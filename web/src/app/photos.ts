import type * as maplibregl from 'maplibre-gl';
import { cameraOf, hasLocation, inspect, makeCopy, preview, type Inspected } from '../photos/copy';
import { exifOf, readSegments, withSegments, xmpOf, xmpSegment, isJpeg } from '../photos/jpeg';
import { dayText, deletePhoto, getFiles, listPhotos, putFiles, putPhoto, shareName, takenText, type Photo, type PhotoFiles } from '../photos/photo';
import { withDescription } from '../photos/xmp';
import { deletions, noteDeleted, setDeletions } from '../saved/deleted';
import { newId } from '../saved/saved';
import { acceptDrops, extensions } from '../ui/drop';
import { readSetting, writeSetting } from '../ui/settings';
import { diag } from './diagnostics';
import { PhotoLayer } from './photoLayer';
import { PhotoViewer } from './photoViewer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** How long Undo is offered after adding or deleting (ms). */
const UNDO_MS = 8000;
/** Photos without a location shown in the "no location" step; more are counted. */
const CHECK_SHOWN = 6;

export const mb = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} kB` : `${Math.round(bytes / 1e6)} MB`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a photo goes on the map. */
export interface Spot {
  lon: number;
  lat: number;
  alt: number | null;
}

/** Taken in the last 3 minutes: by its own clock (EXIF keeps local time, which JavaScript reads
 *  as local), or, with no time in it, by the file's age. The iPhone's camera through Safari gives
 *  a file seconds old with neither a time nor a location in it ("image.jpg"); a photo from the
 *  library always has its time. */
function takenJustNow(x: Inspected, now = Date.now()): boolean {
  const taken = x.info?.taken;
  const t = taken ? new Date(taken).getTime() : x.file.lastModified;
  return Number.isFinite(t) && Math.abs(now - t) < 3 * 60_000;
}

/** A photo's own clock time ("2026-10-28T15:55:30"), as EXIF keeps it: local, no time zone. */
const localTime = (t: number) => {
  const d = new Date(t);
  return new Date(t - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
};

export interface PhotosDeps {
  map: maplibregl.Map;
  /** "Near Landmannalaugar" for a spot. */
  near: (lon: number, lat: number) => string | null;
  /** Plans a route to a photo's spot. */
  routeTo: (p: Photo) => void;
  /** Called after a change here (added, described, deleted), for syncing. */
  changed: () => void;
  /** Where you are, when location is on and has a recent fix (offered for photos without one). */
  here: () => Spot | null;
}

/**
 * Photos on the map (⋯ → Photos): photos added from the phone are kept as copies (at most 2048 px,
 * with all their metadata) and shown as thumbnails where they were taken; a tap opens them.
 * Photos without a location are shown first and left out. Deleting and adding offer Undo.
 */
export class Photos {
  private photos: Photo[] = [];
  private readonly thumbs = new Map<string, string>();
  private readonly layer: PhotoLayer;
  readonly viewer: PhotoViewer;
  private noteTimer = 0;
  private undo: (() => Promise<void>) | null = null;
  private busy = false;
  /** The file Share hands over, made when a photo is shown: iOS only shares in the tap itself. */
  private shared: { key: string; file: Promise<File> } | null = null;
  /** Called with the photos whenever they change (the sync panel counts them). */
  onList: ((photos: Photo[]) => void) | null = null;

  private opened = 0;

  constructor(private readonly deps: PhotosDeps) {
    this.layer = new PhotoLayer(deps.map, (id) => this.thumb(id), (list) => this.viewer.show(list));
    this.viewer = new PhotoViewer({
      picture: async (id) => {
        const f = await getFiles(id).catch(() => null);
        return f ? URL.createObjectURL(f.full) : null;
      },
      thumb: (id) => this.thumb(id),
      near: deps.near,
      route: (p) => deps.routeTo(p),
      share: (p) => this.share(p),
      prepare: (p) => void this.shareFile(p).catch(() => {}),
      remove: (p) => void this.remove(p),
      describe: (p, text) => this.describe(p, text),
    });
    const shown = readSetting('showPhotos', true);
    $('photos-show').setAttribute('aria-checked', String(shown));
    this.layer.show(shown);
    $('photos-show').onclick = () => {
      const on = $('photos-show').getAttribute('aria-checked') !== 'true';
      $('photos-show').setAttribute('aria-checked', String(on));
      writeSetting('showPhotos', on);
      this.layer.show(on);
    };
    $('photos-close').onclick = () => this.show(false);
    $('photos-add').onclick = () => this.pick();
    $<HTMLInputElement>('photo-files').onchange = () => {
      const input = $<HTMLInputElement>('photo-files');
      const files = [...(input.files ?? [])];
      input.value = '';
      // What the picker handed over and how long it took, for when it's slow (Diagnostics).
      if (files.length) diag(pickedText(files, this.opened ? Date.now() - this.opened : null));
      if (files.length) void this.add(files);
    };
    acceptDrops($('photos'), (files) => void this.add(files), extensions('jpg', 'jpeg', 'heic', 'heif'));
    $('photo-note-undo').onclick = () => {
      const u = this.undo;
      this.hideNote();
      if (u) void u().catch((err) => this.note(`Couldn't undo: ${err instanceof Error ? err.message : String(err)}`));
    };
    void this.reload();
  }

  get all(): Photo[] {
    return this.photos;
  }

  /** Reads the photos again (after a sync brought some in or took some away). */
  async reload(): Promise<void> {
    this.photos = await listPhotos().catch(() => []);
    // A photo whose thumbnail is now here (a synced one that arrived) gets it on the next draw.
    this.changedList();
  }

  /** A synced photo's picture arrived: draw its thumbnail. */
  arrived(id: string): void {
    const url = this.thumbs.get(id);
    if (url) URL.revokeObjectURL(url);
    this.thumbs.delete(id);
    this.changedList();
  }

  show(open: boolean): void {
    $('photos').hidden = !open;
    if (open) this.render();
  }

  private changedList(): void {
    this.layer.set(this.photos);
    if (!$('photos').hidden) this.render();
    this.onList?.(this.photos);
  }

  /** The thumbnail's object URL (made once per photo). */
  private async thumb(id: string): Promise<string | null> {
    const have = this.thumbs.get(id);
    if (have) return have;
    const f = await getFiles(id).catch(() => null);
    if (!f) return null;
    const url = this.thumbs.get(id) ?? URL.createObjectURL(f.thumb);
    this.thumbs.set(id, url);
    return url;
  }

  /** The panel: photos by day, newest day first, each day's oldest first. */
  private render(): void {
    $('photos-empty').hidden = this.photos.length > 0;
    const days = new Map<string, Photo[]>();
    for (const p of this.photos) {
      const d = dayText(p.taken) ?? 'Time not known';
      days.set(d, [...(days.get(d) ?? []), p]);
    }
    const order = [...days.entries()].sort(([, a], [, b]) => (b[0].taken ?? '').localeCompare(a[0].taken ?? ''));
    $('photo-days').replaceChildren(
      ...order.map(([day, list]) => {
        const box = document.createElement('div');
        box.className = 'photo-day';
        const h = document.createElement('h3');
        h.textContent = day;
        const places = [...new Set(list.map((p) => this.deps.near(p.lon, p.lat)?.replace(/^Near /, '')).filter(Boolean))];
        if (places.length) {
          const where = document.createElement('span');
          where.textContent = places.slice(0, 2).join(', ');
          h.append(where);
        }
        const grid = document.createElement('div');
        grid.className = 'photo-grid';
        for (const [i, p] of list.entries()) {
          const b = document.createElement('button');
          b.type = 'button';
          b.setAttribute('aria-label', [`Photo, ${takenText(p.taken)}`, p.description].filter(Boolean).join('. '));
          void this.thumb(p.id).then((u) => u && (b.style.backgroundImage = `url("${u}")`));
          // Opens it, with the map moved to where it was taken.
          b.onclick = () => {
            this.show(false);
            this.deps.map.jumpTo({ center: [p.lon, p.lat], zoom: Math.max(this.deps.map.getZoom(), 13) });
            this.viewer.show(list, i);
          };
          grid.append(b);
        }
        box.append(h, grid);
        return box;
      }),
    );
    const bytes = this.photos.reduce((n, p) => n + p.bytes, 0);
    $('photos-foot').textContent = this.photos.length ? `${plural(this.photos.length, 'photo')} · ${mb(bytes)} on this device. A tap on a photo opens it, with the map moved to where it was taken.` : '';
  }

  // Notes at the bottom: progress, results, Undo.
  private note(text: string, opts: { count?: string; progress?: number; sub?: string; undo?: () => Promise<void>; stay?: boolean } = {}): void {
    clearTimeout(this.noteTimer);
    $('photo-note').hidden = false;
    $('photo-note-text').textContent = text;
    $('photo-note-count').textContent = opts.count ?? '';
    $('photo-note-bar').hidden = opts.progress === undefined;
    if (opts.progress !== undefined) {
      const bar = $('photo-note-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', text);
      bar.setAttribute('aria-valuenow', String(Math.round(opts.progress * 100)));
      (bar.firstElementChild as HTMLElement).style.width = `${Math.round(opts.progress * 100)}%`;
    }
    $('photo-note-sub').hidden = !opts.sub;
    $('photo-note-sub').textContent = opts.sub ?? '';
    this.undo = opts.undo ?? null;
    $('photo-note-undo').hidden = !opts.undo;
    if (!opts.stay) this.noteTimer = window.setTimeout(() => this.hideNote(), UNDO_MS);
  }

  private hideNote(): void {
    clearTimeout(this.noteTimer);
    $('photo-note').hidden = true;
    this.undo = null;
  }

  /** The photo picker (Add photos, and the map's photo button); the iPhone offers Take Photo too. */
  pick(): void {
    if (this.busy) return;
    this.opened = Date.now();
    $<HTMLInputElement>('photo-files').click();
  }

  /** Adding photos: read what each says, show the ones with no location (left out, or put where
   *  you are if you choose), then copy the rest in, showing them on the map as they come. */
  async add(files: File[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    $<HTMLButtonElement>('photos-add').disabled = true;
    try {
      this.show(false);
      const read: Inspected[] = [];
      for (const [i, f] of files.entries()) {
        this.note('Reading photos', { count: `${i + 1} of ${files.length}`, progress: i / files.length, stay: true });
        read.push(await inspect(f).catch(() => ({ file: f, info: null, segments: [], description: null })));
      }
      this.hideNote();
      const spots = new Map<Inspected, Spot>();
      for (const x of read) {
        if (hasLocation(x)) spots.set(x, { lon: x.info!.lon!, lat: x.info!.lat!, alt: x.info!.alt });
      }
      // A photo just taken (the picker's Take Photo) with no location of its own goes where you
      // are without asking: you took it here.
      const now = this.deps.here();
      // What each photo says about itself, for when one isn't placed as expected (Diagnostics).
      const ago = (t: number) => `${Math.round((Date.now() - t) / 1000)} s ago`;
      for (const x of read.slice(0, 10)) {
        const t = x.info?.taken ? new Date(x.info.taken).getTime() : NaN;
        diag(`Photo ${x.file.name}: ${x.info ? 'EXIF' : 'no EXIF'}, taken ${x.info?.taken ? `${x.info.taken} (${Number.isFinite(t) ? ago(t) : '?'})` : 'unknown'}, ${hasLocation(x) ? 'has a location' : 'no location'}, file ${ago(x.file.lastModified)}; your position ${now ? 'known' : 'unknown'}`);
      }
      const justTaken = now ? read.filter((x) => !spots.has(x) && takenJustNow(x)) : [];
      for (const x of justTaken) spots.set(x, now!);
      if (justTaken.length) diag(`Photos: ${justTaken.length} just taken without a location, put where you are`);
      // Already here: the same original (name, time and place).
      const key = (name: string, taken: string | null, lat: number, lon: number) => `${name}|${taken}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
      const have = new Set(this.photos.map((p) => key(p.name, p.taken, p.lat, p.lon)));
      const isNew = (x: Inspected) => !have.has(key(x.file.name, x.info?.taken ?? null, spots.get(x)!.lat, spots.get(x)!.lon));
      const missing = read.filter((x) => !spots.has(x));
      if (missing.length) {
        const here = this.deps.here();
        const choice = await this.check(missing, read.filter((x) => spots.has(x) && isNew(x)).length, here !== null);
        if (choice === 'cancel') return;
        if (choice === 'again') {
          $<HTMLInputElement>('photo-files').click();
          return;
        }
        // Where you are now: the position when the step was shown (you may walk on while deciding).
        if (choice === 'here' && here) for (const x of missing) spots.set(x, here);
      }
      const placed = read.filter((x) => spots.has(x));
      const fresh = placed.filter(isNew);
      const already = placed.length - fresh.length;
      if (!fresh.length) {
        if (already) this.note(`${already === 1 ? 'That photo is' : `All ${already} are`} already on the map`);
        return;
      }
      this.fit(fresh.map((x) => spots.get(x)!));
      const added: Photo[] = [];
      let putHere = 0;
      const failed: string[] = [];
      for (const [i, x] of fresh.entries()) {
        this.note('Adding photos', { count: `${i + 1} of ${fresh.length}`, progress: i / fresh.length, sub: i === 0 ? "You can keep using the map. They show on it as they're added." : undefined, stay: true });
        try {
          const copy = await makeCopy(x);
          const p: Photo = {
            id: newId(),
            added: Date.now(),
            ...spots.get(x)!,
            // A photo just taken without a time in it: when its file was made.
            taken: x.info?.taken ?? (justTaken.includes(x) ? localTime(x.file.lastModified) : null),
            camera: cameraOf(x),
            width: copy.width,
            height: copy.height,
            bytes: copy.full.size,
            name: x.file.name,
            ...(x.description ? { description: x.description } : {}),
          };
          await putFiles({ id: p.id, full: copy.full, thumb: copy.thumb });
          await putPhoto(p);
          added.push(p);
          if (justTaken.includes(x)) putHere++;
          this.photos = [...this.photos, p];
          this.changedList();
        } catch (err) {
          console.warn('adding a photo', err);
          failed.push(x.file.name);
        }
      }
      if (added.length) this.deps.changed();
      const extra = [already ? `${already} ${already === 1 ? 'was' : 'were'} already here` : null, failed.length ? `${failed.length} couldn't be opened` : null].filter(Boolean).join(' · ');
      const extraHere = putHere ? `${putHere === 1 && added.length === 1 ? 'Just taken' : `${putHere} just taken`}, so put where you are` : null;
      if (!added.length) return this.note(`Couldn't add ${failed.length === 1 ? 'the photo' : 'the photos'}`, { sub: `${failed.length === 1 ? "It couldn't" : "They couldn't"} be opened in this browser.` });
      this.note(`Added ${plural(added.length, 'photo')}`, {
        sub: [extraHere, extra].filter(Boolean).join(' · ') || undefined,
        undo: async () => {
          for (const p of added) {
            await deletePhoto(p.id);
            noteDeleted(p.id);
          }
          const gone = new Set(added.map((p) => p.id));
          this.photos = this.photos.filter((p) => !gone.has(p.id));
          this.changedList();
          this.deps.changed();
        },
      });
    } catch (err) {
      this.note(`Couldn't add photos: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
      $<HTMLButtonElement>('photos-add').disabled = false;
    }
  }

  /** Moves the map to show where the photos being added were taken. */
  private fit(xs: Spot[]): void {
    const map = this.deps.map;
    const lons = xs.map((x) => x.lon);
    const lats = xs.map((x) => x.lat);
    const b: [[number, number], [number, number]] = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
    if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.easeTo({ center: b[0], zoom: Math.max(map.getZoom(), 13), duration: 600 });
    else map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 600 });
  }

  /** The "no location" step: those photos, and what happens to the others. */
  private check(missing: Inspected[], others: number, canPlace: boolean): Promise<'go' | 'cancel' | 'again' | 'here'> {
    const n = missing.length;
    const none = others === 0;
    $('photo-check-title').textContent = none ? (n === 1 ? "This photo doesn't have a location" : 'None of these photos have a location') : `${plural(n, 'photo')} ${n === 1 ? "doesn't" : "don't"} have a location`;
    $('photo-check-text').textContent = none
      ? `${n === 1 ? 'It' : 'They'} can't be added, because there's no place to show ${n === 1 ? 'it' : 'them'} on the map. Location may have been off for the Camera, or removed when ${n === 1 ? 'it was' : 'they were'} shared.`
      : `${n === 1 ? 'It' : 'They'} won't be added, because there's no place to show ${n === 1 ? 'it' : 'them'} on the map. The other ${others === 1 ? 'one' : others} will be.`;
    if (canPlace) $('photo-check-text').textContent += ` Or put ${n === 1 ? 'it' : 'them'} where you are now.`;
    $('photo-check-here-row').hidden = !canPlace;
    $('photo-check-here').textContent = n === 1 ? 'Put it where I am' : `Put ${n === 2 ? 'both' : `all ${n}`} where I am`;
    const go = $('photo-check-go');
    go.textContent = none ? 'Choose other photos' : others === 1 ? 'Add the other one' : `Add the other ${others}`;
    const shown = n > CHECK_SHOWN ? CHECK_SHOWN - 1 : n;
    const urls: string[] = [];
    const tiles = missing.slice(0, shown).map((x) => {
      const box = document.createElement('div');
      box.className = 'check-photo';
      const pic = document.createElement('div');
      const when = x.info?.taken ? takenText(x.info.taken, true) : new Date(x.file.lastModified).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');
      box.setAttribute('role', 'img');
      box.setAttribute('aria-label', `Photo from ${when}, no location`);
      const cap = document.createElement('span');
      cap.textContent = when;
      box.append(pic, cap);
      void preview(x.file).then((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b);
        urls.push(u);
        pic.style.backgroundImage = `url("${u}")`;
      });
      return box;
    });
    if (n > shown) {
      const more = document.createElement('div');
      more.className = 'check-more';
      more.textContent = `and ${n - shown} more`;
      tiles.push(more);
    }
    $('photo-check-grid').replaceChildren(...tiles);
    $('photo-scrim').hidden = false;
    $('photo-check').hidden = false;
    go.focus();
    return new Promise((resolve) => {
      const done = (r: 'go' | 'cancel' | 'again' | 'here') => {
        $('photo-scrim').hidden = true;
        $('photo-check').hidden = true;
        for (const u of urls) URL.revokeObjectURL(u);
        $('photo-check').onkeydown = null;
        resolve(r);
      };
      go.onclick = () => done(none ? 'again' : 'go');
      $('photo-check-cancel').onclick = () => done('cancel');
      $('photo-check-here').onclick = () => done('here');
      $('photo-check').onkeydown = (e) => e.key === 'Escape' && done('cancel');
    });
  }

  /** Deletes a photo at once, with Undo for a few seconds (the deletion reaches other devices
   *  unless undone). */
  async remove(p: Photo): Promise<void> {
    const files = await getFiles(p.id).catch(() => null);
    await deletePhoto(p.id);
    noteDeleted(p.id);
    this.photos = this.photos.filter((x) => x.id !== p.id);
    this.changedList();
    this.viewer.dropped(p.id);
    this.deps.changed();
    this.note('Photo deleted', {
      undo: async () => {
        // Back, changed after its deletion so the deletion doesn't win when syncing.
        const back: Photo = { ...p, updated: Date.now() };
        if (files) await putFiles(files as PhotoFiles);
        await putPhoto(back);
        const d = deletions();
        delete d[p.id];
        setDeletions(d);
        this.photos = [...this.photos, back];
        this.changedList();
        this.deps.changed();
      },
    });
  }

  private async describe(p: Photo, text: string): Promise<void> {
    const next: Photo = { ...p, updated: Date.now() };
    if (text) next.description = text;
    else delete next.description;
    await putPhoto(next);
    this.photos = this.photos.map((x) => (x.id === p.id ? next : x));
    this.viewer.update(next);
    this.changedList();
    this.deps.changed();
  }

  /** The copy to share, its description written into its XMP so it goes with the file. */
  private shareFile(p: Photo): Promise<File> {
    const key = `${p.id}|${p.updated ?? p.added}`;
    if (this.shared?.key === key) return this.shared.file;
    const file = (async () => {
      const f = await getFiles(p.id);
      if (!f) throw new Error('This photo is still on its way from Google Drive.');
      let blob: Blob = f.full;
      const bytes = new Uint8Array(await f.full.arrayBuffer());
      if (p.description && isJpeg(bytes)) {
        const segs = readSegments(bytes).filter((s) => (s.marker >= 0xe0 && s.marker <= 0xef) || s.marker === 0xfe);
        const xmp = withDescription(xmpOf(segs), p.description)!;
        const rest = segs.filter((s) => !(s.marker === 0xe1 && !exifOf([s]) && xmpOf([s]) !== null));
        blob = new Blob([withSegments(bytes, [...rest, xmpSegment(xmp)]) as BlobPart], { type: 'image/jpeg' });
      }
      return new File([blob], shareName(p), { type: 'image/jpeg' });
    })();
    this.shared = { key, file };
    file.catch(() => this.shared?.file === file && (this.shared = null));
    return file;
  }

  private async share(p: Photo): Promise<void> {
    const file = await this.shareFile(p);
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file] });
        return;
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** "Picker: 5 photos (3 HEIC, 2 JPEG, 11.2 MB) after 14.3 s": the time is from tapping Add
 *  photos, so it includes the picking itself. */
function pickedText(files: File[], ms: number | null): string {
  const kinds = new Map<string, number>();
  for (const f of files) {
    const k = (f.type.replace(/^image\//, '') || f.name.split('.').pop() || '?').toUpperCase();
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const what = [...kinds].map(([k, n]) => `${n} ${k}`).join(', ');
  return `Picker: ${files.length} photo${files.length === 1 ? '' : 's'} (${what}, ${(bytes / 1e6).toFixed(1)} MB)${ms == null ? '' : ` after ${(ms / 1000).toFixed(1)} s`}`;
}
