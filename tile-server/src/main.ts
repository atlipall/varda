import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findMaps } from './maps';
import { createHandler, DEFAULT_CACHE_MB } from './server';

const HELP = `Serves Garmin .img maps as map tiles, with a widget that shows them on any web page.

  node server.mjs [--maps <folder>] [--port 8080] [--host 0.0.0.0]
                  [--origins https://example.com,https://www.example.com]
                  [--public-url https://maps.example.com] [--trust-proxy] [--cache-mb 256]

  --maps        Folder of maps (default ./maps). Each .img file is a map. Put a map's .hgt
                elevation files in a subfolder with it for hillshading.
  --origins     Web sites allowed to show the maps (default: any).
  --public-url  The address people reach the server at (default: the address they asked for).
  --trust-proxy Take that address from X-Forwarded-Host and X-Forwarded-Proto, which a proxy in
                front of the server sets. Only use it behind such a proxy.
  --cache-mb    Memory for built tiles (default ${DEFAULT_CACHE_MB}).

Environment variables MAPS, PORT, HOST, ORIGINS, PUBLIC_URL, TRUST_PROXY=1 and CACHE_MB work too.`;

const { values } = parseArgs({
  options: {
    maps: { type: 'string', default: process.env.MAPS ?? './maps' },
    port: { type: 'string', default: process.env.PORT ?? '8080' },
    host: { type: 'string', default: process.env.HOST ?? '0.0.0.0' },
    origins: { type: 'string', default: process.env.ORIGINS ?? '*' },
    'public-url': { type: 'string', default: process.env.PUBLIC_URL },
    'trust-proxy': { type: 'boolean', default: process.env.TRUST_PROXY === '1' },
    'cache-mb': { type: 'string', default: process.env.CACHE_MB ?? String(DEFAULT_CACHE_MB) },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
const port = Number(values.port);
const cacheMb = Number(values['cache-mb']);
if (!Number.isInteger(port) || port < 0 || port > 65535 || !(cacheMb >= 0)) {
  console.error(`--port must be a port number and --cache-mb a number of megabytes.\n\n${HELP}`);
  process.exit(1);
}

const root = resolve(values.maps);
console.log(`Maps in ${root}:`);
const maps = await findMaps(root).catch((err) => {
  console.error(`Could not read ${root}: ${err.message}\n\n${HELP}`);
  process.exit(1);
});
if (!maps.size) console.log('  (none: put .img files in the folder and restart)');
for (const m of maps.values()) m.warmUp();

const handler = createHandler(maps, {
  publicUrl: values['public-url'],
  trustProxy: values['trust-proxy'],
  origins: values.origins.split(',').map((o) => o.trim()).filter(Boolean),
  publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
  cacheBytes: cacheMb * 1024 * 1024,
});
createServer(handler).listen(port, values.host, () => {
  console.log(`\nListening on http://${values.host === '0.0.0.0' ? 'localhost' : values.host}:${port}/`);
});
