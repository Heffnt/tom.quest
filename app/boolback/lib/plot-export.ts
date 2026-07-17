// app/boolback/lib/plot-export.ts — the "data CSV" serializer: the plotted
// selection at RUN grain, one row per plotted point (per (run, epoch) when the
// x axis is the epoch sentinel), for handing to another agent to write
// matplotlib code. It pairs with the spec JSON the Copy button already exports.
//
// Averaged/mean overlays are NEVER exported — only the raw underlying points
// (the consumer re-aggregates as it likes). A run drawn once per matching
// layer exports once per matching layer (the same duplication-by-design rule
// as the plot); the `layer` column disambiguates. The group plot passes one
// entry per (panel × layer) slice, each carrying its panel key — the `panel`
// column exists ONLY on the groupplot view.
//
// The `member` column (right after `layer`, on BOTH views) names the source
// member layer for a GROUP layer's rows, and is empty for a plain layer. A
// group pools the UNION of its members' matches deduped by run identity, so a
// run matching two members of one group exports ONCE, attributed to the FIRST
// matching member (the union-dedup winner — split-dims.Series.memberOf).
//
// Axis values are RAW (never log-transformed; a categorical parameter axis
// exports its raw string value, not the ordinal position); rows where either
// axis is null are skipped (they are not plottable). Column headers use the
// actual metric/axis ids ("avg_sensitivity", "auroc@mad_quirky", "epoch").
//
// PURE — no store, no DOM. plotDataCsv is unit-tested.

import type { RunRow, FacetKey } from "./types";
import { cellValue, facetValue, numericValue, MAX_EPOCH } from "./select";
import { toCsv } from "./export";
import { buildRunSeries, trajectoryMetric } from "./trajectories";

/** One exported trace: a layer's matched rows. The main plot passes one entry
 *  per layer (resolveSeries order); the group plot passes one entry per
 *  (panel × layer) slice with `panel` set to the facet cell key (raw value). */
export interface ExportSeries {
  /** Layer name — the `layer` column. */
  layer: string;
  /** GROUP layers only: run node_path → source member name (the `member`
   *  column; empty for a plain layer's rows). From split-dims.Series.memberOf. */
  memberOf?: Map<string, string> | null;
  /** Facet cell key (group plot only) — the `panel` column. */
  panel?: string;
  /** The series' unique judge (epoch mode reads per-epoch values with it —
   *  the same rule as the plotted trajectories). */
  judge?: string | null;
  rows: RunRow[];
}

/** The parameter context columns, in header order (CMT snake_case; the fixed
 *  contract list — arity + function identity, then the facet keys). */
const CONTEXT_KEYS = [
  "arity", "fn_hex", "dataset", "trigger_form", "target_behavior",
  "target_phrase", "row_distribution", "samples_per_row", "backdoor_ratio",
  "base_model", "tuning", "backend", "lr", "epochs", "seed", "judge", "split",
] as const;

/** One row's parameter context cells, in CONTEXT_KEYS order. */
function contextOf(r: RunRow): Array<string | number | boolean | null> {
  return CONTEXT_KEYS.map((k) =>
    k === "arity" ? r.function.arity
      : k === "fn_hex" ? cellValue(r, "function.fn_hex")
        : facetValue(r, k as FacetKey));
}

/** Raw axis value for a metric/axis id — bare metric_schema names, dotted
 *  parameter paths and per-method "<base>@<method>" names all resolve through
 *  select.cellValue; the derived max_epoch reads through numericValue. */
function axisValue(r: RunRow, name: string): string | number | boolean | null {
  return name === MAX_EPOCH ? numericValue(r, name) : cellValue(r, name);
}

/**
 * Serialize the plotted selection to CSV. Columns, in order: `layer`, `member`
 * (a group's source member, empty on a plain layer), `panel` (groupplot only),
 * `run_id`, `dir_path`, `<x-id>` (`epoch` when x is the epoch axis), `<y-id>`,
 * then the parameter context columns. One row per plotted point: run grain, or
 * (run, epoch) grain in epoch mode.
 */
export function plotDataCsv(
  series: ExportSeries[],
  axes: { x: string; y: string },
  opts: { view: "plot" | "groupplot" },
): string {
  const groupplot = opts.view === "groupplot";
  const epochMode = axes.x === "epoch";
  const head: string[] = [
    "layer",
    "member",
    ...(groupplot ? ["panel"] : []),
    "run_id",
    "dir_path",
    epochMode ? "epoch" : axes.x,
    axes.y,
    ...CONTEXT_KEYS,
  ];
  const body: Array<Array<string | number | boolean | null>> = [];
  for (const s of series) {
    // `member` is per-ROW (a group pools several members into one series);
    // `panel` is per-series. The pre-cells before run_id are [layer, member,
    // panel?] — member is filled per row below.
    const member = (r: RunRow): string => s.memberOf?.get(r.identity.node_path) ?? "";
    const pre = (r: RunRow): Array<string | number | boolean | null> =>
      groupplot ? [s.layer, member(r), s.panel ?? ""] : [s.layer, member(r)];
    if (epochMode) {
      // Per (run, epoch): the same per-series trajectory build as the plot
      // (the series' judge scores it), raw values (logY never applies here).
      const metric = trajectoryMetric(axes.y) ?? "plantedness";
      const byId = new Map(s.rows.map((r) => [r.identity.node_path, r]));
      const { series: runs } = buildRunSeries(s.rows, metric, () => [], s.judge ?? null, false);
      for (const t of runs) {
        const r = byId.get(t.runId)!;
        const ctx = contextOf(r);
        for (const p of t.points) {
          body.push([...pre(r), r.identity.run_id, r.identity.dir_path, p.e, p.y, ...ctx]);
        }
      }
    } else {
      for (const r of s.rows) {
        const vx = axisValue(r, axes.x);
        const vy = axisValue(r, axes.y);
        if (vx === null || vy === null) continue; // not plottable — not exported
        body.push([...pre(r), r.identity.run_id, r.identity.dir_path, vx, vy, ...contextOf(r)]);
      }
    }
  }
  return toCsv([head, ...body]);
}

/** Download filename for the data CSV: `boolback-<view>-<x>-vs-<y>.csv`. */
export function plotCsvFilename(
  view: "plot" | "groupplot",
  axes: { x: string; y: string },
): string {
  return `boolback-${view}-${axes.x}-vs-${axes.y}.csv`;
}
