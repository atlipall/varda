import { WALK_MPS } from '../gpx/fromRoute';
import { metresBetween, UNITS_PER_DEG } from './graph';
import { cumulative } from './maneuvers';
import { deg, OFF_ROAD_M, type LonLat, type RoadSeg, type RouteReply } from './plan';
import { buildWalkGraph, snapWalk, walkBetween, type WalkLines } from './walk';

/** Places further apart than this (straight, m) are too far to plan a walk between. */
export const MAX_WALK_M = 100_000;
/** How far around the two places the paths are read (m, at least; more for longer walks), which
 *  is also how far from a path a place may be. */
export const WALK_MARGIN_M = 3000;
const SAME_PLACE_M = 5;

/**
 * A route on foot from `from` to `to`, along the paths and roads drawn on the map (./walk.ts), at
 * walking pace. Straight legs join a place more than OFF_ROAD_M from the nearest path. `segsOf`
 * makes the stretches for turn instructions (the worker matches the line to the roads; their times
 * are set here); without it there is one stretch.
 */
export async function planWalk(lines: WalkLines, from: LonLat, to: LonLat, segsOf?: (coords: LonLat[]) => Promise<RoadSeg[]>): Promise<RouteReply> {
  const [x0, y0] = [from[0] * UNITS_PER_DEG, from[1] * UNITS_PER_DEG];
  const [x1, y1] = [to[0] * UNITS_PER_DEG, to[1] * UNITS_PER_DEG];
  const apart = metresBetween(x0, y0, x1, y1);
  if (apart < SAME_PLACE_M) return { status: 'same-place' };
  if (apart > MAX_WALK_M) return { status: 'too-far-to-walk' };
  // A box round both places, with room for a way that bends away from the straight line.
  const ry = Math.max(WALK_MARGIN_M, apart * 0.3) / metresBetween(0, 0, 0, 1);
  const rx = ry / Math.max(0.01, Math.cos((Math.max(Math.abs(from[1]), Math.abs(to[1])) * Math.PI) / 180));
  const g = buildWalkGraph(await lines([Math.min(x0, x1) - rx, Math.min(y0, y1) - ry, Math.max(x0, x1) + rx, Math.max(y0, y1) + ry]));
  const a = snapWalk(g, x0, y0, WALK_MARGIN_M);
  if (!a) return { status: 'no-path-start' };
  const b = snapWalk(g, x1, y1, WALK_MARGIN_M);
  if (!b) return { status: 'no-path-end' };
  const way = walkBetween(g, a, b);
  if (!way) return { status: 'no-walk' };
  const coords = way.points.map(deg);
  if (coords.length < 2) coords.push(coords[0]);
  const seconds = way.metres / WALK_MPS;
  const leg = (chosen: LonLat, anchor: { x: number; y: number; offM: number }, atStart: boolean) => {
    if (anchor.offM <= OFF_ROAD_M) return { leg: null, metres: 0 };
    const path = deg([anchor.x, anchor.y]);
    return { leg: atStart ? [chosen, path] : [path, chosen], metres: anchor.offM };
  };
  const start = leg(from, a, true);
  const end = leg(to, b, false);
  let segs: RoadSeg[] = [{ start: 0, name: null, type: 0, junction: false, seconds, trail: true }];
  if (segsOf) {
    const matched = await segsOf(coords);
    if (matched.length) segs = walked(matched, coords);
  }
  return {
    status: 'ok', coords, metres: way.metres, seconds,
    offRoadStart: start.leg, offRoadEnd: end.leg, offRoadStartM: start.metres, offRoadEndM: end.metres, segs,
  };
}

/** Stretches with their times at walking pace (matching gives roads their driving times). */
function walked(segs: RoadSeg[], coords: LonLat[]): RoadSeg[] {
  const cum = cumulative(coords);
  return segs.map((s, k) => {
    const end = k + 1 < segs.length ? segs[k + 1].start : coords.length - 1;
    return { ...s, seconds: (cum[end] - cum[s.start]) / WALK_MPS };
  });
}
