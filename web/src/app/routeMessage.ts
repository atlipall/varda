import type { RouteReply } from '../routing/plan';

/** Where a route starts: your GPS position, the map centre, or a point chosen on the map. */
export type StartKind = 'gps' | 'centre' | 'chosen';

const MESSAGES: Record<Exclude<RouteReply['status'], 'ok' | 'no-road-start'>, string> = {
  'no-road-end': 'No road within 50 km of the destination',
  'no-route': 'No route without F-roads and tracks: turn the switch on to allow them',
  'no-route-any': 'No route by road between these places',
  'no-routing-data': 'This map has no routing data',
  'same-place': "You're already there",
  'no-path-start': 'No path or road within 3 km of the start',
  'no-path-end': 'No path or road within 3 km of the destination',
  'no-walk': 'No way on foot between these places along the paths on the map',
  'too-far-to-walk': 'Too far to walk: pick places within 100 km of each other',
};

const NO_ROAD_START: Record<StartKind, string> = {
  gps: 'No road near your position',
  centre: 'No road near the map centre',
  chosen: 'No road near the chosen point',
};

/** The panel's message for a failed route; `from` says where the route started. */
export function routeMessage(reply: Exclude<RouteReply, { status: 'ok' }> | { status: 'error'; err: unknown }, from: StartKind): string {
  if (reply.status === 'error') return reply.err instanceof Error ? reply.err.message : String(reply.err);
  if (reply.status === 'no-road-start') return NO_ROAD_START[from];
  return MESSAGES[reply.status];
}

/** An off-road distance: metres (to 10 m) below 1 km, km with one decimal below 10 km, whole km above. */
function fmtOffRoad(m: number): string {
  const r = Math.round(m / 10) * 10;
  if (r < 1000) return `${r} m`;
  return m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

/** The panel's line for the ways on foot between a point and its road, e.g. "+ 1.3 km on foot at
 *  the start" (the route keeps to the roads; the rest is walked), or in a walking route for the
 *  straight legs to the nearest path ("+ 300 m off the paths at the end"); '' when there's none. */
export function offRoadText(startM: number, endM: number, walking = false): string {
  const what = walking ? 'off the paths' : 'on foot';
  if (startM && endM) return `+ ${fmtOffRoad(startM)} ${what} at the start and ${fmtOffRoad(endM)} at the end`;
  if (startM) return `+ ${fmtOffRoad(startM)} ${what} at the start`;
  if (endM) return `+ ${fmtOffRoad(endM)} ${what} at the end`;
  return '';
}
