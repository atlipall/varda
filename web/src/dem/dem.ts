import { ImgError } from '../img/bytes';
import type { ByteSource } from '../img/source';
import { demMaxZoomFor, encodeTerrainRgb, HGT_SIZE_ERROR, HGT_STEP, hgtSample, hgtStep, onePerSquare, parseHgtName } from './hgt';
import type { Overview } from './overview';
import { DEM_TILE_SIZE } from '../map/zoom';

export const TILE_SIZE = DEM_TILE_SIZE;
export const OVERVIEW_MAX_ZOOM = 8;

interface Placed {
  name: string;
  src: ByteSource;
  south: number;
  west: number;
  step: number; // samples per degree: 1200 (3″) or 3600 (1″)
}

/** What a tile needs of one file: every k-th sample from (r0, c0), in the file's own grid. */
interface Patch {
  f: Placed;
  k: number;
  r0: number;
  c0: number;
  rows: number;
  cols: number;
  data: Int16Array;
}

/** Stored rows read from a file at a time, so a 1″ tile's band never sits in memory whole. */
const CHUNK_ROWS = 64;
/** Strides that divide both 1200 and 3600, so the kept samples still land on each file's edges. */
const STRIDES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 25, 30];
const squareKey = (south: number, west: number) => south * 1000 + west;

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
  /** Files by squareKey(south, west). */
  private readonly bySquare: Map<number, Placed>;

  private constructor(
    files: Placed[],
    private readonly overview: Overview | null,
    /** [west, south, east, north] of the mosaic in degrees */
    readonly bounds: [number, number, number, number],
  ) {
    this.bySquare = new Map(files.map((f) => [squareKey(f.south, f.west), f]));
    this.maxZoom = demMaxZoomFor(files);
  }

  /** The last zoom worth asking for terrain tiles at (one further in when any file is 1″). */
  readonly maxZoom: number;

  static fromFiles(input: Array<{ name: string; src: ByteSource }>, overview: Overview | null): Dem {
    if (!input.length) throw new ImgError('no .hgt files');
    const files = onePerSquare(input.map((f) => {
      const p = parseHgtName(f.name);
      if (!p) throw new ImgError(`${f.name}: not an SRTM .hgt file name (expected e.g. n64w019.hgt)`);
      const step = hgtStep(f.src.size);
      if (!step) throw new ImgError(`${f.name}: ${HGT_SIZE_ERROR} (${f.src.size} bytes)`);
      return { ...f, ...p, step };
    }));
    const souths = files.map((p) => p.south);
    const wests = files.map((p) => p.west);
    return new Dem(files, overview, [Math.min(...wests), Math.min(...souths), Math.max(...wests) + 1, Math.max(...souths) + 1]);
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

  /** Reads, from each file the tile touches, just the rows and columns it needs (in the file's own
   *  grid), then samples each point from the file of its 1° square. Every file holds its own edges,
   *  so bilinear never has to reach into a neighbour. Where the points are several samples apart
   *  (1″ files at zooms 9-10), only every k-th sample is read into memory. */
  private async fullResSampler(lons: number[], lats: number[]): Promise<(lon: number, lat: number) => number> {
    const [west, south, east, north] = this.bounds;
    const lonMin = Math.min(...lons);
    const lonMax = Math.max(...lons);
    const latMin = Math.min(...lats);
    const latMax = Math.max(...lats);
    if (lonMax < west || lonMin > east || latMax < south || latMin > north) return () => 0;
    const lonLo = Math.max(lonMin, west);
    const lonHi = Math.min(lonMax, east);
    const latLo = Math.max(latMin, south);
    const latHi = Math.min(latMax, north);
    // Degrees between neighbouring points, the closer of the two directions.
    const spacing = Math.min(lons.length > 1 ? (lonMax - lonMin) / (lons.length - 1) : 0, lats.length > 1 ? (latMax - latMin) / (lats.length - 1) : 0);
    const square = (v: number, lo: number, hi: number) => Math.min(Math.max(Math.floor(v), lo), hi - 1);

    const patches = new Map<number, Patch>();
    const jobs: Array<Promise<void>> = [];
    for (let s = square(latLo, south, north); s <= square(latHi, south, north); s++) {
      for (let w = square(lonLo, west, east); w <= square(lonHi, west, east); w++) {
        const f = this.bySquare.get(squareKey(s, w));
        if (!f) continue;
        const n = f.step;
        let k = 1;
        for (const d of STRIDES) if (d <= spacing * n) k = d;
        const clamp = (v: number) => Math.min(Math.max(v, 0), n);
        const r0 = Math.floor(Math.floor(clamp((f.south + 1 - Math.min(latHi, f.south + 1)) * n)) / k) * k;
        const r1 = Math.min(Math.ceil((Math.ceil(clamp((f.south + 1 - Math.max(latLo, f.south)) * n)) + 1) / k) * k, n);
        const c0 = Math.floor(Math.floor(clamp((Math.max(lonLo, f.west) - f.west) * n)) / k) * k;
        const c1 = Math.min(Math.ceil((Math.ceil(clamp((Math.min(lonHi, f.west + 1) - f.west) * n)) + 1) / k) * k, n);
        const rows = (r1 - r0) / k + 1;
        const cols = (c1 - c0) / k + 1;
        const p: Patch = { f, k, r0, c0, rows, cols, data: new Int16Array(rows * cols) };
        patches.set(squareKey(s, w), p);
        jobs.push(readPatch(p));
      }
    }
    await Promise.all(jobs);

    let lastKey = NaN;
    let p: Patch | undefined;
    const at = (r: number, c: number) => p!.data[r * p!.cols + c];
    return (lon, lat) => {
      const key = squareKey(square(lat, south, north), square(lon, west, east));
      if (key !== lastKey) [lastKey, p] = [key, patches.get(key)];
      if (!p) return 0;
      const { f, k } = p;
      const row = Math.min(Math.max(((f.south + 1 - lat) * f.step - p.r0) / k, 0), p.rows - 1);
      const col = Math.min(Math.max(((lon - f.west) * f.step - p.c0) / k, 0), p.cols - 1);
      return bilinear(at, row, col, p.rows, p.cols);
    };
  }
}

/** Fills a patch from its file, a few stored rows at a time. Each read is one span from the first
 *  wanted sample to the last, as one read is cheaper than one per row. */
async function readPatch(p: Patch): Promise<void> {
  const rowBytes = (p.f.step + 1) * 2;
  const rowStride = p.k * rowBytes;
  const colStride = p.k * 2;
  for (let done = 0; done < p.rows; done += CHUNK_ROWS) {
    const n = Math.min(CHUNK_ROWS, p.rows - done);
    const start = (p.r0 + done * p.k) * rowBytes + p.c0 * 2;
    const bytes = await p.f.src.read(start, (n - 1) * rowStride + (p.cols - 1) * colStride + 2);
    for (let r = 0; r < n; r++) {
      const dst = (done + r) * p.cols;
      for (let c = 0, i = r * rowStride; c < p.cols; c++, i += colStride) p.data[dst + c] = hgtSample(bytes, i);
    }
  }
}
