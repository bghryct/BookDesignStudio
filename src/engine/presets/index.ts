/**
 * Generative layout presets. Each family encodes a historical/modernist canon as rules and
 * produces a small, complete book (spec overrides, masters, pages, cover) from shared content.
 * `variant` selects a structured variation; `seed` drives the generators.
 */
import type { BookSpec, Element, Master, Page, Project, TextElement, TextStyle, Swatch, OrnamentKind, PatternKind, OverprintKind } from '../../model/types';
import {
  makeText, makePage, makeMaster, makeRule, makeShape, makeOrnament, makeInitial, makePattern, makeOverprint, makeGradient,
  makeCutout, makeGridType, makeImage, makePath, textStyle, CLEVES_PALETTE, INK, VERMILION, ULTRAMARINE, GOLD,
} from '../../model/factory';
import { defaultBookSpec, SAMPLE_ESSAY, SAMPLE_JAPANESE, SAMPLE_TITLE } from '../../model/defaults';
import { mm } from '../../model/units';
import { canonMargins, textBlock, computeGrid, lockGridToBaseline, type CanonKind, type PageSide } from '../grid';
import { computeBinding } from '../binding';
import { rng, pick } from '../../lib/random';

import type { PresetContent, PresetResult, PresetFamily } from './helpers';
import { specWith, sideOf, chain, firstParagraphs, plain, runningHeads, textFrames, blankPages } from './helpers';
import { bosshardGrid, bosshardConcrete } from './bosshard';
import { hochuliDetail, hochuliTypotron } from './hochuli';

export type { PresetContent, PresetResult, PresetFamily } from './helpers';
export { defaultContent } from './helpers';

/* -------------------------------------------------------------------------- */
/* 1 · Tschichold — classical golden canon                                      */
/* -------------------------------------------------------------------------- */

const tschichold: PresetFamily = {
  id: 'tschichold', name: 'Golden Canon', designer: 'Jan Tschichold', era: '1940s–60s (after medieval canons)', accent: '#b0331f',
  description: 'Symmetrical classical book: Van de Graaf / 2:3:4:6 margins, centred running heads in letter-spaced small caps, old-style figures, a sunken chapter opening with a rubricated initial.',
  rationale: [
    'Margins in the ratio 2:3:4:6 make the text block echo the page and place it optically high and toward the spine.',
    'Small caps letter-spaced ~10% for running heads; old-style figures sit quietly in running text.',
    'Chapter openings drop by a third of the text block — the “sink” — and open with a two- or three-line initial.',
  ],
  generate(c, variant, seed) {
    const trims: [number, number][] = [[144, 216], [140, 226.5], [156, 234], [138, 216]];
    const canons: CanonKind[] = ['van-de-graaf', 'tschichold-2346', 'golden', 'van-de-graaf'];
    const [tw, th] = trims[variant % 4];
    const canon = canons[Math.floor(variant / 2) % 4];
    const accent = variant % 2 ? ULTRAMARINE : VERMILION;
    const family = variant >= 6 ? 'fraunces' : 'eb-garamond';
    const spec = specWith((s) => {
      s.trimW = mm(tw); s.trimH = mm(th);
      s.margins = canonMargins(canon, s.trimW, s.trimH);
      s.grid = { ...s.grid, columns: 1, rows: 1, baseline: 14, baselineOffset: 14, showCanon: variant % 3 === 0 };
      s.title = c.title; s.author = c.author; s.subtitle = c.subtitle; s.publisher = c.publisher;
      s.cover.material = pick(rng(seed), ['#283548', '#3a2a22', '#2f3b2e', '#4a1f1c']);
    });
    const body = textStyle({ fontFamily: family, fontSize: 11, leading: 14, features: { onum: true, pnum: true, liga: true } });
    const master = runningHeads(spec, { fontFamily: family, tracking: 120, features: { smcp: true, c2sc: true, onum: true } });
    const paper = spec.paper.color;
    const pages = [makePage({ paperColor: paper, label: 'Title' }), ...blankPages(2, paper), ...blankPages(2, paper, master.id)];
    // Title page (recto).
    const tb = textBlock(spec, 'right');
    pages[0].elements.push(
      makeText({ name: 'Title', x: tb.x - 8, y: spec.trimH * 0.2, w: tb.w + 16, h: 90, text: c.title.toUpperCase(), style: plain({ fontFamily: family, fontSize: 20, leading: 26, align: 'center', tracking: 100, features: { lnum: true } }) }),
      makeRule({ name: 'Rule', x: spec.trimW / 2 - 16, y: spec.trimH * 0.2 + 92, w: 32, h: 6, stroke: accent, strokeWidth: 0.75 }),
      makeText({ name: 'Author', x: tb.x, y: spec.trimH * 0.5, w: tb.w, h: 20, text: `^${c.author}^`, style: plain({ fontFamily: family, align: 'center', tracking: 80 }) }),
      makeText({ name: 'Imprint', x: tb.x, y: spec.trimH - spec.margins.bottom * 0.7, w: tb.w, h: 20, text: `^${c.publisher}^`, style: plain({ fontFamily: family, fontSize: 9, align: 'center', tracking: 60 }) }),
    );
    // Epigraph verso.
    const lb = textBlock(spec, 'left');
    pages[1].elements.push(makeText({ name: 'Epigraph', x: lb.x + lb.w * 0.2, y: lb.y + lb.h * 0.25, w: lb.w * 0.6, h: 80, text: `*${firstParagraphs(c.body, 1).split('. ')[0]}.*`, style: plain({ fontFamily: family, fontSize: 10, leading: 14, align: 'left' }) }));
    // Chapter opening recto with sink.
    const sink = tb.h * 0.3;
    pages[2].elements.push(
      makeText({ name: 'Chapter', x: tb.x, y: tb.y, w: tb.w, h: 24, text: variant % 2 ? 'Chapter One' : 'I', style: plain({ fontFamily: variant % 2 ? family : 'cinzel', fontSize: variant % 2 ? 10 : 16, align: 'center', color: accent, tracking: variant % 2 ? 140 : 0, features: { smcp: true } }) }),
      makeText({ name: 'Chapter title', x: tb.x, y: tb.y + 34, w: tb.w, h: 40, text: '*The Proportion of the Page*', style: plain({ fontFamily: family, fontSize: 16, leading: 21, align: 'center' }) }),
    );
    const frames = textFrames(spec, [2, 3, 4], c.body, textStyle({ ...body, firstLineSmallCaps: true, dropCap: { ...body.dropCap, enabled: true, lines: variant % 3 === 2 ? 2 : 3, color: accent, fontFamily: variant % 2 ? 'cinzel' : family } }), { topOffset: (i) => (i === 0 ? sink : 0) });
    pages[2].elements.push(frames[0]);
    pages[3].elements.push(frames[1]);
    pages[4].elements.push(frames[2]);
    return { name: 'Golden Canon', book: spec, pages, masters: [master], cover: classicCover(spec, family, GOLD), focusSpread: variant % 2 ? 2 : 1, caption: `${tw}×${th} mm · ${canon.replace(/-/g, ' ')} · ${family === 'fraunces' ? 'Fraunces' : 'EB Garamond'}` };
  },
};

function classicCover(spec: BookSpec, family: string, foil: string): Element[] {
  const calc = computeBinding(spec);
  const front = calc.panels.find((p) => p.id === 'front')!;
  const spine = calc.panels.find((p) => p.id === 'spine')!;
  const H = calc.coverH;
  const inset = mm(9);
  const len = H * 0.6, thick = Math.max(10, spine.w * 0.7);
  return [
    makeShape({ name: 'Blind panel', anchor: 'front', x: inset, y: inset, w: front.w - 2 * inset, h: H - 2 * inset, fill: null, stroke: '#00000055', strokeWidth: 1.2, finish: 'blind-deboss' }),
    makeText({ name: 'Cover title', anchor: 'front', x: inset * 1.5, y: H * 0.32, w: front.w - inset * 3, h: 70, finish: 'gold-foil', text: spec.title.toUpperCase(), style: plain({ fontFamily: family === 'eb-garamond' ? 'cinzel' : family, fontSize: 14, leading: 20, align: 'center', tracking: 80, color: foil }) }),
    makeRule({ name: 'Foil rule', anchor: 'front', x: front.w / 2 - 18, y: H * 0.32 + 76, w: 36, h: 8, kind: 'scotch', stroke: foil, strokeWidth: 1.2, finish: 'gold-foil' }),
    makeText({ name: 'Spine title', anchor: 'spine', x: spine.w / 2 - len / 2, y: H * 0.42 - thick / 2, w: len, h: thick, rotation: 90, finish: 'gold-foil', verticalAlign: 'middle', text: spec.title.toUpperCase(), style: plain({ fontFamily: 'cinzel', fontSize: Math.min(10, thick * 0.55), leading: Math.min(12, thick * 0.7), align: 'center', tracking: 60, color: foil }) }),
  ];
}

/* -------------------------------------------------------------------------- */
/* 2 · Bringhurst — proportion & marginalia                                    */
/* -------------------------------------------------------------------------- */

const bringhurst: PresetFamily = {
  id: 'bringhurst', name: 'Elements of Style', designer: 'Robert Bringhurst', era: '1992 —', accent: '#8a2a1f',
  description: 'Asymmetric page with a wide outer margin that carries side-notes; text block proportioned like the page; heads and folios together at the outer top corner.',
  rationale: [
    'The page and the text block share a proportion chosen from the musical/golden series (§8.3).',
    'Notes live in the outer margin beside the line they gloss — the margin earns its width.',
    'Running head and folio combined at the outer corner, where the thumb finds them while flipping.',
  ],
  generate(c, variant, seed) {
    const ratios = [1.5, 1.618, 1.667, 1.414];
    const ratio = ratios[variant % 4];
    const w = 150;
    const spec = specWith((s) => {
      s.trimW = mm(w); s.trimH = mm(w * ratio);
      const k = 0.62;
      const bw = s.trimW * k, bh = bw * ratio;
      const hx = s.trimW - bw, hy = s.trimH - bh;
      s.margins = { inner: hx * 0.28, outer: hx * 0.72, top: hy * 0.38, bottom: hy * 0.62 };
      s.grid = { ...s.grid, columns: 1, baseline: 13, baselineOffset: 13 };
      s.title = c.title; s.author = c.author;
      s.cover.finish = 'paper'; s.binding.type = 'smyth'; s.cover.material = '#e9e1cf';
    });
    const family = variant >= 4 ? 'fraunces' : 'eb-garamond';
    const ragged = variant % 2 === 1;
    const body = textStyle({ fontFamily: family, fontSize: 10.5, leading: 13, align: ragged ? 'left' : 'justify', hyphenate: true });
    const m = makeMaster('A · Text');
    for (const side of ['left', 'right'] as const) {
      const b = textBlock(spec, side);
      (side === 'left' ? m.left : m.right).push(makeText({ name: 'Head & folio', x: b.x, y: b.y - 26, w: b.w, h: 14, text: side === 'left' ? '{page}  ·  ^{title}^' : '^{author}^  ·  {page}', style: plain({ fontFamily: family, fontSize: 8.5, align: side === 'left' ? 'left' : 'right', tracking: 40, features: { onum: true } }) }));
    }
    const paper = '#f6f1e6';
    const pages = blankPages(5, paper, m.id);
    pages[0].masterId = null;
    const tb = textBlock(spec, 'right');
    pages[0].elements.push(
      makeText({ name: 'Title', x: tb.x, y: tb.y + tb.h * 0.15, w: tb.w, h: 70, text: `*${c.title}*`, style: plain({ fontFamily: family, fontSize: 22, leading: 26, align: 'left' }) }),
      makeText({ name: 'Author', x: tb.x, y: tb.y + tb.h * 0.15 + 76, w: tb.w, h: 18, text: `^${c.author}^`, style: plain({ fontFamily: family, fontSize: 10, tracking: 80 }) }),
    );
    const frames = textFrames(spec, [1, 2, 3, 4], c.body, body);
    frames.forEach((f, i) => pages[i + 1].elements.push(f));
    // Side-notes in the outer margin, on the grid.
    const r = rng(seed);
    const notes = ['Van de Graaf, 1946: the canon by construction, without measurement.', 'Bulk: the caliper of a sheet relative to its weight.', 'Hochuli: even colour before ornament.', 'Leading is measured baseline to baseline.'];
    for (let i = 1; i < 5; i++) {
      const side = sideOf(spec, i);
      const b = textBlock(spec, side);
      const x = side === 'left' ? mm(9) : b.x + b.w + mm(5);
      const w = side === 'left' ? b.x - mm(14) : spec.trimW - b.x - b.w - mm(14);
      const y = b.y + Math.round((b.h * (0.15 + r() * 0.5)) / 13) * 13;
      pages[i].elements.push(makeText({ name: 'Side-note', x, y, w, h: 80, text: `*${notes[(i + variant) % notes.length]}*`, style: textStyle({ fontFamily: family, fontSize: 8, leading: 9.75, align: side === 'left' ? 'right' : 'left', hyphenate: false, firstLineIndent: 0, baselineGrid: false, color: '#5b4d3d' }) }));
    }
    return { name: 'Elements of Style', book: spec, pages, masters: [m], cover: classicCover(spec, family, '#3b2f25'), focusSpread: 1, caption: `1:${ratio.toFixed(3)} page · ${ragged ? 'ragged right' : 'justified'} · side-notes` };
  },
};

/* -------------------------------------------------------------------------- */
/* 3 · Müller-Brockmann — Swiss modular grid                                    */
/* -------------------------------------------------------------------------- */

const mullerBrockmann: PresetFamily = {
  id: 'muller-brockmann', name: 'Swiss Grid', designer: 'Josef Müller-Brockmann', era: '1950s–80s', accent: '#e30613',
  description: 'Field grid locked to the baseline (rows = whole lines, gutters = one line), flush-left ragged-right grotesque, asymmetric composition of type and image fields.',
  rationale: [
    'Rows are a whole number of baselines with a one-line gutter, so pictures and text align across fields.',
    'One family, few sizes: hierarchy from position and weight, not ornament.',
    'Asymmetry creates tension; the grid makes it read as order.',
  ],
  generate(c, variant, seed) {
    const grids: [number, number][] = [[4, 5], [3, 4], [6, 6], [4, 6], [2, 4], [5, 5], [4, 4], [6, 8]];
    const [cols, rows] = grids[variant % grids.length];
    const accent = ['#e30613', '#111111', '#0055a4', '#f2a900'][variant % 4];
    const family = variant % 3 === 2 ? 'space-grotesk' : 'inter';
    let spec = specWith((s) => {
      s.trimW = mm(210); s.trimH = mm(variant % 2 ? 280 : 297);
      s.margins = canonMargins('muller-brockmann', s.trimW, s.trimH);
      s.grid = { ...s.grid, columns: cols, rows, gutter: 12, rowGutter: 12, baseline: 12, baselineOffset: 12, showGrid: true };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'perfect'; s.cover.finish = 'matte'; s.cover.material = '#f4f4f0';
      s.paper.color = '#fbfbf8';
    });
    const locked = lockGridToBaseline(spec);
    spec = { ...spec, margins: locked.margins ?? spec.margins, grid: locked.grid ?? spec.grid };
    const body = textStyle({ fontFamily: family, fontSize: 9, leading: 12, align: 'left', hyphenate: true, firstLineIndent: 0, paragraphSpacing: 12, indentFirstParagraph: false, features: { tnum: false } });
    const m = makeMaster('A · Grid');
    for (const side of ['left', 'right'] as const) {
      const g = computeGrid(spec, side);
      (side === 'left' ? m.left : m.right).push(makeText({ name: 'Folio', x: g.cols[0].x, y: g.block.y + g.block.h + 14, w: g.cols[0].w, h: 12, text: '{page}', style: plain({ fontFamily: family, fontSize: 8, weight: 600 }) }));
    }
    const paper = spec.paper.color;
    const pages = blankPages(5, paper, m.id);
    const r = rng(seed);
    const lg = computeGrid(spec, 'left');
    const rg = computeGrid(spec, 'right');
    const field = (g: typeof lg, c0: number, r0: number, cw: number, rh: number) => ({
      x: g.cols[c0].x, y: g.rows[r0].y,
      w: g.cols[Math.min(g.cols.length - 1, c0 + cw - 1)].x + g.cols[Math.min(g.cols.length - 1, c0 + cw - 1)].w - g.cols[c0].x,
      h: g.rows[Math.min(g.rows.length - 1, r0 + rh - 1)].y + g.rows[Math.min(g.rows.length - 1, r0 + rh - 1)].h - g.rows[r0].y,
    });
    // Verso: large title across the top fields + image fields.
    const t = field(lg, 0, 0, Math.max(1, cols - 1), 1);
    pages[1].elements.push(makeText({ name: 'Title', ...t, text: c.title.toLowerCase().replace(/^\w/, (ch) => ch.toUpperCase()), style: plain({ fontFamily: family, fontSize: Math.min(48, t.w / 6), leading: Math.min(48, t.w / 6) * 1.05, weight: 700, tracking: -20, align: 'left' }) }));
    const img = field(lg, Math.floor(r() * Math.max(1, cols - 2)), Math.min(rows - 1, 1 + Math.floor(r() * 2)), Math.max(1, Math.ceil(cols / 2)), Math.max(1, Math.ceil(rows / 2)));
    pages[1].elements.push(makeImage({ name: 'Picture field', ...img, placeholder: true }));
    pages[1].elements.push(makeText({ name: 'Caption', x: img.x, y: img.y + img.h + 6, w: Math.max(60, img.w / 2), h: 36, text: '**Fig. 1** Field grid of ' + cols * rows + ' modules, rows locked to the 12 pt baseline.', style: plain({ fontFamily: family, fontSize: 7.5, leading: 9 }) }));
    pages[1].elements.push(makeShape({ name: 'Accent', ...field(lg, cols - 1, rows - 1, 1, 1), shape: variant % 2 ? 'ellipse' : 'rect', fill: accent, stroke: null }));
    // Recto: two-column text spanning fields.
    const span = Math.max(1, Math.min(cols, cols >= 4 ? cols - 1 : cols));
    const tf = field(rg, cols - span, Math.min(1, rows - 1), span, rows - Math.min(1, rows - 1));
    const frames = [
      makeText({ name: 'Text 1', ...tf, columns: span >= 3 ? 2 : 1, columnGap: 12, text: c.body, style: body }),
      makeText({ name: 'Text 2', ...field(lg, 0, 0, cols, rows), columns: Math.min(3, cols), columnGap: 12, style: textStyle(body) }),
    ];
    chain(frames);
    pages[2].elements.push(frames[0], makeText({ name: 'Section', ...field(rg, 0, 0, Math.max(1, cols - span), 1), text: '**1**\nProportion', style: plain({ fontFamily: family, fontSize: 9, leading: 12, weight: 500 }) }));
    pages[3].elements.push(frames[1]);
    const cover = swissCover(spec, family, accent, c.title, r);
    return { name: 'Swiss Grid', book: spec, pages, masters: [m], cover, focusSpread: 1, caption: `${cols} × ${rows} fields · ${family === 'inter' ? 'Inter' : 'Space Grotesk'} · accent ${accent}` };
  },
};

function swissCover(spec: BookSpec, family: string, accent: string, title: string, r: () => number): Element[] {
  const calc = computeBinding(spec);
  const front = calc.panels.find((p) => p.id === 'front')!;
  const H = calc.coverH;
  const els: Element[] = [];
  const n = 5 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const d = front.w * (0.9 - i * 0.12);
    if (d <= 10) break;
    els.push(makeShape({ name: 'Ring', anchor: 'front', x: front.w * 0.62 - d / 2, y: H * 0.38 - d / 2, w: d, h: d, shape: 'ellipse', fill: null, stroke: i % 2 ? '#111111' : accent, strokeWidth: 6 + i * 2, blend: 'multiply' }));
  }
  els.push(makeText({ name: 'Cover title', anchor: 'front', x: mm(12), y: H * 0.72, w: front.w - mm(24), h: 90, text: title.toLowerCase(), style: plain({ fontFamily: family, fontSize: 26, leading: 28, weight: 700, tracking: -20, color: '#111111' }) }));
  return els;
}

/* -------------------------------------------------------------------------- */
/* 4 · Crouwel — systematic modular grid                                        */
/* -------------------------------------------------------------------------- */

const crouwel: PresetFamily = {
  id: 'crouwel', name: 'Systematic Grid', designer: 'Wim Crouwel', era: '1960s–70s', accent: '#ff3b1f',
  description: 'Machine-like square modules, equal margins, a modular alphabet for titles, lowercase grotesque text and colour blocks that occupy whole modules.',
  rationale: [
    'Everything — type, image, colour — occupies whole modules of one square grid.',
    'Letters are constructed on the grid too (a modular alphabet), so title and layout share one system.',
    'Lowercase only: Crouwel considered capitals unnecessary for a rational typography.',
  ],
  generate(c, variant, seed) {
    const mods: [number, number][] = [[5, 7], [4, 6], [6, 8], [3, 4], [5, 5], [6, 6], [4, 5], [7, 9]];
    const [cols, rows] = mods[variant % mods.length];
    const palette = [['#ff3b1f', '#111111'], ['#0048ff', '#111111'], ['#00a651', '#111111'], ['#111111', '#ff3b1f'], ['#ffd400', '#111111'], ['#e4007c', '#0048ff'], ['#111111', '#999999'], ['#ff6a00', '#0048ff']][variant % 8];
    const square = variant % 2 === 0;
    const spec = specWith((s) => {
      s.trimW = mm(square ? 220 : 210); s.trimH = mm(square ? 220 : 297);
      s.margins = canonMargins('crouwel', s.trimW, s.trimH);
      const blockW = s.trimW - s.margins.inner - s.margins.outer;
      const mod = (blockW - 8 * (cols - 1)) / cols;
      s.grid = { ...s.grid, columns: cols, rows, gutter: 8, rowGutter: 8, baseline: 10, baselineOffset: 10, showGrid: true };
      // Square modules: adjust the bottom margin so rows are as tall as columns are wide.
      const blockH = rows * mod + 8 * (rows - 1);
      s.margins.bottom = Math.max(mm(8), s.trimH - s.margins.top - blockH);
      s.title = c.title; s.author = c.author;
      s.binding.type = 'perfect'; s.cover.finish = 'matte'; s.cover.material = '#f2f2ee'; s.paper.color = '#f9f9f6';
    });
    const family = variant % 3 === 1 ? 'inter' : 'space-grotesk';
    const r = rng(seed);
    const lg = computeGrid(spec, 'left'), rg = computeGrid(spec, 'right');
    const mod = (g: typeof lg, cx: number, ry: number, cw = 1, rh = 1) => ({
      x: g.cols[cx].x, y: g.rows[ry].y,
      w: g.cols[cx + cw - 1].x + g.cols[cx + cw - 1].w - g.cols[cx].x,
      h: g.rows[ry + rh - 1].y + g.rows[ry + rh - 1].h - g.rows[ry].y,
    });
    const pages = blankPages(5, spec.paper.color);
    // Verso: grid-alphabet title over two module rows + colour blocks.
    const tt = mod(lg, 0, 0, cols, Math.min(2, rows));
    pages[1].elements.push(makeGridType({ name: 'Title', ...tt, text: c.title.toLowerCase().split(' ').slice(0, 3).join(' '), color: palette[1], weight: 0.55 + (variant % 3) * 0.12, corner: variant % 3, showModules: variant % 2 === 1 }));
    const used = new Set<string>();
    for (let i = 0; i < Math.round(cols * rows * 0.18); i++) {
      const cx = Math.floor(r() * cols), ry = 2 + Math.floor(r() * Math.max(1, rows - 2));
      if (ry >= rows || used.has(`${cx},${ry}`)) continue;
      used.add(`${cx},${ry}`);
      pages[1].elements.push(makeShape({ name: 'Module', ...mod(lg, cx, ry), fill: i % 3 === 0 ? palette[0] : palette[1], stroke: null }));
    }
    // Recto: numbered modules + lowercase text.
    for (let i = 0; i < Math.min(cols, 6); i++) {
      pages[2].elements.push(makeText({ name: 'Index', ...mod(rg, i, 0), text: String(i + 1).padStart(2, '0'), style: plain({ fontFamily: family, fontSize: 22, leading: 22, weight: 600, color: i === variant % cols ? palette[0] : palette[1], features: { tnum: true } }) }));
    }
    const body = textStyle({ fontFamily: family, fontSize: 8.5, leading: 10, align: 'left', textTransform: 'lowercase', hyphenate: true, firstLineIndent: 0, paragraphSpacing: 10 });
    const frames = [
      makeText({ name: 'Text 1', ...mod(rg, 0, Math.min(2, rows - 1), Math.max(1, Math.ceil(cols / 2)), Math.max(1, rows - 2)), columns: 1, text: c.body, style: body }),
      makeText({ name: 'Text 2', ...mod(rg, Math.ceil(cols / 2), Math.min(2, rows - 1), Math.max(1, cols - Math.ceil(cols / 2)), Math.max(1, rows - 2)), style: textStyle(body) }),
    ];
    chain(frames);
    pages[2].elements.push(...frames);
    pages[3].elements.push(makeGridType({ name: 'Numerals', ...mod(lg, 0, 0, cols, Math.min(3, rows)), text: '0123456789', color: palette[0], weight: 0.7, corner: 1, showModules: true }));
    // Cover: modular title and blocks.
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const H = calc.coverH;
    const cover: Element[] = [
      makeShape({ name: 'Field', anchor: 'front', x: 0, y: 0, w: front.w, h: H * 0.5, fill: palette[0], stroke: null }),
      makeGridType({ name: 'Cover title', anchor: 'front', x: mm(10), y: H * 0.56, w: front.w - mm(20), h: H * 0.3, text: c.title.toLowerCase().split(' ').slice(0, 3).join(' '), color: palette[1], weight: 0.62, corner: variant % 3, showModules: false }),
    ];
    return { name: 'Systematic Grid', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${cols} × ${rows} square modules · corner ${['square', 'chamfer', 'round'][variant % 3]}` };
  },
};

/* -------------------------------------------------------------------------- */
/* 5 · Schrofer — kinetic system typography                                     */
/* -------------------------------------------------------------------------- */

const schrofer: PresetFamily = {
  id: 'schrofer', name: 'Restless Typography', designer: 'Jurriaan Schrofer', era: '1960s–80s', accent: '#111111',
  description: 'Optical, algorithmic type: letters set in rings, waves and spirals; moiré and rotating squares; strict black and white with one interruption.',
  rationale: [
    'A simple rule repeated with a small transformation (scale, rotation, phase) produces movement on a still page.',
    'Black-and-white contrast maximises the optical vibration; one colour interrupts the system.',
    'The pattern is generated, so every spread is a variation of the same program.',
  ],
  generate(c, variant, seed) {
    const kinds: PatternKind[] = ['text-rings', 'wave-letters', 'moire-lines', 'rotating-squares', 'radial-bars', 'dot-screen', 'text-spiral', 'letter-grid-scale'];
    const k1 = kinds[variant % 8], k2 = kinds[(variant + 3) % 8];
    const dark = variant % 2 === 1;
    const fg = dark ? '#f4f1ea' : '#111111', bg = dark ? '#111111' : '#f4f1ea';
    const accent = ['#e4002b', '#0050ff', '#ff7a00', '#00a36c'][variant % 4];
    const spec = specWith((s) => {
      s.trimW = mm(210); s.trimH = mm(260);
      s.margins = canonMargins('crouwel', s.trimW, s.trimH);
      s.grid = { ...s.grid, columns: 2, rows: 1, gutter: 14, baseline: 12, baselineOffset: 12 };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'smyth'; s.cover.finish = 'matte'; s.cover.material = bg; s.paper.color = bg;
    });
    const b = spec.bleed;
    const pages = blankPages(5, bg);
    const text = c.title.toUpperCase() + ' · ';
    pages[1].elements.push(makePattern({ name: 'Pattern', x: -b, y: -b, w: spec.trimW + 2 * b, h: spec.trimH + 2 * b, kind: k1, text, fontFamily: 'space-grotesk', color: fg, color2: accent, seed }));
    const tb = textBlock(spec, 'right');
    pages[2].elements.push(
      makePattern({ name: 'Pattern', x: tb.x, y: tb.y, w: tb.w, h: tb.w, kind: k2, text, fontFamily: 'inter', color: fg, color2: accent, seed: seed + 1 }),
      makeText({ name: 'Title', x: tb.x, y: tb.y + tb.w + 20, w: tb.w, h: 60, text: `**${c.title}**`, style: plain({ fontFamily: 'inter', fontSize: 18, leading: 22, color: fg }) }),
      makeText({ name: 'Text', x: tb.x, y: tb.y + tb.w + 70, w: tb.w, h: tb.h - tb.w - 70, columns: 2, columnGap: 14, text: firstParagraphs(c.body, 3), style: textStyle({ fontFamily: 'inter', fontSize: 8, leading: 12, align: 'left', color: fg, firstLineIndent: 0, paragraphSpacing: 6 }) }),
    );
    pages[3].elements.push(makePattern({ name: 'Pattern', x: -b, y: -b, w: spec.trimW + 2 * b, h: spec.trimH + 2 * b, kind: kinds[(variant + 5) % 8], text, fontFamily: 'space-grotesk', color: fg, color2: accent, seed: seed + 2 }));
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makePattern({ name: 'Cover pattern', anchor: 'front', x: 0, y: 0, w: front.w, h: calc.coverH, kind: k1, text, fontFamily: 'space-grotesk', color: fg, color2: accent, seed: seed + 3 }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(12), y: calc.coverH - mm(30), w: front.w - mm(24), h: 30, text: `**${c.title}**`, style: plain({ fontFamily: 'inter', fontSize: 13, color: accent }) }),
    ];
    return { name: 'Restless Typography', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${k1.replace(/-/g, ' ')} + ${k2.replace(/-/g, ' ')} · ${dark ? 'white on black' : 'black on white'}` };
  },
};

/* -------------------------------------------------------------------------- */
/* 6 · Martens — overprinted monoprints                                         */
/* -------------------------------------------------------------------------- */

const martens: PresetFamily = {
  id: 'martens', name: 'Overprint Monoprint', designer: 'Karel Martens', era: '1990s —', accent: '#ff4f9a',
  description: 'Translucent ink passes overprinted with misregistration, industrial numerals and counter-forms, raw roller texture, plain captions in a monospaced grotesque.',
  rationale: [
    'Each colour is a separate pass; where inks overlap a third colour appears (multiply / real PDF overprint).',
    'Misregistration and roller texture keep the hand and the machine visible.',
    'Found forms — numerals, counters, washers — become the image.',
  ],
  generate(c, variant, seed) {
    const inkSets = [['#ff4f9a', '#19a7e0', '#ffd400'], ['#ff6a13', '#2f5cff'], ['#1fae6b', '#ff3b30', '#1b1b1b'], ['#ffe600', '#e4007c'], ['#00b3e3', '#ff8a00', '#6a3fc1'], ['#e60012', '#0068b7'], ['#9bd400', '#ff2d87', '#00a0e9'], ['#1b1b1b', '#ff4f9a']];
    const kinds: OverprintKind[] = ['numerals', 'circles', 'squares-grid', 'counters', 'stripes', 'letters', 'circles', 'numerals'];
    const inks = inkSets[variant % 8];
    const kind = kinds[variant % 8];
    const kraft = variant === 5;
    const spec = specWith((s) => {
      s.trimW = mm(170); s.trimH = mm(240);
      s.margins = { inner: mm(14), top: mm(14), outer: mm(14), bottom: mm(20) };
      s.grid = { ...s.grid, columns: 4, rows: 6, gutter: 8, rowGutter: 8, baseline: 11, baselineOffset: 11 };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'smyth'; s.cover.finish = 'paper'; s.cover.material = kraft ? '#c7a77b' : '#efeae0'; s.paper.color = kraft ? '#c7a77b' : '#f2efe6';
    });
    const b = spec.bleed;
    const pages = blankPages(5, spec.paper.color);
    const text = kind === 'letters' ? c.title.replace(/\s/g, '').slice(0, 8).toUpperCase() : '1234567890';
    pages[1].elements.push(makeOverprint({ name: 'Monoprint', x: -b, y: -b, w: spec.trimW + 2 * b, h: spec.trimH * 0.75, kind, inks, text, seed, misregister: 2 + (variant % 3) * 2, texture: 0.2 + (variant % 4) * 0.12 }));
    const g = computeGrid(spec, 'left');
    pages[1].elements.push(makeText({ name: 'Caption', x: g.cols[0].x, y: spec.trimH * 0.8, w: g.cols[0].w + g.cols[1].w + 8, h: 50, text: `${String(variant + 1).padStart(2, '0')} / ${kind}\n${inks.join(' + ')}`, style: plain({ fontFamily: 'ibm-plex-mono', fontSize: 7, leading: 9.5 }) }));
    const rg = computeGrid(spec, 'right');
    pages[2].elements.push(
      makeOverprint({ name: 'Monoprint', x: rg.cols[2].x, y: rg.rows[0].y, w: rg.cols[3].x + rg.cols[3].w - rg.cols[2].x, h: rg.rows[1].y + rg.rows[1].h - rg.rows[0].y, kind: kinds[(variant + 1) % 8], inks: [...inks].reverse(), text: '0123456789', seed: seed + 9, misregister: 2, texture: 0.3 }),
      makeText({ name: 'Text', x: rg.cols[0].x, y: rg.rows[2].y, w: rg.cols[1].x + rg.cols[1].w - rg.cols[0].x, h: rg.block.y + rg.block.h - rg.rows[2].y, text: firstParagraphs(c.body, 4), style: textStyle({ fontFamily: 'inter', fontSize: 8.5, leading: 11, align: 'left', firstLineIndent: 0, paragraphSpacing: 5.5 }) }),
      makeText({ name: 'Notes', x: rg.cols[2].x, y: rg.rows[2].y, w: rg.cols[3].x + rg.cols[3].w - rg.cols[2].x, h: 120, text: 'printed matter\noverprint · multiply\nmisregistration ' + (2 + (variant % 3) * 2) + ' pt', style: plain({ fontFamily: 'ibm-plex-mono', fontSize: 7, leading: 11 }) }),
    );
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makeOverprint({ name: 'Cover monoprint', anchor: 'front', x: -mm(3), y: -mm(3), w: front.w + mm(6), h: calc.coverH + mm(6), kind: kinds[(variant + 2) % 8], inks, text: '0123456789', seed: seed + 4, misregister: 3, texture: 0.35 }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(10), y: mm(10), w: front.w - mm(20), h: 40, text: c.title.toLowerCase(), style: plain({ fontFamily: 'ibm-plex-mono', fontSize: 10, leading: 13 }) }),
    ];
    return { name: 'Overprint Monoprint', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${kind} · ${inks.length} ink passes${kraft ? ' · kraft' : ''}` };
  },
};

/* -------------------------------------------------------------------------- */
/* 7 · Munari — unreadable / tactile book                                       */
/* -------------------------------------------------------------------------- */

const munari: PresetFamily = {
  id: 'munari', name: 'Unreadable Book', designer: 'Bruno Munari', era: '1949 — Libri illeggibili', accent: '#c8372a',
  description: 'A book read by touch and sequence: coloured stocks, die-cut windows that reveal the next page, translucent vellum, a red thread that runs through the pages.',
  rationale: [
    'The material is the message: paper colour, weight, transparency and holes are the “text”.',
    'Die-cut windows make pages interact — each turn changes what the previous hole frames.',
    'Square format and no words keep the sequence non-linear and open to children and adults alike.',
  ],
  generate(c, variant, seed) {
    const stocks = [['#c8372a', '#f2c230', '#2a5aa8', '#f4efe4', '#1d1d1b', '#f4efe4'], ['#f4efe4', '#e8e2d2', '#c8372a', '#f4efe4', '#2a5aa8', '#f2c230'], ['#1d1d1b', '#f4efe4', '#c8372a', '#f2c230', '#f4efe4', '#2a5aa8'], ['#2a5aa8', '#f4efe4', '#f2c230', '#c8372a', '#f4efe4', '#1d1d1b']][variant % 4];
    const vellum = variant >= 4;
    const r = rng(seed);
    const spec = specWith((s) => {
      s.trimW = mm(210); s.trimH = mm(210);
      s.margins = { inner: mm(15), top: mm(15), outer: mm(15), bottom: mm(15) };
      s.grid = { ...s.grid, columns: 3, rows: 3, gutter: 0, rowGutter: 0, baseline: 12, baselineOffset: 12, showGrid: false };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'munari'; s.plannedPages = 24; s.binding.sectionPages = 8; s.paper.gsm = 160; s.paper.bulk = 1.1;
      s.cover.finish = 'paper'; s.cover.material = '#f4efe4';
    });
    const pages = stocks.map((col, i) => makePage({ paperColor: col, material: vellum && i % 3 === 1 ? 'vellum' : col === '#f4efe4' ? 'paper' : 'colored', vellumOpacity: 0.6 }));
    // Die-cut windows on rectos (they show through the following leaves).
    for (let i = 0; i < pages.length; i += 2) {
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const d = mm(25 + r() * 70);
        pages[i].elements.push(makeCutout({ name: 'Window', x: mm(20) + r() * (spec.trimW - d - mm(40)), y: mm(20) + r() * (spec.trimH - d - mm(40)), w: d, h: d, shape: r() > 0.35 ? 'ellipse' : 'rect' }));
      }
    }
    // The red thread: one continuous curve per page at matching heights.
    const y0 = spec.trimH * (0.3 + r() * 0.4);
    for (let i = 1; i < pages.length; i++) {
      const y1 = spec.trimH * (0.25 + r() * 0.5);
      const w = spec.trimW + spec.bleed * 2;
      pages[i].elements.push(makePath({ name: 'Thread', x: -spec.bleed, y: Math.min(y0, y1) - 20, w, h: Math.abs(y1 - y0) + 40, vw: w, vh: Math.abs(y1 - y0) + 40, d: `M0 ${y0 - Math.min(y0, y1) + 20} C${w * 0.35} ${(y0 - Math.min(y0, y1) + 20) + (r() - 0.5) * 80} ${w * 0.65} ${(y1 - Math.min(y0, y1) + 20) + (r() - 0.5) * 80} ${w} ${y1 - Math.min(y0, y1) + 20}`, fill: null, stroke: '#c8372a', strokeWidth: 1.6, cap: 'round' }));
    }
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makeShape({ name: 'Disc', anchor: 'front', x: front.w * 0.25, y: calc.coverH * 0.25, w: front.w * 0.5, h: front.w * 0.5, shape: 'ellipse', fill: '#c8372a', stroke: null }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(12), y: calc.coverH - mm(24), w: front.w - mm(24), h: 18, text: 'libro illeggibile', style: plain({ fontFamily: 'inter', fontSize: 9, tracking: 40 }) }),
    ];
    return { name: 'Unreadable Book', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${pages.length} coloured leaves · die-cuts${vellum ? ' · vellum' : ''} · red thread` };
  },
};

/* -------------------------------------------------------------------------- */
/* 8 · Catherine of Cleves — illuminated manuscript                             */
/* -------------------------------------------------------------------------- */

const cleves: PresetFamily = {
  id: 'cleves', name: 'Illuminated Manuscript', designer: 'Master of Catherine of Cleves', era: 'Utrecht, c. 1440', accent: '#c9a227',
  description: 'Book-of-hours page: ruled text block, rubricated blackletter headings, burnished-gold initials and margins that come alive with vines, flowers, pearls, shells and coins.',
  rationale: [
    'Generous outer and lower margins carry the decoration and protect the text.',
    'Hierarchy by colour, not size: rubrics in vermilion, versals in blue and gold.',
    'Trompe-l’œil borders blur page and object — the illuminator’s wit on vellum.',
  ],
  generate(c, variant, seed) {
    const kinds: OrnamentKind[] = ['vine-border', 'shells-and-coins', 'acanthus', 'pearls-and-beads', 'strewn-flowers', 'trompe-loeil-frame', 'vine-border', 'rubric-frame'];
    const kind = kinds[variant % 8];
    const twoCol = variant % 2 === 1;
    const spec = specWith((s) => {
      s.trimW = mm(variant % 4 < 2 ? 130 : 168); s.trimH = mm(variant % 4 < 2 ? 192 : 240);
      s.margins = canonMargins('manuscript', s.trimW, s.trimH);
      s.grid = { ...s.grid, columns: twoCol ? 2 : 1, rows: 1, gutter: 12, baseline: 12.5, baselineOffset: 12.5, showGrid: false };
      s.title = c.title; s.author = c.author;
      s.paper.color = '#efe4c9';
      s.binding.raisedBands = 5; s.binding.rounding = 0.8; s.cover.finish = 'leather'; s.cover.material = '#5b2a1c'; s.cover.edge = 'gilt'; s.cover.edgeColor = GOLD;
    });
    const paper = spec.paper.color;
    const pages = blankPages(5, paper);
    const pal = { ...CLEVES_PALETTE, ground: paper };
    // Verso: large illuminated initial within a full border (the "miniature" page).
    const lb = textBlock(spec, 'left');
    const band = Math.min(spec.margins.outer, spec.margins.bottom) * 0.82;
    pages[1].elements.push(makeOrnament({ name: 'Border', x: lb.x - band * 0.5, y: lb.y - band * 0.5, w: lb.w + band, h: lb.h + band, band: band * 0.9, kind: kind === 'rubric-frame' ? 'trompe-loeil-frame' : kind, seed, palette: pal, density: 0.55 + (variant % 3) * 0.15 }));
    pages[1].elements.push(makeInitial({ name: 'Initial', x: lb.x + lb.w * 0.12, y: lb.y + lb.h * 0.1, w: lb.w * 0.76, h: lb.w * 0.76, letter: c.title.trim()[0]?.toUpperCase() ?? 'D', fontFamily: variant % 3 === 0 ? 'unifraktur' : 'cinzel', frame: variant % 2 ? 'vine' : 'gilded', frameColor: ULTRAMARINE, ground: ULTRAMARINE, color: variant % 2 ? GOLD : '#f7efd9', seed }));
    pages[1].elements.push(makeText({ name: 'Rubric', x: lb.x, y: lb.y + lb.w * 0.92, w: lb.w, h: 40, text: c.title, style: plain({ fontFamily: 'unifraktur', fontSize: 14, leading: 18, align: 'center', color: VERMILION }) }));
    // Recto: ruled two-column text with gilded initial and marginal border.
    const rb = textBlock(spec, 'right');
    pages[2].elements.push(makeOrnament({ name: 'Ruling', x: rb.x - 4, y: rb.y - 2, w: rb.w + 8, h: rb.h + 4, kind: 'ruling', band: 4, density: 0.5, seed, palette: { ...pal, red: '#c46a5a' }, params: { lineSpacing: 12.5 } }));
    pages[2].elements.push(makeOrnament({ name: 'Marginalia', x: rb.x + rb.w + mm(3), y: rb.y - mm(4), w: spec.trimW - rb.x - rb.w - mm(6), h: rb.h + mm(8) + spec.margins.bottom * 0.6, kind: kind === 'trompe-loeil-frame' ? 'shells-and-coins' : kind, band: spec.trimW - rb.x - rb.w - mm(8), sides: { top: false, right: true, bottom: false, left: false }, seed: seed + 1, palette: pal, density: 0.65 }));
    pages[2].elements.push(makeText({ name: 'Rubric heading', x: rb.x, y: rb.y, w: rb.w, h: 20, text: 'Incipit liber de forma paginae', style: plain({ fontFamily: 'unifraktur', fontSize: 12, leading: 12.5, color: VERMILION }) }));
    const body = textStyle({
      fontFamily: 'eb-garamond', fontSize: 10.5, leading: 12.5, align: 'justify', features: { hlig: true, dlig: true, onum: true }, firstLineIndent: 0, paragraphSpacing: 0,
      dropCap: { ...textStyle().dropCap, enabled: true, lines: twoCol ? 2 : 3, frame: variant % 3 === 0 ? 'gilded' : variant % 3 === 1 ? 'vine' : 'rubric', color: variant % 3 === 0 ? ULTRAMARINE : variant % 3 === 1 ? GOLD : VERMILION, frameColor: variant % 3 === 1 ? ULTRAMARINE : VERMILION, fontFamily: 'cinzel', weight: 600 },
    });
    const frames = textFrames(spec, [2, 3, 4], c.body, body, { columns: twoCol ? 2 : 1, topOffset: (i) => (i === 0 ? 25 : 0) });
    pages[2].elements.push(frames[0]);
    pages[3].elements.push(frames[1], makeOrnament({ name: 'Marginalia', x: mm(4), y: textBlock(spec, 'left').y, w: textBlock(spec, 'left').x - mm(6), h: textBlock(spec, 'left').h, kind: 'strewn-flowers', band: textBlock(spec, 'left').x - mm(8), sides: { top: false, right: false, bottom: false, left: true }, seed: seed + 2, palette: pal, density: 0.5 }));
    pages[4].elements.push(frames[2]);
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const H = calc.coverH;
    const cover: Element[] = [
      makeOrnament({ name: 'Tooled frame', anchor: 'front', x: mm(8), y: mm(8), w: front.w - mm(16), h: H - mm(16), kind: 'rubric-frame', band: mm(10), seed: seed + 5, palette: { ...pal, red: GOLD, blue: GOLD, ink: GOLD, green: GOLD }, shadow: false, density: 0.6, finish: 'gold-foil' }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(18), y: H * 0.38, w: front.w - mm(36), h: 60, finish: 'gold-foil', text: c.title, style: plain({ fontFamily: 'unifraktur', fontSize: 16, leading: 20, align: 'center', color: GOLD }) }),
    ];
    return { name: 'Illuminated Manuscript', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${kind.replace(/-/g, ' ')} · ${twoCol ? 'two columns' : 'one column'} · ${['gilded', 'vine', 'penwork'][variant % 3]} initials` };
  },
};

/* -------------------------------------------------------------------------- */
/* 9 · Koichi Sato — Ma, vertical setting and soft gradients                   */
/* -------------------------------------------------------------------------- */

const sato: PresetFamily = {
  id: 'sato', name: 'Ma · Japanese', designer: 'Koichi Sato / wa-toji', era: '1970s — & Edo binding', accent: '#5d6bd6',
  description: 'Vertical Mincho setting read right-to-left, large heaven margin and empty space (間), luminous tonal gradients, stab-bound with four-hole yotsume toji.',
  rationale: [
    'Ma: the interval is an active element; the text occupies a small, carefully placed region of the page.',
    'Tategaki columns run top-to-bottom and right-to-left; the book binds on the right.',
    'Sato’s gradients are light rather than colour — soft, glowing, without edges.',
  ],
  generate(c, variant, seed) {
    const glows = [['#0f1022', '#f2b8a0', '#7f8cf0', '#ffe9c2'], ['#061a1f', '#59d2c1', '#2a6fdb', '#f6f1d1'], ['#1b0f22', '#ff7eb6', '#7a5cff', '#ffe0b3'], ['#f3efe7', '#f7c8a8', '#c7d7ff', '#ffffff']][variant % 4];
    const spec = specWith((s) => {
      s.trimW = mm(variant % 2 ? 150 : 127); s.trimH = mm(variant % 2 ? 220 : 188);
      s.direction = 'rtl';
      s.margins = canonMargins('ma', s.trimW, s.trimH);
      s.grid = { ...s.grid, columns: 1, baseline: 18, baselineOffset: 18, showGrid: false };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'stab'; s.binding.stabHoles = variant >= 4 ? 5 : 4; s.binding.fukuroToji = true; s.binding.threadColor = '#ece6da';
      s.cover.finish = 'paper'; s.cover.material = glows[0]; s.paper.color = '#f6f2ea'; s.paper.gsm = 50; s.paper.bulk = 1.6;
    });
    const b = spec.bleed;
    const pages = blankPages(5, spec.paper.color);
    // Frontispiece: full-bleed luminous gradient (page 2, shown on the right in an RTL spread).
    pages[1].elements.push(makeGradient({ name: 'Glow', x: -b, y: -b, w: spec.trimW + 2 * b, h: spec.trimH + 2 * b, base: glows[0], points: [{ x: 0.35, y: 0.38, color: glows[1], radius: 0.55 }, { x: 0.7, y: 0.66, color: glows[2], radius: 0.5 }, { x: 0.5, y: 0.92, color: glows[3], radius: 0.32 }], softness: 0.75, grain: 0.2, glow: true }));
    pages[1].elements.push(makeText({ name: 'Title (vertical)', x: spec.trimW * 0.68, y: spec.trimH * 0.16, w: 30, h: spec.trimH * 0.5, text: '頁の形', style: textStyle({ fontFamily: 'mincho', fontSize: 18, leading: 24, writingMode: 'vertical', color: variant === 3 ? '#1b1813' : '#ffffff', baselineGrid: false, tracking: 200 }) }));
    // Vertical text page with generous ma.
    const side = sideOf(spec, 2);
    const tb = textBlock(spec, side);
    pages[2].elements.push(makeText({ name: '本文 (vertical text)', x: tb.x + tb.w * 0.2, y: tb.y, w: tb.w * 0.8, h: tb.h * 0.82, text: c.japanese, style: textStyle({ fontFamily: 'mincho', fontSize: 10.5, leading: 19, writingMode: 'vertical', tateChuYoko: true, baselineGrid: false, color: '#1b1813' }) }));
    pages[2].elements.push(makeText({ name: 'Folio', x: tb.x, y: spec.trimH - spec.margins.bottom * 0.6, w: 30, h: 12, text: '{page}', style: plain({ fontFamily: 'mincho', fontSize: 8 }) }));
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makeGradient({ name: 'Cover glow', anchor: 'front', x: -mm(3), y: -mm(3), w: front.w + mm(6), h: calc.coverH + mm(6), base: glows[0], points: [{ x: 0.4, y: 0.35, color: glows[1], radius: 0.6 }, { x: 0.65, y: 0.7, color: glows[2], radius: 0.5 }], softness: 0.8, grain: 0.15, glow: true }),
      makeText({ name: 'Cover title', anchor: 'front', x: front.w * 0.72, y: mm(18), w: 26, h: calc.coverH * 0.5, text: '頁の形', style: textStyle({ fontFamily: 'mincho', fontSize: 16, writingMode: 'vertical', color: variant === 3 ? '#1b1813' : '#ffffff', baselineGrid: false, tracking: 250 }) }),
      makeText({ name: 'Title (latin)', anchor: 'front', x: mm(10), y: calc.coverH - mm(20), w: front.w * 0.6, h: 12, text: c.title.toLowerCase(), style: plain({ fontFamily: 'inter', fontSize: 6.5, tracking: 60, color: variant === 3 ? '#1b1813' : '#ffffffcc' }) }),
    ];
    return { name: 'Ma · Japanese', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${variant % 2 ? '菊判' : '四六判'} · 縦書き · ${variant >= 4 ? 'kikkō' : 'yotsume'} toji` };
  },
};

export const PRESET_FAMILIES: PresetFamily[] = [cleves, crouwel, schrofer, martens, munari, tschichold, bringhurst, mullerBrockmann, bosshardGrid, bosshardConcrete, hochuliDetail, hochuliTypotron, sato];

/** Merge a preset result into a project, keeping uploads (assets, fonts) and swatches. */
export function applyPreset(project: Project, r: PresetResult): Project {
  return {
    ...project,
    name: `${project.book.title || r.name}`,
    book: r.book,
    pages: r.pages,
    masters: r.masters,
    cover: { elements: r.cover },
    swatches: r.swatches ?? project.swatches,
  };
}

/** A throwaway project for thumbnails. */
export function previewProject(base: Project, r: PresetResult): Project {
  return applyPreset(base, r);
}
