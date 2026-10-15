/**
 * Grid and measuring diagrams: Müller-Brockmann's field grid, Bosshard's dual and
 * em-derived grids, and a technical dimension line.
 */
import type { MotifElement } from '../../model/types';
import { fromPt } from '../../model/units';
import type { Matrix, Prim, TextRun } from '../../render/primitives';
import { Pen } from '../generators/util';
import type { MotifContext, MotifDef } from './types';
import { motifColor } from './types';
import {
  BLUE, FINE, GREY, HAIR, INK, ONOFF, RED, RULE, choice, clamp, dimH, fill, fitLabel, fmtLen, fmtNum,
  generator, labelFonts, labelSize, run, stroke, textPrim, textWidth, type Params, type Terminator,
} from './diagrams-kit';

/* -------------------------------------------------------------------------- */
/* 1. Field grid — Müller-Brockmann                                            */
/* -------------------------------------------------------------------------- */

function drawFieldGrid(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cLine = motifColor(def, el, 0), cFill = motifColor(def, el, 1), cNum = motifColor(def, el, 2);
  const cols = choice(p.cols, 1, 24), rows = choice(p.rows, 1, 24);
  const m = clamp(p.margin, 0, Math.max(0, Math.min(w, h) / 2 - 0.5));
  const aw = Math.max(0, w - 2 * m), ah = Math.max(0, h - 2 * m);
  let g = p.gutter;
  if (cols > 1 && g * (cols - 1) > aw * 0.6) g = (aw * 0.6) / (cols - 1);
  if (cols === 1) g = 0;
  const fieldW = (aw - g * (cols - 1)) / cols;

  // Rows: with a baseline, fields are a whole number of lines and the row gutter a whole
  // number of empty lines; the remainder falls to the foot margin, as in Grid Systems.
  const L = p.baseline;
  let rg = rows > 1 ? p.rowGutter : 0;
  let fieldH = 0;
  let locked = false;
  if (L >= 1) {
    const rgL = rows > 1 ? Math.round(rg / L) * L : 0;
    const lines = Math.floor((ah - (rows - 1) * rgL) / rows / L + 1e-9);
    if (lines >= 1) {
      rg = rgL;
      fieldH = lines * L;
      locked = true;
    }
  }
  if (!locked) {
    if (rows > 1 && rg * (rows - 1) > ah * 0.6) rg = (ah * 0.6) / (rows - 1);
    fieldH = (ah - rg * (rows - 1)) / rows;
  }
  const usedH = rows * fieldH + (rows - 1) * rg;

  const out: Prim[] = [];
  const fields = new Pen();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) fields.rect(m + i * (fieldW + g), m + j * (fieldH + rg), fieldW, fieldH);
  }
  if (p.fill >= 0.5) out.push(...fill(fields, cFill, 0.13));

  if (L >= 1 && aw > 0) {
    const base = new Pen();
    const bottom = m + (locked ? usedH : ah) + 0.01;
    let n = 0;
    for (let y = m + L; y <= bottom && n < 4000; y += L, n++) base.move(m, y).line(w - m, y);
    out.push(...stroke(base, cLine, FINE, { opacity: 0.55 }));
  }

  // The format edge, kept inside the box.
  const inset = Math.min(RULE / 2, w / 2, h / 2);
  out.push(...stroke(new Pen().rect(inset, inset, Math.max(0, w - 2 * inset), Math.max(0, h - 2 * inset)), cLine, RULE));
  out.push(...stroke(fields, cLine, 0.4));

  const { mono } = labelFonts(ctx);
  if (p.numbers >= 0.5) {
    const ns = Math.min(7, Math.min(fieldW, fieldH) * 0.24);
    if (ns >= 3) {
      const runs: TextRun[] = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          runs.push(run(ctx, String(j * cols + i + 1), mono, ns, m + i * (fieldW + g) + ns * 0.35, m + j * (fieldH + rg) + ns * 1.05, cNum));
        }
      }
      out.push(...textPrim(runs));
    }
  }

  // Caption in the foot margin when there is room for it.
  const lab = labelSize(w, h, 5.5, 120);
  const foot = h - m - usedH;
  if (lab && foot >= lab * 2.2 && aw > 40) {
    const parts = [`${cols} × ${rows} fields`, `gutter ${fmtLen(g, ctx.unit)}`];
    if (L >= 1) parts.push(locked ? `${Math.round(fieldH / L)} lines of ${fmtNum(L, 2)} pt` : `baseline ${fmtNum(L, 2)} pt`);
    const text = fitLabel(ctx, parts.join(' · '), mono, lab, Math.max(aw, w - 2 * Math.min(m, 6)));
    const x = m > 6 ? m : Math.min(m, 6);
    out.push(...textPrim([run(ctx, text, mono, lab, x, m + usedH + foot / 2 + lab * 0.35, cNum)], 0.75));
  }
  return out;
}

export const gridDiagram: MotifDef = {
  kind: 'grid-diagram',
  label: 'Field grid',
  designer: 'muller-brockmann',
  description: 'A visible field grid after Müller-Brockmann’s “Grid Systems in Graphic Design” (1981): margins, columns and rows of equal fields divided by gutters, with fields locked to whole lines of the baseline grid and an empty line as the row gutter.',
  defaultSize: { w: 240, h: 340 },
  colors: [
    { label: 'Grid lines', default: BLUE },
    { label: 'Field tint', default: BLUE },
    { label: 'Numbers', default: INK },
  ],
  params: [
    { key: 'margin', label: 'Margin (pt)', min: 0, max: 144, step: 1, default: 18 },
    { key: 'cols', label: 'Columns', min: 1, max: 24, step: 1, default: 4 },
    { key: 'rows', label: 'Rows', min: 1, max: 24, step: 1, default: 6 },
    { key: 'gutter', label: 'Column gutter (pt)', min: 0, max: 72, step: 0.5, default: 9 },
    { key: 'rowGutter', label: 'Row gutter (pt)', min: 0, max: 72, step: 0.5, default: 12 },
    { key: 'baseline', label: 'Baseline (pt, 0 = off)', min: 0, max: 48, step: 0.5, default: 12 },
    { key: 'numbers', label: 'Field numbers', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'fill', label: 'Tint fields', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  generate: generator(() => gridDiagram, drawFieldGrid),
};

/* -------------------------------------------------------------------------- */
/* 2. Dual grid — Bosshard                                                     */
/* -------------------------------------------------------------------------- */

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

function drawDualGrid(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cA = motifColor(def, el, 0), cB = motifColor(def, el, 1), cU = motifColor(def, el, 2);
  const A = choice(p.systemA, 1, 8), B = choice(p.systemB, 1, 8);
  const N = lcm(A, B);
  // The margin frames the diagram; in a small box it must not swallow the grid.
  const m = clamp(p.margin, 0, Math.max(0, Math.min(w, h) * 0.3));
  const aw = Math.max(0, w - 2 * m), ah = Math.max(0, h - 2 * m);
  let g = N > 1 ? p.gutter : 0;
  if (N > 1 && g * (N - 1) > aw * 0.5) g = (aw * 0.5) / (N - 1);
  // The unit grid: N units with the common gutter. Every column of either system is a
  // whole number of units plus the gutters between them, so all edges coincide.
  const u = (aw - g * (N - 1)) / N;
  const system = (k: number) => {
    const span = N / k;
    const cw = span * u + (span - 1) * g;
    return Array.from({ length: k }, (_, j) => ({ x: m + j * span * (u + g), w: cw }));
  };
  const colsA = system(A), colsB = system(B);

  const out: Prim[] = [];
  const inset = Math.min(RULE / 2, w / 2, h / 2);
  out.push(...stroke(new Pen().rect(inset, inset, Math.max(0, w - 2 * inset), Math.max(0, h - 2 * inset)), cU, RULE));

  if (p.units >= 0.5 && N > 1) {
    const units = new Pen(), edges = new Pen();
    for (let i = 0; i < N; i++) {
      const x = m + i * (u + g);
      units.rect(x, m, u, ah);
      edges.move(x, m).line(x, m + ah).move(x + u, m).line(x + u, m + ah);
    }
    out.push(...fill(units, cU, 0.07), ...stroke(edges, cU, FINE, { opacity: 0.8 }));
  }

  const rects = (cols: { x: number; w: number }[]) => {
    const pen = new Pen();
    for (const c of cols) pen.rect(c.x, m, c.w, ah);
    return pen;
  };
  // System A as a tint, system B as a drawn outline: both stay legible where they overlap.
  const pa = rects(colsA);
  const pb = new Pen();
  const bi = Math.min(0.45, u / 4, ah / 4);
  for (const c of colsB) pb.rect(c.x + bi, m + bi, Math.max(0, c.w - 2 * bi), Math.max(0, ah - 2 * bi));
  out.push(...fill(pa, cA, 0.16), ...stroke(pa, cA, 0.4));
  out.push(...stroke(pb, cB, 0.9));

  const lab = p.labels >= 0.5 ? labelSize(w, h, 6, 110) : 0;
  if (!lab) return out;
  const { mono } = labelFonts(ctx);
  const nameA = `${A}-column`, nameB = `${B}-column`;
  const nameU = `${N} unit${N === 1 ? '' : 's'}`;
  const runs: TextRun[] = [];
  if (m >= lab + 8) {
    // Brackets in the margins: system A over the head, system B under the foot.
    const ya = m - 4, yb = h - m + 4;
    const ba = new Pen(), bb = new Pen();
    for (const c of colsA) ba.move(c.x, ya + 2.5).line(c.x, ya).line(c.x + c.w, ya).line(c.x + c.w, ya + 2.5);
    for (const c of colsB) bb.move(c.x, yb - 2.5).line(c.x, yb).line(c.x + c.w, yb).line(c.x + c.w, yb - 2.5);
    out.push(...stroke(ba, cA, HAIR), ...stroke(bb, cB, HAIR));
    runs.push(run(ctx, fitLabel(ctx, nameA, mono, lab, aw), mono, lab, m, ya - 2.5, cA));
    const by = yb + 2.5 + lab * 0.8;
    const rb = run(ctx, nameB, mono, lab, m, by, cB);
    runs.push(rb);
    const unitText = fitLabel(ctx, `${nameU} · gutter ${fmtLen(g, ctx.unit)}`, mono, lab, aw - rb.width - lab * 2);
    if (unitText) runs.push(run(ctx, unitText, mono, lab, w - m, by, cU, 'right'));
  } else {
    const x = m + 3;
    const maxW = Math.max(0, aw - 6);
    [[nameA, cA], [nameB, cB], [nameU, cU]].forEach(([t, c], i) => {
      const s = fitLabel(ctx, t, mono, lab, maxW);
      if (s) runs.push(run(ctx, s, mono, lab, x, m + 3 + lab * (0.8 + i * 1.3), c));
    });
  }
  out.push(...textPrim(runs));
  return out;
}

export const dualGrid: MotifDef = {
  kind: 'dual-grid',
  label: 'Dual grid',
  designer: 'bosshard',
  description: 'Two column systems superimposed on one page with a common gutter, both derived from their shared unit grid (the least common multiple) — Hans Rudolf Bosshard’s method in “Der typografische Raster” for letting text and images keep different measures that still align.',
  defaultSize: { w: 340, h: 240 },
  colors: [
    { label: 'System A', default: RED },
    { label: 'System B', default: BLUE },
    { label: 'Unit grid', default: GREY },
  ],
  params: [
    { key: 'systemA', label: 'System A columns', min: 1, max: 8, step: 1, default: 2 },
    { key: 'systemB', label: 'System B columns', min: 1, max: 8, step: 1, default: 3 },
    { key: 'gutter', label: 'Gutter (pt)', min: 0, max: 48, step: 0.5, default: 12 },
    { key: 'margin', label: 'Margin (pt)', min: 0, max: 144, step: 1, default: 24 },
    { key: 'units', label: 'Unit grid', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'labels', label: 'Labels', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  generate: generator(() => dualGrid, drawDualGrid),
};

/* -------------------------------------------------------------------------- */
/* 3. Em grid — Bosshard                                                       */
/* -------------------------------------------------------------------------- */

function drawEmGrid(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const { w, h } = el;
  const cGrid = motifColor(def, el, 0), cBase = motifColor(def, el, 1), cLab = motifColor(def, el, 2);
  const em = Math.max(1, p.typeSize);
  const lead = Math.max(1, p.leading);
  const ems = choice(p.emsPerModule, 1, 16), lines = choice(p.linesPerModule, 1, 16);
  const gEm = clamp(p.gutterEms, 0, 4);
  const M = ems * em, G = gEm * em;
  const RH = lines * lead, RG = lead;
  const lab = p.labels >= 0.5 ? labelSize(w, h, 6, 120) : 0;
  const { mono } = labelFonts(ctx);

  // Annotation band: two lines of text plus a ruler.
  const band = lab ? lab * 2.9 + 9 : 0;
  const top = Math.min(band, h * 0.5);
  // One em of margin either side, as far as the box allows.
  const cols = Math.max(1, Math.floor((w - 2 * em + G) / (M + G) + 1e-9));
  const rows = Math.max(1, Math.floor((h - top + RG) / (RH + RG) + 1e-9));
  const gw = cols * M + (cols - 1) * G;
  const gh = rows * RH + (rows - 1) * RG;
  const x0 = Math.max(0, (w - gw) / 2);
  const y0 = top;

  const grid: Prim[] = [];
  const mods = new Pen();
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) mods.rect(x0 + i * (M + G), y0 + j * (RH + RG), M, RH);
  grid.push(...fill(mods, cGrid, 0.1));

  if (p.baselines >= 0.5) {
    // A body of `em` centred in each line slot; the baseline sits 0.2 em above its foot.
    const drop = clamp(lead - ((lead - em) / 2 + 0.2 * em), 0, lead);
    const base = new Pen();
    const count = Math.min(4000, Math.ceil(gh / lead));
    for (let k = 0; k < count; k++) {
      const y = y0 + k * lead + drop;
      if (y > y0 + gh) break;
      base.move(x0, y).line(x0 + gw, y);
    }
    grid.push(...stroke(base, cBase, FINE, { opacity: 0.7 }));
  }
  grid.push(...stroke(mods, cGrid, 0.45));

  // Em ruler along the head of the grid: every edge falls on a whole em.
  const ruler = new Pen();
  const nEm = Math.min(4000, Math.round(gw / em));
  for (let k = 0; k <= nEm; k++) {
    const x = x0 + k * em;
    const major = k % (ems + gEm) === 0 || (k - ems) % (ems + gEm) === 0;
    ruler.move(x, y0).line(x, y0 - (major ? 3.2 : 1.6));
  }
  ruler.move(x0, y0).line(x0 + gw, y0);
  const out: Prim[] = [{ t: 'group', clip: new Pen().rect(0, 0, w, h).d, children: grid }];
  if (y0 >= 3.2) out.push(...stroke(ruler, cLab, FINE));

  if (lab && top >= lab * 2) {
    const metric = ctx.unit === 'pt' ? '' : ` (${fmtLen(M, ctx.unit)})`;
    const l1 = `1 em = ${fmtNum(em, 2)} pt · line = ${fmtNum(lead, 2)} pt`;
    const l2 = `module = ${ems} em × ${lines} lines = ${fmtNum(M, 1)} × ${fmtNum(RH, 1)} pt${metric} · gutter ${fmtNum(gEm, 1)} em, row gap 1 line`;
    const maxW = w - 2;
    out.push(...textPrim([
      run(ctx, fitLabel(ctx, l1, mono, lab, maxW), mono, lab, 1, lab * 1.05, cLab),
      run(ctx, fitLabel(ctx, l2, mono, lab, maxW), mono, lab, 1, lab * 2.35, cLab),
    ]));
  }
  return out;
}

export const emGrid: MotifDef = {
  kind: 'em-grid',
  label: 'Em grid',
  designer: 'bosshard',
  description: 'A grid built from the type itself: module width in ems of the text size, module depth in lines of leading, gutters of one em and one empty line — Bosshard’s typographic measure, where every edge falls on a whole em and every field on the baselines.',
  defaultSize: { w: 340, h: 260 },
  colors: [
    { label: 'Modules', default: BLUE },
    { label: 'Baselines', default: RED },
    { label: 'Labels', default: INK },
  ],
  params: [
    { key: 'typeSize', label: 'Type size (pt)', min: 5, max: 36, step: 0.5, default: 10 },
    { key: 'leading', label: 'Leading (pt)', min: 5, max: 48, step: 0.5, default: 12 },
    { key: 'emsPerModule', label: 'Module width (em)', min: 1, max: 16, step: 1, default: 4 },
    { key: 'linesPerModule', label: 'Module depth (lines)', min: 1, max: 16, step: 1, default: 4 },
    { key: 'gutterEms', label: 'Gutter (em)', min: 0, max: 4, step: 0.5, default: 1 },
    { key: 'baselines', label: 'Baselines', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
    { key: 'labels', label: 'Annotations', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  generate: generator(() => emGrid, drawEmGrid),
};

/* -------------------------------------------------------------------------- */
/* 4. Dimension line                                                           */
/* -------------------------------------------------------------------------- */

function drawDimension(el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef): Prim[] {
  const color = motifColor(def, el, 0);
  const vertical = choice(p.orientation, 0, 1) === 1;
  // Draw horizontally in a (length × thickness) frame, then turn it for vertical use.
  const L = vertical ? el.h : el.w;
  const T = vertical ? el.w : el.h;
  const term = choice(p.arrows, 0, 2) as Terminator;
  const { mono } = labelFonts(ctx);
  const text = `${fmtNum(fromPt(L, ctx.unit), choice(p.decimals, 0, 4), true)} ${ctx.unit}`;
  const lw = HAIR;

  // Label size: as asked, but never taller than the frame or wider than the span allows.
  let size = Math.min(p.labelSize, (T - 2.5) / 0.95);
  const natural = textWidth(ctx, text, mono, 1);
  if (natural > 0) size = Math.min(size, (L - 2) / natural);
  if (size < 3) size = 0;
  const k = clamp(size ? size / 7 : Math.min(1, T / 10), 0.3, 2.5);
  const cap = size * 0.72;
  const dimY = clamp(size ? cap + 3 : T * 0.4, Math.min(T, 1), Math.max(0.5, T - 0.5));
  const out: Prim[] = [];

  if (p.extension >= 0.5) {
    const ext = new Pen();
    const y1 = Math.max(0, dimY - 2.2 * k);
    const y2 = T - Math.min(1.5, T * 0.12);
    if (y2 > y1) {
      ext.move(lw / 2, y1).line(lw / 2, y2).move(L - lw / 2, y1).line(L - lw / 2, y2);
      out.push(...stroke(ext, color, lw * 0.8));
    }
  }
  const st = { ctx, font: mono, size: 0, color, term, k, width: lw };
  out.push(...dimH(st, lw / 2, L - lw / 2, dimY, ''));
  if (size) out.push(...textPrim([run(ctx, text, mono, size, L / 2, dimY - 2 * Math.max(0.6, k), color, 'center')]));
  if (!vertical) return out;
  const turn: Matrix = [0, -1, 1, 0, 0, el.h];
  return [{ t: 'group', matrix: turn, children: out }];
}

export const dimension: MotifDef = {
  kind: 'dimension',
  label: 'Dimension',
  designer: 'general',
  description: 'A technical measuring line — extension lines, a dimension line with arrows, architectural ticks or dots, and the measured length of the box in the document unit — for annotating margins, measures and trims in teaching layouts.',
  defaultSize: { w: 200, h: 26 },
  colors: [{ label: 'Line & label', default: INK }],
  params: [
    { key: 'orientation', label: 'Orientation', min: 0, max: 1, step: 1, default: 0, options: ['Horizontal', 'Vertical'] },
    { key: 'arrows', label: 'Terminators', min: 0, max: 2, step: 1, default: 0, options: ['Arrows', 'Ticks (architectural)', 'Dots'] },
    { key: 'decimals', label: 'Decimals', min: 0, max: 4, step: 1, default: 1 },
    { key: 'labelSize', label: 'Label size (pt)', min: 4, max: 24, step: 0.5, default: 7 },
    { key: 'extension', label: 'Extension lines', min: 0, max: 1, step: 1, default: 1, options: ONOFF },
  ],
  generate: generator(() => dimension, drawDimension),
};
