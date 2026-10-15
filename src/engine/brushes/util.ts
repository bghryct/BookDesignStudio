/**
 * Shared plumbing for the brush renderers: scratch canvases, device-pixel
 * layers, even-spacing resampling, stamp sprites and a fast alpha blur.
 *
 * Everything that affects the *look* of a stroke is expressed in pt, never in
 * device pixels, so a stroke re-rasterised at a different resolution keeps the
 * same character and only gains sharpness.
 */
import type { BrushStroke } from '../../model/types';
import { parseColor, toHex } from '../../lib/color';
import { clamp, fbm, hash2 } from '../../lib/random';

/* -------------------------------------------------------------------------- */
/* Canvas factory                                                              */
/* -------------------------------------------------------------------------- */

/** The single place scratch canvases are created (swap for OffscreenCanvas in a worker). */
export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function context2d(c: HTMLCanvasElement, readback = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Small maths                                                                 */
/* -------------------------------------------------------------------------- */

export interface Rect { x: number; y: number; w: number; h: number }

/** Everything a brush renderer needs for one stroke. */
export interface Job {
  /** Destination; its transform maps 1 unit = 1 pt. */
  ctx: CanvasRenderingContext2D;
  stroke: BrushStroke;
  pxPerPt: number;
  /** Paper tooth of the drawing, 0–1. */
  paperGrain: number;
  /** pt-space region worth rasterising (stroke bounds ∩ visible area). */
  region: Rect;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Pressure as stored on a point, sanitised to 0–1 (missing pressure reads as 0.5). */
export const sanePressure = (p: number) => (Number.isFinite(p) ? clamp(p, 0, 1) : 0.5);

/* -------------------------------------------------------------------------- */
/* Device-pixel layers                                                         */
/* -------------------------------------------------------------------------- */

const MAX_DIM = 4096;
const MAX_AREA = 4096 * 3072;

interface PoolSlot { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; busy: boolean }
const pool: PoolSlot[] = [];

/**
 * An offscreen region in device pixels covering part of pt-space.
 * Its context is pre-transformed so drawing happens in pt.
 */
export interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Device-pixel origin (integer) — the layer's (0,0) is pt (x0 / s, y0 / s). */
  x0: number;
  y0: number;
  /** Size in device px. */
  w: number;
  h: number;
  /** Device px per pt used in this layer (may be below the requested one for huge strokes). */
  s: number;
  slot: PoolSlot;
}

const roundUp = (v: number, step: number) => Math.ceil(v / step) * step;

/** Opens a cleared layer covering `bounds` (pt). Returns null when nothing is visible. */
export function openLayer(bounds: Rect, pxPerPt: number): Layer | null {
  if (!(bounds.w > 0 && bounds.h > 0)) return null;
  let s = Math.max(0.05, pxPerPt);
  const fit = Math.min(1, MAX_DIM / (bounds.w * s), MAX_DIM / (bounds.h * s), Math.sqrt(MAX_AREA / (bounds.w * bounds.h * s * s)));
  s *= fit;
  const x0 = Math.floor(bounds.x * s), y0 = Math.floor(bounds.y * s);
  const w = Math.ceil((bounds.x + bounds.w) * s) - x0;
  const h = Math.ceil((bounds.y + bounds.h) * s) - y0;
  if (w <= 0 || h <= 0) return null;

  let slot = pool.find((sl) => !sl.busy);
  if (!slot) {
    const canvas = createCanvas(roundUp(w, 256), roundUp(h, 256));
    slot = { canvas, ctx: context2d(canvas, true), busy: false };
    pool.push(slot);
  }
  slot.busy = true;
  const { canvas, ctx } = slot;
  if (canvas.width < w || canvas.height < h) {
    canvas.width = Math.max(canvas.width, roundUp(w, 256));
    canvas.height = Math.max(canvas.height, roundUp(h, 256));
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(s, 0, 0, s, -x0, -y0);
  return { canvas, ctx, x0, y0, w, h, s, slot };
}

/** Draws the layer back onto `dst` (whose transform maps 1 unit = 1 pt) and releases it. */
export function compositeLayer(
  dst: CanvasRenderingContext2D, layer: Layer, alpha: number, op: GlobalCompositeOperation = 'source-over',
): void {
  dst.save();
  dst.globalAlpha = clamp(alpha, 0, 1);
  dst.globalCompositeOperation = op;
  dst.imageSmoothingEnabled = true;
  dst.drawImage(layer.canvas, 0, 0, layer.w, layer.h, layer.x0 / layer.s, layer.y0 / layer.s, layer.w / layer.s, layer.h / layer.s);
  dst.restore();
  releaseLayer(layer);
}

export function releaseLayer(layer: Layer): void {
  layer.slot.busy = false;
}

/** Frees every pooled layer (safety net if a renderer bails out mid-way). */
export function releaseAllLayers(): void {
  for (const sl of pool) sl.busy = false;
}

/** Recolours everything drawn on the layer with `color`, keeping its alpha. */
export function colorize(layer: Layer, color: string): void {
  const c = layer.ctx;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = color;
  c.fillRect(0, 0, layer.w, layer.h);
  c.restore();
}

/** Stroke colour without any alpha component (opacity is a separate control). */
export const solid = (c: string) => toHex(parseColor(c));

export function readLayer(layer: Layer): ImageData {
  return layer.ctx.getImageData(0, 0, layer.w, layer.h);
}

export function writeLayer(layer: Layer, img: ImageData): void {
  layer.ctx.putImageData(img, 0, 0);
}

/**
 * The part of pt-space visible on `ctx`'s canvas (inverse of its current
 * transform), or null when it cannot be determined. Used to avoid rasterising
 * stroke regions that are off screen.
 */
export function visibleRect(ctx: CanvasRenderingContext2D): Rect | null {
  const cv = ctx.canvas as HTMLCanvasElement | undefined;
  if (!cv || typeof ctx.getTransform !== 'function' || !cv.width || !cv.height) return null;
  const m = ctx.getTransform();
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = m.inverse();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[0, 0], [cv.width, 0], [0, cv.height], [cv.width, cv.height]]) {
    const x = inv.a * px + inv.c * py + inv.e, y = inv.b * px + inv.d * py + inv.f;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function intersect(a: Rect, b: Rect | null, pad = 0): Rect {
  if (!b) return a;
  const x0 = Math.max(a.x, b.x - pad), y0 = Math.max(a.y, b.y - pad);
  const x1 = Math.min(a.x + a.w, b.x + b.w + pad), y1 = Math.min(a.y + a.h, b.y + b.h + pad);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/* -------------------------------------------------------------------------- */
/* Resampling                                                                  */
/* -------------------------------------------------------------------------- */

export interface Sample {
  x: number;
  y: number;
  /** Pressure 0–1. */
  p: number;
  /** Arc length from the stroke start, pt. */
  d: number;
  /** Unit tangent. */
  tx: number;
  ty: number;
}

/**
 * Catmull-Rom smoothed, evenly spaced samples along the stroke (spacing in pt).
 * Spacing must never depend on device resolution: random streams are consumed
 * per sample, so the same samples are needed at every resolution.
 */
export function resample(points: number[], spacing: number): Sample[] {
  spacing = Math.max(0.05, spacing);
  const xs: number[] = [], ys: number[] = [], ps: number[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i], y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const n = xs.length;
    if (n && Math.abs(x - xs[n - 1]) < 1e-4 && Math.abs(y - ys[n - 1]) < 1e-4) {
      ps[n - 1] = Math.max(ps[n - 1], sanePressure(points[i + 2]));
      continue;
    }
    xs.push(x); ys.push(y); ps.push(sanePressure(points[i + 2]));
  }
  const m = xs.length;
  if (!m) return [];
  if (m === 1) return [{ x: xs[0], y: ys[0], p: ps[0], d: 0, tx: 1, ty: 0 }];

  // 1. Dense Catmull-Rom polyline (~0.75pt pieces).
  const dx: number[] = [xs[0]], dy: number[] = [ys[0]], dp: number[] = [ps[0]];
  for (let k = 0; k < m - 1; k++) {
    const k0 = Math.max(0, k - 1), k3 = Math.min(m - 1, k + 2);
    const len = Math.hypot(xs[k + 1] - xs[k], ys[k + 1] - ys[k]);
    const steps = clamp(Math.ceil(len / 0.75), 1, 32);
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dx.push(cr(xs[k0], xs[k], xs[k + 1], xs[k3]));
      dy.push(cr(ys[k0], ys[k], ys[k + 1], ys[k3]));
      dp.push(lerp(ps[k], ps[k + 1], t));
    }
  }

  // 2. Walk the polyline emitting a sample every `spacing`.
  const out: Sample[] = [{ x: dx[0], y: dy[0], p: dp[0], d: 0, tx: 1, ty: 0 }];
  let carry = 0, dist = 0;
  for (let i = 0; i < dx.length - 1; i++) {
    const ax = dx[i], ay = dy[i], bx = dx[i + 1], by = dy[i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-9) continue;
    let pos = spacing - carry;
    while (pos <= L) {
      const t = pos / L;
      out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, p: lerp(dp[i], dp[i + 1], t), d: dist + pos, tx: 1, ty: 0 });
      pos += spacing;
    }
    carry = L - (pos - spacing);
    dist += L;
  }
  const last = dx.length - 1;
  if (carry > spacing * 0.05) out.push({ x: dx[last], y: dy[last], p: dp[last], d: dist, tx: 1, ty: 0 });

  // 3. Tangents by central differences.
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)];
    const vx = b.x - a.x, vy = b.y - a.y, l = Math.hypot(vx, vy);
    if (l > 1e-9) { out[i].tx = vx / l; out[i].ty = vy / l; }
    else if (i > 0) { out[i].tx = out[i - 1].tx; out[i].ty = out[i - 1].ty; }
  }
  return out;
}

/** Axis-aligned bounds of the raw points (pt), or null for an empty stroke. */
export function pointBounds(points: number[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i], y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** How far paint can reach from the centre line, pt (radius + bleed / dust / spray). */
export function brushReach(s: BrushStroke): number {
  const r = Math.max(0.05, s.size) / 2;
  switch (s.brush) {
    case 'watercolor': return r * (1.75 + 0.35 * clamp(s.wetness, 0, 1)) + 2;
    case 'charcoal': return r * 1.7 + 1;
    case 'pastel': return r * 1.35 + 1;
    case 'airbrush': return r * 1.2 + 1;
    case 'gouache': return r * 1.25 + 1;
    case 'gold-leaf': return r * 1.15 + 1;
    default: return r * 1.12 + 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Stamp sprites                                                               */
/* -------------------------------------------------------------------------- */

const spriteCache = new Map<string, HTMLCanvasElement>();
const SPRITE = 128;

/** Radial profile: 1 inside `hard`, raised-cosine falloff to 0 at r = 1. */
export function falloff(r: number, hard: number): number {
  if (r >= 1) return 0;
  if (r <= hard) return 1;
  const f = (r - hard) / (1 - hard);
  return 0.5 + 0.5 * Math.cos(Math.PI * f);
}

function makeSprite(fn: (nx: number, ny: number) => number, size = SPRITE): HTMLCanvasElement {
  const c = createCanvas(size, size);
  const ctx = context2d(c);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(clamp(fn(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1), 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** White round dab with alpha falloff (hardness 0 = airbrush-soft, 1 = crisp). */
export function softSprite(hardness: number): HTMLCanvasElement {
  const hb = Math.round(clamp(hardness, 0, 1) * 20) / 20;
  const key = `soft:${hb}`;
  let c = spriteCache.get(key);
  if (!c) {
    const hard = Math.min(hb, 1 - 3 / SPRITE);
    c = makeSprite((x, y) => falloff(Math.hypot(x, y), hard));
    spriteCache.set(key, c);
  }
  return c;
}

/**
 * Irregular dab for charcoal / crayon / pastel: noisy outline plus internal
 * clumping. Several variants are cycled (and rotated) to avoid repetition.
 */
export function roughSprite(variant: number, hardness: number, rough: number): HTMLCanvasElement {
  const hb = Math.round(clamp(hardness, 0, 1) * 10) / 10;
  const rb = Math.round(clamp(rough, 0, 1) * 10) / 10;
  const v = variant & 3;
  const key = `rough:${v}:${hb}:${rb}`;
  let c = spriteCache.get(key);
  if (!c) {
    const hard = Math.min(hb, 0.95);
    const seed = 977 + v * 131;
    c = makeSprite((x, y) => {
      const r = Math.hypot(x, y);
      const edge = fbm(x * 2.2 + 7, y * 2.2 + 3, 3, seed);
      const r2 = r * (1 + (edge - 0.5) * rb * 0.9);
      const clump = 1 - rb * 0.45 * hash2(Math.floor((x + 1) * 40), Math.floor((y + 1) * 40), seed);
      return falloff(r2 / 0.95, hard) * clump;
    }, 96);
    spriteCache.set(key, c);
  }
  return c;
}

/* -------------------------------------------------------------------------- */
/* Alpha blur                                                                  */
/* -------------------------------------------------------------------------- */

const scratch: Float32Array[] = [new Float32Array(0), new Float32Array(0), new Float32Array(0)];
/** Reusable scratch buffers (slot 0–2), at least `n` long. Contents are garbage. */
export function scratchF32(slot: number, n: number): Float32Array {
  if (scratch[slot].length < n) scratch[slot] = new Float32Array(Math.ceil(n * 1.25));
  return scratch[slot];
}

function boxPass(src: Float32Array, dst: Float32Array, len: number, lines: number, step: number, lineStep: number, r: number) {
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let sum = 0;
    for (let k = 0; k <= r && k < len; k++) sum += src[base + k * step];
    for (let k = 0; k < len; k++) {
      dst[base + k * step] = sum * norm;
      const add = k + r + 1, rem = k - r;
      if (add < len) sum += src[base + add * step];
      if (rem >= 0) sum -= src[base + rem * step];
    }
  }
}

/**
 * Alpha channel of `data` as 0–1 floats (slot 0) and its box blur with radius
 * `r` device px (slot 1); two iterations approximate a tent / near-Gaussian
 * blur. Outside the layer counts as empty.
 */
export function alphaAndBlur(
  data: Uint8ClampedArray, w: number, h: number, r: number, iterations = 1,
): { a: Float32Array; b: Float32Array } {
  const n = w * h;
  const a = scratchF32(0, n), b = scratchF32(1, n), tmp = scratchF32(2, n);
  for (let i = 0; i < n; i++) a[i] = data[i * 4 + 3] / 255;
  const ri = Math.max(1, Math.round(r));
  boxPass(a, tmp, w, h, 1, w, ri);
  boxPass(tmp, b, h, w, w, 1, ri);
  for (let it = 1; it < iterations; it++) {
    boxPass(b, tmp, w, h, 1, w, ri);
    boxPass(tmp, b, h, w, w, 1, ri);
  }
  return { a, b };
}
