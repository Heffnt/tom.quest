// app/boolback/lib/select.ts — pure derivations used by the panes.
//
// All functions are pure: no store access, no side effects. They operate on
// RunRow[] + FilterState/SortKey + a metric_schema index and return new arrays
// or primitives.
//
// Column addressing: a "col" is a dotted path into the RunRow nested shape (e.g.
// "headline.asr", "function.arity", "dataset.dataset", "defense.asr_drop") OR a
// bare FUNCTION complexity-metric name (e.g. "avg_sensitivity"), which resolves
// against row.function.complexity. Range filters / histograms read empirical
// [min,max] from the metric_schema index passed in.

import type {
  RunRow,
  FilterState,
  SortKey,
  FacetKey,
  MetricSchemaEntry,
  SortDir,
} from "./types";
import { fnText } from "./format";
import { METRIC_COLUMN_IDS } from "./columns";
import { METHOD_SEP, methodMetricValue, parseMethodMetric } from "./method-metrics";

export type MetricIndex = Record<string, MetricSchemaEntry>;

// ---------------------------------------------------------------------------
// Column value access
// ---------------------------------------------------------------------------

// Explicit dotted-path getters for the named scalar columns. Anything not here
// is treated as a FUNCTION complexity-metric key (row.function.complexity[col]).
const COL_GETTERS: Record<string, (r: RunRow) => string | number | boolean | null> = {
  // function
  "function.arity": (r) => r.function.arity,
  "function.fn_hex": (r) => fnText(r.function.arity, r.function.truth_table),
  "function.truth_table": (r) => r.function.truth_table,
  "function.dnf_string": (r) => r.function.dnf_string,
  // dataset (`?? source` = old-cached-blob fallback, pre-flattening)
  "dataset.dataset": (r) => r.dataset.dataset ?? r.dataset.source ?? null,
  "dataset.trigger_form": (r) => r.dataset.trigger_form,
  "dataset.target_behavior": (r) => r.dataset.target_behavior,
  "dataset.target_phrase": (r) => r.dataset.target_phrase,
  "dataset.row_distribution": (r) => r.dataset.row_distribution,
  "dataset.samples_per_row": (r) => r.dataset.samples_per_row,
  "dataset.backdoor_ratio": (r) => r.dataset.backdoor_ratio,
  "dataset.scheme": (r) => r.dataset.scheme,
  // training
  "training.base_model": (r) => r.training.base_model,
  "training.tuning": (r) => r.training.tuning,
  "training.backend": (r) => r.training.backend,
  "training.lr": (r) => r.training.lr,
  "training.epochs": (r) => r.training.epochs,
  "training.seed": (r) => r.training.seed,
  // headline / outcome
  "headline.plantedness": (r) => r.headline.plantedness,
  "headline.planted_fraction": (r) => r.headline.planted_fraction ?? null,
  "headline.asr": (r) => r.headline.asr,
  "headline.ftr": (r) => r.headline.ftr,
  "headline.triggerless_correctness": (r) => r.headline.triggerless_correctness,
  "headline.n_activating": (r) => r.headline.n_activating,
  "headline.ppl": (r) => r.headline.ppl,
  "headline.ppl_drift": (r) => r.headline.ppl_drift,
  "headline.primary_judge": (r) => r.headline.primary_judge,
  "headline.display_epoch": (r) => r.headline.display_epoch,
  // defense
  "defense.asr_drop": (r) => r.defense?.asr_drop ?? null,
  "defense.recovery_rate": (r) => r.defense?.recovery_rate ?? null,
  // interp
  "interp.reading_kind": (r) => r.interp?.reading_kind ?? null,
  "interp.value": (r) => r.interp?.value ?? null,
  "interp.null_control": (r) => r.interp?.null_control ?? null,
  // scan
  "scan.auroc": (r) => r.scan?.auroc ?? null,
  "scan.far_at_frr": (r) => r.scan?.far_at_frr ?? null,
};

/** Read a value for any column for sorting/display (string|number|bool|null).
 * Accepts dotted column ids, bare non-FUNCTION metric_schema names (range
 * filters / the chart store metrics under their schema names), and per-method
 * "<base>@<method>" names (lib/method-metrics). */
export function cellValue(row: RunRow, col: string): string | number | boolean | null {
  const getter = COL_GETTERS[col] ?? COL_GETTERS[METRIC_COLUMN_IDS[col] ?? ""];
  if (getter) return getter(row);
  if (col.includes(METHOD_SEP)) {
    const ref = parseMethodMetric(col);
    if (ref) return methodMetricValue(row, ref);
  }
  const m = row.function.complexity[col];
  return m === undefined ? null : m;
}

/** Read a numeric value for a column (null if non-numeric / absent). */
/** Derived metric id: the run's max completed training epoch (facet bins /
 *  ranges / histograms address it like any schema metric). */
export const MAX_EPOCH = "max_epoch";

export function numericValue(row: RunRow, col: string): number | null {
  if (col === MAX_EPOCH) {
    const es = row.trajectories?.completed_epochs;
    return es && es.length ? Math.max(...es) : null;
  }
  const v = cellValue(row, col);
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return typeof v === "number" ? v : null;
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

// Numeric facet values stringify (facet filters compare strings); null stays null.
const numStr = (v: number | null): string | null => (v === null ? null : String(v));

const FACET_GETTERS: Record<FacetKey, (r: RunRow) => string | null> = {
  // `?? source` = old-cached-blob fallback (pre-flattening Task×Source blobs).
  dataset: (r) => r.dataset.dataset ?? r.dataset.source ?? null,
  target_behavior: (r) => r.dataset.target_behavior,
  trigger_form: (r) => r.dataset.trigger_form,
  row_distribution: (r) => r.dataset.row_distribution,
  scheme: (r) => r.dataset.scheme,
  target_phrase: (r) => r.dataset.target_phrase,
  samples_per_row: (r) => numStr(r.dataset.samples_per_row),
  backdoor_ratio: (r) => numStr(r.dataset.backdoor_ratio),
  base_model: (r) => r.training.base_model,
  tuning: (r) => r.training.tuning,
  backend: (r) => r.training.backend,
  lr: (r) => numStr(r.training.lr),
  epochs: (r) => numStr(r.training.epochs),
  seed: (r) => numStr(r.training.seed),
  judge: (r) => r.headline.primary_judge,
  split: (r) => r.per_judge.find((j) => j.is_primary)?.split ?? r.per_judge[0]?.split ?? null,
  arity: (r) => String(r.function.arity),
};

export const FACET_KEYS = Object.keys(FACET_GETTERS) as FacetKey[];

/** UI labels for the facet keys (shared by filter bar, chips, exports). Keys
 *  are CMT tidy snake_case; "split" is the train/test eval split. */
export const FACET_LABELS: Record<FacetKey, string> = {
  dataset: "Dataset",
  target_behavior: "Target",
  trigger_form: "Trigger",
  row_distribution: "Row dist.",
  scheme: "Scheme",
  target_phrase: "Target phrase",
  samples_per_row: "Samples/row",
  backdoor_ratio: "Backdoor ratio",
  base_model: "Model",
  tuning: "Tuning",
  backend: "Backend",
  lr: "LR",
  epochs: "Epochs",
  seed: "Seed",
  judge: "Judge",
  split: "train/test",
  arity: "Arity",
};

/** The facet value of one row (e.g. facetValue(r, "tuning") -> "lora-r16"). */
export function facetValue(row: RunRow, key: FacetKey): string | null {
  return FACET_GETTERS[key](row);
}

// Column id -> the facet its values filter on (drives the hover-funnel in
// categorical cells: click a cell value to add it to that facet).
const FACET_BY_COLUMN: Record<string, FacetKey> = {
  "dataset.dataset": "dataset",
  "dataset.target_behavior": "target_behavior",
  "dataset.trigger_form": "trigger_form",
  "dataset.row_distribution": "row_distribution",
  "dataset.scheme": "scheme",
  "dataset.target_phrase": "target_phrase",
  "dataset.samples_per_row": "samples_per_row",
  "dataset.backdoor_ratio": "backdoor_ratio",
  "training.base_model": "base_model",
  "training.tuning": "tuning",
  "training.backend": "backend",
  "training.lr": "lr",
  "training.epochs": "epochs",
  "training.seed": "seed",
  "headline.primary_judge": "judge",
  "function.arity": "arity",
};

export function facetKeyForColumn(colId: string): FacetKey | null {
  return FACET_BY_COLUMN[colId] ?? null;
}

/** Distinct facet values present in the data, sorted, with counts. */
export function facetOptions(
  rows: RunRow[],
  key: FacetKey,
): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = FACET_GETTERS[key](r);
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Facet filters pinning every facet parameter to its single most-common value
 *  over `rows` (the dominant experimental cell). A facet with < 2 distinct
 *  values is left unpinned (constant — no need). The `function` parameter has
 *  no facet key and is never pinned (it is the science / X sweep axis). */
export function dominantFilters(rows: RunRow[]): FilterState {
  const facets: FilterState["facets"] = {};
  for (const key of FACET_KEYS) {
    const opts = facetOptions(rows, key);
    if (opts.length < 2) continue; // constant / absent — nothing to declutter
    // Highest count wins; ties keep the first in facetOptions' value order
    // (strict `>` so the earliest maximum sticks — deterministic).
    let best = opts[0];
    for (const o of opts) if (o.count > best.count) best = o;
    facets[key] = [best.value];
  }
  return { facets, ranges: [] };
}

// ---------------------------------------------------------------------------
// Pin auto-repair (the cascade). After a facet edit narrows the data, other
// pinned facets can end up matching zero rows; repairPins re-pins each stale
// one to its single most-frequent compatible value so the plot never goes
// blank. Walks the facet registry (FACET_KEYS) cumulatively — later keys see
// earlier repairs — so a whole dependency chain (dataset → target → judge)
// follows one edit. Ranges and unpinned facets are never touched.
//
// NOTE: this walks select's own FACET_KEYS rather than importing the PARAMETERS
// registry — a select→parameters import would form a cycle (parameters imports
// select at module-init for FACET_LABELS), so select stays a dependency leaf.
// NUMERIC_FACETS mirrors parameters.ts `numericSort` purely for tie-breaking.
// ---------------------------------------------------------------------------

/** Facet keys whose values order numerically (mirror of parameters.numericSort;
 *  duplicated to keep select.ts free of a parameters import cycle). */
const NUMERIC_FACETS: ReadonlySet<FacetKey> = new Set<FacetKey>([
  "arity", "samples_per_row", "backdoor_ratio", "lr", "epochs", "seed",
]);

/** The single most-frequent facet value over `rs` (ties by the dim's sort);
 *  null when the key is null on every row. */
function dominantValue(rs: RunRow[], key: FacetKey): string | null {
  const counts = new Map<string, number>();
  for (const r of rs) {
    const v = FACET_GETTERS[key](r);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const numeric = NUMERIC_FACETS.has(key);
  return [...counts.entries()].sort((a, b) =>
    b[1] !== a[1]
      ? b[1] - a[1]
      : numeric
        ? Number(a[0]) - Number(b[0])
        : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )[0][0];
}

/**
 * Pin auto-repair (the cascade). After an edit to `editedKey`: if the full
 * cell still matches ANY row, every pin is jointly fine and NOTHING moves —
 * the cascade never overrides a choice that still works. When the cell went
 * empty, rebuild it CUMULATIVELY around the edited pin (+ the untouched
 * ranges): walking the other pinned facets in registry order, a pin that fits
 * the rebuilt-so-far cell is kept verbatim; a stale one re-pins to the single
 * most-frequent value under that cell (or unpins entirely when the key is
 * null there — a dead pin must not re-deadlock the cell). The cumulative walk
 * is what handles MUTUALLY stale pins: switching dataset re-pins target
 * against the dataset alone, then target_phrase against dataset+target, and
 * so on. Unpinned facets stay unpinned; ranges are never touched. Returns the
 * repaired filters + which keys moved.
 */
export function repairPins(
  rows: RunRow[],
  filters: FilterState,
  editedKey: FacetKey,
): { filters: FilterState; repaired: FacetKey[] } {
  if (applyFilters(rows, filters).length > 0) return { filters, repaired: [] };

  // Seed: the edited pin + ranges. An edit that matches nothing by itself has
  // no sensible cell to rebuild toward — leave everything alone.
  const editedSel = filters.facets[editedKey];
  let kept: FilterState = {
    facets: editedSel && editedSel.length ? { [editedKey]: editedSel } : {},
    ranges: filters.ranges,
  };
  if (applyFilters(rows, kept).length === 0) return { filters, repaired: [] };

  const repaired: FacetKey[] = [];
  const outFacets = { ...filters.facets };
  for (const key of FACET_KEYS) {
    if (key === editedKey) continue;
    const sel = filters.facets[key];
    if (!sel || sel.length === 0) continue; // unpinned — stays unpinned

    // the existing pin fits the rebuilt cell → keep it verbatim
    const withPin: FilterState = { facets: { ...kept.facets, [key]: sel }, ranges: kept.ranges };
    if (applyFilters(rows, withPin).length > 0) {
      kept = withPin;
      continue;
    }

    // stale → the dominant value under the rebuilt cell (or unpin when none)
    const best = dominantValue(applyFilters(rows, kept), key);
    outFacets[key] = best === null ? [] : [best];
    if (best !== null) {
      kept = { facets: { ...kept.facets, [key]: [best] }, ranges: kept.ranges };
    }
    repaired.push(key);
  }
  return { filters: { facets: outFacets, ranges: filters.ranges }, repaired };
}

// ---------------------------------------------------------------------------
// Table search (repurposed: find runs by PATH FRAGMENT, not a filter
// alternative). The haystack is run_id + dir_path + node_path ONLY — the old
// facet-value / fn-text haystack is gone. `search` lives on the TABLE config;
// it is applied on top of applyFilters by the table pane, never a FilterState
// field.
// ---------------------------------------------------------------------------

const HAYSTACKS = new WeakMap<RunRow, string>();

function haystack(r: RunRow): string {
  const hit = HAYSTACKS.get(r);
  if (hit !== undefined) return hit;
  const parts: Array<string | null> = [
    r.identity.run_id,
    r.identity.dir_path,
    r.identity.node_path,
  ];
  const s = parts.filter(Boolean).join(" ").toLowerCase();
  HAYSTACKS.set(r, s);
  return s;
}

/** True iff every whitespace-separated token of `query` appears in the row's
 *  path haystack (run_id / dir_path / node_path). Empty query = match. */
export function matchesSearch(row: RunRow, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const h = haystack(row);
  return tokens.every((t) => h.includes(t));
}

// ---------------------------------------------------------------------------
// Filtering — facets AND ranges only (status flags and subtree scope are gone).
// ---------------------------------------------------------------------------

/** Apply the slimmed FilterState (facets AND ranges). */
export function applyFilters(rows: RunRow[], filters: FilterState): RunRow[] {
  // Defensive against a partial/stale persisted shape (a saved view could be
  // missing a sub-key); never let it crash the whole table.
  const ranges = filters.ranges ?? [];
  const facetEntries = Object.entries(filters.facets ?? {}).filter(
    ([, vals]) => Array.isArray(vals) && vals.length > 0,
  ) as Array<[FacetKey, string[]]>;

  return rows.filter((r) => {
    // facets (each facet OR within, AND across)
    for (const [key, vals] of facetEntries) {
      const v = FACET_GETTERS[key](r);
      if (v === null || !vals.includes(v)) return false;
    }

    // ranges (AND-composed)
    for (const range of ranges) {
      const v = numericValue(r, range.metric);
      if (v === null) return false;
      if (v < range.min || v > range.max) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Stable multi-key sort. Nulls sort last regardless of direction. */
export function applySorts(rows: RunRow[], sorts: SortKey[]): RunRow[] {
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

function compareCol(a: RunRow, b: RunRow, col: string, dir: SortDir): number {
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
// Range / histogram backing (reads empirical [min,max] from metric_schema)
// ---------------------------------------------------------------------------

function schemaRange(
  index: MetricIndex,
  metric: string,
): { min: number; max: number } | null {
  const e = index[metric];
  if (!e || e.min === null || e.max === null) return null;
  return { min: e.min, max: e.max };
}

function dataExtent(rows: RunRow[], metric: string): { min: number; max: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    const v = numericValue(r, metric);
    if (v === null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { min: 0, max: 1 };
  return { min: lo, max: hi };
}

/** Known display range for a metric (schema min/max, falls back to data extent). */
export function metricRange(
  rows: RunRow[],
  metric: string,
  index: MetricIndex,
): { min: number; max: number } {
  return schemaRange(index, metric) ?? dataExtent(rows, metric);
}

/** Bin the values of `metric` over `rows` into `nBins` counts. */
export function histogramBins(
  rows: RunRow[],
  metric: string,
  nBins: number,
  index: MetricIndex,
): number[] {
  const n = Math.max(1, nBins);
  const bins = new Array<number>(n).fill(0);
  const { min: lo, max: hi } = metricRange(rows, metric, index);
  const span = hi - lo || 1;
  for (const r of rows) {
    const v = numericValue(r, metric);
    if (v === null) continue;
    let idx = Math.floor(((v - lo) / span) * n);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    bins[idx]++;
  }
  return bins;
}

/** Normalize a value to [0,1] against the metric's range (for mini-bars). */
export function normalizeToRange(
  metric: string,
  value: number,
  index: MetricIndex,
): number {
  const r = schemaRange(index, metric) ?? { min: 0, max: 1 };
  const span = r.max - r.min || 1;
  const t = (value - r.min) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Count summary "N of M" for the filter bar. */
export function countSummary(visible: number, total: number): string {
  return `${visible} of ${total}`;
}
