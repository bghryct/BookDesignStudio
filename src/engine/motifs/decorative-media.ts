/**
 * Decorated papers whose medium is genuinely continuous-tone — marbling, paste
 * paper and washi. Each renders as one deterministic RasterPrim sampled in pt
 * space, so the editor, the SVG export and the 300-dpi PDF show the same sheet.
 */
import { clamp, fbm, hash2, rng, valueNoise } from '../../lib/random';
import { mix } from '../../lib/color';
import { TAU, smoothstep } from '../generators/util';
import type { MotifDef } from './types';
import type { RGB, RasterGrid } from './decorative-shared';
import {
  Lattice, lerpRGB, okBox, rasterKey, rasterMotif, readMotifParams, rgbOf, sampleField, seedOf, slot, superSamples,
} from './decorative-shared';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Pick an index from cumulative weights with a uniform value t ∈ [0, 1). */
function pickWeighted(cum: number[], t: number): number {
  for (let i = 0; i < cum.length; i++) if (t < cum[i]) return i;
  return cum.length - 1;
}

const cumulative = (w: number[]): number[] => {
  const s = w.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return w.map((v) => (acc += v / s));
};

/* ========================================================================== */
/* 1. Marbled endpaper                                                         */
/* ========================================================================== */

/**
 * Marbling is modelled the way the marbler works: colours are floated (stones,
 * as a power diagram of drops pushing each other), then raked and combed. The
 * comb strokes are the "tine-line" deformation of Lu & Jaffer's mathematical
 * marbling, d ↦ αλ / (d + λ), inverted per sample; the drag adds the slow
 * swirl of a real bath.
 */
interface Stones {
  /** Fill `info` with: colour index, edge distance (pt), inner-drop signed distance, inner colour, cell hash. */
  find: (x: number, y: number, info: Float64Array) => void;
}

function makeStones(x0: number, y0: number, w: number, h: number, S: number, seed: number, weights: number[], innerShare: number, round: number): Stones {
  const cum = cumulative(weights);
  const pad = 3;
  const i0 = Math.floor(x0 / S) - pad, j0 = Math.floor(y0 / S) - pad;
  const ni = Math.ceil(w / S) + pad * 2 + 1, nj = Math.ceil(h / S) + pad * 2 + 1;
  const n = ni * nj;
  const px = new Float64Array(n), py = new Float64Array(n), wt = new Float64Array(n);
  const ci = new Int8Array(n), inner = new Float64Array(n), ic = new Int8Array(n), ix = new Float64Array(n), iy = new Float64Array(n), hh = new Float64Array(n);
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      const gi = i0 + i, gj = j0 + j, k = j * ni + i;
      const a = hash2(gi, gj, seed), b = hash2(gi, gj, seed + 1), c = hash2(gi, gj, seed + 2), d = hash2(gi, gj, seed + 3);
      px[k] = (gi + 0.5 + (a - 0.5) * 0.85) * S;
      py[k] = (gj + 0.5 + (b - 0.5) * 0.85) * S;
      const r = S * (0.3 + 0.62 * c);
      wt[k] = r * r;
      ci[k] = pickWeighted(cum, d);
      hh[k] = hash2(gi, gj, seed + 4);
      const e = hash2(gi, gj, seed + 5);
      if (e < innerShare) {
        // A later, smaller drop thrown into this stone ("drop within drop").
        inner[k] = r * (0.3 + 0.32 * hash2(gi, gj, seed + 6));
        ix[k] = px[k] + (hash2(gi, gj, seed + 7) - 0.5) * r * 0.5;
        iy[k] = py[k] + (hash2(gi, gj, seed + 8) - 0.5) * r * 0.5;
        let other = pickWeighted(cum, hash2(gi, gj, seed + 9));
        if (other === ci[k]) other = (other + 1 + Math.floor(e * 7)) % weights.length;
        ic[k] = other;
      }
    }
  }
  return {
    find: (x, y, info) => {
      const ci0 = Math.floor(x / S) - i0, cj0 = Math.floor(y / S) - j0;
      let b1 = Infinity, b2 = Infinity, b3 = Infinity, k1 = -1, k2 = -1, k3 = -1;
      for (let dj = -2; dj <= 2; dj++) {
        const jj = cj0 + dj;
        if (jj < 0 || jj >= nj) continue;
        for (let di = -2; di <= 2; di++) {
          const ii = ci0 + di;
          if (ii < 0 || ii >= ni) continue;
          const k = jj * ni + ii;
          const dx = x - px[k], dy = y - py[k];
          const pd = dx * dx + dy * dy - wt[k];
          if (pd < b1) { b3 = b2; k3 = k2; b2 = b1; k2 = k1; b1 = pd; k1 = k; }
          else if (pd < b2) { b3 = b2; k3 = k2; b2 = pd; k2 = k; }
          else if (pd < b3) { b3 = pd; k3 = k; }
        }
      }
      if (k1 < 0) { info[0] = 0; info[1] = S; info[2] = S; info[3] = 0; info[4] = 0; return; }
      // Distance to the power-diagram edges shared with the 2nd and 3rd neighbours.
      const edgeTo = (b: number, k: number) => {
        if (k < 0) return S;
        const cx = px[k] - px[k1], cy = py[k] - py[k1];
        return (b - b1) / (2 * (Math.sqrt(cx * cx + cy * cy) || 1e-6));
      };
      const e2 = edgeTo(b2, k2), e3 = edgeTo(b3, k3);
      // Rounded corners: drops are round, so the junctions open into small pockets.
      let edge = Math.min(e2, e3);
      if (e2 < round && e3 < round) {
        const u = round - e2, v = round - e3;
        edge = round - Math.sqrt(u * u + v * v);
      }
      info[0] = ci[k1];
      info[1] = edge;
      if (inner[k1] > 0) {
        const dx = x - ix[k1], dy = y - iy[k1];
        info[2] = Math.sqrt(dx * dx + dy * dy) - inner[k1];
        info[3] = ic[k1];
      } else {
        info[2] = S;
        info[3] = 0;
      }
      info[4] = hh[k1];
    },
  };
}

/** Repeating stripe sequence of the raked colours (for the combed patterns). */
function makeStripes(Ws: number, seed: number, nPig: number) {
  const cache = new Map<number, number>();
  const colourOf = (k: number): number => {
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    // Rake order repeats loosely: cycle the pigments, with seeded swaps.
    let c = ((k % nPig) + nPig) % nPig;
    const t = hash2(k, 7, seed);
    if (t < 0.28) c = (c + 1 + Math.floor(hash2(k, 9, seed) * (nPig - 1))) % nPig;
    if (cache.size > 4096) cache.clear();
    cache.set(k, c);
    return c;
  };
  return (s: number, out: Float64Array) => {
    // Monotonic warp → irregular stripe widths.
    const sw = s + 0.3 * Ws * Math.sin((TAU * s) / (2.7 * Ws) + 1.3) + 0.18 * Ws * Math.sin((TAU * s) / (5.3 * Ws) + 0.4);
    const q = sw / Ws;
    const k = Math.floor(q);
    out[0] = colourOf(k);
    out[1] = q - k;
    out[2] = hash2(k, 3, seed);
  };
}

function paintMarble(o: Ctx2D, g: RasterGrid, w: number, h: number, p: Record<string, number>, colors: string[], seed: number): void {
  const style = Math.round(p.style);
  const scale = p.scale;
  const drag = p.drag;
  const ground = rgbOf(colors[0]);
  const pig = colors.slice(1).map(rgbOf);
  const dark: RGB = [14, 16, 22];
  const vein = lerpRGB(pig[0], dark, 0.5);
  const S = 24 * scale;
  const Pc = (72 / Math.max(0.5, p.comb)) * scale;
  const fw = 0.45 * Math.max(g.sx, g.sy);
  const spanish = style === 2;

  // Slow swirl of the bath, a finer wobble and two mottling channels, sampled on a
  // lattice no finer than the output needs.
  const lstep = clamp(Math.max(Math.min(S, Pc) / 7, 0.6 / g.ppp, Math.sqrt((w * h) / 1.5e6)), 0.5, 12);
  const warpAmp = drag * S * 1.5;
  const wobAmp = (0.08 + drag * 0.3) * S;
  const wf = 1 / (3 * S), wf2 = 1 / (1.1 * S);
  const lat = new Lattice(-lstep, -lstep, w + 2 * lstep, h + 2 * lstep, lstep, 4, (x, y, out) => {
    out[0] = (fbm(x * wf, y * wf, 3, seed + 11) - 0.5) * 2 * warpAmp + (valueNoise(x * wf2, y * wf2, seed + 13) - 0.5) * 2 * wobAmp;
    out[1] = (fbm(x * wf + 31.7, y * wf - 12.3, 3, seed + 23) - 0.5) * 2 * warpAmp + (valueNoise(x * wf2 + 9.1, y * wf2 + 4.7, seed + 29) - 0.5) * 2 * wobAmp;
    out[2] = fbm(x / (S * 0.8), y / (S * 0.8), 3, seed + 37);
    out[3] = fbm(x / (S * 0.22), y / (S * 0.22), 2, seed + 41);
  });
  const L = [0, 0, 0, 0];
  const info = new Float64Array(5);
  const margin = warpAmp + wobAmp + S * 3;

  const Ss = spanish ? S * 0.8 : S;
  const stone = spanish
    ? makeStones(-margin, -margin, w + 2 * margin, h + 2 * margin, Ss, seed, [0.4, 0.34, 0.16, 0.1], 0.1, Ss * 0.16)
    : makeStones(-margin, -margin, w + 2 * margin, h + 2 * margin, Ss, seed, [0.3, 0.27, 0.25, 0.18], 0.22, Ss * 0.2);

  // Spanish wave: shaded bands from the sheet being rocked as it is laid down.
  const bandP = Pc * 2.4;
  const ba = (-32 * Math.PI) / 180;
  const bc = Math.cos(ba), bs = Math.sin(ba);

  // Combed patterns.
  const Ws = Pc * 0.42;
  const stripes = makeStripes(Ws, seed, pig.length);
  const sOut = new Float64Array(3);
  // For the peacock the nonpareil pass is shallow; the wide wavy comb then draws
  // the fine teeth into nested, alternating teardrops (the "eyes").
  const peacock = style === 3;
  const ac = Pc * (peacock ? 0.9 : 2.6), lc = Pc * 0.18, cMid = (ac * lc) / (Pc / 2 + lc);
  const Pg = Pc * 5.5, ag = Pg * (peacock ? 0.12 : 0.3), lg = Pg * 0.22;
  const Pb = Pc * 4, ab = Pb * 0.26, Lb = Pb * 1.5, abA = Pb * 1.3, lb = Pb * 0.42;
  const tineDy = (x: number): number => {
    // Nonpareil comb: every tine pulls the same way.
    const q = x / Pc;
    const d = Math.abs(q - Math.round(q)) * Pc;
    let dy = (ac * lc) / (d + lc) - cMid;
    // Get-gel rake: tines alternately up and down.
    const k = Math.floor(x / Pg);
    const d0 = x - k * Pg, d1 = (k + 1) * Pg - x;
    const s0 = k & 1 ? -1 : 1;
    dy += ag * s0 * ((lg / (d0 + lg)) - (lg / (d1 + lg)));
    return dy;
  };
  const bouquetDy = (x: number, y: number): number => {
    // Wavy tines (the bouquet comb drawn through in an S-motion).
    const k = Math.round(x / Pb - 0.5);
    let best = Infinity;
    for (let m = k - 1; m <= k + 1; m++) {
      const path = (m + 0.5) * Pb + ab * Math.sin((TAU * y) / Lb + (m & 1) * Math.PI);
      best = Math.min(best, Math.abs(x - path));
    }
    return (abA * lb) / (best + lb);
  };

  const shade = (c: RGB, t: number): RGB => (t >= 0 ? lerpRGB(c, [255, 255, 255], t) : lerpRGB(c, dark, -t));

  const combed = (x: number, y: number, out: Float64Array) => {
    lat.read(x, y, L);
    const wx = x + L[0] * 0.55, wy0 = y + L[1] * 0.55;
    let wy = wy0;
    if (style === 3) {
      // Invert the bouquet stroke by fixed-point iteration.
      let yy = wy0;
      for (let it = 0; it < 4; it++) yy = wy0 - bouquetDy(wx, yy);
      wy = yy;
    }
    const s = wy - tineDy(wx);
    stripes(s, sOut);
    let c = pig[sOut[0]] ?? ground;
    const f = sOut[1];
    // Fine vein between raked bands: dark or paper, alternately.
    const vf = 0.13;
    const veinCol = sOut[2] < 0.55 ? vein : ground;
    const a = 1 - smoothstep(vf * 0.6, vf, f) + smoothstep(1 - vf * 0.25, 1, f);
    c = lerpRGB(c, veinCol, clamp(a, 0, 1));
    c = shade(c, (L[3] - 0.5) * 0.16);
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = 255;
  };

  const stoned = (x: number, y: number, out: Float64Array) => {
    lat.read(x, y, L);
    const wx = x + L[0], wy = y + L[1];
    stone.find(wx, wy, info);
    let c = pig[info[0]] ?? ground;
    // Each stone's value varies a little with how thickly it was thrown.
    c = shade(c, (info[4] - 0.5) * 0.12);
    const e = info[1];
    const vw = Ss * (spanish ? 0.024 : 0.03) * (0.45 + 1.2 * L[2]);
    // Pigment gathers at the rim of a stone.
    const rim = smoothstep(vw, vw + Ss * 0.1, e);
    c = lerpRGB(shade(c, -0.22), c, 0.3 + 0.7 * rim);
    // Inner drop with its own hairline vein.
    if (info[2] < Ss * 0.2) {
      const di = info[2];
      const ic = pig[info[3]] ?? ground;
      const inside = 1 - smoothstep(-fw, fw, di);
      c = lerpRGB(c, shade(ic, (L[3] - 0.5) * 0.1), inside);
      const ring = 1 - smoothstep(vw * 0.35 - fw, vw * 0.35 + fw, Math.abs(di));
      c = lerpRGB(c, vein, ring * 0.85);
    }
    // Mottle: pigment flocculating on the size.
    c = shade(c, (L[3] - 0.5) * 0.18);
    // Veins (and the pockets where three stones meet): a dark line with a
    // paper-pale hairline inside it (Turkish), or a single line (Spanish).
    const v1 = 1 - smoothstep(vw - fw, vw + fw, e);
    if (spanish) {
      c = lerpRGB(c, vein, v1);
    } else {
      const v2 = 1 - smoothstep(vw * 1.75 - fw, vw * 1.75 + fw, e);
      c = lerpRGB(c, ground, clamp(v2 - v1, 0, 1) * 0.9);
      c = lerpRGB(c, vein, v1);
      const pocket = 1 - smoothstep(-vw * 2 - fw, -vw * 2 + fw, e);
      c = lerpRGB(c, lerpRGB(vein, ground, 0.22), pocket * 0.7);
    }
    if (spanish) {
      // Sawtooth bands: light, then deepening, then a crisp return to light.
      const along = -x * bs + y * bc;
      const t = (x * bc + y * bs) / bandP + 0.22 * Math.sin((TAU * along) / (bandP * 3.4)) + L[0] / (bandP * 2.5);
      const fr = t - Math.floor(t);
      const sh = smoothstep(0, 0.8, fr) * (1 - smoothstep(0.86, 1, fr));
      c = shade(c, 0.16 - 0.62 * sh);
    }
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = 255;
  };

  sampleField(o, g, superSamples(g, 6e6), style === 0 || style === 3 ? combed : stoned);
}

export const MARBLED: MotifDef = {
  kind: 'marbled',
  label: 'Marbled endpaper',
  designer: 'diehl',
  description:
    'Hand-marbled endpaper — colours floated on a gum size, thrown into stones or raked and combed into nonpareil and peacock patterns before the sheet is laid down, as in the nineteenth-century trade bindings Edith Diehl catalogued. Rendered as one deterministic raster.',
  defaultSize: { w: 288, h: 396 },
  colors: [
    { label: 'Ground (paper)', default: '#efe7d3' },
    { label: 'Pigment 1 · Prussian blue', default: '#1f3a62' },
    { label: 'Pigment 2 · oxblood', default: '#7b2924' },
    { label: 'Pigment 3 · ochre', default: '#c99a3e' },
    { label: 'Pigment 4 · cream', default: '#e9ddc0' },
  ],
  params: [
    { key: 'style', label: 'Pattern', min: 0, max: 3, step: 1, default: 1, options: ['Nonpareil', 'Turkish stone', 'Spanish wave', 'Peacock / bouquet'] },
    { key: 'scale', label: 'Scale', min: 0.3, max: 3, step: 0.01, default: 1 },
    { key: 'comb', label: 'Comb density (tines / inch)', min: 2, max: 16, step: 0.5, default: 6 },
    { key: 'drag', label: 'Drag / distortion', min: 0, max: 1, step: 0.01, default: 0.35 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(MARBLED, el);
    const colors = [0, 1, 2, 3, 4].map((i) => slot(MARBLED, el, i));
    const { w, h } = el;
    const seed = seedOf(el);
    return [rasterMotif(rasterKey('marbled', el, p, colors), w, h, (o, g) => paintMarble(o, g, w, h, p, colors, seed))];
  },
};

/* ========================================================================== */
/* 2. Paste paper                                                              */
/* ========================================================================== */

/**
 * Coloured starch paste brushed over a sheet and drawn through with a comb while
 * wet: the teeth clear lines back to the ground, piling paste into ridges at
 * their edges, and the brush leaves dry streaks along its direction.
 */
function paintPaste(o: Ctx2D, g: RasterGrid, w: number, h: number, p: Record<string, number>, colors: string[], seed: number): void {
  const pattern = Math.round(p.pattern);
  const ground = rgbOf(colors[0]);
  const paste = rgbOf(colors[1]);
  const deep = lerpRGB(paste, [10, 10, 14], 0.42);
  const Hc = p.scale;
  const n = Math.max(1, Math.round(p.teeth));
  const tp = Hc / n;
  const hw0 = tp * 0.21;
  const fw = 0.45 * Math.max(g.sx, g.sy);
  const lam = 100 / Math.max(0.05, p.frequency);
  const A = p.amplitude * Hc * 0.9;

  // Large brushing unevenness on a lattice.
  const lstep = clamp(Hc / 6, 1, 8);
  const lat = new Lattice(-lstep, -lstep, w + 2 * lstep, h + 2 * lstep, lstep, 1, (x, y, out) => {
    out[0] = fbm(x / 70, y / 70, 3, seed + 5);
  });
  const L = [0];

  /** Thickness of paste under one comb pass at stroke coordinates (u along, v across). */
  const comb = (u: number, v: number, salt: number): [number, number] => {
    const q = v / tp;
    const k = Math.floor(q);
    const dist = Math.abs(q - k - 0.5) * tp;
    const rag = 1 + 0.55 * (valueNoise(u / 2.6, k * 7.31 + salt, seed + 17) - 0.5) + 0.3 * (valueNoise(u / 0.75, k * 3.17 + salt, seed + 19) - 0.5);
    const hw = hw0 * rag;
    const cleared = 1 - smoothstep(hw - fw, hw + fw, dist);
    const rd = tp * 0.16;
    const ridge = smoothstep(hw - fw, hw + rd * 0.5, dist) * (1 - smoothstep(hw + rd * 0.5, hw + rd * 2.2, dist));
    return [cleared, ridge];
  };

  /** Brushed paste: streaks along the stroke direction plus slow unevenness. */
  const brushed = (u: number, v: number, x: number, y: number): number => {
    lat.read(x, y, L);
    const streak = fbm(u / 24, v / 1.1, 2, seed + 29);
    return 0.6 + 0.34 * streak + 0.5 * (L[0] - 0.5);
  };

  const residue = (u: number, v: number): number => 0.04 + 0.12 * valueNoise(u / 1.4, v / 0.35, seed + 31);

  const thicknessFrom = (base: number, cr: [number, number], u: number, v: number): number =>
    base * (1 - cr[0]) + cr[0] * residue(u, v) + cr[1] * 0.42;

  const rowJit = (r: number) => ({
    phase: (hash2(r, 1, seed) - 0.5) * 0.5,
    amp: 0.9 + 0.2 * hash2(r, 2, seed),
    off: (hash2(r, 3, seed) - 0.5) * tp * 0.7,
  });

  const fanR = Hc;
  const fanDx = fanR * 1.86, fanDy = fanR * 0.66;
  const swD = Hc * 2.05;

  const sample = (x: number, y: number, out: Float64Array) => {
    let T: number;
    if (pattern === 1) {
      // Arcs / fans: the comb pivoted about one end, rows overlapping like scales.
      T = -1;
      const jHi = Math.floor((y + fanR) / fanDy) + 1, jLo = Math.floor(y / fanDy) - 1;
      for (let j = jHi; j >= jLo && T < 0; j--) {
        const cy = (j + 1) * fanDy;
        if (y > cy + fw) continue;
        const shift = (j & 1) * 0.5;
        const i = Math.round(x / fanDx - 0.5 - shift);
        for (let ii = i - 1; ii <= i + 1; ii++) {
          const cx = (ii + 0.5 + shift) * fanDx + (hash2(ii, j, seed + 3) - 0.5) * tp;
          const R = fanR * (0.94 + 0.12 * hash2(ii, j, seed + 4));
          const dx = x - cx, dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r > R || dy > 0) continue;
          const ang = Math.atan2(dy, dx);
          const u = ang * Math.max(r, tp);
          const cr = comb(u, r, ii * 13 + j * 7);
          T = thicknessFrom(brushed(u, r, x, y), cr, u, r);
          // Paste shoved to the rim of the fan.
          T += 0.4 * smoothstep(R - tp * 0.7, R - tp * 0.15, r);
          // The pivot smudges.
          T += 0.35 * (1 - smoothstep(0, tp * 1.2, r));
          break;
        }
      }
      if (T < 0) T = brushed(x, y, x, y);
    } else if (pattern === 3) {
      // Combed swirls: a comb turned through a full circle, spiralling inward.
      T = -1;
      let bestOrder = -1;
      const ci = Math.floor(x / swD), cj = Math.floor(y / swD);
      for (let jj = cj - 1; jj <= cj + 1; jj++) {
        for (let ii = ci - 1; ii <= ci + 1; ii++) {
          const cx = (ii + 0.5 + (hash2(ii, jj, seed + 6) - 0.5) * 0.45) * swD;
          const cy = (jj + 0.5 + (hash2(ii, jj, seed + 7) - 0.5) * 0.45) * swD;
          const R = Hc * (0.98 + 0.2 * hash2(ii, jj, seed + 8));
          const dx = x - cx, dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (r > R) continue;
          const order = hash2(ii, jj, seed + 9);
          if (order <= bestOrder) continue;
          bestOrder = order;
          const dir = (ii + jj) & 1 ? 1 : -1;
          const ang = Math.atan2(dy, dx);
          // A hand-turned comb never draws a true circle.
          const ph = order * TAU;
          const re = r * (1 + 0.05 * Math.sin(2 * ang + ph) + 0.03 * Math.sin(3 * ang + ph * 2.3));
          const v = re + ((dir * ang) / TAU + 0.5) * tp * 0.999;
          const u = ang * Math.max(r, tp);
          const cr = comb(u, v, ii * 31 + jj * 17);
          T = thicknessFrom(brushed(u, r, x, y), cr, u, v);
          T += 0.38 * smoothstep(R - tp * 0.6, R - tp * 0.1, r);
          T += 0.3 * (1 - smoothstep(0, tp * 1.5, r));
        }
      }
      if (T < 0) T = brushed(x, y, x, y);
    } else if (pattern === 2) {
      // Crosshatch: a straight pass, then a second across it that drags paste back in.
      const A2 = A * 0.35;
      const s1 = A2 * Math.sin((TAU * x) / lam);
      const v1 = (((y - s1) % Hc) + Hc) % Hc;
      const c1 = comb(x, v1, Math.floor((y - s1) / Hc) * 5);
      const s2 = A2 * Math.sin((TAU * y) / lam + 1.7);
      const v2 = (((x - s2) % Hc) + Hc) % Hc;
      const c2 = comb(y, v2, Math.floor((x - s2) / Hc) * 9 + 101);
      const base = brushed(x, y, x, y);
      const after1 = base * (1 - c1[0]) + c1[0] * (residue(x, v1) + 0.5 * base) + c1[1] * 0.25;
      T = after1 * (1 - c2[0]) + c2[0] * residue(y, v2) + c2[1] * 0.42;
    } else {
      // Waves: parallel passes of the comb in a sine, each pass a little different.
      const r0 = Math.floor((y - A * Math.sin((TAU * x) / lam)) / Hc);
      T = -1;
      for (let r = r0 + 1; r >= r0 - 1; r--) {
        const j = rowJit(r);
        const arg = (TAU * x) / lam + j.phase;
        const centre = r * Hc + Hc / 2 + j.off + A * j.amp * Math.sin(arg);
        const v = y - centre + Hc / 2;
        if (v < 0 || v > Hc) continue;
        // The comb is held square to the sheet, so tooth spacing is constant vertically.
        const cr = comb(x, v, r * 11);
        T = thicknessFrom(brushed(x, v, x, y), cr, x, v);
        break;
      }
      // Between passes the paste is pushed up into a seam.
      if (T < 0) T = brushed(x, y, x, y) + 0.15;
    }
    T = Math.max(0, T);
    const a = Math.min(1, T / 0.8);
    let c = lerpRGB(ground, paste, a);
    if (T > 0.8) c = lerpRGB(paste, deep, Math.min(1, (T - 0.8) / 0.55));
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = 255;
  };

  sampleField(o, g, superSamples(g, 6e6), sample);
}

export const PASTE_PAPER: MotifDef = {
  kind: 'paste-paper',
  label: 'Paste paper',
  designer: 'diehl',
  description:
    'Paste paper: wheat-starch paste tinted with pigment, brushed on and drawn through with a comb while wet, clearing lines back to the ground — the Herrnhut and Bauhaus-workshop decorated paper that Diehl recommends for honest, home-made covers and endpapers.',
  defaultSize: { w: 288, h: 396 },
  colors: [
    { label: 'Ground', default: '#efe3c6' },
    { label: 'Paste', default: '#365472' },
  ],
  params: [
    { key: 'pattern', label: 'Pattern', min: 0, max: 3, step: 1, default: 0, options: ['Waves', 'Arcs / fans', 'Crosshatch', 'Combed swirls'] },
    { key: 'teeth', label: 'Comb teeth', min: 2, max: 24, step: 1, default: 8 },
    { key: 'amplitude', label: 'Wave amplitude', min: 0, max: 1, step: 0.01, default: 0.34 },
    { key: 'frequency', label: 'Waves per 100 pt', min: 0.2, max: 6, step: 0.05, default: 1.4 },
    { key: 'scale', label: 'Comb width pt', min: 12, max: 160, step: 1, default: 44 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(PASTE_PAPER, el);
    const colors = [0, 1].map((i) => slot(PASTE_PAPER, el, i));
    const { w, h } = el;
    const seed = seedOf(el);
    return [rasterMotif(rasterKey('paste-paper', el, p, colors), w, h, (o, g) => paintPaste(o, g, w, h, p, colors, seed))];
  },
};

/* ========================================================================== */
/* 4. Washi                                                                    */
/* ========================================================================== */

/**
 * Kozo / gampi washi: an uneven, translucent formation (the cloudy "look-through"
 * of a hand-dipped sheet), long wavy bast fibres a shade lighter or darker, and
 * the occasional fleck of outer bark or a pressed petal.
 */
function paintWashi(o: Ctx2D, g: RasterGrid, w: number, h: number, p: Record<string, number>, colors: string[], seed: number): void {
  const base = rgbOf(colors[0]);
  const fibreLight = colors[1];
  const bark = colors[2];
  const petal = colors[3];
  const { W, H, sx, sy } = g;

  // Formation: thickness clouds → opacity and value.
  const lstep = clamp(Math.min(w, h) / 120, 0.6, 3);
  const lat = new Lattice(-lstep, -lstep, w + 2 * lstep, h + 2 * lstep, lstep, 2, (x, y, out) => {
    out[0] = fbm(x / 26, y / 26, 4, seed + 3);
    out[1] = fbm(x / 4.5, y / 4.5, 2, seed + 7);
  });
  const L = [0, 0];
  const img = o.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    const y = (j + 0.5) * sy;
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) * sx;
      lat.read(x, y, L);
      const t = clamp(0.5 + (L[0] - 0.5) * 1.9 + (L[1] - 0.5) * 0.45, 0, 1);
      const k = (j * W + i) * 4;
      const lift = (t - 0.5) * 0.12;
      d[k] = clamp(base[0] * (1 - Math.abs(lift)) + (lift > 0 ? 255 * lift : 0), 0, 255);
      d[k + 1] = clamp(base[1] * (1 - Math.abs(lift)) + (lift > 0 ? 255 * lift : 0), 0, 255);
      d[k + 2] = clamp(base[2] * (1 - Math.abs(lift)) + (lift > 0 ? 255 * lift : 0), 0, 255);
      d[k + 3] = Math.round(255 * (0.7 + 0.28 * t));
    }
  }
  o.putImageData(img, 0, 0);

  o.save();
  o.setTransform(W / w, 0, 0, H / h, 0, 0);
  o.lineCap = 'round';
  o.lineJoin = 'round';
  const area = w * h;
  const len = p.length;
  const r = rng(seed * 7 + 1);

  // Long bast fibres: smooth random walks. Each light fibre sits a hair above
  // the sheet, so it carries a faint shadow that makes it read on pale paper.
  const nLong = Math.min(6000, Math.round(p.fibres * area * 0.009 * Math.sqrt(60 / Math.max(5, len))));
  const darkFibre = mix(colors[0], bark, 0.3);
  const shadow = mix(colors[0], '#000000', 0.35);
  const path: number[] = [];
  for (let f = 0; f < nLong; f++) {
    let x = r() * (w + len) - len / 2, y = r() * (h + len) - len / 2;
    let a = (r() - 0.5) * Math.PI * 1.2 + (r() < 0.5 ? 0 : Math.PI);
    const L0 = len * (0.35 + r() * 1.1);
    const steps = Math.max(3, Math.min(48, Math.round(L0 / 3)));
    const st = L0 / steps;
    const isDark = r() < 0.16;
    const alpha = isDark ? 0.22 + r() * 0.25 : 0.5 + r() * 0.45;
    const width = 0.14 + r() * (isDark ? 0.22 : 0.5);
    let bend = (r() - 0.5) * 0.1;
    path.length = 0;
    path.push(x, y);
    for (let s2 = 0; s2 < steps; s2++) {
      bend += (r() - 0.5) * 0.09;
      bend *= 0.92;
      a += bend;
      x += Math.cos(a) * st;
      y += Math.sin(a) * st;
      path.push(x, y);
    }
    const trace = (dx: number, dy: number) => {
      o.beginPath();
      o.moveTo(path[0] + dx, path[1] + dy);
      for (let q = 2; q < path.length; q += 2) o.lineTo(path[q] + dx, path[q + 1] + dy);
      o.stroke();
    };
    if (!isDark) {
      o.strokeStyle = shadow;
      o.globalAlpha = alpha * 0.22;
      o.lineWidth = width * 1.3;
      trace(0.22, 0.3);
    }
    o.strokeStyle = isDark ? darkFibre : fibreLight;
    o.globalAlpha = alpha;
    o.lineWidth = width;
    trace(0, 0);
  }

  // Short fuzz that gives the surface its tooth.
  const nFuzz = Math.min(9000, Math.round(p.fibres * area * 0.02));
  o.strokeStyle = fibreLight;
  for (let f = 0; f < nFuzz; f++) {
    const x = r() * w, y = r() * h;
    const a = r() * TAU, l = 1.5 + r() * 5;
    o.globalAlpha = 0.15 + r() * 0.3;
    o.lineWidth = 0.08 + r() * 0.18;
    o.beginPath();
    o.moveTo(x, y);
    o.quadraticCurveTo(x + Math.cos(a + 0.5) * l * 0.5, y + Math.sin(a + 0.5) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    o.stroke();
  }

  // Bark flecks: dark slivers of outer kozo bark.
  const nBark = Math.min(1500, Math.round(p.inclusions * area * 0.0016));
  for (let f = 0; f < nBark; f++) {
    const x = r() * w, y = r() * h;
    const a = r() * TAU, l = 0.5 + Math.pow(r(), 2.2) * 4.5, t = 0.25 + r() * 0.7;
    o.globalAlpha = 0.45 + r() * 0.45;
    o.fillStyle = r() < 0.3 ? mix(bark, '#000000', 0.25) : bark;
    const c = Math.cos(a), s = Math.sin(a);
    o.beginPath();
    o.moveTo(x - c * l * 0.5, y - s * l * 0.5);
    o.quadraticCurveTo(x - s * t * 0.6, y + c * t * 0.6, x + c * l * 0.5, y + s * l * 0.5);
    o.quadraticCurveTo(x + s * t * (0.3 + r() * 0.5), y - c * t * (0.3 + r() * 0.5), x - c * l * 0.5, y - s * l * 0.5);
    o.fill();
  }

  // Pressed petals, rare and translucent, paler towards the claw.
  const nPetal = Math.min(80, Math.round(p.inclusions * p.petals * area * 0.00009 + (p.petals > 0.5 && p.inclusions > 0.2 && area > 2e4 ? 1 : 0)));
  const petalPale = mix(petal, colors[0], 0.55);
  for (let f = 0; f < nPetal; f++) {
    const x = r() * w, y = r() * h;
    const a = r() * TAU, l = 5 + r() * 8, b = l * (0.38 + r() * 0.2);
    const notch = 0.06 + r() * 0.1;
    o.save();
    o.translate(x, y);
    o.rotate(a);
    const grad = o.createLinearGradient(0, 0, 0, -l);
    grad.addColorStop(0, petalPale);
    grad.addColorStop(0.55, petal);
    grad.addColorStop(1, petal);
    o.globalAlpha = 0.42 + r() * 0.2;
    o.fillStyle = grad;
    o.beginPath();
    o.moveTo(0, 0);
    o.bezierCurveTo(b * 0.5, -l * 0.08, b * 1.05, -l * 0.6, b * 0.42, -l * 0.98);
    o.quadraticCurveTo(b * 0.12, -l * 1.02, 0, -l * (1 - notch));
    o.quadraticCurveTo(-b * 0.12, -l * 1.02, -b * 0.42, -l * 0.98);
    o.bezierCurveTo(-b * 1.05, -l * 0.6, -b * 0.5, -l * 0.08, 0, 0);
    o.fill();
    // Fine veins fanning from the claw.
    o.globalAlpha = 0.22;
    o.strokeStyle = mix(petal, '#000000', 0.25);
    o.lineWidth = 0.1;
    for (let v = -2; v <= 2; v++) {
      o.beginPath();
      o.moveTo(0, -l * 0.04);
      o.quadraticCurveTo(v * b * 0.18, -l * 0.5, v * b * 0.24, -l * 0.9);
      o.stroke();
    }
    o.restore();
  }
  o.restore();
}

export const WASHI: MotifDef = {
  kind: 'washi',
  label: 'Washi paper',
  designer: 'sato',
  description:
    'Hand-made kozo and gampi washi: a translucent, cloudy formation threaded with long bast fibres, flecked with outer bark and the occasional pressed petal — the paper of wa-toji stab bindings, where the sheet itself carries the quiet the Japanese call ma.',
  defaultSize: { w: 288, h: 396 },
  colors: [
    { label: 'Paper', default: '#eee6d4' },
    { label: 'Fibres', default: '#fdfbf5' },
    { label: 'Bark flecks', default: '#6c5a41' },
    { label: 'Petals', default: '#c45a72' },
  ],
  params: [
    { key: 'fibres', label: 'Fibres', min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: 'length', label: 'Fibre length pt', min: 5, max: 160, step: 1, default: 56 },
    { key: 'inclusions', label: 'Inclusions', min: 0, max: 1, step: 0.01, default: 0.35 },
    { key: 'petals', label: 'Petals among inclusions', min: 0, max: 1, step: 0.01, default: 0.4 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(WASHI, el);
    const colors = [0, 1, 2, 3].map((i) => slot(WASHI, el, i));
    const { w, h } = el;
    const seed = seedOf(el);
    return [rasterMotif(rasterKey('washi', el, p, colors), w, h, (o, g) => paintWashi(o, g, w, h, p, colors, seed))];
  },
};
