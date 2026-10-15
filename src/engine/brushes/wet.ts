/**
 * Wet media — watercolour, gouache, airbrush.
 */
import { mix, parseColor } from '../../lib/color';
import { clamp, fbm, rng, valueNoise } from '../../lib/random';
import { getPaperTexture, tileIndex } from './paper';
import { strokeChain } from './pens';
import {
  alphaAndBlur, colorize, compositeLayer, lerp, openLayer, readLayer, resample, smoothstep, softSprite, solid,
  writeLayer, type Job,
} from './util';

/* -------------------------------------------------------------------------- */
/* Watercolour                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Watercolour.
 * 1. The brush footprint (round-capped, pressure-width chain) is drawn as a
 *    hard mask and blurred twice, giving a smooth distance-like field: 1 deep
 *    inside the wash, ~0.5 on the nominal edge, 0 outside.
 * 2. The field is perturbed by world-space noise — low-frequency wash noise on
 *    a global pt lattice plus the paper's own tooth and fibres — so the edge is
 *    ragged, coherent along the stroke and follows the paper.
 * 3. Several thresholds of the field are stacked as translucent passes (the
 *    outermost is the faint bloom fringe, spread by wetness); the main edge
 *    gets the dark drying rim; wash noise adds pooling and cauliflower blooms;
 *    pigment granulates into the paper valleys (grain).
 * Composited with multiply so washes glaze over each other.
 */
export function renderWatercolor(job: Job): void {
  const { stroke } = job;
  const size = Math.max(0.5, stroke.size), R = size / 2;
  const wet = clamp(stroke.wetness, 0, 1), grain = clamp(stroke.grain, 0, 1);
  const load = clamp(0.45 + 0.7 * stroke.flow, 0.2, 1.15);
  const samples = resample(stroke.points, Math.max(0.2, R * 0.15));
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const { ctx, s } = L;
  const seed = stroke.seed;

  // 1. Footprint → smooth field.
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  strokeChain(ctx, samples, (sm) => R * lerp(0.55, 1, sm.p));
  const W = L.w, H = L.h;
  const img = readLayer(L);
  const d = img.data;
  const blurPt = R * 0.42 + 0.4;
  const { b: field } = alphaAndBlur(d, W, H, blurPt * s * 0.8, 2);

  // 2. Noise sources.
  const tex = getPaperTexture(s, 1.8);
  const { cols, rows } = tileIndex(tex.size, tex.texPerPt, L);
  const F = size * 0.9 + 4, G = Math.max(1.5, F / 7);
  const gx0 = Math.floor(L.x0 / s / G) - 1, gy0 = Math.floor(L.y0 / s / G) - 1;
  const gw = Math.ceil(W / s / G) + 3, gh = Math.ceil(H / s / G) + 3;
  const grid = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) grid[j * gw + i] = fbm(((gx0 + i) * G) / F, ((gy0 + j) * G) / F, 3, seed + 99);
  }
  const ci = new Int32Array(W), cf = new Float32Array(W), ri = new Int32Array(H), rf = new Float32Array(H);
  for (let i = 0; i < W; i++) { const g = (L.x0 + i + 0.5) / s / G - gx0; ci[i] = Math.floor(g); cf[i] = g - ci[i]; }
  for (let j = 0; j < H; j++) { const g = (L.y0 + j + 0.5) / s / G - gy0; ri[j] = Math.floor(g); rf[j] = g - ri[j]; }

  // 3. Passes and pigment.
  const T0 = 0.3 - 0.15 * wet, T1 = 0.46 - 0.1 * wet, T2 = T1 + 0.12, T3 = T1 + 0.26;
  const soft = 0.02 + 0.035 * wet, rimW = 0.07 + 0.08 * wet, rimGain = 0.62 - 0.25 * wet;
  const ampLow = 0.6 + 0.8 * wet, ampTooth = 0.06 + 0.1 * wet;
  const bloom = Math.max(0, wet - 0.3) * 1.4, uneven = 0.35 + 0.65 * wet;
  const col = parseColor(stroke.color);
  const height = tex.height, fine = tex.fine;
  const ss = (e0: number, e1: number, x: number) => {
    const t = (x - e0) / (e1 - e0);
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  };

  for (let j = 0; j < H; j++) {
    const rowT = rows[j], g0 = ri[j] * gw, fy = rf[j];
    let p = j * W * 4;
    for (let i = 0; i < W; i++, p += 4) {
      const e0 = field[j * W + i];
      if (e0 < 0.005) { d[p + 3] = 0; continue; }
      const q = g0 + ci[i], fx = cf[i];
      const w0 = grid[q] + (grid[q + 1] - grid[q]) * fx;
      const w1 = grid[q + gw] + (grid[q + gw + 1] - grid[q + gw]) * fx;
      const wl = w0 + (w1 - w0) * fy;
      const tk = rowT + cols[i];
      const h = height[tk], f = fine[tk];
      const e = e0 + (wl - 0.5) * ampLow + (h - 0.5) * ampTooth + (f - 0.5) * 0.05;
      if (e <= T0 - soft) { d[p + 3] = 0; continue; }

      const main = ss(T1 - soft, T1 + soft, e);
      const dens = 0.22 * ss(T0 - soft * 2, T0 + soft * 2, e) + 0.38 * main + 0.22 * ss(T2 - soft * 3, T2 + soft * 3, e) + 0.18 * ss(T3 - soft * 4, T3 + soft * 4, e);
      const rim = main * (1 - ss(T1, T1 + rimW, e));
      let body = dens * (0.75 + (wl - 0.5) * 1.1 * uneven);
      // Cauliflower bloom: pale where wet paint pushed back, dark ragged ring around it.
      const inB = ss(0.57, 0.63, wl);
      const ring = Math.max(0, 1 - Math.abs(wl - 0.6) / 0.022);
      body *= 1 - inB * 0.5 * bloom;
      let pig = body + rim * rimGain + ring * 0.3 * bloom * dens;
      // Granulation: pigment settles in the paper valleys.
      pig *= 1 + grain * ((0.5 - h) * 0.95 + (f - 0.5) * 0.4);
      const alpha = pig * load;
      const shade = 1 - rim * 0.28;
      d[p] = col.r * shade;
      d[p + 1] = col.g * shade;
      d[p + 2] = col.b * shade;
      d[p + 3] = alpha <= 0 ? 0 : alpha >= 1 ? 255 : alpha * 255;
    }
  }
  writeLayer(L, img);
  compositeLayer(job.ctx, L, stroke.opacity, 'multiply');
}

/* -------------------------------------------------------------------------- */
/* Gouache                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gouache: an opaque body (round-capped chain) that narrows as the brush runs dry,
 * overlaid with individual bristle tracks of slightly varied tone. Each
 * bristle carries its own paint load; as paint depletes with distance (flow)
 * and as the brush lifts at the tail, weaker bristles skip, leaving dry-brush
 * streaks.
 */
export function renderGouache(job: Job): void {
  const { stroke } = job;
  const size = Math.max(0.5, stroke.size), R = size / 2;
  const wet = clamp(stroke.wetness, 0, 1), flow = clamp(stroke.flow, 0, 1);
  const samples = resample(stroke.points, Math.max(0.2, R * 0.12));
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const { ctx } = L;
  const r = rng(stroke.seed);
  const base = solid(stroke.color);
  const total = samples[samples.length - 1].d;
  const paintLen = size * (6 + 26 * flow) * (1 + wet);
  const lift = Math.min(total * 0.45, size * (1.6 - wet));
  const dryness = (dd: number) =>
    Math.max(smoothstep(paintLen * 0.45, paintLen, dd), 0.85 * smoothstep(total - lift, total + 1e-3, dd));
  const wOf = (p: number) => lerp(0.6, 1.05, p);

  // 1. Wet body.
  ctx.fillStyle = base;
  ctx.strokeStyle = base;
  strokeChain(ctx, samples, (sm) => R * wOf(sm.p) * 0.92 * (1 - smoothstep(0.1, 0.55, dryness(sm.d))));

  // 2. Bristle tracks.
  const N = clamp(Math.round(size * 1.4), 6, 44);
  const freq = 1 / (0.8 + size * 0.12);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let bi = 0; bi < N; bi++) {
    const off = ((bi + 0.5) / N) * 2 - 1 + (r() - 0.5) * (1.2 / N);
    const bw = ((2 * R) / N) * (1.3 + r() * 0.9);
    const held = (0.5 + r() * 0.5) * (1 - 0.3 * off * off);
    const tone = (r() - 0.5) * 0.16;
    ctx.strokeStyle = tone > 0 ? mix(base, '#ffffff', tone) : mix(base, '#000000', -tone);
    ctx.globalAlpha = 0.75 + r() * 0.25;
    ctx.lineWidth = bw;
    const nseed = stroke.seed + bi * 7919;
    ctx.beginPath();
    let down = false;
    for (const sm of samples) {
      const dry = dryness(sm.d);
      const on = held * (0.6 + 0.8 * valueNoise(sm.d * freq, bi * 3.1, nseed)) > dry * 1.3;
      if (!on) { down = false; continue; }
      const wR = R * wOf(sm.p) * (1 + dry * 0.15);
      const x = sm.x - sm.ty * off * wR, y = sm.y + sm.tx * off * wR;
      if (down) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      down = true;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  compositeLayer(job.ctx, L, stroke.opacity, 'source-over');
}

/* -------------------------------------------------------------------------- */
/* Airbrush                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Airbrush: very soft dabs accumulating towards a flow-controlled density,
 * plus a fine speckle of droplets with a Gaussian radial distribution.
 */
export function renderAirbrush(job: Job): void {
  const { stroke } = job;
  const size = Math.max(0.5, stroke.size), R = size / 2;
  const flow = clamp(stroke.flow, 0.01, 1);
  const step = Math.max(0.25, R * 0.12);
  const samples = resample(stroke.points, step);
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const { ctx } = L;
  const sprite = softSprite(clamp(stroke.hardness, 0, 1) * 0.7);
  const r = rng(stroke.seed);
  const n = Math.max(1, (2 * R) / step);
  const specks = [new Path2D(), new Path2D(), new Path2D()];

  for (const sm of samples) {
    const c = clamp(flow * 1.8 * lerp(0.25, 1, sm.p), 0, 0.98);
    ctx.globalAlpha = samples.length === 1 ? c : 1 - Math.pow(1 - c, 1 / n);
    ctx.drawImage(sprite, sm.x - R, sm.y - R, 2 * R, 2 * R);
    const count = Math.floor(R * 1.2 * flow * sm.p + r());
    for (let k = 0; k < count; k++) {
      const ang = r() * Math.PI * 2;
      const dist = Math.min(1.15, Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * 0.42) * R;
      const ds = 0.16 + r() * 0.3;
      specks[(r() * 3) | 0].rect(sm.x + Math.cos(ang) * dist, sm.y + Math.sin(ang) * dist, ds, ds);
    }
  }
  ctx.fillStyle = '#fff';
  [0.25, 0.5, 0.8].forEach((al, q) => {
    ctx.globalAlpha = al;
    ctx.fill(specks[q]);
  });
  ctx.globalAlpha = 1;
  colorize(L, solid(stroke.color));
  compositeLayer(job.ctx, L, stroke.opacity, 'source-over');
}
