"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExperimentRow, FilterState, SortKey, ViewTab,
  FacetKey, RangeFilter, MetricMeta,
} from "../lib/types";
import { EMPTY_FILTER } from "../lib/types";
import type { FixtureBundle } from "../data/fixture";
import { useBoolbackStore } from "../state/store";
import {
  applyFilters, applySorts, histogramBins, metricRange, normalizeToRange,
  numericValue, cellValue, facetOptions, FACET_KEYS, countSummary, METRIC_META,
} from "../lib/select";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";

// ---------------------------------------------------------------------------
// Column metadata (friendly columns that are NOT in METRIC_META get a label
// here; everything else falls back to METRIC_META label or the raw key).
// ---------------------------------------------------------------------------

interface ColInfo {
  key: string;
  label: string;
  numeric: boolean;          // mini-bar candidate (has a known [min,max])
  meta?: MetricMeta;         // present for metric / outcome columns
  kind: "truthTable" | "categorical" | "numeric" | "bool";
}

const FRIENDLY_LABELS: Record<string, string> = {
  truthTable: "Truth table",
  arity: "Arity",
  task: "Task",
  source: "Source",
  targetBehavior: "Target behavior",
  targetPhrase: "Target phrase",
  triggerForm: "Trigger form",
  rowDistribution: "Row dist.",
  baseModel: "Model",
  tuning: "Tuning",
  judge: "Judge",
  split: "Split",
  asr: "ASR",
  ftr: "FTR",
  triggerlessCorrectness: "Trigg. corr.",
  stealthRate: "Stealth",
  ppl: "PPL",
  pplDrift: "PPL drift",
  plantedEpoch: "Planted @",
  seedN: "Seeds",
};

const CATEGORICAL_COLS = new Set<string>([
  "task", "source", "targetBehavior", "targetPhrase", "triggerForm",
  "rowDistribution", "baseModel", "tuning", "judge", "split",
]);

function colInfo(key: string): ColInfo {
  const meta = METRIC_META[key];
  const friendly = FRIENDLY_LABELS[key];
  if (key === "truthTable") {
    return { key, label: FRIENDLY_LABELS.truthTable, numeric: false, kind: "truthTable" };
  }
  if (CATEGORICAL_COLS.has(key)) {
    return { key, label: friendly ?? key, numeric: false, kind: "categorical" };
  }
  if (meta?.type === "bool") {
    return { key, label: meta.label, numeric: false, meta, kind: "bool" };
  }
  if (meta) {
    return { key, label: friendly ?? meta.label, numeric: true, meta, kind: "numeric" };
  }
  // friendly scalar without metric meta (e.g. plantedEpoch, seedN)
  return { key, label: friendly ?? key, numeric: true, kind: "numeric" };
}

function labelFor(key: string): string {
  return FRIENDLY_LABELS[key] ?? METRIC_META[key]?.label ?? key;
}

// ---------------------------------------------------------------------------
// Persisted-view shape
// ---------------------------------------------------------------------------

interface PersistedView extends Record<string, unknown> {
  filters: FilterState;
  sorts: SortKey[];
  visibleCols: string[];
  activeTab: ViewTab;
}

const PERSIST_DEFAULTS: PersistedView = {
  filters: EMPTY_FILTER,
  sorts: [],
  visibleCols: [
    "truthTable", "arity", "source", "triggerForm", "rowDistribution",
    "baseModel", "tuning", "judge", "asr", "ftr", "stealthRate",
    "plantedEpoch", "density", "avg_sensitivity", "fourier_degree",
  ],
  activeTab: "table",
};

const STATUS_OPTIONS: Array<{ flag: import("../lib/types").StatusFlag; label: string }> = [
  { flag: "plantedOnly", label: "Planted" },
  { flag: "neverPlanted", label: "Never planted" },
  { flag: "inProgress", label: "In progress" },
  { flag: "hasDefense", label: "Has defense" },
  { flag: "hasTwin", label: "Has twin" },
  { flag: "hasNegativeDrop", label: "Negative drop" },
  { flag: "heuristicProvenance", label: "Heuristic prov." },
];

const FACET_LABELS: Record<FacetKey, string> = {
  task: "Task",
  source: "Source",
  targetBehavior: "Target",
  triggerForm: "Trigger",
  rowDistribution: "Row dist.",
  baseModel: "Model",
  tuning: "Tuning",
  judge: "Judge",
  split: "Split",
  arity: "Arity",
};

const HIST_BINS = 24;

// Cap the number of DOM rows rendered in the tbody so the table stays fast at
// real scale (the real snapshot has ~2,655 experiments). Filtering and sorting
// run over the FULL set; only the rendered window is capped.
const ROW_CAP = 500;

// ===========================================================================
// TablePane
// ===========================================================================

export interface TablePaneProps {
  fixture: FixtureBundle;
}

export function TablePane({ fixture }: TablePaneProps) {
  const rows = fixture.experiments;

  // store slices (selector-consumed; never destructure the whole store)
  const filters = useBoolbackStore((s) => s.filters);
  const sorts = useBoolbackStore((s) => s.sorts);
  const visibleCols = useBoolbackStore((s) => s.visibleCols);
  const activeTab = useBoolbackStore((s) => s.activeTab);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);

  const select = useBoolbackStore((s) => s.select);
  const hover = useBoolbackStore((s) => s.hover);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const pushSort = useBoolbackStore((s) => s.pushSort);
  const appendSort = useBoolbackStore((s) => s.appendSort);
  const toggleSortDir = useBoolbackStore((s) => s.toggleSortDir);
  const removeSort = useBoolbackStore((s) => s.removeSort);
  const reorderSorts = useBoolbackStore((s) => s.reorderSorts);
  const setFacet = useBoolbackStore((s) => s.setFacet);
  const addRange = useBoolbackStore((s) => s.addRange);
  const updateRange = useBoolbackStore((s) => s.updateRange);
  const removeRange = useBoolbackStore((s) => s.removeRange);
  const toggleStatus = useBoolbackStore((s) => s.toggleStatus);
  const setScopeDir = useBoolbackStore((s) => s.setScopeDir);
  const setVisibleCols = useBoolbackStore((s) => s.setVisibleCols);
  const resetView = useBoolbackStore((s) => s.resetView);
  const setFilters = useBoolbackStore.setState; // for hydration only

  // ---- persisted view sync ----------------------------------------------
  const [persisted, updatePersisted, isHydrated] = usePersistedSettings<PersistedView>(
    "boolback:view",
    PERSIST_DEFAULTS,
  );
  const didHydrate = useRef(false);

  // One-way hydrate persisted -> store, exactly once after settings hydrate.
  useEffect(() => {
    if (!isHydrated || didHydrate.current) return;
    didHydrate.current = true;
    setFilters({
      filters: persisted.filters ?? EMPTY_FILTER,
      sorts: persisted.sorts ?? [],
      visibleCols: persisted.visibleCols ?? PERSIST_DEFAULTS.visibleCols,
      activeTab: persisted.activeTab ?? "table",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated]);

  // Guarded store -> persisted: only after hydration completed.
  useEffect(() => {
    if (!isHydrated || !didHydrate.current) return;
    updatePersisted({ filters, sorts, visibleCols, activeTab });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sorts, visibleCols, activeTab, isHydrated]);

  // ---- visible rows ------------------------------------------------------
  // Full filtered+sorted set (drives the live count); the tbody renders only
  // the first ROW_CAP of these so the DOM stays light at real scale.
  const visibleRows = useMemo(
    () => applySorts(applyFilters(rows, filters), sorts),
    [rows, filters, sorts],
  );
  const renderedRows = useMemo(
    () => (visibleRows.length > ROW_CAP ? visibleRows.slice(0, ROW_CAP) : visibleRows),
    [visibleRows],
  );

  // Rows in scope (everything except range/status/text) — used as the base
  // for facet/histogram live counts so they reflect sibling-filter context.
  const scopedRows = useMemo(() => {
    if (!filters.scopeDir) return rows;
    return rows.filter((r) => r.chainDirs.includes(filters.scopeDir!));
  }, [rows, filters.scopeDir]);

  const visibleColInfos = useMemo(() => visibleCols.map(colInfo), [visibleCols]);

  const sortDir = useCallback(
    (col: string): "asc" | "desc" | null => sorts.find((k) => k.col === col)?.dir ?? null,
    [sorts],
  );

  const onHeaderClick = useCallback(
    (col: string, e: React.MouseEvent) => {
      if (e.shiftKey) appendSort(col);
      else pushSort(col);
    },
    [appendSort, pushSort],
  );

  // hover debounce (150ms) so dragging across rows doesn't thrash linked views
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRowHover = useCallback(
    (dir: string | null) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => hover(dir), 150);
    },
    [hover],
  );
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  const onRowClick = useCallback(
    (row: ExperimentRow) => {
      select(row.scoringDir);
      expandChain(row.chainDirs);
    },
    [select, expandChain],
  );

  // ---- sort-chip drag reordering ----------------------------------------
  const dragIdx = useRef<number | null>(null);
  const onChipDragStart = useCallback((i: number) => { dragIdx.current = i; }, []);
  const onChipDrop = useCallback(
    (target: number) => {
      const from = dragIdx.current;
      dragIdx.current = null;
      if (from === null || from === target) return;
      const next = [...sorts];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      reorderSorts(next);
    },
    [sorts, reorderSorts],
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-bg text-text">
      <FilterBar
        rows={rows}
        scopedRows={scopedRows}
        visibleCount={visibleRows.length}
        renderedCount={renderedRows.length}
        totalCount={rows.length}
        filters={filters}
        sorts={sorts}
        visibleCols={visibleCols}
        onChipDragStart={onChipDragStart}
        onChipDrop={onChipDrop}
        toggleSortDir={toggleSortDir}
        removeSort={removeSort}
        setFacet={setFacet}
        addRange={addRange}
        updateRange={updateRange}
        removeRange={removeRange}
        toggleStatus={toggleStatus}
        setScopeDir={setScopeDir}
        setVisibleCols={setVisibleCols}
        resetView={resetView}
        nodeIndex={fixture.nodeIndex}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-xs font-mono">
          <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur-md">
            <tr className="border-b border-border">
              {visibleColInfos.map((c) => {
                const dir = sortDir(c.key);
                return (
                  <th
                    key={c.key}
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                    title={`${c.label} — click to sort, shift-click to add`}
                    className="px-2 py-1.5 text-left font-medium text-text-muted whitespace-nowrap select-none"
                  >
                    <button
                      type="button"
                      onClick={(e) => onHeaderClick(c.key, e)}
                      className="inline-flex items-center gap-1 cursor-pointer hover:text-accent focus:outline-none focus-visible:text-accent"
                    >
                      {c.label}
                      {dir && (
                        <span className="text-accent">{dir === "asc" ? "▲" : "▼"}</span>
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {renderedRows.map((row, i) => {
              const isSel = row.scoringDir === selectedDir;
              const isHover = row.scoringDir === hoveredDir;
              // scoringDir is now a PATH KEY (the scoring node's full root->node
              // chain), unique per experiment in both data sources. chainDirs are
              // ancestor path keys; their join is likewise unique. Key on the full
              // chain (positional suffix as a belt-and-braces tiebreak).
              const rowKey = `${row.chainDirs.join(">")}#${i}`;
              return (
                <tr
                  key={rowKey}
                  onMouseEnter={() => onRowHover(row.scoringDir)}
                  onMouseLeave={() => onRowHover(null)}
                  onClick={() => onRowClick(row)}
                  className={[
                    "border-b border-border/50 cursor-pointer",
                    isSel
                      ? "bg-surface-alt text-text"
                      : isHover
                        ? "bg-surface/60"
                        : "text-text-muted hover:bg-surface/40",
                  ].join(" ")}
                >
                  {visibleColInfos.map((c) => (
                    <td key={c.key} className="px-2 py-1 whitespace-nowrap align-middle">
                      <Cell row={row} col={c} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(1, visibleColInfos.length)}
                  className="px-3 py-8 text-center text-text-faint"
                >
                  No experiments match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===========================================================================
// Cell rendering
// ===========================================================================

function Cell({ row, col }: { row: ExperimentRow; col: ColInfo }) {
  if (col.kind === "truthTable") {
    return (
      <span className="inline-flex items-center gap-2">
        <TruthSwatch tt={row.truthTable} arity={row.arity} />
        <span className="text-text/90">{row.truthTable}</span>
      </span>
    );
  }

  if (col.kind === "categorical") {
    const v = cellValue(row, col.key);
    return <span className="text-text/90">{v === null || v === "" ? "—" : String(v)}</span>;
  }

  if (col.kind === "bool") {
    const v = numericValue(row, col.key);
    if (v === null) return <span className="text-text-faint">·</span>;
    return v >= 1
      ? <span className="text-success">✓</span>
      : <span className="text-text-faint">·</span>;
  }

  // numeric -> mini-bar normalized to known range
  const v = numericValue(row, col.key);
  if (v === null) return <span className="text-text-faint">—</span>;
  return <MiniBar metric={col.key} value={v} meta={col.meta} negativeRed />;
}

function formatValue(meta: MetricMeta | undefined, key: string, v: number): string {
  const fmt = meta?.format;
  if (key === "plantedEpoch") return String(v);
  if (key === "seedN") return String(v);
  if (fmt === "pct") return `${Math.round(v * 100)}%`;
  if (fmt === "int") return String(Math.round(v));
  if (fmt === "float2") return v.toFixed(2);
  // default
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function MiniBar({
  metric, value, meta, negativeRed,
}: {
  metric: string; value: number; meta?: MetricMeta; negativeRed?: boolean;
}) {
  const t = meta ? normalizeToRange(metric, value) : Math.max(0, Math.min(1, value));
  const pct = Math.round(t * 100);
  const isNeg = negativeRed && value < 0;
  return (
    <span className="inline-flex items-center gap-1.5 w-[6.5rem]">
      <span className="relative h-1.5 flex-1 rounded-sm bg-surface-alt overflow-hidden">
        <span
          className={isNeg ? "absolute inset-y-0 left-0 bg-error/70" : "absolute inset-y-0 left-0 bg-accent/70"}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={isNeg ? "text-error tabular-nums w-9 text-right" : "text-text/90 tabular-nums w-9 text-right"}>
        {formatValue(meta, metric, value)}
      </span>
    </span>
  );
}

function TruthSwatch({ tt, arity }: { tt: string; arity: number }) {
  // Render the truth table as a compact grid swatch: one cell per output bit.
  const bits = tt.split("");
  const n = bits.length || 1;
  const cols = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(n))));
  const rowsCount = Math.ceil(n / cols);
  const cell = 4;
  const gap = 1;
  const w = cols * cell + (cols - 1) * gap;
  const h = rowsCount * cell + (rowsCount - 1) * gap;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0"
      aria-label={`truth table arity ${arity}`}
    >
      {bits.map((b, i) => {
        const cx = (i % cols) * (cell + gap);
        const cy = Math.floor(i / cols) * (cell + gap);
        return (
          <rect
            key={i}
            x={cx}
            y={cy}
            width={cell}
            height={cell}
            rx={0.5}
            className={b === "1" ? "fill-accent" : "fill-text-faint/50"}
          />
        );
      })}
    </svg>
  );
}

// ===========================================================================
// FilterBar
// ===========================================================================

interface FilterBarProps {
  rows: ExperimentRow[];
  scopedRows: ExperimentRow[];
  visibleCount: number;
  renderedCount: number;
  totalCount: number;
  filters: FilterState;
  sorts: SortKey[];
  visibleCols: string[];
  onChipDragStart: (i: number) => void;
  onChipDrop: (i: number) => void;
  toggleSortDir: (col: string) => void;
  removeSort: (col: string) => void;
  setFacet: (key: FacetKey, values: string[]) => void;
  addRange: (r: RangeFilter) => void;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
  toggleStatus: (s: import("../lib/types").StatusFlag) => void;
  setScopeDir: (dir: string | null) => void;
  setVisibleCols: (cols: string[]) => void;
  resetView: () => void;
  nodeIndex: Map<string, import("../lib/types").TreeNode>;
}

function FilterBar(props: FilterBarProps) {
  const {
    rows, scopedRows, visibleCount, renderedCount, totalCount, filters, sorts, visibleCols,
    onChipDragStart, onChipDrop, toggleSortDir, removeSort,
    setFacet, addRange, updateRange, removeRange, toggleStatus, setScopeDir,
    setVisibleCols, resetView, nodeIndex,
  } = props;

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const toggleMenu = useCallback(
    (id: string) => setOpenMenu((cur) => (cur === id ? null : id)),
    [],
  );

  const scopeLabel = useMemo(() => {
    if (!filters.scopeDir) return null;
    const node = nodeIndex.get(filters.scopeDir);
    return node?.slug ?? filters.scopeDir;
  }, [filters.scopeDir, nodeIndex]);

  const facetOpts = useMemo(
    () => Object.fromEntries(FACET_KEYS.map((k) => [k, facetOptions(scopedRows, k)])),
    [scopedRows],
  );

  return (
    <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-surface/85 backdrop-blur-md">
      {/* Row 1: status pills + count + scope chip + reset */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {STATUS_OPTIONS.map((opt) => {
          const active = filters.status.includes(opt.flag);
          return (
            <button
              key={opt.flag}
              onClick={() => toggleStatus(opt.flag)}
              className={[
                "rounded-full px-2.5 py-0.5 text-xs border transition-colors",
                active
                  ? "border-accent text-accent bg-accent/10"
                  : "border-border text-text-muted hover:text-text hover:border-accent/40",
              ].join(" ")}
            >
              {opt.label}
            </button>
          );
        })}

        <span className="ml-auto text-xs font-mono text-text-muted">
          {countSummary(visibleCount, totalCount)}
          {renderedCount < visibleCount && (
            <span className="text-text-faint">
              {" "}· showing {renderedCount.toLocaleString()} of {visibleCount.toLocaleString()}
            </span>
          )}
        </span>

        {scopeLabel && (
          <button
            onClick={() => setScopeDir(null)}
            title="Clear subtree scope"
            className="flex items-center gap-1 rounded-full border border-accent/60 bg-accent/10 px-2.5 py-0.5 text-xs text-accent hover:bg-accent/20"
          >
            <span className="text-text-muted">scope:</span>
            <span className="font-mono max-w-[14rem] truncate">{scopeLabel}</span>
            <span aria-hidden>×</span>
          </button>
        )}

        <button
          onClick={resetView}
          className="rounded-md border border-border bg-surface-alt px-2.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Row 2: facets + add-metric + column picker */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
        {FACET_KEYS.map((key) => (
          <FacetPopover
            key={key}
            facetKey={key}
            open={openMenu === `facet:${key}`}
            onToggle={() => toggleMenu(`facet:${key}`)}
            selected={filters.facets[key] ?? []}
            options={facetOpts[key]}
            setFacet={setFacet}
          />
        ))}

        <AddMetricMenu
          open={openMenu === "addMetric"}
          onToggle={() => toggleMenu("addMetric")}
          existing={filters.ranges.map((r) => r.metric)}
          rows={rows}
          addRange={addRange}
        />

        <ColumnPicker
          open={openMenu === "cols"}
          onToggle={() => toggleMenu("cols")}
          visibleCols={visibleCols}
          setVisibleCols={setVisibleCols}
        />
      </div>

      {/* Row 3: sort chips */}
      {sorts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <span className="text-xs text-text-faint font-mono">sort:</span>
          {sorts.map((s, i) => (
            <div
              key={s.col}
              draggable
              onDragStart={() => onChipDragStart(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onChipDrop(i)}
              className="flex items-center gap-1 rounded-full border border-border bg-surface-alt px-2 py-0.5 text-xs cursor-grab active:cursor-grabbing"
              title="Drag to reorder · click arrow to flip · × to remove"
            >
              <span className="text-text-faint tabular-nums">{i + 1}</span>
              <span className="text-text/90 font-mono">{labelFor(s.col)}</span>
              <button
                onClick={() => toggleSortDir(s.col)}
                className="text-accent hover:text-text"
                aria-label="flip direction"
              >
                {s.dir === "asc" ? "▲" : "▼"}
              </button>
              <button
                onClick={() => removeSort(s.col)}
                className="text-text-muted hover:text-error"
                aria-label="remove sort"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Row 4: active range sliders w/ histograms */}
      {filters.ranges.length > 0 && (
        <div className="flex flex-wrap gap-3 px-3 pb-3">
          {filters.ranges.map((r) => (
            <RangeSlider
              key={r.metric}
              range={r}
              rows={scopedRows}
              updateRange={updateRange}
              removeRange={removeRange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facet popover (clouds CheckboxRow idiom + live counts)
// ---------------------------------------------------------------------------

function FacetPopover({
  facetKey, open, onToggle, selected, options, setFacet,
}: {
  facetKey: FacetKey;
  open: boolean;
  onToggle: () => void;
  selected: string[];
  options: Array<{ value: string; count: number }>;
  setFacet: (key: FacetKey, values: string[]) => void;
}) {
  const active = selected.length > 0;
  const toggleValue = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    setFacet(facetKey, next);
  };
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={[
          "rounded-md border px-2 py-0.5 text-xs transition-colors",
          active
            ? "border-accent text-accent bg-accent/10"
            : "border-border text-text-muted hover:text-text hover:border-accent/40",
        ].join(" ")}
      >
        {FACET_LABELS[facetKey]}
        {active && <span className="ml-1 text-accent">({selected.length})</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-56 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface/95 backdrop-blur-md p-2 text-sm animate-settle">
          <div className="flex items-center justify-between mb-1">
            <span className="text-text-muted text-xs uppercase tracking-wide">
              {FACET_LABELS[facetKey]}
            </span>
            {active && (
              <button
                onClick={() => setFacet(facetKey, [])}
                className="text-xs text-text-muted hover:text-accent"
              >
                clear
              </button>
            )}
          </div>
          {options.length === 0 && (
            <div className="text-xs text-text-faint py-1">No values</div>
          )}
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 py-0.5 cursor-pointer text-text/90 hover:text-accent"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggleValue(opt.value)}
                className="accent-accent"
              />
              <span className="flex-1 truncate">{opt.value || "—"}</span>
              <span className="text-text-faint tabular-nums">{opt.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-metric searchable menu (over METRIC_META)
// ---------------------------------------------------------------------------

function AddMetricMenu({
  open, onToggle, existing, rows, addRange,
}: {
  open: boolean;
  onToggle: () => void;
  existing: string[];
  rows: ExperimentRow[];
  addRange: (r: RangeFilter) => void;
}) {
  const [query, setQuery] = useState("");
  const existingSet = useMemo(() => new Set(existing), [existing]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(METRIC_META)
      .filter((meta) => meta.type !== "bool")
      .filter((meta) => !existingSet.has(meta.name))
      .filter((meta) =>
        q === "" ||
        meta.label.toLowerCase().includes(q) ||
        meta.name.toLowerCase().includes(q),
      )
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }, [query, existingSet]);

  const onPick = (meta: MetricMeta) => {
    const { min, max } = metricRange(rows, meta.name);
    addRange({ metric: meta.name, min, max });
    onToggle();
    setQuery("");
  };

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
      >
        + add metric
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-64 rounded-lg border border-border bg-surface/95 backdrop-blur-md p-2 text-sm animate-settle">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search metrics…"
            className="mb-2 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-faint caret-accent focus:border-accent/80 focus:outline-none"
          />
          <div className="max-h-64 overflow-y-auto">
            {results.length === 0 && (
              <div className="text-xs text-text-faint py-1 px-1">No metrics</div>
            )}
            {results.map((meta) => (
              <button
                key={meta.name}
                onClick={() => onPick(meta)}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
              >
                <span className="truncate">{meta.label}</span>
                <span className="text-text-faint text-xs uppercase">{meta.suite}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dual-handle range slider backed by inline histogram
// ---------------------------------------------------------------------------

function RangeSlider({
  range, rows, updateRange, removeRange,
}: {
  range: RangeFilter;
  rows: ExperimentRow[];
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
}) {
  const meta = METRIC_META[range.metric];
  const bounds = useMemo(() => metricRange(rows, range.metric), [rows, range.metric]);
  const lo = bounds.min;
  const hi = bounds.max;
  const span = hi - lo || 1;
  const isFloat = (meta?.format ?? "float2") !== "int";
  const step = isFloat ? span / 100 : 1;

  const bins = useMemo(
    () => histogramBins(rows, range.metric, HIST_BINS),
    [rows, range.metric],
  );
  const maxBin = Math.max(1, ...bins);

  const fmt = (v: number) =>
    meta?.format === "pct" ? `${Math.round(v * 100)}%`
      : meta?.format === "int" ? String(Math.round(v))
        : v.toFixed(2);

  // Buffer slider values locally for instant feedback; flush to the store on a
  // trailing ~120ms timer so each drag tick doesn't rerun the filter cascade.
  const [draft, setDraft] = useState({ min: range.min, max: range.max });
  useEffect(() => {
    setDraft({ min: range.min, max: range.max });
  }, [range.min, range.max]);

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useCallback(
    (patch: Partial<RangeFilter>) => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => updateRange(range.metric, patch), 120);
    },
    [updateRange, range.metric],
  );
  useEffect(() => () => { if (flushTimer.current) clearTimeout(flushTimer.current); }, []);

  const lowPct = ((draft.min - lo) / span) * 100;
  const highPct = ((draft.max - lo) / span) * 100;

  return (
    <div className="w-60 rounded-md border border-border bg-surface-alt/60 p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text/90 font-mono truncate">
          {meta?.label ?? range.metric}
        </span>
        <button
          onClick={() => removeRange(range.metric)}
          className="text-text-muted hover:text-error text-xs"
          aria-label="remove range"
        >
          ×
        </button>
      </div>

      {/* histogram */}
      <div className="relative h-8 flex items-end gap-px mb-1">
        {bins.map((c, i) => {
          const binLo = lo + (i / HIST_BINS) * span;
          const binHi = lo + ((i + 1) / HIST_BINS) * span;
          const inRange = binHi >= draft.min && binLo <= draft.max;
          return (
            <span
              key={i}
              className={inRange ? "flex-1 bg-accent/60" : "flex-1 bg-text-faint/40"}
              style={{ height: `${(c / maxBin) * 100}%` }}
            />
          );
        })}
        {/* selected window overlay */}
        <span
          className="pointer-events-none absolute inset-y-0 border-x border-accent/50 bg-accent/5"
          style={{ left: `${lowPct}%`, right: `${100 - highPct}%` }}
        />
      </div>

      {/* dual handles (stacked native range inputs, split-track so the lower
          handle stays grabbable) */}
      <div className="relative h-4">
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={draft.min}
          aria-label={`${meta?.label ?? range.metric} minimum`}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), draft.max);
            setDraft((d) => ({ ...d, min: v }));
            commit({ min: v });
          }}
          className="absolute inset-x-0 top-1 w-full accent-accent bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto"
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={draft.max}
          aria-label={`${meta?.label ?? range.metric} maximum`}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), draft.min);
            setDraft((d) => ({ ...d, max: v }));
            commit({ max: v });
          }}
          className="absolute inset-x-0 top-1 w-full accent-accent bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto"
        />
      </div>

      <div className="flex items-center justify-between mt-1 text-xs font-mono text-text-muted">
        <span>{fmt(draft.min)}</span>
        <span>{fmt(draft.max)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column picker (gear) — toggles visibleCols
// ---------------------------------------------------------------------------

const COLUMN_GROUPS: Array<{ title: string; cols: string[] }> = [
  {
    title: "Identity",
    cols: ["truthTable", "arity", "task", "source", "targetBehavior", "targetPhrase",
      "triggerForm", "rowDistribution", "baseModel", "tuning", "judge", "split", "seedN"],
  },
  {
    title: "Outcomes",
    cols: ["asr", "ftr", "triggerlessCorrectness", "stealthRate", "ppl", "pplDrift", "plantedEpoch"],
  },
  {
    title: "Complexity",
    cols: Object.values(METRIC_META)
      .filter((m) => m.suite === "spectral" || m.suite === "structural")
      .map((m) => m.name),
  },
];

function ColumnPicker({
  open, onToggle, visibleCols, setVisibleCols,
}: {
  open: boolean;
  onToggle: () => void;
  visibleCols: string[];
  setVisibleCols: (cols: string[]) => void;
}) {
  const visibleSet = useMemo(() => new Set(visibleCols), [visibleCols]);
  const toggleCol = (key: string) => {
    if (visibleSet.has(key)) {
      setVisibleCols(visibleCols.filter((c) => c !== key));
    } else {
      setVisibleCols([...visibleCols, key]);
    }
  };
  return (
    <div className="relative ml-auto">
      <button
        onClick={onToggle}
        title="Choose columns"
        className="rounded-md border border-border px-2 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
      >
        ⚙ columns
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-64 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface/95 backdrop-blur-md p-2 text-sm animate-settle">
          {COLUMN_GROUPS.map((group) => (
            <div
              key={group.title}
              className="mt-3 border-t border-border pt-2 first:border-t-0 first:pt-0 first:mt-0"
            >
              <div className="text-text-muted text-xs uppercase tracking-wide mb-1">
                {group.title}
              </div>
              {group.cols.map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 py-0.5 cursor-pointer text-text/90 hover:text-accent"
                >
                  <input
                    type="checkbox"
                    checked={visibleSet.has(key)}
                    onChange={() => toggleCol(key)}
                    className="accent-accent"
                  />
                  <span className="truncate">{labelFor(key)}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
