import { ascii, ImgError, mapUnitsToDeg, s24, u16, u24, u32, u8 } from './bytes';

export const KIND_POINTS = 0x10;
export const KIND_IDX_POINTS = 0x20;
export const KIND_LINES = 0x40;
export const KIND_POLYGONS = 0x80;

export type Range = [number, number];

export interface Level {
  number: number;
  bits: number;
  inherited: boolean;
  count: number;
}

export interface Subdivision {
  index: number;
  level: Level;
  kinds: number;
  cx: number;
  cy: number;
  halfWidth: number;
  halfHeight: number;
  rgnStart: number;
  rgnEnd: number;
  /** The extended (type 0x10000+) sections' byte ranges in RGN, [start, end): polygons, lines,
   *  points. Plain fields rather than arrays: a big map has over 100,000 subdivisions, and four
   *  small arrays each cost more than the rest of the subdivision. */
  extPolygonStart: number;
  extPolygonEnd: number;
  extLineStart: number;
  extLineEnd: number;
  extPointStart: number;
  extPointEnd: number;
}

/** The extended sections' fields from their ranges (polygons, lines, points). */
export function extFields([[pgA, pgE], [lnA, lnE], [ptA, ptE]]: readonly [Range, Range, Range]) {
  return { extPolygonStart: pgA, extPolygonEnd: pgE, extLineStart: lnA, extLineEnd: lnE, extPointStart: ptA, extPointEnd: ptE };
}

/** The extended sections' ranges: polygons, lines, points. */
export const extRanges = (sd: Subdivision): [Range, Range, Range] =>
  [[sd.extPolygonStart, sd.extPolygonEnd], [sd.extLineStart, sd.extLineEnd], [sd.extPointStart, sd.extPointEnd]];

export interface Tre {
  north: number;
  east: number;
  south: number;
  west: number;
  levels: Level[];
  subdivisions: Subdivision[];
}

export const shiftOf = (sd: Subdivision): number => 24 - sd.level.bits;

export const hasData = (sd: Subdivision): boolean =>
  sd.kinds !== 0 || sd.extPolygonEnd > sd.extPolygonStart || sd.extLineEnd > sd.extLineStart || sd.extPointEnd > sd.extPointStart;

/** [west, south, east, north] in Garmin map units. */
export function subdivisionBounds(sd: Subdivision): [number, number, number, number] {
  const k = 2 ** shiftOf(sd);
  return [sd.cx - sd.halfWidth * k, sd.cy - sd.halfHeight * k, sd.cx + sd.halfWidth * k, sd.cy + sd.halfHeight * k];
}

export function parseTre(tre: Uint8Array, rgn: Uint8Array): Tre {
  if (ascii(tre, 2, 12) !== 'GARMIN TRE') throw new ImgError('TRE: bad signature');
  if (ascii(rgn, 2, 12) !== 'GARMIN RGN') throw new ImgError('RGN: bad signature');
  const hlen = u16(tre, 0);
  if (u8(tre, 0x0d) & 0x80) throw new ImgError('TRE is locked/encrypted (header flag 0x80); locked maps are not supported');

  const lo = u32(tre, 0x21);
  const ls = u32(tre, 0x25);
  const levels: Level[] = [];
  for (let i = 0; i < ls; i += 4) {
    levels.push({ number: u8(tre, lo + i) & 0x0f, bits: u8(tre, lo + i + 1), inherited: (u8(tre, lo + i) & 0x80) !== 0, count: u16(tre, lo + i + 2) });
  }

  const rgnOff = u32(rgn, 0x15);
  const rgnLen = u32(rgn, 0x19);
  const subs: Subdivision[] = [];
  let p = u32(tre, 0x29);
  let wrap = 0;
  let prev = -1;
  levels.forEach((level, li) => {
    const rec = li === levels.length - 1 ? 14 : 16;
    for (let k = 0; k < level.count; k++) {
      let r = u24(tre, p) + wrap;
      if (r < prev) {
        // RGN offsets are 24-bit; sections over 16 MB wrap around
        wrap += 0x1000000;
        r += 0x1000000;
      }
      prev = r;
      subs.push({
        index: subs.length, level, kinds: u8(tre, p + 3), cx: s24(tre, p + 4), cy: s24(tre, p + 7),
        halfWidth: u16(tre, p + 10) & 0x7fff, halfHeight: u16(tre, p + 12),
        rgnStart: rgnOff + r, rgnEnd: 0,
        extPolygonStart: 0, extPolygonEnd: 0, extLineStart: 0, extLineEnd: 0, extPointStart: 0, extPointEnd: 0,
      });
      p += rec;
    }
  });
  for (let i = 0; i + 1 < subs.length; i++) subs[i].rgnEnd = subs[i + 1].rgnStart;
  if (subs.length) subs[subs.length - 1].rgnEnd = rgnOff + rgnLen;
  attachExt(tre, rgn, hlen, subs);

  return {
    north: mapUnitsToDeg(s24(tre, 0x15)), east: mapUnitsToDeg(s24(tre, 0x18)),
    south: mapUnitsToDeg(s24(tre, 0x1b)), west: mapUnitsToDeg(s24(tre, 0x1e)),
    levels, subdivisions: subs,
  };
}

function attachExt(tre: Uint8Array, rgn: Uint8Array, hlen: number, subs: Subdivision[]): void {
  if (hlen < 0x86 || u16(rgn, 0) < 0x5d) return;
  const off = u32(tre, 0x7c);
  const size = u32(tre, 0x80);
  const rec = u16(tre, 0x84);
  if (!size || rec < 12) return;
  const sections: Range[] = [[u32(rgn, 0x1d), u32(rgn, 0x21)], [u32(rgn, 0x39), u32(rgn, 0x3d)], [u32(rgn, 0x55), u32(rgn, 0x59)]];
  const records: Array<[number, number, number]> = [];
  for (let i = 0; i < Math.floor(size / rec); i++) {
    const o = off + i * rec;
    records.push([u32(tre, o), u32(tre, o + 4), rec >= 13 ? u32(tre, o + 8) : 0]);
  }
  subs.slice(0, records.length).forEach((sd, i) => {
    Object.assign(sd, extFields(sections.map(([sectOff, sectLen], k) => {
      let start = records[i][k];
      let end = i + 1 < records.length ? records[i + 1][k] : sectLen;
      if (k === 2 && rec < 13) start = end = 0;
      return [sectOff + start, sectOff + end];
    }) as [Range, Range, Range]));
  });
}
