/**
 * Canvas 2D back-end: display list → pixels. Used for 3D textures, thumbnails, PNG export
 * and anything that needs raster output. Text is drawn from the fonts' real glyph outlines
 * (same shaping as the PDF), falling back to fillText for system fonts.
 *
 * `lowerPrims` turns a display list into serialisable ops (rasterOps.ts) that a raster worker
 * draws to the same pixels, so big textures can be rasterised off the main thread.
 */
import type { Matrix, Prim, TextRun } from './primitives';
import { runMatrix } from './primitives';
import { shape, glyphPath, canOutline, glyphKerns } from '../engine/fonts';
import { getImage, loadImage } from './images';
import { COMPOSITE, mulMatrix, paintStyle, type WireImage, type WireList, type WireOp } from './rasterOps';

export interface CanvasOptions {
  pxPerPt: number;
  hideDieLines?: boolean;
}

const pathCache = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
    if (pathCache.size > 6000) pathCache.clear();
  }
  return p;
}

function drawRun(ctx: CanvasRenderingContext2D, r: TextRun) {
  ctx.save();
  if (r.rotate) {
    const [px, py] = r.pivot ?? [r.x, r.y];
    ctx.translate(px, py);
    ctx.rotate((r.rotate * Math.PI) / 180);
    ctx.translate(-px, -py);
  }
  const m = runMatrix(r);
  if (m) ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.fillStyle = r.color;
  if (r.stroke) { ctx.strokeStyle = r.stroke.color; ctx.lineJoin = 'round'; }
  const ls = r.letterSpacing ?? 0;
  if (canOutline(r.text, r.font)) {
    const shaped = shape(r.text, r.font)!;
    const gk = glyphKerns(shaped, r.kern);
    let x = 0;
    for (let gi = 0; gi < shaped.glyphs.length; gi++) {
      const g = shaped.glyphs[gi];
      const gp = glyphPath(r.font, g.id);
      if (gp && gp.d) {
        const k = r.size / gp.upm;
        ctx.save();
        ctx.translate(r.x + x + g.xOffset * r.size, r.y - g.yOffset * r.size);
        ctx.scale(k, -k);
        if (r.font.oblique) ctx.transform(1, 0, Math.tan((12 * Math.PI) / 180), 1, 0, 0);
        ctx.fill(path2d(gp.d));
        if (r.stroke) { ctx.lineWidth = r.stroke.width / k; ctx.stroke(path2d(gp.d)); }
        ctx.restore();
      }
      x += g.xAdvance * r.size + ls + (gk ? gk[gi] : 0);
    }
  } else {
    ctx.font = `${r.font.italic ? 'italic ' : ''}${r.font.weight} ${r.size}px ${r.font.css}`;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${ls}px`;
    ctx.fillText(r.text, r.x, r.y);
    if (r.stroke) { ctx.lineWidth = r.stroke.width; ctx.strokeText(r.text, r.x, r.y); }
  }
  ctx.restore();
}

function needsLayer(p: { opacity?: number; blend?: string }, childCount: number) {
  return ((p.opacity ?? 1) < 1 && childCount > 1) || (p.blend && p.blend !== 'normal' && childCount > 1);
}

export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], opts: CanvasOptions) {
  for (const p of prims) drawPrim(ctx, p, opts);
}

function drawPrim(ctx: CanvasRenderingContext2D, p: Prim, opts: CanvasOptions) {
  const alpha = p.opacity ?? 1;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (p.blend && p.blend !== 'normal') ctx.globalCompositeOperation = COMPOSITE[p.blend];
  try {
    switch (p.t) {
      case 'path': {
        if (p.role === 'dieline' && opts.hideDieLines) break;
        const path = path2d(p.d);
        if (p.fill) {
          ctx.fillStyle = paintStyle(ctx, p.fill);
          ctx.fill(path, p.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
        }
        if (p.stroke && (p.strokeWidth ?? 1) > 0) {
          ctx.strokeStyle = paintStyle(ctx, p.stroke);
          ctx.lineWidth = p.strokeWidth ?? 1;
          ctx.lineCap = p.cap ?? 'butt';
          ctx.lineJoin = p.join ?? 'miter';
          ctx.setLineDash(p.dash ?? []);
          ctx.stroke(path);
        }
        break;
      }
      case 'text':
        for (const r of p.runs) drawRun(ctx, r);
        break;
      case 'image': {
        const img = getImage(p.href);
        if (!img) break;
        if (p.clip) {
          ctx.beginPath();
          ctx.rect(p.clip.x, p.clip.y, p.clip.w, p.clip.h);
          ctx.clip();
        }
        if (p.filter === 'grayscale') ctx.filter = 'grayscale(1)';
        ctx.drawImage(img, p.x, p.y, p.w, p.h);
        break;
      }
      case 'raster': {
        ctx.translate(p.x, p.y);
        const m = ctx.getTransform();
        const pxPerPt = Math.max(0.25, Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)));
        p.draw(ctx, pxPerPt);
        break;
      }
      case 'group': {
        if (p.matrix) ctx.transform(...p.matrix);
        if (p.clip) ctx.clip(path2d(p.clip), p.clipRule === 'evenodd' ? 'evenodd' : 'nonzero');
        if (needsLayer(p, p.children.length)) {
          // Isolated group: draw children into a layer, then composite once.
          const layer = document.createElement('canvas');
          layer.width = ctx.canvas.width;
          layer.height = ctx.canvas.height;
          const lctx = layer.getContext('2d')!;
          lctx.setTransform(ctx.getTransform());
          drawPrims(lctx, p.children, opts);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(layer, 0, 0);
        } else {
          // Opacity of a single child can be pushed down without isolation.
          drawPrims(ctx, p.children, opts);
        }
        break;
      }
    }
  } finally {
    ctx.restore();
  }
}

/** Wait for every image referenced by the prims to decode. */
export async function preloadImages(prims: Prim[]): Promise<void> {
  const srcs = new Set<string>();
  const walk = (ps: Prim[]) => {
    for (const p of ps) {
      if (p.t === 'image') srcs.add(p.href);
      else if (p.t === 'group') walk(p.children);
    }
  };
  walk(prims);
  await Promise.all([...srcs].map((s) => loadImage(s).catch(() => undefined)));
}

/** Render primitives (in pt) to a new canvas covering `box`. */
export function renderToCanvas(prims: Prim[], box: { x: number; y: number; w: number; h: number }, pxPerPt: number, opts: Partial<CanvasOptions> & { background?: string } = {}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(box.w * pxPerPt));
  c.height = Math.max(1, Math.round(box.h * pxPerPt));
  const ctx = c.getContext('2d')!;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  // Map the box exactly onto whole pixels so edges are fully covered (no fractional last column).
  const sx = c.width / box.w, sy = c.height / box.h;
  ctx.setTransform(sx, 0, 0, sy, -box.x * sx, -box.y * sy);
  drawPrims(ctx, prims, { pxPerPt, hideDieLines: opts.hideDieLines });
  return c;
}

/* -------------------------------------------------------------------------- */
/* Lowering for raster workers                                                 */
/* -------------------------------------------------------------------------- */

export interface LowerOptions {
  hideDieLines?: boolean;
  background?: string;
  /**
   * Live view: keep each procedural raster primitive's draw (brushes, marbling, grain — the only
   * drawing left on the main thread) under about this many ms by drawing it at a lower density.
   * Unset (exports): full density.
   */
  rasterBudgetMs?: number;
}

/** Measured cost of raster primitives by kind (ns per pixel); only ever raised, so it stays conservative. */
const rasterCost = new Map<string, number>();
const RASTER_COST_DEFAULT = 80;

/** Pre-rendered raster primitives (brushes, marbling, duotones), by key and pixel size. */
const rasterBitmaps = new Map<string, { bmp: ImageBitmap; px: number }>();
let rasterBitmapsPx = 0;
const RASTER_BITMAP_BUDGET = 64e6;
/** Largest bitmap a raster primitive is pre-rendered to (pixels). */
const RASTER_MAX_PX = 32e6;

const OBLIQUE: Matrix = [1, 0, Math.tan((12 * Math.PI) / 180), 1, 0, 0];

/** Run matrix (character rotation, scaling, false italic) as drawRun applies it. */
function runBase(r: TextRun): Matrix {
  let base: Matrix = [1, 0, 0, 1, 0, 0];
  if (r.rotate) {
    const [px, py] = r.pivot ?? [r.x, r.y];
    const t = (r.rotate * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    base = [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
  }
  const rm = runMatrix(r);
  if (rm) base = mulMatrix(base, rm);
  return base;
}

const runFont = (r: TextRun) => `${r.font.italic ? 'italic ' : ''}${r.font.weight} ${r.size}px ${r.font.css}`;

/**
 * Text run → a glyph-outline op, or a fillText op for system fonts. Returns false for a run of
 * a page font that has no outlines for it (a glyph the font lacks, or the font still loading):
 * only the page's own FontFaces draw that faithfully, so the caller draws it here as a bitmap.
 */
function lowerRun(r: TextRun, a: number, b: WireOp['b'], pid: (d: string) => number, out: WireOp[]): boolean {
  const base = runBase(r);
  const ls = r.letterSpacing ?? 0;
  if (canOutline(r.text, r.font)) {
    const shaped = shape(r.text, r.font)!;
    const gk = glyphKerns(shaped, r.kern);
    const g: number[] = [];
    let x = 0;
    for (let gi = 0; gi < shaped.glyphs.length; gi++) {
      const gl = shaped.glyphs[gi];
      const gp = glyphPath(r.font, gl.id);
      if (gp && gp.d) {
        const k = r.size / gp.upm;
        let m = mulMatrix(base, [k, 0, 0, -k, r.x + x + gl.xOffset * r.size, r.y - gl.yOffset * r.size]);
        if (r.font.oblique) m = mulMatrix(m, OBLIQUE);
        g.push(pid(gp.d), m[0], m[1], m[2], m[3], m[4], m[5], r.stroke ? r.stroke.width / k : 0);
      }
      x += gl.xAdvance * r.size + ls + (gk ? gk[gi] : 0);
    }
    if (g.length) out.push({ o: 'glyphs', a, b, color: r.color, stroke: r.stroke?.color, g: Float64Array.from(g) });
    return true;
  }
  if (r.font.face) return false;
  out.push({ o: 'text', a, b, m: base, font: runFont(r), ls, color: r.color, stroke: r.stroke, text: r.text, x: r.x, y: r.y });
  return true;
}

/** Device scale of a matrix (px per unit), as the canvas back-end measures it. */
const scaleOf = (m: Matrix) => Math.max(0.25, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])));

let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Lower a display list to serialisable ops covering `box` at `pxPerPt`, exactly as renderToCanvas
 * would draw it (see rasterOps.ts). Text becomes glyph outlines with their final matrices; raster
 * primitives and SVG images are drawn to bitmaps here (one at a time, yielding in between).
 */
export async function lowerPrims(prims: Prim[], box: { x: number; y: number; w: number; h: number }, pxPerPt: number, opts: LowerOptions = {}): Promise<WireList> {
  const w = Math.max(1, Math.round(box.w * pxPerPt));
  const h = Math.max(1, Math.round(box.h * pxPerPt));
  const sx = w / box.w, sy = h / box.h;
  const m: Matrix = [sx, 0, 0, sy, -box.x * sx, -box.y * sy];
  const paths: string[] = [];
  const index = new Map<string, number>();
  const pid = (d: string) => {
    let i = index.get(d);
    if (i === undefined) {
      i = paths.length;
      paths.push(d);
      index.set(d, i);
    }
    return i;
  };
  const deferred: { op: WireImage; make: () => Promise<ImageBitmap | null> }[] = [];
  const svgs = new Set<string>();

  const lower = (ps: Prim[], ctm: Matrix): WireOp[] => {
    const out: WireOp[] = [];
    for (const p of ps) {
      const a = p.opacity ?? 1;
      if (a <= 0) continue;
      const b = p.blend && p.blend !== 'normal' ? p.blend : undefined;
      switch (p.t) {
        case 'path':
          if (p.role === 'dieline' && opts.hideDieLines) break;
          out.push({
            o: 'path', a, b, d: pid(p.d), fill: p.fill, stroke: p.stroke, sw: p.strokeWidth, dash: p.dash, cap: p.cap, join: p.join,
            rule: p.fillRule === 'evenodd' ? 'evenodd' : undefined,
          });
          break;
        case 'text':
          for (const r of p.runs) {
            if (lowerRun(r, a, b, pid, out)) continue;
            // Drawn here with the page's fonts, at the size it lands on the page.
            const base = runBase(r);
            const s = scaleOf(mulMatrix(ctm, base));
            const op: WireImage = { o: 'image', a, b, x: 0, y: 0, w: 0, h: 0 };
            out.push({ o: 'group', a: 1, m: base, layer: false, c: [op] });
            deferred.push({
              op,
              make: async () => {
                measureCtx ??= document.createElement('canvas').getContext('2d')!;
                const g0 = measureCtx;
                g0.font = runFont(r);
                if ('letterSpacing' in g0) (g0 as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${r.letterSpacing ?? 0}px`;
                const mt = g0.measureText(r.text);
                const pad = 2 + (r.stroke?.width ?? 0);
                const x0 = r.x - Math.max(0, mt.actualBoundingBoxLeft) - pad;
                const x1 = r.x + Math.max(mt.width, mt.actualBoundingBoxRight) + pad;
                const y0 = r.y - Math.max(mt.actualBoundingBoxAscent, r.size) - pad;
                const y1 = r.y + Math.max(mt.actualBoundingBoxDescent, r.size * 0.35) + pad;
                const W = Math.max(1, Math.min(16384, Math.ceil((x1 - x0) * s))), H = Math.max(1, Math.min(16384, Math.ceil((y1 - y0) * s)));
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const g = c.getContext('2d')!;
                g.scale(W / (x1 - x0), H / (y1 - y0));
                g.translate(-x0, -y0);
                drawRun(g, { ...r, rotate: undefined, scaleX: undefined, scaleY: undefined, skew: undefined });
                Object.assign(op, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
                return createImageBitmap(c);
              },
            });
          }
          break;
        case 'image': {
          const op: WireImage = { o: 'image', a, b, x: p.x, y: p.y, w: p.w, h: p.h, clip: p.clip, gray: p.filter === 'grayscale' || undefined };
          if (/^data:image\/svg/i.test(p.href)) {
            // Workers cannot decode SVG: draw it here at the size it lands on the page.
            const k = Math.min(scaleOf(ctm), Math.sqrt(RASTER_MAX_PX / Math.max(1e-6, p.w * p.h)));
            const W = Math.max(1, Math.min(16384, Math.ceil(p.w * k))), H = Math.max(1, Math.min(16384, Math.ceil(p.h * k)));
            const href = p.href;
            svgs.add(href);
            deferred.push({
              op,
              make: async () => {
                const img = getImage(href);
                if (!img) return null;
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                c.getContext('2d')!.drawImage(img, 0, 0, W, H);
                return createImageBitmap(c);
              },
            });
          } else {
            op.href = p.href;
          }
          out.push(op);
          break;
        }
        case 'raster': {
          const op: WireImage = { o: 'image', a, b, x: p.x, y: p.y, w: p.w, h: p.h };
          const ppp = scaleOf(ctm);
          const area = Math.max(1e-6, p.w * p.h);
          const kind = p.key.split(':')[0];
          let k = Math.min(ppp, Math.sqrt(RASTER_MAX_PX / area));
          if (opts.rasterBudgetMs) k = Math.min(k, Math.sqrt((opts.rasterBudgetMs * 1e6) / (rasterCost.get(kind) ?? RASTER_COST_DEFAULT) / area));
          const W = Math.max(1, Math.min(16384, Math.ceil(p.w * k))), H = Math.max(1, Math.min(16384, Math.ceil(p.h * k)));
          const key = `${p.key}@${W}x${H}`;
          deferred.push({
            op,
            make: async () => {
              const hit = rasterBitmaps.get(key);
              if (hit) {
                rasterBitmaps.delete(key);
                rasterBitmaps.set(key, hit);
                return hit.bmp;
              }
              const c = document.createElement('canvas');
              c.width = W; c.height = H;
              const g = c.getContext('2d')!;
              g.scale(W / p.w, H / p.h);
              const t0 = performance.now();
              p.draw(g, k);
              const ms = performance.now() - t0;
              if (W * H > 65536) rasterCost.set(kind, Math.max(rasterCost.get(kind) ?? RASTER_COST_DEFAULT, (ms * 1e6) / (W * H)));
              const bmp = await createImageBitmap(c);
              rasterBitmaps.set(key, { bmp, px: W * H });
              rasterBitmapsPx += W * H;
              for (const [k2, v] of rasterBitmaps) {
                if (rasterBitmapsPx <= RASTER_BITMAP_BUDGET || rasterBitmaps.size <= 1) break;
                // Not closed: a list being lowered may still hold it (it is collected once unused).
                rasterBitmapsPx -= v.px;
                rasterBitmaps.delete(k2);
              }
              return bmp;
            },
          });
          out.push(op);
          break;
        }
        case 'group': {
          out.push({
            o: 'group', a, b, m: p.matrix, clip: p.clip ? pid(p.clip) : undefined, rule: p.clipRule === 'evenodd' ? 'evenodd' : undefined,
            layer: !!needsLayer(p, p.children.length), c: lower(p.children, p.matrix ? mulMatrix(ctm, p.matrix) : ctm),
          });
          break;
        }
      }
    }
    return out;
  };

  const ops = lower(prims, m);
  if (svgs.size) await Promise.all([...svgs].map((s) => loadImage(s).catch(() => undefined)));
  let slice = performance.now();
  for (const d of deferred) {
    // One bitmap per task (a resolved createImageBitmap does not yield), so frames get through.
    if (performance.now() - slice > 4) {
      await new Promise((r) => setTimeout(r, 0));
      slice = performance.now();
    }
    const bmp = await d.make();
    if (bmp) d.op.bmp = bmp;
  }
  return { ops, paths, w, h, m, background: opts.background };
}
