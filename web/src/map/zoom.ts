export const ZOOM_OFFSET = 11;
export const MIN_ZOOM = 4;
export const MAX_ZOOM = 14;
/** Terrain tiles: their size in pixels, and the zooms the map asks for them at (MapLibre enlarges
 *  zoom 11's beyond it). */
export const DEM_TILE_SIZE = 256;
export const DEM_MIN_ZOOM = 5;
export const DEM_MAX_ZOOM = 11;
/** With 1″ (HD) elevation files: zoom 11's pixels are about 2.5″ apart, so one zoom more shows their detail. */
export const DEM_HD_MAX_ZOOM = 12;
/** Line types for roads and tracks (Garmin 0x01-0x13; GPSmap.is puts the F-roads at 0x0d, 0x11-0x13). */
export const isRoadType = (t: number) => t >= 0x01 && t <= 0x13;
/** From this zoom up to ROADS_LEVEL_ZOOM, tiles take their roads from ROADS_LEVEL_ZOOM's level:
 *  the coarser levels carry only main highways (GPSmap.is) or no F-roads at all (Freizeitkarte), so
 *  the F-roads would otherwise appear only at zoom 9. */
export const EARLY_ROADS_ZOOM = 7;
export const ROADS_LEVEL_ZOOM = 9;
export const CONTOUR_LINE_TYPES = new Set([0x20, 0x21, 0x22, 0x23, 0x24, 0x25]);

/** Python's round(): halves go to the nearest even integer. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** Map level resolution (bits) to a [minzoom, maxzoom] band in MapLibre zoom. */
export function zoomBands(bits: number[]): Map<number, [number, number]> {
  const levels = [...new Set(bits)].sort((a, b) => a - b);
  const starts = [MIN_ZOOM, ...levels.slice(1).map((b) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, b - ZOOM_OFFSET)))];
  const bands = new Map<number, [number, number]>();
  levels.forEach((b, i) => {
    const end = i + 1 < levels.length ? starts[i + 1] - 1 : MAX_ZOOM;
    if (end >= starts[i]) bands.set(b, [starts[i], end]);
  });
  return bands;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

export function isNumber(s: string): boolean {
  return NUMBER.test(s.trim());
}

export function contourLabel(name: string): string {
  return isNumber(name) ? String(pyRound(parseFloat(name) * 0.3048)) : name;
}
