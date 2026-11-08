import type { MapInfo } from './server';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The server's front page: its maps, each with a live widget and the code to put it on a page. */
export function demoPage(maps: MapInfo[], base: string): string {
  const items = maps
    .map((m) => {
      const [w, s, e, n] = m.bounds;
      const center = `${((s + n) / 2).toFixed(4)},${((w + e) / 2).toFixed(4)}`;
      const code = `<script type="module" src="${base}/widget.js"></script>\n<div data-img-map="${m.id}" data-center="${center}" data-zoom="7" style="height: 400px"></div>`;
      return `<section>
  <h2>${esc(m.name)}</h2>
  <p class="meta"><code>${esc(m.id)}</code>${m.terrain ? ' · with hillshading' : ''} · <a href="${esc(m.style)}">style.json</a></p>
  <div class="map" data-img-map="${esc(m.id)}" data-center="${center}" data-zoom="7"></div>
  <pre>${esc(code)}</pre>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Map server</title>
<link rel="icon" href="data:,">
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 900px; padding: 24px; color: #1a1a1a; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 32px 0 0; }
  .meta { margin: 0 0 8px; color: #555; font-size: 14px; }
  .map { height: 400px; border-radius: 8px; overflow: hidden; }
  pre { background: #f3f3f3; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; }
</style>
<script type="module" src="${esc(`${base}/widget.js`)}"></script>
</head>
<body>
<h1>Map server</h1>
<p>${maps.length ? `${maps.length} map${maps.length === 1 ? '' : 's'}. To show one on a web page, copy its code.` : 'No maps found. Put .img files in the maps folder and restart the server.'}</p>
${items}
</body>
</html>
`;
}
