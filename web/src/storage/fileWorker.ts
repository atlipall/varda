/// <reference lib="webworker" />
import { smallChange } from './files';

/** The storage worker for small changes (which map is current, the choices, a map's small files,
 *  removing a map or a set): kept apart from storageWorker.ts so it starts without loading the map
 *  parser, and kept open between changes (store.ts closes it when idle). One message at a time. */

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent) => {
  try {
    if (!(await smallChange(e.data))) throw new Error(`not a small change: ${e.data?.type}`);
    self.postMessage({ type: 'done' });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
