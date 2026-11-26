import { emptyTyp, parseTyp, type Typ } from '../img/typ';
import { LINE_STYLES } from './fallback';

/**
 * The vector tiles' layers. MapLibre tests every style layer's filter against every feature of its
 * source layer, and a map's style has a layer for each line and area type (Freizeitkarte Denmark:
 * 236 on lines, 82 on areas): with all lines in one layer, a busy tile took millions of filter
 * tests. So each line and area type has a layer of its own, which its style layers draw without a
 * filter.
 */
export const POINTS = 'points';
/** Contour lines, all types together: nearly all are named, and their labels need one layer. */
export const CONTOURS = 'contours';
/** Lines of types the style has no layer for (drawn by `ln-other`). */
export const OTHER_LINES = 'l-other';
/** A copy of the named lines other than contours, for their labels (one layer for all types, so
 *  labels are placed as before). */
export const LINE_NAMES = 'line-names';
/** The label points of named areas. */
export const AREA_LABELS = 'area-labels';
export const lineLayer = (t: number) => `l${t}`;
export const areaLayer = (t: number) => `p${t}`;

/** Bumped when the tiles' layout changes, so a server's cached tiles aren't drawn with a new style. */
export const TILE_FORMAT = 2;

export const isLineLayer = (name: string | undefined) => name !== undefined && /^l(\d+|-other)$|^contours$|^line-names$/.test(name);
export const isAreaLayer = (name: string | undefined) => name !== undefined && /^p\d+$/.test(name);

/** The line types the style gives a layer of their own (all others are drawn by `ln-other`). */
export const styledLineTypes = (typ: Typ): Set<number> => new Set([...typ.lines.keys(), ...LINE_STYLES.keys()]);

const fromBytes = new WeakMap<Uint8Array | object, Set<number>>();
const NO_TYP = {};

/** `styledLineTypes` for a map's TYP file (or none), read once per file. A TYP that can't be read
 *  counts as none, as the style does then. */
export function styledLineTypesOf(typ: Uint8Array | null): Set<number> {
  const key = typ ?? NO_TYP;
  let types = fromBytes.get(key);
  if (!types) {
    let parsed: Typ;
    try {
      parsed = typ ? parseTyp(typ) : emptyTyp();
    } catch {
      parsed = emptyTyp();
    }
    types = styledLineTypes(parsed);
    fromBytes.set(key, types);
  }
  return types;
}
