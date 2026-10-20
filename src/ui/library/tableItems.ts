/** Sample tables for the element library, one per classic table style. */
import type { LibraryItem, LibraryContext } from './items';
import type { TableCol, TableElement } from '../../model/table';
import { tableFromMatrix } from '../../model/table';
import { makeTable } from '../../model/factory';

const PROPORTIONS = [
  ['Proportion', 'Ratio', 'Height ÷ width', 'Page 150 mm wide'],
  ['Square', '1 : 1', '1.000', '150.0'],
  ['Three to four', '3 : 4', '1.333', '200.0'],
  ['DIN, √2', '1 : 1.414', '1.414', '212.1'],
  ['Two to three', '2 : 3', '1.500', '225.0'],
  ['Golden section', '1 : 1.618', '1.618', '242.7'],
  ['Three to five', '3 : 5', '1.667', '250.0'],
];

const SIZES = [
  ['Old name', 'Points', 'Millimetres', 'Use'],
  ['Nonpareil', '6', '2.12', 'Notes, indexes'],
  ['Minion', '7', '2.47', 'Footnotes'],
  ['Brevier', '8', '2.82', 'Captions'],
  ['Bourgeois', '9', '3.18', 'Small text'],
  ['Long primer', '10', '3.53', 'Book text'],
  ['Small pica', '11', '3.88', 'Book text'],
  ['Pica', '12', '4.23', 'Reading text'],
  ['English', '14', '4.94', 'Subheads'],
  ['Great primer', '18', '6.35', 'Heads'],
];

const MEASURE = [
  ['Size', 'Leading', 'Measure', 'Characters'],
  ['8 pt', '10.5 pt', '18 pc', '62'],
  ['9 pt', '12 pt', '20 pc', '63'],
  ['10 pt', '13 pt', '22 pc', '64'],
  ['11 pt', '14 pt', '24 pc', '65'],
  ['12 pt', '15.5 pt', '26 pc', '64'],
];

const LEDGER = [
  ['Section', 'Sheets', 'Paper, kg', 'Cost, €'],
  ['Front matter', '1', '42.5', '318.40'],
  ['Part one', '6', '255.0', '1,910.25'],
  ['Part two', '7', '297.5', '2,228.60'],
  ['Plates', '2', '96.0', '1,204.00'],
  ['Index & back matter', '2', '85.0', '636.80'],
  ['Total', '18', '776.0', '6,298.05'],
];

/** A table built from sample rows, placed at the head of the text block. */
function sample(c: LibraryContext, data: string[][], over: Partial<TableElement>, cols?: TableCol[]): TableElement {
  const m = tableFromMatrix(data);
  return makeTable({ ...m, ...(cols ? { cols } : {}), x: c.block.x, y: c.block.y + 12, w: c.block.w, h: 120, ...over });
}

export const TABLE_ITEMS: LibraryItem[] = [
  {
    id: 'table-tschichold', designer: 'tschichold', label: 'Table · book rules',
    note: 'Three horizontal rules, small-capital heads and figures aligned on the decimal point.',
    make: (c) => [sample(c, PROPORTIONS, { name: 'Proportions of the page', tableStyle: 'tbs-book' })],
  },
  {
    id: 'table-swiss', designer: 'muller-brockmann', label: 'Table · Swiss grid',
    note: 'Sans-serif, flush left, hairlines on the grid and a heavy top rule.',
    make: (c) => [sample(c, SIZES, { name: 'Type sizes', tableStyle: 'tbs-swiss' }, [
      { mode: 'fr', w: 1.2 }, { mode: 'fr', w: 0.7, align: 'right' }, { mode: 'fr', w: 1, align: 'decimal', figures: 'tabular-lining' }, { mode: 'fr', w: 1.6 },
    ])],
  },
  {
    id: 'table-bringhurst', designer: 'bringhurst', label: 'Table · no rules, tabular figures',
    note: 'No rules at all: an italic head, a stub, and tabular figures carry the columns.',
    make: (c) => [sample(c, MEASURE, { name: 'Measure', tableStyle: 'tbs-tabular', fitWidth: false }, [
      { mode: 'auto', w: 0, figures: 'tabular-lining' }, { mode: 'auto', w: 0, align: 'right', figures: 'tabular-lining' },
      { mode: 'auto', w: 0, align: 'right', figures: 'tabular-lining' }, { mode: 'auto', w: 0, align: 'right', figures: 'tabular-lining' },
    ])],
  },
  {
    id: 'table-ledger', designer: 'general', label: 'Table · ledger with totals',
    note: 'Banded rows, a solid head, a bold stub and a footer row of totals.',
    make: (c) => {
      const t = sample(c, LEDGER, { name: 'Production costs', tableStyle: 'tbs-ledger', footerRows: 1, repeatFooter: false });
      t.cells[t.rows.length - 1].forEach((cell) => { cell.cellStyle = 'cs-total'; });
      return [t];
    },
  },
];
