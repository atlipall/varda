// Screenshots for the user guide (web/site/images/): the real app on the real map, at iPhone size
// (and one on a car head unit), in the states the guide describes. Run after a UI change:
//   npm run shots
// Needs the GPSmap.is package at the repo root, like the e2e.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DATA = REPO + 'map-files/GPSmap.is 2024.21 Android/';
const IMG = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
/** A second map (the guide's "More than one map"). */
const IMG2 = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Focused.img';
const HGT_DIR = DATA + 'HILLSHADE - Add content to DEM folder/';
const OUT = WEB + 'site/images/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5197;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await mkdir(OUT, { recursive: true });
const hgts = (await readdir(HGT_DIR)).filter((n) => n.endsWith('.hgt')).map((n) => HGT_DIR + n);
const server = await preview({ root: WEB, preview: { port: PORT, strictPort: true } });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const origin = `http://localhost:${PORT}`;
  await browser.defaultBrowserContext().overridePermissions(origin, ['geolocation']);
  const page = await browser.newPage();
  await page.setViewport(PHONE);
  const gps = await page.createCDPSession();
  const at = async (lat, lon, extra = {}) => {
    await gps.send('Emulation.setGeolocationOverride', { latitude: lat, longitude: lon, accuracy: 8, ...extra });
    await sleep(500);
  };
  /** Waits for the map to finish drawing, then saves the screen. */
  const shot = async (name) => {
    await page.evaluate(() => new Promise((r) => (window.__app?.map?.loaded() ? setTimeout(r, 300) : (window.__app?.map?.once('idle', r) ?? r()))));
    await sleep(700);
    await page.screenshot({ path: `${OUT}${name}.webp`, type: 'webp', quality: 72 });
    console.log('shot', name);
  };
  /** Presses a button in the page (no pointer: the layout may still be moving between shots). */
  const tap = (sel) => page.evaluate((q) => document.querySelector(q).click(), sel);
  const view = (center, zoom) => page.evaluate((c, z) => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: c, zoom: z, bearing: 0 }); m.once('idle', r); }), center, zoom);

  // Loading a map.
  await page.goto(`${origin}/`);
  // The first screen is the Maps panel: elevation files first (they stay), then the map (it opens).
  await page.waitForSelector('#maps-panel.standalone:not([hidden]) #maps-add');
  await shot('import');
  await (await page.$('#maps-add-elevation-input')).uploadFile(...hgts);
  await page.waitForSelector('#maps-panel .set-row', { timeout: 600_000 });
  await (await page.$('#maps-add-input')).uploadFile(IMG);
  await page.waitForNavigation({ timeout: 600_000 });
  await page.waitForFunction(() => window.__app?.ready === true && window.__app?.placesReady === true, { timeout: 600_000 });

  // The map, with hillshading: Landmannalaugar.
  await view([-19.06, 63.985], 12.3);
  await shot('map');

  // Search, and a place's card.
  await page.click('#search-open');
  await page.type('#search', 'Hekla');
  await page.waitForFunction(() => document.querySelectorAll('#results li').length > 2);
  await shot('search');
  await page.click('#results li:first-child');
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden);
  await sleep(1200);
  await shot('place');
  await page.click('#route-close');
  await page.evaluate(() => document.querySelector('#search-clear')?.click());

  // Your position: followed, with the ground height.
  await at(63.9913, -19.0605);
  await page.click('.locate-button');
  await page.waitForFunction(() => /^▲ \d+ m$/.test(document.querySelector('.height-pill')?.textContent ?? ''), { timeout: 20_000 });
  await sleep(1500);
  // Zoomed out a little (by hand, so following keeps it): the area around, with the hills.
  await page.evaluate(() => window.__app.map.zoomTo(14.2, { duration: 0 }));
  await sleep(800);
  await shot('location');

  // A route from Selfoss to Landmannalaugar, then navigating it.
  await at(63.936, -21.0, { speed: 0 });
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 120_000 });
  await sleep(1200);
  await shot('route');
  await page.click('#route-start');
  const line = await page.evaluate(() => window.__app.map.getStyle().sources.route.data.features.find((f) => f.properties.kind === 'route').geometry.coordinates);
  const p = line[Math.floor(line.length / 5)];
  for (let k = 0; k < 3; k++) await at(p[1] + k * 0.00001, p[0], { speed: 20 });
  await sleep(1500);
  await shot('navigation');
  // The same on a car's head unit (landscape): the guidance in a column on the left.
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
  for (let k = 3; k < 5; k++) await at(p[1] + k * 0.00001, p[0], { speed: 20 });
  await sleep(1500);
  await shot('head-unit');
  await page.setViewport(PHONE);
  await tap('#nav-end');
  await tap('#route-close');
  await tap('#route-confirm-yes');
  // Location off (a long press), so the next shots don't follow you.
  await page.evaluate(() => {
    const b = document.querySelector('.locate-button');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await sleep(1200);
  await page.evaluate(() => document.querySelector('.locate-button').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));

  // Tracks: a GPX file of the start of Laugavegur.
  const pts = Array.from({ length: 40 }, (_, i) => [63.9913 - i * 0.0006 - Math.sin(i / 5) * 0.0004, -19.0605 - i * 0.0009]);
  const gpx = `${WEB}e2e-output/laugavegur.gpx`;
  await writeFile(gpx, `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Laugavegur</name></metadata><wpt lat="63.9913" lon="-19.0605"><name>Landmannalaugar hut</name></wpt><trk><trkseg>${pts.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('')}</trkseg></trk></gpx>`);
  await page.click('#menu-button');
  await page.click('#tracks-open');
  await (await page.$('#gpx-file')).uploadFile(gpx);
  await page.waitForFunction(() => window.__app.tracks.count === 1);
  await sleep(1500);
  await shot('tracks');
  await tap('#tracks-close');

  // Saved places: two stars and the list.
  for (const [name, lon, lat] of [['Hekla view', -19.67, 63.99], ['Landmannalaugar hut', -19.06, 63.991]]) {
    await page.evaluate((n, x, y) => window.__app.routePlanner.pick({ name: n, lon: x, lat: y }), name, lon, lat);
    await tap('#route-save');
    await tap('#route-save-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#route-save').textContent.trim() === 'Saved');
    await tap('#route-close');
  }
  await tap('#menu-button');
  await tap('#saved-open');
  // Both stars in view below the panel.
  await page.evaluate(() => new Promise((r) => {
    const m = window.__app.map;
    m.fitBounds([[-19.67, 63.99], [-19.06, 63.991]], { padding: { top: 300, bottom: 120, left: 60, right: 60 }, maxZoom: 10.5, duration: 0 });
    m.once('idle', r);
  }));
  await shot('saved');
  await tap('#saved-close');

  // Settings (kept as menu.webp, which the guide shows), and sync.
  await tap('#menu-button');
  await tap('#settings-open');
  await shot('menu');
  await tap('#settings-close');
  await tap('#menu-button');
  await tap('#sync-open');
  await shot('sync');
  await tap('#sync-close');

  // More than one map: a second one added from ⋯ → Maps (it opens in place), then the map button's
  // picker over Landmannalaugar, and the Maps panel.
  await tap('#menu-button');
  await tap('#maps-open');
  await page.waitForSelector('#maps-panel:not([hidden]) #maps-add');
  await (await page.$('#maps-add-input')).uploadFile(IMG2);
  await page.waitForSelector('#map-note:not([hidden])', { timeout: 600_000 });
  await page.waitForFunction(() => document.querySelector('#map-note').hidden, { timeout: 15_000 }); // the note goes after 8 s
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  await view([-19.06, 63.985], 11.5);
  await tap('#maps-button');
  await page.waitForSelector('#map-picker:not([hidden]) .seg');
  await shot('maps-picker');
  await tap('#map-picker .close');
  await tap('#menu-button');
  await tap('#maps-open');
  await page.waitForSelector('#maps-panel:not([hidden]) .storage .bar');
  await shot('maps');
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
