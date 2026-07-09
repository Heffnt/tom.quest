"use client";

// app/boolback/components/table-pane.tsx
//
// The ONLY center view. One row per RunRow (one training run / NODE_KEY).
// Columns are resolved from bundle.column_groups via lib/columns.resolveColumn.
//
// Table mechanics (plan slices 3–5):
//   * WINDOWED rendering — every filtered row is reachable by scroll; only the
//     visible slice (+overscan) hits the DOM. No 500-row cliff.
//   * The leading identity columns (arity, Fn) freeze sticky-left so scrolling
//     through 60 complexity metrics never loses which function you're on.
//   * A summary footer shows the mean of each visible numeric column over the
//     FILTERED set (the same aggregation the .tex export uses).
//   * ↑/↓ move the selection, Enter opens the drawer, Esc closes it.
//   * Categorical cells reveal a filter button on hover (click a value to
//     toggle it into its facet). Headers carry a ⌄ menu: sort asc/desc, hide,
//     add range filter, plot on chart X/Y (the table↔chart bridge).
//
// The filter bar above all views is components/filter-bar.tsx (chip model);
// the chart (components/chart-panel.tsx) and the anatomy view
// (components/anatomy-pane.tsx) mount here under the same bar.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bundle, RunRow, FilterState, SortDir,
  AnatomyConfig, TableConfig, PlotConfig, GroupPlotConfig,
} from "../lib/types";
import {
  DEFAULT_ANATOMY, DEFAULT_PLOT, DEFAULT_GROUP_PLOT, EMPTY_FILTER,
  sanitizePlotConfig, sanitizeGroupPlotConfig, sanitizeTableConfig,
} from "../lib/types";
import { useBoolbackStore, DEFAULT_TABLE, DEFAULT_COLS } from "../state/store";
import {
  applyFilters, applySorts, matchesSearch, metricRange, modeFilters, normalizeToRange,
  numericValue, cellValue, facetKeyForColumn, type MetricIndex,
} from "../lib/select";
import { indexMetricSchema, formatValue } from "../lib/metrics";
import { resolveById, type ColumnDef } from "../lib/columns";
import { sanitizeAnatomyConfig } from "../lib/anatomy";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import type { ArtifactSource } from "../data/source";
import { useResizable } from "../lib/use-resizable";
import { mean } from "../lib/stats";
import { TruthStrip } from "./truth-strip";
import { FnHex } from "./fn-hex";
import { EpochSparkline } from "./epoch-sparkline";
import { PlotBody, type PlotExportHandle } from "./plot-panel";
import { GroupPlotBody } from "./group-plot";
import { AnatomyBody } from "./anatomy-pane";
import { FilterBar } from "./filter-bar";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_H = 30; // fixed row height (windowing depends on it)
const OVERSCAN = 12; // rows rendered beyond the viewport on each side
const DEFAULT_COL_WIDTH = 120;
const TRUTH_COL_WIDTH = 220;
const MIN_COL_WIDTH = 56;
const MAX_COL_WIDTH = 520;

// Leading identity columns that freeze sticky-left (only a LEADING run of
// these ids freezes — reorder them away from the front and they scroll).
const FROZEN_IDS = new Set(["function.arity", "function.fn_hex"]);

// ===========================================================================
// TablePane
// ===========================================================================

export type CenterView = "table" | "plot" | "groupplot" | "anatomy";

/** Map a legacy/foreign center-view string to the current union
 *  ("chart" → "plot"); null when it isn't a recognizable view. Applied at the
 *  share-URL / persisted-state boundaries so old links and blobs still load. */
export function normalizeCenterView(v: unknown): CenterView | null {
  if (v === "chart") return "plot";
  return v === "table" || v === "plot" || v === "groupplot" || v === "anatomy" ? v : null;
}

export interface TablePaneProps {
  bundle: Bundle;
  /** "table" (default), "plot", "groupplot" or "anatomy" — same filter bar, swapped body. */
  view?: CenterView;
  /** Snapshot source — the top bar renders its status dot / Refresh. */
  source: ArtifactSource;
  /** Set while the tree pane is collapsed — the top bar renders the re-open button. */
  onShowTree?: () => void;
  /** Shared plot export surface (owned by the shell so the config panel's PNG
   *  export can read it too). The mounted PlotBody registers itself here. */
  chartRef: React.MutableRefObject<PlotExportHandle | null>;
}

export function TablePane({ bundle, view = "table", source, onShowTree, chartRef }: TablePaneProps) {
  const rows = bundle.rows;
  const index = useMemo<MetricIndex>(
    () => indexMetricSchema(bundle.metric_schema),
    [bundle.metric_schema],
  );

  // ---- store slices — THREE independent per-view configs -----------------
  const table = useBoolbackStore((s) => s.table);
  const plot = useBoolbackStore((s) => s.plot);
  const groupPlot = useBoolbackStore((s) => s.groupPlot);
  const anatomy = useBoolbackStore((s) => s.anatomy);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);

  const { visibleCols, columnWidths, sorts, search } = table;

  const select = useBoolbackStore((s) => s.select);
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const setDetailOpen = useBoolbackStore((s) => s.setDetailOpen);
  const hover = useBoolbackStore((s) => s.hover);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const pushSort = useBoolbackStore((s) => s.pushSort);
  const appendSort = useBoolbackStore((s) => s.appendSort);
  const setPrimarySort = useBoolbackStore((s) => s.setPrimarySort);
  const storeToggleFacetValue = useBoolbackStore((s) => s.toggleFacetValue);
  const storeAddRange = useBoolbackStore((s) => s.addRange);
  const setVisibleCols = useBoolbackStore((s) => s.setVisibleCols);
  const setColumnWidth = useBoolbackStore((s) => s.setColumnWidth);
  const setStore = useBoolbackStore.setState;

  // ---- persisted view sync — ONE key per view config ----------------------
  const [pTable, updateTable, tableHydrated] = usePersistedSettings<TableConfig>(
    "boolback:table", DEFAULT_TABLE,
  );
  const [pPlot, updatePlot, plotHydrated] = usePersistedSettings<PlotConfig>(
    "boolback:plot", DEFAULT_PLOT,
  );
  const [pGroup, updateGroup, groupHydrated] = usePersistedSettings<GroupPlotConfig>(
    "boolback:groupplot", DEFAULT_GROUP_PLOT,
  );
  const [pAnat, updateAnat, anatHydrated] = usePersistedSettings<AnatomyConfig>(
    "boolback:anatomy", DEFAULT_ANATOMY,
  );
  const allHydrated = tableHydrated && plotHydrated && groupHydrated && anatHydrated;
  const didHydrate = useRef(false);

  useEffect(() => {
    if (!allHydrated || didHydrate.current) return;
    didHydrate.current = true;
    // Sanitizers coerce a partial/hostile persisted blob to a valid config
    // without throwing (no v1→v2→v3 migration — old blobs are dropped).
    // Fresh plot/groupplot (no saved filters) default to the "core sweep" view:
    // every varying parameter pinned to its mode (the dominant cell). A returning
    // user's saved non-empty filters are kept as-is.
    const plotCfg = sanitizePlotConfig(pPlot);
    const groupCfg = sanitizeGroupPlotConfig(pGroup);
    const noFilters = (f: FilterState) =>
      Object.keys(f.facets).length === 0 && f.ranges.length === 0;
    setStore({
      table: sanitizeTableConfig(pTable, DEFAULT_COLS),
      plot: noFilters(plotCfg.filters)
        ? { ...plotCfg, filters: modeFilters(bundle.rows) } : plotCfg,
      groupPlot: noFilters(groupCfg.filters)
        ? { ...groupCfg, filters: modeFilters(bundle.rows) } : groupCfg,
      anatomy: sanitizeAnatomyConfig(pAnat),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allHydrated]);

  useEffect(() => {
    if (!didHydrate.current) return;
    updateTable(table);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);
  useEffect(() => {
    if (!didHydrate.current) return;
    updatePlot(plot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plot]);
  useEffect(() => {
    if (!didHydrate.current) return;
    updateGroup(groupPlot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupPlot]);
  useEffect(() => {
    if (!didHydrate.current) return;
    updateAnat(anatomy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anatomy]);

  // Table-scoped mutators (the header/cell actions belong to the TABLE view).
  const toggleFacetValue = useCallback(
    (key: NonNullable<ReturnType<typeof facetKeyForColumn>>, value: string) =>
      storeToggleFacetValue("table", key, value),
    [storeToggleFacetValue],
  );

  // ---- active view's filters (anatomy = frozen EMPTY_FILTER; isolated) -----
  const activeFilters: FilterState =
    view === "table" ? table.filters
    : view === "plot" ? plot.filters
    : view === "groupplot" ? groupPlot.filters
    : EMPTY_FILTER;

  // ---- column defs -------------------------------------------------------
  const colDefs = useMemo(
    () => visibleCols.map((id) => resolveById(id, bundle, index)),
    [visibleCols, bundle, index],
  );

  // ---- visible rows ------------------------------------------------------
  // Table also applies its search (path-fragment) + sorts; the plot/group views
  // just filter; anatomy sees ALL rows (EMPTY_FILTER).
  const visibleRows = useMemo(() => {
    const filtered = applyFilters(rows, activeFilters);
    if (view !== "table") return filtered;
    const q = search.trim();
    const searched = q ? filtered.filter((r) => matchesSearch(r, q)) : filtered;
    return applySorts(searched, sorts);
  }, [rows, activeFilters, view, search, sorts]);

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

  const widthOf = useCallback(
    (def: ColumnDef): number =>
      columnWidths[def.id] ??
      (def.kind === "truthStrip" ? TRUTH_COL_WIDTH : DEFAULT_COL_WIDTH),
    [columnWidths],
  );

  // ---- frozen leading columns (sticky-left offsets) ------------------------
  const frozenLefts = useMemo(() => {
    const map = new Map<string, number>();
    let left = 0;
    for (const def of colDefs) {
      if (!FROZEN_IDS.has(def.id)) break;
      map.set(def.id, left);
      left += widthOf(def);
    }
    return map;
  }, [colDefs, widthOf]);

  // ---- windowed rendering ---------------------------------------------------
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const total = visibleRows.length;
  const start = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN);
  const windowRows = useMemo(() => visibleRows.slice(start, end), [visibleRows, start, end]);
  const topPad = start * ROW_H;
  const bottomPad = (total - end) * ROW_H;

  // ---- summary footer (mean over the FILTERED set) --------------------------
  const footerMeans = useMemo(() => {
    const out = new Map<string, string>();
    for (const def of colDefs) {
      if (def.kind === "truthStrip" || def.kind === "fnHex" || def.kind === "dnf" || def.kind === "categorical") continue;
      const vals: number[] = [];
      for (const r of visibleRows) {
        const v = numericValue(r, def.id);
        if (v !== null && Number.isFinite(v)) vals.push(v);
      }
      const m = mean(vals);
      if (m !== null) {
        out.set(def.id, Number.isInteger(m) ? String(m) : m.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
      }
    }
    return out;
  }, [colDefs, visibleRows]);

  // ---- keyboard navigation ---------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(t.tagName)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (visibleRows.length === 0) return;
        const cur = visibleRows.findIndex((r) => r.identity.node_path === selectedDir);
        const next = e.key === "ArrowDown"
          ? Math.min(visibleRows.length - 1, cur + 1)
          : Math.max(0, cur === -1 ? 0 : cur - 1);
        const row = visibleRows[next];
        select(row.identity.node_path);
        const el = scrollRef.current;
        if (el) {
          const y = next * ROW_H;
          if (y < el.scrollTop + ROW_H) el.scrollTop = Math.max(0, y - ROW_H);
          else if (y + 2 * ROW_H > el.scrollTop + el.clientHeight) {
            el.scrollTop = y + 2 * ROW_H - el.clientHeight;
          }
        }
      } else if (e.key === "Enter") {
        if (selectedDir) openDetail(selectedDir);
      } else if (e.key === "Escape") {
        setDetailOpen(false);
      }
    },
    [visibleRows, selectedDir, select, openDetail, setDetailOpen],
  );

  // ---- header-menu actions ----------------------------------------------------
  const hideColumn = useCallback(
    (id: string) => setVisibleCols(visibleCols.filter((c) => c !== id)),
    [visibleCols, setVisibleCols],
  );
  const addRangeFor = useCallback(
    (metricName: string) => {
      const { min, max } = metricRange(rows, metricName, index);
      // Header "add range filter" belongs to the TABLE view's filters.
      storeAddRange("table", { metric: metricName, min, max });
    },
    [rows, index, storeAddRange],
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-bg text-text">
      <FilterBar
        visibleCount={visibleRows.length}
        totalCount={rows.length}
        bundle={bundle}
        view={view}
        source={source}
        onShowTree={onShowTree}
      />

      {view === "plot" ? (
        <PlotBody rows={visibleRows} bundle={bundle} index={index} exportRef={chartRef} />
      ) : view === "groupplot" ? (
        <GroupPlotBody rows={visibleRows} bundle={bundle} index={index} />
      ) : view === "anatomy" ? (
        <AnatomyBody rows={visibleRows} bundle={bundle} index={index} />
      ) : (
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
        className="flex-1 min-h-0 overflow-auto focus:outline-none"
      >
        <table className="border-collapse text-xs font-mono" style={{ tableLayout: "fixed" }}>
          <colgroup>
            {colDefs.map((c) => (
              <col key={c.id} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-border">
              {colDefs.map((c) => {
                const canMetric = !!(c.metricName && index[c.metricName]);
                const hasData = canMetric &&
                  !(index[c.metricName!].min === null && index[c.metricName!].max === null);
                return (
                  <HeaderCell
                    key={c.id}
                    def={c}
                    dir={sortDirOf(c.id)}
                    width={widthOf(c)}
                    frozenLeft={frozenLefts.get(c.id)}
                    onClick={onHeaderClick}
                    onResize={setColumnWidth}
                    menu={{
                      sort: (dir: SortDir) => setPrimarySort(c.id, dir),
                      hide: () => hideColumn(c.id),
                      addRange: hasData ? () => addRangeFor(c.metricName!) : undefined,
                    }}
                  />
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr aria-hidden style={{ height: topPad }}>
                <td colSpan={Math.max(1, colDefs.length)} className="p-0 border-0" />
              </tr>
            )}
            {windowRows.map((row, i) => {
              const key = `${row.identity.node_path}#${start + i}`;
              const isSel = row.identity.node_path === selectedDir;
              const isHover = row.identity.node_path === hoveredDir;
              const frozenBg = isSel ? "bg-surface-alt" : isHover ? "bg-surface" : "bg-bg";
              return (
                <tr
                  key={key}
                  style={{ height: ROW_H }}
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
                  {colDefs.map((c) => {
                    const left = frozenLefts.get(c.id);
                    return (
                      <td
                        key={c.id}
                        className={[
                          "px-2 py-1 align-middle overflow-hidden whitespace-nowrap group/cell",
                          left !== undefined ? `sticky z-[5] ${frozenBg}` : "",
                        ].join(" ")}
                        style={{ maxWidth: widthOf(c), ...(left !== undefined ? { left } : {}) }}
                      >
                        <Cell
                          row={row}
                          def={c}
                          index={index}
                          onOpenDetail={openDetail}
                          onFacetFilter={toggleFacetValue}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {bottomPad > 0 && (
              <tr aria-hidden style={{ height: bottomPad }}>
                <td colSpan={Math.max(1, colDefs.length)} className="p-0 border-0" />
              </tr>
            )}
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
          {visibleRows.length > 1 && (
            <tfoot>
              <tr
                className="border-t border-border bg-surface/95 backdrop-blur-md"
                title={`mean over the ${visibleRows.length.toLocaleString()} filtered runs (descriptive; the .tex export uses the same aggregation)`}
              >
                {colDefs.map((c, ci) => {
                  const left = frozenLefts.get(c.id);
                  const m = footerMeans.get(c.id);
                  return (
                    <td
                      key={c.id}
                      className={[
                        "sticky bottom-0 px-2 py-1 overflow-hidden whitespace-nowrap text-[11px] tabular-nums text-text-muted bg-surface/95 backdrop-blur-md",
                        left !== undefined ? "z-[6]" : "",
                      ].join(" ")}
                      style={left !== undefined ? { left, position: "sticky" } : undefined}
                    >
                      {m !== undefined ? (
                        <span><span className="text-text-faint">μ </span>{m}</span>
                      ) : ci === 0 ? (
                        <span className="text-text-faint">mean</span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      )}
    </div>
  );
}

// ===========================================================================
// Header cell (sortable + right-edge resize handle + ⌄ menu)
// ===========================================================================

interface HeaderMenuActions {
  sort: (dir: SortDir) => void;
  hide: () => void;
  addRange?: () => void;
}

function HeaderCell({
  def, dir, width, frozenLeft, onClick, onResize, menu,
}: {
  def: ColumnDef;
  dir: "asc" | "desc" | null;
  width: number;
  frozenLeft?: number;
  onClick: (col: string, e: React.MouseEvent) => void;
  onResize: (col: string, width: number) => void;
  menu: HeaderMenuActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
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

  const item = (label: string, act?: () => void) => (
    <button
      type="button"
      disabled={!act}
      onClick={() => { act?.(); setMenuOpen(false); }}
      className="block w-full rounded px-2 py-1 text-left text-xs text-text/90 hover:bg-surface-alt hover:text-accent disabled:opacity-40"
    >
      {label}
    </button>
  );

  return (
    <th
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      title={`${def.label} — click to sort, shift-click to add a secondary key`}
      className={[
        "sticky top-0 bg-surface/95 backdrop-blur-md",
        frozenLeft !== undefined ? "z-20" : "z-10",
        "px-2 py-1.5 text-left font-medium text-text-muted select-none overflow-visible",
      ].join(" ")}
      style={frozenLeft !== undefined ? { left: frozenLeft } : undefined}
    >
      <span className="group/head flex max-w-full items-center gap-0.5 overflow-hidden">
        <button
          type="button"
          onClick={(e) => onClick(def.id, e)}
          className="inline-flex min-w-0 items-center gap-1 cursor-pointer hover:text-accent focus:outline-none focus-visible:text-accent"
        >
          <span className="truncate">{def.label}</span>
          {dir && <span className="text-accent shrink-0">{dir === "asc" ? "▲" : "▼"}</span>}
        </button>
        <button
          type="button"
          aria-label={`${def.label} column menu`}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          className={[
            "shrink-0 rounded px-0.5 text-text-faint hover:text-accent transition-opacity",
            menuOpen ? "opacity-100" : "opacity-0 group-hover/head:opacity-100",
          ].join(" ")}
        >
          ⌄
        </button>
      </span>
      {menuOpen && (
        <>
          <span className="fixed inset-0 z-20 cursor-default" onClick={() => setMenuOpen(false)} />
          <span className="absolute left-0 top-full z-30 mt-0.5 block w-44 rounded-lg border border-border bg-surface/95 p-1 font-normal normal-case shadow-lg backdrop-blur-md animate-settle">
            {item("Sort ascending", () => menu.sort("asc"))}
            {item("Sort descending", () => menu.sort("desc"))}
            {item("Hide column", menu.hide)}
            {menu.addRange && (
              <>
                <span className="my-1 block border-t border-border/60" />
                {item("Add range filter", menu.addRange)}
              </>
            )}
          </span>
        </>
      )}
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
  row, def, index, onOpenDetail, onFacetFilter,
}: {
  row: RunRow;
  def: ColumnDef;
  index: MetricIndex;
  onOpenDetail: (dir: string) => void;
  onFacetFilter: (key: NonNullable<ReturnType<typeof facetKeyForColumn>>, value: string) => void;
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

  if (def.kind === "categorical" || def.kind === "text") {
    const v = cellValue(row, def.id);
    const facetKey = facetKeyForColumn(def.id);
    let s: string;
    if (v === null || v === "") s = "—";
    else if (typeof v === "number") {
      s = def.metricName
        ? formatValue(index, def.metricName, v)
        : Number.isInteger(v) ? String(v) : v.toFixed(3);
    } else s = String(v);
    const numeric = def.kind === "text";
    return (
      <span className="relative flex items-center gap-1">
        <span
          className={`block min-w-0 flex-1 truncate text-text/90 ${numeric ? "tabular-nums" : ""}`}
          title={s}
        >
          {s}
        </span>
        {facetKey && v !== null && v !== "" && (
          <button
            type="button"
            title={`filter: ${s}`}
            aria-label={`filter to ${s}`}
            onClick={(e) => {
              e.stopPropagation();
              onFacetFilter(facetKey, String(v));
            }}
            className="shrink-0 rounded px-0.5 text-[10px] text-text-faint opacity-0 transition-opacity group-hover/cell:opacity-100 hover:text-accent"
          >
            ⊕
          </button>
        )}
      </span>
    );
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
