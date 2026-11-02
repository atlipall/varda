/**
 * The tap card's small charts: a place's hours as three strips (wind with gusts, temperature,
 * rain/snow) sharing one time axis, the chosen hour marked. Drawn as SVG text.
 */

export interface Hours {
  times: number[];
  wind: number[];
  gust: number[];
  temp: number[];
  rain: number[];
}

export const CHART_W = 320;
const STRIP_H = 38;
const GAP = 16;
const LEFT = 30;
const RIGHT = 6;
/** The time axis's labels, under the three strips. */
const AXIS_Y = 3 * (STRIP_H + GAP) + 12 - GAP + 14;
const CHART_H = AXIS_Y + 4;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fin = (v: number) => Number.isFinite(v);

/** The x of hour `i` of `n`. */
export const xOf = (i: number, n: number) => LEFT + (n <= 1 ? 0 : ((CHART_W - LEFT - RIGHT) * i) / (n - 1));

/** The hour nearest x (for a tap on the chart). */
export function indexAtX(x: number, n: number): number {
  if (n <= 1) return 0;
  return Math.max(0, Math.min(n - 1, Math.round(((x - LEFT) / (CHART_W - LEFT - RIGHT)) * (n - 1))));
}

function line(values: number[], y: (v: number) => number, cls: string): string {
  const n = values.length;
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (!fin(v)) return void (pen = false);
    d += `${pen ? 'L' : 'M'}${xOf(i, n).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d ? `<path class="${cls}" d="${d}"/>` : '';
}

/** The chart for `h`, the hour `selected` marked; midnights are named by `dayName` (times in UTC,
 *  Iceland's time). */
export function chartSvg(h: Hours, selected: number, dayName: (t: number) => string): string {
  const n = h.times.length;
  const parts: string[] = [];
  const strip = (k: number, title: string, lo: number, hi: number, body: (y: (v: number) => number) => string, unit: string) => {
    const top = k * (STRIP_H + GAP) + 12;
    const span = hi - lo || 1;
    const y = (v: number) => top + STRIP_H - ((v - lo) / span) * STRIP_H;
    parts.push(`<text class="wx-ct" x="0" y="${top - 3}">${esc(title)}</text>`);
    parts.push(`<line class="wx-cb" x1="${LEFT}" x2="${CHART_W - RIGHT}" y1="${top + STRIP_H}" y2="${top + STRIP_H}"/>`);
    parts.push(`<text class="wx-cv" x="${LEFT - 4}" y="${top + 4}">${Math.round(hi)}</text><text class="wx-cv" x="${LEFT - 4}" y="${top + STRIP_H}">${Math.round(lo)}</text>`);
    parts.push(`<text class="wx-cu" x="${CHART_W - RIGHT}" y="${top - 3}">${esc(unit)}</text>`);
    parts.push(body(y));
  };
  const max = (a: number[]) => Math.max(...a.filter(fin), -Infinity);
  const min = (a: number[]) => Math.min(...a.filter(fin), Infinity);
  const windHi = Math.max(10, Math.ceil(max([...h.wind, ...h.gust]) / 5) * 5);
  strip(0, 'Wind and gusts', 0, windHi, (y) => line(h.gust, y, 'wx-gust') + line(h.wind, y, 'wx-wind'), 'm/s');
  const tLo = Math.floor(Math.min(0, min(h.temp)) / 5) * 5;
  const tHi = Math.max(tLo + 10, Math.ceil(max(h.temp) / 5) * 5);
  strip(1, 'Temperature', tLo, tHi, (y) => (tLo < 0 && tHi > 0 ? `<line class="wx-c0" x1="${LEFT}" x2="${CHART_W - RIGHT}" y1="${y(0)}" y2="${y(0)}"/>` : '') + line(h.temp, y, 'wx-temp'), '°C');
  const rHi = Math.max(2, Math.ceil(max(h.rain)));
  strip(2, 'Rain / snow', 0, rHi, (y) => {
    const w = Math.max(1, (CHART_W - LEFT - RIGHT) / Math.max(1, n) - 1);
    return h.rain.map((v, i) => (fin(v) && v > 0.04 ? `<rect class="wx-rain" x="${(xOf(i, n) - w / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}"/>` : '')).join('');
  }, 'mm/h');
  // The time axis: a mark at each midnight and midday, named.
  const axisY = AXIS_Y;
  h.times.forEach((t, i) => {
    const hour = new Date(t).getUTCHours();
    if (hour !== 0 && hour !== 12) return;
    const x = xOf(i, n);
    parts.push(`<line class="wx-cg" x1="${x}" x2="${x}" y1="12" y2="${axisY - 12}"/>`);
    parts.push(`<text class="wx-cx" x="${x}" y="${axisY}">${esc(hour === 0 ? dayName(t) : '12')}</text>`);
  });
  if (selected >= 0 && selected < n) {
    const x = xOf(selected, n);
    parts.push(`<line class="wx-sel" x1="${x}" x2="${x}" y1="8" y2="${axisY - 12}"/>`);
  }
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" width="100%" role="img" aria-label="Wind, temperature and rain by hour">${parts.join('')}</svg>`;
}
