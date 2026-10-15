/**
 * Small helpers shared by the generators: parameter specs, a transforming path
 * pen, gold paints and a deterministic string hash for raster cache keys.
 */
import type { GradientStop, LinearGradientPaint, Matrix, PathPrim, RadialGradientPaint } from '../../render/primitives';
import { IDENTITY, applyMatrix, multiply, rotate, scale, translate } from '../../render/primitives';
import { mix } from '../../lib/color';

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

/** One numeric generator parameter, described so the UI can build a slider. */
export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

/** Fill in defaults and clamp user values to the documented range. */
export function readParams(specs: readonly ParamSpec[], raw: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of specs) {
    const v = raw ? raw[s.key] : undefined;
    out[s.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export type Pt = [number, number];

/** Affine for a motif drawn in unit space: translate → rotate (radians) → scale. */
export function place(x: number, y: number, angle = 0, sx = 1, sy = sx): Matrix {
  return multiply(translate(x, y), multiply(rotate(angle / DEG), scale(sx, sy)));
}

/** Coordinates to 1/100 pt — far below any visible or printable difference. */
const f2 = (n: number) => (Math.abs(n) < 5e-3 ? '0' : String(Math.round(n * 100) / 100));

/**
 * A path pen that transforms every coordinate through a matrix before writing
 * it, so motifs can be drawn in a convenient unit space and still come out as
 * page-space path data (gradients and drop shadows then stay page-consistent).
 * Only M/L/C/Z are emitted — the subset every back-end understands.
 */
export class Pen {
  d = '';
  m: Matrix;
  private lx = 0;
  private ly = 0;

  constructor(m: Matrix = IDENTITY) {
    this.m = m;
  }

  private p(x: number, y: number): string {
    const [X, Y] = applyMatrix(this.m, x, y);
    return `${f2(X)} ${f2(Y)}`;
  }

  /** Run `fn` with an extra transform applied on top of the current one. */
  with(m: Matrix, fn: (pen: Pen) => void): this {
    const prev = this.m;
    this.m = multiply(prev, m);
    fn(this);
    this.m = prev;
    return this;
  }

  move(x: number, y: number): this {
    this.d += `M${this.p(x, y)}`;
    this.lx = x; this.ly = y;
    return this;
  }

  line(x: number, y: number): this {
    this.d += `L${this.p(x, y)}`;
    this.lx = x; this.ly = y;
    return this;
  }

  curve(x1: number, y1: number, x2: number, y2: number, x: number, y: number): this {
    this.d += `C${this.p(x1, y1)} ${this.p(x2, y2)} ${this.p(x, y)}`;
    this.lx = x; this.ly = y;
    return this;
  }

  /** Quadratic Bézier, written as the equivalent cubic. */
  quad(qx: number, qy: number, x: number, y: number): this {
    const x0 = this.lx, y0 = this.ly;
    return this.curve(x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
  }

  close(): this {
    this.d += 'Z';
    return this;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    const kx = rx * 0.5523, ky = ry * 0.5523;
    this.move(cx - rx, cy);
    this.curve(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry);
    this.curve(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy);
    this.curve(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry);
    this.curve(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy);
    return this.close();
  }

  circle(cx: number, cy: number, r: number): this {
    return this.ellipse(cx, cy, r, r);
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.move(x, y).line(x + w, y).line(x + w, y + h).line(x, y + h).close();
  }

  poly(pts: readonly Pt[], close = false): this {
    if (!pts.length) return this;
    this.move(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) this.line(pts[i][0], pts[i][1]);
    return close ? this.close() : this;
  }

  /** Catmull-Rom spline through the points. */
  smooth(pts: readonly Pt[], close = false, tension = 0.5): this {
    const n = pts.length;
    if (n < 3) return this.poly(pts, close);
    const get = (i: number) => (close ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    this.move(pts[0][0], pts[0][1]);
    const last = close ? n : n - 1;
    const t = tension / 3;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      this.curve(
        p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t,
        p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t,
        p2[0], p2[1],
      );
    }
    return close ? this.close() : this;
  }

  get empty(): boolean {
    return this.d.length === 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Prims                                                                       */
/* -------------------------------------------------------------------------- */

export function fillPath(d: string, fill: PathPrim['fill'], extra: Partial<PathPrim> = {}): PathPrim {
  return { t: 'path', d, fill, stroke: null, ...extra };
}

export function strokePath(d: string, stroke: PathPrim['stroke'], strokeWidth: number, extra: Partial<PathPrim> = {}): PathPrim {
  return { t: 'path', d, fill: null, stroke, strokeWidth, cap: 'round', join: 'round', ...extra };
}

/* -------------------------------------------------------------------------- */
/* Colour & metal                                                              */
/* -------------------------------------------------------------------------- */

export const lighten = (c: string, t: number) => mix(c, '#ffffff', t);
export const darken = (c: string, t: number) => mix(c, '#000000', t);

/** Warm highlight and deep umber shadow keyed to a gold swatch. */
export function goldRamp(gold: string) {
  return {
    deep: mix(gold, '#1d1104', 0.62),
    shade: mix(gold, '#3a2408', 0.34),
    base: gold,
    light: mix(gold, '#fff3cf', 0.45),
    shine: mix(gold, '#fffdf2', 0.82),
  };
}

/** Raised gold boss / bezant: radial paint with an upper-left focal highlight. */
export function goldRadial(cx: number, cy: number, r: number, gold: string): RadialGradientPaint {
  const g = goldRamp(gold);
  return {
    kind: 'radial', cx, cy, r: r * 1.08, fx: cx - r * 0.38, fy: cy - r * 0.42,
    stops: [
      { offset: 0, color: g.shine },
      { offset: 0.22, color: g.light },
      { offset: 0.55, color: g.base },
      { offset: 0.86, color: g.shade },
      { offset: 1, color: g.deep },
    ],
  };
}

/** Burnished flat gold: banded linear paint, like a polished leaf catching the light. */
export function goldBurnish(x1: number, y1: number, x2: number, y2: number, gold: string): LinearGradientPaint {
  const g = goldRamp(gold);
  return {
    kind: 'linear', x1, y1, x2, y2,
    stops: [
      { offset: 0, color: g.light },
      { offset: 0.16, color: g.base },
      { offset: 0.34, color: g.shine },
      { offset: 0.5, color: g.base },
      { offset: 0.68, color: g.shade },
      { offset: 0.84, color: g.base },
      { offset: 1, color: g.light },
    ],
  };
}

/** A sphere of colour (bead, pearl, berry) lit from the upper left. */
export function sphereRadial(cx: number, cy: number, r: number, color: string, gloss = 0.7): RadialGradientPaint {
  const stops: GradientStop[] = [
    { offset: 0, color: mix(color, '#ffffff', gloss) },
    { offset: 0.3, color: mix(color, '#ffffff', gloss * 0.25) },
    { offset: 0.7, color },
    { offset: 1, color: mix(color, '#000000', 0.45) },
  ];
  return { kind: 'radial', cx, cy, r: r * 1.1, fx: cx - r * 0.4, fy: cy - r * 0.45, stops };
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

/** FNV-1a string hash → base36, for RasterPrim cache keys. */
export function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Graphemes of a string without whitespace (for letter fields). */
export function glyphsOf(text: string, fallback: string): string[] {
  const chars = Array.from((text || '').replace(/\s+/g, ''));
  return chars.length ? chars : Array.from(fallback);
}

/** Create a scratch canvas inside a RasterPrim draw call (Offscreen when available). */
export function scratchCanvas(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    return ctx ? { canvas, ctx } : null;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

/** Pixel density for procedural rasters: honour the host's pt→px scale but cap the buffer size. */
export function rasterDensity(w: number, h: number, pxPerPt: number, maxPixels = 16e6): number {
  const area = Math.max(1, w * h);
  return Math.max(0.25, Math.min(pxPerPt, Math.sqrt(maxPixels / area)));
}
