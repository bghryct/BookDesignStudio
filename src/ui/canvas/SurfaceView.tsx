import React, { useMemo } from 'react';
import type { Element, Project } from '../../model/types';
import type { BindingCalc } from '../../engine/binding';
import { compileElement, compilePage, layoutText, cutoutPath, elementMatrix, type CompileContext } from '../../render/compile';
import { primsToSvg } from '../../render/svgString';
import { rectPath, multiply, type Prim, type Matrix } from '../../render/primitives';
import { transformPath } from '../../lib/pathData';
import { useFontStore } from '../../engine/fonts';
import { pageSide } from '../../model/surfaces';
import type { SurfaceDesc } from './geometry';
import { anchorOffset } from './geometry';
import { mix } from '../../lib/color';

const mat = (m: Matrix) => `matrix(${m.map((v) => +v.toFixed(4)).join(' ')})`;

function ElementView({ el, ctx, rasterScale, offsetX }: { el: Element; ctx: CompileContext; rasterScale: number; offsetX: number }) {
  useFontStore((s) => s.version);
  const layout = el.type === 'text' ? layoutText(el, ctx) : null;
  const generic = el.type === 'text' ? null : compileElement(el, ctx);
  const prims: Prim[] = useMemo(() => {
    if (el.type === 'text' && layout) return el.fill ? [{ t: 'path', d: rectPath(0, 0, el.w, el.h), fill: el.fill }, ...layout.prims] : layout.prims;
    return generic ?? [];
  }, [layout, generic, el]);
  const html = useMemo(() => primsToSvg(prims, { pxPerPt: rasterScale, idPrefix: `e${el.id}x` }), [prims, rasterScale, el.id]);
  const m = elementMatrix(el, offsetX, 0);
  return (
    <g
      data-el={el.id}
      transform={mat(m)}
      opacity={el.opacity < 1 ? el.opacity : undefined}
      style={el.blend !== 'normal' ? { mixBlendMode: el.blend } : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const MemoElement = React.memo(ElementView, (a, b) => a.el === b.el && a.rasterScale === b.rasterScale && a.offsetX === b.offsetX && (a.el.type !== 'text' || a.ctx.project === b.ctx.project) && a.ctx.pageIndex === b.ctx.pageIndex && a.ctx.side === b.ctx.side);

/** Die-cut windows of a leaf as seen from this page (own cutouts + the other side, mirrored). */
function leafHoles(project: Project, pageIndex: number): string {
  const W = project.book.trimW;
  const paths: string[] = [];
  const add = (els: Element[], mirror: boolean) => {
    for (const el of els) {
      if (el.type !== 'cutout' || el.hidden) continue;
      let m = elementMatrix(el);
      if (mirror) m = multiply([-1, 0, 0, 1, W, 0], m);
      paths.push(transformPath(cutoutPath(el), m));
    }
  };
  add(project.pages[pageIndex].elements, false);
  const partner = pageIndex % 2 === 0 ? pageIndex + 1 : pageIndex - 1;
  if (project.pages[partner]) add(project.pages[partner].elements, true);
  return paths.join(' ');
}

function pageSvg(project: Project, index: number, scale: number, prefix: string, opts?: { mirror?: boolean }) {
  const prims = compilePage(project, index, { dieLines: false });
  const body = primsToSvg(prims, { pxPerPt: scale, idPrefix: prefix, hideDieLines: true });
  if (!opts?.mirror) return body;
  return `<g transform="matrix(-1 0 0 1 ${project.book.trimW} 0)">${body}</g>`;
}

interface Props {
  project: Project;
  surface: SurfaceDesc;
  calc: BindingCalc | null;
  rasterScale: number;
  /** Elements on this surface are interactive (editing a master shows its own items). */
  editable: boolean;
}

export function SurfaceView({ project, surface, calc, rasterScale }: Props) {
  const b = surface.bleed;
  const ctx: CompileContext = { project, surface: surface.key, pageIndex: surface.pageIndex, side: surface.side };
  const els = surfaceElements(project, surface);
  const page = surface.kind === 'page' && surface.pageIndex != null ? project.pages[surface.pageIndex] : null;
  const master = page?.masterId ? project.masters.find((m) => m.id === page.masterId) : null;
  const masterEls = master ? (surface.side === 'left' ? master.left : master.right) : [];
  const mctx: CompileContext = master ? { ...ctx, surface: `master:${master.id}:${surface.side}` } : ctx;
  const clipId = `clip-${surface.key.replace(/[^a-z0-9]/gi, '')}`;
  // On facing pages nothing crosses the spine: the left page is clipped at its right trim edge.
  const facing = project.book.facing && surface.kind !== 'cover';
  const cx0 = facing && surface.side === 'right' ? 0 : -b;
  const cx1 = facing && surface.side === 'left' ? surface.w : surface.w + b;

  // Munari: windows through the leaf and translucent vellum reveal the pages beneath.
  const pi = surface.pageIndex;
  const holes = page && pi != null ? leafHoles(project, pi) : '';
  const underIndex = pi != null ? (pageSide(project, pi) === 'right' ? pi + 2 : pi - 2) : -1;
  const hasUnder = underIndex >= 0 && underIndex < project.pages.length;
  const partnerIndex = pi != null ? (pi % 2 === 0 ? pi + 1 : pi - 1) : -1;
  const vellum = page?.material === 'vellum';
  const underHtml = useMemo(
    () => (hasUnder && (holes || vellum) ? pageSvg(project, underIndex, Math.min(rasterScale, 1), `u${surface.key}`) : ''),
    [hasUnder, holes, vellum, project, underIndex, rasterScale, surface.key],
  );
  const backHtml = useMemo(
    () => (vellum && partnerIndex >= 0 && project.pages[partnerIndex] ? pageSvg(project, partnerIndex, Math.min(rasterScale, 1), `v${surface.key}`, { mirror: true }) : ''),
    [vellum, partnerIndex, project, rasterScale, surface.key],
  );

  const paper = page ? page.paperColor : surface.kind === 'cover' ? coverColor(project) : project.book.paper.color;
  const paperRect = <rect x={-b} y={-b} width={surface.w + 2 * b} height={surface.h + 2 * b} fill={vellum ? mix(paper, '#ffffff', 0.35) : paper} opacity={vellum ? 1 - (page?.vellumOpacity ?? 0.5) * 0.75 : 1} />;

  const content = (
    <>
      {paperRect}
      {masterEls.filter((e) => !e.hidden).map((el) => <MemoElement key={`m-${el.id}`} el={el} ctx={mctx} rasterScale={rasterScale} offsetX={0} />)}
      {els.filter((e) => !e.hidden).map((el) => (
        <MemoElement key={el.id} el={el} ctx={ctx} rasterScale={rasterScale} offsetX={anchorOffset(el, surface, calc)} />
      ))}
    </>
  );

  return (
    <g transform={`translate(${surface.x} ${surface.y})`}>
      <defs>
        <clipPath id={clipId}><rect x={cx0} y={-b} width={cx1 - cx0} height={surface.h + 2 * b} /></clipPath>
        {holes && (
          <>
            <mask id={`${clipId}-mask`} maskUnits="userSpaceOnUse" x={-b} y={-b} width={surface.w + 2 * b} height={surface.h + 2 * b}>
              <rect x={-b} y={-b} width={surface.w + 2 * b} height={surface.h + 2 * b} fill="white" />
              <path d={holes} fill="black" />
            </mask>
            <clipPath id={`${clipId}-holes`}><path d={holes} /></clipPath>
          </>
        )}
      </defs>
      {/* Drop shadow of the sheet on the pasteboard */}
      <rect x={cx0} y={-b} width={cx1 - cx0} height={surface.h + 2 * b} fill="rgba(0,0,0,0.35)" transform="translate(1.5 2.5)" style={{ filter: 'blur(3px)' }} />
      <g clipPath={`url(#${clipId})`}>
        {vellum && (
          <g>
            {underHtml && <g opacity={0.55} dangerouslySetInnerHTML={{ __html: underHtml }} />}
            {backHtml && <g opacity={0.32} dangerouslySetInnerHTML={{ __html: backHtml }} />}
          </g>
        )}
        {holes ? (
          <>
            <g clipPath={`url(#${clipId}-holes)`}>
              {underHtml ? <g dangerouslySetInnerHTML={{ __html: underHtml }} /> : <rect x={-b} y={-b} width={surface.w + 2 * b} height={surface.h + 2 * b} fill="#2b2a2f" />}
              <path d={holes} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={3} />
            </g>
            <g mask={`url(#${clipId}-mask)`}>{content}</g>
          </>
        ) : content}
      </g>
    </g>
  );
}

function surfaceElements(project: Project, s: SurfaceDesc): Element[] {
  if (s.kind === 'cover') return project.cover.elements;
  if (s.kind === 'master') {
    const [, id, side] = s.key.split(':');
    const m = project.masters.find((x) => x.id === id);
    return m ? (side === 'left' ? m.left : m.right) : [];
  }
  return s.pageIndex != null ? project.pages[s.pageIndex]?.elements ?? [] : [];
}

function coverColor(project: Project): string {
  const t = project.book.binding.type;
  return t === 'case' || t === 'coptic' ? project.book.cover.material : project.book.cover.material || '#f4efe4';
}
