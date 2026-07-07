"use client";

// app/boolback/components/chart-panel.tsx — the Chart center view.
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
//       the r/ρ readout is published back to the bar via store.chartReadout
//       (ALWAYS computed over the underlying runs). The exported figure
//       keeps plain axis labels via a [data-export-only] SVG group.
//
// THE LEGEND PANEL (docked right of the plot; replaces the old top dims
// strip + bottom legend): every run dimension (function, model, arity,
// seed, …) is either SHARED across the filtered view (the points' common
// context) or DIFFERING. Each differing dimension is
//
//   split onto a visual channel — color / shape / size — so its values are
//     distinguishable point-by-point;
//   filtered via the chip's CHECKBOX list — the same multi-select editor as
//     the bar's facet chips, emitting ORDINARY filter state (one filter
//     mechanism, shared with the table); or
//   averaged — collapsed into mean ± 1 SD groups (whiskers, n-sized points,
//     per-group connecting lines across X).
//
// Auto-assignment: biggest split first onto color → shape → size (legibility
// caps in lib/dimensions); everything left is averaged. Chip menus override
// per dimension. Points group by (split values × X bucket) so averaging never
// smears across X; a continuous X falls back to equal-width bins.
//
// Hover a point for its identity + values; click a single-run point to open
// its drawer. Drag a rectangle on the background to add X+Y range filters
// (which also zooms, since the chart rescales to the filtered set). The row
// hovered or selected elsewhere (table/tree) is ring-highlighted here.
//
// Pure SVG — no chart library. Descriptive stats only (lib/stats.ts): the
// boundary rule says inferential statistics come from CMT, never the browser.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, Channel, DimTreatment, RunRow, ValueStyle } from "../lib/types";
import { DEFAULT_CHART } from "../lib/types";
import { DimensionBoard } from "./dimension-board";
import { useBoolbackStore } from "../state/store";
import { numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import { X_GROUP_ORDER, Y_GROUP_ORDER } from "../lib/metrics";
import {
  resolveChannels, summarizeDimensions,
  type DimensionDef, type DimValues,
} from "../lib/dimensions";
import {
  groupRuns, groupKeyFor, makeXBucketer, splitWorthiness,
  type GroupedPoint, type RunPoint, type Ghost, type WorthinessRun,
} from "../lib/aggregate";
import { niceTicks, olsFit, pearson, spearman } from "../lib/stats";
import { buildRunSeries, groupSeries, trajectoryMetric } from "../lib/trajectories";
import { PALETTE, SINGLE_COLOR, colorForValue, shapeForValue, dashForValue } from "../lib/styling";
import { toCsv } from "../lib/export";
import { fnText, hash01 } from "../lib/format";
import { MetricPicker } from "./metric-picker";
import { shapeNode } from "./glyph";

/** What the shared Export menu needs from the mounted chart. */
export interface ChartExportHandle {
  getSvg: () => SVGSVGElement | null;
  getCsv: () => string;
}

/** Guard a persisted/shared metric name whose metric no longer exists in the
 *  schema (also used by the top bar's axis pickers so both agree). */
export function effectiveAxis(
  name: string,
  index: MetricIndex,
  schema: Bundle["metric_schema"],
  fallback: string,
): string {
  return index[name] ? name : fallback in index ? fallback : (schema[0]?.name ?? "");
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

interface VisualPoint {
  gp: GroupedPoint;
  jx: number; // deterministic jitter (single-run points on a count x-axis)
  color: string;
  shapeIdx: number;
  r: number;
  label: string[];
}

export function ChartBody({
  rows,
  bundle,
  index,
  exportRef,
}: {
  rows: RunRow[]; // the filtered (+sorted) rows — chart and table always agree
  bundle: Bundle;
  index: MetricIndex;
  exportRef?: React.MutableRefObject<ChartExportHandle | null>;
}) {
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const toggleSubtreeDir = useBoolbackStore((s) => s.toggleSubtreeDir);
  const removeSubtreeDir = useBoolbackStore((s) => s.removeSubtreeDir);
  const addSubtreeDir = useBoolbackStore((s) => s.addSubtreeDir);
  const setFacet = useBoolbackStore((s) => s.setFacet);
  const toggleFacetValue = useBoolbackStore((s) => s.toggleFacetValue);
  const filters = useBoolbackStore((s) => s.filters);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const config = useBoolbackStore((s) => s.chart);
  const setChart = useBoolbackStore((s) => s.setChart);
  const setChartReadout = useBoolbackStore((s) => s.setChartReadout);

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
  const x = lineMode ? "epoch" : effectiveAxis(config.x, index, bundle.metric_schema, DEFAULT_CHART.x);
  const y = lineMode
    ? (trajectoryMetric(config.y) ?? "plantedness")
    : effectiveAxis(config.y, index, bundle.metric_schema, DEFAULT_CHART.y);
  const logX = !!config.logX;
  const logY = !!config.logY;
  // Persist the Y snap so the config stays consistent after entering epoch mode.
  useEffect(() => {
    if (lineMode && config.y !== y) setChart({ y });
  }, [lineMode, config.y, y, setChart]);
  // The active judge for per-epoch resolution: a single selected judge, else
  // the headline (primary-judge) trajectory.
  const activeJudge = useMemo(() => {
    const j = filters.facets?.judge;
    return j && j.length === 1 ? j[0] : null;
  }, [filters.facets]);
  const splits = useMemo(() => config.splits ?? [], [config.splits]);
  const channelOverrides = useMemo(() => config.channels ?? {}, [config.channels]);
  const valueStyles = useMemo(() => config.valueStyles ?? {}, [config.valueStyles]);

  // ---- the dimension model over the filtered rows ---------------------------
  const summary = useMemo(() => summarizeDimensions(rows), [rows]);
  const differingByKey = useMemo(() => {
    const m = new Map<string, DimValues>();
    for (const d of summary.differing) m.set(d.dim.key, d);
    return m;
  }, [summary]);
  // Only user-chosen splits that actually differ in the current view get a channel.
  const activeSplits = useMemo(
    () => splits.filter((k) => differingByKey.has(k)),
    [splits, differingByKey],
  );
  const channelByDim = useMemo(
    () => resolveChannels(activeSplits, channelOverrides, (k) => differingByKey.get(k)?.values.length ?? 0),
    [activeSplits, channelOverrides, differingByKey],
  );
  const channelDims = useMemo(() => {
    const byChannel = new Map<Channel, DimValues>();
    for (const d of summary.differing) {
      const ch = channelByDim.get(d.dim.key);
      if (ch) byChannel.set(ch, d);
    }
    return byChannel;
  }, [summary, channelByDim]);
  const colorDim = channelDims.get("color");
  const shapeDim = channelDims.get("shape");
  const sizeDim = channelDims.get("size");
  // Split dims in channel order (color, shape, size, dash) — RunPoint.dims order.
  const splitDims = useMemo(() => {
    const order: Channel[] = ["color", "shape", "size", "dash"];
    return order.map((ch) => channelDims.get(ch)).filter((d): d is DimValues => d !== undefined);
  }, [channelDims]);
  // Any differing dimension the user did NOT split is averaged (visible spread).
  const averaging = useMemo(
    () => summary.differing.some((d) => !channelByDim.has(d.dim.key)),
    [summary, channelByDim],
  );

  // value -> ordinal per channel dim (values are pre-sorted in DimValues).
  const valueIndex = (d: DimValues | undefined) => {
    const m = new Map<string, number>();
    d?.values.forEach((v, i) => m.set(v.value, i));
    return m;
  };
  const colorIdx = useMemo(() => valueIndex(colorDim), [colorDim]);
  const shapeIdx = useMemo(() => valueIndex(shapeDim), [shapeDim]);
  const sizeIdx = useMemo(() => valueIndex(sizeDim), [sizeDim]);

  // function display text -> function hash (fn= scope chips from the legend).
  // Built over ALL rows so the legend's checkbox editors can resolve values
  // the current filters exclude.
  const fnHashByText = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of bundle.rows) {
      m.set(fnText(r.function.arity, r.function.truth_table), r.identity.function_hash);
    }
    return m;
  }, [bundle.rows]);

  // Rows in subtree scope — the same base the filter bar's facet editors use.
  // The legend's checkbox lists draw candidate values from here rather than
  // the filtered rows, so checking one value doesn't collapse the list to
  // just itself.
  const scopedRows = useMemo(() => {
    const dirs = filters.subtreeDirs ?? [];
    if (dirs.length === 0) return bundle.rows;
    return bundle.rows.filter((r) => dirs.some((d) => r.identity.chain_dirs.includes(d)));
  }, [bundle.rows, filters.subtreeDirs]);

  // For the function dimension the top-level fn= scope chips ARE its filter,
  // so its candidate list ignores them (deeper subtree chips still scope).
  const fnScopeRows = useMemo(() => {
    const dirs = (filters.subtreeDirs ?? []).filter((d) => !/^fn=[^/]+$/.test(d));
    if (dirs.length === 0) return bundle.rows;
    return bundle.rows.filter((r) => dirs.some((d) => r.identity.chain_dirs.includes(d)));
  }, [bundle.rows, filters.subtreeDirs]);

  // Axis view windows (zoom only; never touch FilterState) in RAW metric units.
  const xDomain = config.xDomain ?? null;
  const yDomain = config.yDomain ?? null;

  // ---- points ---------------------------------------------------------------
  // Averaged dims (any differing dim not split) — shown in the board in either
  // mode, so it lives outside the scatter-only points memo.
  const averagedDims = useMemo(
    () => summary.differing.filter((d) => !channelByDim.has(d.dim.key)).map((d) => d.dim),
    [summary, channelByDim],
  );

  const {
    points, pairs, ghosts, ghostsSubsampled, droppedLog, outsideWindow,
    binned, rowByPath, dataExtent, worthiness,
  } = useMemo(() => {
    if (lineMode) {
      // Scatter path is inert in epoch mode — the epoch memo drives rendering.
      return {
        points: [], pairs: [], ghosts: [], ghostsSubsampled: false,
        droppedLog: 0, outsideWindow: 0, binned: false,
        rowByPath: new Map<string, RunRow>(), dataExtent: null,
        worthiness: {} as Record<string, number>,
      };
    }
    const xId = metricColumnId(x, index);
    const yId = metricColumnId(y, index);
    let dropped = 0;
    let outside = 0;
    const runPts: RunPoint[] = [];
    // Underlying (run-level) pairs for r/ρ and the OLS fits, with the color value.
    const rawPairs: Array<{ x: number; y: number; color: string | null }> = [];
    const byPath = new Map<string, RunRow>();
    // Raw data extent over droppable-clean points (pre-window) for the axis controls.
    let exMinX = Infinity, exMaxX = -Infinity, exMinY = Infinity, exMaxY = -Infinity;
    // Windowed survivors kept with their row for split-worthiness.
    const survivors: Array<{ r: RunRow; tx: number; ty: number; dims: string[] }> = [];
    for (const r of rows) {
      const vx = numericValue(r, xId);
      const vy = numericValue(r, yId);
      if (vx === null || vy === null) continue;
      if ((logX && vx <= 0) || (logY && vy <= 0)) { dropped++; continue; }
      if (vx < exMinX) exMinX = vx;
      if (vx > exMaxX) exMaxX = vx;
      if (vy < exMinY) exMinY = vy;
      if (vy > exMaxY) exMaxY = vy;
      // View-window clip: outside the zoom stays in the table/filters, just not drawn.
      if ((xDomain && (vx < xDomain[0] || vx > xDomain[1])) ||
          (yDomain && (vy < yDomain[0] || vy > yDomain[1]))) {
        outside++;
        continue;
      }
      const tx = logX ? Math.log10(vx) : vx;
      const ty = logY ? Math.log10(vy) : vy;
      const dims = splitDims.map((d) => d.dim.raw(r) ?? "—");
      runPts.push({ x: tx, y: ty, runId: r.identity.node_path, dims });
      rawPairs.push({ x: tx, y: ty, color: colorDim ? colorDim.dim.raw(r) : null });
      byPath.set(r.identity.node_path, r);
      survivors.push({ r, tx, ty, dims });
    }
    const grouped = groupRuns(runPts, averaging);

    // Split-worthiness of each averaged dim, over the WINDOWED survivors, using
    // the same (split tuple × x bucket) grouping the renderer applies.
    const avgDims = summary.differing
      .filter((d) => !channelByDim.has(d.dim.key))
      .map((d) => d.dim);
    let worth: Record<string, number> = {};
    if (avgDims.length > 0 && survivors.length > 0) {
      const { key: bucket } = makeXBucketer(runPts);
      const wRuns: WorthinessRun[] = survivors.map((s) => ({
        y: s.ty,
        group: groupKeyFor(s.dims, s.tx, bucket),
        values: Object.fromEntries(avgDims.map((d) => [d.key, d.raw(s.r) ?? "—"])),
      }));
      worth = splitWorthiness(wRuns, avgDims.map((d) => d.key));
    }

    return {
      points: grouped.points,
      pairs: rawPairs,
      ghosts: grouped.ghosts,
      ghostsSubsampled: grouped.ghostsSubsampled,
      droppedLog: dropped,
      outsideWindow: outside,
      binned: grouped.binned,
      rowByPath: byPath,
      dataExtent: Number.isFinite(exMinX)
        ? { xMin: exMinX, xMax: exMaxX, yMin: exMinY, yMax: exMaxY }
        : null,
      worthiness: worth,
    };
  }, [lineMode, rows, x, y, index, logX, logY, splitDims, colorDim, averaging, xDomain, yDomain, summary, channelByDim]);

  // ---- epoch trajectories (line mode) ---------------------------------------
  const epoch = useMemo(() => {
    if (!lineMode) return null;
    const metric = trajectoryMetric(y);
    if (!metric) return null;
    const dimsOf = (r: RunRow) => splitDims.map((d) => d.dim.raw(r) ?? "—");
    const { series, dropped: droppedY } = buildRunSeries(rows, metric, dimsOf, activeJudge, logY);
    const groups = groupSeries(series);

    // x transform (logX drops epoch ≤ 0); count as "dropped (log)".
    let droppedX = 0;
    const txX = (e: number): number | null => {
      if (!logX) return e;
      if (e <= 0) { droppedX++; return null; }
      return Math.log10(e);
    };

    // Ghost run-lines, colored by the color-dim value, subsampled for perf.
    const ci = colorDim ? splitDims.indexOf(colorDim) : -1;
    const ghostCap = 500;
    const step = Math.max(1, Math.ceil(series.length / ghostCap));
    const ghostRuns: Array<{ color: string; pts: Array<{ x: number; y: number }> }> = [];
    for (let i = 0; i < series.length; i += step) {
      const s = series[i];
      const cv = ci >= 0 ? s.dims[ci] : "";
      const color = colorDim ? colorForValue(colorDim.dim.key, cv, colorIdx.get(cv) ?? 0, valueStyles) : SINGLE_COLOR;
      const pts: Array<{ x: number; y: number }> = [];
      for (const p of s.points) {
        const x2 = txX(p.e);
        if (x2 !== null) pts.push({ x: x2, y: p.y });
      }
      ghostRuns.push({ color, pts });
    }

    // Group mean lines: color from the color dim, dash from the shape dim
    // (splits[1] → dash in line mode; shape glyphs are meaningless on a line).
    const di = shapeDim ? splitDims.indexOf(shapeDim) : -1;
    const groupVis = groups.map((g) => {
      const cv = ci >= 0 ? g.dims[ci] : "";
      const color = colorDim ? colorForValue(colorDim.dim.key, cv, colorIdx.get(cv) ?? 0, valueStyles) : SINGLE_COLOR;
      const dv = di >= 0 ? g.dims[di] : "";
      const dash = shapeDim ? dashForValue(shapeDim.dim.key, dv, shapeIdx.get(dv) ?? 0, valueStyles) : "";
      const pts: Array<{ x: number; y: number; sd: number | null; n: number }> = [];
      for (const p of g.points) {
        const x2 = txX(p.e);
        if (x2 !== null) pts.push({ x: x2, y: p.y, sd: p.sd, n: p.n });
      }
      return { dims: g.dims, color, dash, runId: g.runId, pts };
    });

    // Extent over all rendered points.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const acc = (px: number, py: number) => {
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    };
    for (const g of groupVis) for (const p of g.pts) acc(p.x, p.y);
    for (const s of ghostRuns) for (const p of s.pts) acc(p.x, p.y);

    return {
      ghostRuns,
      groups: groupVis,
      dropped: droppedY + droppedX,
      seriesCount: series.length,
      extent: Number.isFinite(x0) ? { x0, x1, y0, y1 } : null,
    };
  }, [lineMode, y, rows, splitDims, activeJudge, logX, logY, colorDim, shapeDim, colorIdx, shapeIdx, valueStyles]);

  // Jitter single-run points on a linear count x-axis (stacked integers).
  const jitter = !averaging && index[x]?.dtype === "count" && !logX;

  const visual: VisualPoint[] = useMemo(() => {
    const xL = index[x]?.label ?? x;
    const yL = index[y]?.label ?? y;
    const ci = splitDims.indexOf(colorDim!);
    const si = splitDims.indexOf(shapeDim!);
    const zi = splitDims.indexOf(sizeDim!);
    return points.map((gp) => {
      const cv = gp.dims[ci];
      const sv = gp.dims[si];
      const color = colorDim ? colorForValue(colorDim.dim.key, cv, colorIdx.get(cv) ?? 0, valueStyles) : SINGLE_COLOR;
      const shape = shapeDim ? shapeForValue(shapeDim.dim.key, sv, shapeIdx.get(sv) ?? 0, valueStyles) : 0;
      const r = sizeDim
        ? 2.5 + Math.min(5.5, (sizeIdx.get(gp.dims[zi]) ?? 0) * 1.4)
        : gp.n > 1 ? Math.min(10, 3 + Math.sqrt(gp.n)) : 3;
      const dimsDesc = splitDims
        .map((d, i) => `${d.dim.label} ${d.dim.display ? d.dim.display(gp.dims[i]) : gp.dims[i]}`)
        .join(" · ");
      const label: string[] = [];
      if (gp.n === 1 && gp.runId) {
        const row = rowByPath.get(gp.runId);
        label.push(row ? `${fnText(row.function.arity, row.function.truth_table)} · ${row.identity.run_id}` : gp.runId);
        if (dimsDesc) label.push(dimsDesc);
        label.push(`${xL}: ${tickFmt(gp.x)}${logX ? " (log10)" : ""}`);
        label.push(`${yL}: ${tickFmt(gp.y)}${logY ? " (log10)" : ""}`);
      } else {
        label.push(`${dimsDesc || "all runs"} · n=${gp.n}`);
        label.push(`${xL}: ${tickFmt(gp.x)}${gp.sdX !== null && gp.sdX > 0 ? ` ± ${tickFmt(gp.sdX)}` : ""}${binned ? " (bin)" : ""}${logX ? " (log10)" : ""}`);
        label.push(`mean ${yL}: ${tickFmt(gp.y)}${gp.sdY !== null ? ` ± ${tickFmt(gp.sdY)}` : ""}${logY ? " (log10)" : ""}`);
      }
      return {
        gp,
        jx: jitter && gp.runId ? (hash01(gp.runId) - 0.5) * 0.5 : 0,
        color,
        shapeIdx: shape,
        r,
        label,
      };
    });
  }, [points, splitDims, colorDim, shapeDim, sizeDim, colorIdx, shapeIdx, sizeIdx, valueStyles, rowByPath, index, x, y, logX, logY, binned, jitter]);

  // Scales over the TRANSFORMED values.
  const scale = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    if (lineMode && epoch?.extent) {
      ({ x0, x1, y0, y1 } = epoch.extent);
    } else {
      for (const p of visual) {
        const px = p.gp.x + p.jx;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (p.gp.y < y0) y0 = p.gp.y;
        if (p.gp.y > y1) y1 = p.gp.y;
      }
    }
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
    if (y1 - y0 < 1e-9) { y0 -= 0.5; y1 += 0.5; }
    const padX = (x1 - x0) * 0.04;
    const padY = (y1 - y0) * 0.06;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    // A set axis window overrides the auto extent (exact zoom, no padding).
    const tf = (v: number, log: boolean) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
    if (xDomain) { x0 = tf(xDomain[0], logX); x1 = tf(xDomain[1], logX); }
    if (yDomain) { y0 = tf(yDomain[0], logY); y1 = tf(yDomain[1], logY); }
    const sx = (v: number) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const ix = (px: number) => x0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    const iy = (py: number) => y0 + ((H - PAD.b - py) / (H - PAD.t - PAD.b)) * (y1 - y0);
    return { sx, sy, ix, iy, xTicks: niceTicks(x0, x1, 5), yTicks: niceTicks(y0, y1, 5) };
  }, [visual, W, H, xDomain, yDomain, logX, logY, lineMode, epoch]);

  // Ghost points — faint underlying runs behind the group means (averaging +
  // config.ghosts). Colored by each run's color-dim value (its group's color).
  const ghostVisual = useMemo(() => {
    if (!averaging || !config.ghosts) return [] as Array<{ x: number; y: number; color: string }>;
    const ci = colorDim ? splitDims.indexOf(colorDim) : -1;
    return ghosts.map((g: Ghost) => {
      const cv = ci >= 0 ? g.dims[ci] : "";
      const color = colorDim ? colorForValue(colorDim.dim.key, cv, colorIdx.get(cv) ?? 0, valueStyles) : SINGLE_COLOR;
      return { x: g.x, y: g.y, color };
    });
  }, [ghosts, averaging, config.ghosts, colorDim, splitDims, colorIdx, valueStyles]);

  // Trend fits + the r/ρ readout — ALWAYS over the underlying runs (a fit over
  // group means would overstate the association).
  const stats = useMemo(() => {
    if (pairs.length < 2) return null;
    const xs = pairs.map((p) => p.x);
    const ys = pairs.map((p) => p.y);
    const overall = { r: pearson(xs, ys), rho: spearman(xs, ys), n: pairs.length };
    if (!config.trend) return { overall, lines: [] };
    const byColor = new Map<string, { xs: number[]; ys: number[] }>();
    for (const p of pairs) {
      const k = p.color ?? "";
      const slot = byColor.get(k) ?? { xs: [], ys: [] };
      slot.xs.push(p.x);
      slot.ys.push(p.y);
      byColor.set(k, slot);
    }
    const lines = [...byColor.entries()]
      .map(([key, { xs: lx, ys: ly }]) => {
        const fit = olsFit(lx, ly);
        if (!fit) return null;
        return { key, fit, lo: Math.min(...lx), hi: Math.max(...lx), r: pearson(lx, ly) };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    return { overall, lines };
  }, [pairs, config.trend]);

  const rByColorValue = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const l of stats?.lines ?? []) m.set(l.key, l.r);
    return m;
  }, [stats]);

  // Publish the descriptive readout for the shared top bar (cleared on unmount).
  useEffect(() => {
    if (lineMode) {
      setChartReadout({
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
    setChartReadout({
      r: stats?.overall.r ?? null,
      rho: stats?.overall.rho ?? null,
      runs: pairs.length,
      points: points.length,
      averaging,
      binned,
      droppedLog,
      outsideWindow,
      ghostsSubsampled,
    });
  }, [lineMode, epoch, stats, pairs.length, points.length, averaging, binned, droppedLog, outsideWindow, ghostsSubsampled, setChartReadout]);
  useEffect(() => () => setChartReadout(null), [setChartReadout]);

  // ---- dimension treatment setter — edits v2 splits/channels ----------------
  // "avg"/null un-splits (drop from splits + channels); color/shape/size adds
  // the dim to splits with that explicit channel, freeing the channel from any
  // other split so channels stay unique.
  const setDim = (key: string, t: DimTreatment | null) => {
    const curSplits = config.splits ?? [];
    const curChannels = config.channels ?? {};
    if (t === null || t === "avg") {
      const nextChannels = { ...curChannels };
      delete nextChannels[key];
      setChart({ splits: curSplits.filter((k) => k !== key), channels: nextChannels });
      return;
    }
    const nextSplits = curSplits.includes(key) ? [...curSplits] : [...curSplits, key];
    const nextChannels: Record<string, Channel> = { ...curChannels, [key]: t };
    for (const k of Object.keys(nextChannels)) {
      if (k !== key && nextChannels[k] === t) delete nextChannels[k];
    }
    setChart({ splits: nextSplits, channels: nextChannels });
  };

  // ---- legend filtering — the ORDINARY filter mechanism, never chart state
  // (facet selections, or fn= scope chips for the function dimension) --------

  /** Candidate values (with in-scope counts) for a dimension's checkbox list. */
  const dimOptions = (dim: DimensionDef): Array<{ value: string; count: number }> => {
    const base = dim.fnScope ? fnScopeRows : scopedRows;
    const counts = new Map<string, number>();
    for (const r of base) {
      const v = dim.raw(r);
      if (v === null) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const values = [...counts.entries()].map(([value, count]) => ({ value, count }));
    values.sort(
      dim.numericSort
        ? (a, b) => Number(a.value) - Number(b.value)
        : (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
    return values;
  };

  /** The dimension's currently filter-selected values. */
  const dimSelection = (dim: DimensionDef): string[] => {
    if (dim.fnScope) {
      const dirs = filters.subtreeDirs ?? [];
      return [...fnHashByText.entries()]
        .filter(([, hash]) => dirs.includes(`fn=${hash}`))
        .map(([text]) => text);
    }
    return dim.facetKey ? (filters.facets[dim.facetKey] ?? []) : [];
  };

  /** Checkbox semantics: toggle one value in/out of the dimension's filter. */
  const toggleDimValue = (dim: DimensionDef, value: string) => {
    if (dim.fnScope) {
      const hash = fnHashByText.get(value);
      if (hash) toggleSubtreeDir(`fn=${hash}`);
    } else if (dim.facetKey) {
      toggleFacetValue(dim.facetKey, value);
    }
  };

  const clearDimFilter = (dim: DimensionDef) => {
    if (dim.fnScope) {
      for (const d of filters.subtreeDirs ?? []) {
        if (/^fn=[^/]+$/.test(d)) removeSubtreeDir(d);
      }
    } else if (dim.facetKey) {
      setFacet(dim.facetKey, []);
    }
  };

  const onPointClick = (p: VisualPoint) => {
    if (p.gp.runId && p.gp.n === 1) {
      openDetail(p.gp.runId);
      const r = rowByPath.get(p.gp.runId);
      if (r) expandChain(r.identity.chain_dirs);
    }
  };

  // ---- axis view window (zoom-only min/max; never touches FilterState) -------
  const setDomain = (axis: "x" | "y", d: [number, number] | null) =>
    setChart(axis === "x" ? { xDomain: d } : { yDomain: d });

  // ---- dimension-board styling actions (edit v2 splits/channels/valueStyles) -
  const addSplit = (key: string) => {
    const cur = config.splits ?? [];
    if (!cur.includes(key)) setChart({ splits: [...cur, key] });
  };
  const reorderSplits = (next: string[]) => setChart({ splits: next });
  const setChannel = (key: string, ch: Channel) => {
    const cur = config.splits ?? [];
    const nextChannels: Record<string, Channel> = { ...(config.channels ?? {}), [key]: ch };
    for (const k of Object.keys(nextChannels)) {
      if (k !== key && nextChannels[k] === ch) delete nextChannels[k]; // channels stay unique
    }
    setChart({ splits: cur.includes(key) ? cur : [...cur, key], channels: nextChannels });
  };
  const setValueStyle = (dimKey: string, value: string, patch: ValueStyle | null) => {
    const vs: Record<string, Record<string, ValueStyle>> = { ...(config.valueStyles ?? {}) };
    const inner = { ...(vs[dimKey] ?? {}) };
    if (patch === null) delete inner[value];
    else inner[value] = { ...inner[value], ...patch };
    if (Object.keys(inner).length) vs[dimKey] = inner;
    else delete vs[dimKey];
    setChart({ valueStyles: vs });
  };

  // ---- per-value isolate / exclude (ordinary facet / fn= filters) -----------
  const isolateValue = (dim: DimensionDef, value: string) => {
    if (dim.fnScope) {
      for (const d of filters.subtreeDirs ?? []) if (/^fn=[^/]+$/.test(d)) removeSubtreeDir(d);
      const hash = fnHashByText.get(value);
      if (hash) addSubtreeDir(`fn=${hash}`);
    } else if (dim.facetKey) {
      setFacet(dim.facetKey, [value]);
    }
  };
  const excludeValue = (dim: DimensionDef, value: string) => {
    if (dim.fnScope) {
      for (const d of filters.subtreeDirs ?? []) if (/^fn=[^/]+$/.test(d)) removeSubtreeDir(d);
      for (const [text, hash] of fnHashByText.entries()) if (text !== value) addSubtreeDir(`fn=${hash}`);
    } else if (dim.facetKey) {
      setFacet(dim.facetKey, dimOptions(dim).map((o) => o.value).filter((v) => v !== value));
    }
  };

  // ---- export handle for the shared Export menu ----------------------------
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = {
      getSvg: () => svgRef.current,
      getCsv: () => {
        const xL = `${index[x]?.label ?? x}${logX ? " (log10)" : ""}`;
        const yL = `${index[y]?.label ?? y}${logY ? " (log10)" : ""}`;
        const dimHead = splitDims.map((d) => d.dim.label);
        if (lineMode && epoch) {
          const head = ["epoch", ...dimHead, "n", `${yL} (mean)`, `${yL} (sd)`];
          const body = epoch.groups.flatMap((g) =>
            g.pts.map((p) => [logX ? Math.round(Math.pow(10, p.x)) : p.x, ...g.dims, p.n, p.y, p.sd ?? ""]),
          );
          return toCsv([head, ...body]);
        }
        if (averaging) {
          const head = [xL, ...dimHead, "n", `${yL} (mean)`, `${yL} (sd)`];
          return toCsv([head, ...points.map((p) => [p.x, ...p.dims, p.n, p.y, p.sdY ?? ""])]);
        }
        const head = ["run_id", xL, yL, ...dimHead];
        return toCsv([head, ...points.map((p) => [p.runId ?? "", p.x, p.y, ...p.dims])]);
      },
    };
    return () => { exportRef.current = null; };
  }, [exportRef, points, x, y, index, logX, logY, splitDims, averaging, lineMode, epoch]);

  // The point linked to the row hovered/selected elsewhere (table / tree).
  const linked = useMemo(
    () => visual.filter((p) => p.gp.runId !== undefined && (p.gp.runId === selectedDir || p.gp.runId === hoveredDir)),
    [visual, hoveredDir, selectedDir],
  );

  // Tick labels un-transform on a log axis (positions stay in log space).
  const xTickLabel = (t: number) => (logX ? tickFmt(Math.pow(10, t)) : tickFmt(t));
  const yTickLabel = (t: number) => (logY ? tickFmt(Math.pow(10, t)) : tickFmt(t));

  // Per-split-combo connecting lines (averaging only): the mean trajectory of
  // each combination across X.
  const meanLines = useMemo(() => {
    if (!averaging) return [];
    const byCombo = new Map<string, VisualPoint[]>();
    for (const p of visual) {
      const k = p.gp.dims.join("\u0000");
      const arr = byCombo.get(k) ?? [];
      arr.push(p);
      byCombo.set(k, arr);
    }
    return [...byCombo.values()].filter((arr) => arr.length > 1);
  }, [visual, averaging]);

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
          >
            <defs>
              <clipPath id="bb-plot-clip">
                <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} />
              </clipPath>
            </defs>
            <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b}
              fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={1} />
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
                fill="var(--color-text-muted)">{(index[x]?.label ?? x) + (logX ? " (log)" : "")}</text>
              <text x={16} y={(PAD.t + H - PAD.b) / 2} fontSize={13} textAnchor="middle"
                transform={`rotate(-90 16 ${(PAD.t + H - PAD.b) / 2})`}
                fill="var(--color-text-muted)">{(index[y]?.label ?? y) + (logY ? " (log)" : "")}</text>
            </g>

            {/* epoch trajectories: ghost run-lines, group ±SD ribbons, mean lines */}
            {lineMode && epoch && (
              <g clipPath="url(#bb-plot-clip)">
                {config.ghosts && epoch.ghostRuns.map((s, i) => (
                  s.pts.length > 1 && (
                    <polyline
                      key={`gl${i}`}
                      points={s.pts.map((p) => `${scale.sx(p.x)},${scale.sy(p.y)}`).join(" ")}
                      fill="none" stroke={s.color} strokeWidth={1} strokeOpacity={0.12}
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
                    <polygon key={`rb${i}`} points={[...up, ...dn].join(" ")} fill={g.color} fillOpacity={0.1} stroke="none" pointerEvents="none" />
                  );
                })}
                {epoch.groups.map((g, i) => (
                  g.pts.length > 1 && (
                    <polyline
                      key={`ml${i}`}
                      points={g.pts.map((p) => `${scale.sx(p.x)},${scale.sy(p.y)}`).join(" ")}
                      fill="none" stroke={g.color} strokeWidth={1.75} strokeOpacity={0.95}
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
                      cx={scale.sx(p.x)} cy={scale.sy(p.y)} r={2.4}
                      fill={g.color} fillOpacity={0.9}
                      className={g.runId ? "cursor-pointer" : undefined}
                      onClick={g.runId ? () => { openDetail(g.runId!); const r = bundle.rows.find((x2) => x2.identity.node_path === g.runId); if (r) expandChain(r.identity.chain_dirs); } : undefined}
                    >
                      <title>{`${g.dims.length ? g.dims.join(" · ") + " · " : ""}epoch ${logX ? Math.round(Math.pow(10, p.x)) : p.x}: ${tickFmt(logY ? Math.pow(10, p.y) : p.y)}${p.sd !== null && p.sd > 0 ? ` ± ${tickFmt(p.sd)}` : ""}${p.n > 1 ? ` (n=${p.n})` : ""}`}</title>
                    </circle>
                  )),
                )}
              </g>
            )}

            {/* per-combo connecting lines (averaging; under points + whiskers) */}
            {meanLines.length > 0 && (
              <g clipPath="url(#bb-plot-clip)">
                {meanLines.map((line, i) => (
                  <path
                    key={i}
                    d={line.map((p, j) => `${j === 0 ? "M" : "L"}${scale.sx(p.gp.x)},${scale.sy(p.gp.y)}`).join(" ")}
                    fill="none" stroke={line[0].color} strokeWidth={1.5} strokeOpacity={0.85}
                    pointerEvents="none"
                  />
                ))}
              </g>
            )}

            {/* ghost points — faint underlying runs behind the group means */}
            {ghostVisual.length > 0 && (
              <g clipPath="url(#bb-plot-clip)">
                {ghostVisual.map((g, i) => (
                  <circle
                    key={`g${i}`}
                    cx={scale.sx(g.x)}
                    cy={scale.sy(g.y)}
                    r={1.4}
                    fill={g.color}
                    fillOpacity={0.18}
                    pointerEvents="none"
                  />
                ))}
              </g>
            )}

            {/* ±1 SD whiskers (grouped points; under the points) */}
            {averaging && config.band && (
              <g clipPath="url(#bb-plot-clip)">
                {visual.map((p, i) => (
                  <g key={`w${i}`} stroke={p.color} strokeOpacity={0.5} strokeWidth={1}>
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
                  {shapeNode(p.shapeIdx, scale.sx(p.gp.x + p.jx), scale.sy(p.gp.y), p.r, {
                    fill: p.color, fillOpacity: 0.6, stroke: p.color, strokeOpacity: 0.9,
                  })}
                </g>
              ))}
            </g>

            {/* linked-row highlight rings (row hovered/selected in table or tree) */}
            {linked.map((p, i) => (
              <circle
                key={`h${i}`}
                cx={scale.sx(p.gp.x + p.jx)}
                cy={scale.sy(p.gp.y)}
                r={p.r + 3}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            ))}

            {/* trend lines (over the underlying runs, per color value) */}
            {stats && stats.lines.length > 0 && colorDim && (
              <g clipPath="url(#bb-plot-clip)">
                {stats.lines.map((l) => {
                  const idx = colorIdx.get(l.key);
                  const color = idx === undefined ? SINGLE_COLOR : PALETTE[idx % PALETTE.length];
                  return (
                    <line
                      key={l.key}
                      x1={scale.sx(l.lo)}
                      y1={scale.sy(l.fit.intercept + l.fit.slope * l.lo)}
                      x2={scale.sx(l.hi)}
                      y2={scale.sy(l.fit.intercept + l.fit.slope * l.hi)}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeDasharray="6 3"
                      strokeOpacity={0.9}
                      pointerEvents="none"
                    />
                  );
                })}
              </g>
            )}
            {stats && stats.lines.length > 0 && !colorDim && (
              <g clipPath="url(#bb-plot-clip)">
                {stats.lines.map((l) => (
                  <line
                    key={l.key}
                    x1={scale.sx(l.lo)}
                    y1={scale.sy(l.fit.intercept + l.fit.slope * l.lo)}
                    x2={scale.sx(l.hi)}
                    y2={scale.sy(l.fit.intercept + l.fit.slope * l.hi)}
                    stroke={SINGLE_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                    strokeOpacity={0.9}
                    pointerEvents="none"
                  />
                ))}
              </g>
            )}

            {/* invisible hit targets (on top; generous radius) */}
            <g>
              {visual.map((p, i) => (
                <circle
                  key={`t${i}`}
                  cx={scale.sx(p.gp.x + p.jx)}
                  cy={scale.sy(p.gp.y)}
                  r={Math.max(9, p.r + 5)}
                  fill="transparent"
                  className={p.gp.n === 1 ? "cursor-pointer" : undefined}
                  onMouseEnter={() => setHover(p)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onPointClick(p)}
                />
              ))}
            </g>
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
              onChange={(v) => setChart({ x: v })}
              schema={bundle.metric_schema}
              ariaLabel="x metric"
              order={X_GROUP_ORDER}
              placement="up"
              pinned={[{ value: "epoch", label: "epoch (training progress)" }]}
            />
          </div>
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-0.5 z-10 flex items-center">
          <div className="pointer-events-auto">
            <MetricPicker
              value={y}
              onChange={(v) => setChart({ y: v })}
              schema={bundle.metric_schema}
              ariaLabel="y metric"
              order={Y_GROUP_ORDER}
              placement="right"
              vertical
            />
          </div>
        </div>
        <LogToggle
          checked={logX}
          onChange={(b) => setChart({ logX: b })}
          ariaLabel="x log scale"
          style={{ left: PAD.l + 8, bottom: 4 }}
        />
        <LogToggle
          vertical
          checked={logY}
          onChange={(b) => setChart({ logY: b })}
          ariaLabel="y log scale"
          style={{ left: 4, bottom: PAD.b + 8 }}
        />

        {/* axis view-window (zoom) min/max — click a number to edit, ⟲ resets.
            Never touches FilterState; clipped points stay in the table. */}
        <AxisRange
          axis="x"
          domain={xDomain}
          extent={dataExtent ? [dataExtent.xMin, dataExtent.xMax] : null}
          onSet={(d) => setDomain("x", d)}
          style={{ right: PAD.r + 6, bottom: 3 }}
        />
        <AxisRange
          axis="y"
          domain={yDomain}
          extent={dataExtent ? [dataExtent.yMin, dataExtent.yMax] : null}
          onSet={(d) => setDomain("y", d)}
          style={{ left: PAD.l + 4, top: 2 }}
        />

        {/* tooltip (flips sides near the right edge) */}
        {hover && (() => {
          const px = scale.sx(hover.gp.x + hover.jx);
          const py = scale.sy(hover.gp.y);
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

      {/* dimension board — the single control surface, docked right of the plot */}
      <DimensionBoard
        summary={summary}
        splits={activeSplits}
        channelByDim={channelByDim}
        worthiness={worthiness}
        averagedDims={averagedDims}
        valueStyles={valueStyles}
        band={!!config.band}
        ghosts={!!config.ghosts}
        setBand={(b) => setChart({ band: b })}
        setGhosts={(b) => setChart({ ghosts: b })}
        addSplit={addSplit}
        removeSplit={(key) => setDim(key, null)}
        reorderSplits={reorderSplits}
        setChannel={setChannel}
        setValueStyle={setValueStyle}
        dimSelection={dimSelection}
        toggleDimValue={toggleDimValue}
        clearDimFilter={clearDimFilter}
        isolateValue={isolateValue}
        excludeValue={excludeValue}
        rByColorValue={rByColorValue}
      />
    </div>
  );
}

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
        className="w-14 rounded border border-accent/50 bg-surface px-1 text-[10px] text-text tabular-nums focus:outline-none"
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
      className="pointer-events-auto absolute z-10 flex items-center gap-0.5 rounded bg-surface/70 px-1 text-[10px] text-text-faint"
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
