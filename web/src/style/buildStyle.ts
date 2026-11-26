import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { LineStyle, RgbaImage, Typ } from '../img/typ';
import { CONTOUR_LINE_TYPES, DEM_MAX_ZOOM, DEM_MIN_ZOOM, DEM_TILE_SIZE, MAX_ZOOM, MIN_ZOOM } from '../map/zoom';
import { BACKGROUND, DEFAULT_LINE, DEFAULT_LINE_PRIORITY, LINE_PRIORITY, LINE_STYLES, POLYGON_COLORS, SKIP_POLYGONS } from './fallback';
import { AREA_LABELS, areaLayer, CONTOURS, LINE_NAMES, lineLayer as lineSourceLayer, OTHER_LINES, POINTS, styledLineTypes } from './sourceLayers';

export const FONT_REGULAR = 'Noto Sans Regular';
const FONT_ITALIC = 'Noto Sans Italic';
const HALO = { 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 };
const byType = (t: number) => ['==', ['get', 't'], t];

/** Lines drawn thinner than this get flat ends and plain joins. */
const ROUND_FROM_PX = 3;

/** A line's width in pixels by zoom: zoomed out, lines thin to 40% of their width, but no thinner
 *  than a pixel (as a Garmin draws them): a map styled with 1-pixel lines would otherwise lose its
 *  roads there. Contour lines may go to half a pixel, so the hills don't crowd out the rest. */
function widths(t: number | null, width: number): [at8: number, at14: number] {
  const min = t !== null && CONTOUR_LINE_TYPES.has(t) ? 0.5 : 1;
  return [Math.max(min, width * 0.4), Math.max(1, width)];
}

/**
 * Round ends and joins only where they show: from the zoom at which the line (its widest drawn
 * part, the casing when it has one) is ROUND_FROM_PX wide. Round ones cost MapLibre about
 * three times the triangles, and a town's streets are mostly 1-2 px hairlines (a screen of
 * Copenhagen at zoom 10: 500,000 line triangles with round ends, 180,000 without).
 */
function ends([at8, at14]: [number, number], dash: number[] | null): Record<string, unknown> {
  const choose = (flat: string): unknown => {
    if (at14 < ROUND_FROM_PX) return flat;
    if (at8 >= ROUND_FROM_PX) return 'round';
    return ['step', ['zoom'], flat, Math.ceil(8 + (6 * (ROUND_FROM_PX - at8)) / (at14 - at8)), 'round'];
  };
  return { 'line-join': dash ? 'round' : choose('miter'), 'line-cap': dash ? 'butt' : choose('butt') };
}

/** A line type's layer (or, with `t` null, the one for types without a style of their own). Each
 *  type has a source layer of its own, so only contours (which share one) need a filter.
 *  `endsWidth`: the width the ends and joins go by, when not the line's own (the casing's for both
 *  a line and its casing, so the two share one layout and MapLibre builds the line once). */
function lineLayer(id: string, t: number | null, color: string, width: number, dash: number[] | null, opts: { endsWidth?: number } = {}): LayerSpecification {
  const [at8, at14] = widths(t, width);
  const paint: Record<string, unknown> = {
    'line-color': color,
    'line-width': ['interpolate', ['linear'], ['zoom'], 8, at8, 14, at14],
  };
  if (dash) paint['line-dasharray'] = dash;
  const where = t === null ? { 'source-layer': OTHER_LINES }
    : CONTOUR_LINE_TYPES.has(t) ? { 'source-layer': CONTOURS, filter: byType(t) }
    : { 'source-layer': lineSourceLayer(t) };
  return {
    id, type: 'line', source: 'garmin', ...where,
    layout: ends(widths(t, opts.endsWidth ?? width), dash), paint,
  } as LayerSpecification;
}

export interface StyleOptions {
  tiles: string;
  glyphs: string;
  dem?: string;
  demBounds?: [number, number, number, number];
  /** The last zoom of terrain tiles (DEM_MAX_ZOOM unless the elevation files are 1″). */
  demMaxZoom?: number;
  /** Where the map has data [west, south, east, north], so no tiles are asked for outside it. */
  bounds?: [number, number, number, number];
  /** The credit shown with the map (HTML). */
  attribution?: string;
  sprite?: string;
}

export function buildStyle(typ: Typ, opts: StyleOptions): { style: StyleSpecification; images: Map<string, RgbaImage> } {
  const images = new Map<string, RgbaImage>();
  const layers: LayerSpecification[] = [{ id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } }];

  const polygonTypes = [...new Set([...typ.polygons.keys(), ...POLYGON_COLORS.keys()])]
    .sort((a, b) => (typ.drawLevel.get(a) ?? 0) - (typ.drawLevel.get(b) ?? 0) || a - b);
  for (const t of polygonTypes) {
    const s = typ.polygons.get(t);
    const base = { id: `pg-${t}`, type: 'fill' as const, source: 'garmin', 'source-layer': areaLayer(t) };
    if (s?.pattern) {
      images.set(`pg-${t}`, s.pattern);
      layers.push({ ...base, paint: { 'fill-pattern': `pg-${t}`, 'fill-antialias': false } } as LayerSpecification);
      continue;
    }
    const color = s ? s.color : SKIP_POLYGONS.has(t) ? undefined : POLYGON_COLORS.get(t);
    if (color) layers.push({ ...base, paint: { 'fill-color': color, 'fill-antialias': false } } as LayerSpecification);
  }

  if (opts.dem) {
    layers.push({
      id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#5a4a3a', 'hillshade-accent-color': '#5a4a3a', 'hillshade-highlight-color': '#ffffff' },
    } as LayerSpecification);
  }

  const lineTypes = [...styledLineTypes(typ)]
    .sort((a, b) => (LINE_PRIORITY.get(a) ?? DEFAULT_LINE_PRIORITY) - (LINE_PRIORITY.get(b) ?? DEFAULT_LINE_PRIORITY) || a - b);
  const lineStyle = (t: number): LineStyle => {
    const s = typ.lines.get(t);
    if (s) return s;
    const [color, width, dash] = LINE_STYLES.get(t) ?? DEFAULT_LINE;
    return { color, width, borderColor: null, borderWidth: 0, dash };
  };
  const endsWidth = (s: LineStyle) => (s.borderColor ? Math.max(s.width, s.borderWidth) : s.width);
  const [dc, dw] = DEFAULT_LINE;
  layers.push(lineLayer('ln-other', null, dc, dw, null));
  const drawn = lineTypes.filter((t) => !lineStyle(t).hidden);
  for (const t of drawn) {
    const s = lineStyle(t);
    if (s.borderColor) layers.push(lineLayer(`ln-${t}-casing`, t, s.borderColor, s.borderWidth, null, { endsWidth: endsWidth(s) }));
  }
  for (const t of drawn) {
    const s = lineStyle(t);
    layers.push(lineLayer(`ln-${t}`, t, s.color, s.width, s.dash, { endsWidth: endsWidth(s) }));
  }

  layers.push(...[
    { id: 'pg-labels', type: 'symbol', source: 'garmin', 'source-layer': AREA_LABELS,
      layout: { 'text-field': ['get', 'name'], 'text-font': [FONT_ITALIC], 'text-size': 11, 'text-max-width': 8 },
      paint: { 'text-color': '#2c5a85', ...HALO } },
    { id: 'contour-labels', type: 'symbol', source: 'garmin', 'source-layer': CONTOURS, filter: ['has', 'name'],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [FONT_REGULAR], 'text-size': 9 },
      paint: { 'text-color': '#8a6a4a', ...HALO } },
  ] as LayerSpecification[]);

  const iconTypes = [...typ.points.keys()].sort((a, b) => a - b);
  for (const t of iconTypes) images.set(`pt-${t}`, typ.points.get(t)!.image);
  const hasIcon = ['in', ['get', 't'], ['literal', iconTypes]];
  const text = { 'text-font': [FONT_REGULAR], 'text-size': 10, 'text-anchor': 'top', 'text-max-width': 8 };
  layers.push(...[
    { id: 'poi-dots', type: 'circle', source: 'garmin', 'source-layer': POINTS, filter: ['!', hasIcon],
      paint: { 'circle-radius': 2.5, 'circle-color': '#555555', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } },
    { id: 'poi-dot-labels', type: 'symbol', source: 'garmin', 'source-layer': POINTS, filter: ['all', ['!', hasIcon], ['has', 'name']],
      layout: { 'text-field': ['get', 'name'], 'text-offset': [0, 0.8], ...text }, paint: { 'text-color': '#222222', ...HALO } },
    { id: 'poi-icons', type: 'symbol', source: 'garmin', 'source-layer': POINTS, filter: hasIcon,
      layout: { 'icon-image': ['concat', 'pt-', ['to-string', ['get', 't']]], 'text-field': ['coalesce', ['get', 'name'], ''],
                'text-offset': [0, 1.1], 'text-optional': true, ...text },
      paint: { 'text-color': '#222222', ...HALO } },
  ] as LayerSpecification[]);

  // Street and river names last: MapLibre places the last layer's labels first, so they get their
  // room before the points do. In a town centre the shops' dots and names otherwise take it all
  // (central Copenhagen at zoom 14: 520 points shown, 2 street names).
  layers.push({ id: 'line-labels', type: 'symbol', source: 'garmin', 'source-layer': LINE_NAMES,
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [FONT_REGULAR], 'text-size': 11, 'text-max-angle': 30,
              // Wide spacing where long rivers dominate; default spacing where town streets do.
              'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 12, 500, 14, 250] },
    paint: { 'text-color': '#333333', ...HALO } } as unknown as LayerSpecification);

  const sources: StyleSpecification['sources'] = {
    garmin: {
      type: 'vector', tiles: [opts.tiles], minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM,
      ...(opts.bounds ? { bounds: opts.bounds } : {}),
      ...(opts.attribution ? { attribution: opts.attribution } : {}),
    },
  };
  if (opts.dem) {
    sources.dem = { type: 'raster-dem', tiles: [opts.dem], tileSize: DEM_TILE_SIZE, minzoom: DEM_MIN_ZOOM, maxzoom: opts.demMaxZoom ?? DEM_MAX_ZOOM, encoding: 'mapbox', ...(opts.demBounds ? { bounds: opts.demBounds } : {}) } as StyleSpecification['sources']['raster-dem'];
  }

  const style: StyleSpecification = {
    version: 8,
    name: 'GPSmap.is (on the fly)',
    sources,
    glyphs: opts.glyphs,
    ...(opts.sprite ? { sprite: opts.sprite } : {}),
    layers,
  };
  return { style, images };
}
