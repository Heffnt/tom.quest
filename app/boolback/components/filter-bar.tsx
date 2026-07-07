"use client";

// app/boolback/components/filter-bar.tsx — THE top bar: the only horizontal
// chrome above the center view (the old command bar and the chart's axis
// strip folded into it). One wrap-row:
//
//   [» artifacts] [Table|Chart|Anatomy] [+ Filter] (active filter chips…) | [trend] r/ρ
//   ⌕ · N of M runs · Export · Columns(table) · Reset · ⧉ · ● ↻
//
// - `» artifacts` shows only while the tree pane is collapsed — the bar IS the
//   re-open affordance (no full-height rail stealing horizontal space).
// - `+ Filter` is a single CLICK-open searchable menu replacing the old status
//   pills / ten facet buttons / "+ add metric": type to match facet VALUES
//   ("llama" → Model: Llama-3.2-1B), facet names, metric names, and status
//   flags. Facets with fewer than two observed values stay hidden (noise).
//   Metrics list outcome-first (the same order as the chart's Y select).
// - Every active filter renders as a uniform chip: status, `model: Llama +2`,
//   `avg sensitivity 0.5–1.2`, `scope: fn=…`. Clicking a chip's body opens its
//   editor (checkbox list / histogram slider) as a popover; × clears it.
// - The chart's X/Y metric pickers and log toggles live ON the plot's axes
//   (chart-panel.tsx); only the trend toggle and the r/ρ readout (published
//   to store.chartReadout by the mounted ChartBody) render here, on CHART
//   view only.
// - The status dot's tooltip carries snapshot freshness. Search is a ⌕ icon
//   until it holds a query.
// - The sort-chip row appears only with ≥2 keys — a single sort is already
//   shown by the header arrow.
//
// FilterState and applyFilters are untouched; this is presentation only.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Bundle, FacetKey, FilterState, RangeFilter, StatusFlag,
} from "../lib/types";
import type { RunRow } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import type { ArtifactSource } from "../data/source";
import {
  FACET_KEYS, FACET_LABELS, countSummary, facetOptions, histogramBins,
  metricRange, statusCounts, type MetricIndex,
} from "../lib/select";
import { Y_GROUP_ORDER, collapseMethodEntries, formatValue, groupedMetricOptions } from "../lib/metrics";
import { parseMethodMetric } from "../lib/method-metrics";
import { buildShareUrl } from "../lib/share";
import { copyText } from "../lib/export";

/** The method half of a "<base>@<method>" name (null for plain metrics). */
function methodPart(name: string): string | null {
  return parseMethodMetric(name)?.method ?? null;
}
import { resolveById, type ColumnDef } from "../lib/columns";
import { ColumnGroupMenu } from "./column-group-menu";
import { ExportMenu } from "./export-menu";
import type { ChartExportHandle } from "./chart-panel";
import type { CenterView } from "./table-pane";
import { relTime, shortModel } from "../lib/format";

const HIST_BINS = 24;

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

const statusLabel = (flag: StatusFlag): string =>
  STATUS_OPTIONS.find((o) => o.flag === flag)?.label ?? flag;

export interface FilterBarProps {
  rows: RunRow[]; // all runs
  scopedRows: RunRow[]; // subtree chips applied (facet/histogram context)
  visibleRows: RunRow[]; // fully filtered + sorted (export)
  visibleCount: number;
  totalCount: number;
  bundle: Bundle;
  index: MetricIndex;
  colDefs: ColumnDef[]; // visible table columns (export)
  view: CenterView;
  chartRef: React.MutableRefObject<ChartExportHandle | null>;
  source: ArtifactSource; // status dot / freshness / Refresh
  /** Set while the tree pane is collapsed — renders the `» artifacts` re-open button. */
  onShowTree?: () => void;
}

export function FilterBar(props: FilterBarProps) {
  const {
    rows, scopedRows, visibleRows, visibleCount, totalCount,
    bundle, index, colDefs, view, chartRef, source, onShowTree,
  } = props;

  const filters = useBoolbackStore((s) => s.filters);
  const sorts = useBoolbackStore((s) => s.sorts);
  const visibleCols = useBoolbackStore((s) => s.visibleCols);
  const setFacet = useBoolbackStore((s) => s.setFacet);
  const toggleStatus = useBoolbackStore((s) => s.toggleStatus);
  const updateRange = useBoolbackStore((s) => s.updateRange);
  const removeRange = useBoolbackStore((s) => s.removeRange);
  const removeSubtreeDir = useBoolbackStore((s) => s.removeSubtreeDir);
  const setSearch = useBoolbackStore((s) => s.setSearch);
  const setVisibleCols = useBoolbackStore((s) => s.setVisibleCols);
  const resetView = useBoolbackStore((s) => s.resetView);
  const toggleSortDir = useBoolbackStore((s) => s.toggleSortDir);
  const removeSort = useBoolbackStore((s) => s.removeSort);
  const reorderSorts = useBoolbackStore((s) => s.reorderSorts);
  const setCenterView = useBoolbackStore((s) => s.setCenterView);
  const chart = useBoolbackStore((s) => s.chart);
  const setChart = useBoolbackStore((s) => s.setChart);
  const readout = useBoolbackStore((s) => s.chartReadout);

  // Shareable view URL (filters + sorts + columns + chart + anatomy + view).
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    const s = useBoolbackStore.getState();
    await copyText(buildShareUrl({
      filters: s.filters,
      sorts: s.sorts,
      visibleCols: s.visibleCols,
      chart: s.chart,
      anatomy: s.anatomy,
      view: s.centerView,
    }));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const facetSelections = useMemo(
    () =>
      (Object.entries(filters.facets ?? {}) as Array<[FacetKey, string[]]>).filter(
        ([, vals]) => Array.isArray(vals) && vals.length > 0,
      ),
    [filters.facets],
  );

  const activeStatus = filters.status ?? [];

  const hasAnyFilter =
    facetSelections.length > 0 ||
    (filters.ranges ?? []).length > 0 ||
    (filters.status ?? []).length > 0 ||
    (filters.subtreeDirs ?? []).length > 0 ||
    (filters.search ?? "").trim() !== "";

  // ---- sort-chip drag reordering ------------------------------------------
  const dragIdx = useRef<number | null>(null);
  const onChipDrop = (target: number) => {
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from === null || from === target) return;
    const next = [...sorts];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    reorderSorts(next);
  };

  return (
    // z-30: this wrapper is a stacking context (sticky+z), so every popover
    // inside is CAPPED at the wrapper's own z no matter its local z-index.
    // The table's frozen header cells are sticky z-20 in the sibling scroll
    // container — the bar must sit ABOVE the table's whole z range (<= 20)
    // or its dropdowns paint underneath the arity/Fn headers.
    <div className="sticky top-0 z-30 shrink-0 border-b border-border bg-surface/85 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        {/* re-open the collapsed tree pane — header-height, no side rail */}
        {onShowTree && (
          <button
            type="button"
            onClick={onShowTree}
            title="Show the artifact tree"
            aria-label="Show the artifact tree"
            className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
          >
            » artifacts
          </button>
        )}

        {/* Table | Plot | Group Plot | Anatomy view switcher (store-owned) */}
        <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
          {(["table", "plot", "groupplot", "anatomy"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setCenterView(v)}
              className={`px-2.5 py-0.5 transition-colors ${
                view === v ? "bg-accent/15 text-accent" : "bg-surface text-text-muted hover:text-text"
              }`}
            >
              {{ table: "Table", plot: "Plot", groupplot: "Group Plot", anatomy: "Anatomy" }[v]}
            </button>
          ))}
        </div>

        <AddFilterMenu
          rows={rows}
          scopedRows={scopedRows}
          filters={filters}
          bundle={bundle}
          index={index}
        />

        {activeStatus.map((flag) => (
          <Chip
            key={flag}
            label={statusLabel(flag)}
            active
            onBody={() => toggleStatus(flag)}
            onRemove={() => toggleStatus(flag)}
          />
        ))}

        {facetSelections.map(([key, vals]) => (
          <FacetChip
            key={key}
            facetKey={key}
            selected={vals}
            options={facetOptions(scopedRows, key)}
            setFacet={setFacet}
          />
        ))}

        {(filters.ranges ?? []).map((r) => (
          <RangeChip
            key={r.metric}
            range={r}
            rows={scopedRows}
            index={index}
            updateRange={updateRange}
            removeRange={removeRange}
          />
        ))}

        {(filters.subtreeDirs ?? []).map((dir) => (
          <Chip
            key={dir}
            label={`scope: ${dir.split("/").pop() ?? dir}`}
            active
            title={dir}
            onRemove={() => removeSubtreeDir(dir)}
          />
        ))}

        {/* trend + readout — Plot view only; the X/Y pickers, log toggles and
            axis min/max live on the plot's axes (chart-panel.tsx) */}
        {view === "plot" && (
          <>
            <span className="mx-1 h-4 w-px shrink-0 bg-border/60" aria-hidden />
            <AxisToggle label="trend" checked={!!chart.trend} onChange={(b) => setChart({ trend: b })} />
            {readout && (readout.r !== null || readout.binned || readout.droppedLog > 0 || readout.outsideWindow > 0) && (
              <span
                className="text-xs font-mono text-text-faint whitespace-nowrap"
                title={`Pearson r · Spearman ρ over the ${readout.runs.toLocaleString()} runs in the view window (descriptive — what you see is what the stats describe) · ${readout.points.toLocaleString()} ${readout.averaging ? "groups" : "points"} drawn`}
              >
                {readout.r !== null && (
                  <span className="text-text-muted">
                    r {readout.r.toFixed(2)} · ρ {readout.rho === null ? "—" : readout.rho.toFixed(2)}
                  </span>
                )}
                {readout.binned && <span title="X has too many distinct values — grouped into 12 equal-width bins"> · x binned</span>}
                {readout.outsideWindow > 0 && <span title="points outside the axis view window (zoom only) — still present in the table and filters"> · {readout.outsideWindow} outside window</span>}
                {readout.droppedLog > 0 && <span title="values ≤ 0 cannot be shown on a log axis"> · {readout.droppedLog} dropped (log)</span>}
              </span>
            )}
          </>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <QuickSearch value={filters.search ?? ""} onCommit={setSearch} />
          <span className="text-xs font-mono text-text-muted whitespace-nowrap">
            {countSummary(visibleCount, totalCount)} runs
          </span>
          <ExportMenu
            bundle={bundle}
            index={index}
            visibleRows={visibleRows}
            colDefs={colDefs}
            view={view}
            chartRef={chartRef}
            filters={filters}
          />
          {view === "table" && (
            <ColumnsMenuButton
              bundle={bundle}
              index={index}
              visibleCols={visibleCols}
              setVisibleCols={setVisibleCols}
            />
          )}
          {hasAnyFilter && (
            <button
              onClick={resetView}
              className="rounded-md border border-border bg-surface-alt px-2.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => void copyLink()}
            title="Copy a link that reproduces exactly this view (filters, sort, columns, chart)"
            className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 transition-colors"
          >
            {copied ? "✓" : "⧉"}
          </button>
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              source.status === "ready"
                ? "bg-success"
                : source.status === "loading"
                  ? "bg-warning animate-pulse"
                  : "bg-error"
            }`}
            title={`snapshot: ${source.status} · built ${relTime(bundle.meta.built_at)} from ${bundle.meta.source_dir}`}
          />
          <button
            type="button"
            onClick={source.refresh}
            title={
              source.canRebuild
                ? "Re-fetch the latest snapshot AND submit a rebuild on Turing (~2 min)"
                : "Re-fetch the latest snapshot"
            }
            className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 transition-colors"
          >
            ↻
          </button>
          {source.rebuildNote && (
            <span className="shrink-0 text-[11px] text-text-faint whitespace-nowrap">
              {source.rebuildNote}
            </span>
          )}
        </span>
      </div>

      {/* sort chips — only when the multi-key state genuinely needs display */}
      {sorts.length >= 2 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <span className="text-xs text-text-faint font-mono">sort:</span>
          {sorts.map((s, i) => (
            <div
              key={s.col}
              draggable
              onDragStart={() => { dragIdx.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onChipDrop(i)}
              className="flex items-center gap-1 rounded-full border border-border bg-surface-alt px-2 py-0.5 text-xs cursor-grab active:cursor-grabbing"
              title="Drag to reorder · click arrow to flip · × to remove"
            >
              <span className="text-text-faint tabular-nums">{i + 1}</span>
              <span className="text-text/90 font-mono">{resolveById(s.col, bundle, index).label}</span>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic chip + popover scaffolding
// ---------------------------------------------------------------------------

function Chip({
  label, active, title, onBody, onRemove, popover, open, setOpen,
}: {
  label: string;
  active?: boolean;
  title?: string;
  onBody?: () => void;
  onRemove?: () => void;
  /** Editor panel rendered below the chip while open (click-open). */
  popover?: React.ReactNode;
  open?: boolean;
  setOpen?: (b: boolean) => void;
}) {
  return (
    <span className="relative inline-flex">
      <span
        className={[
          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
          active
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-border text-text-muted hover:text-text hover:border-accent/40",
        ].join(" ")}
        title={title}
      >
        <button
          type="button"
          onClick={onBody ?? (setOpen ? () => setOpen(!open) : undefined)}
          className="max-w-[16rem] truncate font-mono"
        >
          {label}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`remove ${label}`}
            className="text-text-muted hover:text-error"
          >
            ×
          </button>
        )}
      </span>
      {open && popover && (
        <>
          <span className="fixed inset-0 z-20" onClick={() => setOpen?.(false)} />
          <span className="absolute left-0 top-full z-30 mt-1 block animate-settle">{popover}</span>
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Facet chip (click body -> checkbox editor)
// ---------------------------------------------------------------------------

function FacetChip({
  facetKey, selected, options, setFacet,
}: {
  facetKey: FacetKey;
  selected: string[];
  options: Array<{ value: string; count: number }>;
  setFacet: (key: FacetKey, values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const display = (v: string) => (facetKey === "baseModel" ? shortModel(v) : v);
  const label =
    `${FACET_LABELS[facetKey]}: ${display(selected[0])}` +
    (selected.length > 1 ? ` +${selected.length - 1}` : "");

  const toggleValue = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    setFacet(facetKey, next);
  };

  return (
    <Chip
      label={label}
      active
      open={open}
      setOpen={setOpen}
      onRemove={() => setFacet(facetKey, [])}
      popover={
        <span className="block w-56 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface/95 p-2 text-sm shadow-lg backdrop-blur-md">
          <span className="mb-1 flex items-center justify-end">
            <button onClick={() => setFacet(facetKey, [])} className="text-xs text-text-muted hover:text-accent">
              clear
            </button>
          </span>
          {options.length === 0 && <span className="block py-1 text-xs text-text-faint">No values</span>}
          {options.map((opt) => (
            <label key={opt.value} className="flex cursor-pointer items-center gap-2 py-0.5 text-text/90 hover:text-accent">
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggleValue(opt.value)}
                className="accent-accent"
              />
              <span className="flex-1 truncate">{display(opt.value) || "—"}</span>
              <span className="text-text-faint tabular-nums">{opt.count}</span>
            </label>
          ))}
        </span>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Range chip (click body -> histogram + dual-slider editor)
// ---------------------------------------------------------------------------

function RangeChip({
  range, rows, index, updateRange, removeRange,
}: {
  range: RangeFilter;
  rows: RunRow[];
  index: MetricIndex;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
  removeRange: (metric: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const entry = index[range.metric];
  const fmt = (v: number) => formatValue(index, range.metric, v);
  const label = `${entry?.label ?? range.metric} ${fmt(range.min)}–${fmt(range.max)}`;

  return (
    <Chip
      label={label}
      active
      open={open}
      setOpen={setOpen}
      onRemove={() => removeRange(range.metric)}
      popover={
        <RangeEditor
          range={range}
          rows={rows}
          index={index}
          updateRange={updateRange}
        />
      }
    />
  );
}

/** The old inline range card, relocated into a popover (histogram + sliders). */
function RangeEditor({
  range, rows, index, updateRange,
}: {
  range: RangeFilter;
  rows: RunRow[];
  index: MetricIndex;
  updateRange: (metric: string, patch: Partial<RangeFilter>) => void;
}) {
  const entry = index[range.metric];
  const bounds = useMemo(() => metricRange(rows, range.metric, index), [rows, range.metric, index]);
  const lo = Math.min(bounds.min, range.min);
  const hi = Math.max(bounds.max, range.max);
  const span = hi - lo || 1;
  const isInt = (entry?.format ?? "") === "d";
  const step = isInt ? 1 : span / 100;

  const bins = useMemo(() => histogramBins(rows, range.metric, HIST_BINS, index), [rows, range.metric, index]);
  const maxBin = Math.max(1, ...bins);
  const fmt = (v: number) => (entry ? formatValue(index, range.metric, v) : v.toFixed(2));

  const [draft, setDraft] = useState({ min: range.min, max: range.max });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = (patch: Partial<RangeFilter>) => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => updateRange(range.metric, patch), 120);
  };

  const lowPct = ((draft.min - lo) / span) * 100;
  const highPct = ((draft.max - lo) / span) * 100;

  return (
    <span className="block w-64 rounded-lg border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md">
      <span className="mb-1 block text-xs font-mono text-text/90 truncate">{entry?.label ?? range.metric}</span>
      <span className="relative mb-1 flex h-8 items-end gap-px">
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
      </span>

      <span className="relative block h-4">
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
      </span>

      <span className="mt-1 flex items-center justify-between text-xs font-mono text-text-muted">
        <span>{fmt(draft.min)}</span>
        <span>{fmt(draft.max)}</span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Quick search (debounced commit into FilterState.search)
// ---------------------------------------------------------------------------

function QuickSearch({
  value, onCommit,
}: {
  value: string;
  onCommit: (q: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Collapsed to a ⌕ icon until it holds a query (or is explicitly opened).
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = useRef(value);

  // Sync down external resets (Reset button, shared-URL hydration).
  if (value !== lastCommitted.current) {
    lastCommitted.current = value;
    if (draft !== value) setDraft(value);
  }

  const commit = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastCommitted.current = q;
      onCommit(q);
    }, 150);
  };

  const expanded = open || draft.trim() !== "" || value.trim() !== "";
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="search runs"
        aria-label="search runs"
        className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 transition-colors"
      >
        ⌕
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="search"
      value={draft}
      placeholder="search runs…"
      aria-label="search runs"
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => {
        if (draft.trim() === "") setOpen(false);
      }}
      className="w-40 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text placeholder:text-text-faint caret-accent focus:border-accent/60 focus:outline-none"
    />
  );
}

// Tiny labeled checkbox (the chart's trend toggle).
function AxisToggle({
  label, checked, onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-text-muted hover:text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// + Filter — the one searchable add-filter menu
// ---------------------------------------------------------------------------

function AddFilterMenu({
  rows, scopedRows, filters, bundle, index,
}: {
  rows: RunRow[];
  scopedRows: RunRow[];
  filters: FilterState;
  bundle: Bundle;
  index: MetricIndex;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [expandedFacet, setExpandedFacet] = useState<FacetKey | null>(null);
  const [expandedMetricBase, setExpandedMetricBase] = useState<string | null>(null);

  const toggleStatus = useBoolbackStore((s) => s.toggleStatus);
  const toggleFacetValue = useBoolbackStore((s) => s.toggleFacetValue);
  const setFacet = useBoolbackStore((s) => s.setFacet);
  const addRange = useBoolbackStore((s) => s.addRange);

  const flagCounts = useMemo(() => statusCounts(rows), [rows]);
  const facetOpts = useMemo(
    () =>
      Object.fromEntries(FACET_KEYS.map((k) => [k, facetOptions(scopedRows, k)])) as Record<
        FacetKey,
        Array<{ value: string; count: number }>
      >,
    [scopedRows],
  );

  const query = q.trim().toLowerCase();
  const matches = (s: string) => query === "" || s.toLowerCase().includes(query);

  // Facets shown: ≥2 observed values (or an active selection keeps it visible).
  const facetKeys = FACET_KEYS.filter(
    (k) => facetOpts[k].length >= 2 || (filters.facets[k]?.length ?? 0) > 0,
  );

  // Direct facet-VALUE hits when searching ("llama" -> Model: Llama-3.2-1B).
  const valueHits = useMemo(() => {
    if (query === "") return [];
    const out: Array<{ key: FacetKey; value: string; count: number }> = [];
    for (const k of facetKeys) {
      for (const o of facetOpts[k]) {
        const disp = k === "baseModel" ? shortModel(o.value) : o.value;
        if (disp.toLowerCase().includes(query) || o.value.toLowerCase().includes(query)) {
          out.push({ key: k, value: o.value, count: o.count });
        }
      }
    }
    return out.slice(0, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, facetOpts]);

  const { groups: metricGroups, empty: emptyMetrics } = useMemo(
    () => groupedMetricOptions(bundle.metric_schema, Y_GROUP_ORDER),
    [bundle.metric_schema],
  );
  const existingRanges = new Set((filters.ranges ?? []).map((r) => r.metric));

  const pickMetric = (name: string) => {
    const { min, max } = metricRange(rows, name, index);
    addRange({ metric: name, min, max });
    close();
  };

  const close = () => {
    setOpen(false);
    setQ("");
    setExpandedFacet(null);
    setExpandedMetricBase(null);
  };

  const statusEntries = STATUS_OPTIONS.filter((o) => matches(o.label));
  const facetEntries = facetKeys.filter((k) => matches(FACET_LABELS[k]));
  const metricEntries = metricGroups
    .map(([group, entries]) => ({
      group,
      entries: entries.filter((e) => !existingRanges.has(e.name) && (matches(e.label) || matches(e.name))),
    }))
    .filter((g) => g.entries.length > 0);
  const emptyEntries = query === ""
    ? []
    : emptyMetrics.filter((e) => matches(e.label) || matches(e.name));

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="rounded-md border border-dashed border-border px-2.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
      >
        + Filter
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-surface/95 p-2 text-sm shadow-lg backdrop-blur-md animate-settle">
            <input
              type="text"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") close(); }}
              placeholder="filter by status, facet, value, metric…"
              className="mb-2 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text placeholder:text-text-faint caret-accent focus:border-accent/80 focus:outline-none"
            />
            <div className="max-h-80 overflow-y-auto">
              {/* direct facet-value hits (search only) */}
              {valueHits.length > 0 && (
                <Section label="values">
                  {valueHits.map(({ key, value, count }) => (
                    <button
                      key={`${key}:${value}`}
                      onClick={() => { toggleFacetValue(key, value); close(); }}
                      className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
                    >
                      <span className="truncate">
                        <span className="text-text-muted">{FACET_LABELS[key]}:</span>{" "}
                        {key === "baseModel" ? shortModel(value) : value}
                      </span>
                      <span className="text-xs text-text-faint tabular-nums">{count}</span>
                    </button>
                  ))}
                </Section>
              )}

              {statusEntries.length > 0 && (
                <Section label="status">
                  {statusEntries.map((o) => {
                    const active = (filters.status ?? []).includes(o.flag);
                    const empty = flagCounts[o.flag] === 0;
                    return (
                      <button
                        key={o.flag}
                        onClick={() => { toggleStatus(o.flag); close(); }}
                        className={`flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-alt hover:text-accent ${empty ? "text-text-faint" : "text-text/90"}`}
                      >
                        <span>
                          {o.label}
                          {active && <span className="ml-1 text-accent">✓</span>}
                        </span>
                        <span className="text-xs text-text-faint tabular-nums">
                          {empty ? "no runs yet" : flagCounts[o.flag].toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </Section>
              )}

              {facetEntries.length > 0 && (
                <Section label="facets">
                  {facetEntries.map((k) => {
                    const selected = filters.facets[k] ?? [];
                    const expanded = expandedFacet === k;
                    return (
                      <div key={k}>
                        <button
                          onClick={() => setExpandedFacet(expanded ? null : k)}
                          className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
                        >
                          <span>
                            {FACET_LABELS[k]}
                            {selected.length > 0 && <span className="ml-1 text-accent">({selected.length})</span>}
                          </span>
                          <span className="text-xs text-text-faint">{expanded ? "▾" : "▸"} {facetOpts[k].length}</span>
                        </button>
                        {expanded && (
                          <div className="mb-1 ml-2 border-l border-border/60 pl-2">
                            {selected.length > 0 && (
                              <button
                                onClick={() => setFacet(k, [])}
                                className="mb-0.5 text-xs text-text-muted hover:text-accent"
                              >
                                clear
                              </button>
                            )}
                            {facetOpts[k].map((o) => (
                              <label key={o.value} className="flex cursor-pointer items-center gap-2 py-0.5 text-text/90 hover:text-accent">
                                <input
                                  type="checkbox"
                                  checked={selected.includes(o.value)}
                                  onChange={() => toggleFacetValue(k, o.value)}
                                  className="accent-accent"
                                />
                                <span className="flex-1 truncate">
                                  {(k === "baseModel" ? shortModel(o.value) : o.value) || "—"}
                                </span>
                                <span className="text-xs text-text-faint tabular-nums">{o.count}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Section>
              )}

              {(metricEntries.length > 0 || emptyEntries.length > 0) && (
                <Section label="metric ranges">
                  {query !== ""
                    ? metricEntries.map(({ group, entries }) => (
                      <div key={group}>
                        {entries.map((e) => (
                          <button
                            key={e.name}
                            onClick={() => pickMetric(e.name)}
                            className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
                          >
                            <span className="truncate">{e.label}</span>
                            <span className="text-[10px] uppercase text-text-faint">{group}</span>
                          </button>
                        ))}
                      </div>
                    ))
                    : metricEntries.map(({ group, entries }) => (
                      <div key={group}>
                        {collapseMethodEntries(entries).map((base) => (
                          <div key={base.baseName}>
                            <div className="flex items-center">
                              {base.entry ? (
                                <button
                                  onClick={() => pickMetric(base.entry!.name)}
                                  className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
                                >
                                  <span className="truncate">{base.label}</span>
                                  {base.children.length === 0 && (
                                    <span className="text-[10px] uppercase text-text-faint">{group}</span>
                                  )}
                                </button>
                              ) : (
                                <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-text-muted">{base.label}</span>
                              )}
                              {base.children.length > 0 && (
                                <button
                                  onClick={() => setExpandedMetricBase(
                                    expandedMetricBase === base.baseName ? null : base.baseName,
                                  )}
                                  className="shrink-0 rounded px-1.5 py-1 text-xs text-text-faint hover:text-accent"
                                  title={`${base.children.length} per-method values`}
                                >
                                  {expandedMetricBase === base.baseName ? "▾" : "▸"} {base.children.length}
                                </button>
                              )}
                            </div>
                            {expandedMetricBase === base.baseName && (
                              <div className="mb-1 ml-2 border-l border-border/60 pl-2">
                                {base.children.map((c) => (
                                  <button
                                    key={c.name}
                                    onClick={() => pickMetric(c.name)}
                                    className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
                                  >
                                    <span className="truncate">{methodPart(c.name) ?? c.label}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  {emptyEntries.map((e) => (
                    <div
                      key={e.name}
                      className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-text-faint"
                    >
                      <span className="truncate">{e.label}</span>
                      <span className="text-[10px]">no data yet</span>
                    </div>
                  ))}
                </Section>
              )}

              {valueHits.length === 0 && statusEntries.length === 0 &&
                facetEntries.length === 0 && metricEntries.length === 0 &&
                emptyEntries.length === 0 && (
                <div className="px-1.5 py-2 text-xs text-text-faint">No matches</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="px-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-text-faint">{label}</div>
      {children}
    </div>
  );
}

// Columns: keep the per-group menus, collapsed behind one "Columns" trigger so
// the single-row bar stays quiet.
function ColumnsMenuButton({
  bundle, index, visibleCols, setVisibleCols,
}: {
  bundle: Bundle;
  index: MetricIndex;
  visibleCols: string[];
  setVisibleCols: (cols: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={[
          "rounded-md border px-2.5 py-0.5 text-xs transition-colors",
          open
            ? "border-accent text-accent bg-accent/10"
            : "border-border bg-surface-alt text-text-muted hover:text-accent hover:border-accent/40",
        ].join(" ")}
      >
        Columns
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-30 mt-1 rounded-lg border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md animate-settle">
            <ColumnGroupMenu
              bundle={bundle}
              index={index}
              visibleCols={visibleCols}
              setVisibleCols={setVisibleCols}
            />
          </div>
        </>
      )}
    </div>
  );
}
