/**
 * Ornament drawn as vector: block-printed endpaper repeats (Diehl), the
 * rubricator's line-fillers and paragraph marks (Cleves) and printers'
 * flowers (Tschichold). Every unit is drawn once in a unit space and placed
 * through the transforming Pen, so hundreds of repeats collapse into a handful
 * of path primitives.
 */
import type { Matrix, PathPrim, Prim } from '../../render/primitives';
import { IDENTITY, multiply, rectPath } from '../../render/primitives';
import { mix } from '../../lib/color';
import { clamp, rng } from '../../lib/random';
import { DEG, Pen, TAU, place } from '../generators/util';
import type { Pt } from '../generators/util';
import type { MotifDef } from './types';
import { okBox, readMotifParams, seedOf, slot } from './decorative-shared';

/* -------------------------------------------------------------------------- */
/* Layers: one Pen per (colour, fill | stroke width), emitted in a fixed order  */
/* -------------------------------------------------------------------------- */

class Layers {
  private order: { key: string; pen: Pen; style: Omit<PathPrim, 't' | 'd'> }[] = [];
  private map = new Map<string, Pen>();

  constructor(private base: Matrix = IDENTITY) {}

  fill(color: string, z = 0): Pen {
    return this.get(`${z}|f|${color}`, { fill: color, stroke: null });
  }

  stroke(color: string, width: number, z = 0, cap: PathPrim['cap'] = 'round'): Pen {
    return this.get(`${z}|s|${color}|${width.toFixed(3)}|${cap}`, { fill: null, stroke: color, strokeWidth: width, cap, join: 'round' });
  }

  private get(key: string, style: Omit<PathPrim, 't' | 'd'>): Pen {
    let pen = this.map.get(key);
    if (!pen) {
      pen = new Pen(this.base);
      this.map.set(key, pen);
      this.order.push({ key, pen, style });
    }
    return pen;
  }

  prims(): PathPrim[] {
    const z = (k: string) => parseFloat(k);
    return this.order
      .map((o, i) => ({ ...o, i }))
      .sort((a, b) => z(a.key) - z(b.key) || a.i - b.i)
      .filter((o) => !o.pen.empty)
      .map((o) => ({ t: 'path', d: o.pen.d, ...o.style }) as PathPrim);
  }
}

/** Counter-clockwise circle (a hole under the nonzero rule; Pen.circle is clockwise). */
function holeCircle(pen: Pen, cx: number, cy: number, r: number): Pen {
  const k = r * 0.5523;
  pen.move(cx - r, cy);
  pen.curve(cx - r, cy + k, cx - k, cy + r, cx, cy + r);
  pen.curve(cx + k, cy + r, cx + r, cy + k, cx + r, cy);
  pen.curve(cx + r, cy - k, cx + k, cy - r, cx, cy - r);
  pen.curve(cx - k, cy - r, cx - r, cy - k, cx - r, cy);
  return pen.close();
}

/** Almond leaf from (0,0) to (len,0), drawn clockwise. */
function leaf(pen: Pen, len: number, width: number): Pen {
  pen.move(0, 0);
  pen.curve(len * 0.25, -width, len * 0.72, -width * 0.95, len, 0);
  pen.curve(len * 0.72, width * 0.95, len * 0.25, width, 0, 0);
  return pen.close();
}

/* ========================================================================== */
/* 3. Block-printed endpaper repeat                                            */
/* ========================================================================== */

interface BlockInks { ink1: Pen; ink2: Pen; cut: Pen; ink1Line: Pen; ink2Line: Pen; cutLine: Pen }

/** Five heart-tipped petals, a stem with two leaves and buds (after Arts & Crafts block prints). */
function floral(k: BlockInks, M1: Matrix, M2: Matrix): void {
  const fy = -0.13, ps = 1.22;
  k.ink1.with(M1, (p) => {
    for (let i = 0; i < 5; i++) {
      p.with(place(0, fy, (i * TAU) / 5, ps), (q) => {
        q.move(0, -0.035);
        q.curve(-0.085, -0.06, -0.135, -0.17, -0.1, -0.225);
        q.curve(-0.075, -0.262, -0.03, -0.262, 0, -0.228);
        q.curve(0.03, -0.262, 0.075, -0.262, 0.1, -0.225);
        q.curve(0.135, -0.17, 0.085, -0.06, 0, -0.035);
        q.close();
      });
    }
    // Buds closing the tendrils.
    p.with(place(-0.24, 0.36, -0.5), (q) => q.ellipse(0, 0, 0.032, 0.05));
    p.with(place(0.24, 0.36, 0.5), (q) => q.ellipse(0, 0, 0.032, 0.05));
  });
  k.cut.with(M1, (p) => {
    // White-line cuts in the block: petal veins.
    for (let i = 0; i < 5; i++) {
      p.with(place(0, fy, (i * TAU) / 5, ps), (q) => {
        q.move(0, -0.1);
        q.curve(-0.018, -0.13, -0.016, -0.17, 0, -0.198);
        q.curve(0.016, -0.17, 0.018, -0.13, 0, -0.1);
        q.close();
      });
    }
  });
  k.ink2Line.with(M2, (p) => {
    p.move(0, fy + 0.08).curve(0.025, 0.08, -0.03, 0.24, 0.0, 0.42);
    p.move(0.0, 0.3).curve(-0.08, 0.3, -0.18, 0.31, -0.22, 0.34);
    p.move(0.0, 0.3).curve(0.08, 0.3, 0.18, 0.31, 0.22, 0.34);
  });
  k.ink2.with(M2, (p) => {
    p.circle(0, fy, 0.07);
    p.with(place(0.0, 0.17, -0.38), (q) => leaf(q, 0.36, 0.095));
    p.with(place(0.0, 0.17, Math.PI + 0.38), (q) => leaf(q, 0.36, 0.095));
  });
  k.cutLine.with(M2, (p) => {
    p.with(place(0.0, 0.17, -0.38), (q) => q.move(0.05, 0).line(0.28, 0));
    p.with(place(0.0, 0.17, Math.PI + 0.38), (q) => q.move(0.05, 0).line(0.28, 0));
  });
  k.cut.with(M2, (p) => {
    p.circle(0, fy, 0.026);
    for (let i = 0; i < 8; i++) p.circle(Math.cos((i * TAU) / 8) * 0.05, fy + Math.sin((i * TAU) / 8) * 0.05, 0.008);
  });
}

function floralFiller(k: BlockInks, M1: Matrix, M2: Matrix): void {
  k.ink1.with(M1, (p) => {
    for (let i = 0; i < 4; i++) p.with(place(0, 0, (i * TAU) / 4 + Math.PI / 4), (q) => q.ellipse(0, -0.065, 0.034, 0.052));
  });
  k.ink2.with(M2, (p) => {
    p.circle(0, 0, 0.028);
    for (let i = 0; i < 4; i++) p.circle(Math.cos((i * TAU) / 4) * 0.13, Math.sin((i * TAU) / 4) * 0.13, 0.018);
  });
}

/** Willow-like sprig: an S-curved stem with alternating leaves and a cluster of berries. */
function sprig(k: BlockInks, M1in: Matrix, M2in: Matrix): void {
  // Leaning a little, so neighbouring impressions interlock instead of stacking.
  const M1 = multiply(M1in, place(0, 0, 0.4)), M2 = multiply(M2in, place(0, 0, 0.4));
  const stem: Pt[] = [[-0.1, 0.4], [-0.03, 0.18], [-0.07, -0.04], [0.03, -0.22], [0.12, -0.36]];
  k.ink2Line.with(M2, (p) => p.smooth(stem));
  const at = (t: number): [number, number, number] => {
    // Sample the Catmull-Rom polyline approximately via linear interpolation of the control points.
    const f = t * (stem.length - 1), i = Math.min(stem.length - 2, Math.floor(f)), u = f - i;
    const a = stem[i], b = stem[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.atan2(b[1] - a[1], b[0] - a[0])];
  };
  k.ink2.with(M2, (p) => {
    const ts = [0.14, 0.3, 0.46, 0.62, 0.78];
    ts.forEach((t, i) => {
      const [x, y, a] = at(t);
      const side = i % 2 ? 1 : -1;
      const len = 0.3 - i * 0.03;
      p.with(place(x, y, a + side * 0.95), (q) => leaf(q, len, len * 0.27));
    });
  });
  k.cutLine.with(M2, (p) => {
    const ts = [0.14, 0.3, 0.46, 0.62, 0.78];
    ts.forEach((t, i) => {
      const [x, y, a] = at(t);
      const side = i % 2 ? 1 : -1;
      const len = 0.3 - i * 0.03;
      p.with(place(x, y, a + side * 0.95), (q) => q.move(len * 0.15, 0).line(len * 0.78, 0));
    });
  });
  k.ink1.with(M1, (p) => {
    p.circle(0.15, -0.4, 0.04).circle(0.21, -0.35, 0.034).circle(0.16, -0.31, 0.03);
    p.circle(-0.2, 0.06, 0.032).circle(-0.25, 0.1, 0.026);
  });
  k.ink1Line.with(M1, (p) => p.move(-0.06, 0.05).curve(-0.12, 0.04, -0.17, 0.05, -0.2, 0.06));
}

function sprigFiller(k: BlockInks, M1: Matrix, M2: Matrix): void {
  k.ink2.with(M2, (p) => {
    p.with(place(0, 0.02, -2.2), (q) => leaf(q, 0.12, 0.035));
    p.with(place(0, 0.02, -0.95), (q) => leaf(q, 0.12, 0.035));
  });
  k.ink1.with(M1, (p) => p.circle(0, 0.05, 0.025));
}

/** Eight-pointed star (two interlaced squares) with lozenges between. */
function star(k: BlockInks, M1: Matrix, M2: Matrix): void {
  const R = 0.31;
  k.ink1.with(M1, (p) => {
    for (const rot of [0, Math.PI / 4]) {
      const pts: Pt[] = [];
      for (let i = 0; i < 4; i++) pts.push([Math.cos(rot + (i * TAU) / 4) * R, Math.sin(rot + (i * TAU) / 4) * R]);
      p.poly(pts, true);
    }
  });
  k.cutLine.with(M1, (p) => {
    const pts: Pt[] = [];
    for (let i = 0; i < 8; i++) pts.push([Math.cos(Math.PI / 8 + (i * TAU) / 8) * 0.17, Math.sin(Math.PI / 8 + (i * TAU) / 8) * 0.17]);
    p.poly(pts, true);
  });
  k.ink2.with(M2, (p) => {
    const pts: Pt[] = [];
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? 0.045 : 0.11;
      pts.push([Math.cos((i * TAU) / 8 - Math.PI / 2) * r, Math.sin((i * TAU) / 8 - Math.PI / 2) * r]);
    }
    p.poly(pts, true);
  });
}

function lozenge(k: BlockInks, M1: Matrix, M2: Matrix): void {
  k.ink2.with(M2, (p) => p.poly([[0, -0.16], [0.1, 0], [0, 0.16], [-0.1, 0]], true));
  k.cutLine.with(M2, (p) => p.poly([[0, -0.085], [0.05, 0], [0, 0.085], [-0.05, 0]], true));
  k.ink1.with(M1, (p) => p.circle(0, 0, 0.02));
}

/** Annulus with a central boss and a crown of dots. */
function ring(k: BlockInks, M1: Matrix, M2: Matrix): void {
  k.ink1Line.with(M1, (p) => p.circle(0, 0, 0.255));
  k.ink2.with(M2, (p) => {
    p.circle(0, 0, 0.1);
    for (let i = 0; i < 8; i++) p.circle(Math.cos((i * TAU) / 8 + Math.PI / 8) * 0.39, Math.sin((i * TAU) / 8 + Math.PI / 8) * 0.39, 0.026);
  });
  k.cut.with(M2, (p) => p.circle(0, 0, 0.032));
}

function ringFiller(k: BlockInks, M1: Matrix, M2: Matrix): void {
  k.ink2Line.with(M2, (p) => p.circle(0, 0, 0.07));
  k.ink1.with(M1, (p) => p.circle(0, 0, 0.028));
}

export const BLOCK_REPEAT: MotifDef = {
  kind: 'block-repeat',
  label: 'Block-printed repeat',
  designer: 'diehl',
  description:
    'A block-printed endpaper in half-drop repeat: one carved block per ink, printed in two colours on a tinted ground with the slight misregister of hand printing — the Arts & Crafts decorated paper (Morris, the Curwen Press) that Diehl prized for endpapers.',
  defaultSize: { w: 288, h: 396 },
  colors: [
    { label: 'Ground', default: '#efe6d1' },
    { label: 'Ink 1', default: '#9a3a2c' },
    { label: 'Ink 2', default: '#2f4c3e' },
  ],
  params: [
    { key: 'motif', label: 'Motif', min: 0, max: 3, step: 1, default: 0, options: ['Floral', 'Leaf sprig', 'Star & lozenge', 'Dots & rings'] },
    { key: 'scale', label: 'Repeat size pt', min: 12, max: 240, step: 1, default: 62 },
    { key: 'drop', label: 'Drop (0.5 = half drop)', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'register', label: 'Misregister pt', min: 0, max: 2, step: 0.05, default: 0.35 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(BLOCK_REPEAT, el);
    const ground = slot(BLOCK_REPEAT, el, 0), c1 = slot(BLOCK_REPEAT, el, 1), c2 = slot(BLOCK_REPEAT, el, 2);
    const { w, h } = el;
    // A tiny repeat on a huge sheet is coarsened to ≈600 impressions to keep the paths light.
    const T = Math.max(p.scale, Math.sqrt((w * h) / 600));
    const motif = Math.round(p.motif);
    const lw = (k: number) => k * T;
    const lay = new Layers();
    const inks: BlockInks = {
      ink1: lay.fill(c1, 1),
      ink1Line: lay.stroke(c1, lw(motif === 3 ? 0.07 : 0.022), 1),
      cut: lay.fill(ground, 2),
      ink2: lay.fill(c2, 3),
      ink2Line: lay.stroke(c2, lw(motif === 3 ? 0.03 : 0.024), 3),
      cutLine: lay.stroke(ground, lw(0.013), 4),
    };
    const main = [floral, sprig, star, ring][motif] ?? floral;
    const fill = [floralFiller, sprigFiller, lozenge, ringFiller][motif] ?? floralFiller;
    const r = rng(seedOf(el) * 13 + 5);
    for (let c = -1; c <= Math.ceil(w / T); c++) {
      // Column drop: 0 = straight repeat, 0.5 = half drop, any fraction = n-drop.
      const off = ((((c * p.drop) % 1) + 1) % 1) * T;
      for (let rr = -2; rr <= Math.ceil(h / T) + 1; rr++) {
        const cx = c * T + T / 2, cy = rr * T + T / 2 + off;
        // Each impression of the second block lands a little off register.
        const jx = (r() - 0.5) * 2 * p.register, jy = (r() - 0.5) * 2 * p.register;
        if (cx > -T * 0.55 && cx < w + T * 0.55 && cy > -T * 0.55 && cy < h + T * 0.55) {
          main(inks, place(cx, cy, 0, T), place(cx + jx, cy + jy, 0, T));
        }
        // The filler sits in the centre of the lattice cell between four impressions.
        const fx = cx + T / 2, fy = cy + (T * (p.drop + 1)) / 2;
        if (fx > -T * 0.3 && fx < w + T * 0.3 && fy > -T * 0.3 && fy < h + T * 0.3) {
          fill(inks, place(fx, fy, 0, T), place(fx + jx, fy + jy, 0, T));
        }
      }
    }
    return [{ t: 'path', d: rectPath(0, 0, w, h), fill: ground }, { t: 'group', clip: rectPath(0, 0, w, h), children: lay.prims() }];
  },
};

/* ========================================================================== */
/* 5. Manuscript line-fillers                                                  */
/* ========================================================================== */

export const LINE_FILLER: MotifDef = {
  kind: 'line-filler',
  label: 'Line-fillers',
  designer: 'cleves',
  description:
    'Line-fillers (bouts-de-ligne): the rubricator’s red and blue bars, patterned in white penwork, that close the short last lines of prayers and litanies so the text block keeps an even edge — as throughout the Hours of Catherine of Cleves.',
  defaultSize: { w: 150, h: 125 },
  colors: [
    { label: 'Red (vermilion)', default: '#b3291d' },
    { label: 'Blue (azurite)', default: '#2b4f9c' },
    { label: 'Penwork', default: '#fbf5e4' },
  ],
  params: [
    { key: 'lineSpacing', label: 'Line spacing pt', min: 4, max: 48, step: 0.25, default: 12.5 },
    { key: 'count', label: 'Lines (0 = fill height)', min: 0, max: 200, step: 1, default: 0 },
    { key: 'minLength', label: 'Shortest bar pt', min: 0, max: 600, step: 1, default: 16 },
    { key: 'style', label: 'Penwork', min: 0, max: 2, step: 1, default: 0, options: ['Zigzag', 'Dots', 'Interlace'] },
    { key: 'barHeight', label: 'Bar height (× line)', min: 0.15, max: 0.85, step: 0.01, default: 0.44 },
    { key: 'split', label: 'Two-colour bars', min: 0, max: 1, step: 0.01, default: 0.25 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(LINE_FILLER, el);
    const red = slot(LINE_FILLER, el, 0), blue = slot(LINE_FILLER, el, 1), white = slot(LINE_FILLER, el, 2);
    const { w, h } = el;
    const ls = p.lineSpacing;
    const fit = Math.max(1, Math.floor(h / ls + 1e-6));
    const lines = Math.min(400, p.count > 0 ? Math.min(Math.round(p.count), fit) : fit);
    const bh = Math.max(0.2, ls * p.barHeight);
    // Coarsen the penwork when a huge field of tiny bars would explode the path data.
    const perBar = [1 / 0.62, 8.4, 11.8][Math.round(p.style)] ?? 2;
    const coarse = Math.max(1, ((lines * w) / bh) * perBar / 24000);
    const style = Math.round(p.style);
    const r = rng(seedOf(el) * 7 + 3);
    const lay = new Layers();
    const fills = [lay.fill(red, 0), lay.fill(blue, 0)];
    const outlines = [lay.stroke(mix(red, '#1a0d08', 0.45), Math.max(0.12, bh * 0.035), 1), lay.stroke(mix(blue, '#05081a', 0.45), Math.max(0.12, bh * 0.035), 1)];
    const pen = lay.stroke(white, Math.max(0.12, bh * (style === 2 ? 0.085 : 0.11)), 2);
    const dots = lay.fill(white, 3);
    const minL = Math.min(p.minLength, w);
    const start = r() < 0.5 ? 0 : 1;
    for (let i = 0; i < lines; i++) {
      const u = r();
      const len = clamp(minL + (w - minL) * Math.pow(u, 0.85), Math.min(w, Math.max(bh * 0.8, 0.5)), w);
      const x0 = w - len, x1 = w;
      const yc = i * ls + ls * 0.55;
      const y0 = yc - bh / 2;
      const ci = (i + start) % 2;
      const split = len > bh * 6 && r() < p.split ? x0 + len * (0.35 + 0.3 * r()) : -1;
      // Rounded head at the left, square at the margin.
      const rr = Math.min(bh / 2, len / 2);
      const bar = (q: Pen, a: number, b: number, head: boolean) => {
        if (head) {
          q.move(a + rr, y0).line(b, y0).line(b, y0 + bh).line(a + rr, y0 + bh);
          q.curve(a + rr * 0.45, y0 + bh, a, y0 + bh / 2 + rr * 0.55, a, y0 + bh / 2);
          q.curve(a, y0 + bh / 2 - rr * 0.55, a + rr * 0.45, y0, a + rr, y0);
          q.close();
        } else q.rect(a, y0, b - a, bh);
      };
      if (split > 0) {
        bar(fills[ci], x0, split, true);
        bar(fills[1 - ci], split, x1, false);
        bar(outlines[ci], x0, split, true);
        bar(outlines[1 - ci], split, x1, false);
      } else {
        bar(fills[ci], x0, x1, true);
        bar(outlines[ci], x0, x1, true);
      }
      // White penwork inside the bar, drawn freehand (a little uneven).
      const a = x0 + Math.min(len * 0.5, rr + bh * 0.25), b = x1 - bh * 0.25;
      if (b - a < bh * 0.4 || bh < 1.2) continue;
      const ins = bh * 0.24;
      const jit = () => (r() - 0.5) * bh * 0.07;
      if (style === 0) {
        const step = bh * 0.62 * coarse;
        const n = Math.max(1, Math.round((b - a) / step));
        const st = (b - a) / n;
        const pts: Pt[] = [];
        for (let k = 0; k <= n; k++) pts.push([a + k * st + (k && k < n ? jit() : 0), (k % 2 ? y0 + bh - ins : y0 + ins) + jit()]);
        pen.poly(pts);
      } else if (style === 1) {
        const step = bh * 0.95 * coarse;
        const n = Math.max(1, Math.floor((b - a) / step));
        const off = a + ((b - a) - (n - 1) * step) / 2;
        for (let k = 0; k < n; k++) {
          const x = off + k * step + jit();
          if (k % 2) {
            const d = bh * 0.085;
            dots.circle(x, yc - bh * 0.17, d).circle(x - bh * 0.15, yc + bh * 0.12, d).circle(x + bh * 0.15, yc + bh * 0.12, d);
          } else dots.circle(x, yc, bh * 0.13);
        }
      } else {
        const per = bh * 1.7 * coarse;
        const n = Math.max(1, Math.round((b - a) / per));
        const P = (b - a) / n;
        const amp = bh / 2 - ins;
        for (const ph of [0, Math.PI]) {
          const pts: Pt[] = [];
          const steps = n * 6;
          for (let k = 0; k <= steps; k++) {
            const x = a + (k / steps) * (b - a);
            pts.push([x, yc + amp * Math.sin(((x - a) / P) * TAU + ph)]);
          }
          pen.smooth(pts);
        }
        for (let k = 0; k < n * 2; k++) {
          const x = a + (k + 0.5) * (P / 2);
          if (x < b) dots.circle(x, yc, bh * 0.06);
        }
      }
    }
    return lay.prims();
  },
};

/* ========================================================================== */
/* 6. Rubricated paragraph marks                                               */
/* ========================================================================== */

/** A rubricator's paragraphus: bowl, double stem and head stroke, height 1, width ≈ 0.6 (clockwise subpaths). */
function pilcrow(p: Pen): void {
  // Bowl: a pen-drawn teardrop hanging from the head stroke.
  p.move(0.36, 0.56);
  p.curve(0.16, 0.57, 0.02, 0.45, 0.02, 0.3);
  p.curve(0.02, 0.14, 0.15, 0.04, 0.34, 0.03);
  p.line(0.4, 0.03);
  p.line(0.4, 0.56);
  p.close();
  // Thick stem, a little swelling at the foot.
  p.move(0.36, 0.03).line(0.445, 0.03).line(0.44, 0.97).curve(0.43, 1.0, 0.37, 1.01, 0.35, 0.99).line(0.36, 0.03).close();
  // Thin stem.
  p.move(0.535, 0.03).line(0.585, 0.03).line(0.58, 0.985).line(0.53, 0.985).close();
  // Head stroke, slightly sloped like a broad nib.
  p.move(0.3, 0.0).line(0.63, -0.02).line(0.625, 0.055).line(0.3, 0.065).close();
}

export const PILCROW_COLUMN: MotifDef = {
  kind: 'pilcrow-column',
  label: 'Rubricated ¶ marks',
  designer: 'cleves',
  description:
    'A margin column of paragraph marks (paragraphi) touched in by the rubricator in alternating red and blue — the medieval way of articulating a continuous text block before the indent existed; drawn as vector so no font is needed.',
  defaultSize: { w: 14, h: 300 },
  colors: [
    { label: 'Red (vermilion)', default: '#b3291d' },
    { label: 'Blue (azurite)', default: '#2b4f9c' },
  ],
  params: [
    { key: 'lineSpacing', label: 'Line spacing pt', min: 4, max: 48, step: 0.25, default: 12.5 },
    { key: 'every', label: 'Every n lines', min: 1, max: 24, step: 1, default: 3 },
    { key: 'irregularity', label: 'Irregularity', min: 0, max: 1, step: 0.01, default: 0.45 },
    { key: 'size', label: 'Mark height (× line)', min: 0.3, max: 1.5, step: 0.01, default: 0.8 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(PILCROW_COLUMN, el);
    const cols = [slot(PILCROW_COLUMN, el, 0), slot(PILCROW_COLUMN, el, 1)];
    const { w, h } = el;
    const ls = p.lineSpacing;
    const lines = Math.max(1, Math.min(2000, Math.floor(h / ls + 1e-6)));
    const every = Math.max(1, Math.round(p.every));
    const r = rng(seedOf(el) * 11 + 1);
    let mh = p.size * ls;
    if (mh * 0.64 > w) mh = w / 0.64;
    const lay = new Layers();
    const pens = [lay.fill(cols[0]), lay.fill(cols[1])];
    let ci = r() < 0.5 ? 0 : 1;
    let last = -1;
    for (let k = 0; k * every < lines; k++) {
      if (k > 0 && r() < p.irregularity * 0.3) continue;
      const shift = Math.round((r() - 0.5) * p.irregularity * (every - 1));
      const line = clamp(k * every + shift, 0, lines - 1);
      if (line <= last) continue;
      last = line;
      const baseline = (line + 1) * ls - ls * 0.24;
      const top = baseline - mh * 0.84;
      if (top + mh > h + 1e-6 && line > 0) break;
      const mw = mh * 0.64;
      const x = (w - mw) / 2;
      pens[ci].with(place(x, Math.max(0, top), 0, mh), pilcrow);
      ci = 1 - ci;
    }
    return lay.prims();
  },
};

/* ========================================================================== */
/* 7. Printers' flowers                                                        */
/* ========================================================================== */

type Fleuron = 'hedera' | 'petal' | 'arabesque';

interface FleuronInks { ink: Pen; accent: Pen; stem: Pen; accentStem: Pen }

/** Aldine hedera leaf ❦, pointing +x, unit box. */
function hedera(k: FleuronInks, M: Matrix, accent = false): void {
  const fill = accent ? k.accent : k.ink;
  fill.with(M, (p) => {
    p.move(-0.16, -0.01);
    p.curve(-0.27, -0.1, -0.24, -0.3, -0.06, -0.31);
    p.curve(0.1, -0.32, 0.22, -0.16, 0.42, 0.03);
    p.curve(0.22, 0.17, 0.12, 0.34, -0.05, 0.31);
    p.curve(-0.22, 0.29, -0.27, 0.1, -0.16, -0.01);
    p.close();
    // Midrib, cut out (counter-clockwise).
    p.move(-0.1, 0.0);
    p.curve(0.02, 0.028, 0.2, 0.012, 0.31, 0.025);
    p.curve(0.2, -0.016, 0.02, -0.032, -0.1, 0.0);
    p.close();
  });
  (accent ? k.accentStem : k.stem).with(M, (p) => {
    p.move(-0.16, -0.01);
    p.curve(-0.3, -0.02, -0.41, -0.11, -0.39, -0.23);
    p.curve(-0.37, -0.32, -0.27, -0.34, -0.24, -0.27);
  });
}

/** Four heart-tipped petals ✤ with a boss and four seeds, unit box. */
function fourPetal(k: FleuronInks, M: Matrix, accent = false): void {
  (accent ? k.accent : k.ink).with(M, (p) => {
    for (let i = 0; i < 4; i++) {
      p.with(place(0, 0, (i * TAU) / 4), (q) => {
        q.move(0, -0.075);
        q.curve(-0.1, -0.12, -0.21, -0.28, -0.15, -0.4);
        q.curve(-0.11, -0.47, -0.04, -0.47, 0, -0.41);
        q.curve(0.04, -0.47, 0.11, -0.47, 0.15, -0.4);
        q.curve(0.21, -0.28, 0.1, -0.12, 0, -0.075);
        q.close();
      });
    }
    holeCircle(p, 0, 0, 0.075);
  });
  (accent ? k.ink : k.accent).with(M, (p) => {
    p.circle(0, 0, 0.045);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * TAU) / 4;
      p.circle(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0.04);
    }
  });
}

/** Rinceau / arabesque unit: a sine stem with paired curls; point-symmetric so it joins end to end. */
function arabesque(k: FleuronInks, M: Matrix, accent = false): void {
  const stemPts: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const x = -0.5 + i / 12;
    stemPts.push([x, 0.15 * Math.sin(TAU * x)]);
  }
  const curl: Pt[] = [[-0.12, -0.1], [-0.07, -0.26], [0.07, -0.35], [0.2, -0.3], [0.22, -0.19], [0.15, -0.15], [0.12, -0.2]];
  const stem = accent ? k.accentStem : k.stem;
  stem.with(M, (p) => {
    p.smooth(stemPts);
    p.smooth(curl);
    p.with(place(0, 0, Math.PI), (q) => q.smooth(curl));
  });
  (accent ? k.accent : k.ink).with(M, (p) => {
    p.with(place(0.3, 0.14, 0.95), (q) => leaf(q, 0.2, 0.06));
    p.with(place(-0.3, -0.14, 0.95 + Math.PI), (q) => leaf(q, 0.2, 0.06));
  });
  (accent ? k.ink : k.accent).with(M, (p) => {
    p.circle(0.155, -0.215, 0.035);
    p.circle(-0.155, 0.215, 0.035);
  });
}

function drawFleuron(kind: Fleuron, k: FleuronInks, M: Matrix, accent = false): void {
  if (kind === 'hedera') hedera(k, M, accent);
  else if (kind === 'petal') fourPetal(k, M, accent);
  else arabesque(k, M, accent);
}

export const FLEURON_BORDER: MotifDef = {
  kind: 'fleuron-border',
  label: 'Fleuron border',
  designer: 'tschichold',
  description:
    'Printers’ flowers — the Aldine hedera leaf, a four-petal flower and a rinceau arabesque — composed into rules, frames, lattices or corner pieces, the classical ornament Tschichold returned to in his Penguin and Birkhäuser title pages after abandoning the New Typography.',
  defaultSize: { w: 288, h: 22 },
  colors: [
    { label: 'Ornament', default: '#1b1813' },
    { label: 'Accent', default: '#b0331f' },
  ],
  params: [
    { key: 'unit', label: 'Unit pt', min: 4, max: 96, step: 0.5, default: 14 },
    { key: 'style', label: 'Fleuron', min: 0, max: 3, step: 1, default: 0, options: ['Hedera leaf', 'Four-petal', 'Arabesque', 'Alternating'] },
    { key: 'arrangement', label: 'Arrangement', min: 0, max: 3, step: 1, default: 0, options: ['Rule', 'Frame', 'Diamond lattice', 'Corner pieces'] },
    { key: 'rotateAlternate', label: 'Turn every other unit', min: 0, max: 1, step: 1, default: 1 },
    { key: 'spacing', label: 'Spacing (× unit)', min: 0, max: 1.5, step: 0.01, default: 0.2 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(FLEURON_BORDER, el);
    const ink = slot(FLEURON_BORDER, el, 0), acc = slot(FLEURON_BORDER, el, 1);
    const { w, h } = el;
    const style = Math.round(p.style);
    const arr = Math.round(p.arrangement);
    const alt = p.rotateAlternate >= 0.5;
    const kindAt = (i: number): Fleuron => (style === 0 ? 'hedera' : style === 1 ? 'petal' : style === 2 ? 'arabesque' : i % 2 ? 'petal' : 'hedera');
    const accentAt = (i: number) => style === 3 && i % 2 === 1;
    let s = Math.max(0.5, p.unit);
    const units: { x: number; y: number; a: number; s: number; kind: Fleuron; accent: boolean; M?: Matrix }[] = [];
    const dots: { x: number; y: number; r: number }[] = [];

    if (arr === 0) {
      // Rule: a single justified row centred vertically.
      s = Math.min(s, h);
      const arab = style === 2;
      const pitch0 = arab ? s : s * (1 + p.spacing);
      const n = Math.max(1, Math.min(600, Math.floor(w / pitch0 + 1e-6)));
      const pitch = w / n;
      if (arab) s = pitch;
      else if (pitch < s) s = pitch;
      for (let i = 0; i < n; i++) {
        units.push({ x: (i + 0.5) * pitch, y: h / 2, a: alt && i % 2 ? 180 : 0, s, kind: kindAt(i), accent: accentAt(i) });
      }
    } else if (arr === 1) {
      // Frame: edges circulate clockwise; corners take an accent flower.
      s = Math.min(s, w / 3, h / 3);
      const pitch0 = style === 2 ? s : s * (1 + p.spacing);
      const side = (len: number, at: (t: number) => [number, number], ang: number) => {
        const L = len - 2 * s;
        if (L < s * 0.5) return;
        const n = Math.max(1, Math.min(400, Math.round(L / pitch0)));
        const st = L / n;
        for (let i = 0; i < n; i++) {
          const [x, y] = at(s + (i + 0.5) * st);
          units.push({ x, y, a: ang + (alt && i % 2 ? 180 : 0), s: Math.min(s, style === 2 ? st : s), kind: kindAt(i), accent: accentAt(i) });
        }
      };
      side(w, (t) => [t, s / 2], 0);
      side(h, (t) => [w - s / 2, t], 90);
      side(w, (t) => [w - t, h - s / 2], 180);
      side(h, (t) => [s / 2, h - t], 270);
      for (const [x, y] of [[s / 2, s / 2], [w - s / 2, s / 2], [w - s / 2, h - s / 2], [s / 2, h - s / 2]] as Pt[]) {
        units.push({ x, y, a: 45, s: s * 0.95, kind: 'petal', accent: true });
      }
    } else if (arr === 2) {
      // Diamond lattice: rows offset by half a pitch so diagonal neighbours sit one
      // unit (plus spacing) apart; dots mark the open centres of the lozenges.
      s = Math.min(s, w, h);
      // Keep the lattice to ≈700 units by enlarging them on very large boxes.
      s = Math.max(s, Math.sqrt((w * h) / 700) / (1 + p.spacing));
      const pitch = s * (1 + p.spacing) * Math.SQRT2, half = pitch / 2;
      const stagger = w - s >= half && h - s >= half;
      const rowStep = stagger ? half : pitch;
      const ny = Math.max(1, Math.floor((h - s) / rowStep + 1e-9) + 1);
      const nx = Math.max(1, Math.floor((w - s - (stagger ? half : 0)) / pitch + 1e-9) + 1);
      const bw = (nx - 1) * pitch + (stagger && ny > 1 ? half : 0), bh = (ny - 1) * rowStep;
      const ox = (w - bw) / 2, oy = (h - bh) / 2;
      for (let j = 0; j < ny; j++) {
        const off = stagger && j % 2 ? half : 0;
        for (let i = 0; i < nx; i++) {
          const x = ox + off + i * pitch, y = oy + j * rowStep;
          const idx = i + j;
          units.push({ x, y, a: 45 + (alt && idx % 2 ? 180 : 0) + (style === 1 ? -45 : 0), s, kind: kindAt(idx), accent: accentAt(idx) });
          if (i < nx - 1) dots.push({ x: x + half, y, r: s * 0.06 });
        }
      }
    } else {
      // Corner pieces: a flower in the corner, two units running out along each edge.
      s = Math.min(s, w / 4, h / 4);
      const pitch = style === 2 ? s : s * (1 + p.spacing);
      const corners: Matrix[] = [
        IDENTITY,
        [-1, 0, 0, 1, w, 0],
        [1, 0, 0, -1, 0, h],
        [-1, 0, 0, -1, w, h],
      ];
      for (const C of corners) {
        const local: { x: number; y: number; a: number; kind: Fleuron; accent: boolean }[] = [
          { x: s / 2, y: s / 2, a: 45, kind: 'petal', accent: true },
          { x: s / 2 + pitch, y: s / 2, a: 0, kind: kindAt(0), accent: false },
          { x: s / 2 + pitch * 2, y: s / 2, a: alt ? 180 : 0, kind: kindAt(1), accent: accentAt(1) },
          { x: s / 2, y: s / 2 + pitch, a: 90, kind: kindAt(0), accent: false },
          { x: s / 2, y: s / 2 + pitch * 2, a: alt ? 270 : 90, kind: kindAt(1), accent: accentAt(1) },
        ];
        for (const u of local) {
          units.push({ x: 0, y: 0, a: 0, s, kind: u.kind, accent: u.accent, M: multiply(C, place(u.x, u.y, u.a * DEG, s)) });
        }
        const [dx, dy] = [s / 2 + pitch * 0.82, s / 2 + pitch * 0.82];
        dots.push({ x: C[0] * dx + C[2] * dy + C[4], y: C[1] * dx + C[3] * dy + C[5], r: s * 0.07 });
      }
    }

    const lay = new Layers();
    const unitS = units.reduce((m, u) => Math.max(m, u.s), 0) || s;
    const k: FleuronInks = {
      stem: lay.stroke(ink, Math.max(0.1, unitS * (style === 2 ? 0.05 : 0.045)), 0),
      ink: lay.fill(ink, 1),
      accentStem: lay.stroke(acc, Math.max(0.1, unitS * (style === 2 ? 0.05 : 0.045)), 0),
      accent: lay.fill(acc, 1),
    };
    for (const u of units) drawFleuron(u.kind, k, u.M ?? place(u.x, u.y, u.a * DEG, u.s), u.accent);
    for (const d of dots) k.accent.circle(d.x, d.y, d.r);
    const out: Prim[] = lay.prims();
    return out;
  },
};
