/**
 * The display list.
 *
 * Every element type compiles to a small tree of primitives in its own local
 * coordinate box (0,0)–(w,h), y pointing down, units = pt. Three back-ends
 * consume the same list, which is what keeps the editor, the exports and the 3D
 * textures identical:
 *
 *   SVG     → the interactive editor and SVG export        (render/svgBackend.tsx)
 *   Canvas  → 3D textures, thumbnails, video, raster export (render/canvasBackend.ts)
 *   PDF     → print-ready vector PDF                        (export/pdf.ts)
 */
import type { BlendMode } from '../model/types';

export interface GradientStop { offset: number; color: string; opacity?: number }

export interface LinearGradientPaint {
  kind: 'linear';
  x1: number; y1: number; x2: number; y2: number;
  stops: GradientStop[];
}

export interface RadialGradientPaint {
  kind: 'radial';
  cx: number; cy: number; r: number;
  /** Optional focal point. */
  fx?: number; fy?: number;
  stops: GradientStop[];
}

export type Paint = string | LinearGradientPaint | RadialGradientPaint;

interface PrimBase {
  opacity?: number;
  blend?: BlendMode;
}

export interface PathPrim extends PrimBase {
  t: 'path';
  /** SVG path data, absolute or relative commands, local pt units. */
  d: string;
  fill?: Paint | null;
  stroke?: Paint | null;
  strokeWidth?: number;
  dash?: number[];
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  fillRule?: 'nonzero' | 'evenodd';
  /** Ask the PDF writer to set overprint for this fill/stroke. */
  overprint?: boolean;
  /** Technical line: die-cut contour (spot colour in PDF, hidden in 3D textures). */
  role?: 'dieline';
}

/** A font instance as the text engine resolved it. */
export interface FontRef {
  /** Registry family id. */
  family: string;
  /** Registry face key (a specific file). Null when only a CSS stack is known (system fonts). */
  face: string | null;
  /** CSS font-family stack used by SVG/Canvas fallbacks. */
  css: string;
  weight: number;
  italic: boolean;
  /** Complete variation coordinates (all axes of the face). */
  axes: Record<string, number>;
  /** OpenType features explicitly switched on/off. */
  features: Record<string, boolean>;
  /** Italic requested but the family has no italic face: back-ends slant the roman. */
  oblique?: boolean;
}

export interface TextRun {
  x: number;
  y: number;          // baseline
  text: string;
  font: FontRef;
  size: number;       // pt
  color: string;
  /** Extra space after each glyph, pt. */
  letterSpacing?: number;
  /** Pair kerning: extra advance after each UTF-16 unit of `text`, pt (manual + optical). */
  kern?: number[];
  /** Rotation in degrees around (x, y) — used for sideways Latin in vertical text. */
  rotate?: number;
  /** Horizontal compression (tate-chū-yoko). */
  scaleX?: number;
  /** Measured advance width of the run (pt) — used to clip / stretch in back-ends. */
  width: number;
  dir?: 'ltr' | 'rtl';
}

export interface TextPrim extends PrimBase {
  t: 'text';
  runs: TextRun[];
}

export interface ImagePrim extends PrimBase {
  t: 'image';
  /** data:/blob: URL. */
  href: string;
  x: number; y: number; w: number; h: number;
  /** Clip rectangle (local units). */
  clip?: { x: number; y: number; w: number; h: number };
  filter?: 'grayscale' | null;
  /** Cache key; also used to look up the original bytes for PDF embedding. */
  assetId?: string;
}

/**
 * A procedurally rasterised region (brush strokes, grain, blurred meshes).
 * `draw` paints into a context already scaled so that 1 unit = 1 pt.
 */
export interface RasterPrim extends PrimBase {
  t: 'raster';
  key: string;
  x: number; y: number; w: number; h: number;
  draw: (ctx: CanvasRenderingContext2D, pxPerPt: number) => void;
}

export interface GroupPrim extends PrimBase {
  t: 'group';
  children: Prim[];
  /** 2D affine [a, b, c, d, e, f] (same convention as SVG matrix / canvas setTransform). */
  matrix?: Matrix;
  /** Clip path (local units, applied before `matrix` of children). */
  clip?: string;
  clipRule?: 'nonzero' | 'evenodd';
}

export type Prim = PathPrim | TextPrim | ImagePrim | RasterPrim | GroupPrim;
export type Matrix = [number, number, number, number, number, number];

/* -------------------------------------------------------------------------- */
/* Matrix helpers                                                              */
/* -------------------------------------------------------------------------- */

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  // m × n  (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];
export function rotate(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return multiply(translate(cx, cy), multiply([c, s, -s, c, 0, 0], translate(-cx, -cy)));
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/* -------------------------------------------------------------------------- */
/* Small path builders shared by generators                                    */
/* -------------------------------------------------------------------------- */

const f = (n: number) => (Math.abs(n) < 1e-9 ? '0' : +n.toFixed(3) + '');

export function rectPath(x: number, y: number, w: number, h: number, r = 0): string {
  if (r <= 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.5523;
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}C${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)}` +
    `V${f(y + h - r)}C${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}C${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}C${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)}Z`
  );
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const kx = rx * 0.5523, ky = ry * 0.5523;
  return (
    `M${f(cx - rx)} ${f(cy)}` +
    `C${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}` +
    `C${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)}` +
    `C${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}` +
    `C${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)}Z`
  );
}

export const circlePath = (cx: number, cy: number, r: number) => ellipsePath(cx, cy, r, r);

export function polylinePath(pts: [number, number][], close = false): string {
  if (!pts.length) return '';
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${f(pts[i][0])} ${f(pts[i][1])}`;
  return close ? d + 'Z' : d;
}

/** Smooth Catmull-Rom spline through points, emitted as cubic Béziers. */
export function smoothPath(pts: [number, number][], close = false, tension = 0.5): string {
  const n = pts.length;
  if (n < 3) return polylinePath(pts, close);
  const get = (i: number) => (close ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  const last = close ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const t = tension / 3;
    const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return close ? d + 'Z' : d;
}

export const fmt = f;
