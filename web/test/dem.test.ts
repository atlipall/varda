import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Dem } from '../src/dem/dem';
import { decodeHgt, decodeTerrainRgb, encodeTerrainRgb, HGT_BYTES, HGT_HD_STEP, HGT_SIZE, hgtStep, onePerSquare, parseHgtName } from '../src/dem/hgt';
import { decodeOverview, encodeOverview, MAX_OVERVIEW_TILES, OverviewBuilder } from '../src/dem/overview';
import { BlobSource } from '../src/img/source';
import { latToTileY, lonToTileX } from '../src/tiles/tileMath';
import { nodeSource } from './helpers/nodeSource';
import { REPO } from './helpers/paths';

const HGT_DIR = REPO + 'map-files/GPSmap.is 2024.21 Android/HILLSHADE - Add content to DEM folder/';
const HD_DIR = REPO + 'map-files/HD Hillshade 3 for Android/COPY CONTENTS TO DEM FOLDER/';

/** A synthetic tile whose height is a function of (row, col) inside the file. */
function makeHgt(f: (r: number, c: number) => number, size = HGT_SIZE): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size * size * 2);
  const dv = new DataView(b.buffer);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dv.setInt16((r * size + c) * 2, f(r, c), false);
  return b;
}
const HD_SIZE = HGT_HD_STEP + 1;

const heightsOf = (rgba: Uint8ClampedArray | Uint8Array) => {
  const out: number[] = [];
  for (let i = 0; i < rgba.length; i += 4) out.push(decodeTerrainRgb(rgba[i], rgba[i + 1], rgba[i + 2]));
  return out;
};

describe('hgt basics', () => {
  test('names', () => {
    expect(parseHgtName('n63w019.hgt')).toEqual({ south: 63, west: -19 });
    expect(parseHgtName('S12E005.HGT')).toEqual({ south: -12, west: 5 });
    expect(parseHgtName('dem/n66w025.hgt')).toEqual({ south: 66, west: -25 });
    expect(parseHgtName('readme.txt')).toBeNull();
  });

  test('decode clips voids and negatives', () => {
    const d = decodeHgt(new Uint8Array([0x00, 0x10, 0xff, 0xff, 0x80, 0x00, 0x07, 0xd0]));
    expect([...d]).toEqual([16, 0, 0, 2000]);
  });

  test('terrain-RGB round trip', () => {
    const px = new Uint8ClampedArray(4);
    encodeTerrainRgb(2112, px, 0);
    expect([...px]).toEqual([1, 217, 32, 255]);
    expect(decodeTerrainRgb(1, 217, 32)).toBeCloseTo(2112, 6);
    encodeTerrainRgb(-50, px, 0);
    expect(decodeTerrainRgb(px[0], px[1], px[2])).toBeCloseTo(0, 6);
  });
});

describe('Dem on synthetic tiles', () => {
  // two stacked tiles: n64w020 (north) above n63w020 (south); height = 1000 + mosaic row
  const north = makeHgt((r) => 1000 + r);
  const south = makeHgt((r) => 1000 + 1200 + r);
  const files = [
    { name: 'n64w020.hgt', src: new BlobSource(new Blob([north])) },
    { name: 'n63w020.hgt', src: new BlobSource(new Blob([south])) },
  ];

  test('bounds and orientation (north is up, heights grow southward)', async () => {
    const dem = Dem.fromFiles(files, null);
    expect(dem.bounds).toEqual([-20, 63, -19, 65]);
    const z = 11;
    const t = await dem.tile(z, lonToTileX(-19.5, z), latToTileY(64.5, z));
    const h = heightsOf(t);
    expect(h[0]).toBeLessThan(h[255 * 256]); // top row is north → smaller row → lower height
    for (const v of h) expect(v).toBeGreaterThan(1000);
  });

  test('elevationAt samples one point bilinearly, and is null outside the mosaic', async () => {
    const dem = Dem.fromFiles(files, null);
    // Mosaic row = (65 - lat) * 1200; height = 1000 + row. Row 600.5 → 1600.5.
    expect(await dem.elevationAt(-19.5, 65 - 600.5 / 1200)).toBeCloseTo(1600.5, 6);
    // In the southern file: row 1200 + 300 → 2500.
    expect(await dem.elevationAt(-19.25, 64 - 300 / 1200)).toBeCloseTo(2500, 6);
    expect(await dem.elevationAt(-10, 64.5)).toBeNull();
    expect(await dem.elevationAt(-19.5, 66)).toBeNull();
  });

  test('outside the mosaic is zero', async () => {
    const dem = Dem.fromFiles(files, null);
    const t = await dem.tile(11, lonToTileX(-10, 11), latToTileY(64.5, 11));
    expect(Math.max(...heightsOf(t))).toBe(0);
  });

  test('overview matches full resolution closely at low zoom', async () => {
    const b = new OverviewBuilder([{ south: 64, west: -20 }, { south: 63, west: -20 }]);
    b.add(64, -20, north);
    b.add(63, -20, south);
    const ov = decodeOverview(encodeOverview(b.finish()));
    expect([ov.step, ov.rows, ov.cols]).toEqual([8, 301, 151]);
    const full = Dem.fromFiles(files, null);
    const coarse = Dem.fromFiles(files, ov);
    const [x, y] = [lonToTileX(-19.5, 8), latToTileY(64, 8)];
    const a = heightsOf(await full.tile(8, x, y));
    const c = heightsOf(await coarse.tile(8, x, y));
    let maxDiff = 0;
    a.forEach((v, i) => (maxDiff = Math.max(maxDiff, Math.abs(v - c[i]))));
    expect(maxDiff).toBeLessThan(1.0); // linear field: bilinear on the coarse grid is near-exact
  });

  test('overview rejects an elevation extent that would blow up the mosaic', () => {
    // Two far-apart tiles: 20° × 21° bounding box = 420 tiles > 400.
    expect(() => new OverviewBuilder([{ south: 50, west: -30 }, { south: 69, west: -10 }])).toThrow(/20° of latitude × 21° of longitude.*at most 400/);
    // Exactly at the cap is fine (20 × 20).
    expect(() => new OverviewBuilder([{ south: 50, west: -30 }, { south: 69, west: -11 }])).not.toThrow();
    expect(MAX_OVERVIEW_TILES).toBe(400);
  });

  test('rejects bad files', () => {
    expect(() => Dem.fromFiles([{ name: 'foo.hgt', src: new BlobSource(new Blob([north])) }], null)).toThrow(/foo\.hgt/);
    expect(() => Dem.fromFiles([{ name: 'n63w020.hgt', src: new BlobSource(new Blob([new Uint8Array(10)])) }], null)).toThrow(/1201×1201 \(3″\) or 3601×3601 \(1″\)/);
  });
});

describe('1″ (HD) tiles', () => {
  // Height in metres = 2 × arc-seconds south of 65°N, whatever the file's grid: the same field in
  // a 3″ file (1200 per degree) and a 1″ file (3600 per degree).
  const field = (lat: number) => (65 - lat) * 7200;
  const hd64 = makeHgt((r) => r * 2, HD_SIZE); // n64w020: north edge at 65°
  const sd63 = makeHgt((r) => 7200 + r * 6); // n63w020, 3″
  const sd64 = makeHgt(() => 1); // n64w020 again, 3″: loses to the HD one
  const src = (b: Uint8Array<ArrayBuffer>) => new BlobSource(new Blob([b]));

  test('sizes', () => {
    expect(hgtStep(HGT_BYTES)).toBe(1200);
    expect(hgtStep(25934402)).toBe(3600);
    expect(hgtStep(25934400)).toBeNull();
  });

  test('one file per square, the finest winning, whatever the order or case', () => {
    const picked = onePerSquare([
      { name: 'N64W020.hgt', south: 64, west: -20, step: 3600 },
      { name: 'n64w020.hgt', south: 64, west: -20, step: 1200 },
      { name: 'n63w020.hgt', south: 63, west: -20, step: 1200 },
    ]);
    expect(picked.map((p) => [p.name, p.step])).toEqual([['n63w020.hgt', 1200], ['N64W020.hgt', 3600]]);
  });

  test('a 1″ file next to a 3″ one samples each in its own grid', async () => {
    const dem = Dem.fromFiles([{ name: 'n64w020.hgt', src: src(sd64) }, { name: 'N64W020.hgt', src: src(hd64) }, { name: 'n63w020.hgt', src: src(sd63) }], null);
    expect(dem.bounds).toEqual([-20, 63, -19, 65]);
    expect(dem.maxZoom).toBe(12);
    for (const lat of [64.9, 64.5 + 1 / 7200, 64.0001, 64, 63.9999, 63.3]) {
      expect(await dem.elevationAt(-19.4, lat)).toBeCloseTo(field(lat), 3);
    }
    // A whole zoom-12 tile across the seam at 64°N: heights follow the field on both sides.
    const z = 12;
    const [x, y] = [lonToTileX(-19.5, z), latToTileY(64, z)];
    const h = heightsOf(await dem.tile(z, x, y));
    const latOf = (py: number) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (y + (py + 0.5) / 256)) / 2 ** z)) * 180) / Math.PI;
    for (const py of [0, 77, 128, 200, 255]) expect(h[py * 256 + 40]).toBeCloseTo(field(latOf(py)), 0);
  });

  test('zoomed out (every k-th 1″ sample kept) agrees with single-point lookups', async () => {
    const dem = Dem.fromFiles([{ name: 'N64W020.hgt', src: src(hd64) }, { name: 'n63w020.hgt', src: src(sd63) }], null);
    const z = 9;
    const [x, y] = [lonToTileX(-19.5, z), latToTileY(64, z)];
    const h = heightsOf(await dem.tile(z, x, y));
    const lonOf = (px: number) => ((x + (px + 0.5) / 256) / 2 ** z) * 360 - 180;
    const latOf = (py: number) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (y + (py + 0.5) / 256)) / 2 ** z)) * 180) / Math.PI;
    for (const [px, py] of [[0, 0], [100, 50], [128, 128], [255, 255], [30, 200]]) {
      const lon = lonOf(px);
      const lat = latOf(py);
      if (lon < -20 || lon > -19 || lat < 63 || lat > 65) continue;
      expect(h[py * 256 + px]).toBeCloseTo((await dem.elevationAt(lon, lat))!, 0);
    }
  });

  test('3″ files alone keep zoom 11', () => {
    expect(Dem.fromFiles([{ name: 'n63w020.hgt', src: src(sd63) }], null).maxZoom).toBe(11);
  });

  test('the overview takes 1″ files at the same spacing', () => {
    const b = new OverviewBuilder([{ south: 64, west: -20 }]);
    b.add(64, -20, hd64, HGT_HD_STEP);
    const ov = b.finish();
    expect([ov.rows, ov.cols]).toEqual([151, 151]);
    // Overview row r is 8 × 3″ = 24″ south of 65°N: 48 m.
    expect([ov.data[0], ov.data[151], ov.data[150 * 151 + 7]]).toEqual([0, 48, 7200]);
  });
});

describe.skipIf(!existsSync(HGT_DIR))('elevationAt on the real elevation files', () => {
  test('known summits and sea level', async () => {
    const names = readdirSync(HGT_DIR).filter((n) => n.endsWith('.hgt'));
    const dem = Dem.fromFiles(await Promise.all(names.map(async (name) => ({ name, src: await nodeSource(HGT_DIR + name) }))), null);
    // Highest point on a ~100 m grid around each summit (SRTM's ~90 m grid smooths peaks a little):
    // Hekla 1488 m (63.99 N, 19.67 W), Esja's Hábunga 914 m (64.25 N, 21.62 W).
    const peak = async (lon: number, lat: number) => {
      let best = -Infinity;
      for (let dy = -0.02; dy <= 0.02; dy += 0.001) for (let dx = -0.04; dx <= 0.04; dx += 0.002) best = Math.max(best, (await dem.elevationAt(lon + dx, lat + dy))!);
      return best;
    };
    expect(await peak(-19.67, 63.99)).toBeGreaterThan(1400);
    expect(await peak(-19.67, 63.99)).toBeLessThan(1520);
    expect(await peak(-21.62, 64.25)).toBeGreaterThan(850);
    expect(await peak(-21.62, 64.25)).toBeLessThan(940);
    expect(await dem.elevationAt(-23.0, 64.3)).toBe(0); // middle of Faxaflói, open sea
  });
});

describe.skipIf(!existsSync(HD_DIR))('the HD (1″) elevation files', () => {
  test('load, and Hekla stands about as high', async () => {
    const names = readdirSync(HD_DIR).filter((n) => /\.hgt$/i.test(n));
    const dem = Dem.fromFiles(await Promise.all(names.map(async (name) => ({ name, src: await nodeSource(HD_DIR + name) }))), null);
    expect(dem.maxZoom).toBe(12);
    let best = -Infinity;
    for (let dy = -0.02; dy <= 0.02; dy += 0.0005) for (let dx = -0.04; dx <= 0.04; dx += 0.001) best = Math.max(best, (await dem.elevationAt(-19.67 + dx, 63.99 + dy))!);
    expect(best).toBeGreaterThan(1440);
    expect(best).toBeLessThan(1520);
    expect(await dem.elevationAt(-23.0, 64.3)).toBe(0);
  });
});

