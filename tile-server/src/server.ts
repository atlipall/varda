import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { StyleSpecification } from 'maplibre-gl';
import { DEM_TILE_SIZE, MAX_ZOOM, MIN_ZOOM } from '../../web/src/map/zoom';
import { buildStyle } from '../../web/src/style/buildStyle';
import { demoPage } from './demo';
import type { ServedMap } from './maps';
import { encodePng } from './png';

export interface ServerOptions {
  /** The address the server is reached at from outside ("https://maps.example.com"), used in the
   *  URLs inside style.json. Without it they're built from the request's Host. */
  publicUrl?: string;
  /** Build those URLs from X-Forwarded-Host and X-Forwarded-Proto: only behind a proxy that sets
   *  them, since anyone can send them. */
  trustProxy?: boolean;
  /** Pages allowed to use the map ("*" for any). */
  origins: string[];
  /** The widget script, MapLibre's worker files and the fonts. */
  publicDir: string;
  /** Bytes of built tiles kept in memory. */
  cacheBytes?: number;
}

export const DEFAULT_CACHE_MB = 256;

export interface MapInfo {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  terrain: boolean;
  credit: string | null;
  style: string;
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};
const DAY = 86_400;

/** A response body, with its gzipped copy made once (images aren't worth compressing). Copied so a
 *  view into a bigger buffer doesn't keep that whole buffer in the cache. */
class Body {
  readonly raw: Uint8Array;
  readonly gzipped: Uint8Array | null;
  constructor(data: Uint8Array | string, readonly type: string) {
    this.raw = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    this.gzipped = !type.startsWith('image/') && this.raw.length > 512 ? gzipSync(this.raw).slice() : null;
  }
  get size(): number {
    return this.raw.length + (this.gzipped?.length ?? 0);
  }
}

/** Built tiles kept by size, least recently used dropped first; one build for requests that overlap. */
class TileCache {
  private readonly done = new Map<string, Body>();
  private readonly pending = new Map<string, Promise<Body>>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  get(key: string, build: () => Promise<Body>): Promise<Body> {
    const hit = this.done.get(key);
    if (hit) {
      this.done.delete(key);
      this.done.set(key, hit);
      return Promise.resolve(hit);
    }
    let p = this.pending.get(key);
    if (!p) {
      p = build().finally(() => this.pending.delete(key));
      p.then((body) => {
        this.done.set(key, body);
        this.bytes += body.size;
        for (const [k, v] of this.done) {
          if (this.bytes <= this.maxBytes) break;
          this.done.delete(k);
          this.bytes -= v.size;
        }
      }, () => {});
      this.pending.set(key, p);
    }
    return p;
  }
}

interface Reply {
  body: Body;
  maxAge: number;
  /** Has the server's address in it, taken from the request unless --public-url is set. */
  addressed?: boolean;
}

/** Whether the client takes gzip: listed (or "*") without q=0. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  let gzip: boolean | null = null;
  let any = false;
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';').map((p) => p.trim());
    const q = params.find((p) => p.startsWith('q='));
    const ok = !q || Number(q.slice(2)) > 0;
    if (name === 'gzip') gzip = ok;
    else if (name === '*') any = ok;
  }
  return gzip ?? any;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const TILE = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/;
const TERRAIN = /^\/terrain\/(\d+)\/(\d+)\/(\d+)\.png$/;
const SPRITE = /^\/sprite(?:@2x)?\.(json|png)$/;

export function createHandler(maps: Map<string, ServedMap>, opts: ServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const tiles = new TileCache(opts.cacheBytes ?? DEFAULT_CACHE_MB * 1024 * 1024);
  const files = new Map<string, Promise<Body>>();
  const publicUrl = opts.publicUrl?.replace(/\/+$/, '');
  const publicDir = normalize(opts.publicDir + sep);
  const anyOrigin = opts.origins.includes('*');

  const baseUrl = (req: IncomingMessage): string => {
    if (publicUrl) return publicUrl;
    const first = (h: string | string[] | undefined) => String(h ?? '').split(',')[0].trim();
    const proto = (opts.trustProxy && first(req.headers['x-forwarded-proto'])) || 'http';
    const host = (opts.trustProxy && first(req.headers['x-forwarded-host'])) || first(req.headers.host) || 'localhost';
    return `${proto}://${host}`;
  };

  const info = (m: ServedMap, base: string): MapInfo => ({
    id: m.id,
    name: m.name,
    bounds: m.map.bounds,
    minzoom: MIN_ZOOM,
    maxzoom: MAX_ZOOM,
    terrain: m.terrainBounds !== null,
    credit: m.credit,
    style: `${base}/maps/${m.id}/style.json`,
  });
  const list = (base: string) => [...maps.values()].map((m) => info(m, base));

  const style = (m: ServedMap, base: string): StyleSpecification => {
    const at = `${base}/maps/${m.id}`;
    const terrain = m.terrainBounds;
    const { style } = buildStyle(m.style, {
      tiles: `${at}/tiles/{z}/{x}/{y}.pbf?v=${m.version}`,
      glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
      sprite: `${at}/sprite?v=${m.version}`,
      bounds: m.map.bounds,
      ...(m.credit ? { attribution: m.credit } : {}),
      ...(terrain ? { dem: `${at}/terrain/{z}/{x}/{y}.png?v=${m.terrainVersion}`, demBounds: terrain, demMaxZoom: m.terrainMaxZoom } : {}),
    });
    return { ...style, name: m.name };
  };

  const tileXY = (match: RegExpExecArray, minZoom: number, maxZoom: number): [number, number, number] => {
    const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (z < minZoom || z > maxZoom) throw new HttpError(404, `tiles go from zoom ${minZoom} to ${maxZoom}`);
    if (x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, 'no such tile');
    return [z, x, y];
  };

  const mapRoute = async (m: ServedMap, rest: string, base: string): Promise<Reply> => {
    if (rest === '' || rest === '/') return { body: new Body(JSON.stringify(info(m, base)), TYPES['.json']), maxAge: 60, addressed: true };
    if (rest === '/style.json') return { body: new Body(JSON.stringify(style(m, base)), TYPES['.json']), maxAge: 60, addressed: true };
    let match = SPRITE.exec(rest);
    if (match) {
      const body = await tiles.get(`${m.id}/sprite.${match[1]}`, async () =>
        match![1] === 'json' ? new Body(JSON.stringify(m.sprite.index), TYPES['.json']) : new Body(m.sprite.png, TYPES['.png']),
      );
      return { body, maxAge: DAY };
    }
    if ((match = TILE.exec(rest))) {
      const [z, x, y] = tileXY(match, MIN_ZOOM, MAX_ZOOM);
      return { body: await tiles.get(`${m.id}/${z}/${x}/${y}`, async () => new Body(await m.tile(z, x, y), TYPES['.pbf'])), maxAge: DAY };
    }
    if ((match = TERRAIN.exec(rest))) {
      if (!m.terrainBounds) throw new HttpError(404, 'this map has no terrain');
      const [z, x, y] = tileXY(match, 0, m.terrainMaxZoom);
      const body = await tiles.get(`${m.id}/terrain/${z}/${x}/${y}`, async () => new Body(encodePng(DEM_TILE_SIZE, DEM_TILE_SIZE, await m.terrainTile(z, x, y)), TYPES['.png']));
      return { body, maxAge: DAY };
    }
    throw new HttpError(404, 'not found');
  };

  /** The widget, MapLibre's worker files and the fonts, read once. */
  const staticFile = (path: string): Promise<Body> => {
    const file = normalize(join(publicDir, path));
    const type = TYPES[extname(file)];
    if (!file.startsWith(publicDir) || !type) return Promise.reject(new HttpError(404, 'not found'));
    let body = files.get(file);
    if (!body) {
      body = readFile(file).then((data) => new Body(new Uint8Array(data), type), () => {
        files.delete(file);
        throw new HttpError(404, 'not found');
      });
      files.set(file, body);
    }
    return body;
  };

  const route = async (req: IncomingMessage, path: string): Promise<Reply> => {
    const base = baseUrl(req);
    if (path === '/' || path === '/index.html') return { body: new Body(demoPage(list(base), base), TYPES['.html']), maxAge: 60, addressed: true };
    if (path === '/maps' || path === '/maps/') return { body: new Body(JSON.stringify(list(base)), TYPES['.json']), maxAge: 60, addressed: true };
    const mm = /^\/maps\/([^/]+)(\/.*)?$/.exec(path);
    if (mm) {
      const m = maps.get(mm[1]);
      if (!m) throw new HttpError(404, `no map "${mm[1]}"`);
      return mapRoute(m, mm[2] ?? '', base);
    }
    return { body: await staticFile(path), maxAge: path.startsWith('/fonts/') ? 7 * DAY : 300 };
  };

  return (req, res) => {
    const vary: string[] = [];
    if (anyOrigin) res.setHeader('Access-Control-Allow-Origin', '*');
    else {
      vary.push('Origin');
      if (req.headers.origin && opts.origins.includes(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': String(DAY) }).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad address');
      return;
    }
    route(req, path).then(
      ({ body, maxAge, addressed }) => {
        const gzip = body.gzipped && acceptsGzip(req.headers['accept-encoding']);
        const data = gzip ? body.gzipped! : body.raw;
        if (body.gzipped) vary.push('Accept-Encoding');
        res.writeHead(200, {
          'Content-Type': body.type,
          // Built from the Host the client sent: not for shared caches, which might hand it to others.
          'Cache-Control': `${addressed && !publicUrl ? 'private' : 'public'}, max-age=${maxAge}`,
          'Content-Length': String(data.length),
          ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
          ...(vary.length ? { Vary: vary.join(', ') } : {}),
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      },
      (err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(`${req.url}:`, err);
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(status === 500 ? 'server error' : err.message);
      },
    );
  };
}
