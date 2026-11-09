import type * as maplibregl from 'maplibre-gl';
import { addTrackLayers, nextColor, trackBounds, tracksGeoJson } from '../gpx/layers';
import { parseGpx } from '../gpx/parse';
import { climb, formatStats, summarize } from '../gpx/stats';
import { deleteTrack, listTracks, putTrack, type StoredTrack } from '../gpx/store';
import { noteDeleted } from '../saved/deleted';
import { newId } from '../saved/saved';
import { editName, renameButton } from '../ui/rename';
import { deleteButton, eyeButton, fitClearOf } from './listButtons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Points at least this far apart (m) are sampled when filling in heights from the elevation files. */
const HEIGHT_SAMPLE_M = 25;
const HEIGHT_SAMPLE_MAX = 4000;

const approxMetres = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) =>
  Math.hypot((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat) * 111_195;

/** The first and last point, and those in between at least `spacing` metres from the previous kept one. */
function sample<P extends { lon: number; lat: number }>(points: P[], spacing: number): P[] {
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) if (approxMetres(out[out.length - 1], points[i]) >= spacing) out.push(points[i]);
  out.push(points[points.length - 1]);
  return out;
}


/**
 * The Tracks panel (⋯ → Tracks): imports GPX files, keeps them on the device, draws the visible
 * ones on the map, and lists them with their distance, climb and time.
 */
export class TracksPanel {
  private tracks: StoredTrack[] = [];
  /** Called after a change made here (import, rename, show or hide, delete), for syncing. */
  onChanged: (() => void) | null = null;
  /** A track tapped in the list: its card (Navigate, Reverse, Export). */
  onOpen: ((t: StoredTrack) => void) | null = null;
  /** A track renamed here (its card, if open, shows the new name). */
  onRenamed: ((t: StoredTrack) => void) | null = null;
  private readonly panel = $('tracks');
  private readonly list = $<HTMLUListElement>('track-list');
  private readonly error = $('tracks-error');
  /** Settles once the stored tracks have been read the first time. */
  readonly loaded: Promise<void>;

  constructor(
    private readonly map: maplibregl.Map,
    private readonly elevations: (coords: Array<[number, number]>) => Promise<Array<number | null>>,
    font: string,
  ) {
    addTrackLayers(map, font);
    const input = $<HTMLInputElement>('gpx-file');
    $('import-gpx').onclick = () => input.click();
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      void this.importFiles(files);
    };
    $('tracks-close').onclick = () => this.show(false);
    this.loaded = this.reload();
  }

  /** Reads the tracks from storage again (after a restore or a sync). */
  async reload(): Promise<void> {
    try {
      this.tracks = await listTracks();
      this.refresh();
      for (const tr of this.tracks) if (tr.stats.climb === null) void this.fillClimb(tr);
    } catch (err) {
      this.fail(err);
    }
  }

  show(open: boolean): void {
    this.panel.hidden = !open;
    if (open) this.error.textContent = '';
  }

  /** The tracks as listed (for a backup made within the tap that asks for it). */
  get all(): StoredTrack[] {
    return this.tracks;
  }

  /** Number of stored tracks (for tests). */
  get count(): number {
    return this.tracks.length;
  }

  /** Whether a track with this id is kept. */
  has(id: string): boolean {
    return this.tracks.some((t) => t.id === id);
  }

  /** Keeps a track made here (a route saved as a track, a recorded trip), with the next free colour.
   *  `id`: one of its own (a recorded trip's, so the same trip is never kept twice). */
  async addTrack(t: { id?: string; name: string; gpx: StoredTrack['gpx']; route?: StoredTrack['route'] }): Promise<StoredTrack> {
    const track: StoredTrack = {
      id: t.id ?? newId(),
      name: t.name,
      color: nextColor(this.tracks),
      visible: true,
      added: Date.now(),
      stats: summarize(t.gpx),
      gpx: t.gpx,
      ...(t.route ? { route: t.route } : {}),
    };
    await putTrack(track);
    this.tracks.push(track);
    this.refresh();
    this.onChanged?.();
    if (track.stats.climb === null) void this.fillClimb(track);
    return track;
  }

  async importFiles(files: File[]): Promise<void> {
    this.error.textContent = '';
    const problems: string[] = [];
    let last: StoredTrack | null = null;
    for (const file of files) {
      try {
        const gpx = parseGpx(await file.text());
        const track: StoredTrack = {
          id: newId(),
          name: gpx.name ?? gpx.lines.find((l) => l.name)?.name ?? file.name.replace(/\.gpx$/i, ''),
          color: nextColor(this.tracks),
          visible: true,
          added: Date.now(),
          stats: summarize(gpx),
          gpx,
        };
        await putTrack(track);
        this.tracks.push(track);
        last = track;
        if (track.stats.climb === null) void this.fillClimb(track);
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.refresh();
    if (last) this.onChanged?.();
    if (problems.length) this.error.textContent = problems.join('\n');
    if (last) this.zoomTo(last);
  }

  /** Climb for a GPX without heights, from the elevation files (sampled along the lines). */
  private async fillClimb(track: StoredTrack): Promise<void> {
    if (!track.gpx.lines.length) return;
    const spacing = Math.max(HEIGHT_SAMPLE_M, track.stats.distance / HEIGHT_SAMPLE_MAX);
    const lines = track.gpx.lines.map((l) => sample(l.points, spacing));
    try {
      const heights = await this.elevations(lines.flat().map((p) => [p.lon, p.lat]));
      let k = 0;
      const value = climb(lines.map((l) => l.map(() => heights[k++])));
      if (value === null) return;
      track.stats = { ...track.stats, climb: value };
      track.updated = Date.now();
      await putTrack(track);
      this.refresh();
      this.onChanged?.();
    } catch {
      // No elevation files or a worker error: the climb just stays unknown.
    }
  }

  /** Deletes a track by id (Discard on a recorded trip). */
  async deleteById(id: string): Promise<void> {
    const t = this.tracks.find((x) => x.id === id);
    if (t) await this.remove(t);
  }

  /** Fits the track in view, keeping it clear of this panel while it is open. */
  zoomTo(t: StoredTrack): void {
    fitClearOf(this.map, this.panel, trackBounds(t), 15);
  }

  private refresh(): void {
    (this.map.getSource('gpx') as maplibregl.GeoJSONSource | undefined)?.setData(tracksGeoJson(this.tracks));
    $('tracks-empty').hidden = this.tracks.length > 0;
    this.list.replaceChildren(...this.tracks.map((t) => this.row(t)));
  }

  private row(t: StoredTrack): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'track';
    li.dataset.id = t.id;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = t.color;
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'track-info';
    info.title = 'Show on the map';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    const stats = document.createElement('span');
    stats.className = 'stats';
    stats.textContent = formatStats(t.stats) || `${t.gpx.waypoints.length} waypoints`;
    info.append(name, stats);
    info.onclick = () => {
      if (!t.visible) void this.setVisible(t, true);
      this.zoomTo(t);
      if (matchMedia('(pointer: coarse)').matches) this.show(false);
      this.onOpen?.(t);
    };
    const eye = eyeButton(t.name, t.visible, () => void this.setVisible(t, !t.visible));
    const del = deleteButton(t.name, () => void this.remove(t));
    const rename = renameButton(t.name, () =>
      editName(li, t.name, (name) => void this.rename(t, name), () => li.replaceWith(this.row(t))),
    );
    li.append(swatch, info, rename, eye, del);
    return li;
  }

  /** A new name: kept, synced, and shown on the map's labels and the list. */
  async rename(t: StoredTrack, name: string): Promise<void> {
    t.name = name;
    t.updated = Date.now();
    this.refresh();
    await putTrack(t).catch((err) => this.fail(err));
    this.onChanged?.();
    this.onRenamed?.(t);
  }

  private async setVisible(t: StoredTrack, visible: boolean): Promise<void> {
    t.visible = visible;
    t.updated = Date.now();
    this.refresh();
    await putTrack(t).catch((err) => this.fail(err));
    this.onChanged?.();
  }

  private async remove(t: StoredTrack): Promise<void> {
    try {
      await deleteTrack(t.id);
      noteDeleted(t.id);
      this.tracks = this.tracks.filter((x) => x.id !== t.id);
      this.refresh();
      this.onChanged?.();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.error.textContent = err instanceof Error ? err.message : String(err);
  }
}
