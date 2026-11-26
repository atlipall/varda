import type { GarminMap } from '../map/garminMap';
import { EDGE_FROAD, GraphBuilder, TOP_RANK, type RoadGraph } from './graph';
import { parseNodHeader, readNodes, type NodNode } from './nod';
import { CLASS_CAP_KMH, type RoadClass, type RoadClasses } from './roadClass';

/** Garmin road speed classes (Table A bits 0-2) in km/h, as mkgmap documents them. */
export const SPEED_CLASS_KMH = [5, 20, 40, 60, 80, 90, 110, 128];
/** NOD arc lengths are in units of 2.4 m (mkgmap's UNIT_TO_METER; straight direct arcs on
 *  GPSmap.is measure 2.41 m), times 2 to the power of header flag bits 5-7 (mkgmap's
 *  DISTANCE_MULT_SHIFT, `flags |= shift << 5`): 0 on GPSmap.is (flags 0x203), 1 on mkgmap's
 *  default (0x227: Freizeitkarte, OpenTopoMap, whose straight arcs measure 4.7 m a unit). */
export const NOD_UNIT_M = 2.4;

/** Table A access bit: closed to cars (mkgmap's TABAACCESS_FLAG_NO_CAR). Footpaths on OSM-based
 *  maps carry it; so do a few closed tracks and pedestrian streets on GPSmap.is. */
export const ACCESS_NO_CAR = 0x01;

export function nodUnitM(flags: number): number {
  return NOD_UNIT_M * 2 ** ((flags >> 5) & 7);
}

/**
 * Adds one tile's routing nodes to the graph: each direct arc becomes an edge with Garmin's length
 * and speed class (capped by road class), except arcs running against a one-way road and arcs of
 * roads closed to cars. Tiles join
 * where boundary nodes share coordinates (the builder dedupes nodes by position).
 */
export function addTileNetwork(b: GraphBuilder, nodes: Map<number, NodNode>, classes: Map<number, RoadClass>, tile: number, unitM = NOD_UNIT_M): void {
  for (const n of nodes.values()) {
    // Made at its first usable arc: nodes on footpaths only (a million on Freizeitkarte Denmark)
    // stay out of the graph.
    let u = -1;
    for (const a of n.arcs) {
      if (!a.direct) continue;
      if (a.info & 0x08 && !a.forward) continue;
      if (a.access & ACCESS_NO_CAR) continue;
      const t = nodes.get(a.target);
      if (!t) continue;
      const cls = classes.get(a.net) ?? 0;
      const kmh = Math.min(SPEED_CLASS_KMH[a.info & 7], CLASS_CAP_KMH[cls]);
      if (u < 0) u = b.node(n.x, n.y);
      b.edge(u, b.node(t.x, t.y), a.length * unitM, kmh, cls ? EDGE_FROAD : 0, null, { tile, net: a.net }, Math.min(TOP_RANK, (a.info >> 4) & 7));
    }
  }
}

/** The whole map's routing network from its NOD subfiles. */
export async function buildNetwork(map: GarminMap, classes: RoadClasses): Promise<RoadGraph> {
  const b = new GraphBuilder();
  for (const [i, tile] of map.tiles.entries()) {
    const nod = await map.readSubfile(`${tile.id}.NOD`);
    if (!nod) continue;
    const hdr = parseNodHeader(nod);
    const nodes = readNodes(nod.subarray(hdr.nod1.offset, hdr.nod1.offset + hdr.nod1.length), nod.subarray(hdr.nod2.offset, hdr.nod2.offset + hdr.nod2.length), hdr);
    addTileNetwork(b, nodes, new Map(classes[tile.id] ?? []), i, nodUnitM(hdr.flags));
  }
  return b.build();
}
