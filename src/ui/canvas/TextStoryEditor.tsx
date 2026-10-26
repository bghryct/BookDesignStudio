import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { X, Bold, Italic, CaseSensitive, Heading1, Heading2, Minus, Hash, Type, Pilcrow, Plus } from 'lucide-react';
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
  const line = value.slice(lineStart, caret);
  const open = (o: string, c: string) => line.lastIndexOf(o) > line.lastIndexOf(c);
  if (open('{', '}') || open('[', ']') || open('<', '>')) return { value, caret };
  const ch = value[caret - 1], prev = value[caret - 2] ?? '';
  const put = (rep: string, back: number) => ({ value: value.slice(0, caret - back) + rep + value.slice(caret), caret: caret - back + rep.length });
  const opening = !prev || /[\s([{—–\-“‘\/]/.test(prev);
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

/** Colour the story markup so tags, codes and paragraph styles read at a glance. */
function highlight(text: string): string {
  return text.split('\n').map((line) => {
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
  }).join('\n') + '\n';
}

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
  // When smart typing or track changes rewrite what was typed, React's new value puts the caret at
  // the end: put it back as soon as the value is committed, before the next keystroke arrives
  // (a frame later was too late for fast typing, and the next letters landed at the end).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const p = pendingCaret.current;
    if (p == null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(p, p);
  });
  const html = useMemo(() => (head ? highlight(head.text) : ''), [head?.text]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Bring the selection into view: put the caret's line near the top.
        const line = ta.value.slice(0, start).split('\n').length - 1;
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16;
        ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
      });
    };
    window.addEventListener('bds:select', sel);
    return () => { window.removeEventListener('bds:insert', on); window.removeEventListener('bds:select', sel); };
  }, []);

  if (!head || head.type !== 'text') return null;

  // At least 340 px wide, but never wider than the canvas (phones).
  const width = Math.max(200, Math.min(480, Math.max(340, anchor.w), viewport.w - 16));
  let left = anchor.x + anchor.w + 12;
  if (left + width > viewport.w - 8) left = Math.max(8, anchor.x - width - 12);
  if (left < 8) left = Math.max(8, Math.min(viewport.w - width - 8, anchor.x));
  const top = Math.max(8, Math.min(viewport.h - 360, anchor.y));

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
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + before.length, b + before.length); });
  };
  const linePrefix = (prefix: string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const line = value.slice(start);
    const stripped = line.replace(/^(#{1,2}\s)/, '');
    setText(value.slice(0, start) + prefix + stripped);
  };
  const insert = (str: string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    setText(value.slice(0, a) + str + value.slice(b));
    // Leave the caret inside an empty footnote / anchor / pair of quotes.
    const back = str === '{ruby:|}' ? 2 : /^\{\w+:\}$/.test(str) ? 1 : str === '‘’' || str === '“”' ? 1 : 0;
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + str.length - back, a + str.length - back); });
  };

  insertRef.current = insert;

  /** Conditional text around the selection, the condition name selected for typing over. */
  const wrapCondition = () => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const name = conditions[0] ?? 'Condition';
    setText(value.slice(0, a) + `{if:${name}}` + value.slice(a, b) + '{/if}' + value.slice(b));
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + 4, a + 4 + name.length); });
  };

  /** Rewrite the paragraph tags of every line the selection touches. */
  const editLines = (fn: (bareLine: string, tags: string[]) => string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const endNl = value.indexOf('\n', b);
    const end = endNl < 0 ? value.length : endNl;
    const lines = value.slice(start, end).split('\n').map((ln) => {
      const tags: string[] = [];
      let rest = ln;
      for (;;) { const m = /^\[([^\]\n]{1,400})\]\s*/.exec(rest); if (!m) break; tags.push(m[1]); rest = rest.slice(m[0].length); }
      return rest.trim() ? fn(rest, tags) : ln;
    });
    setText(value.slice(0, start) + lines.join('\n') + value.slice(end));
    requestAnimationFrame(() => ta.focus());
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
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(pos, pos); setCaret(pos); });
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
  const font: React.CSSProperties = { fontFamily: '"BDS EB Garamond", Georgia, serif', fontSize: 14, lineHeight: 1.45, padding: '8px 12px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal', tabSize: 4, scrollbarGutter: 'stable', letterSpacing: 'normal', fontWeight: 400 };
  return (
    <div
      className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-850/97 shadow-2xl backdrop-blur"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <style>{`.hl-para{color:#e0b062}.hl-list{color:#9aa0b0}.hl-head{color:#f6d38a}.hl-tag{color:#5ec4b6}.hl-code{color:#7fa8ff}.hl-kern{color:#c39bff}.hl-fn{color:#9ed07f}.hl-mark{color:#e5483a}.hl-mute{color:#777}.hl-tab{background:rgba(127,168,255,.15);border-radius:2px}.hl-ins{color:#7fd88f;background:rgba(127,216,143,.12);text-decoration:underline}.hl-del{color:#f08a73;text-decoration:line-through;background:rgba(240,138,115,.1)}`}</style>
      <div className="flex items-center gap-0.5 border-b border-ink-700 px-1.5 py-1">
        <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Story{chain.length > 1 ? ` · ${chain.length} frames` : ''}</span>
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
        <button type="button" title="Tighten the pair at the cursor (⌥←)" className={tb} onClick={() => kern(-10)}><span className="text-[10px] tracking-[-0.15em]">AV</span></button>
        <span className="w-7 text-center font-mono text-[9.5px] tabular-nums text-ink-400" title="Kerning at the cursor, ‰ em">{caretKern || '0'}</span>
        <button type="button" title="Loosen the pair at the cursor (⌥→)" className={tb} onClick={() => kern(10)}><span className="text-[10px] tracking-[0.15em]">AV</span></button>
      </div>
      <div className="flex items-center gap-1 border-b border-ink-700 px-1.5 py-1">
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
        <span className="flex-1" />
        <button type="button" title="Close (Esc)" className={tb} onClick={() => useStore.getState().setTextEditing(null)}><X size={13} /></button>
      </div>
      <ChangesBar text={head.text} caret={caret} tracking={!!project.trackChanges} smart={!!project.smartTyping} onText={(t, c) => { setText(t); if (c != null) { setCaret(c); requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(c, c); }); } }} />
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
      <div className="relative h-64 resize-y overflow-hidden" style={{ minHeight: 120 }}>
        <pre ref={hlRef} aria-hidden className="scroll-thin pointer-events-none absolute inset-0 m-0 overflow-hidden text-ink-100" style={font} dangerouslySetInnerHTML={{ __html: html }} />
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
            if (value !== ta.value || pos !== ta.selectionStart) {
              pendingCaret.current = pos;
              requestAnimationFrame(() => { if (pendingCaret.current === pos) { pendingCaret.current = null; ta.setSelectionRange(pos, pos); } });
            }
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') { if (pop) setPop(null); else useStore.getState().setTextEditing(null); }
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
      <div className="border-t border-ink-700 px-3 py-1 text-[10px] leading-snug text-ink-500">
        One paragraph per line · *italic* · **bold** · ^small caps^ · # heading · [Style] / [{'{align:center}'}] paragraph · &lt;Style&gt;…&lt;/Style&gt; · &lt;{'{size:14}'}&gt;…&lt;/&gt; · {'{fn:…}'} note · ⇧↵ line break · ⇥ tab · ⌥←/→ kern
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
