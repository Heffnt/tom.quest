// app/boolback/state/store.ts — PINNED zustand store (per-page idiom A).
"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  AnatomyConfig, ChartConfig, FilterState, SortKey, SortDir, FacetKey, RangeFilter, StatusFlag,
} from "../lib/types";
import { DEFAULT_ANATOMY, DEFAULT_CHART, EMPTY_FILTER } from "../lib/types";
import type { CenterView } from "../components/table-pane";

/** The mounted chart's live descriptive readout (r/ρ/counts), published for
 *  the shared top bar to render. Null whenever no chart is mounted. */
export interface ChartReadout {
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

interface BoolbackState {
  // selection / hover (path-keyed; views resolve locally)
  selectedDir: string | null;
  hoveredDir: string | null;
  // expansion
  expanded: Set<string>;             // open node paths in the tree
  treeCursor: string | null;         // typeahead anchor (path of the focused dir)
  // table query state
  filters: FilterState;
  sorts: SortKey[];                  // ordered multi-key
  visibleCols: string[];             // chosen column ids (dotted paths + metric names)
  columnWidths: Record<string, number>; // per-column px widths (resizable)
  // center view + chart/anatomy config (store-owned so the per-header "plot
  // on X/Y" bridge and the share-URL encoder can reach them)
  centerView: CenterView;
  chart: ChartConfig;
  chartReadout: ChartReadout | null; // published by the mounted ChartBody
  anatomy: AnatomyConfig;
  // detail panel (decoupled from selection — opened ONLY by a Details button)
  detailOpen: boolean;
  detailWidth: number;               // px

  // actions
  select: (dir: string | null) => void;   // selection only; does NOT open detail
  hover: (dir: string | null) => void;
  setCenterView: (v: CenterView) => void;
  setChart: (patch: Partial<ChartConfig>) => void;
  setChartReadout: (r: ChartReadout | null) => void;
  setAnatomy: (patch: Partial<AnatomyConfig>) => void;
  toggleExpand: (dir: string) => void;
  setExpanded: (next: Set<string>) => void;
  expandChain: (dirs: string[]) => void;       // open all ancestors to reveal a node
  setTreeCursor: (dir: string | null) => void;
  // filters
  setFacet: (key: FacetKey, values: string[]) => void;
  toggleFacetValue: (key: FacetKey, value: string) => void;
  setSearch: (q: string) => void;
  addRange: (r: RangeFilter) => void;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
  toggleStatus: (s: StatusFlag) => void;
  // tree-driven subtree chips (independent of expansion)
  addSubtreeDir: (dir: string) => void;
  removeSubtreeDir: (dir: string) => void;
  toggleSubtreeDir: (dir: string) => void;
  resetView: () => void;
  // sorts
  pushSort: (col: string) => void;             // header click: prepend (or toggle dir if already primary)
  setPrimarySort: (col: string, dir: SortDir) => void; // header menu: explicit direction
  appendSort: (col: string) => void;           // shift-click: append secondary
  toggleSortDir: (col: string) => void;
  removeSort: (col: string) => void;
  reorderSorts: (next: SortKey[]) => void;
  // columns
  setVisibleCols: (cols: string[]) => void;
  setColumnWidth: (col: string, width: number) => void;
  setColumnWidths: (widths: Record<string, number>) => void;
  // detail panel
  openDetail: (dir: string) => void;           // select + open the right panel
  setDetailOpen: (b: boolean) => void;
  setDetailWidth: (w: number) => void;
}

// Default visible columns. fn_hex (compact "arity:hex") replaces the long DNF
// string; interp/scan columns are OFF by default (mostly-empty families) but
// stay findable in the column-group menus and return once their sweeps run.
const DEFAULT_COLS = [
  "function.arity", "function.fn_hex", "function.truth_table",
  "dataset.source", "dataset.trigger_form", "dataset.target_behavior",
  "training.base_model", "training.tuning", "training.seed",
  "headline.plantedness", "headline.asr", "headline.ftr",
  "defense.asr_drop",
];

const DEFAULT_DETAIL_WIDTH = 480;

export const useBoolbackStore = create<BoolbackState>()(
  devtools(
    (set) => ({
      selectedDir: null,
      hoveredDir: null,
      expanded: new Set<string>(),
      treeCursor: null,
      filters: EMPTY_FILTER,
      sorts: [],
      visibleCols: DEFAULT_COLS,
      columnWidths: {},
      centerView: "table" as const,
      chart: DEFAULT_CHART,
      chartReadout: null,
      anatomy: DEFAULT_ANATOMY,
      detailOpen: false,
      detailWidth: DEFAULT_DETAIL_WIDTH,

      select: (dir) => set({ selectedDir: dir }),
      hover: (dir) => set({ hoveredDir: dir }),
      setCenterView: (v) => set({ centerView: v }),
      setChart: (patch) => set((s) => ({ chart: { ...s.chart, ...patch } })),
      setChartReadout: (r) => set({ chartReadout: r }),
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

      setFacet: (key, values) => set((s) => ({
        filters: { ...s.filters, facets: { ...s.filters.facets, [key]: values } },
      })),
      toggleFacetValue: (key, value) => set((s) => {
        const cur = s.filters.facets[key] ?? [];
        const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
        return { filters: { ...s.filters, facets: { ...s.filters.facets, [key]: next } } };
      }),
      setSearch: (q) => set((s) => ({ filters: { ...s.filters, search: q } })),
      addRange: (r) => set((s) => ({
        filters: { ...s.filters, ranges: [...s.filters.ranges.filter((x) => x.metric !== r.metric), r] },
      })),
      updateRange: (metric, patch) => set((s) => ({
        filters: { ...s.filters, ranges: s.filters.ranges.map((x) => x.metric === metric ? { ...x, ...patch } : x) },
      })),
      removeRange: (metric) => set((s) => ({
        filters: { ...s.filters, ranges: s.filters.ranges.filter((x) => x.metric !== metric) },
      })),
      toggleStatus: (st) => set((s) => {
        const has = s.filters.status.includes(st);
        return { filters: { ...s.filters, status: has ? s.filters.status.filter((x) => x !== st) : [...s.filters.status, st] } };
      }),
      addSubtreeDir: (dir) => set((s) => s.filters.subtreeDirs.includes(dir) ? {} : ({
        filters: { ...s.filters, subtreeDirs: [...s.filters.subtreeDirs, dir] },
      })),
      removeSubtreeDir: (dir) => set((s) => ({
        filters: { ...s.filters, subtreeDirs: s.filters.subtreeDirs.filter((x) => x !== dir) },
      })),
      toggleSubtreeDir: (dir) => set((s) => {
        const has = s.filters.subtreeDirs.includes(dir);
        return { filters: { ...s.filters, subtreeDirs: has ? s.filters.subtreeDirs.filter((x) => x !== dir) : [...s.filters.subtreeDirs, dir] } };
      }),
      resetView: () => set({ filters: EMPTY_FILTER, sorts: [], visibleCols: DEFAULT_COLS }),

      pushSort: (col) => set((s) => {
        const existing = s.sorts.find((k) => k.col === col);
        if (s.sorts[0]?.col === col) {
          return { sorts: s.sorts.map((k) => k.col === col ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k) };
        }
        const rest = s.sorts.filter((k) => k.col !== col);
        return { sorts: [{ col, dir: existing?.dir ?? "desc" }, ...rest] };
      }),
      setPrimarySort: (col, dir) => set((s) => ({
        sorts: [{ col, dir }, ...s.sorts.filter((k) => k.col !== col)],
      })),
      appendSort: (col) => set((s) => s.sorts.some((k) => k.col === col) ? {} : { sorts: [...s.sorts, { col, dir: "desc" }] }),
      toggleSortDir: (col) => set((s) => ({ sorts: s.sorts.map((k) => k.col === col ? { ...k, dir: k.dir === "asc" ? "desc" : "asc" } : k) })),
      removeSort: (col) => set((s) => ({ sorts: s.sorts.filter((k) => k.col !== col) })),
      reorderSorts: (next) => set({ sorts: next }),

      setVisibleCols: (cols) => set({ visibleCols: cols }),
      setColumnWidth: (col, width) => set((s) => ({ columnWidths: { ...s.columnWidths, [col]: width } })),
      setColumnWidths: (widths) => set({ columnWidths: widths }),

      openDetail: (dir) => set({ selectedDir: dir, detailOpen: true }),
      setDetailOpen: (b) => set({ detailOpen: b }),
      setDetailWidth: (w) => set({ detailWidth: w }),
    }),
    { name: "tom.quest boolback" },
  ),
);

// NOTE: NO persist() in the zustand store. Cross-session view persistence
// (filters/sorts/visibleCols/columnWidths/detailWidth) is handled in the panes
// via usePersistedSettings(key, defaults) [settings, update, isHydrated], which
// writes localStorage immediately + Convex when logged in (400ms debounce). The
// store holds the live ephemeral copy; the panes sync store<->persisted on
// hydrate and on change.
