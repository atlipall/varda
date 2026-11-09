/** A small GPX 1.0/1.1 reader: tracks (one line per segment), routes and waypoints. It scans the
 *  XML itself rather than using DOMParser, so it runs the same in workers and tests. */

export class GpxError extends Error {}

export interface GpxPoint {
  lon: number;
  lat: number;
  ele: number | null;
  /** Milliseconds since the epoch, or null without a (valid) timestamp. */
  time: number | null;
}

export interface GpxLine {
  kind: 'track' | 'route';
  name: string | null;
  points: GpxPoint[];
}

export interface GpxWaypoint {
  name: string | null;
  lon: number;
  lat: number;
  ele: number | null;
}

export interface Gpx {
  name: string | null;
  lines: GpxLine[];
  waypoints: GpxWaypoint[];
}

export const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][\s\S]*?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export const decode = (s: string) => s.replace(ENTITY, (_, e: string) =>
  e[0] !== '#' ? NAMED[e.toLowerCase()] : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

/** Local name without a namespace prefix, lower-cased. */
export const local = (tag: string) => tag.slice(tag.indexOf(':') + 1).toLowerCase();

export function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) out[local(m[1])] = decode(m[2] ?? m[3]);
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

function coords(a: Record<string, string>): { lon: number; lat: number } | null {
  const lat = num(a.lat);
  const lon = num(a.lon);
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lon, lat } : null;
}

export function parseGpx(xml: string): Gpx {
  const out: Gpx = { name: null, lines: [], waypoints: [] };
  const stack: string[] = [];
  let sawGpx = false;
  let text = '';
  let point: (GpxPoint & { name?: string | null }) | null = null;
  let line: GpxLine | null = null;
  let parentName: string | null = null;
  let segments: GpxLine[] = [];

  const endLine = (l: GpxLine | null) => {
    if (l && l.points.length >= 2) out.lines.push(l);
  };

  for (const m of xml.matchAll(TOKEN)) {
    const [, cdata, close, rawTag, rawAttrs, selfClose, chars] = m;
    if (cdata !== undefined || chars !== undefined) {
      text += cdata ?? decode(chars!);
      continue;
    }
    if (!rawTag) continue; // comment, declaration, processing instruction
    const tag = local(rawTag);
    const parent = stack[stack.length - 1];
    if (!close) {
      text = '';
      if (tag === 'gpx') sawGpx = true;
      if (tag === 'trk' || tag === 'rte') {
        parentName = null;
        segments = [];
        if (tag === 'rte') line = { kind: 'route', name: null, points: [] };
      } else if (tag === 'trkseg') {
        line = { kind: 'track', name: null, points: [] };
      } else if (tag === 'trkpt' || tag === 'rtept' || tag === 'wpt') {
        const c = coords(attrs(rawAttrs ?? ''));
        point = c ? { ...c, ele: null, time: null, name: null } : null;
      }
      if (selfClose) {
        // An empty element: handle it as opened and closed at once.
        if (tag === 'trkpt' || tag === 'rtept') {
          if (point && line) line.points.push({ lon: point.lon, lat: point.lat, ele: null, time: null });
          point = null;
        } else if (tag === 'wpt') {
          if (point) out.waypoints.push({ name: null, lon: point.lon, lat: point.lat, ele: null });
          point = null;
        }
        continue;
      }
      stack.push(tag);
      continue;
    }
    // Closing tag.
    stack.pop();
    const grand = stack[stack.length - 1];
    const value = text.trim();
    text = '';
    if (tag === 'name') {
      if (grand === 'metadata' || grand === 'gpx') out.name ??= value || null;
      else if (grand === 'trk' || grand === 'rte') {
        parentName = value || null;
        if (grand === 'rte' && line) line.name = parentName;
      } else if (point && (grand === 'wpt' || grand === 'trkpt' || grand === 'rtept')) point.name = value || null;
    } else if (tag === 'ele' && point) {
      point.ele = num(value);
    } else if (tag === 'time' && point) {
      const t = Date.parse(value);
      point.time = Number.isNaN(t) ? null : t;
    } else if (tag === 'trkpt' || tag === 'rtept') {
      if (point && line) line.points.push({ lon: point.lon, lat: point.lat, ele: point.ele, time: point.time });
      point = null;
    } else if (tag === 'wpt') {
      if (point) out.waypoints.push({ name: point.name ?? null, lon: point.lon, lat: point.lat, ele: point.ele });
      point = null;
    } else if (tag === 'trkseg') {
      if (line) segments.push(line);
      line = null;
    } else if (tag === 'trk') {
      // The track's name may come after its segments; apply it to all of them.
      for (const s of segments) endLine({ ...s, name: parentName });
      segments = [];
    } else if (tag === 'rte') {
      endLine(line);
      line = null;
    }
    void parent;
  }
  if (!sawGpx) throw new GpxError('not a GPX file');
  if (!out.lines.length && !out.waypoints.length) throw new GpxError('the GPX file has no tracks, routes or waypoints');
  return out;
}
