/**
 * Shows a map from the server this script was loaded from. On a page:
 *
 *   <script type="module" src="https://maps.example.com/widget.js"></script>
 *   <div data-img-map="<map id>" data-center="64.15,-21.94" data-zoom="10" style="height: 400px"></div>
 *
 * or from the page's own code: `const map = await ImgMap.mount(element, { map: '<map id>' })`,
 * which gives a MapLibre map (`ImgMap.maplibregl` has its Marker, Popup and so on).
 */
import * as maplibregl from 'maplibre-gl';
import css from 'maplibre-gl/dist/maplibre-gl.css?inline';

export interface MountOptions {
  /** The map's id, as listed at the server's /maps. */
  map: string;
  /** [latitude, longitude]; without it the whole map is shown. */
  center?: [number, number];
  zoom?: number;
  /** Scrolling the page doesn't zoom the map: zoom with Ctrl/⌘ + scroll, or two fingers (default true). */
  cooperativeGestures?: boolean;
  /** The server's address (default: where this script came from). */
  server?: string;
}

const SCRIPT_BASE = new URL('.', import.meta.url).href.replace(/\/$/, '');
// See build.mjs: a plain-script worker, so the map also works on a page opened from a file.
maplibregl.setWorkerUrl(`${SCRIPT_BASE}/maplibre-gl-worker.cjs`);

function addCss(): void {
  if (document.querySelector('style[data-img-map-css]')) return;
  const style = document.createElement('style');
  style.dataset.imgMapCss = '';
  style.textContent = css;
  document.head.appendChild(style);
}

export async function mount(element: HTMLElement, opts: MountOptions): Promise<maplibregl.Map> {
  addCss();
  if (!opts.map) throw new Error('no map given (data-img-map)');
  const server = (opts.server ?? SCRIPT_BASE).replace(/\/$/, '');
  const res = await fetch(`${server}/maps/${encodeURIComponent(opts.map)}`);
  if (!res.ok) throw new Error(`map "${opts.map}" not found on ${server} (${res.status})`);
  const info = (await res.json()) as { bounds: [number, number, number, number]; style: string };
  if (!element.style.height && element.clientHeight === 0) element.style.height = '400px';
  const [w, s, e, n] = info.bounds;
  // A zoom without a center is around the middle of the map; neither shows the whole map.
  const view = opts.center || opts.zoom !== undefined
    ? { center: (opts.center ? [opts.center[1], opts.center[0]] : [(w + e) / 2, (s + n) / 2]) as [number, number], zoom: opts.zoom ?? 10 }
    : { bounds: [[w, s], [e, n]] as [[number, number], [number, number]], fitBoundsOptions: { padding: 10 } };
  const map = new maplibregl.Map({
    container: element,
    style: info.style,
    ...view,
    maxZoom: 18,
    cooperativeGestures: opts.cooperativeGestures ?? true,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  return map;
}

/** Reads a widget's settings from its data- attributes. */
function optionsOf(el: HTMLElement): MountOptions {
  const d = el.dataset;
  // parseFloat, not Number: a blank part must not read as 0.
  const center = d.center?.split(',').map(parseFloat);
  const zoom = parseFloat(d.zoom ?? '');
  return {
    map: d.imgMap ?? '',
    center: center?.length === 2 && center.every(Number.isFinite) ? (center as [number, number]) : undefined,
    zoom: Number.isFinite(zoom) ? zoom : undefined,
    cooperativeGestures: d.cooperative === 'false' ? false : undefined,
    server: d.server || undefined,
  };
}

const mounted = new WeakSet<HTMLElement>();

/** Shows every `data-img-map` element on the page that isn't showing yet. Each fires `mapready`
 *  ({ detail: { map } }) when its map is there, or `maperror` ({ detail: { error } }). */
export function mountAll(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-img-map]')) {
    if (mounted.has(el)) continue;
    mounted.add(el);
    if (el.dataset.imgMapFailed !== undefined) {
      delete el.dataset.imgMapFailed;
      el.textContent = '';
    }
    mount(el, optionsOf(el)).then(
      (map) => el.dispatchEvent(new CustomEvent('mapready', { detail: { map } })),
      (error) => {
        console.error('map widget:', error);
        // Left out of `mounted`, so a later mountAll() tries again.
        mounted.delete(el);
        el.dataset.imgMapFailed = '';
        el.textContent = `The map could not be shown: ${error instanceof Error ? error.message : error}`;
        el.dispatchEvent(new CustomEvent('maperror', { detail: { error } }));
      },
    );
  }
}

declare global {
  interface Window {
    ImgMap: { mount: typeof mount; mountAll: typeof mountAll; maplibregl: typeof maplibregl };
  }
}
window.ImgMap = { mount, mountAll, maplibregl };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAll());
else mountAll();
