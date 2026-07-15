// app/boolback/lib/parameters.ts — the plot's parameter model.
//
// A run is identified by PARAMETERS (function identity + every dataset/training
// facet + judge/split); X and Y are readings over them. For a given row set
// each parameter is either SHARED (one distinct value — the context every
// plotted point has in common) or DIFFERING. A differing parameter is either
//
//   split — named in the plot config's splitBy, so each of its values gets
//     its own series within every setting (lib/split-dims.resolveSeries);
//   selected — pinned by a SETTING's filters (facet selections); or
//   pooled — left varying inside each series (everything else).

import type { RunRow, FacetKey, FilterState, RangeFilter } from "./types";
import { facetValue, FACET_LABELS, applyFilters } from "./select";
import { fnText, shortModel } from "./format";

/** Origin bucket for the config panel's collapsible parameter sections. */
export type ParamSection = "function" | "dataset" | "training" | "judge";

export interface ParameterDef {
  key: string;
  label: string;
  /** RAW grouping/filter value (stringified); null = missing on the row. */
  raw: (r: RunRow) => string | null;
  /** Pretty rendering of a raw value (defaults to identity). */
  display?: (v: string) => string;
  /** Order values numerically (arity, seed, lr, …) instead of lexically. */
  numericSort?: boolean;
  /** Filter action target: a facet key. The `function` parameter has none in
   *  Phase 1 (fn= subtree scope removed; it becomes an ordinary parameter
   *  filter over function identity in a later phase), so its filter UI is
   *  inert for now. */
  facetKey?: FacetKey;
  /** Which origin section the config panel groups this parameter under. */
  section: ParamSection;
}

const facetParam = (
  facetKey: FacetKey,
  section: ParamSection,
  opts: Partial<ParameterDef> = {},
): ParameterDef => ({
  key: facetKey,
  label: FACET_LABELS[facetKey],
  raw: (r) => facetValue(r, facetKey),
  facetKey,
  section,
  ...opts,
});

/** Every parameter, in display order (the summary re-orders differing ones). */
export const PARAMETERS: ParameterDef[] = [
  {
    key: "function",
    label: "Function",
    raw: (r) => fnText(r.function.arity, r.function.truth_table),
    section: "function",
  },
  facetParam("arity", "function", { numericSort: true }),
  facetParam("dataset", "dataset"),
  facetParam("trigger_form", "dataset"),
  facetParam("target_behavior", "dataset"),
  facetParam("target_phrase", "dataset"),
  facetParam("row_distribution", "dataset"),
  facetParam("scheme", "dataset"),
  facetParam("samples_per_row", "dataset", { numericSort: true }),
  facetParam("backdoor_ratio", "dataset", { numericSort: true }),
  facetParam("base_model", "training", { display: shortModel }),
  facetParam("tuning", "training"),
  facetParam("backend", "training"),
  facetParam("lr", "training", { numericSort: true }),
  facetParam("epochs", "training", { numericSort: true }),
  facetParam("seed", "training", { numericSort: true }),
  facetParam("judge", "judge"),
  facetParam("split", "judge"),
];

// ---------------------------------------------------------------------------
// Parameter tiers + nesting — the settings editor's grouping model. A
// "setting" parameter defines an experimental condition; a "sweep" parameter
// is a training-sweep axis; "function" is the complexity axis. NESTED_UNDER
// records the CMT dependency edges: target_phrase and judge are consequences
// of the target_behavior choice, so the editor nests them under it.
// ---------------------------------------------------------------------------

export type ParamTier = "setting" | "sweep" | "function";

export const PARAM_TIERS: Record<string, ParamTier> = {
  function: "function",
  arity: "setting",
  dataset: "setting",
  target_behavior: "setting",
  target_phrase: "setting",
  trigger_form: "setting",
  row_distribution: "setting",
  scheme: "setting",
  samples_per_row: "setting",
  backdoor_ratio: "setting",
  judge: "setting",
  split: "setting",
  base_model: "sweep",
  tuning: "sweep",
  backend: "sweep",
  lr: "sweep",
  epochs: "sweep",
  seed: "sweep",
};

/** Parameter key → the setting parameter it is a consequence of. */
export const NESTED_UNDER: Record<string, string> = {
  target_phrase: "target_behavior",
  judge: "target_behavior",
};

/** Editor section order (settings editor): condition first, then sweep axes. */
export const TIER_ORDER: ParamTier[] = ["setting", "sweep", "function"];

/** Sentence-case section titles for the editor's tier sections. */
export const TIER_LABEL: Record<ParamTier, string> = {
  setting: "Setting",
  sweep: "Sweep",
  function: "Function",
};

/** One editor row: a top-level parameter plus its NESTED_UNDER children. */
export interface TierEntry {
  dim: ParameterDef;
  /** Parameters nested (indented) under this one, in input order. */
  children: ParameterDef[];
}

/**
 * Group `dims` (in desired display order) into tier sections per PARAM_TIERS,
 * nesting each NESTED_UNDER child under its parent WHEN the parent is also
 * present; an orphaned child renders top-level in its own tier. Empty
 * sections are dropped. Pure — unit-tested.
 */
export function tierSections(
  dims: ParameterDef[],
): Array<{ tier: ParamTier; entries: TierEntry[] }> {
  const present = new Set(dims.map((d) => d.key));
  const childrenOf = new Map<string, ParameterDef[]>();
  const topLevel: ParameterDef[] = [];
  for (const d of dims) {
    const parent = NESTED_UNDER[d.key];
    if (parent !== undefined && present.has(parent)) {
      const list = childrenOf.get(parent);
      if (list) list.push(d);
      else childrenOf.set(parent, [d]);
    } else {
      topLevel.push(d);
    }
  }
  return TIER_ORDER.map((tier) => ({
    tier,
    entries: topLevel
      .filter((d) => (PARAM_TIERS[d.key] ?? "setting") === tier)
      .map((dim) => ({ dim, children: childrenOf.get(dim.key) ?? [] })),
  })).filter((s) => s.entries.length > 0);
}

/**
 * Standard faceted-search counting for one parameter's value list: DROP the
 * parameter's own facet from `filters`, apply every OTHER facet + the
 * filters' own ranges + `extraRanges` (the plot-level ranges), then count
 * `dim.raw` over the surviving rows. Values observed globally but absent
 * here are simply missing from the map (render them as 0 / muted). Pure.
 */
export function conditionedCounts(
  rows: RunRow[],
  dim: ParameterDef,
  filters: FilterState,
  extraRanges: RangeFilter[] = [],
): Map<string, number> {
  const facets = { ...(filters.facets ?? {}) };
  if (dim.facetKey) delete facets[dim.facetKey];
  const conditioned = applyFilters(rows, {
    facets,
    ranges: [...(filters.ranges ?? []), ...extraRanges],
  });
  const counts = new Map<string, number>();
  for (const r of conditioned) {
    const v = dim.raw(r);
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

export interface ParamValues {
  dim: ParameterDef;
  /** Distinct raw values with counts, value-sorted (numeric-aware). */
  values: Array<{ value: string; count: number }>;
}

/**
 * Chip DISPLAY order for a parameter's value list: DESCENDING run count (the
 * conditioned count each value carries under the current filters), so the
 * frequently-run + dominant (checked-by-default) values sit at the top and rare
 * one-offs fall to the bottom. STABLE — ties keep `values`' incoming order
 * (numeric for numericSort params, else lexical), so the sort stays
 * deterministic. Display-only: does NOT touch resolveSeries' combo ordering or
 * summarizeParameters' `differing` biggest-split-first ordering. Pure.
 */
export function orderValuesByCount(
  values: Array<{ value: string; count: number }>,
  counts: ReadonlyMap<string, number>,
): Array<{ value: string; count: number }> {
  return [...values].sort((a, b) => (counts.get(b.value) ?? 0) - (counts.get(a.value) ?? 0));
}

export interface ParamSummary {
  /** One distinct value across every row — the points' common context. */
  shared: Array<{ dim: ParameterDef; value: string }>;
  /** More than one value — sorted biggest split first (then param order). */
  differing: ParamValues[];
}

export function summarizeParameters(rows: RunRow[]): ParamSummary {
  const shared: ParamSummary["shared"] = [];
  const differing: ParamValues[] = [];
  for (const dim of PARAMETERS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = dim.raw(r);
      if (v === null) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size === 0) continue; // parameter absent from this data
    const values = [...counts.entries()].map(([value, count]) => ({ value, count }));
    values.sort(
      dim.numericSort
        ? (a, b) => Number(a.value) - Number(b.value)
        : (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
    if (values.length === 1) shared.push({ dim, value: values[0].value });
    else differing.push({ dim, values });
  }
  differing.sort((a, b) => b.values.length - a.values.length);
  return { shared, differing };
}
