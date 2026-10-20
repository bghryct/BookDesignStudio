import React, { useMemo, useState } from 'react';
import type { Draft } from 'immer';
import { useStore } from '../../store/store';
import type { Element, Project, TextElement } from '../../model/types';
import { findElement, spreadIndexOfPage } from '../../model/surfaces';
import { Section, Row, TextInput, Toggle, Button, Hint } from '../controls';

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

const PRESETS: { label: string; find: string; change: string; grep: boolean }[] = [
  { label: 'Double spaces → one', find: ' {2,}', change: ' ', grep: true },
  { label: 'Straight quotes → curly', find: '"([^"]*)"', change: '“$1”', grep: true },
  { label: "Apostrophes → ’", find: "(\\w)'(\\w)", change: '$1’$2', grep: true },
  { label: '-- → em dash', find: '--', change: '—', grep: false },
  { label: '... → ellipsis', find: '...', change: '…', grep: false },
  { label: 'Ranges 1-9 → en dash', find: '(\\d)-(\\d)', change: '$1–$2', grep: true },
  { label: 'Thin space before ;:!?', find: ' ([;:!?])', change: '{thin}$1', grep: true },
];

export function FindChangeSection() {
  const project = useStore((s) => s.project);
  const [find, setFind] = useState('');
  const [change, setChange] = useState('');
  const [grep, setGrep] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const [pos, setPos] = useState<{ story: number; index: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const re = useMemo(() => {
    if (!find) return null;
    try {
      let src = grep ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (whole) src = `\\b${src}\\b`;
      return new RegExp(src, caseSensitive ? 'gu' : 'giu');
    } catch { return null; }
  }, [find, grep, caseSensitive, whole]);

  const all = stories(project);
  const count = re ? all.reduce((n, s) => n + (s.el.text.match(re)?.length ?? 0), 0) : 0;

  const reveal = (story: number, index: number, len: number) => {
    const st = useStore.getState();
    const s = all[story];
    if (s.pageIndex != null) { st.setView('spreads'); st.setSpread(spreadIndexOfPage(project, s.pageIndex)); }
    st.select([s.el.id]);
    st.setTextEditing(s.el.id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea[spellcheck]');
      if (ta) { ta.focus(); ta.setSelectionRange(index, index + len); const before = ta.value.slice(0, index).split('\n').length; ta.scrollTop = Math.max(0, (before - 3) * 20); }
    }));
  };

  const next = () => {
    if (!re) return;
    const start = pos ?? { story: 0, index: -1 };
    for (let k = 0; k <= all.length; k++) {
      const si = (start.story + k) % all.length;
      const text = all[si].el.text;
      re.lastIndex = k === 0 ? start.index + 1 : 0;
      const m = re.exec(text);
      if (m && (k > 0 || m.index > start.index)) {
        setPos({ story: si, index: m.index });
        setMsg(`${all[si].where}`);
        reveal(si, m.index, m[0].length);
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
    const rep = grep ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), change) : change;
    useStore.getState().updateElement(s.el.id, { text: s.el.text.slice(0, m.index) + rep + s.el.text.slice(m.index + m[0].length) } as Partial<TextElement>);
    setPos({ story: pos.story, index: pos.index + rep.length - 1 });
    requestAnimationFrame(next);
  };

  return (
    <Section title="Find / change" id="type-find" defaultOpen={false}>
      <TextInput label="Find" mono value={find} onChange={(v) => { setFind(v); setPos(null); setMsg(null); }} />
      <TextInput label="Change to" mono value={change} onChange={setChange} />
      <div className="grid grid-cols-3 gap-1">
        <Toggle label="GREP" checked={grep} onChange={setGrep} hint="Regular expressions; $1 in the change field inserts a group" />
        <Toggle label="Case" checked={caseSensitive} onChange={setCase} />
        <Toggle label="Whole word" checked={whole} onChange={setWhole} />
      </div>
      {find && !re && <p className="text-[10.5px] text-[#e5483a]">The pattern is not a valid expression.</p>}
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
