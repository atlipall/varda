import type { Place } from '../app/session';
import type { LonLat, RouteReply } from '../routing/plan';
import type { JoinedRoute } from '../routing/waypoints';
import { run } from '../storage/idb';

/** The route as drawn when it was saved (what `planRoute` returned). */
export type RouteOk = Extract<RouteReply, { status: 'ok' }>;
export type { JoinedRoute };

interface Common {
  id: string;
  name: string;
  /** When it was saved (ms): the list order. */
  added: number;
  /** When it was last changed (ms), for syncing; none: never changed. */
  updated?: number;
}

export interface SavedPin extends Common {
  kind: 'pin';
  lon: number;
  lat: number;
}

/** A route as drawn, with where it went, where it started and the switches it was planned with. */
export interface SavedRoute extends Common {
  kind: 'route';
  dest: { name: string | null; lon: number; lat: number };
  from: LonLat;
  /** Waypoints, in route order (none in routes saved before waypoints). */
  vias?: Place[];
  allowFRoads: boolean;
  preferFRoads: boolean;
  route: JoinedRoute;
}

export type Saved = SavedPin | SavedRoute;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLonLat = (v: unknown): v is LonLat => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isLine = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && v.every(isLonLat);
const isLeg = (v: unknown) => v === null || v === undefined || isLine(v);
const isPlace = (v: unknown) => {
  const p = v as { name: unknown; near?: unknown; lon: unknown; lat: unknown };
  return !!p && (p.name === null || typeof p.name === 'string') && (p.near === undefined || typeof p.near === 'string') && isNum(p.lon) && isNum(p.lat);
};
/** Road stretches that fit their line (a stretch starting outside it would hang turn-by-turn). */
const isSegs = (v: unknown, points: number) => v === undefined || (Array.isArray(v) && v.every((s, i) =>
  !!s && Number.isInteger(s.start) && s.start >= 0 && s.start < points && (i === 0 || s.start >= v[i - 1].start)
  && (s.name === null || typeof s.name === 'string') && isNum(s.type) && typeof s.junction === 'boolean' && isNum(s.seconds) && s.seconds >= 0
  && (s.via === undefined || (Number.isInteger(s.via) && s.via > 0))));

/** A stored item that looks right (an older or damaged entry is left out of the list). */
export function isSaved(v: unknown): v is Saved {
  const s = v as Saved;
  if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || !isNum(s.added)) return false;
  if (s.kind === 'pin') return isNum(s.lon) && isNum(s.lat);
  if (s.kind !== 'route') return false;
  const r = s.route;
  const vias = s.vias === undefined || (Array.isArray(s.vias) && s.vias.every(isPlace));
  return vias && isPlace(s.dest) && isLonLat(s.from) && typeof s.allowFRoads === 'boolean' && typeof s.preferFRoads === 'boolean'
    && !!r && r.status === 'ok' && isLine(r.coords) && isNum(r.metres) && isNum(r.seconds)
    && isLeg(r.offRoadStart) && isLeg(r.offRoadEnd) && isSegs(r.segs, r.coords.length);
}

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const listSaved = async (): Promise<Saved[]> =>
  (await run('saved', 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>)).filter(isSaved).sort((a, b) => a.added - b.added);

export const putSaved = (item: Saved): Promise<unknown> => run('saved', 'readwrite', (s) => s.put(item));

export const deleteSaved = (id: string): Promise<unknown> => run('saved', 'readwrite', (s) => s.delete(id));
