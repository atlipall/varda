import { canArrive, canLeave, EDGE_FROAD, edgeSource, metresBetween, UNITS_PER_DEG, type NodeIndex, type RoadGraph } from './graph';
import type { RoadClass } from './roadClass';

/** A routable road line (finest level, NET-labelled) in map units, with its road (tile index, NET
 *  offset) and class. */
export interface RoadLine {
  tile: number;
  net: number;
  cls: RoadClass;
  coords: Array<[number, number]>;
  /** The road's name or number as the map labels it, and its Garmin line type (for turn
   *  instructions); absent in synthetic test lines. */
  name?: string | null;
  type?: number;
}

/** Road lines that may come within `radiusM` metres of (x, y) (map units): those of every
 *  subdivision whose bounds reach that box. Must return the same line objects for the same line
 *  within one route request (lines are told apart by identity when joining them). `through`, when
 *  there, gives what linesThrough does, faster. */
export type RoadLines = ((x: number, y: number, radiusM: number) => Promise<RoadLine[]>) & {
  through?: (x: number, y: number) => Promise<Array<{ line: RoadLine; i: number }>>;
};

/** The lines with a vertex at exactly (x, y), with each such vertex, in the order `lines` gives
 *  them and then by vertex. */
export async function linesThrough(lines: RoadLines, x: number, y: number): Promise<Array<{ line: RoadLine; i: number }>> {
  if (lines.through) return lines.through(x, y);
  const out: Array<{ line: RoadLine; i: number }> = [];
  for (const line of await lines(x, y, 0)) {
    for (let i = 0; i < line.coords.length; i++) if (line.coords[i][0] === x && line.coords[i][1] === y) out.push({ line, i });
  }
  return out;
}

/** A line's bounds (map units: west, south, east, north), worked out once per line. */
const boxes = new WeakMap<RoadLine, Float64Array>();

function boxOf(line: RoadLine): Float64Array {
  let b = boxes.get(line);
  if (!b) {
    b = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
    for (const [x, y] of line.coords) {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
    boxes.set(line, b);
  }
  return b;
}

/** Whether every point of `line` is further than `metres` from q (map units), in nearestOnLine's
 *  flat projection (x scaled by kx): its bounds are. Never true of a line that comes that near. */
export function beyond(line: RoadLine, qx: number, qy: number, kx: number, metres: number): boolean {
  const b = boxOf(line);
  const dx = Math.max(0, b[0] - qx, qx - b[2]) * kx;
  const dy = Math.max(0, b[1] - qy, qy - b[3]);
  // A hair of slack for rounding: this only skips work.
  return Math.sqrt(dx * dx + dy * dy) * M_PER_UNIT > metres * (1 + 1e-9) + 1e-6;
}

/** One way off the snapped point to a graph node. `leave`/`arrive`: the speed (km/h) of travelling
 *  from the point to the node / from the node to the point, 0 when the road doesn't allow it. */
export interface Side {
  node: number;
  metres: number;
  /** Map units, from the snapped point to the node. */
  path: Array<[number, number]>;
  leave: number;
  arrive: number;
}

/** Where a route end joins the road network. */
export interface Anchor {
  /** The snapped point on the road (or the fallback node), map units. */
  at: [number, number];
  /** Metres from the chosen point to `at`. */
  offM: number;
  sides: Side[];
  /** The stretch between the two nodes of the road the point lies on (null for a fallback node):
   *  its shape from `u` to `v` and the point's distance along it. */
  stretch: { tile: number; net: number; u: number; v: number; line: Array<[number, number]>; along: number } | null;
}

/** How far out to look for a road, in steps (metres). */
export const SNAP_STEPS_M = [2000, 10_000, 50_000];
/** Most lines tried per step before falling back to the nearest node. */
const MAX_TRIES = 50;
/** Most line pieces followed in one direction when a road is drawn as several lines. */
const MAX_JOINS = 100;

const M_PER_UNIT = metresBetween(0, 0, 0, 1);

/** Nearest point of `line` to q, in a local flat projection (fine at these distances). */
export function nearestOnLine(line: Array<[number, number]>, qx: number, qy: number, kx: number): { i: number; t: number; x: number; y: number; d2: number } {
  let best = { i: 0, t: 0, x: line[0][0], y: line[0][1], d2: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = (bx - ax) * kx;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? (((qx - ax) * kx) * dx + (qy - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const ex = (px - qx) * kx;
    const ey = py - qy;
    const d2 = ex * ex + ey * ey;
    if (d2 < best.d2) best = { i, t, x: px, y: py, d2 };
  }
  if (line.length === 1) best.d2 = ((line[0][0] - qx) * kx) ** 2 + (line[0][1] - qy) ** 2;
  return best;
}

const lengthOf = (path: Array<[number, number]>) => {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += metresBetween(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  return m;
};

/** Per graph: the edges into each node, CSR by target (built on first use). */
const inEdges = new WeakMap<RoadGraph, { start: Int32Array; edges: Int32Array }>();

export function incoming(g: RoadGraph, v: number): Int32Array {
  let r = inEdges.get(g);
  if (!r) {
    const n = g.nodeX.length;
    const start = new Int32Array(n + 1);
    for (let e = 0; e < g.edgeTo.length; e++) start[g.edgeTo[e] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n);
    const edges = new Int32Array(g.edgeTo.length);
    for (let e = 0; e < g.edgeTo.length; e++) edges[fill[g.edgeTo[e]]++] = e;
    inEdges.set(g, (r = { start, edges }));
  }
  return r.edges.subarray(r.start[v], r.start[v + 1]);
}

const sameXY = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

/** Speed (km/h) of the edge u→v on road (tile, net) that the route may use, or 0 when there's none. */
function edgeSpeed(g: RoadGraph, u: number, v: number, tile: number, net: number, allowFRoads: boolean): number {
  for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
    if (g.edgeTo[e] !== v || g.edgeTile[e] !== tile || g.edgeNet[e] !== net) continue;
    if (!allowFRoads && g.edgeFlags[e] & EDGE_FROAD) continue;
    return g.edgeSpeed[e];
  }
  return 0;
}

/**
 * Snaps route ends to the nearest point on a road line (not just the nearest junction), searching
 * outward in steps up to 50 km; with F-roads not allowed only normal roads count. From that point
 * the road is followed both ways to the nearest graph nodes (road-line vertices and NOD nodes share
 * exact coordinates), joining the next line of the same road where one ends short of a node.
 */
export class Snapper {
  constructor(
    private readonly g: RoadGraph,
    private readonly index: NodeIndex,
    private readonly lines: RoadLines,
  ) {}

  /** The anchor for a route start (`start`) or destination at [lon, lat], or null when there's no
   *  usable road within 50 km. */
  async snap(p: [number, number], start: boolean, allowFRoads: boolean): Promise<Anchor | null> {
    const qx = Math.round(p[0] * UNITS_PER_DEG);
    const qy = Math.round(p[1] * UNITS_PER_DEG);
    const kx = Math.cos((p[1] * Math.PI) / 180);
    for (const radius of SNAP_STEPS_M) {
      const found = (await this.lines(qx, qy, radius))
        .filter((l) => (allowFRoads || l.cls === 0) && l.coords.length > 0 && !beyond(l, qx, qy, kx, radius))
        .map((l) => ({ l, near: nearestOnLine(l.coords, qx, qy, kx) }))
        .map((c) => ({ ...c, m: Math.sqrt(c.near.d2) * M_PER_UNIT }))
        .filter((c) => c.m <= radius)
        .sort((a, b) => a.m - b.m);
      for (const c of found.slice(0, MAX_TRIES)) {
        const anchor = await this.onLine(c.l, c.near, allowFRoads);
        if (anchor && anchor.sides.some((s) => (start ? s.leave : s.arrive) > 0)) {
          anchor.offM = metresBetween(qx, qy, anchor.at[0], anchor.at[1]);
          return anchor;
        }
      }
      // No line leads to a usable node: the nearest node that can be left (start) or reached (end).
      const ok = (v: number) => (start ? canLeave(this.g, v, allowFRoads) : canArrive(this.g, v, allowFRoads));
      const n = this.index.nearest(p[0], p[1], radius, ok);
      if (n) {
        const at: [number, number] = [this.g.nodeX[n.node], this.g.nodeY[n.node]];
        return { at, offM: n.metres, sides: [{ node: n.node, metres: 0, path: [at], leave: 1, arrive: 1 }], stretch: null };
      }
    }
    return null;
  }

  /** The anchor at the point `near` of `line`, or null when the stretch it lies on can't be tied to
   *  a pair of main-network nodes joined by an edge of this road. */
  private async onLine(line: RoadLine, near: { i: number; t: number; x: number; y: number }, allowFRoads: boolean): Promise<Anchor | null> {
    const at: [number, number] = [near.x, near.y];
    const back = await this.walk(line, near.i, -1, at);
    const ahead = await this.walk(line, near.i + 1, 1, at);
    if (!back || !ahead) return this.oneSide(line, at, back ?? ahead, allowFRoads);
    if (back.node === ahead.node) return null;
    const u = back.node;
    const v = ahead.node;
    if (!this.index.inMain(u) || !this.index.inMain(v)) return null;
    const uv = edgeSpeed(this.g, u, v, line.tile, line.net, allowFRoads);
    const vu = edgeSpeed(this.g, v, u, line.tile, line.net, allowFRoads);
    if (!uv && !vu) return null;
    const dU = lengthOf(back.path);
    const dV = lengthOf(ahead.path);
    return {
      at,
      offM: 0,
      // Towards u means travelling v→u, towards v travelling u→v.
      sides: [
        { node: u, metres: dU, path: back.path, leave: vu, arrive: uv },
        { node: v, metres: dV, path: ahead.path, leave: uv, arrive: vu },
      ],
      stretch: { tile: line.tile, net: line.net, u, v, line: [...back.path].reverse().concat(ahead.path.slice(1)), along: dU },
    };
  }

  /** The anchor when the road runs out (no node, no next line) in one direction from `at`: only the
   *  side towards the node found. Its speed and direction come from that node's edges on this road
   *  that head towards `at` (the other end of such an edge is unknown here). */
  private oneSide(line: RoadLine, at: [number, number], found: { node: number; path: Array<[number, number]> } | null, allowFRoads: boolean): Anchor | null {
    if (!found || !this.index.inMain(found.node)) return null;
    const n = found.node;
    const g = this.g;
    const nx = g.nodeX[n];
    const ny = g.nodeY[n];
    // The road's direction at n towards `at`: its vertex before n (none when `at` is n itself).
    const prev = found.path.length >= 2 ? found.path[found.path.length - 2] : null;
    const kx = Math.cos((ny / UNITS_PER_DEG) * (Math.PI / 180));
    const towardAt = (w: number) => !prev || ((g.nodeX[w] - nx) * kx) * ((prev[0] - nx) * kx) + (g.nodeY[w] - ny) * (prev[1] - ny) > 0;
    let leave = 0; // at → n: an edge w → n from the side of `at`
    let arrive = 0; // n → at: an edge n → w towards `at`
    const usable = (e: number) => g.edgeTile[e] === line.tile && g.edgeNet[e] === line.net && (allowFRoads || !(g.edgeFlags[e] & EDGE_FROAD));
    for (let e = g.edgeStart[n]; e < g.edgeStart[n + 1]; e++) {
      if (usable(e) && towardAt(g.edgeTo[e])) arrive = Math.max(arrive, g.edgeSpeed[e]);
    }
    for (const e of incoming(g, n)) {
      if (usable(e) && towardAt(edgeSource(g, e))) leave = Math.max(leave, g.edgeSpeed[e]);
    }
    if (!leave && !arrive) return null;
    return { at, offM: 0, sides: [{ node: n, metres: lengthOf(found.path), path: found.path, leave, arrive }], stretch: null };
  }

  private walk(line: RoadLine, i: number, dir: 1 | -1, at: [number, number]): Promise<{ node: number; path: Array<[number, number]> } | null> {
    return followRoad(this.lines, this.index, line, i, dir, at);
  }
}

/** Follows the road from `at` through vertex `i` of `line` in direction `dir` to the first graph
 *  node, continuing onto the next line of the same road when a line ends first. Null when the road
 *  runs out first. */
export async function followRoad(lines: RoadLines, index: NodeIndex, line: RoadLine, i: number, dir: 1 | -1, at: [number, number]): Promise<{ node: number; path: Array<[number, number]> } | null> {
  const path: Array<[number, number]> = [at];
  let cur = line;
  for (let joins = 0; joins <= MAX_JOINS; joins++) {
    const c = cur.coords;
    for (; i >= 0 && i < c.length; i += dir) {
      if (!sameXY(path[path.length - 1], c[i])) path.push(c[i]);
      const node = index.nodeAt(c[i][0], c[i][1]);
      if (node >= 0) return { node, path };
    }
    // The line ends short of a node: the road goes on in another line starting or ending here.
    const end = path[path.length - 1];
    const next = (await linesThrough(lines, end[0], end[1])).find(({ line: l, i: k }) => l !== cur && l.tile === cur.tile && l.net === cur.net && (k === 0 || k === l.coords.length - 1))?.line;
    if (!next) return null;
    cur = next;
    const forward = sameXY(next.coords[0], end);
    dir = forward ? 1 : -1;
    i = forward ? 1 : next.coords.length - 2;
  }
  return null;
}

/** The part of `line` between distances `a` < `b` along it (metres), both ends interpolated. */
export function cutLine(line: Array<[number, number]>, a: number, b: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = 0;
  const at = (i: number, d: number, len: number): [number, number] => {
    const t = len ? (d - s) / len : 0;
    return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const len = metresBetween(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
    if (!out.length && a <= s + len) out.push(at(i, a, len));
    if (out.length && b <= s + len) {
      out.push(at(i, b, len));
      return out;
    }
    if (out.length && !sameXY(out[out.length - 1], line[i + 1])) out.push(line[i + 1]);
    s += len;
  }
  if (!out.length) out.push(line[line.length - 1]);
  if (out.length === 1) out.push(line[line.length - 1]);
  return out;
}

export { lengthOf as lineMetres };
