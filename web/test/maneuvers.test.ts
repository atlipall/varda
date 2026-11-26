import { describe, expect, test } from 'vitest';
import { maneuvers, roadLabel, ROUNDABOUT } from '../src/routing/maneuvers';
import type { LonLat, RoadSeg } from '../src/routing/plan';
import { Progress } from '../src/routing/progress';
import { OldProgress } from './helpers/oldProgress';

const seg = (start: number, name: string | null, extra: Partial<RoadSeg> = {}): RoadSeg => ({ start, name, type: 1, junction: true, seconds: 10, ...extra });
const kinds = (ms: ReturnType<typeof maneuvers>) => ms.map((m) => `${m.kind}: ${m.text}`);

describe('roadLabel', () => {
  test('numbers are roads, F-roads stay, capitals become normal case', () => {
    expect(roadLabel('26')).toBe('road 26');
    expect(roadLabel('F26')).toBe('F26');
    expect(roadLabel('SIGTÚN')).toBe('Sigtún');
    expect(roadLabel(null)).toBeNull();
  });
});

describe('maneuvers', () => {
  test('set off, turn left onto another road, arrive', () => {
    // North 222 m on road 1, then west on road 26.
    const coords: LonLat[] = [[0, 0], [0, 0.002], [-0.002, 0.002]];
    expect(kinds(maneuvers(coords, [seg(0, '1'), seg(1, '26')], 'Hut'))).toEqual([
      'depart: Head north on road 1',
      'turn: Turn left onto road 26',
      'arrive: Arrive at Hut',
    ]);
  });

  test('straight on through a junction: nothing on the same road, "Continue onto" when the road changes', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0, 0.004], [0, 0.006]];
    expect(kinds(maneuvers(coords, [seg(0, '1'), seg(1, '1'), seg(2, '35')], 'X'))).toEqual([
      'depart: Head north on road 1',
      'continue: Continue onto road 35',
      'arrive: Arrive at X',
    ]);
  });

  test('a roundabout: the exit to take is the number of stretches on it', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0.0003, 0.0023], [0.0006, 0.002], [0.0006, 0]];
    const segs = [seg(0, '1'), seg(1, null, { type: ROUNDABOUT }), seg(2, null, { type: ROUNDABOUT, junction: false }), seg(3, '1', { junction: false })];
    expect(kinds(maneuvers(coords, segs, 'X'))).toEqual([
      'depart: Head north on road 1',
      'roundabout: At the roundabout, take the 2nd exit onto road 1',
      'arrive: Arrive at X',
    ]);
  });

  test('a roundabout instruction knows where its exit points, relative to the way in', () => {
    // North into the roundabout; off it heading east (right), north (straight) or west (left).
    const at = (exitTo: LonLat): number | undefined => {
      const coords: LonLat[] = [[0, 0], [0, 0.002], [0.0002, 0.0022], [0.0002 + exitTo[0], 0.0022 + exitTo[1]]];
      const segs = [seg(0, '1'), seg(1, null, { type: ROUNDABOUT }), seg(2, '35', { junction: false })];
      return maneuvers(coords, segs, 'X').find((m) => m.kind === 'roundabout')?.exitAngle;
    };
    expect(at([0.002, 0])).toBe(90);
    expect(at([0, 0.002])).toBe(0);
    expect(at([-0.002, 0])).toBe(-90);
  });

  test('the same road bending at a junction needs no instruction; a real turn to stay on it does', () => {
    const bend: LonLat[] = [[0, 0], [0, 0.002], [0.001, 0.004]]; // ~27° right
    expect(kinds(maneuvers(bend, [seg(0, '1'), seg(1, '1')], 'X')).map((k) => k.split(':')[0])).toEqual(['depart', 'arrive']);
    const corner: LonLat[] = [[0, 0], [0, 0.002], [0.002, 0.002]]; // 90° right
    expect(kinds(maneuvers(corner, [seg(0, '1'), seg(1, '1')], 'X'))[1]).toBe('turn: Turn right to stay on road 1');
  });

  test('a turn onto another road counts even where the network shows no junction (one-way streets)', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [-0.002, 0.002]];
    expect(kinds(maneuvers(coords, [seg(0, 'GRENSÁSVEGUR'), seg(1, 'MIKLABRAUT', { junction: false })], 'X'))[1]).toBe('turn: Turn left onto Miklabraut');
  });

  test('a waypoint right before a turn, or just after a roundabout, keeps its instruction', () => {
    // A waypoint 11 m before a left turn: both stay (only two turns that close are merged).
    const near: LonLat[] = [[0, 0], [0, 0.002], [0, 0.0021], [-0.002, 0.0021]];
    expect(kinds(maneuvers(near, [seg(0, '1'), seg(1, '1', { via: 1 }), seg(2, '26')], 'X')).slice(1, 3)).toEqual(['via: Waypoint 1', 'turn: Turn left onto road 26']);
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0.0003, 0.0023], [0.0006, 0.002], [0.0006, 0]];
    const segs = [seg(0, '1'), seg(1, null, { type: ROUNDABOUT }), seg(2, null, { type: ROUNDABOUT }), seg(3, '1', { via: 1 })];
    expect(kinds(maneuvers(coords, segs, 'X')).slice(1, 3)).toEqual(['roundabout: At the roundabout, take the 2nd exit onto road 1', 'via: Waypoint 1']);
  });

  test('a waypoint is its own instruction', () => {
    const coords: LonLat[] = [[0, 0], [0, 0.002], [0, 0.004]];
    const ms = maneuvers(coords, [seg(0, '1'), seg(1, '1', { via: 1 })], 'X');
    expect(kinds(ms)[1]).toBe('via: Waypoint 1');
    expect(Math.round(ms[1].along)).toBe(222);
  });
});

describe('Progress', () => {
  // 0 → 222 m north (road 1, 20 s), then 222 m west (road 26, 60 s).
  const coords: LonLat[] = [[0, 0], [0, 0.002], [-0.002, 0.002]];
  const segs = [seg(0, '1', { seconds: 20 }), seg(1, '26', { seconds: 60 })];

  test('the nearest point along the route and how far off it you are', () => {
    const p = new Progress(coords, segs, 80);
    const w = p.locate([0.0005, 0.001]); // 55 m east of the first stretch, halfway up
    expect(Math.round(w.along)).toBe(111);
    expect(Math.round(w.off)).toBe(56);
  });

  test('distance and time left, from the road stretches\' times', () => {
    const p = new Progress(coords, segs, 80);
    const half = p.left(111.2);
    expect(Math.round(half.metres)).toBe(334);
    expect(Math.round(half.seconds)).toBe(70); // half of road 1 (10 s) + road 26 (60 s)
    expect(p.left(p.total).seconds).toBe(0);
  });

  test('a hairpin: a fix between the two sides stays on the side you were on', () => {
    // North 555 m, 33 m east, back south 555 m: the two sides 33 m apart.
    const hair: LonLat[] = [[0, 0], [0, 0.005], [0.0003, 0.005], [0.0003, 0]];
    const p = new Progress(hair, undefined, 100);
    p.locate([0, 0.0025]);
    // 18 m from the way up, 15 m from the way down: still on the way up.
    const w = p.locate([0.000162, 0.0026]);
    expect(Math.round(w.along)).toBe(289);
  });

  test('the same as the plain search along every stretch, on the route and off it', () => {
    // A winding 3,000-point route near 64°N with a hairpin, repeated points and fixes on it, near
    // it, far off it (the whole-route search) and back.
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const route: LonLat[] = [[-20, 64]];
    for (let i = 1; i < 3000; i++) {
      const [x, y] = route[i - 1];
      if (i % 97 === 0) route.push([x, y]);
      else route.push([x + 0.0006 * Math.cos(i / 150) + (rnd() - 0.5) * 0.0002, y + (i < 1500 ? 0.0003 : -0.00029) + (rnd() - 0.5) * 0.0002]);
    }
    const segs = [seg(0, 'a', { seconds: 300 }), seg(1200, 'b', { seconds: 900 }), seg(2500, 'c', { seconds: 100 })];
    const now = new Progress(route, segs, 1300);
    const before = new OldProgress(route, segs, 1300);
    for (let f = 0; f < 600; f++) {
      const i = Math.min(route.length - 1, Math.floor(f * 5 + rnd() * 3));
      const far = f % 50 > 40 ? 0.01 + rnd() * 0.05 : f % 7 === 0 ? 0.0012 : 0.00005;
      const fix: LonLat = [route[i][0] + (rnd() - 0.5) * far, route[i][1] + (rnd() - 0.5) * far];
      const w = now.locate(fix);
      expect(w).toEqual(before.locate(fix));
      for (const d of [-50, 0, 0.5, 120, 10_000]) {
        expect(now.left(w.along + d)).toEqual(before.left(w.along + d));
        expect(now.pointAt(w.along + d)).toEqual(before.pointAt(w.along + d));
      }
    }
    for (const along of [-1, 0, now.total, now.total + 1, now.cum[97], now.cum[98]]) {
      expect(now.left(along)).toEqual(before.left(along));
      expect(now.pointAt(along)).toEqual(before.pointAt(along));
    }
    const one = new Progress([[0, 0]], undefined, 0);
    const oneBefore = new OldProgress([[0, 0]], undefined, 0);
    expect(one.locate([0.001, 0])).toEqual(oneBefore.locate([0.001, 0]));
    expect(one.left(0)).toEqual(oneBefore.left(0));
    expect(one.pointAt(0)).toEqual(oneBefore.pointAt(0));
  });
});
