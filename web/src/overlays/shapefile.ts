import { coordsBounds, polygonLabelAnchor, simplifyLine } from '../tiles/buildTile';
import { MAX_POINTS, SIMPLIFY_DEGREES, tooDetailed, type Overlay, type OverlayFeature, type OverlayLegend, type OverlayProps } from './kml';
import { fromWkt, ISN93, lonLat, type Unproject } from './proj';

/**
 * A Shapefile reader for overlays (what Icelandic open data services hand out, such as
 * Óbyggðanefnd's þjóðlendur from ogc.gis.is): points, lines and areas in lon/lat, from the national
 * grid or UTM where the .prj says so. A Shapefile has no colours: when its attributes have a field
 * that sorts the shapes into a few kinds (such as "tegund"), each kind gets its own colour and the
 * overlay a legend; otherwise everything is drawn in one colour.
 */

/** A Shapefile's parts: the shapes (.shp), their attributes (.dbf), the coordinate system (.prj)
 *  and the attribute text encoding (.cpg, or GeoServer's .cst). Only .shp is required. */
export interface ShapefileParts {
  shp: Uint8Array;
  dbf?: Uint8Array;
  prj?: string;
  cpg?: string;
}

/** The files that make up a Shapefile, by extension. */
export const SHAPEFILE_EXTENSIONS = ['shp', 'dbf', 'prj', 'cpg', 'cst', 'shx', 'sbn', 'sbx', 'qix'];

type Ring = Array<[number, number]>;
type Value = string | number | boolean;

/** Kinds' colours, in order of how many shapes each has: distinct from each other and from the
 *  map's own colours (no pale greens or blues, which read as woods and water). */
export const KIND_COLORS = ['#c2410c', '#1d4ed8', '#15803d', '#7e22ce', '#0e7490', '#be123c', '#b45309', '#4d7c0f', '#a21caf', '#334155'];
/** Shapes without a value in the legend's field. */
const NO_VALUE_COLOR = '#64748b';
const NO_VALUE = 'Not given';
/** Outline points closer than about a metre to the shape are dropped (survey detail beyond what
 *  the map shows; 30% of Óbyggðanefnd's points): in the file's own units, before projecting, so
 *  only the points kept are projected. Grid units are metres; degrees: about a metre. */
const SIMPLIFY_METRES = 1;

/** The text encoding a .cpg/.cst names, else UTF-8 when the bytes are valid UTF-8, else
 *  Windows-1252 (what older Icelandic data tends to use). */
function decoderFor(cpg: string | undefined, sample: Uint8Array): TextDecoder {
  const name = cpg?.trim().toLowerCase();
  if (name) {
    const label = /^\d+$/.test(name) ? (name === '65001' ? 'utf-8' : `windows-${name}`) : name.replace(/^iso8859/, 'iso-8859');
    try {
      return new TextDecoder(label);
    } catch {
      // unknown label: guess below
    }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return new TextDecoder('utf-8');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

export interface Dbf {
  /** Character fields' names (the ones a name or a kind can be in). */
  textFields: string[];
  records: Array<Record<string, Value>>;
}

/** The records of a .dbf (dBASE III) file. Empty values are left out. */
export function parseDbf(bytes: Uint8Array, cpg?: string): Dbf {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint32(4, true);
  const headerLen = v.getUint16(8, true);
  const recordLen = v.getUint16(10, true);
  const fields: Array<{ name: string; type: string; len: number; offset: number }> = [];
  let offset = 1; // the deletion flag
  for (let at = 32; at < headerLen - 1 && bytes[at] !== 0x0d; at += 32) {
    let end = at;
    while (end < at + 11 && bytes[end] !== 0) end++;
    const name = new TextDecoder('latin1').decode(bytes.subarray(at, end));
    const len = bytes[at + 16];
    fields.push({ name, type: String.fromCharCode(bytes[at + 11]), len, offset });
    offset += len;
  }
  const decoder = decoderFor(cpg, bytes.subarray(headerLen));
  const records: Array<Record<string, Value>> = [];
  for (let r = 0; r < count; r++) {
    const at = headerLen + r * recordLen;
    if (at + recordLen > bytes.length) break;
    const rec: Record<string, Value> = {};
    records.push(rec); // a deleted one too, empty: records go with shapes by position
    if (bytes[at] === 0x2a) continue;
    for (const f of fields) {
      // Some writers pad with NULs rather than spaces.
      const text = decoder.decode(bytes.subarray(at + f.offset, at + f.offset + f.len)).replace(/\0+/g, '').trim();
      if (!text) continue;
      if (f.type === 'N' || f.type === 'F') {
        const n = Number(text);
        if (Number.isFinite(n)) rec[f.name] = n;
      } else if (f.type === 'L') rec[f.name] = /^[TtYy]/.test(text);
      else if (f.type === 'D' && /^\d{8}$/.test(text)) rec[f.name] = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
      else rec[f.name] = text;
    }
  }
  return { textFields: fields.filter((f) => f.type === 'C').map((f) => f.name), records };
}

/** Signed area (lon/lat or grid units): positive counter-clockwise. */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return sum / 2;
}

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A Shapefile polygon's rings as polygons: its outer rings run clockwise, its holes
 *  counter-clockwise; each hole goes with the smallest outer ring it lies in (a lake in an island
 *  in a lake). A "hole" in none is taken as an area drawn the wrong way round (it happens). */
function polygons(rings: Ring[]): Ring[][] {
  const areas = rings.map(signedArea);
  // Each outer ring's box, so most of them are passed over without walking their points.
  const outers = rings.flatMap((r, i) => (areas[i] < 0 ? [{ p: [r], area: -areas[i], box: coordsBounds(r) }] : []));
  const strays: Ring[][] = [];
  for (const h of rings.filter((_, i) => areas[i] >= 0)) {
    const [x, y] = h[0];
    let best: (typeof outers)[number] | null = null;
    for (const o of outers) {
      const [w, s, e, n] = o.box;
      if (x < w || x > e || y < s || y > n || (best && o.area >= best.area)) continue;
      if (inRing(h[0], o.p[0])) best = o;
    }
    if (best) best.p.push(h);
    else strays.push([h]);
  }
  return [...outers.map((o) => o.p), ...strays];
}

type Shape = { type: 'points'; points: Ring } | { type: 'lines'; lines: Ring[] } | { type: 'areas'; areas: Ring[][] };

export { MAX_POINTS };

/** The shapes in a .shp, in lon/lat, by record (null for a null shape). */
function readShapes(shp: Uint8Array, unproject: Unproject): Array<Shape | null> {
  let points = 0;
  const count = (n: number) => {
    points += n;
    if (points > MAX_POINTS) throw tooDetailed();
  };
  const v = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  // Degrees when the file's extent fits in them (whatever order its axes are in).
  const extent = [36, 44, 52, 60].map((o) => Math.abs(v.getFloat64(o, true)));
  const tol = extent.every((x) => x <= 360) ? SIMPLIFY_DEGREES : SIMPLIFY_METRES;
  const project = (r: Ring): Ring => r.map(([x, y]) => unproject(x, y));
  const simplified = (r: Ring, min: number): Ring => {
    const s = simplifyLine(r, tol);
    return project(s.length >= min ? s : r);
  };
  const out: Array<Shape | null> = [];
  let at = 100;
  while (at + 12 <= shp.length) {
    const len = v.getInt32(at + 4, false) * 2;
    const type = v.getInt32(at + 8, true);
    const body = at + 8;
    at += 8 + len;
    if (at > shp.length) throw new Error('This Shapefile is cut short: copy or download its .shp again.');
    const base = type % 10; // 1 point, 3 line, 5 polygon, 8 multipoint (Z and M variants: +10, +20)
    const raw = (o: number): [number, number] => [v.getFloat64(o, true), v.getFloat64(o + 8, true)];
    const pt = (o: number) => unproject(...raw(o));
    if (type === 0 || type === 31) out.push(null); // a null shape; a MultiPatch (3D surfaces)
    else if (base === 1) out.push({ type: 'points', points: [pt(body + 4)] });
    else if (base === 8) {
      const n = v.getInt32(body + 36, true);
      count(n);
      out.push({ type: 'points', points: Array.from({ length: n }, (_, i) => pt(body + 40 + i * 16)) });
    } else if (base === 3 || base === 5) {
      const nParts = v.getInt32(body + 36, true);
      const nPoints = v.getInt32(body + 40, true);
      count(nPoints);
      const starts = Array.from({ length: nParts }, (_, i) => v.getInt32(body + 44 + i * 4, true));
      const pts = body + 44 + nParts * 4;
      const rings: Ring[] = starts.map((s, i) => {
        const end = i + 1 < nParts ? starts[i + 1] : nPoints;
        return Array.from({ length: end - s }, (_, k) => raw(pts + (s + k) * 16));
      });
      if (base === 5) out.push({ type: 'areas', areas: polygons(rings.filter((r) => r.length >= 4)).map((p) => p.map((r) => simplified(r, 4))) });
      else out.push({ type: 'lines', lines: rings.filter((r) => r.length >= 2).map((r) => simplified(r, 2)) });
    } else out.push(null);
  }
  return out;
}

/** Field names that hold a name, in order of preference (English, Icelandic, common GIS ones). */
const NAME_FIELDS = ['name', 'nafn', 'heiti', 'heiti_nf', 'title', 'label', 'nafn_is', 'name_is', 'ornefni', 'örnefni', 'nafnfitju', 'nafn_leida', 'nafn_leid'];
/** Field names that sort shapes into kinds. */
const KIND_FIELD = /^(tegund|flokkur|flokkun|gerd|gerð|type|class|fclass|category|kind|landuse|status|stada|staða)/i;
const MAX_KINDS = KIND_COLORS.length;

/** The field the shapes are named by: the first name-like one most shapes have. */
export function nameField(dbf: Dbf): string | null {
  const have = (f: string) => dbf.records.filter((r) => typeof r[f] === 'string').length;
  const candidates = dbf.textFields.filter((f) => NAME_FIELDS.includes(f.toLowerCase()) && have(f) > 0);
  candidates.sort((a, b) => have(b) - have(a) || NAME_FIELDS.indexOf(a.toLowerCase()) - NAME_FIELDS.indexOf(b.toLowerCase()));
  return candidates[0] ?? null;
}

/** The field the shapes are coloured by: a text field (not the name) that at least half the
 *  shapes have, with 2 to 10 values, each shared by several shapes. A kind-like name ("tegund",
 *  "type") comes first, then more values, then longer ones ("Þjóðlenda" before its code "TH_TH"). */
export function kindField(dbf: Dbf, name: string | null): string | null {
  const n = dbf.records.length;
  const scored = dbf.textFields.filter((f) => f !== name).map((f) => {
    const values = dbf.records.map((r) => r[f]).filter((x): x is string => typeof x === 'string');
    const distinct = new Set(values);
    const length = values.reduce((s, x) => s + x.length, 0) / (values.length || 1);
    return { f, ok: values.length >= n / 2 && distinct.size >= 2 && distinct.size <= MAX_KINDS && distinct.size <= n / 2, kindLike: KIND_FIELD.test(f), distinct: distinct.size, length };
  }).filter((s) => s.ok);
  scored.sort((a, b) => Number(b.kindLike) - Number(a.kindLike) || b.distinct - a.distinct || b.length - a.length);
  return scored[0]?.f ?? null;
}

/** What to name and colour shapes by, where the file's fields are known (see ./ogc.ts): a field,
 *  or null for none; left out, the fields are guessed. */
export interface ShapefileFields {
  name?: string | null;
  kind?: string | null;
}

/** A text field whose every value is a colour ("#ff7f00"): the shapes' own colours. */
function colorField(dbf: Dbf): string | null {
  if (!dbf.records.length) return null;
  return dbf.textFields.find((f) => dbf.records.every((r) => { const c = r[f]; return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); })) ?? null;
}

/** Reads a Shapefile as an overlay named `name`. */
export function parseShapefile(parts: ShapefileParts, name: string, fields: ShapefileFields = {}): Overlay {
  const { shp } = parts;
  const v = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (shp.length < 100 || v.getInt32(0, false) !== 9994) throw new Error("This isn't a Shapefile (.shp).");
  // Without a .prj: degrees if the numbers fit, else Iceland's national grid.
  const unproject = parts.prj ? fromWkt(parts.prj) : Math.abs(v.getFloat64(36, true)) > 180 ? ISN93 : lonLat;
  if (!unproject) throw new Error('Its coordinate system (.prj) isn’t one the app knows: save it in WGS84 (EPSG:4326), ISN93 or ISN2016.');
  const dbf: Dbf = parts.dbf ? parseDbf(parts.dbf, parts.cpg) : { textFields: [], records: [] };
  const named = fields.name !== undefined ? fields.name : nameField(dbf);
  const kind = fields.kind !== undefined ? fields.kind : kindField(dbf, named);
  let own = colorField(dbf);

  // Kinds' colours by how many shapes each has; shapes without one in grey.
  let legend: OverlayLegend | undefined;
  const colorOf = new Map<string, string>();
  if (kind) {
    const uses = new Map<string, number>();
    // With colours of its own, a kind takes the colour its first shape has.
    const ownOf = new Map<string, Set<string>>();
    for (const r of dbf.records) {
      const value = r[kind];
      if (typeof value !== 'string') continue;
      uses.set(value, (uses.get(value) ?? 0) + 1);
      const c = own ? r[own] : undefined;
      if (typeof c === 'string') ownOf.set(value, (ownOf.get(value) ?? new Set()).add(c));
    }
    // The shapes' own colours only where each kind has one (else the legend would be wrong).
    if (own && ![...uses.keys()].every((v) => ownOf.get(v)?.size === 1)) own = null;
    const items = [...uses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'is')).map(([value], i) => ({ value, color: own ? [...ownOf.get(value)!][0] : KIND_COLORS[i] }));
    for (const i of items) colorOf.set(i.value, i.color);
    if (dbf.records.some((r) => typeof r[kind] !== 'string')) items.push({ value: NO_VALUE, color: NO_VALUE_COLOR });
    legend = { field: kind, items };
  }

  const features: OverlayFeature[] = [];
  const counts = { points: 0, lines: 0, areas: 0 };
  const colorUse = new Map<string, number>();
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const extend = (ring: Ring) => {
    for (const [x, y] of ring) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  };
  readShapes(shp, unproject).forEach((shape, i) => {
    if (!shape) return;
    const rec = dbf.records[i] ?? {};
    const value = kind ? rec[kind] : undefined;
    const ownColor = own ? rec[own] : undefined;
    const kindColor = kind ? colorOf.get(String(value)) ?? NO_VALUE_COLOR : KIND_COLORS[0];
    const color = typeof ownColor === 'string' ? ownColor : kindColor;
    const label = named && rec[named] !== undefined ? String(rec[named]) : '';
    const props: OverlayProps = { k: 'area', name: label, line: color, lineOpacity: 1, lineWidth: 1.5, fill: color, fillOpacity: 0.2 };
    colorUse.set(color, (colorUse.get(color) ?? 0) + 1);
    if (shape.type === 'points') {
      for (const p of shape.points) {
        counts.points++;
        extend([p]);
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: { ...props, k: 'point' } });
      }
    } else if (shape.type === 'lines') {
      for (const l of shape.lines) {
        counts.lines++;
        extend(l);
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: l }, properties: { ...props, k: 'line', lineWidth: 2 } });
      }
    } else if (shape.areas.length) {
      let largest = shape.areas[0][0];
      for (const p of shape.areas) {
        counts.areas++;
        extend(p[0]);
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: p }, properties: props });
        if (Math.abs(signedArea(p[0])) > Math.abs(signedArea(largest))) largest = p[0];
      }
      // Its name once, inside its largest part.
      if (label) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: polygonLabelAnchor(largest) }, properties: { ...props, k: 'label' } });
    }
  });
  if (!features.length) throw new Error('There are no points, lines or areas in this Shapefile.');
  return {
    name,
    features,
    counts,
    bounds: [w, s, e, n],
    color: [...colorUse].sort((a, b) => b[1] - a[1])[0][0],
    ...(legend ? { legend } : {}),
  };
}

/** The Shapefiles among files (a .zip's contents or several picked files), by name without the
 *  extension; `parts` is null where there is no .shp. Mac zips' "__MACOSX" copies are skipped. */
export function shapefileGroups(files: Map<string, Uint8Array>): Array<{ base: string; parts: ShapefileParts | null }> {
  const groups = new Map<string, { base: string; files: Map<string, Uint8Array> }>();
  for (const [path, bytes] of files) {
    const file = path.split('/').pop()!;
    const m = /^(.*)\.([^.]+)$/.exec(file);
    if (!m || path.includes('__MACOSX/') || file.startsWith('._') || !SHAPEFILE_EXTENSIONS.includes(m[2].toLowerCase())) continue;
    const key = path.slice(0, path.length - m[2].length - 1).toLowerCase();
    const g = groups.get(key) ?? { base: m[1], files: new Map() };
    if (m[2].toLowerCase() === 'shp') g.base = m[1];
    g.files.set(m[2].toLowerCase(), bytes);
    groups.set(key, g);
  }
  const text = (b?: Uint8Array) => (b ? new TextDecoder().decode(b) : undefined);
  return [...groups.values()].map(({ base, files: f }) => ({
    base,
    parts: f.has('shp') ? { shp: f.get('shp')!, dbf: f.get('dbf'), prj: text(f.get('prj')), cpg: text(f.get('cpg') ?? f.get('cst')) } : null,
  }));
}
