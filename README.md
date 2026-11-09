# Varda

Garmin maps, in your browser.

A web app that shows Garmin `.img` maps (such as GPSmap.is Iceland) on iPhone, Mac and Android car head units,
drawn straight from the map file in the browser and fully offline: hillshading from SRTM `.hgt` files, place
search, GPS follow with heading-up and ground height, GPX tracks, route planning by road with turn-by-turn
navigation, saved places, and optional Google Drive sync.

Live at <https://vardamaps.app/> (instructions) and <https://vardamaps.app/app/> (the app). The map and elevation files stay on the user's device; nothing is uploaded.
Free and open source under the [MIT License](LICENSE).

## Development

The app lives in `web/` (TypeScript, Vite, MapLibre GL JS).

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests; real-data tests use the GPSmap.is files when present
npm run typecheck
npm run e2e        # headless-Chrome run on the real map: import, search, location, GPX, offline
```

Tests that need real data look for the GPSmap.is package in `map-files/GPSmap.is 2024.21 Android/` at the repo root
(never committed). `npm run build` writes the site to `web/dist/`: the instructions page from `web/site/` at the
root and the app under `app/`.

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`) after typecheck, tests and build. The
`dev` branch is deployed alongside as a development version at `/app-dev/`, and the Android app and
the sign-in helper have their own deployments: see CLAUDE.md for all of them and for working notes.

## Layout

- `web/src/img/`: Garmin IMG reader (container, TRE, RGN, LBL, TYP)
- `web/src/tiles/`, `web/src/style/`: vector tiles built on demand in workers, and the MapLibre style
- `web/src/dem/`: terrain tiles and ground height from `.hgt` files
- `web/src/search/`: place index, descriptions and ranking
- `web/src/location/`, `web/src/app/location.ts`: follow, heading-up, keep screen on
- `web/src/gpx/`, `web/src/app/tracks.ts`: GPX import, storage and drawing
- `web/src/routing/`, `web/src/app/route.ts`: route planning over the map's NOD road network, and the route card
- `web/src/app/navigation.ts`, `web/src/routing/maneuvers.ts`, `web/src/routing/progress.ts`: turn-by-turn
- `web/src/saved/`, `web/src/app/savedPanel.ts`, `web/src/app/saveHere.ts`: saved places, backup files
- `web/src/sync/`, `web/src/app/driveSync.ts`: Google Drive sync; `web/auth-worker/` is its sign-in helper
  (a Cloudflare Worker that keeps devices signed in)
- `web/src/storage/`: storing imported files on the device (OPFS) and the IndexedDB database
- `web/src/channel.ts`: the development version's separate storage
- `web/src/app/updates.ts`: the "new version is ready" notice
- `web/site/`: the instructions page served at the site root
- `tile-server/`: a separate, unbranded tile server and web page widget for anyone with Garmin `.img`
  maps, built from the app's reader in `web/src` (see its README)
- `android/`: the Android app for head units (opens the app in Chrome as a Trusted Web Activity, with a
  WebView fallback), built on GitHub by `.github/workflows/android.yml`

## License

The code is under the [MIT License](LICENSE). The name "Varda" and the logo in `brand/` are not part of
it, and no map data is included.
