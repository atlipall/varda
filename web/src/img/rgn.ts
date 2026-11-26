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
  coords: Array<[number, number]>;
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

function walk(sd: Subdivision, dx: number, dy: number, deltas: Array<[number, number]>): Array<[number, number]> {
  const k = 2 ** shiftOf(sd);
  let x = sd.cx + dx * k;
  let y = sd.cy + dy * k;
  const coords: Array<[number, number]> = [[x, y]];
  for (const [ddx, ddy] of deltas) {
    if (ddx === 0 && ddy === 0) continue;
    x += ddx * k;
    y += ddy * k;
    coords.push([x, y]);
  }
  return coords;
}

type Decoded = [number, RawObject];

function point(c: Chunk, o: number, sd: Subdivision): Decoded {
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
  return [size, { kind: 'point', type: (b8(c, o) << 8) | sub, label: lb & 0x3fffff, labelSrc: lb & 0x400000 ? 'poi' : 'lbl', coords: [[x, y]] }];
}

function poly(c: Chunk, o: number, sd: Subdivision, line: boolean): Decoded {
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
  return [p + n - o, { kind: line ? 'line' : 'polygon', type, label: lb & 0x3fffff, labelSrc: lb & 0x800000 ? 'net' : 'lbl', coords: walk(sd, dx, dy, deltas) }];
}

function poly2(c: Chunk, o: number, sd: Subdivision, line: boolean): Decoded {
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
  return [p - o, { kind: line ? 'line' : 'polygon', type, label, labelSrc: 'lbl', coords: walk(sd, dx, dy, deltas) }];
}

function point2(c: Chunk, o: number, sd: Subdivision): Decoded {
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
  return [size, { kind: 'point', type: 0x10000 | (t << 8) | (st & 0x1f), label, labelSrc, coords: [[x, y]] }];
}

function run(stats: DecodeStats, out: RawObject[], start: number, end: number, decodeOne: (o: number) => Decoded): void {
  stats.sections += 1;
  const local: RawObject[] = [];
  let o = start;
  try {
    while (o < end) {
      const [size, obj] = decodeOne(o);
      o += size;
      local.push(obj);
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    stats.badSections += 1;
    return;
  }
  if (o !== end) {
    stats.badSections += 1;
    return;
  }
  out.push(...local);
}

const SECTIONS = [KIND_POINTS, KIND_IDX_POINTS, KIND_LINES, KIND_POLYGONS];

export function decodeSubdivision(bytes: SubdivisionBytes, sd: Subdivision, stats: DecodeStats): RawObject[] {
  const out: RawObject[] = [];
  const c = bytes.main;
  const present = SECTIONS.filter((k) => sd.kinds & k);
  if (present.length && sd.rgnEnd > sd.rgnStart) {
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
      const ends = [...resolvedStarts.slice(1), sd.rgnEnd];
      present.forEach((kind, i) => {
        if (kind === KIND_POINTS || kind === KIND_IDX_POINTS) run(stats, out, resolvedStarts[i], ends[i], (o) => point(c, o, sd));
        else run(stats, out, resolvedStarts[i], ends[i], (o) => poly(c, o, sd, kind === KIND_LINES));
      });
    }
  }
  const [[pgA, pgE], [lnA, lnE], [ptA, ptE]] = extRanges(sd);
  if (pgE > pgA) run(stats, out, pgA, pgE, (o) => poly2(bytes.ext[0], o, sd, false));
  if (lnE > lnA) run(stats, out, lnA, lnE, (o) => poly2(bytes.ext[1], o, sd, true));
  if (ptE > ptA) run(stats, out, ptA, ptE, (o) => point2(bytes.ext[2], o, sd));
  return out;
}
