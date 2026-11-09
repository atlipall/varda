import { BUILD } from '../buildInfo';
import { hasStoredData, loadLibrary, type Library } from '../storage/store';
import { androidApp, diag } from './diagnostics';
import { showImport } from './importScreen';
import { showUpdateNotice } from './updateNotice';
import { browserEnv, UpdateWatcher } from './updates';
import { startViewer } from './viewer';

export async function startApp(): Promise<void> {
  diag('page loaded');
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
    return showImport(`Could not read the stored maps: ${err instanceof Error ? err.message : String(err)}`, { hasMap: true });
  }
  // Leftover data that doesn't form a loadable map can still be removed from the import screen;
  // stored elevation files are offered for the first map.
  if (!lib.maps.length) return showImport('', { hasMap: await hasStoredData().catch(() => false), lib });
  try {
    await startViewer(lib, { reloadFromServer });
  } catch (err) {
    console.error(err);
    showImport(`Could not open the stored map: ${err instanceof Error ? err.message : String(err)}`, { hasMap: true });
  }
}
