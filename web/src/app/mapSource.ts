import type { StyleSpecification } from 'maplibre-gl';
import { emptyTyp, parseTyp, type RgbaImage, type Typ } from '../img/typ';
import type { Stored } from '../storage/store';
import { buildStyle } from '../style/buildStyle';
import { TilePool, type OpenMeta } from '../worker/pool';

/** One stored map opened for drawing: its tile workers, its style and icons. Several maps are kept;
 *  the viewer swaps sources to switch between them (and to change a map's hillshading). */
export interface MapSource {
  stored: Stored;
  pool: TilePool;
  meta: OpenMeta;
  style: StyleSpecification;
  images: Map<string, RgbaImage>;
  /** The layers and sources this map's style brings (everything else on the map is the app's own). */
  baseLayers: Set<string>;
  baseSources: Set<string>;
}

/** Touch devices tend to have many cores but weaker per-core performance and tighter memory, so
 *  they get a small fixed worker count; other devices scale with `hardwareConcurrency` (leaving
 *  one core for the main thread, capped so we don't over-subscribe). */
function tileWorkerCount(): number {
  if (navigator.maxTouchPoints > 0) return 2;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
}

/** Tile addresses carry `gen`, so a switched-to map's tiles are never taken for the last one's. */
export const tileUrl = (scheme: 'garmin' | 'dem', gen: number) => `${scheme}://{z}/{x}/{y}?v=${gen}`;

/** z, x, y and the generation of a tile address made by `tileUrl`. */
export function parseTileUrl(url: string): { z: number; x: number; y: number; gen: number } {
  const m = /^[a-z]+:\/\/(\d+)\/(\d+)\/(\d+)(?:\?v=(\d+))?$/.exec(url);
  if (!m) throw new Error(`bad tile url ${url}`);
  return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]), gen: Number(m[4] ?? 0) };
}

export async function openSource(stored: Stored, gen: number, glyphs: string): Promise<MapSource> {
  const pool = new TilePool({ file: stored.img, hgt: stored.hgt, overview: stored.overview }, tileWorkerCount());
  let meta: OpenMeta;
  try {
    meta = await pool.open();
  } catch (err) {
    pool.dispose();
    throw err;
  }
  let typ: Typ;
  try {
    typ = meta.typ ? parseTyp(meta.typ) : emptyTyp();
  } catch (err) {
    console.warn('failed to parse TYP style file, falling back to default styling', err);
    typ = emptyTyp();
  }
  const { style, images } = buildStyle(typ, {
    tiles: tileUrl('garmin', gen),
    glyphs,
    ...(meta.demBounds ? { dem: tileUrl('dem', gen), demBounds: meta.demBounds, demMaxZoom: meta.demMaxZoom ?? undefined } : {}),
  });
  return {
    stored, pool, meta, style, images,
    baseLayers: new Set(style.layers.map((l) => l.id)),
    baseSources: new Set(Object.keys(style.sources)),
  };
}

/** The next map's style with the app's own sources and layers (route, saved places, tracks…) kept
 *  from the one shown, above the map's layers as before. */
export function carryOver(prev: StyleSpecification | undefined, next: StyleSpecification, old: Pick<MapSource, 'baseLayers' | 'baseSources'>): StyleSpecification {
  if (!prev) return next;
  const sources = { ...next.sources };
  for (const [id, s] of Object.entries(prev.sources)) if (!old.baseSources.has(id) && !(id in sources)) sources[id] = s;
  const layers = [...next.layers, ...prev.layers.filter((l) => !old.baseLayers.has(l.id) && !next.layers.some((n) => n.id === l.id))];
  return { ...next, sources, layers };
}
