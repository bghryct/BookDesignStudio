/**
 * Twentieth-century constructive motifs: the Penguin band grid (Tschichold),
 * Müller-Brockmann's arcs and circles, Bosshard's diagonal bars and the
 * serial colour fields of Zurich Konkrete Kunst. All vector.
 */
import type { MotifElement } from '../../model/types';
import type { PathPrim, Prim, TextRun } from '../../render/primitives';
import { fmt, rectPath } from '../../render/primitives';
import { mix } from '../../lib/color';
import { clamp, rng } from '../../lib/random';
import { DEG, Pen } from '../generators/util';
import type { MotifDef } from './types';
import { advance, arcTo, okBox, optSlot, placeRun, readMotifParams, seedOf, slot } from './decorative-shared';

const box = (el: MotifElement) => rectPath(0, 0, el.w, el.h);

/* ========================================================================== */
/* 8. Penguin horizontal-band grid                                             */
/* ========================================================================== */

/** Greedy word wrap at a measured width; returns lines (never empty when text is). */
function wrap(text: string, measure: (s: string) => number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    const trial = cur ? `${cur} ${wd}` : wd;
    if (!cur || measure(trial) <= width) cur = trial;
    else {
      lines.push(cur);
      cur = wd;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Wrap into as few lines as greedy wrapping needs, then even out their lengths (no widows). */
function balancedWrap(text: string, measure: (s: string) => number, width: number): string[] {
  const lines = wrap(text, measure, width);
  if (lines.length <= 1) return lines;
  let lo = Math.max(...text.split(/\s+/).filter(Boolean).map(measure)), hi = width;
  if (lo >= hi) return lines;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (wrap(text, measure, mid).length <= lines.length) hi = mid;
    else lo = mid;
  }
  return wrap(text, measure, hi);
}

export const PENGUIN_BANDS: MotifDef = {
  kind: 'penguin-bands',
  label: 'Horizontal-band cover',
  designer: 'tschichold',
  description:
    'The horizontal-band paperback cover: Edward Young’s 1935 grid of coloured head and foot bands around a white title band, as refined by Tschichold’s Penguin Composition Rules (1947–49) with fine inner rules and carefully spaced type. Only the band structure — no publisher’s name or device.',
  defaultSize: { w: 315, h: 513 },
  colors: [
    { label: 'Bands', default: '#f37021' },
    { label: 'Centre band', default: '#fbf8f0' },
    { label: 'Rules & type', default: '#1b1813' },
  ],
  text: { label: 'Title (further lines: author)', default: 'The Form of the Book', multiline: true },
  fontFamily: 'inter',
  params: [
    { key: 'bandRatio', label: 'Band height (× cover)', min: 0.05, max: 0.45, step: 0.005, default: 0.3 },
    { key: 'ruleInset', label: 'Rule inset pt', min: 0, max: 60, step: 0.5, default: 7 },
    { key: 'caps', label: 'Spaced capitals', min: 0, max: 1, step: 1, default: 0 },
    { key: 'titleSize', label: 'Title size pt', min: 4, max: 120, step: 0.5, default: 22 },
    { key: 'ruleWeight', label: 'Rule weight pt', min: 0, max: 4, step: 0.05, default: 0.6 },
  ],
  generate: (el, ctx) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(PENGUIN_BANDS, el);
    const band = slot(PENGUIN_BANDS, el, 0), centre = slot(PENGUIN_BANDS, el, 1), ink = slot(PENGUIN_BANDS, el, 2);
    const { w, h } = el;
    const bh = h * p.bandRatio;
    const out: Prim[] = [
      { t: 'path', d: rectPath(0, bh, w, Math.max(0, h - 2 * bh)), fill: centre },
      { t: 'path', d: rectPath(0, 0, w, bh) + rectPath(0, h - bh, w, bh), fill: band },
    ];
    const cTop = bh, cBot = h - bh;
    const rw = p.ruleWeight;
    const inset = Math.min(p.ruleInset, Math.max(0, (cBot - cTop) / 2 - rw));
    const xm = Math.min(w / 2 - 0.5, Math.max(p.ruleInset, w * 0.08));
    let innerTop = cTop, innerBot = cBot;
    if (rw > 0 && cBot - cTop > rw * 2 + 1 && xm < w / 2) {
      const y1 = cTop + inset + rw / 2, y2 = cBot - inset - rw / 2;
      out.push({ t: 'path', d: `M${fmt(xm)} ${fmt(y1)}H${fmt(w - xm)}M${fmt(xm)} ${fmt(y2)}H${fmt(w - xm)}`, fill: null, stroke: ink, strokeWidth: rw, cap: 'butt' });
      innerTop = y1 + rw / 2;
      innerBot = y2 - rw / 2;
    }

    const raw = (el.text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!raw.length || innerBot - innerTop < 2) return out;
    const caps = p.caps >= 0.5;
    const family = el.fontFamily || PENGUIN_BANDS.fontFamily!;
    const fTitle = ctx.font(family, 600);
    const fAuthor = ctx.font(family, 400);
    const mT = ctx.metrics(fTitle), mA = ctx.metrics(fAuthor);
    const capT = Number.isFinite(mT.capHeight) && mT.capHeight > 0 ? mT.capHeight : 0.7;
    const capA = Number.isFinite(mA.capHeight) && mA.capHeight > 0 ? mA.capHeight : 0.7;
    const title = caps ? raw[0].toUpperCase() : raw[0];
    const authors = raw.slice(1).map((s) => (caps ? s.toUpperCase() : s));
    const aw = Math.max(1, w - 2 * Math.max(xm, w * 0.1));
    const avail = Math.max(1, (innerBot - innerTop) * 0.86);

    let size = p.titleSize;
    let layout: { tl: string[]; al: string[]; sizeA: number; lsT: number; lsA: number; height: number } | null = null;
    for (let it = 0; it < 24; it++) {
      const sizeA = Math.max(3, size * 0.52);
      const lsT = caps ? size * 0.09 : 0;
      const lsA = sizeA * (caps ? 0.14 : 0.04);
      const mT1 = (s: string) => advance(ctx, s, fTitle, size, lsT) - lsT;
      const mA1 = (s: string) => advance(ctx, s, fAuthor, sizeA, lsA) - lsA;
      // A title that nearly fits is set a little smaller rather than broken.
      const one = mT1(title);
      if (one > aw && one <= aw * 1.18 && size > 3) {
        size = Math.max(3, size * (aw / one) * 0.999);
        continue;
      }
      const tl = balancedWrap(title, mT1, aw);
      const al = authors.flatMap((a) => balancedWrap(a, mA1, aw));
      const widest = Math.max(...tl.map(mT1), ...al.map(mA1), 0);
      const height = tl.length * size * 1.16 + (al.length ? size * 0.9 + al.length * sizeA * 1.3 : 0);
      layout = { tl, al, sizeA, lsT, lsA, height };
      if ((widest <= aw * 1.001 && height <= avail) || size <= 3) break;
      size = Math.max(3, size * Math.min(0.94, widest > aw ? aw / widest : 1, height > avail ? Math.sqrt(avail / height) : 1));
    }
    if (!layout) return out;
    const runs: TextRun[] = [];
    const cx = w / 2;
    let y = (innerTop + innerBot) / 2 - layout.height / 2;
    for (const line of layout.tl) {
      const slotH = size * 1.16;
      const base = y + slotH / 2 + (capT * size) / 2;
      runs.push(placeRun(ctx, line, fTitle, size, cx, base, ink, 'center', layout.lsT));
      y += slotH;
    }
    if (layout.al.length) {
      // A short centred rule separates title and author, as on the 1940s covers.
      const ry = y + size * 0.45;
      const rl = Math.min(aw * 0.3, size * 1.6);
      out.push({ t: 'path', d: `M${fmt(cx - rl / 2)} ${fmt(ry)}H${fmt(cx + rl / 2)}`, fill: null, stroke: ink, strokeWidth: Math.max(0.3, rw || 0.5), cap: 'butt' });
      y += size * 0.9;
      for (const line of layout.al) {
        const slotH = layout.sizeA * 1.3;
        const base = y + slotH / 2 + (capA * layout.sizeA) / 2;
        runs.push(placeRun(ctx, line, fAuthor, layout.sizeA, cx, base, ink, 'center', layout.lsA));
        y += slotH;
      }
    }
    out.push({ t: 'text', runs });
    return out;
  },
};

/* ========================================================================== */
/* 9. Concentric arcs (after the 1955 Beethoven poster)                        */
/* ========================================================================== */

export const CONCENTRIC_ARCS: MotifDef = {
  kind: 'concentric-arcs',
  label: 'Concentric arcs',
  designer: 'muller-brockmann',
  description:
    'Concentric ring segments radiating from a point near the corner, each ring wider and longer than the last in a measured, syncopated progression — the structure of Müller-Brockmann’s 1955 Beethoven poster for the Tonhalle Zürich, where geometry is made to behave like music.',
  defaultSize: { w: 360, h: 509 },
  colors: [
    { label: 'Arcs', default: '#111111' },
    { label: 'Ground (empty = none)', default: '#f7f5f0' },
  ],
  params: [
    { key: 'rings', label: 'Rings', min: 2, max: 60, step: 1, default: 15 },
    { key: 'startAngle', label: 'Start angle °', min: -180, max: 180, step: 1, default: -8 },
    { key: 'sweepGrowth', label: 'Sweep growth ° per ring', min: 0, max: 40, step: 0.5, default: 6.5 },
    { key: 'weight', label: 'Ink share of ring', min: 0.1, max: 1, step: 0.01, default: 0.74 },
    { key: 'gapRatio', label: 'Breaks in rings', min: 0, max: 0.6, step: 0.01, default: 0.08 },
    { key: 'centreX', label: 'Centre x (× width)', min: -0.5, max: 1.5, step: 0.01, default: 0.1 },
    { key: 'centreY', label: 'Centre y (× height)', min: -0.5, max: 1.5, step: 0.01, default: 0.12 },
    { key: 'growth', label: 'Ring width growth', min: 0, max: 1, step: 0.01, default: 0.55 },
    { key: 'rhythm', label: 'Rhythmic variation', min: 0, max: 1, step: 0.01, default: 0.4 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(CONCENTRIC_ARCS, el);
    const ink = slot(CONCENTRIC_ARCS, el, 0), ground = optSlot(CONCENTRIC_ARCS, el, 1);
    const { w, h } = el;
    const cx = p.centreX * w, cy = p.centreY * h;
    const Rmax = Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => Math.hypot(x - cx, y - cy)), 1e-3);
    const N = Math.round(p.rings);
    const r0 = Rmax * 0.04;
    const q = N > 1 ? Math.pow(1 + 4 * p.growth, 1 / (N - 1)) : 1;
    const span = Rmax - r0;
    const p0 = Math.abs(q - 1) < 1e-9 ? span / N : (span * (q - 1)) / (Math.pow(q, N) - 1);
    const r = rng(seedOf(el) * 17 + 9);
    const prims: PathPrim[] = [];
    let rin = r0;
    for (let i = 0; i < N; i++) {
      const pw = p0 * Math.pow(q, i);
      const rm = rin + pw / 2;
      rin += pw;
      const sw = pw * p.weight;
      // Draw every ring's random numbers up front so one slider never reshuffles another.
      const jitter = (r() - 0.5) * 2, rBreak = r(), rAt = r();
      // Sweep grows with the radius; the rhythm syncopates it.
      const accent = i % 3 === 2 ? 1 : 0;
      let sweep = 16 + p.sweepGrowth * i + p.rhythm * (jitter * (10 + p.sweepGrowth * 2.5) + accent * (8 + p.sweepGrowth));
      sweep = clamp(sweep, 3, 359.5);
      const a0 = p.startAngle * DEG;
      const a1 = a0 + sweep * DEG;
      const pen = new Pen();
      const breakHere = p.gapRatio > 0.001 && (rBreak < 0.45 || i % 4 === 3);
      if (breakHere && sweep > 12) {
        const at = 0.3 + rAt * 0.45;
        const g = clamp(p.gapRatio, 0, 0.9);
        arcTo(pen, cx, cy, rm, a0, a0 + (a1 - a0) * Math.max(0.02, at - g / 2));
        arcTo(pen, cx, cy, rm, a0 + (a1 - a0) * Math.min(0.98, at + g / 2), a1);
      } else arcTo(pen, cx, cy, rm, a0, a1);
      prims.push({ t: 'path', d: pen.d, fill: null, stroke: ink, strokeWidth: sw, cap: 'butt', join: 'miter' });
    }
    const out: Prim[] = [];
    if (ground) out.push({ t: 'path', d: box(el), fill: ground });
    out.push({ t: 'group', clip: box(el), children: prims });
    return out;
  },
};

/* ========================================================================== */
/* 10. Circle composition                                                      */
/* ========================================================================== */

export const CIRCLE_COMPOSITION: MotifDef = {
  kind: 'circle-composition',
  label: 'Circle composition',
  designer: 'muller-brockmann',
  description:
    'Discs and rings of modular sizes placed on a field grid and allowed to overlap and bleed — the constructivist vocabulary of Müller-Brockmann’s Musica Viva concert posters and his 1960 “der Film” poster, with optional multiply for overprinted inks.',
  defaultSize: { w: 360, h: 509 },
  colors: [
    { label: 'Ground (empty = none)', default: '#f4f1ea' },
    { label: 'Colour 1', default: '#151515' },
    { label: 'Colour 2', default: '#e2231a' },
    { label: 'Colour 3', default: '#1f5fae' },
  ],
  params: [
    { key: 'count', label: 'Circles', min: 1, max: 40, step: 1, default: 9 },
    { key: 'sizeSpread', label: 'Size spread', min: 0, max: 1, step: 0.01, default: 0.7 },
    { key: 'overlap', label: 'Overlap', min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: 'alignToGrid', label: 'Align to grid', min: 0, max: 1, step: 1, default: 1 },
    { key: 'multiply', label: 'Multiply (overprint)', min: 0, max: 1, step: 1, default: 1 },
    { key: 'grid', label: 'Grid fields across', min: 2, max: 16, step: 1, default: 6 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(CIRCLE_COMPOSITION, el);
    const ground = optSlot(CIRCLE_COMPOSITION, el, 0);
    const cols = [1, 2, 3].map((i) => slot(CIRCLE_COMPOSITION, el, i));
    const { w, h } = el;
    const G = Math.round(p.grid);
    const m = w / G;
    const rowsN = Math.max(1, Math.round(h / m));
    const my = h / rowsN;
    const unit = Math.min(m, my);
    const aligned = p.alignToGrid >= 0.5;
    const r = rng(seedOf(el) * 23 + 4);
    const N = Math.round(p.count);
    const snap = (x: number, y: number): [number, number] =>
      aligned ? [clamp(Math.round(x / m), -1, G + 1) * m, clamp(Math.round(y / my), -1, rowsN + 1) * my] : [x, y];
    const blend = p.multiply >= 0.5 ? ('multiply' as const) : undefined;
    const prims: PathPrim[] = [];
    const circle = (x: number, y: number, rad: number, color: string, kind: 'disc' | 'ring' | 'hair' | 'concentric') => {
      if (!(rad > 0)) return;
      if (kind === 'disc') prims.push({ t: 'path', d: new Pen().circle(x, y, rad).d, fill: color, blend });
      else if (kind === 'ring') {
        const sw = Math.max(0.5, rad * 0.22);
        prims.push({ t: 'path', d: new Pen().circle(x, y, Math.max(0.1, rad - sw / 2)).d, fill: null, stroke: color, strokeWidth: sw, blend });
      } else if (kind === 'concentric') {
        const n = 3;
        const sw = Math.max(0.4, rad / (n * 2.2));
        const pen = new Pen();
        for (let k = 0; k < n; k++) pen.circle(x, y, Math.max(0.1, rad - sw / 2 - k * sw * 2));
        prims.push({ t: 'path', d: pen.d, fill: null, stroke: color, strokeWidth: sw, blend });
      } else prims.push({ t: 'path', d: new Pen().circle(x, y, rad).d, fill: null, stroke: color, strokeWidth: Math.max(0.35, unit * 0.025), blend });
    };

    // The dominant form sits on grid lines near the golden section.
    const gx = r() < 0.5 ? 0.382 : 0.618, gy = r() < 0.5 ? 0.382 : 0.618;
    let [ax, ay] = snap(w * gx, h * gy);
    const R0 = unit * (1.0 + 1.8 * p.sizeSpread);
    // A rhythmic progression of diminishing circles runs along one axis towards the open side.
    const pick = r();
    const sx = ax < w / 2 ? 1 : -1, sy = ay < h / 2 ? 1 : -1;
    const dir: [number, number] = pick < 0.6 ? [sx, sy] : pick < 0.8 ? [0, sy] : [sx, 0];
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    const q = 1 - 0.42 * p.sizeSpread;
    const nAxis = Math.max(1, Math.round(N * 0.6));
    let prevR = R0;
    const placed: { x: number; y: number; rad: number }[] = [];
    for (let j = 0; j < nAxis; j++) {
      const rad = Math.max(unit * 0.22, R0 * Math.pow(q, j));
      if (j > 0) {
        const step = Math.max(unit * 0.25, (prevR + rad) * (1 - p.overlap));
        let nx = ax + (dir[0] / dl) * step, ny = ay + (dir[1] / dl) * step;
        if (aligned) {
          // Advance along the axis in whole grid steps.
          const k = Math.max(1, Math.round(step / (Math.hypot(dir[0] * m, dir[1] * my) || 1)));
          nx = ax + dir[0] * m * k;
          ny = ay + dir[1] * my * k;
        }
        ax = nx; ay = ny;
      }
      prevR = rad;
      placed.push({ x: ax, y: ay, rad });
      const kind = j === 0 ? 'disc' : j % 3 === 1 ? 'ring' : j % 3 === 2 ? 'disc' : 'concentric';
      circle(ax, ay, rad, cols[j === 0 ? 0 : j % 2 ? 1 : 0], kind);
    }
    // Counterpoint: a few small rings and discs on free grid points, and a hairline halo.
    for (let i = nAxis; i < N; i++) {
      if (i === nAxis && r() < 0.6) {
        circle(placed[0].x, placed[0].y, R0 * (1.18 + 0.2 * r()), cols[0], 'hair');
        continue;
      }
      let best: { x: number; y: number; score: number } | null = null;
      const rad = unit * (0.25 + 0.6 * p.sizeSpread * r());
      for (let t = 0; t < 40; t++) {
        const [x, y] = snap(r() * w, r() * h);
        let score = Infinity;
        for (const c of placed) score = Math.min(score, Math.hypot(c.x - x, c.y - y) / Math.max(1e-6, (c.rad + rad) * (1 - p.overlap * 0.8)));
        if (!best || score > best.score) best = { x, y, score };
        if (score >= 1) break;
      }
      if (!best) continue;
      placed.push({ x: best.x, y: best.y, rad });
      const t = r();
      circle(best.x, best.y, rad, cols[t < 0.45 ? 2 : t < 0.75 ? 1 : 0], t < 0.4 ? 'disc' : t < 0.75 ? 'ring' : 'hair');
    }
    const out: Prim[] = [];
    if (ground) out.push({ t: 'path', d: box(el), fill: ground });
    out.push({ t: 'group', clip: box(el), children: prims });
    return out;
  },
};

/* ========================================================================== */
/* 11. Diagonal bars                                                           */
/* ========================================================================== */

function progression(kind: number, n: number): number[] {
  const out: number[] = [];
  if (kind === 1) {
    const q = n > 1 ? Math.pow(10, 1 / (n - 1)) : 1;
    for (let i = 0; i < n; i++) out.push(Math.pow(q, i));
  } else if (kind === 2) {
    // Fibonacci, restarting after ten terms so long runs stay legible.
    let a = 1, b = 1;
    for (let i = 0; i < n; i++) {
      if (i % 10 === 0) { a = 1; b = 1; }
      out.push(a);
      [a, b] = [b, a + b];
    }
  } else if (kind === 3) {
    for (let i = 0; i < n; i++) out.push(i % 2 ? 1 : 3);
  } else {
    for (let i = 0; i < n; i++) out.push(i + 1);
  }
  return out;
}

export const DIAGONAL_BARS: MotifDef = {
  kind: 'diagonal-bars',
  label: 'Diagonal bars',
  designer: 'bosshard',
  description:
    'Parallel diagonal bars whose widths follow a declared progression — arithmetic, geometric, Fibonacci or alternating — clipped by the format: a constructive exercise of the kind Hans Rudolf Bosshard taught at the Zurich Kunstgewerbeschule, where the rule is visible in the result.',
  defaultSize: { w: 300, h: 300 },
  colors: [
    { label: 'Bar', default: '#1b1813' },
    { label: 'Second bar', default: '#0050a0' },
    { label: 'Ground (empty = none)', default: '#f4f1ea' },
  ],
  params: [
    { key: 'angle', label: 'Angle °', min: -90, max: 90, step: 0.5, default: 45 },
    { key: 'progression', label: 'Progression', min: 0, max: 3, step: 1, default: 2, options: ['Arithmetic', 'Geometric', 'Fibonacci', 'Alternating'] },
    { key: 'count', label: 'Bars', min: 1, max: 60, step: 1, default: 7 },
    { key: 'gap', label: 'Gap pt', min: 0, max: 60, step: 0.5, default: 7 },
    { key: 'extent', label: 'Extent (× diagonal)', min: 0.1, max: 1, step: 0.01, default: 0.72 },
    { key: 'reverse', label: 'Reverse progression', min: 0, max: 1, step: 1, default: 0 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(DIAGONAL_BARS, el);
    const c1 = slot(DIAGONAL_BARS, el, 0), c2 = optSlot(DIAGONAL_BARS, el, 1) ?? c1, ground = optSlot(DIAGONAL_BARS, el, 2);
    const { w, h } = el;
    const th = p.angle * DEG;
    // Bar direction rises to the right for positive angles (y down on the page).
    const dx = Math.cos(th), dy = -Math.sin(th);
    const nx = -dy, ny = dx;
    const half = (Math.abs(nx) * w + Math.abs(ny) * h) / 2;
    const L = 2 * half * p.extent;
    const N = Math.round(p.count);
    let ws = progression(Math.round(p.progression), N);
    if (p.reverse >= 0.5) ws = ws.reverse();
    const sum = ws.reduce((a, b) => a + b, 0);
    let gap = p.gap;
    if (N > 1 && gap * (N - 1) > L * 0.6) gap = (L * 0.6) / (N - 1);
    const k = Math.max(0, L - gap * (N - 1)) / (sum || 1);
    const ext = Math.hypot(w, h);
    const ox = w / 2, oy = h / 2;
    const pens = [new Pen(), new Pen()];
    let u = -half;
    for (let i = 0; i < N; i++) {
      const bw = ws[i] * k;
      const u0 = u, u1 = u + bw;
      u = u1 + gap;
      if (bw <= 1e-4) continue;
      const pen = pens[i % 2];
      pen.poly([
        [ox + nx * u0 - dx * ext, oy + ny * u0 - dy * ext],
        [ox + nx * u0 + dx * ext, oy + ny * u0 + dy * ext],
        [ox + nx * u1 + dx * ext, oy + ny * u1 + dy * ext],
        [ox + nx * u1 - dx * ext, oy + ny * u1 - dy * ext],
      ], true);
    }
    const children: Prim[] = [];
    if (!pens[0].empty) children.push({ t: 'path', d: pens[0].d, fill: c1 });
    if (!pens[1].empty) children.push({ t: 'path', d: pens[1].d, fill: c2 });
    const out: Prim[] = [];
    if (ground) out.push({ t: 'path', d: box(el), fill: ground });
    out.push({ t: 'group', clip: box(el), children });
    return out;
  },
};

/* ========================================================================== */
/* 12. Concrete serial colour fields                                           */
/* ========================================================================== */

export const CONCRETE_FIELDS: MotifDef = {
  kind: 'concrete-fields',
  label: 'Serial colour fields',
  designer: 'bosshard',
  description:
    'A modular field of equal rectangles whose colours run through a fixed series by a stated rule — diagonal shift, mirrored row rotation, symmetry or spiral — after Richard Paul Lohse’s serial and modular orders, the Zurich Konkrete Kunst that Bosshard studied and taught.',
  defaultSize: { w: 300, h: 300 },
  colors: [
    { label: 'Series 1', default: '#c8202f' },
    { label: 'Series 2', default: '#e87425' },
    { label: 'Series 3', default: '#f2c230' },
    { label: 'Series 4', default: '#3b8f5a' },
    { label: 'Series 5', default: '#2a6cb3' },
    { label: 'Series 6', default: '#5d3a8e' },
    { label: 'Gaps (empty = none)', default: '#f4f1ea' },
  ],
  params: [
    { key: 'cols', label: 'Columns', min: 1, max: 24, step: 1, default: 6 },
    { key: 'rows', label: 'Rows', min: 1, max: 24, step: 1, default: 6 },
    { key: 'mode', label: 'Order', min: 0, max: 3, step: 1, default: 0, options: ['Diagonal shift', 'Row rotation', 'Symmetric', 'Spiral'] },
    { key: 'gap', label: 'Gap pt', min: 0, max: 24, step: 0.25, default: 0 },
    { key: 'series', label: 'Colours in series', min: 2, max: 24, step: 1, default: 6 },
    { key: 'step', label: 'Shift per step', min: 1, max: 11, step: 1, default: 1 },
  ],
  generate: (el) => {
    if (!okBox(el)) return [];
    const p = readMotifParams(CONCRETE_FIELDS, el);
    const pal = [0, 1, 2, 3, 4, 5].map((i) => slot(CONCRETE_FIELDS, el, i));
    const ground = optSlot(CONCRETE_FIELDS, el, 6);
    const { w, h } = el;
    const C = Math.round(p.cols), R = Math.round(p.rows);
    const S = Math.round(p.series);
    const step = Math.round(p.step);
    const mode = Math.round(p.mode);
    // The series: S colours spaced evenly round the palette circle (interpolated between slots).
    const series: string[] = [];
    for (let j = 0; j < S; j++) {
      const t = (j / S) * pal.length;
      const a = Math.floor(t), f = t - a;
      series.push(f < 1e-6 ? pal[a % pal.length] : mix(pal[a % pal.length], pal[(a + 1) % pal.length], f));
    }
    // Spiral order, outermost ring first, clockwise from the top left.
    const spiral = new Map<number, number>();
    if (mode === 3) {
      let top = 0, left = 0, bottom = R - 1, right = C - 1, k = 0;
      while (top <= bottom && left <= right) {
        for (let c = left; c <= right; c++) spiral.set(top * C + c, k++);
        for (let rr = top + 1; rr <= bottom; rr++) spiral.set(rr * C + right, k++);
        if (top < bottom) for (let c = right - 1; c >= left; c--) spiral.set(bottom * C + c, k++);
        if (left < right) for (let rr = bottom - 1; rr > top; rr--) spiral.set(rr * C + left, k++);
        top++; left++; bottom--; right--;
      }
    }
    const index = (c: number, rr: number): number => {
      // Row rotation: the series runs on row after row, turning back at each end.
      if (mode === 1) return (rr * C + (rr % 2 ? C - 1 - c : c)) * step;
      if (mode === 2) return (Math.min(c, C - 1 - c) + Math.min(rr, R - 1 - rr)) * step;
      if (mode === 3) return (spiral.get(rr * C + c) ?? 0) * step;
      return c + rr * step;
    };
    const gap = Math.min(p.gap, (w / C) * 0.45, (h / R) * 0.45);
    const cw = (w - gap * (C - 1)) / C, ch = (h - gap * (R - 1)) / R;
    const pens = new Map<number, Pen>();
    for (let rr = 0; rr < R; rr++) {
      for (let c = 0; c < C; c++) {
        const k = ((index(c, rr) % S) + S) % S;
        let pen = pens.get(k);
        if (!pen) { pen = new Pen(); pens.set(k, pen); }
        // Without gaps, cells overlap by a hair so no seams show between fields.
        const e = gap > 0 ? 0 : 0.05;
        pen.rect(c * (cw + gap) - (c ? e : 0), rr * (ch + gap) - (rr ? e : 0), cw + (c ? e : 0), ch + (rr ? e : 0));
      }
    }
    const out: Prim[] = [];
    if (ground && gap > 0) out.push({ t: 'path', d: box(el), fill: ground });
    for (const [k, pen] of [...pens.entries()].sort((a, b) => a[0] - b[0])) out.push({ t: 'path', d: pen.d, fill: series[k] });
    return out;
  },
};
