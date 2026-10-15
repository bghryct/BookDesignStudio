/**
 * Decoded image cache shared by the canvas back-end, raster primitives and the 3D textures.
 * `getImage` is synchronous: it returns null until the image has decoded, then bumps the
 * resource version so dependants re-render.
 */
import { useFontStore } from '../engine/fonts';

const images = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const hit = images.get(src);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(src);
  if (!p) {
    p = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        images.set(src, img);
        pending.delete(src);
        useFontStore.getState().bump();
        resolve(img);
      };
      img.onerror = () => { pending.delete(src); reject(new Error('Image failed to load')); };
      img.src = src;
    });
    pending.set(src, p);
  }
  return p;
}

export function getImage(src: string): HTMLImageElement | null {
  const hit = images.get(src);
  if (hit) return hit;
  void loadImage(src).catch(() => undefined);
  return null;
}
