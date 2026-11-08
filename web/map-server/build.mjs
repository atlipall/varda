// Builds the map server into map-server/dist/: server.mjs (no dependencies to install; Node 22 or
// newer) and public/ (the widget, MapLibre's worker files and the fonts).
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = fileURLToPath(new URL('..', import.meta.url));
const OUT = HERE + 'dist/';

await rm(OUT, { recursive: true, force: true });

await build({
  configFile: false,
  root: HERE,
  logLevel: 'warn',
  build: {
    outDir: OUT,
    emptyOutDir: false,
    ssr: HERE + 'src/main.ts',
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'server.mjs', format: 'es' } },
  },
  // One file with everything in it, so nothing needs installing where it runs.
  ssr: { noExternal: true, target: 'node' },
});

await build({
  configFile: false,
  root: HERE,
  logLevel: 'warn',
  build: {
    outDir: OUT + 'public/',
    emptyOutDir: false,
    minify: true,
    lib: { entry: HERE + 'src/widget.ts', formats: ['es'], fileName: () => 'widget.js' },
    rollupOptions: { output: { codeSplitting: false } },
  },
});

// MapLibre's worker as one plain script. Its own worker is a module, which a page opened from a
// file (file://) can't start from another address; given a .cjs URL, MapLibre fetches the script
// and starts it from a blob instead, which works from any page.
await build({
  configFile: false,
  root: HERE,
  logLevel: 'warn',
  build: {
    outDir: OUT + 'public/',
    emptyOutDir: false,
    lib: { entry: WEB + 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', formats: ['iife'], name: 'maplibreWorker', fileName: () => 'maplibre-gl-worker.cjs' },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
await cp(WEB + 'fonts/', OUT + 'public/fonts/', { recursive: true });
console.log(`Built ${OUT}`);
