/**
 * A serialisable form of the display list ("wire" ops), for rasterising in a worker.
 *
 * The main thread lowers a display list to these (canvasBackend `lowerPrims`): text becomes
 * glyph outlines with their final matrices (so the worker needs no fonts), and raster callbacks
 * become bitmaps. `drawWire` replays them on any 2D context (an OffscreenCanvas in a worker, or a
 * canvas), producing the same pixels as `drawPrims`. No DOM, no fonts, no three.js.
 */
import type { BlendMode } from '../model/types';
import type { FinishParams } from '../three/finishing';
import type { FinishKey } from '../three/types';
import type { Matrix, Paint } from './primitives';

interface OpBase {
  /** Opacity of this op (multiplied into the context's). */
  a: number;
  b?: BlendMode;
}

export interface WirePath extends OpBase {
  o: 'path';
  /** Index into WireList.paths. */
  d: number;
  fill?: Paint | null;
  stroke?: Paint | null;
  sw?: number;
  dash?: number[];
  cap?: CanvasLineCap;
  join?: CanvasLineJoin;
  rule?: CanvasFillRule;
}

/** One text run drawn from glyph outlines: 8 numbers per glyph (path index, matrix a–f, stroke width). */
export interface WireGlyphs extends OpBase {
  o: 'glyphs';
  color: string;
  stroke?: string;
  g: Float64Array;
}

/** A run with no outlines (system font): fillText under matrix `m`. */
export interface WireText extends OpBase {
  o: 'text';
  m: Matrix;
  font: string;
  ls: number;
  color: string;
  stroke?: { color: string; width: number };
  text: string;
  x: number;
  y: number;
}

/** An image by URL (decoded where it is drawn), or already decoded (`bmp`). */
export interface WireImage extends OpBase {
  o: 'image';
  href?: string;
  bmp?: ImageBitmap;
  x: number; y: number; w: number; h: number;
  clip?: { x: number; y: number; w: number; h: number };
  gray?: boolean;
}

export interface WireGroup extends OpBase {
  o: 'group';
  m?: Matrix;
  /** Index into WireList.paths. */
  clip?: number;
  rule?: CanvasFillRule;
  /** Isolated: children go to a layer that is composited once. */
  layer: boolean;
  c: WireOp[];
}

export type WireOp = WirePath | WireGlyphs | WireText | WireImage | WireGroup;

export interface WireList {
  ops: WireOp[];
  /** Path data (SVG syntax) referenced by index, each distinct path once. */
  paths: string[];
  /** Pixel size, and the device transform (pt → px) the ops are drawn under. */
  w: number;
  h: number;
  m: Matrix;
  background?: string;
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

export function paintStyle(ctx: Ctx2D, p: Paint): string | CanvasGradient {
  if (typeof p === 'string') return p;
  const g = p.kind === 'linear'
    ? ctx.createLinearGradient(p.x1, p.y1, p.x2, p.y2)
    : ctx.createRadialGradient(p.fx ?? p.cx, p.fy ?? p.cy, 0, p.cx, p.cy, Math.max(0.001, p.r));
  for (const s of p.stops) {
    let c = s.color;
    if (s.opacity != null && s.opacity < 1) {
      const m = c.match(/^#?([0-9a-f]{6})$/i);
      if (m) {
        const v = parseInt(m[1], 16);
        c = `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${s.opacity})`;
      }
    }
    g.addColorStop(Math.max(0, Math.min(1, s.offset)), c);
  }
  return g;
}

/** a·b for canvas matrices (b applied first). */
export function mulMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export interface WireEnv {
  /** Decoded image for an href (null: skip, like an image that failed to load). */
  image(href: string): CanvasImageSource | null;
  /** A transparent layer the size of the target. */
  layer(w: number, h: number): { ctx: Ctx2D; canvas: CanvasImageSource };
  path(d: string): Path2D;
}

/** Every image URL the list draws (to decode before drawing). */
export function wireImages(list: WireList): Set<string> {
  const out = new Set<string>();
  const walk = (ops: WireOp[]) => {
    for (const op of ops) {
      if (op.o === 'image' && op.href && !op.bmp) out.add(op.href);
      else if (op.o === 'group') walk(op.c);
    }
  };
  walk(list.ops);
  return out;
}

/** Draw a list onto `ctx` (a context of list.w × list.h pixels). */
export function drawWire(ctx: Ctx2D, list: WireList, env: WireEnv): void {
  const paths: (Path2D | undefined)[] = new Array(list.paths.length);
  const path = (i: number) => paths[i] ?? (paths[i] = env.path(list.paths[i]));
  ctx.save();
  if (list.background) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = list.background;
    ctx.fillRect(0, 0, list.w, list.h);
  }
  ctx.setTransform(...list.m);
  drawOps(ctx, list.ops, list, env, path);
  ctx.restore();
}

function drawOps(ctx: Ctx2D, ops: WireOp[], list: WireList, env: WireEnv, path: (i: number) => Path2D): void {
  for (const op of ops) {
    if (op.a <= 0) continue;
    ctx.save();
    ctx.globalAlpha *= op.a;
    if (op.b && op.b !== 'normal') ctx.globalCompositeOperation = COMPOSITE[op.b];
    try {
      switch (op.o) {
        case 'path': {
          const p = path(op.d);
          if (op.fill) {
            ctx.fillStyle = paintStyle(ctx, op.fill);
            ctx.fill(p, op.rule ?? 'nonzero');
          }
          if (op.stroke && (op.sw ?? 1) > 0) {
            ctx.strokeStyle = paintStyle(ctx, op.stroke);
            ctx.lineWidth = op.sw ?? 1;
            ctx.lineCap = op.cap ?? 'butt';
            ctx.lineJoin = op.join ?? 'miter';
            ctx.setLineDash(op.dash ?? []);
            ctx.stroke(p);
          }
          break;
        }
        case 'glyphs': {
          const base = ctx.getTransform();
          ctx.fillStyle = op.color;
          if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineJoin = 'round'; }
          const g = op.g;
          for (let i = 0; i < g.length; i += 8) {
            ctx.setTransform(base);
            ctx.transform(g[i + 1], g[i + 2], g[i + 3], g[i + 4], g[i + 5], g[i + 6]);
            const p = path(g[i]);
            ctx.fill(p);
            if (op.stroke) { ctx.lineWidth = g[i + 7]; ctx.stroke(p); }
          }
          break;
        }
        case 'text': {
          ctx.transform(...op.m);
          ctx.font = op.font;
          ctx.textBaseline = 'alphabetic';
          if ('letterSpacing' in ctx) (ctx as Ctx2D & { letterSpacing: string }).letterSpacing = `${op.ls}px`;
          ctx.fillStyle = op.color;
          ctx.fillText(op.text, op.x, op.y);
          if (op.stroke) { ctx.strokeStyle = op.stroke.color; ctx.lineJoin = 'round'; ctx.lineWidth = op.stroke.width; ctx.strokeText(op.text, op.x, op.y); }
          break;
        }
        case 'image': {
          const img = op.bmp ?? (op.href ? env.image(op.href) : null);
          if (!img) break;
          if (op.clip) {
            ctx.beginPath();
            ctx.rect(op.clip.x, op.clip.y, op.clip.w, op.clip.h);
            ctx.clip();
          }
          if (op.gray) ctx.filter = 'grayscale(1)';
          ctx.drawImage(img, op.x, op.y, op.w, op.h);
          break;
        }
        case 'group': {
          if (op.m) ctx.transform(...op.m);
          if (op.clip != null) ctx.clip(path(op.clip), op.rule ?? 'nonzero');
          if (op.layer) {
            const layer = env.layer(list.w, list.h);
            layer.ctx.setTransform(ctx.getTransform());
            drawOps(layer.ctx, op.c, list, env, path);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(layer.canvas, 0, 0);
          } else {
            drawOps(ctx, op.c, list, env, path);
          }
          break;
        }
      }
    } finally {
      ctx.restore();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Raster worker protocol                                                       */
/* -------------------------------------------------------------------------- */

/** A printed panel to rasterise and finish: art over `base`, finish masks, baked into maps. */
export interface PanelJob {
  art: WireList;
  /** Same size and transform as `art`; coverage = alpha. */
  masks: { key: FinishKey; list: WireList }[];
  base: string;
  fp: FinishParams;
  /**
   * A band of a bigger panel (several workers finish one panel): the lists cover rows from
   * `row0` of the whole; rows `top`…`top + rows` are kept (the rest is margin for the blur).
   * `half`: the whole panel's surface / height / iridescence maps are kept at half size.
   */
  band?: { row0: number; top: number; rows: number; half: boolean };
}

/** Finished panel maps (see finishing.ts); null maps are flat. */
export interface PanelBitmaps {
  color: ImageBitmap;
  surface: ImageBitmap | null;
  flatSurface: [number, number, number];
  bump: ImageBitmap | null;
  holo: ImageBitmap | null;
  hasGloss: boolean;
  hasClearcoat: boolean;
}

/** Bands of one panel (PanelJob.band) to join: band i starts at row rows[i] of a w × h whole. */
export interface StitchJob {
  parts: PanelBitmaps[];
  rows: number[];
  w: number;
  h: number;
  half: boolean;
}

export type RasterRequest =
  | { id: number; kind: 'surface'; list: WireList; /** White with the art's alpha (a finish mask). */ mask?: boolean }
  | ({ id: number; kind: 'panel' } & PanelJob)
  | ({ id: number; kind: 'stitch' } & StitchJob);

export type RasterResponse =
  | { id: number; ok: true; bmp?: ImageBitmap; maps?: PanelBitmaps; ms: number }
  | { id: number; ok: false; error: string };
