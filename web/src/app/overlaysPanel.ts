import type * as maplibregl from 'maplibre-gl';
import { readOverlayFile, type OverlayFeature } from '../overlays/kml';
import { addOverlay, deleteOverlay, getOverlayFeatures, listOverlays, putOverlay, type StoredOverlay } from '../overlays/store';
import { newId } from '../saved/saved';
import { deleteButton, eyeButton, fitClearOf } from './listButtons';
import { acceptDrops, extensions } from '../ui/drop';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** "195 places · 23 areas" */
export function overlaySummary(c: StoredOverlay['counts']): string {
  const part = (n: number, one: string, many: string) => (n ? `${n.toLocaleString('en')} ${n === 1 ? one : many}` : '');
  return [part(c.points, 'place', 'places'), part(c.lines, 'line', 'lines'), part(c.areas, 'area', 'areas')].filter(Boolean).join(' · ');
}

/**
 * ⋯ → Overlays: KML files (such as GPSmap.is's drone no-fly zones, parking zones and artworks)
 * drawn over the map in their own colours. Areas and lines go under the map's names so the names
 * stay readable; points and their names go on top, under the tracks. Only the visible overlays'
 * shapes are read from storage and held. Kept on this device only.
 */
export class OverlaysPanel {
  private overlays: StoredOverlay[] = [];
  /** The shapes of the visible overlays, by id. */
  private readonly shapes = new Map<string, OverlayFeature[]>();
  private readonly panel = $('overlays');
  private readonly list = $<HTMLUListElement>('overlay-list');
  private readonly error = $('overlays-error');
  private readonly loaded: Promise<void>;

  /** `underTracks`: the layer the points and names go under (the tracks' lowest, already added). */
  constructor(private readonly map: maplibregl.Map, font: string, underTracks: string) {
    this.addLayers(font, underTracks);
    const input = $<HTMLInputElement>('overlay-file');
    $('import-overlay').onclick = () => input.click();
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      void this.importFiles(files);
    };
    acceptDrops(this.panel, (files) => void this.importFiles(files), extensions('kml', 'kmz'));
    $('overlays-close').onclick = () => this.show(false);
    this.loaded = this.load().catch((err) => this.fail(err));
  }

  private async load(): Promise<void> {
    this.overlays = await listOverlays();
    this.refreshList();
    for (const o of this.overlays.filter((x) => x.visible)) this.shapes.set(o.id, await getOverlayFeatures(o.id));
    if (this.shapes.size) this.draw();
  }

  private addLayers(font: string, underTracks: string): void {
    const map = this.map;
    map.addSource('overlays', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // The map's own names (its first symbol layer, below the tracks') stay above the areas and lines.
    const underNames = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const k = (...kinds: string[]) => ['in', ['get', 'k'], ['literal', kinds]] as maplibregl.ExpressionSpecification;
    map.addLayer({ id: 'overlay-fill', type: 'fill', source: 'overlays', filter: k('area'),
      paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] } }, underNames);
    map.addLayer({ id: 'overlay-line', type: 'line', source: 'overlays', filter: k('area', 'line'), layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'line'], 'line-opacity': ['get', 'lineOpacity'], 'line-width': ['get', 'lineWidth'] } }, underNames);
    map.addLayer({ id: 'overlay-line-label', type: 'symbol', source: 'overlays', filter: ['all', k('line'), ['!=', ['get', 'name'], '']],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12 },
      paint: { 'text-color': ['get', 'line'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, underTracks);
    map.addLayer({ id: 'overlay-point', type: 'circle', source: 'overlays', filter: k('point'),
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 5], 'circle-color': ['get', 'fill'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } }, underTracks);
    // Names from town zoom on: further out, a city's worth of places would be a heap of names.
    map.addLayer({ id: 'overlay-label', type: 'symbol', source: 'overlays', minzoom: 11, filter: ['all', k('point', 'label'), ['!=', ['get', 'name'], '']],
      layout: {
        'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12, 'text-max-width': 9, 'text-optional': true,
        'text-anchor': ['case', ['==', ['get', 'k'], 'point'], 'top', 'center'],
        'text-offset': ['case', ['==', ['get', 'k'], 'point'], ['literal', [0, 0.7]], ['literal', [0, 0]]],
      },
      paint: { 'text-color': ['get', 'line'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, underTracks);
  }

  show(open: boolean): void {
    this.panel.hidden = !open;
    if (open) this.error.textContent = '';
  }

  /** The overlays as listed (for tests). */
  get all(): StoredOverlay[] {
    return this.overlays;
  }

  async importFiles(files: File[]): Promise<void> {
    await this.loaded;
    this.error.textContent = '';
    const problems: string[] = [];
    let last: StoredOverlay | null = null;
    for (const file of files) {
      try {
        const { features, ...rest } = await readOverlayFile(file.name, new Uint8Array(await file.arrayBuffer()));
        const o: StoredOverlay = { ...rest, id: newId(), visible: true, added: Date.now() };
        await addOverlay(o, features);
        this.overlays.push(o);
        this.shapes.set(o.id, features);
        last = o;
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (last) this.draw();
    this.refreshList();
    if (problems.length) this.error.textContent = problems.join('\n');
    if (last) this.zoomTo(last);
  }

  private zoomTo(o: StoredOverlay): void {
    const [w, s, e, n] = o.bounds;
    fitClearOf(this.map, this.panel, [[w, s], [e, n]], 16);
  }

  /** Hands the visible overlays' shapes to the map, in list order. */
  private draw(): void {
    const features = this.overlays.flatMap((o) => this.shapes.get(o.id) ?? []);
    (this.map.getSource('overlays') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  private refreshList(): void {
    $('overlays-empty').hidden = this.overlays.length > 0;
    this.list.replaceChildren(...this.overlays.map((o) => this.row(o)));
  }

  private row(o: StoredOverlay): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'track overlay';
    li.dataset.id = o.id;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = o.color;
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'track-info';
    info.title = 'Show on the map';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = o.name;
    const stats = document.createElement('span');
    stats.className = 'stats';
    stats.textContent = overlaySummary(o.counts);
    info.append(name, stats);
    info.onclick = () => {
      if (!o.visible) void this.setVisible(o, true);
      this.zoomTo(o);
      if (matchMedia('(pointer: coarse)').matches) this.show(false);
    };
    li.append(
      swatch,
      info,
      eyeButton(o.name, o.visible, () => void this.setVisible(o, !o.visible)),
      deleteButton(o.name, () => void this.remove(o)),
    );
    return li;
  }

  private async setVisible(o: StoredOverlay, visible: boolean): Promise<void> {
    o.visible = visible;
    this.refreshList();
    try {
      await putOverlay(o);
      if (!visible) this.shapes.delete(o.id);
      else {
        const features = await getOverlayFeatures(o.id);
        if (!o.visible) return; // hidden again meanwhile
        this.shapes.set(o.id, features);
      }
      this.draw();
    } catch (err) {
      this.fail(err);
    }
  }

  private async remove(o: StoredOverlay): Promise<void> {
    try {
      await deleteOverlay(o.id);
      this.overlays = this.overlays.filter((x) => x.id !== o.id);
      if (this.shapes.delete(o.id)) this.draw();
      this.refreshList();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.error.textContent = err instanceof Error ? err.message : String(err);
  }
}
