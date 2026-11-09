# Several maps on one device — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every imported map, switch between them in place, and store elevation as named sets that any map can use for hillshading.

**Architecture:** OPFS keeps one dir per map (`garmin-<ts>/`, as today) and one per elevation set (`elevation-<ts>/`, or a migrated `garmin-<ts>/dem/`); `current.json` still names the current map and `maps.json` holds the user's names and hillshading choices. A pure `library.ts` decides sets/coverage; the storage worker does every write. The viewer gets a swappable "source" (pool + style + credit + search index) so a switch is a `setStyle` diff that keeps the overlays.

**Tech Stack:** TypeScript, Vite, MapLibre GL 6.11, OPFS (sync access handles in a worker), Vitest, puppeteer e2e.

**Spec:** `docs/superpowers/specs/2026-11-09-multiple-maps-design.md` (mockup: `mockups/multiple-maps.html`)

## Global Constraints

- No new npm dependencies. Every storage name goes through `storageRoot()`/`storageName()` (dev keeps its own).
- Works offline; copy plain and from the user's side ("Remove from this iPhone" → "Remove from this device" where the device isn't known).
- Buttons ≥ 44 px; font sizes `calc(N * var(--px))`; inputs ≥ 16 px; round ✕ close buttons; panels register with `Dialogs`.
- Older app versions sharing storage must still open the current map (keep `current.json`, keep `meta.json` v1 shape).
- Run in `web/`: `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/vitest run`, `npm run e2e`.

---

### Task 1: Library logic (pure)

**Files:** Create `web/src/storage/library.ts`, `web/test/library.test.ts`.

**Produces:**
```ts
export interface SetInfo { id: string; name: string; files: string[]; step: number; bytes: number; squares: Array<{ south: number; west: number }> }
export interface MapInfo { id: string; name: string; imgName: string; bytes: number; added: number; bounds: Bounds | null; elevation: string | null | undefined /* chosen; undefined = automatic */ }
export type Bounds = [number, number, number, number];
export interface Choices { maps: Record<string, { name?: string; elevation?: string | null; bounds?: Bounds }>; sets: Record<string, { name?: string }> }
export function parseChoices(text: string | null): Choices;           // tolerant: bad → empty
export function parseSetJson(text: string | null): { name: string; files: string[]; step: number } | null;
export function canonicalHgtName(stored: string): string;              // 'n64w019.1731.hgt' → 'n64w019.hgt'
export function coverage(set: Pick<SetInfo, 'squares'>, b: Bounds): number; // 0..1 of the map's 1° squares
export function coverageText(c: number): string;                       // 'Covers all of this map' / 'Covers part of this map' / "Doesn't cover this map"
export function autoSet(sets: SetInfo[], b: Bounds | null): SetInfo | null; // most coverage, then finer step, then newest id
export function elevationFor(map: MapInfo, sets: SetInfo[]): SetInfo | null; // null choice → null; missing set → auto
export function defaultSetName(step: number, n: number): string;      // '1″ elevation · 48 files'
export function contains(b: Bounds, at: [number, number]): boolean;
```
Tests: coverage all/part/none; autoSet prefers coverage then finer; elevationFor honours `null` and falls back when the chosen id is gone; parseChoices junk; canonicalHgtName.

### Task 2: Storage worker + store API

**Files:** Modify `web/src/storage/storageWorker.ts`, `web/src/storage/store.ts`, `web/src/storage/layout.ts`.

**Produces (store.ts):**
```ts
export interface Library { maps: MapInfo[]; sets: SetInfo[]; current: string | null; choices: Choices }
export async function loadLibrary(): Promise<Library>;                 // runs the in-place upgrade first (worker 'migrate')
export async function loadMap(lib: Library, id: string): Promise<Stored>; // Stored gains { id, set: SetInfo | null }
export const importFiles(img, hgt, opts: { name?: string; elevation?: string | null | 'new' }, onProgress);
export const downloadMap(url, imgName, onProgress);
export const importElevation(hgt: File[], into: string | null, onProgress): Promise<string>; // set id
export const inspectMap(img: File): Promise<{ bounds: Bounds; description: string }>;
export async function setCurrent(id: string): Promise<void>;
export async function saveChoices(c: Choices): Promise<void>;
export async function removeMap(id: string): Promise<void>;
export async function removeSet(id: string): Promise<void>;
export async function readText(dir: string, name: string) / writeText(dir: string, name: string, text: string);
```
Worker: imports stop deleting other maps; leftovers without a commit marker are removed; `migrate` writes `dem/overview.bin` + `dem/set.json` for older maps; sets written as `elevation-<ts>/` with `set.json` last; adding to a set writes replaced squares under `<square>.<ts>.hgt`, rebuilds `overview.bin`, rewrites `set.json`, then deletes the replaced files. `writeSmall` for `maps.json` and `current.json`.

### Task 3: Session not tied to one map

**Files:** `web/src/app/session.ts`, its test. `parseSession(raw)` ignores `map`; the viewer drops a view whose centre is outside the map.

### Task 4: Swappable map source in the viewer

**Files:** Create `web/src/app/mapSource.ts`; modify `web/src/app/viewer.ts`, `web/src/app/startup.ts`, `web/src/app/savedPanel.ts` (re-add its star on `styleimagemissing`).

`openSource(stored, gen) → { pool, meta, style, images, baseLayers, credit }`; protocols registered once and served by the current pool; tile URLs `garmin://{z}/{x}/{y}?v=<gen>`. `switchTo(mapId, setId?)`: open new pool, `map.setStyle(style, { transformStyle })` keeping non-base sources/layers, replace TYP images, swap credit control, rebuild search index and roads, re-plan a routed route, fit the map's area when the centre is outside it, dispose the old pool, write `current.json`.

### Task 5: Maps UI

**Files:** Create `web/src/app/mapsPanel.ts`; modify `web/index.html`, `web/src/app/viewer.ts`, `web/src/app/importScreen.ts`.

Map button (`#maps-button`) + picker (`#map-picker`), menu item `#maps-open`, panel `#maps-panel` (list / map details / set details), switch note `#map-note` with Undo (8 s), Settings row `#settings-map`, import screen "add" mode (title, `#import-name`, hillshading radios `#import-elevation`), elevation import input `#elevation-files`.

### Task 6: e2e, guide, notes

**Files:** `web/scripts/e2e.mjs`, `README.md`/guide text if it mentions "Load another map", `CLAUDE.md` open work.

e2e: first import makes one map + one `elevation-*` set; add Focused (no files) → auto set; button visible; switch keeps centre/zoom, overlays (saved star, route) survive; Undo; details → Off removes `dem` source; rename; remove; older layout with `dem/` migrates and keeps hillshading.
