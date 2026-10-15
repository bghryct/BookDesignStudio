import React, { useEffect, useRef } from 'react';
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

  const tb = 'inline-flex h-6 w-6 items-center justify-center rounded text-ink-300 hover:bg-ink-600 hover:text-ink-100';
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
        <button type="button" title="Close (Esc)" className={tb} onClick={() => useStore.getState().setTextEditing(null)}><X size={13} /></button>
      </div>
      <textarea
        ref={ref}
        value={head.text}
        spellCheck
        lang={head.style.language}
        dir={head.style.direction}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') useStore.getState().setTextEditing(null);
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('*'); }
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); }
        }}
        className="scroll-thin h-64 w-full resize-y bg-transparent px-3 py-2 font-serif text-[14px] leading-[1.45] text-ink-100 outline-none"
        style={{ fontFamily: '"BDS EB Garamond", Georgia, serif' }}
      />
      <div className="border-t border-ink-700 px-3 py-1 text-[10px] text-ink-500">
        One paragraph per line · *italic* · **bold** · ^small caps^ · # heading · ## subhead · --- break
      </div>
    </div>
  );
}
