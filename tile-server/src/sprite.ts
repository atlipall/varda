import type { RgbaImage } from '../../web/src/img/typ';
import { encodePng } from './png';

export interface SpriteEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
}

/** The style's icons and fill patterns packed into one sheet, as MapLibre's sprite format wants:
 *  a PNG and a JSON index of where each image is. Shelf packing, rows sorted tallest first. */
export function buildSprite(images: Map<string, RgbaImage>, maxWidth = 1024): { png: Uint8Array; index: Record<string, SpriteEntry> } {
  const items = [...images].sort((a, b) => b[1].height - a[1].height || a[0].localeCompare(b[0]));
  const index: Record<string, SpriteEntry> = {};
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 1;
  for (const [id, img] of items) {
    if (x > 0 && x + img.width > maxWidth) {
      y += rowHeight + 1;
      x = 0;
      rowHeight = 0;
    }
    index[id] = { x, y, width: img.width, height: img.height, pixelRatio: 1 };
    x += img.width + 1;
    rowHeight = Math.max(rowHeight, img.height);
    width = Math.max(width, x);
  }
  const height = Math.max(1, y + rowHeight);
  const sheet = new Uint8Array(width * height * 4);
  for (const [id, img] of items) {
    const at = index[id];
    for (let row = 0; row < img.height; row++) {
      sheet.set(img.data.subarray(row * img.width * 4, (row + 1) * img.width * 4), ((at.y + row) * width + at.x) * 4);
    }
  }
  return { png: encodePng(width, height, sheet), index };
}
