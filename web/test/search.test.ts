import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GarminMap } from '../src/map/garminMap';
import type { RoadClasses } from '../src/routing/roadClass';
import { nearName, townsOf } from '../src/search/describe';
import { NearIndex } from '../src/search/nearIndex';
import { normalize } from '../src/search/normalize';
import { columnsFromPlaces, decodeColumns, encodeColumns, PlaceStore } from '../src/search/placeStore';
import { bboxCenter, collectIndex, type Place } from '../src/search/places';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData, REPO } from './helpers/paths';
import { OldPlaceIndex } from './helpers/placeIndex';

const storeOf = (places: Place[], roads: RoadClasses = {}) => new PlaceStore(columnsFromPlaces(places, roads));

describe('normalize', () => {
  test('Icelandic letters and diacritics', () => {
    expect(normalize('Þórsmörk')).toBe('thorsmork');
    expect(normalize('Hvannadalshnúkur')).toBe('hvannadalshnukur');
    expect(normalize('ÆGISÍÐA')).toBe('aegisida');
    expect(normalize('  Fjallabak-syðra ')).toBe('fjallabak sydra');
  });
});

describe('PlaceStore', () => {
  const idx = storeOf([
    { name: 'Laugavegur', lon: 0, lat: 0, kind: 'line', type: 0x16 },
    { name: 'Landmannalaugar', lon: 1, lat: 1, kind: 'point', type: 0x2f06 },
    { name: 'Landmannalaugar', lon: 1, lat: 1, kind: 'polygon', type: 0x13 },
    { name: 'Hveragerði', lon: 2, lat: 2, kind: 'point', type: 0x0400 },
    { name: 'Efri Laugar', lon: 3, lat: 3, kind: 'point', type: 0x0400 },
  ]);

  test('prefix beats word-prefix beats substring; points first', () => {
    expect(idx.search('lau').map((p) => [p.name, p.kind])).toEqual([
      ['Laugavegur', 'line'],
      ['Efri Laugar', 'point'],
      ['Landmannalaugar', 'point'],
      ['Landmannalaugar', 'polygon'],
    ]);
    expect(idx.search('landm')[0]).toMatchObject({ name: 'Landmannalaugar', kind: 'point' });
    expect(idx.search('hverag')[0].name).toBe('Hveragerði');
    expect(idx.search('')).toEqual([]);
    expect(idx.search('la', 2)).toHaveLength(2);
  });

  test('words: a later word, a query of several words, and a word start after a mid-word match', () => {
    const streets = storeOf([
      { name: 'Hveragerði', lon: 2, lat: 2, kind: 'point', type: 0x0400 },
      { name: 'Nýja Vestur Gata', lon: 0, lat: 0, kind: 'point', type: 0x0400 },
      { name: 'Vesturgata', lon: 0, lat: 0, kind: 'point', type: 0x0400 },
      { name: 'Barbara Bar', lon: 0, lat: 0, kind: 'point', type: 0x0400 },
    ]);
    // Several words match from a word's start, like one word (ahead of names that only contain it).
    expect(streets.search('vestur g').map((p) => p.name)).toEqual(['Nýja Vestur Gata']);
    expect(streets.search('ga').map((p) => p.name)).toEqual(['Nýja Vestur Gata']); // two letters: word starts only
    expect(streets.search('gat').map((p) => p.name)).toEqual(['Nýja Vestur Gata', 'Vesturgata']);
    expect(streets.search('ba').map((p) => p.name)).toEqual(['Barbara Bar']);
    expect(streets.search('bar b').map((p) => p.name)).toEqual([]);
    expect(streets.search('ra b').map((p) => p.name)).toEqual(['Barbara Bar']); // inside the name: 3+ letters
  });

  test('with a reference point, equally good matches within 25 km come first, nearest first', () => {
    const near = storeOf([
      { name: 'Svartá', lon: -15, lat: 65, kind: 'line', type: 0x1f },
      { name: 'Svartá', lon: -20, lat: 65, kind: 'line', type: 0x1f },
      { name: 'Svartá', lon: -19.7, lat: 65, kind: 'line', type: 0x1f },
      { name: 'Svartárkot', lon: -19.9, lat: 65, kind: 'point', type: 0x6402 },
      { name: 'Svartárdalur', lon: -14, lat: 65, kind: 'point', type: 0x640a },
    ]);
    // Exact "Svartá" first: within 25 km -20 (0 km), -19.7 (~14 km), then far -15; then the longer
    // names: nearby Svartárkot (~5 km), then far Svartárdalur.
    expect(near.search('svarta', 20, [-20, 65]).map((p) => p.lon)).toEqual([-20, -19.7, -15, -19.9, -14]);
    expect(near.search('svarta').map((p) => p.lon)).toEqual([-19.9, -14, -15, -20, -19.7]); // no reference: unchanged
  });

  test('with a reference point, exact name matches come first, towns before other exact matches', () => {
    const idx = storeOf([
      { name: 'Reykjavíkurtjörn', lon: -21.94, lat: 64.144, kind: 'polygon', type: 0x41 },
      { name: 'Reykjavíkurhöfn', lon: -21.93, lat: 64.15, kind: 'point', type: 0x650b },
      { name: 'REYKJAVÍK', lon: -21.89, lat: 64.13, kind: 'point', type: 0x0700 },
      { name: 'Reykjavík', lon: -21.93, lat: 64.14, kind: 'point', type: 0x6402 }, // a farm, nearer than the town
    ]);
    expect(idx.search('reykjavik', 20, [-21.94, 64.144]).map((p) => [p.name, p.type])).toEqual([
      ['REYKJAVÍK', 0x0700], ['Reykjavík', 0x6402], ['Reykjavíkurtjörn', 0x41], ['Reykjavíkurhöfn', 0x650b],
    ]);
  });
});

describe('PlaceStore matches a naive full sort', () => {
  const KIND_RANK = { point: 0, polygon: 1, line: 2 } as const;
  // The pre-optimization implementation: score every entry, sort all hits, slice.
  function naive(places: Place[], query: string, limit = 20): Place[] {
    const q = normalize(query);
    if (!q) return [];
    const hits: Array<[number, number, number, string, Place]> = [];
    for (const place of places) {
      const norm = normalize(place.name);
      let score: number;
      if (norm.startsWith(q)) score = 0;
      else if (norm.split(' ').some((w) => w.startsWith(q))) score = 1;
      else if (q.length >= 3 && norm.includes(q)) score = 2;
      else continue;
      hits.push([score, KIND_RANK[place.kind], norm.length, place.name, place]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]));
    return hits.slice(0, limit).map((h) => h[4]);
  }

  // Deterministic pseudo-random names from a small syllable set, so many names share prefixes,
  // word prefixes and substrings, with duplicates (same name and kind at different coordinates).
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const syll = ['lau', 'gar', 'hvera', 'fjall', 'dalur', 'á', 'þór', 'mörk', 'vík', 'reykja', 'foss', 'nes', 'Lau', 'Ey'];
  const word = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => syll[Math.floor(rand() * syll.length)]).join('');
  const kinds = ['point', 'line', 'polygon'] as const;
  const places: Place[] = Array.from({ length: 5000 }, (_, i) => ({
    name: Array.from({ length: 1 + Math.floor(rand() * 3) }, word).join(rand() < 0.2 ? '-' : ' '),
    lon: i,
    lat: i ? -i : 0, // not -0: the columns keep whole 1e-5 degrees
    kind: kinds[Math.floor(rand() * 3)],
    type: i,
  }));
  const idx = storeOf(places);

  test.each(['lau', 'la', 'gar', 'hveragerdi', 'thor', 'fjalld', 'ik', 'vik', 'foss nes', 'ey', 'dalu', 'zzz', 'a', 'mork'])('query %s', (q) => {
    for (const limit of [1, 5, 20, 100, 10_000]) {
      expect(idx.search(q, limit)).toEqual(naive(places, q, limit));
    }
    expect(idx.search(q)).toEqual(naive(places, q));
  });
});

describe('bboxCenter', () => {
  test('does not overflow the call stack on large coordinate arrays', () => {
    const coords: Array<[number, number]> = Array.from({ length: 200_000 }, (_, i) => [i, -i]);
    expect(() => bboxCenter(coords)).not.toThrow();
    expect(bboxCenter(coords)).toEqual([99999.5, -99999.5]);
  });

  test('midpoint of a small bounding box', () => {
    expect(bboxCenter([[0, 0], [10, 4], [2, -6]])).toEqual([5, -1]);
  });
});

describe('the place cache file', () => {
  const places: Place[] = [
    { name: 'Landmannalaugar', lon: -19.06, lat: 63.99, kind: 'point', type: 0x2f06 },
    { name: 'Laugavegur', lon: 0, lat: 0, kind: 'line', type: 0x16 },
    { name: 'Dettifoss', lon: -16.38, lat: 65.81, kind: 'point', type: 0x6508, what: 'Waterfall' },
    { name: 'Þórsmörk', lon: -19.5, lat: 63.68, kind: 'polygon', type: 0x0d, what: 'Waterfall' },
  ];
  const roads: RoadClasses = { t1: [[5, 1], [8, 2]], t2: [[12, 3]] };
  const bytes = encodeColumns('key', columnsFromPlaces(places, roads));

  test('round trip: every place, its road classes and the same search', () => {
    const cols = decodeColumns(bytes.slice().buffer, 'key');
    expect(cols).not.toBeNull();
    const store = new PlaceStore(cols!);
    expect(Array.from({ length: store.size }, (_, i) => store.place(i))).toEqual(places);
    expect(cols!.roads).toEqual(roads);
    expect(store.search('lau')).toEqual(new OldPlaceIndex(places).search('lau'));
  });

  test('another map, another version or a cut-short file is a miss', () => {
    expect(decodeColumns(bytes.slice().buffer, 'other')).toBeNull();
    expect(decodeColumns(bytes.slice(0, bytes.length - 4).buffer, 'key')).toBeNull();
    const v2 = bytes.slice();
    v2[4] = 2;
    expect(decodeColumns(v2.buffer, 'key')).toBeNull();
    expect(decodeColumns(new ArrayBuffer(0), 'key')).toBeNull();
  });

  test('an empty map', () => {
    const store = new PlaceStore(decodeColumns(encodeColumns('k', columnsFromPlaces([], {})).buffer as ArrayBuffer, 'k')!);
    expect(store.search('a', 20, [0, 0])).toEqual([]);
    expect(store.towns()).toEqual([]);
    expect(new NearIndex(store.namedPoints()).nearName([0, 0])).toBeUndefined();
  });
});

/** Queries from the map's own names: prefixes of 1-6 letters, whole names, a later word, a piece
 *  from the middle, two words; plus a few fixed ones. */
function queriesFrom(places: Place[], count: number): string[] {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out = new Set(['a', 'e', 's', 'aa', 've', 'hekla', 'reykjav', 'thor', 'vegur', 'kirke', 'kobenhavn', 'gade', 'zzzq', 'st ', '1']);
  while (out.size < count) {
    const n = normalize(places[Math.floor(rand() * places.length)].name);
    if (!n) continue;
    const words = n.split(' ');
    const pick = Math.floor(rand() * 6);
    if (pick === 0) out.add(n);
    else if (pick === 1) out.add(n.slice(0, 1 + Math.floor(rand() * 6)));
    else if (pick === 2) out.add(words[words.length - 1].slice(0, 2 + Math.floor(rand() * 4)));
    else if (pick === 3 && n.length > 6) out.add(n.slice(2, 5 + Math.floor(rand() * 3)));
    else if (pick === 4 && words.length > 1) out.add(words.slice(0, 2).join(' '));
    else out.add(n.slice(0, 3));
  }
  return [...out];
}

/** The new search, towns and "Near X" against the old ones on a whole map's places. */
function compareOnRealData(label: string, load: () => Promise<Place[]>, refs: Array<[number, number]>, queries: number, spots: number) {
  let places: Place[];
  let old: OldPlaceIndex;
  let store: PlaceStore;
  beforeAll(async () => {
    places = await load();
    old = new OldPlaceIndex(places);
    store = new PlaceStore(decodeColumns(encodeColumns('k', columnsFromPlaces(places, {})).buffer as ArrayBuffer, 'k')!);
  }, 600_000);

  test(`${label}: the same results as before, with and without a reference point`, () => {
    for (const q of queriesFrom(places, queries)) {
      expect(store.search(q), q).toEqual(old.search(q));
      for (const at of refs) expect(store.search(q, 100, at), `${q} near ${at}`).toEqual(old.search(q, 100, at));
    }
  }, 600_000);

  test(`${label}: the same towns and "Near X" as before`, () => {
    expect(store.towns()).toEqual(townsOf(places));
    const near = new NearIndex(store.namedPoints());
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    // Spots by places (so most have a name within reach) and in between.
    for (let k = 0; k < spots; k++) {
      const p = places[Math.floor(rand() * places.length)];
      const at: [number, number] = [p.lon + (rand() - 0.5) * 0.08, p.lat + (rand() - 0.5) * 0.04];
      expect(near.nearName(at), String(at)).toBe(nearName(places, at));
      expect(near.nearName(at, 0.5), String(at)).toBe(nearName(places, at, 0.5));
    }
    for (const at of refs) expect(near.nearName(at)).toBe(nearName(places, at));
  }, 600_000);
}

describe.skipIf(!hasRealData)('the new search on Iceland', () => {
  compareOnRealData('Iceland', async () => {
    const src = await nodeSource(DETAILED);
    try {
      return (await collectIndex(await GarminMap.open(src))).places;
    } finally {
      await src.close();
    }
  }, [[-21.94, 64.146], [-19.06, 63.99], [-15.2, 64.25], [12.57, 55.68]], 120, 300);
});

const DENMARK = REPO + 'map-files/Freizeitkarte DNK/gmapsupp.img';
describe.skipIf(!existsSync(DENMARK))('the new search on Denmark (617,000 places)', () => {
  compareOnRealData('Denmark', async () => {
    const src = await nodeSource(DENMARK);
    try {
      return (await collectIndex(await GarminMap.open(src))).places;
    } finally {
      await src.close();
    }
  }, [[12.57, 55.68], [10.2, 56.15], [-21.94, 64.146]], 30, 60);
});

describe.skipIf(!hasRealData)('search on real data', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let places: Place[];
  let roads: RoadClasses;
  let idx: PlaceStore;
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    ({ places, roads } = await collectIndex(await GarminMap.open(src)));
    console.log(`places: ${places.length}`);
    idx = storeOf(places);
  }, 300_000);
  afterAll(() => src.close());

  test('collects F-road/track classes for roads across the island', () => {
    const all = Object.values(roads).flat();
    expect(all.length).toBeGreaterThan(3000); // F-roads and tracks across the island
    expect(new Set(all.map(([, c]) => c))).toEqual(new Set([1, 2, 3]));
  });

  test('finds well-known places', () => {
    const lm = idx.search('landmannalaugar')[0];
    expect(Math.abs(lm.lon - -19.06)).toBeLessThan(0.1);
    expect(Math.abs(lm.lat - 63.99)).toBeLessThan(0.1);
    expect(idx.search('thorsmork').some((p) => normalize(p.name) === 'thorsmork')).toBe(true);
    expect(normalize(idx.search('reykjav')[0].name).startsWith('reykjavik')).toBe(true);
  });

  test('coordinates are rounded to 5 decimals', () => {
    const offGrid = (v: number) => Math.abs(v * 1e5 - Math.round(v * 1e5));
    for (const p of places) {
      expect(offGrid(p.lon)).toBeLessThan(1e-6);
      expect(offGrid(p.lat)).toBeLessThan(1e-6);
    }
  });
});
