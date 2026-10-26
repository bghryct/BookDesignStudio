/**
 * Plain text and Markdown manuscripts → story markup (one paragraph per line).
 *
 *  - Project Gutenberg files: the licence header and footer are dropped.
 *  - Hard-wrapped prose (lines broken at ~70 characters, blank lines between paragraphs) is
 *    unwrapped into paragraphs; blocks of short lines (verse, letters, contents lists) keep their
 *    line breaks; indented blocks become extracts.
 *  - CHAPTER / BOOK / PART … lines become # headings; _underscored_ words become *italic*.
 *  - Straight quotes become typographer's quotes, -- an em dash.
 *  - Characters the story markup would read as formatting are escaped (plain text only;
 *    Markdown keeps its #, *, ** and lists, which the story markup shares).
 */

export interface TextImportOptions {
  markdown?: boolean;
  /** Typographer's quotes and dashes (default on). */
  smartQuotes?: boolean;
}

export interface TextImportResult { text: string; paragraphs: number; headings: number; unwrapped: boolean; gutenberg: boolean }

const HEAD = /^(chapter|book|part|volume|epilogue|prologue|preface|introduction|etymology|extracts|contents|appendix|afterword|foreword|letter|stave|canto)\b/i;

/** Typographer's quotes from straight ones, by context. */
export function smartQuotes(s: string): string {
  return s
    .replace(/---/g, '—')
    .replace(/--/g, '—')
    .replace(/(^|[\s([{—–\-/])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{—–\-/“])'/g, '$1‘')
    .replace(/'/g, '’')
    .replace(/\.\.\./g, '…');
}

const escPlain = (t: string) => t.replace(/([\\*^{}<>])/g, '\\$1');

export function textToStory(raw: string, opts: TextImportOptions = {}): TextImportResult {
  let text = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/ /g, ' ');
  // Project Gutenberg: keep what lies between the START and END markers.
  let gutenberg = false;
  const start = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*$/im.exec(text);
  if (start) { text = text.slice(start.index + start[0].length); gutenberg = true; }
  const end = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG.*$/im.exec(text);
  if (end) text = text.slice(0, end.index);
  text = text.replace(/^\s*Produced by[^\n]*(\n[^\n]+)*\n/i, '');

  const lines = text.split('\n');
  const lens = lines.map((l) => l.trimEnd().length).filter((n) => n > 0).sort((a, b) => a - b);
  const p90 = lens.length ? lens[Math.floor(lens.length * 0.9)] : 0;
  const blank = lines.filter((l) => !l.trim()).length;
  // Hard-wrapped: lines no longer than a typewriter measure, with blank lines between paragraphs.
  const wrapped = p90 > 0 && p90 <= 100 && blank > lines.length * 0.05;
  const W = Math.max(40, p90);

  // Blocks of consecutive non-blank lines.
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim()) cur.push(l.trimEnd());
    else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);

  const out: string[] = [];
  let headings = 0;
  // Whether any paragraph was actually rejoined from several lines (the summary says so).
  let joined = false;
  // After a CONTENTS heading, chapter lines are the contents list, not headings.
  let inContents = false;
  const listed = new Set<string>();
  const norm = (l: string) => l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // How a contents line and its chapter match: "CHAPTER I.   Down the Rabbit-Hole" and "CHAPTER I."
  // are both "chapter i" ("chapter the first" for spelled-out ordinals).
  const headKey = (l: string) => { const w = norm(l).split(' '); return w.slice(0, w[1] === 'the' ? 3 : 2).join(' '); };
  const esc = opts.markdown ? (t: string) => t.replace(/([\\^{}<>])/g, '\\$1') : escPlain;
  const finish = (t: string) => {
    let s = esc(t.replace(/\s+/g, ' ').trim());
    if (opts.smartQuotes !== false) s = smartQuotes(s);
    // _underscored_ (Gutenberg, Markdown) → italic.
    s = s.replace(/(^|[^\w\\])_([^_]+?)_(?=[^\w]|$)/g, '$1*$2*');
    return s;
  };
  const emit = (block: string[]) => {
    const indented = block.every((l) => /^\s{2,}/.test(l));
    const body = block.map((l) => l.trim());
    if (opts.markdown) {
      // Markdown: headings and list items keep their own lines; other lines join into paragraphs.
      const h = /^(#{1,6})\s+(.*)$/.exec(body[0]);
      if (h && body.length === 1) { out.push(`${h[1].length === 1 ? '#' : '##'} ${finish(h[2])}`); headings++; return; }
      if (body.every((l) => /^([-*+]|\d+[.)])\s/.test(l))) {
        for (const l of body) out.push(l.replace(/^[*+]\s/, '- ').replace(/^(\d+)\)\s/, '$1. ').replace(/^(- |\d+\. )(.*)$/, (_, m: string, r: string) => m + finish(r)));
        return;
      }
      if (body.every((l) => /^>\s?/.test(l))) { out.push(`[{left:18}] ${finish(body.map((l) => l.replace(/^>\s?/, '')).join(' '))}`); return; }
      if (body.length > 1) joined = true;
      out.push(finish(body.join(' ')));
      return;
    }
    const headLike = body.length <= 3 && HEAD.test(body[0]) && body.every((l) => l.length < 70);
    // A contents list: chapter lines, one per paragraph.
    if (body.length > 3 && body.filter((l) => HEAD.test(l)).length >= body.length * 0.7) {
      for (const l of body) { out.push(lead(finish(l))); listed.add(headKey(l)); }
      inContents = true;
      return;
    }
    // …until an entry comes round again: that is the chapter itself.
    if (inContents && headLike && !/^contents\b/i.test(body[0]) && !listed.has(headKey(body[0]))) { listed.add(headKey(body[0])); out.push(lead(finish(body.join(' ')))); return; }
    inContents = false;
    // A short block led by CHAPTER / BOOK / … is a heading (with its title line, if any).
    if (headLike) {
      out.push(`# ${body.map(finish).join('{br}')}`);
      headings++;
      if (/^contents\b/i.test(body[0])) inContents = true;
      return;
    }
    let para: string;
    if (!wrapped) {
      // One paragraph per line already.
      for (const l of body) {
        if (HEAD.test(l) && l.length < 70 && !inContents) { out.push(`# ${finish(l)}`); headings++; }
        else out.push(lead(finish(l)));
      }
      return;
    }
    const shortLines = body.length > 1 && body.slice(0, -1).some((l) => l.length < W * 0.55);
    if (shortLines) para = body.map(finish).join('{br}');      // verse, letters, contents lists
    else { para = finish(body.join(' ')); if (body.length > 1) joined = true; } // wrapped prose
    out.push((indented ? '[{left:18}] ' : '') + lead(para));
  };
  // A literal paragraph-start marker (#, -, 1.) would be read as markup in plain text.
  const lead = (s: string) => (!opts.markdown && /^(#|- |• |\d+[.)] |[a-z]\) |\[|---\s*$)/.test(s) ? '\\' + s : s);
  for (const b of blocks) emit(b);
  const story = out.filter(Boolean).join('\n');
  return { text: story, paragraphs: out.length, headings, unwrapped: joined, gutenberg };
}
