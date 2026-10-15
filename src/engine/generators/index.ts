/** Procedural element generators: element + context → display-list primitives. */
export type { GenContext, Generator } from './context';
export type { ParamSpec } from './util';
export { readParams } from './util';
export { generatePattern, PATTERN_PARAMS } from './schrofer';
export { generateOrnament, generateInitial, illuminatedFrame, ORNAMENT_PARAMS } from './cleves';
export { generateOverprint, OVERPRINT_PARAMS } from './martens';
export { generateGradient } from './sato';
export { generateGridType, GRID_GLYPHS } from './crouwel';
export type { GridGlyph } from './crouwel';
export { generateRule } from './rules';
