"use client";

// app/boolback/components/plot-panel.tsx — the Plot center view.
//
// A single scatter over the SAME filtered row set as the table (the filter
// bar stays above both views) that answers the campaign's real questions:
// "does outcome Y move with function-complexity X, and does the context
// moderate it?"
//
// This file owns the PLUMBING: ResizeObserver sizing, axis resolution + the
// shared scale, series resolution + point/epoch building, the descriptive
// readout published to the top bar, the Export handle/CSV, the on-axis pickers
// + log toggles + AxisRange view-window editors + colorbar. The drawing +
// interaction machinery BETWEEN the axes lives in components/plot-surface.tsx
// (PlotSurface); this component builds the mode data and renders ONE full-size
// PlotSurface (the Group Plot renders many compact ones from the same
// component).
//
//   X / Y = any snapshot metric; the pickers live ON the axes (the x picker
//       under the x axis, the y picker rotated along the y axis) and both
//       log toggles hug the origin — all off the store-owned chart config.
//       Only the trend toggle stays in the SHARED top bar (filter-bar.tsx);
//       the r/ρ readout is published back to the bar via store.plotReadout
//       (ALWAYS computed over the underlying runs). The exported figure
//       keeps plain axis labels + a layers legend via [data-export-only]
//       SVG groups.
//
// LAYER MODEL: the plotted rows are the UNION of the config's LAYERS (named,
// styled parameter selections); lib/split-dims.resolveSeries returns exactly
// ONE series per layer, each with its own color (layer color) and glyph
// (shapeForValue(style.shape) / dashForValue(style.dash), the layer's style).
// A run matching several layers is drawn once PER matching layer (duplication
// by design, surfaced as overlapCount — but the r/ρ/trend statistics dedupe
// by run so nothing double-weights). Multiple traces over one parameter come
// from GENERATORS (lib/generators expand-by-parameter / bin-by-metric) minting
// multiple layers — there is no in-layer split any more.
//
// PLOT-LEVEL vs LAYER-LEVEL style: size/opacity/band/ghosts/trend live on
// PlotConfig and are read directly (config.size / config.opacity) everywhere
// a marker/line/whisker/ghost renders; color/shape/dash are per-layer
// (series.color, style.shape, style.dash).
//
// WITHIN-SERIES AVERAGING: points group per (layer × X bucket) via
// lib/aggregate.groupRuns — exact X values up to 24 distinct, equal-width
// bins beyond. Averaging is simply the n>1 case: a group with n>1 renders as
// a mean point with ±SD whiskers (config.band), its layer's groups connect
// across X, and the raw runs it collapsed draw behind as faint ghosts
// (config.ghosts). A group with n=1 stays an ordinary click-to-inspect run
// point. The parameters left varying inside layers are listed in the config
// panel's merged legend ("averaged: …") via lib/split-dims.averagedParams.
//
// EPOCH-MODE LINE HOVER: every ghost run-polyline and every group mean-
// polyline carries an invisible companion hit stroke (transparent,
// pointerEvents="stroke") feeding the same HTML tooltip as the scatter path
// (positioned from the pointer, not the data point). Hovering a ghost shows
// the layer name, the run's fn/id, and up to 4 varying-parameter values;
// hovering a mean line shows the layer name, its run count, and its judge
// when unique. Clicking a ghost opens the run inspector.
//
// Hover a point for its layer + values; click a single-run point to open its
// drawer (the surface handles hover/click). The row hovered or selected
// elsewhere (table/tree) is ring-highlighted here. There is NO box-select: the
// view window is edited only through the AxisRange controls by each axis end.
//
// Pure SVG — no chart library. Descriptive stats only (lib/stats.ts): the
// boundary rule says inferential statistics come from CMT, never the browser.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, RunRow, LayerStyle } from "../lib/types";
import { DEFAULT_PLOT, DEFAULT_LAYER_STYLE } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { applyFilters, numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import { X_GROUP_ORDER, Y_GROUP_ORDER, formatValue } from "../lib/metrics";
import { PARAMETERS } from "../lib/parameters";
import { resolveSeries, averagedParams } from "../lib/split-dims";
import { resolveAxis, isParamAxis, paramAxisOptions } from "../lib/axes";
import {
  groupRuns, collapsedGhosts,
  type RunPoint, type Ghost,
} from "../lib/aggregate";
import { niceTicks, pearson, spearman } from "../lib/stats";
import { buildRunSeries, groupSeries, trajectoryMetric, type RunSeries } from "../lib/trajectories";
import {
  SINGLE_COLOR, shapeForValue, dashForValue, gradientColor, NULL_GRADIENT,
} from "../lib/styling";
import { plotDataCsv, plotCsvFilename } from "../lib/plot-export";
import { fnText, hash01 } from "../lib/format";
import { MetricPicker } from "./metric-picker";
import { AxisRange } from "./axis-range";
import { shapeNode } from "./glyph";
import { PlotSurface, type SurfacePoint, type SurfaceTrendSeries } from "./plot-surface";

/** What the shared Export menu needs from the mounted plot (the Group Plot
 *  wires the same handle; its getSvg is null — a grid has no single figure). */
export interface PlotExportHandle {
  getSvg: () => SVGSVGElement | null;
  /** The data CSV of the plotted selection + its download filename
   *  (lib/plot-export.plotDataCsv — run grain, raw underlying points). */
  getCsv: () => { csv: string; filename: string };
}

/** Guard a persisted/shared axis name (also used by the top bar's axis pickers
 *  so both agree). A metric_schema name or an offered PARAMETER axis (dotted
 *  path — Phase 3) passes through; anything else falls back. */
export function effectiveAxis(
  name: string,
  index: MetricIndex,
  schema: Bundle["metric_schema"],
  fallback: string,
): string {
  if (index[name] || isParamAxis(name)) return name;
  return fallback in index ? fallback : (schema[0]?.name ?? "");
}

// Geometry: the SVG viewBox tracks the plot container 1:1 (ResizeObserver;
// 1 viewBox unit = 1 CSS px), so in-SVG font sizes are literal pixel sizes
// and the plot fills the pane at any aspect ratio — no letterboxing, no
// shrinking text. FALLBACK covers the first pre-measure render only.
const FALLBACK = { w: 820, h: 430 };
// PAD.l leaves room for the rotated y-axis picker + tick labels side by side.
const PAD = { l: 72, r: 16, t: 14, b: 44 };

function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

/** Dash pattern for a layer style (DASH_PATTERNS index; cycles). */
const dashOf = (style: LayerStyle): string => dashForValue(style.dash);

export function PlotBody({
  rows,
  bundle,
  index,
  exportRef,
}: {
  rows: RunRow[]; // the filtered (+sorted) rows — plot and table always agree
  bundle: Bundle;
  index: MetricIndex;
  exportRef?: React.MutableRefObject<PlotExportHandle | null>;
}) {
  // INP: the plot's heavy pipeline (resolveSeries over the whole bundle + the
  // SVG build) is DEFERRED off the interaction's critical path. A filter click
  // updates the store urgently — the checkbox and the (memoized) config chips
  // repaint immediately — while this component keeps rendering the previous
  // config until React finishes the plot in a background pass. startTransition
  // on the store WRITE cannot do this (zustand updates via useSyncExternalStore
  // are always urgent); deferring the READ is what moves the work off-path.
  const liveConfig = useBoolbackStore((s) => s.plot);
  const config = useDeferredValue(liveConfig);
  const setPlot = useBoolbackStore((s) => s.setPlot);
  const setPlotReadout = useBoolbackStore((s) => s.setPlotReadout);
  const setPlotUnionCount = useBoolbackStore((s) => s.setPlotUnionCount);

  const svgRef = useRef<SVGSVGElement | null>(null);

  // The SVG draws at the plot container's real pixel size (see FALLBACK note).
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 80 || r.height < 80) return; // hidden/degenerate pane
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;

  // Epoch (training-progress) x-axis: runs/groups become trajectory LINES, and
  // Y must be a trajectory-backed metric (snap to plantedness otherwise).
  const lineMode = config.x === "epoch";
  const x = lineMode ? "epoch" : effectiveAxis(config.x, index, bundle.metric_schema, DEFAULT_PLOT.x);
  const y = lineMode
    ? (trajectoryMetric(config.y) ?? "plantedness")
    : effectiveAxis(config.y, index, bundle.metric_schema, DEFAULT_PLOT.y);
  // Resolved axes (scatter): metric / numeric-param / categorical-param. In
  // epoch mode the axes are handled by the trajectory path (X is time).
  const axisX = useMemo(() => (lineMode ? null : resolveAxis(x, index, rows)), [lineMode, x, index, rows]);
  const axisY = useMemo(() => (lineMode ? null : resolveAxis(y, index, rows)), [lineMode, y, index, rows]);
  // Log only where it's meaningful (never on a categorical axis).
  const logX = !!config.logX && (axisX?.allowLog ?? true);
  const logY = !!config.logY && (axisY?.allowLog ?? true);
  // Persist the Y snap so the config stays consistent after entering epoch mode.
  useEffect(() => {
    if (lineMode && config.y !== y) setPlot({ y });
  }, [lineMode, config.y, y, setPlot]);
  // ---- continuous colorBy encoding (honored only on a single, unsplit layer)
  const colorBy = config.colorBy ?? null;
  const colorByActive = !!colorBy && !!index[colorBy] && config.layers.length === 1;
  const colorByColId = colorByActive ? (index[colorBy!] ? metricColumnId(colorBy!, index) : colorBy!) : null;
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
  const colorByLabel = colorByActive ? (index[colorBy!]?.label ?? colorBy!) : "";
  const colorForC = useCallback(
    (v: number | null | undefined): string => {
      if (v === null || v === undefined || !Number.isFinite(v)) return NULL_GRADIENT;
      if (!colorByExtent) return gradientColor(0.5);
      const { lo, hi } = colorByExtent;
      return gradientColor(hi > lo ? (v - lo) / (hi - lo) : 0.5);
    },
    [colorByExtent],
  );

  // ---- the layer model (the config panel computes the SAME resolution) ------
  const resolution = useMemo(
    () => resolveSeries({
      rows,
      layers: config.layers,
      ranges: config.ranges,
      applyTo: applyFilters,
    }),
    [rows, config.layers, config.ranges],
  );
  const seriesList = resolution.series;
  const seriesByKey = useMemo(
    () => new Map(seriesList.map((s) => [s.key, s])),
    [seriesList],
  );
  // Parameters that vary WITHIN at least one layer's rows — feeds the ghost
  // tooltip's "label: value" lines (same list the config panel's merged
  // legend shows as "averaged: …").
  const varyingParams = useMemo(() => averagedParams(resolution, PARAMETERS), [resolution]);
  // Full bundle rows keyed by run id — ghost/vertex click-through + tooltip
  // param lookups (independent of the currently plotted axes/view window).
  const rowByRunId = useMemo(() => {
    const m = new Map<string, RunRow>();
    for (const r of bundle.rows) m.set(r.identity.node_path, r);
    return m;
  }, [bundle.rows]);
  // De-duplicated union (trajectory colorBy + the top bar's run counter).
  const unionRows = useMemo(() => [...new Set(resolution.rowsUnion)], [resolution.rowsUnion]);

  // Publish the union's distinct-run count for the shared top bar's counter
  // (cleared on unmount so the table's filtered count takes over).
  useEffect(() => {
    setPlotUnionCount(unionRows.length);
  }, [unionRows, setPlotUnionCount]);
  useEffect(() => () => setPlotUnionCount(null), [setPlotUnionCount]);

  // Axis view windows (zoom only; never touch FilterState) in RAW units. A
  // categorical axis ignores a persisted numeric window (its units are ordinal).
  // Epoch (line) mode has no resolved axis object but is numeric on BOTH axes,
  // so its zoom window applies too.
  const xDomain = lineMode
    ? config.xDomain ?? null
    : axisX && !axisX.categorical ? config.xDomain ?? null : null;
  const yDomain = lineMode
    ? config.yDomain ?? null
    : axisY && !axisY.categorical ? config.yDomain ?? null : null;

  // ---- points ---------------------------------------------------------------
  const {
    points, pairs, seriesPairs, ghosts, ghostsSubsampled, droppedLog, outsideWindow,
    binned, rowByPath, dataExtent,
  } = useMemo(() => {
    if (lineMode || !axisX || !axisY) {
      // Scatter path is inert in epoch mode — the epoch memo drives rendering.
      return {
        points: [], pairs: [], seriesPairs: [] as Array<{ key: string; pairs: Array<{ x: number; y: number }> }>,
        ghosts: [], ghostsSubsampled: false,
        droppedLog: 0, outsideWindow: 0, binned: false,
        rowByPath: new Map<string, RunRow>(), dataExtent: null,
      };
    }
    let dropped = 0;
    let outside = 0;
    const runPts: RunPoint[] = [];
    // Run-level pairs for r/ρ and the OLS trend, DEDUPED by run: a run drawn
    // once per matching layer must not double-weight the statistics.
    const rawPairs: Array<{ x: number; y: number }> = [];
    // Per-series pairs (rows are unique within a layer, so run-deduped by
    // construction) — the surface's per-series trend fits (>= 2 layers).
    const rawSeriesPairs: Array<{ key: string; pairs: Array<{ x: number; y: number }> }> = [];
    const seen = new Set<string>();
    const byPath = new Map<string, RunRow>();
    // Raw data extent over droppable-clean points (pre-window) for the axis controls.
    let exMinX = Infinity, exMaxX = -Infinity, exMinY = Infinity, exMaxY = -Infinity;
    // Layer-major walk — a run matching several layers draws once per
    // matching layer (duplication by design; surfaced as overlapCount).
    for (const s of seriesList) {
      const sPairs: Array<{ x: number; y: number }> = [];
      rawSeriesPairs.push({ key: s.key, pairs: sPairs });
      for (const r of s.rows) {
        const id = r.identity.node_path;
        const first = !seen.has(id);
        seen.add(id);
        const vx = axisX.value(r);
        const vy = axisY.value(r);
        if (vx === null || vy === null) continue;
        if ((logX && vx <= 0) || (logY && vy <= 0)) {
          if (first) dropped++;
          continue;
        }
        if (vx < exMinX) exMinX = vx;
        if (vx > exMaxX) exMaxX = vx;
        if (vy < exMinY) exMinY = vy;
        if (vy > exMaxY) exMaxY = vy;
        // View-window clip: outside the zoom stays in the table/filters, just not drawn.
        if ((xDomain && (vx < xDomain[0] || vx > xDomain[1])) ||
            (yDomain && (vy < yDomain[0] || vy > yDomain[1]))) {
          if (first) outside++;
          continue;
        }
        const tx = logX ? Math.log10(vx) : vx;
        const ty = logY ? Math.log10(vy) : vy;
        const c = colorByColId ? numericValue(r, colorByColId) : null;
        runPts.push({ x: tx, y: ty, runId: id, dims: [s.key], c });
        if (first) rawPairs.push({ x: tx, y: ty });
        sPairs.push({ x: tx, y: ty });
        byPath.set(id, r);
      }
    }
    // Group per (layer × X bucket); n>1 groups ARE the averaging.
    const grouped = groupRuns(runPts, true);

    return {
      points: grouped.points,
      pairs: rawPairs,
      seriesPairs: rawSeriesPairs,
      // Only the runs a mean actually collapsed ghost (never n=1 duplicates).
      ghosts: collapsedGhosts(runPts, grouped.ghosts),
      ghostsSubsampled: grouped.ghostsSubsampled,
      droppedLog: dropped,
      outsideWindow: outside,
      binned: grouped.binned,
      rowByPath: byPath,
      dataExtent: Number.isFinite(exMinX)
        ? { xMin: exMinX, xMax: exMaxX, yMin: exMinY, yMax: exMaxY }
        : null,
    };
  }, [lineMode, seriesList, axisX, axisY, logX, logY, colorByColId, xDomain, yDomain]);

  // Did any group collapse runs? Drives the averaged-rendering extras (mean
  // lines, ghosts) and the readout/CSV shape — no standalone averaging mode.
  const collapsed = useMemo(() => points.some((p) => p.n > 1), [points]);

  // ---- epoch trajectories (line mode) ---------------------------------------
  const epoch = useMemo(() => {
    if (!lineMode) return null;
    const metric = trajectoryMetric(y);
    if (!metric) return null;
    // Each run draws one trajectory PER MATCHING LAYER (the same per-layer
    // duplication as the scatter), tagged with the layer id. Per-epoch values
    // come from the layer's judge (its unique judge over its rows); a layer
    // mixing judges falls back to the headline trajectory — the legend's
    // judgePooled warning already flags that layer.
    let droppedY = 0;
    const series: RunSeries[] = [];
    for (const s of seriesList) {
      const built = buildRunSeries(s.rows, metric, () => [s.key], s.judge, logY);
      droppedY += built.dropped;
      series.push(...built.series);
    }
    const groups = groupSeries(series);

    // Per-run colorBy value + per-group mean (continuous COLOR encoding).
    const colorByOfRun = colorByColId
      ? new Map(unionRows.map((r) => [r.identity.node_path, numericValue(r, colorByColId)]))
      : null;
    const meanColorByOfDims = new Map<string, number>();
    if (colorByActive && colorByOfRun) {
      const acc = new Map<string, number[]>();
      for (const s of series) {
        const cv = colorByOfRun.get(s.runId);
        if (cv === null || cv === undefined || !Number.isFinite(cv)) continue;
        const k = s.dims.join(" ");
        const arr = acc.get(k);
        if (arr) arr.push(cv); else acc.set(k, [cv]);
      }
      for (const [k, vs] of acc) meanColorByOfDims.set(k, vs.reduce((a, b) => a + b, 0) / vs.length);
    }

    // x transform (logX drops epoch ≤ 0); count as "dropped (log)".
    let droppedX = 0;
    const txX = (e: number): number | null => {
      if (!logX) return e;
      if (e <= 0) { droppedX++; return null; }
      return Math.log10(e);
    };

    // Ghost run-lines, colored by colorBy (continuous) or the run's layer;
    // carry runId + layer key so the hover/click hit-stroke can use them.
    const ghostCap = 500;
    const step = Math.max(1, Math.ceil(series.length / ghostCap));
    const ghostRuns: Array<{ color: string; runId: string; dims: string[]; pts: Array<{ x: number; y: number }> }> = [];
    for (let i = 0; i < series.length; i += step) {
      const s = series[i];
      const sSeries = seriesByKey.get(s.dims[0]);
      const color = colorByActive
        ? colorForC(colorByOfRun?.get(s.runId) ?? null)
        : sSeries?.color ?? SINGLE_COLOR;
      const pts: Array<{ x: number; y: number }> = [];
      for (const p of s.points) {
        const x2 = txX(p.e);
        if (x2 !== null) pts.push({ x: x2, y: p.y });
      }
      ghostRuns.push({ color, runId: s.runId, dims: s.dims, pts });
    }

    // Group mean lines: color from colorBy mean (continuous) or the layer;
    // dash comes from the owning layer's style (size/opacity are plot-level,
    // applied straight from config at render).
    const groupVis = groups.map((g) => {
      const gSeries = seriesByKey.get(g.dims[0]);
      const gStyle = gSeries?.style ?? DEFAULT_LAYER_STYLE;
      const dash = dashOf(gStyle);
      const color = colorByActive
        ? colorForC(meanColorByOfDims.get(g.dims.join(" ")) ?? null)
        : gSeries?.color ?? SINGLE_COLOR;
      const pts: Array<{ x: number; y: number; sd: number | null; n: number }> = [];
      for (const p of g.points) {
        const x2 = txX(p.e);
        if (x2 !== null) pts.push({ x: x2, y: p.y, sd: p.sd, n: p.n });
      }
      const label = gSeries?.label ?? g.dims[0] ?? "";
      return { dims: g.dims, color, dash, shapeIdx: shapeForValue(gStyle.shape), runId: g.runId, label, pts };
    });

    // Extent over all rendered points.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const acc = (px: number, py: number) => {
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    };
    for (const g of groupVis) for (const p of g.pts) acc(p.x, p.y);
    for (const s of ghostRuns) for (const p of s.pts) acc(p.x, p.y);

    // Raw (un-transformed) bounds for the axis range editor, which shows and
    // writes RAW units (the scale re-applies log). Epoch extent is unpadded.
    const untf = (v: number, log: boolean) => (log ? Math.pow(10, v) : v);
    return {
      ghostRuns,
      groups: groupVis,
      dropped: droppedY + droppedX,
      seriesCount: series.length,
      extent: Number.isFinite(x0) ? { x0, x1, y0, y1 } : null,
      rawExtent: Number.isFinite(x0)
        ? { xMin: untf(x0, logX), xMax: untf(x1, logX), yMin: untf(y0, logY), yMax: untf(y1, logY) }
        : null,
    };
  }, [lineMode, y, unionRows, seriesList, seriesByKey, logX, logY,
      colorByActive, colorByColId, colorForC]);

  // Jitter stacked SINGLE-run points on a count/categorical axis (log axes
  // excluded; n>1 means never jitter — their position is the statistic).
  const jitterX = !!axisX?.jitter && !logX;
  const jitterY = !!axisY?.jitter && !logY;

  const visual: SurfacePoint[] = useMemo(() => {
    const xL = axisX?.label ?? x;
    const yL = axisY?.label ?? y;
    const catX = axisX?.categorical ? axisX.categories : null;
    const catY = axisY?.categorical ? axisY.categories : null;
    const fmtX = (v: number) => (catX ? catX[Math.round(v)] ?? tickFmt(v) : tickFmt(v));
    const fmtY = (v: number) => (catY ? catY[Math.round(v)] ?? tickFmt(v) : tickFmt(v));
    return points.map((gp) => {
      const series = seriesByKey.get(gp.dims[0]);
      const style = series?.style ?? DEFAULT_LAYER_STYLE;
      const color = colorByActive ? colorForC(gp.c) : series?.color ?? SINGLE_COLOR;
      const shape = shapeForValue(style.shape);
      const dimsDesc = series?.label ?? "";
      const label: string[] = [];
      if (gp.n === 1 && gp.runId) {
        const row = rowByPath.get(gp.runId);
        label.push(row ? `${fnText(row.function.arity, row.function.truth_table)} · ${row.identity.run_id}` : gp.runId);
        if (dimsDesc) label.push(dimsDesc);
        label.push(`${xL}: ${fmtX(gp.x)}${logX ? " (log10)" : ""}`);
        label.push(`${yL}: ${fmtY(gp.y)}${logY ? " (log10)" : ""}`);
      } else {
        label.push(`${dimsDesc || "all runs"} · n=${gp.n}`);
        label.push(`${xL}: ${fmtX(gp.x)}${gp.sdX !== null && gp.sdX > 0 && !catX ? ` ± ${tickFmt(gp.sdX)}` : ""}${binned ? " (bin)" : ""}${logX ? " (log10)" : ""}`);
        label.push(`mean ${yL}: ${fmtY(gp.y)}${gp.sdY !== null && !catY ? ` ± ${tickFmt(gp.sdY)}` : ""}${logY ? " (log10)" : ""}`);
      }
      if (colorByActive && gp.c !== null && gp.c !== undefined) {
        label.push(`${colorByLabel}: ${tickFmt(gp.c)}`);
      }
      return {
        gp,
        jx: jitterX && gp.runId ? (hash01(gp.runId) - 0.5) * 0.5 : 0,
        jy: jitterY && gp.runId ? (hash01(gp.runId + "#y") - 0.5) * 0.5 : 0,
        color,
        shapeIdx: shape,
        style,
        label,
      };
    });
  }, [points, seriesByKey, rowByPath,
      axisX, axisY, x, y, logX, logY, binned, jitterX, jitterY,
      colorByActive, colorByLabel, colorForC]);

  // Scales over the TRANSFORMED values. Categorical axes use integer tick
  // positions and a domain spanning all categories (± ½ for the end margins).
  const catX = !lineMode && axisX?.categorical ? axisX.categories : null;
  const catY = !lineMode && axisY?.categorical ? axisY.categories : null;
  const scale = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    if (lineMode && epoch?.extent) {
      ({ x0, x1, y0, y1 } = epoch.extent);
    } else {
      for (const p of visual) {
        const px = p.gp.x + p.jx;
        const py = p.gp.y + p.jy;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
    if (y1 - y0 < 1e-9) { y0 -= 0.5; y1 += 0.5; }
    const padX = (x1 - x0) * 0.04;
    const padY = (y1 - y0) * 0.06;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    // Categorical: pin the domain to the ordinal category range.
    if (catX) { x0 = -0.5; x1 = catX.length - 0.5; }
    if (catY) { y0 = -0.5; y1 = catY.length - 0.5; }
    // A set axis window overrides the auto extent (exact zoom, no padding).
    const tf = (v: number, log: boolean) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
    if (xDomain) { x0 = tf(xDomain[0], logX); x1 = tf(xDomain[1], logX); }
    if (yDomain) { y0 = tf(yDomain[0], logY); y1 = tf(yDomain[1], logY); }
    const sx = (v: number) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const intTicks = (n: number) => Array.from({ length: n }, (_, i) => i);
    return {
      sx, sy,
      xTicks: catX ? intTicks(catX.length) : niceTicks(x0, x1, 5),
      yTicks: catY ? intTicks(catY.length) : niceTicks(y0, y1, 5),
    };
  }, [visual, W, H, xDomain, yDomain, logX, logY, lineMode, epoch, catX, catY]);

  // Ghost points — the faint raw runs behind the collapsed group means
  // (config.ghosts; `ghosts` is pre-filtered to n>1 groups). Colored by
  // colorBy (continuous) or each run's layer; opacity is the plot-level
  // multiplier (config.opacity), applied at render.
  const ghostVisual = useMemo(() => {
    if (!config.ghosts) return [] as Array<{ x: number; y: number; color: string }>;
    return ghosts.map((g: Ghost) => {
      const gSeries = seriesByKey.get(g.dims[0]);
      const color = colorByActive ? colorForC(g.c) : gSeries?.color ?? SINGLE_COLOR;
      return { x: g.x, y: g.y, color };
    });
  }, [ghosts, config.ghosts, seriesByKey, colorByActive, colorForC]);

  // Per-series trend inputs (color/dash from the owning layer) — with >= 2
  // layers the surface fits one OLS line per series instead of the pooled one.
  const trendSeries = useMemo<SurfaceTrendSeries[]>(
    () => seriesPairs.map((sp) => {
      const s = seriesByKey.get(sp.key);
      return {
        key: sp.key,
        color: s?.color ?? SINGLE_COLOR,
        dash: dashOf(s?.style ?? DEFAULT_LAYER_STYLE),
        pairs: sp.pairs,
      };
    }),
    [seriesPairs, seriesByKey],
  );

  // The r/ρ readout — ALWAYS over the run-deduped underlying pairs (a
  // correlation over group means would overstate the association; a run
  // matching two layers must not double-weight it). The OLS trend LINE itself
  // is fit + drawn by PlotSurface from the same pairs.
  const stats = useMemo(() => {
    if (pairs.length < 2) return null;
    const xs = pairs.map((p) => p.x);
    const ys = pairs.map((p) => p.y);
    return { overall: { r: pearson(xs, ys), rho: spearman(xs, ys), n: pairs.length } };
  }, [pairs]);

  // Publish the descriptive readout for the shared top bar (cleared on unmount).
  useEffect(() => {
    if (lineMode) {
      setPlotReadout({
        r: null, rho: null,
        runs: epoch?.seriesCount ?? 0,
        points: epoch?.groups.length ?? 0,
        averaging: true, binned: false,
        droppedLog: epoch?.dropped ?? 0,
        outsideWindow: 0,
        ghostsSubsampled: (epoch?.seriesCount ?? 0) > 500,
      });
      return;
    }
    setPlotReadout({
      r: stats?.overall.r ?? null,
      rho: stats?.overall.rho ?? null,
      runs: pairs.length,
      points: points.length,
      averaging: collapsed,
      binned,
      droppedLog,
      outsideWindow,
      ghostsSubsampled,
    });
  }, [lineMode, epoch, stats, pairs.length, points.length, collapsed, binned, droppedLog, outsideWindow, ghostsSubsampled, setPlotReadout]);
  useEffect(() => () => setPlotReadout(null), [setPlotReadout]);

  // ---- epoch-mode line hover: ghost run tooltip + mean-line tooltip --------
  // These builders feed PlotSurface's HTML tooltip (it owns hover state + the
  // pointer positioning). Ghost: layer name; fnText(arity,tt) · run_id; then up
  // to 4 "label: value" lines for parameters that vary within the layers
  // (varyingParams, capped).
  const ghostTooltipLines = (s: { runId: string; dims: string[] }): string[] => {
    const layer = seriesByKey.get(s.dims[0]);
    const row = rowByRunId.get(s.runId);
    const lines: string[] = [];
    if (layer) lines.push(layer.label);
    if (row) {
      lines.push(`${fnText(row.function.arity, row.function.truth_table)} · ${row.identity.run_id}`);
      for (const def of varyingParams.slice(0, 4)) {
        const v = def.raw(row);
        if (v !== null) lines.push(`${def.label}: ${def.display ? def.display(v) : v}`);
      }
    } else {
      lines.push(s.runId);
    }
    return lines;
  };

  // Mean line: layer name, run count (series rows length), judge when unique.
  const meanTooltipLines = (dims: string[]): string[] => {
    const layer = seriesByKey.get(dims[0]);
    if (!layer) return [];
    const lines = [layer.label, `${layer.rows.length} runs`];
    if (layer.judge) lines.push(`judge: ${layer.judge}`);
    return lines;
  };

  // ---- axis view window (zoom-only min/max; never touches FilterState) -------
  const setDomain = (axis: "x" | "y", d: [number, number] | null) =>
    setPlot(axis === "x" ? { xDomain: d } : { yDomain: d });

  // ---- export handle for the shared Export menu ----------------------------
  // CSV is the DATA export: the plotted selection at run grain via
  // lib/plot-export.plotDataCsv (raw underlying points, one row per layer
  // match; per (run, epoch) in epoch mode) — never the on-screen aggregates.
  useEffect(() => {
    if (!exportRef) return;
    const axes = { x: lineMode ? "epoch" : x, y };
    exportRef.current = {
      getSvg: () => svgRef.current,
      getCsv: () => ({
        csv: plotDataCsv(
          seriesList.map((s) => ({ layer: s.label, judge: s.judge, rows: s.rows })),
          axes,
          { view: "plot" },
        ),
        filename: plotCsvFilename("plot", axes),
      }),
    };
    return () => { exportRef.current = null; };
  }, [exportRef, seriesList, x, y, lineMode]);

  // Tick labels: category names on a categorical axis, else numeric (log ticks
  // un-transform, positions stay in log space). Handed to PlotSurface's scale.
  const xTickLabel = (t: number) =>
    catX ? (catX[Math.round(t)] ?? "") : logX ? tickFmt(Math.pow(10, t)) : tickFmt(t);
  const yTickLabel = (t: number) =>
    catY ? (catY[Math.round(t)] ?? "") : logY ? tickFmt(Math.pow(10, t)) : tickFmt(t);

  // Per-layer connecting lines across X — the averaged rendering: a layer
  // draws its mean trajectory only when it actually collapsed runs somewhere
  // (an all-n=1 layer stays a plain scatter, never spaghetti).
  const meanLines = useMemo(() => {
    const bySeries = new Map<string, SurfacePoint[]>();
    for (const p of visual) {
      const k = p.gp.dims.join(" ");
      const arr = bySeries.get(k) ?? [];
      arr.push(p);
      bySeries.set(k, arr);
    }
    return [...bySeries.values()].filter(
      (arr) => arr.length > 1 && arr.some((p) => p.gp.n > 1),
    );
  }, [visual]);

  const hasContent = lineMode ? !!(epoch && epoch.groups.length > 0) : visual.length > 0;

  return (
    <div className="flex-1 min-h-0 flex">
      {/* plot */}
      <div ref={plotRef} className="relative flex-1 min-w-0 px-2 py-1">
        {!hasContent ? (
          <div className="flex h-full items-center justify-center text-xs text-text-faint font-mono">
            {lineMode
              ? "No trajectories — the chosen metric has no per-epoch data on these runs."
              : droppedLog > 0
                ? "No plottable points — every value is ≤ 0 on a log axis."
                : "No plottable points — one of the chosen metrics is null on every filtered run."}
          </div>
        ) : (
          <PlotSurface
            mode={lineMode ? "epoch" : "scatter"}
            size={{ W, H, pad: PAD }}
            scale={{ sx: scale.sx, sy: scale.sy, xTicks: scale.xTicks, yTicks: scale.yTicks, xTickLabel, yTickLabel }}
            config={{ band: config.band, ghosts: config.ghosts, trend: config.trend, size: config.size, opacity: config.opacity }}
            logX={logX}
            logY={logY}
            points={visual}
            meanLines={meanLines}
            ghostPoints={ghostVisual}
            epoch={lineMode && epoch ? { ghostRuns: epoch.ghostRuns, groups: epoch.groups } : null}
            pairs={pairs}
            trendSeries={trendSeries}
            rowByRunId={rowByRunId}
            ghostTooltip={ghostTooltipLines}
            meanTooltip={meanTooltipLines}
            svgRef={svgRef}
            svgUnderlay={
              <>
                {/* axis labels — export-only: the live view renders the on-axis
                    pickers instead; svgToString un-hides [data-export-only] so
                    the standalone figure keeps plain labels */}
                <g data-export-only style={{ display: "none" }}>
                  <text x={(PAD.l + W - PAD.r) / 2} y={H - 8} fontSize={13} textAnchor="middle"
                    fill="var(--color-text-muted)">{(lineMode ? "epoch" : axisX?.label ?? x) + (logX ? " (log)" : "")}</text>
                  <text x={16} y={(PAD.t + H - PAD.b) / 2} fontSize={13} textAnchor="middle"
                    transform={`rotate(-90 16 ${(PAD.t + H - PAD.b) / 2})`}
                    fill="var(--color-text-muted)">{(axisY?.label ?? index[y]?.label ?? y) + (logY ? " (log)" : "")}</text>
                </g>
                {/* layers legend — export-only: the live legend lives in the
                    config panel's layers strip, which an SVG snapshot can't
                    capture */}
                {!colorByActive && (
                  <g data-export-only style={{ display: "none" }}>
                    {seriesList.filter((s) => s.rows.length > 0).slice(0, 14).map((s, i) => (
                      <g key={s.key}>
                        {shapeNode(shapeForValue(s.style.shape), PAD.l + 14, PAD.t + 15 + i * 15, 4, {
                          fill: s.color, fillOpacity: 0.8, stroke: s.color, strokeOpacity: 1,
                        })}
                        <text x={PAD.l + 24} y={PAD.t + 19 + i * 15} fontSize={11}
                          fill="var(--color-text-muted)" className="font-mono">{s.label}</text>
                      </g>
                    ))}
                    {seriesList.filter((s) => s.rows.length > 0).length > 14 && (
                      <text x={PAD.l + 24} y={PAD.t + 19 + 14 * 15} fontSize={11}
                        fill="var(--color-text-faint)" className="font-mono">
                        +{seriesList.filter((s) => s.rows.length > 0).length - 14} more
                      </text>
                    )}
                  </g>
                )}
              </>
            }
            svgOverlay={
              colorByActive && colorByExtent ? (() => {
                const barH = Math.min(96, Math.max(48, (H - PAD.t - PAD.b) * 0.32));
                const barW = 8;
                const bx = W - PAD.r - barW - 2;
                const by = PAD.t + 6;
                const steps = 24;
                const fmtC = (v: number) => (index[colorBy!] ? formatValue(index, colorBy!, v) : tickFmt(v));
                return (
                  <g>
                    {Array.from({ length: steps }, (_, i) => {
                      const t = i / (steps - 1);
                      return (
                        <rect key={`cb${i}`} x={bx} y={by + (1 - t) * barH - barH / steps}
                          width={barW} height={barH / steps + 0.6}
                          fill={gradientColor(t)} />
                      );
                    })}
                    <rect x={bx} y={by - barH / steps} width={barW} height={barH + barH / steps}
                      fill="none" stroke="var(--color-border)" strokeWidth={0.5} />
                    <text x={bx - 3} y={by + 3} fontSize={9} textAnchor="end"
                      fill="var(--color-text-faint)" className="font-mono">{fmtC(colorByExtent.hi)}</text>
                    <text x={bx - 3} y={by + barH} fontSize={9} textAnchor="end"
                      fill="var(--color-text-faint)" className="font-mono">{fmtC(colorByExtent.lo)}</text>
                    <text x={bx + barW + 3} y={by + barH / 2} fontSize={9} textAnchor="middle"
                      transform={`rotate(90 ${bx + barW + 3} ${by + barH / 2})`}
                      fill="var(--color-text-muted)" className="font-mono">{colorByLabel}</text>
                  </g>
                );
              })() : undefined
            }
          />
        )}

        {/* on-axis controls — the pickers ARE the axis labels (x under the x
            axis, y rotated along the y axis) and both log toggles hug the
            origin. HTML overlays on the plot container, rendered even when
            nothing is plottable so a dead metric can be picked away from. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0.5 z-10 flex justify-center">
          <div className="pointer-events-auto">
            <MetricPicker
              value={config.x}
              onChange={(v) => setPlot({ x: v })}
              schema={bundle.metric_schema}
              ariaLabel="x metric"
              order={X_GROUP_ORDER}
              placement="up"
              pinned={[{ value: "epoch", label: "epoch (training progress)" }]}
              params={paramAxisOptions()}
            />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-0.5 z-10 flex items-center">
          <div className="pointer-events-auto">
            <MetricPicker
              value={y}
              onChange={(v) => setPlot({ y: v })}
              schema={bundle.metric_schema}
              ariaLabel="y metric"
              order={Y_GROUP_ORDER}
              placement="right"
              vertical
              params={paramAxisOptions()}
            />
          </div>
        </div>
        <LogToggle
          checked={logX}
          onChange={(b) => setPlot({ logX: b })}
          ariaLabel="x log scale"
          style={{ left: PAD.l + 8, bottom: 4 }}
        />
        <LogToggle
          vertical
          checked={logY}
          onChange={(b) => setPlot({ logY: b })}
          ariaLabel="y log scale"
          style={{ left: 4, bottom: PAD.b + 8 }}
        />

        {/* axis view-window (zoom) min/max — click a number to edit, ⟲ resets.
            Never touches FilterState; clipped points stay in the table. */}
        <AxisRange
          axis="x"
          domain={xDomain}
          extent={dataExtent ? [dataExtent.xMin, dataExtent.xMax] : epoch?.rawExtent ? [epoch.rawExtent.xMin, epoch.rawExtent.xMax] : null}
          onSet={(d) => setDomain("x", d)}
          style={{ right: PAD.r + 6, bottom: 3 }}
        />
        <AxisRange
          axis="y"
          domain={yDomain}
          extent={dataExtent ? [dataExtent.yMin, dataExtent.yMax] : epoch?.rawExtent ? [epoch.rawExtent.yMin, epoch.rawExtent.yMax] : null}
          onSet={(d) => setDomain("y", d)}
          style={{ left: PAD.l + 4, top: 2 }}
        />
      </div>
    </div>
  );
}
// NOTE: the docked legend panel is gone — the config panel's layers strip IS
// the legend now (per-layer series, counts and resolution notes all render
// there, from the same resolveSeries result).

// A small absolutely-positioned log-scale checkbox. Both live by the plot's
// origin; the y one rotates vertical so it costs no horizontal padding.
function LogToggle({
  checked, onChange, ariaLabel, vertical = false, style,
}: {
  checked: boolean;
  onChange: (b: boolean) => void;
  ariaLabel: string;
  vertical?: boolean;
  style: React.CSSProperties;
}) {
  return (
    <label
      className={[
        "absolute z-10 inline-flex cursor-pointer items-center gap-1 text-[11px] text-text-muted hover:text-text",
        vertical ? "rotate-180" : "",
      ].join(" ")}
      style={vertical ? { ...style, writingMode: "vertical-rl" } : style}
    >
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      log
    </label>
  );
}

// The compact axis view-window editor (min / max) by each axis end now lives
// in components/axis-range.tsx (AxisRange) — shared with the Group Plot
// toolbar so the commit/format logic exists once.
