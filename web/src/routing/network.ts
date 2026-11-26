import type { GarminMap } from '../map/garminMap';
import { EDGE_FROAD, GraphBuilder, TOP_RANK, type RoadGraph } from './graph';
import { eachNode, NodeRecord, nodePosition, parseNodHeader, type NodNode } from './nod';
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

/** A tile's nodes by NOD1 offset: whether there's one at `off`, and its graph node (made in the
 *  builder at its position on first use). */
interface TileNodes {
  has(off: number): boolean;
  id(off: number): number;
}

/** One node's arcs as edges (see addTileNetwork). */
function addArcs(b: GraphBuilder, n: NodeRecord, nodes: TileNodes, classes: Map<number, RoadClass>, tile: number, unitM: number): void {
  // Made at its first usable arc: nodes on footpaths only (a million on Freizeitkarte Denmark)
  // stay out of the graph.
  let u = -1;
  for (let k = 0; k < n.count; k++) {
    if (!n.direct[k]) continue;
    const info = n.info[k];
    if (info & 0x08 && !n.forward[k]) continue;
    if (n.access[k] & ACCESS_NO_CAR) continue;
    if (!nodes.has(n.target[k])) continue;
    const net = n.net[k];
    const cls = classes.get(net) ?? 0;
    const kmh = Math.min(SPEED_CLASS_KMH[info & 7], CLASS_CAP_KMH[cls]);
    if (u < 0) u = nodes.id(n.offset);
    b.roadEdge(u, nodes.id(n.target[k]), n.length[k] * unitM, kmh, cls ? EDGE_FROAD : 0, tile, net, Math.min(TOP_RANK, (info >> 4) & 7));
  }
}

/**
 * Adds one tile's routing nodes to the graph: each direct arc becomes an edge with Garmin's length
 * and speed class (capped by road class), except arcs running against a one-way road and arcs of
 * roads closed to cars. Tiles join
 * where boundary nodes share coordinates (the builder dedupes nodes by position).
 */
export function addTileNetwork(b: GraphBuilder, nodes: Map<number, NodNode>, classes: Map<number, RoadClass>, tile: number, unitM = NOD_UNIT_M): void {
  const rec = new NodeRecord();
  const byOffset: TileNodes = {
    has: (off) => nodes.has(off),
    id: (off) => b.node(nodes.get(off)!.x, nodes.get(off)!.y),
  };
  for (const n of nodes.values()) {
    rec.offset = n.offset;
    rec.count = n.arcs.length;
    n.arcs.forEach((a, k) => {
      rec.target[k] = a.target;
      rec.length[k] = a.length;
      rec.forward[k] = a.forward ? 1 : 0;
      rec.direct[k] = a.direct ? 1 : 0;
      rec.net[k] = a.net;
      rec.info[k] = a.info;
      rec.access[k] = a.access;
    });
    addArcs(b, rec, byOffset, classes, tile, unitM);
  }
}

/** The whole map's routing network from its NOD subfiles, decoded straight into the graph: no
 *  object per node or arc (3.67 million nodes on Freizeitkarte Denmark), and each node's graph id
 *  kept by its NOD1 offset while its tile is read, so a node is looked up by position once. The
 *  same graph, node for node and edge for edge, as readNodes + addTileNetwork make. */
export async function buildNetwork(map: GarminMap, classes: RoadClasses): Promise<RoadGraph> {
  const b = new GraphBuilder();
  const at = { x: 0, y: 0 };
  for (const [i, tile] of map.tiles.entries()) {
    const nod = await map.readSubfile(`${tile.id}.NOD`);
    if (!nod) continue;
    const hdr = parseNodHeader(nod);
    const nod1 = nod.subarray(hdr.nod1.offset, hdr.nod1.offset + hdr.nod1.length);
    const nod2 = nod.subarray(hdr.nod2.offset, hdr.nod2.offset + hdr.nod2.length);
    // Graph id + 1 by offset, 0 for none yet.
    const ids = new Int32Array(nod1.length);
    const nodes: TileNodes = {
      // Every offset in NOD1 an arc leads to is a node the walk reaches (it follows every arc).
      has: (off) => off >= 0 && off < nod1.length,
      id: (off) => {
        const known = ids[off];
        if (known) return known - 1;
        nodePosition(nod1, off, hdr, at);
        const id = b.node(at.x, at.y);
        ids[off] = id + 1;
        return id;
      },
    };
    const tileClasses = new Map(classes[tile.id] ?? []);
    const unitM = nodUnitM(hdr.flags);
    eachNode(nod1, nod2, hdr, (rec) => addArcs(b, rec, nodes, tileClasses, i, unitM));
  }
  return b.build();
}
