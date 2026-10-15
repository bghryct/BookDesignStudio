import type { MotifDef } from './types';
import { MARBLED, PASTE_PAPER, WASHI } from './decorative-media';
import { BLOCK_REPEAT, FLEURON_BORDER, LINE_FILLER, PILCROW_COLUMN } from './decorative-ornament';
import { CIRCLE_COMPOSITION, CONCENTRIC_ARCS, CONCRETE_FIELDS, DIAGONAL_BARS, PENGUIN_BANDS } from './decorative-modern';
import { FOLD_DIAGRAM } from './decorative-fold';

/**
 * Decorative and material motifs: decorated papers (Diehl, Sato), the
 * rubricator's furniture (Cleves), printers' flowers and the Penguin grid
 * (Tschichold), Swiss constructive compositions (Müller-Brockmann, Bosshard)
 * and Munari's folding diagrams. Implementations live in `decorative-*.ts`.
 */
export const DECORATIVE_MOTIFS: MotifDef[] = [
  MARBLED,
  PASTE_PAPER,
  BLOCK_REPEAT,
  WASHI,
  LINE_FILLER,
  PILCROW_COLUMN,
  FLEURON_BORDER,
  PENGUIN_BANDS,
  CONCENTRIC_ARCS,
  CIRCLE_COMPOSITION,
  DIAGONAL_BARS,
  CONCRETE_FIELDS,
  FOLD_DIAGRAM,
];
