import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeSubdivision } from '../src/img/rgn';
import type { Subdivision } from '../src/img/tre';
import { GarminMap, type MapTile } from '../src/map/garminMap';
import { NodeIndex, type RoadGraph } from '../src/routing/graph';
import { buildNetwork } from '../src/routing/network';
import { planRoute } from '../src/routing/plan';
import type { RoadClasses } from '../src/routing/roadClass';
import { roadLineSource, routeShape } from '../src/routing/shape';
import { collectIndex } from '../src/search/places';
import { SubdivisionCache } from '../src/tiles/buildTile';
import { nodeSource } from './helpers/nodeSource';
import { FZK_DENMARK } from './helpers/paths';

// The app crashed on the iPhone when routing on this map: the whole network built as JS arrays
// and Maps took over 1.8 GB. These check it still routes with the typed-array graph.
describe.skipIf(!existsSync(FZK_DENMARK))('routing on a big map (Freizeitkarte Denmark)', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  let roads: RoadClasses;
  let graph: RoadGraph;
  let index: NodeIndex;

  beforeAll(async () => {
    src = await nodeSource(FZK_DENMARK);
    map = await GarminMap.open(src);
    roads = (await collectIndex(map)).roads;
    graph = await buildNetwork(map, roads);
    index = new NodeIndex(graph);
  }, 300_000);
  afterAll(() => src.close());

  test('footpath-only nodes are left out of the graph', () => {
    // 3.67 million NOD nodes, 2.6 million with an arc a car may use.
    expect(graph.nodeX.length).toBeGreaterThan(2_000_000);
    expect(graph.nodeX.length).toBeLessThan(3_000_000);
  });

  test('Copenhagen → Aarhus: about 300 km, 2.5-3 h, drawn along the roads', async () => {
    const cache = new SubdivisionCache(750_000);
    const decode = (tile: MapTile, sd: Subdivision) => cache.get(`${tile.id}:${sd.index}`, async () => decodeSubdivision(await map.readSubdivision(tile, sd), sd, { sections: 0, badSections: 0 }));
    const lines = roadLineSource(map, decode, roads);
    const r = await planRoute(graph, index, lines, [12.568, 55.676], [10.203, 56.162], true, (route) => routeShape(graph, index, route, lines));
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.metres / 1000).toBeGreaterThan(280);
    expect(r.metres / 1000).toBeLessThan(330);
    expect(r.seconds / 3600).toBeGreaterThan(2.5);
    expect(r.seconds / 3600).toBeLessThan(3);
    expect(r.coords.length).toBeGreaterThan(1000);
    expect(r.segs?.some((s) => s.name)).toBe(true);
  }, 120_000);
});
