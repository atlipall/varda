/* Offline support: precache the whole app shell; cache everything else same-origin on first use.
 * Cached files are served at once; those that may change under their name are refreshed in the
 * background too (not the hashed build files and fonts, which never do).
 *
 * `npm run build` rewrites the two placeholders below (scripts/precache.ts, run by the Vite plugin
 * in vite.config.ts): CACHE becomes `garmin-app-<hash of the built files>`, PRECACHE lists every
 * built file, so each deploy installs a fresh complete copy and `activate` drops the old one, and
 * BUILD is the build's {version, builtAt}, which a page asks for to tell whether it is out of date
 * (src/app/updates.ts). The defaults keep an unbuilt copy (dev) working. */
/** Caches this app owns: `garmin-app-*`, or `garmin-appdev-*` for the development version at
 *  /app-dev/ (on the same site, so its caches must not be taken for the app's). Others on the
 *  origin (other sites on the same host, and the pre-/app/ root app's `garmin-map-*` caches,
 *  which the root sw.js retires) are left alone. */
const OWN = /\/app-dev\//.test(self.location.pathname) ? 'garmin-appdev-' : 'garmin-app-';
const CACHE = (self.__CACHE__ || 'garmin-app-dev').replace(/^garmin-app-/, OWN);
const BUILD = self.__BUILD__ || null;
const FONTS = ['Noto Sans Regular', 'Noto Sans Italic'].flatMap((f) =>
  ['0-255', '256-511', '8192-8447'].map((r) => `./fonts/${encodeURIComponent(f)}/${r}.pbf`));
const PRECACHE = [...new Set([
  ...(self.__PRECACHE__ || ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']),
  ...FONTS,
])];
/** How long a navigation waits for the network before serving the cached shell. */
const NAV_TIMEOUT_MS = 3000;

/** Remembers the app's last two caches, newest last (kept out of the clean-up below by name). */
const ORDER = `${OWN}order-v1`;

/** Files whose content never changes under their name: the build's hashed files
 *  (`assets/index-B8-mEBLf.js`) and the fonts' glyph ranges. Each deploy precaches its own anyway. */
const immutable = (url) => /\/assets\/[^/]+-[\w-]{8}\.\w+$/.test(url.pathname) || /\/fonts\/[^/]+\/\d+-\d+\.pbf$/.test(url.pathname);
const cacheable = (res) => res && res.ok && res.type === 'basic';
/** A cached response, from this version's cache first, else an older one still kept. */
const cached = (req) => caches.open(CACHE).then((c) => c.match(req)).then((hit) => hit || caches.match(req));
const put = (key, res) => caches.open(CACHE).then((c) => c.put(key, res)).catch(() => {});

self.addEventListener('install', (e) => {
  // `cache: 'reload'` bypasses the HTTP cache so a new build never precaches stale files.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

// The previous version's cache stays until the next update: a page still running the old version
// (an iPhone Home Screen app can for days) can then still load its files, such as a worker it starts
// later (importing a map, or a map worker restarted after a crash). Older ones are dropped.
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const order = await caches.open(ORDER);
    const had = await order.match('order').then((r) => (r ? r.json() : []), () => []);
    const keep = [...had.filter((k) => k !== CACHE), CACHE].slice(-2);
    await order.put('order', new Response(JSON.stringify(keep)));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(OWN) && k !== ORDER && !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// A page asks which build this is (with a port to answer on).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'build' && e.ports[0]) e.ports[0].postMessage(BUILD);
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Race the network against a timeout so a flaky connection in the field can't hang startup;
    // whichever way it goes, a good network response still refreshes the cached shell.
    let refresh = Promise.resolve();
    const net = fetch(req).then((res) => {
      if (cacheable(res)) refresh = put('./', res.clone());
      return res;
    });
    e.waitUntil(net.then(() => refresh).catch(() => {}));
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
    e.respondWith((async () => {
      const res = await Promise.race([net.catch(() => null), timeout]);
      if (res && res.ok) return res;
      const cached = await caches.open(CACHE).then((c) => c.match('./'));
      if (cached) return cached;
      return res || net; // no cached shell: wait for (or fail with) the network
    })());
    return;
  }

  e.respondWith(cached(req).then((hit) => {
    // A file that never changes under its name (a hashed build file, a font range) is served from
    // the cache alone; anything else is also fetched in the background for next time.
    if (hit && immutable(url)) return hit;
    const net = fetch(req).then((res) => {
      if (cacheable(res)) put(req, res.clone());
      return res;
    });
    if (hit) {
      net.catch(() => {}); // background refresh; offline is expected here
      return hit;
    }
    return net;
  }));
});
