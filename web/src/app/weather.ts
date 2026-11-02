import * as maplibregl from 'maplibre-gl';
import { run } from '../storage/idb';
import { FONT_REGULAR as FONT } from '../style/buildStyle';
import { readChoice, readSetting, writeChoice, writeSetting } from '../ui/settings';
import { chartSvg, CHART_W, indexAtX, type Hours } from '../weather/chart';
import { LAYERS, legendGradient, SCALES, tickPosition, type Layer } from '../weather/colors';
import { covers, gridFor, hourIndex, valueAt, type Field, type WeatherGrid } from '../weather/grid';
import { fetchWeather, isoDay, type Period } from '../weather/openMeteo';
import { renderField } from '../weather/render';
import { LATEST_URL, parseLatest, parseStations, stationFeatures, STATIONS_URL, windCompass, type Observation, type Station } from '../weather/stations';
import { coordsText, LONG_PRESS_MS } from './route';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const HOUR = 3_600_000;
/** A forecast older than this is fetched again (when online). */
const FORECAST_FRESH = HOUR;
/** Stations send every 10 minutes. */
const STATIONS_EVERY = 10 * 60_000;
/** Stations show while the chosen hour is this close to now (they're measurements, not forecasts). */
const STATIONS_NEAR = 90 * 60_000;
/** The forecast kept on the device is written at most this often (a few MB each time). */
const KEEP_EVERY = 10 * 60_000;
/** Model arrows at least this far apart on screen (px). */
const ARROW_PX = 64;

/** The map's sources and layers (each layer has the source of the same name). */
const IDS = { field: 'weather-field', arrows: 'weather-arrows', stations: 'weather-stations' } as const;

// Times as in Iceland, which keeps UTC all year (the days asked for are UTC days too), wherever
// the phone's clock is set.
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...o });
const clockFmt = fmt({ hour: '2-digit', minute: '2-digit' });
const weekdayFmt = fmt({ weekday: 'short' });
const longDayFmt = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dateFmt = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const clock = (ms: number) => clockFmt.format(ms);
const weekday = (ms: number) => weekdayFmt.format(ms);
const one = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : '–');

export interface WeatherDeps {
  map: maplibregl.Map;
  /** The nearest named place, for a tapped spot's title. */
  near: (lon: number, lat: number) => string | null;
  /** True while a tap on the map means something else (choosing a route's start). */
  tapTaken: () => boolean;
  /** Layers whose features take a tap themselves (saved stars, waypoints). */
  tappable: string[];
  /** The layer the colours go under (the map's first road layer), so roads and names stay on top. */
  beneath: string;
}

interface Cached {
  id: 'forecast' | 'stations';
  grid?: WeatherGrid;
  stations?: Station[];
  latest?: Observation[];
  fetched?: number;
}

type Card = { kind: 'spot'; lon: number; lat: number; title: string } | { kind: 'station'; id: number };

/**
 * The weather over the map (⋯ → Weather): a bar with the layer (wind, rain/snow, temperature,
 * cloud), an hour slider over yesterday to a week ahead, any past day by date, and measured weather
 * at Veðurstofan's stations. A tap on the map opens that spot's hours. The last forecast and station
 * readings are kept on the device, so offline it shows those, saying when they're from.
 */
export class Weather {
  private open = false;
  private layer: Layer;
  private stationsOn: boolean;
  private period: Period = { kind: 'forecast' };
  /** The grid shown, with the period it's of (the period may change while another loads). */
  private shown: { grid: WeatherGrid; period: Period } | null = null;
  /** The latest forecast, kept while a past day is shown so coming back needs nothing. */
  private forecast: WeatherGrid | null = null;
  private keptAt = 0;
  /** The chosen hour (ms); follows the hours when a new grid comes. */
  private time = Date.now();
  private fetching: AbortController | null = null;
  private moveTimer = 0;
  private stationTimer = 0;
  private stations: Station[] = [];
  private latest: Observation[] = [];
  private stationsFetched = 0;
  /** Counts new readings, so the map's copy is only replaced when they change. */
  private stationsVersion = 0;
  private stationsDrawn = '';
  private arrowsEmpty = true;
  private status = '';
  /** One redraw per frame, one image being made at a time. */
  private frame = 0;
  private fieldBusy = false;
  private fieldDirty = false;
  private canvas = document.createElement('canvas');
  private imageUrl: string | null = null;
  private card: Card | null = null;
  /** The card's spot over the whole grid, worked out once per spot and grid. */
  private cardSeries: { card: Card; grid: WeatherGrid; hours: Hours; dir: number[]; cloud: number[] } | null = null;
  /** The hours the card's chart shows (for a tap on it). */
  private chartHours: number[] = [];
  private pressAt = 0;

  constructor(private readonly deps: WeatherDeps) {
    this.layer = readChoice('weatherLayer', LAYERS, 'wind');
    this.stationsOn = readSetting('weatherStations', true);
    const { map } = deps;
    this.wireBar();
    map.on('moveend', () => {
      if (!this.open) return;
      this.drawArrows();
      clearTimeout(this.moveTimer);
      this.moveTimer = window.setTimeout(() => void this.load(), 600);
    });
    // A tap shows that spot's hours; a station's tap its readings. Long presses are the route's.
    map.getCanvasContainer().addEventListener('pointerdown', () => (this.pressAt = Date.now()));
    map.on('click', (e) => {
      if (!this.open || Date.now() - this.pressAt > LONG_PRESS_MS || this.deps.tapTaken()) return;
      const station = map.getLayer(IDS.stations) ? map.queryRenderedFeatures(e.point, { layers: [IDS.stations] })[0] : undefined;
      if (station) return this.openCard({ kind: 'station', id: Number(station.properties.id) });
      const busy = deps.tappable.filter((l) => map.getLayer(l));
      if (busy.length && map.queryRenderedFeatures(e.point, { layers: busy }).length) return;
      const { lng, lat } = e.lngLat;
      this.openCard({ kind: 'spot', lon: lng, lat, title: deps.near(lng, lat) ?? coordsText({ lon: lng, lat }) });
    });
    if (readSetting('weatherOn', false)) this.show(true);
  }

  /** What's shown (read by the e2e). */
  get state(): { grid: WeatherGrid | null; time: number; layer: Layer; period: Period; status: string; stations: number } {
    return { grid: this.grid, time: this.time, layer: this.layer, period: this.period, status: this.status, stations: this.latest.length };
  }

  private get grid(): WeatherGrid | null {
    return this.shown?.grid ?? null;
  }

  show(on: boolean): void {
    if (on === this.open) return;
    this.open = on;
    writeSetting('weatherOn', on);
    $('weather-bar').hidden = !on;
    clearInterval(this.stationTimer);
    if (!on) {
      this.fetching?.abort();
      this.closeCard();
      this.removeLayers();
      // Kept on the device; freed here for a phone short of memory.
      this.shown = null;
      this.forecast = null;
      return;
    }
    this.renderBar();
    this.stationTimer = window.setInterval(() => void this.loadStations(), STATIONS_EVERY);
    void this.start();
  }

  private async start(): Promise<void> {
    // What was kept last time first, so offline there's something at once.
    const [, kept] = await Promise.all([this.restoreForecast(), this.stations.length ? null : readCached('stations')]);
    if (kept?.stations && !this.stations.length) {
      this.stations = kept.stations;
      this.latest = kept.latest ?? [];
      this.stationsFetched = kept.fetched ?? 0;
      this.stationsVersion++;
    }
    if (!this.open) return;
    this.draw();
    void this.load();
    void this.loadStations();
  }

  /** Shows the forecast in memory or kept on the device, while the forecast is wanted and nothing
   *  else has come meanwhile. */
  private async restoreForecast(): Promise<void> {
    if (this.period.kind !== 'forecast' || this.shown) return;
    if (!this.forecast) this.forecast = (await readCached('forecast'))?.grid ?? null;
    if (this.forecast && this.period.kind === 'forecast' && !this.shown) this.shown = { grid: this.forecast, period: this.period };
  }

  // ── Fetching ──────────────────────────────────────────────────────────────

  /** Fetches the grid the view needs, unless the one shown serves it. */
  private async load(): Promise<void> {
    if (!this.open) return;
    const { map } = this.deps;
    const b = map.getBounds();
    const spec = gridFor([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom());
    const s = this.shown;
    const fresh = this.period.kind === 'day' || (s && Date.now() - s.grid.fetched < FORECAST_FRESH);
    if (s && samePeriods(s.period, this.period) && fresh && covers(s.grid, spec)) return;
    if (!navigator.onLine) {
      this.setStatus(s ? `Offline · ${this.sourceText()}` : 'Offline: the weather shows once you’re connected.', !s);
      return;
    }
    this.fetching?.abort();
    const ctl = new AbortController();
    this.fetching = ctl;
    const period = this.period;
    this.setStatus('Loading the weather…');
    try {
      const grid = await fetchWeather(spec, period, ctl.signal);
      if (ctl.signal.aborted) return;
      this.shown = { grid, period };
      if (period.kind === 'forecast') {
        this.forecast = grid;
        if (Date.now() - this.keptAt > KEEP_EVERY) {
          this.keptAt = Date.now();
          void writeCached({ id: 'forecast', grid });
        }
      }
      this.setStatus(this.sourceText());
      this.draw();
    } catch (err) {
      if (ctl.signal.aborted) return;
      console.warn('weather', err);
      const why = navigator.onLine ? `Couldn’t load the weather: ${(err as Error).message}` : 'Offline';
      this.setStatus(this.shown ? `${why}. Showing: ${this.sourceText()}` : `${why}.`, true);
    } finally {
      if (this.fetching === ctl) this.fetching = null;
    }
  }

  /** The latest readings, while stations can be shown (none of a past day or tomorrow). */
  private async loadStations(): Promise<void> {
    if (!this.open || !this.stationsShown() || !navigator.onLine || Date.now() - this.stationsFetched < STATIONS_EVERY - 30_000) return;
    this.stationsFetched = Date.now();
    try {
      const [list, latest] = await Promise.all([
        this.stations.length ? this.stations : fetch(STATIONS_URL).then((r) => r.json()).then(parseStations),
        fetch(LATEST_URL).then((r) => r.json()).then(parseLatest),
      ]);
      this.stations = list;
      this.latest = latest;
      this.stationsVersion++;
      void writeCached({ id: 'stations', stations: list, latest, fetched: this.stationsFetched });
    } catch (err) {
      console.warn('weather stations', err);
      this.stationsFetched = 0;
      return;
    }
    this.draw();
  }

  // ── The bar ───────────────────────────────────────────────────────────────

  private wireBar(): void {
    $('weather-close').onclick = () => this.show(false);
    for (const b of $('weather-layers').querySelectorAll<HTMLButtonElement>('button')) {
      const layer = LAYERS.find((l) => l === b.dataset.layer);
      if (!layer) continue;
      b.onclick = () => {
        this.layer = layer;
        writeChoice('weatherLayer', layer);
        this.renderBar();
        this.draw();
      };
    }
    const slider = $<HTMLInputElement>('weather-slider');
    slider.oninput = () => {
      const g = this.grid;
      if (!g) return;
      this.time = g.times[Number(slider.value)] ?? this.time;
      this.draw();
    };
    $('weather-now').onclick = () => {
      $<HTMLInputElement>('weather-date').value = '';
      this.time = Date.now();
      void this.usePeriod({ kind: 'forecast' });
    };
    const date = $<HTMLInputElement>('weather-date');
    date.max = isoDay(Date.now() - 86_400_000);
    date.onchange = () => {
      if (!date.value) return;
      // The same hour of the day as shown (midday coming from the forecast).
      const hour = this.period.kind === 'day' ? new Date(this.time).getUTCHours() : 12;
      this.time = Date.parse(`${date.value}T${String(hour).padStart(2, '0')}:00:00Z`);
      void this.usePeriod({ kind: 'day', date: date.value });
    };
    $('weather-stations').onclick = () => {
      this.stationsOn = !this.stationsOn;
      writeSetting('weatherStations', this.stationsOn);
      this.renderBar();
      this.draw();
    };
    $('weather-card-close').onclick = () => this.closeCard();
    $('weather-chart').addEventListener('click', (e) => {
      const svg = (e.currentTarget as HTMLElement).querySelector('svg');
      if (!this.chartHours.length || !svg) return;
      const r = svg.getBoundingClientRect();
      this.time = this.chartHours[indexAtX(((e.clientX - r.left) / r.width) * CHART_W, this.chartHours.length)];
      this.draw();
    });
  }

  /** Shows another period: the forecast (the one in memory or kept, at once, while a fresh one
   *  loads) or a day. */
  private async usePeriod(p: Period): Promise<void> {
    this.period = p;
    if (!this.shown || !samePeriods(this.shown.period, p)) {
      this.shown = null;
      this.fetching?.abort();
      this.renderBar();
      this.draw();
      await this.restoreForecast();
    }
    this.renderBar();
    this.draw();
    void this.load();
  }

  private renderBar(): void {
    for (const b of $('weather-layers').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.layer === this.layer));
    $('weather-stations').setAttribute('aria-pressed', String(this.stationsOn));
    $('weather-now').setAttribute('aria-pressed', String(this.period.kind === 'forecast'));
    $('weather-date-box').classList.toggle('on', this.period.kind === 'day');
    $('weather-date-box').querySelector('span')!.textContent = this.period.kind === 'day' ? dateFmt.format(Date.parse(this.period.date)) : 'Past day';
    const scale = SCALES[this.layer];
    $('weather-legend-bar').style.background = legendGradient(scale);
    $('weather-legend-ticks').replaceChildren(...scale.ticks.map((v) => {
      const s = document.createElement('span');
      s.textContent = String(v);
      s.style.left = `${tickPosition(scale, v) * 100}%`;
      return s;
    }));
    $('weather-legend-unit').textContent = scale.unit;
  }

  /** An hour as the bar and card name it: a past day's with its date, a forecast's with its weekday. */
  private hourText(t: number): string {
    return this.period.kind === 'day' ? `${longDayFmt.format(t)}, ${clock(t)}` : `${weekday(t)} ${clock(t)}`;
  }

  private renderTime(): void {
    const g = this.grid;
    const slider = $<HTMLInputElement>('weather-slider');
    slider.disabled = !g;
    let text = this.period.kind === 'day' ? longDayFmt.format(Date.parse(this.period.date)) : 'Now';
    if (g) {
      const i = hourIndex(g.times, this.time);
      slider.max = String(g.times.length - 1);
      slider.value = String(i);
      const t = g.times[i];
      const away = Math.round((t - Date.now()) / HOUR);
      if (this.period.kind === 'day') text = this.hourText(t);
      else if (Math.abs(t - Date.now()) < HOUR / 2 + 1) text = `Now · ${this.hourText(t)}`;
      else text = `${this.hourText(t)} · ${away > 0 ? `in ${fmtHours(away)}` : `${fmtHours(-away)} ago`}`;
      slider.setAttribute('aria-valuetext', text);
    }
    $('weather-time').textContent = text;
    let note = '';
    if (this.stationsOn && !this.stationsShown()) note = this.period.kind === 'day' ? 'Stations show only the latest readings: tap Forecast to see them.' : 'Stations show the latest readings: move to now to see them.';
    $('weather-stations-note').textContent = note;
  }

  private setStatus(text: string, problem = false): void {
    this.status = text;
    $('weather-status').textContent = text;
    $('weather-status').classList.toggle('problem', problem);
  }

  private sourceText(): string {
    const g = this.grid;
    if (!g) return '';
    const from = this.period.kind === 'forecast' ? `Forecast from ${weekday(g.fetched)} ${clock(g.fetched)}` : 'Past weather';
    return `${from} · ${g.source} via Open-Meteo`;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  /** Redraws the bar, map and card on the next frame (once however often it's asked). */
  private draw(): void {
    if (!this.open || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.open) return;
      this.renderTime();
      this.drawField();
      this.drawArrows();
      this.drawStations();
      this.renderCard();
      void this.loadStations();
    });
  }

  /** The colours: an image the map stretches over the grid. While one is being made, a newer
   *  request waits for it and then makes the latest. */
  private drawField(): void {
    const { map } = this.deps;
    const g = this.grid;
    if (!g) {
      if (map.getLayer(IDS.field)) map.setLayoutProperty(IDS.field, 'visibility', 'none');
      return;
    }
    if (this.fieldBusy) return void (this.fieldDirty = true);
    this.fieldBusy = true;
    const img = renderField(g, SCALES[this.layer], hourIndex(g.times, this.time));
    this.canvas.width = img.width;
    this.canvas.height = img.height;
    this.canvas.getContext('2d')!.putImageData(new ImageData(img.rgba as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
    this.canvas.toBlob((blob) => {
      this.fieldBusy = false;
      if (blob && this.open) {
        const url = URL.createObjectURL(blob);
        const src = map.getSource(IDS.field) as maplibregl.ImageSource | undefined;
        if (src) src.updateImage({ url, coordinates: img.coordinates });
        else {
          map.addSource(IDS.field, { type: 'image', url, coordinates: img.coordinates });
          map.addLayer({ id: IDS.field, type: 'raster', source: IDS.field, paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, map.getLayer(this.deps.beneath) ? this.deps.beneath : undefined);
        }
        map.setLayoutProperty(IDS.field, 'visibility', 'visible');
        // The map has fetched the image by its next frame.
        const old = this.imageUrl;
        this.imageUrl = url;
        if (old) map.once('render', () => URL.revokeObjectURL(old));
      }
      if (this.fieldDirty) {
        this.fieldDirty = false;
        this.drawField();
      }
    }, 'image/png');
  }

  private drawArrows(): void {
    const { map } = this.deps;
    const g = this.grid;
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    if (this.open && g && this.layer === 'wind') {
      const t = hourIndex(g.times, this.time);
      // Every k-th point, so arrows keep apart on screen.
      const a = map.project([g.west, g.south]);
      const b = map.project([g.west + g.dLon, g.south + g.dLat]);
      const k = Math.max(1, Math.ceil(ARROW_PX / Math.max(1, Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)))));
      for (let r = 0; r < g.rows; r += k) {
        for (let c = 0; c < g.cols; c += k) {
          const i = t * g.rows * g.cols + r * g.cols + c;
          const speed = g.values.wind[i];
          const dir = g.values.dir[i];
          if (!Number.isFinite(speed) || !Number.isFinite(dir)) continue;
          features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.west + c * g.dLon, g.south + r * g.dLat] }, properties: { rotate: (dir + 180) % 360, label: String(Math.round(speed)) } });
        }
      }
    }
    if (!features.length && this.arrowsEmpty) return;
    this.arrowsEmpty = !features.length;
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
    const src = map.getSource(IDS.arrows) as maplibregl.GeoJSONSource | undefined;
    if (src) return void src.setData(data);
    addArrowImages(map);
    map.addSource(IDS.arrows, { type: 'geojson', data });
    map.addLayer({
      id: IDS.arrows, type: 'symbol', source: IDS.arrows,
      layout: { 'icon-image': 'wx-arrow', 'icon-rotate': ['get', 'rotate'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'text-field': ['get', 'label'], 'text-font': [FONT], 'text-size': 11, 'text-offset': [0, 1.3], 'text-allow-overlap': true },
      paint: { 'text-color': '#3a4656', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5, 'icon-opacity': 0.85 },
    });
  }

  private stationsShown(): boolean {
    return this.stationsOn && this.period.kind === 'forecast' && Math.abs(this.time - Date.now()) <= STATIONS_NEAR;
  }

  private drawStations(): void {
    const { map } = this.deps;
    const shown = this.open && this.stationsShown() && this.latest.length > 0;
    const label = this.layer === 'temp' ? 'temp' : 'wind';
    // Only when something changed: the readings, shown or not, the label.
    const key = shown ? `${this.stationsVersion}:${label}` : '';
    if (key === this.stationsDrawn) return;
    this.stationsDrawn = key;
    const data = shown ? stationFeatures(this.stations, this.latest) : { type: 'FeatureCollection' as const, features: [] };
    const src = map.getSource(IDS.stations) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      map.setLayoutProperty(IDS.stations, 'text-field', ['get', label]);
      return;
    }
    addArrowImages(map);
    map.addSource(IDS.stations, { type: 'geojson', data });
    map.addLayer({
      id: IDS.stations, type: 'symbol', source: IDS.stations,
      layout: {
        'icon-image': ['case', ['get', 'hasDir'], 'wx-station-arrow', 'wx-station-dot'], 'icon-rotate': ['get', 'rotate'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
        'text-field': ['get', label], 'text-font': [FONT], 'text-size': 12, 'text-offset': [0, 1.35], 'text-optional': true,
        // Stronger wind first when labels collide.
        'symbol-sort-key': ['-', 0, ['get', 'speed']],
      },
      paint: { 'text-color': '#1d3f8f', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
  }

  private removeLayers(): void {
    const { map } = this.deps;
    for (const id of [IDS.stations, IDS.arrows, IDS.field]) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = null;
    this.stationsDrawn = '';
    this.arrowsEmpty = true;
  }

  // ── The card ──────────────────────────────────────────────────────────────

  private openCard(card: Card): void {
    this.card = card;
    $('weather-card').hidden = false;
    document.body.classList.add('weather-card-open');
    this.renderCard();
  }

  closeCard(): void {
    this.card = null;
    this.cardSeries = null;
    this.chartHours = [];
    $('weather-card').hidden = true;
    document.body.classList.remove('weather-card-open');
  }

  private renderCard(): void {
    const card = this.card;
    if (!card) return;
    const title = $('weather-card-title');
    const sub = $('weather-card-sub');
    const chart = $('weather-chart');
    const facts = $('weather-card-facts');
    this.chartHours = [];
    if (card.kind === 'station') {
      const s = this.stations.find((x) => x.id === card.id);
      const o = this.latest.find((x) => x.station === card.id);
      title.textContent = s?.name ?? 'Weather station';
      sub.textContent = [s?.owner, s?.ele != null ? `${Math.round(s.ele)} m` : '', o ? `measured ${clock(o.time)}` : ''].filter(Boolean).join(' · ');
      chart.replaceChildren();
      facts.replaceChildren(...(o ? [
        fact('Wind', o.f === null ? '–' : `${o.f.toFixed(1)} m/s${o.d !== null ? ` from ${windCompass(o.d)}` : ''}`),
        fact('Gusts', o.fg === null ? '–' : `${o.fg.toFixed(1)} m/s`),
        fact('Temperature', o.t === null ? '–' : `${o.t.toFixed(1)} °C`),
        ...(o.rh !== null ? [fact('Humidity', `${Math.round(o.rh)} %`)] : []),
        ...(o.p !== null ? [fact('Pressure', `${Math.round(o.p)} hPa`)] : []),
      ] : [fact('Readings', 'None lately')]));
      return;
    }
    title.textContent = card.title;
    const g = this.grid;
    const series = g && this.spotSeries(card, g);
    if (!g || !series) {
      sub.textContent = g ? 'Outside the weather loaded: move the map there.' : this.status || 'No weather loaded yet.';
      chart.replaceChildren();
      facts.replaceChildren();
      return;
    }
    const t = hourIndex(g.times, this.time);
    const { hours, dir, cloud } = series;
    sub.textContent = this.hourText(g.times[t]);
    facts.replaceChildren(
      fact('Wind', `${one(hours.wind[t])} m/s${Number.isFinite(dir[t]) ? ` from ${windCompass(dir[t])}` : ''}`),
      fact('Gusts', `${one(hours.gust[t])} m/s`),
      fact('Temperature', `${one(hours.temp[t])} °C`),
      fact('Rain / snow', `${Number.isFinite(hours.rain[t]) ? hours.rain[t].toFixed(1) : '–'} mm`),
      fact('Cloud', `${one(cloud[t])} %`),
    );
    // The hours around the chosen one: from 6 before to 42 after (a day's 24 for a past day).
    const from = this.period.kind === 'day' ? 0 : Math.max(0, t - 6);
    const to = this.period.kind === 'day' ? g.times.length : Math.min(g.times.length, from + 48);
    const cut = (a: number[]) => a.slice(from, to);
    const window: Hours = { times: cut(hours.times), wind: cut(hours.wind), gust: cut(hours.gust), temp: cut(hours.temp), rain: cut(hours.rain) };
    this.chartHours = window.times;
    chart.innerHTML = chartSvg(window, t - from, weekday);
  }

  /** The card's spot through every hour of the grid (null outside it). */
  private spotSeries(card: Extract<Card, { kind: 'spot' }>, g: WeatherGrid): NonNullable<Weather['cardSeries']> | null {
    if (this.cardSeries?.card === card && this.cardSeries.grid === g) return this.cardSeries;
    const all = (field: Field) => g.times.map((_, i) => valueAt(g, field, i, card.lon, card.lat));
    const wind = all('wind');
    if (wind.every(Number.isNaN)) return null;
    this.cardSeries = { card, grid: g, hours: { times: g.times, wind, gust: all('gust'), temp: all('temp'), rain: all('rain') }, dir: all('dir'), cloud: all('cloud') };
    return this.cardSeries;
  }
}

function fact(name: string, value: string): HTMLElement {
  const d = document.createElement('div');
  const n = document.createElement('span');
  n.textContent = name;
  const v = document.createElement('b');
  v.textContent = value;
  d.append(n, v);
  return d;
}

function fmtHours(h: number): string {
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r ? `${d} d ${r} h` : `${d} d`;
}

function samePeriods(a: Period, b: Period): boolean {
  if (a.kind === 'forecast') return b.kind === 'forecast';
  return b.kind === 'day' && a.date === b.date;
}

async function readCached(id: Cached['id']): Promise<Cached | null> {
  try {
    return ((await run('weather', 'readonly', (s) => s.get(id))) as Cached | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeCached(c: Cached): Promise<void> {
  try {
    await run('weather', 'readwrite', (s) => s.put(c));
  } catch (err) {
    console.warn('weather cache', err);
  }
}

/** Arrows drawn once: a grey one for the model's wind, a dark blue one (and a dot, for calm or no
 *  direction) for the stations' measured wind. Pointing up; turned by the layer. */
function addArrowImages(map: maplibregl.Map): void {
  const draw = (id: string, size: number, color: string, dot: boolean) => {
    if (map.hasImage(id)) return;
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const x = c.getContext('2d')!;
    x.scale(2, 2);
    x.lineJoin = 'round';
    x.strokeStyle = '#ffffff';
    x.lineWidth = 2.5;
    x.fillStyle = color;
    x.beginPath();
    if (dot) x.arc(size / 2, size / 2, size / 4, 0, Math.PI * 2);
    else {
      const m = size / 2;
      x.moveTo(m, 1);
      x.lineTo(size - 3, size - 2);
      x.lineTo(m, size * 0.68);
      x.lineTo(3, size - 2);
      x.closePath();
    }
    x.stroke();
    x.fill();
    map.addImage(id, x.getImageData(0, 0, size * 2, size * 2), { pixelRatio: 2 });
  };
  draw('wx-arrow', 16, '#4a5868', false);
  draw('wx-station-arrow', 18, '#1d3f8f', false);
  draw('wx-station-dot', 18, '#1d3f8f', true);
}
