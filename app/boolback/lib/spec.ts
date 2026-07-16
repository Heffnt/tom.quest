// app/boolback/lib/spec.ts — view-spec serialization (spec v4).
//
// A VIEW-SPEC is the compact, human-editable, CMT-vocabulary JSON form of ONE
// view's full config. It is the ONLY cross-view transfer object: the config
// panel's Copy/Paste, the Convex presets ({name, spec}), and CMT-side
// `render.py` all consume this identical shape. Versioned (`v: 4`).
//
// This module is PURE LOGIC — no store, no React, no UI. Four exports:
//   configToSpec(view, config[, facet]) → ViewSpec   (config → spec, omit defaults)
//   specToConfig(spec)   → {view, plot?/table?, facet?} (spec → COMPLETE config)
//   serializeSpec(spec)  → string   (pretty JSON, stable key order)
//   parseSpec(text)      → ViewSpec | null  (tolerant; never throws)
//
// DESIGN NOTES — what the spec carries and what it deliberately does NOT:
//   * The spec captures the ANALYTICAL config: axes, log, the LAYERS list
//     (name/color/style{shape,dash} + each layer's facets/ranges), plot-level
//     ranges, plot-level size/opacity, continuous color, the plot toggles
//     (band/ghosts/trend), and — groupplot only — a `facet` (a GroupFacet
//     object: layer / param / param-grid / metric-bins). Table specs carry
//     filters/columns/sorts.
//   * It does NOT carry EPHEMERAL / DISPLAY-ONLY state, which is therefore
//     default-filled by specToConfig (never round-trips):
//       - plot/groupplot: xDomain/yDomain (zoom windows), layer ids
//         (regenerated "l1", "l2", … in order);
//       - groupplot: panelMin (a store extra, never on the shared config);
//       - table: search (dir-path/run-id box) and columnWidths.
//   * Default fields are OMITTED from the spec (a default plot serializes to
//     just {v, view} — including the default single "all runs" layer);
//     specToConfig re-fills them from DEFAULT_PLOT / the local table default.
//   * Parameter keys are DATA-DRIVEN: unknown facet/param keys are preserved
//     verbatim (never validated against the FacetKey enum) — only STRUCTURE
//     and value TYPES are checked.
//   * NO back-compat: parseSpec REQUIRES v === 4. A v3 (or any other) spec
//     returns null — old presets are dropped by design.

import {
  type GroupFacet,
  type LayerStyle,
  type PlotConfig,
  type PlotLayer,
  type TableConfig,
  DEFAULT_LAYER_STYLE,
  DEFAULT_PLOT,
  EMPTY_FILTER,
  sanitizeGroupFacet,
  sanitizePlotConfig,
  sanitizeTableConfig,
} from "./types";

export type ViewKind = "table" | "plot" | "groupplot";

/** One serialized layer (no id — ids regenerate on parse). */
export interface SpecLayer {
  name: string;
  color?: string;
  /** Non-default style fields only (shape/dash); absent = defaults. */
  style?: Partial<LayerStyle>;
  facets?: Record<string, string[]>; // facetKey -> allowed values
  ranges?: { metric: string; min: number; max: number }[];
}

export interface ViewSpec {
  v: 4;
  view: ViewKind;
  // plot / groupplot
  x?: string;
  y?: string;
  log?: ("x" | "y")[]; // present axes that are log-scaled
  /** The layers list (ABSENT = the default single "all runs" layer). */
  layers?: SpecLayer[];
  /** Plot views: PLOT-LEVEL ranges; table: the filter ranges. */
  ranges?: { metric: string; min: number; max: number }[];
  color_by?: string | null; // continuous-color metric, or null
  facet?: GroupFacet; // groupplot only (layer / param / grid / metric-bins panels)
  size?: number;    // plot-level marker/line size multiplier (omit when 1)
  opacity?: number; // plot-level opacity multiplier (omit when 1)
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

/** The non-default fields of a layer's style (undefined when all-default). */
function styleToSpec(style: LayerStyle | undefined): Partial<LayerStyle> | undefined {
  const s = { ...DEFAULT_LAYER_STYLE, ...(style ?? {}) };
  const out: Partial<LayerStyle> = {};
  if (s.shape !== DEFAULT_LAYER_STYLE.shape) out.shape = s.shape;
  if (s.dash !== DEFAULT_LAYER_STYLE.dash) out.dash = s.dash;
  return Object.keys(out).length ? out : undefined;
}

/** Serialize the layers list; undefined when it IS the default single
 *  unfiltered "all runs" layer (the tiny-default-spec rule). */
function layersToSpec(layers: PlotLayer[]): SpecLayer[] | undefined {
  const d = DEFAULT_PLOT.layers[0];
  if (layers.length === 1) {
    const l = layers[0];
    const unfiltered =
      Object.values(l.filters.facets).every((v) => !v || v.length === 0) &&
      l.filters.ranges.length === 0;
    if (unfiltered && l.name === d.name && l.color === d.color && !styleToSpec(l.style)) {
      return undefined;
    }
  }
  return layers.map((l) => {
    const out: SpecLayer = { name: l.name, color: l.color };
    const style = styleToSpec(l.style);
    if (style) out.style = style;
    const facets = facetsToSpec(l.filters.facets);
    if (facets) out.facets = facets;
    const ranges = rangesToSpec(l.filters.ranges);
    if (ranges) out.ranges = ranges;
    return out;
  });
}

function plotToSpec(spec: ViewSpec, cfg: PlotConfig): void {
  if (cfg.x !== DEFAULT_PLOT.x) spec.x = cfg.x;
  if (cfg.y !== DEFAULT_PLOT.y) spec.y = cfg.y;
  const log = logToSpec(cfg.logX, cfg.logY);
  if (log) spec.log = log;
  const layers = layersToSpec(cfg.layers);
  if (layers) spec.layers = layers;
  const ranges = rangesToSpec(cfg.ranges);
  if (ranges) spec.ranges = ranges;
  if (cfg.colorBy != null) spec.color_by = cfg.colorBy;
  if (cfg.size !== DEFAULT_PLOT.size) spec.size = cfg.size;
  if (cfg.opacity !== DEFAULT_PLOT.opacity) spec.opacity = cfg.opacity;
  if (cfg.band !== DEFAULT_PLOT.band) spec.band = cfg.band;
  if (cfg.ghosts !== DEFAULT_PLOT.ghosts) spec.ghosts = cfg.ghosts;
  if (cfg.trend !== DEFAULT_PLOT.trend) spec.trend = cfg.trend;
}

export function configToSpec(view: "table", config: TableConfig): ViewSpec;
export function configToSpec(view: "plot", config: PlotConfig): ViewSpec;
export function configToSpec(view: "groupplot", config: PlotConfig, facet: GroupFacet | null): ViewSpec;
export function configToSpec(
  view: ViewKind,
  config: TableConfig | PlotConfig,
  facet?: GroupFacet | null,
): ViewSpec {
  const spec: ViewSpec = { v: 4, view };
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
  // plot / groupplot — both serialize the SHARED plot config; groupplot adds facet.
  plotToSpec(spec, config as PlotConfig);
  if (view === "groupplot" && facet != null) spec.facet = facet;
  return spec;
}

// ---------------------------------------------------------------------------
// specToConfig — spec → COMPLETE, valid config (merged over defaults).
// Builds a raw config-shaped object from the spec, then runs it through the
// Phase-1 sanitizer, which fills missing keys and drops wrong-typed ones
// (and regenerates layer ids "l1", "l2", … in order). The groupplot facet is
// returned ALONGSIDE the shared plot config (it is a store extra, not a config
// field).
// ---------------------------------------------------------------------------

/** Raw plot-shaped object from a spec (pre-sanitize). Absent layers stay
 *  undefined so the sanitizer installs the default single layer. */
function rawPlotFromSpec(spec: ViewSpec): Record<string, unknown> {
  return {
    layers: spec.layers?.map((l) => ({
      name: l.name,
      color: l.color,
      style: l.style, // sanitizeLayerStyle fills the missing fields
      filters: { facets: l.facets ?? {}, ranges: l.ranges ?? [] },
    })),
    ranges: spec.ranges ?? [],
    colorBy: spec.color_by ?? null,
    x: spec.x,
    y: spec.y,
    size: spec.size,
    opacity: spec.opacity,
    band: spec.band,
    ghosts: spec.ghosts,
    trend: spec.trend,
    logX: spec.log?.includes("x") ?? false,
    logY: spec.log?.includes("y") ?? false,
  };
}

export function specToConfig(spec: ViewSpec): {
  view: ViewKind;
  plot?: PlotConfig;
  table?: TableConfig;
  facet?: GroupFacet | null;
} {
  if (spec.view === "table") {
    const raw: Record<string, unknown> = {
      filters: { facets: spec.filters ?? {}, ranges: spec.ranges ?? [] },
      visibleCols: spec.columns ?? [],
      sorts: spec.sorts,
    };
    return { view: "table", table: sanitizeTableConfig(raw, DEFAULT_TABLE.visibleCols) };
  }
  const plot = sanitizePlotConfig(rawPlotFromSpec(spec));
  if (spec.view === "groupplot") {
    return { view: "groupplot", plot, facet: sanitizeGroupFacet(spec.facet) };
  }
  return { view: "plot", plot };
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
  if (spec.layers !== undefined) {
    o.layers = spec.layers.map((l) => {
      const out: Record<string, unknown> = { name: l.name };
      if (l.color !== undefined) out.color = l.color;
      if (l.style !== undefined) {
        const st: Record<string, unknown> = {};
        if (l.style.shape !== undefined) st.shape = l.style.shape;
        if (l.style.dash !== undefined) st.dash = l.style.dash;
        out.style = st;
      }
      if (l.facets !== undefined) out.facets = orderFacets(l.facets);
      if (l.ranges !== undefined) {
        out.ranges = l.ranges.map((r) => ({ metric: r.metric, min: r.min, max: r.max }));
      }
      return out;
    });
  }
  if (spec.filters !== undefined) o.filters = orderFacets(spec.filters);
  if (spec.ranges !== undefined) {
    o.ranges = spec.ranges.map((r) => ({ metric: r.metric, min: r.min, max: r.max }));
  }
  if (spec.color_by !== undefined) o.color_by = spec.color_by;
  if (spec.facet !== undefined) {
    // fixed key order per kind, so serialization is deterministic
    const f: Record<string, unknown> = { kind: spec.facet.kind };
    if (spec.facet.kind === "param") f.key = spec.facet.key;
    if (spec.facet.kind === "grid") {
      f.row = spec.facet.row;
      f.col = spec.facet.col;
    }
    if (spec.facet.kind === "bins") {
      f.metric = spec.facet.metric;
      f.n = spec.facet.n;
      f.mode = spec.facet.mode;
    }
    o.facet = f;
  }
  if (spec.size !== undefined) o.size = spec.size;
  if (spec.opacity !== undefined) o.opacity = spec.opacity;
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
// REQUIRES v===4 and a known view; coerces/ignores unknown & wrong-typed
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

function coerceStyle(raw: unknown): Partial<LayerStyle> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Partial<LayerStyle> = {};
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (num(raw.shape)) out.shape = raw.shape;
  if (num(raw.dash)) out.dash = raw.dash;
  return Object.keys(out).length ? out : undefined;
}

function coerceLayers(raw: unknown): SpecLayer[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SpecLayer[] = [];
  for (const l of raw) {
    if (!isPlainObject(l) || typeof l.name !== "string") continue;
    const entry: SpecLayer = { name: l.name };
    if (typeof l.color === "string") entry.color = l.color;
    const style = coerceStyle(l.style);
    if (style) entry.style = style;
    const facets = coerceFilters(l.facets);
    if (facets) entry.facets = facets;
    const ranges = coerceRanges(l.ranges);
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
  if (parsed.v !== 4) return null;
  if (parsed.view !== "table" && parsed.view !== "plot" && parsed.view !== "groupplot") return null;

  const spec: ViewSpec = { v: 4, view: parsed.view };

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
  const layers = coerceLayers(parsed.layers);
  if (layers) spec.layers = layers;
  const ranges = coerceRanges(parsed.ranges);
  if (ranges) spec.ranges = ranges;
  if (typeof parsed.color_by === "string" || parsed.color_by === null) spec.color_by = parsed.color_by;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (num(parsed.size)) spec.size = parsed.size;
  if (num(parsed.opacity)) spec.opacity = parsed.opacity;
  if (typeof parsed.band === "boolean") spec.band = parsed.band;
  if (typeof parsed.ghosts === "boolean") spec.ghosts = parsed.ghosts;
  if (typeof parsed.trend === "boolean") spec.trend = parsed.trend;
  if (parsed.view === "groupplot") {
    const facet = sanitizeGroupFacet(parsed.facet);
    if (facet) spec.facet = facet; // the pre-bins STRING form is dropped
  }
  return spec;
}
