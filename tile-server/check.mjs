// Headless-Chrome check of the built tile server (npm run build first): runs it on the
// GPSmap.is package, embeds the widget in a page from another origin (as a web site would), and
// checks the map draws with its icons and hillshading. Screenshots go to check-output/.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const OUT = HERE + 'check-output/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAP_PORT = 8097;
const PAGE_PORT = 8096;
const ID = 'iceland-gpsmap-is-2024-21-detailed';
const fail = (msg) => {
  throw new Error(`TILE SERVER CHECK FAILED: ${msg}`);
};

await mkdir(OUT, { recursive: true });
const maps = await mkdtemp(join(tmpdir(), 'tile-server-'));
await symlink(REPO + 'GPSmap.is 2024.21 Android', join(maps, 'gpsmap'));

let site;
let browser;
const server = spawn(process.execPath, [HERE + 'dist/server.mjs', '--maps', maps, '--port', String(MAP_PORT), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('Listening') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited (${code})`)));
  });

  // A web site somewhere else that shows two maps: one from its data- attributes, one from its code.
  site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body style="margin:0;font-family:sans-serif">
<script type="module" src="http://127.0.0.1:${MAP_PORT}/widget.js"></script>
<div id="a" data-img-map="${ID}" data-center="64.1466,-21.9426" data-zoom="12" style="height:420px"></div>
<div id="b" style="height:420px"></div>
<script type="module">
  window.mapB = await ImgMap.mount(document.getElementById('b'), { map: '${ID}', center: [64.02, -16.9], zoom: 10, cooperativeGestures: false });
  new ImgMap.maplibregl.Marker().setLngLat([-16.9, 64.02]).addTo(window.mapB);
</script>
<script>
  document.getElementById('a').addEventListener('mapready', (e) => (window.mapA = e.detail.map));
</script>
</body></html>`);
  });
  await new Promise((r) => site.listen(PAGE_PORT, '127.0.0.1', r));

  const problems = [];
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  page.on('console', (m) => ['error', 'warn'].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()}: ${r.url()}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  await page.setViewport({ width: 900, height: 860 });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);

  const settled = (name) =>
    page.waitForFunction((n) => window[n]?.loaded() && window[n].areTilesLoaded() && !window[n].isMoving(), { timeout: 60_000, polling: 250 }, name);
  await settled('mapA');
  await settled('mapB');
  await new Promise((r) => setTimeout(r, 1000));

  const report = await page.evaluate(() => {
    const look = (map) => {
      const fs = map.queryRenderedFeatures();
      return {
        features: fs.length,
        layers: [...new Set(fs.map((f) => f.layer.id))],
        icons: fs.filter((f) => f.layer.id === 'poi-icons').length,
        hillshade: !!map.getLayer('hillshade') && map.getSource('dem')?.loaded(),
        attribution: !!map.getContainer().querySelector('.maplibregl-ctrl-attrib'),
      };
    };
    return { a: look(window.mapA), b: look(window.mapB), zoomButtons: [...document.querySelectorAll('.maplibregl-ctrl-zoom-in')].length };
  });
  console.log(JSON.stringify(report, null, 1));
  if (report.a.features < 50) fail(`the Reykjavík map drew ${report.a.features} features`);
  if (report.b.features < 10) fail(`the second map drew ${report.b.features} features`);
  if (!report.a.layers.some((l) => l.startsWith('pg-'))) fail('no areas drawn');
  if (!report.a.layers.some((l) => l.startsWith('ln-'))) fail('no lines (roads) drawn');
  if (!report.a.hillshade || !report.b.hillshade) fail('no hillshading');
  if (report.zoomButtons !== 2) fail(`expected two sets of zoom buttons, found ${report.zoomButtons}`);
  await page.screenshot({ path: OUT + 'tile-server-embed.png' });

  // Drag the second map (its cooperative gestures are off) and zoom with its + button: headless
  // Chrome's synthetic wheel and double-click don't reach MapLibre.
  const box = await (await page.$('#b canvas')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 100, { steps: 10 });
  await page.mouse.up();
  await page.click('#b .maplibregl-ctrl-zoom-in');
  await new Promise((r) => setTimeout(r, 800));
  await settled('mapB');
  const after = await page.evaluate(() => ({ center: window.mapB.getCenter().toArray(), zoom: window.mapB.getZoom() }));
  console.log('after pan and zoom:', JSON.stringify(after));
  if (after.center[0] <= -16.9 || after.zoom < 10.9) fail('pan or zoom did nothing');
  await page.screenshot({ path: OUT + 'tile-server-embed-moved.png' });

  // A page opened straight from a file, which can't start a module worker from another address.
  const filePage = join(maps, 'page.html');
  await writeFile(filePage, `<!doctype html><script type="module" src="http://127.0.0.1:${MAP_PORT}/widget.js"></script>
<div id="f" data-img-map="${ID}" data-center="64.1466,-21.9426" data-zoom="12" style="height:400px"></div>
<script>document.getElementById('f').addEventListener('mapready', (e) => (window.mapF = e.detail.map));</script>`);
  await page.goto(`file://${filePage}`);
  await settled('mapF');
  const fromFile = await page.evaluate(() => window.mapF.queryRenderedFeatures().length);
  console.log('page from a file:', fromFile, 'features');
  if (fromFile < 50) fail(`the page opened from a file drew ${fromFile} features`);

  // The server's own front page.
  await page.goto(`http://127.0.0.1:${MAP_PORT}/`);
  await page.waitForSelector('.maplibregl-canvas', { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: OUT + 'tile-server-front.png' });

  const real = problems.filter((p) => !/GPU stall|WebGL|swiftshader/i.test(p));
  if (real.length) fail(`browser reported:\n  ${real.join('\n  ')}`);
  console.log('tile server check passed; screenshots in', OUT);
} finally {
  await browser?.close();
  site?.close();
  server.kill();
  await rm(maps, { recursive: true, force: true });
}
