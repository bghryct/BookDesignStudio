/**
 * The element library: ready-made design elements grouped by designer / tradition.
 * Each item builds elements for a target surface from its text block, so it lands in the
 * right place on any page size. Every registry motif is also exposed automatically.
 */
import type { BookSpec, Element, TextStyle } from '../../model/types';
import type { DesignerId } from '../../engine/motifs';
import { MOTIF_LIST } from '../../engine/motifs';
import {
  makeText, makeRule, makeShape, makeOrnament, makeInitial, makePattern, makeOverprint, makeGradient, makeCutout, makeGridType,
  makePath, makeImage, makeMotif, textStyle, VERMILION, ULTRAMARINE, GOLD, CLEVES_PALETTE,
} from '../../model/factory';
import type { Rect } from '../../engine/grid';
import { mm } from '../../model/units';
import { SAMPLE_JAPANESE } from '../../model/defaults';
import type { PatternKind, OverprintKind, OrnamentKind } from '../../model/types';

export interface LibraryContext {
  spec: BookSpec;
  /** Text block of the target page (or the front panel, inset, on the cover). */
  block: Rect;
  /** Trim size of the target surface. */
  W: number;
  H: number;
  side: 'left' | 'right';
  onCover: boolean;
}

export interface LibraryItem {
  id: string;
  designer: DesignerId;
  label: string;
  note?: string;
  make: (c: LibraryContext) => Element[];
}

const plain = (o: Partial<TextStyle> = {}) => textStyle({ baselineGrid: false, hyphenate: false, firstLineIndent: 0, ...o });
const SAMPLE = 'The page is a field of tension between the text and its margin; the grid makes that tension legible.';

/** Outer-margin column beside the block on the page's fore-edge side. */
function outerMargin(c: LibraryContext): Rect {
  const gap = mm(4);
  if (c.side === 'left') return { x: mm(8), y: c.block.y, w: Math.max(30, c.block.x - mm(8) - gap), h: c.block.h };
  const x = c.block.x + c.block.w + gap;
  return { x, y: c.block.y, w: Math.max(30, c.W - x - mm(8)), h: c.block.h };
}

const around = (c: LibraryContext, band: number) => ({ x: c.block.x - band, y: c.block.y - band, w: c.block.w + band * 2, h: c.block.h + band * 2, band });

const HANDMADE: LibraryItem[] = [
  /* ---------------------------------------------------------------- Cleves */
  ...(([
    ['vine-border', 'Vine rinceaux border'], ['shells-and-coins', 'Shells & coins border'], ['acanthus', 'Acanthus frame'],
    ['pearls-and-beads', 'Pearls & beads frame'], ['trompe-loeil-frame', 'Gilded trompe-l’œil frame'], ['rubric-frame', 'Rubric penwork frame'],
  ] as [OrnamentKind, string][]).map(([kind, label]) => ({
    id: `cleves-${kind}`, designer: 'cleves' as DesignerId, label,
    make: (c: LibraryContext) => {
      const band = Math.min(c.spec.margins.outer, c.spec.margins.bottom) * 0.75;
      return [makeOrnament({ name: label, ...around(c, band), kind, seed: Math.floor(Math.random() * 1e5) })];
    },
  }))),
  { id: 'cleves-strewn', designer: 'cleves', label: 'Strewn flowers in the margin', make: (c) => {
    const m = outerMargin(c);
    return [makeOrnament({ name: 'Strewn flowers', x: m.x, y: m.y, w: m.w, h: m.h, band: m.w, kind: 'strewn-flowers', sides: { top: false, bottom: false, left: c.side === 'left', right: c.side === 'right' } })];
  } },
  { id: 'cleves-ruling', designer: 'cleves', label: 'Ruling with prickings', note: 'Ruled lines at the baseline, pricked at the edge.', make: (c) => [makeOrnament({ name: 'Ruling', x: c.block.x - 4, y: c.block.y - 2, w: c.block.w + 8, h: c.block.h + 4, kind: 'ruling', band: 4, params: { lineSpacing: c.spec.grid.baseline || 14 }, palette: { ...CLEVES_PALETTE, red: '#c46a5a' } })] },
  { id: 'cleves-initial-gilded', designer: 'cleves', label: 'Burnished gold initial', make: (c) => [makeInitial({ x: c.block.x, y: c.block.y, w: 64, h: 64, frame: 'gilded', letter: 'D' })] },
  { id: 'cleves-initial-vine', designer: 'cleves', label: 'Vine-tracery initial', make: (c) => [makeInitial({ x: c.block.x, y: c.block.y, w: 64, h: 64, frame: 'vine', letter: 'O', color: GOLD, fontFamily: 'unifraktur' })] },
  { id: 'cleves-initial-rubric', designer: 'cleves', label: 'Penwork initial', make: (c) => [makeInitial({ x: c.block.x + 6, y: c.block.y + 6, w: 52, h: 52, frame: 'rubric', letter: 'A', color: ULTRAMARINE, frameColor: VERMILION, ground: null })] },
  { id: 'cleves-rubric', designer: 'cleves', label: 'Rubric heading', note: 'Red blackletter rubric.', make: (c) => [makeText({ name: 'Rubric', x: c.block.x, y: c.block.y, w: c.block.w, h: 22, text: 'Incipit liber de forma paginae', style: plain({ fontFamily: 'unifraktur', fontSize: 13, leading: 16, color: VERMILION }) })] },
  { id: 'cleves-incipit', designer: 'cleves', label: 'Text with gilded initial', make: (c) => [makeText({ name: 'Incipit', x: c.block.x, y: c.block.y + 24, w: c.block.w, h: Math.min(c.block.h - 24, 220), text: `${SAMPLE} The scribe rules the page before a single letter is written, and the illuminator works around the text that results.`, style: textStyle({ fontSize: 10.5, leading: 12.5, features: { hlig: true, dlig: true, onum: true }, dropCap: { enabled: true, lines: 3, fontFamily: 'cinzel', weight: 600, color: ULTRAMARINE, frame: 'gilded', frameColor: ULTRAMARINE, gap: 4 } }) })] },

  /* ---------------------------------------------------------------- Diehl */
  { id: 'diehl-endpaper', designer: 'diehl', label: 'Marbled endpaper (full page)', note: 'Covers the page and its bleed.', make: (c) => [makeMotif('marbled', { name: 'Endpaper', x: -c.spec.bleed, y: -c.spec.bleed, w: c.W + 2 * c.spec.bleed, h: c.H + 2 * c.spec.bleed })] },
  { id: 'diehl-colophon', designer: 'diehl', label: 'Binding colophon', make: (c) => [makeText({ name: 'Colophon', x: c.block.x, y: c.block.y + c.block.h - 90, w: c.block.w, h: 90, text: `^Printed^ on ${c.spec.paper.gsm} g/m² ${c.spec.paper.grain}-grain book paper.\n^Sewn^ in sections of ${c.spec.binding.sectionPages} pages on linen thread.\n^Bound^ by hand, ${c.spec.binding.type === 'case' ? 'case-bound with french joints' : 'in a sewn soft cover'}.`, style: textStyle({ fontSize: 8, leading: 11, align: 'left', firstLineIndent: 0, paragraphSpacing: 0, baselineGrid: false, features: { onum: true } }) })] },

  /* ---------------------------------------------------------------- Munari */
  { id: 'munari-circle', designer: 'munari', label: 'Die-cut circle', make: (c) => [makeCutout({ x: c.block.x + c.block.w / 2 - 45, y: c.block.y + c.block.h / 3, w: 90, h: 90, shape: 'ellipse' })] },
  { id: 'munari-square', designer: 'munari', label: 'Die-cut square window', make: (c) => [makeCutout({ x: c.block.x + c.block.w * 0.2, y: c.block.y + c.block.h * 0.25, w: c.block.w * 0.4, h: c.block.w * 0.4, shape: 'rect' })] },
  { id: 'munari-holes', designer: 'munari', label: 'Row of punched holes', make: (c) => Array.from({ length: 5 }, (_, i) => makeCutout({ name: `Hole ${i + 1}`, x: c.block.x + (c.block.w / 5) * i + c.block.w / 10 - 9, y: c.block.y + c.block.h * 0.7, w: 18, h: 18, shape: 'ellipse' })) },
  { id: 'munari-thread', designer: 'munari', label: 'Red thread', note: 'A thread that runs across the page and onward.', make: (c) => [makePath({ name: 'Thread', x: -c.spec.bleed, y: c.H * 0.4, w: c.W + 2 * c.spec.bleed, h: c.H * 0.2, vw: 100, vh: 20, d: 'M0 12C25 2 45 22 62 10S90 4 100 9', fill: null, stroke: '#c8372a', strokeWidth: 1.6, cap: 'round' })] },

  /* ---------------------------------------------------------------- Crouwel */
  { id: 'crouwel-title', designer: 'crouwel', label: 'Grid-alphabet title', make: (c) => [makeGridType({ x: c.block.x, y: c.block.y, w: c.block.w, h: Math.min(90, c.block.h * 0.2), text: 'new alphabet' })] },
  { id: 'crouwel-numerals', designer: 'crouwel', label: 'Grid numerals', make: (c) => [makeGridType({ x: c.block.x, y: c.block.y, w: c.block.w, h: 70, text: '0123456789', color: '#ff3b1f', showModules: true })] },
  { id: 'crouwel-modules', designer: 'crouwel', label: 'Colour modules', note: 'Square modules in a row of the grid.', make: (c) => {
    const n = 6, g = 6, s = (c.block.w - g * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => makeShape({ name: `Module ${i + 1}`, x: c.block.x + i * (s + g), y: c.block.y + c.block.h - s, w: s, h: s, fill: i % 3 === 0 ? '#ff3b1f' : '#111111', stroke: null, opacity: i === 4 ? 0 : 1 })).filter((e) => e.opacity > 0);
  } },
  { id: 'crouwel-lowercase', designer: 'crouwel', label: 'Lowercase text block', make: (c) => [makeText({ x: c.block.x, y: c.block.y, w: c.block.w / 2, h: c.block.h / 2, text: SAMPLE, style: textStyle({ fontFamily: 'space-grotesk', fontSize: 9, leading: 11, align: 'left', textTransform: 'lowercase', firstLineIndent: 0 }) })] },

  /* ---------------------------------------------------------------- Martens */
  ...(([['numerals', 'Overprinted numerals'], ['circles', 'Overprinted washers'], ['squares-grid', 'Squares grid'], ['stripes', 'Stripes'], ['letters', 'Letters'], ['counters', 'Counter-forms']] as [OverprintKind, string][]).map(([kind, label]) => ({
    id: `martens-${kind}`, designer: 'martens' as DesignerId, label,
    make: (c: LibraryContext) => [makeOverprint({ name: label, x: c.block.x, y: c.block.y, w: c.block.w, h: c.block.w, kind, seed: Math.floor(Math.random() * 1e5) })],
  }))),
  { id: 'martens-caption', designer: 'martens', label: 'Monospaced caption', make: (c) => [makeText({ x: c.block.x, y: c.block.y + c.block.h - 40, w: c.block.w / 2, h: 40, text: 'printed matter\noverprint · multiply\n2 + 3 inks', style: plain({ fontFamily: 'ibm-plex-mono', fontSize: 7, leading: 10 }) })] },

  /* ---------------------------------------------------------------- Schrofer */
  ...(([['text-rings', 'Text rings'], ['wave-letters', 'Wave field'], ['moire-lines', 'Moiré'], ['rotating-squares', 'Rotating squares'], ['radial-bars', 'Radial bars'], ['dot-screen', 'Dot screen'], ['text-spiral', 'Text spiral'], ['letter-grid-scale', 'Scaling letter grid']] as [PatternKind, string][]).map(([kind, label]) => ({
    id: `schrofer-${kind}`, designer: 'schrofer' as DesignerId, label,
    make: (c: LibraryContext) => [makePattern({ name: label, x: c.block.x, y: c.block.y, w: c.block.w, h: c.block.w, kind, seed: Math.floor(Math.random() * 1e5) })],
  }))),

  /* ---------------------------------------------------------------- Tschichold */
  { id: 'tschichold-title', designer: 'tschichold', label: 'Centred title page', make: (c) => [
    makeText({ name: 'Title', x: c.block.x - 8, y: c.H * 0.2, w: c.block.w + 16, h: 60, text: '{title}', style: plain({ fontSize: 20, leading: 26, align: 'center', tracking: 90, textTransform: 'uppercase', features: { lnum: true } }) }),
    makeRule({ name: 'Rule', x: c.W / 2 - 16, y: c.H * 0.2 + 66, w: 32, h: 6, stroke: VERMILION, strokeWidth: 0.75 }),
    makeText({ name: 'Author', x: c.block.x, y: c.H * 0.48, w: c.block.w, h: 18, text: '^{author}^', style: plain({ align: 'center', tracking: 80 }) }),
    makeText({ name: 'Imprint', x: c.block.x, y: c.H - c.spec.margins.bottom * 0.7, w: c.block.w, h: 18, text: '^{publisher}^', style: plain({ fontSize: 9, align: 'center', tracking: 60 }) }),
  ] },
  { id: 'tschichold-chapter', designer: 'tschichold', label: 'Chapter opening', make: (c) => [
    makeText({ name: 'Chapter number', x: c.block.x, y: c.block.y, w: c.block.w, h: 26, text: 'I', style: plain({ fontFamily: 'cinzel', fontSize: 16, align: 'center', color: VERMILION }) }),
    makeText({ name: 'Chapter title', x: c.block.x, y: c.block.y + 32, w: c.block.w, h: 30, text: '*The Proportion of the Page*', style: plain({ fontSize: 16, leading: 21, align: 'center' }) }),
  ] },
  { id: 'tschichold-scotch', designer: 'tschichold', label: 'Scotch rule', make: (c) => [makeRule({ x: c.block.x, y: c.block.y, w: c.block.w, h: 8, kind: 'scotch', strokeWidth: 0.8 })] },
  { id: 'tschichold-dinkus', designer: 'tschichold', label: 'Asterism (section break)', make: (c) => [makeText({ name: 'Asterism', x: c.block.x, y: c.block.y + c.block.h / 2, w: c.block.w, h: 20, text: '⁂', style: plain({ fontSize: 12, align: 'center' }) })] },
  { id: 'tschichold-running', designer: 'tschichold', label: 'Running head & folio', note: 'Small capitals, letter-spaced; folio centred at the foot.', make: (c) => [
    makeText({ name: 'Running head', x: c.block.x, y: c.block.y - 28, w: c.block.w, h: 14, text: c.side === 'left' ? '{title}' : '{author}', style: plain({ fontSize: 8.5, align: 'center', tracking: 120, features: { smcp: true, c2sc: true } }) }),
    makeText({ name: 'Folio', x: c.block.x, y: c.block.y + c.block.h + 16, w: c.block.w, h: 14, text: '{page}', style: plain({ fontSize: 9, align: 'center', features: { onum: true } }) }),
  ] },

  /* ---------------------------------------------------------------- Bringhurst */
  { id: 'bringhurst-sidenote', designer: 'bringhurst', label: 'Side-note in the margin', make: (c) => {
    const m = outerMargin(c);
    return [makeText({ name: 'Side-note', x: m.x, y: m.y + 40, w: m.w, h: 80, text: '*A note belongs beside the line it glosses, where the reader’s eye already is.*', style: plain({ fontSize: 8, leading: 10.5, align: c.side === 'left' ? 'right' : 'left', color: '#5b4d3d' }) })];
  } },
  { id: 'bringhurst-headfolio', designer: 'bringhurst', label: 'Head & folio together', make: (c) => [makeText({ name: 'Head & folio', x: c.block.x, y: c.block.y - 26, w: c.block.w, h: 14, text: c.side === 'left' ? '{page}  ·  ^{title}^' : '^{author}^  ·  {page}', style: plain({ fontSize: 8.5, align: c.side === 'left' ? 'left' : 'right', tracking: 40, features: { onum: true } }) })] },
  { id: 'bringhurst-extract', designer: 'bringhurst', label: 'Indented extract', make: (c) => [makeText({ name: 'Extract', x: c.block.x + 18, y: c.block.y + c.block.h * 0.4, w: c.block.w - 36, h: 70, text: SAMPLE, style: textStyle({ fontSize: 9.5, leading: 12, firstLineIndent: 0, baselineGrid: false }) })] },

  /* ---------------------------------------------------------------- Bosshard */
  { id: 'bosshard-section', designer: 'bosshard', label: 'Numbered section heading', make: (c) => [
    makeText({ name: 'Section number', x: c.block.x, y: c.block.y, w: 60, h: 34, text: '**2.4**', style: plain({ fontFamily: 'inter', fontSize: 24, leading: 28, color: '#0050a0' }) }),
    makeText({ name: 'Section title', x: c.block.x + 64, y: c.block.y + 8, w: c.block.w - 64, h: 22, text: '**Der typografische Raster**', style: plain({ fontFamily: 'inter', fontSize: 12, leading: 14 }) }),
    makeRule({ name: 'Rule', x: c.block.x, y: c.block.y + 34, w: c.block.w, h: 6, strokeWidth: 0.5 }),
  ] },
  { id: 'bosshard-rotated', designer: 'bosshard', label: 'Rotated text column', make: (c) => {
    const len = c.block.h * 0.8, th = 30;
    return [makeText({ name: 'Rotated title', x: c.block.x - len / 2 + th / 2, y: c.block.y + len / 2 - th / 2, w: len, h: th, rotation: -90, text: '**Konkrete Typografie**', style: plain({ fontFamily: 'inter', fontSize: 18, leading: 22, align: 'right', color: '#e30613' }) })];
  } },
  { id: 'bosshard-caption', designer: 'bosshard', label: 'Technical caption', make: (c) => [makeText({ name: 'Caption', x: c.block.x, y: c.block.y + c.block.h - 30, w: c.block.w / 2, h: 30, text: '**Fig. 3** Unit grid of 12 columns: the 2- and 3-column systems share every gutter.', style: plain({ fontFamily: 'inter', fontSize: 7, leading: 9.5 }) })] },

  /* ---------------------------------------------------------------- Müller-Brockmann */
  { id: 'mb-headline', designer: 'muller-brockmann', label: 'Swiss headline', make: (c) => [makeText({ name: 'Headline', x: c.block.x, y: c.block.y, w: c.block.w, h: 110, text: '**Grid systems in graphic design**', style: plain({ fontFamily: 'inter', fontSize: 30, leading: 32, tracking: -20 }) })] },
  { id: 'mb-picture', designer: 'muller-brockmann', label: 'Picture field & caption', make: (c) => {
    const w = c.block.w * 0.6, h = Math.round((w * 0.75) / 12) * 12;
    return [
      makeImage({ name: 'Picture field', x: c.block.x, y: c.block.y + c.block.h - h - 30, w, h, placeholder: true }),
      makeText({ name: 'Caption', x: c.block.x, y: c.block.y + c.block.h - 24, w, h: 24, text: '**Fig. 1** The picture occupies whole fields.', style: plain({ fontFamily: 'inter', fontSize: 7.5, leading: 9 }) }),
    ];
  } },

  /* ---------------------------------------------------------------- Hochuli */
  { id: 'hochuli-marginal', designer: 'hochuli', label: 'Marginal heading', make: (c) => {
    const m = outerMargin(c);
    return [makeText({ name: 'Marginal heading', x: m.x, y: m.y, w: m.w, h: 30, text: '*Word space*', style: plain({ fontSize: 8.5, leading: 12, align: c.side === 'left' ? 'right' : 'left' }) })];
  } },
  { id: 'hochuli-caption', designer: 'hochuli', label: 'Caption beside a picture', make: (c) => {
    const m = outerMargin(c);
    const h = Math.round((c.block.w * 0.62) / 12) * 12;
    return [
      makeImage({ name: 'Picture', x: c.block.x, y: c.block.y + c.block.h - h, w: c.block.w, h, placeholder: true }),
      makeText({ name: 'Caption', x: m.x, y: c.block.y + c.block.h - h, w: m.w, h: 50, text: '*Fig.* The caption aligns with the top of the picture.', style: plain({ fontSize: 7.5, leading: 10, align: c.side === 'left' ? 'right' : 'left', color: '#4e463c' }) }),
    ];
  } },
  { id: 'hochuli-numeral', designer: 'hochuli', label: 'Typotron numeral', make: (c) => [makeText({ name: 'Numeral', x: c.block.x, y: c.block.y, w: c.block.w, h: c.block.h * 0.55, text: '*17*', style: plain({ fontFamily: 'fraunces', fontSize: 170, leading: 160, color: '#d26a1e', features: { lnum: true } }) })] },
  { id: 'hochuli-stepped', designer: 'hochuli', label: 'Stepped title', make: (c) => ['*Detail*', 'in', 'Typography'].map((t, i) => makeText({ name: `Title line ${i + 1}`, x: c.block.x + i * mm(8), y: c.block.y + i * 30, w: c.block.w - i * mm(8), h: 30, text: t, style: plain({ fontFamily: 'eb-garamond', fontSize: 22, leading: 28, color: i === 2 ? '#d26a1e' : '#1b1813' }) })) },

  /* ---------------------------------------------------------------- Unger */
  { id: 'unger-reading', designer: 'unger', label: 'Reading-size text', note: 'Small size, open leading, a measure of about 60 characters.', make: (c) => [makeText({ name: 'Reading text', x: c.block.x, y: c.block.y, w: Math.min(c.block.w, 260), h: c.block.h / 2, text: `${SAMPLE} Reading is not seeing letters; it is recognising word-shapes in a rhythm, which the typographer either supports or disturbs.`, style: textStyle({ fontFamily: 'fraunces', fontSize: 9, leading: 13, align: 'left', axes: { opsz: 9 } }) })] },

  /* ---------------------------------------------------------------- Sato */
  { id: 'sato-glow', designer: 'sato', label: 'Luminous gradient', make: (c) => [makeGradient({ x: -c.spec.bleed, y: -c.spec.bleed, w: c.W + 2 * c.spec.bleed, h: c.H + 2 * c.spec.bleed })] },
  { id: 'sato-vertical-title', designer: 'sato', label: 'Vertical title', make: (c) => [makeText({ name: 'Vertical title', x: c.block.x + c.block.w - 34, y: c.block.y, w: 30, h: c.block.h * 0.5, text: '頁の形', style: textStyle({ fontFamily: 'mincho', fontSize: 18, leading: 24, writingMode: 'vertical', tracking: 200, baselineGrid: false }) })] },
  { id: 'sato-vertical-text', designer: 'sato', label: 'Vertical text (tategaki)', make: (c) => [makeText({ name: 'Vertical text', x: c.block.x + c.block.w * 0.25, y: c.block.y, w: c.block.w * 0.75, h: c.block.h * 0.8, text: SAMPLE_JAPANESE, style: textStyle({ fontFamily: 'mincho', fontSize: 10.5, leading: 19, writingMode: 'vertical', tateChuYoko: true, baselineGrid: false }) })] },
];

/** Registry motifs, placed at their default size inside the block. */
const MOTIF_ITEMS: LibraryItem[] = MOTIF_LIST.map((m) => ({
  id: `motif-${m.kind}`,
  designer: m.designer,
  label: m.label,
  note: m.description,
  make: (c: LibraryContext) => {
    const k = Math.min(1, c.block.w / m.defaultSize.w, c.block.h / m.defaultSize.h);
    const w = m.defaultSize.w * k, h = m.defaultSize.h * k;
    return [makeMotif(m.kind, { x: c.block.x + (c.block.w - w) / 2, y: c.block.y + (c.block.h - h) / 2, w, h })];
  },
}));

export function libraryItems(): LibraryItem[] {
  return [...HANDMADE, ...MOTIF_ITEMS];
}
