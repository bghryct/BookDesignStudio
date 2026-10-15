/**
 * Typographic specimens and charts: Bringhurst’s scale and page proportions, Unger’s
 * waterfall, Hochuli’s spacing lesson, Caflisch’s classification and letter anatomy.
 */
import type { MotifElement } from '../../model/types';
import type { FontRef, Prim, TextRun } from '../../render/primitives';
import { Pen } from '../generators/util';
import type { MotifContext, MotifDef } from './types';
import { motifColor } from './types';
import {
  FINE, GREY, HAIR, INK, ONOFF, RED, RULE, bisect, choice, clamp, fill, fitLabel, fmtNum, generator,
  labelFonts, labelSize, opticalFont, run, safeMetrics, stroke, textPrim, textWidth, truncate, truncateWords, vrun, wrapText,
  type Params,
} from './diagrams-kit';

const PHI = (1 + Math.sqrt(5)) / 2;

/** The classical typographic scale (Bringhurst §3.1.1). */
export const TYPE_SCALE = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 21, 24, 36, 48, 60, 72];
const SCALE_OPTIONS = TYPE_SCALE.map((s) => `${s} pt`);

/** Letters and marks that reach below the baseline in most romans and italics. */
const DESCENDERS = /[gjpqyQJ(),;[\]{}|_\/@ßþçƒ]/;

/** The element text as one line, or a fallback. */
function oneLine(el: MotifElement, fallback: string): string {
  const t = (el.text || '').replace(/\s+/g, ' ').trim();
  return t || fallback;
}

/**
 * Split a sequence into `c` contiguous groups with the smallest possible largest sum
 * (the linear-partition problem) — balanced columns for a waterfall.
 */
function balance(weights: number[], c: number): number[][] {
  const n = weights.length;
  const k = Math.max(1, Math.min(c, n));
  const pre = [0];
  for (const w of weights) pre.push(pre[pre.length - 1] + w);
  // cost[j][i]: best max-sum for the first i items in j groups; cut[j][i]: start of the last group.
  const cost = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(0));
  cost[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let t = j - 1; t < i; t++) {
        const v = Math.max(cost[j - 1][t], pre[i] - pre[t]);
        if (v < cost[j][i]) { cost[j][i] = v; cut[j][i] = t; }
      }
    }
  }
  const groups: number[][] = [];
  let i = n;
  for (let j = k; j >= 1; j--) {
    const t = cut[j][i];
    groups.unshift(Array.from({ length: i - t }, (_, q) => t + q));
    i = t;
  }
  return groups.filter((g) => g.length);
}

/* -------------------------------------------------------------------------- */
/* 5. Typographic scale — Bringhurst                                           */
/* -------------------------------------------------------------------------- */

function drawTypeScale(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cType = motifColor(def, el, 0), cLab = motifColor(def, el, 1), cBase = motifColor(def, el, 2);
  const i0 = choice(Math.min(p.from, p.to), 0, TYPE_SCALE.length - 1);
  const i1 = choice(Math.max(p.from, p.to), 0, TYPE_SCALE.length - 1);
  const sizes = TYPE_SCALE.slice(i0, i1 + 1);
  const base = ctx.font(el.fontFamily, 400);
  const fonts = sizes.map((s) => opticalFont(base, s));
  const text = oneLine(el, 'Aa');
  const adv = sizes.map((s, i) => textWidth(ctx, text, fonts[i], s));
  const { asc, desc: fontDesc } = safeMetrics(ctx, base);
  // Reserve the descender only when the sample has descending letters.
  const desc = DESCENDERS.test(text) ? fontDesc : Math.min(fontDesc, 0.06);
  const { mono } = labelFonts(ctx);
  const pad = Math.min(3, w * 0.02, h * 0.02);
  const W = w - 2 * pad, H = h - 2 * pad;
  const maxS = sizes[sizes.length - 1];
  const out: Prim[] = [];

  if (choice(p.layout, 0, 1) === 0) {
    // Common baseline: the scale reads as one rising line, like a set of organ pipes.
    let lab = labelSize(w, h, 6, 60);
    let k = 0;
    let slot: (i: number, k: number) => number = () => 0;
    let gap: (s: number, k: number) => number = () => 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const labW = sizes.map((s) => textWidth(ctx, String(s), mono, lab));
      slot = (i, kk) => Math.max(kk * adv[i], labW[i]);
      gap = (s, kk) => Math.max(lab ? 2.5 : 1, 0.26 * kk * s);
      const width = (kk: number) => sizes.reduce((a, s, i) => a + slot(i, kk) + (i ? gap(s, kk) : 0), 0);
      const height = (kk: number) => (asc + desc) * kk * maxS + (lab ? lab * 1.5 + 2 : 0);
      k = bisect((kk) => width(kk) <= W && height(kk) <= H);
      if (k * maxS >= 2 || !lab) break;
      lab = 0;
    }
    if (!(k > 0)) return [];
    const bw = sizes.reduce((a, s, i) => a + slot(i, k) + (i ? gap(s, k) : 0), 0);
    const bh = (asc + desc) * k * maxS + (lab ? lab * 1.5 + 2 : 0);
    const x0 = pad + (W - bw) / 2;
    const yb = pad + (H - bh) / 2 + asc * k * maxS;
    out.push(...stroke(new Pen().move(x0, yb).line(x0 + bw, yb), cBase, HAIR));
    const samples: TextRun[] = [], labels: TextRun[] = [];
    let x = x0;
    sizes.forEach((s, i) => {
      if (i) x += gap(s, k);
      const sw = slot(i, k);
      samples.push(run(ctx, text, fonts[i], k * s, x + sw / 2, yb, cType, 'center'));
      if (lab) labels.push(run(ctx, String(s), mono, lab, x + sw / 2, yb + desc * k * maxS + lab * 1.25 + 1, cLab, 'center'));
      x += sw;
    });
    out.push(...textPrim(samples), ...textPrim(labels));
    if (lab && Math.abs(k - 1) > 0.01) {
      out.push(...textPrim([run(ctx, `shown at ${Math.round(k * 100)} %`, mono, lab * 0.9, x0, pad + lab, cLab)], 0.8));
    }
    return out;
  }

  // Columns: a waterfall of lines, wrapped into as many columns as make it largest.
  const lab = labelSize(w, h, 6, 60);
  const labCol = lab ? textWidth(ctx, '72', mono, lab) + lab * 1.1 : 0;
  const colGap = Math.min(14, W * 0.04);
  const pitch = (s: number, k: number) => Math.max(lab * 1.3, (asc + desc) * k * s * 1.06);
  const n = sizes.length;
  let best: { k: number; groups: number[][] } = { k: 0, groups: [] };
  for (let c = 1; c <= n; c++) {
    const groups = balance(sizes.map((s) => Math.max(lab * 1.3, (asc + desc) * s * 1.06)), c);
    const width = (k: number) => groups.reduce((a, g, gi) => a + labCol + Math.max(...g.map((i) => k * adv[i])) + (gi ? colGap : 0), 0);
    const height = (k: number) => Math.max(...groups.map((g) => g.reduce((a, i) => a + pitch(sizes[i], k), 0)));
    const k = bisect((kk) => width(kk) <= W && height(kk) <= H);
    if (k > best.k * 1.03) best = { k, groups };
  }
  const { k, groups } = best;
  if (!(k > 0) || !groups.length) return [];
  const colW = groups.map((g) => labCol + Math.max(...g.map((i) => k * adv[i])));
  const totalW = colW.reduce((a, c) => a + c, 0) + colGap * (groups.length - 1);
  const totalH = Math.max(...groups.map((g) => g.reduce((a, i) => a + pitch(sizes[i], k), 0)));
  let x = pad + (W - totalW) / 2;
  const samples: TextRun[] = [], labels: TextRun[] = [];
  const rules = new Pen();
  groups.forEach((g, gi) => {
    let y = pad + (H - totalH) / 2;
    for (const i of g) {
      const s = sizes[i], ph = pitch(s, k);
      const yb = y + (ph - (asc + desc) * k * s) / 2 + asc * k * s;
      samples.push(run(ctx, text, fonts[i], k * s, x + labCol, yb, cType));
      if (lab) labels.push(run(ctx, String(s), mono, lab, x + labCol - lab * 0.7, yb, cLab, 'right'));
      rules.move(x + labCol, yb).line(x + colW[gi], yb);
      y += ph;
    }
    x += colW[gi] + colGap;
  });
  out.push(...stroke(rules, cBase, FINE, { opacity: 0.8 }), ...textPrim(samples), ...textPrim(labels));
  return out;
}

export const typeScale: MotifDef = {
  kind: 'type-scale',
  label: 'Typographic scale',
  designer: 'bringhurst',
  description: 'The classical scale of type sizes — 6 to 72 pt, “the typographic scale” of Bringhurst’s Elements §3.1 — set on a common baseline or as a waterfall, so students see the old founders’ intervals rather than arbitrary sizes.',
  defaultSize: { w: 440, h: 130 },
  colors: [
    { label: 'Type', default: INK },
    { label: 'Size labels', default: GREY },
    { label: 'Baseline', default: RED },
  ],
  params: [
    { key: 'from', label: 'From', min: 0, max: 15, step: 1, default: 0, options: SCALE_OPTIONS },
    { key: 'to', label: 'To', min: 0, max: 15, step: 1, default: 15, options: SCALE_OPTIONS },
    { key: 'layout', label: 'Layout', min: 0, max: 1, step: 1, default: 0, options: ['Common baseline', 'Columns'] },
  ],
  text: { label: 'Sample', default: 'Aa' },
  fontFamily: 'eb-garamond',
  generate: generator(() => typeScale, drawTypeScale),
};

/* -------------------------------------------------------------------------- */
/* 6. Page proportions — Bringhurst                                            */
/* -------------------------------------------------------------------------- */

const PROPORTIONS: { r: number; ratio: string; name: string }[] = [
  { r: 1, ratio: '1 : 1', name: 'unison' },
  { r: 6 / 5, ratio: '5 : 6', name: 'minor third' },
  { r: 5 / 4, ratio: '4 : 5', name: 'major third' },
  { r: 4 / 3, ratio: '3 : 4', name: 'fourth' },
  { r: Math.SQRT2, ratio: '1 : √2', name: 'ISO / DIN' },
  { r: 3 / 2, ratio: '2 : 3', name: 'fifth' },
  { r: 8 / 5, ratio: '5 : 8', name: 'minor sixth' },
  { r: PHI, ratio: '1 : φ', name: 'golden section' },
  { r: 5 / 3, ratio: '3 : 5', name: 'major sixth' },
  { r: Math.sqrt(3), ratio: '1 : √3', name: 'hexagon' },
  { r: 2, ratio: '1 : 2', name: 'octave' },
];

/**
 * A ratio such as `1 : √2` or `1 : φ`. No bundled face has φ (and Inter lacks √), so these
 * two signs are drawn as strokes beside the measured runs and the label stays vector.
 */
const MATH = /(√|φ)/;
const MATH_W: Record<string, number> = { '√': 0.56, 'φ': 0.6 };

function mathWidth(ctx: MotifContext, text: string, font: FontRef, size: number): number {
  return text.split(MATH).filter(Boolean).reduce((a, t) => a + (MATH_W[t] != null ? MATH_W[t] * size : textWidth(ctx, t, font, size)), 0);
}

function mathRuns(ctx: MotifContext, text: string, font: FontRef, size: number, x: number, y: number, color: string, pen: Pen): TextRun[] {
  const runs: TextRun[] = [];
  let cx = x;
  for (const t of text.split(MATH).filter(Boolean)) {
    if (t === '√') {
      pen.move(cx + 0.05 * size, y - 0.3 * size).line(cx + 0.14 * size, y - 0.36 * size)
        .line(cx + 0.27 * size, y - 0.02 * size).line(cx + 0.52 * size, y - 0.76 * size);
    } else if (t === 'φ') {
      const mx = cx + 0.3 * size;
      pen.ellipse(mx, y - 0.28 * size, 0.23 * size, 0.27 * size);
      pen.move(mx, y - 0.76 * size).line(mx, y + 0.22 * size);
    } else {
      runs.push(run(ctx, t, font, size, cx, y, color));
    }
    cx += MATH_W[t] != null ? MATH_W[t] * size : textWidth(ctx, t, font, size);
  }
  return runs;
}

function drawProportions(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cLine = motifColor(def, el, 0), cFill = motifColor(def, el, 1), cHi = motifColor(def, el, 2);
  const n = PROPORTIONS.length;
  const c = choice(p.columns, 1, n);
  const rows = Math.ceil(n / c);
  const pad = Math.min(2, w * 0.01, h * 0.01);
  const cw = (w - 2 * pad) / c, ch = (h - 2 * pad) / rows;
  let lab = p.labels >= 0.5 ? Math.min(labelSize(w, h, 6.5, 90), cw / 6.5, ch / 4.2) : 0;
  if (lab < 3) lab = 0;
  const band = lab ? lab * 2.55 + 3 : 0;
  const gx = Math.min(cw * 0.2, 12), gy = Math.min(ch * 0.12, 8);
  const RH = Math.max(0, Math.min(ch - band - gy, cw - gx));
  if (!(RH > 0.5)) return [];

  const W = ctx.book.trimW > 0 ? ctx.book.trimW : 1, H = ctx.book.trimH > 0 ? ctx.book.trimH : 1;
  const bookR = Math.max(W, H) / Math.min(W, H);
  let bookIdx = 0;
  PROPORTIONS.forEach((q, i) => {
    if (Math.abs(Math.log(q.r / bookR)) < Math.abs(Math.log(PROPORTIONS[bookIdx].r / bookR))) bookIdx = i;
  });
  const hl = p.highlight >= 0 ? choice(p.highlight, 0, n - 1) : bookIdx;

  const plain = new Pen(), lit = new Pen(), book = new Pen();
  const signsPen = new Pen(), litSigns = new Pen();
  const { sans, bold } = labelFonts(ctx);
  const runs: TextRun[] = [];
  PROPORTIONS.forEach((q, i) => {
    const row = Math.floor(i / c), col = i % c;
    const inRow = row === rows - 1 ? n - row * c : c;
    const cx = pad + (col + 0.5) * cw + ((c - inRow) * cw) / 2;
    const top = pad + row * ch + (ch - RH - band) / 2;
    const rw = RH / q.r;
    (i === hl ? lit : plain).rect(cx - rw / 2, top, rw, RH);
    if (i === bookIdx) {
      const bw = RH / bookR;
      book.rect(cx - bw / 2, top, bw, RH);
    }
    if (lab) {
      const color = i === hl ? cHi : cLine;
      const y1 = top + RH + lab * 1.2 + 1;
      const dec = q.r.toFixed(3);
      const signs = i === hl ? litSigns : signsPen;
      const wr = mathWidth(ctx, q.ratio, bold, lab), wd = textWidth(ctx, dec, sans, lab), sp = lab * 0.55;
      if (wr + sp + wd <= cw - 2) {
        // Ratio in bold, its decimal value beside it in regular weight.
        const x = cx - (wr + sp + wd) / 2;
        runs.push(...mathRuns(ctx, q.ratio, bold, lab, x, y1, color, signs), run(ctx, dec, sans, lab, x + wr + sp, y1, color));
      } else if (wr <= cw - 2) {
        runs.push(...mathRuns(ctx, q.ratio, bold, lab, cx - wr / 2, y1, color, signs));
      }
      const l2 = fitLabel(ctx, i === bookIdx ? `${q.name} · this book` : q.name, sans, lab * 0.9, cw - 2);
      if (l2) runs.push(run(ctx, l2, sans, lab * 0.9, cx, top + RH + lab * 2.3 + 1, color, 'center'));
    }
  });
  return [
    ...fill(plain, cFill),
    ...fill(lit, cHi, 0.2),
    ...stroke(plain, cLine, RULE),
    ...stroke(lit, cHi, 0.9),
    ...stroke(book, cHi, 0.6, { dash: [2, 1.5] }),
    ...textPrim(runs),
    ...stroke(signsPen, cLine, lab * 0.085, { cap: 'round', join: 'round' }),
    ...stroke(litSigns, cHi, lab * 0.085, { cap: 'round', join: 'round' }),
  ];
}

export const proportionChart: MotifDef = {
  kind: 'proportion-chart',
  label: 'Page proportions',
  designer: 'bringhurst',
  description: 'The page shapes of Bringhurst’s Elements §8.1 — from the square to the octave, with ISO’s √2, the golden section and the musical intervals — with the shape of this book marked, so a format can be chosen as deliberately as a scale in music.',
  defaultSize: { w: 420, h: 240 },
  colors: [
    { label: 'Outline', default: INK },
    { label: 'Fill', default: '#ebe4d6' },
    { label: 'Highlight', default: RED },
  ],
  params: [
    { key: 'columns', label: 'Columns', min: 1, max: 11, step: 1, default: 6 },
    { key: 'labels', label: 'Labels', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    {
      key: 'highlight', label: 'Highlight', min: -1, max: 10, step: 1, default: -1,
      options: ['Closest to this book', ...PROPORTIONS.map((q) => `${q.ratio} ${q.name}`)],
    },
  ],
  generate: generator(() => proportionChart, drawProportions),
};

/* -------------------------------------------------------------------------- */
/* 8. Waterfall — Unger                                                        */
/* -------------------------------------------------------------------------- */

function drawWaterfall(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cType = motifColor(def, el, 0), cLab = motifColor(def, el, 1);
  const lo = Math.max(1, Math.min(p.min, p.max)), hi = Math.max(lo, Math.max(p.min, p.max));
  let sizes: number[];
  if (p.classical >= 0.5) {
    sizes = TYPE_SCALE.filter((s) => s >= lo - 1e-6 && s <= hi + 1e-6);
    if (!sizes.length) sizes = [lo];
  } else {
    // Geometric steps: equal ratios read as equal increments to the eye.
    const n = choice(p.steps, 2, 24);
    sizes = [...new Set(Array.from({ length: n }, (_, i) => Math.round(2 * lo * Math.pow(hi / lo, i / (n - 1))) / 2))];
  }
  const text = oneLine(el, 'Reading is a kind of seeing — Hamburgefonstiv 1234567890');
  const base = ctx.font(el.fontFamily, 400);
  const { asc, desc } = safeMetrics(ctx, base);
  const { mono } = labelFonts(ctx);
  const lab = labelSize(w, h, 6, 80);
  const labels = sizes.map((s) => `${fmtNum(s, 1)} pt`);
  const labCol = lab && w > 100 ? Math.max(...labels.map((l) => textWidth(ctx, l, mono, lab))) + lab * 1.5 : 0;
  const maxW = w - labCol;
  const lines: TextRun[] = [], marks: TextRun[] = [];
  let y = 0;
  sizes.forEach((s, i) => {
    const yb = y + asc * s;
    if (yb + desc * s > h + 0.01) return;
    const f = opticalFont(base, s);
    const t = truncateWords(ctx, text, f, s, maxW);
    if (t) lines.push(run(ctx, t, f, s, labCol, yb, cType));
    if (labCol) marks.push(run(ctx, labels[i], mono, lab, labCol - lab * 1.1, yb, cLab, 'right'));
    y = yb + desc * s + Math.max(1.5, s * 0.22);
  });
  return [...textPrim(lines), ...textPrim(marks)];
}

export const waterfall: MotifDef = {
  kind: 'waterfall',
  label: 'Waterfall',
  designer: 'unger',
  description: 'A specimen waterfall: one line set at rising sizes, each labelled, in the tradition of the foundry specimen — and of Gerard Unger’s “While You’re Reading”, which asks how size, optical size and rhythm change what the reader sees.',
  defaultSize: { w: 400, h: 340 },
  colors: [
    { label: 'Type', default: INK },
    { label: 'Size labels', default: GREY },
  ],
  params: [
    { key: 'min', label: 'Smallest (pt)', min: 4, max: 72, step: 0.5, default: 6 },
    { key: 'max', label: 'Largest (pt)', min: 6, max: 144, step: 0.5, default: 48 },
    { key: 'steps', label: 'Steps', min: 2, max: 24, step: 1, default: 9 },
    { key: 'classical', label: 'Classical scale', min: 0, max: 1, step: 1, default: 0, options: ONOFF },
  ],
  text: { label: 'Sample', default: 'Reading is a kind of seeing — Hamburgefonstiv 1234567890' },
  fontFamily: 'fraunces',
  generate: generator(() => waterfall, drawWaterfall),
};

/* -------------------------------------------------------------------------- */
/* 9. Spacing specimen — Hochuli                                               */
/* -------------------------------------------------------------------------- */

interface SpacingRow { tracking: number; word: number; caps: boolean; label: string; note: string; good?: boolean }

const SPACING_ROWS: SpacingRow[] = [
  { tracking: -30, word: 100, caps: false, label: '−30 ‰', note: 'too tight: letters touch, counters close' },
  { tracking: 0, word: 100, caps: false, label: '0 ‰', note: 'as fitted by the designer — even colour', good: true },
  { tracking: 30, word: 100, caps: false, label: '+30 ‰', note: 'a little open: for small sizes, light on dark' },
  { tracking: 100, word: 100, caps: false, label: '+100 ‰', note: 'letter-spaced lower case falls apart' },
  { tracking: 0, word: 60, caps: false, label: 'word space 60 %', note: 'words run together' },
  { tracking: 0, word: 200, caps: false, label: 'word space 200 %', note: 'holes in the line, rivers in the page' },
];
const CAPS_ROWS: SpacingRow[] = [
  { tracking: 0, word: 100, caps: true, label: 'CAPS 0 ‰', note: 'capitals set solid look cramped' },
  { tracking: 50, word: 100, caps: true, label: 'CAPS +50 ‰', note: 'capitals need letter-spacing', good: true },
];

function drawSpacing(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cType = motifColor(def, el, 0), cLab = motifColor(def, el, 1), cGood = motifColor(def, el, 2);
  const rows = [...SPACING_ROWS, ...(p.showCaps >= 0.5 ? CAPS_ROWS : [])];
  const text = oneLine(el, 'Typography is two-dimensional architecture');
  const font = ctx.font(el.fontFamily, 400);
  const { asc, desc } = safeMetrics(ctx, font);
  const { mono } = labelFonts(ctx);
  let lab = labelSize(w, h, 5.5, 90);
  const rowH = (s: number, l: number) => (l ? l * 1.3 + 1.5 : 0) + s * (asc + desc) + s * 0.5;
  let size = p.size;
  if (rows.length * rowH(size, lab) > h) {
    const per = h / rows.length;
    size = (per - (lab ? lab * 1.3 + 1.5 : 0)) / (asc + desc + 0.5);
    if (size < 3 && lab) {
      lab = 0;
      size = per / (asc + desc + 0.5);
    }
  }
  if (!(size >= 1)) return [];
  const space = textWidth(ctx, ' ', font, size) || size * 0.25;
  const total = rows.length * rowH(size, lab);
  let y = Math.max(0, (h - total) / 2);
  const labels: TextRun[] = [], notes: TextRun[] = [], lines: TextRun[] = [];
  for (const r of rows) {
    if (lab) {
      const l = run(ctx, fitLabel(ctx, r.label, mono, lab, w), mono, lab, 0, y + lab, cLab);
      labels.push(l);
      const note = fitLabel(ctx, `· ${r.note}`, mono, lab, w - l.width - lab * 0.6);
      if (note) notes.push(run(ctx, note, mono, lab, l.width + lab * 0.6, y + lab, r.good ? cGood : cLab));
      y += lab * 1.3 + 1.5;
    }
    const yb = y + asc * size;
    const ls = (r.tracking / 1000) * size;
    const words = (r.caps ? text.toUpperCase() : text).split(' ').filter(Boolean);
    const gap = (space * r.word) / 100 + ls;
    let x = 0;
    for (const word of words) {
      const ww = textWidth(ctx, word, font, size, ls);
      if (x + ww > w + 0.01) {
        const t = truncate(ctx, word, font, size, w - x, ls);
        if (t) lines.push(run(ctx, t, font, size, x, yb, cType, 'left', ls));
        break;
      }
      lines.push(run(ctx, word, font, size, x, yb, cType, 'left', ls));
      x += ww + gap;
    }
    y = yb + desc * size + size * 0.5;
  }
  return [...textPrim(lines), ...textPrim(labels), ...textPrim(notes)];
}

export const spacingSpecimen: MotifDef = {
  kind: 'spacing-specimen',
  label: 'Spacing specimen',
  designer: 'hochuli',
  description: 'One line set again and again with tighter and looser letter- and word-spacing, and a pair of capital lines — Jost Hochuli’s lesson from “Detail in Typography” that even typographic colour depends on spacing, and that capitals, unlike lower case, want to be spaced.',
  defaultSize: { w: 380, h: 320 },
  colors: [
    { label: 'Type', default: INK },
    { label: 'Labels', default: GREY },
    { label: 'Recommended', default: RED },
  ],
  params: [
    { key: 'size', label: 'Type size (pt)', min: 6, max: 36, step: 0.5, default: 12 },
    { key: 'showCaps', label: 'Capitals lines', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  text: { label: 'Sample line', default: 'Typography is two-dimensional architecture' },
  fontFamily: 'eb-garamond',
  generate: generator(() => spacingSpecimen, drawSpacing),
};

/* -------------------------------------------------------------------------- */
/* 10. Classification — Caflisch                                               */
/* -------------------------------------------------------------------------- */

interface ClassRow { name: string; group: string; family: string; weight?: number; opsz?: number; face: string; note: string }

const CLASSES: ClassRow[] = [
  { name: 'Garalde', group: 'Classical', family: 'eb-garamond', face: 'EB Garamond',
    note: 'Humanist old style: oblique stress, bracketed serifs, moderate contrast — Garamont, Granjon, 16th c.' },
  { name: 'Didone', group: 'Modern', family: 'fraunces', weight: 300, opsz: 144, face: 'Fraunces opsz 144',
    note: 'Rational: vertical stress, hairline serifs, abrupt contrast — Didot, Bodoni, c. 1800.' },
  { name: 'Glyphic', group: 'Incised', family: 'cinzel', face: 'Cinzel',
    note: 'Inscriptional capitals cut in stone, chiselled terminals — the Trajan column, 113 AD.' },
  { name: 'Neo-grotesque', group: 'Lineale', family: 'inter', face: 'Inter',
    note: 'Swiss sans: even stroke, closed apertures, level terminals — Helvetica, Univers, 1957.' },
  { name: 'Geometric', group: 'Lineale', family: 'space-grotesk', face: 'Space Grotesk',
    note: 'Constructed from circle and line, near-monoline — Futura, Erbar, the Bauhaus 1920s.' },
  { name: 'Blackletter', group: 'Fraktur', family: 'unifraktur', face: 'UnifrakturMaguntia',
    note: 'Broken, angular script of the German print tradition — Gutenberg’s textura to Fraktur.' },
  { name: 'Monospace', group: 'Fixed pitch', family: 'ibm-plex-mono', face: 'IBM Plex Mono',
    note: 'Every glyph on one advance, from typewriter and terminal — Courier, Letter Gothic.' },
];

function classFont(ctx: MotifContext, c: ClassRow, size: number): FontRef {
  const f = ctx.font(c.family, c.weight ?? 400);
  // High-contrast display master of Fraunces stands in for the Didone.
  return c.opsz ? { ...f, axes: { ...f.axes, opsz: c.opsz } } : opticalFont(f, size);
}

function drawClassification(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cType = motifColor(def, el, 0), cLab = motifColor(def, el, 1), cRule = motifColor(def, el, 2);
  const text = oneLine(el, 'Hamburgefonstiv');
  const { mono, sans, bold } = labelFonts(ctx);
  const lab = labelSize(w, h, 6.5, 140);
  const header = p.header >= 0.5 && lab > 0;
  const headH = header ? lab * 2.1 : 0;
  const n = CLASSES.length;
  const rowH = (h - headH) / n;
  const gap = lab ? Math.min(10, w * 0.025) : 0;
  const widest = lab ? Math.max(...CLASSES.map((c) => textWidth(ctx, c.name, bold, lab))) + 2 : 0;
  const nameW = lab ? Math.min(w * 0.4, Math.max(widest, clamp(w * 0.19, 44, 120))) : 0;
  const noteW = p.notes >= 0.5 && lab && w >= 260 ? clamp(w * 0.3, 70, 210) : 0;
  const sx = nameW + (nameW ? gap : 0) + noteW + (noteW ? gap : 0);
  const sw = Math.max(0, w - sx - 1);

  // One size for every specimen, so x-heights and widths compare honestly.
  const metrics = CLASSES.map((c) => safeMetrics(ctx, ctx.font(c.family, c.weight ?? 400)));
  let S = Infinity;
  CLASSES.forEach((c, i) => {
    const adv = textWidth(ctx, text, classFont(ctx, c, 24), 1);
    if (adv > 0) S = Math.min(S, sw / adv);
    S = Math.min(S, (rowH * 0.78) / (metrics[i].asc + metrics[i].desc));
  });
  if (!Number.isFinite(S) || S < 0) S = 0;

  const out: Prim[] = [];
  const rules = new Pen(), heavy = new Pen();
  heavy.move(0, headH).line(w, headH).move(0, h - RULE / 2).line(w, h - RULE / 2);
  for (let i = 1; i < n; i++) rules.move(0, headH + i * rowH).line(w, headH + i * rowH);
  out.push(...stroke(rules, cRule, FINE), ...stroke(heavy, cRule, RULE));

  const samples: TextRun[] = [], labels: TextRun[] = [];
  if (header) {
    const hs = lab * 0.8, ls = hs * 0.08;
    const hy = headH - lab * 0.65;
    labels.push(run(ctx, 'CLASS', mono, hs, 0, hy, cLab, 'left', ls));
    if (noteW) labels.push(run(ctx, 'CHARACTER', mono, hs, nameW + gap, hy, cLab, 'left', ls));
    labels.push(run(ctx, fitLabel(ctx, 'SPECIMEN · ONE SIZE', mono, hs, sw), mono, hs, sx, hy, cLab, 'left', ls));
  }
  CLASSES.forEach((c, i) => {
    const top = headH + i * rowH;
    if (S >= 1) {
      const f = classFont(ctx, c, S);
      const t = truncate(ctx, text, f, S, sw);
      if (t) samples.push(run(ctx, t, f, S, sx, top + rowH / 2 + (metrics[i].cap * S) / 2, cType));
    }
    if (!lab) return;
    const sub = lab * 0.82;
    const two = rowH >= lab * 2.6;
    const y1 = two ? top + (rowH - lab * 1.05 - sub * 1.35) / 2 + lab : top + rowH / 2 + lab * 0.35;
    labels.push(run(ctx, fitLabel(ctx, c.name, bold, lab, nameW), bold, lab, 0, y1, cType));
    if (two) labels.push(run(ctx, fitLabel(ctx, `${c.group} · ${c.face}`, sans, sub, nameW), sans, sub, 0, y1 + sub * 1.4, cLab));
    if (noteW) {
      const ns = lab * 0.82;
      const maxLines = Math.max(0, Math.floor((rowH - 2) / (ns * 1.3)));
      const ls = wrapText(ctx, c.note, sans, ns, noteW, Math.min(3, maxLines));
      const y0 = top + (rowH - ls.length * ns * 1.3) / 2 + ns * 0.95;
      ls.forEach((l, j) => labels.push(run(ctx, l, sans, ns, nameW + gap, y0 + j * ns * 1.3, cLab)));
    }
  });
  out.push(...textPrim(samples), ...textPrim(labels));
  return out;
}

export const classificationChart: MotifDef = {
  kind: 'classification-chart',
  label: 'Type classification',
  designer: 'caflisch',
  description: 'A Vox-ATypI style classification table — Garalde, Didone, Glyphic, the Lineales, Blackletter and Monospace — each set in a bundled face of its class at one common size, after the comparative tables Max Caflisch drew for typographic education.',
  defaultSize: { w: 440, h: 310 },
  colors: [
    { label: 'Specimens & class names', default: INK },
    { label: 'Notes', default: '#6b655b' },
    { label: 'Rules', default: INK },
  ],
  params: [
    { key: 'notes', label: 'Notes', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'header', label: 'Header', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  text: { label: 'Sample', default: 'Hamburgefonstiv' },
  generate: generator(() => classificationChart, drawClassification),
};

/* -------------------------------------------------------------------------- */
/* 11. Letterform anatomy — Caflisch                                           */
/* -------------------------------------------------------------------------- */

function drawAnatomy(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cType = motifColor(def, el, 0), cLine = motifColor(def, el, 1), cLab = motifColor(def, el, 2);
  const text = oneLine(el, 'Hxgb');
  const base = ctx.font(el.fontFamily, 400);
  const { asc, desc, cap, xh } = safeMetrics(ctx, base);
  const { mono } = labelFonts(ctx);
  const lab = p.labels >= 0.5 ? labelSize(w, h, 6, 100) : 0;
  const names = ['ascender', 'cap height', 'x-height', 'baseline', 'descender'];
  const leftCol = lab ? Math.max(...names.map((s) => textWidth(ctx, s, mono, lab))) + lab * 1.3 : 2;
  const brackets = p.brackets >= 0.5 && lab > 0;
  const rightCol = brackets ? lab * 4.4 + 6 : 2;
  const pad = lab ? lab * 0.7 : 1;
  const adv1 = textWidth(ctx, text, base, 1);
  const availW = w - leftCol - rightCol - 4;
  let S = (h - 2 * pad) / (asc + desc);
  if (adv1 > 0) S = Math.min(S, availW / adv1);
  if (!(S > 0.5)) return [];
  const font = opticalFont(base, S);
  const wordW = textWidth(ctx, text, font, S);
  const yb = (h - (asc + desc) * S) / 2 + asc * S;
  const ys = [yb - asc * S, yb - cap * S, yb - xh * S, yb, yb + desc * S];
  const x1 = Math.max(0, leftCol - lab * 0.5), x2 = Math.min(w, w - rightCol + 2);
  const wx = leftCol + (w - leftCol - rightCol - wordW) / 2;

  const out: Prim[] = [...textPrim([run(ctx, text, font, S, wx, yb, cType)])];
  const dashed = new Pen(), solid = new Pen();
  ys.forEach((y, i) => (i === 0 || i === 4 ? dashed : solid).move(x1, y).line(x2, y));
  out.push(...stroke(dashed, cLine, HAIR, { dash: [2, 1.5] }), ...stroke(solid, cLine, HAIR));
  out.push(...stroke(new Pen().move(x1, yb).line(x2, yb), cLine, 0.7));
  if (!lab) return out;

  // Labels beside their lines, nudged apart where the metrics crowd together.
  const gap = lab * 1.05;
  const ly = ys.map((y) => y + lab * 0.35);
  for (let i = 1; i < ly.length; i++) ly[i] = Math.max(ly[i], ly[i - 1] + gap);
  const overflow = ly[ly.length - 1] - (h - 1);
  if (overflow > 0) for (let i = 0; i < ly.length; i++) ly[i] -= overflow;
  for (let i = ly.length - 2; i >= 0; i--) ly[i] = Math.min(ly[i], ly[i + 1] - gap);
  const runs = names.map((s, i) => run(ctx, s, mono, lab, leftCol - lab * 0.9, ly[i], cLab, 'right'));

  if (brackets) {
    const br = new Pen();
    const pair: [number, number, string, number][] = [
      [w - rightCol + lab * 1.6, ys[2], 'x-height', xh],
      [w - rightCol + lab * 3.6, ys[1], 'cap height', cap],
    ];
    for (const [bx, yt, name, v] of pair) {
      br.move(bx - 2.2, yt).line(bx, yt).line(bx, yb).line(bx - 2.2, yb);
      const len = yb - yt - 2;
      const value = `${fmtNum(v, 2, true)} em`;
      const full = `${name} ${value}`;
      const t = textWidth(ctx, full, mono, lab) <= len ? full : textWidth(ctx, value, mono, lab) <= len ? value : '';
      if (t) runs.push(vrun(ctx, t, mono, lab, bx + 1.5 + lab * 0.38, (yt + yb) / 2, cLab));
    }
    out.push(...stroke(br, cLab, HAIR));
  }
  out.push(...textPrim(runs));
  return out;
}

export const anatomy: MotifDef = {
  kind: 'anatomy',
  label: 'Letter anatomy',
  designer: 'caflisch',
  description: 'A word set large between its metric lines — ascender, cap height, x-height, baseline and descender, read from the font itself — with the x-height and cap height measured in ems: the vocabulary of letterform analysis Caflisch taught.',
  defaultSize: { w: 360, h: 200 },
  colors: [
    { label: 'Type', default: INK },
    { label: 'Metric lines', default: RED },
    { label: 'Labels', default: '#5d574d' },
  ],
  params: [
    { key: 'labels', label: 'Labels', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'brackets', label: 'Brackets', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  text: { label: 'Sample', default: 'Hxgb' },
  fontFamily: 'eb-garamond',
  generate: generator(() => anatomy, drawAnatomy),
};
