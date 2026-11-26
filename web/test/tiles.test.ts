import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RawObject } from '../src/img/rgn';
import { shiftOf, subdivisionBounds } from '../src/img/tre';
import { decodeAll } from '../src/map/decodeAll';
import { emptyTyp, parseTyp } from '../src/img/typ';
import { GarminMap } from '../src/map/garminMap';
import { CONTOUR_LINE_TYPES } from '../src/map/zoom';
import { buildStyle } from '../src/style/buildStyle';
import { isLineLayer, styledLineTypes } from '../src/style/sourceLayers';
import { buildTile, coordsBounds, dedupeLabels, paddedSubdivisionBounds, polygonLabelAnchor, simplifyLine, stitchLines, subPixel, SubdivisionCache } from '../src/tiles/buildTile';
import { latToTileY, lonToTileX, tileBounds } from '../src/tiles/tileMath';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

describe('tile math', () => {
  test('world tile and round trip', () => {
    const [w, s, e, n] = tileBounds(0, 0, 0);
    expect([w, e]).toEqual([-180, 180]);
    expect(n).toBeCloseTo(85.0511, 3);
    expect(s).toBeCloseTo(-85.0511, 3);
    const [tw, ts] = tileBounds(15, 14387, 7890);
    expect(lonToTileX(tw + 1e-9, 15)).toBe(14387);
    expect(latToTileY(ts + 1e-9, 15)).toBe(7890);
  });
});

describe('dedupeLabels', () => {
  type F = Parameters<typeof dedupeLabels>[0][number];
  type Info = NonNullable<ReturnType<Parameters<typeof dedupeLabels>[1]>>;
  const labelPoint = (name: string, x = 0, t = 0x3c): F => ({ type: 1, geometry: [[x, 0]], tags: { t, name } });
  const names = (fs: F[]) => fs.map((f) => f.tags.name ?? null);
  const box = (x0: number, x1: number): Info['bbox'] => [x0, 0, x1, 10];

  test('keeps only the label of the largest of touching same-named pieces', () => {
    // One lake that Garmin split into three pieces sharing edges, plus another name.
    const fs = [labelPoint('Þingvallavatn'), labelPoint('Þingvallavatn'), labelPoint('Þingvallavatn'), labelPoint('Hestvík')];
    const info = new Map<F, Info>([
      [fs[0], { size: 10, bbox: box(0, 10) }],
      [fs[1], { size: 50, bbox: box(10, 20) }],
      [fs[2], { size: 20, bbox: box(20, 30) }],
      [fs[3], { size: 1, bbox: box(0, 1) }],
    ]);
    dedupeLabels(fs, (f) => info.get(f));
    expect(names(fs)).toEqual([null, 'Þingvallavatn', null, 'Hestvík']);
  });

  test('keeps every label of same-named buildings that do not touch (house numbers on different streets)', () => {
    const fs = [labelPoint('36', 0, 0x13), labelPoint('36', 100, 0x13), labelPoint('36', 200, 0x13)];
    const info = new Map<F, Info>([
      [fs[0], { size: 5, bbox: box(0, 5) }],
      [fs[1], { size: 6, bbox: box(100, 105) }],
      [fs[2], { size: 7, bbox: box(200, 205) }],
    ]);
    dedupeLabels(fs, (f) => info.get(f));
    expect(names(fs)).toEqual(['36', '36', '36']);
  });

  test('merges nearby same-named areas even when they do not touch (a wide river in pieces)', () => {
    // Pieces of one river polygon with gaps between them: near each other, but not touching.
    const fs = [labelPoint('Blanda', 0, 0x48), labelPoint('Blanda', 900, 0x48), labelPoint('Blanda', 1800, 0x48), labelPoint('Blanda', 4000, 0x48)];
    const info = new Map<F, Info>([
      [fs[0], { size: 5, bbox: box(0, 5) }],
      [fs[1], { size: 9, bbox: box(100, 105) }],
      [fs[2], { size: 7, bbox: box(200, 205) }],
      [fs[3], { size: 1, bbox: box(300, 305) }],
    ]);
    dedupeLabels(fs, (f) => info.get(f));
    // 0-900-1800 chain within half a tile of each other; 4000 is 2200 away from the nearest.
    expect(names(fs)).toEqual([null, 'Blanda', null, 'Blanda']);
  });

  test('a larger piece just outside the tile (context) suppresses the label here, and is not emitted', () => {
    const own = [labelPoint('Blanda', 4000, 0x48)];
    const ctx = [labelPoint('Blanda', 4500, 0x48)]; // across the tile edge, in the neighbour tile
    const info = new Map<F, Info>([[own[0], { size: 3, bbox: box(0, 5) }], [ctx[0], { size: 8, bbox: box(100, 105) }]]);
    dedupeLabels(own, (f) => info.get(f), ctx);
    expect(names(own)).toEqual([null]);
    expect(names(ctx)).toEqual(['Blanda']);
    // And the neighbour, seeing the same two pieces the other way round, keeps its own.
    const own2 = [labelPoint('Blanda', 404, 0x48)];
    const ctx2 = [labelPoint('Blanda', -96, 0x48)];
    const info2 = new Map<F, Info>([[own2[0], { size: 8, bbox: box(100, 105) }], [ctx2[0], { size: 3, bbox: box(0, 5) }]]);
    dedupeLabels(own2, (f) => info2.get(f), ctx2);
    expect(names(own2)).toEqual(['Blanda']);
  });
});

describe('stitchLines', () => {
  type F = Parameters<typeof stitchLines>[0][number];
  const line = (t: number, name: string | undefined, ...parts: Array<Array<[number, number]>>): F =>
    ({ type: 2, geometry: parts, tags: name ? { t, name } : { t } });

  test('joins touching pieces of the same named line into one continuous line', () => {
    const out = stitchLines([
      line(0x1f, 'Þjórsá', [[20, 0], [30, 0]]),
      line(0x1f, 'Þjórsá', [[0, 0], [10, 0]]),
      line(0x1f, 'Þjórsá', [[20, 0], [10, 0]]), // reversed piece in the middle
      line(0x1f, 'Þjórsá', [[50, 50], [60, 50]]), // not touching: stays a separate part
    ]);
    expect(out).toHaveLength(1);
    const parts = out[0].geometry as Array<Array<[number, number]>>;
    expect(parts).toHaveLength(2);
    const chain = parts.find((p) => p.length === 4)!;
    const xs = chain.map((pt) => pt[0]);
    expect(xs[0] === 0 ? xs : [...xs].reverse()).toEqual([0, 10, 20, 30]);
    expect(out[0].tags).toEqual({ t: 0x1f, name: 'Þjórsá' });
  });

  test('keeps different names, different types, named and unnamed, and contours apart', () => {
    const fs = [
      line(0x1f, 'Þjórsá', [[0, 0], [10, 0]]),
      line(0x18, 'Þjórsá', [[10, 0], [20, 0]]),
      line(0x1f, 'Hvítá', [[10, 0], [20, 0]]),
      line(0x1f, undefined, [[0, 0], [10, 0]]),
      line(0x18, undefined, [[10, 0], [20, 0]]),
      line(0x20, '400', [[0, 0], [10, 0]]),
      line(0x20, '400', [[10, 0], [20, 0]]),
      line(0x20, undefined, [[0, 5], [10, 5]]),
      line(0x20, undefined, [[10, 5], [20, 5]]),
    ];
    expect(stitchLines(fs)).toHaveLength(fs.length);
  });

  test('joins the unnamed pieces of a type too (a big town\'s streets come as thousands of 2-pixel pieces)', () => {
    const out = stitchLines([
      line(0x10107, undefined, [[0, 0], [10, 0]]),
      line(0x10107, undefined, [[20, 0], [10, 0]]),
      line(0x10107, undefined, [[20, 0], [20, 10]]),
      line(0x10107, undefined, [[100, 100], [110, 100]]), // another street: a part of its own
      line(0x10107, 'Vestergade', [[20, 10], [20, 20]]), // named: not joined to the unnamed ones
    ]);
    expect(out).toHaveLength(2);
    const unnamed = out.find((f) => f.tags.name === undefined)!;
    expect(unnamed.tags).toEqual({ t: 0x10107 });
    const parts = unnamed.geometry as Array<Array<[number, number]>>;
    expect(parts.map((p) => p.length).sort()).toEqual([2, 4]);
    const chain = parts.find((p) => p.length === 4)!;
    expect(chain[0][0] === 0 ? chain : [...chain].reverse()).toEqual([[0, 0], [10, 0], [20, 0], [20, 10]]);
  });
});

describe('subPixel', () => {
  test('geometry within one screen pixel (8 tile units) is sub-pixel; wider or taller is not', () => {
    expect(subPixel([[[100, 100], [107, 103], [101, 107]]])).toBe(true);
    expect(subPixel([[[100, 100], [108, 100]]])).toBe(false);
    expect(subPixel([[[100, 100], [100, 101]], [[100, 100], [100, 120]]])).toBe(false);
  });
});

describe('simplifyLine', () => {
  test('drops points within the tolerance of the simplified line, keeps the ends and real bends', () => {
    const line: Array<[number, number]> = [[0, 0], [100, 10], [200, -10], [300, 0], [400, 500], [500, 0]];
    expect(simplifyLine(line, 64)).toEqual([[0, 0], [300, 0], [400, 500], [500, 0]]);
    expect(simplifyLine(line, 5)).toEqual(line);
    expect(simplifyLine([[0, 0], [1, 1]], 64)).toEqual([[0, 0], [1, 1]]);
  });
});

describe('polygonLabelAnchor', () => {
  const inside = ([x, y]: [number, number], ring: Array<[number, number]>) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  test('a convex polygon is labelled at its centroid', () => {
    expect(polygonLabelAnchor([[0, 0], [10, 0], [10, 10], [0, 10]])).toEqual([5, 5]);
  });

  test('a concave polygon whose centroid falls outside is labelled inside it', () => {
    // A "U": two 2-wide arms joined by a base; the centroid lies in the empty gap between the arms.
    const u: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [8, 10], [8, 2], [2, 2], [2, 10], [0, 10]];
    const a = polygonLabelAnchor(u);
    expect(inside(a, u)).toBe(true);
  });
});

describe('SubdivisionCache', () => {
  const objs = (n: number): RawObject[] => [
    { kind: 'line', type: 0, label: 0, labelSrc: 'lbl', coords: Array.from({ length: n }, () => [0, 0]) },
  ];

  test('evicts least-recently-used entries once the total point budget is exceeded', async () => {
    const cache = new SubdivisionCache(10);
    const calls: Record<string, number> = {};
    const load = (key: string, n: number) => async () => {
      calls[key] = (calls[key] ?? 0) + 1;
      return objs(n);
    };
    await cache.get('a', load('a', 6));
    await cache.get('b', load('b', 6)); // total 12 > budget 10: evicts the LRU entry ('a')
    await cache.get('a', load('a', 6)); // must reload: was evicted
    expect(calls).toEqual({ a: 2, b: 1 });
  });

  test('concurrent get() of the same key shares one in-flight decode', async () => {
    const cache = new SubdivisionCache();
    let decodeCalls = 0;
    const load = async () => {
      decodeCalls++;
      await Promise.resolve(); // force a microtask gap, like a real fetch+decode would
      return objs(3);
    };
    const [r1, r2] = await Promise.all([cache.get('x', load), cache.get('x', load)]);
    expect(decodeCalls).toBe(1);
    expect(r1).toBe(r2); // one decode, its result shared by both callers
  });

  test('a rejected decode is not cached', async () => {
    const cache = new SubdivisionCache();
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('boom');
    };
    await expect(cache.get('x', failing)).rejects.toThrow('boom');
    await expect(cache.get('x', failing)).rejects.toThrow('boom');
    expect(calls).toBe(2); // not cached: the second get() retried instead of replaying the rejection
  });
});

function decode(data: Uint8Array) {
  const vt = new VectorTile(new PbfReader(data));
  const out: Array<{ layer: string; type: number; name?: string; t: number; geom: Array<Array<{ x: number; y: number }>> }> = [];
  for (const layer of Object.keys(vt.layers)) {
    const l = vt.layers[layer];
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      out.push({ layer, type: f.type, name: f.properties.name as string | undefined, t: f.properties.t as number, geom: f.loadGeometry() });
    }
  }
  return out;
}

describe.skipIf(!hasRealData)('buildTile on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    map = await GarminMap.open(src);
  }, 60_000);
  afterAll(() => src.close());

  test('Tjörnin tile at z14 has the lake name and clipped geometry', async () => {
    const z = 14;
    const [x, y] = [lonToTileX(-21.9416, z), latToTileY(64.1445, z)];
    const { data, badSections } = await buildTile(map, new SubdivisionCache(500), z, x, y);
    const feats = decode(data);
    expect(badSections).toBe(0);
    expect(feats.length).toBeGreaterThan(100);
    expect(feats.some((f) => f.name?.toLowerCase() === 'tjörnin')).toBe(true);
    for (const f of feats) for (const ring of f.geom) for (const p of ring) {
      expect(p.x).toBeGreaterThanOrEqual(-64);
      expect(p.x).toBeLessThanOrEqual(4160);
      expect(p.y).toBeGreaterThanOrEqual(-64);
      expect(p.y).toBeLessThanOrEqual(4160);
    }
  });

  test('highland tiles at z7-8 carry the F-roads from the finer level, but not at z6', async () => {
    const fRoads = async (z: number) => {
      const [x, y] = [lonToTileX(-19.0, z), latToTileY(64.05, z)];
      const feats = decode((await buildTile(map, new SubdivisionCache(), z, x, y)).data);
      return feats.filter((f) => isLineLayer(f.layer) && f.layer !== 'line-names' && /^F\d+/.test(f.name ?? '')).length;
    };
    expect(await fRoads(8)).toBeGreaterThan(0);
    expect(await fRoads(7)).toBeGreaterThan(0);
    expect(await fRoads(6)).toBe(0);
  });

  test('neighbouring tiles never repeat an area label within half a tile of each other', async () => {
    // 3x3 blocks where Garmin splits rivers/areas into many pieces (HÖFÐAR at z9, Blanda at z7).
    for (const [z, lon, lat] of [[9, -22.4, 64.55], [7, -19.75, 65.25], [11, -19.06, 64.0]] as const) {
      const cache = new SubdivisionCache();
      const [cx, cy] = [lonToTileX(lon, z), latToTileY(lat, z)];
      const labels: Array<{ name: string; x: number; y: number; tile: string }> = [];
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let y = cy - 1; y <= cy + 1; y++) {
          for (const f of decode((await buildTile(map, cache, z, x, y)).data)) {
            if (f.layer !== 'area-labels' || !f.name || f.geom[0].length !== 1 || /^\d/.test(f.name)) continue;
            const p = f.geom[0][0];
            labels.push({ name: f.name, x: x * 4096 + p.x, y: y * 4096 + p.y, tile: `${x},${y}` });
          }
        }
      }
      const close = labels.flatMap((a, i) => labels.slice(i + 1)
        .filter((b) => a.name === b.name && a.tile !== b.tile && Math.hypot(a.x - b.x, a.y - b.y) < 2048)
        .map((b) => `z${z} ${a.name} ${a.tile}/${b.tile}`));
      expect(close).toEqual([]);
    }
  }, 120_000);

  test('each line and area type has a source layer of its own, labels and contours apart', async () => {
    const z = 12;
    const typ = map.typ ? parseTyp(map.typ) : emptyTyp();
    const styled = styledLineTypes(typ);
    const { style } = buildStyle(typ, { tiles: '', glyphs: '' });
    // Reykjavík (streets, areas, area labels) and Landmannalaugar (contours).
    for (const [lon, lat] of [[-21.94, 64.146], [-19.06, 63.99]]) {
      const feats = decode((await buildTile(map, new SubdivisionCache(), z, lonToTileX(lon, z), latToTileY(lat, z))).data);
      const layers = new Set(feats.map((f) => f.layer));
      const named = new Map<string, number>();
      for (const f of feats) {
        if (/^l\d+$/.test(f.layer)) {
          expect(f.layer).toBe(`l${f.t}`);
          expect(styled.has(f.t) && !CONTOUR_LINE_TYPES.has(f.t)).toBe(true);
        } else if (f.layer === 'l-other') expect(styled.has(f.t)).toBe(false);
        else if (f.layer === 'contours') expect(CONTOUR_LINE_TYPES.has(f.t)).toBe(true);
        else if (/^p\d+$/.test(f.layer)) {
          expect(f.layer).toBe(`p${f.t}`);
          expect(f.type).toBe(3);
        } else if (f.layer === 'area-labels') {
          expect(f.type).toBe(1);
          expect(f.name).toBeTruthy();
        } else if (f.layer !== 'line-names') expect(f.layer).toBe('points');
        if (f.name && isLineLayer(f.layer) && !['line-names', 'contours'].includes(f.layer)) {
          const k = `${f.name}|${JSON.stringify(f.geom)}`;
          named.set(k, (named.get(k) ?? 0) + 1);
        }
      }
      // The label copy: the same named lines, with the same geometry.
      const copy = feats.filter((f) => f.layer === 'line-names');
      expect(copy.length).toBeGreaterThan(0);
      for (const f of copy) {
        const k = `${f.name}|${JSON.stringify(f.geom)}`;
        expect(named.get(k)).toBeGreaterThan(0);
        named.set(k, named.get(k)! - 1);
      }
      expect([...named.values()].every((n) => n === 0)).toBe(true);
      // Every layer of the tiles that has a style layer is one the style draws from.
      const drawnFrom = new Set(style.layers.map((l) => (l as { 'source-layer'?: string })['source-layer']));
      for (const name of layers) if (name !== 'l-other' && !/^[lp]\d+$/.test(name)) expect(drawnFrom.has(name)).toBe(true);
      expect(layers.has(lon < -20 ? 'area-labels' : 'contours')).toBe(true);
    }
  });

  test('a tile far out at sea is empty', async () => {
    const z = 10;
    const { features } = await buildTile(map, new SubdivisionCache(10), z, lonToTileX(-30, z), latToTileY(60, z));
    expect(features).toBe(0);
  });

  test('subdivision pre-filter margin covers every decoded object (real data)', async () => {
    // Evidence for SD_MARGIN: for every decoded object, how far does its bounding box extend
    // beyond its subdivision's declared bounds, as a fraction of that subdivision's half-extent
    // (per axis)? Track the max per level bits, then confirm every object's box still falls
    // within paddedSubdivisionBounds (the pre-filter's actual margin), proving the margin covers
    // the real data.
    const overshootByLevel = new Map<number, number>();
    let violations = 0;
    await decodeAll(map, (_tile, sd, obj) => {
      const k = 2 ** shiftOf(sd);
      const halfW = sd.halfWidth * k;
      const halfH = sd.halfHeight * k;
      const [sw, ss, se, sn] = subdivisionBounds(sd);
      const [objW, objS, objE, objN] = coordsBounds(obj.coords);
      const overX = Math.max(0, sw - objW, objE - se);
      const overY = Math.max(0, ss - objS, objN - sn);
      const fracX = halfW > 0 ? overX / halfW : overX > 0 ? Infinity : 0;
      const fracY = halfH > 0 ? overY / halfH : overY > 0 ? Infinity : 0;
      overshootByLevel.set(sd.level.bits, Math.max(overshootByLevel.get(sd.level.bits) ?? 0, fracX, fracY));

      const [pw, ps, pe, pn] = paddedSubdivisionBounds(sd);
      if (objW < pw || objE > pe || objS < ps || objN > pn) violations++;
    });
    const rows = [...overshootByLevel]
      .sort((a, b) => a[0] - b[0])
      .map(([bits, frac]) => `  level ${bits}: ${frac.toFixed(4)}`);
    console.log('\nmax overshoot fraction of half-extent, per level bits:\n' + rows.join('\n'));
    expect(violations).toBe(0);
  }, 120_000);

  test('timings (spike measurement)', async () => {
    const around = (lon: number, lat: number, z: number) => {
      const [cx, cy] = [lonToTileX(lon, z), latToTileY(lat, z)];
      return [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [z, cx + dx, cy + dy] as const));
    };
    const cases: Record<string, ReadonlyArray<readonly [number, number, number]>> = {
      'Reykjavík z14': around(-21.94, 64.146, 14),
      'Reykjavík z12': around(-21.94, 64.146, 12),
      'Landmannalaugar z13': around(-19.06, 63.99, 13),
      'Vatnajökull z10': around(-16.9, 64.02, 10),
      'Iceland z6': around(-18.6, 64.9, 6),
    };
    const rows: string[] = [];
    for (const [label, tiles] of Object.entries(cases)) {
      // Fresh cache per case: the first build is a genuine cold (cache-empty) build, not the
      // fastest of the batch. The shared GarminMap stays open (opening it is a once-per-app cost).
      // Default budget: this measures warm-cache reuse across the 3x3 neighbourhood, which a
      // tiny point budget would defeat by evicting subdivisions before the next tile reuses them.
      const cache = new SubdivisionCache();
      const ms: number[] = [];
      for (const [z, x, y] of tiles) {
        const t0 = performance.now();
        await buildTile(map, cache, z, x, y);
        ms.push(performance.now() - t0);
      }
      const cold = ms[0];
      const sorted = [...ms].sort((a, b) => a - b);
      const p50 = sorted[4];
      const max = sorted[8];
      rows.push(`${label.padEnd(22)} cold ${cold.toFixed(0).padStart(5)}  p50 ${p50.toFixed(0).padStart(5)}  max ${max.toFixed(0).padStart(5)} ms`);
      expect(max).toBeLessThan(5000);
    }
    console.log('\n' + rows.join('\n'));
  }, 300_000);
});
