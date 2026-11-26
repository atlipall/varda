import type * as maplibregl from 'maplibre-gl';
import { storageName } from '../channel';
import { formatStats, summarize } from '../gpx/stats';
import type { StoredTrack } from '../gpx/store';
import { NAME_MAX, suggestName } from '../ui/rename';
import { parseTrip, tripGpx, tripId, tripName, type Trip } from '../tracks/trip';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Untouched this long, the save card closes by itself: the trip is kept under its suggested name. */
export const AUTO_SAVE_MS = 30_000;
/** How long the quiet "Saved to Tracks" note stays. */
const NOTE_MS = 4000;
/** Discard asks again; a second tap within this time deletes. */
const CONFIRM_MS = 3000;
/** The trail drawn while recording keeps a point about this often (m). */
const TRAIL_M = 10;
/** While recording, the trail is stored at most this often (and when the page is hidden): a reload
 *  loses at most this much of it, and three hours of trail aren't written out every second. */
const STORE_MS = 30_000;
/** The trail's newest points are redrawn on each fix; at this many they're folded into the rest,
 *  which is only redrawn then (a long trail isn't sent to the map's worker every second). */
const TAIL_POINTS = 60;
/** Record asked and no answer from the app in this time: it can't record (an older app). */
const CONFIRM_START_MS = 10_000;

const RECORD_ICON = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="11" cy="11" r="5" fill="#d32f2f"/></svg>';
const STOP_ICON = '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="2" fill="#fff"/></svg>';

const KEY = storageName('trip-recording');

/** What the map keeps about a recording in progress (the app holds the trip itself). */
interface Recording {
  start: number;
  metres: number;
  trail: Array<[number, number]>;
}

const metresBetween = (a: [number, number], b: [number, number]) =>
  Math.hypot((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 111_195;

function load(): Recording | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Recording | null;
    return r && typeof r.start === 'number' && Array.isArray(r.trail) ? r : null;
  } catch {
    return null;
  }
}

function store(r: Recording | null): void {
  try {
    if (r) localStorage.setItem(KEY, JSON.stringify(r));
    else localStorage.removeItem(KEY);
  } catch {
    // private mode or full: the pill and trail just don't outlive a reload
  }
}

export interface TripDeps {
  /** The Android app's package (the record button only shows in it). */
  app: string;
  /** Opens a link the Android app handles (garminmap://trip/…). */
  open(href: string): void;
  tracks: {
    has(id: string): boolean;
    add(t: { id: string; name: string; gpx: StoredTrack['gpx'] }): Promise<StoredTrack>;
    rename(t: StoredTrack, name: string): Promise<void>;
    remove(id: string): Promise<void>;
    show(t: StoredTrack): void;
  };
  now?: () => number;
}

/**
 * Recording a trip, in the Android app: the record button by the save-a-pin button asks the app to
 * record (it reads the GPS itself, in the background). The app answers in the address after `#`:
 * `trip-recording=<start>` once it records, `trip-failed=location` without precise location; an
 * app too old to record lets Chrome fall back to `trip-failed=old-app`. While it records, the pill on top shows the
 * distance and time and the map draws the way so far (from the fixes the map sees), and the button
 * is Stop. On Stop the app opens the map with the whole trip in the address (../tracks/trip.ts):
 * it's kept in Tracks at once under a suggested name, and a card offers to rename or discard it;
 * left alone, the card closes after 30 s with a quiet note.
 */
export class TripRecorder implements maplibregl.IControl {
  private readonly container = document.createElement('div');
  private readonly button = document.createElement('button');
  private rec: Recording | null = load();
  private map: maplibregl.Map | null = null;
  private tick = 0;
  /** The trip on the save card. */
  private saved: StoredTrack | null = null;
  private autoTimer = 0;
  private noteTimer = 0;
  private confirmTimer = 0;
  /** Waiting for the app to say it records. */
  private startTimer = 0;
  /** The trail since it was last stored is still to store (`storeTimer` set). */
  private storeTimer = 0;
  /** Where the live tail starts in the trail (the points before it are in `trip-done`). */
  private tailFrom = 0;

  constructor(private readonly deps: TripDeps) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group trip-record';
    this.button.type = 'button';
    this.button.className = 'trip-record-button';
    this.button.onclick = () => (this.rec ? this.stop() : this.start());
    this.container.append(this.button);
    $<HTMLFormElement>('trip-form').onsubmit = (e) => {
      e.preventDefault();
      void this.saveName();
    };
    $('trip-close').onclick = () => this.closeCard(true);
    $('trip-discard').onclick = () => this.discard();
    // Any use of the card (typing a name, a first tap on Discard) stops it closing by itself.
    $('trip-card').addEventListener('input', () => clearTimeout(this.autoTimer));
    $('trip-card').addEventListener('pointerdown', () => clearTimeout(this.autoTimer));
    window.addEventListener('hashchange', () => void this.receive(location.hash));
    // Put away or reloaded: the trail so far is kept.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.storeNow());
    window.addEventListener('pagehide', () => this.storeNow());
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    // The way so far in two parts: `trip-done` redrawn now and then, `trip-live` (its newest
    // points) on each fix.
    for (const id of ['trip-done', 'trip-live']) {
      if (map.getSource(id)) continue;
      map.addSource(id, { type: 'geojson', data: line([]) });
      map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d32f2f', 'line-width': 4, 'line-opacity': 0.85 } });
    }
    this.render();
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
    clearInterval(this.tick);
  }

  /** A trip in the address at startup (the app opened the map with it). */
  async receiveStartup(): Promise<void> {
    await this.receive(location.hash);
  }

  /** A position the map got: drawn on the way so far while recording. */
  fix(at: [number, number]): void {
    const r = this.rec;
    if (!r) return;
    const last = r.trail[r.trail.length - 1];
    if (last) {
      const d = metresBetween(last, at);
      if (d < TRAIL_M) return;
      r.metres += d;
    }
    r.trail.push(at);
    this.storeSoon();
    if (r.trail.length - this.tailFrom > TAIL_POINTS) this.renderTrail();
    else this.renderTail();
    this.renderPill();
  }

  /** Stores the recording within `STORE_MS`, unless that's already planned. */
  private storeSoon(): void {
    if (!this.storeTimer) this.storeTimer = window.setTimeout(() => this.storeNow(), STORE_MS);
  }

  /** Stores the recording (or its end) now; unless `always`, only if there's something new. */
  private storeNow(always = false): void {
    if (!always && !this.storeTimer) return;
    clearTimeout(this.storeTimer);
    this.storeTimer = 0;
    store(this.rec);
  }

  /** Whether a trip is being recorded (for tests). */
  get recording(): boolean {
    return this.rec !== null;
  }

  /** Asks the app to record; the pill shows once it says it does (`receive`). */
  private start(): void {
    clearTimeout(this.startTimer);
    this.startTimer = window.setTimeout(() => this.note("The Android app didn't start recording: install its newest version."), CONFIRM_START_MS);
    this.deps.open(this.link('start'));
  }

  private stop(): void {
    this.deps.open(this.link('stop'));
    this.endRecording();
  }

  private endRecording(): void {
    this.rec = null;
    this.storeNow(true);
    this.render();
  }

  /** The app's link; an app without it (too old) has Chrome open the map with `trip-failed=old-app`. */
  private link(what: 'start' | 'stop'): string {
    const back = encodeURIComponent(`${location.origin}${location.pathname}${location.search}#trip-failed=old-app`);
    return `intent://trip/${what}#Intent;scheme=garminmap;package=${this.deps.app};S.browser_fallback_url=${back};end`;
  }

  /** The app's answer in the address, if it has one. A finished trip is kept in Tracks and offered for
   *  naming. */
  private async receive(hash: string): Promise<void> {
    const recording = /^#trip-recording=(\d+)$/.exec(hash);
    const failed = /^#trip-failed=(location|old-app)$/.exec(hash);
    const trip = parseTrip(hash);
    if (!recording && !failed && !trip) return;
    // Tidy the address, so a reload doesn't bring it in again.
    history.replaceState(history.state, '', location.pathname + location.search);
    clearTimeout(this.startTimer);
    if (recording) {
      const start = Number(recording[1]);
      if (this.rec?.start !== start) this.rec = { start, metres: 0, trail: [] };
      this.storeNow(true);
      this.render();
      return;
    }
    if (failed) {
      this.endRecording();
      return this.note(failed[1] === 'location' ? 'Recording needs precise location: allow it for the app in Android’s settings.' : 'Recording needs the newest version of the Android app.');
    }
    if (!trip) return;
    this.endRecording();
    if (trip.points.length < 2) return this.note('Nothing was recorded: the GPS gave no positions.');
    const id = tripId(trip);
    if (this.deps.tracks.has(id)) return; // already brought in
    const name = tripName(trip.start, trip.end);
    const t = await this.deps.tracks.add({ id, name, gpx: tripGpx(trip, name) });
    this.deps.tracks.show(t);
    this.openCard(t, trip);
  }

  private openCard(t: StoredTrack, trip: Trip): void {
    this.saved = t;
    const input = $<HTMLInputElement>('trip-name');
    suggestName(input, t.name);
    input.maxLength = NAME_MAX;
    $('trip-sub').textContent = [formatStats(summarize(t.gpx)), tripName(trip.start, trip.end).replace(/^Drive [^,]+, /, '')].filter(Boolean).join(' · ');
    this.resetDiscard();
    $('trip-card').hidden = false;
    clearTimeout(this.autoTimer);
    this.autoTimer = window.setTimeout(() => this.closeCard(true), AUTO_SAVE_MS);
  }

  /** Closes the card; the trip stays in Tracks (it was kept when it came in). */
  private closeCard(note: boolean): void {
    clearTimeout(this.autoTimer);
    const t = this.saved;
    this.saved = null;
    $('trip-card').hidden = true;
    if (note && t) this.note(`Saved to Tracks: ${t.name}`);
  }

  private async saveName(): Promise<void> {
    const t = this.saved;
    if (!t) return;
    const name = $<HTMLInputElement>('trip-name').value.trim().replace(/\s+/g, ' ');
    if (name && name !== t.name) await this.deps.tracks.rename(t, name);
    this.closeCard(true);
  }

  private discard(): void {
    const b = $('trip-discard');
    if (!b.classList.contains('confirm')) {
      b.classList.add('confirm');
      b.textContent = 'Delete trip?';
      this.confirmTimer = window.setTimeout(() => this.resetDiscard(), CONFIRM_MS);
      return;
    }
    const t = this.saved;
    this.closeCard(false);
    if (t) void this.deps.tracks.remove(t.id).then(() => this.note('Trip deleted.'));
  }

  private resetDiscard(): void {
    clearTimeout(this.confirmTimer);
    const b = $('trip-discard');
    b.classList.remove('confirm');
    b.textContent = 'Discard';
  }

  private note(text: string): void {
    const n = $('trip-note');
    $('trip-note-text').textContent = text;
    n.hidden = false;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => (n.hidden = true), NOTE_MS);
  }

  private render(): void {
    const on = this.rec !== null;
    this.button.classList.toggle('recording', on);
    this.button.innerHTML = on ? STOP_ICON : RECORD_ICON;
    const label = on ? 'Stop recording' : 'Record trip';
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
    $('trip-pill').hidden = !on;
    document.body.classList.toggle('trip-recording', on);
    clearInterval(this.tick);
    if (on) this.tick = window.setInterval(() => this.renderPill(), 30_000);
    this.renderTrail();
    this.renderPill();
  }

  private renderPill(): void {
    const r = this.rec;
    if (!r) return;
    const minutes = Math.max(0, Math.floor(((this.deps.now ?? Date.now)() - r.start) / 60_000));
    const time = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    $('trip-pill-text').textContent = `${(r.metres / 1000).toFixed(1)} km · ${time}`;
  }

  private source(id: 'trip-done' | 'trip-live'): maplibregl.GeoJSONSource | undefined {
    return this.map?.getSource(id) as maplibregl.GeoJSONSource | undefined;
  }

  /** Draws the whole trail again: all but its last point as the done part, the tail starting there. */
  private renderTrail(): void {
    const t = this.rec?.trail ?? [];
    this.tailFrom = Math.max(0, t.length - 1);
    this.source('trip-done')?.setData(line(t));
    this.renderTail();
  }

  /** Draws the trail's newest points (from where the done part ends). */
  private renderTail(): void {
    this.source('trip-live')?.setData(line((this.rec?.trail ?? []).slice(this.tailFrom)));
  }
}

const line = (t: Array<[number, number]>): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: t.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t } }] : [],
});
