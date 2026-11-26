import { ImgError, u16 } from '../img/bytes';
import { ImgContainer } from '../img/container';
import { LabelCache, LabelTable, type Subfile } from '../img/lbl';
import { DECODE_ALL, decodeSubdivision, EXT_KINDS, mainKinds, type Chunk, type DecodeStats, type RawObject, type SubdivisionBytes } from '../img/rgn';
import type { ByteSource } from '../img/source';
import { extRanges, hasData, parseTre, type Subdivision, type Tre } from '../img/tre';
import { conventionsFor, type MapConventions } from './conventions';
import { CONTOUR_LINE_TYPES, contourLabel, EARLY_ROADS_ZOOM, ROADS_LEVEL_ZOOM, zoomBands } from './zoom';

export interface MapTile {
  id: string;
  tre: Tre;
  labels: LabelTable;
  byLevel: Map<number, Subdivision[]>;
  /** How the map writes its labels (./conventions). */
  conventions: MapConventions;
}

function named(name: string, err: unknown): Error {
  if (err instanceof ImgError) return new ImgError(`${name}: ${err.message}`);
  if (err instanceof RangeError) return new ImgError(`${name}: truncated or corrupt (${err.message})`);
  return err as Error;
}

export function objectName(tile: MapTile, obj: RawObject): string | null {
  return objectLabel(tile, obj).name;
}

/** An object's name, and for a point on a map that labels them so, what it is ("Waterfall"). */
export function objectLabel(tile: MapTile, obj: RawObject): { name: string | null; what?: string } {
  const name = obj.text ?? null;
  if (!name) return { name };
  if (obj.kind === 'line' && CONTOUR_LINE_TYPES.has(obj.type)) return { name: contourLabel(name) };
  return obj.kind === 'point' ? tile.conventions.pointLabel(name) : { name };
}

export class GarminMap {
  private constructor(
    private readonly img: ImgContainer,
    readonly tiles: MapTile[],
    readonly bands: Map<number, [number, number]>,
    readonly bounds: [number, number, number, number],
    readonly typ: Uint8Array | null,
    /** The map's name from the IMG header. */
    readonly description: string,
  ) {}

  static async open(src: ByteSource): Promise<GarminMap> {
    const img = await ImgContainer.open(src);
    const ids = img.tileIds();
    if (ids.length === 0) throw new ImgError('no map tiles (TRE subfiles) in IMG');
    const tiles: MapTile[] = [];
    const conventions = conventionsFor(img.description);
    const labelCache = new LabelCache();
    const subfile = (name: string): Subfile => ({ size: img.size(name), read: (o, n) => img.read(name, o, n) });
    for (const id of ids) {
      for (const ext of ['TRE', 'RGN', 'LBL']) if (!img.has(`${id}.${ext}`)) throw new ImgError(`${id}: missing ${ext} subfile`);
      let tre: Tre;
      try {
        const rgnName = `${id}.RGN`;
        const hlen = u16(await img.read(rgnName, 0, 2), 0);
        tre = parseTre(await img.read(`${id}.TRE`), await img.read(rgnName, 0, hlen));
      } catch (err) {
        throw named(`${id}.TRE`, err);
      }
      let labels: LabelTable;
      try {
        labels = await LabelTable.open(subfile(`${id}.LBL`), img.has(`${id}.NET`) ? subfile(`${id}.NET`) : null, labelCache, tiles.length);
      } catch (err) {
        throw named(`${id}.LBL`, err);
      }
      const byLevel = new Map<number, Subdivision[]>();
      for (const sd of tre.subdivisions) {
        if (!hasData(sd)) continue;
        const list = byLevel.get(sd.level.bits) ?? [];
        list.push(sd);
        byLevel.set(sd.level.bits, list);
      }
      tiles.push({ id, tre, labels, byLevel, conventions });
    }
    const bands = zoomBands(tiles.flatMap((t) => [...t.byLevel.keys()]));
    const bounds: [number, number, number, number] = [
      Math.min(...tiles.map((t) => t.tre.west)), Math.min(...tiles.map((t) => t.tre.south)),
      Math.max(...tiles.map((t) => t.tre.east)), Math.max(...tiles.map((t) => t.tre.north)),
    ];
    const typName = img.firstOfType('TYP');
    return new GarminMap(img, tiles, bands, bounds, typName ? await img.read(typName) : null, img.description);
  }

  levelForZoom(z: number): number | undefined {
    for (const [bits, [a, b]] of this.bands) if (z >= a && z <= b) return bits;
    return undefined;
  }

  /** The level whose roads a tile at zoom z shows, when it differs from `levelForZoom(z)`:
   *  ROADS_LEVEL_ZOOM's level, for zooms from EARLY_ROADS_ZOOM up to it. */
  roadLevelForZoom(z: number): number | undefined {
    if (z < EARLY_ROADS_ZOOM || z >= ROADS_LEVEL_ZOOM) return undefined;
    const roads = this.levelForZoom(ROADS_LEVEL_ZOOM);
    return roads !== this.levelForZoom(z) ? roads : undefined;
  }

  /** The RGN bytes of a subdivision; with `kinds` (`DECODE_*` bits), only those `decodeSubdivision`
   *  needs for objects of those kinds. */
  async readSubdivision(tile: MapTile, sd: Subdivision, kinds = DECODE_ALL): Promise<SubdivisionBytes> {
    const rgn = `${tile.id}.RGN`;
    const chunk = async (a: number, e: number, wanted: boolean): Promise<Chunk> =>
      ({ bytes: wanted && e > a ? await this.img.read(rgn, a, e - a) : new Uint8Array(0), base: a });
    const [main, pg, ln, pt] = await Promise.all([
      chunk(sd.rgnStart, sd.rgnEnd, (mainKinds(sd) & kinds) !== 0),
      ...extRanges(sd).map(([a, e], i) => chunk(a, e, (kinds & EXT_KINDS[i]) !== 0)),
    ]);
    return { main, ext: [pg, ln, pt] };
  }

  /**
   * A subdivision's objects with their labels' texts: of the kinds in `opts.kinds` (`DECODE_*`
   * bits; all by default), with `opts.roadTexts` each road's `roadTexts` too, its sections counted
   * in `opts.stats`. With `opts.labels` false, no texts (`withLabels` adds them later).
   */
  async decode(
    tile: MapTile, sd: Subdivision, opts: { stats?: DecodeStats; kinds?: number; roadTexts?: boolean; labels?: boolean } = {},
  ): Promise<RawObject[]> {
    const kinds = opts.kinds ?? DECODE_ALL;
    const objs = decodeSubdivision(await this.readSubdivision(tile, sd, kinds), sd, opts.stats ?? { sections: 0, badSections: 0 }, kinds);
    return opts.labels === false ? objs : this.withLabels(tile, objs, opts.roadTexts);
  }

  /** The objects, with the texts of their labels filled in where they weren't yet. */
  async withLabels(tile: MapTile, objs: RawObject[], roadTexts = false): Promise<RawObject[]> {
    try {
      await tile.labels.resolve(objs, roadTexts);
    } catch (err) {
      throw named(`${tile.id}.LBL`, err);
    }
    return objs;
  }

  /** A whole subfile (e.g. `14057406.NOD`), or null when the map doesn't have it. */
  async readSubfile(name: string): Promise<Uint8Array | null> {
    return this.img.has(name) ? this.img.read(name) : null;
  }
}
