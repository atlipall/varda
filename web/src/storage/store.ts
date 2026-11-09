import { storageRoot } from '../channel';
import { parseHgtName } from '../dem/hgt';
import { canonicalHgtName, mapName, parseChoices, parseSetJson, type Bounds, type Choices, type MapInfo, type SetInfo } from './library';
import { CHOICES, currentDirName, dirTime, hasDataDirs, isDataDir, isMapDir, isMissing, isSetDir, listEntries, parseMeta, POINTER, readTextFile, setDir, subdir, type StoredMeta } from './layout';

export type { StoredMeta };

/** Everything stored: the maps, the elevation sets, which map is current and the user's choices. */
export interface Library {
  maps: MapInfo[];
  sets: SetInfo[];
  current: string | null;
  choices: Choices;
}

/** One map, opened: its files and the elevation set it draws hillshading from. */
export interface Stored {
  id: string;
  meta: StoredMeta;
  img: File;
  hgt: File[];
  overview: File | null;
  set: SetInfo | null;
}

export const cacheKey = (m: StoredMeta) => `${m.imgName}|${m.imgSize}|${m.imgLastModified}`;

async function readSet(dir: FileSystemDirectoryHandle, id: string, choices: Choices): Promise<SetInfo | null> {
  const s = parseSetJson(await readTextFile(dir, 'set.json'));
  if (!s?.files.length) return null;
  // The size is in set.json; sets written before it was kept look at their files once more.
  const bytes = s.bytes ?? (await Promise.all(s.files.map((f) => dir.getFileHandle(f).then((h) => h.getFile()).then((x) => x.size, () => 0)))).reduce((a, b) => a + b, 0);
  const squares = s.files.map((f) => parseHgtName(canonicalHgtName(f))).filter((q) => q !== null);
  return { id, name: choices.sets[id]?.name ?? s.name, files: s.files, step: s.step, overview: s.overview, bytes, squares };
}

/** Reads what's stored. Elevation that older versions kept with a map is made a set first. */
/** Nothing stored (what to show when storage can't be read). */
export const emptyLibrary = (): Library => ({ maps: [], sets: [], current: null, choices: parseChoices(null) });

export async function loadLibrary(): Promise<Library> {
  const root = await storageRoot();
  const entries = (await listEntries(root)).filter((e) => e.kind === 'directory');
  // The upgrade from one map: only when an older map's elevation isn't a set yet.
  for (const e of entries) {
    if (!isMapDir(e.name)) continue;
    const dem = await subdir(await root.getDirectoryHandle(e.name), 'dem');
    if (dem && !parseSetJson(await readTextFile(dem, 'set.json'))) {
      await runWorker({ type: 'migrate' }).catch((err) => console.warn('elevation upgrade', err));
      break;
    }
  }
  const choices = parseChoices(await readTextFile(root, CHOICES));
  const maps: MapInfo[] = [];
  const sets: SetInfo[] = [];
  for (const e of entries.sort((a, b) => dirTime(a.name) - dirTime(b.name) || (a.name < b.name ? -1 : 1))) {
    const dir = await root.getDirectoryHandle(e.name);
    if (isSetDir(e.name)) {
      const s = await readSet(dir, e.name, choices);
      if (s) sets.push(s);
      continue;
    }
    if (!isMapDir(e.name)) continue;
    const dem = await subdir(dir, 'dem');
    if (dem) {
      const s = await readSet(dem, `${e.name}/dem`, choices);
      if (s) sets.push(s);
    }
    const meta = parseMeta(await readTextFile(dir, 'meta.json'));
    if (!meta) continue;
    let size = -1;
    try {
      size = (await (await dir.getFileHandle('map.img')).getFile()).size;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (size !== meta.imgSize) continue;
    const c = choices.maps[e.name] ?? {};
    maps.push({
      id: e.name,
      name: c.name ?? mapName(meta.imgName),
      imgName: meta.imgName,
      bytes: meta.imgSize,
      added: dirTime(e.name),
      bounds: meta.bounds ?? c.bounds ?? null,
      elevation: c.elevation,
    });
  }
  return { maps, sets, current: maps.length ? await currentDirName(root) : null, choices };
}

/** Opens map `id` with elevation set `set` (null: none). */
export async function loadMap(lib: Library, id: string, set: SetInfo | null): Promise<Stored> {
  const root = await storageRoot();
  const dir = await root.getDirectoryHandle(id);
  const meta = parseMeta(await readTextFile(dir, 'meta.json'));
  if (!meta) throw new Error('The map is no longer stored.');
  const img = await (await dir.getFileHandle('map.img')).getFile();
  let hgt: File[] = [];
  let overview: File | null = null;
  if (set && lib.sets.some((s) => s.id === set.id)) {
    const sdir = await setDir(root, set.id);
    hgt = await Promise.all(set.files.map(async (n) => {
      const f = await (await sdir.getFileHandle(n)).getFile();
      const name = canonicalHgtName(n);
      return name === n ? f : new File([f], name);
    }));
    overview = await sdir.getFileHandle(set.overview).then((h) => h.getFile()).catch(() => null);
  }
  return { id, meta, img, hgt, overview, set: hgt.length ? set : null };
}

/** Reads a small text file from a map's directory (null when it isn't there). */
export async function readText(dir: string, name: string): Promise<string | null> {
  try {
    return await readTextFile(await (await storageRoot()).getDirectoryHandle(dir), name);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function runWorker<T = void>(msg: Record<string, unknown>, onProgress?: (m: string) => void): Promise<T> {
  const w = new Worker(new URL('./storageWorker.ts', import.meta.url), { type: 'module' });
  return new Promise<T>((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.message);
      else if (m.type === 'done') resolve(m.result as T);
      else if (m.type === 'error') reject(new Error(m.message));
    };
    w.onerror = (e) => reject(new Error(e.message || 'storage worker failed'));
    w.postMessage(msg);
  }).finally(() => w.terminate());
}

export interface ImportChoices {
  name?: string;
  /** The set to use: an id, null for none, undefined for automatic (new .hgt files make a set). */
  elevation?: string | null;
}

/** Adds a map (and its .hgt files as a new elevation set) and makes it the current map; resolves to its id. */
export const importFiles = (img: File, hgt: File[], onProgress: (m: string) => void, opts: ImportChoices = {}) =>
  runWorker<string>({ type: 'import', img, hgt, opts }, onProgress);

/** Downloads a zipped map and adds it as `imgName`, like an import of that file; resolves to its id. */
export const downloadMap = (url: string, imgName: string, onProgress: (m: string) => void) => runWorker<string>({ type: 'download', url, imgName }, onProgress);

/** Stores .hgt files as a new elevation set, or adds them to set `into`; resolves to the set's id. */
export const importElevation = (hgt: File[], into: string | null, onProgress: (m: string) => void) =>
  runWorker<string>({ type: 'elevation', hgt, into }, onProgress);

/** A map file's area and name, read without storing it. */
export const inspectMap = (img: File) => runWorker<{ bounds: Bounds; description: string }>({ type: 'inspect', img });

export const setCurrent = (id: string) => runWorker({ type: 'setCurrent', id });
export const removeMap = (id: string) => runWorker({ type: 'removeMap', id });
export const removeSet = (id: string) => runWorker({ type: 'removeSet', id });

/** Changes the user's choices (names, hillshading) from the stored ones. */
export function changeChoices(change: (c: Choices) => void): Promise<void> {
  // One at a time: each reads what the last one wrote.
  const run = choicesQueue.then(async () => {
    const c = parseChoices(await readTextFile(await storageRoot(), CHOICES));
    change(c);
    await runWorker({ type: 'writeText', dir: null, name: CHOICES, text: JSON.stringify(c) });
  });
  choicesQueue = run.catch(() => {});
  return run;
}
let choicesQueue: Promise<void> = Promise.resolve();

/** Writes a small text file into a map's directory; rejects when the map is gone. */
export const writeText = (dir: string, name: string, text: string) => runWorker({ type: 'writeText', dir, name, text });

/** Removes everything stored: the pointer first (so a partial removal reads as "no map"), then
 *  every map and elevation directory and the choices. Throws if anything could not be removed. */
export async function clearStored(): Promise<void> {
  const root = await storageRoot();
  const errors: string[] = [];
  const remove = async (name: string, recursive: boolean) => {
    try {
      await root.removeEntry(name, { recursive });
    } catch (err) {
      if (!isMissing(err)) errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await remove(POINTER, false);
  for (const e of await listEntries(root)) if (e.kind === 'directory' && isDataDir(e.name)) await remove(e.name, true);
  await remove(CHOICES, false);
  if (errors.length) throw new Error(`Could not remove the stored maps: ${errors.join('; ')}`);
}

/** Whether any map data exists in storage, even if it isn't a loadable map (so the user can
 *  still be offered to remove it). */
export async function hasStoredData(): Promise<boolean> {
  return hasDataDirs(await storageRoot());
}

export async function requestPersistence(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}
