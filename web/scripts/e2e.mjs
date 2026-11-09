import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';
import { exifOf, readSegments, xmpOf, metadataSegments, withSegments, exifSegment } from '../src/photos/jpeg.ts';
import { readExif } from '../src/photos/exif.ts';
import { descriptionOf } from '../src/photos/xmp.ts';
import { tiff } from '../test/helpers/photoBytes.ts';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DATA = REPO + 'map-files/GPSmap.is 2024.21 Android/';
const IMG = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Detailed.img';
/** A second map of the same area (several are kept). */
const IMG2 = DATA + 'MAPS - Add content to MAPFILES folder/Iceland GPSmap.is 2024.21 Focused.img';
const HGT_DIR = DATA + 'HILLSHADE - Add content to DEM folder/';
const OUT = WEB + 'e2e-output/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5198;

const fail = (msg) => {
  throw new Error(`E2E FAILED: ${msg}`);
};

await mkdir(OUT, { recursive: true });
const hgts = (await readdir(HGT_DIR)).filter((n) => n.endsWith('.hgt')).map((n) => HGT_DIR + n);
/** The built service worker, and its contents while a test stands in a newer one. */
const SW = WEB + 'dist/app/sw.js';
let swBuilt = null;
const server = await preview({ root: WEB, preview: { port: PORT, strictPort: true } });
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  // A failed click names its element (the intermittent "not clickable" errors otherwise don't).
  const rawClick = page.click.bind(page);
  page.click = async (selector, options) => {
    try {
      return await rawClick(selector, options);
    } catch (err) {
      const at = new Error().stack?.split('\n').find((l) => l.includes('e2e.mjs') && !l.includes('page.click')) ?? '';
      // Why: the nearest hidden ancestor (or none), its size, and the route card's state.
      const why = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return 'no such element';
        let hid = el;
        while (hid && getComputedStyle(hid).display !== 'none' && !hid.hidden) hid = hid.parentElement;
        const r = el.getBoundingClientRect();
        const card = document.querySelector('#route-card');
        return JSON.stringify({ hiddenAt: hid ? `${hid.tagName}#${hid.id}.${hid.className}` : null, rect: [r.x, r.y, r.width, r.height].map(Math.round), card: card && { cls: card.className, hidden: card.hidden, title: document.querySelector('#route-title')?.textContent, info: document.querySelector('#route-info')?.textContent, confirm: document.querySelector('#route-confirm')?.hidden } });
      }, selector).catch((e) => `(state unavailable: ${e.message})`);
      throw new Error(`click ${selector} (${at.trim()}): ${err.message} — ${why}`);
    }
  };
  await page.setViewport({ width: 1024, height: 1024 });
  page.on('console', (m) => ['error', 'warn'].includes(m.type()) && console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const waitReady = () => page.waitForFunction(() => window.__app?.ready === true, { timeout: 300_000 });

  // 1. first run: import screen
  await page.goto(`http://localhost:${PORT}/`);
  // A database left at a higher version by another version of the app (one with a store of its own,
  // and without one this version needs): it's used as it is, with the missing store added.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('garmin-map', 7);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('tracks', { keyPath: 'id' });
      req.result.createObjectStore('from-another-version', { keyPath: 'id' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  }));
  // The first screen is the Maps panel on its own: the elevation files first (they stay in the
  // panel), then the map, which opens.
  await page.waitForSelector('#maps-panel.standalone:not([hidden]) #maps-add', { timeout: 30_000 });
  if (await page.$('#maps-panel .close')) fail('the first screen can be closed');
  if (await page.$('#remove-stored')) fail('"Remove stored data" offered with nothing stored');
  await page.screenshot({ path: `${OUT}first-start.png` });
  const t0 = Date.now();
  await (await page.$('#maps-add-elevation-input')).uploadFile(...hgts);
  await page.waitForFunction(() => /used by|not used/.test(document.querySelector('#maps-panel .set-row')?.textContent ?? ''), { timeout: 600_000 })
    .catch(async () => fail(`elevation files not stored: ${await page.$eval('#maps-panel', (e) => e.innerText)}`));
  await (await page.$('#maps-add-input')).uploadFile(IMG);
  await page.waitForNavigation({ timeout: 600_000 });
  console.log(`import took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await waitReady();

  // 2. screenshots with hillshade
  const samples = await page.evaluate(() => window.__app.samples);
  for (const s of samples) {
    await page.evaluate((c, z) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('idle timeout')), 120_000);
      window.__app.map.jumpTo({ center: c, zoom: z });
      window.__app.map.once('idle', () => { clearTimeout(t); resolve(); });
    }), s.center, s.zoom);
    await page.screenshot({ path: `${OUT}${s.name}-hillshade.png` });
    console.log('wrote', `${OUT}${s.name}-hillshade.png`);
  }
  console.log(await page.evaluate(() => window.__app.perf.summary()));

  // 3. search
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  const hit = await page.evaluate(() => window.__app.search('landmannalaugar')[0]);
  if (!hit || Math.abs(hit.lon + 19.06) > 0.1 || Math.abs(hit.lat - 63.99) > 0.1) fail(`search landmannalaugar → ${JSON.stringify(hit)}`);
  console.log('search ok:', hit.name, hit.lon.toFixed(3), hit.lat.toFixed(3));
  // The search bar: a magnifier that expands on tap and collapses when left empty.
  const bar = () => page.evaluate(() => ({ collapsed: document.getElementById('topbar').classList.contains('collapsed'), focused: document.activeElement?.id, width: Math.round(document.getElementById('topbar').getBoundingClientRect().width) }));
  let sb = await bar();
  if (!sb.collapsed || sb.width > 50) fail(`search bar not collapsed at start: ${JSON.stringify(sb)}`);
  await page.click('#search-open');
  await new Promise((r) => setTimeout(r, 300));
  sb = await bar();
  if (sb.collapsed || sb.focused !== 'search' || sb.width < 200) fail(`search bar did not expand and focus: ${JSON.stringify(sb)}`);
  await page.keyboard.type('hekla');
  await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0);
  const mapBox = await page.$eval('#map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.75 }; });
  await page.mouse.click(mapBox.x, mapBox.y);
  if ((await bar()).collapsed) fail('search bar collapsed while it still had text');
  await page.click('#search-clear');
  await page.mouse.click(mapBox.x, mapBox.y);
  await new Promise((r) => setTimeout(r, 300));
  sb = await bar();
  if (!sb.collapsed) fail(`empty search bar did not collapse: ${JSON.stringify(sb)}`);
  console.log('search bar ok');
  // Keyboard: Arrow down + Enter picks a result (its card opens); the menu takes focus and Escape
  // closes it; a panel takes focus and Escape closes it.
  await page.click('#search-open');
  await page.keyboard.type('hekla');
  await page.waitForFunction(() => document.querySelectorAll('#results li[role="option"]').length > 0);
  // Nothing chosen yet, and the list from its top (choosing the last one scrolled to it, and on the
  // head unit slid the page past the search box).
  const fresh = await page.evaluate(() => ({ selected: document.querySelectorAll('#results li[aria-selected="true"]').length, scroll: document.querySelector('#results').scrollTop }));
  if (fresh.selected || fresh.scroll) fail(`new search results: ${JSON.stringify(fresh)}`);
  await page.keyboard.press('ArrowDown');
  const activeOption = await page.evaluate(() => document.querySelector('#search').getAttribute('aria-activedescendant'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('Enter on a search result did not open its card'));
  const kbTitle = await page.$eval('#route-title', (e) => e.textContent);
  if (activeOption !== 'result-0' || !/hekla/i.test(kbTitle)) fail(`keyboard search: ${activeOption} → ${kbTitle}`);
  await page.click('#route-close');
  await page.$eval('#search', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await page.click('#menu-button');
  if (await page.evaluate(() => document.activeElement?.closest('#menu') === null)) fail('opening the menu did not move focus into it');
  // The app's own map moves (following you heading up) leave the menu open.
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.once('moveend', r); m.easeTo({ bearing: m.getBearing() + 30, duration: 200 }); }));
  if (await page.$eval('#menu', (e) => e.hidden)) fail('the menu closed when the map turned by itself');
  await page.keyboard.press('Escape');
  if (await page.evaluate(() => !document.querySelector('#menu').hidden || document.activeElement?.id !== 'menu-button')) fail('Escape did not close the menu back to its button');
  await page.click('#menu-button');
  await page.click('#saved-open');
  if (await page.evaluate(() => document.activeElement?.id !== 'saved-title')) fail('the Saved panel did not take focus');
  await page.keyboard.press('Escape');
  if (await page.evaluate(() => !document.querySelector('#saved').hidden)) fail('Escape did not close the Saved panel');
  // Opening the menu puts the other panels and cards away: a panel closes, a place card closes.
  await page.click('#menu-button');
  await page.click('#saved-open');
  await page.click('#menu-button');
  if (await page.evaluate(() => !document.querySelector('#saved').hidden || document.querySelector('#menu').hidden)) fail('opening the menu did not close the Saved panel');
  await page.keyboard.press('Escape');
  if (await page.$eval('#topbar', (e) => e.classList.contains('collapsed'))) await page.click('#search-open');
  await page.focus('#search');
  await page.type('#search', 'Hekla');
  await page.waitForFunction(() => document.querySelectorAll('#results li[role="option"]').length > 0);
  await page.click('#results li[role="option"]');
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden);
  await page.click('#menu-button');
  if (await page.evaluate(() => !document.querySelector('#route-card').hidden)) fail('opening the menu did not close the place card');
  await page.keyboard.press('Escape');
  console.log('menu closes other dialogs ok');
  // Diagnostics says why the route card closed (for a device with no console), and that the page loaded.
  await page.click('#menu-button');
  await page.click('#settings-open');
  await page.click('#diag-open');
  await page.waitForFunction(() => /route card closed: the menu opened/.test(document.querySelector('#diag-text')?.textContent ?? '') && /page loaded/.test(document.querySelector('#diag-text').textContent), { timeout: 5_000 })
    .catch(async () => fail(`Diagnostics without why the route card closed: ${(await page.$eval('#diag-text', (e) => e.textContent)).slice(-400)}`));
  await page.click('#diag-close');
  console.log('keyboard ok:', kbTitle);

  // 3b. location: a simulated GPS fix at Landmannalaugar; follow, heading up, pause on drag, height
  await browser.defaultBrowserContext().overridePermissions(`http://localhost:${PORT}`, ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer']);
  // Headless Chrome denies the screen wake lock unless granted (Safari grants it without a prompt).
  await (await browser.target().createCDPSession()).send('Browser.grantPermissions', { origin: `http://localhost:${PORT}`, permissions: ['wakeLockScreen', 'geolocation', 'sensors'] });
  await page.setGeolocation({ latitude: 63.9913, longitude: -19.0605, accuracy: 15 });
  const locState = () => page.$eval('.locate-button', (b) => b.dataset.state);
  // Count screen wake lock requests and whether the last lock is still held.
  await page.evaluate(() => {
    const wl = navigator.wakeLock;
    const request = wl.request.bind(wl);
    window.__wake = { requests: 0, last: null };
    wl.request = async (type) => { window.__wake.requests++; try { const l = await request(type); window.__wake.last = l; return l; } catch (e) { window.__wake.error = e.name + ': ' + e.message; throw e; } };
  });
  const wake = () => page.evaluate(() => ({ requests: window.__wake.requests, held: !!window.__wake.last && !window.__wake.last.released, error: window.__wake.error }));
  await page.click('.locate-button');
  await page.waitForSelector('.you', { timeout: 10_000 });
  // Phones often deliver a second fix right after the first; it must not stall the zoom-in.
  await new Promise((r) => setTimeout(r, 150));
  await page.setGeolocation({ latitude: 63.9913, longitude: -19.0605, accuracy: 10 });
  await page.waitForFunction(() => /^▲ \d+ m$/.test(document.querySelector('.height-pill')?.textContent ?? ''), { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 1200)); // let the first-fix zoom finish
  const loc = await page.evaluate(() => {
    const c = window.__app.map.getCenter();
    return { lon: c.lng, lat: c.lat, zoom: window.__app.map.getZoom(), height: document.querySelector('.height-pill').textContent };
  });
  if (Math.abs(loc.lon + 19.0605) > 0.001 || Math.abs(loc.lat - 63.9913) > 0.001 || loc.zoom < 16) fail(`follow did not centre and zoom in on the fix: ${JSON.stringify(loc)}`);
  const metres = Number(loc.height.replace(/\D/g, ''));
  if (metres < 500 || metres > 700) fail(`Landmannalaugar ground height ${loc.height}`);
  if ((await locState()) !== 'north') fail(`after one tap: ${await locState()}`);
  let w = await wake();
  if (w.requests !== 1 || !w.held) fail(`screen wake lock not held while locating: ${JSON.stringify(w)}`);
  await page.click('#menu-button');
  await page.click('#settings-open');
  await page.click('#keep-awake'); // switch off: released
  await new Promise((r) => setTimeout(r, 200));
  w = await wake();
  if (w.held || (await page.$eval('#keep-awake', (b) => b.getAttribute('aria-checked'))) !== 'false') fail(`keep-awake off did not release: ${JSON.stringify(w)}`);
  await page.click('#keep-awake'); // back on: requested again
  await new Promise((r) => setTimeout(r, 200));
  w = await wake();
  if (w.requests !== 2 || !w.held) fail(`keep-awake on did not re-request: ${JSON.stringify(w)}`);
  await page.click('#settings-close');
  // A compass reading of 40° (alpha counts counter-clockwise): the cone shows, and heading-up turns the map.
  const compass = () => page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 320, beta: 0, gamma: 0, absolute: true })));
  await compass();
  if (await page.$eval('.you-cone', (c) => c.hidden)) fail('no direction cone after a compass reading');
  await page.click('.locate-button');
  if ((await locState()) !== 'heading') fail(`after two taps: ${await locState()}`);
  for (let i = 0; i < 8; i++) { await compass(); await new Promise((r) => setTimeout(r, 150)); }
  await new Promise((r) => setTimeout(r, 900));
  const bearing = await page.evaluate(() => window.__app.map.getBearing());
  if (Math.abs(bearing - 40) > 3) fail(`heading-up bearing ${bearing}, expected ~40`);
  const box = await page.$eval('#map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
  await page.mouse.up();
  if ((await locState()) !== 'paused') fail(`after dragging: ${await locState()}`);
  await page.evaluate(() => window.__app.map.jumpTo({ zoom: 11 })); // zoomed out while paused
  await page.click('.locate-button');
  if ((await locState()) !== 'heading') fail(`resume after pause: ${await locState()}`);
  await new Promise((r) => setTimeout(r, 900));
  const resumedZoom = await page.evaluate(() => window.__app.map.getZoom());
  // Resuming keeps the zoom you're at (heading up zoomed out stays zoomed out).
  if (Math.abs(resumedZoom - 11) > 0.1) fail(`resuming changed the zoom: z${resumedZoom}`);
  // Driving at 90 km/h heading 40°: the follow zoom eases out to 13, heading-up follows the GPS
  // course, and the position sits low on the screen (look-ahead).
  const gps = await page.createCDPSession();
  const drive = async (i, speed) => {
    await gps.send('Emulation.setGeolocationOverride', { latitude: 63.9913 + i * 0.0003, longitude: -19.0605 + i * 0.0005, accuracy: 8, speed, heading: 40 });
    await new Promise((r) => setTimeout(r, 400));
  };
  for (let i = 1; i <= 8; i++) await drive(i, 25);
  await new Promise((r) => setTimeout(r, 1500));
  const car = await page.evaluate(() => {
    const m = window.__app.map;
    const you = document.querySelector('.you').getBoundingClientRect();
    const box = m.getContainer().getBoundingClientRect();
    return { zoom: m.getZoom(), bearing: m.getBearing(), y: (you.top - box.top) / box.height };
  });
  if (Math.abs(car.zoom - 13) > 0.05) fail(`driving follow zoom ${car.zoom.toFixed(2)}, expected 13`);
  if (Math.abs(car.bearing - 40) > 3) fail(`driving heading-up bearing ${car.bearing.toFixed(1)}, expected 40`);
  if (car.y < 0.65 || car.y > 0.75) fail(`heading-up position at ${car.y.toFixed(2)} of the height, expected ~0.7`);
  // Zooming by hand turns the speed zoom off until the next tap.
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel({ deltaY: -300 });
  await new Promise((r) => setTimeout(r, 800));
  const handZoom = await page.evaluate(() => window.__app.map.getZoom());
  for (let i = 9; i <= 12; i++) await drive(i, 1);
  await new Promise((r) => setTimeout(r, 800));
  const afterWalk = await page.evaluate(() => window.__app.map.getZoom());
  if (Math.abs(afterWalk - handZoom) > 0.05) fail(`speed zoom overrode a hand zoom: ${handZoom.toFixed(2)} -> ${afterWalk.toFixed(2)}`);
  // Heading up stays on through a hand zoom, and a pinch can't turn the map (that would pause it).
  const headingNow = await page.evaluate(() => ({ state: document.querySelector('.locate-button').dataset.state, noRotate: window.__app.map.touchZoomRotate._rotationDisabled }));
  if (headingNow.state !== 'heading' || !headingNow.noRotate) fail(`heading up after a hand zoom: ${JSON.stringify(headingNow)}`);
  // Dragged away and zoomed out, a tap resumes heading up at that zoom (no zoom back in).
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 40, { steps: 6 });
  await page.mouse.up();
  await page.evaluate(() => window.__app.map.jumpTo({ zoom: 9 }));
  await page.click('.locate-button');
  await drive(13, 1);
  await new Promise((r) => setTimeout(r, 1000));
  const resumed = await page.evaluate(() => ({ state: document.querySelector('.locate-button').dataset.state, zoom: window.__app.map.getZoom() }));
  if (resumed.state !== 'heading' || Math.abs(resumed.zoom - 9) > 0.1) fail(`resume heading up keeps the zoom: ${JSON.stringify(resumed)}`);
  console.log(`driving ok: z${car.zoom.toFixed(1)}, bearing ${car.bearing.toFixed(0)}, position at ${Math.round(car.y * 100)}%`);
  await new Promise((r) => setTimeout(r, 800)); // let the resume animation finish
  await page.screenshot({ path: `${OUT}location.png` });
  console.log('location ok:', loc.height);

  // ⋯ → Diagnostics: the permission, a live location test with a fix, and the map's own first fix
  // noted; no Android log button in a browser; × stops the test.
  await page.click('#menu-button');
  await page.click('#settings-open');
  await page.click('#diag-open');
  await gps.send('Emulation.setGeolocationOverride', { latitude: 63.9913, longitude: -19.0605, accuracy: 8 });
  await page.waitForFunction(() => /fix 1: 63\.99/.test(document.querySelector('#diag-text').textContent), { timeout: 15_000 }).catch(async () => fail(`diagnostics, no fix: ${await page.$eval('#diag-text', (e) => e.textContent)}`));
  const diagText = await page.$eval('#diag-text', (e) => e.textContent);
  if (!/Location permission: granted/.test(diagText) || !/location: first fix/.test(diagText)) fail(`diagnostics: ${diagText}`);
  if (await page.$eval('#diag-android', (e) => !e.hidden)) fail('diagnostics: Android log button in a browser');
  await page.screenshot({ path: `${OUT}diagnostics.png` });
  await page.click('#diag-close');
  if (await page.$eval('#diag-panel', (e) => !e.hidden)) fail('diagnostics: × left it open');
  console.log('diagnostics ok');

  // 3c. GPX: import a track without heights (climb comes from the elevation files) and a bad file
  const pts = Array.from({ length: 30 }, (_, i) => [63.9913 - i * 0.0006, -19.0605 - i * 0.0009]);
  const gpxPath = `${OUT}laugavegur-start.gpx`;
  const badPath = `${OUT}not-a-track.gpx`;
  await writeFile(gpxPath, `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Laugavegur start</name></metadata>
    <wpt lat="63.9913" lon="-19.0605"><name>Hut</name></wpt><trk><trkseg>${pts.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('')}</trkseg></trk></gpx>`);
  await writeFile(badPath, '<kml></kml>');
  await page.click('#menu-button');
  await page.click('#settings-open');
  if (await page.evaluate(() => document.activeElement?.id !== 'settings-title')) fail('the Settings panel did not take focus');
  const mapName = await page.$eval('#map-name', (e) => e.innerText.replace(/\s+/g, ' ').trim());
  if (!mapName.includes('Iceland GPSmap.is 2024.21 Detailed') || !mapName.includes('Hillshading 3″ elevation · 48 files')) fail(`settings map name: ${mapName}`);
  const version = await page.$eval('#app-version', (e) => e.textContent);
  if (!/^Version [0-9a-f]{7} · \d{1,2} \w+ \d{4}, \d\d:\d\d$/.test(version)) fail(`settings version: ${version}`);
  console.log('version ok:', version);
  if (await page.$eval('#reload-app', (e) => !e.hidden)) fail('"Reload from the server" shown in a browser (it is for the Android app)');
  await page.keyboard.press('Escape');
  if (await page.$eval('#settings', (e) => !e.hidden)) fail('Escape did not close Settings');
  const browserSize = await page.$eval('#menu-button', (e) => Math.round(e.getBoundingClientRect().width));
  if (browserSize !== 44) fail(`menu button in a browser: ${browserSize} px, not 44`);
  await page.click('#menu-button');
  await page.click('#tracks-open');
  await (await page.$('#gpx-file')).uploadFile(gpxPath, badPath);
  await page.waitForFunction(() => document.querySelectorAll('#track-list .track').length === 1, { timeout: 10_000 });
  const err = await page.$eval('#tracks-error', (e) => e.textContent);
  if (!/not-a-track\.gpx: not a GPX file/.test(err)) fail(`bad GPX error: ${err}`);
  await page.waitForFunction(() => /↑ \d/.test(document.querySelector('#track-list .stats')?.textContent ?? ''), { timeout: 15_000 });
  const trk = await page.evaluate(() => ({
    stats: document.querySelector('#track-list .stats').textContent,
    features: window.__app.map.getStyle().sources.gpx.data.features.length,
  }));
  if (trk.features !== 2) fail(`GPX features on the map: ${trk.features}`);
  await new Promise((r) => setTimeout(r, 1000)); // fitBounds
  await page.screenshot({ path: `${OUT}tracks.png` });
  console.log('gpx ok:', trk.stats);
  // Renaming a track: the pencil turns the row into a name field; Save keeps the new name (list and
  // storage, spaces tidied); Escape leaves it as it was without closing the panel.
  const renameRow = async (list, from, to, how = 'save') => {
    const row = await page.$$eval(`${list} li`, (lis, f) => lis.findIndex((li) => li.querySelector('.name')?.textContent === f) + 1, from);
    if (!row) fail(`no row named ${from} in ${list}`);
    await page.click(`${list} li:nth-child(${row}) .track-rename`);
    const field = `${list} li:nth-child(${row}) .rename-form input`;
    const prefilled = await page.$eval(field, (e) => e.value);
    if (prefilled !== from) fail(`rename field prefilled with ${prefilled}`);
    // The name is focused and selected: typing replaces it.
    if (!(await page.$eval(field, (e) => e === document.activeElement && e.selectionStart === 0 && e.selectionEnd === e.value.length))) fail('rename field not focused with the name selected');
    await page.keyboard.type(to);
    if (how === 'escape') await page.keyboard.press('Escape');
    else await page.click(`${list} li:nth-child(${row}) .rename-form button.primary`);
  };
  const trackName0 = await page.$eval('#track-list .name', (e) => e.textContent);
  await renameRow('#track-list', trackName0, '  Laugavegur,   first part ');
  await page.waitForFunction(() => document.querySelector('#track-list .name')?.textContent === 'Laugavegur, first part', { timeout: 5_000 }).catch(() => fail('track rename not shown'));
  // Kept in storage, not only on screen.
  const stored = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('garmin-map'); r.onsuccess = () => { const q = r.result.transaction('tracks').objectStore('tracks').getAll(); q.onsuccess = () => res(q.result.map((t) => t.name)); }; }));
  if (!stored.includes('Laugavegur, first part')) fail(`renamed track in storage: ${stored}`);
  await renameRow('#track-list', 'Laugavegur, first part', 'Never kept', 'escape');
  if ((await page.$eval('#track-list .name', (e) => e.textContent)) !== 'Laugavegur, first part' || (await page.$('#tracks:not([hidden])')) === null) fail('Escape changed the name or closed the panel');
  await renameRow('#track-list', 'Laugavegur, first part', trackName0);
  await page.waitForFunction((n) => window.__app.tracks.all[0].name === n, { timeout: 5_000 }, trackName0).catch(() => fail('track renamed back'));
  console.log('track rename ok');
  await page.click('#tracks-close');

  // 3c'. Overlays: GPSmap.is 2026's three KML files and a file that isn't KML; areas under the map's
  // names, their own colours; the eye hides one; all deleted again so later steps see no overlays.
  const overlayDir = REPO + 'map-files/GPSmap.is 2026.20 Android/OVERLAYS - Add content to OVERLAY folder/';
  if (existsSync(overlayDir)) {
    const kmls = readdirSync(overlayDir).filter((f) => f.endsWith('.kml')).sort().map((f) => overlayDir + f);
    await page.click('#menu-button');
    await page.click('#overlays-open');
    if (await page.evaluate(() => document.activeElement?.id !== 'overlays-title')) fail('the Overlays panel did not take focus');
    await (await page.$('#overlay-file')).uploadFile(...kmls, gpxPath);
    await page.waitForFunction((n) => document.querySelectorAll('#overlay-list .overlay').length === n, { timeout: 15_000 }, kmls.length).catch(() => fail('overlays not listed'));
    const ov = await page.evaluate(() => {
      const m = window.__app.map;
      const ids = m.getStyle().layers.map((l) => l.id);
      const firstBaseSymbol = m.getStyle().layers.find((l) => l.type === 'symbol' && !l.id.startsWith('overlay') && !l.id.startsWith('gpx')).id;
      return {
        rows: [...document.querySelectorAll('#overlay-list .overlay')].map((li) => `${li.querySelector('.name').textContent}: ${li.querySelector('.stats').textContent}`),
        error: document.querySelector('#overlays-error').textContent,
        features: m.getStyle().sources.overlays.data.features.length,
        fillUnderNames: ids.indexOf('overlay-fill') < ids.indexOf(firstBaseSymbol),
        pointsUnderTracks: ids.indexOf('overlay-point') < ids.indexOf('gpx-casing'),
      };
    });
    console.log('overlays:', ov.rows.join('; '));
    if (!ov.rows.includes('GPSmap.is-Listaverk-2026-02: 195 places') || !ov.rows.includes('GPSmap.is-Droneban-2026-01: 139 areas')) fail(`overlay rows: ${ov.rows}`);
    if (!/laugavegur-start\.gpx: Pick a KML or KMZ file/.test(ov.error)) fail(`bad overlay error: ${ov.error}`);
    if (ov.features < 195 + 139 + 23) fail(`overlay features on the map: ${ov.features}`);
    if (!ov.fillUnderNames || !ov.pointsUnderTracks) fail(`overlay layer order: ${JSON.stringify(ov)}`);
    await page.click('#overlays-close');
    await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-21.935, 64.144], zoom: 14.5 }); m.once('idle', r); }));
    await page.screenshot({ path: `${OUT}overlays-reykjavik.png` });
    await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-21.2, 64.1], zoom: 8 }); m.once('idle', r); }));
    await page.screenshot({ path: `${OUT}overlays-drones.png` });
    await page.click('#menu-button');
    await page.click('#overlays-open');
    await page.screenshot({ path: `${OUT}overlays-panel.png` });
    // The eye hides an overlay's shapes and remembers it.
    await page.click('#overlay-list .overlay:nth-child(1) .track-eye');
    await page.waitForFunction((n) => window.__app.map.getStyle().sources.overlays.data.features.length < n, { timeout: 5_000 }, ov.features).catch(() => {});
    const hidden = await page.evaluate(() => ({ features: window.__app.map.getStyle().sources.overlays.data.features.length, visible: window.__app.overlays.all.map((o) => o.visible) }));
    if (hidden.features >= ov.features || hidden.visible[0] !== false) fail(`hiding an overlay: ${JSON.stringify(hidden)}`);
    for (let i = 0; i < kmls.length; i++) {
      await page.click('#overlay-list .overlay:nth-child(1) .track-delete');
      await page.click('#overlay-list .overlay:nth-child(1) .track-delete');
      await page.waitForFunction((n) => document.querySelectorAll('#overlay-list .overlay').length === n, { timeout: 5_000 }, kmls.length - i - 1).catch(() => fail('overlay not deleted'));
    }
    const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('garmin-map'); r.onsuccess = () => { const tx = r.result.transaction(['overlays', 'overlayData']); const a = tx.objectStore('overlays').count(); const b = tx.objectStore('overlayData').count(); tx.oncomplete = () => res(a.result + b.result); }; }));
    if (left !== 0 || (await page.$eval('#overlays-empty', (e) => e.hidden))) fail(`after deleting overlays: ${left} stored`);
    await page.click('#overlays-close');
    console.log('overlays ok');
  } else console.log('overlays skipped: no GPSmap.is 2026 folder');

  // 3d. Routing: right-click drops a pin, a tap closes it; Ctrl+Click keeps it; Route here → panel
  // numbers; the switch; an off-road destination; a start chosen on the map; ×
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.06, 63.99], zoom: 12 }); m.once('idle', r); }));
  await gps.send('Emulation.setGeolocationOverride', { latitude: 63.936, longitude: -21.0, accuracy: 10 }); // Selfoss
  // The empty search box says how to pick any place.
  const hint = await page.evaluate(() => {
    document.querySelector('#topbar').classList.remove('collapsed');
    const input = document.querySelector('#search');
    input.focus();
    const h = document.querySelector('#search-hint');
    const shown = { hidden: h.hidden, text: h.textContent };
    input.blur();
    return { ...shown, hiddenAfterBlur: h.hidden };
  });
  if (hint.hidden || hint.text !== 'Right-click the map (Ctrl+Click on a Mac) to pick any place' || !hint.hiddenAfterBlur) fail(`search hint: ${JSON.stringify(hint)}`);
  // Right-click (the Mac's long press) drops a pin with a "Route here" card; a plain click closes it.
  const markers = () => page.evaluate(() => document.querySelectorAll('.maplibregl-marker').length);
  const markersBefore = await markers();
  await page.mouse.click(600, 500, { button: 'right' });
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('no card after right-click'));
  const dropped = await page.evaluate(() => ({ title: document.querySelector('#route-title').textContent, go: document.querySelector('#route-go').hidden ? '' : document.querySelector('#route-go').textContent, from: document.querySelector('#route-from-text').textContent }));
  if (!/^Dropped pin · (6\d\.\d{4}, -1\d\.\d{4}|\D.*)$/.test(dropped.title) || dropped.go !== 'Route here' || dropped.from !== 'Your position') fail(`dropped pin card: ${JSON.stringify(dropped)}`);
  await page.mouse.click(400, 400);
  await page.waitForFunction(() => document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('a map tap did not close the dropped-pin card'));
  if ((await markers()) !== markersBefore) fail('a map tap did not remove the dropped pin');
  // Ctrl+Click (a Mac trackpad's right-click: contextmenu, then click) drops a pin that stays.
  await page.keyboard.down('Control');
  await page.mouse.click(600, 500);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => !document.querySelector('#route-card').hidden, { timeout: 5_000 }).catch(() => fail('no card after Ctrl+Click'));
  await new Promise((r) => setTimeout(r, 500));
  if (await page.$eval('#route-card', (e) => e.hidden)) fail('the click of a Ctrl+Click closed its own card');
  if ((await markers()) !== markersBefore + 1) fail('Ctrl+Click: the dropped pin is gone');
  await page.click('#route-close');
  // A pin dropped on a named feature is called after it: a peak (a named point), a lake (the area
  // it's in); the name is also what Save suggests.
  const dropOn = async (lonLat, zoom) => {
    const xy = await page.evaluate((c, z) => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: c, zoom: z }); m.once('idle', () => { const p = m.project(c); const b = m.getCanvas().getBoundingClientRect(); r([b.left + p.x, b.top + p.y]); }); }), lonLat, zoom);
    await page.mouse.click(xy[0], xy[1], { button: 'right' });
    const title = await page.$eval('#route-title', (e) => e.textContent);
    await page.click('#route-save');
    const suggested = await page.$eval('#route-save-name', (e) => e.value);
    await page.click('#route-save-cancel');
    await page.click('#route-close');
    return { title, suggested };
  };
  const peak = await dropOn([-19.6694, 63.9922], 12);
  if (peak.title !== 'Dropped pin · Hekla 1491m' || peak.suggested !== 'Hekla 1491m') fail(`pin on Hekla: ${JSON.stringify(peak)}`);
  const lake = await dropOn([-18.93, 64.25], 11);
  if (!/^Dropped pin · \D/.test(lake.title) || lake.suggested !== lake.title.replace('Dropped pin · ', '')) fail(`pin in a lake: ${JSON.stringify(lake)}`);
  console.log('pin names ok:', peak.title, '|', lake.title);
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  const withF = await page.$eval('#route-info', (e) => e.textContent);
  if (!/^1[2-5]\d km · [23] h/.test(withF)) fail(`Selfoss → Landmannalaugar: ${withF}`);
  const routeKinds = () => page.evaluate(() => window.__app.map.getStyle().sources.route.data.features.map((f) => `${f.properties.kind}:${f.geometry.type}`));
  const kinds = await routeKinds();
  if (!kinds.includes('route:LineString') || !kinds.includes('start:Point') || kinds.some((k) => !/^(route:LineString|start:Point|offroad:LineString)$/.test(k))) fail(`route features: ${kinds}`);
  await new Promise((r) => setTimeout(r, 1500)); // fitBounds
  await page.screenshot({ path: `${OUT}route.png` });
  console.log('wrote', `${OUT}route.png`);
  // On a phone the card spans the width and sits above the height pill, scale and locate button.
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 1500));
  const phone = await page.evaluate(() => {
    const card = document.querySelector('#route-card').getBoundingClientRect();
    const tops = [...document.querySelectorAll('.maplibregl-ctrl-bottom-left > *, .maplibregl-ctrl-bottom-right > *')].filter((e) => !e.hidden && e.offsetHeight).map((e) => e.getBoundingClientRect().top);
    return { left: card.left, right: card.right, bottom: card.bottom, controlsTop: Math.min(...tops) };
  });
  await page.screenshot({ path: `${OUT}route-phone.png` });
  if (phone.bottom > phone.controlsTop - 4 || phone.left > 12 || phone.right < 378) fail(`route card on a phone: ${JSON.stringify(phone)}`);
  await page.setViewport({ width: 1024, height: 1024 });
  // Once a route is shown, a map tap leaves it (only × clears it).
  await page.mouse.click(400, 400);
  await new Promise((r) => setTimeout(r, 500));
  if (await page.$eval('#route-card', (e) => e.hidden)) fail('a map tap cleared the shown route');
  // Moving (GPS speed above walking pace) minimizes the card to one line; opened again by hand it
  // stays open; the chevron minimizes and opens it too.
  const openOptions = async () => {
    if (await page.$eval('#route-options', (e) => e.hidden)) await page.click('#route-options-toggle');
  };
  const isMin = () => page.$eval('#route-card', (e) => e.classList.contains('min'));
  const fixAt = (dLat, speed) => gps.send('Emulation.setGeolocationOverride', { latitude: 63.936 + dLat, longitude: -21.0, accuracy: 10, speed });
  await fixAt(0.0002, 10);
  await page.waitForFunction(() => document.querySelector('#route-card').classList.contains('min'), { timeout: 5_000 }).catch(() => fail('moving did not minimize the route card'));
  // Minimized: the dark glance panel with the arrival time, drive time and distance.
  const minCard = await page.evaluate(() => {
    const card = document.querySelector('#route-card');
    const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; };
    return {
      h: Math.round(card.getBoundingClientRect().height),
      text: `${document.querySelector('#route-title').textContent} | ${document.querySelector('#route-arrive').textContent} | ${document.querySelector('#route-time').textContent} | ${document.querySelector('#route-sub').textContent}`,
      stops: shown('#route-stops'),
    };
  });
  if (minCard.h > 220 || !/^To Landmannalaugar \| \d\d:\d\d \| \d h \d+ min \| 1\d\d km · arrive about \d\d:\d\d$/.test(minCard.text) || minCard.stops) fail(`minimized card: ${JSON.stringify(minCard)}`);
  await page.screenshot({ path: `${OUT}route-min.png` });
  await page.click('#route-title');
  if (await isMin()) fail('tapping the minimized card did not open it');
  await fixAt(0.0004, 10);
  await new Promise((r) => setTimeout(r, 500));
  if (await isMin()) fail('the card, opened by hand, was minimized again while moving');
  await page.click('#route-min');
  if (!(await isMin())) fail('the chevron did not minimize the card');
  await page.click('#route-min');
  if (await isMin()) fail('the chevron did not open the card');
  // Standing still again (the speed is smoothed over fixes), back at the start position.
  for (const d of [0.0003, 0.0001, 0.0002, 0.0001, 0]) await fixAt(d, 0);
  await new Promise((r) => setTimeout(r, 300));
  console.log('route card minimize ok:', minCard.text);

  // 3c. Turn-by-turn: Start; drive along the route (fixes from its own line); off the route asks
  // (Keep going stays quiet until back on it; Plan again carries on along a new route); arrive; End.
  const routeLine = await page.evaluate(() => window.__app.map.getStyle().sources.route.data.features.find((f) => f.properties.kind === 'route').geometry.coordinates);
  const fixOn = async (p, dLat = 0) => {
    await gps.send('Emulation.setGeolocationOverride', { latitude: p[1] + dLat, longitude: p[0], accuracy: 8, speed: 20 });
    await new Promise((r) => setTimeout(r, 250));
  };
  const navState = () => page.evaluate(() => ({
    on: document.body.classList.contains('navigating'),
    banner: document.querySelector('#nav-banner').className,
    dist: document.querySelector('#nav-dist').textContent,
    text: document.querySelector('#nav-text').textContent,
    then: document.querySelector('#nav-then').hidden ? '' : document.querySelector('#nav-then-text').textContent,
    km: document.querySelector('#nav-km').textContent,
    arrive: document.querySelector('#nav-arrive').textContent,
    asking: !document.querySelector('#nav-prompt').hidden,
    card: getComputedStyle(document.querySelector('#route-card')).display !== 'none',
    to: document.querySelector('#nav-to').textContent,
  }));
  if (await page.$eval('#route-start', (e) => e.hidden)) fail('no Start button on a shown route');
  await page.click('#route-start');
  await fixOn(routeLine[0]);
  let nav = await navState();
  if (!nav.on || nav.card || nav.to !== 'To Landmannalaugar' || !/^\d+ (m|km)$|^\d+\.\d km$/.test(nav.dist) || !nav.text || !/^\d\d:\d\d$/.test(nav.arrive)) fail(`navigation started: ${JSON.stringify(nav)}`);
  // Off the route on an ordinary road: a new route at once, no question.
  for (let k = 0; k < 3; k++) await fixOn(routeLine[2], 0.003 + k * 0.0001);
  nav = await navState();
  if (nav.asking) fail(`asked before rerouting: ${JSON.stringify(nav)}`);
  await page.waitForFunction(() => document.querySelector('#nav-banner').className === '' && document.querySelector('#nav-dist').textContent !== 'Planning…', { timeout: 60_000 }).catch(async () => fail(`no new route when off the route: ${JSON.stringify(await navState())}`));
  console.log('rerouted by itself:', (await navState()).text);
  await fixOn(routeLine[0]);
  nav = await navState();
  const kmAtStart = parseFloat(nav.km);
  await fixOn(routeLine[Math.floor(routeLine.length / 3)]);
  nav = await navState();
  if (!(parseFloat(nav.km) < kmAtStart) || nav.banner !== '') fail(`driving along: ${JSON.stringify(nav)} (started with ${kmAtStart} km left)`);
  console.log('navigating:', nav.dist, '·', nav.text, nav.then ? `· then ${nav.then}` : '', '·', nav.km);
  // ☆ while navigating saves where you are at once (the map's own button waits); Undo takes it back.
  const savedBefore = await page.evaluate(() => window.__app.saved.count);
  if (await page.$eval('#map .save-here', (e) => getComputedStyle(e).display !== 'none')) fail('the map\'s save button shows while navigating');
  await page.click('#nav-save');
  await page.waitForFunction((n) => window.__app.saved.count === n + 1, { timeout: 5_000 }, savedBefore).catch(() => fail('☆ while navigating did not save'));
  const navToast = await page.$eval('#here-toast-text', (e) => e.textContent);
  if (!/^Saved “.+”$/.test(navToast)) fail(`saved while navigating: ${navToast}`);
  console.log('saved while navigating:', navToast);
  await page.click('#here-undo');
  await page.waitForFunction((n) => window.__app.saved.count === n, { timeout: 5_000 }, savedBefore).catch(() => fail('Undo did not remove the pin'));
  const third = routeLine[Math.floor(routeLine.length / 3)];
  // (A fix after a resize: the next one centres the map, as it would a second later in a car.)
  await page.setViewport({ width: 390, height: 844 });
  await fixOn(third, 0.00001);
  await fixOn(third, 0.00002);
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${OUT}nav-phone.png` });
  // A head unit: the guidance in a column on the left, the map centred on you to its right.
  await page.setViewport({ width: 1280, height: 720 });
  await fixOn(third);
  await fixOn(third, 0.00001);
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${OUT}nav-headunit.png` });
  const youX = await page.evaluate((p) => window.__app.map.project(p).x, third);
  const column = await page.evaluate(() => Math.max(...['#nav-banner', '#nav-bottom'].map((q) => document.querySelector(q).getBoundingClientRect().right)));
  // In the middle of the map right of the column (as drawn, whatever size the cards are).
  if (Math.abs(youX - (column + 16 + 1280) / 2) > 40) fail(`head unit: your position at x=${Math.round(youX)}, not centred right of the guidance (which ends at ${Math.round(column)})`);
  // A long turn that wraps onto three lines pushes nothing under the trip panel (it did in the car).
  const stack = await page.evaluate(() => {
    document.querySelector('#nav-text').textContent = 'Turn right onto Háaleitisbraut and keep on it past the roundabout at Kringlumýrarbraut';
    return { banner: document.querySelector('#nav-banner').getBoundingClientRect().bottom, panel: document.querySelector('#nav-bottom').getBoundingClientRect().top };
  });
  if (stack.banner > stack.panel) fail(`head unit: the turn banner (to ${Math.round(stack.banner)}) covers the trip panel (from ${Math.round(stack.panel)})`);
  await page.setViewport({ width: 1024, height: 1024 });
  // Off the route in the highlands (on an F-road or track) with "Ask before rerouting in the
  // highlands" on, ~330 m north of it for three fixes: the question. Keep going: quiet until back.
  await page.evaluate(() => document.querySelector('#ask-highlands').click());
  const mid = await page.evaluate(() => {
    const { coords, segs } = window.__app.navigator.nav.route;
    const i = segs.findIndex((s) => [0x11, 0x12, 0x13].includes(s.type) || /^F\s?\d/i.test(s.name ?? ''));
    if (i < 0) return null;
    const end = i + 1 < segs.length ? segs[i + 1].start : coords.length - 1;
    return coords[Math.floor((segs[i].start + end) / 2)];
  });
  if (!mid) fail('no F-road or track on the route to Landmannalaugar');
  for (let k = 0; k < 3; k++) await fixOn(mid, 0.003);
  nav = await navState();
  if (!nav.asking || nav.banner !== 'off' || nav.dist !== 'Off route') fail(`off the route: ${JSON.stringify(nav)}`);
  await page.click('#nav-keep');
  for (let k = 0; k < 3; k++) await fixOn(mid, 0.0031 + k * 0.0001);
  if ((await navState()).asking) fail('asked again after Keep going while still off the route');
  await fixOn(mid);
  nav = await navState();
  if (nav.banner !== '' || nav.asking) fail(`back on the route: ${JSON.stringify(nav)}`);
  // Off again: Plan again carries on along a new route from here.
  for (let k = 0; k < 3; k++) await fixOn(mid, 0.003);
  await page.click('#nav-replan');
  // A fix while the new route is on its way: no question again, no "Off route" over "Planning…".
  await fixOn(mid, 0.0031);
  nav = await navState();
  if (nav.asking || nav.dist === 'Off route') fail(`off-route question back while planning again: ${JSON.stringify(nav)}`);
  await page.waitForFunction(() => document.querySelector('#nav-banner').className === '' && document.querySelector('#nav-dist').textContent !== 'Planning…', { timeout: 60_000 }).catch(async () => fail(`plan again: ${JSON.stringify(await navState())}`));
  nav = await navState();
  if (!nav.on || nav.asking) fail(`after planning again: ${JSON.stringify(nav)}`);
  console.log('replanned:', nav.text, '·', nav.km);
  // The end of the (new) route: arrived.
  const newLine = await page.evaluate(() => window.__app.map.getStyle().sources.route.data.features.find((f) => f.properties.kind === 'route').geometry.coordinates);
  await fixOn(newLine[newLine.length - 1]);
  nav = await navState();
  if (nav.banner !== 'arrived' || nav.dist !== 'Arrived') fail(`arrival: ${JSON.stringify(nav)}`);
  // Walking on past the end (to a hut off the road): still arrived, no off-route question.
  for (let k = 0; k < 4; k++) await fixOn(newLine[newLine.length - 1], 0.003 + k * 0.0002);
  nav = await navState();
  if (nav.banner !== 'arrived' || nav.asking) fail(`after arriving, off the road: ${JSON.stringify(nav)}`);
  await page.click('#nav-end');
  nav = await navState();
  if (nav.on || !nav.card) fail(`End: ${JSON.stringify(nav)}`);
  // Undo after End: the same guidance again; End again.
  if (await page.$eval('#nav-undo', (e) => e.hidden)) fail('no Undo after End');
  await page.click('#nav-undo-button');
  nav = await navState();
  if (!nav.on || (await page.$eval('#nav-undo', (e) => !e.hidden))) fail(`Undo after End: ${JSON.stringify(nav)}`);
  await page.click('#nav-end');
  // Navigating again: a dropped pin's "New route here" ends navigation and shows the new place's card.
  await page.click('#route-start');
  await page.mouse.click(600, 500, { button: 'right' });
  await page.click('#place-menu-new');
  nav = await navState();
  const newCard = await page.$eval('#route-title', (e) => e.textContent);
  if (nav.on || !nav.card || !/^Dropped pin/.test(newCard)) fail(`New route while navigating: ${JSON.stringify({ ...nav, newCard })}`);
  // Back at Selfoss, standing still, with the original route for the steps that follow. The speed is
  // smoothed over fixes: a few still ones bring it down, or a leftover driving speed would
  // minimize the next route's card (as it should while moving) under the next steps' clicks.
  for (const d of [0.0003, 0.0001, 0.0002, 0.0001, 0]) {
    await gps.send('Emulation.setGeolocationOverride', { latitude: 63.936 + d, longitude: -21.0, accuracy: 10, speed: 0 });
    await new Promise((r) => setTimeout(r, 150));
  }
  await page.click('#route-close');
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  // The search box's × leaves a route alone (it only clears a place card it opened).
  await page.evaluate(() => document.querySelector('#topbar').classList.remove('collapsed'));
  await page.type('#search', 'hek');
  await page.click('#search-clear');
  if (!(await page.evaluate(() => window.__app.map.getStyle().sources.route.data.features.length))) fail('the search box × cleared the route');
  // The button by the locate button: a card with your position and a name; the route card waits.
  await page.click('#map .save-here-button');
  const here = await page.evaluate(() => ({ card: !document.querySelector('#here-card').hidden, route: getComputedStyle(document.querySelector('#route-card')).display, name: document.querySelector('#here-name').value, sub: document.querySelector('#here-sub').textContent }));
  if (!here.card || here.route !== 'none' || !here.name || !/±\d+ m$/.test(here.sub)) fail(`save my location card: ${JSON.stringify(here)}`);
  const n0 = await page.evaluate(() => window.__app.saved.count);
  await page.$eval('#here-name', (e) => (e.value = ''));
  await page.type('#here-name', 'Selfoss spot');
  await page.click('#here-form button[type=submit]');
  await page.waitForFunction((n) => window.__app.saved.count === n + 1, { timeout: 5_000 }, n0).catch(() => fail('save my location did not save'));
  const savedHere = await page.evaluate(() => ({ card: !document.querySelector('#here-card').hidden, route: getComputedStyle(document.querySelector('#route-card')).display, toast: document.querySelector('#here-toast-text').textContent }));
  if (savedHere.card || savedHere.route === 'none' || savedHere.toast !== 'Saved “Selfoss spot”') fail(`after saving my location: ${JSON.stringify(savedHere)}`);
  await page.click('#here-undo');
  await page.waitForFunction((n) => window.__app.saved.count === n, { timeout: 5_000 }, n0).catch(() => fail('Undo did not remove the pin'));
  console.log('save my location ok:', here.name, '·', here.sub);
  console.log('turn-by-turn ok');
  await openOptions();
  await page.click('#route-froads');
  if (await page.$eval('#route-prefer-switch', (e) => !e.hidden)) fail('"Prefer F-roads" shown with F-roads not allowed');
  const noRoute = () => page.waitForFunction(() => /No route without F-roads/.test(document.querySelector('#route-msg')?.textContent ?? ''), { timeout: 30_000 });
  await noRoute();
  // No route on the map: a new place replaces the card without asking.
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Hekla', lon: -19.67, lat: 63.99 }));
  const afterFail = await page.evaluate(() => ({ confirm: !document.querySelector('#route-confirm').hidden, title: document.querySelector('#route-title').textContent }));
  if (afterFail.confirm || afterFail.title !== 'Hekla') fail(`new place after a failed route: ${JSON.stringify(afterFail)}`);
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await noRoute();
  await openOptions();
  await page.click('#route-froads'); // back on
  if (await page.$eval('#route-prefer-switch', (e) => e.hidden)) fail('"Prefer F-roads" hidden with F-roads allowed');
  // Preferring F-roads plans the route again (the time shown is still the real driving time).
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  await openOptions();
  await page.click('#route-prefer');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(() => fail('no route with F-roads preferred'));
  console.log('prefer F-roads ok:', await page.$eval('#route-info', (e) => e.textContent));
  await openOptions();
  await page.click('#route-prefer'); // off again (the setting is remembered)
  // With a route shown, a new pin opens a menu at the place (not a question in the route card):
  // Add as waypoint, Save as pin, New route here; a tap elsewhere closes it and drops the pin.
  const confirmState = () => page.evaluate(() => ({ confirm: !document.querySelector('#route-confirm').hidden, menu: [...document.querySelectorAll('.place-menu button')].map((b) => b.textContent), menuTitle: document.querySelector('#place-menu-title')?.textContent ?? null, drawn: window.__app.map.getStyle().sources.route.data.features.length, title: document.querySelector('#route-title').textContent, markers: document.querySelectorAll('.maplibregl-marker').length }));
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  const drawnBefore = (await confirmState()).drawn;
  if (!drawnBefore) fail('no route drawn before the pin-over-route check');
  const markersWithRoute = await markers();
  await page.mouse.click(600, 500, { button: 'right' });
  let cs = await confirmState();
  if (cs.confirm || cs.menu.join('|') !== 'Add as waypoint|Save as pin|New route here' || !cs.menuTitle || cs.drawn !== drawnBefore || cs.title !== 'To Landmannalaugar' || cs.markers !== markersWithRoute + 1) fail(`pin over a route: ${JSON.stringify(cs)}`);
  await page.screenshot({ path: `${OUT}place-menu.png` });
  const menuGap = await page.evaluate(() => { const [a, b] = document.querySelectorAll('.place-menu button'); return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom; });
  if (menuGap < 6) fail(`place menu buttons ${menuGap} px apart`);
  // A place from search gets the same menu, titled with its name (replacing the pin's).
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Hekla', lon: -19.67, lat: 63.99 }));
  cs = await confirmState();
  if (cs.menuTitle !== 'Hekla' || cs.markers !== markersWithRoute + 1) fail(`menu for a named place: ${JSON.stringify(cs)}`);
  // A tap elsewhere on the map closes it, and only that: the route and its card stay.
  await page.mouse.click(300, 300);
  cs = await confirmState();
  if (cs.menu.length || cs.drawn !== drawnBefore || cs.title !== 'To Landmannalaugar' || cs.markers !== markersWithRoute) fail(`tap away from the place menu: ${JSON.stringify(cs)}`);
  // Save as pin: a saved place, and the route as it was.
  const pinsBefore = await page.evaluate(() => window.__app.saved.count);
  await page.mouse.click(600, 500, { button: 'right' });
  await page.click('#place-menu-pin');
  await page.waitForFunction((n) => window.__app.saved.count === n + 1, { timeout: 5_000 }, pinsBefore).catch(() => fail('Save as pin saved nothing'));
  cs = await confirmState();
  if (cs.menu.length || cs.drawn !== drawnBefore || cs.title !== 'To Landmannalaugar' || cs.markers !== markersWithRoute) fail(`after Save as pin: ${JSON.stringify(cs)}`);
  // Taken out again, so the saved places later steps count are as before.
  await page.evaluate(() => window.__app.saved.delete(window.__app.saved.items.at(-1).id));
  // Add as waypoint: Hella, off the direct way; the route goes through it and gets longer. A tap on
  // its numbered circle removes it again.
  const direct = await page.$eval('#route-info', (e) => e.textContent);
  const km = (t) => Number(/^(\d+) km/.exec(t)?.[1]);
  // Zoomed in where the waypoint goes: the view stays there (only a new route zooms to fit).
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-20.39, 63.845], zoom: 12 }); m.once('idle', r); }));
  const viewBefore = await page.evaluate(() => { const m = window.__app.map; return [m.getCenter().lng, m.getCenter().lat, m.getZoom()]; });
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Near Hella', lon: -20.397, lat: 63.845 }));
  await page.click('#place-menu-via');
  await page.waitForFunction(() => /via 1 waypoint$/.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(async () => fail(`no route via the waypoint: ${await page.$eval('#route-msg', (e) => e.textContent)}`));
  const viaInfo = await page.$eval('#route-info', (e) => e.textContent);
  await new Promise((r) => setTimeout(r, 1000));
  const viewAfter = await page.evaluate(() => { const m = window.__app.map; return [m.getCenter().lng, m.getCenter().lat, m.getZoom()]; });
  if (viewAfter.some((v, i) => Math.abs(v - viewBefore[i]) > 1e-6)) fail(`adding a waypoint moved the map: ${viewBefore} → ${viewAfter}`);
  const nearHella = await page.evaluate(() => {
    const line = window.__app.map.getStyle().sources.route.data.features.find((f) => f.properties.kind === 'route').geometry.coordinates;
    return Math.min(...line.map(([lon, lat]) => Math.hypot((lon + 20.397) * Math.cos((63.834 * Math.PI) / 180), lat - 63.834) * 111_195));
  });
  if (!(km(viaInfo) > km(direct)) || nearHella > 2500) fail(`route via Hella: ${viaInfo} (direct ${direct}), passes ${Math.round(nearHella)} m from it`);
  // The waypoint (dropped beside the road) snapped onto the route; no dashed legs out to it.
  const snapped = await page.evaluate(() => {
    const src = window.__app.map.getStyle().sources;
    const [vlon, vlat] = src['route-vias'].data.features[0].geometry.coordinates;
    const feats = src.route.data.features;
    const line = feats.find((f) => f.properties.kind === 'route').geometry.coordinates;
    const k = Math.cos((vlat * Math.PI) / 180);
    return { onRoute: Math.min(...line.map(([lon, lat]) => Math.hypot((lon - vlon) * k, lat - vlat) * 111_195)), moved: Math.hypot((vlon + 20.397) * k, vlat - 63.845) * 111_195, offroad: feats.filter((f) => f.properties.kind === 'offroad').length };
  });
  if (snapped.onRoute > 5 || snapped.moved < 5 || snapped.offroad > 2) fail(`waypoint not snapped to the road: ${JSON.stringify(snapped)}`);
  await page.screenshot({ path: `${OUT}route-waypoint.png` });
  const viaXY = await page.evaluate(() => { const m = window.__app.map; const p = m.project(m.getStyle().sources['route-vias'].data.features[0].geometry.coordinates); const b = m.getCanvas().getBoundingClientRect(); return [b.left + p.x, b.top + p.y]; });
  await page.mouse.click(viaXY[0], viaXY[1]);
  const removeQ = await page.evaluate(() => ({ q: document.querySelector('#route-confirm-text').textContent, yes: document.querySelector('#route-confirm-yes').textContent }));
  if (removeQ.q !== 'Remove waypoint 1?' || removeQ.yes !== 'Remove') fail(`tap on a waypoint: ${JSON.stringify(removeQ)}`);
  await page.click('#route-confirm-yes');
  await page.waitForFunction((d) => document.querySelector('#route-info')?.textContent === d, { timeout: 60_000 }, direct).catch(async () => fail(`route after removing the waypoint: ${await page.$eval('#route-info', (e) => e.textContent)} (expected ${direct})`));
  if (await page.evaluate(() => window.__app.map.getStyle().sources['route-vias'].data.features.length)) fail('waypoint circle still shown after removing it');
  console.log('waypoint ok:', viaInfo, '→', direct, `(snapped ${Math.round(snapped.moved)} m onto the road)`);
  // New route here: the pin replaces the route.
  await page.mouse.click(600, 500, { button: 'right' });
  await page.click('#place-menu-new');
  cs = await confirmState();
  if (cs.confirm || cs.menu.length || cs.drawn !== 0 || !/^Dropped pin/.test(cs.title) || await page.$eval('#route-go', (e) => e.hidden)) fail(`New route: ${JSON.stringify(cs)}`);
  console.log('pin-over-route confirm ok');
  // A destination 1.5 km from the nearest road (a highland spot from a user report): a dashed
  // off-road leg and a "+ … off-road at the end" line.
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Off the road', lon: -19.31, lat: 64.18 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(async () => fail(`off-road destination: ${await page.$eval('#route-msg', (e) => e.textContent)}`));
  const off = await page.evaluate(() => ({ text: document.querySelector('#route-off').textContent, legs: window.__app.map.getStyle().sources.route.data.features.filter((f) => f.properties.kind === 'offroad').length, dashed: !!window.__app.map.getPaintProperty('route-offroad', 'line-dasharray') }));
  // (The emulated Selfoss position is ~40 m off its road too: "+ 40 m and 1.6 km … at the start and end".)
  if (!/^\+ (\d+ m and )?1\.\d km off-road at the (start and )?end$/.test(off.text) || off.legs < 1 || !off.dashed) fail(`off-road leg: ${JSON.stringify(off)}`);
  await new Promise((r) => setTimeout(r, 1000)); // fitBounds
  await page.screenshot({ path: `${OUT}route-offroad.png` });
  console.log('off-road ok:', off.text);
  // Change → Choose on the map → a map tap sets the start (a start pin, no start dot).
  await page.click('#route-change');
  const choices = await page.evaluate(() => [...document.querySelectorAll('#route-choices button')].map((b) => b.textContent));
  if (choices.join('|') !== 'Use my location|Choose on the map') fail(`start choices: ${choices}`);
  await page.click('#route-choose');
  const prompt = await page.$eval('#route-info', (e) => e.textContent);
  if (prompt !== "Tap the map where you'll start") fail(`choose-on-map prompt: ${prompt}`);
  if ((await routeKinds()).length) fail('the previous route is still drawn while choosing a start');
  await page.mouse.click(420, 360);
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? '') || document.querySelector('#route-msg')?.textContent, { timeout: 60_000 });
  const chosen = await page.evaluate(() => ({
    info: document.querySelector('#route-info').textContent,
    msg: document.querySelector('#route-msg').textContent,
    from: document.querySelector('#route-from-text').textContent,
    pins: document.querySelectorAll('.start-pin').length,
  }));
  const chosenKinds = await routeKinds();
  if (!/^\d+ km · .*min$/.test(chosen.info) || chosen.from !== 'The chosen point' || chosen.pins !== 1 || chosenKinds.includes('start:Point')) fail(`chosen start: ${JSON.stringify(chosen)} ${chosenKinds}`);
  console.log('start ok:', chosen.info);
  // With a route, × asks first: Keep route leaves everything; Clear route closes the card.
  await page.click('#route-close');
  const closeAsk = await page.evaluate(() => ({ confirm: !document.querySelector('#route-confirm').hidden, text: document.querySelector('#route-confirm-text').textContent, drawn: window.__app.map.getStyle().sources.route.data.features.length }));
  if (!closeAsk.confirm || closeAsk.text !== 'Clear the current route?' || !closeAsk.drawn) fail(`× with a route: ${JSON.stringify(closeAsk)}`);
  await page.click('#route-confirm-no');
  if (await page.$eval('#route-card', (e) => e.hidden) || !(await page.$eval('#route-confirm', (e) => e.hidden)) || !(await page.$('.start-pin'))) fail('Keep route after × did not keep the route');
  await page.click('#route-close');
  await page.click('#route-confirm-yes');
  if (await page.$eval('#route-card', (e) => !e.hidden)) fail('route card still open after ×');
  if (await page.$('.start-pin')) fail('start pin still shown after ×');
  console.log('routing ok:', withF);

  // 3e. Saving: a place (named in the card's name box) becomes a star; a route becomes a track.
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Hekla', lon: -19.67, lat: 63.99 }));
  await page.click('#route-save');
  if (await page.$eval('#route-save-name', (e) => e.value) !== 'Hekla') fail('save name not prefilled with the place name');
  // A tap on the suggested name selects all of it (not just a caret where the tap landed).
  await page.$eval('#route-save-name', (e) => e.setSelectionRange(2, 2));
  await page.click('#route-save-name');
  const sel = await page.$eval('#route-save-name', (e) => [e.selectionStart, e.selectionEnd]);
  if (sel[0] !== 0 || sel[1] !== 5) fail(`a tap on the suggested name selected ${sel}, not all of it`);
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.67, 63.99], zoom: 11 }); m.once('idle', r); }));
  await page.screenshot({ path: `${OUT}save-form.png` });
  await page.$eval('#route-save-name', (e) => { e.value = 'Hekla view'; });
  await page.click('#route-save-form button[type="submit"]');
  await page.waitForFunction(() => window.__app.saved.count === 1, { timeout: 5_000 }).catch(() => fail('pin not saved'));
  const savedPin = await page.evaluate(() => ({ button: document.querySelector('#route-save').textContent, stars: window.__app.map.getStyle().sources.saved.data.features.map((f) => f.properties.name) }));
  if (savedPin.button !== 'Saved' || savedPin.stars.join() !== 'Hekla view') fail(`saved pin: ${JSON.stringify(savedPin)}`);
  await page.click('#route-close');
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.64, 63.975], zoom: 11 }); m.once('idle', r); }));
  await page.screenshot({ path: `${OUT}saved-star.png` });
  const star = await page.evaluate(() => window.__app.map.queryRenderedFeatures({ layers: ['saved-pins'] }).map((f) => f.properties.name));
  if (star.join() !== 'Hekla view') fail(`saved star not drawn: ${star}`);
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  const savedInfo = await page.$eval('#route-info', (e) => e.textContent);
  // Export GPX (a download on a computer): a track along the route with the stops as waypoints.
  const dl = `${OUT}downloads/`;
  await rm(dl, { recursive: true, force: true });
  await (await browser.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.click('#route-export');
  let gpxText = '';
  for (let t = 0; t < 50 && !gpxText; t++) {
    await new Promise((r) => setTimeout(r, 100));
    gpxText = await readFile(`${dl}To Landmannalaugar.gpx`, 'utf8').catch(() => '');
  }
  const trkpts = (gpxText.match(/<trkpt /g) ?? []).length;
  if (trkpts < 50 || !/<wpt [^>]*><name>Landmannalaugar<\/name>/.test(gpxText) || !gpxText.includes(`<desc>${savedInfo}</desc>`)) fail(`exported GPX: ${trkpts} track points, ${gpxText.slice(0, 300)}`);
  console.log('export ok:', trkpts, 'track points');
  if (await page.$eval('#route-save span', (e) => e.textContent) !== 'Save as track') fail('a route\'s Save does not say "Save as track"');
  const tracksBeforeSave = await page.evaluate(() => window.__app.tracks.count);
  await page.click('#route-save');
  if (await page.$eval('#route-save-name', (e) => e.value) !== 'To Landmannalaugar') fail('route save name not prefilled');
  await page.click('#route-save-form button[type="submit"]');
  await page.waitForFunction((n) => window.__app.tracks.count === n + 1 && window.__app.saved.count === 1, { timeout: 5_000 }, tracksBeforeSave).catch(() => fail('route not saved as a track'));
  const savedTrack = await page.evaluate(() => {
    const t = window.__app.tracks.all.find((x) => x.name === 'To Landmannalaugar');
    return { segs: t?.route?.segs.length ?? 0, points: t?.gpx.lines[0].points.length ?? 0, button: document.querySelector('#route-save').textContent };
  });
  if (!savedTrack.segs || savedTrack.points < 50 || savedTrack.button !== 'Saved') fail(`route saved as a track: ${JSON.stringify(savedTrack)}`);
  await page.click('#route-close');
  await page.click('#route-confirm-yes');
  // The destination as a pin too (the steps below work with two saved pins).
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-save');
  await page.click('#route-save-form button[type="submit"]');
  await page.waitForFunction(() => window.__app.saved.count === 2, { timeout: 5_000 }).catch(() => fail('second pin not saved'));
  await page.click('#route-close');
  console.log('saving ok:', savedInfo, '· saved as a track with', savedTrack.segs, 'road stretches');

  // 3f. Photos: picked photos with a location are copied (at most 2048 px, upright, their metadata
  // kept) and shown as thumbnails; those without one are shown first and left out.
  const photoDir = OUT + 'photos/';
  await mkdir(photoDir, { recursive: true });
  /** A JPEG w×h drawn by the browser, with an EXIF block (GPS when `at` is given). */
  const makePhoto = async (name, w, h, at, taken, orientation = 1, hue = 200) => {
    const b64 = await page.evaluate(async (w, h, hue) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${hue} 50% 70%)`;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#334';
      g.fillRect(0, h * 0.6, w, h * 0.4); // ground at the bottom of the stored pixels
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    }, w, h, hue);
    const dms = (v) => {
      const a = Math.abs(v);
      const d = Math.floor(a);
      const m = Math.floor((a - d) * 60);
      return [[d, 1], [m, 1], [Math.round(((a - d) * 60 - m) * 60 * 10000), 10000]];
    };
    const gps = at ? { 1: { type: 2, text: at[1] >= 0 ? 'N' : 'S' }, 2: { type: 5, r: dms(at[1]) }, 3: { type: 2, text: at[0] >= 0 ? 'E' : 'W' }, 4: { type: 5, r: dms(at[0]) }, 6: { type: 5, r: [[590, 1]] } } : undefined;
    const exif = tiff({ 0x010f: { type: 2, text: 'Apple' }, 0x0110: { type: 2, text: 'iPhone 13' }, 0x0112: { type: 3, n: [orientation] } },
      { 0x829a: { type: 5, r: [[1, 1200]] }, 0x829d: { type: 5, r: [[8, 5]] }, ...(taken ? { 0x9003: { type: 2, text: taken } } : {}), 0xa002: { type: 4, n: [w] }, 0xa003: { type: 4, n: [h] }, 0xa405: { type: 3, n: [26] } }, gps);
    const bytes = withSegments(new Uint8Array(Buffer.from(b64, 'base64')), [exifSegment(exif)]);
    await writeFile(photoDir + name, bytes);
    return photoDir + name;
  };
  const photoFiles = [
    // Turned on its side as stored (orientation 6): the copy comes out upright, taller than wide.
    await makePhoto('IMG_0001.jpg', 3000, 2000, [-19.0612, 63.9909], '2026:08:14 15:42:10', 6, 200),
    await makePhoto('IMG_0002.jpg', 1600, 1200, [-19.0610, 63.9910], '2026:08:14 15:50:00', 1, 30),
    await makePhoto('IMG_0003.jpg', 1600, 1200, [-19.67, 63.99], '2026:08:13 18:02:00', 1, 120),
    await makePhoto('IMG_0004.jpg', 800, 600, null, '2026:08:12 09:14:00', 1, 300),
    await makePhoto('IMG_0005.jpg', 800, 600, null, '2026:08:12 09:15:00', 1, 330),
  ];
  await page.click('#menu-button');
  await page.click('#photos-open');
  if (await page.$eval('#photos-empty', (e) => e.hidden)) fail('photos panel: no "no photos yet" text');
  await (await page.$('#photo-files')).uploadFile(...photoFiles);
  await page.waitForFunction(() => !document.querySelector('#photo-check').hidden, { timeout: 30_000 }).catch(() => fail('no "no location" step'));
  await page.waitForFunction(() => [...document.querySelectorAll('#photo-check-grid .check-photo div')].every((d) => d.style.backgroundImage), { timeout: 10_000 }).catch(() => {});
  const check = await page.evaluate(() => ({ title: document.querySelector('#photo-check-title').textContent, go: document.querySelector('#photo-check-go').textContent, tiles: [...document.querySelectorAll('#photo-check-grid .check-photo span')].map((e) => e.textContent) }));
  await page.screenshot({ path: `${OUT}photos-no-location.png` });
  if (check.title !== "2 photos don't have a location" || check.go !== 'Add the other 3' || check.tiles.join() !== '12 Aug 09:14,12 Aug 09:15') fail(`no-location step: ${JSON.stringify(check)}`);
  await page.click('#photo-check-go');
  await page.waitForFunction(() => document.querySelector('#photo-note-text').textContent === 'Added 3 photos' && !document.querySelector('#photo-note-undo').hidden, { timeout: 60_000 })
    .catch(async () => fail(`adding photos: ${await page.$eval('#photo-note', (e) => e.textContent)}`));
  // The copy: upright and at most 2048 px, its EXIF kept with orientation 1 and the new size.
  const copied = await page.evaluate(async () => {
    const p = window.__app.photos.all.find((x) => x.name === 'IMG_0001.jpg');
    const db = await new Promise((r) => { const q = indexedDB.open('garmin-map'); q.onsuccess = () => r(q.result); });
    const f = await new Promise((r) => { const q = db.transaction('photoFiles').objectStore('photoFiles').get(p.id); q.onsuccess = () => r(q.result); });
    db.close();
    const bytes = new Uint8Array(await f.full.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    const bm = await createImageBitmap(f.full, { imageOrientation: 'none' });
    return { p, b64: btoa(s), w: bm.width, h: bm.height, thumb: f.thumb.size };
  });
  const copyExif = readExif(exifOf(readSegments(new Uint8Array(Buffer.from(copied.b64, 'base64')))));
  if (copied.w !== 1365 || copied.h !== 2048 || copied.p.width !== 1365 || copied.p.height !== 2048 || copyExif.orientation !== 1 || Math.abs(copyExif.lat - 63.9909) > 1e-4 || copyExif.taken !== '2026-08-14T15:42:10' || copyExif.model !== 'iPhone 13' || !copied.thumb)
    fail(`stored copy: ${copied.w}×${copied.h} ${JSON.stringify({ ...copied.p, b64: undefined })} ${JSON.stringify(copyExif)}`);
  if (copied.p.camera !== 'iPhone 13 · 26 mm · f/1.6 · 1/1200 s' || copied.p.taken !== '2026-08-14T15:42:10' || copied.p.alt !== 590) fail(`photo record: ${JSON.stringify(copied.p)}`);
  // On the map: the two at Landmannalaugar as one thumbnail with a count, the third on its own.
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.3, 63.99], zoom: 9, bearing: 0 }); m.once('idle', r); }));
  await new Promise((r) => setTimeout(r, 300));
  const pins = await page.$$eval('.photo-pin', (els) => els.map((e) => ({ count: e.querySelector('.count')?.textContent ?? '1', bg: !!e.style.backgroundImage })));
  if (pins.length !== 2 || pins.map((p) => p.count).sort().join() !== '1,2' || !pins.every((p) => p.bg)) fail(`photos on the map: ${JSON.stringify(pins)}`);
  await page.screenshot({ path: `${OUT}photos-map.png` });
  // The same photo again: already there.
  await (await page.$('#photo-files')).uploadFile(photoFiles[1]);
  await page.waitForFunction(() => document.querySelector('#photo-note-text').textContent === 'That photo is already on the map', { timeout: 20_000 }).catch(async () => fail(`a photo added twice: ${await page.$eval('#photo-note', (e) => e.textContent)}`));
  // A tap on the group: the viewer, the first of the two.
  await page.click('.photo-pin .count');
  await page.waitForFunction(() => !document.querySelector('#photo-viewer').hidden && document.querySelector('#pv-img').src, { timeout: 10_000 }).catch(() => fail('viewer did not open'));
  let viewer = await page.evaluate(() => ({ count: document.querySelector('#pv-count').textContent, when: document.querySelector('#pv-when').textContent, camera: document.querySelector('#pv-camera').textContent, desc: document.querySelector('#pv-desc-text').textContent, prev: document.querySelector('#pv-prev').disabled }));
  if (viewer.count !== '1 of 2' || viewer.when !== 'Fri 14 Aug 2026 · 15:42' || viewer.camera !== 'iPhone 13 · 26 mm · f/1.6 · 1/1200 s' || viewer.desc !== '+ Add a description' || !viewer.prev) fail(`viewer: ${JSON.stringify(viewer)}`);
  await page.setViewport({ width: 390, height: 844 }); // (isMobile would reload the page)
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${OUT}photos-viewer.png` });
  await page.setViewport({ width: 1024, height: 1024 });
  await page.keyboard.press('ArrowRight');
  if (await page.$eval('#pv-count', (e) => e.textContent) !== '2 of 2') fail('the arrow key did not go to the next photo');
  await page.click('#pv-prev');
  // A description: Cancel keeps what was typed for next time; Save keeps it on the photo.
  await page.click('#pv-desc');
  await page.type('#pe-text', 'Lunch by the hot spring');
  await page.click('#pe-cancel');
  await page.click('#pv-desc');
  if (await page.$eval('#pe-text', (e) => e.value) !== 'Lunch by the hot spring') fail('a cancelled description was not kept as a draft');
  await page.type('#pe-text', ' & a swim');
  await page.screenshot({ path: `${OUT}photos-describe.png` });
  await page.click('#pe-save');
  await page.waitForFunction(() => document.querySelector('#pv-desc-text').textContent === 'Lunch by the hot spring & a swim', { timeout: 5_000 }).catch(() => fail('description not shown after Save'));
  const described = await page.evaluate(() => window.__app.photos.all.find((x) => x.name === 'IMG_0001.jpg'));
  if (described.description !== 'Lunch by the hot spring & a swim' || !described.updated) fail(`description not stored: ${JSON.stringify(described)}`);
  // Shared, the copy carries the description in its XMP, and its EXIF as before.
  const shared = await page.evaluate(async () => {
    const p = window.__app.photos.all.find((x) => x.name === 'IMG_0001.jpg');
    const f = await window.__app.photos.shareFile(p);
    const bytes = new Uint8Array(await f.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return { name: f.name, b64: btoa(s) };
  });
  const sharedSegs = metadataSegments(new Uint8Array(Buffer.from(shared.b64, 'base64')));
  if (shared.name !== 'IMG_0001.jpg' || descriptionOf(xmpOf(sharedSegs)) !== 'Lunch by the hot spring & a swim' || readExif(exifOf(sharedSegs)).taken !== '2026-08-14T15:42:10') fail(`shared copy: ${shared.name} ${xmpOf(sharedSegs)}`);
  // Delete, with Undo: on to the other photo; Undo brings it back.
  await page.click('#pv-delete');
  await page.waitForFunction(() => window.__app.photos.all.length === 2, { timeout: 5_000 }).catch(() => {});
  viewer = await page.evaluate(() => ({ count: document.querySelector('#pv-count').textContent, when: document.querySelector('#pv-when').textContent, note: document.querySelector('#photo-note-text').textContent, n: window.__app.photos.all.length }));
  if (viewer.count !== '' || viewer.when !== 'Fri 14 Aug 2026 · 15:50' || viewer.note !== 'Photo deleted' || viewer.n !== 2) fail(`delete: ${JSON.stringify(viewer)}`);
  await page.click('#photo-note-undo');
  await page.waitForFunction(() => window.__app.photos.all.length === 3, { timeout: 5_000 }).catch(() => fail('Undo did not bring the photo back'));
  await page.click('#pv-close');
  // The panel: by day, newest first; a tap opens the photo with the map moved there.
  await page.click('#menu-button');
  await page.click('#photos-open');
  const panel = await page.evaluate(() => ({ days: [...document.querySelectorAll('.photo-day h3')].map((h) => h.firstChild.textContent), thumbs: document.querySelectorAll('.photo-grid button').length, foot: document.querySelector('#photos-foot').textContent }));
  await page.screenshot({ path: `${OUT}photos-panel.png` });
  if (panel.days.join() !== 'Fri 14 Aug 2026,Thu 13 Aug 2026' || panel.thumbs !== 3 || !/^3 photos · \d+ (kB|MB) on this device\./.test(panel.foot)) fail(`photos panel: ${JSON.stringify(panel)}`);
  await page.click('.photo-day:nth-child(2) .photo-grid button');
  const opened = await page.evaluate(() => ({ when: document.querySelector('#pv-when').textContent, center: window.__app.map.getCenter() }));
  if (opened.when !== 'Thu 13 Aug 2026 · 18:02' || Math.abs(opened.center.lng + 19.67) > 1e-3) fail(`photo from the panel: ${JSON.stringify(opened)}`);
  // On a head unit: the details beside the photo.
  await page.setViewport({ width: 1280, height: 720 });
  await new Promise((r) => setTimeout(r, 300));
  const side = await page.evaluate(() => ({ sheet: document.querySelector('#pv-sheet').getBoundingClientRect().left, stage: document.querySelector('#pv-stage').getBoundingClientRect().right }));
  await page.screenshot({ path: `${OUT}photos-headunit.png` });
  if (side.sheet < 800 || side.stage > side.sheet + 1) fail(`head-unit viewer: ${JSON.stringify(side)}`);
  await page.setViewport({ width: 1024, height: 1024 });
  await page.keyboard.press('Escape');
  if (!(await page.$eval('#photo-viewer', (e) => e.hidden))) fail('Escape did not close the viewer');
  await page.evaluate(() => (document.querySelector('#photo-note').hidden = true));
  // The map's photo button (left of save-a-pin, while location is on). A photo just taken without a
  // location goes where you are at once; an older one only when you choose it in the "no location" step.
  const locWas = await page.$eval('.locate-button', (b) => b.dataset.state);
  if (locWas === 'off') await page.click('.locate-button');
  await new Promise((r) => setTimeout(r, 1500)); // still at Selfoss (63.936, -21.0) from the routing steps
  const buttons = await page.evaluate(() => {
    const box = (q) => { const e = document.querySelector(q); return e && !e.closest('[hidden]') ? e.getBoundingClientRect() : null; };
    const p = box('#map .photo-here-button');
    const s = box('#map .save-here-button');
    return { photo: p && { x: p.x, w: p.width }, save: s && { x: s.x, w: s.width } };
  });
  if (!buttons.photo || !buttons.save || buttons.photo.x >= buttons.save.x || buttons.photo.w !== buttons.save.w) fail(`photo button: ${JSON.stringify(buttons)}`);
  // Like the iPhone's camera through Safari: EXIF with neither a time nor a location, a new file.
  const camera = await makePhoto('CAMERA.jpg', 1200, 900, null, null, 1, 60);
  const old = await makePhoto('OLD.jpg', 800, 600, null, '2026:08:12 09:20:00', 1, 90);
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5_000 }), page.click('#map .photo-here-button')]);
  await chooser.accept([camera, old]);
  await page.waitForFunction(() => !document.querySelector('#photo-check').hidden, { timeout: 15_000 }).catch(() => fail('photo button: no "no location" step'));
  const hereCheck = await page.evaluate(() => ({ here: document.querySelector('#photo-check-here').closest('[hidden]') ? null : document.querySelector('#photo-check-here').textContent, go: document.querySelector('#photo-check-go').textContent, tiles: [...document.querySelectorAll('#photo-check-grid .check-photo span')].map((e) => e.textContent) }));
  await page.screenshot({ path: `${OUT}photos-check-here.png` });
  if (hereCheck.here !== 'Put it where I am' || hereCheck.go !== 'Add the other one' || hereCheck.tiles.join() !== '12 Aug 09:20') fail(`photo button: check offers ${JSON.stringify(hereCheck)}`);
  await page.click('#photo-check-here');
  await page.waitForFunction(() => window.__app.photos.all.length === 5, { timeout: 15_000 }).catch(() => fail('photo button: the photos were not added where you are'));
  const placedHere = await page.evaluate(() => window.__app.photos.all.filter((p) => p.name === 'CAMERA.jpg' || p.name === 'OLD.jpg').map((p) => [p.lat, p.lon]));
  if (placedHere.length !== 2 || placedHere.some(([lat, lon]) => Math.abs(lat - 63.936) > 1e-5 || Math.abs(lon + 21.0) > 1e-5)) fail(`photo button: placed at ${JSON.stringify(placedHere)}`);
  await page.waitForFunction(() => document.querySelector('#photo-note-text').textContent === 'Added 2 photos', { timeout: 10_000 }).catch(() => {});
  const hereSub = await page.$eval('#photo-note-sub', (e) => e.textContent);
  if (hereSub !== '1 just taken, so put where you are') fail(`photo button: note says ${hereSub}`);
  const cameraTaken = await page.evaluate(() => window.__app.photos.all.find((p) => p.name === 'CAMERA.jpg')?.taken);
  if (!cameraTaken || Math.abs(new Date(cameraTaken).getTime() - Date.now()) > 5 * 60_000) fail(`photo button: the photo just taken has time ${cameraTaken}`);
  await page.click('#photo-note-undo');
  await page.waitForFunction(() => window.__app.photos.all.length === 3, { timeout: 5_000 }).catch(() => fail('photo button: Undo did not take the photo back'));
  for (let i = 0; i < 4 && (await page.$eval('.locate-button', (b) => b.dataset.state)) !== locWas; i++) await page.click('.locate-button');
  console.log('photos ok:', panel.foot.split('.')[0]);

  // 4. reload opens straight from storage, where the app was: view, location mode and route
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Landmannalaugar', lon: -19.06, lat: 63.991 }));
  await page.click('#route-go');
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 });
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.5, 64.05], zoom: 9.5, bearing: 0 }); m.once('idle', r); }));
  await new Promise((r) => setTimeout(r, 800)); // the save waits for the map to settle
  const was = await page.evaluate(() => ({ locate: document.querySelector('.locate-button').dataset.state }));
  await page.reload();
  await waitReady();
  await page.waitForFunction(() => /km · /.test(document.querySelector('#route-info')?.textContent ?? ''), { timeout: 60_000 }).catch(() => fail('route not restored after reload'));
  const now = await page.evaluate(() => {
    const m = window.__app.map;
    return { title: document.querySelector('#route-title').textContent, center: m.getCenter().toArray(), zoom: m.getZoom(), locate: document.querySelector('.locate-button').dataset.state, drawn: m.getStyle().sources.route.data.features.length };
  });
  console.log('restored:', JSON.stringify({ was, now }));
  if (now.title !== 'To Landmannalaugar' || !now.drawn || now.locate !== was.locate) fail(`restore after reload: ${JSON.stringify({ was, now })}`);
  // Without location on, the view is exactly as left (following would move it to the position).
  if (was.locate === 'off' && (Math.abs(now.center[0] + 19.5) > 0.001 || Math.abs(now.center[1] - 64.05) > 0.001 || Math.abs(now.zoom - 9.5) > 0.01)) fail(`view not restored: ${JSON.stringify(now)}`);
  await page.click('#route-close');
  await page.click('#route-confirm-yes');
  // Location came back on with the app, so the screen is kept on (the setting is on by default).
  if (was.locate !== 'off') await page.waitForFunction(() => window.__app.screenAwake.held, { timeout: 5_000 }).catch(() => fail('screen not kept on after the app reopened with location on'));
  console.log('restore after reload ok');
  // Saved pins are kept across the reload (the star is back), and so is the route saved as a track.
  await page.waitForFunction(() => window.__app.saved?.count === 2, { timeout: 10_000 }).catch(() => fail('saved items not kept across reload'));
  if (!(await page.$eval('#route-card', (e) => e.hidden))) {
    await page.click('#route-close');
    await page.click('#route-confirm-yes');
  }
  // Navigating the saved route from 2 km off it: its card says how far; the way to its nearest
  // point is planned, then along it ("Join To Landmannalaugar").
  const setFix = async (lat, lon) => {
    await gps.send('Emulation.setGeolocationOverride', { latitude: lat, longitude: lon, accuracy: 8, speed: 0 });
    await new Promise((r) => setTimeout(r, 400));
  };
  const firstPoint = await page.evaluate(() => { const p = window.__app.tracks.all.find((x) => x.name === 'To Landmannalaugar').gpx.lines[0].points[0]; return [p.lat, p.lon]; });
  await setFix(firstPoint[0] + 0.018, firstPoint[1]);
  await page.click('#menu-button');
  await page.click('#tracks-open');
  const routeRow = await page.$$eval('#track-list li', (lis) => lis.findIndex((li) => li.querySelector('.name').textContent === 'To Landmannalaugar') + 1);
  await page.click(`#track-list li:nth-child(${routeRow}) .track-info`);
  if (!(await page.$eval('#tracks', (e) => e.hidden))) await page.click('#tracks-close');
  const trackCardNote = await page.$eval('#track-card-note', (e) => e.textContent);
  if (!/^You're \d(\.\d)? km from the track: navigation takes you to its nearest point, then along it\.$/.test(trackCardNote)) fail(`track card: ${trackCardNote}`);
  await page.screenshot({ path: `${OUT}track-card.png` });
  await page.click('#track-navigate');
  await page.waitForFunction(() => document.body.classList.contains('navigating'), { timeout: 60_000 }).catch(async () => fail(`track navigation did not start: ${await page.$eval('#track-card-note', (e) => e.textContent)}`));
  // The route drawn is the way to the track and the track on to its end.
  const trackNavState = await page.evaluate(() => {
    const drawn = window.__app.map.getStyle().sources['track-nav'].data.features[0]?.geometry.coordinates ?? [];
    const pts = window.__app.tracks.all.find((x) => x.name === 'To Landmannalaugar').gpx.lines[0].points;
    const end = pts[pts.length - 1];
    return { to: document.querySelector('#nav-to').textContent, steps: window.__app.navigator.steps.map((m) => m.text), drawnToEnd: !!drawn.length && drawn[drawn.length - 1][0] === end.lon && drawn[drawn.length - 1][1] === end.lat, drawnFromYou: !!drawn.length && Math.abs(drawn[0][1] - pts[0].lat - 0.018) < 0.01 };
  });
  if (trackNavState.to !== 'To Landmannalaugar' || !trackNavState.steps.includes('Join To Landmannalaugar') || !trackNavState.drawnToEnd || !trackNavState.drawnFromYou || trackNavState.steps.length < 4) fail(`navigating a saved route: ${JSON.stringify(trackNavState)}`);
  await page.screenshot({ path: `${OUT}track-nav.png` });
  console.log('to the track:', trackNavState.steps.slice(0, 4).join(' · '));
  await page.click('#nav-end');
  const trackNavDrawn = () => page.evaluate(() => window.__app.map.getStyle().sources['track-nav'].data.features.length);
  if (await trackNavDrawn()) fail('the way to the track still drawn after End');
  // Undo puts the track's guidance back, drawn as it was.
  await page.click('#nav-undo-button');
  if (!(await page.evaluate(() => document.body.classList.contains('navigating'))) || !(await trackNavDrawn())) fail('Undo after End did not bring back the track navigation');
  await page.click('#nav-end');
  // An imported trail: on it from its start; 150 m off it, the way back is pointed out (no road
  // route planned to a hillside).
  const trail = await page.evaluate(() => window.__app.tracks.all.find((x) => !x.route).gpx.lines[0].points.slice(0, 2).map((p) => [p.lat, p.lon]));
  await setFix(trail[0][0], trail[0][1]);
  await page.click('#menu-button');
  await page.click('#tracks-open');
  const trailRow = await page.$$eval('#track-list li', (lis) => lis.findIndex((li) => li.querySelector('.name').textContent === 'Laugavegur start') + 1);
  await page.click(`#track-list li:nth-child(${trailRow}) .track-info`);
  if (!(await page.$eval('#tracks', (e) => e.hidden))) await page.click('#tracks-close');
  if (!/^You're on the track/.test(await page.$eval('#track-card-note', (e) => e.textContent))) fail(`trail card: ${await page.$eval('#track-card-note', (e) => e.textContent)}`);
  await page.click('#track-navigate');
  await page.waitForFunction(() => document.body.classList.contains('navigating'), { timeout: 60_000 }).catch(() => fail('trail navigation did not start'));
  for (let k = 0; k < 4; k++) await setFix(trail[0][0] + 0.0004 * (k + 1) * 0.3, trail[0][1] + 0.0035);
  const offTrail = await page.evaluate(() => ({ banner: document.querySelector('#nav-banner').className, dist: document.querySelector('#nav-dist').textContent, text: document.querySelector('#nav-text').textContent }));
  if (offTrail.banner !== 'off' || offTrail.dist !== 'Off the track' || !/ from it · back to it (north|south|east|west)/.test(offTrail.text)) fail(`off the trail: ${JSON.stringify(offTrail)}`);
  console.log('off the trail:', offTrail.text);
  await page.click('#nav-end');
  await page.click('#menu-button');
  await page.click('#saved-open');
  const rows = await page.$$eval('#saved-list .track-info .name', (els) => els.map((e) => e.textContent));
  if (rows.join('|') !== 'Hekla view|Landmannalaugar') fail(`saved list: ${rows}`);
  // Renaming a saved pin: the list and its star's label.
  await renameRow('#saved-list', 'Landmannalaugar', 'Landmannalaugar hut');
  await page.waitForFunction(() => window.__app.map.getStyle().sources.saved.data.features.some((f) => f.properties.name === 'Landmannalaugar hut'), { timeout: 5_000 }).catch(() => fail('pin rename not on the map'));
  await renameRow('#saved-list', 'Landmannalaugar hut', 'Landmannalaugar');
  await page.waitForFunction(() => [...document.querySelectorAll('#saved-list .name')].map((e) => e.textContent).join('|') === 'Hekla view|Landmannalaugar', { timeout: 5_000 }).catch(() => fail('pin renamed back'));
  console.log('pin rename ok');
  await page.click('#saved-list li:nth-child(1) .track-info');
  const pinCard = await page.evaluate(() => ({ title: document.querySelector('#route-title').textContent, go: !document.querySelector('#route-go').hidden }));
  if (pinCard.title !== 'Hekla view' || !pinCard.go) fail(`opened saved pin: ${JSON.stringify(pinCard)}`);
  // Routing to a saved pin says so by its name.
  await page.click('#route-go');
  const routingTitle = await page.$eval('#route-title', (e) => e.textContent);
  if (routingTitle !== 'Routing to Hekla view') fail(`title routing to a saved pin: ${routingTitle}`);
  await page.click('#route-close');
  await page.click('#route-confirm-yes');
  // Back up (a download here) with both items and the GPX track; delete them; restore brings them back.
  const backupName = `Varda backup ${new Date().toISOString().slice(0, 10)}.json`;
  await rm(`${dl}${backupName}`, { force: true });
  const syncPanel = async (open) => {
    if (open === (await page.$eval('#sync-panel', (e) => !e.hidden))) return;
    if (open) {
      await page.click('#menu-button');
      await page.click('#sync-open');
    } else await page.click('#sync-close');
  };
  await syncPanel(true);
  await page.click('#backup-save');
  await syncPanel(false);
  let backupText = '';
  for (let t = 0; t < 50 && !backupText; t++) {
    await new Promise((r) => setTimeout(r, 100));
    backupText = await readFile(`${dl}${backupName}`, 'utf8').catch(() => '');
  }
  const backup = JSON.parse(backupText || '{}');
  if (backup.saved?.length !== 2 || backup.tracks?.length !== 2) fail(`backup file: ${backupText.slice(0, 200)}`);
  // Opening the menu for the sync panel closed the Saved panel: open it again.
  await page.click('#menu-button');
  await page.click('#saved-open');
  for (const left of [1, 0]) {
    await page.click('#saved-list li:first-child .track-delete');
    await page.click('#saved-list li:first-child .track-delete');
    await page.waitForFunction((n) => window.__app.saved.count === n && document.querySelectorAll('#saved-list li').length === n, { timeout: 5_000 }, left);
  }
  await page.waitForFunction(() => window.__app.saved.count === 0 && !document.querySelector('#saved-list li'), { timeout: 5_000 }).catch(() => fail('saved items not deleted'));
  await (await page.$('#backup-file')).uploadFile(`${dl}${backupName}`);
  await page.waitForFunction(() => window.__app.saved.count === 2, { timeout: 5_000 }).catch(() => fail('restore did not bring the saved items back'));
  const restored = await page.$eval('#backup-status', (e) => e.textContent);
  if (restored !== 'Restored 2 saved items and 0 tracks.') fail(`restore status: ${restored}`);
  console.log('backup and restore ok:', restored);

  // 4b. Google Drive sync, against a fake Drive and a fake sign-in helper (requests to googleapis.com
  // and the helper answered here; signing in starts as the return from Google's page, with a code).
  // Needs a build with VITE_GOOGLE_CLIENT_ID set.
  if (await page.$eval('#sync', (e) => e.hidden)) fail('no Google Drive sync section (build with VITE_GOOGLE_CLIENT_ID=e2e)');
  const fakeDrive = { file: null, status: 200, photos: new Map(), deletedPhotos: [] };
  const remotePin = { id: 'remote-1', kind: 'pin', name: 'Remote hut', added: 1, lon: -19.3, lat: 64.2 };
  const remoteTrack = { id: 'remote-t', name: 'Remote track', color: '#0891b2', visible: true, added: 2, stats: { distance: 1200, climb: 30, duration: null }, gpx: { name: 'Remote track', lines: [{ kind: 'track', name: 'Remote track', points: [{ lon: -19.1, lat: 63.99, ele: 600, time: null }, { lon: -19.09, lat: 64.0, ele: 630, time: null }] }], waypoints: [] } };
  fakeDrive.file = JSON.stringify({ app: 'garmin-map', kind: 'backup', version: 1, exported: new Date().toISOString(), saved: [remotePin], tracks: [remoteTrack], deleted: {} });
  const tracksBefore = await page.evaluate(() => window.__app.tracks.count);
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
  const fakeHelper = { calls: [], refresh: 200 };
  const onRequest = (req) => {
    const url = new URL(req.url());
    if (url.hostname === 'accounts.google.com') return req.respond({ status: 200, contentType: 'text/javascript', body: '' });
    if (url.hostname === 'auth.vardamaps.app') {
      const h = { ...cors, 'Access-Control-Allow-Origin': `http://localhost:${PORT}` };
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: h });
      fakeHelper.calls.push({ path: url.pathname, body: req.postData() ? JSON.parse(req.postData()) : null });
      const json = (status, o) => req.respond({ status, headers: h, contentType: 'application/json', body: JSON.stringify(o) });
      if (url.pathname === '/token') return json(200, { access_token: 'e2e-token', expires_in: 3600, sealed: 'v1.e2e' });
      if (url.pathname === '/refresh') return fakeHelper.refresh === 200 ? json(200, { access_token: 'e2e-token-2', expires_in: 3600 }) : json(fakeHelper.refresh, { error: 'signed_out' });
      return req.respond({ status: 204, headers: h });
    }
    if (url.hostname !== 'www.googleapis.com') return req.continue();
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    if (fakeDrive.status !== 200) return req.respond({ status: fakeDrive.status, headers: cors, body: '' });
    const json = (o) => req.respond({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(o) });
    // Photo pictures: files of their own, listed by name.
    if (req.method() === 'GET' && url.pathname === '/drive/v3/files' && (url.searchParams.get('q') ?? '').includes('garmin-map-photo-')) return json({ files: [...fakeDrive.photos].map(([name, f]) => ({ id: f.id, name })) });
    const photoId = url.pathname.match(/^\/drive\/v3\/files\/(p-[\w-]+)$/)?.[1];
    if (photoId) {
      const entry = [...fakeDrive.photos].find(([, f]) => f.id === photoId);
      if (req.method() === 'DELETE') {
        if (entry) fakeDrive.photos.delete(entry[0]);
        fakeDrive.deletedPhotos.push(photoId);
        return req.respond({ status: 204, headers: cors, body: '' });
      }
      return entry ? req.respond({ status: 200, headers: cors, contentType: 'image/jpeg', body: entry[1].body }) : req.respond({ status: 404, headers: cors, body: '' });
    }
    if (req.method() === 'POST' && url.pathname === '/upload/drive/v3/files' && (req.headers()['content-type'] ?? '').startsWith('multipart/related')) {
      // A picture's upload is a Blob, whose body Chrome doesn't hand over: the page names it in a
      // header (see the fetch wrapper below).
      return Promise.resolve(req.postData() ?? '').then((body) => {
        const name = req.headers()['x-e2e-name'] ?? /"name":"(garmin-map-photo-[^"]+)"/.exec(body)?.[1];
        if (!name) return null;
        const id = `p-${fakeDrive.photos.size + 1}-${Date.now()}`;
        fakeDrive.photos.set(name, { id, body: Buffer.from('') });
        return json({ id });
      }).then((done) => {
        if (done !== null) return;
        return Promise.resolve(req.postData() ?? '').then((body) => {
          const parts = body.split(/--garmin-map-[a-z0-9]+/);
          fakeDrive.file = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4).trim();
          return json({ id: 'f1' });
        });
      });
    }
    if (req.method() === 'GET' && url.pathname === '/drive/v3/files') return json({ files: fakeDrive.file ? [{ id: 'f1' }] : [] });
    if (req.method() === 'GET' && url.pathname === '/drive/v3/files/f1') return req.respond({ status: 200, headers: cors, contentType: 'application/json', body: fakeDrive.file ?? '' });
    if (req.method() === 'PATCH' && url.pathname === '/upload/drive/v3/files/f1') { fakeDrive.file = req.postData(); return json({ id: 'f1' }); }
    if (req.method() === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const parts = req.postData().split(/--garmin-map-[a-z0-9]+/);
      fakeDrive.file = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4).trim();
      return json({ id: 'f1' });
    }
    return req.respond({ status: 404, headers: cors, body: '' });
  };
  await page.setRequestInterception(true);
  page.on('request', onRequest);
  await page.evaluateOnNewDocument(() => {
    const raw = window.fetch;
    window.fetch = async (url, init) => {
      if (init?.body instanceof Blob && String(url).includes('/upload/drive/v3/files')) {
        const name = /"name":"([^"]+)"/.exec(await init.body.slice(0, 600).text())?.[1];
        if (name) init = { ...init, headers: { ...init.headers, 'x-e2e-name': name } };
      }
      return raw(url, init);
    };
  });
  const remote = () => JSON.parse(fakeDrive.file);
  // Back from Google's sign-in page with a code: the helper trades it, the address is tidied, it syncs.
  await page.evaluate(() => localStorage.setItem('google-sync-signin', 'e2e-state'));
  await page.goto(`http://localhost:${PORT}/?code=e2e-code&state=e2e-state&scope=x`);
  await waitReady();
  await page.waitForFunction(() => /^Synced with Google Drive at \d\d:\d\d\. You stay signed in on this device\.$/.test(document.querySelector('#sync-text').textContent), { timeout: 30_000 })
    .catch(async () => fail(`sign-in through the helper: ${await page.$eval('#sync-text', (e) => e.textContent)}`));
  const token = fakeHelper.calls.find((c) => c.path === '/token');
  if (page.url() !== `http://localhost:${PORT}/` || token?.body.code !== 'e2e-code' || token.body.redirect_uri !== `http://localhost:${PORT}/`) fail(`sign-in return: ${page.url()} ${JSON.stringify(fakeHelper.calls)}`);
  // (The reload closed the Saved panel the steps below use.)
  await page.click('#menu-button');
  await page.click('#saved-open');
  let sync = await page.evaluate(() => ({ count: window.__app.saved.count, text: document.querySelector('#sync-text').textContent, names: [...document.querySelectorAll('#saved-list .name')].map((e) => e.textContent) }));
  const menuStatus = await page.$eval('#sync-menu-status', (e) => e.textContent);
  if (!/^Synced \d\d:\d\d$/.test(menuStatus)) fail(`menu sync state: ${menuStatus}`);
  // Tracks come down from another device too, and show on the map.
  const trackSync = await page.evaluate(() => ({ count: window.__app.tracks.count, names: [...document.querySelectorAll('#track-list .name')].map((e) => e.textContent), drawn: window.__app.map.getStyle().sources.gpx.data.features.length }));
  if (trackSync.count !== tracksBefore + 1 || !trackSync.names.includes('Remote track') || !trackSync.drawn) fail(`track from another device: ${JSON.stringify(trackSync)} (had ${tracksBefore})`);
  if (sync.count !== 3 || !sync.names.includes('Remote hut') || !/^Synced with Google Drive at \d\d:\d\d\. You stay signed in on this device\.$/.test(sync.text) || remote().saved.length !== 3 || remote().tracks.length !== tracksBefore + 1) fail(`first sync: ${JSON.stringify(sync)} drive has ${remote().saved.length} saved, ${remote().tracks.length} tracks`);
  // A deletion here reaches Drive (a few seconds after the change).
  const hutRow = await page.$$eval('#saved-list li', (lis) => lis.findIndex((li) => li.querySelector('.name').textContent === 'Remote hut') + 1);
  await page.click(`#saved-list li:nth-child(${hutRow}) .track-delete`);
  await page.click(`#saved-list li:nth-child(${hutRow}) .track-delete`);
  for (let t = 0; t < 80 && remote().saved.length !== 2; t++) await new Promise((r) => setTimeout(r, 100));
  if (remote().saved.length !== 2 || !remote().deleted['remote-1']) fail(`deletion not synced: ${fakeDrive.file.slice(0, 200)}`);
  // A deletion on another device reaches this one.
  const other = remote();
  const gone = other.saved[0];
  other.saved = other.saved.slice(1);
  other.deleted[gone.id] = Date.now();
  fakeDrive.file = JSON.stringify(other);
  await page.evaluate(() => window.__app.sync.syncNow());
  if ((await page.evaluate(() => window.__app.saved.count)) !== 1) fail('a deletion on another device did not reach this one');
  // Photos sync only when switched on: asked first (how many, how big), then each picture goes up.
  if (remote().photos?.length) fail('photos synced before being switched on');
  await syncPanel(true);
  if (await page.$eval('#sync-photos', (e) => e.getAttribute('aria-checked')) !== 'false') fail('photo sync on before being asked for');
  await page.click('#sync-photos');
  await page.waitForFunction(() => !document.querySelector('#sync-photos-ask').hidden, { timeout: 5_000 }).catch(() => {});
  const ask = await page.evaluate(() => ({ shown: !document.querySelector('#sync-photos-ask').hidden, title: document.querySelector('#sync-photos-ask-title').textContent }));
  if (!ask.shown || ask.title !== 'Upload 3 photos to Drive?') fail(`photo sync question: ${JSON.stringify(ask)}`);
  await page.screenshot({ path: `${OUT}sync-photos-ask.png` });
  await page.click('#sync-photos-go');
  await page.waitForFunction(() => document.querySelector('#sync-photos').getAttribute('aria-checked') === 'true', { timeout: 5_000 });
  for (let t = 0; t < 100 && !(fakeDrive.photos.size === 3 && remote().photos?.length === 3); t++) await new Promise((r) => setTimeout(r, 100));
  if (fakeDrive.photos.size !== 3 || remote().photos?.length !== 3 || remote().photos.find((p) => p.name === 'IMG_0001.jpg')?.description !== 'Lunch by the hot spring & a swim') fail(`photos to Drive: ${fakeDrive.photos.size} pictures, ${remote().photos?.length} in the sync file`);
  // A photo from another device: its details in the sync file, its picture a file; it comes down
  // and shows on the map with a thumbnail made here.
  const otherPhoto = { id: 'remote-photo', added: Date.now(), lon: -19.5, lat: 64.1, alt: null, taken: '2026-08-20T12:00:00', camera: 'Pixel 8', width: 1600, height: 1200, bytes: 200000, name: 'PXL_1.jpg' };
  fakeDrive.photos.set('garmin-map-photo-remote-photo.jpg', { id: 'p-remote', body: await readFile(photoFiles[2]) });
  const withPhoto = remote();
  withPhoto.photos.push(otherPhoto);
  fakeDrive.file = JSON.stringify(withPhoto);
  await page.evaluate(() => window.__app.sync.syncNow());
  await page.waitForFunction(() => window.__app.photos.all.some((p) => p.id === 'remote-photo'), { timeout: 10_000 }).catch(() => fail('a photo from another device did not come'));
  const arrived = await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open('garmin-map'); q.onsuccess = () => r(q.result); });
    const f = await new Promise((r) => { const q = db.transaction('photoFiles').objectStore('photoFiles').get('remote-photo'); q.onsuccess = () => r(q.result); });
    db.close();
    return f ? { full: f.full.size, thumb: f.thumb.size } : null;
  });
  if (!arrived?.full || !arrived.thumb) fail(`picture from another device: ${JSON.stringify(arrived)}`);
  // Deleted here (and the Undo let go of): gone from Drive, its picture too.
  await page.evaluate(() => { const p = window.__app.photos.all.find((x) => x.id === 'remote-photo'); return window.__app.photos.remove(p); });
  await page.evaluate(() => window.__app.sync.syncNow());
  for (let t = 0; t < 50 && !fakeDrive.deletedPhotos.includes('p-remote'); t++) await new Promise((r) => setTimeout(r, 100));
  if (!fakeDrive.deletedPhotos.includes('p-remote') || remote().photos.some((p) => p.id === 'remote-photo')) fail(`photo deleted here not gone from Drive: ${fakeDrive.deletedPhotos}`);
  await page.evaluate(() => document.querySelector('#photo-note').hidden = true);
  await syncPanel(false);
  console.log('photo sync ok:', fakeDrive.photos.size, 'pictures in Drive');
  // Offline (or a connection that doesn't answer): the app carries on; sync says it'll try later.
  await page.setOfflineMode(true);
  await page.evaluate(() => window.__app.sync.syncNow());
  const offlineText = await page.$eval('#sync-text', (e) => e.textContent);
  if (offlineText !== "Offline: syncs when you're back online.") fail(`sync offline: ${offlineText}`);
  await page.evaluate(() => window.__app.routePlanner.pick({ name: 'Offline pin', lon: -19.5, lat: 64.1 }));
  await page.click('#route-save');
  await page.click('#route-save-form button[type="submit"]');
  await page.waitForFunction(() => window.__app.saved.count === 2, { timeout: 5_000 }).catch(() => fail('saving offline did not work'));
  await page.click('#route-close');
  await page.setOfflineMode(false);
  await page.evaluate(() => window.__app.sync.syncNow());
  if (!remote().saved.some((x) => x.name === 'Offline pin')) fail('what was saved offline did not sync once back online');
  // An hour on: a new token from the helper with the sealed key, no sign-in.
  const expire = () => page.evaluate(() => localStorage.setItem('google-sync', JSON.stringify({ ...JSON.parse(localStorage.getItem('google-sync')), expires: Date.now() - 1000 })));
  await expire();
  await page.evaluate(() => window.__app.sync.syncNow());
  // (A sync already under way runs again after it: wait for the one that renews.)
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('google-sync')).token === 'e2e-token-2' && /^Synced/.test(document.querySelector('#sync-text').textContent), { timeout: 10_000 }).catch(() => {});
  sync = await page.evaluate(() => ({ text: document.querySelector('#sync-text').textContent, state: JSON.parse(localStorage.getItem('google-sync')) }));
  if (!fakeHelper.calls.some((c) => c.path === '/refresh' && c.body.sealed === 'v1.e2e') || sync.state.token !== 'e2e-token-2' || !/^Synced/.test(sync.text)) fail(`renewal through the helper: ${JSON.stringify(sync)}`);
  // The key withdrawn (Stop syncing on another device, or in the Google account): sign in again.
  fakeHelper.refresh = 401;
  await expire();
  await page.evaluate(() => window.__app.sync.syncNow());
  await page.waitForFunction(() => document.querySelector('#sync-text').textContent === 'Sign in again to keep syncing.', { timeout: 10_000 }).catch(() => {});
  sync = await page.evaluate(() => ({ text: document.querySelector('#sync-text').textContent, shown: !document.querySelector('#sync-connect').hidden, sealed: JSON.parse(localStorage.getItem('google-sync')).sealed }));
  if (sync.text !== 'Sign in again to keep syncing.' || !sync.shown || sync.sealed) fail(`withdrawn key: ${JSON.stringify(sync)}`);
  // A token refused by Drive (no sealed key to renew it) asks to sign in again; Stop syncing turns
  // sync off and withdraws the key at Google.
  await page.evaluate(() => localStorage.setItem('google-sync', JSON.stringify({ ...JSON.parse(localStorage.getItem('google-sync')), token: 'e2e-token', expires: Date.now() + 3_600_000 })));
  fakeDrive.status = 401;
  await page.evaluate(() => window.__app.sync.syncNow());
  sync = await page.evaluate(() => ({ text: document.querySelector('#sync-text').textContent, button: document.querySelector('#sync-connect').textContent, shown: !document.querySelector('#sync-connect').hidden }));
  if (sync.text !== 'Sign in again to keep syncing.' || sync.button !== 'Sign in to Google' || !sync.shown) fail(`expired sign-in: ${JSON.stringify(sync)}`);
  await syncPanel(true);
  await page.screenshot({ path: `${OUT}sync-panel.png` });
  await page.evaluate(() => localStorage.setItem('google-sync', JSON.stringify({ ...JSON.parse(localStorage.getItem('google-sync')), sealed: 'v1.e2e' })));
  await page.click('#sync-stop');
  if (await page.$eval('#sync-menu-status', (e) => e.textContent) !== '') fail('menu still shows a sync state after Stop syncing');
  for (let t = 0; t < 20 && !fakeHelper.calls.some((c) => c.path === '/revoke'); t++) await new Promise((r) => setTimeout(r, 100));
  if (!fakeHelper.calls.some((c) => c.path === '/revoke' && c.body.sealed === 'v1.e2e')) fail('Stop syncing did not withdraw the key');
  console.log('sign-in helper ok:', fakeHelper.calls.map((c) => c.path).join(' '));
  await syncPanel(false);
  if (await page.$eval('#sync-connect', (e) => e.textContent) !== 'Sync with Google Drive') fail('Stop syncing did not turn sync off');
  page.off('request', onRequest);
  await page.setRequestInterception(false);
  // Leave the device as before the sync: delete the track that came from "another device".
  if (await page.$eval('#saved', (e) => !e.hidden)) await page.click('#saved-close');
  await page.click('#menu-button');
  await page.click('#tracks-open');
  const remoteRow = await page.$$eval('#track-list li', (lis) => lis.findIndex((li) => li.querySelector('.name').textContent === 'Remote track') + 1);
  await page.click(`#track-list li:nth-child(${remoteRow}) .track-delete`);
  await page.click(`#track-list li:nth-child(${remoteRow}) .track-delete`);
  await page.waitForFunction((n) => window.__app.tracks.count === n, { timeout: 5_000 }, tracksBefore);
  await page.click('#tracks-close');
  console.log('drive sync ok');
  if (await page.$eval('#saved', (e) => !e.hidden)) await page.click('#saved-close');
  console.log('saved list ok');
  if (await page.$('#maps-panel.standalone')) fail('the first screen shown after reload');
  await page.waitForFunction((n) => window.__app?.tracks?.count === n, { timeout: 10_000 }, tracksBefore).catch(() => fail('tracks not kept across reload'));
  // Deleting asks for a second tap.
  await page.click('#menu-button');
  await page.click('#tracks-open');
  await page.click('.track-delete');
  if ((await page.evaluate(() => window.__app.tracks.count)) !== tracksBefore) fail('deleted a track without confirmation');
  await page.click('.track-delete');
  await page.waitForFunction((n) => window.__app.tracks.count === n - 1 && document.querySelectorAll('#track-list .track').length === n - 1, { timeout: 5_000 }, tracksBefore).catch(() => fail('track not deleted'));
  await page.click('#tracks-close');
  console.log('reload from storage ok');

  // 5. offline reload
  await page.setOfflineMode(true);
  await page.reload();
  await waitReady();
  console.log('offline reload ok');

  // 6. Several maps. The first start kept the elevation files as a set and the map beside it.
  await page.setOfflineMode(false);
  const opfs = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name, h] of root.entries()) names.push(`${name}${h.kind === 'directory' ? '/' : ''}`);
    const read = async (n) => (names.includes(n) ? JSON.parse(await (await (await root.getFileHandle(n)).getFile()).text()) : null);
    return { names: names.sort(), pointer: await read('current.json'), choices: await read('maps.json') };
  });
  const mapDirs = (o) => o.names.filter((n) => n === 'garmin/' || n.startsWith('garmin-'));
  const setDirs = (o) => o.names.filter((n) => n.startsWith('elevation-'));
  /** The generation in the map's tile address (one more for each map or hillshading shown). */
  const tileGen = () => page.evaluate(() => Number(/\?v=(\d+)$/.exec(window.__app.map.getSource('garmin').tiles?.[0] ?? '')?.[1] ?? 0));
  const before = await opfs();
  console.log('OPFS after the first start:', JSON.stringify(before));
  if (!before.pointer || !before.names.includes(`${before.pointer.dir}/`)) fail(`no committed map dir: ${JSON.stringify(before)}`);
  if (mapDirs(before).length !== 1 || setDirs(before).length !== 1) fail(`first start: expected one map and one elevation set, got ${JSON.stringify(before)}`);
  const buttonShown = () => page.$eval('#maps-button', (b) => !b.closest('.maplibregl-ctrl').hidden);
  if (await buttonShown()) fail('map button shown with one map and one set');
  await page.click('#menu-button');
  await page.click('#settings-open');
  await page.click('#settings-map');
  await page.waitForSelector('#maps-panel:not([hidden]) #maps-add', { timeout: 10_000 });
  if (await page.$('#maps-panel.standalone')) fail('the Maps panel over the map is the first-start one');
  const panelText = await page.$eval('#maps-panel', (e) => e.innerText);
  if (!/Iceland GPSmap\.is 2024\.21 Detailed/.test(panelText) || !/3″ elevation · 48 files/.test(panelText) || !/used by 1 map/.test(panelText)) fail(`maps panel: ${panelText}`);

  // 7. A second map from "Add a map" (the file browser): kept beside the first, shown in place with
  //    the stored set (it covers the map), named after its file.
  const g0 = await tileGen();
  const t1 = Date.now();
  await (await page.$('#maps-add-input')).uploadFile(IMG2);
  await page.waitForSelector('#map-note:not([hidden])', { timeout: 600_000 }).catch(async () => fail(`adding a map: ${await page.$eval('#maps-panel', (e) => e.innerText)}`));
  console.log(`adding a map took ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  if (!(await page.$('#maps-panel[hidden]'))) fail('the Maps panel stayed open over the added map');
  if (!/Focused/.test(await page.$eval('#map-note', (e) => e.innerText))) fail('the note does not name the added map');
  const two = await opfs();
  console.log('OPFS with two maps:', JSON.stringify(two));
  if (mapDirs(two).length !== 2 || setDirs(two).length !== 1 || two.pointer.dir === before.pointer.dir) fail(`expected two maps and one set: ${JSON.stringify(two)}`);
  const focusedDir = two.pointer.dir;
  const g1 = await tileGen();
  if (g1 <= g0) fail('the added map was not shown in place');
  if (!(await page.evaluate(() => !!window.__app.map.getSource('dem')))) fail('the added map has no hillshading from the stored set');
  if (!(await buttonShown())) fail('map button hidden with two maps');
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });

  // Switching from the map button keeps the place and zoom, the app's own layers and icons, and
  // says which map it is with Undo.
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; m.jumpTo({ center: [-19.06, 63.99], zoom: 12 }); m.once('idle', r); }));
  const view = () => page.evaluate(() => { const m = window.__app.map; const c = m.getCenter(); return { lon: +c.lng.toFixed(6), lat: +c.lat.toFixed(6), zoom: +m.getZoom().toFixed(4) }; });
  const v0 = await view();
  await page.click('#maps-button');
  await page.waitForSelector('#map-picker:not([hidden]) [role="menuitemradio"]', { timeout: 10_000 });
  const pickerRows = await page.$$eval('#map-picker [role="menuitemradio"]', (rs) => rs.map((r) => ({ text: r.textContent, on: r.getAttribute('aria-checked') })));
  if (pickerRows.length !== 2 || pickerRows.find((r) => r.on === 'true')?.text?.includes('Focused') !== true) fail(`map picker: ${JSON.stringify(pickerRows)}`);
  await page.screenshot({ path: `${OUT}maps-picker.png` });
  await page.evaluate(() => [...document.querySelectorAll('#map-picker [role="menuitemradio"]')].find((r) => r.textContent.includes('Detailed')).click());
  await page.waitForFunction(() => !document.querySelector('#map-note').hidden && /Detailed/.test(document.querySelector('#map-note').innerText), { timeout: 60_000 });
  await page.evaluate(() => new Promise((r) => window.__app.map.once('idle', r)));
  const v1 = await view();
  if (JSON.stringify(v0) !== JSON.stringify(v1)) fail(`switching moved the map: ${JSON.stringify(v0)} → ${JSON.stringify(v1)}`);
  const afterSwitch = await page.evaluate(() => {
    const m = window.__app.map;
    return { tiles: m.getSource('garmin').tiles?.[0], dem: !!m.getSource('dem'), star: m.hasImage('saved-star'), pins: !!m.getLayer('saved-pins'), note: document.querySelector('#map-note').innerText };
  });
  console.log('after switching:', JSON.stringify(afterSwitch));
  if (!afterSwitch.tiles?.endsWith(`?v=${g1 + 1}`) || !afterSwitch.dem || !afterSwitch.star || !afterSwitch.pins || !/Detailed/.test(afterSwitch.note)) fail(`switch: ${JSON.stringify(afterSwitch)}`);
  if ((await opfs()).pointer.dir !== before.pointer.dir) fail('switching did not make the map current');
  await page.screenshot({ path: `${OUT}maps-switched.png` });
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  if (!(await page.evaluate(() => window.__app.search('landmannalaugar').length > 0))) fail('search found nothing after switching');
  // Undo goes back.
  await page.click('#map-note-undo');
  await page.waitForFunction((g) => window.__app.map.getSource('garmin').tiles?.[0]?.endsWith(`?v=${g}`), { timeout: 60_000 }, g1 + 2);
  // The picker, still open, follows.
  await page.waitForFunction(() => document.querySelector('#map-picker [role="menuitemradio"][aria-checked="true"]')?.textContent.includes('Focused'), { timeout: 10_000 })
    .catch(() => fail('the map picker did not follow Undo'));
  if ((await opfs()).pointer.dir !== focusedDir) fail('Undo did not go back to the map before');
  console.log('switch and undo ok');

  // Hillshading Off and on again from the picker (the choice is the map's).
  await page.waitForSelector('#map-picker:not([hidden]) .seg', { timeout: 10_000 });
  await page.evaluate(() => [...document.querySelectorAll('#map-picker .seg button')].find((b) => b.textContent === 'Off').click());
  await page.waitForFunction(() => !window.__app.map.getSource('dem'), { timeout: 60_000 }).catch(() => fail('hillshading Off left the hillshade'));
  if ((await opfs()).choices?.maps?.[focusedDir]?.elevation !== null) fail('hillshading Off not remembered for the map');
  await page.waitForFunction(() => [...document.querySelectorAll('#map-picker .seg button')].some((b) => b.textContent === 'Off' && b.getAttribute('aria-checked') === 'true'), { timeout: 10_000 });
  await page.evaluate(() => [...document.querySelectorAll('#map-picker .seg button')].find((b) => b.textContent !== 'Off').click());
  await page.waitForFunction(() => !!window.__app.map.getSource('dem'), { timeout: 60_000 }).catch(() => fail('hillshading did not come back'));
  await page.evaluate(() => document.querySelector('#map-picker .close').click()); // it may be drawn again meanwhile
  console.log('hillshading off and on ok');

  // Details: rename, then remove the map shown (the other one is shown instead).
  await page.click('#menu-button');
  await page.click('#maps-open');
  await page.waitForSelector('#maps-panel:not([hidden]) .map-row', { timeout: 10_000 });
  await page.screenshot({ path: `${OUT}maps-panel.png` });
  await page.evaluate(() => [...document.querySelectorAll('#maps-panel .map-row .row:not(.pick)')].find((r) => r.textContent.includes('Focused')).click());
  await page.waitForSelector('#map-rename', { timeout: 10_000 });
  await page.screenshot({ path: `${OUT}maps-details.png` });
  await page.click('#map-rename');
  // The name is focused and selected: typing replaces it.
  await page.waitForFunction(() => document.activeElement?.matches('#maps-panel .rename-form input'), { timeout: 5_000 }).catch(() => fail('the name field did not take focus'));
  await page.keyboard.type('Hálendið');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#maps-panel .title')?.textContent === 'Hálendið', { timeout: 10_000 })
    .catch(async () => fail(`rename did not show: ${await page.$eval('#maps-panel', (e) => e.innerText.replace(/\s+/g, ' '))}`));
  if ((await opfs()).choices?.maps?.[focusedDir]?.name !== 'Hálendið') fail('rename not stored');
  if (!(await page.$eval('#map-file', (e) => e.textContent === 'Hálendið'))) fail('Settings does not show the new name');
  page.once('dialog', (d) => d.accept());
  await page.click('#map-remove');
  await page.waitForFunction((dir) => !document.querySelector('#maps-panel').innerText.includes('Hálendið'), { timeout: 60_000 }, focusedDir).catch(() => fail('removed map still listed'));
  const one = await opfs();
  if (mapDirs(one).length !== 1 || one.pointer.dir !== before.pointer.dir || setDirs(one).length !== 1) fail(`after removing: ${JSON.stringify(one)}`);
  if (!(await page.evaluate(() => !!window.__app.map.getSource('dem')))) fail('hillshade missing after removing the other map');
  if (await buttonShown()) fail('map button still shown with one map');
  await page.evaluate(() => document.querySelector('#maps-panel .close').click());
  console.log('rename and remove ok:', JSON.stringify(one));

  // 8. An older version's layout: one map in `garmin/` (no pointer) with its elevation inside
  //    (dem/, dem-overview.bin, the names in meta.json). It opens with its hillshading, which
  //    becomes a set where it is. Let the viewer finish its place index first (it writes places.json).
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  await page.evaluate(async (dir, set) => {
    const root = await navigator.storage.getDirectory();
    const copy = async (from, to) => {
      for await (const [name, h] of from.entries()) {
        if (h.kind !== 'file' || name === 'set.json') continue;
        const w = await (await to.getFileHandle(name === 'overview.bin' ? 'dem-overview.bin' : name, { create: true })).createWritable();
        await w.write(await h.getFile());
        await w.close();
      }
    };
    const dst = await root.getDirectoryHandle('garmin', { create: true });
    await copy(await root.getDirectoryHandle(dir), dst);
    const dem = await dst.getDirectoryHandle('dem', { create: true });
    const setDir = await root.getDirectoryHandle(set);
    const names = [];
    for await (const [name, h] of setDir.entries()) if (h.kind === 'file' && name.endsWith('.hgt')) names.push(name);
    for (const name of names) {
      const w = await (await dem.getFileHandle(name, { create: true })).createWritable();
      await w.write(await (await setDir.getFileHandle(name)).getFile());
      await w.close();
    }
    // The overview stood beside the map in older versions.
    const ov = await dst.getFileHandle('dem-overview.bin', { create: true }).then((h) => h.createWritable());
    await ov.write(await (await setDir.getFileHandle('overview.bin')).getFile());
    await ov.close();
    const metaH = await dst.getFileHandle('meta.json');
    const meta = JSON.parse(await (await metaH.getFile()).text());
    delete meta.bounds;
    const mw = await metaH.createWritable();
    await mw.write(JSON.stringify({ ...meta, hgtNames: names.sort(), hasOverview: true }));
    await mw.close();
    for (const n of ['current.json', 'maps.json']) await root.removeEntry(n).catch(() => {});
    await root.removeEntry(dir, { recursive: true });
    await root.removeEntry(set, { recursive: true });
  }, one.pointer.dir, setDirs(one)[0].replace(/\/$/, ''));
  await page.reload();
  await waitReady();
  if (await page.$('#maps-panel.standalone')) fail('older layout: map not loaded');
  if (!(await page.evaluate(() => !!window.__app.map.getSource('dem')))) fail('older layout: hillshading lost');
  const upgraded = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dem = await (await root.getDirectoryHandle('garmin')).getDirectoryHandle('dem');
    return JSON.parse(await (await (await dem.getFileHandle('set.json')).getFile()).text());
  }).catch((e) => fail(`older layout: no dem/set.json (${e.message})`));
  if (upgraded.files.length !== 48 || upgraded.name !== '3″ elevation · 48 files') fail(`older layout: set ${JSON.stringify(upgraded)}`);
  console.log('older layout upgraded:', JSON.stringify(await opfs()));

  // 9. an empty (interrupted) pointer still resolves to the stored map
  await page.waitForFunction(() => window.__app?.placesReady === true, { timeout: 600_000 });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const w = await (await root.getFileHandle('current.json', { create: true })).createWritable();
    await w.truncate(0);
    await w.close();
  });
  await page.reload();
  await waitReady();
  if (await page.$('#maps-panel.standalone')) fail('empty pointer lost the stored map');
  console.log('empty pointer falls back ok');

  // 10. A new version deployed while the app is open (sw.js with a later build): coming back into
  // view installs it and the notice offers Reload, which then works offline too (the new version is
  // fully cached before it takes over). (Not checking when offline is a unit test: puppeteer's offline
  // mode covers the page, not the service worker's own fetches.)
  swBuilt = await readFile(SW, 'utf8');
  const newer = swBuilt
    .replace(/const CACHE = "garmin-app-[0-9a-f]+"/, 'const CACHE = "garmin-app-e2e000newer"')
    .replace(/const BUILD = (\{[^;]*\});/, (_, b) => `const BUILD = ${JSON.stringify({ ...JSON.parse(b), builtAt: '2999-01-01T00:00:00.000Z' })};`);
  if (newer === swBuilt || !newer.includes('2999-01-01')) fail('could not stamp a newer sw.js');
  await writeFile(SW, newer);
  if (!(await page.$eval('#update', (e) => e.hidden))) fail('update notice before there was a new version');
  // The app coming back into view (as when switching back to it on a phone) is when it checks.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => !document.querySelector('#update').hidden, { timeout: 30_000 }).catch(() => fail('no notice after a new version was installed'));
  await page.screenshot({ path: `${OUT}update-notice.png` });
  await page.click('#update-close');
  if (await page.$eval('#update', (e) => getComputedStyle(e).display !== 'none')) fail('× did not hide the update notice');
  await page.setOfflineMode(true);
  await page.reload();
  await waitReady();
  // (This test's newer worker holds the same page, so it is still "new": told again at start.)
  await page.waitForFunction(() => !document.querySelector('#update').hidden, { timeout: 10_000 }).catch(() => fail('a newer version already in control at start was not told'));
  await page.setOfflineMode(false);
  console.log('update notice ok');

  // 11. Recording a trip (in the Android app; here the app's part is played by the test): no record
  // button in a browser; in the app the button sits left of save-a-pin; Record asks the app to start
  // and shows the pill and the way so far; Stop asks it to stop. A trip handed over in the address
  // is kept in Tracks at once and offered for naming; the same trip twice is kept once; Discard asks
  // again; left alone the card closes after 30 s with a quiet note; an empty trip only says so; a
  // trip in the address at startup comes in too.
  if (await page.$('#map .trip-record')) fail('record button outside the Android app');
  await page.evaluate(() => localStorage.setItem('android-app', 'is.atlipall.garminmap'));
  await page.reload();
  await waitReady();
  await page.waitForSelector('#map .trip-record-button', { timeout: 10_000 }).catch(() => fail('no record button in the Android app'));
  if ((await page.$eval('.locate-button', (e) => e.dataset.state)) === 'off') await page.click('.locate-button');
  await gps.send('Emulation.setGeolocationOverride', { latitude: 64.11, longitude: -21.89, accuracy: 8 });
  await page.waitForFunction(() => !document.querySelector('#map .save-here').hidden, { timeout: 10_000 });
  const tripPlace = await page.evaluate(() => {
    const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top }; };
    return { rec: r('#map .trip-record'), pin: r('#map .save-here') };
  });
  if (!(tripPlace.rec.right <= tripPlace.pin.left + 1 && Math.abs(tripPlace.rec.top - tripPlace.pin.top) < 2)) fail(`record button not left of save-a-pin: ${JSON.stringify(tripPlace)}`);
  // Record asks the app; nothing shows as recording until the app says it records.
  const appLink = (what) => `intent://trip/${what}#Intent;scheme=garminmap;package=is.atlipall.garminmap;S.browser_fallback_url=${encodeURIComponent(`http://localhost:${PORT}/#trip-failed=old-app`)};end`;
  await page.click('#map .trip-record-button');
  const recAsked = await page.evaluate(() => ({ intent: window.__app.lastIntent, pill: !document.querySelector('#trip-pill').hidden }));
  if (recAsked.intent !== appLink('start') || recAsked.pill) fail(`record asked: ${JSON.stringify(recAsked)}`);
  // No answer (an app that can't record): a note after 10 s.
  await page.waitForFunction(() => /didn't start recording/.test(document.querySelector('#trip-note-text').textContent) && !document.querySelector('#trip-note').hidden, { timeout: 15_000 }).catch(() => fail('no note when the app did not answer'));
  // The app's answers: precise location refused; too old (Chrome's fallback); recording.
  await page.evaluate(() => (location.hash = '#trip-failed=location'));
  await page.waitForFunction(() => /needs precise location/.test(document.querySelector('#trip-note-text').textContent), { timeout: 5_000 }).catch(() => fail('location refused'));
  await page.evaluate(() => (location.hash = '#trip-failed=old-app'));
  await page.waitForFunction(() => /newest version of the Android app/.test(document.querySelector('#trip-note-text').textContent), { timeout: 5_000 }).catch(() => fail('old app'));
  await page.click('#map .trip-record-button');
  await page.evaluate((t) => (location.hash = `#trip-recording=${t}`), Date.now());
  await page.waitForFunction(() => !document.querySelector('#trip-pill').hidden, { timeout: 5_000 }).catch(() => fail('no pill once the app records'));
  const tripStarted = await page.evaluate(() => ({ text: document.querySelector('#trip-pill-text').textContent, label: document.querySelector('#map .trip-record-button').getAttribute('aria-label'), hash: location.hash }));
  if (tripStarted.text !== '0.0 km · 0 min' || tripStarted.label !== 'Stop recording' || tripStarted.hash !== '') fail(`recording: ${JSON.stringify(tripStarted)}`);
  for (let k = 1; k <= 6; k++) {
    await gps.send('Emulation.setGeolocationOverride', { latitude: 64.11 + k * 0.0009, longitude: -21.89, accuracy: 8 });
    await new Promise((r) => setTimeout(r, 400));
  }
  const tripLive = await page.evaluate(() => ({ text: document.querySelector('#trip-pill-text').textContent, line: window.__app.map.getStyle().sources['trip-live'].data.features[0]?.geometry.coordinates.length ?? 0 }));
  if (tripLive.text !== '0.5 km · 0 min' || tripLive.line !== 6) fail(`recording: ${JSON.stringify(tripLive)}`);
  await page.screenshot({ path: `${OUT}trip-recording.png` });
  // Kept over a reload (the app goes on recording whatever the map does).
  await page.reload();
  await waitReady();
  await page.waitForSelector('#map .trip-record-button.recording', { timeout: 10_000 }).catch(() => fail('recording state lost on reload'));
  // In the Android app on a big screen (a head unit) the controls and cards are drawn 1.5 times
  // bigger (the map controls' own size depends on a touch screen, which this Chrome isn't).
  const carZoom = await page.evaluate(() => ['#menu-button', '#map .trip-record-button', '#map .locate-button', '#trip-pill'].map((q) => document.querySelector(q).currentCSSZoom));
  const menuButton = await page.$eval('#menu-button', (e) => Math.round(e.getBoundingClientRect().width));
  if (carZoom.some((z) => z !== 1.5) || menuButton !== 66) fail(`car-sized controls in the Android app on a big screen: zoom ${carZoom}, menu button ${menuButton} px`);
  console.log('car-sized controls ok');
  // The Android app's "Reload from the server": the page loads again, into the map.
  await page.click('#menu-button');
  await page.click('#settings-open');
  if (await page.$eval('#reload-app', (e) => e.hidden)) fail('no "Reload from the server" in the Android app');
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click('#reload-app')]);
  await waitReady();
  console.log('reload from the server ok');
  await page.click('#map .trip-record-button');
  const tripStopped = await page.evaluate(() => ({ intent: window.__app.lastIntent, pill: !document.querySelector('#trip-pill').hidden, line: window.__app.map.getStyle().sources['trip-live'].data.features.length }));
  if (tripStopped.intent !== appLink('stop') || tripStopped.pill || tripStopped.line) fail(`stop: ${JSON.stringify(tripStopped)}`);
  // The app's hand-over: the address fragment Trip.java writes (encoded polyline, %-escaped).
  const tripEnc = (v, out) => { let x = v < 0 ? ~(v * 2) : v * 2; while (x >= 0x20) { out.push(String.fromCharCode((0x20 | (x & 0x1f)) + 63)); x = Math.floor(x / 32); } out.push(String.fromCharCode(x + 63)); };
  const tripHash = (start, n) => {
    const c = [], t = [];
    let pl = 0, po = 0, pt = Math.floor(start / 1000);
    for (let k = 0; k < n; k++) {
      const la = Math.round((64.11 + k * 0.00014) * 1e5), lo = Math.round(-21.89 * 1e5), ts = pt + 1;
      tripEnc(la - pl, c); tripEnc(lo - po, c); tripEnc(ts - pt, t);
      pl = la; po = lo; pt = ts;
    }
    const esc = (a) => a.join('').replace(/[^A-Za-z?@_~]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    return `#trip=1.${start}.${start + n * 1000}.${esc(c)}.${esc(t)}`;
  };
  const tripTracks = () => page.evaluate(() => window.__app.tracks.all.map((t) => ({ id: t.id, name: t.name })));
  const tripsBefore = (await tripTracks()).length;
  const tripT0 = Date.UTC(2026, 9, 5, 14, 20);
  await page.evaluate((h) => (location.hash = h), tripHash(tripT0, 120));
  await page.waitForFunction(() => !document.querySelector('#trip-card').hidden, { timeout: 10_000 }).catch(() => fail('no save card for a handed-over trip'));
  const tripCard = await page.evaluate(() => ({ name: document.querySelector('#trip-name').value, sub: document.querySelector('#trip-sub').textContent, hash: location.hash }));
  if (!/^Drive 5 Oct, \d\d:20–\d\d:22$/.test(tripCard.name) || !/^1\.9 km · 2 min · \d\d:20–\d\d:22$/.test(tripCard.sub) || tripCard.hash !== '') fail(`trip card: ${JSON.stringify(tripCard)}`);
  if ((await tripTracks()).length !== tripsBefore + 1) fail('trip not kept in Tracks at once');
  await page.screenshot({ path: `${OUT}trip-card.png` });
  await page.click('#trip-name', { count: 3 });
  await page.evaluate(() => document.querySelector('#trip-name').select());
  await page.keyboard.type('Home to work');
  await page.click('#trip-form button.primary');
  await page.waitForFunction(() => document.querySelector('#trip-card').hidden && document.querySelector('#trip-note-text').textContent === 'Saved to Tracks: Home to work', { timeout: 5_000 }).catch(() => fail('naming the trip'));
  if (!(await tripTracks()).some((t) => t.name === 'Home to work')) fail('trip name not kept');
  // The same trip again (a reload of the hand-over): kept once, no card.
  await page.evaluate((h) => (location.hash = h), tripHash(tripT0, 120));
  await new Promise((r) => setTimeout(r, 800));
  if ((await tripTracks()).length !== tripsBefore + 1 || !(await page.$eval('#trip-card', (e) => e.hidden))) fail('the same trip kept twice');
  // Discard asks again, then deletes.
  await page.evaluate((h) => (location.hash = h), tripHash(tripT0 + 3_600_000, 60));
  await page.waitForFunction(() => !document.querySelector('#trip-card').hidden, { timeout: 10_000 });
  await page.click('#trip-discard');
  if ((await page.$eval('#trip-discard', (e) => e.textContent)) !== 'Delete trip?' || (await tripTracks()).length !== tripsBefore + 2) fail('Discard did not ask again');
  await page.click('#trip-discard');
  await page.waitForFunction((n) => window.__app.tracks.all.length === n && document.querySelector('#trip-note-text').textContent === 'Trip deleted.', { timeout: 5_000 }, tripsBefore + 1).catch(() => fail('Discard did not delete the trip'));
  // Left alone: the card closes after 30 s, the trip kept under its suggested name.
  await page.evaluate((h) => (location.hash = h), tripHash(tripT0 + 7_200_000, 60));
  await page.waitForFunction(() => !document.querySelector('#trip-card').hidden, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#trip-card').hidden, { timeout: 35_000, polling: 1000 }).catch(() => fail('the card did not close by itself'));
  const tripQuiet = await page.$eval('#trip-note-text', (e) => e.textContent);
  if (!/^Saved to Tracks: Drive 5 Oct, \d\d:20–\d\d:21$/.test(tripQuiet) || (await tripTracks()).length !== tripsBefore + 2) fail(`auto-save: ${tripQuiet}`);
  // An empty trip only says so.
  await page.evaluate(() => (location.hash = '#trip=1.5.9..'));
  await page.waitForFunction(() => /^Nothing was recorded/.test(document.querySelector('#trip-note-text').textContent), { timeout: 5_000 }).catch(() => fail('empty trip'));
  // A trip in the address when the map starts (the app opened it with one).
  await page.goto(`http://localhost:${PORT}/${tripHash(tripT0 + 10_800_000, 30)}`);
  await waitReady();
  await page.waitForFunction(() => !document.querySelector('#trip-card').hidden, { timeout: 15_000 }).catch(() => fail('trip at startup not taken in'));
  if ((await tripTracks()).length !== tripsBefore + 3) fail('trip at startup not kept');
  await page.evaluate(() => localStorage.removeItem('android-app'));
  console.log('trip recording ok');
} finally {
  if (swBuilt) await writeFile(SW, swBuilt);
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
