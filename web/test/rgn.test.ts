import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { DECODE_LINES, decodeSubdivision, pairs, type Chunk, type DecodeStats } from '../src/img/rgn';
import { extFields, KIND_LINES, KIND_POINTS, parseTre, type Range, type Subdivision } from '../src/img/tre';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const LEVEL24 = { number: 0, bits: 24, inherited: false, count: 1 };
const sub = (start: number, end: number, kinds: number, ext: [Range, Range, Range] = [[0, 0], [0, 0], [0, 0]]): Subdivision => ({
  index: 0, level: LEVEL24, kinds, cx: 1000, cy: 2000, halfWidth: 0, halfHeight: 0, rgnStart: start, rgnEnd: end, ...extFields(ext),
});
const whole = (bytes: number[] | Uint8Array) => {
  const c: Chunk = { bytes: Uint8Array.from(bytes), base: 0 };
  return { main: c, ext: [c, c, c] as [Chunk, Chunk, Chunk] };
};
const stats = (): DecodeStats => ({ sections: 0, badSections: 0 });

describe('decodeSubdivision', () => {
  test('points and lines with a section pointer', () => {
    const point = [0x2f, 0x05, 0x00, 0x80, 0x01, 0x00, 0xff, 0xff, 0x06];
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const body = [2 + point.length, 0, ...point, ...line];
    const s = stats();
    const objs = decodeSubdivision(whole([...new Array(10).fill(0), ...body]), sub(10, 10 + body.length, KIND_POINTS | KIND_LINES), s);
    expect(objs.map((o) => [o.kind, o.type, o.label, o.labelSrc, pairs(o.xy)])).toEqual([
      ['point', 0x2f06, 5, 'lbl', [[1001, 1999]]],
      ['line', 0x16, 0, 'lbl', [[1000, 2000], [1001, 2002]]],
    ]);
    expect(s).toEqual({ sections: 2, badSections: 0 });
    // One buffer holds every object's points.
    expect(objs[0].xy.buffer).toBe(objs[1].xy.buffer);
  });

  test('only the kinds asked for', () => {
    const point = [0x2f, 0x05, 0x00, 0x80, 0x01, 0x00, 0xff, 0xff, 0x06];
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const body = [2 + point.length, 0, ...point, ...line];
    const s = stats();
    const objs = decodeSubdivision(whole([...new Array(10).fill(0), ...body]), sub(10, 10 + body.length, KIND_POINTS | KIND_LINES), s, DECODE_LINES);
    expect(objs.map((o) => [o.kind, pairs(o.xy)])).toEqual([['line', [[1000, 2000], [1001, 2002]]]]);
    expect(s).toEqual({ sections: 1, badSections: 0 });
  });

  test('a bad section leaves out its points too', () => {
    const point = [0x2f, 0x05, 0x00, 0x80, 0x01, 0x00, 0xff, 0xff, 0x06];
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    // The line section has a stray byte at its end, so it doesn't decode cleanly.
    const body = [2 + point.length, 0, ...point, ...line, 0];
    const objs = decodeSubdivision(whole(body), sub(0, body.length, KIND_POINTS | KIND_LINES), stats());
    expect(objs.map((o) => [o.kind, pairs(o.xy)])).toEqual([['point', [[1001, 1999]]]]);
    expect(objs[0].xy.buffer.byteLength).toBe(8);
  });

  test('extended polygon with label', () => {
    const rec = [0x03, 0x21, 0x02, 0x00, 0x03, 0x00, 0x07, 0x00, 0x25, 0x01, 0x07, 0x00, 0x00];
    const s = stats();
    const objs = decodeSubdivision(whole([0, 0, 0, 0, ...rec]), sub(0, 0, 0, [[4, 4 + rec.length], [0, 0], [0, 0]]), s);
    expect(objs.map((o) => [o.kind, o.type, o.label, pairs(o.xy)])).toEqual([['polygon', 0x10301, 7, [[1002, 2003], [1003, 2005]]]]);
    expect(s.badSections).toBe(0);
  });

  test('extended point with POI label', () => {
    const rec = [0x2c, 0x25, 0x01, 0x00, 0x02, 0x00, 0x09, 0x00, 0x40];
    const objs = decodeSubdivision(whole(rec), sub(0, 0, 0, [[0, 0], [0, 0], [0, rec.length]]), stats());
    expect(objs.map((o) => [o.kind, o.type, o.label, o.labelSrc, pairs(o.xy)])).toEqual([['point', 0x12c05, 9, 'poi', [[1001, 2002]]]]);
  });

  test('a misaligned section contributes no objects', () => {
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const s = stats();
    const objs = decodeSubdivision(whole([...line, 0]), sub(0, line.length + 1, KIND_LINES), s);
    expect(objs).toEqual([]);
    expect(s.badSections).toBe(1);
  });

  test('a malformed section offset table counts as a bad section instead of throwing', () => {
    // rgnStart is past the end of the chunk's bytes, so reading the 2-byte offset-table entry for
    // the second section overruns the chunk before any section body is even attempted.
    const s = stats();
    const objs = decodeSubdivision(whole([]), sub(100, 110, KIND_POINTS | KIND_LINES), s);
    expect(objs).toEqual([]);
    expect(s).toEqual({ sections: 1, badSections: 1 });
  });

  test('chunks with a non-zero base address absolute offsets', () => {
    const line = [0x16, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x00, 0x95];
    const c: Chunk = { bytes: Uint8Array.from(line), base: 5000 };
    const objs = decodeSubdivision({ main: c, ext: [c, c, c] }, sub(5000, 5000 + line.length, KIND_LINES), stats());
    expect(objs.length).toBe(1);
  });
});

describe.skipIf(!hasRealData)('decodeSubdivision on real data', () => {
  test('tile 14057403 sections align (head and past the 16 MB wrap)', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const rgn = await img.read('14057403.RGN');
    const t = parseTre(await img.read('14057403.TRE'), rgn.subarray(0, 0x7d));
    const c: Chunk = { bytes: rgn, base: 0 };
    const s = stats();
    let latOk = true;
    for (const sd of [...t.subdivisions.slice(0, 1500), ...t.subdivisions.slice(-800)]) {
      for (const o of decodeSubdivision({ main: c, ext: [c, c, c] }, sd, s)) {
        latOk &&= pairs(o.xy).every(([, y]) => (y * 360) / 2 ** 24 > 62.9 && (y * 360) / 2 ** 24 < 65.2);
      }
    }
    expect(s.sections).toBeGreaterThan(1000);
    expect(s.badSections).toBe(0);
    expect(latOk).toBe(true);
    await src.close();
  }, 120_000);
});
