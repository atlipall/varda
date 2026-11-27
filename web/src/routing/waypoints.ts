import type { LonLat, RoadSeg, RouteReply } from './plan';

type RouteOk = Extract<RouteReply, { status: 'ok' }>;

/** A route through waypoints: the legs joined, with the off-road legs at the waypoints as well. */
export type JoinedRoute = RouteOk & { offRoadVia?: LonLat[][] };

/** Straight-line metres between two [lon, lat] points (an equirectangular approximation; fine for
 *  comparing detours). */
function metres(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_195;
}

/** Where a new waypoint `p` goes among `stops` (start, waypoints…, destination): the index in the
 *  waypoint list (0 = right after the start) that adds the least straight-line detour. */
export function bestInsert(stops: LonLat[], p: LonLat): number {
  let best = 0;
  let bestExtra = Infinity;
  for (let i = 0; i + 1 < stops.length; i++) {
    const extra = metres(stops[i], p) + metres(p, stops[i + 1]) - metres(stops[i], stops[i + 1]);
    if (extra < bestExtra) [best, bestExtra] = [i, extra];
  }
  return best;
}

/** The legs start → waypoint → … → destination as one route: the lines joined end to end, distances
 *  and times added up; the off-road legs of the first start and last end stay as they are, those at
 *  the waypoints go in `offRoadVia`. */
export function joinLegs(legs: RouteOk[]): JoinedRoute {
  const first = legs[0];
  const last = legs[legs.length - 1];
  const coords: LonLat[] = [];
  const via: LonLat[][] = [];
  // The road stretches, each leg's moved to where its line starts in the joined one, the first after
  // each waypoint marked with the waypoint's number. None when a leg has none.
  const segs: RoadSeg[] | undefined = legs.every((l) => l.segs?.length) ? [] : undefined;
  legs.forEach((leg, i) => {
    const dup = coords.length > 0 && sameLonLat(coords[coords.length - 1], leg.coords[0]);
    const base = coords.length - (dup ? 1 : 0);
    segs?.push(...leg.segs!.map((s, k) => ({ ...s, start: s.start + base, ...(i > 0 && k === 0 ? { via: i } : {}) })));
    const c = dup ? leg.coords.slice(1) : leg.coords;
    coords.push(...c);
    if (i > 0 && leg.offRoadStart) via.push(leg.offRoadStart);
    if (i < legs.length - 1 && leg.offRoadEnd) via.push(leg.offRoadEnd);
  });
  return {
    status: 'ok',
    coords,
    metres: legs.reduce((m, l) => m + l.metres, 0),
    seconds: legs.reduce((s, l) => s + l.seconds, 0),
    offRoadStart: first.offRoadStart,
    offRoadEnd: last.offRoadEnd,
    offRoadStartM: first.offRoadStartM,
    offRoadEndM: last.offRoadEndM,
    offRoadVia: via,
    ...(segs ? { segs } : {}),
  };
}

const sameLonLat = (a: LonLat, b: LonLat) => a[0] === b[0] && a[1] === b[1];
