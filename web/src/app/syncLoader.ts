import { GOOGLE_CLIENT_ID, syncState } from '../sync/state';
import type { DriveSync } from './driveSync';

/**
 * Drive sync (./driveSync.ts and ../sync/), loaded only when it's needed: at the start when sync
 * is on here or the page is back from Google's sign-in, else when the sync panel is first opened.
 * Until then nothing it does would happen anyway (a change here is synced only while sync is on).
 */
export class SyncLoader {
  private real: DriveSync | null = null;
  private loading: Promise<DriveSync> | null = null;
  private photosHere: DriveSync['photos'] = null;

  constructor(private readonly reload: () => Promise<void>) {
    if (!GOOGLE_CLIENT_ID) return;
    document.getElementById('sync')!.hidden = false;
    const back = /[?&](code|error)=/.test(location.search);
    if (syncState().on || back) this.load().catch((err) => console.warn('sync', err));
  }

  /** The sync itself (loaded now if it isn't yet). */
  load(): Promise<DriveSync> {
    this.loading ??= import('./driveSync').then((m) => {
      const s = new m.DriveSync(this.reload);
      s.photos = this.photosHere;
      this.real = s;
      return s;
    }).catch((err) => {
      this.loading = null; // tried again next time
      throw err;
    });
    return this.loading;
  }

  /** The photos on the map, for the sync to tell. */
  set photos(p: DriveSync['photos']) {
    this.photosHere = p;
    if (this.real) this.real.photos = p;
  }

  changed(): void {
    if (this.loading) this.loading.then((s) => s.changed(), () => {});
  }

  photosChanged(): void {
    this.real?.photosChanged();
  }

  async syncNow(): Promise<void> {
    return (await this.load()).syncNow();
  }
}
