/**
 * Cover finishing, as plain per-pixel maths (no DOM, no three.js), so it can run on the main
 * thread or in a raster worker: covering finish parameters, finish masks, and the bake of art +
 * masks into colour, clear-coat/roughness/metalness, height and iridescence maps.
 */
import type { CoverFinish, JacketFinish } from '../model/types';
import { hash2 } from '../lib/random';
import { mm } from '../model/units';
import type { FinishKey } from './types';

export type DetailKind = 'weave' | 'leather' | 'tooth' | 'none';

export interface FinishParams {
  roughness: number;
  /** Base clear-coat amount (laminate / wax). */
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  sheenRoughness: number;
  detail: DetailKind;
  /** Physical size of one tile of the detail map, pt. */
  tile: number;
  threads: number;
  /** Buckram filler flattening the weave, 0–1. */
  fill: number;
  detailScale: number;
}

export function finishParams(f: CoverFinish): FinishParams {
  const base: FinishParams = {
    roughness: 0.75, clearcoat: 0, clearcoatRoughness: 0.3, sheen: 0, sheenRoughness: 0.6,
    detail: 'tooth', tile: mm(8), threads: 0, fill: 0, detailScale: 0.3,
  };
  switch (f) {
    case 'cloth': return { ...base, roughness: 0.88, sheen: 0.55, sheenRoughness: 0.5, detail: 'weave', tile: mm(6.4), threads: 16, detailScale: 1.1 };
    case 'buckram': return { ...base, roughness: 0.8, sheen: 0.3, sheenRoughness: 0.45, detail: 'weave', tile: mm(8), threads: 10, fill: 0.3, detailScale: 1.3 };
    case 'leather': return { ...base, roughness: 0.5, sheen: 0.12, sheenRoughness: 0.4, detail: 'leather', tile: mm(16), detailScale: 0.65 };
    case 'paper': return { ...base, roughness: 0.8, detailScale: 0.35 };
    case 'matte': return { ...base, roughness: 0.62, detailScale: 0.15 };
    case 'gloss': return { ...base, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.04, detailScale: 0.08 };
    case 'soft-touch': return { ...base, roughness: 0.94, sheen: 0.35, sheenRoughness: 0.85, detailScale: 0.1 };
    case 'vellum': return { ...base, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.35, sheen: 0.15, detailScale: 0.2 };
    default: return base;
  }
}

/** Jacket stock finishes expressed as covering finishes. */
export const JACKET_FINISH: Record<JacketFinish, CoverFinish> = { matte: 'matte', gloss: 'gloss', uncoated: 'paper', 'soft-touch': 'soft-touch' };

const FOIL: Partial<Record<FinishKey, { color: [number, number, number]; rough: number }>> = {
  'gold-foil': { color: [236, 192, 98], rough: 0.17 },
  'silver-foil': { color: [226, 229, 233], rough: 0.14 },
  'copper-foil': { color: [222, 136, 92], rough: 0.18 },
  'holo-foil': { color: [218, 222, 228], rough: 0.12 },
};

/** Mask coverage 0–1 from RGBA pixels (luminance × alpha); null when the mask is empty. */
export function maskFromRGBA(d: Uint8ClampedArray, n: number): Float32Array | null {
  const out = new Float32Array(n);
  let any = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3];
    if (a === 0) continue;
    const v = ((0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) * a) / 65025;
    out[i] = v;
    any += v;
  }
  return any > 0 ? out : null;
}

/** Separable box blur, applied twice (≈ a tent filter), in place. */
export function blurInPlace(a: Float32Array, w: number, h: number, r: number): void {
  if (r < 1) return;
  const line = new Float32Array(Math.max(w, h));
  const norm = 1 / (2 * r + 1);
  for (let iter = 0; iter < 2; iter++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[o + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        line[x] = acc * norm;
        acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
      a.set(line.subarray(0, w), o);
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        line[y] = acc * norm;
        acc += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
      }
      for (let y = 0; y < h; y++) a[y * w + x] = line[y];
    }
  }
}

/** Blur radius (px) of the finish height map at `ppp` pixels per pt: a band of the image needs
 *  twice this many rows of margin to blur exactly like the whole. */
export const heightBlurRadius = (ppp: number) => Math.max(1, Math.round(0.45 * ppp));

/** Result of `finishPixels`: RGBA maps the size of the art, or a flat value when there are no masks. */
export interface FinishMaps {
  /** R = clear-coat, G = roughness, B = metalness; null = flat `flatSurface`. */
  surface: Uint8ClampedArray | null;
  flatSurface: [number, number, number];
  /** Height (grey) for the bump map; null = flat mid-grey. */
  bump: Uint8ClampedArray | null;
  holo: Uint8ClampedArray | null;
  hasGloss: boolean;
  hasClearcoat: boolean;
}

/**
 * Bake finish masks into `color` (RGBA of the art over its base colour, modified in place) and
 * return the surface / height / iridescence maps. `ppp` = pixels per pt (for the deboss blur);
 * `row0`: the first row's place in the whole image, when this is a band of it.
 */
export function finishPixels(color: Uint8ClampedArray, w: number, h: number, masks: Partial<Record<FinishKey, Float32Array>>, fp: FinishParams, ppp: number, row0 = 0): FinishMaps {
  const baseCC = fp.clearcoat;
  const hasGloss = !!masks['spot-gloss'];
  const flatSurface: [number, number, number] = [Math.round(baseCC * 255), Math.round(fp.roughness * 255), 0];
  if (Object.keys(masks).length === 0) {
    return { surface: null, flatSurface, bump: null, holo: null, hasGloss, hasClearcoat: hasGloss || baseCC > 0 };
  }
  const n = w * h;
  const deb = masks['blind-deboss'] ?? null;
  const gloss = masks['spot-gloss'] ?? null;
  const holoMask = masks['holo-foil'] ?? null;
  const foilKeys = (['gold-foil', 'silver-foil', 'copper-foil', 'holo-foil'] as FinishKey[]).filter((k) => masks[k]);
  const foilMasks = foilKeys.map((k) => masks[k] as Float32Array);
  const foilDefs = foilKeys.map((k) => FOIL[k]!);
  // Faint brushed variation of the foil leaf (64-px tile of horizontal streaks).
  const grain = new Float32Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) grain[y * 64 + x] = 0.94 + 0.06 * hash2(x, y >> 2, 3);

  // Height: deboss presses deep, foil a little, varnish sits proud. Blurred once (blur is linear).
  const height = new Float32Array(n).fill(0.5);
  if (deb) for (let i = 0; i < n; i++) height[i] -= 0.42 * deb[i];
  for (const fm of foilMasks) for (let i = 0; i < n; i++) height[i] -= 0.1 * fm[i];
  if (gloss) for (let i = 0; i < n; i++) height[i] += 0.05 * gloss[i];
  blurInPlace(height, w, h, heightBlurRadius(ppp));

  const sd = new Uint8ClampedArray(n * 4);
  const bd = new Uint8ClampedArray(n * 4);
  const hd = holoMask ? new Uint8ClampedArray(n * 4) : null;
  const cd = color;
  const nf = foilMasks.length;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = cd[j], g = cd[j + 1], b = cd[j + 2];
    let rough = fp.roughness;
    let metal = 0;
    let cc = baseCC;
    if (deb) {
      const md = deb[i];
      if (md > 0) {
        const k = 1 - 0.2 * md;
        r *= k; g *= k; b *= k;
        rough += 0.06 * md;
      }
    }
    for (let f = 0; f < nf; f++) {
      const mf = foilMasks[f][i];
      if (mf <= 0) continue;
      const fc = foilDefs[f].color;
      const gr = grain[(((((i / w) | 0) + row0) & 63) << 6) | (i % w & 63)];
      r += (fc[0] * gr - r) * mf;
      g += (fc[1] * gr - g) * mf;
      b += (fc[2] * gr - b) * mf;
      rough += (foilDefs[f].rough - rough) * mf;
      if (mf > metal) metal = mf;
      cc *= 1 - mf;
    }
    if (gloss) {
      const mg = gloss[i];
      if (mg > 0) {
        rough += (0.08 - rough) * mg;
        if (mg > cc) cc = mg;
      }
    }
    cd[j] = r; cd[j + 1] = g; cd[j + 2] = b;
    sd[j] = cc * 255;
    sd[j + 1] = rough * 255;
    sd[j + 2] = metal * 255;
    sd[j + 3] = 255;
    const hv = height[i] * 255;
    bd[j] = hv; bd[j + 1] = hv; bd[j + 2] = hv; bd[j + 3] = 255;
    if (hd && holoMask) {
      const v = holoMask[i] * 255;
      hd[j] = v; hd[j + 1] = v; hd[j + 2] = v; hd[j + 3] = 255;
    }
  }
  return { surface: sd, flatSurface, bump: bd, holo: hd, hasGloss, hasClearcoat: hasGloss || baseCC > 0 };
}
