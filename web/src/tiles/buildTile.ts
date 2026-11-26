import { fromGeojsonVt } from '@maplibre/vt-pbf';
import { clipPolygon, clipPolyline } from 'lineclip';
import { DECODE_LINES, DECODE_POLYGONS, packed, pairs, type RawObject } from '../img/rgn';
import { shiftOf, subdivisionBounds, type Subdivision } from '../img/tre';
import { objectName, type GarminMap, type MapTile } from '../map/garminMap';
import { CONTOUR_LINE_TYPES, isRoadType, MAX_ZOOM } from '../map/zoom';
import { isFRoadName } from '../routing/roadClass';
import { AREA_LABELS, areaLayer, CONTOURS, LINE_NAMES, lineLayer, OTHER_LINES, POINTS, styledLineTypesOf } from '../style/sourceLayers';
import { tileBounds } from './tileMath';

export const EXTENT = 4096;
export const BUFFER = 64;
/**
 * Margin applied to each subdivision's declared bounds before the intersection pre-filter, as a
 * fraction of that subdivision's half-extent (per axis). The declared boxes in the real Iceland
 * "Detailed" map exactly bound their objects (measured max overshoot fraction: 0 at every level
 * bits — see test/tiles.test.ts), so this is headroom rather than a correction for observed
 * overshoot. Never goes below 0.
 */
export const SD_MARGIN = 0.05;
const UNITS_PER_DEG = 16777216 / 360;
const LAYER = { point: 'points', line: 'lines', polygon: 'polygons' } as const;

type Pt = [number, number];
type BBox = [number, number, number, number];
interface TileFeature {
  type: 1 | 2 | 3;
  geometry: Pt[] | Pt[][];
  tags: Record<string, string | number>;
}

interface CacheEntry {
  promise: Promise<RawObject[]>;
  /** The resolved objects, once loaded (for `peek`). */
  value?: RawObject[];
  /** The resolved objects' size (`decodedBytes`), or `null` while still in flight (an in-flight
   *  entry is never evicted: its size isn't known yet, and other callers may be awaiting the same
   *  promise). */
  bytes: number | null;
}

/** About what a decoded object takes besides its points: the object, its view of the points, its
 *  bounds (`boundsOf`) and, on average, its label's text. */
const OBJECT_BYTES = 200;

/** About how much memory decoded objects take: each object, and the buffers holding their points. */
export function decodedBytes(objs: RawObject[]): number {
  let bytes = objs.length * OBJECT_BYTES;
  let last: ArrayBufferLike | null = null;
  const seen = new Set<ArrayBufferLike>();
  for (const { xy } of objs) {
    if (xy.buffer === last || seen.has(xy.buffer)) continue;
    last = xy.buffer;
    seen.add(last);
    bytes += last.byteLength;
  }
  return bytes;
}

/** The objects with their points copied into one buffer of their own, so that keeping a few
 *  objects of a subdivision doesn't keep the points of all its others. */
function ownPoints(objs: RawObject[]): RawObject[] {
  const all = new Int32Array(objs.reduce((n, o) => n + o.xy.length, 0));
  let at = 0;
  return objs.map((o) => {
    all.set(o.xy, at);
    at += o.xy.length;
    return { ...o, xy: all.subarray(at - o.xy.length, at) };
  });
}

/**
 * Caches decoded subdivisions by key, bounded by their size in bytes (`decodedBytes`) rather than
 * entry count (a fixed entry cap let level-24 data - many points per subdivision - use unbounded
 * memory: see the Plan 1 review). Concurrent `get()` calls for the same key before the load settles
 * share one in-flight promise, so two `buildTile` calls in the same worker that both need a
 * subdivision decode it once. A rejected load is not cached, so the next `get()` retries it.
 */
export class SubdivisionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  /** Bumped by clear(): a load started before it doesn't count towards the budget after it. */
  private generation = 0;

  constructor(private readonly maxBytes: number = 40_000_000) {}

  get(key: string, load: () => Promise<RawObject[]>): Promise<RawObject[]> {
    const existing = this.entries.get(key);
    if (existing) {
      // Touch: move to the end so eviction below stays least-recently-used.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.promise;
    }
    const entry = { bytes: null } as CacheEntry;
    const generation = this.generation;
    entry.promise = load().then(
      (objs) => {
        entry.value = objs;
        entry.bytes = decodedBytes(objs);
        if (generation === this.generation && this.entries.get(key) === entry) {
          this.totalBytes += entry.bytes;
          this.evict();
        }
        return objs;
      },
      (err) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw err;
      },
    );
    this.entries.set(key, entry);
    return entry.promise;
  }

  /** The loaded objects for `key`, if cached and resolved (no load, no LRU touch). */
  peek(key: string): RawObject[] | undefined {
    return this.entries.get(key)?.value;
  }

  /** Drops every cached (and in-flight) entry, e.g. when a worker opens a different file. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.totalBytes = 0;
  }

  private evict(): void {
    for (const [key, e] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break;
      if (e.bytes === null) continue; // in-flight: unknown size, and may still be awaited elsewhere
      this.entries.delete(key);
      this.totalBytes -= e.bytes;
    }
  }
}

/** A line that only its name can show to be a road (`isRoad` needs its label's text). */
const mayBeNamedRoad = (o: RawObject) => o.kind === 'line' && !isRoadType(o.type) && o.label !== 0 && !CONTOUR_LINE_TYPES.has(o.type);

const intersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** `subdivisionBounds(sd)` padded by `SD_MARGIN` times the subdivision's half-extent, per axis. */
export function paddedSubdivisionBounds(sd: Subdivision): BBox {
  const [w, s, e, n] = subdivisionBounds(sd);
  const k = 2 ** shiftOf(sd);
  const padX = sd.halfWidth * k * SD_MARGIN;
  const padY = sd.halfHeight * k * SD_MARGIN;
  return [w - padX, s - padY, e + padX, n + padY];
}

export function coordsBounds(coords: Array<[number, number]>): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** The bounds of an object's points (`RawObject.xy`). */
export function xyBounds(xy: Int32Array): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i];
    const y = xy[i + 1];
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Each object's `coordsBounds` (west, south, east, north in turn), made once per decoded
 *  subdivision: a cached subdivision is drawn in many tiles. */
const boundsMade = new WeakMap<RawObject[], Int32Array>();
function boundsOf(objs: RawObject[]): Int32Array {
  let out = boundsMade.get(objs);
  if (!out) {
    const all = new Int32Array(objs.length * 4);
    objs.forEach((o, i) => all.set(xyBounds(o.xy), i * 4));
    boundsMade.set(objs, (out = all));
  }
  return out;
}

function roundDedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const [x, y] of points) {
    const p: Pt = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/** Lakes, ponds and rivers (Garmin 0x28-0x49 water types): kept even when tiny, since their dots
 *  show where the lake-strewn highlands are. */
const isWaterType = (t: number) => t === 0x28 || t === 0x29 || t === 0x32 || (t >= 0x3b && t <= 0x49);

/** Tile units per screen pixel: MapLibre draws vector tiles at 512 px. */
const PIXEL = EXTENT / 512;

/** True when the geometry fits within one screen pixel (invisible, but costly in bulk: zoomed out, a
 *  tile holds tens of thousands of tiny lakes and stream pieces). */
export function subPixel(parts: Pt[][]): boolean {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of parts) for (const [x, y] of part) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return e - w < PIXEL && n - s < PIXEL;
}

/** Douglas-Peucker: drop points closer than `tol` to the simplified line (ends always kept). */
export function simplifyLine(coords: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = coords[a];
    const [dx, dy] = [coords[b][0] - ax, coords[b][1] - ay];
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = [coords[i][0] - ax, coords[i][1] - ay];
      const d = len === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
      if (d > worstD) [worst, worstD] = [i, d];
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** Early roads are only drawn at the coarsest level's zooms (<= 8): half a pixel there, in map units. */
const EARLY_ROAD_TOLERANCE = 64;

/** Shoelace area, including the closing edge (Garmin rings are not explicitly closed; without it
 *  the result depends on the coordinate origin, i.e. would differ from tile to tile). */
const ringArea = (ring: Pt[]) => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(sum) / 2;
};

/**
 * A point inside a polygon to hang its label on: the area centroid when it lies inside, else the
 * middle of the widest interior span along the horizontal line through the centroid (so a
 * U-shaped lake is labelled on water, not in its bay). Works in any planar units.
 */
export function polygonLabelAnchor(ring: Array<[number, number]>): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  if (a === 0) return ring[0];
  cx /= 3 * a;
  cy /= 3 * a;
  // Crossings of the horizontal line y = cy; consecutive pairs bound the interior spans.
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((p, q) => p - q);
  let best: [number, number] | null = null;
  let width = -1;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k] <= cx && cx <= xs[k + 1]) return [cx, cy];
    if (xs[k + 1] - xs[k] > width) {
      width = xs[k + 1] - xs[k];
      best = [(xs[k] + xs[k + 1]) / 2, cy];
    }
  }
  return best ?? ring[0];
}

/**
 * Garmin stores a river or road as many short pieces with the same name, and MapLibre labels each
 * piece on its own, so one river got several labels close together. Join the pieces of each named
 * line (same type and name) that touch end to end into continuous lines, so labels are spaced
 * along the whole line by `symbol-spacing`. The unnamed pieces of a type are joined the same way:
 * zoomed out over a big town its streets are thousands of pieces a pixel or two long, each drawn
 * with its own end caps (12,000 in one zoom-10 tile of Copenhagen). Contours pass through
 * unchanged (they keep a label per ring: equal elevations on different hills are different lines).
 */
export function stitchLines(features: TileFeature[]): TileFeature[] {
  const out: TileFeature[] = [];
  const groups = new Map<string, { tags: TileFeature['tags']; parts: Pt[][] }>();
  for (const f of features) {
    const name = f.tags.name;
    if (CONTOUR_LINE_TYPES.has(f.tags.t as number)) {
      out.push(f);
      continue;
    }
    const key = name === undefined ? `u${f.tags.t}` : `n${f.tags.t}|${name}`;
    const g = groups.get(key) ?? groups.set(key, { tags: f.tags, parts: [] }).get(key)!;
    for (const part of f.geometry as Pt[][]) g.parts.push(part); // no spread: a type's parts can be tens of thousands
  }
  for (const { tags, parts } of groups.values()) out.push({ type: 2, geometry: joinParts(parts), tags });
  return out;
}

/** A point's key as a number: tile coordinates are whole numbers well within ±32768. */
const ptKey = (p: Pt) => (p[0] + 32768) * 65536 + (p[1] + 32768);

/** Greedily chain polylines that share endpoints (reversing pieces as needed). */
function joinParts(parts: Pt[][]): Pt[][] {
  if (parts.length < 2) return parts;
  const byEnd = new Map<number, number[]>();
  parts.forEach((part, i) => {
    for (const p of [part[0], part[part.length - 1]]) {
      const k = ptKey(p);
      (byEnd.get(k) ?? byEnd.set(k, []).get(k)!).push(i);
    }
  });
  const used = new Uint8Array(parts.length);
  /** An unused part with an end at `p`, and whether it starts there. */
  const takeAt = (p: Pt): [Pt[], boolean] | null => {
    const k = ptKey(p);
    for (const i of byEnd.get(k) ?? []) {
      if (used[i]) continue;
      used[i] = 1;
      return [parts[i], ptKey(parts[i][0]) === k];
    }
    return null;
  };
  const chains: Pt[][] = [];
  for (let i = 0; i < parts.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    // Both ways: the second turn extends from the piece's start, and turns the chain back round.
    const chain = parts[i].slice();
    for (let turn = 0; turn < 2; turn++) {
      for (let next = takeAt(chain[chain.length - 1]); next; next = takeAt(chain[chain.length - 1])) {
        const [part, starts] = next;
        if (starts) for (let k = 1; k < part.length; k++) chain.push(part[k]);
        else for (let k = part.length - 2; k >= 0; k--) chain.push(part[k]);
      }
      chain.reverse();
    }
    chains.push(chain);
  }
  return chains;
}

export interface LabelInfo {
  /** Area of the whole polygon the label belongs to. */
  size: number;
  /** Bounds of the whole polygon, in map units. */
  bbox: BBox;
  /** Label anchor in map units: a tile-independent tie-break between equal sizes. */
  anchor?: [number, number];
}

/** Same-named area labels closer than this (tile units: half a tile) are one feature's pieces. */
export const LABEL_MERGE_DISTANCE = EXTENT / 2;

/** Addresses (house numbers) repeat on nearby streets, so they only merge when touching. */
const isAddress = (name: string) => /^\d/.test(name);

const bigger = (a: LabelInfo, b: LabelInfo) =>
  a.size !== b.size ? a.size > b.size
    : (a.anchor?.[0] ?? 0) !== (b.anchor?.[0] ?? 0) ? (a.anchor?.[0] ?? 0) > (b.anchor?.[0] ?? 0)
    : (a.anchor?.[1] ?? 0) > (b.anchor?.[1] ?? 0);

/**
 * Garmin splits a big lake or wide river into several polygons (a wide river as pieces with gaps
 * between them), and each piece would otherwise get its own label. Drop a label when a larger
 * polygon with the same name touches its polygon or, except for addresses, has its label within
 * LABEL_MERGE_DISTANCE. `context` holds same-kind label points of polygons just outside this tile
 * (never emitted): every tile sees the same neighbourhood, so neighbouring tiles agree on which
 * label survives instead of each keeping its own copy near their shared edge.
 */
export function dedupeLabels(
  features: TileFeature[], infoOf: (f: TileFeature) => LabelInfo | undefined, context: TileFeature[] = [],
): void {
  const byName = new Map<string, Array<{ f: TileFeature; info: LabelInfo; own: boolean }>>();
  const add = (f: TileFeature, own: boolean) => {
    const info = infoOf(f);
    if (f.type !== 1 || f.tags.name === undefined || !info) return;
    const key = String(f.tags.name);
    (byName.get(key) ?? byName.set(key, []).get(key)!).push({ f, info, own });
  };
  for (const f of features) add(f, true);
  for (const f of context) add(f, false);
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const address = isAddress(name);
    const drop = group.filter(({ f, info, own }) => own && group.some((o) => {
      if (o.f === f || !bigger(o.info, info)) return false;
      if (intersects(o.info.bbox, info.bbox)) return true;
      const [pa, pb] = [(f.geometry as Pt[])[0], (o.f.geometry as Pt[])[0]];
      return !address && Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < LABEL_MERGE_DISTANCE;
    }));
    for (const { f } of drop) delete f.tags.name;
  }
}

/** Tile units per character of a line label, at least: the narrowest glyph of the labels' font
 *  (Noto Sans Regular's apostrophe) advances 5/24 em, at 11 px 2.3 px, and a tile's pixel is PIXEL
 *  (8) units. */
const LABEL_UNITS_PER_CHAR = 18;

const partLength = (part: Pt[]) => {
  let n = 0;
  for (let i = 1; i < part.length; i++) n += Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
  return n;
};

/**
 * The pieces of a named line its label can go on. MapLibre puts a line label only where the whole
 * label fits along one piece, measured at the tile's own zoom (below MAX_ZOOM a tile is never
 * enlarged for its labels), so a piece shorter than the name can never hold it: a town's streets
 * at zoom 10 are mostly such pieces.
 */
export function labelParts(parts: Pt[][], name: string): Pt[][] {
  const needs = [...name].length * LABEL_UNITS_PER_CHAR;
  return parts.filter((p) => partLength(p) >= needs);
}

/**
 * The tile's features by source layer (see style/sourceLayers.ts): a layer per line and area type
 * (lines of types `styled` hasn't, together), contours together, and the area labels and a copy of
 * the named lines' pieces that could hold their labels, for the label layers. Each layer keeps its
 * features in the order they came, so draw order and label placement stay as they were with one
 * layer per kind.
 */
function sourceLayers(layers: Record<'points' | 'lines' | 'polygons', TileFeature[]>, styled: ReadonlySet<number>, z: number) {
  const out: Record<string, { features: TileFeature[] }> = {};
  const add = (name: string, f: TileFeature) => (out[name] ??= { features: [] }).features.push(f);
  for (const f of layers.points) add(POINTS, f);
  for (const f of layers.lines) {
    const t = f.tags.t as number;
    const contour = CONTOUR_LINE_TYPES.has(t);
    add(contour ? CONTOURS : styled.has(t) ? lineLayer(t) : OTHER_LINES, f);
    if (contour || f.tags.name === undefined) continue;
    const name = String(f.tags.name);
    const parts = z < MAX_ZOOM ? labelParts(f.geometry as Pt[][], name) : (f.geometry as Pt[][]);
    if (parts.length) add(LINE_NAMES, { type: 2, geometry: parts, tags: { name } });
  }
  for (const f of layers.polygons) add(f.type === 1 ? AREA_LABELS : areaLayer(f.tags.t as number), f);
  return out;
}

export async function buildTile(
  map: GarminMap, cache: SubdivisionCache, z: number, x: number, y: number,
): Promise<{ data: Uint8Array; badSections: number; features: number }> {
  const layers: Record<'points' | 'lines' | 'polygons', TileFeature[]> = { points: [], lines: [], polygons: [] };
  let badSections = 0;
  const labelInfo = new Map<TileFeature, LabelInfo>();
  let labelContext: TileFeature[] = [];
  const bits = map.levelForZoom(z);
  if (bits !== undefined) {
    const [w, s, e, n] = tileBounds(z, x, y);
    const padX = ((e - w) * BUFFER) / EXTENT;
    const padY = ((n - s) * BUFFER) / EXTENT;
    const query: BBox = [(w - padX) * UNITS_PER_DEG, (s - padY) * UNITS_PER_DEG, (e + padX) * UNITS_PER_DEG, (n + padY) * UNITS_PER_DEG];
    const scale = 2 ** z;
    const project = (mx: number, my: number): Pt => {
      const lat = ((my / UNITS_PER_DEG) * Math.PI) / 180;
      return [
        ((mx / UNITS_PER_DEG + 180) / 360 * scale - x) * EXTENT,
        ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale - y) * EXTENT,
      ];
    };
    const projectAll = (xy: Int32Array): Pt[] => {
      const out = new Array<Pt>(xy.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = project(xy[2 * i], xy[2 * i + 1]);
      return out;
    };
    const clip: BBox = [-BUFFER, -BUFFER, EXTENT + BUFFER, EXTENT + BUFFER];
    // Polygons within half a tile around this one only contribute label context (dedupeLabels).
    const [hx, hy] = [((e - w) / 2) * UNITS_PER_DEG, ((n - s) / 2) * UNITS_PER_DEG];
    const labelQuery: BBox = [w * UNITS_PER_DEG - hx, s * UNITS_PER_DEG - hy, e * UNITS_PER_DEG + hx, n * UNITS_PER_DEG + hy];
    labelContext = [];

    // Collect every subdivision that intersects the tile first, then resolve them all in parallel
    // via the cache: a cache hit (resolved or already in flight from a concurrent buildTile call)
    // resolves immediately/shares that promise, and a miss reads+decodes once. Output is
    // identical either way: `resolved` ends up holding the same objects for the same keys.
    // With early roads, the tile's own level supplies everything but roads and the finer road
    // level supplies only roads (so each road is drawn once, from one level).
    const roadBits = map.roadLevelForZoom(z);
    // Roads: the road types, and lines named as F-roads (maps that draw roads in their own types).
    const isRoad = (tile: MapTile, o: RawObject) =>
      o.kind === 'line' && (isRoadType(o.type) || (mayBeNamedRoad(o) && isFRoadName(objectName(tile, o))));
    // Each subdivision is read in one of three views. 'all': the tile's own data. 'roads': only
    // the roads of the finer road level. 'labels': only named polygons, from around the tile, for
    // label context. The partial views are cached as their own (much smaller) entries, derived
    // from the full entry when that is cached, so the extra reads don't flush the cache.
    type View = 'all' | 'roads' | 'labels';
    interface Entry { tile: MapTile; sd: Subdivision; key: string; view: View }
    const entries: Entry[] = [];
    for (const [i, level] of (roadBits === undefined ? [bits] : [bits, roadBits]).entries()) {
      for (const tile of map.tiles) {
        for (const sd of tile.byLevel.get(level) ?? []) {
          const b = paddedSubdivisionBounds(sd);
          const inTile = intersects(b, query);
          const view: View | null = i === 1 ? (inTile ? 'roads' : null) : inTile ? 'all' : intersects(b, labelQuery) ? 'labels' : null;
          if (view) entries.push({ tile, sd, key: `${tile.id}:${sd.index}`, view });
        }
      }
    }
    const isNamedPolygon = (o: RawObject) => o.kind === 'polygon' && o.label !== 0;
    const resolved = new Map<Entry, RawObject[]>();
    await Promise.all(entries.map(async (e) => {
      // A partial view that isn't derived from the full entry decodes only the kind it keeps
      // (cached under its own key, never as the full entry).
      // Labels are looked up below, only for the objects this tile names.
      const decode = async (kinds?: number) => {
        const stats = { sections: 0, badSections: 0 };
        const decoded = await map.decode(e.tile, e.sd, { stats, kinds, labels: false });
        badSections += stats.badSections;
        return decoded;
      };
      const roads = async (objs: RawObject[]) => {
        const lines = objs.filter((o) => o.kind === 'line');
        await map.withLabels(e.tile, lines.filter(mayBeNamedRoad));
        return ownPoints(lines.filter((o) => isRoad(e.tile, o))
          .map((o) => ({ ...o, xy: packed(simplifyLine(pairs(o.xy), EARLY_ROAD_TOLERANCE)) })));
      };
      const objs = e.view === 'all'
        ? await cache.get(e.key, () => decode())
        : await cache.get(`${e.key}|${e.view}`, async () =>
          e.view === 'roads'
            ? roads(cache.peek(e.key) ?? (await decode(DECODE_LINES)))
            : ownPoints((cache.peek(e.key) ?? (await decode(DECODE_POLYGONS))).filter(isNamedPolygon)));
      resolved.set(e, objs);
    }));

    // Where each object lies: in the tile, and (an area) near enough for its label to count.
    const overlapsAt = (b: Int32Array, i: number, q: BBox) => b[i * 4] <= q[2] && b[i * 4 + 2] >= q[0] && b[i * 4 + 1] <= q[3] && b[i * 4 + 3] >= q[1];
    const inTileAt = (b: Int32Array, i: number) => overlapsAt(b, i, query);
    const nearAt = (b: Int32Array, i: number) => overlapsAt(b, i, labelQuery);
    // The labels of the objects named below, looked up together (a cached object keeps its text).
    await Promise.all(entries.map((e) => {
      const objs = resolved.get(e)!;
      const b = boundsOf(objs);
      const early = e.view === 'all' && roadBits !== undefined;
      return map.withLabels(e.tile, objs.filter((o, i) => o.text === undefined
        && ((early && mayBeNamedRoad(o)) || inTileAt(b, i) || (o.kind === 'polygon' && nearAt(b, i)))));
    }));

    for (const e of entries) {
      const { tile } = e;
      const objs = resolved.get(e)!;
      const allBounds = boundsOf(objs);
      for (const [i, obj] of objs.entries()) {
        // With early roads, the tile's own level supplies everything but roads (the road level
        // supplies those, so each road is drawn once).
        if (e.view === 'all' && roadBits !== undefined && isRoad(tile, obj)) continue;
        const [bw, bs, be, bn] = [allBounds[i * 4], allBounds[i * 4 + 1], allBounds[i * 4 + 2], allBounds[i * 4 + 3]];
        const inTile = inTileAt(allBounds, i);
        const name = obj.kind === 'polygon' && nearAt(allBounds, i) ? objectName(tile, obj) : null;
        const pts = name || inTile ? projectAll(obj.xy) : [];
        if (name) {
          // One label per polygon, not one per tile it crosses: anchor it on the whole polygon and
          // emit it only from the tile that holds the anchor; the rest is context for dedupeLabels.
          const anchor = polygonLabelAnchor(pairs(obj.xy));
          const [ax, ay] = project(anchor[0], anchor[1]);
          const label: TileFeature = { type: 1, geometry: [[Math.round(ax), Math.round(ay)]], tags: { t: obj.type, name } };
          labelInfo.set(label, { size: ringArea(pts), bbox: [bw, bs, be, bn], anchor });
          if (inTile && ax >= 0 && ax < EXTENT && ay >= 0 && ay < EXTENT) layers.polygons.push(label);
          else labelContext.push(label);
        }
        if (!inTile) continue;
        let feature: TileFeature | null = null;
        if (obj.kind === 'point') {
          const [px, py] = pts[0];
          if (px >= clip[0] && px <= clip[2] && py >= clip[1] && py <= clip[3]) feature = { type: 1, geometry: [[Math.round(px), Math.round(py)]], tags: {} };
        } else if (obj.kind === 'line') {
          const parts = clipPolyline(pts, clip).map(roundDedupe).filter((p) => p.length >= 2);
          if (parts.length) feature = { type: 2, geometry: parts, tags: {} };
        } else {
          const ring = simplifyLine(roundDedupe(clipPolygon(pts, clip)), PIXEL / 4);
          if (ring.length >= 3 && (isWaterType(obj.type) || !subPixel([ring]))) {
            const [f, l] = [ring[0], ring[ring.length - 1]];
            if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
            feature = { type: 3, geometry: [ring], tags: {} };
          }
        }
        if (!feature) continue;
        feature.tags.t = obj.type;
        // A named area keeps its name as `n` (not `name`, which the label layer draws; its label is a
        // separate point): what a pin dropped inside it is called.
        if (obj.kind === 'polygon' && name) feature.tags.n = name;
        if (obj.kind !== 'polygon') {
          const lineOrPointName = objectName(tile, obj);
          if (lineOrPointName) feature.tags.name = lineOrPointName;
        }
        layers[LAYER[obj.kind]].push(feature);
      }
    }
  }
  // Points closer than a quarter pixel to the line or outline change nothing on screen.
  // Each joined line on its own: a type's unnamed lines are one feature with a part per line.
  layers.lines = stitchLines(layers.lines)
    .map((f) => ({ ...f, geometry: (f.geometry as Pt[][]).filter((part) => !subPixel([part])).map((part) => simplifyLine(part, PIXEL / 4)) }))
    .filter((f) => f.geometry.length > 0);
  dedupeLabels(layers.polygons, (f) => labelInfo.get(f), labelContext);
  // Labels another tile shows (their name dropped) needn't be sent at all.
  layers.polygons = layers.polygons.filter((f) => f.type !== 1 || f.tags.name !== undefined);
  const data = fromGeojsonVt(sourceLayers(layers, styledLineTypesOf(map.typ), z) as never, { version: 2, extent: EXTENT });
  return { data, badSections, features: layers.points.length + layers.lines.length + layers.polygons.length };
}
