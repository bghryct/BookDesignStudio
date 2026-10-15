/**
 * Physical layout of the 3D book, derived from the BookSpec and `computeBinding()`.
 *
 * Everything here is in PostScript points in the book's own "a-space":
 *   a — across the book, 0 at the spine side of the text block, + toward the fore-edge
 *   y — up, 0 on the ground (the back cover lies on the ground, the front cover on top)
 *   z — head to tail, head at −coverH/2
 * The scene graph scales a-space by SCENE_UNITS_PER_PT and mirrors it in x for
 * right-to-left books, so geometry is always built as if the book bound on the left.
 */
import type { BindingType } from '../model/types';
import type { BindingCalc, Panel } from '../engine/binding';
import { mm } from '../model/units';
import type { BookSceneInput } from './types';

/** Scene units per PostScript point (1 scene unit = 10 mm). */
export const SCENE_UNITS_PER_PT = 1 / mm(10);
/** Leaves modelled as separate, turnable meshes. */
export const MAX_TURN_LEAVES = 12;
/** Length (pt) of one repeat of the page-edge texture along an edge. */
export const EDGE_TILE = mm(20);

export type Family = 'case' | 'coptic' | 'soft';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Maps points on the physical covering to UVs of the flat cover canvas. */
export class CoverMapper {
  readonly totalW: number;
  readonly totalH: number;
  readonly wrap: number;
  readonly coverW: number;
  readonly coverH: number;
  readonly rtl: boolean;
  private readonly ltr = new Map<Panel['id'], { x: number; w: number }>();

  constructor(calc: BindingCalc, rtl: boolean) {
    this.rtl = rtl;
    this.wrap = calc.wrap;
    this.coverW = calc.coverW;
    this.coverH = calc.coverH;
    this.totalW = Math.max(1, calc.coverW + 2 * calc.wrap);
    this.totalH = Math.max(1, calc.coverH + 2 * calc.wrap);
    // Panels are stored un-mirrored (as for a left-bound book); `u()` mirrors back for RTL.
    for (const p of calc.panels) this.ltr.set(p.id, { x: rtl ? calc.coverW - p.x - p.w : p.x, w: p.w });
  }

  has(id: Panel['id']): boolean {
    return this.ltr.has(id);
  }

  /** Panel position on a left-bound cover (pt). */
  panel(id: Panel['id']): { x: number; w: number } {
    return this.ltr.get(id) ?? { x: 0, w: 0 };
  }

  /** U for a cover-surface x given in left-bound coordinates. */
  u(xLtr: number): number {
    const x = this.rtl ? this.coverW - xLtr : xLtr;
    return (x + this.wrap) / this.totalW;
  }

  /** V for a cover-surface y measured from the head edge of the cover (canvas is flipY). */
  v(y: number): number {
    return 1 - (y + this.wrap) / this.totalH;
  }
}

export interface DroopProfile {
  /** Horizontal-ish run of the drop, pt of arc length. */
  D: number;
  /** Peak extra bend, radians. */
  beta: number;
}

export interface BookLayout {
  family: Family;
  type: BindingType;
  rtl: boolean;
  W: number;
  H: number;
  /** Text-block thickness (paper + swell). */
  T: number;
  /** Thickness of one leaf. */
  c: number;
  leaves: number;
  nTurn: number;
  sections: number;
  /** Closed thickness of the whole book. */
  thick: number;
  tbY0: number;
  tbY1: number;
  /** a of the spine side / fore-edge of the text block at height y. */
  spineA: (y: number) => number;
  foreA: (y: number) => number;
  coverH: number;
  /** z of the head edge of the covering. */
  zHead: number;
  // Boards (case & coptic)
  bt: number;
  boardW: number;
  boardH: number;
  boardA0: number;
  pivotA: number;
  pivotY: number;
  /** Extra rotation past 180° that lets an opened board rest on the ground. */
  tilt: number;
  // Case spine
  off: number;
  spTh: number;
  rd: number;
  arcR: number;
  arcAc: number;
  hingeDepth: number;
  bandH: number;
  bandW: number;
  // Soft covers
  cc: number;
  flap: number;
  creaseM: number;
  creaseR: number;
  centerY: number;
  droop: DroopProfile;
  // Threads
  threadR: number;
  cover: CoverMapper;
  /** Closed extents in a. */
  a0: number;
  a1: number;
}

/** Cubic Bézier length (numeric). */
export function bezierLength(p: number[][]): number {
  let len = 0;
  let pa = p[0][0], py = p[0][1];
  for (let i = 1; i <= 32; i++) {
    const t = i / 32, u = 1 - t;
    const a = u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0];
    const y = u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1];
    len += Math.hypot(a - pa, y - py);
    pa = a; py = y;
  }
  return len;
}

/** Solve the drop profile β·sin²(πu/D) so the integrated fall equals h. */
export function solveDroop(h: number, maxLen: number): DroopProfile {
  if (h <= 0.05 || maxLen <= 1) return { D: 1, beta: 0 };
  const D = clamp(3 * h, Math.min(mm(12), maxLen), maxLen);
  const drop = (beta: number) => {
    let sum = 0;
    const n = 64;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const s = Math.sin(Math.PI * u);
      sum += Math.sin(beta * s * s);
    }
    return (sum * D) / n;
  };
  let lo = 0, hi = 1.45;
  if (drop(hi) < h) return { D, beta: hi };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (drop(mid) < h) lo = mid; else hi = mid;
  }
  return { D, beta: (lo + hi) / 2 };
}

export function droopAngle(p: DroopProfile, u: number): number {
  if (p.beta <= 0 || u <= 0 || u >= p.D) return 0;
  const s = Math.sin((Math.PI * u) / p.D);
  return p.beta * s * s;
}

/** Board rotation beyond 180° at which the board's far outer corner touches the ground. */
function restTilt(pivotY: number, reach: number, bt: number): number {
  const len = Math.hypot(reach, bt);
  if (len <= 0) return 0;
  const k = clamp(pivotY / len, 0, 1);
  return Math.max(0, Math.asin(k) - Math.atan2(bt, reach));
}

export function computeLayout(input: BookSceneInput): BookLayout {
  const { spec, calc } = input;
  const b = spec.binding;
  const type = b.type;
  const family: Family = type === 'case' ? 'case' : type === 'coptic' ? 'coptic' : 'soft';
  const rtl = spec.direction === 'rtl';
  const W = Math.max(spec.trimW, mm(20));
  const H = Math.max(spec.trimH, mm(20));
  const T = Math.max(calc.textBlock, mm(0.2));
  const leaves = Math.max(1, Math.round(calc.leaves));
  const fukuro = type === 'stab' && b.fukuroToji;
  const c = clamp(calc.caliper * (fukuro ? 2 : 1), 0.02, T / leaves);
  const nTurn = Math.max(0, Math.min(MAX_TURN_LEAVES, leaves - 1));
  const cover = new CoverMapper(calc, rtl);
  // Stab bindings are sewn with a heavy silk cord, coptic with linen thread.
  const threadR = Math.max(b.threadDiameter, type === 'stab' ? mm(0.8) : mm(0.4)) / 2;

  const L: BookLayout = {
    family, type, rtl, W, H, T, c, leaves, nTurn,
    sections: Math.max(1, calc.sections),
    thick: T, tbY0: 0, tbY1: T,
    spineA: () => 0, foreA: () => W,
    coverH: calc.coverH, zHead: -calc.coverH / 2,
    bt: 0, boardW: W, boardH: H, boardA0: 0, pivotA: 0, pivotY: T, tilt: 0,
    off: 0, spTh: 0, rd: 0, arcR: 0, arcAc: 0, hingeDepth: 0, bandH: 0, bandW: mm(4.5),
    cc: 0, flap: 0, creaseM: 0, creaseR: 0, centerY: 0, droop: { D: 1, beta: 0 },
    threadR, cover, a0: 0, a1: W,
  };

  if (family === 'case') {
    const bt = Math.max(b.boardThickness, mm(0.8));
    const thick = T + 2 * bt;
    const spTh = clamp(bt * 0.4, mm(0.5), mm(1.2));
    const off = spTh + mm(0.3);
    const rd = Math.min(Math.max(0, calc.roundDepth), thick / 2);
    let R = 0, ac = 0;
    if (rd > 1e-3) {
      R = (thick * thick) / (8 * rd) + rd / 2;
      ac = R - rd;
    }
    const m = thick / 2;
    // Outward bulge of the spine arc at height y.
    const dcov = (y: number) => (rd > 1e-3 ? Math.sqrt(Math.max(0, R * R - (y - m) * (y - m))) - ac : 0);
    const d0 = dcov(bt);
    // The text block's back follows the same circle as the covering (rounded & backed),
    // and its fore-edge carries the matching concave round.
    L.spineA = (y) => off - Math.max(0, dcov(y) - d0);
    L.foreA = (y) => off - Math.max(0, dcov(y) - d0) + W;
    L.bt = bt;
    L.thick = thick;
    L.tbY0 = bt;
    L.tbY1 = bt + T;
    L.boardW = calc.boardW;
    L.boardH = calc.boardH;
    L.boardA0 = Math.max(off, off + W + b.squares - calc.boardW);
    L.off = off;
    L.spTh = spTh;
    L.rd = rd;
    L.arcR = R;
    L.arcAc = ac;
    L.pivotA = off;
    L.pivotY = bt + T;
    L.tilt = restTilt(L.pivotY, L.boardA0 + L.boardW - L.pivotA, bt);
    L.bandH = b.raisedBands > 0 ? Math.min(mm(1.8), bt * 0.85) : 0;
    // French groove: depth chosen so the joint cloth is as long as the hinge panel.
    const A0 = L.boardA0;
    const target = Math.max(b.hingeGap, A0);
    const len = (d: number) => bezierLength([[0, 0], [0.3 * A0, -d], [0.7 * A0, -d], [A0, 0]]);
    let lo = 0, hi = bt * 0.92;
    if (len(hi) <= target) lo = hi;
    else for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (len(mid) < target) lo = mid; else hi = mid;
    }
    L.hingeDepth = Math.max(bt * 0.3, lo);
    L.a0 = -(rd + L.bandH + spTh * 0.2);
    L.a1 = L.boardA0 + L.boardW;
  } else if (family === 'coptic') {
    const bt = Math.max(b.boardThickness, mm(0.8));
    const thick = T + 2 * bt;
    const S = L.sections;
    const ts = T / S;
    const r = Math.min(ts * 0.42, mm(2.5));
    L.bt = bt;
    L.thick = thick;
    L.tbY0 = bt;
    L.tbY1 = bt + T;
    // Each sewn section shows its rounded fold on the exposed spine.
    L.spineA = (y) => {
      const k = clamp(Math.floor((y - bt) / ts), 0, S - 1);
      const yc = bt + (k + 0.5) * ts;
      const q = (y - yc) / (ts / 2);
      return -r * Math.sqrt(Math.max(0, 1 - q * q * q * q));
    };
    L.foreA = () => W;
    L.boardW = calc.boardW;
    L.boardH = calc.boardH;
    L.boardA0 = 0;
    L.pivotA = 0;
    L.pivotY = bt + T;
    L.tilt = restTilt(L.pivotY, L.boardW, bt);
    L.a0 = -(r + threadR * 2.5);
    L.a1 = L.boardW;
  } else {
    const cc = Math.max(b.coverCaliper, 0.15);
    const thick = T + 2 * cc;
    L.cc = cc;
    L.thick = thick;
    L.tbY0 = cc;
    L.tbY1 = cc + T;
    L.flap = type === 'stab' ? 0 : clamp(spec.cover.flapWidth, 0, W - mm(5));
    if (!cover.has('front-flap')) L.flap = 0;
    if (type === 'stab') {
      L.creaseM = clamp(b.stabMargin, mm(3), W / 3);
      L.creaseR = mm(3);
      L.centerY = thick - cc / 2 + L.creaseR;
      const h = L.centerY + L.creaseR - cc / 2;
      L.droop = solveDroop(h, 0.6 * Math.max(mm(10), W - 2 * L.creaseM - Math.PI * L.creaseR - cc));
    } else {
      L.droop = solveDroop(thick - cc, 0.6 * W);
    }
    L.a0 = -cc - (type === 'stab' ? threadR * 2 : 0);
    L.a1 = W + (L.flap > 0 ? cc : 0);
  }
  return L;
}
