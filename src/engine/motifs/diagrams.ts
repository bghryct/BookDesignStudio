/**
 * Teaching diagrams, specimens and measuring motifs: grids after Müller-Brockmann and
 * Bosshard, Bringhurst’s scale and proportions, Unger’s waterfall, Hochuli’s spacing,
 * Caflisch’s classification and anatomy, Tschichold’s canon, and Diehl’s binding and
 * imposition drawings, with the Japanese stab-binding thread path.
 *
 * Every generator is pure and deterministic, emits vector paths and text only (so the
 * diagrams stay crisp in the PDF) and fits its content to the element box.
 */
import type { MotifDef } from './types';
import { dimension, dualGrid, emGrid, gridDiagram } from './diagrams-grids';
import { anatomy, classificationChart, proportionChart, spacingSpecimen, typeScale, waterfall } from './diagrams-type';
import { canonDiagram, caseDiagram, impositionDiagram, stabDiagram } from './diagrams-book';

export const DIAGRAM_MOTIFS: MotifDef[] = [
  gridDiagram,
  dualGrid,
  emGrid,
  dimension,
  typeScale,
  proportionChart,
  canonDiagram,
  waterfall,
  spacingSpecimen,
  classificationChart,
  anatomy,
  caseDiagram,
  impositionDiagram,
  stabDiagram,
];
