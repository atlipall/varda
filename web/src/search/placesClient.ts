import type { RoadClasses } from '../routing/roadClass';
import type { Town } from './describe';
import { NearIndex, type NamedPoints } from './nearIndex';
import type { Place } from './places';

export interface LoadedPlaces {
  roads: RoadClasses;
  towns: Town[];
  near: NearIndex;
  count: number;
  /** Where the index came from: its file, the older places.json, or the map itself. */
  source: 'cache' | 'migrated' | 'built';
  ms: number;
}

/** The page's side of the places worker (placesWorker.ts), one per map shown. */
export class PlacesClient {
  private readonly worker = new Worker(new URL('./placesWorker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private down: Error | null = null;

  constructor() {
    this.worker.onmessage = (e) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (e) => this.fail(new Error(e.message || 'places worker failed'));
    this.worker.onmessageerror = () => this.fail(new Error('places worker message error'));
  }

  private fail(err: Error): void {
    this.down ??= err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call(msg: Record<string, unknown>): Promise<any> {
    if (this.down) return Promise.reject(this.down);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  /** Reads (or the first time builds) the place index of the map stored in `dir`. */
  async load(dir: string, key: string, img: File): Promise<LoadedPlaces> {
    const m = await this.call({ type: 'load', dir, key, img });
    return { roads: m.roads, towns: m.towns, near: new NearIndex(m.near as NamedPoints), count: m.count, source: m.source, ms: m.ms };
  }

  /** PlaceStore.search, in the worker. */
  async search(q: string, limit: number, near?: [number, number]): Promise<Place[]> {
    return (await this.call({ type: 'search', q, limit, near })).places as Place[];
  }

  dispose(): void {
    this.fail(new Error('places closed'));
    this.worker.terminate();
  }
}
