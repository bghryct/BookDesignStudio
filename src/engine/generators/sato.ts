/**
 * Koichi Sato (1944–2016) — luminous tonal mists.
 *
 * Sato's posters are light emerging from a field: a deep ground with soft
 * orbs that seem to glow from within, edges so gradual there is no edge at
 * all. Three things keep it from looking like a cheap gradient:
 *  · a Gaussian falloff sampled into many stops (never a linear ramp),
 *  · light colours added with `screen`, dark ones with `multiply`, so mists
 *    mix like light rather than like paint,
 *  · a fine deterministic film grain that dithers away 8-bit banding.
 *
 * Point coordinates: when every x, y and radius is within ±2 they are read as
 * fractions (x·w, y·h, radius·√(w·h)); otherwise as points.
 */
import type { GradientElement } from '../../model/types';
import type { GradientStop, Prim, RadialGradientPaint } from '../../render/primitives';
import { rectPath } from '../../render/primitives';
import { luminance, mix } from '../../lib/color';
import { clamp, valueNoise } from '../../lib/random';
import type { Generator } from './context';
import { Pen, hashStr, rasterDensity, scratchCanvas } from './util';

/** Normalise any CSS hex to #rrggbb (gradient stop opacity needs 6-digit hex in the canvas back-end). */
const hex6 = (c: string) => mix(c, c, 0);

/** Gaussian falloff sampled into stops: alpha(t) = (e^(−k t²) − e^(−k)) / (1 − e^(−k)). */
function gaussianStops(color: string, k: number, peak: number, edgeTint: string | null, n = 14): GradientStop[] {
  const ek = Math.exp(-k);
  const stops: GradientStop[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = ((Math.exp(-k * t * t) - ek) / (1 - ek)) * peak;
    const c = edgeTint ? mix(color, edgeTint, t * t * 0.35) : color;
    stops.push({ offset: t, color: c, opacity: clamp(a, 0, 1) });
  }
  return stops;
}

function radial(cx: number, cy: number, r: number, stops: GradientStop[]): RadialGradientPaint {
  return { kind: 'radial', cx, cy, r, stops };
}

/** Deterministic film grain, defined in pt space so it looks the same at any zoom. */
function grainRaster(w: number, h: number, amount: number): Prim {
  const key = `sato-grain:${hashStr(`${w}x${h}|${amount}`)}`;
  return {
    t: 'raster', key, x: 0, y: 0, w, h, blend: 'overlay', opacity: clamp(amount, 0, 1) * 0.45,
    draw: (target, pxPerPt) => {
      const ppp = rasterDensity(w, h, pxPerPt, 10e6);
      const W = Math.max(1, Math.ceil(w * ppp)), H = Math.max(1, Math.ceil(h * ppp));
      const sc = scratchCanvas(W, H);
      if (!sc) return;
      const img = sc.ctx.createImageData(W, H);
      const d = img.data;
      const sx = w / W, sy = h / H;
      for (let j = 0; j < H; j++) {
        const y = (j + 0.5) * sy;
        for (let i = 0; i < W; i++) {
          const x = (i + 0.5) * sx;
          // Two grain sizes (≈0.45pt and ≈1.2pt) give the clumping of real film grain.
          const n = 0.68 * valueNoise(x / 0.45, y / 0.45, 101) + 0.32 * valueNoise(x / 1.2, y / 1.2, 202) - 0.5;
          const v = clamp(128 + n * 300, 0, 255);
          const o = (j * W + i) * 4;
          d[o] = d[o + 1] = d[o + 2] = v;
          d[o + 3] = 255;
        }
      }
      sc.ctx.putImageData(img, 0, 0);
      target.drawImage(sc.canvas, 0, 0, w, h);
    },
  };
}

export const generateGradient: Generator<GradientElement> = (el) => {
  const { w, h } = el;
  if (!(w > 0 && h > 0)) return [];
  const base = hex6(el.base);
  const baseLum = luminance(base);
  const soft = clamp(el.softness, 0, 1);
  const unit = Math.sqrt(w * h);
  const frac = el.points.every((p) => Math.abs(p.x) <= 2 && Math.abs(p.y) <= 2 && Math.abs(p.radius) <= 2);
  const box = rectPath(0, 0, w, h);
  const glows: Prim[] = [];

  // The ground breathes: a barely perceptible vertical drift in value.
  glows.push({
    t: 'path', d: box,
    fill: { kind: 'linear', x1: 0, y1: 0, x2: 0, y2: h, stops: [
      { offset: 0, color: mix(base, '#ffffff', 0.035) },
      { offset: 0.55, color: base },
      { offset: 1, color: mix(base, '#000000', 0.07) },
    ] },
  });

  const pts = el.points.map((p, i) => {
    const color = hex6(p.color);
    return {
      i, color,
      cx: frac ? p.x * w : p.x,
      cy: frac ? p.y * h : p.y,
      r: Math.max(1, Math.abs(frac ? p.radius * unit : p.radius)),
      light: luminance(color) >= baseLum,
    };
  });

  const k = 4.2 - 2.4 * soft;
  for (const p of pts) {
    const reach = p.r * (0.7 + soft * 0.6);
    const blend = p.light ? 'screen' : 'multiply';
    // An off-centre echo turns a perfect disc into a drifting mist.
    const away = Math.atan2(p.cy - h / 2, p.cx - w / 2) + (p.i % 2 ? 0.6 : -0.6);
    const ex = p.cx + Math.cos(away) * p.r * 0.16, ey = p.cy + Math.sin(away) * p.r * 0.16;
    const er = reach * 1.25;
    glows.push({
      t: 'path', d: new Pen().circle(ex, ey, er).d, blend,
      fill: radial(ex, ey, er, gaussianStops(mix(p.color, base, 0.25), Math.max(1.2, k * 0.8), 0.28, null, 10)),
    });
    glows.push({
      t: 'path', d: new Pen().circle(p.cx, p.cy, reach).d, blend,
      fill: radial(p.cx, p.cy, reach, gaussianStops(p.color, k, 1, base, 16)),
    });
  }

  if (el.glow) {
    for (const p of pts) {
      if (!p.light && baseLum > 0.5) continue;
      // Luminous core: a whitened heart and a wide faint halo, both added as light.
      const core = mix(p.color, '#ffffff', 0.62);
      const cr = p.r * (0.26 + soft * 0.1);
      glows.push({ t: 'path', d: new Pen().circle(p.cx, p.cy, cr).d, blend: 'screen', fill: radial(p.cx, p.cy, cr, gaussianStops(core, 3.4, 0.8, null, 12)) });
      const hr = p.r * (1.4 + soft * 0.4);
      glows.push({ t: 'path', d: new Pen().circle(p.cx, p.cy, hr).d, blend: 'screen', fill: radial(p.cx, p.cy, hr, gaussianStops(p.color, 2.6, 0.12, null, 10)) });
    }
  }

  const out: Prim[] = [{ t: 'group', clip: box, children: glows }];
  if (el.grain > 0.001) out.push(grainRaster(w, h, el.grain));
  return out;
};
