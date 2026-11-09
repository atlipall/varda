/** The stored maps and elevation sets, and the choices between them (no storage access here; see
 *  store.ts and storageWorker.ts for the OPFS side and the spec
 *  docs/superpowers/specs/2026-11-09-multiple-maps-design.md for the layout). */
import { HGT_STEP } from '../dem/hgt';

/** West, south, east, north in degrees. */
export type Bounds = [number, number, number, number];

/** An elevation set: .hgt files (one per 1° square) and their overview, in a directory of its own
 *  (`elevation-<ts>`) or in an older version's map directory (`garmin-<ts>/dem`). The id is that
 *  path. */
export interface SetInfo {
  id: string;
  name: string;
  /** The stored file names (a replaced square has a `.<ts>` before `.hgt`; see canonicalHgtName). */
  files: string[];
  /** Samples per degree of the finest file: 1200 (3″) or 3600 (1″). */
  step: number;
  /** The overview's file in the set's directory. */
  overview: string;
  bytes: number;
  squares: Array<{ south: number; west: number }>;
}

export interface MapInfo {
  /** Its directory, `garmin-<ts>` (or `garmin` from the first versions). */
  id: string;
  name: string;
  imgName: string;
  bytes: number;
  /** When it was added (ms), from the directory name; 0 when unknown. */
  added: number;
  bounds: Bounds | null;
  /** The chosen elevation set: an id, null for none, undefined for the one that covers it best. */
  elevation: string | null | undefined;
}

/** What the user chose, in `maps.json`: names, and each map's hillshading. Maps learn their area
 *  on first open (older maps' meta.json has none), kept here too. */
export interface Choices {
  maps: Record<string, { name?: string; elevation?: string | null; bounds?: Bounds }>;
  sets: Record<string, { name?: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isBounds = (v: unknown): v is Bounds => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** `maps.json`, keeping only what looks right (hand-edited or older files never break the app). */
export function parseChoices(text: string | null): Choices {
  const out: Choices = { maps: {}, sets: {} };
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return out;
  }
  if (!isObj(raw)) return out;
  if (isObj(raw.maps)) {
    for (const [id, v] of Object.entries(raw.maps)) {
      if (!isObj(v)) continue;
      const m: Choices['maps'][string] = {};
      if (typeof v.name === 'string') m.name = v.name;
      if (v.elevation === null || typeof v.elevation === 'string') m.elevation = v.elevation;
      if (isBounds(v.bounds)) m.bounds = v.bounds;
      out.maps[id] = m;
    }
  }
  if (isObj(raw.sets)) {
    for (const [id, v] of Object.entries(raw.sets)) {
      if (isObj(v)) out.sets[id] = typeof v.name === 'string' ? { name: v.name } : {};
    }
  }
  return out;
}

export interface SetJson {
  name: string;
  /** The .hgt files; none: elevation an older version kept that couldn't be read (left alone). */
  files: string[];
  step: number;
  /** The overview's file (a new name each time files are added: a map may be reading the last). */
  overview: string;
  /** The files' size (sets written before it was kept: unknown). */
  bytes?: number;
}

/** A set's `set.json` (written last: a set without it is unfinished), or null. */
export function parseSetJson(text: string | null): SetJson | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    if (!isObj(s) || s.version !== 1 || typeof s.name !== 'string' || !Array.isArray(s.files) || !s.files.every((f) => typeof f === 'string') || typeof s.step !== 'number') return null;
    return {
      name: s.name,
      files: s.files as string[],
      step: s.step,
      overview: typeof s.overview === 'string' ? s.overview : 'overview.bin',
      ...(typeof s.bytes === 'number' ? { bytes: s.bytes } : {}),
    };
  } catch {
    return null;
  }
}

/** The SRTM name of a stored file: a square replaced by "Add more files" is stored as
 *  `n64w019.<ts>.hgt` until the old file is gone, and read as `n64w019.hgt`. */
export const canonicalHgtName = (stored: string) => stored.replace(/^([ns]\d{2}[ew]\d{3})\.\d+\.hgt$/i, '$1.hgt');

export const defaultSetName = (step: number, n: number) => `${step > HGT_STEP ? '1″' : '3″'} elevation · ${filesText(n)}`;

/** How much of the map's area the set has elevation for, 0 to 1. A map's area is a rectangle that
 *  takes in sea (and runs a little past whole degrees) where there are no elevation files, so a
 *  set made for the map covers most of it rather than all (GPSmap.is and its files: 85%). */
export function coverage(set: Pick<SetInfo, 'squares'>, b: Bounds): number {
  const [w, s, e, n] = b;
  const area = (e - w) * (n - s);
  if (area <= 0) return 0;
  let covered = 0;
  for (const q of set.squares) {
    const dx = Math.min(e, q.west + 1) - Math.max(w, q.west);
    const dy = Math.min(n, q.south + 1) - Math.max(s, q.south);
    if (dx > 0 && dy > 0) covered += dx * dy;
  }
  return Math.min(1, covered / area);
}

/** From this share of its area on, a set is said to cover a map. */
export const COVERS = 0.75;

export function coverageText(c: number): string {
  if (c >= COVERS) return 'Covers this map';
  return c > 0 ? 'Covers part of this map' : "Doesn't cover this map";
}

/** The set a map uses when none was chosen: the one covering most of it, then the finer, then the
 *  newest. None when nothing covers it (or its area isn't known yet). */
export function autoSet(sets: SetInfo[], b: Bounds | null): SetInfo | null {
  if (!b) return null;
  let best: { s: SetInfo; c: number } | null = null;
  for (const s of sets) {
    const c = coverage(s, b);
    if (c <= 0) continue;
    if (!best || c > best.c || (c === best.c && (s.step > best.s.step || (s.step === best.s.step && s.id > best.s.id)))) best = { s, c };
  }
  return best?.s ?? null;
}

/** The set a map draws its hillshading from: the chosen one, none when Off was chosen, else (no
 *  choice, or the chosen set was removed) the best covering one. */
export function elevationFor(map: MapInfo, sets: SetInfo[]): SetInfo | null {
  if (map.elevation === null) return null;
  return sets.find((s) => s.id === map.elevation) ?? autoSet(sets, map.bounds);
}

/** A map's name from its file's: the file name without `.img`. */
export const mapName = (imgName: string) => imgName.replace(/\.img$/i, '');

/** "48 files", "1 file". */
export const filesText = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** What a map's hillshading is drawn from, as shown under its name. */
export const hillshadingText = (set: { name: string } | null) => (set ? `Hillshading ${set.name}` : 'No hillshading');

export const contains = (b: Bounds, [lon, lat]: [number, number]) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
