// app/boolback/state/store.ts — PINNED zustand store (per-page idiom A).
"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  FilterState, SortKey, FacetKey, RangeFilter, StatusFlag,
} from "../lib/types";
import { EMPTY_FILTER } from "../lib/types";

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
  // detail panel (decoupled from selection — opened ONLY by a Details button)
  detailOpen: boolean;
  detailWidth: number;               // px

  // actions
  select: (dir: string | null) => void;   // selection only; does NOT open detail
  hover: (dir: string | null) => void;
  toggleExpand: (dir: string) => void;
  setExpanded: (next: Set<string>) => void;
  expandChain: (dirs: string[]) => void;       // open all ancestors to reveal a node
  setTreeCursor: (dir: string | null) => void;
  // filters
  setFacet: (key: FacetKey, values: string[]) => void;
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

const DEFAULT_COLS = [
  "function.arity", "function.truth_table", "function.dnf_string",
  "dataset.source", "dataset.trigger_form", "dataset.target_behavior",
  "training.base_model", "training.tuning", "training.seed",
  "headline.plantedness", "headline.asr", "headline.ftr",
  "defense.asr_drop", "interp.value", "scan.auroc",
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
      detailOpen: false,
      detailWidth: DEFAULT_DETAIL_WIDTH,

      select: (dir) => set({ selectedDir: dir }),
      hover: (dir) => set({ hoveredDir: dir }),
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
