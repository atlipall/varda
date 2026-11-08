import { crc32, deflateSync } from 'node:zlib';

/** An 8-bit RGBA PNG. Each row is stored as its difference from the row above (filter "Up"),
 *  which roughly halves terrain tiles: neighbouring heights are close. */
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error(`expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = y ? 2 : 0;
    for (let i = 0; i < stride; i++) raw[out + 1 + i] = rgba[y * stride + i] - (y ? rgba[(y - 1) * stride + i] : 0);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, per-row filters, no interlace
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
