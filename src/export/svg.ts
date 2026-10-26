/**
 * SVG and PNG export of pages, spreads, the flat cover or a single element.
 * Text is converted to outlines by default so files render identically anywhere.
 */
import type { Project } from '../model/types';
import { compilePage, compileCover, compileJacket, placedElement, contextForElement } from '../render/compile';
import { primsToSvg } from '../render/svgString';
import { renderToCanvas, preloadImages } from '../render/canvasBackend';
import { spreadsOf, findElement } from '../model/surfaces';
import { computeBinding, computeJacket } from '../engine/binding';
import type { Prim } from '../render/primitives';

export interface SvgExportOptions {
  target: 'spread' | 'page' | 'cover' | 'jacket' | 'selection';
  spreadIndex: number;
  pageIndex: number;
  selectionId?: string;
  outlineText: boolean;
  includeBleed: boolean;
  rasterScale: number;
}

interface Built { prims: Prim[]; box: { x: number; y: number; w: number; h: number }; name: string }

function build(project: Project, o: SvgExportOptions): Built {
  const b = project.book;
  const bleed = o.includeBleed ? b.bleed : 0;
  if (o.target === 'cover') {
    const calc = computeBinding(b);
    const wrap = o.includeBleed ? calc.wrap : 0;
    return { prims: compileCover(project, calc), box: { x: -wrap, y: -wrap, w: calc.coverW + 2 * wrap, h: calc.coverH + 2 * wrap }, name: 'cover' };
  }
  if (o.target === 'jacket') {
    if (!b.jacket?.enabled) throw new Error('this book has no dust jacket yet. Add one in the Jacket view.');
    const jc = computeJacket(b);
    const bl = o.includeBleed ? jc.bleed : 0;
    return { prims: compileJacket(project, jc), box: { x: -bl, y: -bl, w: jc.width + 2 * bl, h: jc.height + 2 * bl }, name: 'jacket' };
  }
  if (o.target === 'selection' && o.selectionId) {
    const loc = findElement(project, o.selectionId);
    const ctx = contextForElement(project, o.selectionId, null);
    if (loc && ctx) {
      const el = { ...loc.el, x: 0, y: 0, rotation: 0 };
      return { prims: [placedElement(el, ctx)], box: { x: 0, y: 0, w: el.w, h: el.h }, name: el.name.toLowerCase().replace(/\s+/g, '-') };
    }
  }
  // Nothing selected (or it was deleted): not the spread under another name.
  if (o.target === 'selection') throw new Error('select an item first.');
  if (o.target === 'page') {
    return { prims: compilePage(project, o.pageIndex, { dieLines: true }), box: { x: -bleed, y: -bleed, w: b.trimW + 2 * bleed, h: b.trimH + 2 * bleed }, name: `page-${o.pageIndex + 1}` };
  }
  const sp = spreadsOf(project)[o.spreadIndex] ?? spreadsOf(project)[0];
  const prims: Prim[] = [];
  const slots = b.facing ? [sp.left, sp.right] : [sp.right];
  slots.forEach((pi, k) => {
    if (pi == null) return;
    // Each page keeps its outer bleed only, so the halves of a spread item meet at the gutter.
    const x0 = k === 0 ? -bleed : 0, x1 = k === slots.length - 1 ? b.trimW + bleed : b.trimW;
    prims.push({ t: 'group', matrix: [1, 0, 0, 1, k * b.trimW, 0], clip: `M${x0} ${-bleed}H${x1}V${b.trimH + bleed}H${x0}Z`, children: compilePage(project, pi, { dieLines: true }) });
  });
  const nums = slots.filter((x): x is number => x != null).map((x) => x + 1).join('-');
  return { prims, box: { x: -bleed, y: -bleed, w: b.trimW * slots.length + 2 * bleed, h: b.trimH + 2 * bleed }, name: `spread-${nums}` };
}

export async function exportSvg(project: Project, o: SvgExportOptions): Promise<{ blob: Blob; name: string }> {
  const { prims, box, name } = build(project, o);
  await preloadImages(prims);
  const body = primsToSvg(prims, { pxPerPt: o.rasterScale, idPrefix: 'bds', outlineText: o.outlineText, hidePlaceholders: true });
  const pt = (v: number) => +v.toFixed(3);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${pt(box.w)}pt" height="${pt(box.h)}pt" viewBox="${pt(box.x)} ${pt(box.y)} ${pt(box.w)} ${pt(box.h)}">
<title>${escapeXml(project.book.title)} — ${name}</title>
<desc>Exported from Book Design Studio. 1 user unit = 1 pt.</desc>
${body}
</svg>`;
  return { blob: new Blob([svg], { type: 'image/svg+xml' }), name: `${name}.svg` };
}

export async function exportPng(project: Project, o: SvgExportOptions & { dpi: number }): Promise<{ blob: Blob; name: string }> {
  const { prims, box, name } = build(project, o);
  await preloadImages(prims);
  const ppp = Math.min(o.dpi / 72, 12000 / Math.max(box.w, box.h));
  const canvas = renderToCanvas(prims, box, ppp, { hideDieLines: true, background: '#ffffff' });
  // A canvas the browser could not allocate gives no blob: say so rather than fail on null.
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error(`a ${canvas.width} × ${canvas.height} px image is more than this browser can make. Choose a lower resolution.`))), 'image/png'));
  return { blob, name: `${name}.png` };
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
