/**
 * Drawing kit shared by the teaching diagrams: measured label runs, unit formatting,
 * fitting, technical dimension lines and a final sanitising pass. Everything is pure.
 *
 * House style: hairlines 0.25–0.5 pt, labels in IBM Plex Mono / Inter at 5.5–7 pt,
 * construction in vermilion, grids in a light blue, structure in warm black.
 */
import type { MotifElement, Unit } from '../../model/types';
import { fromPt } from '../../model/units';
import type { FontRef, PathPrim, Prim, TextRun } from '../../render/primitives';
import { Pen } from '../generators/util';
import type { MotifContext, MotifDef } from './types';
import { motifParams } from './types';

/* -------------------------------------------------------------------------- */
/* Palette & weights                                                           */
/* -------------------------------------------------------------------------- */

export const INK = '#1b1813';
export const RED = '#d9532f';
export const BLUE = '#4a8fd9';
export const GREY = '#8a8478';
export const PAPER = '#f4efe3';

/** Faint grid / baseline line. */
export const FINE = 0.3;
/** Construction hairline. */
export const HAIR = 0.35;
/** Outlines of the drawn object. */
export const RULE = 0.5;

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const finite = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);
export const choice = (v: number, lo: number, hi: number) => clamp(Math.round(finite(v, lo)), lo, hi);

/** Decimal places that read naturally for each display unit. */
export const UNIT_PLACES: Record<Unit, number> = { mm: 1, cm: 2, in: 2, pt: 1, pc: 2, px: 0 };

/** A number with typographic minus; trailing zeros trimmed unless `fixed`. */
export function fmtNum(v: number, places: number, fixed = false): string {
  if (!Number.isFinite(v)) return '–';
  let s = v.toFixed(clamp(Math.round(places), 0, 6));
  if (!fixed && s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
  return s.replace('-', '−');
}

/** A length (pt) in the document unit, e.g. `12.5 mm`, `0.75 in`, `36 pt`. */
export function fmtLen(pt: number, unit: Unit, places?: number, fixed = false): string {
  return `${fmtNum(fromPt(pt, unit), places ?? UNIT_PLACES[unit], fixed)} ${unit}`;
}

/** Two lengths sharing one unit, e.g. `144 × 216 mm`. */
export function fmtSize(a: number, b: number, unit: Unit, places?: number): string {
  const p = places ?? UNIT_PLACES[unit];
  return `${fmtNum(fromPt(a, unit), p)} × ${fmtNum(fromPt(b, unit), p)} ${unit}`;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export type Align = 'left' | 'center' | 'right';

export interface LabelFonts {
  mono: FontRef;
  sans: FontRef;
  bold: FontRef;
}

export const labelFonts = (ctx: MotifContext): LabelFonts => ({
  mono: ctx.font('ibm-plex-mono', 400),
  sans: ctx.font('inter', 400),
  bold: ctx.font('inter', 600),
});

/**
 * Advance width including letter-spacing (the back-ends add it after every glyph).
 * Measures with a throwaway feature set: fontkit writes every feature it plans into the
 * object it is given, and the SVG back-end would then switch on e.g. `numr` for all digits.
 */
export function textWidth(ctx: MotifContext, text: string, font: FontRef, size: number, ls = 0): number {
  if (!text || !(size > 0)) return 0;
  const w = ctx.measure(text, { ...font, features: { ...font.features } }, size) + ls * Array.from(text).length;
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/** A measured horizontal run aligned on x. */
export function run(
  ctx: MotifContext, text: string, font: FontRef, size: number, x: number, y: number,
  color: string, align: Align = 'left', ls = 0,
): TextRun {
  const width = textWidth(ctx, text, font, size, ls);
  const x0 = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  const r: TextRun = { x: x0, y, text, font, size, color, width };
  if (ls) r.letterSpacing = ls;
  return r;
}

/** A run reading bottom-to-top, its glyphs centred on (cx, cy). */
export function vrun(ctx: MotifContext, text: string, font: FontRef, size: number, cx: number, cy: number, color: string, cap = 0.7): TextRun {
  const width = textWidth(ctx, text, font, size);
  return { x: cx + (size * cap) / 2, y: cy + width / 2, text, font, size, color, width, rotate: -90 };
}

/** A run turned 180° (head-to-head imposition), its glyphs centred on (cx, cy). */
export function invertedRun(ctx: MotifContext, text: string, font: FontRef, size: number, cx: number, cy: number, color: string, cap = 0.7): TextRun {
  const width = textWidth(ctx, text, font, size);
  return { x: cx + width / 2, y: cy - (size * cap) / 2, text, font, size, color, width, rotate: 180 };
}

export const textPrim = (runs: TextRun[], opacity?: number): Prim[] =>
  runs.length ? [opacity != null && opacity < 1 ? { t: 'text', runs, opacity } : { t: 'text', runs }] : [];

/** Longest prefix (whole graphemes) that fits `maxW`; trailing spaces dropped. */
export function truncate(ctx: MotifContext, text: string, font: FontRef, size: number, maxW: number, ls = 0): string {
  if (!(maxW > 0) || !text) return '';
  if (textWidth(ctx, text, font, size, ls) <= maxW) return text;
  const g = Array.from(text);
  let lo = 0, hi = g.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(ctx, g.slice(0, mid).join(''), font, size, ls) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return g.slice(0, lo).join('').replace(/\s+$/, '');
}

/**
 * Like `truncate`, but ends on a whole word when that keeps at least `minFill` of the
 * measure — a specimen line should stop at a word, not in the middle of one.
 */
export function truncateWords(ctx: MotifContext, text: string, font: FontRef, size: number, maxW: number, ls = 0, minFill = 0.6): string {
  const t = truncate(ctx, text, font, size, maxW, ls);
  if (t === text || !t) return t;
  const cut = t.lastIndexOf(' ');
  if (cut <= 0) return t;
  const words = t.slice(0, cut).replace(/[\s—–-]+$/, '');
  return words && textWidth(ctx, words, font, size, ls) >= maxW * minFill ? words : t;
}

/** A label that fits `maxW`, shortened with an ellipsis when it must be. */
export function fitLabel(ctx: MotifContext, text: string, font: FontRef, size: number, maxW: number): string {
  if (textWidth(ctx, text, font, size) <= maxW) return text;
  const t = truncate(ctx, text, font, size, maxW - textWidth(ctx, '…', font, size));
  return t ? `${t}…` : '';
}

/** Greedy word wrap into at most `maxLines` lines (the last one ellipsised if needed). */
export function wrapText(ctx: MotifContext, text: string, font: FontRef, size: number, maxW: number, maxLines: number): string[] {
  if (maxLines < 1 || !(maxW > 0)) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur || textWidth(ctx, t, font, size) <= maxW) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitLabel(ctx, lines.slice(maxLines - 1).join(' '), font, size, maxW);
    return kept.filter(Boolean);
  }
  return lines.map((l) => fitLabel(ctx, l, font, size, maxW)).filter(Boolean);
}

/** Optical-size ranges of the bundled variable families with an `opsz` axis. */
const OPSZ: Record<string, [number, number]> = { fraunces: [9, 144], inter: [14, 32] };

/** Set `opsz` to the nominal type size, as the text engine does for text frames. */
export function opticalFont(font: FontRef, size: number): FontRef {
  const r = OPSZ[font.family];
  if (!r || !('opsz' in font.axes)) return font;
  return { ...font, axes: { ...font.axes, opsz: clamp(size, r[0], r[1]) } };
}

/** Clamp-safe font metrics (em fractions, descender positive). */
export function safeMetrics(ctx: MotifContext, font: FontRef) {
  const m = ctx.metrics(font);
  const asc = clamp(finite(m.ascender, 0.8), 0.4, 1.6);
  const desc = clamp(Math.abs(finite(m.descender, -0.22)), 0.02, 0.8);
  const cap = clamp(finite(m.capHeight, 0.68), 0.2, asc);
  const xh = clamp(finite(m.xHeight, 0.45), 0.1, cap);
  return { asc, desc, cap, xh };
}

/** Label size scaled down for small boxes; 0 = too small to be legible, omit. */
export function labelSize(w: number, h: number, base: number, ref: number): number {
  const s = base * Math.min(1, Math.min(w, h) / ref);
  return s >= 3 ? s : 0;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

export function stroke(pen: Pen | string, color: string, width: number, extra: Partial<PathPrim> = {}): Prim[] {
  const d = typeof pen === 'string' ? pen : pen.d;
  if (!d || !(width > 0)) return [];
  return [{ t: 'path', d, fill: null, stroke: color, strokeWidth: width, cap: 'butt', join: 'miter', ...extra }];
}

export function fill(pen: Pen | string, color: string, opacity?: number, extra: Partial<PathPrim> = {}): Prim[] {
  const d = typeof pen === 'string' ? pen : pen.d;
  if (!d) return [];
  const p: PathPrim = { t: 'path', d, fill: color, stroke: null, ...extra };
  if (opacity != null && opacity < 1) p.opacity = opacity;
  return [p];
}

/** Closed arrowhead with its tip at (tx, ty) pointing along the unit vector (ux, uy). */
export function arrowHead(pen: Pen, tx: number, ty: number, ux: number, uy: number, len: number, half: number): Pen {
  const bx = tx - ux * len, by = ty - uy * len;
  return pen.move(tx, ty).line(bx - uy * half, by + ux * half).line(bx + uy * half, by - ux * half).close();
}

/** Uniform scale and offset that fit a cw × ch content box centred into a region. */
export function fitBox(cw: number, ch: number, x: number, y: number, w: number, h: number) {
  const s = cw > 0 && ch > 0 ? Math.max(0, Math.min(w / cw, h / ch)) : 0;
  const k = Number.isFinite(s) ? s : 0;
  return { s: k, ox: x + (w - cw * k) / 2, oy: y + (h - ch * k) / 2 };
}

/** Largest k in [0, hi] for which `fits(k)` holds (monotone predicate). */
export function bisect(fits: (k: number) => boolean, hi = 1000): number {
  if (fits(hi)) return hi;
  let lo = 0;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/* -------------------------------------------------------------------------- */
/* Dimension lines                                                             */
/* -------------------------------------------------------------------------- */

/** 0 = closed arrows (engineering), 1 = 45° ticks (architectural), 2 = dots. */
export type Terminator = 0 | 1 | 2;

export interface DimStyle {
  ctx: MotifContext;
  font: FontRef;
  /** Label size, pt (0 = no label). */
  size: number;
  color: string;
  term: Terminator;
  /** Size factor of the terminators. */
  k?: number;
  width?: number;
}

function terminator(st: DimStyle, x: number, y: number, ux: number, uy: number, arrows: Pen, ticks: Pen, dots: Pen) {
  const k = st.k ?? 1;
  if (st.term === 0) arrowHead(arrows, x, y, ux, uy, 3.6 * k, 1.05 * k);
  else if (st.term === 1) {
    const t = 2.1 * k;
    // The tick always leans like '/', whatever the line direction.
    ticks.move(x - t, y + t).line(x + t, y - t);
  } else dots.circle(x, y, 1.1 * k);
}

function dimPrims(st: DimStyle, line: Pen, arrows: Pen, ticks: Pen, dots: Pen): Prim[] {
  const lw = st.width ?? HAIR;
  return [
    ...stroke(line, st.color, lw),
    ...fill(arrows, st.color),
    ...stroke(ticks, st.color, Math.max(0.6, lw * 2.4), { cap: 'round' }),
    ...fill(dots, st.color),
  ];
}

/**
 * Horizontal dimension from x1 to x2 at y. The label sits centred above (or below) the
 * line; when it does not fit between the terminators it moves past the right end, or
 * stays centred (`overflow: 'center'`) where the neighbours leave room above.
 */
export function dimH(st: DimStyle, x1: number, x2: number, y: number, label: string, below = false, overflow: 'after' | 'center' = 'after'): Prim[] {
  if (!(x2 - x1 > 0)) return [];
  const L = x2 - x1;
  const k = st.k ?? 1;
  const a = st.term === 0 ? 3.6 * k : st.term === 1 ? 2.1 * k : 1.1 * k;
  const line = new Pen(), arrows = new Pen(), ticks = new Pen(), dots = new Pen();
  const outside = st.term === 0 && L < 2 * a + 1;
  if (outside) {
    // Short span: arrows outside pointing in (ISO 129).
    line.move(x1 - a * 2, y).line(x2 + a * 2, y);
    terminator(st, x1, y, -1, 0, arrows, ticks, dots);
    terminator(st, x2, y, 1, 0, arrows, ticks, dots);
  } else {
    line.move(x1, y).line(x2, y);
    terminator(st, x1, y, -1, 0, arrows, ticks, dots);
    terminator(st, x2, y, 1, 0, arrows, ticks, dots);
  }
  const out = dimPrims(st, line, arrows, ticks, dots);
  if (st.size > 0 && label) {
    const lw = textWidth(st.ctx, label, st.font, st.size);
    const room = outside ? 0 : L - (st.term === 0 ? 2 * a : 2 * a) - 2;
    const cap = st.size * 0.7;
    if (lw <= room || overflow === 'center') {
      const by = below ? y + 2 + cap : y - 2;
      out.push(...textPrim([run(st.ctx, label, st.font, st.size, (x1 + x2) / 2, by, st.color, 'center')]));
    } else {
      const xr = x2 + (outside ? a * 2 : a) + 2;
      out.push(...textPrim([run(st.ctx, label, st.font, st.size, xr, y + cap / 2, st.color)]));
    }
  }
  return out;
}

/**
 * Vertical dimension from y1 to y2 at x; the label reads bottom-to-top on the given
 * side, or sits horizontally beside the middle when the span is too short.
 */
export function dimV(st: DimStyle, x: number, y1: number, y2: number, label: string, side: 'left' | 'right' = 'right'): Prim[] {
  if (!(y2 - y1 > 0)) return [];
  const L = y2 - y1;
  const k = st.k ?? 1;
  const a = st.term === 0 ? 3.6 * k : st.term === 1 ? 2.1 * k : 1.1 * k;
  const line = new Pen(), arrows = new Pen(), ticks = new Pen(), dots = new Pen();
  const outside = st.term === 0 && L < 2 * a + 1;
  line.move(x, outside ? y1 - a * 2 : y1).line(x, outside ? y2 + a * 2 : y2);
  terminator(st, x, y1, 0, -1, arrows, ticks, dots);
  terminator(st, x, y2, 0, 1, arrows, ticks, dots);
  const out = dimPrims(st, line, arrows, ticks, dots);
  if (st.size > 0 && label) {
    const lw = textWidth(st.ctx, label, st.font, st.size);
    const cap = st.size * 0.7;
    const cy = (y1 + y2) / 2;
    if (!outside && lw <= L - 2 * a - 2) {
      const cx = side === 'right' ? x + 2 + cap / 2 : x - 2 - cap / 2;
      out.push(...textPrim([vrun(st.ctx, label, st.font, st.size, cx, cy, st.color)]));
    } else {
      const xr = side === 'right' ? x + 3 : x - 3;
      out.push(...textPrim([run(st.ctx, label, st.font, st.size, xr, cy + cap / 2, st.color, side === 'right' ? 'left' : 'right')]));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

const bad = (n: unknown) => typeof n !== 'number' || !Number.isFinite(n);
const badPath = (d: string) => /NaN|Infinity/.test(d);

/** Drop any primitive that carries a non-finite coordinate (the PDF writer cannot recover). */
export function sanitize(prims: Prim[]): Prim[] {
  const out: Prim[] = [];
  for (const p of prims) {
    if (p.opacity != null && bad(p.opacity)) continue;
    if (p.t === 'path') {
      if (!p.d || badPath(p.d) || (p.strokeWidth != null && bad(p.strokeWidth))) continue;
      if (p.dash && p.dash.some(bad)) continue;
      out.push(p);
    } else if (p.t === 'text') {
      const runs = p.runs.filter((r) =>
        !!r.text && !bad(r.x) && !bad(r.y) && !bad(r.width) && r.size > 0 && !bad(r.size)
        && (r.rotate == null || !bad(r.rotate)) && (r.letterSpacing == null || !bad(r.letterSpacing)));
      if (runs.length) out.push(runs.length === p.runs.length ? p : { ...p, runs });
    } else if (p.t === 'group') {
      if ((p.matrix && p.matrix.some(bad)) || (p.clip && badPath(p.clip))) continue;
      const children = sanitize(p.children);
      if (children.length) out.push({ ...p, children });
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * fontkit writes every feature it plans — `frac`, `numr`, `dnom` among them — into the
 * feature object of the FontRef it shapes, and the SVG back-end then turns those on for the
 * whole run, so all digits render as numerators. Features switched off explicitly are left
 * alone, which keeps these runs correct however often a back-end shapes them.
 */
export function noFractions(font: FontRef): FontRef {
  return { ...font, features: { frac: false, numr: false, dnom: false, ...font.features } };
}

export type Params = Record<string, number>;

/**
 * Wrap a drawing function as a motif generator: normalise the element, read clamped
 * params, refuse degenerate boxes and sanitise the result.
 */
export function generator(
  getDef: () => MotifDef,
  draw: (el: MotifElement, ctx: MotifContext, p: Params, def: MotifDef) => Prim[],
): MotifDef['generate'] {
  return (el, ctx) => {
    if (!(Number.isFinite(el.w) && Number.isFinite(el.h) && el.w > 0 && el.h > 0)) return [];
    const def = getDef();
    const fctx: MotifContext = { ...ctx, font: (family, weight, italic) => noFractions(ctx.font(family, weight, italic)) };
    const safe: MotifElement = {
      ...el,
      colors: Array.isArray(el.colors) ? el.colors : [],
      params: el.params ?? {},
      text: typeof el.text === 'string' ? el.text : '',
      fontFamily: el.fontFamily || def.fontFamily || 'inter',
    };
    return sanitize(draw(safe, fctx, motifParams(def, safe.params), def));
  };
}

/** Binary on/off choice labels. */
export const ONOFF = ['Off', 'On'];
