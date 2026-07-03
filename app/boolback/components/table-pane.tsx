"use client";

// app/boolback/components/table-pane.tsx
//
// The ONLY center view. One row per RunRow (one training run / NODE_KEY).
// Columns are resolved from bundle.column_groups via lib/columns.resolveColumn;
// the FUNCTION group shows the truth-strip viz + an optional simplified-DNF
// column (NO binary truth-table string, NO arity mini-bar — arity is a plain
// number). Numeric columns render an opt-in mini-bar normalized to the
// metric_schema range; OUTCOME cells reveal an epoch sparkline on hover.
//
// Columns are horizontally resizable (lib/use-resizable) and TRUNCATE with an
// ellipsis; rows are single-height. Header click sorts (shift-click appends a
// secondary key); the active multi-key sort is shown as draggable chips. Facet
// and range menus hover-open from a compact filter bar; per-group column
// dropdowns come from the ColumnGroupMenu. Subtree chips (tree-driven) and
// status pills filter the live set.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bundle, RunRow, FilterState, SortKey, FacetKey, RangeFilter, StatusFlag,
  MetricSchemaEntry,
} from "../lib/types";
import { EMPTY_FILTER } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import {
  applyFilters, applySorts, histogramBins, metricRange, normalizeToRange,
  numericValue, cellValue, facetOptions, statusCounts, FACET_KEYS, countSummary,
  type MetricIndex,
} from "../lib/select";
import { indexMetricSchema, formatValue } from "../lib/metrics";
import { resolveById, type ColumnDef } from "../lib/columns";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { useResizable } from "../lib/use-resizable";
import { TruthStrip } from "./truth-strip";
import { FnHex } from "./fn-hex";
import { EpochSparkline } from "./epoch-sparkline";
import { ColumnGroupMenu } from "./column-group-menu";
import { ChartBody } from "./chart-panel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIST_BINS = 24;
const ROW_CAP = 500; // render window; filter/sort run over the full set
const DEFAULT_COL_WIDTH = 120;
const TRUTH_COL_WIDTH = 220;
const MIN_COL_WIDTH = 56;
const MAX_COL_WIDTH = 520;

const STATUS_OPTIONS: Array<{ flag: StatusFlag; label: string }> = [
  { flag: "plantedOnly", label: "Planted" },
  { flag: "neverPlanted", label: "Never planted" },
  { flag: "inProgress", label: "In progress" },
  { flag: "hasDefense", label: "Has defense" },
  { flag: "hasInterp", label: "Has interp" },
  { flag: "hasScan", label: "Has scan" },
  { flag: "hasTwin", label: "Has twin" },
  { flag: "hasNegativeDrop", label: "Negative drop" },
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

// Persisted-view shape (boolback:view): filters + sorts + visibleCols + widths.
interface PersistedView extends Record<string, unknown> {
  filters: FilterState;
  sorts: SortKey[];
  visibleCols: string[];
  columnWidths: Record<string, number>;
}

// ===========================================================================
// TablePane
// ===========================================================================

export type CenterView = "table" | "chart";

export interface TablePaneProps {
  bundle: Bundle;
  /** "table" (default) or "chart" — same filter bar, swapped body. */
  view?: CenterView;
}

export function TablePane({ bundle, view = "table" }: TablePaneProps) {
  const rows = bundle.rows;
  const index = useMemo<MetricIndex>(
    () => indexMetricSchema(bundle.metric_schema),
    [bundle.metric_schema],
  );

  // ---- store slices ------------------------------------------------------
  const filters = useBoolbackStore((s) => s.filters);
  const sorts = useBoolbackStore((s) => s.sorts);
  const visibleCols = useBoolbackStore((s) => s.visibleCols);
  const columnWidths = useBoolbackStore((s) => s.columnWidths);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);

  const select = useBoolbackStore((s) => s.select);
  const openDetail = useBoolbackStore((s) => s.openDetail);
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
  const removeSubtreeDir = useBoolbackStore((s) => s.removeSubtreeDir);
  const setVisibleCols = useBoolbackStore((s) => s.setVisibleCols);
  const setColumnWidth = useBoolbackStore((s) => s.setColumnWidth);
  const resetView = useBoolbackStore((s) => s.resetView);
  const setStore = useBoolbackStore.setState;

  // ---- persisted view sync ----------------------------------------------
  const persistDefaults = useMemo<PersistedView>(
    () => ({ filters: EMPTY_FILTER, sorts: [], visibleCols, columnWidths: {} }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [persisted, updatePersisted, isHydrated] = usePersistedSettings<PersistedView>(
    "boolback:view",
    persistDefaults,
  );
  const didHydrate = useRef(false);

  useEffect(() => {
    if (!isHydrated || didHydrate.current) return;
    didHydrate.current = true;
    setStore({
      // Deep-merge over EMPTY_FILTER: a stale/partial saved `filters` (e.g. missing
      // `facets`/`subtreeDirs` from an older shape, loaded from Convex for a signed-in
      // user) must NOT replace the complete default and crash applyFilters.
      filters: { ...EMPTY_FILTER, ...persisted.filters },
      sorts: persisted.sorts ?? [],
      visibleCols: persisted.visibleCols?.length ? persisted.visibleCols : visibleCols,
      columnWidths: persisted.columnWidths ?? {},
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHydrated]);

  useEffect(() => {
    if (!isHydrated || !didHydrate.current) return;
    updatePersisted({ filters, sorts, visibleCols, columnWidths });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, sorts, visibleCols, columnWidths, isHydrated]);

  // ---- column defs -------------------------------------------------------
  const colDefs = useMemo(
    () => visibleCols.map((id) => resolveById(id, bundle, index)),
    [visibleCols, bundle, index],
  );

  // ---- visible rows ------------------------------------------------------
  const visibleRows = useMemo(
    () => applySorts(applyFilters(rows, filters), sorts),
    [rows, filters, sorts],
  );
  const renderedRows = useMemo(
    () => (visibleRows.length > ROW_CAP ? visibleRows.slice(0, ROW_CAP) : visibleRows),
    [visibleRows],
  );

  // Rows in scope (subtree chips applied, but not facets/ranges/status) — base
  // for facet/histogram live counts so they reflect sibling-filter context.
  const scopedRows = useMemo(() => {
    if (filters.subtreeDirs.length === 0) return rows;
    return rows.filter((r) =>
      filters.subtreeDirs.some((d) => r.identity.chain_dirs.includes(d)),
    );
  }, [rows, filters.subtreeDirs]);

  const sortDirOf = useCallback(
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

  // hover debounce so dragging across rows doesn't thrash linked views
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRowHover = useCallback(
    (dir: string | null) => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => hover(dir), 150);
    },
    [hover],
  );
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  // Clicking anywhere on a row opens its drawer (openDetail also selects);
  // the tree reveals the chain so the dir viewer tracks the selection.
  const onRowClick = useCallback(
    (row: RunRow) => {
      expandChain(row.identity.chain_dirs);
      openDetail(row.identity.node_path);
    },
    [expandChain, openDetail],
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

  const widthOf = useCallback(
    (def: ColumnDef): number =>
      columnWidths[def.id] ??
      (def.kind === "truthStrip" ? TRUTH_COL_WIDTH : DEFAULT_COL_WIDTH),
    [columnWidths],
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
        bundle={bundle}
        index={index}
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
        removeSubtreeDir={removeSubtreeDir}
        setVisibleCols={setVisibleCols}
        resetView={resetView}
      />

      {view === "chart" ? (
        <ChartBody rows={visibleRows} bundle={bundle} index={index} />
      ) : (
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse text-xs font-mono" style={{ tableLayout: "fixed" }}>
          <colgroup>
            {colDefs.map((c) => (
              <col key={c.id} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur-md">
            <tr className="border-b border-border">
              {colDefs.map((c) => (
                <HeaderCell
                  key={c.id}
                  def={c}
                  dir={sortDirOf(c.id)}
                  width={widthOf(c)}
                  onClick={onHeaderClick}
                  onResize={setColumnWidth}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {renderedRows.map((row, i) => {
              const key = `${row.identity.node_path}#${i}`;
              const isSel = row.identity.node_path === selectedDir;
              const isHover = row.identity.node_path === hoveredDir;
              return (
                <tr
                  key={key}
                  onMouseEnter={() => onRowHover(row.identity.node_path)}
                  onMouseLeave={() => onRowHover(null)}
                  onClick={() => onRowClick(row)}
                  onDoubleClick={() => openDetail(row.identity.node_path)}
                  className={[
                    "border-b border-border/50 cursor-pointer",
                    isSel
                      ? "bg-surface-alt text-text"
                      : isHover
                        ? "bg-surface/60"
                        : "text-text-muted hover:bg-surface/40",
                  ].join(" ")}
                >
                  {colDefs.map((c) => (
                    <td
                      key={c.id}
                      className="px-2 py-1 align-middle overflow-hidden whitespace-nowrap"
                      style={{ maxWidth: widthOf(c) }}
                    >
                      <Cell row={row} def={c} index={index} onOpenDetail={openDetail} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(1, colDefs.length)}
                  className="px-3 py-8 text-center text-text-faint"
                >
                  No runs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

// ===========================================================================
// Header cell (sortable + right-edge resize handle)
// ===========================================================================

function HeaderCell({
  def, dir, width, onClick, onResize,
}: {
  def: ColumnDef;
  dir: "asc" | "desc" | null;
  width: number;
  onClick: (col: string, e: React.MouseEvent) => void;
  onResize: (col: string, width: number) => void;
}) {
  const { size, handleProps } = useResizable({
    size: width,
    min: MIN_COL_WIDTH,
    max: MAX_COL_WIDTH,
    edge: "right",
    onCommit: (w) => onResize(def.id, Math.round(w)),
  });
  // Live-apply during drag too (cheap; the colgroup width is store-backed and
  // only persists on commit). We push every move so the column tracks the
  // pointer; the committed value is what persists.
  useEffect(() => {
    if (size !== width) onResize(def.id, Math.round(size));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  return (
    <th
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      title={`${def.label} — click to sort, shift-click to add a secondary key`}
      className="relative px-2 py-1.5 text-left font-medium text-text-muted select-none overflow-hidden"
    >
      <button
        type="button"
        onClick={(e) => onClick(def.id, e)}
        className="inline-flex max-w-full items-center gap-1 cursor-pointer hover:text-accent focus:outline-none focus-visible:text-accent"
      >
        <span className="truncate">{def.label}</span>
        {dir && <span className="text-accent shrink-0">{dir === "asc" ? "▲" : "▼"}</span>}
      </button>
      {/* resize handle */}
      <span
        {...handleProps}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-accent/40"
        style={{ ...handleProps.style, touchAction: "none" }}
      />
    </th>
  );
}

// ===========================================================================
// Cell rendering
// ===========================================================================

function Cell({
  row, def, index, onOpenDetail,
}: {
  row: RunRow;
  def: ColumnDef;
  index: MetricIndex;
  onOpenDetail: (dir: string) => void;
}) {
  if (def.kind === "truthStrip") {
    return (
      <span className="block overflow-x-auto">
        <TruthStrip arity={row.function.arity} activation={row.function.activation} box={11} />
      </span>
    );
  }

  if (def.kind === "fnHex") {
    return <FnHex fn={row.function} />;
  }

  if (def.kind === "dnf") {
    const s = row.function.dnf_string;
    const label = s === "0" ? "⊥ (false)" : s === "1" ? "⊤ (true)" : s;
    return <span className="block truncate text-text/90" title={s}>{label}</span>;
  }

  if (def.kind === "categorical") {
    const v = cellValue(row, def.id);
    const s = v === null || v === "" ? "—" : String(v);
    return <span className="block truncate text-text/90" title={s}>{s}</span>;
  }

  if (def.kind === "text") {
    const v = cellValue(row, def.id);
    if (v === null) return <span className="text-text-faint">—</span>;
    const s = typeof v === "number"
      ? def.metricName
        ? formatValue(index, def.metricName, v)
        : Number.isInteger(v) ? String(v) : v.toFixed(3)
      : String(v);
    return <span className="block truncate tabular-nums text-text/90" title={s}>{s}</span>;
  }

  if (def.kind === "outcome") {
    return <OutcomeCell row={row} def={def} index={index} onOpenDetail={onOpenDetail} />;
  }

  // numeric -> mini-bar normalized to schema range
  const v = numericValue(row, def.id);
  if (v === null) return <span className="text-text-faint">—</span>;
  return <MiniBar metricName={def.metricName ?? def.id} value={v} index={index} negativeRed />;
}

// OUTCOME cell: number + reveal an epoch sparkline on hover. The popup is
// position:fixed (anchored to the cell's rect) so the table cell's
// overflow-hidden can't clip it.
function OutcomeCell({
  row, def, index, onOpenDetail,
}: {
  row: RunRow;
  def: ColumnDef;
  index: MetricIndex;
  onOpenDetail: (dir: string) => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const v = numericValue(row, def.id);
  const display = v === null
    ? "—"
    : formatValue(index, def.metricName ?? def.id, v);

  return (
    <span
      className="inline-flex items-center"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAnchor({ x: r.left, y: r.bottom });
      }}
      onMouseLeave={() => setAnchor(null)}
    >
      <span className={v === null ? "text-text-faint tabular-nums" : "tabular-nums text-text/90"}>
        {display}
      </span>
      {anchor && def.trajectoryKey && (
        <span
          className="fixed z-50 rounded-md border border-border bg-surface/95 p-1 shadow-lg backdrop-blur-md"
          style={{ left: Math.max(4, Math.min(anchor.x, window.innerWidth - 140)), top: anchor.y + 4 }}
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetail(row.identity.node_path);
          }}
        >
          <EpochSparkline trajectories={row.trajectories} metric={def.trajectoryKey} />
        </span>
      )}
    </span>
  );
}

function MiniBar({
  metricName, value, index, negativeRed,
}: {
  metricName: string;
  value: number;
  index: MetricIndex;
  negativeRed?: boolean;
}) {
  const t = normalizeToRange(metricName, value, index);
  const pct = Math.round(t * 100);
  const isNeg = negativeRed === true && value < 0;
  return (
    <span className="inline-flex w-full items-center gap-1.5">
      <span className="relative h-1.5 flex-1 min-w-[1.5rem] overflow-hidden rounded-sm bg-surface-alt">
        <span
          className={isNeg ? "absolute inset-y-0 left-0 bg-error/70" : "absolute inset-y-0 left-0 bg-accent/70"}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={[
          "tabular-nums w-10 shrink-0 text-right",
          isNeg ? "text-error" : "text-text/90",
        ].join(" ")}
      >
        {formatValue(index, metricName, value)}
      </span>
    </span>
  );
}

// ===========================================================================
// FilterBar
// ===========================================================================

interface FilterBarProps {
  rows: RunRow[];
  scopedRows: RunRow[];
  visibleCount: number;
  renderedCount: number;
  totalCount: number;
  filters: FilterState;
  sorts: SortKey[];
  bundle: Bundle;
  index: MetricIndex;
  visibleCols: string[];
  onChipDragStart: (i: number) => void;
  onChipDrop: (i: number) => void;
  toggleSortDir: (col: string) => void;
  removeSort: (col: string) => void;
  setFacet: (key: FacetKey, values: string[]) => void;
  addRange: (r: RangeFilter) => void;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
  toggleStatus: (s: StatusFlag) => void;
  removeSubtreeDir: (dir: string) => void;
  setVisibleCols: (cols: string[]) => void;
  resetView: () => void;
}

function FilterBar(props: FilterBarProps) {
  const {
    rows, scopedRows, visibleCount, renderedCount, totalCount, filters, sorts,
    bundle, index, visibleCols,
    onChipDragStart, onChipDrop, toggleSortDir, removeSort,
    setFacet, addRange, updateRange, removeRange, toggleStatus, removeSubtreeDir,
    setVisibleCols, resetView,
  } = props;

  const facetOpts = useMemo(
    () => Object.fromEntries(FACET_KEYS.map((k) => [k, facetOptions(scopedRows, k)])) as Record<FacetKey, Array<{ value: string; count: number }>>,
    [scopedRows],
  );

  const colLabel = useCallback(
    (id: string) => resolveById(id, bundle, index).label,
    [bundle, index],
  );

  // Pills for flags no run matches yet (e.g. scan/twin before those sweeps run)
  // stay FINDABLE but not visible by default: they collapse behind a hover-open
  // "+N unused" reveal. They come back automatically once data exists.
  const flagCounts = useMemo(() => statusCounts(rows), [rows]);
  const [showEmptyPills, setShowEmptyPills] = useState(false);
  const pillFor = (opt: { flag: StatusFlag; label: string }) => {
    const active = filters.status.includes(opt.flag);
    return (
      <button
        key={opt.flag}
        onClick={() => toggleStatus(opt.flag)}
        title={`${flagCounts[opt.flag].toLocaleString()} runs`}
        className={[
          "rounded-full px-2.5 py-0.5 text-xs border transition-colors",
          active
            ? "border-accent text-accent bg-accent/10"
            : flagCounts[opt.flag] === 0
              ? "border-border/60 text-text-faint hover:text-text-muted"
              : "border-border text-text-muted hover:text-text hover:border-accent/40",
        ].join(" ")}
      >
        {opt.label}
      </button>
    );
  };
  const populatedPills = STATUS_OPTIONS.filter(
    (o) => flagCounts[o.flag] > 0 || filters.status.includes(o.flag),
  );
  const emptyPills = STATUS_OPTIONS.filter(
    (o) => flagCounts[o.flag] === 0 && !filters.status.includes(o.flag),
  );

  return (
    <div className="sticky top-0 z-20 shrink-0 border-b border-border bg-surface/85 backdrop-blur-md">
      {/* Row 1: status pills + count + reset */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {populatedPills.map(pillFor)}
        {emptyPills.length > 0 && (
          <span
            className="inline-flex items-center gap-1.5"
            onMouseEnter={() => setShowEmptyPills(true)}
            onMouseLeave={() => setShowEmptyPills(false)}
          >
            {showEmptyPills ? (
              emptyPills.map(pillFor)
            ) : (
              <span
                className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-xs text-text-faint cursor-default"
                title={`no runs yet: ${emptyPills.map((o) => o.label).join(", ")}`}
              >
                +{emptyPills.length} unused
              </span>
            )}
          </span>
        )}

        <span className="ml-auto text-xs font-mono text-text-muted">
          {countSummary(visibleCount, totalCount)}
          {renderedCount < visibleCount && (
            <span className="text-text-faint">
              {" "}· showing {renderedCount.toLocaleString()} of {visibleCount.toLocaleString()}
            </span>
          )}
        </span>

        <button
          onClick={resetView}
          className="rounded-md border border-border bg-surface-alt px-2.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Subtree chips (tree-driven; reversible, independent of expansion) */}
      {filters.subtreeDirs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <span className="text-xs text-text-faint font-mono">scope:</span>
          {filters.subtreeDirs.map((dir) => (
            <button
              key={dir}
              onClick={() => removeSubtreeDir(dir)}
              title={dir}
              className="flex items-center gap-1 rounded-full border border-accent/60 bg-accent/10 px-2.5 py-0.5 text-xs text-accent hover:bg-accent/20"
            >
              <span className="font-mono max-w-[16rem] truncate">{dir}</span>
              <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      )}

      {/* Row 2: facets + add-metric + per-group column menus */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
        {FACET_KEYS.map((key) => (
          <FacetPopover
            key={key}
            facetKey={key}
            selected={filters.facets[key] ?? []}
            options={facetOpts[key]}
            setFacet={setFacet}
          />
        ))}

        <AddMetricMenu
          existing={filters.ranges.map((r) => r.metric)}
          rows={rows}
          schema={bundle.metric_schema}
          index={index}
          addRange={addRange}
        />

        <div className="ml-auto">
          <ColumnGroupMenu
            bundle={bundle}
            index={index}
            visibleCols={visibleCols}
            setVisibleCols={setVisibleCols}
          />
        </div>
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
              <span className="text-text/90 font-mono">{colLabel(s.col)}</span>
              <button onClick={() => toggleSortDir(s.col)} className="text-accent hover:text-text" aria-label="flip direction">
                {s.dir === "asc" ? "▲" : "▼"}
              </button>
              <button onClick={() => removeSort(s.col)} className="text-text-muted hover:text-error" aria-label="remove sort">
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
              index={index}
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
// Facet popover (hover-to-open; popover does NOT repeat its own name)
// ---------------------------------------------------------------------------

function FacetPopover({
  facetKey, selected, options, setFacet,
}: {
  facetKey: FacetKey;
  selected: string[];
  options: Array<{ value: string; count: number }>;
  setFacet: (key: FacetKey, values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const leave = () => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 120); };

  const active = selected.length > 0;
  const toggleValue = (value: string) => {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    setFacet(facetKey, next);
  };

  return (
    <div className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={[
          "rounded-md border px-2 py-0.5 text-xs transition-colors",
          active ? "border-accent text-accent bg-accent/10" : "border-border text-text-muted hover:text-text hover:border-accent/40",
        ].join(" ")}
      >
        {FACET_LABELS[facetKey]}
        {active && <span className="ml-1 text-accent">({selected.length})</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-56 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface/95 backdrop-blur-md p-2 text-sm animate-settle">
          {active && (
            <div className="flex items-center justify-end mb-1">
              <button onClick={() => setFacet(facetKey, [])} className="text-xs text-text-muted hover:text-accent">clear</button>
            </div>
          )}
          {options.length === 0 && <div className="text-xs text-text-faint py-1">No values</div>}
          {options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 py-0.5 cursor-pointer text-text/90 hover:text-accent">
              <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => toggleValue(opt.value)} className="accent-accent" />
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
// Add-metric searchable menu (over metric_schema numeric metrics)
// ---------------------------------------------------------------------------

function AddMetricMenu({
  existing, rows, schema, index, addRange,
}: {
  existing: string[];
  rows: RunRow[];
  schema: MetricSchemaEntry[];
  index: MetricIndex;
  addRange: (r: RangeFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const existingSet = useMemo(() => new Set(existing), [existing]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return schema
      .filter((e) => !existingSet.has(e.name))
      .filter((e) => q === "" || e.label.toLowerCase().includes(q) || e.name.toLowerCase().includes(q))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }, [query, existingSet, schema]);

  const onPick = (e: MetricSchemaEntry) => {
    const { min, max } = metricRange(rows, e.name, index);
    addRange({ metric: e.name, min, max });
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
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
            {results.length === 0 && <div className="text-xs text-text-faint py-1 px-1">No metrics</div>}
            {results.map((e) => {
              const empty = e.min === null && e.max === null;
              return (
                <button
                  key={e.name}
                  onClick={() => onPick(e)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-alt hover:text-accent ${empty ? "text-text-faint" : "text-text/90"}`}
                >
                  <span className="truncate">{e.label}</span>
                  <span className="text-text-faint text-xs">
                    {empty ? "no data yet" : <span className="uppercase">{e.suite}</span>}
                  </span>
                </button>
              );
            })}
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
  range, rows, index, updateRange, removeRange,
}: {
  range: RangeFilter;
  rows: RunRow[];
  index: MetricIndex;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
}) {
  const entry = index[range.metric];
  const bounds = useMemo(() => metricRange(rows, range.metric, index), [rows, range.metric, index]);
  const lo = bounds.min;
  const hi = bounds.max;
  const span = hi - lo || 1;
  const isInt = (entry?.format ?? "") === "d";
  const step = isInt ? 1 : span / 100;

  const bins = useMemo(() => histogramBins(rows, range.metric, HIST_BINS, index), [rows, range.metric, index]);
  const maxBin = Math.max(1, ...bins);

  const fmt = (v: number) => (entry ? formatValue(index, range.metric, v) : v.toFixed(2));

  const [draft, setDraft] = useState({ min: range.min, max: range.max });
  useEffect(() => { setDraft({ min: range.min, max: range.max }); }, [range.min, range.max]);

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
        <span className="text-xs text-text/90 font-mono truncate">{entry?.label ?? range.metric}</span>
        <button onClick={() => removeRange(range.metric)} className="text-text-muted hover:text-error text-xs" aria-label="remove range">×</button>
      </div>

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
        <span
          className="pointer-events-none absolute inset-y-0 border-x border-accent/50 bg-accent/5"
          style={{ left: `${lowPct}%`, right: `${100 - highPct}%` }}
        />
      </div>

      <div className="relative h-4">
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={draft.min}
          aria-label={`${entry?.label ?? range.metric} minimum`}
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
          aria-label={`${entry?.label ?? range.metric} maximum`}
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
