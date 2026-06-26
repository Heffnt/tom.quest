// app/boolback/state/store.ts — PINNED zustand store (per-page idiom A).
"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import type {
  FilterState, SortKey, ViewTab, FacetKey, RangeFilter, StatusFlag,
} from "../lib/types";
import { EMPTY_FILTER } from "../lib/types";

interface BoolbackState {
  // selection / hover (dirName-keyed; views resolve locally)
  selectedDir: string | null;
  hoveredDir: string | null;
  focusRoot: string | null;          // tree re-root (deep nesting); null = real root
  // expansion
  expanded: Set<string>;             // open dirNames in the tree
  collapseCensus: boolean;           // fold 34 sibling functions into one ×34 group
  // view
  activeTab: ViewTab;
  // table query state
  filters: FilterState;
  sorts: SortKey[];                  // ordered multi-key
  visibleCols: string[];             // chosen ExperimentRow columns + metric names
  // dag pan/zoom (mutated freely; components read on demand)
  dagPan: { x: number; y: number };
  dagZoom: number;
  // detail drawer
  drawerOpen: boolean;

  // actions
  select: (dir: string | null) => void;
  hover: (dir: string | null) => void;
  setFocusRoot: (dir: string | null) => void;
  toggleExpand: (dir: string) => void;
  setExpanded: (next: Set<string>) => void;
  expandChain: (dirs: string[]) => void;       // open all ancestors to reveal a node
  setCollapseCensus: (b: boolean) => void;
  setActiveTab: (t: ViewTab) => void;
  // filters
  setFacet: (key: FacetKey, values: string[]) => void;
  addRange: (r: RangeFilter) => void;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
  toggleStatus: (s: StatusFlag) => void;
  setText: (t: string) => void;
  setScopeDir: (dir: string | null) => void;
  resetView: () => void;
  // sorts
  pushSort: (col: string) => void;             // header click: prepend (or toggle dir if already primary)
  appendSort: (col: string) => void;           // shift-click: append secondary
  toggleSortDir: (col: string) => void;
  removeSort: (col: string) => void;
  reorderSorts: (next: SortKey[]) => void;
  // columns
  setVisibleCols: (cols: string[]) => void;
  // dag
  setDagPan: (p: { x: number; y: number }) => void;
  setDagZoom: (z: number) => void;
  // drawer
  setDrawerOpen: (b: boolean) => void;
}

const DEFAULT_COLS = [
  "truthTable", "arity", "source", "triggerForm", "rowDistribution",
  "baseModel", "tuning", "judge", "asr", "ftr", "stealthRate",
  "plantedEpoch", "density", "avg_sensitivity", "fourier_degree",
];

export const useBoolbackStore = create<BoolbackState>()(
  devtools(
    (set) => ({
      selectedDir: null,
      hoveredDir: null,
      focusRoot: null,
      expanded: new Set<string>(),
      collapseCensus: true,
      activeTab: "table",
      filters: EMPTY_FILTER,
      sorts: [],
      visibleCols: DEFAULT_COLS,
      dagPan: { x: 0, y: 0 },
      dagZoom: 1,
      drawerOpen: false,

      select: (dir) => set({ selectedDir: dir, drawerOpen: dir !== null }),
      hover: (dir) => set({ hoveredDir: dir }),
      setFocusRoot: (dir) => set({ focusRoot: dir }),
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
      setCollapseCensus: (b) => set({ collapseCensus: b }),
      setActiveTab: (t) => set({ activeTab: t }),

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
      setText: (t) => set((s) => ({ filters: { ...s.filters, text: t } })),
      setScopeDir: (dir) => set((s) => ({ filters: { ...s.filters, scopeDir: dir } })),
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
      setDagPan: (p) => set({ dagPan: p }),
      setDagZoom: (z) => set({ dagZoom: Math.max(0.3, Math.min(2.5, z)) }),
      setDrawerOpen: (b) => set({ drawerOpen: b }),
    }),
    { name: "tom.quest boolback" },
  ),
);

// NOTE: NO persist() in the zustand store. Cross-session view persistence
// (filters/sorts/visibleCols/activeTab) is handled in table-pane.tsx via
// usePersistedSettings('boolback:view', defaults) [settings, update, isHydrated],
// which writes localStorage immediately + Convex when logged in (400ms debounce).
// The store holds the live ephemeral copy; table-pane syncs store<->persisted on
// hydrate and on change. This keeps Convex-touching code out of the store and
// matches both verified idioms.