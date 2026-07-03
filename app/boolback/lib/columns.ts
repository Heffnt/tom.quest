// app/boolback/lib/columns.ts
//
// The bridge between the builder's column_groups (which name columns BARE, e.g.
// "arity", "asr", "asr_drop", "interp_measurement", "scan_auroc") and the
// internal column-id surface used by select.ts cellValue/numericValue (dotted
// paths like "headline.asr" / "defense.asr_drop", and bare FUNCTION complexity
// names that resolve against function.complexity).
//
// This is the single source of truth for that mapping plus per-column render
// metadata (label, render kind, whether a numeric mini-bar applies, and the
// metric-schema name a bar/range should normalize against). Everything the
// table renders flows through resolveColumn(); the column-group menu enumerates
// bundle.column_groups and resolves each entry the same way, so the two can
// never drift.

import type { Bundle, MetricSchemaEntry } from "./types";

export type ColKind =
  | "truthStrip" // FUNCTION.truth_table -> the box strip (no binary string)
  | "fnHex" // synthetic compact "arity:hex" text; hover -> DNF + strip
  | "dnf" // FUNCTION.dnf_string -> simplified DNF text
  | "categorical" // string-valued (source/task/model/judge/…)
  | "numeric" // numeric scalar; mini-bar opt-in
  | "outcome" // numeric OUTCOME metric; hover -> epoch sparkline
  | "text"; // free numeric/string with no bar (seed, epochs, n_activating)

export interface ColumnDef {
  /** Internal id passed to select.cellValue/numericValue and used as sort col. */
  id: string;
  /** Bare name as it appears in bundle.column_groups (for menu round-trip). */
  colName: string;
  group: string; // FUNCTION / DATASET / TRAINING / OUTCOME / DEFENSE / INTERP / SCAN
  label: string;
  kind: ColKind;
  /** metric_schema name to normalize a mini-bar / range against (if numeric). */
  metricName?: string;
  /** If this outcome cell has an epoch trajectory, which Trajectories key. */
  trajectoryKey?: "plantedness" | "asr" | "ftr" | "ppl";
}

// Bare-name -> dotted internal id, per group. FUNCTION complexity metrics are
// NOT listed here: any FUNCTION bare name that is not truth_table/dnf_string
// resolves to itself (a complexity key), which select.cellValue reads from
// function.complexity.
const DATASET_PATHS: Record<string, string> = {
  source: "dataset.source",
  task: "dataset.task",
  trigger_form: "dataset.trigger_form",
  target_behavior: "dataset.target_behavior",
  target_phrase: "dataset.target_phrase",
  row_distribution: "dataset.row_distribution",
  samples_per_row: "dataset.samples_per_row",
  backdoor_ratio: "dataset.backdoor_ratio",
  scheme: "dataset.scheme",
};

const TRAINING_PATHS: Record<string, string> = {
  base_model: "training.base_model",
  tuning: "training.tuning",
  backend: "training.backend",
  lr: "training.lr",
  epochs: "training.epochs",
  seed: "training.seed",
};

const OUTCOME_PATHS: Record<string, string> = {
  plantedness: "headline.plantedness",
  asr: "headline.asr",
  ftr: "headline.ftr",
  triggerless_correctness: "headline.triggerless_correctness",
  n_activating: "headline.n_activating",
  ppl: "headline.ppl",
  ppl_drift: "headline.ppl_drift",
};

// OUTCOME metric_schema entry names (for bar normalization) match the bare name.
const OUTCOME_TRAJECTORY: Record<string, ColumnDef["trajectoryKey"]> = {
  plantedness: "plantedness",
  asr: "asr",
  ftr: "ftr",
  ppl: "ppl",
};

const DEFENSE_PATHS: Record<string, string> = {
  asr_drop: "defense.asr_drop",
  recovery_rate: "defense.recovery_rate",
};

// INTERP bare names from column_groups are interp_measurement / interp_null_control.
const INTERP_PATHS: Record<string, string> = {
  interp_measurement: "interp.value",
  interp_null_control: "interp.null_control",
};

const SCAN_PATHS: Record<string, string> = {
  scan_auroc: "scan.auroc",
  scan_far_at_frr: "scan.far_at_frr",
};

const CATEGORICAL_IDS = new Set<string>([
  "dataset.source",
  "dataset.task",
  "dataset.trigger_form",
  "dataset.target_behavior",
  "dataset.target_phrase",
  "dataset.row_distribution",
  "dataset.scheme",
  "training.base_model",
  "training.tuning",
  "training.backend",
]);

// Numeric scalars rendered as plain text (no mini-bar): identifiers / counts
// where a normalized bar is meaningless.
const PLAIN_NUMERIC_IDS = new Set<string>([
  "training.lr",
  "training.epochs",
  "training.seed",
  "dataset.samples_per_row",
  "dataset.backdoor_ratio",
  "headline.n_activating",
]);

function labelFromSchema(
  index: Record<string, MetricSchemaEntry>,
  metricName: string,
  fallback: string,
): string {
  return index[metricName]?.label ?? fallback;
}

function titleCase(s: string): string {
  return s
    .split(/[_.]/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Resolve a (group, bare colName) pair into a full ColumnDef. `index` is the
 * metric_schema index (lib/metrics.indexMetricSchema). Friendly labels prefer
 * the metric_schema label where one exists.
 */
export function resolveColumn(
  group: string,
  colName: string,
  index: Record<string, MetricSchemaEntry>,
): ColumnDef {
  // FUNCTION group: truth_table / dnf_string are special; everything else is a
  // complexity metric resolved by its bare name.
  if (group === "FUNCTION") {
    if (colName === "fn_hex") {
      return { id: "function.fn_hex", colName, group, label: "Fn", kind: "fnHex" };
    }
    if (colName === "truth_table") {
      return { id: "function.truth_table", colName, group, label: "Truth table", kind: "truthStrip" };
    }
    if (colName === "dnf_string") {
      return { id: "function.dnf_string", colName, group, label: "DNF", kind: "dnf" };
    }
    if (colName === "arity") {
      return { id: "function.arity", colName, group, label: "Arity", kind: "text" };
    }
    // complexity metric — bare name resolves against function.complexity
    const entry = index[colName];
    return {
      id: colName,
      colName,
      group,
      label: entry?.label ?? titleCase(colName),
      kind: "numeric",
      metricName: colName,
    };
  }

  const pathTable: Record<string, string> | null =
    group === "DATASET" ? DATASET_PATHS
      : group === "TRAINING" ? TRAINING_PATHS
        : group === "OUTCOME" ? OUTCOME_PATHS
          : group === "DEFENSE" ? DEFENSE_PATHS
            : group === "INTERP" ? INTERP_PATHS
              : group === "SCAN" ? SCAN_PATHS
                : null;

  const id = pathTable?.[colName] ?? colName;

  if (group === "OUTCOME") {
    return {
      id,
      colName,
      group,
      label: labelFromSchema(index, colName, titleCase(colName)),
      kind: PLAIN_NUMERIC_IDS.has(id) ? "text" : "outcome",
      metricName: colName,
      trajectoryKey: OUTCOME_TRAJECTORY[colName],
    };
  }

  if (group === "DEFENSE" || group === "INTERP" || group === "SCAN") {
    return {
      id,
      colName,
      group,
      label: labelFromSchema(index, colName, titleCase(colName)),
      kind: "numeric",
      metricName: colName,
    };
  }

  // DATASET / TRAINING
  if (CATEGORICAL_IDS.has(id)) {
    return { id, colName, group, label: titleCase(colName), kind: "categorical" };
  }
  return { id, colName, group, label: titleCase(colName), kind: "text" };
}

/** metric_schema name -> the column id select.numericValue understands. */
export function metricColumnId(
  name: string,
  index: Record<string, MetricSchemaEntry>,
): string {
  const entry = index[name];
  if (!entry || entry.group === "FUNCTION") return name;
  return resolveColumn(entry.group, name, index).id;
}

/** Resolve a stored visibleCols entry (an internal id) back to its ColumnDef. */
export function resolveById(
  id: string,
  bundle: Bundle,
  index: Record<string, MetricSchemaEntry>,
): ColumnDef {
  for (const grp of bundle.column_groups) {
    for (const colName of grp.columns) {
      const def = resolveColumn(grp.group, colName, index);
      if (def.id === id) return def;
    }
  }
  // Unknown id: best-effort as a complexity / text column.
  const entry = index[id];
  if (entry) {
    return { id, colName: id, group: entry.group, label: entry.label, kind: "numeric", metricName: id };
  }
  return { id, colName: id, group: "FUNCTION", label: titleCase(id), kind: "text" };
}

/** All resolved ColumnDefs for a bundle, grouped, in builder order. */
export function allColumnDefs(
  bundle: Bundle,
  index: Record<string, MetricSchemaEntry>,
): Array<{ group: string; columns: ColumnDef[] }> {
  return bundle.column_groups.map((grp) => ({
    group: grp.group,
    columns: grp.columns.map((c) => resolveColumn(grp.group, c, index)),
  }));
}
