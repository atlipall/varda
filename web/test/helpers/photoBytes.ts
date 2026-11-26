/** Builders for photo metadata in tests: an EXIF (TIFF) block, a JPEG around segments, and a HEIC
 *  with EXIF, XMP and a colour profile. */

type Val = { type: 2; text: string } | { type: 3; n: number[] } | { type: 4; n: number[] } | { type: 5; r: Array<[number, number]> };
export type Ifd = Record<number, Val>;

export const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const size = (v: Val) => (v.type === 2 ? v.text.length + 1 : v.type === 3 ? v.n.length * 2 : v.type === 4 ? v.n.length * 4 : v.r.length * 8);

/** A TIFF block: IFD0 with pointers to an EXIF IFD and a GPS IFD when given. */
export function tiff(ifd0: Ifd, exif?: Ifd, gps?: Ifd, le = true): Uint8Array {
  const ifds: Ifd[] = [{ ...ifd0 }];
  if (exif) ifds.push(exif);
  if (gps) ifds.push(gps);
  if (exif) ifds[0][0x8769] = { type: 4, n: [0] };
  if (gps) ifds[0][0x8825] = { type: 4, n: [0] };
  const ifdSize = (d: Ifd) => 2 + Object.keys(d).length * 12 + 4;
  const starts: number[] = [];
  let at = 8;
  for (const d of ifds) {
    starts.push(at);
    at += ifdSize(d);
  }
  if (exif) ifds[0][0x8769] = { type: 4, n: [starts[1]] };
  if (gps) ifds[0][0x8825] = { type: 4, n: [starts[exif ? 2 : 1]] };
  let data = at;
  const total = data + ifds.reduce((n, d) => n + Object.values(d).reduce((m, v) => m + (size(v) > 4 ? size(v) + (size(v) % 2) : 0), 0), 0);
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  b.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  const put = (o: number, val: Val) => {
    if (val.type === 2) b.set(ascii(val.text + '\0'), o);
    else if (val.type === 3) val.n.forEach((x, i) => v.setUint16(o + i * 2, x, le));
    else if (val.type === 4) val.n.forEach((x, i) => v.setUint32(o + i * 4, x, le));
    else val.r.forEach(([a, c], i) => {
      v.setUint32(o + i * 8, a, le);
      v.setUint32(o + i * 8 + 4, c, le);
    });
  };
  ifds.forEach((d, k) => {
    const tags = Object.keys(d).map(Number).sort((a, c) => a - c);
    const s = starts[k];
    v.setUint16(s, tags.length, le);
    tags.forEach((tag, i) => {
      const e = s + 2 + i * 12;
      const val = d[tag];
      const n = val.type === 2 ? val.text.length + 1 : val.type === 5 ? val.r.length : val.n.length;
      v.setUint16(e, tag, le);
      v.setUint16(e + 2, val.type, le);
      v.setUint32(e + 4, n, le);
      if (size(val) <= 4) put(e + 8, val);
      else {
        v.setUint32(e + 8, data, le);
        put(data, val);
        data += size(val) + (size(val) % 2);
      }
    });
  });
  return b;
}

/** An iPhone-like EXIF block: taken 14 Aug 2026 15:42:10 at 63.99091 N, 19.06120 W, 590 m. */
export function iphoneExif(le = true): Uint8Array {
  return tiff(
    { 0x010f: { type: 2, text: 'Apple' }, 0x0110: { type: 2, text: 'iPhone 13' }, 0x0112: { type: 3, n: [6] } },
    {
      0x829a: { type: 5, r: [[1, 1200]] },
      0x829d: { type: 5, r: [[8, 5]] },
      0x9003: { type: 2, text: '2026:08:14 15:42:10' },
      0x9011: { type: 2, text: '+00:00' },
      0xa002: { type: 4, n: [4032] },
      0xa003: { type: 4, n: [3024] },
      0xa405: { type: 3, n: [26] },
    },
    {
      1: { type: 2, text: 'N' },
      2: { type: 5, r: [[63, 1], [59, 1], [2727, 100]] },
      3: { type: 2, text: 'W' },
      4: { type: 5, r: [[19, 1], [3, 1], [4032, 100]] },
      5: { type: 3, n: [0] },
      6: { type: 5, r: [[590, 1]] },
    },
    le,
  );
}

const seg = (marker: number, data: Uint8Array) => concat([Uint8Array.of(0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff), data]);

/** A JPEG's structure around `segments` (marker, payload), with stand-in picture data. */
export function jpeg(segments: Array<[number, Uint8Array]>, picture = Uint8Array.of(1, 2, 3, 4)): Uint8Array {
  return concat([
    Uint8Array.of(0xff, 0xd8),
    ...segments.map(([m, d]) => seg(m, d)),
    seg(0xdb, new Uint8Array(65)), // a quantisation table: not metadata
    seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    picture,
    Uint8Array.of(0xff, 0xd9),
  ]);
}

/** A minimal ICC profile with a `desc` tag naming it. */
export function icc(name: string): Uint8Array {
  const desc = concat([ascii('desc'), new Uint8Array(4), Uint8Array.of(0, 0, 0, name.length + 1), ascii(name + '\0')]);
  const head = new Uint8Array(132 + 12);
  const v = new DataView(head.buffer);
  v.setUint32(128, 1);
  head.set(ascii('desc'), 132);
  v.setUint32(136, head.length);
  v.setUint32(140, desc.length);
  const out = concat([head, desc]);
  new DataView(out.buffer).setUint32(0, out.length);
  return out;
}

const box = (type: string, ...body: Uint8Array[]) => {
  const inner = concat(body);
  const b = concat([new Uint8Array(4), ascii(type), inner]);
  new DataView(b.buffer).setUint32(0, b.length);
  return b;
};
const full = (version: number, flags: number) => Uint8Array.of(version, 0, 0, flags);
const u16 = (n: number) => Uint8Array.of(n >> 8, n & 255);
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);

/** A HEIC holding EXIF, XMP and (as the primary item's property) an ICC profile. */
export function heic(exif: Uint8Array, xmp: string, profile: Uint8Array, picture = Uint8Array.of(9, 9, 9, 9)): Uint8Array {
  const ftyp = box('ftyp', ascii('heic'), u32(0), ascii('mif1heic'));
  const exifItem = concat([u32(6), ascii('Exif\0\0'), exif]);
  const xmpItem = ascii(xmp);
  const mdatHead = 8;
  const mdat = box('mdat', picture, exifItem, xmpItem);
  const at = ftyp.length + mdatHead;
  const infe = (id: number, type: string, mime?: string) => box('infe', full(2, 0), u16(id), u16(0), ascii(type), ascii('\0'), ...(mime ? [ascii(mime + '\0')] : []));
  const iinf = box('iinf', full(0, 0), u16(3), infe(1, 'hvc1'), infe(2, 'Exif'), infe(3, 'mime', 'application/rdf+xml'));
  const loc = (id: number, off: number, len: number) => concat([u16(id), u16(0), u16(1), u32(off), u32(len)]);
  const iloc = box('iloc', full(0, 0), Uint8Array.of(0x44, 0x00), u16(3),
    loc(1, at, picture.length), loc(2, at + picture.length, exifItem.length), loc(3, at + picture.length + exifItem.length, xmpItem.length));
  const ipco = box('ipco', box('ispe', full(0, 0), u32(4032), u32(3024)), box('colr', ascii('prof'), profile));
  const ipma = box('ipma', full(0, 0), u32(1), u16(1), Uint8Array.of(2, 0x81, 0x82));
  const meta = box('meta', full(0, 0), box('hdlr', full(0, 0), u32(0), ascii('pict'), new Uint8Array(13)), box('pitm', full(0, 0), u16(1)), iinf, iloc, box('iprp', ipco, ipma));
  return concat([ftyp, mdat, meta]);
}
