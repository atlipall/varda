import { backupFrom, parseJson, type Backup } from '../saved/backup';
import { mergeFiles } from './merge';
import { DEV } from '../channel';

/** The one file the app keeps in the user's Google Drive, in the hidden app-data folder (only this
 *  app can see it; the user's own files stay out of reach: scope drive.appdata). */
/** The sync file in Drive's hidden app folder (the development version keeps its own). */
export const SYNC_FILE = DEV ? 'garmin-map-sync-dev.json' : 'garmin-map-sync.json';
export const API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** A Drive request that failed; `status` 401 means the sign-in has expired. */
export class DriveError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new DriveError(res.status, res.status === 401 ? 'The Google sign-in has expired.' : `Google Drive answered ${res.status}.`);
  return res;
}

/** What's in Drive: the sync file to use (the oldest, if two devices each made one), its contents
 *  merged with any others', and its version; `unchanged` when its version is the one given and
 *  there's only one (nothing downloaded then). */
export interface SyncFile {
  id: string | null;
  data: Backup | null;
  version: string | null;
  /** Other sync files, merged into `data`; deleted once it's written. */
  extra: string[];
  unchanged?: boolean;
}

/** `fill` completes a file's parsed JSON before it's read (the tracks' points, sync/trackFiles.ts). */
export async function readSyncFile(token: string, knownVersion: string | null = null, fill: (raw: unknown) => Promise<void> = async () => {}): Promise<SyncFile> {
  const read = async (fileId: string) => {
    const raw = parseJson(await (await call(token, `${API}/files/${fileId}?alt=media`)).text());
    await fill(raw);
    return backupFrom(raw);
  };
  const q = encodeURIComponent(`name='${SYNC_FILE}'`);
  const list = (await (await call(token, `${API}/files?spaces=appDataFolder&q=${q}&orderBy=createdTime&fields=files(id,version)`)).json()) as { files?: Array<{ id: string; version?: string }> };
  const files = list.files ?? [];
  if (!files.length) return { id: null, data: null, version: null, extra: [] };
  const [first, ...rest] = files;
  const version = first.version ?? null;
  if (!rest.length && knownVersion && version === knownVersion) return { id: first.id, data: null, version, extra: [], unchanged: true };
  let data = await read(first.id);
  for (const f of rest) data = mergeFiles(data, await read(f.id));
  return { id: first.id, data, version, extra: rest.map((f) => f.id) };
}

/** Writes the sync file (creating it in the app-data folder the first time); returns its id and
 *  new version. */
export async function writeSyncFile(token: string, id: string | null, data: Backup): Promise<{ id: string; version: string | null }> {
  const body = JSON.stringify(data);
  if (id) {
    const res = await call(token, `${UPLOAD}/files/${id}?uploadType=media&fields=id,version`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    const f = (await res.json()) as { id: string; version?: string };
    return { id, version: f.version ?? null };
  }
  const boundary = `garmin-map-${Math.random().toString(36).slice(2)}`;
  const meta = JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await call(token, `${UPLOAD}/files?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  const f = (await res.json()) as { id: string; version?: string };
  return { id: f.id, version: f.version ?? null };
}

/** Deletes a sync file (an extra one, merged into the main one). */
export async function deleteSyncFile(token: string, id: string): Promise<void> {
  await call(token, `${API}/files/${id}`, { method: 'DELETE' });
}
