import { cumulative, metres } from './maneuvers';
import type { LonLat, RoadSeg } from './plan';

/** Where you are on a route. */
export interface Where {
  /** Metres from the start to the nearest point of the route. */
  along: number;
  /** Metres from you to that point. */
  off: number;
  /** The route point the nearest stretch starts at. */
  index: number;
}

/** Metres per degree of latitude, as `metres` measures. */
const M_PER_DEG = metres([0, 0], [0, 1]);
/** Stretches per block in the search's bounds. */
const BLOCK = 32;

/**
 * Follows a position along a route: the nearest point of the route (looked for near the last one
 * first, so a road that doubles back doesn't make you jump ahead), the distance and driving time
 * left. The time comes from the road stretches' times where the route has them, else in proportion
 * to the distance.
 */
export class Progress {
  readonly cum: number[];
  readonly total: number;
  /** Seconds from the start to each route point. */
  private readonly time: number[];
  /** Stretch i's bounds (degrees): west, south, east, north at 4i … 4i + 3. */
  private readonly box: Float64Array;
  /** The same for each BLOCK stretches together (block b: stretches b·BLOCK …). */
  private readonly blocks: Float64Array;
  /** The largest |latitude| on the route. */
  private readonly maxLat: number;
  private last = 0;
  /** Metres along the route at the last fix; null before the first (or after a long gap). */
  private lastAlong: number | null = null;

  constructor(readonly coords: LonLat[], segs: RoadSeg[] | undefined, readonly seconds: number) {
    this.cum = cumulative(coords);
    this.total = this.cum[this.cum.length - 1];
    this.time = new Array(coords.length).fill(0);
    if (segs?.length) {
      for (let s = 0; s < segs.length; s++) {
        const a = segs[s].start;
        const b = s + 1 < segs.length ? segs[s + 1].start : coords.length - 1;
        const len = this.cum[b] - this.cum[a];
        for (let i = a + 1; i <= b; i++) this.time[i] = this.time[a] + (len ? segs[s].seconds * ((this.cum[i] - this.cum[a]) / len) : 0);
      }
    } else {
      for (let i = 1; i < coords.length; i++) this.time[i] = this.total ? seconds * (this.cum[i] / this.total) : 0;
    }
    const n = Math.max(0, coords.length - 1);
    this.box = new Float64Array(n * 4);
    this.blocks = new Float64Array(Math.ceil(n / BLOCK) * 4);
    for (let b = 0; b < this.blocks.length; b += 4) this.blocks.set([Infinity, Infinity, -Infinity, -Infinity], b);
    let maxLat = 0;
    for (let i = 0; i < coords.length; i++) {
      maxLat = Math.max(maxLat, Math.abs(coords[i][1]));
      if (i === n) break;
      const [a, b] = [coords[i], coords[i + 1]];
      const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      this.box.set(box, i * 4);
      const j = Math.floor(i / BLOCK) * 4;
      for (let c = 0; c < 4; c++) this.blocks[j + c] = c < 2 ? Math.min(this.blocks[j + c], box[c]) : Math.max(this.blocks[j + c], box[c]);
    }
    this.maxLat = maxLat;
  }

  /** The nearest point of the route to `p`. */
  locate(p: LonLat): Where {
    const near = this.nearest(p, Math.max(0, this.last - 20), Math.min(this.coords.length - 1, this.last + 400));
    // Nothing near where you were (a tunnel, the app in the background): look along the whole route,
    // nearest first, without favouring the old spot. The stretch found near is one of those, so
    // none further than it need be looked at.
    const best = near.off > 100 ? this.nearest(p, 0, this.coords.length - 1, false, near.off) : near;
    this.last = best.index;
    this.lastAlong = best.along;
    return best;
  }

  /** The point `along` metres from the start. */
  pointAt(along: number): LonLat {
    // The first stretch that reaches `along` (or the last), found by halving.
    let i = 0;
    let hi = Math.max(0, this.cum.length - 2);
    while (i < hi) {
      const mid = (i + hi) >> 1;
      if (this.cum[mid + 1] < along) i = mid + 1;
      else hi = mid;
    }
    const span = this.cum[i + 1] - this.cum[i];
    const t = span ? Math.max(0, Math.min(1, (along - this.cum[i]) / span)) : 0;
    const [a, b] = [this.coords[i], this.coords[Math.min(i + 1, this.coords.length - 1)]];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** Metres and driving seconds from `along` to the end. */
  left(along: number): { metres: number; seconds: number } {
    // The last point at or before `along`, found by halving.
    let i = 0;
    let hi = this.cum.length - 1;
    while (i < hi) {
      const mid = (i + hi) >> 1;
      if (this.cum[mid + 1] <= along) i = mid + 1;
      else hi = mid;
    }
    const j = Math.min(i + 1, this.cum.length - 1);
    const span = this.cum[j] - this.cum[i];
    const t = this.time[i] + (span ? (this.time[j] - this.time[i]) * ((along - this.cum[i]) / span) : 0);
    return { metres: Math.max(0, this.total - along), seconds: Math.max(0, this.time[this.time.length - 1] - t) };
  }

  /** The nearest stretch from … to - 1 to `p`. `within`: the best one's score is known to be at
   *  most this, so more can be skipped. */
  private nearest(p: LonLat, from: number, to: number, stay = true, within = Infinity): Where {
    const k = Math.cos(p[1] * (Math.PI / 180));
    // A stretch can't be nearer than its bounds: `metres` scales longitude by the cosine of the
    // mean latitude, never below this one. Stretches (and blocks of them) whose bounds are further
    // than the best so far are skipped (a score is never below the distance), so the whole route
    // is quick to search when you're off it.
    const kMin = Math.cos(Math.min(90, Math.max(Math.abs(p[1]), this.maxLat)) * (Math.PI / 180));
    const limitOf = (score: number) => {
      const deg = (Math.min(score, within) + 1e-6) / (M_PER_DEG * (1 - 1e-9));
      return deg * deg;
    };
    const far = (b: Float64Array, j: number, limit: number) => {
      const bx = Math.max(0, b[j] - p[0], p[0] - b[j + 2]) * kMin;
      const by = Math.max(0, b[j + 1] - p[1], p[1] - b[j + 3]);
      return bx * bx + by * by > limit;
    };
    const { box, blocks, coords } = this;
    let best = { along: 0, off: Infinity, index: 0, score: Infinity };
    let limit = limitOf(Infinity);
    for (let i = from; i < to; i++) {
      if (i % BLOCK === 0 && i + BLOCK <= to && far(blocks, (i / BLOCK) * 4, limit)) {
        i += BLOCK - 1;
        continue;
      }
      if (far(box, i * 4, limit)) continue;
      const [ax, ay] = [(coords[i][0] - p[0]) * k, coords[i][1] - p[1]];
      const [bx, by] = [(coords[i + 1][0] - p[0]) * k, coords[i + 1][1] - p[1]];
      const [dx, dy] = [bx - ax, by - ay];
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const q: LonLat = [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
      const off = metres(p, q);
      // Where the route passes close to itself (a hairpin, a block in town), the stretch near where
      // you were wins over a later one that's only slightly nearer: no skipping turns ahead.
      const keep = stay && this.lastAlong !== null;
      const along = keep ? this.cum[i] + metres(coords[i], q) : 0;
      const score = off + (keep ? Math.max(0, Math.abs(along - this.lastAlong!) - 150) * 0.1 : 0);
      if (score < best.score) {
        best = { along: keep ? along : this.cum[i] + metres(coords[i], q), off, index: i, score };
        limit = limitOf(score);
      }
    }
    if (from === to) return { along: this.cum[from], off: metres(p, coords[from]), index: from };
    return { along: best.along, off: best.off, index: best.index };
  }
}
