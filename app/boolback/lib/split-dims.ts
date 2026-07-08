// app/boolback/lib/split-dims.ts — synthesize the plot's SPLIT set.
//
// Phase 3: a continuous metric the user chose to BIN (config.bins[m], with the
// metric key pushed into config.splits) must behave exactly like a categorical
// split — its bucket labels flow through the same group key, legend, channel
// assignment and averaging as a ParameterDef split. summarizeParameters only
// knows ParameterDefs, so we build a synthetic split dimension for a binned
// metric on the fly and merge it into the resolution alongside the param-based
// ones. Judge is ALWAYS pinned into the split set (cmt pool_guard: judges never
// pool), even if the user didn't add it.
//
// PURE — no store, no React. binnedSplitDim + resolveSplits are unit-tested.

import type { RunRow, BinSpec, Channel } from "./types";
import {
  resolveChannels,
  type ParameterDef,
  type ParamValues,
  type ParamSummary,
} from "./parameters";
import { computeBinEdges, bucketOf, binLabel, edgeLabel } from "./bins";

/** Bucket label for a run whose value is null/absent on the binned metric. */
export const NULL_BUCKET = "—";

/** Judge is always split (cmt pool_guard rule). */
export const JUDGE_KEY = "judge";

/** Boundary edges for a bin spec: hand-edited (custom) or recomputed from the
 *  current data so quantile/width labels stay absolute over the plotted rows. */
export function binEdgesFor(sortedValues: number[], spec: BinSpec): number[] {
  if (spec.method === "custom" && spec.edges && spec.edges.length >= 2) return spec.edges;
  return computeBinEdges(sortedValues, spec.n, spec.method === "custom" ? "quantile" : spec.method);
}

/**
 * A synthetic split dimension for binning continuous metric `key` over `rows`.
 * Each run's split value is its bucket LABEL ("0.12–0.35"); values are ordered
 * by bucket index (not lexically) with a trailing NULL_BUCKET when any run is
 * missing the metric. `numericOf` reads the run's numeric value for the metric.
 */
export function binnedSplitDim(
  key: string,
  label: string,
  rows: RunRow[],
  numericOf: (r: RunRow) => number | null,
  spec: BinSpec,
  fmt: (v: number) => string = edgeLabel,
): { dim: ParameterDef; values: Array<{ value: string; count: number }>; edges: number[] } {
  const nums: number[] = [];
  for (const r of rows) {
    const v = numericOf(r);
    if (v !== null && Number.isFinite(v)) nums.push(v);
  }
  nums.sort((a, b) => a - b);
  const edges = binEdgesFor(nums, spec);

  const bucketLabelOf = (r: RunRow): string => {
    const v = numericOf(r);
    if (v === null || !Number.isFinite(v)) return NULL_BUCKET;
    return binLabel(edges, bucketOf(v, edges), fmt);
  };

  const counts = new Map<string, number>();
  for (const r of rows) {
    const l = bucketLabelOf(r);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  // Order by bucket index (labels merge if two buckets stringify equally).
  const values: Array<{ value: string; count: number }> = [];
  const nBuckets = Math.max(1, edges.length - 1);
  for (let i = 0; i < nBuckets; i++) {
    const l = binLabel(edges, i, fmt);
    const c = counts.get(l);
    if (c !== undefined) {
      values.push({ value: l, count: c });
      counts.delete(l);
    }
  }
  if (counts.has(NULL_BUCKET)) values.push({ value: NULL_BUCKET, count: counts.get(NULL_BUCKET)! });

  const dim: ParameterDef = { key, label, raw: bucketLabelOf, section: "function" };
  return { dim, values, edges };
}

export interface SplitResolution {
  /** Split dims in visual-channel order (color, shape, size, dash). */
  splitDims: ParamValues[];
  /** split key → its assigned channel. */
  channelByKey: Map<string, Channel>;
  /** channel → its split dim (color absent when a continuous colorBy owns it). */
  byChannel: Map<Channel, ParamValues>;
  /** True when at least one differing PARAMETER is neither split nor faceted. */
  averaging: boolean;
}

/**
 * Merge ParameterDef splits + synthetic binned-metric splits + the pinned judge
 * into one channel-resolved split set. `excludeKey` drops a key (Group Plot's
 * facet). `numericOf`/`labelOf`/`fmtEdge` are per-metric accessors the caller
 * derives from its metric index (kept out of this pure module).
 */
export function resolveSplits(opts: {
  summary: ParamSummary;
  rows: RunRow[];
  splitKeys: string[];
  bins: Record<string, BinSpec>;
  channels: Record<string, Channel>;
  colorByActive: boolean;
  excludeKey?: string | null;
  numericOf: (metric: string) => (r: RunRow) => number | null;
  labelOf: (metric: string) => string;
  fmtEdge: (metric: string) => (v: number) => string;
}): SplitResolution {
  const { summary, rows, splitKeys, bins, channels, colorByActive } = opts;
  const excludeKey = opts.excludeKey ?? null;

  const differingByKey = new Map<string, ParamValues>();
  for (const d of summary.differing) {
    if (d.dim.key !== excludeKey) differingByKey.set(d.dim.key, d);
  }

  // Resolve requested splits: a differing param, or a binned continuous metric.
  const resolvedByKey = new Map<string, ParamValues>();
  for (const key of splitKeys) {
    if (key === excludeKey || resolvedByKey.has(key)) continue;
    const param = differingByKey.get(key);
    if (param) {
      resolvedByKey.set(key, param);
      continue;
    }
    const spec = bins[key];
    if (spec) {
      const { dim, values } = binnedSplitDim(
        key, opts.labelOf(key), rows, opts.numericOf(key), spec, opts.fmtEdge(key),
      );
      // A degenerate bin (one bucket over these rows) is constant — skip it so
      // it never consumes a channel.
      if (values.length >= 2) resolvedByKey.set(key, { dim, values });
    }
  }

  // Pin judge whenever it differs (unless it's the facet key).
  if (JUDGE_KEY !== excludeKey && differingByKey.has(JUDGE_KEY) && !resolvedByKey.has(JUDGE_KEY)) {
    resolvedByKey.set(JUDGE_KEY, differingByKey.get(JUDGE_KEY)!);
  }

  // Active split order: requested order first, then the pinned judge last.
  const activeSplits: string[] = [];
  for (const key of splitKeys) {
    if (key !== excludeKey && resolvedByKey.has(key) && !activeSplits.includes(key)) {
      activeSplits.push(key);
    }
  }
  if (resolvedByKey.has(JUDGE_KEY) && !activeSplits.includes(JUDGE_KEY)) activeSplits.push(JUDGE_KEY);

  const available: Channel[] = colorByActive
    ? ["shape", "size", "dash"]
    : ["color", "shape", "size", "dash"];
  const channelByKey = resolveChannels(
    activeSplits, channels, (k) => resolvedByKey.get(k)?.values.length ?? 0, available,
  );

  const byChannel = new Map<Channel, ParamValues>();
  for (const [key, ch] of channelByKey) {
    const pv = resolvedByKey.get(key);
    if (pv) byChannel.set(ch, pv);
  }
  const order: Channel[] = ["color", "shape", "size", "dash"];
  const splitDims = order
    .map((ch) => byChannel.get(ch))
    .filter((d): d is ParamValues => d !== undefined);

  // Only a differing PARAMETER can be "averaged" (a binned metric that isn't
  // split simply isn't a dimension). A split/faceted/judge-pinned param is not.
  const averaging = summary.differing.some(
    (d) => d.dim.key !== excludeKey && !channelByKey.has(d.dim.key),
  );

  return { splitDims, channelByKey, byChannel, averaging };
}
