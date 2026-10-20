/**
 * Rasterise the cover, finish masks and interior pages for the 3D book (canvas back-end, so
 * text is drawn from the same glyph outlines as the PDF).
 */
import type { Element, Finish, Project } from '../model/types';
import type { BindingCalc, JacketCalc } from '../engine/binding';
import type { BookTextures, FinishKey, PageInfo, PanelArt, TextureDemand } from '../three';
import { compileCover, compileJacket, compilePage, elementMatrix } from './compile';
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

export interface TextureOptions { coverMaxPx?: number; pageMaxPx?: number; pageLimit?: number; signal?: { cancelled: boolean }; jacket?: JacketCalc | null }

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
  // Dust jacket art + finish masks, same conventions as the cover (origin at −bleed, −bleed).
  let jacket: HTMLCanvasElement | null = null;
  let jacketPxPerPt = 1;
  const jacketFinishMasks: BookTextures['finishMasks'] = {};
  if (o.jacket) {
    const jc = o.jacket;
    const box = { x: -jc.bleed, y: -jc.bleed, w: jc.width + 2 * jc.bleed, h: jc.height + 2 * jc.bleed };
    jacketPxPerPt = Math.min(4, (o.coverMaxPx ?? 2400) / box.w);
    const prims = compileJacket(project, jc);
    await preloadImages(prims);
    if (o.signal?.cancelled) return null;
    jacket = renderToCanvas(prims, box, jacketPxPerPt, { hideDieLines: true });
    const usedJ = new Set((project.jacket?.elements ?? []).map((e) => e.finish).filter((f): f is Finish => !!f && f !== 'none'));
    for (const f of FINISHES) {
      if (!usedJ.has(f)) continue;
      jacketFinishMasks[f] = toMask(renderToCanvas(compileJacket(project, jc, { background: null, finishFilter: (el: Element) => el.finish === f }), box, jacketPxPerPt, { hideDieLines: true }));
    }
  }
  return { cover, coverPxPerPt, finishMasks, pages, pagePxPerPt, jacket, jacketPxPerPt, jacketFinishMasks };
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

/* -------------------------------------------------------------------------- */
/* Camera-driven sharpening                                                     */
/* -------------------------------------------------------------------------- */

export type TextureQuality = 'standard' | 'high' | 'ultra';

/**
 * Per quality: longest edge (px) of a sharpened page and of the front-panel art, and the pixel
 * budgets for all sharpened pages / one panel together (GPU memory ≈ 5.3 bytes per pixel).
 */
const CAPS: Record<TextureQuality, { page: number; panel: number; pages: number; panel2: number }> = {
  standard: { page: 2048, panel: 4096, pages: 20e6, panel2: 12e6 },
  high: { page: 4096, panel: 8192, pages: 44e6, panel2: 40e6 },
  ultra: { page: 6144, panel: 16384, pages: 96e6, panel2: 96e6 },
};
/** Texture pixels per screen pixel asked for (a little over 1 so mipmaps never blur type). */
const OVERSAMPLE = 1.2;
/** Seconds a sharpened surface lingers after leaving the view before it is dropped. */
const LINGER = 8;

/** Up to the next step of √2 (fewer re-renders as the camera moves). */
const quantize = (ppp: number) => Math.pow(2, Math.ceil(Math.log2(Math.max(1e-3, ppp)) * 2) / 2);

/** Page `index` rasterised at `pxPerPt`. */
export async function renderPageArt(project: Project, index: number, pxPerPt: number): Promise<HTMLCanvasElement> {
  const W = project.book.trimW, H = project.book.trimH;
  const prims = compilePage(project, index, { dieLines: false });
  await preloadImages(prims);
  return renderToCanvas(prims, { x: 0, y: 0, w: W, h: H }, pxPerPt, { hideDieLines: true });
}

/** Front panel of the cover (or jacket) rasterised at `pxPerPt`, with its finish masks. */
export async function renderPanelArt(project: Project, calc: BindingCalc, jacket: JacketCalc | null, which: 'cover' | 'jacket', pxPerPt: number): Promise<PanelArt | null> {
  const m = 2; // pt of the neighbouring panels, so filtering at the panel's edges stays clean
  if (which === 'cover') {
    const P = calc.panels.find((p) => p.id === 'front');
    if (!P) return null;
    const x0 = Math.max(-calc.wrap, P.x - m), x1 = Math.min(calc.coverW + calc.wrap, P.x + P.w + m);
    const box = { x: x0, y: -m, w: x1 - x0, h: calc.coverH + 2 * m };
    const prims = compileCover(project, calc);
    await preloadImages(prims);
    const canvas = renderToCanvas(prims, box, pxPerPt, { hideDieLines: true });
    const masks: PanelArt['masks'] = {};
    const used = new Set(project.cover.elements.map((e) => e.finish).filter((f): f is Finish => !!f && f !== 'none'));
    for (const f of FINISHES) {
      if (!used.has(f)) continue;
      masks[f] = toMask(renderToCanvas(compileCover(project, calc, { background: null, finishFilter: (el: Element) => el.finish === f }), box, pxPerPt, { hideDieLines: true }));
    }
    return { canvas, masks, box };
  }
  if (!jacket) return null;
  const P = jacket.panels.find((p) => p.id === 'front');
  if (!P) return null;
  const x0 = Math.max(-jacket.bleed, P.x - m), x1 = Math.min(jacket.width + jacket.bleed, P.x + P.w + m);
  const box = { x: x0, y: -m, w: x1 - x0, h: jacket.height + 2 * m };
  const prims = compileJacket(project, jacket);
  await preloadImages(prims);
  const canvas = renderToCanvas(prims, box, pxPerPt, { hideDieLines: true });
  const masks: PanelArt['masks'] = {};
  const used = new Set((project.jacket?.elements ?? []).map((e) => e.finish).filter((f): f is Finish => !!f && f !== 'none'));
  for (const f of FINISHES) {
    if (!used.has(f)) continue;
    masks[f] = toMask(renderToCanvas(compileJacket(project, jacket, { background: null, finishFilter: (el: Element) => el.finish === f }), box, pxPerPt, { hideDieLines: true }));
  }
  return { canvas, masks, box };
}

/** What the refiner drives (BookScene). */
export interface RefinerTarget {
  setPageArt(index: number, canvas: HTMLCanvasElement | null): void;
  setPanelArt(which: 'cover' | 'jacket', art: PanelArt | null): void;
  readonly maxTextureSize: number;
}

interface Job { kind: 'page' | 'cover' | 'jacket'; index: number; ppp: number; need: number }

/**
 * Keeps the book's art as sharp as the view needs: pages in view, the front cover and the
 * jacket's front panel are re-rasterised at the density the camera asks for (one surface at a
 * time, between frames), and dropped back to the base art when they leave the view. Before a
 * still or a video, `prepare` sharpens everything the export will show at its full size.
 */
export class TextureRefiner {
  quality: TextureQuality = 'high';
  /** While true, live updates neither sharpen nor drop anything (an export is running). */
  hold = false;
  private project: Project | null = null;
  private calc: BindingCalc | null = null;
  private jacket: JacketCalc | null = null;
  private base = { page: 0, cover: 0, jacket: 0 };
  private applied = new Map<string, { ppp: number; seen: number }>();
  private gen = 0;
  private running = false;
  private next: { demand: TextureDemand; capped: boolean } | null = null;

  constructor(private readonly target: RefinerTarget) {}

  /** New content (or a rebuilt scene): forget every sharpened surface. */
  reset(project: Project | null, calc: BindingCalc | null, jacket: JacketCalc | null, base: BookTextures | null): void {
    this.gen++;
    for (const key of this.applied.keys()) this.drop(key);
    this.applied.clear();
    this.project = project;
    this.calc = calc;
    this.jacket = jacket;
    this.base = { page: base?.pagePxPerPt ?? 0, cover: base?.coverPxPerPt ?? 0, jacket: base?.jacketPxPerPt ?? 0 };
    this.next = null;
  }

  /** Live view: sharpen what is in view, in the background. `capped`: keep it light (animating). */
  update(demand: TextureDemand, capped = false): void {
    // Nothing to sharpen until the base art is in (it resets everything when it arrives).
    if (this.hold || !this.project || this.base.page <= 0) return;
    this.next = { demand, capped };
    if (!this.running) void this.loop();
  }

  /** Sharpen everything `demand` needs, now (before a still or a video export). */
  async prepare(demand: TextureDemand): Promise<void> {
    const gen = this.gen;
    for (const job of this.plan(demand, false)) {
      if (gen !== this.gen) return;
      await this.run(job);
    }
  }

  dispose(): void {
    this.reset(null, null, null, null);
  }

  private drop(key: string): void {
    const [kind, idx] = key.split(':');
    if (kind === 'page') this.target.setPageArt(Number(idx), null);
    else this.target.setPanelArt(kind as 'cover' | 'jacket', null);
  }

  /** Jobs for a demand, most needed first, within the quality's caps and memory budgets. */
  private plan(d: TextureDemand, capped: boolean): Job[] {
    const p = this.project, calc = this.calc;
    if (!p || !calc) return [];
    const caps = CAPS[capped ? 'standard' : this.quality];
    const maxTex = this.target.maxTextureSize || 8192;
    const W = p.book.trimW, H = p.book.trimH;
    const jobs: Job[] = [];
    // Pages: cap the edge, then scale everything down together if over the pixel budget.
    const pageCap = Math.min(caps.page, maxTex) / Math.max(W, H);
    let pages = d.pages.filter((q) => q.index < p.pages.length).map((q) => ({ index: q.index, want: Math.min(pageCap, q.pxPerPt * OVERSAMPLE) }));
    const area = pages.reduce((sum, q) => sum + W * H * q.want * q.want, 0);
    if (area > caps.pages) {
      const k = Math.sqrt(caps.pages / area);
      pages = pages.map((q) => ({ ...q, want: q.want * k }));
    }
    for (const q of pages) {
      const ppp = Math.min(pageCap, quantize(q.want));
      if (ppp > this.base.page * 1.3) jobs.push({ kind: 'page', index: q.index, ppp, need: q.want / Math.max(1e-6, this.base.page) });
    }
    const panel = (kind: 'cover' | 'jacket', need: number, w: number, h: number, base: number) => {
      if (need <= 0) return;
      let want = Math.min(Math.min(caps.panel, maxTex) / Math.max(w, h), need * OVERSAMPLE);
      if (w * h * want * want > caps.panel2) want = Math.sqrt(caps.panel2 / (w * h));
      const ppp = Math.min(Math.min(caps.panel, maxTex) / Math.max(w, h), quantize(want));
      if (ppp > base * 1.3) jobs.push({ kind, index: 0, ppp, need: want / Math.max(1e-6, base) });
    };
    const front = calc.panels.find((q) => q.id === 'front');
    if (front) panel('cover', d.coverFront, front.w, calc.coverH, this.base.cover);
    const jf = this.jacket?.panels.find((q) => q.id === 'front');
    if (jf && this.jacket) panel('jacket', d.jacketFront, jf.w, this.jacket.height, this.base.jacket);
    return jobs.sort((a, b) => b.need - a.need);
  }

  private async run(job: Job): Promise<void> {
    const key = job.kind === 'page' ? `page:${job.index}` : `${job.kind}:0`;
    const have = this.applied.get(key);
    const now = performance.now() / 1000;
    if (have && have.ppp >= job.ppp * 0.99) {
      have.seen = now;
      return;
    }
    const p = this.project, calc = this.calc, gen = this.gen;
    if (!p || !calc) return;
    if (job.kind === 'page') {
      const canvas = await renderPageArt(p, job.index, job.ppp);
      if (gen !== this.gen) return;
      this.target.setPageArt(job.index, canvas);
    } else {
      const art = await renderPanelArt(p, calc, this.jacket, job.kind, job.ppp);
      if (gen !== this.gen || !art) return;
      this.target.setPanelArt(job.kind, art);
    }
    this.applied.set(key, { ppp: job.ppp, seen: now });
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (this.next && !this.hold) {
        const { demand, capped } = this.next;
        this.next = null;
        const jobs = this.plan(demand, capped);
        const now = performance.now() / 1000;
        const wanted = new Set(jobs.map((j) => (j.kind === 'page' ? `page:${j.index}` : `${j.kind}:0`)));
        for (const [key, a] of this.applied) {
          if (wanted.has(key)) a.seen = now;
          else if (now - a.seen > LINGER) {
            this.drop(key);
            this.applied.delete(key);
          }
        }
        // One surface per turn, then yield so frames keep flowing; a newer demand re-plans.
        for (const job of jobs) {
          if (this.next || this.hold) break;
          await this.run(job);
          await new Promise((r) => setTimeout(r, 16));
        }
      }
    } finally {
      this.running = false;
    }
  }
}
