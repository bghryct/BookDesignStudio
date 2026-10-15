/**
 * Motif registry contract. A motif is a designer-specific generator exposed through a
 * single element type (`MotifElement`): the inspector builds its controls from `params`,
 * `colors` and `text`, the element library inserts it, and every back-end renders it.
 */
import type { BookSpec, MotifElement, Unit } from '../../model/types';
import type { Prim } from '../../render/primitives';
import type { GenContext } from '../generators/context';

export type DesignerId =
  | 'cleves' | 'diehl' | 'munari' | 'crouwel' | 'martens' | 'schrofer' | 'tschichold' | 'bringhurst'
  | 'bosshard' | 'muller-brockmann' | 'hochuli' | 'unger' | 'caflisch' | 'sato' | 'general';

export interface MotifParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Optional labels for integer-valued choices (index = value - min). */
  options?: string[];
}

export interface MotifContext extends GenContext {
  /** Document display unit — for labels on measuring and teaching diagrams. */
  unit: Unit;
  /** The book being designed — binding, imposition and canon diagrams read it. */
  book: BookSpec;
}

export interface MotifDef {
  /** Registry key, kebab-case, unique. */
  kind: string;
  label: string;
  designer: DesignerId;
  /** One or two sentences: what it is and why it belongs to this designer's practice. */
  description: string;
  /** Size when inserted, pt. */
  defaultSize: { w: number; h: number };
  /** Colour slots, in order (el.colors[i]). */
  colors: { label: string; default: string }[];
  params: MotifParam[];
  /** Optional text input (el.text). */
  text?: { label: string; default: string; multiline?: boolean };
  /** Default font family id (el.fontFamily) when the motif sets type. */
  fontFamily?: string;
  /** Pure, deterministic: primitives in the element's local box (0,0)–(el.w, el.h), pt, y down. */
  generate: (el: MotifElement, ctx: MotifContext) => Prim[];
}

/** Read params with defaults and clamping. */
export function motifParams(def: MotifDef, raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) {
    const v = raw[p.key];
    out[p.key] = typeof v === 'number' && Number.isFinite(v) ? Math.max(p.min, Math.min(p.max, v)) : p.default;
  }
  return out;
}

/** Colour slot with default fallback. */
export function motifColor(def: MotifDef, el: MotifElement, i: number): string {
  return el.colors[i] ?? def.colors[i]?.default ?? '#1b1813';
}
