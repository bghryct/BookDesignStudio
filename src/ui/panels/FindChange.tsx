import React, { useMemo, useState } from 'react';
import { create } from 'zustand';
import type { Draft } from 'immer';
import { useStore } from '../../store/store';
import type { Element, Project, TextElement } from '../../model/types';
import { findElement, spreadIndexOfPage } from '../../model/surfaces';
import { Section, Row, TextInput, Toggle, Button, Hint } from '../controls';
import { riskyPattern } from '../../engine/text/story';
import { RISKY_PATTERN } from './TypeAdvanced';

/** Every story (text frame holding its own text) with where it lives. */
function stories(project: Project): { el: TextElement; where: string; pageIndex: number | null }[] {
  const out: { el: TextElement; where: string; pageIndex: number | null }[] = [];
  const add = (els: Element[], where: string, pageIndex: number | null) => { for (const e of els) if (e.type === 'text' && e.text) out.push({ el: e, where, pageIndex }); };
  project.pages.forEach((p, i) => add(p.elements, `p. ${i + 1}`, i));
  for (const m of project.masters) { add(m.left, `master ${m.name ?? ''}`, null); add(m.right, `master ${m.name ?? ''}`, null); }
  add(project.cover.elements, 'cover', null);
  add(project.jacket?.elements ?? [], 'jacket', null);
  return out;
}

/**
 * Show the surface an element is on — its spread, master, the cover or the jacket — select it and
 * open its story. (Going to a cover or master item from the spreads used to leave it off screen.)
 */
export function revealStory(id: string, openStory = true) {
  const s = useStore.getState();
  const p = s.project;
  const pi = p.pages.findIndex((pg) => pg.elements.some((e) => e.id === id));
  if (pi >= 0) { s.setView('spreads'); s.setSpread(spreadIndexOfPage(p, pi)); }
  else if (p.cover.elements.some((e) => e.id === id)) s.setView('cover');
  else if (p.jacket?.elements.some((e) => e.id === id)) s.setView('jacket');
  else {
    const m = p.masters.find((x) => [...x.left, ...x.right].some((e) => e.id === id));
    if (m) s.setMasterEdit({ id: m.id });
  }
  s.select([id]);
  if (openStory) s.setTextEditing(id);
}

const PRESETS: { label: string; find: string; change: string; grep: boolean }[] = [
  { label: 'Double spaces → one', find: ' {2,}', change: ' ', grep: true },
  { label: 'Straight quotes → curly', find: '"([^"]*)"', change: '“$1”', grep: true },
  { label: "Apostrophes → ’", find: "(\\w)'(\\w)", change: '$1’$2', grep: true },
  { label: '-- → em dash', find: '--', change: '—', grep: false },
  { label: '... → ellipsis', find: '...', change: '…', grep: false },
  { label: 'Ranges 1-9 → en dash', find: '(\\d)-(\\d)', change: '$1–$2', grep: true },
  { label: 'Thin space before ;:!?', find: ' ([;:!?])', change: '{thin}$1', grep: true },
];

interface FindState { find: string; change: string; grep: boolean; caseSensitive: boolean; whole: boolean; pos: { story: number; index: number } | null; msg: string | null }
/**
 * Kept outside the component: Find next selects the frame it finds, and when that is another story
 * the Type panel remounts, which used to empty the fields mid-search.
 */
const useFind = create<FindState>(() => ({ find: '', change: '', grep: false, caseSensitive: false, whole: false, pos: null, msg: null }));

export function FindChangeSection() {
  const project = useStore((s) => s.project);
  const { find, change, grep, caseSensitive, whole, pos, msg } = useFind();
  const setFind = (find: string) => useFind.setState({ find });
  const setChange = (change: string) => useFind.setState({ change });
  const setGrep = (grep: boolean) => useFind.setState({ grep });
  const setCase = (caseSensitive: boolean) => useFind.setState({ caseSensitive });
  const setWhole = (whole: boolean) => useFind.setState({ whole });
  const setPos = (p: FindState['pos']) => useFind.setState({ pos: p });
  const setMsg = (m: string | null) => useFind.setState({ msg: m });

  const risky = grep && !!find && riskyPattern(find);
  const re = useMemo(() => {
    if (!find || risky) return null;
    try {
      let src = grep ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (whole) src = `\\b${src}\\b`;
      return new RegExp(src, caseSensitive ? 'gu' : 'giu');
    } catch { return null; }
  }, [find, grep, caseSensitive, whole, risky]);

  const all = stories(project);
  const count = re ? all.reduce((n, s) => n + (s.el.text.match(re)?.length ?? 0), 0) : 0;

  const reveal = (s: (typeof all)[number], index: number, len: number) => {
    revealStory(s.el.id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea[spellcheck]');
      if (ta) { ta.focus(); ta.setSelectionRange(index, index + len); const before = ta.value.slice(0, index).split('\n').length; ta.scrollTop = Math.max(0, (before - 3) * 20); }
    }));
  };

  // Reads the live project and position: it also runs on the frame after a change.
  const next = () => {
    if (!re) return;
    const list = stories(useStore.getState().project);
    if (!list.length) { setMsg('No match'); return; }
    const start = useFind.getState().pos ?? { story: 0, index: -1 };
    for (let k = 0; k <= list.length; k++) {
      const si = (start.story + k) % list.length;
      const text = list[si].el.text;
      re.lastIndex = k === 0 ? start.index + 1 : 0;
      const m = re.exec(text);
      if (m && (k > 0 || m.index > start.index)) {
        setPos({ story: si, index: m.index });
        setMsg(`${list[si].where}`);
        reveal(list[si], m.index, m[0].length);
        return;
      }
    }
    setMsg('No match');
  };

  const replaceAll = () => {
    if (!re) return;
    let n = 0;
    useStore.getState().update((d) => {
      const visit = (els: Draft<Element>[]) => {
        for (const e of els) {
          if (e.type !== 'text') continue;
          const t = e as Draft<TextElement>;
          const m = t.text.match(re);
          if (!m) continue;
          n += m.length;
          t.text = grep ? t.text.replace(re, change) : t.text.replace(re, () => change);
        }
      };
      for (const p of d.pages) visit(p.elements);
      for (const m of d.masters) { visit(m.left); visit(m.right); }
      visit(d.cover.elements);
      if (d.jacket) visit(d.jacket.elements);
    });
    setMsg(`Changed ${n} occurrence${n === 1 ? '' : 's'}`);
    setPos(null);
  };

  const replaceOne = () => {
    if (!re || !pos) return next();
    const s = all[pos.story];
    const loc = findElement(project, s.el.id);
    if (!loc) return;
    re.lastIndex = pos.index;
    const m = re.exec(s.el.text);
    if (!m || m.index !== pos.index) return next();
    // Replace in place, so lookarounds, anchors and \b see the text around the match.
    let rep = change;
    if (grep) {
      const at = new RegExp(re.source, re.flags.replace('g', '') + 'y');
      at.lastIndex = m.index;
      const out = s.el.text.replace(at, change);
      rep = out.slice(m.index, out.length - (s.el.text.length - m.index - m[0].length));
    }
    useStore.getState().updateElement(s.el.id, { text: s.el.text.slice(0, m.index) + rep + s.el.text.slice(m.index + m[0].length) } as Partial<TextElement>);
    setPos({ story: pos.story, index: pos.index + rep.length - 1 });
    requestAnimationFrame(next);
  };

  return (
    <Section title="Find / change" id="type-find" defaultOpen={false}>
      <TextInput label="Find" mono value={find} onChange={(v) => { setFind(v); setPos(null); setMsg(null); }} />
      <TextInput label="Change to" mono value={change} onChange={setChange} />
      <TextInput label="Find a glyph (paste it, or U+2014)" mono value="" onChange={(v) => {
        const m = /^\s*(?:U\+|0x|\\u\{?)?([0-9a-f]{4,6})\}?\s*$/i.exec(v);
        const ch = m ? String.fromCodePoint(parseInt(m[1], 16)) : [...v.trim()][0];
        if (!ch) return;
        setFind(`\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`); setGrep(true); setWhole(false); setPos(null); setMsg(null);
      }} />
      <div className="grid grid-cols-3 gap-1">
        <Toggle label="GREP" checked={grep} onChange={setGrep} hint="Regular expressions; $1 in the change field inserts a group" />
        <Toggle label="Case" checked={caseSensitive} onChange={setCase} />
        <Toggle label="Whole word" checked={whole} onChange={setWhole} />
      </div>
      {find && !re && <p className="text-[10.5px] text-[#e5483a]">{risky ? RISKY_PATTERN : 'The pattern is not a valid expression.'}</p>}
      <Row>
        <Button disabled={!re || !count} onClick={next}>Find next</Button>
        <Button disabled={!re || !count} onClick={replaceOne}>Change</Button>
        <Button variant="primary" disabled={!re || !count} onClick={replaceAll}>Change all ({count})</Button>
      </Row>
      {msg && <p className="text-[10.5px] text-ink-400">{msg}</p>}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:text-ink-100" onClick={() => { setFind(p.find); setChange(p.change); setGrep(p.grep); setWhole(false); setPos(null); setMsg(null); }}>{p.label}</button>
        ))}
      </div>
      <Hint>Searches every story in the book: pages, masters, cover and jacket. Markup is searched as written.</Hint>
    </Section>
  );
}

const KINDS: Element['type'][] = ['text', 'image', 'shape', 'rule', 'path', 'svg', 'table', 'pattern', 'ornament', 'initial', 'overprint', 'gradient', 'cutout', 'drawing', 'gridtype', 'motif'];

/** Find objects anywhere in the book by kind, name, colour or story text, and select them. */
export function FindObjectsSection() {
  const project = useStore((s) => s.project);
  const [kind, setKind] = useState<string>('');
  const [name, setName] = useState('');
  const [colour, setColour] = useState('');
  const [text, setText] = useState('');
  const results = useMemo(() => {
    if (!kind && !name && !colour && !text) return [];
    const out: { el: Element; where: string; pageIndex: number | null }[] = [];
    const test = (e: Element) => {
      if (kind && e.type !== kind) return false;
      if (name && !e.name.toLowerCase().includes(name.toLowerCase())) return false;
      if (colour) {
        const c = colour.toLowerCase().replace(/^#?/, '#');
        if (!JSON.stringify(e).toLowerCase().includes(c)) return false;
      }
      if (text && !(e.type === 'text' && e.text.toLowerCase().includes(text.toLowerCase()))) return false;
      return true;
    };
    project.pages.forEach((p, i) => { for (const e of p.elements) if (test(e)) out.push({ el: e, where: `p. ${i + 1}`, pageIndex: i }); });
    for (const m of project.masters) for (const e of [...m.left, ...m.right]) if (test(e)) out.push({ el: e, where: `master ${m.name}`, pageIndex: null });
    for (const e of project.cover.elements) if (test(e)) out.push({ el: e, where: 'cover', pageIndex: null });
    for (const e of project.jacket?.elements ?? []) if (test(e)) out.push({ el: e, where: 'jacket', pageIndex: null });
    return out;
  }, [project, kind, name, colour, text]);
  const go = (r: (typeof results)[number]) => revealStory(r.el.id, false);
  return (
    <Section title={`Find objects${results.length ? ` · ${results.length}` : ''}`} id="doc-find-objects" defaultOpen={false}>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="text-[10.5px] text-ink-400">Kind
          <select className="mt-0.5 block h-7 w-full rounded border border-ink-600 bg-ink-800 px-1 text-[11px] text-ink-100" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any</option>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <TextInput label="Name contains" value={name} onChange={setName} />
        <TextInput label="Uses colour" mono value={colour} onChange={setColour} />
        <TextInput label="Story contains" value={text} onChange={setText} />
      </div>
      {results.length > 0 && (
        <>
          <Button className="w-full" onClick={() => {
            // Only what is on the canvas now: a master, cover or jacket match selected from the
            // spreads would be invisible, yet moved or deleted with the rest.
            const st = useStore.getState();
            const here = results.filter((r) => {
              if (r.pageIndex != null) return st.view === 'spreads' && !st.masterEdit && spreadIndexOfPage(project, r.pageIndex) === st.spread;
              const key = findElement(project, r.el.id)?.key ?? '';
              if (key === 'cover' || key === 'jacket') return st.view === key;
              return !!st.masterEdit && key.startsWith(`master:${st.masterEdit.id}:`);
            });
            st.select(here.map((r) => r.el.id));
          }}>Select the matches on this spread</Button>
          <div className="max-h-48 space-y-0.5 overflow-auto">
            {results.slice(0, 200).map((r) => (
              <button key={r.el.id} type="button" className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-ink-300 hover:bg-ink-750 hover:text-ink-100" onClick={() => go(r)}>
                <span className="w-14 shrink-0 text-[10px] text-ink-500">{r.el.type}</span>
                <span className="min-w-0 flex-1 truncate">{r.el.name || '(unnamed)'}</span>
                <span className="shrink-0 text-[10px] text-ink-500">{r.where}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <Hint>Searches pages, masters, cover and jacket; click a result to go to it.</Hint>
    </Section>
  );
}
