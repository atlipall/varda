/**
 * A compact directed road graph shared by both routing engines (A: built from road lines,
 * B: decoded from Garmin's NOD routing data), plus fastest-route search and snapping.
 * Coordinates are Garmin map units (360° = 2^24).
 */

export const UNITS_PER_DEG = (1 << 24) / 360;
const EARTH_R = 6371008.8;

/** Edge flag: an F-road or 4×4 track (excluded when F-roads aren't allowed). */
export const EDGE_FROAD = 1;

export function metresBetween(x1: number, y1: number, x2: number, y2: number): number {
  const rad = Math.PI / 180 / UNITS_PER_DEG;
  const la1 = y1 * rad;
  const la2 = y2 * rad;
  const dLat = la2 - la1;
  const dLon = (x2 - x1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RoadGraph {
  nodeX: Int32Array;
  nodeY: Int32Array;
  /** CSR: edges of node n are edgeStart[n] .. edgeStart[n + 1] - 1. */
  edgeStart: Int32Array;
  edgeTo: Int32Array;
  /** Metres. */
  edgeLen: Float32Array;
  /** km/h used for travel time, whole (1-255; Garmin speed classes are 5-128). */
  edgeSpeed: Uint8Array;
  edgeFlags: Uint8Array;
  /** The edge's road: its map tile's index (0 when the edge has no road) and its NET offset
   *  (−1 when unknown). */
  edgeTile: Uint16Array;
  edgeNet: Int32Array;
  /** The road's importance from the map, 0 (least: residential streets, minor roads) to 4 (main
   *  roads). */
  edgeRank: Uint8Array;
  /** Optional shape per edge: points geomStart[e] .. geomStart[e + 1] - 1 of geomX/geomY, from
   *  the source node to the target (exclusive of both ends). Absent: straight between nodes. */
  geomStart?: Int32Array;
  geomX?: Int32Array;
  geomY?: Int32Array;
  maxSpeed: number;
}

/**
 * Node ids by exact position: open addressing over the ids, positions read from `xs`/`ys`. Typed
 * arrays throughout, so a big map's millions of nodes (3.6 million on Freizeitkarte Denmark) cost
 * 4-8 bytes a slot instead of a Map entry each. Up to three quarters full before it doubles
 * (Denmark's 2.6 million graph nodes take 4.2 million slots, 17 MB, not 8.4 million).
 */
export class XYTable {
  private slots: Int32Array;
  private mask: number;
  private count = 0;

  /** `xs`/`ys` are read through `.data`, so they may be replaced by grown copies. */
  constructor(private readonly xs: { data: Int32Array }, private readonly ys: { data: Int32Array }, capacity = 0) {
    let size = 16;
    while (size * 3 < capacity * 4) size *= 2;
    this.slots = new Int32Array(size).fill(-1);
    this.mask = size - 1;
  }

  private slot(x: number, y: number): number {
    // Murmur3's finalizer: coarse maps' coordinates share their low bits.
    let h = Math.imul(x, 0x9e3779b1) ^ y;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    const xs = this.xs.data;
    const ys = this.ys.data;
    let i = h & this.mask;
    for (;;) {
      const id = this.slots[i];
      if (id < 0 || (xs[id] === x && ys[id] === y)) return i;
      i = (i + 1) & this.mask;
    }
  }

  /** The id at this position, or -1. */
  get(x: number, y: number): number {
    return this.slots[this.slot(x, y)];
  }

  /** Records `id` (whose position is already in xs/ys) unless one is there; returns the id kept. */
  add(id: number): number {
    const i = this.slot(this.xs.data[id], this.ys.data[id]);
    if (this.slots[i] >= 0) return this.slots[i];
    this.slots[i] = id;
    if (++this.count * 4 > this.slots.length * 3) this.grow();
    return id;
  }

  private grow(): void {
    const old = this.slots;
    this.slots = new Int32Array(old.length * 2).fill(-1);
    this.mask = this.slots.length - 1;
    for (const id of old) if (id >= 0) this.slots[this.slot(this.xs.data[id], this.ys.data[id])] = id;
  }
}

/** A typed array that grows (by half) as values are pushed. */
class Column<T extends Int32Array | Float32Array | Uint16Array | Uint8Array> {
  length = 0;
  constructor(public data: T) {}
  push(v: number): void {
    if (this.length === this.data.length) {
      const bigger = new (this.data.constructor as new (n: number) => T)(Math.max(64, Math.ceil(this.data.length * 1.5)));
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = v;
  }
  /** The values in edge order `order` (a permutation of 0 … length - 1). */
  permuted(order: Int32Array): T {
    const out = new (this.data.constructor as new (n: number) => T)(order.length);
    for (let i = 0; i < order.length; i++) out[i] = this.data[order[i]];
    return out;
  }
  /** Empties the column, letting its buffer go. */
  release(): void {
    this.data = new (this.data.constructor as new (n: number) => T)(0);
    this.length = 0;
  }
}

/** Accumulates nodes (deduplicated by exact coordinate) and edges, then packs them; build() leaves
 *  it empty. Columns are typed arrays, each let go once packed, to keep a big map's build within a
 *  phone's memory. */
export class GraphBuilder {
  private readonly xs = new Column(new Int32Array(1024));
  private readonly ys = new Column(new Int32Array(1024));
  private ids = new XYTable(this.xs, this.ys);
  private readonly from = new Column(new Int32Array(1024));
  private readonly to = new Column(new Int32Array(1024));
  private readonly len = new Column(new Float32Array(1024));
  private readonly speed = new Column(new Uint8Array(1024));
  private readonly flags = new Column(new Uint8Array(1024));
  private readonly tile = new Column(new Uint16Array(1024));
  private readonly net = new Column(new Int32Array(1024));
  private readonly rank = new Column(new Uint8Array(1024));
  /** Interior points of the edges that have a shape, by edge (most graphs have none). */
  private readonly geom = new Map<number, number[]>();

  node(x: number, y: number): number {
    const found = this.ids.get(x, y);
    if (found >= 0) return found;
    const id = this.xs.length;
    this.xs.push(x);
    this.ys.push(y);
    return this.ids.add(id);
  }

  /** Adds a directed edge; `kmh` is whole (kept in a byte); `shape` is the interior points as a flat [x, y, x, y, …] list. */
  edge(a: number, b: number, metres: number, kmh: number, flags: number, shape: number[] | null = null, road: { tile: number; net: number } | null = null, rank = TOP_RANK): void {
    if (a === b) return;
    if (shape) this.geom.set(this.from.length, shape);
    this.roadEdge(a, b, metres, kmh, flags, road?.tile ?? 0, road?.net ?? -1, rank);
  }

  /** Adds a directed edge along road (tile, net) with no shape: `edge` without the objects, for
   *  the millions of a big map. */
  roadEdge(a: number, b: number, metres: number, kmh: number, flags: number, tile: number, net: number, rank: number): void {
    if (a === b) return;
    this.from.push(a);
    this.to.push(b);
    this.len.push(metres);
    this.speed.push(kmh);
    this.flags.push(flags);
    this.tile.push(tile);
    this.net.push(net);
    this.rank.push(rank);
  }

  get nodeCount(): number {
    return this.xs.length;
  }

  build(): RoadGraph {
    const n = this.xs.length;
    const m = this.from.length;
    const nodeX = this.xs.data.slice(0, n);
    const nodeY = this.ys.data.slice(0, n);
    this.ids = new XYTable(this.xs, this.ys);
    this.xs.release();
    this.ys.release();
    const edgeStart = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) edgeStart[this.from.data[e] + 1]++;
    for (let i = 0; i < n; i++) edgeStart[i + 1] += edgeStart[i];
    const fill = edgeStart.slice(0, n);
    const order = new Int32Array(m);
    for (let e = 0; e < m; e++) order[fill[this.from.data[e]]++] = e;
    this.from.release();
    // One column at a time, each source let go once copied: the peak stays near one copy.
    const take = <T extends Int32Array | Float32Array | Uint16Array | Uint8Array>(c: Column<T>): T => {
      const out = c.permuted(order);
      c.release();
      return out;
    };
    const edgeTo = take(this.to);
    const edgeLen = take(this.len);
    const edgeSpeed = take(this.speed);
    const edgeFlags = take(this.flags);
    const edgeTile = take(this.tile);
    const edgeNet = take(this.net);
    const edgeRank = take(this.rank);
    let maxSpeed = 1;
    for (let i = 0; i < m; i++) if (edgeSpeed[i] > maxSpeed) maxSpeed = edgeSpeed[i];
    let geomStart: Int32Array | undefined;
    let geomX: Int32Array | undefined;
    let geomY: Int32Array | undefined;
    if (this.geom.size) {
      let points = 0;
      for (const g of this.geom.values()) points += g.length / 2;
      geomStart = new Int32Array(m + 1);
      geomX = new Int32Array(points);
      geomY = new Int32Array(points);
      let gp = 0;
      for (let i = 0; i < m; i++) {
        geomStart[i] = gp;
        const g = this.geom.get(order[i]);
        if (g) for (let k = 0; k < g.length; k += 2) {
          geomX[gp] = g[k];
          geomY[gp++] = g[k + 1];
        }
      }
      geomStart[m] = gp;
      this.geom.clear();
    }
    return { nodeX, nodeY, edgeStart, edgeTo, edgeLen, edgeSpeed, edgeFlags, edgeTile, edgeNet, edgeRank, geomStart, geomX, geomY, maxSpeed };
  }
}

export interface Route {
  /** Route shape as [lon, lat] degrees. */
  coords: Array<[number, number]>;
  metres: number;
  seconds: number;
  nodes: number[];
  edges: number[];
}

/** Binary min-heap of (key, value) pairs, in typed arrays that grow and are kept between searches. */
class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;
  get topKey(): number {
    return this.keys[0];
  }
  clear(): void {
    this.size = 0;
  }
  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const vals = new Int32Array(this.size * 2);
      keys.set(this.keys);
      vals.set(this.vals);
      this.keys = keys;
      this.vals = vals;
    }
    const keys = this.keys;
    const vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    const k = keys[n];
    const v = vals[n];
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

/** A search's per-node state, kept per graph so a route or reroute on a big map (2.6 million
 *  nodes on Freizeitkarte Denmark) doesn't allocate and fill tens of MB each time. `stamp[v]`
 *  tells which search last touched v: 2·gen once v has a cost in search `gen`, 2·gen + 1 once it's
 *  settled; anything lower means untouched (no cost yet, no edge in), whatever best/via hold.
 *  14 bytes a node, kept (36 MB on Denmark); the stamps are cleared once every 32,767 searches. */
interface Scratch {
  best: Float64Array;
  via: Int32Array;
  stamp: Uint16Array;
  gen: number;
  heap: Heap;
}

const scratches = new WeakMap<RoadGraph, Scratch>();

/** The graph's search state, readied for a new search. */
function scratchFor(g: RoadGraph): Scratch {
  const n = g.nodeX.length;
  let s = scratches.get(g);
  if (!s) scratches.set(g, (s = { best: new Float64Array(n), via: new Int32Array(n), stamp: new Uint16Array(n), gen: 0, heap: new Heap() }));
  if (++s.gen >= 0x8000) {
    s.stamp.fill(0);
    s.gen = 1;
  }
  s.heap.clear();
  return s;
}

const RAD_PER_UNIT = Math.PI / 180 / UNITS_PER_DEG;

/** At most metresBetween(x1, y1, x2, y2), given the cosines of the two latitudes: the chord
 *  through the earth, 2R·√h, where the arc is 2R·asin √h, with sin x taken as x − x³/6 (less than
 *  sin x for 0 ≤ x ≤ 1). A few hundredths of a percent short over a few hundred km, and it needs
 *  one square root instead of four trigonometric functions. */
function metresAtLeast(x1: number, y1: number, cos1: number, x2: number, y2: number, cos2: number): number {
  const a = Math.abs(y2 - y1) * (RAD_PER_UNIT / 2);
  const b = Math.abs(x2 - x1) * (RAD_PER_UNIT / 2);
  if (a > 1 || b > 1) return metresBetween(x1, y1, x2, y2);
  const sa = a * (1 - (a * a) / 6);
  const sb = b * (1 - (b * b) / 6);
  return 2 * EARTH_R * Math.sqrt(sa * sa + cos1 * cos2 * sb * sb);
}

/** A route end on the graph: a node plus the time (seconds) spent getting to it from the start
 *  point (for a source) or from it to the destination point (for a target). */
export interface Terminal {
  node: number;
  cost: number;
}

const terminals = (t: number | Terminal[]): Terminal[] => (typeof t === 'number' ? [{ node: t, cost: 0 }] : t);

/** With F-roads preferred, time on F-roads and tracks counts this much when choosing a route. */
export const PREFER_FROAD_WEIGHT = 0.6;

/** The most important road rank (main roads); an edge without one counts as this. */
export const TOP_RANK = 4;

/** How a route is chosen beyond driving time. `rankWeight[r]`: time on a normal road of rank r
 *  counts this much (≥ 1); `changeSeconds`: added each time the route turns onto another road.
 *  Both make it keep to main roads instead of shorter zig-zags through streets whose speed class
 *  equals the main road's (common in towns). F-roads and tracks are left to `fWeight`. */
export interface Preference {
  rankWeight: readonly number[];
  changeSeconds: number;
}

export const NO_PREFERENCE: Preference = { rankWeight: [1, 1, 1, 1, 1], changeSeconds: 0 };

/**
 * Fastest route (A*, time in seconds) from any of the sources to any of the targets, counting each
 * source's and target's cost, or null when none is reachable. `seconds` includes those costs,
 * `metres` only the edges'. A plain node stands for a single terminal with no cost. `fWeight` < 1
 * makes F-road and track time count for less when choosing (to prefer them); `seconds` is still
 * the real driving time.
 */
export function fastestRoute(g: RoadGraph, from: number | Terminal[], to: number | Terminal[], allowFRoads: boolean, fWeight = 1, pref: Preference = NO_PREFERENCE): Route | null {
  const sources = terminals(from);
  const targets = terminals(to);
  if (!sources.length || !targets.length) return null;
  const { best, via, stamp, gen, heap } = scratchFor(g);
  const reached = 2 * gen;
  const settled = reached + 1;
  const extra = new Map<number, number>();
  for (const t of targets) extra.set(t.node, Math.min(t.cost, extra.get(t.node) ?? Infinity));
  // An F-road counted at fWeight is as if driven 1/fWeight times faster.
  // 1 % above top speed: NOD lengths (2.4 m units) run a little short of the straight-line distance,
  // and the estimate must never exceed the real cost.
  const maxMs = (g.maxSpeed * 1.01) / 3.6 / Math.min(1, fWeight);
  // Admissible: at most the straight-line time at top speed to the nearest-in-total target (see
  // metresAtLeast), with the targets' positions and cosines worked out once.
  const tn = targets.length;
  const tx = new Float64Array(tn);
  const ty = new Float64Array(tn);
  const tcos = new Float64Array(tn);
  const tcost = new Float64Array(tn);
  for (let k = 0; k < tn; k++) {
    tx[k] = g.nodeX[targets[k].node];
    ty[k] = g.nodeY[targets[k].node];
    tcos[k] = Math.cos(ty[k] * RAD_PER_UNIT);
    tcost[k] = targets[k].cost;
  }
  const h = (v: number) => {
    const x = g.nodeX[v];
    const y = g.nodeY[v];
    const cos = Math.cos(y * RAD_PER_UNIT);
    let m = Infinity;
    for (let k = 0; k < tn; k++) m = Math.min(m, metresAtLeast(x, y, cos, tx[k], ty[k], tcos[k]) / maxMs + tcost[k]);
    return m;
  };
  for (const s of sources) {
    if (s.cost < (stamp[s.node] < reached ? Infinity : best[s.node])) {
      best[s.node] = s.cost;
      via[s.node] = -1;
      stamp[s.node] = reached;
      heap.push(s.cost + h(s.node), s.node);
    }
  }
  let bestTotal = Infinity;
  let end = -1;
  while (heap.size) {
    if (heap.topKey >= bestTotal) break; // nothing left can beat the best found
    const u = heap.pop();
    if (stamp[u] === settled) continue;
    stamp[u] = settled;
    const x = extra.get(u);
    if (x !== undefined && best[u] + x < bestTotal) {
      bestTotal = best[u] + x;
      end = u;
    }
    const into = via[u];
    for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) {
      if (!allowFRoads && g.edgeFlags[e] & EDGE_FROAD) continue;
      const v = g.edgeTo[e];
      const sv = stamp[v];
      if (sv === settled) continue;
      const froad = g.edgeFlags[e] & EDGE_FROAD;
      // Onto another road (not just across a map tile boundary, where a road's NET record changes).
      const change = into >= 0 && g.edgeTile[into] === g.edgeTile[e] && g.edgeNet[into] !== g.edgeNet[e] ? pref.changeSeconds : 0;
      const t = best[u] + (g.edgeLen[e] / (g.edgeSpeed[e] / 3.6)) * (froad ? fWeight : pref.rankWeight[g.edgeRank[e]]) + change;
      if (t < (sv < reached ? Infinity : best[v])) {
        best[v] = t;
        via[v] = e;
        stamp[v] = reached;
        heap.push(t + h(v), v);
      }
    }
  }
  if (end < 0) return null;
  // Walk back through the edges to a source (a node reached by no edge), then emit the shape forwards.
  const edges: number[] = [];
  let start = end;
  while (via[start] >= 0) {
    const e = via[start];
    edges.push(e);
    start = edgeSource(g, e);
  }
  edges.reverse();
  const deg = (x: number) => x / UNITS_PER_DEG;
  const coords: Array<[number, number]> = [[deg(g.nodeX[start]), deg(g.nodeY[start])]];
  let metres = 0;
  // Real time: the terminals' costs plus the edges' unweighted times.
  let seconds = Math.min(...sources.filter((t) => t.node === start).map((t) => t.cost)) + extra.get(end)!;
  const nodes = [start];
  for (const e of edges) {
    metres += g.edgeLen[e];
    seconds += g.edgeLen[e] / (g.edgeSpeed[e] / 3.6);
    if (g.geomStart) for (let k = g.geomStart[e]; k < g.geomStart[e + 1]; k++) coords.push([deg(g.geomX![k]), deg(g.geomY![k])]);
    const v = g.edgeTo[e];
    coords.push([deg(g.nodeX[v]), deg(g.nodeY[v])]);
    nodes.push(v);
  }
  return { coords, metres, seconds, nodes, edges };
}

/** The node edge `e` leaves from (binary search in edgeStart). */
export function edgeSource(g: RoadGraph, e: number): number {
  let lo = 0;
  let hi = g.nodeX.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.edgeStart[mid + 1] <= e) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether node `v` has an outgoing edge that isn't an F-road or track (so a route that may not
 *  use those can start there). */
export function hasNormalRoad(g: RoadGraph, v: number): boolean {
  for (let e = g.edgeStart[v]; e < g.edgeStart[v + 1]; e++) if (!(g.edgeFlags[e] & EDGE_FROAD)) return true;
  return false;
}

/** Whether node `v` has an outgoing edge a route may use (any, or only normal roads). */
export const canLeave = (g: RoadGraph, v: number, allowFRoads: boolean): boolean =>
  allowFRoads ? g.edgeStart[v + 1] > g.edgeStart[v] : hasNormalRoad(g, v);

const IN_ANY = 1;
const IN_NORMAL = 2;
const inbound = new WeakMap<RoadGraph, Uint8Array>();

/** Whether node `v` has an incoming edge a route may use (any, or only normal roads), so a route
 *  can end there. */
export function canArrive(g: RoadGraph, v: number, allowFRoads: boolean): boolean {
  let flags = inbound.get(g);
  if (!flags) {
    flags = new Uint8Array(g.nodeX.length);
    for (let e = 0; e < g.edgeTo.length; e++) flags[g.edgeTo[e]] |= IN_ANY | (g.edgeFlags[e] & EDGE_FROAD ? 0 : IN_NORMAL);
    inbound.set(g, flags);
  }
  return (flags[v] & (allowFRoads ? IN_ANY : IN_NORMAL)) !== 0;
}

/** Grid index over the graph's nodes, for snapping a position to the nearest node, plus a lookup
 *  of nodes by exact position. Typed arrays (the cells' nodes in one list), so a big map's millions
 *  of nodes fit in a phone's memory. */
export class NodeIndex {
  /** Cell key → the cell's range in `cellNodes`: cellStart[i] … cellStart[i + 1] - 1. */
  private readonly cellOf = new Map<number, number>();
  private readonly cellStart: Int32Array;
  private readonly cellNodes: Int32Array;
  private readonly byXY: XYTable;
  private readonly main: Uint8Array;
  private static readonly CELL = Math.round(0.05 * UNITS_PER_DEG);

  /** Snapping uses the nodes of the main road network (its largest connected part) only, so a
   *  position never snaps to an isolated stub, e.g. a parking loop that isn't joined to any road. */
  constructor(private readonly g: RoadGraph) {
    const C = NodeIndex.CELL;
    const n = g.nodeX.length;
    this.main = largestComponent(g);
    this.byXY = new XYTable({ data: g.nodeX }, { data: g.nodeY }, n);
    const cell = new Int32Array(n).fill(-1);
    const counts: number[] = [];
    for (let v = 0; v < n; v++) {
      this.byXY.add(v);
      if (!this.main[v]) continue;
      const key = Math.floor(g.nodeX[v] / C) * 100000 + Math.floor(g.nodeY[v] / C);
      let c = this.cellOf.get(key);
      if (c === undefined) {
        c = counts.length;
        this.cellOf.set(key, c);
        counts.push(0);
      }
      cell[v] = c;
      counts[c]++;
    }
    this.cellStart = new Int32Array(counts.length + 1);
    for (let c = 0; c < counts.length; c++) this.cellStart[c + 1] = this.cellStart[c] + counts[c];
    const fill = this.cellStart.slice(0, counts.length);
    this.cellNodes = new Int32Array(this.cellStart[counts.length]);
    for (let v = 0; v < n; v++) if (cell[v] >= 0) this.cellNodes[fill[cell[v]]++] = v;
  }

  /** The node at exactly this position (map units), or -1. */
  nodeAt(x: number, y: number): number {
    return this.byXY.get(x, y);
  }

  /** Whether node `v` is part of the main road network. */
  inMain(v: number): boolean {
    return this.main[v] === 1;
  }

  /** Nearest main-network node within `maxMetres` that `accept` (when given) lets through, or null. */
  nearest(lon: number, lat: number, maxMetres: number, accept?: (node: number) => boolean): { node: number; metres: number } | null {
    const C = NodeIndex.CELL;
    const x = Math.round(lon * UNITS_PER_DEG);
    const y = Math.round(lat * UNITS_PER_DEG);
    const cx = Math.floor(x / C);
    const cy = Math.floor(y / C);
    // Enough cells each way to cover the radius (cells are narrower east-west away from the equator).
    const cellM = metresBetween(0, y, C, y);
    const rx = Math.ceil(maxMetres / Math.max(1, cellM));
    const ry = Math.ceil(maxMetres / metresBetween(0, 0, 0, C));
    let bestNode = -1;
    let bestM = maxMetres;
    for (let dx = -rx; dx <= rx; dx++) for (let dy = -ry; dy <= ry; dy++) {
      const c = this.cellOf.get((cx + dx) * 100000 + (cy + dy));
      if (c === undefined) continue;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const v = this.cellNodes[k];
        const m = metresBetween(x, y, this.g.nodeX[v], this.g.nodeY[v]);
        if (m <= bestM && (!accept || accept(v))) {
          bestM = m;
          bestNode = v;
        }
      }
    }
    return bestNode < 0 ? null : { node: bestNode, metres: bestM };
  }
}

/** Nodes of the largest connected part of the graph (edges taken as undirected). */
export function largestComponent(g: RoadGraph): Uint8Array {
  const n = g.nodeX.length;
  const comp = new Int32Array(n).fill(-1);
  // Undirected adjacency in CSR form: every edge in both directions.
  const deg = new Int32Array(n + 1);
  for (let u = 0; u < n; u++) for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) { deg[u + 1]++; deg[g.edgeTo[e] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const fill = deg.slice(0, n);
  const adj = new Int32Array(deg[n]);
  for (let u = 0; u < n; u++) for (let e = g.edgeStart[u]; e < g.edgeStart[u + 1]; e++) { adj[fill[u]++] = g.edgeTo[e]; adj[fill[g.edgeTo[e]]++] = u; }
  let best = -1;
  let bestSize = 0;
  const stack: number[] = [];
  for (let s = 0, id = 0; s < n; s++, id++) {
    if (comp[s] >= 0) { id--; continue; }
    let size = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (let k = deg[u]; k < deg[u + 1]; k++) if (comp[adj[k]] < 0) { comp[adj[k]] = id; stack.push(adj[k]); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  const out = new Uint8Array(n);
  for (let v = 0; v < n; v++) out[v] = comp[v] === best ? 1 : 0;
  return out;
}
