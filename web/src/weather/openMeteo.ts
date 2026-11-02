import { FIELDS, gridPoints, type Field, type GridSpec, type WeatherGrid } from './grid';

/**
 * Weather from Open-Meteo (open-meteo.com: free, no key, answers browsers directly; CC BY 4.0).
 * Forecasts and the last three months come from its forecast API, preferring DMI's HARMONIE model
 * (about 2 km over Iceland, 2.5 days ahead) and filling in from ECMWF's (25 km, a week and more).
 * Older days come from its archive (ERA5 reanalysis, 1940 on).
 */

export const FORECAST_HOST = 'https://api.open-meteo.com';
export const ARCHIVE_HOST = 'https://archive-api.open-meteo.com';

/** The forecast API's models, best first: an hour takes the first one that has it. */
const MODELS = ['dmi_harmonie_arome_europe', 'ecmwf_ifs025'];

/** Open-Meteo's names for the fields. */
const VARS: Record<Field, string> = {
  temp: 'temperature_2m',
  rain: 'precipitation',
  cloud: 'cloud_cover',
  wind: 'wind_speed_10m',
  gust: 'wind_gusts_10m',
  dir: 'wind_direction_10m',
};

/** How far back the forecast API keeps its hours (days); older ones are in the archive. */
const FORECAST_PAST_DAYS = 90;

/** What to fetch: the forecast (yesterday to a week ahead), or one past day (UTC, YYYY-MM-DD). */
export type Period = { kind: 'forecast' } | { kind: 'day'; date: string };

const DAY = 86_400_000;

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The address for `period` at the grid's points. `now` decides whether a past day is in the
 *  forecast API's reach or the archive's. */
export function weatherUrl(spec: GridSpec, period: Period, now = Date.now()): string {
  const pts = gridPoints(spec);
  const q = new URLSearchParams({
    latitude: pts.map((p) => p[1]).join(','),
    longitude: pts.map((p) => p[0]).join(','),
    hourly: FIELDS.map((f) => VARS[f]).join(','),
    wind_speed_unit: 'ms',
    timezone: 'GMT',
  });
  if (period.kind === 'forecast') {
    q.set('models', MODELS.join(','));
    q.set('past_days', '1');
    q.set('forecast_days', '7');
    return `${FORECAST_HOST}/v1/forecast?${q}`;
  }
  q.set('start_date', period.date);
  q.set('end_date', period.date);
  if (Date.parse(period.date) >= now - FORECAST_PAST_DAYS * DAY) {
    q.set('models', MODELS.join(','));
    return `${FORECAST_HOST}/v1/forecast?${q}`;
  }
  return `${ARCHIVE_HOST}/v1/archive?${q}`;
}

interface PointAnswer {
  hourly?: Record<string, Array<number | null> | string[]>;
  error?: boolean;
  reason?: string;
}

/** The answer (one object for one point, an array for several) as a grid; throws on an error
 *  answer or one that doesn't fit the grid. */
export function parseWeather(spec: GridSpec, body: unknown, fetched = Date.now()): WeatherGrid {
  const answer = body as PointAnswer | PointAnswer[];
  if (!Array.isArray(answer) && answer?.error) throw new Error(answer.reason ?? 'The weather service gave an error.');
  const points = Array.isArray(answer) ? answer : [answer];
  const n = spec.rows * spec.cols;
  if (points.length !== n) throw new Error(`Expected ${n} places from the weather service, got ${points.length}.`);
  const timesText = points[0]?.hourly?.time as string[] | undefined;
  if (!timesText?.length) throw new Error('The weather service sent no hours.');
  const times = timesText.map((t) => Date.parse(`${t}Z`));
  const values = Object.fromEntries(FIELDS.map((f) => [f, new Float32Array(times.length * n).fill(NaN)])) as Record<Field, Float32Array>;
  const used = new Set<string>();
  points.forEach((p, i) => {
    const hourly = p.hourly ?? {};
    for (const f of FIELDS) {
      // With models asked for, each has its own series ("…_dmi_harmonie_arome_europe"); without, one.
      const series = [...MODELS.map((m) => [m, hourly[`${VARS[f]}_${m}`]] as const), ['', hourly[VARS[f]]] as const]
        .filter((s): s is readonly [string, Array<number | null>] => Array.isArray(s[1]));
      const out = values[f];
      for (let t = 0; t < times.length; t++) {
        for (const [model, s] of series) {
          const v = s[t];
          if (v === null || v === undefined) continue;
          out[t * n + i] = v;
          if (f === 'wind') used.add(model);
          break;
        }
      }
    }
  });
  return { ...spec, times, values, source: sourceName(used), fetched };
}

function sourceName(used: Set<string>): string {
  const names = [];
  if (used.has('dmi_harmonie_arome_europe')) names.push('DMI HARMONIE');
  if (used.has('ecmwf_ifs025')) names.push('ECMWF');
  if (used.has('')) names.push('ERA5');
  return names.join(', ');
}

/** Fetches `period` for the grid. Rejects when offline or on an error answer. */
export async function fetchWeather(spec: GridSpec, period: Period, signal?: AbortSignal): Promise<WeatherGrid> {
  const res = await fetch(weatherUrl(spec, period), { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as PointAnswer | null)?.reason ?? `The weather service answered ${res.status}.`);
  return parseWeather(spec, body);
}
