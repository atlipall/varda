import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pairs, type RawObject } from '../src/img/rgn';
import type { Subdivision } from '../src/img/tre';
import { GarminMap, type MapTile } from '../src/map/garminMap';
import { fastestRoute, GraphBuilder, metresBetween, NodeIndex, UNITS_PER_DEG, type Route } from '../src/routing/graph';
import { buildNetwork } from '../src/routing/network';
import { roadLineSource, routeShape } from '../src/routing/shape';
import type { RoadLine } from '../src/routing/snap';
import { collectIndex } from '../src/search/places';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, F_ROAD_DETAILED, hasRealData } from './helpers/paths';

describe('routeShape', () => {
  // Nodes a (0) and b (40) joined by one edge of road NET 7, drawn as two lines that meet at x=20
  // (not a node): the second one runs backwards. A third line of another road also touches x=20.
  const gb = new GraphBuilder();
  const a = gb.node(0, 0);
  const b = gb.node(40, 0);
  gb.edge(a, b, 100, 36, 0, null, { tile: 0, net: 7 });
  gb.edge(b, a, 100, 36, 0, null, { tile: 0, net: 7 });
  const g = gb.build();
  const lineList: RoadLine[] = [
    { tile: 0, net: 7, cls: 0, coords: [[0, 0], [10, 5], [20, 5]], name: 'F26', type: 0x12 },
    { tile: 0, net: 7, cls: 0, coords: [[40, 0], [30, 5], [20, 5]], name: 'F26', type: 0x12 },
    { tile: 0, net: 9, cls: 0, coords: [[20, 5], [20, 50]] },
  ];
  const lines = async () => lineList;
  const units = (c: Array<[number, number]>) => c.map(([x, y]) => [Math.round(x * UNITS_PER_DEG), Math.round(y * UNITS_PER_DEG)]);
  const route = (nodes: number[]): Route => ({ coords: [], nodes, edges: [g.edgeStart[nodes[0]]], metres: 100, seconds: 10 });

  test('an edge whose road is split into several lines follows them, either way round', async () => {
    const idx = new NodeIndex(g);
    const ab = await routeShape(g, idx, route([a, b]), lines);
    expect(units(ab.coords)).toEqual([[0, 0], [10, 5], [20, 5], [30, 5], [40, 0]]);
    // One road stretch, with the road's name and type and the edge's time (100 m at 36 km/h).
    expect(ab.segs).toEqual([{ start: 0, name: 'F26', type: 0x12, junction: false, seconds: 10 }]);
    expect(units((await routeShape(g, idx, route([b, a]), lines)).coords)).toEqual([[40, 0], [30, 5], [20, 5], [10, 5], [0, 0]]);
  });

  test('an edge without matching lines is drawn straight', async () => {
    expect(units((await routeShape(g, new NodeIndex(g), route([a, b]), async () => [])).coords)).toEqual([[0, 0], [40, 0]]);
  });
});

describe.skipIf(!hasRealData)('routeShape on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    map = await GarminMap.open(src);
  }, 300_000);
  afterAll(() => src.close());

  test('the Reykjavík → Selfoss route is drawn along road-line vertices', async () => {
    const { roads } = await collectIndex(map);
    const g = await buildNetwork(map, roads);
    const idx = new NodeIndex(g);
    const from = idx.nearest(-21.94, 64.146, 2000)!.node;
    const to = idx.nearest(-21.0, 63.936, 2000)!.node;
    const route = fastestRoute(g, from, to, true)!;
    expect(route).not.toBeNull();

    // Collect every road-line vertex of every subdivision the decode function is asked for, so we
    // can check the shape stays on the decoded road lines (per the task's real-data test contract).
    const vertices = new Set<string>();
    const decode = async (tile: MapTile, sd: Subdivision): Promise<RawObject[]> => {
      const objs = await map.decode(tile, sd);
      for (const o of objs) {
        if (o.kind === 'line' && o.labelSrc === 'net') for (const [x, y] of pairs(o.xy)) vertices.add(`${x},${y}`);
      }
      return objs;
    };

    const shape = (await routeShape(g, idx, route, roadLineSource(map, decode, roads))).coords;
    expect(shape.length).toBeGreaterThan(route.nodes.length);

    const toUnits = ([lon, lat]: [number, number]): [number, number] => [Math.round(lon * UNITS_PER_DEG), Math.round(lat * UNITS_PER_DEG)];
    const startNode = route.nodes[0];
    const endNode = route.nodes[route.nodes.length - 1];
    const [sx, sy] = toUnits(shape[0]);
    const [ex, ey] = toUnits(shape[shape.length - 1]);
    expect(metresBetween(sx, sy, g.nodeX[startNode], g.nodeY[startNode])).toBeLessThan(1);
    expect(metresBetween(ex, ey, g.nodeX[endNode], g.nodeY[endNode])).toBeLessThan(1);

    let onRoad = 0;
    for (const p of shape) {
      const [x, y] = toUnits(p);
      if (vertices.has(`${x},${y}`)) onRoad++;
    }
    const pct = (100 * onRoad) / shape.length;
    console.log(`shape points on a decoded road-line vertex: ${onRoad}/${shape.length} (${pct.toFixed(1)}%)`);
    expect(pct).toBeGreaterThanOrEqual(95);
  }, 300_000);

  test('Reykjavík → Sprengisandur (roads drawn as many lines) is drawn along its roads, not in straight cuts', async () => {
    const { roads } = await collectIndex(map);
    const g = await buildNetwork(map, roads);
    const idx = new NodeIndex(g);
    const route = fastestRoute(g, idx.nearest(-21.92, 64.13, 2000)!.node, idx.nearest(-19.35, 64.81, 2000)!.node, true)!;
    const decode = (tile: MapTile, sd: Subdivision) => map.decode(tile, sd);
    const shape = (await routeShape(g, idx, route, roadLineSource(map, decode, roads))).coords;
    let drawn = 0;
    for (let i = 1; i < shape.length; i++) drawn += metresBetween(shape[i - 1][0] * UNITS_PER_DEG, shape[i - 1][1] * UNITS_PER_DEG, shape[i][0] * UNITS_PER_DEG, shape[i][1] * UNITS_PER_DEG);
    console.log(`drawn ${(drawn / 1000).toFixed(1)} km of ${(route.metres / 1000).toFixed(1)} km`);
    // Straight cuts across bends make the drawn line clearly shorter than the road.
    expect(drawn / route.metres).toBeGreaterThan(0.97);
  }, 300_000);
});

describe.skipIf(!hasRealData || !existsSync(F_ROAD_DETAILED))('fastestRoute on real data (F-Road Detailed)', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  let g: Awaited<ReturnType<typeof buildNetwork>>;
  let idx: NodeIndex;
  beforeAll(async () => {
    src = await nodeSource(F_ROAD_DETAILED);
    map = await GarminMap.open(src);
    const { roads } = await collectIndex(map);
    g = await buildNetwork(map, roads);
    idx = new NodeIndex(g);
  }, 300_000);
  afterAll(() => src.close());

  test('Reykjavík → Akureyri: found, 380-395 km', () => {
    const from = idx.nearest(-21.94, 64.146, 2000)!.node;
    const to = idx.nearest(-18.09, 65.68, 2000)!.node;
    const route = fastestRoute(g, from, to, true);
    expect(route).not.toBeNull();
    const km = route!.metres / 1000;
    console.log(`Reykjavík → Akureyri: ${km.toFixed(1)} km, ${(route!.seconds / 60).toFixed(0)} min`);
    expect(km).toBeGreaterThanOrEqual(380);
    expect(km).toBeLessThanOrEqual(395);
  });

  test('Selfoss → Landmannalaugar: found with F-roads in 2.0-3.3 h; null without', () => {
    const from = idx.nearest(-21.0, 63.936, 2000)!.node;
    const to = idx.nearest(-19.06, 63.991, 2000)!.node;
    const withFRoads = fastestRoute(g, from, to, true);
    expect(withFRoads).not.toBeNull();
    const hours = withFRoads!.seconds / 3600;
    console.log(`Selfoss → Landmannalaugar: ${(withFRoads!.metres / 1000).toFixed(1)} km, ${hours.toFixed(2)} h (F-roads allowed)`);
    expect(hours).toBeGreaterThanOrEqual(2.0);
    expect(hours).toBeLessThanOrEqual(3.3);

    const withoutFRoads = fastestRoute(g, from, to, false);
    expect(withoutFRoads).toBeNull();
  });

  test('Húsavík → Dettifoss: found', () => {
    const from = idx.nearest(-17.34, 66.045, 2000)!.node;
    const to = idx.nearest(-16.39, 65.81, 2000)!.node;
    const route = fastestRoute(g, from, to, true);
    expect(route).not.toBeNull();
    console.log(`Húsavík → Dettifoss: ${(route!.metres / 1000).toFixed(1)} km, ${(route!.seconds / 60).toFixed(0)} min`);
  });
});
