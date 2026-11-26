import { decodeDeltas } from './bitstream';
import { s16, u16, u24, u8 } from './bytes';
import { extRanges, KIND_IDX_POINTS, KIND_LINES, KIND_POINTS, KIND_POLYGONS, shiftOf, type Subdivision } from './tre';

export interface Chunk {
  bytes: Uint8Array;
  base: number;
}

export interface SubdivisionBytes {
  main: Chunk;
  ext: [Chunk, Chunk, Chunk];
}

export type Kind = 'point' | 'line' | 'polygon';
export type LabelSrc = 'lbl' | 'poi' | 'net';

export interface RawObject {
  kind: Kind;
  type: number;
  label: number;
  labelSrc: LabelSrc;
  /** The points in map units, x and y in turn. One buffer holds the points of every object of a
   *  subdivision (each object's `xy` is a view into it): arrays of [x, y] pairs took over 130
   *  bytes a point, these take 8. */
  xy: Int32Array;
  /** The label's text (null without one), once looked up (`LabelTable.resolve`; `GarminMap.decode`
   *  does that unless asked not to). */
  text: string | null | undefined;
  /** All of a road's labels (`LabelTable.roadTexts`), filled in for `decodeAll`'s visitors. */
  roadTexts?: string[];
}

/** An object's points as [x, y] pairs, for code that works on those (a new array each call). */
export function pairs(xy: Int32Array): Array<[number, number]> {
  const out = new Array<[number, number]>(xy.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = [xy[2 * i], xy[2 * i + 1]];
  return out;
}

/** Pairs packed the other way round, into one array of x and y in turn. */
export function packed(points: ReadonlyArray<readonly [number, number]>): Int32Array {
  const out = new Int32Array(points.length * 2);
  points.forEach(([x, y], i) => {
    out[2 * i] = x;
    out[2 * i + 1] = y;
  });
  return out;
}

/** Which kinds of object `decodeSubdivision` decodes (the others' sections are skipped unread). */
export const DECODE_POINTS = 1;
export const DECODE_LINES = 2;
export const DECODE_POLYGONS = 4;
export const DECODE_ALL = DECODE_POINTS | DECODE_LINES | DECODE_POLYGONS;

const NO_POINTS = new Int32Array(0);

/** The points of one subdivision's objects as they're decoded, in one growing buffer. */
class PointBuffer {
  buf = new Int32Array(1024);
  length = 0;

  push(x: number, y: number): void {
    if (this.length + 2 > this.buf.length) {
      const bigger = new Int32Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.length++] = x;
    this.buf[this.length++] = y;
  }
}

export interface DecodeStats {
  sections: number;
  badSections: number;
}

const b8 = (c: Chunk, o: number) => u8(c.bytes, o - c.base);
const b16 = (c: Chunk, o: number) => u16(c.bytes, o - c.base);
const bs16 = (c: Chunk, o: number) => s16(c.bytes, o - c.base);
const b24 = (c: Chunk, o: number) => u24(c.bytes, o - c.base);

function bitstream(c: Chunk, p: number, n: number): Uint8Array {
  const start = p - c.base;
  if (n < 0 || start < 0 || start + n > c.bytes.length) throw new RangeError('bitstream runs past the end of RGN');
  return c.bytes.subarray(start, start + n);
}

function walk(pts: PointBuffer, sd: Subdivision, dx: number, dy: number, deltas: Array<[number, number]>): void {
  const k = 2 ** shiftOf(sd);
  let x = sd.cx + dx * k;
  let y = sd.cy + dy * k;
  pts.push(x, y);
  for (const [ddx, ddy] of deltas) {
    if (ddx === 0 && ddy === 0) continue;
    x += ddx * k;
    y += ddy * k;
    pts.push(x, y);
  }
}

/** An object's size in bytes and the object, its points pushed to the buffer (`xy` set later). */
type Decoded = [number, RawObject];

function point(pts: PointBuffer, c: Chunk, o: number, sd: Subdivision): Decoded {
  const k = 2 ** shiftOf(sd);
  const lb = b24(c, o + 1);
  const x = sd.cx + bs16(c, o + 4) * k;
  const y = sd.cy + bs16(c, o + 6) * k;
  let size = 8;
  let sub = 0;
  if (lb & 0x800000) {
    sub = b8(c, o + 8);
    size = 9;
  }
  pts.push(x, y);
  return [size, { kind: 'point', type: (b8(c, o) << 8) | sub, label: lb & 0x3fffff, labelSrc: lb & 0x400000 ? 'poi' : 'lbl', xy: NO_POINTS, text: undefined }];
}

function poly(pts: PointBuffer, c: Chunk, o: number, sd: Subdivision, line: boolean): Decoded {
  const t = b8(c, o);
  const type = line ? t & 0x3f : t & 0x7f;
  const lb = b24(c, o + 1);
  const dx = bs16(c, o + 4);
  const dy = bs16(c, o + 6);
  let n: number;
  let p: number;
  if (t & 0x80) {
    n = b16(c, o + 8);
    p = o + 10;
  } else {
    n = b8(c, o + 8);
    p = o + 9;
  }
  const info = b8(c, p);
  p += 1;
  const deltas = decodeDeltas(bitstream(c, p, n), info, false, (lb & 0x400000) !== 0);
  walk(pts, sd, dx, dy, deltas);
  return [p + n - o, { kind: line ? 'line' : 'polygon', type, label: lb & 0x3fffff, labelSrc: lb & 0x800000 ? 'net' : 'lbl', xy: NO_POINTS, text: undefined }];
}

function poly2(pts: PointBuffer, c: Chunk, o: number, sd: Subdivision, line: boolean): Decoded {
  const t = b8(c, o);
  const st = b8(c, o + 1);
  const dx = bs16(c, o + 2);
  const dy = bs16(c, o + 4);
  let p = o + 6;
  let n: number;
  if ((b8(c, p) & 1) === 0) {
    n = (b16(c, p) >> 2) - 1;
    p += 2;
  } else {
    n = (b8(c, p) >> 1) - 1;
    p += 1;
  }
  const info = b8(c, p);
  p += 1;
  const deltas = decodeDeltas(bitstream(c, p, n), info, true, false);
  p += n;
  let label = 0;
  if (st & 0x20) {
    label = b24(c, p) & 0x3fffff;
    p += 3;
  }
  const type = 0x10000 | (t << 8) | (st & 0x1f);
  walk(pts, sd, dx, dy, deltas);
  return [p - o, { kind: line ? 'line' : 'polygon', type, label, labelSrc: 'lbl', xy: NO_POINTS, text: undefined }];
}

function point2(pts: PointBuffer, c: Chunk, o: number, sd: Subdivision): Decoded {
  const k = 2 ** shiftOf(sd);
  const t = b8(c, o);
  const st = b8(c, o + 1);
  const x = sd.cx + bs16(c, o + 2) * k;
  const y = sd.cy + bs16(c, o + 4) * k;
  let size = 6;
  let label = 0;
  let labelSrc: LabelSrc = 'lbl';
  if (st & 0x20) {
    const lb = b24(c, o + 6);
    label = lb & 0x3fffff;
    labelSrc = lb & 0x400000 ? 'poi' : 'lbl';
    size += 3;
  }
  if (st & 0x80) size += 1;
  pts.push(x, y);
  return [size, { kind: 'point', type: 0x10000 | (t << 8) | (st & 0x1f), label, labelSrc, xy: NO_POINTS, text: undefined }];
}

/** Decodes one section's objects into `out`, with where each one's points start in `pts` (`ends`
 *  gets where they end). A section that doesn't decode cleanly is left out whole. */
function run(
  stats: DecodeStats, out: RawObject[], ends: number[], pts: PointBuffer, start: number, end: number,
  decodeOne: (o: number) => Decoded,
): void {
  stats.sections += 1;
  const [count, mark] = [out.length, pts.length];
  let o = start;
  try {
    while (o < end) {
      const [size, obj] = decodeOne(o);
      o += size;
      out.push(obj);
      ends.push(pts.length);
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    o = -1;
  }
  if (o !== end) {
    stats.badSections += 1;
    out.length = ends.length = count;
    pts.length = mark;
  }
}

const SECTIONS = [KIND_POINTS, KIND_IDX_POINTS, KIND_LINES, KIND_POLYGONS];
function decodeBit(kind: number): number {
  if (kind === KIND_LINES) return DECODE_LINES;
  if (kind === KIND_POLYGONS) return DECODE_POLYGONS;
  return DECODE_POINTS;
}

/** The `DECODE_*` kinds in a subdivision's main RGN section. */
export const mainKinds = (sd: Subdivision): number => SECTIONS.reduce((bits, k) => (sd.kinds & k ? bits | decodeBit(k) : bits), 0);

/** The `DECODE_*` kind of each extended section, in `extRanges`' order. */
export const EXT_KINDS = [DECODE_POLYGONS, DECODE_LINES, DECODE_POINTS] as const;

/** The subdivision's objects of the kinds in `kinds` (`DECODE_*` bits; all by default). */
export function decodeSubdivision(bytes: SubdivisionBytes, sd: Subdivision, stats: DecodeStats, kinds = DECODE_ALL): RawObject[] {
  const out: RawObject[] = [];
  const ends: number[] = [];
  const pts = new PointBuffer();
  const c = bytes.main;
  const present = SECTIONS.filter((k) => sd.kinds & k);
  if (present.some((k) => kinds & decodeBit(k)) && sd.rgnEnd > sd.rgnStart) {
    // The section offset table itself (not just each section's body) can run past the chunk on a
    // malformed subdivision; treat that the same as a bad section instead of throwing out of
    // decodeSubdivision (see `run`'s own RangeError handling below).
    let starts: number[] | null = null;
    try {
      starts = [sd.rgnStart + 2 * (present.length - 1)];
      for (let i = 0; i < present.length - 1; i++) starts.push(sd.rgnStart + b16(c, sd.rgnStart + 2 * i));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      stats.sections += 1;
      stats.badSections += 1;
      starts = null;
    }
    if (starts) {
      const resolvedStarts = starts;
      const sectionEnds = [...resolvedStarts.slice(1), sd.rgnEnd];
      present.forEach((kind, i) => {
        if (!(kinds & decodeBit(kind))) return;
        if (kind === KIND_POINTS || kind === KIND_IDX_POINTS) run(stats, out, ends, pts, resolvedStarts[i], sectionEnds[i], (o) => point(pts, c, o, sd));
        else run(stats, out, ends, pts, resolvedStarts[i], sectionEnds[i], (o) => poly(pts, c, o, sd, kind === KIND_LINES));
      });
    }
  }
  const [[pgA, pgE], [lnA, lnE], [ptA, ptE]] = extRanges(sd);
  if (kinds & EXT_KINDS[0] && pgE > pgA) run(stats, out, ends, pts, pgA, pgE, (o) => poly2(pts, bytes.ext[0], o, sd, false));
  if (kinds & EXT_KINDS[1] && lnE > lnA) run(stats, out, ends, pts, lnA, lnE, (o) => poly2(pts, bytes.ext[1], o, sd, true));
  if (kinds & EXT_KINDS[2] && ptE > ptA) run(stats, out, ends, pts, ptA, ptE, (o) => point2(pts, bytes.ext[2], o, sd));
  const all = pts.buf.slice(0, pts.length);
  out.forEach((obj, i) => {
    obj.xy = all.subarray(i ? ends[i - 1] : 0, ends[i]);
  });
  return out;
}
