import * as maplibregl from 'maplibre-gl';
import { angleDelta, chooseHeading, smoothAngle } from '../location/heading';
import { zoomForSpeed } from '../location/followZoom';
import { describeError, diag } from './diagnostics';
import { compassReset, dragged, INITIAL, longPress, tap, type LocationState } from '../location/modes';

/** Fraction of each compass change applied per reading: damps sensor jitter without lagging. */
const HEADING_SMOOTHING = 0.3;
/** Heading-up rotation ignores changes smaller than this (degrees) and runs at most this often. */
const ROTATE_MIN_DEG = 3;
const ROTATE_MIN_MS = 250;
/** Hold the locate button this long (ms) to turn location off. */
const LONG_PRESS_MS = 600;
/** In heading-up mode the position sits this fraction of the screen height below the centre
 *  (about 70% of the way down), leaving more of the way ahead in view. */
const LOOK_AHEAD = 0.2;
/** After a pinch or scroll zoom, following waits this long (ms) before moving the map again. */
const HANDS_ON_MS = 800;
/** Weight of each new GPS speed reading in the smoothed speed used for the follow zoom. */
const SPEED_SMOOTHING = 0.4;
/** The height pill is refreshed once the position has moved this far (m). */
const HEIGHT_MIN_MOVE = 10;
/** The marker's turn follows the heading in steps of at least this (degrees): the compass reads up
 *  to 60 times a second. */
const MARKER_TURN_MIN_DEG = 0.5;
/** The accuracy circle is drawn this big (px) and scaled to its size; resized only when that
 *  changes by more than `ACCURACY_STEP`, and hidden when smaller than the dot. */
const ACCURACY_PX = 100;
const ACCURACY_STEP = 0.03;
const DOT_PX = 18;

export interface Fix {
  at: [number, number];
  accuracy: number;
  time: number;
}

const ICONS: Record<'off' | 'north' | 'heading' | 'paused', string> = {
  off: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>',
  north: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 11 21 3l-8 18-2-8z" fill="currentColor"/></svg>',
  paused: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 11 21 3l-8 18-2-8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  heading: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2 20 21l-8-5-8 5z" fill="currentColor"/></svg>',
};

const LABELS = {
  off: 'Show my location',
  north: 'Following, north up. Tap for heading up',
  heading: 'Following, heading up. Tap for north up',
  paused: 'Follow my location again',
};

type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

/** Metres per CSS pixel at a latitude and zoom (512 px tiles). */
const metresPerPixel = (lat: number, zoom: number) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

/** Great-circle distance in metres (small distances). */
function distanceM(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * 6371000;
}

/**
 * The locate button (bottom-right) and everything it drives: the position marker with its
 * accuracy circle and direction cone, following the position with north up or heading up
 * (see ../location/modes.ts), and the ground-height pill (bottom-left, above the scale).
 */
export class LocationControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private state: LocationState = INITIAL;
  private readonly container = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly marker: maplibregl.Marker;
  private readonly markerEl = document.createElement('div');
  private readonly accuracyEl = document.createElement('div');
  private readonly accuracyRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  /** The accuracy circle's scale as drawn (0: hidden). */
  private accuracyScale = 0;
  /** The marker's turn as drawn. */
  private markerTurn: number | null = null;
  private readonly coneEl = document.createElement('div');
  private watchId: number | null = null;
  private fix: Fix | null = null;
  private gps: { heading: number | null; speed: number | null } = { heading: null, speed: null };
  private compass: { heading: number; time: number } | null = null;
  private heading: number | null = null;
  private lastRotate = 0;
  private heightAt: [number, number] | null = null;
  private pressTimer = 0;
  private longPressed = false;
  /** The next fix is the first since location was turned on: zoom in to it. */
  private firstFix = false;
  /** Whether this watch's first fix went into the diagnostics yet. */
  private fixNoted = false;
  /** A zoom-in in progress: later follow moves (new fixes, heading turns) must keep aiming for it,
   *  or each new easeTo restarts from the half-finished zoom and the zoom-in stalls. */
  private targetZoom: number | null = null;
  /** Zoom follows speed (see ../location/followZoom.ts) until the user zooms by hand. */
  private autoZoom = false;
  /** Until then the user is zooming by hand: following doesn't move the map under their fingers. */
  private handsOnUntil = 0;
  private followZoom: number | null = null;
  /** Smoothed GPS speed (m/s), null when the GPS reports none. */
  private speed: number | null = null;

  /** `elevation` looks up the ground height (m) at a point, null when unknown. */
  constructor(private readonly elevation: (lon: number, lat: number) => Promise<number | null>, private readonly heightEl: HTMLElement) {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.button.type = 'button';
    this.button.className = 'locate-button';
    this.container.append(this.button);
    this.markerEl.className = 'you';
    this.accuracyEl.className = 'you-accuracy';
    this.accuracyEl.hidden = true;
    // An SVG circle, so its outline stays 1 px however far it's scaled (its stroke is set to 1/scale).
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${ACCURACY_PX} ${ACCURACY_PX}`);
    svg.setAttribute('width', String(ACCURACY_PX));
    svg.setAttribute('height', String(ACCURACY_PX));
    for (const [k, v] of [['cx', ACCURACY_PX / 2], ['cy', ACCURACY_PX / 2], ['r', ACCURACY_PX / 2]] as const) this.accuracyRing.setAttribute(k, String(v));
    svg.append(this.accuracyRing);
    this.accuracyEl.append(svg);
    this.coneEl.className = 'you-cone';
    const dot = document.createElement('div');
    dot.className = 'you-dot';
    this.markerEl.append(this.accuracyEl, this.coneEl, dot);
    this.marker = new maplibregl.Marker({ element: this.markerEl, rotationAlignment: 'map', pitchAlignment: 'map' });
    this.render();
  }

  /** Called whenever location turns on or off (following or paused counts as on). */
  onActiveChange: ((active: boolean) => void) | null = null;
  /** Called on every mode change (for remembering it across restarts). */
  onStateChange: ((state: LocationState) => void) | null = null;
  /** Called with the smoothed GPS speed (m/s) on each fix that has one. */
  onSpeed: ((mps: number) => void) | null = null;
  /** Called on every GPS fix (for navigation): where, how accurate (m). */
  onFix: ((at: [number, number], accuracy: number) => void) | null = null;

  /** The latest position fix, if any. */
  get lastFix(): Fix | null {
    return this.fix;
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    this.button.addEventListener('pointerdown', () => {
      this.longPressed = false;
      this.pressTimer = window.setTimeout(() => {
        this.longPressed = true;
        this.setState(longPress());
      }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) this.button.addEventListener(ev, () => clearTimeout(this.pressTimer));
    this.button.addEventListener('click', () => {
      if (this.longPressed) return; // the long press already turned location off
      this.press();
    });
    // A drag (or a rotate gesture) by the user pauses following; programmatic moves have no originalEvent.
    map.on('dragstart', () => this.setState(dragged(this.state)));
    map.on('rotatestart', (e: { originalEvent?: Event }) => {
      if (e.originalEvent && this.state.mode === 'heading') this.setState(dragged(this.state));
    });
    map.on('zoom', () => this.sizeAccuracy());
    // A zoom-in is done once reached; a pinch by the user overrides it.
    map.on('zoomend', () => {
      if (this.targetZoom !== null && Math.abs(map.getZoom() - this.targetZoom) < 0.01) this.targetZoom = null;
    });
    // Zooming by hand wins: no automatic zoom until the next tap on the locate button. Detected from
    // the input itself: MapLibre's zoom events don't reliably say whether the user started them.
    const manualZoom = () => {
      this.targetZoom = null;
      this.autoZoom = false;
      this.handsOnUntil = Date.now() + HANDS_ON_MS;
    };
    const canvas = map.getCanvasContainer();
    let lastTap = 0;
    // Fingers still on the map: keep holding off following.
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 2) this.handsOnUntil = Date.now() + HANDS_ON_MS;
    }, { passive: true });
    canvas.addEventListener('wheel', manualZoom, { passive: true });
    canvas.addEventListener('dblclick', manualZoom);
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) return manualZoom(); // pinch
      const now = Date.now();
      if (now - lastTap < 350) manualZoom(); // double tap
      lastTap = now;
    }, { passive: true });
    for (const b of map.getContainer().querySelectorAll('.maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out')) b.addEventListener('click', manualZoom);
    // The compass button returns to north up (it resets the bearing itself).
    map.getContainer().querySelector('.maplibregl-ctrl-compass')?.addEventListener('click', () => this.setState(compassReset(this.state)));
    return this.container;
  }

  /** Turns location on, as the first tap on the button does; does nothing when it's already on.
   *  Call it from a user gesture (iOS grants compass access only then). */
  activate(): void {
    if (this.state.mode === 'off') this.press();
  }

  private press(): void {
    // Turning location on zooms in; resuming after a drag, and switching north/heading up, keep the
    // zoom you're at (heading up zoomed out stays zoomed out).
    const startsFollowing = this.state.mode === 'off';
    if (this.state.mode === 'off') {
      this.firstFix = true;
      this.start();
    }
    this.setState(tap(this.state), startsFollowing);
  }

  /** The mode, to remember across restarts. */
  get current(): LocationState {
    return this.state;
  }

  /** Follows with heading up, turning location on if it's off (navigation; call from a tap). */
  navigate(): void {
    if (this.state.mode === 'off') {
      this.firstFix = true;
      this.start();
    }
    this.setState({ mode: 'heading', paused: false }, true);
  }

  /** Brings back a remembered mode at startup (no tap: the compass is asked for on the next touch). */
  restore(state: LocationState): void {
    if (state.mode === 'off' || this.state.mode !== 'off') return;
    this.firstFix = true;
    this.start();
    this.setState(state);
  }

  onRemove(): void {
    this.stop();
    this.container.remove();
    this.map = null;
  }

  private setState(next: LocationState, zoomIn = false): void {
    const prev = this.state;
    this.state = next;
    if (next.mode === 'off' && prev.mode !== 'off') this.stop();
    if ((next.mode === 'off') !== (prev.mode === 'off')) this.onActiveChange?.(next.mode !== 'off');
    this.render();
    this.onStateChange?.(next);
    // Following heading up, a pinch only zooms: turning the map by hand would pause heading up (and
    // a pinch nearly always turns a little). Otherwise two fingers may turn the map as usual.
    if (this.map) {
      if (next.mode === 'heading' && !next.paused) this.map.touchZoomRotate.disableRotation();
      else this.map.touchZoomRotate.enableRotation();
    }
    if (next.mode !== 'off' && !next.paused) this.follow(true, zoomIn);
  }

  private render(): void {
    const { mode, paused } = this.state;
    const look = mode === 'off' ? 'off' : paused ? 'paused' : mode;
    this.button.innerHTML = ICONS[look];
    this.button.dataset.state = look;
    this.button.title = LABELS[look];
    this.button.setAttribute('aria-label', LABELS[look]);
  }

  /** Starts GPS and compass. Called from the tap itself: iOS only grants compass access to a user gesture. */
  private start(): void {
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> } | undefined;
    const listen = () => {
      const absolute = 'ondeviceorientationabsolute' in window;
      window.addEventListener(absolute ? 'deviceorientationabsolute' : 'deviceorientation', this.onOrientation as EventListener);
    };
    // Without a tap (a mode restored at startup) iOS refuses: ask again on the next touch.
    const ask = (requestPermission: () => Promise<'granted' | 'denied'>) => requestPermission().then((r) => r === 'granted' && listen(), () => {
      document.addEventListener('touchend', () => {
        if (this.watchId !== null) ask(requestPermission);
      }, { once: true });
    });
    if (DOE?.requestPermission) ask(DOE.requestPermission.bind(DOE));
    else listen();
    if (!('geolocation' in navigator)) return this.unavailable('This device has no location service.');
    diag('location: started');
    this.fixNoted = false;
    this.watchId = navigator.geolocation.watchPosition(this.onPosition, this.onError, { enableHighAccuracy: true, maximumAge: 5000 });
  }

  private stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener('deviceorientationabsolute', this.onOrientation as EventListener);
    window.removeEventListener('deviceorientation', this.onOrientation as EventListener);
    this.marker.remove();
    this.fix = null;
    this.compass = null;
    this.heading = null;
    this.heightAt = null;
    this.targetZoom = null;
    this.autoZoom = false;
    this.followZoom = null;
    this.speed = null;
    this.heightEl.hidden = true;
    this.button.classList.remove('unavailable');
  }

  private unavailable(message: string): void {
    const wasOn = this.state.mode !== 'off';
    this.stop();
    this.state = INITIAL;
    this.render();
    this.onStateChange?.(this.state);
    if (wasOn) this.onActiveChange?.(false);
    this.button.classList.add('unavailable');
    this.button.title = message;
  }

  private readonly onError = (err: GeolocationPositionError): void => {
    diag(`location ${describeError(err)}`);
    if (err.code === err.PERMISSION_DENIED) this.unavailable('Location access is off. Allow it in Settings → Safari → Location.');
    // Other errors (timeout, no signal) are transient: keep watching.
  };

  private readonly onPosition = (pos: GeolocationPosition): void => {
    const map = this.map;
    if (!map || this.state.mode === 'off') return;
    const at: [number, number] = [pos.coords.longitude, pos.coords.latitude];
    this.fix = { at, accuracy: pos.coords.accuracy, time: Date.now() };
    this.gps = { heading: pos.coords.heading, speed: pos.coords.speed };
    this.marker.setLngLat(at);
    if (!this.marker.getElement().isConnected) this.marker.addTo(map);
    this.sizeAccuracy();
    this.updateHeading();
    const v = pos.coords.speed;
    if (v !== null && Number.isFinite(v)) this.speed = this.speed === null ? v : this.speed + (v - this.speed) * SPEED_SMOOTHING;
    if (this.speed !== null) this.onSpeed?.(this.speed);
    this.onFix?.(at, pos.coords.accuracy);
    if (!this.fixNoted) {
      this.fixNoted = true;
      diag(`location: first fix, ±${Math.round(pos.coords.accuracy)} m`);
    }
    if (this.firstFix && !this.state.paused) {
      this.firstFix = false;
      this.follow(true, true);
    } else {
      if (this.autoZoom && !this.state.paused) {
        const z = zoomForSpeed(this.speed, this.followZoom, at[1]);
        if (z !== this.followZoom) this.followZoom = this.targetZoom = z;
      }
      this.follow(false);
    }
    this.updateHeight(at);
  };

  private readonly onOrientation = (e: OrientationEvent): void => {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iOS: clockwise from north
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha; // alpha is counter-clockwise
    if (h == null) return;
    // Headings are relative to the device's top; correct for a rotated screen.
    const angle = screen.orientation?.angle ?? 0;
    this.compass = { heading: (h + angle) % 360, time: Date.now() };
    this.updateHeading();
  };

  private updateHeading(): void {
    const next = chooseHeading({ compass: this.compass, gps: this.gps, now: Date.now() });
    this.coneEl.hidden = next == null;
    if (next == null) return;
    this.heading = smoothAngle(this.heading, next, this.compass ? HEADING_SMOOTHING : 1);
    if (this.markerTurn === null || Math.abs(angleDelta(this.markerTurn, this.heading)) >= MARKER_TURN_MIN_DEG) {
      this.markerTurn = this.heading;
      this.marker.setRotation(this.heading);
    }
    if (this.state.mode === 'heading' && !this.state.paused && this.map) {
      const now = Date.now();
      if (Math.abs(angleDelta(this.map.getBearing(), this.heading)) >= ROTATE_MIN_DEG && now - this.lastRotate >= ROTATE_MIN_MS) {
        this.lastRotate = now;
        this.follow(false);
      }
    }
  }

  /** Starts the automatic follow zoom at the zoom for the current speed, unless the map is already
   *  zoomed in closer than that (a closer zoom chosen by the user is kept, without auto zoom). */
  private startZoom(map: maplibregl.Map): void {
    const z = zoomForSpeed(this.speed, null, this.fix?.at[1] ?? map.getCenter().lat);
    this.autoZoom = map.getZoom() <= z + 0.01;
    this.followZoom = this.autoZoom ? z : null;
    this.targetZoom = this.autoZoom ? z : this.targetZoom;
  }

  /** Centres on the position (and turns the map in heading-up mode, with the position lower down
   *  for look-ahead). `jump`: a mode change, animate longer. `zoomIn`: (re)start the follow zoom. */
  private follow(jump: boolean, zoomIn = false): void {
    const map = this.map;
    if (!map || !this.fix || this.state.mode === 'off' || this.state.paused) return;
    // Not in the middle of a pinch or scroll zoom: the next fix catches up.
    if (Date.now() < this.handsOnUntil) return;
    const heading = this.state.mode === 'heading';
    const bearing = heading ? (this.heading ?? map.getBearing()) : 0;
    if (zoomIn) this.startZoom(map);
    const zoom = this.targetZoom ?? map.getZoom();
    const offset: [number, number] = [0, heading ? map.getContainer().clientHeight * LOOK_AHEAD : 0];
    map.easeTo({ center: this.fix.at, bearing, zoom, offset, duration: jump ? 600 : 300, essential: true });
  }

  /** Sizes the accuracy circle by scaling it (no layout), at most twice the screen's diagonal
   *  across (still covering the screen from any corner). */
  private sizeAccuracy(): void {
    if (!this.map || !this.fix) return;
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const px = Math.min((2 * this.fix.accuracy) / metresPerPixel(this.fix.at[1], this.map.getZoom()), 2 * Math.hypot(w, h));
    const el = this.accuracyEl;
    if (!(px >= DOT_PX)) {
      el.hidden = true;
      this.accuracyScale = 0;
      return;
    }
    const scale = px / ACCURACY_PX;
    if (this.accuracyScale && Math.abs(scale / this.accuracyScale - 1) < ACCURACY_STEP) return;
    this.accuracyScale = scale;
    el.hidden = false;
    el.style.transform = `scale(${scale})`;
    this.accuracyRing.setAttribute('stroke-width', String(1 / scale));
    this.accuracyRing.setAttribute('r', String(ACCURACY_PX / 2 - 0.5 / scale));
  }

  private updateHeight(at: [number, number]): void {
    if (this.heightAt && distanceM(this.heightAt, at) < HEIGHT_MIN_MOVE) return;
    this.heightAt = at;
    this.elevation(at[0], at[1]).then((m) => {
      if (this.state.mode === 'off') return;
      this.heightEl.hidden = m == null;
      if (m != null) this.heightEl.textContent = `▲ ${Math.round(m)} m`;
    }, () => {
      this.heightEl.hidden = true;
    });
  }
}

/** A plain control holding the height pill, stacked above the scale bar (bottom-left). */
export class HeightControl implements maplibregl.IControl {
  readonly element = document.createElement('div');
  constructor() {
    this.element.className = 'maplibregl-ctrl height-pill';
    this.element.hidden = true;
    this.element.title = 'Ground height at your position';
  }
  onAdd(): HTMLElement {
    return this.element;
  }
  onRemove(): void {
    this.element.remove();
  }
}
