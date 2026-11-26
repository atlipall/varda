import { describe, expect, test } from 'vitest';
import { cluster } from '../src/photos/cluster';
import { cameraText, exifForCopy, readExif } from '../src/photos/exif';
import { heifMetadata, heifMetadataOf, isHeif } from '../src/photos/heif';
import { exifOf, iccOf, iccSegments, metadataSegments, readSegments, withSegments, xmpOf, xmpSegment, exifSegment, ICC_ID } from '../src/photos/jpeg';
import { iccName, inspect } from '../src/photos/copy';
import { byTime, dayText, isPhoto, takenText, type Photo } from '../src/photos/photo';
import { descriptionOf, withDescription } from '../src/photos/xmp';
import { ascii, concat, heic, icc, iphoneExif, jpeg, tiff } from './helpers/photoBytes';

describe('EXIF', () => {
  test.each([true, false])('where, when and what with (little-endian %s)', (le) => {
    const e = readExif(iphoneExif(le));
    expect(e.lat).toBeCloseTo(63.990908, 5);
    expect(e.lon).toBeCloseTo(-19.0612, 5);
    expect(e.alt).toBe(590);
    expect(e.taken).toBe('2026-08-14T15:42:10');
    expect(e.offset).toBe('+00:00');
    expect([e.make, e.model, e.orientation, e.focal35, e.fNumber]).toEqual(['Apple', 'iPhone 13', 6, 26, 1.6]);
    expect(e.exposure).toBeCloseTo(1 / 1200);
    expect(cameraText(e)).toBe('iPhone 13 · 26 mm · f/1.6 · 1/1200 s');
  });

  test('no GPS, or 0,0 (an app that had no position), is no location', () => {
    expect(readExif(tiff({ 0x0110: { type: 2, text: 'X' } })).lat).toBeNull();
    const zero = tiff({}, undefined, { 1: { type: 2, text: 'N' }, 2: { type: 5, r: [[0, 1], [0, 1], [0, 1]] }, 3: { type: 2, text: 'E' }, 4: { type: 5, r: [[0, 1], [0, 1], [0, 1]] } });
    expect(readExif(zero)).toMatchObject({ lat: null, lon: null });
  });

  test('a camera that names its maker in the model, or not', () => {
    expect(cameraText({ make: 'Canon', model: 'Canon EOS R6', focal35: null, fNumber: 4, exposure: 2 })).toBe('Canon EOS R6 · f/4 · 2 s');
    expect(cameraText({ make: 'FUJIFILM', model: 'X-T4', focal35: 35, fNumber: null, exposure: null })).toBe('FUJIFILM X-T4 · 35 mm');
  });

  test('the copy says upright and its new size; every other byte is the same', () => {
    const before = iphoneExif();
    const after = exifForCopy(before, 2048, 1536);
    const e = readExif(after);
    expect(e.orientation).toBe(1);
    expect(after.length).toBe(before.length);
    const differing = [...before].map((b, i) => (b !== after[i] ? i : -1)).filter((i) => i >= 0);
    expect(differing.length).toBeLessThanOrEqual(2 + 4 + 4); // orientation, width, height
    expect(readExif(before).orientation).toBe(6); // the original is left alone
    const v = new DataView(after.buffer);
    // PixelXDimension / PixelYDimension, read back by tag.
    const exifIfd = (() => {
      const n = v.getUint16(8, true);
      for (let i = 0; i < n; i++) if (v.getUint16(10 + i * 12, true) === 0x8769) return v.getUint32(18 + i * 12, true);
      return 0;
    })();
    const dims: number[] = [];
    for (let i = 0; i < v.getUint16(exifIfd, true); i++) {
      const e2 = exifIfd + 2 + i * 12;
      const tag = v.getUint16(e2, true);
      if (tag === 0xa002 || tag === 0xa003) dims.push(v.getUint32(e2 + 8, true));
    }
    expect(dims).toEqual([2048, 1536]);
  });
});

describe('JPEG metadata', () => {
  const exif = iphoneExif();
  const xmp = '<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>';
  const profile = icc('Display P3');
  const original = jpeg([
    [0xe0, concat([ascii('JFIF\0'), new Uint8Array(9)])],
    [0xe1, concat([ascii('Exif\0\0'), exif])],
    [0xe1, concat([ascii('http://ns.adobe.com/xap/1.0/\0'), ascii(xmp)])],
    [0xe2, concat([ascii('MPF\0'), new Uint8Array(20)])],
    ...iccSegments(profile).map((s) => [s.marker, s.data] as [number, Uint8Array]),
    [0xed, ascii('Photoshop 3.0\0IPTC')],
    [0xfe, ascii('a comment')],
  ]);

  test('takes everything about the photo, not the file layout (JFIF header, MPF)', () => {
    const segs = metadataSegments(original);
    expect(segs.map((s) => s.marker)).toEqual([0xe1, 0xe1, 0xe2, 0xed, 0xfe]);
    expect(exifOf(segs)).toEqual(exif);
    expect(xmpOf(segs)).toBe(xmp);
    expect(iccOf(segs)).toEqual(profile);
  });

  test('a big colour profile goes in several segments and comes back whole', () => {
    const big = new Uint8Array(150_000).map((_, i) => i % 251);
    const segs = iccSegments(big);
    expect(segs.length).toBe(3);
    expect(segs.every((s) => s.data.length + 2 <= 0xffff)).toBe(true);
    expect(iccOf(segs.reverse())).toEqual(big);
  });

  test('a new JPEG gets the metadata in place of its own, EXIF first, picture data untouched', () => {
    const picture = Uint8Array.of(7, 7, 7, 0xff, 0x00, 7);
    const fresh = jpeg([[0xe0, concat([ascii('JFIF\0'), new Uint8Array(9)])], [0xe2, concat([ICC_ID, Uint8Array.of(1, 1), icc('sRGB')])]], picture);
    const segs = metadataSegments(original);
    const out = withSegments(fresh, [xmpSegment('<x/>'), exifSegment(exif)]);
    const back = readSegments(out);
    expect(back.map((s) => s.marker)).toEqual([0xe1, 0xe1, 0xdb]);
    expect(exifOf(back)).toEqual(exif);
    expect(xmpOf(back)).toBe('<x/>');
    // From SOS on, byte for byte.
    const tail = (b: Uint8Array) => b.subarray(b.length - picture.length - 2 - 8);
    expect(tail(out)).toEqual(tail(fresh));
    expect(readSegments(withSegments(fresh, segs)).filter((s) => s.marker !== 0xdb)).toHaveLength(segs.length);
  });

  test('the colour profile is told by name', () => {
    expect(iccName(icc('Display P3'))).toBe('Display P3');
    expect(iccName(new Uint8Array(10))).toBeNull();
  });
});

describe('HEIC metadata', () => {
  test('EXIF, XMP and the primary picture’s colour profile', () => {
    const xmp = '<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=""><dc:description><rdf:Alt><rdf:li xml:lang="x-default">Hot spring</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>';
    const file = heic(iphoneExif(), xmp, icc('Display P3'));
    expect(isHeif(file)).toBe(true);
    const m = heifMetadata(file);
    expect(readExif(m.exif!).lat).toBeCloseTo(63.990908, 5);
    expect(m.xmp).toBe(xmp);
    expect(descriptionOf(m.xmp)).toBe('Hot spring');
    expect(iccName(m.icc!)).toBe('Display P3');
  });

  test('not a HEIC: nothing', () => {
    expect(heifMetadata(jpeg([]))).toEqual({ exif: null, xmp: null, icc: null });
  });
});

/** A file that counts the bytes read from it. */
function counted(bytes: Uint8Array, name: string) {
  const seen = { bytes: 0 };
  class Counted extends File {
    override slice(a?: number, b?: number, type?: string): Blob {
      const s = super.slice(a, b, type);
      seen.bytes += s.size;
      return s;
    }
    override arrayBuffer(): Promise<ArrayBuffer> {
      seen.bytes += this.size;
      return super.arrayBuffer();
    }
  }
  return { f: new Counted([bytes as BlobPart], name), seen };
}

describe('reading a photo’s metadata without the whole file', () => {
  const xmp = '<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=""><dc:description><rdf:Alt><rdf:li xml:lang="x-default">Hot spring</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>';
  const picture = new Uint8Array(3_000_000).fill(7);

  test('a JPEG: the segments before the picture data, also when they run past the first read', async () => {
    const big = Array.from({ length: 6 }, (_, i) => [0xe3 + i, new Uint8Array(60_000).fill(i)] as [number, Uint8Array]);
    for (const segs of [[] as Array<[number, Uint8Array]>, big]) {
      const bytes = jpeg([[0xe1, exifSegment(iphoneExif()).data], [0xe1, xmpSegment(xmp).data], ...segs], picture);
      const { f, seen } = counted(bytes, 'IMG_1.jpg');
      const x = await inspect(f);
      expect(x.info?.lat).toBeCloseTo(63.990908, 5);
      expect(x.description).toBe('Hot spring');
      expect(x.segments).toHaveLength(2 + segs.length);
      expect(seen.bytes).toBeLessThan(bytes.length / 2);
    }
  });

  test('a HEIC: the same as from the whole file, the picture data skipped', async () => {
    for (const bytes of [heic(iphoneExif(), xmp, icc('Display P3')), heic(iphoneExif(), xmp, icc('Display P3'), picture)]) {
      const whole = heifMetadata(bytes);
      expect(whole.exif).not.toBeNull();
      const { f, seen } = counted(bytes, 'IMG_1.HEIC');
      expect(await heifMetadataOf(f)).toEqual(whole);
      if (bytes.length > 1e6) expect(seen.bytes).toBeLessThan(10_000);
      const x = await inspect(f);
      expect(x.info?.lat).toBeCloseTo(63.990908, 5);
      expect(x.description).toBe('Hot spring');
    }
  });
});

describe('description in XMP', () => {
  test('added to a photo with no XMP, and read back', () => {
    const x = withDescription(null, 'Lunch & a <swim>')!;
    expect(descriptionOf(x)).toBe('Lunch & a <swim>');
    expect(x).toContain('xmlns:dc=');
  });

  test('replaces a description the packet had, keeping the rest', () => {
    const apple = '<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" xmlns:HDRGainMap="x"><HDRGainMap:HDRGainMapVersion>65536</HDRGainMap:HDRGainMapVersion></rdf:Description></rdf:RDF></x:xmpmeta>';
    const once = withDescription(apple, 'First')!;
    const twice = withDescription(once, 'Second')!;
    expect(descriptionOf(twice)).toBe('Second');
    expect(twice.match(/dc:description>/g)).toHaveLength(2); // one element: its open and close tags
    expect(twice).toContain('HDRGainMapVersion>65536');
    expect(descriptionOf(withDescription(twice, '  '))).toBeNull();
  });
});

describe('photos close together', () => {
  test('within the radius of a group’s first photo they join it; the rest make their own', () => {
    const pts = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 100, y: 0 }, { x: 55, y: 0 }, { x: 0, y: 49 }].map((p, i) => ({ item: i, ...p }));
    const g = cluster(pts, 50);
    expect(g.map((x) => x.items)).toEqual([[0, 1, 4], [2, 3]]);
    expect([g[1].x, g[1].y]).toEqual([100, 0]);
  });

  test('many photos are grouped quickly', () => {
    const pts = Array.from({ length: 5000 }, (_, i) => ({ item: i, x: (i * 37) % 1000, y: (i * 91) % 800 }));
    const t = performance.now();
    const g = cluster(pts, 56);
    expect(performance.now() - t).toBeLessThan(200);
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(5000);
  });
});

describe('photo records', () => {
  const p: Photo = { id: 'a', added: 1, lon: -19.06, lat: 63.99, alt: 590, taken: '2026-08-14T15:42:10', camera: 'iPhone 13', width: 2048, height: 1536, bytes: 600_000, name: 'IMG_1.HEIC' };
  test('looks right, or is left out', () => {
    expect(isPhoto(p)).toBe(true);
    expect(isPhoto({ ...p, description: 'x', updated: 2, taken: null, alt: null })).toBe(true);
    expect(isPhoto({ ...p, lat: 91 })).toBe(false);
    expect(isPhoto({ ...p, taken: '14 Aug' })).toBe(false);
    expect(isPhoto({ ...p, description: 5 })).toBe(false);
  });

  test('times as the camera showed them', () => {
    expect(takenText(p.taken)).toBe('Fri 14 Aug 2026 · 15:42');
    expect(takenText(p.taken, true)).toBe('14 Aug 15:42');
    expect(dayText(p.taken)).toBe('Fri 14 Aug 2026');
    expect(takenText(null)).toBe('Time not known');
  });

  test('oldest first, no time last', () => {
    const xs = [{ ...p, id: 'c', taken: null }, { ...p, id: 'b', taken: '2026-08-15T09:00:00' }, p];
    expect(xs.sort(byTime).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
