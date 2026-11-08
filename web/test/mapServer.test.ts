import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { findMaps, slug } from '../map-server/src/maps';
import { encodePng } from '../map-server/src/png';
import { createHandler } from '../map-server/src/server';
import { buildSprite } from '../map-server/src/sprite';
import { decodeTerrainRgb } from '../src/dem/hgt';
import { lonToTileX, latToTileY } from '../src/tiles/tileMath';
import { DETAILED, hasRealData, REPO } from './helpers/paths';

/** The pixels of a PNG written by encodePng (rows unfiltered or filtered "Up"). */
function decodePng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length; ) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    expect([0, 2]).toContain(filter);
    for (let i = 0; i < stride; i++) {
      rgba[y * stride + i] = raw[y * (stride + 1) + 1 + i] + (filter === 2 && y ? rgba[(y - 1) * stride + i] : 0);
    }
  }
  return { width, height, rgba };
}

describe('png', () => {
  test('round trips RGBA pixels', () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) % 256);
    const png = encodePng(3, 2, rgba);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const back = decodePng(png);
    expect([back.width, back.height]).toEqual([3, 2]);
    expect([...back.rgba]).toEqual([...rgba]);
  });

  test('rejects the wrong number of bytes', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(/16 bytes/);
  });
});

describe('sprite', () => {
  const solid = (width: number, height: number, v: number) => ({ width, height, data: new Uint8Array(width * height * 4).fill(v) });

  test('packs images without overlap and copies their pixels', () => {
    const images = new Map([
      ['a', solid(10, 20, 1)],
      ['b', solid(30, 5, 2)],
      ['c', solid(25, 25, 3)],
    ]);
    const { png, index } = buildSprite(images, 40);
    const sheet = decodePng(png);
    for (const [id, img] of images) {
      const at = index[id];
      expect(at).toMatchObject({ width: img.width, height: img.height, pixelRatio: 1 });
      expect(at.x + at.width).toBeLessThanOrEqual(sheet.width);
      expect(at.y + at.height).toBeLessThanOrEqual(sheet.height);
      for (const [px, py] of [[0, 0], [at.width - 1, at.height - 1]]) {
        expect(sheet.rgba[((at.y + py) * sheet.width + at.x + px) * 4]).toBe(img.data[0]);
      }
    }
    const boxes = Object.values(index);
    for (const p of boxes) for (const q of boxes) {
      if (p === q) continue;
      const apart = p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y;
      expect(apart).toBe(true);
    }
  });

  test('an empty sheet is still a valid image', () => {
    const { png, index } = buildSprite(new Map());
    expect(index).toEqual({});
    expect(decodePng(png).width).toBe(1);
  });
});

test('slug', () => {
  expect(slug('Iceland GPSmap.is 2024.21 Detailed.img')).toBe('iceland-gpsmap-is-2024-21-detailed');
  expect(slug('Ísland — Þórsmörk.IMG')).toBe('island-thorsmork');
  expect(slug('.img')).toBe('map');
});

async function listen(handler: ReturnType<typeof createHandler>): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('server without maps', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const pub = await mkdtemp(join(tmpdir(), 'map-server-pub-'));
    await writeFile(join(pub, 'widget.js'), 'export {};');
    await mkdir(join(pub, 'fonts/Noto Sans Regular'), { recursive: true });
    await writeFile(join(pub, 'fonts/Noto Sans Regular/0-255.pbf'), new Uint8Array([1, 2, 3]));
    await writeFile(join(dirname(pub), 'secret.js'), 'no');
    ({ server, base } = await listen(createHandler(new Map(), { origins: ['https://site.example'], publicDir: pub })));
  });
  afterAll(() => server.close());

  test('lists no maps and says so on its front page', async () => {
    expect(await (await fetch(`${base}/maps`)).json()).toEqual([]);
    expect(await (await fetch(`${base}/`)).text()).toContain('No maps found');
  });

  test('serves the widget and fonts, nothing outside its folder', async () => {
    const js = await fetch(`${base}/widget.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${base}/fonts/Noto%20Sans%20Regular/0-255.pbf`)).status).toBe(200);
    expect((await fetch(`${base}/%2e%2e/secret.js`)).status).toBe(404);
    expect((await fetch(`${base}/maps/nope/style.json`)).status).toBe(404);
    expect((await fetch(`${base}/%E0`)).status).toBe(400);
  });

  test('ignores X-Forwarded-Host unless told to trust a proxy', async () => {
    const page = await (await fetch(`${base}/`, { headers: { 'X-Forwarded-Host': 'evil.example' } })).text();
    expect(page).not.toContain('evil.example');
  });

  test('lets only the listed sites use it', async () => {
    const ok = await fetch(`${base}/maps`, { headers: { Origin: 'https://site.example' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://site.example');
    expect(ok.headers.get('vary')).toContain('Origin');
    const other = await fetch(`${base}/maps`, { headers: { Origin: 'https://other.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${base}/maps`, { method: 'POST' })).status).toBe(405);
  });
});

describe.skipIf(!hasRealData)('server on the real map', () => {
  let server: Server;
  let base: string;
  const id = 'iceland-gpsmap-is-2024-21-detailed';
  beforeAll(async () => {
    // As the README suggests: the map package linked into the maps folder.
    const maps = await mkdtemp(join(tmpdir(), 'map-server-maps-'));
    await symlink(dirname(dirname(DETAILED)), join(maps, 'gpsmap'));
    const found = await findMaps(maps, () => {});
    ({ server, base } = await listen(createHandler(found, { origins: ['*'], publicDir: REPO + 'web/map-server/dist/public', trustProxy: true })));
  }, 60_000);
  afterAll(() => server.close());

  test('finds the package\'s four maps, with terrain', async () => {
    const list = (await (await fetch(`${base}/maps`)).json()) as Array<{ id: string; terrain: boolean }>;
    expect(list.map((m) => m.id)).toContain(id);
    expect(list).toHaveLength(4);
    expect(list.every((m) => m.terrain)).toBe(true);
  });

  test('style.json points at this server, with a sprite that has every icon', async () => {
    const style = await (await fetch(`${base}/maps/${id}/style.json`, { headers: { 'X-Forwarded-Host': 'maps.example.com', 'X-Forwarded-Proto': 'https' } })).json();
    expect(style.sources.garmin.tiles[0]).toMatch(/^https:\/\/maps\.example\.com\/maps\/[^/]+\/tiles\/\{z\}\/\{x\}\/\{y\}\.pbf\?v=/);
    expect(style.sources.dem.tiles[0]).toMatch(/^https:\/\/maps\.example\.com\/.*\/terrain\//);
    expect(style.glyphs).toBe('https://maps.example.com/fonts/{fontstack}/{range}.pbf');
    const index = await (await fetch(`${base}/maps/${id}/sprite.json`)).json();
    const used = new Set<string>();
    for (const l of style.layers) {
      const p = l.paint?.['fill-pattern'];
      if (typeof p === 'string') used.add(p);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(index[name]).toBeDefined();
    expect(Object.keys(index).some((k) => k.startsWith('pt-'))).toBe(true);
  });

  test('a tile over Reykjavík has its streets, and a second request is the same bytes', async () => {
    const z = 13;
    const x = lonToTileX(-21.94, z);
    const y = latToTileY(64.146, z);
    const res = await fetch(`${base}/maps/${id}/tiles/${z}/${x}/${y}.pbf`);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tile = new VectorTile(new PbfReader(bytes));
    const lines = tile.layers.lines;
    expect(lines.length).toBeGreaterThan(50);
    const geom = lines.feature(0).loadGeometry();
    expect(geom.length).toBeGreaterThan(0);
    expect(geom[0].length).toBeGreaterThan(1);
    const again = new Uint8Array(await (await fetch(`${base}/maps/${id}/tiles/${z}/${x}/${y}.pbf`)).arrayBuffer());
    expect(again).toEqual(bytes);
    expect((await fetch(`${base}/maps/${id}/tiles/15/${x * 4}/${y * 4}.pbf`)).status).toBe(404);
  });

  test('terrain tiles are 256 px Terrain-RGB with Hekla at the right height', async () => {
    const z = 10;
    const lon = -19.6658;
    const lat = 63.9922;
    const res = await fetch(`${base}/maps/${id}/terrain/${z}/${lonToTileX(lon, z)}/${latToTileY(lat, z)}.png`);
    expect(res.headers.get('content-type')).toBe('image/png');
    const { width, height, rgba } = decodePng(new Uint8Array(await res.arrayBuffer()));
    expect([width, height]).toEqual([256, 256]);
    // A tile is 256 = 2^8 pixels across.
    const px = lonToTileX(lon, z + 8) % 256;
    const py = latToTileY(lat, z + 8) % 256;
    let top = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i = ((py + dy) * 256 + px + dx) * 4;
      top = Math.max(top, decodeTerrainRgb(rgba[i], rgba[i + 1], rgba[i + 2]));
    }
    expect(top).toBeGreaterThan(1300);
    expect(top).toBeLessThan(1600);
  });
});
