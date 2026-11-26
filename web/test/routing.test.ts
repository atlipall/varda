import { describe, expect, test } from 'vitest';
import { canArrive, canLeave, EDGE_FROAD, fastestRoute, GraphBuilder, hasNormalRoad, NodeIndex, UNITS_PER_DEG } from '../src/routing/graph';
import { ROUTE_PREFERENCE } from '../src/routing/plan';
import { addTileNetwork, nodUnitM } from '../src/routing/network';
import type { NodNode } from '../src/routing/nod';
import { RoadClassCollector, roadClass } from '../src/routing/roadClass';

const U = (deg: number) => Math.round(deg * UNITS_PER_DEG);

describe('road classes', () => {
  test('F-roads by type or name, tracks, rough tracks, everything else normal', () => {
    expect(roadClass(0x12, null)).toBe(1);
    expect(roadClass(0x0d, 'F26')).toBe(1);
    expect(roadClass(0x0a, 'F 208')).toBe(1);
    expect(roadClass(0x11, null)).toBe(2);
    expect(roadClass(0x13, 'VATNAHJALLALEIÐ')).toBe(3);
    expect(roadClass(0x01, 'Hringvegur')).toBe(0);
    expect(roadClass(0x06, 'Fálkagata')).toBe(0); // starts with F but isn't a road number
    expect(roadClass(0x04, ['Fjallabaksleið nyrðri', 'F208'])).toBe(1); // the number as a second label
    expect(roadClass(0x04, ['Hringvegur', '1'])).toBe(0);
    expect(roadClass(0x04, [])).toBe(0);
  });

  test('the collector keeps one entry per NET offset per tile and leaves out normal roads', () => {
    const c = new RoadClassCollector();
    c.add('t1', 5, 1);
    c.add('t1', 5, 1); // the same road drawn as a second line
    c.add('t1', 6, 0);
    c.add('t1', 8, 2);
    c.add('t2', 5, 3); // NET offsets are per tile
    expect(c.roads).toEqual({ t1: [[5, 1], [8, 2]], t2: [[5, 3]] });
  });
});

describe('NOD network', () => {
  /** Nodes of one tile: a–b on a one-way highway (NET 1), b–c on an F-road (NET 2). */
  function tile(): Map<number, NodNode> {
    const n = (offset: number, lon: number, lat: number, arcs: NodNode['arcs']): NodNode => ({ offset, flags: 0x40, x: U(lon), y: U(lat), arcs, end: 0 });
    const arc = (target: number, length: number, forward: boolean, net: number, info: number) => ({ target, length, forward, direct: true, net, info, access: 0 });
    return new Map([
      [0, n(0, -21.0, 64.0, [arc(10, 1000, true, 1, 0x08 | 4)])],
      [10, n(10, -20.95, 64.0, [arc(0, 1000, false, 1, 0x08 | 4), arc(20, 500, true, 2, 0x20 | 3), { ...arc(30, 900, true, 2, 3), direct: false }])],
      [20, n(20, -20.95, 64.01, [arc(10, 500, false, 2, 3)])],
      [30, n(30, -20.95, 64.02, [])],
    ]);
  }
  const build = () => {
    const b = new GraphBuilder();
    addTileNetwork(b, tile(), new Map([[2, 1]]), 3);
    return b.build();
  };

  test('direct arcs become edges: length × 2.4 m, capped speed, F-road flag, road identity; one-way against is dropped', () => {
    const g = build();
    const idx = new NodeIndex(g);
    const a = idx.nearest(-21.0, 64.0, 100)!.node;
    const bN = idx.nearest(-20.95, 64.0, 100)!.node;
    const c = idx.nearest(-20.95, 64.01, 100)!.node;
    expect(fastestRoute(g, a, bN, true)!.metres).toBeCloseTo(2400, 3);
    expect(fastestRoute(g, bN, a, true)).toBeNull(); // one-way
    const f = fastestRoute(g, bN, c, true)!;
    expect(f.metres).toBeCloseTo(1200, 3);
    expect(f.seconds).toBeCloseTo(1200 / (40 / 3.6), 1); // speed class 3 (60 km/h), capped at 40 on an F-road
    expect(g.edgeFlags[f.edges[0]] & EDGE_FROAD).toBe(EDGE_FROAD);
    expect([g.edgeTile[f.edges[0]], g.edgeNet[f.edges[0]]]).toEqual([3, 2]);
    // The road's rank (Table A bits 4-6).
    expect(g.edgeRank[f.edges[0]]).toBe(2);
    expect(fastestRoute(g, bN, c, false)).toBeNull(); // F-roads not allowed
    expect(g.edgeTo.length).toBe(3); // a→b, b→c, c→b (indirect b→d skipped, b→a one-way)
  });

  test('arcs of roads closed to cars (Table A access bit 0x01) are left out', () => {
    const t = tile();
    t.get(0)!.arcs[0].access = 0x01; // a–b: a footpath on an OSM-based map
    t.get(10)!.arcs[0].access = 0x21; // b–a: no cars, no bikes
    const b = new GraphBuilder();
    addTileNetwork(b, t, new Map([[2, 1]]), 3);
    const g = b.build();
    expect(g.edgeTo.length).toBe(2); // b→c and c→b only
    // a is on the footpath only: no node for it (big OSM maps have a million such nodes).
    expect(g.nodeX.length).toBe(2);
    expect(new NodeIndex(g).nodeAt(U(-21.0), U(64.0))).toBe(-1);
  });

  test('nodes without a usable arc (only indirect arcs, or none) are left out', () => {
    expect(build().nodeX.length).toBe(3); // a, b, c; not d (reached only by an indirect arc)
  });

  test('many nodes: each found by its position, the same position given once', () => {
    const b = new GraphBuilder();
    const N = 100_000;
    const pos = (i: number): [number, number] => [((i * 7919) % 200_003) - 100_000, -((i * 104_729) % 300_007)];
    const ids: number[] = [];
    for (let i = 0; i < N; i++) ids.push(b.node(...pos(i)));
    for (let i = 0; i < N; i++) expect(b.node(...pos(i))).toBe(ids[i]);
    for (let i = 0; i + 1 < N; i++) b.edge(ids[i], ids[i + 1], 1, 50, 0);
    const g = b.build();
    expect(g.nodeX.length).toBe(new Set(ids).size);
    const idx = new NodeIndex(g);
    for (let i = 0; i < N; i += 97) expect(idx.nodeAt(...pos(i))).toBe(ids[i]);
    expect(idx.nodeAt(100_001, 5)).toBe(-1);
    expect(fastestRoute(g, ids[0], ids[50], true)!.edges.length).toBe(50);
  });

  test('the length unit doubles per step of header flag bits 5-7 (GPSmap.is 0x203, mkgmap OSM maps 0x227)', () => {
    expect(nodUnitM(0x203)).toBeCloseTo(2.4, 9);
    expect(nodUnitM(0x201)).toBeCloseTo(2.4, 9);
    expect(nodUnitM(0x227)).toBeCloseTo(4.8, 9);
    // mkgmap always sets 0x0004 (bits 2-4 are not the multiplier): shift 0 is 0x207, shift 2 is 0x247.
    expect(nodUnitM(0x207)).toBeCloseTo(2.4, 9);
    expect(nodUnitM(0x247)).toBeCloseTo(9.6, 9);
    expect(nodUnitM(0x327)).toBeCloseTo(4.8, 9); // 0x100: drive on the left
    const b = new GraphBuilder();
    addTileNetwork(b, tile(), new Map([[2, 1]]), 3, nodUnitM(0x227));
    const g = b.build();
    const idx = new NodeIndex(g);
    const r = fastestRoute(g, idx.nearest(-21.0, 64.0, 100)!.node, idx.nearest(-20.95, 64.0, 100)!.node, true)!;
    expect(r.metres).toBeCloseTo(4800, 3);
  });

  test('nearest(…, accept) skips nodes the predicate rejects; hasNormalRoad spots F-road-only nodes', () => {
    const g = build();
    const idx = new NodeIndex(g);
    const c = idx.nearest(-20.95, 64.01, 5000)!.node;
    expect(hasNormalRoad(g, c)).toBe(false); // only the F-road back to b
    const snapped = idx.nearest(-20.95, 64.01, 5000, (v) => hasNormalRoad(g, v))!;
    expect(snapped.node).toBe(idx.nearest(-21.0, 64.0, 100)!.node); // a: b's only normal edge is inbound
    expect(idx.nearest(-20.95, 64.01, 100, (v) => hasNormalRoad(g, v))).toBeNull();
  });

  test('edge tile indexes above 255 are kept', () => {
    const b = new GraphBuilder();
    b.edge(b.node(0, 0), b.node(10, 0), 10, 50, 0, null, { tile: 300, net: 7 });
    expect(b.build().edgeTile[0]).toBe(300);
  });

  test('canLeave / canArrive: usable outgoing / incoming edges, with and without F-roads', () => {
    const g = build();
    const idx = new NodeIndex(g);
    const a = idx.nearest(-21.0, 64.0, 100)!.node;
    const bN = idx.nearest(-20.95, 64.0, 100)!.node;
    const c = idx.nearest(-20.95, 64.01, 100)!.node;
    expect([canLeave(g, a, false), canArrive(g, a, true)]).toEqual([true, false]); // one-way start
    expect([canLeave(g, bN, false), canArrive(g, bN, false)]).toEqual([false, true]); // only the F-road leaves b
    expect([canArrive(g, c, false), canArrive(g, c, true)]).toEqual([false, true]);
    expect(idx.nodeAt(g.nodeX[c], g.nodeY[c])).toBe(c);
    expect(idx.nodeAt(g.nodeX[c] + 1, g.nodeY[c])).toBe(-1);
  });
});

describe('fastestRoute with several sources and targets', () => {
  // a — b — c — d in a row, 1000 m each at 36 km/h (100 s), both ways.
  const line = () => {
    const b = new GraphBuilder();
    const n = [0, 0.01, 0.02, 0.03].map((lon) => b.node(U(lon), 0));
    for (let i = 0; i < 3; i++) {
      b.edge(n[i], n[i + 1], 1000, 36, 0);
      b.edge(n[i + 1], n[i], 1000, 36, 0);
    }
    return { g: b.build(), n };
  };

  test('counts the sources\' and targets\' costs and picks the best total', () => {
    const { g, n } = line();
    // From a (cost 500) or b (cost 10); to d (extra 0) or c (extra 50): b → c + 50 = 160 wins
    // over b → d = 210 and a → … ≥ 600.
    const r = fastestRoute(g, [{ node: n[0], cost: 500 }, { node: n[1], cost: 10 }], [{ node: n[3], cost: 0 }, { node: n[2], cost: 50 }], true)!;
    expect(r.nodes).toEqual([n[1], n[2]]);
    expect(r.seconds).toBeCloseTo(160, 6);
    expect(r.metres).toBeCloseTo(1000, 6);
    // A costly target near by loses to a cheap one further on: b → d (200) beats b → c (100 + 150).
    const far = fastestRoute(g, [{ node: n[1], cost: 0 }], [{ node: n[2], cost: 150 }, { node: n[3], cost: 0 }], true)!;
    expect(far.nodes).toEqual([n[1], n[2], n[3]]);
    expect(far.seconds).toBeCloseTo(200, 6);
  });

  test('preferring F-roads picks a slower F-road when its weighted time wins, and reports the real time', () => {
    // a → b directly on a normal road (1000 m at 36 km/h: 100 s), or a → c → b on F-roads
    // (2 × 700 m at 36 km/h: 140 s, weighted 84 s).
    const b = new GraphBuilder();
    const [a, bb, c] = [b.node(0, 0), b.node(U(0.01), 0), b.node(U(0.005), U(0.003))];
    b.edge(a, bb, 1000, 36, 0);
    b.edge(a, c, 700, 36, EDGE_FROAD);
    b.edge(c, bb, 700, 36, EDGE_FROAD);
    const g = b.build();
    const plain = fastestRoute(g, a, bb, true)!;
    expect(plain.nodes).toEqual([a, bb]);
    expect(plain.seconds).toBeCloseTo(100, 6);
    const preferred = fastestRoute(g, a, bb, true, 0.6)!;
    expect(preferred.nodes).toEqual([a, c, bb]);
    expect(preferred.seconds).toBeCloseTo(140, 6);
    expect(preferred.metres).toBeCloseTo(1400, 6);
  });

  test('keeping to the main road: a road change costs extra, so a slightly shorter zig-zag through side streets loses', () => {
    // a → m → b along one main road (NET 1, 2 × 500 m), or a → s1 → s2 → b on three side streets
    // (NETs 2, 3, 4, 3 × 320 m: 4 s quicker at 36 km/h, but three more road changes).
    const b = new GraphBuilder();
    const [a, m, bb, s1, s2] = [b.node(0, 0), b.node(U(0.004), 0), b.node(U(0.008), 0), b.node(U(0.0027), U(0.0005)), b.node(U(0.0053), U(0.0005))];
    const road = (net: number) => ({ tile: 1, net });
    b.edge(a, m, 500, 36, 0, null, road(1));
    b.edge(m, bb, 500, 36, 0, null, road(1));
    b.edge(a, s1, 320, 36, 0, null, road(2));
    b.edge(s1, s2, 320, 36, 0, null, road(3));
    b.edge(s2, bb, 320, 36, 0, null, road(4));
    const g = b.build();
    expect(fastestRoute(g, a, bb, true)!.nodes).toEqual([a, s1, s2, bb]);
    const kept = fastestRoute(g, a, bb, true, 1, ROUTE_PREFERENCE)!;
    expect(kept.nodes).toEqual([a, m, bb]);
    expect(kept.seconds).toBeCloseTo(100, 6); // the real time, without the preference's costs
  });

  test('crossing a map tile boundary (a new NET record for the same road) is not a road change', () => {
    // a → m → b on a road that changes tile at m (100 s), or a → b on one road at 102 s.
    const b = new GraphBuilder();
    const [a, m, bb] = [b.node(0, 0), b.node(U(0.004), 0), b.node(U(0.008), 0)];
    b.edge(a, m, 500, 36, 0, null, { tile: 1, net: 1 });
    b.edge(m, bb, 500, 36, 0, null, { tile: 2, net: 7 });
    b.edge(a, bb, 1020, 36, 0, null, { tile: 1, net: 2 });
    const g = b.build();
    expect(fastestRoute(g, a, bb, true, 1, ROUTE_PREFERENCE)!.nodes).toEqual([a, m, bb]);
  });

  test('a minor road counts for more than a main road of the same speed; F-roads keep their own weight', () => {
    // a → b on a minor road (rank 0, 1000 m) or a → c → b on a main road (rank 4, 2 × 550 m), all 36 km/h.
    const b = new GraphBuilder();
    const [a, bb, c] = [b.node(0, 0), b.node(U(0.008), 0), b.node(U(0.004), U(0.002))];
    b.edge(a, bb, 1000, 36, 0, null, { tile: 1, net: 1 }, 0);
    b.edge(a, c, 550, 36, 0, null, { tile: 1, net: 2 }, 4);
    b.edge(c, bb, 550, 36, 0, null, { tile: 1, net: 2 }, 4);
    const g = b.build();
    expect(fastestRoute(g, a, bb, true)!.nodes).toEqual([a, bb]);
    expect(fastestRoute(g, a, bb, true, 1, ROUTE_PREFERENCE)!.nodes).toEqual([a, c, bb]);
  });

  test('a node that is both a source and a target gives an empty route', () => {
    const { g, n } = line();
    const r = fastestRoute(g, [{ node: n[1], cost: 5 }], [{ node: n[1], cost: 7 }], true)!;
    expect(r.edges).toEqual([]);
    expect(r.seconds).toBeCloseTo(12, 6);
  });
});
