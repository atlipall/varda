import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { parseTyp } from '../src/img/typ';
import { bytesOf, concat } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

type El = [number, number[]];

function makeTyp(points: El[] = [], lines: El[] = [], polygons: El[] = [], order: Array<[number, number]> = []): Uint8Array {
  const hdr = new Uint8Array(0x5b);
  const dv = new DataView(hdr.buffer);
  dv.setUint16(0, 0x5b, true);
  hdr.set(bytesOf('GARMIN TYP'), 2);
  dv.setUint16(0x15, 1252, true);
  const body: number[] = [];
  const sections: Array<[number, number, Array<[number, number]>]> = [];
  for (const elements of [points, lines, polygons]) {
    const dataStart = body.length;
    const index: Array<[number, number]> = [];
    for (const [t16, data] of elements) {
      index.push([t16, body.length - dataStart]);
      body.push(...data);
    }
    sections.push([0x5b + dataStart, body.length - dataStart, index]);
  }
  const arrays: Array<[number, number, number]> = [];
  for (const [, , index] of sections) {
    const start = body.length;
    for (const [t16, off] of index) body.push(t16 & 0xff, t16 >> 8, off & 0xff, off >> 8);
    arrays.push([0x5b + start, 4, 4 * index.length]);
  }
  const orderStart = body.length;
  for (const [typ, mask] of order) body.push(typ, mask & 0xff, (mask >> 8) & 0xff, (mask >> 16) & 0xff, (mask >>> 24) & 0xff);
  arrays.push([0x5b + orderStart, 5, 5 * order.length]);
  sections.forEach(([off, len], i) => {
    dv.setUint32(0x17 + 8 * i, off, true);
    dv.setUint32(0x1b + 8 * i, len, true);
  });
  arrays.forEach(([off, mod, size], i) => {
    dv.setUint32(0x33 + 10 * i, off, true);
    dv.setUint16(0x37 + 10 * i, mod, true);
    dv.setUint32(0x39 + 10 * i, size, true);
  });
  return concat(hdr, new Uint8Array(body));
}

const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('parseTyp', () => {
  test('polygon solid colour and draw order', () => {
    const typ = parseTyp(makeTyp([], [], [[0x50 << 5, [0x06, 0x30, 0x20, 0x10]]], [[0x50, 0], [0, 0], [0x3c, 0]]));
    expect(typ.polygons.get(0x50)).toEqual({ color: '#102030', pattern: null });
    expect([...typ.drawLevel]).toEqual([[0x50, 1], [0x3c, 2]]);
  });

  test('polygon pattern', () => {
    const typ = parseTyp(makeTyp([], [], [[0x4e << 5, [0x08, 0, 0, 255, 255, 255, 255, ...new Array(128).fill(0xff)]]]));
    const s = typ.polygons.get(0x4e)!;
    expect(s.color).toBe('#ff0000');
    expect([s.pattern!.width, s.pattern!.height]).toEqual([32, 32]);
    expect(px(s.pattern!, 5, 5)).toEqual([255, 0, 0, 255]);
  });

  test('line with border', () => {
    const line = parseTyp(makeTyp([], [[0x16 << 5, [0x00, 0x00, 0, 0, 255, 0, 0, 0, 3, 5]]])).lines.get(0x16);
    expect(line).toEqual({ color: '#ff0000', width: 3, borderColor: '#000000', borderWidth: 5, dash: null });
  });

  test('bitmap line becomes dash', () => {
    const line = parseTyp(makeTyp([], [[0x0a << 5, [(1 << 3) | 0x06, 0x00, 0, 0, 255, 0xff, 0x00, 0xff, 0x00]]])).lines.get(0x0a)!;
    expect([line.color, line.width, line.dash]).toEqual(['#ff0000', 1, [8, 8, 8, 8]]);
  });

  test('point bitmap with subtype', () => {
    const img = parseTyp(makeTyp([[(0x2f << 5) | 6, [0x01, 4, 1, 1, 0x00, 0x00, 0xff, 0x00, 0b1010]]])).points.get(0x2f06)!.image;
    expect([img.width, img.height]).toEqual([4, 1]);
    expect(px(img, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(px(img, 1, 0)[3]).toBe(0);
  });
});

describe.skipIf(!hasRealData)('parseTyp on real data', () => {
  test('Detailed TYP', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const typ = parseTyp(await img.read(img.firstOfType('TYP')!));
    expect([typ.polygons.size, typ.lines.size, typ.points.size]).toEqual([36, 29, 14]);
    expect(typ.drawLevel.size).toBeGreaterThan(0);
    await src.close();
  });
});
