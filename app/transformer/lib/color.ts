// Color scales for activation heat and signed weights, tuned to the site's
// dark theme (bg #0a0e17, accent #e8a040).

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

const COLD: [number, number, number] = [26, 35, 50]; // surface-alt
const HOT: [number, number, number] = [232, 160, 64]; // accent amber
const NEG: [number, number, number] = [59, 130, 246]; // blue for negative weights
const ZERO: [number, number, number] = [14, 19, 31]; // near bg

/** Activation intensity 0..1 → dark slate → amber. */
export function heat(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  // slight gamma so mid-range values stay readable on dark
  const g = Math.pow(t, 0.75);
  return rgb(lerp(COLD[0], HOT[0], g), lerp(COLD[1], HOT[1], g), lerp(COLD[2], HOT[2], g));
}

/** Signed value in [-1, 1] → blue / dark / amber. Used by weight heatmaps. */
export function diverging(t: number): string {
  const c = Math.max(-1, Math.min(1, t));
  const a = Math.pow(Math.abs(c), 0.6);
  const target = c < 0 ? NEG : HOT;
  return rgb(lerp(ZERO[0], target[0], a), lerp(ZERO[1], target[1], a), lerp(ZERO[2], target[2], a));
}

/** Same as diverging() but returns [r,g,b] for ImageData writes. */
export function divergingRgb(t: number): [number, number, number] {
  const c = Math.max(-1, Math.min(1, t));
  const a = Math.pow(Math.abs(c), 0.6);
  const target = c < 0 ? NEG : HOT;
  return [lerp(ZERO[0], target[0], a), lerp(ZERO[1], target[1], a), lerp(ZERO[2], target[2], a)];
}
