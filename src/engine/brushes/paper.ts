/**
 * Surface textures shared by the brushes: the paper tooth that dry media catch
 * on (and watercolour granulates into), and the craquelure / burnish of gilding.
 *
 * Textures are tileable squares of PAPER_TILE_PT pt, generated in device
 * pixels for a bucketed px/pt and cached. Noise is evaluated in pt space, so
 * a 2 px/pt screen render and a 300 dpi print render show the same paper.
 * All drawings share one sheet (fixed seed): overlapping strokes catch on the
 * same peaks, exactly as on real paper.
 */
import { clamp, hash2 } from '../../lib/random';
import { context2d, createCanvas, smoothstep, type Layer } from './util';

export const PAPER_TILE_PT = 64;
const PAPER_SEED = 0x5eed;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Value noise in [0, 1] whose lattice wraps every `px` × `py` cells. */
export function tileNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const u = fade(x - xi), v = fade(y - yi);
  const x0 = mod(xi, px), x1 = mod(xi + 1, px), y0 = mod(yi, py), y1 = mod(yi + 1, py);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

/** Lattice period (cells per tile) for a feature size in pt. */
const periodFor = (cellPt: number) => Math.max(1, Math.round(PAPER_TILE_PT / cellPt));

/** Texture resolution bucket: half-pixel steps, 0.5–8 px/pt. */
const bucket = (pxPerPt: number) => clamp(Math.round(pxPerPt * 2) / 2, 0.5, 8);

/* -------------------------------------------------------------------------- */
/* Paper tooth                                                                 */
/* -------------------------------------------------------------------------- */

export interface PaperTexture {
  /** Texels per tile edge. */
  size: number;
  /** Texels per pt. */
  texPerPt: number;
  /** Surface height, 0 = valley … 1 = peak, histogram-equalised (uniformly distributed). */
  height: Float32Array;
  /** Independent fine fibre / speckle noise 0–1 (~0.35pt features). */
  fine: Float32Array;
  /** Lazily built greyscale image of `height` (for patterns, previews, the UI). */
  canvas(): HTMLCanvasElement;
}

const paperCache = new Map<string, PaperTexture>();

/** Histogram equalisation in place: maps values to their CDF so tooth thresholds read as coverage. */
function equalise(v: Float32Array): void {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < v.length; i++) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  const BINS = 2048, span = hi - lo || 1;
  const hist = new Float64Array(BINS + 1);
  for (let i = 0; i < v.length; i++) hist[Math.min(BINS - 1, Math.floor(((v[i] - lo) / span) * BINS))]++;
  const cdf = new Float64Array(BINS + 1);
  for (let b = 0; b < BINS; b++) cdf[b + 1] = cdf[b] + hist[b] / v.length;
  for (let i = 0; i < v.length; i++) {
    const f = ((v[i] - lo) / span) * BINS;
    const b = Math.min(BINS - 1, Math.floor(f));
    v[i] = cdf[b] + (cdf[b + 1] - cdf[b]) * (f - b);
  }
}

/**
 * Cached tileable paper texture for a device resolution. `grainScale` scales
 * the tooth (1 = fine drawing cartridge, ~1.8 = cold-press watercolour).
 */
export function getPaperTexture(pxPerPt: number, grainScale = 1, seed = PAPER_SEED): PaperTexture {
  const b = bucket(pxPerPt);
  const g = clamp(Math.round(grainScale * 10) / 10, 0.3, 4);
  const key = `${b}|${g}|${seed}`;
  const hit = paperCache.get(key);
  if (hit) return hit;

  const size = Math.round(PAPER_TILE_PT * b), texPerPt = size / PAPER_TILE_PT, n = size * size;
  const height = new Float32Array(n), fine = new Float32Array(n);
  // Octaves: [feature size pt, weight] — broad undulation down to fine tooth.
  const oct: [number, number][] = [[2.6, 0.18], [1.2, 0.3], [0.6, 0.32], [0.3, 0.2]];
  const per = oct.map(([c]) => periodFor(c * g));
  const fibX = periodFor(3.4 * g), fibY = periodFor(0.5 * g), finP = periodFor(0.35);
  const T = PAPER_TILE_PT;

  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / texPerPt;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / texPerPt;
      let h = 0;
      for (let o = 0; o < oct.length; o++) h += oct[o][1] * tileNoise((u * per[o]) / T, (v * per[o]) / T, per[o], per[o], seed + o * 101);
      // Faint laid fibres running along the sheet.
      h += 0.1 * tileNoise((u * fibX) / T, (v * fibY) / T, fibX, fibY, seed + 777);
      const k = j * size + i;
      height[k] = h;
      fine[k] = tileNoise((u * finP) / T, (v * finP) / T, finP, finP, seed + 991);
    }
  }
  equalise(height);

  let cv: HTMLCanvasElement | null = null;
  const tex: PaperTexture = {
    size, texPerPt, height, fine,
    canvas() {
      if (cv) return cv;
      cv = createCanvas(size, size);
      const ctx = context2d(cv);
      const img = ctx.createImageData(size, size);
      for (let k = 0; k < n; k++) {
        const g8 = Math.round(height[k] * 255);
        img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = g8;
        img.data[k * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    },
  };
  paperCache.set(key, tex);
  return tex;
}

/** Paper height 0–1 at a pt coordinate (nearest texel of the 4 px/pt tile). */
export function paperHeight(xPt: number, yPt: number, grainScale = 1): number {
  const t = getPaperTexture(4, grainScale);
  const i = mod(Math.floor(xPt * t.texPerPt), t.size), j = mod(Math.floor(yPt * t.texPerPt), t.size);
  return t.height[j * t.size + i];
}

/** Per-column / per-row texel lookups for a layer: texel index = rows[j] + cols[i]. */
export interface TileIndex { cols: Int32Array; rows: Int32Array }

export function tileIndex(size: number, texPerPt: number, layer: Layer): TileIndex {
  const cols = new Int32Array(layer.w), rows = new Int32Array(layer.h);
  const k = texPerPt / layer.s;
  for (let i = 0; i < layer.w; i++) cols[i] = mod(Math.floor((layer.x0 + i + 0.5) * k), size);
  for (let j = 0; j < layer.h; j++) rows[j] = mod(Math.floor((layer.y0 + j + 0.5) * k), size) * size;
  return { cols, rows };
}

/* -------------------------------------------------------------------------- */
/* Gilding                                                                     */
/* -------------------------------------------------------------------------- */

export interface GildTexture {
  size: number;
  texPerPt: number;
  /** Craquelure lines 0–1 (1 = in a crack). */
  crack: Float32Array;
  /** Low-frequency burnish / leaf-wrinkle variation 0–1. */
  burnish: Float32Array;
}

const gildCache = new Map<number, GildTexture>();

export function getGildTexture(pxPerPt: number): GildTexture {
  const b = bucket(pxPerPt);
  const hit = gildCache.get(b);
  if (hit) return hit;
  const size = Math.round(PAPER_TILE_PT * b), texPerPt = size / PAPER_TILE_PT, n = size * size;
  const crack = new Float32Array(n), burnish = new Float32Array(n);
  const T = PAPER_TILE_PT, seed = 4242;
  const P = periodFor(3.2), cellPt = T / P;
  const visP = periodFor(9), b1 = periodFor(7), b2 = periodFor(2.4), wx = periodFor(5), wy = periodFor(1.2);

  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / texPerPt;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / texPerPt;
      // Worley F2 − F1 → distance to the nearest cell border = a crack.
      const gx = u / cellPt, gy = v / cellPt;
      const ix = Math.floor(gx), iy = Math.floor(gy);
      let f1 = 9, f2 = 9;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy, hx = mod(cx, P), hy = mod(cy, P);
          const d = Math.hypot(gx - (cx + hash2(hx, hy, seed)), gy - (cy + hash2(hx, hy, seed + 7)));
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
      }
      const edgePt = (f2 - f1) * 0.5 * cellPt;
      const vis = smoothstep(0.3, 0.7, tileNoise((u * visP) / T, (v * visP) / T, visP, visP, seed + 3));
      const k = j * size + i;
      crack[k] = (1 - smoothstep(0.05, 0.2, edgePt)) * (0.25 + 0.75 * vis);
      burnish[k] =
        0.5 * tileNoise((u * b1) / T, (v * b1) / T, b1, b1, seed + 11) +
        0.3 * tileNoise((u * b2) / T, (v * b2) / T, b2, b2, seed + 13) +
        0.2 * tileNoise((u * wx) / T, (v * wy) / T, wx, wy, seed + 17);
    }
  }
  const tex: GildTexture = { size, texPerPt, crack, burnish };
  gildCache.set(b, tex);
  return tex;
}
