import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RawObject } from '../src/img/rgn';
import type { Subdivision } from '../src/img/tre';
import { GarminMap, type MapTile } from '../src/map/garminMap';
import { NodeIndex, type RoadGraph } from '../src/routing/graph';
import { buildNetwork } from '../src/routing/network';
import { maneuvers } from '../src/routing/maneuvers';
import { planRoute } from '../src/routing/plan';
import type { RoadClasses } from '../src/routing/roadClass';
import { roadLineSource, routeShape } from '../src/routing/shape';
import { collectIndex } from '../src/search/places';
import { nodeSource } from './helpers/nodeSource';
import { F_ROAD_DETAILED, hasRealData } from './helpers/paths';

describe.skipIf(!hasRealData || !existsSync(F_ROAD_DETAILED))('planRoute on real data (F-Road Detailed)', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  let graph: RoadGraph;
  let index: NodeIndex;
  let roads: RoadClasses;
  const cache = new Map<string, Promise<RawObject[]>>();
  const decode = (tile: MapTile, sd: Subdivision) => {
    const key = `${tile.id}:${sd.index}`;
    let p = cache.get(key);
    if (!p) cache.set(key, (p = map.decode(tile, sd)));
    return p;
  };
  const plan = (from: [number, number], to: [number, number], allow: boolean) => {
    const lines = roadLineSource(map, decode, roads);
    return planRoute(graph, index, lines, from, to, allow, (r) => routeShape(graph, index, r, lines));
  };

  beforeAll(async () => {
    src = await nodeSource(F_ROAD_DETAILED);
    map = await GarminMap.open(src);
    roads = (await collectIndex(map)).roads;
    graph = await buildNetwork(map, roads);
    index = new NodeIndex(graph);
  }, 300_000);
  afterAll(() => src.close());

  test('the map centre from the report (~1 km from a highland track, far from its junctions) gets a route', async () => {
    const t0 = performance.now();
    const r = await plan([-19.31, 64.18], [-21.0, 63.936], true);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    console.log(`(-19.31, 64.18) → Selfoss: ${(r.metres / 1000).toFixed(1)} km, ${(r.seconds / 3600).toFixed(2)} h, off-road at the start ${Math.round(r.offRoadStartM)} m, ${Math.round(performance.now() - t0)} ms`);
    expect(r.offRoadStartM).toBeLessThan(2000);
  }, 120_000);

  test('Selfoss → Landmannalaugar: 2.0-3.3 h with F-roads, no route without', async () => {
    const r = await plan([-21.0, 63.936], [-19.06, 63.991], true);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    const hours = r.seconds / 3600;
    console.log(`Selfoss → Landmannalaugar: ${(r.metres / 1000).toFixed(1)} km, ${hours.toFixed(2)} h, off-road ${Math.round(r.offRoadStartM)} m / ${Math.round(r.offRoadEndM)} m`);
    expect(hours).toBeGreaterThanOrEqual(2.0);
    expect(hours).toBeLessThanOrEqual(3.3);
    // Without F-roads: the normal road stubs around Landmannalaugar are reached only over F-roads.
    await expect(plan([-21.0, 63.936], [-19.06, 63.991], false)).resolves.toEqual({ status: 'no-route' });
  }, 120_000);

  test('in town the route keeps to the main roads (Grandi → Mosfellsbær by Hringbraut and Miklabraut)', async () => {
    // By time alone it zig-zagged through Borgartún, Háaleitisbraut and Fellsmúli (24 turns): those
    // streets have the main roads' speed class.
    const r = await plan([-21.94, 64.1555], [-21.7, 64.167], true);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    const roads = new Set((r.segs ?? []).map((x) => x.name));
    const turns = maneuvers(r.coords, r.segs ?? [], 'here').filter((m) => m.kind === 'turn' || m.kind === 'keep' || m.kind === 'roundabout').length;
    console.log(`Grandi → Mosfellsbær: ${(r.metres / 1000).toFixed(1)} km, ${(r.seconds / 60).toFixed(1)} min, ${turns} turns`);
    expect(roads).toContain('MIKLABRAUT');
    for (const side of ['HÁALEITISBRAUT', 'FELLSMÚLI', 'BORGARTÚN']) expect(roads).not.toContain(side);
    expect(turns).toBeLessThanOrEqual(14);
  }, 120_000);

  test('Kársnes → Sundahöfn by Kringlumýrarbraut and Sæbraut (the owner\'s report: it went through Háaleitisbraut and Langholtsvegur)', async () => {
    const r = await plan([-21.927, 64.1105], [-21.857, 64.1455], true);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    const roads = new Set((r.segs ?? []).map((x) => x.name));
    expect(roads).toContain('KRINGLUMÝRARBRAUT');
    expect(roads).toContain('SÆBRAUT');
    for (const side of ['HÁALEITISBRAUT', 'GRENSÁSVEGUR', 'LANGHOLTSVEGUR']) expect(roads).not.toContain(side);
  }, 120_000);

  test('the middle of Vatnajökull: the far search steps stay quick', async () => {
    const t0 = performance.now();
    const r = await plan([-16.8, 64.45], [-21.0, 63.936], true);
    const ms = performance.now() - t0;
    console.log(`Vatnajökull → Selfoss: ${r.status}${r.status === 'ok' ? `, off-road ${(r.offRoadStartM / 1000).toFixed(1)} km` : ''}, ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(30_000);
  }, 120_000);
});
