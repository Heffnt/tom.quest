// app/boolback/lib/axes.ts — plot axis resolution (Phase 3).
//
// X and Y accept any metric OR parameter (and X also "epoch"). This module maps
// an axis NAME to a resolved accessor the plot renders from:
//
//   * metric_schema name  → continuous, read via its dotted column id;
//   * numeric parameter   → continuous, read via its DOTTED path directly
//       (training.lr, function.arity, dataset.backdoor_ratio, …) — these live
//       in select.COL_GETTERS, so numericValue resolves them;
//   * categorical param   → distinct values mapped to ordinal positions 0,1,2…
//       with the tick labels rendered as the category names.
//
// Parameters are addressed by their DOTTED column id (unambiguous vs. bare
// metric names). PARAM_AXES is the offered set; the picker lists it under a
// "parameters" group.
//
// PURE — no store/React. resolveAxis is unit-tested.

import type { RunRow } from "./types";
import { cellValue, numericValue, type MetricIndex } from "./select";
import { metricColumnId } from "./columns";
import { shortModel } from "./format";

/** A parameter offered as an axis (addressed by dotted column id). */
export interface ParamAxisDef {
  name: string; // dotted col id; also the config.x/y value
  label: string;
  numeric: boolean; // true → continuous read; false → categorical ordinal
  numericSort?: boolean; // categorical ordering (arity/seed as numbers)
  /** Integer-valued numeric axis → its stacked single points jitter. */
  integer?: boolean;
  display?: (v: string) => string; // categorical tick label prettifier
}

export const PARAM_AXES: ParamAxisDef[] = [
  { name: "function.arity", label: "Arity", numeric: true, integer: true },
  { name: "function.fn_hex", label: "Function", numeric: false },
  { name: "dataset.dataset", label: "Dataset", numeric: false },
  { name: "dataset.trigger_form", label: "Trigger", numeric: false },
  { name: "dataset.target_behavior", label: "Target", numeric: false },
  { name: "dataset.target_phrase", label: "Target phrase", numeric: false },
  { name: "dataset.row_distribution", label: "Row dist.", numeric: false },
  { name: "dataset.scheme", label: "Scheme", numeric: false },
  { name: "dataset.samples_per_row", label: "Samples/row", numeric: true, integer: true },
  { name: "dataset.backdoor_ratio", label: "Backdoor ratio", numeric: true },
  { name: "training.base_model", label: "Model", numeric: false, display: shortModel },
  { name: "training.tuning", label: "Tuning", numeric: false },
  { name: "training.backend", label: "Backend", numeric: false },
  { name: "training.lr", label: "LR", numeric: true },
  { name: "training.epochs", label: "Epochs", numeric: true, integer: true },
  { name: "training.seed", label: "Seed", numeric: true, integer: true },
  { name: "headline.primary_judge", label: "Judge", numeric: false },
];

const PARAM_BY_NAME = new Map(PARAM_AXES.map((p) => [p.name, p]));

/** Is `name` an offered parameter axis? */
export function isParamAxis(name: string): boolean {
  return PARAM_BY_NAME.has(name);
}

/** Picker options for the "parameters" group. */
export function paramAxisOptions(): Array<{ value: string; label: string }> {
  return PARAM_AXES.map((p) => ({ value: p.name, label: p.label }));
}

/** A resolved plot axis. `value(r)` is the numeric position (categorical →
 *  ordinal index); null means the run is skipped on this axis. */
export interface Axis {
  name: string;
  label: string;
  categorical: boolean;
  value: (r: RunRow) => number | null;
  /** Category display labels at positions 0..n-1 (categorical only). */
  categories: string[];
  /** Single points jitter on this axis (categorical or count metric). */
  jitter: boolean;
  /** Log scaling is meaningful (false for categorical). */
  allowLog: boolean;
}

/**
 * Resolve `name` to an Axis over `rows` (the rows the plot renders — categories
 * describe the plotted set so the axis stays self-describing). Numeric metrics
 * and numeric params read continuously; categorical params ordinal-map.
 */
export function resolveAxis(name: string, index: MetricIndex, rows: RunRow[]): Axis {
  const param = PARAM_BY_NAME.get(name);

  if (param && !param.numeric) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = cellValue(r, name);
      if (v === null || v === undefined) continue;
      counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    }
    const raw = [...counts.keys()];
    raw.sort(
      param.numericSort
        ? (a, b) => Number(a) - Number(b)
        : (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    );
    const ordinal = new Map(raw.map((v, i) => [v, i]));
    const disp = param.display ?? ((v: string) => v);
    return {
      name,
      label: param.label,
      categorical: true,
      value: (r) => {
        const v = cellValue(r, name);
        if (v === null || v === undefined) return null;
        return ordinal.get(String(v)) ?? null;
      },
      categories: raw.map(disp),
      jitter: true,
      allowLog: false,
    };
  }

  // numeric parameter OR metric_schema entry
  const colId = index[name] ? metricColumnId(name, index) : name;
  const label = param?.label ?? index[name]?.label ?? name;
  // Integer-valued axes (count metrics, integer params like seed/arity) jitter
  // their stacked single points; continuous ones do not.
  const isCount = index[name]?.dtype === "count" || !!param?.integer;
  return {
    name,
    label,
    categorical: false,
    value: (r) => numericValue(r, colId),
    categories: [],
    jitter: isCount,
    allowLog: true,
  };
}
