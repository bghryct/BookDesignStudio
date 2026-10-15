import type { BookSpec, Project, Swatch, Element } from './types';
import { mm } from './units';
import { uid } from '../lib/random';
import {
  makeText, makeRule, makeShape, makeMaster, makePage, textStyle, INK, VERMILION, GOLD, ULTRAMARINE,
} from './factory';
import { computeBinding } from '../engine/binding';
import { textBlock } from '../engine/grid';

export const SAMPLE_TITLE = 'The Architecture of the Page';

/** Original sample prose (written for this app) — used by the starter book and the layout matrix. */
export const SAMPLE_ESSAY = `A book begins long before its first word is set. It begins with a sheet of paper, folded, and with the decision of how much of that sheet the text may occupy. Every page is a negotiation between the block of type and the margin that surrounds it: the type asks to be read, the margin asks to be held.
The scribes of the fifteenth century settled this negotiation with geometry rather than arithmetic. By drawing the diagonals of the open spread and of each single page, they located the corners of the text block without measuring anything at all. The inner margin became half of the outer, the head margin half of the foot, and the block itself took on the proportion of the page that contained it.
Such a page is calm because its parts agree. The eye travels from the binding outward and from the head downward, and the wider margins at the fore-edge and the foot give the text a place to rest. The reader’s thumbs, too, find room there without covering a word.
---
Within the text block a second order governs: the baseline grid. When every line of every column falls on a common rhythm, the lines on the recto align with those on the verso, and the ghost of the reverse page no longer shows between them. Captions, notes and headings take their places on the same scale, measured in whole lines.
The column itself should hold between forty-five and seventy-five characters. Narrower, and the rag begins to tear; wider, and the eye loses its way back to the start of the next line. Justified setting asks for careful hyphenation and a line-breaking method that weighs the whole paragraph at once, so that no single line is left loose while its neighbours are tight.
Space between words is the subtlest material of all. It should be just large enough to separate the words and no larger, so that the page has an even colour, neither speckled with holes nor clotted with dark rivers. The best compositors judged this by eye, adjusting a hair space here and there; an algorithm can only approximate their patience.
## Ornament and the margin
The illuminators of Utrecht treated the margin not as an absence but as a second stage. Around the sober block of text they grew vines and acanthus, strewed flowers, hung strings of pearls, and painted mussel shells and coins so convincingly that a reader might reach to brush them from the page. The text stayed still; the margin played.
Later designers turned the same freedom toward systems. Grids became visible and expressive, numerals were overprinted in translucent inks, letters were set in rings and waves until the page itself seemed to move. The book survived each of these adventures because its underlying architecture—the fold, the sewing, the proportion of the page—remained intact beneath them.
## The binding
A sewn book is a hinge as much as a container. Its sections, folded with the grain of the paper running parallel to the spine, open without resistance and close without strain. The boards are set back from the joint so that the cover can swing freely, and the spine is rounded and backed to give the boards a shoulder to rest against.
These details are invisible when they are right. Nobody admires a book because its grain runs the right way; they simply find that it lies open on the table and stays there. The craft of the book is largely a craft of such invisible decisions, made patiently, one after another, until the object disappears and only the reading remains.`;

/** Original Japanese sample for vertical setting (tategaki). */
export const SAMPLE_JAPANESE = `本は静かな建築である。余白は呼吸であり、文字はその中に住む。一枚の紙を折るたびに頁が生まれ、間が生まれる。
第3章では、12の折りと4つの穴による綴じ方を見ていく。糸は背を包み、表紙は手のひらに馴染む。
読むことは、紙の白さの中を歩くことだ。`;

export const DEFAULT_SWATCHES: Swatch[] = [
  { id: 'sw-ink', name: 'Ink black', hex: INK, cmyk: { c: 0, m: 0, y: 0, k: 100 } },
  { id: 'sw-rich', name: 'Rich black', hex: '#0d0b09', cmyk: { c: 40, m: 30, y: 30, k: 100 } },
  { id: 'sw-vermilion', name: 'Vermilion (rubric)', hex: VERMILION, cmyk: { c: 0, m: 85, y: 90, k: 15 } },
  { id: 'sw-ultramarine', name: 'Ultramarine', hex: ULTRAMARINE, cmyk: { c: 100, m: 72, y: 0, k: 18 } },
  { id: 'sw-gold', name: 'Gold (metallic sim.)', hex: GOLD, cmyk: { c: 18, m: 30, y: 95, k: 8 } },
  { id: 'sw-verdigris', name: 'Verdigris', hex: '#3f6b3a', cmyk: { c: 70, m: 25, y: 85, k: 25 } },
  { id: 'sw-pink', name: 'Fluorescent pink', hex: '#ff4f9a', cmyk: { c: 0, m: 80, y: 0, k: 0 } },
  { id: 'sw-cyan', name: 'Process cyan', hex: '#19a7e0', cmyk: { c: 100, m: 0, y: 0, k: 0 } },
  { id: 'sw-yellow', name: 'Process yellow', hex: '#ffd400', cmyk: { c: 0, m: 0, y: 100, k: 0 } },
  { id: 'sw-paper', name: 'Book wove', hex: '#f7f2e7', cmyk: { c: 2, m: 3, y: 9, k: 0 } },
];

export function defaultBookSpec(): BookSpec {
  const trimW = mm(144), trimH = mm(216);
  return {
    title: SAMPLE_TITLE,
    subtitle: 'Notes on proportion, type & binding',
    author: 'The Compositor',
    publisher: 'Book Design Studio',
    unit: 'mm',
    trimW,
    trimH,
    bleed: mm(3),
    slug: mm(12),
    // Van de Graaf canon: ninths of the page.
    margins: { inner: trimW / 9, top: trimH / 9, outer: (2 * trimW) / 9, bottom: (2 * trimH) / 9 },
    facing: true,
    direction: 'ltr',
    plannedPages: 240,
    paper: { gsm: 90, bulk: 1.3, grain: 'short', sheetW: mm(1000), sheetH: mm(700), color: '#f7f2e7' },
    binding: {
      type: 'case',
      boardThickness: mm(2.5),
      coverCaliper: mm(0.35),
      hingeGap: mm(7),
      turnIn: mm(15),
      squares: mm(3),
      rounding: 0.6,
      raisedBands: 0,
      headband: true,
      headbandColors: ['#8a2a1f', '#efe4c8'],
      sectionPages: 16,
      threadDiameter: mm(0.3),
      threadColor: '#efe6cf',
      stabHoles: 4,
      stabMargin: mm(12),
      fukuroToji: true,
    },
    cover: { flapWidth: 0, finish: 'cloth', material: '#283548', edge: 'plain', edgeColor: '#9b2f22' },
    grid: {
      mode: 'modular', columns: 1, rows: 1, gutter: 12, rowGutter: 14, baseline: 14, baselineOffset: 14,
      microDivisions: 1, showGrid: true, showBaseline: false, showMargins: true, showBleed: true,
      snap: true, snapToBaseline: true, showCanon: false,
    },
  };
}

/** Running heads and folios — the classical master page. */
export function classicMaster(spec: BookSpec) {
  const m = makeMaster('A · Text');
  const sc = { textTransform: 'none' as const, tracking: 120, features: { smcp: true, c2sc: true, onum: true }, align: 'center' as const, fontSize: 9, leading: 11, baselineGrid: false, hyphenate: false };
  for (const side of ['left', 'right'] as const) {
    const b = textBlock(spec, side);
    const head = makeText({
      name: 'Running head', x: b.x, y: b.y - 30, w: b.w, h: 14,
      text: side === 'left' ? '{title}' : '{author}',
      style: textStyle(sc),
    });
    const folio = makeText({
      name: 'Folio', x: b.x, y: b.y + b.h + 16, w: b.w, h: 14,
      text: '{page}', style: textStyle({ ...sc, tracking: 0, features: { onum: true } }),
    });
    (side === 'left' ? m.left : m.right).push(head, folio);
  }
  return m;
}

export function createDefaultProject(): Project {
  const spec = defaultBookSpec();
  const W = spec.trimW, H = spec.trimH;
  const master = classicMaster(spec);
  const right = textBlock(spec, 'right');
  const left = textBlock(spec, 'left');

  // 1 · Half-title
  const halfTitle = makePage({ label: 'Half-title' });
  halfTitle.elements.push(makeText({
    name: 'Half-title', x: right.x, y: H * 0.28, w: right.w, h: 20, text: `^${SAMPLE_TITLE}^`,
    style: textStyle({ align: 'center', tracking: 60, baselineGrid: false, hyphenate: false, fontSize: 11 }),
  }));

  // 2 · Blank verso
  const blank = makePage({ label: 'Verso' });

  // 3 · Title page
  const titlePage = makePage({ label: 'Title page' });
  titlePage.elements.push(
    makeText({
      name: 'Title', x: right.x - 10, y: H * 0.2, w: right.w + 20, h: 80, text: SAMPLE_TITLE.toUpperCase(),
      style: textStyle({ fontFamily: 'eb-garamond', fontSize: 22, leading: 28, align: 'center', tracking: 90, baselineGrid: false, hyphenate: false, features: { lnum: true } }),
    }),
    makeRule({ name: 'Rubric rule', x: W / 2 - 18, y: H * 0.2 + 84, w: 36, h: 6, stroke: VERMILION, strokeWidth: 0.75 }),
    makeText({
      name: 'Subtitle', x: right.x, y: H * 0.2 + 100, w: right.w, h: 20, text: '*Notes on proportion, type & binding*',
      style: textStyle({ align: 'center', fontSize: 12, leading: 15, baselineGrid: false, hyphenate: false }),
    }),
    makeText({
      name: 'Author', x: right.x, y: H * 0.52, w: right.w, h: 18, text: '^The Compositor^',
      style: textStyle({ align: 'center', fontSize: 11, tracking: 80, baselineGrid: false, hyphenate: false }),
    }),
    makeText({
      name: 'Imprint', x: right.x, y: H - spec.margins.bottom * 0.75, w: right.w, h: 30, text: '^Book Design Studio^\n*Utrecht · Basel · Kyoto*',
      style: textStyle({ align: 'center', fontSize: 9, leading: 12, tracking: 40, baselineGrid: false, hyphenate: false }),
    }),
  );

  // 4 · Colophon
  const colophon = makePage({ label: 'Colophon' });
  colophon.elements.push(makeText({
    name: 'Colophon', x: left.x, y: H - spec.margins.bottom - 100, w: left.w, h: 100,
    text: 'Set in EB Garamond, after the romans of Claude Garamont, with true small caps and old-style figures. Text block proportioned on the Van de Graaf canon; lines locked to a 14 pt baseline grid; justified with total-fit line breaking.\nSewn in sixteen-page sections on 90 g/m² book wove, grain parallel to the spine; case-bound in cloth with gold foil.',
    style: textStyle({ fontSize: 8, leading: 11, align: 'left', hyphenate: true, baselineGrid: false, firstLineIndent: 0, indentFirstParagraph: false, paragraphSpacing: 5.5 }),
  }));

  // 5 – 8 · Chapter, threaded through four frames
  const chapter = makePage({ label: 'Chapter I', masterId: null });
  const sink = right.h * 0.28;
  const chapterNo = makeText({
    name: 'Chapter number', x: right.x, y: right.y + 4, w: right.w, h: 30, text: 'I',
    style: textStyle({ fontFamily: 'cinzel', fontSize: 18, leading: 24, align: 'center', color: VERMILION, baselineGrid: false, hyphenate: false, weight: 400 }),
  });
  const chapterTitle = makeText({
    name: 'Chapter title', x: right.x, y: right.y + 40, w: right.w, h: 40, text: '*The Proportion of the Page*',
    style: textStyle({ fontSize: 17, leading: 22, align: 'center', baselineGrid: false, hyphenate: false }),
  });
  const frames = [0, 1, 2, 3].map((i) => {
    const b = i % 2 === 0 ? right : left;
    const y = i === 0 ? b.y + sink : b.y;
    return makeText({ name: `Text ${i + 1}`, x: b.x, y, w: b.w, h: b.y + b.h - y });
  });
  frames[0].text = SAMPLE_ESSAY;
  frames[0].style = textStyle({ dropCap: { ...textStyle().dropCap, enabled: true, lines: 3, color: VERMILION, fontFamily: 'eb-garamond' }, firstLineSmallCaps: true });
  for (let i = 0; i < frames.length; i++) {
    frames[i].flowNext = frames[i + 1]?.id ?? null;
    if (i > 0) frames[i].style = textStyle();
  }
  chapter.elements.push(chapterNo, chapterTitle, frames[0]);
  const p6 = makePage({ masterId: master.id });
  const p7 = makePage({ masterId: master.id });
  const p8 = makePage({ masterId: master.id });
  p6.elements.push(frames[1]);
  p7.elements.push(frames[2]);
  p8.elements.push(frames[3]);

  const project: Project = {
    version: 1,
    id: uid('prj'),
    name: SAMPLE_TITLE,
    book: spec,
    pages: [halfTitle, blank, titlePage, colophon, chapter, p6, p7, p8],
    masters: [master],
    cover: { elements: [] },
    swatches: DEFAULT_SWATCHES.map((s) => ({ ...s })),
    assets: {},
    fonts: [],
  };
  project.cover.elements = defaultCover(spec);
  return project;
}

/** A cloth case with gold-foil lettering and a blind-debossed panel. */
export function defaultCover(spec: BookSpec): Element[] {
  const calc = computeBinding(spec);
  const front = calc.panels.find((p) => p.id === 'front')!;
  const spine = calc.panels.find((p) => p.id === 'spine')!;
  const H = calc.coverH;
  const els: Element[] = [];
  const inset = mm(10);
  els.push(makeShape({
    name: 'Blind panel', anchor: 'front', x: inset, y: inset, w: front.w - inset * 2, h: H - inset * 2,
    fill: null, stroke: '#1d2736', strokeWidth: 1.2, finish: 'blind-deboss',
  }));
  els.push(makeText({
    name: 'Cover title', anchor: 'front', x: inset * 1.6, y: H * 0.3, w: front.w - inset * 3.2, h: 70, finish: 'gold-foil',
    text: SAMPLE_TITLE.toUpperCase(),
    style: textStyle({ fontFamily: 'cinzel', fontSize: 15, leading: 21, align: 'center', tracking: 80, color: GOLD, baselineGrid: false, hyphenate: false, weight: 500 }),
  }));
  els.push(makeRule({ name: 'Foil rule', anchor: 'front', x: front.w / 2 - 20, y: H * 0.3 + 78, w: 40, h: 8, kind: 'scotch', stroke: GOLD, strokeWidth: 1.2, finish: 'gold-foil' }));
  els.push(makeText({
    name: 'Cover author', anchor: 'front', x: inset * 1.6, y: H * 0.3 + 96, w: front.w - inset * 3.2, h: 20, finish: 'gold-foil',
    text: '^The Compositor^', style: textStyle({ fontSize: 11, align: 'center', tracking: 80, color: GOLD, baselineGrid: false, hyphenate: false }),
  }));
  // Spine title runs top-to-bottom (the Anglo-American convention).
  const len = H * 0.62;
  const thick = Math.max(10, spine.w * 0.7);
  els.push(makeText({
    name: 'Spine title', anchor: 'spine', x: spine.w / 2 - len / 2, y: H * 0.42 - thick / 2, w: len, h: thick, rotation: 90, finish: 'gold-foil',
    text: SAMPLE_TITLE.toUpperCase(), verticalAlign: 'middle',
    style: textStyle({ fontFamily: 'cinzel', fontSize: Math.min(10, thick * 0.55), leading: Math.min(12, thick * 0.7), align: 'center', tracking: 60, color: GOLD, baselineGrid: false, hyphenate: false }),
  }));
  els.push(makeText({
    name: 'Spine imprint', anchor: 'spine', x: spine.w / 2 - 20, y: H - mm(22), w: 40, h: 12, finish: 'gold-foil',
    text: '^bds^', style: textStyle({ fontSize: 7, align: 'center', tracking: 60, color: GOLD, baselineGrid: false, hyphenate: false }),
  }));
  return els;
}
