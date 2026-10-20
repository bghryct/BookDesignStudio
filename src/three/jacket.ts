/**
 * Dust jacket: one thin printed sheet. Its middle follows the outside of the covering (back
 * board, joints, spine, front board — or the soft cover), offset by a hair; at each fore-edge it
 * folds round the board (or cover) and the flap tucks inside against the pastedown. The base
 * curve is re-read from the book on every pose, so the jacket opens with the front board.
 */
import { Mesh, type Material } from 'three';
import type { JacketCalc, JacketPanel } from '../engine/binding';
import { mm } from '../model/units';
import { SheetMesh, linspace, type UV } from './sheet';

export interface JacketBase {
  /** Base samples along the outside of the covering, back fore-edge → front fore-edge. */
  count: number;
  /** Left-bound jacket x (pt) of each base sample (spine panel = joints + spine). */
  x: Float64Array;
  /** Thickness the fore-edge folds wrap: board thickness, or the soft-cover caliper. */
  wrapT: number;
  /** Write the current (a, y) of every base sample into out[2i], out[2i+1]. */
  fill(out: Float64Array): void;
  /**
   * Optional: nudge the posed mid-surface (a, y pairs, `count` samples) clear of the book where
   * a joint pinches it (the opening board's spine edge, the joint cloth, the spine's top edge).
   */
  constrain?(mid: Float64Array, count: number, half: number): void;
}

/** Jacket panel position on a left-bound jacket (pt). */
export function jacketPanel(jc: JacketCalc, rtl: boolean, id: JacketPanel['id']): { x: number; w: number } {
  const p = jc.panels.find((q) => q.id === id) ?? { x: 0, w: 0 };
  return { x: rtl ? jc.width - p.x - p.w : p.x, w: p.w };
}

/**
 * Remove small self-intersection loops from a polyline (a, y pairs) in place: when segment i
 * crosses a segment up to a few samples later, the samples in between collapse onto the crossing.
 */
export function untangle(p: Float64Array, n: number, reach = 14): void {
  for (let i = 0; i < n - 3; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * i + 2], by = p[2 * i + 3];
    for (let j = Math.min(n - 2, i + reach); j >= i + 2; j--) {
      const cx = p[2 * j], cy = p[2 * j + 1], dx = p[2 * j + 2], dy = p[2 * j + 3];
      const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t > 0 && t < 1 && u > 0 && u < 1) {
        const qx = ax + rx * t, qy = ay + ry * t;
        for (let k = i + 1; k <= j; k++) { p[2 * k] = qx; p[2 * k + 1] = qy; }
        i = j - 1;
        break;
      }
    }
  }
}

const FOLD_N = 12;
const FLAP_N = 6;
export const JACKET_THICKNESS = mm(0.12);
/** Air between the covering and the jacket. */
export const JACKET_GAP = mm(0.15);

export class JacketRig {
  readonly mesh: Mesh;
  readonly sheet: SheetMesh;
  private readonly base: JacketBase;
  private readonly baseBuf: Float64Array;
  private readonly flapW: number;
  private readonly height: number;

  constructor(jc: JacketCalc, rtl: boolean, base: JacketBase, materials: Material[]) {
    this.base = base;
    this.baseBuf = new Float64Array(base.count * 2);
    this.flapW = Math.max(0, jc.flapW);
    this.height = jc.height;
    const panel = (id: JacketPanel['id']) => jacketPanel(jc, rtl, id);
    const BF = panel('back-flap'), BFo = panel('back-fold'), FFo = panel('front-fold'), FF = panel('front-flap');
    // X (left-bound) for every sample: flap | fold | base | fold | flap.
    const X: number[] = [];
    for (let i = 0; i < FLAP_N; i++) X.push(BF.x + (BF.w * i) / FLAP_N);
    for (let i = 0; i < FOLD_N; i++) X.push(BFo.x + (BFo.w * i) / FOLD_N);
    for (let i = 0; i < base.count; i++) X.push(base.x[i]);
    for (let i = 1; i <= FOLD_N; i++) X.push(FFo.x + (FFo.w * i) / FOLD_N);
    for (let i = 1; i <= FLAP_N; i++) X.push(FF.x + (FF.w * i) / FLAP_N);
    const total = jc.width + 2 * jc.bleed;
    const totalH = jc.height + 2 * jc.bleed;
    const u = (x: number) => ((rtl ? jc.width - x : x) + jc.bleed) / total;
    const zs = [-jc.height / 2, jc.height / 2];
    const s = linspace(0, X.length - 1, X.length);
    const zero = (): UV => [0, 0];
    this.sheet = new SheetMesh(s, zs, JACKET_THICKNESS, {
      top: (i, j) => [u(X[i]), 1 - (zs[j] + jc.height / 2 + jc.bleed) / totalH],
      bottom: zero,
      edge: zero,
    }, (mid) => this.fillMid(mid));
    this.mesh = new Mesh(this.sheet.geometry, materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Re-pose from the book's current covering. */
  update(): void {
    this.fillMid(this.sheet.mid);
    this.sheet.update();
  }

  /** Jacket-off: slide the jacket over the head of the book (0 on … 1 off). */
  setOffset(p: number): void {
    this.mesh.position.z = -Math.max(0, Math.min(1, p)) * this.height * 1.06;
  }

  private fillMid(mid: Float64Array): void {
    const b = this.base;
    const n = b.count;
    const B = this.baseBuf;
    b.fill(B);
    const off = JACKET_GAP + JACKET_THICKNESS / 2;
    const ns = FLAP_N + FOLD_N + n + FOLD_N + FLAP_N;
    const pts = new Float64Array(ns * 2);
    const put = (i: number, a: number, y: number) => { pts[2 * i] = a; pts[2 * i + 1] = y; };
    // Main part: the base offset outward along its left normals.
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let ta = B[2 * i1] - B[2 * i0], ty = B[2 * i1 + 1] - B[2 * i0 + 1];
      const l = Math.hypot(ta, ty) || 1;
      ta /= l; ty /= l;
      put(FLAP_N + FOLD_N + i, B[2 * i] - ty * off, B[2 * i + 1] + ta * off);
    }
    const end = (first: boolean) => {
      const i = first ? 0 : n - 1, k = first ? 1 : n - 2;
      let ta = first ? B[2 * k] - B[2 * i] : B[2 * i] - B[2 * k];
      let ty = first ? B[2 * k + 1] - B[2 * i + 1] : B[2 * i + 1] - B[2 * k + 1];
      const l = Math.hypot(ta, ty) || 1;
      ta /= l; ty /= l;
      return { ea: B[2 * i], ey: B[2 * i + 1], ta, ty, na: -ty, ny: ta };
    };
    const r = b.wrapT / 2 + off;
    // A flap lies against the inside of the cover it wraps: the base walked back from its end,
    // offset inward through the cover (straight on a board, curling with a soft cover).
    const inside = (first: boolean, d: number): [number, number] => {
      let acc = 0;
      for (let k = 0; k < n - 1; k++) {
        const i0 = first ? k : n - 1 - k, i1 = first ? k + 1 : n - 2 - k;
        const da = B[2 * i1] - B[2 * i0], dy = B[2 * i1 + 1] - B[2 * i0 + 1];
        const l = Math.hypot(da, dy);
        if (acc + l >= d || k === n - 2) {
          const t = l > 0 ? Math.min(1, (d - acc) / l) : 0;
          // Left normal of the base's own direction (back → front), pointing outward.
          const sgn = first ? 1 : -1;
          const tx = (sgn * da) / (l || 1), tyy = (sgn * dy) / (l || 1);
          const h = b.wrapT + off;
          return [B[2 * i0] + da * t + tyy * h, B[2 * i0 + 1] + dy * t - tx * h];
        }
        acc += l;
      }
      return [B[0], B[1]];
    };
    // Back fore-edge: flap (deep end first) → fold from the inside round to the outside.
    {
      const { ea, ey, ta, ty, na, ny } = end(true);
      const ca = ea - na * (b.wrapT / 2), cy = ey - ny * (b.wrapT / 2);
      for (let k = 0; k < FOLD_N; k++) {
        const th = Math.PI * (1 - k / FOLD_N);
        put(FLAP_N + k, ca + r * (na * Math.cos(th) - ta * Math.sin(th)), cy + r * (ny * Math.cos(th) - ty * Math.sin(th)));
      }
      for (let k = 0; k < FLAP_N; k++) {
        const p = inside(true, this.flapW * (1 - k / FLAP_N));
        put(k, p[0], p[1]);
      }
    }
    // Front fore-edge: fold from the outside round to the inside, then the flap.
    {
      const { ea, ey, ta, ty, na, ny } = end(false);
      const ca = ea - na * (b.wrapT / 2), cy = ey - ny * (b.wrapT / 2);
      const o = FLAP_N + FOLD_N + n;
      for (let k = 1; k <= FOLD_N; k++) {
        const th = (Math.PI * k) / FOLD_N;
        put(o + k - 1, ca + r * (na * Math.cos(th) + ta * Math.sin(th)), cy + r * (ny * Math.cos(th) + ty * Math.sin(th)));
      }
      for (let k = 1; k <= FLAP_N; k++) {
        const p = inside(false, (this.flapW * k) / FLAP_N);
        put(o + FOLD_N + k - 1, p[0], p[1]);
      }
    }
    // Offsetting into a concave crease (an opened soft cover's spine edge, the joint of an opened
    // case) leaves a little swallowtail loop: cut it at its crossing.
    untangle(pts, ns);
    if (b.constrain) {
      b.constrain(pts, ns, JACKET_THICKNESS / 2);
      untangle(pts, ns);
    }
    for (let j = 0; j < 2; j++) mid.set(pts, j * ns * 2);
  }

  dispose(): void {
    this.sheet.dispose();
  }
}
