/**
 * Track changes, kept in the story as CriticMarkup: `{++inserted++}` and `{--deleted--}`.
 * The page always sets the text as if every change were accepted (InDesign shows tracked changes
 * only in the story editor); the story editor records edits as changes while tracking is on and
 * accepts or rejects them one at a time or all together.
 */

const INS = /\{\+\+([\s\S]*?)\+\+\}/g;
const DEL = /\{--([\s\S]*?)--\}/g;

/** The text with every change accepted (what is set on the page). */
export function acceptChanges(text: string): string {
  if (!text.includes('{++') && !text.includes('{--')) return text;
  return text.replace(DEL, '').replace(INS, '$1');
}

/** The text with every change rejected (the original). */
export function rejectChanges(text: string): string {
  if (!text.includes('{++') && !text.includes('{--')) return text;
  return text.replace(INS, '').replace(DEL, '$1');
}

export interface Change { kind: 'ins' | 'del'; start: number; end: number; content: string }

export function listChanges(text: string): Change[] {
  const out: Change[] = [];
  for (const [re, kind] of [[INS, 'ins'], [DEL, 'del']] as const) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ kind, start: m.index!, end: m.index! + m[0].length, content: m[1] });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The change the caret is in (or touching). */
export function changeAt(text: string, pos: number): Change | null {
  return listChanges(text).find((c) => pos >= c.start && pos <= c.end) ?? null;
}

/** Accept or reject one change. */
export function resolveChange(text: string, c: Change, accept: boolean): string {
  const keep = (c.kind === 'ins') === accept ? c.content : '';
  return text.slice(0, c.start) + keep + text.slice(c.end);
}

/**
 * Record an edit as a change: what was removed becomes a deletion, what was typed an insertion.
 * Typing inside an insertion just edits it; backspacing over a deletion skips past it; adjacent
 * deletions and insertions merge. Returns the new text and where the caret goes.
 */
export function trackEdit(before: string, after: string, caret: number): { text: string; caret: number } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const removed = before.slice(p, before.length - s);
  const inserted = after.slice(p, after.length - s);
  if (!removed && !inserted) return { text: after, caret };
  const changes = listChanges(before);
  const inIns = (i: number) => changes.some((c) => c.kind === 'ins' && i >= c.start + 3 && i <= c.end - 3);
  // Inside an insertion, an edit only changes what was inserted.
  if (inIns(p) && inIns(before.length - s)) return { text: after, caret };
  // Removing part of a change's own markup (backspace or delete over it): step past it instead.
  const hit = changes.find((c) => p < c.end && before.length - s > c.start && !(p >= c.start + 3 && before.length - s <= c.end - 3));
  if (hit && !inserted) return { text: before, caret: p >= hit.end - 3 ? hit.start : hit.end };
  let mid = '';
  if (removed) mid += `{--${removed}--}`;
  if (inserted) mid += `{++${inserted}++}`;
  let text = before.slice(0, p) + mid + before.slice(before.length - s);
  let newCaret = inserted ? p + mid.length - 3 : p;
  // Merge with neighbouring changes of the same kind.
  const merge = (pat: string) => {
    let i = text.indexOf(pat);
    while (i >= 0) {
      text = text.slice(0, i) + text.slice(i + pat.length);
      if (i < newCaret) newCaret -= Math.min(pat.length, newCaret - i);
      i = text.indexOf(pat);
    }
  };
  merge('--}{--');
  merge('++}{++');
  return { text, caret: newCaret };
}
