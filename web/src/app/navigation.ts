import { maneuvers, type Maneuver, type Turn } from '../routing/maneuvers';
import type { LonLat } from '../routing/plan';
import { Progress, type Where } from '../routing/progress';
import type { JoinedRoute } from '../routing/waypoints';
import { roadClass } from '../routing/roadClass';
import { roundaboutIcon } from '../ui/roundaboutIcon';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** The banner and panel are redrawn on every fix: only what changed is written to the page. */
const setText = (id: string, text: string) => {
  const e = $(id);
  if (e.textContent !== text) e.textContent = text;
};
/** The icons written, by element (reading innerHTML back would serialise it each time). */
const icons = new WeakMap<HTMLElement, string>();
const setIcon = (id: string, html: string) => {
  const e = $(id);
  if (icons.get(e) === html) return;
  icons.set(e, html);
  e.innerHTML = html;
};

/** Further than this from the route (m)… */
const OFF_ROUTE_M = 50;
/** …for this many fixes in a row is off the route (one stray fix isn't). */
const OFF_ROUTE_FIXES = 3;
/** Closer than this (m) is back on the route. */
const BACK_ON_M = 25;
/** Fixes less accurate than this (m) don't count towards being off the route. */
const ROUGH_FIX_M = 60;
/** Within this (m) of the end is there. */
const ARRIVED_M = 30;
/** Screens that show the guidance as a column on the left (matches the CSS). */
const WIDE = '(min-width: 900px) and (orientation: landscape)';
/** Map kept clear to the right of the guidance column (px). */
const COLUMN_GAP = 16;

/** What navigation needs from the route planner. */
export interface NavRoute {
  route: JoinedRoute;
  /** "To Landmannalaugar" (or the saved route's name). */
  title: string;
  dest: string;
  /** Following a track (its wording: "Off the track"). */
  track?: boolean;
}

/** Ways navigation reaches the rest of the app. */
export interface NavHooks {
  /** Plans the route again from your position, leaving out the first `passed` waypoints; `along`:
   *  metres along the route you had got to (a track is rejoined ahead of it). */
  replan(passed: number, along: number): void;
  /** Keeps the map's centre clear of a column of `left` pixels (0: none). */
  keepClear(left: number): void;
  /** The "Ask before rerouting in the highlands" setting. */
  askInHighlands(): boolean;
  /** Navigation ended (the route stays). */
  ended(): void;
  /** Undo of End: navigation along `nav` is about to start again (a track's, say, is put back). */
  resumed(nav: NavRoute): void;
}

/** How long "Guidance ended · Undo" stays (ms). */
const UNDO_MS = 8000;

const fmtDist = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);
function fmtLeft(s: number): string {
  const min = Math.round(s / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const svg = (body: string) => `<svg viewBox="0 0 56 56" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ARROWS: Record<Turn, string> = {
  straight: svg('<path d="M28 50V10M16 22 28 10l12 12"/>'),
  'slight-left': svg('<path d="M34 50V32L20 16M18 30V14h16"/>'),
  'slight-right': svg('<path d="M22 50V32l14-16M38 30V14H22"/>'),
  left: svg('<path d="M36 50V27a7 7 0 0 0-7-7H14M20 9 8 20l12 11"/>'),
  right: svg('<path d="M20 50V27a7 7 0 0 1 7-7h15M36 9l12 11-12 11"/>'),
  'sharp-left': svg('<path d="M38 50V16L14 38M14 22v16h16"/>'),
  'sharp-right': svg('<path d="M18 50V16l24 22M42 22v16H26"/>'),
  uturn: svg('<path d="M38 50V22a10 10 0 0 0-20 0v16M8 30l10 10 10-10"/>'),
};
/** A roundabout whose exit direction isn't known. */
const ROUNDABOUT = svg('<circle cx="28" cy="25" r="9"/><path d="M28 50V34M36 17l9-9M46 18V7H35"/>');
const FLAG = svg('<path d="M14 50V8M14 10h26l-6 9 6 9H14"/>');
const PIN = '<svg viewBox="0 0 56 56"><path d="M28 4C18.6 4 11 11.6 11 21c0 13 17 31 17 31s17-18 17-31C45 11.6 37.4 4 28 4z" fill="currentColor"/><circle cx="28" cy="21" r="6.5" fill="#1d3f8f"/></svg>';
const WARNING = svg('<path d="M28 8 50 46H6z" stroke-width="5"/><path d="M28 22v12" stroke-width="5"/><circle cx="28" cy="40" r="2" fill="currentColor"/>');

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Compass bearing (degrees clockwise from north) from a to b. */
function bearing(a: LonLat, b: LonLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return ((Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

function icon(m: Maneuver): string {
  if (m.kind === 'roundabout') return m.exitAngle === undefined ? ROUNDABOUT : roundaboutIcon(m.exitAngle);
  if (m.kind === 'via' || m.kind === 'join') return FLAG;
  if (m.kind === 'arrive') return PIN;
  if (m.kind === 'depart' || m.kind === 'continue') return ARROWS.straight;
  return ARROWS[m.turn ?? 'straight'];
}

/**
 * Turn-by-turn guidance along a planned route (no voice): the next instruction and its distance in
 * a banner, the one after it below, and the arrival time, time and distance left in a panel. Being
 * off the route for a few fixes asks before planning again; "Keep going" stays quiet until you're
 * back on it.
 */
export class Navigator {
  private progress: Progress | null = null;
  private steps: Maneuver[] = [];
  private nav: NavRoute | null = null;
  private offFixes = 0;
  /** "Keep going" was chosen: don't ask again until back on the route. */
  private quiet = false;
  private asking = false;
  private lastOn: Where | null = null;
  private arrived = false;
  /** "Plan again" is under way: no off-route question or banner until the new route (or not). */
  private replanning = false;
  /** Metres along the route to each waypoint (from the route's road stretches). */
  private viaAlong: number[] = [];
  /** Planning again failed: say so until back on the route. */
  private noRoute = false;
  /** The instruction last announced to screen readers. */
  private said = '';
  /** The last GPS fix, for guidance started again by Undo. */
  private lastFix: { at: LonLat; accuracy: number } | null = null;
  /** The guidance End just stopped, while its Undo is offered. */
  private undoable: NavRoute | null = null;
  private undoTimer = 0;

  /** On a wide screen the guidance is a column on the left: how much of the map's width it takes
   *  (as drawn, so car-sized cards count at their size), for the map to centre in the rest. */
  private columnWidth(): number {
    if (!matchMedia(WIDE).matches) return 0;
    const right = Math.max(...['nav-banner', 'nav-bottom'].map((id) => $(id).getBoundingClientRect().right));
    return Math.ceil(right) + COLUMN_GAP;
  }

  constructor(private readonly hooks: NavHooks) {
    // Turning a phone, or a head unit's screen changing size, moves the guidance column.
    matchMedia(WIDE).addEventListener('change', () => this.nav && this.hooks.keepClear(this.columnWidth()));
    // End stops at once (a tap that misses on a bumpy road shouldn't need a new route planned):
    // "Guidance ended · Undo" starts it again for a few seconds.
    $('nav-end').onclick = () => {
      const nav = this.nav;
      this.end();
      if (nav) this.offerUndo(nav);
    };
    $('nav-undo-button').onclick = () => {
      const nav = this.undoable;
      this.dropUndo();
      if (!nav) return;
      this.hooks.resumed(nav);
      this.start(nav, this.lastFix);
    };
    $('nav-keep').onclick = () => {
      this.quiet = true;
      this.ask(false);
    };
    $('nav-replan').onclick = () => {
      this.ask(false);
      this.replan();
    };
  }

  /** Plans the route again from here, leaving out the waypoints already passed. */
  private replan(): void {
    this.replanning = true;
    this.banner(WARNING, 'Planning…', 'A new route from here', null, 'off');
    const along = this.lastOn?.along ?? 0;
    this.hooks.replan(this.viaAlong.filter((a) => a <= along).length, along);
  }

  /** Where you left the route was off the roads (a trail): there's no road way back to plan. */
  private onTrail(): boolean {
    const segs = this.nav?.route.segs;
    const i = this.lastOn?.index;
    if (!segs?.length || i === undefined) return false;
    let k = 0;
    while (k + 1 < segs.length && segs[k + 1].start <= i) k++;
    return !!segs[k].trail;
  }

  /** Where you left the route was an F-road or a track: the highlands. */
  private inHighlands(): boolean {
    const segs = this.nav?.route.segs;
    const i = this.lastOn?.index;
    if (!segs?.length || i === undefined) return false;
    let k = 0;
    while (k + 1 < segs.length && segs[k + 1].start <= i) k++;
    // Routes saved before segments carried `highland` go by the road's name and type.
    return !!segs[k].highland || roadClass(segs[k].type, segs[k].name) !== 0;
  }

  get active(): boolean {
    return this.nav !== null;
  }

  /** Starts guidance along `nav` (or carries on along a route planned again). */
  start(nav: NavRoute, fix: { at: LonLat; accuracy: number } | null): void {
    this.dropUndo();
    this.nav = nav;
    const r = nav.route;
    const segs = r.segs?.length ? r.segs : [{ start: 0, name: null, type: 0, junction: false, seconds: r.seconds }];
    this.progress = new Progress(r.coords, r.segs, r.seconds);
    this.steps = maneuvers(r.coords, segs, nav.dest);
    this.viaAlong = (r.segs ?? []).filter((s) => s.via).map((s) => this.progress!.cum[s.start]);
    this.replanning = false;
    this.noRoute = false;
    this.offFixes = 0;
    this.quiet = false;
    this.arrived = false;
    this.lastOn = null;
    this.ask(false);
    document.body.classList.add('navigating');
    $('nav-banner').hidden = false;
    $('nav-bottom').hidden = false;
    $('nav-to').textContent = nav.title;
    this.show({ along: 0, off: 0, index: 0 });
    // On a wide landscape screen (a car head unit) the guidance is a column on the left: the map
    // centres on you in the space to its right (measured now the column is shown).
    this.hooks.keepClear(this.columnWidth());
    if (fix) this.fix(fix.at, fix.accuracy);
  }

  /** Planning again from here failed: say so, and don't ask again until back on the route. */
  couldNotReplan(): void {
    this.replanning = false;
    this.noRoute = true;
    this.quiet = true;
    this.banner(WARNING, 'No new route', "Couldn't plan a route from here", null, 'off');
  }

  end(): void {
    this.dropUndo();
    if (!this.nav) return;
    this.nav = null;
    this.progress = null;
    document.body.classList.remove('navigating');
    this.hooks.keepClear(0);
    $('nav-banner').hidden = true;
    $('nav-bottom').hidden = true;
    this.hooks.ended();
  }

  /** Shows "Guidance ended · Undo" (under the search row). */
  private offerUndo(nav: NavRoute): void {
    this.undoable = nav;
    $('nav-undo').hidden = false;
    this.undoTimer = window.setTimeout(() => this.dropUndo(), UNDO_MS);
  }

  private dropUndo(): void {
    clearTimeout(this.undoTimer);
    this.undoable = null;
    $('nav-undo').hidden = true;
  }

  /** A GPS fix: where on the route, what's next; off the route for a while asks to plan again. */
  fix(at: LonLat, accuracy: number): void {
    this.lastFix = { at, accuracy };
    if (!this.progress || !this.nav) return;
    const where = this.progress.locate(at);
    // Arrived: guidance is done (walking the last bit off the road to a hut isn't "off route").
    if (this.arrived) return this.panel({ ...where, along: this.progress.total });
    // A new route is being planned: keep the trip panel going, nothing else.
    if (this.replanning) return this.panel(this.lastOn ?? where);
    if (where.off <= BACK_ON_M) {
      this.offFixes = 0;
      this.quiet = false;
      this.noRoute = false;
      if (this.asking) this.ask(false);
    } else if (where.off > OFF_ROUTE_M && accuracy <= ROUGH_FIX_M) this.offFixes++;
    const off = this.offFixes >= OFF_ROUTE_FIXES;
    if (!off) this.lastOn = where;
    // Off the route: a new route straight away; in the highlands, where leaving the route may be on
    // purpose (a viewpoint, a ford), ask first if the setting says so. Off a trail there's no road
    // way back: the banner points the way instead.
    const trail = off && this.onTrail();
    if (off && !trail && !this.quiet && !this.asking) {
      if (this.hooks.askInHighlands() && this.inHighlands()) this.ask(true);
      else return this.replan();
    }
    if (off) {
      const what = this.nav.track ? 'Off the track' : 'Off route';
      if (trail) {
        const back = this.progress.pointAt(where.along);
        this.banner(WARNING, what, `${fmtDist(where.off)} from it · back to it ${COMPASS[Math.round(bearing(at, back) / 45) % 8]}`, null, 'off');
      } else if (this.noRoute) this.banner(WARNING, 'No new route', "Couldn't plan a route from here", null, 'off');
      else this.banner(WARNING, what, `You're ${fmtDist(where.off)} from the ${this.nav.track ? 'track' : 'route'}`, null, 'off');
      this.panel(this.lastOn ?? where);
      return;
    }
    this.show(where);
  }

  private show(where: Where): void {
    const p = this.progress!;
    if ((p.total - where.along <= ARRIVED_M && where.off <= OFF_ROUTE_M) || this.arrived) {
      this.arrived = true;
      this.banner(PIN, 'Arrived', this.nav!.dest, null, 'arrived');
      this.panel({ ...where, along: p.total });
      return;
    }
    const i = this.steps.findIndex((m) => m.along > where.along + 5);
    const next = this.steps[i] ?? this.steps[this.steps.length - 1];
    const then = this.steps[i + 1];
    this.banner(icon(next), fmtDist(next.along - where.along), next.text, then ? { m: then, gap: then.along - next.along } : null, '');
    this.panel(where);
  }

  private banner(iconSvg: string, dist: string, text: string, then: { m: Maneuver; gap: number } | null, state: '' | 'off' | 'arrived'): void {
    const b = $('nav-banner');
    if (b.className !== state) b.className = state;
    setIcon('nav-icon', iconSvg);
    setText('nav-dist', dist);
    setText('nav-text', text);
    // Screen readers hear a new instruction once, not every distance update.
    if (text !== this.said) {
      this.said = text;
      $('nav-say').textContent = state === 'off' || state === 'arrived' ? `${dist}. ${text}` : `In ${dist}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
    if ($('nav-then').hidden !== !then) $('nav-then').hidden = !then;
    if (then) {
      setIcon('nav-then-icon', icon(then.m));
      setText('nav-then-text', then.m.text);
      setText('nav-then-dist', `in ${fmtDist(then.gap)}`);
    }
  }

  private panel(where: Where): void {
    const left = this.progress!.left(where.along);
    setText('nav-arrive', clock(Date.now() + left.seconds * 1000));
    setText('nav-time', fmtLeft(left.seconds));
    setText('nav-km', `${fmtDist(left.metres)} left`);
  }

  private ask(on: boolean): void {
    this.asking = on;
    $('nav-prompt').hidden = !on;
    if (on) $('nav-replan').focus({ preventScroll: true });
  }
}
