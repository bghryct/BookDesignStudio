import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Draft } from 'immer';
import { Upload } from 'lucide-react';
import { useStore } from '../../store/store';
import { getFamilies, getFamily, getFace, ensureFamily, useFontStore, cssFamily, fontVariationCss, fontFeatureCss } from '../../engine/fonts';
import { importFiles } from '../importFiles';
import { Section, Slider, Button, Hint, TextInput } from '../controls';
import { findElement } from '../../model/surfaces';
import { threadOf } from '../../render/compile';
import type { TextElement } from '../../model/types';

export function FontsPanel() {
  useFontStore((s) => s.version);
  const families = getFamilies();
  const [selected, setSelected] = useState(families[0]?.id ?? 'eb-garamond');
  const fam = getFamily(selected);
  const [italic, setItalic] = useState(false);
  const face = getFace((fam.faces.find((f) => f.italic === italic) ?? fam.faces[0]).key);
  const [axes, setAxes] = useState<Record<string, number>>({});
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [sample, setSample] = useState('Hamburgefonstiv 1234567890 — Quick wafting zephyrs vex bold Jim.');
  const input = useRef<HTMLInputElement>(null);
  const s = useStore.getState;

  useEffect(() => { void ensureFamily(selected); setAxes({}); setFeatures({}); }, [selected]);

  const coords = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of face?.axes ?? []) out[a.tag] = axes[a.tag] ?? a.default;
    return out;
  }, [face, axes]);

  const glyphs = useMemo(() => {
    const fk = face?.fk;
    if (!fk) return [] as string[];
    return fk.characterSet.filter((c) => c > 32 && c < 0xfb07 && !(c >= 0x7f && c < 0xa0)).slice(0, 240).map((c) => String.fromCodePoint(c));
  }, [face]);

  const applyToSelection = () => {
    const st = s();
    const ids = new Set<string>();
    for (const id of st.selection) {
      const loc = findElement(st.project, id);
      if (loc?.el.type === 'text') ids.add(threadOf(st.project, id)[0] ?? id);
    }
    if (!ids.size) { st.notify('Select a text frame first.', 'error'); return; }
    st.update((d) => {
      for (const id of ids) {
        const loc = findElement(d as never, id);
        if (!loc) continue;
        const el = loc.el as Draft<TextElement>;
        el.style.fontFamily = fam.id;
        el.style.italic = italic;
        if (coords.wght != null) el.style.weight = Math.round(coords.wght);
        el.style.axes = Object.fromEntries(Object.entries(coords).filter(([k]) => k !== 'wght' && k !== 'opsz'));
        for (const [k, v] of Object.entries(features)) el.style.features[k] = v;
      }
    });
    st.notify(`${fam.name} applied.`);
  };

  const style: React.CSSProperties = {
    fontFamily: cssFamily(fam.id),
    fontStyle: italic ? 'italic' : 'normal',
    fontVariationSettings: fontVariationCss(coords),
    fontFeatureSettings: fontFeatureCss(features),
    fontWeight: coords.wght ?? 400,
  };

  return (
    <div>
      <Section title="Library" id="fonts-lib" right={
        <button type="button" title="Upload fonts" className="rounded p-1 text-ink-400 hover:bg-ink-700" onClick={() => input.current?.click()}><Upload size={13} /></button>
      }>
        <input ref={input} type="file" multiple accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={async (e) => {
          const r = await importFiles(e.target.files ? [...e.target.files] : []);
          if (r.errors.length) s().notify(r.errors[0], 'error'); else s().notify(r.messages.join(' '));
          e.target.value = '';
        }} />
        <div className="space-y-0.5">
          {families.map((f) => (
            <button key={f.id} type="button" onClick={() => setSelected(f.id)} className={clsx('flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left', selected === f.id ? 'bg-ink-700' : 'hover:bg-ink-750')}>
              <span className="truncate text-[15px] text-ink-100" style={{ fontFamily: cssFamily(f.id) }}>{f.name}</span>
              <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-ink-500">{f.builtin ? f.category : 'uploaded'}</span>
            </button>
          ))}
        </div>
        <Button className="w-full" onClick={() => input.current?.click()}><Upload size={12} /> Upload OTF · TTF · WOFF · WOFF2</Button>
        <Hint>Variable fonts expose their fvar axes below. Uploads stay in this browser (IndexedDB) and travel inside saved project files.</Hint>
      </Section>

      <Section title={fam.name} id="fonts-detail">
        <p className="text-[10.5px] leading-snug text-ink-400"><span className="text-ink-300">{fam.classification}.</span> {fam.note}</p>
        {fam.faces.some((f) => f.italic) && fam.faces.some((f) => !f.italic) && (
          <div className="flex gap-1">
            <Button variant={!italic ? 'primary' : 'default'} className="flex-1" onClick={() => setItalic(false)}>Roman</Button>
            <Button variant={italic ? 'primary' : 'default'} className="flex-1" onClick={() => setItalic(true)}>Italic</Button>
          </div>
        )}
        <div className="rounded-md bg-paper p-3 text-[#1b1813]">
          <div className="text-[34px] leading-[1.05]" style={style}>Aa Gg Rr &amp; 1984</div>
          <div className="mt-2 text-[15px] leading-snug" style={style}>{sample}</div>
          <div className="mt-2 text-[11px] leading-snug" style={style}>The proportion of the page, the colour of the text block and the rhythm of the baseline grid.</div>
        </div>
        <TextInput label="Specimen text" value={sample} onChange={setSample} />
        {face?.status === 'loading' && <Hint>Loading…</Hint>}
        {face && face.axes.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">fvar axes</span>
            {face.axes.map((a) => (
              <Slider key={a.tag} label={`${a.name} · ${a.tag} (${a.min}–${a.max})`} value={coords[a.tag]} min={a.min} max={a.max} step={a.max - a.min > 20 ? 1 : 0.01} onChange={(v) => setAxes({ ...axes, [a.tag]: v })} />
            ))}
            {Object.keys(face.named).length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {Object.entries(face.named).slice(0, 18).map(([n, c]) => (
                  <button key={n} type="button" onClick={() => setAxes({ ...c })} className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-ink-500">{n}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {face && face.features.length > 0 && (
          <div>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-400">GSUB / GPOS features</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {face.features.map((f) => (
                <button key={f} type="button" onClick={() => setFeatures({ ...features, [f]: !features[f] })} className={clsx('rounded border px-1.5 py-0.5 font-mono text-[10px]', features[f] ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200')}>{f}</button>
              ))}
            </div>
          </div>
        )}
        {face?.metrics && face.status === 'ready' && (
          <p className="font-mono text-[10px] text-ink-500">
            UPM {face.metrics.unitsPerEm} · cap {face.metrics.capHeight.toFixed(3)} · x {face.metrics.xHeight.toFixed(3)} · asc {face.metrics.ascender.toFixed(3)} · desc {face.metrics.descender.toFixed(3)}
          </p>
        )}
        <Button variant="primary" className="w-full" onClick={applyToSelection}>Apply to selected text</Button>
      </Section>

      {glyphs.length > 0 && (
        <Section title={`Glyphs · ${face?.fk?.numGlyphs ?? 0}`} id="fonts-glyphs" defaultOpen={false}>
          <div className="grid grid-cols-8 gap-px rounded bg-ink-700 p-px">
            {glyphs.map((g, i) => (
              <button key={i} type="button" title={`U+${g.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} — click to insert into the story being edited`}
                onClick={() => { if (!s().textEditing) { s().notify('Open a story (double-click a text frame), then click a glyph to insert it.'); return; } window.dispatchEvent(new CustomEvent('bds:insert', { detail: g })); }}
                className="flex aspect-square items-center justify-center bg-paper text-[17px] text-[#1b1813] hover:bg-[#f0e2c4]" style={style}>{g}</button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
