/**
 * Input conditioning for live drawing: speed-derived pressure for mice and a
 * pulled-string stabiliser. Both are pure functions over flat
 * [x, y, pressure, …] arrays (pt) and return new arrays.
 */
import { clamp } from '../../lib/random';
import { smoothstep } from './util';

/**
 * Mouse input has no pressure: derive a plausible one from speed (fast =
 * lighter / thinner), with a short taper-in at the start and taper-out at the
 * end so ink and calligraphy strokes get natural entry and exit.
 * Assumes roughly uniform event timing, so distance per sample ≈ speed.
 */
export function simulatePressure(points: number[]): number[] {
  const n = Math.floor(points.length / 3);
  const out = points.slice(0, n * 3);
  if (!n) return out;
  const along = new Float64Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = i ? Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2]) : 0;
    along[i] = i ? along[i - 1] + d : 0;
    v = i <= 1 ? d : v + (d - v) * 0.3;
    out[i * 3 + 2] = clamp(1.05 - 0.7 * smoothstep(0.6, 14, v), 0.25, 1);
  }
  const total = along[n - 1];
  for (let i = 0; i < n; i++) {
    const taperIn = 0.35 + 0.65 * smoothstep(0, 7, along[i]);
    const taperOut = 0.45 + 0.55 * smoothstep(0, 5, total - along[i]);
    out[i * 3 + 2] *= Math.min(taperIn, taperOut);
  }
  return out;
}

/**
 * Lazy-brush / pulled-string stabiliser. The brush is dragged behind the
 * pointer on a string whose length grows with `amount` (0–1, up to ~20pt),
 * then lightly averaged. The final raw point is appended so the stroke ends
 * where the pen lifted.
 */
export function stabilize(points: number[], amount: number): number[] {
  const a = clamp(amount, 0, 1);
  const n = Math.floor(points.length / 3);
  if (a <= 0 || n < 3) return points.slice(0, n * 3);
  const R = a * a * 18 + a * 2;
  const follow = 1 - 0.55 * a;
  let bx = points[0], by = points[1], bp = points[2];
  let sx = bx, sy = by;
  const out: number[] = [sx, sy, bp];
  for (let i = 1; i < n; i++) {
    const px = points[i * 3], py = points[i * 3 + 1], pp = points[i * 3 + 2];
    const dx = px - bx, dy = py - by, d = Math.hypot(dx, dy);
    if (d > R) {
      const t = (d - R) / d;
      bx += dx * t;
      by += dy * t;
    }
    bp += ((Number.isFinite(pp) ? pp : 0.5) - bp) * 0.35;
    sx += (bx - sx) * follow;
    sy += (by - sy) * follow;
    const l = out.length;
    if (Math.hypot(sx - out[l - 3], sy - out[l - 2]) > 0.05) out.push(sx, sy, bp);
  }
  const lx = points[n * 3 - 3], ly = points[n * 3 - 2], l = out.length;
  if (Math.hypot(lx - out[l - 3], ly - out[l - 2]) > 0.05) out.push(lx, ly, bp);
  return out;
}
