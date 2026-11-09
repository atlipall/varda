/**
 * Files dragged from the computer onto a panel, as well as picked with its button. A dropped
 * folder is read through (GPSmap.is keeps its .hgt and KML files in folders); of a folder's files
 * only the ones `wanted` takes are kept, while files dropped on their own all go to the panel, so
 * a wrong one gets the same message as when it's picked.
 */
export function acceptDrops(el: HTMLElement, take: (files: File[]) => void, wanted: (name: string) => boolean): void {
  outlined.add(el);
  el.addEventListener('dragenter', (e) => hasFiles(e) && el.classList.add('drop-over'));
  // Leaving for one of its own children isn't leaving. (A counter of enters and leaves gets stuck
  // when the panel redraws under the pointer: the child it left is gone and never says so.)
  el.addEventListener('dragleave', (e) => hasFiles(e) && !el.contains(e.relatedTarget as Node | null) && el.classList.remove('drop-over'));
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    droppedFiles(e.dataTransfer!, wanted).then((files) => files.length && take(files), (err) => console.warn('reading dropped files', err));
  });
}

/** The panels taking drops, to clear their outline once the drag is over wherever it ended. */
const outlined = new Set<HTMLElement>();

/** Keeps files dropped anywhere but on a panel from opening in the browser in place of the app. */
export function ignoreStrayDrops(): void {
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    for (const el of outlined) el.classList.remove('drop-over');
    if (hasFiles(e)) e.preventDefault();
  });
  // Dragged out of the window (or the panel hidden under the pointer): nothing stays outlined.
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) for (const el of outlined) el.classList.remove('drop-over');
  });
}

/** An extension test for `acceptDrops`' `wanted`: `extensions('gpx')`. */
export const extensions = (...exts: string[]) => (name: string) => exts.some((x) => name.toLowerCase().endsWith(`.${x}`));

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

async function droppedFiles(dt: DataTransfer, wanted: (name: string) => boolean): Promise<File[]> {
  // The entries must be taken while the drop event runs; they're read afterwards.
  const entries = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.() ?? null);
  if (!entries.length || entries.some((x) => !x)) return [...dt.files];
  // Dropped on their own, files all go to the panel; out of a folder, only the wanted ones.
  const parts = await Promise.all(entries.map((e) => (e!.isFile ? fileOf(e as FileSystemFileEntry).then((f) => [f]) : readFolder(e as FileSystemDirectoryEntry, wanted))));
  return parts.flat();
}

/** A folder's wanted files, its subfolders' included (hidden ones left out). */
async function readFolder(dir: FileSystemDirectoryEntry, wanted: (name: string) => boolean): Promise<File[]> {
  const reader = dir.createReader();
  const parts: Array<Promise<File[]>> = [];
  // readEntries hands them over in batches until an empty one; the files are taken all at once.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const e of batch) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory) parts.push(readFolder(e as FileSystemDirectoryEntry, wanted));
      else if (wanted(e.name)) parts.push(fileOf(e as FileSystemFileEntry).then((f) => [f]));
    }
  }
  return (await Promise.all(parts)).flat();
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));
