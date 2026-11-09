import { BUILD } from '../buildInfo';
import { emptyLibrary, hasStoredData, loadLibrary, removeMap, setCurrent, type Library } from '../storage/store';
import { androidApp, diag } from './diagnostics';
import { MapsUi, type Standalone } from './mapsPanel';
import { showUpdateNotice } from './updateNotice';
import { browserEnv, UpdateWatcher } from './updates';
import { ignoreStrayDrops } from '../ui/drop';
import { startViewer } from './viewer';

const errorText = (what: string, err: unknown) => `${what}: ${err instanceof Error ? err.message : String(err)}`;

export async function startApp(): Promise<void> {
  diag('page loaded');
  ignoreStrayDrops(); // a file dropped beside a panel would otherwise open in place of the app
  // In the Android app (made for car head units) a big screen gets car-sized controls (index.html):
  // judged by the screen, which the on-screen keyboard doesn't shrink as it does the page.
  const inApp = androidApp() !== null;
  document.body.classList.toggle('android-app', inApp);
  const carSize = () => document.body.classList.toggle('car-size', inApp && Math.min(screen.width, screen.height) >= 600);
  carSize();
  screen.orientation?.addEventListener('change', carSize);
  const updates = 'serviceWorker' in navigator && import.meta.env.PROD
    ? new UpdateWatcher(BUILD, showUpdateNotice, browserEnv(new URL('./sw.js', document.baseURI)))
    : null;
  void updates?.start();
  // Without a service worker (the dev server) the page itself is all there is to load again.
  const reloadFromServer = async () => {
    if (updates) return updates.reloadFromServer();
    if (!navigator.onLine) return 'offline' as const;
    location.reload();
    return 'reloading' as const;
  };
  let lib: Library;
  try {
    lib = await loadLibrary();
  } catch (err) {
    console.error(err);
    return showMapsAlone({ error: errorText('Could not read the stored maps', err), unreadable: true });
  }
  // No map yet: the Maps panel is the first screen. Leftover data that doesn't make a map or a
  // set of elevation files can be removed there.
  if (!lib.maps.length) return showMapsAlone({ leftovers: !lib.sets.length && (await hasStoredData().catch(() => false)) });
  try {
    await startViewer(lib, { reloadFromServer });
  } catch (err) {
    console.error(err);
    // Another map can be shown instead, or this one removed.
    showMapsAlone({ error: errorText('Could not open the map', err), failed: lib.current ?? undefined });
  }
}

/** The Maps panel on its own, with no map behind it: adding, showing or removing a map starts the
 *  app again with it. */
function showMapsAlone(standalone: Standalone): void {
  const ui = new MapsUi({
    library: () => loadLibrary().catch(emptyLibrary),
    current: () => null,
    center: () => null,
    switchTo: async (id) => {
      await setCurrent(id);
      location.reload();
    },
    refresh: async () => {},
    add: async (store) => {
      await store();
      location.reload();
    },
    removeMap: (id) => removeMap(id),
    changed: () => {},
  }, standalone);
  ui.showPanel(true);
}
