import React, { useEffect, useMemo } from 'react';
import { Shuffle } from 'lucide-react';
import { useStore } from '../store/store';
import { PRESET_FAMILIES, defaultContent, previewProject, type PresetResult } from '../engine/presets';
import { spreadsOf } from '../model/surfaces';
import { compilePage } from '../render/compile';
import { primsToSvg } from '../render/svgString';
import { useFontStore, ensureFamily } from '../engine/fonts';
import { useMatrix, applyFamily } from './panels/PresetsPanel';
import { Button, Segmented, Select } from './controls';
import type { Project } from '../model/types';
import { ellipsePath, rectPath } from '../render/primitives';

/** Multi-option matrix: 4–9 structured variations generated from the same content. */
export default function LayoutMatrix() {
  const project = useStore((s) => s.project);
  const { family, seed, source } = useMatrix();
  useFontStore((s) => s.version);
  const content = useMemo(() => defaultContent(source === 'document' ? project : undefined), [project, source]);

  const cards = useMemo(() => {
    const out: { familyId: string; variant: number; result: PresetResult; name: string }[] = [];
    if (family === 'all') {
      PRESET_FAMILIES.forEach((f, i) => out.push({ familyId: f.id, variant: (seed + i) % 8, result: f.generate(content, (seed + i) % 8, seed + i * 13), name: f.name }));
    } else {
      const f = PRESET_FAMILIES.find((x) => x.id === family);
      if (f) for (let v = 0; v < 8; v++) out.push({ familyId: f.id, variant: v, result: f.generate(content, v, seed + v * 7), name: f.name });
    }
    return out;
  }, [family, seed, content]);

  // Make sure every family used by the previews is loading (after render: it updates the font store).
  useEffect(() => { for (const id of ['eb-garamond', 'cinzel', 'inter', 'space-grotesk', 'ibm-plex-mono', 'unifraktur', 'fraunces']) void ensureFamily(id); }, []);

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-ink-900">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900/95 px-5 py-3 backdrop-blur">
        <div>
          <h1 className="font-serif text-[20px] leading-none text-ink-100" style={{ fontFamily: '"BDS EB Garamond", Georgia, serif' }}>Layout matrix</h1>
          <p className="mt-1 text-[11px] text-ink-400">Structured variations from identical content. Apply one to replace the document (undo restores it).</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="w-56">
            <Select value={family} options={[{ value: 'all', label: 'All canons — one each' }, ...PRESET_FAMILIES.map((f) => ({ value: f.id, label: `${f.name} — ${f.designer}` }))]} onChange={(v) => useMatrix.setState({ family: v })} />
          </div>
          <div className="w-52">
            <Segmented value={source} onChange={(v) => useMatrix.setState({ source: v })} options={[{ value: 'document', label: 'My text' }, { value: 'sample', label: 'Sample text' }]} />
          </div>
          <Button onClick={() => useMatrix.setState({ seed: Math.floor(Math.random() * 10000) })}><Shuffle size={13} /> Regenerate</Button>
        </div>
      </div>
      <div className="grid gap-5 p-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {cards.map((c, i) => (
          <MatrixCard key={`${c.familyId}-${c.variant}-${i}`} base={project} card={c} />
        ))}
      </div>
    </div>
  );
}

function MatrixCard({ base, card }: { base: Project; card: { familyId: string; variant: number; result: PresetResult; name: string } }) {
  const preview = useMemo(() => previewProject(base, card.result), [base, card.result]);
  const version = useFontStore((s) => s.version);
  const sp = spreadsOf(preview)[card.result.focusSpread] ?? spreadsOf(preview)[0];
  const W = preview.book.trimW, H = preview.book.trimH;
  const html = useMemo(() => {
    const parts: string[] = [];
    const place = (idx: number | null, x: number) => {
      if (idx == null) return;
      const prims = compilePage(preview, idx, { dieLines: false });
      // Die-cut windows show the colour of the leaf beneath (Munari).
      const under = preview.pages[idx % 2 === 0 ? idx + 2 : idx - 2];
      for (const el of preview.pages[idx].elements) {
        if (el.type !== 'cutout') continue;
        const d = el.shape === 'ellipse' ? ellipsePath(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2) : rectPath(el.x, el.y, el.w, el.h, el.radius);
        prims.push({ t: 'path', d, fill: under?.paperColor ?? '#2b2a2f', stroke: 'rgba(0,0,0,0.25)', strokeWidth: 1.5 });
      }
      parts.push(`<g transform="translate(${x} 0)"><clipPath id="mc${card.familyId}${card.variant}${idx}"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath><g clip-path="url(#mc${card.familyId}${card.variant}${idx})">${primsToSvg(prims, { pxPerPt: 0.6, idPrefix: `mx${card.familyId}${card.variant}${idx}`, hideDieLines: true })}</g></g>`);
    };
    place(sp.left, 0);
    place(sp.right, W);
    return parts.join('');
  }, [preview, sp, W, H, card.familyId, card.variant, version]);
  const fam = PRESET_FAMILIES.find((f) => f.id === card.familyId)!;
  return (
    <div className="group overflow-hidden rounded-lg border border-ink-700 bg-ink-850 transition-colors hover:border-ink-500">
      <div className="pasteboard flex items-center justify-center p-4">
        <svg viewBox={`-4 -4 ${W * 2 + 8} ${H + 8}`} className="w-full drop-shadow-[0_4px_10px_rgba(0,0,0,0.5)]" style={{ aspectRatio: `${W * 2 + 8} / ${H + 8}` }}>
          <g dangerouslySetInnerHTML={{ __html: html }} />
          <line x1={W} x2={W} y1={0} y2={H} stroke="rgba(0,0,0,0.25)" strokeWidth={0.6} />
        </svg>
      </div>
      <div className="flex items-start gap-2 border-t border-ink-700 p-3">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: fam.accent }} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-ink-100">{card.name} <span className="text-ink-500">· {card.variant + 1}</span></div>
          <div className="truncate text-[10.5px] text-ink-400" title={card.result.caption}>{card.result.caption}</div>
        </div>
        <Button variant="primary" onClick={() => applyFamily(card.familyId, card.variant, useMatrix.getState().seed + (useMatrix.getState().family === 'all' ? PRESET_FAMILIES.findIndex((f) => f.id === card.familyId) * 13 : card.variant * 7))}>Apply</Button>
      </div>
    </div>
  );
}
