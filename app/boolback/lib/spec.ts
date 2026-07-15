// app/boolback/lib/spec.ts — view-spec serialization (Phase 5).
//
// A VIEW-SPEC is the compact, human-editable, CMT-vocabulary JSON form of ONE
// view's full config. It is the ONLY cross-view transfer object: the config
// panel's Copy/Paste, the Convex presets ({name, spec}), and CMT-side
// `render.py` all consume this identical shape. Versioned (`v: 3`).
//
// This module is PURE LOGIC — no store, no React, no UI. Four exports:
//   configToSpec(view, config)  →  ViewSpec        (config → spec, omit defaults)
//   specToConfig(spec)          →  {view, config}  (spec → COMPLETE, valid config)
//   serializeSpec(spec)         →  string          (pretty JSON, stable key order)
//   parseSpec(text)             →  ViewSpec | null (tolerant; never throws)
//
// DESIGN NOTES — what the spec carries and what it deliberately does NOT:
//   * The spec captures the ANALYTICAL config: axes, log, the SETTINGS list
//     (name/color + each setting's facets/ranges), plot-level ranges,
//     split_by, continuous color, facet (a parameter key or the literal
//     "setting"), plot toggles, table filters/columns/sorts.
//   * It does NOT carry EPHEMERAL / DISPLAY-ONLY state, which is therefore
//     default-filled by specToConfig (never round-trips):
//       - plot/groupplot: xDomain/yDomain (zoom windows), setting ids
//         (regenerated "s1", "s2", … in order);
//       - groupplot: panelMin (panel size preference);
//       - table: search (dir-path/run-id box) and columnWidths.
//   * Default fields are OMITTED from the spec (a default plot serializes to
//     just {v, view} — including the default single "all runs" setting);
//     specToConfig re-fills them from DEFAULT_PLOT / DEFAULT_GROUP_PLOT /
//     the local table default.
//   * Parameter keys are DATA-DRIVEN: unknown facet/param keys are preserved
//     verbatim (never validated against the FacetKey enum) — only STRUCTURE
//     and value TYPES are checked.
//   * Unknown keys in an OLD stored spec (the color_param/shape_param or the
//     split/channels era) are simply ignored — old presets keep their
//     axes and lose their styling (no migration); a spec with no settings
//     parses to the default single setting.

import {
  type GroupPlotConfig,
  type PlotConfig,
  type PlotSetting,
  type TableConfig,
  DEFAULT_PLOT,
  EMPTY_FILTER,
  sanitizeGroupPlotConfig,
  sanitizePlotConfig,
  sanitizeTableConfig,
} from "./types";

export type ViewKind = "table" | "plot" | "groupplot";

/** One serialized setting (no id — ids regenerate on parse). */
export interface SpecSetting {
  name: string;
  color?: string;
  facets?: Record<string, string[]>; // facetKey -> allowed values
  ranges?: { metric: string; min: number; max: number }[];
}

export interface ViewSpec {
  v: 3;
  view: ViewKind;
  // plot / groupplot
  x?: string;
  y?: string;
  log?: ("x" | "y")[]; // present axes that are log-scaled
  /** The settings list (ABSENT = the default single "all runs" setting). */
  settings?: SpecSetting[];
  /** Plot views: PLOT-LEVEL ranges; table: the filter ranges. */
  ranges?: { metric: string; min: number; max: number }[];
  /** Ordered parameter keys split within settings. */
  split_by?: string[];
  color_by?: string | null; // continuous-color metric, or null
  facet?: string | null; // groupplot only (a parameter key or "setting")
  band?: boolean;
  ghosts?: boolean;
  trend?: boolean;
  // table
  filters?: Record<string, string[]>; // facetKey -> allowed values (table only)
  columns?: string[];
  sorts?: { col: string; dir: "asc" | "desc" }[];
}

/** Local table default (types.ts exports no DEFAULT_TABLE; sanitizeTableConfig
 *  takes a fallbackCols arg). specToConfig merges the spec over this. */
const DEFAULT_TABLE: TableConfig = {
  filters: EMPTY_FILTER,
  visibleCols: [],
  columnWidths: {},
  sorts: [],
  search: "",
};

// ---------------------------------------------------------------------------
// configToSpec — config → compact spec (omit empty/default fields)
// ---------------------------------------------------------------------------

function facetsToSpec(facets: TableConfig["filters"]["facets"]): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(facets)) {
    if (Array.isArray(v) && v.length) out[k] = [...v];
  }
  return Object.keys(out).length ? out : undefined;
}

function rangesToSpec(ranges: PlotConfig["ranges"]): ViewSpec["ranges"] {
  return ranges.length ? ranges.map((r) => ({ metric: r.metric, min: r.min, max: r.max })) : undefined;
}

function logToSpec(logX: boolean, logY: boolean): ViewSpec["log"] {
  const out: ("x" | "y")[] = [];
  if (logX) out.push("x");
  if (logY) out.push("y");
  return out.length ? out : undefined;
}

/** Serialize the settings list; undefined when it IS the default single
 *  unfiltered "all runs" setting (the tiny-default-spec rule). */
function settingsToSpec(settings: PlotSetting[]): SpecSetting[] | undefined {
  const d = DEFAULT_PLOT.settings[0];
  if (settings.length === 1) {
    const s = settings[0];
    const unfiltered =
      Object.values(s.filters.facets).every((v) => !v || v.length === 0) &&
      s.filters.ranges.length === 0;
    if (unfiltered && s.name === d.name && s.color === d.color) return undefined;
  }
  return settings.map((s) => {
    const out: SpecSetting = { name: s.name, color: s.color };
    const facets = facetsToSpec(s.filters.facets);
    if (facets) out.facets = facets;
    const ranges = rangesToSpec(s.filters.ranges);
    if (ranges) out.ranges = ranges;
    return out;
  });
}

function plotToSpec(spec: ViewSpec, cfg: PlotConfig): void {
  if (cfg.x !== DEFAULT_PLOT.x) spec.x = cfg.x;
  if (cfg.y !== DEFAULT_PLOT.y) spec.y = cfg.y;
  const log = logToSpec(cfg.logX, cfg.logY);
  if (log) spec.log = log;
  const settings = settingsToSpec(cfg.settings);
  if (settings) spec.settings = settings;
  const ranges = rangesToSpec(cfg.ranges);
  if (ranges) spec.ranges = ranges;
  if (cfg.splitBy.length) spec.split_by = [...cfg.splitBy];
  if (cfg.colorBy != null) spec.color_by = cfg.colorBy;
  if (cfg.band !== DEFAULT_PLOT.band) spec.band = cfg.band;
  if (cfg.ghosts !== DEFAULT_PLOT.ghosts) spec.ghosts = cfg.ghosts;
  if (cfg.trend !== DEFAULT_PLOT.trend) spec.trend = cfg.trend;
}

export function configToSpec(
  view: ViewKind,
  config: TableConfig | PlotConfig | GroupPlotConfig,
): ViewSpec {
  const spec: ViewSpec = { v: 3, view };
  if (view === "table") {
    const cfg = config as TableConfig;
    const filters = facetsToSpec(cfg.filters.facets);
    if (filters) spec.filters = filters;
    const ranges = rangesToSpec(cfg.filters.ranges);
    if (ranges) spec.ranges = ranges;
    if (cfg.visibleCols.length) spec.columns = [...cfg.visibleCols];
    if (cfg.sorts.length) spec.sorts = cfg.sorts.map((s) => ({ col: s.col, dir: s.dir }));
    // search + columnWidths are display-only: intentionally NOT serialized.
    return spec;
  }
  // plot / groupplot
  const cfg = config as PlotConfig;
  plotToSpec(spec, cfg);
  if (view === "groupplot") {
    const g = config as GroupPlotConfig;
    if (g.facet != null) spec.facet = g.facet;
    // panelMin is a display preference: intentionally NOT serialized.
  }
  return spec;
}

// ---------------------------------------------------------------------------
// specToConfig — spec → COMPLETE, valid config (merged over defaults).
// Builds a raw config-shaped object from the spec, then runs it through the
// Phase-1 sanitizer, which fills missing keys and drops wrong-typed ones
// (and regenerates setting ids "s1", "s2", … in order).
// ---------------------------------------------------------------------------

/** Raw plot-shaped object from a spec (pre-sanitize). Absent settings stay
 *  undefined so the sanitizer installs the default single setting. */
function rawPlotFromSpec(spec: ViewSpec): Record<string, unknown> {
  return {
    settings: spec.settings?.map((s) => ({
      name: s.name,
      color: s.color,
      filters: { facets: s.facets ?? {}, ranges: s.ranges ?? [] },
    })),
    ranges: spec.ranges ?? [],
    splitBy: spec.split_by ?? [],
    colorBy: spec.color_by ?? null,
    x: spec.x,
    y: spec.y,
    band: spec.band,
    ghosts: spec.ghosts,
    trend: spec.trend,
    logX: spec.log?.includes("x") ?? false,
    logY: spec.log?.includes("y") ?? false,
  };
}

export function specToConfig(spec: ViewSpec): {
  view: ViewKind;
  config: TableConfig | PlotConfig | GroupPlotConfig;
} {
  if (spec.view === "table") {
    const raw: Record<string, unknown> = {
      filters: { facets: spec.filters ?? {}, ranges: spec.ranges ?? [] },
      visibleCols: spec.columns ?? [],
      sorts: spec.sorts,
    };
    return { view: "table", config: sanitizeTableConfig(raw, DEFAULT_TABLE.visibleCols) };
  }
  const raw = rawPlotFromSpec(spec);
  if (spec.view === "groupplot") {
    raw.facet = spec.facet ?? null;
    return { view: "groupplot", config: sanitizeGroupPlotConfig(raw) };
  }
  return { view: "plot", config: sanitizePlotConfig(raw) };
}

// ---------------------------------------------------------------------------
// serializeSpec — pretty JSON, STABLE key order (deterministic output).
// ---------------------------------------------------------------------------

/** Rebuild the spec as a plain object with a fixed top-level key order and
 *  alphabetically-ordered facet keys, so serialization is deterministic. */
function orderSpec(spec: ViewSpec): Record<string, unknown> {
  const orderFacets = (facets: Record<string, string[]>): Record<string, string[]> => {
    const f: Record<string, string[]> = {};
    for (const k of Object.keys(facets).sort()) f[k] = facets[k];
    return f;
  };
  const o: Record<string, unknown> = { v: spec.v, view: spec.view };
  if (spec.x !== undefined) o.x = spec.x;
  if (spec.y !== undefined) o.y = spec.y;
  if (spec.log !== undefined) o.log = spec.log;
  if (spec.settings !== undefined) {
    o.settings = spec.settings.map((s) => {
      const out: Record<string, unknown> = { name: s.name };
      if (s.color !== undefined) out.color = s.color;
      if (s.facets !== undefined) out.facets = orderFacets(s.facets);
      if (s.ranges !== undefined) {
        out.ranges = s.ranges.map((r) => ({ metric: r.metric, min: r.min, max: r.max }));
      }
      return out;
    });
  }
  if (spec.filters !== undefined) o.filters = orderFacets(spec.filters);
  if (spec.ranges !== undefined) {
    o.ranges = spec.ranges.map((r) => ({ metric: r.metric, min: r.min, max: r.max }));
  }
  if (spec.split_by !== undefined) o.split_by = spec.split_by;
  if (spec.color_by !== undefined) o.color_by = spec.color_by;
  if (spec.facet !== undefined) o.facet = spec.facet;
  if (spec.band !== undefined) o.band = spec.band;
  if (spec.ghosts !== undefined) o.ghosts = spec.ghosts;
  if (spec.trend !== undefined) o.trend = spec.trend;
  if (spec.columns !== undefined) o.columns = spec.columns;
  if (spec.sorts !== undefined) o.sorts = spec.sorts.map((s) => ({ col: s.col, dir: s.dir }));
  return o;
}

export function serializeSpec(spec: ViewSpec): string {
  return JSON.stringify(orderSpec(spec), null, 2);
}

// ---------------------------------------------------------------------------
// parseSpec — tolerant JSON → ViewSpec. Returns null on garbage; never throws.
// Validates v===3 and a known view; coerces/ignores unknown & wrong-typed
// fields; PRESERVES unknown parameter keys (data-driven).
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function coerceFilters(raw: unknown): Record<string, string[]> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      const vals = v.filter((s): s is string => typeof s === "string");
      if (vals.length) out[k] = vals;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function coerceRanges(raw: unknown): ViewSpec["ranges"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<ViewSpec["ranges"]> = [];
  for (const r of raw) {
    if (
      isPlainObject(r) &&
      typeof r.metric === "string" &&
      typeof r.min === "number" &&
      Number.isFinite(r.min) &&
      typeof r.max === "number" &&
      Number.isFinite(r.max)
    ) {
      out.push({ metric: r.metric, min: r.min, max: r.max });
    }
  }
  return out.length ? out : undefined;
}

function coerceSettings(raw: unknown): SpecSetting[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SpecSetting[] = [];
  for (const s of raw) {
    if (!isPlainObject(s) || typeof s.name !== "string") continue;
    const entry: SpecSetting = { name: s.name };
    if (typeof s.color === "string") entry.color = s.color;
    const facets = coerceFilters(s.facets);
    if (facets) entry.facets = facets;
    const ranges = coerceRanges(s.ranges);
    if (ranges) entry.ranges = ranges;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

function coerceSorts(raw: unknown): ViewSpec["sorts"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<ViewSpec["sorts"]> = [];
  for (const s of raw) {
    if (isPlainObject(s) && typeof s.col === "string" && (s.dir === "asc" || s.dir === "desc")) {
      out.push({ col: s.col, dir: s.dir });
    }
  }
  return out.length ? out : undefined;
}

function coerceLog(raw: unknown): ViewSpec["log"] {
  if (!Array.isArray(raw)) return undefined;
  const out: ("x" | "y")[] = [];
  if (raw.includes("x")) out.push("x");
  if (raw.includes("y")) out.push("y");
  return out.length ? out : undefined;
}

function coerceStrings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((s): s is string => typeof s === "string");
  return out.length ? out : undefined;
}

export function parseSpec(text: string): ViewSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.v !== 3) return null;
  if (parsed.view !== "table" && parsed.view !== "plot" && parsed.view !== "groupplot") return null;

  const spec: ViewSpec = { v: 3, view: parsed.view };

  if (parsed.view === "table") {
    const filters = coerceFilters(parsed.filters);
    if (filters) spec.filters = filters;
    const ranges = coerceRanges(parsed.ranges);
    if (ranges) spec.ranges = ranges;
    const columns = coerceStrings(parsed.columns);
    if (columns) spec.columns = columns;
    const sorts = coerceSorts(parsed.sorts);
    if (sorts) spec.sorts = sorts;
    return spec;
  }

  // plot / groupplot
  if (typeof parsed.x === "string") spec.x = parsed.x;
  if (typeof parsed.y === "string") spec.y = parsed.y;
  const log = coerceLog(parsed.log);
  if (log) spec.log = log;
  const settings = coerceSettings(parsed.settings);
  if (settings) spec.settings = settings;
  const ranges = coerceRanges(parsed.ranges);
  if (ranges) spec.ranges = ranges;
  const splitBy = coerceStrings(parsed.split_by);
  if (splitBy) spec.split_by = splitBy;
  if (typeof parsed.color_by === "string" || parsed.color_by === null) spec.color_by = parsed.color_by;
  if (typeof parsed.band === "boolean") spec.band = parsed.band;
  if (typeof parsed.ghosts === "boolean") spec.ghosts = parsed.ghosts;
  if (typeof parsed.trend === "boolean") spec.trend = parsed.trend;
  if (parsed.view === "groupplot") {
    if (typeof parsed.facet === "string" || parsed.facet === null) spec.facet = parsed.facet;
  }
  return spec;
}
