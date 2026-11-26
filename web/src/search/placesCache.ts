import type { Kind } from '../img/rgn';
import type { RoadClasses } from '../routing/roadClass';
import type { Place } from './places';

/** Compact on-disk form of a `Place`: [name, lon, lat, kindCode, type, what?]. */
type PackedPlace = [string, number, number, number, number, string?];
/** Kind codes, on disk (here and in places.bin). */
export const KINDS: Kind[] = ['point', 'line', 'polygon'];
const PLACES_VERSION = 3;

/** Returns null (a cache miss) for another map's cache, an old/unknown format, corrupt JSON, or a
 *  `roads` field that isn't a plain object of `[NET offset, class]` pairs. */
export function decodePlacesCache(text: string, key: string): { places: Place[]; roads: RoadClasses } | null {
  try {
    const parsed = JSON.parse(text) as { key?: unknown; v?: unknown; places?: unknown; roads?: unknown };
    if (parsed.key !== key || parsed.v !== PLACES_VERSION || !Array.isArray(parsed.places)) return null;
    const out: Place[] = [];
    for (const row of parsed.places as unknown[]) {
      if (!Array.isArray(row) || (row.length !== 5 && row.length !== 6)) return null;
      const [name, lon, lat, kindCode, type, what] = row as PackedPlace;
      const kind = KINDS[kindCode];
      if (typeof name !== 'string' || typeof lon !== 'number' || typeof lat !== 'number' || !kind || typeof type !== 'number') return null;
      if (row.length === 6 && typeof what !== 'string') return null;
      out.push(what ? { name, lon, lat, kind, type, what } : { name, lon, lat, kind, type });
    }
    const roads = decodeRoadClasses(parsed.roads);
    if (!roads) return null;
    return { places: out, roads };
  } catch {
    return null;
  }
}

/** Accepts only a plain object whose values are arrays of `[NET offset, 1|2|3]` pairs; anything
 *  else (including a missing field) is treated as invalid, so the whole places cache is rebuilt. */
export function decodeRoadClasses(value: unknown): RoadClasses | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: RoadClasses = {};
  for (const [tileId, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entries)) return null;
    const list: Array<[number, 1 | 2 | 3]> = [];
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [offset, cls] = entry as [unknown, unknown];
      if (typeof offset !== 'number' || (cls !== 1 && cls !== 2 && cls !== 3)) return null;
      list.push([offset, cls]);
    }
    out[tileId] = list;
  }
  return out;
}
