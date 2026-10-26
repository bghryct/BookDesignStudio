/**
 * Composition: measured items, line breaking and line placement.
 *
 *  • Knuth–Plass total-fit breaking with fitness classes, flagged-hyphen demerits, an enforced
 *    limit on consecutive hyphens, a hyphenation zone for ragged text and a hyphenation bias.
 *  • Justification by word space, letter spacing and glyph scaling (the hz-programme), each within
 *    its own range, plus last-line and single-word alignment.
 *  • Shaped rags: Swiss (short / long / short / long), balanced, wedge and repeating patterns, all
 *    composed by the paragraph composer against per-line target measures.
 *  • A single-line (first-fit) composer, and a tab composer with left / centre / right / decimal
 *    stops, aligned leaders and right-indent tabs.
 */
import type { TextStyle } from '../../model/types';
import type { FontRef, TextRun } from '../../render/primitives';
import { resolveFont, measure, fontMetrics, faceSupports, opticalKerning } from '../fonts';
import { hyphenPoints } from '../hyphenate';
import { PLAIN, type Paragraph, type SpanStyle, type Word, type StoryStyles } from './story';

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/** Layout-only decoration of a run (underline, strike, highlight), turned into rules by the frame. */
export interface RunDeco {
  u?: { w: number; o: number; c: string; k?: 'double' | 'dashed' | 'dotted' | 'wavy'; g?: string };
  s?: { w: number; c: string };
  hl?: string;
  /** Ruby annotation set above the run: text, size, measured width. */
  ruby?: { t: string; s: number; w: number };
  /** Kenten: a mark over each character. */
  em?: { m: string; s: number };
  /** A PDF hyperlink over the run. */
  link?: string;
  /** Warichu: two half-size lines set inside the line (the run itself is blank). */
  wari?: { a: string; b: string; s: number; wa: number; wb: number };
}

/** A measured piece of text in one font. `kern`: extra advance after each UTF-16 unit (pt). */
export interface Seg {
  text: string;
  font: FontRef;
  size: number;
  ls: number;
  width: number;
  /** Width of the glyphs alone (scaled), without letter spacing or kerning. */
  glyphW: number;
  color: string;
  kern?: number[];
  dy?: number;
  sx?: number;
  sy?: number;
  skew?: number;
  stroke?: { color: string; width: number };
  deco?: RunDeco;
  /** A footnote reference (its text is the label). */
  fn?: boolean;
  /** An inline graphic (its width is the image's; `pct` = % of the column, resolved when placed). */
  obj?: { href: string; w: number; h: number; assetId?: string; pct?: number; anchor?: 'left' | 'right' | 'outside' | 'inside'; dx?: number; dy?: number };
  /** Character rotation, degrees. */
  rot?: number;
  /** Lead-in before the first glyph (spaced-out ruby bases start half a space in). */
  dx0?: number;
}

export interface Box {
  t: 'box';
  w: number;
  segs: Seg[];
  word: number;
  /** Stretch / shrink from letter spacing and glyph scaling (justified text only). */
  st: number;
  sh: number;
  lsSt: number;
  lsSh: number;
  gsSt: number;
  gsSh: number;
  chars: number;
}
export interface Glue { t: 'glue'; w: number; st: number; sh: number }
export interface Pen { t: 'pen'; w: number; p: number; f: boolean; hyphen?: Seg | null; ws?: number }
export interface TabItem { t: 'tab'; kind: 'tab' | 'rtab' }
export interface HereItem { t: 'here' }
export type Item = Box | Glue | Pen | TabItem | HereItem;

export const INF = 10000;
/** Breaking inside a run with no break opportunity: allowed, but dearer than any other line. */
const EMERGENCY_PEN = 5000;
const EMERGENCY_EM = 12;
/** Width beyond which a run with nowhere to break gets emergency break points (see buildItems). */
export const longRunWidth = (fontSize: number, measure: number) => Math.max(fontSize, Math.min(EMERGENCY_EM * fontSize, measure));
/** May a run be cut before text[k]? Not inside a surrogate pair, before a combining mark or variation selector, or next to a joiner. */
const cuttable = (text: string, k: number) => {
  const c = text.charCodeAt(k);
  if (c >= 0xdc00 && c <= 0xdfff) return false;
  return !/[\p{M}\u200d\ufe00-\ufe0f]/u.test(text[k]) && text[k - 1] !== '\u200d';
};

/** A text-valued property (colour, font, link) only when it really is text: styles from a damaged file may hold anything. */
const txt = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const ULINE_KINDS = new Set<string>(['double', 'dashed', 'dotted', 'wavy']);

export interface ParaStyle {
  size: number;
  leading: number;
  align: TextStyle['align'];
  indent: number;
  spaceBefore: number;
  spaceAfter: number;
  weight: number;
  tracking: number;
  forceSc: boolean;
  left: number;
  right: number;
  /** List marker hanging in front of the first line. */
  marker: { text: string; x: number; w: number; align: 'left' | 'right' } | null;
}

export function paraStyle(p: Paragraph, s: TextStyle): ParaStyle {
  const listIndent = p.list ? p.list.indent ?? (p.list.type === 'number' ? 1.6 : 1.1) * s.fontSize : 0;
  const base: ParaStyle = {
    size: s.fontSize, leading: s.leading, align: s.align,
    // A negative first-line indent hangs, on every paragraph (lists, bibliographies).
    indent: p.list ? 0 : s.firstLineIndent < 0 ? s.firstLineIndent : p.first && !s.indentFirstParagraph ? 0 : s.firstLineIndent,
    spaceBefore: p.first ? 0 : p.pstyle?.spaceBefore ?? s.paragraphSpacing, spaceAfter: p.pstyle?.spaceAfter ?? 0,
    weight: s.weight, tracking: s.tracking, forceSc: s.textTransform === 'small-caps',
    left: (s.leftIndent ?? 0) + (p.list ? listIndent * (p.level + 1) : 0), right: s.rightIndent ?? 0,
    marker: p.list && p.marker ? { text: p.marker, x: (s.leftIndent ?? 0) + listIndent * p.level, w: listIndent, align: p.list.align ?? (p.list.type === 'number' ? 'right' : 'left') } : null,
  };
  const centred = s.align === 'justify' || s.align === 'center' || s.align === 'justify-all';
  switch (p.kind) {
    case 'h1':
      return { ...base, size: s.fontSize * 1.75, leading: s.leading * 2, align: centred ? 'center' : s.align, indent: 0, spaceBefore: s.leading * 2, spaceAfter: s.leading, tracking: s.tracking + 10 };
    case 'h2':
      return { ...base, size: s.fontSize, leading: s.leading, align: centred ? 'center' : s.align, indent: 0, spaceBefore: s.leading, spaceAfter: s.leading * 0.5, tracking: s.tracking + 80, forceSc: true };
    case 'break':
      return { ...base, align: 'center', indent: 0, spaceBefore: s.leading * 0.5, spaceAfter: s.leading * 0.5 };
    default:
      return base;
  }
}

const isLower = (ch: string) => ch !== ch.toUpperCase() && ch === ch.toLowerCase();

/** Size-specific tracking (‰ em): the optical curve type founders cut into metal sizes. */
const TRACK_CURVE: [number, number][] = [[5, 30], [7, 18], [9, 8], [12, 0], [18, -8], [24, -13], [36, -18], [72, -26], [144, -32]];
export function opticalTrack(size: number): number {
  const ls = Math.log(Math.max(1, size));
  if (size <= TRACK_CURVE[0][0]) return TRACK_CURVE[0][1];
  for (let i = 1; i < TRACK_CURVE.length; i++) {
    const [s1, t1] = TRACK_CURVE[i];
    if (size <= s1) {
      const [s0, t0] = TRACK_CURVE[i - 1];
      return t0 + ((t1 - t0) * (ls - Math.log(s0))) / (Math.log(s1) - Math.log(s0));
    }
  }
  return TRACK_CURVE[TRACK_CURVE.length - 1][1];
}

/** Fixed spaces, em fractions (figure / punctuation spaces are measured from the font). */
const FIXED: Record<string, number> = { ' ': 0.5, ' ': 1, ' ': 1 / 3, ' ': 1 / 4, ' ': 1 / 6, ' ': 1 / 8, ' ': 1 / 24, ' ': 1 / 6 };
const FIXED_RE = /([ -  ])/;

export class ItemBuilder {
  private rtl: boolean;
  constructor(private style: TextStyle, private ps: ParaStyle, private images: StoryStyles['images'] = undefined) { this.rtl = style.direction === 'rtl'; }

  /** Size of an inline graphic: given width / height, the other from the image's proportions. */
  objSeg(st: SpanStyle): Seg {
    const o = st.obj!;
    const img = this.images?.[o.id];
    const ar = img && img.w > 0 ? img.h / img.w : 0.75;
    let w = o.w ?? (o.h != null ? o.h / ar : Math.min(160, (img?.w ?? 120) * 0.75));
    let h = o.h ?? w * ar;
    if (o.pct) { w = 1; h = 1; }
    // An anchored object sits outside the text: it takes no room on the line.
    const adv = o.anchor ? 0 : w;
    return {
      text: '', font: this.font(PLAIN), size: this.ps.size, ls: 0, width: adv, glyphW: adv, color: this.style.color, dy: o.shift || undefined,
      obj: { href: img?.href ?? '', w, h, assetId: o.id, pct: o.pct, anchor: o.anchor, dx: o.dx, dy: o.dy },
    };
  }

  font(st: SpanStyle, extraFeatures?: Record<string, boolean>, size = this.ps.size): FontRef {
    const s = this.style;
    const cs = st.cs;
    // Italic inside italic text returns to roman — the typographic convention for emphasis.
    const italic = (cs?.italic ?? s.italic) !== st.italic;
    const w0 = cs?.weight ?? this.ps.weight;
    const weight = st.bold ? Math.min(900, Math.max(w0 + 250, 650)) : w0;
    const features = { ...s.features, ...(cs?.features ?? {}), ...(extraFeatures ?? {}) };
    if (s.textTransform === 'uppercase' || cs?.textTransform === 'uppercase') features.case = true;
    // Optical kerning replaces the font's pairs; "none" sets the type unkerned.
    if ((s.kerning ?? 'metrics') !== 'metrics') features.kern = false;
    const family = txt(cs?.fontFamily) ?? s.fontFamily;
    return resolveFont({ family, weight, italic, axes: family === s.fontFamily ? s.axes : {}, features, size });
  }

  /** One measured segment; manual (‰ em) and optical kerning become extra advance per character. */
  private seg(text: string, font: FontRef, size: number, ls: number, color: string, look: Partial<Seg>, manual?: number[]): Seg {
    let kern: number[] | undefined;
    if (!this.rtl) {
      const man = manual && manual.length === text.length && manual.some((v) => v) ? manual : null;
      const opt = this.style.kerning === 'optical' ? opticalKerning(text, font) : null;
      if (man || opt) kern = Array.from({ length: text.length }, (_, i) => ((man?.[i] ?? 0) / 1000) * size + (opt ? opt[i] * size : 0));
    }
    const kw = kern ? kern.reduce((a, b) => a + b, 0) : 0;
    const glyphW = measure(text.replace(/‑/g, '-'), font, size) * (look.sx ?? 1);
    return { text: text.replace(/‑/g, '-'), font, size, ls, width: glyphW + ls * [...text].length + kw, glyphW, color, kern, ...look };
  }

  /** Measure a piece of text in a span style: special spaces, small caps, positions, scaling. */
  segs(text: string, st: SpanStyle, sc: boolean, manual?: number[]): Seg[] {
    if (st.obj) return [this.objSeg(st)];
    if (FIXED_RE.test(text)) {
      // Fixed-width spaces become blank segments of their exact width.
      const out: Seg[] = [];
      let off = 0;
      for (const part of text.split(FIXED_RE)) {
        if (!part) continue;
        if (FIXED_RE.test(part)) {
          // Em, en, thin, hair… are fractions of the size; a figure space is as wide as a digit and a
          // punctuation space as a full stop, measured in the font. (These two once recursed forever.)
          const size = this.sizeOf(st);
          const w = FIXED[part] != null ? FIXED[part] * size : measure(part === '\u2007' ? '0' : '.', this.font(st), size);
          out.push({ text: '', font: this.font(st), size, ls: 0, width: w, glyphW: w, color: this.style.color });
        } else out.push(...this.segs(part, st, sc, manual?.slice(off, off + part.length)));
        off += part.length;
      }
      return out;
    }
    const ps = this.ps;
    const cs = st.cs;
    let size = this.sizeOf(st);
    let dy = cs?.baselineShift ?? 0;
    let extra: Record<string, boolean> | undefined;
    if (cs?.position === 'superscript' || cs?.position === 'subscript') {
      // True superior / inferior figures when the font has them, else scaled and shifted.
      const tag = cs.position === 'superscript' ? 'sups' : 'subs';
      if (faceSupports(this.font(st, { [tag]: true }), tag)) extra = { [tag]: true };
      else { dy += cs.position === 'superscript' ? size * 0.33 : -size * 0.14; size *= 0.62; }
    }
    const color = txt(cs?.color) ?? this.style.color;
    const ls = ((ps.tracking + (cs?.tracking ?? 0) + (this.style.opticalTracking ? opticalTrack(size) : 0)) / 1000) * size;
    const look: Partial<Seg> = { dy: dy || undefined, fn: st.fn || undefined };
    if (cs?.hScale && cs.hScale !== 100) look.sx = cs.hScale / 100;
    if (cs?.vScale && cs.vScale !== 100) look.sy = cs.vScale / 100;
    if (cs?.skew) look.skew = cs.skew;
    if (cs?.stroke) look.stroke = { color: cs.stroke === 'currentColor' ? color : txt(cs.stroke) ?? color, width: cs.strokeWidth ?? size * 0.03 };
    if (cs?.underline || cs?.strike || cs?.highlight) {
      look.deco = {
        u: cs.underline ? { w: cs.underlineWeight ?? Math.max(0.3, size * 0.055), o: cs.underlineOffset ?? size * 0.13, c: txt(cs.underlineColor) ?? color, k: cs.underlineStyle && cs.underlineStyle !== 'solid' && ULINE_KINDS.has(cs.underlineStyle) ? cs.underlineStyle as 'double' | 'dashed' | 'dotted' | 'wavy' : undefined, g: txt(cs.underlineGap) } : undefined,
        s: cs.strike ? { w: cs.strikeWeight ?? Math.max(0.3, size * 0.055), c: txt(cs.strikeColor) ?? color } : undefined,
        hl: (cs.highlight as unknown) === true ? '#f6e27a' : txt(cs.highlight),
      };
    }
    if (st.wari) {
      // Warichu: the note split over two half-size lines, as wide as the longer one.
      const font = this.font(st, extra, size);
      const ws = size * 0.5;
      const [a, b] = st.wari;
      const wa = measure(a, font, ws), wb = measure(b, font, ws);
      const w = Math.max(wa, wb) + size * 0.12;
      return [{ text: '', font, size, ls: 0, width: w, glyphW: w, color, deco: { ...look.deco, wari: { a, b, s: ws, wa, wb } } }];
    }
    if (cs?.emphasis) look.deco = { ...look.deco, em: { m: txt(cs.emphasis) ?? 'dot', s: size * 0.42 } };
    if (txt(cs?.link)) look.deco = { ...look.deco, link: cs!.link };
    if (st.ruby) {
      // Ruby: the annotation at half size; a base narrower than its annotation is spaced out to match.
      const font = this.font(st, extra, size);
      const rs = size * 0.5;
      const rw = measure(st.ruby, font, rs);
      const base = this.seg(text, font, size, ls, color, { ...look, deco: { ...look.deco, ruby: { t: st.ruby, s: rs, w: rw } } });
      const n = [...text].length;
      if (rw > base.width && n > 0) { const add = (rw - base.width) / n; base.ls += add; base.width += add * n; base.dx0 = add / 2; }
      return [base];
    }
    sc = sc || cs?.textTransform === 'small-caps';
    // Character rotation: every character its own run, turned about its centre.
    if (cs?.rotate && !sc) {
      const font = this.font(st, extra, size);
      return [...text].map((ch) => ({ ...this.seg(ch, font, size, ls, color, look), rot: cs.rotate }));
    }
    if (!sc) return [this.seg(text, this.font(st, extra, size), size, ls, color, look, manual)];
    const trial = this.font(st, { ...extra, smcp: true }, size);
    if (faceSupports(trial, 'smcp')) {
      // Small caps want a touch of letter-spacing (Bringhurst §3.2.2).
      return [this.seg(text, trial, size, ls + 0.05 * size, color, look, manual)];
    }
    // Synthetic small caps: lowercase → capitals at 72% with added tracking.
    const out: Seg[] = [];
    const font = this.font(st, extra, size);
    let buf = '';
    let start = 0, u = 0;
    let lower: boolean | null = null;
    const push = () => {
      if (!buf) return;
      const sz = lower ? size * 0.72 : size;
      const t = lower ? buf.toUpperCase() : buf;
      out.push(this.seg(t, lower ? this.font(st, extra, sz) : font, sz, ls + 0.05 * sz, color, look, t.length === buf.length ? manual?.slice(start, start + buf.length) : undefined));
      buf = '';
      start = u;
    };
    for (const ch of text) {
      const lc = isLower(ch);
      if (lower !== null && lc !== lower) push();
      lower = lc;
      buf += ch;
      u += ch.length;
    }
    push();
    return out;
  }

  sizeOf(st: SpanStyle): number {
    const cs = st.cs;
    return cs?.size ?? this.ps.size * ((cs?.sizeScale ?? 100) / 100);
  }

  wordSegs(word: Word, from: number, to: number, sc: boolean): Seg[] {
    const out: Seg[] = [];
    let off = 0;
    for (const p of word.pieces) {
      const a = Math.max(from, off), b = Math.min(to, off + p.text.length);
      if (b > a) out.push(...this.segs(p.text.slice(a - off, b - off), p.st, sc || p.st.sc || this.ps.forceSc, p.kern?.slice(a - off, b - off)));
      off += p.text.length;
    }
    return out;
  }

  space(): number {
    const font = this.font(PLAIN);
    const sp = measure(' ', font, this.ps.size);
    return sp * (1 + this.style.wordSpacing / 100) + (this.ps.tracking / 1000) * this.ps.size;
  }

  hyphen(word: Word, at: number): Seg {
    let off = 0;
    let st: SpanStyle = PLAIN;
    for (const p of word.pieces) {
      if (at <= off + p.text.length) { st = p.st; break; }
      off += p.text.length;
    }
    return this.segs('-', st, false)[0];
  }

  /** Leader dots / rules for tabs, in the paragraph's font. */
  leader(text: string): Seg {
    const font = this.font(PLAIN);
    const w = measure(text, font, this.ps.size);
    return { text, font, size: this.ps.size, ls: 0, width: w, glyphW: w, color: this.style.color };
  }
}

const sumW = (segs: Seg[]) => segs.reduce((s, g) => s + g.width, 0);
const letters = (t: string) => (t.match(/\p{L}/gu) ?? []).length;

/** Hyphenation exceptions: "ty-pog-ra-phy" fixes the breaks, a bare word never breaks. */
const dictCache = new WeakMap<string[], Map<string, number[] | null>>();
export function hyphenDictionary(list: string[] | undefined): Map<string, number[] | null> | null {
  if (!list || !list.length) return null;
  let d = dictCache.get(list);
  if (d) return d;
  d = new Map();
  for (const entry of list) {
    const e = entry.trim();
    if (!e) continue;
    const word = e.replace(/[-=·]/g, '').toLowerCase();
    if (!/[-=·]/.test(e)) { d.set(word, null); continue; }
    const pts: number[] = [];
    let n = 0;
    for (const ch of e) { if (/[-=·]/.test(ch)) pts.push(n); else n += ch.length; }
    d.set(word, pts);
  }
  dictCache.set(list, d);
  return d;
}

export function buildItems(p: Paragraph, style: TextStyle, ps: ParaStyle, scWords: number, ragged: boolean, dict: Map<string, number[] | null> | null, images?: StoryStyles['images'], measure = Infinity): Item[] {
  // Runs wider than this may break anywhere (see run below): 12 em, or the narrowest column if
  // narrower. Those breaks are a last resort (breakLines), so a run that fits is never split.
  const longRun = longRunWidth(style.fontSize, measure);
  const b = new ItemBuilder(style, ps, images);
  const items: Item[] = [];
  const sp = b.space();
  const justify = !ragged;
  const shaped = ragged && !!style.rag && style.rag !== 'natural';
  const rs = shaped ? 1.4 : 3;
  // Justification range for word spaces, % of the desired space (Bringhurst: keep it narrow).
  const stretch = Math.max(0.05, (style.wordSpaceMax ?? 150) / 100 - 1);
  const shrink = Math.max(0, Math.min(0.9, 1 - (style.wordSpaceMin ?? 67) / 100));
  const lsMax = Math.max(0, (style.letterSpaceMax ?? 0) / 1000), lsMin = Math.max(0, -(style.letterSpaceMin ?? 0) / 1000);
  const gsMax = Math.max(0, (style.glyphScaleMax ?? 100) / 100 - 1), gsMin = Math.max(0, 1 - (style.glyphScaleMin ?? 100) / 100);
  const bias = Math.max(0, Math.min(100, style.hyphenBias ?? 50));
  const hyphPen = ragged ? 50 + bias * 3 : 10 + bias * 0.8;
  const box = (segs: Seg[], word: number): Box => {
    let chars = 0, glyph = 0, lsSt = 0, lsSh = 0;
    for (const g of segs) {
      const n = [...g.text].length;
      chars += n;
      glyph += g.glyphW;
      lsSt += n * lsMax * g.size;
      lsSh += n * lsMin * g.size;
    }
    const j = justify && chars > 1;
    const bx: Box = { t: 'box', w: sumW(segs), segs, word, st: 0, sh: 0, lsSt: j ? lsSt : 0, lsSh: j ? lsSh : 0, gsSt: j ? glyph * gsMax : 0, gsSh: j ? glyph * gsMin : 0, chars };
    bx.st = bx.lsSt + bx.gsSt;
    bx.sh = bx.lsSh + bx.gsSh;
    return bx;
  };
  if (ps.indent > 0) items.push({ t: 'box', w: ps.indent, segs: [], word: -1, st: 0, sh: 0, lsSt: 0, lsSh: 0, gsSt: 0, gsSh: 0, chars: 0 });
  const nb = (w: Word | undefined, end: boolean) => !!w && !!(end ? w.pieces.at(-1) : w.pieces[0])?.st.cs?.noBreak;
  p.words.forEach((word, wi) => {
    const prev = p.words[wi - 1];
    switch (word.before) {
      case 'space': {
        let pen = 0;
        if (style.avoidRunts && wi === p.words.length - 1 && p.words.length > 3) pen = INF;
        if (nb(prev, true) && nb(word, false)) pen = INF;
        // Swiss / German practice: no line ends on a one- or two-letter word.
        if (pen < INF && style.avoidShortLineEnds && prev && letters(prev.text) > 0 && letters(prev.text) <= 2) pen = 400;
        if (justify) {
          if (pen) items.push({ t: 'pen', w: 0, p: pen, f: false });
          items.push({ t: 'glue', w: sp, st: sp * stretch, sh: sp * shrink });
        } else {
          items.push({ t: 'glue', w: 0, st: sp * rs, sh: 0 });
          items.push({ t: 'pen', w: 0, p: pen, f: false });
          items.push({ t: 'glue', w: sp, st: -sp * rs, sh: 0 });
        }
        break;
      }
      case 'br':
        items.push({ t: 'glue', w: 0, st: INF, sh: 0 });
        items.push({ t: 'pen', w: 0, p: -INF, f: false });
        break;
      case 'tab':
      case 'rtab':
        items.push({ t: 'tab', kind: word.before });
        break;
      default:
        break;
    }
    if (word.here) items.push({ t: 'here' });
    const sc = wi < scWords;
    const text = word.text;
    const noBreak = word.pieces.some((x) => x.st.cs?.noBreak || x.st.ruby != null || x.st.wari != null);
    // Break opportunities: discretionary hyphens, else hyphenation points; after explicit hyphens/dashes.
    const breaks: { at: number; hyph: boolean }[] = [];
    if (!noBreak) {
      for (let i = 1; i < text.length - 1; i++) if (/[-–—/]/.test(text[i - 1]) && /\p{L}/u.test(text[i])) breaks.push({ at: i, hyph: false });
      if (word.shy?.length) {
        for (const at of word.shy) if (at > 0 && at < text.length) breaks.push({ at, hyph: true });
      } else if (style.hyphenate && p.kind === 'body' && (style.hyphenateLastWord !== false || wi < p.words.length - 1)) {
        // Hyphenate only the alphabetic core of the word.
        const m = text.match(/^([^\p{L}]*)(\p{L}[\p{L}'’]*\p{L})([^\p{L}]*)$/u);
        if (m && m[2].length >= (style.hyphenMinWord ?? 5) && !/[A-Z]{2}/.test(m[2]) && (style.hyphenateCaps !== false || !/^\p{Lu}/u.test(m[2]))) {
          const custom = dict?.get(m[2].toLowerCase());
          const lang = word.pieces[0]?.st.cs?.language ?? style.language;
          const pts = custom !== undefined ? custom ?? [] : hyphenPoints(m[2].toLowerCase(), lang, style.hyphenBefore ?? 2, style.hyphenAfter ?? 3);
          for (const at of pts) breaks.push({ at: m[1].length + at, hyph: true });
        }
      }
    }
    breaks.sort((x, y) => x.at - y.at);
    // A run with nowhere to break that is wider than 12 em or its column (a URL, a long code) may also break
    // between any two characters, at a cost so high that it only happens when the run would
    // otherwise stick out of its column. No hyphen is added.
    const run = (from: number, to: number) => {
      const segs = b.wordSegs(word, from, to, sc);
      if (noBreak || sumW(segs) <= longRun) { items.push(box(segs, wi)); return; }
      let at = from;
      for (let k = from + 1; k <= to; k++) {
        if (k < to && !cuttable(text, k)) continue;
        if (at > from) items.push({ t: 'pen', w: 0, p: EMERGENCY_PEN, f: false, hyphen: null });
        items.push(box(b.wordSegs(word, at, k, sc), wi));
        at = k;
      }
    };
    let prevAt = 0;
    for (const br of breaks) {
      if (br.at <= prevAt) continue;
      run(prevAt, br.at);
      if (br.hyph) {
        const h = b.hyphen(word, br.at);
        items.push({ t: 'pen', w: h.width, p: hyphPen, f: true, hyphen: h });
      } else items.push({ t: 'pen', w: 0, p: 50, f: true, hyphen: null });
      prevAt = br.at;
    }
    run(prevAt, text.length);
  });
  items.push({ t: 'glue', w: 0, st: INF, sh: 0 });
  items.push({ t: 'pen', w: 0, p: -INF, f: true });
  return items;
}

/* -------------------------------------------------------------------------- */
/* Knuth–Plass                                                                 */
/* -------------------------------------------------------------------------- */

/** `hc`: consecutive lines ending in a hyphen up to this break. */
interface KPNode { pos: number; line: number; fit: number; w: number; st: number; sh: number; dem: number; hc: number; prev: KPNode | null }

const LINE_PENALTY = 10;
const FLAGGED_DEMERITS = 3000;
const FITNESS_DEMERITS = 3000;

export interface BreakOptions { hyphenLimit?: number; hyphenZone?: number; /** Allow breaks inside runs with nowhere to break (the last resort). */ emergency?: boolean }

function knuthPlass(items: Item[], widthAt: (line: number) => number, tolerance: number, o: BreakOptions = {}): number[] | null {
  const hyphenLimit = o.hyphenLimit ?? 0, zone = o.hyphenZone ?? 0;
  let active: KPNode[] = [{ pos: -1, line: 0, fit: 1, w: 0, st: 0, sh: 0, dem: 0, hc: 0, prev: null }];
  let W = 0, ST = 0, SH = 0;
  let wordStartW = 0, lastWord = -2;
  const n = items.length;

  const afterBreakTotals = (i: number) => {
    let w = W, st = ST, sh = SH;
    for (let j = i; j < n; j++) {
      const it = items[j];
      if (it.t === 'glue') { w += it.w; st += it.st; sh += it.sh; }
      else if (it.t === 'box' || (it.t === 'pen' && it.p === -INF && j > i)) break;
    }
    return { w, st, sh };
  };

  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (it.t === 'box') {
      if (it.word !== lastWord) { wordStartW = W; lastWord = it.word; }
      W += it.w; ST += it.st; SH += it.sh;
      continue;
    }
    if (it.t === 'here' || it.t === 'tab') continue;
    const legal = it.t === 'glue' ? i > 0 && items[i - 1].t === 'box' : it.p < INF && (it.p < EMERGENCY_PEN || !!o.emergency);
    if (legal) {
      const best = new Map<string, { dem: number; node: KPNode; fit: number; hc: number }>();
      const flagged = it.t === 'pen' && it.f && it.p > -INF;
      const next: KPNode[] = [];
      for (const a of active) {
        const lineW = widthAt(a.line);
        let w = W - a.w;
        if (it.t === 'pen') w += it.w;
        let r: number;
        if (w < lineW) { const st = ST - a.st; r = st > 0 ? (lineW - w) / st : INF; }
        else if (w > lineW) { const sh = SH - a.sh; r = sh > 0 ? (lineW - w) / sh : -INF; }
        else r = 0;
        const forced = it.t === 'pen' && it.p === -INF;
        const hc = flagged ? a.hc + 1 : 0;
        // Hyphenation zone: break a word only when the line would otherwise end far short.
        const zoneOk = !(zone > 0 && it.t === 'pen' && it.hyphen && lineW - (wordStartW - a.w) < zone);
        if (r >= -1 && r <= tolerance && zoneOk && !(hyphenLimit > 0 && hc > hyphenLimit)) {
          const bad = 100 * Math.abs(r) ** 3;
          const p = it.t === 'pen' ? it.p : 0;
          let dem = p >= 0 ? (LINE_PENALTY + bad) ** 2 + p * p : p > -INF ? (LINE_PENALTY + bad) ** 2 - p * p : (LINE_PENALTY + bad) ** 2;
          const prevItem = a.pos >= 0 ? items[a.pos] : null;
          if (it.t === 'pen' && it.f && prevItem && prevItem.t === 'pen' && prevItem.f) dem += FLAGGED_DEMERITS;
          const fit = r < -0.5 ? 0 : r <= 0.5 ? 1 : r <= 1 ? 2 : 3;
          if (Math.abs(fit - a.fit) > 1) dem += FITNESS_DEMERITS;
          dem += a.dem;
          const key = `${a.line + 1}:${fit}:${hc}`;
          const cur = best.get(key);
          if (!cur || dem < cur.dem) best.set(key, { dem, node: a, fit, hc });
        }
        // Keep the node active unless the line is now overfull or a forced break passed it.
        if (!(r < -1 || forced)) next.push(a);
      }
      if (best.size) {
        const totals = afterBreakTotals(i);
        for (const [key, b] of best) {
          const line = +key.split(':')[0];
          next.push({ pos: i, line, fit: b.fit, ...totals, dem: b.dem, hc: b.hc, prev: b.node });
        }
      }
      active = next;
      if (!active.length) return null;
    }
    if (it.t === 'glue') { W += it.w; ST += it.st; SH += it.sh; }
  }
  const finals = active.filter((a) => a.pos === n - 1);
  if (!finals.length) return null;
  let bestNode = finals[0];
  for (const a of finals) if (a.dem < bestNode.dem) bestNode = a;
  const out: number[] = [];
  for (let node: KPNode | null = bestNode; node && node.pos >= 0; node = node.prev) out.unshift(node.pos);
  return out;
}

/** First fit: the single-line composer, and the fallback when no total-fit solution exists. */
export function greedy(items: Item[], widthAt: (line: number) => number): number[] {
  const out: number[] = [];
  // Where the line could end: the last ordinary break, else the last emergency break inside a long run.
  let w = 0, line = 0, lastBreak = -1, lastEmergency = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t === 'box') {
      const at = lastBreak >= 0 ? lastBreak : lastEmergency;
      if (w + it.w > widthAt(line) && at >= 0) {
        out.push(at);
        line++;
        const restart = at;
        lastBreak = -1;
        lastEmergency = -1;
        w = 0;
        i = restart;
        // Skip discardables after the break.
        while (i + 1 < items.length && items[i + 1].t !== 'box' && !(items[i + 1].t === 'pen' && (items[i + 1] as Pen).p === -INF)) i++;
        continue;
      }
      w += it.w;
    } else if (it.t === 'glue') {
      if (i > 0 && items[i - 1].t === 'box') lastBreak = i;
      if (w > 0) w += it.w;
    } else if (it.t === 'pen') {
      if (it.p === -INF) { out.push(i); line++; w = 0; lastBreak = -1; lastEmergency = -1; continue; }
      // A line already too full (a run wider than the column) still ends at its first chance.
      if (it.p < INF && (w + it.w <= widthAt(line) || (lastBreak < 0 && lastEmergency < 0))) { if (it.p >= EMERGENCY_PEN) lastEmergency = i; else lastBreak = i; }
    }
  }
  if (!out.length || out[out.length - 1] !== items.length - 1) out.push(items.length - 1);
  return out;
}

function breakLines(items: Item[], widthAt0: (line: number) => number, o: BreakOptions): number[] {
  // A non-finite width anywhere would make every line infeasible and the search run to the end each time.
  for (const it of items) {
    if (it.t === 'box' || it.t === 'glue') {
      if (!Number.isFinite(it.w)) it.w = 0;
      if (!Number.isFinite(it.st)) it.st = 0;
      if (!Number.isFinite(it.sh)) it.sh = 0;
    } else if (it.t === 'pen' && !Number.isFinite(it.w)) it.w = 0;
  }
  const widthAt = (line: number) => { const w = widthAt0(line); return Number.isFinite(w) ? w : 0; };
  // A run is broken mid-word only when no looser setting of the paragraph keeps it whole.
  return knuthPlass(items, widthAt, 2, o) ?? knuthPlass(items, widthAt, 8, o) ?? knuthPlass(items, widthAt, 8) ?? knuthPlass(items, widthAt, 8, { emergency: true }) ?? greedy(items, widthAt);
}

/** Line breaks for a paragraph, with the rag shaped as the style asks. */
export function breakParagraph(items: Item[], widthAt: (line: number) => number, style: TextStyle, ragged: boolean): number[] {
  const o: BreakOptions = { hyphenLimit: style.hyphenLimit ?? 0, hyphenZone: ragged ? style.hyphenZone ?? 0 : 0 };
  if (style.composer === 'single') return greedy(items, widthAt);
  const rag = ragged ? style.rag ?? 'natural' : 'natural';
  if (rag === 'natural') return breakLines(items, widthAt, o);
  const a = Math.max(0.02, Math.min(0.6, (style.ragAmount ?? 12) / 100));
  if (rag === 'swiss') {
    // Short line, long line, short line, long line: alternate target measures.
    const longFirst = style.ragStartLong !== false;
    return breakLines(items, (ln) => widthAt(ln) * ((ln % 2 === 0) === longFirst ? 1 : 1 - a), o);
  }
  if (rag === 'pattern') {
    const pat = (style.ragPattern ?? '').split(/[\s,]+/).map(Number).filter((v) => v > 10 && v <= 100);
    const seq = pat.length ? pat : [100, 100 - a * 100];
    return breakLines(items, (ln) => widthAt(ln) * (seq[ln % seq.length] / 100), o);
  }
  const natural = breakLines(items, widthAt, o);
  const n = natural.length;
  if (n <= 1 || items.length > 3000) return natural;
  if (rag === 'wedge') {
    // Each line a little shorter than the one above (or the inverse for a centred pyramid).
    return breakLines(items, (ln) => widthAt(ln) * (1 - a * Math.min(1, ln / Math.max(1, n - 1))), o);
  }
  // Balanced: the narrowest measure that still sets in the same number of lines.
  let lo = 0.35, hi = 1;
  for (let k = 0; k < 9; k++) {
    const mid = (lo + hi) / 2;
    if (breakLines(items, (ln) => widthAt(ln) * mid, o).length <= n) hi = mid; else lo = mid;
  }
  return breakLines(items, (ln) => widthAt(ln) * hi, o);
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

export interface TabResolution { width: number; leader?: string }

/** Natural width of the items after `i` up to the next tab, forced break or line end (and to a decimal). */
function segmentAfter(items: Item[], i: number, decimal: string): { w: number; dec: number } {
  let w = 0, dec = -1;
  for (let j = i + 1; j < items.length; j++) {
    const it = items[j];
    if (it.t === 'tab' || (it.t === 'pen' && it.p === -INF)) break;
    if (it.t === 'box') {
      if (dec < 0) {
        let acc = 0;
        for (const g of it.segs) {
          const k = g.text.indexOf(decimal);
          if (k >= 0) { dec = w + acc + (g.width * k) / Math.max(1, g.text.length); break; }
          acc += g.width;
        }
      }
      w += it.w;
    } else if (it.t === 'glue') w += it.w;
  }
  return { w, dec: dec < 0 ? w : dec };
}

/**
 * First-fit composition for paragraphs with tabs. Tab positions are measured from the column's
 * left edge (`lineLeft(ln)` gives each line's start relative to it); stops repeat every
 * `defaultTab` after the last one.
 */
export function tabCompose(items: Item[], widthAt: (ln: number) => number, lineLeft: (ln: number) => number, style: TextStyle): { breaks: number[]; tabs: Map<number, TabResolution> } {
  const stops = [...(style.tabStops ?? [])].sort((a, b) => a.pos - b.pos);
  const def = Math.max(6, style.defaultTab ?? 36);
  const tabs = new Map<number, TabResolution>();
  const breaks: number[] = [];
  let ln = 0, x = 0, lastBreak = -1, lineStart = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const W = widthAt(ln);
    if (it.t === 'box') {
      if (x + it.w > W + 0.01 && lastBreak > lineStart) {
        breaks.push(lastBreak);
        ln++; x = 0; i = lastBreak; lineStart = lastBreak + 1; lastBreak = -1;
        continue;
      }
      x += it.w;
    } else if (it.t === 'glue') {
      if (i > 0 && items[i - 1].t === 'box') lastBreak = i;
      if (x > 0) x += it.w;
    } else if (it.t === 'pen') {
      if (it.p === -INF) { breaks.push(i); ln++; x = 0; lastBreak = -1; lineStart = i + 1; }
    } else if (it.t === 'tab') {
      const abs = lineLeft(ln) + x;
      let to = x, leader: string | undefined;
      if (it.kind === 'rtab') {
        const seg = segmentAfter(items, i, '.');
        to = Math.max(x, W - seg.w);
        leader = style.rightTabLeader || undefined;
      } else {
        // The first stop the following text can reach without running back over what is set;
        // text that has overrun a stop goes on to the next one (or the default stops).
        const minGap = (style.fontSize ?? 10) * 0.25;
        let found = false;
        for (const stop of stops) {
          if (stop.pos <= abs + 0.01) continue;
          const seg = segmentAfter(items, i, stop.char || '.');
          const rel = stop.pos - lineLeft(ln);
          const off = stop.align === 'right' ? seg.w : stop.align === 'center' ? seg.w / 2 : stop.align === 'decimal' ? seg.dec : 0;
          if (rel - off < x + (stop.align === 'left' ? 0 : minGap)) continue;
          to = rel - off;
          leader = stop.leader || undefined;
          found = true;
          break;
        }
        if (!found) to = Math.ceil((abs + minGap) / def) * def - lineLeft(ln);
      }
      tabs.set(i, { width: to - x, leader });
      x = to;
    }
  }
  if (!breaks.length || breaks[breaks.length - 1] !== items.length - 1) breaks.push(items.length - 1);
  return { breaks, tabs };
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

export interface Line {
  start: number;
  end: number;
  hyphen: Seg | null;
  last: boolean;
}

export function linesFromBreaks(items: Item[], breaks: number[], from: number): Line[] {
  const lines: Line[] = [];
  let start = from;
  for (const br of breaks) {
    while (start < br && items[start].t !== 'box' && items[start].t !== 'tab' && items[start].t !== 'here') start++;
    const it = items[br];
    lines.push({ start, end: br, hyphen: it.t === 'pen' && it.hyphen ? it.hyphen : null, last: it.t === 'pen' && it.p === -INF });
    start = br + 1;
  }
  return lines;
}

const L_PROTRUDE: Record<string, number> = { '“': 1, '‘': 1, '"': 1, "'": 1, '«': 0.7, '‹': 0.7, '(': 0.3, '[': 0.3, '¿': 0.5, '¡': 0.5, A: 0.05, T: 0.05, V: 0.05, W: 0.05, Y: 0.05, J: 0.05, v: 0.05, w: 0.05, y: 0.05 };
const R_PROTRUDE: Record<string, number> = { '.': 0.7, ',': 0.7, '-': 0.7, '‐': 0.7, '–': 0.3, '—': 0.2, '’': 1, '”': 1, '"': 1, "'": 1, ':': 0.5, ';': 0.5, '!': 0.2, '?': 0.2, ')': 0.3, ']': 0.3, '»': 0.7, '›': 0.7, '…': 0.3, A: 0.05, T: 0.05, V: 0.05, W: 0.05, Y: 0.05, k: 0.04, r: 0.04, v: 0.05, w: 0.05, y: 0.05 };

function protrusion(seg: Seg | undefined, side: 'l' | 'r', amount: number): number {
  if (!seg || !seg.text) return 0;
  const chars = [...seg.text];
  const ch = side === 'l' ? chars[0] : chars[chars.length - 1];
  const f = (side === 'l' ? L_PROTRUDE : R_PROTRUDE)[ch];
  if (!f) return 0;
  return f * amount * measure(ch, seg.font, seg.size) * (seg.sx ?? 1);
}

export interface Placed { runs: TextRun[]; width: number; ratio: number; chars: number; justified: boolean; hereX: number | null }

function sameFont(a: FontRef, b: FontRef): boolean {
  return a === b || (a.face === b.face && a.css === b.css && a.weight === b.weight && a.italic === b.italic &&
    JSON.stringify(a.axes) === JSON.stringify(b.axes) && JSON.stringify(a.features) === JSON.stringify(b.features));
}
const sameLook = (a: TextRun, b: TextRun) => a.scaleX === b.scaleX && a.scaleY === b.scaleY && a.skew === b.skew &&
  JSON.stringify(a.stroke) === JSON.stringify(b.stroke) && JSON.stringify(a.deco) === JSON.stringify(b.deco);

export interface PlaceOptions {
  align: TextStyle['align'];
  optical: boolean;
  opticalAmount: number;
  rtl: boolean;
  baseline: number;
  xOffset: number;
  mergeSpaces: boolean;
  lastLineAlign?: TextStyle['lastLineAlign'];
  singleWord?: TextStyle['singleWordJustify'];
  tabs?: Map<number, TabResolution>;
  /** Column-left x of the line start, for aligning leaders across lines. */
  leaderOrigin?: number;
  leader?: (text: string) => Seg;
}

function runOf(s: Seg, x: number, baseline: number, extraLs = 0, scale = 1): TextRun {
  const sx = (s.sx ?? 1) * scale;
  const n = [...s.text].length;
  const ls = s.ls + extraLs;
  const kernSum = s.kern ? s.kern.reduce((a, b) => a + b, 0) : 0;
  const width = s.glyphW * scale + ls * n + kernSum;
  const r: TextRun = { x: x + (s.dx0 ?? 0), y: baseline - (s.dy ?? 0), text: s.text, font: s.font, size: s.size, color: s.color, width };
  // Scaled runs carry pre-scale spacing so the renderers' transform lands them exactly.
  if (sx !== 1) { r.scaleX = sx; r.letterSpacing = ls / sx; r.kern = s.kern?.map((k) => k / sx); }
  else { r.letterSpacing = ls; r.kern = s.kern; }
  if (s.sy && s.sy !== 1) r.scaleY = s.sy;
  if (s.skew) r.skew = s.skew;
  if (s.stroke) r.stroke = s.stroke;
  if (s.deco) r.deco = s.deco;
  if (s.rot) { r.rotate = s.rot; r.pivot = [x + width / 2, r.y - s.size * 0.33]; }
  return r;
}

export function placeLine(items: Item[], line: Line, lineW: number, o: PlaceOptions): Placed {
  // Right-to-left lines are composed left-to-right with mirrored alignment, then mirrored.
  const align0 = o.rtl ? (o.align === 'left' ? 'right' : o.align === 'right' ? 'left' : o.align) : o.align;
  let natural = 0, st = 0, sh = 0, glues = 0, boxes = 0;
  for (let i = line.start; i < line.end; i++) {
    const it = items[i];
    if (it.t === 'box') { natural += it.w; st += it.st; sh += it.sh; if (it.segs.length) boxes++; }
    else if (it.t === 'glue') { natural += it.w; st += it.st; sh += it.sh; glues++; }
    else if (it.t === 'tab') natural += o.tabs?.get(i)?.width ?? 0;
  }
  if (line.hyphen) natural += line.hyphen.width;
  const hasTabs = !!o.tabs && o.tabs.size > 0;

  // Optical margin alignment: let punctuation and some round/diagonal letters hang.
  let firstSeg: Seg | undefined, lastSeg: Seg | undefined;
  for (let i = line.start; i < line.end && !firstSeg; i++) { const it = items[i]; if (it.t === 'box' && it.segs.length) firstSeg = it.segs[0]; }
  if (line.hyphen) lastSeg = line.hyphen;
  for (let i = line.end - 1; i >= line.start && !lastSeg; i--) { const it = items[i]; if (it.t === 'box' && it.segs.length) lastSeg = it.segs[it.segs.length - 1]; }
  const amt = o.opticalAmount;
  const lp = o.optical && !o.rtl ? protrusion(firstSeg, 'l', amt) : 0;
  const rp = o.optical && !o.rtl ? protrusion(lastSeg, 'r', amt) : 0;

  // Last line of a justified paragraph, and lines holding a single word.
  let align = align0;
  if (align === 'justify' && line.last) align = o.lastLineAlign === 'justify' ? 'justify-all' : (o.lastLineAlign ?? 'left') as TextStyle['align'];
  const single = glues === 0 && boxes === 1;
  let letterFill = 0;
  if ((align === 'justify' || align === 'justify-all') && single && !line.last && !hasTabs) {
    const sw = o.singleWord ?? 'left';
    if (sw === 'full') {
      let chars = 0;
      for (let i = line.start; i < line.end; i++) { const it = items[i]; if (it.t === 'box') chars += it.chars; }
      if (chars > 1) letterFill = (lineW + lp + rp - natural) / (chars - 1);
      align = 'left';
    } else align = sw === 'center' ? 'center' : sw === 'right' ? 'right' : 'left';
  }
  const justify = !hasTabs && (align === 'justify-all' || (align === 'justify' && !line.last));
  const target = lineW + lp + rp;
  let r = 0;
  if (justify) {
    if (natural < target && st > 0 && st < INF / 2) r = (target - natural) / st;
    else if (natural > target && sh > 0) r = Math.max(-1, (target - natural) / sh);
  } else if (natural > target && sh > 0 && !hasTabs) {
    r = Math.max(-1, (target - natural) / sh);
  }

  let x = 0;
  let hereX: number | null = null;
  const runs: TextRun[] = [];
  for (let i = line.start; i < line.end; i++) {
    const it = items[i];
    if (it.t === 'box') {
      const lsExtra = it.chars > 0 ? (r > 0 ? r * it.lsSt : r * it.lsSh) / it.chars : 0;
      const glyph = it.segs.reduce((a, g) => a + g.glyphW, 0);
      const scale = glyph > 0 ? 1 + (r > 0 ? r * it.gsSt : r * it.gsSh) / glyph : 1;
      for (const s of it.segs) {
        if (s.obj) {
          runs.push({ x, y: o.baseline - (s.dy ?? 0), text: '', font: s.font, size: s.size, color: s.color, width: s.width, obj: { ...s.obj } });
          x += s.width;
          continue;
        }
        if (!s.text) {
          if (s.deco?.wari) runs.push({ x, y: o.baseline - (s.dy ?? 0), text: '', font: s.font, size: s.size, color: s.color, width: s.width, deco: s.deco });
          x += s.width;
          continue;
        }
        const run = runOf(s, x, o.baseline, lsExtra + letterFill, scale);
        runs.push(run);
        x += run.width;
      }
      if (it.segs.length === 0) x += it.w;
    } else if (it.t === 'glue') {
      x += it.w + (r > 0 ? r * it.st : r * it.sh);
    } else if (it.t === 'tab') {
      const res = o.tabs?.get(i);
      const w = res?.width ?? 0;
      if (res?.leader && o.leader && w > 0) {
        // Leaders sit on a grid from the column edge so dots line up from line to line.
        const unit = o.leader(res.leader);
        if (unit.width > 0.1) {
          const origin = o.leaderOrigin ?? 0;
          const pad = unit.width * 0.4;
          const k0 = Math.ceil((origin + x + pad) / unit.width), k1 = Math.floor((origin + x + w - pad) / unit.width);
          if (k1 > k0) {
            const text = res.leader.repeat(k1 - k0);
            runs.push({ x: k0 * unit.width - origin, y: o.baseline, text, font: unit.font, size: unit.size, color: unit.color, width: unit.width * (k1 - k0), letterSpacing: 0 });
          }
        }
      }
      x += w;
    } else if (it.t === 'here') hereX = x;
  }
  if (line.hyphen) {
    const run = runOf(line.hyphen, x, o.baseline);
    runs.push(run);
    x += run.width;
  }
  const width = x;
  let x0: number;
  if (justify) x0 = -lp;
  else if (align === 'right') x0 = lineW - width + rp;
  else if (align === 'center') x0 = (lineW - width) / 2 + (rp - lp) / 2;
  else x0 = -lp;
  for (const run of runs) {
    const before = run.x;
    run.x = o.rtl ? o.xOffset + lineW - (run.x + x0 + run.width) : o.xOffset + run.x + x0;
    if (run.pivot) run.pivot = [run.pivot[0] + run.x - before, run.pivot[1]];
    if (o.rtl) run.dir = 'rtl';
  }
  if (hereX != null) hereX += x0;
  const chars = runs.reduce((n, rr) => n + [...rr.text].length, 0) + Math.max(0, runs.length - 1);
  if (o.rtl || justify || hasTabs || letterFill || runs.some((rr) => rr.obj || rr.rotate)) return { runs, width, ratio: justify ? r : 0, chars, justified: justify, hereX };
  // Ragged lines: merge words into one run per font so the SVG stays light. The glue equals
  // the font's own space advance, which is exactly what the browser will set.
  const merged: TextRun[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && sameFont(prev.font, run.font) && prev.size === run.size && prev.color === run.color && prev.letterSpacing === run.letterSpacing && prev.y === run.y && sameLook(prev, run)) {
      const gap = run.x - (prev.x + prev.width);
      // Joined runs keep their kerning, with a zero entry for the joining space.
      const joinKern = (sep: string) => {
        if (!prev.kern && !run.kern) return;
        prev.kern = [...(prev.kern ?? new Array<number>(prev.text.length).fill(0)), ...new Array<number>(sep.length).fill(0), ...(run.kern ?? new Array<number>(run.text.length).fill(0))];
      };
      if (Math.abs(gap) < 0.01) { joinKern(''); prev.text += run.text; prev.width += run.width; continue; }
      if (o.mergeSpaces && !prev.scaleX) {
        const sp = measure(' ', prev.font, prev.size) + (prev.letterSpacing ?? 0);
        if (Math.abs(gap - sp) < 0.02) { joinKern(' '); prev.text += ' ' + run.text; prev.width += gap + run.width; continue; }
      }
    }
    merged.push({ ...run, kern: run.kern ? [...run.kern] : undefined });
  }
  return { runs: merged, width, ratio: r, chars, justified: false, hereX };
}

export { fontMetrics };
