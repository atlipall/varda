import { listTracks } from '../gpx/store';
import { deletions, setDeletions } from '../saved/deleted';
import { listSaved } from '../saved/saved';
import { deleteSyncFile, DriveError, readSyncFile, writeSyncFile } from '../sync/drive';
import { finishSignIn, freshToken, GOOGLE_CLIENT_ID, prepareSignIn, setSyncState, signedIn, signIn, signOut, startSignIn, syncState, validToken } from '../sync/google';
import { AUTH_HELPER, HelperError, helperReachable } from '../sync/helper';
import { applyPlan } from '../sync/apply';
import { planSync } from '../sync/merge';
import { preview, THUMB } from '../photos/copy';
import { filesHere, getFiles, listPhotos, putFiles } from '../photos/photo';
import { deletePhotoFile, downloadPhotoFile, listPhotoFiles, uploadPhotoFile } from '../sync/photoFiles';
import { readSetting, writeSetting } from '../ui/settings';
import { mb } from './photos';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** A change here is synced this long after the last one (ms), so a burst of edits is one sync. */
const AFTER_CHANGE_MS = 3000;

const timeText = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Keeps saved pins and routes and GPX tracks the same on every device signed in to the same Google
 * account, through one file in the hidden app-data folder of the user's Google Drive. Syncs when the
 * app starts, comes back to the screen or back online, and a few seconds after a change here; the
 * copy changed last wins, and deletions carry over. Offered only when the app has a Google client ID.
 * Entirely optional: off until turned on, never loads anything from Google before that, and never
 * holds up the app — everything is read from and saved to the device first, offline or not.
 * Signing in goes through the sign-in helper, so a device stays signed in (../sync/helper.ts); when
 * the helper can't be reached it falls back to Google's one-hour sign-in.
 */
export class DriveSync {
  private running: Promise<void> | null = null;
  private again = false;
  private timer = 0;
  /** The sign-in helper didn't answer: "Sign in" uses Google's one-hour sign-in meanwhile. */
  private helperDown = !AUTH_HELPER;
  /** A Drive refusal already led to a new token once in a row (don't loop on it). */
  private retried = false;
  /** The photos on the map: told when a sync brings photos in or a picture arrives. */
  photos: { reload(): Promise<void>; arrived(id: string): void } | null = null;
  /** Photos are synced too (a switch in the sync panel, per device). */
  private photosOn = readSetting('syncPhotos', false);

  /** `reload` reads the saved items and tracks again after a sync changed them here. */
  constructor(private readonly reload: () => Promise<void>) {
    if (!GOOGLE_CLIENT_ID) return;
    $('sync').hidden = false;
    $('sync-connect').onclick = () => void this.connect();
    $('sync-now').onclick = () => void this.syncNow();
    $('sync-stop').onclick = () => {
      signOut();
      this.render();
    };
    $('sync-photos').onclick = () => void this.togglePhotos();
    this.render();
    void this.start();
    window.addEventListener('online', () => this.schedule(0));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.schedule(0));
  }

  /** Back from Google's sign-in page, finish signing in; then sync if it's on. */
  private async start(): Promise<void> {
    const back = await finishSignIn();
    if (back instanceof Error) {
      if (back instanceof HelperError && back.kind === 'unreachable') this.fallBack();
      this.render(back.message);
    }
    if (this.helperDown && syncState().on && navigator.onLine) prepareSignIn().catch(() => {});
    if (syncState().on) await this.syncNow();
  }

  /** The helper is unreachable: get Google's one-hour sign-in ready for the next tap. */
  private fallBack(): void {
    this.helperDown = true;
    if (navigator.onLine) prepareSignIn().catch(() => {});
  }

  /** Something changed here (saved, deleted, restored, a track shown or hidden): sync soon. */
  changed(): void {
    if (!GOOGLE_CLIENT_ID || !syncState().on) return;
    setSyncState({ ...syncState(), changedAt: Date.now() });
    this.schedule();
  }

  /** Sync soon (also on coming back to the app or online). */
  schedule(delay = AFTER_CHANGE_MS): void {
    if (!GOOGLE_CLIENT_ID || !syncState().on) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.syncNow(), delay);
  }

  /** Signs in (from a tap) and syncs: through Google's page and the helper, or for an hour. */
  private async connect(): Promise<void> {
    if (!navigator.onLine) return this.render("You're offline: connect to sign in.");
    if (!this.helperDown) {
      this.render('Opening Google sign-in…');
      if (await helperReachable()) return startSignIn();
      this.fallBack();
      return this.render("Couldn't reach the sign-in helper. Tap Sign in again to sign in for an hour.");
    }
    try {
      await prepareSignIn();
      await signIn();
      await this.syncNow();
    } catch (err) {
      this.render(err instanceof Error ? err.message : String(err));
    }
  }

  /** One sync; a sync asked for while one runs follows it. */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (!syncState().on) return this.render();
    if (!navigator.onLine) return this.render("Offline: syncs when you're back online.");
    const got = await freshToken();
    if ('problem' in got) {
      if (got.problem === 'signed-out') return this.render('Sign in again to keep syncing.');
      this.fallBack();
      return this.render("Couldn't reach the sign-in helper. Sign in to sync for an hour, or wait for it to come back.");
    }
    const token = got.token;
    this.render('Syncing…');
    try {
      // Nothing changed here and the file is as this device left it: nothing to download or send.
      const start = syncState();
      const localChange = start.changedAt;
      const dirty = localChange !== undefined && localChange !== start.syncedAt;
      const file = await readSyncFile(token, dirty ? null : start.version ?? null);
      if (file.unchanged) {
        // The pictures too, unless every one was already in place when the file had this version.
        if (this.photosOn && syncState().picturesAt !== start.version && (await this.syncPictures(token))) setSyncState({ ...syncState(), picturesAt: start.version });
        setSyncState({ ...syncState(), lastSync: Date.now() });
        return this.render();
      }
      const photosOn = this.photosOn;
      const plan = planSync({ saved: await listSaved(), tracks: await listTracks(), deleted: deletions(), photos: photosOn ? await listPhotos() : null }, file.data);
      // In one transaction; something edited or deleted here while this sync ran wins over what it brings in.
      const kept = await applyPlan(plan, deletions());
      // Deletions made here meanwhile are kept: merge, don't overwrite.
      const gone = deletions();
      for (const [id, at] of Object.entries(plan.deleted)) gone[id] = Math.max(at, gone[id] ?? 0);
      setDeletions(gone);
      let { id, version } = file;
      if (plan.upload) ({ id, version } = await writeSyncFile(token, id, plan.upload));
      for (const extra of file.extra) await deleteSyncFile(token, extra).catch(() => {});
      if (plan.putPhotos.length > kept.photos || plan.removePhotos.length) await this.photos?.reload();
      const pictures = photosOn && (await this.syncPictures(token));
      // A change here during the sync, or one not sent (kept over what came in): sync again.
      const skipped = kept.saved + kept.tracks + kept.photos > 0;
      setSyncState({ ...syncState(), lastSync: Date.now(), fileId: id ?? undefined, version: version ?? undefined, syncedAt: skipped ? undefined : localChange, picturesAt: pictures ? version ?? undefined : undefined });
      if (skipped || syncState().changedAt !== localChange) this.schedule();
      if (plan.putSaved.length > kept.saved || plan.putTracks.length > kept.tracks || plan.removeSaved.length || plan.removeTracks.length) await this.reload();
      this.retried = false;
      this.render();
    } catch (err) {
      if (err instanceof DriveError && err.status === 401) {
        // The token was refused before its time: with the sealed key, get a new one (once).
        setSyncState({ ...syncState(), token: undefined, expires: undefined });
        if (syncState().sealed && !this.retried) {
          this.retried = true;
          return this.schedule(0);
        }
        // Refused again: signing in afresh is the way out.
        setSyncState({ ...syncState(), sealed: undefined });
        this.retried = false;
        return this.render('Sign in again to keep syncing.');
      }
      // A request that never got an answer (no connection, or one that only looks connected): try
      // again when the connection comes back or the app is opened again.
      if (err instanceof TypeError) return this.render("Offline: syncs when you're back online.");
      this.render(`Couldn't sync: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The pictures of synced photos: those only here go up, those only in Drive come down (their
   *  thumbnails made here), and those of deleted photos are removed from Drive. True when every
   *  photo's picture is here afterwards (nothing to do again until the sync file changes). */
  private async syncPictures(token: string): Promise<boolean> {
    const remote = await listPhotoFiles(token);
    const list = await listPhotos();
    const ids = new Set(list.map((p) => p.id));
    const gone = deletions();
    for (const [id, fileId] of remote) {
      if (!ids.has(id) && gone[id] !== undefined) {
        await deletePhotoFile(token, fileId).catch(() => {});
        remote.delete(id);
      }
    }
    const here = await filesHere();
    const up = list.filter((p) => here.has(p.id) && !remote.has(p.id));
    for (const [i, p] of up.entries()) {
      this.render(`Uploading photos · ${i + 1} of ${up.length}`);
      const f = await getFiles(p.id);
      if (f) await uploadPhotoFile(token, p.id, f.full);
    }
    const down = list.filter((p) => !here.has(p.id) && remote.has(p.id));
    // A photo whose picture is neither here nor in Drive yet (still on its way up from another
    // device): look again next time.
    let complete = list.every((p) => here.has(p.id) || remote.has(p.id));
    for (const [i, p] of down.entries()) {
      this.render(`Downloading photos · ${i + 1} of ${down.length}`);
      const full = await downloadPhotoFile(token, remote.get(p.id)!);
      const thumb = await preview(full, THUMB);
      if (!thumb) {
        complete = false; // not a picture this browser can open: try again next time
        continue;
      }
      await putFiles({ id: p.id, full, thumb });
      this.photos?.arrived(p.id);
    }
    return complete;
  }

  /** The "Sync photos too" switch: turning it on asks first when there's something to upload. */
  private async togglePhotos(): Promise<void> {
    if (this.photosOn) {
      this.photosOn = false;
      writeSetting('syncPhotos', false);
      return this.render();
    }
    const list = await listPhotos().catch(() => []);
    if (list.length) {
      const bytes = list.reduce((n, p) => n + p.bytes, 0);
      $('sync-photos-ask-title').textContent = `Upload ${list.length === 1 ? 'the photo' : `${list.length} photos`} to Drive?`;
      $('sync-photos-ask-text').textContent = `About ${mb(bytes)}. On mobile data that comes out of your plan; you can also wait for Wi-Fi and turn this on then.`;
      $('photo-scrim').hidden = false;
      $('sync-photos-ask').hidden = false;
      $('sync-photos-go').focus();
      const ok = await new Promise<boolean>((resolve) => {
        const done = (v: boolean) => {
          $('photo-scrim').hidden = true;
          $('sync-photos-ask').hidden = true;
          $('sync-photos').focus();
          resolve(v);
        };
        $('sync-photos-go').onclick = () => done(true);
        $('sync-photos-later').onclick = () => done(false);
        $('sync-photos-ask').onkeydown = (e) => e.key === 'Escape' && done(false);
      });
      if (!ok) return;
    }
    this.photosOn = true;
    writeSetting('syncPhotos', true);
    this.render();
    this.changed();
    this.schedule(0);
  }

  /** The photos changed (count, size): the switch's text says so. */
  photosChanged(): void {
    this.render();
  }

  private render(message?: string): void {
    const s = syncState();
    // Signed in: a token now, or the sealed key while the helper answers.
    const ready = s.on && (!!validToken(s) || (signedIn(s) && !this.helperDown));
    $('sync-connect').hidden = ready;
    $('sync-connect').textContent = s.on ? 'Sign in to Google' : 'Sync with Google Drive';
    $('sync-now').hidden = !ready;
    $('sync-stop').hidden = !s.on;
    $('sync-photos-box').hidden = !s.on;
    $('sync-photos').setAttribute('aria-checked', String(this.photosOn));
    void listPhotos().then((list) => {
      const bytes = list.reduce((n, p) => n + p.bytes, 0);
      const count = `${list.length === 1 ? '1 photo' : `${list.length} photos`} · ${mb(bytes)}`;
      $('sync-photos-text').textContent = this.photosOn
        ? `The app's copies go up (2048 px, with the time, place, camera details and descriptions kept), not your originals. ${count}. Turning this off stops new uploads; the photos already in Drive stay there, and on your other devices.`
        : `Photos stay on this device${list.length ? ` (${count})` : ''}. Turn this on to have them on your other devices too.`;
    }).catch(() => {});
    // A short state under the menu item.
    $('sync-menu-status').textContent = !s.on ? '' : message === 'Syncing…' ? 'Syncing…' : /^(Uploading|Downloading) photos/.test(message ?? '') ? 'Syncing photos…' : !ready ? 'Sign-in needed' : message?.startsWith('Offline') ? 'Offline' : message ? 'Not synced' : s.lastSync ? `Synced ${timeText(s.lastSync)}` : '';
    $('sync-text').textContent = message
      ?? (!s.on
        ? 'Keep your saved places and routes and your GPX tracks the same on all your devices, through your Google Drive (in a hidden folder only this app can see).'
        : (s.lastSync ? `Synced with Google Drive at ${timeText(s.lastSync)}.` : 'Syncing with Google Drive.') + (s.sealed ? ' You stay signed in on this device.' : ''));
  }
}
