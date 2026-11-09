/// <reference lib="webworker" />
import { HGT_SIZE_ERROR, hgtStep, onePerSquare, parseHgtName } from '../dem/hgt';
import { encodeOverview, OverviewBuilder } from '../dem/overview';
import { ImgError } from '../img/bytes';
import { BlobSource } from '../img/source';
import { storageRoot } from '../channel';
import { GarminMap } from '../map/garminMap';
import { canonicalHgtName, defaultSetName, parseChoices, parseSetJson, type Choices, type SetJson } from './library';
import { CHOICES, currentDirName, DIR_PREFIX, isCompleteDir, isMapDir, isMissing, isSetDir, listEntries, parseMeta, POINTER, readTextFile as readText, SET_PREFIX, setDir, subdir, type StoredMeta } from './layout';
import { firstEntry } from './unzipStream';

declare const self: DedicatedWorkerGlobalScope;

const CHUNK = 8 * 1024 * 1024;
/** Free space required before copying, as a multiple of the bytes to be written. */
const SPACE_MARGIN = 1.1;

const progress = (message: string) => self.postMessage({ type: 'progress', message });
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
const encode = (o: unknown) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));

// The sync access handle's methods return promises on older Safari (pre-17) and plain values on
// newer engines; awaiting is harmless on the latter and required on the former.
async function writeBytes(dir: FileSystemDirectoryHandle, name: string, write: (h: FileSystemSyncAccessHandle) => Promise<void>): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    await handle.truncate(0);
    await write(handle);
    await handle.flush();
  } finally {
    await handle.close();
  }
}

const writeAll = (dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => writeBytes(dir, name, async (h) => void (await h.write(bytes, { at: 0 })));

/** Overwrites a small file with one write and then trims it, so it is never observed empty (a
 *  pointer or set.json must not be left blank by an interruption between truncate and write). */
async function writeSmall(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    await handle.write(bytes, { at: 0 });
    await handle.truncate(bytes.length);
    await handle.flush();
  } finally {
    await handle.close();
  }
}

async function checkSpace(needed: number): Promise<void> {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (!est || est.quota == null || est.usage == null) return; // unknown: let the copy try
  const free = est.quota - est.usage;
  if (free < needed * SPACE_MARGIN) {
    throw new ImgError(
      `Not enough storage space on this device: this needs about ${mb(needed * SPACE_MARGIN)} but only ${mb(Math.max(0, free))} is available. ` +
        'Nothing was changed. You can remove maps or elevation files you no longer need in ⋯ → Maps.',
    );
  }
}

async function removeEntry(dir: FileSystemDirectoryHandle, name: string, recursive = false): Promise<void> {
  await dir.removeEntry(name, { recursive }).catch((err) => {
    if (!isMissing(err)) console.warn('could not remove', name, err);
  });
}

/** A fresh `<prefix><ts>` name not yet in the root. */
async function freshName(root: FileSystemDirectoryHandle, prefix: string): Promise<string> {
  const existing = new Set((await listEntries(root)).map((e) => e.name));
  let name = `${prefix}${Date.now()}`;
  for (let i = 1; existing.has(name); i++) name = `${prefix}${Date.now()}-${i}`;
  return name;
}

// ---- the user's choices (maps.json) ----

async function updateChoices(change: (c: Choices) => void): Promise<void> {
  const root = await storageRoot();
  const c = parseChoices(await readText(root, CHOICES));
  change(c);
  await writeSmall(root, CHOICES, encode(c));
}

// ---- elevation ----

interface Hgt {
  file: File;
  /** The SRTM name, lower case (n64w019.hgt). */
  name: string;
  south: number;
  west: number;
  step: number;
}

function parseHgtFiles(hgt: File[]): Hgt[] {
  return hgt.map((f) => {
    const name = canonicalHgtName(f.name.split('/').pop() ?? f.name).toLowerCase();
    const p = parseHgtName(name);
    if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
    const step = hgtStep(f.size);
    if (!step) throw new ImgError(`${f.name}: ${HGT_SIZE_ERROR} (${f.size} bytes)`);
    return { file: f, name, ...p, step };
  });
}

/** Writes elevation files into a set: a new one (`into` null) or an existing one, where a square it
 *  already has is replaced (the finer file wins; the new one on a tie). The set's overview is built
 *  again from all of its files. Nothing a map may be reading is overwritten: replaced squares and
 *  the overview get new names, `set.json` (written last) switches to them, and the files it no
 *  longer lists are removed the next time files are added. Returns the set's id. */
async function storeElevation(hgt: File[], into: string | null): Promise<string> {
  const root = await storageRoot();
  const added = parseHgtFiles(hgt);
  const id = into ?? (await freshName(root, SET_PREFIX));
  const dir = await setDir(root, id, true);
  const old = into ? parseSetJson(await readText(dir, 'set.json')) : null;
  if (into && !old) throw new ImgError('That elevation set is no longer stored.');
  if (old) {
    // What an earlier change left for the map that was reading it (shown afresh since).
    const keep = new Set([...old.files, old.overview, 'set.json']);
    for (const e of await listEntries(dir)) if (e.kind === 'file' && !keep.has(e.name)) await removeEntry(dir, e.name);
  }
  const oldFiles: Hgt[] = old ? parseHgtFiles(await Promise.all(old.files.map(async (n) => {
    const f = await (await dir.getFileHandle(n)).getFile();
    return new File([f], n);
  }))) : [];
  // Stored names: the old ones for kept squares, new names for written ones.
  const storedName = new Map<Hgt, string>(oldFiles.map((h) => [h, h.file.name]));
  const all = onePerSquare([...added, ...oldFiles]);
  if (!all.length) throw new ImgError('Pick the .hgt elevation files.');
  // Built before copying anything so an oversized elevation extent fails up front.
  const builder = new OverviewBuilder(all);
  const writing = all.filter((h) => !storedName.has(h));
  await checkSpace(writing.reduce((n, h) => n + h.file.size, 0));

  try {
    const taken = new Set(old?.files ?? []);
    const stamp = Date.now();
    for (const [i, h] of all.entries()) {
      const bytes = new Uint8Array(await h.file.arrayBuffer());
      if (!storedName.has(h)) {
        const name = taken.has(h.name) ? h.name.replace(/\.hgt$/, `.${stamp}.hgt`) : h.name;
        await writeAll(dir, name, bytes);
        storedName.set(h, name);
        progress(`Copying elevation ${writing.indexOf(h) + 1}/${writing.length}`);
      } else if (i % 4 === 0) progress('Reading elevation…');
      builder.add(h.south, h.west, bytes, h.step);
    }
    const overview = old ? `overview.${stamp}.bin` : 'overview.bin';
    await writeAll(dir, overview, encodeOverview(builder.finish()));
    const files = all.map((h) => storedName.get(h)!);
    const step = Math.max(...all.map((h) => h.step));
    // A set named after its file count is named after the new count.
    const name = old && old.name !== defaultSetName(old.step, old.files.length) ? old.name : defaultSetName(step, files.length);
    const json: SetJson & { version: 1 } = { version: 1, name, files, step, overview, bytes: all.reduce((n, h) => n + h.file.size, 0) };
    await writeSmall(dir, 'set.json', encode(json));
  } catch (err) {
    if (!into) await removeEntry(root, id, true);
    throw err;
  }
  return id;
}

// ---- maps ----

interface MapOptions {
  name?: string;
  /** The set to use: an id, null for none, undefined for automatic. */
  elevation?: string | null;
}

async function doImport(img: File, hgt: File[], opts: MapOptions): Promise<void> {
  progress('Checking map file…');
  const map = await GarminMap.open(new BlobSource(img)); // throws a tile-named ImgError for locked/corrupt maps
  await checkSpace(img.size + hgt.reduce((n, f) => n + f.size, 0));
  // Elevation first: a map whose new set failed is never added (nor a set whose map failed).
  const set = hgt.length ? await storeElevation(hgt, null) : undefined;
  try {
    await storeMap(async (dir) => {
      await writeBytes(dir, 'map.img', async (h) => {
        for (let off = 0; off < img.size; off += CHUNK) {
          await h.write(new Uint8Array(await img.slice(off, off + CHUNK).arrayBuffer()), { at: off });
          progress(`Copying map ${Math.min(100, Math.round(((off + CHUNK) / img.size) * 100))}%`);
        }
      });
      return { version: 1, imgName: img.name, imgSize: img.size, imgLastModified: img.lastModified, hgtNames: [], hasOverview: false, bounds: map.bounds };
    }, { ...opts, ...(set ? { elevation: set } : {}) });
  } catch (err) {
    if (set) await removeEntry(await storageRoot(), set, true);
    throw err;
  }
}

/** Downloads a zipped map (one .img in a zip) and stores it as `imgName`, unpacking it on the way:
 *  the phone never holds the whole file in memory. */
async function doDownload(url: string, imgName: string): Promise<void> {
  progress('Connecting…');
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ImgError('Could not reach the download. Check the internet connection and try again.');
  }
  if (!res.ok || !res.body) throw new ImgError(`The download is not available right now (error ${res.status}). Try again later.`);
  const lastModified = Date.parse(res.headers.get('Last-Modified') ?? '') || Date.now();
  let shown = -1;
  const onPacked = (n: number, of: number) => {
    const pct = Math.floor((n / of) * 100);
    if (pct !== shown) progress(`Downloading map ${(shown = pct)}% · ${mb(n)} of ${mb(of)}`);
  };
  // firstEntry cancels the download itself when the zip can't be read.
  const entry = await firstEntry(res.body, onPacked);
  try {
    if (!/\.img$/i.test(entry.name)) throw new ImgError(`The download holds ${entry.name}, not a map (.img).`);
    await checkSpace(entry.size);
  } catch (err) {
    void entry.stream.cancel().catch(() => {});
    throw err;
  }

  await storeMap(async (dir) => {
    let at = 0;
    try {
      await writeBytes(dir, 'map.img', async (h) => {
        const reader = entry.stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await h.write(value, { at });
          at += value.length;
        }
      });
    } catch (err) {
      if (err instanceof ImgError) throw err;
      throw new ImgError(`The download stopped at ${mb(at)} of ${mb(entry.size)}. Try again; nothing was changed. (${err instanceof Error ? err.message : String(err)})`);
    }
    if (at !== entry.size) throw new ImgError(`The download stopped at ${mb(at)} of ${mb(entry.size)}. Try again; nothing was changed.`);
    progress('Checking map file…');
    const map = await GarminMap.open(new BlobSource(await (await dir.getFileHandle('map.img')).getFile()));
    return { version: 1, imgName, imgSize: entry.size, imgLastModified: lastModified, hgtNames: [], hasOverview: false, bounds: map.bounds };
  }, {});
}

/** Writes a new map into a fresh directory (`fill` writes its files and returns its meta), records
 *  the choices made for it and makes it the current map. Other maps stay. A failure removes the
 *  new directory; afterwards unfinished leftovers of earlier imports are removed. */
async function storeMap(fill: (dir: FileSystemDirectoryHandle) => Promise<StoredMeta>, opts: MapOptions): Promise<void> {
  const root = await storageRoot();
  const name = await freshName(root, DIR_PREFIX);
  const dir = await root.getDirectoryHandle(name, { create: true });
  try {
    const meta = await fill(dir);
    await writeAll(dir, 'meta.json', encode(meta));
  } catch (err) {
    progress('Import failed; nothing was changed.');
    await removeEntry(root, name, true);
    throw err;
  }
  if (opts.name !== undefined || opts.elevation !== undefined) {
    await updateChoices((c) => {
      const m = (c.maps[name] ??= {});
      if (opts.name) m.name = opts.name;
      if (opts.elevation !== undefined) m.elevation = opts.elevation;
    });
  }
  // The new map is complete; showing it is a pointer away.
  await writeSmall(root, POINTER, encode({ dir: name }));
  progress('Cleaning up…');
  await removeLeftovers(root, name).catch((err) => console.warn('cleanup', err));
}

/** Removes directories an interrupted import left behind: a map directory with neither a finished
 *  map nor a finished set in it, and an unfinished set. `keep` is never touched. */
async function removeLeftovers(root: FileSystemDirectoryHandle, keep: string): Promise<void> {
  for (const e of await listEntries(root)) {
    if (e.kind !== 'directory' || e.name === keep) continue;
    if (isSetDir(e.name)) {
      if (!parseSetJson(await readText(await root.getDirectoryHandle(e.name), 'set.json'))) await removeEntry(root, e.name, true);
    } else if (isMapDir(e.name)) {
      if (await isCompleteDir(root, e.name)) continue;
      const dem = await subdir(await root.getDirectoryHandle(e.name), 'dem');
      if (dem && parseSetJson(await readText(dem, 'set.json'))) continue;
      await removeEntry(root, e.name, true);
    }
  }
}

/** Removes a map. If it's the current one, another map becomes current first (the newest), or the
 *  pointer goes when it was the last. A directory that also holds an elevation set (an older
 *  version's map) keeps the set. */
async function removeMap(id: string): Promise<void> {
  const root = await storageRoot();
  if ((await currentDirName(root)) === id) {
    const others = (await listEntries(root)).filter((e) => e.kind === 'directory' && e.name !== id && isMapDir(e.name)).map((e) => e.name);
    const complete: string[] = [];
    for (const o of others) if (await isCompleteDir(root, o)) complete.push(o);
    complete.sort();
    const next = complete.pop();
    if (next) await writeSmall(root, POINTER, encode({ dir: next }));
    else await removeEntry(root, POINTER);
  }
  const dir = await subdir(root, id);
  if (!dir) return;
  const dem = await subdir(dir, 'dem');
  if (dem && parseSetJson(await readText(dem, 'set.json'))) {
    for (const f of ['meta.json', 'map.img', 'places.json', 'dem-overview.bin']) await removeEntry(dir, f);
  } else await removeEntry(root, id, true);
  await updateChoices((c) => void delete c.maps[id]);
}

/** Removes an elevation set; maps that used it are drawn without hillshading. */
async function removeSet(id: string): Promise<void> {
  const root = await storageRoot();
  const [top, sub] = id.split('/');
  if (sub) {
    const parent = await subdir(root, top);
    if (parent) {
      await removeEntry(parent, sub, true);
      await removeEntry(parent, 'dem-overview.bin');
      if (!(await isCompleteDir(root, top))) await removeEntry(root, top, true);
    }
  } else await removeEntry(root, id, true);
  await updateChoices((c) => {
    delete c.sets[id];
    for (const m of Object.values(c.maps)) if (m.elevation === id) m.elevation = null;
  });
}

/** Older versions stored a map's elevation with it (`dem/`, `dem-overview.bin`, the names in
 *  meta.json). Each such map's elevation becomes a set where it is: its overview copied into
 *  `dem/overview.bin`, then `dem/set.json`. Nothing large is moved. */
async function migrate(): Promise<void> {
  const root = await storageRoot();
  for (const e of await listEntries(root)) {
    if (e.kind !== 'directory' || !isMapDir(e.name)) continue;
    const dir = await root.getDirectoryHandle(e.name);
    const dem = await subdir(dir, 'dem');
    if (!dem || parseSetJson(await readText(dem, 'set.json'))) continue;
    const meta = parseMeta(await readText(dir, 'meta.json'));
    // Elevation that can't be read gets a set.json listing no files, so it isn't tried again on
    // every start (and isn't offered); its files are left as they are.
    const unreadable = () => writeSmall(dem, 'set.json', encode({ version: 1, name: 'Unreadable elevation', files: [], step: 1200, overview: 'overview.bin' }));
    try {
      if (!meta?.hgtNames.length) throw new Error('no elevation files named');
      const files = await Promise.all(meta.hgtNames.map(async (n) => (await dem.getFileHandle(n)).getFile()));
      const steps = files.map((f) => hgtStep(f.size) ?? 0);
      if (steps.includes(0)) throw new Error('a file of the wrong size');
      const overview = meta.hasOverview ? await (await dir.getFileHandle('dem-overview.bin')).getFile() : null;
      if (overview) await writeAll(dem, 'overview.bin', new Uint8Array(await overview.arrayBuffer()));
      const step = Math.max(...steps);
      // The map keeps drawing its hillshading from these files, and learns its area (older
      // versions didn't keep it), so the files can be offered to other maps too.
      const bounds = await GarminMap.open(new BlobSource(await (await dir.getFileHandle('map.img')).getFile())).then((m) => m.bounds).catch(() => undefined);
      await updateChoices((c) => {
        const m = (c.maps[e.name] ??= {});
        if (m.elevation === undefined) m.elevation = `${e.name}/dem`;
        if (bounds && !m.bounds) m.bounds = bounds;
      });
      const bytes = files.reduce((n, f) => n + f.size, 0);
      await writeSmall(dem, 'set.json', encode({ version: 1, name: defaultSetName(step, files.length), files: meta.hgtNames, step, overview: 'overview.bin', bytes }));
    } catch (err) {
      console.warn('could not keep the elevation of', e.name, err);
      await unreadable().catch(() => {});
    }
  }
}

async function doWriteText(dirName: string | null, name: string, text: string): Promise<void> {
  const root = await storageRoot();
  if (dirName === null) return writeSmall(root, name, encode(text));
  // No `create`: if the map directory vanished meanwhile, fail rather than resurrect it.
  const dir = await root.getDirectoryHandle(dirName);
  await writeAll(dir, name, encode(text));
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    let result: unknown;
    if (msg.type === 'import') await doImport(msg.img as File, msg.hgt as File[], msg.opts as MapOptions);
    else if (msg.type === 'download') await doDownload(msg.url as string, msg.imgName as string);
    else if (msg.type === 'elevation') result = await storeElevation(msg.hgt as File[], msg.into as string | null);
    else if (msg.type === 'inspect') {
      const map = await GarminMap.open(new BlobSource(msg.img as File));
      result = { bounds: map.bounds, description: map.description };
    } else if (msg.type === 'removeMap') await removeMap(msg.id as string);
    else if (msg.type === 'removeSet') await removeSet(msg.id as string);
    else if (msg.type === 'setCurrent') await writeSmall(await storageRoot(), POINTER, encode({ dir: msg.id as string }));
    else if (msg.type === 'migrate') await migrate();
    else if (msg.type === 'writeText') await doWriteText(msg.dir as string | null, msg.name as string, msg.text as string);
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
