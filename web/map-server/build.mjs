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

// MapLibre finds its worker next to its own code (see ../scripts/copy-maplibre-worker.mjs), which
// here is widget.js.
for (const name of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  await cp(WEB + 'node_modules/maplibre-gl/dist/' + name, OUT + 'public/' + name);
}
await cp(WEB + 'fonts/', OUT + 'public/fonts/', { recursive: true });
console.log(`Built ${OUT}`);
