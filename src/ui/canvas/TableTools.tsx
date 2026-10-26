/**
 * In-canvas table editing.
 *
 *  • Click a selected table to pick a cell, shift-click (or drag) for a range; Esc returns to
 *    the frame. Double-click (or Enter, or just start typing) edits the cell's story.
 *  • Drag a column or row border to resize it (⇧ makes a row height exact).
 *  • Tab / ⇧Tab walk the cells (Tab in the last cell adds a row), arrows move, ⇧arrows extend,
 *    Delete clears, ⌘C / ⌘X / ⌘V copy, cut and paste tab-separated data (from a spreadsheet).
 *  • The frame follows the table: it grows with the content, and dragging its edge scales the rows.
 *  • Threads: the out-port at the frame's lower right continues the table in another (empty)
 *    table frame, or in a new one wherever you click; the rows flow on, the head repeats.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Draft } from 'immer';
import { X, Bold, Italic, CaseSensitive, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Element, Project } from '../../model/types';
import type { TableElement, CellRange } from '../../model/table';
import { anchorAt, anchorsOf, coverMap, expandRange, normRange, parseDelimited, rangeToTSV, fillCells, insertRows, rangeLabel, colLetter, tableFromMatrix } from '../../model/table';
import { layoutTable, tableHead, tableThreadOf, type TableLayout } from '../../render/table';
import { contextForElement } from '../../render/compile';
import { applyMatrix, invert, multiply, scale as scaleM, translate, type Matrix } from '../../render/primitives';
import { useStore, type Tool } from '../../store/store';
import { makeTable } from '../../model/factory';
import { computeGrid, textBlock, type PageSide } from '../../engine/grid';
import { findElement, surfaceElementsDraft, pageSide, spreadIndexOfPage } from '../../model/surfaces';
import { insertPages } from '../../model/pageOps';
import { sceneMatrix, type PanelLayout, type Pt, type SurfaceDesc } from './geometry';

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

export function findTable(id: string): TableElement | null {
  const el = findElement(useStore.getState().project, id)?.el;
  return el && el.type === 'table' ? el : null;
}

/** The table holding the rows for a frame (the head of its thread). */
export function findHead(id: string): TableElement | null {
  const t = findTable(id);
  return t ? tableHead(useStore.getState().project, t) : null;
}

/* -------------------------------------------------------------------------- */
/* Cell selection state                                                         */
/* -------------------------------------------------------------------------- */

interface TableUi {
  /** The frame being worked in. */
  tableId: string | null;
  /** The table that holds the rows (the head of the frame's thread). */
  dataId: string | null;
  /** Selected cells, in table rows / columns (expanded to whole merges). */
  sel: CellRange | null;
  /** Where shift-click / shift-arrow extends from. */
  anchor: { r: number; c: number } | null;
  /** Cell whose story is open in the cell editor. */
  editing: { r: number; c: number; initial?: string } | null;
  setSel: (frameId: string, sel: CellRange | null, anchor?: { r: number; c: number } | null) => void;
  edit: (frameId: string, r: number, c: number, initial?: string) => void;
  /** Carry on in another frame of the same table. */
  moveTo: (frameId: string) => void;
  stopEditing: () => void;
  clear: () => void;
}

const dataOf = (frameId: string) => findHead(frameId)?.id ?? frameId;

export const useTableUi = create<TableUi>((set) => ({
  tableId: null,
  dataId: null,
  sel: null,
  anchor: null,
  editing: null,
  setSel: (frameId, sel, anchor) => set((s) => ({ tableId: frameId, dataId: dataOf(frameId), sel, anchor: anchor === undefined ? s.anchor : anchor, editing: null })),
  edit: (frameId, r, c, initial) => set({ tableId: frameId, dataId: dataOf(frameId), sel: { r0: r, c0: c, r1: r, c1: c }, anchor: { r, c }, editing: { r, c, initial } }),
  moveTo: (frameId) => set({ tableId: frameId }),
  stopEditing: () => set({ editing: null }),
  clear: () => set({ tableId: null, dataId: null, sel: null, anchor: null, editing: null }),
}));

/** Select the cell covering slot (r, c), expanded to its merge. */
function cellRange(t: TableElement, r: number, c: number): CellRange {
  const a = anchorAt(t, r, c);
  return a ? { r0: a.r, c0: a.c, r1: a.r + a.rs - 1, c1: a.c + a.cs - 1 } : { r0: r, c0: c, r1: r, c1: c };
}

/** The selected cells of a table (pass the table that holds the rows). */
export function selectedTableRange(t: TableElement): CellRange | null {
  const ui = useTableUi.getState();
  if (ui.dataId !== t.id || !ui.sel || !t.rows.length || !t.cols.length) return null;
  const R = t.rows.length - 1, C = t.cols.length - 1;
  const g = { r0: Math.min(ui.sel.r0, R), c0: Math.min(ui.sel.c0, C), r1: Math.min(ui.sel.r1, R), c1: Math.min(ui.sel.c1, C) };
  return expandRange(t, g);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function layoutOf(project: Project, el: TableElement): TableLayout {
  const ctx = contextForElement(project, el.id, useStore.getState().spread);
  return layoutTable(el, { project, pageIndex: ctx?.pageIndex ?? null });
}

/** The table cell (row / column) under a frame-local point. */
function slotAt(L: TableLayout, p: Pt): { r: number; c: number } | null {
  if (!L.rowMap.length || p.x < 0 || p.y < 0 || p.x > L.width || p.y > L.height) return null;
  let c = 0, d = 0;
  while (c < L.colX.length - 2 && p.x > L.colX[c + 1]) c++;
  while (d < L.rowY.length - 2 && p.y > L.rowY[d + 1]) d++;
  return { r: L.rowMap[d], c };
}

/** A resizable border under the point: interior column borders, and the foot of a shown row. */
function borderAt(L: TableLayout, p: Pt, tol: number): { axis: 'col'; index: number } | { axis: 'row'; row: number } | null {
  if (p.y >= -tol && p.y <= L.height + tol) {
    for (let b = 1; b < L.colX.length - 1; b++) if (Math.abs(p.x - L.colX[b]) <= tol) return { axis: 'col', index: b };
  }
  if (p.x >= -tol && p.x <= L.width + tol) {
    for (let b = 1; b < L.rowY.length - 1; b++) {
      if (Math.abs(p.y - L.rowY[b]) <= tol && L.rowPiece[b - 1] < 0) return { axis: 'row', row: L.rowMap[b - 1] };
    }
  }
  return null;
}

/** Freeze the current column widths into specs that reproduce them, with columns i and j resized. */
function setColumnWidths(t: Draft<TableElement>, widths: number[], changed: number[]) {
  // fr weights become the widths themselves (they share exactly the remaining width); a resized
  // auto column becomes fixed; without fr columns a fitted table freezes every column.
  const hasFr = t.cols.some((c) => c.mode === 'fr');
  t.cols.forEach((col, c) => {
    const w = +widths[c].toFixed(2);
    if (col.mode === 'fr' || col.mode === 'fixed') col.w = w;
    else if (changed.includes(c) || (!hasFr && t.fitWidth)) { col.mode = 'fixed'; col.w = w; }
  });
}

const hasContent = (t: TableElement) => t.rows.length > 0 && t.cells.some((row) => row.some((c) => c.text.trim()));

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

/** A new table from the toolbar tool: a click spans the text block, a drag fills the box. */
export function makeTableFromDrag(project: Project, surface: SurfaceDesc, x: number, y: number, w: number, h: number, click: boolean): TableElement {
  const rows = 5;
  if (click) {
    if (surface.kind === 'page' || surface.kind === 'master') {
      const g = computeGrid(project.book, surface.side);
      const inBlock = x >= g.block.x - 2 && x <= g.block.x + g.block.w + 2;
      return makeTable({ x: inBlock ? g.block.x : x, y, w: inBlock ? g.block.w : 280, h: 90 });
    }
    return makeTable({ x: x - 140, y: y - 45, w: 280, h: 90 });
  }
  const tall = h >= rows * 16;
  return makeTable({
    x, y, w: Math.max(40, w), h: Math.max(20, h),
    rows: Array.from({ length: rows }, () => (tall ? { mode: 'min' as const, h: +(h / rows).toFixed(2) } : { mode: 'auto' as const, h: 0 })),
  });
}

/**
 * A new table from CSV / TSV text centred on a point (surface coordinates) — for dropped files.
 * It never starts above `top` (the head of the page's text block): a long table centred on the
 * drop point used to begin far above the page, where its first rows could not be seen or printed.
 */
export function tableFromText(text: string, at: { x: number; y: number }, name = 'Table', top = -Infinity): TableElement | null {
  const data = parseDelimited(text);
  if (!data.length) return null;
  const m = tableFromMatrix(data);
  const w = Math.min(340, Math.max(160, m.cols.length * 72)), h = data.length * 15;
  return makeTable({ ...m, name, x: at.x - w / 2, y: Math.max(top, at.y - h / 2), w, h });
}

/** Double-click on a table: edit the cell under the point (frame-local coordinates). */
export function tableDoubleClick(el: Element, local: Pt) {
  if (el.type !== 'table') return;
  const project = useStore.getState().project;
  const L = layoutOf(project, el);
  const slot = slotAt(L, local);
  if (!slot) return;
  const a = anchorAt(tableHead(project, el), slot.r, slot.c);
  if (!a) return;
  useStore.getState().select([el.id]);
  useTableUi.getState().edit(el.id, a.r, a.c);
}

/* -------------------------------------------------------------------------- */
/* Threads                                                                     */
/* -------------------------------------------------------------------------- */

/** An empty table frame that a table runs on into. */
function makeContinuation(head: TableElement, box: { x: number; y: number; w: number; h: number }): TableElement {
  return makeTable({
    name: `${head.name} (continued)`, ...box, rows: [], cols: [], cells: [], headerRows: 0, footerRows: 0,
    tableStyle: null, autoHeight: false, fitWidth: head.fitWidth,
  });
}

type DraftTable = Draft<TableElement>;
const draftTable = (d: Draft<Project>, id: string): DraftTable | null => {
  const loc = findElement(d as Project, id);
  if (!loc || loc.el.type !== 'table') return null;
  return surfaceElementsDraft(d as Project, loc.key)![loc.index] as DraftTable;
};

/** Frames of a thread stop at the foot of their page's text block; the head stops following its rows. */
function settleThread(d: Draft<Project>, ids: string[]) {
  const p = d as Project;
  ids.forEach((id, i) => {
    const t = draftTable(d, id);
    const loc = findElement(p, id);
    if (!t || !loc) return;
    if (i === 0) t.autoHeight = false;
    if (loc.pageIndex == null) return;
    const blk = textBlock(p.book, pageSide(p, loc.pageIndex));
    const foot = blk.y + blk.h;
    if (t.y + t.h > foot + 0.5 && foot - t.y > 24) t.h = +(foot - t.y).toFixed(2);
  });
}

/** Continue `fromId`'s table in the frame `toId` (inserted after it in the thread). */
function linkFrames(d: Draft<Project>, fromId: string, toId: string) {
  const from = draftTable(d, fromId), to = draftTable(d, toId);
  if (!from || !to) return;
  to.flowNext = from.flowNext ?? null;
  from.flowNext = toId;
}

/** Frames can only be threaded within one "place": the document's pages, one master, the cover or the jacket. */
const domainOf = (key: string) => (key.startsWith('master:') ? key.split(':').slice(0, 2).join(':') : key.startsWith('page:') ? 'pages' : key);
const placeName = (key: string) => (key.startsWith('master:') ? 'a master page' : key.startsWith('page:') ? 'the document pages' : key === 'jacket' ? 'the dust jacket' : 'the cover');

function domainError(fromKey: string, toKey: string): string | null {
  if (domainOf(fromKey) === domainOf(toKey)) return null;
  if (fromKey.startsWith('master:')) return 'A table on a master continues only on the same master (its left or right page): a master repeats on many pages, so it cannot run on into one document page.';
  if (toKey.startsWith('master:')) return 'A table on the document pages cannot continue on a master page — master items repeat on every page that uses them.';
  return `A table on ${placeName(fromKey)} continues only on ${placeName(fromKey)}.`;
}

/** Where "continue in a new frame" would put the next frame, or why it cannot. */
export function continueTarget(project: Project, frameId: string): { ok: boolean; label: string; why?: string } {
  const th = tableThreadOf(project, frameId);
  const last = th?.frames[th.frames.length - 1];
  if (!last) return { ok: false, label: 'Continue in a new frame on the next page', why: 'Place the table on a page first.' };
  if (last.surface.startsWith('master:')) {
    if (last.surface.endsWith(':left') && project.book.facing) return { ok: true, label: 'Continue on the master’s right page' };
    return { ok: false, label: 'Continue on a further page', why: 'A master table can run from the master’s left page to its right page only — a master repeats on many pages, so it cannot continue onto one document page.' };
  }
  if (last.pageIndex == null) return { ok: false, label: 'Continue in a new frame on the next page', why: 'A table on the cover or jacket cannot run on to another page; thread it to another table frame on the cover instead.' };
  return { ok: true, label: 'Continue in a new frame on the next page' };
}

/**
 * A click while threading a table (Editor linking mode). Returns false when the frame being
 * threaded is not a table, so text threading handles the click.
 */
export function tableLinkClick(linkingId: string, hit: Element | null, at: { key: string; kind: string; side: PageSide; x: number; y: number } | null): boolean {
  const from = findTable(linkingId);
  if (!from) return false;
  const s = useStore.getState();
  const project = s.project;
  const th = tableThreadOf(project, from.id);
  const head = th?.head ?? from;
  const fromKey = findElement(project, from.id)?.key ?? '';
  const toKey = hit ? findElement(project, hit.id)?.key ?? '' : at?.key ?? '';
  const bad = toKey ? domainError(fromKey, toKey) : null;
  if (bad) { s.notify(bad, 'error'); return true; }
  if (hit) {
    if (hit.type !== 'table') { s.notify('A table continues only in a table frame — click an empty table frame, or an empty spot to make one.', 'error'); return true; }
    if (th?.frames.some((f) => f.el.id === hit.id) || hit.id === from.id) { s.notify('That frame is already part of this table.', 'error'); return true; }
    const other = tableThreadOf(project, hit.id);
    if (hasContent(hit) || (other && other.frames.length > 1)) { s.notify('That table has rows of its own — continue into an empty table frame, or click an empty spot to make one.', 'error'); return true; }
    s.update((d) => { linkFrames(d, from.id, hit.id); settleThread(d, [...(th?.frames.map((f) => f.el.id) ?? [from.id]), hit.id]); });
    s.notify('The table continues in that frame: rows flow on and the head repeats.');
    return true;
  }
  if (!at) return true;
  const L = layoutOf(project, head);
  let h = 200;
  if (at.kind === 'page' || at.kind === 'master') {
    const blk = textBlock(project.book, at.side);
    h = Math.max(60, blk.y + blk.h - at.y);
  }
  const frame = makeContinuation(head, { x: at.x, y: at.y, w: L.width || head.w, h });
  s.update((d) => {
    surfaceElementsDraft(d as Project, at.key)?.push(frame as Draft<Element>);
    linkFrames(d, from.id, frame.id);
    settleThread(d, [...(th?.frames.map((f) => f.el.id) ?? [from.id]), frame.id]);
  });
  s.notify('New frame made — the table continues there.');
  return true;
}

/** Panel action: continue the table in a new frame at the head of the text block on the next page. */
export function continueTableOnNextPage(frameId: string) {
  const s = useStore.getState();
  const project = s.project;
  const t = findTable(frameId);
  const th = t ? tableThreadOf(project, t.id) : null;
  if (!t || !th) { s.notify('Place the table on a page first.', 'error'); return; }
  const last = th.frames[th.frames.length - 1];
  const target = continueTarget(project, t.id);
  if (!target.ok) { s.notify(target.why ?? 'The table cannot continue from here.', 'error'); return; }
  if (last.surface.startsWith('master:')) {
    // A master spread: from the left page to the right one.
    const key = last.surface.replace(/:left$/, ':right');
    const blk = textBlock(project.book, 'right');
    const L0 = layoutOf(project, th.head);
    const frame = makeContinuation(th.head, { x: blk.x, y: blk.y, w: L0.width || th.head.w, h: blk.h });
    s.update((d) => {
      surfaceElementsDraft(d as Project, key)?.push(frame as Draft<Element>);
      linkFrames(d, last.el.id, frame.id);
      settleThread(d, [...th.frames.map((f) => f.el.id), frame.id]);
    });
    s.notify('The table continues on the master’s right page.');
    return;
  }
  if (last.pageIndex == null) return;
  const next = last.pageIndex + 1;
  if (next >= project.pages.length) insertPages(project.pages.length - 1, 2, project.pages[last.pageIndex].masterId);
  const p2 = useStore.getState().project;
  const blk = textBlock(p2.book, pageSide(p2, next));
  const L = layoutOf(p2, th.head);
  const frame = makeContinuation(th.head, { x: blk.x, y: blk.y, w: L.width || th.head.w, h: blk.h });
  const nextId = p2.pages[next].id;
  s.update((d) => {
    d.pages.find((pg) => pg.id === nextId)?.elements.push(frame as Draft<Element>);
    linkFrames(d, last.el.id, frame.id);
    settleThread(d, [...th.frames.map((f) => f.el.id), frame.id]);
  });
  s.notify(`The table continues on page ${next + 1}.`);
}

/** Break the thread after this frame (the frames after it keep nothing). */
export function unthreadTable(frameId: string) {
  useStore.getState().updateElement(frameId, (d) => { (d as DraftTable).flowNext = null; });
}

/* -------------------------------------------------------------------------- */
/* Frame auto-fit                                                              */
/* -------------------------------------------------------------------------- */

interface Seen { w: number; h: number; natH: number; natW: number }
const seen = new Map<string, Seen>();

/** Keep the frame on the table: content changes resize the frame, frame drags scale rows / columns. */
function autoFit(el: TableElement, L: TableLayout, threaded: boolean, head: boolean): ((d: Draft<Element>) => void) | null {
  const prev = seen.get(el.id);
  const hug = !el.fitWidth && !L.hasFr;
  let fn: ((d: Draft<TableElement>) => void) | null = null;
  const chain = (f: (d: Draft<TableElement>) => void) => { const g = fn; fn = (d) => { g?.(d); f(d); }; };

  if (threaded && !head) {
    // A continuation frame is as wide as its table; its height is the frame's own.
    if (L.rowMap.length && Math.abs(el.w - L.width) > 0.05) chain((d) => { d.w = +L.width.toFixed(3); });
  } else {
    if (hug && Math.abs(el.w - L.width) > 0.05) {
      if (prev && Math.abs(prev.w - el.w) > 0.05 && Math.abs(prev.natW - L.width) < 0.05 && L.width > 0) {
        const k = el.w / L.width;
        chain((d) => { d.cols.forEach((col, c) => { col.mode = 'fixed'; col.w = +(L.colW[c] * k).toFixed(2); }); });
      } else chain((d) => { d.w = +L.width.toFixed(3); });
    }
    if (!threaded && el.autoHeight && Math.abs(el.h - L.height) > 0.05) {
      if (!el.fillHeight && prev && Math.abs(prev.h - el.h) > 0.05 && Math.abs(prev.natH - L.naturalHeight) < 0.05 && L.naturalHeight > 0) {
        const k = el.h / L.naturalHeight;
        chain((d) => {
          d.rows.forEach((row, r) => {
            const h = +(L.rowH[r] * k).toFixed(2);
            if (row.mode === 'fixed') row.h = h;
            else if (h <= L.contentMin[r] + 0.05) { row.mode = 'auto'; row.h = 0; }
            else { row.mode = 'min'; row.h = h; }
          });
        });
      } else chain((d) => { d.h = +L.height.toFixed(3); });
    }
  }
  seen.set(el.id, { w: el.w, h: el.h, natH: L.naturalHeight, natW: L.width });
  const f = fn as ((d: Draft<TableElement>) => void) | null;
  return f ? (d) => f(d as Draft<TableElement>) : null;
}

/* -------------------------------------------------------------------------- */
/* Overlay                                                                     */
/* -------------------------------------------------------------------------- */

interface OverlayProps {
  items: { el: Element; surface: SurfaceDesc }[];
  selection: string[];
  tool: Tool;
  zoom: number;
  pan: Pt;
  size: { w: number; h: number };
  calc: PanelLayout | null;
  project: Project;
}

type Drag =
  | { k: 'col'; index: number; start: Pt; widths: number[] }
  | { k: 'row'; row: number; start: Pt; h0: number; min: number; fixed: boolean }
  | { k: 'range'; from: { r: number; c: number } };

const HANDLE_POS: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

export function TableOverlay({ items, selection, tool, zoom, pan, size, calc, project }: OverlayProps) {
  const ui = useTableUi();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointerDown = useRef(false);
  const [tick, setTick] = useState(0);
  const [cursor, setCursor] = useState('inherit');

  const tables = useMemo(() => items.filter((x) => x.el.type === 'table' && !x.el.hidden) as { el: TableElement; surface: SurfaceDesc }[], [items]);
  const single = selection.length === 1 ? tables.find((x) => x.el.id === selection[0]) ?? null : null;
  const active = single && tool === 'select' && !single.el.locked ? single : null;
  const head = active ? tableHead(project, active.el) : null;
  const thread = active ? tableThreadOf(project, active.el.id) : null;

  // Leaving the table (selection change) leaves cell mode.
  useEffect(() => {
    if (ui.tableId && (!single || single.el.id !== ui.tableId)) useTableUi.getState().clear();
  }, [single?.el.id, ui.tableId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the pointer so the auto-fit never fights a drag.
  useEffect(() => {
    const down = () => { pointerDown.current = true; };
    const up = () => { if (pointerDown.current) { pointerDown.current = false; setTick((t) => t + 1); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
  }, []);

  const layouts = useMemo(() => new Map(tables.map(({ el, surface }) => [el.id, layoutTable(el, { project, pageIndex: surface.pageIndex })])), [tables, project]);

  useEffect(() => {
    if (pointerDown.current) return;
    for (const { el } of tables) {
      if (el.locked) continue;
      const L = layouts.get(el.id);
      if (!L) continue;
      const th = tableThreadOf(project, el.id);
      const threaded = !!th && th.frames.length > 1;
      const fn = autoFit(el, L, threaded, !threaded || th!.index === 0);
      if (fn) useStore.getState().updateElement(el.id, fn, { history: false });
    }
  }, [tables, layouts, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The cell being edited or picked lives in another frame of the thread: follow it there.
  useEffect(() => {
    if (!active || !thread || thread.frames.length < 2 || ui.tableId !== active.el.id) return;
    const cell = ui.editing ?? ui.anchor;
    if (!cell) return;
    const shows = (L: TableLayout) => L.cells.some((b) => !b.ghost && b.r === cell.r && b.c === cell.c);
    if (shows(layouts.get(active.el.id) ?? layoutOf(project, active.el))) return;
    const target = thread.frames.find((f) => shows(layoutTable(f.el, { project, pageIndex: f.pageIndex })));
    if (!target || target.el.id === active.el.id) return;
    const s = useStore.getState();
    if (target.pageIndex != null && !s.masterEdit) {
      const sp = spreadIndexOfPage(project, target.pageIndex);
      if (sp !== s.spread) s.setSpread(sp);
    }
    s.select([target.el.id]);
    useTableUi.getState().moveTo(target.el.id);
  }, [ui.editing, ui.anchor, active?.el.id, layouts]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- keyboard */
  useEffect(() => {
    if (!active) return;
    const el = active.el;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      const st = useTableUi.getState();
      if (isField(e.target) || st.editing) return;
      const t = findHead(el.id) ?? el;
      if (!t.rows.length) return;
      // Enter on a selected table steps into its first cell.
      if ((st.tableId !== el.id || !st.sel) && e.key === 'Enter' && !e.metaKey && !e.ctrlKey && useStore.getState().selection.join() === el.id) {
        e.preventDefault(); e.stopPropagation();
        const L = layoutOf(useStore.getState().project, findTable(el.id) ?? el);
        const r0 = L.rowMap.find((_, d) => L.rowPiece[d] < 0) ?? 0;
        st.setSel(el.id, cellRange(t, r0, 0), { r: r0, c: 0 });
        return;
      }
      if (st.tableId !== el.id || !st.sel) return;
      const g = selectedTableRange(t)!;
      if (!g) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = useStore.getState();
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      const focus = st.anchor ?? { r: g.r0, c: g.c0 };
      const clearCells = () => s.updateElement(t.id, (d) => { const tt = d as DraftTable; for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) tt.cells[r][c].text = ''; });
      if (e.key === 'Escape') { stop(); st.clear(); return; }
      if (e.key === 'Enter' || e.key === 'F2') { stop(); st.edit(el.id, g.r0, g.c0); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { stop(); clearCells(); return; }
      if (e.key === 'Tab') {
        stop();
        const order = anchorsOf(t).sort((a, b) => a.r - b.r || a.c - b.c);
        const i = order.findIndex((a) => a.r === g.r0 && a.c === g.c0);
        const j = i + (e.shiftKey ? -1 : 1);
        if (j >= order.length) {
          // Tab in the last cell adds a row, like InDesign.
          s.updateElement(t.id, (d) => insertRows(d as unknown as TableElement, t.rows.length, 1));
          st.setSel(el.id, cellRange(findTable(t.id) ?? t, t.rows.length, 0), { r: t.rows.length, c: 0 });
          return;
        }
        const a = order[Math.max(0, j)];
        st.setSel(el.id, cellRange(t, a.r, a.c), { r: a.r, c: a.c });
        return;
      }
      if (e.key.startsWith('Arrow') && !mod) {
        stop();
        const dr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (e.shiftKey) {
          // Extend the far edge of the range away from the anchor.
          const far = { r: dr > 0 ? g.r1 + 1 : dr < 0 ? (focus.r > g.r0 ? g.r0 - 1 : g.r1 - 1) : (focus.r === g.r0 ? g.r1 : g.r0), c: dc > 0 ? g.c1 + 1 : dc < 0 ? (focus.c > g.c0 ? g.c0 - 1 : g.c1 - 1) : (focus.c === g.c0 ? g.c1 : g.c0) };
          if (dr < 0 && focus.r === g.r0 && g.r1 > g.r0) far.r = g.r1 - 1;
          if (dc < 0 && focus.c === g.c0 && g.c1 > g.c0) far.c = g.c1 - 1;
          const R = t.rows.length - 1, C = t.cols.length - 1;
          const to = { r: Math.max(0, Math.min(R, far.r)), c: Math.max(0, Math.min(C, far.c)) };
          st.setSel(el.id, expandRange(t, normRange(focus, to)), focus);
        } else {
          const r = dr > 0 ? g.r1 + 1 : dr < 0 ? g.r0 - 1 : g.r0;
          const c = dc > 0 ? g.c1 + 1 : dc < 0 ? g.c0 - 1 : g.c0;
          if (r < 0 || c < 0 || r >= t.rows.length || c >= t.cols.length) return;
          const a = anchorAt(t, r, c)!;
          st.setSel(el.id, cellRange(t, a.r, a.c), { r: a.r, c: a.c });
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') { stop(); st.setSel(el.id, { r0: 0, c0: 0, r1: t.rows.length - 1, c1: t.cols.length - 1 }, { r: 0, c: 0 }); return; }
      if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
        stop();
        void navigator.clipboard?.writeText(rangeToTSV(t, g)).catch(() => undefined);
        if (e.key.toLowerCase() === 'x') clearCells();
        else s.notify(`Copied ${rangeLabel(g)} as tab-separated text.`);
        return;
      }
      // ⌘V: keep the canvas from pasting items; the paste event below fills the cells.
      if (mod && e.key.toLowerCase() === 'v') { e.stopPropagation(); return; }
      if (mod && e.key.toLowerCase() === 'z') return;
      if (!mod && !e.altKey && e.key.length === 1) { stop(); st.edit(el.id, g.r0, g.c0, e.key); }
    };
    const onPaste = (e: ClipboardEvent) => {
      const st = useTableUi.getState();
      if (st.tableId !== el.id || !st.sel || st.editing || isField(e.target)) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      const t = findHead(el.id) ?? el;
      const g = selectedTableRange(t);
      if (!g) return;
      const data = parseDelimited(text);
      let filled: CellRange | null = null;
      useStore.getState().updateElement(t.id, (d) => { filled = fillCells(d as unknown as TableElement, data, { r: g.r0, c: g.c0 }); });
      if (filled) st.setSel(el.id, filled, { r: g.r0, c: g.c0 });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('paste', onPaste); };
  }, [active?.el.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- geometry */
  const screenM = (el: Element, surface: SurfaceDesc): Matrix => multiply(translate(pan.x, pan.y), multiply(scaleM(zoom), sceneMatrix(el, surface, calc)));
  const sp = (m: Matrix, x: number, y: number) => { const [a, b] = applyMatrix(m, x, y); return { x: a, y: b }; };
  const poly = (m: Matrix, x: number, y: number, w: number, h: number) => [sp(m, x, y), sp(m, x + w, y), sp(m, x + w, y + h), sp(m, x, y + h)].map((q) => `${q.x},${q.y}`).join(' ');

  const localOf = (e: { clientX: number; clientY: number }, el: Element, surface: SurfaceDesc): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    const m = invert(screenM(el, surface));
    const [x, y] = applyMatrix(m, e.clientX - r.left, e.clientY - r.top);
    return { x, y };
  };

  const activeL = active ? layouts.get(active.el.id) ?? null : null;
  const sel = active && head && activeL && ui.tableId === active.el.id ? selectedTableRange(head) : null;

  const nearHandle = (el: TableElement, p: Pt) => {
    const tol = 7 / zoom;
    return HANDLE_POS.some(([hx, hy]) => Math.abs(p.x - hx * el.w) < tol && Math.abs(p.y - hy * el.h) < tol);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || !activeL || !head || e.button !== 0 || !head.rows.length) return;
    const el = active.el;
    const p = localOf(e, el, active.surface);
    if (nearHandle(el, p)) return;
    const tol = 4 / zoom;
    const b = borderAt(activeL, p, tol);
    const s = useStore.getState();
    if (b) {
      e.stopPropagation();
      s.checkpoint();
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
      if (b.axis === 'col') drag.current = { k: 'col', index: b.index, start: p, widths: [...activeL.colW] };
      else drag.current = { k: 'row', row: b.row, start: p, h0: activeL.rowH[b.row], min: activeL.contentMin[b.row], fixed: head.rows[b.row].mode === 'fixed' };
      return;
    }
    const slot = slotAt(activeL, p);
    // The outer edge always moves the frame.
    const edge = Math.min(p.x, p.y, activeL.width - p.x, activeL.height - p.y) < 5 / zoom;
    if (!slot || edge) return;
    const st = useTableUi.getState();
    if (st.tableId === el.id && st.sel) {
      e.stopPropagation();
      (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
      if (e.shiftKey && st.anchor) st.setSel(el.id, expandRange(head, normRange(st.anchor, slot)));
      else st.setSel(el.id, cellRange(head, slot.r, slot.c), slot);
      drag.current = { k: 'range', from: e.shiftKey && st.anchor ? st.anchor : slot };
      return;
    }
    // Frame mode: the canvas moves the table; a click that does not move picks the cell.
    const x0 = e.clientX, y0 = e.clientY;
    const up = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) return;
      const cur = findHead(el.id);
      if (!cur || useStore.getState().selection.join() !== el.id) return;
      useTableUi.getState().setSel(el.id, cellRange(cur, slot.r, slot.c), slot);
    };
    window.addEventListener('pointerup', up, { once: true });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!active || !activeL || !head) return;
    const el = active.el;
    const p = localOf(e, el, active.surface);
    const d = drag.current;
    const s = useStore.getState();
    if (!d) {
      const b = nearHandle(el, p) ? null : borderAt(activeL, p, 4 / zoom);
      const inCells = ui.tableId === el.id && !!ui.sel;
      setCursor(b ? (b.axis === 'col' ? 'col-resize' : 'row-resize') : inCells ? 'cell' : 'inherit');
      return;
    }
    e.stopPropagation();
    if (d.k === 'col') {
      const i = d.index - 1, j = d.index;
      const dx = p.x - d.start.x;
      const total = d.widths[i] + d.widths[j];
      const wi = Math.max(6, Math.min(total - 6, d.widths[i] + dx));
      const widths = [...d.widths];
      widths[i] = wi; widths[j] = total - wi;
      s.updateElement(head.id, (dr) => setColumnWidths(dr as DraftTable, widths, [i, j]), { history: false });
    } else if (d.k === 'row') {
      const h = Math.max(d.fixed || e.shiftKey ? 2 : d.min, d.h0 + (p.y - d.start.y));
      s.updateElement(head.id, (dr) => {
        const row = (dr as DraftTable).rows[d.row];
        if (d.fixed || e.shiftKey) { row.mode = 'fixed'; row.h = +h.toFixed(2); }
        else if (h <= d.min + 0.05) { row.mode = 'auto'; row.h = 0; }
        else { row.mode = 'min'; row.h = +h.toFixed(2); }
      }, { history: false });
    } else if (d.k === 'range') {
      const slot = slotAt(activeL, { x: Math.max(0, Math.min(activeL.width, p.x)), y: Math.max(0, Math.min(activeL.height - 0.01, p.y)) });
      if (slot) useTableUi.getState().setSel(el.id, expandRange(head, normRange(d.from, slot)), d.from);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    e.stopPropagation();
    drag.current = null;
    try { (e.currentTarget as SVGElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
  };

  /* ---------------------------------------------------------------- render */
  const markers: React.ReactNode[] = [];
  for (const { el, surface } of tables) {
    const L = layouts.get(el.id);
    if (!L) continue;
    const m = screenM(el, surface);
    // An empty table frame (a continuation not threaded to anything) shows on screen only.
    if (!L.rowMap.length) markers.push(<polygon key={`e${el.id}`} points={poly(m, 0, 0, el.w, el.h)} fill="none" stroke="#9a8f7e" strokeWidth={1} strokeDasharray="5 4" />);
    for (const b of L.cells) {
      if (!b.overflow) continue;
      const q = sp(m, b.x + b.w, b.y + b.h);
      markers.push(<circle key={`o${el.id}${b.r}-${b.c}`} cx={q.x - 5} cy={q.y - 5} r={3} fill="#e5483a" stroke="#fff" strokeWidth={0.8}><title>Overset text in this cell</title></circle>);
    }
    if (L.overset && !(active && active.el.id === el.id)) {
      const q = sp(m, el.w, el.h);
      markers.push(
        <g key={`ov${el.id}`}>
          <rect x={q.x - 5} y={q.y - 5} width={10} height={10} fill="#e5483a" stroke="#4aa3ff" />
          <text x={q.x} y={q.y + 3.5} textAnchor="middle" fontSize={10} fill="#fff" style={{ fontFamily: 'ui-sans-serif' }}>+</text>
        </g>,
      );
    }
  }

  // Where a thread goes off this spread: "from p. 5" at the frame's head, "to p. 7" at its foot.
  const visible = new Set(tables.map((x) => x.el.id));
  const where = (f: { pageIndex: number | null; surface: string }) => (f.pageIndex != null ? `p. ${f.pageIndex + 1}` : f.surface.startsWith('master:') ? `master ${f.surface.endsWith(':left') ? 'left' : 'right'}` : f.surface);
  const goTo = (f: { el: TableElement; pageIndex: number | null }) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const s = useStore.getState();
    if (f.pageIndex != null && !s.masterEdit) s.setSpread(spreadIndexOfPage(project, f.pageIndex));
    s.select([f.el.id]);
  };
  const chip = (key: string, x: number, y: number, text: string, anchor: 'start' | 'end', color: string, title: string, onDown?: (e: React.PointerEvent) => void) => {
    const w = text.length * 5.4 + 10;
    const x0 = anchor === 'start' ? x : x - w;
    return (
      <g key={key} style={{ pointerEvents: onDown ? 'all' : 'none', cursor: onDown ? 'pointer' : 'default' }} onPointerDown={onDown}>
        <title>{title}</title>
        <rect x={x0} y={y - 8} width={w} height={15} rx={7.5} fill={color} />
        <text x={x0 + w / 2} y={y + 3} textAnchor="middle" fontSize={9.5} fill="#fff" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>{text}</text>
      </g>
    );
  };
  const chips: React.ReactNode[] = [];
  for (const { el, surface } of tables) {
    const m = screenM(el, surface);
    const L = layouts.get(el.id);
    const th = tableThreadOf(project, el.id);
    if (th && th.frames.length > 1) {
      const prev = th.frames[th.index - 1], next = th.frames[th.index + 1];
      if (prev && !visible.has(prev.el.id)) { const q = sp(m, 0, 0); chips.push(chip(`cf${el.id}`, q.x - 4, q.y + 24, `from ${where(prev)}`, 'end', '#5aa9e6', `Continued from ${where(prev)} — click to go there`, goTo(prev))); }
      if (next && !visible.has(next.el.id)) { const q = sp(m, el.w, el.h); chips.push(chip(`ct${el.id}`, q.x + 4, q.y + 12, `continues on ${where(next)}`, 'start', '#5aa9e6', `Continues on ${where(next)} — click to go there`, goTo(next))); }
    }
    if (L?.stuck) {
      const q = sp(m, 0, el.h);
      const rowsTxt = L.stuck.r0 === L.stuck.r1 ? `row ${L.stuck.r0 + 1}` : `rows ${L.stuck.r0 + 1}–${L.stuck.r1 + 1}`;
      chips.push(chip(`st${el.id}`, q.x, q.y + 12, `⚠ ${rowsTxt} taller than the frame`, 'start', '#e5483a', 'These rows do not fit even an empty frame. Allow rows to break across frames (Table panel), make the frame taller, or shrink the rows — they are not printed until they fit.'));
    }
  }

  // Thread lines between the frames of the selected table that are on screen.
  const threadLines: React.ReactNode[] = [];
  if (thread && thread.frames.length > 1) {
    for (let i = 0; i + 1 < thread.frames.length; i++) {
      const a = tables.find((x) => x.el.id === thread.frames[i].el.id), b = tables.find((x) => x.el.id === thread.frames[i + 1].el.id);
      if (!a || !b) continue;
      const p0 = sp(screenM(a.el, a.surface), a.el.w, a.el.h), p1 = sp(screenM(b.el, b.surface), 0, 0);
      threadLines.push(<path key={`th${i}`} d={`M${p0.x} ${p0.y} C${p0.x + 50} ${p0.y} ${p1.x - 50} ${p1.y} ${p1.x} ${p1.y}`} fill="none" stroke="#5aa9e6" strokeWidth={1.2} strokeDasharray="4 3" />);
    }
  }

  let editorNode: React.ReactNode = null;
  if (active && activeL && head && ui.editing && ui.tableId === active.el.id) {
    const box = activeL.cells.find((b) => !b.ghost && b.r === ui.editing!.r && b.c === ui.editing!.c);
    if (box) {
      const m = screenM(active.el, active.surface);
      const pts = [sp(m, box.x, box.y), sp(m, box.x + box.w, box.y), sp(m, box.x + box.w, box.y + box.h), sp(m, box.x, box.y + box.h)];
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      editorNode = <CellEditor key={`${head.id}:${ui.editing.r}:${ui.editing.c}`} el={head} frameId={active.el.id} r={ui.editing.r} c={ui.editing.c} initial={ui.editing.initial} rect={rect} viewport={size} />;
    }
  }

  const startLinking = (e: React.PointerEvent) => {
    if (!active) return;
    e.stopPropagation();
    e.preventDefault();
    const s = useStore.getState();
    s.setLinking(active.el.id);
    s.notify('Click an empty table frame, or an empty spot on any page, to continue the table there (Esc cancels).');
  };

  return (
    <>
      <svg ref={svgRef} width={size.w} height={size.h} className="absolute inset-0 select-none" style={{ pointerEvents: 'none' }}>
        {threadLines}
        {active && activeL && head && (() => {
          const el = active.el;
          const m = screenM(el, active.surface);
          const grid: string[] = [];
          for (const b of activeL.cells) grid.push(`M${poly(m, b.x, b.y, b.w, b.h).split(' ').join('L')}Z`);
          const inSel = (b: { r: number; c: number }) => !!sel && b.r >= sel.r0 && b.r <= sel.r1 && b.c >= sel.c0 && b.c <= sel.c1;
          const br = sp(m, el.w, el.h), tl = sp(m, 0, 0);
          const out = { x: br.x + 9, y: br.y - 9 }, inp = { x: tl.x - 9, y: tl.y + 9 };
          const idx = thread?.index ?? 0, n = thread?.frames.length ?? 1;
          return (
            <g>
              <path d={grid.join('')} fill="none" stroke="#4aa3ff" strokeOpacity={0.45} strokeWidth={0.75} strokeDasharray="3 3" />
              {activeL.cells.filter(inSel).map((b) => <polygon key={`s${b.r}-${b.c}`} points={poly(m, b.x, b.y, b.w, b.h)} fill="rgba(74,163,255,0.16)" stroke="#4aa3ff" strokeWidth={1.25} />)}
              {sel && el.rotation === 0 && (
                <g style={{ fontFamily: 'ui-monospace, monospace' }} fontSize={9.5}>
                  {activeL.colW.map((w, c) => {
                    const q = sp(m, activeL.colX[c] + w / 2, 0);
                    const on = c >= sel.c0 && c <= sel.c1;
                    return <text key={`cl${c}`} x={q.x} y={q.y - 6} textAnchor="middle" fill={on ? '#4aa3ff' : 'rgba(150,170,200,0.75)'}>{colLetter(c)}</text>;
                  })}
                  {activeL.rowY.slice(0, -1).map((y, d) => {
                    const q = sp(m, 0, (y + activeL.rowY[d + 1]) / 2);
                    const r = activeL.rowMap[d];
                    const on = r >= sel.r0 && r <= sel.r1;
                    return <text key={`rl${d}`} x={q.x - 6} y={q.y + 3.5} textAnchor="end" fill={on ? '#4aa3ff' : 'rgba(150,170,200,0.75)'}>{r + 1}{activeL.rowPiece[d] > 0 ? '…' : ''}</text>;
                  })}
                </g>
              )}
              <polygon
                points={poly(m, 0, 0, Math.max(activeL.width, 1), Math.max(activeL.height, 1))}
                fill="transparent"
                style={{ pointerEvents: 'all', cursor }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
              {idx > 0 && (
                <g>
                  <title>Continued from frame {idx} of this table</title>
                  <rect x={inp.x - 5} y={inp.y - 5} width={10} height={10} fill="#5aa9e6" stroke="#fff" />
                  <path d={`M${inp.x - 2} ${inp.y - 3}L${inp.x + 2.5} ${inp.y}L${inp.x - 2} ${inp.y + 3}`} fill="none" stroke="#fff" strokeWidth={1.4} />
                </g>
              )}
              <g style={{ pointerEvents: 'all', cursor: 'pointer' }} onPointerDown={startLinking}>
                <title>{activeL.overset ? 'Overset rows — click, then click an empty table frame or a spot on a page to continue the table' : el.flowNext ? `Continues in frame ${idx + 2} of ${n} — click to thread into another frame` : 'Continue the table in another frame'}</title>
                <rect x={out.x - 6} y={out.y - 6} width={12} height={12} fill={activeL.overset ? '#e5483a' : el.flowNext ? '#5aa9e6' : '#fff'} stroke="#4aa3ff" />
                {activeL.overset ? <text x={out.x} y={out.y + 3.8} textAnchor="middle" fontSize={11} fill="#fff" style={{ fontFamily: 'ui-sans-serif' }}>+</text>
                  : el.flowNext ? <path d={`M${out.x - 2} ${out.y - 3}L${out.x + 2.5} ${out.y}L${out.x - 2} ${out.y + 3}`} fill="none" stroke="#fff" strokeWidth={1.4} /> : null}
              </g>
            </g>
          );
        })()}
        {markers}
        {chips}
      </svg>
      {editorNode}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Cell editor                                                                 */
/* -------------------------------------------------------------------------- */

function CellEditor({ el, frameId, r, c, initial, rect, viewport }: { el: TableElement; frameId: string; r: number; c: number; initial?: string; rect: { x: number; y: number; w: number; h: number }; viewport: { w: number; h: number } }) {
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const checkpointed = useRef(false);
  const live = findTable(el.id) ?? el;
  const text = live.cells[r]?.[c]?.text ?? '';
  const paraStyles = project.paragraphStyles ?? [];
  const charStyles = project.characterStyles ?? [];

  const setText = (v: string) => {
    const s = useStore.getState();
    if (!checkpointed.current) { s.checkpoint(); checkpointed.current = true; }
    s.updateElement(el.id, (d) => { const cell = (d as DraftTable).cells[r]?.[c]; if (cell) cell.text = v; }, { history: false });
  };

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    if (initial != null) { setText(initial); requestAnimationFrame(() => ta.setSelectionRange(initial.length, initial.length)); }
    else ta.setSelectionRange(ta.value.length, ta.value.length);
    const away = (e: PointerEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) useTableUi.getState().stopEditing(); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (dir: 1 | -1) => {
    const t = findTable(el.id) ?? el;
    const order = anchorsOf(t, coverMap(t)).sort((a, b) => a.r - b.r || a.c - b.c);
    const i = order.findIndex((a) => a.r === r && a.c === c);
    const j = i + dir;
    if (j < 0) return;
    if (j >= order.length) {
      useStore.getState().updateElement(el.id, (d) => insertRows(d as unknown as TableElement, t.rows.length, 1));
      useTableUi.getState().edit(frameId, t.rows.length, 0);
      return;
    }
    useTableUi.getState().edit(frameId, order[j].r, order[j].c);
  };

  const wrap = (before: string, after = before) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    setText(value.slice(0, a) + before + value.slice(a, b) + after + value.slice(b));
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + before.length, b + before.length); });
  };
  const paraTag = (name: string | null) => {
    const ta = ref.current;
    if (!ta) return;
    const names = new Set(paraStyles.map((p) => p.name.toLowerCase()));
    const lines = ta.value.split('\n').map((ln) => {
      const m = /^\[([^\]]{1,60})\]\s*/.exec(ln);
      const bare = m && names.has(m[1].trim().toLowerCase()) ? ln.slice(m[0].length) : ln;
      return name && bare.trim() ? `[${name}] ${bare}` : bare;
    });
    setText(lines.join('\n'));
    requestAnimationFrame(() => ta.focus());
  };

  const width = Math.min(380, Math.max(260, rect.w));
  let left = rect.x;
  if (left + width > viewport.w - 8) left = Math.max(8, viewport.w - width - 8);
  let top = rect.y + rect.h + 6;
  if (top + 170 > viewport.h) top = Math.max(8, rect.y - 176);
  const tb = 'inline-flex h-6 w-6 items-center justify-center rounded text-ink-300 hover:bg-ink-600 hover:text-ink-100';
  const selCls = 'h-6 max-w-[92px] rounded border border-ink-600 bg-ink-800 px-1 text-[10.5px] text-ink-200 outline-none';
  return (
    <div
      ref={boxRef}
      className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-850/97 shadow-2xl backdrop-blur"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-0.5 border-b border-ink-700 px-1.5 py-1">
        <span className="mr-1 font-mono text-[10.5px] font-semibold text-ink-400">{rangeLabel({ r0: r, c0: c, r1: r, c1: c })}</span>
        <button type="button" title="Previous cell (⇧Tab)" className={tb} onClick={() => move(-1)}><ChevronLeft size={13} /></button>
        <button type="button" title="Next cell (Tab)" className={tb} onClick={() => move(1)}><ChevronRight size={13} /></button>
        <span className="mx-0.5 h-4 w-px bg-ink-700" />
        <button type="button" title="Italic (*text*)" className={tb} onClick={() => wrap('*')}><Italic size={13} /></button>
        <button type="button" title="Bold (**text**)" className={tb} onClick={() => wrap('**')}><Bold size={13} /></button>
        <button type="button" title="Small caps (^text^)" className={tb} onClick={() => wrap('^')}><CaseSensitive size={14} /></button>
        <select className={selCls} value="" title="Paragraph style for the cell's paragraphs" onChange={(e) => { const v = e.target.value; if (v === '__none') paraTag(null); else if (v) paraTag(v); }}>
          <option value="">¶ Para…</option>
          <option value="__none">No paragraph style</option>
          {paraStyles.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
        <select className={selCls} value="" title="Character style for the selected words" onChange={(e) => { const v = e.target.value; if (v) wrap(`<${v}>`, `</${v}>`); }}>
          <option value="">a Char…</option>
          {charStyles.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
        </select>
        <span className="flex-1" />
        <button type="button" title="Done (Esc)" className={tb} onClick={() => useTableUi.getState().stopEditing()}><X size={13} /></button>
      </div>
      <textarea
        ref={ref}
        value={text}
        spellCheck
        lang={el.style.language}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); useTableUi.getState().stopEditing(); return; }
          if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); return; }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
        }}
        rows={3}
        className="scroll-thin min-h-[64px] w-full resize-y bg-transparent px-2.5 py-1.5 font-serif text-[13.5px] leading-[1.4] text-ink-100 outline-none"
        style={{ fontFamily: '"BDS EB Garamond", Georgia, serif' }}
      />
      <div className="border-t border-ink-700 px-2.5 py-1 text-[10px] text-ink-500">Tab next cell · ⇧Tab previous · Return new paragraph · Esc done</div>
    </div>
  );
}
