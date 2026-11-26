/**
 * Reader for Garmin's routing network (the NOD subfile): nodes with their arcs to neighbouring
 * nodes, each arc linked to a road record ("Table A") with speed class, road class, one-way and
 * toll flags and a pointer to the road in NET. Written from the public reverse-engineering notes
 * (OSM wiki "NOD Subfile Format", mkgmap's doc/nod.txt) and a study of how mkgmap writes the format.
 */

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s24 = (v: number) => (v & 0x800000 ? v - 0x1000000 : v);
const signed = (v: number, bits: number) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);

export interface NodHeader {
  nod1: { offset: number; length: number };
  nod2: { offset: number; length: number };
  nod3: { offset: number; length: number; record: number };
  flags: number;
  /** Tables areas start on multiples of 1 << align. */
  align: number;
  tableARecord: number;
}

export function parseNodHeader(h: Uint8Array): NodHeader {
  return {
    nod1: { offset: u32(h, 0x15), length: u32(h, 0x19) },
    flags: u32(h, 0x1d),
    align: h[0x21],
    tableARecord: u16(h, 0x23),
    nod2: { offset: u32(h, 0x25), length: u32(h, 0x29) },
    nod3: { offset: u32(h, 0x31), length: u32(h, 0x35), record: h[0x39] },
  };
}

/** Start nodes (NOD1 offsets) of every road, from the NOD2 road records. */
export function nod2StartNodes(nod2: Uint8Array): number[] {
  const out: number[] = [];
  let p = 0;
  while (p + 6 <= nod2.length) {
    out.push(u24(nod2, p + 1));
    const nbits = u16(nod2, p + 4);
    p += 6 + Math.ceil(nbits / 8);
  }
  return out;
}

export interface NodArc {
  target: number;
  /** Raw length in NOD units. */
  length: number;
  forward: boolean;
  /** Table A record: pointer into NET, class/speed/one-way/toll byte, access byte. */
  net: number;
  info: number;
  access: number;
  /** The first arc of its road-and-direction group: a link to the adjacent node. The others in the
   *  group are "indirect" links further along the same road, whose length field is not the road
   *  length to their target; routing uses direct links only. */
  direct: boolean;
}

export interface NodNode {
  offset: number;
  flags: number;
  /** Map units. */
  x: number;
  y: number;
  arcs: NodArc[];
  /** Offset just past the arcs (before any restriction offsets). */
  end: number;
}

/** More links than this from one node means the data is damaged. */
const MAX_ARCS = 64;

/** One node record decoded into reused typed arrays (no objects), for reading millions of nodes:
 *  `count` arcs, arc k's fields at index k. */
export class NodeRecord {
  offset = 0;
  flags = 0;
  x = 0;
  y = 0;
  end = 0;
  count = 0;
  readonly target = new Int32Array(MAX_ARCS);
  readonly length = new Int32Array(MAX_ARCS);
  /** 1 or 0. */
  readonly forward = new Uint8Array(MAX_ARCS);
  readonly direct = new Uint8Array(MAX_ARCS);
  readonly net = new Int32Array(MAX_ARCS);
  readonly info = new Uint8Array(MAX_ARCS);
  readonly access = new Uint8Array(MAX_ARCS);
}

/** The position (map units) of the node record at `off` in NOD1, into `out`. Returns `p`, the
 *  offset of its first arc. */
function readPosition(nod1: Uint8Array, off: number, align: number, out: { x: number; y: number }): number {
  const tables = ((off >> align) + nod1[off] + 1) << align;
  const baseX = s24(u24(nod1, tables + 1));
  const baseY = s24(u24(nod1, tables + 4));
  const flags = nod1[off + 1];
  if (flags & 0x20) {
    const v = u32(nod1, off + 2);
    out.x = baseX + signed(v & 0xffff, 16);
    out.y = baseY + signed(v >>> 16, 16);
    return off + 6;
  }
  const v = u24(nod1, off + 2);
  out.x = baseX + signed(v & 0xfff, 12);
  out.y = baseY + signed(v >>> 12, 12);
  return off + 5;
}

/** Just the position of the node record at `off` in NOD1 (map units), into `out`. */
export function nodePosition(nod1: Uint8Array, off: number, hdr: NodHeader, out: { x: number; y: number }): void {
  readPosition(nod1, off, hdr.align, out);
}

/** Decodes the node record at `off` in NOD1 into `rec`. */
export function decodeNode(nod1: Uint8Array, off: number, hdr: NodHeader, rec: NodeRecord): void {
  const align = hdr.align;
  const tables = ((off >> align) + nod1[off] + 1) << align;
  const nA = nod1[tables + 7];
  const tableA = tables + 9;
  const tableB = tableA + nA * hdr.tableARecord;
  const flags = nod1[off + 1];
  let p = readPosition(nod1, off, align, rec);
  rec.offset = off;
  rec.flags = flags;
  rec.count = 0;
  rec.end = p;
  if (!(flags & 0x40)) return;

  let first = true;
  let compact = false;
  let dirByteHalf = 0; // compact directions: 0 = next direction reads a new byte
  let indexA = -1;
  let prevForward = false;
  for (;;) {
    // A record that runs off the end of the data (a truncated or damaged map), or one with more
    // links than any junction has: stop here rather than reading on forever.
    if (p + 2 > nod1.length || rec.count >= MAX_ARCS) break;
    const fa = nod1[p++];
    const fb = nod1[p++];
    let target: number;
    if (!(fb & 0x40)) {
      target = off + signed(((fb & 0x3f) << 8) | nod1[p++], 14);
    } else {
      let ib = fb & 0x3f;
      if (ib === 0x3f) ib = nod1[p++];
      target = u24(nod1, tableB + ib * 3);
    }
    if (first) compact = (fa & 0x80) !== 0;
    const newNet = first || (fa & 0x80) !== 0;
    if (newNet) indexA = nod1[p++];
    let length: number;
    let curve: boolean;
    if ((fa & 0x38) !== 0x38) {
      length = ((fa & 0x18) << 5) | nod1[p++];
      curve = (fa & 0x20) !== 0;
    } else {
      const b0 = nod1[p];
      if (b0 & 0x80) {
        if (b0 & 0x40) {
          length = (b0 & 0x3f) | (nod1[p + 1] << 6) | (nod1[p + 2] << 14);
          p += 3;
          curve = true;
        } else {
          length = (b0 & 0x3f) | (nod1[p + 1] << 6);
          p += 2;
          curve = false;
        }
      } else {
        length = (b0 & 0x7f) | (nod1[p + 1] << 7);
        p += 2;
        curve = true;
      }
    }
    const forward = (fa & 0x40) !== 0;
    const direct = first || newNet || forward !== prevForward;
    if (direct) {
      if (!compact) p++;
      else {
        if (dirByteHalf === 0) p++;
        dirByteHalf ^= 1;
      }
    }
    if (curve) {
      const c = nod1[p++];
      if ((c & 0xe0) === 0) p++;
    }
    const a = tableA + indexA * hdr.tableARecord;
    const k = rec.count++;
    rec.target[k] = target;
    rec.length[k] = length;
    rec.forward[k] = forward ? 1 : 0;
    rec.direct[k] = direct ? 1 : 0;
    rec.net[k] = u24(nod1, a) & 0x3fffff;
    rec.info[k] = nod1[a + 3];
    rec.access[k] = nod1[a + 4];
    prevForward = forward;
    first = false;
    if (fb & 0x80) break;
  }
  rec.end = p;
}

/** The record as an object. */
export function nodNode(rec: NodeRecord): NodNode {
  const arcs: NodArc[] = [];
  for (let k = 0; k < rec.count; k++) {
    arcs.push({ target: rec.target[k], length: rec.length[k], forward: rec.forward[k] === 1, direct: rec.direct[k] === 1, net: rec.net[k], info: rec.info[k], access: rec.access[k] });
  }
  return { offset: rec.offset, flags: rec.flags, x: rec.x, y: rec.y, arcs, end: rec.end };
}

/** Decodes the node record at `off` in NOD1. */
export function parseNode(nod1: Uint8Array, off: number, hdr: NodHeader): NodNode {
  const rec = new NodeRecord();
  decodeNode(nod1, off, hdr, rec);
  return nodNode(rec);
}

/**
 * Visits every node reachable from the road start nodes once, depth first from the last start node
 * (the order readNodes keeps), each decoded into the one `rec` passed to `visit`. Nothing per node
 * is kept but a bit, so a big map's millions of nodes cost no objects.
 */
export function eachNode(nod1: Uint8Array, nod2: Uint8Array, hdr: NodHeader, visit: (rec: NodeRecord) => void): void {
  const seen = new Uint8Array((nod1.length >> 3) + 1);
  const isSeen = (off: number) => (seen[off >> 3] & (1 << (off & 7))) !== 0;
  const starts = nod2StartNodes(nod2);
  let stack = Int32Array.from(starts);
  let top = stack.length;
  const rec = new NodeRecord();
  while (top) {
    const off = stack[--top];
    if (off < 0 || off >= nod1.length || isSeen(off)) continue;
    seen[off >> 3] |= 1 << (off & 7);
    decodeNode(nod1, off, hdr, rec);
    visit(rec);
    for (let k = 0; k < rec.count; k++) {
      const t = rec.target[k];
      // Out of range: dropped when popped, as an already-seen node is.
      if (t >= 0 && t < nod1.length && isSeen(t)) continue;
      if (top === stack.length) {
        const bigger = new Int32Array(Math.max(1024, stack.length * 2));
        bigger.set(stack);
        stack = bigger;
      }
      stack[top++] = t;
    }
  }
}

/** All nodes reachable from the road start nodes, by offset. */
export function readNodes(nod1: Uint8Array, nod2: Uint8Array, hdr: NodHeader): Map<number, NodNode> {
  const nodes = new Map<number, NodNode>();
  eachNode(nod1, nod2, hdr, (rec) => nodes.set(rec.offset, nodNode(rec)));
  return nodes;
}
