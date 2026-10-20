/**
 * Tables — model, named styles, presets and structural operations.
 *
 * A table is a grid of rows × columns. Each cell holds a story (the same markup as a text frame,
 * set by the same engine) and may span several rows and columns. Formatting cascades like
 * InDesign's: the table style sets the rules, fills and the cell styles of the header, body,
 * footer and stub regions; a named cell style and local overrides sit on top of that.
 *
 *   base cell defaults ← column (align, decimal, figures) ← region cell style ← cell style ← local
 *
 * Geometry is in pt. Column widths may be fixed, proportional (fr) or automatic from content;
 * row heights automatic, a minimum, or fixed.
 */
import type { ElementBase, ID, TextStyle } from './types';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type CellAlign = 'left' | 'center' | 'right' | 'justify' | 'decimal';
export type CellVAlign = 'top' | 'middle' | 'bottom';
export type CellRotation = 0 | 90 | 180 | 270;
export type CellDiagonal = 'none' | 'down' | 'up' | 'cross';
/** Figure style for numbers: tabular / proportional × lining / oldstyle (OpenType tnum·pnum, lnum·onum). */
export type FigureStyle = 'default' | 'tabular-lining' | 'tabular-oldstyle' | 'proportional-lining' | 'proportional-oldstyle';

/** A rule. Weight 0 = no rule. */
export interface TableStroke { w: number; color: string; dash: number[] }

export interface CellEdges { top?: TableStroke; right?: TableStroke; bottom?: TableStroke; left?: TableStroke }

/** Everything a cell style (or a cell's local formatting) can set. Unset properties inherit. */
export interface CellStyleProps {
  /** Paragraph style (project id) laid over the table's text style. */
  paraStyle?: ID | null;
  /** Character style (project id) applied to the whole cell. */
  charStyle?: ID | null;
  fontFamily?: string;
  fontSize?: number;
  leading?: number;
  weight?: number;
  italic?: boolean;
  color?: string;
  /** Thousandths of an em. */
  tracking?: number;
  textTransform?: TextStyle['textTransform'];
  /** OpenType features merged over the text's own (e.g. c2sc, case, zero). */
  features?: Record<string, boolean>;
  figures?: FigureStyle;
  hyphenate?: boolean;
  align?: CellAlign;
  /** Character the decimal alignment lines up on ('.', ',', '·' …). */
  decimalChar?: string;
  valign?: CellVAlign;
  padTop?: number;
  padRight?: number;
  padBottom?: number;
  padLeft?: number;
  /** Cell fill; null = explicitly none (overrides zebra / region fills). */
  fill?: string | null;
  rotation?: CellRotation;
  diagonal?: CellDiagonal;
  diagonalStroke?: TableStroke;
  /** Per-edge rules that override the table's rules on that edge. */
  edges?: CellEdges;
}

export interface CellStyleDef { id: ID; name: string; props: CellStyleProps }

export interface TableStyleProps {
  borderTop: TableStroke;
  borderBottom: TableStroke;
  borderLeft: TableStroke;
  borderRight: TableStroke;
  /** Rule below the header rows. */
  headerRule: TableStroke;
  /** Rule above the footer rows. */
  footerRule: TableStroke;
  /** Rules between rows; drawn every `rowRuleEvery` body rows. */
  rowRule: TableStroke;
  rowRuleEvery: number;
  /** Rules between columns. */
  colRule: TableStroke;
  /** Rule after the stub (first) column; null = same as the column rule. */
  stubRule: TableStroke | null;
  /** Body background. */
  fill: string | null;
  /** Alternating body-row fill: every `zebraEvery` rows, starting after `zebraOffset` groups. */
  zebraFill: string | null;
  zebraEvery: number;
  zebraOffset: number;
  /** Alternating column fill. */
  colZebraFill: string | null;
  colZebraEvery: number;
  headerFill: string | null;
  footerFill: string | null;
  /** Treat the first column as a stub (row heads) with its own cell style and rule. */
  stub: boolean;
  headerCell: ID | null;
  bodyCell: ID | null;
  footerCell: ID | null;
  stubCell: ID | null;
}

export interface TableStyleDef { id: ID; name: string; props: Partial<TableStyleProps>; note?: string }

export type RowMode = 'auto' | 'min' | 'fixed';
export interface TableRow { mode: RowMode; /** Minimum (min) or exact (fixed) height, pt. */ h: number }

export type ColMode = 'fixed' | 'fr' | 'auto';
export interface TableCol {
  mode: ColMode;
  /** fixed: width in pt · fr: share of the remaining width · auto: maximum width in pt (0 = none). */
  w: number;
  align?: CellAlign;
  decimalChar?: string;
  figures?: FigureStyle;
}

export interface TableCell {
  /** Story markup: *italic*, **bold**, ^small caps^, [Para style] , <Char style>…</Char style>. */
  text: string;
  colSpan?: number;
  rowSpan?: number;
  cellStyle?: ID | null;
  /** Local overrides. */
  fmt?: CellStyleProps;
}

export interface TableElement extends ElementBase {
  type: 'table';
  rows: TableRow[];
  cols: TableCol[];
  /** cells[row][col]; cells covered by a merge keep their slot (and are ignored). */
  cells: TableCell[][];
  headerRows: number;
  footerRows: number;
  /** Named table style (project style or built-in preset). */
  tableStyle: ID | null;
  /** Local overrides of the table style. */
  local: Partial<TableStyleProps>;
  /** Base text formatting of every cell. */
  style: TextStyle;
  /** Paragraph style the base formatting follows. */
  paraStyle?: ID | null;
  /** Columns fill the frame width (fr columns take the rest; without fr columns all scale). */
  fitWidth: boolean;
  /** The frame height follows the table (dragging the frame edge scales the rows). */
  autoHeight: boolean;
  /** Body rows stretch to fill a taller frame. */
  fillHeight: boolean;
}

export interface CellRange { r0: number; c0: number; r1: number; c1: number }

/* -------------------------------------------------------------------------- */
/* Defaults & presets                                                          */
/* -------------------------------------------------------------------------- */

const INK = '#1b1813';
export const NO_RULE: TableStroke = { w: 0, color: INK, dash: [] };
export const rule = (w: number, color = INK, dash: number[] = []): TableStroke => ({ w, color, dash });

export const BASE_TABLE_STYLE: TableStyleProps = {
  borderTop: NO_RULE, borderBottom: NO_RULE, borderLeft: NO_RULE, borderRight: NO_RULE,
  headerRule: NO_RULE, footerRule: NO_RULE, rowRule: NO_RULE, rowRuleEvery: 1, colRule: NO_RULE, stubRule: null,
  fill: null, zebraFill: null, zebraEvery: 1, zebraOffset: 1, colZebraFill: null, colZebraEvery: 1,
  headerFill: null, footerFill: null, stub: false, headerCell: null, bodyCell: null, footerCell: null, stubCell: null,
};

export const BASE_CELL: Required<Omit<CellStyleProps, 'paraStyle' | 'charStyle' | 'fontFamily' | 'fontSize' | 'leading' | 'weight' | 'italic' | 'color' | 'tracking' | 'textTransform' | 'features' | 'hyphenate' | 'edges' | 'align'>> = {
  figures: 'default', decimalChar: '.', valign: 'top', padTop: 3, padRight: 4, padBottom: 3, padLeft: 4,
  fill: null, rotation: 0, diagonal: 'none', diagonalStroke: rule(0.5),
};

/** Built-in cell styles (copied into the project when a preset using them is applied). */
export const CELL_PRESETS: CellStyleDef[] = [
  { id: 'cs-head', name: 'Column head', props: { textTransform: 'small-caps', features: { c2sc: true }, tracking: 50, valign: 'bottom' } },
  { id: 'cs-head-italic', name: 'Column head · italic', props: { italic: true, valign: 'bottom' } },
  { id: 'cs-head-bold', name: 'Column head · bold', props: { weight: 650, valign: 'bottom' } },
  { id: 'cs-head-swiss', name: 'Column head · Swiss', props: { fontFamily: 'inter', weight: 600, fontSize: 7.5, leading: 10, valign: 'bottom', padTop: 4, padBottom: 4 } },
  { id: 'cs-body-swiss', name: 'Body · Swiss', props: { fontFamily: 'inter', fontSize: 7.5, leading: 10, figures: 'tabular-lining', padTop: 4, padBottom: 4 } },
  { id: 'cs-stub', name: 'Stub', props: { italic: true } },
  { id: 'cs-stub-bold', name: 'Stub · bold', props: { weight: 650 } },
  { id: 'cs-figures', name: 'Figures', props: { align: 'decimal', figures: 'tabular-lining' } },
  { id: 'cs-total', name: 'Total', props: { weight: 650, edges: { top: rule(0.5) } } },
  { id: 'cs-note', name: 'Table note', props: { fontSize: 7.5, leading: 10, italic: true } },
  { id: 'cs-ledger-head', name: 'Ledger head', props: { textTransform: 'uppercase', tracking: 80, fontSize: 7, weight: 600, color: '#f4efe4', valign: 'middle' } },
];

/** Classic book-table presets. */
export const TABLE_PRESETS: TableStyleDef[] = [
  {
    id: 'tbs-book', name: 'Book rules (Tschichold)',
    note: 'Three horizontal rules only — a heavier rule above and below the table, a fine one under the heads. No vertical rules: the columns are held by alignment.',
    props: { borderTop: rule(1), headerRule: rule(0.4), borderBottom: rule(1), footerRule: rule(0.4), headerCell: 'cs-head' },
  },
  {
    id: 'tbs-swiss', name: 'Swiss grid (Müller-Brockmann)',
    note: 'Sans-serif, flush left, a heavy top rule and hairlines on every row and column — the grid made visible.',
    props: { borderTop: rule(2), headerRule: rule(0.75), rowRule: rule(0.25), colRule: rule(0.25), borderBottom: rule(0.75), headerCell: 'cs-head-swiss', bodyCell: 'cs-body-swiss' },
  },
  {
    id: 'tbs-ledger', name: 'Ledger (zebra)',
    note: 'Banded rows every line for reading across long rows of figures; a solid header and a bold stub.',
    props: { headerFill: '#2b2a2f', zebraFill: '#ece5d6', zebraEvery: 1, zebraOffset: 1, borderBottom: rule(0.75), footerRule: rule(0.5), stub: true, stubCell: 'cs-stub-bold', headerCell: 'cs-ledger-head' },
  },
  {
    id: 'tbs-grid', name: 'Full grid',
    note: 'Every cell boxed by a fine rule, a tinted header — for forms, schedules and dense reference tables.',
    props: { borderTop: rule(0.75), borderBottom: rule(0.75), borderLeft: rule(0.75), borderRight: rule(0.75), headerRule: rule(0.75), footerRule: rule(0.75), rowRule: rule(0.4), colRule: rule(0.4), headerFill: '#e6dfd0', headerCell: 'cs-head-bold' },
  },
  {
    id: 'tbs-tabular', name: 'Tabular, no rules (Bringhurst)',
    note: 'No rules at all: space, alignment and an italic head do the work. Rules are added only where the eye needs them.',
    props: { headerCell: 'cs-head-italic', stub: true, stubCell: null },
  },
];

/* -------------------------------------------------------------------------- */
/* Style lookup                                                                */
/* -------------------------------------------------------------------------- */

interface StyleSource { tableStyles?: TableStyleDef[]; cellStyles?: CellStyleDef[] }

export function findTableStyle(p: StyleSource, id: ID | null | undefined): TableStyleDef | null {
  if (!id) return null;
  return p.tableStyles?.find((s) => s.id === id) ?? TABLE_PRESETS.find((s) => s.id === id) ?? null;
}

export function findCellStyle(p: StyleSource, id: ID | null | undefined): CellStyleDef | null {
  if (!id) return null;
  return p.cellStyles?.find((s) => s.id === id) ?? CELL_PRESETS.find((s) => s.id === id) ?? null;
}

/** Table styles available to a project: its own, then presets it has not redefined. */
export function allTableStyles(p: StyleSource): TableStyleDef[] {
  const own = p.tableStyles ?? [];
  return [...own, ...TABLE_PRESETS.filter((x) => !own.some((o) => o.id === x.id))];
}

export function allCellStyles(p: StyleSource): CellStyleDef[] {
  const own = p.cellStyles ?? [];
  return [...own, ...CELL_PRESETS.filter((x) => !own.some((o) => o.id === x.id))];
}

const isDefined = <T,>(v: T | undefined): v is T => v !== undefined;

/** Lay `b` over `a` (undefined inherits, null is a value). Edges merge per side. */
export function mergeCellProps(a: CellStyleProps, b: CellStyleProps | null | undefined): CellStyleProps {
  if (!b) return a;
  const out: CellStyleProps = { ...a };
  for (const k of Object.keys(b) as (keyof CellStyleProps)[]) {
    if (k === 'edges' || k === 'features') continue;
    const v = b[k];
    if (isDefined(v)) (out as Record<string, unknown>)[k] = v;
  }
  if (b.edges) out.edges = { ...(a.edges ?? {}), ...b.edges };
  if (b.features) out.features = { ...(a.features ?? {}), ...b.features };
  return out;
}

/** Effective table style: defaults ← named style ← local overrides. */
export function resolveTableStyle(p: StyleSource, t: Pick<TableElement, 'tableStyle' | 'local'>): TableStyleProps {
  const named = findTableStyle(p, t.tableStyle);
  const out: TableStyleProps = { ...BASE_TABLE_STYLE };
  for (const src of [named?.props, t.local]) {
    if (!src) continue;
    for (const k of Object.keys(src) as (keyof TableStyleProps)[]) {
      const v = src[k];
      if (v !== undefined && k in BASE_TABLE_STYLE) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Font features for a figure style (merged over the text's own features). */
export function figureFeatures(f: FigureStyle | undefined): Record<string, boolean> | null {
  switch (f) {
    case 'tabular-lining': return { tnum: true, pnum: false, lnum: true, onum: false };
    case 'tabular-oldstyle': return { tnum: true, pnum: false, onum: true, lnum: false };
    case 'proportional-lining': return { pnum: true, tnum: false, lnum: true, onum: false };
    case 'proportional-oldstyle': return { pnum: true, tnum: false, onum: true, lnum: false };
    default: return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Grid structure                                                              */
/* -------------------------------------------------------------------------- */

export const emptyCell = (): TableCell => ({ text: '' });

export function spanOf(t: Pick<TableElement, 'cells' | 'rows' | 'cols'>, r: number, c: number): { rs: number; cs: number } {
  const cell = t.cells[r]?.[c];
  return {
    rs: Math.max(1, Math.min(t.rows.length - r, Math.round(cell?.rowSpan ?? 1))),
    cs: Math.max(1, Math.min(t.cols.length - c, Math.round(cell?.colSpan ?? 1))),
  };
}

/**
 * Owner map: for each slot, the index (r * cols + c) of the anchor cell covering it.
 * Overlapping merges are resolved first-come (reading order); later anchors inside a merge are ignored.
 */
export function coverMap(t: Pick<TableElement, 'cells' | 'rows' | 'cols'>): Int32Array {
  const R = t.rows.length, C = t.cols.length;
  const map = new Int32Array(R * C).fill(-1);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (map[r * C + c] !== -1) continue;
      let { rs, cs } = spanOf(t, r, c);
      // Shrink a span that would run into an existing merge.
      for (let cc = c; cc < c + cs; cc++) if (map[r * C + cc] !== -1) { cs = cc - c; break; }
      outer: for (let rr = r + 1; rr < r + rs; rr++) {
        for (let cc = c; cc < c + cs; cc++) if (map[rr * C + cc] !== -1) { rs = rr - r; break outer; }
      }
      for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) map[rr * C + cc] = r * C + c;
    }
  }
  return map;
}

export interface Anchor { r: number; c: number; rs: number; cs: number }

export function anchorsOf(t: Pick<TableElement, 'cells' | 'rows' | 'cols'>, map = coverMap(t)): Anchor[] {
  const C = t.cols.length;
  const out: Anchor[] = [];
  const ext = new Map<number, Anchor>();
  for (let i = 0; i < map.length; i++) {
    const a = map[i];
    const r = Math.floor(i / C), c = i % C;
    let an = ext.get(a);
    if (!an) { an = { r: Math.floor(a / C), c: a % C, rs: 1, cs: 1 }; ext.set(a, an); out.push(an); }
    an.rs = Math.max(an.rs, r - an.r + 1);
    an.cs = Math.max(an.cs, c - an.c + 1);
  }
  return out;
}

/** The anchor covering slot (r, c). */
export function anchorAt(t: Pick<TableElement, 'cells' | 'rows' | 'cols'>, r: number, c: number, map = coverMap(t)): Anchor | null {
  const C = t.cols.length;
  if (r < 0 || c < 0 || r >= t.rows.length || c >= C) return null;
  const a = map[r * C + c];
  return anchorsOf(t, map).find((x) => x.r * C + x.c === a) ?? null;
}

export const normRange = (a: { r: number; c: number }, b: { r: number; c: number }): CellRange =>
  ({ r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) });

/** Grow a range until it contains every merge it touches. */
export function expandRange(t: Pick<TableElement, 'cells' | 'rows' | 'cols'>, range: CellRange): CellRange {
  const anchors = anchorsOf(t);
  const g = { ...range };
  for (let changed = true; changed;) {
    changed = false;
    for (const a of anchors) {
      const touches = a.r <= g.r1 && a.r + a.rs - 1 >= g.r0 && a.c <= g.c1 && a.c + a.cs - 1 >= g.c0;
      if (!touches) continue;
      const n = { r0: Math.min(g.r0, a.r), c0: Math.min(g.c0, a.c), r1: Math.max(g.r1, a.r + a.rs - 1), c1: Math.max(g.c1, a.c + a.cs - 1) };
      if (n.r0 !== g.r0 || n.c0 !== g.c0 || n.r1 !== g.r1 || n.c1 !== g.c1) { Object.assign(g, n); changed = true; }
    }
  }
  return g;
}

/** Anchor cells whose top-left lies inside the range. */
export function anchorsIn(t: Pick<TableElement, 'cells' | 'rows' | 'cols'>, range: CellRange): Anchor[] {
  return anchorsOf(t).filter((a) => a.r >= range.r0 && a.r <= range.r1 && a.c >= range.c0 && a.c <= range.c1);
}

/** Make the cell matrix match the row and column counts. */
export function normalizeTable(t: TableElement): void {
  while (t.cells.length < t.rows.length) t.cells.push([]);
  t.cells.length = t.rows.length;
  for (const row of t.cells) {
    while (row.length < t.cols.length) row.push(emptyCell());
    row.length = t.cols.length;
  }
  t.headerRows = Math.max(0, Math.min(t.rows.length, Math.round(t.headerRows)));
  t.footerRows = Math.max(0, Math.min(t.rows.length - t.headerRows, Math.round(t.footerRows)));
}

/* -------------------------------------------------------------------------- */
/* Structural edits (mutate a draft)                                           */
/* -------------------------------------------------------------------------- */

const blankRowLike = (t: TableElement, from: number | null): TableCell[] =>
  t.cols.map((_, c) => {
    const src = from != null ? t.cells[from]?.[c] : null;
    return src ? { text: '', cellStyle: src.cellStyle ?? undefined, fmt: src.fmt ? JSON.parse(JSON.stringify(src.fmt)) : undefined } : emptyCell();
  });

/** Insert `count` rows before row `at` (formatting copied from the neighbouring row). */
export function insertRows(t: TableElement, at: number, count = 1): void {
  at = Math.max(0, Math.min(t.rows.length, at));
  const map = coverMap(t);
  const anchors = anchorsOf(t, map);
  // Merges that straddle the insertion point grow.
  for (const a of anchors) if (a.r < at && a.r + a.rs > at) t.cells[a.r][a.c].rowSpan = a.rs + count;
  // Formatting comes from the row above (or the first row when inserting at the top).
  const R0 = t.rows.length;
  const tmpl = at > 0 ? (at === t.headerRows && at < R0 ? at : at - 1) : R0 ? 0 : null;
  const rowSpec = tmpl != null ? { ...t.rows[tmpl], mode: t.rows[tmpl].mode === 'fixed' ? 'fixed' as const : 'auto' as const } : { mode: 'auto' as const, h: 0 };
  const proto = tmpl != null ? blankRowLike(t, tmpl) : null;
  for (let i = 0; i < count; i++) {
    t.rows.splice(at, 0, { ...rowSpec });
    t.cells.splice(at, 0, proto ? proto.map((c) => JSON.parse(JSON.stringify(c)) as TableCell) : blankRowLike(t, null));
  }
  if (at < t.headerRows) t.headerRows += count;
  else if (t.footerRows > 0 && at > R0 - t.footerRows) t.footerRows += count;
  normalizeTable(t);
}

/** Delete rows r0…r1 (inclusive). */
export function deleteRows(t: TableElement, r0: number, r1: number): void {
  r0 = Math.max(0, r0); r1 = Math.min(t.rows.length - 1, r1);
  if (r1 < r0 || r1 - r0 + 1 >= t.rows.length) return;
  const n = r1 - r0 + 1;
  const anchors = anchorsOf(t);
  for (const a of anchors) {
    const end = a.r + a.rs - 1;
    const overlap = Math.max(0, Math.min(end, r1) - Math.max(a.r, r0) + 1);
    if (!overlap) continue;
    const rs = a.rs - overlap;
    if (rs <= 0) continue;
    if (a.r >= r0) {
      // The anchor row goes: the merge moves to the first surviving row.
      const cell = t.cells[a.r][a.c];
      t.cells[r1 + 1][a.c] = { ...cell, rowSpan: rs };
    } else t.cells[a.r][a.c].rowSpan = rs;
  }
  const hdrCut = Math.max(0, Math.min(r1, t.headerRows - 1) - r0 + 1);
  const ftStart = t.rows.length - t.footerRows;
  const ftCut = Math.max(0, r1 - Math.max(r0, ftStart) + 1);
  t.rows.splice(r0, n);
  t.cells.splice(r0, n);
  t.headerRows -= hdrCut;
  t.footerRows -= ftCut;
  normalizeTable(t);
}

/** Insert `count` columns before column `at`. New columns share the width style of their neighbour. */
export function insertCols(t: TableElement, at: number, count = 1): void {
  at = Math.max(0, Math.min(t.cols.length, at));
  const anchors = anchorsOf(t);
  for (const a of anchors) if (a.c < at && a.c + a.cs > at) t.cells[a.r][a.c].colSpan = a.cs + count;
  const tmpl = t.cols[at > 0 ? at - 1 : 0];
  const spec = tmpl ? { ...tmpl } : { mode: 'fr' as const, w: 1 };
  for (let i = 0; i < count; i++) {
    t.cols.splice(at, 0, { ...spec });
    t.cells.forEach((row, r) => {
      const src = row[at > 0 ? at - 1 : at];
      row.splice(at, 0, src ? { text: '', cellStyle: src.cellStyle ?? undefined, fmt: src.fmt ? JSON.parse(JSON.stringify(src.fmt)) : undefined } : emptyCell());
      void r;
    });
  }
  normalizeTable(t);
}

export function deleteCols(t: TableElement, c0: number, c1: number): void {
  c0 = Math.max(0, c0); c1 = Math.min(t.cols.length - 1, c1);
  if (c1 < c0 || c1 - c0 + 1 >= t.cols.length) return;
  const n = c1 - c0 + 1;
  for (const a of anchorsOf(t)) {
    const end = a.c + a.cs - 1;
    const overlap = Math.max(0, Math.min(end, c1) - Math.max(a.c, c0) + 1);
    if (!overlap) continue;
    const cs = a.cs - overlap;
    if (cs <= 0) continue;
    if (a.c >= c0) t.cells[a.r][c1 + 1] = { ...t.cells[a.r][a.c], colSpan: cs };
    else t.cells[a.r][a.c].colSpan = cs;
  }
  t.cols.splice(c0, n);
  for (const row of t.cells) row.splice(c0, n);
  normalizeTable(t);
}

/** Merge a range into its top-left cell; the texts of the other cells are appended as paragraphs. */
export function mergeCells(t: TableElement, range: CellRange): CellRange {
  const g = expandRange(t, range);
  const anchors = anchorsIn(t, g);
  const texts = anchors.map((a) => t.cells[a.r][a.c].text).filter((x) => x.trim());
  for (const a of anchors) {
    const cell = t.cells[a.r][a.c];
    delete cell.rowSpan; delete cell.colSpan;
    if (a.r !== g.r0 || a.c !== g.c0) cell.text = '';
  }
  const top = t.cells[g.r0][g.c0];
  top.text = texts.join('\n');
  top.rowSpan = g.r1 - g.r0 + 1;
  top.colSpan = g.c1 - g.c0 + 1;
  if (top.rowSpan === 1) delete top.rowSpan;
  if (top.colSpan === 1) delete top.colSpan;
  return g;
}

export function unmergeCells(t: TableElement, range: CellRange): void {
  for (const a of anchorsIn(t, expandRange(t, range))) {
    const cell = t.cells[a.r][a.c];
    delete cell.rowSpan; delete cell.colSpan;
    // The split-off cells take the formatting of the merged cell.
    for (let r = a.r; r < a.r + a.rs; r++) for (let c = a.c; c < a.c + a.cs; c++) {
      if (r === a.r && c === a.c) continue;
      const o = t.cells[r][c];
      o.cellStyle = cell.cellStyle;
      o.fmt = cell.fmt ? JSON.parse(JSON.stringify(cell.fmt)) : undefined;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Delimited text (CSV / TSV)                                                   */
/* -------------------------------------------------------------------------- */

/** The separator that splits every one of the first lines into the same number of fields (tab, ;, , or |). */
function detectDelimiter(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim()).slice(0, 12).map((l) => l.replace(/"[^"]*"/g, ''));
  let best = ',', bestScore = -1;
  for (const d of ['\t', ';', ',', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    if (min <= 0) continue;
    const score = (counts.every((c) => c === counts[0]) ? 1000 : 0) + min;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** Parse CSV / TSV / semicolon-separated text (quotes and doubled quotes supported). */
export function parseDelimited(src: string, delimiter?: string): string[][] {
  const text = src.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!text) return [];
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { q = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);
  const w = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r.map((x) => x.trim()), ...new Array<string>(w - r.length).fill('')]);
}

/** Cells of a range as tab-separated text (markup kept; paragraph breaks become spaces). */
export function rangeToTSV(t: TableElement, range: CellRange): string {
  const out: string[] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    const line: string[] = [];
    for (let c = range.c0; c <= range.c1; c++) line.push((t.cells[r]?.[c]?.text ?? '').replace(/\s*\n\s*/g, ' '));
    out.push(line.join('\t'));
  }
  return out.join('\n');
}

export function tableToCSV(t: TableElement): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return t.cells.map((row) => row.map((c) => q(c.text)).join(',')).join('\n');
}

const NUMERIC = /^[\s(]*[-−+–]?[$€£¥]?\s*\d[\d\s.,'’ ]*%?\)?\s*$/;
export const looksNumeric = (s: string) => NUMERIC.test(s.trim());

/** Write a matrix of strings into the table from (r, c), growing it as needed. */
export function fillCells(t: TableElement, data: string[][], at: { r: number; c: number }): CellRange {
  const needR = at.r + data.length, needC = at.c + Math.max(0, ...data.map((d) => d.length));
  if (needR > t.rows.length) insertRows(t, t.rows.length - t.footerRows, needR - t.rows.length);
  if (needC > t.cols.length) insertCols(t, t.cols.length, needC - t.cols.length);
  data.forEach((row, i) => row.forEach((v, j) => { t.cells[at.r + i][at.c + j].text = v; }));
  return { r0: at.r, c0: at.c, r1: needR - 1, c1: needC - 1 };
}

/** Structure of a new table from a matrix: first row as heads, numeric columns decimal-aligned in tabular figures. */
export function tableFromMatrix(data: string[][], opts: { header?: boolean } = {}): Pick<TableElement, 'rows' | 'cols' | 'cells' | 'headerRows' | 'footerRows'> {
  const R = Math.max(1, data.length), C = Math.max(1, ...data.map((d) => d.length));
  const header = opts.header ?? (R > 1 && data[0].some((v) => v && !looksNumeric(v)));
  const body = data.slice(header ? 1 : 0);
  const cols = Array.from({ length: C }, (_, c) => {
    const vals = body.map((r) => r[c] ?? '').filter((v) => v.trim());
    const numeric = vals.length > 0 && vals.filter(looksNumeric).length / vals.length >= 0.75;
    if (numeric) return { mode: 'auto' as ColMode, w: 0, align: 'decimal' as CellAlign, figures: 'tabular-lining' as FigureStyle, decimalChar: guessDecimal(vals) };
    return c === 0 ? { mode: 'auto' as ColMode, w: 0 } : { mode: 'fr' as ColMode, w: 1 };
  });
  // At least one column takes up the slack.
  if (!cols.some((c) => c.mode === 'fr')) { const i = cols.findIndex((c) => !c.align); if (i >= 0) cols[i] = { mode: 'fr', w: 1 }; }
  return {
    rows: Array.from({ length: R }, () => ({ mode: 'auto' as RowMode, h: 0 })),
    cols,
    cells: Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => ({ text: data[r]?.[c] ?? '' }))),
    headerRows: header ? 1 : 0,
    footerRows: 0,
  };
}

/** '.' or ',' — whichever separates the fraction in most values (German, French: ','). */
function guessDecimal(vals: string[]): string {
  let dot = 0, comma = 0;
  for (const v of vals) {
    if (/\d\.\d{1,2}(?!\d)/.test(v) && !/\d\.\d{3}(?!\d)/.test(v)) dot++;
    if (/\d,\d{1,2}(?!\d)/.test(v) && !/\d,\d{3}(?!\d)/.test(v)) comma++;
  }
  return comma > dot ? ',' : '.';
}

/** Bump `zebra`-style numbers etc. Shared label helpers. */
export const colLetter = (c: number): string => (c < 26 ? String.fromCharCode(65 + c) : colLetter(Math.floor(c / 26) - 1) + String.fromCharCode(65 + (c % 26)));
export const rangeLabel = (g: CellRange) => (g.r0 === g.r1 && g.c0 === g.c1 ? `${colLetter(g.c0)}${g.r0 + 1}` : `${colLetter(g.c0)}${g.r0 + 1}:${colLetter(g.c1)}${g.r1 + 1}`);

/** Region of a row. */
export function rowRegion(t: Pick<TableElement, 'rows' | 'headerRows' | 'footerRows'>, r: number): 'header' | 'body' | 'footer' {
  if (r < t.headerRows) return 'header';
  if (r >= t.rows.length - t.footerRows) return 'footer';
  return 'body';
}
