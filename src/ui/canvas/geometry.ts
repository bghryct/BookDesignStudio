import type { Element, Project, SurfaceKey } from '../../model/types';
import type { PageSide } from '../../engine/grid';
import { computeGrid, spreadGrid } from '../../engine/grid';
import { applyMatrix, invert, multiply, translate, type Matrix } from '../../render/primitives';
import { elementMatrix } from '../../render/compile';
import { coverGrid, jacketGrid } from '../../engine/binding';
import { panelGridLines } from '../../engine/grid';
import { guidesOf } from '../../model/surfaces';

/** Anything with flat-cover panels: the cover's BindingCalc or the jacket's JacketCalc. */
export interface PanelLayout { panels: { id: string; x: number; w: number; label?: string }[] }
type BindingCalc = PanelLayout;

export interface SurfaceDesc {
  key: SurfaceKey;
  kind: 'page' | 'master' | 'cover' | 'jacket';
  /** Offset of the surface's trim origin in scene coordinates (pt). */
  x: number;
  y: number;
  w: number;
  h: number;
  bleed: number;
  pageIndex: number | null;
  side: PageSide;
  label: string;
}

export interface Pt { x: number; y: number }

/** x offset of an element on the cover caused by its panel anchor. */
export function anchorOffset(el: Element, surface: SurfaceDesc, calc: BindingCalc | null): number {
  if ((surface.kind !== 'cover' && surface.kind !== 'jacket') || !el.anchor || !calc) return 0;
  return calc.panels.find((p) => p.id === el.anchor)?.x ?? 0;
}

/** Matrix from element-local coordinates to scene coordinates. */
export function sceneMatrix(el: Element, surface: SurfaceDesc, calc: BindingCalc | null): Matrix {
  return multiply(translate(surface.x + anchorOffset(el, surface, calc), surface.y), elementMatrix(el));
}

export function toLocal(el: Element, surface: SurfaceDesc, calc: BindingCalc | null, p: Pt): Pt {
  const [x, y] = applyMatrix(invert(sceneMatrix(el, surface, calc)), p.x, p.y);
  return { x, y };
}

export function corners(el: Element, surface: SurfaceDesc, calc: BindingCalc | null): Pt[] {
  const m = sceneMatrix(el, surface, calc);
  return ([[0, 0], [el.w, 0], [el.w, el.h], [0, el.h]] as const).map(([x, y]) => {
    const [a, b] = applyMatrix(m, x, y);
    return { x: a, y: b };
  });
}

export function sceneBounds(el: Element, surface: SurfaceDesc, calc: BindingCalc | null) {
  const cs = corners(el, surface, calc);
  const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function hitElement(el: Element, surface: SurfaceDesc, calc: BindingCalc | null, p: Pt, tolerance: number): boolean {
  const l = toLocal(el, surface, calc, p);
  const t = el.type === 'rule' || el.h < tolerance * 2 || el.w < tolerance * 2 ? tolerance : 0;
  return l.x >= -t && l.y >= -t && l.x <= el.w + t && l.y <= el.h + t;
}

export function surfaceAt(surfaces: SurfaceDesc[], p: Pt, pad = 0): SurfaceDesc | null {
  for (const s of surfaces) {
    if (p.x >= s.x - s.bleed - pad && p.x <= s.x + s.w + s.bleed + pad && p.y >= s.y - s.bleed - pad && p.y <= s.y + s.h + s.bleed + pad) return s;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Snapping                                                                    */
/* -------------------------------------------------------------------------- */

export interface SnapLines { x: number[]; y: number[] }

/** Snap targets in scene coordinates for a surface. */
export function snapTargets(project: Project, surface: SurfaceDesc, others: { el: Element; surface: SurfaceDesc }[], calc: BindingCalc | null, exclude: Set<string>): SnapLines {
  const xs: number[] = [], ys: number[] = [];
  const spec = project.book;
  if ((surface.kind === 'cover' || surface.kind === 'jacket') && calc) {
    xs.push(0, surface.w, surface.w / 2);
    for (const p of calc.panels) xs.push(p.x, p.x + p.w, p.x + p.w / 2);
    ys.push(0, surface.h, surface.h / 2);
    const pg = surface.kind === 'cover' ? coverGrid(spec) : jacketGrid(spec);
    if (pg.snap) {
      const lines = panelGridLines(calc.panels, pg, surface.h);
      xs.push(...lines.snapX);
      ys.push(...lines.snapY);
    }
  } else if (spec.grid.snap) {
    const g = computeGrid(spec, surface.side);
    xs.push(...g.snapX);
    ys.push(...g.snapY);
    if (spec.grid.snapToBaseline) ys.push(...g.baselines);
    // The spread grid's columns, mapped onto this page (they may lie across the gutter).
    const sg = surface.kind === 'page' || surface.kind === 'master' ? spreadGrid(spec) : null;
    if (sg) {
      const dx = surface.side === 'right' ? -spec.trimW : 0;
      for (const c of sg.cols) xs.push(c.x + dx, c.x + c.w + dx);
      xs.push(sg.block.x + dx, sg.block.x + sg.block.w + dx);
    }
  }
  // Ruler guides on this surface.
  if (!project.guidesHidden) {
    const g = guidesOf(project, surface.key);
    xs.push(...g.x);
    ys.push(...g.y);
  }
  for (const o of others) {
    if (exclude.has(o.el.id) || o.el.hidden) continue;
    const b = sceneBounds(o.el, o.surface, calc);
    xs.push(b.x - surface.x, b.x + b.w / 2 - surface.x, b.x + b.w - surface.x);
    ys.push(b.y - surface.y, b.y + b.h / 2 - surface.y, b.y + b.h - surface.y);
  }
  return { x: xs.map((v) => v + surface.x), y: ys.map((v) => v + surface.y) };
}

/** Best snap delta for a set of candidate coordinates against target lines. */
export function snapAxis(candidates: number[], lines: number[], threshold: number): { delta: number; line: number | null } {
  let best = { delta: 0, line: null as number | null, dist: threshold + 1 };
  for (const c of candidates) {
    for (const l of lines) {
      const d = Math.abs(l - c);
      if (d < best.dist) best = { delta: l - c, line: l, dist: d };
    }
  }
  return best.dist <= threshold ? { delta: best.delta, line: best.line } : { delta: 0, line: null };
}
