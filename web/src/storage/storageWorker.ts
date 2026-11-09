/// <reference lib="webworker" />
import { HGT_SIZE_ERROR, hgtStep, onePerSquare, parseHgtName } from '../dem/hgt';
import { encodeOverview, OverviewBuilder } from '../dem/overview';
import { ImgError } from '../img/bytes';
import { BlobSource } from '../img/source';
import { storageRoot } from '../channel';
import { GarminMap } from '../map/garminMap';
import { currentDirName, DIR_PREFIX, isCompleteDir, isDataDir, isMissing, listEntries, opfsAdapter, parsePointer, POINTER, type StoredMeta } from './layout';
import { firstEntry } from './unzipStream';

declare const self: DedicatedWorkerGlobalScope;

const CHUNK = 8 * 1024 * 1024;
/** Free space required before copying, as a multiple of the bytes to be written. */
const SPACE_MARGIN = 1.1;

const progress = (message: string) => self.postMessage({ type: 'progress', message });
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

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

/** Overwrites a small file with one write and then trims it, so it is never observed empty (the
 *  commit pointer must not be left blank by an interruption between truncate and write). */
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
      `Not enough storage space on this device: the import needs about ${mb(needed * SPACE_MARGIN)} but only ${mb(Math.max(0, free))} is available. ` +
        'Nothing was changed. If a map is already stored, you can remove it with “Remove stored map” and then import again.',
    );
  }
}

async function removeDir(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  await root.removeEntry(name, { recursive: true }).catch((err) => {
    if (!isMissing(err)) console.warn('could not remove', name, err);
  });
}

async function doImport(img: File, hgt: File[]): Promise<void> {
  progress('Checking map file…');
  await GarminMap.open(new BlobSource(img)); // throws a tile-named ImgError for locked/corrupt maps
  // One file per 1° square (the HD one where both the normal and HD hillshade were picked), sorted
  // by name so tiles are added to the overview in the same order as the Python pipeline.
  const parsed = onePerSquare(
    hgt.map((f) => {
      const p = parseHgtName(f.name);
      if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
      const step = hgtStep(f.size);
      if (!step) throw new ImgError(`${f.name}: ${HGT_SIZE_ERROR} (${f.size} bytes)`);
      return { file: f, name: f.name.toLowerCase(), ...p, step };
    }),
  );
  // Built before copying anything so an oversized elevation extent fails up front.
  const builder = parsed.length ? new OverviewBuilder(parsed) : null;

  await checkSpace(img.size + parsed.reduce((n, p) => n + p.file.size, 0));

  await storeMap(async (dir) => {
    await writeBytes(dir, 'map.img', async (h) => {
      for (let off = 0; off < img.size; off += CHUNK) {
        await h.write(new Uint8Array(await img.slice(off, off + CHUNK).arrayBuffer()), { at: off });
        progress(`Copying map ${Math.min(100, Math.round(((off + CHUNK) / img.size) * 100))}%`);
      }
    });

    if (builder) {
      const demDir = await dir.getDirectoryHandle('dem', { create: true });
      for (const [i, p] of parsed.entries()) {
        const bytes = new Uint8Array(await p.file.arrayBuffer());
        await writeBytes(demDir, p.name, async (h) => void (await h.write(bytes, { at: 0 })));
        builder.add(p.south, p.west, bytes, p.step);
        progress(`Copying elevation ${i + 1}/${parsed.length}`);
      }
      const ov = encodeOverview(builder.finish());
      await writeBytes(dir, 'dem-overview.bin', async (h) => void (await h.write(ov, { at: 0 })));
    }

    return {
      version: 1, imgName: img.name, imgSize: img.size, imgLastModified: img.lastModified,
      hgtNames: parsed.map((p) => p.name).sort(), hasOverview: parsed.length > 0,
    };
  });
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
    await GarminMap.open(new BlobSource(await (await dir.getFileHandle('map.img')).getFile()));
    return { version: 1, imgName, imgSize: entry.size, imgLastModified: lastModified, hgtNames: [], hasOverview: false };
  });
}

/** Writes a new map into a fresh directory (`fill` writes its files and returns its meta) and makes
 *  it the stored map. The stored map is untouched until the commit pointer flips, and a failure
 *  removes the new directory; once committed, every other map directory is dropped. */
async function storeMap(fill: (dir: FileSystemDirectoryHandle) => Promise<StoredMeta>): Promise<void> {
  const root = await storageRoot();
  let name = `${DIR_PREFIX}${Date.now()}`;
  const existing = new Set((await listEntries(root)).map((e) => e.name));
  for (let i = 1; existing.has(name); i++) name = `${DIR_PREFIX}${Date.now()}-${i}`;

  const dir = await root.getDirectoryHandle(name, { create: true });
  try {
    const meta = await fill(dir);
    const text = new TextEncoder().encode(JSON.stringify(meta));
    await writeBytes(dir, 'meta.json', async (h) => void (await h.write(text, { at: 0 })));

    // The commit: from here on the new directory is the stored map.
    await writeSmall(root, POINTER, new TextEncoder().encode(JSON.stringify({ dir: name })));
  } catch (err) {
    progress('Import failed; keeping the stored map.');
    if (await safeToDiscard(root, name)) await removeDir(root, name);
    throw err;
  }

  // Best effort: drop every other map directory (older imports, the legacy `garmin/`, partial
  // leftovers of an interrupted import), but only once storage demonstrably resolves to the new
  // map. A failure here only wastes space until the next import.
  progress('Cleaning up…');
  if ((await currentDirName(root).catch(() => null)) !== name) return;
  for (const e of await listEntries(root).catch(() => [])) {
    if (e.kind === 'directory' && e.name !== name && isDataDir(e.name)) await removeDir(root, e.name);
  }
}

/** A failed import's directory may be removed only if it isn't (possibly) the stored map: not
 *  named by the pointer (its bytes may have landed before the error) and not the only complete
 *  map directory there is. Any doubt keeps it. */
async function safeToDiscard(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    const io = opfsAdapter(root);
    if (parsePointer(await io.pointerText()) === name) return false;
    if (!(await isCompleteDir(root, name))) return true;
    for (const d of await io.dirs()) if (d !== name && isDataDir(d) && (await isCompleteDir(root, d))) return true;
    return false;
  } catch {
    return false;
  }
}

async function doWriteText(dirName: string, name: string, text: string): Promise<void> {
  // No `create`: if the map directory vanished meanwhile, fail rather than resurrect it.
  const dir = await (await storageRoot()).getDirectoryHandle(dirName);
  await writeBytes(dir, name, async (h) => void (await h.write(new TextEncoder().encode(text), { at: 0 })));
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'import') await doImport(msg.img as File, msg.hgt as File[]);
    else if (msg.type === 'download') await doDownload(msg.url as string, msg.imgName as string);
    else if (msg.type === 'writeText') await doWriteText(msg.dir as string, msg.name as string, msg.text as string);
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
