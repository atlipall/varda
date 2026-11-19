/**
 * Map projections for Shapefile overlays: national grid coordinates (metres) to longitude/latitude.
 * Covers what Icelandic open data comes in: ISN93 / ISN2016 (Lambert conformal conic, EPSG:3057 and
 * 8088) and UTM (transverse Mercator), read from a Shapefile's .prj. ISN93 and
 * GRS80 are taken as WGS84 (they differ by about a metre now; fine for map overlays).
 */

export type Unproject = (x: number, y: number) => [number, number];

interface Ellipsoid { a: number; f: number }
const GRS80: Ellipsoid = { a: 6378137, f: 1 / 298.257222101 };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface LccParams { lat1: number; lat2: number; lat0: number; lon0: number; x0: number; y0: number; ellipsoid?: Ellipsoid }

/** Lambert conformal conic, two standard parallels: grid metres → [lon, lat]. */
export function lcc(p: LccParams): Unproject {
  const { a, f } = p.ellipsoid ?? GRS80;
  const e = Math.sqrt(f * (2 - f));
  const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - (e * Math.sin(phi)) ** 2);
  const t = (phi: number) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const [phi1, phi2, phi0] = [rad(p.lat1), rad(p.lat2), rad(p.lat0)];
  const n = phi1 === phi2 ? Math.sin(phi1) : (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * t(phi1) ** n);
  const rho0 = a * F * t(phi0) ** n;
  return (x, y) => {
    const dx = x - p.x0;
    const dy = rho0 - (y - p.y0);
    const rho = Math.sign(n) * Math.hypot(dx, dy);
    const tt = (rho / (a * F)) ** (1 / n);
    const theta = Math.atan2(Math.sign(n) * dx, Math.sign(n) * dy);
    let phi = Math.PI / 2 - 2 * Math.atan(tt);
    for (let i = 0; i < 8; i++) {
      const next = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
      const done = Math.abs(next - phi) < 1e-12;
      phi = next;
      if (done) break;
    }
    return [deg(theta / n) + p.lon0, deg(phi)];
  };
}

/** ISN93 (EPSG:3057), the Icelandic national grid. ISN2016 (EPSG:8088) uses the same projection. */
export const ISN93: Unproject = lcc({ lat1: 64.25, lat2: 65.75, lat0: 65, lon0: -19, x0: 500000, y0: 500000 });

export interface TmParams { lon0: number; k0: number; x0: number; y0: number; lat0?: number; ellipsoid?: Ellipsoid }

/** Transverse Mercator (UTM and the like): grid metres → [lon, lat] (Snyder's series). */
export function tm(p: TmParams): Unproject {
  const { a, f } = p.ellipsoid ?? GRS80;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const M = (phi: number) => a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const M0 = M(rad(p.lat0 ?? 0));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  return (x, y) => {
    const mu = (M0 + (y - p.y0) / p.k0) / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
    const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
    const C1 = ep2 * Math.cos(phi1) ** 2;
    const T1 = Math.tan(phi1) ** 2;
    const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
    const R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
    const D = (x - p.x0) / (N1 * p.k0);
    const lat = phi1 - ((N1 * Math.tan(phi1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
    const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(phi1);
    return [p.lon0 + deg(lon), deg(lat)];
  };
}

/** UTM zone on the northern hemisphere (Iceland: 26–28). */
export const utmNorth = (zone: number): Unproject => tm({ lon0: zone * 6 - 183, k0: 0.9996, x0: 500000, y0: 0 });

/** Longitude/latitude already: nothing to do. */
export const lonLat: Unproject = (x, y) => [x, y];

/** The projection a Shapefile's .prj (WKT) describes; null when it isn't one this app knows. */
export function fromWkt(wkt: string): Unproject | null {
  const w = wkt.replace(/\s+/g, ' ');
  if (!/^\s*PROJCS/i.test(w)) return /^\s*GEOGCS/i.test(w) ? lonLat : null;
  const param = (...names: string[]) => {
    for (const name of names) {
      const m = new RegExp(`PARAMETER\\s*\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+-]+)`, 'i').exec(w);
      if (m) return Number(m[1]);
    }
    return undefined;
  };
  const sph = /SPHEROID\s*\[\s*"[^"]*"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(w);
  const ellipsoid = sph ? { a: Number(sph[1]), f: Number(sph[2]) ? 1 / Number(sph[2]) : 0 } : GRS80;
  const unit = /UNIT\s*\[\s*"[^"]*"\s*,\s*([\d.]+)\s*\]\s*(,\s*AUTHORITY[^\]]*\])?\s*\]\s*$/i.exec(w);
  const toMetres = unit ? Number(unit[1]) : 1;
  const scaled = (u: Unproject): Unproject => (toMetres === 1 ? u : (x, y) => u(x * toMetres, y * toMetres));
  const x0 = param('false_easting') ?? 0;
  const y0 = param('false_northing') ?? 0;
  const lon0 = param('central_meridian', 'longitude_of_origin', 'longitude_of_center') ?? 0;
  if (/PROJECTION\s*\[\s*"Lambert_Conformal_Conic/i.test(w)) {
    const lat1 = param('standard_parallel_1');
    const lat0 = param('latitude_of_origin', 'latitude_of_center') ?? lat1;
    if (lat1 === undefined || lat0 === undefined) return null;
    return scaled(lcc({ lat1, lat2: param('standard_parallel_2') ?? lat1, lat0, lon0, x0: x0 * toMetres, y0: y0 * toMetres, ellipsoid }));
  }
  if (/PROJECTION\s*\[\s*"Transverse_Mercator/i.test(w)) {
    return scaled(tm({ lon0, k0: param('scale_factor') ?? 1, x0: x0 * toMetres, y0: y0 * toMetres, lat0: param('latitude_of_origin') ?? 0, ellipsoid }));
  }
  return null;
}

