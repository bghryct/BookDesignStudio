/**
 * Typographic rules, drawn along the horizontal centre line of the box.
 *
 *  single     one line (dash and cap honoured)
 *  double     two hairlines of `strokeWidth`
 *  scotch     a thick (3 × strokeWidth) over a thin (strokeWidth) line
 *  dotted     round dots of 2 × strokeWidth; `dash[0]` sets the gap
 *  wave       a sine wave filling the box height
 *  zigzag     a sharp chevron line
 *  greek-key  a running meander band using the box height
 *  chain      interlinked ovals, with real over/under crossings
 */
import type { RuleElement } from '../../model/types';
import type { PathPrim, Prim } from '../../render/primitives';
import type { Generator } from './context';
import { Pen, TAU } from './util';
import type { Pt } from './util';

export const generateRule: Generator<RuleElement> = (el) => {
  const { w, h } = el;
  if (!(w > 0)) return [];
  const H = Math.max(h, 0);
  const sw = Math.max(0.05, el.strokeWidth || 0.5);
  const cy = H / 2;
  const dash = el.dash && el.dash.length ? el.dash.filter((d) => d >= 0) : undefined;
  const capInset = el.cap === 'butt' ? 0 : sw / 2;
  const stroke = (d: string, width: number, extra: Partial<PathPrim> = {}): PathPrim => ({
    t: 'path', d, fill: null, stroke: el.stroke, strokeWidth: width, cap: el.cap, join: 'miter', ...extra,
  });
  const hline = (y: number, inset = capInset) => new Pen().move(inset, y).line(w - inset, y).d;

  switch (el.kind) {
    case 'double': {
      const d = Math.max(sw * 3, Math.min(H - sw, sw * 2 + 2));
      return [stroke(hline(cy - d / 2) + hline(cy + d / 2), sw, { dash })];
    }
    case 'scotch': {
      const thick = sw * 3, thin = sw;
      const gap = Math.max(sw * 1.2, 1);
      const total = thick + gap + thin;
      const y0 = cy - total / 2;
      return [
        stroke(hline(y0 + thick / 2, el.cap === 'butt' ? 0 : thick / 2), thick, { dash }),
        stroke(hline(y0 + thick + gap + thin / 2), thin, { dash }),
      ];
    }
    case 'dotted': {
      const d = Math.min(Math.max(sw * 2, 0.5), H > 0 ? H : Infinity);
      const gap = dash && dash.length ? Math.max(dash[0], 0) : d * 1.25;
      const usable = w - d;
      const n = Math.max(1, Math.floor(usable / (d + gap)) + 1);
      const pitch = n > 1 ? usable / (n - 1) : 0;
      const pen = new Pen();
      for (let i = 0; i < n; i++) pen.circle(d / 2 + i * pitch + (n === 1 ? usable / 2 : 0), cy, d / 2);
      return [{ t: 'path', d: pen.d, fill: el.stroke }];
    }
    case 'wave': {
      const a = Math.max(sw * 0.6, (H - sw) * 0.32);
      const lambda = Math.max(sw * 6, a * 5);
      const span = w - 2 * capInset;
      const n = Math.max(1, Math.round(span / lambda));
      const L = span / n;
      const pts: Pt[] = [];
      const steps = n * 16;
      for (let i = 0; i <= steps; i++) {
        const x = (i / steps) * span;
        pts.push([capInset + x, cy - a * Math.sin((TAU * x) / L)]);
      }
      return [stroke(new Pen().smooth(pts).d, sw, { dash, join: 'round' })];
    }
    case 'zigzag': {
      const a = Math.max(sw * 0.6, H / 2 - sw * 0.75 - 0.1);
      const span = w - 2 * capInset;
      const n = Math.max(1, Math.round(span / (4 * a)));
      const L = span / n;
      const pts: Pt[] = [[capInset, cy]];
      for (let i = 0; i < n; i++) {
        const x = capInset + i * L;
        pts.push([x + L / 4, cy - a], [x + (3 * L) / 4, cy + a], [x + L, cy]);
      }
      return [stroke(new Pen().poly(pts).d, sw, { dash })];
    }
    case 'greek-key': {
      // One period: 5 × 4 units, a hooked spiral with every line one unit apart.
      const band = Math.max(H - sw, sw * 4);
      const u = band / 4;
      const top = cy - band / 2;
      const span = w - sw;
      const n = Math.max(1, Math.round(span / (5 * u)));
      const ux = span / (5 * n);
      const X = (x: number) => sw / 2 + x * ux;
      const Y = (y: number) => top + y * u;
      const period: Pt[] = [[0, 0], [4, 0], [4, 3], [2, 3], [2, 2], [3, 2], [3, 1], [1, 1], [1, 4], [5, 4]];
      const pts: Pt[] = [[X(0), Y(4)]];
      for (let k = 0; k < n; k++) for (const [x, y] of period) pts.push([X(x + 5 * k), Y(y)]);
      pts.push([X(5 * n), Y(0)]);
      return [stroke(new Pen().poly(pts).d, sw, { dash, join: 'miter', cap: el.cap === 'round' ? 'round' : 'square' })];
    }
    case 'chain':
      return chain(el, w, H, sw);
    default:
      return [stroke(hline(cy), sw, { dash })];
  }
};

/**
 * Interlinked ovals. Each link passes over its left neighbour at the lower
 * crossing and under it at the upper one, so the strand that runs "under" is
 * broken by a small gap — the classic engraved chain.
 */
function chain(el: RuleElement, w: number, h: number, sw: number): Prim[] {
  const cy = h / 2;
  const b = Math.max(sw * 1.5, ((h - sw) / 2) * 0.92);
  const a = b * 1.75;
  const span = w - sw;
  if (span < 2 * a) {
    return [{ t: 'path', d: new Pen().ellipse(w / 2, cy, Math.max(sw, span / 2), b).d, fill: null, stroke: el.stroke, strokeWidth: sw }];
  }
  const dTarget = a * 1.45;
  const n = Math.max(1, Math.floor((span - 2 * a) / dTarget) + 1);
  const d = n > 1 ? (span - 2 * a) / (n - 1) : 0;
  const cxs = Array.from({ length: n }, (_, i) => sw / 2 + a + i * d + (n === 1 ? (span - 2 * a) / 2 : 0));
  const gap = sw * 1.3 + 0.35;
  // Approximate distance from a point to an ellipse via the implicit function's gradient.
  const dist = (x: number, y: number, cx: number) => {
    const X = (x - cx) / a, Y = (y - cy) / b;
    const F = X * X + Y * Y - 1;
    const gx = (2 * X) / a, gy = (2 * Y) / b;
    return Math.abs(F) / (Math.hypot(gx, gy) || 1);
  };
  const pen = new Pen();
  const N = 120;
  cxs.forEach((cx, i) => {
    let run: Pt[] = [];
    const flush = () => {
      if (run.length > 1) pen.poly(run);
      run = [];
    };
    for (let s = 0; s <= N; s++) {
      const t = (s / N) * TAU;
      const x = cx + a * Math.cos(t), y = cy + b * Math.sin(t);
      // Under the left neighbour at its upper crossing; under the right neighbour at the lower one.
      const underLeft = i > 0 && y < cy && dist(x, y, cxs[i - 1]) < gap;
      const underRight = i < n - 1 && y > cy && dist(x, y, cxs[i + 1]) < gap;
      if (underLeft || underRight) flush();
      else run.push([x, y]);
    }
    flush();
  });
  return [{ t: 'path', d: pen.d, fill: null, stroke: el.stroke, strokeWidth: sw, cap: 'round', join: 'round' }];
}
