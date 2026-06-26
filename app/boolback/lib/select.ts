// app/boolback/lib/select.ts — pure derivations used by the panes.
//
// All functions are pure: no store access, no side effects. They operate on
// ExperimentRow[] + FilterState/SortKey and return new arrays / primitives.

import type {
  ExperimentRow, FilterState, SortKey, FacetKey, StatusFlag,
} from "./types";
import { METRIC_META } from "./metrics";

// ---------------------------------------------------------------------------
// Column value access (friendly column OR metric key)
// ---------------------------------------------------------------------------

// Columns that live directly on ExperimentRow (outcomes + categoricals).
const ROW_SCALAR_COLS = new Set<string>([
  "asr", "ftr", "triggerlessCorrectness", "stealthRate", "ppl", "pplDrift",
  "plantedEpoch", "seedN", "arity",
]);

/** Read a numeric value for a column (ExperimentRow scalar OR metric key). */
export function numericValue(row: ExperimentRow, col: string): number | null {
  if (ROW_SCALAR_COLS.has(col)) {
    const v = (row as unknown as Record<string, unknown>)[col];
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return typeof v === "number" ? v : null;
  }
  const m = row.metrics[col];
  if (m === undefined) return null;
  return typeof m === "boolean" ? (m ? 1 : 0) : m;
}

/** Read a value for any column for sorting/display (string|number|bool|null). */
export function cellValue(row: ExperimentRow, col: string): string | number | boolean | null {
  if (col in row && !ROW_SCALAR_COLS.has(col)) {
    const v = (row as unknown as Record<string, unknown>)[col];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (v === null) return null;
  }
  if (ROW_SCALAR_COLS.has(col)) {
    const v = (row as unknown as Record<string, unknown>)[col];
    return (v as number | null) ?? null;
  }
  const m = row.metrics[col];
  return m === undefined ? null : m;
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

const FACET_GETTERS: Record<FacetKey, (r: ExperimentRow) => string> = {
  task: (r) => r.task,
  source: (r) => r.source,
  targetBehavior: (r) => r.targetBehavior,
  triggerForm: (r) => r.triggerForm,
  rowDistribution: (r) => r.rowDistribution,
  baseModel: (r) => r.baseModel,
  tuning: (r) => r.tuning,
  judge: (r) => r.judge,
  split: (r) => r.split,
  arity: (r) => String(r.arity),
};

export const FACET_KEYS = Object.keys(FACET_GETTERS) as FacetKey[];

/** Distinct facet values present in the data, sorted, with counts. */
export function facetOptions(
  rows: ExperimentRow[], key: FacetKey,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = FACET_GETTERS[key](r);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Status predicates
// ---------------------------------------------------------------------------

const STATUS_PREDS: Record<StatusFlag, (r: ExperimentRow) => boolean> = {
  plantedOnly: (r) => r.planted,
  neverPlanted: (r) => !r.planted,
  inProgress: (r) => r.inProgress,
  hasDefense: (r) => r.hasDefense,
  hasTwin: (r) => r.hasTwin,
  hasNegativeDrop: (r) => r.hasNegativeDrop,
  heuristicProvenance: (r) => r.heuristicProvenance,
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Apply the full FilterState (facets AND ranges AND status AND text AND scope). */
export function applyFilters(rows: ExperimentRow[], filters: FilterState): ExperimentRow[] {
  const text = filters.text.trim().toLowerCase();
  const facetEntries = Object.entries(filters.facets).filter(
    ([, vals]) => Array.isArray(vals) && vals.length > 0,
  ) as Array<[FacetKey, string[]]>;

  return rows.filter((r) => {
    // scope: row must include scopeDir in its chain
    if (filters.scopeDir && !r.chainDirs.includes(filters.scopeDir)) return false;

    // facets (each facet OR within, AND across)
    for (const [key, vals] of facetEntries) {
      if (!vals.includes(FACET_GETTERS[key](r))) return false;
    }

    // ranges (AND-composed)
    for (const range of filters.ranges) {
      const v = numericValue(r, range.metric);
      if (v === null) return false;
      if (v < range.min || v > range.max) return false;
    }

    // status (AND-composed)
    for (const s of filters.status) {
      if (!STATUS_PREDS[s](r)) return false;
    }

    // text: substring over truthTable/slug-ish/hash/friendly
    if (text) {
      const hay = [
        r.truthTable, r.scoringDir, r.functionHash, r.source, r.triggerForm,
        r.targetBehavior, r.baseModel, r.tuning, r.judge, r.task,
      ].join(" ").toLowerCase();
      if (!hay.includes(text)) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Stable multi-key sort. Nulls sort last regardless of direction. */
export function applySorts(rows: ExperimentRow[], sorts: SortKey[]): ExperimentRow[] {
  if (sorts.length === 0) return rows;
  const indexed = rows.map((row, i) => ({ row, i }));
  indexed.sort((a, b) => {
    for (const { col, dir } of sorts) {
      const cmp = compareCol(a.row, b.row, col, dir);
      if (cmp !== 0) return cmp;
    }
    return a.i - b.i; // stable
  });
  return indexed.map((x) => x.row);
}

function compareCol(a: ExperimentRow, b: ExperimentRow, col: string, dir: "asc" | "desc"): number {
  const va = cellValue(a, col);
  const vb = cellValue(b, col);
  // nulls always last
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  let cmp: number;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else if (typeof va === "boolean" && typeof vb === "boolean") cmp = (va ? 1 : 0) - (vb ? 1 : 0);
  else cmp = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
  return dir === "asc" ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Histograms (for the range-slider distribution backing)
// ---------------------------------------------------------------------------

/**
 * Bin the values of `metric` over `rows` into `nBins` counts. Uses the
 * known-range [min,max] from METRIC_META when available, else the data extent.
 */
export function histogramBins(
  rows: ExperimentRow[], metric: string, nBins: number,
): number[] {
  const bins = new Array(Math.max(1, nBins)).fill(0);
  const meta = METRIC_META[metric];
  let lo: number, hi: number;
  if (meta) { lo = meta.min; hi = meta.max; }
  else {
    lo = Infinity; hi = -Infinity;
    for (const r of rows) {
      const v = numericValue(r, metric);
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  }
  const span = hi - lo || 1;
  for (const r of rows) {
    const v = numericValue(r, metric);
    if (v === null) continue;
    let idx = Math.floor(((v - lo) / span) * nBins);
    if (idx < 0) idx = 0;
    if (idx >= nBins) idx = nBins - 1;
    bins[idx]++;
  }
  return bins;
}

/** Known display range for a metric (falls back to data extent). */
export function metricRange(rows: ExperimentRow[], metric: string): { min: number; max: number } {
  const meta = METRIC_META[metric];
  if (meta) return { min: meta.min, max: meta.max };
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) {
    const v = numericValue(r, metric);
    if (v === null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { min: 0, max: 1 };
  return { min: lo, max: hi };
}

/**
 * Normalize a value to [0,1] against the metric's known range (for mini-bars).
 */
export function normalizeToRange(metric: string, value: number): number {
  const meta = METRIC_META[metric];
  const lo = meta?.min ?? 0;
  const hi = meta?.max ?? 1;
  const span = hi - lo || 1;
  const t = (value - lo) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ---------------------------------------------------------------------------
// Chain path / DropSpec helpers
// ---------------------------------------------------------------------------

/**
 * The ordered dirName chain (root->scoring) for an experiment row. `index` is
 * accepted for call-site symmetry with table rows; the chain is already stored.
 */
export function chainPathFor(row: ExperimentRow): string[] {
  return row.chainDirs;
}

/**
 * Copy-as-DropSpec: the per-experiment cut as a stable group_key JSON. `scope`
 * is the scope dirName (or null for the whole table). The shape mirrors the
 * analysis-side DropSpec (drop every *.seed for the per-experiment cut).
 */
export function dropSpecJSON(scope: string | null): string {
  const spec = {
    cut: "per_experiment",
    drop: ["dataset.seed", "training.seed", "inference.seed"],
    scope: scope ?? "all",
  };
  return JSON.stringify(spec, null, 2);
}

/** Count summary "N of M" for the filter bar. */
export function countSummary(visible: number, total: number): string {
  return `${visible} of ${total}`;
}

// Re-export so panes have a single import surface for known-range metadata.
export { METRIC_META };
