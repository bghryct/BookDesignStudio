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
import { JACKET_GAP, JACKET_THICKNESS } from './jacket';
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
  /**
   * Room kept free between each closed cover and the text block for what tucks in there
   * (pastedown and endpaper hinge on boards, soft-cover French flaps, dust-jacket flaps), pt.
   */
  clr: number;
  // Boards (case & coptic)
  bt: number;
  boardW: number;
  boardH: number;
  boardA0: number;
  /**
   * Front-board hinge, on the board's mid-plane: the opened board's inner face lies level with
   * the top of the spine, and its spine edge clears the spine (rounded back, coptic chains).
   */
  pivotA: number;
  pivotY: number;
  /** Extra rotation past 180° that lets an opened board rest on the ground. */
  tilt: number;
  /** a where turned leaves start their gutter bend. */
  creaseA: number;
  // Case spine
  off: number;
  spTh: number;
  rd: number;
  arcR: number;
  arcAc: number;
  hingeDepth: number;
  /** The spine lining keeps this far from the top and bottom (clear of the joint cloth), pt. */
  liningClip: number;
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

/**
 * Board rotation beyond 180° at which the board's far outer corner touches the ground, for a
 * hinge at height `pivotY`, `reach` from that corner along the board and `h` below its outer face.
 */
function restTilt(pivotY: number, reach: number, h: number): number {
  const len = Math.hypot(reach, h);
  if (len <= 0) return 0;
  const k = clamp(pivotY / len, 0, 1);
  return Math.max(0, Math.asin(k) - Math.atan2(h, reach));
}

type P2 = [number, number];

/**
 * Rest tilt of the opened front board: it settles until its far edge reaches the ground, which
 * lies `lift` below a-space y = 0 (a jacket or thread under the book). A jacket (`jt` thick
 * with its gap) adds a half-round of radius bt/2 + jt round the board's fore-edge, which is
 * what then touches the ground.
 */
function openBoardTilt(L: Pick<BookLayout, 'pivotY' | 'pivotA' | 'boardA0' | 'boardW' | 'bt'>, lift: number, jt: number): number {
  const reach = L.boardA0 + L.boardW - L.pivotA;
  let t = restTilt(L.pivotY + lift, reach, L.bt / 2);
  if (jt > 0 && reach > 0) t = Math.min(t, Math.asin(clamp((L.pivotY + lift - L.bt / 2 - jt) / reach, 0, 1)));
  return Math.max(0, t);
}

/**
 * Raised bands fade out toward the joints (f = 0 back joint … 1 front joint across the spine),
 * so the spine meets the boards flush.
 */
export function bandTaper(f: number): number {
  const e = (x: number) => {
    const t = clamp(x / 0.14, 0, 1);
    return t * t * (3 - 2 * t);
  };
  return e(f) * e(1 - f);
}

/** Outer surface of the case spine (raised bands included) at f across the spine, a-space. */
export function spineOuter(L: Pick<BookLayout, 'rd' | 'arcR' | 'arcAc' | 'thick' | 'bandH'>, f: number, band = 1): { p: P2; n: P2 } {
  const thick = L.thick;
  let p: P2, n: P2;
  if (L.rd > 1e-3) {
    const R = L.arcR, ac = L.arcAc;
    const psi0 = Math.asin(Math.min(1, thick / 2 / R));
    const psi = -psi0 + 2 * psi0 * f;
    p = [ac - R * Math.cos(psi), thick / 2 + R * Math.sin(psi)];
    n = [-Math.cos(psi), Math.sin(psi)];
  } else {
    p = [0, thick * f];
    n = [-1, 0];
  }
  const h = L.bandH * bandTaper(f) * band;
  return { p: [p[0] + n[0] * h, p[1] + n[1] * h], n };
}

function insidePoly(poly: P2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Largest hinge position a (on the board's mid-plane) at which the front board, swinging from
 * closed to resting open, never comes within `margin` of the `obstacles` (a-space polygons on
 * the spine side).
 */
function clearPivotA(start: number, py: number, A0: number, A1: number, bt: number, thick: number, obstacles: P2[][], margin: number): number {
  const step = mm(0.1);
  for (let pa = start; pa > start - thick - mm(20); pa -= step) {
    const tilt = restTilt(py, A1 - pa, bt / 2);
    let hit = false;
    for (let i = 0; i <= 64 && !hit; i++) {
      const th = ((Math.PI + tilt) * i) / 64;
      const c = Math.cos(th), s = Math.sin(th);
      // Obstacle points in the board frame (u along the board, v across, 0 on the mid-plane).
      for (const [a, y] of obstacles.flat()) {
        const da = a - pa, dy = y - py;
        const u = c * da + s * dy, v = -s * da + c * dy;
        if (u > A0 - pa - margin && u < A1 - pa + margin && Math.abs(v) < bt / 2 + margin) { hit = true; break; }
      }
      if (hit) break;
      // Board corners (and edge midpoints) inside the obstacle.
      for (const [u, v] of [[A0 - pa, -bt / 2], [A0 - pa, bt / 2], [A0 - pa, 0], [(A0 + A1) / 2 - pa, bt / 2], [(A0 + A1) / 2 - pa, -bt / 2]] as P2[]) {
        for (const [du, dv] of [[-margin, -margin], [-margin, margin], [margin, -margin], [margin, margin], [0, 0]] as P2[]) {
          const uu = u + du, vv = v + dv;
          const qa = pa + c * uu - s * vv, qy = py + s * uu + c * vv;
          if (obstacles.some((o) => insidePoly(o, qa, qy))) { hit = true; break; }
        }
        if (hit) break;
      }
    }
    if (!hit) return pa;
  }
  return start - thick - mm(20);
}

export function computeLayout(input: BookSceneInput): BookLayout {
  const { spec, calc } = input;
  const b = spec.binding;
  const type = b.type;
  const family: Family = type === 'case' ? 'case' : type === 'coptic' ? 'coptic' : 'soft';
  const rtl = spec.direction === 'rtl';
  const W = Math.max(spec.trimW, mm(20));
  const H = Math.max(spec.trimH, mm(20));
  const T0 = Math.max(calc.textBlock, mm(0.2));
  const leaves = Math.max(1, Math.round(calc.leaves));
  const fukuro = type === 'stab' && b.fukuroToji;
  const nTurn = Math.max(0, Math.min(MAX_TURN_LEAVES, leaves - 1));
  const cover = new CoverMapper(calc, rtl);
  // Stab bindings are sewn with a heavy silk cord, coptic with linen thread.
  const threadR = Math.max(b.threadDiameter, type === 'stab' ? mm(0.8) : mm(0.4)) / 2;
  // What tucks in under each closed cover: dust-jacket flaps (and French flaps, below). The
  // text block yields that room (it is compressible); a block too thin to give it up grows.
  const softFlap = family === 'soft' && type !== 'stab' && cover.has('front-flap') ? clamp(spec.cover.flapWidth, 0, W - mm(5)) : 0;
  const cc0 = Math.max(b.coverCaliper, 0.15);
  // Boards always keep a hair for the pastedown and endpaper hinge.
  const clr = (input.jacket ? JACKET_GAP + JACKET_THICKNESS + mm(0.05) : 0) + (softFlap > 0 ? cc0 + mm(0.03) : 0) + (family === 'soft' ? 0 : mm(0.15));
  const T = Math.max(T0 - 2 * clr, Math.min(T0, T0 * 0.6));
  /** Closed book thickness for a given cover / board thickness. */
  const closed = (shell: number) => Math.max(T0, T + 2 * clr) + 2 * shell;
  const c = clamp(calc.caliper * (fukuro ? 2 : 1), 0.02, T / leaves);

  const L: BookLayout = {
    family, type, rtl, W, H, T, c, leaves, nTurn,
    sections: Math.max(1, calc.sections),
    thick: T, tbY0: 0, tbY1: T,
    spineA: () => 0, foreA: () => W,
    coverH: calc.coverH, zHead: -calc.coverH / 2,
    clr,
    bt: 0, boardW: W, boardH: H, boardA0: 0, pivotA: 0, pivotY: T, tilt: 0, creaseA: 0,
    off: 0, spTh: 0, rd: 0, arcR: 0, arcAc: 0, hingeDepth: 0, liningClip: 0, bandH: 0, bandW: mm(4.5),
    cc: 0, flap: 0, creaseM: 0, creaseR: 0, centerY: 0, droop: { D: 1, beta: 0 },
    threadR, cover, a0: 0, a1: W,
  };

  if (family === 'case') {
    const bt = Math.max(b.boardThickness, mm(0.8));
    const thick = closed(bt);
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
    L.tbY0 = thick / 2 - T / 2;
    L.tbY1 = thick / 2 + T / 2;
    L.boardW = calc.boardW;
    L.boardH = calc.boardH;
    L.boardA0 = Math.max(off, off + W + b.squares - calc.boardW);
    L.off = off;
    L.spTh = spTh;
    L.rd = rd;
    L.arcR = R;
    L.arcAc = ac;
    L.creaseA = off;
    // The spine covering (raised bands included), which the opening board must clear, and the
    // wedge under the tangent at its top: with the board's spine edge beyond that tangent, the
    // joint cloth and the jacket can run straight from the spine to the opened board.
    L.bandH = b.raisedBands > 0 ? Math.min(mm(1.8), bt * 0.85) : 0;
    const outer: P2[] = [];
    const lining: P2[] = [];
    for (let i = 0; i <= 32; i++) {
      const { p, n } = spineOuter(L, i / 32);
      outer.push(p);
      const q = spineOuter(L, i / 32, 0).p;
      lining.push([q[0] - n[0] * spTh, q[1] - n[1] * spTh]);
    }
    // Steepest line from the top edge that still touches the outline (bands ramp up near it).
    const D = Math.min(thick / 2, 4 * bt + mm(5));
    let tan = 0;
    for (const q of outer) if (q[1] < thick - 1e-6 && q[1] >= thick - D) tan = Math.max(tan, -q[0] / (thick - q[1]));
    tan *= 1.05;
    const wedge: P2[] = [[0, thick], [-D * tan, thick - D], [0, thick - D]];
    L.pivotY = thick - bt / 2;
    L.pivotA = clearPivotA(off, L.pivotY, L.boardA0, L.boardA0 + L.boardW, bt, thick, [[...outer, ...lining.reverse()], wedge], mm(0.35));
    const jt = input.jacket ? JACKET_GAP + JACKET_THICKNESS : 0;
    L.tilt = openBoardTilt(L, jt, jt);
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
    // …but never so deep that the cloth (0.35 mm) dips below the board into the text block.
    L.hingeDepth = Math.min(Math.max(bt * 0.3, lo), Math.max(bt * 0.1, (bt - mm(0.45)) / 0.75));
    L.liningClip = Math.min(bt, 0.75 * L.hingeDepth + mm(0.45));
    L.a0 = -(rd + L.bandH + spTh * 0.2);
    L.a1 = L.boardA0 + L.boardW;
  } else if (family === 'coptic') {
    const bt = Math.max(b.boardThickness, mm(0.8));
    const thick = closed(bt);
    const S = L.sections;
    const ts = T / S;
    const r = Math.min(ts * 0.42, mm(2.5));
    L.bt = bt;
    L.thick = thick;
    L.tbY0 = thick / 2 - T / 2;
    L.tbY1 = thick / 2 + T / 2;
    const y0 = L.tbY0;
    // Each sewn section shows its rounded fold on the exposed spine.
    L.spineA = (y) => {
      const k = clamp(Math.floor((y - y0) / ts), 0, S - 1);
      const yc = y0 + (k + 0.5) * ts;
      const q = (y - yc) / (ts / 2);
      return -r * Math.sqrt(Math.max(0, 1 - q * q * q * q));
    };
    L.foreA = () => W;
    L.boardW = calc.boardW;
    L.boardH = calc.boardH;
    L.boardA0 = 0;
    // The boards hinge on the link stitches at their spine edge: the opened board's edge
    // lands just outside the section folds and chains.
    L.pivotY = thick - bt / 2;
    L.pivotA = -(r + 2 * threadR + mm(0.3)) / 2;
    const jt = input.jacket ? JACKET_GAP + JACKET_THICKNESS : 0;
    L.tilt = openBoardTilt(L, Math.max(jt, 2 * threadR), jt);
    L.a0 = -(r + threadR * 2.5);
    L.a1 = L.boardW;
  } else {
    const cc = cc0;
    const thick = closed(cc);
    L.cc = cc;
    L.thick = thick;
    L.tbY0 = thick / 2 - T / 2;
    L.tbY1 = thick / 2 + T / 2;
    L.flap = softFlap;
    if (type === 'stab') {
      L.creaseM = clamp(b.stabMargin, mm(3), W / 3);
      L.creaseR = mm(3);
      L.centerY = thick - cc / 2 + L.creaseR;
      L.creaseA = L.creaseM;
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
