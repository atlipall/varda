import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { overlaySummary } from '../src/app/overlaysPanel';
import { KmlError, kmlColor, parseKml, readOverlayFile } from '../src/overlays/kml';
import { parseXml } from '../src/overlays/xml';
import { REPO } from './helpers/paths';

const kml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Test</name>${body}</Document></kml>`;

/** A zip holding `files` uncompressed (the reader skips CRCs, so they're left 0). */
function storedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 255, v >> 8);
  const u32 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24);
  let count = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = enc.encode(text);
    const offset = locals.length;
    u32(locals, 0x04034b50); u16(locals, 20); u16(locals, 0); u16(locals, 0); u32(locals, 0); u32(locals, 0);
    u32(locals, d.length); u32(locals, d.length); u16(locals, n.length); u16(locals, 0);
    locals.push(...n, ...d);
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, 0);
    u32(central, d.length); u32(central, d.length); u16(central, n.length); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0);
    u32(central, 0); u32(central, offset);
    central.push(...n);
    count++;
  }
  const end: number[] = [];
  u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, count); u16(end, count); u32(end, central.length); u32(end, locals.length); u16(end, 0);
  return new Uint8Array([...locals, ...central, ...end]);
}

describe('parseXml', () => {
  test('nests elements, drops namespace prefixes, decodes text and CDATA', () => {
    const root = parseXml('<a x="1"><gx:B>one &amp; two</gx:B><c/><d><![CDATA[<raw>]]></d></a>');
    const [a] = root.children;
    expect(a.tag).toBe('a');
    expect(a.attrs.x).toBe('1');
    expect(a.children.map((c) => c.tag)).toEqual(['b', 'c', 'd']);
    expect(a.children[0].text).toBe('one & two');
    expect(a.children[2].text).toBe('<raw>');
  });
});

describe('parseKml', () => {
  test('KML colours are aabbggrr', () => {
    expect(kmlColor('800000ff')).toEqual({ color: '#ff0000', opacity: 128 / 255 });
    expect(kmlColor('ff6562ff')).toEqual({ color: '#ff6265', opacity: 1 });
    expect(kmlColor('red')).toBeNull();
  });

  test('a polygon takes its StyleMap\'s normal style, with a hole and a label inside', () => {
    const o = parseKml(kml(`
      <Style id="hl"><PolyStyle><color>ff00ff00</color></PolyStyle></Style>
      <Style id="n"><LineStyle><color>ff0000ff</color><width>3</width></LineStyle><PolyStyle><color>400000ff</color></PolyStyle></Style>
      <StyleMap id="m"><Pair><key>normal</key><styleUrl>#n</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#hl</styleUrl></Pair></StyleMap>
      <Folder><Placemark><name>Zone</name><styleUrl>#m</styleUrl><Polygon>
        <outerBoundaryIs><LinearRing><coordinates>0,0,0 4,0,0 4,4,0 0,4,0</coordinates></LinearRing></outerBoundaryIs>
        <innerBoundaryIs><LinearRing><coordinates>1,1 2,1 2,2 1,1</coordinates></LinearRing></innerBoundaryIs>
      </Polygon></Placemark></Folder>`), 'x');
    expect(o.name).toBe('Test');
    expect(o.counts).toEqual({ points: 0, lines: 0, areas: 1 });
    const [area, label] = o.features;
    expect(area.geometry.type).toBe('Polygon');
    const rings = (area.geometry as GeoJSON.Polygon).coordinates;
    expect(rings).toHaveLength(2);
    // The open outer ring is closed.
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
    expect(area.properties).toMatchObject({ k: 'area', name: 'Zone', line: '#ff0000', lineOpacity: 1, lineWidth: 3, fill: '#ff0000' });
    expect(area.properties.fillOpacity).toBeCloseTo(64 / 255);
    expect(label.properties.k).toBe('label');
    expect(label.properties.name).toBe('Zone');
    expect(o.bounds).toEqual([0, 0, 4, 4]);
    expect(o.color).toBe('#ff0000');
  });

  test('fills are kept see-through; fill 0 and outline 0 are honoured', () => {
    const o = parseKml(kml(`
      <Placemark><Style><PolyStyle><color>ffffffff</color></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><Style><PolyStyle><fill>0</fill><outline>0</outline></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`), 'x');
    expect(o.features[0].properties.fillOpacity).toBe(0.45);
    expect(o.features[1].properties).toMatchObject({ fillOpacity: 0, lineOpacity: 0 });
  });

  test('points, lines, gx:Track and MultiGeometry; unstyled shapes get a visible colour', () => {
    const o = parseKml(kml(`
      <Placemark><name>A &amp; B</name><Point><coordinates>-21.9,64.1,0</coordinates></Point></Placemark>
      <Placemark><name>Path</name><LineString><coordinates>-21,64 -20,65</coordinates></LineString></Placemark>
      <Placemark><gx:Track><gx:coord>-21 64 10</gx:coord><gx:coord>-21.1 64.1 12</gx:coord></gx:Track></Placemark>
      <Placemark><MultiGeometry><Point><coordinates>1,2</coordinates></Point><Point><coordinates>3,4</coordinates></Point></MultiGeometry></Placemark>
      <Placemark><name>Nowhere</name><Point><coordinates>999,999</coordinates></Point></Placemark>`), 'x');
    expect(o.counts).toEqual({ points: 3, lines: 2, areas: 0 });
    expect(o.features[0]).toMatchObject({ geometry: { type: 'Point', coordinates: [-21.9, 64.1] }, properties: { k: 'point', name: 'A & B' } });
    expect(o.features[2].geometry).toEqual({ type: 'LineString', coordinates: [[-21, 64], [-21.1, 64.1]] });
    expect(o.features[0].properties.fill).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("a white icon colour (KML's no tint) leaves points in the default colour", () => {
    const o = parseKml(kml('<Placemark><Style><IconStyle><color>ffffffff</color></IconStyle></Style><Point><coordinates>1,2</coordinates></Point></Placemark><Placemark><Style><IconStyle><color>ff00ff00</color></IconStyle></Style><Point><coordinates>1,2</coordinates></Point></Placemark>'), 'x');
    expect(o.features[0].properties.fill).not.toBe('#ffffff');
    expect(o.features[1].properties.fill).toBe('#00ff00');
  });

  test('a file without shapes, or not KML, says so', () => {
    expect(() => parseKml(kml('<Placemark><name>x</name></Placemark>'), 'x')).toThrow(KmlError);
    expect(() => parseKml('<gpx></gpx>', 'x')).toThrow("This isn't a KML file.");
  });

  test('the file name is used when the document has none', () => {
    const o = parseKml('<kml><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></kml>', 'mine');
    expect(o.name).toBe('mine');
  });
});

describe('readOverlayFile', () => {
  const doc = kml('<Placemark><Point><coordinates>1,2</coordinates></Point></Placemark>');

  test('reads a KMZ (zipped KML), preferring doc.kml', async () => {
    const zip = storedZip({ 'files/other.kml': kml('<Placemark><Point><coordinates>9,9</coordinates></Point></Placemark>'), 'doc.kml': doc });
    const o = await readOverlayFile('Places.kmz', zip);
    expect(o.features[0].geometry).toEqual({ type: 'Point', coordinates: [1, 2] });
  });

  test('refuses other files', async () => {
    await expect(readOverlayFile('track.gpx', new TextEncoder().encode('<gpx></gpx>'))).rejects.toThrow('Pick a KML or KMZ file');
    await expect(readOverlayFile('x.kmz', storedZip({ 'a.txt': 'hi' }))).rejects.toThrow('no KML file inside');
  });

  test('summary for the list', () => {
    expect(overlaySummary({ points: 195, lines: 0, areas: 0 })).toBe('195 places');
    expect(overlaySummary({ points: 1, lines: 2, areas: 1139 })).toBe('1 place · 2 lines · 1,139 areas');
  });
});

const OVERLAYS = REPO + 'map-files/GPSmap.is 2026.20 Android/OVERLAYS - Add content to OVERLAY folder/';
describe.skipIf(!existsSync(OVERLAYS))("GPSmap.is 2026's overlays", () => {
  const read = (name: string) => readOverlayFile(name, new Uint8Array(readFileSync(OVERLAYS + name)));

  test('drone no-fly zones: one placemark of 139 red areas over Iceland', async () => {
    const o = await read('GPSmap.is-Droneban-2026-01.kml');
    expect(o.name).toBe('GPSmap.is-Droneban-2026-01');
    expect(o.counts).toEqual({ points: 0, lines: 0, areas: 139 });
    expect(o.color).toBe('#ff0000');
    const area = o.features[0].properties;
    expect(area.fillOpacity).toBeCloseTo(0x40 / 255);
    expect(area.lineOpacity).toBeCloseTo(0x80 / 255);
    expect(o.features.filter((f) => f.properties.k === 'label')).toHaveLength(0);
    expect(o.bounds[0]).toBeCloseTo(-24.576, 2);
    expect(o.bounds[3]).toBeCloseTo(66.586, 2);
  });

  test('Reykjavík parking zones: 23 areas in four colours, named 1 to 4', async () => {
    const o = await read('GPSmap.is-Gjaldsvaedi-bilastaedasjods-2026-02.kml');
    expect(o.counts.areas).toBe(23);
    const areas = o.features.filter((f) => f.properties.k === 'area');
    expect(new Set(areas.map((f) => f.properties.name))).toEqual(new Set(['1', '2', '3', '4']));
    expect(new Set(areas.map((f) => f.properties.fill)).size).toBe(4);
    // Zone 1 is GPSmap.is's red (ff6562ff: alpha ff, blue 65, green 62, red ff).
    expect(areas.find((f) => f.properties.name === '1')!.properties.fill).toBe('#ff6265');
    expect(areas.every((f) => f.properties.fillOpacity <= 0.45)).toBe(true);
  });

  test('artworks: 195 named places', async () => {
    const o = await read('GPSmap.is-Listaverk-2026-02.kml');
    expect(o.counts).toEqual({ points: 195, lines: 0, areas: 0 });
    expect(o.features.map((f) => f.properties.name)).toContain('Leifur heppni');
  });
});
