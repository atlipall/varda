// The tile server reuses the app's code in ../web/src, whose imports of packages (maplibre-gl,
// lineclip, @maplibre/vt-pbf) would otherwise be looked up in ../web/node_modules. This takes
// them from the tile server's own node_modules, so it builds without the app's packages installed.
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export function ownPackages() {
  return {
    name: 'own-packages',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || /^[./]|^\0|^node:|^virtual:/.test(source) || importer.startsWith(HERE + 'node_modules/')) return null;
      return this.resolve(source, HERE + 'package.json', { ...options, skipSelf: true });
    },
  };
}
