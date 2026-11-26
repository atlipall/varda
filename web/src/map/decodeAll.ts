import type { DecodeStats, RawObject } from '../img/rgn';
import type { Subdivision } from '../img/tre';
import type { GarminMap, MapTile } from './garminMap';

/** Visit every object of every subdivision that has data at a level with a zoom band, in file order
 *  (roads with their `roadTexts`). */
export async function decodeAll(
  map: GarminMap,
  visit: (tile: MapTile, sd: Subdivision, obj: RawObject) => void | false,
  opts: { bits?: number } = {},
): Promise<DecodeStats> {
  const stats: DecodeStats = { sections: 0, badSections: 0 };
  for (const tile of map.tiles) {
    const wanted = new Set([...tile.byLevel]
      .filter(([bits]) => map.bands.has(bits) && (opts.bits === undefined || bits === opts.bits))
      .flatMap(([, sds]) => sds));
    for (const sd of tile.tre.subdivisions) {
      if (!wanted.has(sd)) continue;
      for (const obj of await map.decode(tile, sd, { stats, roadTexts: true })) {
        if (visit(tile, sd, obj) === false) return stats;
      }
    }
  }
  return stats;
}
