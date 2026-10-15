import type { MotifDef } from './types';
import { DECORATIVE_MOTIFS } from './decorative';
import { DIAGRAM_MOTIFS } from './diagrams';

export * from './types';
export { DESIGNERS, designerName } from './designers';

export const MOTIF_LIST: MotifDef[] = [...DECORATIVE_MOTIFS, ...DIAGRAM_MOTIFS];
export const MOTIFS: Record<string, MotifDef> = Object.fromEntries(MOTIF_LIST.map((m) => [m.kind, m]));
export const getMotif = (kind: string): MotifDef | undefined => MOTIFS[kind];
