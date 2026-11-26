import { readOverlayFile, type Overlay } from './kml';
import { OVERLAY_EXTENSIONS, SHAPEFILE_EXTENSIONS } from './extensions';
import { parseShapefile, shapefileGroups, type ShapefileFields } from './shapefile';
import { unzip } from './zip';

export { OVERLAY_EXTENSIONS };

export interface PickedFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** One thing to add: a file, or a Shapefile's files together. `label` names it in a problem. */
export interface OverlayJob {
  label: string;
  read(): Promise<Overlay[]>;
}

const USED_PARTS = ['shp', 'dbf', 'prj', 'cpg', 'cst'];
const ext = (name: string) => /\.([^./]+)$/.exec(name)?.[1].toLowerCase() ?? '';
const base = (name: string) => name.split('/').pop()!.replace(/\.[^.]+$/, '');
const bytesOf = async (f: PickedFile) => new Uint8Array(await f.arrayBuffer());

/** A zip: a KMZ by another name when it holds a .kml, else each Shapefile in it (named after the
 *  zip when it holds only one; `fields`: what to name and colour them by, when known). */
export async function readZip(name: string, bytes: Uint8Array, fields?: ShapefileFields): Promise<Overlay[]> {
  const files = await unzip(bytes.buffer as ArrayBuffer); // a fresh buffer from bytesOf
  if ([...files.keys()].some((n) => /\.kml$/i.test(n))) return [await readOverlayFile(name, bytes)];
  const shapes = shapefileGroups(files).filter((g) => g.parts);
  if (!shapes.length) throw new Error('There is no KML file or Shapefile (.shp) inside this zip file.');
  return shapes.map((g) => parseShapefile(g.parts!, shapes.length === 1 ? base(name) : g.base, fields));
}

/** What to add from picked or dropped files: each KML, KMZ and zip on its own, and a Shapefile's
 *  files (.shp, .dbf, .prj…) taken together by their shared name. */
export function overlayJobs(files: PickedFile[]): OverlayJob[] {
  const jobs: OverlayJob[] = [];
  const shapefiles = new Map<string, PickedFile[]>();
  for (const f of files) {
    const e = ext(f.name);
    if (e === 'zip') jobs.push({ label: f.name, read: async () => readZip(f.name, await bytesOf(f)) });
    else if (SHAPEFILE_EXTENSIONS.includes(e)) {
      const key = base(f.name).toLowerCase();
      shapefiles.set(key, [...(shapefiles.get(key) ?? []), f]);
    } else jobs.push({ label: f.name, read: async () => [await readOverlayFile(f.name, await bytesOf(f))] });
  }
  for (const group of shapefiles.values()) {
    const shp = group.find((f) => ext(f.name) === 'shp');
    jobs.push({
      label: shp?.name ?? group[0].name,
      read: async () => {
        if (!shp) throw new Error('This is part of a Shapefile: choose its .shp with it (and the .dbf and .prj), or a .zip of them.');
        // Only the parts read (not the .shx and other indexes).
        const used = group.filter((f) => USED_PARTS.includes(ext(f.name)));
        const contents = new Map(await Promise.all(used.map(async (f) => [f.name, await bytesOf(f)] as const)));
        return shapefileGroups(contents).filter((g) => g.parts).map((g) => parseShapefile(g.parts!, g.base));
      },
    });
  }
  return jobs;
}
