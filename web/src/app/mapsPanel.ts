import type * as maplibregl from 'maplibre-gl';
import { contains, coverage, coverageText, elevationFor, filesText, hillshadingText, type MapInfo, type SetInfo } from '../storage/library';
import { changeChoices, clearStored, downloadMap, importElevation, importFiles, removeSet, requestPersistence, type ImportChoices, type Library } from '../storage/store';
import { HGT_STEP } from '../dem/hgt';
import { acceptDrops, extensions } from '../ui/drop';
import { editName } from '../ui/rename';

/** The free OpenStreetMap-based map of Iceland, through the download pass-through (web/download-worker). */
const FREE_MAP_URL = 'https://download.vardamaps.app/iceland.zip';
const FREE_MAP_NAME = 'Freizeitkarte Iceland (OpenStreetMap).img';

/** What the maps UI needs from the viewer (or, with no map open, from the start-up screen). */
export interface MapsHost {
  /** What's stored, read again. */
  library(): Promise<Library>;
  /** The map shown and the set its hillshading comes from (none: no map is open). */
  current(): { id: string; set: SetInfo | null } | null;
  /** The middle of the screen (none: no map is open). */
  center(): [number, number] | null;
  /** Shows map `id` here (keeping the view when it covers it); rejects with the reason it couldn't. */
  switchTo(id: string): Promise<void>;
  /** Draws the map shown again when its elevation set should change (a choice, a set added or
   *  removed; `without`: a set about to be removed). */
  refresh(without?: string): Promise<void>;
  /** Adds a map (`store` copies it and resolves to its id). With a map open, that one stays shown;
   *  with none, the new one is shown. Rejects when it couldn't be added. */
  add(store: () => Promise<string>): Promise<void>;
  /** Removes a map (another one is shown when it was this one; none left: the empty panel). */
  removeMap(id: string): Promise<void>;
  /** Something stored changed (names, maps): labels elsewhere follow. */
  changed(lib: Library): void;
}

const LAYERS_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const CLOSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const BACK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const formatBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
export const resolutionText = (step: number) => (step > HGT_STEP ? '1″ (about 30 m)' : '3″ (about 90 m)');
const dateText = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
/** "this iPhone" where we can tell, else "this device". */
const device = () => (/iPhone/.test(navigator.userAgent) ? 'this iPhone' : /iPad/.test(navigator.userAgent) ? 'this iPad' : 'this device');
/** Opened from the Home Screen (where storage stays), not in a Safari tab. */
const onHomeScreen = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

type El = HTMLElement;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...kids: Array<Node | string | null | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** A row: name and a line under it, with something before (radio, tick) and after (chevron). */
function row(name: string, sub: string, opts: { lead?: El; trail?: El; checked?: boolean; role?: string; current?: boolean } = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'row', role: opts.role, ...(opts.checked !== undefined ? { 'aria-checked': String(opts.checked) } : {}), ...(opts.current ? { 'aria-current': 'true' } : {}) },
    opts.lead ?? null,
    h('span', { class: 't' }, h('span', { class: 'n', text: name }), sub ? h('span', { class: 's', text: sub }) : null),
    opts.trail ?? null);
  return b;
}
const radio = () => h('span', { class: 'radio', 'aria-hidden': 'true' });
const chev = () => h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' });
const tick = (on: boolean) => h('span', { class: 'tick', 'aria-hidden': 'true', text: on ? '✓' : '' });

/** The map button (under ⋯; shown once there's a choice to make). */
export class MapsButton implements maplibregl.IControl {
  readonly container = h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' });
  readonly button = h('button', { type: 'button', id: 'maps-button', class: 'maps-button', 'aria-label': 'Choose map', title: 'Choose map', 'aria-controls': 'map-picker', 'aria-expanded': 'false', html: LAYERS_ICON });

  constructor() {
    this.container.append(this.button);
    this.container.hidden = true;
  }

  onAdd(): HTMLElement {
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}

type View = { kind: 'list' } | { kind: 'map'; id: string; renaming?: boolean } | { kind: 'set'; id: string; renaming?: boolean };

/** With no map open: the panel is the whole screen (the first start, or a map that won't open). */
export interface Standalone {
  /** Why no map is open, shown under the title. */
  error?: string;
  /** The map that couldn't be opened. */
  failed?: string;
  /** Storage couldn't be read: only removing what's stored is offered. */
  unreadable?: boolean;
  /** Data is stored that doesn't make a map: offer to remove it. */
  leftovers?: boolean;
}

/** The map picker (from the map button) and ⋯ → Maps: switching maps, their hillshading, adding,
 *  renaming and removing maps and elevation sets. Also the first screen, before there's a map. */
export class MapsUi {
  readonly mapsButton = new MapsButton();
  private readonly picker = document.getElementById('map-picker')!;
  private readonly panel = document.getElementById('maps-panel')!;
  private view: View = { kind: 'list' };
  private lib: Library | null = null;
  private busy = false;
  private message = '';
  private messageIsError = false;

  constructor(private readonly host: MapsHost, private readonly standalone: Standalone | null = null) {
    this.panel.classList.toggle('standalone', !!standalone);
    this.mapsButton.button.onclick = () => this.showPicker(this.picker.hidden !== false);
    for (const el of [this.picker, this.panel]) {
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (el === this.picker) this.showPicker(false);
        else if (!this.standalone) this.showPanel(false); // nothing behind the standalone panel
      });
    }
    acceptDrops(this.panel, (files) => this.dropped(files), extensions('img', 'hgt'));
  }

  /** Files dropped on the panel: a map (with any elevation files dropped with it as its hillshading),
   *  or elevation files alone, added to the set shown or stored as a new one. */
  private dropped(files: File[]): void {
    const img = extensions('img');
    const imgs = files.filter((f) => img(f.name));
    const hgt = files.filter((f) => !img(f.name));
    if (imgs.length > 1) {
      if (!this.stillBusy()) this.showError('Drop one map (.img file) at a time.');
      return;
    }
    if (imgs.length) this.storeMap((onProgress, opts) => importFiles(imgs[0], hgt, onProgress, opts));
    else this.addElevation(hgt, this.view.kind === 'set' ? this.view.id : null);
  }

  private showError(text: string): void {
    this.message = text;
    this.messageIsError = true;
    this.redraw();
  }

  /** Reads the library again and shows it wherever it's open. */
  async reload(): Promise<Library> {
    const lib = await this.host.library();
    this.lib = lib;
    this.host.changed(lib); // labels elsewhere, and the map button shown once there's a choice
    this.redraw();
    return lib;
  }

  /** Draws whichever is open again; a name being typed isn't drawn over. */
  private redraw(): void {
    if (!this.picker.hidden) this.renderPicker();
    if (!this.panel.hidden && !('renaming' in this.view && this.view.renaming)) this.renderPanel();
  }

  showPicker(open: boolean): void {
    this.picker.hidden = !open;
    this.mapsButton.button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.panel.hidden = true;
    this.message = '';
    this.renderPicker();
    this.picker.querySelector<HTMLElement>('h2')?.focus();
    void this.reload();
  }

  showPanel(open: boolean, view: View = { kind: 'list' }): void {
    this.panel.hidden = !open;
    if (!open) return;
    this.showPicker(false);
    this.view = view;
    this.message = '';
    this.renderPanel();
    this.panel.querySelector<HTMLElement>('h2')?.focus();
    void this.reload();
  }

  /** Says so (and is true) while a change is still running. */
  private stillBusy(): boolean {
    if (!this.busy) return false;
    this.progress('Wait until this has finished.');
    return true;
  }

  /** Runs a change: one at a time, its error shown in the panel, then everything read again. */
  private async act(what: () => Promise<void>, done?: string): Promise<void> {
    if (this.stillBusy()) return;
    this.busy = true;
    this.message = '';
    try {
      await what();
      this.message = done ?? '';
      this.messageIsError = false;
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      this.messageIsError = true;
    } finally {
      this.busy = false;
    }
    await this.reload().catch((err) => {
      console.warn('maps', err);
      this.redraw();
    });
  }

  private progress(text: string): void {
    this.message = text;
    this.messageIsError = false;
    const note = this.panel.querySelector('.status');
    if (note) note.textContent = text;
  }

  private head(title: string, id: string, onClose: () => void, back?: () => void): El {
    // Nothing to close to when no map is open.
    const close = this.standalone ? null : h('button', { type: 'button', class: 'close', 'aria-label': 'Close', html: CLOSE_ICON });
    if (close) close.onclick = onClose;
    if (back) {
      const b = h('button', { type: 'button', class: 'back', html: BACK_ICON });
      b.append('Maps');
      b.onclick = back;
      return h('div', { class: 'tracks-head' }, b, close);
    }
    return h('div', { class: 'tracks-head' }, h('h2', { id, tabindex: '-1', text: title }), close);
  }

  private status(): El {
    return h('p', { class: `note status${this.messageIsError ? ' error' : ''}`, role: 'status', text: this.message });
  }

  private setFor(m: MapInfo): SetInfo | null {
    return this.lib ? elevationFor(m, this.lib.sets) : null;
  }

  /** The map shown and its set (an id matching no map when none is open). */
  private get cur(): { id: string; set: SetInfo | null } {
    return this.host.current() ?? { id: '', set: null };
  }

  // ---- the picker ----

  private renderPicker(): void {
    const lib = this.lib;
    const out: Array<Node> = [this.head('Map', 'map-picker-title', () => this.showPicker(false))];
    if (lib) {
      const cur = this.cur;
      const at = this.host.center();
      for (const m of lib.maps) {
        const isCur = m.id === cur.id;
        const set = isCur ? cur.set : this.setFor(m);
        const sub = [hillshadingText(set), m.bounds && at && !contains(m.bounds, at) ? 'not where you are' : ''].filter(Boolean).join(' · ');
        const r = row(m.name, sub, { role: 'menuitemradio', checked: isCur, trail: tick(isCur) });
        r.onclick = () => isCur || void this.act(() => this.host.switchTo(m.id));
        out.push(r);
      }
      const curMap = lib.maps.find((m) => m.id === cur.id);
      const offered = lib.sets.filter((s) => !curMap?.bounds || coverage(s, curMap.bounds) > 0 || s.id === cur.set?.id);
      if (curMap && (offered.length || cur.set)) {
        out.push(h('h3', { text: 'Hillshading' }));
        const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Hillshading' });
        for (const choice of [...offered, null]) {
          const on = (choice?.id ?? null) === (cur.set?.id ?? null);
          const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), text: choice ? choice.name : 'Off' });
          b.onclick = () => on || !cur.id || void this.act(() => this.chooseElevation(cur.id, choice?.id ?? null));
          seg.append(b);
        }
        out.push(seg);
      }
      out.push(this.status());
      const manage = h('button', { type: 'button', class: 'item link', id: 'maps-manage', text: 'Manage maps…' });
      manage.onclick = () => this.showPanel(true);
      out.push(manage);
    }
    this.picker.replaceChildren(...out);
  }

  private async chooseElevation(mapId: string, choice: string | null): Promise<void> {
    await changeChoices((c) => void ((c.maps[mapId] ??= {}).elevation = choice));
    if (mapId === this.host.current()?.id) await this.host.refresh();
  }

  // ---- ⋯ → Maps ----

  private renderPanel(): void {
    const v = this.view;
    const lib = this.lib;
    const close = () => this.showPanel(false);
    const back = () => {
      this.view = { kind: 'list' };
      this.message = '';
      this.renderPanel();
      this.panel.querySelector<HTMLElement>('h2')?.focus();
    };
    let out: Node[];
    if (!lib) out = [this.head('Maps', 'maps-title', close)];
    else if (v.kind === 'map') out = this.mapDetails(lib, v.id, !!v.renaming, close, back);
    else if (v.kind === 'set') out = this.setDetails(lib, v.id, !!v.renaming, close, back);
    else out = this.list(lib, close);
    this.panel.replaceChildren(...out);
  }

  private list(lib: Library, close: () => void): Node[] {
    const cur = this.cur;
    const out: Node[] = [this.head('Maps', 'maps-title', close)];
    if (this.standalone?.error) out.push(h('p', { class: 'note error', role: 'alert', text: this.standalone.error }));
    if (this.standalone?.unreadable) {
      out.push(this.removeAll());
      return out;
    }
    const first = !lib.maps.length;
    if (first) out.push(h('p', { class: 'note intro', text: 'Add a Garmin map: its .img file, from this device or iCloud Drive. Maps and elevation files are stored on this device only.' }));
    for (const m of lib.maps) {
      const isCur = m.id === cur.id;
      const set = isCur ? cur.set : this.setFor(m);
      const pick = h('button', { type: 'button', class: 'row pick', role: 'radio', 'aria-checked': String(isCur), 'aria-label': `Show ${m.name}` }, radio());
      pick.onclick = () => isCur || void this.act(() => this.host.switchTo(m.id));
      const sub = m.id === this.standalone?.failed ? "Couldn't be opened" : `${formatBytes(m.bytes)} · ${set ? `hillshading ${set.name}` : 'no hillshading'}`;
      const open = row(m.name, sub, { trail: chev(), current: isCur });
      open.onclick = () => this.go({ kind: 'map', id: m.id });
      out.push(h('div', { class: 'split map-row' }, pick, open));
    }
    out.push(this.filesButton('Add a map', 'maps-add', ([file]) => this.addMap(file), 'add', false));
    const download = h('button', { type: 'button', class: 'item link', id: 'maps-download', text: 'Download the free map of Iceland' });
    download.onclick = () => this.download();
    out.push(download);
    if (first) out.push(h('p', { class: 'note', text: 'Made from OpenStreetMap: roads, trails, places and contour lines, with routing (Freizeitkarte, 255 MB). Keep the app open while it downloads.' }));
    out.push(h('h3', { text: 'Elevation for hillshading' }));
    for (const s of lib.sets) {
      const users = lib.maps.filter((m) => (m.id === cur.id ? cur.set : this.setFor(m))?.id === s.id).length;
      const r = row(s.name, `${filesText(s.files.length)} · ${formatBytes(s.bytes)} · ${users ? `used by ${users} map${users === 1 ? '' : 's'}` : 'not used'}`, { trail: chev() });
      r.classList.add('set-row');
      r.onclick = () => this.go({ kind: 'set', id: s.id });
      out.push(r);
    }
    if (!lib.sets.length) out.push(h('p', { class: 'note', text: 'Elevation files (.hgt) draw the hills’ shading and give heights along tracks.' }));
    out.push(this.filesButton('Add elevation files', 'maps-add-elevation', (files) => this.addElevation(files, null)));
    out.push(this.status());
    if (lib.maps.length || lib.sets.length) {
      const usage = h('div', { class: 'storage' });
      out.push(usage);
      void this.showStorage(usage, lib);
    }
    if (this.standalone && !onHomeScreen()) out.push(h('p', { class: 'note', id: 'home-hint', text: 'Tip: add this app to your Home Screen first (Share → Add to Home Screen) so your maps stay stored.' }));
    if (this.standalone?.leftovers) out.push(this.removeAll());
    return out;
  }

  /** Removes everything stored (data that doesn't make a map, or storage that can't be read). */
  private removeAll(): El {
    const remove = h('button', { type: 'button', class: 'item danger', id: 'remove-stored', text: 'Remove stored data' });
    remove.onclick = () => {
      if (!confirm(`Remove the stored maps and elevation files from ${device()}? You will need the files to add them again.`)) return;
      void this.act(async () => {
        await clearStored();
        location.reload();
      });
    };
    return h('div', {}, remove, this.status());
  }

  /** Stores a map (`store` resolves to its id). With a map open it's only added to the list (the
   *  panel stays open; the map shown stays); the first map is shown. */
  private storeMap(store: (onProgress: (m: string) => void, opts: ImportChoices) => Promise<string>): void {
    void this.act(async () => {
      await requestPersistence().catch(() => false); // best effort: never block an import on it
      await this.host.add(() => store((m) => this.progress(m), { current: !!this.standalone }));
      this.view = { kind: 'list' };
    }, 'Map added.');
  }

  private addMap(file: File): void {
    this.storeMap((onProgress, opts) => importFiles(file, [], onProgress, opts));
  }

  private download(): void {
    if (this.stillBusy()) return;
    if (!navigator.onLine) {
      this.showError('You are offline. Connect to the internet to download the map.');
      return;
    }
    this.storeMap((onProgress, opts) => downloadMap(FREE_MAP_URL, FREE_MAP_NAME, onProgress, opts));
  }

  private go(view: View): void {
    this.view = view;
    this.message = '';
    this.renderPanel();
    this.panel.querySelector<HTMLElement>('.title')?.focus();
  }

  private async showStorage(into: El, lib: Library): Promise<void> {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (!est?.quota || est.usage == null) return;
    const mapBytes = lib.maps.reduce((n, m) => n + m.bytes, 0);
    const setBytes = lib.sets.reduce((n, s) => n + s.bytes, 0);
    const pct = (n: number) => `${Math.min(100, (n / est.quota!) * 100).toFixed(1)}%`;
    into.replaceChildren(
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${pct(mapBytes)};background:var(--accent)` }), h('i', { style: `width:${pct(setBytes)};background:#7b93c6` })),
      h('p', { class: 'note', text: `${formatBytes(est.usage)} used on ${device()} · about ${formatBytes(Math.max(0, est.quota - est.usage))} free for the app` }),
    );
  }

  /** A button that picks files and hands them on (a hidden input each, so iOS shows its picker). */
  private filesButton(label: string, id: string, take: (files: File[]) => void, cls = 'item link', multiple = true): El {
    const input = h('input', { type: 'file', ...(multiple ? { multiple: '' } : {}), hidden: '', id: `${id}-input` });
    const b = h('button', { type: 'button', class: cls, id, text: label });
    b.onclick = () => this.stillBusy() || input.click();
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      if (files.length) take(files);
    };
    return h('div', {}, b, input);
  }

  private addElevation(files: File[], into: string | null): void {
    void this.act(async () => {
      await importElevation(files, into, (m) => this.progress(m));
      // A new set may now be the best one for the map shown; an added-to one has new files.
      await this.host.refresh();
    }, into ? 'Elevation files added.' : 'Elevation files stored.');
  }

  /** The name field of Tracks and Saved places (an unchanged name or Escape cancels). */
  private renameForm(current: string, save: (name: string) => Promise<void>, cancel: () => void): El {
    const box = h('div', { class: 'rename' });
    editName(box, current, (name) => void save(name), cancel);
    // editName focuses the field, which only takes once it's on the page.
    setTimeout(() => {
      const input = box.querySelector('input');
      input?.focus();
      input?.select();
    }, 0);
    return box;
  }

  private mapDetails(lib: Library, id: string, renaming: boolean, close: () => void, back: () => void): Node[] {
    const m = lib.maps.find((x) => x.id === id);
    if (!m) return [this.head('Maps', 'maps-title', close, back), h('p', { class: 'note', text: 'This map is no longer stored.' })];
    const cur = this.cur;
    const isCur = m.id === cur.id;
    const set = isCur ? cur.set : this.setFor(m);
    const out: Node[] = [this.head('', '', close, back)];
    if (renaming) {
      out.push(this.renameForm(m.name, (name) => this.act(async () => {
        await changeChoices((c) => void ((c.maps[m.id] ??= {}).name = name));
        this.view = { kind: 'map', id };
      }), () => this.go({ kind: 'map', id })));
    } else out.push(h('h2', { class: 'title', tabindex: '-1', id: 'maps-title', text: m.name }));
    out.push(h('p', { class: 'note', text: [m.imgName, formatBytes(m.bytes), m.added ? `added ${dateText(m.added)}` : ''].filter(Boolean).join(' · ') }));
    out.push(h('h3', { text: 'Hillshading' }));
    const group = h('div', { role: 'radiogroup', 'aria-label': 'Hillshading' });
    for (const s of [...lib.sets, null]) {
      const on = (s?.id ?? null) === (set?.id ?? null);
      const r = row(s ? s.name : 'Off', s && m.bounds ? coverageText(coverage(s, m.bounds)) : '', { lead: radio(), role: 'radio', checked: on });
      r.onclick = () => on || void this.act(() => this.chooseElevation(m.id, s?.id ?? null));
      group.append(r);
    }
    out.push(group);
    if (!lib.sets.length) out.push(h('p', { class: 'note', text: 'No elevation files are stored. Add them in Maps.' }));
    if (!isCur) {
      const show = h('button', { type: 'button', class: 'item link', id: 'map-show', text: 'Show this map' });
      show.onclick = () => void this.act(async () => {
        await this.host.switchTo(m.id);
        if (!this.standalone) this.showPanel(false); // standalone: the page is starting again with it
      });
      out.push(show);
    }
    const rename = h('button', { type: 'button', class: 'item', id: 'map-rename', text: 'Rename' });
    rename.onclick = () => this.go({ kind: 'map', id, renaming: true });
    const remove = h('button', { type: 'button', class: 'item danger', id: 'map-remove', text: `Remove from ${device()}` });
    remove.onclick = () => {
      const last = lib.maps.length === 1;
      if (!confirm(`Remove “${m.name}” from ${device()}?${last ? ' It is the only map stored.' : ''} You will need the map file to add it again.`)) return;
      void this.act(async () => {
        await this.host.removeMap(m.id);
        this.view = { kind: 'list' };
      });
    };
    out.push(rename, remove, this.status());
    return out;
  }

  private setDetails(lib: Library, id: string, renaming: boolean, close: () => void, back: () => void): Node[] {
    const s = lib.sets.find((x) => x.id === id);
    if (!s) return [this.head('Maps', 'maps-title', close, back), h('p', { class: 'note', text: 'These elevation files are no longer stored.' })];
    const cur = this.cur;
    const users = lib.maps.filter((m) => (m.id === cur.id ? cur.set : this.setFor(m))?.id === s.id);
    const out: Node[] = [this.head('', '', close, back)];
    if (renaming) {
      out.push(this.renameForm(s.name, (name) => this.act(async () => {
        await changeChoices((c) => void ((c.sets[s.id] ??= {}).name = name));
        this.view = { kind: 'set', id };
      }), () => this.go({ kind: 'set', id })));
    } else out.push(h('h2', { class: 'title', tabindex: '-1', id: 'maps-title', text: s.name }));
    out.push(h('p', { class: 'note', text: `${filesText(s.files.length)} · ${resolutionText(s.step)} · ${formatBytes(s.bytes)}` }));
    out.push(coverSketch(s, lib.maps.find((m) => m.id === cur.id)?.bounds ?? null), h('p', { class: 'note', text: 'Where the files have elevation (dashed: the map shown)' }));
    out.push(h('h3', { text: 'Used by' }));
    if (!users.length) out.push(h('p', { class: 'note', text: 'No map uses these files now.' }));
    for (const m of users) {
      const r = row(m.name, '', { trail: chev() });
      r.onclick = () => this.go({ kind: 'map', id: m.id });
      out.push(r);
    }
    out.push(this.filesButton('Add more files to this set', 'set-add-files', (files) => this.addElevation(files, s.id)));
    const rename = h('button', { type: 'button', class: 'item', id: 'set-rename', text: 'Rename' });
    rename.onclick = () => this.go({ kind: 'set', id, renaming: true });
    const remove = h('button', { type: 'button', class: 'item danger', id: 'set-remove', text: `Remove from ${device()}` });
    remove.onclick = () => {
      if (!confirm(`Remove “${s.name}” from ${device()}?${users.length ? ' Maps that use it will be drawn without hillshading.' : ''}`)) return;
      void this.act(async () => {
        // The map shown lets go of the files first.
        await this.host.refresh(s.id);
        await removeSet(s.id);
        await this.host.refresh();
        this.view = { kind: 'list' };
      });
    };
    out.push(rename, remove);
    if (users.length) out.push(h('p', { class: 'note', text: 'Maps that use it will be drawn without hillshading.' }));
    out.push(this.status());
    return out;
  }
}

/** The set's 1° squares, with the map shown's area dashed over them. */
function coverSketch(s: SetInfo, map: [number, number, number, number] | null): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const souths = s.squares.map((q) => q.south);
  const wests = s.squares.map((q) => q.west);
  let [w, so, e, n] = [Math.min(...wests), Math.min(...souths), Math.max(...wests) + 1, Math.max(...souths) + 1];
  if (map) [w, so, e, n] = [Math.min(w, Math.floor(map[0])), Math.min(so, Math.floor(map[1])), Math.max(e, Math.ceil(map[2])), Math.max(n, Math.ceil(map[3]))];
  // Degrees of longitude drawn narrower by the latitude, as on the map.
  const k = Math.cos((((so + n) / 2) * Math.PI) / 180);
  const pad = 0.3;
  const W = (e - w) * k + 2 * pad;
  const H = n - so + 2 * pad;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'cover');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${s.squares.length} squares of one degree`);
  const x = (lon: number) => pad + (lon - w) * k;
  const y = (lat: number) => pad + (n - lat);
  for (const q of s.squares) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(x(q.west)));
    r.setAttribute('y', String(y(q.south + 1)));
    r.setAttribute('width', String(k));
    r.setAttribute('height', '1');
    r.setAttribute('fill', '#1d3f8f33');
    r.setAttribute('stroke', '#1d3f8f');
    r.setAttribute('stroke-width', String(H / 160));
    svg.append(r);
  }
  if (map) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(x(map[0])));
    r.setAttribute('y', String(y(map[3])));
    r.setAttribute('width', String((map[2] - map[0]) * k));
    r.setAttribute('height', String(map[3] - map[1]));
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', '#1d2a38');
    r.setAttribute('stroke-width', String(H / 90));
    r.setAttribute('stroke-dasharray', `${H / 30} ${H / 50}`);
    svg.append(r);
  }
  return svg;
}
