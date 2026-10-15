/**
 * The Hours of Catherine of Cleves (Utrecht, c. 1440) — border illumination.
 *
 * The Cleves Master framed his miniatures with borders of two traditions:
 *  · Dutch penwork — black hairline stems, spiralling tendrils and "hairline
 *    sprays" studded with tiny burnished gold dots and ivy leaves, with painted
 *    acanthus, flowers and strawberries;
 *  · startling trompe-l'œil borders — mussel shells, gold coins, rosaries and
 *    pearls laid on a coloured ground, each casting a real shadow.
 * Plus the scribe's apparatus: pen-flourished red/blue frames and the faint
 * ruling with its prickings.
 *
 * Motifs are drawn in a unit space through a transforming Pen, so every path
 * is emitted in page space and gold gradients / shadows stay consistent with a
 * single light from the upper left.
 */
import type { DropCapFrame, InitialElement, OrnamentElement, OrnamentKind, OrnamentPalette } from '../../model/types';
import type { LinearGradientPaint, Matrix, PathPrim, Prim, RadialGradientPaint, TextRun } from '../../render/primitives';
import { IDENTITY, applyMatrix, multiply, rectPath, rotate, scale, translate } from '../../render/primitives';
import { luminance, mix, parseColor } from '../../lib/color';
import { clamp, pick, range, rng } from '../../lib/random';
import type { Generator } from './context';
import {
  DEG, Pen, TAU, darken, fillPath, goldBurnish, goldRadial, goldRamp, lighten, place, readParams, sphereRadial,
} from './util';
import type { ParamSpec, Pt } from './util';

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

const PANEL = (on: number): ParamSpec => ({ key: 'panel', label: 'Painted ground', min: 0, max: 1, step: 1, default: on });
const FILLETS = (on: number): ParamSpec => ({ key: 'fillets', label: 'Gold fillets', min: 0, max: 1, step: 1, default: on });
const SCALE: ParamSpec = { key: 'scale', label: 'Motif scale', min: 0.5, max: 1.8, step: 0.01, default: 1 };

/** Optional knobs per ornament kind (read from `el.params`). */
export const ORNAMENT_PARAMS: Record<OrnamentKind, ParamSpec[]> = {
  'vine-border': [SCALE, { key: 'flowers', label: 'Flowers vs gold leaves', min: 0, max: 1, step: 0.01, default: 0.45 }, PANEL(0), FILLETS(0)],
  'acanthus': [SCALE, PANEL(0), FILLETS(0)],
  'strewn-flowers': [SCALE, PANEL(1), FILLETS(1)],
  'pearls-and-beads': [{ key: 'strings', label: 'Strings', min: 1, max: 3, step: 1, default: 2 }, SCALE, PANEL(1), FILLETS(1)],
  'shells-and-coins': [SCALE, { key: 'coins', label: 'Coins vs shells', min: 0, max: 1, step: 0.01, default: 0.5 }, PANEL(1), FILLETS(1)],
  'rubric-frame': [
    { key: 'bar', label: 'Bar width pt', min: 1, max: 12, step: 0.25, default: 3.5 },
    { key: 'flourish', label: 'Flourish length', min: 0, max: 1, step: 0.01, default: 0.75 },
  ],
  'ruling': [
    { key: 'lineSpacing', label: 'Line spacing pt', min: 4, max: 48, step: 0.25, default: 14 },
    { key: 'ink', label: 'Medium (0 plummet, 1 red ink, 2 drypoint)', min: 0, max: 2, step: 1, default: 0 },
    { key: 'columns', label: 'Columns', min: 1, max: 3, step: 1, default: 1 },
    { key: 'gutter', label: 'Column gap pt', min: 6, max: 72, step: 0.5, default: 18 },
    { key: 'prickings', label: 'Prickings', min: 0, max: 1, step: 1, default: 1 },
  ],
  'trompe-loeil-frame': [
    { key: 'depth', label: 'Relief depth', min: 0.2, max: 2, step: 0.01, default: 1 },
    { key: 'corners', label: 'Corner blocks', min: 0, max: 1, step: 1, default: 1 },
    { key: 'punch', label: 'Punched frieze', min: 0, max: 1, step: 1, default: 1 },
  ],
};

/* -------------------------------------------------------------------------- */
/* Scene: layered buckets so hundreds of motifs become a few dozen prims        */
/* -------------------------------------------------------------------------- */

const Z = { GROUND: 0, STEM: 10, SHADOW: 20, FILL: 30, SHADE: 40, DETAIL: 50, LIGHT: 60, LINE: 70, GOLD: 80, GOLDLINE: 85, TOP: 90, FRAME: 100 } as const;

type Style = Omit<PathPrim, 't' | 'd'>;
interface Item { z: number; seq: number; pen?: Pen; style?: Style; prim?: Prim }

interface ShadowSpec { dx: number; dy: number; color: string }

class Scene {
  private items: Item[] = [];
  private buckets = new Map<string, Item>();
  private seq = 0;

  constructor(readonly sh: ShadowSpec | null) {}

  pen(z: number, key: string, style: Style): Pen {
    const k = `${z}|${key}`;
    let it = this.buckets.get(k);
    if (!it) {
      it = { z, seq: this.seq++, pen: new Pen(), style };
      this.buckets.set(k, it);
      this.items.push(it);
    }
    return it.pen as Pen;
  }

  fill(z: number, color: string, opacity = 1): Pen {
    return this.pen(z, `f|${color}|${opacity}`, opacity < 1 ? { fill: color, opacity } : { fill: color });
  }

  stroke(z: number, color: string, width: number, opacity = 1): Pen {
    const style: Style = { fill: null, stroke: color, strokeWidth: width, cap: 'round', join: 'round' };
    if (opacity < 1) style.opacity = opacity;
    return this.pen(z, `s|${color}|${width.toFixed(3)}|${opacity}`, style);
  }

  add(z: number, prim: Prim): void {
    this.items.push({ z, seq: this.seq++, prim });
  }

  /** Soft trompe-l'œil drop shadow (two offset silhouettes) on the shared shadow layer. */
  shadow(M: Matrix, outline: (p: Pen) => void): void {
    if (!this.sh) return;
    const { dx, dy, color } = this.sh;
    this.fill(Z.SHADOW, color, 0.16).with(multiply(translate(dx * 1.8, dy * 1.8), M), outline);
    this.fill(Z.SHADOW + 1, color, 0.24).with(multiply(translate(dx, dy), M), outline);
  }

  /** Shadow emitted in sequence at `z`, so it falls on objects painted earlier (stacked coins). */
  shadowInline(z: number, M: Matrix, outline: (p: Pen) => void): void {
    if (!this.sh) return;
    const { dx, dy, color } = this.sh;
    const a = new Pen(multiply(translate(dx * 1.8, dy * 1.8), M));
    const b = new Pen(multiply(translate(dx, dy), M));
    outline(a);
    outline(b);
    this.add(z, fillPath(a.d, color, { opacity: 0.14 }));
    this.add(z, fillPath(b.d, color, { opacity: 0.22 }));
  }

  emit(): Prim[] {
    return this.items
      .slice()
      .sort((a, b) => a.z - b.z || a.seq - b.seq)
      .flatMap((it): Prim[] => {
        if (it.prim) return [it.prim];
        if (!it.pen || it.pen.empty) return [];
        return [{ t: 'path', d: it.pen.d, ...it.style }];
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Band geometry                                                               */
/* -------------------------------------------------------------------------- */

type SideName = 'top' | 'right' | 'bottom' | 'left';

/** A band side as a local frame: u runs along the band, v across it (positive = inward). */
interface Side { name: SideName; o: Pt; t: Pt; n: Pt; len: number; startCorner: boolean; endCorner: boolean }

const at = (s: Side, u: number, v: number): Pt => [s.o[0] + s.t[0] * u + s.n[0] * v, s.o[1] + s.t[1] * u + s.n[1] * v];
const dirOf = (s: Side, du: number, dv: number): number => Math.atan2(s.t[1] * du + s.n[1] * dv, s.t[0] * du + s.n[0] * dv);

interface Inner { l: number; t: number; r: number; b: number }

function bandSides(el: OrnamentElement, band: number): { sides: Side[]; corners: Pt[]; inner: Inner } {
  const { w, h } = el;
  const S = el.sides;
  const x0 = S.left ? band : 0, x1 = S.right ? w - band : w;
  const y0 = S.top ? band : 0, y1 = S.bottom ? h - band : h;
  const sides: Side[] = [];
  if (S.top) sides.push({ name: 'top', o: [x0, band / 2], t: [1, 0], n: [0, 1], len: x1 - x0, startCorner: S.left, endCorner: S.right });
  if (S.right) sides.push({ name: 'right', o: [w - band / 2, y0], t: [0, 1], n: [-1, 0], len: y1 - y0, startCorner: S.top, endCorner: S.bottom });
  if (S.bottom) sides.push({ name: 'bottom', o: [x0, h - band / 2], t: [1, 0], n: [0, -1], len: x1 - x0, startCorner: S.left, endCorner: S.right });
  if (S.left) sides.push({ name: 'left', o: [band / 2, y0], t: [0, 1], n: [1, 0], len: y1 - y0, startCorner: S.top, endCorner: S.bottom });
  const corners: Pt[] = [];
  if (S.top && S.left) corners.push([band / 2, band / 2]);
  if (S.top && S.right) corners.push([w - band / 2, band / 2]);
  if (S.bottom && S.right) corners.push([w - band / 2, h - band / 2]);
  if (S.bottom && S.left) corners.push([band / 2, h - band / 2]);
  return { sides, corners, inner: { l: x0, t: y0, r: x1, b: y1 } };
}

/** The band region (box minus the inner field) as an even-odd path. */
function bandRegion(w: number, h: number, i: Inner): string {
  return rectPath(0, 0, w, h) + rectPath(i.l, i.t, Math.max(0, i.r - i.l), Math.max(0, i.b - i.t));
}

/** Panel boundary segments: outer edges where they bound the band, plus interior edges. */
function bandOutline(el: OrnamentElement, band: number, i: Inner): Pen {
  const { w, h } = el;
  const S = el.sides;
  const pen = new Pen();
  const seg = (x0: number, y0: number, x1: number, y1: number) => pen.move(x0, y0).line(x1, y1);
  const along = (full: boolean, a: boolean, b: boolean, len: number, mk: (p: number, q: number) => void) => {
    if (full) mk(0, len);
    else {
      if (a) mk(0, band);
      if (b) mk(len - band, len);
    }
  };
  along(S.top, S.left, S.right, w, (p, q) => seg(p, 0, q, 0));
  along(S.bottom, S.left, S.right, w, (p, q) => seg(p, h, q, h));
  along(S.left, S.top, S.bottom, h, (p, q) => seg(0, p, 0, q));
  along(S.right, S.top, S.bottom, h, (p, q) => seg(w, p, w, q));
  if (S.top) seg(i.l, i.t, i.r, i.t);
  if (S.bottom) seg(i.l, i.b, i.r, i.b);
  if (S.left) seg(i.l, i.t, i.l, i.b);
  if (S.right) seg(i.r, i.t, i.r, i.b);
  return pen;
}

/* -------------------------------------------------------------------------- */
/* Shared generator state                                                      */
/* -------------------------------------------------------------------------- */

interface Circle { x: number; y: number; r: number }

interface Orn {
  el: OrnamentElement;
  p: Record<string, number>;
  pal: OrnamentPalette;
  r: () => number;
  S: Scene;
  band: number;
  /** Hairline width. */
  sw: number;
  sides: Side[];
  corners: Pt[];
  inner: Inner;
  occ: Occupancy;
  /** Total length of the band tracks, pt. */
  perimeter: number;
  /** Repeat spacing: the band, widened on very long/thin borders so motif counts stay bounded. */
  step: number;
}

/** Spatial hash of occupied discs, so gap-filling stays fast on long borders. */
class Occupancy {
  private cells = new Map<number, Circle[]>();
  constructor(private size: number) {}
  private key(i: number, j: number) {
    return i * 73856093 ^ j * 19349663;
  }
  add(c: Circle): void {
    const s = this.size;
    for (let i = Math.floor((c.x - c.r) / s); i <= Math.floor((c.x + c.r) / s); i++) {
      for (let j = Math.floor((c.y - c.r) / s); j <= Math.floor((c.y + c.r) / s); j++) {
        const k = this.key(i, j);
        const list = this.cells.get(k);
        if (list) list.push(c);
        else this.cells.set(k, [c]);
      }
    }
  }
  free(x: number, y: number, r: number): boolean {
    const s = this.size;
    for (let i = Math.floor((x - r) / s); i <= Math.floor((x + r) / s); i++) {
      for (let j = Math.floor((y - r) / s); j <= Math.floor((y + r) / s); j++) {
        const list = this.cells.get(this.key(i, j));
        if (list) for (const c of list) if (Math.hypot(c.x - x, c.y - y) < c.r + r) return false;
      }
    }
    return true;
  }
}

const WHITE = '#fffaf0';

function occupy(O: Orn, x: number, y: number, r: number): void {
  O.occ.add({ x, y, r });
}

function inBand(O: Orn, x: number, y: number, rr: number): boolean {
  const { w, h } = O.el;
  const i = O.inner;
  if (x < rr || y < rr || x > w - rr || y > h - rr) return false;
  return !(x > i.l - rr && x < i.r + rr && y > i.t - rr && y < i.b + rr);
}

/** A uniformly random point in the band (sides weighted by area). */
function randomInBand(O: Orn): Pt {
  const { w, h } = O.el;
  const i = O.inner;
  const rects: [number, number, number, number][] = [];
  if (O.el.sides.top) rects.push([0, 0, w, i.t]);
  if (O.el.sides.bottom) rects.push([0, i.b, w, h - i.b]);
  if (O.el.sides.left) rects.push([0, i.t, i.l, i.b - i.t]);
  if (O.el.sides.right) rects.push([i.r, i.t, w - i.r, i.b - i.t]);
  const total = rects.reduce((a, q) => a + q[2] * q[3], 0);
  let pickA = O.r() * total;
  for (const [x, y, rw, rh] of rects) {
    pickA -= rw * rh;
    if (pickA <= 0) return [x + O.r() * rw, y + O.r() * rh];
  }
  return [O.r() * w, O.r() * h];
}

/** Dart-throwing fill of the free band space (attempts are capped for very long borders). */
function sprinkle(O: Orn, attempts: number, rr: number, fn: (x: number, y: number) => void): void {
  const n = Math.min(Math.round(attempts), 2500);
  for (let k = 0; k < n; k++) {
    const [x, y] = randomInBand(O);
    if (!inBand(O, x, y, rr) || !O.occ.free(x, y, rr)) continue;
    occupy(O, x, y, rr);
    fn(x, y);
  }
}

/**
 * A curling tendril integrated from a heading; curvature grows toward the tip
 * as t^power, so the stem sweeps out and then winds into a spiral.
 */
function tendril(x: number, y: number, heading: number, length: number, curl: number, n = 20, power = 1.7): Pt[] {
  const pts: Pt[] = [[x, y]];
  const step = length / n;
  let hd = heading, px = x, py = y;
  let norm = 0;
  for (let i = 1; i <= n; i++) norm += Math.pow(i / n, power);
  for (let i = 1; i <= n; i++) {
    hd += (curl * Math.pow(i / n, power)) / norm;
    px += Math.cos(hd) * step;
    py += Math.sin(hd) * step;
    pts.push([px, py]);
  }
  return pts;
}

/** Outline of a polyline thickened to `width` (for shadows of stems). */
function ribbon(pts: Pt[], width: number): Pt[] {
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (-(b[1] - a[1]) / l) * (width / 2), ny = ((b[0] - a[0]) / l) * (width / 2);
    left.push([pts[i][0] + nx, pts[i][1] + ny]);
    right.push([pts[i][0] - nx, pts[i][1] - ny]);
  }
  return [...left, ...right.reverse()];
}

const endHeading = (pts: Pt[]): number => {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
};

/* -------------------------------------------------------------------------- */
/* Motifs                                                                      */
/* -------------------------------------------------------------------------- */

/** Three-lobed, pointed ivy leaf; base at the origin, tip at (1, 0). */
const ivyOutline = (p: Pen) => {
  p.move(0, 0)
    .curve(-0.06, -0.24, 0.08, -0.48, 0.34, -0.56)
    .curve(0.38, -0.4, 0.43, -0.29, 0.52, -0.2)
    .curve(0.7, -0.26, 0.9, -0.13, 1, 0)
    .curve(0.9, 0.13, 0.7, 0.26, 0.52, 0.2)
    .curve(0.43, 0.29, 0.38, 0.4, 0.34, 0.56)
    .curve(0.08, 0.48, -0.06, 0.24, 0, 0)
    .close();
};

/** Burnished gold ivy leaf — the signature of Dutch hairline borders. */
function goldLeaf(O: Orn, x: number, y: number, angle: number, size: number): void {
  const M = place(x, y, angle, size);
  O.S.shadow(M, ivyOutline);
  const pen = new Pen(M);
  ivyOutline(pen);
  const [cx, cy] = applyMatrix(M, 0.42, 0);
  O.S.add(Z.GOLD, fillPath(pen.d, goldRadial(cx, cy, size * 0.62, O.pal.gold)));
  O.S.stroke(Z.GOLDLINE, mix(O.pal.ink, O.pal.gold, 0.25), O.sw * 0.5).with(M, (p) => {
    ivyOutline(p);
    p.move(0.04, 0).line(0.74, 0).move(0.3, 0).line(0.36, -0.3).move(0.3, 0).line(0.36, 0.3);
  });
  occupy(O, cx, cy, size * 0.55);
}

/** Small gold ball: flat gold + dark rim + highlight (batched, for sprays). */
function goldDot(O: Orn, x: number, y: number, r: number): void {
  const g = goldRamp(O.pal.gold);
  if (r > 1.8) {
    O.S.shadow(place(x, y, 0, r), (p) => p.circle(0, 0, 1));
    O.S.add(Z.GOLD, fillPath(new Pen().circle(x, y, r).d, goldRadial(x, y, r, O.pal.gold)));
    O.S.stroke(Z.GOLDLINE, mix(O.pal.ink, O.pal.gold, 0.25), O.sw * 0.5).circle(x, y, r);
    return;
  }
  O.S.fill(Z.GOLD, g.base).circle(x, y, r);
  O.S.stroke(Z.GOLDLINE, g.deep, Math.min(r * 0.3, O.sw * 0.6)).circle(x, y, r);
  O.S.fill(Z.TOP, g.shine, 0.9).circle(x - r * 0.32, y - r * 0.34, r * 0.34);
}

/** Gold bezant with three hairline rays (penwork "sun"). */
function bezant(O: Orn, x: number, y: number, r: number, angle: number): void {
  const ink = O.S.stroke(Z.STEM, O.pal.ink, O.sw * 0.6);
  for (let k = 0; k < 3; k++) {
    const a = angle + (k - 1) * 0.55;
    ink.move(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25).line(x + Math.cos(a) * r * 2.6, y + Math.sin(a) * r * 2.6);
  }
  goldDot(O, x, y, r);
  occupy(O, x, y, r * 1.6);
}

/** Hairline spray: a fine black stem with side sprigs ending in gold dots and a gold leaf. */
function hairSpray(O: Orn, x: number, y: number, heading: number, len: number, sign: number): void {
  const pts = tendril(x, y, heading, len, sign * 1.1, 10);
  const ink = O.S.stroke(Z.STEM, O.pal.ink, O.sw * 0.55);
  ink.smooth(pts);
  const dotR = Math.max(0.55, O.band * 0.017);
  const sprigs = 2 + Math.floor(O.r() * 3);
  for (let k = 0; k < sprigs; k++) {
    const i = Math.floor(((k + 1) / (sprigs + 1)) * (pts.length - 1));
    const [px, py] = pts[i];
    const hd = Math.atan2(pts[i + 1][1] - py, pts[i + 1][0] - px) + (k % 2 ? 0.75 : -0.75);
    const l = len * range(O.r, 0.22, 0.36);
    const ex = px + Math.cos(hd) * l, ey = py + Math.sin(hd) * l;
    ink.move(px, py).quad(px + Math.cos(hd + 0.3 * sign) * l * 0.6, py + Math.sin(hd + 0.3 * sign) * l * 0.6, ex, ey);
    goldDot(O, ex + Math.cos(hd) * dotR, ey + Math.sin(hd) * dotR, dotR);
  }
  const [ex, ey] = pts[pts.length - 1];
  goldLeaf(O, ex, ey, endHeading(pts), Math.max(2.2, O.band * 0.11));
  for (const q of pts.filter((_, i) => i % 3 === 0)) occupy(O, q[0], q[1], len * 0.12);
}

/** Short hairline sprigs along a stem, each tipped with a gold dot (Dutch penwork). */
function sprigs(O: Orn, pts: Pt[], count: number, len: number): void {
  const ink = O.S.stroke(Z.STEM, O.pal.ink, O.sw * 0.5);
  const dotR = Math.max(0.5, O.band * 0.016);
  for (let k = 0; k < count; k++) {
    const i = Math.min(pts.length - 2, Math.floor(((k + 1) / (count + 1)) * (pts.length - 1) * 0.8));
    const [px, py] = pts[i];
    const side = (k + i) % 2 ? 1 : -1;
    const hd = Math.atan2(pts[i + 1][1] - py, pts[i + 1][0] - px) + side * range(O.r, 0.6, 1.0);
    const l = len * range(O.r, 0.7, 1.2);
    const c = tendril(px, py, hd, l, side * 1.4, 6);
    ink.smooth(c);
    const [ex, ey] = c[c.length - 1];
    const eh = endHeading(c);
    goldDot(O, ex + Math.cos(eh) * dotR, ey + Math.sin(eh) * dotR, dotR);
  }
}

const leafOutline = (wd: number, bend: number) => (p: Pen) => {
  p.move(0, 0)
    .curve(0.22, -wd * 1.25, 0.7, -wd * 0.95 + bend * 0.5, 1, bend)
    .curve(0.72, wd * 0.8 + bend * 0.5, 0.25, wd * 1.05, 0, 0)
    .close();
};

/** Painted leaf: body, shaded half, midrib, white heightening, ink contour. */
function leaf(O: Orn, x: number, y: number, angle: number, len: number, color: string, wd = 0.3, bend = 0.1): void {
  const M = place(x, y, angle, len);
  const out = leafOutline(wd, bend);
  O.S.shadow(M, out);
  O.S.fill(Z.FILL, color).with(M, out);
  O.S.fill(Z.SHADE, darken(color, 0.34), 0.85).with(M, (p) =>
    p.move(0, 0).curve(0.3, bend * 0.15 + 0.01, 0.7, bend * 0.65, 1, bend).curve(0.72, wd * 0.8 + bend * 0.5, 0.25, wd * 1.05, 0, 0).close());
  O.S.stroke(Z.DETAIL, darken(color, 0.55), O.sw * 0.55, 0.9).with(M, (p) => {
    p.move(0.04, 0).curve(0.3, bend * 0.15, 0.7, bend * 0.65, 0.96, bend);
    for (const t of [0.3, 0.5, 0.7]) p.move(t, bend * t * t * 0.9).line(t + 0.12, bend * t - wd * 0.55);
  });
  O.S.stroke(Z.LIGHT, WHITE, O.sw * 0.65, 0.85).with(M, (p) =>
    p.move(0.14, -wd * 0.52).curve(0.35, -wd * 0.88, 0.62, -wd * 0.72 + bend * 0.4, 0.86, -wd * 0.22 + bend * 0.8));
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.5).with(M, out);
  const [cx, cy] = applyMatrix(M, 0.5, 0);
  occupy(O, cx, cy, len * 0.45);
}

/** Wild rose: five overlapping petals, heightened in white, gold boss. */
function rose(O: Orn, x: number, y: number, r: number, angle: number, color: string): void {
  const M = place(x, y, angle, r);
  const petals = (p: Pen) => {
    for (let k = 0; k < 5; k++) p.with(rotate(k * 72), (q) => q.ellipse(0.52, 0, 0.5, 0.4));
  };
  O.S.shadow(M, petals);
  O.S.fill(Z.FILL, color).with(M, petals);
  O.S.fill(Z.SHADE, darken(color, 0.38), 0.7).with(M, (p) => p.circle(0, 0, 0.52));
  O.S.stroke(Z.LIGHT, WHITE, O.sw * 0.7, 0.9).with(M, (p) => {
    for (let k = 0; k < 5; k++) p.with(rotate(k * 72 + 8), (q) => q.move(0.5, -0.12).curve(0.64, -0.2, 0.8, -0.18, 0.9, -0.08));
  });
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.5).with(M, petals);
  goldDot(O, x, y, Math.max(0.8, r * 0.3));
  occupy(O, x, y, r * 1.05);
}

/** Daisy / marguerite with pink-tipped petals. */
function daisy(O: Orn, x: number, y: number, r: number, angle: number): void {
  const M = place(x, y, angle, r);
  const petals = (p: Pen) => {
    for (let k = 0; k < 12; k++) p.with(rotate(k * 30), (q) => q.ellipse(0.56, 0, 0.44, 0.12));
  };
  O.S.shadow(M, petals);
  O.S.fill(Z.FILL, '#fbf7ee').with(M, petals);
  O.S.fill(Z.SHADE, lighten(O.pal.red, 0.45), 0.8).with(M, (p) => {
    for (let k = 0; k < 12; k++) p.with(rotate(k * 30), (q) => q.ellipse(0.9, 0, 0.1, 0.075));
  });
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.4, 0.8).with(M, petals);
  goldDot(O, x, y, Math.max(0.8, r * 0.28));
  occupy(O, x, y, r * 1.05);
}

const floretOutline = (p: Pen) => {
  p.poly([[0.12, -0.05], [0.66, -0.16], [0.8, -0.3], [0.84, -0.12], [1, -0.17], [0.9, 0], [1, 0.17], [0.84, 0.12], [0.8, 0.3], [0.66, 0.16], [0.12, 0.05]], true);
};

/** Cornflower: jagged blue florets around a dark heart. */
function cornflower(O: Orn, x: number, y: number, r: number, angle: number): void {
  const M = place(x, y, angle, r);
  const florets = (p: Pen) => {
    for (let k = 0; k < 7; k++) p.with(rotate(k * (360 / 7)), floretOutline);
  };
  O.S.shadow(M, florets);
  O.S.fill(Z.FILL, O.pal.blue).with(M, florets);
  O.S.stroke(Z.LIGHT, lighten(O.pal.blue, 0.7), O.sw * 0.55, 0.9).with(M, (p) => {
    for (let k = 0; k < 7; k++) p.with(rotate(k * (360 / 7)), (q) => q.move(0.25, -0.02).line(0.78, -0.08));
  });
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.45).with(M, florets);
  O.S.fill(Z.DETAIL, mix(O.pal.blue, O.pal.red, 0.5)).with(M, (p) => p.circle(0, 0, 0.2));
  occupy(O, x, y, r * 1.05);
}

const berryOutline = (p: Pen) => {
  p.move(0, 0.06).curve(0.44, 0, 0.52, 0.56, 0.02, 1).curve(-0.5, 0.58, -0.44, 0, 0, 0.06).close();
};

/** Strawberry (fruit of the righteous): glossy berry, seeds, green calyx. Unit: calyx at origin, berry toward +y. */
function strawberry(O: Orn, x: number, y: number, size: number, angle: number): void {
  const M = place(x, y, angle, size);
  O.S.shadow(M, berryOutline);
  const pen = new Pen(M);
  berryOutline(pen);
  const [hx, hy] = applyMatrix(M, -0.06, 0.45);
  O.S.add(Z.FILL, fillPath(pen.d, sphereRadial(hx, hy, size * 0.6, O.pal.red, 0.55)));
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.45).with(M, berryOutline);
  const seeds = O.S.fill(Z.LIGHT, '#f3d77a');
  const rows: [number, number[]][] = [[0.28, [-0.22, 0, 0.22]], [0.48, [-0.28, -0.08, 0.12, 0.3]], [0.68, [-0.18, 0.04, 0.22]], [0.84, [-0.06, 0.1]]];
  for (const [yy, xs] of rows) for (const xx of xs) seeds.with(M, (p) => p.ellipse(xx, yy, 0.035, 0.05));
  const sepals = (p: Pen) => {
    for (let k = 0; k < 5; k++) {
      p.with(rotate(-90 + (k - 2) * 38), (q) => q.move(0, -0.05).curve(0.12, -0.12, 0.24, -0.08, 0.36, 0).curve(0.24, 0.06, 0.1, 0.08, 0, 0.05).close());
    }
  };
  O.S.fill(Z.DETAIL, O.pal.green).with(multiply(M, scale(1, -1)), sepals);
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.4).with(multiply(M, scale(1, -1)), sepals);
  const [cx, cy] = applyMatrix(M, 0, 0.5);
  occupy(O, cx, cy, size * 0.6);
}

const budOutline = (p: Pen) => {
  p.move(0, 0).curve(0.32, 0.12, 0.3, 0.62, 0, 1).curve(-0.3, 0.62, -0.32, 0.12, 0, 0).close();
};

/** Closed bud embraced by two sepals. Unit: base at origin, tip toward +y. */
function bud(O: Orn, x: number, y: number, size: number, angle: number, color: string): void {
  const M = place(x, y, angle, size);
  O.S.shadow(M, budOutline);
  O.S.fill(Z.FILL, color).with(M, budOutline);
  O.S.stroke(Z.LIGHT, WHITE, O.sw * 0.6, 0.85).with(M, (p) => p.move(-0.06, 0.3).curve(-0.12, 0.5, -0.1, 0.7, -0.02, 0.85));
  const sepal = (p: Pen) => {
    p.move(0, 0).curve(0.3, 0.05, 0.34, 0.3, 0.12, 0.62).curve(0.16, 0.34, 0.1, 0.18, 0, 0.1).close();
    p.move(0, 0).curve(-0.3, 0.05, -0.34, 0.3, -0.12, 0.62).curve(-0.16, 0.34, -0.1, 0.18, 0, 0.1).close();
  };
  O.S.fill(Z.DETAIL, O.pal.green).with(M, sepal);
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.45).with(M, (p) => {
    budOutline(p);
    sepal(p);
  });
  const [cx, cy] = applyMatrix(M, 0, 0.5);
  occupy(O, cx, cy, size * 0.55);
}

/**
 * Acanthus leaf curling along a spine whose curvature grows toward the tip.
 * Unit space: base at origin heading +x, curling toward −y. Scalloped lobes on
 * the convex edge, a turnover in the second colour, white hatched heightening.
 */
function acanthus(O: Orn, M: Matrix, c1: string, c2: string, lobes = 5): void {
  const n = 38;
  const spine: Pt[] = [];
  const heads: number[] = [];
  let x = 0, y = 0;
  const curlMax = 4.4;
  for (let i = 0; i <= n; i++) {
    const hd = -curlMax * Math.pow(i / n, 2.4);
    spine.push([x, y]);
    heads.push(hd);
    x += Math.cos(hd) / n;
    y += Math.sin(hd) / n;
  }
  const outerW = (t: number) => 0.27 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.04)), 0.6) * (1 - 0.4 * t);
  const innerW = (t: number) => 0.09 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.03)), 0.7);
  // Pointed lobes ("fingers") leaning toward the tip, separated by sharp notches.
  const lobe = (t: number) => {
    const f = (t * lobes) % 1;
    return 0.5 + 0.5 * Math.pow(f, 0.55) * (f > 0.9 ? (1 - f) / 0.1 : 1);
  };
  const edge = (i: number, off: number): Pt => {
    const nx = -Math.sin(heads[i]), ny = Math.cos(heads[i]);
    return [spine[i][0] + nx * off, spine[i][1] + ny * off];
  };
  const outerPts = (a: number, b: number) => {
    const pts: Pt[] = [];
    for (let i = a; i <= b; i++) pts.push(edge(i, outerW(i / n) * lobe(i / n)));
    return pts;
  };
  const innerPts = (a: number, b: number) => {
    const pts: Pt[] = [];
    for (let i = b; i >= a; i--) pts.push(edge(i, -innerW(i / n)));
    return pts;
  };
  const whole: Pt[] = [...outerPts(0, n), ...innerPts(0, n)];
  const turnAt = Math.round(n * 0.62);
  const turn: Pt[] = [...outerPts(turnAt, n), ...innerPts(turnAt, n)];
  const shade: Pt[] = [...spine.slice(0, turnAt + 1), ...innerPts(0, turnAt)];
  const body = (p: Pen) => p.smooth(whole, true, 0.3);

  O.S.shadow(M, body);
  O.S.fill(Z.FILL, c1).with(M, body);
  O.S.fill(Z.SHADE, darken(c1, 0.36), 0.9).with(M, (p) => p.smooth(shade, true, 0.3));
  O.S.fill(Z.SHADE + 1, c2).with(M, (p) => p.smooth(turn, true, 0.3));
  // Heightening: white hatching from the spine into each finger, and a line along the turnover.
  O.S.stroke(Z.LIGHT, WHITE, O.sw * 0.6, 0.9).with(M, (p) => {
    for (let k = 0; k < lobes; k++) {
      const tc = (k + 0.62) / lobes;
      if (tc * n >= turnAt - 2) break;
      for (const d of [-0.05, -0.022, 0.006]) {
        const j = clamp(Math.round((tc + d) * n), 1, n - 2);
        const a = edge(j - 1, outerW(j / n) * 0.16);
        const b = edge(j + 1, outerW(j / n) * lobe(j / n) * 0.8);
        p.move(a[0], a[1]).line(b[0], b[1]);
      }
    }
    p.smooth(spine.slice(2, turnAt).map((_, i) => edge(i + 2, outerW((i + 2) / n) * 0.07)), false);
  });
  O.S.stroke(Z.LIGHT, lighten(c2, 0.65), O.sw * 0.55, 0.9).with(M, (p) => p.smooth(outerPts(turnAt + 2, n - 3).map((q, i) => {
    const e = edge(turnAt + 2 + i, outerW((turnAt + 2 + i) / n) * 0.4);
    return [(q[0] + e[0]) / 2, (q[1] + e[1]) / 2] as Pt;
  })));
  O.S.stroke(Z.LINE, O.pal.ink, O.sw * 0.5).with(M, (p) => {
    body(p);
    p.smooth(spine.slice(0, n - 3));
  });
  const [cx, cy] = applyMatrix(M, 0.42, -0.22);
  const [ex, ey] = applyMatrix(M, 0, 0);
  occupy(O, cx, cy, Math.max(1, Math.hypot(ex - cx, ey - cy)) * 0.95);
}

/** Pearl lit from the upper left, with a pinkish iridescent rim. */
function pearl(O: Orn, x: number, y: number, r: number): void {
  O.S.shadow(place(x, y, 0, r), (p) => p.circle(0, 0, 1));
  const g: RadialGradientPaint = {
    kind: 'radial', cx: x, cy: y, r: r * 1.05, fx: x - r * 0.35, fy: y - r * 0.4,
    stops: [
      { offset: 0, color: '#ffffff' },
      { offset: 0.35, color: '#f6f1e6' },
      { offset: 0.78, color: '#d8cfc2' },
      { offset: 1, color: '#b9a99a' },
    ],
  };
  O.S.add(Z.FILL, fillPath(new Pen().circle(x, y, r).d, g));
  O.S.fill(Z.TOP, '#ffffff', 0.95).circle(x - r * 0.36, y - r * 0.38, r * 0.2);
}

/** Coloured bead (coral, lapis) or gold Paternoster bead. */
function bead(O: Orn, x: number, y: number, r: number, color: string | 'gold'): void {
  O.S.shadow(place(x, y, 0, r), (p) => p.circle(0, 0, 1));
  const paint = color === 'gold' ? goldRadial(x, y, r, O.pal.gold) : sphereRadial(x, y, r, color, 0.6);
  O.S.add(Z.FILL, fillPath(new Pen().circle(x, y, r).d, paint));
  O.S.stroke(Z.LINE, darken(color === 'gold' ? O.pal.gold : color, 0.55), O.sw * 0.35, 0.7).circle(x, y, r);
  O.S.fill(Z.TOP, '#ffffff', 0.85).circle(x - r * 0.38, y - r * 0.4, r * 0.18);
}

const musselOutline = (p: Pen) => {
  p.move(0, 0)
    .curve(0.12, -0.2, 0.55, -0.4, 0.88, -0.27)
    .curve(1.04, -0.2, 1.06, 0.1, 0.92, 0.2)
    .curve(0.62, 0.36, 0.16, 0.13, 0, 0)
    .close();
};

/** Blue-black mussel with growth lines and a nacreous sheen (inline z-order for stacking). */
function mussel(O: Orn, x: number, y: number, len: number, angle: number, z: number): void {
  const M = place(x - Math.cos(angle) * len * 0.5, y - Math.sin(angle) * len * 0.5, angle, len);
  O.S.shadowInline(z, M, musselOutline);
  const dark = mix(O.pal.ink, O.pal.blue, 0.3);
  const sheen = mix(O.pal.blue, '#cfd9ea', 0.45);
  const [x1, y1] = applyMatrix(M, 0.5, -0.36);
  const [x2, y2] = applyMatrix(M, 0.5, 0.3);
  const paint: LinearGradientPaint = {
    kind: 'linear', x1, y1, x2, y2,
    stops: [
      { offset: 0, color: mix(sheen, dark, 0.35) },
      { offset: 0.3, color: sheen },
      { offset: 0.55, color: dark },
      { offset: 0.85, color: darken(dark, 0.4) },
      { offset: 1, color: mix(dark, O.pal.blue, 0.4) },
    ],
  };
  const body = new Pen(M);
  musselOutline(body);
  O.S.add(z, fillPath(body.d, paint));
  const growth = new Pen(M);
  for (const s of [0.84, 0.68, 0.52, 0.36]) growth.with(scale(s), musselOutline);
  O.S.add(z, { t: 'path', d: growth.d, fill: null, stroke: sheen, strokeWidth: O.sw * 0.45, opacity: 0.55 });
  const hl = new Pen(M).move(0.16, -0.09).curve(0.38, -0.24, 0.62, -0.3, 0.84, -0.22);
  O.S.add(z, { t: 'path', d: hl.d, fill: null, stroke: '#ffffff', strokeWidth: O.sw * 1.1, opacity: 0.5, cap: 'round' });
  O.S.add(z, { t: 'path', d: body.d, fill: null, stroke: O.pal.ink, strokeWidth: O.sw * 0.55 });
}

/** Gold (or silver) coin: rim, legend, long cross with pellets, struck relief. */
function coin(O: Orn, x: number, y: number, r: number, angle: number, silver: boolean, z: number): void {
  const metal = silver ? '#c9ccd1' : O.pal.gold;
  const g = goldRamp(metal);
  O.S.shadowInline(z, place(x, y, 0, r), (p) => p.circle(0, 0, 1));
  O.S.add(z, fillPath(new Pen().circle(x, y, r).d, goldRadial(x, y, r, metal)));
  const M = place(x, y, angle, r);
  const rim = new Pen(M).circle(0, 0, 0.9);
  O.S.add(z, { t: 'path', d: rim.d, fill: null, stroke: g.shade, strokeWidth: r * 0.09, opacity: 0.7 });
  const legend = new Pen(M).circle(0, 0, 0.72);
  O.S.add(z, { t: 'path', d: legend.d, fill: null, stroke: g.deep, strokeWidth: r * 0.08, dash: [r * 0.07, r * 0.055], opacity: 0.75 });
  const cross = (p: Pen) => {
    p.rect(-0.62, -0.06, 1.24, 0.12).rect(-0.06, -0.62, 0.12, 1.24);
    for (let q = 0; q < 4; q++) {
      p.with(rotate(45 + q * 90), (s) => {
        s.circle(0.34, 0, 0.07);
        s.circle(0.44, -0.08, 0.06);
        s.circle(0.44, 0.08, 0.06);
      });
    }
  };
  // Struck relief: a light edge up-left, the design in shaded metal.
  const lit = new Pen(multiply(translate(-r * 0.03, -r * 0.03), M));
  const struck = new Pen(M);
  cross(lit);
  cross(struck);
  O.S.add(z, fillPath(lit.d, g.shine, { opacity: 0.8 }));
  O.S.add(z, fillPath(struck.d, g.shade));
  O.S.add(z, { t: 'path', d: new Pen().circle(x, y, r).d, fill: null, stroke: mix(O.pal.ink, metal, 0.3), strokeWidth: O.sw * 0.5 });
}

/* -------------------------------------------------------------------------- */
/* Kinds                                                                       */
/* -------------------------------------------------------------------------- */

/** Rinceaux: an undulating stem whose branches wind into each arch, with flowers, gold ivy, leaves and sprays. */
function vineBorder(O: Orn): void {
  const { S, band, sw, pal, p } = O;
  const A = band * 0.2;
  const dens = O.el.density;
  const colours = [pal.red, pal.blue, mix(pal.red, '#ffffff', 0.25)];
  for (const s of O.sides) {
    if (s.len < band * 0.6) continue;
    const nHalf = Math.max(1, Math.round(s.len / (O.step * 1.05 * p.scale)));
    const half = s.len / nHalf;
    const vAt = (u: number) => A * Math.sin((Math.PI * u) / half);
    const dvAt = (u: number) => ((A * Math.PI) / half) * Math.cos((Math.PI * u) / half);
    const stem: Pt[] = [];
    for (let u = 0; u <= s.len + 1e-6; u += Math.max(1.5, half / 12)) stem.push(at(s, u, vAt(u)));
    S.stroke(Z.STEM, pal.ink, sw * 1.3).smooth(stem);
    for (const q of stem) occupy(O, q[0], q[1], sw * 3);
    for (let k = 0; k < nHalf; k++) {
      const sig = k % 2 ? -1 : 1;
      const uc = (k + 0.5) * half;
      // A branch springs from the rising stem and winds into the arch.
      const ub = uc - half * 0.4;
      const hb = Math.atan2(dvAt(ub), 1) - sig * 1.15;
      const uv = tendril(ub, vAt(ub), hb, half * 0.95 * p.scale, -sig * 5.8, 32, 1.35);
      const pts = uv.map(([u, v]) => at(s, u, v));
      S.stroke(Z.STEM, pal.ink, sw * 0.9).smooth(pts);
      for (const q of pts) occupy(O, q[0], q[1], sw * 3);
      sprigs(O, pts, 1 + Math.round(dens * 2), band * 0.13);
      const [ex, ey] = pts[pts.length - 1];
      const fr = band * 0.14 * p.scale;
      if (O.r() < p.flowers * (0.5 + dens * 0.5)) {
        const kind = O.r();
        if (kind < 0.45) rose(O, ex, ey, fr, O.r() * TAU, pick(O.r, colours));
        else if (kind < 0.75) cornflower(O, ex, ey, fr, O.r() * TAU);
        else daisy(O, ex, ey, fr, O.r() * TAU);
      } else {
        goldLeaf(O, ex, ey, endHeading(pts), band * 0.19 * p.scale);
      }
      // A painted leaf on the crest, leaning into the narrow outer strip.
      if (O.r() < 0.3 + dens * 0.7) {
        const ul = uc + half * 0.06;
        const [lx, ly] = at(s, ul, vAt(ul));
        const hd = Math.atan2(dvAt(ul), 1) + sig * 0.55;
        leaf(O, lx, ly, dirOf(s, Math.cos(hd), Math.sin(hd)), band * 0.27 * p.scale, k % 3 === 2 ? pal.blue : pal.green, 0.3, -sig * 0.06);
      }
      // A hairline spray into the space the stem has just left.
      if (O.r() < 0.3 + dens * 0.7) {
        const up = uc + half * 0.42;
        const [sx, sy] = at(s, up, vAt(up));
        const hd = sig * (Math.PI / 2 + 0.5);
        hairSpray(O, sx, sy, dirOf(s, Math.cos(hd), Math.sin(hd)), band * 0.3, -sig);
      }
    }
  }
  for (const [cx, cy] of O.corners) {
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      goldLeaf(O, cx + Math.cos(a) * band * 0.15, cy + Math.sin(a) * band * 0.15, a, band * 0.17);
      const c = tendril(cx + Math.cos(a + 0.78) * band * 0.14, cy + Math.sin(a + 0.78) * band * 0.14, a + 0.78, band * 0.2, 3.5, 10);
      S.stroke(Z.STEM, pal.ink, sw * 0.6).smooth(c);
    }
    rose(O, cx, cy, band * 0.16 * p.scale, 0.3, pal.red);
  }
  // Fill the leftover vellum: gold bezants with hairline rays, tiny sprays, trefoils of gold dots.
  const rr = Math.max(0.9, band * 0.03);
  const tries = Math.round((dens * O.sides.reduce((a, s) => a + s.len, 0) / band) * 40);
  sprinkle(O, tries, rr * 2.4, (x, y) => {
    const roll = O.r();
    if (roll < 0.5) bezant(O, x, y, rr, O.r() * TAU);
    else if (roll < 0.75) {
      const a = O.r() * TAU;
      for (let q = 0; q < 3; q++) goldDot(O, x + Math.cos(a + (q * TAU) / 3) * rr * 1.3, y + Math.sin(a + (q * TAU) / 3) * rr * 1.3, rr * 0.6);
    } else hairSpray(O, x, y, O.r() * TAU, band * 0.16, O.r() < 0.5 ? 1 : -1);
  });
}

/** Coloured acanthus rinceau: big leaves curling into each bay, heightened in white. */
function acanthusBorder(O: Orn): void {
  const { S, band, sw, pal, p } = O;
  const A = band * 0.17;
  const pairs: [string, string][] = [[pal.blue, pal.red], [pal.green, pal.gold], [pal.red, pal.blue]];
  let leafIndex = Math.floor(O.r() * 3);
  const total = O.sides.reduce((a, s) => a + s.len, 0);
  for (const s of O.sides) {
    if (s.len < band * 0.6) continue;
    const nHalf = Math.max(1, Math.round(s.len / (Math.max(O.step, total / 50) * 1.05 * p.scale)));
    const half = s.len / nHalf;
    const vAt = (u: number) => A * Math.sin((Math.PI * u) / half);
    const dvAt = (u: number) => ((A * Math.PI) / half) * Math.cos((Math.PI * u) / half);
    const stem: Pt[] = [];
    for (let u = 0; u <= s.len + 1e-6; u += Math.max(1.5, half / 12)) stem.push(at(s, u, vAt(u)));
    S.stroke(Z.STEM, pal.ink, sw * 3.2).smooth(stem);
    S.stroke(Z.STEM + 1, pal.green, sw * 2).smooth(stem);
    S.stroke(Z.STEM + 2, lighten(pal.green, 0.5), sw * 0.5, 0.8).smooth(stem);
    for (let k = 0; k < nHalf; k++) {
      const sig = k % 2 ? -1 : 1;
      const uc = (k + 0.5) * half;
      const us = uc - half * 0.3;
      const [x, y] = at(s, us, vAt(us));
      const hd = Math.atan2(dvAt(us), 1);
      const angle = dirOf(s, Math.cos(hd), Math.sin(hd));
      // Flip so the curl falls toward −sig (into the concave bay).
      const want = [-sig * s.n[0], -sig * s.n[1]];
      const flip = Math.sin(angle) * want[0] - Math.cos(angle) * want[1] > 0 ? 1 : -1;
      const L = band * 0.82 * p.scale;
      const [c1, c2] = pairs[leafIndex++ % pairs.length];
      acanthus(O, place(x, y, angle, L, L * flip), c1, c2);
      if (O.r() < O.el.density) {
        // A small counter-leaf on the outer side of the crest.
        const ub = uc + half * 0.12;
        const [bx, by] = at(s, ub, vAt(ub));
        const hb = Math.atan2(dvAt(ub), 1);
        const ab = dirOf(s, Math.cos(hb), Math.sin(hb));
        const fb = -flip;
        const Lb = L * 0.42;
        const [d1] = pairs[(leafIndex + 1) % pairs.length];
        acanthus(O, place(bx, by, ab, Lb, Lb * fb), d1, pal.gold, 3);
      }
    }
  }
  for (const [cx, cy] of O.corners) {
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      const L = band * 0.36;
      acanthus(O, place(cx, cy, a, L, L), k % 2 ? pal.blue : pal.red, pal.gold, 3);
    }
    goldDot(O, cx, cy, band * 0.07);
  }
  const rr = Math.max(1, band * 0.03);
  const tries = Math.round(O.el.density * O.sides.reduce((a, s) => a + s.len, 0) / band * 24);
  sprinkle(O, tries, rr * 3, (x, y) => {
    if (O.r() < 0.6) bezant(O, x, y, rr, O.r() * TAU);
    else hairSpray(O, x, y, O.r() * TAU, band * 0.22, O.r() < 0.5 ? 1 : -1);
  });
}

/** Strewn border: cut flowers, strawberries and buds scattered on a painted ground, with shadows. */
function strewnFlowers(O: Orn): void {
  const { S, band, sw, pal, p } = O;
  const area = O.sides.reduce((a, s) => a + s.len * band, 0) + O.corners.length * band * band;
  const dmin = Math.max(band * (0.5 - 0.22 * O.el.density) * p.scale, Math.sqrt(area / 260));
  const flowerColours = [pal.red, pal.blue, mix(pal.red, '#ffffff', 0.3), mix(pal.blue, pal.red, 0.45)];
  const attempts = Math.min(6000, Math.round((area / (dmin * dmin)) * 4));
  const pts: Pt[] = [];
  const grid = new Occupancy(dmin);
  for (let k = 0; k < attempts && pts.length < 300; k++) {
    const [x, y] = randomInBand(O);
    if (!inBand(O, x, y, dmin * 0.42) || !grid.free(x, y, dmin / 2)) continue;
    grid.add({ x, y, r: dmin / 2 });
    pts.push([x, y]);
  }
  const stems = S.stroke(Z.STEM, pal.green, sw * 1.6);
  for (const [x, y] of pts) {
    const a = O.r() * TAU;
    const s = dmin * range(O.r, 0.36, 0.46);
    const kind = O.r();
    const stemTo = (len: number, from: Pt) => {
      const bx = from[0] - Math.cos(a) * len, by = from[1] - Math.sin(a) * len;
      const qx = from[0] - Math.cos(a + 0.4) * len * 0.6, qy = from[1] - Math.sin(a + 0.4) * len * 0.6;
      stems.move(from[0], from[1]).quad(qx, qy, bx, by);
      if (O.r() < 0.6) leaf(O, (from[0] + bx) / 2, (from[1] + by) / 2, a + Math.PI + (O.r() < 0.5 ? 0.9 : -0.9), s * 0.8, pal.green, 0.28, 0.08);
      // The cut stem casts a thin shadow too: a ribbon along the same curve.
      const curve: Pt[] = [];
      for (let t = 0; t <= 1.0001; t += 0.125) {
        const u = 1 - t;
        curve.push([u * u * from[0] + 2 * u * t * qx + t * t * bx, u * u * from[1] + 2 * u * t * qy + t * t * by]);
      }
      S.shadow(IDENTITY, (pp) => pp.poly(ribbon(curve, sw * 1.6), true));
    };
    if (kind < 0.2) {
      stemTo(s * 1.3, [x - Math.cos(a) * s * 0.6, y - Math.sin(a) * s * 0.6]);
      rose(O, x, y, s * 0.75, O.r() * TAU, pick(O.r, flowerColours));
    } else if (kind < 0.34) {
      stemTo(s * 1.3, [x - Math.cos(a) * s * 0.6, y - Math.sin(a) * s * 0.6]);
      daisy(O, x, y, s * 0.75, O.r() * TAU);
    } else if (kind < 0.46) {
      stemTo(s * 1.2, [x - Math.cos(a) * s * 0.55, y - Math.sin(a) * s * 0.55]);
      cornflower(O, x, y, s * 0.72, O.r() * TAU);
    } else if (kind < 0.68) {
      const ox = x - Math.cos(a) * s * 0.6, oy = y - Math.sin(a) * s * 0.6;
      stemTo(s * 0.9, [ox, oy]);
      strawberry(O, ox, oy, s * 1.25, a - Math.PI / 2);
    } else if (kind < 0.82) {
      const ox = x - Math.cos(a) * s * 0.55, oy = y - Math.sin(a) * s * 0.55;
      stemTo(s * 1.1, [ox, oy]);
      bud(O, ox, oy, s * 1.15, a - Math.PI / 2, pick(O.r, flowerColours));
    } else if (kind < 0.92) {
      leaf(O, x - Math.cos(a) * s * 0.6, y - Math.sin(a) * s * 0.6, a, s * 1.3, O.r() < 0.7 ? pal.green : pal.blue, 0.3, 0.1);
    } else {
      for (let q = 0; q < 3; q++) {
        const b = a + (q * TAU) / 3;
        goldDot(O, x + Math.cos(b) * s * 0.3, y + Math.sin(b) * s * 0.3, Math.max(0.9, s * 0.2));
      }
    }
    occupy(O, x, y, dmin * 0.45);
  }
  // Dutch hairline sprays in the gaps.
  const tries = Math.round(O.el.density * pts.length * 3);
  sprinkle(O, tries, band * 0.09, (x, y) => hairSpray(O, x, y, O.r() * TAU, band * 0.2, O.r() < 0.5 ? 1 : -1));
}

/** Rosaries and strings of pearls laid on the ground, each bead casting its shadow. */
function pearlsAndBeads(O: Orn): void {
  const { S, band, sw, pal, p } = O;
  const strings = Math.round(p.strings);
  const pr = Math.max(1.2, band * 0.055 * p.scale);
  for (let si = 0; si < O.sides.length; si++) {
    const s = O.sides[si];
    if (s.len < band * 0.5) continue;
    for (let k = 0; k < strings; k++) {
      const rosary = k === 0;
      const A = band * (strings === 1 ? 0.22 : 0.26 - k * 0.05);
      const waves = Math.max(1, Math.round(s.len / (O.step * (2.2 + k * 0.5))));
      const lam = s.len / waves;
      const ph = k * Math.PI;
      const vAt = (u: number) => A * Math.sin((TAU * u) / lam + ph) + (strings === 3 && k === 2 ? 0 : 0);
      // Walk the curve by arc length, dropping beads.
      const rBead = rosary ? pr * 1.12 : pr * (0.85 - k * 0.12);
      const gap = Math.max(rBead * (2.05 - O.el.density * 0.15), (O.perimeter * strings) / 1200);
      const thread: Pt[] = [];
      const beads: { x: number; y: number; i: number }[] = [];
      let acc = gap / 2, i = 0;
      let prev = at(s, 0, vAt(0));
      thread.push(prev);
      for (let u = 0.5; u <= s.len; u += 0.5) {
        const q = at(s, u, vAt(u));
        acc += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
        prev = q;
        if (thread.length < 2000 && u % 2 < 0.5) thread.push(q);
        if (acc >= gap) {
          acc -= gap;
          beads.push({ x: q[0], y: q[1], i: i++ });
        }
      }
      S.stroke(Z.STEM, rosary ? mix(pal.gold, pal.ink, 0.3) : mix(pal.ink, pal.ground, 0.35), sw * 0.6).smooth(thread);
      for (const b of beads) {
        if (rosary) {
          // A decade of Aves in coral, then a gold Paternoster bead.
          if (b.i % 11 === 10) bead(O, b.x, b.y, rBead * 1.3, 'gold');
          else bead(O, b.x, b.y, rBead, pal.red);
        } else if (k === 2) {
          bead(O, b.x, b.y, rBead, b.i % 6 === 5 ? pal.blue : 'gold');
        } else {
          pearl(O, b.x, b.y, rBead);
        }
      }
    }
    if (O.el.density > 0.7) {
      // Seed-pearl edging along both band edges.
      for (const v of [-band * 0.42, band * 0.42]) {
        const sr = pr * 0.45;
        for (let u = sr * 2; u < s.len - sr; u += Math.max(sr * 2.3, s.len / 90)) {
          const [x, y] = at(s, u, v);
          pearl(O, x, y, sr);
        }
      }
    }
  }
  O.corners.forEach(([cx, cy], idx) => {
    if (idx === 0) {
      // The rosary's pendant cross.
      const M = place(cx, cy, 0, band * 0.3);
      const cross = (q: Pen) => q.rect(-0.12, -0.75, 0.24, 1.5).rect(-0.55, -0.37, 1.1, 0.24);
      S.shadow(M, cross);
      const pen = new Pen(M);
      cross(pen);
      S.add(Z.GOLD, fillPath(pen.d, goldBurnish(cx - band * 0.2, cy - band * 0.2, cx + band * 0.2, cy + band * 0.2, pal.gold)));
      S.stroke(Z.GOLDLINE, mix(pal.ink, pal.gold, 0.3), sw * 0.5).with(M, cross);
      bead(O, cx, cy - band * 0.11, band * 0.045, pal.red);
    } else {
      for (let k = 0; k < 8; k++) {
        const a = (k * TAU) / 8;
        pearl(O, cx + Math.cos(a) * band * 0.17, cy + Math.sin(a) * band * 0.17, pr * 0.9);
      }
      bead(O, cx, cy, band * 0.1, 'gold');
    }
  });
}

/** The famous Cleves trompe-l'œil: mussel shells and gold coins strewn in the band. */
function shellsAndCoins(O: Orn): void {
  const { band, p } = O;
  const area = O.sides.reduce((a, s) => a + s.len * band, 0);
  const slot = Math.max(band * (0.62 - 0.2 * O.el.density) * p.scale, Math.sqrt(area / 220), O.perimeter / 200);
  const rows = Math.max(1, Math.min(4, Math.round(band / (slot * 1.15))));
  let z = Z.FILL;
  const objects: { x: number; y: number; kind: 'mussel' | 'coin' | 'pair'; a: number; silver: boolean }[] = [];
  for (const s of O.sides) {
    const cols = Math.max(1, Math.round(s.len / slot));
    const du = s.len / cols;
    for (let j = 0; j < rows; j++) {
      const v = -band / 2 + (band * (j + 0.5)) / rows;
      for (let i = 0; i < cols; i++) {
        const u = (i + 0.5 + (j % 2 ? 0.5 : 0)) * du;
        if (u > s.len) continue;
        const [x, y] = at(s, u + range(O.r, -0.12, 0.12) * du, v + range(O.r, -0.1, 0.1) * band / rows);
        const isCoin = (i + j) % 2 === 1 ? O.r() < 0.5 + p.coins * 0.5 : O.r() < p.coins * 0.5;
        const a = (i + j) % 2 ? Math.PI / 4 : -Math.PI / 4;
        objects.push({
          x, y, a: isCoin ? O.r() * TAU : a + range(O.r, -0.4, 0.4) + (O.r() < 0.5 ? Math.PI : 0),
          kind: isCoin ? (O.r() < 0.18 ? 'pair' : 'coin') : 'mussel', silver: O.r() < 0.22,
        });
      }
    }
  }
  for (const [cx, cy] of O.corners) objects.push({ x: cx, y: cy, kind: 'coin', a: O.r() * TAU, silver: false });
  // Painting order by a seeded shuffle, so objects overlap in a believable heap.
  const order = objects.map((o, i) => ({ o, k: O.r() + (o.kind === 'mussel' ? 0 : 0.15), i })).sort((a, b) => a.k - b.k);
  for (const { o } of order) {
    if (o.kind === 'mussel') mussel(O, o.x, o.y, slot * 0.98, o.a, z);
    else if (o.kind === 'coin') coin(O, o.x, o.y, slot * 0.36, o.a, o.silver, z);
    else {
      coin(O, o.x - slot * 0.12, o.y - slot * 0.08, slot * 0.3, o.a, !o.silver, z);
      coin(O, o.x + slot * 0.12, o.y + slot * 0.1, slot * 0.32, o.a + 1, o.silver, z);
    }
    z += 0.001;
  }
}

/**
 * Gothic pen-flourishing: a split bar of red and blue segments (slanted joins,
 * reserved white line), and in the counter-colour a feathered echo line from
 * which hairline scrolls spring, wind into volutes and end in pearls.
 */
function rubricFrame(O: Orn): void {
  const { S, band, sw, pal, p } = O;
  const { w, h } = O.el;
  const r = O.r;
  const barT = Math.min(p.bar, band * 0.35);
  const vb = band / 2 - band * 0.12 - barT / 2;
  const vt = vb - barT / 2, vi = vb + barT / 2;
  const reach = band / 2 + vt;
  const cols = [pal.red, pal.blue];
  const penW = Math.max(0.28, sw * 0.55);
  const gap = Math.max(0.6, barT * 0.3);
  const slant = barT * 0.9;
  const beadR = Math.max(0.45, barT * 0.15);

  /** A flourish in uv space: scroll + counter-scroll + barbs + pearls. */
  const flourish = (s: Side, ink: Pen, dots: Pen, u: number, v: number, lean: number, len: number) => {
    const side = lean > 0 ? 1 : -1;
    const hd = -Math.PI / 2 + lean;
    const main = tendril(u, v, hd, len, side * range(r, 4.6, 6.2), 30, 1.6);
    ink.smooth(main.map(([a, b]) => at(s, a, b)));
    const j = Math.round(main.length * 0.42);
    const [bu, bv] = main[j];
    const bh = Math.atan2(main[j + 1][1] - bv, main[j + 1][0] - bu) - side * 0.95;
    const sub = tendril(bu, bv, bh, len * range(r, 0.3, 0.45), -side * range(r, 3.8, 5), 14, 1.8);
    ink.smooth(sub.map(([a, b]) => at(s, a, b)));
    // Barbs on the convex side of the first stretch.
    for (let q = 2; q < j - 1; q += 3) {
      const [pu, pv] = main[q];
      const th = Math.atan2(main[q + 1][1] - pv, main[q + 1][0] - pu) + side * 1.1;
      const l = barT * range(r, 0.35, 0.6);
      ink.move(...at(s, pu, pv)).line(...at(s, pu + Math.cos(th) * l, pv + Math.sin(th) * l));
    }
    const end = main[main.length - 1];
    dots.circle(...at(s, end[0], end[1]), beadR * 0.75);
    const se = sub[sub.length - 1];
    dots.circle(...at(s, se[0], se[1]), beadR * 0.6);
    // Frog-spawn: tiny rings with a dot beside the scroll.
    const [fu, fv] = main[Math.round(main.length * 0.7)];
    const fx = fu - side * barT * 1.1, fy = fv;
    if (Math.abs(fy) < band / 2 - beadR * 2) {
      ink.circle(...at(s, fx, fy), beadR * 1.1);
      dots.circle(...at(s, fx, fy), beadR * 0.35);
    }
  };

  for (const s of O.sides) {
    const u0 = s.startCorner ? vb - band / 2 + barT / 2 + gap : 1;
    const u1 = s.endCorner ? s.len + band / 2 - vb - barT / 2 - gap : s.len - 1;
    const total = u1 - u0;
    if (total <= barT) continue;
    const nSeg = Math.max(1, Math.round(total / Math.max(barT * 8, O.perimeter / 160)));
    const cut = (i: number) => u0 + (total * i) / nSeg;
    for (let i = 0; i < nSeg; i++) {
      const first = i === 0, last = i === nSeg - 1;
      const a = cut(i), b = cut(i + 1);
      const ci = (i + (s.name === 'left' || s.name === 'right' ? 1 : 0)) % 2;
      const c = cols[ci], cc = cols[1 - ci];
      const aT = first ? a : a + slant / 2 + gap / 2, aB = first ? a : a - slant / 2 + gap / 2;
      const bT = last ? b : b + slant / 2 - gap / 2, bB = last ? b : b - slant / 2 - gap / 2;
      S.fill(Z.FILL, c).poly([at(s, aT, vt), at(s, bT, vt), at(s, bB, vi), at(s, aB, vi)], true);
      // Reserved white wave inside the bar.
      if (barT >= 2.2 && b - a > barT * 3) {
        const wave: Pt[] = [];
        const lam = barT * 1.8;
        for (let u = a + barT * 1.2; u <= b - barT * 1.2; u += lam / 8) wave.push(at(s, u, vb + Math.sin(((u - a) / lam) * TAU) * barT * 0.16));
        S.stroke(Z.LIGHT, WHITE, Math.max(0.22, barT * 0.1), 0.95).smooth(wave);
      }
      // Counter-colour penwork on the outer side.
      const ink = S.stroke(Z.STEM, cc, penW);
      const dots = S.fill(Z.LINE, cc);
      const ve = vt - barT * 0.6;
      ink.move(...at(s, a + barT * 0.3, ve)).line(...at(s, b - barT * 0.3, ve));
      ink.circle(...at(s, a + barT * 0.3 - beadR, ve), beadR);
      ink.circle(...at(s, b - barT * 0.3 + beadR, ve), beadR);
      const fa = a + (b - a) * 0.2, fb = b - (b - a) * 0.2;
      for (let u = fa; u <= fb; u += Math.max(1, barT * 0.32)) ink.move(...at(s, u, ve)).line(...at(s, u, ve - barT * 0.5));
      if (p.flourish > 0) {
        const count = r() < 0.35 ? 1 : 2;
        for (let q = 0; q < count; q++) {
          const u = a + (b - a) * (count === 1 ? range(r, 0.35, 0.65) : q === 0 ? range(r, 0.2, 0.4) : range(r, 0.6, 0.8));
          const lean = (r() < 0.5 ? -1 : 1) * range(r, 0.3, 0.75);
          const len = reach * range(r, 0.85, 1.25) * (0.35 + 0.65 * p.flourish);
          flourish(s, ink, dots, u, ve - barT * 0.5, lean, len);
        }
      }
      // Inner echo line toward the text, in the bar's own colour.
      S.stroke(Z.STEM, c, penW * 0.8).move(...at(s, a + 0.5, vi + barT * 0.5)).line(...at(s, b - 0.5, vi + barT * 0.5));
    }
  }
  // Corner squares where two bars meet, ringed with volutes toward the outer corner.
  O.corners.forEach(([cx, cy], idx) => {
    const dx = cx < w / 2 ? 1 : -1, dy = cy < h / 2 ? 1 : -1;
    const qx = cx + dx * vb, qy = cy + dy * vb;
    const c = cols[idx % 2], cc = cols[1 - (idx % 2)];
    S.fill(Z.FILL, c).rect(qx - barT / 2, qy - barT / 2, barT, barT);
    const ink = S.stroke(Z.STEM, cc, penW);
    const out = Math.atan2(-dy, -dx);
    for (const sg of [-1, 1]) {
      const pts = tendril(qx - dx * barT, qy - dy * barT, out + sg * 0.5, reach * (0.5 + 0.4 * p.flourish), sg * 5.2, 22, 2.2);
      ink.smooth(pts);
    }
    ink.circle(qx - dx * barT * 1.6, qy - dy * barT * 1.6, beadR * 1.2);
    S.fill(Z.LINE, cc).circle(qx - dx * barT * 1.6, qy - dy * barT * 1.6, beadR * 0.45);
  });
}

/** Faint manuscript ruling with bounding lines and prickings. */
function ruling(O: Orn): void {
  const { S, band, pal, p } = O;
  const { w, h } = O.el;
  const i = O.inner;
  const medium = Math.round(p.ink);
  const col = medium === 1 ? mix(pal.red, pal.ground, 0.4) : medium === 2 ? mix(pal.ink, pal.ground, 0.82) : mix(pal.ink, pal.ground, 0.62);
  const lw = medium === 2 ? 0.35 : 0.28;
  const op = medium === 1 ? 0.75 : 0.65;
  const pen = S.stroke(Z.STEM, col, lw, op);
  const bound = S.stroke(Z.STEM, col, lw, op);
  const ls = p.lineSpacing;
  const n = Math.floor((i.b - i.t) / ls + 1e-6);
  const dv = Math.min(Math.max(band * 0.12, 3), 6);
  const leftB = O.el.sides.left ? i.l - dv : i.l;
  const rightB = O.el.sides.right ? i.r + dv : i.r;
  const cols = Math.round(p.columns);
  const colW = (i.r - i.l - p.gutter * (cols - 1)) / cols;
  for (let k = 0; k <= n; k++) {
    const y = i.t + k * ls;
    if (k <= 1 || k >= n - 1) pen.move(O.el.sides.left ? leftB - band * 0.4 : 0, y).line(O.el.sides.right ? rightB + band * 0.4 : w, y);
    else pen.move(leftB, y).line(rightB, y);
  }
  // Double bounding lines through the full page height.
  if (O.el.sides.left) bound.move(i.l, 0).line(i.l, h).move(leftB, 0).line(leftB, h);
  if (O.el.sides.right) bound.move(i.r, 0).line(i.r, h).move(rightB, 0).line(rightB, h);
  for (let c = 1; c < cols; c++) {
    const x1 = i.l + c * colW + (c - 1) * p.gutter;
    const x2 = x1 + p.gutter;
    bound.move(x1, 0).line(x1, h).move(x2, 0).line(x2, h);
  }
  if (medium === 2) {
    // Drypoint: the stylus raises a ridge — a light edge under each furrow.
    const ridge = S.stroke(Z.STEM - 1, '#ffffff', lw, 0.6);
    for (let k = 0; k <= n; k++) ridge.move(leftB, i.t + k * ls + 0.35).line(rightB, i.t + k * ls + 0.35);
  }
  if (p.prickings) {
    const prick = S.fill(Z.DETAIL, mix(pal.ink, pal.ground, 0.35), 0.8);
    const rim = S.fill(Z.DETAIL - 1, '#ffffff', 0.5);
    const hole = (x: number, y: number) => {
      const a = range(O.r, -0.5, 0.5);
      prick.with(place(x, y, a, 1), (q) => q.ellipse(0, 0, 0.45, 0.85));
      rim.with(place(x + 0.25, y + 0.3, a, 1), (q) => q.ellipse(0, 0, 0.45, 0.85));
    };
    const px: number[] = [];
    if (O.el.sides.left) px.push(Math.max(2, band * 0.18));
    if (O.el.sides.right) px.push(w - Math.max(2, band * 0.18));
    if (!px.length) px.push(2.5);
    for (const x of px) for (let k = 0; k <= n; k++) hole(x + range(O.r, -0.4, 0.4), i.t + k * ls);
    const py: number[] = [];
    if (O.el.sides.top) py.push(Math.max(2, band * 0.18));
    if (O.el.sides.bottom) py.push(h - Math.max(2, band * 0.18));
    const xs = [...(O.el.sides.left ? [i.l, leftB] : []), ...(O.el.sides.right ? [i.r, rightB] : [])];
    for (const y of py) for (const x of xs) hole(x, y + range(O.r, -0.4, 0.4));
  }
}

/** Gilded architectural frame: a lit moulding profile, punched frieze, corner blocks with cabochons. */
function trompeFrame(O: Orn): void {
  const { S, band, pal, p } = O;
  const { w, h } = O.el;
  const SD = O.el.sides;
  const gold = pal.gold;
  const g = goldRamp(gold);
  const L = normalize3(-0.5, -0.68, 0.62);
  const Hv = normalize3(L[0], L[1], L[2] + 1);
  const depth = 0.4 * p.depth;
  const profile = (t: number): number => {
    if (t < 0.08) return 0.62 + (t / 0.08) * 0.38;
    if (t < 0.14) return 1;
    if (t < 0.42) return 0.45 + 0.55 * (0.5 + 0.5 * Math.cos((Math.PI * (t - 0.14)) / 0.28));
    if (t < 0.54) {
      const q = (t - 0.48) / 0.06;
      return 0.45 + 0.14 * Math.sqrt(Math.max(0, 1 - q * q));
    }
    if (t < 0.8) return 0.45;
    if (t < 0.86) return 0.52;
    return 0.52 * (1 - (t - 0.86) / 0.14);
  };
  const shadeAt = (t: number, nIx: number, nIy: number): string => {
    const e = 0.004;
    const slope = ((profile(Math.min(1, t + e)) - profile(Math.max(0, t - e))) / (2 * e)) * depth;
    const N = normalize3(-slope * nIx, -slope * nIy, 1);
    const lam = N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
    const spec = Math.pow(Math.max(0, N[0] * Hv[0] + N[1] * Hv[1] + N[2] * Hv[2]), 28);
    const v = lam / L[2];
    let c = v <= 1 ? mix(g.deep, g.base, clamp(v, 0, 1) ** 1.3) : mix(g.base, g.light, clamp((v - 1) / 0.45, 0, 1));
    c = mix(c, g.shine, clamp(spec * 0.9, 0, 1));
    return c;
  };
  const corners = p.corners > 0;
  const lo = (d: number, a: boolean) => (a ? (corners ? band : d) : 0);
  type Spec = { on: boolean; nI: Pt; poly: (d0: number, d1: number) => Pt[]; g0: Pt; g1: Pt; line: (d: number) => [Pt, Pt] };
  const specs: Spec[] = [
    { on: SD.top, nI: [0, 1], g0: [w / 2, 0], g1: [w / 2, band],
      poly: (d0, d1) => [[lo(d0, SD.left), d0], [w - lo(d0, SD.right), d0], [w - lo(d1, SD.right), d1], [lo(d1, SD.left), d1]],
      line: (d) => [[lo(d, SD.left), d], [w - lo(d, SD.right), d]] },
    { on: SD.bottom, nI: [0, -1], g0: [w / 2, h], g1: [w / 2, h - band],
      poly: (d0, d1) => [[lo(d0, SD.left), h - d0], [w - lo(d0, SD.right), h - d0], [w - lo(d1, SD.right), h - d1], [lo(d1, SD.left), h - d1]],
      line: (d) => [[lo(d, SD.left), h - d], [w - lo(d, SD.right), h - d]] },
    { on: SD.left, nI: [1, 0], g0: [0, h / 2], g1: [band, h / 2],
      poly: (d0, d1) => [[d0, lo(d0, SD.top)], [d0, h - lo(d0, SD.bottom)], [d1, h - lo(d1, SD.bottom)], [d1, lo(d1, SD.top)]],
      line: (d) => [[d, lo(d, SD.top)], [d, h - lo(d, SD.bottom)]] },
    { on: SD.right, nI: [-1, 0], g0: [w, h / 2], g1: [w - band, h / 2],
      poly: (d0, d1) => [[w - d0, lo(d0, SD.top)], [w - d0, h - lo(d0, SD.bottom)], [w - d1, h - lo(d1, SD.bottom)], [w - d1, lo(d1, SD.top)]],
      line: (d) => [[w - d, lo(d, SD.top)], [w - d, h - lo(d, SD.bottom)]] },
  ];
  const STOPS = 40;
  for (const sp of specs) {
    if (!sp.on) continue;
    const stops = [];
    for (let k = 0; k <= STOPS; k++) {
      const t = k / STOPS;
      stops.push({ offset: t, color: shadeAt(t, sp.nI[0], sp.nI[1]) });
    }
    const paint: LinearGradientPaint = { kind: 'linear', x1: sp.g0[0], y1: sp.g0[1], x2: sp.g1[0], y2: sp.g1[1], stops };
    S.add(Z.FILL, fillPath(new Pen().poly(sp.poly(0, band), true).d, paint));
    const lines = S.stroke(Z.LINE, g.deep, 0.3, 0.55);
    for (const t of [0.08, 0.14, 0.42, 0.54, 0.8, 0.86]) {
      const [a, b] = sp.line(t * band);
      lines.move(a[0], a[1]).line(b[0], b[1]);
    }
    if (p.punch) {
      const d = 0.67 * band;
      const [a, b] = sp.line(d);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const step = Math.max(2, band * 0.075);
      const pr = Math.max(0.3, band * 0.013);
      const lit = S.fill(Z.DETAIL, g.shine, 0.85);
      const hole = S.fill(Z.DETAIL + 1, g.deep, 0.85);
      for (let s = step / 2; s < len; s += step) {
        const x = a[0] + ((b[0] - a[0]) * s) / len, y = a[1] + ((b[1] - a[1]) * s) / len;
        lit.circle(x + pr * 0.35, y + pr * 0.35, pr);
        hole.circle(x, y, pr);
      }
    }
  }
  // Mitre lines where two sides meet without corner blocks.
  if (!corners) {
    const m = S.stroke(Z.LINE, g.deep, 0.35, 0.6);
    if (SD.top && SD.left) m.move(0, 0).line(band, band);
    if (SD.top && SD.right) m.move(w, 0).line(w - band, band);
    if (SD.bottom && SD.left) m.move(0, h).line(band, h - band);
    if (SD.bottom && SD.right) m.move(w, h).line(w - band, h - band);
  } else {
    O.corners.forEach(([cx, cy], idx) => cornerBlock(O, cx - band / 2, cy - band / 2, band, idx % 2 ? pal.blue : pal.red, L));
  }
  // Cast shadow of the frame onto the field (light from the upper left).
  const i = O.inner;
  const sh = band * 0.22;
  const tint = O.pal.ink;
  if (SD.top) S.add(Z.GROUND, fillPath(rectPath(i.l, i.t, i.r - i.l, sh), linear(0, i.t, 0, i.t + sh, tint, 0.38)));
  if (SD.left) S.add(Z.GROUND, fillPath(rectPath(i.l, i.t, sh, i.b - i.t), linear(i.l, 0, i.l + sh, 0, tint, 0.3)));
  S.add(Z.FRAME, { t: 'path', d: bandOutline(O.el, band, O.inner).d, fill: null, stroke: mix(O.pal.ink, gold, 0.2), strokeWidth: 0.4 });
}

function linear(x1: number, y1: number, x2: number, y2: number, color: string, alpha: number): LinearGradientPaint {
  return { kind: 'linear', x1, y1, x2, y2, stops: [{ offset: 0, color, opacity: alpha }, { offset: 0.45, color, opacity: alpha * 0.35 }, { offset: 1, color, opacity: 0 }] };
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Bevelled corner block (a lit frustum) set with a cabochon in a gold bezel. */
function cornerBlock(O: Orn, x: number, y: number, s: number, gem: string, L: [number, number, number]): void {
  const g = goldRamp(O.pal.gold);
  const k = s * 0.24;
  const faces: { pts: Pt[]; n: Pt }[] = [
    { pts: [[x, y], [x + s, y], [x + s - k, y + k], [x + k, y + k]], n: [0, -1] },
    { pts: [[x + s, y], [x + s, y + s], [x + s - k, y + s - k], [x + s - k, y + k]], n: [1, 0] },
    { pts: [[x + s, y + s], [x, y + s], [x + k, y + s - k], [x + s - k, y + s - k]], n: [0, 1] },
    { pts: [[x, y + s], [x, y], [x + k, y + k], [x + k, y + s - k]], n: [-1, 0] },
  ];
  for (const f of faces) {
    const N = normalize3(f.n[0] * 0.9, f.n[1] * 0.9, 1);
    const v = (N[0] * L[0] + N[1] * L[1] + N[2] * L[2]) / L[2];
    const c = v <= 1 ? mix(g.deep, g.base, clamp(v, 0, 1)) : mix(g.base, g.light, clamp((v - 1) / 0.45, 0, 1));
    O.S.add(Z.GOLD, fillPath(new Pen().poly(f.pts, true).d, c));
  }
  O.S.add(Z.GOLD, fillPath(rectPath(x + k, y + k, s - 2 * k, s - 2 * k), goldBurnish(x + k, y + k, x + s - k, y + s - k, O.pal.gold)));
  O.S.stroke(Z.GOLDLINE, g.deep, 0.35, 0.7).rect(x, y, s, s).rect(x + k, y + k, s - 2 * k, s - 2 * k);
  const cx = x + s / 2, cy = y + s / 2, r = s * 0.17;
  O.S.add(Z.GOLDLINE, fillPath(new Pen().circle(cx, cy, r * 1.3).d, goldRadial(cx, cy, r * 1.3, O.pal.gold)));
  O.S.add(Z.GOLDLINE, fillPath(new Pen().circle(cx, cy, r).d, sphereRadial(cx, cy, r, gem, 0.5)));
  O.S.fill(Z.TOP, '#ffffff', 0.9).circle(cx - r * 0.35, cy - r * 0.4, r * 0.22);
}

/* -------------------------------------------------------------------------- */
/* Ornament entry                                                              */
/* -------------------------------------------------------------------------- */

export const generateOrnament: Generator<OrnamentElement> = (el) => {
  const { w, h } = el;
  if (!(w > 0 && h > 0)) return [];
  const band = Math.min(Math.max(el.band, 2), Math.min(w, h) / 2);
  if (band < 1) return [];
  const p = readParams(ORNAMENT_PARAMS[el.kind] ?? [], el.params);
  // Normalise to #rrggbb so gradient-stop opacity works in every back-end.
  const src = el.palette;
  const pal: OrnamentPalette = {
    gold: mix(src.gold, src.gold, 0), ink: mix(src.ink, src.ink, 0), red: mix(src.red, src.red, 0),
    blue: mix(src.blue, src.blue, 0), green: mix(src.green, src.green, 0), ground: mix(src.ground, src.ground, 0),
  };
  const sh: ShadowSpec | null = el.shadow
    ? { dx: clamp(band * 0.035, 0.6, 3.5) * 0.8, dy: clamp(band * 0.035, 0.6, 3.5), color: mix(pal.ground, pal.ink, 0.82) }
    : null;
  const geo = bandSides(el, band);
  const O: Orn = {
    el, p, pal, r: rng(el.seed), S: new Scene(sh), band,
    sw: clamp(band * 0.012, 0.3, 0.9), ...geo, occ: new Occupancy(Math.max(2, band * 0.3)),
    perimeter: geo.sides.reduce((a, s) => a + s.len, 0),
    step: Math.max(band, 6, geo.sides.reduce((a, s) => a + s.len, 0) / 140),
  };
  if (!geo.sides.length && el.kind !== 'ruling') return [];
  const region = bandRegion(w, h, geo.inner);
  const out: Prim[] = [];
  if (p.panel) out.push(fillPath(region, pal.ground, { fillRule: 'evenodd' }));

  switch (el.kind) {
    case 'vine-border': vineBorder(O); break;
    case 'acanthus': acanthusBorder(O); break;
    case 'strewn-flowers': strewnFlowers(O); break;
    case 'pearls-and-beads': pearlsAndBeads(O); break;
    case 'shells-and-coins': shellsAndCoins(O); break;
    case 'rubric-frame': rubricFrame(O); break;
    case 'ruling': ruling(O); break;
    case 'trompe-loeil-frame': trompeFrame(O); break;
    default: vineBorder(O);
  }
  const body = O.S.emit();
  const clipped = el.kind === 'strewn-flowers' || el.kind === 'shells-and-coins' || el.kind === 'pearls-and-beads';
  if (clipped) out.push({ t: 'group', clip: region, clipRule: 'evenodd', children: body });
  else out.push(...body);
  if (p.fillets) {
    const outline = bandOutline(el, band, geo.inner).d;
    out.push({ t: 'path', d: outline, fill: null, stroke: pal.ink, strokeWidth: 1.9, opacity: 0.85, cap: 'square' });
    out.push({ t: 'path', d: outline, fill: null, stroke: goldBurnish(0, 0, w, h, pal.gold), strokeWidth: 1.2, cap: 'square' });
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* Illuminated initial frames                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_GOLD = '#c9a227';

/**
 * Background for a drop cap or initial. The host draws the letter on top.
 *  gilded  — burnished gold square, tooled (punched) dots, fine outline; with a
 *            ground colour the gold becomes a border around a painted field.
 *  vine    — painted ground with white tracery vine, gold fillet and dots.
 *  rubric  — red/blue penwork flourishes that run outside the box.
 *  box     — plain coloured square.  outline — thin double rule.
 */
export function illuminatedFrame(
  frame: DropCapFrame,
  box: { x: number; y: number; w: number; h: number },
  colors: { frame: string; ground: string | null; gold?: string },
  seed: number,
): Prim[] {
  const { x, y, w, h } = box;
  if (!(w > 0 && h > 0)) return [];
  const s = Math.min(w, h);
  const gold = colors.gold ?? DEFAULT_GOLD;
  const g = goldRamp(gold);
  const r = rng(seed);
  const ink = '#2a2118';
  const out: Prim[] = [];
  switch (frame) {
    case 'none':
      return [];
    case 'box':
      return [fillPath(rectPath(x, y, w, h), colors.ground ?? colors.frame)];
    case 'outline': {
      const lw = Math.max(0.3, s * 0.008);
      const gap = Math.max(1.4, s * 0.035);
      out.push({ t: 'path', d: rectPath(x + lw / 2, y + lw / 2, w - lw, h - lw), fill: colors.ground, stroke: colors.frame, strokeWidth: lw });
      out.push({ t: 'path', d: rectPath(x + gap, y + gap, w - 2 * gap, h - 2 * gap), fill: null, stroke: colors.frame, strokeWidth: lw * 0.7 });
      return out;
    }
    case 'gilded': {
      out.push(fillPath(rectPath(x, y, w, h), goldBurnish(x, y, x + w, y + h, gold)));
      const pr = Math.max(0.28, s * 0.009);
      const lit = new Pen(), hole = new Pen();
      const punch = (px: number, py: number) => {
        lit.circle(px + pr * 0.4, py + pr * 0.4, pr);
        hole.circle(px, py, pr);
      };
      if (colors.ground) {
        const b = s * 0.12;
        // Punched dots run along the middle of the gold border.
        const step = Math.max(pr * 4, b * 0.42);
        const ring = (px: number, py: number, len: number, dx: number, dy: number) => {
          const n = Math.max(1, Math.round(len / step));
          for (let k = 0; k <= n; k++) punch(px + (dx * len * k) / n, py + (dy * len * k) / n);
        };
        ring(x + b / 2, y + b / 2, w - b, 1, 0);
        ring(x + b / 2, y + h - b / 2, w - b, 1, 0);
        ring(x + b / 2, y + b / 2, h - b, 0, 1);
        ring(x + w - b / 2, y + b / 2, h - b, 0, 1);
        out.push(fillPath(lit.d, g.shine, { opacity: 0.85 }), fillPath(hole.d, g.deep, { opacity: 0.8 }));
        out.push(fillPath(rectPath(x + b, y + b, w - 2 * b, h - 2 * b), colors.ground));
        out.push({ t: 'path', d: rectPath(x + b, y + b, w - 2 * b, h - 2 * b), fill: null, stroke: darken(gold, 0.5), strokeWidth: Math.max(0.3, s * 0.006) });
        const ib = b + Math.max(1, s * 0.03);
        out.push({ t: 'path', d: rectPath(x + ib, y + ib, w - 2 * ib, h - 2 * ib), fill: null, stroke: WHITE, strokeWidth: Math.max(0.25, s * 0.004), opacity: 0.7 });
        // A few white trefoils in the field corners.
        const tre = new Pen();
        const dr = Math.max(0.35, s * 0.012);
        for (const [cx, cy, a] of [[x + ib + s * 0.07, y + ib + s * 0.07, 45], [x + w - ib - s * 0.07, y + ib + s * 0.07, 135], [x + w - ib - s * 0.07, y + h - ib - s * 0.07, 225], [x + ib + s * 0.07, y + h - ib - s * 0.07, 315]] as [number, number, number][]) {
          for (let k = 0; k < 3; k++) {
            const b2 = (a + 180 + (k - 1) * 40) * DEG;
            tre.circle(cx + Math.cos(b2) * dr * 2.2, cy + Math.sin(b2) * dr * 2.2, dr);
          }
        }
        out.push(fillPath(tre.d, WHITE, { opacity: 0.85 }));
      } else {
        // Tooled diaper of punched dots on a 45° lattice, plus a punched border.
        const step = s / 8;
        const m = s * 0.06;
        for (let j = 0; j * step <= h; j++) {
          for (let i = 0; i * step <= w; i++) {
            const px = x + i * step + (j % 2 ? step / 2 : 0), py = y + j * step;
            if (px > x + m * 1.8 && px < x + w - m * 1.8 && py > y + m * 1.8 && py < y + h - m * 1.8) punch(px, py);
          }
        }
        const bstep = Math.max(pr * 3.5, s * 0.045);
        for (let t = m; t <= w - m + 0.01; t += (w - 2 * m) / Math.max(1, Math.round((w - 2 * m) / bstep))) {
          punch(x + t, y + m);
          punch(x + t, y + h - m);
        }
        for (let t = m; t <= h - m + 0.01; t += (h - 2 * m) / Math.max(1, Math.round((h - 2 * m) / bstep))) {
          punch(x + m, y + t);
          punch(x + w - m, y + t);
        }
        out.push(fillPath(lit.d, g.shine, { opacity: 0.85 }), fillPath(hole.d, g.deep, { opacity: 0.8 }));
      }
      out.push({ t: 'path', d: rectPath(x, y, w, h), fill: null, stroke: ink, strokeWidth: Math.max(0.3, s * 0.006) });
      return out;
    }
    case 'vine': {
      const ground = colors.ground ?? colors.frame;
      const b = Math.max(1.2, s * 0.05);
      out.push(fillPath(rectPath(x, y, w, h), goldBurnish(x, y, x + w, y + h, gold)));
      out.push(fillPath(rectPath(x + b, y + b, w - 2 * b, h - 2 * b), ground));
      // White tracery: mirrored spiralling tendrils with trefoils (Flemish "white vine").
      const iw = w - 2 * b, ih = h - 2 * b;
      const lw = Math.max(0.25, s * 0.007);
      const vine = new Pen();
      const dots = new Pen();
      const golds: Pt[] = [];
      const curl = range(r, 5.4, 6.2);
      // One quadrant: a spiral winding into the corner, a counter-curl from the top edge.
      const quarter: Pt[][] = [
        tendril(0.07, 0.5, -Math.PI / 2, 0.62, curl, 30, 2.1),
        tendril(0.47, 0.07, Math.PI, 0.16, -3.6, 12, 1.4),
      ];
      const buds: Pt[] = [quarter[0][9], quarter[0][19], quarter[1][8]];
      const mirror = (pts: Pt[], mx: boolean, my: boolean): Pt[] =>
        pts.map(([u, v]) => [x + b + (mx ? 1 - u : u) * iw, y + b + (my ? 1 - v : v) * ih]);
      for (const mx of [false, true]) {
        for (const my of [false, true]) {
          for (const q of quarter) vine.smooth(mirror(q, mx, my));
          for (const [u, v] of mirror(buds, mx, my)) {
            const dr = Math.max(0.3, s * 0.011);
            const a = Math.atan2(v - (y + h / 2), u - (x + w / 2));
            for (let k = 0; k < 3; k++) {
              const c = a + (k - 1) * 0.75;
              dots.circle(u + Math.cos(c) * dr * 2.3, v + Math.sin(c) * dr * 2.3, dr);
            }
          }
          const [qx, qy] = mirror([quarter[0][quarter[0].length - 1]], mx, my)[0];
          golds.push([qx, qy]);
        }
      }
      out.push({ t: 'path', d: vine.d, fill: null, stroke: WHITE, strokeWidth: lw, cap: 'round', join: 'round', opacity: 0.92 });
      out.push(fillPath(dots.d, WHITE, { opacity: 0.92 }));
      const gr = Math.max(0.6, s * 0.022);
      for (const [gx, gy] of [...golds, [x + w / 2, y + b + ih * 0.035] as Pt, [x + w / 2, y + h - b - ih * 0.035] as Pt]) {
        out.push(fillPath(new Pen().circle(gx, gy, gr).d, goldRadial(gx, gy, gr, gold)));
      }
      out.push({ t: 'path', d: rectPath(x + b, y + b, w - 2 * b, h - 2 * b), fill: null, stroke: darken(gold, 0.45), strokeWidth: Math.max(0.25, s * 0.005) });
      out.push({ t: 'path', d: rectPath(x, y, w, h), fill: null, stroke: ink, strokeWidth: Math.max(0.3, s * 0.006) });
      return out;
    }
    case 'rubric': {
      const c1 = colors.frame;
      const rgb = parseColor(c1);
      const c2 = rgb.r > rgb.b ? '#2b4a8f' : '#b0331f';
      const lw = Math.max(0.25, s * 0.0075);
      if (colors.ground) out.push(fillPath(rectPath(x, y, w, h), colors.ground));
      const a = new Pen(), bpen = new Pen();
      const off = Math.max(1.2, s * 0.035);
      // Echo outlines.
      a.rect(x, y, w, h);
      bpen.rect(x - off, y - off, w + 2 * off, h + 2 * off);
      // Beading along the outer echo line.
      const br = Math.max(0.5, s * 0.016);
      const beadStep = br * 4.2;
      for (let t = beadStep / 2; t < w + 2 * off; t += beadStep) {
        bpen.circle(x - off + t, y - off - br, br);
        bpen.circle(x - off + t, y + h + off + br, br);
      }
      for (let t = beadStep / 2; t < h + 2 * off; t += beadStep) bpen.circle(x + w + off + br, y - off + t, br);
      // The long tail down the margin, with alternating curls.
      const tailLen = h * range(r, 1.1, 1.5);
      const tx = x - off - br * 2.5;
      a.move(tx, y - off).line(tx, y + h + tailLen);
      bpen.move(tx - lw * 3, y + h * 0.2).line(tx - lw * 3, y + h + tailLen * 0.85);
      const curls = Math.max(3, Math.round(tailLen / (s * 0.22)));
      for (let k = 0; k < curls; k++) {
        const ty = y + h + (tailLen * (k + 0.6)) / curls;
        const side = k % 2 ? 1 : -1;
        const pts = tendril(tx, ty, side > 0 ? -0.6 : Math.PI + 0.6, s * 0.2, side * 4.3, 16);
        (k % 2 ? a : bpen).smooth(pts);
        const [ex, ey] = pts[pts.length - 1];
        bpen.circle(ex, ey, br * 0.8);
      }
      // Top flourishes: curls springing from the top-left corner and along the top.
      for (let k = 0; k < 3; k++) {
        const sx = x + (w * (k + 0.5)) / 3;
        const pts = tendril(sx, y - off - br * 2, -Math.PI / 2 + (k - 1) * 0.5, s * 0.22, (k % 2 ? -1 : 1) * 4.2, 16);
        (k % 2 ? bpen : a).smooth(pts);
      }
      // Feathering along the right edge.
      for (let t = 0; t < h; t += Math.max(1, s * 0.03)) a.move(x + w + off, y + t).line(x + w + off + s * 0.06, y + t);
      out.push({ t: 'path', d: a.d, fill: null, stroke: c1, strokeWidth: lw, cap: 'round', join: 'round' });
      out.push({ t: 'path', d: bpen.d, fill: null, stroke: c2, strokeWidth: lw, cap: 'round', join: 'round' });
      return out;
    }
    default:
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Initial element                                                             */
/* -------------------------------------------------------------------------- */

export const generateInitial: Generator<InitialElement> = (el, ctx) => {
  const { w, h } = el;
  if (!(w > 0 && h > 0)) return [];
  const out = illuminatedFrame(el.frame, { x: 0, y: 0, w, h }, { frame: el.frameColor, ground: el.ground }, el.seed);
  const letter = Array.from((el.letter || '').trim())[0];
  if (!letter) return out;
  const font = ctx.font(el.fontFamily, el.weight);
  const m = ctx.metrics(font);
  const cap = m.capHeight > 0.2 && m.capHeight < 1.2 ? m.capHeight : 0.7;
  const s = Math.min(w, h);
  const pad = el.frame === 'none' || el.frame === 'rubric' ? s * 0.06
    : el.frame === 'gilded' && el.ground ? s * 0.2
      : el.frame === 'vine' ? s * 0.17 : s * 0.15;
  let size = (h - 2 * pad) / cap;
  let adv = ctx.measure(letter, font, size);
  const maxW = w - 2 * pad;
  if (adv > maxW && adv > 0) {
    size *= maxW / adv;
    adv = ctx.measure(letter, font, size);
  }
  // Centre the cap height; lift a touch toward the optical centre.
  const baseline = h / 2 + (cap * size) / 2 - h * 0.012;
  const run: TextRun = { x: (w - adv) / 2, y: baseline, text: letter, font, size, color: el.color, width: adv };
  // On a gilded field a faint dark offset keeps a light letter legible, as painted initials do.
  const lightOnGold = el.frame === 'gilded' && !el.ground && luminance(el.color) > 0.45;
  if (lightOnGold) out.push({ t: 'text', runs: [{ ...run, x: run.x + size * 0.012, y: run.y + size * 0.012, color: '#2a2118' }], opacity: 0.45 });
  out.push({ t: 'text', runs: [run] });
  return out;
};
