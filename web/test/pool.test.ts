import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { TilePool, type OpenPayload } from '../src/worker/pool';

/** A message a `FakeWorker` was told to post, or its own event-callback signature. */
type Listener = (ev: any) => void;

/** Stands in for the DOM `Worker` in tests: records everything posted to it and lets the test
 *  drive its `onmessage`/`onerror`/`onmessageerror` handlers directly, instead of spinning up a
 *  real worker thread. */
class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onmessageerror: Listener | null = null;
  readonly posted: any[] = [];
  terminated = false;

  constructor(readonly url: string | URL, readonly options?: unknown) {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: any): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers a reply as if this worker had posted it. */
  reply(data: any): void {
    this.onmessage?.({ data });
  }

  /** Simulates the worker crashing. */
  fail(message = 'boom'): void {
    this.onerror?.({ message });
  }

  /** The `id` of the last message posted to this worker, for replying without hand-tracking ids. */
  lastId(): number {
    return this.posted[this.posted.length - 1].id;
  }
}

const payload: OpenPayload = { file: { name: 'a.img' } as unknown as File, hgt: [], overview: null };
const opened = (id: number) => ({ type: 'opened', id, bounds: [0, 0, 1, 1] as [number, number, number, number], typ: null, tileIds: [], demBounds: null });

let originalWorker: typeof Worker | undefined;

beforeEach(() => {
  FakeWorker.instances = [];
  originalWorker = globalThis.Worker;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
});

describe('TilePool', () => {
  test('open() sends {type: "open", ...payload} to every worker', async () => {
    const pool = new TilePool(payload, 3);
    const openPromise = pool.open();

    expect(FakeWorker.instances).toHaveLength(3);
    for (const w of FakeWorker.instances) {
      expect(w.posted).toHaveLength(1);
      expect(w.posted[0]).toMatchObject({ type: 'open', file: payload.file, hgt: payload.hgt, overview: payload.overview });
      expect(typeof w.posted[0].id).toBe('number');
    }

    for (const w of FakeWorker.instances) w.reply(opened(w.lastId()));
    await expect(openPromise).resolves.toEqual({ bounds: [0, 0, 1, 1], typ: null, tileIds: [], demBounds: null });
  });

  test('tile() resolves on a reply', async () => {
    const pool = new TilePool(payload, 1);
    const p = pool.tile(5, 10, 20);
    const w = FakeWorker.instances[0];
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ type: 'tile', z: 5, x: 10, y: 20 });

    const data = new ArrayBuffer(4);
    w.reply({ type: 'tile', id: w.lastId(), data, ms: 3, badSections: 0, features: 1 });
    await expect(p).resolves.toMatchObject({ data, ms: 3, badSections: 0, features: 1 });
  });

  test('abort before the reply rejects with an AbortError and posts {type: "cancel", id}', async () => {
    const pool = new TilePool(payload, 1);
    const controller = new AbortController();
    const p = pool.tile(0, 0, 0, controller.signal);
    const w = FakeWorker.instances[0];
    const id = w.lastId();

    controller.abort();

    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(w.posted).toHaveLength(2);
    expect(w.posted[1]).toEqual({ type: 'cancel', id });
  });

  test('a worker error rejects only that worker\'s pending calls and respawns with open resent before new work', async () => {
    const pool = new TilePool(payload, 2);

    const openPromise = pool.open();
    for (const w of FakeWorker.instances) w.reply(opened(w.lastId()));
    await openPromise;

    // (x >> 1) + (y >> 1) * 7, mod 2 live workers: (0,0) hashes to slot 0, (2,0) to slot 1.
    const pA = pool.tile(5, 0, 0);
    const pB = pool.tile(5, 2, 0);
    const workerA = FakeWorker.instances[0];
    const workerB = FakeWorker.instances[1];
    expect(workerA.posted).toHaveLength(2); // open, then the slot-0 tile call
    expect(workerB.posted).toHaveLength(2); // open, then the slot-1 tile call

    workerA.fail('boom');
    await expect(pA).rejects.toThrow('boom');

    // pB, on the other worker, must be unaffected by workerA's failure.
    let bSettled = false;
    pB.then(
      () => (bSettled = true),
      () => (bSettled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(bSettled).toBe(false);

    // A replacement worker for slot 0 is spawned, and gets 'open' resent before any new tile work.
    expect(FakeWorker.instances).toHaveLength(3);
    const replacement = FakeWorker.instances[2];
    expect(replacement.posted).toHaveLength(1);
    expect(replacement.posted[0]).toMatchObject({ type: 'open', file: payload.file });

    const pC = pool.tile(5, 0, 0);
    expect(replacement.posted).toHaveLength(2);
    expect(replacement.posted[1]).toMatchObject({ type: 'tile', x: 0, y: 0 });

    // Settle the remaining in-flight calls so nothing is left dangling.
    workerB.reply({ type: 'tile', id: workerB.lastId(), data: new ArrayBuffer(0), ms: 0, badSections: 0, features: 0 });
    await pB;
    replacement.reply(opened(replacement.posted[0].id));
    replacement.reply({ type: 'tile', id: replacement.posted[1].id, data: new ArrayBuffer(0), ms: 0, badSections: 0, features: 0 });
    await pC;
  });

  test('dispose() rejects everything pending and later calls', async () => {
    const pool = new TilePool(payload, 2);
    const p1 = pool.tile(0, 0, 0);
    const p2 = pool.tile(2, 0, 0);

    pool.dispose();

    await expect(p1).rejects.toThrow('pool disposed');
    await expect(p2).rejects.toThrow('pool disposed');
    for (const w of FakeWorker.instances) expect(w.terminated).toBe(true);

    await expect(pool.open()).rejects.toThrow('pool disposed');
    await expect(pool.tile(0, 0, 0)).rejects.toThrow('pool disposed');
    await expect(pool.dem(0, 0, 0)).rejects.toThrow('pool disposed');

    // A second dispose() is a harmless no-op, not a re-termination or a fresh rejection storm.
    expect(() => pool.dispose()).not.toThrow();
  });

  test('dem() uses the same routing as tile() and passes through bitmap/rgba/ms', async () => {
    const pool = new TilePool(payload, 1);
    const p = pool.dem(5, 10, 20);
    const w = FakeWorker.instances[0];
    expect(w.posted[0]).toMatchObject({ type: 'dem', z: 5, x: 10, y: 20 });

    const rgba = new ArrayBuffer(4);
    w.reply({ type: 'dem', id: w.lastId(), rgba, ms: 2 });
    await expect(p).resolves.toEqual({ bitmap: undefined, rgba, ms: 2 });
  });

  test('route() goes to the last worker and resolves with its reply', async () => {
    const pool = new TilePool(payload, 2);
    const r = pool.route([-21.9, 64.1], [-21.0, 63.9], true, true, {});
    const w = FakeWorker.instances[1];
    const msg = w.posted.find((m) => m.type === 'route');
    expect(msg).toMatchObject({ from: [-21.9, 64.1], to: [-21.0, 63.9], allowFRoads: true, preferFRoads: true, roads: {} });
    w.reply({ type: 'route', id: msg.id, result: { status: 'no-route' } });
    expect(await r).toEqual({ status: 'no-route' });
  });

  test('the road classes go to a worker once, and again to one that replaced it', async () => {
    const pool = new TilePool(payload, 1);
    const roads = { t: [[5, 1]] as Array<[number, 0 | 1 | 2]> };
    const sent = (w: FakeWorker) => w.posted.filter((m) => m.type === 'route' || m.type === 'match').map((m) => 'roads' in m);
    void pool.route([0, 0], [1, 1], true, false, roads).catch(() => {});
    void pool.matchTrack([[0, 0], [1, 1]], undefined, roads).catch(() => {});
    void pool.route([0, 0], [1, 1], true, false, roads).catch(() => {});
    const first = FakeWorker.instances[0];
    expect(sent(first)).toEqual([true, false, false]);
    // Another map's classes are sent.
    void pool.route([0, 0], [1, 1], true, false, { u: [] }).catch(() => {});
    expect(sent(first)).toEqual([true, false, false, true]);
    first.fail();
    const second = FakeWorker.instances[1];
    void pool.route([0, 0], [1, 1], true, false, roads).catch(() => {});
    expect(sent(second)).toEqual([true]);
  });
});
