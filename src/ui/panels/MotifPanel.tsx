import React from 'react';
import type { Draft } from 'immer';
import type { MotifElement } from '../../model/types';
import { MOTIF_LIST, getMotif, designerName, DESIGNERS } from '../../engine/motifs';
import { getFamilies } from '../../engine/fonts';
import { Section, Slider, Select, ColorField, TextInput, Button, Hint } from '../controls';
import { useStore } from '../../store/store';

/** Inspector for registry motifs: every control is derived from the motif's definition. */
export function MotifPanel({ el }: { el: MotifElement }) {
  const s = useStore.getState;
  const set = (fn: (d: Draft<MotifElement>) => void) => s().updateElement(el.id, (d) => { fn(d as Draft<MotifElement>); });
  const live = (fn: (d: Draft<MotifElement>) => void) => s().updateElement(el.id, (d) => { fn(d as Draft<MotifElement>); }, { history: false });
  const begin = () => s().checkpoint();
  const def = getMotif(el.kind);

  const kindOptions = DESIGNERS.flatMap((d) => MOTIF_LIST.filter((m) => m.designer === d.id).map((m) => ({ value: m.kind, label: m.label, group: d.name })));

  if (!def) {
    return (
      <Section title="Motif" id="el-motif">
        <Hint>Unknown motif “{el.kind}”.</Hint>
      </Section>
    );
  }

  return (
    <Section title={`${def.label} · ${designerName(def.designer)}`} id="el-motif">
      <p className="text-[10.5px] leading-snug text-ink-400">{def.description}</p>
      {kindOptions.length > 1 && (
        <Select label="Motif" value={el.kind} options={kindOptions} onChange={(kind) => {
          const next = getMotif(kind);
          if (!next) return;
          set((d) => {
            d.kind = kind;
            d.name = next.label;
            d.colors = next.colors.map((c) => c.default);
            d.params = Object.fromEntries(next.params.map((p) => [p.key, p.default]));
            if (next.text) d.text = next.text.default;
            if (next.fontFamily) d.fontFamily = next.fontFamily;
          });
        }} />
      )}
      {def.text && (
        <TextInput label={def.text.label} value={el.text} multiline={def.text.multiline} rows={3} onChange={(v) => live((d) => { d.text = v; })} />
      )}
      {(def.fontFamily || def.text) && (
        <Select label="Typeface" value={el.fontFamily || def.fontFamily || 'inter'} options={getFamilies().map((f) => ({ value: f.id, label: f.name, group: f.builtin ? f.category : 'Uploaded' }))} onChange={(v) => set((d) => { d.fontFamily = v; })} />
      )}
      {def.params.map((p) => {
        const v = el.params[p.key] ?? p.default;
        if (p.options && p.options.length) {
          return (
            <Select key={p.key} label={p.label} value={String(Math.round(v))} options={p.options.map((o, i) => ({ value: String(p.min + i), label: o }))} onChange={(nv) => set((d) => { d.params[p.key] = Number(nv); })} />
          );
        }
        return <Slider key={p.key} label={p.label} value={v} min={p.min} max={p.max} step={p.step} onStart={begin} onChange={(nv) => live((d) => { d.params[p.key] = nv; })} />;
      })}
      {def.colors.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {def.colors.map((c, i) => (
            <ColorField key={i} label={c.label} value={el.colors[i] || null} allowNone onChange={(v) => set((d) => { d.colors[i] = v ?? ''; })} />
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <Button className="flex-1" onClick={() => set((d) => { d.seed = Math.floor(Math.random() * 100000); })}>Reseed ({el.seed})</Button>
        <Button className="flex-1" onClick={() => set((d) => {
          d.colors = def.colors.map((c) => c.default);
          d.params = Object.fromEntries(def.params.map((p) => [p.key, p.default]));
        })}>Defaults</Button>
      </div>
    </Section>
  );
}
