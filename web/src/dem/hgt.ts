import { DEM_HD_MAX_ZOOM, DEM_MAX_ZOOM, pyRound } from '../map/zoom';

export const HGT_SIZE = 1201;
/** Samples per degree of SRTM3 (3″, about 90 m), the grid the overview and tests are counted in. */
export const HGT_STEP = 1200;
export const HGT_BYTES = HGT_SIZE * HGT_SIZE * 2;
/** SRTM1 (1″, about 30 m), as in GPSmap.is's "HD Hillshade" package. */
export const HGT_HD_STEP = 3600;

/** Samples per degree of a .hgt file of this many bytes (1200 or 3600), or null if it's neither size. */
export function hgtStep(bytes: number): number | null {
  for (const step of [HGT_STEP, HGT_HD_STEP]) if (bytes === (step + 1) * (step + 1) * 2) return step;
  return null;
}

export const HGT_SIZE_ERROR = 'not a 1201×1201 (3″) or 3601×3601 (1″) SRTM tile';

/** The last zoom worth asking for terrain tiles at: one further in when any file is 1″. */
export const demMaxZoomFor = (files: Array<{ step: number }>) => (files.some((f) => f.step > HGT_STEP) ? DEM_HD_MAX_ZOOM : DEM_MAX_ZOOM);

/** One file per 1° square: where several cover the same square (say the normal and the HD
 *  hillshade both picked), the finest wins. Sorted by lower-case name. */
export function onePerSquare<T extends { south: number; west: number; step: number; name: string }>(files: T[]): T[] {
  const best = new Map<string, T>();
  for (const f of files) {
    const key = `${f.south},${f.west}`;
    const had = best.get(key);
    if (!had || f.step > had.step) best.set(key, f);
  }
  const keyed = [...best.values()].map((f) => ({ f, name: f.name.toLowerCase() }));
  keyed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return keyed.map((k) => k.f);
}

export function parseHgtName(name: string): { south: number; west: number } | null {
  const base = name.split('/').pop() ?? name;
  const m = /^([ns])(\d{2})([ew])(\d{3})\.hgt$/i.exec(base);
  if (!m) return null;
  return {
    south: (m[1].toLowerCase() === 'n' ? 1 : -1) * Number(m[2]),
    west: (m[3].toLowerCase() === 'e' ? 1 : -1) * Number(m[4]),
  };
}

/** The big-endian int16 sample at byte `i`; voids (-32768) and negative heights become 0 (sea level). */
export function hgtSample(bytes: Uint8Array, i: number): number {
  const v = ((bytes[i] << 8) | bytes[i + 1]) << 16 >> 16;
  return v < 0 ? 0 : v;
}

export function decodeHgt(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = hgtSample(bytes, 2 * i);
  return out;
}

export function encodeTerrainRgb(h: number, out: Uint8ClampedArray, i: number): void {
  const v = pyRound((Math.max(h, 0) + 10000) * 10);
  out[i] = Math.floor(v / 65536) % 256;
  out[i + 1] = Math.floor(v / 256) % 256;
  out[i + 2] = v % 256;
  out[i + 3] = 255;
}

export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}
