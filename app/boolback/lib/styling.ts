// app/boolback/lib/styling.ts — visual encoding for the plot's series.
//
// CATEGORY_PALETTE is the categorical series palette: ≥20 visually distinct
// mid-lightness hues that read on both light and dark backgrounds. A series
// takes paletteColor(i) by its ordinal (setting-major series order; cycles
// past the palette length — split-dims.resolveSeries flags the cycling as
// `paletteExceeded`). Index 0 doubles as the default setting color and the
// single-series color.

/** Categorical series palette (≥20 mid-lightness hues; cycles). */
export const CATEGORY_PALETTE = [
  "#e8a040", "#38bdf8", "#4ade80", "#e879f9",
  "#f87171", "#facc15", "#2dd4bf", "#a78bfa",
  "#fb7185", "#a3e635", "#22d3ee", "#f472b6",
  "#94a3b8", "#c9b35f", "#6fb6a6", "#b48ad6",
  "#fca5a5", "#86efac", "#7dd3fc", "#f0abfc",
];

/** Back-compat alias (older call sites); prefer CATEGORY_PALETTE. */
export const PALETTE = CATEGORY_PALETTE;

/** Color for a view with no color split. */
export const SINGLE_COLOR = "#e8a040";

/** Shape-channel glyph cycle length (0 = plain circle; see shapeNode). */
export const SHAPE_COUNT = 6;

/** Dash-channel patterns (SVG stroke-dasharray); index 0 = solid line. */
export const DASH_PATTERNS = ["", "6 3", "2 3", "8 3 2 3"];

const wrap = (i: number, mod: number) => ((i % mod) + mod) % mod;

/** Concrete series color for ordinal `i` (palette cycles). */
export function paletteColor(i: number): string {
  return CATEGORY_PALETTE[wrap(i, CATEGORY_PALETTE.length)];
}

/** Back-compat alias for paletteColor (older call sites). */
export const colorForValue = paletteColor;

/** Glyph index for a value at ordinal `i` (glyphs cycle). */
export function shapeForValue(i: number): number {
  return wrap(i, SHAPE_COUNT);
}

/** Dash pattern for a value at ordinal `i` (patterns cycle; 0 = solid). */
export function dashForValue(i: number): string {
  return DASH_PATTERNS[wrap(i, DASH_PATTERNS.length)];
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
