import { describe, expect, test } from 'vitest';
import type { RoadClasses } from '../src/routing/roadClass';
import type { Place } from '../src/search/places';
import { decodePlacesCache } from '../src/search/placesCache';
import { encodePlacesCache } from './helpers/placeIndex';

const KEY = 'map-key';
const PLACES: Place[] = [
  { name: 'Landmannalaugar', lon: -19.06, lat: 63.99, kind: 'point', type: 0x2f06 },
  { name: 'Laugavegur', lon: 0, lat: 0, kind: 'line', type: 0x16 },
  { name: 'Dettifoss', lon: -16.38, lat: 65.81, kind: 'point', type: 0x6508, what: 'Waterfall' },
];
const ROADS: RoadClasses = { t1: [[5, 1], [8, 2]], t2: [[12, 3]] };

describe('placesCache', () => {
  test('round trip: encode then decode equals the input', () => {
    const text = encodePlacesCache(KEY, PLACES, ROADS);
    expect(decodePlacesCache(text, KEY)).toEqual({ places: PLACES, roads: ROADS });
  });

  test('a valid cache with empty roads {} is accepted', () => {
    const text = encodePlacesCache(KEY, PLACES, {});
    expect(decodePlacesCache(text, KEY)).toEqual({ places: PLACES, roads: {} });
  });

  test('wrong key is a cache miss', () => {
    const text = encodePlacesCache(KEY, PLACES, ROADS);
    expect(decodePlacesCache(text, 'other-key')).toBeNull();
  });

  test('old cache version (v: 1, no roads field) is a cache miss', () => {
    const packed = PLACES.map((p) => [p.name, p.lon, p.lat, ['point', 'line', 'polygon'].indexOf(p.kind), p.type]);
    const text = JSON.stringify({ key: KEY, v: 1, places: packed });
    expect(decodePlacesCache(text, KEY)).toBeNull();
  });

  test('malformed JSON is a cache miss', () => {
    expect(decodePlacesCache('{not json', KEY)).toBeNull();
  });

  test.each([
    ['not an object (a number)', 1],
    ['not an object (a string)', 'nope'],
    ['null', null],
    ['an array', [[5, 1]]],
  ])('roads that is %s invalidates the whole cache', (_desc, roads) => {
    const text = encodePlacesCache(KEY, PLACES, ROADS).replace(JSON.stringify(ROADS), JSON.stringify(roads));
    expect(decodePlacesCache(text, KEY)).toBeNull();
  });

  test('a roads entry that is not an array of pairs invalidates the whole cache', () => {
    const text = encodePlacesCache(KEY, PLACES, ROADS).replace(JSON.stringify(ROADS), JSON.stringify({ t1: 'nope' }));
    expect(decodePlacesCache(text, KEY)).toBeNull();
  });

  test('a pair with a non-number offset invalidates the whole cache', () => {
    const text = encodePlacesCache(KEY, PLACES, ROADS).replace(JSON.stringify(ROADS), JSON.stringify({ t1: [['5', 1]] }));
    expect(decodePlacesCache(text, KEY)).toBeNull();
  });

  test.each([0, 4])('a pair with class %d (out of range) invalidates the whole cache', (cls) => {
    const text = encodePlacesCache(KEY, PLACES, ROADS).replace(JSON.stringify(ROADS), JSON.stringify({ t1: [[5, cls]] }));
    expect(decodePlacesCache(text, KEY)).toBeNull();
  });
});
