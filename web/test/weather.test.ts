import { describe, expect, test } from 'vitest';
import { chartSvg, indexAtX, xOf } from '../src/weather/chart';
import { colorOf, legendGradient, SCALES, tickPosition } from '../src/weather/colors';
import { covers, FIELDS, gridEast, gridFor, gridNorth, gridPoints, hourIndex, MAX_POINTS, valueAt, type Field, type GridSpec, type WeatherGrid } from '../src/weather/grid';
import { ARCHIVE_HOST, FORECAST_HOST, parseWeather, weatherUrl } from '../src/weather/openMeteo';
import { renderField } from '../src/weather/render';
import { windCompass, parseLatest, parseStations, stationFeatures, STALE_MS } from '../src/weather/stations';

const ICELAND: [number, number, number, number] = [-24.6, 63.2, -13.4, 66.6];

/** A grid whose fields are set by `fill(field, t, row, col)`. */
function makeGrid(spec: GridSpec, hours: number, fill: (f: Field, t: number, r: number, c: number) => number): WeatherGrid {
  const n = spec.rows * spec.cols;
  const values = Object.fromEntries(FIELDS.map((f) => {
    const a = new Float32Array(hours * n);
    for (let t = 0; t < hours; t++) for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) a[t * n + r * spec.cols + c] = fill(f, t, r, c);
    return [f, a];
  })) as Record<Field, Float32Array>;
  return { ...spec, times: Array.from({ length: hours }, (_, t) => Date.UTC(2026, 10, 2, t)), values, source: 'test', fetched: 0 };
}

describe('weather grid', () => {
  test('the whole of Iceland at a low zoom: the coarse spacing, within the point limit, reaching past the view', () => {
    const g = gridFor(ICELAND, 5.5);
    expect([g.dLat, g.dLon]).toEqual([0.5, 1]);
    expect(g.rows * g.cols).toBeLessThanOrEqual(MAX_POINTS);
    expect(g.south).toBeLessThan(63.2);
    expect(g.west).toBeLessThan(-24.6);
    expect(gridNorth(g)).toBeGreaterThan(66.6);
    expect(gridEast(g)).toBeGreaterThan(-13.4);
  });

  test('zoomed in, the spacing gets finer; too many points falls back to a coarser one', () => {
    const view: [number, number, number, number] = [-19.2, 63.95, -19.0, 64.05];
    expect(gridFor(view, 11).dLat).toBe(0.02);
    expect(gridFor(view, 9).dLat).toBe(0.1);
    // A wider view at zoom 11 takes the next spacing.
    expect(gridFor([-19.3, 63.9, -18.9, 64.1], 11).dLat).toBe(0.05);
    // Iceland at zoom 11 would be thousands of points.
    const wide = gridFor(ICELAND, 11);
    expect(wide.rows * wide.cols).toBeLessThanOrEqual(MAX_POINTS);
    expect(wide.dLat).toBe(0.5);
  });

  test('the whole world keeps to the limit', () => {
    const g = gridFor([-180, -85, 180, 85], 0);
    expect(g.rows * g.cols).toBeLessThanOrEqual(MAX_POINTS);
  });

  test('edges snap to whole steps, so a small pan keeps the grid', () => {
    const a = gridFor([-20.03, 63.91, -19.52, 64.18], 10);
    const b = gridFor([-20.0, 63.93, -19.5, 64.2], 10);
    expect(covers(a, b)).toBe(true);
    // Far away it doesn't; nor does a coarser grid for a closer view.
    expect(covers(a, gridFor([-15, 65, -14.5, 65.3], 10))).toBe(false);
    expect(covers(gridFor(ICELAND, 5), gridFor([-19.3, 63.9, -18.9, 64.1], 11))).toBe(false);
  });

  test('points run row by row from the south-west', () => {
    const pts = gridPoints({ dLat: 0.1, dLon: 0.2, south: 64, west: -20, rows: 2, cols: 3 });
    expect(pts).toEqual([[-20, 64], [-19.8, 64], [-19.6, 64], [-20, 64.1], [-19.8, 64.1], [-19.6, 64.1]]);
  });

  test('values between points are bilinear; outside the grid NaN', () => {
    const g = makeGrid({ dLat: 1, dLon: 1, south: 64, west: -20, rows: 2, cols: 2 }, 1, (_f, _t, r, c) => r * 10 + c);
    expect(valueAt(g, 'temp', 0, -20, 64)).toBe(0);
    expect(valueAt(g, 'temp', 0, -19, 65)).toBe(11);
    expect(valueAt(g, 'temp', 0, -19.5, 64.5)).toBeCloseTo(5.5);
    expect(valueAt(g, 'temp', 0, -21, 64.5)).toBeNaN();
    expect(valueAt(g, 'temp', 1, -19.5, 64.5)).toBeNaN();
  });

  test('wind direction is averaged as a vector: between 350° and 10° is north, not south', () => {
    const g = makeGrid({ dLat: 1, dLon: 1, south: 64, west: -20, rows: 1, cols: 2 }, 1, (f, _t, _r, c) => (f === 'dir' ? (c === 0 ? 350 : 10) : f === 'wind' ? 5 : 0));
    const d = valueAt(g, 'dir', 0, -19.5, 64);
    expect(Math.min(d, 360 - d)).toBeLessThan(1);
  });

  test('the nearest hour', () => {
    const times = [0, 3_600_000, 7_200_000];
    expect(hourIndex(times, 3_000_000)).toBe(1);
    expect(hourIndex(times, -5)).toBe(0);
    expect(hourIndex(times, 9e9)).toBe(2);
    expect(hourIndex([], 0)).toBe(-1);
  });
});

describe('Open-Meteo', () => {
  const spec: GridSpec = { dLat: 0.25, dLon: 0.5, south: 64, west: -20, rows: 1, cols: 2 };
  const now = Date.UTC(2026, 10, 2, 12);

  test('the forecast asks DMI first, then ECMWF, for yesterday to a week ahead, in m/s', () => {
    const u = new URL(weatherUrl(spec, { kind: 'forecast' }, now));
    expect(u.origin).toBe(FORECAST_HOST);
    expect(u.searchParams.get('latitude')).toBe('64,64');
    expect(u.searchParams.get('longitude')).toBe('-20,-19.5');
    expect(u.searchParams.get('models')).toBe('dmi_harmonie_arome_europe,ecmwf_ifs025');
    expect(u.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(u.searchParams.get('past_days')).toBe('1');
    expect(u.searchParams.get('hourly')).toContain('wind_gusts_10m');
  });

  test('a recent day comes from the forecast service, an old one from the archive', () => {
    const recent = new URL(weatherUrl(spec, { kind: 'day', date: '2026-09-10' }, now));
    expect(recent.origin).toBe(FORECAST_HOST);
    expect(recent.searchParams.get('start_date')).toBe('2026-09-10');
    const old = new URL(weatherUrl(spec, { kind: 'day', date: '1995-01-10' }, now));
    expect(old.origin).toBe(ARCHIVE_HOST);
    expect(old.searchParams.get('models')).toBeNull();
    expect(old.searchParams.get('end_date')).toBe('1995-01-10');
  });

  test('each hour takes DMI where it has one, else ECMWF', () => {
    const point = (dmi: Array<number | null>, ec: number[]) => ({
      hourly: {
        time: ['2026-11-02T00:00', '2026-11-02T01:00'],
        wind_speed_10m_dmi_harmonie_arome_europe: dmi,
        wind_speed_10m_ecmwf_ifs025: ec,
        temperature_2m_ecmwf_ifs025: [1, 2],
      },
    });
    const g = parseWeather(spec, [point([5, null], [7, 8]), point([null, null], [9, 10])], 42);
    expect(g.times).toEqual([Date.UTC(2026, 10, 2, 0), Date.UTC(2026, 10, 2, 1)]);
    expect([...g.values.wind]).toEqual([5, 9, 8, 10]);
    expect([...g.values.temp]).toEqual([1, 1, 2, 2]);
    expect(g.values.cloud.every(Number.isNaN)).toBe(true);
    expect(g.source).toBe('DMI HARMONIE, ECMWF');
    expect(g.fetched).toBe(42);
  });

  test('the archive answers without model names; one point comes as an object', () => {
    const one: GridSpec = { ...spec, cols: 1 };
    const g = parseWeather(one, { hourly: { time: ['1995-01-10T00:00'], wind_speed_10m: [20] } });
    expect([...g.values.wind]).toEqual([20]);
    expect(g.source).toBe('ERA5');
  });

  test('an error answer or the wrong number of places throws', () => {
    expect(() => parseWeather(spec, { error: true, reason: 'Too many' })).toThrow('Too many');
    expect(() => parseWeather(spec, [{ hourly: { time: ['2026-11-02T00:00'] } }])).toThrow(/Expected 2/);
  });
});

describe('weather colours', () => {
  test('calm, dry and clear are see-through; stronger wind is stronger colour', () => {
    expect(colorOf(SCALES.wind, 0)[3]).toBe(0);
    expect(colorOf(SCALES.rain, 0)[3]).toBe(0);
    expect(colorOf(SCALES.cloud, 5)[3]).toBe(0);
    expect(colorOf(SCALES.wind, 20)[3]).toBeGreaterThan(colorOf(SCALES.wind, 5)[3]);
    expect(colorOf(SCALES.wind, NaN)).toEqual([0, 0, 0, 0]);
    expect(colorOf(SCALES.wind, 99)).toEqual(SCALES.wind.stops.at(-1)![1]);
  });

  test('the legend spans the ticks', () => {
    expect(legendGradient(SCALES.temp)).toMatch(/^linear-gradient\(to right, rgba/);
    expect(tickPosition(SCALES.wind, 0)).toBe(0);
    expect(tickPosition(SCALES.wind, 32)).toBe(1);
  });
});

describe('drawing a field', () => {
  test('the image covers the grid, rows evenly spaced in Mercator: strong wind in the north shows at the top', () => {
    const spec: GridSpec = { dLat: 10, dLon: 1, south: 50, west: -22, rows: 3, cols: 2 };
    // Calm in the south row, a storm in the north row.
    const g = makeGrid(spec, 1, (f, _t, r) => (f === 'wind' ? (r === 2 ? 25 : 0) : 0));
    const img = renderField(g, SCALES.wind, 0);
    expect(img.coordinates).toEqual([[-22, 70], [-21, 70], [-21, 50], [-22, 50]]);
    expect(img.rgba.length).toBe(img.width * img.height * 4);
    const alpha = (row: number) => img.rgba[(row * img.width + 1) * 4 + 3];
    expect(alpha(0)).toBeGreaterThan(150);
    expect(alpha(img.height - 1)).toBe(0);
    // Mercator stretches the north: the half north of 60° takes more than half the image's rows.
    const windy = Array.from({ length: img.height }, (_, r) => alpha(r)).filter((a) => a > 0).length;
    expect(windy).toBeGreaterThan(img.height / 2);
  });
});

describe('weather stations', () => {
  const stations = parseStations([
    { station: 1, name: 'Reykjavík', lat: 64.13, lon: -21.9, ele: 60.2, owner: ', Veðurstofa Íslands' },
    { station: 2, name: 'Hellisheiði', lat: 64.02, lon: -21.34, ele: 360, owner: 'Vegagerðin' },
    { station: 3, name: 'No place', owner: 'x' },
  ]);
  const now = Date.UTC(2026, 10, 2, 13);

  test('the list keeps placed stations and tidies owners', () => {
    expect(stations.map((s) => s.id)).toEqual([1, 2]);
    expect(stations[0].owner).toBe('Veðurstofa Íslands');
  });

  test('fresh readings become points labelled with wind (gust) and temperature, arrows pointing downwind', () => {
    const latest = parseLatest([
      { station: 1, time: '2026-11-02T12:40:00', t: 4.4, f: 11.1, fg: 14.6, d: 159, rh: 89, p: 1026.6, r: null },
      { station: 2, time: '2026-11-02T06:00:00', t: 1, f: 20, fg: 30, d: 90 },
      { station: 9, time: '2026-11-02T12:40:00', f: 3 },
    ]);
    expect(latest[0].time).toBe(Date.UTC(2026, 10, 2, 12, 40));
    const fc = stationFeatures(stations, latest, now);
    // Station 2's reading is 7 hours old; 9 isn't on the list.
    expect(now - latest[1].time).toBeGreaterThan(STALE_MS);
    expect(fc.features).toHaveLength(1);
    const p = fc.features[0].properties!;
    expect([p.wind, p.temp, p.rotate, p.hasDir]).toEqual(['11 (15)', '4°', 339, true]);
    expect(fc.features[0].geometry.coordinates).toEqual([-21.9, 64.13]);
  });

  test('windCompass points', () => {
    expect([windCompass(0), windCompass(159), windCompass(225), windCompass(359), windCompass(-90)]).toEqual(['N', 'SSE', 'SW', 'N', 'W']);
  });
});

describe('the hours chart', () => {
  const hours = { times: [0, 1, 2, 3].map((h) => Date.UTC(2026, 10, 2, 11 + h)), wind: [5, 8, NaN, 12], gust: [9, 12, 14, 18], temp: [-2, 0, 1, 3], rain: [0, 0.5, 2, 0] };

  test('draws the three strips, breaks lines at missing hours, marks the chosen hour', () => {
    const svg = chartSvg(hours, 1, () => 'x');
    expect(svg).toContain('class="wx-wind"');
    expect(svg).toContain('class="wx-temp"');
    expect((svg.match(/class="wx-rain"/g) ?? []).length).toBe(2);
    // The wind line restarts after the missing hour.
    const wind = /class="wx-wind" d="([^"]+)"/.exec(svg)![1];
    expect((wind.match(/M/g) ?? []).length).toBe(2);
    expect(svg).toContain(`x1="${xOf(1, 4)}"`);
    // Below freezing: the 0° line.
    expect(svg).toContain('class="wx-c0"');
  });

  test('a tap finds its hour', () => {
    expect(indexAtX(xOf(2, 4), 4)).toBe(2);
    expect(indexAtX(-50, 4)).toBe(0);
    expect(indexAtX(9999, 4)).toBe(3);
  });
});
