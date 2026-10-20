/**
 * The text engine: frames, columns and threads.
 *
 *  • Story markup → paragraphs (`text/story.ts`), measured items and line breaking (`text/compose.ts`):
 *    Knuth–Plass with hyphenation controls, justification by word space, letter spacing and glyph
 *    scaling, shaped rags (Swiss, balanced, wedge, pattern), tabs with leaders, lists, footnotes,
 *    paragraph and character styles, local formatting, nested and GREP styles.
 *  • Frames: columns with text wrap around other items (both sides, largest side, jump), first-
 *    baseline options, baseline-grid locking (all lines or first lines), keeps (with next,
 *    together, widows, orphans, start in next column / frame), footnotes at the foot of the
 *    column, balanced columns, vertical justification, column rules, paragraph rules and shading,
 *    underline / strike / highlight, drop caps with Cleves illumination, optical margins.
 *  • Threads (overflow into linked frames), RTL lines and Japanese vertical setting (tategaki).
 *
 * Output is display-list primitives positioned in frame-local pt.
 */
import type { TextStyle, TextElement } from '../model/types';
import type { Prim, TextRun, GroupPrim, PathPrim, FontRef } from '../render/primitives';
import { resolveFont, measure, fontMetrics, useFontStore } from './fonts';
import { illuminatedFrame } from './generators/cleves';
import { toRoman } from '../model/units';
import { parseStory, PLAIN, type Footnote, type Paragraph, type Piece, type StoryStyles } from './text/story';
import {
  ItemBuilder, buildItems, paraStyle, breakParagraph, tabCompose, linesFromBreaks, placeLine, hyphenDictionary,
  type Item, type Line, type ParaStyle, type TabResolution,
} from './text/compose';

export { applyParagraphStyle } from './text/props';
export type { StoryStyles } from './text/story';

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
  /** The current chapter (running heads on masters). */
  chapter?: string;
}

/** An item the text wraps around, in frame-local pt (already grown by its wrap offset). */
export interface WrapShape {
  x: number; y: number; w: number; h: number;
  shape: 'rect' | 'ellipse';
  side: 'both' | 'largest' | 'left' | 'right';
  jump?: boolean;
}

export interface FrameSpec {
  w: number;
  h: number;
  columns: number;
  columnGap: number;
  inset: number;
  insets?: { top: number; right: number; bottom: number; left: number } | null;
  verticalAlign: 'top' | 'middle' | 'bottom' | 'justify';
  /** Frame-local y of any baseline-grid line, and the grid increment. */
  grid?: { origin: number; increment: number } | null;
  firstBaseline?: TextElement['firstBaseline'];
  firstBaselineMin?: number;
  balance?: boolean;
  columnRule?: TextElement['columnRule'];
  wraps?: WrapShape[];
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
  /** Depth the text actually uses (for frames that fit their height to the text). */
  usedHeight?: number;
  /** Headings (# / ##) whose first line is set in this frame, for generated contents. */
  heads?: { level: 1 | 2; text: string }[];
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

export function expandTokens(text: string, t: TokenContext): string {
  return text.replace(/\{(page|pages|title|subtitle|author|publisher|year|chapter)(?::(roman|ROMAN))?\}/g, (_, k: string, fmt?: string) => {
    switch (k) {
      case 'page': return fmt === 'roman' ? toRoman(t.page) : fmt === 'ROMAN' ? toRoman(t.page, true) : String(t.page);
      case 'pages': return String(t.pages);
      case 'title': return t.title;
      case 'subtitle': return t.subtitle;
      case 'author': return t.author;
      case 'publisher': return t.publisher;
      case 'year': return String(new Date().getFullYear());
      case 'chapter': return t.chapter ?? '';
      default: return '';
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Prepared stories (cached)                                                   */
/* -------------------------------------------------------------------------- */

interface PreparedPara { para: Paragraph; ps: ParaStyle; items: Item[]; ragged: boolean }

interface Prepared { key: string; paras: PreparedPara[]; dropCap: DropCapInfo | null; styles: StoryStyles | null }

interface DropCapInfo {
  text: string;
  font: ReturnType<typeof resolveFont>;
  size: number;
  width: number;
  capBody: number;
  lines: number;
  boxW: number;
  pad: number;
}

const storyCache = new Map<string, Prepared>();

function prepare(text: string, style: TextStyle, firstWidth: number, styles: StoryStyles | null): Prepared {
  const key = `${useFontStore.getState().version}|${JSON.stringify(style)}|${Math.round(firstWidth)}|${styles ? JSON.stringify(styles) : ''}|${text}`;
  const hit = storyCache.get(key);
  if (hit) return hit;
  const paras = parseStory(text, style, styles);
  const dict = hyphenDictionary(styles?.hyphenation);

  // Drop cap: take the first letters (plus an opening quote) of the first body paragraph.
  let dropCap: DropCapInfo | null = null;
  const dc = style.dropCap;
  if (dc.enabled && paras.length && paras[0].kind === 'body' && paras[0].words.length) {
    const w0 = paras[0].words[0];
    const n = Math.max(1, Math.min(6, Math.round(dc.chars ?? 1)));
    const m = w0.text.match(new RegExp(`^([“‘"'«]?)((?:\\p{L}|\\p{N}){1,${n}})`, 'u'));
    if (m) {
      const letter = m[0];
      const restText = w0.text.slice(letter.length);
      // Remove the initial from the first word.
      let toRemove = letter.length;
      const pieces: Piece[] = [];
      for (const p of w0.pieces) {
        if (toRemove >= p.text.length) { toRemove -= p.text.length; continue; }
        pieces.push({ text: p.text.slice(toRemove), st: p.st, kern: p.kern?.slice(toRemove) });
        toRemove = 0;
      }
      const shy = w0.shy?.map((v) => v - letter.length).filter((v) => v > 0);
      paras[0] = { ...paras[0], words: restText ? [{ ...w0, pieces, text: restText, shy: shy?.length ? shy : undefined }, ...paras[0].words.slice(1)] : paras[0].words.slice(1) };
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
    let items = buildItems(para, pst, ps, 0, ragged, dict);
    if (i === 0 && style.firstLineSmallCaps && para.kind === 'body') {
      // Iterate: set the words of line one in small caps until the line is stable.
      let scCount = 0;
      const fw = firstWidth - ps.left - ps.right;
      for (let pass = 0; pass < 3; pass++) {
        const widthAt = (ln: number) => (ln < (dropCap?.lines ?? 0) ? fw - (dropCap!.boxW + style.dropCap.gap) : fw);
        const breaks = breakParagraph(items, widthAt, pst, ragged);
        const first = linesFromBreaks(items, breaks, 0)[0];
        let count = 0;
        for (let k = first.start; k < first.end; k++) { const it = items[k]; if (it.t === 'box' && it.word >= 0) count = it.word + 1; }
        if (first.hyphen) count = Math.max(0, count - 1);
        if (count === scCount) break;
        scCount = count;
        items = buildItems(para, pst, ps, scCount, ragged, dict);
      }
    }
    return { para, ps, items, ragged };
  });

  const result: Prepared = { key, paras: prepared, dropCap, styles };
  storyCache.set(key, result);
  if (storyCache.size > 160) storyCache.delete(storyCache.keys().next().value!);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Frame layout                                                                */
/* -------------------------------------------------------------------------- */

interface Cursor { para: number; item: number }

/** One line position: an x-interval of a column at a baseline (`col` −1 = beyond the frame). */
interface Slot { x: number; w: number; baseline: number; col: number }

interface Flow {
  col: number;
  /** Baseline of the previous line in this column (null at a column top). */
  y: number | null;
  /** Depth reserved for footnotes at the foot of each column. */
  reserve: number[];
  notes: Footnote[][];
  used: boolean[];
}

const cloneFlow = (f: Flow): Flow => ({ col: f.col, y: f.y, reserve: [...f.reserve], notes: f.notes.map((n) => [...n]), used: [...f.used] });

const snapUp = (y: number, g: { origin: number; increment: number } | null | undefined) =>
  g ? g.origin + Math.ceil((y - g.origin) / g.increment - 1e-6) * g.increment : y;
const gridRound = (v: number, g: { origin: number; increment: number } | null | undefined) =>
  g ? Math.ceil(v / g.increment - 0.02) * g.increment : v;
const gridLeading = (lead: number, g: { origin: number; increment: number } | null | undefined) =>
  g ? Math.max(g.increment, gridRound(lead, g)) : lead;

/** The parts of a column band [y0, y1] left free by wrap items, at least `minW` wide. */
function bandIntervals(x0: number, w: number, y0: number, y1: number, wraps: WrapShape[], minW: number): { a: number; b: number }[] {
  const whole = [{ a: x0, b: x0 + w }];
  let segs = whole;
  for (const wr of wraps) {
    if (wr.y > y1 || wr.y + wr.h < y0) continue;
    let ex0: number, ex1: number;
    if (wr.shape === 'ellipse') {
      const rx = wr.w / 2, ry = wr.h / 2, cx = wr.x + rx, cy = wr.y + ry;
      const dy = y0 <= cy && cy <= y1 ? 0 : Math.min(Math.abs(y0 - cy), Math.abs(y1 - cy));
      if (dy >= ry) continue;
      const half = rx * Math.sqrt(1 - (dy / ry) ** 2);
      ex0 = cx - half; ex1 = cx + half;
    } else { ex0 = wr.x; ex1 = wr.x + wr.w; }
    if (ex1 <= x0 || ex0 >= x0 + w) continue;
    if (wr.jump) return [];
    const next: { a: number; b: number }[] = [];
    for (const s of segs) {
      if (ex1 <= s.a || ex0 >= s.b) { next.push(s); continue; }
      const left = { a: s.a, b: Math.max(s.a, ex0) }, right = { a: Math.min(s.b, ex1), b: s.b };
      const lw = left.b - left.a, rw = right.b - right.a;
      if (wr.side === 'left') next.push(left);
      else if (wr.side === 'right') next.push(right);
      else if (wr.side === 'largest') next.push(lw >= rw ? left : right);
      else { next.push(left); next.push(right); }
    }
    segs = next;
  }
  // Only slivers cut by a wrap are dropped; an untouched column is used however narrow it is.
  return segs === whole ? whole : segs.filter((s) => s.b - s.a >= minW);
}

const fnTokens: TokenContext = { page: 0, pages: 0, title: '', subtitle: '', author: '', publisher: '' };

function layoutFrame(prep: Prepared, style: TextStyle, frame: FrameSpec, cursor: Cursor, isFirstFrame: boolean, bottomOverride?: number): { layout: FrameLayout; cursor: Cursor | null } {
  const ins = frame.insets ?? { top: frame.inset, right: frame.inset, bottom: frame.inset, left: frame.inset };
  const cols = Math.max(1, Math.round(frame.columns));
  const colW = Math.max(1, (frame.w - ins.left - ins.right - frame.columnGap * (cols - 1)) / cols);
  const top = ins.top;
  // Spanning heads at the top of a multi-column frame push the columns' tops down.
  let colTop = top;
  let spanPhase = cols > 1;
  let spanning = false;
  const fullW = frame.w - ins.left - ins.right;
  const frameBottom = frame.h - ins.bottom;
  const bottom = bottomOverride ?? frameBottom;
  const grid = style.baselineGrid ? frame.grid : null;
  const gridFirst = !!grid && style.gridAlign === 'first';
  const rtl = style.direction === 'rtl';
  const mergeSpaces = style.wordSpacing === 0;
  const body = fontMetrics(resolveFont({ family: style.fontFamily, weight: style.weight, italic: style.italic, size: style.fontSize }));
  const wraps = frame.wraps ?? [];

  const colXAt = (c: number) => ins.left + (rtl ? cols - 1 - c : c) * (colW + frame.columnGap);
  // First baseline below the frame top, snapped to the grid.
  const firstBaseline = (ps: ParaStyle) => {
    let off: number;
    switch (frame.firstBaseline ?? 'cap') {
      case 'ascent': off = body.ascender * ps.size; break;
      case 'x-height': off = body.xHeight * ps.size; break;
      case 'leading': off = ps.leading; break;
      case 'fixed': off = frame.firstBaselineMin ?? ps.leading; break;
      default: off = body.capHeight * ps.size;
    }
    return snapUp(colTop + Math.max(off, frame.firstBaselineMin ?? 0), grid);
  };

  // Footnotes: set at the foot of the column that holds the reference, smaller, after a short rule.
  const fnScale = (style.footnoteScale ?? 80) / 100;
  const fnStyle: TextStyle = {
    ...style, fontSize: style.fontSize * fnScale, leading: style.leading * fnScale, firstLineIndent: 0, indentFirstParagraph: false,
    paragraphSpacing: style.leading * fnScale * 0.25, dropCap: { ...style.dropCap, enabled: false }, firstLineSmallCaps: false, baselineGrid: false,
    align: style.align === 'justify' || style.align === 'justify-all' ? 'justify' : style.align === 'right' ? 'right' : 'left',
    list: null, ruleAbove: null, ruleBelow: null, shading: null, keepWithNext: 0, keepTogether: false, rag: 'natural', tabStops: [],
  };
  const fnGap = style.leading * 0.6;
  const fnCache = new Map<number, FrameLayout>();
  const fnLayout = (fn: Footnote) => {
    let l = fnCache.get(fn.n);
    if (!l) {
      l = layoutStory(`${fn.label}{en}${fn.text}`, fnStyle, [{ w: colW, h: 100000, columns: 1, columnGap: 0, inset: 0, verticalAlign: 'top' }], fnTokens, prep.styles)[0];
      fnCache.set(fn.n, l);
    }
    return l;
  };
  const fnHeight = (fn: Footnote) => {
    const l = fnLayout(fn);
    return l.baselines.length ? l.baselines[l.baselines.length - 1] + fnStyle.leading * 0.25 + fnStyle.leading * 0.3 : 0;
  };

  const runs: TextRun[] = [];
  const baselines: number[] = [];
  const lineBoxes: FrameLayout['lines'] = [];
  const under: { g: GroupPrim; col: number; para: number }[] = [];
  const over: { g: GroupPrim; col: number; para: number }[] = [];
  const dcPrims: { g: GroupPrim; col: number; para: number }[] = [];
  const lineRecs: { col: number; para: number; from: number; to: number; base: number; bottom: number; top: number }[] = [];
  const heads: { level: 1 | 2; text: string }[] = [];
  let lineCount = 0;
  let hasDropCap = false;

  const flow: Flow = { col: 0, y: null, reserve: new Array(cols).fill(0), notes: Array.from({ length: cols }, () => []), used: new Array(cols).fill(false) };

  /** Slots for a paragraph from a flow position, generated on demand. */
  const slotGen = (start: Flow, ps: ParaStyle, startsPara: boolean, maxFirst: number | null) => {
    const lead = gridLeading(ps.leading, gridFirst ? null : grid);
    const descent = ps.size * 0.22, ascent = body.ascender * ps.size;
    const slots: Slot[] = [];
    const extra: Slot[] = [];
    let col = start.col, y = start.y, inFirst = 0;
    const bottomOf = (c: number) => bottom - (start.reserve[c] ?? 0);
    const gen = () => {
      if (extra.length) { slots.push(extra.shift()!); return; }
      for (let guard = 0; guard < 4000; guard++) {
        if (col >= cols || (spanning && col > start.col)) break;
        let baseline = y == null ? firstBaseline(ps) : y + lead;
        if (gridFirst && slots.length === 0 && startsPara && y != null) baseline = snapUp(baseline, grid);
        const forced = maxFirst != null && col === start.col && inFirst >= maxFirst;
        if (forced || (y != null && baseline + descent > bottomOf(col) + 0.5) || (y == null && baseline > bottomOf(col) + 0.5)) {
          col++;
          y = null;
          continue;
        }
        y = baseline;
        const ints = spanning ? bandIntervals(ins.left, fullW, baseline - ascent, baseline + descent, wraps, ps.size * 2.5) : bandIntervals(colXAt(col), colW, baseline - ascent, baseline + descent, wraps, ps.size * 2.5);
        if (!ints.length) continue;
        if (col === start.col) inFirst++;
        const [first, ...rest] = ints.map((iv) => ({ x: iv.a, w: iv.b - iv.a, baseline, col }));
        slots.push(first);
        extra.push(...rest);
        return;
      }
      slots.push({ x: colXAt(0), w: colW, baseline: Infinity, col: -1 });
    };
    return (i: number) => { while (slots.length <= i) gen(); return slots[i]; };
  };

  /** Natural width before `{here}` (indent to here), if the paragraph has one. */
  const hereOffset = (items: Item[]) => {
    let w = 0;
    for (const it of items) {
      if (it.t === 'here') return w;
      if (it.t === 'box' || it.t === 'glue') w += it.w;
      if (it.t === 'pen' && it.p === -10000) return null;
    }
    return null;
  };

  const plan = (pp: PreparedPara, itemStart: number, fl: Flow, maxFirst: number | null) => {
    const startsPara = itemStart === 0;
    let items = pp.items;
    let offsetBase = 0;
    if (!startsPara) {
      // Continuation from a previous column / frame: drop leading discardables (and the indent).
      let k = itemStart;
      while (k < pp.items.length && pp.items[k].t !== 'box' && pp.items[k].t !== 'tab') k++;
      items = pp.items.slice(k);
      offsetBase = k;
    }
    const ps = pp.ps;
    const dc = isFirstFrame && pp === prep.paras[0] && startsPara ? prep.dropCap : null;
    const slot = slotGen(fl, ps, startsPara, maxFirst);
    const hang = startsPara ? Math.min(0, ps.indent) : 0;
    const hereW = startsPara ? hereOffset(items) : null;
    const indentOf = (ln: number) => {
      let left = ps.left + (ln === 0 ? hang : 0);
      if (dc && ln < dc.lines) left += dc.boxW + style.dropCap.gap;
      if (hereW != null && ln > 0) left = Math.max(left, ps.left + hereW);
      return left;
    };
    const widthAt = (ln: number) => Math.max(1, slot(ln).w - indentOf(ln) - ps.right);
    const colOf = (ln: number) => { const s = slot(ln); return s.col >= 0 ? s.col : 0; };
    const lineLeft = (ln: number) => slot(ln).x - colXAt(colOf(ln)) + indentOf(ln);
    let breaks: number[];
    let tabs: Map<number, TabResolution> | undefined;
    if (pp.para.hasTabs) { const r = tabCompose(items, widthAt, lineLeft, pp.para.style); breaks = r.breaks; tabs = r.tabs; }
    else breaks = breakParagraph(items, widthAt, pp.para.style, pp.ragged);
    const lines = linesFromBreaks(items, breaks, 0);
    return { items, offsetBase, lines, slot, indentOf, widthAt, tabs, dc, startsPara };
  };
  type Plan = ReturnType<typeof plan>;

  const notesIn = (pp: PreparedPara, items: Item[], line: Line): Footnote[] => {
    if (!pp.para.footnotes.length) return [];
    const out: Footnote[] = [];
    for (let i = line.start; i < line.end; i++) {
      const it = items[i];
      if (it.t !== 'box') continue;
      for (const g of it.segs) if (g.fn) { const fn = pp.para.footnotes.find((f) => f.label === g.text); if (fn) out.push(fn); }
    }
    return out;
  };

  /** Walk the planned lines against the flow: footnote space, overflow. Nothing is committed. */
  const simulate = (pp: PreparedPara, pl: Plan, fl: Flow) => {
    const f = cloneFlow(fl);
    const placed: { li: number; slot: Slot }[] = [];
    const descent = pp.ps.size * 0.22;
    for (let li = 0; li < pl.lines.length; li++) {
      const s = pl.slot(li);
      if (s.col < 0) return { placed, flow: f, stop: li as number | null, reason: 'overflow' as const };
      if (s.col !== f.col) { f.col = s.col; f.y = null; }
      const refs = notesIn(pp, pl.items, pl.lines[li]);
      const need = refs.reduce((a, fn) => a + fnHeight(fn), 0) + (refs.length && !f.notes[s.col].length ? fnGap : 0);
      const occupied = f.used[s.col] || placed.some((p) => p.slot.col === s.col);
      if (occupied && s.baseline + descent > bottom - f.reserve[s.col] - need + 0.5) return { placed, flow: f, stop: li, reason: 'notes' as const };
      f.reserve[s.col] += need;
      f.notes[s.col].push(...refs);
      f.y = s.baseline;
      f.used[s.col] = true;
      placed.push({ li, slot: s });
    }
    return { placed, flow: f, stop: null as number | null, reason: null };
  };

  const ruleGroup = (rule: NonNullable<TextStyle['ruleAbove']>, x0: number, x1: number, y: number): GroupPrim => {
    const w = Math.max(0.1, rule.weight);
    const dash = rule.style === 'dashed' ? [w * 4, w * 3] : rule.style === 'dotted' ? [0.01, w * 2] : undefined;
    const line = (yy: number, ww: number): PathPrim => ({ t: 'path', d: `M${x0} ${yy}H${x1}`, stroke: rule.color, strokeWidth: ww, dash, cap: rule.style === 'dotted' ? 'round' : 'butt' });
    const children: Prim[] = rule.style === 'double' ? [line(y - w, w * 0.6), line(y + w, w * 0.6)] : [line(y, w)];
    return { t: 'group', matrix: [1, 0, 0, 1, 0, 0], children };
  };

  /** Commit the placed lines of a paragraph (or the part of it that fits). */
  const commit = (pp: PreparedPara, pl: Plan, placed: { li: number; slot: Slot }[], paraNo: number) => {
    const pst = pp.para.style, ps = pp.ps;
    const builder = new ItemBuilder(pst, ps);
    const parts = new Map<number, { first: number; last: number; slot: Slot; runsFrom: number; runsTo: number; minX: number; maxX: number }>();
    for (const { li, slot } of placed) {
      const line = pl.lines[li];
      const lineW = pl.widthAt(li);
      const indent = pl.indentOf(li);
      const xOff = slot.x + (rtl ? ps.right : indent);
      const from = runs.length;
      const pl0 = placeLine(pl.items, line, lineW, {
        align: ps.align, optical: style.opticalMargin, opticalAmount: (pst.opticalMarginAmount ?? 100) / 100, rtl,
        baseline: slot.baseline, xOffset: xOff, mergeSpaces, lastLineAlign: pst.lastLineAlign, singleWord: pst.singleWordJustify,
        tabs: pl.tabs, leaderOrigin: xOff - colXAt(slot.col), leader: (t) => builder.leader(t),
      });
      runs.push(...pl0.runs);
      if (pl.startsPara && li === 0 && (pp.para.kind === 'h1' || pp.para.kind === 'h2')) {
        heads.push({ level: pp.para.kind === 'h1' ? 1 : 2, text: pp.para.words.map((w) => w.text).join(' ') });
      }
      // List marker hanging in front of the paragraph's first line.
      if (pl.startsPara && li === 0 && ps.marker) {
        const st = pp.para.list?.color ? { ...PLAIN, cs: { color: pp.para.list.color } } : PLAIN;
        const segs = builder.segs(ps.marker.text, st, false);
        const mw = segs.reduce((a, g) => a + g.width, 0);
        const gap = 0.45 * ps.size;
        let mx = ps.marker.align === 'right' ? ps.marker.x + ps.marker.w - gap - mw : ps.marker.x;
        if (rtl) mx = slot.w - mx - mw;
        let x = slot.x + mx;
        for (const g of segs) { if (g.text) runs.push({ x, y: slot.baseline - (g.dy ?? 0), text: g.text, font: g.font, size: g.size, color: g.color, letterSpacing: g.ls, width: g.width }); x += g.width; }
      }
      const to = runs.length;
      baselines.push(slot.baseline);
      lineBoxes.push({ x: slot.x, y: slot.baseline, w: slot.w, ratio: pl0.ratio, chars: pl0.chars, last: line.last, justified: pl0.justified, hyphenated: !!line.hyphen });
      lineRecs.push({ col: slot.col, para: paraNo, from, to, base: slot.baseline, top: slot.baseline - body.capHeight * ps.size, bottom: slot.baseline + ps.size * 0.22 });
      lineCount++;

      // Underline, strike and highlight become rules around the runs.
      const lineRuns = runs.slice(from, to);
      const decoRuns = lineRuns.filter((r) => r.deco);
      if (decoRuns.length) {
        const u: Prim[] = [], o: Prim[] = [];
        let k = 0;
        while (k < decoRuns.length) {
          const r0 = decoRuns[k];
          let x1 = r0.x + r0.width;
          let j = k + 1;
          while (j < decoRuns.length && JSON.stringify(decoRuns[j].deco) === JSON.stringify(r0.deco) && decoRuns[j].y === r0.y && decoRuns[j].x - x1 < r0.size * 0.6) { x1 = decoRuns[j].x + decoRuns[j].width; j++; }
          const d = r0.deco!;
          const m = fontMetrics(r0.font);
          if (d.hl) u.push({ t: 'path', d: `M${r0.x - r0.size * 0.05} ${r0.y - m.ascender * r0.size}H${x1 + r0.size * 0.05}V${r0.y - m.descender * r0.size * 0.9}H${r0.x - r0.size * 0.05}Z`, fill: d.hl });
          if (d.u) u.push({ t: 'path', d: `M${r0.x} ${r0.y + d.u.o - d.u.w / 2}H${x1}V${r0.y + d.u.o + d.u.w / 2}H${r0.x}Z`, fill: d.u.c });
          if (d.s) { const sy = r0.y - (m.xHeight || 0.45) * r0.size * 0.55; o.push({ t: 'path', d: `M${r0.x} ${sy - d.s.w / 2}H${x1}V${sy + d.s.w / 2}H${r0.x}Z`, fill: d.s.c }); }
          k = j;
        }
        if (u.length) under.push({ g: { t: 'group', matrix: [1, 0, 0, 1, 0, 0], children: u }, col: slot.col, para: paraNo });
        if (o.length) over.push({ g: { t: 'group', matrix: [1, 0, 0, 1, 0, 0], children: o }, col: slot.col, para: paraNo });
      }

      // Drop cap: its cap height spans from the cap line of line 1 to the baseline of line N.
      if (pl.dc && li === 0) {
        hasDropCap = true;
        const dc = pl.dc;
        const lead = gridLeading(ps.leading, grid);
        const dcBaseline = slot.baseline + (dc.lines - 1) * lead;
        const boxTop = slot.baseline - dc.capBody - dc.pad;
        const boxH = (dc.lines - 1) * lead + dc.capBody + dc.pad * 2;
        const bx = rtl ? slot.x + slot.w - dc.boxW : slot.x + ps.left;
        const children: Prim[] = [];
        if (style.dropCap.frame !== 'none') {
          children.push(...illuminatedFrame(style.dropCap.frame, { x: bx, y: boxTop, w: dc.boxW, h: boxH },
            { frame: style.dropCap.frameColor, ground: style.dropCap.frameColor, gold: '#c9a227' }, dc.text.charCodeAt(0)));
        }
        children.push({ t: 'text', runs: [{ x: bx + dc.pad, y: dcBaseline, text: dc.text, font: dc.font, size: dc.size, color: style.dropCap.color, width: dc.width }] });
        dcPrims.push({ g: { t: 'group', matrix: [1, 0, 0, 1, 0, 0], children }, col: slot.col, para: paraNo });
      }

      const part = parts.get(slot.col);
      const ext = lineRuns.reduce((a, r) => ({ min: Math.min(a.min, r.x), max: Math.max(a.max, r.x + r.width) }), { min: Infinity, max: -Infinity });
      if (!part) parts.set(slot.col, { first: li, last: li, slot, runsFrom: from, runsTo: to, minX: ext.min, maxX: ext.max });
      else { part.last = li; part.runsTo = to; part.minX = Math.min(part.minX, ext.min); part.maxX = Math.max(part.maxX, ext.max); }
    }

    // Paragraph rules and shading, per column the paragraph occupies.
    const lastLine = pl.lines.length - 1;
    for (const [col, part] of parts) {
      const s0 = pl.slot(part.first), s1 = pl.slot(part.last);
      const x0 = part.slot.x + ps.left, x1 = part.slot.x + part.slot.w - ps.right;
      const yTop = s0.baseline - body.capHeight * ps.size, yBot = s1.baseline + ps.size * 0.22;
      if (pst.shading && pst.shading.color) {
        const pad = pst.shading.padding ?? 3;
        const r = pst.shading.radius ?? 0;
        const X0 = x0 - pad, X1 = x1 + pad, Y0 = yTop - pad, Y1 = yBot + pad;
        const d = r > 0
          ? `M${X0 + r} ${Y0}H${X1 - r}Q${X1} ${Y0} ${X1} ${Y0 + r}V${Y1 - r}Q${X1} ${Y1} ${X1 - r} ${Y1}H${X0 + r}Q${X0} ${Y1} ${X0} ${Y1 - r}V${Y0 + r}Q${X0} ${Y0} ${X0 + r} ${Y0}Z`
          : `M${X0} ${Y0}H${X1}V${Y1}H${X0}Z`;
        under.unshift({ g: { t: 'group', matrix: [1, 0, 0, 1, 0, 0], children: [{ t: 'path', d, fill: pst.shading.color, stroke: pst.shading.stroke ?? undefined, strokeWidth: pst.shading.strokeWidth }] }, col, para: paraNo });
      }
      const tx = (rule: NonNullable<TextStyle['ruleAbove']>) => rule.width === 'text' && Number.isFinite(part.minX) ? [part.minX, part.maxX] : [x0, x1];
      if (pst.ruleAbove && pst.ruleAbove.weight > 0 && pl.startsPara && part.first === 0) {
        const [a, b] = tx(pst.ruleAbove);
        under.push({ g: ruleGroup(pst.ruleAbove, a + (pst.ruleAbove.indentLeft ?? 0), b - (pst.ruleAbove.indentRight ?? 0), yTop - pst.ruleAbove.offset - pst.ruleAbove.weight / 2), col, para: paraNo });
      }
      if (pst.ruleBelow && pst.ruleBelow.weight > 0 && part.last === lastLine) {
        const [a, b] = tx(pst.ruleBelow);
        under.push({ g: ruleGroup(pst.ruleBelow, a + (pst.ruleBelow.indentLeft ?? 0), b - (pst.ruleBelow.indentRight ?? 0), s1.baseline + pst.ruleBelow.offset + pst.ruleBelow.weight / 2), col, para: paraNo });
      }
    }
  };

  const advance = (f: Flow) => { f.col++; f.y = null; return f.col < cols; };

  let cur: Cursor | null = { ...cursor };
  let paraNo = 0;
  outer: while (cur && cur.para < prep.paras.length) {
    const pp: PreparedPara = prep.paras[cur.para];
    const pst = pp.para.style, ps = pp.ps;
    const startsPara = cur.item === 0;
    if (startsPara) {
      const startOn = pp.para.breakBefore ?? (pst.startOn && pst.startOn !== 'anywhere' ? pst.startOn : null);
      const frameEmpty = runs.length === 0 && flow.col === 0 && flow.y === null;
      if (startOn === 'frame' && !frameEmpty) break outer;
      if (startOn === 'column' && flow.y !== null && !advance(flow)) break outer;
    }
    // Spanning heads: only while nothing but spanning paragraphs has been set in this frame.
    spanning = spanPhase && startsPara && !!pst.spanColumns && flow.col === 0;
    if (spanPhase && !spanning && (startsPara || flow.y !== null)) {
      spanPhase = false;
      if (flow.y != null && flow.col === 0) { colTop = flow.y + style.leading * 0.3; flow.y = null; }
    }
    const base = cloneFlow(flow);
    let fl = cloneFlow(flow);
    if (fl.y != null && startsPara) fl.y += gridRound(ps.spaceBefore, grid);
    let maxFirst: number | null = null;
    let pl = plan(pp, cur.item, fl, maxFirst);
    let sim = simulate(pp, pl, fl);
    for (let attempt = 0; startsPara && attempt < 6; attempt++) {
      const atTop = fl.y === null;
      const counts: number[] = [];
      let lastCol = -2;
      for (const p of sim.placed) { if (p.slot.col !== lastCol) { counts.push(0); lastCol = p.slot.col; } counts[counts.length - 1]++; }
      const total = pl.lines.length;
      const spans = counts.length > 1 || (sim.stop != null && sim.placed.length > 0);
      const orphans = Math.max(1, pst.orphans ?? 1), widows = Math.max(1, pst.widows ?? 1);
      let moveOn = false;
      if (!atTop && spans && (pst.keepTogether || (counts[0] ?? 0) < Math.min(orphans, total))) moveOn = true;
      if (!moveOn && !atTop && (pst.keepWithNext ?? 0) > 0 && sim.stop == null && cur.para + 1 < prep.paras.length) {
        // Keep with next: the next paragraph's first lines must follow in the same column.
        const next = prep.paras[cur.para + 1];
        const endY = sim.flow.y ?? top;
        const need = gridRound(ps.spaceAfter + next.ps.spaceBefore, grid) + gridLeading(next.ps.leading, grid) * Math.max(1, pst.keepWithNext ?? 1) + next.ps.size * 0.22;
        if (endY + need > bottom - sim.flow.reserve[sim.flow.col] + 0.5) moveOn = true;
      }
      if (moveOn) {
        fl = cloneFlow(base);
        if (!advance(fl)) break outer;
        maxFirst = null;
        pl = plan(pp, cur.item, fl, null);
        sim = simulate(pp, pl, fl);
        continue;
      }
      // Widows: pull lines from the previous column so the last part keeps enough.
      if (counts.length === 2 && maxFirst == null && sim.stop == null) {
        const last = counts[1];
        if (last < Math.min(widows, total)) {
          const cut = counts[0] - (widows - last);
          if (cut >= Math.min(orphans, counts[0]) && cut > 0) {
            maxFirst = cut;
            pl = plan(pp, cur.item, fl, maxFirst);
            sim = simulate(pp, pl, fl);
            continue;
          }
        }
      }
      break;
    }
    commit(pp, pl, sim.placed, paraNo);
    flow.col = sim.flow.col; flow.y = sim.flow.y; flow.reserve = sim.flow.reserve; flow.notes = sim.flow.notes; flow.used = sim.flow.used;
    if (sim.stop != null) {
      const item = pl.offsetBase + pl.lines[sim.stop].start;
      if (sim.reason === 'notes') {
        // Footnotes filled the column: carry on with the rest of the paragraph in the next one.
        flow.col = Math.max(flow.col, pl.slot(sim.stop).col) + 1;
        flow.y = null;
        cur = { para: cur.para, item };
        paraNo++;
        if (flow.col >= cols) break outer;
        continue;
      }
      cur = { para: cur.para, item };
      break outer;
    }
    if (flow.y != null) flow.y += gridRound(ps.spaceAfter, grid);
    cur = { para: cur.para + 1, item: 0 };
    paraNo++;
  }
  if (cur && cur.para >= prep.paras.length) cur = null;

  const shiftLine = (rec: (typeof lineRecs)[number], dy: number) => {
    for (let r = rec.from; r < rec.to; r++) runs[r].y += dy;
    const bi = baselines.indexOf(rec.base);
    if (bi >= 0) { baselines[bi] += dy; lineBoxes[bi].y += dy; }
    rec.base += dy; rec.top += dy; rec.bottom += dy;
  };
  const shiftGroups = (col: number, para: number, dy: number) => {
    for (const list of [under, over, dcPrims]) for (const x of list) if (x.col === col && x.para === para) x.g.matrix![5] += dy;
  };

  // Vertical alignment / justification — only when everything fits and no initial is anchored to the top.
  if (!cur && frame.verticalAlign !== 'top' && lineRecs.length && !hasDropCap) {
    for (let c = 0; c < cols; c++) {
      const recs = lineRecs.filter((r) => r.col === c);
      if (!recs.length) continue;
      const colBottom = bottom - flow.reserve[c];
      const usedTop = recs[0].top, usedBottom = recs[recs.length - 1].bottom;
      const slack = colBottom - usedBottom - (usedTop - top);
      if (slack <= 0.5) continue;
      if (frame.verticalAlign === 'justify') {
        const paras = [...new Set(recs.map((r) => r.para))];
        const slackJ = colBottom - usedBottom;
        if (paras.length > 1) {
          const add = slackJ / (paras.length - 1);
          paras.forEach((p, k) => { for (const r of recs) if (r.para === p) shiftLine(r, k * add); shiftGroups(c, p, k * add); });
        } else if (recs.length > 1) {
          const add = slackJ / (recs.length - 1);
          recs.forEach((r, k) => shiftLine(r, k * add));
        }
      } else {
        const shift = frame.verticalAlign === 'middle' ? slack / 2 : slack;
        const paras = new Set(recs.map((r) => r.para));
        for (const r of recs) shiftLine(r, shift);
        for (const p of paras) shiftGroups(c, p, shift);
      }
    }
  }

  const prims: Prim[] = [];
  for (const x of under) prims.push(x.g);
  for (const x of dcPrims) prims.push(x.g);
  if (runs.length) prims.push({ t: 'text', runs });
  for (const x of over) prims.push(x.g);

  // Footnotes at the foot of each column, under a short rule.
  for (let c = 0; c < cols; c++) {
    const notes = flow.notes[c];
    if (!notes.length) continue;
    const cx = colXAt(c);
    let y = bottom - flow.reserve[c] + fnGap;
    if (style.footnoteRule !== false) {
      const ry = y - fnGap * 0.55;
      prims.push({ t: 'path', d: rtl ? `M${cx + colW * 0.75} ${ry}H${cx + colW}` : `M${cx} ${ry}H${cx + colW * 0.25}`, stroke: style.color, strokeWidth: 0.5 });
    }
    for (const fn of notes) {
      const l = fnLayout(fn);
      prims.push({ t: 'group', matrix: [1, 0, 0, 1, cx, y], children: l.prims });
      y += fnHeight(fn);
    }
  }

  // Column rules, centred in the gutters.
  if (frame.columnRule && frame.columnRule.weight > 0 && cols > 1) {
    const r = frame.columnRule;
    const w = r.weight;
    const yb = frame.balance ? Math.max(top, ...lineRecs.map((l) => l.bottom)) : frameBottom;
    for (let c = 0; c < cols - 1; c++) {
      const x = ins.left + (c + 1) * colW + c * frame.columnGap + frame.columnGap / 2;
      prims.push({ t: 'path', d: `M${x} ${top}V${yb}`, stroke: r.color, strokeWidth: w, dash: r.style === 'dashed' ? [w * 4, w * 3] : r.style === 'dotted' ? [0.01, w * 2.5] : undefined, cap: r.style === 'dotted' ? 'round' : 'butt' });
    }
  }

  const usedBottom = flow.notes.some((n) => n.length) ? frameBottom : lineRecs.reduce((m, r) => Math.max(m, r.bottom), top);
  return { layout: { prims, lineCount, overflow: !!cur, baselines, lines: lineBoxes, usedHeight: usedBottom + ins.bottom, heads }, cursor: cur };
}

/** Balanced columns: the shortest column depth at which everything still fits. */
function layoutFrameBalanced(prep: Prepared, style: TextStyle, frame: FrameSpec, cursor: Cursor, isFirstFrame: boolean) {
  const full = layoutFrame(prep, style, frame, cursor, isFirstFrame);
  if (!frame.balance || frame.columns < 2 || full.layout.overflow || !full.layout.lineCount) return full;
  const top = frame.insets?.top ?? frame.inset;
  let lo = top + style.leading, hi = frame.h - (frame.insets?.bottom ?? frame.inset);
  for (let k = 0; k < 14 && hi - lo > 0.5; k++) {
    const mid = (lo + hi) / 2;
    if (layoutFrame(prep, style, frame, cursor, isFirstFrame, mid).layout.overflow) lo = mid; else hi = mid;
  }
  return layoutFrame(prep, style, frame, cursor, isFirstFrame, hi);
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

export function frameSpecOf(el: TextElement, grid?: FrameSpec['grid'], wraps?: WrapShape[]): FrameSpec {
  return {
    w: el.w, h: el.h, columns: el.columns, columnGap: el.columnGap, inset: el.inset, insets: el.insetSides ?? null,
    verticalAlign: el.verticalAlign, grid, firstBaseline: el.firstBaseline, firstBaselineMin: el.firstBaselineMin,
    balance: el.balanceColumns, columnRule: el.columnRule ?? null, wraps: el.wrapIgnore ? undefined : wraps,
  };
}

/** Lay out a story through one or more threaded frames. */
export function layoutStory(text: string, style: TextStyle, frames: FrameSpec[], tokens: TokenContext, styles: StoryStyles | null = null): FrameLayout[] {
  const expanded = expandTokens(text, tokens);
  if (style.writingMode === 'vertical') {
    // Vertical stories are set per frame (threading of vertical text is not supported).
    return frames.map((f, i) => (i === 0 ? layoutVertical(expanded, style, f) : { prims: [], lineCount: 0, overflow: false, baselines: [], lines: [] }));
  }
  const f0 = frames[0];
  const in0 = f0?.insets ? f0.insets.left + f0.insets.right : (f0?.inset ?? 0) * 2;
  const firstColW = f0 ? (f0.w - in0 - f0.columnGap * (Math.max(1, f0.columns) - 1)) / Math.max(1, f0.columns) : 100;
  const useStyles = styles && (styles.para.length || styles.char.length || styles.hyphenation?.length) ? styles : null;
  const prep = prepare(expanded, style, firstColW, useStyles);
  const out: FrameLayout[] = [];
  let cursor: Cursor | null = { para: 0, item: 0 };
  frames.forEach((frame, i) => {
    if (!cursor) {
      out.push({ prims: [], lineCount: 0, overflow: false, baselines: [], lines: [] });
      return;
    }
    const { layout, cursor: next } = layoutFrameBalanced(prep, style, frame, cursor, i === 0);
    out.push(layout);
    cursor = next;
  });
  return out;
}
