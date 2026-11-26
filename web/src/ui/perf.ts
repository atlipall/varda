/** The tile times the summary's percentiles are taken over: the latest this many. */
const WINDOW = 1000;
/** The panel (shown with ?debug) is redrawn at most this often (ms). */
const REDRAW_MS = 500;

/** Tile build times and counts, summed up in the ?debug panel (and read by the e2e). Each tile only
 *  writes its time into a fixed window; the sorting is done when the summary is shown or read. */
export class PerfStats {
  private readonly ms = new Float64Array(WINDOW);
  private tiles = 0;
  private bad = 0;
  private features = 0;
  private redraw = 0;

  constructor(private readonly el: HTMLElement) {}

  record(ms: number, badSections: number, features: number): void {
    this.ms[this.tiles % WINDOW] = ms;
    this.tiles++;
    this.bad += badSections;
    this.features += features;
    if (this.el.hidden || this.redraw) return;
    this.redraw = window.setTimeout(() => {
      this.redraw = 0;
      this.el.textContent = this.summary();
    }, REDRAW_MS);
  }

  summary(): string {
    if (!this.tiles) return 'no tiles yet';
    const s = this.ms.slice(0, Math.min(this.tiles, WINDOW)).sort();
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(0);
    const last = this.tiles > WINDOW ? ` (last ${WINDOW})` : '';
    return `tiles ${this.tiles}${last}  p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  max ${s[s.length - 1].toFixed(0)} ms\n` +
      `features ${this.features}  bad sections ${this.bad}`;
  }
}
