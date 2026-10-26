/**
 * Regions of the cover and jacket wrap that carry their own, camera-driven sharp art (as the
 * front panel always did): front, back, spine and flaps. Narrow strips go with their neighbour,
 * the hinges with the spine and the jacket's folds with the flaps.
 */
export type WrapRegion = 'front' | 'back' | 'spine' | 'front-flap' | 'back-flap';
export const WRAP_REGIONS: readonly WrapRegion[] = ['front', 'back', 'spine', 'front-flap', 'back-flap'];

const MEMBERS: Record<WrapRegion, readonly string[]> = {
  front: ['front'],
  back: ['back'],
  spine: ['hinge-back', 'spine', 'hinge-front'],
  'front-flap': ['front-fold', 'front-flap'],
  'back-flap': ['back-fold', 'back-flap'],
};

/** The region's extent across the wrap's art (pt, art coordinates), or null when the wrap has none. */
export function regionExtent(panels: readonly { id: string; x: number; w: number }[], region: WrapRegion): { x: number; w: number } | null {
  let x0 = Infinity, x1 = -Infinity;
  for (const p of panels) {
    if (p.w <= 0 || !MEMBERS[region].includes(p.id)) continue;
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x + p.w);
  }
  return x1 > x0 ? { x: x0, w: x1 - x0 } : null;
}
