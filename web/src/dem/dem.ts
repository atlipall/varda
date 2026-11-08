import { ImgError } from '../img/bytes';
import type { ByteSource } from '../img/source';
import { decodeHgt, encodeTerrainRgb, HGT_BYTES, HGT_SIZE, HGT_STEP, parseHgtName } from './hgt';
import type { Overview } from './overview';
import { DEM_TILE_SIZE } from '../map/zoom';

export const TILE_SIZE = DEM_TILE_SIZE;
export const OVERVIEW_MAX_ZOOM = 8;
const ROW_BYTES = HGT_SIZE * 2;

interface Placed {
  name: string;
  src: ByteSource;
  row0: number; // mosaic row of the file's north edge
  col0: number; // mosaic column of the file's west edge
}

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z)) * 180) / Math.PI;

function bilinear(get: (r: number, c: number) => number, row: number, col: number, rows: number, cols: number): number {
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(r0 + 1, rows - 1);
  const c1 = Math.min(c0 + 1, cols - 1);
  const fr = row - r0;
  const fc = col - c0;
  const top = get(r0, c0) * (1 - fc) + get(r0, c1) * fc;
  const bottom = get(r1, c0) * (1 - fc) + get(r1, c1) * fc;
  return top * (1 - fr) + bottom * fr;
}

export class Dem {
  private constructor(
    private readonly files: Placed[],
    private readonly rows: number,
    private readonly cols: number,
    private readonly overview: Overview | null,
    /** [west, south, east, north] of the mosaic in degrees */
    readonly bounds: [number, number, number, number],
  ) {}

  static fromFiles(input: Array<{ name: string; src: ByteSource }>, overview: Overview | null): Dem {
    if (!input.length) throw new ImgError('no .hgt files');
    const parsed = input.map((f) => {
      const p = parseHgtName(f.name);
      if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
      if (f.src.size !== HGT_BYTES) throw new ImgError(`${f.name}: not a 1201×1201 SRTM3 tile (${f.src.size} bytes)`);
      return { ...f, ...p };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const southMin = Math.min(...parsed.map((p) => p.south));
    const southMax = Math.max(...parsed.map((p) => p.south));
    const westMin = Math.min(...parsed.map((p) => p.west));
    const westMax = Math.max(...parsed.map((p) => p.west));
    const rows = (southMax - southMin + 1) * HGT_STEP + 1;
    const cols = (westMax - westMin + 1) * HGT_STEP + 1;
    const files = parsed.map((p) => ({ name: p.name, src: p.src, row0: (southMax - p.south) * HGT_STEP, col0: (p.west - westMin) * HGT_STEP }));
    return new Dem(files, rows, cols, overview, [westMin, southMin, westMax + 1, southMax + 1]);
  }

  async tile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
    const [west, south, east, north] = this.bounds;
    const lons = Array.from({ length: TILE_SIZE }, (_, px) => tileLon(x + (px + 0.5) / TILE_SIZE, z));
    const lats = Array.from({ length: TILE_SIZE }, (_, py) => tileLat(y + (py + 0.5) / TILE_SIZE, z));
    const out = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);

    let sample: (lon: number, lat: number) => number;
    if (this.overview && z <= OVERVIEW_MAX_ZOOM) {
      const o = this.overview;
      const per = HGT_STEP / o.step;
      sample = (lon, lat) => bilinear(
        (r, c) => o.data[r * o.cols + c],
        Math.min(Math.max((o.north - lat) * per, 0), o.rows - 1),
        Math.min(Math.max((lon - o.west) * per, 0), o.cols - 1),
        o.rows, o.cols,
      );
    } else {
      sample = await this.fullResSampler(lons, lats);
    }

    for (let py = 0; py < TILE_SIZE; py++) {
      const lat = lats[py];
      for (let px = 0; px < TILE_SIZE; px++) {
        const lon = lons[px];
        const outside = lat < south || lat > north || lon < west || lon > east;
        encodeTerrainRgb(outside ? 0 : sample(lon, lat), out, (py * TILE_SIZE + px) * 4);
      }
    }
    return out;
  }

  /** Ground height in metres at one point (bilinear, full resolution), or null outside the mosaic. */
  async elevationAt(lon: number, lat: number): Promise<number | null> {
    const [west, south, east, north] = this.bounds;
    if (lon < west || lon > east || lat < south || lat > north) return null;
    return (await this.fullResSampler([lon], [lat]))(lon, lat);
  }

  /** Reads one row band per intersecting file into a patch covering exactly the rows/cols this tile needs. */
  private async fullResSampler(lons: number[], lats: number[]): Promise<(lon: number, lat: number) => number> {
    const [west, , , north] = this.bounds;
    const rowOf = (lat: number) => Math.min(Math.max((north - lat) * HGT_STEP, 0), this.rows - 1);
    const colOf = (lon: number) => Math.min(Math.max((lon - west) * HGT_STEP, 0), this.cols - 1);
    const rMin = Math.floor(rowOf(lats[0]));
    const rMax = Math.min(Math.ceil(rowOf(lats[lats.length - 1])) + 1, this.rows - 1);
    const cMin = Math.floor(colOf(lons[0]));
    const cMax = Math.min(Math.ceil(colOf(lons[lons.length - 1])) + 1, this.cols - 1);
    const pr = rMax - rMin + 1;
    const pc = cMax - cMin + 1;
    const patch = new Int16Array(pr * pc);

    await Promise.all(this.files.map(async (f) => {
      const r0 = Math.max(rMin, f.row0);
      const r1 = Math.min(rMax, f.row0 + HGT_STEP);
      const c0 = Math.max(cMin, f.col0);
      const c1 = Math.min(cMax, f.col0 + HGT_STEP);
      if (r0 > r1 || c0 > c1) return;
      const lr0 = r0 - f.row0;
      const band = decodeHgt(await f.src.read(lr0 * ROW_BYTES, (r1 - r0 + 1) * ROW_BYTES));
      return () => {
        for (let r = r0; r <= r1; r++) {
          const src = (r - r0) * HGT_SIZE - f.col0;
          const dst = (r - rMin) * pc - cMin;
          for (let c = c0; c <= c1; c++) patch[dst + c] = band[src + c];
        }
      };
    })).then((writers) => writers.forEach((w) => w?.())); // apply in file-name order, like the Python mosaic

    return (lon, lat) => bilinear((r, c) => patch[(r - rMin) * pc + (c - cMin)], rowOf(lat), colOf(lon), this.rows, this.cols);
  }
}
