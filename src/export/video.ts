/**
 * Motion export of the 3D book: MP4 (H.264), WebM (VP9/VP8) and animated GIF.
 *
 * Preferred path is frame-exact offline rendering: every frame is posed with
 * `scene.renderFrame(i / fps, w, h)` and fed to a WebCodecs VideoEncoder, then muxed with
 * mp4-muxer / webm-muxer. Without WebCodecs (or without a supported codec) it falls back to
 * MediaRecorder on `canvas.captureStream()`, driven in real time at the fps cadence.
 *
 * The scene canvas is resized to the export size while rendering; when the export ends
 * (or fails / is aborted) `scene.resize()` restores the size the canvas had on screen.
 * Callers that manage the canvas size themselves may call `scene.resize()` again.
 */
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type { BookScene } from '../three';

export type VideoFormat = 'mp4' | 'webm' | 'gif';

export interface VideoOptions {
  format: VideoFormat;
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  /** Bits per second (MP4/WebM). Defaults to ~0.15 bit per pixel per frame. */
  bitrate?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface VideoSupport {
  mp4: boolean;
  webm: boolean;
  gif: true;
  mp4Method: 'webcodecs' | 'mediarecorder' | null;
  webmMethod: 'webcodecs' | 'mediarecorder' | null;
}

const AVC_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
/** Level 5.1/5.2 profiles for frames larger than 1080p. */
const AVC_LARGE = ['avc1.640033', 'avc1.640034', 'avc1.4d0033'];
const WEBM_CODECS = ['vp09.00.10.08', 'vp8'];
const MP4_MIME = ['video/mp4;codecs=avc1', 'video/mp4;codecs="avc1.42E01E"', 'video/mp4'];
const WEBM_MIME = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
/** GIFs are capped to this longest side and frame rate to keep files reasonable. */
const GIF_MAX_SIDE = 800;
const GIF_MAX_FPS = 30;
const GIF_MAX_FRAMES = 900;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function abortError(): DOMException {
  return new DOMException('Video export aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function hasWebCodecs(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function canCaptureCanvas(): boolean {
  return typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && typeof MediaRecorder !== 'undefined';
}

function pickMime(list: string[]): string | null {
  if (!canCaptureCanvas() || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

async function findEncoderConfig(codecs: string[], width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig | null> {
  if (!hasWebCodecs()) return null;
  for (const codec of codecs) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps };
    if (codec.startsWith('avc1')) config.avc = { format: 'avc' };
    try {
      const res = await VideoEncoder.isConfigSupported(config);
      if (res.supported) return config;
    } catch {
      // Malformed or unknown codec string in this browser — try the next one.
    }
  }
  return null;
}

function codecList(format: 'mp4' | 'webm', width: number, height: number): string[] {
  if (format === 'webm') return WEBM_CODECS;
  return width * height > 1920 * 1088 ? [...AVC_LARGE, ...AVC_CODECS] : AVC_CODECS;
}

export async function getVideoSupport(): Promise<VideoSupport> {
  const [mp4wc, webmwc] = await Promise.all([
    findEncoderConfig(AVC_CODECS, 1280, 720, 30, 5e6).then((c) => c !== null),
    findEncoderConfig(WEBM_CODECS, 1280, 720, 30, 5e6).then((c) => c !== null),
  ]);
  const mp4mr = pickMime(MP4_MIME) !== null;
  const webmmr = pickMime(WEBM_MIME) !== null;
  return {
    mp4: mp4wc || mp4mr,
    webm: webmwc || webmmr,
    gif: true,
    mp4Method: mp4wc ? 'webcodecs' : mp4mr ? 'mediarecorder' : null,
    webmMethod: webmwc ? 'webcodecs' : webmmr ? 'mediarecorder' : null,
  };
}

interface Job {
  scene: BookScene;
  width: number;
  height: number;
  fps: number;
  frames: number;
  bitrate: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

interface ChunkSink {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void;
  finalize(): void;
}

function waitForDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      encoder.removeEventListener('dequeue', finish);
      resolve();
    };
    encoder.addEventListener('dequeue', finish);
    setTimeout(finish, 20);
  });
}

/** Frame-exact WebCodecs encode. Resolves null when no codec configuration is supported. */
async function encodeWebCodecs(format: 'mp4' | 'webm', job: Job): Promise<Blob | null> {
  const { scene, width: w, height: h, fps, frames, bitrate, onProgress, signal } = job;
  const config = await findEncoderConfig(codecList(format, w, h), w, h, fps, bitrate);
  if (!config) return null;
  throwIfAborted(signal);

  let sink: ChunkSink;
  let output: () => ArrayBuffer;
  if (format === 'mp4') {
    const target = new Mp4Target();
    sink = new Mp4Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    output = () => target.buffer;
  } else {
    const target = new WebmTarget();
    const codec = config.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8';
    sink = new WebmMuxer({ target, video: { codec, width: w, height: h, frameRate: fps }, firstTimestampBehavior: 'offset' });
    output = () => target.buffer;
  }

  const state: { error: Error | null } = { error: null };
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        sink.addVideoChunk(chunk, meta);
      } catch (e) {
        state.error = e instanceof Error ? e : new Error(String(e));
      }
    },
    error: (e) => {
      state.error = e;
    },
  });
  encoder.configure(config);
  const keyEvery = Math.max(1, Math.round(fps * 2));
  const frameUs = 1e6 / fps;
  try {
    for (let i = 0; i < frames; i++) {
      throwIfAborted(signal);
      if (state.error) throw state.error;
      const canvas = scene.renderFrame(i / fps, w, h);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      try {
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      } finally {
        frame.close();
      }
      while (encoder.encodeQueueSize > 4) {
        await waitForDequeue(encoder);
        throwIfAborted(signal);
      }
      if (i % 3 === 2) await yieldToUI();
      onProgress?.(((i + 1) / frames) * 0.97);
    }
    await encoder.flush();
    if (state.error) throw state.error;
    sink.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  onProgress?.(1);
  return new Blob([output()], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' });
}

/** Real-time MediaRecorder capture of the canvas. Resolves null when unsupported. */
async function encodeMediaRecorder(format: 'mp4' | 'webm', job: Job): Promise<Blob | null> {
  const mime = pickMime(format === 'mp4' ? MP4_MIME : WEBM_MIME);
  if (!mime) return null;
  const { scene, width: w, height: h, fps, frames, bitrate, onProgress, signal } = job;
  const canvas = scene.renderFrame(0, w, h);
  // captureStream(0) + requestFrame() hands the recorder exactly the frames we render.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const manual = !!track && typeof track.requestFrame === 'function';
  let recStream = stream;
  if (!manual) {
    for (const t of stream.getTracks()) t.stop();
    recStream = canvas.captureStream(fps);
  }
  const recorder = new MediaRecorder(recStream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('MediaRecorder failed'));
  });
  recorder.start(250);
  const frameMs = 1000 / fps;
  const t0 = performance.now();
  try {
    for (let i = 0; i < frames; i++) {
      throwIfAborted(signal);
      scene.renderFrame(i / fps, w, h);
      if (manual) track!.requestFrame();
      const wait = t0 + (i + 1) * frameMs - performance.now();
      if (wait > 0) await sleep(wait);
      onProgress?.(((i + 1) / frames) * 0.97);
    }
    await sleep(frameMs * 2);
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    for (const t of recStream.getTracks()) t.stop();
  }
  await stopped;
  onProgress?.(1);
  return new Blob(chunks, { type: mime.split(';')[0] });
}

/** Animated GIF with one palette shared by all frames (no colour flicker between frames). */
async function encodeGif(job: Job): Promise<Blob> {
  const { scene, fps, onProgress, signal } = job;
  const scale = Math.min(1, GIF_MAX_SIDE / Math.max(job.width, job.height));
  const w = Math.max(2, Math.round(job.width * scale));
  const h = Math.max(2, Math.round(job.height * scale));
  const frames = Math.min(GIF_MAX_FRAMES, job.frames);
  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const grab = (i: number): Uint8ClampedArray => {
    const src = scene.renderFrame(i / fps, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };

  // Palette from frames sampled across the whole animation.
  const samples = Math.min(8, frames);
  const stride = 2;
  const perSample = Math.ceil((w * h) / stride);
  const pool = new Uint8ClampedArray(perSample * samples * 4);
  for (let s = 0; s < samples; s++) {
    throwIfAborted(signal);
    const idx = samples === 1 ? 0 : Math.round((s * (frames - 1)) / (samples - 1));
    const data = grab(idx);
    let o = s * perSample * 4;
    for (let p = 0; p < w * h; p += stride, o += 4) {
      pool[o] = data[4 * p];
      pool[o + 1] = data[4 * p + 1];
      pool[o + 2] = data[4 * p + 2];
      pool[o + 3] = 255;
    }
    onProgress?.((s + 1) / samples * 0.08);
    await yieldToUI();
  }
  const palette = quantize(pool, 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  for (let i = 0; i < frames; i++) {
    throwIfAborted(signal);
    const data = grab(i);
    const index = applyPalette(data, palette, 'rgb565');
    gif.writeFrame(index, w, h, { palette: i === 0 ? palette : undefined, delay, repeat: 0 });
    onProgress?.(0.08 + ((i + 1) / frames) * 0.9);
    await yieldToUI();
  }
  gif.finish();
  onProgress?.(1);
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export async function exportVideo(scene: BookScene, opts: VideoOptions): Promise<Blob> {
  const { signal } = opts;
  throwIfAborted(signal);
  const canvas = scene.canvas;
  const restoreW = canvas.clientWidth || canvas.width;
  const restoreH = canvas.clientHeight || canvas.height;
  const restorePR = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  const wasPlaying = scene.isPlaying();
  scene.pause();

  const gif = opts.format === 'gif';
  const fps = Math.max(1, Math.min(gif ? GIF_MAX_FPS : 120, opts.fps || 30));
  const duration = Math.max(1 / fps, opts.duration || 0);
  const width = even(opts.width || 1280);
  const height = even(opts.height || 720);
  const frames = Math.max(1, Math.round(duration * fps));
  const bitrate = Math.round(opts.bitrate ?? Math.min(40e6, Math.max(2e6, width * height * fps * 0.15)));
  const job: Job = { scene, width, height, fps, frames, bitrate, onProgress: opts.onProgress, signal };

  try {
    const format = opts.format;
    if (format === 'gif') return await encodeGif(job);
    const viaCodecs = await encodeWebCodecs(format, job);
    if (viaCodecs) return viaCodecs;
    const viaRecorder = await encodeMediaRecorder(format, job);
    if (viaRecorder) return viaRecorder;
    throw new Error(`${format.toUpperCase()} video export is not supported in this browser.`);
  } finally {
    scene.resize(restoreW, restoreH, restorePR);
    if (wasPlaying) scene.play();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
