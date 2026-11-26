import { readExif, exifForCopy, cameraText, type ExifInfo } from './exif';
import { heifMetadataOf, isHeif } from './heif';
import { exifOf, exifSegment, iccOf, iccSegments, isJpeg, metadataSegments, withSegments, xmpOf, xmpSegment, ICC_ID, startsWith, type Segment } from './jpeg';
import { descriptionOf } from './xmp';

/** The longest side of the copy the app keeps (px). */
export const MAX_SIDE = 2048;
/** The thumbnail's side (px): a square for the map and the lists, sharp at 3x for 52 pt. */
export const THUMB = 192;
/** JPEG quality: 0.75 is about a third smaller than 0.85 (0.67 MB vs 0.87 MB for iPhone 13 photos) and looks the same on a phone. */
const QUALITY = 0.75;

/** What a picked photo says about itself, read before any decoding (cheap: a photo with no
 *  location can be left out before the work of copying it). */
export interface Inspected {
  file: File;
  info: ExifInfo | null;
  /** Every metadata block to carry over to the copy. */
  segments: Segment[];
  /** A description it already has (from Lightroom, say). */
  description: string | null;
}

/** How much of a JPEG is read first for its metadata (the segments before the picture data):
 *  an iPhone's are about 40-70 KB, a camera's with a big preview more; read further when needed. */
const JPEG_HEAD = 256 * 1024;

/** A JPEG's metadata segments, reading only as much of the file as they take. */
async function jpegSegments(file: Blob, head: Uint8Array): Promise<Segment[]> {
  for (let bytes = head; ; ) {
    try {
      return metadataSegments(bytes);
    } catch {
      // Cut short by the read (or damaged): read four times as much, up to all of it.
      if (bytes.length >= file.size) return [];
      bytes = new Uint8Array(await file.slice(0, Math.min(file.size, bytes.length * 4)).arrayBuffer());
    }
  }
}

export async function inspect(file: File): Promise<Inspected> {
  const head = new Uint8Array(await file.slice(0, JPEG_HEAD).arrayBuffer());
  let segments: Segment[] = [];
  if (isJpeg(head)) {
    segments = await jpegSegments(file, head);
  } else if (isHeif(head)) {
    const m = await heifMetadataOf(file);
    if (m.exif) segments.push(exifSegment(m.exif));
    if (m.xmp) segments.push(xmpSegment(m.xmp));
    if (m.icc) segments.push(...iccSegments(m.icc));
  }
  // Keep only what's needed of the file: the segments are views into it, so copy them.
  segments = segments.map((s) => ({ marker: s.marker, data: s.data.slice() }));
  const tiff = exifOf(segments);
  let info: ExifInfo | null = null;
  try {
    info = tiff ? readExif(tiff) : null;
  } catch {
    info = null;
  }
  return { file, info, segments, description: descriptionOf(xmpOf(segments)) };
}

export const hasLocation = (x: Inspected) => x.info?.lat != null && x.info?.lon != null;

export const cameraOf = (x: Inspected) => (x.info ? cameraText(x.info) : '');

/** The name of the colour profile ("Display P3", "sRGB IEC61966-2.1"), from its `desc` tag. */
export function iccName(icc: Uint8Array): string | null {
  if (icc.length < 132) return null;
  const v = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const n = v.getUint32(128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= icc.length; i++) {
    const e = 132 + i * 12;
    if (v.getUint32(e) !== 0x64657363) continue; // 'desc'
    const at = v.getUint32(e + 4);
    if (at + 12 > icc.length) return null;
    const type = String.fromCharCode(...icc.subarray(at, at + 4));
    if (type === 'desc') {
      const len = v.getUint32(at + 8);
      return new TextDecoder().decode(icc.subarray(at + 12, Math.min(icc.length, at + 12 + len))).replace(/\0.*$/s, '') || null;
    }
    if (type === 'mluc' && at + 28 <= icc.length) {
      const len = v.getUint32(at + 20);
      const off = v.getUint32(at + 24);
      let s = '';
      for (let k = 0; k + 1 < len && at + off + k + 1 < icc.length; k += 2) s += String.fromCharCode(v.getUint16(at + off + k));
      return s || null;
    }
  }
  return null;
}

/** Which canvas to draw the copy in, and whether the original's colour profile still describes
 *  its pixels there: a Display P3 photo stays P3 where the browser can draw P3 (an iPhone), an
 *  sRGB one stays sRGB; anything else the browser turns into sRGB, so its profile is dropped. */
function colourPlan(segments: Segment[]): { space: 'srgb' | 'display-p3'; keepIcc: boolean } {
  const icc = iccOf(segments);
  if (!icc) return { space: 'srgb', keepIcc: false };
  const name = iccName(icc) ?? '';
  if (/p3/i.test(name)) return { space: 'display-p3', keepIcc: true };
  return { space: 'srgb', keepIcc: /srgb/i.test(name) };
}

function context(c: HTMLCanvasElement, space: 'srgb' | 'display-p3'): { g: CanvasRenderingContext2D; space: 'srgb' | 'display-p3' } {
  const g = c.getContext('2d', { colorSpace: space } as CanvasRenderingContext2DSettings) ?? c.getContext('2d');
  if (!g) throw new Error('This browser cannot draw photos.');
  const got = (g.getContextAttributes?.() as { colorSpace?: string } | undefined)?.colorSpace;
  return { g, space: got === 'display-p3' ? 'display-p3' : 'srgb' };
}

const toBlob = (c: HTMLCanvasElement, q: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make a copy of the photo.'))), 'image/jpeg', q));

/** Decodes the photo the way the browser shows it (turned upright by its orientation). */
async function decode(file: Blob, name = file instanceof File ? file.name : 'The photo'): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error(`${name} can't be opened in this browser.`);
  } finally {
    // The decoded picture stays with the element.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export interface Copy {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

/** The copy the app keeps: at most `max` px on its longest side, upright, a JPEG carrying the
 *  original's metadata (with its orientation and size updated), and a square thumbnail. */
export async function makeCopy(x: Inspected, max = MAX_SIDE): Promise<Copy> {
  const img = await decode(x.file);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error(`${x.file.name} can't be opened in this browser.`);
  const scale = Math.min(1, max / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * scale));
  const height = Math.max(1, Math.round(h0 * scale));
  const plan = colourPlan(x.segments);
  // Halve in steps down to twice the size, then draw the last step: one big jump looks rough.
  let src: CanvasImageSource = img;
  let sw = w0;
  let sh = h0;
  const temps: HTMLCanvasElement[] = [];
  while (sw / 2 >= width * 2) {
    const t = document.createElement('canvas');
    t.width = Math.round(sw / 2);
    t.height = Math.round(sh / 2);
    const { g } = context(t, plan.space);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, t.width, t.height);
    temps.push(t);
    src = t;
    sw = t.width;
    sh = t.height;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const { g, space } = context(canvas, plan.space);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, width, height);
  for (const t of temps) t.width = t.height = 0; // let iOS have the memory back now
  const drawn = new Uint8Array(await (await toBlob(canvas, QUALITY)).arrayBuffer());
  // The metadata: EXIF updated for the copy; the colour profile only where it still fits.
  const keepIcc = plan.keepIcc && space === plan.space;
  const segments = x.segments
    .filter((s) => keepIcc || !(s.marker === 0xe2 && startsWith(s.data, ICC_ID)))
    .map((s) => (s.marker === 0xe1 && exifOf([s]) ? exifSegment(exifForCopy(exifOf([s])!, width, height)) : s));
  const full = new Blob([withSegments(drawn, segments) as BlobPart], { type: 'image/jpeg' });
  // The thumbnail: the middle square.
  const t = document.createElement('canvas');
  t.width = t.height = THUMB;
  const tg = context(t, space).g;
  tg.imageSmoothingQuality = 'high';
  const side = Math.min(width, height);
  tg.drawImage(canvas, (width - side) / 2, (height - side) / 2, side, side, 0, 0, THUMB, THUMB);
  const thumb = await toBlob(t, 0.8);
  canvas.width = canvas.height = t.width = t.height = 0;
  return { full, thumb, width, height };
}

/** A small square picture of a photo: for the "no location" list, and the thumbnail of a synced
 *  photo whose picture just arrived (no metadata needed). */
export async function preview(file: Blob, side = 160): Promise<Blob | null> {
  try {
    const img = await decode(file);
    const c = document.createElement('canvas');
    c.width = c.height = side;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side);
    const b = await toBlob(c, 0.8);
    c.width = c.height = 0;
    return b;
  } catch {
    return null;
  }
}
