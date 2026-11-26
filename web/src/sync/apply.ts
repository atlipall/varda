import { changedAt } from '../saved/backup';
import { batch, type StoreName } from '../storage/idb';
import type { SyncPlan } from './merge';

type Item = { id: string; added: number; updated?: number };

/** How many items a sync brought in were kept back, per kind, because the copy here changed (or
 *  was deleted) after the one that came in. */
export interface Applied {
  saved: number;
  tracks: number;
  photos: number;
}

/**
 * Writes what a sync brings in (`plan`) in one transaction, so a sync of many items is one write
 * instead of one each, and each item is compared with what's stored at that moment: one edited or
 * deleted here while the sync ran (after the copy that came in) wins over it. `gone` is the
 * deletions made here (id → when). A photo's removal takes its picture too.
 */
export async function applyPlan(plan: SyncPlan, gone: Record<string, number>): Promise<Applied> {
  const kept: Applied = { saved: 0, tracks: 0, photos: 0 };
  const newer = (mine: Item | undefined, theirs: Item) =>
    (!!mine && changedAt(mine) > changedAt(theirs)) || (gone[theirs.id] ?? -Infinity) >= changedAt(theirs);
  const kinds: Array<{ kind: keyof Applied; store: StoreName; put: Item[]; remove: string[]; alsoFrom?: StoreName }> = [
    { kind: 'saved', store: 'saved', put: plan.putSaved, remove: plan.removeSaved },
    { kind: 'tracks', store: 'tracks', put: plan.putTracks, remove: plan.removeTracks },
    { kind: 'photos', store: 'photos', put: plan.putPhotos, remove: plan.removePhotos, alsoFrom: 'photoFiles' },
  ];
  const used = kinds.filter((k) => k.put.length || k.remove.length);
  if (!used.length) return kept;
  const stores = [...new Set(used.flatMap((k) => (k.alsoFrom && k.remove.length ? [k.store, k.alsoFrom] : [k.store])))];
  await batch(stores, 'readwrite', (tx) => {
    for (const k of used) {
      const s = tx.objectStore(k.store);
      // Removals after the puts (as an id both put and removed would end up removed).
      const removeAll = () => {
        for (const id of k.remove) {
          s.delete(id);
          if (k.alsoFrom) tx.objectStore(k.alsoFrom).delete(id);
        }
      };
      let waiting = k.put.length;
      if (!waiting) removeAll();
      for (const x of k.put) {
        const req = s.get(x.id);
        req.onsuccess = () => {
          if (newer(req.result as Item | undefined, x)) kept[k.kind]++;
          else s.put(x);
          if (--waiting === 0) removeAll();
        };
      }
    }
  });
  return kept;
}
