import { colorTable, type Scale } from './colors';
import { gridEast, gridNorth, type WeatherGrid } from './grid';

/** Image pixels between two grid points (MapLibre smooths the rest). */
const PX_PER_STEP = 8;
const MAX_SIDE = 512;

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y: number) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

export interface FieldImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Corners for MapLibre's image source: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

/** Where a pixel falls between grid points along one axis: the point before it and how far on. */
function axis(pixels: number, points: number, at: (p: number) => number): { i0: Int32Array; f: Float32Array } {
  const i0 = new Int32Array(pixels);
  const f = new Float32Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const x = Math.max(0, Math.min(points - 1, at(p)));
    i0[p] = Math.min(Math.floor(x), Math.max(0, points - 2));
    f[p] = x - i0[p];
  }
  return { i0, f };
}

/**
 * Hour `t` of a field as an image over the grid, bilinear between points. MapLibre stretches an
 * image evenly in Web Mercator, so its rows are spaced evenly in Mercator y (not in latitude) and
 * each pixel takes the value at its own latitude. Run on every move of the hour slider: the
 * per-pixel loop only mixes numbers and copies colours from a table.
 */
export function renderField(g: WeatherGrid, scale: Scale, t: number): FieldImage {
  const north = gridNorth(g);
  const east = gridEast(g);
  const width = Math.max(2, Math.min(MAX_SIDE, (g.cols - 1) * PX_PER_STEP));
  const height = Math.max(2, Math.min(MAX_SIDE, (g.rows - 1) * PX_PER_STEP));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const coordinates: FieldImage['coordinates'] = [[g.west, north], [east, north], [east, g.south], [g.west, g.south]];
  if (t < 0 || t >= g.times.length) return { width, height, rgba, coordinates };
  const yTop = mercY(north);
  const yBottom = mercY(g.south);
  const cols = axis(width, g.cols, (p) => (((east - g.west) * (p + 0.5)) / width) / g.dLon);
  const rows = axis(height, g.rows, (p) => (latOf(yTop + ((yBottom - yTop) * (p + 0.5)) / height) - g.south) / g.dLat);
  const v = g.values[scale.field];
  const base = t * g.rows * g.cols;
  const c1 = g.cols > 1 ? 1 : 0;
  const r1 = g.rows > 1 ? g.cols : 0;
  const { lut, lo, step } = colorTable(scale);
  const last = lut.length / 4 - 1;
  for (let row = 0; row < height; row++) {
    const rowBase = base + rows.i0[row] * g.cols;
    const fy = rows.f[row];
    for (let col = 0; col < width; col++) {
      const i = rowBase + cols.i0[col];
      const fx = cols.f[col];
      const value = (v[i] * (1 - fx) + v[i + c1] * fx) * (1 - fy) + (v[i + r1] * (1 - fx) + v[i + r1 + c1] * fx) * fy;
      if (Number.isNaN(value)) continue;
      const k = Math.max(0, Math.min(last, Math.round((value - lo) / step))) * 4;
      const o = (row * width + col) * 4;
      rgba[o] = lut[k];
      rgba[o + 1] = lut[k + 1];
      rgba[o + 2] = lut[k + 2];
      rgba[o + 3] = lut[k + 3];
    }
  }
  return { width, height, rgba, coordinates };
}
