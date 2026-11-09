import { coordsBounds, polygonLabelAnchor } from '../tiles/buildTile';
import { child, childText, parseXml, type El } from './xml';
import { unzip } from './zip';

/**
 * A KML reader for overlays (Google Earth's format, as in GPSmap.is's OVERLAYS folder): placemarks'
 * points, lines and polygons with the colours their styles give them. Image overlays, 3D models and
 * network links are not read.
 */

export class KmlError extends Error {}

/** What the map's overlay layers draw a feature with (see ../app/overlaysPanel.ts). */
export interface OverlayProps {
  /** area: a polygon; line; point: a placemark's point; label: where a polygon's name goes. */
  k: 'area' | 'line' | 'point' | 'label';
  name: string;
  line: string;
  lineOpacity: number;
  lineWidth: number;
  fill: string;
  fillOpacity: number;
}

export type OverlayFeature = GeoJSON.Feature<GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon, OverlayProps>;

export interface Overlay {
  name: string;
  features: OverlayFeature[];
  counts: { points: number; lines: number; areas: number };
  /** West, south, east, north. */
  bounds: [number, number, number, number];
  /** The colour most of it is drawn in (the list's swatch). */
  color: string;
}

const DEFAULT_COLOR = '#c2410c';
/** Fills stay see-through enough to read the map under them (GPSmap.is's parking zones are 60%). */
const MAX_FILL_OPACITY = 0.45;

interface Style {
  line?: string;
  lineOpacity?: number;
  width?: number;
  fill?: string;
  fillOpacity?: number;
  filled?: boolean;
  outline?: boolean;
  icon?: string;
}

/** A KML colour, aabbggrr in hex, as #rrggbb and an opacity. */
export function kmlColor(s: string | null): { color: string; opacity: number } | null {
  const m = s && /^#?([0-9a-f]{8})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return { color: `#${h.slice(6, 8)}${h.slice(4, 6)}${h.slice(2, 4)}`, opacity: parseInt(h.slice(0, 2), 16) / 255 };
}

function readStyle(e: El): Style {
  const out: Style = {};
  const ls = child(e, 'linestyle');
  if (ls) {
    const c = kmlColor(childText(ls, 'color'));
    if (c) [out.line, out.lineOpacity] = [c.color, c.opacity];
    const width = childText(ls, 'width');
    if (width && Number.isFinite(Number(width))) out.width = Number(width);
  }
  const ps = child(e, 'polystyle');
  if (ps) {
    const c = kmlColor(childText(ps, 'color'));
    if (c) [out.fill, out.fillOpacity] = [c.color, c.opacity];
    if (childText(ps, 'fill') === '0') out.filled = false;
    if (childText(ps, 'outline') === '0') out.outline = false;
  }
  const is = child(e, 'iconstyle');
  const ic = is && kmlColor(childText(is, 'color'));
  // White is KML's "no tint" (the icon as drawn); a white dot would vanish on the map.
  if (ic && ic.color !== '#ffffff') out.icon = ic.color;
  return out;
}

function walk(e: El, visit: (e: El) => void): void {
  visit(e);
  for (const c of e.children) walk(c, visit);
}

function coordinates(e: El | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const t of (e?.text ?? '').trim().split(/\s+/)) {
    const [lon, lat] = t.split(',').map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) out.push([lon, lat]);
  }
  return out;
}

function ring(e: El | undefined): Array<[number, number]> | null {
  const lr = e && child(e, 'linearring');
  const pts = coordinates(lr && child(lr, 'coordinates'));
  if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) pts.push(pts[0]);
  return pts.length >= 4 ? pts : null;
}

type Geometry = GeoJSON.Point | GeoJSON.LineString | GeoJSON.Polygon;

function geometries(e: El, out: Geometry[]): void {
  switch (e.tag) {
    case 'point': {
      const [p] = coordinates(child(e, 'coordinates'));
      if (p) out.push({ type: 'Point', coordinates: p });
      return;
    }
    case 'linestring':
    case 'linearring': {
      const pts = coordinates(child(e, 'coordinates'));
      if (pts.length >= 2) out.push({ type: 'LineString', coordinates: pts });
      return;
    }
    case 'track': {
      // gx:Track: "lon lat alt" in gx:coord elements.
      const pts = e.children.filter((c) => c.tag === 'coord').map((c) => c.text.trim().split(/\s+/).map(Number)).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)).map(([lon, lat]) => [lon, lat] as [number, number]);
      if (pts.length >= 2) out.push({ type: 'LineString', coordinates: pts });
      return;
    }
    case 'polygon': {
      const outer = ring(child(e, 'outerboundaryis'));
      if (!outer) return;
      const holes = e.children.filter((c) => c.tag === 'innerboundaryis').map(ring).filter((r) => r !== null);
      out.push({ type: 'Polygon', coordinates: [outer, ...holes] });
      return;
    }
    case 'multigeometry':
    case 'multitrack':
      for (const c of e.children) geometries(c, out);
  }
}

/** Area in lon/lat units (only compared with other rings). */
const ringArea = (r: number[][]) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
};

/** Reads a KML document. `fallbackName`: the overlay's name if the document has none. */
export function parseKml(xml: string, fallbackName: string): Overlay {
  const root = parseXml(xml);
  const kml = root.children.find((c) => c.tag === 'kml');
  if (!kml) throw new KmlError("This isn't a KML file.");

  // Shared styles by id; a StyleMap's "normal" style is the one drawn.
  const shared = new Map<string, El>();
  walk(kml, (e) => {
    if ((e.tag === 'style' || e.tag === 'stylemap') && e.attrs.id) shared.set(e.attrs.id, e);
  });
  const resolve = (url: string | null, depth = 0): Style => {
    const el = url?.startsWith('#') ? shared.get(url.slice(1)) : undefined;
    if (!el || depth > 4) return {};
    if (el.tag === 'style') return readStyle(el);
    const normal = el.children.find((p) => p.tag === 'pair' && childText(p, 'key') !== 'highlight');
    if (!normal) return {};
    const inline = child(normal, 'style');
    return { ...resolve(childText(normal, 'styleurl'), depth + 1), ...(inline ? readStyle(inline) : {}) };
  };

  const features: OverlayFeature[] = [];
  const counts = { points: 0, lines: 0, areas: 0 };
  const colorUse = new Map<string, number>();
  walk(kml, (pm) => {
    if (pm.tag !== 'placemark') return;
    const inline = child(pm, 'style');
    const st: Style = { ...resolve(childText(pm, 'styleurl')), ...(inline ? readStyle(inline) : {}) };
    const name = childText(pm, 'name') ?? '';
    const geoms: Geometry[] = [];
    for (const c of pm.children) geometries(c, geoms);
    const fill = st.fill ?? st.line ?? DEFAULT_COLOR;
    const line = st.line ?? st.fill ?? DEFAULT_COLOR;
    const props: OverlayProps = {
      k: 'area',
      name,
      line,
      lineOpacity: st.outline === false ? 0 : (st.lineOpacity ?? 1),
      lineWidth: Math.min(8, Math.max(0.5, st.width ?? 1.5)),
      fill,
      fillOpacity: st.filled === false ? 0 : Math.min(MAX_FILL_OPACITY, st.fillOpacity ?? 0.25),
    };
    let largest: GeoJSON.Polygon | null = null;
    for (const g of geoms) {
      if (g.type === 'Polygon') {
        counts.areas++;
        features.push({ type: 'Feature', geometry: g, properties: props });
        if (!largest || ringArea(g.coordinates[0]) > ringArea(largest.coordinates[0])) largest = g;
        colorUse.set(fill, (colorUse.get(fill) ?? 0) + 1);
      } else if (g.type === 'LineString') {
        counts.lines++;
        features.push({ type: 'Feature', geometry: g, properties: { ...props, k: 'line' } });
        colorUse.set(line, (colorUse.get(line) ?? 0) + 1);
      } else {
        counts.points++;
        const color = st.icon ?? DEFAULT_COLOR;
        features.push({ type: 'Feature', geometry: g, properties: { ...props, k: 'point', line: color, fill: color } });
        colorUse.set(color, (colorUse.get(color) ?? 0) + 1);
      }
    }
    // A polygon's name once, inside its largest part.
    if (largest && name) {
      const anchor = polygonLabelAnchor(largest.coordinates[0] as Array<[number, number]>);
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: anchor }, properties: { ...props, k: 'label' } });
    }
  });
  if (!features.length) throw new KmlError('There are no points, lines or areas in this file.');

  const coords = features.flatMap(({ geometry: g }) => (g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates[0])) as Array<[number, number]>;
  const doc = child(kml, 'document') ?? child(kml, 'folder');
  const docName = (doc && childText(doc, 'name')) || fallbackName;
  return {
    name: docName.replace(/\.km[lz]$/i, ''),
    features,
    counts,
    bounds: coordsBounds(coords),
    color: [...colorUse].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_COLOR,
  };
}

/** Reads a picked .kml or .kmz (a zip with a .kml inside, usually doc.kml). */
export async function readOverlayFile(name: string, bytes: Uint8Array): Promise<Overlay> {
  const base = name.split('/').pop()!.replace(/\.[^.]+$/, '');
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    const files = await unzip(bytes.slice().buffer);
    const kmls = [...files.keys()].filter((n) => /\.kml$/i.test(n));
    const main = kmls.find((n) => /(^|\/)doc\.kml$/i.test(n)) ?? kmls[0];
    if (!main) throw new KmlError('There is no KML file inside this KMZ file.');
    return parseKml(new TextDecoder().decode(files.get(main)), base);
  }
  const text = new TextDecoder().decode(bytes);
  if (!/<kml[\s>]/i.test(text.slice(0, 4096))) throw new KmlError('Pick a KML or KMZ file (from Google Earth or an overlays folder).');
  return parseKml(text, base);
}
