import type { DesignerId } from './types';

/** Designers and traditions the studio draws on — used to group presets and library items. */
export const DESIGNERS: { id: DesignerId; name: string; era: string; accent: string; note: string }[] = [
  { id: 'cleves', name: 'Catherine of Cleves', era: 'Utrecht, c. 1440', accent: '#c9a227', note: 'Illumination, rubrication, marginalia and trompe-l’œil borders.' },
  { id: 'diehl', name: 'Edith Diehl', era: 'Bookbinding, 1946', accent: '#8a5a3b', note: 'Binding structure, endpapers and the anatomy of the sewn book.' },
  { id: 'munari', name: 'Bruno Munari', era: 'Libri illeggibili, 1949–', accent: '#c8372a', note: 'Die-cuts, folds, coloured stocks and the book as object.' },
  { id: 'crouwel', name: 'Wim Crouwel', era: 'Total Design, 1963–', accent: '#ff3b1f', note: 'Square modules, visible grids and constructed letters.' },
  { id: 'martens', name: 'Karel Martens', era: 'Printed Matter, 1990s–', accent: '#ff4f9a', note: 'Overprinted monoprints, found forms and industrial numerals.' },
  { id: 'schrofer', name: 'Jurriaan Schrofer', era: 'Restless typography, 1960s–80s', accent: '#111111', note: 'Optical, algorithmic, kinetic type systems.' },
  { id: 'tschichold', name: 'Jan Tschichold', era: 'The Form of the Book, 1940s–', accent: '#b0331f', note: 'Classical canons, centred title pages and the Penguin rules.' },
  { id: 'bringhurst', name: 'Robert Bringhurst', era: 'Elements of Typographic Style, 1992', accent: '#8a2a1f', note: 'Proportion, the typographic scale and the margin as a working space.' },
  { id: 'bosshard', name: 'Hans Rudolf Bosshard', era: 'Der typografische Raster, 2000', accent: '#0050a0', note: 'Dual grids, em-derived modules and concrete, constructive typography.' },
  { id: 'muller-brockmann', name: 'Josef Müller-Brockmann', era: 'Grid Systems, 1961–81', accent: '#e30613', note: 'Field grids, objective typography and constructivist posters.' },
  { id: 'hochuli', name: 'Jost Hochuli', era: 'Detail in Typography, 1987', accent: '#d26a1e', note: 'Micro-typography, even colour and asymmetric, reader-first books.' },
  { id: 'unger', name: 'Gerard Unger', era: 'While You’re Reading, 1997', accent: '#2f6d63', note: 'How reading works: sizes, rhythm and the reader’s eye.' },
  { id: 'caflisch', name: 'Max Caflisch', era: 'Typographic classification', accent: '#5b4f8a', note: 'Typeface classification and letterform anatomy.' },
  { id: 'sato', name: 'Koichi Sato & wa-toji', era: 'Ma, gradients, stab binding', accent: '#5d6bd6', note: 'Negative space, luminous gradients and Japanese binding.' },
  { id: 'general', name: 'Studio tools', era: 'Measuring & teaching', accent: '#7d7a83', note: 'Grids, dimensions and specimens for teaching.' },
];

export const designerName = (id: DesignerId) => DESIGNERS.find((d) => d.id === id)?.name ?? id;
