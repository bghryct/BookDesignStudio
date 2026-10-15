/**
 * Ink & pens — fineliner, dip-pen ink, broad-edge calligraphy, chisel marker,
 * highlighter, stipple. Shapes are built from opaque pieces on a layer (or a
 * single path) and composited once, so self-overlaps never double the alpha
 * within a stroke.
 */
import { mix } from '../../lib/color';
import { clamp, rng } from '../../lib/random';
import {
  compositeLayer, lerp, openLayer, resample, sanePressure, smoothstep, solid, type Job, type Sample,
} from './util';

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Variable-width chain: one round-capped segment per sample pair, each drawn
 * as its own opaque stroke. Must target a layer (opaque union), which is then
 * composited once — far faster than one huge self-overlapping fill path.
 */
export function strokeChain(c: CanvasRenderingContext2D, samples: Sample[], radius: (s: Sample) => number): void {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (samples.length === 1) {
    const s = samples[0];
    c.beginPath();
    c.arc(s.x, s.y, Math.max(0.01, radius(s)), 0, Math.PI * 2);
    c.fill();
    return;
  }
  let pr = Math.max(0.01, radius(samples[0]));
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const rr = Math.max(0.01, radius(b));
    c.lineWidth = pr + rr;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    pr = rr;
  }
}

const MAXP = 12;
const PX = new Float64Array(MAXP), PY = new Float64Array(MAXP), ORD = new Int32Array(MAXP), HULL = new Int32Array(MAXP * 2 + 1);
const cross = (o: number, a: number, b: number) =>
  (PX[a] - PX[o]) * (PY[b] - PY[o]) - (PY[a] - PY[o]) * (PX[b] - PX[o]);

/** Fills the convex hull of PX/PY[0..n) (monotone chain). */
function fillHull(c: CanvasRenderingContext2D, n: number): void {
  for (let i = 0; i < n; i++) ORD[i] = i;
  for (let i = 1; i < n; i++) {
    const v = ORD[i];
    let j = i - 1;
    while (j >= 0 && (PX[ORD[j]] > PX[v] || (PX[ORD[j]] === PX[v] && PY[ORD[j]] > PY[v]))) { ORD[j + 1] = ORD[j]; j--; }
    ORD[j + 1] = v;
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k >= 2 && cross(HULL[k - 2], HULL[k - 1], ORD[i]) <= 0) k--;
    HULL[k++] = ORD[i];
  }
  for (let i = n - 2, t = k + 1; i >= 0; i--) {
    while (k >= t && cross(HULL[k - 2], HULL[k - 1], ORD[i]) <= 0) k--;
    HULL[k++] = ORD[i];
  }
  if (k < 4) return;
  c.beginPath();
  c.moveTo(PX[HULL[0]], PY[HULL[0]]);
  for (let i = 1; i < k - 1; i++) c.lineTo(PX[HULL[i]], PY[HULL[i]]);
  c.closePath();
  c.fill();
}

/**
 * Sweeps a rectangular nib (major × minor, at `angleDeg`) along the samples.
 * The union of the hulls of consecutive nib positions is the exact Minkowski
 * sum, giving razor-sharp thick/thin transitions. Each hull spans three nib
 * positions so neighbours overlap generously (no anti-aliasing seams). Draws
 * opaque pieces: target a layer.
 */
function nibSweep(c: CanvasRenderingContext2D, samples: Sample[], angleDeg: number, major: (s: Sample) => number, minor: number): void {
  const th = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(th), uy = Math.sin(th);
  const vx = (-uy * minor) / 2, vy = (ux * minor) / 2;
  const put = (s: Sample, o: number) => {
    const h = major(s) / 2;
    PX[o] = s.x + ux * h + vx; PY[o] = s.y + uy * h + vy;
    PX[o + 1] = s.x + ux * h - vx; PY[o + 1] = s.y + uy * h - vy;
    PX[o + 2] = s.x - ux * h + vx; PY[o + 2] = s.y - uy * h + vy;
    PX[o + 3] = s.x - ux * h - vx; PY[o + 3] = s.y - uy * h - vy;
  };
  const n = samples.length;
  if (n <= 2) {
    for (let i = 0; i < n; i++) put(samples[i], i * 4);
    fillHull(c, n * 4);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    put(samples[i - 1], 0);
    put(samples[i], 4);
    put(samples[i + 1], 8);
    fillHull(c, 12);
  }
}

/* -------------------------------------------------------------------------- */
/* Brushes                                                                     */
/* -------------------------------------------------------------------------- */

/** Fineliner: constant-width line through the input points with quadratic midpoint smoothing. */
export function renderFineliner(job: Job): void {
  const { ctx, stroke } = job;
  const pts = stroke.points;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const n = xs.length;
    if (n && Math.hypot(x - xs[n - 1], y - ys[n - 1]) < 0.02) continue;
    xs.push(x); ys.push(y);
  }
  if (!xs.length) return;
  const w = Math.max(0.05, stroke.size);
  ctx.save();
  ctx.globalAlpha = clamp(stroke.opacity, 0, 1);
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  if (xs.length === 1) {
    ctx.fillStyle = solid(stroke.color);
    ctx.arc(xs[0], ys[0], w / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = solid(stroke.color);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(xs[0], ys[0]);
    for (let i = 1; i < xs.length - 1; i++) {
      ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
    }
    ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1]);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Dip pen / brush ink: width follows pressure strongly (flow = how much the
 * nib responds) with tapered entry and exit; one solid glossy fill.
 */
export function renderInk(job: Job): void {
  const { stroke } = job;
  const R = Math.max(0.05, stroke.size) / 2;
  const samples = resample(stroke.points, Math.max(0.12, R * 0.2));
  if (!samples.length) return;
  const resp = clamp(stroke.flow, 0, 1);
  const total = samples[samples.length - 1].d;
  const tl = Math.min(total * 0.3, R * 5);
  const radius = (s: Sample) => {
    const swell = lerp(1, 0.08 + 1.12 * Math.pow(s.p, 1.4), resp);
    const taper = tl > 0 ? Math.min(0.15 + 0.85 * smoothstep(0, tl, s.d), 0.15 + 0.85 * smoothstep(0, tl, total - s.d)) : 1;
    return Math.max(0.1, R * swell * (samples.length > 1 ? taper : 1));
  };
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const color = solid(stroke.color);
  L.ctx.fillStyle = color;
  L.ctx.strokeStyle = color;
  strokeChain(L.ctx, samples, radius);
  compositeLayer(job.ctx, L, stroke.opacity, 'source-over');
}

/** Broad-edge nib at a fixed angle (default 30°); pressure flexes the nib slightly. */
export function renderCalligraphy(job: Job): void {
  const { stroke } = job;
  const W = Math.max(0.2, stroke.size);
  const samples = resample(stroke.points, Math.max(0.12, W * 0.04));
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  L.ctx.fillStyle = solid(stroke.color);
  nibSweep(L.ctx, samples, stroke.angle, (s) => W * lerp(0.78, 1, s.p), Math.max(0.12, W * 0.06));
  compositeLayer(job.ctx, L, stroke.opacity, 'source-over');
}

/**
 * Chisel marker / highlighter: the nib sweep is rendered at full strength into
 * a layer (uniform within the stroke) and composited once with multiply, so
 * only separate overlapping strokes darken.
 */
function renderChisel(job: Job, minorFrac: number, pooling: boolean): void {
  const { stroke } = job;
  const W = Math.max(0.2, stroke.size);
  const samples = resample(stroke.points, Math.max(0.15, W * 0.06));
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const c = L.ctx;
  const color = solid(stroke.color);
  c.fillStyle = color;
  nibSweep(c, samples, stroke.angle, () => W, Math.max(0.2, W * minorFrac));
  if (pooling) {
    // Ink pools where the nib lands and lifts: slightly darker ends.
    c.globalCompositeOperation = 'source-atop';
    const dark = mix(color, '#000000', 0.3);
    const ends = samples.length > 1 ? [samples[0], samples[samples.length - 1]] : [samples[0]];
    for (const e of ends) {
      const g = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, W * 0.65);
      g.addColorStop(0, dark);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.55;
      c.fillStyle = g;
      c.fillRect(e.x - W, e.y - W, W * 2, W * 2);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
  compositeLayer(job.ctx, L, stroke.opacity, 'multiply');
}

export const renderMarker = (job: Job) => renderChisel(job, 0.38, true);
export const renderHighlighter = (job: Job) => renderChisel(job, 0.22, false);

/** Stipple: seeded ink dots scattered in the brush disc; pressure and flow set the density, grain the dot size. */
export function renderStipple(job: Job): void {
  const { ctx, stroke } = job;
  const R = Math.max(0.2, stroke.size) / 2;
  const dotR = clamp(R * 0.07 * (0.6 + 1.4 * clamp(stroke.grain, 0, 1)), 0.15, 3);
  const step = Math.max(dotR * 2.5, R * 0.25);
  const samples = resample(stroke.points, step);
  if (!samples.length) return;
  const r = rng(stroke.seed);
  const flow = clamp(stroke.flow, 0, 1);
  const path = new Path2D();
  for (const s of samples) {
    const cov = 0.06 + 0.42 * flow * sanePressure(s.p);
    const expected = (cov * step * 2 * R) / (Math.PI * dotR * dotR);
    const count = Math.floor(expected + r());
    for (let k = 0; k < count; k++) {
      const rad = R * Math.sqrt(r()), ang = r() * Math.PI * 2, dr = dotR * (0.7 + r() * 0.6);
      const x = s.x + Math.cos(ang) * rad, y = s.y + Math.sin(ang) * rad;
      path.moveTo(x + dr, y);
      path.arc(x, y, dr, 0, Math.PI * 2);
    }
  }
  ctx.save();
  ctx.globalAlpha = clamp(stroke.opacity, 0, 1);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = solid(stroke.color);
  ctx.fill(path, 'nonzero');
  ctx.restore();
}
