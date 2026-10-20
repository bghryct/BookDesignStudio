/**
 * Table layout: sizes columns and rows from their content, sets every cell's story with the
 * text engine (so cells get the same Knuth–Plass justification, hyphenation, kerning, small caps
 * and story markup as a text frame), aligns figures on the decimal, and compiles fills, rules,
 * diagonals and text to display-list primitives — which the editor, SVG, PDF, thumbnails and the
 * 3D book all draw.
 */
import type { Project, TextStyle } from '../model/types';
import type {
  TableElement, TableStyleProps, CellStyleProps, CellAlign, CellVAlign, CellRotation, CellDiagonal, TableStroke, CellEdges, Anchor,
} from '../model/table';
import { BASE_CELL, coverMap, anchorsOf, findCellStyle, mergeCellProps, resolveTableStyle, rowRegion, figureFeatures } from '../model/table';
import type { GroupPrim, Matrix, Prim, TextRun } from './primitives';
import { rectPath } from './primitives';
import { layoutStory, applyParagraphStyle, type FrameLayout, type FrameSpec, type StoryStyles, type TokenContext } from '../engine/textLayout';
import { ensureFamily, fontMetrics, measure, resolveFont, useFontStore } from '../engine/fonts';

export interface TableContext { project: Project; pageIndex: number | null }

/** A cell as laid out (anchor cells only), table-local pt. */
export interface CellBox {
  r: number; c: number; rs: number; cs: number;
  x: number; y: number; w: number; h: number;
  /** Text did not fit (fixed or clipped rows). */
  overflow: boolean;
}

export interface TableLayout {
  colX: number[];
  rowY: number[];
  colW: number[];
  rowH: number[];
  width: number;
  height: number;
  /** Width the columns want without fitting the frame (auto + fixed + minimal fr). */
  naturalWidth: number;
  /** Height before body rows are stretched to fill the frame. */
  naturalHeight: number;
  /** Per row: the least height its content needs. */
  contentMin: number[];
  hasFr: boolean;
  /** Rows drawn (the rest are overset when the frame is fixed and too short). */
  visibleRows: number;
  overset: boolean;
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

/** Everything outside the element that a table's appearance depends on. */
export function tableContextKey(ctx: TableContext, fontVersion = useFontStore.getState().version): string {
  const p = ctx.project;
  return `${fontVersion}|${idOf(p.paragraphStyles)}|${idOf(p.characterStyles)}|${idOf(p.tableStyles)}|${idOf(p.cellStyles)}|${idOf(p.book)}|${ctx.pageIndex ?? '-'}|${p.pages.length}`;
}

const layoutCache = new WeakMap<TableElement, { key: string; layout: TableLayout }>();

export function layoutTable(el: TableElement, ctx: TableContext): TableLayout {
  const key = tableContextKey(ctx);
  const hit = layoutCache.get(el);
  if (hit && hit.key === key) return hit.layout;
  let layout: TableLayout;
  try {
    layout = computeLayout(el, ctx);
  } catch (err) {
    console.error('Table layout failed', err);
    layout = emptyLayout(el);
  }
  layoutCache.set(el, { key, layout });
  return layout;
}

export function compileTable(el: TableElement, ctx: TableContext): Prim[] {
  return layoutTable(el, ctx).prims;
}

function emptyLayout(el: TableElement): TableLayout {
  return {
    colX: [0, el.w], rowY: [0, el.h], colW: [el.w], rowH: [el.h], width: el.w, height: el.h, naturalWidth: el.w, naturalHeight: el.h,
    contentMin: [el.h], hasFr: true, visibleRows: 0, overset: false, cells: [],
    prims: [{ t: 'path', d: rectPath(0, 0, el.w, el.h), stroke: '#e5483a', strokeWidth: 0.5, dash: [3, 3] }],
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

function computeLayout(el: TableElement, ctx: TableContext): TableLayout {
  const project = ctx.project;
  const R = el.rows.length, C = el.cols.length;
  if (!R || !C) return emptyLayout(el);
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
  const rotated = (rc: ResolvedCell) => rc.rotation === 90 || rc.rotation === 270;

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
    if (col.mode !== 'auto') continue;
    if (rc.a.cs === 1) {
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
  }
  for (const [c, d] of decimalDemand) autoDemand[c] = Math.max(autoDemand[c], d.pre + d.post + d.pad);
  // A merged cell across auto columns widens them evenly.
  for (const rc of cells) {
    if (rc.a.cs < 2) continue;
    const span = el.cols.slice(rc.a.c, rc.a.c + rc.a.cs);
    if (!span.every((col) => col.mode === 'auto')) continue;
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
  // Merged rows: the last growable row of the span takes up any shortfall.
  for (const rc of cells) {
    if (rc.a.rs < 2) continue;
    const need = demandH(rc);
    const have = rowH.slice(rc.a.r, rc.a.r + rc.a.rs).reduce((s, v) => s + v, 0);
    if (need <= have + 0.01) continue;
    let target = -1;
    for (let r = rc.a.r + rc.a.rs - 1; r >= rc.a.r; r--) if (el.rows[r].mode !== 'fixed') { target = r; break; }
    if (target >= 0) rowH[target] += need - have;
  }
  const naturalHeight = rowH.reduce((s, v) => s + v, 0);
  if (el.fillHeight && naturalHeight < el.h - 0.01) {
    let grow = [...Array(R).keys()].filter((r) => rowRegion(el, r) === 'body' && el.rows[r].mode !== 'fixed');
    if (!grow.length) grow = [...Array(R).keys()].filter((r) => el.rows[r].mode !== 'fixed');
    if (grow.length) { const add = (el.h - naturalHeight) / grow.length; for (const r of grow) rowH[r] += add; }
  }
  const rowY = [0];
  for (let r = 0; r < R; r++) rowY.push(rowY[r] + rowH[r]);

  // Overset: a fixed-height frame shows the rows that fit (always at least one).
  let visibleRows = R;
  if (!el.autoHeight) {
    visibleRows = 1;
    while (visibleRows < R && rowY[visibleRows + 1] <= el.h + 0.5) visibleRows++;
  }

  /* ---------------------------------------------------------------- cells */
  const boxes: CellBox[] = [];
  const textRuns: TextRun[] = [];
  const groups: Prim[] = [];
  const decimalCells: { rc: ResolvedCell; lines: DecimalLine[]; runs: TextRun[]; x0: number; inner: number }[] = [];
  for (const rc of cells) {
    const { r, c, cs } = rc.a;
    if (r >= visibleRows) continue;
    const rs = Math.min(rc.a.rs, visibleRows - r);
    const x = colX[c], y = rowY[r], w = colX[c + cs] - x, h = rowY[r + rs] - y;
    const iw = Math.max(1, w - rc.pad.l - rc.pad.r), ih = Math.max(1, h - rc.pad.t - rc.pad.b);
    const x0 = x + rc.pad.l, y0 = y + rc.pad.t;
    let overflow = false;
    if (!rotated(rc)) {
      let m = fitted.get(rc) ?? setText(rc.text, rc.style, iw, BIG, 'top', env);
      let dy = 0;
      if (m.height <= ih + 0.5) {
        const slack = Math.max(0, ih - m.height);
        dy = rc.valign === 'middle' ? slack / 2 : rc.valign === 'bottom' ? slack : 0;
      } else {
        m = setText(rc.text, rc.style, iw, ih, 'top', env);
        overflow = m.layout.overflow;
      }
      if (rc.rotation === 180) {
        // Upside down: set in place, then turned about the inner box.
        const flip: Matrix = [-1, 0, 0, -1, x0 + iw, y0 + ih];
        groups.push({ t: 'group', matrix: flip, children: shiftPrims(m.layout.prims, 0, ih - m.height - dy) });
      } else {
        const runs = runsOf(m.layout.prims).map((run) => ({ ...run, x: run.x + x0, y: run.y + y0 + dy }));
        if (rc.align === 'decimal' && cs === 1) {
          const lines = decimalLines(m.layout, rc.decimalChar).map((ln) => ({ ...ln, y: ln.y + y0 + dy, pre: ln.pre + x0, start: ln.start + x0 }));
          decimalCells.push({ rc, lines, runs, x0, inner: iw });
        }
        textRuns.push(...runs);
        for (const p of m.layout.prims) if (p.t !== 'text') groups.push({ t: 'group', matrix: [1, 0, 0, 1, x0, y0 + dy], children: [p] });
      }
    } else {
      // Rotated text runs along the cell's height: the frame is turned a quarter.
      const len = ih, across = iw;
      const m = setText(rc.text, rc.style, len, across, rc.valign, env);
      overflow = m.layout.overflow;
      const mat: Matrix = rc.rotation === 90 ? [0, -1, 1, 0, x0, y0 + ih] : [0, 1, -1, 0, x0 + iw, y0];
      groups.push({ t: 'group', matrix: mat, children: m.layout.prims });
    }
    boxes.push({ r, c, rs, cs, x, y, w, h, overflow });
  }

  // Decimal alignment: every decimal cell of a column shares one decimal position.
  const byCol = new Map<number, typeof decimalCells>();
  for (const d of decimalCells) { const list = byCol.get(d.rc.a.c) ?? []; list.push(d); byCol.set(d.rc.a.c, list); }
  for (const list of byCol.values()) {
    let maxPre = 0, maxPost = 0;
    for (const d of list) for (const ln of d.lines) { maxPre = Math.max(maxPre, ln.pre - ln.start); maxPost = Math.max(maxPost, ln.post); }
    for (const d of list) {
      const target = d.x0 + Math.max(0, (d.inner - (maxPre + maxPost)) / 2) + maxPre;
      for (const ln of d.lines) {
        const shift = target - ln.pre;
        for (const run of d.runs) if (Math.abs(run.y - ln.y) < run.size * 0.5) run.x += shift;
      }
    }
  }

  /* ---------------------------------------------------------------- prims */
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
    if (rc.diagonal === 'none' || !st || st.w <= 0) continue;
    let d = '';
    if (rc.diagonal === 'down' || rc.diagonal === 'cross') d += `M${b.x} ${b.y}L${b.x + b.w} ${b.y + b.h}`;
    if (rc.diagonal === 'up' || rc.diagonal === 'cross') d += `M${b.x} ${b.y + b.h}L${b.x + b.w} ${b.y}`;
    prims.push({ t: 'path', d, fill: null, stroke: st.color, strokeWidth: st.w, dash: st.dash.length ? st.dash : undefined, cap: dotted(st) ? 'round' : 'butt' });
  }

  prims.push(...strokePrims(el, T, map, byKey, colX, rowY, visibleRows));
  if (textRuns.length) prims.push({ t: 'text', runs: textRuns });
  prims.push(...groups);

  const width = colX[C];
  return {
    colX, rowY: rowY.slice(0, visibleRows + 1), colW, rowH, width, height: rowY[visibleRows], naturalWidth, naturalHeight, contentMin,
    hasFr: frCols.length > 0, visibleRows, overset: visibleRows < R, cells: boxes, prims,
  };
}

function shiftPrims(prims: Prim[], dx: number, dy: number): Prim[] {
  if (!dx && !dy) return prims;
  return [{ t: 'group', matrix: [1, 0, 0, 1, dx, dy], children: prims } as GroupPrim];
}

const dotted = (s: TableStroke) => s.dash.length >= 2 && s.dash[0] < 0.1;

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

const heaviest = (...ss: (TableStroke | undefined)[]): TableStroke | undefined => {
  let best: TableStroke | undefined;
  for (const s of ss) if (s && (!best || s.w > best.w)) best = s;
  return best;
};

const strokeKey = (s: TableStroke) => `${s.w}|${s.color}|${s.dash.join(',')}`;

function strokePrims(el: TableElement, T: TableStyleProps, map: Int32Array, byKey: Map<number, ResolvedCell>, colX: number[], rowY: number[], R: number): Prim[] {
  const C = el.cols.length;
  const nR = el.rows.length;
  const owner = (r: number, c: number) => (r >= 0 && r < R && c >= 0 && c < C ? map[r * C + c] : -1);
  const cellOf = (k: number) => (k >= 0 ? byKey.get(k) : undefined);

  const hRule = (b: number): TableStroke | null => {
    if (b === 0) return T.borderTop;
    if (b === R) return T.borderBottom;
    if (el.headerRows > 0 && b === el.headerRows) return T.headerRule;
    if (el.footerRows > 0 && b === nR - el.footerRows) return T.footerRule;
    if (b < el.headerRows || b > nR - el.footerRows) return T.rowRule;
    const every = Math.max(1, Math.round(T.rowRuleEvery || 1));
    return (b - el.headerRows) % every === 0 ? T.rowRule : null;
  };
  const vRule = (b: number): TableStroke | null => {
    if (b === 0) return T.borderLeft;
    if (b === C) return T.borderRight;
    if (T.stub && b === 1) return T.stubRule ?? T.colRule;
    return T.colRule;
  };

  // Resolve every grid segment first, so rules can meet cleanly at their ends.
  const H: (TableStroke | null)[][] = [];
  for (let b = 0; b <= R; b++) {
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
    for (let r = 0; r < R; r++) {
      const left = owner(r, b - 1), right = owner(r, b);
      if (left !== -1 && left === right) { col.push(null); continue; }
      const ov = heaviest(cellOf(left)?.edges.right, cellOf(right)?.edges.left);
      const s = ov ?? vRule(b);
      col.push(s && s.w > 0 ? s : null);
    }
    V.push(col);
  }
  const vAt = (b: number, r: number) => (b >= 0 && b <= C && r >= 0 && r < R ? V[b][r]?.w ?? 0 : 0);
  const hAt = (b: number, c: number) => (b >= 0 && b <= R && c >= 0 && c < C ? H[b][c]?.w ?? 0 : 0);

  const paths = new Map<string, { s: TableStroke; d: string[] }>();
  const add = (s: TableStroke, d: string) => {
    const k = strokeKey(s);
    const e = paths.get(k) ?? { s, d: [] };
    e.d.push(d);
    paths.set(k, e);
  };
  const f = (v: number) => +v.toFixed(3);
  for (let b = 0; b <= R; b++) {
    let c = 0;
    while (c < C) {
      const s = H[b][c];
      if (!s) { c++; continue; }
      const k = strokeKey(s);
      let e = c + 1;
      while (e < C && H[b][e] && strokeKey(H[b][e]!) === k) e++;
      const ext0 = Math.max(vAt(c, b - 1), vAt(c, b)) / 2, ext1 = Math.max(vAt(e, b - 1), vAt(e, b)) / 2;
      add(s, `M${f(colX[c] - ext0)} ${f(rowY[b])}H${f(colX[e] + ext1)}`);
      c = e;
    }
  }
  for (let b = 0; b <= C; b++) {
    let r = 0;
    while (r < R) {
      const s = V[b][r];
      if (!s) { r++; continue; }
      const k = strokeKey(s);
      let e = r + 1;
      while (e < R && V[b][e] && strokeKey(V[b][e]!) === k) e++;
      const ext0 = Math.max(hAt(r, b - 1), hAt(r, b)) / 2, ext1 = Math.max(hAt(e, b - 1), hAt(e, b)) / 2;
      add(s, `M${f(colX[b])} ${f(rowY[r] - ext0)}V${f(rowY[e] + ext1)}`);
      r = e;
    }
  }
  return [...paths.values()].map(({ s, d }) => ({
    t: 'path' as const, d: d.join(''), fill: null, stroke: s.color, strokeWidth: s.w,
    dash: s.dash.length ? s.dash : undefined, cap: dotted(s) ? 'round' as const : 'butt' as const,
  }));
}
