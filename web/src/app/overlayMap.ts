import type * as maplibregl from 'maplibre-gl';
import { readOverlayFile, type OverlayFeature } from '../overlays/kml';
import { addOverlay, deleteOverlay, getOverlayFeatures, listOverlays, putOverlay, type StoredOverlay } from '../overlays/store';
import { newId } from '../saved/saved';
import { fitClearOf } from './listButtons';

/** "195 places · 23 areas" */
export function overlaySummary(c: StoredOverlay['counts']): string {
  const part = (n: number, one: string, many: string) => (n ? `${n.toLocaleString('en')} ${n === 1 ? one : many}` : '');
  return [part(c.points, 'place', 'places'), part(c.lines, 'line', 'lines'), part(c.areas, 'area', 'areas')].filter(Boolean).join(' · ');
}

/**
 * KML overlays (such as GPSmap.is's drone no-fly zones, parking zones and artworks) drawn over the
 * map in their own colours; listed in the Maps panel's Overlays tab. Areas and lines go under the
 * map's names so the names stay readable; points and their names go on top, under the tracks. Only
 * the visible overlays' shapes are read from storage and held. Kept on this device only.
 */
export class OverlayMap {
  private overlays: StoredOverlay[] = [];
  /** The shapes of the visible overlays, by id. */
  private readonly shapes = new Map<string, OverlayFeature[]>();
  /** Read from storage (never rejects: a failure is in `loadError`). */
  private readonly loaded: Promise<void>;
  loadError = '';
  /** Called when the list or an overlay's visibility changed. */
  onChange = () => {};

  /** `underTracks`: the layer the points and names go under (the tracks' lowest, already added). */
  constructor(private readonly map: maplibregl.Map, font: string, underTracks: string) {
    this.addLayers(font, underTracks);
    this.loaded = this.load().catch((err) => {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.onChange();
    });
  }

  private async load(): Promise<void> {
    this.overlays = await listOverlays();
    this.onChange();
    for (const o of this.overlays.filter((x) => x.visible)) this.shapes.set(o.id, await getOverlayFeatures(o.id));
    if (this.shapes.size) this.draw();
  }

  private addLayers(font: string, underTracks: string): void {
    const map = this.map;
    map.addSource('overlays', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // The map's own names (its first symbol layer, below the tracks') stay above the areas and lines.
    const underNames = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    const k = (...kinds: string[]) => ['in', ['get', 'k'], ['literal', kinds]] as maplibregl.ExpressionSpecification;
    map.addLayer({ id: 'overlay-fill', type: 'fill', source: 'overlays', filter: k('area'),
      paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] } }, underNames);
    map.addLayer({ id: 'overlay-line', type: 'line', source: 'overlays', filter: k('area', 'line'), layout: { 'line-join': 'round' },
      paint: { 'line-color': ['get', 'line'], 'line-opacity': ['get', 'lineOpacity'], 'line-width': ['get', 'lineWidth'] } }, underNames);
    map.addLayer({ id: 'overlay-line-label', type: 'symbol', source: 'overlays', filter: ['all', k('line'), ['!=', ['get', 'name'], '']],
      layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12 },
      paint: { 'text-color': ['get', 'line'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, underTracks);
    map.addLayer({ id: 'overlay-point', type: 'circle', source: 'overlays', filter: k('point'),
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 5], 'circle-color': ['get', 'fill'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } }, underTracks);
    // Names from town zoom on: further out, a city's worth of places would be a heap of names.
    map.addLayer({ id: 'overlay-label', type: 'symbol', source: 'overlays', minzoom: 11, filter: ['all', k('point', 'label'), ['!=', ['get', 'name'], '']],
      layout: {
        'text-field': ['get', 'name'], 'text-font': [font], 'text-size': 12, 'text-max-width': 9, 'text-optional': true,
        'text-anchor': ['case', ['==', ['get', 'k'], 'point'], 'top', 'center'],
        'text-offset': ['case', ['==', ['get', 'k'], 'point'], ['literal', [0, 0.7]], ['literal', [0, 0]]],
      },
      paint: { 'text-color': ['get', 'line'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } }, underTracks);
  }

  /** The overlays, in the order added. */
  get all(): StoredOverlay[] {
    return this.overlays;
  }

  /** Stores and shows KML/KMZ files; a file that can't be read is named in `problems`. */
  async importFiles(files: File[]): Promise<{ added: StoredOverlay[]; problems: string[] }> {
    await this.loaded;
    const added: StoredOverlay[] = [];
    const problems: string[] = [];
    for (const file of files) {
      try {
        const { features, ...rest } = await readOverlayFile(file.name, new Uint8Array(await file.arrayBuffer()));
        const o: StoredOverlay = { ...rest, id: newId(), visible: true, added: Date.now() };
        await addOverlay(o, features);
        this.overlays.push(o);
        this.shapes.set(o.id, features);
        added.push(o);
      } catch (err) {
        problems.push(`“${file.name}” couldn’t be added: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (added.length) {
      this.draw();
      this.onChange();
    }
    return { added, problems };
  }

  /** Fits overlay `o` in view, clear of `panel` while it's open. */
  zoomTo(o: StoredOverlay, panel: HTMLElement): void {
    const [w, s, e, n] = o.bounds;
    fitClearOf(this.map, panel, [[w, s], [e, n]], 16);
  }

  /** Hands the visible overlays' shapes to the map, in list order. */
  private draw(): void {
    const features = this.overlays.flatMap((o) => this.shapes.get(o.id) ?? []);
    (this.map.getSource('overlays') as maplibregl.GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
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
    if (!visible) this.shapes.delete(o.id);
    else {
      const features = await getOverlayFeatures(o.id);
      if (!o.visible || !this.overlays.includes(o)) return; // hidden or removed meanwhile
      this.shapes.set(o.id, features);
    }
    this.draw();
  }

  async remove(id: string): Promise<void> {
    await deleteOverlay(id);
    this.overlays = this.overlays.filter((x) => x.id !== id);
    if (this.shapes.delete(id)) this.draw();
    this.onChange();
  }
}
