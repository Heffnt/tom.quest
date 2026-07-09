// app/boolback/lib/bins.ts — continuous → bucket math.
//
// Shared by the config panel (Phase 2: writes a BinSpec and previews the bucket
// edge labels) and the plot renderer (Phase 3: buckets each run's value into a
// split group and labels it). PURE — no store, no React, no DOM.
//
// A bucketing is described by its ORDERED BOUNDARY EDGES: `n` buckets ⇒ n+1
// ascending numbers [e0, e1, …, en], where bucket i covers [e_i, e_{i+1}) and
// the last bucket is closed on the right ([e_{n-1}, e_n]). Edges are stored in
// BinSpec.edges only when the user hand-edits them (method "custom"); for
// "quantile"/"width" they are recomputed from the current data by
// computeBinEdges so labels stay absolute (they describe the actual values).

/** Clamp a requested bucket count to the supported 1..8 range. */
export function clampBinCount(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

/** Linear-interpolated quantile of an ASCENDING array (q in [0,1]). */
function quantile(sorted: number[], q: number): number {
  const m = sorted.length;
  if (m === 0) return 0;
  if (m === 1) return sorted[0];
  const pos = q * (m - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Boundary edges for `n` buckets over ASCENDING-sorted finite `sortedValues`.
 *   - "quantile": equal-count buckets (edges at the k/n sample quantiles);
 *   - "width":    equal-width buckets over [min, max].
 * Returns n+1 ascending boundaries. `n` is clamped to [1,8]. With fewer than
 * two finite values a single degenerate bucket is returned ([v, v] or [0, 0]).
 */
export function computeBinEdges(
  sortedValues: number[],
  n: number,
  method: "quantile" | "width",
): number[] {
  const k = clampBinCount(n);
  const clean = sortedValues.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return new Array<number>(k + 1).fill(0);
  const min = clean[0];
  const max = clean[clean.length - 1];
  if (clean.length === 1 || max - min < 1e-12) {
    return new Array<number>(k + 1).fill(min);
  }
  const edges: number[] = [];
  if (method === "width") {
    const step = (max - min) / k;
    for (let i = 0; i <= k; i++) edges.push(i === k ? max : min + i * step);
  } else {
    for (let i = 0; i <= k; i++) edges.push(quantile(clean, i / k));
    edges[0] = min;
    edges[k] = max;
  }
  return edges;
}

/**
 * Bucket index (0-based) a value falls into for the given boundary `edges`
 * (length n+1 ⇒ n buckets). Values ≤ e0 land in bucket 0; values ≥ en land in
 * the last bucket. Degenerate edges (<2 entries) always bucket 0.
 */
export function bucketOf(value: number, edges: number[]): number {
  const n = edges.length - 1;
  if (n < 1) return 0;
  if (value <= edges[0]) return 0;
  if (value >= edges[n]) return n - 1;
  for (let i = 0; i < n; i++) {
    if (value < edges[i + 1]) return i;
  }
  return n - 1;
}

/** Compact numeric label for a bucket edge (trims trailing zeros; sci for extremes). */
export function edgeLabel(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (v === 0) return "0";
  if (a >= 1000 || a < 0.001) return v.toExponential(1);
  return String(Number(v.toFixed(3)));
}

/**
 * Label for bucket `i` given boundary `edges` — the closed-open interval
 * "lo–hi" (e.g. "0.12–0.35"), using `fmt` for each endpoint (defaults to
 * edgeLabel). Out-of-range indices yield an em dash.
 */
export function binLabel(
  edges: number[],
  i: number,
  fmt: (v: number) => string = edgeLabel,
): string {
  if (i < 0 || i + 1 >= edges.length) return "—";
  return `${fmt(edges[i])}–${fmt(edges[i + 1])}`;
}
