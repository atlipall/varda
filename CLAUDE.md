# Varda: notes for working on this repo

(Called Garmin Map until the October 2026 move to vardamaps.app; internal storage names, the Drive
files, the Android package id and the `garminmap://` links keep the old name on purpose.)

A web app (TypeScript, Vite, MapLibre) that draws Garmin `.img` maps offline in the browser, used as an
iPhone Home Screen app, on a Mac, and on an Android car head unit. See README.md for the layout. The owner
is the only user and tests on an iPhone 13 and the head unit.

## How the owner likes to work

- **Small fixes: deploy right away** once unit tests and the e2e pass (push `main`). **Larger features:
  build on a branch**, put it on the development site (below) for a phone test, and merge and deploy
  when the owner says so.
- **Mockups first** for new UI when asked: a Design artifact with phone-sized screens (390×844).
- Ask the few questions that change the design (one `AskUserQuestion` with options), then build.
- **No money:** free tiers only (GitHub Pages, Cloudflare Workers free plan, Google APIs free quotas).
- **The app must work offline**; anything online (sync, downloads) is optional and fails softly.
- Copy is plain and specific, from the user's side ("Save as track", "Off the track · 180 m from it").
- PR descriptions: no "Test plan" section (owner's global rule).
- Commit messages explain what and why; end them with the Claude-Session link.

## Commands (run in `web/`)

```bash
./node_modules/.bin/tsc --noEmit        # typecheck (npx is blocked by a hook; use node_modules/.bin)
./node_modules/.bin/vitest run          # unit tests (~290); real-data tests need the GPSmap.is package
npm run e2e                             # build with VITE_GOOGLE_CLIENT_ID=e2e, then the full headless-Chrome run (~5 min)
node scripts/e2e.mjs                    # the e2e again without rebuilding
npm run dev                             # http://localhost:5173
npm run shots                           # retake the guide's screenshots (web/site/images/) after a UI change
npm run icons                           # redraw the app's and Android app's icons from brand/*.svg (the logo's master files)
```

- **`npm install` is blocked** unless logged in to npm (`npm login`): no new dependencies without asking.
  Prefer writing small code over adding packages (zip, Shapefile and projections were written by hand).
- The e2e drives the real map from `GPSmap.is 2024.21 Android/` (never committed), fakes GPS with
  `Emulation.setGeolocationOverride`, and fakes Google Drive, the sign-in helper and HMS with request
  interception. A failed click reports its line and which parent was hidden. Screenshots go to
  `web/e2e-output/`; look at them, they catch what assertions miss.
- Tests that build a vector tile should decode it and check the geometry, not just the properties.

## Deployments

| What | Where | How |
|---|---|---|
| The app + guide | vardamaps.app (`/app/`; custom domain on GitHub Pages, DNS on Cloudflare) | push `main` → `.github/workflows/pages.yml` |
| Development version | `/app-dev/` ("Varda Dev") | `git push --force origin <branch>:dev`; `dev.yml` re-runs Pages from main, which builds both |
| Android app | GitHub Releases, `releases/latest/download/Varda.apk` | push `main` touching `android/` → `android.yml` |
| Sign-in helper | auth.vardamaps.app only (worker `garmin-maps-auth`, kept so its secrets stay; workers.dev off) | `wrangler deploy` in `web/auth-worker/` |
| Free-map download helper | download.vardamaps.app only (worker `garmin-maps-download`; workers.dev off) | `wrangler deploy` in `web/download-worker/` (passes the Freizeitkarte Iceland zip on with CORS; no secrets) |
| Asset links | vardamaps.app/.well-known/assetlinks.json | `web/site/.well-known/assetlinks.json`, deployed with the site |
| Old addresses | atlipall.github.io/garmin-maps/… | redirect pages in the `atlipall/atlipall.github.io` repo (no asset links there any more) |
| Development page | vardamaps.app/dev/ (APK downloads, short to type on the head unit) | `web/site/dev/index.html`, deployed with the site; update its pinned APK version |

- Only `main` may deploy to Pages (environment rule): never loosen it; dev deploys go through `dev.yml`.
- **The development version keeps its own storage** (`web/src/channel.ts`, build flag `VITE_CHANNEL=dev`):
  database, settings, map folder, caches and sync file all differ, so a new storage format there can't
  break the app. Every storage name goes through `storageName()` / `storageRoot()`.
- **IndexedDB is opened at whatever version it has** (`web/src/storage/idb.ts`); add a store by adding it
  to `STORES`, never by relying on a version number (branches and old app versions share databases).
- **Adding a host the app talks to:** add it to the CSP `connect-src` in `web/index.html`, or it fails
  silently in the browser (the e2e catches it; unit tests don't).
- Wrangler isn't installed globally: use `/Users/atli/projects/katifillinn/node_modules/.bin/wrangler`
  (logged in to the owner's Cloudflare account; the helpers take only `ALLOWED_ORIGINS` in their
  `wrangler.toml`: vardamaps.app and localhost). Its secrets:
  `GOOGLE_CLIENT_SECRET`, `SEAL_KEY`.
- Android: APKs are built on GitHub; local build, emulator and Chrome's location rules are in
  `android/CLAUDE.md`. Signing key: repo secrets `ANDROID_KEYSTORE`/`ANDROID_KEYSTORE_PASSWORD`, local
  copy in `.android-signing/` (git-ignored; never lose it, or updates stop installing over the old app).

## Open work (update this when it changes)

- **`embed` branch (2026-11-08): a map server and widget for web pages**, `map-server/` (its own
  package and node_modules, like `android/`; `npm run build|test|typecheck|check` there; it
  reuses `web/src`, taking that code's packages from its own node_modules via `resolve.mjs`). Not
  Varda: no Varda name, links or hosting; anyone with .img maps runs it (`node server.mjs --maps
  <folder>`), and it serves its own `widget.js` (`<div data-img-map=…>`, or `ImgMap.mount()`),
  MapLibre's workers and the fonts. Owner's choices: tiles built on request by a Node server (not
  pre-built files), a script + div (not an iframe), hillshading in the first version. Each map
  also gets a standard `style.json` with a sprite generated from its TYP. Tiles are built in the
  main thread one at a time, with an in-memory cache. Not merged; nothing deployed (it needs an
  always-on machine).

- **Switched 2026-10-29: Garmin Map is now Varda at vardamaps.app** (repo `atlipall/varda`). DNS on
  Cloudflare (zone `vardamaps.app`; Pages A/AAAA/www records DNS-only; the wrangler login can't edit
  DNS, a DNS-only API token was used and deleted). Old `atlipall.github.io/garmin-maps/…` addresses
  redirect through pages in the `atlipall/atlipall.github.io` repo. Android app 1.20 is the first
  Varda build. Owner's devices moved; clean-up done 2026-11-07 (helpers accept only vardamaps.app
  and localhost, workers.dev addresses off, old assetlinks.json deleted). Left for the owner: the
  old origin out of the Google OAuth client (Cloud Console) and ticking the checklist
  (claude.ai/artifact/Wxis6khp5D2Amqj7jnH3mh).
- **Shipped 2026-10-28** (merged from `photos` before a full phone test): photos on the map (⋯ →
  Photos). Copies at most 2048 px with all the original's metadata (`web/src/photos/`: JPEG
  segments, HEIC boxes, EXIF; orientation and size updated in place, MPF dropped, the colour
  profile kept where the copy is drawn in its space); round thumbnails grouped on screen
  (`photoLayer.ts`); viewer with swipe, pinch, tap-to-hide and a description editor
  (`photoViewer.ts`); photos without a location shown first and left out; Undo after adding and
  deleting. Sync is a per-device switch ("Sync photos too"): details in the sync file, each
  picture a file `garmin-map-photo-<id>.jpg` in the app folder. Mockups:
  claude.ai/artifact/95UsMjnreFrPQTAvNcyPNH. Safari's Photos picker keeps the location (tested
  on the owner's iPhone). Still to check on the iPhone: P3 colours, Share's caption, gestures,
  memory when adding 20–30 photos, sync with a second device. Not in the guide's screenshots yet.
- **Shipped 2026-10-16** (an Apple HIG review): one accent colour (`--accent #1d3f8f`; the icon,
  guide and Android bar keep #2c5a85); every button at least 44 pt; End shows "Guidance ended ·
  Undo" for 8 s (`TrackNav.resume` brings a track's guidance back); a Settings panel (⋯ →
  Settings: the map, Load another map, the two switches, Diagnostics, Reload, version) so the menu
  keeps to Tracks, Saved places, Sync and Settings; round ✕ close buttons everywhere; drawn file
  pickers on the import screen; keyboard focus rings; text follows the iPhone's Text Size (font
  sizes are `calc(N * var(--px))`, held to about 14–23 px body; inputs never below 16 px). Next:
  **dark mode on a branch**, which needs the colours as variables and a night map style.
- **Shipped 2026-10-07**: the menu puts other panels away (`web/src/ui/dialogs.ts`); a tap on a
  suggested name selects it (`suggestName`); car-sized controls in the Android app on screens
  ≥600 px each way (CSS zoom 1.5, `body.android-app`); "Reload from the server" in the Android
  app's menu; follow zoom by speed after Organic Maps' scale table (`web/src/location/followZoom.ts`);
  a menu at a place picked over a route (`web/src/app/placeMenu.ts`). Not yet tried in the car.
- **Shipped 2026-10-06** (merged from `free-map`): a free map for people without GPSmap.is.
  "Download free map" on the import screen fetches Freizeitkarte Iceland (OSM-based,
  mkgmap-built, "free for any purposes" with credit) through the download helper and unzips it
  while it streams (`web/src/storage/unzipStream.ts`). Also: NOD length unit from header flag bits
  5-7 (mkgmap's DISTANCE_MULT_SHIFT; its maps use 4.8 m); roads closed to cars (Table A access bit
  0x01) left out of routing; F-roads found by any of a road's labels; zooms 7-8 take roads from
  zoom 9's level; lines at least 1 px (contours 0.5); Freizeitkarte's "(Type)" name suffixes
  cleaned up (`web/src/map/freizeitkarte.ts`); credit in an (i) on the map. Next ideas: hill
  shading from the .img's own DEM subfiles (OSM users have no .hgt files; SRTM stops at 60°N);
  slower rough tracks on Freizeitkarte (it has no GPSmap.is track types); maybe telling the
  Freizeitkarte team.
- **Shipped 2026-10-05** (merged from `trip-recording`, which held `tracks-nav`): routes saved as
  tracks, the track card and track navigation; renaming tracks and pins; trip recording in the
  Android app (TripActivity/TripRecorder/TripStore → `#trip-recording=` / `#trip=` / `#trip-failed=`
  in the map's address). Not yet tried in the car. Branch APKs: `gh workflow run android.yml --ref
  <branch>` (published as a pre-release).
- **`map-layers` branch** (paused by the owner): imported GeoJSON/Shapefile layers and HMS farm
  boundaries. Next idea if resumed: HMS estimated boundaries (`HMS_AETLUN_SKIKI`) as dashed lines.
- **Android app on the head unit**: works, location included, since 1.15 (Chrome only); 1.16 keeps the
  unit's system bar (clock, back) visible. Next, when asked: background location tracking. Details in
  `android/CLAUDE.md`.
- Import screen tip is iOS-only ("Share → Add to Home Screen"); Android would need its own.
