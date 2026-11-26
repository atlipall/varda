import * as maplibregl from 'maplibre-gl';
import { cluster } from '../photos/cluster';
import { byTime, type Photo } from '../photos/photo';

/** Photos closer than this on screen (px) are one thumbnail with a count. */
const GROUP_PX = 56;
/** The view moved less than this (px) since the photos were grouped, at the same zoom and turn:
 *  they're left as they are (while following the position, the map stops moving on every fix). */
const STILL_PX = 8;

/** What the groups were made for. */
interface Grouped {
  zoom: number;
  bearing: number;
  pitch: number;
  center: maplibregl.LngLat;
  width: number;
  height: number;
}

/**
 * Photos on the map: round thumbnails at their spot, those close together on screen as one with a
 * count, regrouped when the map stops moving. A tap opens the group's photos.
 */
export class PhotoLayer {
  private photos: Photo[] = [];
  /** The markers drawn, by their photos' ids joined. */
  private markers = new Map<string, maplibregl.Marker>();
  private visible = true;
  private grouped: Grouped | null = null;

  constructor(
    private readonly map: maplibregl.Map,
    /** The thumbnail's address (an object URL), when it's here. */
    private readonly thumb: (id: string) => Promise<string | null>,
    private readonly open: (photos: Photo[]) => void,
  ) {
    map.on('moveend', () => this.still() || this.draw());
  }

  set(photos: Photo[]): void {
    this.photos = photos;
    // New photo records (a spot or description may have changed): new markers.
    for (const m of this.markers.values()) m.remove();
    this.markers.clear();
    this.draw();
  }

  show(on: boolean): void {
    this.visible = on;
    this.draw();
  }

  /** The groups as drawn (for tests): each one's photo ids. */
  get groups(): string[][] {
    return [...this.markers.keys()].map((k) => k.split(','));
  }

  /** Whether the view is (nearly) the one the photos were grouped for. */
  private still(): boolean {
    const g = this.grouped;
    const map = this.map;
    if (!g) return false;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    if (w !== g.width || h !== g.height || map.getZoom() !== g.zoom || map.getBearing() !== g.bearing || map.getPitch() !== g.pitch) return false;
    const a = map.project(g.center);
    return Math.hypot(a.x - w / 2, a.y - h / 2) < STILL_PX;
  }

  private draw(): void {
    const map = this.map;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    this.grouped = { zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), center: map.getCenter(), width: w, height: h };
    const keep = new Map<string, maplibregl.Marker>();
    const groups = this.visible ? this.group(w, h) : [];
    for (const g of groups) {
      const key = g.map((p) => p.id).join(',');
      const m = this.markers.get(key);
      if (m) {
        // The same photos (so the same first one, at the same spot): the marker stays.
        this.markers.delete(key);
        keep.set(key, m);
      } else keep.set(key, this.marker(g));
    }
    for (const m of this.markers.values()) m.remove();
    this.markers = keep;
  }

  /** The photos on screen (and just off it), grouped. */
  private group(w: number, h: number): Photo[][] {
    if (!this.photos.length) return [];
    const pad = GROUP_PX;
    const pts = [...this.photos].sort(byTime).flatMap((p) => {
      const { x, y } = this.map.project([p.lon, p.lat]);
      return x < -pad || y < -pad || x > w + pad || y > h + pad ? [] : [{ item: p, x, y }];
    });
    return cluster(pts, GROUP_PX).map((g) => g.items);
  }

  /** A group's thumbnail on the map, at its first photo. */
  private marker(items: Photo[]): maplibregl.Marker {
    const first = items[0];
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'photo-pin';
    el.dataset.ids = items.map((p) => p.id).join(',');
    el.setAttribute('aria-label', items.length === 1 ? 'Photo' : `${items.length} photos`);
    if (items.length > 1) {
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = String(items.length);
      el.append(n);
    }
    // The map shouldn't take the tap as one of its own (a long press picks a place there).
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.open(items);
    });
    void this.thumb(first.id).then((url) => url && (el.style.backgroundImage = `url("${url}")`));
    return new maplibregl.Marker({ element: el }).setLngLat([first.lon, first.lat]).addTo(this.map);
  }
}
