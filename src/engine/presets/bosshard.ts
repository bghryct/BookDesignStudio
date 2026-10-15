/**
 * Hans Rudolf Bosshard (1929–2017), Zurich typographer and teacher — "Der typografische
 * Raster / The Typographic Grid" (2000), "Technische Grundlagen zur Satzherstellung",
 * "Sechs Essays zu Typografie, Schrift, Grafik und Kunst".
 *
 * Two families:
 *  • Typographic Grid — two column systems superimposed on one common unit grid (their
 *    least common multiple), so text can run in one system while pictures and captions use
 *    the other; rows locked to the baseline; numbered, technical headings.
 *  • Concrete Typography — the constructive side of his work and teaching: diagonal bar
 *    progressions, serial colour fields after Richard Paul Lohse, rotated text columns.
 */
import type { BookSpec, Element, TextStyle } from '../../model/types';
import { makeText, makeShape, makeImage, makeRule, makeMotif, makeMaster, textStyle } from '../../model/factory';
import { mm } from '../../model/units';
import { textBlock, lockGridToBaseline, type PageSide } from '../grid';
import { computeBinding } from '../binding';
import { rng } from '../../lib/random';
import type { PresetFamily } from './helpers';
import { specWith, chain, firstParagraphs, plain, blankPages } from './helpers';

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number) => (a * b) / gcd(a, b);

/** Column boxes of an n-column system inside a block. */
function system(block: { x: number; w: number }, n: number, gutter: number) {
  const w = (block.w - gutter * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: block.x + i * (w + gutter), w }));
}

/** Span columns a..b (inclusive) of a system. */
const span = (cols: { x: number; w: number }[], a: number, b: number) => ({ x: cols[a].x, w: cols[Math.min(cols.length - 1, b)].x + cols[Math.min(cols.length - 1, b)].w - cols[a].x });

const snapDown = (v: number, base: number) => Math.floor(v / base) * base;

export const bosshardGrid: PresetFamily = {
  id: 'bosshard-grid', name: 'Typographic Grid', designer: 'Hans Rudolf Bosshard', era: 'Der typografische Raster, 2000', accent: '#0050a0',
  description: 'Two column systems superimposed on one common unit grid: text runs in one, pictures and captions in the other; rows are whole baselines; headings are numbered like a technical manual.',
  rationale: [
    'Combining a 2- and a 3-column system on their common 6-unit grid lets text and images keep different measures yet stay aligned.',
    'Every vertical measure is a multiple of the line: field heights, gutters, picture heights and the space around headings.',
    'Decimal numbering and a strict, unornamented grotesque make the structure itself legible — typography as construction.',
  ],
  generate(c, variant, seed) {
    const pairs: [number, number][] = [[2, 3], [3, 4], [2, 3], [2, 5], [4, 6], [3, 4], [2, 3], [3, 5]];
    const [a, b] = pairs[variant % pairs.length];
    const units = lcm(a, b);
    const formats: [number, number][] = [[210, 280], [230, 300], [210, 297], [240, 240]];
    const [fw, fh] = formats[Math.floor(variant / 2) % formats.length];
    const accent = ['#0050a0', '#e30613', '#111111', '#e85d10'][variant % 4];
    const family = variant % 3 === 2 ? 'space-grotesk' : 'inter';
    const showDiagram = variant % 2 === 0;
    const base = 11;
    let spec = specWith((s) => {
      s.trimW = mm(fw); s.trimH = mm(fh);
      s.margins = { inner: s.trimW / 13, outer: s.trimW / 9, top: base * 4, bottom: s.trimH / 8 };
      s.grid = { ...s.grid, mode: 'modular', columns: units, rows: 6, gutter: base, rowGutter: base, baseline: base, baselineOffset: base, showGrid: true, microDivisions: 1 };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'smyth'; s.cover.finish = 'matte'; s.cover.material = '#f2f1ec'; s.paper.color = '#fbfaf6';
    });
    const locked = lockGridToBaseline(spec);
    spec = { ...spec, margins: locked.margins ?? spec.margins, grid: locked.grid ?? spec.grid };

    const body: TextStyle = textStyle({ fontFamily: family, fontSize: 8.5, leading: base, align: 'left', hyphenate: true, firstLineIndent: 0, paragraphSpacing: base, features: {} });
    const caption = (o: Partial<TextStyle> = {}) => plain({ fontFamily: family, fontSize: 7, leading: base, ...o });
    const m = makeMaster('A · Grid');
    for (const side of ['left', 'right'] as const) {
      const blk = textBlock(spec, side);
      const outer = side === 'left' ? 'left' : 'right';
      (side === 'left' ? m.left : m.right).push(
        makeText({ name: 'Folio', x: blk.x, y: blk.y + blk.h + base * 2, w: blk.w, h: 12, text: '{page}', style: caption({ align: outer, weight: 600 }) }),
        makeText({ name: 'Running head', x: blk.x, y: blk.y - base * 2.5, w: blk.w, h: 12, text: side === 'left' ? '{title}' : 'Der typografische Raster', style: caption({ align: outer }) }),
      );
    }
    const pages = blankPages(6, spec.paper.color, m.id);
    pages[0].masterId = null;
    const r = rng(seed);
    const L = textBlock(spec, 'left'), R = textBlock(spec, 'right');
    const sysA = (blk: { x: number; w: number }) => system(blk, a, base);
    const sysB = (blk: { x: number; w: number }) => system(blk, b, base);
    const rowH = (spec.grid.rowGutter ? (L.h - spec.grid.rowGutter * (spec.grid.rows - 1)) / spec.grid.rows : L.h / spec.grid.rows);

    // Verso: numbered chapter head, intro in system A, the grid demonstrated in system B.
    const head = span(sysA(L), 0, Math.max(0, a - 2));
    pages[1].elements.push(
      makeText({ name: 'Section number', x: L.x, y: L.y, w: L.w, h: base * 4, text: `**${1 + (variant % 3)}.${1 + (variant % 4)}**`, style: plain({ fontFamily: family, fontSize: 30, leading: base * 3, color: accent, weight: 600 }) }),
      makeText({ name: 'Chapter title', x: head.x, y: L.y + base * 4, w: Math.max(head.w, L.w * 0.6), h: base * 6, text: `**${c.title}**`, style: plain({ fontFamily: family, fontSize: 18, leading: base * 2, weight: 600 }) }),
      makeRule({ name: 'Rule', x: L.x, y: L.y + base * 10 - 4, w: L.w, h: 8, stroke: '#111111', strokeWidth: 0.5 }),
    );
    const introTop = L.y + base * 11;
    const introCols = sysA(L);
    const intro = introCols.map((col, i) => makeText({ name: `Intro ${i + 1}`, x: col.x, y: introTop, w: col.w, h: snapDown(rowH * 2.2, base), text: i === 0 ? firstParagraphs(c.body, 2) : '', style: i === 0 ? body : textStyle(body) }));
    chain(intro);
    pages[1].elements.push(...intro);
    const lowerTop = introTop + snapDown(rowH * 2.2, base) + base * 2;
    if (showDiagram) {
      pages[1].elements.push(makeMotif('dual-grid', { name: `Grid ${a}+${b}`, x: L.x, y: lowerTop, w: L.w, h: L.y + L.h - lowerTop - base * 3, params: { systemA: a, systemB: b, gutter: base }, colors: [accent, '#111111', '#b9c6d6'] }));
      pages[1].elements.push(makeText({ name: 'Figure caption', x: L.x, y: L.y + L.h - base * 2, w: L.w, h: base * 2, text: `**Fig. 1** ${a}- and ${b}-column systems on a common grid of ${units} units; gutters and rows = 1 line (${base} pt).`, style: caption() }));
    } else {
      const cols = sysB(L);
      cols.forEach((col, i) => {
        const h = snapDown(rowH * (1 + (i % 2)), base);
        pages[1].elements.push(makeImage({ name: `Picture ${i + 1}`, x: col.x, y: lowerTop, w: col.w, h, placeholder: true }));
        pages[1].elements.push(makeText({ name: `Caption ${i + 1}`, x: col.x, y: lowerTop + h + base * 0.5, w: col.w, h: base * 3, text: `**${i + 1}** Picture in the ${b}-column system.`, style: caption() }));
      });
    }

    // Recto: text in system A, pictures on system B, marginal heading in the first unit.
    const rA = sysA(R), rB = sysB(R);
    const unitW = (R.w - base * (units - 1)) / units;
    pages[2].elements.push(makeText({ name: 'Marginal heading', x: R.x, y: R.y, w: Math.max(unitW * 2 + base, 40), h: base * 3, text: `**${1 + (variant % 3)}.${2 + (variant % 4)}**\nRaster`, style: caption({ color: accent, weight: 600 }) }));
    const picCol = rB[rB.length - 1];
    const picH = snapDown(rowH * 1.6, base);
    pages[2].elements.push(
      makeImage({ name: 'Picture', x: picCol.x, y: R.y, w: picCol.w, h: picH, placeholder: true }),
      makeText({ name: 'Caption', x: picCol.x, y: R.y + picH + base * 0.5, w: picCol.w, h: base * 4, text: `**Fig. 2** One column of the ${b}-column system; its height is ${Math.round(picH / base)} lines.`, style: caption() }),
      makeShape({ name: 'Accent field', x: rB[0].x, y: R.y, w: rB[0].w, h: base * 2, fill: accent, stroke: null }),
    );
    const textTop = R.y + picH + base * 5;
    const rText = rA.map((col, i) => makeText({ name: `Text ${i + 1}`, x: col.x, y: textTop, w: col.w, h: R.y + R.h - textTop, style: textStyle(body) }));
    // Second spread: the other system for running text.
    const L2 = textBlock(spec, 'left' as PageSide), R2 = textBlock(spec, 'right' as PageSide);
    const l2 = sysB(L2).map((col, i) => makeText({ name: `Text B${i + 1}`, x: col.x, y: L2.y, w: col.w, h: L2.h, style: textStyle(body) }));
    const r2 = sysB(R2).map((col, i) => makeText({ name: `Text C${i + 1}`, x: col.x, y: R2.y + (i === 0 ? snapDown(rowH * 2, base) : 0), w: col.w, h: R2.h - (i === 0 ? snapDown(rowH * 2, base) : 0), style: textStyle(body) }));
    const all = [...intro, ...rText, ...l2, ...r2];
    chain(all);
    intro[0].text = c.body;
    pages[2].elements.push(...rText);
    pages[3].elements.push(...l2);
    pages[4].elements.push(...r2);
    if (r() > 0.5) pages[4].elements.push(makeShape({ name: 'Accent field', x: R2.x, y: R2.y, w: sysB(R2)[0].w, h: snapDown(rowH * 2, base) - base, fill: accent, stroke: null, opacity: 0.9 }));

    // Cover: the grid itself as the image.
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makeMotif('dual-grid', { name: 'Cover grid', anchor: 'front', x: mm(12), y: mm(12), w: front.w - mm(24), h: calc.coverH * 0.62, params: { systemA: a, systemB: b, gutter: base }, colors: [accent, '#111111', '#c8d0da'] }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(12), y: calc.coverH * 0.72, w: front.w - mm(24), h: 80, text: `**${c.title}**\n${c.author}`, style: plain({ fontFamily: family, fontSize: 16, leading: 20, weight: 500 }) }),
    ];
    return { name: 'Typographic Grid', book: spec, pages, masters: [m], cover, focusSpread: 1, caption: `${a} + ${b} columns on ${units} units · ${fw}×${fh} · ${family === 'inter' ? 'Inter' : 'Space Grotesk'}${showDiagram ? ' · grid shown' : ''}` };
  },
};

export const bosshardConcrete: PresetFamily = {
  id: 'bosshard-concrete', name: 'Concrete Typography', designer: 'Hans Rudolf Bosshard', era: 'Konkrete Kunst & constructive typography', accent: '#e30613',
  description: 'Bosshard the constructivist: diagonal bar progressions, Lohse-style serial colour fields and rotated text columns, all ruled by one square module.',
  rationale: [
    'Concrete art (Max Bill, Richard Paul Lohse) builds images from rule and series, not depiction — the same logic as a grid.',
    'Diagonals introduce movement into an orthogonal system only when they too follow the module and a numerical progression.',
    'Text becomes a constructive element: rotated, stepped or set in narrow columns, it is weighed against the colour fields.',
  ],
  generate(c, variant, seed) {
    const square = variant % 2 === 0;
    const spec = specWith((s) => {
      s.trimW = mm(square ? 220 : 210); s.trimH = mm(square ? 220 : 270);
      const m = s.trimW / 11;
      s.margins = { inner: m, outer: m, top: m, bottom: m * 1.25 };
      s.grid = { ...s.grid, mode: 'modular', columns: 6, rows: square ? 6 : 8, gutter: 8, rowGutter: 8, baseline: 10, baselineOffset: 10, showGrid: false };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'smyth'; s.cover.finish = 'matte'; s.cover.material = '#f4f3ef'; s.paper.color = variant === 5 ? '#e9e7e1' : '#fbfaf7';
    });
    const palettes = [
      ['#e30613', '#111111', '#f2c230', '#0050a0', '#2f8f5b', '#f08a24'],
      ['#111111', '#6d6d6d', '#b8b8b8', '#e30613', '#f4f3ef', '#2b2b2b'],
      ['#0050a0', '#4a90d9', '#9cc4ef', '#f2c230', '#e85d10', '#111111'],
      ['#2f8f5b', '#a4c639', '#f2c230', '#f08a24', '#e30613', '#7a1f5c'],
    ];
    const pal = palettes[variant % 4];
    const family = variant % 3 === 1 ? 'space-grotesk' : 'inter';
    const B = (side: PageSide) => textBlock(spec, side);
    const L = B('left'), R = B('right');
    const pages = blankPages(5, spec.paper.color);
    const comp = variant % 4;
    // Verso: the constructive image.
    if (comp === 0 || comp === 2) {
      pages[1].elements.push(makeMotif('diagonal-bars', { name: 'Diagonal bars', x: L.x, y: L.y, w: L.w, h: L.h, params: { angle: comp === 0 ? 45 : 30, count: 9 + variant, progression: variant % 4, gap: 0.6 }, colors: [pal[0], pal[1], ''] }));
    } else {
      pages[1].elements.push(makeMotif('concrete-fields', { name: 'Serial fields', x: L.x, y: L.y, w: L.w, h: L.h, params: { cols: 6, rows: square ? 6 : 8, mode: variant % 4, gap: 0 }, colors: pal }));
    }
    // Recto: rotated title along the inner edge, numbered text in a narrow column.
    const titleLen = R.h;
    const titleThick = 34;
    pages[2].elements.push(
      makeText({ name: 'Rotated title', x: R.x - titleLen / 2 + titleThick / 2, y: R.y + titleLen / 2 - titleThick / 2, w: titleLen, h: titleThick, rotation: -90, text: `**${c.title}**`, verticalAlign: 'top', style: plain({ fontFamily: family, fontSize: 22, leading: 26, weight: 600, align: 'right', color: pal[0] === '#111111' ? pal[3] : pal[0] }) }),
    );
    const colW = (R.w - titleThick - 16) / 2;
    const text = makeText({ name: 'Text', x: R.x + titleThick + 16, y: R.y + R.h * 0.35, w: colW, h: R.h * 0.65, text: firstParagraphs(c.body, 3).split('\n').map((p, i) => `**${i + 1}** ${p}`).join('\n'), style: textStyle({ fontFamily: family, fontSize: 8, leading: 10, align: 'left', firstLineIndent: 0, paragraphSpacing: 10, hyphenate: true, baselineGrid: true }) });
    pages[2].elements.push(text);
    pages[2].elements.push(makeMotif('dimension', { name: 'Module', x: R.x + titleThick + 16, y: R.y + R.h * 0.35 - 22, w: colW, h: 14 }));
    pages[2].elements.push(makeShape({ name: 'Square module', x: R.x + titleThick + 16 + colW + 16, y: R.y + R.h - colW, w: colW, h: colW, fill: pal[comp === 1 ? 3 : 2], stroke: null }));
    // Third spread: a reversed progression.
    pages[3].elements.push(makeMotif(comp % 2 ? 'diagonal-bars' : 'concrete-fields', { name: 'Counter-image', x: -spec.bleed, y: -spec.bleed, w: spec.trimW + 2 * spec.bleed, h: spec.trimH + 2 * spec.bleed, params: comp % 2 ? { angle: 60, count: 14, progression: 2, gap: 0.5 } : { cols: 8, rows: 8, mode: (variant + 1) % 4, gap: 0 }, colors: comp % 2 ? [pal[2], pal[0], spec.paper.color] : [...pal].reverse() }));
    pages[4].elements.push(makeText({ name: 'Colophon', x: R.x, y: R.y + R.h - 60, w: R.w / 2, h: 60, text: `${c.title}\nKonkrete Typografie\n${seed}`, style: plain({ fontFamily: 'ibm-plex-mono', fontSize: 7, leading: 10 }) }));
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makeMotif(comp === 1 ? 'concrete-fields' : 'diagonal-bars', { name: 'Cover image', anchor: 'front', x: 0, y: 0, w: front.w, h: calc.coverH * 0.7, params: comp === 1 ? { cols: 6, rows: 4, mode: variant % 4, gap: 0 } : { angle: 45, count: 12, progression: variant % 4, gap: 0.55 }, colors: comp === 1 ? pal : [pal[0], pal[1], ''] }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(12), y: calc.coverH * 0.76, w: front.w - mm(24), h: 60, text: `**${c.title}**`, style: plain({ fontFamily: family, fontSize: 15, leading: 18, weight: 600 }) }),
    ];
    const names = ['45° bar progression', 'Lohse serial fields', '30° bar progression', 'Symmetric fields'];
    return { name: 'Concrete Typography', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `${names[comp]} · ${square ? 'square' : 'portrait'} · ${family === 'inter' ? 'Inter' : 'Space Grotesk'}` };
  },
};
