/**
 * Bendable sheets (leaves, soft covers, cloth joints): a thin slab whose mid-surface is
 * re-posed on the CPU every time the book moves. The mid-surface is a grid of samples
 * s (across the sheet) × z (head → tail); each sample is a point (a, y) in a-space.
 * The slab is emitted as a top surface (offset +½ thickness along the normal), a bottom
 * surface (−½) and four edge strips, in three material groups: 0 top, 1 bottom, 2 edges.
 */
import { BufferAttribute, BufferGeometry } from 'three';

export type UV = readonly [number, number];
export type SheetEdge = 'head' | 'tail' | 'spine' | 'fore';

export interface SheetUVs {
  top: (i: number, j: number) => UV;
  bottom: (i: number, j: number) => UV;
  /** k = sample index along the edge (i for head/tail, j for spine/fore). */
  edge: (edge: SheetEdge, k: number, onTop: boolean) => UV;
}

/**
 * Integrate a planar curve from its tangent angles (radians, measured in the a–y plane from +a).
 * Uses the exact chord of a circular arc between samples, so constant-curvature bends are exact.
 */
export function integrateCurve(
  s: ArrayLike<number>, phi: ArrayLike<number>, anchor: number,
  a0: number, y0: number, out: Float64Array, offset: number,
): void {
  const n = s.length;
  out[offset + 2 * anchor] = a0;
  out[offset + 2 * anchor + 1] = y0;
  const chord = (i: number) => {
    const ds = s[i] - s[i - 1];
    const dp = phi[i] - phi[i - 1];
    const k = Math.abs(dp) < 1e-6 ? 1 : Math.sin(dp / 2) / (dp / 2);
    const mean = (phi[i] + phi[i - 1]) / 2;
    return [ds * k * Math.cos(mean), ds * k * Math.sin(mean)];
  };
  for (let i = anchor + 1; i < n; i++) {
    const [da, dy] = chord(i);
    out[offset + 2 * i] = out[offset + 2 * (i - 1)] + da;
    out[offset + 2 * i + 1] = out[offset + 2 * (i - 1) + 1] + dy;
  }
  for (let i = anchor - 1; i >= 0; i--) {
    const [da, dy] = chord(i + 1);
    out[offset + 2 * i] = out[offset + 2 * (i + 1)] - da;
    out[offset + 2 * i + 1] = out[offset + 2 * (i + 1) + 1] - dy;
  }
}

/** Merge sorted sample positions, dropping near-duplicates. */
export function mergeSamples(...lists: number[][]): number[] {
  const all = lists.flat().sort((p, q) => p - q);
  const out: number[] = [];
  for (const v of all) if (out.length === 0 || v - out[out.length - 1] > 1e-4) out.push(v);
  return out;
}

export function linspace(a: number, b: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(n === 1 ? a : a + ((b - a) * i) / (n - 1));
  return out;
}

export class SheetMesh {
  readonly geometry = new BufferGeometry();
  readonly ns: number;
  readonly nz: number;
  readonly s: Float64Array;
  readonly z: Float64Array;
  /** Mid-surface (a, y) per z-row: index 2·(j·ns + i). Write it, then call `update()`. */
  readonly mid: Float64Array;
  half: number;
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly mn: Float64Array;
  private readonly ts: Float64Array;
  private readonly tz: Float64Array;
  private readonly offTop: number;
  private readonly offBot: number;
  private readonly offHead: number;
  private readonly offTail: number;
  private readonly offSpine: number;
  private readonly offFore: number;

  /**
   * `topGroup` (optional) picks the material group of the top-surface quad between samples i and
   * i + 1 (default 0), so a panel of a sheet can carry its own material.
   */
  constructor(s: ArrayLike<number>, z: ArrayLike<number>, thickness: number, uvs: SheetUVs, init: (mid: Float64Array, sheet: SheetMesh) => void, private readonly topGroup?: (i: number) => number) {
    this.ns = s.length;
    this.nz = z.length;
    this.s = Float64Array.from(s);
    this.z = Float64Array.from(z);
    this.half = thickness / 2;
    const ns = this.ns, nz = this.nz;
    this.mid = new Float64Array(ns * nz * 2);
    this.mn = new Float64Array(ns * nz * 3);
    this.ts = new Float64Array(ns * nz * 3);
    this.tz = new Float64Array(ns * nz * 3);
    this.offTop = 0;
    this.offBot = ns * nz;
    this.offHead = 2 * ns * nz;
    this.offTail = this.offHead + 2 * ns;
    this.offSpine = this.offTail + 2 * ns;
    this.offFore = this.offSpine + 2 * nz;
    const count = this.offFore + 2 * nz;
    this.pos = new Float32Array(count * 3);
    this.nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const setUV = (v: number, t: UV) => { uv[2 * v] = t[0]; uv[2 * v + 1] = t[1]; };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < ns; i++) {
        setUV(this.offTop + j * ns + i, uvs.top(i, j));
        setUV(this.offBot + j * ns + i, uvs.bottom(i, j));
      }
    }
    for (let i = 0; i < ns; i++) {
      setUV(this.offHead + 2 * i, uvs.edge('head', i, true));
      setUV(this.offHead + 2 * i + 1, uvs.edge('head', i, false));
      setUV(this.offTail + 2 * i, uvs.edge('tail', i, true));
      setUV(this.offTail + 2 * i + 1, uvs.edge('tail', i, false));
    }
    for (let j = 0; j < nz; j++) {
      setUV(this.offSpine + 2 * j, uvs.edge('spine', j, true));
      setUV(this.offSpine + 2 * j + 1, uvs.edge('spine', j, false));
      setUV(this.offFore + 2 * j, uvs.edge('fore', j, true));
      setUV(this.offFore + 2 * j + 1, uvs.edge('fore', j, false));
    }
    this.geometry.setAttribute('position', new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(this.nrm, 3));
    this.geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    init(this.mid, this);
    this.update();
    this.buildIndex();
  }

  /** Recompute the slab from `mid`. */
  update(): void {
    const { ns, nz, mid, z, mn, ts, tz, pos, nrm, half } = this;
    const P = (i: number, j: number, k: 0 | 1 | 2) => (k === 2 ? z[j] : mid[2 * (j * ns + i) + k]);
    for (let j = 0; j < nz; j++) {
      const jA = Math.max(0, j - 1), jB = Math.min(nz - 1, j + 1);
      for (let i = 0; i < ns; i++) {
        const iA = Math.max(0, i - 1), iB = Math.min(ns - 1, i + 1);
        const q = 3 * (j * ns + i);
        let sx = P(iB, j, 0) - P(iA, j, 0), sy = P(iB, j, 1) - P(iA, j, 1), sz = 0;
        let zx = P(i, jB, 0) - P(i, jA, 0), zy = P(i, jB, 1) - P(i, jA, 1), zz = P(i, jB, 2) - P(i, jA, 2);
        let l = Math.hypot(sx, sy, sz) || 1;
        sx /= l; sy /= l; sz /= l;
        l = Math.hypot(zx, zy, zz) || 1;
        zx /= l; zy /= l; zz /= l;
        // n = tz × ts  (up for a flat sheet whose s runs along +a)
        let nx = zy * sz - zz * sy, ny = zz * sx - zx * sz, nz2 = zx * sy - zy * sx;
        l = Math.hypot(nx, ny, nz2) || 1;
        nx /= l; ny /= l; nz2 /= l;
        mn[q] = nx; mn[q + 1] = ny; mn[q + 2] = nz2;
        ts[q] = sx; ts[q + 1] = sy; ts[q + 2] = sz;
        tz[q] = zx; tz[q + 1] = zy; tz[q + 2] = zz;
      }
    }
    const put = (v: number, x: number, y: number, zz: number, nx: number, ny: number, nz2: number) => {
      pos[3 * v] = x; pos[3 * v + 1] = y; pos[3 * v + 2] = zz;
      nrm[3 * v] = nx; nrm[3 * v + 1] = ny; nrm[3 * v + 2] = nz2;
    };
    const vert = (i: number, j: number, top: boolean, v: number, nx: number, ny: number, nz2: number) => {
      const q = 3 * (j * ns + i);
      const sg = top ? half : -half;
      put(v, mid[2 * (j * ns + i)] + mn[q] * sg, mid[2 * (j * ns + i) + 1] + mn[q + 1] * sg, z[j] + mn[q + 2] * sg, nx, ny, nz2);
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < ns; i++) {
        const q = 3 * (j * ns + i);
        vert(i, j, true, this.offTop + j * ns + i, mn[q], mn[q + 1], mn[q + 2]);
        vert(i, j, false, this.offBot + j * ns + i, -mn[q], -mn[q + 1], -mn[q + 2]);
      }
    }
    for (let i = 0; i < ns; i++) {
      let q = 3 * i;
      vert(i, 0, true, this.offHead + 2 * i, -tz[q], -tz[q + 1], -tz[q + 2]);
      vert(i, 0, false, this.offHead + 2 * i + 1, -tz[q], -tz[q + 1], -tz[q + 2]);
      q = 3 * ((nz - 1) * ns + i);
      vert(i, nz - 1, true, this.offTail + 2 * i, tz[q], tz[q + 1], tz[q + 2]);
      vert(i, nz - 1, false, this.offTail + 2 * i + 1, tz[q], tz[q + 1], tz[q + 2]);
    }
    for (let j = 0; j < nz; j++) {
      let q = 3 * (j * ns);
      vert(0, j, true, this.offSpine + 2 * j, -ts[q], -ts[q + 1], -ts[q + 2]);
      vert(0, j, false, this.offSpine + 2 * j + 1, -ts[q], -ts[q + 1], -ts[q + 2]);
      q = 3 * (j * ns + ns - 1);
      vert(ns - 1, j, true, this.offFore + 2 * j, ts[q], ts[q + 1], ts[q + 2]);
      vert(ns - 1, j, false, this.offFore + 2 * j + 1, ts[q], ts[q + 1], ts[q + 2]);
    }
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('normal') as BufferAttribute).needsUpdate = true;
  }

  /** Triangles are wound once, against the first pose, so each faces along its vertex normals. */
  private buildIndex(): void {
    const { ns, nz, pos, nrm } = this;
    const groups: number[][] = [[], [], []];
    const tri = (g: number, a: number, b: number, c: number) => {
      while (groups.length <= g) groups.push([]);
      const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
      const ux = pos[3 * b] - ax, uy = pos[3 * b + 1] - ay, uz = pos[3 * b + 2] - az;
      const vx = pos[3 * c] - ax, vy = pos[3 * c + 1] - ay, vz = pos[3 * c + 2] - az;
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      const rx = nrm[3 * a] + nrm[3 * b] + nrm[3 * c];
      const ry = nrm[3 * a + 1] + nrm[3 * b + 1] + nrm[3 * c + 1];
      const rz = nrm[3 * a + 2] + nrm[3 * b + 2] + nrm[3 * c + 2];
      if (gx * rx + gy * ry + gz * rz < 0) groups[g].push(a, c, b); else groups[g].push(a, b, c);
    };
    const quad = (g: number, a: number, b: number, c: number, d: number) => { tri(g, a, b, c); tri(g, a, c, d); };
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < ns - 1; i++) {
        const v = (o: number, ii: number, jj: number) => o + jj * ns + ii;
        quad(this.topGroup ? this.topGroup(i) : 0, v(this.offTop, i, j), v(this.offTop, i + 1, j), v(this.offTop, i + 1, j + 1), v(this.offTop, i, j + 1));
        quad(1, v(this.offBot, i, j), v(this.offBot, i + 1, j), v(this.offBot, i + 1, j + 1), v(this.offBot, i, j + 1));
      }
    }
    for (let i = 0; i < ns - 1; i++) {
      let o = this.offHead;
      quad(2, o + 2 * i, o + 2 * i + 1, o + 2 * i + 3, o + 2 * i + 2);
      o = this.offTail;
      quad(2, o + 2 * i, o + 2 * i + 1, o + 2 * i + 3, o + 2 * i + 2);
    }
    for (let j = 0; j < nz - 1; j++) {
      let o = this.offSpine;
      quad(2, o + 2 * j, o + 2 * j + 1, o + 2 * j + 3, o + 2 * j + 2);
      o = this.offFore;
      quad(2, o + 2 * j, o + 2 * j + 1, o + 2 * j + 3, o + 2 * j + 2);
    }
    let start = 0;
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].length === 0) continue;
      this.geometry.addGroup(start, groups[g].length, g);
      start += groups[g].length;
    }
    this.geometry.setIndex(groups.flat());
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
