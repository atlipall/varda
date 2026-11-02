import { storageName } from '../channel';

/** The app's IndexedDB database (GPX tracks, saved pins and routes, photos, the last weather fetched),
 *  kept on this device and independent of the loaded map. Every store is created here. */
const DB = storageName('garmin-map');
export type StoreName = 'tracks' | 'saved' | 'photos' | 'photoFiles' | 'weather';
const STORES: StoreName[] = ['tracks', 'saved', 'photos', 'photoFiles', 'weather'];

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
async function open(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('This browser cannot store data.');
  const db = await openAt();
  if (STORES.every((s) => db.objectStoreNames.contains(s))) return db;
  const next = db.version + 1;
  db.close();
  return openAt(next);
}

/** Runs one request on `store` in its own transaction and resolves when the transaction completes. */
export async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Storage failed.'));
    });
  } finally {
    db.close();
  }
}
