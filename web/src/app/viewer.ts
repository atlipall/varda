import * as maplibregl from 'maplibre-gl';
import { emptyTyp, parseTyp, type Typ } from '../img/typ';
import type { RoadClasses } from '../routing/roadClass';
import { collapseNearby, describePlace, nearName, titleCase, townsOf } from '../search/describe';
import { PlaceIndex } from '../search/placeIndex';
import type { Place } from '../search/places';
import { decodePlacesCache, encodePlacesCache } from '../search/placesCache';
import { cacheKey, readText, writeText, type Stored } from '../storage/store';
import { buildStyle, FONT_REGULAR } from '../style/buildStyle';
import { preloadImages } from '../ui/images';
import { versionLabel } from '../buildInfo';
import { DEV } from '../channel';
import { featureNameAt } from '../map/featureName';
import { conventionsFor } from '../map/conventions';
import { takenText } from '../photos/photo';
import { SaveHere } from './saveHere';
import { PhotoHere } from './photoHere';
import { TrackCard } from './trackCard';
import { Dialogs } from '../ui/dialogs';
import { TrackNav } from './trackNav';
import { PerfStats } from '../ui/perf';
import { browserScreenAwake } from '../location/wakeLock';
import { readSetting, writeSetting } from '../ui/settings';
import { HeightControl, LocationControl } from './location';
import { RoutePlanner } from './route';
import { SavedPanel } from './savedPanel';
import { DriveSync } from './driveSync';
import { Photos } from './photos';
import { Weather } from './weather';
import { androidApp, DiagnosticsPanel } from './diagnostics';
import { TripRecorder } from './tripRecorder';
import { Navigator } from './navigation';
import { loadSession, saveSession } from './session';
import { TracksPanel } from './tracks';
import { TilePool, type OpenMeta } from '../worker/pool';
import { showImport } from './importScreen';

/** MapLibre zooms, i.e. one less than the raster samples' zoom, so the scale matches. */
const SAMPLES: Array<{ name: string; center: [number, number]; zoom: number }> = [
  { name: 'reykjavik-z14', center: [-21.94, 64.146], zoom: 14 },
  { name: 'landmannalaugar-z12', center: [-19.06, 63.99], zoom: 12 },
  { name: 'vatnajokull-z10', center: [-16.9, 64.02], zoom: 10 },
  { name: 'iceland-z6', center: [-18.6, 64.9], zoom: 6 },
];

declare global {
  interface Window {
    __app?: {
      map: maplibregl.Map;
      perf: PerfStats;
      ready: boolean;
      placesReady: boolean;
      search: (q: string) => Place[] | null;
      samples: typeof SAMPLES;
      tracks: TracksPanel | null;
      routePlanner: RoutePlanner | null;
    };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const parseZxy = (url: string) => {
  const m = /^[a-z]+:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!m) throw new Error(`bad tile url ${url}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
};

/** Touch devices tend to have many cores but weaker per-core performance and tighter memory, so
 *  they get a small fixed worker count; other devices scale with `hardwareConcurrency` (leaving
 *  one core for the main thread, capped so we don't over-subscribe). */
function tileWorkerCount(): number {
  if (navigator.maxTouchPoints > 0) return 2;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
}

export interface ViewerOptions {
  /** Loads the newest version of the app from the server (the Android app's menu item). */
  reloadFromServer(): Promise<'offline' | 'reloading'>;
}

export async function startViewer(stored: Stored, opts: ViewerOptions): Promise<void> {
  const pool = new TilePool({ file: stored.img, hgt: stored.hgt, overview: stored.overview }, tileWorkerCount());
  let meta: OpenMeta;
  try {
    meta = await pool.open();
  } catch (err) {
    pool.dispose();
    throw err;
  }
  try {
    mountViewer(stored, pool, meta, opts);
  } catch (err) {
    // e.g. no WebGL: don't leave tile workers (holding the map file) running behind the error.
    pool.dispose();
    throw err;
  }
}

function mountViewer(stored: Stored, pool: TilePool, meta: OpenMeta, opts: ViewerOptions): void {
  const debug = new URLSearchParams(location.search).has('debug');
  const perf = new PerfStats($('perf'));
  $('perf').hidden = !debug;
  let bad = 0;

  // A worker that crashed (often out of memory on a phone) rejects the tiles it was building; the
  // pool starts a new one, so try once more there (MapLibre never retries a failed tile itself).
  const again = <T>(get: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    get().catch((err) => {
      if (signal.aborted || (err as Error)?.name === 'AbortError') throw err;
      return get();
    });
  maplibregl.addProtocol('garmin', async (params, abortController) => {
    const r = await again(() => pool.tile(...parseZxy(params.url), abortController.signal), abortController.signal);
    perf.record(r.ms, r.badSections, r.features);
    if (r.badSections) {
      bad += r.badSections;
      $('badge').hidden = false;
      $('badge').textContent = `⚠ ${bad} map section${bad === 1 ? '' : 's'} could not be decoded`;
    }
    return { data: r.data };
  });
  if (meta.demBounds) {
    maplibregl.addProtocol('dem', async (params, abortController) => {
      const r = await again(() => pool.dem(...parseZxy(params.url), abortController.signal), abortController.signal);
      if (r.bitmap) return { data: r.bitmap };
      if (r.rgba) return { data: await createImageBitmap(new ImageData(new Uint8ClampedArray(r.rgba), 256, 256)) };
      throw new Error(`empty DEM tile ${params.url}`);
    });
  }

  let typ: Typ;
  try {
    typ = meta.typ ? parseTyp(meta.typ) : emptyTyp();
  } catch (err) {
    console.warn('failed to parse TYP style file, falling back to default styling', err);
    typ = emptyTyp();
  }
  const glyphs = new URL('fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  const { style, images } = buildStyle(typ, {
    tiles: 'garmin://{z}/{x}/{y}',
    glyphs,
    ...(meta.demBounds ? { dem: 'dem://{z}/{x}/{y}', demBounds: meta.demBounds } : {}),
  });
  const [w, s, e, n] = meta.bounds;
  // Where the app was last time (iOS may close it in the background or when memory runs short).
  const session = loadSession(stored.meta.imgName);
  const view = session ? { center: session.view.center, zoom: session.view.zoom, bearing: session.view.bearing } : { bounds: [[w, s], [e, n]] as [[number, number], [number, number]] };
  const map = new maplibregl.Map({ container: 'map', style, ...view, maxZoom: 18, attributionControl: false });
  // Register every icon/pattern before any tile is fetched (see src/ui/images.ts); the
  // styleimagemissing handler stays as a defensive fallback.
  preloadImages(map, images);
  map.on('styleimagemissing', (ev) => {
    const img = images.get(ev.id);
    if (img && !map.hasImage(ev.id)) map.addImage(ev.id, img);
  });
  map.on('error', (ev) => console.error(ev.error));
  // Phones pinch to zoom, so they get only the compass; the locate button sits bottom-right,
  // within thumb reach.
  const touch = matchMedia('(pointer: coarse)').matches;
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: !touch }), 'top-right');
  // Locate button (bottom-right): follow with north up / heading up, direction cone, ground height.
  const height = new HeightControl();
  const locate = new LocationControl((lon, lat) => pool.elevation(lon, lat), height.element);
  map.addControl(locate, 'bottom-right');
  // Keep the screen on while location is on (a ⋯ menu switch, remembered on this device).
  const awake = browserScreenAwake();
  let keepAwake = readSetting('keepAwake', true);
  let locating = false;
  const keepAwakeItem = $<HTMLButtonElement>('keep-awake');
  const syncAwake = () => {
    keepAwakeItem.setAttribute('aria-checked', String(keepAwake));
    awake.setWanted(keepAwake && locating);
  };
  keepAwakeItem.hidden = !awake.supported;
  // Navigation: off the route it plans again by itself; this switch makes it ask first on F-roads and
  // tracks (leaving the route there may be on purpose).
  let askInHighlands = readSetting('askRerouteHighlands', false);
  const askItem = $<HTMLButtonElement>('ask-highlands');
  askItem.setAttribute('aria-checked', String(askInHighlands));
  askItem.onclick = () => {
    askInHighlands = !askInHighlands;
    writeSetting('askRerouteHighlands', askInHighlands);
    askItem.setAttribute('aria-checked', String(askInHighlands));
  };
  keepAwakeItem.onclick = () => {
    keepAwake = !keepAwake;
    writeSetting('keepAwake', keepAwake);
    syncAwake();
  };
  /** Saving a pin where you are (made once the map has loaded, with the saved items). */
  let saveHere: SaveHere | null = null;
  /** Adding a photo where you are (its button left of save-a-pin). */
  let photoHere: PhotoHere | null = null;
  /** The map's named places once the place index is loaded (for naming a pin where you are). */
  let places: Place[] = [];
  locate.onActiveChange = (active) => {
    locating = active;
    syncAwake();
    saveHere?.setAvailable(active);
    photoHere?.setAvailable(active);
  };
  syncAwake();
  // Location as it was last time: after the line above, so keeping the screen on hears of it.
  if (session) locate.restore(session.location);
  // Corner controls stack upwards in the order added: the height pill sits above the scale bar, and
  // a map whose licence asks for credit has it (folded into an ⓘ button) below both.
  const credit = conventionsFor(meta.description).credit;
  if (credit) {
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: credit }), 'bottom-left');
    // MapLibre opens it until the first drag, over the scale and height; start folded instead.
    map.once('load', () => map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  }
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(height, 'bottom-left');
  // The last GPS fix is the reference for search-result distances (the map centre when none is recent).
  const searchFrom = (): { at: [number, number]; gps: boolean } => {
    const fix = locate.lastFix;
    if (fix && Date.now() - fix.time < 10 * 60_000) return { at: fix.at, gps: true };
    const c = map.getCenter();
    return { at: [c.lng, c.lat], gps: false };
  };

  // Which map file is loaded (the GPSmap.is package has several variants that look different).
  $('map-file').textContent = stored.meta.imgName.replace(/\.img$/i, '');
  $('map-dem').textContent = stored.hgt.length ? `${stored.hgt.length} elevation file${stored.hgt.length === 1 ? '' : 's'}` : 'No elevation files';
  $('app-version').textContent = (DEV ? 'Development version · ' : '') + versionLabel();
  $('topbar').hidden = false;
  collapsibleSearch(map);
  $('menu-button').hidden = false;
  // Opening the menu puts every other panel and card away (each registers how, below).
  const dialogs = new Dialogs();
  const setMenu = (open: boolean) => {
    if (open) dialogs.closeAll();
    $('menu').hidden = !open;
    $('menu-button').setAttribute('aria-expanded', String(open));
  };
  // Keyboard and screen readers: opening the menu moves focus into it; Escape closes it.
  $('menu-button').onclick = () => {
    const open = $('menu').hidden !== false;
    setMenu(open);
    if (open) $('menu').querySelector<HTMLButtonElement>('button:not([hidden])')?.focus();
  };
  $('menu').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    setMenu(false);
    $('menu-button').focus();
  });
  // The panels opened from the menu: focus their heading; Escape or × closes them and focus goes
  // back to the menu button.
  for (const [panel, close] of [['tracks', 'tracks-close'], ['saved', 'saved-close'], ['photos', 'photos-close'], ['sync-panel', 'sync-close'], ['diag-panel', 'diag-close'], ['settings', 'settings-close']]) {
    $(panel).addEventListener('keydown', (e) => e.key === 'Escape' && $(close).click());
    $(close).addEventListener('click', () => $('menu-button').focus());
  }
  const focusPanel = (panel: string) => $(panel).querySelector<HTMLElement>('h2')?.focus();
  // Settings (the map, the switches, diagnostics, the version): a panel of its own, so the menu
  // keeps to places to go.
  $('settings-open').onclick = () => {
    setMenu(false);
    $('settings').hidden = false;
    focusPanel('settings');
  };
  $('settings-close').onclick = () => ($('settings').hidden = true);
  dialogs.add('settings', () => ($('settings').hidden = true));
  // In the Android app (which has no address bar to reload from): load the newest version.
  const reloadButton = $<HTMLButtonElement>('reload-app');
  reloadButton.hidden = androidApp() === null;
  reloadButton.onclick = async () => {
    reloadButton.disabled = true;
    reloadButton.textContent = 'Loading the newest version…';
    if ((await opts.reloadFromServer()) === 'reloading') return;
    reloadButton.textContent = 'Offline: connect to reload';
    setTimeout(() => {
      reloadButton.textContent = 'Reload from the server';
      reloadButton.disabled = false;
    }, 3000);
  };
  // Moving the map by hand closes the menu; the app's own moves (following you, turning heading up)
  // don't.
  map.on('movestart', (e) => {
    if ((e as { originalEvent?: Event }).originalEvent) setMenu(false);
  });
  let closed = false;
  $('replace').onclick = () => {
    // Nothing is deleted here: the stored map stays until a new import commits (and Cancel
    // reloads straight back into it). Stop the workers and the map to free memory for the import.
    closed = true;
    setMenu(false);
    $('settings').hidden = true;
    pool.dispose();
    map.remove();
    for (const id of ['topbar', 'menu-button', 'badge', 'perf']) $(id).hidden = true;
    showImport('', { hasMap: true, canCancel: true });
  };

  const app = { map, perf, ready: false, placesReady: false, search: (_q: string): Place[] | null => null, samples: SAMPLES, tracks: null as TracksPanel | null, trackCard: null as TrackCard | null, trip: null as TripRecorder | null, lastIntent: null as string | null, routePlanner: null as RoutePlanner | null, saved: null as SavedPanel | null, photos: null as Photos | null, weather: null as Weather | null, sync: null as DriveSync | null, navigator: null as Navigator | null, screenAwake: awake };
  window.__app = app;
  // F-road/track classes from the place-index pass, keyed by tile id and NET offset. Resolved
  // once `loadPlaces` finishes; a route requested before then awaits this instead. Rejected if
  // `loadPlaces` fails, so a route requested with no road index shows a message instead of
  // "Preparing roads…" forever.
  let resolveRoads: (roads: RoadClasses) => void;
  let rejectRoads: (err: Error) => void;
  const roadsReady = new Promise<RoadClasses>((res, rej) => {
    resolveRoads = res;
    rejectRoads = rej;
  });
  roadsReady.catch(() => {}); // avoid an unhandled-rejection warning when no route is ever requested
  map.once('idle', () => (app.ready = true));
  // GPX tracks: drawn above the map once its style has loaded; ⋯ → Tracks lists and imports them.
  // The route planner is built after it so its route line draws above GPX tracks.
  // Remember the view, location mode and route card as they change, and when the app is hidden.
  let rememberTimer = 0;
  const saveNow = () => {
    clearTimeout(rememberTimer);
    if (closed) return;
    const c = map.getCenter();
    saveSession({
      map: stored.meta.imgName,
      view: { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing() },
      location: locate.current,
      route: app.routePlanner ? app.routePlanner.snapshot() : session?.route ?? null,
    });
  };
  const remember = () => {
    clearTimeout(rememberTimer);
    rememberTimer = window.setTimeout(saveNow, 500);
  };
  map.on('moveend', remember);
  locate.onStateChange = remember;
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveNow());
  window.addEventListener('pagehide', saveNow);

  map.once('load', () => {
    const tracks = new TracksPanel(map, (coords) => pool.elevations(coords), FONT_REGULAR);
    app.tracks = tracks;
    $('tracks-open').onclick = () => {
      setMenu(false);
      tracks.show(true);
      focusPanel('tracks');
    };
    const routePlanner = new RoutePlanner(
      map,
      (from, to, allow, prefer) => roadsReady.then((roads) => pool.route(from, to, allow, prefer, roads)),
      searchFrom,
      () => locate.activate(),
    );
    app.routePlanner = routePlanner;
    if (session?.route) routePlanner.restore(session.route, session.location.mode !== 'off');
    routePlanner.onChange = remember;
    locate.onSpeed = (mps) => routePlanner.moving(mps);
    // Turn-by-turn along the route shown: Start follows you heading up; every fix moves the guidance on.
    const navigator = new Navigator({
      replan: (passed, along) => (trackNav.active ? trackNav.rejoin(along) : routePlanner.replanFromHere(passed)),
      keepClear: (left) => map.setPadding({ top: 0, bottom: 0, right: 0, left }),
      askInHighlands: () => askInHighlands,
      ended: () => trackNav.ended(),
      resumed: (nav) => {
        if (nav.track) trackNav.resume();
        locate.navigate();
      },
    });
    // A fix from the last two minutes (an old one would start guidance from the wrong place).
    const fresh = () => { const f = locate.lastFix; return f && Date.now() - f.time < 120_000 ? f : null; };
    routePlanner.onStart = () => {
      const nav = routePlanner.navRoute();
      if (!nav) return;
      trackNav.ended(); // a route now, not a track
      locate.navigate();
      navigator.start(nav, fresh());
    };
    routePlanner.onPlanned = (ok) => {
      if (!navigator.active || trackNav.active) return;
      const nav = ok ? routePlanner.navRoute() : null;
      if (nav) navigator.start(nav, fresh());
      else navigator.couldNotReplan();
    };
    routePlanner.onCleared = () => {
      if (!trackNav.active) navigator.end();
    };
    // Navigating a track: to its nearest point ahead, then along it (./trackNav.ts); a track's card
    // (a tap on it in the Tracks panel) starts it.
    const trackNav = new TrackNav({
      map,
      navigator,
      fix: fresh,
      follow: () => locate.navigate(),
      plan: (from, to) => roadsReady.then((roads) => pool.route(from, to, readSetting('allowFRoads', true), readSetting('preferFRoads', false), roads)),
      match: (coords, times) => roadsReady.then((roads) => pool.matchTrack(coords, times, roads)),
    });
    const trackCard = new TrackCard(trackNav, fresh);
    tracks.onOpen = (t) => trackCard.open(t);
    tracks.onRenamed = (t) => trackCard.renamed(t);
    app.trackCard = trackCard;
    dialogs.add('tracks', () => tracks.show(false));
    dialogs.add('track-card', () => trackCard.close());
    let trip: TripRecorder | null = null;
    locate.onFix = (at, accuracy) => {
      navigator.fix(at, accuracy);
      trip?.fix(at);
    };
    app.navigator = navigator;
    app.screenAwake = awake;
    // Saved pins (stars on the map) and routes, from the route card's Save.
    const saved = new SavedPanel(
      map,
      FONT_REGULAR,
      (p) => {
        routePlanner.pick({ name: p.name, lon: p.lon, lat: p.lat, saved: true });
        map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 12), duration: 600 });
      },
      () => tracks.reload(),
      () => tracks.all,
    );
    app.saved = saved;
    // Google Drive sync of the saved items and tracks (offered when the app has a Google client ID).
    const sync = new DriveSync(async () => {
      await saved.reload();
      await tracks.reload();
    });
    saved.onChanged = tracks.onChanged = () => sync.changed();
    app.sync = sync;
    const nearCache = new Map<string, string | null>();
    // Photos (⋯ → Photos): thumbnails where they were taken; synced with the rest when that's on.
    const photos = new Photos({
      map,
      near: (lon, lat) => {
        // A scan of every named place: once per spot.
        if (!places.length) return null;
        const k = `${lon},${lat}`;
        if (!nearCache.has(k)) nearCache.set(k, nearName(places, [lon, lat]) ?? null);
        return nearCache.get(k)!;
      },
      routeTo: (p) => routePlanner.pick({ name: `Photo, ${takenText(p.taken, true)}`, lon: p.lon, lat: p.lat }),
      here: () => {
        if (!locating) return null;
        const f = fresh();
        return f ? { lon: f.at[0], lat: f.at[1], alt: null } : null;
      },
      changed: () => sync.changed(),
    });
    photos.onList = () => sync.photosChanged();
    sync.photos = photos;
    app.photos = photos;
    $('photos-open').onclick = () => {
      setMenu(false);
      photos.show(true);
      focusPanel('photos');
    };
    dialogs.add('photos', () => photos.show(false));
    // Weather (⋯ → Weather): a bar of its own that stays while other panels come and go; its card
    // goes away with them.
    const weather = new Weather({
      map,
      near: (lon, lat) => (places.length ? nearName(places, [lon, lat]) ?? null : null),
      tapTaken: () => routePlanner.choosingStart,
      tappable: ['saved-pins', 'route-via'],
      beneath: 'ln-other',
    });
    app.weather = weather;
    $('weather-open').onclick = () => {
      setMenu(false);
      weather.show(true);
    };
    dialogs.add('weather-card', () => weather.closeCard());
    dialogs.add('photo-viewer', () => photos.viewer.close());
    routePlanner.onSave = (item) => saved.add(item);
    routePlanner.onSaveTrack = async (t) => {
      await tracks.addTrack(t);
    };
    // A pin where you are: the button left of the locate button (added after it, so placed first), and
    // the ☆ while navigating. Named after the map feature there when it's on screen, else the
    // nearest named place.
    saveHere = new SaveHere({
      fix: fresh,
      height: (lon, lat) => pool.elevation(lon, lat),
      suggest: (at) => {
        const p = map.project(at);
        const { clientWidth: w, clientHeight: h } = map.getCanvas();
        const onMap = p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h ? featureNameAt(map, p) : undefined;
        return onMap ?? nearName(places, at);
      },
      save: (pin) => saved.add(pin),
      remove: (id) => saved.delete(id),
    });
    map.addControl(saveHere, 'bottom-right');
    saveHere.setAvailable(locating);
    // Adding photos from the map: left of save-a-pin. The picker offers Take Photo too.
    photoHere = new PhotoHere(() => photos.pick());
    map.addControl(photoHere, 'bottom-right');
    photoHere.setAvailable(locating);
    // Recording a trip, in the Android app only (it records in the background): its button goes
    // left of save-a-pin. A trip the app hands over comes in once the stored tracks are read.
    const android = androidApp();
    if (android) {
      trip = new TripRecorder({
        app: android,
        open: (href) => {
          app.lastIntent = href;
          location.href = href;
        },
        tracks: {
          has: (id) => tracks.has(id),
          add: (t) => tracks.addTrack(t),
          rename: (t, name) => tracks.rename(t, name),
          remove: (id) => tracks.deleteById(id),
          show: (t) => tracks.zoomTo(t),
        },
      });
      map.addControl(trip, 'bottom-right');
      app.trip = trip;
      void tracks.loaded.then(() => trip?.receiveStartup());
    }
    $('sync-open').onclick = () => {
      setMenu(false);
      $('sync-panel').hidden = false;
      focusPanel('sync-panel');
    };
    $('sync-close').onclick = () => ($('sync-panel').hidden = true);
    // What the app sees on this device (location above all), for a head unit without a console.
    const diagnostics = new DiagnosticsPanel($('diag-panel'), () => locate.lastFix);
    $('diag-open').onclick = () => {
      setMenu(false);
      $('settings').hidden = true;
      diagnostics.show(true);
      focusPanel('diag-panel');
    };
    $('diag-close').onclick = () => diagnostics.show(false);
    dialogs.add('saved', () => saved.show(false));
    dialogs.add('sync', () => ($('sync-panel').hidden = true));
    dialogs.add('diagnostics', () => diagnostics.show(false));
    dialogs.add('route', () => routePlanner.putAway());
    if (saveHere) {
      const here = saveHere;
      dialogs.add('save-here', () => here.close());
    }
    $('saved-open').onclick = () => {
      setMenu(false);
      saved.show(true);
      focusPanel('saved');
    };
  });

  void loadPlaces(stored, pool)
    .then(({ index, roads }) => {
      if (closed) return;
      resolveRoads(roads);
      places = index.places;
      app.search = (q) => index.search(q);
      app.placesReady = true;
      wireSearch(map, index, searchFrom, (d) => app.routePlanner?.pick(d), () => app.routePlanner?.clearPlace(), dialogs);
      const input = $<HTMLInputElement>('search');
      input.placeholder = 'Search places';
      input.disabled = false;
    })
    .catch((err) => {
      if (closed) return; // "Load another map" disposed the pool mid-build
      console.error('search index', err);
      $<HTMLInputElement>('search').placeholder = 'Search unavailable';
      rejectRoads(new Error("Routing is unavailable: the map index couldn't be built."));
    });
}

async function loadPlaces(stored: Stored, pool: TilePool): Promise<{ index: PlaceIndex; roads: RoadClasses }> {
  const key = cacheKey(stored.meta);
  const cached = await readText('places.json').catch(() => null);
  if (cached) {
    const decoded = decodePlacesCache(cached, key);
    if (decoded) return { index: new PlaceIndex(decoded.places), roads: decoded.roads };
  }
  const { places, roads } = await pool.places();
  // A failed cache write only costs a rebuild next launch; search still works now.
  await writeText('places.json', encodePlacesCache(key, places, roads)).catch((err) => console.warn('places cache', err));
  return { index: new PlaceIndex(places), roads };
}

function wireSearch(
  map: maplibregl.Map,
  index: PlaceIndex,
  searchFrom: () => { at: [number, number]; gps: boolean },
  onPick: (dest: { name: string | null; lon: number; lat: number }) => void,
  onClear: () => void,
  dialogs: Dialogs,
): void {
  const towns = townsOf(index.places);
  const input = $<HTMLInputElement>('search');
  const list = $<HTMLUListElement>('results');
  let timer = 0;
  // A search box with a list of suggestions: Arrow keys move through the results, Enter picks one
  // (the first when none is chosen), Escape clears.
  let active = -1;
  const options = () => [...list.querySelectorAll<HTMLLIElement>('li')];
  /** Selects result `i` (wrapping past either end), or none when `i` is -1. */
  const setActive = (i: number) => {
    const all = options();
    active = i === -1 || !all.length ? -1 : (i + all.length) % all.length;
    all.forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', all[active].id);
      all[active].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const showList = () => {
    input.setAttribute('aria-expanded', String(list.children.length > 0));
    setActive(-1);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      // Up from no selection goes to the last result.
      setActive(e.key === 'ArrowDown' ? active + 1 : active === -1 ? options().length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      const li = options()[active >= 0 ? active : 0];
      if (li) {
        e.preventDefault();
        li.click();
      }
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      clear.click();
    }
  });
  const render = () => {
    list.replaceChildren(
      ...collapseNearby(index.search(input.value, 100, searchFrom().at)).slice(0, 20).map((p, i) => {
        const from = searchFrom();
        const d = describePlace(p, towns, from.at);
        const li = document.createElement('li');
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = titleCase(p.name);
        const detail = document.createElement('div');
        detail.className = 'detail';
        detail.textContent = [d.category, d.where].filter(Boolean).join(' · ');
        const dist = document.createElement('span');
        dist.className = 'dist';
        dist.textContent = d.distance ?? '';
        dist.title = from.gps ? 'from your position' : 'from the map centre';
        li.append(name, detail, dist);
        li.id = `result-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.onclick = () => {
          map.flyTo({ center: [p.lon, p.lat], zoom: p.kind === 'point' ? 14 : 12 });
          onPick({ name: titleCase(p.name), lon: p.lon, lat: p.lat });
          list.replaceChildren();
          showList();
          input.blur();
        };
        return li;
      }),
    );
    showList();
  };
  const clear = $<HTMLButtonElement>('search-clear');
  // While the box is focused and empty: how to pick a place that search can't find.
  const hint = $('search-hint');
  hint.textContent = matchMedia('(pointer: coarse)').matches ? 'Press and hold on the map to pick any place' : 'Right-click the map (Ctrl+Click on a Mac) to pick any place';
  const syncHint = () => (hint.hidden = !(document.activeElement === input && input.value === ''));
  input.addEventListener('focus', syncHint);
  input.addEventListener('blur', syncHint);
  syncHint();
  input.addEventListener('input', () => {
    syncHint();
    clear.hidden = input.value === '';
    clearTimeout(timer);
    timer = window.setTimeout(render, 120);
  });
  // Clear the query, results and result pin.
  const reset = () => {
    clearTimeout(timer);
    input.value = '';
    clear.hidden = true;
    list.replaceChildren();
    showList();
    onClear();
  };
  // The ×: keep the keyboard up for a new search.
  clear.addEventListener('pointerdown', (ev) => ev.preventDefault()); // don't steal focus from the input
  clear.onclick = () => {
    reset();
    input.focus();
    syncHint();
  };
  // Put away for the menu: the search box folds back to its magnifier.
  dialogs.add('search', () => {
    if (input.value) reset();
    input.blur();
  });
}

/** The search bar is a magnifier until tapped; it collapses again when left empty (focus moves
 *  elsewhere, or the map is touched, which on iOS doesn't take focus from the input by itself). */
function collapsibleSearch(map: maplibregl.Map): void {
  const bar = $('topbar');
  const input = $<HTMLInputElement>('search');
  const collapse = () => {
    if (input.value === '' && document.activeElement !== input) bar.classList.add('collapsed');
  };
  $('search-open').onclick = () => {
    bar.classList.remove('collapsed');
    input.focus(); // in the tap itself, so iOS shows the keyboard
  };
  input.addEventListener('blur', () => setTimeout(collapse, 0));
  map.getCanvasContainer().addEventListener('pointerdown', () => {
    input.blur();
    collapse();
  });
}
