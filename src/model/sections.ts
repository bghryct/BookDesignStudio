/**
 * Sections and page numbering: a section starts on a page, numbers its pages from a value in a
 * style (1 2 3, i ii iii, I II III, a b c, A B C) with an optional prefix, and carries a marker
 * ({section}) for running heads. Pages before the first section are numbered 1, 2, 3 …
 */
import type { Project, PageSection } from './types';
import { toRoman } from './units';

export interface PageNumber { n: number; label: string; marker: string }

const alpha = (n: number, upper: boolean) => {
  if (!Number.isFinite(n) || n > 1e9) return String(n);
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return upper ? s.toUpperCase() : s || 'a';
};

export function formatPageNumber(n: number, style: PageSection['style']): string {
  switch (style) {
    case 'roman': return toRoman(n);
    case 'ROMAN': return toRoman(n, true);
    case 'alpha': return alpha(n, false);
    case 'ALPHA': return alpha(n, true);
    default: return String(n);
  }
}

const cache = new WeakMap<object, { sections: unknown; out: PageNumber[] }>();

/** The number, label and section marker of every page. */
export function pageNumbers(project: Project): PageNumber[] {
  const hit = cache.get(project.pages);
  if (hit && hit.sections === project.sections) return hit.out;
  const starts = new Map((project.sections ?? []).map((s) => [s.pageId, s]));
  let sec: PageSection | null = null;
  let base = 0;
  const out = project.pages.map((p, i) => {
    const s = starts.get(p.id);
    if (s) { sec = s; base = i; }
    if (!sec) return { n: i + 1, label: String(i + 1), marker: '' };
    const n = sec.start + (i - base);
    return { n, label: (sec.prefix ?? '') + formatPageNumber(n, sec.style), marker: sec.marker ?? '' };
  });
  cache.set(project.pages, { sections: project.sections, out });
  return out;
}

export function pageLabel(project: Project, pageIndex: number): string {
  return pageNumbers(project)[pageIndex]?.label ?? String(pageIndex + 1);
}
