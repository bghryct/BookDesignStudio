import React, { useEffect, useRef, useState } from 'react';
import { X, Bold, Italic, CaseSensitive, Heading1, Heading2, Minus, Hash } from 'lucide-react';
import { useStore } from '../../store/store';
import { findElement } from '../../model/surfaces';
import { threadOf } from '../../render/compile';
import type { TextElement } from '../../model/types';

/** Floating story editor: edits the head of the frame's thread, so the whole story reflows. */
export function TextStoryEditor({ elementId, anchor, viewport }: { elementId: string; anchor: { x: number; y: number; w: number; h: number }; viewport: { w: number; h: number } }) {
  const project = useStore((s) => s.project);
  const ref = useRef<HTMLTextAreaElement>(null);
  const chain = threadOf(project, elementId);
  const paraStyles = project.paragraphStyles ?? [];
  const charStyles = project.characterStyles ?? [];
  const [caret, setCaret] = useState(0);
  const headId = chain[0] ?? elementId;
  const head = findElement(project, headId)?.el as TextElement | undefined;
  const checkpointed = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    checkpointed.current = false;
  }, [elementId]);

  if (!head || head.type !== 'text') return null;

  const width = Math.min(440, Math.max(300, anchor.w));
  let left = anchor.x + anchor.w + 12;
  if (left + width > viewport.w - 8) left = Math.max(8, anchor.x - width - 12);
  if (left < 8) left = Math.max(8, Math.min(viewport.w - width - 8, anchor.x));
  const top = Math.max(8, Math.min(viewport.h - 320, anchor.y));

  const setText = (text: string) => {
    const s = useStore.getState();
    if (!checkpointed.current) { s.checkpoint(); checkpointed.current = true; }
    s.updateElement(headId, { text } as Partial<TextElement>, { history: false });
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
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + str.length, a + str.length); });
  };

  /** Paragraph style tag on every line the selection touches (null removes it). */
  const paraTag = (name: string | null) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const endNl = value.indexOf('\n', b);
    const end = endNl < 0 ? value.length : endNl;
    const names = new Set(paraStyles.map((p) => p.name.toLowerCase()));
    const lines = value.slice(start, end).split('\n').map((ln) => {
      const m = /^\[([^\]]{1,60})\]\s*/.exec(ln);
      const bare = m && names.has(m[1].trim().toLowerCase()) ? ln.slice(m[0].length) : ln;
      return name && bare.trim() ? `[${name}] ${bare}` : bare;
    });
    setText(value.slice(0, start) + lines.join('\n') + value.slice(end));
    requestAnimationFrame(() => ta.focus());
  };

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
  const sel = 'h-6 max-w-[96px] rounded border border-ink-600 bg-ink-800 px-1 text-[10.5px] text-ink-200 outline-none';
  return (
    <div
      className="absolute z-30 flex flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-850/97 shadow-2xl backdrop-blur"
      style={{ left, top, width }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-0.5 border-b border-ink-700 px-1.5 py-1">
        <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">Story{chain.length > 1 ? ` · ${chain.length} frames` : ''}</span>
        <button type="button" title="Italic (*text*)" className={tb} onClick={() => wrap('*')}><Italic size={13} /></button>
        <button type="button" title="Bold (**text**)" className={tb} onClick={() => wrap('**')}><Bold size={13} /></button>
        <button type="button" title="Small caps (^text^)" className={tb} onClick={() => wrap('^')}><CaseSensitive size={14} /></button>
        <button type="button" title="Heading (# )" className={tb} onClick={() => linePrefix('# ')}><Heading1 size={13} /></button>
        <button type="button" title="Subheading (## )" className={tb} onClick={() => linePrefix('## ')}><Heading2 size={13} /></button>
        <button type="button" title="Section break (---)" className={tb} onClick={() => insert('\n---\n')}><Minus size={13} /></button>
        <button type="button" title="Page number token" className={tb} onClick={() => insert('{page}')}><Hash size={13} /></button>
        <span className="flex-1" />
        <button type="button" title="Tighten the pair at the cursor (⌥←)" className={tb} onClick={() => kern(-10)}>
          <span className="text-[10px] tracking-[-0.15em]">AV</span>
        </button>
        <span className="w-7 text-center font-mono text-[9.5px] tabular-nums text-ink-400" title="Kerning at the cursor, ‰ em">{caretKern || '0'}</span>
        <button type="button" title="Loosen the pair at the cursor (⌥→)" className={tb} onClick={() => kern(10)}>
          <span className="text-[10px] tracking-[0.15em]">AV</span>
        </button>
      </div>
      <div className="flex items-center gap-1 border-b border-ink-700 px-1.5 py-1">
        <select className={sel} value="" title="Paragraph style for the lines in the selection" onChange={(e) => { const v = e.target.value; if (v === '__none') paraTag(null); else if (v) paraTag(v); }}>
          <option value="">¶ Paragraph…</option>
          <option value="__none">No paragraph style</option>
          {paraStyles.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
        <select className={sel} value="" title="Character style for the selected words" onChange={(e) => { const v = e.target.value; if (v) wrap(`<${v}>`, `</${v}>`); }}>
          <option value="">a Character…</option>
          {charStyles.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        {!paraStyles.length && !charStyles.length && <span className="truncate text-[10px] text-ink-500">Add styles in the Type panel</span>}
        <span className="flex-1" />
        <button type="button" title="Close (Esc)" className={tb} onClick={() => useStore.getState().setTextEditing(null)}><X size={13} /></button>
      </div>
      <textarea
        ref={ref}
        value={head.text}
        spellCheck
        lang={head.style.language}
        dir={head.style.direction}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart); }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') useStore.getState().setTextEditing(null);
          // InDesign's pair kerning keys: ⌥← / ⌥→ by 10/1000 em, with ⇧ by 50.
          if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && ref.current && ref.current.selectionStart === ref.current.selectionEnd) {
            e.preventDefault();
            kern((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 50 : 10));
          }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
        }}
        className="scroll-thin h-64 w-full resize-y bg-transparent px-3 py-2 font-serif text-[14px] leading-[1.45] text-ink-100 outline-none"
        style={{ fontFamily: '"BDS EB Garamond", Georgia, serif' }}
      />
      <div className="border-t border-ink-700 px-3 py-1 text-[10px] text-ink-500">
        One paragraph per line · *italic* · **bold** · ^small caps^ · # heading · ## subhead · --- break · [Style] paragraph · &lt;Style&gt;…&lt;/Style&gt; · {'{k:-20}'} kern
      </div>
    </div>
  );
}
