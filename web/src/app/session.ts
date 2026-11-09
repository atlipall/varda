import type { LocationState } from '../location/modes';
import { storageName } from '../channel';

/** A place a route goes to (a search result, a dropped pin or a saved pin: `saved`). */
export interface Place {
  name: string | null;
  lon: number;
  lat: number;
  saved?: boolean;
  /** For a dropped pin: the named feature it was dropped on (a peak, river, lake…). */
  near?: string;
}

/** The route card as it was: the place, and when routed, where from (a point, or null for your
 *  position). */
export interface SessionRoute {
  dest: Place;
  routed: boolean;
  from: [number, number] | null;
  /** Waypoints, in route order (none in sessions saved before waypoints). */
  vias?: Place[];
  /** Where the route last started (also for one from your position). */
  at?: [number, number];
}

/** What the app brings back after iOS closes it (or it's reopened): the map view, location mode
 *  and route card. Kept across maps (several are stored; switching keeps the view). */
export interface Session {
  /** The map it was saved with (its directory). */
  map: string;
  view: { center: [number, number]; zoom: number; bearing: number };
  location: LocationState;
  route: SessionRoute | null;
}

const KEY = storageName('session');

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLonLat = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isPlace = (v: unknown): v is Place => {
  const p = v as Place;
  return !!p && (p.name === null || typeof p.name === 'string') && isNum(p.lon) && isNum(p.lat);
};

/** The stored session, or null when there's none or it doesn't look right (an older format,
 *  hand-edited storage). */
export function parseSession(raw: string | null): Session | null {
  if (!raw) return null;
  let s: Session;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!s) return null;
  const map = typeof s.map === 'string' ? s.map : '';
  const v = s.view;
  if (!v || !isLonLat(v.center) || !isNum(v.zoom) || !isNum(v.bearing)) return null;
  const l = s.location;
  if (!l || !['off', 'north', 'heading'].includes(l.mode) || typeof l.paused !== 'boolean') return null;
  const r = s.route;
  if (r !== null && (!r || !isPlace(r.dest) || typeof r.routed !== 'boolean' || (r.from !== null && !isLonLat(r.from)) || (r.vias !== undefined && !(Array.isArray(r.vias) && r.vias.every(isPlace))) || (r.at !== undefined && !isLonLat(r.at)))) return null;
  return { map, view: { center: v.center, zoom: v.zoom, bearing: v.bearing }, location: { mode: l.mode, paused: l.paused }, route: r && { dest: r.dest, routed: r.routed, from: r.from, vias: r.vias ?? [], ...(r.at ? { at: r.at } : {}) } };
}

export function loadSession(): Session | null {
  try {
    return parseSession(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered (private mode, full storage); the app works as before
  }
}
