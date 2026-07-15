"use client";

// app/boolback/components/plot-panel.tsx — the Plot center view.
//
// A single scatter over the SAME filtered row set as the table (the filter
// bar stays above both views) that answers the campaign's real questions:
// "does outcome Y move with function-complexity X, and does the context
// moderate it?"
//
//   X / Y = any snapshot metric; the pickers live ON the axes (the x picker
//       under the x axis, the y picker rotated along the y axis) and both
//       log toggles hug the origin — all off the store-owned chart config.
//       Only the trend toggle stays in the SHARED top bar (filter-bar.tsx);
//       the r/ρ readout is published back to the bar via store.plotReadout
//       (ALWAYS computed over the underlying runs). The exported figure
//       keeps plain axis labels + a series legend via [data-export-only]
//       SVG groups.
//
// SERIES MODEL: the plotted rows are the UNION of the config's SETTINGS
// (named, styled parameter selections), resolved by
// lib/split-dims.resolveSeries — one series per (setting × splitBy combo),
// each with its own color (setting color, or CATEGORY_PALETTE under an
// active split) and shape (the first split dim's value ordinal). A run
// matching several settings is drawn once PER matching setting (duplication
// by design, surfaced as overlapCount — but the r/ρ/trend statistics dedupe
// by run so nothing double-weights).
//
// WITHIN-SERIES AVERAGING: points group per (series × X bucket) via
// lib/aggregate.groupRuns — exact X values up to 24 distinct, equal-width
// bins beyond. Averaging is simply the n>1 case: a group with n>1 renders as
// a mean point with ±SD whiskers (config.band), its series' groups connect
// across X, and the raw runs it collapsed draw behind as faint ghosts
// (config.ghosts). A group with n=1 stays an ordinary click-to-inspect run
// point. The parameters left varying inside groups are listed in the config
// panel's merged legend ("averaged: …").
//
// Hover a point for its series + values; click a single-run point to open
// its drawer. Drag a rectangle on the background to add PLOT-LEVEL X+Y range
// filters (store.addRange with settingId null — every setting ANDs them; the
// chart rescales to the filtered set, so this is also the zoom gesture). The
// row hovered or selected elsewhere (table/tree) is ring-highlighted here.
//
// Pure SVG — no chart library. Descriptive stats only (lib/stats.ts): the
// boundary rule says inferential statistics come from CMT, never the browser.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, RunRow, SettingStyle } from "../lib/types";
import { DEFAULT_PLOT, DEFAULT_SETTING_STYLE } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { applyFilters, numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import { X_GROUP_ORDER, Y_GROUP_ORDER, formatValue } from "../lib/metrics";
import { PARAMETERS } from "../lib/parameters";
import { resolveSeries } from "../lib/split-dims";
import { resolveAxis, isParamAxis, paramAxisOptions } from "../lib/axes";
import {
  groupRuns, collapsedGhosts,
  type GroupedPoint, type RunPoint, type Ghost,
} from "../lib/aggregate";
import { niceTicks, olsFit, pearson, spearman } from "../lib/stats";
import { buildRunSeries, groupSeries, trajectoryMetric, type RunSeries } from "../lib/trajectories";
import {
  SINGLE_COLOR, shapeForValue, dashForValue, opac, gradientColor, NULL_GRADIENT,
} from "../lib/styling";
import { toCsv } from "../lib/export";
import { fnText, hash01 } from "../lib/format";
import { MetricPicker } from "./metric-picker";
import { shapeNode } from "./glyph";

/** PARAMETERS lookup for resolveSeries (module-level: stable identity). */
const paramOf = (key: string) => PARAMETERS.find((p) => p.key === key) ?? null;

/** What the shared Export menu needs from the mounted plot. */
export interface PlotExportHandle {
  getSvg: () => SVGSVGElement | null;
  getCsv: () => string;
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
// ViewBox units of pointer travel before a background drag counts as a
// box-select (below it, the gesture stays a click).
const MIN_DRAG = 8;

function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

interface VisualPoint {
  gp: GroupedPoint;
  jx: number; // deterministic jitter (single points on a count/categorical x)
  jy: number; // deterministic jitter (single points on a categorical y)
  color: string;
  shapeIdx: number;
  r: number;
  /** The owning setting's style (opacity/dash multipliers at render). */
  style: SettingStyle;
  label: string[];
}

/** Dash pattern for a setting style (DASH_PATTERNS index; cycles). */
const dashOf = (style: SettingStyle): string => dashForValue(style.dash);

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
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
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
  const addRange = useBoolbackStore((s) => s.addRange);

  const [hover, setHover] = useState<VisualPoint | null>(null);
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
  // ---- continuous colorBy encoding (honored only on a single, unsplit setting)
  const colorBy = config.colorBy ?? null;
  const colorByActive =
    !!colorBy && !!index[colorBy] && config.settings.length === 1 && config.splitBy.length === 0;
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

  // ---- the series model (the config panel computes the SAME resolution) -----
  const resolution = useMemo(
    () => resolveSeries({
      rows,
      settings: config.settings,
      ranges: config.ranges,
      splitBy: config.splitBy,
      paramOf,
      applyTo: applyFilters,
    }),
    [rows, config.settings, config.ranges, config.splitBy],
  );
  const seriesList = resolution.series;
  const seriesByKey = useMemo(
    () => new Map(seriesList.map((s) => [s.key, s])),
    [seriesList],
  );
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
    points, pairs, ghosts, ghostsSubsampled, droppedLog, outsideWindow,
    binned, rowByPath, dataExtent,
  } = useMemo(() => {
    if (lineMode || !axisX || !axisY) {
      // Scatter path is inert in epoch mode — the epoch memo drives rendering.
      return {
        points: [], pairs: [], ghosts: [], ghostsSubsampled: false,
        droppedLog: 0, outsideWindow: 0, binned: false,
        rowByPath: new Map<string, RunRow>(), dataExtent: null,
      };
    }
    let dropped = 0;
    let outside = 0;
    const runPts: RunPoint[] = [];
    // Run-level pairs for r/ρ and the OLS trend, DEDUPED by run: a run drawn
    // once per matching setting must not double-weight the statistics.
    const rawPairs: Array<{ x: number; y: number }> = [];
    const seen = new Set<string>();
    const byPath = new Map<string, RunRow>();
    // Raw data extent over droppable-clean points (pre-window) for the axis controls.
    let exMinX = Infinity, exMaxX = -Infinity, exMinY = Infinity, exMaxY = -Infinity;
    // Setting-major series walk — a run matching several settings draws once
    // per matching series (duplication by design; surfaced as overlapCount).
    for (const s of seriesList) {
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
        byPath.set(id, r);
      }
    }
    // Group per (series × X bucket); n>1 groups ARE the averaging.
    const grouped = groupRuns(runPts, true);

    return {
      points: grouped.points,
      pairs: rawPairs,
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
    // Each run draws one trajectory PER MATCHING SETTING-SERIES (the same
    // per-setting duplication as the scatter), tagged with the series key.
    // Per-epoch values come from the SERIES' judge (its unique judge over its
    // rows); a series mixing judges falls back to the headline trajectory —
    // the legend's judgePooled warning already flags that setting.
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
        const k = s.dims.join("\u0000");
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

    // Ghost run-lines, colored by colorBy (continuous) or the run's series.
    const ghostCap = 500;
    const step = Math.max(1, Math.ceil(series.length / ghostCap));
    const ghostRuns: Array<{ color: string; op: number; pts: Array<{ x: number; y: number }> }> = [];
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
      ghostRuns.push({ color, op: (sSeries?.style ?? DEFAULT_SETTING_STYLE).opacity, pts });
    }

    // Group mean lines: color from colorBy mean (continuous) or the series;
    // dash/opacity come from the owning setting's style.
    const groupVis = groups.map((g) => {
      const gSeries = seriesByKey.get(g.dims[0]);
      const style = gSeries?.style ?? DEFAULT_SETTING_STYLE;
      const color = colorByActive
        ? colorForC(meanColorByOfDims.get(g.dims.join("\u0000")) ?? null)
        : gSeries?.color ?? SINGLE_COLOR;
      const pts: Array<{ x: number; y: number; sd: number | null; n: number }> = [];
      for (const p of g.points) {
        const x2 = txX(p.e);
        if (x2 !== null) pts.push({ x: x2, y: p.y, sd: p.sd, n: p.n });
      }
      return { dims: g.dims, color, dash: dashOf(style), style, runId: g.runId, pts };
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

  const visual: VisualPoint[] = useMemo(() => {
    const xL = axisX?.label ?? x;
    const yL = axisY?.label ?? y;
    const catX = axisX?.categorical ? axisX.categories : null;
    const catY = axisY?.categorical ? axisY.categories : null;
    const fmtX = (v: number) => (catX ? catX[Math.round(v)] ?? tickFmt(v) : tickFmt(v));
    const fmtY = (v: number) => (catY ? catY[Math.round(v)] ?? tickFmt(v) : tickFmt(v));
    return points.map((gp) => {
      const series = seriesByKey.get(gp.dims[0]);
      const style = series?.style ?? DEFAULT_SETTING_STYLE;
      const color = colorByActive ? colorForC(gp.c) : series?.color ?? SINGLE_COLOR;
      const shape = shapeForValue(series?.shapeIdx ?? 0);
      const r = (gp.n > 1 ? Math.min(10, 3 + Math.sqrt(gp.n)) : 3) * style.size;
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
        r,
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
    const ix = (px: number) => x0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    const iy = (py: number) => y0 + ((H - PAD.b - py) / (H - PAD.t - PAD.b)) * (y1 - y0);
    const intTicks = (n: number) => Array.from({ length: n }, (_, i) => i);
    return {
      sx, sy, ix, iy,
      xTicks: catX ? intTicks(catX.length) : niceTicks(x0, x1, 5),
      yTicks: catY ? intTicks(catY.length) : niceTicks(y0, y1, 5),
    };
  }, [visual, W, H, xDomain, yDomain, logX, logY, lineMode, epoch, catX, catY]);

  // Ghost points — the faint raw runs behind the collapsed group means
  // (config.ghosts; `ghosts` is pre-filtered to n>1 groups). Colored by
  // colorBy (continuous) or each run's series.
  const ghostVisual = useMemo(() => {
    if (!config.ghosts) return [] as Array<{ x: number; y: number; color: string; op: number }>;
    return ghosts.map((g: Ghost) => {
      const gSeries = seriesByKey.get(g.dims[0]);
      const color = colorByActive ? colorForC(g.c) : gSeries?.color ?? SINGLE_COLOR;
      return { x: g.x, y: g.y, color, op: (gSeries?.style ?? DEFAULT_SETTING_STYLE).opacity };
    });
  }, [ghosts, config.ghosts, seriesByKey, colorByActive, colorForC]);

  // Trend fit + the r/ρ readout — ALWAYS over the run-deduped underlying pairs
  // (a fit over group means would overstate the association; a run matching
  // two settings must not double-weight it). One global OLS line.
  const stats = useMemo(() => {
    if (pairs.length < 2) return null;
    const xs = pairs.map((p) => p.x);
    const ys = pairs.map((p) => p.y);
    const overall = { r: pearson(xs, ys), rho: spearman(xs, ys), n: pairs.length };
    if (!config.trend) return { overall, line: null };
    const fit = olsFit(xs, ys);
    const line = fit ? { fit, lo: Math.min(...xs), hi: Math.max(...xs) } : null;
    return { overall, line };
  }, [pairs, config.trend]);

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

  // ---- box-select (background drag -> PLOT-LEVEL X+Y range filters) ---------
  // Writes store.addRange("plot", null, …): the ranges AND onto every setting
  // (split-dims applies them per setting), and the chart rescales to the
  // filtered set — so the drag doubles as the zoom gesture. Numeric scatter
  // axes only (an ordinal or epoch range filter would be meaningless).
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragMoved = useRef(false);
  const canDrag = !lineMode && !!axisX && !!axisY && !axisX.categorical && !axisY.categorical;

  const onPointClick = (p: VisualPoint) => {
    if (dragMoved.current) return; // a box-select drag just ended
    if (p.gp.runId && p.gp.n === 1) {
      openDetail(p.gp.runId);
      const r = rowByPath.get(p.gp.runId);
      if (r) expandChain(r.identity.chain_dirs);
    }
  };

  // ---- axis view window (zoom-only min/max; never touches FilterState) -------
  const setDomain = (axis: "x" | "y", d: [number, number] | null) =>
    setPlot(axis === "x" ? { xDomain: d } : { yDomain: d });

  const toViewBox = (e: React.PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };
  const onSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!canDrag || e.button !== 0) return;
    if ((e.target as Element).tagName === "circle") return; // point clicks stay point clicks
    const p = toViewBox(e);
    if (!p || p.x < PAD.l || p.x > W - PAD.r || p.y < PAD.t || p.y > H - PAD.b) return;
    dragMoved.current = false;
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = toViewBox(e);
    if (!p) return;
    if (Math.abs(p.x - drag.x0) > MIN_DRAG || Math.abs(p.y - drag.y0) > MIN_DRAG) {
      dragMoved.current = true;
    }
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const onSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const d = drag;
    setDrag(null);
    if (!dragMoved.current || !axisX || !axisY) return;
    // Invert pixel rect -> transformed values -> raw metric values.
    const untX = (v: number) => (logX ? Math.pow(10, v) : v);
    const untY = (v: number) => (logY ? Math.pow(10, v) : v);
    const vx = [scale.ix(Math.min(d.x0, d.x1)), scale.ix(Math.max(d.x0, d.x1))];
    const vy = [scale.iy(Math.max(d.y0, d.y1)), scale.iy(Math.min(d.y0, d.y1))]; // sy inverts
    addRange("plot", null, { metric: axisX.name, min: untX(vx[0]), max: untX(vx[1]) });
    addRange("plot", null, { metric: axisY.name, min: untY(vy[0]), max: untY(vy[1]) });
    // Let the click that follows pointerup on a point be ignored, then reset.
    setTimeout(() => { dragMoved.current = false; }, 0);
  };

  // ---- export handle for the shared Export menu ----------------------------
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = {
      getSvg: () => svgRef.current,
      getCsv: () => {
        const xL = `${axisX?.label ?? x}${logX ? " (log10)" : ""}`;
        const yL = `${axisY?.label ?? y}${logY ? " (log10)" : ""}`;
        const seriesLabel = (dims: string[]) => seriesByKey.get(dims[0])?.label ?? dims[0] ?? "";
        if (lineMode && epoch) {
          const head = ["epoch", "series", "n", `${yL} (mean)`, `${yL} (sd)`];
          const body = epoch.groups.flatMap((g) =>
            g.pts.map((p) => [logX ? Math.round(Math.pow(10, p.x)) : p.x, seriesLabel(g.dims), p.n, p.y, p.sd ?? ""]),
          );
          return toCsv([head, ...body]);
        }
        if (collapsed) {
          const head = [xL, "series", "n", `${yL} (mean)`, `${yL} (sd)`];
          return toCsv([head, ...points.map((p) => [p.x, seriesLabel(p.dims), p.n, p.y, p.sdY ?? ""])]);
        }
        const head = ["run_id", xL, yL, "series"];
        return toCsv([head, ...points.map((p) => [p.runId ?? "", p.x, p.y, seriesLabel(p.dims)])]);
      },
    };
    return () => { exportRef.current = null; };
  }, [exportRef, points, x, y, axisX, axisY, logX, logY, seriesByKey, collapsed, lineMode, epoch]);

  // The point linked to the row hovered/selected elsewhere (table / tree).
  const linked = useMemo(
    () => visual.filter((p) => p.gp.runId !== undefined && (p.gp.runId === selectedDir || p.gp.runId === hoveredDir)),
    [visual, hoveredDir, selectedDir],
  );

  // Tick labels: category names on a categorical axis, else numeric (log ticks
  // un-transform, positions stay in log space).
  const xTickLabel = (t: number) =>
    catX ? (catX[Math.round(t)] ?? "") : logX ? tickFmt(Math.pow(10, t)) : tickFmt(t);
  const yTickLabel = (t: number) =>
    catY ? (catY[Math.round(t)] ?? "") : logY ? tickFmt(Math.pow(10, t)) : tickFmt(t);

  // Per-series connecting lines across X — the averaged rendering: a series
  // draws its mean trajectory only when it actually collapsed runs somewhere
  // (an all-n=1 series stays a plain scatter, never spaghetti).
  const meanLines = useMemo(() => {
    const bySeries = new Map<string, VisualPoint[]>();
    for (const p of visual) {
      const k = p.gp.dims.join("\u0000");
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
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full select-none"
            role="img"
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
          >
            <defs>
              <clipPath id="bb-plot-clip">
                <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} />
              </clipPath>
            </defs>
            <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b}
              fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={1}>
              {canDrag && <title>drag a box to filter to that X/Y range</title>}
            </rect>
            {scale.yTicks.map((t, i) => (
              <g key={`y${i}`}>
                <line x1={PAD.l} y1={scale.sy(t)} x2={W - PAD.r} y2={scale.sy(t)}
                  stroke="var(--color-border)" strokeOpacity={0.5} strokeWidth={0.5} />
                <text x={PAD.l - 6} y={scale.sy(t) + 4} fontSize={12} textAnchor="end"
                  fill="var(--color-text-faint)" className="font-mono">{yTickLabel(t)}</text>
              </g>
            ))}
            {scale.xTicks.map((t, i) => (
              <g key={`x${i}`}>
                <line x1={scale.sx(t)} y1={PAD.t} x2={scale.sx(t)} y2={H - PAD.b}
                  stroke="var(--color-border)" strokeOpacity={0.35} strokeWidth={0.5} />
                <text x={scale.sx(t)} y={H - PAD.b + 16} fontSize={12} textAnchor="middle"
                  fill="var(--color-text-faint)" className="font-mono">{xTickLabel(t)}</text>
              </g>
            ))}
            {/* axis labels — export-only: the live view renders the on-axis
                pickers instead; svgToString un-hides [data-export-only] so the
                standalone figure keeps plain labels */}
            <g data-export-only style={{ display: "none" }}>
              <text x={(PAD.l + W - PAD.r) / 2} y={H - 8} fontSize={13} textAnchor="middle"
                fill="var(--color-text-muted)">{(lineMode ? "epoch" : axisX?.label ?? x) + (logX ? " (log)" : "")}</text>
              <text x={16} y={(PAD.t + H - PAD.b) / 2} fontSize={13} textAnchor="middle"
                transform={`rotate(-90 16 ${(PAD.t + H - PAD.b) / 2})`}
                fill="var(--color-text-muted)">{(axisY?.label ?? index[y]?.label ?? y) + (logY ? " (log)" : "")}</text>
            </g>
            {/* series legend — export-only: the live legend lives in the config
                panel's settings strip, which an SVG snapshot cannot capture */}
            {!colorByActive && (
              <g data-export-only style={{ display: "none" }}>
                {seriesList.filter((s) => s.rows.length > 0).slice(0, 14).map((s, i) => (
                  <g key={s.key}>
                    {shapeNode(shapeForValue(s.shapeIdx), PAD.l + 14, PAD.t + 15 + i * 15, 4, {
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

            {/* epoch trajectories: ghost run-lines, group ±SD ribbons, mean lines */}
            {lineMode && epoch && (
              <g clipPath="url(#bb-plot-clip)">
                {config.ghosts && epoch.ghostRuns.map((s, i) => (
                  s.pts.length > 1 && (
                    <polyline
                      key={`gl${i}`}
                      points={s.pts.map((p) => `${scale.sx(p.x)},${scale.sy(p.y)}`).join(" ")}
                      fill="none" stroke={s.color} strokeWidth={1} strokeOpacity={opac(0.12, s.op)}
                      pointerEvents="none"
                    />
                  )
                ))}
                {config.band && epoch.groups.map((g, i) => {
                  const withSd = g.pts.filter((p) => p.sd !== null && p.sd > 0);
                  if (withSd.length < 2) return null;
                  const up = withSd.map((p) => `${scale.sx(p.x)},${scale.sy(p.y + (p.sd ?? 0))}`);
                  const dn = withSd.slice().reverse().map((p) => `${scale.sx(p.x)},${scale.sy(p.y - (p.sd ?? 0))}`);
                  return (
                    <polygon key={`rb${i}`} points={[...up, ...dn].join(" ")} fill={g.color} fillOpacity={opac(0.1, g.style.opacity)} stroke="none" pointerEvents="none" />
                  );
                })}
                {epoch.groups.map((g, i) => (
                  g.pts.length > 1 && (
                    <polyline
                      key={`ml${i}`}
                      points={g.pts.map((p) => `${scale.sx(p.x)},${scale.sy(p.y)}`).join(" ")}
                      fill="none" stroke={g.color} strokeWidth={1.75 * g.style.size} strokeOpacity={opac(0.95, g.style.opacity)}
                      strokeDasharray={g.dash || undefined}
                      pointerEvents="none"
                    />
                  )
                ))}
                {/* vertices — hover title + click-through for single-run groups */}
                {epoch.groups.map((g) =>
                  g.pts.map((p, j) => (
                    <circle
                      key={`${g.dims.join(",")}-${j}`}
                      cx={scale.sx(p.x)} cy={scale.sy(p.y)} r={2.4 * g.style.size}
                      fill={g.color} fillOpacity={opac(0.9, g.style.opacity)}
                      className={g.runId ? "cursor-pointer" : undefined}
                      onClick={g.runId ? () => { openDetail(g.runId!); const r = bundle.rows.find((x2) => x2.identity.node_path === g.runId); if (r) expandChain(r.identity.chain_dirs); } : undefined}
                    >
                      <title>{`${g.dims.length ? (seriesByKey.get(g.dims[0])?.label ?? g.dims[0]) + " · " : ""}epoch ${logX ? Math.round(Math.pow(10, p.x)) : p.x}: ${tickFmt(logY ? Math.pow(10, p.y) : p.y)}${p.sd !== null && p.sd > 0 ? ` ± ${tickFmt(p.sd)}` : ""}${p.n > 1 ? ` (n=${p.n})` : ""}`}</title>
                    </circle>
                  )),
                )}
              </g>
            )}

            {/* per-series connecting lines (collapsed series; under points) */}
            {meanLines.length > 0 && (
              <g clipPath="url(#bb-plot-clip)">
                {meanLines.map((line, i) => (
                  <path
                    key={i}
                    d={line.map((p, j) => `${j === 0 ? "M" : "L"}${scale.sx(p.gp.x)},${scale.sy(p.gp.y)}`).join(" ")}
                    fill="none" stroke={line[0].color} strokeWidth={1.5 * line[0].style.size}
                    strokeOpacity={opac(0.85, line[0].style.opacity)}
                    strokeDasharray={dashOf(line[0].style) || undefined}
                    pointerEvents="none"
                  />
                ))}
              </g>
            )}

            {/* ghost points — faint raw runs behind the collapsed group means */}
            {ghostVisual.length > 0 && (
              <g clipPath="url(#bb-plot-clip)">
                {ghostVisual.map((g, i) => (
                  <circle
                    key={`g${i}`}
                    cx={scale.sx(g.x)}
                    cy={scale.sy(g.y)}
                    r={1.4}
                    fill={g.color}
                    fillOpacity={opac(0.18, g.op)}
                    pointerEvents="none"
                  />
                ))}
              </g>
            )}

            {/* ±1 SD whiskers (n>1 groups only — sd is null on singles) */}
            {config.band && (
              <g clipPath="url(#bb-plot-clip)">
                {visual.map((p, i) => (
                  <g key={`w${i}`} stroke={p.color} strokeOpacity={opac(0.5, p.style.opacity)} strokeWidth={1}>
                    {p.gp.sdY !== null && p.gp.sdY > 0 && (
                      <line x1={scale.sx(p.gp.x)} y1={scale.sy(p.gp.y - p.gp.sdY)} x2={scale.sx(p.gp.x)} y2={scale.sy(p.gp.y + p.gp.sdY)} />
                    )}
                    {p.gp.sdX !== null && p.gp.sdX > 0 && (
                      <line x1={scale.sx(p.gp.x - p.gp.sdX)} y1={scale.sy(p.gp.y)} x2={scale.sx(p.gp.x + p.gp.sdX)} y2={scale.sy(p.gp.y)} />
                    )}
                  </g>
                ))}
              </g>
            )}

            {/* visible points */}
            <g>
              {visual.map((p, i) => (
                <g key={i}>
                  {shapeNode(p.shapeIdx, scale.sx(p.gp.x + p.jx), scale.sy(p.gp.y + p.jy), p.r, {
                    fill: p.color, fillOpacity: opac(0.6, p.style.opacity),
                    stroke: p.color, strokeOpacity: opac(0.9, p.style.opacity),
                  })}
                </g>
              ))}
            </g>

            {/* linked-row highlight rings (row hovered/selected in table or tree) */}
            {linked.map((p, i) => (
              <circle
                key={`h${i}`}
                cx={scale.sx(p.gp.x + p.jx)}
                cy={scale.sy(p.gp.y + p.jy)}
                r={p.r + 3}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            ))}

            {/* one overall OLS trend line (over the run-deduped underlying pairs) */}
            {stats?.line && (
              <g clipPath="url(#bb-plot-clip)">
                <line
                  x1={scale.sx(stats.line.lo)}
                  y1={scale.sy(stats.line.fit.intercept + stats.line.fit.slope * stats.line.lo)}
                  x2={scale.sx(stats.line.hi)}
                  y2={scale.sy(stats.line.fit.intercept + stats.line.fit.slope * stats.line.hi)}
                  stroke="var(--color-text-muted)"
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  strokeOpacity={0.9}
                  pointerEvents="none"
                />
              </g>
            )}

            {/* invisible hit targets (on top; generous radius) */}
            <g>
              {visual.map((p, i) => (
                <circle
                  key={`t${i}`}
                  cx={scale.sx(p.gp.x + p.jx)}
                  cy={scale.sy(p.gp.y + p.jy)}
                  r={Math.max(9, p.r + 5)}
                  fill="transparent"
                  className={p.gp.n === 1 ? "cursor-pointer" : undefined}
                  onMouseEnter={() => setHover(p)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onPointClick(p)}
                />
              ))}
            </g>

            {/* box-select rubber band (drag in progress) */}
            {drag && dragMoved.current && (
              <rect
                x={Math.min(drag.x0, drag.x1)}
                y={Math.min(drag.y0, drag.y1)}
                width={Math.abs(drag.x1 - drag.x0)}
                height={Math.abs(drag.y1 - drag.y0)}
                fill="var(--color-accent)"
                fillOpacity={0.08}
                stroke="var(--color-accent)"
                strokeWidth={1}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}

            {/* continuous colorBy colorbar (replaces a categorical color legend) */}
            {colorByActive && colorByExtent && (() => {
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
            })()}
          </svg>
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

        {/* tooltip (flips sides near the right edge) */}
        {hover && (() => {
          const px = scale.sx(hover.gp.x + hover.jx);
          const py = scale.sy(hover.gp.y + hover.jy);
          const flip = px > W * 0.62;
          return (
            <div
              className="pointer-events-none absolute z-20 max-w-96 rounded-md border border-border bg-surface-alt px-2 py-1 font-mono text-xs text-text shadow-lg"
              style={{
                left: `calc(${(px / W) * 100}% + ${flip ? -12 : 12}px)`,
                top: `${(py / H) * 100}%`,
                transform: flip ? "translateX(-100%)" : undefined,
              }}
            >
              {hover.label.map((l, i) => (
                <div key={i} className={i === 0 ? "text-text-muted truncate" : ""}>{l}</div>
              ))}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
// NOTE: the docked legend panel is gone — the config panel's settings strip
// IS the legend now (per-setting split series, counts and resolution notes
// all render there, from the same resolveSeries result).

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

// A compact axis view-window editor (min / max) by an axis end. Click a number
// to edit (Enter commits, Esc/blur cancels); ⟲ clears the zoom. Purely a view
// window — points outside stay in the table and filters (chart-panel clips them
// and surfaces "N outside window" in the readout).
function AxisRange({
  axis, domain, extent, onSet, style,
}: {
  axis: "x" | "y";
  domain: [number, number] | null;
  extent: [number, number] | null;
  onSet: (d: [number, number] | null) => void;
  style: React.CSSProperties;
}) {
  const [edit, setEdit] = useState<null | 0 | 1>(null);
  const lo = domain?.[0] ?? extent?.[0];
  const hi = domain?.[1] ?? extent?.[1];
  if (lo === undefined || hi === undefined) return null;

  const commit = (which: 0 | 1, raw: string) => {
    setEdit(null);
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v)) return;
    const next: [number, number] = which === 0 ? [v, hi] : [lo, v];
    if (next[0] < next[1]) onSet(next);
  };
  const fmt = (n: number) =>
    Math.abs(n) >= 1000 || (n !== 0 && Math.abs(n) < 0.01)
      ? n.toExponential(1)
      : String(Number(n.toFixed(3)));

  const Field = (which: 0 | 1, value: number) =>
    edit === which ? (
      <input
        autoFocus
        type="number"
        defaultValue={value}
        aria-label={`${axis} ${which === 0 ? "min" : "max"}`}
        onBlur={(e) => commit(which, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(which, (e.target as HTMLInputElement).value);
          else if (e.key === "Escape") setEdit(null);
        }}
        className="w-16 rounded border border-accent/50 bg-surface px-1 text-sm text-text tabular-nums focus:outline-none"
      />
    ) : (
      <button
        type="button"
        onClick={() => setEdit(which)}
        title={`edit ${axis} ${which === 0 ? "min" : "max"} (zoom only)`}
        className="tabular-nums hover:text-accent"
      >
        {fmt(value)}
      </button>
    );

  return (
    <div
      className="pointer-events-auto absolute z-10 flex items-center gap-0.5 rounded bg-surface/70 px-1 text-sm text-text-faint"
      style={style}
    >
      {Field(0, lo)}
      <span aria-hidden>–</span>
      {Field(1, hi)}
      {domain && (
        <button
          type="button"
          onClick={() => onSet(null)}
          title="reset zoom to fit"
          aria-label={`reset ${axis} zoom`}
          className="ml-0.5 hover:text-accent"
        >
          ⟲
        </button>
      )}
    </div>
  );
}
