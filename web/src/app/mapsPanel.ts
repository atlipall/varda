import type * as maplibregl from 'maplibre-gl';
import { contains, coverage, coverageText, elevationFor, filesText, hillshadingText, type MapInfo, type SetInfo } from '../storage/library';
import { changeChoices, importElevation, removeSet, type Library } from '../storage/store';
import { HGT_STEP } from '../dem/hgt';
import { editName } from '../ui/rename';

/** What the maps UI needs from the viewer. */
export interface MapsHost {
  /** What's stored, read again. */
  library(): Promise<Library>;
  /** The map shown and the set its hillshading comes from. */
  current(): { id: string; set: SetInfo | null };
  /** The middle of the screen. */
  center(): [number, number];
  /** Shows map `id` here (keeping the view when it covers it); rejects with the reason it couldn't. */
  switchTo(id: string): Promise<void>;
  /** Draws the map shown again when its elevation set should change (a choice, a set added or
   *  removed; `without`: a set about to be removed). */
  refresh(without?: string): Promise<void>;
  /** The import screen, to add a map. */
  addMap(): void;
  /** Removes a map (another one is shown when it was this one; none left: the first-run screen). */
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

/** The map picker (from the map button) and ⋯ → Maps: switching maps, their hillshading, adding,
 *  renaming and removing maps and elevation sets. */
export class MapsUi {
  readonly mapsButton = new MapsButton();
  private readonly picker = document.getElementById('map-picker')!;
  private readonly panel = document.getElementById('maps-panel')!;
  private view: View = { kind: 'list' };
  private lib: Library | null = null;
  private busy = false;
  private message = '';
  private messageIsError = false;

  constructor(private readonly host: MapsHost) {
    this.mapsButton.button.onclick = () => this.showPicker(this.picker.hidden !== false);
    for (const el of [this.picker, this.panel]) {
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (el === this.panel) this.showPanel(false);
        else this.showPicker(false);
      });
    }
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

  /** Runs a change: one at a time, its error shown in the panel, then everything read again. */
  private async act(what: () => Promise<void>, done?: string): Promise<void> {
    if (this.busy) return;
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
    const close = h('button', { type: 'button', class: 'close', 'aria-label': 'Close', html: CLOSE_ICON });
    close.onclick = onClose;
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

  // ---- the picker ----

  private renderPicker(): void {
    const lib = this.lib;
    const out: Array<Node> = [this.head('Map', 'map-picker-title', () => this.showPicker(false))];
    if (lib) {
      const cur = this.host.current();
      const at = this.host.center();
      for (const m of lib.maps) {
        const isCur = m.id === cur.id;
        const set = isCur ? cur.set : this.setFor(m);
        const sub = [hillshadingText(set), m.bounds && !contains(m.bounds, at) ? 'not where you are' : ''].filter(Boolean).join(' · ');
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
          b.onclick = () => on || void this.act(() => this.chooseElevation(this.host.current().id, choice?.id ?? null));
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
    if (mapId === this.host.current().id) await this.host.refresh();
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
    const cur = this.host.current();
    const out: Node[] = [this.head('Maps', 'maps-title', close)];
    for (const m of lib.maps) {
      const isCur = m.id === cur.id;
      const set = isCur ? cur.set : this.setFor(m);
      const pick = h('button', { type: 'button', class: 'row pick', role: 'radio', 'aria-checked': String(isCur), 'aria-label': `Show ${m.name}` }, radio());
      pick.onclick = () => isCur || void this.act(() => this.host.switchTo(m.id));
      const open = row(m.name, `${formatBytes(m.bytes)} · ${set ? `hillshading ${set.name}` : 'no hillshading'}`, { trail: chev(), current: isCur });
      open.onclick = () => this.go({ kind: 'map', id: m.id });
      out.push(h('div', { class: 'split map-row' }, pick, open));
    }
    const add = h('button', { type: 'button', class: 'add', id: 'maps-add', text: 'Add a map' });
    add.onclick = () => this.host.addMap();
    out.push(add, h('h3', { text: 'Elevation for hillshading' }));
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
    const usage = h('div', { class: 'storage' });
    out.push(usage);
    void this.showStorage(usage, lib);
    return out;
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
  private filesButton(label: string, id: string, take: (files: File[]) => void, cls = 'item link'): El {
    const input = h('input', { type: 'file', multiple: '', hidden: '', id: `${id}-input` });
    const b = h('button', { type: 'button', class: cls, id, text: label });
    b.onclick = () => input.click();
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      if (files.length) take(files);
    };
    return h('div', {}, b, input);
  }

  private addElevation(files: File[], into: string | null): void {
    void this.act(async () => {
      const id = await importElevation(files, into, (m) => this.progress(m));
      // A new set may now be the best one for the map shown; an added-to one has new files.
      await this.host.refresh();
      if (!into) this.view = { kind: 'set', id };
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
    const cur = this.host.current();
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
        this.showPanel(false);
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
    const cur = this.host.current();
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
