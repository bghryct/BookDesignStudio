/**
 * Natural-media brush renderer (Canvas 2D).
 *
 * `renderStroke` receives a context whose transform already maps 1 unit = 1 pt
 * and paints one stored stroke. All randomness derives from `stroke.seed` and
 * pt-space hashing, and all spacing / texture scales are in pt, so a stroke
 * re-renders identically at screen, 300 dpi and video resolutions.
 */
import type { BrushStroke, BrushType } from '../../model/types';
import { renderDry } from './dry';
import { renderCalligraphy, renderFineliner, renderHighlighter, renderInk, renderMarker, renderStipple } from './pens';
import { renderEraser, renderGoldLeaf } from './special';
import { brushReach, intersect, pointBounds, releaseAllLayers, visibleRect, type Job, type Rect } from './util';
import { renderAirbrush, renderGouache, renderWatercolor } from './wet';

export { simulatePressure, stabilize } from './input';

export interface RenderOpts {
  /** Device pixels per pt of the destination (e.g. 2 on screen, 300/72 for print). */
  pxPerPt: number;
  /** Paper tooth 0–1, from DrawingElement.paperGrain. */
  paperGrain: number;
}

const RENDERERS: Record<BrushType, (job: Job) => void> = {
  pencil: (j) => renderDry(j, 'pencil'),
  graphite: (j) => renderDry(j, 'graphite'),
  charcoal: (j) => renderDry(j, 'charcoal'),
  crayon: (j) => renderDry(j, 'crayon'),
  pastel: (j) => renderDry(j, 'pastel'),
  marker: renderMarker,
  highlighter: renderHighlighter,
  fineliner: renderFineliner,
  ink: renderInk,
  calligraphy: renderCalligraphy,
  watercolor: renderWatercolor,
  gouache: renderGouache,
  airbrush: renderAirbrush,
  stipple: renderStipple,
  'gold-leaf': renderGoldLeaf,
  eraser: renderEraser,
};

/** Bounds of everything the stroke can paint, pt — brush radius plus bleed / dust / spray. */
export function strokeBounds(stroke: BrushStroke): Rect {
  const pb = pointBounds(stroke.points);
  if (!pb) return { x: 0, y: 0, w: 0, h: 0 };
  const r = brushReach(stroke);
  return { x: pb.x - r, y: pb.y - r, w: pb.w + 2 * r, h: pb.h + 2 * r };
}

export function renderStroke(ctx: CanvasRenderingContext2D, stroke: BrushStroke, opts: RenderOpts): void {
  if (!stroke || !stroke.points || stroke.points.length < 3 || !(stroke.opacity > 0)) return;
  const render = RENDERERS[stroke.brush];
  if (!render) return;
  const bounds = strokeBounds(stroke);
  if (!(bounds.w > 0 && bounds.h > 0)) return;
  // Only rasterise what can be seen; the pad keeps blur-based effects (wet
  // edges, gilding bevel) identical near the visible edge.
  const region = intersect(bounds, visibleRect(ctx), brushReach(stroke) * 0.5 + 4);
  if (region.w <= 0 || region.h <= 0) return;
  const job: Job = {
    ctx,
    stroke,
    pxPerPt: opts.pxPerPt > 0 && Number.isFinite(opts.pxPerPt) ? opts.pxPerPt : 1,
    paperGrain: Number.isFinite(opts.paperGrain) ? opts.paperGrain : 0.5,
    region,
  };
  ctx.save();
  try {
    render(job);
  } finally {
    releaseAllLayers();
    ctx.restore();
  }
}

export function renderStrokes(ctx: CanvasRenderingContext2D, strokes: BrushStroke[], opts: RenderOpts): void {
  for (const s of strokes) renderStroke(ctx, s, opts);
}
