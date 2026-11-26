import { storageName } from '../channel';

/** The app's IndexedDB database (GPX tracks, saved pins and routes, photos, overlays), kept on this device and
 *  independent of the loaded map. Every store is created here. */
const DB = storageName('garmin-map');
export type StoreName = 'tracks' | 'saved' | 'photos' | 'photoFiles' | 'overlays' | 'overlayData';
const STORES: StoreName[] = ['tracks', 'saved', 'photos', 'photoFiles', 'overlays', 'overlayData'];

/** Opens the database at `version` (none: as it is), creating the stores it lacks on an upgrade. */
function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB) : indexedDB.open(DB, version);
    req.onupgradeneeded = () => {
      for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
    };
    // Another tab holding the database open blocks an upgrade: say so rather than wait forever.
    req.onblocked = () => reject(new Error('The app is open in another tab or window; close it and try again.'));
    req.onsuccess = () => {
      // An upgrade wanted elsewhere: let it happen.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('Could not open storage.'));
  });
}

/**
 * The database, at whatever version it has: a version number only ever goes up, and another version
 * of the app (an older one still open on a phone, or the development version on another branch)
 * may have raised it and added stores of its own. Upgraded (one version up) only when a store this
 * version needs is missing.
 */
async function openFresh(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('This browser cannot store data.');
  const db = await openAt();
  if (STORES.every((s) => db.objectStoreNames.contains(s))) return db;
  const next = db.version + 1;
  db.close();
  return openAt(next);
}

/** The open connection, kept between requests (each thumbnail, synced item and added photo used to
 *  open and close the database). Let go when another tab or version wants to upgrade the database,
 *  or when the browser closes it (storage cleared, an error), so the next request opens it afresh,
 *  again at whatever version it has then. */
let shared: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (shared) return shared;
  const p = openFresh().then((db) => {
    const drop = () => {
      if (shared === p) shared = null;
    };
    db.onversionchange = () => {
      drop();
      db.close();
    };
    db.onclose = drop;
    return db;
  });
  shared = p;
  p.catch(() => {
    if (shared === p) shared = null;
  });
  return p;
}

/** A transaction on the shared connection; opened once more if the connection was closed under it
 *  (InvalidStateError) without the close being reported yet. */
async function transaction(stores: StoreName | StoreName[], mode: IDBTransactionMode): Promise<IDBTransaction> {
  const db = await open();
  try {
    return db.transaction(stores, mode);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'InvalidStateError')) throw err;
    shared = null;
    return (await open()).transaction(stores, mode);
  }
}

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Storage failed.'));
  });

/** Runs one request on `store` in its own transaction and resolves when the transaction completes. */
export async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const tx = await transaction(store, mode);
  const done = finished(tx);
  const req = fn(tx.objectStore(store));
  await done;
  return req.result;
}

/** Runs many requests on `stores` in one transaction (a sync's puts and deletes) and resolves when
 *  it completes: all of them are written or, on a failure, none. `fn` may start more requests from
 *  a request's onsuccess, but must not await anything else, or the transaction ends early. */
export async function batch(stores: StoreName[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> {
  const tx = await transaction(stores, mode);
  const done = finished(tx);
  try {
    fn(tx);
  } catch (err) {
    tx.abort();
    await done.catch(() => {});
    throw err;
  }
  await done;
}
