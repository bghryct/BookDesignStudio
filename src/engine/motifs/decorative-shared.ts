/**
 * Helpers shared by the decorative motifs: colour slots with sensible fallbacks,
 * a cached procedural raster, Bézier arcs for the transforming Pen and a
 * measured text run.
 */
import type { MotifElement } from '../../model/types';
import type { FontRef, RasterPrim, TextRun } from '../../render/primitives';
import { parseColor } from '../../lib/color';
import type { Pen } from '../generators/util';
import { hashStr, scratchCanvas } from '../generators/util';
import type { GenContext } from '../generators/context';
import type { MotifDef } from './types';
import { motifParams } from './types';

/* -------------------------------------------------------------------------- */
/* Parameters & colours                                                        */
/* -------------------------------------------------------------------------- */

/** Clamped params with defaults (tolerates a missing params record). */
export const readMotifParams = (def: MotifDef, el: MotifElement): Record<string, number> =>
  motifParams(def, el.params ?? {});

/** '', 'none' and 'transparent' mean "no paint". */
export const isNone = (c: string | null | undefined): boolean => !c || /^\s*(none|transparent)\s*$/i.test(c);

/** A required colour slot: an empty value falls back to the slot's default. */
export function slot(def: MotifDef, el: MotifElement, i: number): string {
  const c = el.colors?.[i];
  if (typeof c === 'string' && !isNone(c)) return c;
  const d = def.colors[i]?.default;
  return d && !isNone(d) ? d : '#1b1813';
}

/** An optional colour slot: an explicitly empty value means none (null). */
export function optSlot(def: MotifDef, el: MotifElement, i: number): string | null {
  const c = el.colors?.[i];
  if (typeof c === 'string') return isNone(c) ? null : c;
  const d = def.colors[i]?.default;
  return d && !isNone(d) ? d : null;
}

export type RGB = [number, number, number];

export function rgbOf(c: string): RGB {
  const p = parseColor(c);
  const ok = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(255, v)) : 0);
  return [ok(p.r), ok(p.g), ok(p.b)];
}

export const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Is the element box drawable at all? */
export const okBox = (el: MotifElement): boolean => Number.isFinite(el.w) && Number.isFinite(el.h) && el.w > 0 && el.h > 0;

/** Seed as a safe 32-bit integer. */
export const seedOf = (el: MotifElement): number => (Number.isFinite(el.seed) ? Math.floor(el.seed) | 0 : 0);

/** Cache key for a raster motif: everything that changes its pixels. */
export const rasterKey = (kind: string, el: MotifElement, p: Record<string, number>, colors: string[]): string =>
  `${kind}:${hashStr(`${el.w}x${el.h}|${seedOf(el)}|${JSON.stringify(p)}|${colors.join(',')}`)}`;

/* -------------------------------------------------------------------------- */
/* Procedural raster                                                           */
/* -------------------------------------------------------------------------- */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface RasterGrid {
  /** Buffer size in device pixels. */
  W: number;
  H: number;
  /** pt per pixel, horizontally and vertically. */
  sx: number;
  sy: number;
  /** Device pixels per pt. */
  ppp: number;
}

const rasterCache = new Map<string, { canvas: AnyCanvas; px: number }>();
let rasterCachePx = 0;
const RASTER_CACHE_BUDGET = 24e6;

/**
 * A single RasterPrim covering the element box. `paint` fills a scratch buffer
 * whose pixels map to pt through `grid`; all sampling must happen in pt space so
 * the image is the same at every resolution. Buffers are capped (≈12 MP by
 * default) and recently painted ones are kept, since marbling is not cheap.
 */
export function rasterMotif(key: string, w: number, h: number, paint: (o: Ctx2D, grid: RasterGrid) => void, maxPixels = 12e6): RasterPrim {
  return {
    t: 'raster', key, x: 0, y: 0, w, h,
    draw: (target, pxPerPt) => {
      const want = Number.isFinite(pxPerPt) && pxPerPt > 0 ? pxPerPt : 1;
      const ppp = Math.max(0.02, Math.min(want, Math.sqrt(maxPixels / Math.max(1e-6, w * h))));
      const W = Math.max(1, Math.min(8192, Math.ceil(w * ppp)));
      const H = Math.max(1, Math.min(8192, Math.ceil(h * ppp)));
      const ck = `${key}@${W}x${H}`;
      let hit = rasterCache.get(ck);
      if (hit) {
        rasterCache.delete(ck);
        rasterCache.set(ck, hit);
      } else {
        const sc = scratchCanvas(W, H);
        if (!sc) return;
        paint(sc.ctx, { W, H, sx: w / W, sy: h / H, ppp: Math.min(W / w, H / h) });
        hit = { canvas: sc.canvas, px: W * H };
        rasterCache.set(ck, hit);
        rasterCachePx += hit.px;
        while (rasterCachePx > RASTER_CACHE_BUDGET && rasterCache.size > 1) {
          const [k, v] = rasterCache.entries().next().value as [string, { canvas: AnyCanvas; px: number }];
          rasterCache.delete(k);
          rasterCachePx -= v.px;
        }
      }
      target.drawImage(hit.canvas, 0, 0, w, h);
    },
  };
}

/**
 * Fill a raster by sampling `fn(x, y, out)` (pt coordinates, out = RGBA 0–255)
 * with `ss`×`ss` supersampling per pixel — the box filter that keeps fine
 * combed lines from aliasing at screen resolution.
 */
export function sampleField(o: Ctx2D, g: RasterGrid, ss: number, fn: (x: number, y: number, out: Float64Array) => void): void {
  const { W, H, sx, sy } = g;
  const img = o.createImageData(W, H);
  const d = img.data;
  const out = new Float64Array(4);
  const n = Math.max(1, Math.floor(ss));
  const inv = 1 / (n * n);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let r = 0, gg = 0, b = 0, a = 0;
      for (let v = 0; v < n; v++) {
        const y = (j + (v + 0.5) / n) * sy;
        for (let u = 0; u < n; u++) {
          const x = (i + (u + 0.5) / n) * sx;
          out[3] = 255;
          fn(x, y, out);
          // Premultiplied accumulation keeps translucent edges clean.
          const al = out[3] / 255;
          r += out[0] * al; gg += out[1] * al; b += out[2] * al; a += al;
        }
      }
      const k = (j * W + i) * 4;
      if (a > 0) {
        d[k] = r / a; d[k + 1] = gg / a; d[k + 2] = b / a;
        d[k + 3] = a * inv * 255;
      }
    }
  }
  o.putImageData(img, 0, 0);
}

/** Supersampling factor for a field: finer at low density, capped by a sample budget. */
export function superSamples(g: RasterGrid, budget = 16e6): number {
  let ss = g.ppp < 1.25 ? 3 : g.ppp < 2.6 ? 2 : 1;
  while (ss > 1 && g.W * g.H * ss * ss > budget) ss--;
  return ss;
}

/**
 * A smooth vector field sampled on a coarse lattice (pt) and read back
 * bilinearly — domain warps cost one fbm per lattice node instead of per pixel.
 */
export class Lattice {
  readonly nx: number;
  readonly ny: number;
  readonly data: Float32Array;

  constructor(readonly x0: number, readonly y0: number, w: number, h: number, readonly step: number, readonly channels: number, fn: (x: number, y: number, out: number[]) => void) {
    this.nx = Math.max(2, Math.ceil(w / step) + 2);
    this.ny = Math.max(2, Math.ceil(h / step) + 2);
    this.data = new Float32Array(this.nx * this.ny * channels);
    const tmp: number[] = new Array(channels).fill(0);
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        fn(x0 + i * step, y0 + j * step, tmp);
        const o = (j * this.nx + i) * channels;
        for (let c = 0; c < channels; c++) this.data[o + c] = Number.isFinite(tmp[c]) ? tmp[c] : 0;
      }
    }
  }

  /** Bilinear read of all channels into `out`. */
  read(x: number, y: number, out: number[]): void {
    const fx = Math.max(0, Math.min(this.nx - 1.0001, (x - this.x0) / this.step));
    const fy = Math.max(0, Math.min(this.ny - 1.0001, (y - this.y0) / this.step));
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const C = this.channels, nx = this.nx, d = this.data;
    const o00 = (j * nx + i) * C, o10 = o00 + C, o01 = o00 + nx * C, o11 = o01 + C;
    for (let c = 0; c < C; c++) {
      const a = d[o00 + c] + (d[o10 + c] - d[o00 + c]) * u;
      const b = d[o01 + c] + (d[o11 + c] - d[o01 + c]) * u;
      out[c] = a + (b - a) * v;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Circular arc as cubic Béziers (≤ 90° each) on a Pen. Angles in radians, y down
 * (positive = clockwise on the page). `join` continues the current subpath.
 */
export function arcTo(pen: Pen, cx: number, cy: number, r: number, a0: number, a1: number, join = false): Pen {
  const span = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(span) / (Math.PI / 2) - 1e-9));
  const da = span / n;
  const k = (4 / 3) * Math.tan(da / 4);
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  if (join) pen.line(x0, y0); else pen.move(x0, y0);
  for (let i = 0; i < n; i++) {
    const a = a0 + i * da, b = a + da;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    pen.curve(
      cx + r * (ca - k * sa), cy + r * (sa + k * ca),
      cx + r * (cb + k * sb), cy + r * (sb - k * cb),
      cx + r * cb, cy + r * sb,
    );
  }
  return pen;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

/** Measured advance (pt) including letter-spacing after every glyph. */
export function advance(ctx: GenContext, text: string, font: FontRef, size: number, ls = 0): number {
  const m = ctx.measure(text, font, size);
  const w = (Number.isFinite(m) ? m : text.length * size * 0.5) + ls * Array.from(text).length;
  return Math.max(0, w);
}

/**
 * A run placed by alignment of its *visible* width (trailing letter-space
 * excluded, so letter-spaced caps centre optically).
 */
export function placeRun(
  ctx: GenContext, text: string, font: FontRef, size: number, x: number, y: number, color: string,
  align: 'left' | 'center' | 'right' = 'left', ls = 0,
): TextRun {
  const width = advance(ctx, text, font, size, ls);
  const vis = Math.max(0, width - (text.length ? ls : 0));
  const left = align === 'center' ? x - vis / 2 : align === 'right' ? x - vis : x;
  const run: TextRun = { x: left, y, text, font, size, color, width };
  if (ls) run.letterSpacing = ls;
  return run;
}
