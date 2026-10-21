/**
 * Book mesh builders for every binding, plus `BookModel`, which owns the meshes and poses
 * the moving parts (front board / soft cover, cloth joint, turnable leaves).
 *
 * All coordinates are a-space points (see layout.ts). Static parts are built once; the
 * bendable parts are `SheetMesh`es re-posed on the CPU.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Group,
  Mesh,
  ShapeUtils,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm } from '../lib/random';
import { mm } from '../model/units';
import { EDGE_TILE, bandTaper, droopAngle, spineOuter, type BookLayout } from './layout';
import type { BookMaterials } from './materials';
import { SheetMesh, integrateCurve, linspace, mergeSamples, type SheetEdge, type UV } from './sheet';
import type { BookSceneInput } from './types';
import type { JacketCalc } from '../engine/binding';
import { JACKET_GAP, JacketRig, jacketPanel, type JacketBase } from './jacket';

type V3 = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;
/** Peak curl (radians) of a leaf / soft cover mid-turn. */
const LEAF_CURL = 0.5;
const COVER_CURL = 0.22;
/** Cloth joint thickness, endpaper hinge thickness and samples, pt. */
const JOINT_T = mm(0.35);
const GUTTER_T = 0.25;
const GUTTER_N = 15;

function bezier(p: number[][], t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
    u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
  ];
}

/** Closest point on a polyline with per-vertex normals; `inside` = projects within its span. */
function closestOnPolyline(pl: { p: Float64Array; n: Float64Array }, a: number, y: number): { a: number; y: number; na: number; ny: number; inside: boolean } {
  const { p, n } = pl;
  const m = p.length / 2;
  let best = Infinity, ba = 0, by = 0, bna = 0, bny = 1, bin = false;
  for (let i = 0; i < m - 1; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1], ux = p[2 * i + 2] - ax, uy = p[2 * i + 3] - ay;
    const l2 = ux * ux + uy * uy || 1e-12;
    const tr = ((a - ax) * ux + (y - ay) * uy) / l2;
    const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
    const qx = ax + ux * t, qy = ay + uy * t;
    const d2 = (a - qx) ** 2 + (y - qy) ** 2;
    if (d2 < best) {
      best = d2; ba = qx; by = qy;
      let nx = n[2 * i] + (n[2 * i + 2] - n[2 * i]) * t, ny = n[2 * i + 1] + (n[2 * i + 3] - n[2 * i + 1]) * t;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      bna = nx; bny = ny;
      bin = !((i === 0 && tr < 0) || (i === m - 2 && tr > 1));
    }
  }
  return { a: ba, y: by, na: bna, ny: bny, inside: bin };
}

/** The point lies (nearly) along the normal at its closest point: a local, not a far-off, match. */
function near(a: number, y: number, q: { a: number; y: number; na: number; ny: number }, d: number): boolean {
  return Math.hypot(a - q.a - d * q.na, y - q.y - d * q.ny) < mm(0.3);
}

/** A sheet's mid-surface (row 0) as a polyline with its top (cover-side) normals. */
function sheetOutline(sh: SheetMesh): { p: Float64Array; n: Float64Array } {
  const ns = sh.ns;
  const pos = sh.geometry.getAttribute('position').array as Float32Array;
  const p = new Float64Array(2 * ns), n = new Float64Array(2 * ns);
  for (let i = 0; i < ns; i++) {
    const ma = sh.mid[2 * i], my = sh.mid[2 * i + 1];
    p[2 * i] = ma; p[2 * i + 1] = my;
    const tx = pos[3 * i] - ma, ty = pos[3 * i + 1] - my;
    const l = Math.hypot(tx, ty) || 1;
    n[2 * i] = tx / l; n[2 * i + 1] = ty / l;
  }
  return { p, n };
}

/** Curl of a leaf / cover along its free part: amplitude × u^CURL_POW (u = 0 … 1). */
const CURL_POW = 1.5;
/** Curl factor across the leaf from head (−1) to tail (+1): 1 + CURL_TWIST·zn. */
const CURL_TWIST = 0.35;
/** Angular room (rad) to the leaf / cover ahead below which a leaf can't curl freely. */
const CURL_ROOM = 0.5;

/* ------------------------------------------------------------------------- */
/* Static mesh builder                                                        */
/* ------------------------------------------------------------------------- */

class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private groups: number[][] = [];

  vertex(p: V3, n: V3, uv: UV): number {
    this.pos.push(p[0], p[1], p[2]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.nrm.push(n[0] / l, n[1] / l, n[2] / l);
    this.uvs.push(uv[0], uv[1]);
    return this.pos.length / 3 - 1;
  }

  /** Adds a triangle wound so that it faces along its vertex normals. */
  tri(g: number, a: number, b: number, c: number): void {
    const P = this.pos, N = this.nrm;
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const rx = N[3 * a] + N[3 * b] + N[3 * c], ry = N[3 * a + 1] + N[3 * b + 1] + N[3 * c + 1], rz = N[3 * a + 2] + N[3 * b + 2] + N[3 * c + 2];
    while (this.groups.length <= g) this.groups.push([]);
    if (gx * rx + gy * ry + gz * rz < 0) this.groups[g].push(a, c, b); else this.groups[g].push(a, b, c);
  }

  quad(g: number, a: number, b: number, c: number, d: number): void {
    this.tri(g, a, b, c);
    this.tri(g, a, c, d);
  }

  /** Flat quad from four corners (any order around the perimeter). */
  face(g: number, corners: V3[], n: V3, uv: (p: V3) => UV): void {
    const ids = corners.map((p) => this.vertex(p, n, uv(p)));
    this.quad(g, ids[0], ids[1], ids[2], ids[3]);
  }

  /** A (nu × nv) vertex grid with finite-difference normals oriented along `hint`. */
  grid(g: number, nu: number, nv: number, f: (i: number, j: number) => { p: V3; uv: UV }, hint: (p: V3, i: number, j: number) => V3): void {
    const pts: V3[] = [];
    const uv: UV[] = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const r = f(i, j);
      pts.push(r.p);
      uv.push(r.uv);
    }
    const at = (i: number, j: number) => pts[j * nu + i];
    const base = this.pos.length / 3;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const p = at(i, j);
      const a = at(Math.max(0, i - 1), j), b = at(Math.min(nu - 1, i + 1), j);
      const c = at(i, Math.max(0, j - 1)), d = at(i, Math.min(nv - 1, j + 1));
      const du: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const dv: V3 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
      let n: V3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
      const h = hint(p, i, j);
      const l = Math.hypot(n[0], n[1], n[2]);
      if (l < 1e-9) n = h;
      else if (n[0] * h[0] + n[1] * h[1] + n[2] * h[2] < 0) n = [-n[0], -n[1], -n[2]];
      this.vertex(p, n, uv[j * nu + i]);
    }
    for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
      const v = (ii: number, jj: number) => base + jj * nu + ii;
      this.quad(g, v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
    }
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    const index: number[] = [];
    this.groups.forEach((tris, g) => {
      if (tris.length === 0) return;
      geo.addGroup(index.length, tris.length, g);
      for (const t of tris) index.push(t);
    });
    geo.setIndex(index);
    geo.computeBoundingSphere();
    return geo;
  }
}

/* ------------------------------------------------------------------------- */
/* Static parts                                                               */
/* ------------------------------------------------------------------------- */

/** Covered board (case / coptic) in its closed position. Groups: 0 covering, 1 pastedown, 2 front panel. */
function buildBoard(L: BookLayout, side: 'front' | 'back'): BufferGeometry {
  const mb = new MeshBuilder();
  const cm = L.cover;
  const A0 = L.boardA0, A1 = A0 + L.boardW;
  const front = side === 'front';
  const yOut = front ? L.thick : 0;
  const yIn = front ? L.thick - L.bt : L.bt;
  const ny = front ? 1 : -1;
  const bh = L.boardH, Z0 = -bh / 2, Z1 = bh / 2;
  const P = cm.panel(front ? 'front' : 'back');
  const Xp = (d: number) => (front ? P.x + d : P.x + P.w - d);
  const uv = (X: number, Y: number): UV => [cm.u(X), cm.v(Y)];
  const e = (y: number) => Math.abs(yOut - y);
  const bw = L.boardW, bt = L.bt;

  // The front board's outer face is the front panel: its own material slot (sharper art).
  mb.face(front ? 2 : 0, [[A0, yOut, Z0], [A1, yOut, Z0], [A1, yOut, Z1], [A0, yOut, Z1]], [0, ny, 0], (p) => uv(Xp(p[0] - A0), p[2] - Z0));
  mb.face(0, [[A1, yOut, Z0], [A1, yIn, Z0], [A1, yIn, Z1], [A1, yOut, Z1]], [1, 0, 0], (p) => uv(Xp(bw + e(p[1])), p[2] - Z0));
  mb.face(0, [[A0, yOut, Z0], [A1, yOut, Z0], [A1, yIn, Z0], [A0, yIn, Z0]], [0, 0, -1], (p) => uv(Xp(p[0] - A0), -e(p[1])));
  mb.face(0, [[A0, yOut, Z1], [A1, yOut, Z1], [A1, yIn, Z1], [A0, yIn, Z1]], [0, 0, 1], (p) => uv(Xp(p[0] - A0), bh + e(p[1])));
  mb.face(0, [[A0, yOut, Z0], [A0, yIn, Z0], [A0, yIn, Z1], [A0, yOut, Z1]], [-1, 0, 0], (p) => uv(Xp(-e(p[1])), p[2] - Z0));

  // Inside: the turn-ins (mitred at the corners) framing the pastedown.
  const iv = Math.max(0, Math.min(cm.wrap - bt, mm(3.5), bw / 4, bh / 4));
  const nIn: V3 = [0, -ny, 0];
  if (iv > 0.01) {
    mb.face(0, [[A0, yIn, Z0], [A1, yIn, Z0], [A1 - iv, yIn, Z0 + iv], [A0, yIn, Z0 + iv]], nIn, (p) => uv(Xp(p[0] - A0), -(bt + (p[2] - Z0))));
    mb.face(0, [[A0, yIn, Z1], [A1, yIn, Z1], [A1 - iv, yIn, Z1 - iv], [A0, yIn, Z1 - iv]], nIn, (p) => uv(Xp(p[0] - A0), bh + bt + (Z1 - p[2])));
    mb.face(0, [[A1, yIn, Z0], [A1, yIn, Z1], [A1 - iv, yIn, Z1 - iv], [A1 - iv, yIn, Z0 + iv]], nIn, (p) => uv(Xp(bw + bt + (A1 - p[0])), p[2] - Z0));
  }
  mb.face(1, [[A0, yIn, Z0 + iv], [A1 - iv, yIn, Z0 + iv], [A1 - iv, yIn, Z1 - iv], [A0, yIn, Z1 - iv]], nIn, () => [0, 0]);

  // Dust-jacket flap folded around the fore-edge onto the pastedown.
  if (L.flap > 0) {
    const F = Math.min(L.flap, bw - mm(4));
    const FP = cm.panel(front ? 'front-flap' : 'back-flap');
    const Xf = (dist: number) => (front ? FP.x + dist : FP.x + FP.w - dist);
    const y = yIn - ny * 0.4;
    mb.face(0, [[A1 - F, y, Z0], [A1, y, Z0], [A1, y, Z1], [A1 - F, y, Z1]], nIn, (p) => uv(Xf(A1 - p[0]), p[2] - Z0));
  }
  return mb.build();
}

/** Rounded (or flat) spine covering with raised bands. Groups: 0 covering, 1 lining. */
function buildCaseSpine(L: BookLayout, bandsFromHead: number[]): BufferGeometry {
  const mb = new MeshBuilder();
  const cm = L.cover;
  const S = cm.panel('spine');
  const bh = L.boardH, Z0 = -bh / 2, Z1 = bh / 2;
  const thick = L.thick;
  const arc: { p: [number, number]; n: [number, number]; t: number }[] = [];
  if (L.rd > 1e-3) {
    const R = L.arcR, ac = L.arcAc;
    const psi0 = Math.asin(Math.min(1, thick / 2 / R));
    const N = 28;
    for (let i = 0; i < N; i++) {
      const psi = -psi0 + (2 * psi0 * i) / (N - 1);
      arc.push({ p: [ac - R * Math.cos(psi), thick / 2 + R * Math.sin(psi)], n: [-Math.cos(psi), Math.sin(psi)], t: R * (psi + psi0) });
    }
  } else {
    for (let i = 0; i < 28; i++) arc.push({ p: [0, (thick * i) / 27], n: [-1, 0], t: (thick * i) / 27 });
  }
  const arcLen = arc[arc.length - 1].t || 1;
  const X = (t: number) => S.x + (t / arcLen) * S.w;
  // z samples, refined across each raised band.
  const bandZ = bandsFromHead.map((b) => Z0 + b);
  const extra: number[] = [];
  for (const zb of bandZ) extra.push(...linspace(zb - L.bandW / 2, zb + L.bandW / 2, 11));
  const zs = mergeSamples([Z0, Z1], extra.filter((z) => z > Z0 && z < Z1));
  const bump = (z: number) => {
    let h = 0;
    for (const zb of bandZ) {
      const d = z - zb;
      if (Math.abs(d) < L.bandW / 2) h += L.bandH * 0.5 * (1 + Math.cos((TAU * d) / L.bandW));
    }
    return h;
  };
  mb.grid(0, arc.length, zs.length, (i, j) => {
    const a = arc[i], h = bump(zs[j]) * bandTaper(i / (arc.length - 1));
    return { p: [a.p[0] + a.n[0] * h, a.p[1] + a.n[1] * h, zs[j]], uv: [cm.u(X(a.t)), cm.v(zs[j] - Z0)] };
  }, (_p, i) => [arc[i].n[0], arc[i].n[1], 0]);
  const th = L.spTh;
  // The lining stops short of the joints, below the cloth dipping into the french grooves.
  const lin = (a: (typeof arc)[number]): [number, number] => [a.p[0] - a.n[0] * th, Math.min(thick - L.liningClip, Math.max(L.liningClip, a.p[1] - a.n[1] * th))];
  mb.grid(1, arc.length, 2, (i, j) => {
    const q = lin(arc[i]);
    return { p: [q[0], q[1], j === 0 ? Z0 : Z1], uv: [0, 0] };
  }, (_p, i) => [-arc[i].n[0], -arc[i].n[1], 0]);
  // Its long edges at the joints, closed from the cloth to the lining: under the joint cloth,
  // but open they let a grazing view at the head or tail into the hollow and out the other side.
  for (const [i, sgn] of [[0, -1], [arc.length - 1, 1]] as const) {
    const a = arc[i];
    const q = lin(a);
    const out: [number, number] = [a.p[0], a.p[1]];
    // Facing along the arc, away from the spine (toward the joint).
    const ta = sgn * (arc[Math.min(arc.length - 1, i + 1)].p[0] - arc[Math.max(0, i - 1)].p[0]);
    const ty = sgn * (arc[Math.min(arc.length - 1, i + 1)].p[1] - arc[Math.max(0, i - 1)].p[1]);
    mb.grid(1, 2, zs.length, (k, j) => ({ p: k === 0 ? [out[0], out[1], zs[j]] : [q[0], q[1], zs[j]], uv: [0, 0] }), () => [ta, ty, 0]);
  }
  // Head and tail: the covering turned in over the spine stiffener.
  for (const [z, sign] of [[Z0, -1], [Z1, 1]] as const) {
    mb.grid(0, arc.length, 2, (i, j) => {
      const a = arc[i];
      const d = j === 0 ? -bump(z) * bandTaper(i / (arc.length - 1)) : th;
      const q: [number, number] = j === 0 ? [a.p[0] - a.n[0] * d, a.p[1] - a.n[1] * d] : lin(a);
      return { p: [q[0], q[1], z], uv: [cm.u(X(a.t)), cm.v(sign < 0 ? -d : bh + d)] };
    }, () => [0, 0, sign]);
  }
  return mb.build();
}

/** Text block below the turnable leaves. Groups: 0 top page, 1 bottom, 2 page edges, 3 spine. */
function buildTextBlock(L: BookLayout, y0: number, y1: number, deckle: boolean, spineTop: number): BufferGeometry {
  const mb = new MeshBuilder();
  const H = L.H, Z0 = -H / 2, Z1 = H / 2;
  const ny = L.family === 'case' ? 24 : L.family === 'coptic' ? Math.min(600, L.sections * 10 + 1) : deckle ? 12 : 2;
  const ys = linspace(y0, y1, Math.max(2, ny));
  const zs = deckle ? linspace(Z0, Z1, 121) : [Z0, Z1];
  const amp = mm(0.9);
  const dk = (z: number, y: number) => (deckle ? amp * Math.max(0, fbm(z / mm(1.6), y / mm(0.22), 3, 17) * 1.6 - 0.45) : 0);
  const vT = (y: number) => (y - L.tbY0) / L.T;
  const W = L.W;
  const pageU = (s: number) => (L.rtl ? 1 - s / W : s / W);
  // top page
  const sTop = L.spineA(y1);
  mb.grid(0, 2, zs.length, (i, j) => {
    const a = i === 0 ? sTop : L.foreA(y1) - dk(zs[j], y1);
    return { p: [a, y1, zs[j]], uv: [pageU(a - sTop), 1 - (zs[j] - Z0) / H] };
  }, () => [0, 1, 0]);
  mb.grid(1, 2, 2, (i, j) => ({ p: [i === 0 ? L.spineA(y0) : L.foreA(y0), y0, j === 0 ? Z0 : Z1], uv: [0, 0] }), () => [0, -1, 0]);
  // fore-edge
  mb.grid(2, ys.length, zs.length, (i, j) => ({
    p: [L.foreA(ys[i]) - dk(zs[j], ys[i]), ys[i], zs[j]],
    uv: [(zs[j] - Z0) / EDGE_TILE, vT(ys[i])],
  }), () => [1, 0, 0]);
  // head & tail
  for (const [z, sign] of [[Z0, -1], [Z1, 1]] as const) {
    mb.grid(2, 2, ys.length, (i, j) => {
      const y = ys[j];
      const a = i === 0 ? L.spineA(y) : L.foreA(y) - dk(z, y);
      return { p: [a, y, z], uv: [(a - L.spineA(y)) / EDGE_TILE, vT(y)] };
    }, () => [0, 0, sign]);
  }
  // Spine side. On a coptic book these are the exposed section folds, which stay in place
  // over the turnable leaves too (leaves hinge in their fold).
  const ysSpine = spineTop > y1 ? linspace(y0, spineTop, Math.max(2, Math.round((ny * (spineTop - y0)) / Math.max(1e-6, y1 - y0)))) : ys;
  mb.grid(3, ysSpine.length, 2, (i, j) => ({ p: [L.spineA(ysSpine[i]), ysSpine[i], j === 0 ? Z0 : Z1], uv: [(j === 0 ? 0 : H) / EDGE_TILE, vT(ysSpine[i])] }), () => [-1, 0, 0]);
  return mb.build();
}

function tube(points: V3[], radius: number, closed = false): TubeGeometry {
  const curve = new CatmullRomCurve3(points.map((p) => new Vector3(p[0], p[1], p[2])), closed, 'centripetal');
  const segs = Math.max(8, Math.min(400, Math.round(curve.getLength() / Math.max(radius, 0.2))));
  return new TubeGeometry(curve, segs, radius, 6, closed);
}

function merge(geos: BufferGeometry[]): BufferGeometry | null {
  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
}

/**
 * Headband: silk-wrapped core glued to the head and tail of the spine. It spans the static
 * part of the block (up to `yTop`), so the turnable leaves roll over it instead of through it.
 */
function buildHeadbands(L: BookLayout, headbandHeight: number, squares: number, yTop: number): BufferGeometry | null {
  const span = yTop - L.tbY0;
  const r = Math.min(Math.max(mm(0.6), Math.min(headbandHeight / 2, squares * 0.45, mm(1.6))), span / 2.5);
  if (r < mm(0.15)) return null;
  const geos: BufferGeometry[] = [];
  for (const sign of [-1, 1]) {
    const z = sign * (L.H / 2 - r * 0.4);
    const pts: V3[] = linspace(L.tbY0 + r, yTop - r, 12).map((y) => [L.spineA(y) + r * 0.85, y, z]);
    geos.push(tube(pts, r));
  }
  return merge(geos);
}

/**
 * Coptic link stitches: a chain at every station across the exposed section folds. The chains
 * meet the boards at their hinge line (L.pivotA, on the board's mid-plane), so the front board
 * swings about the thread without tearing the chain apart.
 */
function buildCopticChains(L: BookLayout, stations: number[]): { spine: BufferGeometry | null; front: BufferGeometry | null } {
  const S = L.sections;
  const ts = L.T / S;
  const r = Math.min(ts * 0.42, mm(2.5));
  const rt = L.threadR;
  const w = Math.min(Math.max(ts * 0.55, mm(0.8)), mm(2.2));
  const bt = L.bt, thick = L.thick, y0 = L.tbY0;
  const ha = L.pivotA;
  const spine: BufferGeometry[] = [];
  const front: BufferGeometry[] = [];
  for (const st of stations) {
    const zs = -L.H / 2 + st;
    for (const side of [1, -1]) {
      const pts: V3[] = [[mm(4), -rt, zs], [ha * 0.6 - rt * 0.4, -rt * 0.4, zs + side * w * 0.2], [ha, bt * 0.5, zs + side * w * 0.4]];
      for (let j = 0; j < S; j++) {
        pts.push([-r - rt * 0.8, y0 + (j + 0.5) * ts, zs]);
        if (j < S - 1) pts.push([-r * 0.35 - rt, y0 + (j + 1) * ts, zs + side * w]);
      }
      pts.push([ha, thick - bt * 0.5, zs + side * w * 0.4]);
      spine.push(tube(pts, rt));
    }
    front.push(tube([[ha, thick - bt * 0.5, zs], [ha * 0.6 - rt * 0.4, thick + rt * 0.4, zs], [mm(1.5), thick + rt, zs], [mm(4), thick + rt * 0.6, zs]], rt));
  }
  return { spine: merge(spine), front: merge(front) };
}

/** Japanese stab binding: spine wraps at every hole, the stitch line, and head/tail wraps. */
function buildStabThread(L: BookLayout, holes: { x: number; y: number }[]): BufferGeometry | null {
  if (holes.length === 0) return null;
  const rt = L.threadR, cc = L.cc, thick = L.thick;
  const Z0 = -L.H / 2, Z1 = L.H / 2;
  const geos: BufferGeometry[] = [];
  const top = thick + rt, bot = -rt;
  const spineWrap = (a: number, z: number) => geos.push(tube([
    [a, top, z], [-cc * 0.3, top, z], [-cc - rt * 0.7, thick + rt * 0.7, z], [-cc - rt, thick * 0.5, z],
    [-cc - rt * 0.7, -rt * 0.7, z], [-cc * 0.3, bot, z], [a, bot, z],
  ], rt));
  const edgeWrap = (a: number, z: number, head: boolean) => {
    const ze = head ? Z0 - rt : Z1 + rt;
    const zc = head ? Z0 - rt * 0.7 : Z1 + rt * 0.7;
    const zi = head ? Z0 + rt * 0.3 : Z1 - rt * 0.3;
    geos.push(tube([[a, top, z], [a, top, zi], [a, thick + rt * 0.7, zc], [a, thick * 0.5, ze], [a, -rt * 0.7, zc], [a, bot, zi], [a, bot, z]], rt));
  };
  const main = holes.slice(0, 4).sort((p, q) => p.y - q.y);
  const corner = holes.slice(4);
  for (const h of holes) spineWrap(h.x, Z0 + h.y);
  for (let i = 0; i < main.length - 1; i++) {
    const a = main[i], b = main[i + 1];
    geos.push(tube([[a.x, top, Z0 + a.y], [(a.x + b.x) / 2, top, Z0 + (a.y + b.y) / 2], [b.x, top, Z0 + b.y]], rt));
    geos.push(tube([[a.x, bot, Z0 + a.y], [(a.x + b.x) / 2, bot, Z0 + (a.y + b.y) / 2], [b.x, bot, Z0 + b.y]], rt));
  }
  if (main.length > 0) {
    edgeWrap(main[0].x, Z0 + main[0].y, true);
    edgeWrap(main[main.length - 1].x, Z0 + main[main.length - 1].y, false);
  }
  for (const h of corner) {
    const head = h.y < L.H / 2;
    edgeWrap(h.x, Z0 + h.y, head);
    const end = head ? main[0] : main[main.length - 1];
    if (end) geos.push(tube([[h.x, top, Z0 + h.y], [(h.x + end.x) / 2, top, Z0 + (h.y + end.y) / 2], [end.x, top, Z0 + end.y]], rt));
  }
  return merge(geos);
}

/* ------------------------------------------------------------------------- */
/* Book model                                                                 */
/* ------------------------------------------------------------------------- */

interface LeafRig {
  k: number;
  sheet: SheetMesh;
  mesh: Mesh;
  yRight: number;
  /** Arc length from the spine to the start of the gutter bend (stab: the stitched strip). */
  sc: number;
  /** Current turn, 0 … 1. */
  x: number;
  last: string;
}

/** How a turning leaf bends, for one gravity (see BookModel.leafBend). */
interface LeafBend {
  /** Bend angle of a fully turned leaf (π, plus the board's rest tilt when lying). */
  thetaEnd: number;
  /** Arc length over which the gutter bend is spread. */
  len: number;
  /** Soft covers: offset of the turned leaf above the opened cover's mid-surface, pt. */
  offset: number;
  /** Soft covers: arc length at which the leaf starts to follow the cover's droop. */
  sd: number;
}

interface SoftCoverRig {
  sheet: SheetMesh;
  basePhi: Float64Array;
  anchor: number;
  creaseStart: number;
  creaseLen: number;
  curlStart: number;
  frontEnd: number;
  /** Arc length where the front French flap starts (after its fold); Infinity without flaps. */
  flapStart: number;
  droopStart: number;
  /** Arc length at the back fore-edge, and at the back / front edges of the spine panel. */
  sBack0: number;
  sSpine0: number;
  sSpine1: number;
  last: string;
}

/** On-screen densities (px per pt) the textures need; 0 = not in view. */
export interface TextureDensity { pages: Map<number, number>; coverFront: number; jacketFront: number }

export interface BookBounds { a0: number; a1: number; y0: number; y1: number; z0: number; z1: number }

/**
 * Solve u + q·p(u) = v for u, where p is the droop angle profile: the arc length u on the
 * cover's droop that corresponds to arc length v on a sheet lying `q / dw` above it (a parallel
 * curve is longer over convex bends and shorter over concave ones).
 */
function offsetDroopU(L: BookLayout, v: number, q: number): number {
  const { D, beta } = L.droop;
  if (beta <= 0 || q === 0 || v <= 0) return v;
  // Keep the parallel curve free of cusps: 1 + q·p'(u) > 0.
  const qq = Math.sign(q) * Math.min(Math.abs(q), (0.85 * D) / (Math.PI * beta));
  let u = v;
  for (let i = 0; i < 6; i++) {
    const inside = u > 0 && u < D;
    const p = inside ? droopAngle(L.droop, u) : 0;
    const dp = inside ? beta * (Math.PI / D) * Math.sin((TAU * u) / D) : 0;
    u -= (u + qq * p - v) / (1 + qq * dp);
    if (u < 0) u = 0;
  }
  return u;
}

export class BookModel {
  readonly group = new Group();
  private readonly L: BookLayout;
  private readonly mats: BookMaterials;
  private readonly geometries: BufferGeometry[] = [];
  private readonly sheets: SheetMesh[] = [];
  private readonly leaves: LeafRig[] = [];
  private frontPivot: Group | null = null;
  private hinge: SheetMesh | null = null;
  private gutter: SheetMesh | null = null;
  private backJoint: SheetMesh | null = null;
  /** Head and tail caps of the spine region (see buildSpineCaps). */
  private caps: { geo: BufferGeometry; pos: Float32Array; max: number } | null = null;
  private soft: SoftCoverRig | null = null;
  /** Case spine's outer surface (back → front) with outward normals, for the jacket. */
  private spineOutline: { p: Float64Array; n: Float64Array } | null = null;
  private phi: Float64Array = new Float64Array(0);
  private lastBoard = '';
  private openAmount = 0;
  private boardTheta = 0;
  private jacket: JacketRig | null = null;
  private lastJacket = '';
  /**
   * Gap between the support (opened board's inner face / opened cover's top) and the bottom of
   * the first turned leaf: pastedown and endpaper hinge, plus the flaps tucked in there, pt.
   */
  private e0: number;
  /** Lift (pt) that sets the lowest closed part (jacket, threads, joint cloth) on the ground. */
  readonly groundLift: number;
  /** Head-most / tail-most z of the closed book (jacket, threads included), pt. */
  readonly zHead: number;
  readonly zTail: number;

  constructor(L: BookLayout, input: BookSceneInput, mats: BookMaterials) {
    this.L = L;
    this.mats = mats;
    const jc = input.jacket && mats.jacketOuter && mats.jacketInner ? input.jacket : null;
    this.e0 = L.clr + (L.family === 'soft' ? mm(0.02) : mm(0.16));
    const { spec, calc } = input;
    if (L.family === 'case') this.buildCase(calc.bands, spec.binding.headband, calc.headbandHeight, spec.binding.squares);
    else if (L.family === 'coptic') this.buildCoptic(calc.stations);
    else this.buildSoft(calc.stabHoles);
    this.buildBlock(spec.cover.edge === 'deckle');
    this.buildLeaves();
    if (jc) this.buildJacket(jc);
    this.setPose(0, [], 1);
    const ext = this.closedExtents();
    this.groundLift = Math.max(0, -ext.y0);
    this.zHead = Math.min(ext.z0, -L.coverH / 2);
    this.zTail = Math.max(ext.z1, L.coverH / 2);
  }

  /** Extents of the closed book over every mesh (a-space), for ground contact. */
  private closedExtents(): { y0: number; z0: number; z1: number } {
    let y0 = 0, z0 = 0, z1 = 0;
    this.group.updateMatrixWorld(true);
    const inv = this.group.matrixWorld.clone().invert();
    const v = new Vector3();
    this.group.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      const m = mesh.matrixWorld.clone().premultiply(inv);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (v.y < y0) y0 = v.y;
        if (v.z < z0) z0 = v.z;
        if (v.z > z1) z1 = v.z;
      }
    });
    return { y0, z0, z1 };
  }

  get hasJacket(): boolean {
    return this.jacket !== null;
  }

  /** Jacket-off: 0 = on, 1 = slid off over the head. */
  setJacketOffset(p: number): void {
    this.jacket?.setOffset(p);
  }

  /* ----------------------------- jacket ----------------------------- */

  private buildJacket(jc: JacketCalc): void {
    const L = this.L;
    const outer = this.mats.jacketOuter, inner = this.mats.jacketInner;
    if (!outer || !inner) return;
    const base = L.family === 'soft' ? this.softJacketBase(jc) : this.boardJacketBase(jc);
    if (!base) return;
    this.jacket = new JacketRig(jc, L.rtl, base, [outer, inner, inner, this.mats.jacketFront ?? outer]);
    this.group.add(this.jacket.mesh);
  }

  /** Outside of back board → joint → spine → joint → front board (front part follows the board). */
  private boardJacketBase(jc: JacketCalc): JacketBase {
    const L = this.L;
    const A0 = L.boardA0, A1 = A0 + L.boardW, thick = L.thick;
    const Nj = 8, Ns = 24;
    const hdJ = L.family === 'case' ? L.hingeDepth * 0.3 : 0;
    // Coptic: the link stitches run over both boards' outer faces up to 4 mm in from the spine
    // edge. The jacket rides over them, and comes down onto the board after the next sample.
    const stitchEnd = L.family === 'coptic' ? Math.min(mm(4) + 2 * L.threadR, 0.5 * L.boardW) : 0;
    const lift = stitchEnd > 0 ? 2 * L.threadR + mm(0.05) : 0;
    const bs = mergeSamples(linspace(A0, A1, 8), stitchEnd > 0 ? [A0 + stitchEnd] : []);
    const lb = bs.map((a) => (a - A0 <= stitchEnd + 1e-6 ? lift : 0));
    const Nb = bs.length;
    const count = Nb + Nj + Ns + Nj + Nb - 1;
    // An uncovered (coptic) spine: the jacket runs up its back to where the front board's outer
    // face starts. Opened past upright, that corner sinks below the closed book's top, and a
    // jacket run up to the top would fold back down through the pages' roots.
    let spineTop = thick;
    const spinePt = (f: number): [number, number] => {
      if (L.family === 'case') return spineOuter(L, f).p;
      return [L.a0, -lift + (spineTop + lift) * f];
    };
    const bez = (p: number[][], t: number): [number, number] => {
      const u = 1 - t;
      return [
        u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
        u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
      ];
    };
    const fillAt = (theta: number, out: Float64Array) => {
      const rot = (a: number, y: number) => this.rotateAboutPivot(a, y, theta);
      // (The board's own corner: opened, a lifted one would run the spine up past the board's end.)
      if (L.family !== 'case') spineTop = Math.max(L.tbY1, Math.min(thick, rot(A0, thick)[1]));
      let i = 0;
      const put = (p: [number, number]) => { out[2 * i] = p[0]; out[2 * i + 1] = p[1]; i++; };
      for (let k = Nb - 1; k >= 0; k--) put([bs[k], -lb[k]]);
      const S0 = spinePt(0), S1 = spinePt(1);
      const back = [[A0, -lift], [A0 + (S0[0] - A0) * 0.3, hdJ - lift], [A0 + (S0[0] - A0) * 0.7, hdJ - lift], S0];
      for (let k = 1; k <= Nj; k++) put(bez(back, k / Nj));
      for (let k = 1; k <= Ns; k++) put(spinePt(k / Ns));
      // Over the joint only while the board is near closed: opened, the board's spine end swings
      // out past the spine, and the jacket wraps that corner as before.
      const lj = lift * (1 - smoothstep(0.08 * Math.PI, 0.2 * Math.PI, theta));
      const front = this.frontJoint(S1, hdJ - lj, theta, -lj);
      for (let k = 1; k <= Nj; k++) {
        const q = bez(front, k / Nj);
        // Over the joint cloth: its cover face, bridged across the groove (never inside it). In a
        // tight crease at the top of the spine the offsets of this and of the spine then meet in a
        // clean corner, which the jacket rig trims. (Outside the cloth, the smooth curve itself:
        // stepping out along the cloth's normals would ripple it over the groove's slopes.)
        const c = this.clothFaceAt(k / Nj);
        if (c) {
          const d = (q[0] - c[0]) * c[2] + (q[1] - c[1]) * c[3];
          put(d >= 0 ? q : [q[0] - c[2] * d, q[1] - c[3] * d]);
        } else put(q);
      }
      for (let k = 1; k < Nb; k++) put(rot(bs[k], thick + lb[k]));
    };
    // X from the closed pose: board panels by distance, the spine panel by arc length.
    const closed = new Float64Array(count * 2);
    fillAt(0, closed);
    const B = jacketPanel(jc, L.rtl, 'back'), S = jacketPanel(jc, L.rtl, 'spine'), F = jacketPanel(jc, L.rtl, 'front');
    const x = new Float64Array(count);
    const s0 = Nb - 1, s1 = Nb - 1 + Nj + Ns + Nj;
    const cum = [0];
    for (let i = s0 + 1; i <= s1; i++) cum.push(cum[cum.length - 1] + Math.hypot(closed[2 * i] - closed[2 * i - 2], closed[2 * i + 1] - closed[2 * i - 1]));
    const total = cum[cum.length - 1] || 1;
    for (let i = 0; i < count; i++) {
      if (i <= s0) x[i] = B.x + ((A1 - closed[2 * i]) / L.boardW) * B.w;
      else if (i <= s1) x[i] = S.x + (cum[i - s0] / total) * S.w;
      else x[i] = F.x + ((closed[2 * i] - A0) / L.boardW) * F.w;
    }
    // The cloth only bears on the samples from the spine's top edge on, the spine on the joints
    // and the spine (a thin book's spine samples are close to the cloth too, and must not jump onto it).
    const spine0 = Nb, clothFrom = Nb + Nj + Ns - 1, spine1 = Nb + 2 * Nj + Ns - 1;
    return {
      count, x, wrapT: L.bt, fill: (out) => fillAt(this.boardTheta, out),
      constrain: (mid, n, half, first) => this.constrainJacket(mid, n, half, { clothFrom: first + clothFrom, spine: [first + spine0, first + spine1] }),
    };
  }

  /** Point on the front joint cloth's cover face at parameter t (0 spine … 1 board) and its normal. */
  private clothFaceAt(t: number): [number, number, number, number] | null {
    const h = this.hinge;
    if (!h) return null;
    const pos = h.geometry.getAttribute('position').array as Float32Array;
    const f = clamp01(t) * (h.ns - 1);
    const i = Math.min(h.ns - 2, Math.floor(f)), w = f - i;
    const top = (k: number): [number, number] => [pos[3 * k], pos[3 * k + 1]];
    const t0 = top(i), t1 = top(i + 1);
    const a = t0[0] + (t1[0] - t0[0]) * w, y = t0[1] + (t1[1] - t0[1]) * w;
    const ma = h.mid[2 * i] + (h.mid[2 * i + 2] - h.mid[2 * i]) * w, my = h.mid[2 * i + 1] + (h.mid[2 * i + 3] - h.mid[2 * i + 1]) * w;
    const l = Math.hypot(a - ma, y - my) || 1;
    return [a, y, (a - ma) / l, (y - my) / l];
  }

  /**
   * Keep the jacket clear of the front joint: outside the opening board's spine end, outside the
   * joint cloth's cover face, and outside the spine's covering near its top edge. Points are
   * pushed straight out to the required distance (a no-op away from the joint).
   */
  private constrainJacket(mid: Float64Array, n: number, half: number, at?: { clothFrom: number; spine: [number, number] }): void {
    const L = this.L;
    const gap = JACKET_GAP + half;
    const th = this.boardTheta, c = Math.cos(th), s = Math.sin(th);
    const u0 = L.boardA0 - L.pivotA, u1 = u0 + L.boardW, hb = L.bt / 2;
    const cloth = this.hinge ? sheetOutline(this.hinge) : null;
    const clothHalf = this.hinge?.half ?? 0;
    const spine = this.spineOutline;
    // Alternate the projections: in the crease between the cloth and the spine's top edge they
    // pull against each other, and converge on the crease's floor.
    for (let it = 0; it < 6; it++) for (let i = 0; i < n; i++) {
      let a = mid[2 * i], y = mid[2 * i + 1];
      // Board (front): rectangle in its own frame, grown by the gap.
      const da = a - L.pivotA, dy = y - L.pivotY;
      const u = c * da + s * dy, v = -s * da + c * dy;
      if (u > u0 - gap && u < u1 && v > -hb - gap && v < hb + gap) {
        const pushU = u - (u0 - gap), pushOut = hb + gap - v, pushIn = v + hb + gap;
        // Only the spine end and the outer face matter (the flap side is handled by the fold).
        if (pushU < pushOut && pushU < pushIn) {
          const uu = u0 - gap;
          a = L.pivotA + c * uu - s * v; y = L.pivotY + s * uu + c * v;
        } else if (pushOut <= pushIn) {
          const vv = hb + gap;
          a = L.pivotA + c * u - s * vv; y = L.pivotY + s * u + c * vv;
        }
      }
      // Joint cloth: stay on its cover side, its half thickness plus the gap away.
      if (cloth && (!at || i >= at.clothFrom)) {
        const q = closestOnPolyline(cloth, a, y);
        const need = clothHalf + gap;
        const d = (a - q.a) * q.na + (y - q.y) * q.ny;
        if (q.inside && near(a, y, q, d) && d < need && d > -need - mm(1)) { a += q.na * (need - d); y += q.ny * (need - d); }
      }
      // Spine covering: outside it.
      if (spine && (!at || (i >= at.spine[0] && i <= at.spine[1]))) {
        const q = closestOnPolyline(spine, a, y);
        const d = (a - q.a) * q.na + (y - q.y) * q.ny;
        if (q.inside && near(a, y, q, d) && d < gap && d > -mm(1.5)) { a += q.na * (gap - d); y += q.ny * (gap - d); }
      }
      mid[2 * i] = a;
      mid[2 * i + 1] = y;
    }
  }

  /** Outside of the soft cover (back fore-edge → front fore-edge), resampled from its pose. */
  private softJacketBase(jc: JacketCalc): JacketBase | null {
    const rig = this.soft;
    if (!rig) return null;
    const L = this.L;
    const src = rig.sheet.s;
    // Even steps plus every sample of the cover itself, so the jacket wraps its tight spine
    // corners instead of chamfering through them.
    const own = Array.from(src).filter((v) => v > rig.sBack0 && v < rig.frontEnd);
    const sv = mergeSamples(linspace(rig.sBack0, rig.frontEnd, 60), own);
    const count = sv.length;
    const seg = sv.map((v) => {
      let k = 0;
      while (k < src.length - 2 && src[k + 1] < v) k++;
      return k;
    });
    const B = jacketPanel(jc, L.rtl, 'back'), S = jacketPanel(jc, L.rtl, 'spine'), F = jacketPanel(jc, L.rtl, 'front');
    const knots: [number, number][] = [[rig.sBack0, B.x], [rig.sSpine0, S.x], [rig.sSpine1, S.x + S.w], [rig.frontEnd, F.x + F.w]];
    const x = Float64Array.from(sv, (v) => {
      for (let k = 1; k < knots.length; k++) {
        if (v <= knots[k][0] || k === knots.length - 1) {
          const [s0, x0] = knots[k - 1], [s1, x1] = knots[k];
          return x0 + ((x1 - x0) * (v - s0)) / Math.max(1e-6, s1 - s0);
        }
      }
      return F.x + F.w;
    });
    const tmp = new Float64Array(count * 2);
    const stitches = L.type === 'stab' ? 2 * L.threadR + mm(0.05) : 0;
    const fill = (out: Float64Array) => {
      const mid = rig.sheet.mid;
      for (let i = 0; i < count; i++) {
        const k = seg[i];
        const t = Math.max(0, Math.min(1, (sv[i] - src[k]) / Math.max(1e-9, src[k + 1] - src[k])));
        tmp[2 * i] = mid[2 * k] + (mid[2 * k + 2] - mid[2 * k]) * t;
        tmp[2 * i + 1] = mid[2 * k + 1] + (mid[2 * k + 3] - mid[2 * k + 1]) * t;
      }
      // Outer surface of the cover: half its caliper along the left normal (and over a stab
      // binding's stitches, which run round the spine onto both covers).
      const h = L.cc / 2 + stitches;
      for (let i = 0; i < count; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1);
        let ta = tmp[2 * i1] - tmp[2 * i0], ty = tmp[2 * i1 + 1] - tmp[2 * i0 + 1];
        const l = Math.hypot(ta, ty) || 1;
        ta /= l; ty /= l;
        out[2 * i] = tmp[2 * i] - ty * h;
        out[2 * i + 1] = tmp[2 * i + 1] + ta * h;
      }
    };
    // With French flaps the jacket folds round the cover and its flap together.
    return { count, x, wrapT: (L.flap > 0 ? 2 * L.cc : L.cc) + stitches, fill };
  }

  /** Closed (open = 0) or fully open (open = 1) extents, used for camera framing. */
  bounds(open: number): BookBounds {
    const L = this.L;
    const leftOpen = L.family === 'soft' ? -L.W - L.cc : 2 * L.pivotA - (L.boardA0 + L.boardW);
    const a0 = L.a0 + (Math.min(L.a0, leftOpen) - L.a0) * open;
    // Headroom for a leaf mid-turn, so the framing stays put while pages turn.
    // (and for a cover standing half open).
    const head = L.W * Math.max(0.5 * open, 0.9 * Math.sin(Math.PI * Math.min(1, open)));
    return { a0, a1: L.a1, y0: -this.groundLift, y1: L.thick + head, z0: Math.min(this.zHead, -L.H / 2), z1: Math.max(this.zTail, L.H / 2) };
  }

  private addMesh(geo: BufferGeometry, mat: Material | Material[], parent: Group = this.group, cast = true): Mesh {
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.geometries.push(geo);
    return mesh;
  }

  private addSheet(sheet: SheetMesh, mat: Material[], cast = true): Mesh {
    this.sheets.push(sheet);
    const mesh = new Mesh(sheet.geometry, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  private boardPivot(): Group {
    const L = this.L;
    const pivot = new Group();
    pivot.position.set(L.pivotA, L.pivotY, 0);
    this.group.add(pivot);
    return pivot;
  }

  /* ------------------------------ case ------------------------------ */

  private buildCase(bands: number[], headband: boolean, headbandHeight: number, squares: number): void {
    const L = this.L, m = this.mats;
    const cm = L.cover;
    const coverMats = [m.cover, m.endpaper, m.coverFront];
    this.addMesh(buildBoard(L, 'back'), coverMats);
    const pivot = this.boardPivot();
    const front = this.addMesh(buildBoard(L, 'front'), coverMats, pivot);
    front.position.set(-L.pivotA, -L.pivotY, 0);
    this.frontPivot = pivot;
    this.addMesh(buildCaseSpine(L, bands), [m.cover, m.lining]);
    {
      const N = 64;
      const p = new Float64Array(2 * N), nn = new Float64Array(2 * N);
      for (let i = 0; i < N; i++) {
        const o = spineOuter(L, i / (N - 1));
        p[2 * i] = o.p[0]; p[2 * i + 1] = o.p[1];
        nn[2 * i] = o.n[0]; nn[2 * i + 1] = o.n[1];
      }
      this.spineOutline = { p, n: nn };
    }
    if (headband) {
      const hb = buildHeadbands(L, headbandHeight, squares, L.tbY1 - L.nTurn * L.c);
      if (hb) {
        this.addMesh(hb, m.headband);
        const len = Math.max(1, L.T);
        m.headbandTexture.repeat.set(len / mm(1.4), 1);
      }
    }
    // Cloth joints (french grooves) between spine and boards; their outer face is flush with
    // the boards' (the back joint rests on the ground with the back board).
    const bh = L.boardH;
    const zs = [-bh / 2, bh / 2];
    const A0 = L.boardA0, hd = L.hingeDepth;
    const n = 26;
    const ts = linspace(0, 1, n);
    const ch = JOINT_T / 2;
    const backCtrl: number[][] = [[A0, ch], [0.7 * A0, hd], [0.3 * A0, hd], [0, ch]];
    const cumulative = (p: number[][]) => {
      const out = [0];
      let prev = bezier(p, 0);
      for (let i = 1; i < n; i++) {
        const q = bezier(p, ts[i]);
        out.push(out[i - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
        prev = q;
      }
      return out;
    };
    const hingeUV = (side: 'front' | 'back') => {
      const P = cm.panel(side === 'front' ? 'hinge-front' : 'hinge-back');
      const cum = cumulative(side === 'front' ? this.frontJoint([0, L.thick - ch], hd, 0, ch) : backCtrl);
      const total = cum[n - 1] || 1;
      return (i: number, j: number): UV => {
        // distance from the spine side of the joint
        const fromSpine = side === 'front' ? cum[i] : total - cum[i];
        const X = side === 'front' ? P.x + (fromSpine / total) * P.w : P.x + P.w - (fromSpine / total) * P.w;
        return [cm.u(X), cm.v(zs[j] + bh / 2)];
      };
    };
    const zero = (): UV => [0, 0];
    const back = new SheetMesh(ts, zs, JOINT_T, { top: hingeUV('back'), bottom: zero, edge: zero }, (mid) => {
      for (let j = 0; j < 2; j++) for (let i = 0; i < n; i++) {
        const q = bezier(backCtrl, ts[i]);
        mid[2 * (j * n + i)] = q[0];
        mid[2 * (j * n + i) + 1] = q[1];
      }
    });
    this.addSheet(back, [m.cover, m.lining, m.lining]);
    this.backJoint = back;
    this.hinge = new SheetMesh(ts, zs, JOINT_T, { top: hingeUV('front'), bottom: zero, edge: zero }, (mid) => this.poseJointCloth(mid, n, 0));
    this.addSheet(this.hinge, [m.cover, m.lining, m.lining]);
    // Endpaper hinge bridging the pastedown and the first leaf when the book is open.
    const gz = [-L.H / 2, L.H / 2];
    this.gutter = new SheetMesh(linspace(0, 1, GUTTER_N), gz, GUTTER_T, { top: zero, bottom: zero, edge: zero }, (mid) => this.poseGutter(mid, 0));
    this.addSheet(this.gutter, [m.endpaper, m.endpaper, m.endpaper], false);
    this.buildSpineCaps(m.lining);
    // Lying open, the first turned leaf crosses the spine's top edge over the joint cloth's arch
    // and the endpaper hinge on it: room for both above the board's line (thin boards sit low).
    const open = Math.PI + L.tilt;
    const ridge = this.gutterRidge(open) + GUTTER_T / 2 + 0.03;
    const p0 = this.rotateAboutPivot(L.boardA0, L.thick - L.bt, open), p1 = this.rotateAboutPivot(L.boardA0 + L.boardW, L.thick - L.bt, open);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], ul = Math.hypot(ux, uy) || 1;
    // Height of the ridge above the board's inner face, across the board, from where the hinge
    // steps up (before the cloth's arch) to the spine's edge.
    const up = ux / ul >= 0 ? 1 : -1;
    const above = (a: number) => (((a - p0[0]) * -uy + (ridge - p0[1]) * ux) / ul) * up;
    const d = Math.max(above(0), above(this.ridgeStep(open)));
    this.e0 = Math.max(this.e0, d + mm(0.02));
  }

  /**
   * Height (mid-plane) at which the endpaper hinge crosses the spine's top edge once the board
   * lies open: over the covering's edge and over the joint cloth arching up there.
   */
  /**
   * Where the endpaper hinge leaves the board's line to step up to its ridge, lying open: short
   * of the spine's edge, and before the joint cloth arches above that line.
   */
  private ridgeStep(theta: number): number {
    const L = this.L;
    const hg = GUTTER_T / 2 + 0.03;
    let aStep = -(L.bandH + mm(0.4));
    const h = this.hinge;
    if (!h) return aStep;
    const B = this.rotateAboutPivot(L.boardA0, L.thick - L.bt - hg, theta);
    const da = -Math.cos(theta), dy = -Math.sin(theta), slope = dy / Math.max(1e-6, da);
    const ka = L.off - hg - 0.05;
    const tmp = new Float64Array(2 * 2 * h.ns);
    this.poseJointCloth(tmp, h.ns, theta);
    for (let k = 0; k < h.ns; k++) {
      const ca = tmp[2 * k], cy = tmp[2 * k + 1];
      if (ca >= ka || ca < B[0]) continue;
      if (cy + h.half + hg + mm(0.03) > B[1] + slope * (ca - B[0])) aStep = Math.min(aStep, ca - mm(0.3));
    }
    return aStep;
  }

  private gutterRidge(theta: number): number {
    const L = this.L;
    const hg = GUTTER_T / 2 + 0.03;
    let Y = L.thick + hg + 0.1;
    const h = this.hinge;
    if (!h) return Y;
    const tmp = new Float64Array(2 * 2 * h.ns);
    this.poseJointCloth(tmp, h.ns, theta);
    const ka = L.off - hg - 0.05;
    for (let k = 0; k < h.ns; k++) {
      const a = tmp[2 * k], y = tmp[2 * k + 1];
      if (a > -(L.bandH + mm(1.5)) && a < ka) Y = Math.max(Y, y + h.half + hg + mm(0.03));
    }
    return Y;
  }

  /**
   * Head and tail of the spine region: the hollow behind the block, both joints and the endpaper
   * hinge, closed flush with the block's head and tail (as linings, headbands and glue close a
   * real book). Open, a grazing view along the spine looked right through the book. Re-posed with
   * the front joint.
   */
  private buildSpineCaps(mat: Material): void {
    const max = 160;
    const pos = new Float32Array(2 * max * 3);
    const nrm = new Float32Array(2 * max * 3);
    for (let i = 0; i < max; i++) {
      nrm[3 * i + 2] = 1;
      nrm[3 * (max + i) + 2] = -1;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(2 * max * 2), 2));
    const mesh = this.addMesh(geo, mat, this.group, false);
    mesh.frustumCulled = false;
    this.caps = { geo, pos, max };
    this.poseSpineCaps(0);
  }

  private poseSpineCaps(theta: number): void {
    const caps = this.caps, L = this.L;
    if (!caps || !this.hinge || !this.gutter || !this.backJoint) return;
    const pts: [number, number][] = [];
    // Inner (lining) side of a cloth, i0 → i1.
    const inner = (sh: SheetMesh, i0: number, i1: number) => {
      const o = sheetOutline(sh);
      const step = i1 >= i0 ? 1 : -1;
      for (let i = i0; step > 0 ? i <= i1 : i >= i1; i += step) pts.push([o.p[2 * i] - o.n[2 * i] * sh.half * 1.5, o.p[2 * i + 1] - o.n[2 * i + 1] * sh.half * 1.5]);
    };
    const thick = L.thick, A0 = L.boardA0;
    // Back board's spine edge, back joint (board → spine), the lining (back → front).
    pts.push([A0, L.bt]);
    inner(this.backJoint, 0, this.backJoint.ns - 1);
    const N = 24;
    for (let k = 0; k <= N; k++) {
      const o = spineOuter(L, k / N, 0);
      pts.push([o.p[0] - o.n[0] * L.spTh, Math.min(thick - L.liningClip, Math.max(L.liningClip, o.p[1] - o.n[1] * L.spTh))]);
    }
    // Front joint (spine → board), the board's spine edge, the endpaper hinge (board → block).
    inner(this.hinge, 0, this.hinge.ns - 1);
    pts.push(this.rotateAboutPivot(A0, thick - L.bt, theta));
    const g = this.gutter;
    for (let i = 0; i < g.ns; i++) pts.push([g.mid[2 * i], g.mid[2 * i + 1]]);
    // Down the block's spine (and the turning leaves' roots), just outside it.
    const e = mm(0.05);
    for (let k = 0; k <= 12; k++) {
      const y = L.tbY1 + ((L.tbY0 - L.tbY1) * k) / 12;
      pts.push([L.spineA(y) - e, y]);
    }
    // Drop repeats, then triangulate (consistent winding for each face).
    const contour: Vector2[] = [];
    for (const p of pts) {
      const q = contour[contour.length - 1];
      if (!q || Math.hypot(q.x - p[0], q.y - p[1]) > 1e-4) contour.push(new Vector2(p[0], p[1]));
    }
    const n = Math.min(contour.length, caps.max);
    contour.length = n;
    const tris = ShapeUtils.triangulateShape(contour, []);
    const z = L.H / 2 - e;
    const P = caps.pos, M = caps.max;
    for (let i = 0; i < n; i++) {
      P[3 * i] = contour[i].x; P[3 * i + 1] = contour[i].y; P[3 * i + 2] = z;
      P[3 * (M + i)] = contour[i].x; P[3 * (M + i) + 1] = contour[i].y; P[3 * (M + i) + 2] = -z;
    }
    const index: number[] = [];
    for (const [a, b, c] of tris) {
      const area = (contour[b].x - contour[a].x) * (contour[c].y - contour[a].y) - (contour[c].x - contour[a].x) * (contour[b].y - contour[a].y);
      // Head cap faces +z (counter-clockwise seen from +z), tail cap −z.
      if (area >= 0) index.push(a, b, c, M + a, M + c, M + b);
      else index.push(a, c, b, M + a, M + b, M + c);
    }
    caps.geo.setIndex(index);
    (caps.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  private rotateAboutPivot(a: number, y: number, theta: number): [number, number] {
    const L = this.L;
    const c = Math.cos(theta), s = Math.sin(theta);
    const da = a - L.pivotA, dy = y - L.pivotY;
    return [L.pivotA + c * da - s * dy, L.pivotY + s * da + c * dy];
  }

  /**
   * Control polygon of the front joint (cloth, or the jacket over it) from the spine edge `S` to
   * the front board's outer spine-side corner, `inset` below the outer surface. Closed it dips
   * into the french groove; as the board swings over it eases into a straight run, so it never
   * wraps through the rounded spine or the opened board's edge.
   */
  private frontJoint(S: [number, number], hd: number, theta: number, inset: number): number[][] {
    const L = this.L;
    const A0 = L.boardA0, top = L.thick - inset;
    const P3 = this.rotateAboutPivot(A0, top, theta);
    const c1: [number, number] = [S[0] + (A0 - S[0]) * 0.3, L.thick - hd];
    const c2 = this.rotateAboutPivot(S[0] + (A0 - S[0]) * 0.7, L.thick - hd, theta);
    const w = smoothstep(0.25 * Math.PI, 0.9 * Math.PI, theta);
    const mix = (p: number[], q: number[], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    // Opened, it leaves the spine bowing outward a little (clear of the rounded back).
    const dx = P3[0] - S[0], dy = P3[1] - S[1];
    const l = Math.hypot(dx, dy) || 1;
    const bow = Math.min(JOINT_T, 0.25 * l);
    const o1 = [S[0] + dx / 3 + (dy / l) * bow, S[1] + dy / 3 - (dx / l) * bow];
    return [S, mix(c1, o1, w), mix(c2, mix(S, P3, 2 / 3), w), P3];
  }

  private poseJointCloth(mid: Float64Array, n: number, theta: number): void {
    const p = this.frontJoint([0, this.L.thick - JOINT_T / 2], this.L.hingeDepth, theta, JOINT_T / 2);
    // Opened (not while it sits in the groove), keep clear of raised bands ramping up just below
    // the spine's top edge.
    const spine = this.spineOutline;
    const k = smoothstep(0.5 * Math.PI, 0.75 * Math.PI, theta);
    for (let i = 0; i < n; i++) {
      const q = bezier(p, i / (n - 1));
      if (spine && i > 0 && k > 0) {
        const c = closestOnPolyline(spine, q[0], q[1]);
        const need = JOINT_T / 2 + 0.05;
        const d = (q[0] - c.a) * c.na + (q[1] - c.y) * c.ny;
        if (c.inside && near(q[0], q[1], c, d) && d < need && d > -mm(1.5)) { q[0] += k * c.na * (need - d); q[1] += k * c.ny * (need - d); }
      }
      // Clear of the board itself up to its attachment at the board's spine edge: past ~150°
      // the curve meets that corner from inside the board's outline.
      if (i > 0 && i < n - 1) {
        const L = this.L;
        const cs = Math.cos(theta), sn = Math.sin(theta);
        const da = q[0] - L.pivotA, dy = q[1] - L.pivotY;
        const u = cs * da + sn * dy, v = -sn * da + cs * dy;
        const u0 = L.boardA0 - L.pivotA, hb = L.bt / 2, vc = L.thick - L.bt / 2 - L.pivotY, h = JOINT_T / 2 + mm(0.01);
        if (u > u0 - h && v > vc - hb - h && v < vc + hb + h) {
          // Out across the board's spine edge (toward the spine), or over its outer face.
          const outU = u - (u0 - h), outV = vc + hb + h - v;
          const uu = outU < outV ? u0 - h : u, vv = outU < outV ? v : vc + hb + h;
          q[0] = L.pivotA + cs * uu - sn * vv;
          q[1] = L.pivotY + sn * uu + cs * vv;
        }
      }
      for (let j = 0; j < 2; j++) {
        mid[2 * (j * n + i)] = q[0];
        mid[2 * (j * n + i) + 1] = q[1];
      }
    }
  }

  /**
   * Endpaper hinge: from the pastedown's spine edge (on the board) down beside the spine to the
   * first leaf. Once the board has swung past the spine, it first runs across at least as high as
   * the top of the spine, so it passes over the spine's covering instead of through it.
   */
  private poseGutter(mid: Float64Array, theta: number): void {
    const L = this.L;
    const hg = GUTTER_T / 2 + 0.03;
    const B = this.rotateAboutPivot(L.boardA0, L.thick - L.bt - hg, theta);
    const ka = L.off - hg - 0.05;
    const pts: [number, number][] = [B];
    if (B[0] < ka) {
      // Past the spine: keep to the pastedown's line toward the spine, but never below the top
      // of the spine's covering until past it (the turned leaves lie above this line).
      const da = -Math.cos(theta), dy = -Math.sin(theta);
      // Over the cloth's arch too, once the board lies (nearly) open.
      const Y = theta > 0.9 * Math.PI ? this.gutterRidge(theta) : L.thick + hg + 0.1;
      if (dy <= 0) {
        // Board still rising from the spine: its line descends toward the spine.
        const y1 = B[1] + ((ka - B[0]) * dy) / Math.max(1e-6, da);
        if (y1 >= Y) pts.push([ka, y1]);
        else {
          // Down to the spine's height where the board's line meets it, but no further out than
          // just past the spine's top edge: under the joint cloth, which bows out from that edge
          // to the board (an upright board's line runs outside the cloth).
          const t0 = Math.max(0, (Y - B[1]) / Math.min(-1e-9, dy));
          // ... and clear of the cloth's groove, which dips in past the spine's edge.
          let groove = 0;
          if (this.hinge) {
            const hm = this.hinge.mid;
            for (let k = 0; k < this.hinge.ns; k++) if (hm[2 * k + 1] < Y + mm(0.5)) groove = Math.max(groove, hm[2 * k] + this.hinge.half);
          }
          const aMin = Math.min(ka, Math.max(hg + mm(0.1), groove + hg + mm(0.08)));
          const a1 = Math.max(B[0] + t0 * da, aMin);
          if (a1 < ka - 1e-6 && Math.hypot(a1 - B[0], Y - B[1]) > 1e-6) pts.push([a1, Y]);
          pts.push([ka, Y]);
        }
      } else {
        // Tilted past 180° (lying open): the line climbs toward the spine; follow it to just
        // short of the spine, then step up over the covering's top edge.
        const aq = Math.max(B[0], Math.min(ka - mm(0.5), this.ridgeStep(theta)));
        const yq = Math.min(Math.max(Y, B[1]), B[1] + (dy / Math.max(1e-6, da)) * (aq - B[0]));
        if (aq > B[0] + 1e-6) pts.push([aq, yq]);
        const Y2 = Math.max(Y, yq);
        if (Y2 > yq + 1e-6) pts.push([Math.min(ka - mm(0.1), aq + mm(0.25)), Y2]);
        pts.push([ka, Y2]);
      }
    }
    const last = pts[pts.length - 1];
    pts.push([ka, Math.min(L.tbY1 + hg, last[1] - 0.05)]);
    // Spread the samples over the segments by length, keeping every corner.
    const n = GUTTER_N, m = pts.length - 1;
    const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const total = lens.reduce((x, y) => x + y, 0) || 1;
    const counts = lens.map(() => 1);
    let spare = n - 1 - m;
    const order = lens.map((l, i) => ({ l, i })).sort((x, y) => y.l - x.l);
    for (const { l, i } of order) {
      const c = Math.min(spare, Math.floor(((n - 1 - m) * l) / total));
      counts[i] += c;
      spare -= c;
    }
    counts[order[0].i] += spare;
    let i = 0;
    const put = (a: number, y: number) => {
      for (let j = 0; j < 2; j++) {
        mid[2 * (j * n + i)] = a;
        mid[2 * (j * n + i) + 1] = y;
      }
      i++;
    };
    for (let g = 0; g < m; g++) {
      const P = pts[g], Q = pts[g + 1];
      for (let c = 0; c < counts[g]; c++) put(P[0] + ((Q[0] - P[0]) * c) / counts[g], P[1] + ((Q[1] - P[1]) * c) / counts[g]);
    }
    put(pts[m][0], pts[m][1]);
    // Under the joint cloth all the way: on its lining side, clear of its thickness (where the
    // cloth bulges toward the block, or rises over the spine's top edge, the path above can graze it).
    const h = this.hinge;
    if (h) {
      const cloth = sheetOutline(h);
      const need = h.half + hg + mm(0.03);
      for (let it = 0; it < 3; it++) for (let k = 1; k < n; k++) {
        const a = mid[2 * k], y = mid[2 * k + 1];
        const q = closestOnPolyline(cloth, a, y);
        const d = (a - q.a) * q.na + (y - q.y) * q.ny;
        if (q.inside && near(a, y, q, d) && d > -need && d < need + mm(1)) {
          const sh = -need - d;
          for (let j = 0; j < 2; j++) {
            mid[2 * (j * n + k)] = a + q.na * sh;
            mid[2 * (j * n + k) + 1] = y + q.ny * sh;
          }
        }
      }
    }
  }

  private poseCaseBoard(theta: number): void {
    if (this.frontPivot) this.frontPivot.rotation.z = theta;
    if (this.hinge) {
      this.poseJointCloth(this.hinge.mid, this.hinge.ns, theta);
      this.hinge.update();
    }
    if (this.gutter) {
      this.poseGutter(this.gutter.mid, theta);
      this.gutter.update();
    }
    this.poseSpineCaps(theta);
  }

  /* ----------------------------- coptic ----------------------------- */

  private buildCoptic(stations: number[]): void {
    const L = this.L, m = this.mats;
    const coverMats = [m.cover, m.endpaper, m.coverFront];
    this.addMesh(buildBoard(L, 'back'), coverMats);
    const pivot = this.boardPivot();
    const front = this.addMesh(buildBoard(L, 'front'), coverMats, pivot);
    front.position.set(-L.pivotA, -L.pivotY, 0);
    this.frontPivot = pivot;
    const chains = buildCopticChains(L, stations);
    if (chains.spine) this.addMesh(chains.spine, m.thread);
    if (chains.front) {
      const f = this.addMesh(chains.front, m.thread, pivot);
      f.position.set(-L.pivotA, -L.pivotY, 0);
    }
  }

  /* ------------------------------ soft ------------------------------ */

  private buildSoft(holes: { x: number; y: number }[]): void {
    const L = this.L, m = this.mats, cm = L.cover;
    const cc = L.cc, W = L.W, F = L.flap;
    const Lc = (Math.PI * cc) / 4;
    const Lf = (Math.PI * cc) / 2;
    const stab = L.type === 'stab';
    interface Seg { kind: string; len: number; p0: number; p1: number; x0: number; x1: number; local: number[] }
    const segs: Seg[] = [];
    const bf = cm.panel('back-flap'), bk = cm.panel('back'), sp = cm.panel('spine'), fr = cm.panel('front'), ff = cm.panel('front-flap');
    const add = (kind: string, len: number, p0: number, p1: number, x0: number, x1: number, n: number, extra: number[] = []) => {
      const local = mergeSamples(linspace(0, len, n + 1).slice(0, n), extra.filter((v) => v > 0 && v < len));
      segs.push({ kind, len, p0, p1, x0, x1, local });
    };
    const PI = Math.PI;
    if (F > 0) {
      add('flapB', Math.max(1, F - Lf / 2), TAU, TAU, bf.x, bk.x - Lf / 2, 16);
      add('foldB', Lf, TAU, PI, bk.x - Lf / 2, bk.x + Lf / 2, 8);
    }
    add('back', W, PI, PI, F > 0 ? bk.x + Lf / 2 : bk.x, sp.x - Lc / 2, 4);
    add('cornerB', Lc, PI, PI / 2, sp.x - Lc / 2, sp.x + Lc / 2, 6);
    // The spine spans the block plus the room kept under the covers for flaps (L.clr).
    add('spine', L.thick - 2 * cc, PI / 2, PI / 2, sp.x + Lc / 2, fr.x - Lc / 2, 3);
    add('cornerF', Lc, PI / 2, 0, fr.x - Lc / 2, fr.x + Lc / 2, 8);
    // Dense samples over the crease (stab) and over the droop onto the ground when lying open.
    const creaseExtra = stab ? linspace(L.creaseM, L.creaseM + PI * L.creaseR, 32) : [];
    const droop0 = stab ? 2 * L.creaseM + PI * L.creaseR + cc : 0;
    // (Fine enough that the leaves landing on it, sampled on their own, don't cut its chords.)
    creaseExtra.push(...linspace(droop0, droop0 + L.droop.D, Math.max(48, Math.min(160, Math.ceil(L.droop.D / mm(0.8))))));
    add('front', W, 0, 0, fr.x + Lc / 2, F > 0 ? ff.x - Lf / 2 : fr.x + fr.w, 44, creaseExtra);
    if (F > 0) {
      add('foldF', Lf, 0, -PI, ff.x - Lf / 2, ff.x + Lf / 2, 8);
      // The flap lies on the front panel (mirrored from the fore-edge): sampled as finely where the
      // panel droops to the ground, so it bends with it (a coarse chord stands proud into the
      // pages landing on it).
      add('flapF', Math.max(1, F - Lf / 2), -PI, -PI, ff.x + Lf / 2, ff.x + ff.w, 24, creaseExtra.map((v) => W - v));
    }
    const s: number[] = [], phi: number[] = [], X: number[] = [];
    const start: Record<string, number> = {};
    let acc = 0;
    for (const sg of segs) {
      start[sg.kind] = acc;
      for (const l of sg.local) {
        s.push(acc + l);
        phi.push(sg.p0 + ((sg.p1 - sg.p0) * l) / sg.len);
        X.push(sg.x0 + ((sg.x1 - sg.x0) * l) / sg.len);
      }
      acc += sg.len;
    }
    const last = segs[segs.length - 1];
    s.push(acc);
    phi.push(last.p1);
    X.push(last.x1);
    const anchor = s.indexOf(start.cornerF);
    const creaseStart = stab ? start.front + L.creaseM : start.cornerF;
    const creaseLen = stab ? PI * L.creaseR : Lc;
    const curlStart = creaseStart + creaseLen;
    const frontEnd = start.front + W;
    const droopStart = stab ? curlStart + L.creaseM + cc : curlStart;
    const H = L.H;
    const zs = [-H / 2, H / 2];
    const zero = (): UV => [0, 0];
    const basePhi = Float64Array.from(phi);
    // The pose must exist before the sheet winds its triangles, so it is set in `init`.
    const sheet = new SheetMesh(s, zs, cc, { top: (i, j) => [cm.u(X[i]), cm.v(zs[j] + H / 2)], bottom: zero, edge: zero }, (_mid, sh) => {
      this.soft = {
        sheet: sh, basePhi, anchor, creaseStart, creaseLen, curlStart, frontEnd, droopStart,
        flapStart: F > 0 ? frontEnd + Lf : Infinity,
        sBack0: start.back, sSpine0: start.cornerB + Lc / 2, sSpine1: start.cornerF + Lc / 2, last: '',
      };
      this.poseSoftCover(0, 1);
    }, (i) => (s[i] >= start.front - 1e-6 && s[i + 1] <= frontEnd + 1e-6 ? 3 : 0));
    this.addSheet(sheet, [m.cover, m.coverStock, m.coverStock, m.coverFront]);
    if (stab) {
      const thread = buildStabThread(L, holes);
      if (thread) this.addMesh(thread, m.thread);
    }
  }

  private poseSoftCover(open: number, gravity: number): void {
    const rig = this.soft;
    if (!rig) return;
    // Exact keys: a re-posed frame must reproduce its vertices bit for bit (video export).
    const key = `${open}|${gravity}`;
    if (key === rig.last) return;
    rig.last = key;
    const L = this.L;
    const { sheet } = rig;
    const { ns, nz, s, mid } = sheet;
    if (this.phi.length < ns) this.phi = new Float64Array(ns);
    const phi = this.phi;
    const theta = open * Math.PI;
    const lift = COVER_CURL * Math.sin(TAU * open);
    const dw = gravity * smoothstep(0.55, 1, open);
    const span = Math.max(1, rig.frontEnd - rig.curlStart);
    for (let i = 0; i < ns; i++) {
      const si = s[i];
      let p = rig.basePhi[i];
      if (si > rig.creaseStart) p += theta * clamp01((si - rig.creaseStart) / rig.creaseLen);
      // The French flap lies folded flat against the front panel: past the fold it mirrors the
      // panel's curl and droop, rather than running on straight and peeling into the leaves.
      const sm = si > rig.flapStart ? rig.frontEnd - (si - rig.flapStart) : Math.min(si, rig.frontEnd);
      if (sm > rig.curlStart) p += lift * Math.pow(clamp01((sm - rig.curlStart) / span), CURL_POW);
      if (dw > 0) p += dw * droopAngle(L.droop, sm - rig.droopStart);
      phi[i] = p;
    }
    for (let j = 0; j < nz; j++) integrateCurve(s, phi, rig.anchor, -L.cc / 2, L.thick - L.cc, mid, 2 * j * ns);
    // Never sink below the ground.
    for (let k = 1; k < mid.length; k += 2) if (mid[k] < L.cc / 2) mid[k] = L.cc / 2;
    sheet.update();
  }

  /* ------------------------------ block ----------------------------- */

  private buildBlock(deckle: boolean): void {
    const L = this.L, m = this.mats;
    const y1 = L.tbY1 - L.nTurn * L.c;
    if (y1 - L.tbY0 < 0.05) return;
    const spineTop = L.family === 'coptic' ? L.tbY1 : y1;
    this.addMesh(buildTextBlock(L, L.tbY0, y1, deckle, spineTop), [m.blockTop, m.paper, m.edge, m.paper]);
  }

  private buildLeaves(): void {
    const L = this.L, m = this.mats;
    const W = L.W, H = L.H;
    const zs = linspace(-H / 2, H / 2, 9);
    const aRoot = L.family === 'case' ? L.off : 0;
    const sc = Math.max(0, L.creaseA - aRoot);
    for (let k = 0; k < L.nTurn; k++) {
      const yRight = L.tbY1 - (k + 0.5) * L.c;
      // Dense samples over the gutter bend (its length varies a little with the board's tilt).
      const lying = this.leafBend(k, yRight, 1);
      const len = Math.max(this.leafBend(k, yRight, 0).len, lying.len) * 1.04;
      // (Fine: a chord across a tight bend, such as a stab crease, cuts into the cover round it.)
      const extra = linspace(sc, Math.min(W, sc + len), 40);
      // Soft covers: follow the cover's droop to the ground closely (its arc length on the leaf
      // stretches a little over the convex part, hence the 1.15). About every 0.8 mm: over the
      // convex part a longer chord sags into the cover or the leaf below.
      if (L.family === 'soft') {
        const dl = L.droop.D * 1.15;
        extra.push(...linspace(lying.sd, lying.sd + dl, Math.max(48, Math.min(160, Math.ceil(dl / mm(0.8))))).filter((v) => v < W));
      }
      const s = mergeSamples(linspace(0, W, 34), extra);
      const vHi = (yRight + L.c / 2 - L.tbY0) / L.T;
      const vLo = (yRight - L.c / 2 - L.tbY0) / L.T;
      const pageU = (si: number, front: boolean) => {
        const u = si / W;
        return front !== L.rtl ? u : 1 - u;
      };
      const edge = (e: SheetEdge, idx: number, onTop: boolean): UV => {
        const v = onTop ? vHi : vLo;
        return e === 'head' || e === 'tail' ? [s[idx] / EDGE_TILE, v] : [(zs[idx] + H / 2) / EDGE_TILE, v];
      };
      const sheet = new SheetMesh(s, zs, L.c * 0.9, {
        top: (i, j) => [pageU(s[i], true), 1 - (zs[j] + H / 2) / H],
        bottom: (i, j) => [pageU(s[i], false), 1 - (zs[j] + H / 2) / H],
        edge,
      }, (mid) => {
        for (let j = 0; j < zs.length; j++) for (let i = 0; i < s.length; i++) {
          mid[2 * (j * s.length + i)] = aRoot + s[i];
          mid[2 * (j * s.length + i) + 1] = yRight;
        }
      });
      const transparent = m.leafTransparent[k] ?? false;
      const mesh = this.addSheet(sheet, [m.leafFront[k], m.leafBack[k], m.edge], !transparent);
      this.leaves.push({ k, sheet, mesh, yRight, sc, x: 0, last: '' });
    }
  }

  /**
   * Gutter bend of leaf k. A turning leaf stays flat up to the crease (the spine fold; the
   * stitched strip of a stab binding), then bends through θ over a fixed length. The length is
   * chosen so that, fully turned, the leaf lies exactly e_k above the opened board's inner face
   * (or above the opened soft cover): all leaves then wrap one common centre in nested arcs
   * c apart, which keeps them apart at every angle in between too.
   */
  private leafBend(k: number, yR: number, gravity: number): LeafBend {
    const L = this.L;
    const e = this.e0 + (k + 0.5) * L.c;
    let out: LeafBend;
    if (L.family !== 'soft') {
      // Straight part after a bend of θb = π + τ about the crease, offset e from the inner face
      // of the board hinged at (pivotA, pivotY) on its mid-plane.
      const tau = gravity * L.tilt;
      const ca = L.creaseA;
      const rho = (e + L.bt / 2 + (ca - L.pivotA) * Math.sin(tau) - (yR - L.pivotY) * Math.cos(tau)) / (1 + Math.cos(tau));
      out = { thetaEnd: Math.PI + tau, len: Math.max(1e-3, rho) * (Math.PI + tau), offset: 0, sd: 0 };
    } else {
      const stab = L.type === 'stab';
      // Stab: round the stitched strip, concentric with the cover's crease. Otherwise round a
      // centre above the spine so the turned leaf lies e above the opened cover's top.
      const rho = stab ? L.centerY - yR : (L.thick + e - yR) / 2;
      const turned = yR + 2 * rho;
      const coverMid = stab ? 2 * L.centerY - (L.thick - L.cc / 2) : L.thick - L.cc / 2;
      const len = Math.max(1e-3, rho) * Math.PI;
      const sc = Math.max(0, L.creaseA);
      out = { thetaEnd: Math.PI, len, offset: turned - coverMid, sd: sc + len + L.creaseA + L.cc };
    }
    return out;
  }

  /** Refresh per-leaf flags that depend on the textures (vellum leaves don't cast shadows). */
  refreshLeafFlags(): void {
    for (const rig of this.leaves) rig.mesh.castShadow = !(this.mats.leafTransparent[rig.k] ?? false);
  }

  /** Leaves that blend (vellum), for back-to-front ordering by the renderer. */
  transparentLeaves(): { mesh: Mesh; k: number; center: [number, number, number] }[] {
    const out: { mesh: Mesh; k: number; center: [number, number, number] }[] = [];
    for (const rig of this.leaves) {
      if (!this.mats.leafTransparent[rig.k]) continue;
      const { mid, ns, nz } = rig.sheet;
      const q = 2 * (Math.floor(nz / 2) * ns + Math.floor(ns / 2));
      out.push({ mesh: rig.mesh, k: rig.k, center: [mid[q], mid[q + 1], 0] });
    }
    return out;
  }

  /** `amp`: curl amplitude (rad) at the free edge, before the head-to-tail twist. */
  private poseLeaf(rig: LeafRig, x: number, gravity: number, amp: number): void {
    // Exact keys: a re-posed frame must reproduce its vertices bit for bit (video export).
    const key = `${x}|${gravity}|${amp}`;
    rig.x = x;
    if (key === rig.last) return;
    rig.last = key;
    const L = this.L;
    const { sheet } = rig;
    const { ns, nz, s, mid } = sheet;
    if (this.phi.length < ns) this.phi = new Float64Array(ns);
    const phi = this.phi;
    const W = L.W;
    const soft = L.family === 'soft';
    const bend = this.leafBend(rig.k, rig.yRight, gravity);
    const theta = x * bend.thetaEnd;
    const s0 = rig.sc, s1 = rig.sc + bend.len;
    const span = Math.max(1, W - s1);
    // Lying soft covers: the turned leaf follows the cover's droop as a parallel curve.
    const dw = soft ? gravity * smoothstep(0.55, 1, x) : 0;
    const q = dw * bend.offset;
    const aRoot = L.family === 'case' ? L.off : 0;
    for (let j = 0; j < nz; j++) {
      const zn = (2 * j) / (nz - 1) - 1;
      const cj = amp * (1 + CURL_TWIST * zn);
      for (let i = 0; i < ns; i++) {
        const si = s[i];
        let p = si <= s0 ? 0 : si >= s1 ? theta : (theta * (si - s0)) / bend.len;
        if (si > s1 && cj !== 0) p += cj * Math.pow(clamp01((si - s1) / span), CURL_POW);
        if (dw > 0 && si > bend.sd) p += dw * droopAngle(L.droop, offsetDroopU(L, si - bend.sd, q));
        phi[i] = p;
      }
      integrateCurve(s, phi, 0, aRoot, rig.yRight, mid, 2 * j * ns);
    }
    if (soft) {
      // Turned onto the opened cover (left of the spine): never below its place in the stack.
      const floor = L.cc + this.e0 + (rig.k + 0.5) * L.c;
      for (let k = 1; k < mid.length; k += 2) if (mid[k] < floor && mid[k - 1] < -L.cc) mid[k] = floor;
    }
    sheet.update();
  }

  /**
   * Pose the book. `open` 0…1 (eased), `leaves[k]` 0…1 turn of leaf k (eased),
   * `gravity` 0 (standing) … 1 (lying: opened parts settle onto the ground).
   */
  setPose(open: number, leaves: number[], gravity: number): void {
    const L = this.L;
    const o = clamp01(open);
    this.openAmount = o;
    const key = `${o}|${gravity}`;
    if (L.family === 'soft') this.poseSoftCover(o, gravity);
    else if (key !== this.lastBoard) {
      this.lastBoard = key;
      this.boardTheta = o * (Math.PI + gravity * L.tilt);
      this.poseCaseBoard(this.boardTheta);
    }
    if (this.jacket && key !== this.lastJacket) {
      this.lastJacket = key;
      this.jacket.update();
    }
    // The leaf (or cover) ahead of each leaf: its turn angle and curl at the free edge.
    const thetaEnd = L.family === 'soft' ? Math.PI : Math.PI + gravity * L.tilt;
    let aheadTheta = o * thetaEnd;
    let aheadAmp = L.family === 'soft' ? COVER_CURL * Math.sin(TAU * o) : 0;
    let aheadIsLeaf = false;
    let prev = o;
    const tMax = 1 + CURL_TWIST, tMin = 1 - CURL_TWIST;
    for (const rig of this.leaves) {
      // A leaf can't be turned further than the one before it, nor further than the cover.
      const x = Math.min(clamp01(leaves[rig.k] ?? 0), prev);
      prev = x;
      const theta = x * thetaEnd;
      const room = Math.max(0, aheadTheta - theta);
      // Free curl while there's room; pressed flat against the leaf / cover ahead.
      let amp = LEAF_CURL * Math.sin(TAU * x) * smoothstep(0, CURL_ROOM, room);
      // Never curl past what's ahead, at any point from head to tail.
      if (aheadIsLeaf) amp = Math.min(amp, aheadAmp + room / tMax);
      else {
        const r = room + aheadAmp;
        amp = Math.min(amp, r >= 0 ? r / tMax : r / tMin);
      }
      this.poseLeaf(rig, x, gravity, amp);
      aheadTheta = theta;
      aheadAmp = amp;
      aheadIsLeaf = true;
    }
  }

  /**
   * On-screen density (px per pt) of every page face in view, of the front cover panel and of
   * the jacket's front panel, for the current pose: what their textures need to look sharp.
   * `toScreen` maps an a-space point to pixels (null when behind the camera), `view` is the
   * viewport (px) and `eye` the camera position in a-space. Neighbouring sample points count when
   * the segment between them crosses the view, so close-ups of a small part of a surface still
   * measure it. Pages hidden under other leaves are skipped.
   */
  textureDemand(toScreen: (a: number, y: number, z: number) => [number, number] | null, eye: [number, number, number], view: [number, number] = [1e9, 1e9]): TextureDensity {
    const L = this.L;
    const out: TextureDensity = { pages: new Map(), coverFront: 0, jacketFront: 0 };
    const bump = (page: number, d: number) => { if (d > (out.pages.get(page) ?? 0)) out.pages.set(page, d); };
    // Density of a grid of a-space points (rows × cols) with a facing test per point.
    const [vw, vh] = view;
    const mx = 0.075 * Math.min(vw, vh);
    const grid = (pts: { p: [number, number, number]; n: [number, number, number] }[][], take: (front: boolean, d: number) => void) => {
      const scr = pts.map((row) => row.map((q) => toScreen(q.p[0], q.p[1], q.p[2])));
      for (let j = 0; j < pts.length; j++) for (let i = 0; i < pts[j].length; i++) {
        const q = pts[j][i], sq = scr[j][i];
        if (!sq) continue;
        const front = (eye[0] - q.p[0]) * q.n[0] + (eye[1] - q.p[1]) * q.n[1] + (eye[2] - q.p[2]) * q.n[2] > 0;
        for (const [jj, ii] of [[j, i + 1], [j + 1, i]] as const) {
          const r = pts[jj]?.[ii], sr = scr[jj]?.[ii];
          if (!r || !sr) continue;
          if (Math.max(sq[0], sr[0]) < -mx || Math.min(sq[0], sr[0]) > vw + mx || Math.max(sq[1], sr[1]) < -mx || Math.min(sq[1], sr[1]) > vh + mx) continue;
          const dist = Math.hypot(r.p[0] - q.p[0], r.p[1] - q.p[1], r.p[2] - q.p[2]);
          if (dist > 1e-6) take(front, Math.hypot(sr[0] - sq[0], sr[1] - sq[1]) / dist);
        }
      }
    };
    const sheetGrid = (sh: SheetMesh, cols: number[], rows: number[], zOff = 0) => {
      const pos = sh.geometry.getAttribute('position').array as Float32Array;
      return rows.map((j) => cols.map((i) => {
        const q = 2 * (j * sh.ns + i), v = 3 * (j * sh.ns + i);
        const p: [number, number, number] = [sh.mid[q], sh.mid[q + 1], sh.z[j] + zOff];
        return { p, n: [pos[v] - p[0], pos[v + 1] - p[1], pos[v + 2] - sh.z[j]] as [number, number, number] };
      }));
    };
    /** A two-row (head / tail) sheet is ruled between its rows: sample `k` rows across it. */
    const ruledGrid = (sh: SheetMesh, cols: number[], zOff = 0, k = 5) => {
      const [a, b] = sheetGrid(sh, cols, [0, sh.nz - 1], zOff);
      return Array.from({ length: k }, (_, r) => {
        const f = r / (k - 1);
        return a.map((qa, c) => {
          const qb = b[c];
          const mixv = (u: [number, number, number], v: [number, number, number]): [number, number, number] => [u[0] + (v[0] - u[0]) * f, u[1] + (v[1] - u[1]) * f, u[2] + (v[2] - u[2]) * f];
          return { p: mixv(qa.p, qb.p), n: mixv(qa.n, qb.n) };
        });
      });
    };
    const spread = (n: number, k: number) => Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)));
    // Leaves: resting ones show only the top of each stack; leaves in flight show both faces.
    // A closed (or barely open) cover hides the pages.
    const coverShut = this.openAmount < 0.02;
    const resting = this.leaves.filter((r) => r.x <= 1e-4);
    const turned = this.leaves.filter((r) => r.x >= 1 - 1e-4);
    const firstRight = resting.length ? Math.min(...resting.map((r) => r.k)) : -1;
    const lastLeft = turned.length ? Math.max(...turned.map((r) => r.k)) : -1;
    for (const r of this.leaves) {
      if (coverShut) break;
      if (r.x <= 1e-4 && r.k !== firstRight) continue;
      if (r.x >= 1 - 1e-4 && r.k !== lastLeft) continue;
      const sh = r.sheet;
      const rows = sh.nz > 2 ? spread(sh.nz, Math.min(sh.nz, 7)) : [0, sh.nz - 1];
      const pts = sh.nz > 2 ? sheetGrid(sh, spread(sh.ns, 12), rows) : ruledGrid(sh, spread(sh.ns, 12), 0, 7);
      grid(pts, (front, d) => bump(2 * r.k + (front ? 0 : 1), d));
    }
    // The page on top of the static block, once every modelled leaf has moved off it.
    if (!coverShut && this.leaves.every((r) => r.x > 1e-4)) {
      const y1 = L.tbY1 - L.nTurn * L.c;
      const pts = [-1, -0.5, 0, 0.5, 1].map((zn) => [0, 0.25, 0.5, 0.75, 1].map((f) => {
        const a = L.spineA(y1) + (L.foreA(y1) - L.spineA(y1)) * f;
        return { p: [a, y1, (zn * L.H) / 2] as [number, number, number], n: [0, 1, 0] as [number, number, number] };
      }));
      grid(pts, (front, d) => { if (front) bump(2 * L.nTurn, d); });
    }
    // Front cover panel (hidden under a jacket that is on).
    const jacketOn = this.jacket !== null && Math.abs(this.jacket.mesh.position.z) < 0.5 * L.coverH;
    if (!jacketOn) {
      if (this.soft) {
        const sh = this.soft.sheet;
        const cols: number[] = [];
        for (let i = 0; i < sh.ns; i++) if (sh.s[i] >= this.soft.frontEnd - L.W - 1e-6 && sh.s[i] <= this.soft.frontEnd + 1e-6) cols.push(i);
        const pick = cols.length > 12 ? spread(cols.length, 12).map((k) => cols[k]) : cols;
        if (pick.length > 1) grid(ruledGrid(sh, pick), (front, d) => { if (front) out.coverFront = Math.max(out.coverFront, d); });
      } else {
        const th = this.boardTheta, c = Math.cos(th), sn = Math.sin(th);
        const rot = (a: number, y: number): [number, number] => {
          const da = a - L.pivotA, dy = y - L.pivotY;
          return [L.pivotA + c * da - sn * dy, L.pivotY + sn * da + c * dy];
        };
        const n: [number, number, number] = [-sn, c, 0];
        const pts = [0, 0.25, 0.5, 0.75, 1].map((fz) => [0, 0.25, 0.5, 0.75, 1].map((fa) => {
          const q = rot(L.boardA0 + L.boardW * fa, L.thick);
          return { p: [q[0], q[1], -L.boardH / 2 + L.boardH * fz] as [number, number, number], n };
        }));
        grid(pts, (front, d) => { if (front) out.coverFront = Math.max(out.coverFront, d); });
      }
    }
    // Jacket front panel.
    if (this.jacket) {
      const sh = this.jacket.sheet;
      const cols: number[] = [];
      for (let i = 0; i < sh.ns - 1; i++) if (this.jacket.isFront(i)) cols.push(i);
      const pick = cols.length > 12 ? spread(cols.length, 12).map((k) => cols[k]) : cols;
      if (pick.length > 1) grid(ruledGrid(sh, pick, this.jacket.mesh.position.z), (front, d) => { if (front) out.jacketFront = Math.max(out.jacketFront, d); });
    }
    return out;
  }

  get turnableLeaves(): number {
    return this.leaves.length;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const s of this.sheets) s.dispose();
    this.jacket?.dispose();
    this.group.clear();
  }
}
