import { describe, expect, test } from 'vitest';
import { onePerSquare } from '../src/dem/hgt';
import { coversExactly, decodeOverview, encodeOverview, keptAfter, OverviewBuilder, type Overview } from '../src/dem/overview';

/** A square of random heights (`step` samples per degree), so neighbours' shared edges differ and
 *  which square gives an edge sample shows. */
function square(south: number, west: number, step: number, seed: number) {
  const size = step + 1;
  const bytes = new Uint8Array(size * size * 2);
  let x = seed;
  for (let i = 0; i < bytes.length; i += 2) {
    x = (x * 1103515245 + 12345) >>> 0;
    const v = (x >>> 8) % 2500;
    bytes[i] = v >> 8;
    bytes[i + 1] = v & 255;
  }
  const ns = south >= 0 ? 'n' : 's';
  const ew = west >= 0 ? 'e' : 'w';
  const name = `${ns}${String(Math.abs(south)).padStart(2, '0')}${ew}${String(Math.abs(west)).padStart(3, '0')}.hgt`;
  return { south, west, step, name, bytes };
}
type Square = ReturnType<typeof square>;

function full(all: Square[]): Overview {
  const b = new OverviewBuilder(all);
  for (const h of all) b.add(h.south, h.west, h.bytes, h.step);
  return b.finish();
}

/** What storeElevation does when adding to a set: the old overview, with only the written squares added. */
function added(oldOverview: Overview, old: Square[], all: Square[]): Overview {
  const b = new OverviewBuilder(all);
  expect(coversExactly(oldOverview, old)).toBe(true);
  expect(b.seed(oldOverview)).toBe(true);
  const kept = new Set(all.filter((h) => old.includes(h)));
  const keeps = keptAfter(all, kept);
  for (const h of all) if (!kept.has(h)) b.add(h.south, h.west, h.bytes, h.step, keeps(h));
  return b.finish();
}

describe('adding squares to an elevation set', () => {
  test('gives the same overview as building it from all the files', () => {
    let seed = 1;
    const old = onePerSquare([square(64, -20, 1200, seed++), square(64, -19, 1200, seed++), square(63, -20, 1200, seed++), square(65, -18, 1200, seed++)]);
    const before = decodeOverview(encodeOverview(full(old)));
    // New squares around and between the old ones (west, south, a corner), and a finer 1″ file
    // replacing an old 3″ square.
    const fresh = [square(64, -21, 1200, seed++), square(62, -20, 1200, seed++), square(63, -19, 1200, seed++), square(64, -19, 3600, seed++)];
    const all = onePerSquare([...fresh, ...old]);
    expect(all).toHaveLength(7);
    const want = full(all);
    const got = added(before, old, all);
    expect({ ...got, data: null }).toEqual({ ...want, data: null });
    expect(got.data).toEqual(want.data);
  });

  test('an overview of another area is not used', () => {
    const old = [square(64, -20, 1200, 1), square(64, -19, 1200, 2)];
    const other = full([old[0]]);
    expect(coversExactly(other, old)).toBe(false);
    const b = new OverviewBuilder([square(60, -20, 1200, 3)]);
    expect(b.seed(full(old))).toBe(false); // outside
  });
});
