import { existsSync, readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { fromWkt, ISN93, lonLat, utmNorth } from '../src/overlays/proj';
import { overlayJobs, type PickedFile } from '../src/overlays/read';
import { KIND_COLORS, kindField, nameField, parseDbf, parseShapefile, shapefileGroups } from '../src/overlays/shapefile';
import { REPO } from './helpers/paths';

/** The same corner of a parcel from HMS, asked for in ISN93 and in WGS84. */
const HMS_ISN93: [number, number] = [549853.233, 581073.078];
const HMS_WGS84: [number, number] = [-17.91372041, 65.72332701];
/** ISN93 as ArcGIS writes it, and as GeoServer does (Óbyggðanefnd's download). */
const ISN93_PRJ = 'PROJCS["ISN93_Lambert_1993",GEOGCS["GCS_ISN_1993",DATUM["D_Islands_Network_1993",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",500000.0],PARAMETER["Central_Meridian",-19.0],PARAMETER["Standard_Parallel_1",64.25],PARAMETER["Standard_Parallel_2",65.75],PARAMETER["Latitude_Of_Origin",65.0],UNIT["Meter",1.0]]';
const GEOSERVER_PRJ = 'PROJCS["ISN93 / Lambert 1993", GEOGCS["ISN93", DATUM["Islands Net 1993", SPHEROID["GRS 1980", 6378137.0, 298.257222101, AUTHORITY["EPSG","7019"]], TOWGS84[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], AUTHORITY["EPSG","6659"]], PRIMEM["Greenwich", 0.0, AUTHORITY["EPSG","8901"]], UNIT["degree", 0.017453292519943295], AXIS["Geodetic latitude", NORTH], AXIS["Geodetic longitude", EAST], AUTHORITY["EPSG","4659"]], PROJECTION["Lambert_Conformal_Conic_2SP", AUTHORITY["EPSG","9802"]], PARAMETER["central_meridian", -19.0], PARAMETER["latitude_of_origin", 65.0], PARAMETER["standard_parallel_1", 65.75], PARAMETER["false_easting", 500000.0], PARAMETER["false_northing", 500000.0], PARAMETER["scale_factor", 1.0], PARAMETER["standard_parallel_2", 64.25], UNIT["m", 1.0], AXIS["Easting", EAST], AXIS["Northing", NORTH], AUTHORITY["EPSG","3057"]]';

const near = (a: number[], b: number[], deg = 1e-6) => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(deg);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(deg);
};

type Ring = Array<[number, number]>;
/** A square ring in ISN93 metres around (x, y), clockwise (a Shapefile's outer ring) or not (a hole). */
const square = (x: number, y: number, r: number, clockwise = true): Ring => {
  const ring: Ring = [[x - r, y - r], [x - r, y + r], [x + r, y + r], [x + r, y - r], [x - r, y - r]];
  return clockwise ? ring : ring.reverse();
};

/** A polygon .shp with one record per entry (each a list of rings). */
function shp(records: Ring[][], type = 5): Uint8Array {
  const bodies = records.map((rings) => {
    const n = rings.reduce((s, r) => s + r.length, 0);
    const b = Buffer.alloc(4 + 32 + 8 + rings.length * 4 + n * 16);
    b.writeInt32LE(type, 0);
    b.writeInt32LE(rings.length, 36);
    b.writeInt32LE(n, 40);
    let start = 0;
    rings.forEach((r, i) => {
      b.writeInt32LE(start, 44 + i * 4);
      start += r.length;
    });
    let o = 44 + rings.length * 4;
    for (const [x, y] of rings.flat()) {
      b.writeDoubleLE(x, o);
      b.writeDoubleLE(y, o + 8);
      o += 16;
    }
    return b;
  });
  const head = Buffer.alloc(100);
  head.writeInt32BE(9994, 0);
  head.writeInt32LE(1000, 28);
  head.writeInt32LE(type, 32);
  head.writeDoubleLE(records[0]?.[0]?.[0]?.[0] ?? 0, 36);
  const recs = bodies.map((b, i) => {
    const h = Buffer.alloc(8);
    h.writeInt32BE(i + 1, 0);
    h.writeInt32BE(b.length / 2, 4);
    return Buffer.concat([h, b]);
  });
  const all = Buffer.concat([head, ...recs]);
  all.writeInt32BE(all.length / 2, 24);
  return new Uint8Array(all);
}

/** A dBASE III file of character fields 40 wide (a number field where `numbers` says), padded with
 *  `pad` the way some writers do. */
function dbf(fields: string[], rows: string[][], encoding: 'utf-8' | 'latin1' = 'utf-8', pad = ' ', numbers: string[] = []): Uint8Array {
  const W = 40;
  const headerLen = 32 + fields.length * 32 + 1;
  const recordLen = 1 + fields.length * W;
  const b = Buffer.alloc(headerLen + rows.length * recordLen + 1, 0);
  b[0] = 3;
  b.writeUInt32LE(rows.length, 4);
  b.writeUInt16LE(headerLen, 8);
  b.writeUInt16LE(recordLen, 10);
  fields.forEach((n, i) => {
    b.write(n, 32 + i * 32, 'latin1');
    b.write(numbers.includes(n) ? 'N' : 'C', 32 + i * 32 + 11, 'latin1');
    b[32 + i * 32 + 16] = W;
  });
  b[headerLen - 1] = 0x0d;
  rows.forEach((row, r) => {
    const at = headerLen + r * recordLen;
    b[at] = 0x20;
    row.forEach((v, i) => {
      const bytes = Buffer.from(v, encoding);
      Buffer.concat([bytes, Buffer.alloc(W - bytes.length, pad)]).copy(b, at + 1 + i * W);
    });
  });
  b[b.length - 1] = 0x1a;
  return new Uint8Array(b);
}

/** A zip with each file deflated (as zip tools write them). */
function makeZip(files: Record<string, Uint8Array>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = deflateRawSync(data);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const picked = (name: string, bytes: Uint8Array | string): PickedFile => {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { name, arrayBuffer: async () => b.slice().buffer };
};
const readAll = async (files: PickedFile[]) => Promise.all(overlayJobs(files).map((j) => j.read()));

describe('projections', () => {
  test('ISN93 to lon/lat matches HMS to a few centimetres, from either .prj', () => {
    near(ISN93(...HMS_ISN93), HMS_WGS84);
    near(fromWkt(ISN93_PRJ)!(...HMS_ISN93), HMS_WGS84);
    near(fromWkt(GEOSERVER_PRJ)!(...HMS_ISN93), HMS_WGS84);
  });

  test('UTM: the central meridian; unknown systems are refused; degrees pass through', () => {
    expect(utmNorth(27)(500000, 0)).toEqual([-21, 0]);
    expect(fromWkt('PROJCS["x",PROJECTION["Mollweide"]]')).toBeNull();
    expect(fromWkt('GEOGCS["WGS 84"]')).toBe(lonLat);
  });
});

describe('.dbf', () => {
  test('Icelandic text in Windows-1252, ISO-8859-1 (a .cst) or UTF-8; NUL padding and empty values dropped', () => {
    expect(parseDbf(dbf(['NAFN', 'X'], [['Þórsmörk', '']], 'latin1')).records).toEqual([{ NAFN: 'Þórsmörk' }]);
    expect(parseDbf(dbf(['NAFN'], [['Þórsmörk']], 'latin1'), 'ISO-8859-1').records[0].NAFN).toBe('Þórsmörk');
    expect(parseDbf(dbf(['NAFN'], [['Þórsmörk']], 'utf-8')).records[0].NAFN).toBe('Þórsmörk');
    const d = parseDbf(dbf(['heiti', 'domur', 'nr'], [['Á', '', '233961']], 'latin1', '\0', ['nr']), '1252');
    expect(d.records).toEqual([{ heiti: 'Á', nr: 233961 }]);
    expect(d.textFields).toEqual(['heiti', 'domur']);
  });

  test('the name field and the kind field: a readable kind-like one, not the name or one per shape', () => {
    const rows = [
      ['Hálsmannatungur', 'AFR_EIGN', 'Afréttareign', 'Þingeyjarsveit'],
      ['Vesturöræfi', 'AFR_EIGN', 'Afréttareign', 'Fljótsdalshreppur'],
      ['Landsvæði norðvestan Entujökuls', 'TH_TH', 'Þjóðlenda', 'Rangárþing eystra'],
      ['Mýrdalsjökull', 'TH_J', 'Þjóðlenda á jökli', 'Mýrdalshreppur'],
    ];
    const d = parseDbf(dbf(['heiti', 'tegund', 'tegund2', 'sveit'], [...rows, ...rows]));
    expect(nameField(d)).toBe('heiti');
    expect(kindField(d, 'heiti')).toBe('tegund2');
    // No field with repeated values: one colour.
    expect(kindField(parseDbf(dbf(['heiti', 'sveit'], rows.map((r) => [r[0], r[3]]))), 'heiti')).toBeNull();
  });
});

describe('parseShapefile', () => {
  test('areas in ISN93: holes go with the area they are in, names once in each, colours by kind with a legend', () => {
    const file = shp([
      [square(549853, 581073, 1000), square(560000, 581073, 1000), square(549853, 581073, 300, false)],
      [square(600000, 500000, 1000)],
      [square(610000, 500000, 1000)],
      [square(620000, 500000, 1000)],
    ]);
    const attrs = dbf(['nafn', 'flokkur'], [['Hekla', 'Þjóðlenda'], ['Katla', 'Afréttur'], ['Askja', 'Þjóðlenda'], ['', '']]);
    const o = parseShapefile({ shp: file, dbf: attrs, prj: ISN93_PRJ }, 'Lönd');
    expect(o.name).toBe('Lönd');
    expect(o.counts).toEqual({ points: 0, lines: 0, areas: 5 });
    const areas = o.features.filter((f) => f.properties.k === 'area');
    const first = areas[0].geometry as GeoJSON.Polygon;
    expect(first.coordinates).toHaveLength(2); // the hole is in the first square, not the second
    expect((areas[1].geometry as GeoJSON.Polygon).coordinates).toHaveLength(1);
    near(first.coordinates[0][0], ISN93(549853 - 1000, 581073 - 1000));
    const labels = o.features.filter((f) => f.properties.k === 'label');
    expect(labels.map((f) => f.properties.name)).toEqual(['Hekla', 'Katla', 'Askja']);
    expect(o.legend).toEqual({
      field: 'flokkur',
      items: [{ value: 'Þjóðlenda', color: KIND_COLORS[0] }, { value: 'Afréttur', color: KIND_COLORS[1] }, { value: 'Not given', color: '#64748b' }],
    });
    expect(areas.map((f) => f.properties.fill)).toEqual([KIND_COLORS[0], KIND_COLORS[0], KIND_COLORS[1], KIND_COLORS[0], '#64748b']);
    expect(o.color).toBe(KIND_COLORS[0]);
    const [w, s, e, n] = o.bounds;
    expect(w).toBeLessThan(-17.9);
    expect(e).toBeGreaterThan(w);
    expect(n).toBeGreaterThan(s);
  });

  test('lines; without a .prj big numbers are ISN93; without a .dbf one colour and no names', () => {
    const o = parseShapefile({ shp: shp([[[[549853.233, 581073.078], [550853, 581073]]]], 3) }, 'Slóðir');
    expect(o.counts).toEqual({ points: 0, lines: 1, areas: 0 });
    near((o.features[0].geometry as GeoJSON.LineString).coordinates[0], HMS_WGS84);
    expect(o.legend).toBeUndefined();
    expect(o.features[0].properties.name).toBe('');
  });

  test('a deleted .dbf record keeps the later names on their shapes; a hole goes to the smallest area around it', () => {
    const attrs = dbf(['nafn'], [['Gone'], ['Katla']]);
    attrs[32 + 32 + 1] = 0x2a; // the first record deleted
    const island = [square(600000, 500000, 1000), square(600000, 500000, 600, false), square(600000, 500000, 400), square(600000, 500000, 200, false)];
    const o = parseShapefile({ shp: shp([[square(550000, 500000, 1000)], island]), dbf: attrs }, 'x');
    expect(o.features.filter((f) => f.properties.k === 'label').map((f) => f.properties.name)).toEqual(['Katla']);
    const areas = o.features.filter((f) => f.properties.k === 'area').map((f) => (f.geometry as GeoJSON.Polygon).coordinates.length);
    expect(areas).toEqual([1, 2, 2]); // the outer island with the lake, the island in it with its pond
  });

  test('refuses what it can\'t read', () => {
    const whole = shp([[square(5e5, 5e5, 10)]]);
    expect(() => parseShapefile({ shp: whole.subarray(0, whole.length - 20) }, 'x')).toThrow('cut short');
    expect(() => parseShapefile({ shp: new Uint8Array(100) }, 'x')).toThrow("isn't a Shapefile");
    expect(() => parseShapefile({ shp: shp([[square(5e5, 5e5, 10)]]), prj: 'PROJCS["x",PROJECTION["Mollweide"]]' }, 'x')).toThrow('coordinate system');
  });
});

describe('overlayJobs', () => {
  const s = shp([[square(549853, 581073, 1000)]]);
  const d = dbf(['nafn'], [['Hekla']]);
  const prj = new TextEncoder().encode(ISN93_PRJ);

  test('a zip of a Shapefile is named after the zip; Mac zips\' extra copies are skipped', async () => {
    const zip = makeZip({ 'TH.shp': s, 'TH.dbf': d, 'TH.prj': prj, '__MACOSX/._TH.shp': new Uint8Array(4) });
    const [[o]] = await readAll([picked('thjodlendur.zip', zip)]);
    expect(o.name).toBe('thjodlendur');
    expect(o.features.find((f) => f.properties.k === 'label')?.properties.name).toBe('Hekla');
  });

  test('a zip with two Shapefiles gives two overlays; a zip with a KML is a KMZ', async () => {
    const two = makeZip({ 'a/jardir.shp': s, 'a/jardir.dbf': d, 'a/vegir.shp': s });
    expect((await readAll([picked('gögn.zip', two)]))[0].map((o) => o.name)).toEqual(['jardir', 'vegir']);
    const kml = '<kml><Document><name>K</name><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>';
    expect((await readAll([picked('k.zip', makeZip({ 'doc.kml': new TextEncoder().encode(kml) }))]))[0][0].counts.points).toBe(1);
    await expect(readAll([picked('x.zip', makeZip({ 'a.txt': new Uint8Array(1) }))])).rejects.toThrow('no KML file or Shapefile');
  });

  test("a Shapefile's files picked together are one overlay; its parts without the .shp are explained", async () => {
    const jobs = overlayJobs([picked('TH.shp', s), picked('TH.dbf', d), picked('TH.prj', prj), picked('TH.shx', new Uint8Array(8)), picked('places.kml', '<kml/>')]);
    expect(jobs.map((j) => j.label)).toEqual(['places.kml', 'TH.shp']);
    const [o] = await jobs[1].read();
    expect(o.name).toBe('TH');
    expect(o.counts.areas).toBe(1);
    await expect(overlayJobs([picked('TH.dbf', d)])[0].read()).rejects.toThrow('choose its .shp with it');
  });

  test('shapefileGroups pairs files by name, any case', () => {
    const g = shapefileGroups(new Map([['x/Lond.SHP', s], ['x/lond.dbf', d], ['y/lond.dbf', d]]));
    expect(g.map((x) => [x.base, !!x.parts, !!x.parts?.dbf])).toEqual([['Lond', true, true], ['lond', false, false]]);
  });
});

const TH = REPO + 'map-files/Obyggdanefnd thjodlendur/TH';
describe.skipIf(!existsSync(TH + '.shp'))("Óbyggðanefnd's þjóðlendur", () => {
  test('281 shapes (306 areas) over Iceland in five kinds, named in Icelandic', () => {
    const read = (e: string) => new Uint8Array(readFileSync(TH + e));
    const o = parseShapefile({ shp: read('.shp'), dbf: read('.dbf'), prj: readFileSync(TH + '.prj', 'utf8'), cpg: readFileSync(TH + '.cst', 'utf8') }, 'thjodlendur');
    expect(o.counts).toEqual({ points: 0, lines: 0, areas: 306 });
    expect(o.legend?.field).toBe('tegund2');
    expect(o.legend?.items.map((i) => i.value)).toEqual(['Afréttareign', 'Afréttur', 'Þjóðlenda', 'Þjóðlenda á jökli', 'Haf']);
    const names = o.features.filter((f) => f.properties.k === 'label').map((f) => f.properties.name);
    expect(names).toContain('Eyrarbotn - strandsvæði');
    const [w, s, e, n] = o.bounds;
    expect([w > -25.1, s > 63, e < -12.7, n < 67.4]).toEqual([true, true, true, true]);
    const points = o.features.reduce((c, f) => c + (f.geometry.type === 'Polygon' ? f.geometry.coordinates.flat().length : 0), 0);
    expect(points).toBeLessThan(228_000 * 0.7); // simplified
  });
});

describe('axis order', () => {
  const WFS2_4326 = 'GEOGCS["WGS 84", DATUM["World Geodetic System 1984", SPHEROID["WGS 84", 6378137.0, 298.257223563, AUTHORITY["EPSG","7030"]], AUTHORITY["EPSG","6326"]], PRIMEM["Greenwich", 0.0, AUTHORITY["EPSG","8901"]], UNIT["degree", 0.017453292519943295], AXIS["Geodetic latitude", NORTH], AXIS["Geodetic longitude", EAST], AUTHORITY["EPSG","4326"]]';
  test("GeoServer's WFS 2.0 degrees are latitude first, as its .prj says; ISN93's grid isn't swapped by its GEOGCS's axes", () => {
    expect(fromWkt(WFS2_4326)!(64.33, -19.66)).toEqual([-19.66, 64.33]);
    expect(fromWkt('GEOGCS["WGS 84",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]')!(-19.66, 64.33)).toEqual([-19.66, 64.33]);
    const noGridAxes = GEOSERVER_PRJ.replace(', AXIS["Easting", EAST], AXIS["Northing", NORTH]', '');
    near(fromWkt(noGridAxes)!(...HMS_ISN93), HMS_WGS84);
  });

  test('a latitude-first point file comes out over Iceland', () => {
    const b = Buffer.alloc(100 + 8 + 20);
    b.writeInt32BE(9994, 0);
    b.writeInt32BE(b.length / 2, 24);
    b.writeInt32LE(1000, 28);
    b.writeInt32LE(1, 32);
    [64.33, -19.66, 64.33, -19.66].forEach((x, i) => b.writeDoubleLE(x, 36 + i * 8));
    b.writeInt32BE(1, 100);
    b.writeInt32BE(10, 104);
    b.writeInt32LE(1, 108);
    b.writeDoubleLE(64.33, 112);
    b.writeDoubleLE(-19.66, 120);
    const o = parseShapefile({ shp: new Uint8Array(b), prj: WFS2_4326 }, 'Skálar');
    expect(o.features[0].geometry).toEqual({ type: 'Point', coordinates: [-19.66, 64.33] });
  });
});
