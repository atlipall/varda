import type * as maplibregl from 'maplibre-gl';
import { contains, coverage, coverageText, elevationFor, filesText, hillshadingText, type MapInfo, type SetInfo } from '../storage/library';
import { changeChoices, clearStored, downloadMap, importElevation, importFiles, removeSet, requestPersistence, type ImportChoices, type Library } from '../storage/store';
import { HGT_STEP } from '../dem/hgt';
import { acceptDrops, extensions } from '../ui/drop';
import { editName } from '../ui/rename';

/** The free OpenStreetMap-based map of Iceland, through the download pass-through (web/download-worker). */
const FREE_MAP_URL = 'https://download.vardamaps.app/iceland.zip';
const FREE_MAP_NAME = 'Freizeitkarte Iceland (OpenStreetMap).img';

/** Copies one map into storage, with elevation files `hgt` as a new set; resolves to its id. */
type StoreMap = (hgt: File[], onProgress: (m: string) => void, opts: ImportChoices) => Promise<string>;

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
  /** Adds a map (`store` copies it and resolves to its id); the map shown, if any, stays. Rejects
   *  when it couldn't be added. */
  add(store: () => Promise<string>): Promise<void>;
  /** Removes a map (another one is shown when it was this one; none left: the empty panel). */
  removeMap(id: string): Promise<void>;
  /** Something stored changed (names, maps): labels elsewhere follow. */
  changed(lib: Library): void;
}

const LAYERS_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 12.5l9 5 9-5M3 16.5l9 5 9-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const CLOSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
const INFO_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/><path d="M12 11v6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
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

/** A row: name and a line under it, with something before (a tick) and after (chevron). */
function row(name: string, sub: Array<Node | string>, opts: { lead?: El; trail?: El; checked?: boolean } = {}): HTMLButtonElement {
  const checked = opts.checked === undefined ? {} : { role: 'radio', 'aria-checked': String(opts.checked) };
  return h('button', { type: 'button', class: 'row', ...checked },
    opts.lead ?? null,
    h('span', { class: 't' }, h('span', { class: 'n', text: name }), sub.length ? h('span', { class: 's' }, ...sub) : null),
    opts.trail ?? null);
}
const chev = () => h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' });
/** A label in the middle of a row's line ("… · covers this map"). */
const lower = (s: string) => s.replace(/^./, (x) => x.toLowerCase());
const tick = () => h('span', { class: 'tick', 'aria-hidden': 'true', text: '✓' });

/** The map button, top right under ⋯: opens the Maps panel. */
export class MapsButton implements maplibregl.IControl {
  readonly container = h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' });
  readonly button = h('button', { type: 'button', id: 'maps-button', class: 'maps-button', 'aria-label': 'Maps', title: 'Maps', 'aria-controls': 'maps-panel', 'aria-expanded': 'false', html: LAYERS_ICON });

  constructor() {
    this.container.append(this.button);
  }

  onAdd(): HTMLElement {
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}

type View = { kind: 'list' } | { kind: 'map'; id: string; renaming?: boolean } | { kind: 'set'; id: string; renaming?: boolean };

/** The map ticked in the list and the elevation set ticked for it (null: none). Nothing is shown
 *  or saved until Apply. */
interface Pick {
  map: string;
  set: string | null;
}

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

/** The Maps panel (the map button, ⋯ → Maps, Settings' map row): a map and its hillshading are
 *  ticked and shown with Apply; maps and elevation files are added, renamed and removed. Also the
 *  first screen, before there's a map. */
export class MapsUi {
  readonly mapsButton = new MapsButton();
  private readonly panel = document.getElementById('maps-panel')!;
  private view: View = { kind: 'list' };
  private lib: Library | null = null;
  /** `lib` as last read, to tell whether a read changed anything. */
  private libJson = '';
  /** The browser's storage figures, read when what's stored changes (not on every tap). */
  private estimate: StorageEstimate | null = null;
  private pick: Pick | null = null;
  private busy = false;
  private message = '';
  private messageIsError = false;

  constructor(private readonly host: MapsHost, private readonly standalone: Standalone | null = null) {
    this.panel.classList.toggle('standalone', !!standalone);
    this.mapsButton.button.onclick = () => this.showPanel(this.panel.hidden !== false);
    // Nothing behind the standalone panel to go back to.
    this.panel.addEventListener('keydown', (e) => e.key === 'Escape' && !this.standalone && this.showPanel(false));
    acceptDrops(this.panel, (files) => this.take(files), extensions('img', 'hgt'));
  }

  /** Files picked with Add… or dropped on the panel: maps (any elevation files given with them
   *  stored once, with the first, as a set the others also take where it covers them), or
   *  elevation files alone, added to the set shown or stored as a new one. */
  private take(files: File[]): void {
    const img = extensions('img');
    const hgt = extensions('hgt');
    if (this.stillBusy()) return;
    if (files.some((f) => !img(f.name) && !hgt(f.name))) return this.showError('Choose a map (.img file) or elevation files (.hgt).');
    const imgs = files.filter((f) => img(f.name));
    const hgts = files.filter((f) => hgt(f.name));
    if (imgs.length) {
      this.storeMaps(imgs.map((f) => ({ name: f.name, store: (hgt, onProgress, opts) => importFiles(f, hgt, onProgress, opts) })), hgts);
    }
    else this.addElevation(hgts, this.view.kind === 'set' ? this.view.id : null);
  }

  private showError(text: string): void {
    this.message = text;
    this.messageIsError = true;
    this.redraw();
  }

  /** Reads the library again and draws the panel again if anything in it changed (a redraw for
   *  nothing would take the focus from a row or a name being typed). */
  async reload(opts: { force?: boolean; then?: (lib: Library) => void } = {}): Promise<Library> {
    const lib = await this.host.library();
    const json = JSON.stringify(lib);
    const same = json === this.libJson;
    this.lib = lib;
    this.libJson = json;
    if (!same) this.host.changed(lib); // labels elsewhere
    opts.then?.(lib);
    // A ticked map or set that's gone: back to what's shown.
    if (this.pick && !lib.maps.some((m) => m.id === this.pick!.map)) this.pick = null;
    if (this.pick?.set && !lib.sets.some((s) => s.id === this.pick!.set)) this.pick.set = this.effectiveId(this.pick.map);
    this.pick ??= this.shownPick();
    if (same && !opts.force) return lib;
    this.redraw();
    void this.readStorage();
    return lib;
  }

  /** Draws the panel again if it's open; a name being typed isn't drawn over. */
  private redraw(): void {
    if (!this.panel.hidden && !('renaming' in this.view && this.view.renaming)) this.renderPanel();
  }

  showPanel(open: boolean, view: View = { kind: 'list' }): void {
    this.panel.hidden = !open;
    this.mapsButton.button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.view = view;
    this.message = '';
    this.pick = this.shownPick(); // ticks not applied last time are gone
    this.renderPanel();
    this.panel.querySelector<HTMLElement>('h2')?.focus();
    void this.reload();
  }

  /** The map shown and its hillshading, ticked (none when no map is open). */
  private shownPick(): Pick | null {
    const cur = this.cur;
    return cur.id ? { map: cur.id, set: cur.set?.id ?? null } : null;
  }

  /** The set map `id` draws from now (the map shown: the one it was drawn with). */
  private effective(id: string): SetInfo | null {
    const cur = this.cur;
    if (id === cur.id) return cur.set;
    const m = this.lib?.maps.find((x) => x.id === id);
    return m && this.lib ? elevationFor(m, this.lib.sets) : null;
  }

  private effectiveId(id: string): string | null {
    return this.effective(id)?.id ?? null;
  }

  /** Something ticked that isn't shown yet. */
  private get pending(): boolean {
    const p = this.pick;
    return !!p && (p.map !== this.cur.id || p.set !== this.effectiveId(p.map));
  }

  /** Says so (and is true) while a change is still running. */
  private stillBusy(): boolean {
    if (!this.busy) return false;
    this.progress('Wait until this has finished.');
    return true;
  }

  /** Runs a change: one at a time, its error shown in the panel, then everything read again and
   *  drawn (its message, at least). `after` sees what's stored after a change that worked and
   *  returns its message. */
  private async act(what: () => Promise<void>, after?: (lib: Library) => string | void): Promise<void> {
    if (this.stillBusy()) return;
    this.busy = true;
    this.message = '';
    let ok = false;
    try {
      await what();
      ok = true;
      this.messageIsError = false;
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      this.messageIsError = true;
    } finally {
      this.busy = false;
    }
    const then = ok && after ? (lib: Library) => void (this.message = after(lib) ?? '') : undefined;
    await this.reload({ force: true, then }).catch((err) => {
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

  /** The map shown and its set (an id matching no map when none is open). */
  private get cur(): { id: string; set: SetInfo | null } {
    return this.host.current() ?? { id: '', set: null };
  }

  /** A row that ticks, with an ⓘ button for its details. */
  private choice(name: string, sub: Array<Node | string>, on: boolean, select: () => void, details: (() => void) | null, cls: string): El {
    const b = row(name, sub, { lead: tick(), checked: on });
    b.onclick = select;
    const info = details ? h('button', { type: 'button', class: 'info', 'aria-label': `Details for ${name}`, html: INFO_ICON }) : null;
    if (info) info.onclick = details;
    return h('div', { class: `split ${cls}` }, b, info);
  }

  // ---- the panel ----

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
    const pick = this.pick;
    const at = this.host.center();
    const out: Node[] = [this.head('Maps', 'maps-title', close)];
    if (this.standalone?.error) out.push(h('p', { class: 'note error', role: 'alert', text: this.standalone.error }));
    if (this.standalone?.unreadable) {
      out.push(this.removeAll());
      return out;
    }
    const first = !lib.maps.length;
    if (first) out.push(h('p', { class: 'note intro', text: 'Add a Garmin map (.img file) from this device or iCloud Drive, with elevation files (.hgt) for hillshading if you have them. Everything is stored on this device only.' }));
    const maps = h('div', { role: 'radiogroup', 'aria-labelledby': 'maps-title' });
    if (lib.maps.length) out.push(maps);
    for (const m of lib.maps) {
      const on = m.id === pick?.map;
      const set = on ? lib.sets.find((s) => s.id === pick!.set) ?? null : this.effective(m.id);
      const sub: Array<Node | string> = [];
      if (m.id === cur.id) sub.push(h('span', { class: 'shown', text: 'Shown' }));
      sub.push(m.id === this.standalone?.failed ? "Couldn't be opened"
        : [formatBytes(m.bytes), lower(hillshadingText(set)), m.bounds && at && !contains(m.bounds, at) ? 'not where you are' : ''].filter(Boolean).join(' · '));
      maps.append(this.choice(m.name, sub, on, () => this.tickMap(m.id), () => this.go({ kind: 'map', id: m.id }), 'map-row'));
    }
    out.push(this.status());
    const ticked = lib.maps.find((m) => m.id === pick?.map);
    if (ticked) {
      out.push(h('h3', { id: 'hillshading-title', text: 'Hillshading' }));
      if (lib.sets.length) {
        const sets = h('div', { role: 'radiogroup', 'aria-labelledby': 'hillshading-title' });
        for (const s of lib.sets) {
          const sub = [formatBytes(s.bytes), ticked.bounds ? lower(coverageText(coverage(s, ticked.bounds))) : filesText(s.files.length)].join(' · ');
          sets.append(this.choice(s.name, [sub], s.id === pick!.set, () => this.tickSet(s.id), () => this.go({ kind: 'set', id: s.id }), 'set-row'));
        }
        sets.append(this.choice('None', [], pick!.set === null, () => this.tickSet(null), null, 'set-none'));
        out.push(sets);
      } else out.push(h('p', { class: 'note', text: 'Elevation files (.hgt) draw the hills’ shading and give heights along tracks.' }));
    }
    out.push(this.filesButton('+ Add…', 'maps-add', (files) => this.take(files), first ? 'big' : 'add'));
    out.push(h('p', { class: 'note', text: 'Maps (.img) and elevation files (.hgt), one or several at a time, from this device or iCloud Drive.' }));
    if (!lib.maps.some((m) => m.imgName === FREE_MAP_NAME)) {
      const download = h('button', { type: 'button', class: 'add', id: 'maps-download', text: 'Download the free map of Iceland' });
      download.onclick = () => this.download();
      out.push(download);
      if (first) out.push(h('p', { class: 'note', text: 'Made from OpenStreetMap: roads, trails, places and contour lines, with routing (Freizeitkarte, 255 MB). Keep the app open while it downloads.' }));
    }
    if (lib.maps.length || lib.sets.length) {
      const usage = h('div', { class: 'storage' });
      out.push(usage);
      this.showStorage(usage, lib);
    }
    if (this.standalone && !onHomeScreen()) out.push(h('p', { class: 'note', id: 'home-hint', text: 'Tip: add this app to your Home Screen first (Share → Add to Home Screen) so your maps stay stored.' }));
    if (this.standalone?.leftovers) out.push(this.removeAll());
    if (lib.maps.length) {
      const apply = h('button', { type: 'button', class: 'big', id: 'maps-apply', text: 'Apply' });
      apply.disabled = !this.pending;
      apply.onclick = () => this.apply();
      out.push(h('div', { class: 'apply' }, apply));
    }
    return out;
  }

  /** Ticks a map, with the hillshading it has now. */
  private tickMap(id: string): void {
    this.pick = { map: id, set: this.effectiveId(id) };
    this.message = '';
    this.renderPanel();
  }

  /** Ticks a set for the ticked map; the ticked one again: none. */
  private tickSet(id: string | null): void {
    if (!this.pick) return;
    this.pick.set = this.pick.set === id ? null : id;
    this.message = '';
    this.renderPanel();
  }

  /** Shows the ticked map with the ticked hillshading, saved as that map's choice, and closes. */
  private apply(): void {
    const p = this.pick;
    if (!p || !this.pending) return;
    void this.act(async () => {
      // Saved only when it isn't what the map's choice gives already (an automatic choice stays
      // automatic, following elevation files added later).
      const m = this.lib?.maps.find((x) => x.id === p.map);
      const stored = m && this.lib ? elevationFor(m, this.lib.sets)?.id ?? null : null;
      if (p.set !== stored) await changeChoices((c) => void ((c.maps[p.map] ??= {}).elevation = p.set));
      if (p.map !== this.cur.id) await this.host.switchTo(p.map); // standalone: the page starts again with it
      else await this.host.refresh();
      if (!this.standalone) this.showPanel(false);
    });
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

  /** Adds maps one after another (never side by side: the iPhone's memory) in one `host.add`, so
   *  the map shown is closed and opened again once. One that fails is named and the rest still
   *  added; elevation files `hgt` go with the first one added. The last one added is ticked. */
  private storeMaps(jobs: { name: string; store: StoreMap }[], hgt: File[] = []): void {
    const ids: string[] = [];
    const failed: string[] = [];
    void this.act(async () => {
      await requestPersistence().catch(() => false); // best effort: never block an import on it
      await this.host.add(async () => {
        for (const [i, job] of jobs.entries()) {
          const step = jobs.length > 1 ? `Map ${i + 1} of ${jobs.length} · ` : '';
          try {
            ids.push(await job.store(ids.length ? [] : hgt, (m) => this.progress(step + m), { current: false }));
          } catch (err) {
            if (jobs.length === 1) throw err;
            failed.push(`“${job.name}” couldn’t be added: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!ids.length) throw new Error(failed.join(' '));
        return ids[ids.length - 1];
      });
      this.view = { kind: 'list' };
    }, (lib) => {
      const id = ids[ids.length - 1];
      this.pick = { map: id, set: this.effectiveId(id) };
      const added = ids.length === 1 ? `Added “${lib.maps.find((m) => m.id === id)?.name ?? 'the map'}”.` : `Added ${ids.length} maps.`;
      return [added, ...failed].join(' ');
    });
  }

  private download(): void {
    if (this.stillBusy()) return;
    if (!navigator.onLine) {
      this.showError('You are offline. Connect to the internet to download the map.');
      return;
    }
    this.storeMaps([{ name: FREE_MAP_NAME, store: (_hgt, onProgress, opts) => downloadMap(FREE_MAP_URL, FREE_MAP_NAME, onProgress, opts) }]);
  }

  private go(view: View): void {
    this.view = view;
    this.message = '';
    this.renderPanel();
    this.panel.querySelector<HTMLElement>('.title')?.focus();
  }

  private async readStorage(): Promise<void> {
    this.estimate = (await navigator.storage?.estimate?.().catch(() => null)) ?? null;
    const into = this.panel.querySelector<HTMLElement>('.storage');
    if (into && this.lib) this.showStorage(into, this.lib);
  }

  private showStorage(into: El, lib: Library): void {
    const est = this.estimate;
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
  private filesButton(label: string, id: string, take: (files: File[]) => void, cls = 'item link'): El {
    const input = h('input', { type: 'file', multiple: '', hidden: '', id: `${id}-input` });
    const b = h('button', { type: 'button', class: cls, id, text: label });
    b.onclick = () => this.stillBusy() || input.click();
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      if (files.length) take(files);
    };
    return h('div', {}, b, input);
  }

  /** Stores elevation files as a new set (ticked when it covers the ticked map) or adds them to set
   *  `into`. */
  private addElevation(files: File[], into: string | null): void {
    let id = '';
    void this.act(async () => {
      id = await importElevation(files, into, (m) => this.progress(m));
      // An added-to set has new files: the map shown draws them.
      if (into) await this.host.refresh();
    }, (lib) => {
      if (into) return 'Elevation files added.';
      const s = lib.sets.find((x) => x.id === id);
      const m = lib.maps.find((x) => x.id === this.pick?.map);
      if (this.pick && s && m?.bounds && coverage(s, m.bounds) > 0) this.pick.set = id;
      return 'Elevation files stored.';
    });
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
    const set = this.effective(m.id);
    const out: Node[] = [this.head('', '', close, back)];
    if (renaming) {
      out.push(this.renameForm(m.name, (name) => this.act(async () => {
        await changeChoices((c) => void ((c.maps[m.id] ??= {}).name = name));
        this.view = { kind: 'map', id };
      }), () => this.go({ kind: 'map', id })));
    } else out.push(h('h2', { class: 'title', tabindex: '-1', id: 'maps-title', text: m.name }));
    out.push(h('p', { class: 'note', text: [m.imgName, formatBytes(m.bytes), m.added ? `added ${dateText(m.added)}` : ''].filter(Boolean).join(' · ') }));
    out.push(h('p', { class: 'note', text: `${hillshadingText(set)}${m.id === this.cur.id ? ' · shown now' : ''}` }));
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
    rename.style.marginTop = '10px';
    out.push(rename, remove, this.status());
    return out;
  }

  private setDetails(lib: Library, id: string, renaming: boolean, close: () => void, back: () => void): Node[] {
    const s = lib.sets.find((x) => x.id === id);
    if (!s) return [this.head('Maps', 'maps-title', close, back), h('p', { class: 'note', text: 'These elevation files are no longer stored.' })];
    const cur = this.cur;
    const users = lib.maps.filter((m) => this.effective(m.id)?.id === s.id);
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
      const r = row(m.name, [], { trail: chev() });
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
