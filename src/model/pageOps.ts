import type { Draft } from 'immer';
import type { Element, Page, Project, TextStyle } from './types';
import { useStore } from '../store/store';
import { makePage, makeText, makeMaster, cloneElement, textStyle } from './factory';
import { textBlock } from '../engine/grid';
import { pageSide, spreadIndexOfPage } from './surfaces';
import { layoutStory, frameSpecOf, type FrameSpec } from '../engine/textLayout';

const st = () => useStore.getState();

export function insertPages(afterIndex: number, count = 2, masterId: string | null = null) {
  st().update((d) => {
    const pages = Array.from({ length: count }, () => makePage({ masterId, paperColor: d.book.paper.color }));
    d.pages.splice(afterIndex + 1, 0, ...(pages as Draft<Page>[]));
  });
}

export function deletePage(index: number) {
  const p = st().project;
  if (p.pages.length <= 1) return;
  const ids = new Set(p.pages[index].elements.map((e) => e.id));
  st().update((d) => {
    d.pages.splice(index, 1);
    for (const pg of d.pages) for (const e of pg.elements) if (e.type === 'text' && e.flowNext && ids.has(e.flowNext)) e.flowNext = null;
  });
  st().setSpread(Math.min(st().spread, Math.ceil((p.pages.length - 1) / 2)));
}

export function duplicatePage(index: number) {
  st().update((d) => {
    const src = d.pages[index] as Page;
    const copy: Page = { ...JSON.parse(JSON.stringify(src)), id: makePage().id };
    copy.elements = src.elements.map((e) => cloneElement(e as Element));
    d.pages.splice(index + 1, 0, copy as Draft<Page>);
  });
}

export function movePage(index: number, dir: -1 | 1) {
  st().update((d) => {
    const j = index + dir;
    if (j < 0 || j >= d.pages.length) return;
    const [p] = d.pages.splice(index, 1);
    d.pages.splice(j, 0, p);
  });
}

export function addMaster() {
  const m = makeMaster(`${String.fromCharCode(65 + st().project.masters.length)} · Master`);
  st().update((d) => { d.masters.push(m); });
  st().setMasterEdit({ id: m.id });
}

export function deleteMaster(id: string) {
  st().update((d) => {
    d.masters = d.masters.filter((m) => m.id !== id);
    for (const p of d.pages) if (p.masterId === id) p.masterId = null;
  });
  if (st().masterEdit?.id === id) st().setMasterEdit(null);
}

/**
 * Auto-flow: place a long text into threaded frames on the text block of as many new pages
 * as it needs, using the given master for running heads and folios.
 */
export function autoFlow(text: string, opts: { afterIndex: number; masterId: string | null; style?: TextStyle; startRecto: boolean }) {
  const project = st().project;
  const spec = project.book;
  const style = opts.style ?? textStyle();
  let insertAt = opts.afterIndex + 1;
  // Start on a recto (odd page) if requested: page index must be even.
  const pad = opts.startRecto && insertAt % 2 === 1 ? 1 : 0;
  insertAt += pad;
  const sideFor = (pageIndex: number) => pageSide({ ...project, pages: new Array(Math.max(project.pages.length, pageIndex + 1)).fill(project.pages[0]) } as Project, pageIndex);
  const frameFor = (i: number): FrameSpec => {
    const b = textBlock(spec, sideFor(insertAt + i));
    return { w: b.w, h: b.h, columns: Math.max(1, spec.grid.columns > 2 ? 1 : spec.grid.columns), columnGap: spec.grid.gutter, inset: 0, verticalAlign: 'top', grid: { origin: spec.grid.baselineOffset, increment: spec.grid.baseline } };
  };
  const tokens = { page: 1, pages: project.pages.length, title: spec.title, subtitle: spec.subtitle, author: spec.author, publisher: spec.publisher };
  // Find how many frames the story needs (doubling, then trimming the empty tail).
  let n = 4;
  let used = 0;
  for (let guard = 0; guard < 9; guard++) {
    const frames = Array.from({ length: n }, (_, i) => frameFor(i));
    const res = layoutStory(text, style, frames, tokens);
    used = res.reduce((acc, r, i) => (r.lineCount > 0 ? i + 1 : acc), 0);
    if (!res[n - 1].overflow && used < n) break;
    n *= 2;
  }
  used = Math.max(1, Math.min(used, 600));
  const pages: Page[] = [];
  const frames: Element[] = [];
  for (let i = 0; i < pad; i++) pages.push(makePage({ masterId: null, paperColor: spec.paper.color }));
  for (let i = 0; i < used; i++) {
    const side = sideFor(insertAt + i);
    const b = textBlock(spec, side);
    const f = frameFor(i);
    const el = makeText({ name: `Story ${i + 1}`, x: b.x, y: b.y, w: b.w, h: b.h, columns: f.columns, columnGap: f.columnGap, style: i === 0 ? style : textStyle(), text: i === 0 ? text : '' });
    frames.push(el);
    pages.push(makePage({ masterId: opts.masterId, paperColor: spec.paper.color, elements: [el] }));
  }
  for (let i = 0; i < frames.length - 1; i++) (frames[i] as Extract<Element, { type: 'text' }>).flowNext = frames[i + 1].id;
  st().update((d) => { d.pages.splice(opts.afterIndex + 1, 0, ...(pages as Draft<Page>[])); });
  st().setSpread(spreadIndexOfPage(st().project, insertAt));
  return used;
}

export { frameSpecOf };
