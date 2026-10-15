import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Draft } from 'immer';
import type { BrushStroke, DrawingElement, Element, PathElement, Project, TextElement } from '../../model/types';
import { useStore, type Tool } from '../../store/store';
import { spreadsOf, surfaceElementsDraft, findElement, COVER_KEY, pageKey, masterKey } from '../../model/surfaces';
import { computeBinding, type BindingCalc } from '../../engine/binding';
import { computeGrid } from '../../engine/grid';
import { makeElement, makeText, makeDrawing, makePath, makeOrnament, makeRule, makeMotif } from '../../model/factory';
import { LIBRARY_MIME } from '../library/LibraryPanel';
import { getItem, insertItem, targetFor } from '../library/insert';
import { uid } from '../../lib/random';
import { applyMatrix, multiply, translate, scale as scaleM } from '../../render/primitives';
import { layoutText, threadOf } from '../../render/compile';
import { renderStroke, simulatePressure, stabilize } from '../../engine/brushes';
import { parsePath, serialize, type Seg } from '../../lib/pathData';
import { SurfaceView } from './SurfaceView';
import { SurfaceGuides, CanonGuides, CoverGuides } from './Guides';
import { TextStoryEditor } from './TextStoryEditor';
import { SpacingOverlay } from './SpacingOverlay';
import {
  type SurfaceDesc, type Pt, sceneMatrix, toLocal, corners, sceneBounds, hitElement, surfaceAt, snapTargets, snapAxis,
} from './geometry';
import { importFiles } from '../importFiles';

/** Cursor position readout (kept out of the main store to avoid re-rendering the app). */
export const useCursor = create<{ x: number; y: number; surface: string }>(() => ({ x: 0, y: 0, surface: '' }));

type Handle = [number, number];
const HANDLES: Handle[] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

interface MoveItem { id: string; x0: number; y0: number; surface: SurfaceDesc }
type Interaction =
  | { k: 'none' }
  | { k: 'pan'; sx: number; sy: number; px: number; py: number }
  | { k: 'move'; start: Pt; items: MoveItem[]; moved: boolean; surface: SurfaceDesc }
  | { k: 'resize'; id: string; handle: Handle; el0: Element; surface: SurfaceDesc }
  | { k: 'rotate'; id: string; center: Pt; a0: number; rot0: number }
  | { k: 'marquee'; start: Pt; cur: Pt; additive: boolean }
  | { k: 'create'; tool: Tool; surface: SurfaceDesc; start: Pt; cur: Pt }
  | { k: 'draw'; surface: SurfaceDesc; elId: string; points: number[]; mouse: boolean; stroke: BrushStroke }
  | { k: 'node'; id: string; seg: number; which: 'p' | 'c1' | 'c2'; segs: Seg[]; surface: SurfaceDesc }
  | { k: 'pen-drag'; idx: number };

interface PenPoint { x: number; y: number; hx: number; hy: number } // anchor + outgoing handle offset (scene)

const CREATE_TOOLS: Tool[] = ['text', 'rect', 'ellipse', 'polygon', 'line', 'image', 'pattern', 'ornament', 'initial', 'overprint', 'gradient', 'cutout', 'gridtype', 'grid-diagram', 'dimension', 'specimen'];
const MOTIF_TOOLS: Partial<Record<Tool, string>> = { 'grid-diagram': 'grid-diagram', dimension: 'dimension', specimen: 'waterfall' };

export function Editor({ mode }: { mode: 'spreads' | 'cover' }) {
  const project = useStore((s) => s.project);
  const spreadIdx = useStore((s) => s.spread);
  const masterEdit = useStore((s) => s.masterEdit);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const zoom = useStore((s) => s.zoom);
  const fitRequest = useStore((s) => s.fitRequest);
  const brush = useStore((s) => s.brush);
  const linking = useStore((s) => s.linking);
  const textEditing = useStore((s) => s.textEditing);

  const rootRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const [creating, setCreating] = useState<{ a: Pt; b: Pt } | null>(null);
  const [pen, setPen] = useState<{ surface: SurfaceDesc; pts: PenPoint[] } | null>(null);
  const [penHover, setPenHover] = useState<Pt | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [rasterScale, setRasterScale] = useState(2);
  const [hoverCursor, setHoverCursor] = useState<string>('default');
  const inter = useRef<Interaction>({ k: 'none' });

  const calc: BindingCalc | null = useMemo(() => (mode === 'cover' ? computeBinding(project.book) : null), [mode, project.book]);
  const spec = project.book;

  /* ---------------------------------------------------------------- surfaces */
  const surfaces: SurfaceDesc[] = useMemo(() => {
    const W = spec.trimW, H = spec.trimH;
    if (mode === 'cover' && calc) {
      return [{ key: COVER_KEY, kind: 'cover', x: 0, y: 0, w: calc.coverW, h: calc.coverH, bleed: calc.wrap, pageIndex: null, side: 'right', label: 'Cover' }];
    }
    if (masterEdit) {
      const m = project.masters.find((x) => x.id === masterEdit.id);
      if (m) {
        return [
          { key: masterKey(m.id, 'left'), kind: 'master', x: 0, y: 0, w: W, h: H, bleed: spec.bleed, pageIndex: null, side: 'left', label: `${m.name} — left` },
          { key: masterKey(m.id, 'right'), kind: 'master', x: W, y: 0, w: W, h: H, bleed: spec.bleed, pageIndex: null, side: 'right', label: `${m.name} — right` },
        ];
      }
    }
    const spreads = spreadsOf(project);
    const sp = spreads[Math.min(spreadIdx, spreads.length - 1)] ?? { left: null, right: null };
    const out: SurfaceDesc[] = [];
    const facing = spec.facing;
    if (sp.left != null) out.push({ key: pageKey(project.pages[sp.left].id), kind: 'page', x: 0, y: 0, w: W, h: H, bleed: spec.bleed, pageIndex: sp.left, side: 'left', label: `Page ${sp.left + 1}` });
    if (sp.right != null) out.push({ key: pageKey(project.pages[sp.right].id), kind: 'page', x: facing ? W : 0, y: 0, w: W, h: H, bleed: spec.bleed, pageIndex: sp.right, side: facing ? 'right' : 'right', label: `Page ${sp.right + 1}` });
    return out;
  }, [mode, calc, masterEdit, project, spreadIdx, spec]);

  const sceneBox = useMemo(() => {
    const pad = (mode === 'cover' && calc ? calc.wrap : spec.bleed) + 18;
    if (mode === 'cover' && calc) return { x: -pad, y: -pad - 14, w: calc.coverW + pad * 2, h: calc.coverH + pad * 2 + 14 };
    const W = spec.trimW;
    const total = spec.facing ? W * 2 : W;
    return { x: -pad, y: -pad, w: total + pad * 2, h: spec.trimH + pad * 2 };
  }, [mode, calc, spec]);

  const allEls = useMemo(() => {
    const out: { el: Element; surface: SurfaceDesc }[] = [];
    for (const s of surfaces) for (const el of surfaceEls(project, s)) out.push({ el, surface: s });
    return out;
  }, [surfaces, project]);

  /* ---------------------------------------------------------------- sizing / zoom */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const userZoomed = useRef(false);
  const fit = useCallback(() => {
    userZoomed.current = false;
    const z = Math.min((size.w - 60) / sceneBox.w, (size.h - 60) / sceneBox.h);
    const zz = Math.max(0.05, Math.min(8, z));
    useStore.getState().setZoom(zz);
    setPan({ x: (size.w - sceneBox.w * zz) / 2 - sceneBox.x * zz, y: (size.h - sceneBox.h * zz) / 2 - sceneBox.y * zz });
  }, [size, sceneBox]);

  useEffect(() => { fit(); }, [fitRequest, mode, masterEdit?.id, spreadIdx, sceneBox.w, sceneBox.h]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the spread fitted while the window or panels resize, until the user zooms by hand.
  useEffect(() => { if (!userZoomed.current) fit(); }, [size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const target = Math.max(0.5, Math.min(4, 2 ** Math.ceil(Math.log2(zoom * dpr))));
    const t = setTimeout(() => setRasterScale(target), 180);
    return () => clearTimeout(t);
  }, [zoom]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    userZoomed.current = true;
    const z0 = useStore.getState().zoom;
    const z1 = Math.max(0.05, Math.min(32, z0 * factor));
    setPan((p) => ({ x: cx - ((cx - p.x) * z1) / z0, y: cy - ((cy - p.y) * z1) / z0 }));
    useStore.getState().setZoom(z1);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
      else { userZoomed.current = true; setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY })); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /* ---------------------------------------------------------------- helpers */
  const toScene = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom };
  };
  const toScreen = (p: Pt): Pt => ({ x: p.x * zoom + pan.x, y: p.y * zoom + pan.y });

  const pick = (p: Pt, cycleFrom?: string): { el: Element; surface: SurfaceDesc } | null => {
    const hits: { el: Element; surface: SurfaceDesc }[] = [];
    for (let i = allEls.length - 1; i >= 0; i--) {
      const { el, surface } = allEls[i];
      if (el.hidden || el.locked) continue;
      if (hitElement(el, surface, calc, p, 4 / zoom)) hits.push({ el, surface });
    }
    if (!hits.length) return null;
    if (cycleFrom) {
      const i = hits.findIndex((h) => h.el.id === cycleFrom);
      if (i >= 0) return hits[(i + 1) % hits.length];
    }
    return hits[0];
  };

  const selected = allEls.filter((x) => selection.includes(x.el.id));
  const single = selected.length === 1 ? selected[0] : null;

  const handleAt = (p: Pt): { kind: 'resize'; h: Handle } | { kind: 'rotate' } | null => {
    if (!single || single.el.locked || tool !== 'select') return null;
    const m = sceneMatrix(single.el, single.surface, calc);
    const tol = 6 / zoom;
    // Rotation handle above the top edge.
    const [rx, ry] = applyMatrix(multiply(m, translate(single.el.w / 2, 0)), 0, -22 / zoom / 1);
    if (Math.hypot(p.x - rx, p.y - ry) < tol * 1.4) return { kind: 'rotate' };
    for (const h of HANDLES) {
      const [hx, hy] = applyMatrix(m, h[0] * single.el.w, h[1] * single.el.h);
      if (Math.abs(p.x - hx) < tol && Math.abs(p.y - hy) < tol) return { kind: 'resize', h };
    }
    return null;
  };

  const st = useStore.getState;

  /* ---------------------------------------------------------------- pointer down */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    rootRef.current?.setPointerCapture(e.pointerId);
    const p = toScene(e);
    const s = st();

    if (e.button === 1 || spaceDown || tool === 'hand') {
      inter.current = { k: 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
      return;
    }
    if (tool === 'zoom') {
      const r = rootRef.current!.getBoundingClientRect();
      zoomAt(e.altKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
      return;
    }

    // Thread linking mode: click a text frame to continue the story there.
    if (linking) {
      const hit = pick(p);
      if (hit && hit.el.type === 'text' && hit.el.id !== linking) {
        const chain = threadOf(s.project, linking);
        if (chain.includes(hit.el.id)) s.notify('That frame is already in this thread.', 'error');
        else {
          s.updateElement(linking, { flowNext: hit.el.id } as Partial<TextElement>);
          s.notify('Frames threaded — the story now flows into the selected frame.');
        }
      }
      s.setLinking(null);
      return;
    }

    if (tool === 'select' || tool === 'node') {
      // Overflow port on a text frame → enter linking mode.
      if (single && single.el.type === 'text') {
        const m = sceneMatrix(single.el, single.surface, calc);
        const [ox, oy] = applyMatrix(m, single.el.w, single.el.h);
        if (Math.abs(p.x - ox) < 8 / zoom && Math.abs(p.y - oy) < 8 / zoom) {
          s.setLinking(single.el.id);
          s.notify('Click another text frame to thread the story into it (Esc to cancel).');
          return;
        }
      }
      if (tool === 'node' && single && single.el.type === 'path') {
        const nh = nodeAt(single.el as PathElement, single.surface, p);
        if (nh) {
          s.checkpoint();
          inter.current = { k: 'node', id: single.el.id, seg: nh.seg, which: nh.which, segs: parsePath((single.el as PathElement).d), surface: single.surface };
          return;
        }
      }
      const h = handleAt(p);
      if (h && single) {
        s.checkpoint();
        if (h.kind === 'rotate') {
          const c = centerOf(single.el, single.surface);
          inter.current = { k: 'rotate', id: single.el.id, center: c, a0: Math.atan2(p.y - c.y, p.x - c.x), rot0: single.el.rotation };
        } else {
          inter.current = { k: 'resize', id: single.el.id, handle: h.h, el0: single.el, surface: single.surface };
        }
        return;
      }
      const hit = pick(p, e.altKey && single ? single.el.id : undefined);
      if (hit) {
        let sel = selection;
        if (e.shiftKey) sel = selection.includes(hit.el.id) ? selection.filter((i) => i !== hit.el.id) : [...selection, hit.el.id];
        else if (!selection.includes(hit.el.id) || e.altKey) sel = [hit.el.id];
        s.select(sel);
        s.checkpoint();
        const items = allEls.filter((x) => sel.includes(x.el.id) && !x.el.locked).map((x) => ({ id: x.el.id, x0: x.el.x, y0: x.el.y, surface: x.surface }));
        inter.current = { k: 'move', start: p, items, moved: false, surface: hit.surface };
        return;
      }
      if (!e.shiftKey) s.select([]);
      s.setTextEditing(null);
      inter.current = { k: 'marquee', start: p, cur: p, additive: e.shiftKey };
      return;
    }

    const surface = surfaceAt(surfaces, p, 40 / zoom);
    if (!surface) return;

    if (tool === 'brush' || tool === 'eraser') {
      const brush = s.brush;
      s.checkpoint();
      let target = single && single.el.type === 'drawing' && single.surface.key === surface.key ? single.el as DrawingElement : null;
      if (!target) {
        const b = surface.bleed;
        target = makeDrawing({ name: 'Drawing', x: -b, y: -b, w: surface.w + 2 * b, h: surface.h + 2 * b });
        s.update((d) => { surfaceElementsDraft(d as Project, surface.key)?.push(target as Draft<Element>); }, { history: false });
        s.select([target.id]);
      }
      const local = toLocal(target, surface, calc, p);
      const mouse = e.pointerType === 'mouse';
      const pr = mouse ? 0.5 : e.pressure || 0.5;
      const stroke: BrushStroke = {
        id: uid('stk'), brush: tool === 'eraser' ? 'eraser' : brush.type, color: brush.color, size: brush.size, opacity: brush.opacity,
        flow: brush.flow, hardness: brush.hardness, grain: brush.grain, wetness: brush.wetness, angle: brush.angle,
        seed: Math.floor(Math.random() * 1e9), points: [local.x, local.y, brush.pressure ? pr : 0.6],
      };
      inter.current = { k: 'draw', surface, elId: target.id, points: stroke.points, mouse, stroke };
      drawLive();
      return;
    }

    if (tool === 'pen') {
      if (pen && pen.pts.length >= 2) {
        const first = pen.pts[0];
        if (Math.hypot(p.x - first.x, p.y - first.y) < 8 / zoom) { finishPen(true); return; }
      }
      const pts = pen && pen.surface.key === surface.key ? [...pen.pts] : [];
      pts.push({ x: p.x, y: p.y, hx: 0, hy: 0 });
      setPen({ surface, pts });
      inter.current = { k: 'pen-drag', idx: pts.length - 1 };
      return;
    }

    if (CREATE_TOOLS.includes(tool)) {
      inter.current = { k: 'create', tool, surface, start: p, cur: p };
      setCreating({ a: p, b: p });
    }
  };

  /* ---------------------------------------------------------------- pointer move */
  const onPointerMove = (e: React.PointerEvent) => {
    const p = toScene(e);
    const sAt = surfaceAt(surfaces, p);
    useCursor.setState({ x: sAt ? p.x - sAt.x : p.x, y: sAt ? p.y - sAt.y : p.y, surface: sAt?.label ?? '' });
    const it = inter.current;
    const s = st();
    switch (it.k) {
      case 'none': {
        if (tool === 'select') {
          const h = handleAt(p);
          setHoverCursor(h ? (h.kind === 'rotate' ? 'grab' : HANDLE_CURSORS[HANDLES.indexOf(h.h)]) : 'default');
        }
        if (tool === 'pen' && pen) setPenHover(p);
        return;
      }
      case 'pan':
        setPan({ x: it.px + e.clientX - it.sx, y: it.py + e.clientY - it.sy });
        return;
      case 'move': {
        let dx = p.x - it.start.x, dy = p.y - it.start.y;
        if (!it.moved && Math.hypot(dx * zoom, dy * zoom) < 3) return;
        it.moved = true;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        // Snap the selection's bounds to grid, baselines and other elements.
        const ids = new Set(it.items.map((i) => i.id));
        const movingEls = it.items.map((i) => allEls.find((x) => x.el.id === i.id)!).filter(Boolean);
        let gx: number | null = null, gy: number | null = null;
        if (!e.altKey && movingEls.length) {
          const bs = movingEls.map((x) => {
            const item = it.items.find((i) => i.id === x.el.id)!;
            return sceneBounds({ ...x.el, x: item.x0 + dx, y: item.y0 + dy } as Element, x.surface, calc);
          });
          const minX = Math.min(...bs.map((b) => b.x)), maxX = Math.max(...bs.map((b) => b.x + b.w));
          const minY = Math.min(...bs.map((b) => b.y)), maxY = Math.max(...bs.map((b) => b.y + b.h));
          const target = surfaceAt(surfaces, { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }) ?? it.surface;
          const lines = snapTargets(s.project, target, allEls.filter((x) => x.surface.key === target.key), calc, ids);
          const thr = 6 / zoom;
          const sx = snapAxis([minX, (minX + maxX) / 2, maxX], lines.x, thr);
          const sy = snapAxis([minY, (minY + maxY) / 2, maxY], lines.y, thr);
          dx += sx.delta; dy += sy.delta;
          gx = sx.line; gy = sy.line;
        }
        setGuides({ x: gx, y: gy });
        s.update((d) => {
          for (const item of it.items) {
            const loc = findElement(d as Project, item.id);
            if (!loc) continue;
            const el = surfaceElementsDraft(d as Project, loc.key)![loc.index];
            el.x = item.x0 + dx;
            el.y = item.y0 + dy;
          }
        }, { history: false });
        return;
      }
      case 'resize': {
        const el0 = it.el0;
        const c0 = centerOf(el0, it.surface);
        const r = (el0.rotation * Math.PI) / 180;
        const cos = Math.cos(-r), sin = Math.sin(-r);
        const vx = p.x - c0.x, vy = p.y - c0.y;
        let lx = vx * cos - vy * sin + el0.w / 2, ly = vx * sin + vy * cos + el0.h / 2;
        const [hx, hy] = it.handle;
        // Snap the moving edge when unrotated.
        if (!el0.rotation && !e.altKey) {
          const lines = snapTargets(s.project, it.surface, allEls.filter((x) => x.surface.key === it.surface.key), calc, new Set([el0.id]));
          const ox = it.surface.x + (el0.anchor && calc ? calc.panels.find((pp) => pp.id === el0.anchor)?.x ?? 0 : 0) + el0.x;
          const oy = it.surface.y + el0.y;
          const thr = 6 / zoom;
          if (hx !== 0.5) { const sx = snapAxis([ox + lx], lines.x, thr); lx += sx.delta; setGuides((g) => ({ ...g, x: sx.line })); }
          if (hy !== 0.5) { const sy = snapAxis([oy + ly], lines.y, thr); ly += sy.delta; setGuides((g) => ({ ...g, y: sy.line })); }
        }
        let left = 0, top = 0, right = el0.w, bottom = el0.h;
        if (hx === 0) left = Math.min(lx, el0.w - 1); else if (hx === 1) right = Math.max(lx, 1);
        if (hy === 0) top = Math.min(ly, el0.h - 1); else if (hy === 1) bottom = Math.max(ly, 1);
        let w = right - left, h = bottom - top;
        if (e.shiftKey && hx !== 0.5 && hy !== 0.5) {
          const ratio = el0.w / el0.h;
          if (w / h > ratio) { const nw = h * ratio; if (hx === 0) left = right - nw; else right = left + nw; w = nw; }
          else { const nh = w / ratio; if (hy === 0) top = bottom - nh; else bottom = top + nh; h = nh; }
        }
        // New centre in scene space.
        const lcx = (left + right) / 2 - el0.w / 2, lcy = (top + bottom) / 2 - el0.h / 2;
        const cr = Math.cos(r), sr = Math.sin(r);
        const ncx = c0.x + lcx * cr - lcy * sr, ncy = c0.y + lcx * sr + lcy * cr;
        const offX = it.surface.x + (el0.anchor && calc ? calc.panels.find((pp) => pp.id === el0.anchor)?.x ?? 0 : 0);
        s.updateElement(el0.id, (d) => {
          d.w = w; d.h = h;
          d.x = ncx - w / 2 - offX;
          d.y = ncy - h / 2 - it.surface.y;
        }, { history: false });
        return;
      }
      case 'rotate': {
        let a = ((Math.atan2(p.y - it.center.y, p.x - it.center.x) - it.a0) * 180) / Math.PI + it.rot0;
        if (e.shiftKey) a = Math.round(a / 15) * 15;
        a = ((a % 360) + 540) % 360 - 180;
        s.updateElement(it.id, { rotation: +a.toFixed(2) }, { history: false });
        return;
      }
      case 'marquee':
        it.cur = p;
        setMarquee({ a: it.start, b: p });
        return;
      case 'create': {
        let b = p;
        if (e.shiftKey) {
          const d = Math.max(Math.abs(p.x - it.start.x), Math.abs(p.y - it.start.y));
          b = { x: it.start.x + Math.sign(p.x - it.start.x || 1) * d, y: it.start.y + Math.sign(p.y - it.start.y || 1) * d };
        }
        it.cur = b;
        setCreating({ a: it.start, b });
        return;
      }
      case 'draw': {
        // The layer may have been created on this very pointerdown, before React re-rendered.
        const el = allEls.find((x) => x.el.id === it.elId)?.el ?? findElement(s.project, it.elId)?.el;
        if (!el) return;
        // Coalesced events give tablet-rate input; the list can be empty for synthetic events.
        const coalesced = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
        const events = coalesced.length ? coalesced : [e.nativeEvent];
        for (const ev of events) {
          const local = toLocal(el, it.surface, calc, toScene(ev));
          const pr = it.mouse ? 0.5 : (ev as PointerEvent).pressure || 0.5;
          it.points.push(local.x, local.y, brush.pressure ? pr : 0.6);
        }
        drawLive();
        return;
      }
      case 'node': {
        const el = allEls.find((x) => x.el.id === it.id)?.el as PathElement | undefined;
        if (!el) return;
        const local = toLocal(el, it.surface, calc, p);
        const kx = el.vw / el.w, ky = el.vh / el.h;
        const px = local.x * kx, py = local.y * ky;
        const segs = it.segs.map((sg) => ({ ...sg })) as Seg[];
        const sg = segs[it.seg];
        if (sg.c === 'Z') return;
        if (it.which === 'p') {
          const ddx = px - sg.x, ddy = py - sg.y;
          sg.x = px; sg.y = py;
          if (sg.c === 'C') { sg.x2 += ddx; sg.y2 += ddy; }
          const nx = segs[it.seg + 1];
          if (nx && nx.c === 'C') { nx.x1 += ddx; nx.y1 += ddy; }
        } else if (sg.c === 'C') {
          if (it.which === 'c1') { sg.x1 = px; sg.y1 = py; } else { sg.x2 = px; sg.y2 = py; }
        }
        it.segs = segs;
        s.updateElement(it.id, { d: serialize(segs) } as Partial<PathElement>, { history: false });
        return;
      }
      case 'pen-drag': {
        if (!pen) return;
        const pts = [...pen.pts];
        const pt = pts[it.idx];
        if (!pt) return;
        pts[it.idx] = { ...pt, hx: p.x - pt.x, hy: p.y - pt.y };
        setPen({ ...pen, pts });
        return;
      }
    }
  };

  /* ---------------------------------------------------------------- pointer up */
  const onPointerUp = (e: React.PointerEvent) => {
    const it = inter.current;
    inter.current = { k: 'none' };
    const s = st();
    setGuides({ x: null, y: null });
    switch (it.k) {
      case 'move':
        if (it.moved) transferAcrossPages(it.items.map((i) => i.id));
        break;
      case 'resize':
        if (calc) reanchor([it.id]);
        break;
      case 'marquee': {
        setMarquee(null);
        const x0 = Math.min(it.start.x, it.cur.x), x1 = Math.max(it.start.x, it.cur.x);
        const y0 = Math.min(it.start.y, it.cur.y), y1 = Math.max(it.start.y, it.cur.y);
        if (x1 - x0 < 2 / zoom && y1 - y0 < 2 / zoom) break;
        const ids = allEls.filter(({ el, surface }) => {
          if (el.hidden || el.locked) return false;
          const b = sceneBounds(el, surface, calc);
          return b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0;
        }).map((x) => x.el.id);
        s.select(it.additive ? [...new Set([...selection, ...ids])] : ids);
        break;
      }
      case 'create': {
        setCreating(null);
        createFromDrag(it.tool, it.surface, it.start, it.cur);
        break;
      }
      case 'draw': {
        const pts0 = it.points;
        let pts = it.mouse && brush.pressure ? simulatePressure(pts0) : pts0;
        if (brush.stabilizer > 0) pts = stabilize(pts, brush.stabilizer);
        if (pts.length >= 3) {
          const stroke: BrushStroke = { ...it.stroke, points: pts.map((v) => +v.toFixed(2)) };
          s.updateElement(it.elId, (d) => { (d as Draft<DrawingElement>).strokes.push(stroke); }, { history: false });
        }
        requestAnimationFrame(() => requestAnimationFrame(clearLive));
        break;
      }
      case 'pen-drag':
        break;
      default:
        break;
    }
    try { rootRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  /* ---------------------------------------------------------------- actions */
  function centerOf(el: Element, surface: SurfaceDesc): Pt {
    const m = sceneMatrix(el, surface, calc);
    const [x, y] = applyMatrix(m, el.w / 2, el.h / 2);
    return { x, y };
  }

  function nodeAt(el: PathElement, surface: SurfaceDesc, p: Pt): { seg: number; which: 'p' | 'c1' | 'c2' } | null {
    const segs = parsePath(el.d);
    const m = multiply(sceneMatrix(el, surface, calc), scaleM(el.w / el.vw, el.h / el.vh));
    const tol = 6 / zoom;
    for (let i = segs.length - 1; i >= 0; i--) {
      const sg = segs[i];
      if (sg.c === 'Z') continue;
      if (sg.c === 'C') {
        const [a, b] = applyMatrix(m, sg.x2, sg.y2);
        if (Math.hypot(p.x - a, p.y - b) < tol) return { seg: i, which: 'c2' };
        const [c, d] = applyMatrix(m, sg.x1, sg.y1);
        if (Math.hypot(p.x - c, p.y - d) < tol) return { seg: i, which: 'c1' };
      }
      const [x, y] = applyMatrix(m, sg.x, sg.y);
      if (Math.hypot(p.x - x, p.y - y) < tol) return { seg: i, which: 'p' };
    }
    return null;
  }

  /** Dragging an item onto the other page of the spread moves it to that page. */
  function transferAcrossPages(ids: string[]) {
    const s = st();
    if (mode === 'cover') { reanchor(ids); return; }
    s.update((d) => {
      for (const id of ids) {
        const cur = allEls.find((x) => x.el.id === id);
        if (!cur || cur.surface.kind !== 'page') continue;
        const loc = findElement(d as Project, id);
        if (!loc) continue;
        const el = surfaceElementsDraft(d as Project, loc.key)![loc.index];
        const cx = cur.surface.x + el.x + el.w / 2, cy = cur.surface.y + el.y + el.h / 2;
        const target = surfaces.find((sf) => sf.kind === 'page' && cx >= sf.x && cx <= sf.x + sf.w && cy >= sf.y - 200 && cy <= sf.y + sf.h + 200);
        if (!target || target.key === loc.key) continue;
        const [moved] = surfaceElementsDraft(d as Project, loc.key)!.splice(loc.index, 1);
        moved.x += cur.surface.x - target.x;
        moved.y += cur.surface.y - target.y;
        surfaceElementsDraft(d as Project, target.key)!.push(moved);
      }
    }, { history: false });
  }

  /** Cover elements belong to the panel (front / spine / back / flap) under their centre. */
  function reanchor(ids: string[]) {
    if (!calc) return;
    st().update((d) => {
      for (const id of ids) {
        const loc = findElement(d as Project, id);
        if (!loc || loc.key !== COVER_KEY) continue;
        const el = d.cover.elements[loc.index];
        const off = el.anchor ? calc.panels.find((p) => p.id === el.anchor)?.x ?? 0 : 0;
        const cx = off + el.x + el.w / 2;
        const panel = calc.panels.find((p) => cx >= p.x && cx <= p.x + p.w && !p.id.startsWith('hinge'));
        const next = (panel?.id ?? null) as Element['anchor'];
        if (next === (el.anchor ?? null)) continue;
        const nOff = next ? calc.panels.find((p) => p.id === next)!.x : 0;
        el.x = el.x + off - nOff;
        el.anchor = next;
      }
    }, { history: false });
  }

  function createFromDrag(t: Tool, surface: SurfaceDesc, a: Pt, b: Pt) {
    const s = st();
    let x = Math.min(a.x, b.x) - surface.x, y = Math.min(a.y, b.y) - surface.y;
    let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const click = w * zoom < 4 && h * zoom < 4;
    let el: Element;
    const anchorX = (xx: number) => {
      if (!calc) return { anchor: undefined as Element['anchor'], x: xx };
      const panel = calc.panels.find((p) => xx >= p.x && xx <= p.x + p.w && !p.id.startsWith('hinge'));
      return panel ? { anchor: panel.id as Element['anchor'], x: xx - panel.x } : { anchor: undefined, x: xx };
    };
    if (t === 'text') {
      if (click && surface.kind !== 'cover') {
        // Click inside a column: frame the column from the click to the foot of the text block.
        const g = computeGrid(s.project.book, surface.side);
        const col = g.cols.find((c) => x >= c.x - 2 && x <= c.x + c.w + 2) ?? { x, w: 200 };
        x = col.x; w = col.w; h = Math.max(30, g.block.y + g.block.h - y);
      } else if (click) { w = 200; h = 60; }
      const head = s.selection.length === 1 ? findElement(s.project, s.selection[0])?.el : null;
      const style = head && head.type === 'text' ? head.style : undefined;
      el = makeText({ x, y, w, h, text: 'Type here. Double-click a frame to edit its story; *italic*, **bold**, ^small caps^; # heading, ## subhead, --- section break.', style });
    } else if (t === 'line') {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const L = click ? 120 : len;
      const cx = (click ? a.x + 60 : (a.x + b.x) / 2) - surface.x, cy = (click ? a.y : (a.y + b.y) / 2) - surface.y;
      el = makeRule({ x: cx - L / 2, y: cy - 4, w: L, h: 8, rotation: click ? 0 : +ang.toFixed(2) });
    } else if (t === 'dimension') {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const L = click ? 72 : len;
      const cx = (click ? a.x + 36 : (a.x + b.x) / 2) - surface.x, cy = (click ? a.y : (a.y + b.y) / 2) - surface.y;
      el = makeMotif('dimension', { x: cx - L / 2, y: cy - 9, w: L, h: 18, rotation: click ? 0 : +ang.toFixed(2) });
    } else if (MOTIF_TOOLS[t]) {
      const kind = MOTIF_TOOLS[t]!;
      const m = makeMotif(kind);
      if (click) { w = m.w; h = m.h; x -= w / 2; y -= h / 2; }
      el = { ...m, x, y, w: Math.max(8, w), h: Math.max(8, h) };
    } else if (t === 'ornament' && click && surface.kind !== 'cover') {
      // Click: frame the whole text block, decorating the margins.
      const g = computeGrid(s.project.book, surface.side);
      const band = Math.min(s.project.book.margins.outer, s.project.book.margins.bottom) * 0.8;
      el = makeOrnament({ x: g.block.x - band, y: g.block.y - band, w: g.block.w + band * 2, h: g.block.h + band * 2, band });
    } else {
      const defaults = makeElement(toolType(t));
      if (click) { w = defaults.w; h = defaults.h; x -= w / 2; y -= h / 2; }
      el = makeElement(toolType(t), { x, y, w: Math.max(4, w), h: Math.max(4, h) } as Partial<Element>);
      if (t === 'rect') el = { ...el, ...{ shape: 'rect' } } as Element;
      if (t === 'ellipse') el = { ...el, ...{ shape: 'ellipse' } } as Element;
      if (t === 'polygon') el = { ...el, ...{ shape: 'star', sides: 5 } } as Element;
    }
    if (surface.kind === 'cover') {
      const an = anchorX(el.x);
      el = { ...el, x: an.x, anchor: an.anchor };
    }
    s.addElement(surface.key, el);
    s.setTool('select');
    if (el.type === 'image') requestAnimationFrame(() => pickImageFor(el.id));
    if (el.type === 'text') s.setTextEditing(el.id);
  }

  function pickImageFor(id: string) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.svg';
    input.onchange = async () => {
      const files = input.files ? [...input.files] : [];
      const res = await importFiles(files, { replaceImageId: id });
      if (res.errors.length) st().notify(res.errors[0], 'error');
    };
    input.click();
  }

  function finishPen(close: boolean) {
    if (!pen || pen.pts.length < 2) { setPen(null); return; }
    const sf = pen.surface;
    const pts = pen.pts.map((q) => ({ ...q, x: q.x - sf.x, y: q.y - sf.y }));
    const xs: number[] = [], ys: number[] = [];
    for (const q of pts) { xs.push(q.x, q.x + q.hx, q.x - q.hx); ys.push(q.y, q.y + q.hy, q.y - q.hy); }
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - x0), h = Math.max(1, Math.max(...ys) - y0);
    const segs: Seg[] = [{ c: 'M', x: pts[0].x - x0, y: pts[0].y - y0 }];
    const n = pts.length;
    const count = close ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n];
      segs.push({ c: 'C', x1: p0.x + p0.hx - x0, y1: p0.y + p0.hy - y0, x2: p1.x - p1.hx - x0, y2: p1.y - p1.hy - y0, x: p1.x - x0, y: p1.y - y0 });
    }
    if (close) segs.push({ c: 'Z' });
    const el = makePath({ x: x0, y: y0, w, h, vw: w, vh: h, d: serialize(segs), fill: close ? '#d8cfbd' : null, stroke: '#1b1813', strokeWidth: 1 });
    st().addElement(sf.key, el);
    setPen(null);
    setPenHover(null);
  }

  /* ---------------------------------------------------------------- live brush */
  function drawLive() {
    const it = inter.current;
    const canvas = liveRef.current;
    if (it.k !== 'draw' || !canvas) return;
    const el = allEls.find((x) => x.el.id === it.elId)?.el ?? findElement(st().project, it.elId)?.el;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const m = multiply(scaleM(dpr), multiply(translate(pan.x, pan.y), multiply(scaleM(zoom), sceneMatrix(el, it.surface, calc))));
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    let pts = it.points;
    if (brush.stabilizer > 0 && pts.length > 9) pts = stabilize(pts, brush.stabilizer);
    if (it.mouse && brush.pressure && pts.length > 6) pts = simulatePressure(pts);
    try {
      renderStroke(ctx, { ...it.stroke, points: pts }, { pxPerPt: zoom * dpr, paperGrain: (el as DrawingElement).paperGrain ?? 0.5 });
    } catch { /* keep painting even if one frame fails */ }
  }
  function clearLive() {
    const c = liveRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
  }

  /* ---------------------------------------------------------------- keyboard */
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (isField(e.target)) return;
      const s = st();
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space' && !e.repeat) { setSpaceDown(true); e.preventDefault(); return; }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) s.redo(); else s.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); s.duplicateSelection(); return; }
      if (mod && e.key.toLowerCase() === 'c') { s.copySelection(); return; }
      if (mod && e.key.toLowerCase() === 'v') {
        const target = single?.surface.key ?? surfaces[surfaces.length - 1]?.key;
        if (target) { e.preventDefault(); s.paste(target); }
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); s.select(allEls.filter((x) => !x.el.locked && !x.el.hidden).map((x) => x.el.id)); return; }
      if (mod && (e.key === '0')) { e.preventDefault(); fit(); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomAt(1.25, size.w / 2, size.h / 2); return; }
      if (mod && e.key === '-') { e.preventDefault(); zoomAt(0.8, size.w / 2, size.h / 2); return; }
      if (mod && e.key === '1') { e.preventDefault(); const z = 1; zoomAt(z / s.zoom, size.w / 2, size.h / 2); return; }
      if (mod && e.key === ']') { e.preventDefault(); s.arrange(e.shiftKey ? 'front' : 'forward'); return; }
      if (mod && e.key === '[') { e.preventDefault(); s.arrange(e.shiftKey ? 'back' : 'backward'); return; }
      if (e.key === 'Escape') {
        if (pen) { finishPen(false); return; }
        s.setLinking(null); s.setTextEditing(null); s.select([]); s.setTool('select');
        return;
      }
      if (e.key === 'Enter' && pen) { finishPen(false); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); s.deleteSelection(); return; }
      if (e.key.startsWith('Arrow') && s.selection.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        s.update((d) => {
          for (const id of s.selection) {
            const loc = findElement(d as Project, id);
            if (!loc) continue;
            const el = surfaceElementsDraft(d as Project, loc.key)![loc.index];
            if (el.locked) continue;
            el.x += dx; el.y += dy;
          }
        });
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === '[') { s.setBrush({ size: Math.max(0.5, s.brush.size / 1.2) }); return; }
      if (e.key === ']') { s.setBrush({ size: Math.min(400, s.brush.size * 1.2) }); return; }
      const map: Record<string, Tool> = { v: 'select', a: 'node', t: 'text', r: 'rect', e: 'ellipse', l: 'line', p: 'pen', b: 'brush', x: 'eraser', h: 'hand', z: 'zoom', i: 'image', k: 'pattern', o: 'ornament', g: 'gradient', d: 'cutout', m: 'dimension' };
      const tl = map[e.key.toLowerCase()];
      if (tl) s.setTool(tl);
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  /* ---------------------------------------------------------------- drop files */
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const libId = e.dataTransfer.getData(LIBRARY_MIME);
    if (libId) {
      const item = getItem(libId);
      const p = toScene(e);
      const surface = surfaceAt(surfaces, p, 40 / zoom) ?? surfaces[0];
      const target = surface ? targetFor(st().project, surface.key) : null;
      if (item && target && surface) {
        const ax = target.anchor && calc ? calc.panels.find((pp) => pp.id === target.anchor)?.x ?? 0 : 0;
        insertItem(item, target, { x: p.x - surface.x - ax, y: p.y - surface.y });
      }
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const p = toScene(e);
    const surface = surfaceAt(surfaces, p, 40) ?? surfaces[0];
    const res = await importFiles(files, { place: surface ? { surfaceKey: surface.key, x: p.x - surface.x, y: p.y - surface.y } : undefined });
    if (res.errors.length) st().notify(res.errors[0], 'error');
    else if (res.messages.length) st().notify(res.messages.join(' '));
  };

  /* ---------------------------------------------------------------- render */
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const cursor = spaceDown || tool === 'hand' ? 'grab' : tool === 'zoom' ? 'zoom-in' : tool === 'select' ? hoverCursor : tool === 'node' ? 'default' : 'crosshair';
  const textOverflow = (el: Element, surface: SurfaceDesc) => {
    if (el.type !== 'text') return false;
    try { return layoutText(el, { project, surface: surface.key, pageIndex: surface.pageIndex, side: surface.side }).overflow; } catch { return false; }
  };

  return (
    <div
      ref={rootRef}
      className="pasteboard relative h-full w-full overflow-hidden"
      style={{ cursor, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if (pen) { finishPen(false); return; }
        if (tool !== 'select' && tool !== 'node') return;
        const hit = pick(toScene(e));
        if (!hit) return;
        if (hit.el.type === 'text') st().setTextEditing(hit.el.id);
        else if (hit.el.type === 'path') st().setTool('node');
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={size.w} height={size.h} className="absolute inset-0 select-none" style={{ pointerEvents: 'none' }}>
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {surfaces.map((s) => (
            <SurfaceView key={s.key} project={project} surface={s} calc={calc} rasterScale={rasterScale} editable />
          ))}
          {mode === 'spreads' && spec.facing && surfaces.length > 0 && (
            <line x1={spec.trimW} x2={spec.trimW} y1={-spec.bleed} y2={spec.trimH + spec.bleed} stroke="rgba(0,0,0,0.22)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          )}
          {mode === 'spreads' && surfaces.map((s) => <SurfaceGuides key={`g${s.key}`} project={project} surface={s} />)}
          {mode === 'spreads' && <CanonGuides project={project} x={0} y={0} />}
          {spec.grid.showSpacing && <SpacingOverlay project={project} items={allEls} calc={calc} />}
          {mode === 'cover' && calc && surfaces[0] && <CoverGuides calc={calc} surface={surfaces[0]} showBleed={spec.grid.showBleed} />}
          {mode === 'spreads' && surfaces.map((s) => (
            <text key={`l${s.key}`} x={s.x + 2} y={s.y + s.h + s.bleed + 12 / zoom} fontSize={10 / zoom} fill="rgba(240,235,225,0.45)" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>
              {s.label}{s.pageIndex != null && project.pages[s.pageIndex]?.label ? ` · ${project.pages[s.pageIndex].label}` : ''}{s.pageIndex != null && project.pages[s.pageIndex]?.masterId ? ` · ${project.masters.find((m) => m.id === project.pages[s.pageIndex!].masterId)?.name ?? ''}` : ''}
            </text>
          ))}
          {/* Threads between frames visible on this spread */}
          {allEls.filter((x) => x.el.type === 'text' && (x.el as TextElement).flowNext && selection.length > 0).map((x) => {
            const nextId = (x.el as TextElement).flowNext!;
            const target = allEls.find((y) => y.el.id === nextId);
            if (!target) return null;
            const [ax, ay] = applyMatrix(sceneMatrix(x.el, x.surface, calc), x.el.w, x.el.h);
            const [bx, by] = applyMatrix(sceneMatrix(target.el, target.surface, calc), 0, 0);
            const show = selection.includes(x.el.id) || selection.includes(nextId);
            if (!show) return null;
            return <path key={`th${x.el.id}`} d={`M${ax} ${ay} C${ax + 40} ${ay} ${bx - 40} ${by} ${bx} ${by}`} fill="none" stroke="#5aa9e6" strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />;
          })}
        </g>
        {/* Overlays in screen space */}
        <g>
          {selected.map(({ el, surface }) => {
            const cs = corners(el, surface, calc).map(toScreen);
            const overflow = textOverflow(el, surface);
            return (
              <g key={`sel${el.id}`}>
                <polygon points={cs.map((c) => `${c.x},${c.y}`).join(' ')} fill="none" stroke={el.locked ? '#888' : '#4aa3ff'} strokeWidth={1} />
                {el.type === 'text' && (
                  <>
                    <rect x={cs[2].x - 5} y={cs[2].y - 5} width={10} height={10} fill={overflow ? '#e5483a' : '#fff'} stroke="#4aa3ff" />
                    {overflow && <text x={cs[2].x} y={cs[2].y + 3.5} textAnchor="middle" fontSize={10} fill="#fff" style={{ fontFamily: 'ui-sans-serif' }}>+</text>}
                  </>
                )}
              </g>
            );
          })}
          {single && !single.el.locked && tool === 'select' && (() => {
            const m = sceneMatrix(single.el, single.surface, calc);
            const hs = HANDLES.map((h) => toScreen((([x, y]) => ({ x, y }))(applyMatrix(m, h[0] * single.el.w, h[1] * single.el.h))));
            const top = toScreen((([x, y]) => ({ x, y }))(applyMatrix(m, single.el.w / 2, 0)));
            const [rx, ry] = applyMatrix(multiply(m, translate(single.el.w / 2, 0)), 0, -22 / zoom);
            const rot = toScreen({ x: rx, y: ry });
            return (
              <g>
                <line x1={top.x} y1={top.y} x2={rot.x} y2={rot.y} stroke="#4aa3ff" />
                <circle cx={rot.x} cy={rot.y} r={4.5} fill="#fff" stroke="#4aa3ff" />
                {hs.map((h, i) => (single.el.type === 'text' && i === 4 ? null : <rect key={i} x={h.x - 3.5} y={h.y - 3.5} width={7} height={7} fill="#fff" stroke="#4aa3ff" />))}
              </g>
            );
          })()}
          {tool === 'node' && single && single.el.type === 'path' && (() => {
            const el = single.el as PathElement;
            const m = multiply(sceneMatrix(el, single.surface, calc), scaleM(el.w / el.vw, el.h / el.vh));
            const segs = parsePath(el.d);
            const sp = (x: number, y: number) => { const [a, b] = applyMatrix(m, x, y); return toScreen({ x: a, y: b }); };
            let prev: Pt | null = null;
            return (
              <g>
                {segs.map((sg, i) => {
                  if (sg.c === 'Z') return null;
                  const p = sp(sg.x, sg.y);
                  const out = (
                    <g key={i}>
                      {sg.c === 'C' && prev && (() => {
                        const c1 = sp(sg.x1, sg.y1), c2 = sp(sg.x2, sg.y2);
                        return (
                          <>
                            <line x1={prev!.x} y1={prev!.y} x2={c1.x} y2={c1.y} stroke="#4aa3ff" strokeWidth={0.8} />
                            <line x1={p.x} y1={p.y} x2={c2.x} y2={c2.y} stroke="#4aa3ff" strokeWidth={0.8} />
                            <circle cx={c1.x} cy={c1.y} r={3} fill="#4aa3ff" />
                            <circle cx={c2.x} cy={c2.y} r={3} fill="#4aa3ff" />
                          </>
                        );
                      })()}
                      <rect x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} fill="#fff" stroke="#4aa3ff" />
                    </g>
                  );
                  prev = p;
                  return out;
                })}
              </g>
            );
          })()}
          {guides.x != null && <line x1={toScreen({ x: guides.x, y: 0 }).x} x2={toScreen({ x: guides.x, y: 0 }).x} y1={0} y2={size.h} stroke="#ff3d8b" strokeWidth={1} />}
          {guides.y != null && <line y1={toScreen({ x: 0, y: guides.y }).y} y2={toScreen({ x: 0, y: guides.y }).y} x1={0} x2={size.w} stroke="#ff3d8b" strokeWidth={1} />}
          {marquee && (() => {
            const a = toScreen(marquee.a), b = toScreen(marquee.b);
            return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill="rgba(74,163,255,0.08)" stroke="#4aa3ff" strokeDasharray="3 3" />;
          })()}
          {creating && (() => {
            const a = toScreen(creating.a), b = toScreen(creating.b);
            return <rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} fill="rgba(217,83,47,0.06)" stroke="#d9532f" strokeDasharray="4 3" />;
          })()}
          {pen && (() => {
            const pts = pen.pts.map((q) => ({ a: toScreen(q), h: toScreen({ x: q.x + q.hx, y: q.y + q.hy }), hi: toScreen({ x: q.x - q.hx, y: q.y - q.hy }) }));
            let d = `M${pts[0].a.x} ${pts[0].a.y}`;
            for (let i = 1; i < pts.length; i++) d += `C${pts[i - 1].h.x} ${pts[i - 1].h.y} ${pts[i].hi.x} ${pts[i].hi.y} ${pts[i].a.x} ${pts[i].a.y}`;
            const hover = penHover ? toScreen(penHover) : null;
            const last = pts[pts.length - 1];
            return (
              <g>
                <path d={d} fill="none" stroke="#d9532f" strokeWidth={1.2} />
                {hover && <line x1={last.a.x} y1={last.a.y} x2={hover.x} y2={hover.y} stroke="#d9532f" strokeDasharray="3 3" />}
                {pts.map((q, i) => (
                  <g key={i}>
                    {(q.h.x !== q.a.x || q.h.y !== q.a.y) && <line x1={q.hi.x} y1={q.hi.y} x2={q.h.x} y2={q.h.y} stroke="#d9532f" strokeWidth={0.8} />}
                    <rect x={q.a.x - 3.5} y={q.a.y - 3.5} width={7} height={7} fill={i === 0 ? '#d9532f' : '#fff'} stroke="#d9532f" />
                  </g>
                ))}
              </g>
            );
          })()}
        </g>
      </svg>
      <canvas
        ref={liveRef}
        width={Math.round(size.w * dpr)}
        height={Math.round(size.h * dpr)}
        className="pointer-events-none absolute inset-0"
        style={{ width: size.w, height: size.h }}
      />
      {(tool === 'brush' || tool === 'eraser') && <BrushCursor zoom={zoom} size={brush.size} />}
      {textEditing && (() => {
        const target = allEls.find((x) => x.el.id === textEditing);
        if (!target) return null;
        const b = sceneBounds(target.el, target.surface, calc);
        const a = toScreen({ x: b.x, y: b.y });
        return <TextStoryEditor elementId={textEditing} anchor={{ x: a.x, y: a.y, w: b.w * zoom, h: b.h * zoom }} viewport={size} />;
      })()}
      {linking && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-[#5aa9e6] px-3 py-1 text-[11px] font-medium text-white shadow-lg">
          Threading — click the frame the story should continue in
        </div>
      )}
      {mode === 'spreads' && masterEdit && (
        <div className="pointer-events-none absolute left-3 top-3 rounded bg-[#7e57c2] px-2.5 py-1 text-[11px] font-medium text-white shadow">
          Editing master — items appear on every page that uses it. Tokens: {'{page}'} {'{title}'} {'{author}'}
        </div>
      )}
    </div>
  );
}

function BrushCursor({ zoom, size }: { zoom: number; size: number }) {
  const [pos, setPos] = useState<Pt | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const root = t.closest?.('.pasteboard');
      if (!root) { setPos(null); return; }
      const r = root.getBoundingClientRect();
      setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);
  if (!pos) return null;
  const d = Math.max(3, size * zoom);
  return <div className="pointer-events-none absolute rounded-full border border-white/70 mix-blend-difference" style={{ left: pos.x - d / 2, top: pos.y - d / 2, width: d, height: d }} />;
}

function toolType(t: Tool): Element['type'] {
  switch (t) {
    case 'rect': case 'ellipse': case 'polygon': return 'shape';
    case 'line': return 'rule';
    case 'image': return 'image';
    case 'pattern': return 'pattern';
    case 'ornament': return 'ornament';
    case 'initial': return 'initial';
    case 'overprint': return 'overprint';
    case 'gradient': return 'gradient';
    case 'cutout': return 'cutout';
    case 'gridtype': return 'gridtype';
    default: return 'text';
  }
}

function surfaceEls(project: Project, s: SurfaceDesc): Element[] {
  if (s.kind === 'cover') return project.cover.elements;
  if (s.kind === 'master') {
    const [, id, side] = s.key.split(':');
    const m = project.masters.find((x) => x.id === id);
    return m ? (side === 'left' ? m.left : m.right) : [];
  }
  return s.pageIndex != null ? project.pages[s.pageIndex]?.elements ?? [] : [];
}

