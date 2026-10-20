import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Play, Pause, RotateCcw, Camera, Film, Image as ImageIcon, PanelLeft } from 'lucide-react';
import { useStore } from '../store/store';
import {
  BookScene, type AnimationMode, type AnimationInfo, type BookTextures, type LightingPreset, type LightingOptions,
  type BackdropPreset, type CameraPose,
} from '../three';
import { computeBinding, computeJacket } from '../engine/binding';
import { buildBookTextures, pageInfos, TextureRefiner } from '../render/bookTextures';
import { useFontStore } from '../engine/fonts';
import { exportVideo, getVideoSupport, type VideoFormat, type VideoSupport } from '../export/video';
import { downloadBlob, safeName } from './projectIO';
import { Button, Select, Slider, Toggle, Section, ColorField, Segmented, Hint } from './controls';
import { enableJacket } from './jacket';
import { resolveLighting } from '../three/lighting';
import { useScene3D } from './scene3d';

const LIGHTS: { id: LightingPreset; label: string }[] = [
  { id: 'studio', label: 'Studio' }, { id: 'soft-box', label: 'Soft box' }, { id: 'window', label: 'Window' },
  { id: 'golden-hour', label: 'Golden hour' }, { id: 'dramatic', label: 'Dramatic' }, { id: 'top-down', label: 'Top-down' },
  { id: 'overcast', label: 'Overcast' }, { id: 'gallery', label: 'Gallery' }, { id: 'night', label: 'Night' },
];

const BACKDROPS: { id: BackdropPreset; label: string; color: string; color2: string }[] = [
  { id: 'studio-sweep', label: 'Studio sweep', color: '#d9d4cb', color2: '#b9b2a6' },
  { id: 'solid', label: 'Solid', color: '#e8e4dc', color2: '#c8c2b8' },
  { id: 'gradient', label: 'Gradient', color: '#f1ece3', color2: '#9e978b' },
  { id: 'wood', label: 'Oak desk', color: '#8a5a36', color2: '#5c3a22' },
  { id: 'linen', label: 'Linen', color: '#d8cfbf', color2: '#b8ad99' },
  { id: 'concrete', label: 'Concrete', color: '#9c9a96', color2: '#6f6d69' },
  { id: 'paper', label: 'Paper', color: '#f3eee3', color2: '#d9d1c1' },
  { id: 'marble', label: 'Marble', color: '#eceae6', color2: '#9a9690' },
  { id: 'felt', label: 'Felt', color: '#2f4a3e', color2: '#1f3229' },
  { id: 'transparent', label: 'Transparent', color: '#00000000', color2: '#00000000' },
];

const ORIENTATIONS = [
  { id: 'landscape', label: 'Landscape 3:2', w: 3, h: 2 },
  { id: 'wide', label: 'Wide 16:9', w: 16, h: 9 },
  { id: 'portrait', label: 'Portrait 4:5', w: 4, h: 5 },
  { id: 'iso', label: 'Portrait 1:√2', w: 1, h: Math.SQRT2 },
  { id: 'square', label: 'Square 1:1', w: 1, h: 1 },
  { id: 'story', label: 'Story 9:16', w: 9, h: 16 },
] as const;

type OrientationId = (typeof ORIENTATIONS)[number]['id'];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
function sizeFor(o: OrientationId, longEdge: number) {
  const r = ORIENTATIONS.find((x) => x.id === o)!;
  return r.w >= r.h ? { w: even(longEdge), h: even((longEdge * r.h) / r.w) } : { w: even((longEdge * r.w) / r.h), h: even(longEdge) };
}

/** Canvas pixel-ratio cap per quality (the device's own ratio is used up to this). */
const DPR_CAP = { standard: 1.5, high: 2, ultra: 3 } as const;
const pixelRatio = (q: keyof typeof DPR_CAP) => Math.min(DPR_CAP[q] ?? 2, window.devicePixelRatio || 1);

/** 35 mm-equivalent focal length for a vertical field of view (24 mm sensor height). */
const focal = (fov: number) => Math.round(12 / Math.tan((fov * Math.PI) / 360));

/* -------------------------------------------------------------------------- */
/* Viewer                                                                      */
/* -------------------------------------------------------------------------- */

export default function Viewer3D() {
  const project = useStore((s) => s.project);
  const fontVersion = useFontStore((s) => s.version);
  const st = useScene3D();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BookScene | null>(null);
  const texRef = useRef<BookTextures | null>(null);
  /** Re-rasterises what the camera sees at the density it needs (pages, front cover, jacket). */
  const refinerRef = useRef<TextureRefiner | null>(null);
  const qualityRef = useRef(st.quality);
  qualityRef.current = st.quality;
  const [playing, setPlaying] = useState(true);
  const [open, setOpen] = useState(0);
  const [leaf, setLeaf] = useState(0);
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anims, setAnims] = useState<AnimationInfo[]>([]);
  const [scrub, setScrub] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 760));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const calc = useMemo(() => computeBinding(project.book), [project.book]);
  const hasJacket = !!project.book.jacket?.enabled;
  const jacket = useMemo(() => (hasJacket && st.showJacket ? computeJacket(project.book, calc) : null), [hasJacket, st.showJacket, project.book, calc]);
  const infos = useMemo(() => pageInfos(project), [project.pages]); // eslint-disable-line react-hooks/exhaustive-deps

  const scene = () => sceneRef.current;
  const call = <T,>(fn: (s: BookScene) => T): T | undefined => {
    const s = sceneRef.current;
    if (!s) return undefined;
    try { return fn(s); } catch { return undefined; }
  };

  // Mount the WebGL scene.
  useEffect(() => {
    const canvas = canvasRef.current!;
    let sc: BookScene;
    try {
      sc = new BookScene(canvas, { background: st.color, preserveDrawingBuffer: true });
    } catch (e) {
      setError(`WebGL is not available in this browser (${(e as Error).message}).`);
      return;
    }
    sceneRef.current = sc;
    const refiner = new TextureRefiner(sc);
    refiner.quality = qualityRef.current;
    refinerRef.current = refiner;
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current;
      if (el) sc.resize(el.clientWidth, el.clientHeight, pixelRatio(qualityRef.current));
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    // Sharpen what is in view as the camera settles (lighter while an animation plays).
    const poll = window.setInterval(() => {
      if (document.hidden || !sceneRef.current) return;
      refiner.update(sc.getTextureDemand(), sc.isPlaying());
    }, 400);
    return () => { window.clearInterval(poll); ro.disconnect(); refiner.dispose(); refinerRef.current = null; sc.dispose(); sceneRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Quality: texture sharpness and the canvas pixel ratio.
  useEffect(() => {
    const r = refinerRef.current, el = wrapRef.current;
    if (r) r.quality = st.quality;
    if (el) call((s) => s.resize(el.clientWidth, el.clientHeight, pixelRatio(st.quality)));
  }, [st.quality]); // eslint-disable-line react-hooks/exhaustive-deps

  // Geometry follows the binding, page materials and the jacket.
  useEffect(() => {
    const s = scene();
    if (!s) return;
    s.setInput({ spec: project.book, calc, pages: infos, jacket });
    if (texRef.current) s.setTextures(texRef.current);
    refinerRef.current?.reset(project, calc, jacket, texRef.current);
    applyAll();
    setAnims(call((x) => x.getAnimations()) ?? []);
  }, [project.book, calc, infos, jacket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Textures follow every visual change (debounced).
  useEffect(() => {
    const signal = { cancelled: false };
    setBuilding(true);
    const t = setTimeout(async () => {
      try {
        const tex = await buildBookTextures(project, calc, { signal, jacket });
        if (!tex || signal.cancelled) return;
        texRef.current = tex;
        scene()?.setTextures(tex);
        refinerRef.current?.reset(project, calc, jacket, tex);
      } catch (e) {
        setError(`Could not render textures: ${(e as Error).message}`);
      } finally {
        if (!signal.cancelled) setBuilding(false);
      }
    }, 350);
    return () => { signal.cancelled = true; clearTimeout(t); };
  }, [project, calc, fontVersion, jacket]);

  // Lighting / backdrop / camera follow the settings.
  function applyAll() {
    call((s) => s.setLighting({ preset: st.lighting, ...st.light }));
    call((s) => s.setBackdrop({ preset: st.backdrop, color: st.color, color2: st.color2, showGround: st.ground }));
    call((s) => s.setCamera({ fov: st.fov, pose: st.pose }));
  }
  useEffect(() => { call((s) => s.setLighting({ preset: st.lighting, ...st.light })); }, [st.lighting, st.light]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { call((s) => s.setBackdrop({ preset: st.backdrop, color: st.color, color2: st.color2, showGround: st.ground })); }, [st.backdrop, st.color, st.color2, st.ground]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { call((s) => s.setCamera({ fov: st.fov, pose: st.pose })); }, [st.fov, st.pose]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentDuration = () => (call((s) => s.getAnimationDuration()) ?? 6);
  const startMode = (m: AnimationMode, play = true) => {
    st.set({ mode: m });
    const s = scene();
    if (!s) return;
    const base = anims.find((a) => a.id === m)?.duration;
    s.setAnimation(m, { loop: st.loop, pagesToTurn: st.pagesToTurn, duration: base ? base / st.speed : undefined });
    if (play) { s.play(); setPlaying(true); }
  };
  useEffect(() => { if (anims.length) startMode(st.mode); }, [anims.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const s = scene();
    if (!s) return;
    if (s.isPlaying()) { s.pause(); setPlaying(false); } else { s.play(); setPlaying(true); }
  };

  const bgCss = st.backdrop === 'transparent' ? 'repeating-conic-gradient(#3a3940 0% 25%, #2b2a2f 0% 50%) 50% / 16px 16px' : st.color;

  return (
    <div ref={rootRef} className="relative flex h-full w-full">
      {st.panel && (
        // On narrow screens the panel floats over the canvas instead of squeezing it.
        <aside className={clsx('scroll-thin w-[268px] shrink-0 overflow-y-auto border-r border-ink-700 bg-ink-850', narrow && 'absolute inset-y-0 left-0 z-10 max-w-[85%] shadow-2xl')}>
          <ScenePanel anims={anims} startMode={startMode} hasJacket={hasJacket} />
          <ExportPanel scene={sceneRef} refiner={refinerRef} wrap={wrapRef} title={project.book.title} onDone={() => { applyAll(); startMode(st.mode, playing); }} />
        </aside>
      )}
      <div ref={wrapRef} className="relative min-w-0 flex-1" style={{ background: bgCss }}>
        <canvas ref={canvasRef} className="block h-full w-full" />
        {error && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-[13px] text-ink-900">{error}</div>}
        {building && !error && <div className="absolute left-3 top-3 rounded bg-black/55 px-2 py-1 text-[11px] text-white">Rendering textures…</div>}
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg bg-black/50 p-1 backdrop-blur">
          <button type="button" title={st.panel ? 'Hide scene panel' : 'Show scene panel'} className="rounded p-1.5 text-white/80 hover:bg-white/10" onClick={() => st.set({ panel: !st.panel })}><PanelLeft size={14} /></button>
          <button type="button" title="Reset camera" className="rounded p-1.5 text-white/80 hover:bg-white/10" onClick={() => scene()?.resetCamera()}><RotateCcw size={14} /></button>
          <button type="button" title="Quick snapshot (current view)" className="rounded p-1.5 text-white/80 hover:bg-white/10" onClick={() => {
            const url = scene()?.snapshot();
            if (url) { const a = document.createElement('a'); a.href = url; a.download = `${safeName(project.book.title)}-3d.png`; a.click(); }
          }}><Camera size={14} /></button>
        </div>
        <div className="absolute bottom-3 left-1/2 flex w-[min(720px,calc(100%-24px))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl bg-black/55 px-3 py-2 text-white backdrop-blur">
          <button type="button" onClick={togglePlay} className="rounded-full bg-white/15 p-1.5 hover:bg-white/25" title={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <span className="min-w-[90px] truncate text-[11.5px] text-white/80">{anims.find((a) => a.id === st.mode)?.label ?? st.mode}</span>
          <label className="flex min-w-[140px] flex-1 items-center gap-1.5 text-[10.5px] text-white/70" title="Scrub the animation">
            Time
            <input type="range" className="w-full" min={0} max={1} step={0.001} value={scrub} onChange={(e) => {
              const v = parseFloat(e.target.value);
              setScrub(v);
              const s = scene();
              if (!s) return;
              s.pause(); setPlaying(false);
              s.seek(v * currentDuration());
              s.render();
            }} />
          </label>
          <label className="flex items-center gap-1.5 text-[10.5px] text-white/70">Cover
            <input type="range" className="w-20" min={0} max={1} step={0.01} value={open} onChange={(e) => {
              const v = parseFloat(e.target.value);
              setOpen(v); scene()?.pause(); setPlaying(false); scene()?.setOpen(v);
            }} />
          </label>
          <label className="flex items-center gap-1.5 text-[10.5px] text-white/70">Leaves
            <input type="range" className="w-20" min={0} max={12} step={1} value={leaf} onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              setLeaf(v); scene()?.pause(); setPlaying(false);
              if (open < 0.95) { setOpen(1); scene()?.setOpen(1, true); }
              scene()?.setLeaf(v, true);
            }} />
          </label>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene panel                                                                  */
/* -------------------------------------------------------------------------- */

function ScenePanel({ anims, startMode, hasJacket }: { anims: AnimationInfo[]; startMode: (m: AnimationMode) => void; hasJacket: boolean }) {
  const st = useScene3D();
  const light = (k: keyof LightingOptions, v: number) => st.set({ light: { ...st.light, [k]: v } });
  // Sliders show the preset's own values until the user overrides one.
  const L = resolveLighting({ preset: st.lighting, ...st.light });
  return (
    <div>
      <Section title="Animation" id="s3d-anim">
        <div className="space-y-0.5">
          {(anims.length ? anims : [{ id: 'showcase', label: 'Showcase', duration: 0, description: '' } as AnimationInfo]).map((a) => (
            <button key={a.id} type="button" title={a.description} onClick={() => startMode(a.id)}
              className={clsx('flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[11.5px]', st.mode === a.id ? 'bg-rubric/25 text-ink-100' : 'text-ink-300 hover:bg-ink-750')}>
              <span>{a.label}</span>
              <span className="tabular-nums text-[10px] text-ink-500">{a.duration ? `${(a.duration / st.speed).toFixed(1)} s` : ''}</span>
            </button>
          ))}
        </div>
        <Slider label="Speed" value={st.speed} min={0.25} max={3} step={0.05} onChange={(v) => { st.set({ speed: v }); }} format={(v) => `${v.toFixed(2)}×`} />
        {st.mode === 'page-turn' && <Slider label="Leaves to turn" value={st.pagesToTurn} min={1} max={12} step={1} onChange={(v) => st.set({ pagesToTurn: v })} format={(v) => String(v)} />}
        <div className="flex items-center justify-between">
          <Toggle label="Loop" checked={st.loop} onChange={(v) => st.set({ loop: v })} />
          <Button variant="ghost" onClick={() => startMode(st.mode)}>Restart</Button>
        </div>
      </Section>

      <Section title="Lighting" id="s3d-light">
        <div className="grid grid-cols-3 gap-1">
          {LIGHTS.map((l) => (
            <button key={l.id} type="button" onClick={() => st.set({ lighting: l.id, light: {} })}
              className={clsx('h-7 rounded border text-[10.5px]', st.lighting === l.id ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-100')}>{l.label}</button>
          ))}
        </div>
        <Slider label="Intensity" value={L.intensity} min={0} max={3} onChange={(v) => light('intensity', v)} />
        <Slider label="Key light direction" value={L.azimuth} min={-180} max={180} step={1} onChange={(v) => light('azimuth', v)} format={(v) => `${Math.round(v)}°`} />
        <Slider label="Key light height" value={L.elevation} min={5} max={85} step={1} onChange={(v) => light('elevation', v)} format={(v) => `${Math.round(v)}°`} />
        <Slider label="Warmth" value={L.warmth} min={-1} max={1} onChange={(v) => light('warmth', v)} format={(v) => (v > 0.05 ? 'warm' : v < -0.05 ? 'cool' : 'neutral')} />
        <Slider label="Exposure" value={L.exposure} min={0.3} max={3} onChange={(v) => light('exposure', v)} />
        <Slider label="Shadow softness" value={L.shadowSoftness} min={0} max={1} onChange={(v) => light('shadowSoftness', v)} />
        <Slider label="Ambient bounce" value={L.ambient} min={0} max={2} onChange={(v) => light('ambient', v)} />
        <Hint>A preset sets every value; moving a slider overrides just that value.</Hint>
      </Section>

      <Section title="Backdrop" id="s3d-backdrop">
        <div className="grid grid-cols-2 gap-1">
          {BACKDROPS.map((b) => (
            <button key={b.id} type="button" onClick={() => st.set({ backdrop: b.id, color: b.color, color2: b.color2 })}
              className={clsx('flex h-7 items-center gap-1.5 rounded border px-1.5 text-left text-[10.5px]', st.backdrop === b.id ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-100')}>
              <span className={clsx('h-3.5 w-3.5 shrink-0 rounded-sm border border-white/15', b.id === 'transparent' && 'checker')} style={b.id === 'transparent' ? undefined : { background: `linear-gradient(135deg, ${b.color}, ${b.color2})` }} />
              {b.label}
            </button>
          ))}
        </div>
        {st.backdrop !== 'transparent' && (
          <div className="grid grid-cols-2 gap-2">
            <ColorField label={st.backdrop === 'gradient' ? 'Top' : 'Colour'} value={st.color} onChange={(v) => v && st.set({ color: v })} />
            {st.backdrop !== 'solid' && st.backdrop !== 'studio-sweep' && <ColorField label={st.backdrop === 'gradient' ? 'Bottom' : 'Grain / vein'} value={st.color2} onChange={(v) => v && st.set({ color2: v })} />}
          </div>
        )}
        <Toggle label="Ground & contact shadow" checked={st.ground} onChange={(v) => st.set({ ground: v })} />
        {st.backdrop === 'transparent' && <Hint>Stills export as PNG with alpha; WebM keeps transparency where the encoder supports it.</Hint>}
      </Section>

      <Section title="Camera & pose" id="s3d-camera">
        <Slider label="Lens" value={st.fov} min={15} max={75} step={1} onChange={(v) => st.set({ fov: v })} format={(v) => `${focal(v)} mm`} hint="Longer lenses flatten perspective for product shots" />
        <Segmented value={st.pose} onChange={(v) => st.set({ pose: v })} options={[{ value: 'standing', label: 'Standing' }, { value: 'angled', label: 'Angled' }, { value: 'lying', label: 'Lying' }, { value: 'open', label: 'Open' }]} />
        <span className="text-[10.5px] text-ink-400">Quality</span>
        <Segmented value={st.quality} onChange={(v) => st.set({ quality: v })} options={[{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }]} />
        <Hint>Pages and covers in view are re-rendered as sharp as the camera needs; exports always render at full sharpness. Ultra also renders the view at up to 3× pixel density.</Hint>
      </Section>

      <Section title="Dust jacket" id="s3d-jacket">
        {hasJacket
          ? <Toggle label="Show the dust jacket" checked={st.showJacket} onChange={(v) => st.set({ showJacket: v })} />
          : <><Hint>This book has no dust jacket yet.</Hint><Button className="w-full" onClick={() => enableJacket(true)}>Add a dust jacket</Button></>}
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Export (stills & motion, any orientation)                                   */
/* -------------------------------------------------------------------------- */

function ExportPanel({ scene, refiner, wrap, title, onDone }: { scene: React.MutableRefObject<BookScene | null>; refiner: React.MutableRefObject<TextureRefiner | null>; wrap: React.RefObject<HTMLDivElement | null>; title: string; onDone: () => void }) {
  const st = useScene3D();
  const [orientation, setOrientation] = useState<OrientationId>('portrait');
  const [stillEdge, setStillEdge] = useState(2400);
  const [videoEdge, setVideoEdge] = useState(1080);
  const [format, setFormat] = useState<VideoFormat>('mp4');
  const [fps, setFps] = useState(30);
  const [support, setSupport] = useState<VideoSupport | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { void getVideoSupport().then((s) => { setSupport(s); if (!s.mp4) setFormat(s.webm ? 'webm' : 'gif'); }); }, []);
  useEffect(() => { if (format === 'gif') { setFps(15); setVideoEdge((e) => Math.min(e, 800)); } }, [format]);

  const restore = () => {
    const s = scene.current, el = wrap.current;
    if (s && el) s.resize(el.clientWidth, el.clientHeight, pixelRatio(st.quality));
  };
  /** Exports render at full sharpness, whatever the live quality: sharpen first, hold while exporting. */
  const sharpen = async (demand: Parameters<TextureRefiner['prepare']>[0]) => {
    const r = refiner.current;
    if (!r) return;
    r.hold = true;
    const q = r.quality;
    r.quality = q === 'standard' ? 'high' : q;
    try { await r.prepare(demand); } finally { r.quality = q; }
  };

  const still = async () => {
    const s = scene.current;
    if (!s) return;
    const { w, h } = sizeFor(orientation, stillEdge);
    try {
      await sharpen(s.getTextureDemand(w, h));
      const canvas = s.renderStill(w, h);
      const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
      downloadBlob(blob, `${safeName(title)}-${orientation}-${w}x${h}.png`);
      useStore.getState().notify(`Still exported — ${w} × ${h} px.`);
    } catch (e) {
      useStore.getState().notify(`Still export failed: ${(e as Error).message}`, 'error');
    } finally {
      if (refiner.current) refiner.current.hold = false;
      restore();
    }
  };

  const video = async () => {
    const s = scene.current;
    if (!s) return;
    const { w, h } = sizeFor(orientation, videoEdge);
    abort.current = new AbortController();
    setProgress(0);
    s.pause();
    s.setAnimation(st.mode, { loop: false, pagesToTurn: st.pagesToTurn });
    const duration = s.getAnimationDuration() / st.speed;
    s.setAnimation(st.mode, { loop: false, pagesToTurn: st.pagesToTurn, duration });
    try {
      await sharpen(s.getAnimationTextureDemand(w, h));
      const blob = await exportVideo(s, { format, width: w, height: h, fps, duration, onProgress: setProgress, signal: abort.current.signal });
      downloadBlob(blob, `${safeName(title)}-${st.mode}-${orientation}.${format}`);
      useStore.getState().notify(`${format.toUpperCase()} exported — ${w} × ${h}, ${(blob.size / 1e6).toFixed(1)} MB.`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') useStore.getState().notify(`Video export failed: ${(e as Error).message}`, 'error');
    } finally {
      if (refiner.current) refiner.current.hold = false;
      setProgress(null);
      restore();
      onDone();
    }
  };

  const vs = sizeFor(orientation, videoEdge), ss = sizeFor(orientation, stillEdge);
  return (
    <Section title="Export" id="s3d-export">
      <span className="text-[10.5px] text-ink-400">Orientation</span>
      <div className="grid grid-cols-3 gap-1">
        {ORIENTATIONS.map((o) => (
          <button key={o.id} type="button" onClick={() => setOrientation(o.id)} title={o.label}
            className={clsx('flex h-12 flex-col items-center justify-center gap-1 rounded border text-[9.5px]', orientation === o.id ? 'border-rubric bg-rubric/20 text-ink-100' : 'border-ink-700 text-ink-400 hover:text-ink-100')}>
            <span className="block rounded-[2px] border border-current" style={{ width: o.w >= o.h ? 22 : (22 * o.w) / o.h, height: o.w >= o.h ? (22 * o.h) / o.w : 22 }} />
            {o.label.split(' ')[0]}
          </button>
        ))}
      </div>
      <div className="rounded-md border border-ink-700 p-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-200"><ImageIcon size={12} /> Still image</div>
        <Select label="Long edge" value={String(stillEdge)} options={[1200, 1600, 2400, 3200, 4096].map((v) => ({ value: String(v), label: `${v} px` }))} onChange={(v) => setStillEdge(Number(v))} />
        <Button variant="primary" className="mt-2 w-full" onClick={still}>Render PNG · {ss.w} × {ss.h}</Button>
      </div>
      <div className="rounded-md border border-ink-700 p-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-200"><Film size={12} /> Motion · {st.mode}</div>
        <Select<VideoFormat> label="Format" value={format} options={[
          { value: 'mp4', label: `MP4 · H.264${support && !support.mp4 ? ' (unsupported here)' : ''}` },
          { value: 'webm', label: `WebM · VP9${support && !support.webm ? ' (unsupported here)' : ''}` },
          { value: 'gif', label: 'GIF' },
        ]} onChange={setFormat} />
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Select label="Long edge" value={String(videoEdge)} options={(format === 'gif' ? [480, 640, 800] : [720, 1080, 1920, 2160, 3840]).map((v) => ({ value: String(v), label: `${v} px` }))} onChange={(v) => setVideoEdge(Number(v))} />
          <Select label="Frame rate" value={String(fps)} options={(format === 'gif' ? [10, 12, 15, 20] : [24, 25, 30, 60]).map((f) => ({ value: String(f), label: `${f} fps` }))} onChange={(v) => setFps(Number(v))} />
        </div>
        {progress != null ? (
          <div className="mt-2 space-y-1.5">
            <div className="h-1.5 overflow-hidden rounded bg-ink-700"><div className="h-full bg-rubric" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="flex items-center justify-between text-[11px] text-ink-300">Encoding… {Math.round(progress * 100)}%<Button variant="ghost" onClick={() => abort.current?.abort()}>Cancel</Button></div>
          </div>
        ) : (
          <Button variant="primary" className="mt-2 w-full" disabled={(format === 'mp4' && support != null && !support.mp4) || (format === 'webm' && support != null && !support.webm)} onClick={video}>Render {format.toUpperCase()} · {vs.w} × {vs.h}</Button>
        )}
        <Hint>Frames are rendered one by one at full quality and encoded in your browser. The framing adapts to the orientation so the whole book stays in view.</Hint>
      </div>
    </Section>
  );
}
