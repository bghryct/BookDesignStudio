/**
 * In-canvas table editing.
 *
 *  • Click a selected table to pick a cell, shift-click (or drag) for a range; Esc returns to
 *    the frame. Double-click (or Enter, or just start typing) edits the cell's story.
 *  • Drag a column or row border to resize it (⇧ makes a row height exact).
 *  • Tab / ⇧Tab walk the cells (Tab in the last cell adds a row), arrows move, ⇧arrows extend,
 *    Delete clears, ⌘C / ⌘X / ⌘V copy, cut and paste tab-separated data (from a spreadsheet).
 *  • The frame follows the table: it grows with the content, and dragging its edge scales the rows.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Draft } from 'immer';
import { X, Bold, Italic, CaseSensitive, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Element, Project } from '../../model/types';
import type { TableElement, CellRange } from '../../model/table';
import { anchorAt, anchorsOf, coverMap, expandRange, normRange, parseDelimited, rangeToTSV, fillCells, insertRows, rangeLabel, colLetter, tableFromMatrix } from '../../model/table';
import { layoutTable, type TableLayout } from '../../render/table';
import { contextForElement } from '../../render/compile';
import { applyMatrix, invert, multiply, scale as scaleM, translate, type Matrix } from '../../render/primitives';
import { useStore, type Tool } from '../../store/store';
import { makeTable } from '../../model/factory';
import { computeGrid } from '../../engine/grid';
import { sceneMatrix, type PanelLayout, type Pt, type SurfaceDesc } from './geometry';

/* -------------------------------------------------------------------------- */
/* Cell selection state                                                         */
/* -------------------------------------------------------------------------- */

interface TableUi {
  tableId: string | null;
  /** Selected slots (expanded to whole merges). */
  sel: CellRange | null;
  /** Where shift-click / shift-arrow extends from. */
  anchor: { r: number; c: number } | null;
  /** Cell whose story is open in the cell editor. */
  editing: { r: number; c: number; initial?: string } | null;
  setSel: (tableId: string, sel: CellRange | null, anchor?: { r: number; c: number } | null) => void;
  edit: (tableId: string, r: number, c: number, initial?: string) => void;
  stopEditing: () => void;
  clear: () => void;
}

export const useTableUi = create<TableUi>((set) => ({
  tableId: null,
  sel: null,
  anchor: null,
  editing: null,
  setSel: (tableId, sel, anchor) => set((s) => ({ tableId, sel, anchor: anchor === undefined ? s.anchor : anchor, editing: null })),
  edit: (tableId, r, c, initial) => set({ tableId, sel: { r0: r, c0: c, r1: r, c1: c }, anchor: { r, c }, editing: { r, c, initial } }),
  stopEditing: () => set({ editing: null }),
  clear: () => set({ tableId: null, sel: null, anchor: null, editing: null }),
}));

/** Select the cell covering slot (r, c), expanded to its merge. */
function cellRange(t: TableElement, r: number, c: number): CellRange {
  const a = anchorAt(t, r, c);
  return a ? { r0: a.r, c0: a.c, r1: a.r + a.rs - 1, c1: a.c + a.cs - 1 } : { r0: r, c0: c, r1: r, c1: c };
}

export function selectedTableRange(t: TableElement): CellRange | null {
  const ui = useTableUi.getState();
  if (ui.tableId !== t.id || !ui.sel) return null;
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

/** The table slot under a table-local point. */
function slotAt(L: TableLayout, p: Pt): { r: number; c: number } | null {
  if (p.x < 0 || p.y < 0 || p.x > L.width || p.y > L.height) return null;
  let c = 0, r = 0;
  while (c < L.colX.length - 2 && p.x > L.colX[c + 1]) c++;
  while (r < L.rowY.length - 2 && p.y > L.rowY[r + 1]) r++;
  return { r, c };
}

/** A resizable border under the point: interior column borders, and row bottoms (not the table's foot). */
function borderAt(L: TableLayout, p: Pt, tol: number): { axis: 'col' | 'row'; index: number } | null {
  if (p.y >= -tol && p.y <= L.height + tol) {
    for (let b = 1; b < L.colX.length - 1; b++) if (Math.abs(p.x - L.colX[b]) <= tol) return { axis: 'col', index: b };
  }
  if (p.x >= -tol && p.x <= L.width + tol) {
    for (let b = 1; b < L.rowY.length - 1; b++) if (Math.abs(p.y - L.rowY[b]) <= tol) return { axis: 'row', index: b };
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

/** A new table from CSV / TSV text centred on a point (surface coordinates) — for dropped files. */
export function tableFromText(text: string, at: { x: number; y: number }, name = 'Table'): TableElement | null {
  const data = parseDelimited(text);
  if (!data.length) return null;
  const m = tableFromMatrix(data);
  const w = Math.min(340, Math.max(160, m.cols.length * 72)), h = data.length * 15;
  return makeTable({ ...m, name, x: at.x - w / 2, y: at.y - h / 2, w, h });
}

/** Double-click on a table: edit the cell under the point (table-local coordinates). */
export function tableDoubleClick(el: Element, local: Pt) {
  if (el.type !== 'table') return;
  const project = useStore.getState().project;
  const L = layoutOf(project, el);
  const slot = slotAt(L, local);
  if (!slot) return;
  const a = anchorAt(el, slot.r, slot.c);
  if (!a) return;
  useStore.getState().select([el.id]);
  useTableUi.getState().edit(el.id, a.r, a.c);
}

/* -------------------------------------------------------------------------- */
/* Frame auto-fit                                                              */
/* -------------------------------------------------------------------------- */

interface Seen { w: number; h: number; natH: number; natW: number }
const seen = new Map<string, Seen>();

/** Keep the frame on the table: content changes resize the frame, frame drags scale rows / columns. */
function autoFit(el: TableElement, L: TableLayout): ((d: Draft<Element>) => void) | null {
  const prev = seen.get(el.id);
  const hug = !el.fitWidth && !L.hasFr;
  let fn: ((d: Draft<TableElement>) => void) | null = null;
  const chain = (f: (d: Draft<TableElement>) => void) => { const g = fn; fn = (d) => { g?.(d); f(d); }; };

  if (hug && Math.abs(el.w - L.width) > 0.05) {
    if (prev && Math.abs(prev.w - el.w) > 0.05 && Math.abs(prev.natW - L.width) < 0.05 && L.width > 0) {
      const k = el.w / L.width;
      chain((d) => { d.cols.forEach((col, c) => { col.mode = 'fixed'; col.w = +(L.colW[c] * k).toFixed(2); }); });
    } else chain((d) => { d.w = +L.width.toFixed(3); });
  }
  if (el.autoHeight && Math.abs(el.h - L.height) > 0.05) {
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
  | { k: 'row'; index: number; start: Pt; h0: number; min: number; fixed: boolean }
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
      const fn = autoFit(el, L);
      if (fn) useStore.getState().updateElement(el.id, fn, { history: false });
    }
  }, [tables, layouts, tick]);

  /* ---------------------------------------------------------------- keyboard */
  useEffect(() => {
    if (!active) return;
    const el = active.el;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      const st = useTableUi.getState();
      if (isField(e.target) || st.editing) return;
      // Enter on a selected table steps into its first cell.
      if ((st.tableId !== el.id || !st.sel) && e.key === 'Enter' && !e.metaKey && !e.ctrlKey && useStore.getState().selection.join() === el.id) {
        e.preventDefault(); e.stopPropagation();
        const t0 = findTable(el.id) ?? el;
        st.setSel(el.id, cellRange(t0, 0, 0), { r: 0, c: 0 });
        return;
      }
      if (st.tableId !== el.id || !st.sel) return;
      const t = findTable(el.id) ?? el;
      const g = selectedTableRange(t)!;
      const mod = e.metaKey || e.ctrlKey;
      const s = useStore.getState();
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      const focus = st.anchor ?? { r: g.r0, c: g.c0 };
      if (e.key === 'Escape') { stop(); st.clear(); return; }
      if (e.key === 'Enter' || e.key === 'F2') { stop(); st.edit(el.id, g.r0, g.c0); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        stop();
        s.updateElement(el.id, (d) => { const tt = d as Draft<TableElement>; for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) tt.cells[r][c].text = ''; });
        return;
      }
      if (e.key === 'Tab') {
        stop();
        const order = anchorsOf(t).sort((a, b) => a.r - b.r || a.c - b.c);
        const i = order.findIndex((a) => a.r === g.r0 && a.c === g.c0);
        let j = i + (e.shiftKey ? -1 : 1);
        if (j >= order.length) {
          // Tab in the last cell adds a row, like InDesign.
          s.updateElement(el.id, (d) => insertRows(d as Draft<TableElement> as TableElement, t.rows.length, 1));
          st.setSel(el.id, cellRange(findTable(el.id) ?? t, t.rows.length, 0), { r: t.rows.length, c: 0 });
          return;
        }
        j = Math.max(0, j);
        const a = order[j];
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
        if (e.key.toLowerCase() === 'x') s.updateElement(el.id, (d) => { const tt = d as Draft<TableElement>; for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) tt.cells[r][c].text = ''; });
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
      const t = findTable(el.id) ?? el;
      const g = selectedTableRange(t)!;
      const data = parseDelimited(text);
      let filled: CellRange | null = null;
      useStore.getState().updateElement(el.id, (d) => { filled = fillCells(d as Draft<TableElement> as TableElement, data, { r: g.r0, c: g.c0 }); });
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
  const sel = active && activeL && ui.tableId === active.el.id ? selectedTableRange(active.el) : null;

  const nearHandle = (el: TableElement, p: Pt) => {
    const tol = 7 / zoom;
    return HANDLE_POS.some(([hx, hy]) => Math.abs(p.x - hx * el.w) < tol && Math.abs(p.y - hy * el.h) < tol);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active || !activeL || e.button !== 0) return;
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
      else {
        const r = b.index - 1;
        drag.current = { k: 'row', index: r, start: p, h0: activeL.rowH[r], min: activeL.contentMin[r], fixed: el.rows[r].mode === 'fixed' };
      }
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
      if (e.shiftKey && st.anchor) st.setSel(el.id, expandRange(el, normRange(st.anchor, slot)));
      else st.setSel(el.id, cellRange(el, slot.r, slot.c), slot);
      drag.current = { k: 'range', from: e.shiftKey && st.anchor ? st.anchor : slot };
      return;
    }
    // Frame mode: the canvas moves the table; a click that does not move picks the cell.
    const x0 = e.clientX, y0 = e.clientY;
    const up = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 3) return;
      const cur = findTable(el.id);
      if (!cur || useStore.getState().selection.join() !== el.id) return;
      useTableUi.getState().setSel(el.id, cellRange(cur, slot.r, slot.c), slot);
    };
    window.addEventListener('pointerup', up, { once: true });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!active || !activeL) return;
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
      s.updateElement(el.id, (dr) => setColumnWidths(dr as Draft<TableElement>, widths, [i, j]), { history: false });
    } else if (d.k === 'row') {
      const h = Math.max(d.fixed || e.shiftKey ? 2 : d.min, d.h0 + (p.y - d.start.y));
      s.updateElement(el.id, (dr) => {
        const row = (dr as Draft<TableElement>).rows[d.index];
        if (d.fixed || e.shiftKey) { row.mode = 'fixed'; row.h = +h.toFixed(2); }
        else if (h <= d.min + 0.05) { row.mode = 'auto'; row.h = 0; }
        else { row.mode = 'min'; row.h = +h.toFixed(2); }
      }, { history: false });
    } else if (d.k === 'range') {
      const slot = slotAt(activeL, { x: Math.max(0, Math.min(activeL.width, p.x)), y: Math.max(0, Math.min(activeL.height, p.y)) });
      if (slot) useTableUi.getState().setSel(el.id, expandRange(el, normRange(d.from, slot)), d.from);
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
    for (const b of L.cells) {
      if (!b.overflow) continue;
      const q = sp(m, b.x + b.w, b.y + b.h);
      markers.push(<circle key={`o${el.id}${b.r}-${b.c}`} cx={q.x - 5} cy={q.y - 5} r={3} fill="#e5483a" stroke="#fff" strokeWidth={0.8}><title>Overset text in this cell</title></circle>);
    }
    if (L.overset) {
      const q = sp(m, el.w, el.h);
      markers.push(
        <g key={`ov${el.id}`}>
          <rect x={q.x - 5} y={q.y - 5} width={10} height={10} fill="#e5483a" stroke="#4aa3ff" />
          <text x={q.x} y={q.y + 3.5} textAnchor="middle" fontSize={10} fill="#fff" style={{ fontFamily: 'ui-sans-serif' }}>+</text>
        </g>,
      );
    }
  }

  let editorNode: React.ReactNode = null;
  if (active && activeL && ui.editing && ui.tableId === active.el.id) {
    const box = activeL.cells.find((b) => b.r === ui.editing!.r && b.c === ui.editing!.c);
    if (box) {
      const m = screenM(active.el, active.surface);
      const pts = [sp(m, box.x, box.y), sp(m, box.x + box.w, box.y), sp(m, box.x + box.w, box.y + box.h), sp(m, box.x, box.y + box.h)];
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      editorNode = <CellEditor key={`${active.el.id}:${ui.editing.r}:${ui.editing.c}`} el={active.el} r={ui.editing.r} c={ui.editing.c} initial={ui.editing.initial} rect={rect} viewport={size} />;
    }
  }

  return (
    <>
      <svg ref={svgRef} width={size.w} height={size.h} className="absolute inset-0 select-none" style={{ pointerEvents: 'none' }}>
        {active && activeL && (() => {
          const el = active.el;
          const m = screenM(el, active.surface);
          const grid: string[] = [];
          for (const b of activeL.cells) grid.push(`M${poly(m, b.x, b.y, b.w, b.h).split(' ').join('L')}Z`);
          const selBox = sel && (() => {
            const x0 = activeL.colX[sel.c0], x1 = activeL.colX[Math.min(sel.c1 + 1, activeL.colX.length - 1)];
            const y0 = activeL.rowY[Math.min(sel.r0, activeL.rowY.length - 1)], y1 = activeL.rowY[Math.min(sel.r1 + 1, activeL.rowY.length - 1)];
            return poly(m, x0, y0, x1 - x0, y1 - y0);
          })();
          return (
            <g>
              <path d={grid.join('')} fill="none" stroke="#4aa3ff" strokeOpacity={0.45} strokeWidth={0.75} strokeDasharray="3 3" />
              {selBox && <polygon points={selBox} fill="rgba(74,163,255,0.16)" stroke="#4aa3ff" strokeWidth={1.5} />}
              {sel && el.rotation === 0 && (
                <g style={{ fontFamily: 'ui-monospace, monospace' }} fontSize={9.5}>
                  {activeL.colW.map((w, c) => {
                    const q = sp(m, activeL.colX[c] + w / 2, 0);
                    const on = c >= sel.c0 && c <= sel.c1;
                    return <text key={`cl${c}`} x={q.x} y={q.y - 6} textAnchor="middle" fill={on ? '#4aa3ff' : 'rgba(150,170,200,0.75)'}>{colLetter(c)}</text>;
                  })}
                  {activeL.rowY.slice(0, -1).map((y, r) => {
                    const q = sp(m, 0, (y + activeL.rowY[r + 1]) / 2);
                    const on = r >= sel.r0 && r <= sel.r1;
                    return <text key={`rl${r}`} x={q.x - 6} y={q.y + 3.5} textAnchor="end" fill={on ? '#4aa3ff' : 'rgba(150,170,200,0.75)'}>{r + 1}</text>;
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
            </g>
          );
        })()}
        {markers}
      </svg>
      {editorNode}
    </>
  );
}

function findTable(id: string): TableElement | null {
  const p = useStore.getState().project;
  for (const list of [p.pages.flatMap((x) => x.elements), p.masters.flatMap((m) => [...m.left, ...m.right]), p.cover.elements, p.jacket?.elements ?? []]) {
    const el = list.find((e) => e.id === id);
    if (el) return el.type === 'table' ? el : null;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Cell editor                                                                 */
/* -------------------------------------------------------------------------- */

function CellEditor({ el, r, c, initial, rect, viewport }: { el: TableElement; r: number; c: number; initial?: string; rect: { x: number; y: number; w: number; h: number }; viewport: { w: number; h: number } }) {
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
    s.updateElement(el.id, (d) => { const cell = (d as Draft<TableElement>).cells[r]?.[c]; if (cell) cell.text = v; }, { history: false });
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
      useStore.getState().updateElement(el.id, (d) => insertRows(d as Draft<TableElement> as TableElement, t.rows.length, 1));
      useTableUi.getState().edit(el.id, t.rows.length, 0);
      return;
    }
    useTableUi.getState().edit(el.id, order[j].r, order[j].c);
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
