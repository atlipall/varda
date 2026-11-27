import { describe, expect, test } from 'vitest';
import { metresBetween } from '../src/routing/graph';
import { buildWalkGraph, JOIN_M, snapWalk, walkBetween, walkToRoad, type WalkLine } from '../src/routing/walk';

// At the equator a map unit is about 2.39 m both ways.
const U = metresBetween(0, 0, 0, 1);
const line = (pts: Array<[number, number]>, net = -1): WalkLine => ({ xy: Int32Array.from(pts.flat()), tile: 0, net, cls: 0 });
const road = (pts: Array<[number, number]>, net = 1) => line(pts, net);
const way = (lines: WalkLine[], a: [number, number], b: [number, number]) => {
  const g = buildWalkGraph(lines);
  const from = snapWalk(g, a[0], a[1], 1000)!;
  const to = snapWalk(g, b[0], b[1], 1000)!;
  return walkBetween(g, from, to);
};

describe('the walking network', () => {
  test('lines sharing a point join there, and a way follows their shape', () => {
    const w = way([line([[0, 0], [100, 0], [100, 50]]), line([[100, 50], [200, 50]])], [0, 0], [200, 50]);
    expect(w?.points).toEqual([[0, 0], [100, 0], [100, 50], [200, 50]]);
    expect(w!.metres).toBeCloseTo(250 * U, 0);
  });

  test(`a line end within ${JOIN_M} m of another line joins it; further off it doesn't`, () => {
    const near = Math.floor((JOIN_M - 3) / U);
    const far = Math.ceil((JOIN_M + 3) / U);
    const trail = (gap: number) => line([[50, gap], [50, 300]]);
    const r = road([[0, 0], [100, 0]]);
    const joined = way([r, trail(near)], [50, 300], [100, 0]);
    expect(joined?.points).toEqual([[50, 300], [50, near], [50, 0], [100, 0]]);
    expect(way([r, trail(far)], [50, 300], [100, 0])).toBeNull();
  });

  test('a trail crossing a road without a shared point gets a node where they cross', () => {
    const w = way([road([[0, 0], [200, 0]]), line([[100, -100], [100, 100]])], [100, 100], [200, 0]);
    expect(w?.points).toEqual([[100, 100], [100, 0], [200, 0]]);
  });

  test('roads crossing without a shared point stay apart (a bridge)', () => {
    expect(way([road([[0, 0], [200, 0]], 1), road([[100, -100], [100, 100]], 2)], [100, 100], [200, 0])).toBeNull();
  });

  test('two places on one piece of line: straight along it', () => {
    const w = way([line([[0, 0], [100, 0], [200, 0]])], [20, 5], [80, -5]);
    expect(w?.points.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6))).toEqual([[20, 0], [80, 0]]);
  });

  test('a way picks the shorter of two', () => {
    // From halfway up one side to halfway up the other: round the top 250 + 100 + 250 units,
    // round the bottom 50 + 20 + 100 + 20 + 50.
    const w = way([line([[0, 0], [0, 300], [100, 300], [100, 0]]), line([[0, 0], [0, -20], [100, -20], [100, 0]])], [0, 50], [100, 50]);
    expect(w!.metres).toBeCloseTo(240 * U, 0);
  });
});

describe('walkToRoad', () => {
  const r = road([[0, 0], [1000, 0]]);
  // A place 300 units (716 m) north of the road; a trail from 10 units of it.
  const place: [number, number] = [500, 300];

  test('along a trail that gets to the road sooner than walking straight', () => {
    const g = buildWalkGraph([r, line([[500, 290], [700, 290], [700, 0]])]);
    const w = walkToRoad(g, place[0], place[1], 300 * U, (l) => l.net >= 0);
    expect(w?.points).toEqual([[500, 300], [500, 290], [700, 290], [700, 0]]);
  });

  test('no way when the trail is the longer way (straight counts double)', () => {
    const g = buildWalkGraph([r, line([[500, 290], [2000, 290], [2000, 0]])]);
    expect(walkToRoad(g, place[0], place[1], 300 * U, (l) => l.net >= 0)).toBeNull();
  });

  test('only to a road a car may use', () => {
    const g = buildWalkGraph([r, line([[500, 290], [700, 290], [700, 0]])]);
    expect(walkToRoad(g, place[0], place[1], 300 * U, () => false)).toBeNull();
  });
});

describe('walkToRoad from a path that stops short of the road', () => {
  test('the rest across country, when the hop is short', () => {
    const r = road([[0, 0], [1000, 0]]);
    // The trail stops 50 units (119 m) short of the road.
    const g = buildWalkGraph([r, line([[500, 290], [700, 290], [700, 50]])]);
    const w = walkToRoad(g, 500, 300, 300 * U, (l) => l.net >= 0);
    expect(w?.points.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6))).toEqual([[500, 300], [500, 290], [700, 290], [700, 50], [700, 0]]);
  });
});
