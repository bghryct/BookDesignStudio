/**
 * Generated table of contents: chapter-title frames and # / ## headings, with the page each one is
 * actually set on (headings inside threaded stories are found by laying the story out).
 */
import type { Element, Project, TextElement } from '../model/types';
import { useStore } from '../store/store';
import { layoutText } from '../render/compile';
import { pageSide, spreadsOf, pageKey } from '../model/surfaces';
import { makeText, textStyle } from '../model/factory';
import { textBlock } from '../engine/grid';

const plain = (s: string) => s.replace(/<\/?(?:\{[^}]*\}|[^<>]{0,40})>|\{[^}]*\}|\[[^\]]*\]\s*|[*^\\]/g, '').replace(/\s+/g, ' ').trim();
export const CONTENTS_NAME = 'Contents (generated)';

export function contentsEntries(project: Project): { level: 1 | 2; text: string; page: number }[] {
  const out: { level: 1 | 2; text: string; page: number }[] = [];
  project.pages.forEach((p, i) => {
    const els = [...p.elements].filter((e): e is TextElement => e.type === 'text' && e.name !== CONTENTS_NAME).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const e of els) {
      if (/chapter\s*title|^chapter$/i.test(e.name) && e.text.trim()) { out.push({ level: 1, text: plain(e.text.split('\n')[0]), page: i + 1 }); continue; }
      const heads = layoutText(e, { project, surface: pageKey(p.id), pageIndex: i, side: pageSide(project, i) }).heads ?? [];
      for (const h of heads) out.push({ level: h.level, text: plain(h.text), page: i + 1 });
    }
  });
  return out.filter((e) => e.text);
}

/** Create the contents frame on the current spread's right page, or refresh the existing one. */
export function generateContents(): { entries: number; updated: boolean } {
  const s = useStore.getState();
  const project = s.project;
  const entries = contentsEntries(project);
  const lines = entries.map((e) => (e.level === 1 ? `${e.text}{rtab}${e.page}` : `[{left:14; size:${(project.book.grid.baseline || 12) > 12 ? 9.5 : 9}}] ${e.text}{rtab}${e.page}`));
  const text = `[{size:15; leading:22; after:12}] ^Contents^\n${lines.join('\n')}`;
  let existing: { pageIndex: number; el: Element } | null = null;
  project.pages.forEach((p, i) => { const e = p.elements.find((x) => x.name === CONTENTS_NAME); if (e && !existing) existing = { pageIndex: i, el: e }; });
  if (existing) {
    s.updateElement((existing as { el: Element }).el.id, { text } as Partial<TextElement>);
    return { entries: entries.length, updated: true };
  }
  const sp = spreadsOf(project)[s.spread];
  const pi = sp?.right ?? sp?.left ?? 0;
  const b = textBlock(project.book, pageSide(project, pi));
  const el = makeText({ name: CONTENTS_NAME, x: b.x, y: b.y, w: b.w, h: b.h, text, style: textStyle({ fontSize: 10, leading: 16, align: 'left', hyphenate: false, firstLineIndent: 0, baselineGrid: false, rightTabLeader: '. ', features: { onum: true }, paragraphSpacing: 2 }) });
  s.addElement(pageKey(project.pages[pi].id), el);
  s.select([el.id]);
  return { entries: entries.length, updated: false };
}

/* -------------------------------------------------------------------------- */
/* Generated index                                                             */
/* -------------------------------------------------------------------------- */

export const INDEX_NAME = 'Index (generated)';

/** Index terms ({ix:term} / {ix:term!subterm}) with the pages they are set on. */
export function indexEntries(project: Project): Map<string, { pages: Set<number>; subs: Map<string, Set<number>> }> {
  const out = new Map<string, { pages: Set<number>; subs: Map<string, Set<number>> }>();
  project.pages.forEach((p, i) => {
    for (const e of p.elements) {
      if (e.type !== 'text' || e.name === INDEX_NAME) continue;
      const marks = layoutText(e, { project, surface: pageKey(p.id), pageIndex: i, side: pageSide(project, i) }).marks ?? [];
      for (const m of marks) {
        const [main, sub] = m.split('!').map((x) => x.trim());
        if (!main) continue;
        const key = main;
        const rec = out.get(key) ?? { pages: new Set<number>(), subs: new Map<string, Set<number>>() };
        if (sub) { const set = rec.subs.get(sub) ?? new Set<number>(); set.add(i + 1); rec.subs.set(sub, set); }
        else rec.pages.add(i + 1);
        out.set(key, rec);
      }
    }
  });
  return out;
}

/** 3, 4, 5, 9 → "3–5, 9". */
function pageList(pages: Set<number>): string {
  const ps = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ps.length; i++) {
    let j = i;
    while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
    parts.push(j > i ? `${ps[i]}–${ps[j]}` : String(ps[i]));
    i = j;
  }
  return parts.join(', ');
}

export function generateIndex(): { entries: number; updated: boolean } {
  const s = useStore.getState();
  const project = s.project;
  const entries = [...indexEntries(project).entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  const lines: string[] = ['[{size:15; leading:22; after:10; span}] ^Index^'];
  let letter = '';
  for (const [term, rec] of entries) {
    const l = term[0].toUpperCase();
    if (l !== letter) { letter = l; lines.push(`[{before:8; keep:2}] ^${l}^`); }
    lines.push(`${term}${rec.pages.size ? `, ${pageList(rec.pages)}` : ''}`);
    for (const [sub, pages] of [...rec.subs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`[{left:10}] ${sub}, ${pageList(pages)}`);
  }
  const text = lines.join('\n');
  let existing: Element | null = null;
  for (const p of project.pages) { const e = p.elements.find((x) => x.name === INDEX_NAME); if (e) { existing = e; break; } }
  if (existing) {
    s.updateElement((existing as Element).id, { text } as Partial<TextElement>);
    return { entries: entries.length, updated: true };
  }
  const sp = spreadsOf(project)[s.spread];
  const pi = sp?.right ?? sp?.left ?? 0;
  const b = textBlock(project.book, pageSide(project, pi));
  const el = makeText({ name: INDEX_NAME, x: b.x, y: b.y, w: b.w, h: b.h, text, style: textStyle({ fontSize: 8.5, leading: 11, align: 'left', hyphenate: false, firstLineIndent: -10, leftIndent: 10, baselineGrid: false, features: { onum: true } }) });
  el.columns = 2;
  el.columnGap = 12;
  s.addElement(pageKey(project.pages[pi].id), el);
  s.select([el.id]);
  return { entries: entries.length, updated: false };
}
