// app/boolback/state/store.ts — PINNED zustand store (per-page idiom A).
"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  AnatomyConfig, PlotConfig, GroupPlotConfig, TableConfig,
  FilterState, SortKey, SortDir, FacetKey, RangeFilter,
} from "../lib/types";
import {
  DEFAULT_ANATOMY, DEFAULT_PLOT, DEFAULT_GROUP_PLOT, EMPTY_FILTER,
} from "../lib/types";
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
// Per-view config keys. The three views below own their OWN filters (no
// inheritance on tab switch). Anatomy is deprecated and has NO config here —
// it reads a frozen EMPTY_FILTER (see table-pane). The centerView union uses
// the lowercase "groupplot"; the config key is "groupPlot".
// ---------------------------------------------------------------------------

export type ViewKey = "table" | "plot" | "groupPlot";

/** Map the centerView union to its config key (anatomy → null). */
export function configViewOf(view: CenterView): ViewKey | null {
  if (view === "table") return "table";
  if (view === "plot") return "plot";
  if (view === "groupplot") return "groupPlot";
  return null; // anatomy — no per-view config
}

// Default visible columns. fn_hex (compact "arity:hex") replaces the long DNF
// string; interp/scan columns are OFF by default (mostly-empty families) but
// stay findable in the column-group menus and return once their sweeps run.
export const DEFAULT_COLS = [
  "function.arity", "function.fn_hex", "function.truth_table",
  "dataset.source", "dataset.trigger_form", "dataset.target_behavior",
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

  // THREE fully independent per-view configs (no inheritance on tab switch)
  table: TableConfig;
  plot: PlotConfig;
  groupPlot: GroupPlotConfig;

  // center view + published plot readout + anatomy config
  centerView: CenterView;
  plotReadout: PlotReadout | null;   // published by the mounted PlotBody
  anatomy: AnatomyConfig;
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
  setGroupPlot: (patch: Partial<GroupPlotConfig>) => void;
  setPlotReadout: (r: PlotReadout | null) => void;
  setAnatomy: (patch: Partial<AnatomyConfig>) => void;
  toggleExpand: (dir: string) => void;
  setExpanded: (next: Set<string>) => void;
  expandChain: (dirs: string[]) => void;       // open all ancestors to reveal a node
  setTreeCursor: (dir: string | null) => void;
  // per-view filter mutators (view = ViewKey; scoped to that view's config)
  setFacet: (view: ViewKey, key: FacetKey, values: string[]) => void;
  toggleFacetValue: (view: ViewKey, key: FacetKey, value: string) => void;
  addRange: (view: ViewKey, r: RangeFilter) => void;
  updateRange: (view: ViewKey, metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (view: ViewKey, metric: string) => void;
  patchViewFilters: (view: ViewKey, next: FilterState) => void;
  // table-only search
  setSearch: (q: string) => void;
  // reset one view's config to its defaults
  resetView: (view: CenterView) => void;
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

// Patch a view's embedded FilterState immutably.
function withFilters(
  s: BoolbackState,
  view: ViewKey,
  next: FilterState,
): Partial<BoolbackState> {
  return { [view]: { ...s[view], filters: next } } as Partial<BoolbackState>;
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
      groupPlot: DEFAULT_GROUP_PLOT,
      centerView: "table" as const,
      plotReadout: null,
      anatomy: DEFAULT_ANATOMY,
      detailOpen: false,
      detailWidth: DEFAULT_DETAIL_WIDTH,

      select: (dir) => set({ selectedDir: dir }),
      hover: (dir) => set({ hoveredDir: dir }),
      setCenterView: (v) => set({ centerView: v }),

      setTableConfig: (patch) => set((s) => ({ table: { ...s.table, ...patch } })),
      setPlot: (patch) => set((s) => ({ plot: { ...s.plot, ...patch } })),
      setGroupPlot: (patch) => set((s) => ({ groupPlot: { ...s.groupPlot, ...patch } })),
      setPlotReadout: (r) => set({ plotReadout: r }),
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

      patchViewFilters: (view, next) => set((s) => withFilters(s, view, next)),
      setFacet: (view, key, values) => set((s) => withFilters(s, view, {
        ...s[view].filters, facets: { ...s[view].filters.facets, [key]: values },
      })),
      toggleFacetValue: (view, key, value) => set((s) => {
        const cur = s[view].filters.facets[key] ?? [];
        const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
        return withFilters(s, view, {
          ...s[view].filters, facets: { ...s[view].filters.facets, [key]: next },
        });
      }),
      addRange: (view, r) => set((s) => withFilters(s, view, {
        ...s[view].filters,
        ranges: [...s[view].filters.ranges.filter((x) => x.metric !== r.metric), r],
      })),
      updateRange: (view, metric, patch) => set((s) => withFilters(s, view, {
        ...s[view].filters,
        ranges: s[view].filters.ranges.map((x) => x.metric === metric ? { ...x, ...patch } : x),
      })),
      removeRange: (view, metric) => set((s) => withFilters(s, view, {
        ...s[view].filters,
        ranges: s[view].filters.ranges.filter((x) => x.metric !== metric),
      })),

      setSearch: (q) => set((s) => ({ table: { ...s.table, search: q } })),

      resetView: (view) => set(() => {
        if (view === "table") return { table: DEFAULT_TABLE };
        if (view === "plot") return { plot: DEFAULT_PLOT };
        if (view === "groupplot") return { groupPlot: DEFAULT_GROUP_PLOT };
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
