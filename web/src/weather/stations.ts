/**
 * Measured weather at Veðurstofa Íslands' automatic stations (api.vedur.is, CC BY 4.0), the Road
 * Administration's and Landsvirkjun's included: the latest 10-minute values, all stations in one
 * request. Its station list holds the places.
 */

const VEDUR_HOST = 'https://api.vedur.is';
export const STATIONS_URL = `${VEDUR_HOST}/weather/stations?active=true`;
export const LATEST_URL = `${VEDUR_HOST}/weather/observations/aws/10min/latest`;

export interface Station {
  id: number;
  name: string;
  owner: string;
  lon: number;
  lat: number;
  /** Height above sea (m). */
  ele: number | null;
}

export interface Observation {
  station: number;
  /** When measured (ms, UTC). */
  time: number;
  /** Temperature (°C), mean wind (m/s), strongest gust (m/s), direction it comes from (degrees). */
  t: number | null;
  f: number | null;
  fg: number | null;
  d: number | null;
  /** Relative humidity (%), sea-level pressure (hPa). */
  rh: number | null;
  p: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseStations(body: unknown): Station[] {
  if (!Array.isArray(body)) throw new Error('Unexpected station list.');
  return body.flatMap((s) => {
    const lon = num(s?.lon);
    const lat = num(s?.lat);
    if (lon === null || lat === null || typeof s?.station !== 'number') return [];
    // Owners come with stray commas (", Veðurstofa Íslands").
    const owner = String(s.owner ?? '').split(',').map((o: string) => o.trim()).filter(Boolean).join(', ');
    return [{ id: s.station, name: String(s.name ?? ''), owner, lon, lat, ele: num(s.ele) }];
  });
}

export function parseLatest(body: unknown): Observation[] {
  if (!Array.isArray(body)) throw new Error('Unexpected observations.');
  return body.flatMap((o) => {
    // "2026-11-02T12:40:00" is UTC (Iceland's time).
    const time = typeof o?.time === 'string' ? Date.parse(`${o.time}Z`) : NaN;
    if (typeof o?.station !== 'number' || Number.isNaN(time)) return [];
    return [{ station: o.station, time, t: num(o.t), f: num(o.f), fg: num(o.fg), d: num(o.d), rh: num(o.rh), p: num(o.p) }];
  });
}

/** Observations older than this are left off the map (a station that stopped sending). */
export const STALE_MS = 3 * 3_600_000;

/** The stations with a fresh observation, as map points. */
export function stationFeatures(stations: Station[], latest: Observation[], now = Date.now()): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const byId = new Map(stations.map((s) => [s.id, s]));
  return {
    type: 'FeatureCollection',
    features: latest.flatMap((o) => {
      const s = byId.get(o.station);
      if (!s || now - o.time > STALE_MS) return [];
      return [{
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        properties: {
          id: s.id,
          // What the map labels: wind as "12 (18)" (mean, gust), temperature as "4°".
          wind: o.f === null ? '' : o.fg === null ? `${Math.round(o.f)}` : `${Math.round(o.f)} (${Math.round(o.fg)})`,
          temp: o.t === null ? '' : `${Math.round(o.t)}°`,
          speed: o.f ?? 0,
          // An arrow points where the wind goes: opposite to where it comes from.
          rotate: o.d === null ? 0 : (o.d + 180) % 360,
          hasDir: o.d !== null && (o.f ?? 0) > 0,
        },
      }];
    }),
  };
}

/** Compass point names for a direction the wind comes from. */
export function windCompass(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}
