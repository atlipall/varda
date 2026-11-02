import * as maplibregl from 'maplibre-gl';
import type { RouteReply } from '../worker/pool';
import { readSetting, writeSetting } from '../ui/settings';
import { offRoadText, routeMessage, type StartKind } from './routeMessage';
import type { Place, SessionRoute } from './session';
import { featureNameAt } from '../map/featureName';
import { FONT_REGULAR } from '../style/buildStyle';
import type { LonLat } from '../routing/plan';
import { bestInsert, joinLegs, type JoinedRoute } from '../routing/waypoints';
import { gpxFileName, routeGpx, shareFile } from '../gpx/export';
import type { NavRoute } from './navigation';
import { newId, type RouteOk, type Saved } from '../saved/saved';
import { routeAsTrack } from '../gpx/fromRoute';
import type { Gpx } from '../gpx/parse';
import type { TrackRoute } from '../gpx/store';
import { suggestName } from '../ui/rename';
import { PlaceMenu, type PlaceMenuItem } from './placeMenu';
import { diag } from './diagnostics';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Hold time for a long press: below iOS's own ~0.5 s long-press gestures (selection loupe, callout). */
export const LONG_PRESS_MS = 450;
/** iOS may cancel the touch when its own long-press gesture starts; a finger held still this long
 *  by then already counts as a long press. */
const LONG_PRESS_CANCEL_MS = 350;
/** "Use my location" gives up on a first fix after this long. */
const FIX_WAIT_MS = 20_000;
/** Moving faster than this (m/s, about 9 km/h: faster than walking) minimizes the route card. */
const MOVING_MPS = 2.5;

export const fmtKm = (m: number) => (m < 10_000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);
export function fmtTime(s: number): string {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const coordsText = (p: { lon: number; lat: number }) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;

const FROM_TEXT: Record<StartKind, string> = { gps: 'your position', centre: 'the map centre', chosen: 'the chosen point' };

/** A white pin with a dark outline for a start chosen on the map. */
function startPinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'start-pin';
  el.innerHTML = '<svg viewBox="0 0 27 41" width="27" height="41" aria-hidden="true"><path d="M13.5 1.5C6.9 1.5 1.5 6.9 1.5 13.5c0 9 12 26 12 26s12-17 12-26c0-6.6-5.4-12-12-12z" fill="#fff" stroke="#1d3f8f" stroke-width="2.5"/><circle cx="13.5" cy="13.5" r="4.5" fill="#1d3f8f"/></svg>';
  el.title = 'Route start';
  return el;
}

/** Destination card, route panel and route line (route planning without guidance). */
export class RoutePlanner {
  private pin: maplibregl.Marker | null = null;
  private readonly placeMenu: PlaceMenu;
  private dest: Place | null = null;
  /** Waypoints between the start and the destination, in route order. */
  private vias: Place[] = [];
  /** A start chosen on the map; null: your position or the map centre. */
  private start: [number, number] | null = null;
  private startPin: maplibregl.Marker | null = null;
  /** The next plain map tap sets the start. */
  private choosing = false;
  private allow = readSetting('allowFRoads', true);
  private prefer = readSetting('preferFRoads', false);
  private started = false;
  /** A route line is on the map. */
  private shown = false;
  /** A route is being planned (reset when it's superseded or cleared). */
  private planning = false;
  /** A question in the card ("clear the current route?", "add as a waypoint?"): what its buttons do,
   *  and the grey marker of the new place it's about (none when it's the × asking). */
  private pending: { yes: () => void } | null = null;
  /** "Use my location" is waiting for a first fix (a switch change keeps waiting). */
  private waiting = false;
  private seq = 0;
  /** The route start when it was the map centre (remembered as a point across restarts). */
  private fromCentre: [number, number] | null = null;
  /** The next route found moves the map to show it: a new route or start, not a route restored at
   *  startup or one changed by a waypoint or switch. */
  private fitRoute = true;
  /** Called when the place, start or route changes (for remembering them across restarts). */
  onChange: (() => void) | null = null;
  /** The card is shrunk to one line. */
  private minimized = false;
  /** Opened again by hand: not minimized automatically again for this route. */
  private keepOpen = false;
  /** The route on the map and where it started (what "Save" keeps). */
  private last: { route: JoinedRoute; from: [number, number] } | null = null;
  /** The place or route in the card is saved (until the card changes). */
  private saved = false;
  /** Stores a saved pin or route (the Saved panel). */
  onSave: ((item: Saved) => Promise<void>) | null = null;
  /** Keeps a route as a track (the Tracks panel). */
  onSaveTrack: ((t: { name: string; gpx: Gpx; route: TrackRoute }) => Promise<void>) | null = null;
  /** "Start": navigate along the route shown. */
  onStart: (() => void) | null = null;
  /** A route was planned (`ok`) or couldn't be (for navigation, which plans again on the way). */
  onPlanned: ((ok: boolean) => void) | null = null;
  /** The route and place were cleared. */
  onCleared: (() => void) | null = null;

  /** `searchFrom`: your recent GPS position, else the map centre. `useLocation` turns location on. */
  constructor(
    private readonly map: maplibregl.Map,
    private readonly plan: (from: [number, number], to: [number, number], allow: boolean, prefer: boolean) => Promise<RouteReply>,
    private readonly searchFrom: () => { at: [number, number]; gps: boolean },
    private readonly useLocation: () => void,
  ) {
    this.placeMenu = new PlaceMenu(map);
    map.addSource('route', { type: 'geojson', data: EMPTY });
    const kind = (k: string): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: kind('route'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 15, 11] } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: kind('route'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1d3f8f', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 15, 7] } });
    // Straight legs between a chosen point and its road: thinner and dashed.
    map.addLayer({ id: 'route-offroad', type: 'line', source: 'route', filter: kind('offroad'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#1d3f8f', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 15, 4], 'line-dasharray': [2, 1.5] } });
    // The start of the route: a white dot with a dark outline.
    map.addLayer({ id: 'route-start', type: 'circle', source: 'route', filter: kind('start'), paint: { 'circle-color': '#ffffff', 'circle-radius': 6, 'circle-stroke-color': '#1d3f8f', 'circle-stroke-width': 3 } });
    // Waypoints: numbered dark-blue circles (a tap offers to remove one).
    map.addSource('route-vias', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'route-via', type: 'circle', source: 'route-vias', paint: { 'circle-color': '#1d3f8f', 'circle-radius': 10, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'route-via-number', type: 'symbol', source: 'route-vias', layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': [FONT_REGULAR], 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
    $<HTMLInputElement>('route-froads').checked = this.allow;
    $('route-go').onclick = () => void this.route();
    // With a route on the map (or on its way), × asks first; a card with just a place closes.
    $('route-close').onclick = () => {
      if (this.shown || this.planning) this.ask('Clear the current route?', () => this.clear('its × (route cleared)'));
      else this.clear('its ×');
    };
    $('route-min').onclick = (e) => {
      e.stopPropagation();
      this.setMinimized(!this.minimized, true);
    };
    $('route-card').addEventListener('click', () => {
      if (this.minimized) this.setMinimized(false, true);
    });
    $('route-confirm-yes').onclick = () => {
      const yes = this.pending?.yes;
      this.dropPending();
      yes?.();
    };
    $('route-confirm-no').onclick = () => this.dropPending();
    $<HTMLInputElement>('route-prefer').checked = this.prefer;
    $<HTMLInputElement>('route-froads').onchange = (e) => {
      this.allow = (e.target as HTMLInputElement).checked;
      writeSetting('allowFRoads', this.allow);
      this.showSwitches();
      // While waiting for a position, the route that follows uses the new setting. The view stays.
      if (this.started && !this.waiting) {
        this.fitRoute = false;
        void this.route();
      }
    };
    // Prefer F-roads (only offered while they're allowed): they count for less when choosing.
    $<HTMLInputElement>('route-prefer').onchange = (e) => {
      this.prefer = (e.target as HTMLInputElement).checked;
      writeSetting('preferFRoads', this.prefer);
      this.showSwitches();
      // While waiting for a position, the route that follows uses the new setting. The view stays.
      if (this.started && !this.waiting) {
        this.fitRoute = false;
        void this.route();
      }
    };
    $('route-change').onclick = () => this.showChoices($('route-choices').hidden === true);
    $('route-use-gps').onclick = () => void this.useMyLocation();
    $('route-choose').onclick = () => this.chooseOnMap();
    $('route-save').onclick = () => this.showSaveForm(true);
    $('route-export').onclick = () => void this.exportGpx();
    $('route-start').onclick = () => this.onStart?.();
    $('route-options-toggle').onclick = () => this.showOptions($('route-options').hidden === true);
    $('route-save-cancel').onclick = () => this.showSaveForm(false);
    $<HTMLFormElement>('route-save-form').onsubmit = (e) => {
      e.preventDefault();
      void this.save($<HTMLInputElement>('route-save-name').value.trim());
    };
    // Long press (touch) or right-click (mouse) drops a pin with a "Route here" card.
    // A plain tap elsewhere on the map sets the start while choosing one, else closes the card while
    // it only offers "Route here"; a shown route stays until ×. The click a browser may send after a
    // long press or a Ctrl+Click (a Mac's right-click: contextmenu, then click) is ignored.
    let pressed = false;
    map.on('contextmenu', (e) => {
      pressed = true;
      this.pick({ name: null, lon: e.lngLat.lng, lat: e.lngLat.lat, near: featureNameAt(this.map, e.point) });
    });
    map.on('click', (e) => {
      // A tap on a waypoint offers to remove it.
      const via = map.getLayer('route-via') ? map.queryRenderedFeatures(e.point, { layers: ['route-via'] })[0] : undefined;
      if (via) {
        const n = Number(via.properties.n);
        this.ask(`Remove waypoint ${n}?`, () => this.removeVia(n - 1), { yes: 'Remove', no: 'Keep' });
        return;
      }
      // A tap on a saved star opens its card (the Saved panel handles it).
      if (map.getLayer('saved-pins') && map.queryRenderedFeatures(e.point, { layers: ['saved-pins'] }).length) return;
      if (pressed) pressed = false;
      // A tap elsewhere puts the place menu away (and does nothing else).
      else if (this.placeMenu.isOpen) this.placeMenu.close();
      else if (this.choosing) this.setStart([e.lngLat.lng, e.lngLat.lat]);
      else if (this.dest && !this.started) this.clear('a tap on the map');
    });
    let timer = 0;
    let startXY: [number, number] | null = null;
    let startAt = 0;
    const dropAt = (xy: [number, number]) => {
      const r = canvas.getBoundingClientRect();
      const p = new maplibregl.Point(xy[0] - r.left, xy[1] - r.top);
      const ll = map.unproject(p);
      pressed = true;
      this.pick({ name: null, lon: ll.lng, lat: ll.lat, near: featureNameAt(this.map, p) });
    };
    const canvas = map.getCanvasContainer();
    // A new mouse press starts afresh (a right-click is followed by no click to clear the guard).
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') pressed = false;
    });
    canvas.addEventListener('touchstart', (e) => {
      clearTimeout(timer);
      pressed = false;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const xy: [number, number] = [t.clientX, t.clientY];
      startXY = xy;
      startAt = Date.now();
      timer = window.setTimeout(() => {
        timer = 0;
        dropAt(xy);
      }, LONG_PRESS_MS);
    }, { passive: true });
    const cancelPress = () => {
      clearTimeout(timer);
      timer = 0;
      startXY = null;
    };
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (startXY && (e.touches.length !== 1 || Math.hypot(t.clientX - startXY[0], t.clientY - startXY[1]) > 10)) cancelPress();
    }, { passive: true });
    canvas.addEventListener('touchend', cancelPress);
    // iOS cancels the touch when its own long-press gesture begins: if the finger had already been
    // held still for most of a long press, take it as one rather than dropping the press.
    canvas.addEventListener('touchcancel', () => {
      const xy = startXY;
      const held = timer !== 0 && xy !== null && Date.now() - startAt >= LONG_PRESS_CANCEL_MS;
      cancelPress();
      if (held) dropAt(xy!);
    });
  }

  /** Shows the destination card for a place (from search or a long press). */
  pick(dest: Place): void {
    // With a route on the map (or on its way), a new place becomes a waypoint or a new route.
    // The choice is a menu at the place; the route card stays as it is.
    if (this.shown || this.planning) {
      const marker = new maplibregl.Marker({ color: '#8a8f98' }).setLngLat([dest.lon, dest.lat]).addTo(this.map);
      const then = (fn: () => void) => () => {
        marker.remove();
        fn();
      };
      const items: PlaceMenuItem[] = [
        { id: 'place-menu-via', label: 'Add as waypoint', run: then(() => this.addVia(dest)) },
        ...(this.onSave ? [{ id: 'place-menu-pin', label: 'Save as pin', run: then(() => void this.savePin(dest)) }] : []),
        { id: 'place-menu-new', label: 'New route here', run: then(() => {
          this.clearRoute();
          this.pick(dest);
        }) },
      ];
      this.placeMenu.open([dest.lon, dest.lat], dest.name ?? dest.near ?? coordsText(dest), items, () => marker.remove());
      return;
    }
    this.dropPending();
    this.clearRoute();
    this.setVias([]);
    // A new place starts afresh: from your position (not an earlier chosen start), with your own
    // F-road settings (not those of a saved route opened before).
    this.clearStart();
    this.allow = readSetting('allowFRoads', true);
    this.prefer = readSetting('preferFRoads', false);
    $<HTMLInputElement>('route-froads').checked = this.allow;
    $<HTMLInputElement>('route-prefer').checked = this.prefer;
    this.keepOpen = false;
    this.saved = false;
    this.setMinimized(false);
    this.dest = dest;
    this.pin?.remove();
    this.pin = new maplibregl.Marker({ color: '#c0392b' }).setLngLat([dest.lon, dest.lat]).addTo(this.map);
    $('route-title').textContent = dest.name ?? `Dropped pin · ${dest.near ?? coordsText(dest)}`;
    this.setInfo('', '', '');
    this.showChoices(false);
    this.showFrom();
    this.showSwitches();
    $('route-go').hidden = false;
    $('route-card').hidden = false;
    this.fitRoute = true;
    this.showSave();
    this.onChange?.();
  }

  /** The search box's ×: drops a place card it opened, but never a route (the card's × asks). */
  clearPlace(): void {
    if (!this.started && !this.shown && !this.planning) this.clear('the search box cleared');
  }

  /** Out of the way for another dialog (the menu): a place card closes, a route's card folds up. */
  putAway(): void {
    this.placeMenu.close();
    if ($('route-card').hidden) return;
    if (!this.started && !this.shown && !this.planning) this.clear('the menu opened');
    else {
      diag('route card folded: the menu opened');
      this.setMinimized(true);
    }
  }

  /** The route shown, for navigation. */
  navRoute(): NavRoute | null {
    if (!this.last || !this.dest) return null;
    const place = this.dest.name ?? this.dest.near ?? 'the dropped pin';
    return { route: this.last.route, title: $('route-title').textContent || `To ${place}`, dest: place };
  }

  /** Plans the route again from your position (navigation, off the route), without the waypoints
   *  already passed and without moving the map. */
  replanFromHere(passed: number): void {
    if (!this.dest) return;
    this.clearStart();
    this.setVias(this.vias.slice(passed));
    this.fitRoute = false;
    void this.route();
  }

  /** True while a tap on the map sets the route's start. */
  get choosingStart(): boolean {
    return this.choosing;
  }

  /** The card to remember across restarts: the place and, once routed, where from. */
  snapshot(): SessionRoute | null {
    if (!this.dest) return null;
    return { dest: this.dest, routed: this.started && !this.choosing, from: this.start ?? this.fromCentre, vias: this.vias, ...(this.last ? { at: this.last.from } : {}) };
  }

  /** Brings back a remembered card; a route is planned again without moving the map. One from your
   *  position waits for a fix only when location comes back on (`locating`); otherwise it starts
   *  where it started last time, rather than turning location on. */
  restore(r: SessionRoute, locating: boolean): void {
    this.pick(r.dest);
    if (!r.routed) return;
    this.setVias(r.vias ?? []);
    this.fitRoute = false;
    if (r.from) this.setStart(r.from);
    else if (locating) void this.useMyLocation();
    else if (r.at) this.setStart(r.at);
  }

  /** Asks `question` in the card: the `yes` button (label `labels.yes`, "Clear route" by default)
   *  runs `yes`; the `no` button ("Keep route") just closes the question. */
  private ask(question: string, yes: () => void, labels: { yes?: string; no?: string } = {}): void {
    this.dropPending();
    this.pending = { yes };
    $('route-confirm-text').textContent = question;
    $('route-confirm-yes').textContent = labels.yes ?? 'Clear route';
    $('route-confirm-no').textContent = labels.no ?? 'Keep route';
    // Keyboard and screen readers: the question takes focus (an alertdialog, read out).
    queueMicrotask(() => $('route-confirm-yes').focus({ preventScroll: true }));
    $('route-confirm').hidden = false;
    $('route-card').classList.add('asking');
    $('route-card').hidden = false;
    this.setMinimized(false);
  }

  private setVias(vias: Place[]): void {
    this.vias = vias;
    // The card's Via rows, each with a remove button.
    $('route-via-list').replaceChildren(...vias.map((v, i) => {
      const row = document.createElement('div');
      row.className = 'stop';
      const mark = document.createElement('span');
      mark.className = 'stop-mark via';
      mark.textContent = String(i + 1);
      const text = document.createElement('div');
      text.className = 'stop-text';
      const label = document.createElement('span');
      label.className = 'stop-label';
      label.textContent = 'Via';
      const name = document.createElement('span');
      name.className = 'stop-name';
      name.textContent = v.name ?? v.near ?? coordsText(v);
      text.append(label, name);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'via-remove';
      remove.setAttribute('aria-label', `Remove waypoint ${i + 1}`);
      remove.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
      remove.onclick = () => this.removeVia(i);
      row.append(mark, text, remove);
      return row;
    }));
    (this.map.getSource('route-vias') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: vias.map((v, i) => ({ type: 'Feature', properties: { n: i + 1 }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })),
    });
  }

  /** Adds a waypoint where it adds the least detour, and plans the route again. */
  private addVia(p: Place): void {
    if (!this.dest) return;
    const from = this.start ?? this.last?.from ?? this.searchFrom().at;
    const stops: LonLat[] = [from, ...this.vias.map((v): LonLat => [v.lon, v.lat]), [this.dest.lon, this.dest.lat]];
    const vias = [...this.vias];
    vias.splice(bestInsert(stops, [p.lon, p.lat]), 0, p);
    this.setVias(vias);
    this.fitRoute = false; // keep the view where the waypoint was picked
    void this.route();
  }

  private removeVia(i: number): void {
    this.setVias(this.vias.filter((_, k) => k !== i));
    this.fitRoute = false;
    void this.route();
  }

  /** Closes the card's question. */
  private dropPending(): void {
    this.pending = null;
    $('route-confirm').hidden = true;
    $('route-card').classList.remove('asking');
  }

  /** Closes the card and drops its place and route; `why` goes to the Diagnostics log. */
  clear(why: string): void {
    if (!$('route-card').hidden) diag(`route card closed: ${why}`);
    this.placeMenu.close();
    this.dropPending();
    this.clearRoute();
    this.pin?.remove();
    this.pin = null;
    this.dest = null;
    this.setVias([]);
    this.clearStart();
    $('route-card').hidden = true;
    this.showSave();
    this.keepOpen = false;
    this.setMinimized(false);
    this.onChange?.();
  }

  /** The current speed (m/s, from the GPS): once moving with a route, the card gets out of the way
   *  (unless it was opened again by hand). */
  moving(mps: number): void {
    if (mps < MOVING_MPS || !this.started || this.minimized || this.keepOpen || this.pending || this.choosing || !$('route-choices').hidden || !$('route-save-form').hidden) return;
    diag(`route card folded: moving (${Math.round(mps * 3.6)} km/h)`);
    this.setMinimized(true);
  }

  private setMinimized(min: boolean, byHand = false): void {
    if (byHand && !min) this.keepOpen = true;
    this.minimized = min;
    $('route-card').classList.toggle('min', min);
    const button = $('route-min');
    button.setAttribute('aria-expanded', String(!min));
    button.setAttribute('aria-label', min ? 'Show route details' : 'Minimize');
  }

  /** Drops the route (a new place, a saved route opened, ×): navigation along it ends too. */
  private clearRoute(): void {
    if (this.started || this.shown || this.planning) this.onCleared?.();
    this.seq++;
    this.planning = false;
    this.started = false;
    this.choosing = false;
    this.waiting = false;
    this.drawRoute(EMPTY);
  }

  private drawRoute(data: GeoJSON.FeatureCollection): void {
    (this.map.getSource('route') as maplibregl.GeoJSONSource).setData(data);
    this.shown = data.features.length > 0;
    $('route-card').classList.toggle('routed', this.shown);
    if (!this.shown) this.last = null;
    this.showSave();
  }

  /** "Save" for a place (before routing) or a drawn route; "Saved" once it is. */
  private showSave(): void {
    const button = $<HTMLButtonElement>('route-save');
    button.hidden = !this.dest || (this.started && !this.last);
    button.disabled = this.saved;
    // A route is saved as a track: "Save as track", or just "Save" where that doesn't fit.
    const label = button.querySelector('span')!;
    label.textContent = this.saved ? 'Saved' : this.last ? 'Save as track' : 'Save';
    if (!this.saved && this.last && !button.hidden && button.scrollWidth > button.clientWidth) label.textContent = 'Save';
    if (button.hidden) this.showSaveForm(false);
    // Export and Start only for a drawn route.
    $('route-export').hidden = !this.last;
    $('route-start').hidden = !this.last || !this.onStart;
    // No empty row on a route panel that's still being planned.
    if ($('route-save-form').hidden) $('route-actions').hidden = $('route-go').hidden && button.hidden && $('route-export').hidden;
  }

  private showSaveForm(open: boolean): void {
    $('route-save-form').hidden = !open;
    $('route-actions').hidden = open;
    if (!open || !this.dest) return;
    const place = this.dest.name ?? this.dest.near ?? coordsText(this.dest);
    const input = $<HTMLInputElement>('route-save-name');
    input.placeholder = this.last ? `To ${place}` : this.dest.name ?? this.dest.near ?? `Pin ${place}`;
    suggestName(input, input.placeholder);
    input.focus();
    input.select();
  }

  private async save(name: string): Promise<void> {
    if (!this.dest) return;
    const title = name || $<HTMLInputElement>('route-save-name').placeholder;
    try {
      if (this.last) {
        if (!this.onSaveTrack) return;
        await this.onSaveTrack({ name: title, ...routeAsTrack(title, this.last.route, this.dest, this.vias) });
      } else {
        if (!this.onSave) return;
        await this.onSave({ id: newId(), name: title, added: Date.now(), kind: 'pin', lon: this.dest.lon, lat: this.dest.lat });
      }
      this.saved = true;
      this.showSaveForm(false);
      this.showSave();
    } catch (err) {
      this.setInfo($('route-info').textContent ?? '', $('route-off').textContent ?? '', `Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Saves a place as a pin under its name (renamed later in Saved places), leaving the route. */
  private async savePin(p: Place): Promise<void> {
    try {
      await this.onSave?.({ id: newId(), name: p.name ?? p.near ?? `Pin ${coordsText(p)}`, added: Date.now(), kind: 'pin', lon: p.lon, lat: p.lat });
    } catch (err) {
      this.setInfo($('route-info').textContent ?? '', $('route-off').textContent ?? '', `Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The drawn route as a GPX file, handed to the share sheet (or downloaded). */
  private async exportGpx(): Promise<void> {
    if (!this.last || !this.dest) return;
    const name = $('route-title').textContent || 'Route';
    const gpx = routeGpx({ name, summary: $('route-info').textContent ?? '', route: this.last.route, start: this.last.route.offRoadStart?.[0] ?? this.last.from, vias: this.vias, dest: this.dest });
    await shareFile(gpxFileName(name), gpx).catch((err) => this.setInfo($('route-info').textContent ?? '', $('route-off').textContent ?? '', `Couldn't export: ${err instanceof Error ? err.message : String(err)}`));
  }

  private clearStart(): void {
    this.start = null;
    this.fromCentre = null;
    this.startPin?.remove();
    this.startPin = null;
  }

  private startKind(): StartKind {
    return this.start ? 'chosen' : this.searchFrom().gps ? 'gps' : 'centre';
  }

  private showFrom(): void {
    const from = FROM_TEXT[this.startKind()];
    $('route-from-text').textContent = from[0].toUpperCase() + from.slice(1);
  }

  /** The "Use my location" / "Choose on the map" choices; choosing on the map is the emphasised
   *  one when there's no recent GPS position. */
  private showChoices(show: boolean): void {
    $('route-choices').hidden = !show;
    $('route-change').setAttribute('aria-expanded', String(show));
    $('route-choose').classList.toggle('primary', !this.searchFrom().gps);
  }

  private setInfo(info: string, off: string, msg: string): void {
    $('route-info').textContent = info;
    $('route-off').textContent = off;
    $('route-msg').textContent = msg;
    if (msg && this.minimized) this.setMinimized(false);
  }

  /** The F-road switches, on the route panel only; "Prefer" only while F-roads are allowed. */
  private showSwitches(): void {
    $('route-switch').hidden = !this.started;
    $('route-prefer-switch').hidden = !this.started || !this.allow;
    $('route-options-toggle').hidden = !this.started;
    if (!this.started) this.showOptions(false);
    $('route-options-sum').textContent = !this.allow ? 'No F-roads' : this.prefer ? 'F-roads preferred' : 'F-roads allowed';
    $('route-stop-to').hidden = !this.started;
    if (this.dest) $('route-to-text').textContent = this.dest.name ?? this.dest.near ?? coordsText(this.dest);
  }

  private showOptions(open: boolean): void {
    $('route-options').hidden = !open;
    $('route-options-toggle').setAttribute('aria-expanded', String(open));
  }


  /** The card as a route panel (title "To …", the F-road switch), for a route or its preparations. */
  private showStarted(): void {
    if (!this.dest) return;
    this.started = true;
    $('route-go').hidden = true;
    this.showSwitches();
    const place = this.dest.name ?? `dropped pin · ${this.dest.near ?? coordsText(this.dest)}`;
    $('route-title').textContent = this.dest.saved ? `Routing to ${place}` : `To ${place}`;
    this.showSave();
    this.onChange?.();
  }

  private async useMyLocation(): Promise<void> {
    this.showChoices(false);
    this.choosing = false;
    this.clearStart();
    this.showFrom();
    if (!this.dest) return;
    if (!this.searchFrom().gps) {
      const seq = ++this.seq;
      this.planning = false;
      this.useLocation();
      this.showStarted();
      this.drawRoute(EMPTY);
      this.setInfo('Waiting for your position…', '', '');
      const t0 = Date.now();
      this.waiting = true;
      while (!this.searchFrom().gps) {
        if (Date.now() - t0 > FIX_WAIT_MS) {
          this.waiting = false;
          this.setInfo('', '', "Couldn't get your position");
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
        if (seq !== this.seq) return; // cancelled: another pick, ×, or a new start
      }
      this.waiting = false;
    }
    void this.route();
  }

  private chooseOnMap(): void {
    this.showChoices(false);
    this.seq++; // a route in progress no longer applies
    this.planning = false;
    this.waiting = false;
    this.choosing = true;
    this.drawRoute(EMPTY);
    this.setInfo("Tap the map where you'll start", '', '');
  }

  private setStart(at: [number, number]): void {
    this.choosing = false;
    this.start = at;
    this.startPin?.remove();
    this.startPin = new maplibregl.Marker({ element: startPinElement(), anchor: 'bottom' }).setLngLat(at).addTo(this.map);
    this.showFrom();
    void this.route();
  }

  private async route(): Promise<void> {
    if (!this.dest) return;
    const seq = ++this.seq;
    this.choosing = false;
    this.waiting = false;
    const kind = this.startKind();
    const from = this.start ?? this.searchFrom().at;
    this.fromCentre = kind === 'centre' ? from : null;
    const fit = this.fitRoute;
    this.fitRoute = true;
    this.saved = false;
    this.last = null;
    this.showStarted();
    this.showFrom();
    this.setInfo('Preparing roads…', '', '');
    this.planning = true;
    // Leg by leg through the waypoints; a waypoint right at the previous stop adds no leg.
    const stops: LonLat[] = [from, ...this.vias.map((v): LonLat => [v.lon, v.lat]), [this.dest.lon, this.dest.lat]];
    const legs: RouteOk[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const reply = await this.plan(stops[i], stops[i + 1], this.allow, this.prefer).catch((err) => ({ status: 'error' as const, err }));
      if (seq !== this.seq) return; // superseded
      if (reply.status === 'ok') {
        legs.push(reply);
        // A waypoint snaps to the road: it moves to where the route passes it.
        if (i + 2 < stops.length) {
          const [lon, lat] = reply.coords[reply.coords.length - 1];
          this.vias[i] = { ...this.vias[i], lon, lat };
          stops[i + 1] = [lon, lat];
        }
      } else if (reply.status !== 'same-place' || stops.length === 2) {
        this.planning = false;
        this.drawRoute(EMPTY);
        this.onPlanned?.(false);
        const leg = stops.length === 2 ? '' : i + 2 < stops.length ? `To waypoint ${i + 1}: ` : 'To the destination: ';
        this.setInfo('', '', leg + routeMessage(reply, i === 0 ? kind : 'chosen'));
        return;
      }
    }
    this.planning = false;
    if (!legs.length) {
      this.drawRoute(EMPTY);
      this.onPlanned?.(false);
      this.setInfo('', '', routeMessage({ status: 'same-place' }, kind));
      return;
    }
    this.setVias(this.vias);
    this.showRoute(legs.length === 1 ? legs[0] : joinLegs(legs), from, kind, fit);
    this.onPlanned?.(true);
  }

  /** Draws a found (or saved) route with its numbers, and fits it in view when `fit`. */
  private showRoute(reply: JoinedRoute, from: [number, number], kind: StartKind, fit: boolean): void {
    const feature = (k: string, geometry: GeoJSON.Geometry): GeoJSON.Feature => ({ type: 'Feature', properties: { kind: k }, geometry });
    const features = [feature('route', { type: 'LineString', coordinates: reply.coords })];
    // Waypoints sit on the road (see route()), so only the start and end have off-road legs.
    for (const leg of [reply.offRoadStart, reply.offRoadEnd]) if (leg) features.push(feature('offroad', { type: 'LineString', coordinates: leg }));
    // A chosen start has its pin; otherwise a dot marks where the route starts.
    if (kind !== 'chosen') features.push(feature('start', { type: 'Point', coordinates: reply.coords[0] }));
    this.drawRoute({ type: 'FeatureCollection', features });
    this.last = { route: reply, from };
    this.showSave();
    const via = this.vias.length ? ` · via ${this.vias.length} waypoint${this.vias.length === 1 ? '' : 's'}` : '';
    this.setInfo(`${fmtKm(reply.metres)} · ${fmtTime(reply.seconds)}${via}`, offRoadText(reply.offRoadStartM, reply.offRoadEndM), '');
    // The blue band: drive time, distance and when you'd arrive leaving now (no guidance, so it
    // doesn't count down as you drive).
    const arrive = new Date(Date.now() + reply.seconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    $('route-time').textContent = fmtTime(reply.seconds);
    const sub = document.createElement('span');
    sub.className = 'arrive-part';
    sub.textContent = ` · arrive about ${arrive}`;
    $('route-sub').replaceChildren(fmtKm(reply.metres), sub);
    $('route-arrive').textContent = arrive;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lon, lat] of [...reply.coords, ...(reply.offRoadStart ?? []), ...(reply.offRoadEnd ?? [])]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    if (!fit) return;
    // The route fits in the map the card leaves: above it, or beside it where the card is a column
    // on the left of a wide screen (it then covers more of the map's width than its height).
    const card = $('route-card').getBoundingClientRect();
    const box = this.map.getContainer().getBoundingClientRect();
    const beside = (card.right - box.left) / box.width < 0.6 && (box.bottom - card.top) / box.height > 0.5;
    const padding = beside
      ? { top: 80, bottom: 60, left: card.right - box.left + 30, right: 40 }
      : { top: 80, bottom: Math.max(60, box.bottom - card.top + 20), left: 40, right: 40 };
    this.map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 15, duration: 800 });
  }
}
