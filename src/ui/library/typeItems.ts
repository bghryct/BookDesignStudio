/**
 * Library items that show off the typesetting engine: shaped rags, contents pages with leaders,
 * footnotes, lists, pull quotes with rules, spanning heads, run-in heads and type on a path.
 */
import type { TextStyle } from '../../model/types';
import type { DesignerId } from '../../engine/motifs';
import { makeText, makePath, textStyle, VERMILION } from '../../model/factory';
import type { LibraryItem } from './items';

const PROSE = 'The grid is the most disciplined of the typographer’s tools, and the most liberating. Once the measure, the leading and the margins are settled, every decision that follows has a place to stand, and the page acquires the calm of a well-proportioned room.';
const t = (o: Partial<TextStyle> = {}) => textStyle({ baselineGrid: false, firstLineIndent: 0, hyphenate: true, ...o });

export const TYPE_ITEMS: LibraryItem[] = [
  { id: 'type-swiss-rag', designer: 'muller-brockmann' as DesignerId, label: 'Swiss rag', note: 'Flush left, short line / long line, no short words at line ends.', make: (c) => [
    makeText({ name: 'Swiss rag', x: c.block.x, y: c.block.y, w: c.block.w * 0.8, h: 150, text: PROSE, style: t({ fontFamily: 'inter', fontSize: 9, leading: 13, align: 'left', rag: 'swiss', ragAmount: 14, avoidShortLineEnds: true, hyphenate: false }) }),
  ] },
  { id: 'type-balanced-head', designer: 'tschichold' as DesignerId, label: 'Balanced centred title', note: 'Lines of even length instead of a lonely last word.', make: (c) => [
    makeText({ name: 'Balanced title', x: c.block.x, y: c.block.y, w: c.block.w, h: 80, text: 'On the proportions of the printed page and the margins that surround it', style: t({ fontSize: 18, leading: 23, align: 'center', rag: 'balanced', hyphenate: false, kerning: 'optical' }) }),
  ] },
  { id: 'type-contents', designer: 'bringhurst' as DesignerId, label: 'Contents with leaders', note: 'Right-indent tab with dot leaders; numbers aligned.', make: (c) => [
    makeText({ name: 'Contents', x: c.block.x, y: c.block.y, w: c.block.w, h: 170, text: '[{size:14; leading:20; after:8}] ^Contents^\nI{tab}The Proportion of the Page{rtab}7\nII{tab}Type and Its Colour{rtab}23\nIII{tab}The Margin and the Gutter{rtab}41\nIV{tab}Sewing, Boards and Cloth{rtab}68\nV{tab}Notes on the Edition{rtab}97', style: t({ fontSize: 10, leading: 16, align: 'left', hyphenate: false, tabStops: [{ pos: 22, align: 'left' }], rightTabLeader: '. ', features: { onum: true } }) }),
  ] },
  { id: 'type-footnotes', designer: 'bringhurst' as DesignerId, label: 'Text with footnotes', note: 'Notes set at the foot of the column, under a short rule.', make: (c) => [
    makeText({ name: 'Footnoted text', x: c.block.x, y: c.block.y, w: c.block.w, h: Math.min(c.block.h, 260), text: `The proportions of the page were settled long before printing.{fn:Jan Tschichold, *The Form of the Book*, 1975.} ${PROSE} The canon survives because it works.{fn:Bringhurst calls it the most durable of all page constructions.}`, style: t({ fontSize: 10, leading: 13, align: 'justify', footnoteScale: 78 }) }),
  ] },
  { id: 'type-lists', designer: 'hochuli' as DesignerId, label: 'Lists, bullets & numbers', note: 'Hanging markers; numbers aligned on the point.', make: (c) => [
    makeText({ name: 'Lists', x: c.block.x, y: c.block.y, w: c.block.w, h: 170, text: 'Three rules for a calm page:\n1. Choose the measure before the type size.\n2. Let the leading follow the measure, not the other way round.\n3. Set the margins last, from the text block outward.\nAnd three things to avoid:\n- Rivers of white in justified text\n- Widows at the head of a column\n  - and orphans at its foot', style: t({ fontSize: 10, leading: 14, align: 'left', paragraphSpacing: 3 }) }),
  ] },
  { id: 'type-pullquote', designer: 'bringhurst' as DesignerId, label: 'Pull quote with rules', note: 'Rules above and below, wraps the text beside it.', make: (c) => {
    const q = makeText({ name: 'Pull quote', x: c.block.x + c.block.w * 0.12, y: c.block.y + 10, w: c.block.w * 0.76, h: 84, text: '“Typography exists to honour content.”', style: t({ fontSize: 15, leading: 19, italic: true, align: 'center', rag: 'balanced', hyphenate: false, ruleAbove: { weight: 1, color: VERMILION, offset: 8, width: 'column' }, ruleBelow: { weight: 1, color: VERMILION, offset: 10, width: 'column' } }) });
    q.verticalAlign = 'middle';
    q.wrap = { mode: 'box', offset: 8, side: 'both' };
    return [q];
  } },
  { id: 'type-runin', designer: 'hochuli' as DesignerId, label: 'Run-in head', note: 'The first words in letter-spaced small capitals.', make: (c) => [
    makeText({ name: 'Run-in head', x: c.block.x, y: c.block.y, w: c.block.w, h: 110, text: `<{case:sc; track:60; color:${VERMILION}}>The first words</> of a section can carry the heading themselves. ${PROSE}`, style: t({ fontSize: 10, leading: 13, align: 'justify' }) }),
  ] },
  { id: 'type-span-columns', designer: 'bosshard' as DesignerId, label: 'Two columns, spanning head', note: 'Head across both columns; balanced, with a column rule.', make: (c) => {
    const f = makeText({ name: 'Spanning head', x: c.block.x, y: c.block.y, w: c.block.w, h: 200, text: `[{span; size:16; leading:20; after:8; align:left}] A head across both columns\n${PROSE} ${PROSE}`, style: t({ fontSize: 8.5, leading: 11.5, align: 'justify' }) });
    f.columns = 2; f.columnGap = 12; f.balanceColumns = true; f.columnRule = { weight: 0.4, color: '#2a2118' };
    return [f];
  } },
  { id: 'type-on-path', designer: 'general' as DesignerId, label: 'Type on a path', note: 'A line of type that follows a curve.', make: (c) => {
    const w = c.block.w, h = Math.min(90, c.block.h / 3);
    const p = makePath({ name: 'Type on a path', x: c.block.x, y: c.block.y, w, h, d: `M4 ${h - 8} C ${w * 0.3} ${-h * 0.2}, ${w * 0.7} ${-h * 0.2}, ${w - 4} ${h - 8}`, vw: w, vh: h });
    p.stroke = null; p.fill = null;
    p.pathText = { text: 'Type on a path follows every curve of the line', fontFamily: 'eb-garamond', size: 15, weight: 400, italic: true, color: VERMILION, tracking: 30, offset: 50, align: 'center', side: 'over', baselineShift: 0 };
    return [p];
  } },
];
