import { pairs, type RawObject } from '../img/rgn';
import type { Subdivision } from '../img/tre';
import { objectName, type GarminMap, type MapTile } from '../map/garminMap';
import { paddedSubdivisionBounds } from '../tiles/buildTile';
import { EDGE_FROAD, edgeSource, metresBetween, UNITS_PER_DEG, type NodeIndex, type RoadGraph, type Route } from './graph';
import type { RoadSeg, Shaped } from './plan';
import type { RoadClass, RoadClasses } from './roadClass';
import { followRoad, incoming, type RoadLine, type RoadLines } from './snap';

const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

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
  for (const line of await lines(a[0], a[1], 0)) {
    if (line.tile !== tile || line.net !== net) continue;
    for (let i = 0; i < line.coords.length; i++) {
      if (!same(line.coords[i], a)) continue;
      for (const dir of [1, -1] as const) {
        const got = await followRoad(lines, index, line, i + dir, dir, a);
        if (got?.node === v) return { path: got.path, line };
      }
    }
  }
  return null;
}

/**
 * Road lines for snapping (see ./snap.ts): the routable lines (`labelSrc === 'net'`) of the
 * finest-level subdivisions whose padded bounds reach the box around a point, decoded via `decode`
 * (the worker's cache), each with its road class from `classes`. One source serves one route
 * request: it keeps the lines it made, so a line is the same object each time it's returned.
 */
export function roadLineSource(map: GarminMap, decode: (tile: MapTile, sd: Subdivision) => Promise<RawObject[]>, classes: RoadClasses): RoadLines {
  const bits = Math.max(...map.bands.keys());
  const made = new Map<string, RoadLine[]>();
  const classOf = map.tiles.map((t) => new Map<number, RoadClass>(classes[t.id] ?? []));
  const unitsPerM = 1 / metresBetween(0, 0, 0, 1);
  return async (x, y, radiusM) => {
    const ry = radiusM * unitsPerM;
    const rx = ry / Math.max(0.01, Math.cos((y / UNITS_PER_DEG) * (Math.PI / 180)));
    const out: RoadLine[] = [];
    const wanted: Array<Promise<RoadLine[]>> = [];
    for (const [i, tile] of map.tiles.entries()) {
      // Tile bounds are in degrees; a margin covers rounding.
      const t = tile.tre;
      const m = 0.01 * UNITS_PER_DEG;
      if (x + rx + m < t.west * UNITS_PER_DEG || x - rx - m > t.east * UNITS_PER_DEG || y + ry + m < t.south * UNITS_PER_DEG || y - ry - m > t.north * UNITS_PER_DEG) continue;
      for (const sd of tile.byLevel.get(bits) ?? []) {
        const [w, s, e, n] = paddedSubdivisionBounds(sd);
        if (x + rx < w || x - rx > e || y + ry < s || y - ry > n) continue;
        const key = `${tile.id}:${sd.index}`;
        const have = made.get(key);
        if (have) {
          out.push(...have);
          continue;
        }
        wanted.push(decode(tile, sd).then((objs) => {
          const lines = made.get(key) ?? objs
            .filter((o) => o.kind === 'line' && o.labelSrc === 'net')
            .map((o) => ({ tile: i, net: o.label, cls: classOf[i].get(o.label) ?? 0, coords: pairs(o.xy), name: objectName(tile, o), type: o.type }));
          made.set(key, lines);
          return lines;
        }));
      }
    }
    for (const lines of await Promise.all(wanted)) out.push(...lines);
    return out;
  };
}
