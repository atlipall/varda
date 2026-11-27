import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WALK_MPS } from '../src/gpx/fromRoute';
import type { RawObject } from '../src/img/rgn';
import type { Subdivision } from '../src/img/tre';
import { GarminMap, type MapTile } from '../src/map/garminMap';
import { NodeIndex, type RoadGraph } from '../src/routing/graph';
import { buildNetwork } from '../src/routing/network';
import { planRoute, type LonLat } from '../src/routing/plan';
import { planWalk } from '../src/routing/planWalk';
import type { RoadClasses } from '../src/routing/roadClass';
import { roadLineSource, routeShape, walkLineSource } from '../src/routing/shape';
import { collectIndex } from '../src/search/places';
import { matchTrack } from '../src/tracks/match';
import { nodeSource } from './helpers/nodeSource';
import { HIKING_2026 } from './helpers/paths';

describe.skipIf(!existsSync(HIKING_2026))('walking on real data (GPSmap.is 2026 Hiking Detailed)', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  let graph: RoadGraph;
  let index: NodeIndex;
  let roads: RoadClasses;
  const cache = new Map<string, Promise<RawObject[]>>();
  const decode = (tile: MapTile, sd: Subdivision) => {
    const key = `${tile.id}:${sd.index}`;
    let p = cache.get(key);
    if (!p) cache.set(key, (p = map.decode(tile, sd, { labels: false })));
    return p;
  };
  const reykjavik: LonLat = [-21.9, 64.14];
  const drive = (to: LonLat, paths: boolean) => {
    const lines = roadLineSource(map, decode, roads);
    return planRoute(graph, index, lines, reykjavik, to, true, (r) => routeShape(graph, index, r, lines), false, paths ? walkLineSource(map, decode, roads) : undefined);
  };
  const walk = (a: LonLat, b: LonLat) => planWalk(walkLineSource(map, decode, roads), a, b, (c) => matchTrack(c, roadLineSource(map, decode, roads)));

  beforeAll(async () => {
    src = await nodeSource(HIKING_2026);
    map = await GarminMap.open(src);
    roads = (await collectIndex(map)).roads;
    graph = await buildNetwork(map, roads);
    index = new NodeIndex(graph);
  }, 300_000);
  afterAll(() => src.close());

  test('a pin on the Esja trail: driven to the trail head, then up the trail instead of straight across the slope', async () => {
    const steinn: LonLat = [-21.6936, 64.229];
    const straight = await drive(steinn, false);
    const paths = await drive(steinn, true);
    if (straight.status !== 'ok' || paths.status !== 'ok') throw new Error(`${straight.status} / ${paths.status}`);
    expect(straight.offRoadEnd).toHaveLength(2);
    expect(paths.offRoadEnd!.length).toBeGreaterThan(20);
    // Longer than straight, but by less than straight across country counts (twice).
    expect(paths.offRoadEndM).toBeGreaterThan(straight.offRoadEndM);
    expect(paths.offRoadEndM).toBeLessThan(2 * straight.offRoadEndM);
    expect(paths.offRoadEnd![paths.offRoadEnd!.length - 1]).toEqual(steinn);
  });

  test('a pin above Glymur: up the trail from the car park (it stops 150 m short of the road)', async () => {
    const r = await drive([-21.2405, 64.3955], true);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.offRoadEnd!.length).toBeGreaterThan(20);
    expect(r.offRoadEndM).toBeGreaterThan(2500);
    expect(r.offRoadEndM).toBeLessThan(4500);
  });

  test('a walk on the Laugavegur, Landmannalaugar to Hrafntinnusker, at walking pace', async () => {
    const r = await walk([-19.0605, 63.9908], [-19.1681, 63.9334]);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.metres).toBeGreaterThan(8000);
    expect(r.metres).toBeLessThan(14_000);
    expect(r.seconds).toBeCloseTo(r.metres / WALK_MPS, 0);
    expect(r.segs!.reduce((s, g) => s + g.seconds, 0)).toBeCloseTo(r.seconds, 0);
    expect(r.offRoadStartM + r.offRoadEndM).toBeLessThan(100);
  });

  test('a walk in town, along the streets', async () => {
    const r = await walk([-21.9135, 64.1432], [-21.9328, 64.1504]);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(r.metres).toBeGreaterThan(1100);
    expect(r.metres).toBeLessThan(1800);
    expect(r.segs!.some((s) => s.name)).toBe(true);
  });

  test('too far to walk', async () => {
    expect((await walk([-21.9, 64.14], [-18.1, 65.68])).status).toBe('too-far-to-walk');
  });
});
