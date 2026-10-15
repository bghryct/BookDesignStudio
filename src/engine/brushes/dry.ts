/**
 * Dry media — pencil, graphite, charcoal, crayon, pastel.
 *
 * Technique: dabs are stamped along the evenly resampled stroke into an alpha
 * mask (per-dab alpha chosen so the overlapping dabs build up to the target
 * coverage). A pixel pass then lets the paper tooth decide where pigment sticks:
 * a pixel with coverage `a` only receives pigment where the paper height is
 * above 1 − a, so a light touch catches only the peaks and pressure pushes
 * pigment down into the valleys.
 */
import { parseColor, mix } from '../../lib/color';
import { clamp, rng } from '../../lib/random';
import { getPaperTexture, tileIndex } from './paper';
import {
  compositeLayer, lerp, openLayer, readLayer, resample, roughSprite, softSprite, writeLayer, type Job,
} from './util';

interface DryStyle {
  /** Dab spacing as a fraction of the nominal size. */
  spacing: number;
  /** Dab diameter multiplier at pressure 0 and 1. */
  width: [number, number];
  /** Target coverage at pressure 0 and 1. */
  cover: [number, number];
  /** 0 = round soft dab, > 0 = irregular dab with this roughness. */
  rough: number;
  /** Positional scatter as a fraction of the radius. */
  jitter: number;
  /** How strongly the paper tooth gates pigment, 0–1. */
  tooth: number;
  /** Softness of the tooth threshold (wider = smoother tone). */
  soft: number;
  /** How far full pressure reaches into the valleys (crayon wax never fills them). */
  reach: number;
  /** Darkest coverage the medium can reach. */
  maxCover: number;
  /** Fine speckle from the medium itself. */
  speckle: number;
  /** Lighten towards white at low coverage (pastel chalk). */
  chalk: number;
  /** Loose dust particles around the stroke (charcoal). */
  dust: number;
  /** Paper tooth feature scale. */
  paperScale: number;
  composite: GlobalCompositeOperation;
  /** Final pigment colour from the stroke colour. */
  tint: (c: string) => string;
}

const STYLES: Record<'pencil' | 'graphite' | 'charcoal' | 'crayon' | 'pastel', DryStyle> = {
  pencil: {
    spacing: 0.2, width: [0.75, 1.05], cover: [0.3, 0.92], rough: 0, jitter: 0,
    tooth: 0.85, soft: 0.12, reach: 1, maxCover: 0.88, speckle: 0.15, chalk: 0, dust: 0, paperScale: 1,
    composite: 'multiply',
    // Graphite never reaches pure black: pull towards a cool, sheen-free grey.
    tint: (c) => mix(c, '#7c7e85', 0.24),
  },
  graphite: {
    spacing: 0.1, width: [0.7, 1.05], cover: [0.3, 0.88], rough: 0.35, jitter: 0.06,
    tooth: 1, soft: 0.1, reach: 1, maxCover: 0.86, speckle: 0.22, chalk: 0, dust: 0, paperScale: 1,
    composite: 'multiply',
    tint: (c) => mix(c, '#6e7077', 0.28),
  },
  charcoal: {
    spacing: 0.09, width: [0.75, 1.1], cover: [0.5, 1], rough: 0.85, jitter: 0.16,
    tooth: 1, soft: 0.06, reach: 1, maxCover: 0.97, speckle: 0.45, chalk: 0, dust: 1, paperScale: 1.2,
    composite: 'multiply',
    tint: (c) => mix(c, '#1b1918', 0.12),
  },
  crayon: {
    spacing: 0.12, width: [0.85, 1.05], cover: [0.65, 1], rough: 0.5, jitter: 0.05,
    tooth: 1, soft: 0.035, reach: 0.8, maxCover: 0.95, speckle: 0.25, chalk: 0, dust: 0, paperScale: 1.25,
    composite: 'source-over',
    tint: (c) => c,
  },
  pastel: {
    spacing: 0.1, width: [0.8, 1.1], cover: [0.42, 0.97], rough: 0.6, jitter: 0.12,
    tooth: 0.9, soft: 0.14, reach: 0.95, maxCover: 0.93, speckle: 0.3, chalk: 0.4, dust: 0.25, paperScale: 1.25,
    composite: 'source-over',
    tint: (c) => c,
  },
};

export type DryBrush = keyof typeof STYLES;

export function renderDry(job: Job, kind: DryBrush): void {
  const { stroke } = job;
  const st = STYLES[kind];
  const size = Math.max(0.1, stroke.size);
  const step = st.spacing * size;
  const samples = resample(stroke.points, step);
  if (!samples.length) return;
  const L = openLayer(job.region, job.pxPerPt);
  if (!L) return;
  const { ctx, s, x0, y0 } = L;
  const r = rng(stroke.seed);
  const flowScale = clamp(0.35 + 0.75 * stroke.flow, 0.1, 1);
  const single = samples.length === 1;
  const sprite0 = st.rough > 0 ? null : softSprite(stroke.hardness);

  // 1. Dabs → coverage mask.
  for (let i = 0; i < samples.length; i++) {
    const sm = samples[i];
    const D = size * lerp(st.width[0], st.width[1], sm.p);
    const c = clamp(lerp(st.cover[0], st.cover[1], sm.p) * flowScale, 0, 0.995);
    const n = Math.max(1, D / step);
    const ang = r() * Math.PI * 2;
    const jx = (r() - 0.5) * st.jitter * D, jy = (r() - 0.5) * st.jitter * D;
    const variant = (r() * 4) | 0;
    ctx.globalAlpha = single ? c : 1 - Math.pow(1 - c, 1 / n);
    if (sprite0) {
      // Round dabs need no rotation: skip the per-dab transform (pencil lays thousands).
      ctx.drawImage(sprite0, sm.x + jx - D / 2, sm.y + jy - D / 2, D, D);
    } else {
      const cs = Math.cos(ang) * s, sn = Math.sin(ang) * s;
      ctx.setTransform(cs, sn, -sn, cs, (sm.x + jx) * s - x0, (sm.y + jy) * s - y0);
      ctx.drawImage(roughSprite(variant, stroke.hardness, st.rough), -D / 2, -D / 2, D, D);
      ctx.setTransform(s, 0, 0, s, -x0, -y0);
    }

    // Charcoal / pastel dust: loose particles flicked off the edge of the stick.
    if (st.dust > 0) {
      const count = Math.floor(r() * 3 * st.dust * sm.p + r() * 0.6);
      for (let k = 0; k < count; k++) {
        const a = r() * Math.PI * 2, dist = (D / 2) * (0.9 + r() * 0.75 * st.dust);
        const ds = 0.18 + r() * 0.45;
        ctx.globalAlpha = 0.35 + r() * 0.5;
        ctx.fillStyle = '#fff';
        ctx.fillRect(sm.x + Math.cos(a) * dist, sm.y + Math.sin(a) * dist, ds, ds);
      }
    }
  }
  ctx.globalAlpha = 1;

  // 2. Paper tooth pass → pigment.
  const img = readLayer(L);
  const d = img.data;
  const tex = getPaperTexture(s, st.paperScale);
  const { cols, rows } = tileIndex(tex.size, tex.texPerPt, L);
  const g = clamp(stroke.grain, 0, 1), paper = clamp(job.paperGrain, 0, 1);
  const T = clamp(st.tooth * (0.5 + 0.5 * g) * (0.7 + 0.6 * paper), 0, 1);
  const soft = st.soft, reach = st.reach, maxC = st.maxCover, spk = st.speckle * 2, chalk = st.chalk;
  const col = parseColor(st.tint(stroke.color));
  const height = tex.height, fine = tex.fine;

  for (let j = 0; j < L.h; j++) {
    const row = rows[j];
    let p = j * L.w * 4;
    for (let i = 0; i < L.w; i++, p += 4) {
      const a8 = d[p + 3];
      if (!a8) continue;
      const a = a8 / 255;
      const k = row + cols[i];
      const h = height[k];
      // Pigment reaches paper whose height is above the threshold.
      const thr = 1 - a * reach;
      let t = (h - thr + soft) / (2 * soft);
      t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      // Smooth (tooth-free) share uses a² so low coverage never forms a soft halo.
      let cov = t * T + a * a * (1 - T);
      cov *= 1 + spk * (fine[k] - 0.5) * (1 - a * 0.5);
      cov = cov <= 0 ? 0 : cov >= 1 ? maxC : cov * maxC;
      const lighten = chalk * (1 - a);
      d[p] = col.r + (255 - col.r) * lighten;
      d[p + 1] = col.g + (255 - col.g) * lighten;
      d[p + 2] = col.b + (255 - col.b) * lighten;
      d[p + 3] = cov * 255;
    }
  }
  writeLayer(L, img);
  compositeLayer(job.ctx, L, stroke.opacity, st.composite);
}
