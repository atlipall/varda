import type * as maplibregl from 'maplibre-gl';
import { titleCase } from '../search/describe';
import { isAreaLayer, isLineLayer, POINTS } from '../style/sourceLayers';

/** The named map feature at screen point `p`, for naming a pin: the nearest named point (peak,
 *  hut…) within 30 px, else a named line (river, road) within 12 px, else the named area (lake,
 *  glacier…) it's in. Numbers (contour heights, house numbers) don't count. */
export function featureNameAt(map: maplibregl.Map, p: maplibregl.Point): string | undefined {
  const named = (f: maplibregl.MapGeoJSONFeature, key: string) => {
    const v = f.properties?.[key];
    if (f.source !== 'garmin' || typeof v !== 'string' || /^[\d\s.,-]+$/.test(v)) return null;
    // Map labels are often in capitals with a height: "HEKLA 1491m" → "Hekla 1491m".
    const m = /^(.*?)(\s+\d+\s?m)?$/.exec(v)!;
    return titleCase(m[1]) + (m[2] ?? '');
  };
  const box = (r: number): [maplibregl.PointLike, maplibregl.PointLike] => [[p.x - r, p.y - r], [p.x + r, p.y + r]];
  let best: { name: string; d: number } | null = null;
  // Named features only: a town's unnamed streets are thousands of parts to hand over.
  const withName = { filter: ['has', 'name'] as maplibregl.FilterSpecification };
  for (const f of map.queryRenderedFeatures(box(30), withName)) {
    const name = named(f, 'name');
    if (!name || f.sourceLayer !== POINTS || f.geometry.type !== 'Point') continue;
    const q = map.project(f.geometry.coordinates as [number, number]);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= 30 && (!best || d < best.d)) best = { name, d };
  }
  if (best) return best.name;
  for (const f of map.queryRenderedFeatures(box(12), withName)) {
    const name = isLineLayer(f.sourceLayer) ? named(f, 'name') : null;
    if (name) return name;
  }
  for (const f of map.queryRenderedFeatures(p, { filter: ['has', 'n'] })) {
    const name = isAreaLayer(f.sourceLayer) ? named(f, 'n') : null;
    if (name) return name;
  }
  return undefined;
}
