import { DEV } from '../channel';
import type { StoredTrack } from '../gpx/store';
import { changedAt, type TrackFile } from '../saved/backup';
import { API, call, DriveError, UPLOAD } from './drive';

/**
 * Each synced track's points (its GPX and, for a route saved as a track, the road stretches) as a
 * file of its own in Drive's hidden app folder, like the photos' pictures: written once, and again
 * only when the points change, so showing, hiding or renaming a track doesn't send its points
 * again. The sync file keeps an index (`trackFiles`: id → file, which points, when).
 *
 * A track in the sync file without points is filled from its file (or from this device, when it
 * has the same points). While DOUBLE_WRITE is on, the sync file still carries every track's
 * points too, for older versions of the app, which know nothing of the files.
 */

/** Also write each track's points into the sync file, as versions before the track files did.
 *  Turn off once every device runs a version that reads the files (older ones would then see the
 *  tracks without points and leave them out). */
export const DOUBLE_WRITE = true;

const PREFIX = DEV ? 'garmin-map-dev-track-' : 'garmin-map-track-';
export const trackFileName = (id: string) => `${PREFIX}${id}.json`;

type Points = Pick<StoredTrack, 'gpx' | 'route'> & Partial<StoredTrack>;

/** Which points a track has: a hash of its GPX and road stretches (64 bits, two 32-bit hashes). */
export function pointsKey(t: Points): string {
  const s = JSON.stringify([t.gpx, t.route ?? null]);
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) + c) | 0;
  }
  return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${s.length.toString(36)}`;
}

/** A sync file's track without its points (what it holds once DOUBLE_WRITE is off). */
export const withoutPoints = ({ gpx: _g, route: _r, ...rest }: StoredTrack) => rest;

/**
 * Fills in, in a sync file's parsed JSON, the points of each track that came without them: from
 * this device's copy when it has the same points (`here`), else from the track's file. Throws when
 * a file can't be read (the sync is tried again later; a track left out would read as deleted).
 */
export async function fillTracks(token: string, raw: unknown, here: (id: string) => StoredTrack | undefined): Promise<void> {
  const b = raw as { tracks?: unknown; trackFiles?: Record<string, TrackFile> } | null;
  if (!b || !Array.isArray(b.tracks) || !b.trackFiles) return;
  for (const t of b.tracks as Array<Partial<StoredTrack> & { id?: unknown }>) {
    if (!t || typeof t.id !== 'string' || t.gpx !== undefined) continue;
    const entry = b.trackFiles[t.id];
    if (!entry || typeof entry.file !== 'string') continue;
    const mine = here(t.id);
    let points: Points | null = mine && pointsKey(mine) === entry.points ? mine : null;
    if (!points) {
      const got = (await (await call(token, `${API}/files/${encodeURIComponent(entry.file)}?alt=media`)).json()) as { id?: unknown } & Points;
      if (got?.id !== t.id) throw new Error('A track’s points in Google Drive don’t belong to it.');
      points = got;
    }
    t.gpx = points.gpx;
    if (points.route) t.route = points.route;
  }
}

/** The track files in Drive: track id → file id and which points it holds. */
async function listTrackFiles(token: string): Promise<Map<string, { file: string; points: string | null }>> {
  const out = new Map<string, { file: string; points: string | null }>();
  const q = encodeURIComponent(`name contains '${PREFIX}' and trashed = false`);
  let page: string | undefined;
  do {
    const url = `${API}/files?spaces=appDataFolder&q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`;
    const res = (await (await call(token, url)).json()) as { nextPageToken?: string; files?: Array<{ id: string; name: string; appProperties?: { points?: string } }> };
    for (const f of res.files ?? []) {
      if (typeof f.name === 'string' && f.name.startsWith(PREFIX) && f.name.endsWith('.json')) out.set(f.name.slice(PREFIX.length, -5), { file: f.id, points: f.appProperties?.points ?? null });
    }
    page = res.nextPageToken;
  } while (page);
  return out;
}

/** Writes a track's points: a new file, or over `fileId`. The points key goes in the file's
 *  appProperties, so an index lost to an older app's write can be rebuilt without downloading. */
async function writeTrackFile(token: string, fileId: string | null, t: StoredTrack, points: string): Promise<string> {
  const boundary = `garmin-map-${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify(fileId ? { appProperties: { points } } : { name: trackFileName(t.id), parents: ['appDataFolder'], mimeType: 'application/json', appProperties: { points } });
  const content = JSON.stringify({ app: 'garmin-map', kind: 'track-points', version: 1, id: t.id, gpx: t.gpx, ...(t.route ? { route: t.route } : {}) });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const url = fileId ? `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`;
  const res = await call(token, url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return ((await res.json()) as { id: string }).id;
}

/** Whether `index` already holds the points of every one of `tracks` (nothing to write). */
export const indexCurrent = (tracks: StoredTrack[], index: Record<string, TrackFile> | undefined) =>
  !!index && tracks.every((t) => index[t.id]?.points === pointsKey(t)) && Object.keys(index).length === tracks.length;

/**
 * Brings the track files in line with `tracks` (the sync file about to be written) and returns its
 * index. Points already in Drive (`before`, the index read) aren't sent again; a track missing from
 * the index (one an older app's write left out) is looked for by name first. Files of tracks no
 * longer synced are deleted.
 */
export async function writeTrackFiles(token: string, tracks: StoredTrack[], before: Record<string, TrackFile> = {}): Promise<Record<string, TrackFile>> {
  const index: Record<string, TrackFile> = {};
  let found: Map<string, { file: string; points: string | null }> | null = null;
  for (const t of tracks) {
    const points = pointsKey(t);
    const had = before[t.id];
    if (had?.points === points) {
      index[t.id] = had;
      continue;
    }
    let file: string | null = had?.file ?? null;
    if (!file) {
      found ??= await listTrackFiles(token);
      const f = found.get(t.id);
      if (f?.points === points) {
        index[t.id] = { file: f.file, points, at: changedAt(t) };
        continue;
      }
      file = f?.file ?? null;
    }
    const written = await writeTrackFile(token, file, t, points).catch((err) => {
      // Gone from Drive meanwhile: a new one.
      if (file && err instanceof DriveError && err.status === 404) return writeTrackFile(token, null, t, points);
      throw err;
    });
    index[t.id] = { file: written, points, at: changedAt(t) };
  }
  const gone = new Set(Object.values(before).map((f) => f.file));
  for (const f of Object.values(index)) gone.delete(f.file);
  for (const file of gone) await call(token, `${API}/files/${encodeURIComponent(file)}`, { method: 'DELETE' }).catch(() => {});
  return index;
}
