import React, { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Play, Pause, RotateCcw, Camera, Film, X, BookOpen, Orbit, Sparkles, Layers } from 'lucide-react';
import { useStore } from '../store/store';
import { BookScene, type AnimationMode, type BookTextures } from '../three';
import { computeBinding } from '../engine/binding';
import { buildBookTextures, pageInfos } from '../render/bookTextures';
import { useFontStore } from '../engine/fonts';
import { exportVideo, getVideoSupport, type VideoFormat, type VideoSupport } from '../export/video';
import { downloadBlob, safeName } from './projectIO';
import { Button, Select, Slider, Toggle } from './controls';

const MODES: { id: AnimationMode; label: string; icon: React.ReactNode }[] = [
  { id: 'orbit', label: '360° orbit', icon: <Orbit size={13} /> },
  { id: 'open', label: 'Open cover', icon: <BookOpen size={13} /> },
  { id: 'page-turn', label: 'Turn pages', icon: <Layers size={13} /> },
  { id: 'showcase', label: 'Showcase', icon: <Sparkles size={13} /> },
];

const SIZES = [
  { id: '1080p', label: '1920 × 1080 (16:9)', w: 1920, h: 1080 },
  { id: '720p', label: '1280 × 720 (16:9)', w: 1280, h: 720 },
  { id: 'square', label: '1080 × 1080 (square)', w: 1080, h: 1080 },
  { id: 'portrait', label: '1080 × 1350 (4:5)', w: 1080, h: 1350 },
  { id: 'story', label: '1080 × 1920 (9:16)', w: 1080, h: 1920 },
  { id: '4k', label: '3840 × 2160 (4K)', w: 3840, h: 2160 },
  { id: 'gif', label: '640 × 480 (GIF-friendly)', w: 640, h: 480 },
];

export default function Viewer3D() {
  const project = useStore((s) => s.project);
  const fontVersion = useFontStore((s) => s.version);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BookScene | null>(null);
  const texRef = useRef<BookTextures | null>(null);
  const [mode, setMode] = useState<AnimationMode>('showcase');
  const [playing, setPlaying] = useState(true);
  const [open, setOpen] = useState(0);
  const [leaf, setLeaf] = useState(0);
  const [bg, setBg] = useState('#d9d4cb');
  const [shadows, setShadows] = useState(true);
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [videoOpen, setVideoOpen] = useState(false);

  const calc = useMemo(() => computeBinding(project.book), [project.book]);
  const infos = useMemo(() => pageInfos(project), [project.pages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount the WebGL scene.
  useEffect(() => {
    const canvas = canvasRef.current!;
    let scene: BookScene;
    try {
      scene = new BookScene(canvas, { background: bg, preserveDrawingBuffer: true });
    } catch (e) {
      setError(`WebGL is not available in this browser (${(e as Error).message}).`);
      return;
    }
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current;
      if (el) scene.resize(el.clientWidth, el.clientHeight, Math.min(2, window.devicePixelRatio || 1));
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => { ro.disconnect(); scene.dispose(); sceneRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Geometry follows the binding spec and page materials.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.setInput({ spec: project.book, calc, pages: infos });
    if (texRef.current) s.setTextures(texRef.current);
    s.setAnimation(mode, { loop: true });
    if (playing) s.play();
  }, [project.book, calc, infos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Textures follow every visual change (debounced).
  useEffect(() => {
    const signal = { cancelled: false };
    setBuilding(true);
    const t = setTimeout(async () => {
      try {
        const tex = await buildBookTextures(project, calc, { signal });
        if (!tex || signal.cancelled) return;
        texRef.current = tex;
        sceneRef.current?.setTextures(tex);
      } catch (e) {
        setError(`Could not render textures: ${(e as Error).message}`);
      } finally {
        if (!signal.cancelled) setBuilding(false);
      }
    }, 350);
    return () => { signal.cancelled = true; clearTimeout(t); };
  }, [project, calc, fontVersion]);

  useEffect(() => { sceneRef.current?.setEnvironment({ background: bg, shadows, showGround: true }); }, [bg, shadows]);

  const startMode = (m: AnimationMode) => {
    setMode(m);
    const s = sceneRef.current;
    if (!s) return;
    s.setAnimation(m, { loop: true, pagesToTurn: 4 });
    s.play();
    setPlaying(true);
  };

  const togglePlay = () => {
    const s = sceneRef.current;
    if (!s) return;
    if (s.isPlaying()) { s.pause(); setPlaying(false); } else { s.play(); setPlaying(true); }
  };

  return (
    <div className="relative flex h-full w-full">
      <div ref={wrapRef} className="relative min-w-0 flex-1" style={{ background: bg }}>
        <canvas ref={canvasRef} className="block h-full w-full" />
        {error && <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-[13px] text-ink-900">{error}</div>}
        {building && !error && <div className="absolute left-3 top-3 rounded bg-black/55 px-2 py-1 text-[11px] text-white">Rendering textures…</div>}
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg bg-black/50 p-1 backdrop-blur">
          <input type="color" title="Background" className="h-6 w-7 cursor-pointer" value={bg} onChange={(e) => setBg(e.target.value)} />
          <button type="button" title="Reset camera" className="rounded p-1.5 text-white/80 hover:bg-white/10" onClick={() => sceneRef.current?.resetCamera()}><RotateCcw size={14} /></button>
          <button type="button" title="Snapshot PNG" className="rounded p-1.5 text-white/80 hover:bg-white/10" onClick={() => {
            const url = sceneRef.current?.snapshot();
            if (url) { const a = document.createElement('a'); a.href = url; a.download = `${safeName(project.book.title)}-3d.png`; a.click(); }
          }}><Camera size={14} /></button>
          <button type="button" title="Export video" className={clsx('rounded p-1.5 hover:bg-white/10', videoOpen ? 'text-rubric' : 'text-white/80')} onClick={() => setVideoOpen(!videoOpen)}><Film size={14} /></button>
        </div>
        <div className="absolute bottom-3 left-1/2 flex w-[min(760px,calc(100%-24px))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl bg-black/55 px-3 py-2 text-white backdrop-blur">
          <button type="button" onClick={togglePlay} className="rounded-full bg-white/15 p-1.5 hover:bg-white/25" title={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          {MODES.map((m) => (
            <button key={m.id} type="button" onClick={() => startMode(m.id)} className={clsx('flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px]', mode === m.id && playing ? 'bg-rubric' : 'bg-white/10 hover:bg-white/20')}>{m.icon}{m.label}</button>
          ))}
          <div className="flex min-w-[220px] flex-1 items-center gap-3">
            <label className="flex flex-1 items-center gap-1.5 text-[10.5px] text-white/70">Cover
              <input type="range" className="w-full" min={0} max={1} step={0.01} value={open} onChange={(e) => {
                const v = parseFloat(e.target.value);
                setOpen(v);
                sceneRef.current?.pause(); setPlaying(false);
                sceneRef.current?.setOpen(v);
              }} />
            </label>
            <label className="flex flex-1 items-center gap-1.5 text-[10.5px] text-white/70">Leaves
              <input type="range" className="w-full" min={0} max={10} step={1} value={leaf} onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setLeaf(v);
                sceneRef.current?.pause(); setPlaying(false);
                if (open < 0.95) { setOpen(1); sceneRef.current?.setOpen(1, true); }
                sceneRef.current?.setLeaf(v, true);
              }} />
            </label>
          </div>
          <Toggle label={<span className="text-white/80">Shadows</span>} checked={shadows} onChange={setShadows} />
        </div>
        {videoOpen && <VideoPanel scene={sceneRef.current} mode={mode} onClose={() => setVideoOpen(false)} wrap={wrapRef.current} title={project.book.title} onDone={() => { const s = sceneRef.current; if (s) { s.setAnimation(mode, { loop: true }); if (playing) s.play(); } }} />}
      </div>
    </div>
  );
}

function VideoPanel({ scene, mode, onClose, wrap, title, onDone }: { scene: BookScene | null; mode: AnimationMode; onClose: () => void; wrap: HTMLDivElement | null; title: string; onDone: () => void }) {
  const [support, setSupport] = useState<VideoSupport | null>(null);
  const [format, setFormat] = useState<VideoFormat>('mp4');
  const [anim, setAnim] = useState<AnimationMode>(mode === 'none' ? 'showcase' : mode);
  const [size, setSize] = useState('1080p');
  const [fps, setFps] = useState(30);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { void getVideoSupport().then((s) => { setSupport(s); if (!s.mp4) setFormat(s.webm ? 'webm' : 'gif'); }); }, []);
  useEffect(() => {
    if (!scene) return;
    scene.setAnimation(anim, { loop: false, pagesToTurn: 4 });
    setDuration(+scene.getAnimationDuration().toFixed(1));
  }, [scene, anim]);
  useEffect(() => { if (format === 'gif') { setFps(15); if (size === '1080p' || size === '4k') setSize('gif'); } }, [format]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!scene) return;
    const dims = SIZES.find((s) => s.id === size)!;
    abort.current = new AbortController();
    setProgress(0);
    scene.pause();
    scene.setAnimation(anim, { loop: false, pagesToTurn: 4, duration: duration || undefined });
    try {
      const blob = await exportVideo(scene, { format, width: dims.w, height: dims.h, fps, duration: duration || scene.getAnimationDuration(), onProgress: setProgress, signal: abort.current.signal });
      downloadBlob(blob, `${safeName(title)}-${anim}.${format}`);
      useStore.getState().notify(`${format.toUpperCase()} exported (${(blob.size / 1e6).toFixed(1)} MB).`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') useStore.getState().notify(`Video export failed: ${(e as Error).message}`, 'error');
    } finally {
      setProgress(null);
      if (wrap) scene.resize(wrap.clientWidth, wrap.clientHeight, Math.min(2, window.devicePixelRatio || 1));
      onDone();
    }
  };

  return (
    <div className="absolute right-3 top-14 w-72 space-y-2.5 rounded-xl border border-ink-600 bg-ink-850/95 p-3 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-ink-100">Motion export</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-ink-400 hover:text-ink-100"><X size={14} /></button>
      </div>
      <Select<VideoFormat> label="Format" value={format} options={[
        { value: 'mp4', label: `MP4 · H.264${support && !support.mp4 ? ' (unsupported here)' : support?.mp4Method === 'mediarecorder' ? ' (real-time)' : ''}` },
        { value: 'webm', label: `WebM · VP9${support && !support.webm ? ' (unsupported here)' : support?.webmMethod === 'mediarecorder' ? ' (real-time)' : ''}` },
        { value: 'gif', label: 'GIF · animated' },
      ]} onChange={setFormat} />
      <Select<AnimationMode> label="Animation" value={anim} options={MODES.map((m) => ({ value: m.id, label: m.label }))} onChange={setAnim} />
      <Select label="Size" value={size} options={SIZES.map((s) => ({ value: s.id, label: s.label }))} onChange={setSize} />
      <Select label="Frame rate" value={String(fps)} options={(format === 'gif' ? [10, 12, 15, 20] : [24, 25, 30, 60]).map((f) => ({ value: String(f), label: `${f} fps` }))} onChange={(v) => setFps(Number(v))} />
      <Slider label="Duration" value={duration} min={2} max={30} step={0.5} onChange={setDuration} format={(v) => `${v.toFixed(1)} s`} />
      {progress != null ? (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded bg-ink-700"><div className="h-full bg-rubric" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          <div className="flex items-center justify-between text-[11px] text-ink-300">Encoding… {Math.round(progress * 100)}%<Button variant="ghost" onClick={() => abort.current?.abort()}>Cancel</Button></div>
        </div>
      ) : (
        <Button variant="primary" className="w-full" disabled={!scene || (format === 'mp4' && support != null && !support.mp4) || (format === 'webm' && support != null && !support.webm)} onClick={run}><Film size={13} /> Render {format.toUpperCase()}</Button>
      )}
      <p className="text-[10.5px] leading-snug text-ink-400">Frames are rendered one by one at full quality, then encoded in your browser — nothing is uploaded.</p>
    </div>
  );
}
