import type * as maplibregl from 'maplibre-gl';
import type { Overlay, OverlayFeature } from '../overlays/kml';
import { downloadLayer, pickedLayer, type OgcLayer } from '../overlays/ogc';
/** The readers (KML, Shapefile, zip, projections): loaded when an overlay is first added. */
const readers = () => import('../overlays/read');
import { addOverlay, deleteOverlay, getOverlayFeatures, listOverlays, putOverlay, type OverlaySource, type StoredOverlay } from '../overlays/store';
import { newId } from '../saved/saved';
import { fitClearOf } from './listButtons';

/** "195 places · 23 areas" */
export function overlaySummary(c: StoredOverlay['counts']): string {
  const part = (n: number, one: string, many: string) => (n ? `${n.toLocaleString('en')} ${n === 1 ? one : many}` : '');
  return [part(c.points, 'place', 'places'), part(c.lines, 'line', 'lines'), part(c.areas, 'area', 'areas')].filter(Boolean).join(' · ');
}

/**
 * KML overlays (such as GPSmap.is's drone no-fly zones, parking zones and artworks) and Shapefiles
 * (such as Óbyggðanefnd's þjóðlendur) drawn over the map in their own colours; listed in the Maps
 * panel's Overlays tab. Areas and lines go under the map's names so the names stay readable; points
 * and their names go on top, under the tracks. Each overlay has its own source and layers, in list
 * order, so showing, hiding or updating one doesn't send the others' shapes to the map again; only
 * the visible overlays' shapes are read from storage and handed to the map (which holds them).
 * Kept on this device only.
 */
export class OverlayMap {
  private overlays: StoredOverlay[] = [];
  /** Read from storage (never rejects: a failure is in `loadError`). */
  private readonly loaded: Promise<void>;
  loadError = '';
  /** Called when the list or an overlay's visibility changed. */
  onChange = () => {};

  /** `underTracks`: the layer the points and names go under (the tracks' lowest, already added). */
  constructor(private readonly map: maplibregl.Map, private readonly font: string, private readonly underTracks: string) {
    this.loaded = this.load().catch((err) => {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.onChange();
    });
  }

  private async load(): Promise<void> {
    this.overlays = await listOverlays();
    this.onChange();
    for (const o of this.overlays) this.addLayers(o, []);
    for (const o of this.overlays.filter((x) => x.visible)) {
      const features = await getOverlayFeatures(o.id);
      if (o.visible && this.overlays.includes(o)) this.draw(o, features); // not hidden or removed meanwhile
    }
  }

  /** Adds overlay `o`'s source and layers above the other overlays' (it's the last in the list,
   *  or they're being added in list order). Hidden overlays' layers are there, hidden, without shapes. */
  private addLayers(o: StoredOverlay, features: OverlayFeature[]): void {
    const map = this.map;
    const src = sourceId(o.id);
    if (map.getSource(src)) return; // kept over a map switch
    const order = map.getLayersOrder();
    /** The layer just above the last one named `prefix`… (undefined: the top), or `otherwise`. */
    const above = (prefix: string, otherwise: string | undefined) => {
      let last = order.length - 1;
      while (last >= 0 && !order[last].startsWith(prefix)) last--;
      return last < 0 ? otherwise : order[last + 1];
    };
    // Areas and lines above the other overlays' but under the map's own names (its first symbol
    // layer); points and names above the other overlays' but under the tracks.
    const underNames = above('overlay-line:', order.find((id) => !id.startsWith('overlay-') && map.getLayer(id)?.type === 'symbol'));
    const underPoints = above('overlay-label:', map.getLayer(this.underTracks) ? this.underTracks : undefined);
    const visibility = o.visible ? 'visible' : 'none';
    const k = (...kinds: string[]) => ['in', ['get', 'k'], ['literal', kinds]] as maplibregl.ExpressionSpecification;
    const font = this.font;
    map.addSource(src, { type: 'geojson', data: collection(features) });
    map.addLayer({ id: `overlay-fill:${o.id}`, type: 'fill', source: src, filter: k('area'), layout: { visibility },
      paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] } }, underNames);
    map.addLayer({ id: `overlay-line:${o.id}`, type: 'line', source: src, filter: k('area', 'line'), layout: { visibility, 'line-join': 'round' },
      paint: { 'line-color': ['get', 'line'], 'line-opacity': ['get', 'lineOpacity'], 'line-width': ['get', 'lineWidth'] } }, underNames);
    map.addLayer({ id: `overlay-line-label:${o.id}`, type: 'symbol', source: src, filter: ['all', k('line'), ['!=', ['get', 'name'], '']],
      layout: { visibility, 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12 },
      paint: { 'text-color': ['get', 'line'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, underPoints);
    map.addLayer({ id: `overlay-point:${o.id}`, type: 'circle', source: src, filter: k('point'), layout: { visibility },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 5], 'circle-color': ['get', 'fill'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } }, underPoints);
    // Names from town zoom on: further out, a city's worth of places would be a heap of names.
    map.addLayer({ id: `overlay-label:${o.id}`, type: 'symbol', source: src, minzoom: 11, filter: ['all', k('point', 'label'), ['!=', ['get', 'name'], '']],
      layout: {
        visibility,
        'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12, 'text-max-width': 9, 'text-optional': true,
        'text-anchor': ['case', ['==', ['get', 'k'], 'point'], 'top', 'center'],
        'text-offset': ['case', ['==', ['get', 'k'], 'point'], ['literal', [0, 0.7]], ['literal', [0, 0]]],
      },
      paint: { 'text-color': ['get', 'line'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, underPoints);
  }

  /** Overlay `o`'s layers on the map. */
  private layerIds(o: StoredOverlay): string[] {
    return LAYERS.map((l) => `overlay-${l}:${o.id}`);
  }

  /** Hands overlay `o`'s shapes to the map (none: it's hidden) and shows or hides its layers. */
  private draw(o: StoredOverlay, features: OverlayFeature[]): void {
    const map = this.map;
    (map.getSource(sourceId(o.id)) as maplibregl.GeoJSONSource | undefined)?.setData(collection(features));
    for (const id of this.layerIds(o)) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', o.visible ? 'visible' : 'none');
  }

  /** The overlays, in the order added. */
  get all(): StoredOverlay[] {
    return this.overlays;
  }

  /** Stores and shows KML/KMZ files and Shapefiles (their files together, or zipped); what can't
   *  be read is named in `problems`. */
  async importFiles(files: File[]): Promise<{ added: StoredOverlay[]; problems: string[] }> {
    await this.loaded;
    const added: StoredOverlay[] = [];
    const problems: string[] = [];
    for (const job of (await readers()).overlayJobs(files)) {
      try {
        for (const overlay of await job.read()) added.push(await this.keep(overlay));
      } catch (err) {
        problems.push(`“${job.label}” couldn’t be added: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (added.length) this.onChange();
    return { added, problems };
  }

  /** Stores, lists and shows a read overlay. */
  private async keep({ features, ...rest }: Overlay, source?: OverlaySource): Promise<StoredOverlay> {
    const o: StoredOverlay = { ...rest, id: newId(), visible: true, added: Date.now(), ...(source ? { source } : {}) };
    await addOverlay(o, features);
    this.overlays.push(o);
    this.addLayers(o, features);
    return o;
  }

  /** Reads layer `layer` from ogc.gis.is, named and coloured as the picked list says. */
  private async fetchLayer(layer: OgcLayer, onBytes?: (n: number) => void): Promise<Overlay> {
    const bytes = await downloadLayer(layer.id, onBytes);
    const [first] = await (await readers()).readZip(`${layer.title}.zip`, bytes, layer.fields);
    if (!first) throw new Error('The layer came without any shapes.');
    return { ...first, name: layer.title };
  }

  /** Downloads a layer from ogc.gis.is and adds it, shown. Rejects with the reason it couldn't. */
  async download(layer: OgcLayer, onBytes?: (n: number) => void): Promise<StoredOverlay> {
    await this.loaded;
    const o = await this.keep(await this.fetchLayer(layer, onBytes), { ogc: layer.id, downloaded: Date.now() });
    this.onChange();
    return o;
  }

  /** The overlay downloaded from layer `id`, if there is one. */
  fromLayer(id: string): StoredOverlay | undefined {
    return this.overlays.find((o) => o.source?.ogc === id);
  }

  /** Downloads overlay `o`'s layer again and puts it in its place (its name, list place and
   *  visibility kept). Resolves to its counts before. */
  async update(o: StoredOverlay, onBytes?: (n: number) => void): Promise<StoredOverlay['counts']> {
    if (!o.source) throw new Error('This overlay wasn’t downloaded from ogc.gis.is.');
    const layer = pickedLayer(o.source.ogc) ?? { id: o.source.ogc, title: o.name, agency: '' };
    const { features, counts, bounds, color, legend } = await this.fetchLayer(layer, onBytes);
    const before = o.counts;
    if (!this.overlays.includes(o)) return before; // removed meanwhile
    Object.assign(o, { counts, bounds, color, legend, source: { ...o.source, downloaded: Date.now() } });
    if (!legend) delete o.legend;
    await addOverlay(o, features);
    if (o.visible) this.draw(o, features);
    this.onChange();
    return before;
  }

  /** Fits overlay `o` in view, clear of `panel` while it's open. */
  zoomTo(o: StoredOverlay, panel: HTMLElement): void {
    const [w, s, e, n] = o.bounds;
    fitClearOf(this.map, panel, [[w, s], [e, n]], 16);
  }

  /** Shows or hides an overlay at once, and remembers it. */
  async setVisible(o: StoredOverlay, visible: boolean): Promise<void> {
    o.visible = visible;
    this.onChange();
    try {
      await putOverlay(o);
    } catch (err) {
      o.visible = !visible;
      this.onChange();
      throw err;
    }
    // Hidden: its shapes are let go (read from storage again when shown).
    if (!visible) return this.draw(o, []);
    const features = await getOverlayFeatures(o.id);
    if (!o.visible || !this.overlays.includes(o)) return; // hidden or removed meanwhile
    this.draw(o, features);
  }

  async remove(id: string): Promise<void> {
    await deleteOverlay(id);
    const o = this.overlays.find((x) => x.id === id);
    this.overlays = this.overlays.filter((x) => x !== o);
    if (o) {
      for (const l of this.layerIds(o)) if (this.map.getLayer(l)) this.map.removeLayer(l);
      if (this.map.getSource(sourceId(id))) this.map.removeSource(sourceId(id));
    }
    this.onChange();
  }
}

/** An overlay's layers: `overlay-<kind>:<its id>`, all from the source `overlay:<its id>`. */
const LAYERS = ['fill', 'line', 'line-label', 'point', 'label'];
const sourceId = (id: string) => `overlay:${id}`;
const collection = (features: OverlayFeature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features });
