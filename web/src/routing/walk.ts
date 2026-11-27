import { Heap, metresBetween, UNITS_PER_DEG } from './graph';
import { lineMetres } from './snap';
import type { RoadClass } from './roadClass';

/**
 * Walking: a network of the paths and roads near a route, made from the map's drawn lines (the
 * routing network has the roads only, and on GPSmap.is none of the trails), and searches on it.
 *
 * Lines join where they share a point. Trails on GPSmap.is mostly don't share one with the roads
 * they meet (453 of 80,000 trail ends do): they stop a few metres short or cross the road. So a
 * line end that meets nothing joins the nearest line within JOIN_M, and a trail joins every line
 * it crosses. Roads that cross without a shared point are left apart (a bridge over a road).
 *
 * Nodes are only where lines end, meet or join; an edge runs along its line between two of them,
 * and its shape is the line's own points (the lines are views into the decoded map, not copies).
 */

/** A drawn line people can walk along: its points in map units (x, y in turn), and its road of the
 *  routing network (tile and NET offset), or `net` -1 for a trail. */
export interface WalkLine {
  xy: Int32Array;
  tile: number;
  net: number;
  cls: RoadClass;
}

/** The walkable lines of the finest-level subdivisions that reach a box (west, south, east,
 *  north; map units). */
export type WalkLines = (box: readonly [number, number, number, number]) => Promise<WalkLine[]>;

/** A line end that meets no other line joins the nearest one this close (m). */
export const JOIN_M = 15;

export interface WalkGraph {
  lines: WalkLine[];
  nodeX: Float64Array;
  nodeY: Float64Array;
  /** Edges of node u: edgeStart[u] … edgeStart[u + 1] - 1 (each edge is there both ways). An edge
   *  runs along line `edgeLine` from `edgeFrom` to `edgeTo` (where on the line: point index plus
   *  fraction), or straight for a join between lines (`edgeLine` -1). */
  edgeStart: Int32Array;
  edgeTarget: Int32Array;
  edgeLen: Float64Array;
  edgeLine: Int32Array;
  edgeFrom: Float64Array;
  edgeTo: Float64Array;
  /** Per line: its nodes in order along it, and where each lies on it. */
  lineNodes: Int32Array[];
  lineAt: Float64Array[];
  grid: SegmentGrid;
}

const M_PER_UNIT = metresBetween(0, 0, 0, 1);
const RAD_PER_UNIT = Math.PI / 180 / UNITS_PER_DEG;
/** A grid cell's side in map units (about 150 m north to south). */
const CELL = 64;
/** Fractions this close to a segment's ends are its ends. */
const EPS = 1e-6;

/** Segments by grid cell: cell → index into `start`, whose range in `items` lists the cell's
 *  segments as (line, segment) pairs. */
interface SegmentGrid {
  cells: Map<number, number>;
  start: Int32Array;
  items: Int32Array;
}

const cellKey = (cx: number, cy: number) => (cx + 0x100000) * 0x200000 + (cy + 0x100000);
// Decoded points are whole map units (±2^23 east-west, ±2^22 north-south).
const posKey = (x: number, y: number) => (x + 0x800000) * 0x1000000 + (y + 0x800000);

const pointCount = (l: WalkLine) => l.xy.length >> 1;

/** The cells a segment's bounds reach. */
function eachCell(ax: number, ay: number, bx: number, by: number, visit: (key: number) => void): void {
  for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) {
    for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) visit(cellKey(cx, cy));
  }
}

function segmentGrid(lines: WalkLine[]): SegmentGrid {
  const cells = new Map<number, number>();
  const counts: number[] = [];
  const each = (visit: (key: number, li: number, j: number) => void) =>
    lines.forEach((l, li) => {
      const xy = l.xy;
      for (let j = 0; j + 1 < pointCount(l); j++) eachCell(xy[2 * j], xy[2 * j + 1], xy[2 * j + 2], xy[2 * j + 3], (key) => visit(key, li, j));
    });
  each((key) => {
    let c = cells.get(key);
    if (c === undefined) cells.set(key, (c = counts.push(0) - 1));
    counts[c]++;
  });
  const start = new Int32Array(counts.length + 1);
  for (let c = 0; c < counts.length; c++) start[c + 1] = start[c] + counts[c];
  const fill = start.slice(0, counts.length);
  const items = new Int32Array(start[counts.length] * 2);
  each((key, li, j) => {
    const k = fill[cells.get(key)!]++;
    items[2 * k] = li;
    items[2 * k + 1] = j;
  });
  return { cells, start, items };
}

/** The point of segment a–b nearest to q, in a flat projection with x scaled by kx: its fraction
 *  along the segment and the distance in metres. */
function nearestOnSegment(ax: number, ay: number, bx: number, by: number, qx: number, qy: number, kx: number): { t: number; m: number } {
  const dx = (bx - ax) * kx;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, (((qx - ax) * kx) * dx + (qy - ay) * dy) / len2)) : 0;
  const ex = (ax + (bx - ax) * t - qx) * kx;
  const ey = ay + (by - ay) * t - qy;
  return { t, m: Math.sqrt(ex * ex + ey * ey) * M_PER_UNIT };
}

/** The nearest point within `maxM` metres of (x, y) on any line `accept` takes: its line,
 *  segment, fraction along it and distance; null when there's none. */
function nearestSegment(lines: WalkLine[], grid: SegmentGrid, x: number, y: number, maxM: number, accept: (li: number) => boolean = () => true): { li: number; j: number; t: number; m: number } | null {
  const ry = maxM / M_PER_UNIT;
  const kx = Math.cos(y * RAD_PER_UNIT);
  const rx = ry / Math.max(0.01, kx);
  let best: { li: number; j: number; t: number; m: number } | null = null;
  for (let cx = Math.floor((x - rx) / CELL); cx <= Math.floor((x + rx) / CELL); cx++) {
    for (let cy = Math.floor((y - ry) / CELL); cy <= Math.floor((y + ry) / CELL); cy++) {
      const c = grid.cells.get(cellKey(cx, cy));
      if (c === undefined) continue;
      for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
        const li = grid.items[2 * k];
        if (!accept(li)) continue;
        const j = grid.items[2 * k + 1];
        const xy = lines[li].xy;
        const near = nearestOnSegment(xy[2 * j], xy[2 * j + 1], xy[2 * j + 2], xy[2 * j + 3], x, y, kx);
        // Ties go to the earlier line and segment, so the result doesn't depend on cell order.
        if (near.m <= maxM && (!best || near.m < best.m || (near.m === best.m && (li < best.li || (li === best.li && j < best.j))))) best = { li, j, t: near.t, m: near.m };
      }
    }
  }
  return best;
}

/** Where segments a–b and c–d cross (fractions along each), when they do away from their ends. */
function crossing(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): { t: number; u: number } | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (!den) return null;
  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS ? { t, u } : null;
}

/** The point at `at` along a line (point index plus fraction). */
function pointAt(l: WalkLine, at: number): [number, number] {
  const n = pointCount(l);
  const j = Math.min(Math.floor(at), n - 1);
  const t = at - j;
  const xy = l.xy;
  if (t <= 0 || j + 1 >= n) return [xy[2 * j], xy[2 * j + 1]];
  return [xy[2 * j] + (xy[2 * j + 2] - xy[2 * j]) * t, xy[2 * j + 1] + (xy[2 * j + 3] - xy[2 * j + 1]) * t];
}

/** The line's shape from `p` to `q` (either way), both ends included. */
function alongPoints(l: WalkLine, p: number, q: number): Array<[number, number]> {
  const out: Array<[number, number]> = [pointAt(l, p)];
  const xy = l.xy;
  if (p <= q) for (let j = Math.floor(p) + 1; j < q; j++) out.push([xy[2 * j], xy[2 * j + 1]]);
  else for (let j = Math.ceil(p) - 1; j > q; j--) out.push([xy[2 * j], xy[2 * j + 1]]);
  out.push(pointAt(l, q));
  return out;
}

/** Metres along a line from `p` to `q` (either way). */
function alongMetres(l: WalkLine, p: number, q: number): number {
  if (p > q) [p, q] = [q, p];
  const xy = l.xy;
  let [px, py] = pointAt(l, p);
  let m = 0;
  for (let j = Math.floor(p) + 1; j < q; j++) {
    m += metresBetween(px, py, xy[2 * j], xy[2 * j + 1]);
    px = xy[2 * j];
    py = xy[2 * j + 1];
  }
  const [qx, qy] = pointAt(l, q);
  return m + metresBetween(px, py, qx, qy);
}

/** The walking network of `lines` (see the top of this file). */
export function buildWalkGraph(lines: WalkLine[]): WalkGraph {
  const grid = segmentGrid(lines);
  // Positions where two points of the lines meet (sorted keys, equal neighbours).
  let total = 0;
  for (const l of lines) total += pointCount(l);
  const keys = new Float64Array(total);
  let n = 0;
  for (const l of lines) for (let j = 0; j < pointCount(l); j++) keys[n++] = posKey(l.xy[2 * j], l.xy[2 * j + 1]);
  keys.sort();
  const shared = new Set<number>();
  for (let i = 1; i < keys.length; i++) if (keys[i] === keys[i - 1]) shared.add(keys[i]);

  const xs: number[] = [];
  const ys: number[] = [];
  const byPos = new Map<number, number>();
  const vertexNode = (x: number, y: number): number => {
    const k = posKey(x, y);
    let v = byPos.get(k);
    if (v === undefined) {
      v = xs.push(x) - 1;
      ys.push(y);
      byPos.set(k, v);
    }
    return v;
  };
  // Nodes along each line: [where, node]. Its ends and the points it shares, then joins and crossings.
  const along: Array<Array<[number, number]>> = lines.map((l) => {
    const list: Array<[number, number]> = [];
    const last = pointCount(l) - 1;
    for (let j = 0; j <= last; j++) {
      const x = l.xy[2 * j];
      const y = l.xy[2 * j + 1];
      if (j === 0 || j === last || shared.has(posKey(x, y))) list.push([j, vertexNode(x, y)]);
    }
    return list;
  });
  /** A node at `t` along segment j of line li. */
  const pointOn = (li: number, j: number, t: number): number => {
    const l = lines[li];
    if (t <= EPS || t >= 1 - EPS) {
      const k = t <= EPS ? j : j + 1;
      const v = vertexNode(l.xy[2 * k], l.xy[2 * k + 1]);
      along[li].push([k, v]);
      return v;
    }
    const [x, y] = pointAt(l, j + t);
    const v = xs.push(x) - 1;
    ys.push(y);
    along[li].push([j + t, v]);
    return v;
  };
  const joins: Array<[number, number, number]> = [];

  // Line ends that meet no other line: joined to the nearest line within JOIN_M.
  lines.forEach((l, li) => {
    const last = pointCount(l) - 1;
    for (const j of [0, last]) {
      const x = l.xy[2 * j];
      const y = l.xy[2 * j + 1];
      if (shared.has(posKey(x, y))) continue;
      const near = nearestSegment(lines, grid, x, y, JOIN_M, (k) => k !== li);
      if (near) joins.push([vertexNode(x, y), pointOn(near.li, near.j, near.t), near.m]);
    }
  });
  // Trails cross other lines without a shared point: a node where they cross.
  const seen = new Set<number>();
  lines.forEach((l, li) => {
    if (l.net >= 0) return;
    const a = l.xy;
    for (let j = 0; j + 1 < pointCount(l); j++) {
      seen.clear();
      eachCell(a[2 * j], a[2 * j + 1], a[2 * j + 2], a[2 * j + 3], (key) => {
        const c = grid.cells.get(key)!;
        for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
          const lk = grid.items[2 * k];
          const m = grid.items[2 * k + 1];
          // Each pair of trails once; a trail's own segments never.
          if (lk === li || (lines[lk].net < 0 && lk < li)) continue;
          const id = lk * 0x100000 + m;
          if (seen.has(id)) continue;
          seen.add(id);
          const b = lines[lk].xy;
          const x = crossing(a[2 * j], a[2 * j + 1], a[2 * j + 2], a[2 * j + 3], b[2 * m], b[2 * m + 1], b[2 * m + 2], b[2 * m + 3]);
          if (!x) continue;
          const v = pointOn(li, j, x.t);
          along[lk].push([m + x.u, v]);
        }
      });
    }
  });

  // Edges: along each line between its nodes, and the joins.
  const eFrom: number[] = [];
  const eTo: number[] = [];
  const eLen: number[] = [];
  const eLine: number[] = [];
  const eAtFrom: number[] = [];
  const eAtTo: number[] = [];
  const lineNodes: Int32Array[] = [];
  const lineAt: Float64Array[] = [];
  along.forEach((list, li) => {
    list.sort((p, q) => p[0] - q[0]);
    const nodes: number[] = [];
    const at: number[] = [];
    for (const [w, v] of list) {
      // The same node twice (a shared point also joined to); two at one spot are linked (0 m).
      if (nodes.length && nodes[nodes.length - 1] === v) continue;
      if (nodes.length) {
        eFrom.push(nodes[nodes.length - 1]);
        eTo.push(v);
        eLen.push(alongMetres(lines[li], at[at.length - 1], w));
        eLine.push(li);
        eAtFrom.push(at[at.length - 1]);
        eAtTo.push(w);
      }
      nodes.push(v);
      at.push(w);
    }
    lineNodes.push(Int32Array.from(nodes));
    lineAt.push(Float64Array.from(at));
  });
  for (const [u, v, m] of joins) {
    eFrom.push(u);
    eTo.push(v);
    eLen.push(m);
    eLine.push(-1);
    eAtFrom.push(0);
    eAtTo.push(0);
  }
  // Both ways, grouped by node.
  const count = xs.length;
  const edgeStart = new Int32Array(count + 1);
  for (let k = 0; k < eFrom.length; k++) {
    edgeStart[eFrom[k] + 1]++;
    edgeStart[eTo[k] + 1]++;
  }
  for (let u = 0; u < count; u++) edgeStart[u + 1] += edgeStart[u];
  const fill = edgeStart.slice(0, count);
  const m2 = eFrom.length * 2;
  const g: WalkGraph = {
    lines, nodeX: Float64Array.from(xs), nodeY: Float64Array.from(ys), edgeStart,
    edgeTarget: new Int32Array(m2), edgeLen: new Float64Array(m2), edgeLine: new Int32Array(m2), edgeFrom: new Float64Array(m2), edgeTo: new Float64Array(m2),
    lineNodes, lineAt, grid,
  };
  const put = (u: number, v: number, len: number, li: number, p: number, q: number) => {
    const i = fill[u]++;
    g.edgeTarget[i] = v;
    g.edgeLen[i] = len;
    g.edgeLine[i] = li;
    g.edgeFrom[i] = p;
    g.edgeTo[i] = q;
  };
  for (let k = 0; k < eFrom.length; k++) {
    put(eFrom[k], eTo[k], eLen[k], eLine[k], eAtFrom[k], eAtTo[k]);
    put(eTo[k], eFrom[k], eLen[k], eLine[k], eAtTo[k], eAtFrom[k]);
  }
  return g;
}

/** Where a point joins the walking network: the nearest point on a line (map units) and how far
 *  that is, where on the line it lies, and the line's nodes either side of it (a before, b after)
 *  with the metres along the line to each. */
export interface WalkAnchor {
  x: number;
  y: number;
  offM: number;
  line: number;
  at: number;
  a: number;
  b: number;
  /** Where on the line nodes a and b lie. */
  atA: number;
  atB: number;
  da: number;
  db: number;
}

/** The nearest point of the network to (x, y) (map units) within `maxM` metres, or null. */
export function snapWalk(g: WalkGraph, x: number, y: number, maxM: number): WalkAnchor | null {
  // Growing circles: a near line is found without scanning every cell of the whole radius.
  let near: ReturnType<typeof nearestSegment> = null;
  for (let r = Math.min(200, maxM); ; r = Math.min(r * 4, maxM)) {
    near = nearestSegment(g.lines, g.grid, x, y, r);
    if (near || r >= maxM) break;
  }
  if (!near) return null;
  const l = g.lines[near.li];
  const at = near.j + near.t;
  const [px, py] = pointAt(l, at);
  const ats = g.lineAt[near.li];
  const nodes = g.lineNodes[near.li];
  let k = 0;
  while (k + 2 < ats.length && ats[k + 1] <= at) k++;
  const kb = Math.min(k + 1, nodes.length - 1);
  return {
    x: px, y: py, offM: near.m, line: near.li, at, a: nodes[k], b: nodes[kb], atA: ats[k], atB: ats[kb],
    da: alongMetres(l, at, ats[k]), db: alongMetres(l, at, ats[kb]),
  };
}

/** A way found on the network: its points (map units) and its length in metres. */
export interface WalkPath {
  points: Array<[number, number]>;
  metres: number;
}

/**
 * Shortest way (metres plus each seed's cost) from the seeds to a node `end` says can end it (its
 * extra cost; Infinity: it can't), searching no further than `maxCost`, `h` an estimate of the
 * rest that never overshoots: the seed it starts at, the edges, and the total; or null.
 */
function search(g: WalkGraph, seeds: Array<[number, number]>, end: (v: number) => number, h: (v: number) => number, maxCost: number): { first: number; last: number; edges: number[]; cost: number } | null {
  const n = g.nodeX.length;
  const best = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new Heap();
  for (const [s, cost] of seeds) {
    if (cost < best[s]) {
      best[s] = cost;
      heap.push(cost + h(s), s);
    }
  }
  let bestTotal = Infinity;
  let last = -1;
  while (heap.size) {
    if (heap.topKey >= bestTotal || heap.topKey > maxCost) break;
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const x = end(u);
    if (best[u] + x < bestTotal) {
      bestTotal = best[u] + x;
      last = u;
    }
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
      const v = g.edgeTarget[e];
      const c = best[u] + g.edgeLen[e];
      if (!done[v] && c < best[v]) {
        best[v] = c;
        via[v] = e;
        from[v] = u;
        heap.push(c + h(v), v);
      }
    }
  }
  if (last < 0 || bestTotal > maxCost) return null;
  const edges: number[] = [];
  let first = last;
  while (via[first] >= 0) {
    edges.push(via[first]);
    first = from[first];
  }
  return { first, last, edges: edges.reverse(), cost: bestTotal };
}

/** Where on its line an anchor's node `v` is: on a closed line both sides can be the same node,
 *  and the way leaves by the nearer. */
function sideAt(an: WalkAnchor, v: number): number {
  if (an.a === an.b) return an.da <= an.db ? an.atA : an.atB;
  return v === an.a ? an.atA : an.atB;
}

/** The shape of a found way: from the anchor's point along its line to the first node, along the
 *  edges, and (with `to`) along the last line to that anchor's point. */
function shapeOf(g: WalkGraph, from: WalkAnchor, found: { first: number; edges: number[]; last: number }, to: WalkAnchor | null): Array<[number, number]> {
  const node = (v: number): [number, number] => [g.nodeX[v], g.nodeY[v]];
  const pts = alongPoints(g.lines[from.line], from.at, sideAt(from, found.first));
  pts.push(node(found.first));
  for (const e of found.edges) {
    const li = g.edgeLine[e];
    if (li >= 0) pts.push(...alongPoints(g.lines[li], g.edgeFrom[e], g.edgeTo[e]).slice(1));
    else pts.push(node(g.edgeTarget[e]));
  }
  if (to) pts.push(...alongPoints(g.lines[to.line], sideAt(to, found.last), to.at));
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

/** The shortest way along the network between two anchors. */
export function walkBetween(g: WalkGraph, from: WalkAnchor, to: WalkAnchor): WalkPath | null {
  // Straight-line metres to the destination's point, a little short (never more than the way):
  // east-west at the more polar latitude's scale.
  const h = (v: number) => {
    const dx = (g.nodeX[v] - to.x) * Math.cos(Math.max(Math.abs(g.nodeY[v]), Math.abs(to.y)) * RAD_PER_UNIT);
    const dy = g.nodeY[v] - to.y;
    return Math.sqrt(dx * dx + dy * dy) * M_PER_UNIT * 0.995;
  };
  const end = (v: number) => Math.min(v === to.a ? to.da : Infinity, v === to.b ? to.db : Infinity);
  const found = search(g, [[from.a, from.da], [from.b, from.db]], end, h, Infinity);
  // Both on the same piece of line: straight along it may be shorter than by any node.
  if (from.line === to.line && from.a === to.a && from.b === to.b) {
    const pts = alongPoints(g.lines[from.line], from.at, to.at);
    const metres = lineMetres(pts);
    if (!found || metres <= found.cost) return { points: pts, metres };
  }
  if (!found) return null;
  const points = shapeOf(g, from, found, to);
  return { points, metres: lineMetres(points) };
}

/** Walking across country (off the network) counts this many times its length when the way on
 *  foot to a road is chosen: rough ground, no path. */
export const OFF_PATH_COST = 2;
/** A path that stops short of a road may end this close to one (m): the rest across country
 *  (Glymur's trail ends at the car park, 150 m from the road). */
export const TO_ROAD_HOP_M = 300;

/**
 * The way on foot from a point off the roads to a road a car can use (`drivable`), along paths
 * (and at most TO_ROAD_HOP_M across country from where they stop), when that counts for less than
 * walking `straightM` metres straight to the nearest such road (see OFF_PATH_COST); null
 * otherwise. Its points run from the point to the road.
 */
export function walkToRoad(g: WalkGraph, x: number, y: number, straightM: number, drivable: (line: WalkLine) => boolean): WalkPath | null {
  const limit = OFF_PATH_COST * straightM;
  const at = snapWalk(g, x, y, straightM);
  if (!at) return null;
  const road = Uint8Array.from(g.lines, (l) => (drivable(l) ? 1 : 0));
  const onRoad = (u: number) => {
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) if (g.edgeLine[e] >= 0 && road[g.edgeLine[e]]) return true;
    return false;
  };
  // Where a path stops (a node with one edge), the nearest road within the hop.
  const hops = new Map<number, ReturnType<typeof nearestSegment>>();
  const hop = (v: number) => {
    if (g.edgeStart[v + 1] - g.edgeStart[v] !== 1) return null;
    if (!hops.has(v)) hops.set(v, nearestSegment(g.lines, g.grid, g.nodeX[v], g.nodeY[v], TO_ROAD_HOP_M, (li) => road[li] === 1));
    return hops.get(v)!;
  };
  const end = (v: number) => {
    if (onRoad(v)) return 0;
    const h = hop(v);
    return h ? OFF_PATH_COST * h.m : Infinity;
  };
  const off = OFF_PATH_COST * at.offM;
  const found = search(g, [[at.a, off + at.da], [at.b, off + at.db]], end, () => 0, limit);
  // Only a clear gain: about the same as straight, straight it is.
  if (!found || found.cost > limit - 1) return null;
  const points = [[x, y] as [number, number], ...shapeOf(g, at, found, null)];
  const last = onRoad(found.last) ? null : hop(found.last);
  const tail = points[points.length - 1];
  if (last) {
    const p = pointAt(g.lines[last.li], last.j + last.t);
    if (p[0] !== tail[0] || p[1] !== tail[1]) points.push(p);
  }
  return { points, metres: lineMetres(points) };
}
