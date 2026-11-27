import { FREIZEITKARTE_CREDIT, splitTypeSuffix } from './freizeitkarte';

/**
 * How a map writes what the format leaves open, chosen once when the map is opened (by the name in
 * its IMG header). Everything else treats every map alike and just uses these.
 */
export interface MapConventions {
  /** A point's name and what it is, from its label as the map writes it. */
  pointLabel(label: string): { name: string | null; what?: string };
  /** The credit the map's licence asks for (HTML), or null. */
  credit: string | null;
  /** Line types of paths people walk that aren't in the routing network (walking routes use them
   *  as well as the roads). Garmin's trail type is 0x16; maps whose trails are roads of the
   *  routing network (Freizeitkarte's footpaths) need none. */
  trailLines: readonly number[];
}

const PLAIN: MapConventions = { pointLabel: (label) => ({ name: label }), credit: null, trailLines: [0x16] };

/** Freizeitkarte (free, OpenStreetMap-based): "Dettifoss (Waterfall)" labels, and a credit. */
const FREIZEITKARTE: MapConventions = { pointLabel: splitTypeSuffix, credit: FREIZEITKARTE_CREDIT, trailLines: [] };

/** GPSmap.is draws its hiking trails as 0x14 (Garmin's railway type; Iceland has none). */
const GPSMAP_IS: MapConventions = { ...PLAIN, trailLines: [0x14, 0x16] };

export function conventionsFor(description: string): MapConventions {
  if (/^Freizeitkarte/i.test(description)) return FREIZEITKARTE;
  return /GPSmap\.is/i.test(description) ? GPSMAP_IS : PLAIN;
}
