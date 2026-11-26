/// <reference lib="webworker" />
import { storageRoot } from '../channel';
import { BlobSource } from '../img/source';
import { GarminMap } from '../map/garminMap';
import { OLD_PLACES, PLACES } from '../storage/layout';
import { collectIndex } from './places';
import { decodePlacesCache } from './placesCache';
import { columnsFromPlaces, decodeColumns, encodeColumns, PlaceStore, type PlaceColumns } from './placeStore';

declare const self: DedicatedWorkerGlobalScope;

/**
 * The place index of the map shown, kept here rather than on the page: it reads the map's
 * `places.bin` (or, the first time, reads the map itself, which takes a while on a big map), and
 * answers searches with a few results each. The page gets the road classes, the towns and the
 * named points (for "Near X") once.
 */
let store: PlaceStore | null = null;

async function fileIn(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

async function write(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    // Older Safari returns promises from these.
    await handle.truncate(0);
    await handle.write(bytes, { at: 0 });
    await handle.flush();
  } finally {
    await handle.close();
  }
}

async function load(dirName: string, key: string, img: File): Promise<{ store: PlaceStore; source: 'cache' | 'migrated' | 'built' }> {
  const dir = await (await storageRoot()).getDirectoryHandle(dirName);
  const bin = await fileIn(dir, PLACES);
  const cached = bin ? decodeColumns(await bin.arrayBuffer(), key) : null;
  if (cached) return { store: new PlaceStore(cached), source: 'cache' };
  let cols: PlaceColumns | null = null;
  let source: 'migrated' | 'built' = 'built';
  const old = await fileIn(dir, OLD_PLACES);
  if (old) {
    const decoded = decodePlacesCache(await old.text(), key);
    if (decoded) {
      cols = columnsFromPlaces(decoded.places, decoded.roads);
      source = 'migrated';
    }
  }
  if (!cols) {
    const { places, roads } = await collectIndex(await GarminMap.open(new BlobSource(img)));
    cols = columnsFromPlaces(places, roads);
  }
  // One copy kept: the store reads the file's bytes.
  const bytes = encodeColumns(key, cols);
  cols = null;
  try {
    await write(dir, PLACES, bytes);
    if (old) await dir.removeEntry(OLD_PLACES);
  } catch (err) {
    // Only costs building it again next time; search works now.
    console.warn('places cache', err);
  }
  return { store: new PlaceStore(decodeColumns(bytes.buffer as ArrayBuffer, key)!), source };
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      const loaded = await load(msg.dir as string, msg.key as string, msg.img as File);
      store = loaded.store;
      const near = store.namedPoints();
      const transfer = [near.lon, near.lat, near.index, near.nameOff, near.names, near.cells, near.cellStart].map((a) => a.buffer as ArrayBuffer);
      self.postMessage({
        type: 'loaded', id: msg.id, roads: store.cols.roads, towns: store.towns(), near, count: store.size, source: loaded.source, ms: performance.now() - t0,
      }, transfer);
    } else if (msg.type === 'search') {
      if (!store) throw new Error('places not loaded');
      self.postMessage({ type: 'found', id: msg.id, places: store.search(msg.q as string, msg.limit as number, msg.near as [number, number] | undefined) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
