import { WALK_MPS } from '../gpx/fromRoute';
import { UNITS_PER_DEG } from '../routing/graph';
import { cumulative, turnAngle } from '../routing/maneuvers';
import type { LonLat, RoadSeg } from '../routing/plan';
import { CLASS_CAP_KMH } from '../routing/roadClass';
import { beyond, nearestOnLine, type RoadLine, type RoadLines } from '../routing/snap';

/** A track point this close to a road line (m) is on that road. */
export const ON_ROAD_M = 20;
/** A stretch shorter than this (m) is taken as GPS wobble at a crossing and joins its neighbour. */
const MIN_STRETCH_M = 30;
/** A trail's bend of at least this many degrees gets a turn instruction… */
const BEND_DEG = 50;
/** …if this far (m) from the previous one and from the ends of the trail stretch. */
const BEND_GAP_M = 60;
/** Off-road for more than this share of its length, a track is walked (times at walking pace). */
const MOSTLY_TRAIL = 0.5;

/** Typical speeds (km/h) by Garmin road type, for a track's driving time where the GPX has none. */
const TYPE_KMH: Record<number, number> = { 0x01: 90, 0x02: 80, 0x03: 70, 0x04: 60, 0x05: 60, 0x06: 40, 0x07: 20, 0x08: 40, 0x09: 60, 0x0a: 40, 0x0b: 60, 0x0c: 30, 0x16: 4 };

const metresPerUnit = 111_195 / UNITS_PER_DEG;

interface Hit { key: string; name: string | null; type: number; cls: number }
const TRAIL: Hit = { key: 'trail', name: null, type: 0, cls: 0 };

/** The road a point is on: the nearest road line within ON_ROAD_M, else the trail. */
async function roadAt(lines: RoadLines, p: LonLat): Promise<Hit> {
  const x = p[0] * UNITS_PER_DEG;
  const y = p[1] * UNITS_PER_DEG;
  const kx = Math.cos((p[1] * Math.PI) / 180);
  let best: { line: RoadLine; m: number } | null = null;
  for (const line of await lines(x, y, ON_ROAD_M * 2)) {
    if (beyond(line, x, y, kx, ON_ROAD_M)) continue;
    const m = Math.sqrt(nearestOnLine(line.coords, x, y, kx).d2) * metresPerUnit;
    if (m <= ON_ROAD_M && (!best || m < best.m)) best = { line, m };
  }
  if (!best) return TRAIL;
  const name = best.line.name ?? null;
  const type = best.line.type ?? 0;
  return { key: `${name ?? ''}|${type}`, name, type, cls: best.line.cls };
}

/**
 * Road stretches along a track (as a planned route has), so it gets turn instructions: matched to
 * the map's roads where it follows them (by name and type; a change of road is a junction), and
 * on trails cut at its sharper bends. Seconds per stretch from the GPX's own times when it has
 * them, else walking pace for a track mostly off the roads, else typical road speeds.
 */
export async function matchTrack(coords: LonLat[], lines: RoadLines, times?: Array<number | null>): Promise<RoadSeg[]> {
  if (coords.length < 2) return [{ start: 0, name: null, type: 0, junction: false, seconds: 0, trail: true }];
  const cum = cumulative(coords);
  const hits: Hit[] = [];
  for (const p of coords) hits.push(await roadAt(lines, p));
  // A lone point that differs from both neighbours, which agree, is GPS wobble.
  for (let i = 1; i + 1 < hits.length; i++) if (hits[i - 1].key === hits[i + 1].key && hits[i].key !== hits[i - 1].key) hits[i] = hits[i - 1];
  // Runs of the same road (or trail).
  let runs: Array<{ start: number; hit: Hit }> = [];
  for (let i = 0; i < hits.length; i++) if (!runs.length || runs[runs.length - 1].hit.key !== hits[i].key) runs.push({ start: i, hit: hits[i] });
  const runEnd = (k: number) => (k + 1 < runs.length ? runs[k + 1].start : coords.length - 1);
  // Too short to be a stretch of its own: part of the one before (or after, at the start).
  runs = runs.filter((r, k) => k === 0 || cum[runEnd(k)] - cum[r.start] >= MIN_STRETCH_M);
  const merged: typeof runs = [];
  for (const r of runs) if (!merged.length || merged[merged.length - 1].hit.key !== r.hit.key) merged.push(r);
  runs = merged;
  // A change of road shows where the track gets more than ON_ROAD_M from the road, past the corner:
  // move it back to the sharpest point shortly before (where the turn is).
  for (let k = 1; k < runs.length; k++) {
    let best = runs[k].start;
    let sharpest = Math.abs(turnAngle(coords, cum, best));
    for (let i = runs[k].start - 1; i > runs[k - 1].start && cum[runs[k].start] - cum[i] <= ON_ROAD_M * 2; i--) {
      const a = Math.abs(turnAngle(coords, cum, i));
      if (a > sharpest) [best, sharpest] = [i, a];
    }
    runs[k].start = best;
  }
  // Stretches, trails cut at their bends.
  const segs: RoadSeg[] = [];
  runs.forEach((r, k) => {
    const end = runEnd(k);
    const trail = r.hit.key === 'trail';
    segs.push({ start: r.start, name: r.hit.name, type: r.hit.type, junction: k > 0, seconds: 0, ...(trail ? { trail: true } : {}), ...(r.hit.cls ? { highland: true } : {}) });
    if (!trail) return;
    let last = cum[r.start];
    for (let i = r.start + 1; i < end; i++) {
      if (cum[i] - last < BEND_GAP_M || cum[end] - cum[i] < BEND_GAP_M / 2) continue;
      const a = Math.abs(turnAngle(coords, cum, i));
      // The sharpest point of the bend: no sharper one just after it.
      if (a < BEND_DEG || Math.abs(turnAngle(coords, cum, i + 1)) > a) continue;
      segs.push({ start: i, name: null, type: 0, junction: true, seconds: 0, trail: true, bend: true });
      last = cum[i];
    }
  });
  // Times: recorded, walked, or driven.
  const segEnd = (k: number) => (k + 1 < segs.length ? segs[k + 1].start : coords.length - 1);
  const recorded = times && times.length === coords.length && times[0] !== null && times[times.length - 1] !== null && times[times.length - 1]! > times[0]! ? times : null;
  const trailM = segs.reduce((m, s, k) => m + (s.trail ? cum[segEnd(k)] - cum[s.start] : 0), 0);
  const walked = trailM > cum[cum.length - 1] * MOSTLY_TRAIL;
  segs.forEach((s, k) => {
    const m = cum[segEnd(k)] - cum[s.start];
    const t0 = recorded?.[s.start];
    const t1 = recorded?.[segEnd(k)];
    if (t0 != null && t1 != null && t1 >= t0) s.seconds = (t1 - t0) / 1000;
    else if (s.trail || walked) s.seconds = m / WALK_MPS;
    else s.seconds = m / (Math.min(TYPE_KMH[s.type] ?? 50, CLASS_CAP_KMH[hits[s.start].cls] ?? Infinity) / 3.6);
  });
  return segs;
}
