// app/boolback/lib/presets.ts — tolerant hydration of saved filter sets / views.
//
// A preset must NEVER crash the page: unknown keys are ignored, missing keys
// defaulted, `chart` runs through the same v1→v2 migration path, and the whole
// FilterState is field-sanitized so a hand-corrupted or stale blob applies
// PARTIALLY rather than throwing. This is deliberately NOT the share-URL codec —
// presets store structured state and tolerate schema drift (schemaVersion).

import type { ChartConfig, FilterState, SortKey } from "./types";
import { EMPTY_FILTER, migrateChart } from "./types";
import type { CenterView } from "../components/table-pane";

export type PresetKind = "filters" | "view";
export const PRESET_SCHEMA_VERSION = 1;

/** kind=filters: just FilterState. kind=view: the whole view. */
export interface FiltersPresetState {
  filters: FilterState;
}
export interface ViewPresetState {
  filters: FilterState;
  chart: ChartConfig;
  sorts: SortKey[];
  visibleCols: string[];
  centerView: CenterView;
}

export interface HydratedPreset {
  filters: FilterState;
  chart?: ChartConfig;
  sorts?: SortKey[];
  visibleCols?: string[];
  centerView?: CenterView;
}

/** Map a legacy/foreign center-view string ("chart" → "plot"); null if unknown. */
function normView(v: unknown): CenterView | null {
  if (v === "chart") return "plot";
  return v === "table" || v === "plot" || v === "groupplot" || v === "anatomy" ? v : null;
}

/** Coerce any blob to a complete FilterState (field-by-field; never throws). */
export function sanitizeFilters(raw: unknown): FilterState {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    facets: f.facets && typeof f.facets === "object" && !Array.isArray(f.facets)
      ? (f.facets as FilterState["facets"])
      : {},
    ranges: Array.isArray(f.ranges) ? (f.ranges as FilterState["ranges"]) : [],
    status: Array.isArray(f.status) ? (f.status as FilterState["status"]) : [],
    subtreeDirs: Array.isArray(f.subtreeDirs)
      ? f.subtreeDirs.filter((x): x is string => typeof x === "string")
      : [],
    search: typeof f.search === "string" ? f.search : "",
  };
}

/**
 * Hydrate a preset's `state` for application. A filters preset yields only
 * `filters`; a view preset yields the full set. `fallbackCols` is used when the
 * saved visibleCols are missing/empty. Tolerant of any malformed input.
 */
export function hydratePreset(
  kind: PresetKind,
  state: unknown,
  fallbackCols: string[],
): HydratedPreset {
  const s = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  const filters = { ...EMPTY_FILTER, ...sanitizeFilters(s.filters) };
  if (kind === "filters") return { filters };
  return {
    filters,
    chart: migrateChart(s.chart),
    sorts: Array.isArray(s.sorts) ? (s.sorts as SortKey[]) : [],
    visibleCols:
      Array.isArray(s.visibleCols) && s.visibleCols.length > 0
        ? (s.visibleCols as string[])
        : fallbackCols,
    centerView: normView(s.centerView) ?? undefined,
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
