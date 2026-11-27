import { describe, expect, test } from 'vitest';
import { EDGE_FROAD, GraphBuilder, metresBetween, NodeIndex, UNITS_PER_DEG, type RoadGraph } from '../src/routing/graph';
import { offRoadText, routeMessage } from '../src/app/routeMessage';
import { planRoute, type RouteReply } from '../src/routing/plan';
import type { RoadClass } from '../src/routing/roadClass';
import type { RoadLine, RoadLines } from '../src/routing/snap';

const U = (deg: number) => Math.round(deg * UNITS_PER_DEG);
/** Metres between two [lon, lat] points. */
const m = (a: [number, number], b: [number, number]) => metresBetween(U(a[0]), U(a[1]), U(b[0]), U(b[1]));

type Road = { from: number; to: number; net: number; cls?: RoadClass; oneWay?: boolean; kmh?: number; metres?: number };

/**
 * A synthetic network on the equator: nodes at the given longitudes (lat 0), one road line per
 * road with an extra vertex halfway (not a node), and graph edges tagged with the road's NET offset
 * (both ways unless one-way). Edge lengths default to 1000 m, speeds to 36 km/h (10 m/s).
 */
function network(lons: number[], roads: Road[]): { graph: RoadGraph; index: NodeIndex; lines: RoadLines; nodes: number[] } {
  const gb = new GraphBuilder();
  const nodes = lons.map((lon) => gb.node(U(lon), 0));
  const lineList: RoadLine[] = [];
  for (const r of roads) {
    const cls = r.cls ?? 0;
    const flags = cls ? EDGE_FROAD : 0;
    const road = { tile: 0, net: r.net };
    gb.edge(nodes[r.from], nodes[r.to], r.metres ?? 1000, r.kmh ?? 36, flags, null, road);
    if (!r.oneWay) gb.edge(nodes[r.to], nodes[r.from], r.metres ?? 1000, r.kmh ?? 36, flags, null, road);
    const mid = U((lons[r.from] + lons[r.to]) / 2);
    lineList.push({ tile: 0, net: r.net, cls, coords: [[U(lons[r.from]), 0], [mid, 0], [U(lons[r.to]), 0]] });
  }
  const graph = gb.build();
  return { graph, index: new NodeIndex(graph), lines: async () => lineList, nodes };
}

const noShape = async (): Promise<Array<[number, number]>> => {
  throw new Error('shape should not have been called');
};
/** Shape callback: the route's nodes as [lon, 0]. */
const nodeShape = (graph: RoadGraph) => async (r: { nodes: number[] }) => r.nodes.map((n) => [graph.nodeX[n] / UNITS_PER_DEG, 0] as [number, number]);

function ok(r: RouteReply): Extract<RouteReply, { status: 'ok' }> {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
  return r;
}

describe('planRoute', () => {
  test('ends between junctions snap mid-road; the partial stretches count in distance and time', async () => {
    // a — b — c — d, normal roads; start halfway a–b, destination halfway c–d.
    const { graph, index, lines } = network([0, 0.01, 0.02, 0.03], [{ from: 0, to: 1, net: 1 }, { from: 1, to: 2, net: 2 }, { from: 2, to: 3, net: 3 }]);
    const r = ok(await planRoute(graph, index, lines, [0.005, 0], [0.025, 0], true, nodeShape(graph)));
    const half = m([0.005, 0], [0.01, 0]);
    expect(r.metres).toBeCloseTo(half + 1000 + half, 3);
    expect(r.seconds).toBeCloseTo((half + 1000 + half) / 10, 3);
    // Partial line from the start point to b, the graph part b → c, then c to the destination point.
    expect(r.coords[0][0]).toBeCloseTo(0.005, 6);
    expect(r.coords.map((p) => Math.round(p[0] * 1000))).toEqual([5, 10, 20, 25]);
    expect(r.offRoadStart).toBeNull();
    expect(r.offRoadEnd).toBeNull();
  });

  test('a one-way road is used only its way, at the start and at the destination', async () => {
    // c — a two-way, a → b one-way (NET 2).
    const net = () => network([-0.01, 0, 0.01], [{ from: 0, to: 1, net: 1 }, { from: 1, to: 2, net: 2, oneWay: true }]);
    // Destination halfway a → b: reached through a (the edge into the stretch), never through b.
    const { graph, index, lines } = net();
    const r = ok(await planRoute(graph, index, lines, [-0.01, 0], [0.005, 0], true, nodeShape(graph)));
    expect(r.metres).toBeCloseTo(1000 + m([0, 0], [0.005, 0]), 3);
    expect(r.coords.map((p) => Math.round(p[0] * 1000))).toEqual([-10, 0, 5]);
    // Start halfway a → b: only onwards to b, which is a dead end, so there's no way back to c.
    await expect(planRoute(graph, index, lines, [0.005, 0], [-0.01, 0], true, noShape)).resolves.toEqual({ status: 'no-route-any' });
  });

  test('with F-roads not allowed, F-road lines are ignored when snapping', async () => {
    // a — b normal (NET 1); b — c an F-road (NET 2). A point just off the F-road snaps to it with
    // F-roads allowed, and to the normal road 1.1 km away (an off-road leg) without.
    const { graph, index, lines } = network([0, 0.01, 0.02], [{ from: 0, to: 1, net: 1 }, { from: 1, to: 2, net: 2, cls: 1 }]);
    const near: [number, number] = [0.02, 0.0001];
    const withF = ok(await planRoute(graph, index, lines, [0, 0], near, true, nodeShape(graph)));
    expect(withF.offRoadEnd).toBeNull();
    const without = ok(await planRoute(graph, index, lines, [0, 0], near, false, nodeShape(graph)));
    expect(without.offRoadEndM).toBeCloseTo(m([0.01, 0], near), 1);
    expect(without.offRoadEnd).toEqual([[0.01, 0], near].map(([x, y]) => [expect.closeTo(x, 4), expect.closeTo(y, 4)]));
    expect(without.metres).toBeCloseTo(m([0, 0], [0.01, 0]), 3); // straight along a–b's line
  });

  test('no road line to snap to: falls back to the nearest node', async () => {
    const { graph, index } = network([0, 0.01], [{ from: 0, to: 1, net: 1 }]);
    const none: RoadLines = async () => [];
    const r = ok(await planRoute(graph, index, none, [0.0001, 0], [0.0099, 0], true, nodeShape(graph)));
    expect(r.metres).toBeCloseTo(1000, 3);
    expect(r.coords).toEqual([[0, 0], [expect.closeTo(0.01, 4), 0]]);
  });

  test('a line whose road has no nodes on it falls back to the nearest node that can be left / reached', async () => {
    // a → b one-way (NET 1). A stray line (NET 9) near a has no nodes; a start near b can't use b
    // (nothing leaves it), so the fallback start is a.
    const { graph, index } = network([0, 0.01], [{ from: 0, to: 1, net: 1, oneWay: true }]);
    const stray: RoadLine = { tile: 0, net: 9, cls: 0, coords: [[U(0.0098), U(0.00001)], [U(0.0099), U(0.00001)]] };
    const lines: RoadLines = async () => [stray];
    const r = ok(await planRoute(graph, index, lines, [0.0099, 0], [0.0099, 0.0003], true, nodeShape(graph)));
    expect(r.coords.map((p) => Math.round(p[0] * 100))).toEqual([0, 1]);
    expect(r.offRoadStartM).toBeGreaterThan(1000);
  });

  test('an off-road leg is reported beyond 30 m from the road and not below', async () => {
    const { graph, index, lines } = network([0, 0.01, 0.02], [{ from: 0, to: 1, net: 1 }, { from: 1, to: 2, net: 2 }]);
    const far = ok(await planRoute(graph, index, lines, [0.002, -0.0005], [0.015, 0.0005], true, nodeShape(graph)));
    expect(far.offRoadStartM).toBeCloseTo(m([0.002, 0], [0.002, -0.0005]), 1);
    expect(far.offRoadStart![0]).toEqual([0.002, -0.0005]);
    expect(far.offRoadStart![1][0]).toBeCloseTo(0.002, 4); // map units are ~2.4 m
    expect(far.offRoadEnd![1]).toEqual([0.015, 0.0005]);
    // Distance counts the road only.
    expect(far.metres).toBeCloseTo(m([0.002, 0], [0.01, 0]) + m([0.01, 0], [0.015, 0]), 3);
    const near = ok(await planRoute(graph, index, lines, [0.002, -0.0002], [0.015, 0.0002], true, nodeShape(graph)));
    expect(near.offRoadStart).toBeNull();
    expect(near.offRoadEnd).toBeNull();
    expect(near.offRoadStartM).toBe(0);
  });

  test('both ends on the same stretch: straight along the road, or around when it is one-way', async () => {
    const two = network([0, 0.01], [{ from: 0, to: 1, net: 1 }]);
    const r = ok(await planRoute(two.graph, two.index, two.lines, [0.002, 0], [0.008, 0], true, noShape));
    expect(r.metres).toBeCloseTo(m([0.002, 0], [0.008, 0]), 3);
    expect(r.coords.map((p) => Math.round(p[0] * 1000))).toEqual([2, 5, 8]);
    // One road stretch with the whole time (so a waypoint route joined from such a leg keeps every
    // leg's stretches, and turn-by-turn its instructions).
    expect(r.segs).toEqual([{ start: 0, name: null, type: 0, junction: false, seconds: r.seconds }]);
    const back = ok(await planRoute(two.graph, two.index, two.lines, [0.008, 0], [0.002, 0], true, noShape));
    expect(back.coords.map((p) => Math.round(p[0] * 1000))).toEqual([8, 5, 2]);
    // One-way a → b: going back needs another way round (none here).
    const one = network([0, 0.01], [{ from: 0, to: 1, net: 1, oneWay: true }]);
    await expect(planRoute(one.graph, one.index, one.lines, [0.008, 0], [0.002, 0], true, noShape)).resolves.toEqual({ status: 'no-route-any' });
  });

  test('same-place: the chosen points are within 5 m of each other', async () => {
    const { graph, index, lines } = network([0, 0.01], [{ from: 0, to: 1, net: 1 }]);
    await expect(planRoute(graph, index, lines, [0.005, 0.0002], [0.00502, 0.0002], true, noShape)).resolves.toEqual({ status: 'same-place' });
  });

  test('places apart that join the road at the same point: only the off-road legs', async () => {
    // 440 m either side of the road, both straight across from the same road point.
    const { graph, index, lines } = network([0, 0.01], [{ from: 0, to: 1, net: 1 }]);
    const r = ok(await planRoute(graph, index, lines, [0.005, 0.004], [0.005, -0.004], true, noShape));
    expect(r.metres).toBe(0);
    expect(r.seconds).toBe(0);
    expect(r.coords).toHaveLength(2);
    expect(r.offRoadStartM).toBeCloseTo(m([0.005, 0], [0.005, 0.004]), 0);
    expect(r.offRoadEndM).toBeCloseTo(m([0.005, 0], [0.005, -0.004]), 0);
  });

  test('a road that runs out short of a node one way still joins at the node the other way', async () => {
    // c — a (NET 2) and a → b one-way (NET 1). NET 1's only line runs from a to halfway and stops
    // (no node, no next line): the stretch keeps its side towards a, with a's edges for direction.
    const gb = new GraphBuilder();
    const [c, a, b] = [-0.01, 0, 0.01].map((lon) => gb.node(U(lon), 0));
    for (const [x, y] of [[c, a], [a, c]]) gb.edge(x, y, 1000, 36, 0, null, { tile: 0, net: 2 });
    gb.edge(a, b, 1000, 36, 0, null, { tile: 0, net: 1 });
    const graph = gb.build();
    const index = new NodeIndex(graph);
    const lineList: RoadLine[] = [
      { tile: 0, net: 2, cls: 0, coords: [[U(-0.01), 0], [U(0), 0]] },
      { tile: 0, net: 1, cls: 0, coords: [[U(0), 0], [U(0.005), 0]] },
    ];
    const lines: RoadLines = async () => lineList;
    // Destination at 0.004: reached from a along the one-way road.
    const to = ok(await planRoute(graph, index, lines, [-0.01, 0], [0.004, 0], true, nodeShape(graph)));
    expect(to.metres).toBeCloseTo(1000 + m([0, 0], [0.004, 0]), 3);
    expect(to.offRoadEnd).toBeNull();
    expect(to.coords.map((p) => Math.round(p[0] * 1000))).toEqual([-10, 0, 4]);
    // Start at 0.004: the one-way road can't be driven back to a, so the start joins the next
    // nearest road, c — a, at a (445 m off-road), and goes along it to c.
    const from = ok(await planRoute(graph, index, lines, [0.004, 0], [-0.01, 0], true, nodeShape(graph)));
    expect(from.offRoadStartM).toBeCloseTo(m([0, 0], [0.004, 0]), 0);
    expect(from.metres).toBeCloseTo(m([0, 0], [-0.01, 0]), 3);
  });

  test('no-road-start / no-road-end: nothing within 50 km', async () => {
    const { graph, index, lines } = network([0, 0.01], [{ from: 0, to: 1, net: 1 }]);
    await expect(planRoute(graph, index, lines, [0.5, 0], [0.01, 0], true, noShape)).resolves.toEqual({ status: 'no-road-start' });
    await expect(planRoute(graph, index, lines, [0, 0], [0, 0.46], true, noShape)).resolves.toEqual({ status: 'no-road-end' });
    // 40 km off still snaps (with an off-road leg).
    const r = ok(await planRoute(graph, index, lines, [0, 0], [0.005, 0.36], true, nodeShape(graph)));
    expect(r.offRoadEndM).toBeGreaterThan(39_000);
  });

  test('no-route: F-roads not allowed and only an F-road within reach, or only reachable over one', async () => {
    const { graph, index, lines } = network([0, 0.01, 0.02], [{ from: 0, to: 1, net: 1 }, { from: 1, to: 2, net: 2, cls: 1 }]);
    // Destination halfway along the F-road: reachable only over it.
    const r = ok(await planRoute(graph, index, lines, [0, 0], [0.015, 0], true, nodeShape(graph)));
    expect(r.metres).toBeGreaterThan(1000);
    // Without F-roads the destination snaps to the normal road (b), so a route is found with an
    // off-road leg. With the only road an F-road, it's 'no-route'.
    const fOnly = network([0, 0.01], [{ from: 0, to: 1, net: 1, cls: 1 }]);
    await expect(planRoute(fOnly.graph, fOnly.index, fOnly.lines, [0.002, 0], [0.008, 0], false, noShape)).resolves.toEqual({ status: 'no-route' });
  });

  test('no-routing-data: a map without NOD subfiles gives an empty graph', async () => {
    const graph = new GraphBuilder().build();
    await expect(planRoute(graph, new NodeIndex(graph), async () => [], [0, 0], [0.01, 0], true, noShape)).resolves.toEqual({ status: 'no-routing-data' });
  });
});

describe('routeMessage', () => {
  test('no road at the start: names your position, the map centre or the chosen point', () => {
    expect(routeMessage({ status: 'no-road-start' }, 'gps')).toBe('No road near your position');
    expect(routeMessage({ status: 'no-road-start' }, 'centre')).toBe('No road near the map centre');
    expect(routeMessage({ status: 'no-road-start' }, 'chosen')).toBe('No road near the chosen point');
  });

  test('each failure has its message', () => {
    expect(routeMessage({ status: 'no-road-end' }, 'gps')).toBe('No road within 50 km of the destination');
    expect(routeMessage({ status: 'no-route' }, 'gps')).toBe('No route without F-roads and tracks: turn the switch on to allow them');
    expect(routeMessage({ status: 'no-route-any' }, 'gps')).toBe('No route by road between these places');
    expect(routeMessage({ status: 'no-routing-data' }, 'gps')).toBe('This map has no routing data');
    expect(routeMessage({ status: 'same-place' }, 'gps')).toBe("You're already there");
  });

  test('errors show their message, not "Error: …"', () => {
    expect(routeMessage({ status: 'error', err: new Error('Routing is unavailable') }, 'gps')).toBe('Routing is unavailable');
    expect(routeMessage({ status: 'error', err: 'boom' }, 'gps')).toBe('boom');
  });
});

describe('offRoadText', () => {
  test('none, start, end or both; metres below 1 km, one decimal below 10 km', () => {
    expect(offRoadText(0, 0)).toBe('');
    expect(offRoadText(1320, 0)).toBe('+ 1.3 km on foot at the start');
    expect(offRoadText(0, 347)).toBe('+ 350 m on foot at the end');
    expect(offRoadText(412, 1300)).toBe('+ 410 m on foot at the start and 1.3 km at the end');
    expect(offRoadText(12_400, 0)).toBe('+ 12 km on foot at the start');
    expect(offRoadText(998, 0)).toBe('+ 1.0 km on foot at the start');
  });
});
