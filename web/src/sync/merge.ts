import type { StoredTrack } from '../gpx/store';
import { changedAt, makeBackup, type Backup } from '../saved/backup';
import type { Saved } from '../saved/saved';
import type { Photo } from '../photos/photo';

/** What this device holds. */
export interface Local {
  saved: Saved[];
  tracks: StoredTrack[];
  deleted: Record<string, number>;
  /** The photos here, when this device syncs photos; else (null or left out) the file's photos are
   *  passed through untouched and nothing changes in the photos here. */
  photos?: Photo[] | null;
}

/** The outcome of comparing this device with the synced file: what to change here, and the file
 *  to write back when it differs from what's there. */
export interface SyncPlan {
  putSaved: Saved[];
  putTracks: StoredTrack[];
  removeSaved: string[];
  removeTracks: string[];
  putPhotos: Photo[];
  removePhotos: string[];
  /** Deletions known on either side (the newer time for an id deleted on both). */
  deleted: Record<string, number>;
  /** The merged data to upload, or null when the file already holds it. */
  upload: Backup | null;
}

type Item = { id: string; added: number; updated?: number };

/** A time further ahead than this (a device whose clock runs fast) is stored as now plus this: kept
 *  as it was, a deletion or edit "an hour from now" would beat everything done elsewhere for an
 *  hour, and every sync would carry it on. */
const FUTURE_MS = 5 * 60_000;

/** One kind of item: for each id, the copy changed last wins, unless the item was deleted after
 *  that change. Items changed "in the future" get their time capped (and written back). */
function mergeKind<T extends Item>(mine: T[], theirs: T[], deleted: Record<string, number>, limit: number) {
  const at = (x: T) => changedAt(x);
  const local = new Map(mine.map((x) => [x.id, x]));
  const remote = new Map(theirs.map((x) => [x.id, x]));
  const kept: T[] = [];
  const put: T[] = [];
  const remove: string[] = [];
  let remoteDiffers = false;
  for (const id of new Set([...local.keys(), ...remote.keys()])) {
    const l = local.get(id);
    const r = remote.get(id);
    let win = !l ? r! : !r ? l : at(r) > at(l) ? r : l;
    if (at(win) > limit) win = { ...win, updated: limit };
    const gone = deleted[id] !== undefined && deleted[id] >= at(win);
    if (gone) {
      if (l) remove.push(id);
      if (r) remoteDiffers = true;
      continue;
    }
    kept.push(win);
    if (win !== l) put.push(win);
    if (win !== r && (!r || changedAt(win) !== changedAt(r))) remoteDiffers = true;
  }
  return { kept: kept.sort((a, b) => a.added - b.added), put, remove, remoteDiffers };
}

export function planSync(local: Local, remote: Backup | null, now = new Date()): SyncPlan {
  const limit = now.getTime() + FUTURE_MS;
  const deleted: Record<string, number> = { ...(remote?.deleted ?? {}) };
  for (const [id, at] of Object.entries(local.deleted)) deleted[id] = Math.max(at, deleted[id] ?? 0);
  for (const id of Object.keys(deleted)) deleted[id] = Math.min(deleted[id], limit);
  const saved = mergeKind(local.saved, remote?.saved ?? [], deleted, limit);
  const tracks = mergeKind(local.tracks, remote?.tracks ?? [], deleted, limit);
  // Not syncing photos here: the file's photos stay as they are (less any deleted).
  const syncPhotos = Array.isArray(local.photos);
  const photos = mergeKind(syncPhotos ? local.photos! : remote?.photos ?? [], remote?.photos ?? [], deleted, limit);
  const theirDeleted = remote?.deleted ?? {};
  const deletedDiffers = Object.keys(deleted).length !== Object.keys(theirDeleted).length || Object.entries(deleted).some(([id, at]) => theirDeleted[id] !== at);
  const upload = !remote || saved.remoteDiffers || tracks.remoteDiffers || photos.remoteDiffers || deletedDiffers ? makeBackup(saved.kept, tracks.kept, deleted, now, photos.kept) : null;
  return {
    putSaved: saved.put,
    putTracks: tracks.put,
    removeSaved: saved.remove,
    removeTracks: tracks.remove,
    putPhotos: syncPhotos ? photos.put : [],
    removePhotos: syncPhotos ? photos.remove : [],
    deleted,
    upload,
  };
}

/** Two sync files as one (two devices that first synced at the same moment each made one). */
export function mergeFiles(a: Backup, b: Backup, now = new Date()): Backup {
  const merged = planSync({ saved: a.saved, tracks: a.tracks, deleted: a.deleted ?? {}, photos: a.photos ?? [] }, b, now).upload ?? b;
  // The track files both name (the later write of a track's points where both do).
  const files = { ...a.trackFiles };
  for (const [id, f] of Object.entries(b.trackFiles ?? {})) if (!files[id] || f.at > files[id].at) files[id] = f;
  return a.trackFiles || b.trackFiles ? { ...merged, trackFiles: files } : merged;
}
