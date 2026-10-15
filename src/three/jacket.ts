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
}

/** Jacket panel position on a left-bound jacket (pt). */
export function jacketPanel(jc: JacketCalc, rtl: boolean, id: JacketPanel['id']): { x: number; w: number } {
  const p = jc.panels.find((q) => q.id === id) ?? { x: 0, w: 0 };
  return { x: rtl ? jc.width - p.x - p.w : p.x, w: p.w };
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
    // Back fore-edge: flap (deep end first) → fold from the inside round to the outside.
    {
      const { ea, ey, ta, ty, na, ny } = end(true);
      const ca = ea - na * (b.wrapT / 2), cy = ey - ny * (b.wrapT / 2);
      for (let k = 0; k < FOLD_N; k++) {
        const th = Math.PI * (1 - k / FOLD_N);
        put(FLAP_N + k, ca + r * (na * Math.cos(th) - ta * Math.sin(th)), cy + r * (ny * Math.cos(th) - ty * Math.sin(th)));
      }
      const sa = ca - r * na, sy = cy - r * ny;
      for (let k = 0; k < FLAP_N; k++) {
        const d = this.flapW * (1 - k / FLAP_N);
        put(k, sa + ta * d, sy + ty * d);
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
      const sa = ca - r * na, sy = cy - r * ny;
      for (let k = 1; k <= FLAP_N; k++) {
        const d = (this.flapW * k) / FLAP_N;
        put(o + FOLD_N + k - 1, sa - ta * d, sy - ty * d);
      }
    }
    for (let j = 0; j < 2; j++) mid.set(pts, j * ns * 2);
  }

  dispose(): void {
    this.sheet.dispose();
  }
}
