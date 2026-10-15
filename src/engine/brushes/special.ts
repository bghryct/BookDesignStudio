/**
 * Special brushes — gold leaf (gilding) and the eraser.
 */
import { luminance, parseColor } from '../../lib/color';
import { clamp } from '../../lib/random';
import { getGildTexture, tileIndex } from './paper';
import { strokeChain } from './pens';
import {
  alphaAndBlur, compositeLayer, lerp, openLayer, readLayer, resample, softSprite, writeLayer, type Job,
} from './util';

/* -------------------------------------------------------------------------- */
/* Gold leaf                                                                   */
/* -------------------------------------------------------------------------- */

/** 256-entry metallic gold ramp, deep shadow → burnished highlight. */
let goldLut: Uint8ClampedArray | null = null;
function goldRamp(): Uint8ClampedArray {
  if (goldLut) return goldLut;
  const stops: [number, number, number, number][] = [
    [0, 0x4a, 0x30, 0x0c], [0.28, 0x8f, 0x63, 0x1c], [0.52, 0xc4, 0x98, 0x36],
    [0.74, 0xe8, 0xcb, 0x6e], [0.9, 0xf8, 0xea, 0xb0], [1, 0xff, 0xf8, 0xdc],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
    const f = clamp((t - t0) / (t1 - t0), 0, 1);
    lut[i * 3] = lerp(r0, r1, f);
    lut[i * 3 + 1] = lerp(g0, g1, f);
    lut[i * 3 + 2] = lerp(b0, b1, f);
  }
  goldLut = lut;
  return lut;
}

/**
 * Gilding: the stroke shape is rasterised as a mask, then shaded per pixel —
 * a slow diagonal sheen band plus burnish noise, an emboss from the blurred
 * mask (light from the top-left, like raised gesso under the leaf), fine
 * craquelure showing the red bole beneath (grain), and a thin darker outline.
 * A non-neutral stroke colour gently tints the metal.
 */
export function renderGoldLeaf(job: Job): void {
  const { stroke } = job;
  const size = Math.max(0.3, stroke.size), R = size / 2;
  const samples = resample(stroke.points, Math.max(0.15, R * 0.2));
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const { ctx, s } = L;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  strokeChain(ctx, samples, (sm) => R * lerp(0.7, 1.05, sm.p));

  const W = L.w, H = L.h;
  const img = readLayer(L);
  const d = img.data;
  const blurPx = Math.max(1, (0.3 + size * 0.045) * s);
  const { a, b } = alphaAndBlur(d, W, H, blurPx);
  const tex = getGildTexture(s);
  const { cols, rows } = tileIndex(tex.size, tex.texPerPt, L);
  const lut = goldRamp();
  const crackAmt = clamp(stroke.grain, 0, 1);
  const embK = blurPx * 1.6;
  const band = size * 3 + 14;
  const tint = parseColor(stroke.color);
  const lum = luminance(stroke.color);
  const tintAmt = lum < 0.06 || lum > 0.9 ? 0 : 0.2;

  for (let j = 0; j < H; j++) {
    const v = (L.y0 + j + 0.5) / s;
    const rowT = rows[j];
    let p = j * W * 4;
    for (let i = 0; i < W; i++, p += 4) {
      const k = j * W + i;
      const av = a[k];
      if (av < 0.004) { d[p + 3] = 0; continue; }
      const u = (L.x0 + i + 0.5) / s;
      const tk = rowT + cols[i];
      const burn = tex.burnish[tk];
      // Emboss from the blurred mask gradient: lit top-left edges, shaded bottom-right.
      const gx = (i + 1 < W ? b[k + 1] : 0) - (i > 0 ? b[k - 1] : 0);
      const gy = (j + 1 < H ? b[k + W] : 0) - (j > 0 ? b[k - W] : 0);
      const emb = clamp((gx + gy) * embK, -0.6, 0.6);
      const sheen = 0.5 + 0.5 * Math.sin(((u + v) * 0.7071 / band) * Math.PI * 2 + burn * 2.4);
      let t = 0.18 + 0.5 * sheen + 0.3 * (burn - 0.5) + emb * 0.55;
      const outline = clamp((av - b[k] - 0.18) * 3.2, 0, 1);
      t *= 1 - outline * 0.55;
      const ti = clamp(Math.round(t * 255), 0, 255) * 3;
      let r = lut[ti], g = lut[ti + 1], bl = lut[ti + 2];
      // Craquelure: thin cracks reveal the red-brown bole.
      const cr = tex.crack[tk] * crackAmt;
      if (cr > 0.01) {
        r = lerp(r, 0x6e, cr * 0.75); g = lerp(g, 0x34, cr * 0.75); bl = lerp(bl, 0x1c, cr * 0.75);
      }
      if (tintAmt) {
        r = lerp(r, (r * tint.r) / 200, tintAmt); g = lerp(g, (g * tint.g) / 200, tintAmt); bl = lerp(bl, (bl * tint.b) / 200, tintAmt);
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = bl;
      d[p + 3] = av * 255;
    }
  }
  writeLayer(L, img);
  compositeLayer(job.ctx, L, stroke.opacity, 'source-over');
}

/* -------------------------------------------------------------------------- */
/* Eraser                                                                      */
/* -------------------------------------------------------------------------- */

/** Eraser: destination-out; hard erasers cut a crisp round-nib path, soft ones accumulate feathered dabs. */
export function renderEraser(job: Job): void {
  const { stroke } = job;
  const R = Math.max(0.1, stroke.size) / 2;
  const hard = clamp(stroke.hardness, 0, 1);
  const widthOf = (p: number) => R * lerp(0.6, 1, p);

  if (hard >= 0.95) {
    const samples = resample(stroke.points, Math.max(0.12, R * 0.2));
    if (!samples.length) return;
    const L = openLayer(job.region, job.pxPerPt);
    if (!L) return;
    L.ctx.fillStyle = '#000';
    L.ctx.strokeStyle = '#000';
    strokeChain(L.ctx, samples, (sm) => widthOf(sm.p));
    compositeLayer(job.ctx, L, stroke.opacity, 'destination-out');
    return;
  }

  const step = Math.max(0.12, R * 0.15);
  const samples = resample(stroke.points, step);
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const sprite = softSprite(hard);
  for (const sm of samples) {
    const rr = widthOf(sm.p);
    const c = clamp(lerp(0.35, 1, sm.p), 0, 0.995);
    L.ctx.globalAlpha = samples.length === 1 ? c : 1 - Math.pow(1 - c, step / (2 * rr));
    L.ctx.drawImage(sprite, sm.x - rr, sm.y - rr, rr * 2, rr * 2);
  }
  L.ctx.globalAlpha = 1;
  compositeLayer(job.ctx, L, stroke.opacity, 'destination-out');
}
