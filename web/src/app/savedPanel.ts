import type * as maplibregl from 'maplibre-gl';
import { deleteSaved, listSaved, putSaved, type Saved, type SavedPin } from '../saved/saved';
import { listTracks, putTrack, type StoredTrack } from '../gpx/store';
import { backupFileName, makeBackup, parseBackup, toStore } from '../saved/backup';
import { deletions, noteDeleted, setDeletions } from '../saved/deleted';
import { shareFile } from '../gpx/export';
import { coordsText } from './route';
import { acceptDrops, extensions } from '../ui/drop';
import { editName, renameButton } from '../ui/rename';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A delete button asks "Delete?" and needs a second tap within this time (ms). */
const CONFIRM_MS = 3000;
const TRASH = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STAR = '★';

/** The list line under a saved pin's name. */
export const savedDetails = (s: SavedPin): string => coordsText(s);

/** A small gold star with a dark outline, for saved pins on the map. */
function starImage(): ImageData {
  const size = 44; // 2x for sharp edges on high-density screens
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? size * 0.2 : size * 0.46;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    g.lineTo(size / 2 + r * Math.cos(a), size / 2 + 2 + r * Math.sin(a));
  }
  g.closePath();
  g.fillStyle = '#f4b400';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = '#6b4e00';
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

/**
 * The Saved panel (⋯ → Saved): pins saved from a place's card, kept on the device and shown on the
 * map as stars; a tap on one (or on it in the list) opens its card. Routes are saved as tracks
 * (the Tracks panel); routes saved here before that are deleted (./savedPanel.ts `reload`).
 */
export class SavedPanel {
  private items: SavedPin[] = [];
  /** Called after a change made here (save, rename, delete, restore), for syncing. */
  onChanged: (() => void) | null = null;
  private readonly panel = $('saved');
  private readonly list = $<HTMLUListElement>('saved-list');
  private readonly error = $('saved-error');

  constructor(
    private readonly map: maplibregl.Map,
    font: string,
    private readonly openPin: (p: SavedPin) => void,
    /** Reads the GPX tracks again after a restore brought some in. */
    private readonly reloadTracks: () => Promise<void>,
    /** The GPX tracks as the Tracks panel holds them. */
    private readonly tracksNow: () => StoredTrack[] = () => [],
  ) {
    map.addImage('saved-star', starImage(), { pixelRatio: 2 });
    // A switch to another map that MapLibre can't apply as a change rebuilds the style without it.
    map.on('styleimagemissing', (e) => {
      if (e.id === 'saved-star' && !map.hasImage('saved-star')) map.addImage('saved-star', starImage(), { pixelRatio: 2 });
    });
    map.addSource('saved', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'saved-pins',
      type: 'symbol',
      source: 'saved',
      layout: {
        'icon-image': 'saved-star',
        'icon-allow-overlap': true,
        'text-field': ['get', 'name'],
        'text-font': [font],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-color': '#4a3700', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
    map.on('click', 'saved-pins', (e) => {
      const id = e.features?.[0]?.properties?.id;
      const pin = this.items.find((s) => s.id === id);
      if (pin) this.openPin(pin);
    });
    map.on('mouseenter', 'saved-pins', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'saved-pins', () => (map.getCanvas().style.cursor = ''));
    $('saved-close').onclick = () => this.show(false);
    $('backup-save').onclick = () => void this.backup().catch((err) => this.fail(err));
    const input = $<HTMLInputElement>('backup-file');
    $('backup-restore').onclick = () => input.click();
    input.onchange = () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) this.restoreFile(file);
    };
    acceptDrops($('sync-panel'), ([file]) => this.restoreFile(file), extensions('json'));
    void this.reload();
  }

  /** Reads the saved items from storage again (after a restore or a sync). */
  async reload(): Promise<void> {
    try {
      const all = await listSaved();
      // Routes saved before they became tracks: gone (deleted everywhere, through sync).
      const routes = all.filter((s) => s.kind !== 'pin');
      for (const r of routes) {
        await deleteSaved(r.id);
        noteDeleted(r.id);
      }
      this.items = all.filter((s): s is SavedPin => s.kind === 'pin');
      this.refresh();
      if (routes.length) this.onChanged?.();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Everything saved plus the GPX tracks, as one file (the share sheet on a phone, else a download). */
  /** Built from what the panels already hold, without waiting on storage: iOS lets a tap open the
   *  share sheet only straight away. */
  private async backup(): Promise<void> {
    this.status('');
    const text = JSON.stringify(makeBackup(this.items, this.tracksNow(), deletions()));
    await shareFile(backupFileName(), text, 'application/json');
  }

  /** Restores a backup, its failure told under the backup buttons (Saved places' own line isn't on screen). */
  private restoreFile(file: File): void {
    void this.restore(file).catch((err) => this.status(`Couldn't restore ${file.name}: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Brings in what a backup has that this device doesn't (or has an older copy of); deletes nothing. */
  private async restore(file: File): Promise<void> {
    this.status('');
    const b = parseBackup(await file.text());
    const saved = toStore(await listSaved(), b.saved.filter((s) => s.kind === 'pin'));
    const tracks = toStore(await listTracks(), b.tracks);
    // Restoring is wanting them back: they count as just changed, which also outweighs a deletion of
    // them remembered here or on another device.
    const now = Date.now();
    const gone = deletions();
    for (const s of saved) {
      await putSaved({ ...s, updated: now });
      delete gone[s.id];
    }
    for (const t of tracks) {
      await putTrack({ ...t, updated: now });
      delete gone[t.id];
    }
    setDeletions(gone);
    await this.reload();
    if (tracks.length) await this.reloadTracks();
    if (saved.length || tracks.length) this.onChanged?.();
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    this.status(saved.length || tracks.length ? `Restored ${n(saved.length, 'saved item', 'saved items')} and ${n(tracks.length, 'track', 'tracks')}.` : 'Nothing new in this backup: everything in it is already here.');
  }

  private status(text: string): void {
    $('backup-status').textContent = text;
    this.error.textContent = '';
  }

  show(open: boolean): void {
    this.panel.hidden = !open;
    if (open) this.error.textContent = '';
  }

  /** Number of saved items (for tests). */
  get count(): number {
    return this.items.length;
  }

  async add(item: Saved): Promise<void> {
    if (item.kind !== 'pin') return;
    await putSaved(item);
    this.items.push(item);
    this.refresh();
    this.onChanged?.();
  }

  /** Deletes an item by id (Undo after saving one elsewhere). */
  async delete(id: string): Promise<void> {
    const s = this.items.find((x) => x.id === id);
    if (s) await this.remove(s);
  }

  private refresh(): void {
    const pins = this.items.filter((s): s is SavedPin => s.kind === 'pin');
    (this.map.getSource('saved') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: pins.map((p) => ({ type: 'Feature', properties: { id: p.id, name: p.name }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
    });
    $('saved-empty').hidden = this.items.length > 0;
    this.list.replaceChildren(...this.items.map((s) => this.row(s)));
  }

  private row(s: SavedPin): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'track saved-item';
    li.dataset.id = s.id;
    const icon = document.createElement('span');
    icon.className = 'saved-icon pin';
    icon.textContent = STAR;
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'track-info';
    info.title = 'Show on the map';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const details = document.createElement('span');
    details.className = 'stats';
    details.textContent = savedDetails(s);
    info.append(name, details);
    info.onclick = () => {
      this.openPin(s);
      if (matchMedia('(pointer: coarse)').matches) this.show(false);
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'track-delete';
    del.setAttribute('aria-label', `Delete ${s.name}`);
    del.innerHTML = TRASH;
    let timer = 0;
    del.onclick = () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm');
        del.textContent = 'Delete?';
        timer = window.setTimeout(() => {
          del.classList.remove('confirm');
          del.innerHTML = TRASH;
        }, CONFIRM_MS);
        return;
      }
      clearTimeout(timer);
      void this.remove(s);
    };
    const rename = renameButton(s.name, () =>
      editName(li, s.name, (name) => void this.rename(s, name), () => li.replaceWith(this.row(s))),
    );
    li.append(icon, info, rename, del);
    return li;
  }

  /** A new name: kept, synced, and shown on its star and in the list. */
  private async rename(s: SavedPin, name: string): Promise<void> {
    s.name = name;
    s.updated = Date.now();
    this.refresh();
    await putSaved(s).catch((err) => this.fail(err));
    this.onChanged?.();
  }

  private async remove(s: Saved): Promise<void> {
    try {
      await deleteSaved(s.id);
      noteDeleted(s.id);
      this.items = this.items.filter((x) => x.id !== s.id);
      this.refresh();
      this.onChanged?.();
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    this.error.textContent = err instanceof Error ? err.message : String(err);
  }
}
