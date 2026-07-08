// app/boolback/lib/presets.ts — tolerant hydration of saved filter sets / views.
//
// A preset must NEVER crash the page: unknown keys are ignored, missing keys
// defaulted, and each config runs through its sanitizer so a hand-corrupted or
// stale blob applies PARTIALLY rather than throwing.
//
// NOTE (Phase 1): this is the interim shape. Phase 5 replaces presets with the
// text VIEW-SPEC (one kind, {name, spec}); the Convex query/table are left
// intact here so nothing breaks in the meantime — only the in-memory shapes
// were re-pointed at the new per-view configs.

import type {
  FilterState, PlotConfig, GroupPlotConfig, TableConfig,
} from "./types";
import {
  sanitizeFilters, sanitizePlotConfig, sanitizeGroupPlotConfig, sanitizeTableConfig,
} from "./types";
import type { CenterView } from "../components/table-pane";

export type PresetKind = "filters" | "view";
export const PRESET_SCHEMA_VERSION = 2;

/** kind=filters: just a FilterState (applied to the active view). */
export interface FiltersPresetState {
  filters: FilterState;
}
/** kind=view: a full workspace snapshot (all three configs + which view). */
export interface ViewPresetState {
  centerView: CenterView;
  table: TableConfig;
  plot: PlotConfig;
  groupPlot: GroupPlotConfig;
}

export interface HydratedFilters {
  kind: "filters";
  filters: FilterState;
}
export interface HydratedView {
  kind: "view";
  centerView: CenterView | null;
  table: TableConfig;
  plot: PlotConfig;
  groupPlot: GroupPlotConfig;
}
export type HydratedPreset = HydratedFilters | HydratedView;

/** Map a legacy/foreign center-view string ("chart" → "plot"); null if unknown. */
function normView(v: unknown): CenterView | null {
  if (v === "chart") return "plot";
  return v === "table" || v === "plot" || v === "groupplot" || v === "anatomy" ? v : null;
}

export { sanitizeFilters };

/**
 * Hydrate a preset's `state` for application. Tolerant of any malformed input.
 * `fallbackCols` seeds the table's visibleCols when the blob has none.
 */
export function hydratePreset(
  kind: PresetKind,
  state: unknown,
  fallbackCols: string[],
): HydratedPreset {
  const s = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  if (kind === "filters") {
    return { kind: "filters", filters: sanitizeFilters(s.filters) };
  }
  return {
    kind: "view",
    centerView: normView(s.centerView),
    table: sanitizeTableConfig(s.table, fallbackCols),
    plot: sanitizePlotConfig(s.plot),
    groupPlot: sanitizeGroupPlotConfig(s.groupPlot),
  };
}

/** A default preset name suggested from the active filter chips. */
export function suggestPresetName(filters: FilterState): string {
  const parts: string[] = [];
  for (const vals of Object.values(filters.facets ?? {})) {
    if (Array.isArray(vals) && vals.length) parts.push(vals[0]);
    if (parts.length >= 2) break;
  }
  for (const r of filters.ranges ?? []) {
    if (parts.length >= 2) break;
    parts.push(`${r.metric} sweep`);
  }
  return parts.join(" · ") || "preset";
}
