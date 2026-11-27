import { fastestRoute, metresBetween, PREFER_FROAD_WEIGHT, UNITS_PER_DEG, type NodeIndex, type Preference, type RoadGraph, type Route, type Terminal } from './graph';

/**
 * How routes keep to main roads (see Preference). In towns many collector streets share the main
 * roads' speed class, and by time alone a zig-zag through them won (Grandi → Mosfellsbær took 24
 * turns through Borgartún, Háaleitisbraut and Fellsmúli instead of Hringbraut and Miklabraut). The
 * road-change cost does most of the work; the rank weights tip close calls towards main roads.
 */
export const ROUTE_PREFERENCE: Preference = { rankWeight: [1.5, 1.3, 1.15, 1.05, 1], changeSeconds: 10 };
import { cumulative } from './maneuvers';
import { cutLine, lineMetres, Snapper, type Anchor, type RoadLines, type Side } from './snap';
import { buildWalkGraph, OFF_PATH_COST, walkToRoad, type WalkLine, type WalkLines } from './walk';

export type LonLat = [number, number];

/** A stretch of the route along one road, from `coords[start]` to the next stretch's start: what
 *  turn instructions are made from. `junction`: a road branches off where it starts; `via`: a
 *  waypoint's number, on the first stretch after it. */
export interface RoadSeg {
  start: number;
  name: string | null;
  type: number;
  junction: boolean;
  seconds: number;
  via?: number;
  /** Off the roads: a trail, or a straight leg to or from one (on a track, ../tracks/match.ts). */
  trail?: boolean;
  /** A straight leg between a point and the road or track (no trail to name). */
  offRoad?: boolean;
  /** Where a route to a track joins it: the track's name (../tracks/trackNav.ts). */
  join?: string;
  /** A bend of a trail worth a turn instruction (it has no junctions to go by). */
  bend?: boolean;
  /** An F-road or a track (the road's class, which on some maps only its second label shows). */
  highland?: boolean;
}

/** A graph route drawn along its roads, with its road stretches. */
export interface Shaped {
  coords: LonLat[];
  segs: RoadSeg[];
}

export type RouteReply =
  | {
      status: 'ok';
      coords: LonLat[];
      /** Road distance and time: from the snapped start point to the snapped destination. */
      metres: number;
      seconds: number;
      /** The ways on foot between a chosen point and the road when that is more than 30 m away
       *  (chosen start … road, road … destination), with their lengths (0 when none): straight,
       *  or along paths where they lead there (see ./walk.ts). In a walking route: the straight
       *  legs between a point and the nearest path. */
      offRoadStart: LonLat[] | null;
      offRoadEnd: LonLat[] | null;
      offRoadStartM: number;
      offRoadEndM: number;
      /** The roads along `coords` (none for a route along a single stretch, and in routes saved
       *  before turn instructions). */
      segs?: RoadSeg[];
    }
  | { status: 'no-road-start' | 'no-road-end' | 'no-route' | 'no-route-any' | 'no-routing-data' | 'same-place' | 'no-path-start' | 'no-path-end' | 'no-walk' | 'too-far-to-walk' };

/** A chosen point further than this from its road gets a drawn off-road leg. */
export const OFF_ROAD_M = 30;
/** Snapped ends closer than this are the same place. */
const SAME_PLACE_M = 5;

export const deg = (p: [number, number]): LonLat => [p[0] / UNITS_PER_DEG, p[1] / UNITS_PER_DEG];
const units = (p: LonLat) => [p[0] * UNITS_PER_DEG, p[1] * UNITS_PER_DEG] as const;
const seconds = (metres: number, kmh: number) => (kmh > 0 ? metres / (kmh / 3.6) : 0);

/**
 * Snaps `from`/`to` to the nearest point on a road (within 50 km; see ./snap.ts) and searches for
 * the fastest route between those points, reporting why not when either step fails. With F-roads not
 * allowed only normal roads count; an end with only an F-road or track within reach is reported as
 * 'no-route' (turning the switch on would help). `shape` turns a found graph route into on-road
 * coordinates (the worker passes `routeShape` bound to its subdivision cache) and `lines` finds road
 * lines, so this is testable against a synthetic graph and lines alone. `preferFRoads` (with F-roads
 * allowed) favours F-roads and tracks when choosing the route; the time reported stays the real one.
 */
export async function planRoute(
  graph: RoadGraph,
  index: NodeIndex,
  lines: RoadLines,
  from: LonLat,
  to: LonLat,
  allowFRoads: boolean,
  shape: (route: Route) => Promise<LonLat[] | Shaped>,
  preferFRoads = false,
  walkLines?: WalkLines,
): Promise<RouteReply> {
  if (graph.nodeX.length === 0) return { status: 'no-routing-data' };
  const snapper = new Snapper(graph, index, lines);
  let a = await snapper.snap(from, true, allowFRoads);
  if (!a) return { status: !allowFRoads && (await snapper.snap(from, true, true)) ? 'no-route' : 'no-road-start' };
  let b = await snapper.snap(to, false, allowFRoads);
  if (!b) return { status: !allowFRoads && (await snapper.snap(to, false, true)) ? 'no-route' : 'no-road-end' };
  if (metresBetween(...units(from), ...units(to)) < SAME_PLACE_M) return { status: 'same-place' };

  // A point away from the road: on foot along paths to a road, where they lead to one sooner than
  // walking straight; else straight to the nearest road.
  const offRoad = async (chosen: LonLat, anchor: Anchor, atStart: boolean): Promise<{ anchor: Anchor; leg: LonLat[] | null; metres: number }> => {
    if (anchor.offM <= OFF_ROAD_M) return { anchor, leg: null, metres: 0 };
    const onPaths = walkLines ? await walkToRoadFrom(graph, walkLines, chosen, anchor.offM, allowFRoads) : null;
    const there = onPaths && (await snapper.snap(onPaths[onPaths.length - 1], atStart, allowFRoads));
    if (onPaths && there && there.offM <= OFF_ROAD_M) {
      const leg = [...onPaths, deg(there.at)].filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
      return { anchor: there, leg: atStart ? leg : leg.reverse(), metres: cumulative(leg).pop()! };
    }
    const road = deg(anchor.at);
    return { anchor, leg: atStart ? [chosen, road] : [road, chosen], metres: anchor.offM };
  };
  const start = await offRoad(from, a, true);
  const end = await offRoad(to, b, false);
  a = start.anchor;
  b = end.anchor;
  const ok = (coords: LonLat[], metres: number, secs: number, segs?: RoadSeg[]): RouteReply => ({
    status: 'ok',
    coords,
    metres,
    seconds: secs,
    offRoadStart: start.leg,
    offRoadEnd: end.leg,
    offRoadStartM: start.metres,
    offRoadEndM: end.metres,
    ...(segs ? { segs } : {}),
  });

  // Different places that join the road at the same point: only the off-road legs (the road part
  // is the two snapped points, no distance or time).
  // A route along one stretch has a single road stretch (its road's name isn't known here), so a
  // route joined from legs keeps every leg's stretches.
  const one = (secs: number): RoadSeg[] => [{ start: 0, name: null, type: 0, junction: false, seconds: secs }];
  if (metresBetween(a.at[0], a.at[1], b.at[0], b.at[1]) < SAME_PLACE_M) return ok([deg(a.at), deg(b.at)], 0, 0, one(0));

  const direct = alongOneStretch(a, b);
  if (direct) {
    const secs = seconds(direct.metres, direct.kmh);
    return ok(direct.path.map(deg), direct.metres, secs, one(secs));
  }

  const sources: Terminal[] = a.sides.filter((s) => s.leave > 0).map((s) => ({ node: s.node, cost: seconds(s.metres, s.leave) }));
  const targets: Terminal[] = b.sides.filter((s) => s.arrive > 0).map((s) => ({ node: s.node, cost: seconds(s.metres, s.arrive) }));
  const route = fastestRoute(graph, sources, targets, allowFRoads, allowFRoads && preferFRoads ? PREFER_FROAD_WEIGHT : 1, ROUTE_PREFERENCE);
  if (!route) return { status: allowFRoads ? 'no-route-any' : 'no-route' };
  const first = route.nodes[0];
  const last = route.nodes[route.nodes.length - 1];
  const sa = a.sides.find((s) => s.node === first && s.leave > 0) as Side;
  const sb = b.sides.find((s) => s.node === last && s.arrive > 0) as Side;
  const shaped = await shape(route);
  const middle = Array.isArray(shaped) ? shaped : shaped.coords;
  const coords = [...sa.path.map(deg), ...middle.slice(1), ...[...sb.path].reverse().slice(1).map(deg)];
  // The road stretches, moved past the partial stretch at the start; the partial stretches' times go
  // to the first and last.
  let segs: RoadSeg[] | undefined;
  if (!Array.isArray(shaped) && shaped.segs.length) {
    const offset = sa.path.length - 1;
    segs = shaped.segs.map((s, i) => ({ ...s, start: i === 0 ? 0 : s.start + offset }));
    segs[0].seconds += seconds(sa.metres, sa.leave);
    segs[segs.length - 1].seconds += seconds(sb.metres, sb.arrive);
  }
  return ok(coords, sa.metres + route.metres + sb.metres, route.seconds, segs);
}

/** The roads cars may use, by tile and NET offset (tile × 2^32 + offset, sorted): those with edges
 *  in the routing network (roads closed to cars have none). Made once per network, as a typed
 *  array (a Set of a big map's million roads would take far more memory). */
const carRoads = new WeakMap<RoadGraph, Float64Array>();
function carRoadsOf(g: RoadGraph): Float64Array {
  let keys = carRoads.get(g);
  if (!keys) {
    const all = new Float64Array(g.edgeNet.length);
    let n = 0;
    for (let e = 0; e < g.edgeNet.length; e++) if (g.edgeNet[e] >= 0) all[n++] = g.edgeTile[e] * 0x100000000 + g.edgeNet[e];
    const sorted = all.subarray(0, n).sort();
    let k = 0;
    for (let i = 0; i < n; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[k++] = sorted[i];
    keys = sorted.slice(0, k);
    carRoads.set(g, keys);
  }
  return keys;
}

function hasKey(keys: Float64Array, key: number): boolean {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] === key) return true;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** The last few ways on foot to a road, by point and switch: navigation plans again from your
 *  position many times, to the same destination. */
const walksToRoad = new WeakMap<RoadGraph, Map<string, LonLat[] | null>>();
const KEEP_WALKS = 4;

/** Most metres around a point the paths are looked at for a way to a road. */
const WALK_TO_ROAD_MAX_M = 25_000;

/** The way on foot along paths from `p` ([lon, lat]) to a road this route may use, when it beats
 *  walking `straightM` straight to the nearest one; its points from `p` to the road, or null. */
async function walkToRoadFrom(g: RoadGraph, walkLines: WalkLines, p: LonLat, straightM: number, allowFRoads: boolean): Promise<LonLat[] | null> {
  let kept = walksToRoad.get(g);
  if (!kept) walksToRoad.set(g, (kept = new Map()));
  const key = `${p[0]},${p[1]},${allowFRoads}`;
  if (kept.has(key)) return kept.get(key)!;
  const way = await findWalkToRoad(g, walkLines, p, straightM, allowFRoads);
  kept.set(key, way);
  if (kept.size > KEEP_WALKS) kept.delete(kept.keys().next().value!);
  return way;
}

async function findWalkToRoad(g: RoadGraph, walkLines: WalkLines, p: LonLat, straightM: number, allowFRoads: boolean): Promise<LonLat[] | null> {
  const [x, y] = units(p);
  // Nothing further than this beats walking straight (see OFF_PATH_COST).
  const reach = Math.min(WALK_TO_ROAD_MAX_M, OFF_PATH_COST * straightM + 200);
  const ry = reach / metresBetween(0, 0, 0, 1);
  const rx = ry / Math.max(0.01, Math.cos((p[1] * Math.PI) / 180));
  const walkGraph = buildWalkGraph(await walkLines([x - rx, y - ry, x + rx, y + ry]));
  const cars = carRoadsOf(g);
  const drivable = (l: WalkLine) => l.net >= 0 && (allowFRoads || l.cls === 0) && hasKey(cars, l.tile * 0x100000000 + l.net);
  const way = walkToRoad(walkGraph, x, y, straightM, drivable);
  return way ? way.points.map(deg) : null;
}

/** The way straight along the road when both ends lie on the same stretch between two nodes and
 *  the road may be driven from one to the other; null otherwise. */
function alongOneStretch(a: Anchor, b: Anchor): { path: Array<[number, number]>; metres: number; kmh: number } | null {
  const sa = a.stretch;
  const sb = b.stretch;
  if (!sa || !sb || sa.tile !== sb.tile || sa.net !== sb.net) return null;
  let alongB: number;
  if (sa.u === sb.u && sa.v === sb.v) alongB = sb.along;
  else if (sa.u === sb.v && sa.v === sb.u) alongB = lineMetres(sb.line) - sb.along;
  else return null;
  const forward = alongB > sa.along;
  // Towards v is a's second side's `leave`, towards u its first's.
  const kmh = forward ? a.sides[1].leave : a.sides[0].leave;
  if (!kmh) return null;
  const path = forward ? cutLine(sa.line, sa.along, alongB) : cutLine(sa.line, alongB, sa.along).reverse();
  return { path, metres: Math.abs(alongB - sa.along), kmh };
}
