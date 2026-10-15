import type { CMYK, Swatch } from '../model/types';

export interface RGB { r: number; g: number; b: number } // 0–255

export function parseColor(input: string): RGB & { a: number } {
  let s = (input || '#000').trim();
  if (s.startsWith('#')) {
    s = s.slice(1);
    if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
    const n = parseInt(s.slice(0, 6), 16);
    const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean);
    return { r: +r, g: +g, b: +b, a: +a };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

const h2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
export const toHex = ({ r, g, b }: RGB) => `#${h2(r)}${h2(g)}${h2(b)}`;

export function mix(a: string, b: string, t: number): string {
  const A = parseColor(a), B = parseColor(b);
  return toHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseColor(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function luminance(hex: string): number {
  const { r, g, b } = parseColor(hex);
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Naive device RGB → CMYK (GCR 100%). Swatches with an explicit build always win. */
export function rgbToCmyk(hex: string): CMYK {
  const { r, g, b } = parseColor(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 0.9999) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - R - k) / (1 - k), m = (1 - G - k) / (1 - k), y = (1 - B - k) / (1 - k);
  const p = (v: number) => Math.round(v * 1000) / 10;
  return { c: p(c), m: p(m), y: p(y), k: p(k) };
}

export function cmykToHex({ c, m, y, k }: CMYK): string {
  const K = k / 100;
  return toHex({ r: 255 * (1 - c / 100) * (1 - K), g: 255 * (1 - m / 100) * (1 - K), b: 255 * (1 - y / 100) * (1 - K) });
}

export function findSwatchCmyk(hex: string, swatches: Swatch[]): CMYK | null {
  const h = hex.toLowerCase();
  const s = swatches.find((sw) => sw.hex.toLowerCase() === h && sw.cmyk);
  return s?.cmyk ?? null;
}
