import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { X, Bold, Italic, CaseSensitive, Heading1, Heading2, Minus, Hash, Type, Pilcrow, Plus, GripVertical, Maximize2, Minimize2, Search, ChevronUp, ChevronDown, CircleHelp, AArrowUp, AArrowDown } from 'lucide-react';
import { useStore } from '../../store/store';
import { findElement } from '../../model/surfaces';
import { threadOf } from '../../render/compile';
import type { TextElement, CharacterStyleProps } from '../../model/types';
import { charPropsToString } from '../../engine/text/props';
import { getFamilies } from '../../engine/fonts';
import { anchorNames, conditionNames } from '../contents';
import { trackEdit, listChanges, changeAt, resolveChange, acceptChanges, rejectChanges } from '../../engine/text/changes';

/**
 * Smart typing: straight quotes curl by context, -- becomes an em dash and ... an ellipsis. Never
 * inside markup ({…}, […], <…>) on the current line.
 */
function smartType(value: string, caret: number, before: string, autocorrect: { from: string; to: string }[] = []): { value: string; caret: number } {
  if (value.length !== before.length + 1 || caret < 1) return { value, caret };
  // Autocorrect: the word just finished (by a space or punctuation) is replaced from the list.
  if (autocorrect.length && /[\s.,;:!?)\]”’]/.test(value[caret - 1])) {
    const m = /([\p{L}\p{N}'’-]+)$/u.exec(value.slice(0, caret - 1));
    const hit = m && autocorrect.find((a) => a.from === m[1] || (a.from.toLowerCase() === m[1].toLowerCase() && m[1] === m[1].toLowerCase()));
    if (m && hit) {
      const start = caret - 1 - m[1].length;
      return { value: value.slice(0, start) + hit.to + value.slice(caret - 1), caret: start + hit.to.length + 1 };
    }
  }
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  // Tracked changes ({++typed++}, {--deleted--}) are not markup to stay out of: with track changes
  // on, everything typed is inside a {++…++}, and quotes never curled.
  const line = value.slice(lineStart, caret).replace(/\{--[\s\S]*?--\}|\{\+\+|\+\+\}/g, '');
  const open = (o: string, c: string) => line.lastIndexOf(o) > line.lastIndexOf(c);
  // A tag is open after a < that is not a less-than sign (“gutters < 5 mm”).
  if (open('{', '}') || open('[', ']') || /<(?!\s)[^<>]*$/.test(line)) return { value, caret };
  const ch = value[caret - 1], prev = value[caret - 2] ?? '';
  const put = (rep: string, back: number) => ({ value: value.slice(0, caret - back) + rep + value.slice(caret), caret: caret - back + rep.length });
  const before1 = line[line.length - 2] ?? '';
  const opening = !before1 || /[\s([{—–\-“‘\/]/.test(before1);
  if (ch === '"') return put(opening ? '“' : '”', 1);
  if (ch === "'") return put(opening ? '‘' : '’', 1);
  if (ch === '-' && prev === '-') return put('—', 2);
  if (ch === '.' && value.slice(caret - 3, caret) === '...') return put('…', 3);
  return { value, caret };
}

/* -------------------------------------------------------------------------- */
/* Markup highlighting                                                         */
/* -------------------------------------------------------------------------- */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => `<span class="${cls}">${esc(s)}</span>`;

/** Colour one line of story markup so tags, codes and paragraph styles read at a glance. */
function highlightOne(line: string): string {
  let out = '';
  let rest = line;
  const lead = /^((?:\[[^\]\n]{1,400}\]\s*)+)/.exec(rest);
  if (lead) { out += span('hl-para', lead[1]); rest = rest.slice(lead[1].length); }
  const list = /^((?: {2}|\t)*(?:[-•▪◦]|\d{1,3}[.)]|[a-zA-Z]\))[ \t]+)/.exec(rest);
  if (list) { out += span('hl-list', list[1]); rest = rest.slice(list[1].length); }
  else if (/^#{1,2}\s/.test(rest)) { out += span('hl-head', rest); rest = ''; }
  else if (/^(-{3,}|\*\s\*\s\*|⁂|\{(col|column|frame)\})\s*$/.test(rest)) { out += span('hl-code', rest); rest = ''; }
  const re = /(\{fn:(?:[^{}]|\{[^{}]*\})*\})|(\{k:[^}]*\})|(\{[a-z]+(?::[^}]*)?\})|(<\/?\{[^}]*\}>|<\/?[^<>\n]{0,40}>)|(\\.)|(\*\*|\*|\^)|(\t)|(\{\+\+[\s\S]*?\+\+\})|(\{--[\s\S]*?--\})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    out += esc(rest.slice(last, m.index));
    if (m[1]) out += span('hl-fn', m[1]);
    else if (m[2]) out += span('hl-kern', m[2]);
    else if (m[3]) out += span('hl-code', m[3]);
    else if (m[4]) out += span('hl-tag', m[4]);
    else if (m[5]) out += span('hl-mute', m[5]);
    else if (m[6]) out += span('hl-mark', m[6]);
    else if (m[7]) out += span('hl-tab', '\t');
    else if (m[8]) out += span('hl-ins', m[8]);
    else if (m[9]) out += span('hl-del', m[9]);
    last = m.index + m[0].length;
  }
  out += esc(rest.slice(last));
  return out;
}

/** Highlighted lines by their text: a keystroke re-colours only the line it changed. */
const lineHtml = new Map<string, string>();
function highlightLine(line: string): string {
  let h = lineHtml.get(line);
  if (h == null) {
    h = highlightOne(line);
    if (lineHtml.size > 20000) lineHtml.clear();
    lineHtml.set(line, h);
  }
  return h;
}

/**
 * One line of the colour layer. Each line is its own element, so a keystroke in a book-length
 * story updates one line instead of re-parsing the whole layer (which took ~80 ms at 600k
 * characters), and its own block, so the browser lays out only that line again (one inline run
 * for the whole story took ~140 ms per keystroke at 300k). The text and newlines are exactly the
 * story's, so the layer still lines up with the text box.
 */
const HlLine = React.memo(function HlLine({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: `${html}\n` }} />;
});

/* -------------------------------------------------------------------------- */
/* Insert menu                                                                 */
/* -------------------------------------------------------------------------- */

const INSERTS: { group: string; items: { label: string; text: string; hint?: string }[] }[] = [
  { group: 'Breaks', items: [
    { label: 'Forced line break', text: '{br}', hint: 'New line, same paragraph' },
    { label: 'Column break', text: '\n{col}\n' },
    { label: 'Frame / page break', text: '\n{frame}\n' },
    { label: 'Section break ⁂', text: '\n---\n' },
    { label: 'Discretionary hyphen', text: '{shy}', hint: 'Break here only if needed' },
    { label: 'Non-breaking hyphen', text: '{nbhy}' },
  ] },
  { group: 'Spaces', items: [
    { label: 'Em space', text: '{em}' }, { label: 'En space', text: '{en}' }, { label: 'Thin space (⅛ em)', text: '{thin}' },
    { label: 'Hair space', text: '{hair}' }, { label: 'Figure space', text: '{figure}' }, { label: 'Punctuation space', text: '{punct}' },
    { label: 'Non-breaking space', text: '{nbsp}' }, { label: 'Narrow no-break space', text: '{nnbsp}' },
  ] },
  { group: 'Tabs & notes', items: [
    { label: 'Tab', text: '\t' }, { label: 'Right-indent tab', text: '{rtab}' }, { label: 'Indent to here', text: '{here}' },
    { label: 'Footnote', text: '{fn:}', hint: 'Type the note inside the braces' }, { label: 'Endnote', text: '{en:}', hint: 'Collected at the end of the story' },
    { label: 'Index entry', text: '{ix:}', hint: 'Type the index term inside the braces; term!subterm for a sub-entry' }, { label: 'Page number', text: '{page}' }, { label: 'Roman page number', text: '{page:roman}' }, { label: 'Chapter (running head)', text: '{chapter}' }, { label: 'Book title', text: '{title}' },
  ] },
  { group: 'References & editions', items: [
    { label: 'Anchor', text: '{anchor:}', hint: 'Name a place for cross-references: {anchor:fig-3}' },
    { label: 'Cross-ref page', text: '{xref:}', hint: 'The page an anchor is set on: {xref:fig-3}' },
    { label: 'Cross-ref text', text: '{xreftext:}', hint: 'The text of the paragraph holding the anchor' },
    { label: 'Conditional text', text: '{if:Condition}', hint: 'Wraps the selection in {if:Name}…{/if}; show or hide conditions under Document › Conditional text' },
    { label: 'Ruby', text: '{ruby:|}', hint: '{ruby:base|annotation} — furigana or a gloss set small above the base' },
    { label: 'Warichu', text: '{wari:}', hint: '{wari:top|bottom} — a note set in two half-size lines inside the line' },
    { label: 'Note (non-printing)', text: '{note:}', hint: 'An editorial note kept in the story but never set' },
    { label: 'Date', text: '{date}' }, { label: 'Last page', text: '{lastpage}' },
  ] },
  { group: 'Characters', items: [
    { label: '— em dash', text: '—' }, { label: '– en dash', text: '–' }, { label: '… ellipsis', text: '…' }, { label: '‘ ’ single quotes', text: '‘’' },
    { label: '“ ” double quotes', text: '“”' }, { label: '« » guillemets', text: '« »' }, { label: '§ section', text: '§' }, { label: '¶ pilcrow', text: '¶' },
    { label: '† dagger', text: '†' }, { label: '‡ double dagger', text: '‡' }, { label: '× multiplication', text: '×' }, { label: '− minus', text: '−' },
    { label: '© ® ™', text: '©' }, { label: '❧ hedera', text: '❧' }, { label: '☞ manicule', text: '☞' }, { label: '′ ″ primes', text: '′' },
  ] },
];

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

type Pop = null | 'char' | 'para' | 'insert';

/**
 * Where the editor sits on the canvas once moved, its size, text size and whether the cheat sheet
 * shows, remembered in this browser (no position: beside the frame being edited).
 */
interface Placement { x?: number; y?: number; w?: number; h?: number; max?: boolean; size?: number; help?: boolean }
const PLACEMENT = 'bds.storyEditor';
function readPlacement(): Placement {
  try { const p = JSON.parse(localStorage.getItem(PLACEMENT) ?? '{}'); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}
function writePlacement(p: Placement) {
  try { localStorage.setItem(PLACEMENT, JSON.stringify(p)); } catch { /* storage blocked: forget it */ }
}
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Words, characters and paragraphs as the story reads: markup, notes and deletions left out. */
function countStory(text: string): { words: number; chars: number; paras: number } {
  const plain = text
    .replace(/\{(?:note|ix|anchor|k|img|xref|xreftext|if|running):[^{}]*\}|\{--[\s\S]*?--\}|\{\/if\}/g, '')
    .replace(/\{(?:fn|en|ruby|wari):|\{\+\+|\+\+\}|\}/g, ' ')
    .replace(/\{[a-z]+(?::[^{}]*)?\}|<\/?\{[^}]*\}>|<\/?[^<>\n]{0,40}>|^(?:\[[^\]\n]{1,400}\]\s*)+|^#{1,2}\s|[*^]|\\(?=.)/gm, ' ');
  let paras = 0;
  for (const line of plain.split('\n')) if (line.trim() && !/^\s*(-{3,}|⁂)\s*$/.test(line)) paras++;
  return { words: (plain.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length, chars: plain.replace(/\s+/g, ' ').trim().length, paras };
}

/**
 * A DOM range over story characters [at, at + len) in the colour layer, whose text is the story's
 * exactly, one element per line: used to mark a find match and to scroll a range into view.
 */
function rangeAt(pre: HTMLElement | null, text: string, at: number, len: number): Range | null {
  if (!pre) return null;
  let line = 0, start = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) { line++; start = i + 1; }
  const span = pre.children[line];
  if (!span) return null;
  const nl = text.indexOf('\n', at);
  const end = Math.min(at + len, nl < 0 ? text.length : nl);
  const pos = (off: number): [Node, number] | null => {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const l = n.textContent?.length ?? 0;
      if (off <= l) return [n, off];
      off -= l;
      last = n;
    }
    return last ? [last, last.textContent?.length ?? 0] : null;
  };
  const a = pos(at - start), b = pos(end - start);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1]);
  return r;
}

/** Matches of a plain search in the story (case ignored), at most a few thousand. */
function findAll(text: string, q: string): number[] {
  if (!q) return [];
  // Case-blind on the story itself: lower-casing it first moved every match after an İ by one.
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), out: number[] = [];
  for (let m = re.exec(text); m && out.length < 5000; m = re.exec(text)) out.push(m.index);
  return out;
}

/** Floating story editor: edits the head of the frame's thread, so the whole story reflows. */
export function TextStoryEditor({ elementId, anchor, viewport }: { elementId: string; anchor: { x: number; y: number; w: number; h: number }; viewport: { w: number; h: number } }) {
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);
  const chain = threadOf(project, elementId);
  const paraStyles = project.paragraphStyles ?? [];
  const anchors = useMemo(() => anchorNames(project), [project]);
  const conditions = useMemo(() => conditionNames(project), [project]);
  const charStyles = project.characterStyles ?? [];
  const [caret, setCaret] = useState(0);
  const [pop, setPop] = useState<Pop>(null);
  const headId = chain[0] ?? elementId;
  const head = findElement(project, headId)?.el as TextElement | undefined;
  const checkpointed = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);
  // When smart typing, track changes, an insert, a style or undo rewrite the text, React's new
  // value puts the caret at the end (and scrolls there): put it back as soon as the value is
  // committed, before the next keystroke arrives (a frame later was too late for fast typing in a
  // long story, and the next letters landed at the end).
  const pendingSel = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const p = pendingSel.current;
    if (p == null || !ref.current) return;
    pendingSel.current = null;
    ref.current.setSelectionRange(p[0], p[1]);
  });
  /** Select [a, b] once the text is committed; a toolbar button gives the focus back to the text. */
  const selectAfter = (a: number, b = a) => {
    pendingSel.current = [a, b];
    const top = ref.current?.scrollTop;
    requestAnimationFrame(() => {
      const ta = ref.current;
      if (!ta) return;
      const pending = pendingSel.current?.[0] === a && pendingSel.current[1] === b;
      if (pending) pendingSel.current = null;
      // Typing: select if the text did not change (nothing committed); else leave later keys alone.
      if (document.activeElement === ta) { if (pending) ta.setSelectionRange(a, b); return; }
      // A toolbar button has the focus, and a text box without it loses its selection to new text:
      // select, keep the scroll, then focus (focusing first scrolls to the old selection).
      ta.setSelectionRange(a, b);
      if (top != null) ta.scrollTop = top;
      ta.focus();
    });
  };
  // Keyed by their text (and which repeat of it), not their place: a return near the top of a
  // book-length story adds one line to the layer instead of re-rendering every line after it.
  const lines = useMemo(() => {
    const seen = new Map<string, number>();
    return (head ? head.text.split('\n') : []).map((t) => {
      const n = seen.get(t) ?? 0;
      seen.set(t, n + 1);
      return { key: `${n}:${t}`, html: highlightLine(t) };
    });
  }, [head?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the editor sits (moved, resized, maximised) and its text size, remembered in this browser.
  const [place, setPlace] = useState<Placement>(readPlacement);
  useEffect(() => writePlacement(place), [place]);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Height of the toolbars and footer around the text, so a maximised editor fits the canvas.
  const [chrome, setChrome] = useState(150);
  useLayoutEffect(() => {
    if (!boxRef.current || !bodyRef.current) return;
    const c = boxRef.current.offsetHeight - bodyRef.current.offsetHeight;
    if (Math.abs(c - chrome) > 1) setChrome(c);
  });

  // Find in this story (⌘F): the matches and the one shown, and what was looked for last (⌘F
  // after Esc shows it again, selected).
  const [find, setFind] = useState<string | null>(null);
  const [hit, setHit] = useState(-1);
  const findRef = useRef<HTMLInputElement>(null);
  const lastFind = useRef('');
  const matches = useMemo(() => (find && head ? findAll(head.text, find) : []), [find, head?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (find != null) findRef.current?.focus(); }, [find != null]); // eslint-disable-line react-hooks/exhaustive-deps
  // The text changed under an open find bar, or this is another story: the numbered match is gone.
  useEffect(() => setHit(-1), [head?.text, headId]);
  // The match shown is marked in the coloured layer, so the find field can keep the focus.
  useLayoutEffect(() => {
    const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const Mark = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !Mark) return;
    reg.delete('story-find');
    const at = find && hit >= 0 ? matches[hit] : undefined;
    const r = at != null && head ? rangeAt(hlRef.current, head.text, at, find!.length) : null;
    if (r) reg.set('story-find', new Mark(r));
  });
  useEffect(() => () => { (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete('story-find'); }, []);

  // Words and characters, counted once typing pauses (a whole book takes a moment).
  const [counts, setCounts] = useState<ReturnType<typeof countStory> | null>(null);
  useEffect(() => {
    if (!head) return;
    const t = setTimeout(() => setCounts(countStory(head.text)), 400);
    return () => clearTimeout(t);
  }, [head?.text]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Scroll the text so story offset `at` sits a third of the way down (exact, wrapped lines too). */
  const revealRef = useRef<(at: number, len?: number) => void>(() => {});
  revealRef.current = (at: number, len = 1) => {
    const ta = ref.current, pre = hlRef.current;
    if (!ta || !pre || !head) return;
    const r = rangeAt(pre, head.text, at, Math.max(1, len));
    const box = r?.getBoundingClientRect();
    if (!box) return;
    ta.scrollTop = Math.max(0, box.top - pre.getBoundingClientRect().top + pre.scrollTop - ta.clientHeight / 3);
  };

  useEffect(() => {
    ref.current?.focus();
    checkpointed.current = false;
  }, [elementId]);

  // Glyphs clicked in the Font Studio arrive here and are typed at the cursor.
  const insertRef = useRef<(s: string) => void>(() => {});
  useEffect(() => {
    const on = (e: Event) => insertRef.current((e as CustomEvent<string>).detail);
    window.addEventListener('bds:insert', on);
    // Find / spelling: select a range of the story.
    const sel = (e: Event) => {
      const { start, end } = (e as CustomEvent<{ start: number; end: number }>).detail;
      requestAnimationFrame(() => {
        const ta = ref.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(start, end);
        setCaret(start);
        revealRef.current(start, end - start);
      });
    };
    window.addEventListener('bds:select', sel);
    return () => { window.removeEventListener('bds:insert', on); window.removeEventListener('bds:select', sel); };
  }, []);

  if (!head || head.type !== 'text') return null;

  // Size and place: maximised, where it was moved to (kept on the canvas), or beside the frame.
  // At least 280 px wide, but never wider than the canvas (phones).
  const fontSize = clamp(place.size ?? 14, 11, 24);
  const maxBody = Math.max(80, viewport.h - 16 - chrome);
  const width = place.max ? viewport.w - 16 : clamp(place.w ?? Math.min(480, Math.max(340, anchor.w)), Math.min(280, viewport.w - 16), viewport.w - 16);
  let bodyH = place.max ? maxBody : clamp(place.h ?? 256, 80, maxBody);
  let left: number, top: number;
  if (place.max) { left = 8; top = 8; }
  else if (place.x != null && place.y != null) {
    left = clamp(place.x, 8, viewport.w - width - 8);
    top = clamp(place.y, 8, viewport.h - 40);
    // Shorter rather than past the bottom of the canvas (a smaller window), so the resize corner
    // stays in reach; parked lower than that, only the header shows.
    bodyH = clamp(bodyH, 80, viewport.h - 8 - top - chrome);
  } else {
    left = anchor.x + anchor.w + 12;
    if (left + width > viewport.w - 8) left = Math.max(8, anchor.x - width - 12);
    if (left < 8) left = Math.max(8, Math.min(viewport.w - width - 8, anchor.x));
    top = clamp(anchor.y, 8, viewport.h - bodyH - chrome - 8);
  }

  /** Follow the pointer until it is released. */
  const drag = (e: React.PointerEvent, onMove: (dx: number, dy: number) => void) => {
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  /** The header moves the editor (its buttons still work); a double-click puts it back beside the frame. */
  const onHeader = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, select, input, label')) return;
    const l0 = left, t0 = top;
    drag(e, (dx, dy) => setPlace((p) => ({ ...p, max: false, x: l0 + dx, y: t0 + dy })));
  };
  const dock = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, select, input, label')) return;
    setPlace((p) => ({ ...p, max: false, x: undefined, y: undefined }));
  };
  /** The corner resizes the editor and pins it where it is. */
  const onResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const l0 = left, t0 = top, w0 = width, h0 = bodyH;
    setPlace((p) => ({ ...p, max: false, x: l0, y: t0, w: w0, h: h0 }));
    drag(e, (dx, dy) => setPlace((p) => ({ ...p, w: Math.max(280, w0 + dx), h: Math.max(80, h0 + dy) })));
  };

  /** Show the next (1) or previous (−1) match: the first after the cursor when none is shown yet. */
  const go = (dir: 1 | -1, select = false) => {
    if (!matches.length || !find) return;
    let i = hit;
    if (i < 0) {
      const c = ref.current?.selectionStart ?? caret;
      i = dir > 0 ? matches.findIndex((m) => m >= c) : -1;
      if (dir < 0) for (let k = matches.length - 1; k >= 0; k--) if (matches[k] < c) { i = k; break; }
      if (i < 0) i = dir > 0 ? 0 : matches.length - 1;
    } else i = (i + dir + matches.length) % matches.length;
    setHit(i);
    const at = matches[i];
    if (select && ref.current) { ref.current.setSelectionRange(at, at + find.length); setCaret(at); }
    requestAnimationFrame(() => revealRef.current(at, find.length));
  };
  /** Close the find bar with the match shown selected in the text. */
  const closeFind = () => {
    const at = find && hit >= 0 ? matches[hit] : undefined;
    const len = find?.length ?? 0;
    lastFind.current = find ?? '';
    setFind(null);
    setHit(-1);
    const ta = ref.current;
    if (!ta) return;
    // Select before focusing: focus scrolls to the selection the text box had (the top of the
    // story, often), and selecting afterwards does not scroll back to the match.
    if (at != null) { ta.setSelectionRange(at, at + len); setCaret(at); }
    ta.focus();
  };
  const openFind = () => {
    const ta = ref.current;
    const picked = ta && ta.selectionEnd > ta.selectionStart && ta.selectionEnd - ta.selectionStart < 80 ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : null;
    setFind(picked && !picked.includes('\n') ? picked : find ?? lastFind.current);
    setHit(-1);
    requestAnimationFrame(() => findRef.current?.select());
  };

  // The paragraph at the cursor and its style, for the footer.
  let paraAt = 1;
  for (let i = head.text.indexOf('\n'); i >= 0 && i < caret; i = head.text.indexOf('\n', i + 1)) paraAt++;
  const lineStart = head.text.lastIndexOf('\n', caret - 1) + 1;
  const styleAt = /^\[([^\]{}\n]{1,80})\]/.exec(head.text.slice(lineStart, lineStart + 90))?.[1];

  // One undo step per burst of typing: after a pause of a second the next edit starts a new step.
  const setText = (text: string) => {
    const s = useStore.getState();
    if (!checkpointed.current) { s.checkpoint(); checkpointed.current = true; }
    s.updateElement(headId, { text } as Partial<TextElement>, { history: false });
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { checkpointed.current = false; }, 1000);
  };

  const wrap = (before: string, after = before) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const next = value.slice(0, a) + before + value.slice(a, b) + after + value.slice(b);
    setText(next);
    selectAfter(a + before.length, b + before.length);
  };
  const linePrefix = (prefix: string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const line = value.slice(start);
    const stripped = line.replace(/^(#{1,2}\s)/, '');
    setText(value.slice(0, start) + prefix + stripped);
    selectAfter(Math.max(start + prefix.length, a + prefix.length - (line.length - stripped.length)));
  };
  const insert = (str: string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    setText(value.slice(0, a) + str + value.slice(b));
    // Leave the caret inside an empty footnote / anchor / pair of quotes.
    const back = str === '{ruby:|}' ? 2 : /^\{\w+:\}$/.test(str) ? 1 : str === '‘’' || str === '“”' ? 1 : 0;
    selectAfter(a + str.length - back);
  };

  insertRef.current = insert;

  /** Conditional text around the selection, the condition name selected for typing over. */
  const wrapCondition = () => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const name = conditions[0] ?? 'Condition';
    setText(value.slice(0, a) + `{if:${name}}` + value.slice(a, b) + '{/if}' + value.slice(b));
    selectAfter(a + 4, a + 4 + name.length);
  };

  /** Rewrite the paragraph tags of every line the selection touches. */
  const editLines = (fn: (bareLine: string, tags: string[]) => string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const endNl = value.indexOf('\n', b);
    const end = endNl < 0 ? value.length : endNl;
    const old = value.slice(start, end).split('\n');
    const lines = old.map((ln) => {
      const tags: string[] = [];
      let rest = ln;
      for (;;) { const m = /^\[([^\]\n]{1,400})\]\s*/.exec(rest); if (!m) break; tags.push(m[1]); rest = rest.slice(m[0].length); }
      return rest.trim() ? fn(rest, tags) : ln;
    });
    const block = lines.join('\n');
    setText(value.slice(0, start) + block + value.slice(end));
    // The selection keeps to the same words (the tags in front of the first line changed length).
    const shift = lines[0].length - old[0].length;
    selectAfter(Math.max(start, a + shift), Math.max(start, b + block.length - (end - start)));
  };
  const names = new Set(paraStyles.map((p) => p.name.toLowerCase()));
  /** Paragraph style tag on every line the selection touches (null removes it); local formatting stays. */
  const paraTag = (name: string | null) => editLines((rest, tags) => {
    const keep = tags.filter((t) => !names.has(t.trim().toLowerCase()));
    return [...(name ? [name] : []), ...keep].map((t) => `[${t}] `).join('') + rest;
  });
  const paraLocal = (props: string | null) => editLines((rest, tags) => {
    const keep = tags.filter((t) => !t.trim().startsWith('{'));
    return [...keep, ...(props ? [`{${props}}`] : [])].map((t) => `[${t}] `).join('') + rest;
  });

  /** Kern the pair at the caret by `delta` thousandths of an em, editing an adjacent {k:…} tag. */
  const kern = (delta: number) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, value } = ta;
    const before = /\{k:([+-]?\d+(?:\.\d+)?)\}$/.exec(value.slice(0, a));
    const after = before ? null : /^\{k:([+-]?\d+(?:\.\d+)?)\}/.exec(value.slice(a));
    const cur = before ? parseFloat(before[1]) : after ? parseFloat(after[1]) : 0;
    const next = Math.round(cur + delta);
    const tag = next ? `{k:${next}}` : '';
    const from = before ? a - before[0].length : a;
    const to = after ? a + after[0].length : a;
    setText(value.slice(0, from) + tag + value.slice(to));
    const pos = from + tag.length;
    setCaret(pos);
    selectAfter(pos);
  };
  const caretKern = (() => {
    const v = head.text;
    const m = /\{k:([+-]?\d+(?:\.\d+)?)\}$/.exec(v.slice(0, caret)) ?? /^\{k:([+-]?\d+(?:\.\d+)?)\}/.exec(v.slice(caret));
    return m ? parseFloat(m[1]) : 0;
  })();

  const tb = 'inline-flex h-6 w-6 items-center justify-center rounded text-ink-300 hover:bg-ink-600 hover:text-ink-100';
  const tbOn = 'bg-ink-600 text-ink-100';
  const sel = 'h-6 max-w-[104px] rounded border border-ink-600 bg-ink-800 px-1 text-[10.5px] text-ink-200 outline-none';
  // The coloured layer and the text box must wrap identically: same font, padding and the same
  // scrollbar gutter (a long story gives the text box a scrollbar, which narrowed it before).
  const font: React.CSSProperties = { fontFamily: '"BDS EB Garamond", Georgia, serif', fontSize, lineHeight: 1.45, padding: '8px 12px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal', tabSize: 4, scrollbarGutter: 'stable', letterSpacing: 'normal', fontWeight: 400 };
  return (
    <div
      ref={boxRef}
      className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-850/97 shadow-2xl backdrop-blur"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <style>{`.hl-para{color:#e0b062}.hl-list{color:#9aa0b0}.hl-head{color:#f6d38a}.hl-tag{color:#5ec4b6}.hl-code{color:#7fa8ff}.hl-kern{color:#c39bff}.hl-fn{color:#9ed07f}.hl-mark{color:#e5483a}.hl-mute{color:#777}.hl-tab{background:rgba(127,168,255,.15);border-radius:2px}.hl-ins{color:#7fd88f;background:rgba(127,216,143,.12);text-decoration:underline}.hl-del{color:#f08a73;text-decoration:line-through;background:rgba(240,138,115,.1)}::highlight(story-find){background-color:rgba(246,211,138,.42)}`}</style>
      <div className="flex cursor-grab touch-none flex-wrap items-center gap-0.5 border-b border-ink-700 px-1.5 py-1 active:cursor-grabbing" onPointerDown={onHeader} onDoubleClick={dock} title="Drag to move the editor · double-click to put it back beside the frame">
        <GripVertical size={12} className="shrink-0 text-ink-500" />
        <span className="mr-1 select-none whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Story{chain.length > 1 ? ` · ${chain.length} frames` : ''}</span>
        <button type="button" title="Italic (*text*, ⌘I)" className={tb} onClick={() => wrap('*')}><Italic size={13} /></button>
        <button type="button" title="Bold (**text**, ⌘B)" className={tb} onClick={() => wrap('**')}><Bold size={13} /></button>
        <button type="button" title="Small caps (^text^)" className={tb} onClick={() => wrap('^')}><CaseSensitive size={14} /></button>
        <button type="button" title="Heading (# )" className={tb} onClick={() => linePrefix('# ')}><Heading1 size={13} /></button>
        <button type="button" title="Subheading (## )" className={tb} onClick={() => linePrefix('## ')}><Heading2 size={13} /></button>
        <button type="button" title="Section break (---)" className={tb} onClick={() => insert('\n---\n')}><Minus size={13} /></button>
        <button type="button" title="Page number token" className={tb} onClick={() => insert('{page}')}><Hash size={13} /></button>
        <span className="mx-0.5 h-4 w-px bg-ink-700" />
        <button type="button" title="Character formatting for the selection" className={clsx(tb, pop === 'char' && tbOn)} onClick={() => setPop(pop === 'char' ? null : 'char')}><Type size={13} /></button>
        <button type="button" title="Paragraph formatting for these lines" className={clsx(tb, pop === 'para' && tbOn)} onClick={() => setPop(pop === 'para' ? null : 'para')}><Pilcrow size={13} /></button>
        <button type="button" title="Insert special characters, spaces and breaks" className={clsx(tb, pop === 'insert' && tbOn)} onClick={() => setPop(pop === 'insert' ? null : 'insert')}><Plus size={13} /></button>
        <span className="flex-1" />
        <span className="flex items-center whitespace-nowrap">
          <button type="button" title="Tighten the pair at the cursor (⌥←)" className={tb} onClick={() => kern(-10)}><span className="text-[10px] tracking-[-0.15em]">AV</span></button>
          <span className="w-7 text-center font-mono text-[9.5px] tabular-nums text-ink-400" title="Kerning at the cursor, ‰ em">{caretKern || '0'}</span>
          <button type="button" title="Loosen the pair at the cursor (⌥→)" className={tb} onClick={() => kern(10)}><span className="text-[10px] tracking-[0.15em]">AV</span></button>
        </span>
      </div>
      {/* Wraps on a narrow canvas, so find, maximise and close never fall off the right edge. */}
      <div className="flex flex-wrap items-center gap-1 border-b border-ink-700 px-1.5 py-1">
        <select className={sel} value="" title="Paragraph style for the lines in the selection" onChange={(e) => { const v = e.target.value; if (v === '__none') paraTag(null); else if (v) paraTag(v); }}>
          <option value="">¶ Paragraph style…</option>
          <option value="__none">No paragraph style</option>
          {paraStyles.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
        <select className={sel} value="" title="Character style for the selected words" onChange={(e) => { const v = e.target.value; if (v) wrap(`<${v}>`, `</${v}>`); }}>
          <option value="">a Character style…</option>
          {charStyles.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        {!paraStyles.length && !charStyles.length && <span className="truncate text-[10px] text-ink-500">Add styles in the Type panel</span>}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" title="Find in this story (⌘F)" className={clsx(tb, find != null && tbOn)} onClick={() => (find != null ? closeFind() : openFind())}><Search size={13} /></button>
          <button type="button" title="Smaller text" className={tb} disabled={fontSize <= 11} onClick={() => setPlace((p) => ({ ...p, size: Math.max(11, fontSize - 1) }))}><AArrowDown size={14} /></button>
          <button type="button" title="Larger text" className={tb} disabled={fontSize >= 24} onClick={() => setPlace((p) => ({ ...p, size: Math.min(24, fontSize + 1) }))}><AArrowUp size={14} /></button>
          <button type="button" title={place.help === false ? 'Show the markup cheat sheet' : 'Hide the markup cheat sheet'} className={clsx(tb, place.help !== false && tbOn)} onClick={() => setPlace((p) => ({ ...p, help: p.help === false }))}><CircleHelp size={13} /></button>
          <button type="button" title={place.max ? 'Restore the editor' : 'Fill the canvas with the editor'} className={tb} onClick={() => setPlace((p) => ({ ...p, max: !p.max }))}>{place.max ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
          <button type="button" title="Close (Esc)" className={tb} onClick={() => useStore.getState().setTextEditing(null)}><X size={13} /></button>
        </span>
      </div>
      {find != null && (
        <div className="flex items-center gap-1 border-b border-ink-700 px-1.5 py-1">
          <Search size={12} className="shrink-0 text-ink-500" />
          <input
            ref={findRef}
            value={find}
            placeholder="Find in this story"
            className="h-6 min-w-0 flex-1 rounded border border-ink-600 bg-ink-800 px-1.5 text-[11px] text-ink-100 outline-none focus:border-ink-400"
            onChange={(e) => { setFind(e.target.value); setHit(-1); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
              else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
              else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
              // ⌘F again selects what is looked for (not the browser's own find bar).
              else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findRef.current?.select(); }
            }}
          />
          <span className="w-14 shrink-0 text-right font-mono text-[9.5px] tabular-nums text-ink-400">{!find ? '' : matches.length ? `${hit >= 0 ? hit + 1 : '–'} of ${matches.length}${matches.length >= 5000 ? '+' : ''}` : 'none'}</span>
          <button type="button" title="Previous (⇧↵)" className={tb} disabled={!matches.length} onClick={() => go(-1)}><ChevronUp size={13} /></button>
          <button type="button" title="Next (↵)" className={tb} disabled={!matches.length} onClick={() => go(1)}><ChevronDown size={13} /></button>
          <button type="button" title="Close and select the match (Esc)" className={tb} onClick={closeFind}><X size={12} /></button>
        </div>
      )}
      <ChangesBar text={head.text} caret={caret} tracking={!!project.trackChanges} smart={!!project.smartTyping} onText={(t, c) => { const at = c ?? Math.min(caret, t.length); setText(t); setCaret(at); selectAfter(at); }} />
      {pop === 'char' && <CharFormat onApply={(props) => { if (props) wrap(`<{${props}}>`, '</>'); setPop(null); }} />}
      {pop === 'para' && <ParaFormat onApply={(props) => { paraLocal(props); setPop(null); }} />}
      {pop === 'insert' && (
        <div className="scroll-thin max-h-52 overflow-y-auto border-b border-ink-700 px-2 py-1.5">
          {Object.values(project.assets).some((a) => a.kind === 'image' || a.kind === 'svg') && (
            <div className="mb-1.5">
              <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">Images in the text · click: inline, ⇧-click: full-width figure</div>
              <div className="flex flex-wrap gap-1">
                {Object.values(project.assets).filter((a) => a.kind === 'image' || a.kind === 'svg').slice(0, 24).map((a) => (
                  <button key={a.id} type="button" title={`${a.name} — inline in the line; ⇧-click for a figure the width of the column`}
                    onClick={(e) => insert(e.shiftKey ? `\n{img:${a.id}; w:100%}\n` : `{img:${a.id}; h:${Math.round((head?.style.fontSize ?? 10) * 1.2)}}`)}
                    className="h-10 w-10 overflow-hidden rounded border border-ink-700 bg-ink-900 hover:border-ink-400">
                    <img src={a.src} alt="" className="h-full w-full object-contain" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {INSERTS.map((g) => (
            <div key={g.group} className="mb-1.5">
              <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-500">{g.group}</div>
              <div className="flex flex-wrap gap-1">
                {g.items.map((it) => (
                  <button key={it.label} type="button" title={it.hint ?? it.text} onClick={() => (it.text === '{if:Condition}' ? wrapCondition() : insert(it.text))} className="rounded border border-ink-700 px-1.5 py-0.5 text-[10.5px] text-ink-300 hover:border-ink-500 hover:text-ink-100">{it.label}</button>
                ))}
                {g.group === 'References & editions' && anchors.map((a) => (
                  <button key={a} type="button" title={`Insert {xref:${a}} — the page of this anchor`} onClick={() => insert(`{xref:${a}}`)} className="rounded border border-[#3a6f8f] px-1.5 py-0.5 text-[10.5px] text-[#8ec5e6] hover:border-[#5c9cc2]">→ {a}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div ref={bodyRef} className="relative shrink-0 overflow-hidden" style={{ height: bodyH }}>
        <pre ref={hlRef} aria-hidden lang={head.style.language} dir={head.style.direction} className="scroll-thin pointer-events-none absolute inset-0 m-0 overflow-hidden text-ink-100" style={font}>{lines.map((l) => <HlLine key={l.key} html={l.html} />)}</pre>
        <textarea
          ref={ref}
          value={head.text}
          spellCheck
          lang={head.style.language}
          dir={head.style.direction}
          onScroll={(e) => { if (hlRef.current) hlRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop; }}
          onChange={(e) => {
            const ta = e.target;
            let value = ta.value, pos = ta.selectionStart;
            if (project.smartTyping) ({ value, caret: pos } = smartType(value, pos, head.text, project.autocorrect));
            if (project.trackChanges) ({ text: value, caret: pos } = trackEdit(head.text, value, pos));
            setText(value);
            setCaret(pos);
            if (value !== ta.value || pos !== ta.selectionStart) selectAfter(pos);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { if (pop) setPop(null); else if (find != null) closeFind(); else useStore.getState().setTextEditing(null); }
            // Undo and redo are the book's, a step per burst of typing: the text box's own undo
            // forgets everything typed before smart typing, track changes or an insert rewrote it.
            if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[zy]$/i.test(e.key)) {
              e.preventDefault();
              const s = useStore.getState();
              if (e.shiftKey || e.key.toLowerCase() === 'y') s.redo(); else s.undo();
              checkpointed.current = false;
              const before = head.text;
              const after = (findElement(useStore.getState().project, headId)?.el as TextElement | undefined)?.text;
              if (after != null && after !== before) {
                // The caret goes to the end of what changed.
                let i = 0, j = 0;
                while (i < after.length && i < before.length && after[i] === before[i]) i++;
                while (j < after.length - i && j < before.length - i && after[after.length - 1 - j] === before[before.length - 1 - j]) j++;
                setCaret(after.length - j);
                selectAfter(after.length - j);
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && find) { e.preventDefault(); go(e.shiftKey ? -1 : 1, true); }
            // Tab types a tab (it is a typesetting character here, not focus navigation).
            if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); insert(e.shiftKey ? '{rtab}' : '\t'); }
            // Shift-Return: forced line break inside the paragraph.
            if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insert('{br}'); }
            else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && ref.current) {
              // Next style: a return after a styled paragraph tags the new one.
              const ta = ref.current;
              const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
              const m = /^\[([^\]{}\n]{1,80})\]/.exec(ta.value.slice(start));
              const cur = m ? paraStyles.find((p) => p.name.toLowerCase() === m[1].trim().toLowerCase()) : undefined;
              const next = cur?.nextStyle ? paraStyles.find((p) => p.id === cur.nextStyle) : undefined;
              if (next) { e.preventDefault(); insert(`\n[${next.name}] `); }
            }
            // InDesign's pair kerning keys: ⌥← / ⌥→ by 10/1000 em, with ⇧ by 50.
            if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && ref.current && ref.current.selectionStart === ref.current.selectionEnd) {
              e.preventDefault();
              kern((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 50 : 10));
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
          }}
          className="scroll-thin absolute inset-0 h-full w-full resize-none bg-transparent outline-none"
          style={{ ...font, color: 'transparent', caretColor: '#f0e6d0' }}
        />
      </div>
      <div className="flex items-center gap-2 border-t border-ink-700 px-3 py-1 text-[10px] tabular-nums text-ink-500">
        <span className="truncate">{counts ? `${counts.words.toLocaleString()} words · ${counts.chars.toLocaleString()} characters · ${counts.paras.toLocaleString()} paragraphs` : 'Counting…'}</span>
        <span className="flex-1" />
        <span className="shrink-0 truncate" title="The paragraph the cursor is in, and its style">¶ {paraAt.toLocaleString()}{styleAt ? ` · ${styleAt}` : ''}</span>
      </div>
      {place.help !== false && <div className="border-t border-ink-700 px-3 py-1 text-[10px] leading-snug text-ink-500">
        One paragraph per line · *italic* · **bold** · ^small caps^ · # heading · [Style] / [{'{align:center}'}] paragraph · &lt;Style&gt;…&lt;/Style&gt; · &lt;{'{size:14}'}&gt;…&lt;/&gt; · {'{fn:…}'} note · ⇧↵ line break · ⇥ tab · ⌥←/→ kern · ⌘F find
      </div>}
      <div
        className="absolute bottom-0 right-0 z-10 cursor-nwse-resize touch-none p-0.5 text-ink-500 hover:text-ink-300"
        style={{ width: 18, height: 18 }}
        title="Drag to resize the editor"
        onPointerDown={onResize}
      >
        <svg viewBox="0 0 14 14" className="h-full w-full" aria-hidden><path d="M13 5L5 13M13 9L9 13" stroke="currentColor" strokeWidth="1.2" /></svg>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting popovers                                                         */
/* -------------------------------------------------------------------------- */

const field = 'h-6 w-full rounded border border-ink-600 bg-ink-800 px-1 text-[11px] text-ink-100 outline-none';
const lab = 'block text-[9.5px] text-ink-400';

function CharFormat({ onApply }: { onApply: (props: string | null) => void }) {
  const [p, setP] = useState<CharacterStyleProps>({});
  const up = (k: keyof CharacterStyleProps, v: unknown) => setP((o) => { const n = { ...o } as Record<string, unknown>; if (v === '' || v == null || (typeof v === 'number' && Number.isNaN(v))) delete n[k]; else n[k] = v; return n as CharacterStyleProps; });
  const num = (k: keyof CharacterStyleProps, label: string, ph = '') => (
    <label><span className={lab}>{label}</span><input className={field} type="number" placeholder={ph} value={(p[k] as number | undefined) ?? ''} onChange={(e) => up(k, e.target.value === '' ? '' : parseFloat(e.target.value))} /></label>
  );
  const color = (k: keyof CharacterStyleProps, label: string) => (
    <label><span className={lab}>{label}</span><span className="flex gap-1"><input type="color" className="h-6 w-7 shrink-0 cursor-pointer rounded border border-ink-600 bg-ink-800" value={(p[k] as string | undefined) ?? '#000000'} onChange={(e) => up(k, e.target.value)} />{p[k] != null && <button type="button" className="text-[10px] text-ink-400" onClick={() => up(k, '')}>×</button>}</span></label>
  );
  const check = (k: keyof CharacterStyleProps, label: string) => (
    <label className="flex items-center gap-1 text-[10.5px] text-ink-300"><input type="checkbox" checked={!!p[k]} onChange={(e) => up(k, e.target.checked || '')} />{label}</label>
  );
  const preview = charPropsToString(p);
  return (
    <div className="space-y-1.5 border-b border-ink-700 bg-ink-900/60 px-2 py-2">
      <div className="grid grid-cols-4 gap-1.5">
        <label className="col-span-2"><span className={lab}>Typeface</span>
          <select className={field} value={p.fontFamily ?? ''} onChange={(e) => up('fontFamily', e.target.value)}>
            <option value="">(paragraph)</option>
            {getFamilies().filter((f) => !f.system).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        {num('size', 'Size pt')}
        {num('weight', 'Weight', '400')}
        {num('tracking', 'Tracking ‰')}
        {num('baselineShift', 'Shift pt')}
        {num('hScale', 'H-scale %', '100')}
        {num('skew', 'Skew °')}
        {num('rotate', 'Rotate °')}
        <label><span className={lab}>Case</span>
          <select className={field} value={p.textTransform ?? ''} onChange={(e) => up('textTransform', e.target.value)}>
            <option value="">—</option><option value="uppercase">CAPS</option><option value="lowercase">lower</option><option value="small-caps">Sm. caps</option>
          </select>
        </label>
        <label><span className={lab}>Position</span>
          <select className={field} value={p.position ?? ''} onChange={(e) => up('position', e.target.value)}>
            <option value="">—</option><option value="superscript">Super</option><option value="subscript">Sub</option>
          </select>
        </label>
        <label><span className={lab}>Italic</span>
          <select className={field} value={p.italic == null ? '' : p.italic ? '1' : '0'} onChange={(e) => up('italic', e.target.value === '' ? '' : e.target.value === '1')}>
            <option value="">—</option><option value="1">Italic</option><option value="0">Roman</option>
          </select>
        </label>
        {color('color', 'Colour')}
        {color('highlight', 'Highlight')}
        {color('stroke', 'Outline')}
        {p.stroke && num('strokeWidth', 'Outline pt', '0.3')}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {check('underline', 'Underline')}
        {p.underline && (
          <select className="h-5 rounded border border-ink-600 bg-ink-800 px-1 text-[10.5px] text-ink-100" value={p.underlineStyle ?? 'solid'} onChange={(e) => up('underlineStyle', e.target.value === 'solid' ? '' : e.target.value)}>
            <option value="solid">Solid</option><option value="double">Double</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option><option value="wavy">Wavy</option>
          </select>
        )}
        {p.underline && p.underlineStyle && p.underlineStyle !== 'wavy' && (
          <label className="flex items-center gap-1 text-[10.5px] text-ink-300" title="Colour filling the gaps of the underline">Gap
            <input type="color" className="h-5 w-6 cursor-pointer rounded border border-ink-600 bg-ink-800" value={p.underlineGap ?? '#ffffff'} onChange={(e) => up('underlineGap', e.target.value)} />
          </label>
        )}
        {check('strike', 'Strikethrough')}
        {check('noBreak', 'No break')}
        <select className="h-5 rounded border border-ink-600 bg-ink-800 px-1 text-[10.5px] text-ink-100" value={p.emphasis ?? ''} onChange={(e) => up('emphasis', e.target.value)} title="Kenten: an emphasis mark over every character">
          <option value="">No kenten</option><option value="dot">Kenten •</option><option value="sesame">Kenten ﹅</option><option value="circle">Kenten ◦</option><option value="triangle">Kenten ▴</option>
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded bg-ink-900 px-1.5 py-1 text-[10px] text-[#5ec4b6]">{preview ? `<{${preview}}>…</>` : 'Choose properties to apply to the selection'}</code>
        <button type="button" disabled={!preview} className="rounded bg-rubric px-2 py-1 text-[11px] text-white disabled:opacity-40" onClick={() => onApply(preview || null)}>Apply</button>
      </div>
    </div>
  );
}

function ParaFormat({ onApply }: { onApply: (props: string | null) => void }) {
  const [p, setP] = useState<Record<string, string>>({});
  const up = (k: string, v: string) => setP((o) => { const n = { ...o }; if (!v) delete n[k]; else n[k] = v; return n; });
  const sel = (k: string, label: string, opts: [string, string][]) => (
    <label><span className={lab}>{label}</span><select className={field} value={p[k] ?? ''} onChange={(e) => up(k, e.target.value)}><option value="">—</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
  );
  const num = (k: string, label: string) => (
    <label><span className={lab}>{label}</span><input className={field} type="number" value={p[k] ?? ''} onChange={(e) => up(k, e.target.value)} /></label>
  );
  const preview = Object.entries(p).map(([k, v]) => `${k}:${v}`).join('; ');
  return (
    <div className="space-y-1.5 border-b border-ink-700 bg-ink-900/60 px-2 py-2">
      <div className="grid grid-cols-4 gap-1.5">
        {sel('align', 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['justify', 'Justify'], ['full', 'Justify all']])}
        {sel('rag', 'Rag', [['natural', 'Natural'], ['swiss', 'Swiss'], ['balanced', 'Balanced'], ['wedge', 'Wedge']])}
        {num('size', 'Size pt')}
        {num('leading', 'Leading pt')}
        {num('before', 'Space before')}
        {num('after', 'Space after')}
        {num('indent', 'First indent')}
        {num('left', 'Left indent')}
        {num('right', 'Right indent')}
        {num('track', 'Tracking ‰')}
        {sel('keep', 'Keep with next', [['1', '1 line'], ['2', '2 lines'], ['3', '3 lines']])}
        {sel('start', 'Start', [['column', 'Next column'], ['frame', 'Next frame']])}
        {sel('split', 'Split column', [['2', '2 columns'], ['3', '3 columns'], ['4', '4 columns']])}
        {sel('hyphencolumns', 'Hyphen at column end', [['true', 'Allow'], ['false', 'Avoid']])}
      </div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded bg-ink-900 px-1.5 py-1 text-[10px] text-[#e0b062]">{preview ? `[{${preview}}]` : 'Local formatting for the lines in the selection'}</code>
        <button type="button" className="rounded border border-ink-600 px-2 py-1 text-[11px] text-ink-300" onClick={() => onApply(null)} title="Remove local paragraph formatting">Clear</button>
        <button type="button" disabled={!preview} className="rounded bg-rubric px-2 py-1 text-[11px] text-white disabled:opacity-40" onClick={() => onApply(preview || null)}>Apply</button>
      </div>
    </div>
  );
}

/** Track changes and smart typing: the toggles, the change count, accept / reject. */
function ChangesBar({ text, caret, tracking, smart, onText }: { text: string; caret: number; tracking: boolean; smart: boolean; onText: (t: string, caret?: number) => void }) {
  const changes = useMemo(() => listChanges(text), [text]);
  const here = changeAt(text, caret);
  const toggle = (k: 'trackChanges' | 'smartTyping', v: boolean) => useStore.getState().update((d) => { d[k] = v; }, { history: false });
  const btn = 'rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-ink-500 hover:text-ink-100 disabled:opacity-35';
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-ink-700 px-1.5 py-1 text-[10px] text-ink-400">
      <label className="flex items-center gap-1" title="Record insertions and deletions as tracked changes; the page sets the text with every change accepted"><input type="checkbox" checked={tracking} onChange={(e) => toggle('trackChanges', e.target.checked)} />Track changes</label>
      <label className="ml-1.5 flex items-center gap-1" title="Curly quotes, -- to an em dash, ... to an ellipsis as you type"><input type="checkbox" checked={smart} onChange={(e) => toggle('smartTyping', e.target.checked)} />Smart typing</label>
      {changes.length > 0 && (
        <>
          <span className="ml-auto tabular-nums">{changes.length} change{changes.length === 1 ? '' : 's'}</span>
          <button type="button" className={btn} disabled={!here} title="Accept the change at the cursor" onClick={() => here && onText(resolveChange(text, here, true), here.start)}>Accept</button>
          <button type="button" className={btn} disabled={!here} title="Reject the change at the cursor" onClick={() => here && onText(resolveChange(text, here, false), here.start)}>Reject</button>
          <button type="button" className={btn} title="Go to the next change" onClick={() => { const n = changes.find((c) => c.start > caret) ?? changes[0]; if (n) onText(text, n.start + 3); }}>Next</button>
          <button type="button" className={btn} onClick={() => onText(acceptChanges(text))}>Accept all</button>
          <button type="button" className={btn} onClick={() => onText(rejectChanges(text))}>Reject all</button>
        </>
      )}
    </div>
  );
}
