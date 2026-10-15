import type { Element } from '../model/types';
import { useStore } from '../store/store';
import { computeBinding, computeJacket, DEFAULT_JACKET } from '../engine/binding';
import { makeText, makeRule, textStyle, VERMILION } from '../model/factory';
import { mm } from '../model/units';
import { firstParagraphs } from '../engine/presets/helpers';

const plain = (o: Parameters<typeof textStyle>[0] = {}) => textStyle({ baselineGrid: false, hyphenate: false, firstLineIndent: 0, ...o });

/** Starter jacket typography: front, spine, back blurb and both flaps, anchored to their panels. */
export function starterJacket(): Element[] {
  const p = useStore.getState().project;
  const spec = { ...p.book, jacket: { ...DEFAULT_JACKET, ...(p.book.jacket ?? {}), enabled: true } };
  const jc = computeJacket(spec, computeBinding(spec));
  const H = jc.height;
  const m = mm(12);
  // The longest story is the book's text; use its opening as the blurb.
  const body = p.pages.flatMap((pg) => pg.elements).reduce<Element | null>((best, e) => (e.type === 'text' && e.text.length > ((best && best.type === 'text') ? best.text.length : 300) ? e : best), null);
  const blurb = body && body.type === 'text' ? firstParagraphs(body.text, 1) : 'A book about the proportion of the page, the colour of type and the craft of binding.';
  const front = jc.panels.find((x) => x.id === 'front')!;
  const spine = jc.panels.find((x) => x.id === 'spine')!;
  const back = jc.panels.find((x) => x.id === 'back')!;
  const fflap = jc.panels.find((x) => x.id === 'front-flap')!;
  const bflap = jc.panels.find((x) => x.id === 'back-flap')!;
  const len = H * 0.62, thick = Math.max(10, spine.w * 0.7);
  const els: Element[] = [
    makeText({ name: 'Jacket title', anchor: 'front', x: m, y: H * 0.26, w: front.w - 2 * m, h: 90, text: spec.title.toUpperCase(), style: plain({ fontFamily: 'cinzel', fontSize: 20, leading: 26, align: 'center', tracking: 70 }) }),
    makeRule({ name: 'Rule', anchor: 'front', x: front.w / 2 - 20, y: H * 0.26 + 96, w: 40, h: 8, kind: 'scotch', stroke: VERMILION, strokeWidth: 1 }),
    makeText({ name: 'Jacket author', anchor: 'front', x: m, y: H * 0.26 + 116, w: front.w - 2 * m, h: 22, text: `^${spec.author}^`, style: plain({ fontSize: 12, align: 'center', tracking: 80 }) }),
    makeText({ name: 'Jacket imprint', anchor: 'front', x: m, y: H - m * 2.2, w: front.w - 2 * m, h: 16, text: `^${spec.publisher}^`, style: plain({ fontSize: 8.5, align: 'center', tracking: 80 }) }),
    makeText({ name: 'Spine title', anchor: 'spine', x: spine.w / 2 - len / 2, y: H * 0.42 - thick / 2, w: len, h: thick, rotation: 90, verticalAlign: 'middle', text: spec.title.toUpperCase(), style: plain({ fontFamily: 'cinzel', fontSize: Math.min(10, thick * 0.55), leading: Math.min(12, thick * 0.7), align: 'center', tracking: 60 }) }),
    makeText({ name: 'Back blurb', anchor: 'back', x: m * 1.5, y: H * 0.18, w: back.w - 3 * m, h: H * 0.45, text: `*${blurb}*`, style: textStyle({ fontSize: 10.5, leading: 14, align: 'left', hyphenate: true, baselineGrid: false, firstLineIndent: 0 }) }),
    makeText({ name: 'Front flap copy', anchor: 'front-flap', x: m * 0.8, y: m * 1.5, w: fflap.w - m * 1.6, h: H * 0.7, text: `^${spec.title}^\n${blurb}`, style: textStyle({ fontSize: 8.5, leading: 12, align: 'left', hyphenate: true, baselineGrid: false, firstLineIndent: 0, paragraphSpacing: 6 }) }),
    makeText({ name: 'Back flap copy', anchor: 'back-flap', x: m * 0.8, y: m * 1.5, w: bflap.w - m * 1.6, h: H * 0.5, text: `^${spec.author}^\nWrites and designs books on proportion, type and binding.\n\n*Jacket design: Book Design Studio*`, style: textStyle({ fontSize: 8.5, leading: 12, align: 'left', hyphenate: true, baselineGrid: false, firstLineIndent: 0, paragraphSpacing: 6 }) }),
  ];
  return els;
}

/** Turn the dust jacket on (optionally with starter typography) and show it. */
export function enableJacket(withStarter: boolean) {
  const s = useStore.getState();
  s.update((d) => {
    d.book.jacket = { ...DEFAULT_JACKET, ...(d.book.jacket ?? {}), enabled: true };
    if (!d.jacket) d.jacket = { elements: [] };
  });
  if (withStarter && !(useStore.getState().project.jacket?.elements.length)) {
    const els = starterJacket();
    s.update((d) => { if (!d.jacket) d.jacket = { elements: [] }; d.jacket.elements.push(...(els as typeof d.jacket.elements)); }, { history: false });
  }
  s.setView('jacket');
  s.requestFit();
}
