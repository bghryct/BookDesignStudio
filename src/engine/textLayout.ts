/**
 * The text engine.
 *
 *  • Knuth–Plass total-fit line breaking (justified and ragged), with Liang hyphenation,
 *    flagged-penalty demerits for consecutive hyphens and fitness-class demerits, so
 *    spacing stays even down the page (Bringhurst §2.1, Hochuli's "even colour").
 *  • Optical margin alignment / hanging punctuation applied per line.
 *  • Baseline-grid locking (Müller-Brockmann / Bosshard).
 *  • Drop caps sized so the initial's cap height spans exactly N lines, with optional
 *    Cleves illumination frames.
 *  • True small caps from the font, or synthesised when the font lacks `smcp`.
 *  • Threads (overflow into linked frames), multi-column frames, RTL lines and
 *    Japanese vertical setting (tategaki) with kinsoku and tate-chū-yoko.
 *
 * Output is display-list primitives positioned in frame-local pt.
 */
import type { TextStyle, TextElement, ParagraphStyleDef, CharacterStyleDef, ParagraphStyleProps, CharacterStyleProps } from '../model/types';
import type { FontRef, Prim, TextRun } from '../render/primitives';
import { resolveFont, measure, fontMetrics, faceSupports, useFontStore, opticalKerning } from './fonts';
import { hyphenPoints } from './hyphenate';
import { illuminatedFrame } from './generators/cleves';
import { toRoman } from '../model/units';

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface TokenContext {
  page: number;
  pages: number;
  title: string;
  subtitle: string;
  author: string;
  publisher: string;
}

/** The project's named styles, used by `[Name]` paragraph tags and `<Name>…</Name>` runs. */
export interface StoryStyles { para: ParagraphStyleDef[]; char: CharacterStyleDef[] }

export interface FrameSpec {
  w: number;
  h: number;
  columns: number;
  columnGap: number;
  inset: number;
  verticalAlign: 'top' | 'middle' | 'bottom';
  /** Frame-local y of any baseline-grid line, and the grid increment. */
  grid?: { origin: number; increment: number } | null;
}

/** Per-line facts for the editor's micro-typography checks. */
export interface LineInfo {
  x: number;
  y: number;
  w: number;
  /** Knuth–Plass adjustment ratio actually used: > 0 loose (spaces stretched), < 0 tight. */
  ratio?: number;
  /** Characters on the line (for the measure readout). */
  chars?: number;
  /** Last line of its paragraph (never stretched). */
  last?: boolean;
  /** Line was justified (spaces adjusted). */
  justified?: boolean;
  hyphenated?: boolean;
}

export interface FrameLayout {
  prims: Prim[];
  lineCount: number;
  overflow: boolean;
  baselines: number[];
  /** Line boxes (frame-local) — used by manuscript ruling and the editor. */
  lines: LineInfo[];
}

/* -------------------------------------------------------------------------- */
/* Tokens & inline markup                                                      */
/* -------------------------------------------------------------------------- */

export function expandTokens(text: string, t: TokenContext): string {
  return text.replace(/\{(page|pages|title|subtitle|author|publisher|year)(?::(roman|ROMAN))?\}/g, (_, k: string, fmt?: string) => {
    switch (k) {
      case 'page': return fmt === 'roman' ? toRoman(t.page) : fmt === 'ROMAN' ? toRoman(t.page, true) : String(t.page);
      case 'pages': return String(t.pages);
      case 'title': return t.title;
      case 'subtitle': return t.subtitle;
      case 'author': return t.author;
      case 'publisher': return t.publisher;
      case 'year': return String(new Date().getFullYear());
      default: return '';
    }
  });
}

interface SpanStyle { italic: boolean; bold: boolean; sc: boolean; cs: CharacterStyleProps | null }
/** `kern[i]`: manual kerning after UTF-16 unit `i`, thousandths of an em. */
interface Piece { text: string; st: SpanStyle; kern?: number[] }
interface Word { pieces: Piece[]; text: string }
type ParaKind = 'body' | 'h1' | 'h2' | 'break';
interface Paragraph { kind: ParaKind; words: Word[]; first: boolean; style: TextStyle; pstyle: ParagraphStyleProps | null }

const PLAIN: SpanStyle = { italic: false, bold: false, sc: false, cs: null };

/** The frame style with a paragraph style laid over it (unset properties inherit). */
export function applyParagraphStyle(s: TextStyle, p: ParagraphStyleProps | null | undefined): TextStyle {
  if (!p) return s;
  const out: TextStyle = { ...s };
  const keys = ['fontFamily', 'fontSize', 'leading', 'weight', 'italic', 'tracking', 'color', 'align', 'firstLineIndent', 'leftIndent', 'rightIndent', 'textTransform', 'hyphenate', 'kerning'] as const;
  for (const k of keys) if (p[k] != null) (out as unknown as Record<string, unknown>)[k] = p[k];
  // A new size without a new leading keeps the frame's proportion of leading to size.
  if (p.fontSize != null && p.leading == null) out.leading = +((s.leading * p.fontSize) / s.fontSize).toFixed(2);
  if (p.fontFamily != null && p.fontFamily !== s.fontFamily) out.axes = {};
  if (p.features) out.features = { ...s.features, ...p.features };
  return out;
}

const mergeCs = (stack: CharacterStyleProps[]): CharacterStyleProps | null =>
  stack.length ? stack.reduce<CharacterStyleProps>((a, b) => ({ ...a, ...b, features: { ...(a.features ?? {}), ...(b.features ?? {}) } }), {}) : null;

const nameKey = (n: string) => n.trim().toLowerCase();

/**
 * `*italic*`, `**bold**`, `^small caps^`; `\*` escapes. Lines: `# `, `## `, `---`.
 * `[Style] ` at the start of a line applies a paragraph style, `<Style>…</Style>` (or `</>`) a
 * character style, `{k:-20}` kerns the following pair by thousandths of an em.
 */
function parseStory(text: string, style: TextStyle, styles: StoryStyles | null): Paragraph[] {
  const pmap = new Map((styles?.para ?? []).map((d) => [nameKey(d.name), d.props]));
  const cmap = new Map((styles?.char ?? []).map((d) => [nameKey(d.name), d.props]));
  const paras: Paragraph[] = [];
  let afterBreak = true;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) { continue; }
    let pstyle: ParagraphStyleProps | null = null;
    const tag = /^\[([^\]]{1,60})\]\s*/.exec(line);
    if (tag && pmap.has(nameKey(tag[1]))) {
      pstyle = pmap.get(nameKey(tag[1]))!;
      line = line.slice(tag[0].length);
      if (!line.trim()) continue;
    }
    let kind: ParaKind = 'body';
    let body = line;
    if (/^#\s/.test(line)) { kind = 'h1'; body = line.slice(2); }
    else if (/^##\s/.test(line)) { kind = 'h2'; body = line.slice(3); }
    else if (/^(-{3,}|\*\s\*\s\*|⁂)$/.test(line.trim())) { kind = 'break'; body = '⁂'; }
    const eff = applyParagraphStyle(style, pstyle);
    const words = parseInline(body, eff, cmap);
    paras.push({ kind, words, first: afterBreak, style: eff, pstyle });
    afterBreak = kind !== 'body';
  }
  return paras;
}

function parseInline(s: string, style: TextStyle, cmap: Map<string, CharacterStyleProps>): Word[] {
  const st: SpanStyle = { ...PLAIN };
  const csStack: CharacterStyleProps[] = [];
  const words: Word[] = [];
  let cur: Piece[] = [];
  let buf = '';
  let kbuf: number[] = [];
  const flush = () => {
    if (buf) cur.push({ text: buf, st: { ...st }, kern: kbuf.some((v) => v) ? Array.from({ length: buf.length }, (_, i) => kbuf[i] ?? 0) : undefined });
    buf = '';
    kbuf = [];
  };
  const endWord = () => {
    flush();
    if (cur.length) words.push({ pieces: cur, text: cur.map((p) => p.text).join('') });
    cur = [];
  };
  // Kerning after the last character set so far (a kern at a word start widens the space).
  const addKern = (n: number) => {
    if (buf) { kbuf[buf.length - 1] = (kbuf[buf.length - 1] ?? 0) + n; return; }
    const piece = cur.length ? cur[cur.length - 1] : words.length ? words[words.length - 1].pieces.at(-1) : undefined;
    if (!piece) return;
    piece.kern ??= new Array<number>(piece.text.length).fill(0);
    piece.kern[piece.text.length - 1] += n;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { buf += s[++i]; continue; }
    if (ch === '{') {
      const m = /^\{k:([+-]?\d+(?:\.\d+)?)\}/.exec(s.slice(i, i + 16));
      if (m) { addKern(parseFloat(m[1])); i += m[0].length - 1; continue; }
    }
    if (ch === '<' && cmap.size) {
      const m = /^<(\/?)([^<>/]{0,40})>/.exec(s.slice(i, i + 46));
      if (m) {
        const name = nameKey(m[2]);
        if (m[1] && csStack.length && (!name || cmap.has(name))) { flush(); csStack.pop(); st.cs = mergeCs(csStack); i += m[0].length - 1; continue; }
        if (!m[1] && cmap.has(name)) { flush(); csStack.push(cmap.get(name)!); st.cs = mergeCs(csStack); i += m[0].length - 1; continue; }
      }
    }
    if (ch === '*' && s[i + 1] === '*') { flush(); st.bold = !st.bold; i++; continue; }
    if (ch === '*') { flush(); st.italic = !st.italic; continue; }
    if (ch === '^') { flush(); st.sc = !st.sc; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    buf += ch;
  }
  endWord();
  for (const w of words) {
    let changed = false;
    for (const p of w.pieces) {
      const tt = p.st.cs?.textTransform && p.st.cs.textTransform !== 'none' ? p.st.cs.textTransform : style.textTransform;
      if (tt !== 'uppercase' && tt !== 'lowercase') continue;
      const next = tt === 'uppercase' ? p.text.toUpperCase() : p.text.toLowerCase();
      if (next.length !== p.text.length) p.kern = undefined;
      p.text = next;
      changed = true;
    }
    if (changed) w.text = w.pieces.map((p) => p.text).join('');
  }
  return words;
}

/* -------------------------------------------------------------------------- */
/* Measured items                                                              */
/* -------------------------------------------------------------------------- */

/** `kern`: extra advance after each UTF-16 unit, pt; `dy`: baseline shift, pt (up). */
interface Seg { text: string; font: FontRef; size: number; ls: number; width: number; color: string; kern?: number[]; dy?: number }

interface Box { t: 'box'; w: number; segs: Seg[]; word: number }
interface Glue { t: 'glue'; w: number; st: number; sh: number }
interface Pen { t: 'pen'; w: number; p: number; f: boolean; hyphen?: Seg | null }
type Item = Box | Glue | Pen;

const INF = 10000;

interface ParaStyle {
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
}

function paraStyle(p: Paragraph, s: TextStyle): ParaStyle {
  const base: ParaStyle = {
    size: s.fontSize, leading: s.leading, align: s.align,
    // A negative first-line indent hangs, on every paragraph (lists, bibliographies).
    indent: s.firstLineIndent < 0 ? s.firstLineIndent : p.first && !s.indentFirstParagraph ? 0 : s.firstLineIndent,
    spaceBefore: p.first ? 0 : p.pstyle?.spaceBefore ?? s.paragraphSpacing, spaceAfter: p.pstyle?.spaceAfter ?? 0,
    weight: s.weight, tracking: s.tracking, forceSc: s.textTransform === 'small-caps', left: s.leftIndent ?? 0, right: s.rightIndent ?? 0,
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

class ItemBuilder {
  private rtl: boolean;
  constructor(private style: TextStyle, private ps: ParaStyle) { this.rtl = style.direction === 'rtl'; }

  font(st: SpanStyle, extraFeatures?: Record<string, boolean>): FontRef {
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
    const family = cs?.fontFamily ?? s.fontFamily;
    return resolveFont({ family, weight, italic, axes: family === s.fontFamily ? s.axes : {}, features, size: this.ps.size });
  }

  /** One measured segment; manual (‰ em) and optical kerning become extra advance per character. */
  private seg(text: string, font: FontRef, size: number, ls: number, color: string, dy: number, manual?: number[]): Seg {
    let kern: number[] | undefined;
    if (!this.rtl) {
      const man = manual && manual.length === text.length && manual.some((v) => v) ? manual : null;
      const opt = this.style.kerning === 'optical' ? opticalKerning(text, font) : null;
      if (man || opt) kern = Array.from({ length: text.length }, (_, i) => ((man?.[i] ?? 0) / 1000) * size + (opt ? opt[i] * size : 0));
    }
    const kw = kern ? kern.reduce((a, b) => a + b, 0) : 0;
    return { text, font, size, ls, width: measure(text, font, size) + ls * [...text].length + kw, color, kern, dy: dy || undefined };
  }

  /** Measure a piece of text in a span style, synthesising small caps when needed. */
  segs(text: string, st: SpanStyle, sc: boolean, manual?: number[]): Seg[] {
    const ps = this.ps;
    const cs = st.cs;
    let size = ps.size * ((cs?.sizeScale ?? 100) / 100);
    let dy = cs?.baselineShift ?? 0;
    let extra: Record<string, boolean> | undefined;
    if (cs?.position === 'superscript' || cs?.position === 'subscript') {
      // True superior / inferior figures when the font has them, else scaled and shifted.
      const tag = cs.position === 'superscript' ? 'sups' : 'subs';
      if (faceSupports(this.font(st, { [tag]: true }), tag)) extra = { [tag]: true };
      else { dy += cs.position === 'superscript' ? size * 0.33 : -size * 0.14; size *= 0.62; }
    }
    const color = cs?.color ?? this.style.color;
    const ls = ((ps.tracking + (cs?.tracking ?? 0)) / 1000) * size;
    sc = sc || cs?.textTransform === 'small-caps';
    if (!sc) return [this.seg(text, this.font(st, extra), size, ls, color, dy, manual)];
    const trial = this.font(st, { ...extra, smcp: true });
    if (faceSupports(trial, 'smcp')) {
      // Small caps want a touch of letter-spacing (Bringhurst §3.2.2).
      return [this.seg(text, trial, size, ls + 0.05 * size, color, dy, manual)];
    }
    // Synthetic small caps: lowercase → capitals at 72% with added tracking.
    const out: Seg[] = [];
    const font = this.font(st, extra);
    let buf = '';
    let start = 0, u = 0;
    let lower: boolean | null = null;
    const push = () => {
      if (!buf) return;
      const sz = lower ? size * 0.72 : size;
      const t = lower ? buf.toUpperCase() : buf;
      out.push(this.seg(t, font, sz, ls + 0.05 * sz, color, dy, t.length === buf.length ? manual?.slice(start, start + buf.length) : undefined));
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
}

const sumW = (segs: Seg[]) => segs.reduce((s, g) => s + g.width, 0);

function buildItems(p: Paragraph, style: TextStyle, ps: ParaStyle, scWords: number, ragged: boolean): Item[] {
  const b = new ItemBuilder(style, ps);
  const items: Item[] = [];
  const sp = b.space();
  const justify = !ragged;
  // Justification range for word spaces, % of the desired space (Bringhurst: keep it narrow).
  const stretch = Math.max(0.05, (style.wordSpaceMax ?? 150) / 100 - 1);
  const shrink = Math.max(0, Math.min(0.9, 1 - (style.wordSpaceMin ?? 67) / 100));
  if (ps.indent > 0) items.push({ t: 'box', w: ps.indent, segs: [], word: -1 });
  p.words.forEach((word, wi) => {
    if (wi > 0) {
      if (style.avoidRunts && wi === p.words.length - 1 && p.words.length > 3) items.push({ t: 'pen', w: 0, p: INF, f: false });
      if (justify) items.push({ t: 'glue', w: sp, st: sp * stretch, sh: sp * shrink });
      else {
        items.push({ t: 'glue', w: 0, st: sp * 3, sh: 0 });
        items.push({ t: 'pen', w: 0, p: 0, f: false });
        items.push({ t: 'glue', w: sp, st: -sp * 3, sh: 0 });
      }
    }
    const sc = wi < scWords;
    const text = word.text;
    // Break opportunities: hyphenation points + after explicit hyphens/dashes.
    const breaks: { at: number; hyph: boolean }[] = [];
    for (let i = 1; i < text.length - 1; i++) if (/[-–—/]/.test(text[i - 1]) && /\p{L}/u.test(text[i])) breaks.push({ at: i, hyph: false });
    if (style.hyphenate && p.kind === 'body') {
      // Hyphenate only the alphabetic core of the word.
      const m = text.match(/^([^\p{L}]*)(\p{L}[\p{L}'’]*\p{L})([^\p{L}]*)$/u);
      if (m && m[2].length >= (style.hyphenMinWord ?? 5) && !/[A-Z]{2}/.test(m[2]) && (style.hyphenateCaps !== false || !/^\p{Lu}/u.test(m[2]))) {
        for (const at of hyphenPoints(m[2].toLowerCase(), style.language, style.hyphenBefore ?? 2, style.hyphenAfter ?? 3)) breaks.push({ at: m[1].length + at, hyph: true });
      }
    }
    breaks.sort((x, y) => x.at - y.at);
    let prev = 0;
    for (const br of breaks) {
      const segs = b.wordSegs(word, prev, br.at, sc);
      items.push({ t: 'box', w: sumW(segs), segs, word: wi });
      if (br.hyph) {
        const h = b.hyphen(word, br.at);
        items.push({ t: 'pen', w: h.width, p: ragged ? 200 : 50, f: true, hyphen: h });
      } else items.push({ t: 'pen', w: 0, p: 50, f: true, hyphen: null });
      prev = br.at;
    }
    const segs = b.wordSegs(word, prev, text.length, sc);
    items.push({ t: 'box', w: sumW(segs), segs, word: wi });
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

function knuthPlass(items: Item[], widthAt: (line: number) => number, tolerance: number, hyphenLimit = 0): number[] | null {
  let active: KPNode[] = [{ pos: -1, line: 0, fit: 1, w: 0, st: 0, sh: 0, dem: 0, hc: 0, prev: null }];
  let W = 0, ST = 0, SH = 0;
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
    if (it.t === 'box') { W += it.w; continue; }
    const legal = it.t === 'glue' ? i > 0 && items[i - 1].t === 'box' : it.p < INF;
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
        if (r >= -1 && r <= tolerance && !(hyphenLimit > 0 && hc > hyphenLimit)) {
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

/** First-fit fallback when no feasible total-fit solution exists (very narrow columns). */
function greedy(items: Item[], widthAt: (line: number) => number): number[] {
  const out: number[] = [];
  let w = 0, line = 0, lastBreak = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t === 'box') {
      if (w + it.w > widthAt(line) && lastBreak >= 0 && out[out.length - 1] !== lastBreak) {
        out.push(lastBreak);
        line++;
        w = 0;
        // Re-accumulate from the break.
        for (let j = lastBreak + 1; j <= i; j++) { const x = items[j]; if (x.t === 'box') w += x.w; else if (x.t === 'glue' && w > 0) w += x.w; }
        continue;
      }
      w += it.w;
    } else if (it.t === 'glue') {
      if (i > 0 && items[i - 1].t === 'box') lastBreak = i;
      if (w > 0) w += it.w;
    } else if (it.p < INF) {
      if (it.p === -INF) { out.push(i); break; }
      lastBreak = i;
    }
  }
  if (out[out.length - 1] !== items.length - 1) out.push(items.length - 1);
  return out;
}

function breakLines(items: Item[], widthAt: (line: number) => number, hyphenLimit = 0): number[] {
  return knuthPlass(items, widthAt, 2, hyphenLimit) ?? knuthPlass(items, widthAt, 8, hyphenLimit) ?? knuthPlass(items, widthAt, 8) ?? greedy(items, widthAt);
}

/* -------------------------------------------------------------------------- */
/* Line assembly                                                               */
/* -------------------------------------------------------------------------- */

interface Line {
  start: number;      // first item index (inclusive)
  end: number;        // break item index (exclusive content)
  hyphen: Seg | null;
  last: boolean;
}

function linesFromBreaks(items: Item[], breaks: number[], from: number): Line[] {
  const lines: Line[] = [];
  let start = from;
  for (const br of breaks) {
    while (start < br && items[start].t !== 'box') start++;
    const it = items[br];
    lines.push({ start, end: br, hyphen: it.t === 'pen' && it.hyphen ? it.hyphen : null, last: it.t === 'pen' && it.p === -INF });
    start = br + 1;
  }
  return lines;
}

const L_PROTRUDE: Record<string, number> = { '“': 1, '‘': 1, '"': 1, "'": 1, '«': 0.7, '‹': 0.7, '(': 0.3, '[': 0.3, '¿': 0.5, '¡': 0.5, A: 0.05, T: 0.05, V: 0.05, W: 0.05, Y: 0.05, J: 0.05, v: 0.05, w: 0.05, y: 0.05 };
const R_PROTRUDE: Record<string, number> = { '.': 0.7, ',': 0.7, '-': 0.7, '‐': 0.7, '–': 0.3, '—': 0.2, '’': 1, '”': 1, '"': 1, "'": 1, ':': 0.5, ';': 0.5, '!': 0.2, '?': 0.2, ')': 0.3, ']': 0.3, '»': 0.7, '›': 0.7, '…': 0.3, A: 0.05, T: 0.05, V: 0.05, W: 0.05, Y: 0.05, k: 0.04, r: 0.04, v: 0.05, w: 0.05, y: 0.05 };

function protrusion(seg: Seg | undefined, side: 'l' | 'r'): number {
  if (!seg || !seg.text) return 0;
  const chars = [...seg.text];
  const ch = side === 'l' ? chars[0] : chars[chars.length - 1];
  const f = (side === 'l' ? L_PROTRUDE : R_PROTRUDE)[ch];
  if (!f) return 0;
  return f * measure(ch, seg.font, seg.size);
}

interface Placed { runs: TextRun[]; width: number; ratio: number; chars: number; justified: boolean }

function sameFont(a: FontRef, b: FontRef): boolean {
  return a === b || (a.face === b.face && a.css === b.css && a.weight === b.weight && a.italic === b.italic &&
    JSON.stringify(a.axes) === JSON.stringify(b.axes) && JSON.stringify(a.features) === JSON.stringify(b.features));
}

function placeLine(items: Item[], line: Line, lineW: number, alignIn: TextStyle['align'], optical: boolean, rtl: boolean, baseline: number, xOffset: number, mergeSpaces: boolean): Placed {
  // Right-to-left lines are composed left-to-right with mirrored alignment, then mirrored.
  const align = rtl ? (alignIn === 'left' ? 'right' : alignIn === 'right' ? 'left' : alignIn) : alignIn;
  let natural = 0, st = 0, sh = 0;
  for (let i = line.start; i < line.end; i++) {
    const it = items[i];
    if (it.t === 'box') natural += it.w;
    else if (it.t === 'glue') { natural += it.w; st += it.st; sh += it.sh; }
  }
  if (line.hyphen) natural += line.hyphen.width;

  // Optical margin alignment: let punctuation and some round/diagonal letters hang.
  let firstSeg: Seg | undefined, lastSeg: Seg | undefined;
  for (let i = line.start; i < line.end && !firstSeg; i++) { const it = items[i]; if (it.t === 'box' && it.segs.length) firstSeg = it.segs[0]; }
  if (line.hyphen) lastSeg = line.hyphen;
  for (let i = line.end - 1; i >= line.start && !lastSeg; i--) { const it = items[i]; if (it.t === 'box' && it.segs.length) lastSeg = it.segs[it.segs.length - 1]; }
  const lp = optical && !rtl ? protrusion(firstSeg, 'l') : 0;
  const rp = optical && !rtl ? protrusion(lastSeg, 'r') : 0;

  const justify = align === 'justify-all' || (align === 'justify' && !line.last);
  const target = lineW + lp + rp;
  let r = 0;
  if (justify) {
    if (natural < target && st > 0 && st < INF / 2) r = (target - natural) / st;
    else if (natural > target && sh > 0) r = Math.max(-1, (target - natural) / sh);
  } else if (natural > target && sh > 0) {
    r = Math.max(-1, (target - natural) / sh);
  }

  let x = 0;
  const runs: TextRun[] = [];
  for (let i = line.start; i < line.end; i++) {
    const it = items[i];
    if (it.t === 'box') {
      for (const s of it.segs) {
        runs.push({ x, y: baseline - (s.dy ?? 0), text: s.text, font: s.font, size: s.size, color: s.color, letterSpacing: s.ls, width: s.width, kern: s.kern });
        x += s.width;
      }
      if (it.segs.length === 0) x += it.w;
    } else if (it.t === 'glue') {
      x += it.w + (r > 0 ? r * it.st : r * it.sh);
    }
  }
  if (line.hyphen) {
    const h = line.hyphen;
    runs.push({ x, y: baseline - (h.dy ?? 0), text: h.text, font: h.font, size: h.size, color: h.color, letterSpacing: h.ls, width: h.width });
    x += h.width;
  }
  const width = x;
  let x0: number;
  if (justify) x0 = -lp;
  else if (align === 'right') x0 = lineW - width + rp;
  else if (align === 'center') x0 = (lineW - width) / 2 + (rp - lp) / 2;
  else x0 = -lp;
  for (const run of runs) {
    run.x = rtl ? xOffset + lineW - (run.x + x0 + run.width) : xOffset + run.x + x0;
    if (rtl) run.dir = 'rtl';
  }
  const chars = runs.reduce((n, rr) => n + [...rr.text].length, 0) + Math.max(0, runs.length - 1);
  if (rtl || justify) return { runs, width, ratio: justify ? r : 0, chars, justified: justify };
  // Ragged lines: merge words into one run per font so the SVG stays light. The glue equals
  // the font's own space advance, which is exactly what the browser will set.
  const merged: TextRun[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (prev && sameFont(prev.font, run.font) && prev.size === run.size && prev.color === run.color && prev.letterSpacing === run.letterSpacing && prev.y === run.y) {
      const gap = run.x - (prev.x + prev.width);
      // Joined runs keep their kerning, with a zero entry for the joining space.
      const joinKern = (sep: string) => {
        if (!prev.kern && !run.kern) return;
        prev.kern = [...(prev.kern ?? new Array<number>(prev.text.length).fill(0)), ...new Array<number>(sep.length).fill(0), ...(run.kern ?? new Array<number>(run.text.length).fill(0))];
      };
      if (Math.abs(gap) < 0.01) { joinKern(''); prev.text += run.text; prev.width += run.width; continue; }
      if (mergeSpaces) {
        const sp = measure(' ', prev.font, prev.size) + (prev.letterSpacing ?? 0);
        if (Math.abs(gap - sp) < 0.02) { joinKern(' '); prev.text += ' ' + run.text; prev.width += gap + run.width; continue; }
      }
    }
    merged.push({ ...run, kern: run.kern ? [...run.kern] : undefined });
  }
  return { runs: merged, width, ratio: r, chars, justified: false };
}

/* -------------------------------------------------------------------------- */
/* Prepared stories (cached)                                                   */
/* -------------------------------------------------------------------------- */

interface PreparedPara { para: Paragraph; ps: ParaStyle; items: Item[]; ragged: boolean }

interface Prepared { key: string; paras: PreparedPara[]; dropCap: DropCapInfo | null }

interface DropCapInfo {
  text: string;
  font: FontRef;
  size: number;
  width: number;
  capBody: number;
  lines: number;
  boxW: number;
  pad: number;
}

const storyCache = new Map<string, Prepared>();

function styleKey(s: TextStyle) {
  return JSON.stringify(s);
}

function prepare(text: string, style: TextStyle, firstWidth: number, styles: StoryStyles | null): Prepared {
  const key = `${useFontStore.getState().version}|${styleKey(style)}|${Math.round(firstWidth)}|${styles ? JSON.stringify(styles) : ''}|${text}`;
  const hit = storyCache.get(key);
  if (hit) return hit;
  const paras = parseStory(text, style, styles);

  // Drop cap: take the first letter (plus an opening quote) of the first body paragraph.
  let dropCap: DropCapInfo | null = null;
  const dc = style.dropCap;
  if (dc.enabled && paras.length && paras[0].kind === 'body' && paras[0].words.length) {
    const w0 = paras[0].words[0];
    const m = w0.text.match(/^([“‘"'«]?)(\p{L}|\p{N})/u);
    if (m) {
      const letter = m[0];
      const restText = w0.text.slice(letter.length);
      // Remove the initial from the first word.
      let toRemove = letter.length;
      const pieces: Piece[] = [];
      for (const p of w0.pieces) {
        if (toRemove >= p.text.length) { toRemove -= p.text.length; continue; }
        pieces.push({ text: p.text.slice(toRemove), st: p.st });
        toRemove = 0;
      }
      paras[0] = { ...paras[0], words: restText ? [{ pieces, text: restText }, ...paras[0].words.slice(1)] : paras[0].words.slice(1) };
      const bodyFont = resolveFont({ family: style.fontFamily, weight: style.weight, italic: style.italic, axes: style.axes, features: style.features, size: style.fontSize });
      const capBody = fontMetrics(bodyFont).capHeight * style.fontSize;
      const dcFont0 = resolveFont({ family: dc.fontFamily ?? style.fontFamily, weight: dc.weight, italic: false, axes: {}, features: { lnum: true }, size: 72 });
      const capRatio = fontMetrics(dcFont0).capHeight || 0.68;
      const lines = Math.max(2, Math.round(dc.lines));
      const size = ((lines - 1) * style.leading + capBody) / capRatio;
      const font = resolveFont({ family: dc.fontFamily ?? style.fontFamily, weight: dc.weight, italic: false, axes: {}, features: { lnum: true }, size });
      const width = measure(letter, font, size);
      const pad = dc.frame === 'none' ? 0 : style.leading * 0.35;
      dropCap = { text: letter, font, size, width, capBody, lines, boxW: width + pad * 2, pad };
    }
  }

  const prepared: PreparedPara[] = paras.map((para, i) => {
    const pst = para.style;
    const ps = paraStyle(para, pst);
    if (dropCap && i === 0) ps.indent = 0;
    const ragged = ps.align === 'left' || ps.align === 'right' || ps.align === 'center';
    let items = buildItems(para, pst, ps, 0, ragged);
    if (i === 0 && style.firstLineSmallCaps && para.kind === 'body') {
      // Iterate: set the words of line one in small caps until the line is stable.
      let scCount = 0;
      const fw = firstWidth - ps.left - ps.right;
      for (let pass = 0; pass < 3; pass++) {
        const widthAt = (ln: number) => (ln < (dropCap?.lines ?? 0) ? fw - (dropCap!.boxW + style.dropCap.gap) : fw);
        const breaks = breakLines(items, widthAt, pst.hyphenLimit ?? 0);
        const first = linesFromBreaks(items, breaks, 0)[0];
        let count = 0;
        for (let k = first.start; k < first.end; k++) { const it = items[k]; if (it.t === 'box' && it.word >= 0) count = it.word + 1; }
        if (first.hyphen) count = Math.max(0, count - 1);
        if (count === scCount) break;
        scCount = count;
        items = buildItems(para, pst, ps, scCount, ragged);
      }
    }
    return { para, ps, items, ragged };
  });

  const result: Prepared = { key, paras: prepared, dropCap };
  storyCache.set(key, result);
  if (storyCache.size > 120) storyCache.delete(storyCache.keys().next().value!);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Frame layout                                                                */
/* -------------------------------------------------------------------------- */

interface Cursor { para: number; item: number }

const snapUp = (y: number, g: { origin: number; increment: number } | null | undefined) =>
  g ? g.origin + Math.ceil((y - g.origin) / g.increment - 1e-6) * g.increment : y;
const gridRound = (v: number, g: { origin: number; increment: number } | null | undefined) =>
  g ? Math.ceil(v / g.increment - 0.02) * g.increment : v;
const gridLeading = (lead: number, g: { origin: number; increment: number } | null | undefined) =>
  g ? Math.max(g.increment, gridRound(lead, g)) : lead;

function layoutFrame(prep: Prepared, style: TextStyle, frame: FrameSpec, cursor: Cursor, isFirstFrame: boolean): { layout: FrameLayout; cursor: Cursor | null } {
  const prims: Prim[] = [];
  const runs: TextRun[] = [];
  const baselines: number[] = [];
  const lineBoxes: FrameLayout['lines'] = [];
  const cols = Math.max(1, Math.round(frame.columns));
  const colW = Math.max(1, (frame.w - frame.inset * 2 - frame.columnGap * (cols - 1)) / cols);
  const top = frame.inset;
  const bottom = frame.h - frame.inset;
  const grid = style.baselineGrid ? frame.grid : null;
  const rtl = style.direction === 'rtl';
  const mergeSpaces = style.wordSpacing === 0;
  const body = fontMetrics(resolveFont({ family: style.fontFamily, weight: style.weight, italic: style.italic, size: style.fontSize }));

  const colXAt = (c: number) => frame.inset + (rtl ? cols - 1 - c : c) * (colW + frame.columnGap);
  // First baseline: cap height below the frame top ("Cap Height" offset), snapped to the grid.
  const firstBaseline = (ps: ParaStyle) => snapUp(top + body.capHeight * ps.size, grid);

  let col = 0;
  let colX = colXAt(0);
  let y: number | null = null; // baseline of the previous line in this column
  let lineCount = 0;
  let cur: Cursor | null = { ...cursor };
  const columns: { firstRun: number; lastBaseline: number }[] = [];
  let colFirstRun = 0;
  let hasDropCap = false;

  const nextColumn = () => {
    columns.push({ firstRun: colFirstRun, lastBaseline: y ?? top });
    col++;
    colFirstRun = runs.length;
    if (col >= cols) return false;
    colX = colXAt(col);
    y = null;
    return true;
  };

  outer: while (cur && cur.para < prep.paras.length) {
    const pp: PreparedPara = prep.paras[cur.para];
    const ps = pp.ps;
    const lead = gridLeading(ps.leading, grid);
    const startsPara = cur.item === 0;
    const dc = isFirstFrame && cur.para === 0 && startsPara ? prep.dropCap : null;
    const indentLines = dc ? dc.lines : 0;
    const indentW = dc ? dc.boxW + style.dropCap.gap : 0;

    let items = pp.items;
    if (!startsPara) {
      // Continuation from a previous frame: drop leading discardables (and the indent).
      let k = cur.item;
      while (k < pp.items.length && pp.items[k].t !== 'box') k++;
      items = pp.items.slice(k);
    }
    const offsetBase = pp.items.length - items.length;
    // Left / right indents, and a hanging (negative) first-line indent on the paragraph's first line.
    const hang = startsPara ? Math.min(0, ps.indent) : 0;
    const widthAt = (ln: number) => (ln < indentLines ? colW - indentW : colW) - ps.left - ps.right - (ln === 0 ? hang : 0);
    const lines = linesFromBreaks(items, breakLines(items, widthAt, pp.para.style.hyphenLimit ?? 0), 0);

    if (y != null && startsPara) y += gridRound(ps.spaceBefore, grid);

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let baseline: number = y == null ? firstBaseline(ps) : y + lead;
      const descent = ps.size * 0.22;
      if (y != null && baseline + descent > bottom + 0.5) {
        if (!nextColumn()) {
          cur = { para: cur.para, item: offsetBase + line.start };
          break outer;
        }
        baseline = firstBaseline(ps);
      } else if (y == null && baseline > bottom + 0.5 && runs.length === 0 && cols === 1) {
        // Frame too short for even one line: hand everything to the next frame.
        cur = { para: cur.para, item: offsetBase + line.start };
        break outer;
      }
      const indent = li < indentLines ? indentW : 0;
      const h0 = li === 0 ? hang : 0;
      const placed = placeLine(items, line, colW - indent - ps.left - ps.right - h0, ps.align, style.opticalMargin, rtl, baseline, colX + (rtl ? ps.right : indent + ps.left + h0), mergeSpaces);
      runs.push(...placed.runs);
      baselines.push(baseline);
      lineBoxes.push({ x: colX, y: baseline, w: colW, ratio: placed.ratio, chars: placed.chars, last: line.last, justified: placed.justified, hyphenated: !!line.hyphen });
      lineCount++;
      y = baseline;

      if (dc && li === 0) {
        // The initial's cap height spans from the cap line of line 1 to the baseline of line N.
        hasDropCap = true;
        const dcBaseline = baseline + (dc.lines - 1) * lead;
        const boxTop = baseline - dc.capBody - dc.pad;
        const boxH = (dc.lines - 1) * lead + dc.capBody + dc.pad * 2;
        const bx = rtl ? colX + colW - dc.boxW : colX;
        if (style.dropCap.frame !== 'none') {
          prims.push(...illuminatedFrame(style.dropCap.frame, { x: bx, y: boxTop, w: dc.boxW, h: boxH },
            { frame: style.dropCap.frameColor, ground: style.dropCap.frameColor, gold: '#c9a227' }, dc.text.charCodeAt(0)));
        }
        runs.push({ x: bx + dc.pad, y: dcBaseline, text: dc.text, font: dc.font, size: dc.size, color: style.dropCap.color, width: dc.width });
      }
    }
    if (y != null) y += gridRound(ps.spaceAfter, grid);
    cur = { para: cur.para + 1, item: 0 };
  }

  if (cur && cur.para >= prep.paras.length) cur = null;
  columns.push({ firstRun: colFirstRun, lastBaseline: y ?? top });

  // Vertical alignment — only when everything fits and no initial is anchored to the top.
  if (!cur && frame.verticalAlign !== 'top' && runs.length && !hasDropCap) {
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const end = i + 1 < columns.length ? columns[i + 1].firstRun : runs.length;
      const firstY = runs[c.firstRun]?.y;
      if (firstY == null) continue;
      const usedTop = firstY - body.capHeight * style.fontSize;
      const usedBottom = c.lastBaseline + style.fontSize * 0.22;
      const slack = bottom - usedBottom - (usedTop - top);
      if (slack <= 0) continue;
      const shift = frame.verticalAlign === 'middle' ? slack / 2 : slack;
      for (let r = c.firstRun; r < end; r++) runs[r].y += shift;
    }
  }

  if (runs.length) prims.push({ t: 'text', runs });
  return { layout: { prims, lineCount, overflow: !!cur, baselines, lines: lineBoxes }, cursor: cur };
}

/* -------------------------------------------------------------------------- */
/* Vertical (tategaki)                                                         */
/* -------------------------------------------------------------------------- */

const VERTICAL_FORMS: Record<string, string> = {
  '、': '︑', '。': '︒', '，': '︐', '：': '︓', '；': '︔', '！': '︕', '？': '︖', '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄',
  '（': '︵', '）': '︶', '(': '︵', ')': '︶', '【': '︻', '】': '︼', '〔': '︹', '〕': '︺', '〈': '︿', '〉': '﹀', '《': '︽', '》': '︾',
  '…': '︙', '‥': '︰', '—': '︱', '–': '︲', '［': '﹇', '］': '﹈', '｛': '︷', '｝': '︸',
};
const ROTATE_IN_VERTICAL = new Set(['ー', '〜', '～', '-', '‐', '=', '＝', '→', '←']);
const NO_LINE_START = new Set([...'、。，．・：；？！ー」』）］｝〕〉》ゝゞ々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ']);
const NO_LINE_END = new Set([...'「『（［｛〔〈《']);
const HANGING = new Set(['、', '。', '，', '．']);

interface VCell { kind: 'char' | 'tcy' | 'sideways'; text: string; adv: number }

function verticalCells(text: string, font: FontRef, size: number, tcy: boolean): VCell[] {
  const cells: VCell[] = [];
  const re = /([0-9]{1,4})|([A-Za-z0-9.,'’\-]+)|(\s+)|(.)/gsu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] && tcy && m[1].length <= 3) cells.push({ kind: 'tcy', text: m[1], adv: size });
    else if (m[1] || m[2]) {
      const t = m[1] || m[2];
      cells.push({ kind: 'sideways', text: t, adv: measure(t, font, size) });
    } else if (m[3]) {
      if (m[3].includes('\n')) cells.push({ kind: 'char', text: '\n', adv: 0 });
      else cells.push({ kind: 'char', text: '　', adv: size * 0.5 });
    } else cells.push({ kind: 'char', text: m[4], adv: size });
  }
  return cells;
}

function layoutVertical(text: string, style: TextStyle, frame: FrameSpec): FrameLayout {
  const size = style.fontSize;
  const font = resolveFont({ family: style.fontFamily, weight: style.weight, italic: false, axes: style.axes, features: style.features, size });
  const m = fontMetrics(font);
  const top = frame.inset, bottom = frame.h - frame.inset;
  const pitch = Math.max(style.leading, size);
  const track = (style.tracking / 1000) * size;
  const runs: TextRun[] = [];
  const lines: FrameLayout['lines'] = [];
  let colCenter = frame.w - frame.inset - size / 2;
  let yy = top;
  let count = 1;
  let overflow = false;
  const paras = text.replace(/\r\n?/g, '\n').split('\n').filter((p) => p.trim());
  const newColumn = () => {
    colCenter -= pitch;
    yy = top;
    count++;
    lines.push({ x: colCenter - size / 2, y: top, w: size });
    return colCenter - size / 2 >= frame.inset - 0.5;
  };
  lines.push({ x: colCenter - size / 2, y: top, w: size });
  outer: for (let pi = 0; pi < paras.length; pi++) {
    if (pi > 0 && !newColumn()) { overflow = true; break; }
    yy += size; // one-character paragraph indent (字下げ)
    const cells = verticalCells(paras[pi].trim(), font, size, style.tateChuYoko);
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      const fitsHere = yy + c.adv <= bottom + 0.01;
      const hang = !fitsHere && HANGING.has(c.text) && yy <= bottom + 0.01; // burasage
      if (!fitsHere && !hang) {
        if (!newColumn()) { overflow = true; break outer; }
      } else if (fitsHere && ci + 1 < cells.length && NO_LINE_END.has(c.text) && yy + c.adv + cells[ci + 1].adv > bottom + 0.01) {
        if (!newColumn()) { overflow = true; break outer; }
      }
      if (yy === top && NO_LINE_START.has(c.text) && runs.length && !hang) {
        // Oikomi: tuck a forbidden line-start into the previous column's end.
        yy = bottom - c.adv * 0.4;
        colCenter += pitch;
      }
      const cellTop = yy;
      if (c.kind === 'char') {
        const ch = VERTICAL_FORMS[c.text] ?? c.text;
        const w = measure(ch, font, size);
        if (ROTATE_IN_VERTICAL.has(c.text)) {
          runs.push({ x: colCenter - (m.ascender + m.descender) / 2 * size, y: cellTop, text: ch, font, size, color: style.color, rotate: 90, width: w });
        } else {
          runs.push({ x: colCenter - w / 2, y: cellTop + size * 0.88, text: ch, font, size, color: style.color, width: w });
        }
      } else if (c.kind === 'tcy') {
        const w = measure(c.text, font, size);
        const scaleX = w > size * 0.95 ? (size * 0.95) / w : 1;
        runs.push({ x: colCenter - (w * scaleX) / 2, y: cellTop + size * 0.88, text: c.text, font, size, color: style.color, scaleX, width: w });
      } else {
        runs.push({ x: colCenter - (m.ascender + m.descender) / 2 * size, y: cellTop, text: c.text, font, size, color: style.color, rotate: 90, width: c.adv });
      }
      yy += c.adv + track;
      if (hang) { if (!newColumn()) { overflow = ci < cells.length - 1; break outer; } }
    }
  }
  return { prims: runs.length ? [{ t: 'text', runs }] : [], lineCount: count, overflow, baselines: [], lines };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

export function frameSpecOf(el: TextElement, grid?: FrameSpec['grid']): FrameSpec {
  return { w: el.w, h: el.h, columns: el.columns, columnGap: el.columnGap, inset: el.inset, verticalAlign: el.verticalAlign, grid };
}

/** Lay out a story through one or more threaded frames. */
export function layoutStory(text: string, style: TextStyle, frames: FrameSpec[], tokens: TokenContext, styles: StoryStyles | null = null): FrameLayout[] {
  const expanded = expandTokens(text, tokens);
  if (style.writingMode === 'vertical') {
    // Vertical stories are set per frame (threading of vertical text is not supported).
    return frames.map((f, i) => (i === 0 ? layoutVertical(expanded, style, f) : { prims: [], lineCount: 0, overflow: false, baselines: [], lines: [] }));
  }
  const f0 = frames[0];
  const firstColW = f0 ? (f0.w - f0.inset * 2 - f0.columnGap * (Math.max(1, f0.columns) - 1)) / Math.max(1, f0.columns) : 100;
  const prep = prepare(expanded, style, firstColW, styles && (styles.para.length || styles.char.length) ? styles : null);
  const out: FrameLayout[] = [];
  let cursor: Cursor | null = { para: 0, item: 0 };
  frames.forEach((frame, i) => {
    if (!cursor) {
      out.push({ prims: [], lineCount: 0, overflow: false, baselines: [], lines: [] });
      return;
    }
    const { layout, cursor: next } = layoutFrame(prep, style, frame, cursor, i === 0);
    out.push(layout);
    cursor = next;
  });
  return out;
}
