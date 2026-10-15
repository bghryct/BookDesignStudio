/**
 * Sample strokes for the brush UI, rendered by the real brush engine: medium
 * tiles (cached as data URLs per type / colour / size bucket, rendered a few
 * per frame so opening the panel never stalls) and the live preview strip.
 */
import { useEffect, useState } from 'react';
import type { BrushStroke, BrushType } from '../../model/types';
import { getBrush, renderStroke, strokeBounds, type BrushParams } from '../../engine/brushes';

/** Paper tooth used for previews (matches a fresh drawing). */
const PREVIEW_GRAIN = 0.5;
/** Ink band the eraser preview lifts paint from. */
const ERASER_GROUND = '#3a3640';

export const devicePixelRatioCapped = () => Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

/** Distance paint reaches from the centre line for these settings, pt. */
export function reachOf(type: BrushType, params: BrushParams): number {
  const b = strokeBounds({ id: 'r', brush: type, color: '#000', seed: 1, points: [0, 0, 1], ...params });
  return b.w / 2;
}

/** A sideways S across w × h pt with a pressure swell (or constant pressure). */
export function sCurve(w: number, h: number, padX: number, amp: number, n: number, pressure: boolean): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(
      padX + t * (w - 2 * padX),
      h / 2 - Math.sin(t * Math.PI * 2) * amp,
      pressure ? 0.18 + 0.82 * Math.pow(Math.sin(t * Math.PI), 0.75) : 0.6,
    );
  }
  return pts;
}

/**
 * Renders one sample stroke onto `cv` sized cssW × cssH CSS px. The view is
 * scaled by `k` (1 pt = k CSS px) so oversized brushes still fit; the canvas
 * stays transparent so a CSS paper background shows through (and through the
 * eraser).
 */
export function drawSample(
  cv: HTMLCanvasElement, type: BrushType, params: BrushParams, color: string,
  cssW: number, cssH: number, opts: { k?: number; pressure?: boolean; points?: number } = {},
): void {
  const dpr = devicePixelRatioCapped();
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const k = opts.k ?? 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
  const wPt = cssW / k, hPt = cssH / k;
  const reach = reachOf(type, params);
  if (type === 'eraser') {
    ctx.fillStyle = ERASER_GROUND;
    ctx.fillRect(0, hPt * 0.18, wPt, hPt * 0.64);
  }
  const amp = Math.max(0, (hPt / 2 - reach - 1) * 0.85);
  const stroke: BrushStroke = {
    id: 'sample', brush: type, color, seed: 7, ...params,
    points: sCurve(wPt, hPt, Math.min(reach + 2, wPt * 0.2), amp, opts.points ?? 80, opts.pressure ?? true),
  };
  renderStroke(ctx, stroke, { pxPerPt: dpr * k, paperGrain: PREVIEW_GRAIN });
}

/* -------------------------------------------------------------------------- */
/* Medium tiles                                                                */
/* -------------------------------------------------------------------------- */

/** Brush size used on a medium's tile: its natural size, kept legible and inside the tile. */
export const tileSize = (type: BrushType) => Math.max(1.2, Math.min(12, getBrush(type).defaults.size));

const tileCache = new Map<string, string>();
const TILE_CACHE_MAX = 240;
interface Job { run: () => string; cbs: Set<(url: string) => void> }
const queue = new Map<string, Job>();
let raf = 0;
let scratch: HTMLCanvasElement | null = null;

function remember(key: string, url: string) {
  tileCache.set(key, url);
  if (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value;
    if (oldest !== undefined) tileCache.delete(oldest);
  }
}

/** Renders queued tiles with a ~10 ms budget per animation frame. */
function pump() {
  raf = 0;
  const t0 = performance.now();
  for (const [key, job] of queue) {
    queue.delete(key);
    let url = tileCache.get(key);
    if (url === undefined) {
      try { url = job.run(); } catch { url = ''; }
      remember(key, url);
    }
    for (const cb of job.cbs) cb(url);
    if (performance.now() - t0 > 10) break;
  }
  if (queue.size && !raf) raf = requestAnimationFrame(pump);
}

function renderTile(type: BrushType, color: string, size: number, w: number, h: number): string {
  scratch ??= document.createElement('canvas');
  const params = { ...getBrush(type).defaults, size };
  drawSample(scratch, type, params, color, w, h, { points: 60 });
  return scratch.toDataURL('image/png');
}

/**
 * Data URL of a medium's sample stroke in `color` (cached per type, colour,
 * size bucket and pixel ratio). Keeps showing the previous image while a new
 * colour renders, so tiles never flicker.
 */
export function useMediumTile(type: BrushType, color: string, w: number, h: number): string | null {
  const size = tileSize(type);
  const key = `${type}|${color.toLowerCase()}|${Math.round(size * 2) / 2}|${devicePixelRatioCapped()}|${w}x${h}`;
  const [url, setUrl] = useState<string | null>(() => tileCache.get(key) ?? null);
  useEffect(() => {
    const hit = tileCache.get(key);
    if (hit !== undefined) { setUrl(hit); return; }
    const cb = (u: string) => setUrl(u);
    let job = queue.get(key);
    if (!job) {
      job = { run: () => renderTile(type, color, size, w, h), cbs: new Set() };
      queue.set(key, job);
    }
    job.cbs.add(cb);
    if (!raf) raf = requestAnimationFrame(pump);
    const j = job;
    return () => {
      j.cbs.delete(cb);
      if (!j.cbs.size && queue.get(key) === j) queue.delete(key);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}
