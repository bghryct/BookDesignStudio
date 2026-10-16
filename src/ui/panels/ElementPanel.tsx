import React, { useRef } from 'react';
import type { Draft } from 'immer';
import {
  FlipHorizontal2, FlipVertical2, ArrowUpToLine, ArrowDownToLine, Copy, Trash, Link, Unlink, Upload, Lock, LockOpen,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, Plus, X,
} from 'lucide-react';
import { useStore } from '../../store/store';
import { findElement, surfaceElementsDraft } from '../../model/surfaces';
import type {
  BlendMode, Element, Finish, TextElement, ImageElement, ShapeElement, RuleElement, PathElement, SvgElement, PatternElement,
  OrnamentElement, InitialElement, OverprintElement, GradientElement, CutoutElement, DrawingElement, GridTypeElement, Project,
  PatternKind, OrnamentKind, OverprintKind, RuleKind, ShapeKind, DropCapFrame,
} from '../../model/types';
import { Section, Row, NumberField, Slider, Select, Toggle, ColorField, TextInput, Button, IconButton, Hint, Segmented } from '../controls';
import { PATTERN_PARAMS, OVERPRINT_PARAMS, ORNAMENT_PARAMS } from '../../engine/generators';
import { getFamilies } from '../../engine/fonts';
import { threadOf, layoutText, contextForElement, crossesGutter } from '../../render/compile';
import { importFiles } from '../importFiles';
import { parseSvgCached, svgMarkupFromDataUrl, svgPrims } from '../../render/svgImport';
import { makePath } from '../../model/factory';
import { MotifPanel } from './MotifPanel';
import { spacingReport } from '../canvas/SpacingOverlay';
import { getMotif } from '../../engine/motifs';
import type { MotifElement } from '../../model/types';
import { parsePath, pathBounds, serialize, transformSegs } from '../../lib/pathData';
import { computeGrid, textBlock } from '../../engine/grid';
import { pageSide, facingOf } from '../../model/surfaces';

const BLENDS: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
const FINISHES: { value: Finish; label: string }[] = [
  { value: 'none', label: 'Print (CMYK)' }, { value: 'gold-foil', label: 'Gold foil' }, { value: 'silver-foil', label: 'Silver foil' },
  { value: 'copper-foil', label: 'Copper foil' }, { value: 'holo-foil', label: 'Holographic foil' }, { value: 'blind-deboss', label: 'Blind deboss' }, { value: 'spot-gloss', label: 'Spot gloss UV' },
];
const DASHES: { label: string; value: number[] }[] = [
  { label: 'Solid', value: [] }, { label: 'Dotted', value: [0.01, 3] }, { label: 'Dash 4·2', value: [4, 2] }, { label: 'Dash 8·4', value: [8, 4] },
  { label: 'Dash-dot', value: [8, 3, 1, 3] }, { label: 'Morse', value: [1, 2, 6, 2] }, { label: 'Long 16·4', value: [16, 4] }, { label: 'Stitch 3·3', value: [3, 3] },
];

export function useEdit(id: string) {
  const s = useStore.getState;
  return {
    set: (p: Partial<Element> | ((d: Draft<Element>) => void)) => s().updateElement(id, p),
    live: (p: Partial<Element> | ((d: Draft<Element>) => void)) => s().updateElement(id, p, { history: false }),
    begin: () => s().checkpoint(),
  };
}

export function ElementPanel() {
  const selection = useStore((s) => s.selection);
  const project = useStore((s) => s.project);
  const els = selection.map((id) => findElement(project, id)).filter(Boolean);
  if (!els.length) return <NothingSelected />;
  if (els.length > 1) return <MultiPanel ids={selection} />;
  const loc = els[0]!;
  return <SinglePanel key={loc.el.id} el={loc.el} surfaceKey={loc.key} project={project} />;
}

function NothingSelected() {
  return (
    <div className="space-y-3 p-4 text-[11.5px] leading-relaxed text-ink-400">
      <p>Select an item on the canvas, or pick a tool on the left to draw one.</p>
      <p><span className="text-ink-200">Text</span> — click inside a column to frame it; double-click a frame to edit its story. Overflowing frames show a red <span className="text-[#e5483a]">+</span>; click it, then another frame, to thread the story onward.</p>
      <p><span className="text-ink-200">Brushes</span> paint into a drawing layer that stays editable and re-renders at print resolution.</p>
      <p><span className="text-ink-200">Generators</span> — Schrofer patterns, Cleves marginalia, Martens overprints, Sato gradients, Crouwel grid type and Munari die-cuts are live vector objects with their own controls.</p>
    </div>
  );
}

function MultiPanel({ ids }: { ids: string[] }) {
  const s = useStore.getState;
  const align = (mode: 'l' | 'c' | 'r' | 't' | 'm' | 'b') => {
    const p = s().project;
    const items = ids.map((id) => findElement(p, id)!).filter(Boolean);
    const minX = Math.min(...items.map((i) => i.el.x)), maxX = Math.max(...items.map((i) => i.el.x + i.el.w));
    const minY = Math.min(...items.map((i) => i.el.y)), maxY = Math.max(...items.map((i) => i.el.y + i.el.h));
    s().update((d) => {
      for (const it of items) {
        const el = surfaceElementsDraft(d as Project, it.key)![it.index];
        if (mode === 'l') el.x = minX; if (mode === 'r') el.x = maxX - el.w; if (mode === 'c') el.x = (minX + maxX) / 2 - el.w / 2;
        if (mode === 't') el.y = minY; if (mode === 'b') el.y = maxY - el.h; if (mode === 'm') el.y = (minY + maxY) / 2 - el.h / 2;
      }
    });
  };
  return (
    <div>
      <Section title={`${ids.length} items`}>
        <AlignButtons onAlign={align} />
        <Row>
          <Button onClick={() => s().duplicateSelection()}><Copy size={12} /> Duplicate</Button>
          <Button variant="danger" onClick={() => s().deleteSelection()}><Trash size={12} /> Delete</Button>
        </Row>
      </Section>
    </div>
  );
}

function AlignButtons({ onAlign }: { onAlign: (m: 'l' | 'c' | 'r' | 't' | 'm' | 'b') => void }) {
  return (
    <div className="flex justify-between">
      <IconButton title="Align left" onClick={() => onAlign('l')}><AlignStartVertical size={14} /></IconButton>
      <IconButton title="Align centre" onClick={() => onAlign('c')}><AlignCenterVertical size={14} /></IconButton>
      <IconButton title="Align right" onClick={() => onAlign('r')}><AlignEndVertical size={14} /></IconButton>
      <IconButton title="Align top" onClick={() => onAlign('t')}><AlignStartHorizontal size={14} /></IconButton>
      <IconButton title="Align middle" onClick={() => onAlign('m')}><AlignCenterHorizontal size={14} /></IconButton>
      <IconButton title="Align bottom" onClick={() => onAlign('b')}><AlignEndHorizontal size={14} /></IconButton>
    </div>
  );
}

/** Fit an item to its page or across the spread, and choose how a gutter-crossing item stacks. */
function SpreadTools({ el, project, set }: { el: Element; project: Project; set: (p: Partial<Element>) => void }) {
  const loc = findElement(project, el.id);
  const spec = project.book;
  const master = loc?.key.startsWith('master:');
  if (!loc || (loc.pageIndex == null && !master)) return null;
  const side = loc.pageIndex != null ? pageSide(project, loc.pageIndex) : loc.key.endsWith(':left') ? 'left' : 'right';
  const hasFacing = spec.facing && (master || (loc.pageIndex != null && !!facingOf(project, loc.pageIndex)));
  const W = spec.trimW, H = spec.trimH, b = spec.bleed;
  const x0 = side === 'left' ? 0 : -W; // the spread's left edge in this page's coordinates
  const crosses = spec.facing && crossesGutter(el, side, W);
  return (
    <div>
      <span className="mb-1 block text-[10.5px] text-ink-400">Page & spread</span>
      <div className="grid grid-cols-3 gap-1">
        <Button title="Cover the page to the bleed (not into the gutter)" onClick={() => set({ x: !spec.facing || side === 'left' ? -b : 0, y: -b, w: W + (spec.facing ? b : 2 * b), h: H + 2 * b, rotation: 0 })}>Fill page</Button>
        <Button disabled={!hasFacing} title="Run across both pages, bleed to bleed" onClick={() => set({ x: x0 - b, y: -b, w: 2 * W + 2 * b, h: H + 2 * b, rotation: 0 })}>Fill spread</Button>
        <Button disabled={!hasFacing} title="From the left page's outer margin to the right page's" onClick={() => {
          const L = textBlock(spec, 'left'), R = textBlock(spec, 'right');
          set({ x: x0 + L.x, w: W + R.x + R.w - L.x, rotation: 0 });
        }}>Span text</Button>
      </div>
      {crosses && (
        <div className="mt-2">
          <span className="mb-1 block text-[10.5px] text-ink-400">Spread item · on the facing page it sits</span>
          <Segmented value={el.spreadAbove ? 'above' : 'below'} onChange={(v) => set({ spreadAbove: v === 'above' })} options={[{ value: 'below', label: 'Beneath its items' }, { value: 'above', label: 'Above its items' }]} />
        </div>
      )}
    </div>
  );
}

function SinglePanel({ el, surfaceKey, project }: { el: Element; surfaceKey: string; project: Project }) {
  const { set, live, begin } = useEdit(el.id);
  const s = useStore.getState;
  const onCover = surfaceKey === 'cover' || surfaceKey === 'jacket';

  const alignToPage = (mode: 'l' | 'c' | 'r' | 't' | 'm' | 'b') => {
    const loc = findElement(project, el.id);
    if (!loc) return;
    const side = loc.pageIndex != null ? pageSide(project, loc.pageIndex) : loc.key.endsWith(':left') ? 'left' : 'right';
    const g = computeGrid(project.book, side);
    const box = onCover ? { x: 0, y: 0, w: el.w, h: project.book.trimH } : g.block;
    set((d) => {
      if (mode === 'l') d.x = box.x; if (mode === 'r') d.x = box.x + box.w - d.w; if (mode === 'c') d.x = box.x + box.w / 2 - d.w / 2;
      if (mode === 't') d.y = box.y; if (mode === 'b') d.y = box.y + box.h - d.h; if (mode === 'm') d.y = box.y + box.h / 2 - d.h / 2;
    });
  };

  return (
    <div>
      <Section title={el.type === 'motif' ? getMotif(el.kind)?.label ?? 'Motif' : TITLES[el.type]} id="el-geometry" right={
        <div className="flex">
          <IconButton title={el.locked ? 'Unlock' : 'Lock'} onClick={() => set({ locked: !el.locked })}>{el.locked ? <Lock size={13} /> : <LockOpen size={13} />}</IconButton>
          <IconButton title="Duplicate (⌘D)" onClick={() => s().duplicateSelection()}><Copy size={13} /></IconButton>
          <IconButton title="Delete" onClick={() => s().deleteSelection()}><Trash size={13} /></IconButton>
        </div>
      }>
        <TextInput label="Name" value={el.name} onChange={(v) => live({ name: v })} />
        <Row>
          <NumberField label="X" length value={el.x} onChange={(v) => set({ x: v })} onScrubStart={begin} />
          <NumberField label="Y" length value={el.y} onChange={(v) => set({ y: v })} onScrubStart={begin} />
          <NumberField label="W" length value={el.w} min={0.5} onChange={(v) => set({ w: v })} onScrubStart={begin} />
          <NumberField label="H" length value={el.h} min={0.5} onChange={(v) => set({ h: v })} onScrubStart={begin} />
        </Row>
        <Row>
          <NumberField label="Rotation" unit="°" value={el.rotation} decimals={1} onChange={(v) => set({ rotation: v })} onScrubStart={begin} />
          <div className="flex items-end gap-1">
            <IconButton title="Flip horizontal" active={!!el.flipX} onClick={() => set({ flipX: !el.flipX })}><FlipHorizontal2 size={14} /></IconButton>
            <IconButton title="Flip vertical" active={!!el.flipY} onClick={() => set({ flipY: !el.flipY })}><FlipVertical2 size={14} /></IconButton>
            <IconButton title="Bring to front (⇧⌘])" onClick={() => s().arrange('front')}><ArrowUpToLine size={14} /></IconButton>
            <IconButton title="Send to back (⇧⌘[)" onClick={() => s().arrange('back')}><ArrowDownToLine size={14} /></IconButton>
          </div>
        </Row>
        <div>
          <span className="mb-1 block text-[10.5px] text-ink-400">Align to {onCover ? 'cover' : 'text block'}</span>
          <AlignButtons onAlign={alignToPage} />
        </div>
        {!onCover && <SpreadTools el={el} project={project} set={set} />}
      </Section>
      <Section title="Appearance" id="el-appearance">
        <Slider label="Opacity" value={el.opacity} min={0} max={1} onStart={begin} onChange={(v) => live({ opacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
        <Select<BlendMode> label="Blend mode (overprint)" value={el.blend} options={BLENDS.map((b) => ({ value: b, label: b[0].toUpperCase() + b.slice(1) }))} onChange={(v) => set({ blend: v })} hint="Multiply / Screen / Difference simulate overprinting inks (Karel Martens)" />
        <Select<Finish> label="Finish" value={el.finish ?? 'none'} options={FINISHES} onChange={(v) => set({ finish: v })} hint="Foils and debossing render in 3D and are separated as named spots in the PDF" />
      </Section>
      <TypeSpecific el={el} project={project} />
    </div>
  );
}

const TITLES: Record<Element['type'], string> = {
  text: 'Text frame', image: 'Image frame', shape: 'Shape', rule: 'Rule', path: 'Path', svg: 'SVG graphic', pattern: 'Kinetic pattern · Schrofer',
  ornament: 'Marginalia · Cleves', initial: 'Illuminated initial', overprint: 'Overprint · Martens', gradient: 'Tonal gradient · Sato',
  cutout: 'Die-cut · Munari', drawing: 'Drawing', gridtype: 'Grid alphabet · Crouwel', motif: 'Motif',
};

function familyOptions() {
  return getFamilies().map((f) => ({ value: f.id, label: f.name, group: f.builtin ? f.category : 'Uploaded' }));
}

function StrokeControls<T extends ShapeElement | PathElement>({ el, set, live, begin }: { el: T; set: (p: Partial<Element>) => void; live: (p: Partial<Element>) => void; begin: () => void }) {
  return (
    <>
      <Row>
        <ColorField label="Fill" value={el.fill} allowNone onChange={(v) => set({ fill: v } as Partial<Element>)} />
        <ColorField label="Stroke" value={el.stroke} allowNone onChange={(v) => set({ stroke: v } as Partial<Element>)} />
      </Row>
      <Row>
        <NumberField label="Stroke weight" unit="pt" value={el.strokeWidth} min={0} step={0.25} onChange={(v) => set({ strokeWidth: v } as Partial<Element>)} onScrubStart={begin} />
        <Select label="Dash matrix" value={JSON.stringify(el.dash)} options={DASHES.map((d) => ({ value: JSON.stringify(d.value), label: d.label }))} onChange={(v) => set({ dash: JSON.parse(v) } as Partial<Element>)} />
      </Row>
      <Row>
        <Select label="Cap" value={el.cap} options={[{ value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }]} onChange={(v) => set({ cap: v } as Partial<Element>)} />
        <Select label="Join" value={el.join} options={[{ value: 'miter', label: 'Miter' }, { value: 'round', label: 'Round' }, { value: 'bevel', label: 'Bevel' }]} onChange={(v) => set({ join: v } as Partial<Element>)} />
      </Row>
      <TextInput label="Custom dash (pt, space separated)" value={el.dash.join(' ')} onChange={(v) => live({ dash: v.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0) } as Partial<Element>)} />
    </>
  );
}

function ParamSliders({ defs, params, onStart, onChange }: { defs: { key: string; label: string; min: number; max: number; step: number; default: number }[]; params: Record<string, number>; onStart: () => void; onChange: (key: string, v: number) => void }) {
  return (
    <>
      {defs.map((d) => (
        <Slider key={d.key} label={d.label} value={params[d.key] ?? d.default} min={d.min} max={d.max} step={d.step} onStart={onStart} onChange={(v) => onChange(d.key, v)} />
      ))}
    </>
  );
}

function TypeSpecific({ el, project }: { el: Element; project: Project }) {
  const { set, live, begin } = useEdit(el.id);
  const s = useStore.getState;
  const fileRef = useRef<HTMLInputElement>(null);
  const reseed = () => set({ seed: Math.floor(Math.random() * 100000) } as Partial<Element>);

  switch (el.type) {
    case 'text': {
      const e = el as TextElement;
      const chain = threadOf(project, e.id);
      const ctx = contextForElement(project, e.id, s().spread);
      const layout = ctx ? layoutText(e, ctx) : null;
      return (
        <Section title="Frame" id="el-text">
          <Button className="w-full" onClick={() => s().setTextEditing(e.id)}>Edit story…</Button>
          <Row>
            <NumberField label="Columns" value={e.columns} min={1} max={12} decimals={0} onChange={(v) => set({ columns: Math.round(v) } as Partial<Element>)} />
            <NumberField label="Gutter" length value={e.columnGap} min={0} onChange={(v) => set({ columnGap: v } as Partial<Element>)} />
            <NumberField label="Inset" length value={e.inset} min={0} onChange={(v) => set({ inset: v } as Partial<Element>)} />
            <Select label="Vertical align" value={e.verticalAlign} options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} onChange={(v) => set({ verticalAlign: v } as Partial<Element>)} />
          </Row>
          <ColorField label="Frame fill" value={e.fill} allowNone onChange={(v) => set({ fill: v } as Partial<Element>)} />
          {layout && e.style.writingMode !== 'vertical' && (() => {
            const rep = spacingReport(layout.lines);
            const measureOk = rep.avgChars >= 45 && rep.avgChars <= 75;
            return (
              <div className="space-y-1 rounded-md border border-ink-700 bg-ink-900 p-2 text-[11px] text-ink-300">
                <div className="flex justify-between">
                  <span title="Bringhurst §2.1.2: 45–75 characters, 66 ideal for a single column">Measure</span>
                  <span className={measureOk ? 'text-[#7fcf9a]' : 'text-[#f0b46e]'}>≈ {Math.round(rep.avgChars)} characters / line</span>
                </div>
                <div className="flex justify-between" title="Hochuli: lines whose word spaces stretched or shrank beyond comfort">
                  <span>Spacing</span>
                  <span>{rep.loose} loose · {rep.tight} tight · {rep.hyphens} hyphens{rep.ladder >= 3 ? ` · ladder of ${rep.ladder}` : ''}</span>
                </div>
                <button type="button" className="text-[10.5px] text-ink-400 underline hover:text-ink-200" onClick={() => s().update((d) => { d.book.grid.showSpacing = !d.book.grid.showSpacing; })}>
                  {project.book.grid.showSpacing ? 'Hide' : 'Show'} spacing check on the canvas
                </button>
              </div>
            );
          })()}
          <div className="rounded-md border border-ink-700 bg-ink-900 p-2 text-[11px] text-ink-300">
            <div className="flex items-center justify-between">
              <span>Thread: frame {chain.indexOf(e.id) + 1} of {chain.length}</span>
              {layout?.overflow && <span className="font-medium text-[#e5483a]">Overset text</span>}
            </div>
            <div className="mt-1.5 flex gap-1">
              <Button className="flex-1" onClick={() => { s().setLinking(e.id); s().notify('Click the frame the story should continue in.'); }}><Link size={12} /> Thread to…</Button>
              {e.flowNext && <Button onClick={() => set({ flowNext: null } as Partial<Element>)}><Unlink size={12} /> Unthread</Button>}
            </div>
          </div>
          <Hint>Typography for the whole story lives in the Type tab.</Hint>
        </Section>
      );
    }
    case 'image': {
      const e = el as ImageElement;
      return (
        <Section title="Image" id="el-image">
          <Button className="w-full" onClick={() => fileRef.current?.click()}><Upload size={12} /> {e.assetId ? 'Replace image…' : 'Choose image…'}</Button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (ev) => {
            const r = await importFiles(ev.target.files ? [...ev.target.files] : [], { replaceImageId: e.id });
            if (r.errors.length) s().notify(r.errors[0], 'error');
            ev.target.value = '';
          }} />
          <Segmented value={e.fit} options={[{ value: 'cover', label: 'Fill frame' }, { value: 'contain', label: 'Fit' }, { value: 'fill', label: 'Stretch' }]} onChange={(v) => set({ fit: v } as Partial<Element>)} />
          <Slider label="Zoom" value={e.zoom} min={0.2} max={4} onStart={begin} onChange={(v) => live({ zoom: v } as Partial<Element>)} />
          <Slider label="Offset X" value={e.offsetX} min={-1} max={1} onStart={begin} onChange={(v) => live({ offsetX: v } as Partial<Element>)} />
          <Slider label="Offset Y" value={e.offsetY} min={-1} max={1} onStart={begin} onChange={(v) => live({ offsetY: v } as Partial<Element>)} />
          <Toggle label="Greyscale" checked={e.grayscale} onChange={(v) => set({ grayscale: v } as Partial<Element>)} />
          <Toggle label="Duotone" checked={!!e.duotone} onChange={(v) => set({ duotone: v ? ['#1b2a4a', '#f2c94c'] : null } as Partial<Element>)} />
          {e.duotone && (
            <Row>
              <ColorField label="Shadows" value={e.duotone[0]} onChange={(v) => v && set({ duotone: [v, e.duotone![1]] } as Partial<Element>)} />
              <ColorField label="Highlights" value={e.duotone[1]} onChange={(v) => v && set({ duotone: [e.duotone![0], v] } as Partial<Element>)} />
            </Row>
          )}
        </Section>
      );
    }
    case 'shape': {
      const e = el as ShapeElement;
      return (
        <Section title="Shape" id="el-shape">
          <Select<ShapeKind> label="Kind" value={e.shape} options={[{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }, { value: 'polygon', label: 'Polygon' }, { value: 'star', label: 'Star' }, { value: 'triangle', label: 'Triangle' }, { value: 'arc', label: 'Arc' }]} onChange={(v) => set({ shape: v } as Partial<Element>)} />
          {e.shape === 'rect' && <NumberField label="Corner radius" length value={e.radius} min={0} onChange={(v) => set({ radius: v } as Partial<Element>)} />}
          {(e.shape === 'polygon' || e.shape === 'star') && <NumberField label="Sides / points" value={e.sides} min={3} max={64} decimals={0} onChange={(v) => set({ sides: Math.round(v) } as Partial<Element>)} />}
          {(e.shape === 'star' || e.shape === 'arc') && <Slider label={e.shape === 'arc' ? 'Sweep' : 'Inner radius'} value={e.innerRatio} min={0.05} max={1} onStart={begin} onChange={(v) => live({ innerRatio: v } as Partial<Element>)} />}
          <StrokeControls el={e} set={set} live={live} begin={begin} />
        </Section>
      );
    }
    case 'rule': {
      const e = el as RuleElement;
      return (
        <Section title="Rule" id="el-rule">
          <Select<RuleKind> label="Kind" value={e.kind} options={[
            { value: 'single', label: 'Single' }, { value: 'double', label: 'Double' }, { value: 'scotch', label: 'Scotch (thick–thin)' }, { value: 'dotted', label: 'Dotted' },
            { value: 'wave', label: 'Wave' }, { value: 'zigzag', label: 'Zigzag' }, { value: 'greek-key', label: 'Greek key (meander)' }, { value: 'chain', label: 'Chain' },
          ]} onChange={(v) => set({ kind: v } as Partial<Element>)} />
          <Row>
            <ColorField label="Colour" value={e.stroke} onChange={(v) => v && set({ stroke: v } as Partial<Element>)} />
            <NumberField label="Weight" unit="pt" value={e.strokeWidth} min={0.1} step={0.25} onChange={(v) => set({ strokeWidth: v } as Partial<Element>)} onScrubStart={begin} />
          </Row>
          <Row>
            <Select label="Dash matrix" value={JSON.stringify(e.dash)} options={DASHES.map((d) => ({ value: JSON.stringify(d.value), label: d.label }))} onChange={(v) => set({ dash: JSON.parse(v) } as Partial<Element>)} />
            <Select label="Cap" value={e.cap} options={[{ value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }]} onChange={(v) => set({ cap: v } as Partial<Element>)} />
          </Row>
        </Section>
      );
    }
    case 'path': {
      const e = el as PathElement;
      return (
        <Section title="Path" id="el-path">
          <Hint>Use the Direct selection tool (A) to drag anchors and Bézier handles.</Hint>
          <StrokeControls el={e} set={set} live={live} begin={begin} />
          <Select label="Fill rule" value={e.fillRule} options={[{ value: 'nonzero', label: 'Non-zero' }, { value: 'evenodd', label: 'Even-odd' }]} onChange={(v) => set({ fillRule: v } as Partial<Element>)} />
          <TextInput label="Path data" mono multiline rows={3} value={e.d} onChange={(v) => live({ d: v } as Partial<Element>)} />
          <Button className="w-full" onClick={() => {
            // Re-fit the box to the path's geometry.
            const segs = parsePath(e.d);
            const b = pathBounds(segs);
            if (b.w <= 0 || b.h <= 0) return;
            const kx = e.w / e.vw, ky = e.h / e.vh;
            const moved = transformSegs(segs, [1, 0, 0, 1, -b.x, -b.y]);
            set({ d: serialize(moved), vw: b.w, vh: b.h, w: b.w * kx, h: b.h * ky, x: e.x + b.x * kx, y: e.y + b.y * ky } as Partial<Element>);
          }}>Fit frame to path</Button>
        </Section>
      );
    }
    case 'svg': {
      const e = el as SvgElement;
      const asset = e.assetId ? project.assets[e.assetId] : null;
      return (
        <Section title="SVG" id="el-svg">
          <Row>
            <ColorField label="Fill override" value={e.fillOverride} allowNone onChange={(v) => set({ fillOverride: v } as Partial<Element>)} />
            <ColorField label="Stroke override" value={e.strokeOverride} allowNone onChange={(v) => set({ strokeOverride: v } as Partial<Element>)} />
          </Row>
          <Button className="w-full" disabled={!asset} onClick={() => {
            if (!asset) return;
            const parsed = parseSvgCached(asset.id, svgMarkupFromDataUrl(asset.src));
            if (!parsed) return;
            const prims = svgPrims(parsed, e.w, e.h, e.fillOverride, e.strokeOverride);
            const loc = findElement(s().project, e.id);
            if (!loc) return;
            const paths = prims.filter((p) => p.t === 'path').map((p) => {
              if (p.t !== 'path') throw new Error();
              const segs = parsePath(p.d);
              const b = pathBounds(segs);
              const d = serialize(transformSegs(segs, [1, 0, 0, 1, -b.x, -b.y]));
              return makePath({ name: 'Path', x: e.x + b.x, y: e.y + b.y, w: Math.max(0.5, b.w), h: Math.max(0.5, b.h), vw: Math.max(0.5, b.w), vh: Math.max(0.5, b.h), d,
                fill: typeof p.fill === 'string' ? p.fill : null, stroke: typeof p.stroke === 'string' ? p.stroke : null, strokeWidth: p.strokeWidth ?? 1, fillRule: p.fillRule ?? 'nonzero', rotation: 0 });
            });
            s().update((d) => {
              const arr = surfaceElementsDraft(d as Project, loc.key)!;
              arr.splice(loc.index, 1, ...(paths as Draft<Element>[]));
            });
            s().select(paths.map((p) => p.id));
            s().notify(`Exploded into ${paths.length} editable paths.`);
          }}>Explode into editable paths</Button>
        </Section>
      );
    }
    case 'pattern': {
      const e = el as PatternElement;
      return (
        <Section title="Restless typography" id="el-pattern">
          <Select<PatternKind> label="System" value={e.kind} options={[
            { value: 'text-rings', label: 'Concentric text rings' }, { value: 'wave-letters', label: 'Wave field of letters' }, { value: 'moire-lines', label: 'Moiré lines' },
            { value: 'rotating-squares', label: 'Rotating squares' }, { value: 'radial-bars', label: 'Radial bars' }, { value: 'dot-screen', label: 'Dot screen' },
            { value: 'text-spiral', label: 'Text spiral' }, { value: 'letter-grid-scale', label: 'Letter grid · scale' },
          ]} onChange={(v) => set({ kind: v, params: {} } as Partial<Element>)} />
          <TextInput label="Text" value={e.text} onChange={(v) => live({ text: v } as Partial<Element>)} />
          <Select label="Typeface" value={e.fontFamily} options={familyOptions()} onChange={(v) => set({ fontFamily: v } as Partial<Element>)} />
          <Row>
            <ColorField label="Colour" value={e.color} onChange={(v) => v && set({ color: v } as Partial<Element>)} />
            <ColorField label="Second colour" value={e.color2} onChange={(v) => v && set({ color2: v } as Partial<Element>)} />
          </Row>
          <ParamSliders defs={PATTERN_PARAMS[e.kind] ?? []} params={e.params} onStart={begin} onChange={(k, v) => live((d) => { (d as Draft<PatternElement>).params[k] = v; })} />
          <Button className="w-full" onClick={reseed}>Reseed ({e.seed})</Button>
        </Section>
      );
    }
    case 'ornament': {
      const e = el as OrnamentElement;
      return (
        <Section title="Illumination" id="el-ornament">
          <Select<OrnamentKind> label="Border" value={e.kind} options={[
            { value: 'vine-border', label: 'Vine rinceaux & hairline sprays' }, { value: 'acanthus', label: 'Acanthus' }, { value: 'strewn-flowers', label: 'Strewn flowers' },
            { value: 'pearls-and-beads', label: 'Pearls & beads' }, { value: 'shells-and-coins', label: 'Mussel shells & coins (trompe-l’œil)' }, { value: 'rubric-frame', label: 'Rubric penwork frame' },
            { value: 'ruling', label: 'Ruling & prickings' }, { value: 'trompe-loeil-frame', label: 'Gilded trompe-l’œil frame' },
          ]} onChange={(v) => set({ kind: v } as Partial<Element>)} />
          <NumberField label="Band width" length value={e.band} min={2} onChange={(v) => set({ band: v } as Partial<Element>)} onScrubStart={begin} />
          <Slider label="Density" value={e.density} min={0} max={1} onStart={begin} onChange={(v) => live({ density: v } as Partial<Element>)} />
          <ParamSliders defs={ORNAMENT_PARAMS[e.kind] ?? []} params={e.params} onStart={begin} onChange={(k, v) => live((d) => { (d as Draft<OrnamentElement>).params[k] = v; })} />
          <div className="grid grid-cols-4 gap-1">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <Button key={side} variant={e.sides[side] ? 'primary' : 'default'} className="px-1" onClick={() => set((d) => { (d as Draft<OrnamentElement>).sides[side] = !e.sides[side]; })}>{side}</Button>
            ))}
          </div>
          <Toggle label="Trompe-l’œil shadows" checked={e.shadow} onChange={(v) => set({ shadow: v } as Partial<Element>)} />
          <div className="grid grid-cols-3 gap-2">
            {(['gold', 'ink', 'red', 'blue', 'green', 'ground'] as const).map((k) => (
              <ColorField key={k} label={k} value={e.palette[k]} onChange={(v) => v && set((d) => { (d as Draft<OrnamentElement>).palette[k] = v; })} />
            ))}
          </div>
          <Button className="w-full" onClick={reseed}>Reseed ({e.seed})</Button>
        </Section>
      );
    }
    case 'initial': {
      const e = el as InitialElement;
      return (
        <Section title="Initial" id="el-initial">
          <Row>
            <TextInput label="Letter" value={e.letter} onChange={(v) => live({ letter: v.slice(0, 2) } as Partial<Element>)} />
            <NumberField label="Weight" value={e.weight} min={100} max={900} step={50} decimals={0} onChange={(v) => set({ weight: v } as Partial<Element>)} />
          </Row>
          <Select label="Typeface" value={e.fontFamily} options={familyOptions()} onChange={(v) => set({ fontFamily: v } as Partial<Element>)} />
          <Select<DropCapFrame> label="Frame" value={e.frame} options={[{ value: 'gilded', label: 'Burnished gold' }, { value: 'vine', label: 'Vine tracery' }, { value: 'rubric', label: 'Rubric penwork' }, { value: 'box', label: 'Coloured box' }, { value: 'outline', label: 'Double rule' }, { value: 'none', label: 'None' }]} onChange={(v) => set({ frame: v } as Partial<Element>)} />
          <Row>
            <ColorField label="Letter" value={e.color} onChange={(v) => v && set({ color: v } as Partial<Element>)} />
            <ColorField label="Frame" value={e.frameColor} onChange={(v) => v && set({ frameColor: v } as Partial<Element>)} />
          </Row>
          <ColorField label="Ground" value={e.ground} allowNone onChange={(v) => set({ ground: v } as Partial<Element>)} />
          <Button className="w-full" onClick={reseed}>Reseed</Button>
        </Section>
      );
    }
    case 'overprint': {
      const e = el as OverprintElement;
      return (
        <Section title="Monoprint" id="el-overprint">
          <Select<OverprintKind> label="Motif" value={e.kind} options={[
            { value: 'numerals', label: 'Industrial numerals' }, { value: 'circles', label: 'Circles' }, { value: 'squares-grid', label: 'Squares grid' },
            { value: 'stripes', label: 'Stripes' }, { value: 'letters', label: 'Letters' }, { value: 'counters', label: 'Counter-forms' },
          ]} onChange={(v) => set({ kind: v, params: {} } as Partial<Element>)} />
          <TextInput label="Characters" value={e.text} onChange={(v) => live({ text: v } as Partial<Element>)} />
          <Select label="Typeface" value={e.fontFamily} options={familyOptions()} onChange={(v) => set({ fontFamily: v } as Partial<Element>)} />
          <div>
            <span className="text-[10.5px] text-ink-400">Ink passes</span>
            <div className="mt-1 space-y-1">
              {e.inks.map((ink, i) => (
                <div key={i} className="flex items-center gap-1">
                  <div className="flex-1"><ColorField value={ink} onChange={(v) => v && set((d) => { (d as Draft<OverprintElement>).inks[i] = v; })} /></div>
                  <IconButton title="Remove pass" onClick={() => set((d) => { (d as Draft<OverprintElement>).inks.splice(i, 1); })}><X size={12} /></IconButton>
                </div>
              ))}
              <Button className="w-full" onClick={() => set((d) => { (d as Draft<OverprintElement>).inks.push('#1fae6b'); })}><Plus size={12} /> Add ink pass</Button>
            </div>
          </div>
          <NumberField label="Misregistration" unit="pt" value={e.misregister} min={0} step={0.5} onChange={(v) => set({ misregister: v } as Partial<Element>)} onScrubStart={begin} />
          <Slider label="Roller texture" value={e.texture} min={0} max={1} onStart={begin} onChange={(v) => live({ texture: v } as Partial<Element>)} />
          <ParamSliders defs={OVERPRINT_PARAMS[e.kind] ?? []} params={e.params} onStart={begin} onChange={(k, v) => live((d) => { (d as Draft<OverprintElement>).params[k] = v; })} />
          <Toggle label="Write PDF overprint (OP/op)" checked={e.pdfOverprint} onChange={(v) => set({ pdfOverprint: v } as Partial<Element>)} hint="True press overprint in the PDF instead of a transparency blend" />
          <Button className="w-full" onClick={reseed}>Reseed ({e.seed})</Button>
        </Section>
      );
    }
    case 'gradient': {
      const e = el as GradientElement;
      return (
        <Section title="Tonal mesh" id="el-gradient">
          <ColorField label="Base" value={e.base} onChange={(v) => v && set({ base: v } as Partial<Element>)} />
          <Slider label="Softness" value={e.softness} min={0} max={1} onStart={begin} onChange={(v) => live({ softness: v } as Partial<Element>)} />
          <Slider label="Grain" value={e.grain} min={0} max={1} onStart={begin} onChange={(v) => live({ grain: v } as Partial<Element>)} />
          <Toggle label="Luminous glow" checked={e.glow} onChange={(v) => set({ glow: v } as Partial<Element>)} />
          {e.points.map((p, i) => (
            <div key={i} className="space-y-1 rounded-md border border-ink-700 p-2">
              <div className="flex items-center gap-1">
                <div className="flex-1"><ColorField value={p.color} onChange={(v) => v && set((d) => { (d as Draft<GradientElement>).points[i].color = v; })} /></div>
                <IconButton title="Remove light" onClick={() => set((d) => { (d as Draft<GradientElement>).points.splice(i, 1); })}><X size={12} /></IconButton>
              </div>
              <Slider label="X" value={p.x} min={0} max={1} onStart={begin} onChange={(v) => live((d) => { (d as Draft<GradientElement>).points[i].x = v; })} />
              <Slider label="Y" value={p.y} min={0} max={1} onStart={begin} onChange={(v) => live((d) => { (d as Draft<GradientElement>).points[i].y = v; })} />
              <Slider label="Radius" value={p.radius} min={0.05} max={1.5} onStart={begin} onChange={(v) => live((d) => { (d as Draft<GradientElement>).points[i].radius = v; })} />
            </div>
          ))}
          <Button className="w-full" onClick={() => set((d) => { (d as Draft<GradientElement>).points.push({ x: Math.random(), y: Math.random(), color: '#ffd6a5', radius: 0.4 }); })}><Plus size={12} /> Add light</Button>
        </Section>
      );
    }
    case 'cutout': {
      const e = el as CutoutElement;
      return (
        <Section title="Die-cut window" id="el-cutout">
          <Segmented value={e.shape === 'path' ? 'rect' : e.shape} options={[{ value: 'ellipse', label: 'Circle / ellipse' }, { value: 'rect', label: 'Rectangle' }]} onChange={(v) => set({ shape: v } as Partial<Element>)} />
          {e.shape === 'rect' && <NumberField label="Corner radius" length value={e.radius} min={0} onChange={(v) => set({ radius: v } as Partial<Element>)} />}
          <Hint>The window cuts through the whole leaf: on the canvas you see the page beneath through it (and the hole mirrored on the reverse). The PDF carries it as a “CutContour” spot-colour die line; the 3D model makes it a real hole.</Hint>
        </Section>
      );
    }
    case 'drawing': {
      const e = el as DrawingElement;
      return (
        <Section title="Drawing" id="el-drawing">
          <p className="text-[11px] text-ink-300">{e.strokes.length} stroke{e.strokes.length === 1 ? '' : 's'} · {[...new Set(e.strokes.map((x) => x.brush))].join(', ') || 'empty'}</p>
          <Slider label="Paper tooth" value={e.paperGrain} min={0} max={1} onStart={begin} onChange={(v) => live({ paperGrain: v } as Partial<Element>)} />
          <Row>
            <Button disabled={!e.strokes.length} onClick={() => set((d) => { (d as Draft<DrawingElement>).strokes.pop(); })}>Undo stroke</Button>
            <Button variant="danger" disabled={!e.strokes.length} onClick={() => set((d) => { (d as Draft<DrawingElement>).strokes = []; })}>Clear</Button>
          </Row>
          <Button className="w-full" onClick={() => s().setTool('brush')}>Paint with brushes (B)</Button>
          <Hint>Strokes are stored as data, so they re-render crisply for 300-dpi print and for video.</Hint>
        </Section>
      );
    }
    case 'motif':
      return <MotifPanel el={el as MotifElement} />;
    case 'gridtype': {
      const e = el as GridTypeElement;
      return (
        <Section title="Modular alphabet" id="el-gridtype">
          <TextInput label="Text" value={e.text} onChange={(v) => live({ text: v } as Partial<Element>)} />
          <ColorField label="Colour" value={e.color} onChange={(v) => v && set({ color: v } as Partial<Element>)} />
          <Slider label="Stroke weight (of module)" value={e.weight} min={0.1} max={1} onStart={begin} onChange={(v) => live({ weight: v } as Partial<Element>)} />
          <Segmented value={String(e.corner)} options={[{ value: '0', label: 'Square' }, { value: '1', label: '45° chamfer' }, { value: '2', label: 'Round' }]} onChange={(v) => set({ corner: Number(v) } as Partial<Element>)} />
          <Slider label="Tracking (modules)" value={e.tracking} min={0} max={4} step={0.5} onStart={begin} onChange={(v) => live({ tracking: v } as Partial<Element>)} />
          <Toggle label="Show module grid" checked={e.showModules} onChange={(v) => set({ showModules: v } as Partial<Element>)} />
        </Section>
      );
    }
  }
}

export { textBlock };
