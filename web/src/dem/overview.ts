import { ImgError } from '../img/bytes';
import { HGT_STEP, hgtSample } from './hgt';

/** A decimated mosaic: sample (r, c) is at lat = north - r*step/1200, lon = west + c*step/1200. */
export interface Overview {
  step: number;
  west: number;
  north: number;
  rows: number;
  cols: number;
  data: Int16Array;
}

/** Largest elevation extent (in 1°×1° tiles, gaps included) the overview mosaic accepts. The
 *  mosaic covers the whole bounding box of the given tiles, so two far-apart files would otherwise
 *  allocate an enormous array (400 tiles at step 8 is ~9 M samples, ~18 MB). */
export const MAX_OVERVIEW_TILES = 400;

export class OverviewBuilder {
  private readonly o: Overview;
  private readonly southMax: number;
  private readonly westMin: number;

  constructor(tiles: Array<{ south: number; west: number }>, step = 8) {
    if (HGT_STEP % step) throw new Error('overview step must divide 1200');
    const souths = tiles.map((t) => t.south);
    const wests = tiles.map((t) => t.west);
    this.southMax = Math.max(...souths);
    this.westMin = Math.min(...wests);
    const nLat = this.southMax - Math.min(...souths) + 1;
    const nLon = Math.max(...wests) - this.westMin + 1;
    if (nLat * nLon > MAX_OVERVIEW_TILES) {
      throw new ImgError(
        `Elevation files span ${nLat}° of latitude × ${nLon}° of longitude (${nLat * nLon} tiles including gaps); ` +
          `at most ${MAX_OVERVIEW_TILES} are supported. Pick the .hgt files for one region only.`,
      );
    }
    const rows = (nLat * HGT_STEP) / step + 1;
    const cols = (nLon * HGT_STEP) / step + 1;
    this.o = { step, west: this.westMin, north: this.southMax + 1, rows, cols, data: new Int16Array(rows * cols) };
  }

  /** `bytes` is one whole .hgt file of `fileStep` samples per degree (1200, or 3600 for 1″); only
   *  the samples the overview keeps are decoded. */
  add(south: number, west: number, bytes: Uint8Array, fileStep = HGT_STEP): void {
    const { step, cols, data } = this.o;
    const r0 = ((this.southMax - south) * HGT_STEP) / step;
    const c0 = ((west - this.westMin) * HGT_STEP) / step;
    const k = (step * fileStep) / HGT_STEP; // file samples between overview samples
    const size = fileStep + 1;
    for (let r = 0; r <= HGT_STEP / step; r++) {
      for (let c = 0; c <= HGT_STEP / step; c++) data[(r0 + r) * cols + c0 + c] = hgtSample(bytes, (r * k * size + c * k) * 2);
    }
  }

  finish(): Overview {
    return this.o;
  }
}

const MAGIC = 0x4f4d4544; // "DEMO" little-endian

export function encodeOverview(o: Overview): Uint8Array {
  const out = new Uint8Array(24 + o.data.length * 2);
  const dv = new DataView(out.buffer);
  [MAGIC, o.step, o.west, o.north, o.rows, o.cols].forEach((v, i) => dv.setInt32(i * 4, v, true));
  for (let i = 0; i < o.data.length; i++) dv.setInt16(24 + i * 2, o.data[i], true);
  return out;
}

export function decodeOverview(bytes: Uint8Array): Overview {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 || dv.getInt32(0, true) !== MAGIC) throw new ImgError('dem-overview.bin: bad header');
  const [step, west, north, rows, cols] = [1, 2, 3, 4, 5].map((i) => dv.getInt32(i * 4, true));
  if (bytes.length !== 24 + rows * cols * 2) throw new ImgError('dem-overview.bin: truncated');
  const data = new Int16Array(rows * cols);
  for (let i = 0; i < data.length; i++) data[i] = dv.getInt16(24 + i * 2, true);
  return { step, west, north, rows, cols, data };
}
