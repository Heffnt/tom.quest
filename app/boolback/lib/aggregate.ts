// app/boolback/lib/aggregate.ts — grouped means for the chart's dimension model.
//
// Points are grouped by the run's SPLIT-dimension values plus an X bucket, so
// averaging collapses exactly the dimensions the user marked "average" while
// preserving position along X (a mean smeared across X would answer nothing).
// Discrete X (fourier degree, arity, counts) buckets by exact value; a
// continuous X with more distinct values than `maxXGroups` falls back to
// `bins` equal-width bins (positions at bin centers).
//
// When averaging, the raw runs behind each group are also returned as GHOSTS
// (faint underlying points/lines) so the collapse stays visible — subsampled
// above GHOST_CAP so 10k-run views don't melt. splitWorthiness scores, for each
// averaged dimension, how much of the within-group Y spread it would explain if
// split out (the legend's "should I split this?" readout).
//
// Descriptive only (mean/sd/n + eta² via within/total sums of squares) — the
// boundary rule keeps anything inferential CMT-side.

import { mean, stdDev } from "./stats";

export interface RunPoint {
  x: number; // transformed (log?) x
  y: number;
  runId: string;
  /** Split-dimension raw values, in the caller's fixed dimension order. */
  dims: string[];
}

export interface GroupedPoint {
  x: number; // group mean x (== the run's x when n === 1)
  y: number;
  sdX: number | null; // null for n < 2
  sdY: number | null;
  n: number;
  dims: string[];
  /** Set when the group is a single run (click-through to its drawer). */
  runId?: string;
}

/** A raw run tagged with its group's split-dim values (ghost rendering). */
export interface Ghost {
  x: number;
  y: number;
  dims: string[];
  runId: string;
}

export interface GroupResult {
  points: GroupedPoint[]; // sorted by dims, then x
  binned: boolean; // true when X was bucketed into equal-width bins
  /** Raw runs behind the groups (only when averaging), for faint ghost rendering. */
  ghosts: Ghost[];
  /** True when ghosts were subsampled to stay under GHOST_CAP. */
  ghostsSubsampled: boolean;
}

const SEP = "\u0000";

/** Cap on ghost points/lines rendered — above this we deterministically thin. */
export const GHOST_CAP = 2000;

/**
 * X-bucketing shared by grouping and split-worthiness so both agree on group
 * boundaries. Exact value up to `maxXGroups` distinct; otherwise equal-width
 * bins keyed at bin centers.
 */
export function makeXBucketer(
  pts: ReadonlyArray<{ x: number }>,
  maxXGroups = 24,
  bins = 12,
): { key: (x: number) => number; binned: boolean } {
  const distinct = new Set<number>();
  for (const p of pts) distinct.add(p.x);
  if (distinct.size <= maxXGroups) return { key: (x) => x, binned: false };
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.x < lo) lo = p.x;
    if (p.x > hi) hi = p.x;
  }
  const span = hi - lo || 1;
  return {
    key: (x) => {
      let i = Math.floor(((x - lo) / span) * bins);
      if (i >= bins) i = bins - 1; // x === hi lands in the last bin
      return lo + ((i + 0.5) / bins) * span;
    },
    binned: true,
  };
}

/** Group id for a run at (dims, x) via a shared bucketer — the same grouping
 *  groupRuns applies, so split-worthiness scores the exact rendered groups. */
export function groupKeyFor(dims: string[], x: number, bucket: (x: number) => number): string {
  return dims.join(SEP) + SEP + bucket(x);
}

/** Stable sort by (dims, x, runId) — deterministic ghost subsampling order. */
function sortStable(pts: RunPoint[]): RunPoint[] {
  return [...pts].sort((a, b) => {
    const n = Math.min(a.dims.length, b.dims.length);
    for (let i = 0; i < n; i++) {
      if (a.dims[i] !== b.dims[i]) return a.dims[i] < b.dims[i] ? -1 : 1;
    }
    if (a.x !== b.x) return a.x - b.x;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
}

function ghostSample(pts: RunPoint[]): { list: Ghost[]; subsampled: boolean } {
  const sorted = sortStable(pts);
  const toGhost = (p: RunPoint): Ghost => ({ x: p.x, y: p.y, dims: p.dims, runId: p.runId });
  if (sorted.length <= GHOST_CAP) return { list: sorted.map(toGhost), subsampled: false };
  const k = Math.ceil(sorted.length / GHOST_CAP);
  const list: Ghost[] = [];
  for (let i = 0; i < sorted.length; i += k) list.push(toGhost(sorted[i]));
  return { list, subsampled: true };
}

/**
 * Group `pts` by (dims, x bucket) and reduce to mean ± SD. With
 * `averaging === false` every run stays its own point (no grouping, no ghosts).
 */
export function groupRuns(
  pts: RunPoint[],
  averaging: boolean,
  maxXGroups = 24,
  bins = 12,
): GroupResult {
  if (!averaging) {
    return {
      points: pts.map((p) => ({
        x: p.x, y: p.y, sdX: null, sdY: null, n: 1, dims: p.dims, runId: p.runId,
      })),
      binned: false,
      ghosts: [],
      ghostsSubsampled: false,
    };
  }
  if (pts.length === 0) return { points: [], binned: false, ghosts: [], ghostsSubsampled: false };

  const { key: xKey, binned } = makeXBucketer(pts, maxXGroups, bins);

  const groups = new Map<string, { dims: string[]; xs: number[]; ys: number[]; runId: string }>();
  for (const p of pts) {
    const id = p.dims.join(SEP) + SEP + xKey(p.x);
    const g = groups.get(id) ?? { dims: p.dims, xs: [], ys: [], runId: p.runId };
    g.xs.push(p.x);
    g.ys.push(p.y);
    groups.set(id, g);
  }

  const points = [...groups.values()].map((g) => ({
    x: mean(g.xs)!,
    y: mean(g.ys)!,
    sdX: stdDev(g.xs),
    sdY: stdDev(g.ys),
    n: g.xs.length,
    dims: g.dims,
    runId: g.xs.length === 1 ? g.runId : undefined,
  }));
  points.sort((a, b) => {
    for (let i = 0; i < a.dims.length; i++) {
      if (a.dims[i] !== b.dims[i]) return a.dims[i] < b.dims[i] ? -1 : 1;
    }
    return a.x - b.x;
  });

  const { list: ghosts, subsampled } = ghostSample(pts);
  return { points, binned, ghosts, ghostsSubsampled: subsampled };
}

// ---------------------------------------------------------------------------
// Split-worthiness — how much within-group Y spread an averaged dim explains.
// ---------------------------------------------------------------------------

export interface WorthinessRun {
  y: number;
  /** Rendered group id (split-dim tuple × x bucket) — same grouping as above. */
  group: string;
  /** Averaged dimension key → this run's raw value. */
  values: Record<string, string>;
}

/**
 * Weighted eta² of Y explained by each averaged dimension WITHIN the current
 * rendered groups. For each group with n ≥ 3 runs and ≥ 2 distinct values of
 * `d`: eta²_g = 1 − Σ_v SS_within(v) / SS_total(g); report
 * Σ_g n_g·eta²_g / Σ_g n_g over qualifying groups (0 if none qualify).
 *
 * 0 ⇒ splitting `d` wouldn't separate the current spread; ~1 ⇒ it explains it.
 * Guards contribute nothing: n < 3, single distinct value, all-identical Y.
 * Descriptive (sums of squares) — inside the stats boundary.
 */
export function splitWorthiness(
  runs: WorthinessRun[],
  averagedDims: string[],
): Record<string, number> {
  const byGroup = new Map<string, WorthinessRun[]>();
  for (const r of runs) {
    const arr = byGroup.get(r.group);
    if (arr) arr.push(r);
    else byGroup.set(r.group, [r]);
  }
  const groups = [...byGroup.values()];

  const out: Record<string, number> = {};
  for (const d of averagedDims) {
    let wSum = 0;
    let wTot = 0;
    for (const g of groups) {
      if (g.length < 3) continue;
      const distinct = new Set(g.map((r) => r.values[d]));
      if (distinct.size < 2) continue;
      const ys = g.map((r) => r.y);
      const gMean = ys.reduce((s, v) => s + v, 0) / ys.length;
      const ssTot = ys.reduce((s, v) => s + (v - gMean) * (v - gMean), 0);
      if (ssTot <= 0) continue; // all-identical Y — nothing to explain
      const byVal = new Map<string, number[]>();
      for (const r of g) {
        const arr = byVal.get(r.values[d]);
        if (arr) arr.push(r.y);
        else byVal.set(r.values[d], [r.y]);
      }
      let ssWithin = 0;
      for (const arr of byVal.values()) {
        const m = arr.reduce((s, v) => s + v, 0) / arr.length;
        for (const v of arr) ssWithin += (v - m) * (v - m);
      }
      const eta2 = 1 - ssWithin / ssTot;
      wSum += g.length * eta2;
      wTot += g.length;
    }
    out[d] = wTot > 0 ? wSum / wTot : 0;
  }
  return out;
}
