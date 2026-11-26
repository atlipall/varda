import type { Place } from './places';

/** Point types (type << 8 | subtype) as used by GPSmap.is, in plain words. */
const POINT: Record<number, string> = {
  0x0e00: 'Neighbourhood', 0x1400: 'Region', 0x1e00: 'Region', 0x2800: 'Region',
  0x2a00: 'Restaurant', 0x2a05: 'Bakery', 0x2a07: 'Fast food', 0x2a0a: 'Pizza', 0x2a0e: 'Café',
  0x2b00: 'Accommodation', 0x2b01: 'Hotel', 0x2b03: 'Campsite',
  0x2c00: 'Attraction', 0x2c02: 'Museum', 0x2c03: 'Library', 0x2c04: 'Landmark', 0x2c05: 'School',
  0x2c07: 'Zoo', 0x2c09: 'Concert hall', 0x2c0b: 'Church',
  0x2d01: 'Theatre', 0x2d02: 'Bar', 0x2d03: 'Cinema', 0x2d05: 'Golf course', 0x2d06: 'Ski area',
  0x2d09: 'Swimming pool', 0x2d0a: 'Sports centre',
  0x2e02: 'Grocery', 0x2e03: 'Supermarket', 0x2e04: 'Shopping centre', 0x2e05: 'Pharmacy',
  0x2e08: 'Hardware store', 0x2e0b: 'Electronics store',
  0x2f01: 'Fuel station', 0x2f02: 'Car rental', 0x2f03: 'Car repair', 0x2f04: 'Airfield', 0x2f05: 'Post office',
  0x2f06: 'Bank', 0x2f0b: 'Parking', 0x2f0e: 'Car wash',
  0x3001: 'Police', 0x3002: 'Health centre', 0x3003: 'Town hall', 0x3005: 'Community centre',
  0x3007: 'Government office', 0x3008: 'Fire station',
  0x4c00: 'Information', 0x4d00: 'Parking', 0x4e00: 'Toilets', 0x5904: 'Helipad',
  0x6400: 'Lighthouse', 0x6401: 'Bridge', 0x6402: 'Farm or house', 0x6403: 'Cemetery', 0x6408: 'Hospital',
  0x6409: 'Skerry', 0x640a: 'Place name', 0x640e: 'Park', 0x6413: 'Tunnel',
  0x6508: 'Waterfall', 0x650a: 'Glacier', 0x650b: 'Harbour', 0x650c: 'Island', 0x650d: 'Lake',
  0x660a: 'Forest', 0x660e: 'Lava field', 0x6616: 'Peak',
};
/** Fallbacks by point type family (the type byte). */
const POINT_FAMILY: Record<number, string> = {
  0x2a: 'Restaurant', 0x2b: 'Accommodation', 0x2c: 'Attraction', 0x2d: 'Leisure', 0x2e: 'Shop',
  0x2f: 'Service', 0x30: 'Public service',
};
const LINE: Record<number, string> = {
  0x01: 'Highway', 0x02: 'Main road', 0x03: 'Road', 0x04: 'Road', 0x05: 'Road', 0x06: 'Street', 0x07: 'Street',
  0x09: 'Road', 0x0a: 'Unpaved road', 0x0c: 'Roundabout', 0x0d: 'Road', 0x11: 'Track', 0x12: 'Highland track',
  0x13: 'Track', 0x14: 'Trail', 0x16: 'Trail', 0x18: 'Stream', 0x1a: 'Ferry', 0x1e: 'Boundary', 0x1f: 'River',
  0x26: 'Stream', 0x28: 'Power line', 0x2a: 'Place name', 0x2b: 'Sea feature',
};
const POLYGON: Record<number, string> = {
  0x01: 'Town area', 0x02: 'Town area', 0x03: 'Town area', 0x05: 'Parking', 0x08: 'Site', 0x0b: 'Hospital',
  0x0c: 'Industrial area', 0x0d: 'Forest', 0x0e: 'Airport', 0x13: 'Building', 0x17: 'Park', 0x18: 'Golf course',
  0x19: 'Sports field', 0x1a: 'Cemetery', 0x1f: 'Town area', 0x20: 'Golf course', 0x28: 'Sea', 0x40: 'Swimming pool',
  0x3c: 'Lake', 0x3d: 'Lake', 0x3e: 'Lake', 0x3f: 'Lake', 0x41: 'Lake', 0x42: 'Lake', 0x43: 'Lake', 0x44: 'Lake',
  0x46: 'River', 0x47: 'River', 0x48: 'River', 0x4d: 'Glacier',
};

/** Garmin city point types: 0x01-0x0d (by size). */
export const isTownCode = (type: number) => type >> 8 >= 0x01 && type >> 8 <= 0x0d;
export const isTownType = (p: Place) => p.kind === 'point' && isTownCode(p.type);

export function placeCategory(p: Place): string {
  if (p.kind === 'point') {
    if (isTownType(p)) return 'Town';
    if (p.what) return p.what;
    return POINT[p.type] ?? POINT_FAMILY[p.type >> 8] ?? 'Place';
  }
  if (p.kind === 'line') {
    if (/^F\d+/i.test(p.name)) return 'F-road';
    return LINE[p.type] ?? 'Line';
  }
  return POLYGON[p.type] ?? 'Area';
}

/** "BORGARFJÖRÐUR EYSTRI" → "Borgarfjörður Eystri"; names in mixed case are left alone. */
export function titleCase(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

export interface Town { name: string; lon: number; lat: number }

/** The earth's mean radius, km. */
export const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const [dLat, dLon] = [rad(b[1] - a[1]), rad(b[0] - a[0])];
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, degrees clockwise from north. */
function bearing(a: [number, number], b: [number, number]): number {
  const dLon = rad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const octant = (deg: number) => Math.round((((deg % 360) + 360) % 360) / 45) % 8;
export const compass = (deg: number) => DIRS[octant(deg)];

function formatKm(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export interface PlaceDescription {
  category: string;
  /** Relation to the nearest town: "in X", "near X" or "25 km NE of X"; null without towns. */
  where: string | null;
  /** Distance and direction from `from`, e.g. "12 km ↗"; null without a reference point. */
  distance: string | null;
}

export function describePlace(p: Place, towns: Town[], from?: [number, number]): PlaceDescription {
  const at: [number, number] = [p.lon, p.lat];
  let where: string | null = null;
  let best: Town | null = null;
  let bestKm = Infinity;
  for (const t of towns) {
    const km = distanceKm([t.lon, t.lat], at);
    if (km < bestKm) [best, bestKm] = [t, km];
  }
  if (best && !(isTownType(p) && bestKm < 0.5)) {
    where = bestKm < 2 ? `in ${best.name}` : bestKm < 15 ? `near ${best.name}`
      : `${formatKm(bestKm)} ${compass(bearing([best.lon, best.lat], at))} of ${best.name}`;
  }
  const distance = from ? `${formatKm(distanceKm(from, at))} ${ARROWS[octant(bearing(from, at))]}` : null;
  return { category: placeCategory(p), where, distance };
}

/** Squared equirectangular distance: cheap and monotonic enough for ranking nearby hits. */
export function nearness(p: Place, from: [number, number]): number {
  const dx = (p.lon - from[0]) * Math.cos(rad(from[1]));
  const dy = p.lat - from[1];
  return dx * dx + dy * dy;
}

/** Drop hits that repeat an earlier hit's name and category within `km` (Garmin stores a long
 *  river or road as many named pieces); the earlier (better-ranked) hit stands for them all. */
export function collapseNearby(hits: Place[], km = 15): Place[] {
  const kept: Place[] = [];
  for (const p of hits) {
    // Points (farms, hills, huts) are kept: the same name 10 km apart is two places. Only roads,
    // rivers and areas, which the map stores in pieces, are collapsed.
    if (p.kind === 'point') {
      kept.push(p);
      continue;
    }
    const cat = placeCategory(p);
    const dup = kept.some((k) => k.name.toLowerCase() === p.name.toLowerCase() && placeCategory(k) === cat
      && distanceKm([k.lon, k.lat], [p.lon, p.lat]) < km);
    if (!dup) kept.push(p);
  }
  return kept;
}
