/**
 * Loading a manuscript file as story markup: Word (.docx), Markdown (.md) or plain text (.txt,
 * including Project Gutenberg books). See src/lib/docx.ts and src/lib/plainText.ts.
 */
import { docxToStory } from '../lib/docx';
import { textToStory } from '../lib/plainText';

/** Files the importer treats as manuscripts (a dropped PDF is placed as a graphic instead). */
export const MANUSCRIPT_EXT = /\.(docx|txt|text|md|markdown|rtf|idml)$/i;
/** The Flow text loader also takes PDFs, for their text. */
export const MANUSCRIPT_ACCEPT = '.docx,.rtf,.idml,.txt,.text,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf,application/rtf';

export async function loadManuscript(file: File, paraStyleNames: string[] = [], onProgress?: (msg: string) => void): Promise<{ text: string; summary: string }> {
  if (/\.rtf$/i.test(file.name) || file.type === 'application/rtf' || file.type === 'text/rtf') {
    const { rtfToStory } = await import('../lib/rtf');
    const r = rtfToStory(await file.text(), paraStyleNames);
    return { text: r.text, summary: `${r.paragraphs.toLocaleString()} paragraphs${r.notes ? `, ${r.notes} note${r.notes === 1 ? '' : 's'}` : ''} from RTF` };
  }
  if (/\.idml$/i.test(file.name)) {
    const { idmlToStory } = await import('../lib/idml');
    const r = await idmlToStory(file, paraStyleNames);
    return { text: r.text, summary: `${r.paragraphs.toLocaleString()} paragraphs from ${r.stories} InDesign stor${r.stories === 1 ? 'y' : 'ies'}${r.notes ? `, ${r.notes} note${r.notes === 1 ? '' : 's'}` : ''}${r.skipped ? `; ${r.skipped} short stories (folios, captions) left out` : ''}` };
  }
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const { pdfToStory } = await import('../lib/pdfImport');
    const r = await pdfToStory(new Uint8Array(await file.arrayBuffer()), (n, of) => onProgress?.(`Reading page ${n} of ${of}…`));
    const bits = [`${r.paragraphs.toLocaleString()} paragraphs from ${r.pages} PDF page${r.pages === 1 ? '' : 's'}`];
    if (r.headings) bits.push(`${r.headings} heading${r.headings === 1 ? '' : 's'}`);
    if (r.dropped) bits.push(`${r.dropped} running heads / folios left out`);
    bits.push('check tables, notes and columns by eye');
    return { text: r.text, summary: bits.join(', ') };
  }
  if (/\.docx$/i.test(file.name)) {
    const r = await docxToStory(file, paraStyleNames);
    return { text: r.text, summary: `${r.paragraphs.toLocaleString()} paragraphs${r.notes ? `, ${r.notes} note${r.notes === 1 ? '' : 's'}` : ''} from Word` };
  }
  const markdown = /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown';
  const r = textToStory(await file.text(), { markdown });
  const bits = [`${r.paragraphs.toLocaleString()} paragraphs`];
  if (r.headings) bits.push(`${r.headings} heading${r.headings === 1 ? '' : 's'}`);
  if (r.gutenberg) bits.push('Project Gutenberg licence text left out');
  if (r.unwrapped) bits.push('hard-wrapped lines joined');
  return { text: r.text, summary: bits.join(', ') };
}
