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
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Camera elevation (radians) for a standing book, a closed book lying down, and an open spread. */
export const EL_STAND = 0.2;
export const EL_LIE = 0.72;
export const EL_OPEN = 0.98;

export interface CameraKey {
  /** Azimuth offset from the default 3/4 view, radians. */
  az: number;
  /** Absolute elevation, radians. */
  el: number;
  /** Distance multiplier on the automatic framing. */
  zoom: number;
  /** Frame for every azimuth (turntables), so the distance doesn't breathe while orbiting. */
  stable?: boolean;
}

export interface TimelineSample {
  /** Front cover opening, eased 0…1. */
  open: number;
  /** Turn of each modelled leaf, eased 0…1. */
  leaves: number[];
  /** 0 = book standing upright, 1 = lying on its back cover. */
  stage: number;
  cam: CameraKey | null;
}

export interface StaticPose {
  open: number;
  /** Leaves turned (fractional = mid-turn). */
  leaf: number;
  stage: number;
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
  sample(t: number, nTurn: number, base: StaticPose): TimelineSample;
}

const LEAF_TURN = 1.4;
const LEAF_STAGGER = 0.85;

function turnLeaves(t: number, start: number, count: number, nTurn: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < nTurn; k++) out.push(k < count ? easeInOutCubic((t - start - k * LEAF_STAGGER) / LEAF_TURN) : 0);
  return out;
}

function plan(mode: AnimationMode, opts: AnimationOptions, nTurn: number): Plan {
  switch (mode) {
    case 'orbit': {
      const length = 12;
      return {
        length,
        sample: (t, n, base) => ({
          open: base.open,
          leaves: leafTurns(base.leaf, n),
          stage: base.stage,
          cam: { az: (2 * Math.PI * t) / length, el: elevationFor(base.stage, base.open), zoom: 1, stable: true },
        }),
      };
    }
    case 'open': {
      const length = 6;
      return {
        length,
        sample: (t, n) => {
          const open = track(t, [[0.5, 0], [2.5, 1], [3.7, 1], [5.5, 0]]);
          return {
            open,
            leaves: new Array<number>(n).fill(0),
            stage: 1,
            cam: { az: -0.18 + 0.36 * (1 - Math.cos((2 * Math.PI * t) / length)) / 2, el: elevationFor(1, open), zoom: 1 },
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
        sample: (t, n) => {
          const open = track(t, [[0.4, 0], [2.0, 1], [close0, 1], [close1, 0]]);
          return {
            open,
            leaves: turnLeaves(t, turnStart, count, n),
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
        sample: (t, n) => {
          const stage = track(t, [[orbit1, 0], [lie1, 1], [stand0, 1], [stand1, 0]]);
          const open = track(t, [[open0, 0], [open1, 1], [close0, 1], [close1, 0]]);
          const az = track(t, [[0, -Math.PI], [orbit1, 0], [stand1, 0], [orbit2, Math.PI]], easeInOutSine);
          return {
            open,
            leaves: turnLeaves(t, turnStart, count, n),
            stage,
            cam: { az, el: elevationFor(stage, open), zoom: 1, stable: true },
          };
        },
      };
    }
    default:
      return {
        length: 0,
        sample: (_t, n, base) => ({ open: base.open, leaves: leafTurns(base.leaf, n), stage: base.stage, cam: null }),
      };
  }
}

/** Seconds for one pass of the animation (opts.duration rescales the whole timeline). */
export function animationDuration(mode: AnimationMode, opts: AnimationOptions, nTurn: number): number {
  if (mode === 'none') return 0;
  const p = plan(mode, opts, nTurn);
  return opts.duration && opts.duration > 0 ? opts.duration : p.length;
}

/** Pose at time t (seconds). Loops when opts.loop !== false, otherwise clamps to the end. */
export function sampleTimeline(mode: AnimationMode, opts: AnimationOptions, t: number, nTurn: number, base: StaticPose): TimelineSample {
  const p = plan(mode, opts, nTurn);
  if (mode === 'none' || p.length <= 0) return p.sample(0, nTurn, base);
  const duration = animationDuration(mode, opts, nTurn);
  let local = Number.isFinite(t) ? t : 0;
  if (opts.loop === false) local = Math.max(0, Math.min(duration, local));
  else local = ((local % duration) + duration) % duration;
  return p.sample((local / duration) * p.length, nTurn, base);
}
