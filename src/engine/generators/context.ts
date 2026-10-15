import type { FontRef, Prim } from '../../render/primitives';

/**
 * Services a generator needs from the host. Generators are pure functions of
 * (element, context) → primitives, so they can render on any back-end.
 */
export interface GenContext {
  /** Resolve a registry font family to a concrete font reference. */
  font(familyId: string, weight?: number, italic?: boolean): FontRef;
  /** Advance width of `text` set in `font` at `size` pt (no letter-spacing). */
  measure(text: string, font: FontRef, size: number): number;
  /** Font metrics as fractions of the em. */
  metrics(font: FontRef): { ascender: number; descender: number; capHeight: number; xHeight: number };
}

export type Generator<E> = (el: E, ctx: GenContext) => Prim[];
