/**
 * SVG and PNG export of pages, spreads, the flat cover or a single element.
 * Text is converted to outlines by default so files render identically anywhere.
 */
import type { Project } from '../model/types';
import { compilePage, compileCover, placedElement, contextForElement } from '../render/compile';
import { primsToSvg } from '../render/svgString';
import { renderToCanvas, preloadImages } from '../render/canvasBackend';
import { spreadsOf, findElement } from '../model/surfaces';
import { computeBinding } from '../engine/binding';
import type { Prim } from '../render/primitives';

export interface SvgExportOptions {
  target: 'spread' | 'page' | 'cover' | 'selection';
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
  if (o.target === 'selection' && o.selectionId) {
    const loc = findElement(project, o.selectionId);
    const ctx = contextForElement(project, o.selectionId, null);
    if (loc && ctx) {
      const el = { ...loc.el, x: 0, y: 0, rotation: 0 };
      return { prims: [placedElement(el, ctx)], box: { x: 0, y: 0, w: el.w, h: el.h }, name: el.name.toLowerCase().replace(/\s+/g, '-') };
    }
  }
  if (o.target === 'page') {
    return { prims: compilePage(project, o.pageIndex, { dieLines: true }), box: { x: -bleed, y: -bleed, w: b.trimW + 2 * bleed, h: b.trimH + 2 * bleed }, name: `page-${o.pageIndex + 1}` };
  }
  const sp = spreadsOf(project)[o.spreadIndex] ?? spreadsOf(project)[0];
  const prims: Prim[] = [];
  const slots = b.facing ? [sp.left, sp.right] : [sp.right];
  slots.forEach((pi, k) => {
    if (pi == null) return;
    prims.push({ t: 'group', matrix: [1, 0, 0, 1, k * b.trimW, 0], clip: `M${-bleed} ${-bleed}H${b.trimW + bleed}V${b.trimH + bleed}H${-bleed}Z`, children: compilePage(project, pi, { dieLines: true }) });
  });
  const nums = slots.filter((x): x is number => x != null).map((x) => x + 1).join('-');
  return { prims, box: { x: -bleed, y: -bleed, w: b.trimW * slots.length + 2 * bleed, h: b.trimH + 2 * bleed }, name: `spread-${nums}` };
}

export async function exportSvg(project: Project, o: SvgExportOptions): Promise<{ blob: Blob; name: string }> {
  const { prims, box, name } = build(project, o);
  await preloadImages(prims);
  const body = primsToSvg(prims, { pxPerPt: o.rasterScale, idPrefix: 'bds', outlineText: o.outlineText });
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
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  return { blob, name: `${name}.png` };
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
