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
  TubeGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm } from '../lib/random';
import { mm } from '../model/units';
import { EDGE_TILE, droopAngle, type BookLayout } from './layout';
import type { BookMaterials } from './materials';
import { SheetMesh, integrateCurve, linspace, mergeSamples, type SheetEdge, type UV } from './sheet';
import type { BookSceneInput } from './types';
import type { JacketCalc } from '../engine/binding';
import { JacketRig, jacketPanel, type JacketBase } from './jacket';

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

/** Covered board (case / coptic) in its closed position. Groups: 0 covering, 1 pastedown. */
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

  mb.face(0, [[A0, yOut, Z0], [A1, yOut, Z0], [A1, yOut, Z1], [A0, yOut, Z1]], [0, ny, 0], (p) => uv(Xp(p[0] - A0), p[2] - Z0));
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
    for (let i = 0; i < 2; i++) arc.push({ p: [0, thick * i], n: [-1, 0], t: thick * i });
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
    const a = arc[i], h = bump(zs[j]);
    return { p: [a.p[0] + a.n[0] * h, a.p[1] + a.n[1] * h, zs[j]], uv: [cm.u(X(a.t)), cm.v(zs[j] - Z0)] };
  }, (_p, i) => [arc[i].n[0], arc[i].n[1], 0]);
  const th = L.spTh;
  mb.grid(1, arc.length, 2, (i, j) => {
    const a = arc[i];
    return { p: [a.p[0] - a.n[0] * th, a.p[1] - a.n[1] * th, j === 0 ? Z0 : Z1], uv: [0, 0] };
  }, (_p, i) => [-arc[i].n[0], -arc[i].n[1], 0]);
  // Head and tail: the covering turned in over the spine stiffener.
  for (const [z, sign] of [[Z0, -1], [Z1, 1]] as const) {
    mb.grid(0, arc.length, 2, (i, j) => {
      const a = arc[i];
      const d = j === 0 ? -bump(z) : th;
      return { p: [a.p[0] - a.n[0] * d, a.p[1] - a.n[1] * d, z], uv: [cm.u(X(a.t)), cm.v(sign < 0 ? -d : bh + d)] };
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

/** Headband: silk-wrapped core glued to the head and tail of the spine. */
function buildHeadbands(L: BookLayout, headbandHeight: number, squares: number): BufferGeometry | null {
  const r = Math.max(mm(0.6), Math.min(headbandHeight / 2, squares * 0.45, mm(1.6)));
  const geos: BufferGeometry[] = [];
  for (const sign of [-1, 1]) {
    const z = sign * (L.H / 2 - r * 0.4);
    const pts: V3[] = linspace(L.tbY0 + r * 0.4, L.tbY1 - r * 0.4, 12).map((y) => [L.spineA(y) + r * 0.85, y, z]);
    geos.push(tube(pts, r));
  }
  return merge(geos);
}

/** Coptic link stitches: a chain at every station across the exposed section folds. */
function buildCopticChains(L: BookLayout, stations: number[]): { spine: BufferGeometry | null; front: BufferGeometry | null } {
  const S = L.sections;
  const ts = L.T / S;
  const r = Math.min(ts * 0.42, mm(2.5));
  const rt = L.threadR;
  const w = Math.min(Math.max(ts * 0.55, mm(0.8)), mm(2.2));
  const bt = L.bt, thick = L.thick;
  const spine: BufferGeometry[] = [];
  const front: BufferGeometry[] = [];
  for (const st of stations) {
    const zs = -L.H / 2 + st;
    for (const side of [1, -1]) {
      const pts: V3[] = [[mm(4), -rt, zs], [-rt * 0.6, -rt * 0.4, zs + side * w * 0.2], [-rt, bt * 0.5, zs + side * w * 0.4]];
      for (let j = 0; j < S; j++) {
        pts.push([-r - rt * 0.8, bt + (j + 0.5) * ts, zs]);
        if (j < S - 1) pts.push([-r * 0.35 - rt, bt + (j + 1) * ts, zs + side * w]);
      }
      pts.push([-rt, thick - bt * 0.5, zs + side * w * 0.4]);
      spine.push(tube(pts, rt));
    }
    front.push(tube([[-rt, thick - bt * 0.5, zs], [-rt * 0.6, thick + rt * 0.4, zs], [mm(1.5), thick + rt, zs], [mm(4), thick + rt * 0.6, zs]], rt));
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
  /** Stab binding: radius of this leaf's fold over the stitched strip. */
  rk: number;
  /** Arc length at which the gravity droop starts. */
  sd: number;
  last: string;
}

interface SoftCoverRig {
  sheet: SheetMesh;
  basePhi: Float64Array;
  anchor: number;
  creaseStart: number;
  creaseLen: number;
  curlStart: number;
  frontEnd: number;
  droopStart: number;
  /** Arc length at the back fore-edge, and at the back / front edges of the spine panel. */
  sBack0: number;
  sSpine0: number;
  sSpine1: number;
  last: string;
}

/** Extra clearance under turned leaves when a jacket flap lies on the pastedown / cover, pt. */
const JACKET_PAD = mm(0.6);

export interface BookBounds { a0: number; a1: number; y0: number; y1: number; z0: number; z1: number }

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
  private soft: SoftCoverRig | null = null;
  private phi: Float64Array = new Float64Array(0);
  private lastBoard = '';
  private boardTheta = 0;
  private jacket: JacketRig | null = null;
  private lastJacket = '';
  /** Pastedown/endpaper allowance under the first turned leaf, pt. */
  private readonly e0: number;
  private readonly pad: number;

  constructor(L: BookLayout, input: BookSceneInput, mats: BookMaterials) {
    this.L = L;
    this.mats = mats;
    const jc = input.jacket && mats.jacketOuter && mats.jacketInner ? input.jacket : null;
    this.pad = jc ? JACKET_PAD : 0;
    this.e0 = (L.flap > 0 ? 0.8 : 0.2) + this.pad;
    const { spec, calc } = input;
    if (L.family === 'case') this.buildCase(calc.bands, spec.binding.headband, calc.headbandHeight, spec.binding.squares);
    else if (L.family === 'coptic') this.buildCoptic(calc.stations);
    else this.buildSoft(calc.stabHoles);
    this.buildBlock(spec.cover.edge === 'deckle');
    this.buildLeaves();
    if (jc) this.buildJacket(jc);
    this.setPose(0, [], 1);
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
    this.jacket = new JacketRig(jc, L.rtl, base, [outer, inner, inner]);
    this.group.add(this.jacket.mesh);
  }

  /** Outside of back board → joint → spine → joint → front board (front part follows the board). */
  private boardJacketBase(jc: JacketCalc): JacketBase {
    const L = this.L;
    const A0 = L.boardA0, A1 = A0 + L.boardW, thick = L.thick;
    const Nb = 8, Nj = 8, Ns = 24;
    const hdJ = L.family === 'case' ? L.hingeDepth * 0.3 : 0;
    const count = Nb + Nj + Ns + Nj + Nb - 1;
    const spinePt = (f: number): [number, number] => {
      if (L.family === 'case' && L.rd > 1e-3) {
        const R = L.arcR, ac = L.arcAc;
        const psi0 = Math.asin(Math.min(1, thick / 2 / R));
        const psi = -psi0 + 2 * psi0 * f;
        const ca = Math.cos(psi), sa = Math.sin(psi);
        return [ac - R * ca - ca * L.bandH, thick / 2 + R * sa + sa * L.bandH];
      }
      const a = L.family === 'coptic' ? L.a0 : -L.bandH;
      return [a, thick * f];
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
      let i = 0;
      const put = (p: [number, number]) => { out[2 * i] = p[0]; out[2 * i + 1] = p[1]; i++; };
      for (let k = 0; k < Nb; k++) put([A1 - ((A1 - A0) * k) / (Nb - 1), 0]);
      const S0 = spinePt(0), S1 = spinePt(1);
      const back = [[A0, 0], [A0 + (S0[0] - A0) * 0.3, hdJ], [A0 + (S0[0] - A0) * 0.7, hdJ], S0];
      for (let k = 1; k <= Nj; k++) put(bez(back, k / Nj));
      for (let k = 1; k <= Ns; k++) put(spinePt(k / Ns));
      const front = [S1, [S1[0] + (A0 - S1[0]) * 0.3, thick - hdJ], rot(S1[0] + (A0 - S1[0]) * 0.7, thick - hdJ), rot(A0, thick)];
      for (let k = 1; k <= Nj; k++) put(bez(front, k / Nj));
      for (let k = 1; k < Nb; k++) put(rot(A0 + ((A1 - A0) * k) / (Nb - 1), thick));
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
    return { count, x, wrapT: L.bt, fill: (out) => fillAt(this.boardTheta, out) };
  }

  /** Outside of the soft cover (back fore-edge → front fore-edge), resampled from its pose. */
  private softJacketBase(jc: JacketCalc): JacketBase | null {
    const rig = this.soft;
    if (!rig) return null;
    const L = this.L;
    const count = 80;
    const sv = linspace(rig.sBack0, rig.frontEnd, count);
    const src = rig.sheet.s;
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
    const fill = (out: Float64Array) => {
      const mid = rig.sheet.mid;
      for (let i = 0; i < count; i++) {
        const k = seg[i];
        const t = Math.max(0, Math.min(1, (sv[i] - src[k]) / Math.max(1e-9, src[k + 1] - src[k])));
        tmp[2 * i] = mid[2 * k] + (mid[2 * k + 2] - mid[2 * k]) * t;
        tmp[2 * i + 1] = mid[2 * k + 1] + (mid[2 * k + 3] - mid[2 * k + 1]) * t;
      }
      // Outer surface of the cover: half its caliper along the left normal.
      const h = L.cc / 2;
      for (let i = 0; i < count; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(count - 1, i + 1);
        let ta = tmp[2 * i1] - tmp[2 * i0], ty = tmp[2 * i1 + 1] - tmp[2 * i0 + 1];
        const l = Math.hypot(ta, ty) || 1;
        ta /= l; ty /= l;
        out[2 * i] = tmp[2 * i] - ty * h;
        out[2 * i + 1] = tmp[2 * i + 1] + ta * h;
      }
    };
    return { count, x, wrapT: L.cc, fill };
  }

  /** Closed (open = 0) or fully open (open = 1) extents, used for camera framing. */
  bounds(open: number): BookBounds {
    const L = this.L;
    const zh = Math.max(L.coverH, L.H) / 2;
    const leftOpen = L.family === 'soft' ? -L.W - L.cc : 2 * L.pivotA - (L.boardA0 + L.boardW);
    const a0 = L.a0 + (Math.min(L.a0, leftOpen) - L.a0) * open;
    // Headroom for a leaf mid-turn, so the framing stays put while pages turn.
    // (and for a cover standing half open).
    const head = L.W * Math.max(0.5 * open, 0.9 * Math.sin(Math.PI * Math.min(1, open)));
    return { a0, a1: L.a1, y0: 0, y1: L.thick + head, z0: -zh, z1: zh };
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
    const coverMats = [m.cover, m.endpaper];
    this.addMesh(buildBoard(L, 'back'), coverMats);
    const pivot = this.boardPivot();
    const front = this.addMesh(buildBoard(L, 'front'), coverMats, pivot);
    front.position.set(-L.pivotA, -L.pivotY, 0);
    this.frontPivot = pivot;
    this.addMesh(buildCaseSpine(L, bands), [m.cover, m.lining]);
    if (headband) {
      const hb = buildHeadbands(L, headbandHeight, squares);
      if (hb) {
        this.addMesh(hb, m.headband);
        const len = Math.max(1, L.T);
        m.headbandTexture.repeat.set(len / mm(1.4), 1);
      }
    }
    // Cloth joints (french grooves) between spine and boards.
    const bh = L.boardH;
    const zs = [-bh / 2, bh / 2];
    const A0 = L.boardA0, hd = L.hingeDepth, thick = L.thick;
    const n = 14;
    const ts = linspace(0, 1, n);
    const ctrl = (side: 'front' | 'back'): number[][] => side === 'front'
      ? [[0, thick], [0.3 * A0, thick - hd], [0.7 * A0, thick - hd], [A0, thick]]
      : [[A0, 0], [0.7 * A0, hd], [0.3 * A0, hd], [0, 0]];
    const bez = (p: number[][], t: number): [number, number] => {
      const u = 1 - t;
      return [
        u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
        u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
      ];
    };
    const cumulative = (p: number[][]) => {
      const out = [0];
      let prev = bez(p, 0);
      for (let i = 1; i < n; i++) {
        const q = bez(p, ts[i]);
        out.push(out[i - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
        prev = q;
      }
      return out;
    };
    const hingeUV = (side: 'front' | 'back') => {
      const P = cm.panel(side === 'front' ? 'hinge-front' : 'hinge-back');
      const cum = cumulative(ctrl(side));
      const total = cum[n - 1] || 1;
      return (i: number, j: number): UV => {
        // distance from the spine side of the joint
        const fromSpine = side === 'front' ? cum[i] : total - cum[i];
        const X = side === 'front' ? P.x + (fromSpine / total) * P.w : P.x + P.w - (fromSpine / total) * P.w;
        return [cm.u(X), cm.v(zs[j] + bh / 2)];
      };
    };
    const zero = (): UV => [0, 0];
    const back = new SheetMesh(ts, zs, mm(0.35), { top: hingeUV('back'), bottom: zero, edge: zero }, (mid) => {
      const p = ctrl('back');
      for (let j = 0; j < 2; j++) for (let i = 0; i < n; i++) {
        const q = bez(p, ts[i]);
        mid[2 * (j * n + i)] = q[0];
        mid[2 * (j * n + i) + 1] = q[1];
      }
    });
    this.addSheet(back, [m.cover, m.lining, m.lining]);
    this.hinge = new SheetMesh(ts, zs, mm(0.35), { top: hingeUV('front'), bottom: zero, edge: zero }, (mid) => {
      const p = ctrl('front');
      for (let j = 0; j < 2; j++) for (let i = 0; i < n; i++) {
        const q = bez(p, ts[i]);
        mid[2 * (j * n + i)] = q[0];
        mid[2 * (j * n + i) + 1] = q[1];
      }
    });
    this.addSheet(this.hinge, [m.cover, m.lining, m.lining]);
    // Endpaper hinge bridging the pastedown and the first leaf when the book is open.
    const gz = [-L.H / 2, L.H / 2];
    this.gutter = new SheetMesh(linspace(0, 1, 8), gz, 0.25, { top: zero, bottom: zero, edge: zero }, (mid) => this.poseGutter(mid, 0));
    this.addSheet(this.gutter, [m.endpaper, m.endpaper, m.endpaper], false);
  }

  private rotateAboutPivot(a: number, y: number, theta: number): [number, number] {
    const L = this.L;
    const c = Math.cos(theta), s = Math.sin(theta);
    const da = a - L.pivotA, dy = y - L.pivotY;
    return [L.pivotA + c * da - s * dy, L.pivotY + s * da + c * dy];
  }

  private poseGutter(mid: Float64Array, theta: number): void {
    const L = this.L;
    const yIn = L.thick - L.bt;
    const B = this.rotateAboutPivot(L.boardA0, yIn, theta);
    const C: [number, number] = [L.off, L.tbY1];
    const sag = mm(1.2) * clamp01(theta / Math.PI);
    const n = 8;
    for (let j = 0; j < 2; j++) for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      mid[2 * (j * n + i)] = B[0] + (C[0] - B[0]) * t;
      mid[2 * (j * n + i) + 1] = B[1] + (C[1] - B[1]) * t - sag * 4 * t * (1 - t);
    }
  }

  private poseCaseBoard(theta: number): void {
    const L = this.L;
    if (this.frontPivot) this.frontPivot.rotation.z = theta;
    if (this.hinge) {
      const A0 = L.boardA0, hd = L.hingeDepth, thick = L.thick;
      const p = [[0, thick], [0.3 * A0, thick - hd], this.rotateAboutPivot(0.7 * A0, thick - hd, theta), this.rotateAboutPivot(A0, thick, theta)];
      const n = this.hinge.ns;
      const mid = this.hinge.mid;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1), u = 1 - t;
        const a = u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0];
        const y = u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1];
        for (let j = 0; j < 2; j++) {
          mid[2 * (j * n + i)] = a;
          mid[2 * (j * n + i) + 1] = y;
        }
      }
      this.hinge.update();
    }
    if (this.gutter) {
      this.poseGutter(this.gutter.mid, theta);
      this.gutter.update();
    }
  }

  /* ----------------------------- coptic ----------------------------- */

  private buildCoptic(stations: number[]): void {
    const L = this.L, m = this.mats;
    const coverMats = [m.cover, m.endpaper];
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
    const cc = L.cc, W = L.W, T = L.T, F = L.flap;
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
      add('flapB', Math.max(1, F - Lf / 2), TAU, TAU, bf.x, bk.x - Lf / 2, 6);
      add('foldB', Lf, TAU, PI, bk.x - Lf / 2, bk.x + Lf / 2, 8);
    }
    add('back', W, PI, PI, F > 0 ? bk.x + Lf / 2 : bk.x, sp.x - Lc / 2, 4);
    add('cornerB', Lc, PI, PI / 2, sp.x - Lc / 2, sp.x + Lc / 2, 6);
    add('spine', T, PI / 2, PI / 2, sp.x + Lc / 2, fr.x - Lc / 2, 3);
    add('cornerF', Lc, PI / 2, 0, fr.x - Lc / 2, fr.x + Lc / 2, 8);
    const creaseExtra = stab ? linspace(L.creaseM, L.creaseM + PI * L.creaseR, 16) : [];
    add('front', W, 0, 0, fr.x + Lc / 2, F > 0 ? ff.x - Lf / 2 : fr.x + fr.w, 44, creaseExtra);
    if (F > 0) {
      add('foldF', Lf, 0, -PI, ff.x - Lf / 2, ff.x + Lf / 2, 8);
      add('flapF', Math.max(1, F - Lf / 2), -PI, -PI, ff.x + Lf / 2, ff.x + ff.w, 8);
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
        sBack0: start.back, sSpine0: start.cornerB + Lc / 2, sSpine1: start.cornerF + Lc / 2, last: '',
      };
      this.poseSoftCover(0, 1);
    });
    this.addSheet(sheet, [m.cover, m.coverStock, m.coverStock]);
    if (stab) {
      const thread = buildStabThread(L, holes);
      if (thread) this.addMesh(thread, m.thread);
    }
  }

  private poseSoftCover(open: number, gravity: number): void {
    const rig = this.soft;
    if (!rig) return;
    const key = `${open.toFixed(5)}|${gravity.toFixed(4)}`;
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
      if (si > rig.curlStart) p += lift * Math.pow(clamp01((si - rig.curlStart) / span), 1.5);
      if (dw > 0) p += dw * droopAngle(L.droop, si - rig.droopStart);
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
    const stab = L.type === 'stab';
    const zs = linspace(-H / 2, H / 2, 9);
    const aRoot = L.family === 'case' ? L.off : 0;
    for (let k = 0; k < L.nTurn; k++) {
      const yRight = L.tbY1 - (k + 0.5) * L.c;
      const rk = stab ? L.centerY - yRight : 0;
      const s = stab
        ? mergeSamples(linspace(0, W, 34), linspace(L.creaseM, L.creaseM + Math.PI * rk, 14))
        : linspace(0, W, 36);
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
      const sd = stab ? 2 * L.creaseM + Math.PI * rk + L.cc : L.cc;
      this.leaves.push({ k, sheet, mesh, yRight, rk, sd, last: '' });
    }
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

  private poseLeaf(rig: LeafRig, x: number, gravity: number): void {
    const key = `${x.toFixed(5)}|${gravity.toFixed(4)}`;
    if (key === rig.last) return;
    rig.last = key;
    const L = this.L;
    const { sheet } = rig;
    const { ns, nz, s, mid } = sheet;
    if (this.phi.length < ns) this.phi = new Float64Array(ns);
    const phi = this.phi;
    const W = L.W;
    const stab = L.type === 'stab';
    const soft = L.family === 'soft';
    const tilt = soft ? 0 : gravity * L.tilt;
    const thetaEnd = Math.PI + tilt;
    const theta = x * thetaEnd;
    const lift = LEAF_CURL * Math.sin(TAU * x);
    const dw = soft ? gravity * smoothstep(0.55, 1, x) : 0;
    // Pivot travels from the right-hand stack to the left-hand stack.
    let pa: number, py: number;
    if (stab) {
      pa = 0;
      py = rig.yRight;
    } else {
      const aRoot = L.family === 'case' ? L.off : 0;
      let la: number, ly: number;
      if (soft) {
        la = 0;
        ly = L.thick + (L.flap > 0 ? L.cc : 0) + this.pad + (rig.k + 0.5) * L.c;
      } else {
        const e = this.e0 + (rig.k + 0.5) * L.c;
        la = L.pivotA - Math.sin(tilt) * e;
        ly = L.pivotY + Math.cos(tilt) * e;
      }
      pa = aRoot + (la - aRoot) * x;
      py = rig.yRight + (ly - rig.yRight) * x;
    }
    const bendLen = stab ? Math.PI * rig.rk : 0;
    const curl0 = stab ? L.creaseM + bendLen : 0;
    const span = Math.max(1, W - curl0);
    for (let j = 0; j < nz; j++) {
      const zn = (2 * j) / (nz - 1) - 1;
      const cj = lift * (1 + 0.35 * zn);
      for (let i = 0; i < ns; i++) {
        const si = s[i];
        let p = stab ? (si <= L.creaseM ? 0 : theta * clamp01((si - L.creaseM) / bendLen)) : theta;
        if (si > curl0) p += cj * Math.pow(clamp01((si - curl0) / span), 1.6);
        if (dw > 0) p += dw * droopAngle(L.droop, si - rig.sd);
        phi[i] = p;
      }
      integrateCurve(s, phi, 0, pa, py, mid, 2 * j * ns);
    }
    if (soft) {
      const floor = L.cc * (L.flap > 0 ? 2 : 1) + this.pad + (rig.k + 0.5) * L.c;
      for (let k = 1; k < mid.length; k += 2) if (mid[k] < floor) mid[k] = floor;
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
    if (L.family === 'soft') this.poseSoftCover(o, gravity);
    else {
      const key = `${o.toFixed(5)}|${gravity.toFixed(4)}`;
      if (key !== this.lastBoard) {
        this.lastBoard = key;
        this.boardTheta = o * (Math.PI + gravity * L.tilt);
        this.poseCaseBoard(this.boardTheta);
      }
    }
    if (this.jacket) {
      const key = `${o.toFixed(5)}|${gravity.toFixed(4)}`;
      if (key !== this.lastJacket) {
        this.lastJacket = key;
        this.jacket.update();
      }
    }
    let prev = o;
    for (const rig of this.leaves) {
      // A leaf can't be turned further than the one before it, nor further than the cover.
      const x = Math.min(clamp01(leaves[rig.k] ?? 0), prev);
      prev = x;
      this.poseLeaf(rig, x, gravity);
    }
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
