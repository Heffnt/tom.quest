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
