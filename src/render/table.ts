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
 */
import type { Project, TextStyle } from '../model/types';
import type {
  TableElement, TableStyleProps, CellStyleProps, CellAlign, CellVAlign, CellRotation, CellDiagonal, TableStroke, CellEdges, Anchor,
} from '../model/table';
import { BASE_CELL, coverMap, anchorsOf, findCellStyle, mergeCellProps, resolveTableStyle, rowRegion, figureFeatures, ruleStyleOf, ruleExtent, gapOf } from '../model/table';
import type { GroupPrim, Matrix, Prim, TextRun } from './primitives';
import { rectPath } from './primitives';
import { layoutStory, applyParagraphStyle, type FrameLayout, type FrameSpec, type StoryStyles, type TokenContext } from '../engine/textLayout';
import { ensureFamily, fontMetrics, measure, resolveFont, useFontStore } from '../engine/fonts';

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

const singleCache = new WeakMap<TableElement, { key: string; layout: TableLayout }>();
const threadCache = new WeakMap<TableElement, { key: string; layouts: TableLayout[] }>();

export function layoutTable(el: TableElement, ctx: TableContext): TableLayout {
  const th = tableThreadOf(ctx.project, el.id);
  if (th && th.frames.length > 1 && th.frames[th.index].el === el) {
    const head = th.head;
    const hctx: TableContext = { project: ctx.project, pageIndex: th.frames[0].pageIndex };
    const key = `${tableContextKey(hctx)}|${th.frames.map((f) => idOf(f.el)).join(',')}`;
    const hit = threadCache.get(head);
    if (hit && hit.key === key) return hit.layouts[th.index];
    let layouts: TableLayout[];
    try {
      layouts = computeThread(head, th.frames.map((f) => f.el), hctx);
    } catch (err) {
      console.error('Table layout failed', err);
      layouts = th.frames.map((f) => emptyLayout(f.el));
    }
    threadCache.set(head, { key, layouts });
    return layouts[th.index];
  }
  const key = tableContextKey(ctx);
  const hit = singleCache.get(el);
  if (hit && hit.key === key) return hit.layout;
  let layout: TableLayout;
  try {
    layout = computeSingle(el, ctx);
  } catch (err) {
    console.error('Table layout failed', err);
    layout = emptyLayout(el);
  }
  singleCache.set(el, { key, layout });
  return layout;
}

export function compileTable(el: TableElement, ctx: TableContext): Prim[] {
  return layoutTable(el, ctx).prims;
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

interface ResolvedCell {
  a: Anchor;
  text: string;
  style: TextStyle;
  /** Measurement style: ragged left, no hyphenation (natural widths). */
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
  const ps = el.paraStyle ? project.paragraphStyles?.find((d) => d.id === el.paraStyle)?.props : null;
  if (ps) s = applyParagraphStyle(s, ps);
  s.firstLineIndent = 0;
  return s;
}

function applyCellText(base: TextStyle, P: CellStyleProps, project: Project): TextStyle {
  let s: TextStyle = { ...base, features: { ...base.features } };
  const ps = P.paraStyle ? project.paragraphStyles?.find((d) => d.id === P.paraStyle)?.props : null;
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

function resolveCell(el: TableElement, T: TableStyleProps, project: Project, base: TextStyle, a: Anchor): ResolvedCell {
  const P = cellProps(el, project, a.r, a.c, T);
  const style = applyCellText(base, P, project);
  requestFamily(style.fontFamily);
  const cs = P.charStyle ? project.characterStyles?.find((d) => d.id === P.charStyle) : null;
  requestFamily(cs?.props.fontFamily);
  const raw = el.cells[a.r]?.[a.c]?.text ?? '';
  const text = cs && raw.trim() ? wrapCharStyle(raw, cs.name) : raw;
  return {
    a,
    text,
    style,
    natStyle: { ...style, align: 'left', hyphenate: false },
    align: P.align ?? (style.align === 'justify-all' ? 'justify' : style.align),
    decimalChar: P.decimalChar || BASE_CELL.decimalChar,
    valign: P.valign ?? BASE_CELL.valign,
    pad: { t: P.padTop ?? BASE_CELL.padTop, r: P.padRight ?? BASE_CELL.padRight, b: P.padBottom ?? BASE_CELL.padBottom, l: P.padLeft ?? BASE_CELL.padLeft },
    fill: P.fill !== undefined ? P.fill : regionFill(el, T, a.r, a.c),
    rotation: P.rotation ?? 0,
    diagonal: P.diagonal ?? 'none',
    diagonalStroke: P.diagonalStroke ?? BASE_CELL.diagonalStroke,
    edges: P.edges ?? {},
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
}

const frameOf = (w: number, h: number, valign: CellVAlign = 'top'): FrameSpec =>
  ({ w: Math.max(1, w), h: Math.max(1, h), columns: 1, columnGap: 0, inset: 0, verticalAlign: valign, grid: null });

function runsOf(prims: Prim[]): TextRun[] {
  const out: TextRun[] = [];
  for (const p of prims) if (p.t === 'text') out.push(...p.runs);
  return out;
}

const cellCache = new Map<string, Measured>();

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
  return { layout, width, height };
}

/** Set a cell's story in a w × h frame (memoised). */
function setText(text: string, style: TextStyle, w: number, h: number, valign: CellVAlign, env: Env): Measured {
  const key = `${env.key}|${Math.round(w * 100)}|${Math.round(h * 100)}|${valign}|${JSON.stringify(style)}|${text}`;
  const hit = cellCache.get(key);
  if (hit) return hit;
  const [layout] = layoutStory(text, style, [frameOf(w, h, valign)], env.tokens, env.styles);
  const m = measureLayout(layout, style);
  if (cellCache.size > 4000) cellCache.clear();
  cellCache.set(key, m);
  return m;
}

/** Set a cell's story through several frames of one width (a row broken across table frames). */
const framesCache = new Map<string, FrameLayout[]>();
function setTextFrames(text: string, style: TextStyle, w: number, heights: number[], env: Env): FrameLayout[] {
  const key = `${env.key}|${Math.round(w * 100)}|${heights.map((h) => Math.round(h * 100)).join(',')}|${JSON.stringify(style)}|${text}`;
  const hit = framesCache.get(key);
  if (hit) return hit;
  const lays = layoutStory(text, style, heights.map((h) => frameOf(w, h, 'top')), env.tokens, env.styles);
  if (framesCache.size > 1000) framesCache.clear();
  framesCache.set(key, lays);
  return lays;
}

/** Width of the longest word (the narrowest a column can get without breaking words). */
function minContent(rc: ResolvedCell, env: Env): number {
  return setText(rc.text.replace(/[ \t]+/g, '\n'), rc.natStyle, BIG, BIG, 'top', env).width;
}

/** Advance from the start of a run to before UTF-16 index `idx`. */
function advanceTo(run: TextRun, idx: number): number {
  if (idx <= 0) return 0;
  const sub = run.text.slice(0, idx);
  let k = 0;
  if (run.kern) for (let i = 0; i < idx && i < run.kern.length; i++) k += run.kern[i];
  return measure(sub, run.font, run.size) + (run.letterSpacing ?? 0) * [...sub].length + k;
}

interface DecimalLine { y: number; pre: number; post: number; start: number }

/** Where each line's decimal marker sits (or where it would, after the last digit). */
function decimalLines(layout: FrameLayout, ch: string): DecimalLine[] {
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

interface Env { tokens: TokenContext; styles: StoryStyles | null; key: string }

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
  colX: number[];
  colW: number[];
  rowH: number[];
  contentMin: number[];
  naturalWidth: number;
  naturalHeight: number;
  hasFr: boolean;
  fitted: Map<ResolvedCell, Measured>;
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
  const para = project.paragraphStyles ?? [], char = project.characterStyles ?? [];
  for (const d of para) requestFamily(d.props.fontFamily);
  const tokens = tokensFor(project, ctx.pageIndex);
  const env: Env = {
    tokens,
    styles: para.length || char.length ? { para, char } : null,
    key: `${useFontStore.getState().version}|${idOf(project.paragraphStyles)}|${idOf(project.characterStyles)}|${JSON.stringify(tokens)}`,
  };
  const base = cellBase(el, project);
  const map = coverMap(el);
  const anchors = anchorsOf(el, map);
  const cells = anchors.map((a) => resolveCell(el, T, project, base, a));
  const byKey = new Map<number, ResolvedCell>();
  for (const rc of cells) byKey.set(rc.a.r * C + rc.a.c, rc);

  /* ---------------------------------------------------------------- columns */
  const natural = new Map<ResolvedCell, Measured>();
  const nat = (rc: ResolvedCell) => {
    let m = natural.get(rc);
    if (!m) { m = setText(rc.text, rc.natStyle, BIG, BIG, 'top', env); natural.set(rc, m); }
    return m;
  };
  const autoDemand = new Array<number>(C).fill(0);
  const decimalDemand = new Map<number, { pre: number; post: number; pad: number }>();
  for (const rc of cells) {
    const col = el.cols[rc.a.c];
    if (col.mode !== 'auto' || rc.a.cs !== 1) continue;
    const m = nat(rc);
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
    const m = nat(rc);
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
      const minW = new Map<number, number>();
      for (const c of autos) {
        let mw = MIN_COL;
        for (const rc of cells) if (rc.a.c === c && rc.a.cs === 1 && !rotated(rc)) mw = Math.max(mw, minContent(rc, env) + rc.pad.l + rc.pad.r);
        if (decimalDemand.has(c)) mw = Math.max(mw, autoDemand[c]);
        minW.set(c, Math.min(mw, colW[c]));
      }
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
  const fitted = new Map<ResolvedCell, Measured>();
  const innerW = (rc: ResolvedCell) => Math.max(1, colX[rc.a.c + rc.a.cs] - colX[rc.a.c] - rc.pad.l - rc.pad.r);
  const demandH = (rc: ResolvedCell): number => {
    if (rotated(rc)) return nat(rc).width + rc.pad.t + rc.pad.b;
    let m = fitted.get(rc);
    if (!m) { m = setText(rc.text, rc.style, innerW(rc), BIG, 'top', env); fitted.set(rc, m); }
    return m.height + rc.pad.t + rc.pad.b;
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
    const m = fitted.get(rc);
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
    el, T, env, R, C, map, cells, byKey, colX, colW, rowH, contentMin, naturalWidth, naturalHeight, hasFr: frCols.length > 0,
    fitted, decimal, breakable, minPiece, joinedAbove,
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
  for (const rc of M.cells) {
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
  for (const rc of M.cells) {
    if (rc.a.rs < 2) continue;
    const parts = slices.map((sl) => sl.rows.reduce((h, d) => h + (d.kind === 'body' && d.r >= rc.a.r && d.r < rc.a.r + rc.a.rs ? d.h : 0), 0));
    if (parts.filter((h) => h > 0).length > 1) out.set(rc, parts);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* One frame's slice → primitives                                              */
/* -------------------------------------------------------------------------- */

function renderSlice(M: Measure, slice: Slice, frameIndex: number, frameCount: number, parts: Map<ResolvedCell, number[]>): TableLayout {
  const { C, colX, cells, byKey, env } = M;
  const rows = slice.rows;
  const N = rows.length;
  const rowY = [0];
  for (const d of rows) rowY.push(rowY[rowY.length - 1] + d.h);
  const disp = new Map<number, number>();
  rows.forEach((d, i) => disp.set(d.r, i));

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
      let m = M.fitted.get(rc) ?? setText(rc.text, rc.style, iw, BIG, 'top', env);
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
