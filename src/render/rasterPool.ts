/**
 * A small pool of raster workers (rasterWorker.ts). Jobs are queued by priority; a cancelled job
 * leaves the queue, or has its result discarded (its bitmaps closed) when it is already drawing.
 * `rasterPool()` is null where workers or OffscreenCanvas are missing: callers draw on the main
 * thread instead.
 */
import type { PanelBitmaps, PanelJob, RasterRequest, RasterResponse, StitchJob, WireList } from './rasterOps';

type Request = RasterRequest extends infer R ? (R extends RasterRequest ? Omit<R, 'id'> : never) : never;

export interface RasterJobOptions {
  signal?: AbortSignal;
  /** Higher runs first (default 0). */
  priority?: number;
}

export function abortError(): Error {
  const e = new Error('Raster job cancelled');
  e.name = 'AbortError';
  return e;
}

export const isAbort = (e: unknown): boolean => (e as Error)?.name === 'AbortError';

interface Pending {
  req: Request;
  priority: number;
  seq: number;
  resolve: (r: RasterResponse & { ok: true }) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  cancelled: boolean;
  detach?: () => void;
}

interface Slot {
  worker: Worker;
  job: Pending | null;
  id: number;
}

/** Bitmaps of a response (to close when nobody wants them). */
function closeResponse(r: RasterResponse): void {
  if (!r.ok) return;
  r.bmp?.close();
  if (r.maps) for (const b of [r.maps.color, r.maps.surface, r.maps.bump, r.maps.holo]) b?.close();
}

/** What a request hands over to the worker (lists are copied: bands of a panel share them). */
function transferables(req: Request): Transferable[] {
  if (req.kind !== 'stitch') return [];
  return req.parts.flatMap((p) => [p.color, p.surface, p.bump, p.holo].filter((b): b is ImageBitmap => !!b));
}

export class RasterPool {
  readonly size: number;
  private slots: Slot[] = [];
  private queue: Pending[] = [];
  private seq = 0;
  private nextId = 1;
  /** Jobs finished / failed, and worker time (ms), for diagnostics. */
  readonly stats = { done: 0, failed: 0, cancelled: 0, ms: 0 };

  constructor(size: number) {
    this.size = Math.max(1, size);
  }

  /** Rasterise a lowered display list; resolves with an ImageBitmap (top row first). */
  async surface(list: WireList, o: RasterJobOptions & { mask?: boolean } = {}): Promise<ImageBitmap> {
    const r = await this.submit({ kind: 'surface', list, mask: o.mask }, o);
    return r.bmp!;
  }

  /** Rasterise and finish a cover / jacket panel (or a band of one). */
  async panel(job: PanelJob, o: RasterJobOptions = {}): Promise<PanelBitmaps> {
    const r = await this.submit({ kind: 'panel', ...job }, o);
    return r.maps!;
  }

  /** Join the bands of a panel (takes over their bitmaps). */
  async stitch(job: StitchJob, o: RasterJobOptions = {}): Promise<PanelBitmaps> {
    const r = await this.submit({ kind: 'stitch', ...job }, o);
    return r.maps!;
  }

  /** Jobs waiting or drawing. */
  get busy(): number {
    return this.queue.length + this.slots.filter((s) => s.job).length;
  }

  private errors = 0;

  /** Give up on workers: pending jobs fail (callers draw on the main thread) and no new ones start. */
  private disable(): void {
    if (pool === this) pool = null;
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) {
      p.detach?.();
      p.reject(new Error('Raster workers unavailable'));
    }
  }

  dispose(): void {
    for (const p of this.queue) p.reject(abortError());
    this.queue = [];
    for (const s of this.slots) {
      s.job?.reject(abortError());
      s.worker.terminate();
    }
    this.slots = [];
  }

  private submit(req: Request, o: RasterJobOptions): Promise<RasterResponse & { ok: true }> {
    return new Promise((resolve, reject) => {
      if (o.signal?.aborted) {
        reject(abortError());
        return;
      }
      const p: Pending = { req, priority: o.priority ?? 0, seq: this.seq++, resolve, reject, signal: o.signal, cancelled: false };
      if (o.signal) {
        const onAbort = () => this.cancel(p);
        o.signal.addEventListener('abort', onAbort);
        p.detach = () => o.signal!.removeEventListener('abort', onAbort);
      }
      this.queue.push(p);
      this.pump();
    });
  }

  private cancel(p: Pending): void {
    if (p.cancelled) return;
    p.cancelled = true;
    this.stats.cancelled++;
    const i = this.queue.indexOf(p);
    if (i >= 0) {
      this.queue.splice(i, 1);
      // Bitmaps it would have handed over are still ours.
      for (const t of transferables(p.req)) (t as ImageBitmap).close();
    } else {
      // Drawing already. A big panel is not worth finishing: stop its worker (a new one starts).
      const slot = this.slots.find((s) => s.job === p);
      if (slot && p.req.kind === 'panel') this.retire(slot);
    }
    p.detach?.();
    p.reject(abortError());
  }

  private retire(slot: Slot): void {
    slot.worker.terminate();
    this.slots.splice(this.slots.indexOf(slot), 1);
    const p = slot.job;
    slot.job = null;
    if (p && !p.cancelled) {
      p.detach?.();
      p.reject(new Error('Raster worker stopped'));
    }
    this.pump();
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('./rasterWorker.ts', import.meta.url), { type: 'module', name: 'raster' });
    const slot: Slot = { worker, job: null, id: 0 };
    worker.onmessage = (e: MessageEvent<RasterResponse>) => {
      const r = e.data;
      const p = slot.job;
      if (!p || r.id !== slot.id) {
        closeResponse(r);
        return;
      }
      slot.job = null;
      p.detach?.();
      if (p.cancelled) closeResponse(r);
      else if (r.ok) {
        this.stats.done++;
        this.stats.ms += r.ms;
        p.resolve(r);
      } else {
        this.stats.failed++;
        p.reject(new Error(r.error));
      }
      this.pump();
    };
    worker.onerror = (e) => {
      e.preventDefault();
      this.stats.failed++;
      // Workers that keep failing (cannot load, out of memory): stop using the pool.
      if (++this.errors >= 3) this.disable();
      this.retire(slot);
    };
    this.slots.push(slot);
    return slot;
  }

  private pump(): void {
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        slot = this.spawn();
      }
      // Highest priority first, then oldest.
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i], b = this.queue[best];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const p = this.queue.splice(best, 1)[0];
      slot.job = p;
      slot.id = this.nextId++;
      try {
        slot.worker.postMessage({ ...p.req, id: slot.id }, transferables(p.req));
      } catch (e) {
        slot.job = null;
        p.detach?.();
        for (const t of transferables(p.req)) (t as ImageBitmap).close();
        p.reject(e as Error);
      }
    }
  }
}

let pool: RasterPool | null | undefined;

/** The shared pool (one worker per spare core, up to 4), or null when workers cannot rasterise. */
export function rasterPool(): RasterPool | null {
  if (pool !== undefined) return pool;
  const ok = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined'
    && typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function';
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  pool = ok ? new RasterPool(Math.min(4, Math.max(1, cores - 1))) : null;
  return pool;
}
