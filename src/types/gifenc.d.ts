declare module 'gifenc' {
  export type GifPixelFormat = 'rgb565' | 'rgb444' | 'rgba4444';
  /** Array of [r, g, b] or [r, g, b, a] byte triplets/quads. */
  export type GifPalette = number[][];

  export interface QuantizeOptions {
    format?: GifPixelFormat;
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  export interface WriteFrameOptions {
    palette?: GifPalette;
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    /** Frame delay in milliseconds. */
    delay?: number;
    /** 0 = loop forever, -1 = play once, n = repeat n times. */
    repeat?: number;
    dispose?: number;
  }

  export interface GIFEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array<ArrayBuffer>;
    writeHeader(): void;
    reset(): void;
    readonly buffer: ArrayBuffer;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: QuantizeOptions): GifPalette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: GifPalette, format?: GifPixelFormat): Uint8Array;
  export function nearestColorIndex(palette: GifPalette, pixel: number[]): number;
  export function nearestColorIndexWithDistance(palette: GifPalette, pixel: number[]): [number, number];
  export function nearestColor(palette: GifPalette, pixel: number[]): number[];
  export function prequantize(rgba: Uint8Array | Uint8ClampedArray, options?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number }): void;
  export function snapColorsToPalette(palette: GifPalette, knownColors: number[][], threshold?: number): void;

  const gifenc: {
    GIFEncoder: typeof GIFEncoder;
    quantize: typeof quantize;
    applyPalette: typeof applyPalette;
    nearestColorIndex: typeof nearestColorIndex;
    nearestColorIndexWithDistance: typeof nearestColorIndexWithDistance;
    nearestColor: typeof nearestColor;
    prequantize: typeof prequantize;
    snapColorsToPalette: typeof snapColorsToPalette;
  };
  export default gifenc;
}
