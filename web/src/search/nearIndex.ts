import { distanceKm, EARTH_KM, titleCase } from './describe';

/** Grid cells of 0.05° latitude by 0.1° longitude, in 1e-5 degrees. */
const CELL_LAT = 5000;
const CELL_LON = 10000;
const cellKey = (latCell: number, lonCell: number) => (latCell + 2000) * 4000 + lonCell + 2000;
const KM_PER_DEG = (EARTH_KM * Math.PI) / 180;
const NUMBER_NAME = /^[\d\s.,-]+$/;

/**
 * The map's named points (those whose name isn't just a number), sorted by grid cell: small typed
 * arrays the places worker hands to the page, so naming a spot (a pin, a photo) stays a quick
 * synchronous lookup there without the page holding every place.
 */
export interface NamedPoints {
  lon: Int32Array;
  lat: Int32Array;
  /** The point's index among the map's places (ties go to the later one, as they used to). */
  index: Uint32Array;
  nameOff: Uint32Array;
  names: Uint8Array;
  /** Sorted cell keys and where each cell's points start (cellStart[cells.length] = the count). */
  cells: Int32Array;
  cellStart: Uint32Array;
}

interface Columns {
  lon: Int32Array;
  lat: Int32Array;
  kind: Uint8Array;
  nameOff: Uint32Array;
  names: Uint8Array;
}

export function namedPointsOf(cols: Columns, name: (i: number) => string): NamedPoints {
  const picked: number[] = [];
  const keys = new Int32Array(cols.lon.length);
  for (let i = 0; i < cols.lon.length; i++) {
    if (cols.kind[i] !== 0 || NUMBER_NAME.test(name(i))) continue;
    picked.push(i);
    keys[i] = cellKey(Math.floor(cols.lat[i] / CELL_LAT), Math.floor(cols.lon[i] / CELL_LON));
  }
  picked.sort((a, b) => keys[a] - keys[b] || a - b);
  const n = picked.length;
  const out: NamedPoints = {
    lon: new Int32Array(n),
    lat: new Int32Array(n),
    index: Uint32Array.from(picked),
    nameOff: new Uint32Array(n + 1),
    names: new Uint8Array(0),
    cells: new Int32Array(0),
    cellStart: new Uint32Array(0),
  };
  let bytes = 0;
  for (const i of picked) bytes += cols.nameOff[i + 1] - cols.nameOff[i];
  out.names = new Uint8Array(bytes);
  const cells: number[] = [];
  const cellStart: number[] = [];
  let at = 0;
  for (let k = 0; k < n; k++) {
    const i = picked[k];
    out.lon[k] = cols.lon[i];
    out.lat[k] = cols.lat[i];
    out.names.set(cols.names.subarray(cols.nameOff[i], cols.nameOff[i + 1]), at);
    at += cols.nameOff[i + 1] - cols.nameOff[i];
    out.nameOff[k + 1] = at;
    if (!cells.length || cells[cells.length - 1] !== keys[i]) {
      cells.push(keys[i]);
      cellStart.push(k);
    }
  }
  cellStart.push(n);
  out.cells = Int32Array.from(cells);
  out.cellStart = Uint32Array.from(cellStart);
  return out;
}

/** "Near X" for the nearest named point within some km of a spot, found through a grid. */
export class NearIndex {
  private readonly dec = new TextDecoder();
  constructor(readonly points: NamedPoints) {}

  /** The points of cell `key`: [start, end) or null. */
  private cell(key: number): [number, number] | null {
    const { cells, cellStart } = this.points;
    let lo = 0;
    let hi = cells.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cells[mid] < key) lo = mid + 1;
      else if (cells[mid] > key) hi = mid - 1;
      else return [cellStart[mid], cellStart[mid + 1]];
    }
    return null;
  }

  /** "Near X" for the nearest named point (a hut, a farm, a peak, a town) within `km` of `at`, for
   *  naming a pin where no map feature is at hand. The same answer as describe.ts' `nearName`. */
  nearName(at: [number, number], km = 3): string | undefined {
    const { lon, lat, index } = this.points;
    // Every point within `km` lies within dLat of `at`'s latitude, and (both points then at
    // latitudes whose cosine is at least `c`) within dLon of its longitude.
    const dLat = (km / KM_PER_DEG) * 1.001;
    const c = Math.cos((Math.min(90, Math.abs(at[1]) + dLat) * Math.PI) / 180);
    const s = km / (2 * EARTH_KM * c);
    const dLon = c > 1e-9 && s < 1 ? ((2 * Math.asin(s) * 180) / Math.PI) * 1.001 : 360;
    const lat0 = Math.floor(((at[1] - dLat) * 1e5) / CELL_LAT);
    const lat1 = Math.floor(((at[1] + dLat) * 1e5) / CELL_LAT);
    const lon0 = Math.floor((Math.max(-180, at[0] - dLon) * 1e5) / CELL_LON);
    const lon1 = Math.floor((Math.min(180, at[0] + dLon) * 1e5) / CELL_LON);
    let best = -1;
    let bestKm = km;
    for (let y = lat0; y <= lat1; y++) {
      for (let x = lon0; x <= lon1; x++) {
        const range = this.cell(cellKey(y, x));
        if (!range) continue;
        for (let k = range[0]; k < range[1]; k++) {
          const d = distanceKm(at, [lon[k] / 1e5, lat[k] / 1e5]);
          if (d < bestKm || (d === bestKm && (best < 0 || index[k] > index[best]))) [best, bestKm] = [k, d];
        }
      }
    }
    if (best < 0) return undefined;
    const name = this.dec.decode(this.points.names.subarray(this.points.nameOff[best], this.points.nameOff[best + 1]));
    return `Near ${titleCase(name.replace(/\s+\d+\s?m$/, ''))}`;
  }
}
