import { describe, expect, test } from 'vitest';
import { ImgContainer } from '../src/img/container';
import { extRanges, KIND_LINES, KIND_POINTS, parseTre, shiftOf, subdivisionBounds } from '../src/img/tre';
import { makeRgnHeader, makeTre } from './helpers/builders';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const LEVELS: Array<[number, number, boolean, number]> = [[1, 22, false, 1], [0, 24, false, 2]];

describe('parseTre', () => {
  test('levels, subdivisions and bounds', () => {
    const t = parseTre(makeTre(LEVELS, [[0, KIND_POINTS, 100, 200], [40, KIND_LINES, -5, 7], [90, 0, 1, 2]]), makeRgnHeader(300));
    expect(t.levels.map((l) => [l.number, l.bits])).toEqual([[1, 22], [0, 24]]);
    const s = t.subdivisions;
    expect(s.map((x) => [x.rgnStart, x.rgnEnd])).toEqual([[0x7d, 0x7d + 40], [0x7d + 40, 0x7d + 90], [0x7d + 90, 0x7d + 300]]);
    expect([shiftOf(s[0]), shiftOf(s[1])]).toEqual([2, 0]);
    expect([s[1].cx, s[1].cy, s[1].kinds]).toEqual([-5, 7, KIND_LINES]);
    expect(subdivisionBounds(s[0])).toEqual([60, 160, 140, 240]);
    expect(t.north).toBeCloseTo((1000 * 360) / 2 ** 24, 12);
  });

  test('unwraps 24-bit RGN offsets', () => {
    const s = parseTre(makeTre(LEVELS, [[0, 0, 0, 0], [0xfffff0, 0, 0, 0], [0x10, 0, 0, 0]]), makeRgnHeader(0x1000100)).subdivisions;
    expect(s[2].rgnStart).toBe(0x7d + 0x1000010);
    expect(s[1].rgnEnd).toBe(s[2].rgnStart);
  });

  test('ext offsets', () => {
    const tre = makeTre(LEVELS, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], [[0, 0, 0], [20, 0, 0], [20, 0, 12], [60, 0, 12]]);
    const s = parseTre(tre, makeRgnHeader(10, [[500, 60], [600, 0], [700, 12]])).subdivisions;
    expect(extRanges(s[0])).toEqual([[500, 520], [600, 600], [700, 700]]);
    expect(extRanges(s[1])).toEqual([[520, 520], [600, 600], [700, 712]]);
    expect(extRanges(s[2])).toEqual([[520, 560], [600, 600], [712, 712]]);
  });

  test('locked TRE is rejected', () => {
    const tre = makeTre(LEVELS, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    tre[0x0d] = 0x80;
    expect(() => parseTre(tre, makeRgnHeader(10))).toThrow(/locked/);
  });
});

describe.skipIf(!hasRealData)('parseTre on real data', () => {
  test('tile 14057403', async () => {
    const src = await nodeSource(DETAILED);
    const img = await ImgContainer.open(src);
    const rgnHead = await img.read('14057403.RGN', 0, 0x7d);
    const t = parseTre(await img.read('14057403.TRE'), rgnHead);
    expect(t.levels.map((l) => l.bits)).toEqual([16, 18, 20, 22, 24]);
    expect(t.subdivisions.length).toBe(7892);
    const starts = t.subdivisions.map((s) => s.rgnStart);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(t.subdivisions.at(-1)!.rgnEnd).toBeGreaterThan(2 ** 24);
    expect(t.south).toBeGreaterThan(62.9);
    expect(t.north).toBeLessThan(65.2);
    await src.close();
  });
});
