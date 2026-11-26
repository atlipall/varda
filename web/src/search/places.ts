import { mapUnitsToDeg } from '../img/bytes';
import { pairs, type Kind } from '../img/rgn';
import { decodeAll } from '../map/decodeAll';
import { objectLabel, objectName, type GarminMap } from '../map/garminMap';
import { CONTOUR_LINE_TYPES, isNumber } from '../map/zoom';
import { RoadClassCollector, roadClass, type RoadClasses } from '../routing/roadClass';
import { normalize } from './normalize';
import { polygonLabelAnchor } from '../tiles/buildTile';

export interface Place {
  name: string;
  lon: number;
  lat: number;
  kind: Kind;
  type: number;
  /** What the place is, when the map's label says so (Freizeitkarte: "Waterfall"). */
  what?: string;
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Midpoint of a coordinate array's bounding box. Loops rather than spreading into `Math.min`/
 * `Math.max` — a spread of more than ~130k arguments overflows V8's call stack (fewer on some
 * mobile engines), which would otherwise reject the whole `collectIndex` call on a large polygon
 * or line.
 */
export function bboxCenter(coords: Array<[number, number]>): [number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** The vertex of `coords` nearest `p`. */
function nearestVertex(coords: Array<[number, number]>, p: [number, number]): [number, number] {
  let best = coords[0];
  let d = Infinity;
  for (const c of coords) {
    const e = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    if (e < d) [best, d] = [c, e];
  }
  return best;
}

/** Named objects of the most detailed level, deduplicated by name within ~0.05°, plus the F-road/
 *  track class of every line whose class isn't 0, keyed by tile id and NET offset (Task 5). */
export async function collectIndex(map: GarminMap): Promise<{ places: Place[]; roads: RoadClasses }> {
  const bits = Math.max(...map.bands.keys());
  const seen = new Set<string>();
  const out: Place[] = [];
  const roads = new RoadClassCollector();
  await decodeAll(map, (tile, _sd, obj) => {
    if (obj.kind === 'line' && obj.labelSrc === 'net') roads.add(tile.id, obj.label, roadClass(obj.type, tile.labels.roadTexts(obj.label)));
    if (obj.kind === 'line' && CONTOUR_LINE_TYPES.has(obj.type)) return;
    const { name, what } = objectLabel(tile, obj);
    if (!name || isNumber(name)) return;
    let lon: number;
    let lat: number;
    if (obj.kind === 'point') {
      [lon, lat] = [mapUnitsToDeg(obj.xy[0]), mapUnitsToDeg(obj.xy[1])];
    } else {
      // A point on the feature: a line's vertex nearest its middle, an area's label point (the
      // middle of the bounding box can lie off a bent road or a crescent lake).
      const coords = pairs(obj.xy);
      const [x, y] = obj.kind === 'polygon' ? polygonLabelAnchor(coords) : nearestVertex(coords, bboxCenter(coords));
      lon = mapUnitsToDeg(x);
      lat = mapUnitsToDeg(y);
    }
    lon = round5(lon);
    lat = round5(lat);
    const key = `${normalize(name)}|${obj.kind}|${Math.round(lon * 20)}|${Math.round(lat * 20)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(what ? { name, lon, lat, kind: obj.kind, type: obj.type, what } : { name, lon, lat, kind: obj.kind, type: obj.type });
  }, { bits });
  return { places: out, roads: roads.roads };
}
