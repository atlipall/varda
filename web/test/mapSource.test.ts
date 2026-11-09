import { describe, expect, it } from 'vitest';
import type { StyleSpecification } from 'maplibre-gl';
import { carryOver, parseTileUrl, tileUrl } from '../src/app/mapSource';

const style = (sources: string[], layers: string[]): StyleSpecification => ({
  version: 8,
  sources: Object.fromEntries(sources.map((s) => [s, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }])),
  layers: layers.map((id) => ({ id, type: 'background' })),
});

describe('switching styles', () => {
  it('keeps the app\'s own sources and layers above the next map\'s', () => {
    const prev = style(['garmin', 'dem', 'route', 'saved'], ['bg', 'hillshade', 'roads', 'route-line', 'saved-pins']);
    const next = style(['garmin'], ['bg', 'water', 'roads']);
    const out = carryOver(prev, next, { baseLayers: new Set(['bg', 'hillshade', 'roads']), baseSources: new Set(['garmin', 'dem']) });
    expect(Object.keys(out.sources)).toEqual(['garmin', 'route', 'saved']);
    expect(out.layers.map((l) => l.id)).toEqual(['bg', 'water', 'roads', 'route-line', 'saved-pins']);
  });
  it('takes the next style as it is when there was none', () => {
    const next = style(['garmin'], ['bg']);
    expect(carryOver(undefined, next, { baseLayers: new Set(), baseSources: new Set() })).toBe(next);
  });
});

describe('tile addresses', () => {
  it('carry the generation', () => {
    const url = tileUrl('garmin', 3).replace('{z}', '12').replace('{x}', '1').replace('{y}', '2');
    expect(parseTileUrl(url)).toEqual({ z: 12, x: 1, y: 2, gen: 3 });
    expect(parseTileUrl('dem://4/5/6')).toEqual({ z: 4, x: 5, y: 6, gen: 0 });
    expect(() => parseTileUrl('garmin://x')).toThrow();
  });
});
