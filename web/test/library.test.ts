import { describe, expect, it } from 'vitest';
import { autoSet, canonicalHgtName, contains, coverage, coverageText, defaultSetName, elevationFor, parseChoices, parseSetJson, type MapInfo, type SetInfo } from '../src/storage/library';

const squares = (souths: number[], wests: number[]) => souths.flatMap((south) => wests.map((west) => ({ south, west })));
const set = (id: string, step: number, sq: Array<{ south: number; west: number }>): SetInfo => ({ id, name: id, files: [], step, overview: 'overview.bin', bytes: 0, squares: sq });
const iceland: [number, number, number, number] = [-24.5, 63.3, -13.5, 66.6];
const map = (elevation?: string | null): MapInfo => ({ id: 'garmin-1', name: 'm', imgName: 'm.img', bytes: 1, added: 0, bounds: iceland, elevation });

describe('coverage', () => {
  const all = set('a', 1200, squares([63, 64, 65, 66], [-25, -24, -23, -22, -21, -20, -19, -18, -17, -16, -15, -14]));
  it('is 1 when every 1° square of the map has a file', () => expect(coverage(all, iceland)).toBe(1));
  it('is the share of the map\'s area with files', () => {
    const c = coverage(set('p', 1200, squares([63, 64], [-25, -24, -23, -22, -21, -20, -19, -18, -17, -16, -15, -14])), iceland);
    expect(c).toBeCloseTo(1.7 / 3.3);
  });
  it('says a map running past its files over the sea is covered (GPSmap.is and its own files)', () => {
    const c = coverage(all, [-26.0101318359375, 62.984619140625, -11.9915771484375, 67.0111083984375]);
    expect(c).toBeGreaterThan(0.8);
    expect(coverageText(c)).toBe('Covers this map');
  });
  it('is 0 elsewhere', () => expect(coverage(set('f', 1200, [{ south: 61, west: -8 }]), iceland)).toBe(0));
  it('words it', () => {
    expect(coverageText(1)).toBe('Covers this map');
    expect(coverageText(0.4)).toBe('Covers part of this map');
    expect(coverageText(0)).toBe("Doesn't cover this map");
  });
});

describe('choosing a set', () => {
  const full3 = set('elevation-1', 1200, squares([63, 64, 65, 66], [-25, -24, -23, -22, -21, -20, -19, -18, -17, -16, -15, -14]));
  const full1 = { ...full3, id: 'elevation-2', step: 3600 };
  const part1 = set('elevation-3', 3600, [{ south: 64, west: -19 }]);
  const faroe = set('elevation-4', 3600, [{ south: 61, west: -8 }]);
  it('takes the set covering most, then the finer one', () => {
    expect(autoSet([part1, full3], iceland)?.id).toBe('elevation-1');
    expect(autoSet([full3, full1, part1], iceland)?.id).toBe('elevation-2');
  });
  it('takes none when nothing covers the map', () => expect(autoSet([faroe], iceland)).toBeNull());
  it('takes none without the map\'s area', () => expect(autoSet([full3], null)).toBeNull());
  it('follows the choice, Off included, and falls back when the chosen set is gone', () => {
    expect(elevationFor(map('elevation-3'), [full3, part1])?.id).toBe('elevation-3');
    expect(elevationFor(map(null), [full3])).toBeNull();
    expect(elevationFor(map('elevation-9'), [full3])?.id).toBe('elevation-1');
    expect(elevationFor(map(undefined), [full3])?.id).toBe('elevation-1');
  });
});

describe('stored files', () => {
  it('reads choices tolerantly', () => {
    expect(parseChoices(null)).toEqual({ maps: {}, sets: {} });
    expect(parseChoices('{nope')).toEqual({ maps: {}, sets: {} });
    expect(parseChoices('[1]')).toEqual({ maps: {}, sets: {} });
    expect(parseChoices('{"maps":{"garmin-1":{"name":"A","elevation":null,"bounds":[1,2,3,4]},"x":5},"sets":{"elevation-1":{"name":"HD"}}}')).toEqual({
      maps: { 'garmin-1': { name: 'A', elevation: null, bounds: [1, 2, 3, 4] } },
      sets: { 'elevation-1': { name: 'HD' } },
    });
    expect(parseChoices('{"maps":{"garmin-1":{"name":3,"elevation":4,"bounds":[1]}}}')).toEqual({ maps: { 'garmin-1': {} }, sets: {} });
  });
  it('reads a set file', () => {
    expect(parseSetJson('{"version":1,"name":"HD","files":["n64w019.hgt"],"step":3600}')).toEqual({ name: 'HD', files: ['n64w019.hgt'], step: 3600, overview: 'overview.bin' });
    expect(parseSetJson('{"version":1,"name":"HD","files":[],"step":3600,"overview":"overview.5.bin","bytes":9}')).toEqual({ name: 'HD', files: [], step: 3600, overview: 'overview.5.bin', bytes: 9 });
    expect(parseSetJson('{"version":2}')).toBeNull();
    expect(parseSetJson(null)).toBeNull();
  });
  it('names a replaced square back', () => {
    expect(canonicalHgtName('n64w019.hgt')).toBe('n64w019.hgt');
    expect(canonicalHgtName('n64w019.1731000000000.hgt')).toBe('n64w019.hgt');
  });
  it('names a new set', () => {
    expect(defaultSetName(3600, 48)).toBe('1″ elevation · 48 files');
    expect(defaultSetName(1200, 1)).toBe('3″ elevation · 1 file');
  });
  it('knows what a map covers', () => {
    expect(contains(iceland, [-19, 64])).toBe(true);
    expect(contains(iceland, [-7, 62])).toBe(false);
  });
});
