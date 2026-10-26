import type { Element, ID, Project, SurfaceKey, TextElement } from './types';
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

/**
 * The page facing this one in its reader spread, and the x offset that maps the facing page's
 * coordinates onto this page's (+W when the facing page is on the right, −W on the left).
 */
export function facingOf(project: Project, pageIndex: number): { index: number; dx: number } | null {
  if (!project.book.facing || pageIndex <= 0) return null;
  const partner = pageIndex % 2 === 1 ? pageIndex + 1 : pageIndex - 1;
  if (partner < 1 || partner >= project.pages.length) return null;
  return { index: partner, dx: pageSide(project, pageIndex) === 'left' ? project.book.trimW : -project.book.trimW };
}

export const pageKey = (pageId: ID): SurfaceKey => `page:${pageId}`;
export const masterKey = (masterId: ID, side: PageSide): SurfaceKey => `master:${masterId}:${side}`;
export const COVER_KEY: SurfaceKey = 'cover';
export const JACKET_KEY: SurfaceKey = 'jacket';

export function surfaceElements(project: Project, key: SurfaceKey): Element[] {
  if (key === COVER_KEY) return project.cover.elements;
  if (key === JACKET_KEY) return project.jacket?.elements ?? [];
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
  if (key === JACKET_KEY) {
    if (!project.jacket) project.jacket = { elements: [] };
    return project.jacket.elements;
  }
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
    JACKET_KEY,
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
  const jEls = project.jacket?.elements ?? [];
  const j = jEls.findIndex((e) => e.id === id);
  if (j >= 0) return { key: JACKET_KEY, el: jEls[j], index: j, pageIndex: null };
  return null;
}

/**
 * Text frames about to be deleted leave their story whole (InDesign's rule): the frames before and
 * after them in the thread are linked up, and a deleted first frame hands the story (its text,
 * style and paragraph style) to the next frame that stays. Without this, deleting a page in the
 * middle of a flowed story cut the story off there, and deleting its first page lost the text.
 * Locked frames are not deleted, so they stay in the thread unless `includeLocked` is set.
 */
export function releaseTextFrames(project: Project, ids: Set<string>, includeLocked = false): void {
  const all: TextElement[] = [];
  const visit = (els: Element[]) => { for (const e of els) if (e.type === 'text') all.push(e); };
  project.pages.forEach((pg) => visit(pg.elements));
  project.masters.forEach((m) => { visit(m.left); visit(m.right); });
  visit(project.cover.elements);
  if (project.jacket) visit(project.jacket.elements);
  const byId = new Map(all.map((t) => [t.id, t]));
  const gone = (t: TextElement) => ids.has(t.id) && (includeLocked || !t.locked);
  const hasPrev = new Set<string>();
  for (const t of all) if (t.flowNext && byId.has(t.flowNext) && t.flowNext !== t.id) hasPrev.add(t.flowNext);
  for (const head of all) {
    if (hasPrev.has(head.id) || !head.flowNext || !byId.has(head.flowNext)) continue;
    const chain: TextElement[] = [];
    const seen = new Set<string>();
    for (let cur: TextElement | undefined = head; cur && !seen.has(cur.id); cur = cur.flowNext ? byId.get(cur.flowNext) : undefined) { chain.push(cur); seen.add(cur.id); }
    if (!chain.some(gone)) continue;
    const keep = chain.filter((t) => !gone(t));
    if (!keep.length) continue;
    if (gone(head)) {
      const next = keep[0];
      next.text = head.text;
      next.style = JSON.parse(JSON.stringify(head.style));
      next.paraStyle = head.paraStyle ?? null;
    }
    keep.forEach((t, i) => { t.flowNext = keep[i + 1]?.id ?? null; });
  }
}

export function pageIndexOfKey(project: Project, key: SurfaceKey): number | null {
  if (!key.startsWith('page:')) return null;
  const i = project.pages.findIndex((p) => p.id === key.slice(5));
  return i >= 0 ? i : null;
}

/* -------------------------------------------------------------------------- */
/* Ruler guides                                                                */
/* -------------------------------------------------------------------------- */

export const guidesOf = (project: Project, key: SurfaceKey) => project.guides?.[key] ?? { x: [], y: [] };
