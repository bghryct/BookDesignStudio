/**
 * Raster worker: draws lowered display lists (rasterOps.ts) into OffscreenCanvases and returns
 * ImageBitmaps, so 3D textures are rasterised off the main thread. Images are fetched and decoded
 * here (data:/blob: URLs); glyphs arrive as outlines, so no fonts are needed. Panel jobs also bake
 * the cover finishes (finishing.ts) into colour / surface / height / iridescence maps.
 */
import { drawWire, wireImages, type Ctx2D, type PanelBitmaps, type PanelJob, type RasterRequest, type RasterResponse, type StitchJob, type WireEnv, type WireList } from './rasterOps';
import { finishPixels } from '../three/finishing';
import type { FinishKey } from '../three/types';

interface WorkerScope {
  onmessage: ((e: MessageEvent<RasterRequest>) => void) | null;
  postMessage(msg: RasterResponse, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/* Decoded images, most recently used last (dropped ones are left to the GC: a draw may hold them). */
const images = new Map<string, Promise<ImageBitmap | null>>();
const MAX_IMAGES = 48;

function decode(href: string): Promise<ImageBitmap | null> {
  let p = images.get(href);
  if (p) {
    images.delete(href);
    images.set(href, p);
    return p;
  }
  p = fetch(href).then((r) => r.blob()).then((b) => createImageBitmap(b)).catch(() => null);
  images.set(href, p);
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value as string);
  return p;
}

const paths = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
    if (paths.size > 8000) paths.clear();
  }
  return p;
}

async function envFor(lists: WireList[]): Promise<WireEnv> {
  const hrefs = new Set<string>();
  for (const l of lists) for (const h of wireImages(l)) hrefs.add(h);
  const decoded = new Map<string, ImageBitmap | null>();
  await Promise.all([...hrefs].map(async (h) => decoded.set(h, await decode(h))));
  return {
    image: (href) => decoded.get(href) ?? null,
    layer: (w, h) => {
      const canvas = new OffscreenCanvas(w, h);
      return { canvas, ctx: canvas.getContext('2d')! };
    },
    path: path2d,
  };
}

async function surface(list: WireList, mask: boolean): Promise<ImageBitmap> {
  const env = await envFor([list]);
  const canvas = new OffscreenCanvas(list.w, list.h);
  const ctx = canvas.getContext('2d')!;
  drawWire(ctx, list, env);
  if (mask) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, list.w, list.h);
  }
  return canvas.transferToImageBitmap();
}

/** RGBA pixels → a GPU-side bitmap (uploads here, so the main thread's texture upload is a copy). */
function bitmapOf(data: Uint8ClampedArray, w: number, h: number): ImageBitmap {
  const c = new OffscreenCanvas(w, h);
  const own = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
  (c.getContext('2d') as Ctx2D).putImageData(new ImageData(own as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return c.transferToImageBitmap();
}

/** Join the bands of a panel into whole maps (GPU blits). Flat bands of a map that others have get
 *  its flat value. */
function stitch(job: StitchJob): PanelBitmaps {
  const { parts, rows, w, h } = job;
  const sheet = (pick: (p: PanelBitmaps) => ImageBitmap | null, half: boolean, flat: string) => {
    const W = half ? Math.max(1, w >> 1) : w, H = half ? Math.max(1, h >> 1) : h;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d')!;
    parts.forEach((p, i) => {
      const y0 = half ? rows[i] >> 1 : rows[i], y1 = half ? (i + 1 < parts.length ? rows[i + 1] >> 1 : H) : (rows[i + 1] ?? h);
      const b = pick(p);
      if (b) g.drawImage(b, 0, y0);
      else {
        g.fillStyle = flat;
        g.fillRect(0, y0, W, y1 - y0);
      }
    });
    return c.transferToImageBitmap();
  };
  const f = parts[0].flatSurface;
  const out: PanelBitmaps = {
    color: sheet((p) => p.color, false, '#000'),
    surface: parts.some((p) => p.surface) ? sheet((p) => p.surface, job.half, `rgb(${f[0]},${f[1]},${f[2]})`) : null,
    flatSurface: f,
    bump: parts.some((p) => p.bump) ? sheet((p) => p.bump, job.half, 'rgb(128,128,128)') : null,
    holo: parts.some((p) => p.holo) ? sheet((p) => p.holo, job.half, '#000') : null,
    hasGloss: parts.some((p) => p.hasGloss),
    hasClearcoat: parts.some((p) => p.hasClearcoat),
  };
  for (const p of parts) for (const b of [p.color, p.surface, p.bump, p.holo]) b?.close();
  return out;
}

/** Above this many pixels, the surface / height / iridescence maps are kept at half size. */
const HALF_MAPS_PX = 16e6;

/**
 * Half-size (2×2 box filter) copy of RGBA pixels. Roughness, metalness, height and iridescence
 * change slowly (height is blurred anyway), so big panels keep these maps at a quarter of the
 * pixels: less to upload to the GPU, and to hold there.
 */
function halve(d: Uint8ClampedArray, w: number, h: number): { d: Uint8ClampedArray; w: number; h: number } {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const r0 = Math.min(h - 1, 2 * y) * w, r1 = Math.min(h - 1, 2 * y + 1) * w;
    for (let x = 0; x < W; x++) {
      const x0 = Math.min(w - 1, 2 * x), x1 = Math.min(w - 1, 2 * x + 1);
      const a = (r0 + x0) * 4, b = (r0 + x1) * 4, c = (r1 + x0) * 4, e = (r1 + x1) * 4, o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (d[a + k] + d[b + k] + d[c + k] + d[e + k] + 2) >> 2;
    }
  }
  return { d: out, w: W, h: H };
}

async function panel(job: PanelJob): Promise<PanelBitmaps> {
  const { art } = job;
  const w = art.w, h = art.h;
  const env = await envFor([art, ...job.masks.map((m) => m.list)]);
  if (!job.masks.length) {
    // No finishes: nothing to read back, so the art stays on the GPU (the main thread's texture
    // upload is then a GPU copy, not hundreds of MB from memory).
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = job.base || '#6b5a48';
    ctx.fillRect(0, 0, w, h);
    drawWire(ctx, art, env);
    const flat = finishPixels(new Uint8ClampedArray(0), 0, 0, {}, job.fp, art.m[0]);
    return { color: canvas.transferToImageBitmap(), surface: null, flatSurface: flat.flatSurface, bump: null, holo: null, hasGloss: flat.hasGloss, hasClearcoat: flat.hasClearcoat };
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = job.base || '#6b5a48';
  ctx.fillRect(0, 0, w, h);
  drawWire(ctx, art, env);
  const masks: Partial<Record<FinishKey, Float32Array>> = {};
  if (job.masks.length) {
    const mc = new OffscreenCanvas(w, h);
    const mctx = mc.getContext('2d', { willReadFrequently: true })!;
    const n = w * h;
    for (const { key, list } of job.masks) {
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.clearRect(0, 0, w, h);
      drawWire(mctx, list, env);
      // A finish mask is white with the art's alpha: coverage = alpha.
      const d = mctx.getImageData(0, 0, w, h).data;
      const m = new Float32Array(n);
      let any = false;
      for (let i = 0, j = 3; i < n; i++, j += 4) {
        const a = d[j];
        if (a) { m[i] = a / 255; any = true; }
      }
      if (any) masks[key] = m;
    }
  }
  const img = ctx.getImageData(0, 0, w, h);
  // Pixels per pt (the deboss blur radius): the list's device scale.
  const band = job.band;
  const maps = finishPixels(img.data, w, h, masks, job.fp, art.m[0], band?.row0 ?? 0);
  // A band keeps its own rows only (the margin was there for the blur).
  const top = band?.top ?? 0, rows = band?.rows ?? h;
  const crop = (d: Uint8ClampedArray) => (band ? d.subarray(top * w * 4, (top + rows) * w * 4) : d);
  const halfMaps = band ? band.half : w * h > HALF_MAPS_PX;
  const aux = (d: Uint8ClampedArray | null) => {
    if (!d) return null;
    if (!halfMaps) return bitmapOf(crop(d), w, rows);
    const half = halve(crop(d), w, rows);
    return bitmapOf(half.d, half.w, half.h);
  };
  return {
    color: bitmapOf(crop(img.data), w, rows),
    surface: aux(maps.surface),
    flatSurface: maps.flatSurface,
    bump: aux(maps.bump),
    holo: aux(maps.holo),
    hasGloss: maps.hasGloss,
    hasClearcoat: maps.hasClearcoat,
  };
}

scope.onmessage = async (e) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    if (req.kind === 'surface') {
      const bmp = await surface(req.list, !!req.mask);
      scope.postMessage({ id: req.id, ok: true, bmp, ms: performance.now() - t0 }, [bmp]);
    } else {
      const maps = req.kind === 'stitch' ? stitch(req) : await panel(req);
      const transfer = [maps.color, maps.surface, maps.bump, maps.holo].filter((b): b is ImageBitmap => !!b);
      scope.postMessage({ id: req.id, ok: true, maps, ms: performance.now() - t0 }, transfer);
    }
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: String((err as Error)?.message ?? err) }, []);
  }
};
