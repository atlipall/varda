import { describe, expect, test } from 'vitest';
import { collapseNearby, compass, describePlace, placeCategory, titleCase } from '../src/search/describe';
import { nearName, townsOf } from './helpers/placeIndex';
import { NearIndex } from '../src/search/nearIndex';
import { columnsFromPlaces, PlaceStore } from '../src/search/placeStore';
import type { Place } from '../src/search/places';

const place = (name: string, kind: Place['kind'], type: number, lon = -20, lat = 64): Place => ({ name, kind, type, lon, lat });

describe('placeCategory', () => {
  test('names common Garmin types in plain words', () => {
    expect(placeCategory(place('Blæjuvatn', 'polygon', 0x41))).toBe('Lake');
    expect(placeCategory(place('Blanda', 'polygon', 0x47))).toBe('River');
    expect(placeCategory(place('Selá', 'line', 0x1f))).toBe('River');
    expect(placeCategory(place('Gægir 1214m', 'point', 0x6616))).toBe('Peak');
    expect(placeCategory(place('Garðshorn', 'point', 0x6402))).toBe('Farm or house');
    expect(placeCategory(place('N1 - Hrísey', 'point', 0x2f01))).toBe('Fuel station');
    expect(placeCategory(place('Brekkuvegur', 'line', 0x06))).toBe('Street');
    expect(placeCategory(place('Hólmavík', 'point', 0x0700))).toBe('Town');
    // What the map's label says the place is (Freizeitkarte) comes before the type's own word.
    expect(placeCategory({ ...place('Vínbúðin', 'point', 0x2e0a), what: 'Off licence' })).toBe('Off licence');
  });

  test('F-roads by name, and generic fallbacks by type family and kind', () => {
    expect(placeCategory(place('F225', 'line', 0x12))).toBe('F-road');
    expect(placeCategory(place('Helgaskáli', 'line', 0x12))).toBe('Highland track');
    expect(placeCategory(place('Some diner', 'point', 0x2a09))).toBe('Restaurant');
    expect(placeCategory(place('?', 'point', 0x7777))).toBe('Place');
    expect(placeCategory(place('?', 'polygon', 0x77))).toBe('Area');
  });
});

describe('describePlace', () => {
  const towns = townsOf([
    place('HÓLMAVÍK', 'point', 0x0700, -21.68, 65.705),
    place('BLÖNDUÓS', 'point', 0x0700, -20.28, 65.66),
    place('Garðshorn', 'point', 0x6402, -20.0, 65.0), // not a town
  ]);

  test('in / near / far from the nearest town', () => {
    expect(describePlace(place('Kirkja', 'point', 0x2c0b, -21.682, 65.706), towns).where).toBe('in Hólmavík');
    expect(describePlace(place('Svínavatn', 'polygon', 0x41, -20.1, 65.55), towns).where).toBe('near Blönduós');
    // ~0.9 degrees of latitude south of Blönduós: about 100 km, due south.
    expect(describePlace(place('Hveravellir', 'point', 0x640a, -20.28, 64.76), towns).where).toBe('100 km S of Blönduós');
  });

  test('distance and direction from a reference point', () => {
    const d = describePlace(place('Svínavatn', 'polygon', 0x41, -20.28, 65.75), towns, [-20.28, 65.66]);
    expect(d.distance).toBe('10 km ↑');
    expect(describePlace(place('x', 'point', 0x640a, -20.28, 65.6605), towns, [-20.28, 65.66]).distance).toBe('60 m ↑');
    expect(describePlace(place('x', 'point', 0x640a), towns).distance).toBeNull();
  });

  test('helpers', () => {
    expect(titleCase('BORGARFJÖRÐUR EYSTRI')).toBe('Borgarfjörður Eystri');
    expect(titleCase('LITLI-ÁRSKÓGSSANDUR')).toBe('Litli-Árskógssandur');
    expect(compass(0)).toBe('N');
    expect(compass(44)).toBe('NE');
    expect(compass(181)).toBe('S');
    expect(compass(-90)).toBe('W');
  });
});

describe('collapseNearby', () => {
  test('drops later hits of the same name and category within 15 km (pieces of one river)', () => {
    const hits = [
      place('Svartá', 'line', 0x1f, -19.30, 65.30),
      place('Svartá', 'line', 0x1f, -19.35, 65.32), // same river, ~3 km away
      place('Svartá', 'point', 0x6401, -19.31, 65.30), // a bridge of that name: different category
      place('Svartá', 'line', 0x1f, -16.0, 65.0), // another river far away
    ];
    expect(collapseNearby(hits).map((p) => [p.kind, p.lon])).toEqual([['line', -19.30], ['point', -19.31], ['line', -16.0]]);
  });

  test('points of the same name are all kept: two farms "Stekkur" 10 km apart are two places', () => {
    const farms = [place('Stekkur', 'point', 0x6402, -19.30, 65.30), place('Stekkur', 'point', 0x6402, -19.10, 65.30)];
    expect(collapseNearby(farms)).toHaveLength(2);
  });
});

describe('nearName', () => {
  test('the nearest named point within reach, without its height; lines, areas and numbers don\'t count', () => {
    const places = [
      place('RJÚPNAVELLIR', 'point', 0x2b02, -19.88, 64.03),
      place('HEKLA 1491m', 'point', 0x6616, -19.67, 63.99),
      place('Þjórsá', 'line', 0x1f00, -19.86, 64.035),
      place('420', 'point', 0x6616, -19.86, 64.035),
    ];
    expect(nearName(places, [-19.86, 64.034])).toBe('Near Rjúpnavellir');
    expect(nearName(places, [-19.67, 63.995])).toBe('Near Hekla');
    expect(nearName(places, [-21, 64.5])).toBeUndefined();
  });

  test('a NearIndex (the grid the app asks) gives the same answers', () => {
    const places = [
      place('RJÚPNAVELLIR', 'point', 0x2b02, -19.88, 64.03),
      place('HEKLA 1491m', 'point', 0x6616, -19.67, 63.99),
      place('Þjórsá', 'line', 0x1f00, -19.86, 64.035),
      place('420', 'point', 0x6616, -19.86, 64.035),
      place('Hut', 'point', 0x2b02, -19.7, 64.05),
      place('Other hut', 'point', 0x2b02, -19.7, 64.05), // the same spot: the later one, as before
    ];
    const near = new NearIndex(new PlaceStore(columnsFromPlaces(places, {})).namedPoints());
    for (const at of [[-19.86, 64.034], [-19.67, 63.995], [-21, 64.5], [-19.7, 64.05], [-19.75, 64.04]] as Array<[number, number]>) {
      expect(near.nearName(at)).toBe(nearName(places, at));
      expect(near.nearName(at, 10)).toBe(nearName(places, at, 10));
    }
    expect(near.nearName([-19.7, 64.05])).toBe('Near Other hut');
  });
});
