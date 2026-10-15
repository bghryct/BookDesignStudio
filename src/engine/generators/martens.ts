/**
 * Karel Martens — overprinted letterpress monoprints.
 *
 * Martens inks found objects (Meccano strips, washers, type, numbering
 * stamps) and prints them pass after pass on the same sheet. Each pass is one
 * transparent ink; the passes never register perfectly, and the roller leaves
 * its texture — mottling, streaks, speckles of paper showing through.
 *
 * Here every ink is a separate pass: a multiply group, nudged by a seeded
 * misregistration. With texture 0 the pass stays pure vector (and asks the PDF
 * writer for real overprint); with texture > 0 the pass is rasterised so the
 * roller texture can bite into the ink's alpha.
 */
import type { OverprintElement, OverprintKind } from '../../model/types';
import type { FontRef, Matrix, Prim, TextRun } from '../../render/primitives';
import { IDENTITY, multiply, rectPath, rotate, translate } from '../../render/primitives';
import { mix } from '../../lib/color';
import { clamp, fbm, range, rng, valueNoise } from '../../lib/random';
import type { GenContext, Generator } from './context';
import { DEG, Pen, TAU, hashStr, place, rasterDensity, readParams, scratchCanvas, smoothstep } from './util';
import type { ParamSpec } from './util';

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

const DENSITY: ParamSpec = { key: 'density', label: 'Ink density', min: 0.4, max: 1, step: 0.01, default: 0.9 };
const WEIGHT: ParamSpec = { key: 'weight', label: 'Weight', min: 100, max: 900, step: 50, default: 700 };

export const OVERPRINT_PARAMS: Record<OverprintKind, ParamSpec[]> = {
  numerals: [
    { key: 'size', label: 'Numeral height (× box)', min: 0.2, max: 1.6, step: 0.01, default: 0.86 },
    { key: 'count', label: 'Figures per ink', min: 1, max: 6, step: 1, default: 1 },
    { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.01, default: 0.5 },
    WEIGHT, DENSITY,
  ],
  circles: [
    { key: 'cols', label: 'Columns', min: 1, max: 16, step: 1, default: 4 },
    { key: 'size', label: 'Diameter (× module)', min: 0.4, max: 2.2, step: 0.01, default: 0.9 },
    { key: 'shift', label: 'Shift between inks (modules)', min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: 'hole', label: 'Washer hole', min: 0, max: 0.85, step: 0.01, default: 0 },
    { key: 'missing', label: 'Missing pieces', min: 0, max: 0.6, step: 0.01, default: 0.1 },
    DENSITY,
  ],
  'squares-grid': [
    { key: 'cols', label: 'Columns', min: 1, max: 16, step: 1, default: 4 },
    { key: 'size', label: 'Square (× module)', min: 0.3, max: 1.6, step: 0.01, default: 0.7 },
    { key: 'shift', label: 'Shift between inks (modules)', min: 0, max: 1, step: 0.01, default: 0.42 },
    { key: 'rotation', label: 'Turn per ink °', min: 0, max: 45, step: 0.5, default: 0 },
    { key: 'hole', label: 'Meccano hole', min: 0, max: 0.8, step: 0.01, default: 0.34 },
    { key: 'missing', label: 'Missing pieces', min: 0, max: 0.6, step: 0.01, default: 0.06 },
    DENSITY,
  ],
  stripes: [
    { key: 'count', label: 'Stripes', min: 2, max: 60, step: 1, default: 9 },
    { key: 'duty', label: 'Bar width', min: 0.1, max: 0.9, step: 0.01, default: 0.5 },
    { key: 'angle', label: 'Angle between inks °', min: 0, max: 90, step: 0.5, default: 60 },
    { key: 'holes', label: 'Meccano holes', min: 0, max: 0.8, step: 0.01, default: 0 },
    DENSITY,
  ],
  letters: [
    { key: 'cols', label: 'Columns', min: 1, max: 12, step: 1, default: 2 },
    { key: 'size', label: 'Letter height (× cell)', min: 0.4, max: 2, step: 0.01, default: 1.2 },
    { key: 'shift', label: 'Shift between inks (cells)', min: 0, max: 1, step: 0.01, default: 0.42 },
    WEIGHT, DENSITY,
  ],
  counters: [
    { key: 'size', label: 'Letter height (× box)', min: 0.3, max: 1.6, step: 0.01, default: 0.92 },
    { key: 'scatter', label: 'Scatter', min: 0, max: 1, step: 0.01, default: 0.55 },
    { key: 'turn', label: 'Quarter turns', min: 0, max: 1, step: 1, default: 1 },
    DENSITY,
  ],
};

/* -------------------------------------------------------------------------- */
/* Ink shapes                                                                  */
/* -------------------------------------------------------------------------- */

type InkShape =
  | { k: 'path'; d: string; rule: 'nonzero' | 'evenodd' }
  | { k: 'text'; run: TextRun };

interface Pass { ink: string; shapes: InkShape[] }

const path = (d: string, rule: 'nonzero' | 'evenodd' = 'nonzero'): InkShape => ({ k: 'path', d, rule });

function capOf(ctx: GenContext, font: FontRef): number {
  const m = ctx.metrics(font);
  return m.capHeight > 0.2 && m.capHeight < 1.2 ? m.capHeight : 0.7;
}

/** Grid of square modules covering the box (with one spare ring for shifted inks). */
function moduleGrid(w: number, h: number, cols: number) {
  // Never more than ~600 modules per ink, however tall the sheet.
  const m = Math.max(w / Math.max(1, Math.round(cols)), Math.sqrt((w * h) / 600));
  const c = Math.max(1, Math.round(w / m));
  const r = Math.max(1, Math.round(h / m));
  const oy = (h - r * m) / 2;
  return { m, cols: c, rows: r, ox: (w - c * m) / 2, oy };
}

/** Per-ink shift direction: inks fan out around the clock. */
function shiftVec(k: number, n: number, amount: number): [number, number] {
  const a = Math.PI / 4 + (k * TAU) / Math.max(2, n);
  return k === 0 ? [0, 0] : [Math.cos(a) * amount, Math.sin(a) * amount];
}

/* -------------------------------------------------------------------------- */
/* Kinds                                                                       */
/* -------------------------------------------------------------------------- */

function numerals(el: OverprintElement, p: Record<string, number>, ctx: GenContext, r: () => number): Pass[] {
  const { w, h } = el;
  const digits = Array.from(el.text || '').filter((c) => /[0-9]/.test(c));
  const glyphs = digits.length ? digits : Array.from((el.text || '').replace(/\s+/g, ''));
  const pool = glyphs.length ? glyphs : Array.from('1234567890');
  const font = ctx.font(el.fontFamily, p.weight);
  const cap = capOf(ctx, font);
  const count = Math.round(p.count);
  return el.inks.map((ink, k) => {
    let text = '';
    for (let j = 0; j < count; j++) text += pool[(k * count + j) % pool.length];
    let size = (p.size * h) / cap;
    let adv = ctx.measure(text, font, size);
    if (adv > w * 1.15) {
      size *= (w * 1.15) / adv;
      adv = ctx.measure(text, font, size);
    }
    const capPt = cap * size;
    const cx = w / 2 + range(r, -1, 1) * p.scatter * w * 0.32;
    const cy = h / 2 + range(r, -1, 1) * p.scatter * h * 0.22;
    const run: TextRun = { x: cx - adv / 2, y: cy + capPt / 2, text, font, size, color: ink, width: adv };
    return { ink, shapes: [{ k: 'text', run }] };
  });
}

function circles(el: OverprintElement, p: Record<string, number>, r: () => number): Pass[] {
  const { w, h } = el;
  const g = moduleGrid(w, h, p.cols);
  const n = el.inks.length;
  return el.inks.map((ink, k) => {
    const [sx, sy] = shiftVec(k, n, p.shift * g.m);
    const pen = new Pen();
    const R = (p.size * g.m) / 2;
    for (let j = -1; j <= g.rows; j++) {
      for (let i = -1; i <= g.cols; i++) {
        if (r() < p.missing) continue;
        const cx = g.ox + (i + 0.5) * g.m + sx, cy = g.oy + (j + 0.5) * g.m + sy;
        if (cx + R < 0 || cy + R < 0 || cx - R > w || cy - R > h) continue;
        pen.circle(cx, cy, R);
        if (p.hole > 0.01) pen.circle(cx, cy, R * p.hole);
      }
    }
    return { ink, shapes: [path(pen.d, p.hole > 0.01 ? 'evenodd' : 'nonzero')] };
  });
}

function squaresGrid(el: OverprintElement, p: Record<string, number>, r: () => number): Pass[] {
  const { w, h } = el;
  const g = moduleGrid(w, h, p.cols);
  const n = el.inks.length;
  return el.inks.map((ink, k) => {
    const [sx, sy] = shiftVec(k, n, p.shift * g.m);
    const pen = new Pen();
    const s = p.size * g.m;
    const rot = k * p.rotation;
    for (let j = -1; j <= g.rows; j++) {
      for (let i = -1; i <= g.cols; i++) {
        if (r() < p.missing) continue;
        const cx = g.ox + (i + 0.5) * g.m + sx, cy = g.oy + (j + 0.5) * g.m + sy;
        if (cx + s < 0 || cy + s < 0 || cx - s > w || cy - s > h) continue;
        pen.with(place(cx, cy, rot * DEG), (q) => {
          q.rect(-s / 2, -s / 2, s, s);
          if (p.hole > 0.01) q.circle(0, 0, (s / 2) * p.hole);
        });
      }
    }
    return { ink, shapes: [path(pen.d, 'evenodd')] };
  });
}

function stripes(el: OverprintElement, p: Record<string, number>, r: () => number): Pass[] {
  const { w, h } = el;
  const D = Math.hypot(w, h);
  const pitch = Math.max(w, h) / p.count;
  const bw = pitch * p.duty;
  return el.inks.map((ink, k) => {
    const a = (k * p.angle + range(r, -1.2, 1.2)) * DEG;
    const phase = r() * pitch;
    const pen = new Pen(multiply(translate(w / 2, h / 2), rotate(a / DEG)));
    const n = Math.ceil(D / 2 / pitch) + 1;
    for (let i = -n; i <= n; i++) {
      const y = i * pitch + phase - bw / 2;
      pen.rect(-D / 2, y, D, bw);
      if (p.holes > 0.01) {
        const hr = (bw / 2) * p.holes;
        const step = Math.max(bw * 1.6, (D * (2 * n + 1)) / 1200);
        for (let x = -D / 2 + step / 2 + (i % 2) * step * 0.5; x < D / 2; x += step) pen.circle(x, y + bw / 2, hr);
      }
    }
    return { ink, shapes: [path(pen.d, 'evenodd')] };
  });
}

function letters(el: OverprintElement, p: Record<string, number>, ctx: GenContext): Pass[] {
  const { w, h } = el;
  const pool = Array.from((el.text || '').replace(/\s+/g, '')).filter(Boolean);
  const glyphs = pool.length ? pool : Array.from('MARTENS');
  const font = ctx.font(el.fontFamily, p.weight);
  const cap = capOf(ctx, font);
  // At most ~120 letters per ink.
  const unit = Math.max(w / Math.max(1, Math.round(p.cols)), Math.sqrt((w * h) / 120));
  const cols = Math.max(1, Math.round(w / unit));
  const rows = Math.max(1, Math.round(h / unit));
  const cw = w / cols, ch = h / rows;
  const n = el.inks.length;
  return el.inks.map((ink, k) => {
    const [sx, sy] = shiftVec(k, n, p.shift * Math.min(cw, ch));
    const shapes: InkShape[] = [];
    let idx = k * 3;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const c = glyphs[idx++ % glyphs.length];
        const size = (p.size * Math.min(cw, ch) * 0.8) / cap;
        const adv = ctx.measure(c, font, size);
        const cx = (i + 0.5) * cw + sx, cy = (j + 0.5) * ch + sy;
        shapes.push({ k: 'text', run: { x: cx - adv / 2, y: cy + (cap * size) / 2, text: c, font, size, color: ink, width: adv } });
      }
    }
    return { ink, shapes };
  });
}

/* Counter forms, in a unit body box x ∈ [0,1], y ∈ [0,1.25]. Holes are drawn even-odd inside the body. */
type CounterDef = { body: 'rect' | 'round' | 'd'; holes: (p: Pen) => void };

const slot = (x0: number, y0: number, x1: number, y1: number) => (p: Pen) => p.rect(x0, y0, x1 - x0, y1 - y0);
const oval = (cx: number, cy: number, rx: number, ry: number) => (p: Pen) => p.ellipse(cx, cy, rx, ry);
const many = (...fs: ((p: Pen) => void)[]) => (p: Pen) => fs.forEach((f) => f(p));
const dHole = (x0: number, y0: number, x1: number, y1: number) => (p: Pen) => {
  const r = (y1 - y0) / 2;
  const k = r * 0.5523;
  p.move(x0, y0).line(x1 - r, y0).curve(x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r)
    .curve(x1, y0 + r + k, x1 - r + k, y1, x1 - r, y1).line(x0, y1).close();
};

const COUNTERS: Record<string, CounterDef> = {
  O: { body: 'round', holes: oval(0.5, 0.625, 0.25, 0.4) },
  Q: { body: 'round', holes: oval(0.5, 0.6, 0.24, 0.37) },
  D: { body: 'd', holes: dHole(0.3, 0.24, 0.74, 1.01) },
  A: { body: 'rect', holes: many((p) => p.poly([[0.5, 0.22], [0.68, 0.7], [0.32, 0.7]], true), slot(0.34, 0.92, 0.66, 1.25)) },
  B: { body: 'd', holes: many(dHole(0.3, 0.2, 0.68, 0.52), dHole(0.3, 0.72, 0.72, 1.05)) },
  P: { body: 'rect', holes: many(dHole(0.3, 0.2, 0.7, 0.58), slot(0.34, 0.8, 1, 1.25)) },
  R: { body: 'rect', holes: many(dHole(0.3, 0.2, 0.7, 0.56), (p) => p.poly([[0.36, 0.8], [0.62, 0.8], [0.8, 1.25], [0.36, 1.25]], true)) },
  E: { body: 'rect', holes: many(slot(0.36, 0.24, 1, 0.5), slot(0.36, 0.75, 1, 1.01)) },
  F: { body: 'rect', holes: many(slot(0.36, 0.24, 1, 0.5), slot(0.36, 0.75, 1, 1.25)) },
  H: { body: 'rect', holes: many(slot(0.32, 0, 0.68, 0.5), slot(0.32, 0.75, 0.68, 1.25)) },
  U: { body: 'rect', holes: (p) => p.move(0.3, 0).line(0.7, 0).line(0.7, 0.75).curve(0.7, 0.88, 0.61, 0.97, 0.5, 0.97).curve(0.39, 0.97, 0.3, 0.88, 0.3, 0.75).close() },
  N: { body: 'rect', holes: many((p) => p.poly([[0.3, 0.42], [0.3, 1.25], [0.66, 1.25]], true), (p) => p.poly([[0.7, 0], [0.7, 0.83], [0.34, 0]], true)) },
  M: { body: 'rect', holes: many((p) => p.poly([[0.24, 0.4], [0.24, 1.25], [0.44, 1.25], [0.44, 0.9]], true), (p) => p.poly([[0.76, 0.4], [0.76, 1.25], [0.56, 1.25], [0.56, 0.9]], true), (p) => p.poly([[0.32, 0], [0.68, 0], [0.5, 0.5]], true)) },
  T: { body: 'rect', holes: many(slot(0, 0.3, 0.34, 1.25), slot(0.66, 0.3, 1, 1.25)) },
  L: { body: 'rect', holes: slot(0.36, 0, 1, 0.95) },
  V: { body: 'rect', holes: many((p) => p.poly([[0.28, 0], [0.72, 0], [0.5, 0.82]], true), (p) => p.poly([[0, 0.5], [0, 1.25], [0.38, 1.25]], true), (p) => p.poly([[1, 0.5], [1, 1.25], [0.62, 1.25]], true)) },
  X: { body: 'rect', holes: many((p) => p.poly([[0.3, 0], [0.7, 0], [0.5, 0.45]], true), (p) => p.poly([[0.3, 1.25], [0.7, 1.25], [0.5, 0.8]], true)) },
  S: { body: 'round', holes: many(slot(0.36, 0.3, 0.92, 0.52), slot(0.08, 0.73, 0.64, 0.95)) },
  Z: { body: 'rect', holes: many((p) => p.poly([[0, 0.28], [0.56, 0.28], [0, 0.95]], true), (p) => p.poly([[1, 0.3], [1, 0.97], [0.44, 0.97]], true)) },
  C: { body: 'round', holes: (p) => p.move(1, 0.42).line(0.7, 0.42).curve(0.64, 0.3, 0.58, 0.24, 0.5, 0.24).curve(0.36, 0.24, 0.26, 0.42, 0.26, 0.625).curve(0.26, 0.83, 0.36, 1.01, 0.5, 1.01).curve(0.58, 1.01, 0.64, 0.95, 0.7, 0.83).line(1, 0.83).close() },
  e: { body: 'round', holes: many((p) => p.move(0.24, 0.56).curve(0.24, 0.36, 0.36, 0.24, 0.5, 0.24).curve(0.64, 0.24, 0.76, 0.36, 0.76, 0.56).close(), slot(0.62, 0.76, 1, 0.88)) },
  a: { body: 'round', holes: oval(0.46, 0.8, 0.2, 0.18) },
  g: { body: 'round', holes: many(oval(0.5, 0.42, 0.2, 0.2), slot(0.3, 0.8, 0.72, 0.98)) },
  '0': { body: 'round', holes: oval(0.5, 0.625, 0.22, 0.43) },
  '4': { body: 'rect', holes: many((p) => p.poly([[0.56, 0.24], [0.56, 0.74], [0.24, 0.74]], true), slot(0, 0.95, 0.5, 1.25)) },
  '6': { body: 'round', holes: many(oval(0.5, 0.82, 0.21, 0.18), slot(0.5, 0.18, 1, 0.42)) },
  '8': { body: 'round', holes: many(oval(0.5, 0.36, 0.19, 0.15), oval(0.5, 0.86, 0.23, 0.18)) },
  '9': { body: 'round', holes: many(oval(0.5, 0.43, 0.21, 0.18), slot(0, 0.83, 0.5, 1.07)) },
  '7': { body: 'rect', holes: (p) => p.poly([[0, 0.3], [0.6, 0.3], [0.32, 1.25], [0, 1.25]], true) },
  '1': { body: 'rect', holes: many(slot(0, 0.32, 0.32, 1.25), slot(0.68, 0, 1, 1.25)) },
  '2': { body: 'round', holes: many(slot(0, 0.3, 0.62, 0.5), slot(0.38, 0.72, 1, 1.0)) },
  '3': { body: 'round', holes: many(slot(0, 0.28, 0.62, 0.5), slot(0, 0.74, 0.62, 0.97)) },
  '5': { body: 'rect', holes: many(slot(0.36, 0.24, 1, 0.48), slot(0, 0.72, 0.62, 0.98)) },
};
const ALIASES: Record<string, string> = {
  o: 'O', q: 'Q', d: 'D', b: 'B', p: 'P', r: 'R', h: 'H', n: 'N', m: 'M', u: 'U', t: 'T', l: 'L', v: 'V', w: 'M', W: 'M', x: 'X',
  s: 'S', z: 'Z', c: 'C', f: 'F', k: 'H', K: 'H', y: 'V', Y: 'V', i: '1', I: '1', j: 'L', J: 'U', G: 'C',
};

function counterOf(ch: string): CounterDef {
  return COUNTERS[ch] ?? COUNTERS[ALIASES[ch] ?? ''] ?? COUNTERS[ch.toUpperCase()] ?? COUNTERS.O;
}

/** Enlarged counter-forms: letter bodies punched with their counters, like big rubber stamps. */
function counters(el: OverprintElement, p: Record<string, number>, r: () => number): Pass[] {
  const { w, h } = el;
  const pool = Array.from((el.text || '').replace(/\s+/g, ''));
  const glyphs = pool.length ? pool : Array.from('aeg0');
  return el.inks.map((ink, k) => {
    const def = counterOf(glyphs[k % glyphs.length]);
    const H = p.size * h;
    const S = H / 1.25;
    const turn = p.turn ? Math.floor(r() * 4) * 90 : 0;
    const cx = w / 2 + range(r, -1, 1) * p.scatter * w * 0.3;
    const cy = h / 2 + range(r, -1, 1) * p.scatter * h * 0.25;
    const M: Matrix = multiply(place(cx, cy, turn * DEG, S), translate(-0.5, -0.625));
    const pen = new Pen(M);
    if (def.body === 'round') pen.ellipse(0.5, 0.625, 0.5, 0.625);
    else if (def.body === 'd') pen.move(0, 0).line(0.45, 0).curve(0.8, 0, 1, 0.3, 1, 0.625).curve(1, 0.95, 0.8, 1.25, 0.45, 1.25).line(0, 1.25).close();
    else pen.rect(0, 0, 1, 1.25);
    def.holes(pen);
    return { ink, shapes: [path(pen.d, 'evenodd')] };
  });
}

/* -------------------------------------------------------------------------- */
/* Roller texture                                                              */
/* -------------------------------------------------------------------------- */

/** Ink coverage 0–1 at a point (pt): broad mottling, streaks along the roll, paper-tooth voids, a starved side. */
function rollerTexture(seed: number, amount: number, w: number, h: number): (x: number, y: number) => number {
  const r = rng(seed);
  const across = r() < 0.5;
  const starveA = r() * TAU;
  const sx = Math.cos(starveA), sy = Math.sin(starveA);
  const s1 = (seed * 7 + 11) | 0, s2 = (seed * 7 + 23) | 0, s3 = (seed * 7 + 37) | 0, s4 = (seed * 7 + 51) | 0;
  const T = clamp(amount, 0, 1);
  return (x: number, y: number) => {
    const along = across ? x : y, perp = across ? y : x;
    const mottle = fbm(x / 34, y / 34, 3, s1);
    const streak = valueNoise(along / 150, perp / 1.7, s2) * 0.7 + valueNoise(along / 60, perp / 0.9, s4) * 0.3;
    const tooth = valueNoise(x / 0.8, y / 0.8, s3);
    const starve = ((x / w - 0.5) * sx + (y / h - 0.5) * sy) + 0.5;
    let c = 1;
    c -= T * 0.6 * smoothstep(0.42, 0.78, 1 - mottle);
    c -= T * 0.5 * smoothstep(0.5, 0.85, streak);
    c -= T * 1.1 * smoothstep(0.6, 0.86, tooth) * (0.6 + 0.4 * (1 - mottle));
    c -= T * 0.35 * smoothstep(0.55, 1.1, starve);
    return clamp(c, 0, 1);
  };
}

/** A textured pass, painted into a scratch canvas and composited (multiply) by the host. */
function rasterPass(el: OverprintElement, pass: Pass, M: Matrix, k: number, density: number): Prim {
  const { w, h } = el;
  const seed = (el.seed * 131 + k * 977) | 0;
  const sig = pass.shapes.map((s) => (s.k === 'path' ? s.d.length + s.d.slice(0, 64) + s.d.slice(-64) : `${s.run.text}${s.run.x}${s.run.y}${s.run.size}${s.run.font.css}${s.run.font.weight}`)).join('|');
  const key = `martens:${hashStr(`${sig}|${M.join(',')}|${pass.ink}|${el.texture}|${seed}|${w}x${h}`)}`;
  const coverage = rollerTexture(seed, el.texture, w, h);
  return {
    t: 'raster', key, x: 0, y: 0, w, h, blend: 'multiply', opacity: density,
    draw: (target, pxPerPt) => {
      const ppp = rasterDensity(w, h, pxPerPt, 12e6);
      const W = Math.max(1, Math.ceil(w * ppp)), H = Math.max(1, Math.ceil(h * ppp));
      const sc = scratchCanvas(W, H);
      if (!sc) return;
      const o = sc.ctx;
      o.setTransform(W / w, 0, 0, H / h, 0, 0);
      o.transform(M[0], M[1], M[2], M[3], M[4], M[5]);
      o.fillStyle = pass.ink;
      for (const s of pass.shapes) {
        if (s.k === 'path') o.fill(new Path2D(s.d), s.rule);
        else {
          const run = s.run;
          o.save();
          o.font = `${run.font.italic ? 'italic ' : ''}${run.font.weight} ${run.size}px ${run.font.css}`;
          o.textBaseline = 'alphabetic';
          if (run.rotate) {
            o.translate(run.x, run.y);
            o.rotate(run.rotate * DEG);
            o.fillText(run.text, 0, 0);
          } else o.fillText(run.text, run.x, run.y);
          o.restore();
        }
      }
      const img = o.getImageData(0, 0, W, H);
      const data = img.data;
      const sx = w / W, sy = h / H;
      for (let j = 0; j < H; j++) {
        const y = (j + 0.5) * sy;
        for (let i = 0; i < W; i++) {
          const a = (j * W + i) * 4 + 3;
          if (data[a] === 0) continue;
          data[a] = Math.round(data[a] * coverage((i + 0.5) * sx, y));
        }
      }
      o.putImageData(img, 0, 0);
      target.drawImage(sc.canvas, 0, 0, w, h);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

export const generateOverprint: Generator<OverprintElement> = (el, ctx) => {
  const { w, h } = el;
  if (!(w > 0 && h > 0) || !el.inks.length) return [];
  const p = readParams(OVERPRINT_PARAMS[el.kind] ?? OVERPRINT_PARAMS.numerals, el.params);
  const r = rng(el.seed);
  const inks = el.inks.map((c) => mix(c, c, 0));
  const local: OverprintElement = { ...el, inks };
  let passes: Pass[];
  switch (el.kind) {
    case 'circles': passes = circles(local, p, r); break;
    case 'squares-grid': passes = squaresGrid(local, p, r); break;
    case 'stripes': passes = stripes(local, p, r); break;
    case 'letters': passes = letters(local, p, ctx); break;
    case 'counters': passes = counters(local, p, r); break;
    default: passes = numerals(local, p, ctx, r);
  }
  const mr = rng(el.seed * 31 + 7);
  const out: Prim[] = passes.map((pass, k) => {
    // Misregistration: a seeded nudge plus a hair of rotation about the sheet centre.
    const dx = k === 0 ? 0 : range(mr, -1, 1) * el.misregister;
    const dy = k === 0 ? 0 : range(mr, -1, 1) * el.misregister;
    const rot = k === 0 ? 0 : range(mr, -1, 1) * el.misregister * 0.1;
    const M: Matrix = rot || dx || dy ? multiply(translate(dx, dy), rotate(rot, w / 2, h / 2)) : IDENTITY;
    if (el.texture > 0.001) return rasterPass(local, pass, M, k, p.density);
    const children: Prim[] = pass.shapes.map((s): Prim => s.k === 'path'
      ? { t: 'path', d: s.d, fill: pass.ink, fillRule: s.rule, overprint: el.pdfOverprint }
      : { t: 'text', runs: [s.run] });
    return { t: 'group', blend: 'multiply', opacity: p.density, matrix: M, children };
  });
  return [{ t: 'group', clip: rectPath(0, 0, w, h), children: out }];
};
