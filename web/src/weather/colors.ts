import type { Field } from './grid';

/** The layers one can pick in the weather bar. */
export type Layer = 'wind' | 'rain' | 'temp' | 'cloud';
export const LAYERS: Layer[] = ['wind', 'rain', 'temp', 'cloud'];

type Rgba = [number, number, number, number];

export interface Scale {
  /** The field drawn. */
  field: Field;
  unit: string;
  /** Value → colour, straight lines between the stops. Alpha 0 shows the map through. */
  stops: Array<[number, Rgba]>;
  /** Values named under the legend. */
  ticks: number[];
}

/**
 * Colours over the paper-coloured map: nothing where there's nothing to see (calm, dry, clear), and
 * stronger as it matters more. Wind by Veðurstofan's steps: 15 m/s is a gale for driving, 20 a storm,
 * 25 gusts upsets cars with trailers.
 */
export const SCALES: Record<Layer, Scale> = {
  wind: {
    field: 'wind', unit: 'm/s',
    stops: [[0, [190, 225, 255, 0]], [3, [170, 215, 245, 70]], [8, [110, 195, 120, 140]], [13, [245, 205, 50, 170]], [18, [240, 125, 35, 190]], [24, [210, 35, 55, 205]], [32, [140, 30, 150, 215]]],
    ticks: [0, 5, 10, 15, 20, 25, 30],
  },
  rain: {
    field: 'rain', unit: 'mm/h',
    stops: [[0, [150, 195, 255, 0]], [0.09, [150, 195, 255, 0]], [0.1, [150, 195, 255, 90]], [0.5, [85, 150, 240, 150]], [2, [30, 90, 220, 190]], [5, [95, 40, 200, 210]], [10, [200, 40, 160, 220]]],
    ticks: [0.1, 1, 2, 5, 10],
  },
  temp: {
    field: 'temp', unit: '°C',
    stops: [[-20, [80, 30, 140, 160]], [-10, [50, 90, 215, 150]], [-3, [125, 180, 240, 140]], [0, [235, 240, 250, 130]], [3, [170, 220, 165, 140]], [8, [240, 220, 105, 150]], [14, [245, 150, 60, 160]], [22, [215, 55, 45, 170]]],
    ticks: [-10, -5, 0, 5, 10, 15, 20],
  },
  cloud: {
    field: 'cloud', unit: '%',
    stops: [[0, [110, 120, 135, 0]], [15, [110, 120, 135, 0]], [40, [110, 120, 135, 60]], [70, [95, 105, 120, 115]], [100, [80, 88, 100, 165]]],
    ticks: [25, 50, 75, 100],
  },
};

/** The colour of `v` on the scale (transparent for NaN). */
export function colorOf(scale: Scale, v: number): Rgba {
  if (Number.isNaN(v)) return [0, 0, 0, 0];
  const s = scale.stops;
  if (v <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const [a, ca] = s[i - 1];
      const [b, cb] = s[i];
      const f = (v - a) / (b - a);
      return [0, 1, 2, 3].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f)) as Rgba;
    }
  }
  return s[s.length - 1][1];
}

const tables = new Map<Scale, { lut: Uint8ClampedArray; lo: number; step: number }>();

/** The scale as a table of 1024 colours over its stops' range (for drawing a field fast). */
export function colorTable(scale: Scale): { lut: Uint8ClampedArray; lo: number; step: number } {
  let t = tables.get(scale);
  if (!t) {
    const lo = scale.stops[0][0];
    const step = (scale.stops[scale.stops.length - 1][0] - lo) / 1023;
    const lut = new Uint8ClampedArray(1024 * 4);
    for (let i = 0; i < 1024; i++) lut.set(colorOf(scale, lo + i * step), i * 4);
    t = { lut, lo, step };
    tables.set(scale, t);
  }
  return t;
}

/** The values the legend spans: the stops and the ticks. */
function legendRange(scale: Scale): [number, number] {
  return [Math.min(scale.ticks[0], scale.stops[0][0]), Math.max(scale.ticks[scale.ticks.length - 1], scale.stops[scale.stops.length - 1][0])];
}

/** A CSS gradient for the legend, over the ticks' range. */
export function legendGradient(scale: Scale): string {
  const [lo, hi] = legendRange(scale);
  const parts = [];
  for (let i = 0; i <= 20; i++) {
    const v = lo + ((hi - lo) * i) / 20;
    // On the legend's white the faint ends need a little more colour to read.
    const [r, g, b, a] = colorOf(scale, v);
    parts.push(`rgba(${r},${g},${b},${Math.max(a, 25) / 255}) ${i * 5}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** Where a tick sits along the legend (0–1). */
export function tickPosition(scale: Scale, v: number): number {
  const [lo, hi] = legendRange(scale);
  return (v - lo) / (hi - lo);
}
