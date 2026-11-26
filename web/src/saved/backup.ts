import type { StoredTrack } from '../gpx/store';
import { isSaved, type Saved } from './saved';
import { isPhoto, type Photo } from '../photos/photo';

/** A backup of everything the user keeps on the device besides the map: saved pins and routes,
 *  and GPX tracks. Also the shape of the Google Drive sync file (with deletions). */
export interface Backup {
  app: 'garmin-map';
  kind: 'backup';
  version: 1;
  /** When it was written (ISO time). */
  exported: string;
  saved: Saved[];
  tracks: StoredTrack[];
  /** Photos (their details; each picture is a file of its own in Drive), when a device syncs
   *  photos. Not in backup files. */
  photos?: Photo[];
  /** Deleted items: id → when (ms), so a deletion reaches other devices when syncing. */
  deleted?: Record<string, number>;
  /** In the Drive sync file: each track's points as a file of its own (sync/trackFiles.ts). Not
   *  in backup files. */
  trackFiles?: Record<string, TrackFile>;
}

/** Where a track's points are in Drive: the file, which points it holds (`pointsKey`) and the
 *  track's change time when they were written. */
export interface TrackFile {
  file: string;
  points: string;
  at: number;
}

/** An item's last change (ms): when it was last edited, else when it was added. */
export const changedAt = (x: { added: number; updated?: number }) => x.updated ?? x.added;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';
const isPoint = (p: unknown) => {
  const q = p as { lon: unknown; lat: unknown; ele?: unknown; time?: unknown };
  return !!q && isNum(q.lon) && isNum(q.lat) && Math.abs(q.lat) <= 90 && Math.abs(q.lon) <= 180
    && (q.ele === undefined || q.ele === null || isNum(q.ele)) && (q.time === undefined || q.time === null || isNum(q.time));
};
/** A track colour as the app makes them (#rrggbb): anything else (a url(), say) would be fetched
 *  when the colour is used. */
export const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** A stored GPX track that looks right, all the way down to its points (one that isn't would break
 *  the Tracks panel on every synced device). */
export function isTrack(v: unknown): v is StoredTrack {
  const t = v as StoredTrack;
  if (!t || typeof t.id !== 'string' || typeof t.name !== 'string' || !isColor(t.color) || typeof t.visible !== 'boolean' || !isNum(t.added)) return false;
  if (t.updated !== undefined && !isNum(t.updated)) return false;
  const s = t.stats;
  if (!s || !isNum(s.distance) || !(s.climb === null || isNum(s.climb)) || !(s.duration === null || isNum(s.duration))) return false;
  // A route saved as a track: its road stretches must index its line's points.
  if (t.route !== undefined) {
    const r = t.route as { segs?: unknown; seconds?: unknown };
    const n = t.gpx?.lines?.[0]?.points?.length ?? 0;
    const okSeg = (x: unknown) => {
      const sg = x as { start: unknown; name: unknown; type: unknown; seconds: unknown };
      return !!sg && isNum(sg.start) && sg.start >= 0 && sg.start < n && isStrOrNull(sg.name) && isNum(sg.type) && isNum(sg.seconds);
    };
    if (!r || !isNum(r.seconds) || !Array.isArray(r.segs) || !r.segs.length || !r.segs.every(okSeg)) return false;
  }
  const g = t.gpx;
  return !!g && isStrOrNull(g.name) && Array.isArray(g.lines) && Array.isArray(g.waypoints)
    && g.lines.every((l) => !!l && (l.kind === 'track' || l.kind === 'route') && isStrOrNull(l.name) && Array.isArray(l.points) && l.points.every(isPoint))
    && g.waypoints.every((w) => isPoint(w) && isStrOrNull(w.name));
}

export function makeBackup(saved: Saved[], tracks: StoredTrack[], deleted: Record<string, number> = {}, now = new Date(), photos?: Photo[]): Backup {
  return { app: 'garmin-map', kind: 'backup', version: 1, exported: now.toISOString(), saved, tracks, deleted, ...(photos?.length ? { photos } : {}) };
}

/** A backup file's contents; throws with a message for the user when it isn't one. Items that
 *  don't look right are left out. */
export function parseBackup(text: string): Backup {
  return backupFrom(parseJson(text));
}

/** The JSON of a backup file; throws with a message for the user when it isn't JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("This isn't a Varda backup file.");
  }
}

/** A backup from its parsed JSON (as parseBackup). */
export function backupFrom(v: unknown): Backup {
  const b = v as Backup;
  if (!b || b.app !== 'garmin-map' || b.kind !== 'backup') throw new Error("This isn't a Varda backup file.");
  if (b.version !== 1) throw new Error('This backup is from a newer version of the app.');
  const deleted: Record<string, number> = {};
  for (const [id, at] of Object.entries(b.deleted ?? {})) if (isNum(at)) deleted[id] = at;
  const trackFiles: Record<string, TrackFile> = {};
  for (const [id, f] of Object.entries(b.trackFiles ?? {})) {
    if (f && typeof f.file === 'string' && typeof f.points === 'string' && isNum(f.at)) trackFiles[id] = { file: f.file, points: f.points, at: f.at };
  }
  return {
    ...b,
    saved: Array.isArray(b.saved) ? b.saved.filter(isSaved) : [],
    tracks: Array.isArray(b.tracks) ? b.tracks.filter(isTrack) : [],
    photos: Array.isArray(b.photos) ? b.photos.filter(isPhoto) : [],
    deleted,
    ...(b.trackFiles ? { trackFiles } : {}),
  };
}

/** The incoming items to store here: those this device doesn't have, and those changed later than
 *  its copy. With `deleted`, an item deleted after its last change is left out. */
export function toStore<T extends { id: string; added: number; updated?: number }>(local: T[], incoming: T[], deleted: Record<string, number> = {}): T[] {
  const mine = new Map(local.map((x) => [x.id, x]));
  return incoming.filter((x) => {
    const gone = deleted[x.id];
    if (gone !== undefined && gone >= changedAt(x)) return false;
    const m = mine.get(x.id);
    return !m || changedAt(x) > changedAt(m);
  });
}

export const backupFileName = (now = new Date()) => `Varda backup ${now.toISOString().slice(0, 10)}.json`;
