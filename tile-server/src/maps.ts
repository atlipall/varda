import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { Dem } from '../../web/src/dem/dem';
import { decodeHgt, HGT_BYTES, parseHgtName } from '../../web/src/dem/hgt';
import { OverviewBuilder } from '../../web/src/dem/overview';
import type { ByteSource } from '../../web/src/img/source';
import { emptyTyp, parseTyp, type Typ } from '../../web/src/img/typ';
import { conventionsFor } from '../../web/src/map/conventions';
import { GarminMap } from '../../web/src/map/garminMap';
import { normalize } from '../../web/src/search/normalize';
import { buildStyle } from '../../web/src/style/buildStyle';
import { buildTile, SubdivisionCache } from '../../web/src/tiles/buildTile';
import { buildSprite } from './sprite';

type Bounds = [number, number, number, number];

/** A file read in pieces, as the map reader wants. */
export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(offset: number, length: number) {
      const buf = new Uint8Array(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    },
    close: () => fh.close(),
  };
}

interface FoundFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Changes when any of the files does, so browsers and proxies don't keep old tiles. */
const versionOf = (files: FoundFile[]) =>
  `${files.reduce((n, f) => n + f.size, 0).toString(36)}-${Math.round(Math.max(...files.map((f) => f.mtimeMs))).toString(36)}-${files.length}`;

/** Terrain from the .hgt files of one folder, shared by its maps. */
class Terrain {
  /** Sorted by name in code-point order, as the app applies them on import: shared tile edges are
   *  "last write wins", so the order decides which file's edge is used. */
  private readonly files: Array<{ path: string; name: string; south: number; west: number }>;
  private readonly area: Bounds;
  readonly version: string;
  private dem: Promise<Dem> | null = null;
  private failed = false;

  constructor(found: FoundFile[]) {
    this.files = found
      .map(({ path }) => ({ path, name: basename(path).toLowerCase(), ...parseHgtName(basename(path))! }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const souths = this.files.map((f) => f.south);
    const wests = this.files.map((f) => f.west);
    this.area = [Math.min(...wests), Math.min(...souths), Math.max(...wests) + 1, Math.max(...souths) + 1];
    this.version = versionOf(found);
  }

  /** Where the terrain is (known from the file names alone), or null once it turned out unreadable,
   *  so the maps stop offering hillshading instead of failing on every terrain tile. */
  get bounds(): Bounds | null {
    return this.failed ? null : this.area;
  }

  get count(): number {
    return this.files.length;
  }

  /** Built once (the server starts it in the background). A failure is kept, not retried: reading
   *  every .hgt again on each request wouldn't fix a bad file. */
  get(): Promise<Dem> {
    if (!this.dem) {
      this.dem = (async () => {
        // Zoomed out, terrain comes from a coarse copy of the whole area (as the app builds on import).
        const builder = new OverviewBuilder(this.files);
        for (const f of this.files) builder.add(f.south, f.west, decodeHgt(new Uint8Array(await readFile(f.path))));
        const sources: Array<{ name: string; src: Awaited<ReturnType<typeof fileSource>> }> = [];
        try {
          for (const f of this.files) sources.push({ name: f.name, src: await fileSource(f.path) });
          return Dem.fromFiles(sources, builder.finish());
        } catch (err) {
          await Promise.all(sources.map((s) => s.src.close()));
          throw err;
        }
      })();
      this.dem.catch((err) => {
        this.failed = true;
        console.error(`Terrain from ${this.files.length} .hgt files could not be read; no hillshading:`, err);
      });
    }
    return this.dem;
  }
}

export class ServedMap {
  private readonly cache = new SubdivisionCache(750_000);
  private typ: Typ | null = null;
  private spriteSheet: ReturnType<typeof buildSprite> | null = null;

  private constructor(
    readonly id: string,
    readonly file: string,
    readonly map: GarminMap,
    private readonly terrain: Terrain | null,
    /** Changes when the file does, so browsers and proxies don't keep old tiles. */
    readonly version: string,
  ) {}

  static async open(file: FoundFile, id: string, terrain: Terrain | null): Promise<ServedMap> {
    const src = await fileSource(file.path);
    try {
      return new ServedMap(id, file.path, await GarminMap.open(src), terrain, versionOf([file]));
    } catch (err) {
      await src.close();
      throw err;
    }
  }

  get name(): string {
    return this.map.description.trim() || basename(this.file).replace(/\.img$/i, '');
  }

  get credit(): string | null {
    return conventionsFor(this.map.description).credit;
  }

  /** The map's own style file (TYP), or a plain default when it has none or it can't be read. */
  get style(): Typ {
    if (!this.typ) {
      try {
        this.typ = this.map.typ ? parseTyp(this.map.typ) : emptyTyp();
      } catch (err) {
        console.warn(`${this.id}: could not read the TYP style, using the default`, err);
        this.typ = emptyTyp();
      }
    }
    return this.typ;
  }

  /** The style's icons and patterns, as one sheet. */
  get sprite(): ReturnType<typeof buildSprite> {
    if (!this.spriteSheet) this.spriteSheet = buildSprite(buildStyle(this.style, { tiles: '', glyphs: '' }).images);
    return this.spriteSheet;
  }

  async tile(z: number, x: number, y: number): Promise<Uint8Array> {
    return (await buildTile(this.map, this.cache, z, x, y)).data;
  }

  /** Where the terrain is [west, south, east, north], or null without (readable) terrain. */
  get terrainBounds(): Bounds | null {
    return this.terrain?.bounds ?? null;
  }

  /** Changes when the .hgt files do (the map's own version follows its .img). */
  get terrainVersion(): string {
    return this.terrain?.version ?? '';
  }

  async terrainTile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
    if (!this.terrain) throw new Error('no terrain');
    return (await this.terrain.get()).tile(z, x, y);
  }

  /** Starts reading the terrain, so the first terrain tile doesn't wait for it. */
  warmUp(): void {
    this.terrain?.get().catch(() => {});
  }
}

/** A URL-friendly name: "Iceland GPSmap.is 2024.21 Detailed.img" → "iceland-gpsmap-is-2024-21-detailed". */
export function slug(fileName: string): string {
  return normalize(fileName.replace(/\.img$/i, '')).replace(/ /g, '-') || 'map';
}

/** A folder's entries, sorted, with symbolic links followed (a maps folder often links to packages). */
async function entries(dir: string): Promise<Array<FoundFile & { name: string; dir: boolean; file: boolean }>> {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const path = join(dir, e.name);
    const st = await stat(path).catch(() => null);
    if (st) out.push({ name: e.name, path, dir: st.isDirectory(), file: st.isFile(), size: st.size, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every map in a folder. Each .img file is a map, named after its file. An .img right in the folder
 * has no terrain; the .img files inside a subfolder share the .hgt files anywhere in that subfolder
 * (as a GPSmap.is package keeps its maps and elevation files side by side). A folder or file reached
 * twice through links is used once.
 */
export async function findMaps(root: string, log: (msg: string) => void = console.log): Promise<Map<string, ServedMap>> {
  const maps = new Map<string, ServedMap>();
  const seen = new Set<string>();
  /** True the first time a file or folder (by its real path) comes up. */
  const first = async (path: string) => {
    const real = await realpath(path);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  };
  const walk = async (dir: string): Promise<FoundFile[]> => {
    const out: FoundFile[] = [];
    for (const e of await entries(dir)) {
      if (!(await first(e.path))) continue;
      if (e.dir) out.push(...(await walk(e.path)));
      else if (e.file) out.push(e);
    }
    return out;
  };
  const add = async (file: FoundFile, terrain: Terrain | null) => {
    const base = slug(basename(file.path));
    let id = base;
    for (let n = 2; maps.has(id); n++) id = `${base}-${n}`;
    try {
      maps.set(id, await ServedMap.open(file, id, terrain));
      log(`  ${id}  (${relative(root, file.path)}${terrain ? `, terrain from ${terrain.count} .hgt files` : ''})`);
    } catch (err) {
      log(`  skipped ${relative(root, file.path)}: ${err instanceof Error ? err.message : err}`);
    }
  };
  for (const e of await entries(root)) {
    if (!(await first(e.path))) continue;
    if (e.file && /\.img$/i.test(e.name)) await add(e, null);
    if (!e.dir) continue;
    const files = (await walk(e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
    const hgt: FoundFile[] = [];
    for (const f of files.filter((f) => /\.hgt$/i.test(f.path))) {
      if (!parseHgtName(basename(f.path))) log(`  skipped ${relative(root, f.path)}: not named like n64w019.hgt`);
      else if (f.size !== HGT_BYTES) log(`  skipped ${relative(root, f.path)}: not a 1201×1201 SRTM3 file`);
      else hgt.push(f);
    }
    const terrain = hgt.length ? new Terrain(hgt) : null;
    for (const f of files.filter((f) => /\.img$/i.test(f.path))) await add(f, terrain);
  }
  return maps;
}
