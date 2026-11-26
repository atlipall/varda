import { storageName } from '../channel';

/** What the app keeps about Drive sync on this device, apart from signing in and syncing
 *  (google.ts, app/driveSync.ts), so the app's start can tell whether it needs those yet. */

/** The app's OAuth client ID (public; made in Google Cloud Console), or VITE_GOOGLE_CLIENT_ID at
 *  build time (the e2e run uses a fake). Empty: sync isn't offered. */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID || '461823178284-761cjr28lki3ocobgt9n8kag1op4f5rp.apps.googleusercontent.com';
const KEY = storageName('google-sync');

/** What's remembered on this device: whether sync is on, the current token and the last sync. */
export interface SyncState {
  on: boolean;
  token?: string;
  expires?: number;
  lastSync?: number;
  fileId?: string;
  /** The sync file's version after the last sync here (unchanged since: no download needed). */
  version?: string;
  /** When something last changed here, and the last such change a sync has taken in. */
  changedAt?: number;
  syncedAt?: number;
  /** The sync file's version when every photo's picture was last found in place (here, and in
   *  Drive): while the file keeps it, a sync needn't list the pictures in Drive. */
  picturesAt?: string;
  /** The refresh key, sealed by the sign-in helper: new tokens without signing in again. */
  sealed?: string;
}

export function syncState(): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return s && typeof s === 'object' ? { on: s.on === true, token: s.token, expires: s.expires, lastSync: s.lastSync, fileId: s.fileId, version: s.version, changedAt: s.changedAt, syncedAt: s.syncedAt, picturesAt: typeof s.picturesAt === 'string' ? s.picturesAt : undefined, sealed: typeof s.sealed === 'string' ? s.sealed : undefined } : { on: false };
  } catch {
    return { on: false };
  }
}

export function setSyncState(s: SyncState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered: sync asks to sign in again next time
  }
}
