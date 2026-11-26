/// <reference lib="webworker" />
import { storageRoot } from '../channel';
import { parseChoices, parseSetJson, type Choices } from './library';
import { CHOICES, currentDirName, isCompleteDir, isMapDir, isMissing, listEntries, POINTER, readTextFile as readText, subdir } from './layout';

/** Writing to the stored maps' files, for the storage workers (sync access handles are only there).
 *  Nothing here reads a map: the small changes (which map is current, a name, removing a map) run
 *  in a worker that doesn't load the map parser (fileWorker.ts). */

export const encode = (o: unknown) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));

// The sync access handle's methods return promises on older Safari (pre-17) and plain values on
// newer engines; awaiting is harmless on the latter and required on the former.
export async function writeBytes(dir: FileSystemDirectoryHandle, name: string, write: (h: FileSystemSyncAccessHandle) => Promise<void>): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    await handle.truncate(0);
    await write(handle);
    await handle.flush();
  } finally {
    await handle.close();
  }
}

export const writeAll = (dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => writeBytes(dir, name, async (h) => void (await h.write(bytes, { at: 0 })));

/** Overwrites a small file with one write and then trims it, so it is never observed empty (a
 *  pointer or set.json must not be left blank by an interruption between truncate and write). */
export async function writeSmall(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    await handle.write(bytes, { at: 0 });
    await handle.truncate(bytes.length);
    await handle.flush();
  } finally {
    await handle.close();
  }
}

export async function removeEntry(dir: FileSystemDirectoryHandle, name: string, recursive = false): Promise<void> {
  await dir.removeEntry(name, { recursive }).catch((err) => {
    if (!isMissing(err)) console.warn('could not remove', name, err);
  });
}

// ---- the user's choices (maps.json) ----

export async function updateChoices(change: (c: Choices) => void): Promise<void> {
  const root = await storageRoot();
  const c = parseChoices(await readText(root, CHOICES));
  change(c);
  await writeSmall(root, CHOICES, encode(c));
}

/** Removes a map. If it's the current one, another map becomes current first (the newest), or the
 *  pointer goes when it was the last. A directory that also holds an elevation set (an older
 *  version's map) keeps the set. */
export async function removeMap(id: string): Promise<void> {
  const root = await storageRoot();
  if ((await currentDirName(root)) === id) {
    const others = (await listEntries(root)).filter((e) => e.kind === 'directory' && e.name !== id && isMapDir(e.name)).map((e) => e.name);
    const complete: string[] = [];
    for (const o of others) if (await isCompleteDir(root, o)) complete.push(o);
    complete.sort();
    const next = complete.pop();
    if (next) await writeSmall(root, POINTER, encode({ dir: next }));
    else await removeEntry(root, POINTER);
  }
  const dir = await subdir(root, id);
  if (!dir) return;
  const dem = await subdir(dir, 'dem');
  if (dem && parseSetJson(await readText(dem, 'set.json'))) {
    for (const f of ['meta.json', 'map.img', 'places.json', 'dem-overview.bin']) await removeEntry(dir, f);
  } else await removeEntry(root, id, true);
  await updateChoices((c) => void delete c.maps[id]);
}

/** Removes an elevation set; maps that used it are drawn without hillshading. */
export async function removeSet(id: string): Promise<void> {
  const root = await storageRoot();
  const [top, sub] = id.split('/');
  if (sub) {
    const parent = await subdir(root, top);
    if (parent) {
      await removeEntry(parent, sub, true);
      await removeEntry(parent, 'dem-overview.bin');
      if (!(await isCompleteDir(root, top))) await removeEntry(root, top, true);
    }
  } else await removeEntry(root, id, true);
  await updateChoices((c) => {
    delete c.sets[id];
    for (const m of Object.values(c.maps)) if (m.elevation === id) m.elevation = null;
  });
}

export async function writeText(dirName: string | null, name: string, text: string): Promise<void> {
  const root = await storageRoot();
  if (dirName === null) return writeSmall(root, name, encode(text));
  // No `create`: if the map directory vanished meanwhile, fail rather than resurrect it.
  const dir = await root.getDirectoryHandle(dirName);
  await writeAll(dir, name, encode(text));
}

export const setCurrent = async (id: string) => writeSmall(await storageRoot(), POINTER, encode({ dir: id }));

/** The small changes, by message (both workers answer them). */
export async function smallChange(msg: Record<string, unknown>): Promise<boolean> {
  if (msg.type === 'removeMap') await removeMap(msg.id as string);
  else if (msg.type === 'removeSet') await removeSet(msg.id as string);
  else if (msg.type === 'setCurrent') await setCurrent(msg.id as string);
  else if (msg.type === 'writeText') await writeText(msg.dir as string | null, msg.name as string, msg.text as string);
  else return false;
  return true;
}
