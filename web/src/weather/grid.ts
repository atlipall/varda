/**
 * Weather on the map is sampled at a grid of points over the view (Open-Meteo answers for points,
 * many in one request) and drawn between them. The grid's spacing follows the zoom, its edges are
 * snapped to whole steps so a slightly moved view still finds the grid it has, and it reaches a step
 * past the view so a small pan needs nothing new.
 */

export type Field = 'temp' | 'rain' | 'cloud' | 'wind' | 'gust' | 'dir';
export const FIELDS: Field[] = ['temp', 'rain', 'cloud', 'wind', 'gust', 'dir'];

export interface GridSpec {
  /** Degrees between points, north-south and east-west (about square on the ground in Iceland). */
  dLat: number;
  dLon: number;
  /** The south-west point. */
  south: number;
  west: number;
  rows: number;
  cols: number;
}

export interface WeatherGrid extends GridSpec {
  /** The start of each hour, ms since 1970 (UTC). */
  times: number[];
  /** Per field: times × rows × cols values (rows south to north), NaN where there's none. */
  values: Record<Field, Float32Array>;
  /** Which models the values came from, for the credit line. */
  source: string;
  /** When it was fetched (ms). */
  fetched: number;
}

/** Spacings from coarse to fine; a finer one takes over as the map zooms in. */
const STEPS: Array<{ minZoom: number; dLat: number; dLon: number }> = [
  { minZoom: 0, dLat: 0.5, dLon: 1 },
  { minZoom: 6.5, dLat: 0.25, dLon: 0.5 },
  { minZoom: 8, dLat: 0.1, dLon: 0.2 },
  { minZoom: 9.5, dLat: 0.05, dLon: 0.1 },
  // About DMI's 2 km.
  { minZoom: 11, dLat: 0.02, dLon: 0.04 },
];

/** At most this many points in one request. Open-Meteo's free use counts each point as a call (a
 *  little more with our 12 series) and allows 600 a minute and 10,000 a day: about 180 a request
 *  leaves room for a few in a minute and dozens a day. Iceland whole at the coarsest spacing is 140. */
export const MAX_POINTS = 150;

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** The grid for a view ([west, south, east, north]) at a zoom: the finest spacing for the zoom that
 *  keeps within MAX_POINTS. */
export function gridFor(bounds: [number, number, number, number], zoom: number): GridSpec {
  const [w, s, e, n] = bounds;
  let i = STEPS.length - 1;
  while (i > 0 && zoom < STEPS[i].minZoom) i--;
  for (; i > 0; i--) {
    const spec = snap(w, s, e, n, STEPS[i].dLat, STEPS[i].dLon);
    if (spec.rows * spec.cols <= MAX_POINTS) return spec;
  }
  const coarse = snap(w, s, e, n, STEPS[0].dLat, STEPS[0].dLon);
  return coarse.rows * coarse.cols <= MAX_POINTS ? coarse : limit(coarse);
}

function snap(w: number, s: number, e: number, n: number, dLat: number, dLon: number): GridSpec {
  // (The small allowances keep 64.2 / 0.04 = 1605.0000001 from counting as a step more.)
  const south = Math.max(-89, (Math.floor(s / dLat + 1e-6) - 1) * dLat);
  const north = Math.min(89, (Math.ceil(n / dLat - 1e-6) + 1) * dLat);
  const west = (Math.floor(w / dLon + 1e-6) - 1) * dLon;
  const east = (Math.ceil(e / dLon - 1e-6) + 1) * dLon;
  return {
    dLat, dLon, south: round(south), west: round(west),
    rows: Math.round((north - south) / dLat) + 1,
    cols: Math.round((east - west) / dLon) + 1,
  };
}

/** The coarsest grid still too big (the whole world in view): keep its middle. */
function limit(spec: GridSpec): GridSpec {
  const side = Math.floor(Math.sqrt(MAX_POINTS));
  const rows = Math.min(spec.rows, side);
  const cols = Math.min(spec.cols, Math.floor(MAX_POINTS / rows));
  return {
    ...spec,
    south: round(spec.south + Math.floor((spec.rows - rows) / 2) * spec.dLat),
    west: round(spec.west + Math.floor((spec.cols - cols) / 2) * spec.dLon),
    rows, cols,
  };
}

export const gridNorth = (g: GridSpec) => round(g.south + (g.rows - 1) * g.dLat);
export const gridEast = (g: GridSpec) => round(g.west + (g.cols - 1) * g.dLon);

/** The points of a grid, row by row from the south-west: [lon, lat]. */
export function gridPoints(g: GridSpec): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) out.push([round(g.west + c * g.dLon), round(g.south + r * g.dLat)]);
  return out;
}

/** Whether `have` serves the view `want` needs: the same spacing and covering it. A coarser grid
 *  doesn't (zoomed in, the finer one is wanted); a finer one does while it covers. */
export function covers(have: GridSpec, want: GridSpec): boolean {
  return have.dLat <= want.dLat + 1e-9 && have.dLat >= want.dLat - 1e-9
    && have.south <= want.south + 1e-9 && have.west <= want.west + 1e-9
    && gridNorth(have) >= gridNorth(want) - 1e-9 && gridEast(have) >= gridEast(want) - 1e-9;
}

/** The index of the hour holding `time` (the nearest when outside), or -1 with no hours. */
export function hourIndex(times: number[], time: number): number {
  if (!times.length) return -1;
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i;
  return best;
}

/** A field's value at [lon, lat] in hour `t`, bilinear between the four points around it; NaN
 *  outside the grid or where a corner has none. Wind direction is averaged as a vector. */
export function valueAt(g: WeatherGrid, field: Field, t: number, lon: number, lat: number): number {
  const x = (lon - g.west) / g.dLon;
  const y = (lat - g.south) / g.dLat;
  if (t < 0 || t >= g.times.length || x < 0 || y < 0 || x > g.cols - 1 || y > g.rows - 1) return NaN;
  const c0 = Math.min(Math.floor(x), Math.max(0, g.cols - 2));
  const r0 = Math.min(Math.floor(y), Math.max(0, g.rows - 2));
  const c1 = Math.min(c0 + 1, g.cols - 1);
  const r1 = Math.min(r0 + 1, g.rows - 1);
  const fx = x - c0;
  const fy = y - r0;
  const base = t * g.rows * g.cols;
  const at = (f: Field, r: number, c: number) => g.values[f][base + r * g.cols + c];
  const mix = (a: number, b: number, c: number, d: number) => (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  if (field === 'dir') {
    // The direction the wind comes from, as degrees: average the vectors (weighted by speed).
    const vec = (r: number, c: number) => {
      const d = (at('dir', r, c) * Math.PI) / 180;
      const s = at('wind', r, c) || 1;
      return [Math.sin(d) * s, Math.cos(d) * s];
    };
    const [a, b, c, d] = [vec(r0, c0), vec(r0, c1), vec(r1, c0), vec(r1, c1)];
    const u = mix(a[0], b[0], c[0], d[0]);
    const v = mix(a[1], b[1], c[1], d[1]);
    return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  }
  return mix(at(field, r0, c0), at(field, r0, c1), at(field, r1, c0), at(field, r1, c1));
}
