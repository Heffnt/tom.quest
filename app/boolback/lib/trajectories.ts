// app/boolback/lib/trajectories.ts — per-epoch training trajectories for the
// Plot view's epoch x-axis (x === "epoch", training progress).
//
// Each run contributes points (completed_epochs[i], metric[i]); null metric
// values are line GAPS (skipped, never interpolated). Only trajectory-backed
// metrics have per-epoch series: plantedness / asr / ftr / ppl. Judge
// resolution: when the `judge` dimension is filtered to ONE judge we read that
// judge's per_judge[].by_epoch arrays (asr/ftr/plantedness only); otherwise the
// headline `trajectories` (the primary judge's), and ppl always from headline.
//
// Descriptive only (mean/sd via lib/stats) — the boundary rule holds.

import type { RunRow } from "./types";
import { mean, stdDev } from "./stats";

export const EPOCH_METRICS = ["plantedness", "asr", "ftr", "ppl"] as const;
export type EpochMetric = (typeof EPOCH_METRICS)[number];

/** The trajectory metric backing headline Y `y`, or null if it has no series. */
export function trajectoryMetric(y: string): EpochMetric | null {
  return (EPOCH_METRICS as readonly string[]).includes(y) ? (y as EpochMetric) : null;
}

export interface SeriesPoint { e: number; y: number; }

export interface RunSeries {
  runId: string;
  dims: string[]; // split-dim values (grouping key)
  points: SeriesPoint[]; // ascending epoch; nulls skipped (gaps)
}

export interface EpochMean { e: number; y: number; sd: number | null; n: number; }

export interface GroupSeries {
  dims: string[];
  points: EpochMean[]; // ascending epoch
  /** Set when exactly one run backs the group (vertex click-through to drawer). */
  runId?: string;
}

const SEP = String.fromCharCode(0);

/** The per-epoch Y array for a run: the selected judge's by_epoch when `judge`
 *  names one (and the metric is judge-scoped), else the headline trajectory. */
function epochArray(r: RunRow, metric: EpochMetric, judge: string | null): (number | null)[] {
  if (judge && metric !== "ppl") {
    const pj = r.per_judge?.find((p) => p.judge === judge);
    const arr = pj?.by_epoch?.[metric];
    if (arr) return arr;
  }
  return r.trajectories?.[metric] ?? [];
}

/**
 * Per-run epoch series for `metric`. `dimsOf` yields the run's split-dim values
 * (its group key). `logY` drops non-positive Y (counted in `dropped`).
 * In-progress runs simply produce shorter series.
 */
export function buildRunSeries(
  rows: RunRow[],
  metric: EpochMetric,
  dimsOf: (r: RunRow) => string[],
  judge: string | null,
  logY: boolean,
): { series: RunSeries[]; dropped: number } {
  const series: RunSeries[] = [];
  let dropped = 0;
  for (const r of rows) {
    const epochs = r.trajectories?.completed_epochs ?? [];
    const ys = epochArray(r, metric, judge);
    const points: SeriesPoint[] = [];
    for (let i = 0; i < epochs.length; i++) {
      const yv = ys[i];
      if (yv === null || yv === undefined) continue; // line gap
      if (logY && yv <= 0) { dropped++; continue; }
      points.push({ e: epochs[i], y: logY ? Math.log10(yv) : yv });
    }
    if (points.length > 0) series.push({ runId: r.identity.node_path, dims: dimsOf(r), points });
  }
  return { series, dropped };
}

/** Aggregate run series into group means ± SD per EXACT epoch (no binning —
 *  epochs are small integers). Groups by the runs' dims tuple. */
export function groupSeries(series: RunSeries[]): GroupSeries[] {
  const groups = new Map<string, { dims: string[]; byEpoch: Map<number, number[]>; runs: Set<string> }>();
  for (const s of series) {
    const key = s.dims.join(SEP);
    let g = groups.get(key);
    if (!g) { g = { dims: s.dims, byEpoch: new Map(), runs: new Set() }; groups.set(key, g); }
    g.runs.add(s.runId);
    for (const p of s.points) {
      const arr = g.byEpoch.get(p.e);
      if (arr) arr.push(p.y);
      else g.byEpoch.set(p.e, [p.y]);
    }
  }
  const out: GroupSeries[] = [];
  for (const g of groups.values()) {
    const points: EpochMean[] = [...g.byEpoch.entries()]
      .map(([e, ys]) => ({ e, y: mean(ys)!, sd: stdDev(ys), n: ys.length }))
      .sort((a, b) => a.e - b.e);
    out.push({ dims: g.dims, points, runId: g.runs.size === 1 ? [...g.runs][0] : undefined });
  }
  out.sort((a, b) => {
    for (let i = 0; i < Math.min(a.dims.length, b.dims.length); i++) {
      if (a.dims[i] !== b.dims[i]) return a.dims[i] < b.dims[i] ? -1 : 1;
    }
    return 0;
  });
  return out;
}
