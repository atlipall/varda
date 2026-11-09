/// <reference lib="webworker" />
import { Dem, TILE_SIZE } from '../dem/dem';
import { decodeOverview } from '../dem/overview';
import { decodeSubdivision } from '../img/rgn';
import { BlobSource } from '../img/source';
import type { Subdivision } from '../img/tre';
import { GarminMap, type MapTile } from '../map/garminMap';
import { NodeIndex, type RoadGraph, type Route } from '../routing/graph';
import { buildNetwork } from '../routing/network';
import { planRoute } from '../routing/plan';
import type { RoadClasses } from '../routing/roadClass';
import { roadLineSource, routeShape } from '../routing/shape';
import { collectIndex } from '../search/places';
import { matchTrack } from '../tracks/match';
import { buildTile, SubdivisionCache } from '../tiles/buildTile';

declare const self: DedicatedWorkerGlobalScope;

let opened: Promise<GarminMap> | null = null;
/** The road network built from NOD, plus an index over its nodes and the road classes it was built
 *  with (also used to pick eligible road lines when snapping); built once
 *  per open map, on the first `route` request, and reset whenever a new map is opened. The road
 *  classes (`msg.roads`) of that first request are the ones used for the whole session — a later
 *  `route` call with different classes still gets the network built from the first call's. */
let network: Promise<{ graph: RoadGraph; index: NodeIndex; roads: RoadClasses }> | null = null;
/** Set synchronously when `open` arrives, so a `dem` request that lands while `open` is still
 *  building the DEM (e.g. right after the pool respawned this worker) waits instead of failing. */
let demReady: Promise<Dem | null> | null = null;
// 750k points: the coarsest level alone needs ~585k for a 3x3 block of z7 tiles, plus the slim
// early-road and label-context entries.
const cache = new SubdivisionCache(750_000);
/** Ids of `tile` requests the pool has asked us to abandon. Checked before starting decode work
 *  and again right before posting a result, so a cancelled tile does as little wasted work as
 *  practical; entries are removed once consumed so the set can't grow without bound. */
const cancelled = new Set<number>();
/** Ids of requests being handled now. */
const inFlight = new Set<number>();
/** Tiles are built one at a time: building several at once holds all their decoded subdivisions in
 *  memory together (a pinch-out requests dozens of tiles, most cancelled moments later), and a tile
 *  cancelled while waiting its turn is skipped without being decoded at all. */
let tileTurn: Promise<unknown> = Promise.resolve();
function oneTileAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = tileTurn.then(job);
  tileTurn = run.catch(() => {});
  return run;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    // Only for a request still being handled: a cancel that crossed its reply would never be
    // consumed and pile up.
    if (inFlight.has(msg.id)) cancelled.add(msg.id);
    return;
  }
  inFlight.add(msg.id);
  try {
    if (msg.type === 'open') {
      // A new file shares no subdivisions with whatever was cached for the last one, and no DEM
      // data either (a map with no .hgt files must not keep serving the previous map's terrain).
      cache.clear();
      cancelled.clear();
      network = null;
      opened = GarminMap.open(new BlobSource(msg.file as File));
      const hgt = (msg.hgt ?? []) as File[];
      const overviewFile = (msg.overview ?? null) as File | null;
      demReady = hgt.length
        ? (async () => {
            const overview = overviewFile ? decodeOverview(new Uint8Array(await overviewFile.arrayBuffer())) : null;
            return Dem.fromFiles(hgt.map((f) => ({ name: f.name, src: new BlobSource(f) })), overview);
          })()
        : Promise.resolve(null);
      demReady.catch(() => {}); // surfaced by the awaits below / in `dem`; never an unhandled rejection
      const m = await opened;
      const dem = await demReady;
      self.postMessage({
        type: 'opened',
        id: msg.id,
        bounds: m.bounds,
        typ: m.typ,
        tileIds: m.tiles.map((t) => t.id),
        demBounds: dem?.bounds ?? null,
        demMaxZoom: dem?.maxZoom ?? null,
        description: m.description,
      });
    } else if (msg.type === 'tile') {
      if (!opened) throw new Error('map not opened');
      if (cancelled.delete(msg.id)) return;
      const m = await opened;
      if (cancelled.delete(msg.id)) return;
      const r = await oneTileAtATime(async () => {
        if (cancelled.has(msg.id)) return null;
        const t0 = performance.now();
        return { ...(await buildTile(m, cache, msg.z, msg.x, msg.y)), t0 };
      });
      if (cancelled.delete(msg.id) || !r) return;
      const { t0 } = r;
      const buf = r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer;
      self.postMessage({ type: 'tile', id: msg.id, data: buf, ms: performance.now() - t0, badSections: r.badSections, features: r.features }, [buf]);
    } else if (msg.type === 'dem') {
      if (!demReady) throw new Error('map not opened');
      const dem = await demReady;
      if (!dem) throw new Error('no elevation data loaded');
      if (cancelled.delete(msg.id)) return;
      const t0 = performance.now();
      const rgba = await dem.tile(msg.z, msg.x, msg.y);
      if (cancelled.delete(msg.id)) return;
      // createImageBitmap is missing or throws on some older iOS Safari versions; fall back to
      // shipping the raw RGBA buffer so the main thread (Task 6) can build the bitmap itself.
      let bitmap: ImageBitmap | undefined;
      if (typeof createImageBitmap === 'function') {
        try {
          // Dem.tile()'s Uint8ClampedArray is generic over ArrayBufferLike; ImageData wants the
          // narrower ArrayBuffer, which is what a freshly allocated typed array is backed by.
          bitmap = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, TILE_SIZE, TILE_SIZE));
        } catch {
          bitmap = undefined;
        }
      }
      const ms = performance.now() - t0;
      if (cancelled.delete(msg.id)) return;
      if (bitmap) {
        self.postMessage({ type: 'dem', id: msg.id, bitmap, ms }, [bitmap]);
      } else {
        const buf = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;
        self.postMessage({ type: 'dem', id: msg.id, rgba: buf, ms }, [buf]);
      }
    } else if (msg.type === 'elevations') {
      const dem = demReady ? await demReady : null;
      const coords = msg.coords as Array<[number, number]>;
      const metres: Array<number | null> = [];
      for (const [lon, lat] of coords) metres.push(dem ? await dem.elevationAt(lon, lat) : null);
      self.postMessage({ type: 'elevations', id: msg.id, metres });
    } else if (msg.type === 'elevation') {
      const dem = demReady ? await demReady : null;
      const metres = dem ? await dem.elevationAt(msg.lon, msg.lat) : null;
      self.postMessage({ type: 'elevation', id: msg.id, metres });
    } else if (msg.type === 'places') {
      if (!opened) throw new Error('map not opened');
      if (cancelled.delete(msg.id)) return;
      const m = await opened;
      // collectIndex (and the decodeAll it's built on) has no way to abort mid-decode short of
      // changing its signature, which is out of scope here — this only skips starting the work,
      // or skips replying, for a request that's already been cancelled either side of it.
      const { places, roads } = await collectIndex(m);
      if (cancelled.delete(msg.id)) return;
      self.postMessage({ type: 'places', id: msg.id, places, roads });
    } else if (msg.type === 'route') {
      if (!opened) throw new Error('map not opened');
      const m = await opened;
      if (!network) {
        // A rejected build (I/O error, malformed NOD) must not stick around forever: clear
        // `network` — but only if nothing else already replaced it (a later 'open') — so the
        // next 'route' request retries instead of failing until the worker is reopened. Mirrors
        // SubdivisionCache.get()'s retry-on-rejection in ../tiles/buildTile.ts.
        // The handler comes after the mapper, so a failing NodeIndex construction is caught too.
        const roads = msg.roads as RoadClasses;
        const building: Promise<{ graph: RoadGraph; index: NodeIndex; roads: RoadClasses }> = buildNetwork(m, roads)
          .then((graph) => ({ graph, index: new NodeIndex(graph), roads }))
          .catch((err) => {
            if (network === building) network = null;
            throw err;
          });
        network = building;
      }
      const { graph, index, roads } = await network;
      const decode = (tile: MapTile, sd: Subdivision) => cache.get(`${tile.id}:${sd.index}`, async () => decodeSubdivision(await m.readSubdivision(tile, sd), sd, { sections: 0, badSections: 0 }));
      const lines = roadLineSource(m, decode, roads);
      const shape = (route: Route) => routeShape(graph, index, route, lines);
      const result = await planRoute(graph, index, lines, msg.from as [number, number], msg.to as [number, number], msg.allowFRoads as boolean, shape, msg.preferFRoads === true);
      self.postMessage({ type: 'route', id: msg.id, result });
    } else if (msg.type === 'match') {
      // A track matched to the map's roads (for its turn instructions): only the road lines needed.
      if (!opened) throw new Error('map not opened');
      const m = await opened;
      const decode = (tile: MapTile, sd: Subdivision) => cache.get(`${tile.id}:${sd.index}`, async () => decodeSubdivision(await m.readSubdivision(tile, sd), sd, { sections: 0, badSections: 0 }));
      const segs = await matchTrack(msg.coords as Array<[number, number]>, roadLineSource(m, decode, msg.roads as RoadClasses), msg.times as Array<number | null> | undefined);
      self.postMessage({ type: 'match', id: msg.id, segs });
    }
  } catch (err) {
    if (cancelled.delete(msg.id)) return;
    self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight.delete(msg.id);
    cancelled.delete(msg.id);
  }
};
