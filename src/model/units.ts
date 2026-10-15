import type { Unit } from './types';

/** Points per unit. */
export const PT_PER: Record<Unit, number> = {
  pt: 1,
  pc: 12,
  in: 72,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  px: 0.75, // CSS px at 96 dpi
};

export const toPt = (v: number, u: Unit) => v * PT_PER[u];
export const fromPt = (v: number, u: Unit) => v / PT_PER[u];
export const mm = (v: number) => v * PT_PER.mm;
export const ptToMm = (v: number) => v / PT_PER.mm;

export const UNIT_STEP: Record<Unit, number> = { pt: 0.5, pc: 0.25, in: 0.0625, mm: 0.5, cm: 0.05, px: 1 };
export const UNIT_DECIMALS: Record<Unit, number> = { pt: 2, pc: 3, in: 4, mm: 2, cm: 3, px: 1 };

export function formatUnit(v: number, u: Unit, withUnit = true): string {
  const n = fromPt(v, u);
  const s = (+n.toFixed(UNIT_DECIMALS[u])).toString();
  return withUnit ? `${s} ${u}` : s;
}

/** Parse "12.5mm", "3p6" (picas+points), "0.5in", or a bare number in the default unit. */
export function parseLength(input: string, defaultUnit: Unit): number | null {
  const s = input.trim().toLowerCase();
  const picas = s.match(/^(-?\d*\.?\d*)p(\d*\.?\d*)$/);
  if (picas) return (parseFloat(picas[1] || '0') * 12) + parseFloat(picas[2] || '0');
  const m = s.match(/^(-?\d*\.?\d+)\s*(mm|cm|in|pt|pc|px|")?$/);
  if (!m) return null;
  const unit = (m[2] === '"' ? 'in' : (m[2] as Unit)) || defaultUnit;
  return toPt(parseFloat(m[1]), unit);
}

export function toRoman(n: number, upper = false): string {
  if (n <= 0 || n >= 4000) return String(n);
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return upper ? out.toUpperCase() : out;
}
