import { pairs, type RawObject } from '../img/rgn';
import type { Subdivision } from '../img/tre';
import { objectName, type GarminMap, type MapTile } from '../map/garminMap';
import { boundsOf, paddedSubdivisionBounds } from '../tiles/buildTile';
import { EDGE_FROAD, edgeSource, metresBetween, UNITS_PER_DEG, type NodeIndex, type RoadGraph, type Route } from './graph';
import type { RoadSeg, Shaped } from './plan';
import type { RoadClass, RoadClasses } from './roadClass';
import { followRoad, incoming, linesThrough, type RoadLine, type RoadLines } from './snap';

/**
 * The route drawn along its roads: each edge follows its road (the lines with the edge's tile and
 * NET offset, from `lines`) from one end node to the other, across the several lines a road is
 * often drawn as. An edge whose road can't be followed to its other end is drawn straight.
 */
export async function routeShape(g: RoadGraph, index: NodeIndex, route: Route, lines: RoadLines): Promise<Shaped> {
  const deg = (p: [number, number]): [number, number] => [p[0] / UNITS_PER_DEG, p[1] / UNITS_PER_DEG];
  const coords: Array<[number, number]> = [];
  const segs: RoadSeg[] = [];
  let prev = route.nodes[0];
  coords.push(deg([g.nodeX[prev], g.nodeY[prev]]));
  for (const e of route.edges) {
    const v = g.edgeTo[e];
    const a: [number, number] = [g.nodeX[prev], g.nodeY[prev]];
    const b: [number, number] = [g.nodeX[v], g.nodeY[v]];
    const found = g.edgeNet[e] >= 0 ? await along(lines, index, g.edgeTile[e], g.edgeNet[e], a, v) : null;
    segs.push({
      start: coords.length - 1, name: found?.line.name ?? null, type: found?.line.type ?? 0, junction: isJunction(g, prev), seconds: g.edgeLen[e] / (g.edgeSpeed[e] / 3.6),
      ...(g.edgeFlags[e] & EDGE_FROAD ? { highland: true } : {}),
    });
    for (const p of (found?.path ?? [a, b]).slice(1)) coords.push(deg(p));
    prev = v;
  }
  return { coords, segs };
}

/** A node where three or more roads meet (somewhere a driver has a choice): one joined to at least
 *  three different nodes, by edges out of it or into it. */
function isJunction(g: RoadGraph, u: number): boolean {
  const near = new Set<number>();
  // Edges into it too: one-way streets and dual carriageways lead only one way.
  for (const e of incoming(g, u)) near.add(edgeSource(g, e));
  for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) near.add(g.edgeTo[e]);
  return near.size >= 3;
}

/** The road (tile, NET) from node point `a` to node `v`: from each place `a` lies on a line of that
 *  road, followed both ways to the next node; the way that arrives at `v`. */
async function along(lines: RoadLines, index: NodeIndex, tile: number, net: number, a: [number, number], v: number): Promise<{ path: Array<[number, number]>; line: RoadLine } | null> {
  for (const { line, i } of await linesThrough(lines, a[0], a[1])) {
    if (line.tile !== tile || line.net !== net) continue;
    for (const dir of [1, -1] as const) {
      const got = await followRoad(lines, index, line, i + dir, dir, a);
      if (got?.node === v) return { path: got.path, line };
    }
  }
  return null;
}

/** The finest-level subdivisions of a map, in the order the tiles list them, with a grid over
 *  their padded bounds (map units) so a lookup reads only the few near a point. Made once per map. */
interface SubdivisionGrid {
  bits: number;
  /** Per subdivision k, in map order: its tile's index, the subdivision, and its padded bounds
   *  (w, s, e, n at 4k … 4k + 3). */
  tileOf: Int32Array;
  sds: Subdivision[];
  bounds: Float64Array;
  /** Per tile: bounds in map units (w, s, e, n). */
  tileBounds: Float64Array;
  cell: number;
  /** Cell key → subdivisions (ascending) whose padded bounds reach the cell. */
  cells: Map<number, number[]>;
}

const grids = new WeakMap<GarminMap, SubdivisionGrid>();

const cellKey = (cx: number, cy: number) => cx * 0x200000 + cy;

function gridOf(map: GarminMap): SubdivisionGrid {
  const have = grids.get(map);
  if (have) return have;
  const bits = Math.max(...map.bands.keys());
  const sds: Subdivision[] = [];
  const tiles: number[] = [];
  const box: number[] = [];
  const tileBounds = new Float64Array(map.tiles.length * 4);
  map.tiles.forEach((tile, i) => {
    const t = tile.tre;
    tileBounds.set([t.west * UNITS_PER_DEG, t.south * UNITS_PER_DEG, t.east * UNITS_PER_DEG, t.north * UNITS_PER_DEG], i * 4);
    for (const sd of tile.byLevel.get(bits) ?? []) {
      sds.push(sd);
      tiles.push(i);
      box.push(...paddedSubdivisionBounds(sd));
    }
  });
  const bounds = Float64Array.from(box);
  // Cells about a typical subdivision's size: each one in a few cells, a few in each.
  const sizes = sds.map((_, k) => Math.max(bounds[k * 4 + 2] - bounds[k * 4], bounds[k * 4 + 3] - bounds[k * 4 + 1])).sort((a, b) => a - b);
  const cell = Math.max(256, Math.ceil(sizes[sizes.length >> 1] ?? 0));
  const cells = new Map<number, number[]>();
  for (let k = 0; k < sds.length; k++) {
    for (let cx = Math.floor(bounds[k * 4] / cell); cx <= Math.floor(bounds[k * 4 + 2] / cell); cx++) {
      for (let cy = Math.floor(bounds[k * 4 + 1] / cell); cy <= Math.floor(bounds[k * 4 + 3] / cell); cy++) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list) list.push(k);
        else cells.set(key, [k]);
      }
    }
  }
  const grid = { bits, tileOf: Int32Array.from(tiles), sds, bounds, tileBounds, cell, cells };
  grids.set(map, grid);
  return grid;
}

/** Subdivisions (indices into the grid, ascending: map order) whose padded bounds reach the box
 *  x ± rx, y ± ry, in tiles whose bounds (with a margin for rounding) reach it. */
function subdivisionsNear(grid: SubdivisionGrid, x: number, y: number, rx: number, ry: number): number[] {
  const { cell, bounds, tileBounds, tileOf } = grid;
  const x0 = Math.floor((x - rx) / cell);
  const x1 = Math.floor((x + rx) / cell);
  const y0 = Math.floor((y - ry) / cell);
  const y1 = Math.floor((y + ry) / cell);
  let found: number[] = [];
  if (x0 === x1 && y0 === y1) found = grid.cells.get(cellKey(x0, y0)) ?? [];
  else {
    const seen = new Set<number>();
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const k of grid.cells.get(cellKey(cx, cy)) ?? []) seen.add(k);
    found = [...seen].sort((a, b) => a - b);
  }
  const m = 0.01 * UNITS_PER_DEG;
  return found.filter((k) => {
    const t = tileOf[k] * 4;
    if (x + rx + m < tileBounds[t] || x - rx - m > tileBounds[t + 2] || y + ry + m < tileBounds[t + 1] || y - ry - m > tileBounds[t + 3]) return false;
    return !(x + rx < bounds[k * 4] || x - rx > bounds[k * 4 + 2] || y + ry < bounds[k * 4 + 1] || y - ry > bounds[k * 4 + 3]);
  });
}

/** A subdivision's road lines, and (made on first use) its vertices bucketed by position for
 *  finding the lines through a point: bucket b's vertices are start[b] … start[b + 1] - 1 of
 *  `line`/`at` (a line's index and the vertex's), in line then vertex order. */
interface SubdivisionLines {
  classes: RoadClasses;
  lines: RoadLine[];
  vertices?: { mask: number; start: Int32Array; line: Int32Array; at: Int32Array };
}

/** Per decoded subdivision (the worker's cache's objects, so these go when it lets them go). */
const linesOfObjects = new WeakMap<RawObject[], SubdivisionLines>();

/** A position's bucket (whole map units; a fraction is dropped, so check the match). */
function bucket(x: number, y: number, mask: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ y;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= h >>> 13;
  return h & mask;
}

function verticesOf(s: SubdivisionLines): NonNullable<SubdivisionLines['vertices']> {
  if (s.vertices) return s.vertices;
  let n = 0;
  for (const l of s.lines) n += l.coords.length;
  let size = 16;
  while (size < n) size *= 2;
  const mask = size - 1;
  const start = new Int32Array(size + 1);
  for (const l of s.lines) for (const [x, y] of l.coords) start[bucket(x, y, mask) + 1]++;
  for (let b = 0; b < size; b++) start[b + 1] += start[b];
  const fill = start.slice(0, size);
  const line = new Int32Array(n);
  const at = new Int32Array(n);
  s.lines.forEach((l, li) => {
    for (let i = 0; i < l.coords.length; i++) {
      const k = fill[bucket(l.coords[i][0], l.coords[i][1], mask)]++;
      line[k] = li;
      at[k] = i;
    }
  });
  return (s.vertices = { mask, start, line, at });
}

/** The lines of `s` with a vertex at exactly (x, y), with that vertex, in line then vertex order. */
function throughIn(s: SubdivisionLines, x: number, y: number, out: Array<{ line: RoadLine; i: number }>): void {
  const v = verticesOf(s);
  const b = bucket(x, y, v.mask);
  for (let k = v.start[b]; k < v.start[b + 1]; k++) {
    const line = s.lines[v.line[k]];
    const p = line.coords[v.at[k]];
    if (p[0] === x && p[1] === y) out.push({ line, i: v.at[k] });
  }
}

/** Road classes by NET offset per tile, made once per map and table. */
const classTables = new WeakMap<GarminMap, { classes: RoadClasses; byTile: Array<Map<number, RoadClass>> }>();

function classesByTile(map: GarminMap, classes: RoadClasses): Array<Map<number, RoadClass>> {
  const have = classTables.get(map);
  if (have?.classes === classes) return have.byTile;
  const byTile = map.tiles.map((t) => new Map<number, RoadClass>(classes[t.id] ?? []));
  classTables.set(map, { classes, byTile });
  return byTile;
}

/** A decoded line's points (map units): the one place a decoded object's coordinates are read. */
const lineCoords = (o: RawObject): Array<[number, number]> => pairs(o.xy);

/**
 * Road lines for snapping (see ./snap.ts): the routable lines (`labelSrc === 'net'`) of the
 * finest-level subdivisions whose padded bounds reach the box around a point, decoded via `decode`
 * (the worker's cache), each with its road class from `classes`. The lines through a point are
 * found from the subdivisions' vertices bucketed by position (`through`). A line is the same object
 * each time it's returned by one source (one route request), and while its subdivision stays in
 * the worker's cache, across requests too.
 */
export function roadLineSource(map: GarminMap, decode: (tile: MapTile, sd: Subdivision) => Promise<RawObject[]>, classes: RoadClasses): RoadLines {
  const grid = gridOf(map);
  const made = new Map<number, Promise<SubdivisionLines>>();
  const classOf = classesByTile(map, classes);
  const unitsPerM = 1 / metresBetween(0, 0, 0, 1);
  const make = async (k: number): Promise<SubdivisionLines> => {
    const i = grid.tileOf[k];
    const tile = map.tiles[i];
    const objs = await decode(tile, grid.sds[k]);
    const have = linesOfObjects.get(objs);
    if (have?.classes === classes) return have;
    // Only the road lines' names are looked up (a subdivision's other labels cost far more).
    const roads = objs.filter((o) => o.kind === 'line' && o.labelSrc === 'net');
    await map.withLabels(tile, roads);
    // The cache's bounds of each object, made once per decoded subdivision.
    const bounds = boundsOf(objs);
    const lines: RoadLine[] = [];
    objs.forEach((o, j) => {
      if (o.kind !== 'line' || o.labelSrc !== 'net') return;
      lines.push({ tile: i, net: o.label, cls: classOf[i].get(o.label) ?? 0, coords: lineCoords(o), name: objectName(tile, o), type: o.type, box: bounds.subarray(j * 4, j * 4 + 4) });
    });
    const s = { classes, lines };
    linesOfObjects.set(objs, s);
    return s;
  };
  // Promises, so lines asked for twice at once are still made once.
  const linesOf = (k: number): Promise<SubdivisionLines> => {
    let p = made.get(k);
    if (!p) made.set(k, (p = make(k)));
    return p;
  };
  const near = (x: number, y: number, radiusM: number): Promise<SubdivisionLines[]> => {
    const ry = radiusM * unitsPerM;
    const rx = ry / Math.max(0.01, Math.cos((y / UNITS_PER_DEG) * (Math.PI / 180)));
    return Promise.all(subdivisionsNear(grid, x, y, rx, ry).map(linesOf));
  };
  const lines: RoadLines = async (x, y, radiusM) => (await near(x, y, radiusM)).flatMap((s) => s.lines);
  lines.through = async (x, y) => {
    const out: Array<{ line: RoadLine; i: number }> = [];
    for (const s of await near(x, y, 0)) throughIn(s, x, y, out);
    return out;
  };
  return lines;
}
