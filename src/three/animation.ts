/**
 * Animation timelines. Every sample is a pure function of (mode, options, t), so a video
 * export can render any frame independently and land on exactly the same pose.
 */
import type { AnimationMode, AnimationOptions } from './types';

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeInOutCubic = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Camera elevation (radians) for a standing book, a closed book lying down, and an open spread. */
export const EL_STAND = 0.2;
export const EL_LIE = 0.72;
export const EL_OPEN = 0.98;
/** Stage of a book propped at an angle (0 = upright, 1 = lying): leans back ~20°. */
export const STAGE_ANGLED = 0.22;

export interface CameraKey {
  /** Azimuth offset from the default 3/4 view, radians (mirrored for right-to-left books). */
  az: number;
  /** Absolute elevation, radians. */
  el: number;
  /** Distance multiplier on the automatic framing. */
  zoom: number;
  /** Frame for every azimuth (turntables), so the distance doesn't breathe while orbiting. */
  stable?: boolean;
  /** Target offset as a fraction of the framed bounds (world x, y, z; x mirrored for RTL). */
  pan?: [number, number, number];
  /** Extra height (pt) above the book kept in frame: lifts, drops, a jacket sliding off. */
  headroom?: number;
}

export interface TimelineSample {
  /** Front cover opening, eased 0…1. */
  open: number;
  /** Turn of each modelled leaf, eased 0…1. */
  leaves: number[];
  /** 0 = book standing upright, 1 = lying on its back cover. */
  stage: number;
  cam: CameraKey | null;
  /** Rigid motion of the whole book about its centre: lift (pt), spin about the vertical (rad), tilt (rad). */
  lift?: number;
  spin?: number;
  tilt?: number;
  /** Dust jacket slid off, 0…1. */
  jacket?: number;
}

export interface StaticPose {
  open: number;
  /** Leaves turned (fractional = mid-turn). */
  leaf: number;
  stage: number;
}

/** Book facts a timeline may depend on. */
export interface TimelineBook {
  nTurn: number;
  /** Cover height, pt (drop / float heights scale with the book). */
  height: number;
}

/** Leaves turned, with each leaf eased individually. */
export function leafTurns(leafPos: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(easeInOutCubic(leafPos - k));
  return out;
}

/** Keyframed value: holds before the first / after the last key, eases between keys. */
function track(t: number, keys: [number, number][], ease: (x: number) => number = easeInOutCubic): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return t1 > t0 ? lerp(v0, v1, ease((t - t0) / (t1 - t0))) : v1;
    }
  }
  return keys[keys.length - 1][1];
}

export const elevationFor = (stage: number, open: number) => lerp(EL_STAND, EL_LIE, clamp01(stage)) + (EL_OPEN - EL_LIE) * clamp01(open);

interface Plan {
  length: number;
  sample(t: number, base: StaticPose): TimelineSample;
}

const LEAF_TURN = 1.4;
const LEAF_STAGGER = 0.85;
const TAU = Math.PI * 2;

function turnLeaves(t: number, start: number, count: number, nTurn: number, stagger = LEAF_STAGGER, dur = LEAF_TURN): number[] {
  const out: number[] = [];
  for (let k = 0; k < nTurn; k++) out.push(k < count ? easeInOutCubic((t - start - k * stagger) / dur) : 0);
  return out;
}

const closed = (n: number) => new Array<number>(n).fill(0);

function plan(mode: AnimationMode, opts: AnimationOptions, book: TimelineBook): Plan {
  const nTurn = book.nTurn;
  switch (mode) {
    case 'orbit': {
      const length = 12;
      return {
        length,
        sample: (t, base) => ({
          open: base.open,
          leaves: leafTurns(base.leaf, nTurn),
          stage: base.stage,
          cam: { az: (TAU * t) / length, el: elevationFor(base.stage, base.open), zoom: 1, stable: true },
        }),
      };
    }
    case 'open': {
      const length = 6;
      return {
        length,
        sample: (t) => {
          const open = track(t, [[0.5, 0], [2.5, 1], [3.7, 1], [5.5, 0]]);
          return {
            open,
            leaves: closed(nTurn),
            stage: 1,
            cam: { az: -0.18 + (0.36 * (1 - Math.cos((TAU * t) / length))) / 2, el: elevationFor(1, open), zoom: 1 },
          };
        },
      };
    }
    case 'page-turn': {
      const count = nTurn > 0 ? Math.max(1, Math.min(nTurn, Math.round(opts.pagesToTurn ?? 3))) : 0;
      const turnStart = 2.3;
      const turnEnd = count > 0 ? turnStart + (count - 1) * LEAF_STAGGER + LEAF_TURN : turnStart;
      const close0 = turnEnd + 1.1;
      const close1 = close0 + 1.8;
      const length = close1 + 0.5;
      return {
        length,
        sample: (t) => {
          const open = track(t, [[0.4, 0], [2.0, 1], [close0, 1], [close1, 0]]);
          return {
            open,
            leaves: turnLeaves(t, turnStart, count, nTurn),
            stage: 1,
            cam: { az: -0.12 * open, el: elevationFor(1, open), zoom: 1 },
          };
        },
      };
    }
    case 'showcase': {
      const count = Math.min(nTurn, 3);
      const orbit1 = 4.5;
      const lie1 = orbit1 + 1.1;
      const open0 = lie1 + 0.2, open1 = open0 + 1.6;
      const turnStart = open1 + 0.3;
      const turnEnd = count > 0 ? turnStart + (count - 1) * LEAF_STAGGER + LEAF_TURN : turnStart;
      const close0 = turnEnd + 0.9, close1 = close0 + 1.7;
      const stand0 = close1 + 0.1, stand1 = stand0 + 1.1;
      const orbit2 = stand1 + 4.5;
      const length = orbit2 + 0.3;
      return {
        length,
        sample: (t) => {
          const stage = track(t, [[orbit1, 0], [lie1, 1], [stand0, 1], [stand1, 0]]);
          const open = track(t, [[open0, 0], [open1, 1], [close0, 1], [close1, 0]]);
          const az = track(t, [[0, -Math.PI], [orbit1, 0], [stand1, 0], [orbit2, Math.PI]], easeInOutSine);
          return {
            open,
            leaves: turnLeaves(t, turnStart, count, nTurn),
            stage,
            cam: { az, el: elevationFor(stage, open), zoom: 1, stable: true },
          };
        },
      };
    }
    case 'flip-through': {
      // Riffle: the leaves fly over in quick succession, then fan back.
      const n = nTurn;
      const stagger = 0.11, dur = 0.6;
      const out0 = 1.6;
      const outEnd = out0 + Math.max(0, n - 1) * stagger + dur;
      const back0 = outEnd + 0.7;
      const backEnd = back0 + Math.max(0, n - 1) * stagger + dur;
      const close0 = backEnd + 0.3, close1 = close0 + 1.3;
      const length = close1 + 0.4;
      return {
        length,
        sample: (t) => {
          const open = track(t, [[0.3, 0], [1.4, 1], [close0, 1], [close1, 0]]);
          const leaves: number[] = [];
          for (let k = 0; k < n; k++) {
            const go = easeInOutCubic((t - out0 - k * stagger) / dur);
            const ret = easeInOutCubic((t - back0 - (n - 1 - k) * stagger) / dur);
            leaves.push(clamp01(go - ret));
          }
          return { open, leaves, stage: 1, cam: { az: 0.05, el: 0.62 + 0.18 * open, zoom: 0.92 } };
        },
      };
    }
    case 'spine-reveal': {
      const length = 8.5;
      return {
        length,
        sample: (t) => {
          // From spine-on (absolute −90°, i.e. +0.55 − π/2 from the 3/4 view) round to the front.
          const spineOn = 0.55 - Math.PI / 2;
          const az = track(t, [[0.6, spineOn], [4.6, 0.3], [6.0, 0.3], [8.3, spineOn]]);
          return { open: 0, leaves: closed(nTurn), stage: 0, cam: { az, el: 0.12, zoom: 0.95 } };
        },
      };
    }
    case 'float': {
      const length = 10;
      return {
        length,
        sample: (t) => {
          const up = track(t, [[0, 0], [1.6, 1], [8.4, 1], [10, 0]]);
          const lift = book.height * (0.16 * up + 0.025 * up * Math.sin((TAU * 2 * t) / length));
          const spin = track(t, [[0.8, 0], [9.2, TAU]], easeInOutSine);
          const tilt = 0.05 * up * Math.sin((TAU * t) / length);
          return { open: 0, leaves: closed(nTurn), stage: 0, lift, spin, tilt, cam: { az: 0.2, el: 0.14, zoom: 1, headroom: book.height * 0.19 } };
        },
      };
    }
    case 'push-in': {
      const length = 7.5;
      return {
        length,
        sample: (t) => {
          const p = track(t, [[0.3, 0], [5.3, 1], [6.1, 1], [7.4, 0]]);
          return { open: 0, leaves: closed(nTurn), stage: 0, cam: { az: lerp(-0.05, 0.42, p), el: lerp(0.2, 0.08, p), zoom: lerp(1.2, 0.5, p), pan: [0.06 * p, 0.04 * p, 0] } };
        },
      };
    }
    case 'turntable-flat': {
      const length = 12;
      return {
        length,
        sample: (t) => ({ open: 0, leaves: closed(nTurn), stage: 1, cam: { az: (TAU * t) / length, el: 0.78, zoom: 1, stable: true } }),
      };
    }
    case 'read-spread': {
      const length = 9;
      return {
        length,
        sample: (t) => {
          const ph = (TAU * t) / length;
          const leaves = closed(nTurn);
          if (nTurn > 0) leaves[0] = 1;
          return { open: 1, leaves, stage: 1, cam: { az: 0.19 + 0.08 * Math.sin(ph), el: 1.02 + 0.06 * Math.cos(ph), zoom: 0.62, pan: [-0.22 * Math.cos(ph), 0, 0.07 * Math.sin(ph)] } };
        },
      };
    }
    case 'drop-in': {
      const length = 5;
      return {
        length,
        sample: (t) => {
          const h0 = book.height * 0.55;
          const g = (2 * h0) / (0.6 * 0.6); // reach the table at t = 0.9 s after 0.3 s hold
          let lift = 0;
          let wobble = 0;
          const tf = t - 0.3;
          if (tf < 0) lift = h0;
          else if (tf < 0.6) lift = h0 - 0.5 * g * tf * tf;
          else {
            // Two damped bounces, then settle.
            const v0 = g * 0.6;
            const bounces = [0.22, 0.06];
            let tb = tf - 0.6;
            lift = 0;
            for (const e of bounces) {
              const v = v0 * Math.sqrt(e);
              const span = (2 * v) / g;
              if (tb < span) { lift = v * tb - 0.5 * g * tb * tb; break; }
              tb -= span;
            }
            wobble = 0.035 * Math.exp(-4 * (tf - 0.6)) * Math.sin(18 * (tf - 0.6));
          }
          const air = clamp01(lift / h0);
          return {
            open: 0, leaves: closed(nTurn), stage: 1,
            lift: Math.max(0, lift),
            tilt: 0.22 * air + wobble,
            spin: -0.35 * air,
            cam: { az: 0.1, el: 0.5, zoom: 1, headroom: book.height * 0.62 },
          };
        },
      };
    }
    case 'jacket-off': {
      const length = 8;
      return {
        length,
        sample: (t) => {
          const jacket = track(t, [[1.0, 0], [3.3, 1], [5.2, 1], [7.4, 0]]);
          return { open: 0, leaves: closed(nTurn), stage: 0, jacket, cam: { az: lerp(-0.15, 0.2, easeInOutSine(t / length)), el: 0.16, zoom: 1, headroom: book.height * 0.85 } };
        },
      };
    }
    case 'cover-close-up': {
      const length = 9;
      return {
        length,
        sample: (t) => {
          const p = (1 - Math.cos((TAU * t) / length)) / 2;
          return { open: 0, leaves: closed(nTurn), stage: 0, cam: { az: lerp(-0.25, 0.85, p), el: lerp(0.24, 0.06, p), zoom: 0.42, pan: [lerp(-0.1, 0.16, p), lerp(0.16, -0.12, p), 0] } };
        },
      };
    }
    default:
      return {
        length: 0,
        sample: (_t, base) => ({ open: base.open, leaves: leafTurns(base.leaf, nTurn), stage: base.stage, cam: null }),
      };
  }
}

export const ANIMATION_INFO: { id: Exclude<AnimationMode, 'none'>; label: string; description: string }[] = [
  { id: 'orbit', label: '360° orbit', description: 'Turntable: the camera circles the book in its resting pose.' },
  { id: 'open', label: 'Open cover', description: 'The book lies down, the front cover swings open and closes again.' },
  { id: 'page-turn', label: 'Turn pages', description: 'Open the cover, then turn leaves one after another (pagesToTurn).' },
  { id: 'showcase', label: 'Showcase', description: 'Half orbit from the back cover, lie down, open, turn pages, close, stand up.' },
  { id: 'flip-through', label: 'Flip through', description: 'A fast riffle: every modelled leaf flies over, then fans back.' },
  { id: 'spine-reveal', label: 'Spine reveal', description: 'Starts spine-on and swings round to the front cover.' },
  { id: 'float', label: 'Float', description: 'The book levitates and makes a slow hero turn above its shadow.' },
  { id: 'push-in', label: 'Push in', description: 'A slow dolly toward the front cover.' },
  { id: 'turntable-flat', label: 'Flat turntable', description: 'The closed book lying on the table, camera circling above.' },
  { id: 'read-spread', label: 'Read the spread', description: 'The camera glides over the open spread, page to page.' },
  { id: 'drop-in', label: 'Drop in', description: 'The book drops onto the table, bounces and settles.' },
  { id: 'jacket-off', label: 'Jacket off', description: 'The dust jacket slides off over the head and back on (needs a jacket).' },
  { id: 'cover-close-up', label: 'Cover close-up', description: 'A raking macro glide across the cover: foils, deboss, cloth.' },
];

/** Seconds for one pass of the animation (opts.duration rescales the whole timeline). */
export function animationDuration(mode: AnimationMode, opts: AnimationOptions, book: TimelineBook): number {
  if (mode === 'none') return 0;
  const p = plan(mode, opts, book);
  return opts.duration && opts.duration > 0 ? opts.duration : p.length;
}

/** Pose at time t (seconds). Loops when opts.loop !== false, otherwise clamps to the end. */
export function sampleTimeline(mode: AnimationMode, opts: AnimationOptions, t: number, book: TimelineBook, base: StaticPose): TimelineSample {
  const p = plan(mode, opts, book);
  if (mode === 'none' || p.length <= 0) return p.sample(0, base);
  const duration = animationDuration(mode, opts, book);
  let local = Number.isFinite(t) ? t : 0;
  if (opts.loop === false) local = Math.max(0, Math.min(duration, local));
  else local = ((local % duration) + duration) % duration;
  return p.sample((local / duration) * p.length, base);
}
