import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { downloadLayer, layerUrl, MAX_DOWNLOAD, parseCapabilities, PICKED, pickedLayer, searchLayers, serverLayers } from '../src/overlays/ogc';
import { readZip } from '../src/overlays/read';
import { fromWkt } from '../src/overlays/proj';
import { MAX_POINTS, parseShapefile } from '../src/overlays/shapefile';
import { REPO } from './helpers/paths';

const CAPS = `<?xml version="1.0"?><wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0"><FeatureTypeList>
<FeatureType><Name>vedur:crevasse_map_2025</Name><Title>Sprungukort 2025</Title></FeatureType>
<FeatureType><Name>f4x4:skalar</Name><Title>Skálar</Title></FeatureType>
<FeatureType><Name>obyggdanefnd:TH</Name><Title>Þjóðlendur</Title></FeatureType>
<FeatureType><Name>xyz:untitled</Name></FeatureType>
</FeatureTypeList></wfs:WFS_Capabilities>`;

afterEach(() => vi.unstubAllGlobals());

/** A fetch answering with `body` in chunks of `chunk` bytes. */
const fetchWith = (body: Uint8Array | string, status = 200, chunk = 1000) => vi.fn(async () => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
  return new Response(stream, { status });
});

describe('the server list', () => {
  test('layers from the capabilities, with their agencies, sorted; a missing title is the layer name', () => {
    const layers = parseCapabilities(CAPS);
    expect(layers.map((l) => [l.id, l.title, l.agency])).toEqual([
      ['f4x4:skalar', 'Skálar', 'Ferðaklúbburinn 4x4'],
      ['obyggdanefnd:TH', 'Þjóðlendur', 'Óbyggðanefnd'],
      ['vedur:crevasse_map_2025', 'Sprungukort 2025', 'Veðurstofa Íslands'],
      ['xyz:untitled', 'untitled', 'xyz'],
    ]);
  });

  test('search: every word, in the title, agency or id, without minding case or Icelandic letters', () => {
    const layers = parseCapabilities(CAPS);
    expect(searchLayers(layers, 'thjodlendur').map((l) => l.id)).toEqual(['obyggdanefnd:TH']);
    expect(searchLayers(layers, 'SKÁL 4x4').map((l) => l.id)).toEqual(['f4x4:skalar']);
    expect(searchLayers(layers, 'vedur sprung').map((l) => l.id)).toEqual(['vedur:crevasse_map_2025']);
    expect(searchLayers(layers, '  ')).toEqual([]);
  });

  test('fetched once, then kept a week in storage', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const f = fetchWith(CAPS);
    vi.stubGlobal('fetch', f);
    expect((await serverLayers(1000)).length).toBe(4);
    expect((await serverLayers(1000 + 6 * 24 * 3600e3)).length).toBe(4);
    expect(f).toHaveBeenCalledTimes(1);
    await serverLayers(1000 + 8 * 24 * 3600e3);
    expect(f).toHaveBeenCalledTimes(2);
  });

  test('the real list has every picked layer', () => {
    const file = REPO + 'map-files/ogc.gis.is/capabilities.xml';
    if (!existsSync(file)) return;
    const ids = new Set(parseCapabilities(readFileSync(file, 'utf8')).map((l) => l.id));
    expect(ids.size).toBeGreaterThan(400);
    expect(PICKED.flatMap((g) => g.layers).filter((l) => !ids.has(l.id))).toEqual([]);
  });
});

describe('downloads', () => {
  test('the address asks for a Shapefile zip of the layer', () => {
    expect(layerUrl('f4x4:skalar')).toBe('https://ogc.gis.is/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&outputFormat=shape-zip&typeName=f4x4%3Askalar');
  });

  test('says how much has come; refuses errors, non-zips and too-big layers', async () => {
    const zip = new Uint8Array(2500);
    zip.set([0x50, 0x4b]);
    vi.stubGlobal('fetch', fetchWith(zip));
    const seen: number[] = [];
    expect((await downloadLayer('a:b', (n) => seen.push(n))).length).toBe(2500);
    expect(seen).toEqual([1000, 2000, 2500]);
    vi.stubGlobal('fetch', fetchWith('<ows:ExceptionReport/>'));
    await expect(downloadLayer('a:b')).rejects.toThrow('didn’t send this layer as a Shapefile');
    vi.stubGlobal('fetch', fetchWith('', 404));
    await expect(downloadLayer('a:b')).rejects.toThrow('answered 404');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(downloadLayer('a:b')).rejects.toThrow('couldn’t be reached');
    vi.stubGlobal('fetch', fetchWith(new Uint8Array(MAX_DOWNLOAD + 10), 200, 4e6));
    await expect(downloadLayer('a:b')).rejects.toThrow('too big for the app');
  });
});

describe('reading what the server sends', () => {
  test('Web Mercator, as some LMÍ layers come', () => {
    const wkt = 'PROJCS["WGS 84 / Pseudo-Mercator", GEOGCS["WGS 84", DATUM["World Geodetic System 1984", SPHEROID["WGS 84", 6378137.0, 298.257223563]], PRIMEM["Greenwich", 0.0], UNIT["degree", 0.017453292519943295], AXIS["Geodetic latitude", NORTH], AXIS["Geodetic longitude", EAST]], PROJECTION["Popular Visualisation Pseudo Mercator"], PARAMETER["central_meridian", 0.0], PARAMETER["false_easting", 0.0], PARAMETER["false_northing", 0.0], UNIT["m", 1.0], AXIS["Easting", EAST], AXIS["Northing", NORTH]]';
    const R = 6378137;
    const [lon, lat] = fromWkt(wkt)!((-22 * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (63.9 * Math.PI) / 360)));
    expect(lon).toBeCloseTo(-22, 9);
    expect(lat).toBeCloseTo(63.9, 9);
  });

  test('a layer too detailed for a phone is refused before it is read', () => {
    const n = MAX_POINTS + 1;
    const b = Buffer.alloc(100 + 8 + 48 + n * 16);
    b.writeInt32BE(9994, 0);
    b.writeInt32BE(b.length / 2, 24);
    b.writeInt32LE(5, 32);
    b.writeInt32BE(1, 100);
    b.writeInt32BE((48 + n * 16) / 2, 104);
    b.writeInt32LE(5, 108);
    b.writeInt32LE(1, 144);
    b.writeInt32LE(n, 148);
    expect(() => parseShapefile({ shp: new Uint8Array(b) }, 'x')).toThrow('too detailed');
  });

  const DIR = REPO + 'map-files/ogc.gis.is/';
  test.skipIf(!existsSync(DIR))('every picked layer reads, over Iceland, named where the list says', async () => {
    const lines: string[] = [];
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.zip'))) {
      const layer = pickedLayer(f.replace(/\.zip$/, ''));
      if (!layer) continue;
      const [o] = await readZip(`${layer.title}.zip`, new Uint8Array(readFileSync(DIR + f)), layer.fields);
      const [w, s, e, n] = o.bounds;
      expect([w > -26, s > 62.5, e < -12, n < 67.6], layer.id).toEqual([true, true, true, true]);
      const names = o.features.filter((x) => x.properties.name).length;
      if (layer.fields?.name) expect(names, layer.id).toBeGreaterThan(0);
      if (layer.fields?.name === null) expect(names, layer.id).toBe(0);
      if (layer.fields?.kind) expect(o.legend?.field, layer.id).toBe(layer.fields.kind);
      lines.push(layer.id);
    }
    expect(lines.length).toBeGreaterThan(15);
  });

  test.skipIf(!existsSync(DIR))('hazard zones take their own colours', async () => {
    const layer = pickedLayer('LMI_vektor:gos_reykjanes_hazard_zones_nyjast')!;
    const [o] = await readZip('h.zip', new Uint8Array(readFileSync(DIR + `${layer.id}.zip`)), layer.fields);
    expect(o.features.filter((f) => f.properties.k === 'area').map((f) => f.properties.fill)).toContain('#ff7f00');
    expect(o.legend?.items.every((i) => /^#[0-9a-f]{6}$/i.test(i.color))).toBe(true);
  });
});
