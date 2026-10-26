/**
 * Table layout: sizes columns and rows from their content, sets every cell's story with the
 * text engine (so cells get the same Knuth–Plass justification, hyphenation, kerning, small caps
 * and story markup as a text frame), aligns figures on the decimal, and compiles fills, rules,
 * diagonals and text to display-list primitives — which the editor, SVG, PDF, thumbnails and the
 * 3D book all draw.
 *
 * A table may run on through threaded table frames: the head frame holds the table, the rows are
 * paginated over the frames (header and footer rows repeat, rows are kept whole or broken), and
 * every frame compiles only its own slice.
 *
 * Large tables: setting a cell's story is the expensive part (a new number costs a font shaping),
 * so every cell measurement is cached by its text, format and width in a cache sized for tables
 * of tens of thousands of cells — a redraw after an edit sets only the cells that changed. Cells
 * that share a format share one resolved style, a cell whose natural line already fits its column
 * is not set a second time, and each frame of a thread visits only the rows it shows.
 */
import type { Project, TextStyle } from '../model/types';
import type {
  TableElement, TableStyleProps, CellStyleProps, CellAlign, CellVAlign, CellRotation, CellDiagonal, TableStroke, CellEdges, Anchor,
} from '../model/table';
import { BASE_CELL, coverMap, anchorsOf, findCellStyle, mergeCellProps, resolveTableStyle, rowRegion, figureFeatures, ruleStyleOf, ruleExtent, gapOf } from '../model/table';
import type { GroupPrim, Matrix, Prim, TextRun } from './primitives';
import { rectPath } from './primitives';
import { resolveParaStyles, resolveCharStyles } from '../engine/text/props';
import { layoutStory, applyParagraphStyle, type FrameLayout, type FrameSpec, type StoryStyles, type TokenContext } from '../engine/textLayout';
import { canOutline, ensureFamily, fontMetrics, getFace, getFamily, measure, resolveFont, shape, useFontStore } from '../engine/fonts';

export interface TableContext { project: Project; pageIndex: number | null }

/** A cell as laid out in one frame (anchor cells only), frame-local pt. */
export interface CellBox {
  /** Anchor row / column in the table; `rs` counts the rows shown in this frame. */
  r: number; c: number; rs: number; cs: number;
  x: number; y: number; w: number; h: number;
  /** Text did not fit (fixed or clipped rows). */
  overflow: boolean;
  /** The rest of a merged cell whose first row sits in an earlier frame (its story runs on here). */
  ghost?: boolean;
}

export interface TableLayout {
  colX: number[];
  colW: number[];
  /** Row boundaries of the rows shown in this frame. */
  rowY: number[];
  /** Shown row → table row (header rows repeat in continuation frames). */
  rowMap: number[];
  /** Shown row → piece of a row broken across frames (-1 = whole row). */
  rowPiece: number[];
  /** Height of every table row. */
  rowH: number[];
  /** Per table row: the least height its content needs. */
  contentMin: number[];
  width: number;
  /** Height of the rows shown in this frame. */
  height: number;
  /** Width the columns want without fitting the frame (auto + fixed + minimal fr). */
  naturalWidth: number;
  /** Height of the whole table before body rows are stretched to fill the frame. */
  naturalHeight: number;
  hasFr: boolean;
  /** Rows are left over after this, the last frame. */
  overset: boolean;
  /** In this frame the table stopped at rows too tall for a whole frame (and not allowed to break). */
  stuck: { r0: number; r1: number } | null;
  /** Position of this frame in its thread. */
  frameIndex: number;
  frameCount: number;
  cells: CellBox[];
  prims: Prim[];
}

/* -------------------------------------------------------------------------- */
/* Cache keys                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ask for a font family without starting its load during a render (the load updates the font
 * store; a table may first be laid out inside a thumbnail). The layout re-runs when it arrives.
 */
const requested = new Set<string>();
function requestFamily(id: string | undefined | null) {
  if (!id || requested.has(id)) return;
  requested.add(id);
  queueMicrotask(() => { void ensureFamily(id); });
}

const objIds = new WeakMap<object, number>();
let objCounter = 0;
const idOf = (o: object | undefined | null): number => {
  if (!o) return 0;
  let v = objIds.get(o);
  if (v == null) { v = ++objCounter; objIds.set(o, v); }
  return v;
};

/**
 * Everything outside the element that a table's appearance depends on. With the element, a
 * threaded frame's key also covers every frame of its thread (the head holds the rows).
 */
export function tableContextKey(ctx: TableContext, fontVersion = useFontStore.getState().version, el?: TableElement): string {
  const p = ctx.project;
  const base = `${fontVersion}|${idOf(p.paragraphStyles)}|${idOf(p.characterStyles)}|${idOf(p.tableStyles)}|${idOf(p.cellStyles)}|${idOf(p.book)}|${ctx.pageIndex ?? '-'}|${p.pages.length}`;
  if (!el) return base;
  const th = tableThreadOf(p, el.id);
  return th && th.frames.length > 1 ? `${base}|${th.frames.map((f) => idOf(f.el)).join(',')}` : base;
}

/* -------------------------------------------------------------------------- */
/* Threads                                                                     */
/* -------------------------------------------------------------------------- */

export interface TableFrameRef { el: TableElement; pageIndex: number | null; surface: string }
export interface TableThread { head: TableElement; frames: TableFrameRef[]; index: number }

interface TableIndex { byId: Map<string, TableFrameRef>; prev: Map<string, string> }
const indexCache = new WeakMap<Project, TableIndex>();

function tableIndex(project: Project): TableIndex {
  let idx = indexCache.get(project);
  if (idx) return idx;
  const byId = new Map<string, TableFrameRef>();
  project.pages.forEach((pg, pi) => { for (const e of pg.elements) if (e.type === 'table') byId.set(e.id, { el: e, pageIndex: pi, surface: `page:${pg.id}` }); });
  for (const m of project.masters) {
    for (const e of m.left) if (e.type === 'table') byId.set(e.id, { el: e, pageIndex: null, surface: `master:${m.id}:left` });
    for (const e of m.right) if (e.type === 'table') byId.set(e.id, { el: e, pageIndex: null, surface: `master:${m.id}:right` });
  }
  for (const e of project.cover.elements) if (e.type === 'table') byId.set(e.id, { el: e, pageIndex: null, surface: 'cover' });
  for (const e of project.jacket?.elements ?? []) if (e.type === 'table') byId.set(e.id, { el: e, pageIndex: null, surface: 'jacket' });
  const prev = new Map<string, string>();
  for (const { el } of byId.values()) if (el.flowNext && byId.has(el.flowNext) && el.flowNext !== el.id) prev.set(el.flowNext, el.id);
  idx = { byId, prev };
  indexCache.set(project, idx);
  return idx;
}

/** The thread a table frame belongs to (head first, cycle-safe); null when the frame is not in the project. */
export function tableThreadOf(project: Project, id: string): TableThread | null {
  const { byId, prev } = tableIndex(project);
  if (!byId.has(id)) return null;
  let head = id;
  const seen = new Set<string>([head]);
  while (prev.has(head) && !seen.has(prev.get(head)!)) { head = prev.get(head)!; seen.add(head); }
  const frames: TableFrameRef[] = [];
  const seen2 = new Set<string>();
  for (let cur: string | null = head; cur && byId.has(cur) && !seen2.has(cur); cur = byId.get(cur)!.el.flowNext ?? null) {
    frames.push(byId.get(cur)!);
    seen2.add(cur);
  }
  const index = frames.findIndex((f) => f.el.id === id);
  return index < 0 ? null : { head: frames[0].el, frames, index };
}

/** The table that holds the rows for a frame (the head of its thread, or the frame itself). */
export function tableHead(project: Project, el: TableElement): TableElement {
  const th = tableThreadOf(project, el.id);
  return th && th.frames.length > 1 ? th.head : el;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The fields of a table frame its layout depends on — not its position, name or opacity — so a
 * moved frame (or a frame whose height follows its rows) reuses the layout of a large table
 * instead of setting it again. Sub-objects count by identity (unchanged ones keep it in the store).
 */
function contentKey(el: TableElement, withHeight: boolean): string {
  return [
    idOf(el.rows), idOf(el.cols), idOf(el.cells), el.headerRows, el.footerRows, el.tableStyle, idOf(el.local), idOf(el.style), el.paraStyle,
    el.fitWidth, el.autoHeight, el.fillHeight, el.w, withHeight ? el.h : '', el.repeatHeader, el.skipFirstHeader, el.repeatFooter, el.skipLastFooter, el.breakRows,
  ].join('|');
}

/**
 * Layouts by frame id (single frames) and by head id (threads), newest last; the last two
 * versions of each, so two views of different states of one table do not undo each other.
 */
const singleCache = new Map<string, { key: string; layout: TableLayout }[]>();
const threadCache = new Map<string, { key: string; layouts: TableLayout[] }[]>();
function recall<V extends { key: string }>(m: Map<string, V[]>, id: string, key: string): V | undefined {
  return m.get(id)?.find((e) => e.key === key);
}
function remember<V extends { key: string }>(m: Map<string, V[]>, id: string, v: V) {
  const prev = m.get(id);
  m.delete(id);
  m.set(id, prev ? [v, prev[0]] : [v]);
  if (m.size > 400) m.delete(m.keys().next().value!);
}

export function layoutTable(el: TableElement, ctx: TableContext): TableLayout {
  const th = tableThreadOf(ctx.project, el.id);
  if (th && th.frames.length > 1 && th.frames[th.index].el === el) {
    const head = th.head;
    const hctx: TableContext = { project: ctx.project, pageIndex: th.frames[0].pageIndex };
    // The head holds the rows; the frames give only their heights (and widths, for empty ones).
    const key = `${tableContextKey(hctx)}|${contentKey(head, false)}|${th.frames.map((f) => `${f.el.id}:${f.el.h}:${f.el.w}`).join(',')}`;
    const hit = recall(threadCache, head.id, key);
    if (hit) return hit.layouts[th.index];
    let layouts: TableLayout[];
    try {
      layouts = computeThread(saneTable(head), th.frames.map((f) => saneTable(f.el)), hctx);
    } catch (err) {
      console.error('Table layout failed', err);
      layouts = th.frames.map((f) => emptyLayout(f.el));
    }
    remember(threadCache, head.id, { key, layouts });
    return layouts[th.index];
  }
  // A frame whose height follows its rows lays out the same at any height.
  const key = `${tableContextKey(ctx)}|${contentKey(el, !el.autoHeight || el.fillHeight)}`;
  const hit = recall(singleCache, el.id, key);
  if (hit) return hit.layout;
  let layout: TableLayout;
  try {
    layout = computeSingle(saneTable(el), ctx);
  } catch (err) {
    console.error('Table layout failed', err);
    layout = emptyLayout(el);
  }
  remember(singleCache, el.id, { key, layout });
  return layout;
}

export function compileTable(el: TableElement, ctx: TableContext): Prim[] {
  return layoutTable(el, ctx).prims;
}

/**
 * Counts and sizes from a project file or a field can be NaN, infinite, negative or fractional. An
 * infinite header-row count once looped forever adding rows until the tab ran out of memory, so the
 * table is clamped before layout. Returns the element itself when nothing needs fixing (caches key on it).
 */
function saneTable(el: TableElement): TableElement {
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const R = el.rows.length;
  const hr = Math.round(num(el.headerRows, 0, 0, R));
  const fr = Math.round(num(el.footerRows, 0, 0, R - hr));
  const w = num(el.w, 0, 0, 1e6), h = num(el.h, 0, 0, 1e6);
  const rowsOk = el.rows.every((r) => Number.isFinite(r.h) && r.h >= 0);
  const colsOk = el.cols.every((c) => c.w == null || (Number.isFinite(c.w) && c.w >= 0));
  const styleOk = Number.isFinite(el.style.fontSize) && el.style.fontSize > 0 && Number.isFinite(el.style.leading) && el.style.leading > 0;
  if (hr === el.headerRows && fr === el.footerRows && w === el.w && h === el.h && rowsOk && colsOk && styleOk && el.cells.length >= R) return el;
  const cells = el.cells.length >= R ? el.cells : [...el.cells, ...Array.from({ length: R - el.cells.length }, () => el.cols.map(() => ({ text: '' })))];
  return {
    ...el, headerRows: hr, footerRows: fr, w, h, cells,
    rows: rowsOk ? el.rows : el.rows.map((r) => ({ ...r, h: num(r.h, 0, 0, 1e5) })),
    cols: colsOk ? el.cols : el.cols.map((c) => ({ ...c, w: num(c.w, c.mode === 'fr' ? 1 : 0, 0, 1e5) })),
    style: styleOk ? el.style : { ...el.style, fontSize: num(el.style.fontSize, 9, 0.1, 5000), leading: num(el.style.leading, 11, 0.1, 10000) },
  };
}

/** An empty frame (a continuation not threaded to any table): nothing printed. */
function emptyLayout(el: TableElement): TableLayout {
  return {
    colX: [0, el.w], colW: [el.w], rowY: [0], rowMap: [], rowPiece: [], rowH: [], contentMin: [], width: el.w, height: 0,
    naturalWidth: el.w, naturalHeight: 0, hasFr: true, overset: false, stuck: null, frameIndex: 0, frameCount: 1, cells: [], prims: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Cell resolution                                                             */
/* -------------------------------------------------------------------------- */

/** A cell's resolved formatting; cells with the same column, region, cell style and local formatting share one. */
interface CellFmt {
  style: TextStyle;
  /** Measurement style: ragged left, no hyphenation (natural widths). */
  natStyle: TextStyle;
  align: CellAlign;
  decimalChar: string;
  valign: CellVAlign;
  pad: { t: number; r: number; b: number; l: number };
  /** The cell's own fill (null = none); undefined = the table's region / zebra fill. */
  ownFill: string | null | undefined;
  rotation: CellRotation;
  diagonal: CellDiagonal;
  diagonalStroke: TableStroke;
  edges: CellEdges;
  /** Name of a character style laid over the whole cell. */
  charStyle: string | null;
  /**
   * The natural (unbroken) setting may stand for the setting at the column width when its single
   * line fits: ragged left, plain composition (no rag shapes, runts, margins or right indent).
   */
  reuseNatural: boolean;
}

interface ResolvedCell {
  a: Anchor;
  text: string;
  style: TextStyle;
  natStyle: TextStyle;
  align: CellAlign;
  decimalChar: string;
  valign: CellVAlign;
  pad: { t: number; r: number; b: number; l: number };
  fill: string | null;
  rotation: CellRotation;
  diagonal: CellDiagonal;
  diagonalStroke: TableStroke;
  edges: CellEdges;
  reuseNatural: boolean;
  /** Set once per layout: the natural setting and the setting at the column width. */
  nat?: Measured;
  fit?: Measured;
}

function tokensFor(project: Project, pageIndex: number | null): TokenContext {
  const b = project.book;
  return { page: (pageIndex ?? 0) + 1, pages: project.pages.length, title: b.title, subtitle: b.subtitle, author: b.author, publisher: b.publisher };
}

/** The cell's base text style: the table's text style made suitable for a cell. */
function cellBase(el: TableElement, project: Project): TextStyle {
  let s: TextStyle = {
    ...el.style,
    features: { ...el.style.features },
    axes: { ...el.style.axes },
    dropCap: { ...el.style.dropCap, enabled: false },
    indentFirstParagraph: false,
    baselineGrid: false,
    writingMode: 'horizontal',
    firstLineSmallCaps: false,
  };
  const ps = el.paraStyle ? resolveParaStyles(project.paragraphStyles ?? []).find((d) => d.id === el.paraStyle)?.props : null;
  if (ps) s = applyParagraphStyle(s, ps);
  s.firstLineIndent = 0;
  return s;
}

function applyCellText(base: TextStyle, P: CellStyleProps, project: Project): TextStyle {
  let s: TextStyle = { ...base, features: { ...base.features } };
  const ps = P.paraStyle ? resolveParaStyles(project.paragraphStyles ?? []).find((d) => d.id === P.paraStyle)?.props : null;
  if (ps) { s = applyParagraphStyle(s, ps); s.firstLineIndent = 0; }
  if (P.fontFamily != null && P.fontFamily !== s.fontFamily) { s.fontFamily = P.fontFamily; s.axes = {}; }
  if (P.fontSize != null && P.fontSize > 0) {
    if (P.leading == null) s.leading = +((s.leading * P.fontSize) / s.fontSize).toFixed(2);
    s.fontSize = P.fontSize;
  }
  if (P.leading != null && P.leading > 0) s.leading = P.leading;
  if (P.weight != null) s.weight = P.weight;
  if (P.italic != null) s.italic = P.italic;
  if (P.color != null) s.color = P.color;
  if (P.tracking != null) s.tracking = P.tracking;
  if (P.textTransform != null) s.textTransform = P.textTransform;
  if (P.hyphenate != null) s.hyphenate = P.hyphenate;
  if (P.features) s.features = { ...s.features, ...P.features };
  const ff = figureFeatures(P.figures);
  if (ff) s.features = { ...s.features, ...ff };
  if (P.align) s.align = P.align === 'decimal' ? 'left' : P.align;
  return s;
}

/** A whole-cell character style wraps each paragraph (after any `[Para]` tag). */
function wrapCharStyle(text: string, name: string): string {
  return text.split('\n').map((line) => {
    if (!line.trim()) return line;
    const m = /^\[([^\]]{1,60})\]\s*/.exec(line);
    const head = m ? m[0] : '';
    return `${head}<${name}>${line.slice(head.length)}</${name}>`;
  }).join('\n');
}

function regionFill(el: TableElement, T: TableStyleProps, r: number, c: number): string | null {
  const region = rowRegion(el, r);
  if (region === 'header') return T.headerFill;
  if (region === 'footer') return T.footerFill;
  const bi = r - el.headerRows;
  const ci = c - (T.stub ? 1 : 0);
  if (T.colZebraFill && ci >= 0 && Math.floor(ci / Math.max(1, T.colZebraEvery)) % 2 === 1) return T.colZebraFill;
  if (T.zebraFill && Math.floor(bi / Math.max(1, T.zebraEvery)) % 2 === ((T.zebraOffset ?? 1) % 2 === 0 ? 0 : 1)) return T.zebraFill;
  return T.fill;
}

/** Cascaded formatting of one anchor cell (exported for the inspector). */
export function cellProps(el: TableElement, project: Project, r: number, c: number, T = resolveTableStyle(project, el)): CellStyleProps {
  const col = el.cols[c];
  const region = rowRegion(el, r);
  let P: CellStyleProps = {};
  if (col) {
    P = mergeCellProps(P, {
      align: col.align ? (region === 'header' && col.align === 'decimal' ? 'center' : col.align) : undefined,
      decimalChar: col.decimalChar || undefined,
      figures: region === 'header' ? undefined : col.figures,
    });
  }
  const regionId = region === 'header' ? T.headerCell : region === 'footer' ? T.footerCell : T.bodyCell;
  P = mergeCellProps(P, findCellStyle(project, regionId)?.props);
  if (T.stub && c === 0 && region === 'body') P = mergeCellProps(P, findCellStyle(project, T.stubCell)?.props);
  const cell = el.cells[r]?.[c];
  P = mergeCellProps(P, findCellStyle(project, cell?.cellStyle)?.props);
  P = mergeCellProps(P, cell?.fmt);
  return P;
}

function resolveFmt(el: TableElement, T: TableStyleProps, project: Project, base: TextStyle, r: number, c: number): CellFmt {
  const P = cellProps(el, project, r, c, T);
  const style = applyCellText(base, P, project);
  requestFamily(style.fontFamily);
  const cs = P.charStyle ? resolveCharStyles(project.characterStyles ?? []).find((d) => d.id === P.charStyle) : null;
  requestFamily(cs?.props.fontFamily);
  return {
    style,
    natStyle: { ...style, align: 'left', hyphenate: false },
    align: P.align ?? (style.align === 'justify-all' ? 'justify' : style.align),
    decimalChar: P.decimalChar || BASE_CELL.decimalChar,
    valign: P.valign ?? BASE_CELL.valign,
    pad: { t: P.padTop ?? BASE_CELL.padTop, r: P.padRight ?? BASE_CELL.padRight, b: P.padBottom ?? BASE_CELL.padBottom, l: P.padLeft ?? BASE_CELL.padLeft },
    ownFill: P.fill,
    rotation: P.rotation ?? 0,
    diagonal: P.diagonal ?? 'none',
    diagonalStroke: P.diagonalStroke ?? BASE_CELL.diagonalStroke,
    edges: P.edges ?? {},
    charStyle: cs ? cs.name : null,
    reuseNatural: style.align === 'left' && style.direction !== 'rtl' && style.writingMode !== 'vertical' && (style.rag ?? 'natural') === 'natural'
      && !style.avoidRunts && !style.avoidShortLineEnds && !style.opticalMargin && !((style.rightIndent ?? 0) > 0) && !style.firstLineSmallCaps && !style.dropCap?.enabled,
  };
}

/** The cells' formats for one layout, shared by the cells that cascade alike. */
function fmtResolver(el: TableElement, T: TableStyleProps, project: Project, base: TextStyle) {
  const fmts = new Map<string, CellFmt>();
  const of = (r: number, c: number): CellFmt => {
    const cell = el.cells[r]?.[c];
    const key = `${c}|${rowRegion(el, r)}|${cell?.cellStyle ?? ''}|${cell?.fmt ? idOf(cell.fmt) : 0}`;
    let f = fmts.get(key);
    if (!f) { f = resolveFmt(el, T, project, base, r, c); fmts.set(key, f); }
    return f;
  };
  return { of, fmts };
}

function resolveCell(el: TableElement, T: TableStyleProps, fmtOf: (r: number, c: number) => CellFmt, a: Anchor): ResolvedCell {
  const f = fmtOf(a.r, a.c);
  const raw = el.cells[a.r]?.[a.c]?.text ?? '';
  return {
    a,
    text: f.charStyle && raw.trim() ? wrapCharStyle(raw, f.charStyle) : raw,
    style: f.style,
    natStyle: f.natStyle,
    align: f.align,
    decimalChar: f.decimalChar,
    valign: f.valign,
    pad: f.pad,
    fill: f.ownFill !== undefined ? f.ownFill : regionFill(el, T, a.r, a.c),
    rotation: f.rotation,
    diagonal: f.diagonal,
    diagonalStroke: f.diagonalStroke,
    edges: f.edges,
    reuseNatural: f.reuseNatural,
  };
}

/* -------------------------------------------------------------------------- */
/* Text measurement                                                            */
/* -------------------------------------------------------------------------- */

const BIG = 100000;

interface Measured {
  layout: FrameLayout;
  /** Widest line (from the frame's left edge). */
  width: number;
  /** Cap height of the first line to the descent of the last. */
  height: number;
  /** One line (or none) of plain text runs: the same setting in any frame it fits. */
  simple: boolean;
}

const frameOf = (w: number, h: number, valign: CellVAlign = 'top'): FrameSpec =>
  ({ w: Math.max(1, w), h: Math.max(1, h), columns: 1, columnGap: 0, inset: 0, verticalAlign: valign, grid: null });

function runsOf(prims: Prim[]): TextRun[] {
  const out: TextRun[] = [];
  for (const p of prims) if (p.t === 'text') for (const r of p.runs) out.push(r);
  return out;
}

/**
 * A two-generation cache: hits are kept in the newer map, and when it fills the older one is
 * dropped whole. Everything one layout uses survives as long as it fits the bound (a plain
 * clear-when-full cache thrashed on every redraw of a table with more cells than its limit).
 */
class GenCache<V> {
  private cur = new Map<string, V>();
  private old = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get(k: string): V | undefined {
    const v = this.cur.get(k);
    if (v !== undefined) return v;
    const o = this.old.get(k);
    if (o !== undefined) this.set(k, o);
    return o;
  }
  set(k: string, v: V) {
    this.cur.set(k, v);
    if (this.cur.size >= this.cap) { this.old = this.cur; this.cur = new Map(); }
  }
}

/**
 * Cell settings. A 3,000 × 30 table of figures keeps about 95,000 (a natural setting per cell of
 * an auto column, a setting at the column width where that one does not serve, longest words);
 * two generations of this bound stay under a few hundred MB.
 */
const cellCache = new GenCache<Measured>(200_000);
/** Cells set through several frames (broken rows, merged cells dealt over frames). */
const framesCache = new GenCache<FrameLayout[]>(20_000);

/** A small number per distinct text style (cache keys stay short; JSON once per style object). */
const styleNoOf = new WeakMap<object, number>();
const styleNos = new Map<string, number>();
let styleCounter = 0;
function styleNo(style: TextStyle): number {
  let n = styleNoOf.get(style);
  if (n != null) return n;
  const json = JSON.stringify(style);
  n = styleNos.get(json);
  if (n == null) {
    // Numbers are never reused, so dropping the table cannot make an old cache entry match.
    if (styleNos.size > 5000) styleNos.clear();
    n = ++styleCounter;
    styleNos.set(json, n);
  }
  styleNoOf.set(style, n);
  return n;
}

/**
 * Cache key of a cell's story. The page tokens ({page} …) count only for text that has any; the
 * app-wide font version (it also moves when hyphenation patterns or pictures load) only for text
 * that hyphenates or holds {…} — everything else depends on the table's own fonts (`env.key`), so
 * a font loading for some other frame does not set a large table again from scratch.
 */
function storyKey(text: string, style: TextStyle, env: Env): string {
  const braces = text.includes('{');
  const hyph = style.hyphenate || (env.paraHyphenates && text.includes('['));
  return `${env.key}|${braces ? env.tok : ''}|${braces || hyph ? env.version : ''}|${styleNo(style)}|${text}`;
}

/**
 * Load state of the font families a table's cells can be set in: their formats' families, those
 * of every paragraph and character style (markup can name any of them) and the fallback family.
 */
function fontSignature(families: Iterable<string>): string {
  const out: string[] = [];
  for (const id of [...new Set(families)].sort()) {
    const fam = getFamily(id);
    out.push(`${id}>${fam.id}:${fam.faces.map((f) => getFace(f.key)?.status[0] ?? '-').join('')}`);
  }
  return out.join(',');
}

function measureLayout(layout: FrameLayout, style: TextStyle): Measured {
  const runs = runsOf(layout.prims);
  let width = 0;
  for (const r of runs) width = Math.max(width, r.x + r.width);
  const capH = fontMetrics(resolveFont({ family: style.fontFamily, weight: style.weight, italic: style.italic, size: style.fontSize })).capHeight;
  let height: number;
  const last = layout.baselines[layout.baselines.length - 1];
  if (last == null) height = capH * style.fontSize + 0.22 * style.fontSize;
  else {
    let size = style.fontSize;
    for (const r of runs) if (Math.abs(r.y - last) < r.size * 0.5) size = Math.max(size, r.size);
    height = last + 0.22 * size;
  }
  const simple = layout.baselines.length <= 1 && !layout.overflow && layout.prims.every((p) => p.t === 'text');
  return { layout, width, height, simple };
}

/** Set a cell's story in a w × h frame (memoised). */
function setText(text: string, style: TextStyle, w: number, h: number, valign: CellVAlign, env: Env): Measured {
  const key = `${Math.round(w * 100)}|${Math.round(h * 100)}|${valign}|${storyKey(text, style, env)}`;
  const hit = cellCache.get(key);
  if (hit) return hit;
  const [layout] = layoutStory(text, style, [frameOf(w, h, valign)], env.tokens, env.styles);
  const m = measureLayout(layout, style);
  cellCache.set(key, m);
  return m;
}

/** Set a cell's story through several frames of one width (a row broken across table frames). */
function setTextFrames(text: string, style: TextStyle, w: number, heights: number[], env: Env): FrameLayout[] {
  const key = `${Math.round(w * 100)}|${heights.map((h) => Math.round(h * 100)).join(',')}|${storyKey(text, style, env)}`;
  const hit = framesCache.get(key);
  if (hit) return hit;
  const lays = layoutStory(text, style, heights.map((h) => frameOf(w, h, 'top')), env.tokens, env.styles);
  framesCache.set(key, lays);
  return lays;
}

/** The cell's story set on one unbroken line per paragraph (natural width). */
function natural(rc: ResolvedCell, env: Env): Measured {
  return (rc.nat ??= setText(rc.text, rc.natStyle, BIG, BIG, 'top', env));
}

/**
 * The cell's story set at the width of its column (less padding). A natural setting of one plain
 * line that fits is that setting already (left-aligned text breaks nowhere when it fits).
 */
function fitted(rc: ResolvedCell, innerW: number, env: Env): Measured {
  if (rc.fit) return rc.fit;
  const n = rc.nat;
  rc.fit = rc.reuseNatural && n && n.simple && n.width <= innerW - 0.01 && !/[\n[{]/.test(rc.text) ? n : setText(rc.text, rc.style, innerW, BIG, 'top', env);
  return rc.fit;
}

/** Width of the longest word (the narrowest a column can get without breaking words). */
function minContent(rc: ResolvedCell, env: Env): number {
  if (!/[ \t]/.test(rc.text)) return natural(rc, env).width;
  return setText(rc.text.replace(/[ \t]+/g, '\n'), rc.natStyle, BIG, BIG, 'top', env).width;
}

/**
 * Advance from the start of a run to before UTF-16 index `idx`, as the run is drawn: the glyphs
 * of the whole run as shaped (no new shaping of the part — a decimal column once shaped every
 * figure twice), with letter spacing and kerning per glyph.
 */
function advanceTo(run: TextRun, idx: number): number {
  if (idx <= 0) return 0;
  if (canOutline(run.text, run.font)) {
    const sh = shape(run.text, run.font)!;
    const ls = run.letterSpacing ?? 0;
    let x = 0, u = 0;
    for (const g of sh.glyphs) {
      if (u >= idx) break;
      const n = Math.max(1, g.units);
      x += g.xAdvance * run.size + ls;
      if (run.kern) for (let j = 0; j < n; j++) x += run.kern[u + j] ?? 0;
      u += n;
    }
    return x;
  }
  const sub = run.text.slice(0, idx);
  let k = 0;
  if (run.kern) for (let i = 0; i < idx && i < run.kern.length; i++) k += run.kern[i];
  return measure(sub, run.font, run.size) + (run.letterSpacing ?? 0) * [...sub].length + k;
}

interface DecimalLine { y: number; pre: number; post: number; start: number }

/** Decimal positions of a setting (memoised: a cell's setting is shared by every frame and redraw). */
const decimalMemo = new WeakMap<FrameLayout, { ch: string; lines: DecimalLine[] }>();
function decimalLines(layout: FrameLayout, ch: string): DecimalLine[] {
  const hit = decimalMemo.get(layout);
  if (hit && hit.ch === ch) return hit.lines;
  const lines = computeDecimalLines(layout, ch);
  decimalMemo.set(layout, { ch, lines });
  return lines;
}

/** Where each line's decimal marker sits (or where it would, after the last digit). */
function computeDecimalLines(layout: FrameLayout, ch: string): DecimalLine[] {
  const runs = runsOf(layout.prims);
  const out: DecimalLine[] = [];
  for (const b of layout.baselines) {
    const line = runs.filter((r) => Math.abs(r.y - b) < r.size * 0.5).sort((x, y) => x.x - y.x);
    if (!line.length) continue;
    const start = line[0].x;
    const end = Math.max(...line.map((r) => r.x + r.width));
    let pre: number | null = null;
    for (const r of line) {
      const i = r.text.indexOf(ch);
      if (i >= 0) { pre = r.x + advanceTo(r, i); break; }
    }
    if (pre == null) {
      for (let k = line.length - 1; k >= 0 && pre == null; k--) {
        const r = line[k];
        const m = /\d(?!.*\d)/.exec(r.text);
        if (m) pre = r.x + advanceTo(r, m.index + 1);
      }
    }
    if (pre == null) pre = end;
    out.push({ y: b, pre, post: end - pre, start });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

interface Env {
  tokens: TokenContext;
  styles: StoryStyles | null;
  /** The table's fonts and the project styles every cell's setting depends on. */
  key: string;
  /** The page tokens, for text that holds any ({page}, {title} …). */
  tok: string;
  /** The app-wide font version (fonts, hyphenation patterns, pictures). */
  version: number;
  /** Some paragraph style hyphenates (markup may switch a cell's paragraphs to it). */
  paraHyphenates: boolean;
}

const MIN_COL = 6;

/** Everything measured once per table and shared by all of its frames. */
interface Measure {
  el: TableElement;
  T: TableStyleProps;
  env: Env;
  R: number;
  C: number;
  map: Int32Array;
  cells: ResolvedCell[];
  byKey: Map<number, ResolvedCell>;
  /** Per table row: the anchor cells that cover it (a merged cell is listed on each of its rows). */
  byRow: ResolvedCell[][];
  colX: number[];
  colW: number[];
  rowH: number[];
  contentMin: number[];
  naturalWidth: number;
  naturalHeight: number;
  hasFr: boolean;
  /** One decimal position per column for the whole table: widest part before and after the marker. */
  decimal: Map<number, { pre: number; post: number }>;
  /** The row may break across frames (single-row cells, not fixed, no turned text). */
  breakable: boolean[];
  /** Least height of one piece of a broken row (padding and a line). */
  minPiece: number[];
  /** A merged cell crosses the boundary above this row: the rows travel together. */
  joinedAbove: boolean[];
}

const rotated = (rc: ResolvedCell) => rc.rotation === 90 || rc.rotation === 270;
const innerWOf = (M: Measure, rc: ResolvedCell) => Math.max(1, M.colX[rc.a.c + rc.a.cs] - M.colX[rc.a.c] - rc.pad.l - rc.pad.r);

function computeSingle(el: TableElement, ctx: TableContext): TableLayout {
  const M = measureTable(el, ctx, el.fillHeight);
  if (!M) return emptyLayout(el);
  const heights = [el.autoHeight ? Infinity : el.h];
  const slices = paginate(M, heights);
  return renderSlice(M, slices[0], 0, 1, fitMergeParts(M, slices, heights));
}

function computeThread(head: TableElement, frames: TableElement[], ctx: TableContext): TableLayout[] {
  const M = measureTable(head, ctx, false);
  if (!M) return frames.map(emptyLayout);
  const heights = frames.map((f) => Math.max(1, f.h));
  const slices = paginate(M, heights);
  const parts = fitMergeParts(M, slices, heights);
  return slices.map((sl, i) => renderSlice(M, sl, i, frames.length, parts));
}

function measureTable(el: TableElement, ctx: TableContext, fill: boolean): Measure | null {
  const project = ctx.project;
  const R = el.rows.length, C = el.cols.length;
  if (!R || !C || el.cells.length < R) return null;
  requestFamily(el.style.fontFamily);
  const T = resolveTableStyle(project, el);
  const para = resolveParaStyles(project.paragraphStyles ?? []), char = resolveCharStyles(project.characterStyles ?? []);
  for (const d of para) requestFamily(d.props.fontFamily);
  const base = cellBase(el, project);
  const map = coverMap(el);
  const anchors = anchorsOf(el, map);
  const fmt = fmtResolver(el, T, project, base);
  const cells = anchors.map((a) => resolveCell(el, T, fmt.of, a));
  const families = ['eb-garamond', el.style.fontFamily];
  for (const f of fmt.fmts.values()) families.push(f.style.fontFamily);
  for (const d of para) if (d.props.fontFamily) families.push(d.props.fontFamily);
  for (const d of char) if (d.props.fontFamily) families.push(d.props.fontFamily);
  const tokens = tokensFor(project, ctx.pageIndex);
  const env: Env = {
    tokens,
    styles: para.length || char.length ? { para, char } : null,
    key: `${fontSignature(families)}|${idOf(project.paragraphStyles)}|${idOf(project.characterStyles)}`,
    tok: JSON.stringify(tokens),
    version: useFontStore.getState().version,
    paraHyphenates: para.some((d) => d.props.hyphenate),
  };
  const byKey = new Map<number, ResolvedCell>();
  const byRow: ResolvedCell[][] = Array.from({ length: R }, () => []);
  for (const rc of cells) {
    byKey.set(rc.a.r * C + rc.a.c, rc);
    for (let r = rc.a.r; r < rc.a.r + rc.a.rs; r++) byRow[r].push(rc);
  }

  /* ---------------------------------------------------------------- columns */
  const autoDemand = new Array<number>(C).fill(0);
  const decimalDemand = new Map<number, { pre: number; post: number; pad: number }>();
  for (const rc of cells) {
    const col = el.cols[rc.a.c];
    if (col.mode !== 'auto' || rc.a.cs !== 1) continue;
    const m = natural(rc, env);
    const pads = rc.pad.l + rc.pad.r;
    autoDemand[rc.a.c] = Math.max(autoDemand[rc.a.c], (rotated(rc) ? m.height : m.width) + pads);
    if (rc.align === 'decimal' && !rotated(rc)) {
      const d = decimalDemand.get(rc.a.c) ?? { pre: 0, post: 0, pad: 0 };
      for (const ln of decimalLines(m.layout, rc.decimalChar)) { d.pre = Math.max(d.pre, ln.pre - ln.start); d.post = Math.max(d.post, ln.post); }
      d.pad = Math.max(d.pad, pads);
      decimalDemand.set(rc.a.c, d);
    }
  }
  for (const [c, d] of decimalDemand) autoDemand[c] = Math.max(autoDemand[c], d.pre + d.post + d.pad);
  // A merged cell across auto columns widens them evenly.
  for (const rc of cells) {
    if (rc.a.cs < 2) continue;
    if (!el.cols.slice(rc.a.c, rc.a.c + rc.a.cs).every((col) => col.mode === 'auto')) continue;
    const m = natural(rc, env);
    const need = (rotated(rc) ? m.height : m.width) + rc.pad.l + rc.pad.r;
    const have = autoDemand.slice(rc.a.c, rc.a.c + rc.a.cs).reduce((s, v) => s + v, 0);
    if (need > have) for (let c = rc.a.c; c < rc.a.c + rc.a.cs; c++) autoDemand[c] += (need - have) / rc.a.cs;
  }
  const colW = el.cols.map((col, c) => {
    if (col.mode === 'fixed') return Math.max(1, col.w);
    if (col.mode === 'auto') { const w = Math.max(MIN_COL, autoDemand[c]); return col.w > 0 ? Math.min(w, col.w) : w; }
    return 0;
  });
  const frCols = el.cols.map((col, c) => (col.mode === 'fr' ? c : -1)).filter((c) => c >= 0);
  const frSum = frCols.reduce((s, c) => s + Math.max(0.01, el.cols[c].w || 1), 0);
  const MIN_FR = 12;
  let fixedSum = colW.reduce((s, v) => s + v, 0);
  // Auto columns give way (down to their longest word) when the table would overrun the frame.
  const avail = el.w;
  if (el.fitWidth || frCols.length) {
    const over = fixedSum + frCols.length * MIN_FR - avail;
    const autos = el.cols.map((col, c) => (col.mode === 'auto' ? c : -1)).filter((c) => c >= 0);
    if (over > 0.5 && autos.length) {
      // One pass over the cells. A decimal column keeps its whole demand (it is at least as wide
      // as any of its words), so its cells need no longest-word measure.
      const mw = new Array<number>(C).fill(MIN_COL);
      for (const rc of cells) {
        const c = rc.a.c;
        if (el.cols[c].mode !== 'auto' || rc.a.cs !== 1 || rotated(rc) || decimalDemand.has(c)) continue;
        mw[c] = Math.max(mw[c], minContent(rc, env) + rc.pad.l + rc.pad.r);
      }
      const minW = new Map<number, number>();
      for (const c of autos) minW.set(c, Math.min(decimalDemand.has(c) ? Math.max(mw[c], autoDemand[c]) : mw[c], colW[c]));
      const slack = autos.reduce((s, c) => s + (colW[c] - minW.get(c)!), 0);
      const k = slack > 0 ? Math.min(1, over / slack) : 0;
      for (const c of autos) colW[c] -= (colW[c] - minW.get(c)!) * k;
      fixedSum = colW.reduce((s, v) => s + v, 0);
    }
  }
  const naturalWidth = fixedSum + frCols.length * MIN_FR;
  if (frCols.length) {
    const rem = Math.max(0, avail - fixedSum);
    for (const c of frCols) colW[c] = Math.max(MIN_FR, (rem * Math.max(0.01, el.cols[c].w || 1)) / frSum);
  } else if (el.fitWidth && fixedSum > 0 && Math.abs(avail - fixedSum) > 0.01) {
    const k = avail / fixedSum;
    for (let c = 0; c < C; c++) colW[c] *= k;
  }
  const colX = [0];
  for (let c = 0; c < C; c++) colX.push(colX[c] + colW[c]);

  /* ---------------------------------------------------------------- rows */
  const innerW = (rc: ResolvedCell) => Math.max(1, colX[rc.a.c + rc.a.cs] - colX[rc.a.c] - rc.pad.l - rc.pad.r);
  const demandH = (rc: ResolvedCell): number => {
    if (rotated(rc)) return natural(rc, env).width + rc.pad.t + rc.pad.b;
    return fitted(rc, innerW(rc), env).height + rc.pad.t + rc.pad.b;
  };
  const contentMin = new Array<number>(R).fill(0);
  for (const rc of cells) if (rc.a.rs === 1) contentMin[rc.a.r] = Math.max(contentMin[rc.a.r], demandH(rc));
  const rowH = el.rows.map((row, r) => {
    if (row.mode === 'fixed') return Math.max(1, row.h);
    const h = Math.max(contentMin[r], 2);
    return row.mode === 'min' ? Math.max(h, row.h) : h;
  });
  // Merged rows: the growable rows of the span share any shortfall evenly (so a tall merged
  // group can still be dealt out over frames row by row).
  for (const rc of cells) {
    if (rc.a.rs < 2) continue;
    const need = demandH(rc);
    const have = rowH.slice(rc.a.r, rc.a.r + rc.a.rs).reduce((s, v) => s + v, 0);
    if (need <= have + 0.01) continue;
    const grow: number[] = [];
    for (let r = rc.a.r; r < rc.a.r + rc.a.rs; r++) if (el.rows[r].mode !== 'fixed') grow.push(r);
    for (const r of grow) rowH[r] += (need - have) / grow.length;
  }
  const naturalHeight = rowH.reduce((s, v) => s + v, 0);
  if (fill && naturalHeight < el.h - 0.01) {
    let grow = [...Array(R).keys()].filter((r) => rowRegion(el, r) === 'body' && el.rows[r].mode !== 'fixed');
    if (!grow.length) grow = [...Array(R).keys()].filter((r) => el.rows[r].mode !== 'fixed');
    if (grow.length) { const add = (el.h - naturalHeight) / grow.length; for (const r of grow) rowH[r] += add; }
  }

  /* ---------------------------------------------------------------- flow facts */
  const decimal = new Map<number, { pre: number; post: number }>();
  for (const rc of cells) {
    if (rc.align !== 'decimal' || rc.a.cs !== 1 || rotated(rc)) continue;
    const m = rc.fit;
    if (!m) continue;
    const d = decimal.get(rc.a.c) ?? { pre: 0, post: 0 };
    for (const ln of decimalLines(m.layout, rc.decimalChar)) { d.pre = Math.max(d.pre, ln.pre - ln.start); d.post = Math.max(d.post, ln.post); }
    decimal.set(rc.a.c, d);
  }
  const joinedAbove = new Array<boolean>(R).fill(false);
  for (const rc of cells) for (let r = rc.a.r + 1; r < rc.a.r + rc.a.rs; r++) joinedAbove[r] = true;
  const breakable = el.rows.map((row, r) => row.mode !== 'fixed' && rowRegion(el, r) === 'body' && !joinedAbove[r] && !(r + 1 < R && joinedAbove[r + 1]));
  const minPiece = new Array<number>(R).fill(0);
  for (const rc of cells) {
    if (rotated(rc)) breakable[rc.a.r] = false;
    minPiece[rc.a.r] = Math.max(minPiece[rc.a.r], rc.pad.t + rc.pad.b + rc.style.leading);
  }

  return {
    el, T, env, R, C, map, cells, byKey, byRow, colX, colW, rowH, contentMin, naturalWidth, naturalHeight, hasFr: frCols.length > 0,
    decimal, breakable, minPiece, joinedAbove,
  };
}

/* -------------------------------------------------------------------------- */
/* Pagination over frames                                                      */
/* -------------------------------------------------------------------------- */

interface DisplayRow {
  r: number;
  h: number;
  kind: 'header' | 'body' | 'footer';
  /** Piece of a broken row (-1 = the whole row), and the heights of its pieces so far. */
  piece: number;
  cuts?: number[];
}
interface Slice { rows: DisplayRow[]; overset: boolean; /** Rows too tall for a whole frame that may not break: the table stops here. */ stuck?: { r0: number; r1: number } | null }

/** Height still needed by a broken row after pieces of the given heights. */
function restHeight(M: Measure, r: number, cuts: number[]): number {
  let need = 0;
  for (const rc of M.byRow[r]) {
    if (rc.a.r !== r) continue;
    const frames = [...cuts.map((h) => Math.max(1, h - rc.pad.t - rc.pad.b)), BIG];
    const lays = setTextFrames(rc.text, rc.style, innerWOf(M, rc), frames, M.env);
    const last = lays[lays.length - 1];
    const h = last && last.baselines.length ? measureLayout(last, rc.style).height : 0;
    need = Math.max(need, h + rc.pad.t + rc.pad.b);
  }
  return Math.max(need, 2);
}

/**
 * Deal the rows out over frames of the given heights: header rows on top of each frame, footer
 * rows at its foot, body rows whole (rows joined by a merged cell travel together), a row too
 * tall for an empty frame set anyway, or broken across frames when the table allows it.
 */
function paginate(M: Measure, heights: number[]): Slice[] {
  const { el, rowH, R } = M;
  const hr = el.headerRows, fr = el.footerRows, bodyEnd = R - fr;
  const sum = (a: number, b: number) => { let t = 0; for (let r = a; r < b; r++) t += rowH[r]; return t; };
  const ftrH = sum(bodyEnd, R), hdrH = sum(0, hr);
  const repeatHeader = el.repeatHeader !== false, repeatFooter = el.repeatFooter !== false;
  const midFooter = fr > 0 && repeatFooter;
  const lastFooter = fr > 0 && (!repeatFooter || !el.skipLastFooter);
  const showHeader = (i: number) => hr > 0 && (i === 0 ? !el.skipFirstHeader : repeatHeader);
  /** Body room of frame `i` when it is still empty (−∞ when there is no such frame). */
  const freshBody = (i: number) => (heights[i] == null ? -Infinity : heights[i] - (showHeader(i) ? hdrH : 0) - (midFooter ? ftrH : 0));
  const groupEnd = (r: number) => { let e = r + 1; while (e < bodyEnd && M.joinedAbove[e]) e++; return e; };
  const slices: Slice[] = [];
  let cur = hr;
  let carry: { r: number; cuts: number[] } | null = null;
  let done = cur >= bodyEnd;
  let stuck: { r0: number; r1: number } | null = null;
  for (let i = 0; i < heights.length; i++) {
    const H = heights[i];
    const rows: DisplayRow[] = [];
    if ((done || stuck) && i > 0) { slices.push({ rows, overset: false }); continue; }
    let y = 0;
    if (showHeader(i)) for (let r = 0; r < hr; r++) { rows.push({ r, h: rowH[r], kind: 'header', piece: -1 }); y += rowH[r]; }
    const room = (final: boolean) => H - ((final ? lastFooter : midFooter) ? ftrH : 0) - y;
    let placed = 0;
    let stuckHere: { r0: number; r1: number } | null = null;
    while (!done) {
      if (carry) {
        // A row broken in the previous frame runs on.
        const r = carry.r;
        const rest = restHeight(M, r, carry.cuts);
        if (rest <= room(r === bodyEnd - 1) + 0.01) {
          rows.push({ r, h: rest, kind: 'body', piece: carry.cuts.length, cuts: [...carry.cuts] });
          y += rest; placed++; carry = null; cur = r + 1; done = cur >= bodyEnd;
          continue;
        }
        const h = room(false);
        if (h >= M.minPiece[r]) {
          carry.cuts.push(h);
          rows.push({ r, h, kind: 'body', piece: carry.cuts.length - 1, cuts: [...carry.cuts] });
          y += h; placed++;
        } else if (placed === 0) stuckHere = { r0: r, r1: r };
        break;
      }
      const g = groupEnd(cur);
      const gh = sum(cur, g);
      if (gh <= room(g >= bodyEnd) + 0.01) {
        for (let r = cur; r < g; r++) { rows.push({ r, h: rowH[r], kind: 'body', piece: -1 }); y += rowH[r]; }
        placed += g - cur; cur = g; done = cur >= bodyEnd;
        continue;
      }
      // It does not fit what is left of this frame: move it whole when a fresh frame would hold it.
      if (placed > 0 && (heights[i + 1] == null || gh <= freshBody(i + 1) + 0.01)) break;
      if (placed > 0 && !el.breakRows) break;
      // Taller than a whole frame (or this frame is still empty).
      const h = room(false);
      if (!el.breakRows) { stuckHere = { r0: cur, r1: g - 1 }; break; }
      if (g === cur + 1) {
        if (M.breakable[cur] && h >= M.minPiece[cur]) {
          carry = { r: cur, cuts: [h] };
          rows.push({ r: cur, h, kind: 'body', piece: 0, cuts: [h] });
          y += h; placed++;
        } else if (placed === 0) stuckHere = { r0: cur, r1: cur };
        break;
      }
      // Rows joined by a merged cell: as many whole rows as fit here, the rest in the next frame
      // (the merged cell's story runs on from frame to frame).
      let r = cur;
      while (r < g && rowH[r] <= room(false) + 0.01) { rows.push({ r, h: rowH[r], kind: 'body', piece: -1 }); y += rowH[r]; r++; placed++; }
      if (r === cur && placed === 0) stuckHere = { r0: cur, r1: g - 1 };
      cur = r;
      break;
    }
    if (stuckHere) stuck = stuckHere;
    if (fr > 0 && (done && !carry ? lastFooter : midFooter)) for (let r = bodyEnd; r < R; r++) rows.push({ r, h: rowH[r], kind: 'footer', piece: -1 });
    slices.push({ rows, overset: false, stuck: stuckHere });
  }
  if ((!done || carry || stuck) && slices.length) slices[slices.length - 1].overset = true;
  return slices;
}

/** Text frame heights of a split merged cell's parts (padding only at its real top and foot), and this frame's part. */
function partFrames(rc: ResolvedCell, split: number[], frameIndex: number): { inner: number[]; k: number } {
  const shown = split.map((ph, i) => ({ ph, i })).filter((q) => q.ph > 0);
  const n = shown.length;
  const inner = shown.map((q, j) => Math.max(1, q.ph - (j === 0 ? rc.pad.t : 0) - (j === n - 1 ? rc.pad.b : 0)));
  return { inner, k: shown.findIndex((q) => q.i === frameIndex) };
}

/**
 * Split merged cells whose story needs a little more room in its last part than the rows give
 * (lines do not divide exactly at a frame's foot): the part's last row grows when the frame allows.
 */
function fitMergeParts(M: Measure, slices: Slice[], heights: number[]): Map<ResolvedCell, number[]> {
  const parts = mergeParts(M, slices);
  for (const [rc, split] of parts) {
    if (rotated(rc)) continue;
    const shown = split.map((ph, i) => ({ ph, i })).filter((q) => q.ph > 0);
    const last = shown[shown.length - 1];
    const { inner } = partFrames(rc, split, last.i);
    inner[inner.length - 1] = BIG;
    const lays = setTextFrames(rc.text, rc.style, innerWOf(M, rc), inner, M.env);
    const tail = lays[lays.length - 1];
    const need = (tail && tail.baselines.length ? measureLayout(tail, rc.style).height : 0) + rc.pad.b;
    const extra = need - last.ph;
    if (extra <= 0.01) continue;
    const sl = slices[last.i];
    const used = sl.rows.reduce((h, d) => h + d.h, 0);
    if (used + extra > (heights[last.i] ?? Infinity) + 0.01) continue;
    let j = -1;
    sl.rows.forEach((d, idx) => { if (d.kind === 'body' && d.r >= rc.a.r && d.r < rc.a.r + rc.a.rs) j = idx; });
    if (j < 0) continue;
    sl.rows[j] = { ...sl.rows[j], h: sl.rows[j].h + extra };
    split[last.i] += extra;
  }
  return parts;
}

/**
 * Merged cells whose rows were dealt out over several frames: the height of the cell's part in
 * each frame (0 where it does not appear). Their stories run on from part to part.
 */
function mergeParts(M: Measure, slices: Slice[]): Map<ResolvedCell, number[]> {
  const out = new Map<ResolvedCell, number[]>();
  const merged = M.cells.filter((rc) => rc.a.rs >= 2);
  if (!merged.length) return out;
  // Where each body row is shown: (frame, height) pairs — one pass over the slices, not one per merged cell.
  const shown: [number, number][][] = Array.from({ length: M.R }, () => []);
  slices.forEach((sl, i) => { for (const d of sl.rows) if (d.kind === 'body') shown[d.r].push([i, d.h]); });
  for (const rc of merged) {
    const parts = new Array<number>(slices.length).fill(0);
    for (let r = rc.a.r; r < rc.a.r + rc.a.rs; r++) for (const [i, h] of shown[r]) parts[i] += h;
    if (parts.filter((h) => h > 0).length > 1) out.set(rc, parts);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* One frame's slice → primitives                                              */
/* -------------------------------------------------------------------------- */

function renderSlice(M: Measure, slice: Slice, frameIndex: number, frameCount: number, parts: Map<ResolvedCell, number[]>): TableLayout {
  const { C, colX, byKey, env } = M;
  const rows = slice.rows;
  const N = rows.length;
  const rowY = [0];
  for (const d of rows) rowY.push(rowY[rowY.length - 1] + d.h);
  const disp = new Map<number, number>();
  rows.forEach((d, i) => disp.set(d.r, i));
  // Only the cells on this frame's rows (in table order): visiting every cell of the table in
  // every frame made a long thread cost rows × frames.
  const seen = new Set<ResolvedCell>();
  const cells: ResolvedCell[] = [];
  for (const d of rows) for (const rc of M.byRow[d.r]) if (!seen.has(rc)) { seen.add(rc); cells.push(rc); }
  cells.sort((p, q) => (p.a.r - q.a.r) || (p.a.c - q.a.c));

  const boxes: CellBox[] = [];
  const textRuns: TextRun[] = [];
  const groups: Prim[] = [];
  const decimalCells: { rc: ResolvedCell; lines: DecimalLine[]; runs: TextRun[]; x0: number; inner: number }[] = [];
  const placeRuns = (rc: ResolvedCell, layout: FrameLayout, x0: number, y0: number, iw: number) => {
    const runs = runsOf(layout.prims).map((run) => ({ ...run, x: run.x + x0, y: run.y + y0 }));
    if (rc.align === 'decimal' && rc.a.cs === 1) {
      const lines = decimalLines(layout, rc.decimalChar).map((ln) => ({ ...ln, y: ln.y + y0, pre: ln.pre + x0, start: ln.start + x0 }));
      decimalCells.push({ rc, lines, runs, x0, inner: iw });
    }
    textRuns.push(...runs);
    for (const p of layout.prims) if (p.t !== 'text') groups.push({ t: 'group', matrix: [1, 0, 0, 1, x0, y0], children: [p] });
  };

  for (const rc of cells) {
    const { r, c, cs } = rc.a;
    let d0 = -1, d1 = -1;
    for (let rr = r; rr < r + rc.a.rs; rr++) {
      const d = disp.get(rr);
      if (d == null) continue;
      if (d0 < 0 || d < d0) d0 = d;
      if (d > d1) d1 = d;
    }
    if (d0 < 0) continue;
    const ghost = rows[d0].r !== r;
    const piece = rows[d0].piece;
    const x = colX[c], y = rowY[d0], w = colX[c + cs] - x, h = rowY[d1 + 1] - y;
    const box: CellBox = { r, c, rs: d1 - d0 + 1, cs, x, y, w, h, overflow: false };
    if (ghost) box.ghost = true;
    boxes.push(box);
    const iw = Math.max(1, w - rc.pad.l - rc.pad.r), ih = Math.max(1, h - rc.pad.t - rc.pad.b);
    const x0 = x + rc.pad.l, y0 = y + rc.pad.t;
    const split = parts.get(rc);
    if (split && !rotated(rc)) {
      // A merged cell dealt over several frames: its story runs on through its parts.
      const { inner, k } = partFrames(rc, split, frameIndex);
      if (k >= 0) {
        const lays = setTextFrames(rc.text, rc.style, iw, inner, env);
        if (lays[k]) placeRuns(rc, lays[k], x0, k === 0 ? y0 : y, iw);
        if (k === inner.length - 1) box.overflow = !!lays[k]?.overflow;
      }
      continue;
    }
    if (ghost) continue;
    if (piece >= 0) {
      // A piece of a row broken across frames: the story runs on from piece to piece.
      const cuts = rows[d0].cuts ?? [h];
      const lays = setTextFrames(rc.text, rc.style, iw, [...cuts.map((ch) => Math.max(1, ch - rc.pad.t - rc.pad.b)), BIG], env);
      if (lays[piece]) placeRuns(rc, lays[piece], x0, y0, iw);
      continue;
    }
    if (!rotated(rc)) {
      let m = rc.fit ?? fitted(rc, iw, env);
      let dy = 0;
      if (m.height <= ih + 0.5) {
        const slack = Math.max(0, ih - m.height);
        dy = rc.valign === 'middle' ? slack / 2 : rc.valign === 'bottom' ? slack : 0;
      } else {
        m = setText(rc.text, rc.style, iw, ih, 'top', env);
        box.overflow = m.layout.overflow;
      }
      if (rc.rotation === 180) {
        // Upside down: set in place, then turned about the inner box.
        const flip: Matrix = [-1, 0, 0, -1, x0 + iw, y0 + ih];
        groups.push({ t: 'group', matrix: flip, children: shiftPrims(m.layout.prims, 0, ih - m.height - dy) });
      } else placeRuns(rc, m.layout, x0, y0 + dy, iw);
    } else {
      // Turned text runs along the cell's height: the frame is turned a quarter.
      const m = setText(rc.text, rc.style, ih, iw, rc.valign, env);
      box.overflow = m.layout.overflow;
      const mat: Matrix = rc.rotation === 90 ? [0, -1, 1, 0, x0, y0 + ih] : [0, 1, -1, 0, x0 + iw, y0];
      groups.push({ t: 'group', matrix: mat, children: m.layout.prims });
    }
  }

  // Decimal alignment: one decimal position per column, the same in every frame.
  for (const d of decimalCells) {
    const col = M.decimal.get(d.rc.a.c);
    let pre = col?.pre ?? 0, post = col?.post ?? 0;
    for (const ln of d.lines) { pre = Math.max(pre, ln.pre - ln.start); post = Math.max(post, ln.post); }
    const target = d.x0 + Math.max(0, (d.inner - (pre + post)) / 2) + pre;
    for (const ln of d.lines) {
      const shift = target - ln.pre;
      for (const run of d.runs) if (Math.abs(run.y - ln.y) < run.size * 0.5) run.x += shift;
    }
  }

  const prims: Prim[] = [];
  const fills = new Map<string, string[]>();
  for (const b of boxes) {
    const rc = byKey.get(b.r * C + b.c)!;
    if (!rc.fill) continue;
    const list = fills.get(rc.fill) ?? [];
    list.push(rectPath(b.x, b.y, b.w, b.h));
    fills.set(rc.fill, list);
  }
  for (const [color, ds] of fills) prims.push({ t: 'path', d: ds.join(''), fill: color });

  // Diagonals sit behind the text.
  for (const b of boxes) {
    const rc = byKey.get(b.r * C + b.c)!;
    const st = rc.diagonalStroke;
    if (rc.diagonal === 'none' || !st || st.w <= 0 || b.ghost) continue;
    let d = '';
    if (rc.diagonal === 'down' || rc.diagonal === 'cross') d += `M${b.x} ${b.y}L${b.x + b.w} ${b.y + b.h}`;
    if (rc.diagonal === 'up' || rc.diagonal === 'cross') d += `M${b.x} ${b.y + b.h}L${b.x + b.w} ${b.y}`;
    prims.push({ t: 'path', d, fill: null, stroke: st.color, strokeWidth: st.w, dash: strokeDash(st), cap: ruleStyleOf(st) === 'dotted' ? 'round' : 'butt' });
  }

  prims.push(...strokePrims(M, rows, rowY));
  if (textRuns.length) prims.push({ t: 'text', runs: textRuns });
  prims.push(...groups);

  return {
    colX, colW: M.colW, rowY, rowMap: rows.map((d) => d.r), rowPiece: rows.map((d) => d.piece), rowH: M.rowH, contentMin: M.contentMin,
    width: colX[C], height: rowY[N], naturalWidth: M.naturalWidth, naturalHeight: M.naturalHeight, hasFr: M.hasFr,
    overset: slice.overset, stuck: slice.stuck ?? null, frameIndex, frameCount, cells: boxes, prims,
  };
}

function shiftPrims(prims: Prim[], dx: number, dy: number): Prim[] {
  if (!dx && !dy) return prims;
  return [{ t: 'group', matrix: [1, 0, 0, 1, dx, dy], children: prims } as GroupPrim];
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

/** The lines a rule is drawn with: offset across the rule from its centre line, and weight. */
interface SubLine { o: number; w: number }

function subLines(s: TableStroke): SubLine[] {
  const k = ruleStyleOf(s);
  if (k === 'double') {
    const lw = s.w / 2, off = (gapOf(s) + lw) / 2;
    return [{ o: -off, w: lw }, { o: off, w: lw }];
  }
  if (k === 'thick-thin' || k === 'thin-thick') {
    const thick = (s.w * 2) / 3, thin = s.w / 3, total = s.w + gapOf(s);
    const a = k === 'thick-thin' ? thick : thin, b = k === 'thick-thin' ? thin : thick;
    return [{ o: -total / 2 + a / 2, w: a }, { o: total / 2 - b / 2, w: b }];
  }
  return [{ o: 0, w: s.w }];
}

/** Dash pattern for dotted / dashed rules (a plain dash array is kept for older rules). */
function strokeDash(s: TableStroke): number[] | undefined {
  if (!s.style && s.dash.length) return s.dash;
  const k = ruleStyleOf(s);
  if (k === 'dotted') return [0.01, Math.max(1.2, s.w * 2.2)];
  if (k === 'dashed') return [Math.max(2, s.w * 3), Math.max(1.5, s.w * 2)];
  return s.dash.length && k === 'solid' ? s.dash : undefined;
}

const heaviest = (...ss: (TableStroke | undefined | null)[]): TableStroke | undefined => {
  let best: TableStroke | undefined;
  for (const s of ss) if (s && (!best || ruleExtent(s) > ruleExtent(best))) best = s;
  return best;
};

const strokeKey = (s: TableStroke) => `${s.w}|${s.color}|${s.dash.join(',')}|${s.style ?? ''}|${s.gap ?? ''}`;

/**
 * Where one line of a rule ends at a junction (offset from the grid line along the rule):
 * through a single crossing rule; at a corner of two-line rules the inner lines meet the inner
 * line and the outer lines the outer one, so double borders nest; at a T it stops on the near line.
 */
function endAt(sub: SubLine, d: 1 | -1, before: TableStroke | null, after: TableStroke | null): number {
  const P = heaviest(before, after);
  if (!P) return 0;
  const ps = subLines(P);
  if (ps.length === 1) return (-d * P.w) / 2;
  const inner = ps.reduce((a, b) => (b.o * d > a.o * d ? b : a));
  const outer = ps.reduce((a, b) => (b.o * d < a.o * d ? b : a));
  const sgn = (after ? 1 : 0) - (before ? 1 : 0);
  const q = sgn === 0 || (sub.o !== 0 && Math.sign(sub.o) === sgn) ? inner : outer;
  return q.o - (d * q.w) / 2;
}

function strokePrims(M: Measure, rows: DisplayRow[], rowY: number[]): Prim[] {
  const { el, T, map, byKey, colX, C } = M;
  const N = rows.length;
  if (!N) return [];
  const owner = (d: number, c: number) => (d >= 0 && d < N && c >= 0 && c < C ? map[rows[d].r * C + c] : -1);
  const cellOf = (k: number) => (k >= 0 ? byKey.get(k) : undefined);

  const hRule = (b: number): TableStroke | null => {
    if (b === 0) return T.borderTop;
    if (b === N) return T.borderBottom;
    const a = rows[b - 1], z = rows[b];
    if (a.kind === 'header' && z.kind !== 'header') return T.headerRule;
    if (z.kind === 'footer' && a.kind !== 'footer') return T.footerRule;
    if (a.kind !== 'body' || z.kind !== 'body') return T.rowRule;
    const every = Math.max(1, Math.round(T.rowRuleEvery || 1));
    return (z.r - el.headerRows) % every === 0 ? T.rowRule : null;
  };
  const vRule = (b: number): TableStroke | null => {
    if (b === 0) return T.borderLeft;
    if (b === C) return T.borderRight;
    if (T.stub && b === 1) return T.stubRule ?? T.colRule;
    return T.colRule;
  };

  // Resolve every grid segment first, so rules can meet cleanly at their ends.
  const H: (TableStroke | null)[][] = [];
  for (let b = 0; b <= N; b++) {
    const row: (TableStroke | null)[] = [];
    for (let c = 0; c < C; c++) {
      const above = owner(b - 1, c), below = owner(b, c);
      if (above !== -1 && above === below) { row.push(null); continue; }
      const ov = heaviest(cellOf(above)?.edges.bottom, cellOf(below)?.edges.top);
      const s = ov ?? hRule(b);
      row.push(s && s.w > 0 ? s : null);
    }
    H.push(row);
  }
  const V: (TableStroke | null)[][] = [];
  for (let b = 0; b <= C; b++) {
    const col: (TableStroke | null)[] = [];
    for (let d = 0; d < N; d++) {
      const left = owner(d, b - 1), right = owner(d, b);
      if (left !== -1 && left === right) { col.push(null); continue; }
      const ov = heaviest(cellOf(left)?.edges.right, cellOf(right)?.edges.left);
      const s = ov ?? vRule(b);
      col.push(s && s.w > 0 ? s : null);
    }
    V.push(col);
  }
  const vSeg = (b: number, d: number) => (b >= 0 && b <= C && d >= 0 && d < N ? V[b][d] : null);
  const hSeg = (b: number, c: number) => (b >= 0 && b <= N && c >= 0 && c < C ? H[b][c] : null);

  const paths = new Map<string, { color: string; w: number; dash?: number[]; cap: 'butt' | 'round'; d: string[] }>();
  const add = (s: TableStroke, w: number, d: string) => {
    const dash = strokeDash(s);
    const k = `${s.color}|${w}|${dash?.join(',') ?? ''}`;
    const e = paths.get(k) ?? { color: s.color, w, dash, cap: ruleStyleOf(s) === 'dotted' ? 'round' as const : 'butt' as const, d: [] };
    e.d.push(d);
    paths.set(k, e);
  };
  const f = (v: number) => +v.toFixed(3);
  for (let b = 0; b <= N; b++) {
    let c = 0;
    while (c < C) {
      const s = H[b][c];
      if (!s) { c++; continue; }
      const k = strokeKey(s);
      let e = c + 1;
      while (e < C && H[b][e] && strokeKey(H[b][e]!) === k) e++;
      for (const sub of subLines(s)) {
        const x0 = colX[c] + endAt(sub, 1, vSeg(c, b - 1), vSeg(c, b));
        const x1 = colX[e] + endAt(sub, -1, vSeg(e, b - 1), vSeg(e, b));
        add(s, sub.w, `M${f(x0)} ${f(rowY[b] + sub.o)}H${f(x1)}`);
      }
      c = e;
    }
  }
  for (let b = 0; b <= C; b++) {
    let d = 0;
    while (d < N) {
      const s = V[b][d];
      if (!s) { d++; continue; }
      const k = strokeKey(s);
      let e = d + 1;
      while (e < N && V[b][e] && strokeKey(V[b][e]!) === k) e++;
      for (const sub of subLines(s)) {
        const y0 = rowY[d] + endAt(sub, 1, hSeg(d, b - 1), hSeg(d, b));
        const y1 = rowY[e] + endAt(sub, -1, hSeg(e, b - 1), hSeg(e, b));
        add(s, sub.w, `M${f(colX[b] + sub.o)} ${f(y0)}V${f(y1)}`);
      }
      d = e;
    }
  }
  return [...paths.values()].map((p) => ({ t: 'path' as const, d: p.d.join(''), fill: null, stroke: p.color, strokeWidth: p.w, dash: p.dash, cap: p.cap }));
}
