import type { Kind } from '../img/rgn';
import type { RoadClasses } from '../routing/roadClass';
import { titleCase, type Town } from './describe';
import { type NamedPoints, namedPointsOf } from './nearIndex';
import { normalize } from './normalize';
import { decodeRoadClasses } from './placesCache';
import type { Place } from './places';

/** Kind codes in the columns (the same as places.json's). */
export const KINDS: Kind[] = ['point', 'line', 'polygon'];
/** Static search order by kind: points, then areas, then lines. */
const KIND_RANK = [0, 2, 1];
const NEARBY_KM = 25;
/** NEARBY_KM as a squared equirectangular distance in degrees (see `nearness` in describe.ts). */
const NEARBY_DEG2 = (NEARBY_KM / 111.2) ** 2;

/**
 * A map's places as columns, in the map's order (index i is place i), plus what search needs
 * precomputed: `order` lists the places in static search order (kind, normalized-name length,
 * name), and `norm` is their normalized names in that order, joined by "\n" (UTF-8). Coordinates
 * are whole 1e-5 degrees (the places are rounded to that when collected).
 */
export interface PlaceColumns {
  lon: Int32Array;
  lat: Int32Array;
  type: Int32Array;
  kind: Uint8Array;
  /** 0 for none, else 1 + an index into `whats`. */
  what: Uint32Array;
  /** Place i's name is names[nameOff[i], nameOff[i + 1]) (UTF-8). */
  nameOff: Uint32Array;
  names: Uint8Array;
  order: Uint32Array;
  norm: Uint8Array;
  whats: string[];
  roads: RoadClasses;
}

const isTown = (kind: number, type: number) => kind === 0 && type >> 8 >= 0x01 && type >> 8 <= 0x0d;

/** Normalizes and sorts the places once (the expensive part, done when the cache is written). */
export function columnsFromPlaces(places: Place[], roads: RoadClasses): PlaceColumns {
  const n = places.length;
  const lon = new Int32Array(n);
  const lat = new Int32Array(n);
  const type = new Int32Array(n);
  const kind = new Uint8Array(n);
  const what = new Uint32Array(n);
  const nameOff = new Uint32Array(n + 1);
  const whats: string[] = [];
  const whatIds = new Map<string, number>();
  let chars = 0;
  for (const p of places) chars += p.name.length;
  let names = new Uint8Array(chars * 3);
  const enc = new TextEncoder();
  let off = 0;
  const norms: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = places[i];
    lon[i] = Math.round(p.lon * 1e5);
    lat[i] = Math.round(p.lat * 1e5);
    type[i] = p.type;
    kind[i] = KINDS.indexOf(p.kind);
    if (p.what) {
      let id = whatIds.get(p.what);
      if (id === undefined) {
        id = whats.push(p.what);
        whatIds.set(p.what, id);
      }
      what[i] = id;
    }
    off += enc.encodeInto(p.name, names.subarray(off)).written;
    nameOff[i + 1] = off;
    norms[i] = normalize(p.name);
  }
  names = names.slice(0, off);
  // The order PlaceIndex used to sort its entries in, ties kept in the map's order (a stable sort).
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => KIND_RANK[kind[a]] - KIND_RANK[kind[b]] || norms[a].length - norms[b].length || places[a].name.localeCompare(places[b].name));
  const order = Uint32Array.from(idx);
  const norm = enc.encode(idx.map((i) => norms[i]).join('\n'));
  return { lon, lat, type, kind, what, nameOff, names, order, norm, whats, roads };
}

// The cache file: a header, then sections (each a byte length and the bytes, padded to 4).
const MAGIC = 0x434c5056; // "VPLC"
const VERSION = 1;

/** The on-disk form of `cols` for the map file `key`. Typed arrays in the machine's byte order
 *  (little-endian on every device the app runs on; a mismatch would only fail the checks). */
export function encodeColumns(key: string, cols: PlaceColumns): Uint8Array {
  const enc = new TextEncoder();
  const n = cols.lon.length;
  const sections: Uint8Array[] = [
    enc.encode(key),
    ...[cols.lon, cols.lat, cols.type, cols.kind, cols.what, cols.nameOff, cols.names, cols.order, cols.norm]
      .map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)),
    enc.encode(JSON.stringify({ whats: cols.whats, roads: cols.roads })),
  ];
  const pad = (len: number) => (len + 3) & ~3;
  const size = 16 + sections.reduce((s, b) => s + 4 + pad(b.byteLength), 0);
  const out = new Uint8Array(size);
  const head = new Uint32Array(out.buffer, 0, 4);
  head.set([MAGIC, VERSION, size, n]);
  let at = 16;
  for (const b of sections) {
    new Uint32Array(out.buffer, at, 1)[0] = b.byteLength;
    out.set(b, at + 4);
    at += 4 + pad(b.byteLength);
  }
  return out;
}

/** The columns in `buf` (views on it), or null for another map's file, another version, or a
 *  file that is cut short or doesn't add up. */
export function decodeColumns(buf: ArrayBuffer, key: string): PlaceColumns | null {
  try {
    if (buf.byteLength < 16) return null;
    const [magic, version, size, n] = new Uint32Array(buf, 0, 4);
    if (magic !== MAGIC || version !== VERSION || size !== buf.byteLength) return null;
    let at = 16;
    const next = (): [number, number] => {
      if (at + 4 > size) throw new Error('short');
      const len = new Uint32Array(buf, at, 1)[0];
      const start = at + 4;
      at = start + ((len + 3) & ~3);
      if (at > size) throw new Error('short');
      return [start, len];
    };
    const dec = new TextDecoder();
    const [ks, kl] = next();
    if (dec.decode(new Uint8Array(buf, ks, kl)) !== key) return null;
    const i32 = () => {
      const [s, l] = next();
      if (l !== n * 4) throw new Error('size');
      return new Int32Array(buf, s, n);
    };
    const u32 = (count: number) => {
      const [s, l] = next();
      if (l !== count * 4) throw new Error('size');
      return new Uint32Array(buf, s, count);
    };
    const bytes = (count?: number) => {
      const [s, l] = next();
      if (count !== undefined && l !== count) throw new Error('size');
      return new Uint8Array(buf, s, l);
    };
    const lon = i32();
    const lat = i32();
    const type = i32();
    const kind = bytes(n);
    const what = u32(n);
    const nameOff = u32(n + 1);
    const names = bytes();
    const order = u32(n);
    const norm = bytes();
    const [ms, ml] = next();
    const meta = JSON.parse(dec.decode(new Uint8Array(buf, ms, ml))) as { whats?: unknown; roads?: unknown };
    const roads = decodeRoadClasses(meta.roads);
    const whats = meta.whats;
    if (!roads || !Array.isArray(whats) || !whats.every((w) => typeof w === 'string')) return null;
    if (nameOff[n] !== names.byteLength) return null;
    return { lon, lat, type, kind, what, nameOff, names, order, norm, whats: whats as string[], roads };
  } catch {
    return null;
  }
}

/** A bucket of hits in a search with a reference point: the `k` nearest of those within
 *  NEARBY_KM (nearest first, ties in static order) and the first `k` of the rest in static order. */
class NearBucket {
  readonly near: number[] = [];
  private readonly dist: number[] = [];
  readonly far: number[] = [];
  constructor(private readonly k: number) {}

  add(rank: number, d: number): void {
    if (d >= NEARBY_DEG2) {
      if (this.far.length < this.k) this.far.push(rank);
      return;
    }
    const { dist, k } = this;
    if (dist.length === k && d >= dist[k - 1]) return;
    // After every hit as near (ranks come in increasing order: a stable sort's order).
    let lo = 0;
    let hi = dist.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] <= d) lo = mid + 1;
      else hi = mid;
    }
    dist.splice(lo, 0, d);
    this.near.splice(lo, 0, rank);
    if (dist.length > k) {
      dist.pop();
      this.near.pop();
    }
  }
}

/**
 * Search over a map's places, held as columns (a few typed arrays and one string of normalized
 * names) rather than as an object per place. A search finds the query in the names' string with
 * `indexOf`, so only the places whose names contain it are looked at.
 */
export class PlaceStore {
  readonly size: number;
  /** The normalized names in static order, joined by "\n". */
  private readonly norms: string;
  /** Where each rank's name starts in `norms`; starts[size] is past the end (+1). */
  private readonly starts: Uint32Array;
  private readonly dec = new TextDecoder();

  constructor(readonly cols: PlaceColumns) {
    const n = (this.size = cols.lon.length);
    this.norms = this.dec.decode(cols.norm);
    const starts = (this.starts = new Uint32Array(n + 1));
    for (let r = 1; r < n; r++) starts[r] = this.norms.indexOf('\n', starts[r - 1]) + 1;
    starts[n] = this.norms.length + 1;
  }

  name(i: number): string {
    return this.dec.decode(this.cols.names.subarray(this.cols.nameOff[i], this.cols.nameOff[i + 1]));
  }

  /** Place i (in the map's order). */
  place(i: number): Place {
    const { lon, lat, kind, type, what, whats } = this.cols;
    const p: Place = { name: this.name(i), lon: lon[i] / 1e5, lat: lat[i] / 1e5, kind: KINDS[kind[i]], type: type[i] };
    if (what[i]) p.what = whats[what[i] - 1];
    return p;
  }

  /** The map's towns (Garmin city points), in the map's order. */
  towns(): Town[] {
    const { lon, lat, kind, type } = this.cols;
    const out: Town[] = [];
    for (let i = 0; i < this.size; i++) if (isTown(kind[i], type[i])) out.push({ name: titleCase(this.name(i)), lon: lon[i] / 1e5, lat: lat[i] / 1e5 });
    return out;
  }

  /** The named points, for naming a spot after the nearest one (see NearIndex). */
  namedPoints(): NamedPoints {
    return namedPointsOf(this.cols, (i) => this.name(i));
  }

  /** The rank whose name holds position `pos` of `norms`, searching from rank `from` on. */
  private rankAt(pos: number, from: number): number {
    const { starts } = this;
    let lo = from;
    let hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Places whose names match `query`: name prefixes, then word prefixes, then substrings (3+
   * characters); within each, in static order (kind, name length, name). With `near`: exact name
   * matches first (towns before the rest), and within each group the hits within NEARBY_KM of
   * `near` first, nearest first, then the rest in static order. Only `limit` hits per group are
   * kept while scanning, so a one-letter query costs no more memory than a long one.
   */
  search(query: string, limit = 20, near?: [number, number]): Place[] {
    const q = normalize(query);
    if (!q || limit <= 0) return [];
    const { norms, starts } = this;
    const { order, lon, lat, kind, type } = this.cols;
    const substrings = q.length >= 3;
    const cos = near ? Math.cos((near[1] * Math.PI) / 180) : 0;
    const buckets = near ? [0, 1, 2, 3, 4].map(() => new NearBucket(limit)) : null;
    const plain: number[][] = [[], [], []];
    let r = 0;
    for (let pos = norms.indexOf(q); pos !== -1; ) {
      r = this.rankAt(pos, r);
      const start = starts[r];
      const end = starts[r + 1] - 1; // the "\n" after the name (or the end)
      let score = -1;
      if (pos === start) score = 0;
      else {
        if (substrings) score = 2;
        // A word prefix: the query (one word or several) from a word's start.
        for (let p = pos; p !== -1 && p < end; p = norms.indexOf(q, p + 1)) {
          if (norms.charCodeAt(p - 1) === 32) {
            score = 1;
            break;
          }
        }
      }
      pos = norms.indexOf(q, end + 1);
      if (score < 0) continue;
      if (buckets && near) {
        const i = order[r];
        const exact = score === 0 && end - start === q.length;
        const dx = (lon[i] / 1e5 - near[0]) * cos;
        const dy = lat[i] / 1e5 - near[1];
        buckets[exact ? (isTown(kind[i], type[i]) ? 0 : 1) : score + 2].add(r, dx * dx + dy * dy);
      } else {
        const b = plain[score];
        if (b.length < limit) b.push(r);
        if (score === 0 && b.length >= limit) break; // nothing can outrank a full set of prefix hits
      }
    }
    const ranks = buckets ? buckets.flatMap((b) => [...b.near, ...b.far]) : plain.flat();
    return ranks.slice(0, limit).map((rank) => this.place(order[rank]));
  }
}
