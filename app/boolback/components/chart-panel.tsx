"use client";

// app/boolback/components/chart-panel.tsx — the Chart center view.
//
// A single scatter over the SAME filtered row set as the table (the filter
// bar stays above both views) that answers the campaign's real questions:
// "does outcome Y move with function-complexity X, and does the context
// moderate it?"
//
//   X = any snapshot metric (FUNCTION group listed first in its select)
//   Y = any snapshot metric (OUTCOME/DEFENSE listed first in its select) —
//       per-method DEFENSE/INTERP/SCAN entries ("asr drop · beear") plot one
//       method's values instead of the generic best-of-methods rollup
//   color = a facet (arity, trigger form, model, …); legend keys CLICK to
//           toggle that value in the facet filter
//   mode = one point per RUN; one point per FUNCTION (mean over its runs,
//          sized by run count, ±1 SD whiskers); or MEANS — mean Y per
//          (X value × color) group over the filtered runs, connected per
//          color, so "the average effect of X on Y across everything else"
//          reads directly (continuous X falls back to equal-width bins)
//   trend = per-color OLS fit lines + Pearson r (overall r/ρ in the readout;
//           in means mode the readout is computed over the underlying runs)
//   log   = per-axis log10 toggles (non-positive values dropped, counted)
//
// Hover a point for its identity + values; click a run point to open its
// drawer; click a function point to scope the filters to that function.
// Drag a rectangle on the background to add X+Y range filters (which also
// zooms, since the chart rescales to the filtered set). The row hovered or
// selected elsewhere (table/tree) is ring-highlighted here.
//
// Pure SVG — no chart library. Descriptive stats only (lib/stats.ts): the
// boundary rule says inferential statistics come from CMT, never the browser.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Bundle, ChartConfig, FacetKey, MetricSchemaEntry, RunRow } from "../lib/types";
import { DEFAULT_CHART } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { facetValue, numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import {
  groupedMetricOptions, X_GROUP_ORDER, Y_GROUP_ORDER, type MetricGroupName,
} from "../lib/metrics";
import { mean, niceTicks, olsFit, pearson, spearman, stdDev } from "../lib/stats";
import { groupMeans } from "../lib/aggregate";
import { toCsv } from "../lib/export";
import { fnText, hash01, shortModel } from "../lib/format";

/** What the shared Export menu needs from the mounted chart. */
export interface ChartExportHandle {
  getSvg: () => SVGSVGElement | null;
  getCsv: () => string;
}

const COLOR_FACETS: Array<{ key: ChartConfig["color"]; label: string }> = [
  { key: "none", label: "single color" },
  { key: "arity", label: "arity" },
  { key: "triggerForm", label: "trigger form" },
  { key: "source", label: "source" },
  { key: "targetBehavior", label: "target behavior" },
  { key: "task", label: "task" },
  { key: "baseModel", label: "model" },
  { key: "tuning", label: "tuning" },
  { key: "judge", label: "judge" },
];

const PALETTE = [
  "#e8a040", "#38bdf8", "#4ade80", "#e879f9",
  "#f87171", "#c9b35f", "#6fb6a6", "#b48ad6",
];

// Geometry (viewBox units; the SVG scales to the pane).
const W = 820;
const H = 430;
const PAD = { l: 56, r: 16, t: 14, b: 40 };
const MIN_DRAG = 8; // viewBox units before a drag counts as a box-select

interface Pt {
  rx: number; // raw x value (CSV / tooltip)
  ry: number;
  tx: number; // transformed (log?) value — stats + position
  ty: number;
  jx: number; // display-only jitter offset (count metrics, linear axis)
  r: number;
  color: string;
  key: string; // legend key (display)
  raw: string | null; // raw facet value behind the key (legend click target)
  label: string[];
  runId?: string; // runs mode -> open drawer
  fh?: string; // functions mode -> scope chip
  n?: number; // functions mode: run count
  ex?: number | null; // functions mode: ±1 SD whisker half-lengths (transformed)
  ey?: number | null;
}

function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

function MetricSelect({
  value,
  onChange,
  schema,
  ariaLabel,
  order,
}: {
  value: string;
  onChange: (name: string) => void;
  schema: MetricSchemaEntry[];
  ariaLabel: string;
  order: MetricGroupName[];
}) {
  const { groups, empty } = useMemo(
    () => groupedMetricOptions(schema, order),
    [schema, order],
  );
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-44 rounded-md border border-border bg-surface px-1 py-0.5 text-xs text-text focus:border-accent/60 focus:outline-none"
    >
      {groups.map(([group, entries]) => (
        <optgroup key={group} label={group}>
          {entries.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label}
            </option>
          ))}
        </optgroup>
      ))}
      {empty.length > 0 && (
        <optgroup label="no data yet">
          {empty.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
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
  const toggleFacetValue = useBoolbackStore((s) => s.toggleFacetValue);
  const filters = useBoolbackStore((s) => s.filters);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const config = useBoolbackStore((s) => s.chart);
  const setChart = useBoolbackStore((s) => s.setChart);

  const [hover, setHover] = useState<Pt | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragMoved = useRef(false);

  // Guard a persisted/shared config whose metric no longer exists in the schema.
  const x = index[config.x] ? config.x : DEFAULT_CHART.x in index ? DEFAULT_CHART.x : (bundle.metric_schema[0]?.name ?? "");
  const y = index[config.y] ? config.y : DEFAULT_CHART.y in index ? DEFAULT_CHART.y : (bundle.metric_schema[0]?.name ?? "");
  const mode = config.mode === "functions" || config.mode === "means" ? config.mode : "runs";
  const logX = !!config.logX;
  const logY = !!config.logY;

  const { points, colorKeys, droppedLog, legendFacet, underlying, binned } = useMemo(() => {
    const xId = metricColumnId(x, index);
    const yId = metricColumnId(y, index);
    // Count metrics stack points on integer columns; a small deterministic
    // per-run jitter keeps them readable without lying about the value much.
    // (Suppressed on a log axis, where a fixed offset would distort.)
    const jitterX = mode === "runs" && index[x]?.dtype === "count" && !logX;
    const facet: FacetKey | null =
      mode === "functions" ? "arity" : config.color === "none" ? null : (config.color as FacetKey);
    const colorOf = new Map<string, string>();
    const rawOf = new Map<string, string | null>();
    const keyOf = (r: RunRow): { key: string; raw: string | null } => {
      if (mode === "functions") {
        return { key: `arity ${r.function.arity}`, raw: String(r.function.arity) };
      }
      if (facet === null) return { key: "runs", raw: null };
      const v = facetValue(r, facet);
      if (v === null) return { key: "—", raw: null };
      return { key: facet === "baseModel" ? shortModel(v) : v, raw: v };
    };

    let dropped = 0;
    const tXY = (r: RunRow): { rx: number; ry: number; tx: number; ty: number } | null => {
      const vx = numericValue(r, xId);
      const vy = numericValue(r, yId);
      if (vx === null || vy === null) return null;
      if ((logX && vx <= 0) || (logY && vy <= 0)) {
        dropped++;
        return null;
      }
      return {
        rx: vx,
        ry: vy,
        tx: logX ? Math.log10(vx) : vx,
        ty: logY ? Math.log10(vy) : vy,
      };
    };

    const raw: Pt[] = [];
    const pairs: Array<{ x: number; y: number; key: string }> = []; // means-mode input
    let isBinned = false;
    if (mode === "runs") {
      for (const r of rows) {
        const v = tXY(r);
        if (!v) continue;
        const k = keyOf(r);
        raw.push({
          ...v,
          jx: jitterX ? (hash01(r.identity.run_id) - 0.5) * 0.5 : 0,
          r: 3,
          color: "",
          key: k.key,
          raw: k.raw,
          runId: r.identity.node_path,
          label: [
            `${fnText(r.function.arity, r.function.truth_table)} · ${r.identity.run_id}`,
            `${index[x]?.label ?? x}: ${tickFmt(v.rx)}`,
            `${index[y]?.label ?? y}: ${tickFmt(v.ry)}`,
          ],
        });
      }
    } else if (mode === "means") {
      // Mean Y per (X value × color) group over the filtered runs — "the
      // average effect of X on Y" with everything unfaceted averaged over.
      for (const r of rows) {
        const v = tXY(r);
        if (!v) continue;
        const k = keyOf(r);
        pairs.push({ x: v.tx, y: v.ty, key: k.key });
        if (!rawOf.has(k.key)) rawOf.set(k.key, k.raw);
      }
      const grouped = groupMeans(pairs);
      isBinned = grouped.binned;
      for (const p of grouped.points) {
        raw.push({
          rx: p.x,
          ry: p.mean,
          tx: p.x,
          ty: p.mean,
          jx: 0,
          r: Math.min(10, 3 + Math.sqrt(p.n)),
          color: "",
          key: p.key,
          raw: rawOf.get(p.key) ?? null,
          n: p.n,
          ex: null,
          ey: p.sd,
          label: [
            `${p.key} · ${p.n} run${p.n === 1 ? "" : "s"}`,
            `${index[x]?.label ?? x}: ${tickFmt(p.x)}${isBinned ? " (bin center)" : ""}${logX ? " (log10)" : ""}`,
            `mean ${index[y]?.label ?? y}: ${tickFmt(p.mean)}${p.sd !== null ? ` ± ${tickFmt(p.sd)}` : ""}${logY ? " (log10)" : ""}`,
          ],
        });
      }
    } else {
      const byFn = new Map<string, { xs: number[]; ys: number[]; rxs: number[]; rys: number[]; row: RunRow }>();
      for (const r of rows) {
        const v = tXY(r);
        if (!v) continue;
        const slot = byFn.get(r.identity.function_hash) ?? { xs: [], ys: [], rxs: [], rys: [], row: r };
        slot.xs.push(v.tx);
        slot.ys.push(v.ty);
        slot.rxs.push(v.rx);
        slot.rys.push(v.ry);
        byFn.set(r.identity.function_hash, slot);
      }
      for (const [fh, { xs, ys, rxs, rys, row }] of byFn) {
        const mx = mean(xs)!;
        const my = mean(ys)!;
        const k = keyOf(row);
        raw.push({
          rx: mean(rxs)!,
          ry: mean(rys)!,
          tx: mx,
          ty: my,
          jx: 0,
          r: Math.min(10, 3 + Math.sqrt(xs.length)),
          color: "",
          key: k.key,
          raw: k.raw,
          fh,
          n: xs.length,
          ex: stdDev(xs),
          ey: stdDev(ys),
          label: [
            `${fnText(row.function.arity, row.function.truth_table)} · ${xs.length} run${xs.length === 1 ? "" : "s"}`,
            `${index[x]?.label ?? x}: ${tickFmt(mx)}`,
            `mean ${index[y]?.label ?? y}: ${tickFmt(my)}${ys.length > 1 && stdDev(ys) !== null ? ` ± ${tickFmt(stdDev(ys)!)}` : ""}`,
          ],
        });
      }
    }

    const keys = [...new Set(raw.map((p) => p.key))].sort();
    keys.forEach((k, i) => colorOf.set(k, PALETTE[i % PALETTE.length]));
    for (const p of raw) {
      p.color = colorOf.get(p.key) ?? PALETTE[0];
      if (!rawOf.has(p.key)) rawOf.set(p.key, p.raw);
    }
    return {
      points: raw,
      colorKeys: keys.map((k) => ({ key: k, color: colorOf.get(k)!, raw: rawOf.get(k) ?? null })),
      droppedLog: dropped,
      legendFacet: facet,
      underlying: mode === "means" ? pairs : null,
      binned: isBinned,
    };
  }, [rows, x, y, mode, config.color, logX, logY, index]);

  // Scales over the TRANSFORMED values.
  const scale = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const px = p.tx + p.jx;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (p.ty < y0) y0 = p.ty;
      if (p.ty > y1) y1 = p.ty;
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
    return { sx, sy, ix, iy, x0, x1, y0, y1, xTicks: niceTicks(x0, x1, 5), yTicks: niceTicks(y0, y1, 5) };
  }, [points]);

  // Trend fits (per color group) + the overall correlation readout. In means
  // mode r/ρ come from the UNDERLYING runs (r over group means would overstate
  // the association) and the per-color connecting lines replace the OLS fits.
  const stats = useMemo(() => {
    if (mode === "means") {
      if (!underlying || underlying.length < 2) return null;
      const xs = underlying.map((p) => p.x);
      const ys = underlying.map((p) => p.y);
      return {
        overall: { r: pearson(xs, ys), rho: spearman(xs, ys), n: underlying.length },
        lines: [] as Array<{ key: string; fit: { slope: number; intercept: number }; lo: number; hi: number; r: number | null }>,
      };
    }
    if (!config.trend || points.length < 2) return null;
    const xsAll = points.map((p) => p.tx);
    const ysAll = points.map((p) => p.ty);
    const overall = { r: pearson(xsAll, ysAll), rho: spearman(xsAll, ysAll), n: points.length };
    const perKey = new Map<string, { xs: number[]; ys: number[] }>();
    for (const p of points) {
      const slot = perKey.get(p.key) ?? { xs: [], ys: [] };
      slot.xs.push(p.tx);
      slot.ys.push(p.ty);
      perKey.set(p.key, slot);
    }
    const lines = [...perKey.entries()]
      .map(([key, { xs, ys }]) => {
        const fit = olsFit(xs, ys);
        if (!fit) return null;
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        return { key, fit, lo, hi, r: pearson(xs, ys) };
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    return { overall, lines };
  }, [config.trend, points, mode, underlying]);

  const rByKey = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const l of stats?.lines ?? []) m.set(l.key, l.r);
    return m;
  }, [stats]);

  // Tick labels un-transform on a log axis (positions stay in log space).
  const xTickLabel = (t: number) => (logX ? tickFmt(Math.pow(10, t)) : tickFmt(t));
  const yTickLabel = (t: number) => (logY ? tickFmt(Math.pow(10, t)) : tickFmt(t));

  const onPointClick = (p: Pt) => {
    if (dragMoved.current) return; // a box-select drag just ended
    if (p.runId) {
      openDetail(p.runId);
      const r = rows.find((row) => row.identity.node_path === p.runId);
      if (r) expandChain(r.identity.chain_dirs);
    } else if (p.fh) {
      addSubtreeDir(`fn=${p.fh}`);
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
        const xL = index[x]?.label ?? x;
        const yL = index[y]?.label ?? y;
        if (mode === "runs") {
          const head = ["run_id", xL, yL, legendFacet ?? "color"];
          return toCsv([head, ...points.map((p) => [p.runId ?? "", p.rx, p.ry, p.key])]);
        }
        if (mode === "means") {
          // Values are in plotted space (log10 when that axis is logged).
          const head = [
            `${xL}${logX ? " (log10)" : ""}`,
            legendFacet ?? "group",
            "n",
            `${yL}${logY ? " (log10)" : ""} (mean)`,
            `${yL} (sd)`,
          ];
          return toCsv([head, ...points.map((p) => [p.tx, p.key, p.n ?? 0, p.ty, p.ey ?? ""])]);
        }
        const head = ["function", "runs", `${xL} (mean)`, `${yL} (mean)`, `${xL} (sd)`, `${yL} (sd)`];
        return toCsv([head, ...points.map((p) => [p.fh ?? "", p.n ?? 0, p.rx, p.ry, p.ex ?? "", p.ey ?? ""])]);
      },
    };
    return () => { exportRef.current = null; };
  }, [exportRef, points, x, y, mode, index, legendFacet, logX, logY]);

  // The point linked to the row hovered/selected elsewhere (table / tree).
  const linked = useMemo(() => {
    if (mode !== "runs") return [];
    return points.filter(
      (p) => p.runId !== undefined && (p.runId === selectedDir || p.runId === hoveredDir),
    );
  }, [points, hoveredDir, selectedDir, mode]);

  const legendSelected = legendFacet ? (filters.facets[legendFacet] ?? []) : [];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* axis / color / mode controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/60">
        <span className="text-xs text-text-faint font-mono">y</span>
        <MetricSelect value={y} onChange={(v) => setChart({ y: v })} schema={bundle.metric_schema} ariaLabel="y metric" order={Y_GROUP_ORDER} />
        <AxisToggle label="log" checked={logY} onChange={(b) => setChart({ logY: b })} />
        <span className="text-xs text-text-faint font-mono">vs x</span>
        <MetricSelect value={x} onChange={(v) => setChart({ x: v })} schema={bundle.metric_schema} ariaLabel="x metric" order={X_GROUP_ORDER} />
        <AxisToggle label="log" checked={logX} onChange={(b) => setChart({ logX: b })} />
        <span className="text-xs text-text-faint font-mono">color</span>
        <select
          value={mode === "functions" ? "arity" : config.color}
          disabled={mode === "functions"}
          aria-label="color facet"
          onChange={(e) => setChart({ color: e.target.value as ChartConfig["color"] })}
          className="rounded-md border border-border bg-surface px-1 py-0.5 text-xs text-text disabled:opacity-50 focus:border-accent/60 focus:outline-none"
          title={mode === "functions" ? "function points are colored by arity" : undefined}
        >
          {COLOR_FACETS.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {([
            { m: "runs", label: "runs", title: "one point per training run" },
            { m: "functions", label: "functions (mean)", title: "one point per function — mean over its runs, sized by run count" },
            { m: "means", label: "means", title: "mean ± SD of Y per (X × color) group over the filtered runs — the average effect of X on Y" },
          ] as const).map(({ m, label, title }) => (
            <button
              key={m}
              type="button"
              title={title}
              onClick={() => setChart({ mode: m })}
              className={`px-2 py-0.5 transition-colors ${mode === m ? "bg-accent/15 text-accent" : "bg-surface text-text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode !== "means" && (
          <AxisToggle label="trend" checked={!!config.trend} onChange={(b) => setChart({ trend: b })} />
        )}
        <span className="ml-auto text-xs text-text-faint font-mono">
          {stats?.overall && (
            <span
              className="text-text-muted"
              title={
                mode === "means"
                  ? `Pearson r · Spearman ρ over the ${stats.overall.n.toLocaleString()} underlying runs (descriptive)`
                  : "Pearson r · Spearman ρ over the plotted points (descriptive — see plan §5)"
              }
            >
              r={stats.overall.r === null ? "—" : stats.overall.r.toFixed(2)}
              {" · "}ρ={stats.overall.rho === null ? "—" : stats.overall.rho.toFixed(2)}
              {mode === "means" && " (runs)"}
              {" · "}
            </span>
          )}
          {points.length.toLocaleString()} {mode === "means" ? `group${points.length === 1 ? "" : "s"} of ${(underlying?.length ?? 0).toLocaleString()} runs` : `point${points.length === 1 ? "" : "s"}`}
          {binned && <span title="X has too many distinct values — grouped into 12 equal-width bins (points at bin centers)"> · x binned</span>}
          {droppedLog > 0 && <span title="values ≤ 0 cannot be shown on a log axis"> · {droppedLog} dropped (log)</span>}
          {mode === "runs" && " · click a point for details · drag to filter"}
          {mode === "functions" && " · click a point to scope · drag to filter"}
          {mode === "means" && " · drag to filter"}
        </span>
      </div>

      {/* plot */}
      <div className="relative flex-1 min-h-0 px-2 py-1">
        {points.length === 0 ? (
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

            {/* means-mode per-color connecting lines (under points + whiskers) */}
            {mode === "means" && (
              <g clipPath="url(#bb-plot-clip)">
                {colorKeys.map(({ key, color }) => {
                  const line = points.filter((p) => p.key === key); // already x-sorted
                  if (line.length < 2) return null;
                  const d = line
                    .map((p, i) => `${i === 0 ? "M" : "L"}${scale.sx(p.tx)},${scale.sy(p.ty)}`)
                    .join(" ");
                  return (
                    <path key={key} d={d} fill="none" stroke={color}
                      strokeWidth={1.5} strokeOpacity={0.85} pointerEvents="none" />
                  );
                })}
              </g>
            )}

            {/* ±1 SD whiskers (functions + means modes; under the points) */}
            {(mode === "functions" || mode === "means") && (
              <g clipPath="url(#bb-plot-clip)">
                {points.map((p, i) => (
                  <g key={`w${i}`} stroke={p.color} strokeOpacity={0.5} strokeWidth={1}>
                    {p.ey !== null && p.ey !== undefined && p.ey > 0 && (
                      <line x1={scale.sx(p.tx)} y1={scale.sy(p.ty - p.ey)} x2={scale.sx(p.tx)} y2={scale.sy(p.ty + p.ey)} />
                    )}
                    {p.ex !== null && p.ex !== undefined && p.ex > 0 && (
                      <line x1={scale.sx(p.tx - p.ex)} y1={scale.sy(p.ty)} x2={scale.sx(p.tx + p.ex)} y2={scale.sy(p.ty)} />
                    )}
                  </g>
                ))}
              </g>
            )}

            {/* visible points */}
            <g>
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={scale.sx(p.tx + p.jx)}
                  cy={scale.sy(p.ty)}
                  r={p.r}
                  fill={p.color}
                  fillOpacity={0.6}
                  stroke={p.color}
                  strokeOpacity={0.9}
                  pointerEvents="none"
                />
              ))}
            </g>

            {/* linked-row highlight rings (row hovered/selected in table or tree) */}
            {linked.map((p, i) => (
              <circle
                key={`h${i}`}
                cx={scale.sx(p.tx + p.jx)}
                cy={scale.sy(p.ty)}
                r={p.r + 3}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
            ))}

            {/* trend lines */}
            {stats && (
              <g clipPath="url(#bb-plot-clip)">
                {stats.lines.map((l) => {
                  const color = colorKeys.find((c) => c.key === l.key)?.color ?? PALETTE[0];
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

            {/* invisible hit targets (on top; generous radius — #6) */}
            <g>
              {points.map((p, i) => (
                <circle
                  key={`t${i}`}
                  cx={scale.sx(p.tx + p.jx)}
                  cy={scale.sy(p.ty)}
                  r={Math.max(9, p.r + 5)}
                  fill="transparent"
                  className="cursor-pointer"
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

        {/* tooltip (flips sides near the right edge — #6) */}
        {hover && (() => {
          const px = scale.sx(hover.tx + hover.jx);
          const py = scale.sy(hover.ty);
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

      {/* legend — keys CLICK to toggle the facet filter (#5) */}
      {points.length > 0 && colorKeys.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11px] text-text-muted">
          {colorKeys.slice(0, 12).map(({ key, color, raw }) => {
            const clickable = legendFacet !== null && raw !== null;
            const active = clickable && legendSelected.includes(raw);
            const dimmed = clickable && legendSelected.length > 0 && !active;
            const r = rByKey.get(key);
            return (
              <button
                key={key}
                type="button"
                disabled={!clickable}
                onClick={() => clickable && toggleFacetValue(legendFacet, raw)}
                title={clickable ? `toggle ${legendFacet}: ${raw}` : undefined}
                className={[
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors",
                  clickable ? "cursor-pointer hover:bg-surface-alt" : "cursor-default",
                  active ? "ring-1 ring-accent/60 text-text" : "",
                  dimmed ? "opacity-40" : "",
                ].join(" ")}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {key}
                {r !== undefined && r !== null && (
                  <span className="text-text-faint">r={r.toFixed(2)}</span>
                )}
              </button>
            );
          })}
          {colorKeys.length > 12 && <span>+{colorKeys.length - 12} more</span>}
        </div>
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
