import { isNumber, pyRound } from '../map/zoom';
import { ascii, ImgError, u16, u24, u32, u8 } from './bytes';
import type { LabelSrc, RawObject } from './rgn';
import type { ByteSource } from './source';

const FEET_TO_M = 0.3048;
const ELEVATION_SEPARATOR = 0x1f;

export function formatLabel(raw: Uint8Array, decoder: TextDecoder): string | null {
  const parts: Array<[number[], number]> = [];
  let buf: number[] = [];
  let prevSep = 0;
  for (const b of raw) {
    if (b >= 0x1b && b <= 0x1f) {
      if (buf.length) {
        parts.push([buf, prevSep]);
        buf = [];
      }
      prevSep = b;
    } else if (b >= 0x07) {
      buf.push(b);
    }
  }
  if (buf.length) parts.push([buf, prevSep]);
  const out: string[] = [];
  for (const [bytes, sep] of parts) {
    let s = decoder.decode(new Uint8Array(bytes)).trim();
    if (sep === ELEVATION_SEPARATOR && isNumber(s)) s = `${pyRound(parseFloat(s) * FEET_TO_M)} m`;
    if (s) out.push(s);
  }
  return out.length ? out.join(' ') : null;
}

function decoderFor(codepage: number): TextDecoder {
  const label = codepage === 65001 ? 'utf-8' : codepage ? `windows-${codepage}` : 'windows-1252';
  try {
    return new TextDecoder(label);
  } catch {
    throw new ImgError(`LBL: codepage ${codepage} not supported`);
  }
}

/** A subfile's bytes, read when needed. */
export type Subfile = ByteSource;

/** A subfile already in memory (tests). */
export const inMemory = (bytes: Uint8Array): Subfile => ({ size: bytes.length, read: async (o, n) => bytes.subarray(o, o + n) });

const BLOCK = 4096;

/** Thrown by `Blocks` for a block not read yet: `readAll` reads it and runs the job again. */
class Need {
  constructor(readonly blocks: Blocks, readonly offset: number) {}
}

/** A subfile read in blocks for one batch of lookups. Reading is synchronous, from the blocks
 *  already read (`Need` for another); the batch keeps the blocks it used, and the recently used
 *  ones are kept for the next batches in `LabelCache`. */
class Blocks {
  private readonly got = new Map<number, Uint8Array>();

  /** `key`: this subfile's blocks' numbers in the shared cache start there. */
  constructor(readonly file: Subfile, private readonly cache: LabelCache, private readonly key: number) {}

  /** Reads the blocks holding these byte offsets. */
  async load(offsets: number[]): Promise<void> {
    const want = new Set(offsets.map((o) => Math.floor(o / BLOCK)).filter((i) => !this.got.has(i)));
    await Promise.all([...want].map(async (i) => {
      const b = await this.file.read(i * BLOCK, BLOCK);
      this.got.set(i, b);
      this.cache.blocks.set(this.key + i, b);
    }));
  }

  private block(i: number): Uint8Array {
    let b = this.got.get(i);
    if (!b) {
      b = this.cache.blocks.get(this.key + i);
      if (!b) throw new Need(this, i * BLOCK);
      this.got.set(i, b);
    }
    return b;
  }

  /** `n` bytes from `start`; a RangeError past the end of the subfile. */
  bytes(start: number, n: number): Uint8Array {
    if (start < 0 || n < 0 || start + n > this.file.size) throw new RangeError(`read past end at offset ${start + n} (length ${this.file.size})`);
    const i = Math.floor(start / BLOCK);
    if (start + n <= (i + 1) * BLOCK) return this.block(i).subarray(start - i * BLOCK, start + n - i * BLOCK);
    const out = new Uint8Array(n);
    for (let at = start; at < start + n;) {
      const j = Math.floor(at / BLOCK);
      const b = this.block(j).subarray(at - j * BLOCK, start + n - j * BLOCK);
      out.set(b, at - start);
      at += b.length;
    }
    return out;
  }

  /** The bytes from `start` to the next zero byte (or the end of the subfile). */
  zeroEnded(start: number): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let i = Math.floor(start / BLOCK), from = start - i * BLOCK; start >= 0 && i * BLOCK < this.file.size; i++, from = 0) {
      const b = this.block(i);
      const end = b.indexOf(0, from);
      parts.push(b.subarray(from, end < 0 ? b.length : end));
      if (end >= 0 || b.length < BLOCK) break;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
    return out;
  }
}

/** Runs every job, reading the blocks they turn out to need (`Need`) between rounds, until all
 *  are done: a batch of lookups takes a few rounds of reads, not a promise per lookup. */
async function readAll(jobs: Array<() => void>): Promise<void> {
  for (let pending = jobs; pending.length;) {
    const next: Array<() => void> = [];
    const needs = new Map<Blocks, number[]>();
    for (const job of pending) {
      try {
        job();
      } catch (err) {
        if (!(err instanceof Need)) throw err;
        next.push(job);
        (needs.get(err.blocks) ?? needs.set(err.blocks, []).get(err.blocks)!).push(err.offset);
      }
    }
    await Promise.all([...needs].map(([blocks, offsets]) => blocks.load(offsets)));
    pending = next;
  }
}

/** `f()`, or `fallback` when it reads past the end of a subfile. */
function orIfPastEnd<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof RangeError) return fallback;
    throw err;
  }
}

/**
 * A map that keeps about the `limit` most recently used entries, in two halves: when the newer one
 * fills, the older one is dropped. (Deleting a Map's oldest entry one at a time leaves holes at its
 * start that every `keys().next()` walks past: lookups slowed to milliseconds on a long route.)
 */
class Lru<V> {
  private map = new Map<number, V>();
  private old = new Map<number, V>();

  constructor(private readonly limit: number) {}

  get(key: number): V | undefined {
    let v = this.map.get(key);
    if (v === undefined) {
      v = this.old.get(key);
      if (v !== undefined) this.set(key, v);
    }
    return v;
  }

  set(key: number, v: V): void {
    this.map.set(key, v);
    if (this.map.size >= this.limit / 2) {
      this.old = this.map;
      this.map = new Map();
    }
  }
}

/**
 * Labels already looked up, and the LBL and NET blocks read lately (1 MB), shared by a map's
 * label tables and bounded: the search index visits every object of a map once, and an unbounded
 * cache kept over half a million names (Freizeitkarte Denmark: 25 MB).
 */
export class LabelCache {
  readonly blocks = new Lru<Uint8Array>(256);
  private readonly texts: Lru<string | null>;

  constructor(limit = 20_000) {
    this.texts = new Lru(limit);
  }

  get(key: number): string | null | undefined {
    return this.texts.get(key);
  }

  set(key: number, v: string | null): void {
    this.texts.set(key, v);
  }
}

const SRC_CODE: Record<LabelSrc, number> = { lbl: 0, poi: 1, net: 2 };

/**
 * A map tile's labels (LBL), and its roads' labels (NET). Neither subfile is held in memory (a big
 * map's are tens of MB, in every tile worker): the labels a batch of objects needs are read when
 * they're decoded (`resolve`).
 */
export class LabelTable {
  private constructor(
    private readonly lbl: Subfile,
    private readonly net: Subfile | null,
    private readonly cache: LabelCache,
    /** Tells this table's entries in the shared cache from other tables'. */
    private readonly id: number,
    private readonly lbl1: number,
    private readonly shift: number,
    private readonly decoder: TextDecoder,
    private readonly poiOff: number,
    private readonly poiShift: number,
    private readonly net1: number,
    private readonly netShift: number,
  ) {}

  /** Reads the subfiles' headers (`id`: this table's number among those sharing `cache`). */
  static async open(lbl: Subfile, net: Subfile | null, cache = new LabelCache(), id = 0): Promise<LabelTable> {
    const h = await lbl.read(0, Math.min(lbl.size, 0x200));
    if (ascii(h, 2, 12) !== 'GARMIN LBL') throw new ImgError('LBL: bad signature');
    const encoding = u8(h, 0x1e);
    if (encoding !== 9) throw new ImgError(`LBL: label encoding ${encoding} not supported (only 8-bit labels, encoding 9)`);
    const nh = net ? await net.read(0, 0x20) : null;
    return new LabelTable(
      lbl, net, cache, id, u32(h, 0x15), u8(h, 0x1d), decoderFor(u16(h, 0) >= 0xac ? u16(h, 0xaa) : 1252), u32(h, 0x57), u8(h, 0x5f),
      nh ? u32(nh, 0x15) : 0, nh ? u8(nh, 0x1d) : 0,
    );
  }

  /** Fills in each object's `text` (unless it has it already) and, with `roadTexts`, a road's
   *  `roadTexts`. */
  async resolve(objs: RawObject[], roadTexts = false): Promise<void> {
    const [lbl, net] = this.blocks();
    const jobs: Array<() => void> = [];
    for (const o of objs) {
      // Most objects have no label or one already looked up: nothing to read.
      const known = o.text !== undefined ? o.text : o.labelSrc === 'lbl' && o.label === 0 ? null : this.cache.get(this.key(o.label, o.labelSrc));
      if (known !== undefined) o.text = known;
      else jobs.push(() => void (o.text = this.lookup(o.label, o.labelSrc, lbl, net)));
      if (roadTexts && o.labelSrc === 'net') jobs.push(() => void (o.roadTexts = this.roads(o.label, lbl, net)));
    }
    await readAll(jobs);
  }

  /** One label (tests). */
  async text(label: number, src: LabelSrc): Promise<string | null> {
    const [lbl, net] = this.blocks();
    let out: string | null = null;
    await readAll([() => void (out = this.lookup(label, src, lbl, net))]);
    return out;
  }

  /** Every label of a road (NET): its name and, on some maps, its number as a second label, e.g.
   *  "Fjallabaksleið nyrðri" and "F208" (Freizeitkarte). Up to four; the last has bit 23 set. */
  async roadTexts(label: number): Promise<string[]> {
    const [lbl, nb] = this.blocks();
    let out: string[] = [];
    await readAll([() => void (out = this.roads(label, lbl, nb))]);
    return out;
  }

  /** The LBL and NET subfiles, for one batch of lookups. */
  private blocks(): [Blocks, Blocks | null] {
    const key = (file: number) => (this.id * 2 + file) * 2 ** 21;
    return [new Blocks(this.lbl, this.cache, key(0)), this.net && new Blocks(this.net, this.cache, key(1))];
  }

  private key(label: number, src: LabelSrc): number {
    return (this.id * 3 + SRC_CODE[src]) * 0x400000 + label;
  }

  private lookup(label: number, src: LabelSrc, lbl: Blocks, net: Blocks | null): string | null {
    if (src === 'lbl' && label === 0) return null;
    const key = this.key(label, src);
    let v = this.cache.get(key);
    if (v === undefined) {
      v = orIfPastEnd(() => {
        const off = this.offset(label, src, lbl, net);
        return off ? this.string(off, lbl) : null;
      }, null);
      this.cache.set(key, v);
    }
    return v;
  }

  private roads(label: number, lbl: Blocks, net: Blocks | null): string[] {
    const out: string[] = [];
    if (!net) return out;
    orIfPastEnd(() => {
      for (let i = 0, at = this.net1 + label * 2 ** this.netShift; i < 4; i++, at += 3) {
        const v = u24(net.bytes(at, 3), 0);
        const off = v & 0x3fffff;
        if (!(v & 0x400000) && off) {
          const t = this.string(off, lbl);
          if (t) out.push(t);
        }
        if (v & 0x800000) break;
      }
    }, undefined);
    return out;
  }

  private string(off: number, lbl: Blocks): string | null {
    return formatLabel(lbl.zeroEnded(this.lbl1 + off * 2 ** this.shift), this.decoder);
  }

  private offset(label: number, src: LabelSrc, lbl: Blocks, net: Blocks | null): number | null {
    if (src === 'poi') return u24(lbl.bytes(this.poiOff + label * 2 ** this.poiShift, 3), 0) & 0x3fffff;
    if (src === 'net') {
      if (!net) return null;
      const v = u24(net.bytes(this.net1 + label * 2 ** this.netShift, 3), 0);
      return v & 0x400000 ? null : v & 0x3fffff;
    }
    return label;
  }
}
