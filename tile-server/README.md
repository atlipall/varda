# Tile server

Puts Garmin `.img` maps on web pages. You run the server where your map files are; it turns them
into map tiles as they're asked for, and gives web pages a small script that shows the map with
pan, zoom and hillshading. The map files stay on the server; browsers only get the tiles they show.

It reads the same maps a Garmin GPS does: the map's own style file (TYP) is used for colours,
patterns and icons, and SRTM `.hgt` elevation files give hillshading.

## Running it

You need Node.js 22 or newer.

```bash
cd tile-server
npm install
npm run build                      # builds dist/
node dist/server.mjs --maps /path/to/maps
```

Then open <http://localhost:8080/>: it lists your maps, each with a live preview and the code to put
it on a page.

`dist/` is all it needs to run: copy that folder to your server, there's nothing to
install there.

### The maps folder

```
maps/
├── Some map.img                  ← a map without hillshading
└── Iceland/                      ← a folder: its maps share its elevation files
    ├── Iceland Detailed.img
    ├── Iceland Topo.img
    └── DEM/
        ├── n63w014.hgt
        └── …
```

Every `.img` file is a map, called by its file name in lower case with dashes
(`Iceland Detailed.img` → `iceland-detailed`). The `.img` files in a subfolder get hillshading from
the `.hgt` files anywhere in that subfolder (1201×1201 SRTM3 files, named like `n64w019.hgt`).
Symbolic links are followed, so you can link a map package in instead of copying it. Restart the
server after changing the folder.

### Options

| Option | Environment | Default | |
|---|---|---|---|
| `--maps` | `MAPS` | `./maps` | The maps folder |
| `--port` | `PORT` | `8080` | |
| `--host` | `HOST` | `0.0.0.0` | |
| `--origins` | `ORIGINS` | `*` (any) | Web sites allowed to show the maps, comma separated: `https://example.com,https://www.example.com` |
| `--public-url` | `PUBLIC_URL` | from the request | The server's address as people reach it (`https://maps.example.com`) |
| `--trust-proxy` | `TRUST_PROXY=1` | off | Take that address from the `X-Forwarded-Host` and `X-Forwarded-Proto` headers a proxy in front sets. Only behind such a proxy: anyone can send them |
| `--cache-mb` | `CACHE_MB` | `256` | Memory for tiles already built. Each map also keeps up to roughly 100 MB of decoded map data |

`--origins` only stops other web sites' pages from using the maps in a browser. Anyone who can reach
the server can still download tiles, so put it behind a login or a private network if the maps
mustn't be public.

### On a server

Run it behind the web server you already have (nginx, Caddy, Apache) for HTTPS, for example with
Caddy:

```
maps.example.com {
  reverse_proxy localhost:8080
}
```

and keep it running with systemd:

```ini
[Service]
ExecStart=/usr/bin/node /opt/tile-server/server.mjs --maps /srv/maps --host 127.0.0.1 --trust-proxy --origins https://example.com
Restart=always
```

## On a web page

```html
<script type="module" src="https://maps.example.com/widget.js"></script>

<div data-img-map="iceland-detailed" data-center="64.1466,-21.9426" data-zoom="12" style="height: 400px"></div>
```

| Attribute | |
|---|---|
| `data-img-map` | The map (as listed on the server's front page or at `/maps`) |
| `data-center` | Latitude, longitude. Without it, the whole map is shown |
| `data-zoom` | 4 (a country) to 18 (a street). Default 10 |
| `data-cooperative="false"` | Scrolling over the map zooms it. By default the page scrolls, and the map zooms with Ctrl/⌘ + scroll or two fingers |

The page can be anywhere: on any web site, or an .html file opened straight from disk.

Each map fires `mapready` with the map in `event.detail.map`, or `maperror`.

From your own code:

```html
<div id="map" style="height: 400px"></div>
<script type="module">
  import 'https://maps.example.com/widget.js';
  const map = await ImgMap.mount(document.getElementById('map'), { map: 'iceland-detailed', center: [64.15, -21.94], zoom: 12 });
  new ImgMap.maplibregl.Marker().setLngLat([-21.94, 64.15]).addTo(map);
</script>
```

`map` is a [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) map, and `ImgMap.maplibregl`
is MapLibre itself, for markers, popups, your own layers and so on. If you load the map in a page
with a Content Security Policy, allow the server in `script-src`, `connect-src` and `img-src`, and
`blob:` in `worker-src`.

### With your own MapLibre

Each map has a standard style, so you can use it without the widget, in MapLibre GL JS or any
other app that reads MapLibre styles:

```js
new maplibregl.Map({ container: 'map', style: 'https://maps.example.com/maps/iceland-detailed/style.json' });
```

## What the server serves

| Address | |
|---|---|
| `/` | The maps, with previews and code to copy |
| `/maps` | The maps as JSON: id, name, bounds, whether they have hillshading, the credit their licence asks for |
| `/maps/<id>` | One map, as above |
| `/maps/<id>/style.json` | A MapLibre style |
| `/maps/<id>/tiles/<z>/<x>/<y>.pbf` | Vector tiles, zoom 4 to 14 (MapLibre enlarges them beyond 14) |
| `/maps/<id>/terrain/<z>/<x>/<y>.png` | Terrain-RGB elevation tiles, for hillshading |
| `/maps/<id>/sprite.json`, `.png` | The map's icons and patterns |
| `/widget.js` | The widget |
| `/fonts/…` | Label fonts (Noto Sans) |

A tile is built the first time it's asked for (about 20–100 ms) and kept in memory; browsers keep
tiles for a day. The elevation files are read once when the server starts (a few seconds). Tiles are built one after another in a single process, which is plenty for a web
site's map; for a busy site, put a caching proxy or CDN in front.

## Map licences

Putting a map on a web page publishes it. Only serve maps whose licence lets you do that. A map
that asks for credit (such as Freizeitkarte's OpenStreetMap maps) gets it in the corner of the map
when the server recognises it; for others, add the credit to your page.

## Development

The server reads maps with the same code as the Varda app in this repository (`../web/src/img`,
`tiles`, `style`, `dem`). The packages that code uses come from this folder's `node_modules`
(`resolve.mjs`), so the app's packages don't need installing.

```bash
npm run build                         # dist/
npm test                              # unit tests; the real-map ones need the GPSmap.is package
npm run typecheck
npm run check                         # headless-Chrome check on the GPSmap.is package (macOS Chrome), screenshots in check-output/
```
