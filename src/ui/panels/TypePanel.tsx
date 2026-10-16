import React from 'react';
import clsx from 'clsx';
import type { Draft } from 'immer';
import { TextAlignStart, TextAlignCenter, TextAlignEnd, TextAlignJustify } from 'lucide-react';
import { useStore } from '../../store/store';
import { findElement } from '../../model/surfaces';
import type { TextElement, TextStyle, DropCapFrame } from '../../model/types';
import { Section, Row, NumberField, Slider, Select, Toggle, ColorField, Segmented, Hint } from '../controls';
import { getFamilies, getFamily, getFace, resolveFont, useFontStore } from '../../engine/fonts';
import { threadOf } from '../../render/compile';
import { HYPHEN_LANGUAGES } from '../../engine/hyphenate';
import { FrameStyleSection, StylesManager } from './StylesPanel';
import type { KerningMode } from '../../model/types';

const FEATURES: { tag: string; label: string; hint: string }[] = [
  { tag: 'liga', label: 'Ligatures', hint: 'Standard ligatures fi fl ff' },
  { tag: 'dlig', label: 'Discretionary ligs', hint: 'ct st and historical ligatures' },
  { tag: 'hlig', label: 'Historical ligs', hint: 'Long s and period ligatures' },
  { tag: 'smcp', label: 'Small caps', hint: 'True small capitals (lowercase → small caps)' },
  { tag: 'c2sc', label: 'Caps → small caps', hint: 'Capitals to small capitals' },
  { tag: 'onum', label: 'Old-style figures', hint: 'Text figures with ascenders & descenders' },
  { tag: 'lnum', label: 'Lining figures', hint: 'Cap-height figures' },
  { tag: 'pnum', label: 'Proportional figures', hint: 'Figures with individual widths' },
  { tag: 'tnum', label: 'Tabular figures', hint: 'Equal-width figures for tables' },
  { tag: 'swsh', label: 'Swashes', hint: 'Swash capitals' },
  { tag: 'case', label: 'Case-sensitive forms', hint: 'Punctuation raised for capitals' },
  { tag: 'frac', label: 'Fractions', hint: '1/2 → ½' },
  { tag: 'zero', label: 'Slashed zero', hint: '' },
  { tag: 'calt', label: 'Contextual alternates', hint: '' },
  { tag: 'salt', label: 'Stylistic alternates', hint: '' },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ tag: `ss0${n}`, label: `Stylistic set ${n}`, hint: '' })),
];

const AXIS_NAMES: Record<string, string> = { wght: 'Weight', wdth: 'Width', slnt: 'Slant', ital: 'Italic', opsz: 'Optical size', SOFT: 'Softness', WONK: 'Wonky', GRAD: 'Grade', CASL: 'Casual', MONO: 'Monospace', XHGT: 'x-height' };

export function TypePanel() {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  useFontStore((s) => s.version);
  const loc = selection.length === 1 ? findElement(project, selection[0]) : null;
  if (!loc || loc.el.type !== 'text') {
    return (
      <div>
        <div className="p-4 text-[11.5px] leading-relaxed text-ink-400">Select a text frame to set its type. A threaded story shares one style, set on its first frame.</div>
        <StylesManager />
      </div>
    );
  }
  const headId = threadOf(project, loc.el.id)[0] ?? loc.el.id;
  const head = (findElement(project, headId)?.el ?? loc.el) as TextElement;
  return <TypeControls key={head.id} el={head} />;
}

function TypeControls({ el }: { el: TextElement }) {
  const s = useStore.getState;
  const st = el.style;
  const set = (fn: (d: Draft<TextStyle>) => void, history = true) => s().updateElement(el.id, (d) => { fn((d as Draft<TextElement>).style); }, { history });
  const begin = () => s().checkpoint();
  const fam = getFamily(st.fontFamily);
  const ref = resolveFont({ family: st.fontFamily, weight: st.weight, italic: st.italic, axes: st.axes, size: st.fontSize });
  const face = getFace(ref.face);
  const axes = face?.axes ?? [];
  const supported = new Set(face?.features ?? []);
  const families = getFamilies();

  const kerning: KerningMode = st.kerning ?? (st.features.kern === false ? 'none' : 'metrics');
  return (
    <div>
      <FrameStyleSection el={el} />
      <Section title="Character" id="type-char">
        <Select label="Typeface" value={st.fontFamily} options={families.map((f) => ({ value: f.id, label: f.name, group: f.builtin ? cap(f.category) : 'Uploaded' }))} onChange={(v) => set((d) => { d.fontFamily = v; d.axes = {}; })} />
        <p className="text-[10.5px] leading-snug text-ink-400"><span className="text-ink-300">{fam.classification}.</span> {fam.note}</p>
        <Row>
          <NumberField label="Size" unit="pt" value={st.fontSize} min={2} max={720} step={0.5} onScrubStart={begin} onChange={(v) => set((d) => {
            const ratio = d.leading / d.fontSize;
            d.fontSize = v;
            if (!d.baselineGrid) d.leading = +(v * ratio).toFixed(2);
          })} />
          <NumberField label="Leading" unit="pt" value={st.leading} min={1} step={0.5} onScrubStart={begin} onChange={(v) => set((d) => { d.leading = v; })} hint="Baseline to baseline. Locked to the grid, it rounds up to whole grid lines." />
          <NumberField label="Tracking" unit="‰ em" value={st.tracking} step={5} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.tracking = v; })} hint="Letter-space capitals and small caps by 5–10% (Bringhurst §3.2.2)" />
          <NumberField label="Word space" unit="%" value={st.wordSpacing} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.wordSpacing = v; })} />
        </Row>
        <div className="flex flex-wrap gap-0.5" title="The classical typographic scale (Bringhurst §3.1.1)">
          {[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 21, 24, 36, 48, 60, 72].map((pt) => (
            <button key={pt} type="button" onClick={() => set((d) => { const ratio = d.leading / d.fontSize; d.fontSize = pt; if (!d.baselineGrid) d.leading = +(pt * ratio).toFixed(2); })}
              className={clsx('h-5 min-w-[22px] rounded border px-1 text-[10px] tabular-nums', st.fontSize === pt ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200')}>{pt}</button>
          ))}
        </div>
        <Row>
          <NumberField label="Weight" value={st.weight} min={100} max={1000} step={10} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.weight = Math.round(v); })} />
          <div className="flex items-end"><Toggle label="Italic" checked={st.italic} onChange={(v) => set((d) => { d.italic = v; })} /></div>
        </Row>
        <div>
          <span className="mb-1 block text-[10.5px] text-ink-400">Kerning</span>
          <Segmented<KerningMode> value={kerning} onChange={(v) => set((d) => { d.kerning = v; delete d.features.kern; })} options={[
            { value: 'metrics', label: 'Metrics', title: 'The kerning pairs the type designer built into the font' },
            { value: 'optical', label: 'Optical', title: 'Measured from the glyph outlines: evens the white between every pair, also for fonts with poor or no kern tables' },
            { value: 'none', label: 'Off', title: 'Unkerned' },
          ]} />
          <p className="mt-1 text-[10px] leading-snug text-ink-500">Kern one pair by hand in the story editor: cursor between the letters, ⌥← tighter, ⌥→ looser (⇧ ×5).</p>
        </div>
        <ColorField label="Colour" value={st.color} onChange={(v) => v && set((d) => { d.color = v; })} />
        <Select label="Case" value={st.textTransform} options={[{ value: 'none', label: 'As typed' }, { value: 'uppercase', label: 'CAPITALS' }, { value: 'lowercase', label: 'lowercase (Crouwel)' }, { value: 'small-caps', label: 'Small caps' }]} onChange={(v) => set((d) => { d.textTransform = v; })} />
      </Section>

      {axes.length > 0 && (
        <Section title={`Variable axes · fvar (${axes.length})`} id="type-axes">
          {axes.map((a) => {
            const isW = a.tag === 'wght';
            const auto = a.tag === 'opsz' && st.axes.opsz == null;
            const v = isW ? st.weight : st.axes[a.tag] ?? (a.tag === 'opsz' ? Math.max(a.min, Math.min(a.max, st.fontSize)) : a.default);
            return (
              <div key={a.tag}>
                <Slider
                  label={`${AXIS_NAMES[a.tag] ?? a.name} · ${a.tag}${auto ? ' (auto = size)' : ''}`}
                  value={v} min={a.min} max={a.max} step={a.max - a.min > 20 ? 1 : 0.01}
                  onStart={begin}
                  onChange={(nv) => set((d) => { if (isW) d.weight = Math.round(nv); else d.axes[a.tag] = nv; }, false)}
                />
                {a.tag === 'opsz' && !auto && <button type="button" className="text-[10px] text-ink-400 underline" onClick={() => set((d) => { delete d.axes.opsz; })}>Back to automatic optical sizing</button>}
              </div>
            );
          })}
          {face && Object.keys(face.named).length > 0 && (
            <Select label="Named instance" value="" options={[{ value: '', label: 'Choose…' }, ...Object.keys(face.named).map((n) => ({ value: n, label: n }))]} onChange={(n) => {
              const coords = face.named[n];
              if (!coords) return;
              set((d) => {
                for (const [k, v] of Object.entries(coords)) { if (k === 'wght') d.weight = Math.round(v); else d.axes[k] = v; }
              });
            }} />
          )}
        </Section>
      )}

      <Section title="OpenType features" id="type-ot">
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {FEATURES.filter((f) => supported.has(f.tag) || st.features[f.tag] != null || f.tag === 'kern' || f.tag === 'liga').map((f) => {
            const on = st.features[f.tag] ?? (f.tag === 'kern' || f.tag === 'liga' || f.tag === 'calt');
            const avail = supported.has(f.tag) || f.tag === 'kern' || (f.tag === 'smcp');
            return (
              <button
                key={f.tag}
                type="button"
                title={`${f.tag}${f.hint ? ` — ${f.hint}` : ''}${!supported.has(f.tag) && f.tag === 'smcp' ? ' (synthesised: this font has no smcp)' : ''}`}
                onClick={() => set((d) => { d.features[f.tag] = !on; })}
                className={clsx('flex h-6 items-center justify-between rounded border px-1.5 text-left text-[10.5px]', on ? 'border-rubric/70 bg-rubric/15 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-200', !avail && 'opacity-50')}
              >
                <span className="truncate">{f.label}</span>
                <span className="font-mono text-[9px] text-ink-500">{f.tag}</span>
              </button>
            );
          })}
        </div>
        <Hint>Only features present in {face ? fam.name : 'the font'}'s GSUB/GPOS tables are listed; small caps are synthesised when absent.</Hint>
      </Section>

      <Section title="Paragraph" id="type-para">
        <Segmented value={st.align} onChange={(v) => set((d) => { d.align = v; })} options={[
          { value: 'left', label: <TextAlignStart size={13} />, title: 'Flush left / ragged right' },
          { value: 'center', label: <TextAlignCenter size={13} />, title: 'Centred' },
          { value: 'right', label: <TextAlignEnd size={13} />, title: 'Flush right' },
          { value: 'justify', label: <TextAlignJustify size={13} />, title: 'Justified (Knuth–Plass)' },
          { value: 'justify-all', label: 'All', title: 'Justify all lines' },
        ]} />
        <Row>
          <NumberField label="First-line indent" unit="pt" value={st.firstLineIndent} min={-200} step={0.5} onScrubStart={begin} onChange={(v) => set((d) => { d.firstLineIndent = v; })} hint="One em is the classical indent; negative hangs the first line" />
          <NumberField label="Paragraph space" unit="pt" value={st.paragraphSpacing} min={0} step={0.5} onScrubStart={begin} onChange={(v) => set((d) => { d.paragraphSpacing = v; })} />
          <NumberField label="Left indent" unit="pt" value={st.leftIndent ?? 0} min={0} step={0.5} onScrubStart={begin} onChange={(v) => set((d) => { d.leftIndent = v; })} />
          <NumberField label="Right indent" unit="pt" value={st.rightIndent ?? 0} min={0} step={0.5} onScrubStart={begin} onChange={(v) => set((d) => { d.rightIndent = v; })} />
        </Row>
        <Toggle label="Indent first paragraph" checked={st.indentFirstParagraph} onChange={(v) => set((d) => { d.indentFirstParagraph = v; })} hint="Classical practice sets the first paragraph after a heading flush" />
        <Toggle label="Optical margin alignment" checked={st.opticalMargin} onChange={(v) => set((d) => { d.opticalMargin = v; })} hint="Hang punctuation and nudge A, T, V, W, Y into the margin so edges look straight" />
        <Toggle label="Lock to baseline grid" checked={st.baselineGrid} onChange={(v) => set((d) => { d.baselineGrid = v; })} hint="Every line on the document grid so recto and verso back up" />
        <Toggle label="Avoid one-word last lines" checked={st.avoidRunts} onChange={(v) => set((d) => { d.avoidRunts = v; })} />
        <Toggle label="First line in small caps" checked={st.firstLineSmallCaps} onChange={(v) => set((d) => { d.firstLineSmallCaps = v; })} />
      </Section>

      <Section title="Justification & hyphenation" id="type-hj" defaultOpen={false}>
        <span className="block text-[10.5px] text-ink-400">Word spaces in justified lines, % of the desired space</span>
        <Row>
          <NumberField label="Minimum" unit="%" value={st.wordSpaceMin ?? 67} min={30} max={100} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.wordSpaceMin = v; })} />
          <NumberField label="Maximum" unit="%" value={st.wordSpaceMax ?? 150} min={100} max={400} step={1} decimals={0} onScrubStart={begin} onChange={(v) => set((d) => { d.wordSpaceMax = v; })} hint="Narrow ranges give even colour; the breaker re-tries wider only when nothing fits" />
        </Row>
        <Toggle label="Hyphenate" checked={st.hyphenate} onChange={(v) => set((d) => { d.hyphenate = v; })} hint="Liang patterns for the chosen language" />
        {st.hyphenate && (
          <>
            <Select label="Language" value={st.language} options={HYPHEN_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => set((d) => { d.language = v; })} />
            <Row>
              <NumberField label="Words longer than" value={st.hyphenMinWord ?? 5} min={3} max={15} decimals={0} onChange={(v) => set((d) => { d.hyphenMinWord = Math.round(v); })} />
              <NumberField label="Consecutive hyphens" value={st.hyphenLimit ?? 0} min={0} max={9} decimals={0} onChange={(v) => set((d) => { d.hyphenLimit = Math.round(v); })} hint="0 = no limit. Bringhurst: no more than two in a row" />
              <NumberField label="Letters before break" value={st.hyphenBefore ?? 2} min={1} max={6} decimals={0} onChange={(v) => set((d) => { d.hyphenBefore = Math.round(v); })} />
              <NumberField label="Letters after break" value={st.hyphenAfter ?? 3} min={1} max={6} decimals={0} onChange={(v) => set((d) => { d.hyphenAfter = Math.round(v); })} />
            </Row>
            <Toggle label="Hyphenate capitalised words" checked={st.hyphenateCaps !== false} onChange={(v) => set((d) => { d.hyphenateCaps = v; })} hint="Off keeps names and sentence openings whole" />
          </>
        )}
      </Section>

      <Section title="Initial / drop cap" id="type-dropcap">
        <Toggle label="Drop cap" checked={st.dropCap.enabled} onChange={(v) => set((d) => { d.dropCap.enabled = v; })} />
        {st.dropCap.enabled && (
          <>
            <Row>
              <NumberField label="Lines" value={st.dropCap.lines} min={2} max={12} decimals={0} onChange={(v) => set((d) => { d.dropCap.lines = Math.round(v); })} />
              <NumberField label="Gap" unit="pt" value={st.dropCap.gap} min={0} step={0.5} onChange={(v) => set((d) => { d.dropCap.gap = v; })} />
            </Row>
            <Select label="Initial typeface" value={st.dropCap.fontFamily ?? ''} options={[{ value: '', label: 'Same as text' }, ...getFamilies().filter((f) => !f.system).map((f) => ({ value: f.id, label: f.name }))]} onChange={(v) => set((d) => { d.dropCap.fontFamily = v || null; })} />
            <NumberField label="Initial weight" value={st.dropCap.weight} min={100} max={900} step={50} decimals={0} onChange={(v) => set((d) => { d.dropCap.weight = v; })} />
            <Select<DropCapFrame> label="Illumination (Cleves)" value={st.dropCap.frame} options={[{ value: 'none', label: 'None — rubricated letter' }, { value: 'gilded', label: 'Burnished gold square' }, { value: 'vine', label: 'Vine tracery on colour' }, { value: 'rubric', label: 'Penwork flourishes' }, { value: 'box', label: 'Coloured box' }, { value: 'outline', label: 'Double rule' }]} onChange={(v) => set((d) => { d.dropCap.frame = v; })} />
            <Row>
              <ColorField label="Letter" value={st.dropCap.color} onChange={(v) => v && set((d) => { d.dropCap.color = v; })} />
              <ColorField label="Frame" value={st.dropCap.frameColor} onChange={(v) => v && set((d) => { d.dropCap.frameColor = v; })} />
            </Row>
            <Hint>The initial is sized so its cap height spans exactly from the cap line of line 1 to the baseline of line {st.dropCap.lines}.</Hint>
          </>
        )}
      </Section>

      <StylesManager />

      <Section title="Direction & writing mode" id="type-dir" defaultOpen={false}>
        <Segmented value={st.writingMode} onChange={(v) => set((d) => {
          d.writingMode = v;
          if (v === 'vertical' && !getFamily(d.fontFamily).system) d.fontFamily = 'mincho';
        })} options={[{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical 縦書き' }]} />
        {st.writingMode === 'vertical' ? (
          <>
            <Toggle label="Tate-chū-yoko (縦中横)" checked={st.tateChuYoko} onChange={(v) => set((d) => { d.tateChuYoko = v; })} hint="Set runs of up to three digits upright and horizontal within one em" />
            <Hint>Columns run top-to-bottom, right-to-left, with kinsoku line-breaking rules, hanging 、。 (burasage) and vertical punctuation forms.</Hint>
          </>
        ) : (
          <Segmented value={st.direction} onChange={(v) => set((d) => { d.direction = v; })} options={[{ value: 'ltr', label: 'Left → right' }, { value: 'rtl', label: 'Right → left' }]} />
        )}
      </Section>
    </div>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
