// app/boolback/lib/styling.ts — visual encoding for split dimensions.
//
// A split dimension drives ONE channel; a value's concrete visual comes from
// its ordinal within the (pre-sorted) value list, cycling past the palette /
// glyph / dash caps. Explicit per-value overrides (ChartConfig.valueStyles,
// set from a legend swatch picker) win over the ordinal default.

import type { ValueStyle } from "./types";

/** Color-channel palette (cycles). Index 0 is also the single-series color. */
export const PALETTE = [
  "#e8a040", "#38bdf8", "#4ade80", "#e879f9",
  "#f87171", "#c9b35f", "#6fb6a6", "#b48ad6",
  "#f0abfc", "#86efac", "#fca5a5", "#7dd3fc",
];

/** Color for a view with no color split. */
export const SINGLE_COLOR = "#e8a040";

/** Shape-channel glyph cycle length (0 = plain circle; see shapeNode). */
export const SHAPE_COUNT = 6;

/** Dash-channel patterns (SVG stroke-dasharray); index 0 = solid line. */
export const DASH_PATTERNS = ["", "6 3", "2 3", "8 3 2 3"];

type ValueStyles = Record<string, Record<string, ValueStyle>>;

const wrap = (i: number, mod: number) => ((i % mod) + mod) % mod;

/** Concrete color for `dimKey`'s value at ordinal `i` (valueStyles override wins). */
export function colorForValue(dimKey: string, value: string, i: number, styles: ValueStyles): string {
  return styles[dimKey]?.[value]?.color ?? PALETTE[wrap(i, PALETTE.length)];
}

/** Glyph index for `dimKey`'s value at ordinal `i` (valueStyles override wins). */
export function shapeForValue(dimKey: string, value: string, i: number, styles: ValueStyles): number {
  const ov = styles[dimKey]?.[value]?.shape;
  return wrap(ov ?? i, SHAPE_COUNT);
}

/** Dash pattern for `dimKey`'s value at ordinal `i` (valueStyles override wins). */
export function dashForValue(dimKey: string, value: string, i: number, styles: ValueStyles): string {
  const ov = styles[dimKey]?.[value]?.dash;
  return DASH_PATTERNS[wrap(ov ?? i, DASH_PATTERNS.length)];
}

// ---------------------------------------------------------------------------
// Continuous COLOR channel (Phase 3 `colorBy`): a viridis-like gradient used
// when a metric drives color as a continuous encoding (not a categorical
// split). Stops are the canonical viridis anchors; gradientColor interpolates
// linearly in sRGB between them (no new deps — good enough for a legend/scatter
// gradient). NULL_GRADIENT is the neutral fill for a run missing the metric.
// ---------------------------------------------------------------------------

/** Viridis anchor stops (perceptually-ordered dark→bright), sRGB hex. */
export const GRADIENT_STOPS = [
  "#440154", "#414487", "#2a788e", "#22a884", "#7ad151", "#fde725",
] as const;

/** Neutral gray for a point with no value on the colorBy metric. */
export const NULL_GRADIENT = "#8a8a8a";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Continuous color for a normalized position `t` in [0,1] along the gradient. */
export function gradientColor(t: number): string {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : Number.isFinite(t) ? t : 0.5;
  const stops = GRADIENT_STOPS;
  const seg = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * f);
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(mix(a[0], b[0]))}${to2(mix(a[1], b[1]))}${to2(mix(a[2], b[2]))}`;
}
