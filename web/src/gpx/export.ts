import type { LonLat } from '../routing/plan';
import type { JoinedRoute } from '../routing/waypoints';
import type { Gpx } from './parse';

/** What a route export needs: the route as drawn and its named stops. */
export interface RouteExport {
  name: string;
  /** Distance and time as the card shows them, e.g. "125 km · 2 h 07 min". */
  summary: string;
  route: JoinedRoute;
  start: LonLat;
  vias: Array<{ name: string | null; near?: string; lon: number; lat: number }>;
  dest: { name: string | null; near?: string; lon: number; lat: number };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pt = ([lon, lat]: LonLat) => `lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"`;

/**
 * The route as a GPX 1.1 file: a track along the drawn line (from the chosen start, including the
 * ways on foot at the ends, to the destination) and waypoints for the start, each waypoint and the
 * destination. A track rather than a GPX route, so a device shows this exact line instead of
 * working out its own.
 */
export function routeGpx(r: RouteExport, now = new Date()): string {
  const line: LonLat[] = [
    ...(r.route.offRoadStart?.slice(0, -1) ?? []),
    ...r.route.coords,
    ...(r.route.offRoadEnd?.slice(1) ?? []),
  ];
  const wpt = (at: LonLat, name: string) => `  <wpt ${pt(at)}><name>${esc(name)}</name></wpt>`;
  const label = (p: { name: string | null; near?: string }, fallback: string) => p.name ?? p.near ?? fallback;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Varda" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(r.name)}</name><desc>${esc(r.summary)}</desc><time>${now.toISOString()}</time></metadata>`,
    wpt(r.start, 'Start'),
    ...r.vias.map((v, i) => wpt([v.lon, v.lat], `Waypoint ${i + 1}${v.name ?? v.near ? `: ${label(v, '')}` : ''}`)),
    wpt([r.dest.lon, r.dest.lat], label(r.dest, 'Destination')),
    `  <trk><name>${esc(r.name)}</name><desc>${esc(r.summary)}</desc><trkseg>`,
    ...line.map((p) => `    <trkpt ${pt(p)}/>`),
    '  </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');
}

/** A track as a GPX 1.1 file: its lines (with heights and times where it has them) and waypoints. */
export function trackGpx(g: Gpx, name: string, now = new Date()): string {
  const ele = (e: number | null) => (e === null ? '' : `<ele>${e.toFixed(1)}</ele>`);
  const time = (t: number | null) => (t === null ? '' : `<time>${new Date(t).toISOString()}</time>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Varda" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name><time>${now.toISOString()}</time></metadata>`,
    ...g.waypoints.map((w) => `  <wpt ${pt([w.lon, w.lat])}>${ele(w.ele)}${w.name ? `<name>${esc(w.name)}</name>` : ''}</wpt>`),
    ...g.lines.flatMap((l) => [
      `  <trk><name>${esc(l.name ?? name)}</name><trkseg>`,
      ...l.points.map((p) => `    <trkpt ${pt([p.lon, p.lat])}>${ele(p.ele)}${time(p.time)}</trkpt>`),
      '  </trkseg></trk>',
    ]),
    '</gpx>',
    '',
  ].join('\n');
}

/** A file name from a route name: letters (any script), digits, spaces and dashes kept. */
export const gpxFileName = (name: string) => `${name.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().replace(/\s+/g, ' ') || 'Route'}.gpx`;

/** Hands a file to the user: the share sheet where the browser can share files (iPhone: save to
 *  Files, AirDrop, another app), else a download. */
export async function shareFile(fileName: string, text: string, type = 'application/gpx+xml'): Promise<void> {
  const file = new File([text], fileName, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await nav.share({ files: [file], title: fileName });
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return; // the user closed the share sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
