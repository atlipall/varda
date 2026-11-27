import { WALK_MPS, walkSeg } from '../gpx/fromRoute';
import type { StoredTrack } from '../gpx/store';
import { cumulative, metres } from '../routing/maneuvers';
import type { LonLat, RoadSeg, RouteReply } from '../routing/plan';
import type { JoinedRoute } from '../routing/waypoints';

type RouteOk = Extract<RouteReply, { status: 'ok' }>;

/** A track as navigation follows it: one line, in the direction chosen. */
export interface TrackLine {
  coords: LonLat[];
  /** Per point, when it was recorded (ms), if the GPX has times. */
  times: Array<number | null>;
  cum: number[];
}

/** The track's line, its parts joined in order and turned round for `reverse`. A route saved as a
 *  track keeps its points as they are (its road stretches index them). */
export function trackLine(t: StoredTrack, reverse: boolean): TrackLine {
  const points = t.route ? t.gpx.lines[0].points : t.gpx.lines.flatMap((l) => l.points);
  const kept = t.route ? points : points.filter((p, i) => i === 0 || p.lon !== points[i - 1].lon || p.lat !== points[i - 1].lat);
  const ordered = reverse ? [...kept].reverse() : kept;
  const coords = ordered.map((p): LonLat => [p.lon, p.lat]);
  return { coords, times: reverse ? ordered.map(() => null) : ordered.map((p) => p.time), cum: cumulative(coords) };
}

/** Where to join a track: its nearest point to `p` at least `from` metres along it (so a track that
 *  comes back near itself isn't joined at a part already done). */
export interface Join {
  /** The track point the joining stretch starts at. */
  index: number;
  point: LonLat;
  along: number;
  /** Metres from `p`. */
  off: number;
}

export function nearestAhead(line: TrackLine, p: LonLat, from = 0): Join {
  const { coords, cum } = line;
  const k = Math.cos((p[1] * Math.PI) / 180);
  let best: Join = { index: coords.length - 1, point: coords[coords.length - 1], along: cum[cum.length - 1], off: metres(p, coords[coords.length - 1]) };
  for (let i = 0; i + 1 < coords.length; i++) {
    if (cum[i + 1] < from) continue;
    const [ax, ay] = [(coords[i][0] - p[0]) * k, coords[i][1] - p[1]];
    const [dx, dy] = [(coords[i + 1][0] - coords[i][0]) * k, coords[i + 1][1] - coords[i][1]];
    const len2 = dx * dx + dy * dy;
    // Not behind `from` on this stretch either.
    const tMin = cum[i] < from && cum[i + 1] > cum[i] ? (from - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    const t = Math.max(tMin, Math.min(1, len2 ? -(ax * dx + ay * dy) / len2 : 0));
    const q: LonLat = [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
    const off = metres(p, q);
    if (off < best.off) best = { index: i, point: q, along: cum[i] + (cum[i + 1] - cum[i]) * t, off };
  }
  return best;
}

/** The seconds of `segs` (over `cum`) from `along` to the end. */
function secondsFrom(segs: RoadSeg[], cum: number[], along: number): number {
  let s = 0;
  segs.forEach((seg, k) => {
    const a = cum[seg.start];
    const b = cum[k + 1 < segs.length ? segs[k + 1].start : cum.length - 1];
    if (b <= along) return;
    s += b > a ? seg.seconds * ((b - Math.max(a, along)) / (b - a)) : 0;
  });
  return s;
}

/**
 * One route for navigation: the way to the track (a planned road route, with the straight legs off
 * the road at its ends; or a straight line where no road leads there; or nothing when you're on
 * it), then the track from where it joins to its end, with the track's own stretches. The stretch
 * where the way meets the track says so ("Join Laugavegur").
 */
export function routeAlongTrack(name: string, line: TrackLine, segs: RoadSeg[], join: Join, from: LonLat | null, approach: RouteOk | null): { route: JoinedRoute; approachM: number; joinIndex: number } {
  const coords: LonLat[] = [];
  const out: RoadSeg[] = [];
  let seconds = 0;
  /** A way on foot from the last point of `coords` along `leg` (its first point that one): a
   *  stretch for it, and its points but the last (the next part starts there). */
  const walk = (leg: LonLat[]) => {
    const s = cumulative(leg).pop()! / WALK_MPS;
    out.push(walkSeg(Math.max(0, coords.length - 1), leg, coords.length > 0, s));
    coords.push(...leg.slice(1, -1));
    seconds += s;
  };
  if (approach) {
    if (approach.offRoadStart) {
      coords.push(approach.offRoadStart[0]);
      walk(approach.offRoadStart);
    }
    const base = coords.length;
    const roadSegs = approach.segs?.length ? approach.segs : [{ start: 0, name: null, type: 0, junction: false, seconds: approach.seconds }];
    out.push(...roadSegs.map((s, k) => ({ ...s, start: s.start + base, junction: s.junction || (k === 0 && base > 0) })));
    coords.push(...approach.coords);
    seconds += approach.seconds;
    // The way on foot from the road ends at the track (the route was planned to its join point).
    if (approach.offRoadEnd) walk([...approach.offRoadEnd.slice(0, -1), join.point]);
  } else if (from && metres(from, join.point) > 1) {
    // No road leads there: straight to the track.
    coords.push(from);
    walk([from, join.point]);
  }
  const approachM = coords.length ? cumulative([...coords, join.point]).pop()! : 0;
  // The track from the join point: its stretches moved to their place on the joined line.
  const base = coords.length;
  coords.push(join.point, ...line.coords.slice(join.index + 1));
  const within = segs.filter((s) => s.start <= join.index).pop() ?? segs[0];
  const later = segs.filter((s) => s.start > join.index);
  out.push({ ...within, start: base, junction: base > 0, bend: false, ...(base > 0 ? { join: name } : {}) });
  out.push(...later.map((s) => ({ ...s, start: base + (s.start - join.index) })));
  seconds += secondsFrom(segs, line.cum, join.along);
  const total = cumulative(coords).pop() ?? 0;
  return { route: { status: 'ok', coords, metres: total, seconds, offRoadStart: null, offRoadEnd: null, offRoadStartM: 0, offRoadEndM: 0, segs: out }, approachM, joinIndex: base };
}
