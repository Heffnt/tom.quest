"use client";

// app/boolback/components/chart-panel.tsx — the Chart center view.
//
// A single scatter over the SAME filtered row set as the table (the filter
// bar stays above both views) that answers the campaign's real questions:
// "does outcome Y move with function-complexity X, and does the context
// moderate it?"
//
//   X / Y = any snapshot metric (searchable pickers; per-method
//       DEFENSE/INTERP/SCAN entries collapse under their base metric)
//   log   = per-axis log10 toggles (non-positive values dropped, counted)
//   trend = per-color OLS fit lines + Pearson r (r/ρ readout is ALWAYS
//       computed over the underlying runs)
//
// THE DIMENSIONS PANEL (replacing the old runs|functions|means toggle and the
// color dropdown): every run dimension (function, model, arity, seed, …) is
// either SHARED across the filtered view (shown as the points' common
// context) or DIFFERING. Each differing dimension is
//
//   split onto a visual channel — color / shape / size — so its values are
//     distinguishable point-by-point;
//   filtered to one value via the chip's value list (this emits an ORDINARY
//     filter chip in the bar above — one filter mechanism, shared with the
//     table); or
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
import type { Bundle, DimTreatment, RunRow } from "../lib/types";
import { DEFAULT_CHART } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import { X_GROUP_ORDER, Y_GROUP_ORDER } from "../lib/metrics";
import {
  assignTreatments, summarizeDimensions, type Channel, type DimValues,
} from "../lib/dimensions";
import { groupRuns, type GroupedPoint, type RunPoint } from "../lib/aggregate";
import { niceTicks, olsFit, pearson, spearman } from "../lib/stats";
import { toCsv } from "../lib/export";
import { fnText, hash01 } from "../lib/format";
import { MetricPicker } from "./metric-picker";

/** What the shared Export menu needs from the mounted chart. */
export interface ChartExportHandle {
  getSvg: () => SVGSVGElement | null;
  getCsv: () => string;
}

const PALETTE = [
  "#e8a040", "#38bdf8", "#4ade80", "#e879f9",
  "#f87171", "#c9b35f", "#6fb6a6", "#b48ad6",
  "#f0abfc", "#86efac", "#fca5a5", "#7dd3fc",
];

const SINGLE_COLOR = "#e8a040";

// Geometry (viewBox units; the SVG scales to the pane).
const W = 820;
const H = 430;
const PAD = { l: 56, r: 16, t: 14, b: 40 };
const MIN_DRAG = 8; // viewBox units before a drag counts as a box-select

const CHANNEL_GLYPH: Record<Channel | "avg", string> = {
  color: "●",
  shape: "▲",
  size: "◔",
  avg: "x̄",
};

// The shape channel's glyph cycle (index 0 = plain circle).
const SHAPE_COUNT = 6;

function shapeNode(
  idx: number, cx: number, cy: number, r: number,
  props: { fill: string; fillOpacity: number; stroke: string; strokeOpacity: number },
): React.ReactElement {
  const k = idx % SHAPE_COUNT;
  if (k === 1) {
    return <rect x={cx - r} y={cy - r} width={2 * r} height={2 * r} {...props} pointerEvents="none" />;
  }
  if (k === 2) {
    return <path d={`M${cx},${cy - r * 1.2} L${cx + r * 1.1},${cy + r * 0.9} L${cx - r * 1.1},${cy + r * 0.9} Z`} {...props} pointerEvents="none" />;
  }
  if (k === 3) {
    return <path d={`M${cx},${cy - r * 1.3} L${cx + r * 1.3},${cy} L${cx},${cy + r * 1.3} L${cx - r * 1.3},${cy} Z`} {...props} pointerEvents="none" />;
  }
  if (k === 4) {
    return <path d={`M${cx},${cy + r * 1.2} L${cx + r * 1.1},${cy - r * 0.9} L${cx - r * 1.1},${cy - r * 0.9} Z`} {...props} pointerEvents="none" />;
  }
  if (k === 5) {
    const a = r * 0.9;
    return (
      <path
        d={`M${cx - a},${cy - a} L${cx + a},${cy + a} M${cx - a},${cy + a} L${cx + a},${cy - a}`}
        fill="none" stroke={props.stroke} strokeOpacity={props.strokeOpacity}
        strokeWidth={Math.max(1.5, r * 0.5)} pointerEvents="none"
      />
    );
  }
  return <circle cx={cx} cy={cy} r={r} {...props} pointerEvents="none" />;
}

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
  const addSubtreeDir = useBoolbackStore((s) => s.addSubtreeDir);
  const addRange = useBoolbackStore((s) => s.addRange);
  const setFacet = useBoolbackStore((s) => s.setFacet);
  const toggleFacetValue = useBoolbackStore((s) => s.toggleFacetValue);
  const filters = useBoolbackStore((s) => s.filters);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const config = useBoolbackStore((s) => s.chart);
  const setChart = useBoolbackStore((s) => s.setChart);

  const [hover, setHover] = useState<VisualPoint | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragMoved = useRef(false);

  // Guard a persisted/shared config whose metric no longer exists in the schema.
  const x = index[config.x] ? config.x : DEFAULT_CHART.x in index ? DEFAULT_CHART.x : (bundle.metric_schema[0]?.name ?? "");
  const y = index[config.y] ? config.y : DEFAULT_CHART.y in index ? DEFAULT_CHART.y : (bundle.metric_schema[0]?.name ?? "");
  const logX = !!config.logX;
  const logY = !!config.logY;
  const rawDims = config.dims;
  const dimOverrides = useMemo(
    () => (rawDims ?? {}) as Record<string, DimTreatment>,
    [rawDims],
  );

  // ---- the dimension model over the filtered rows ---------------------------
  const summary = useMemo(() => summarizeDimensions(rows), [rows]);
  const treatments = useMemo(
    () => assignTreatments(summary.differing, dimOverrides),
    [summary, dimOverrides],
  );
  const channelDims = useMemo(() => {
    const byChannel = new Map<Channel, DimValues>();
    for (const d of summary.differing) {
      const t = treatments.get(d.dim.key);
      if (t && t !== "avg") byChannel.set(t, d);
    }
    return byChannel;
  }, [summary, treatments]);
  const colorDim = channelDims.get("color");
  const shapeDim = channelDims.get("shape");
  const sizeDim = channelDims.get("size");
  // Split dims in RunPoint.dims order: color, shape, size (whichever exist).
  const splitDims = useMemo(
    () => [colorDim, shapeDim, sizeDim].filter((d): d is DimValues => d !== undefined),
    [colorDim, shapeDim, sizeDim],
  );
  const averaging = useMemo(
    () => summary.differing.some((d) => treatments.get(d.dim.key) === "avg"),
    [summary, treatments],
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

  // function display text -> function hash (scope-chip filters, legend clicks).
  const fnHashByText = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      m.set(fnText(r.function.arity, r.function.truth_table), r.identity.function_hash);
    }
    return m;
  }, [rows]);

  // ---- points ---------------------------------------------------------------
  const { points, pairs, droppedLog, binned, rowByPath } = useMemo(() => {
    const xId = metricColumnId(x, index);
    const yId = metricColumnId(y, index);
    let dropped = 0;
    const runPts: RunPoint[] = [];
    // Underlying (run-level) pairs for r/ρ and the OLS fits, with the color value.
    const rawPairs: Array<{ x: number; y: number; color: string | null }> = [];
    const byPath = new Map<string, RunRow>();
    for (const r of rows) {
      const vx = numericValue(r, xId);
      const vy = numericValue(r, yId);
      if (vx === null || vy === null) continue;
      if ((logX && vx <= 0) || (logY && vy <= 0)) {
        dropped++;
        continue;
      }
      const tx = logX ? Math.log10(vx) : vx;
      const ty = logY ? Math.log10(vy) : vy;
      runPts.push({
        x: tx,
        y: ty,
        runId: r.identity.node_path,
        dims: splitDims.map((d) => d.dim.raw(r) ?? "—"),
      });
      rawPairs.push({ x: tx, y: ty, color: colorDim ? colorDim.dim.raw(r) : null });
      byPath.set(r.identity.node_path, r);
    }
    const grouped = groupRuns(runPts, averaging);
    return {
      points: grouped.points,
      pairs: rawPairs,
      droppedLog: dropped,
      binned: grouped.binned,
      rowByPath: byPath,
    };
  }, [rows, x, y, index, logX, logY, splitDims, colorDim, averaging]);

  // Jitter single-run points on a linear count x-axis (stacked integers).
  const jitter = !averaging && index[x]?.dtype === "count" && !logX;

  const visual: VisualPoint[] = useMemo(() => {
    const xL = index[x]?.label ?? x;
    const yL = index[y]?.label ?? y;
    const ci = splitDims.indexOf(colorDim!);
    const si = splitDims.indexOf(shapeDim!);
    const zi = splitDims.indexOf(sizeDim!);
    return points.map((gp) => {
      const color = colorDim ? PALETTE[(colorIdx.get(gp.dims[ci]) ?? 0) % PALETTE.length] : SINGLE_COLOR;
      const shape = shapeDim ? (shapeIdx.get(gp.dims[si]) ?? 0) : 0;
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
  }, [points, splitDims, colorDim, shapeDim, sizeDim, colorIdx, shapeIdx, sizeIdx, rowByPath, index, x, y, logX, logY, binned, jitter]);

  // Scales over the TRANSFORMED values.
  const scale = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of visual) {
      const px = p.gp.x + p.jx;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (p.gp.y < y0) y0 = p.gp.y;
      if (p.gp.y > y1) y1 = p.gp.y;
    }
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
    if (y1 - y0 < 1e-9) { y0 -= 0.5; y1 += 0.5; }
    const padX = (x1 - x0) * 0.04;
    const padY = (y1 - y0) * 0.06;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    const sx = (v: number) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const ix = (px: number) => x0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    const iy = (py: number) => y0 + ((H - PAD.b - py) / (H - PAD.t - PAD.b)) * (y1 - y0);
    return { sx, sy, ix, iy, xTicks: niceTicks(x0, x1, 5), yTicks: niceTicks(y0, y1, 5) };
  }, [visual]);

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

  // ---- dimension treatment setter (channels stay unique) ---------------------
  const setDim = (key: string, t: DimTreatment | null) => {
    const next: Record<string, DimTreatment> = { ...dimOverrides };
    if (t === null) {
      delete next[key];
    } else {
      if (t !== "avg") {
        for (const k of Object.keys(next)) {
          if (next[k] === t && k !== key) delete next[k];
        }
      }
      next[key] = t;
    }
    setChart({ dims: next });
  };

  // "filter to one value" — the ORDINARY filter mechanism, never chart state.
  const filterDimTo = (d: DimValues, value: string) => {
    if (d.dim.fnScope) {
      const hash = fnHashByText.get(value);
      if (hash) addSubtreeDir(`fn=${hash}`);
    } else if (d.dim.facetKey) {
      setFacet(d.dim.facetKey, [value]);
    }
  };
  const legendToggle = (d: DimValues, value: string) => {
    if (d.dim.fnScope) {
      const hash = fnHashByText.get(value);
      if (hash) addSubtreeDir(`fn=${hash}`);
    } else if (d.dim.facetKey) {
      toggleFacetValue(d.dim.facetKey, value);
    }
  };

  const onPointClick = (p: VisualPoint) => {
    if (dragMoved.current) return; // a box-select drag just ended
    if (p.gp.runId && p.gp.n === 1) {
      openDetail(p.gp.runId);
      const r = rowByPath.get(p.gp.runId);
      if (r) expandChain(r.identity.chain_dirs);
    }
  };

  // ---- box-select (background drag -> X+Y range filters) ------------------
  const toViewBox = (e: React.PointerEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const onSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
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
    if (!dragMoved.current) return;
    // Invert pixel rect -> transformed values -> raw metric values.
    const untX = (v: number) => (logX ? Math.pow(10, v) : v);
    const untY = (v: number) => (logY ? Math.pow(10, v) : v);
    const vx = [scale.ix(Math.min(d.x0, d.x1)), scale.ix(Math.max(d.x0, d.x1))];
    const vy = [scale.iy(Math.max(d.y0, d.y1)), scale.iy(Math.min(d.y0, d.y1))]; // sy inverts
    addRange({ metric: x, min: untX(vx[0]), max: untX(vx[1]) });
    addRange({ metric: y, min: untY(vy[0]), max: untY(vy[1]) });
    // Let the click that follows pointerup on a point be ignored, then reset.
    setTimeout(() => { dragMoved.current = false; }, 0);
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
        if (averaging) {
          const head = [xL, ...dimHead, "n", `${yL} (mean)`, `${yL} (sd)`];
          return toCsv([head, ...points.map((p) => [p.x, ...p.dims, p.n, p.y, p.sdY ?? ""])]);
        }
        const head = ["run_id", xL, yL, ...dimHead];
        return toCsv([head, ...points.map((p) => [p.runId ?? "", p.x, p.y, ...p.dims])]);
      },
    };
    return () => { exportRef.current = null; };
  }, [exportRef, points, x, y, index, logX, logY, splitDims, averaging]);

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

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* axis / trend controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/60">
        <span className="text-xs text-text-faint font-mono">y</span>
        <MetricPicker value={y} onChange={(v) => setChart({ y: v })} schema={bundle.metric_schema} ariaLabel="y metric" order={Y_GROUP_ORDER} />
        <AxisToggle label="log" checked={logY} onChange={(b) => setChart({ logY: b })} />
        <span className="text-xs text-text-faint font-mono">vs x</span>
        <MetricPicker value={x} onChange={(v) => setChart({ x: v })} schema={bundle.metric_schema} ariaLabel="x metric" order={X_GROUP_ORDER} />
        <AxisToggle label="log" checked={logX} onChange={(b) => setChart({ logX: b })} />
        <AxisToggle label="trend" checked={!!config.trend} onChange={(b) => setChart({ trend: b })} />
        <span className="ml-auto text-xs text-text-faint font-mono">
          {stats?.overall && (
            <span
              className="text-text-muted"
              title={`Pearson r · Spearman ρ over the ${stats.overall.n.toLocaleString()} underlying runs (descriptive)`}
            >
              r={stats.overall.r === null ? "—" : stats.overall.r.toFixed(2)}
              {" · "}ρ={stats.overall.rho === null ? "—" : stats.overall.rho.toFixed(2)}
              {" · "}
            </span>
          )}
          {averaging
            ? `${points.length.toLocaleString()} group${points.length === 1 ? "" : "s"} of ${pairs.length.toLocaleString()} runs`
            : `${points.length.toLocaleString()} point${points.length === 1 ? "" : "s"}`}
          {binned && <span title="X has too many distinct values — grouped into 12 equal-width bins"> · x binned</span>}
          {droppedLog > 0 && <span title="values ≤ 0 cannot be shown on a log axis"> · {droppedLog} dropped (log)</span>}
          {" · drag to filter"}
        </span>
      </div>

      {/* dimensions panel — shared context + differing dims with treatments */}
      <DimensionsBar
        summary={summary}
        treatments={treatments}
        setDim={setDim}
        filterDimTo={filterDimTo}
        overrides={dimOverrides}
      />

      {/* plot */}
      <div className="relative flex-1 min-h-0 px-2 py-1">
        {visual.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-text-faint font-mono">
            {droppedLog > 0
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
              fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={1} />
            {scale.yTicks.map((t, i) => (
              <g key={`y${i}`}>
                <line x1={PAD.l} y1={scale.sy(t)} x2={W - PAD.r} y2={scale.sy(t)}
                  stroke="var(--color-border)" strokeOpacity={0.5} strokeWidth={0.5} />
                <text x={PAD.l - 5} y={scale.sy(t) + 3} fontSize={10} textAnchor="end"
                  fill="var(--color-text-faint)" className="font-mono">{yTickLabel(t)}</text>
              </g>
            ))}
            {scale.xTicks.map((t, i) => (
              <g key={`x${i}`}>
                <line x1={scale.sx(t)} y1={PAD.t} x2={scale.sx(t)} y2={H - PAD.b}
                  stroke="var(--color-border)" strokeOpacity={0.35} strokeWidth={0.5} />
                <text x={scale.sx(t)} y={H - PAD.b + 14} fontSize={10} textAnchor="middle"
                  fill="var(--color-text-faint)" className="font-mono">{xTickLabel(t)}</text>
              </g>
            ))}
            <text x={(PAD.l + W - PAD.r) / 2} y={H - 6} fontSize={11} textAnchor="middle"
              fill="var(--color-text-muted)">{(index[x]?.label ?? x) + (logX ? " (log)" : "")}</text>
            <text x={14} y={(PAD.t + H - PAD.b) / 2} fontSize={11} textAnchor="middle"
              transform={`rotate(-90 14 ${(PAD.t + H - PAD.b) / 2})`}
              fill="var(--color-text-muted)">{(index[y]?.label ?? y) + (logY ? " (log)" : "")}</text>

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

            {/* ±1 SD whiskers (grouped points; under the points) */}
            {averaging && (
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

            {/* box-select rectangle */}
            {drag && dragMoved.current && (
              <rect
                x={Math.min(drag.x0, drag.x1)}
                y={Math.min(drag.y0, drag.y1)}
                width={Math.abs(drag.x1 - drag.x0)}
                height={Math.abs(drag.y1 - drag.y0)}
                fill="var(--color-accent)"
                fillOpacity={0.08}
                stroke="var(--color-accent)"
                strokeOpacity={0.7}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
          </svg>
        )}

        {/* tooltip (flips sides near the right edge) */}
        {hover && (() => {
          const px = scale.sx(hover.gp.x + hover.jx);
          const py = scale.sy(hover.gp.y);
          const flip = px > W * 0.62;
          return (
            <div
              className="pointer-events-none absolute z-20 max-w-96 rounded-md border border-border bg-surface-alt px-2 py-1 font-mono text-[11px] text-text shadow-lg"
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

      {/* legend — one row per active channel; keys CLICK to toggle that filter */}
      {visual.length > 0 && (colorDim || shapeDim || sizeDim) && (
        <div className="border-t border-border/60 px-3 py-1.5 text-[11px] text-text-muted">
          {([["color", colorDim], ["shape", shapeDim], ["size", sizeDim]] as const)
            .filter((e): e is [Channel, DimValues] => e[1] !== undefined)
            .map(([channel, d]) => (
              <div key={channel} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-text-faint">{CHANNEL_GLYPH[channel]} {d.dim.label}:</span>
                {d.values.slice(0, 14).map(({ value }, i) => {
                  const selected = d.dim.facetKey ? (filters.facets[d.dim.facetKey] ?? []) : [];
                  const active = selected.includes(value);
                  const dimmed = selected.length > 0 && !active;
                  const disp = d.dim.display ? d.dim.display(value) : value;
                  const r = channel === "color" ? rByColorValue.get(value) : undefined;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => legendToggle(d, value)}
                      title={`toggle ${d.dim.label}: ${disp}`}
                      className={[
                        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors cursor-pointer hover:bg-surface-alt",
                        active ? "ring-1 ring-accent/60 text-text" : "",
                        dimmed ? "opacity-40" : "",
                      ].join(" ")}
                    >
                      {channel === "color" && (
                        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                      )}
                      {channel === "shape" && (
                        <svg width={10} height={10} viewBox="-6 -6 12 12">
                          {shapeNode(i, 0, 0, 4, {
                            fill: "currentColor", fillOpacity: 0.7, stroke: "currentColor", strokeOpacity: 1,
                          })}
                        </svg>
                      )}
                      {channel === "size" && (
                        <span
                          className="inline-block rounded-full bg-current opacity-70"
                          style={{ width: 4 + Math.min(8, i * 2), height: 4 + Math.min(8, i * 2) }}
                        />
                      )}
                      {disp}
                      {r !== undefined && r !== null && (
                        <span className="text-text-faint">r={r.toFixed(2)}</span>
                      )}
                    </button>
                  );
                })}
                {d.values.length > 14 && <span>+{d.values.length - 14} more</span>}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dimensions bar — the shared line + one chip per differing dimension.
// ---------------------------------------------------------------------------

function DimensionsBar({
  summary,
  treatments,
  setDim,
  filterDimTo,
  overrides,
}: {
  summary: ReturnType<typeof summarizeDimensions>;
  treatments: Map<string, DimTreatment>;
  setDim: (key: string, t: DimTreatment | null) => void;
  filterDimTo: (d: DimValues, value: string) => void;
  overrides: Record<string, DimTreatment>;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-3 py-1.5 text-[11px]">
      {summary.differing.length > 0 && (
        <span className="text-text-faint" title="Differing dimensions: split onto a channel (color/shape/size), filter to one value, or average across. Auto assigns the biggest splits to channels first; the rest are averaged.">
          differs by
        </span>
      )}
      {summary.differing.map((d) => {
        const t = treatments.get(d.dim.key) ?? "avg";
        const overridden = d.dim.key in overrides;
        const open = openKey === d.dim.key;
        return (
          <span key={d.dim.key} className="relative inline-block">
            <button
              type="button"
              onClick={() => setOpenKey(open ? null : d.dim.key)}
              title={`${d.dim.label}: ${d.values.length} values — ${t === "avg" ? "averaged" : `split by ${t}`}${overridden ? "" : " (auto)"}`}
              className={[
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors hover:border-accent/50",
                t === "avg" ? "border-border text-text-muted" : "border-accent/40 text-text",
              ].join(" ")}
            >
              <span className={t === "avg" ? "text-text-faint" : "text-accent"}>{CHANNEL_GLYPH[t]}</span>
              {d.dim.label}
              <span className="text-text-faint">×{d.values.length}</span>
            </button>
            {open && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setOpenKey(null)} />
                <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-border bg-surface/95 p-2 shadow-lg backdrop-blur-md">
                  <div className="mb-1 flex flex-wrap gap-1">
                    {(["color", "shape", "size", "avg"] as const).map((opt) => (
                      <button
                        key={opt}
                        onClick={() => { setDim(d.dim.key, opt); setOpenKey(null); }}
                        className={[
                          "rounded-md border px-1.5 py-0.5 transition-colors",
                          t === opt ? "border-accent/60 text-accent" : "border-border text-text-muted hover:text-text",
                        ].join(" ")}
                      >
                        {CHANNEL_GLYPH[opt]} {opt === "avg" ? "average" : opt}
                      </button>
                    ))}
                    {overridden && (
                      <button
                        onClick={() => { setDim(d.dim.key, null); setOpenKey(null); }}
                        className="rounded-md border border-border px-1.5 py-0.5 text-text-muted hover:text-text"
                        title="return to automatic assignment"
                      >
                        auto
                      </button>
                    )}
                  </div>
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-faint">filter to</div>
                  <div className="max-h-48 overflow-y-auto">
                    {d.values.map(({ value, count }) => (
                      <button
                        key={value}
                        onClick={() => { filterDimTo(d, value); setOpenKey(null); }}
                        className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left text-text/90 hover:bg-surface-alt hover:text-accent"
                      >
                        <span className="truncate">{d.dim.display ? d.dim.display(value) : value}</span>
                        <span className="text-[10px] text-text-faint tabular-nums">{count}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </span>
        );
      })}
      {summary.shared.length > 0 && (
        <span
          className="ml-auto truncate text-text-faint"
          title={`Shared by every plotted run:\n${summary.shared.map((s) => `${s.dim.label}: ${s.dim.display ? s.dim.display(s.value) : s.value}`).join("\n")}`}
        >
          shared: {summary.shared.slice(0, 5).map((s) => (s.dim.display ? s.dim.display(s.value) : s.value)).join(" · ")}
          {summary.shared.length > 5 && ` +${summary.shared.length - 5}`}
        </span>
      )}
    </div>
  );
}

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
