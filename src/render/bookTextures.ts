/**
 * Rasterise the cover, finish masks and interior pages for the 3D book (canvas back-end, so
 * text is drawn from the same glyph outlines as the PDF).
 */
import type { Element, Finish, Project } from '../model/types';
import type { BindingCalc } from '../engine/binding';
import type { BookTextures, FinishKey, PageInfo } from '../three';
import { compileCover, compilePage, elementMatrix } from './compile';
import { renderToCanvas, preloadImages } from './canvasBackend';
import { applyMatrix } from './primitives';

const FINISHES: FinishKey[] = ['gold-foil', 'silver-foil', 'copper-foil', 'holo-foil', 'blind-deboss', 'spot-gloss'];

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function toMask(c: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

export interface TextureOptions { coverMaxPx?: number; pageMaxPx?: number; pageLimit?: number; signal?: { cancelled: boolean } }

export async function buildBookTextures(project: Project, calc: BindingCalc, o: TextureOptions = {}): Promise<BookTextures | null> {
  const wrap = calc.wrap;
  const coverBox = { x: -wrap, y: -wrap, w: calc.coverW + 2 * wrap, h: calc.coverH + 2 * wrap };
  const coverPxPerPt = Math.min(4, (o.coverMaxPx ?? 2400) / coverBox.w);
  const coverPrims = compileCover(project, calc);
  await preloadImages(coverPrims);
  if (o.signal?.cancelled) return null;
  const cover = renderToCanvas(coverPrims, coverBox, coverPxPerPt, { hideDieLines: true });

  const finishMasks: BookTextures['finishMasks'] = {};
  const used = new Set(project.cover.elements.map((e) => e.finish).filter((f): f is Finish => !!f && f !== 'none'));
  for (const f of FINISHES) {
    if (!used.has(f)) continue;
    const prims = compileCover(project, calc, { background: null, finishFilter: (el: Element) => el.finish === f });
    finishMasks[f] = toMask(renderToCanvas(prims, coverBox, coverPxPerPt, { hideDieLines: true }));
  }

  const W = project.book.trimW, H = project.book.trimH;
  const pagePxPerPt = Math.min(3, (o.pageMaxPx ?? 1100) / Math.max(W, H));
  const limit = Math.min(project.pages.length, o.pageLimit ?? 26);
  const pages: (HTMLCanvasElement | null)[] = [];
  for (let i = 0; i < limit; i++) {
    if (o.signal?.cancelled) return null;
    const prims = compilePage(project, i, { dieLines: false });
    await preloadImages(prims);
    pages.push(renderToCanvas(prims, { x: 0, y: 0, w: W, h: H }, pagePxPerPt, { hideDieLines: true }));
    if (i % 3 === 2) await tick();
  }
  return { cover, coverPxPerPt, finishMasks, pages, pagePxPerPt };
}

/** Per-page material + die-cut windows (both faces of a leaf share its holes). */
export function pageInfos(project: Project): PageInfo[] {
  const W = project.book.trimW;
  const holes = (i: number, mirror: boolean) => (project.pages[i]?.elements ?? []).filter((e) => e.type === 'cutout' && !e.hidden).map((e) => {
    const m = elementMatrix(e);
    const pts = [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]].map(([x, y]) => applyMatrix(m, x, y));
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
    const shape: 'rect' | 'ellipse' = e.type === 'cutout' && e.shape === 'ellipse' ? 'ellipse' : 'rect';
    return { x: mirror ? W - x1 : x0, y: y0, w: x1 - x0, h: y1 - y0, shape };
  });
  return project.pages.map((p, i) => {
    const partner = i % 2 === 0 ? i + 1 : i - 1;
    return {
      material: p.material,
      paperColor: p.paperColor,
      vellumOpacity: p.vellumOpacity,
      cutouts: [...holes(i, false), ...holes(partner, true)],
    };
  });
}
