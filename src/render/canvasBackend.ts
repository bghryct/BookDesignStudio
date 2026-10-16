/**
 * Canvas 2D back-end: display list → pixels. Used for 3D textures, thumbnails, PNG export
 * and anything that needs raster output. Text is drawn from the fonts' real glyph outlines
 * (same shaping as the PDF), falling back to fillText for system fonts.
 */
import type { BlendMode } from '../model/types';
import type { Paint, Prim, TextRun } from './primitives';
import { shape, glyphPath, canOutline, glyphKerns } from '../engine/fonts';
import { getImage, loadImage } from './images';

export interface CanvasOptions {
  pxPerPt: number;
  hideDieLines?: boolean;
}

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

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

function paintStyle(ctx: CanvasRenderingContext2D, p: Paint): string | CanvasGradient {
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

function drawRun(ctx: CanvasRenderingContext2D, r: TextRun) {
  ctx.save();
  if (r.rotate) {
    ctx.translate(r.x, r.y);
    ctx.rotate((r.rotate * Math.PI) / 180);
    ctx.translate(-r.x, -r.y);
  }
  if (r.scaleX && r.scaleX !== 1) {
    ctx.translate(r.x, 0);
    ctx.scale(r.scaleX, 1);
    ctx.translate(-r.x, 0);
  }
  ctx.fillStyle = r.color;
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
        ctx.restore();
      }
      x += g.xAdvance * r.size + ls + (gk ? gk[gi] : 0);
    }
  } else {
    ctx.font = `${r.font.italic ? 'italic ' : ''}${r.font.weight} ${r.size}px ${r.font.css}`;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${ls}px`;
    ctx.fillText(r.text, r.x, r.y);
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
