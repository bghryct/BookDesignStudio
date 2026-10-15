/**
 * Materials and procedural maps for the 3D book: covering finishes (cloth weave, buckram,
 * leather grain, paper tooth), cover finishing composited from the finish masks (foils,
 * holographic foil, blind deboss, spot gloss), page-edge textures (plain, gilt, stained,
 * sprayed, deckle), headband silk, and per-leaf page materials (vellum, die-cuts).
 */
import {
  CanvasTexture,
  Color,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  ShaderChunk,
  SRGBColorSpace,
  Texture,
  Vector2,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { CoverFinish, EdgeTreatment, JacketFinish } from '../model/types';
import { jacketSpec, type JacketCalc } from '../engine/binding';
import { hash2, rng } from '../lib/random';
import { mix, parseColor } from '../lib/color';
import { mm } from '../model/units';
import { EDGE_TILE, type BookLayout } from './layout';
import type { BookSceneInput, BookTextures, FinishKey, PageInfo } from './types';

/* ------------------------------------------------------------------------- */
/* Canvas helpers                                                             */
/* ------------------------------------------------------------------------- */

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function context2d(c: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Tileable value noise: lattice periods px × py cells. */
export function tileNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const wx = (i: number) => ((i % px) + px) % px;
  const wy = (j: number) => ((j % py) + py) % py;
  const a = hash2(wx(xi), wy(yi), seed), b = hash2(wx(xi + 1), wy(yi), seed);
  const c = hash2(wx(xi), wy(yi + 1), seed), d = hash2(wx(xi + 1), wy(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function tileFbm(x: number, y: number, px: number, py: number, octaves: number, seed: number): number {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(x * f, y * f, px * f, py * f, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function heightCanvas(h: Float32Array, size: number): HTMLCanvasElement {
  const c = createCanvas(size, size);
  const ctx = context2d(c);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(clamp01(h[i]) * 255);
    img.data[4 * i] = v;
    img.data[4 * i + 1] = v;
    img.data[4 * i + 2] = v;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------------- */
/* Covering finishes                                                          */
/* ------------------------------------------------------------------------- */

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

/** Tileable height map for the covering texture (luminance = height). */
export function makeDetailCanvas(fp: FinishParams, seed = 7): HTMLCanvasElement {
  const size = 256;
  const h = new Float32Array(size * size);
  if (fp.detail === 'weave') {
    const threads = Math.max(2, fp.threads & ~1);
    const cell = size / threads;
    const prof = (t: number) => {
      const q = (t - 0.5) / 0.47;
      return q * q >= 1 ? 0 : Math.sqrt(1 - q * q);
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = (x + 0.5) / cell, gy = (y + 0.5) / cell;
        const i = Math.floor(gx), j = Math.floor(gy);
        const fx = gx - i, fy = gy - j;
        // Plain weave: warp over weft on alternate crossings.
        const warpUp = ((i + j) & 1) === 0;
        const warp = prof(fx) * (warpUp ? 0.62 + 0.38 * Math.sin(Math.PI * fy) : 0.4);
        const weft = prof(fy) * (warpUp ? 0.4 : 0.62 + 0.38 * Math.sin(Math.PI * fx));
        let v = Math.max(warp, weft);
        const fib = warp >= weft
          ? tileNoise(x * 0.5, y / 8, size / 2, size / 8, seed)
          : tileNoise(x / 8, y * 0.5, size / 8, size / 2, seed + 7);
        v += (fib - 0.5) * 0.22;
        v += (tileNoise(x / 32, y / 32, size / 32, size / 32, seed + 3) - 0.5) * 0.12;
        h[y * size + x] = v * (1 - fp.fill) + fp.fill * 0.55;
      }
    }
  } else if (fp.detail === 'leather') {
    const cells = 14;
    const r = rng(seed);
    const pts = new Float32Array(cells * cells * 2);
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        pts[2 * (j * cells + i)] = i + 0.12 + 0.76 * r();
        pts[2 * (j * cells + i) + 1] = j + 0.12 + 0.76 * r();
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = ((x + 0.5) / size) * cells, gy = ((y + 0.5) / size) * cells;
        const ci = Math.floor(gx), cj = Math.floor(gy);
        let f1 = 9, f2 = 9;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = ci + di, nj = cj + dj;
            const wi = ((ni % cells) + cells) % cells, wj = ((nj % cells) + cells) % cells;
            const px = pts[2 * (wj * cells + wi)] + (ni - wi);
            const py = pts[2 * (wj * cells + wi) + 1] + (nj - wj);
            const d = Math.hypot(px - gx, py - gy);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
          }
        }
        // Pebbled grain: raised cells separated by creases, plus pores.
        let v = 0.3 + 0.55 * smooth(0, 0.35, f2 - f1) + 0.15 * (1 - smooth(0, 0.75, f1));
        v += (tileFbm(x / 16, y / 16, size / 16, size / 16, 3, seed + 5) - 0.5) * 0.08;
        if (hash2(x, y, seed) > 0.996) v -= 0.15;
        h[y * size + x] = v;
      }
    }
  } else {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v = tileFbm(x / 8, y / 8, size / 8, size / 8, 4, seed);
        v += (hash2(x, y, seed + 1) - 0.5) * 0.15;
        h[y * size + x] = v;
      }
    }
  }
  return heightCanvas(h, size);
}

/* ------------------------------------------------------------------------- */
/* Cover finishing composite                                                  */
/* ------------------------------------------------------------------------- */

const FOIL: Partial<Record<FinishKey, { color: [number, number, number]; rough: number }>> = {
  'gold-foil': { color: [236, 192, 98], rough: 0.17 },
  'silver-foil': { color: [226, 229, 233], rough: 0.14 },
  'copper-foil': { color: [222, 136, 92], rough: 0.18 },
  'holo-foil': { color: [218, 222, 228], rough: 0.12 },
};

export interface CoverComposite {
  color: CanvasTexture;
  /** R = clear-coat, G = roughness, B = metalness. */
  surface: CanvasTexture;
  /** Height (luminance) for the bump map. */
  bump: CanvasTexture;
  holo: CanvasTexture | null;
  hasGloss: boolean;
  hasClearcoat: boolean;
  dispose(): void;
}

/** Mask coverage 0–1 (luminance × alpha); null when the mask is empty. */
function readMask(src: HTMLCanvasElement, w: number, h: number, scratch: HTMLCanvasElement): Float32Array | null {
  const ctx = context2d(scratch, true);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
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
function blurInPlace(a: Float32Array, w: number, h: number, r: number): void {
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

function dataTexture(canvas: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.colorSpace = NoColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

export function colorTexture(canvas: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

/**
 * Bake the cover art and finish masks into a colour map, a clear-coat/roughness/metalness map,
 * a height map (deboss/foil impression) and an iridescence mask.
 */
export function composeCover(tex: BookTextures | null, layout: BookLayout, finish: CoverFinish, material: string, anisotropy: number): CoverComposite {
  return composeSurface({
    art: tex?.cover ?? null,
    masks: tex?.finishMasks ?? {},
    totalW: layout.cover.totalW,
    totalH: layout.cover.totalH,
    fp: finishParams(finish),
    base: material,
    anisotropy,
  });
}

export interface SurfaceSource {
  art: HTMLCanvasElement | null;
  masks: Partial<Record<FinishKey, HTMLCanvasElement>>;
  /** Physical size the art covers, pt. */
  totalW: number;
  totalH: number;
  fp: FinishParams;
  /** Fill colour under (or instead of) the art. */
  base: string;
  anisotropy: number;
}

/** Same as composeCover for any printed wrapper (the dust jacket uses it too). */
export function composeSurface(src: SurfaceSource): CoverComposite {
  const { fp, anisotropy } = src;
  const map = { totalW: Math.max(1, src.totalW), totalH: Math.max(1, src.totalH) };
  const material = src.base;
  let w: number, h: number;
  const art = src.art;
  if (art && art.width > 1 && art.height > 1) {
    // Cap the working size (the finishing pass is per-pixel): ≤ 4096 px and ≤ 6 MP.
    const k = Math.min(1, 4096 / Math.max(art.width, art.height), Math.sqrt(6e6 / (art.width * art.height)));
    w = Math.max(2, Math.round(art.width * k));
    h = Math.max(2, Math.round(art.height * k));
  } else {
    const ppp = Math.min(2, 2048 / map.totalW);
    w = Math.max(2, Math.round(map.totalW * ppp));
    h = Math.max(2, Math.round(map.totalH * ppp));
  }
  const colorCanvas = createCanvas(w, h);
  const cctx = context2d(colorCanvas, true);
  cctx.fillStyle = material || '#6b5a48';
  cctx.fillRect(0, 0, w, h);
  if (art && art.width > 1) cctx.drawImage(art, 0, 0, w, h);

  const masks: Partial<Record<FinishKey, Float32Array>> = {};
  const entries = Object.entries(src.masks) as [FinishKey, HTMLCanvasElement | undefined][];
  const scratch = createCanvas(w, h);
  for (const [key, cnv] of entries) {
    if (!cnv || cnv.width < 1 || cnv.height < 1) continue;
    const m = readMask(cnv, w, h, scratch);
    if (m) masks[key] = m;
  }
  const baseCC = fp.clearcoat;
  const hasGloss = !!masks['spot-gloss'];
  const holo = masks['holo-foil'] ?? null;

  let surfaceCanvas: HTMLCanvasElement;
  let bumpCanvas: HTMLCanvasElement;
  let holoCanvas: HTMLCanvasElement | null = null;

  if (Object.keys(masks).length === 0) {
    surfaceCanvas = createCanvas(4, 4);
    const sctx = context2d(surfaceCanvas);
    sctx.fillStyle = `rgb(${Math.round(baseCC * 255)},${Math.round(fp.roughness * 255)},0)`;
    sctx.fillRect(0, 0, 4, 4);
    bumpCanvas = createCanvas(4, 4);
    const bctx = context2d(bumpCanvas);
    bctx.fillStyle = 'rgb(128,128,128)';
    bctx.fillRect(0, 0, 4, 4);
  } else {
    const n = w * h;
    const ppp = w / map.totalW;
    const deb = masks['blind-deboss'] ?? null;
    const gloss = masks['spot-gloss'] ?? null;
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
    blurInPlace(height, w, h, Math.max(1, Math.round(0.45 * ppp)));

    const colorImg = cctx.getImageData(0, 0, w, h);
    const cd = colorImg.data;
    surfaceCanvas = createCanvas(w, h);
    const sctx = context2d(surfaceCanvas);
    const surf = sctx.createImageData(w, h);
    const sd = surf.data;
    bumpCanvas = createCanvas(w, h);
    const bctx = context2d(bumpCanvas);
    const bimg = bctx.createImageData(w, h);
    const bd = bimg.data;
    let hd: Uint8ClampedArray | null = null;
    let himg: ImageData | null = null;
    if (holo) {
      holoCanvas = createCanvas(w, h);
      himg = context2d(holoCanvas).createImageData(w, h);
      hd = himg.data;
    }
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
        const gr = grain[((((i / w) | 0) & 63) << 6) | (i % w & 63)];
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
      if (hd && holo) {
        const v = holo[i] * 255;
        hd[j] = v; hd[j + 1] = v; hd[j + 2] = v; hd[j + 3] = 255;
      }
    }
    cctx.putImageData(colorImg, 0, 0);
    sctx.putImageData(surf, 0, 0);
    bctx.putImageData(bimg, 0, 0);
    if (holoCanvas && himg) context2d(holoCanvas).putImageData(himg, 0, 0);
  }

  const color = colorTexture(colorCanvas, anisotropy);
  const surface = dataTexture(surfaceCanvas, anisotropy);
  const bump = dataTexture(bumpCanvas, anisotropy);
  const holoTex = holoCanvas ? dataTexture(holoCanvas, anisotropy) : null;
  return {
    color, surface, bump, holo: holoTex,
    hasGloss,
    hasClearcoat: hasGloss || baseCC > 0,
    dispose() {
      color.dispose();
      surface.dispose();
      bump.dispose();
      holoTex?.dispose();
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Page edges                                                                 */
/* ------------------------------------------------------------------------- */

export interface EdgeLook {
  canvas: HTMLCanvasElement;
  color: string;
  roughness: number;
  metalness: number;
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/**
 * Stacked-leaf texture for the head, tail and fore-edge. u runs along the edge
 * (EDGE_TILE pt per repeat), v across the thickness of the block (0 = last leaf, 1 = first).
 */
export function makeEdgeLook(treatment: EdgeTreatment, paper: string, edgeColor: string, leaves: number, leavesPerSection: number, T: number, seed = 11): EdgeLook {
  const W = 256;
  const Hc = Math.min(2048, Math.max(256, nextPow2(leaves * 3)));
  const c = createCanvas(W, Hc);
  const ctx = context2d(c);
  const r = rng(seed);
  let base = paper, lineAlpha = 0.12, color = '#ffffff', roughness = 0.9, metalness = 0;
  switch (treatment) {
    case 'gilt':
      base = '#ffffff'; lineAlpha = 0.06; color = '#e4b95a'; roughness = 0.24; metalness = 1;
      break;
    case 'stained':
      base = edgeColor; lineAlpha = 0.16; roughness = 0.72;
      break;
    case 'sprayed':
      base = mix(paper, edgeColor, 0.2); lineAlpha = 0.1; roughness = 0.85;
      break;
    case 'deckle':
      base = paper; lineAlpha = 0.14; roughness = 0.95;
      break;
    default:
      break;
  }
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, Hc);
  const band = Hc / Math.max(1, leaves);
  for (let k = 0; k < leaves; k++) {
    const y = k * band;
    // A faint shadow line between leaves, slightly varying leaf to leaf.
    ctx.fillStyle = `rgba(0,0,0,${(lineAlpha * (0.5 + r())).toFixed(3)})`;
    ctx.fillRect(0, y, W, Math.max(0.5, band * 0.3));
    if (band >= 2) {
      ctx.fillStyle = `rgba(255,255,255,${(0.05 * r()).toFixed(3)})`;
      ctx.fillRect(0, y + band * 0.4, W, band * 0.4);
    }
    if (leavesPerSection > 0 && k % leavesPerSection === 0 && k > 0) {
      ctx.fillStyle = `rgba(0,0,0,${(lineAlpha * 0.9).toFixed(3)})`;
      ctx.fillRect(0, y - band * 0.2, W, Math.max(0.8, band * 0.5));
    }
  }
  // Gentle streaking along the edge from the trimming knife.
  for (let x = 0; x < W; x += 2) {
    ctx.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${(0.025 * r()).toFixed(3)})`;
    ctx.fillRect(x, 0, 2, Hc);
  }
  if (treatment === 'sprayed') {
    const pxPerPtU = W / EDGE_TILE;
    const pxPerPtV = Hc / Math.max(1, T);
    const count = Math.round((W * Hc) / 60);
    const ink = parseColor(edgeColor);
    for (let i = 0; i < count; i++) {
      const rad = 0.08 + 0.35 * r() * r();
      ctx.fillStyle = `rgba(${ink.r},${ink.g},${ink.b},${(0.45 + 0.5 * r()).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(r() * W, r() * Hc, Math.max(0.5, rad * pxPerPtU), Math.max(0.5, rad * pxPerPtV), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (treatment === 'deckle') {
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = `rgba(90,70,40,${(0.03 + 0.05 * r()).toFixed(3)})`;
      ctx.fillRect(r() * W, r() * Hc, 2 + 10 * r(), 1 + 30 * r());
    }
  }
  return { canvas: c, color, roughness, metalness };
}

/** Silk headband: diagonal wraps in two colours with a beaded crown. */
export function makeHeadbandCanvas(a: string, b: string): HTMLCanvasElement {
  const size = 64;
  const c = createCanvas(size, size);
  const ctx = context2d(c);
  const img = ctx.createImageData(size, size);
  const A = parseColor(a), B = parseColor(b);
  const period = 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = ((x + y * 0.5) % period) / period;
      const stripe = Math.floor((x + y * 0.5) / (period / 2)) % 2 === 0 ? A : B;
      // Cylindrical shading across each wrap of silk.
      const local = (t * 2) % 1;
      const shade = 0.62 + 0.38 * Math.sin(Math.PI * local);
      const bead = y < 10 ? 0.85 + 0.15 * Math.sin((Math.PI * y) / 10) : 1;
      const i = 4 * (y * size + x);
      img.data[i] = stripe.r * shade * bead;
      img.data[i + 1] = stripe.g * shade * bead;
      img.data[i + 2] = stripe.b * shade * bead;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------------- */
/* Leaves                                                                     */
/* ------------------------------------------------------------------------- */

type Cutout = PageInfo['cutouts'][number];

/**
 * Alpha map for one side of a leaf: vellum translucency (ink stays opaque) and die-cut
 * windows. Holes cut from either side of the leaf appear on both (mirrored on the back).
 * Returns null when the side is plain opaque paper.
 */
export function makeLeafAlpha(own: PageInfo | undefined, other: PageInfo | undefined, art: HTMLCanvasElement | null, W: number, H: number): HTMLCanvasElement | null {
  const vellum = own?.material === 'vellum';
  const holes: Cutout[] = [
    ...(own?.cutouts ?? []),
    ...(other?.cutouts ?? []).map((h) => ({ ...h, x: W - h.x - h.w })),
  ].filter((h) => h.w > 0 && h.h > 0);
  if (!vellum && holes.length === 0) return null;
  const k = 1024 / Math.max(W, H);
  const cw = Math.max(8, Math.round(W * k)), ch = Math.max(8, Math.round(H * k));
  const c = createCanvas(cw, ch);
  const ctx = context2d(c, true);
  if (vellum && own) {
    const op = Math.max(0.06, Math.min(1, own.vellumOpacity));
    if (art && art.width > 0) {
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(art, 0, 0, cw, ch);
      const img = ctx.getImageData(0, 0, cw, ch);
      const d = img.data;
      const p = parseColor(own.paperColor || '#ffffff');
      for (let i = 0; i < cw * ch; i++) {
        const a = d[4 * i + 3] / 255;
        const diff = Math.max(Math.abs(d[4 * i] - p.r), Math.abs(d[4 * i + 1] - p.g), Math.abs(d[4 * i + 2] - p.b)) / 255;
        const ink = smooth(0.05, 0.3, diff * a);
        const v = Math.round(Math.max(op, ink) * 255);
        d[4 * i] = v; d[4 * i + 1] = v; d[4 * i + 2] = v; d[4 * i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    } else {
      const v = Math.round(op * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(0, 0, cw, ch);
    }
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.fillStyle = '#000000';
  for (const hole of holes) {
    ctx.beginPath();
    if (hole.shape === 'ellipse') {
      ctx.ellipse((hole.x + hole.w / 2) * k, (hole.y + hole.h / 2) * k, (hole.w / 2) * k, (hole.h / 2) * k, 0, 0, Math.PI * 2);
    } else {
      ctx.rect(hole.x * k, hole.y * k, hole.w * k, hole.h * k);
    }
    ctx.fill();
  }
  return c;
}

const PAPER_ROUGHNESS: Record<PageInfo['material'], number> = { paper: 0.86, colored: 0.84, kraft: 0.93, vellum: 0.42 };

/* ------------------------------------------------------------------------- */
/* Texture cache                                                              */
/* ------------------------------------------------------------------------- */

/** Keeps GPU textures for page canvases and the cover composite across rebuilds. */
export class TextureCache {
  private pages = new Map<HTMLCanvasElement, CanvasTexture>();
  private composite: CoverComposite | null = null;
  private compositeKey = '';
  private compositeTex: BookTextures | null = null;
  private jacketComposite: CoverComposite | null = null;
  private jacketKey = '';
  private jacketTex: BookTextures | null = null;
  constructor(public anisotropy: number) {}

  /** Call when a new BookTextures arrives: reused canvases are re-uploaded, stale ones dropped. */
  refresh(tex: BookTextures | null): void {
    const keep = new Set<HTMLCanvasElement>();
    for (const p of tex?.pages ?? []) if (p) keep.add(p);
    for (const [cnv, t] of this.pages) {
      if (keep.has(cnv)) t.needsUpdate = true;
      else { t.dispose(); this.pages.delete(cnv); }
    }
  }

  page(canvas: HTMLCanvasElement | null | undefined): CanvasTexture | null {
    if (!canvas || canvas.width < 1 || canvas.height < 1) return null;
    let t = this.pages.get(canvas);
    if (!t) {
      t = colorTexture(canvas, this.anisotropy);
      this.pages.set(canvas, t);
    }
    return t;
  }

  cover(tex: BookTextures | null, layout: BookLayout, finish: CoverFinish, material: string): CoverComposite {
    const key = [finish, material, layout.cover.totalW.toFixed(2), layout.cover.totalH.toFixed(2)].join('|');
    if (this.composite && this.compositeTex === tex && this.compositeKey === key) return this.composite;
    this.composite?.dispose();
    this.composite = composeCover(tex, layout, finish, material, this.anisotropy);
    this.compositeTex = tex;
    this.compositeKey = key;
    return this.composite;
  }

  /** Dust-jacket composite (art + finish masks), cached like the cover. */
  jacket(tex: BookTextures | null, jc: JacketCalc, finish: JacketFinish, paper: string): CoverComposite {
    const totalW = jc.width + 2 * jc.bleed, totalH = jc.height + 2 * jc.bleed;
    const key = [finish, paper, totalW.toFixed(2), totalH.toFixed(2)].join('|');
    if (this.jacketComposite && this.jacketTex === tex && this.jacketKey === key) return this.jacketComposite;
    this.jacketComposite?.dispose();
    this.jacketComposite = composeSurface({
      art: tex?.jacket ?? null,
      masks: tex?.jacketFinishMasks ?? {},
      totalW,
      totalH,
      fp: finishParams(JACKET_FINISH[finish] ?? 'matte'),
      base: paper,
      anisotropy: this.anisotropy,
    });
    this.jacketTex = tex;
    this.jacketKey = key;
    return this.jacketComposite;
  }

  dispose(): void {
    for (const t of this.pages.values()) t.dispose();
    this.pages.clear();
    this.composite?.dispose();
    this.composite = null;
    this.jacketComposite?.dispose();
    this.jacketComposite = null;
  }
}

/** Jacket stock finishes expressed as covering finishes. */
const JACKET_FINISH: Record<JacketFinish, CoverFinish> = { matte: 'matte', gloss: 'gloss', uncoated: 'paper', 'soft-touch': 'soft-touch' };

/* ------------------------------------------------------------------------- */
/* Material set                                                               */
/* ------------------------------------------------------------------------- */

interface DetailUniforms {
  detailMap: { value: Texture };
  detailRepeat: { value: Vector2 };
  detailScale: { value: number };
}

/**
 * Adds a tiled micro-relief (weave / grain / tooth) on top of the cover's bump map, with
 * its own repeat, so the cloth texture stays crisp regardless of the cover-art resolution.
 * Foil (metallic) areas keep only a trace of it: the leaf is pressed smooth.
 */
function installDetailBump(m: MeshPhysicalMaterial, u: DetailUniforms): void {
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.detailMap = u.detailMap;
    shader.uniforms.detailRepeat = u.detailRepeat;
    shader.uniforms.detailScale = u.detailScale;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <bumpmap_pars_fragment>', `#include <bumpmap_pars_fragment>
#ifdef USE_BUMPMAP
uniform sampler2D detailMap;
uniform vec2 detailRepeat;
uniform float detailScale;
vec2 detailDHdxy() {
  vec2 uvD = vBumpMapUv * detailRepeat;
  vec2 dx = dFdx( uvD );
  vec2 dy = dFdy( uvD );
  float h = detailScale * texture2D( detailMap, uvD ).x;
  return vec2( detailScale * texture2D( detailMap, uvD + dx ).x - h, detailScale * texture2D( detailMap, uvD + dy ).x - h );
}
#endif`)
      .replace(
        '#include <normal_fragment_maps>',
        ShaderChunk.normal_fragment_maps.replace('dHdxy_fwd()', 'dHdxy_fwd() + detailDHdxy() * ( 1.0 - 0.8 * metalnessFactor )'),
      );
  };
  m.customProgramCacheKey = () => 'book-cover-detail-v1';
}

export class BookMaterials {
  readonly cover: MeshPhysicalMaterial;
  readonly coverStock: MeshStandardMaterial;
  readonly lining: MeshStandardMaterial;
  readonly endpaper: MeshStandardMaterial;
  readonly paper: MeshStandardMaterial;
  readonly edge: MeshStandardMaterial;
  readonly blockTop: MeshStandardMaterial;
  readonly thread: MeshPhysicalMaterial;
  readonly headband: MeshStandardMaterial;
  readonly leafFront: MeshStandardMaterial[] = [];
  readonly leafBack: MeshStandardMaterial[] = [];
  /** Leaves drawn with alpha blending (vellum). */
  readonly leafTransparent: boolean[] = [];
  readonly headbandTexture: CanvasTexture;
  /** Dust jacket: printed outside and plain inside (null when the book has no jacket). */
  readonly jacketOuter: MeshPhysicalMaterial | null = null;
  readonly jacketInner: MeshStandardMaterial | null = null;
  private readonly owned: Texture[] = [];
  private readonly leafAlpha: Texture[] = [];
  private readonly detail: DetailUniforms;
  private readonly fp: FinishParams;
  private readonly jfp: FinishParams | null = null;

  constructor(private readonly input: BookSceneInput, private readonly layout: BookLayout, private readonly cache: TextureCache) {
    const { spec } = input;
    const fp = finishParams(spec.cover.finish);
    this.fp = fp;
    const aniso = cache.anisotropy;
    const paper = spec.paper.color || '#f5f1e8';
    const caseColor = spec.cover.material || '#6b5a48';

    const detailCanvas = makeDetailCanvas(fp);
    const detailTex = new CanvasTexture(detailCanvas);
    detailTex.colorSpace = NoColorSpace;
    detailTex.wrapS = detailTex.wrapT = RepeatWrapping;
    detailTex.anisotropy = aniso;
    this.owned.push(detailTex);
    const map = layout.cover;
    this.detail = {
      detailMap: { value: detailTex },
      detailRepeat: { value: new Vector2(map.totalW / fp.tile, map.totalH / fp.tile) },
      detailScale: { value: fp.detail === 'none' ? 0 : fp.detailScale },
    };

    this.cover = new MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
      sheen: fp.sheen,
      sheenRoughness: fp.sheenRoughness,
      sheenColor: new Color(mix(caseColor, '#ffffff', 0.55)),
      clearcoat: 0,
      clearcoatRoughness: fp.clearcoatRoughness,
      bumpScale: 2.2,
      iridescenceIOR: 1.65,
      iridescenceThicknessRange: [180, 650],
    });
    installDetailBump(this.cover, this.detail);

    this.coverStock = new MeshStandardMaterial({ color: new Color(mix('#f4f1ea', caseColor, 0.06)), roughness: 0.9 });
    this.lining = new MeshStandardMaterial({ color: new Color(mix(caseColor, '#1a1612', 0.45)), roughness: 0.9 });
    this.endpaper = new MeshStandardMaterial({ color: new Color(mix(paper, '#000000', 0.03)), roughness: 0.88 });
    this.paper = new MeshStandardMaterial({ color: new Color(paper), roughness: 0.9 });

    const sectionLeaves = layout.family === 'soft' && layout.type !== 'smyth' && layout.type !== 'munari'
      ? 0 : Math.max(1, Math.round(spec.binding.sectionPages / 2));
    const look = makeEdgeLook(spec.cover.edge, paper, spec.cover.edgeColor || '#8a2b22', layout.leaves, sectionLeaves, layout.T);
    const edgeTex = colorTexture(look.canvas, aniso);
    edgeTex.wrapS = RepeatWrapping;
    this.owned.push(edgeTex);
    this.edge = new MeshStandardMaterial({ map: edgeTex, color: new Color(look.color), roughness: look.roughness, metalness: look.metalness });

    this.blockTop = new MeshStandardMaterial({ roughness: 0.86 });
    this.thread = new MeshPhysicalMaterial({
      color: new Color(spec.binding.threadColor || '#e8e0cc'),
      roughness: 0.55,
      sheen: 0.6,
      sheenRoughness: 0.4,
      sheenColor: new Color('#ffffff'),
    });
    this.headbandTexture = colorTexture(makeHeadbandCanvas(spec.binding.headbandColors[0], spec.binding.headbandColors[1]), aniso);
    this.headbandTexture.wrapS = this.headbandTexture.wrapT = RepeatWrapping;
    this.owned.push(this.headbandTexture);
    this.headband = new MeshStandardMaterial({ map: this.headbandTexture, roughness: 0.45 });

    for (let k = 0; k < layout.nTurn; k++) {
      this.leafFront.push(new MeshStandardMaterial({ roughness: 0.86 }));
      this.leafBack.push(new MeshStandardMaterial({ roughness: 0.86 }));
      this.leafTransparent.push(false);
    }

    if (input.jacket) {
      const js = jacketSpec(spec);
      const jfp = finishParams(JACKET_FINISH[js.finish] ?? 'matte');
      this.jfp = jfp;
      const jDetail = new CanvasTexture(makeDetailCanvas(jfp, 19));
      jDetail.colorSpace = NoColorSpace;
      jDetail.wrapS = jDetail.wrapT = RepeatWrapping;
      jDetail.anisotropy = aniso;
      this.owned.push(jDetail);
      const jc = input.jacket;
      const outer = new MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 1,
        metalness: 1,
        sheen: jfp.sheen,
        sheenRoughness: jfp.sheenRoughness,
        sheenColor: new Color('#ffffff'),
        clearcoat: 0,
        clearcoatRoughness: jfp.clearcoatRoughness,
        bumpScale: 2.2,
        iridescenceIOR: 1.65,
        iridescenceThicknessRange: [180, 650],
      });
      installDetailBump(outer, {
        detailMap: { value: jDetail },
        detailRepeat: { value: new Vector2((jc.width + 2 * jc.bleed) / jfp.tile, (jc.height + 2 * jc.bleed) / jfp.tile) },
        detailScale: { value: jfp.detail === 'none' ? 0 : jfp.detailScale },
      });
      this.jacketOuter = outer;
      this.jacketInner = new MeshStandardMaterial({ color: new Color(js.paperColor || '#f4f0e8'), roughness: 0.9 });
    }
  }

  private applyComposite(m: MeshPhysicalMaterial, comp: CoverComposite, fp: FinishParams): void {
    m.map = comp.color;
    m.roughnessMap = comp.surface;
    m.metalnessMap = comp.surface;
    m.bumpMap = comp.bump;
    m.clearcoat = comp.hasClearcoat ? 1 : 0;
    m.clearcoatMap = comp.hasClearcoat ? comp.surface : null;
    m.clearcoatRoughness = comp.hasGloss ? 0.05 : fp.clearcoatRoughness;
    m.iridescence = comp.holo ? 1 : 0;
    m.iridescenceMap = comp.holo;
    m.needsUpdate = true;
  }

  /** (Re)assign every texture-driven map. */
  applyTextures(tex: BookTextures | null): void {
    const { spec, pages } = this.input;
    const L = this.layout;
    this.applyComposite(this.cover, this.cache.cover(tex, L, spec.cover.finish, spec.cover.material), this.fp);
    if (this.jacketOuter && this.input.jacket && this.jfp) {
      const js = jacketSpec(spec);
      this.applyComposite(this.jacketOuter, this.cache.jacket(tex, this.input.jacket, js.finish, js.paperColor || '#f4f0e8'), this.jfp);
    }

    for (const t of this.leafAlpha) t.dispose();
    this.leafAlpha.length = 0;
    const art = (i: number) => tex?.pages[i] ?? null;
    const paperFallback = spec.paper.color || '#f5f1e8';
    const configure = (mat: MeshStandardMaterial, pageIndex: number, otherIndex: number): boolean => {
      const info = pages[pageIndex];
      const canvas = art(pageIndex);
      const mapTex = this.cache.page(canvas);
      const alphaCanvas = makeLeafAlpha(info, pages[otherIndex], canvas, L.W, L.H);
      const alphaTex = alphaCanvas ? new CanvasTexture(alphaCanvas) : null;
      if (alphaTex) {
        alphaTex.colorSpace = NoColorSpace;
        alphaTex.anisotropy = this.cache.anisotropy;
        this.leafAlpha.push(alphaTex);
      }
      const vellum = info?.material === 'vellum';
      mat.map = mapTex;
      mat.color.set(mapTex ? '#ffffff' : (info?.paperColor || paperFallback));
      mat.roughness = PAPER_ROUGHNESS[info?.material ?? 'paper'] ?? 0.86;
      mat.alphaMap = alphaTex;
      mat.transparent = vellum;
      mat.alphaTest = alphaTex ? (vellum ? 0.02 : 0.5) : 0;
      mat.depthWrite = true;
      mat.needsUpdate = true;
      return vellum;
    };
    for (let k = 0; k < L.nTurn; k++) {
      const vf = configure(this.leafFront[k], 2 * k, 2 * k + 1);
      const vb = configure(this.leafBack[k], 2 * k + 1, 2 * k);
      this.leafTransparent[k] = vf || vb;
    }
    // The page lying on top of the remaining block.
    const topIndex = 2 * L.nTurn;
    const topInfo = pages[topIndex];
    const topTex = this.cache.page(art(topIndex));
    this.blockTop.map = topTex;
    this.blockTop.color.set(topTex ? '#ffffff' : (topInfo?.paperColor || paperFallback));
    this.blockTop.roughness = PAPER_ROUGHNESS[topInfo?.material ?? 'paper'] ?? 0.86;
    this.blockTop.needsUpdate = true;
  }

  dispose(): void {
    for (const t of this.owned) t.dispose();
    for (const t of this.leafAlpha) t.dispose();
    const mats = [this.cover, this.coverStock, this.lining, this.endpaper, this.paper, this.edge, this.blockTop, this.thread, this.headband, ...this.leafFront, ...this.leafBack];
    if (this.jacketOuter) mats.push(this.jacketOuter);
    if (this.jacketInner) mats.push(this.jacketInner);
    for (const m of mats) m.dispose();
  }
}
