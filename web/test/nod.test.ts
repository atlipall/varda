import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pairs } from '../src/img/rgn';
import { decodeAll } from '../src/map/decodeAll';
import { GarminMap } from '../src/map/garminMap';
import { nod2StartNodes, parseNodHeader, parseNode, readNodes, type NodHeader, type NodNode } from '../src/routing/nod';
import { nodeSource } from './helpers/nodeSource';
import { DETAILED, hasRealData } from './helpers/paths';

const HDR: NodHeader = { nod1: { offset: 0, length: 0 }, nod2: { offset: 0, length: 0 }, nod3: { offset: 0, length: 0, record: 9 }, flags: 0x203, align: 6, tableARecord: 5 };
const BASE_X = -885437; // about -19.0°
const BASE_Y = 2982617; // about 64.0°

/** Two nodes at offsets 0 and 11 of one node area, tables area at 0x40. */
function sample(): Uint8Array {
  const b = new Uint8Array(0x40 + 9 + 5);
  const put24 = (o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; b[o + 2] = (v >> 16) & 0xff; };
  // Node 0: tables at ((0 >> 6) + 0 + 1) << 6 = 0x40; flags: has arcs; 12-bit offsets dx=10, dy=-5.
  b.set([0x00, 0x40], 0);
  put24(2, ((-5 & 0xfff) << 12) | 10);
  // Arc: forward (0x40), 10-bit length 300 (top bits 0x08), last link, intra-area +11, Table A 0,
  // length low byte, normal direction byte.
  b.set([0x48, 0x80, 0x0b, 0x00, 300 & 0xff, 0x00], 5);
  // Node 1 at 11: 16-bit offsets (0x20) dx=-300, dy=200.
  b.set([0x00, 0x60], 11);
  const v = ((200 & 0xffff) << 16) | (-300 & 0xffff);
  b.set([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff], 13);
  // Arc back: not forward, 14-bit length 1000 (flags 0x38, 0x80 | low 6 bits, then bits 6-13),
  // last link, intra-area -11 (14-bit 0x3ff5), Table A 0, direction byte.
  b.set([0x38, 0x80 | 0x3f, 0xf5, 0x00, 0x80 | (1000 & 0x3f), (1000 >> 6) & 0xff, 0x40], 17);
  // Tables header: format 0, base lon/lat (signed 24-bit), 1 Table A record, 0 Table B records.
  put24(0x41, BASE_X & 0xffffff);
  put24(0x44, BASE_Y & 0xffffff);
  b[0x47] = 1;
  b[0x48] = 0;
  // Table A: NET 0x1234; speed class 3, one-way (0x08); access 0.
  put24(0x49, 0x1234);
  b[0x4c] = 0x0b;
  b[0x4d] = 0;
  return b;
}

describe('NOD reader', () => {
  test('nodes: position from base + 12- or 16-bit offsets; arcs with target, length, direction, road', () => {
    const nod1 = sample();
    const n0 = parseNode(nod1, 0, HDR);
    expect([n0.x, n0.y]).toEqual([BASE_X + 10, BASE_Y - 5]);
    expect(n0.arcs).toEqual([{ target: 11, length: 300, forward: true, direct: true, net: 0x1234, info: 0x0b, access: 0 }]);
    const n1 = parseNode(nod1, 11, HDR);
    expect([n1.x, n1.y]).toEqual([BASE_X - 300, BASE_Y + 200]);
    expect(n1.arcs).toEqual([{ target: 0, length: 1000, forward: false, direct: true, net: 0x1234, info: 0x0b, access: 0 }]);
    expect(n1.end).toBe(24);
  });

  test('a node record that runs off the end of the data (a truncated map) stops instead of reading on', () => {
    const cut = sample().slice(0, 11);
    cut[6] = 0x00; // node 0's only arc without its "last link" flag: the next would start past the end
    const n0 = parseNode(cut, 0, HDR);
    expect(n0.arcs.length).toBe(1);
    expect(n0.end).toBe(11);
  });

  test('NOD2 road records give start nodes; following arcs reaches every node', () => {
    const nod2 = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x03]);
    expect(nod2StartNodes(nod2)).toEqual([0]);
    expect([...readNodes(sample(), nod2, HDR).keys()].sort((a, b) => a - b)).toEqual([0, 11]);
  });
});

describe.skipIf(!hasRealData)('NOD on real data (Detailed)', () => {
  let src: Awaited<ReturnType<typeof nodeSource>>;
  let map: GarminMap;
  /** Per tile id: its decoded nodes, and every road-line vertex of its finest level as "x,y". */
  const tiles = new Map<string, { nodes: Map<number, NodNode>; vertices: Set<string> }>();
  beforeAll(async () => {
    src = await nodeSource(DETAILED);
    map = await GarminMap.open(src);
    for (const tile of map.tiles) {
      const nod = await map.readSubfile(`${tile.id}.NOD`);
      if (!nod) continue;
      const hdr = parseNodHeader(nod);
      const nodes = readNodes(nod.subarray(hdr.nod1.offset, hdr.nod1.offset + hdr.nod1.length), nod.subarray(hdr.nod2.offset, hdr.nod2.offset + hdr.nod2.length), hdr);
      tiles.set(tile.id, { nodes, vertices: new Set() });
    }
    await decodeAll(map, (tile, _sd, obj) => {
      if (obj.kind !== 'line' || obj.labelSrc !== 'net') return;
      const t = tiles.get(tile.id);
      if (t) for (const [x, y] of pairs(obj.xy)) t.vertices.add(`${x},${y}`);
    }, { bits: Math.max(...map.bands.keys()) });
  }, 300_000);
  afterAll(() => src.close());

  test('every decoded node lies on a road-line vertex of its tile', () => {
    let nodes = 0;
    const off: string[] = [];
    for (const [id, t] of tiles) for (const n of t.nodes.values()) {
      nodes++;
      if (!t.vertices.has(`${n.x},${n.y}`)) off.push(`${id}@${n.offset}`);
    }
    console.log(`NOD nodes: ${nodes} in ${tiles.size} tiles, ${off.length} off a road vertex`);
    expect(nodes).toBeGreaterThan(0);
    expect(off.slice(0, 10)).toEqual([]);
  });

  test('every direct arc has a direct arc back from its target', () => {
    let arcs = 0;
    const unpaired: string[] = [];
    for (const [id, t] of tiles) for (const n of t.nodes.values()) for (const a of n.arcs) {
      if (!a.direct) continue;
      arcs++;
      const back = t.nodes.get(a.target)?.arcs.some((b) => b.direct && b.target === n.offset);
      if (!back) unpaired.push(`${id}@${n.offset}→${a.target}`);
    }
    console.log(`direct arcs: ${arcs}, ${unpaired.length} without a direct arc back`);
    expect(arcs).toBeGreaterThan(0);
    expect(unpaired.slice(0, 10)).toEqual([]);
  });
});
