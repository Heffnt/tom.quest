"use client";

// app/boolback/components/group-plot.tsx — the Group Plot center view: the same
// shared Plot config (store.plot) faceted across ONE parameter's values, across
// the LAYERS (one panel per layer), across the BINS of a continuous metric
// (one panel per bin of complexity / an outcome metric / the derived max
// trained epoch), or across a GRID of two parameters (row × col — one panel
// per non-empty cell, column headers across the top, row labels down the
// left). Every panel is the identical plot (shared axes, consistent styling);
// panels vary across the facet.
//
// The config panel OWNS the facet choice (groupPlot.facet — a GroupFacet union)
// and panel size (groupPlot.panelMin); this view only reads them (plus the
// SHARED plot config, store.plot, for everything else: axes, layers, style).
//
// ONE RENDERER: each panel is a COMPACT <PlotSurface> (components/plot-surface),
// the very same component the main Plot renders full size — so the panels get
// tooltips, ghost / mean-line hover, click-to-inspect, linked hover/selection
// rings and a per-panel OLS trend for free. This view is PLUMBING only: it
// resolves the global series, derives the facet panels, computes the SHARED
// scale (global extent, so every panel's axes align), and builds each panel's
// mode data (scatter points / epoch groups) in data space for the surface.
//
// SERIES MODEL: lib/split-dims.resolveSeries runs GLOBALLY (over all panels'
// rows) and returns exactly ONE series per layer, so a layer's color/shape/
// dash and the categorical axis positions mean the same thing in every panel.
// Panels carry (row × series) PAIRS: under a parameter, grid or bins facet the
// panel SLICE comes from the deduped union, but within a panel a run renders once per
// matching layer-series — the same per-layer duplication rule as the main plot;
// under the layer facet each panel is simply that layer's own series. Points
// group per (series × X bucket) exactly like the main plot (mean ± SD whiskers
// on n>1 groups, per-series connecting lines, collapsed-run ghosts). The legend
// + warnings live in the config panel's layers strip; panels are kept lean.
// Plot-level `size`/`opacity` scale every mark the same way as the main plot.
// Rendering is windowed (content-visibility) since 150 SVG panels is work.

import { Fragment, useDeferredValue, useEffect, useMemo } from "react";
import type { Bundle, RunRow } from "../lib/types";
import { DEFAULT_PLOT, DEFAULT_GROUP_EXTRAS, DEFAULT_LAYER_STYLE } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { applyFilters, numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import { metricLabel, X_GROUP_ORDER, Y_GROUP_ORDER } from "../lib/metrics";
import { PARAMETERS, type ParameterDef } from "../lib/parameters";
import { resolveSeries, averagedParams, type Series } from "../lib/split-dims";
import { resolveAxis, paramAxisOptions, type Axis } from "../lib/axes";
import { plotDataCsv, plotCsvFilename, type ExportSeries } from "../lib/plot-export";
import { groupRuns, collapsedGhosts, type RunPoint } from "../lib/aggregate";
import {
  buildRunSeries, groupSeries, trajectoryMetric,
  type EpochMetric, type RunSeries,
} from "../lib/trajectories";
import { partitionBins } from "../lib/generators";
import { niceTicks } from "../lib/stats";
import { shapeForValue, dashForValue, gradientColor, NULL_GRADIENT, SINGLE_COLOR } from "../lib/styling";
import { fnText, hash01 } from "../lib/format";
import { effectiveAxis, type PlotExportHandle } from "./plot-panel";
import { MetricPicker } from "./metric-picker";
import {
  PlotSurface,
  type SurfacePoint, type SurfaceGhostPoint, type SurfaceEpoch,
  type SurfaceMeanGroup, type SurfaceGhostRun,
  type SurfaceSize, type SurfaceScale, type SurfaceStyle,
} from "./plot-surface";

const PW = 260, PH = 176; // panel logical size (viewBox); CSS scales it
const PAD = { l: 34, r: 8, t: 8, b: 20 };
const MAX_FACETS = 150;
/** Grid cardinality cap — rows × cols above this shows the warning instead of
 *  rendering (a crossed pair explodes much faster than a flat facet). */
export const MAX_GRID_CELLS = 100;
const GHOST_CAP = 500; // per-panel epoch ghost-line cap (as the main plot)

type Extent = { x0: number; x1: number; y0: number; y1: number };

/** A run scheduled into a panel under one series (the duplication unit). */
type PanelPt = { row: RunRow; key: string };

export type FacetPanel = { id: string; value: string; count: number; pts: PanelPt[] };

/** Sort a parameter's values by its rule: numericSort ascending, else lexical
 *  (the same ordering the flat param facet uses for its panels). */
function paramValueSort(def: ParameterDef): (a: string, b: string) => number {
  return def.numericSort
    ? (a, b) => Number(a) - Number(b)
    : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Derive a grid facet's occupancy over the layers' resolved series: the sorted
 * row/col value lists plus one panel per NON-EMPTY (row-value, col-value) cell.
 * A cell's id/value is the RAW `"<row>|<col>"` pair — it doubles as the CSV
 * `panel` key; display formatting (shortModel etc.) happens only in the UI.
 * Within a cell a run renders once per matching layer-series (the same
 * duplication rule as the flat facets); `count` reports DISTINCT runs. Rows
 * where either parameter is null are dropped (they belong to no cell). Pure —
 * exported for tests.
 */
export function deriveGridCells(
  series: Array<{ key: string; rows: RunRow[] }>,
  rowDef: ParameterDef,
  colDef: ParameterDef,
): { rowVals: string[]; colVals: string[]; cells: Map<string, FacetPanel> } {
  const cells = new Map<string, FacetPanel>();
  const rowSet = new Set<string>(), colSet = new Set<string>();
  for (const s of series) {
    for (const row of s.rows) {
      const rv = rowDef.raw(row);
      const cv = colDef.raw(row);
      if (rv === null || cv === null) continue;
      rowSet.add(rv);
      colSet.add(cv);
      const id = `${rv}|${cv}`;
      let cell = cells.get(id);
      if (!cell) {
        cell = { id, value: id, count: 0, pts: [] };
        cells.set(id, cell);
      }
      cell.pts.push({ row, key: s.key });
    }
  }
  for (const c of cells.values()) {
    c.count = new Set(c.pts.map((p) => p.row.identity.node_path)).size;
  }
  return {
    rowVals: [...rowSet].sort(paramValueSort(rowDef)),
    colVals: [...colSet].sort(paramValueSort(colDef)),
    cells,
  };
}

/** Compact numeric label formatter (matches plot-panel's tooltip formatter). */
function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

export function GroupPlotBody({
  rows, bundle, index, exportRef,
}: {
  rows: RunRow[];
  bundle: Bundle;
  index: MetricIndex;
  /** The shared Export handle (CSV only — a grid of panels has no single SVG). */
  exportRef?: React.MutableRefObject<PlotExportHandle | null>;
}) {
  // INP: defer the heavy pipeline off the interaction's critical path (see the
  // note in plot-panel.tsx) — a filter click repaints the panel immediately
  // while the faceted panels re-render in a background pass.
  const livePlot = useBoolbackStore((s) => s.plot);
  const liveGroupPlot = useBoolbackStore((s) => s.groupPlot);
  const plot = useDeferredValue(livePlot);
  const groupPlot = useDeferredValue(liveGroupPlot);
  const setPlot = useBoolbackStore((s) => s.setPlot);
  const setPlotUnionCount = useBoolbackStore((s) => s.setPlotUnionCount);

  // Facet: the GroupFacet union — one panel per layer, per parameter value,
  // per bin of a continuous metric, or per (row × col) grid cell.
  const facet = groupPlot.facet;
  const facetDef =
    facet?.kind === "param" ? PARAMETERS.find((d) => d.key === facet.key) ?? null : null;
  // Grid facet parameter defs (null when a hand-edited key names no parameter —
  // the grid body renders its "unknown parameter" note in that case).
  const gridRowDef =
    facet?.kind === "grid" ? PARAMETERS.find((d) => d.key === facet.row) ?? null : null;
  const gridColDef =
    facet?.kind === "grid" ? PARAMETERS.find((d) => d.key === facet.col) ?? null : null;
  const panelMin = groupPlot.panelMin || DEFAULT_GROUP_EXTRAS.panelMin;

  // Facet-by-function panels label with the function's simplified DNF ("A&B |
  // A&C"). The compact arity:hex raw value stays the bucketing/sort key — the
  // DNF is display-only, looked up from bundle.functions by that raw value.
  const fnDnf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of Object.values(bundle.functions)) {
      if (f.dnf_string) m.set(fnText(f.arity, f.truth_table), f.dnf_string);
    }
    return m;
  }, [bundle.functions]);
  /** display() for a parameter value, with the function→DNF special case
   *  (shared by the flat facet headers and the grid margins). */
  const paramDisplay = (def: ParameterDef | null, v: string) =>
    def?.key === "function" ? (fnDnf.get(v) ?? v) : def?.display ? def.display(v) : v;

  const lineMode = plot.x === "epoch";
  const xName = lineMode ? "epoch" : effectiveAxis(plot.x, index, bundle.metric_schema, DEFAULT_PLOT.x);
  const yName = lineMode
    ? (trajectoryMetric(plot.y) ?? "plantedness")
    : effectiveAxis(plot.y, index, bundle.metric_schema, DEFAULT_PLOT.y);
  // Resolved axes over ALL rows (categories/positions align across panels).
  const axisX = useMemo(() => (lineMode ? null : resolveAxis(xName, index, rows)), [lineMode, xName, index, rows]);
  const axisY = useMemo(() => (lineMode ? null : resolveAxis(yName, index, rows)), [lineMode, yName, index, rows]);
  const logX = !!plot.logX && (axisX?.allowLog ?? true);
  const logY = !!plot.logY && (axisY?.allowLog ?? true);

  // ---- continuous colorBy encoding (honored only on a single layer) --------
  const colorBy = plot.colorBy ?? null;
  const colorByActive = !!colorBy && !!index[colorBy] && plot.layers.length === 1;
  const colorByColId = colorByActive ? (index[colorBy!] ? metricColumnId(colorBy!, index) : colorBy!) : null;
  const colorByLabel = colorByActive ? (index[colorBy!]?.label ?? colorBy!) : "";
  const colorByExtent = useMemo(() => {
    if (!colorByColId) return null;
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) {
      const v = numericValue(r, colorByColId);
      if (v === null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return Number.isFinite(lo) ? { lo, hi } : null;
  }, [rows, colorByColId]);
  const colorForC = useMemo(() => (v: number | null | undefined): string => {
    if (v === null || v === undefined || !Number.isFinite(v)) return NULL_GRADIENT;
    if (!colorByExtent) return gradientColor(0.5);
    const { lo, hi } = colorByExtent;
    return gradientColor(hi > lo ? (v - lo) / (hi - lo) : 0.5);
  }, [colorByExtent]);

  // ---- series model (computed GLOBALLY so styling aligns across panels) -----
  const resolution = useMemo(
    () => resolveSeries({
      rows,
      layers: plot.layers,
      ranges: plot.ranges,
      applyTo: applyFilters,
    }),
    [rows, plot.layers, plot.ranges],
  );
  const seriesByKey = useMemo(
    () => new Map(resolution.series.map((s) => [s.key, s])),
    [resolution.series],
  );
  // De-duplicated union of the layers' matches (shared axes + facet slices).
  const unionRows = useMemo(() => [...new Set(resolution.rowsUnion)], [resolution.rowsUnion]);
  // Parameters that vary WITHIN at least one layer's rows — the ghost tooltip's
  // "label: value" lines (same list the config panel's merged legend shows).
  const varyingParams = useMemo(() => averagedParams(resolution, PARAMETERS), [resolution]);
  // Full bundle rows keyed by run id — the surface's click-through chain
  // expansion + point/ghost tooltip lookups (independent of the plotted axes).
  const rowByRunId = useMemo(() => {
    const m = new Map<string, RunRow>();
    for (const r of bundle.rows) m.set(r.identity.node_path, r);
    return m;
  }, [bundle.rows]);

  // Publish the union's distinct-run count for the shared top bar's counter
  // (cleared on unmount so the table's filtered count takes over).
  useEffect(() => {
    setPlotUnionCount(unionRows.length);
  }, [unionRows, setPlotUnionCount]);
  useEffect(() => () => setPlotUnionCount(null), [setPlotUnionCount]);

  // ---- grid occupancy (grid facet only) --------------------------------------
  // Row/col value lists + the non-empty cells; GridPanels lays them out, and
  // the facets memo below flattens the cells for the toolbar count + export.
  const grid = useMemo(
    () => (gridRowDef && gridColDef ? deriveGridCells(resolution.series, gridRowDef, gridColDef) : null),
    [gridRowDef, gridColDef, resolution.series],
  );

  // ---- facet panels (sorted, cardinality-capped) -----------------------------
  const facets = useMemo(() => {
    if (facet?.kind === "grid") {
      // Non-empty cells in display order (row-major) — the export walks this
      // list; each cell's value is its raw "<row>|<col>" panel key.
      const list: FacetPanel[] = [];
      if (grid) {
        for (const rv of grid.rowVals) {
          for (const cv of grid.colVals) {
            const cell = grid.cells.get(`${rv}|${cv}`);
            if (cell) list.push(cell);
          }
        }
      }
      return { list, hidden: 0, lacking: 0, lackLabel: "" };
    }
    if (facet?.kind === "layer") {
      // One panel per layer — that layer's own series (duplication across
      // panels is by design: a run matching two layers appears in both).
      const list: FacetPanel[] = plot.layers.map((l) => {
        const pts = resolution.series
          .filter((s) => s.layerId === l.id)
          .flatMap((s) => s.rows.map((row) => ({ row, key: s.key })));
        return { id: l.id, value: l.name, count: pts.length, pts };
      });
      return { list, hidden: 0, lacking: 0, lackLabel: "" };
    }
    if (facet?.kind === "bins") {
      // Bin the DEDUPED union by the metric; a row lands where lo <= v <= max
      // (the ε-shrunk inclusive upper bound partitions the shared edges). Rows
      // with a null metric are DROPPED (the strip notes how many).
      const metric = facet.metric;
      const values: number[] = [];
      for (const r of unionRows) {
        const v = numericValue(r, metric);
        if (v !== null && Number.isFinite(v)) values.push(v);
      }
      const bins = partitionBins(values, facet.n, facet.mode);
      const buckets: PanelPt[][] = bins.map(() => []);
      for (const s of resolution.series) {
        for (const row of s.rows) {
          const v = numericValue(row, metric);
          if (v === null || !Number.isFinite(v)) continue;
          const bi = bins.findIndex((b) => v >= b.lo && v <= b.max);
          if (bi >= 0) buckets[bi].push({ row, key: s.key });
        }
      }
      const list: FacetPanel[] = bins.map((b, i) => ({
        id: `bin${i}`,
        value: b.label,
        count: new Set(buckets[i].map((p) => p.row.identity.node_path)).size,
        pts: buckets[i],
      }));
      const lacking = unionRows.filter((r) => numericValue(r, metric) === null).length;
      return { list, hidden: 0, lacking, lackLabel: metricLabel(index, metric) };
    }
    if (!facetDef) return { list: [] as FacetPanel[], hidden: 0, lacking: 0, lackLabel: "" };
    // Panels per parameter value over the DEDUPED union; within a panel a run
    // renders once per matching layer-series (the pair walk keeps the
    // duplicates; `count` reports DISTINCT runs).
    const groups = new Map<string, PanelPt[]>();
    for (const s of resolution.series) {
      for (const row of s.rows) {
        const v = facetDef.raw(row);
        if (v === null) continue;
        const arr = groups.get(v);
        const pt = { row, key: s.key };
        if (arr) arr.push(pt); else groups.set(v, [pt]);
      }
    }
    let list: FacetPanel[] = [...groups.entries()].map(([value, pts]) => ({
      id: value,
      value,
      count: new Set(pts.map((p) => p.row.identity.node_path)).size,
      pts,
    }));
    const byValue = facetDef.numericSort
      ? (a: FacetPanel, b: FacetPanel) => Number(a.value) - Number(b.value)
      : (a: FacetPanel, b: FacetPanel) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
    list.sort(byValue);
    let hidden = 0;
    if (list.length > MAX_FACETS) {
      hidden = list.length - MAX_FACETS;
      list = [...list].sort((a, b) => b.count - a.count).slice(0, MAX_FACETS);
      list.sort(byValue);
    }
    return { list, hidden, lacking: 0, lackLabel: "" };
  }, [facet, facetDef, grid, plot.layers, resolution.series, unionRows, index]);

  // ---- export handle (shared header CSV button) ------------------------------
  // One ExportSeries per (panel × layer) slice, panels in display order, layers
  // in config order — lib/plot-export adds the `panel` column on this view.
  // getSvg stays null: a grid of panels has no single figure to rasterize.
  useEffect(() => {
    if (!exportRef) return;
    const axes = { x: lineMode ? "epoch" : xName, y: yName };
    exportRef.current = {
      getSvg: () => null,
      getCsv: () => {
        const entries: ExportSeries[] = [];
        for (const f of facets.list) {
          const byKey = new Map<string, RunRow[]>();
          for (const p of f.pts) {
            const arr = byKey.get(p.key);
            if (arr) arr.push(p.row); else byKey.set(p.key, [p.row]);
          }
          for (const s of resolution.series) {
            const rs = byKey.get(s.key);
            if (rs && rs.length) entries.push({ layer: s.label, panel: f.value, judge: s.judge, rows: rs });
          }
        }
        return {
          csv: plotDataCsv(entries, axes, { view: "groupplot" }),
          filename: plotCsvFilename("groupplot", axes),
        };
      },
    };
    return () => { exportRef.current = null; };
  }, [exportRef, facets.list, resolution.series, lineMode, xName, yName]);

  // Categorical axis category lists (positions 0..n-1), null for numeric axes.
  const catX = !lineMode && axisX?.categorical ? axisX.categories : null;
  const catY = !lineMode && axisY?.categorical ? axisY.categories : null;

  // ---- shared extent across ALL rows (so every panel's axes align) ----------
  const extent = useMemo<Extent>(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const acc = (px: number, py: number) => {
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    };
    if (lineMode) {
      const metric = trajectoryMetric(yName);
      if (metric) {
        // Per resolved series so each series' own judge scores its extent
        // (duplicates across layers are harmless under min/max).
        for (const s of resolution.series) {
          const { series } = buildRunSeries(s.rows, metric, () => [], s.judge, logY);
          for (const t of series) for (const p of t.points) acc(logX ? (p.e > 0 ? Math.log10(p.e) : NaN) : p.e, p.y);
        }
      }
    } else if (axisX && axisY) {
      for (const r of unionRows) {
        const vx = axisX.value(r);
        const vy = axisY.value(r);
        if (vx === null || vy === null) continue;
        if ((logX && vx <= 0) || (logY && vy <= 0)) continue;
        acc(logX ? Math.log10(vx) : vx, logY ? Math.log10(vy) : vy);
      }
    }
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
    if (y1 - y0 < 1e-9) { y0 -= 0.5; y1 += 0.5; }
    const padX = (x1 - x0) * 0.05, padY = (y1 - y0) * 0.07;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    if (catX) { x0 = -0.5; x1 = catX.length - 0.5; }
    if (catY) { y0 = -0.5; y1 = catY.length - 0.5; }
    const tf = (v: number, log: boolean) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
    if (axisX && !axisX.categorical && plot.xDomain) { x0 = tf(plot.xDomain[0], logX); x1 = tf(plot.xDomain[1], logX); }
    if (axisY && !axisY.categorical && plot.yDomain) { y0 = tf(plot.yDomain[0], logY); y1 = tf(plot.yDomain[1], logY); }
    return { x0, x1, y0, y1 };
  }, [unionRows, resolution.series, lineMode, axisX, axisY, yName, logX, logY, plot.xDomain, plot.yDomain, catX, catY]);

  // Shared logical-space scale (fixed panel viewBox → aligned axes everywhere).
  // Handed to every panel's PlotSurface so their gridlines/ticks agree.
  const scale = useMemo<SurfaceScale>(() => {
    const sx = (v: number) => PAD.l + ((v - extent.x0) / (extent.x1 - extent.x0)) * (PW - PAD.l - PAD.r);
    const sy = (v: number) => PH - PAD.b - ((v - extent.y0) / (extent.y1 - extent.y0)) * (PH - PAD.t - PAD.b);
    const intTicks = (n: number) => Array.from({ length: n }, (_, i) => i);
    return {
      sx, sy,
      xTicks: catX ? intTicks(catX.length) : niceTicks(extent.x0, extent.x1, 3),
      yTicks: catY ? intTicks(catY.length) : niceTicks(extent.y0, extent.y1, 3),
      xTickLabel: (t) => (catX ? (catX[Math.round(t)] ?? "") : logX ? tickFmt(Math.pow(10, t)) : tickFmt(t)),
      yTickLabel: (t) => (catY ? (catY[Math.round(t)] ?? "") : logY ? tickFmt(Math.pow(10, t)) : tickFmt(t)),
    };
  }, [extent, catX, catY, logX, logY]);

  const facetLabel =
    facet?.kind === "layer" ? "layer"
      : facet?.kind === "param" ? (facetDef?.label ?? facet.key)
      : facet?.kind === "grid" ? `${gridRowDef?.label ?? facet.row} × ${gridColDef?.label ?? facet.col}`
      : facet?.kind === "bins" ? metricLabel(index, facet.metric)
      : "";
  const dispFacet = (v: string) => (facet?.kind === "param" ? paramDisplay(facetDef, v) : v);

  const panelCtx: PanelCtx = {
    lineMode,
    lineMetric: lineMode ? (trajectoryMetric(yName) ?? "plantedness") : null,
    axisX, axisY, logX, logY,
    jitterX: !!axisX?.jitter && !logX,
    jitterY: !!axisY?.jitter && !logY,
    catX, catY,
    xL: axisX?.label ?? xName,
    yL: axisY?.label ?? yName,
    seriesByKey,
    colorByActive, colorByColId, colorByLabel, colorForC,
    size: { W: PW, H: PH, pad: PAD },
    scale,
    surfaceConfig: {
      band: !!plot.band, ghosts: !!plot.ghosts, trend: !!plot.trend,
      size: plot.size, opacity: plot.opacity,
    },
    rowByRunId, varyingParams,
  };

  if (!facet) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        <p className="max-w-sm text-center text-xs text-text-faint">
          Choose a facet in the config panel — a parameter (one panel per value),
          <span className="text-text-muted"> layer</span> (one panel per layer), or
          a binned metric (one panel per bin).
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* toolbar: the SAME x/y MetricPickers as the main plot (writing the
          shared store.plot), then the facet summary (inert — the config panel
          owns facet + panel size). Log toggles stay plot-view chrome. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1">
          <span className="text-text-faint">x</span>
          <MetricPicker
            value={plot.x}
            onChange={(v) => setPlot({ x: v })}
            schema={bundle.metric_schema}
            ariaLabel="x metric"
            order={X_GROUP_ORDER}
            pinned={[{ value: "epoch", label: "epoch (training progress)" }]}
            params={paramAxisOptions()}
          />
        </span>
        <span className="text-text-faint" aria-hidden>·</span>
        <span className="flex items-center gap-1">
          <span className="text-text-faint">y</span>
          <MetricPicker
            value={yName}
            onChange={(v) => setPlot({ y: v })}
            schema={bundle.metric_schema}
            ariaLabel="y metric"
            order={Y_GROUP_ORDER}
            params={paramAxisOptions()}
          />
        </span>
        <span className="text-text-faint" aria-hidden>·</span>
        <span className="text-text-faint">facet:</span>
        <span className="text-text-muted">{facetLabel}</span>
        <span className="text-text-muted">
          · {facets.list.length} panels
          {facets.hidden > 0 ? ` · ${facets.hidden} more not shown` : ""}
          {facets.lacking > 0 ? ` · ${facets.lacking} runs lack ${facets.lackLabel}` : ""}
        </span>
      </div>

      {facet.kind === "grid" ? (
        <GridPanels grid={grid} rowDef={gridRowDef} colDef={gridColDef} panelMin={panelMin} ctx={panelCtx} disp={paramDisplay} />
      ) : (
        <div
          className="min-h-0 flex-1 overflow-y-auto p-2"
          style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${panelMin}px, 1fr))`, gap: 8, alignContent: "start" }}
        >
          {facets.list.map((f) => (
            <LazyPanel key={f.id} minHeight={panelMin * (PH / PW) + 22}>
              <div
                title={`${facetLabel}: ${dispFacet(f.value) || "—"} · ${f.count} runs`}
                className="flex w-full items-center justify-between gap-2 truncate px-1 pt-1 text-left text-[11px] text-text-muted"
              >
                <span className="truncate">{dispFacet(f.value) || "—"}</span>
                <span className="shrink-0 text-text-faint">{f.count}</span>
              </div>
              <Panel pts={f.pts} ctx={panelCtx} />
            </LazyPanel>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid facet layout — a REAL CSS grid: column headers across the top (col
// values, display()-formatted — shortModel for base_model, simplified DNF for
// function), row labels down the left, one compact PlotSurface per non-empty
// cell (the per-panel pooled
// trend + `r=` corner comes free from the surface). Empty cells keep their
// slot (dashed outline) so the grid stays rectangular. Cells share the same
// windowed rendering (LazyPanel) as the flat facets. Above MAX_GRID_CELLS the
// warning replaces the panels (the flat facets' cardinality guard, grid form).
// ---------------------------------------------------------------------------

function GridPanels({
  grid, rowDef, colDef, panelMin, ctx, disp,
}: {
  grid: ReturnType<typeof deriveGridCells> | null;
  rowDef: ParameterDef | null;
  colDef: ParameterDef | null;
  panelMin: number;
  ctx: PanelCtx;
  /** Parameter-value display (owner-provided: def.display + function→DNF). */
  disp: (def: ParameterDef | null, v: string) => string;
}) {
  if (!grid || !rowDef || !colDef) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        <p className="max-w-sm text-center text-xs text-text-faint">
          Grid parameters not found in this data — pick another row × col pair
          in the config panel.
        </p>
      </div>
    );
  }
  const nCells = grid.rowVals.length * grid.colVals.length;
  if (nCells > MAX_GRID_CELLS) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        <p className="max-w-sm text-center text-xs text-text-faint">
          {grid.rowVals.length} × {grid.colVals.length} = {nCells} cells exceeds
          the {MAX_GRID_CELLS}-panel cap — pick lower-cardinality parameters (or
          filter the layers down).
        </p>
      </div>
    );
  }
  const dispRow = (v: string) => disp(rowDef, v);
  const dispCol = (v: string) => disp(colDef, v);
  const minH = panelMin * (PH / PW) + 22;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `max-content repeat(${grid.colVals.length}, minmax(${panelMin}px, 1fr))`,
          gap: 8,
          alignContent: "start",
        }}
      >
        <div aria-hidden /> {/* corner spacer above the row labels */}
        {grid.colVals.map((cv) => (
          <div
            key={cv}
            title={`${colDef.label}: ${dispCol(cv) || "—"}`}
            className="truncate px-1 text-center text-[11px] text-text-muted"
          >
            {dispCol(cv) || "—"}
          </div>
        ))}
        {grid.rowVals.map((rv) => (
          <Fragment key={rv}>
            <div
              title={`${rowDef.label}: ${dispRow(rv) || "—"}`}
              className="flex items-center justify-end text-right text-[11px] text-text-muted"
              style={{ maxWidth: 140 }}
            >
              <span className="truncate">{dispRow(rv) || "—"}</span>
            </div>
            {grid.colVals.map((cv) => {
              const cell = grid.cells.get(`${rv}|${cv}`);
              if (!cell) {
                // No runs at this (row, col) — keep the slot, render nothing.
                return (
                  <div
                    key={cv}
                    className="rounded-md border border-dashed border-border/40"
                    style={{ minHeight: minH }}
                    aria-hidden
                  />
                );
              }
              return (
                <LazyPanel key={cv} minHeight={minH}>
                  <div
                    title={`${rowDef.label}: ${dispRow(rv) || "—"} · ${colDef.label}: ${dispCol(cv) || "—"} · ${cell.count} runs`}
                    className="flex w-full items-center justify-end px-1 pt-1 text-[11px] text-text-faint"
                  >
                    {cell.count}
                  </div>
                  <Panel pts={cell.pts} ctx={ctx} />
                </LazyPanel>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One facet panel — a COMPACT PlotSurface over its (row × series) pairs. This
// component only BUILDS the surface's mode data (scatter points / epoch groups)
// in data space; the surface owns all drawing + interaction. Grouping/averaging
// mirrors the main plot: points group per (series × X bucket); n>1 groups render
// as means with ±SD whiskers, per-series connecting lines and collapsed-run
// ghosts. Size/opacity are the PLOT-LEVEL multipliers (ctx.surfaceConfig);
// shape/dash come from each series' own layer style.
// ---------------------------------------------------------------------------

type PanelCtx = {
  lineMode: boolean;
  lineMetric: EpochMetric | null;
  axisX: Axis | null; axisY: Axis | null;
  logX: boolean; logY: boolean;
  jitterX: boolean; jitterY: boolean;
  catX: string[] | null; catY: string[] | null;
  xL: string; yL: string;
  /** Global series lookup (dims[0] is a point's series key === layer id;
   *  carries the series' judge for per-epoch resolution). */
  seriesByKey: Map<string, Series>;
  colorByActive: boolean; colorByColId: string | null; colorByLabel: string;
  colorForC: (v: number | null | undefined) => string;
  /** Shared surface plumbing (identical for every panel). */
  size: SurfaceSize;
  scale: SurfaceScale;
  surfaceConfig: SurfaceStyle;
  rowByRunId: Map<string, RunRow>;
  varyingParams: ParameterDef[];
};

type ScatterContent = {
  kind: "scatter";
  points: SurfacePoint[];
  meanLines: SurfacePoint[][];
  ghostPoints: SurfaceGhostPoint[];
  pairs: Array<{ x: number; y: number }>;
};
type EpochContent = {
  kind: "epoch";
  epoch: SurfaceEpoch;
  /** runs per group dims-key — feeds the panel-scoped mean-line tooltip. */
  meanCounts: Map<string, number>;
};

function Panel({ pts, ctx }: { pts: PanelPt[]; ctx: PanelCtx }) {
  const content = useMemo<ScatterContent | EpochContent | null>(() => {
    if (ctx.lineMode) return buildEpochContent(pts, ctx);
    return buildScatterContent(pts, ctx);
  }, [pts, ctx]);

  // Epoch line tooltips (the surface owns hover state + pointer positioning).
  // Ghost: layer name; fnText · run_id; up to 4 varying-parameter values.
  const ghostTooltip = (s: { runId: string; dims: string[] }): string[] => {
    const layer = ctx.seriesByKey.get(s.dims[0]);
    const row = ctx.rowByRunId.get(s.runId);
    const lines: string[] = [];
    if (layer) lines.push(layer.label);
    if (row) {
      lines.push(`${fnText(row.function.arity, row.function.truth_table)} · ${row.identity.run_id}`);
      for (const def of ctx.varyingParams.slice(0, 4)) {
        const v = def.raw(row);
        if (v !== null) lines.push(`${def.label}: ${def.display ? def.display(v) : v}`);
      }
    } else {
      lines.push(s.runId);
    }
    return lines;
  };
  // Mean line: layer name, THIS panel's run count for the group, judge if unique.
  const meanTooltip = (dims: string[]): string[] => {
    const layer = ctx.seriesByKey.get(dims[0]);
    if (!layer) return [];
    const n = content?.kind === "epoch" ? content.meanCounts.get(dims.join(" ")) ?? 0 : 0;
    const lines = [layer.label, `${n} runs`];
    if (layer.judge) lines.push(`judge: ${layer.judge}`);
    return lines;
  };

  return (
    <PlotSurface
      mode={ctx.lineMode ? "epoch" : "scatter"}
      compact
      size={ctx.size}
      scale={ctx.scale}
      config={ctx.surfaceConfig}
      logX={ctx.logX}
      logY={ctx.logY}
      points={content?.kind === "scatter" ? content.points : undefined}
      meanLines={content?.kind === "scatter" ? content.meanLines : undefined}
      ghostPoints={content?.kind === "scatter" ? content.ghostPoints : undefined}
      epoch={content?.kind === "epoch" ? content.epoch : null}
      pairs={content?.kind === "scatter" ? content.pairs : []}
      rowByRunId={ctx.rowByRunId}
      ghostTooltip={ghostTooltip}
      meanTooltip={meanTooltip}
    />
  );
}

/** Build a scatter panel's surface data (points / mean lines / ghosts / the
 *  run-deduped trend pairs) in data space. */
function buildScatterContent(pts: PanelPt[], ctx: PanelCtx): ScatterContent | null {
  if (!ctx.axisX || !ctx.axisY) return null;
  const runPts: RunPoint[] = [];
  // Trend pairs, DEDUPED by run (a run drawn once per matching layer must not
  // double-weight the fit).
  const pairs: Array<{ x: number; y: number }> = [];
  const seen = new Set<string>();
  for (const p of pts) {
    const vx = ctx.axisX.value(p.row);
    const vy = ctx.axisY.value(p.row);
    if (vx === null || vy === null) continue;
    if ((ctx.logX && vx <= 0) || (ctx.logY && vy <= 0)) continue;
    const tx = ctx.logX ? Math.log10(vx) : vx;
    const ty = ctx.logY ? Math.log10(vy) : vy;
    const id = p.row.identity.node_path;
    runPts.push({
      x: tx, y: ty, runId: id, dims: [p.key],
      c: ctx.colorByColId ? numericValue(p.row, ctx.colorByColId) : null,
    });
    if (!seen.has(id)) { seen.add(id); pairs.push({ x: tx, y: ty }); }
  }
  // Group per (series × X bucket) — same rule as the main plot.
  const grouped = groupRuns(runPts, true);

  const catX = ctx.catX, catY = ctx.catY;
  const fmtX = (v: number) => (catX ? catX[Math.round(v)] ?? tickFmt(v) : tickFmt(v));
  const fmtY = (v: number) => (catY ? catY[Math.round(v)] ?? tickFmt(v) : tickFmt(v));

  const points: SurfacePoint[] = grouped.points.map((gp) => {
    const series = ctx.seriesByKey.get(gp.dims[0]);
    const style = series?.style ?? DEFAULT_LAYER_STYLE;
    const color = ctx.colorByActive ? ctx.colorForC(gp.c) : series?.color ?? SINGLE_COLOR;
    const dimsDesc = series?.label ?? "";
    const label: string[] = [];
    if (gp.n === 1 && gp.runId) {
      const row = ctx.rowByRunId.get(gp.runId);
      label.push(row ? `${fnText(row.function.arity, row.function.truth_table)} · ${row.identity.run_id}` : gp.runId);
      if (dimsDesc) label.push(dimsDesc);
      label.push(`${ctx.xL}: ${fmtX(gp.x)}${ctx.logX ? " (log10)" : ""}`);
      label.push(`${ctx.yL}: ${fmtY(gp.y)}${ctx.logY ? " (log10)" : ""}`);
    } else {
      label.push(`${dimsDesc || "all runs"} · n=${gp.n}`);
      label.push(`${ctx.xL}: ${fmtX(gp.x)}${gp.sdX !== null && gp.sdX > 0 && !catX ? ` ± ${tickFmt(gp.sdX)}` : ""}${grouped.binned ? " (bin)" : ""}${ctx.logX ? " (log10)" : ""}`);
      label.push(`mean ${ctx.yL}: ${fmtY(gp.y)}${gp.sdY !== null && !catY ? ` ± ${tickFmt(gp.sdY)}` : ""}${ctx.logY ? " (log10)" : ""}`);
    }
    if (ctx.colorByActive && gp.c !== null && gp.c !== undefined) {
      label.push(`${ctx.colorByLabel}: ${tickFmt(gp.c)}`);
    }
    return {
      gp,
      jx: ctx.jitterX && gp.runId ? (hash01(gp.runId) - 0.5) * 0.5 : 0,
      jy: ctx.jitterY && gp.runId ? (hash01(gp.runId + "#y") - 0.5) * 0.5 : 0,
      color,
      shapeIdx: shapeForValue(style.shape),
      style,
      label,
    };
  });

  // Per-series connecting lines only where the series collapsed runs.
  const bySeries = new Map<string, SurfacePoint[]>();
  for (const p of points) {
    const arr = bySeries.get(p.gp.dims[0]);
    if (arr) arr.push(p); else bySeries.set(p.gp.dims[0], [p]);
  }
  const meanLines = [...bySeries.values()].filter(
    (arr) => arr.length > 1 && arr.some((p) => p.gp.n > 1),
  );

  const ghostPoints: SurfaceGhostPoint[] = collapsedGhosts(runPts, grouped.ghosts).map((g) => ({
    x: g.x,
    y: g.y,
    color: ctx.colorByActive ? ctx.colorForC(g.c) : ctx.seriesByKey.get(g.dims[0])?.color ?? SINGLE_COLOR,
  }));

  return { kind: "scatter", points, meanLines, ghostPoints, pairs };
}

/** Build an epoch panel's surface data (ghost run-lines + group mean lines) in
 *  data space, mirroring the main plot's per-layer trajectory build. */
function buildEpochContent(pts: PanelPt[], ctx: PanelCtx): EpochContent | null {
  const traj = ctx.lineMetric;
  if (!traj) return null;
  // Each run draws one trajectory per matching series (pair walk), so batch the
  // pairs by series key and score each with ITS judge.
  const byKey = new Map<string, RunRow[]>();
  for (const p of pts) {
    const arr = byKey.get(p.key);
    if (arr) arr.push(p.row); else byKey.set(p.key, [p.row]);
  }
  const series: RunSeries[] = [];
  for (const [key, rs] of byKey) {
    const judge = ctx.seriesByKey.get(key)?.judge ?? null;
    series.push(...buildRunSeries(rs, traj, () => [key], judge, ctx.logY).series);
  }
  const groups = groupSeries(series);

  // Per-run colorBy value + per-group mean (continuous COLOR encoding).
  const colorByOfRun = ctx.colorByColId
    ? new Map(pts.map((p) => [p.row.identity.node_path, numericValue(p.row, ctx.colorByColId!)]))
    : null;
  const meanC = new Map<string, number>();
  if (ctx.colorByActive && colorByOfRun) {
    const acc = new Map<string, number[]>();
    for (const s of series) {
      const cv = colorByOfRun.get(s.runId);
      if (cv === null || cv === undefined || !Number.isFinite(cv)) continue;
      const k = s.dims.join(" ");
      const arr = acc.get(k);
      if (arr) arr.push(cv); else acc.set(k, [cv]);
    }
    for (const [k, vs] of acc) meanC.set(k, vs.reduce((a, b) => a + b, 0) / vs.length);
  }

  // logX drops epoch ≤ 0 (no negative time on a log axis).
  const txX = (e: number): number | null => (ctx.logX ? (e > 0 ? Math.log10(e) : null) : e);

  // Ghost run-lines (subsampled to the per-panel cap), colored by colorBy
  // (continuous) or the run's layer; carry runId + key for the hit-stroke.
  const step = Math.max(1, Math.ceil(series.length / GHOST_CAP));
  const ghostRuns: SurfaceGhostRun[] = [];
  for (let i = 0; i < series.length; i += step) {
    const s = series[i];
    const sSeries = ctx.seriesByKey.get(s.dims[0]);
    const color = ctx.colorByActive
      ? ctx.colorForC(colorByOfRun?.get(s.runId) ?? null)
      : sSeries?.color ?? SINGLE_COLOR;
    const linePts: Array<{ x: number; y: number }> = [];
    for (const p of s.points) {
      const x2 = txX(p.e);
      if (x2 !== null) linePts.push({ x: x2, y: p.y });
    }
    ghostRuns.push({ color, runId: s.runId, dims: s.dims, pts: linePts });
  }

  // Group mean lines: color from colorBy mean (continuous) or the layer; dash
  // from the owning layer's style; label = the series' label (vertex title).
  const groupVis: SurfaceMeanGroup[] = groups.map((g) => {
    const gSeries = ctx.seriesByKey.get(g.dims[0]);
    const style = gSeries?.style ?? DEFAULT_LAYER_STYLE;
    const color = ctx.colorByActive
      ? ctx.colorForC(meanC.get(g.dims.join(" ")) ?? null)
      : gSeries?.color ?? SINGLE_COLOR;
    const linePts: Array<{ x: number; y: number; sd: number | null; n: number }> = [];
    for (const p of g.points) {
      const x2 = txX(p.e);
      if (x2 !== null) linePts.push({ x: x2, y: p.y, sd: p.sd, n: p.n });
    }
    return {
      dims: g.dims,
      color,
      dash: dashForValue(style.dash),
      shapeIdx: shapeForValue(style.shape),
      runId: g.runId,
      label: gSeries?.label ?? g.dims[0] ?? "",
      pts: linePts,
    };
  });

  // Runs per group (panel-scoped) for the mean-line tooltip.
  const meanCounts = new Map<string, number>();
  for (const s of series) {
    const k = s.dims.join(" ");
    meanCounts.set(k, (meanCounts.get(k) ?? 0) + 1);
  }

  return { kind: "epoch", epoch: { ghostRuns, groups: groupVis }, meanCounts };
}

// ---------------------------------------------------------------------------
// Windowed mount — `content-visibility: auto` lets the browser skip layout and
// paint for off-screen panels natively (no IntersectionObserver, robust in any
// render context). The SVGs stay in the DOM; only their rendering is deferred.
// ---------------------------------------------------------------------------

function LazyPanel({ children, minHeight }: { children: React.ReactNode; minHeight: number }) {
  return (
    <div
      className="overflow-hidden rounded-md border border-border/50 bg-surface/40"
      style={{
        minHeight,
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${Math.round(minHeight)}px`,
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
