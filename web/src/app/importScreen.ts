import { autoSet, coverage, coverageText, filesText, mapName, type Bounds } from '../storage/library';
import { clearStored, downloadMap, importFiles, inspectMap, requestPersistence, type Library } from '../storage/store';

/** The free OpenStreetMap-based map of Iceland, through the download pass-through (web/download-worker). */
export const FREE_MAP_URL = 'https://download.vardamaps.app/iceland.zip';
const FREE_MAP_NAME = 'Freizeitkarte Iceland (OpenStreetMap).img';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface ImportOptions {
  /** Data is stored but no map opens: offer to remove it (e.g. to free space for a large import). */
  hasMap?: boolean;
  /** The viewer is behind this screen: offer to go back to it (a reload into the stored map). */
  canCancel?: boolean;
  /** Adding a map to the ones stored (rather than the first). */
  add?: boolean;
  /** What's stored: its elevation sets are offered for the new map. */
  lib?: Library | null;
}

const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

/** The hillshading choice for the new map: a stored set, new files, or none. */
type Elevation = { kind: 'set'; id: string } | { kind: 'new' } | { kind: 'none' };

export function showImport(error = '', opts: ImportOptions = {}): void {
  $('import').hidden = false;
  $('import-error').textContent = error;
  $('import-progress').textContent = '';
  $('home-hint').hidden = isStandalone() || !!opts.add;
  const sets = opts.lib?.sets ?? [];

  $('import-title').textContent = opts.add ? 'Add a map' : 'Load your map';
  $('import-intro').innerHTML = opts.add
    ? 'Pick the Garmin <code>.img</code> map file. It is kept with your other maps on this device.'
    : sets.length
      ? 'Pick the Garmin <code>.img</code> map file. It is stored on this device only.'
      : 'Pick the Garmin <code>.img</code> map file. Add the <code>.hgt</code> elevation files for hillshading (optional). They are stored on this device only.';
  const button = $<HTMLButtonElement>('import-button');
  button.textContent = opts.add ? 'Add map' : 'Import';
  const cancel = $<HTMLButtonElement>('import-cancel');
  const remove = $<HTMLButtonElement>('remove-stored');
  const download = $<HTMLButtonElement>('download-free');
  const busy = (on: boolean) => [button, cancel, remove, download].forEach((b) => (b.disabled = on));
  busy(false);

  // The new map's name (adding one), filled in from its file name until typed over.
  const nameInput = $<HTMLInputElement>('import-name');
  $('import-name-row').hidden = !opts.add;
  nameInput.value = '';
  let nameTyped = false;
  nameInput.oninput = () => (nameTyped = nameInput.value.trim() !== '');

  // Hillshading: once elevation files are stored, a set of them (the one covering the map, when
  // it's known), new files, or none. Without stored files it's just the optional file picker.
  let bounds: Bounds | null = null;
  let elevation: Elevation = sets.length ? { kind: 'set', id: sets[sets.length - 1].id } : { kind: 'new' };
  let elevationPicked = false;
  const renderElevation = () => {
    $('import-elevation').hidden = !sets.length;
    $('hgt-row').hidden = elevation.kind !== 'new';
    if (!sets.length) return;
    const options: Array<{ e: Elevation; name: string; sub: string }> = [
      ...sets.map((s) => ({ e: { kind: 'set', id: s.id } as Elevation, name: s.name, sub: bounds ? coverageText(coverage(s, bounds)) : filesText(s.files.length) })),
      { e: { kind: 'new' }, name: 'Add elevation files', sub: '.hgt, select all' },
      { e: { kind: 'none' }, name: 'None', sub: '' },
    ];
    $('import-elevation-options').replaceChildren(...options.map((o) => {
      const on = o.e.kind === elevation.kind && (o.e.kind !== 'set' || (elevation.kind === 'set' && o.e.id === elevation.id));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'row';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      const r = document.createElement('span');
      r.className = 'radio';
      const t = document.createElement('span');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = o.name;
      t.append(n);
      if (o.sub) {
        const s = document.createElement('span');
        s.className = 's';
        s.textContent = o.sub;
        t.append(s);
      }
      b.append(r, t);
      b.onclick = () => {
        elevation = o.e;
        elevationPicked = true;
        renderElevation();
      };
      return b;
    }));
  };
  renderElevation();

  // The pickers show the chosen file's name (or how many) beside their button.
  for (const [id, none] of [['img-file', 'No file chosen'], ['hgt-files', 'No files chosen']]) {
    const input = $<HTMLInputElement>(id);
    const show = () => {
      const files = [...(input.files ?? [])];
      $(`${id}-name`).textContent = files.length === 0 ? none : files.length === 1 ? files[0].name : `${files.length} files`;
    };
    input.onchange = () => {
      show();
      if (id === 'img-file') void picked(input.files?.[0]);
    };
    show();
  }
  /** A map file was picked: its name, and (with elevation stored) which files cover it. */
  const picked = async (img: File | undefined) => {
    if (!img) return;
    if (opts.add && !nameTyped) nameInput.value = mapName(img.name);
    if (!sets.length) return;
    let found: Bounds;
    try {
      found = (await inspectMap(img)).bounds;
    } catch {
      return; // Import says what's wrong with the file
    }
    if ($<HTMLInputElement>('img-file').files?.[0] !== img) return; // another file was picked meanwhile
    bounds = found;
    if (!elevationPicked) {
      const best = autoSet(sets, bounds);
      elevation = best ? { kind: 'set', id: best.id } : { kind: 'new' };
    }
    renderElevation();
  };

  cancel.hidden = !opts.canCancel;
  cancel.onclick = () => location.reload();

  remove.hidden = !opts.hasMap || !!opts.add;
  remove.onclick = async () => {
    if (!confirm('Remove the stored maps and elevation files from this device? You will need the files to add them again.')) return;
    busy(true);
    try {
      await clearStored();
      location.reload();
    } catch (err) {
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      busy(false);
    }
  };

  /** Stores a map (`store` reports progress), then reloads into it; shows the error otherwise. */
  const run = async (store: (onProgress: (m: string) => void) => Promise<void>) => {
    $('import-error').textContent = '';
    busy(true);
    try {
      await requestPersistence().catch(() => false); // best effort: never block an import on it
      await store((m) => ($('import-progress').textContent = m));
      location.reload();
    } catch (err) {
      $('import-progress').textContent = '';
      $('import-error').textContent = err instanceof Error ? err.message : String(err);
      busy(false);
    }
  };

  button.onclick = () => {
    const img = $<HTMLInputElement>('img-file').files?.[0];
    const hgt = elevation.kind === 'new' ? [...($<HTMLInputElement>('hgt-files').files ?? [])] : [];
    if (!img) {
      $('import-error').textContent = 'Pick the .img map file first.';
      return;
    }
    const name = nameInput.value.trim();
    // A set picked by hand is kept even if a better one comes later; otherwise the map takes the
    // one covering it best (new files become its set).
    const choice = elevation.kind === 'none' ? null : elevation.kind === 'set' && elevationPicked ? elevation.id : undefined;
    void run((onProgress) => importFiles(img, hgt, onProgress, {
      ...(opts.add && name && name !== mapName(img.name) ? { name } : {}),
      ...(choice !== undefined ? { elevation: choice } : {}),
    }));
  };

  download.onclick = () => {
    if (!navigator.onLine) {
      $('import-error').textContent = 'You are offline. Connect to the internet to download the map.';
      return;
    }
    void run((onProgress) => downloadMap(FREE_MAP_URL, FREE_MAP_NAME, onProgress));
  };
}
