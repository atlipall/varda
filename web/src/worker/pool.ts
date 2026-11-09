import type { RoadSeg, RouteReply } from '../routing/plan';
import type { RoadClasses } from '../routing/roadClass';
import type { Place } from '../search/places';

export type { RouteReply };

export interface OpenPayload {
  file: File;
  hgt: File[];
  overview: File | null;
}

export interface OpenMeta {
  bounds: [number, number, number, number];
  typ: Uint8Array | null;
  tileIds: string[];
  demBounds: [number, number, number, number] | null;
  /** The last zoom terrain tiles are worth asking for at (null without elevation files). */
  demMaxZoom: number | null;
  /** The map's name from the IMG header. */
  description: string;
}

export interface TileResult {
  data: ArrayBuffer;
  ms: number;
  badSections: number;
  features: number;
}

/** Exactly one of `bitmap`/`rgba` is set: `bitmap` on platforms where the worker could build an
 *  `ImageBitmap` itself, `rgba` (a transferred RGBA buffer) where `createImageBitmap` was missing
 *  or threw — which happens on some older iOS Safari versions. Task 6's main-thread code is
 *  expected to build the `ImageBitmap` from `rgba` itself in that case. */
export interface DemResult {
  bitmap?: ImageBitmap;
  rgba?: ArrayBuffer;
  ms: number;
}

type Pending = { worker: Worker; resolve: (v: any) => void; reject: (e: Error | DOMException) => void };

/** Caps respawn attempts per slot so a worker that dies immediately on construction (e.g. a
 * broken build) can't respawn forever; past this it's left dead and routed around. */
const MAX_RESPAWNS_PER_SLOT = 3;

export class TilePool {
  /** `null` means that slot's worker died and ran out of respawn attempts. */
  private readonly workers: Array<Worker | null> = [];
  private readonly respawns: number[] = [];
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private opened = false;
  private disposed = false;

  /** Whether `dispose` was called (its calls then reject: not a failure of the map). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  constructor(private readonly payload: OpenPayload, size: number) {
    for (let i = 0; i < size; i++) {
      this.respawns[i] = 0;
      this.workers[i] = this.spawn(i);
    }
  }

  private spawn(index: number): Worker {
    const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => this.onWorkerDown(index, w, new Error(e.message || 'worker error'));
    // A message that failed to deserialize doesn't necessarily mean the worker itself is dead,
    // so only its own pending calls are rejected (not a full respawn).
    w.onmessageerror = () => this.rejectPendingFor(w, new Error('worker message error'));
    return w;
  }

  /** A worker crashed or failed to load: fail its in-flight calls, then respawn it (re-sending
   * `open` before it's handed tile work) or, past the respawn cap, mark the slot dead so future
   * calls route around it instead of hanging forever. */
  private onWorkerDown(index: number, dead: Worker, err: Error): void {
    this.rejectPendingFor(dead, err);
    if (this.disposed || this.workers[index] !== dead) return; // already replaced/handled/disposed
    try {
      dead.terminate();
    } catch {
      // already gone
    }
    if (this.respawns[index] >= MAX_RESPAWNS_PER_SLOT) {
      this.workers[index] = null;
      return;
    }
    this.respawns[index] += 1;
    const w = this.spawn(index);
    this.workers[index] = w;
    if (this.opened) {
      // If re-opening also fails, the new worker's own onerror handler drives the next attempt.
      this.call(w, { type: 'open', ...this.payload }).catch(() => {});
    }
  }

  private rejectPendingFor(w: Worker, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.worker === w) {
        this.pending.delete(id);
        p.reject(err);
      }
    }
  }

  private call(w: Worker, msg: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (!signal) {
        this.pending.set(id, { worker: w, resolve, reject });
        w.postMessage({ ...msg, id });
        return;
      }
      // Wrap resolve/reject so a normal completion (via onMessage or rejectPendingFor) detaches
      // the abort listener too — otherwise an abort that fires after the call already settled
      // would still try to postMessage a 'cancel' for an id the worker (and we) are done with.
      const settle = <T,>(fn: (v: T) => void) => (v: T) => {
        signal.removeEventListener('abort', onAbort);
        fn(v);
      };
      const onAbort = () => {
        if (!this.pending.delete(id)) return; // already settled: nothing to cancel or leak
        w.postMessage({ type: 'cancel', id });
        reject(new DOMException('aborted', 'AbortError'));
      };
      this.pending.set(id, { worker: w, resolve: settle(resolve), reject: settle(reject) });
      signal.addEventListener('abort', onAbort, { once: true });
      w.postMessage({ ...msg, id });
    });
  }

  private onMessage(msg: { id: number; type: string; message?: string }): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private live(): Worker[] {
    return this.workers.filter((w): w is Worker => w !== null);
  }

  /** Same worker choice for every message keyed by tile coordinates (`tile` and `dem`), so a
   *  worker's per-tile caches (subdivision cache, decoded DEM patches) stay warm across requests
   *  for neighbouring tiles. */
  private routeFor(x: number, y: number): Worker | undefined {
    const live = this.live();
    if (!live.length) return undefined;
    return live[((x >> 1) + (y >> 1) * 7) % live.length];
  }

  async open(): Promise<OpenMeta> {
    if (this.disposed) throw new Error('pool disposed');
    this.opened = true;
    const live = this.live();
    if (!live.length) throw new Error('no workers available');
    const results = await Promise.all(live.map((w) => this.call(w, { type: 'open', ...this.payload })));
    const { bounds, typ, tileIds, demBounds, demMaxZoom, description } = results[0];
    return { bounds, typ, tileIds, demBounds, demMaxZoom, description };
  }

  /** Neighbouring tiles go to the same worker so its subdivision cache is reused. `signal`, when
   *  given, cancels the request: an already-aborted signal rejects immediately without posting
   *  anything to the worker, and an abort mid-flight posts `{type: 'cancel', id}` to that worker
   *  and rejects with an `AbortError`. */
  tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<TileResult> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const w = this.routeFor(x, y);
    if (!w) return Promise.reject(new Error('no workers available'));
    return this.call(w, { type: 'tile', z, x, y }, signal);
  }

  /** Same routing and cancellation semantics as `tile()` — see its doc comment. */
  dem(z: number, x: number, y: number, signal?: AbortSignal): Promise<DemResult> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const w = this.routeFor(x, y);
    if (!w) return Promise.reject(new Error('no workers available'));
    return this.call(w, { type: 'dem', z, x, y }, signal).then((msg): DemResult => ({ bitmap: msg.bitmap, rgba: msg.rgba, ms: msg.ms }));
  }

  /** Ground height in metres at a point from the elevation files, or null without them / outside. */
  elevation(lon: number, lat: number): Promise<number | null> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const live = this.live();
    if (!live.length) return Promise.reject(new Error('no workers available'));
    return this.call(live[0], { type: 'elevation', lon, lat }).then((msg) => msg.metres as number | null);
  }

  /** `elevation` for many points in one message (e.g. a GPX track without heights). */
  elevations(coords: Array<[number, number]>): Promise<Array<number | null>> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const live = this.live();
    if (!live.length) return Promise.reject(new Error('no workers available'));
    return this.call(live[live.length - 1], { type: 'elevations', coords }).then((msg) => msg.metres as Array<number | null>);
  }

  /** Builds the place list on the LAST live worker rather than the first: a simple way to keep
   *  this one-off, comparatively expensive decode off the routing slot ((0,0) tiles and low zooms
   *  hash to index 0) that's busiest with tile requests, so it doesn't starve tile serving. */
  places(signal?: AbortSignal): Promise<{ places: Place[]; roads: RoadClasses }> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const live = this.live();
    if (!live.length) return Promise.reject(new Error('no workers available'));
    const w = live[live.length - 1];
    return this.call(w, { type: 'places' }, signal).then((msg) => ({ places: msg.places as Place[], roads: msg.roads as RoadClasses }));
  }

  /** Plans a route on the last worker (which keeps the road network after the first request). */
  route(from: [number, number], to: [number, number], allowFRoads: boolean, preferFRoads: boolean, roads: RoadClasses): Promise<RouteReply> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const live = this.live();
    if (!live.length) return Promise.reject(new Error('no workers available'));
    return this.call(live[live.length - 1], { type: 'route', from, to, allowFRoads, preferFRoads, roads }).then((msg) => msg.result as RouteReply);
  }

  /** Road stretches along a track, matched to the map's roads (for its turn instructions). */
  matchTrack(coords: Array<[number, number]>, times: Array<number | null> | undefined, roads: RoadClasses): Promise<RoadSeg[]> {
    if (this.disposed) return Promise.reject(new Error('pool disposed'));
    const live = this.live();
    if (!live.length) return Promise.reject(new Error('no workers available'));
    return this.call(live[live.length - 1], { type: 'match', coords, times, roads }).then((msg) => msg.segs as RoadSeg[]);
  }

  /** Terminates every worker and rejects every pending call with Error('pool disposed'); any
   *  later call rejects immediately the same way. Task 6 calls this on re-import, before a fresh
   *  pool is constructed for the newly opened file. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const err = new Error('pool disposed');
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i];
      this.workers[i] = null;
      if (!w) continue;
      try {
        w.terminate();
      } catch {
        // already gone
      }
    }
  }
}
