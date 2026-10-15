/** Shared building blocks for preset families. */
import type { BookSpec, Master, Page, Project, Swatch, TextElement, TextStyle } from '../../model/types';
import { makeText, makePage, makeMaster, textStyle } from '../../model/factory';
import { defaultBookSpec, SAMPLE_ESSAY, SAMPLE_JAPANESE, SAMPLE_TITLE } from '../../model/defaults';
import { textBlock, type PageSide } from '../grid';
import type { Element } from '../../model/types';

export interface PresetContent {
  title: string;
  subtitle: string;
  author: string;
  publisher: string;
  body: string;
  japanese: string;
}

export interface PresetResult {
  name: string;
  book: BookSpec;
  pages: Page[];
  masters: Master[];
  cover: Element[];
  swatches?: Swatch[];
  /** Spread shown in the matrix thumbnail. */
  focusSpread: number;
  /** One-line description of this variation. */
  caption: string;
}

export interface PresetFamily {
  id: string;
  name: string;
  designer: string;
  era: string;
  description: string;
  rationale: string[];
  accent: string;
  generate: (content: PresetContent, variant: number, seed: number) => PresetResult;
}

export function defaultContent(project?: Project): PresetContent {
  let body = SAMPLE_ESSAY;
  if (project) {
    // Use the longest story in the document as the content.
    let best = '';
    for (const p of project.pages) for (const e of p.elements) if (e.type === 'text' && e.text.length > best.length && e.style.writingMode === 'horizontal') best = e.text;
    if (best.length > 400) body = best;
  }
  const b = project?.book;
  return {
    title: b?.title || SAMPLE_TITLE,
    subtitle: b?.subtitle || 'Notes on proportion, type & binding',
    author: b?.author || 'The Compositor',
    publisher: b?.publisher || 'Book Design Studio',
    body,
    japanese: SAMPLE_JAPANESE,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function specWith(over: (s: BookSpec) => void): BookSpec {
  const s = defaultBookSpec();
  over(s);
  return s;
}

/** Page sides for LTR facing books: index 0 = recto (right). */
export const sideOf = (spec: BookSpec, i: number): PageSide => (spec.direction === 'rtl' ? (i % 2 === 0 ? 'left' : 'right') : i % 2 === 0 ? 'right' : 'left');

export function chain(frames: TextElement[]) {
  for (let i = 0; i < frames.length - 1; i++) frames[i].flowNext = frames[i + 1].id;
}

export function firstParagraphs(text: string, n: number) {
  return text.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^-{3,}$/.test(l.trim())).slice(0, n).join('\n');
}

export const plain = (o: Partial<TextStyle> = {}) => textStyle({ baselineGrid: false, hyphenate: false, firstLineIndent: 0, ...o });

export function runningHeads(spec: BookSpec, style: Partial<TextStyle>, placement: 'centre' | 'outer' = 'centre', folioAtFoot = true): Master {
  const m = makeMaster('A · Text');
  for (const side of ['left', 'right'] as const) {
    const b = textBlock(spec, side);
    const align = placement === 'centre' ? 'center' : side === 'left' ? 'left' : 'right';
    const head = makeText({ name: 'Running head', x: b.x, y: b.y - spec.grid.baseline * 2.2, w: b.w, h: 14, text: side === 'left' ? '{title}' : '{author}', style: plain({ fontSize: 8.5, leading: 11, align, ...style }) });
    const folio = folioAtFoot
      ? makeText({ name: 'Folio', x: b.x, y: b.y + b.h + spec.grid.baseline * 1.2, w: b.w, h: 14, text: '{page}', style: plain({ fontSize: 9, leading: 11, align, ...style, tracking: 0, features: { onum: true } }) })
      : null;
    (side === 'left' ? m.left : m.right).push(head, ...(folio ? [folio] : []));
  }
  return m;
}

export function textFrames(spec: BookSpec, pageIdx: number[], content: string, style: TextStyle, opts: { columns?: number; topOffset?: (i: number) => number; width?: (b: { x: number; w: number }, side: PageSide) => { x: number; w: number } } = {}): TextElement[] {
  const frames = pageIdx.map((pi, i) => {
    const side = sideOf(spec, pi);
    const b = textBlock(spec, side);
    const top = opts.topOffset ? opts.topOffset(i) : 0;
    const geo = opts.width ? opts.width(b, side) : { x: b.x, w: b.w };
    return makeText({ name: `Text ${i + 1}`, x: geo.x, y: b.y + top, w: geo.w, h: b.h - top, columns: opts.columns ?? 1, columnGap: spec.grid.gutter, text: i === 0 ? content : '', style: i === 0 ? style : textStyle(style) });
  });
  chain(frames);
  return frames;
}

export function blankPages(n: number, paper: string, masterId: string | null = null): Page[] {
  return Array.from({ length: n }, () => makePage({ masterId, paperColor: paper }));
}

