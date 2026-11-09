/** TYP style file parser (after QMapShack's CGarminTyp). */
import { ascii, ImgError, u16, u32, u8 } from './bytes';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface PolygonStyle {
  color: string;
  pattern: RgbaImage | null;
}
export interface LineStyle {
  color: string;
  width: number;
  borderColor: string | null;
  borderWidth: number;
  dash: number[] | null;
}
export interface PointStyle {
  image: RgbaImage;
}
export interface Typ {
  polygons: Map<number, PolygonStyle>;
  lines: Map<number, LineStyle>;
  points: Map<number, PointStyle>;
  drawLevel: Map<number, number>;
}

export const emptyTyp = (): Typ => ({ polygons: new Map(), lines: new Map(), points: new Map(), drawLevel: new Map() });

type Rgba = [number, number, number, number];

class Reader {
  constructor(readonly d: Uint8Array, public pos = 0) {}
  u8(): number {
    return u8(this.d, this.pos++);
  }
  u16(): number {
    const v = u16(this.d, this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = u32(this.d, this.pos);
    this.pos += 4;
    return v;
  }
  rgb(): Rgba {
    const b = this.u8();
    const g = this.u8();
    const r = this.u8();
    return [r, g, b, 255];
  }
}

const hex = (c: Rgba) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');

function indices(r: Reader, w: number, h: number, bpp: number): number[][] {
  const perByte = Math.floor(8 / bpp);
  const mask = (1 << bpp) - 1;
  const rows: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    while (row.length < w) {
      const byte = r.u8();
      for (let i = 0; i < perByte && row.length < w; i++) row.push((byte >> (i * bpp)) & mask);
    }
    rows.push(row);
  }
  return rows;
}

function image(rows: number[][], palette: Array<Rgba | null>): RgbaImage {
  const width = rows[0].length;
  const height = rows.length;
  const data = new Uint8Array(width * height * 4);
  rows.forEach((row, y) => row.forEach((idx, x) => {
    const c = idx < palette.length ? palette[idx] : null;
    if (c) data.set(c, (y * width + x) * 4);
  }));
  return { width, height, data };
}

function dash(rows: number[][]): number[] | null {
  const n = rows[0].length;
  const cols = Array.from({ length: n }, (_, x) => rows.some((row) => row[x] === 1));
  if (cols.every(Boolean) || !cols.some(Boolean)) return null;
  const start = cols.findIndex((on, i) => on && !cols[(i - 1 + n) % n]);
  const seq = [...cols.slice(start), ...cols.slice(0, start)];
  const runs: Array<[boolean, number]> = [];
  for (const on of seq) {
    const last = runs[runs.length - 1];
    if (last && last[0] === on) last[1] += 1;
    else runs.push([on, 1]);
  }
  return runs.map(([, len]) => len / rows.length);
}

function* elements(data: Uint8Array, array: [number, number, number], dataOffset: number): Generator<[number, Reader]> {
  const [off, mod, size] = array;
  if (!mod || !size || size % mod) return;
  const r = new Reader(data);
  for (let i = 0; i < size / mod; i++) {
    r.pos = off + i * mod;
    const t16 = r.u16();
    let o: number;
    if (mod === 5) o = r.u16() | (r.u8() << 16);
    else if (mod === 4) o = r.u16();
    else if (mod === 3) o = r.u8();
    else return;
    yield [t16, new Reader(data, dataOffset + o)];
  }
}

function linePolygonType(t16: number): number {
  const typ = ((t16 >> 5) | ((t16 & 0x1f) << 11)) & 0x7f;
  return t16 & 0x2000 ? 0x10000 | (typ << 8) | (t16 & 0x1f) : typ;
}

function pointType(t16: number): number {
  const typ = ((t16 >> 5) | ((t16 & 0x1f) << 11)) & 0x7ff;
  return t16 & 0x2000 ? 0x10000 | (typ << 8) | (t16 & 0x1f) : (typ << 8) + (t16 & 0x1f);
}

function polygon(r: Reader): PolygonStyle | null {
  const ctyp = r.u8() & 0x0f;
  if (ctyp === 0x01 || ctyp === 0x06 || ctyp === 0x07) return { color: hex(r.rgb()), pattern: null };
  if (ctyp === 0x08 || ctyp === 0x09 || ctyp === 0x0d) {
    const fg = r.rgb();
    const bg = r.rgb();
    if (ctyp === 0x09) {
      r.rgb();
      r.rgb();
    } else if (ctyp === 0x0d) {
      r.rgb();
    }
    return { color: hex(fg), pattern: image(indices(r, 32, 32, 1), [bg, fg]) };
  }
  if (ctyp === 0x0b || ctyp === 0x0e || ctyp === 0x0f) {
    const fg = r.rgb();
    if (ctyp === 0x0b) {
      r.rgb();
      r.rgb();
    } else if (ctyp === 0x0f) {
      r.rgb();
    }
    return { color: hex(fg), pattern: image(indices(r, 32, 32, 1), [null, fg]) };
  }
  return null;
}

const LINE_COLOURS: Record<number, number> = { 0x00: 2, 0x01: 4, 0x03: 3, 0x05: 3, 0x06: 1, 0x07: 2 };

function line(r: Reader): LineStyle | null {
  const f1 = r.u8();
  r.u8();
  const ctyp = f1 & 0x07;
  const rows = f1 >> 3;
  const ncolours = LINE_COLOURS[ctyp];
  if (ncolours === undefined) return null;
  const colours = Array.from({ length: ncolours }, () => r.rgb());
  const day = hex(colours[0]);
  if (rows) return { color: day, width: rows, borderColor: null, borderWidth: 0, dash: dash(indices(r, 32, rows, 1)) };
  let w1: number;
  let w2 = 0;
  if (ctyp === 0x00 || ctyp === 0x01 || ctyp === 0x03) {
    w1 = r.u8();
    w2 = r.u8();
  } else {
    w1 = r.u8();
  }
  if ((ctyp === 0x00 || ctyp === 0x01) && w2 > w1) return { color: day, width: w1, borderColor: hex(colours[1]), borderWidth: w2, dash: null };
  return { color: day, width: w1, borderColor: null, borderWidth: 0, dash: null };
}

function bpp(ncolors: number, flags: number): number | null {
  let table: Array<[number, number]>;
  if (flags === 0x00) table = [[3, ncolors], [4, 2], [16, 4], [256, 8]];
  else if (flags === 0x10) {
    if (ncolors === 0) return 1;
    table = [[3, 2], [15, 4], [256, 8]];
  } else if (flags === 0x20) {
    if (ncolors === 0) return 16;
    table = [[3, ncolors], [4, 2], [16, 4], [256, 8]];
  } else return null;
  for (const [limit, b] of table) if (ncolors < limit) return b;
  return null;
}

function colourTable(r: Reader, n: number, alpha: boolean): Rgba[] {
  if (!alpha) return Array.from({ length: n }, () => r.rgb());
  const out: Rgba[] = [];
  let reg = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    while (bits < 28) {
      reg += r.u8() * 2 ** bits;
      bits += 8;
    }
    const nibble = Math.floor(reg / 2 ** 24) % 16;
    out.push([Math.floor(reg / 65536) % 256, Math.floor(reg / 256) % 256, reg % 256, Math.round(((15 - nibble) * 255) / 15)]);
    reg = Math.floor(reg / 2 ** 28);
    bits -= 28;
  }
  return out;
}

function point(r: Reader): PointStyle | null {
  r.u8();
  const w = r.u8();
  const h = r.u8();
  const ncolors = r.u8();
  const flags = r.u8();
  const b = bpp(ncolors, flags);
  if (!b || b >= 16 || !w || !h) return null;
  const palette = colourTable(r, ncolors, flags === 0x20);
  return { image: image(indices(r, w, h, b), palette) };
}

function drawLevels(data: Uint8Array, array: [number, number, number]): Map<number, number> {
  const [off, mod, size] = array;
  const levels = new Map<number, number>();
  if (mod !== 5 || !size || size % 5) return levels;
  let level = 1;
  for (let i = 0; i < size / 5; i++) {
    const typ = u8(data, off + i * 5);
    const mask = u32(data, off + i * 5 + 1);
    if (typ === 0) level += 1;
    else if (mask === 0) levels.set(typ, level);
    else for (let n = 0; n < 32; n++) if (Math.floor(mask / 2 ** n) % 2 === 1) levels.set(0x10000 | (typ << 8) | n, level);
  }
  return levels;
}

export function parseTyp(data: Uint8Array): Typ {
  if (ascii(data, 2, 12) !== 'GARMIN TYP') throw new ImgError('TYP: bad signature');
  const r = new Reader(data, 0x17);
  const pointsData = [r.u32(), r.u32()];
  const linesData = [r.u32(), r.u32()];
  const polygonsData = [r.u32(), r.u32()];
  r.u16();
  r.u16();
  const arrays = Array.from({ length: 4 }, () => [r.u32(), r.u16(), r.u32()] as [number, number, number]);
  const typ: Typ = { ...emptyTyp(), drawLevel: drawLevels(data, arrays[3]) };
  for (const [t16, er] of elements(data, arrays[0], pointsData[0])) {
    const s = point(er);
    if (s) typ.points.set(pointType(t16), s);
  }
  for (const [t16, er] of elements(data, arrays[1], linesData[0])) {
    const s = line(er);
    if (s) typ.lines.set(linePolygonType(t16), s);
  }
  for (const [t16, er] of elements(data, arrays[2], polygonsData[0])) {
    const s = polygon(er);
    if (s) typ.polygons.set(linePolygonType(t16), s);
  }
  return typ;
}
