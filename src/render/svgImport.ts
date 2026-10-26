/**
 * Import uploaded SVG markup as vector primitives (so it stays vector in the PDF), or explode
 * it into editable path elements.
 *
 * Read: shapes and paths with their transforms; fill and stroke (colours, and linear and radial
 * gradients with their units, transforms, spread and stop opacity, `href` inheritance included);
 * opacity, dashes and caps; `<style>` sheets; and text (`<text>`, `<tspan>`, `<textPath>`), set in
 * the closest bundled family. Not read: `<use>`, images, clips, masks, patterns (a flat colour)
 * and filters.
 */
import type { FontRef, GradientStop, Matrix, Paint, PathPrim, Prim, RadialGradientPaint, TextRun } from './primitives';
import { IDENTITY, multiply, translate, scale, rotate, ellipsePath, rectPath, applyMatrix, invert } from './primitives';
import { parsePath, pathBounds, transformPath } from '../lib/pathData';
import { mix, parseColor, toHex } from '../lib/color';
import { ensureFamily, fontMetrics, getFamilies, getFamily, measure, resolveFont } from '../engine/fonts';

type Box = { x: number; y: number; w: number; h: number };

/** A shape in viewBox units, its transforms baked in. */
export interface SvgShape extends PathPrim {
  /**
   * An elliptical radial fill (a radial gradient seen through a non-uniform scale or a skew):
   * `fill` is then a circle in the space this linear map takes to viewBox units.
   */
  fillSpace?: Matrix;
}

interface SpanStyle {
  /** The CSS font-family list, matched to a bundled family when placed. */
  family: string;
  weight: number;
  italic: boolean;
  smallCaps: boolean;
  /** User units. */
  size: number;
  fill: string | null;
  stroke: { color: string; width: number } | null;
  letterSpacing: number;
  anchor: 'start' | 'middle' | 'end';
  /** dominant-baseline / alignment-baseline keyword. */
  baseline: string;
  /** baseline-shift, user units, positive raises. */
  shift: number;
}

interface SvgTextPath { d: string; start: number; percent: boolean }

interface SvgSpan extends SpanStyle {
  text: string;
  /** Absolute position before the span (text user space): starts a new chunk. */
  x?: number;
  y?: number;
  dx: number;
  dy: number;
  /** Rotation of each glyph (the span is then one character). */
  rotate?: number;
  /** Type on a path: shared by every span of one `<textPath>`. */
  path?: SvgTextPath;
}

/** A `<text>` element. Its spans are measured and placed with real fonts when the SVG is placed. */
export interface SvgText {
  t: 'svgtext';
  /** Text user space → viewBox units. */
  matrix: Matrix;
  opacity: number;
  spans: SvgSpan[];
}

export type SvgItem = SvgShape | SvgText;

export interface ParsedSvg {
  viewBox: { x: number; y: number; w: number; h: number };
  /** Everything drawn, in paint order: shapes (viewBox units, transforms baked in) and text. */
  paths: SvgItem[];
}

function parseTransform(t: string | null): Matrix {
  if (!t) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(t))) {
    const v = x[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Matrix = IDENTITY;
    switch (x[1]) {
      case 'matrix': n = [v[0], v[1], v[2], v[3], v[4], v[5]]; break;
      case 'translate': n = translate(v[0] || 0, v[1] || 0); break;
      case 'scale': n = scale(v[0], v[1] ?? v[0]); break;
      case 'rotate': n = rotate(v[0], v[1] || 0, v[2] || 0); break;
      case 'skewX': n = [1, 0, Math.tan((v[0] * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan((v[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    if (n.every(Number.isFinite)) m = multiply(m, n);
  }
  return m;
}

const localName = (el: Element) => (el.localName || el.nodeName).toLowerCase().replace(/^svg:/, '');
const XLINK = 'http://www.w3.org/1999/xlink';
const hrefOf = (el: Element) => (el.getAttribute('href') ?? el.getAttributeNS(XLINK, 'href') ?? el.getAttribute('xlink:href') ?? '').trim();

function byId(doc: Document, id: string): Element | null {
  if (!id) return null;
  try {
    return doc.getElementById(id) ?? doc.querySelector(`[id="${CSS.escape(id)}"]`);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Styles: presentation attributes < <style> rules < style=""                  */
/* -------------------------------------------------------------------------- */

const PRESENTATION = new Set([
  'fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'display', 'visibility',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'color', 'stop-color', 'stop-opacity',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-anchor', 'letter-spacing',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'white-space',
]);

interface CssRule { sel: string; spec: number; order: number; decls: Record<string, string> }

function parseDecls(text: string, into: Record<string, string>) {
  for (const decl of text.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).replace(/!important/i, '').trim();
    if (k && v) into[k] = v;
  }
}

function specificity(sel: string): number {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

/** The rules of every `<style>` sheet (at-rules skipped). */
function parseSheets(doc: Document): CssRule[] {
  const rules: CssRule[] = [];
  for (const style of Array.from(doc.getElementsByTagName('style'))) {
    const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      let depth = 1, j = open + 1;
      while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
      // Statements such as @import …; end before the selector.
      const head = css.slice(i, open).split(';').pop()!.trim();
      const body = css.slice(open + 1, j - 1);
      i = j;
      if (!head || head.startsWith('@')) continue;
      const decls: Record<string, string> = {};
      parseDecls(body, decls);
      for (const sel of head.split(',')) {
        const s = sel.trim();
        if (s) rules.push({ sel: s, spec: specificity(s), order: rules.length, decls });
      }
    }
  }
  return rules;
}

function matches(el: Element, sel: string): boolean {
  // Type, class and id selectors by hand: they also match in a file without the SVG namespace.
  const simple = /^([a-z][\w-]*|\*)?((?:[#.][\w-]+)*)$/i.exec(sel);
  if (simple) {
    if (simple[1] && simple[1] !== '*' && localName(el) !== simple[1].toLowerCase()) return false;
    const classes = (el.getAttribute('class') ?? '').split(/\s+/);
    for (const part of simple[2].match(/[#.][\w-]+/g) ?? []) {
      if (part[0] === '#' ? el.getAttribute('id') !== part.slice(1) : !classes.includes(part.slice(1))) return false;
    }
    return true;
  }
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

function styleMap(el: Element, rules: CssRule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (PRESENTATION.has(a.name)) out[a.name] = a.value.trim();
  if (rules.length) {
    const hit = rules.filter((r) => matches(el, r.sel)).sort((a, b) => a.spec - b.spec || a.order - b.order);
    for (const r of hit) Object.assign(out, r.decls);
  }
  const style = el.getAttribute('style');
  if (style) parseDecls(style, out);
  if (out.font) expandFont(out.font, out);
  return out;
}

/** The `font` shorthand ([style] [variant] [weight] size[/line-height] family), where longhands are absent. */
function expandFont(v: string, out: Record<string, string>) {
  const m = /^((?:(?:italic|oblique|normal|small-caps|bold|bolder|lighter|[1-9]00)\s+)*)([\d.]+[a-z%]*|[a-z-]+-(?:small|large)|medium|smaller|larger)(?:\/\S+)?\s+(.+)$/i.exec(v.trim());
  if (!m) return;
  const pre = m[1].toLowerCase();
  if (/italic|oblique/.test(pre)) out['font-style'] ??= 'italic';
  if (/small-caps/.test(pre)) out['font-variant'] ??= 'small-caps';
  const w = /\b(bold|bolder|lighter|[1-9]00)\b/.exec(pre);
  if (w) out['font-weight'] ??= w[1];
  out['font-size'] ??= m[2];
  out['font-family'] ??= m[3];
}

/* -------------------------------------------------------------------------- */
/* Inherited properties                                                        */
/* -------------------------------------------------------------------------- */

/** A paint as declared: a colour, a reference (with its fallback), or none. */
type PaintSpec = string | { url: string; fallback: string | null } | null;

interface Inherited {
  fill: PaintSpec; stroke: PaintSpec; color: string;
  sw: number; opacity: number; fillOpacity: number; strokeOpacity: number; rule: 'nonzero' | 'evenodd'; visible: boolean;
  fontFamily: string; fontSize: number; fontWeight: number; italic: boolean; smallCaps: boolean;
  anchor: 'start' | 'middle' | 'end'; letterSpacing: number; baseline: string; preserve: boolean;
}

const ROOT: Inherited = {
  fill: '#000', stroke: null, color: '#000', sw: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, rule: 'nonzero', visible: true,
  // A browser's default for SVG text: 16px serif.
  fontFamily: 'serif', fontSize: 16, fontWeight: 400, italic: false, smallCaps: false, anchor: 'start', letterSpacing: 0, baseline: 'auto', preserve: false,
};

function paintSpec(v: string | undefined, inh: PaintSpec, color: string): PaintSpec {
  if (v == null || v === 'inherit') return inh;
  if (v === 'none' || v === 'transparent') return null;
  const url = /^url\(\s*['"]?([^'")]*?)['"]?\s*\)\s*(.*)$/i.exec(v);
  if (url) {
    const fb = url[2].trim();
    const fallback = !fb || fb === 'none' ? null : /^currentcolor$/i.test(fb) ? color : fb;
    return url[1].startsWith('#') ? { url: url[1].slice(1), fallback } : fallback;
  }
  if (/^currentcolor$/i.test(v)) return color;
  return v;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
function opacityOf(v: string | undefined, dflt = 1): number {
  if (v == null || v === 'inherit') return dflt;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return clamp01(v.trim().endsWith('%') ? n / 100 : n);
}

const FONT_SIZES: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };

/** A length in user units (px); `em` and `%` relative to `em`. */
function cssLength(v: string, em: number): number {
  const m = /^(-?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)$/i.exec(v.trim());
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case '': case 'px': return n;
    case 'pt': return (n * 4) / 3;
    case 'pc': return n * 16;
    case 'mm': return (n * 96) / 25.4;
    case 'cm': return (n * 96) / 2.54;
    case 'in': return n * 96;
    case 'em': return n * em;
    case 'ex': return n * em * 0.5;
    case 'rem': return n * 16;
    case '%': return (n / 100) * em;
    default: return n;
  }
}

function fontSizeOf(v: string, inh: number): number {
  const k = v.trim().toLowerCase();
  if (FONT_SIZES[k]) return FONT_SIZES[k];
  if (k === 'larger') return inh * 1.2;
  if (k === 'smaller') return inh / 1.2;
  const n = cssLength(k, inh);
  return Number.isFinite(n) && n > 0 ? n : inh;
}

function fontWeightOf(v: string | undefined, inh: number): number {
  if (!v) return inh;
  const k = v.trim().toLowerCase();
  if (k === 'normal') return 400;
  if (k === 'bold') return 700;
  if (k === 'bolder') return inh < 350 ? 400 : inh < 550 ? 700 : 900;
  if (k === 'lighter') return inh < 550 ? 100 : inh < 750 ? 400 : 700;
  const n = parseFloat(k);
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : inh;
}

function inherit(st: Record<string, string>, inh: Inherited, el: Element): Inherited {
  const color = st.color && st.color !== 'inherit' && !/^currentcolor$/i.test(st.color) ? st.color : inh.color;
  const fontSize = st['font-size'] ? fontSizeOf(st['font-size'], inh.fontSize) : inh.fontSize;
  const num = (v: string | undefined, d: number) => { const n = v == null ? NaN : parseFloat(v); return Number.isFinite(n) ? n : d; };
  const anchor = st['text-anchor'];
  const ls = st['letter-spacing'];
  const space = el.getAttribute('xml:space') ?? el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space');
  const ws = st['white-space'];
  return {
    fill: paintSpec(st.fill, inh.fill, color),
    stroke: paintSpec(st.stroke, inh.stroke, color),
    color,
    sw: num(st['stroke-width'], inh.sw),
    opacity: inh.opacity * opacityOf(st.opacity),
    fillOpacity: opacityOf(st['fill-opacity'], inh.fillOpacity),
    strokeOpacity: opacityOf(st['stroke-opacity'], inh.strokeOpacity),
    rule: st['fill-rule'] === 'evenodd' || st['fill-rule'] === 'nonzero' ? st['fill-rule'] : inh.rule,
    visible: st.visibility && st.visibility !== 'inherit' ? st.visibility === 'visible' : inh.visible,
    fontFamily: st['font-family'] && st['font-family'] !== 'inherit' ? st['font-family'] : inh.fontFamily,
    fontSize,
    fontWeight: fontWeightOf(st['font-weight'], inh.fontWeight),
    italic: st['font-style'] && st['font-style'] !== 'inherit' ? /italic|oblique/i.test(st['font-style']) : inh.italic,
    smallCaps: st['font-variant'] && st['font-variant'] !== 'inherit' ? /small-caps/i.test(st['font-variant']) : inh.smallCaps,
    anchor: anchor === 'start' || anchor === 'middle' || anchor === 'end' ? anchor : inh.anchor,
    letterSpacing: ls == null || ls === 'inherit' ? inh.letterSpacing : ls === 'normal' ? 0 : ((n) => (Number.isFinite(n) ? n : inh.letterSpacing))(cssLength(ls, fontSize)),
    baseline: (st['alignment-baseline'] ?? st['dominant-baseline'] ?? inh.baseline).toLowerCase(),
    preserve: space ? space === 'preserve' : ws ? /^pre/.test(ws) : inh.preserve,
  };
}

/* -------------------------------------------------------------------------- */
/* Gradients                                                                   */
/* -------------------------------------------------------------------------- */

interface GradientDef {
  kind: 'linear' | 'radial';
  bboxUnits: boolean;
  transform: Matrix;
  spread: 'pad' | 'reflect' | 'repeat';
  attrs: Record<string, string>;
  stops: GradientStop[];
}

interface Ctx {
  doc: Document;
  rules: CssRule[];
  vb: { w: number; h: number };
  gradients: Map<string, GradientDef | null>;
  /** Characters of text still to read: a huge text (or an entity bomb) stops there. */
  budget: number;
}

const LINEAR_ATTRS = ['x1', 'y1', 'x2', 'y2'];
const RADIAL_ATTRS = ['cx', 'cy', 'r', 'fx', 'fy', 'fr'];

/** A gradient with everything it inherits through `href` (attributes, and stops when it has none). */
function gradientDef(id: string, ctx: Ctx): GradientDef | null {
  if (ctx.gradients.has(id)) return ctx.gradients.get(id)!;
  const chain: Element[] = [];
  const seen = new Set<Element>();
  for (let el = byId(ctx.doc, id); el && !seen.has(el) && chain.length < 32; el = byId(ctx.doc, hrefOf(el).replace(/^#/, ''))) {
    seen.add(el);
    const tag = localName(el);
    if (tag !== 'lineargradient' && tag !== 'radialgradient') break;
    chain.push(el);
  }
  let def: GradientDef | null = null;
  if (chain.length) {
    const kind = localName(chain[0]) === 'lineargradient' ? 'linear' : 'radial';
    const own = kind === 'linear' ? LINEAR_ATTRS : RADIAL_ATTRS;
    const attr = (name: string, sameKind: boolean) => {
      for (const el of chain) {
        if (sameKind && localName(el) !== localName(chain[0])) continue;
        const v = el.getAttribute(name);
        if (v != null && v.trim()) return v.trim();
      }
      return undefined;
    };
    const attrs: Record<string, string> = {};
    for (const a of own) { const v = attr(a, true); if (v != null) attrs[a] = v; }
    const stopsEl = chain.find((el) => Array.from(el.children).some((c) => localName(c) === 'stop'));
    const stops: GradientStop[] = [];
    let last = 0;
    for (const s of stopsEl ? Array.from(stopsEl.children).filter((c) => localName(c) === 'stop') : []) {
      const st = styleMap(s, ctx.rules);
      const raw = s.getAttribute('offset') ?? st.offset ?? '0';
      let off = parseFloat(raw);
      off = clamp01(Number.isFinite(off) ? (raw.trim().endsWith('%') ? off / 100 : off) : 0);
      // Offsets never go back (SVG: a smaller one takes the previous one's).
      off = Math.max(off, last);
      last = off;
      let cs = st['stop-color'] ?? 'black';
      if (/^currentcolor$/i.test(cs)) cs = st.color ?? '#000';
      const c = parseColor(cs);
      const opacity = clamp01((Number.isFinite(c.a) ? c.a : 1) * opacityOf(st['stop-opacity']));
      stops.push({ offset: off, color: toHex(c), ...(opacity < 1 ? { opacity } : {}) });
    }
    const spread = attr('spreadMethod', false);
    def = {
      kind,
      bboxUnits: attr('gradientUnits', false) !== 'userSpaceOnUse',
      transform: parseTransform(attr('gradientTransform', false) ?? null),
      spread: spread === 'reflect' || spread === 'repeat' ? spread : 'pad',
      attrs,
      stops,
    };
  }
  ctx.gradients.set(id, def);
  return def;
}

/** A stop's colour as CSS (its opacity folded in). */
function stopCss(s: GradientStop): string {
  if (s.opacity == null || s.opacity >= 1) return s.color;
  const { r, g, b } = parseColor(s.color);
  return `rgba(${r},${g},${b},${+s.opacity.toFixed(3)})`;
}

/** The colour halfway along a gradient: what text (which takes one colour) is set in. */
function colourAt(stops: GradientStop[], t: number): string {
  if (!stops.length) return '#000000';
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].offset < t) i++;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  if (a === b || t <= a.offset) return stopCss(a);
  if (t >= b.offset) return stopCss(b);
  const k = (t - a.offset) / (b.offset - a.offset || 1);
  const opacity = (a.opacity ?? 1) + ((b.opacity ?? 1) - (a.opacity ?? 1)) * k;
  return stopCss({ offset: t, color: mix(a.color, b.color, k), opacity });
}

/** A gradient coordinate: user units, or a fraction of the bounding box; percentages of either. */
function gradientLength(v: string | undefined, dflt: string, bboxUnits: boolean, axis: 'x' | 'y' | 'r', vb: { w: number; h: number }): number {
  const parse = (s: string) => {
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return NaN;
    if (!s.trim().endsWith('%')) return n;
    if (bboxUnits) return n / 100;
    return (n / 100) * (axis === 'x' ? vb.w : axis === 'y' ? vb.h : Math.hypot(vb.w, vb.h) / Math.SQRT2);
  };
  const n = v == null ? NaN : parse(v);
  return Number.isFinite(n) ? n : parse(dflt);
}

/** Stops for `reflect` / `repeat`: the cycles needed over the parameter range [lo, hi]. */
function spreadStops(stops: GradientStop[], mode: GradientDef['spread'], lo: number, hi: number): { stops: GradientStop[]; lo: number; hi: number } | null {
  if (mode === 'pad' || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  lo = Math.floor(lo);
  hi = Math.ceil(hi);
  if (lo >= 0 && hi <= 1) return null;
  if (hi - lo > 64) { const mid = Math.round((lo + hi) / 2); lo = mid - 32; hi = mid + 32; }
  const span = hi - lo;
  const out: GradientStop[] = [];
  for (let k = lo; k < hi; k++) {
    const cycle = mode === 'reflect' && Math.abs(k) % 2 === 1 ? [...stops].reverse().map((s) => ({ ...s, offset: 1 - s.offset })) : stops;
    for (const s of cycle) out.push({ ...s, offset: (k - lo + s.offset) / span });
  }
  return { stops: out, lo, hi };
}

/** Equal offsets (hard edges) nudged apart, so every back-end (PDF stitching functions too) keeps them. */
function strictStops(stops: GradientStop[]): GradientStop[] {
  let prev = -1;
  return stops.map((s) => {
    const offset = Math.min(1, Math.max(s.offset, prev + 1e-4));
    prev = offset;
    return offset === s.offset ? s : { ...s, offset };
  });
}

/** Corners of a box under a matrix. */
const corners = (b: Box, m: Matrix = IDENTITY) => [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => applyMatrix(m, x, y));

/**
 * A gradient as a Paint in viewBox units, for a shape with bounding box `bbox` in its user space,
 * which `toView` maps to viewBox units, covering `area` (viewBox units). Linear gradients map
 * exactly under any transform. Radial ones stay exact under rotation and uniform scale; through
 * any other transform they are ellipses, returned as a circle in `space`.
 */
function gradientPaint(def: GradientDef, bbox: () => Box, toView: Matrix, area: Box, vb: { w: number; h: number }): { paint: Paint | null; space?: Matrix } {
  const stops = def.stops;
  if (!stops.length) return { paint: null };
  if (stops.length === 1) return { paint: stopCss(stops[0]) };
  let units: Matrix = IDENTITY;
  if (def.bboxUnits) {
    const b = bbox();
    // SVG: a bounding-box gradient on a shape with no width or height paints nothing.
    if (!(b.w > 1e-9) || !(b.h > 1e-9)) return { paint: null };
    units = [b.w, 0, 0, b.h, b.x, b.y];
  }
  const T = multiply(toView, multiply(units, def.transform));
  const det = T[0] * T[3] - T[1] * T[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { paint: colourAt(stops, 0.5) };
  const len = (name: string, dflt: string, axis: 'x' | 'y' | 'r') => gradientLength(def.attrs[name], dflt, def.bboxUnits, axis, vb);
  const last = stops[stops.length - 1];

  if (def.kind === 'linear') {
    const x1 = len('x1', '0%', 'x'), y1 = len('y1', '0%', 'y'), x2 = len('x2', '100%', 'x'), y2 = len('y2', '0%', 'y');
    const dx = x2 - x1, dy = y2 - y1, dd = dx * dx + dy * dy;
    if (!(dd > 0)) return { paint: stopCss(last) };
    // The gradient's parameter at a viewBox point p is t(p) = g·p + b (affine), whatever T is.
    const N = invert(T);
    const gx = (N[0] * dx + N[1] * dy) / dd, gy = (N[2] * dx + N[3] * dy) / dd;
    const b = ((N[4] - x1) * dx + (N[5] - y1) * dy) / dd;
    const gg = gx * gx + gy * gy;
    if (!(gg > 0)) return { paint: colourAt(stops, 0.5) };
    const p1x = (-b * gx) / gg, p1y = (-b * gy) / gg, ux = gx / gg, uy = gy / gg;
    const ts = corners(area).map(([x, y]) => gx * x + gy * y + b);
    const sp = spreadStops(stops, def.spread, Math.min(...ts), Math.max(...ts));
    const lo = sp?.lo ?? 0, hi = sp?.hi ?? 1;
    return { paint: { kind: 'linear', x1: p1x + ux * lo, y1: p1y + uy * lo, x2: p1x + ux * hi, y2: p1y + uy * hi, stops: strictStops(sp?.stops ?? stops) } };
  }

  const cx = len('cx', '50%', 'x'), cy = len('cy', '50%', 'y'), r = len('r', '50%', 'r');
  const fx = def.attrs.fx != null ? len('fx', '50%', 'x') : cx, fy = def.attrs.fy != null ? len('fy', '50%', 'y') : cy;
  const fr = len('fr', '0', 'r');
  if (!(r > 0) || fr >= r) return { paint: stopCss(last) };
  // A focal radius (SVG 2): the stops start that far out (exact when the focus is the centre).
  let st = fr > 0 ? stops.map((s) => ({ ...s, offset: fr / r + s.offset * (1 - fr / r) })) : stops;
  const k = Math.sqrt(Math.abs(det));
  const [a, b, c, d] = T;
  const similar = Math.abs(a - d) + Math.abs(b + c) <= 2e-3 * k || Math.abs(a + d) + Math.abs(b - c) <= 2e-3 * k;
  // Similar: the circle maps to a circle in viewBox units. Otherwise draw in a space G (T's linear
  // part, unit area) where it stays one: G⁻¹·T is then a uniform scale and a shift.
  const space: Matrix | undefined = similar ? undefined : [a / k, b / k, c / k, d / k, 0, 0];
  const K = space ? multiply(invert(space), T) : T;
  const [ccx, ccy] = applyMatrix(K, cx, cy);
  const [ffx, ffy] = applyMatrix(K, fx, fy);
  let R = r * k;
  let ex = ccx, ey = ccy;
  // reflect / repeat: from the focus (t = 0) out to the farthest corner of the area.
  const far = Math.max(...corners(area, space ? invert(space) : IDENTITY).map(([x, y]) => Math.hypot(x - ffx, y - ffy)));
  const sp = spreadStops(st, def.spread, 0, far / R + Math.hypot(ccx - ffx, ccy - ffy) / R);
  if (sp) {
    st = sp.stops;
    ex = ffx + (ccx - ffx) * sp.hi;
    ey = ffy + (ccy - ffy) * sp.hi;
    R *= sp.hi;
  }
  const focal = Math.hypot(ffx - ex, ffy - ey) > 1e-9 * R;
  return { paint: { kind: 'radial', cx: ex, cy: ey, r: R, ...(focal ? { fx: ffx, fy: ffy } : {}), stops: strictStops(st) }, space };
}

/** A pattern (not drawn): its first plain colour stands in, else a mid grey. */
function patternColour(el: Element, ctx: Ctx): string {
  for (const c of Array.from(el.querySelectorAll('*'))) {
    const f = styleMap(c, ctx.rules).fill;
    if (f && f !== 'none' && !/^url\(/i.test(f) && !/^currentcolor$/i.test(f)) return f;
  }
  return '#808080';
}

/** A declared paint for one shape. */
function resolvePaint(spec: PaintSpec, ctx: Ctx, bbox: () => Box, toView: Matrix, area: () => Box): { paint: Paint | null; space?: Matrix } {
  if (spec == null || typeof spec === 'string') return { paint: spec };
  const def = gradientDef(spec.url, ctx);
  if (def) return gradientPaint(def, bbox, toView, area(), ctx.vb);
  const target = byId(ctx.doc, spec.url);
  if (target && localName(target) === 'pattern') return { paint: spec.fallback ?? patternColour(target, ctx) };
  return { paint: spec.fallback };
}

/** A declared paint as one colour (text). */
function flatPaint(spec: PaintSpec, alpha: number, ctx: Ctx): string | null {
  let c: string | null;
  if (spec == null || typeof spec === 'string') c = spec;
  else {
    const def = gradientDef(spec.url, ctx);
    const target = def ? null : byId(ctx.doc, spec.url);
    c = def ? (def.stops.length ? colourAt(def.stops, 0.5) : null) : target && localName(target) === 'pattern' ? spec.fallback ?? patternColour(target, ctx) : spec.fallback;
  }
  if (!c || alpha >= 1) return c;
  const p = parseColor(c);
  return `rgba(${p.r},${p.g},${p.b},${+(clamp01(Number.isFinite(p.a) ? p.a : 1) * alpha).toFixed(3)})`;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/** The exact bounding box of path data (curve extremes, not control points). */
function tightBounds(d: string): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  let px = 0, py = 0, sx = 0, sy = 0;
  // Roots in (0, 1) of the derivative of a cubic Bézier coordinate.
  const extremes = (p0: number, p1: number, p2: number, p3: number): number[] => {
    const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
    // The derivative over 3 is a t² + b t + c.
    const out: number[] = [];
    if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) out.push(-c / b); }
    else {
      const D = b * b - 4 * a * c;
      if (D >= 0) { const q = Math.sqrt(D); out.push((-b + q) / (2 * a), (-b - q) / (2 * a)); }
    }
    return out.filter((t) => t > 0 && t < 1);
  };
  const at = (p0: number, p1: number, p2: number, p3: number, t: number) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
  for (const s of parsePath(d)) {
    if (s.c === 'Z') { px = sx; py = sy; continue; }
    if (s.c === 'C') {
      for (const t of [...extremes(px, s.x1, s.x2, s.x), ...extremes(py, s.y1, s.y2, s.y)]) add(at(px, s.x1, s.x2, s.x, t), at(py, s.y1, s.y2, s.y, t));
    } else if (s.c === 'M') { sx = s.x; sy = s.y; }
    add(s.x, s.y);
    px = s.x; py = s.y;
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

function grow(b: Box, by: number): Box {
  return by > 0 ? { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by } : b;
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

interface TextNode { st: Inherited; start: number; x?: number[]; y?: number[]; dx?: number[]; dy?: number[]; rotate?: number[]; path?: SvgTextPath; shift: number; span?: SpanStyle }

function numberList(el: Element, name: string, em: number): number[] | undefined {
  const v = el.getAttribute(name);
  if (!v || !v.trim()) return undefined;
  const out = v.trim().split(/[\s,]+/).map((s) => cssLength(s, em));
  return out.length ? out : undefined;
}

/** A shape's outline as path data in its own user space (for `<textPath>`). */
function shapeData(el: Element): string | null {
  const num = (a: string) => parseFloat(el.getAttribute(a) || '0') || 0;
  switch (localName(el)) {
    case 'path': return el.getAttribute('d');
    case 'rect': return rectPath(num('x'), num('y'), num('width'), num('height'), num('rx') || num('ry'));
    case 'circle': return ellipsePath(num('cx'), num('cy'), num('r'), num('r'));
    case 'ellipse': return ellipsePath(num('cx'), num('cy'), num('rx'), num('ry'));
    case 'line': return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return localName(el) === 'polygon' ? d + 'Z' : d;
    }
  }
  return null;
}

function baselineShiftOf(v: string | undefined, size: number): number {
  if (!v || v === 'baseline' || v === 'inherit') return 0;
  if (v === 'super') return size * 0.4;
  if (v === 'sub') return -size * 0.2;
  const n = cssLength(v, size);
  return Number.isFinite(n) ? n : 0;
}

/** A `<text>` element as spans: whitespace handled, per-character positions resolved. */
function parseText(textEl: Element, st0: Record<string, string>, inh: Inherited, matrix: Matrix, ctx: Ctx): SvgText | null {
  const chars: { ch: string; chain: TextNode[] }[] = [];
  const visit = (el: Element, st: Record<string, string>, cur: Inherited, chain: TextNode[], shift: number) => {
    if (st.display === 'none') return;
    const em = cur.fontSize;
    const node: TextNode = { st: cur, start: -1, x: numberList(el, 'x', em), y: numberList(el, 'y', em), dx: numberList(el, 'dx', em), dy: numberList(el, 'dy', em), rotate: numberList(el, 'rotate', em), shift: shift + baselineShiftOf(st['baseline-shift'], em) };
    if (localName(el) === 'textpath') {
      // SVG 2 allows the path inline; otherwise the referenced shape, its own transform applied.
      const target = byId(ctx.doc, hrefOf(el).replace(/^#/, ''));
      let d = el.getAttribute('path');
      if (!d && target) {
        const raw = shapeData(target);
        d = raw ? transformPath(raw, parseTransform(target.getAttribute('transform'))) : null;
      }
      if (d) {
        const so = (el.getAttribute('startOffset') ?? '0').trim();
        node.path = { d, start: parseFloat(so) || 0, percent: so.endsWith('%') };
      }
    }
    const nodes = [...chain, node];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        for (const ch of child.nodeValue ?? '') {
          if (ctx.budget-- <= 0) break;
          chars.push({ ch, chain: nodes });
        }
      } else if (child.nodeType === 1) {
        const tag = localName(child as Element);
        if (tag === 'tspan' || tag === 'textpath' || tag === 'a') {
          const cst = styleMap(child as Element, ctx.rules);
          visit(child as Element, cst, inherit(cst, cur, child as Element), nodes, node.shift);
        }
      }
    }
  };
  visit(textEl, st0, inh, [], 0);

  // White space as browsers treat it: line breaks and tabs are spaces; unless preserved, runs of
  // spaces collapse and the text is trimmed at both ends.
  const kept: { ch: string; chain: TextNode[] }[] = [];
  for (const c of chars) {
    const ch = c.ch === '\n' || c.ch === '\r' || c.ch === '\t' ? ' ' : c.ch;
    const preserve = c.chain[c.chain.length - 1].st.preserve;
    if (ch === ' ' && !preserve && (!kept.length || kept[kept.length - 1].ch === ' ')) continue;
    kept.push({ ch, chain: c.chain });
  }
  while (kept.length && kept[kept.length - 1].ch === ' ' && !kept[kept.length - 1].chain[kept[kept.length - 1].chain.length - 1].st.preserve) kept.pop();
  if (!kept.length) return null;
  kept.forEach((c, i) => { for (const n of c.chain) if (n.start < 0) n.start = i; });

  const styleOf = (n: TextNode): SpanStyle => (n.span ??= {
    family: n.st.fontFamily,
    weight: n.st.fontWeight,
    italic: n.st.italic,
    smallCaps: n.st.smallCaps,
    size: n.st.fontSize,
    fill: n.st.visible ? flatPaint(n.st.fill, n.st.fillOpacity, ctx) : null,
    stroke: n.st.visible && n.st.stroke && n.st.sw > 0 ? (() => { const c = flatPaint(n.st.stroke, n.st.strokeOpacity, ctx); return c ? { color: c, width: n.st.sw } : null; })() : null,
    letterSpacing: n.st.letterSpacing,
    anchor: n.st.anchor,
    baseline: n.st.baseline,
    shift: n.shift,
  });

  const spans: SvgSpan[] = [];
  let owner: TextNode | null = null;
  let cur: SvgSpan | null = null;
  kept.forEach((c, i) => {
    // The innermost element giving a value for this character wins.
    const pick = (key: 'x' | 'y' | 'dx' | 'dy'): number | undefined => {
      for (let k = c.chain.length - 1; k >= 0; k--) {
        const n = c.chain[k], l = n[key];
        if (l && i - n.start < l.length && Number.isFinite(l[i - n.start])) return l[i - n.start];
      }
      return undefined;
    };
    let turn = 0;
    for (let k = c.chain.length - 1; k >= 0; k--) {
      const n = c.chain[k], l = n.rotate;
      // The last rotation goes on for the element's remaining characters.
      if (l && l.length) { turn = l[Math.min(i - n.start, l.length - 1)] || 0; break; }
    }
    const node = c.chain[c.chain.length - 1];
    const path = [...c.chain].reverse().find((n) => n.path)?.path;
    const x = pick('x'), y = pick('y'), dx = pick('dx') ?? 0, dy = pick('dy') ?? 0;
    if (!cur || owner !== node || x != null || y != null || dx || dy || turn || cur.rotate || cur.path !== path) {
      cur = { ...styleOf(node), text: '', x, y, dx, dy, ...(turn ? { rotate: turn } : {}), ...(path ? { path } : {}) };
      owner = node;
      spans.push(cur);
    }
    cur.text += c.ch;
  });
  return { t: 'svgtext', matrix, opacity: inh.opacity, spans };
}

/* ---- fonts */

const SANS = /inter\b|helvetica|arial|sans|grotesk|grotesque|roboto|segoe|verdana|tahoma|trebuchet|calibri|myriad|frutiger|univers|gill|lato\b|ubuntu|system-ui|apple-system|blinkmacsystemfont|franklin|news ?gothic|trade ?gothic|akzidenz|lucida ?grande|geneva|candara|corbel|optima|nunito|raleway|oswald|barlow|manrope|sf ?pro|neue haas|aktiv/i;
const SERIF = /garamond|times|georgia|baskerville|caslon|minion|palatino|book ?antiqua|cambria|charter|iowan|hoefler|sabon|bembo|jenson|plantin|janson|goudy|century ?(schoolbook|old)|constantia|merriweather|lora\b|crimson|cormorant|serif|new ?york|athelas|charis|spectral|literata|tinos|roman/i;

/** Font-family names to bundled families, first match wins (a pattern, or a family id). */
const FAMILY_HINTS: [RegExp, string][] = [
  [/mincho|songti|simsun|stsong|batang|myungjo|source ?han ?serif|noto ?serif ?(jp|sc|tc|kr|cjk)/i, 'mincho'],
  [/hiragino ?(kaku ?gothic|sans)|yu ?gothic|ms ?p?gothic|meiryo|source ?han ?sans|noto ?sans ?(jp|sc|tc|kr|cjk)|pingfang|yahei|simhei|heiti|gulim|dotum|malgun|apple ?sd ?gothic/i, 'gothic-jp'],
  [/mono|courier|consolas|menlo|monaco|\bcode\b|typewriter|lucida ?console|andale|^ui-monospace$/i, 'ibm-plex-mono'],
  [/fraktur|blackletter|textura|old ?english|schwabacher/i, 'unifraktur'],
  [/cinzel|trajan|capitolina|copperplate|titling/i, 'cinzel'],
  [/fraunces|cooper|recoleta|windsor|souvenir|bookman|playfair|didot|bodoni|abril|^fantasy$/i, 'fraunces'],
  [/space ?grotesk|futura|avenir|century ?gothic|gotham|montserrat|poppins|josefin|eurostile|\bdin\b|bahnschrift|geometric/i, 'space-grotesk'],
  [SANS, 'inter'],
  [SERIF, 'eb-garamond'],
  [/^(cursive|ui-serif|emoji|math)$/i, 'eb-garamond'],
];

const WEIGHT_WORDS: [RegExp, number][] = [
  [/thin|hairline/, 100], [/extra-?light|ultra-?light/, 200], [/light/, 300], [/medium/, 500], [/semi-?bold|demi/, 600],
  [/extra-?bold|ultra-?bold|heavy/, 800], [/black/, 900], [/bold/, 700],
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "MyriadPro-BoldIt", "Inter Bold", "Times New Roman" → family name and the style its name carries. */
function faceName(raw: string): { name: string; weight?: number; italic: boolean } {
  let name = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  let style = '';
  const dash = name.indexOf('-');
  // PostScript names: Family-Style.
  if (dash > 0 && !/\s/.test(name)) { style = name.slice(dash + 1); name = name.slice(0, dash); }
  const word = /\s+(thin|hairline|extra ?light|ultra ?light|light|regular|book|roman|normal|medium|semi ?bold|demi ?bold|demi|bold|extra ?bold|ultra ?bold|heavy|black|italic|oblique|it)$/i;
  for (let m = word.exec(name); m; m = word.exec(name)) { style += ' ' + m[1]; name = name.slice(0, m.index); }
  const s = style.toLowerCase();
  const weight = WEIGHT_WORDS.find(([re]) => re.test(s))?.[1];
  return { name, weight, italic: /italic|oblique/.test(s) || /it(mt)?$/.test(s.trim()) };
}

const familyCache = new Map<string, { family: string; weight?: number; italic: boolean }>();

/** The closest bundled (or uploaded) family for a CSS font-family list. */
function matchFamily(list: string): { family: string; weight?: number; italic: boolean } {
  const fams = getFamilies();
  const key = `${fams.length}|${list}`;
  const hit = familyCache.get(key);
  if (hit) return hit;
  const names = list.split(',').map((n) => n.trim()).filter(Boolean);
  let out: { family: string; weight?: number; italic: boolean } | null = null;
  for (const raw of names) {
    const f = faceName(raw);
    const want = squash(f.name);
    const own = want && fams.find((fam) => !fam.system && [fam.name, fam.id, fam.css.replace(/^BDS /, '')].some((n) => squash(n) === want || squash(n) === squash(raw)));
    if (own) { out = { family: own.id, weight: f.weight, italic: f.italic }; break; }
    const hint = FAMILY_HINTS.find(([re]) => re.test(raw.replace(/^['"]|['"]$/g, '')));
    if (hint) { out = { family: hint[1], weight: f.weight, italic: f.italic }; break; }
  }
  // Nothing known: a browser's default is a serif, unless the names say sans.
  out ??= { family: /sans/i.test(list) ? 'inter' : 'eb-garamond', italic: false };
  familyCache.set(key, out);
  if (familyCache.size > 500) familyCache.delete(familyCache.keys().next().value!);
  return out;
}

const CJK_CHARS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uff00-\\uffef';
const CJK = new RegExp(`[${CJK_CHARS}]`);

/** A span's text cut where it changes between CJK and other scripts (each part gets its own font). */
const scriptParts = (text: string): string[] => text.match(new RegExp(`[${CJK_CHARS}]+|[^${CJK_CHARS}]+`, 'g')) ?? [];

/** The font for `text` (all CJK or none of it) in a span's style. */
function fontFor(sp: SvgSpan, text: string, size: number): FontRef {
  const m = matchFamily(sp.family);
  let family = m.family;
  // Japanese, Chinese or Korean in a Latin family: the system CJK face of the same kind.
  if (CJK.test(text) && getFamily(family).category !== 'cjk') family = getFamily(family).category === 'sans' || family === 'space-grotesk' ? 'gothic-jp' : 'mincho';
  void ensureFamily(family);
  const weight = sp.weight === 400 && m.weight ? m.weight : sp.weight;
  return resolveFont({ family, weight, italic: sp.italic || m.italic, size, features: sp.smallCaps ? { smcp: true } : {} });
}

/** How far down (user units) the alphabetic baseline sits from the y given, for the span's baseline. */
function baselineOffset(sp: SvgSpan, font: FontRef): number {
  const mt = fontMetrics(font);
  let em = 0;
  switch (sp.baseline) {
    case 'middle': em = mt.xHeight / 2; break;
    case 'central': em = (mt.ascender + mt.descender) / 2; break;
    case 'hanging': em = mt.ascender * 0.8; break;
    case 'mathematical': em = mt.ascender / 2; break;
    case 'text-before-edge': case 'before-edge': case 'text-top': em = mt.ascender; break;
    case 'text-after-edge': case 'after-edge': case 'text-bottom': case 'ideographic': em = mt.descender; break;
  }
  return em * sp.size - sp.shift;
}

/** A linear map as rotation · [[sx, shear], [0, sy]]. */
function decompose(m: Matrix) {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const rot = Math.atan2(b, a);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return { rot: (rot * 180) / Math.PI, sx, shear: cos * c + sin * d, sy: -sin * c + cos * d };
}

interface Colours { fillOverride: string | null; strokeOverride: string | null }

/** A run whose glyph origin is (ux, uy) in text user space, turned `turn` degrees there; M maps to the frame. */
function placeRun(M: Matrix, ux: number, uy: number, turn: number, sp: SvgSpan, font: FontRef, text: string, adv: number, col: Colours): TextRun | null {
  const fill = sp.fill && col.fillOverride ? col.fillOverride : sp.fill;
  const stroke = sp.stroke ? { color: col.strokeOverride ?? sp.stroke.color, width: sp.stroke.width } : null;
  if (!fill && !stroke) return null;
  const dec = decompose(turn ? multiply(M, rotate(turn)) : M);
  const k = Math.abs(dec.sy);
  if (!(k > 1e-9) || !Number.isFinite(k) || !Number.isFinite(dec.sx)) return null;
  const [x, y] = applyMatrix(M, ux, uy);
  const run: TextRun = { x, y, text, font, size: sp.size * k, color: fill ?? 'rgba(0,0,0,0)', width: adv * k };
  if (sp.letterSpacing) run.letterSpacing = sp.letterSpacing * k;
  if (stroke) run.stroke = { color: stroke.color, width: stroke.width * k };
  if (Math.abs(dec.rot) > 1e-6) run.rotate = dec.rot;
  if (Math.abs(dec.sx / k - 1) > 1e-6) run.scaleX = dec.sx / k;
  if (dec.sy < 0) run.scaleY = -1;
  // runMatrix's shear entry is −tan(skew)·scaleY.
  const skew = (Math.atan(-dec.shear / dec.sy) * 180) / Math.PI;
  if (Math.abs(skew) > 1e-6) run.skew = skew;
  return run;
}

/** Type on a path: each character stood on the path at its own distance, turned to the tangent. */
function pathRuns(spans: SvgSpan[], M: Matrix, k: number, col: Colours): TextRun[] {
  const path = spans[0].path!;
  // The first sub-path, flattened.
  const pts: [number, number][] = [];
  let cx = 0, cy = 0;
  for (const s of parsePath(path.d)) {
    if (s.c === 'M') { if (pts.length > 1) break; pts.length = 0; pts.push([s.x, s.y]); }
    else if (s.c === 'L') pts.push([s.x, s.y]);
    else if (s.c === 'C') {
      for (let i = 1; i <= 24; i++) {
        const t = i / 24, u = 1 - t;
        pts.push([u * u * u * cx + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x, u * u * u * cy + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y]);
      }
    } else if (pts.length) pts.push([...pts[0]] as [number, number]);
    if (s.c !== 'Z') { cx = s.x; cy = s.y; }
  }
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = lens[lens.length - 1];
  if (pts.length < 2 || !(L > 0)) return [];
  const at = (s: number) => {
    let i = 1;
    while (i < lens.length - 1 && lens[i] < s) i++;
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const f = (s - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, a: Math.atan2(y1 - y0, x1 - x0) };
  };
  const glyphs: { sp: SvgSpan; font: FontRef; ch: string; adv: number; dx: number; dy: number }[] = [];
  for (const sp of spans) {
    let first = true;
    for (const part of scriptParts(sp.text)) {
      const font = fontFor(sp, part, sp.size * k);
      for (const ch of part) {
        glyphs.push({ sp, font, ch, adv: measure(ch, font, sp.size) + sp.letterSpacing, dx: first ? sp.dx : 0, dy: first ? sp.dy : 0 });
        first = false;
      }
    }
  }
  const total = glyphs.reduce((t, g) => t + g.adv + g.dx, 0);
  const anchor = spans[0].anchor;
  let s = (path.percent ? (path.start / 100) * L : path.start) - (anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0);
  let off = 0;
  const runs: TextRun[] = [];
  for (const g of glyphs) {
    s += g.dx;
    off += g.dy;
    const mid = s + g.adv / 2;
    // Characters whose middle falls off the path are not drawn (SVG).
    if (g.ch.trim() && mid >= 0 && mid <= L) {
      const p = at(mid);
      const cos = Math.cos(p.a), sin = Math.sin(p.a);
      const half = (g.adv - g.sp.letterSpacing) / 2;
      const down = off + baselineOffset(g.sp, g.font);
      const run = placeRun(M, p.x - cos * half - sin * down, p.y - sin * half + cos * down, (p.a * 180) / Math.PI, g.sp, g.font, g.ch, g.adv - g.sp.letterSpacing, col);
      if (run) runs.push(run);
    }
    s += g.adv;
  }
  return runs;
}

/** A `<text>` laid out with real fonts: chunks anchored, baselines placed, then mapped by M. */
function textRuns(item: SvgText, M: Matrix, col: Colours): TextRun[] {
  const k = Math.abs(decompose(M).sy);
  const runs: TextRun[] = [];
  type Placed = { sp: SvgSpan; text: string; font: FontRef; x: number; y: number; adv: number };
  let chunk: Placed[] = [];
  // Each chunk (from one absolute position to the next) is aligned by its first span's text-anchor.
  const flush = () => {
    if (!chunk.length) return;
    const first = chunk[0], last = chunk[chunk.length - 1];
    const width = last.x + last.adv - first.x;
    const shift = first.sp.anchor === 'middle' ? -width / 2 : first.sp.anchor === 'end' ? -width : 0;
    for (const p of chunk) {
      const run = placeRun(M, p.x + shift, p.y + baselineOffset(p.sp, p.font), p.sp.rotate ?? 0, p.sp, p.font, p.text, p.adv, col);
      if (run) runs.push(run);
    }
    chunk = [];
  };
  let cx = 0, cy = 0;
  for (let i = 0; i < item.spans.length;) {
    const sp = item.spans[i];
    if (sp.path) {
      flush();
      let j = i;
      while (j < item.spans.length && item.spans[j].path === sp.path) j++;
      runs.push(...pathRuns(item.spans.slice(i, j), M, k, col));
      i = j;
      continue;
    }
    if (sp.x != null || sp.y != null) flush();
    if (sp.x != null) cx = sp.x;
    if (sp.y != null) cy = sp.y;
    cx += sp.dx;
    cy += sp.dy;
    for (const text of scriptParts(sp.text)) {
      const font = fontFor(sp, text, sp.size * k);
      const adv = measure(text, font, sp.size) + sp.letterSpacing * [...text].length;
      chunk.push({ sp, text, font, x: cx, y: cy, adv });
      cx += adv;
    }
    i++;
  }
  flush();
  return runs;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

const SKIP = new Set(['defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'symbol', 'style', 'title', 'desc', 'metadata', 'foreignobject', 'marker', 'filter', 'script']);

export function parseSvg(markup: string): ParsedSvg | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  } catch {
    return null;
  }
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;
  const vbAttr = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const w = parseFloat(svg.getAttribute('width') || '') || vbAttr?.[2] || 100;
  const h = parseFloat(svg.getAttribute('height') || '') || vbAttr?.[3] || 100;
  const viewBox = vbAttr && vbAttr.length === 4 ? { x: vbAttr[0], y: vbAttr[1], w: vbAttr[2], h: vbAttr[3] } : { x: 0, y: 0, w, h };
  const items: SvgItem[] = [];
  const ctx: Ctx = { doc, rules: parseSheets(doc), vb: { w: viewBox.w, h: viewBox.h }, gradients: new Map(), budget: 20000 };

  const walk = (node: Element, m: Matrix, inh: Inherited) => {
    const tag = localName(node);
    if (SKIP.has(tag)) return;
    const st = styleMap(node, ctx.rules);
    if (st.display === 'none') return;
    const cur = inherit(st, inh, node);
    const mm = multiply(m, parseTransform(node.getAttribute('transform')));
    if (tag === 'text') {
      const t = parseText(node, st, cur, mm, ctx);
      if (t) items.push(t);
      return;
    }
    const d = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(tag) ? shapeData(node) : null;
    if (d && cur.visible) {
      const scaleFactor = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])) || 1;
      const dash = st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' ? st['stroke-dasharray'].split(/[\s,]+/).map((v) => parseFloat(v) * scaleFactor) : undefined;
      const dView = transformPath(d, mm);
      // The bounding box (user space) for objectBoundingBox gradients, and the area painted
      // (viewBox units, stroke included) for reflect / repeat: both only when asked for.
      let bb: Box | null = null, area: Box | null = null;
      const bbox = () => (bb ??= tightBounds(d));
      const painted = () => (area ??= grow(pathBounds(parsePath(dView)), (cur.stroke ? cur.sw * scaleFactor : 0) / 2));
      const fill = tag === 'line' ? { paint: null } : resolvePaint(cur.fill, ctx, bbox, mm, painted);
      const stroke = cur.sw > 0 ? resolvePaint(cur.stroke, ctx, bbox, mm, painted) : { paint: null };
      const base: SvgShape = {
        t: 'path',
        d: dView,
        fill: fill.paint,
        stroke: stroke.paint,
        strokeWidth: cur.sw * scaleFactor,
        fillRule: cur.rule,
        opacity: cur.opacity * (fill.paint ? cur.fillOpacity : cur.strokeOpacity),
        cap: (st['stroke-linecap'] as PathPrim['cap']) ?? undefined,
        join: (st['stroke-linejoin'] as PathPrim['join']) ?? undefined,
        dash,
        ...(fill.space ? { fillSpace: fill.space } : {}),
      };
      // An elliptical radial stroke has no exact form here: the circle of the same area.
      if (stroke.space && stroke.paint && typeof stroke.paint !== 'string' && stroke.paint.kind === 'radial') {
        const p: RadialGradientPaint = { ...stroke.paint };
        [p.cx, p.cy] = applyMatrix(stroke.space, p.cx, p.cy);
        if (p.fx != null) [p.fx, p.fy] = applyMatrix(stroke.space, p.fx, p.fy ?? stroke.paint.cy);
        base.stroke = p;
      }
      if (base.fill && base.stroke && cur.fillOpacity !== cur.strokeOpacity) {
        // Fill and stroke at different opacities: two shapes.
        items.push({ ...base, stroke: null });
        items.push({ ...base, fill: null, fillSpace: undefined, opacity: cur.opacity * cur.strokeOpacity });
      } else if (base.fill || base.stroke) items.push(base);
    }
    for (const child of Array.from(node.children)) walk(child, mm, cur);
  };
  walk(svg, IDENTITY, ROOT);
  return { viewBox, paths: items };
}

const parsedCache = new Map<string, ParsedSvg | null>();

export function parseSvgCached(key: string, markup: string): ParsedSvg | null {
  if (!parsedCache.has(key)) parsedCache.set(key, parseSvg(markup));
  return parsedCache.get(key)!;
}

/** A paint moved by a similarity (uniform scale `s`, rotation, shift). */
function movePaint(p: Paint, m: Matrix, s: number): Paint {
  if (typeof p === 'string') return p;
  if (p.kind === 'linear') {
    const [x1, y1] = applyMatrix(m, p.x1, p.y1), [x2, y2] = applyMatrix(m, p.x2, p.y2);
    return { ...p, x1, y1, x2, y2 };
  }
  const [cx, cy] = applyMatrix(m, p.cx, p.cy);
  const out: RadialGradientPaint = { ...p, cx, cy, r: p.r * s };
  if (p.fx != null) [out.fx, out.fy] = applyMatrix(m, p.fx, p.fy ?? p.cy);
  return out;
}

/** Fit an SVG into a w×h box (xMidYMid meet) as primitives. A fill or stroke override replaces any gradient. */
export function svgPrims(parsed: ParsedSvg, w: number, h: number, fillOverride: string | null, strokeOverride: string | null): Prim[] {
  const vb = parsed.viewBox;
  const s = Math.min(w / vb.w, h / vb.h);
  const m = multiply(translate((w - vb.w * s) / 2, (h - vb.h * s) / 2), multiply(scale(s), translate(-vb.x, -vb.y)));
  const out: Prim[] = [];
  for (const item of parsed.paths) {
    if (item.t === 'svgtext') {
      const runs = textRuns(item, multiply(m, item.matrix), { fillOverride, strokeOverride });
      if (runs.length) out.push({ t: 'text', runs, ...(item.opacity < 1 ? { opacity: item.opacity } : {}) });
      continue;
    }
    const { fillSpace, ...p } = item;
    const d = transformPath(p.d, m);
    const shape: PathPrim = {
      ...p,
      d,
      strokeWidth: (p.strokeWidth ?? 1) * s,
      dash: p.dash?.map((v) => v * s),
      fill: p.fill && fillOverride ? fillOverride : p.fill ? movePaint(p.fill, m, s) : p.fill,
      stroke: p.stroke && strokeOverride ? strokeOverride : p.stroke ? movePaint(p.stroke, m, s) : p.stroke,
    };
    if (fillSpace && p.fill && !fillOverride) {
      // An elliptical gradient: the fill drawn in the gradient's own space (where it is a circle),
      // mapped back by the group; the stroke stays outside so its width isn't distorted.
      const Gi = invert(fillSpace);
      out.push({ t: 'group', matrix: fillSpace, children: [{ ...shape, d: transformPath(d, Gi), fill: movePaint(p.fill, multiply(Gi, multiply(m, fillSpace)), s), stroke: null }] });
      if (shape.stroke) out.push({ ...shape, fill: null });
      continue;
    }
    out.push(shape);
  }
  return out;
}

/** Decode the markup of an SVG data: URL. */
export function svgMarkupFromDataUrl(src: string): string {
  const comma = src.indexOf(',');
  const meta = src.slice(0, comma);
  const data = src.slice(comma + 1);
  return meta.includes('base64') ? decodeURIComponent(escape(atob(data))) : decodeURIComponent(data);
}
