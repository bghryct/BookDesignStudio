/**
 * Text wrap around an image's outline: the opaque extent of each row of the image, read from its
 * alpha channel once it has loaded (layouts are then recomputed through the font-store version).
 */
import { useFontStore } from '../engine/fonts';

export type RowSpan = [number, number] | null;

const ROWS = 128;
const cache = new Map<string, RowSpan[] | 'loading' | 'failed'>();

/** Opaque extent of each of 128 rows, as fractions of the image width (null = transparent row). */
export function alphaRows(src: string): RowSpan[] | null {
  const hit = cache.get(src);
  if (Array.isArray(hit)) return hit;
  if (hit) return null;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
  cache.set(src, 'loading');
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  const img = new Image();
  img.onload = () => {
    try {
      const W = Math.max(8, Math.min(256, img.naturalWidth || 256));
      const c = document.createElement('canvas');
      c.width = W; c.height = ROWS;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, W, ROWS);
      const d = ctx.getImageData(0, 0, W, ROWS).data;
      const rows: RowSpan[] = [];
      for (let y = 0; y < ROWS; y++) {
        let a = -1, b = -1;
        for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 40) { if (a < 0) a = x; b = x; }
        rows.push(a < 0 ? null : [a / W, (b + 1) / W]);
      }
      cache.set(src, rows);
      useFontStore.getState().bump();
    } catch {
      cache.set(src, 'failed');
    }
  };
  img.onerror = () => cache.set(src, 'failed');
  img.src = src;
  return null;
}
