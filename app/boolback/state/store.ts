// app/boolback/state/store.ts — PINNED zustand store (per-page idiom A).
"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  AnatomyConfig, PlotConfig, GroupPlotExtras, TableConfig, PlotLayer,
  FilterState, SortKey, SortDir, FacetKey, RangeFilter,
} from "../lib/types";
import {
  DEFAULT_ANATOMY, DEFAULT_PLOT, DEFAULT_GROUP_EXTRAS, DEFAULT_LAYER_STYLE,
  EMPTY_FILTER, nextLayerId, defaultPlotWithFilters,
} from "../lib/types";
import { paletteColor } from "../lib/styling";
import type { CenterView } from "../components/table-pane";

/** The mounted plot's live descriptive readout (r/ρ/counts), published for
 *  the shared top bar to render. Null whenever no plot is mounted. */
export interface PlotReadout {
  r: number | null;
  rho: number | null;
  runs: number;    // underlying run pairs behind the stats (windowed)
  points: number;  // rendered points (or groups when averaging)
  averaging: boolean;
  binned: boolean;
  droppedLog: number;
  outsideWindow: number;   // runs clipped by the axis view window (still in table)
  ghostsSubsampled: boolean; // ghosts thinned to stay under the render cap
}

// ---------------------------------------------------------------------------
// Per-view config keys. The Plot AND Group Plot views SHARE one `plot` config;
// Group Plot adds only `groupPlot` extras (facet + panel size). The table owns
// its own filters (no inheritance on tab switch). Anatomy is deprecated and has
// NO config here — it reads a frozen EMPTY_FILTER (see table-pane).
// ---------------------------------------------------------------------------

/** Filter-mutator targeting: only the table and the shared plot config carry
 *  filters (group plot writes through `plot`). */
export type ViewKey = "table" | "plot";

/** Where a parameter-row edit lands on the plot-like views: the SELECTED layer
 *  (default) or fanned out to EVERY layer. An edit MODE, not view state — it
 *  never serializes into a ViewSpec and is not persisted. This is the user's
 *  PREFERENCE; with no layer selected the panel's effective scope is "all"
 *  (the only mode that can edit), and the preference survives re-selection. */
export type EditScope = "selected" | "all";

/** Map the centerView union to its filter-config key (anatomy → null). The
 *  group-plot tab targets the SHARED plot config, so it maps to "plot"; the
 *  PANEL still checks centerView === "groupplot" to show the facet/panel rows. */
export function configViewOf(view: CenterView): ViewKey | null {
  if (view === "table") return "table";
  if (view === "plot") return "plot";
  if (view === "groupplot") return "plot";
  return null; // anatomy — no per-view config
}

// Default visible columns. fn_hex (compact "arity:hex") replaces the long DNF
// string; interp/scan columns are OFF by default (mostly-empty families) but
// stay findable in the column-group menus and return once their sweeps run.
export const DEFAULT_COLS = [
  "function.arity", "function.fn_hex", "function.truth_table",
  "dataset.dataset", "dataset.trigger_form", "dataset.target_behavior",
  "training.base_model", "training.tuning", "training.seed",
  "headline.plantedness", "headline.asr", "headline.ftr",
  "defense.asr_drop",
];

export const DEFAULT_TABLE: TableConfig = {
  filters: EMPTY_FILTER,
  visibleCols: DEFAULT_COLS,
  columnWidths: {},
  sorts: [],
  search: "",
};

const DEFAULT_DETAIL_WIDTH = 480;

interface BoolbackState {
  // selection / hover (path-keyed; views resolve locally)
  selectedDir: string | null;
  hoveredDir: string | null;
  // expansion
  expanded: Set<string>;             // open node paths in the tree
  treeCursor: string | null;         // typeahead anchor (path of the focused dir)

  // per-view configs. The table owns its filters; `plot` is SHARED by the Plot
  // AND Group Plot views; `groupPlot` holds only the group-plot extras.
  table: TableConfig;
  plot: PlotConfig;
  groupPlot: GroupPlotExtras;

  // center view + published plot readout + anatomy config
  centerView: CenterView;
  plotReadout: PlotReadout | null;   // published by the mounted PlotBody
  /** DISTINCT runs in the layers union of the mounted plot-like view (a run
   *  matching several layers counts once) — the top bar's run counter on the
   *  Plot / Group Plot views. Null while neither plot view is mounted (the
   *  table's filtered count renders instead). */
  plotUnionCount: number | null;
  anatomy: AnatomyConfig;
  /** Parameter-edit scope on the plot-like views (selected layer vs all
   *  layers). UI state only — NOT part of PlotConfig, never in a ViewSpec. */
  editScope: EditScope;
  // detail panel (decoupled from selection — opened ONLY by a Details button)
  detailOpen: boolean;
  detailWidth: number;               // px

  // actions
  select: (dir: string | null) => void;   // selection only; does NOT open detail
  hover: (dir: string | null) => void;
  setCenterView: (v: CenterView) => void;
  // whole-config patch per view
  setTableConfig: (patch: Partial<TableConfig>) => void;
  setPlot: (patch: Partial<PlotConfig>) => void;
  setGroupPlot: (patch: Partial<GroupPlotExtras>) => void;
  setPlotReadout: (r: PlotReadout | null) => void;
  setPlotUnionCount: (n: number | null) => void;
  setAnatomy: (patch: Partial<AnatomyConfig>) => void;
  setEditScope: (s: EditScope) => void;
  toggleExpand: (dir: string) => void;
  setExpanded: (next: Set<string>) => void;
  expandChain: (dirs: string[]) => void;       // open all ancestors to reveal a node
  setTreeCursor: (dir: string | null) => void;
  // layer management (the shared `plot` config only — no view arg). addLayer /
  // duplicateLayer return the NEW layer's id so the panel can select it.
  patchLayer: (id: string, patch: Partial<PlotLayer>) => void;
  /** `filters` seeds the new layer (the panel passes the dominant-cell
   *  default); omitted → an empty, unfiltered layer. */
  addLayer: (filters?: FilterState) => string;
  /** Copy name (+" copy") and filters; next palette color; inserted after the
   * source. Returns the new id, or null when `id` doesn't resolve. */
  duplicateLayer: (id: string) => string | null;
  removeLayer: (id: string) => void;
  /** Wholesale replace the layers list (the generators write through this). */
  replaceLayers: (next: PlotLayer[]) => void;
  // per-view filter mutators. On "table", layerId is ignored and the table's
  // own FilterState is patched. On "plot", facet edits target the layer named
  // by layerId; range edits with layerId === null target the PLOT-LEVEL ranges
  // (drag-zoom), otherwise the layer's own ranges. (Group Plot writes through
  // "plot" — the shared config.)
  setFacet: (view: ViewKey, layerId: string | null, key: FacetKey, values: string[]) => void;
  toggleFacetValue: (view: ViewKey, layerId: string | null, key: FacetKey, value: string) => void;
  addRange: (view: ViewKey, layerId: string | null, r: RangeFilter) => void;
  updateRange: (view: ViewKey, layerId: string | null, metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (view: ViewKey, layerId: string | null, metric: string) => void;
  patchViewFilters: (view: ViewKey, layerId: string | null, next: FilterState) => void;
  // table-only search
  setSearch: (q: string) => void;
  // reset one view's config to its defaults. `plotFilters` (the panel passes
  // the dominant-cell default) seeds the single default layer of the shared
  // plot config; omitted → the plain filter-empty default. "groupplot" ALSO
  // resets the groupPlot extras.
  resetView: (view: CenterView, plotFilters?: FilterState) => void;
  // sorts (table config)
  pushSort: (col: string) => void;             // header click: prepend (or toggle dir if already primary)
  setPrimarySort: (col: string, dir: SortDir) => void; // header menu: explicit direction
  appendSort: (col: string) => void;           // shift-click: append secondary
  toggleSortDir: (col: string) => void;
  removeSort: (col: string) => void;
  reorderSorts: (next: SortKey[]) => void;
  // columns (table config)
  setVisibleCols: (cols: string[]) => void;
  setColumnWidth: (col: string, width: number) => void;
  setColumnWidths: (widths: Record<string, number>) => void;
  // detail panel
  openDetail: (dir: string) => void;           // select + open the right panel
  setDetailOpen: (b: boolean) => void;
  setDetailWidth: (w: number) => void;
}

// Patch the FilterState a (view, layerId) pair addresses, immutably:
// table → the table's own filters; plot → the named layer's filters. A plot
// edit with layerId === null is a no-op (facet edits require a layer;
// plot-LEVEL ranges are handled by the range mutators directly).
function withFilters(
  s: BoolbackState,
  view: ViewKey,
  layerId: string | null,
  next: (cur: FilterState) => FilterState,
): Partial<BoolbackState> {
  if (view === "table") return { table: { ...s.table, filters: next(s.table.filters) } };
  if (layerId === null) return {};
  const cfg = s.plot;
  return {
    plot: {
      ...cfg,
      layers: cfg.layers.map((l) =>
        l.id === layerId ? { ...l, filters: next(l.filters) } : l,
      ),
    },
  };
}

// Patch the shared plot config's PLOT-LEVEL ranges immutably.
function withPlotRanges(
  s: BoolbackState,
  next: (cur: RangeFilter[]) => RangeFilter[],
): Partial<BoolbackState> {
  return { plot: { ...s.plot, ranges: next(s.plot.ranges) } };
}

export const useBoolbackStore = create<BoolbackState>()(
  devtools(
    (set) => ({
      selectedDir: null,
      hoveredDir: null,
      expanded: new Set<string>(),
      treeCursor: null,
      table: DEFAULT_TABLE,
      plot: DEFAULT_PLOT,
      groupPlot: DEFAULT_GROUP_EXTRAS,
      centerView: "table" as const,
      plotReadout: null,
      plotUnionCount: null,
      anatomy: DEFAULT_ANATOMY,
      editScope: "selected" as const,
      detailOpen: false,
      detailWidth: DEFAULT_DETAIL_WIDTH,

      select: (dir) => set({ selectedDir: dir }),
      hover: (dir) => set({ hoveredDir: dir }),
      setCenterView: (v) => set({ centerView: v }),

      setTableConfig: (patch) => set((s) => ({ table: { ...s.table, ...patch } })),
      setPlot: (patch) => set((s) => ({ plot: { ...s.plot, ...patch } })),
      setGroupPlot: (patch) => set((s) => ({ groupPlot: { ...s.groupPlot, ...patch } })),
      setPlotReadout: (r) => set({ plotReadout: r }),
      setPlotUnionCount: (n) => set((s) => (s.plotUnionCount === n ? s : { plotUnionCount: n })),
      // Skip no-op patches: every anatomy change fans out to table-pane's
      // persist effect (synchronous full-settings localStorage write + a
      // scheduled Convex mutation), so a background click re-asserting
      // sel:null must not rebuild the object and trigger that chain.
      setAnatomy: (patch) => set((s) => {
        const keys = Object.keys(patch) as (keyof AnatomyConfig)[];
        return keys.every((k) => Object.is(s.anatomy[k], patch[k]))
          ? s
          : { anatomy: { ...s.anatomy, ...patch } };
      }),
      toggleExpand: (dir) => set((s) => {
        const next = new Set(s.expanded);
        if (next.has(dir)) next.delete(dir); else next.add(dir);
        return { expanded: next };
      }),
      setExpanded: (next) => set({ expanded: next }),
      expandChain: (dirs) => set((s) => {
        const next = new Set(s.expanded);
        for (const d of dirs) next.add(d);
        return { expanded: next };
      }),
      setTreeCursor: (dir) => set({ treeCursor: dir }),
      setEditScope: (s) => set({ editScope: s }),

      patchLayer: (id, patch) => set((s) => ({
        plot: { ...s.plot, layers: s.plot.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) },
      })),
      addLayer: (filters) => {
        let newId = "";
        set((s) => {
          const cfg = s.plot;
          const id = nextLayerId(cfg.layers.map((l) => l.id));
          newId = id;
          const next: PlotLayer = {
            id,
            name: `layer ${id.slice(1)}`,
            color: paletteColor(cfg.layers.length),
            style: { ...DEFAULT_LAYER_STYLE },
            filters: filters ?? EMPTY_FILTER,
          };
          return { plot: { ...cfg, layers: [...cfg.layers, next] } };
        });
        return newId;
      },
      duplicateLayer: (id) => {
        let newId: string | null = null;
        set((s) => {
          const cfg = s.plot;
          const idx = cfg.layers.findIndex((l) => l.id === id);
          if (idx === -1) return {};
          const src = cfg.layers[idx];
          const used = new Set(cfg.layers.map((l) => l.id));
          const nid = nextLayerId(used);
          used.add(nid);
          newId = nid;
          // Deep-copy a FilterState so edits to the copy never leak back.
          const copyFilters = (f: FilterState): FilterState => ({
            facets: Object.fromEntries(
              Object.entries(f.facets ?? {}).map(([k, v]) => [k, [...(v ?? [])]]),
            ) as FilterState["facets"],
            ranges: (f.ranges ?? []).map((r) => ({ ...r })),
          });
          const copy: PlotLayer = {
            id: nid,
            name: `${src.name} copy`,
            color: paletteColor(cfg.layers.length),
            style: { ...src.style },
            filters: copyFilters(src.filters),
          };
          // A GROUP duplicates its members too (fresh ids, deep-copied filters)
          // — otherwise the copy would silently lose the group's contents.
          if (src.members && src.members.length) {
            copy.members = src.members.map((m) => {
              const mid = nextLayerId(used);
              used.add(mid);
              return { id: mid, name: m.name, color: m.color, style: { ...m.style }, filters: copyFilters(m.filters) };
            });
          }
          const layers = [...cfg.layers];
          layers.splice(idx + 1, 0, copy);
          return { plot: { ...cfg, layers } };
        });
        return newId;
      },
      removeLayer: (id) => set((s) => {
        const cfg = s.plot;
        if (cfg.layers.length <= 1) return {}; // always keep >= 1 layer
        return { plot: { ...cfg, layers: cfg.layers.filter((l) => l.id !== id) } };
      }),
      replaceLayers: (next) => set((s) => ({ plot: { ...s.plot, layers: next } })),

      patchViewFilters: (view, layerId, next) =>
        set((s) => withFilters(s, view, layerId, () => next)),
      setFacet: (view, layerId, key, values) => set((s) => withFilters(s, view, layerId, (f) => ({
        ...f, facets: { ...f.facets, [key]: values },
      }))),
      toggleFacetValue: (view, layerId, key, value) => set((s) => withFilters(s, view, layerId, (f) => {
        const cur = f.facets[key] ?? [];
        const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
        return { ...f, facets: { ...f.facets, [key]: next } };
      })),
      addRange: (view, layerId, r) => set((s) =>
        view !== "table" && layerId === null
          ? withPlotRanges(s, (rs) => [...rs.filter((x) => x.metric !== r.metric), r])
          : withFilters(s, view, layerId, (f) => ({
              ...f, ranges: [...f.ranges.filter((x) => x.metric !== r.metric), r],
            })),
      ),
      updateRange: (view, layerId, metric, patch) => set((s) =>
        view !== "table" && layerId === null
          ? withPlotRanges(s, (rs) => rs.map((x) => (x.metric === metric ? { ...x, ...patch } : x)))
          : withFilters(s, view, layerId, (f) => ({
              ...f, ranges: f.ranges.map((x) => (x.metric === metric ? { ...x, ...patch } : x)),
            })),
      ),
      removeRange: (view, layerId, metric) => set((s) =>
        view !== "table" && layerId === null
          ? withPlotRanges(s, (rs) => rs.filter((x) => x.metric !== metric))
          : withFilters(s, view, layerId, (f) => ({
              ...f, ranges: f.ranges.filter((x) => x.metric !== metric),
            })),
      ),

      setSearch: (q) => set((s) => ({ table: { ...s.table, search: q } })),

      resetView: (view, plotFilters) => set(() => {
        if (view === "table") return { table: DEFAULT_TABLE };
        if (view === "plot") {
          return { plot: plotFilters ? defaultPlotWithFilters(plotFilters) : DEFAULT_PLOT };
        }
        if (view === "groupplot") {
          // Group Plot shares `plot`; resetting it ALSO clears the extras.
          return {
            plot: plotFilters ? defaultPlotWithFilters(plotFilters) : DEFAULT_PLOT,
            groupPlot: DEFAULT_GROUP_EXTRAS,
          };
        }
        return { anatomy: DEFAULT_ANATOMY };
      }),

      pushSort: (col) => set((s) => {
        const sorts = s.table.sorts;
        const existing = sorts.find((k) => k.col === col);
        if (sorts[0]?.col === col) {
          return { table: { ...s.table, sorts: sorts.map((k) => k.col === col ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k) } };
        }
        const rest = sorts.filter((k) => k.col !== col);
        return { table: { ...s.table, sorts: [{ col, dir: existing?.dir ?? "desc" }, ...rest] } };
      }),
      setPrimarySort: (col, dir) => set((s) => ({
        table: { ...s.table, sorts: [{ col, dir }, ...s.table.sorts.filter((k) => k.col !== col)] },
      })),
      appendSort: (col) => set((s) => s.table.sorts.some((k) => k.col === col) ? {} : {
        table: { ...s.table, sorts: [...s.table.sorts, { col, dir: "desc" }] },
      }),
      toggleSortDir: (col) => set((s) => ({
        table: { ...s.table, sorts: s.table.sorts.map((k) => k.col === col ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k) },
      })),
      removeSort: (col) => set((s) => ({
        table: { ...s.table, sorts: s.table.sorts.filter((k) => k.col !== col) },
      })),
      reorderSorts: (next) => set((s) => ({ table: { ...s.table, sorts: next } })),

      setVisibleCols: (cols) => set((s) => ({ table: { ...s.table, visibleCols: cols } })),
      setColumnWidth: (col, width) => set((s) => ({
        table: { ...s.table, columnWidths: { ...s.table.columnWidths, [col]: width } },
      })),
      setColumnWidths: (widths) => set((s) => ({ table: { ...s.table, columnWidths: widths } })),

      openDetail: (dir) => set({ selectedDir: dir, detailOpen: true }),
      setDetailOpen: (b) => set({ detailOpen: b }),
      setDetailWidth: (w) => set({ detailWidth: w }),
    }),
    { name: "tom.quest boolback" },
  ),
);

// NOTE: NO persist() in the zustand store. Cross-session view persistence is
// handled in table-pane via usePersistedSettings(key, defaults) — ONE key per
// view config (boolback:table / boolback:plot / boolback:groupplot) plus
// boolback:anatomy. The store holds the live ephemeral copy; the pane syncs
// store<->persisted on hydrate and on change.
