import type { Element, ID, Project, SurfaceKey } from './types';
import type { PageSide } from '../engine/grid';

export interface SpreadSlot { left: number | null; right: number | null }

/**
 * Spreads in display order. Page index 0 is page 1, always a recto.
 * Left-to-right books show page 1 alone on the right; right-to-left books (Japanese,
 * Arabic, Hebrew) bind on the right, so page 1 sits alone on the left.
 */
export function spreadsOf(project: Project): SpreadSlot[] {
  const n = project.pages.length;
  const rtl = project.book.direction === 'rtl';
  const out: SpreadSlot[] = [];
  if (!project.book.facing) {
    for (let i = 0; i < n; i++) out.push({ left: null, right: i });
    return out;
  }
  out.push(rtl ? { left: 0, right: null } : { left: null, right: 0 });
  for (let i = 1; i < n; i += 2) {
    const a = i, b = i + 1 < n ? i + 1 : null;
    out.push(rtl ? { left: b, right: a } : { left: a, right: b });
  }
  return out;
}

export function spreadIndexOfPage(project: Project, pageIndex: number): number {
  if (!project.book.facing) return pageIndex;
  return pageIndex === 0 ? 0 : Math.floor((pageIndex + 1) / 2);
}

/** Which side of the spread a page is displayed on. */
export function pageSide(project: Project, pageIndex: number): PageSide {
  if (!project.book.facing) return 'right';
  const recto = pageIndex % 2 === 0;
  const rtl = project.book.direction === 'rtl';
  return recto !== rtl ? 'right' : 'left';
}

export const pageKey = (pageId: ID): SurfaceKey => `page:${pageId}`;
export const masterKey = (masterId: ID, side: PageSide): SurfaceKey => `master:${masterId}:${side}`;
export const COVER_KEY: SurfaceKey = 'cover';

export function surfaceElements(project: Project, key: SurfaceKey): Element[] {
  if (key === COVER_KEY) return project.cover.elements;
  if (key.startsWith('page:')) return project.pages.find((p) => p.id === key.slice(5))?.elements ?? [];
  if (key.startsWith('master:')) {
    const [, id, side] = key.split(':');
    const m = project.masters.find((x) => x.id === id);
    return m ? (side === 'left' ? m.left : m.right) : [];
  }
  return [];
}

/** Mutable access for immer drafts. */
export function surfaceElementsDraft(project: Project, key: SurfaceKey): Element[] | null {
  if (key === COVER_KEY) return project.cover.elements;
  if (key.startsWith('page:')) return project.pages.find((p) => p.id === key.slice(5))?.elements ?? null;
  if (key.startsWith('master:')) {
    const [, id, side] = key.split(':');
    const m = project.masters.find((x) => x.id === id);
    return m ? (side === 'left' ? m.left : m.right) : null;
  }
  return null;
}

export function allSurfaces(project: Project): SurfaceKey[] {
  return [
    ...project.pages.map((p) => pageKey(p.id)),
    ...project.masters.flatMap((m) => [masterKey(m.id, 'left'), masterKey(m.id, 'right')]),
    COVER_KEY,
  ];
}

export interface Located { key: SurfaceKey; el: Element; index: number; pageIndex: number | null }

export function findElement(project: Project, id: ID): Located | null {
  for (let pi = 0; pi < project.pages.length; pi++) {
    const els = project.pages[pi].elements;
    const i = els.findIndex((e) => e.id === id);
    if (i >= 0) return { key: pageKey(project.pages[pi].id), el: els[i], index: i, pageIndex: pi };
  }
  for (const m of project.masters) {
    for (const side of ['left', 'right'] as const) {
      const els = side === 'left' ? m.left : m.right;
      const i = els.findIndex((e) => e.id === id);
      if (i >= 0) return { key: masterKey(m.id, side), el: els[i], index: i, pageIndex: null };
    }
  }
  const i = project.cover.elements.findIndex((e) => e.id === id);
  if (i >= 0) return { key: COVER_KEY, el: project.cover.elements[i], index: i, pageIndex: null };
  return null;
}

export function pageIndexOfKey(project: Project, key: SurfaceKey): number | null {
  if (!key.startsWith('page:')) return null;
  const i = project.pages.findIndex((p) => p.id === key.slice(5));
  return i >= 0 ? i : null;
}
