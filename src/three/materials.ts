/**
 * Materials and procedural maps for the 3D book: covering finishes (cloth weave, buckram,
 * leather grain, paper tooth), cover finishing composited from the finish masks (foils,
 * holographic foil, blind deboss, spot gloss), page-edge textures (plain, gilt, stained,
 * sprayed, deckle), headband silk, and per-leaf page materials (vellum, die-cuts).
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
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
import { finishParams, finishPixels, JACKET_FINISH, maskFromRGBA, type FinishParams } from './finishing';
import { mix, parseColor } from '../lib/color';
import { mm } from '../model/units';
import { EDGE_TILE, type BookLayout } from './layout';
import type { BookSceneInput, BookTextures, FinishKey, PageInfo, PanelArt, PanelMaps } from './types';
import type { WrapRegion } from './regions';
export type { PanelArt } from './types';

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

export { finishParams } from './finishing';
export type { DetailKind, FinishParams } from './finishing';

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

export interface CoverComposite {
  color: Texture;
  /** R = clear-coat, G = roughness, B = metalness. */
  surface: Texture;
  /** Height (luminance) for the bump map. */
  bump: Texture;
  holo: Texture | null;
  hasGloss: boolean;
  hasClearcoat: boolean;
  dispose(): void;
}

/** Art that can feed a texture: a canvas, or an ImageBitmap from a raster worker (unflipped). */
export type ArtSource = HTMLCanvasElement | ImageBitmap;

const isBitmap = (s: ArtSource): s is ImageBitmap => typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap;

/**
 * A texture for art. Canvases upload with flipY; ImageBitmaps ignore flipY, so they are flipped
 * through the UV transform instead (same result, no extra copy).
 */
function artTexture(src: ArtSource, anisotropy: number, srgb: boolean, own = false): Texture {
  const t = isBitmap(src) ? new Texture(src) : new CanvasTexture(src);
  if (isBitmap(src)) {
    t.flipY = false;
    t.repeat.set(1, -1);
    t.offset.set(0, 1);
    t.needsUpdate = true;
    // An owned bitmap's memory goes with the texture.
    if (own) t.addEventListener('dispose', () => src.close());
  }
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

function dataTexture(src: ArtSource, anisotropy: number, own = false): Texture {
  return artTexture(src, anisotropy, false, own);
}

/** sRGB texture for art. `own`: close an ImageBitmap source when the texture is disposed. */
export function colorTexture(src: ArtSource, anisotropy: number, own = false): Texture {
  return artTexture(src, anisotropy, true, own);
}

/** Map a texture onto the UV rectangle [u0, u1] × [v0, v1] of a surface (v up). */
export function placeTexture(t: Texture, u0: number, u1: number, v0: number, v1: number): void {
  const flip = t.flipY === false && t.repeat.y < 0;
  t.repeat.set(1 / (u1 - u0), (flip ? -1 : 1) / (v1 - v0));
  t.offset.set(-u0 / (u1 - u0), flip ? 1 + v0 / (v1 - v0) : -v0 / (v1 - v0));
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
}

function flatCanvas(rgb: [number, number, number]): HTMLCanvasElement {
  const c = createCanvas(4, 4);
  const g = context2d(c);
  g.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  g.fillRect(0, 0, 4, 4);
  return c;
}

/** Textures from finished maps (main-thread composite or a raster worker's output). `own`: close
 *  the maps' bitmaps when the composite is disposed. */
export function compositeFromMaps(m: PanelMaps, anisotropy: number, own = true): CoverComposite {
  const color = colorTexture(m.color, anisotropy, own);
  const surface = dataTexture(m.surface ?? flatCanvas(m.flatSurface), anisotropy, own);
  const bump = dataTexture(m.bump ?? flatCanvas([128, 128, 128]), anisotropy, own);
  const holo = m.holo ? dataTexture(m.holo, anisotropy, own) : null;
  return {
    color, surface, bump, holo, hasGloss: m.hasGloss, hasClearcoat: m.hasClearcoat,
    dispose() {
      color.dispose();
      surface.dispose();
      bump.dispose();
      holo?.dispose();
    },
  };
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
  art: ArtSource | null;
  masks: Partial<Record<FinishKey, ArtSource>>;
  /** Physical size the art covers, pt. */
  totalW: number;
  totalH: number;
  fp: FinishParams;
  /** Fill colour under (or instead of) the art. */
  base: string;
  anisotropy: number;
  /** Working-size caps: longest edge (px) and total pixels (default 4096 px / 16 MP). */
  maxPx?: number;
  maxPixels?: number;
}

/** Same as composeCover for any printed wrapper (the dust jacket uses it too). Main thread. */
export function composeSurface(src: SurfaceSource): CoverComposite {
  const { fp, anisotropy } = src;
  const map = { totalW: Math.max(1, src.totalW), totalH: Math.max(1, src.totalH) };
  let w: number, h: number;
  const art = src.art;
  if (art && art.width > 1 && art.height > 1) {
    // Cap the working size (the finishing pass is per-pixel).
    const k = Math.min(1, (src.maxPx ?? 4096) / Math.max(art.width, art.height), Math.sqrt((src.maxPixels ?? 16e6) / (art.width * art.height)));
    w = Math.max(2, Math.round(art.width * k));
    h = Math.max(2, Math.round(art.height * k));
  } else {
    const ppp = Math.min(2, 2048 / map.totalW);
    w = Math.max(2, Math.round(map.totalW * ppp));
    h = Math.max(2, Math.round(map.totalH * ppp));
  }
  const colorCanvas = createCanvas(w, h);
  const cctx = context2d(colorCanvas, true);
  cctx.fillStyle = src.base || '#6b5a48';
  cctx.fillRect(0, 0, w, h);
  if (art && art.width > 1) cctx.drawImage(art, 0, 0, w, h);
  const masks: Partial<Record<FinishKey, Float32Array>> = {};
  const scratch = createCanvas(w, h);
  const sctx = context2d(scratch, true);
  for (const [key, cnv] of Object.entries(src.masks) as [FinishKey, ArtSource | undefined][]) {
    if (!cnv || cnv.width < 1 || cnv.height < 1) continue;
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(cnv, 0, 0, w, h);
    const m = maskFromRGBA(sctx.getImageData(0, 0, w, h).data, w * h);
    if (m) masks[key] = m;
  }
  const colorImg = cctx.getImageData(0, 0, w, h);
  const maps = finishPixels(colorImg.data, w, h, masks, fp, w / map.totalW);
  const toCanvas = (d: Uint8ClampedArray) => {
    const c = createCanvas(w, h);
    const img = new ImageData(d as unknown as Uint8ClampedArray<ArrayBuffer>, w, h);
    context2d(c).putImageData(img, 0, 0);
    return c;
  };
  if (maps.surface) cctx.putImageData(colorImg, 0, 0);
  return compositeFromMaps({
    color: colorCanvas,
    surface: maps.surface ? toCanvas(maps.surface) : null,
    flatSurface: maps.flatSurface,
    bump: maps.bump ? toCanvas(maps.bump) : null,
    holo: maps.holo ? toCanvas(maps.holo) : null,
    hasGloss: maps.hasGloss,
    hasClearcoat: maps.hasClearcoat,
  }, anisotropy);
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
export function makeLeafAlpha(own: PageInfo | undefined, other: PageInfo | undefined, art: ArtSource | null, W: number, H: number): HTMLCanvasElement | null {
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
  private pages = new Map<ArtSource, Texture>();
  private composite: CoverComposite | null = null;
  private compositeKey = '';
  private compositeTex: BookTextures | null = null;
  private jacketComposite: CoverComposite | null = null;
  private jacketKey = '';
  private jacketTex: BookTextures | null = null;
  constructor(public anisotropy: number, public maxTextureSize = 8192) {}

  /** Call when a new BookTextures arrives: reused canvases are re-uploaded, stale ones dropped. */
  refresh(tex: BookTextures | null): void {
    const keep = new Set<ArtSource>();
    for (const p of tex?.pages ?? []) if (p) keep.add(p);
    for (const [cnv, t] of this.pages) {
      // Canvases may have been redrawn in place; bitmaps never change.
      if (keep.has(cnv)) { if (!isBitmap(cnv)) t.needsUpdate = true; }
      else { t.dispose(); this.pages.delete(cnv); }
    }
  }

  page(canvas: ArtSource | null | undefined): Texture | null {
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
    // Finished by a raster worker for this finish and colour (the textures own the bitmaps).
    this.composite = tex?.coverMaps && tex.coverMapsKey === `${finish}|${material}`
      ? compositeFromMaps(tex.coverMaps, this.anisotropy, false)
      : composeCover(tex, layout, finish, material, this.anisotropy);
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
    this.jacketComposite = tex?.jacketMaps && tex.jacketMapsKey === `${finish}|${paper}` ? compositeFromMaps(tex.jacketMaps, this.anisotropy, false) : composeSurface({
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


/* ------------------------------------------------------------------------- */
/* Material set                                                               */
/* ------------------------------------------------------------------------- */

interface DetailUniforms {
  detailMap: { value: Texture };
  detailRepeat: { value: Vector2 };
  detailScale: { value: number };
  /** 1 when the bump map is an ImageBitmap flipped through its UV transform (see artTexture):
   *  the relief then reads the bump UV flipped back, so it lies exactly as with a canvas. */
  detailFlip: { value: number };
  /** Added to the relief's coordinates (tiles): a panel texture covering part of the wrap keeps
   *  the weave where the whole-wrap texture has it, so sharpening does not shift it. */
  detailOffset: { value: Vector2 };
}

/** The detail uniforms of each material that has the relief, for applyComposite. */
const detailOf = new WeakMap<MeshPhysicalMaterial, DetailUniforms>();

/**
 * Adds a tiled micro-relief (weave / grain / tooth) on top of the cover's bump map, with
 * its own repeat, so the cloth texture stays crisp regardless of the cover-art resolution.
 * Foil (metallic) areas keep only a trace of it: the leaf is pressed smooth.
 */
function installDetailBump(m: MeshPhysicalMaterial, u: DetailUniforms): void {
  detailOf.set(m, u);
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.detailMap = u.detailMap;
    shader.uniforms.detailRepeat = u.detailRepeat;
    shader.uniforms.detailScale = u.detailScale;
    shader.uniforms.detailFlip = u.detailFlip;
    shader.uniforms.detailOffset = u.detailOffset;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <bumpmap_pars_fragment>', `#include <bumpmap_pars_fragment>
#ifdef USE_BUMPMAP
uniform sampler2D detailMap;
uniform vec2 detailRepeat;
uniform float detailScale;
uniform float detailFlip;
uniform vec2 detailOffset;
vec2 detailDHdxy() {
  vec2 uvD = vec2( vBumpMapUv.x, mix( vBumpMapUv.y, 1.0 - vBumpMapUv.y, detailFlip ) ) * detailRepeat + detailOffset;
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
  m.customProgramCacheKey = () => 'book-cover-detail-v3';
}

function coverMaterial(fp: FinishParams, sheenBase: string): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    sheen: fp.sheen,
    sheenRoughness: fp.sheenRoughness,
    sheenColor: new Color(mix(sheenBase, '#ffffff', 0.55)),
    clearcoat: 0,
    clearcoatRoughness: fp.clearcoatRoughness,
    bumpScale: 2.2,
    iridescenceIOR: 1.65,
    iridescenceThicknessRange: [180, 650],
  });
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
  readonly headbandTexture: Texture;
  /** Dust jacket: printed outside and plain inside (null when the book has no jacket). */
  readonly jacketOuter: MeshPhysicalMaterial | null = null;
  readonly jacketInner: MeshStandardMaterial | null = null;
  /**
   * The front panel of the cover / jacket: same look as the rest, but it can carry its own, much
   * sharper art (camera-driven) mapped onto the panel's rectangle of the wrap. The back, spine and
   * flaps get such materials too (regionMaterial), made when the geometry asks for them.
   */
  readonly coverFront: MeshPhysicalMaterial;
  readonly jacketFront: MeshPhysicalMaterial | null = null;
  /** Every region's material, detail uniforms and sharp art, by `cover:front`, `jacket:spine` … */
  private readonly regions = new Map<string, { mat: MeshPhysicalMaterial; detail: DetailUniforms; comp: CoverComposite | null; art: PanelArt | null }>();
  private readonly newRegion: { cover: () => { mat: MeshPhysicalMaterial; detail: DetailUniforms }; jacket: (() => { mat: MeshPhysicalMaterial; detail: DetailUniforms }) | null };
  /** Whether the base art has been applied (region materials made later take it then). */
  private textured = false;
  /** Sharper art for individual pages (index → texture), over the base page art. */
  private readonly pageArt = new Map<number, Texture>();
  private textures: BookTextures | null = null;
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
      detailFlip: { value: 0 }, detailOffset: { value: new Vector2() },
    };

    this.cover = coverMaterial(fp, caseColor);
    installDetailBump(this.cover, this.detail);
    const coverRegion = () => {
      const mat = coverMaterial(fp, caseColor);
      const detail: DetailUniforms = { detailMap: this.detail.detailMap, detailRepeat: { value: this.detail.detailRepeat.value.clone() }, detailScale: this.detail.detailScale, detailFlip: { value: 0 }, detailOffset: { value: new Vector2() } };
      installDetailBump(mat, detail);
      return { mat, detail };
    };
    const front = coverRegion();
    this.coverFront = front.mat;
    this.regions.set('cover:front', { ...front, comp: null, art: null });
    let jacketRegion: (() => { mat: MeshPhysicalMaterial; detail: DetailUniforms }) | null = null;

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
        detailFlip: { value: 0 }, detailOffset: { value: new Vector2() },
      });
      this.jacketOuter = outer;
      jacketRegion = () => {
        const mat = coverMaterial(jfp, '#ffffff');
        const detail: DetailUniforms = {
          detailMap: { value: jDetail },
          detailRepeat: { value: new Vector2((jc.width + 2 * jc.bleed) / jfp.tile, (jc.height + 2 * jc.bleed) / jfp.tile) },
          detailScale: { value: jfp.detail === 'none' ? 0 : jfp.detailScale },
          detailFlip: { value: 0 }, detailOffset: { value: new Vector2() },
        };
        installDetailBump(mat, detail);
        return { mat, detail };
      };
      const jf = jacketRegion();
      this.jacketFront = jf.mat;
      this.regions.set('jacket:front', { ...jf, comp: null, art: null });
      this.jacketInner = new MeshStandardMaterial({ color: new Color(js.paperColor || '#f4f0e8'), roughness: 0.9 });
    }
    this.newRegion = { cover: coverRegion, jacket: jacketRegion };
  }

  /** The material of a region of the cover / jacket wrap, made on first use (null: no jacket). */
  regionMaterial(which: 'cover' | 'jacket', region: WrapRegion): MeshPhysicalMaterial | null {
    const key = `${which}:${region}`;
    let r = this.regions.get(key);
    if (!r) {
      const make = this.newRegion[which];
      if (!make) return null;
      r = { ...make(), comp: null, art: null };
      this.regions.set(key, r);
      if (this.textured) {
        const base = this.baseComposite(which);
        if (base) this.applyRegion(which, region, base);
      }
    }
    return r.mat;
  }

  /** The base composite of the whole wrap (null: no jacket). */
  private baseComposite(which: 'cover' | 'jacket'): CoverComposite | null {
    const spec = this.input.spec;
    if (which === 'cover') return this.cache.cover(this.textures, this.layout, spec.cover.finish, spec.cover.material);
    if (!this.input.jacket) return null;
    const js = jacketSpec(spec);
    return this.cache.jacket(this.textures, this.input.jacket, js.finish, js.paperColor || '#f4f0e8');
  }

  private applyComposite(m: MeshPhysicalMaterial, comp: CoverComposite, fp: FinishParams): void {
    m.map = comp.color;
    m.roughnessMap = comp.surface;
    m.metalnessMap = comp.surface;
    m.bumpMap = comp.bump;
    const du = detailOf.get(m);
    if (du) du.detailFlip.value = comp.bump.flipY === false && comp.bump.repeat.y < 0 ? 1 : 0;
    m.clearcoat = comp.hasClearcoat ? 1 : 0;
    m.clearcoatMap = comp.hasClearcoat ? comp.surface : null;
    m.clearcoatRoughness = comp.hasGloss ? 0.05 : fp.clearcoatRoughness;
    m.iridescence = comp.holo ? 1 : 0;
    m.iridescenceMap = comp.holo;
    m.needsUpdate = true;
  }

  /** A region's material shows its sharper art when there is some, else the base composite. */
  private applyRegion(which: 'cover' | 'jacket', region: WrapRegion, base: CoverComposite): void {
    const r = this.regions.get(`${which}:${region}`);
    const fp = which === 'cover' ? this.fp : this.jfp;
    if (!r || !fp) return;
    const full = this.wrapSize(which);
    if (r.comp && r.art) {
      this.applyComposite(r.mat, r.comp, fp);
      r.detail.detailRepeat.value.set(r.art.box.w / fp.tile, r.art.box.h / fp.tile);
      // The art's corner (u0, v0) of the wrap, in tiles: the weave lines up with the base's.
      r.detail.detailOffset.value.set((r.art.box.x + full.o) / fp.tile, (full.h - r.art.box.y - r.art.box.h - full.o) / fp.tile);
    } else {
      this.applyComposite(r.mat, base, fp);
      r.detail.detailRepeat.value.set(full.w / fp.tile, full.h / fp.tile);
      r.detail.detailOffset.value.set(0, 0);
    }
  }

  /** Every region of one wrap, after its base composite changed. */
  private applyRegions(which: 'cover' | 'jacket', base: CoverComposite): void {
    for (const key of this.regions.keys()) {
      const [w, region] = key.split(':') as ['cover' | 'jacket', WrapRegion];
      if (w === which) this.applyRegion(which, region, base);
    }
  }

  /** Whole wrap of the cover / jacket canvas: size and origin offset (turn-in or bleed), pt. */
  private wrapSize(which: 'cover' | 'jacket'): { w: number; h: number; o: number } {
    if (which === 'cover') {
      const c = this.layout.cover;
      return { w: c.totalW, h: c.totalH, o: c.wrap };
    }
    const jc = this.input.jacket;
    return jc ? { w: jc.width + 2 * jc.bleed, h: jc.height + 2 * jc.bleed, o: jc.bleed } : { w: 1, h: 1, o: 0 };
  }

  /**
   * Sharper art for the front panel of the cover or jacket: `art.canvas` (and finish masks) covers
   * `art.box` of the wrap (pt, in the cover / jacket canvas frame, origin at the trim). null drops
   * back to the base art.
   */
  setPanelArt(which: 'cover' | 'jacket', region: WrapRegion, art: PanelArt | null): void {
    const r = this.regions.get(`${which}:${region}`);
    const fp = which === 'cover' ? this.fp : this.jfp;
    if (!r || !fp) {
      // Not modelled: free a worker's bitmaps now.
      if (art?.maps) for (const b of [art.maps.color, art.maps.surface, art.maps.bump, art.maps.holo]) if (b && isBitmap(b)) b.close();
      return;
    }
    r.comp?.dispose();
    r.comp = null;
    r.art = art;
    if (art) {
      const spec = this.input.spec;
      const baseColor = which === 'cover' ? spec.cover.material : (jacketSpec(spec).paperColor || '#f4f0e8');
      // Finished maps from a raster worker, or composite the art and masks here.
      const comp = art.maps
        ? compositeFromMaps(art.maps, this.cache.anisotropy)
        : composeSurface({
          art: art.canvas ?? null, masks: art.masks ?? {}, totalW: art.box.w, totalH: art.box.h, fp, base: baseColor,
          anisotropy: this.cache.anisotropy, maxPx: this.cache.maxTextureSize, maxPixels: 80e6,
        });
      // Map the region's texture onto its rectangle of the wrap's UV space.
      const full = this.wrapSize(which);
      const u0 = (art.box.x + full.o) / full.w, u1 = (art.box.x + art.box.w + full.o) / full.w;
      const v0 = 1 - (art.box.y + art.box.h + full.o) / full.h, v1 = 1 - (art.box.y + full.o) / full.h;
      for (const t of [comp.color, comp.surface, comp.bump, comp.holo]) if (t) placeTexture(t, u0, u1, v0, v1);
      r.comp = comp;
    }
    const base = this.baseComposite(which);
    if (base) this.applyRegion(which, region, base);
  }

  /** Sharper art for page `index` (null: back to the base art). Returns true when the page is modelled. */
  setPageArt(index: number, canvas: ArtSource | null): boolean {
    const L = this.layout;
    const mat = index < 2 * L.nTurn ? (index % 2 === 0 ? this.leafFront : this.leafBack)[Math.floor(index / 2)] : index === 2 * L.nTurn ? this.blockTop : null;
    if (!mat) return false;
    this.pageArt.get(index)?.dispose();
    this.pageArt.delete(index);
    if (canvas) {
      const t = colorTexture(canvas, this.cache.anisotropy, true);
      this.pageArt.set(index, t);
      mat.map = t;
    } else {
      mat.map = this.cache.page(this.textures?.pages[index] ?? null);
    }
    mat.needsUpdate = true;
    return true;
  }

  /** (Re)assign every texture-driven map. */
  applyTextures(tex: BookTextures | null): void {
    const { spec, pages } = this.input;
    const L = this.layout;
    this.textures = tex;
    this.textured = true;
    const coverComp = this.cache.cover(tex, L, spec.cover.finish, spec.cover.material);
    this.applyComposite(this.cover, coverComp, this.fp);
    this.applyRegions('cover', coverComp);
    if (this.jacketOuter && this.input.jacket && this.jfp) {
      const js = jacketSpec(spec);
      const jComp = this.cache.jacket(tex, this.input.jacket, js.finish, js.paperColor || '#f4f0e8');
      this.applyComposite(this.jacketOuter, jComp, this.jfp);
      this.applyRegions('jacket', jComp);
    }

    for (const t of this.leafAlpha) t.dispose();
    this.leafAlpha.length = 0;
    const art = (i: number) => tex?.pages[i] ?? null;
    const paperFallback = spec.paper.color || '#f5f1e8';
    const configure = (mat: MeshStandardMaterial, pageIndex: number, otherIndex: number): boolean => {
      const info = pages[pageIndex];
      const canvas = art(pageIndex);
      const mapTex = this.pageArt.get(pageIndex) ?? this.cache.page(canvas);
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
      // Die-cut windows: alpha-to-coverage (with MSAA) smooths the cut edge an alpha test would
      // leave stair-stepped and crawling. Vellum blends, so it doesn't need it.
      mat.alphaToCoverage = !!alphaTex && !vellum;
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
    const topTex = this.pageArt.get(topIndex) ?? this.cache.page(art(topIndex));
    this.blockTop.map = topTex;
    this.blockTop.color.set(topTex ? '#ffffff' : (topInfo?.paperColor || paperFallback));
    this.blockTop.roughness = PAPER_ROUGHNESS[topInfo?.material ?? 'paper'] ?? 0.86;
    this.blockTop.needsUpdate = true;
  }

  dispose(): void {
    for (const t of this.owned) t.dispose();
    for (const t of this.leafAlpha) t.dispose();
    for (const t of this.pageArt.values()) t.dispose();
    this.pageArt.clear();
    for (const r of this.regions.values()) r.comp?.dispose();
    const mats = [this.cover, this.coverStock, this.lining, this.endpaper, this.paper, this.edge, this.blockTop, this.thread, this.headband, ...this.leafFront, ...this.leafBack];
    for (const r of this.regions.values()) mats.push(r.mat);
    if (this.jacketOuter) mats.push(this.jacketOuter);
    if (this.jacketInner) mats.push(this.jacketInner);
    for (const m of mats) m.dispose();
  }
}
