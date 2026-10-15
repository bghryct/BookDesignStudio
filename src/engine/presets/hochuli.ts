/**
 * Jost Hochuli (b. 1933), St. Gallen — "Detail in Typography" (1987), "Designing Books:
 * Practice and Theory" (with Robin Kinross, 1996), the Typotron booklets (1983–98) and
 * Edition Ostschweiz.
 *
 * Hochuli's position is undogmatic: asymmetric or symmetric, whatever serves the text and
 * the reader. What never changes is the micro-typography — even colour, word spaces no
 * wider than needed, generous leading for small sizes, quiet marginalia.
 */
import type { Element, TextStyle } from '../../model/types';
import { makeText, makeImage, makeRule, makeMotif, makeMaster, makeShape, textStyle } from '../../model/factory';
import { mm } from '../../model/units';
import { textBlock } from '../grid';
import { computeBinding } from '../binding';
import type { PresetFamily } from './helpers';
import { specWith, chain, firstParagraphs, plain, blankPages, sideOf } from './helpers';

export const hochuliDetail: PresetFamily = {
  id: 'hochuli-detail', name: 'Detail in Typography', designer: 'Jost Hochuli', era: 'St. Gallen, 1987 —', accent: '#d26a1e',
  description: 'A reader-first book: small text with generous leading, careful word spacing, the text block shifted toward the spine or the fore-edge, and a margin column for headings, notes and captions.',
  rationale: [
    'Asymmetry is chosen for the reader: the open margin carries headings and captions where the eye looks for them, without interrupting the text.',
    'Micro-typography first — even grey, word spaces no wider than needed, leading proportionate to the measure.',
    'Hochuli is not doctrinaire: when the content is formal or ceremonial, a symmetric axis is equally right.',
  ],
  generate(c, variant) {
    const formats: [number, number][] = [[150, 230], [140, 220], [160, 240], [135, 210]];
    const [fw, fh] = formats[variant % 4];
    const symmetric = variant >= 6;
    const blockToForeEdge = variant === 3 || variant === 5;
    const justified = variant % 2 === 1;
    const family = variant === 2 || variant === 7 ? 'fraunces' : 'eb-garamond';
    const lead = 13;
    const spec = specWith((s) => {
      s.trimW = mm(fw); s.trimH = mm(fh);
      const W = s.trimW;
      if (symmetric) s.margins = { inner: W * 0.13, outer: W * 0.13, top: s.trimH * 0.1, bottom: s.trimH * 0.16 };
      else if (blockToForeEdge) s.margins = { inner: W * 0.3, outer: W * 0.09, top: s.trimH * 0.09, bottom: s.trimH * 0.15 };
      else s.margins = { inner: W * 0.1, outer: W * 0.3, top: s.trimH * 0.09, bottom: s.trimH * 0.15 };
      s.grid = { ...s.grid, columns: 1, rows: 1, baseline: lead, baselineOffset: lead, showGrid: false };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'smyth'; s.cover.finish = 'paper'; s.cover.material = '#ece5d6'; s.paper.color = '#f8f4ea';
    });
    const body: TextStyle = textStyle({ fontFamily: family, fontSize: 9.5, leading: lead, align: justified ? 'justify' : 'left', hyphenate: true, opticalMargin: true, firstLineIndent: 9.5, features: { onum: true, pnum: true, liga: true, kern: true } });
    const note = (o: Partial<TextStyle> = {}) => plain({ fontFamily: family, fontSize: 7.5, leading: lead, color: '#4e463c', ...o });
    // Marginal column: the wide margin (outer, or inner when the block sits at the fore-edge).
    const margin = (side: 'left' | 'right') => {
      const b = textBlock(spec, side);
      const gap = mm(5);
      const wideOnLeft = symmetric ? false : blockToForeEdge ? side === 'right' : side === 'left';
      return wideOnLeft ? { x: mm(9), w: b.x - mm(9) - gap, align: 'right' as const } : { x: b.x + b.w + gap, w: spec.trimW - b.x - b.w - gap - mm(9), align: 'left' as const };
    };
    const m = makeMaster('A · Text');
    for (const side of ['left', 'right'] as const) {
      const b = textBlock(spec, side);
      const mc = margin(side);
      if (symmetric) {
        (side === 'left' ? m.left : m.right).push(makeText({ name: 'Folio', x: b.x, y: b.y + b.h + lead * 1.5, w: b.w, h: 12, text: '{page}', style: note({ align: 'center', features: { onum: true } }) }));
      } else {
        (side === 'left' ? m.left : m.right).push(makeText({ name: 'Running head & folio', x: mc.x, y: b.y - lead, w: Math.max(30, mc.w), h: 12, text: side === 'left' ? '{page}  ^{title}^' : '^{author}^  {page}', style: note({ align: mc.align, tracking: 30, features: { onum: true, smcp: true } }) }));
      }
    }
    const pages = blankPages(6, spec.paper.color, m.id);
    pages[0].masterId = null;
    pages[1].masterId = null;
    // Title page.
    const tb = textBlock(spec, 'right');
    if (symmetric) {
      pages[0].elements.push(
        makeText({ name: 'Title', x: tb.x, y: spec.trimH * 0.24, w: tb.w, h: 60, text: c.title, style: plain({ fontFamily: family, fontSize: 18, leading: 24, align: 'center' }) }),
        makeText({ name: 'Author', x: tb.x, y: spec.trimH * 0.24 + 60, w: tb.w, h: 20, text: `^${c.author}^`, style: plain({ fontFamily: family, fontSize: 9.5, align: 'center', tracking: 60 }) }),
        makeText({ name: 'Imprint', x: tb.x, y: spec.trimH - spec.margins.bottom, w: tb.w, h: 20, text: c.publisher, style: note({ align: 'center' }) }),
      );
    } else {
      pages[0].elements.push(
        makeText({ name: 'Author', x: tb.x, y: tb.y + lead * 4, w: tb.w, h: lead * 2, text: c.author, style: plain({ fontFamily: family, fontSize: 9.5, leading: lead }) }),
        makeText({ name: 'Title', x: tb.x, y: tb.y + lead * 6, w: tb.w, h: lead * 6, text: `**${c.title}**`, style: plain({ fontFamily: family, fontSize: 17, leading: lead * 1.6 }) }),
        makeText({ name: 'Subtitle', x: tb.x, y: tb.y + lead * 11, w: tb.w * 0.8, h: lead * 3, text: `*${c.subtitle}*`, style: plain({ fontFamily: family, fontSize: 9.5, leading: lead }) }),
        makeText({ name: 'Imprint', x: tb.x, y: tb.y + tb.h - lead * 2, w: tb.w, h: lead * 2, text: c.publisher, style: note() }),
      );
    }
    // Verso figure: letter- and word-spacing study (Hochuli's subject).
    const lb = textBlock(spec, 'left');
    const lm = margin('left');
    pages[1].elements.push(makeMotif('spacing-specimen', { name: 'Spacing study', x: lb.x, y: lb.y + lead * 2, w: lb.w, h: lb.h * 0.55, fontFamily: family }));
    pages[1].elements.push(makeText({ name: 'Figure caption', x: symmetric ? lb.x : lm.x, y: symmetric ? lb.y + lb.h * 0.6 : lb.y + lead * 2, w: symmetric ? lb.w : Math.max(40, lm.w), h: lead * 5, text: `*Fig. 1* Letter-spacing changes the colour of a line; small capitals need it, lowercase rarely does.`, style: note({ align: symmetric ? 'center' : lm.align }) }));
    // Text pages with marginal headings beside the paragraphs they introduce.
    const frames = [2, 3, 4, 5].map((pi, i) => {
      const b = textBlock(spec, sideOf(spec, pi));
      const top = i === 0 ? lead * 6 : 0;
      return makeText({ name: `Text ${i + 1}`, x: b.x, y: b.y + top, w: b.w, h: b.h - top, style: textStyle(body) });
    });
    frames[0].text = c.body;
    frames[0].style = body;
    chain(frames);
    frames.forEach((f, i) => pages[i + 2].elements.push(f));
    const rb = textBlock(spec, 'right');
    pages[2].elements.push(makeText({ name: 'Chapter heading', x: symmetric ? rb.x : rb.x, y: rb.y, w: rb.w, h: lead * 4, text: `*${c.subtitle || c.title}*`, style: plain({ fontFamily: family, fontSize: 13, leading: lead * 1.5, align: symmetric ? 'center' : 'left' }) }));
    if (!symmetric) {
      const heads = ['Word space', 'Leading', 'The margin', 'Even colour'];
      [2, 3, 4, 5].forEach((pi, i) => {
        const side = sideOf(spec, pi);
        const b = textBlock(spec, side);
        const mc = margin(side);
        pages[pi].elements.push(makeText({ name: 'Marginal heading', x: mc.x, y: b.y + (i === 0 ? lead * 6 : lead * (3 + (i % 3) * 7)), w: Math.max(36, mc.w), h: lead * 2, text: `*${heads[i]}*`, style: note({ align: mc.align, fontSize: 8, color: '#1b1813' }) }));
      });
      // A picture across the block with its caption in the margin.
      const b4 = textBlock(spec, sideOf(spec, 4));
      const mc4 = margin(sideOf(spec, 4));
      const picH = Math.round((b4.w * 0.62) / lead) * lead;
      pages[4].elements.push(makeImage({ name: 'Picture', x: b4.x, y: b4.y + b4.h - picH, w: b4.w, h: picH, placeholder: true }));
      frames[2].h = b4.h - picH - lead;
      pages[4].elements.push(makeText({ name: 'Caption', x: mc4.x, y: b4.y + b4.h - picH, w: Math.max(36, mc4.w), h: lead * 4, text: '*Fig. 2* The caption sits beside the picture, on the line of its top edge.', style: note({ align: mc4.align }) }));
    }
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const cover: Element[] = [
      makeText({ name: 'Cover author', anchor: 'front', x: mm(14), y: calc.coverH * 0.18, w: front.w - mm(28), h: 20, text: c.author, style: plain({ fontFamily: family, fontSize: 11, align: symmetric ? 'center' : 'left' }) }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(14), y: calc.coverH * 0.18 + 22, w: front.w - mm(28), h: 60, text: `**${c.title}**`, style: plain({ fontFamily: family, fontSize: 18, leading: 22, align: symmetric ? 'center' : 'left', color: '#8a3b12' }) }),
    ];
    const layout = symmetric ? 'symmetric axis' : blockToForeEdge ? 'block at the fore-edge, notes inside' : 'block at the spine, notes outside';
    return { name: 'Detail in Typography', book: spec, pages, masters: [m], cover, focusSpread: 2, caption: `${fw}×${fh} · ${layout} · ${justified ? 'justified' : 'ragged right'}` };
  },
};

export const hochuliTypotron: PresetFamily = {
  id: 'hochuli-typotron', name: 'Typotron', designer: 'Jost Hochuli', era: 'Typotron booklets, St. Gallen 1983–98', accent: '#2c56a6',
  description: 'Small, playful booklets on coloured stock: titles stepped across the page, a large italic numeral, two type sizes in dialogue, accent colour used sparingly — freedom resting on exact micro-typography.',
  rationale: [
    'Play is allowed precisely because the details are exact: the spacing of the small text never changes.',
    'A large italic numeral and stepped title lines give each booklet its own voice within a series.',
    'One accent colour on a tinted stock is enough; it marks entry points, never decoration.',
  ],
  generate(c, variant) {
    const accents = ['#d26a1e', '#2c56a6', '#3c8a4a', '#c0362c', '#7a3f98', '#0a7f8c', '#b8860b', '#1b1813'];
    const papers = ['#f6f0e2', '#eef1f4', '#f3efe6', '#fbf7ee', '#f1ece4', '#eaf2f0', '#f7f2e3', '#f4f1ea'];
    const accent = accents[variant % 8];
    const display = variant % 2 ? 'fraunces' : 'eb-garamond';
    const sans = variant % 3 === 2 ? 'space-grotesk' : 'inter';
    const lead = 12;
    const spec = specWith((s) => {
      s.trimW = mm(148); s.trimH = mm(210);
      s.margins = { inner: mm(14), outer: mm(18), top: mm(14), bottom: mm(22) };
      s.grid = { ...s.grid, columns: 2, rows: 1, gutter: mm(5), baseline: lead, baselineOffset: lead, showGrid: false };
      s.title = c.title; s.author = c.author;
      s.binding.type = 'perfect'; s.cover.finish = 'paper'; s.cover.material = accent; s.paper.color = papers[variant % 8];
      s.plannedPages = 48;
    });
    const pages = blankPages(5, spec.paper.color);
    const rb = textBlock(spec, 'right'), lb = textBlock(spec, 'left');
    const issue = String(3 + variant * 2);
    // Title spread: a large italic numeral on the verso, stepped title on the recto.
    pages[1].elements.push(
      makeText({ name: 'Issue numeral', x: lb.x - mm(4), y: lb.y + lb.h * 0.1, w: lb.w + mm(8), h: lb.h * 0.6, text: `*${issue}*`, style: plain({ fontFamily: display, fontSize: 190, leading: 180, color: accent, align: variant % 2 ? 'left' : 'right', features: { lnum: true } }) }),
      makeText({ name: 'Series', x: lb.x, y: lb.y + lb.h - lead * 3, w: lb.w, h: lead * 3, text: `Typotron · Heft ${issue}\nSt. Gallen`, style: plain({ fontFamily: sans, fontSize: 7.5, leading: lead }) }),
    );
    const words = c.title.split(' ');
    const lines: string[] = [];
    for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2).join(' '));
    lines.forEach((line, i) => {
      const step = (i % 3) * mm(9);
      pages[2].elements.push(makeText({ name: `Title line ${i + 1}`, x: rb.x + step, y: rb.y + lead * 4 + i * lead * 2.5, w: rb.w - step, h: lead * 3, text: i === 0 ? `*${line}*` : line, style: plain({ fontFamily: display, fontSize: 21, leading: lead * 2.5, color: i === lines.length - 1 ? accent : '#1b1813' }) }));
    });
    pages[2].elements.push(
      makeRule({ name: 'Accent rule', x: rb.x, y: rb.y + lead * 4 + lines.length * lead * 2.5 + lead, w: mm(18), h: 6, stroke: accent, strokeWidth: 2 }),
      makeText({ name: 'Author', x: rb.x, y: rb.y + lead * 6 + lines.length * lead * 2.5, w: rb.w, h: lead * 2, text: c.author, style: plain({ fontFamily: sans, fontSize: 8, leading: lead }) }),
    );
    // Text spread: two sizes in dialogue — a large lead paragraph and small two-column text.
    const lead1 = makeText({ name: 'Lead paragraph', x: lb.x, y: lb.y, w: lb.w, h: lead * 10, text: `*${firstParagraphs(c.body, 1)}*`, style: textStyle({ fontFamily: display, fontSize: 12.5, leading: lead * 1.5, align: 'left', firstLineIndent: 0, hyphenate: true, baselineGrid: false }) });
    pages[3].elements.push(lead1);
    const colW = (lb.w - mm(5)) / 2;
    const small = textStyle({ fontFamily: sans, fontSize: 7.5, leading: lead, align: 'left', firstLineIndent: 0, paragraphSpacing: lead, hyphenate: true });
    const cols = [
      makeText({ name: 'Text 1', x: lb.x, y: lb.y + lead * 12, w: colW, h: lb.h - lead * 12, style: small }),
      makeText({ name: 'Text 2', x: lb.x + colW + mm(5), y: lb.y + lead * 12, w: colW, h: lb.h - lead * 12, style: textStyle(small) }),
      makeText({ name: 'Text 3', x: rb.x, y: rb.y, w: colW, h: rb.h, style: textStyle(small) }),
      makeText({ name: 'Text 4', x: rb.x + colW + mm(5), y: rb.y + lead * 8, w: colW, h: rb.h - lead * 8, style: textStyle(small) }),
    ];
    cols[0].text = c.body.split('\n').slice(1).join('\n');
    chain(cols);
    pages[3].elements.push(cols[0], cols[1]);
    pages[4].elements.push(cols[2], cols[3]);
    pages[4].elements.push(
      makeText({ name: 'Side note', x: rb.x + colW + mm(5), y: rb.y, w: colW, h: lead * 7, text: `*Note* — ${firstParagraphs(c.body, 1).split('. ')[0]}.`, style: plain({ fontFamily: display, fontSize: 9, leading: lead, color: accent }) }),
      makeText({ name: 'Folio', x: rb.x, y: rb.y + rb.h + lead, w: rb.w, h: 12, text: '{page}', style: plain({ fontFamily: sans, fontSize: 7.5, align: 'right', color: accent }) }),
    );
    const calc = computeBinding(spec);
    const front = calc.panels.find((p) => p.id === 'front')!;
    const H = calc.coverH;
    const cover: Element[] = [
      makeShape({ name: 'Paper band', anchor: 'front', x: 0, y: H * 0.58, w: front.w, h: H * 0.42, fill: '#f6f0e2', stroke: null }),
      makeText({ name: 'Cover numeral', anchor: 'front', x: mm(8), y: mm(6), w: front.w - mm(16), h: H * 0.55, text: `*${issue}*`, style: plain({ fontFamily: display, fontSize: 150, leading: 150, color: '#f6f0e2', align: 'right', features: { lnum: true } }) }),
      makeText({ name: 'Cover title', anchor: 'front', x: mm(12), y: H * 0.62, w: front.w - mm(24), h: H * 0.25, text: `*${c.title}*`, style: plain({ fontFamily: display, fontSize: 15, leading: 18, color: '#1b1813' }) }),
      makeText({ name: 'Cover series', anchor: 'front', x: mm(12), y: H - mm(16), w: front.w - mm(24), h: 12, text: `Typotron ${issue}`, style: plain({ fontFamily: sans, fontSize: 7.5, color: accent }) }),
    ];
    return { name: 'Typotron', book: spec, pages, masters: [], cover, focusSpread: 1, caption: `Heft ${issue} · ${display === 'fraunces' ? 'Fraunces' : 'EB Garamond'} + ${sans === 'inter' ? 'Inter' : 'Space Grotesk'} · accent ${accent}` };
  },
};
