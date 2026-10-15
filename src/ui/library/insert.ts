import type { Element, Project } from '../../model/types';
import { useStore } from '../../store/store';
import { spreadsOf, pageKey, masterKey, findElement, pageSide, COVER_KEY, JACKET_KEY } from '../../model/surfaces';
import { textBlock } from '../../engine/grid';
import { computeBinding, computeJacket, coverGrid, jacketGrid } from '../../engine/binding';
import { panelGridLines } from '../../engine/grid';
import { mm } from '../../model/units';
import { libraryItems, type LibraryContext, type LibraryItem } from './items';

export interface Target { key: string; ctx: LibraryContext; anchor: Element['anchor'] }

/** Where a library item should go: the selected item's page, else the visible right page, the master, or the cover. */
export function currentTarget(project: Project): Target | null {
  const s = useStore.getState();
  const spec = project.book;
  if (s.view === 'cover' || s.view === 'jacket') {
    // The front panel's margin block from the cover / jacket grid, in panel coordinates.
    const calc = computeBinding(spec);
    const jc = s.view === 'jacket' ? computeJacket(spec, calc) : null;
    const panels = jc ? jc.panels : calc.panels;
    const H = jc ? jc.height : calc.coverH;
    const front = panels.find((p) => p.id === 'front')!;
    const blk = panelGridLines(panels, jc ? jacketGrid(spec) : coverGrid(spec), H).blocks.find((b) => b.panel === 'front');
    const block = blk ? { x: blk.x - front.x, y: blk.y, w: blk.w, h: blk.h } : { x: mm(10), y: mm(10), w: front.w - mm(20), h: H - mm(20) };
    return { key: jc ? JACKET_KEY : COVER_KEY, anchor: 'front', ctx: { spec, W: front.w, H, side: 'right', onCover: true, block } };
  }
  if (s.masterEdit) {
    const side = 'right' as const;
    return { key: masterKey(s.masterEdit.id, side), anchor: null, ctx: { spec, W: spec.trimW, H: spec.trimH, side, onCover: false, block: textBlock(spec, side) } };
  }
  let pi: number | null = null;
  const sel = s.selection[0] ? findElement(project, s.selection[0]) : null;
  if (sel?.pageIndex != null) pi = sel.pageIndex;
  if (pi == null) {
    const sp = spreadsOf(project)[s.spread];
    pi = sp?.right ?? sp?.left ?? null;
  }
  if (pi == null) return null;
  const side = pageSide(project, pi);
  return { key: pageKey(project.pages[pi].id), anchor: null, ctx: { spec, W: spec.trimW, H: spec.trimH, side, onCover: false, block: textBlock(spec, side) } };
}

/** Target for a specific surface (drag & drop). */
export function targetFor(project: Project, key: string): Target | null {
  const spec = project.book;
  if (key === COVER_KEY || key === JACKET_KEY) {
    const view = useStore.getState().view;
    if ((key === COVER_KEY && view !== 'cover') || (key === JACKET_KEY && view !== 'jacket')) return null;
    return currentTarget(project);
  }
  if (key.startsWith('master:')) {
    const side = key.endsWith(':left') ? 'left' : 'right';
    return { key, anchor: null, ctx: { spec, W: spec.trimW, H: spec.trimH, side, onCover: false, block: textBlock(spec, side) } };
  }
  const pi = project.pages.findIndex((p) => `page:${p.id}` === key);
  if (pi < 0) return null;
  const side = pageSide(project, pi);
  return { key, anchor: null, ctx: { spec, W: spec.trimW, H: spec.trimH, side, onCover: false, block: textBlock(spec, side) } };
}

export function bounds(els: Element[]) {
  const x0 = Math.min(...els.map((e) => e.x)), y0 = Math.min(...els.map((e) => e.y));
  const x1 = Math.max(...els.map((e) => e.x + e.w)), y1 = Math.max(...els.map((e) => e.y + e.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function getItem(id: string): LibraryItem | undefined {
  return libraryItems().find((i) => i.id === id);
}

/** Insert an item; with `at` (surface coordinates) the group is centred on that point. */
export function insertItem(item: LibraryItem, target: Target, at?: { x: number; y: number }) {
  const s = useStore.getState();
  let els = item.make(target.ctx);
  if (!els.length) return;
  if (at) {
    const b = bounds(els);
    const dx = at.x - (b.x + b.w / 2), dy = at.y - (b.y + b.h / 2);
    els = els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
  }
  if (target.anchor) els = els.map((e) => ({ ...e, anchor: target.anchor }));
  s.update((d) => {
    if (target.key === JACKET_KEY && !d.jacket) d.jacket = { elements: [] };
    const arr = target.key === COVER_KEY ? d.cover.elements : target.key === JACKET_KEY ? d.jacket!.elements : target.key.startsWith('page:') ? d.pages.find((p) => `page:${p.id}` === target.key)?.elements : (() => {
      const [, id, side] = target.key.split(':');
      const m = d.masters.find((x) => x.id === id);
      return m ? (side === 'left' ? m.left : m.right) : undefined;
    })();
    arr?.push(...(els as typeof arr));
  });
  s.select(els.map((e) => e.id));
  s.setRightTab('element');
}
