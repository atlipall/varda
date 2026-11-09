import { run } from '../storage/idb';
import type { Overlay, OverlayFeature } from './kml';

/** An imported overlay as listed (IndexedDB "overlays"). Its shapes are kept apart, in
 *  "overlayData", so listing overlays or showing and hiding one never reads or writes them. Kept on
 *  this device only (not synced). */
export interface StoredOverlay extends Omit<Overlay, 'features'> {
  id: string;
  visible: boolean;
  /** When it was added (ms): the list order. */
  added: number;
}

export const listOverlays = async (): Promise<StoredOverlay[]> =>
  (await run('overlays', 'readonly', (s) => s.getAll() as IDBRequest<StoredOverlay[]>)).sort((a, b) => a.added - b.added);

export const putOverlay = (o: StoredOverlay): Promise<unknown> => run('overlays', 'readwrite', (s) => s.put(o));

export const getOverlayFeatures = async (id: string): Promise<OverlayFeature[]> =>
  (await run('overlayData', 'readonly', (s) => s.get(id) as IDBRequest<{ features: OverlayFeature[] } | undefined>))?.features ?? [];

/** Keeps a new overlay: its shapes first, so a listed overlay always has them. */
export async function addOverlay(o: StoredOverlay, features: OverlayFeature[]): Promise<void> {
  await run('overlayData', 'readwrite', (s) => s.put({ id: o.id, features }));
  await putOverlay(o);
}

export async function deleteOverlay(id: string): Promise<void> {
  await run('overlays', 'readwrite', (s) => s.delete(id));
  await run('overlayData', 'readwrite', (s) => s.delete(id));
}
