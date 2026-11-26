import { describe, expect, test } from 'vitest';
import { emptyTyp, type Typ } from '../src/img/typ';
import { buildStyle } from '../src/style/buildStyle';

const OPTS = { tiles: 'garmin://{z}/{x}/{y}', glyphs: 'http://x/fonts/{fontstack}/{range}.pbf' };
const img = (w: number, h: number) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });

describe('buildStyle', () => {
  test('layer order, sources, glyphs', () => {
    const typ: Typ = {
      ...emptyTyp(),
      polygons: new Map([[0x3c, { color: '#0000ff', pattern: null }], [0x50, { color: '#00ff00', pattern: null }]]),
      lines: new Map([[0x16, { color: '#ff0000', width: 3, borderColor: '#000000', borderWidth: 5, dash: null }]]),
      drawLevel: new Map([[0x50, 1], [0x3c, 2]]),
    };
    const { style } = buildStyle(typ, OPTS);
    const ids = style.layers.map((l) => l.id);
    expect(ids[0]).toBe('background');
    expect(ids.indexOf('pg-80')).toBeLessThan(ids.indexOf('pg-60'));
    expect(ids.indexOf('ln-22-casing')).toBeLessThan(ids.indexOf('ln-32'));
    expect(ids.indexOf('ln-32')).toBeLessThan(ids.indexOf('ln-22'));
    expect(ids).toContain('ln-other');
    expect(ids).not.toContain('hillshade');
    expect(style.sources.garmin).toEqual({ type: 'vector', tiles: [OPTS.tiles], minzoom: 4, maxzoom: 14 });
    expect(style.glyphs).toBe(OPTS.glyphs);
    const pg = style.layers.find((l) => l.id === 'pg-60') as { filter: unknown; paint: Record<string, unknown> };
    // Areas only: area labels are points in the same layer.
    expect(pg.filter).toEqual(['all', ['==', ['get', 't'], 0x3c], ['==', ['geometry-type'], 'Polygon']]);
    expect(pg.paint['fill-color']).toBe('#0000ff');
  });

  test('patterns and icons become images', () => {
    const typ: Typ = { ...emptyTyp(), polygons: new Map([[0x4e, { color: '#010203', pattern: img(32, 32) }]]), points: new Map([[0x2f06, { image: img(8, 8) }]]) };
    const { style, images } = buildStyle(typ, OPTS);
    expect([...images.keys()].sort()).toEqual(['pg-78', 'pt-12038']);
    const pg = style.layers.find((l) => l.id === 'pg-78') as { paint: Record<string, unknown> };
    expect(pg.paint['fill-pattern']).toBe('pg-78');
    const icons = style.layers.find((l) => l.id === 'poi-icons') as { filter: unknown };
    expect(icons.filter).toEqual(['in', ['get', 't'], ['literal', [0x2f06]]]);
  });

  test('fallbacks: skip 0x4a/0x4b, keep known defaults', () => {
    const ids = buildStyle(emptyTyp(), OPTS).style.layers.map((l) => l.id);
    expect(ids).not.toContain('pg-74');
    expect(ids).not.toContain('pg-75');
    expect(ids).toContain('pg-80');
    expect(ids).toContain('ln-1');
  });

  test('round ends and joins only from the zoom where a line is drawn 3 px wide; a casing follows its line', () => {
    const typ: Typ = {
      ...emptyTyp(),
      lines: new Map([
        [0x10107, { color: '#888888', width: 1, borderColor: null, borderWidth: 0, dash: null }], // never 3 px
        [0x04, { color: '#ffff00', width: 5, borderColor: null, borderWidth: 0, dash: null }], // 2 px at zoom 8, 3 px at zoom 10
        [0x01, { color: '#ff0000', width: 8, borderColor: null, borderWidth: 0, dash: null }], // 3.2 px at zoom 8 already
        [0x16, { color: '#ffffff', width: 2, borderColor: '#000000', borderWidth: 5, dash: null }], // by its casing's width
        [0x1f, { color: '#0000ff', width: 8, borderColor: null, borderWidth: 0, dash: [4, 2] }], // dashed: flat ends
      ]),
    };
    const layout = (id: string) => (buildStyle(typ, OPTS).style.layers.find((l) => l.id === id) as { layout: Record<string, unknown> }).layout;
    const from10 = (flat: string) => ['step', ['zoom'], flat, 10, 'round'];
    expect(layout(`ln-${0x10107}`)).toEqual({ 'line-join': 'miter', 'line-cap': 'butt' });
    expect(layout('ln-4')).toEqual({ 'line-join': from10('miter'), 'line-cap': from10('butt') });
    expect(layout('ln-1')).toEqual({ 'line-join': 'round', 'line-cap': 'round' });
    expect(layout('ln-22')).toEqual(layout('ln-22-casing')); // one layout: MapLibre builds the line once for both
    expect(layout('ln-22')).toEqual({ 'line-join': from10('miter'), 'line-cap': from10('butt') });
    expect(layout('ln-31')).toEqual({ 'line-join': 'round', 'line-cap': 'butt' });
  });

  test('a hidden line type is not drawn, but its names are', () => {
    const typ: Typ = { ...emptyTyp(), lines: new Map([[0x2a, { color: '#ffffff', width: 1, borderColor: null, borderWidth: 0, dash: null, hidden: true }]]) };
    const { style } = buildStyle(typ, OPTS);
    const ids = style.layers.map((l) => l.id);
    expect(ids).not.toContain('ln-42');
    // Not caught by the catch-all for types without a style either.
    const other = style.layers.find((l) => l.id === 'ln-other') as { filter: unknown[] };
    expect(JSON.stringify(other.filter)).toContain('42');
    const labels = style.layers.find((l) => l.id === 'line-labels') as { filter: unknown };
    expect(labels.filter).toEqual(['all', ['has', 'name'], ['!', ['in', ['get', 't'], ['literal', [0x20, 0x21, 0x22, 0x23, 0x24, 0x25]]]]]);
  });

  test('hillshade when a dem source is given', () => {
    const { style } = buildStyle(emptyTyp(), { ...OPTS, dem: 'dem://{z}/{x}/{y}', demBounds: [-25, 63, -13, 67] });
    const ids = style.layers.map((l) => l.id);
    const lastFill = Math.max(...ids.map((id, i) => (id.startsWith('pg-') && id !== 'pg-labels' ? i : -1)));
    expect(ids.indexOf('hillshade')).toBe(lastFill + 1);
    expect(ids.indexOf('hillshade')).toBeLessThan(ids.indexOf('ln-other'));
    expect(style.sources.dem).toEqual({
      type: 'raster-dem', tiles: ['dem://{z}/{x}/{y}'], tileSize: 256, minzoom: 5, maxzoom: 11, encoding: 'mapbox', bounds: [-25, 63, -13, 67],
    });
  });
});
