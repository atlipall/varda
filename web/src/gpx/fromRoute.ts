import type { LonLat } from '../routing/plan';
import { cumulative } from '../routing/maneuvers';
import type { JoinedRoute } from '../routing/waypoints';
import type { Gpx } from './parse';
import type { TrackRoute } from './store';

/** Walking pace for a straight leg off the road (m/s): 4 km/h. */
export const WALK_MPS = 4 / 3.6;

const legMetres = (leg: LonLat[]) => cumulative(leg).pop()!;

/** The stretch of a way on foot at a route's end: straight (off the road), or along paths. */
export const walkSeg = (start: number, leg: LonLat[], junction: boolean, seconds: number) =>
  ({ start, name: null, type: 0, junction, seconds, trail: true, ...(leg.length === 2 ? { offRoad: true } : {}) });

/**
 * A planned route as a track to keep: its line from the chosen start to the destination (the
 * ways on foot at either end included), the waypoints and destination as GPX
 * waypoints, and its road stretches, so navigating the track later gives the same turns.
 */
export function routeAsTrack(name: string, r: JoinedRoute, dest: { name: string | null; lon: number; lat: number }, vias: Array<{ name: string | null; lon: number; lat: number }>): { gpx: Gpx; route: TrackRoute } {
  const pts: LonLat[] = [...r.coords];
  let segs = (r.segs?.length ? r.segs : [{ start: 0, name: null, type: 0, junction: false, seconds: r.seconds }]).map((s) => ({ ...s }));
  let seconds = r.seconds;
  if (r.offRoadStart) {
    const leg = r.offRoadStart;
    const walk = legMetres(leg) / WALK_MPS;
    pts.unshift(...leg.slice(0, -1));
    const n = leg.length - 1;
    segs = [walkSeg(0, leg, false, walk), ...segs.map((s, i) => ({ ...s, start: s.start + n, ...(i === 0 ? { junction: true } : {}) }))];
    seconds += walk;
  }
  if (r.offRoadEnd) {
    const leg = r.offRoadEnd;
    const walk = legMetres(leg) / WALK_MPS;
    const at = pts.length - 1;
    pts.push(...leg.slice(1));
    segs.push(walkSeg(at, leg, true, walk));
    seconds += walk;
  }
  const point = ([lon, lat]: LonLat) => ({ lon, lat, ele: null, time: null });
  return {
    gpx: {
      name,
      lines: [{ kind: 'route', name, points: pts.map(point) }],
      waypoints: [...vias, dest].map((p) => ({ name: p.name, lon: p.lon, lat: p.lat, ele: null })),
    },
    route: { segs, seconds },
  };
}
