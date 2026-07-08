"use client";

// app/boolback/components/group-plot.tsx — the Group Plot center view: the same
// Plot config faceted across one dimension's values. Every panel is the
// identical plot (shared axes, consistent styling); panels vary across the
// facet dim. Clicking a panel PROMOTES it — the facet value becomes a filter
// and the view switches back to the big Plot.
//
// Panels share one ChartConfig with the Plot tab (facetDim is what makes this
// the group view; the Plot render path ignores it). Styling ordinals are
// computed GLOBALLY (over all rows) so colors/shapes mean the same thing in
// every panel. Rendering is windowed (IntersectionObserver) since 100 SVG
// panels with ghosts is real work.

import { useMemo, useState } from "react";
import type { Bundle, RunRow, Channel } from "../lib/types";
import { DEFAULT_GROUP_PLOT } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import {
  PARAMETERS, summarizeParameters, resolveChannels,
  type ParamValues,
} from "../lib/parameters";
import { groupRuns } from "../lib/aggregate";
import { buildRunSeries, groupSeries, trajectoryMetric } from "../lib/trajectories";
import { niceTicks } from "../lib/stats";
import { colorForValue, SINGLE_COLOR } from "../lib/styling";
import { shapeNode } from "./glyph";
import { effectiveAxis } from "./plot-panel";

const PW = 260, PH = 176; // panel logical size (viewBox); CSS scales it
const PAD = { l: 34, r: 8, t: 8, b: 20 };
const MAX_FACETS = 150;

type Extent = { x0: number; x1: number; y0: number; y1: number };

export function GroupPlotBody({
  rows, bundle, index,
}: {
  rows: RunRow[];
  bundle: Bundle;
  index: MetricIndex;
}) {
  const config = useBoolbackStore((s) => s.groupPlot);
  const setGroupPlot = useBoolbackStore((s) => s.setGroupPlot);
  const setCenterView = useBoolbackStore((s) => s.setCenterView);
  const setFacet = useBoolbackStore((s) => s.setFacet);
  const openDetail = useBoolbackStore((s) => s.openDetail);
  // Filters live INSIDE the group-plot config.
  const filters = config.filters;

  const facetDef = config.facet ? PARAMETERS.find((d) => d.key === config.facet) ?? null : null;
  const panelMin = config.panelMin || DEFAULT_GROUP_PLOT.panelMin;

  const lineMode = config.x === "epoch";
  const xName = lineMode ? "epoch" : effectiveAxis(config.x, index, bundle.metric_schema, DEFAULT_GROUP_PLOT.x);
  const yName = lineMode
    ? (trajectoryMetric(config.y) ?? "plantedness")
    : effectiveAxis(config.y, index, bundle.metric_schema, DEFAULT_GROUP_PLOT.y);
  const logX = !!config.logX;
  const logY = !!config.logY;

  // ---- global dimension model (facet dim excluded — it drives the panels) ----
  const summary = useMemo(() => summarizeParameters(rows), [rows]);
  const diffByKey = useMemo(
    () => new Map(summary.differing.map((d) => [d.dim.key, d])),
    [summary],
  );
  const splits = useMemo(
    () => (config.splits ?? []).filter((k) => k !== config.facet && diffByKey.has(k)),
    [config.splits, config.facet, diffByKey],
  );
  const channelByDim = useMemo(
    () => resolveChannels(splits, config.channels ?? {}, (k) => diffByKey.get(k)?.values.length ?? 0),
    [splits, config.channels, diffByKey],
  );
  const channelDims = useMemo(() => {
    const m = new Map<Channel, ParamValues>();
    for (const d of summary.differing) {
      const ch = channelByDim.get(d.dim.key);
      if (ch) m.set(ch, d);
    }
    return m;
  }, [summary, channelByDim]);
  const colorDim = channelDims.get("color");
  const shapeDim = channelDims.get("shape");
  const sizeDim = channelDims.get("size");
  const splitDims = useMemo(() => {
    const order: Channel[] = ["color", "shape", "size", "dash"];
    return order.map((ch) => channelDims.get(ch)).filter((d): d is ParamValues => d !== undefined);
  }, [channelDims]);
  const ordinal = (d: ParamValues | undefined) => {
    const m = new Map<string, number>();
    d?.values.forEach((v, i) => m.set(v.value, i));
    return m;
  };
  const colorIdx = useMemo(() => ordinal(colorDim), [colorDim]);
  const shapeIdx = useMemo(() => ordinal(shapeDim), [shapeDim]);
  const sizeIdx = useMemo(() => ordinal(sizeDim), [sizeDim]);
  const averaging = useMemo(
    () => summary.differing.some((d) => d.dim.key !== config.facet && !channelByDim.has(d.dim.key)),
    [summary, config.facet, channelByDim],
  );
  const activeJudge = useMemo(() => {
    const j = filters.facets?.judge;
    return j && j.length === 1 ? j[0] : null;
  }, [filters.facets]);
  const valueStyles = config.valueStyles ?? {};

  // ---- facet values (sorted, cardinality-capped) ----------------------------
  const facets = useMemo(() => {
    if (!facetDef) return { list: [] as Array<{ value: string; count: number; rows: RunRow[] }>, hidden: 0 };
    const groups = new Map<string, RunRow[]>();
    for (const r of rows) {
      const v = facetDef.raw(r);
      if (v === null) continue;
      const arr = groups.get(v);
      if (arr) arr.push(r); else groups.set(v, [r]);
    }
    let list = [...groups.entries()].map(([value, rs]) => ({ value, count: rs.length, rows: rs }));
    list.sort(
      facetDef.numericSort
        ? (a, b) => Number(a.value) - Number(b.value)
        : (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
    let hidden = 0;
    if (list.length > MAX_FACETS) {
      hidden = list.length - MAX_FACETS;
      list = [...list].sort((a, b) => b.count - a.count).slice(0, MAX_FACETS);
      list.sort(
        facetDef.numericSort
          ? (a, b) => Number(a.value) - Number(b.value)
          : (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
      );
    }
    return { list, hidden };
  }, [facetDef, rows]);

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
        const { series } = buildRunSeries(rows, metric, () => [], activeJudge, logY);
        for (const s of series) for (const p of s.points) acc(logX ? (p.e > 0 ? Math.log10(p.e) : NaN) : p.e, p.y);
      }
    } else {
      const xId = metricColumnId(xName, index);
      const yId = metricColumnId(yName, index);
      for (const r of rows) {
        const vx = numericValue(r, xId);
        const vy = numericValue(r, yId);
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
    const tf = (v: number, log: boolean) => (log ? Math.log10(Math.max(v, 1e-12)) : v);
    if (config.xDomain) { x0 = tf(config.xDomain[0], logX); x1 = tf(config.xDomain[1], logX); }
    if (config.yDomain) { y0 = tf(config.yDomain[0], logY); y1 = tf(config.yDomain[1], logY); }
    return { x0, x1, y0, y1 };
  }, [rows, lineMode, xName, yName, index, logX, logY, activeJudge, config.xDomain, config.yDomain]);

  // Shared logical-space scale (fixed panel viewBox → aligned axes everywhere).
  const sx = (v: number) => PAD.l + ((v - extent.x0) / (extent.x1 - extent.x0)) * (PW - PAD.l - PAD.r);
  const sy = (v: number) => PH - PAD.b - ((v - extent.y0) / (extent.y1 - extent.y0)) * (PH - PAD.t - PAD.b);

  const dispFacet = (v: string) => (facetDef?.display ? facetDef.display(v) : v);

  // ---- promote: facet value becomes a filter on the PLOT view, land there.
  // (The `function` parameter has no facetKey in Phase 1, so promoting it only
  // switches views — no filter, per the subtree-scope removal.) --------------
  const promote = (value: string) => {
    if (facetDef?.facetKey) setFacet("plot", facetDef.facetKey, [value]);
    setGroupPlot({ facet: null });
    setCenterView("plot");
  };

  const panelCtx = { xName, yName, logX, logY, splitDims, colorDim, shapeDim, sizeDim, colorIdx, shapeIdx, sizeIdx, valueStyles, averaging, lineMode, activeJudge, index, band: !!config.band, ghosts: !!config.ghosts, sx, sy };

  if (!facetDef) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <FacetPicker current={null} onPick={(k) => setGroupPlot({ facet: k, splits: (config.splits ?? []).filter((s) => s !== k) })} rows={rows} />
        <p className="mt-3 text-xs text-text-faint">Choose a dimension to facet the plot across — one panel per value.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* control strip */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-3 py-1.5 text-xs">
        <span className="text-text-faint">facet:</span>
        <FacetPicker current={facetDef.key} onPick={(k) => setGroupPlot({ facet: k, splits: (config.splits ?? []).filter((s) => s !== k) })} rows={rows} />
        <span className="text-text-muted">{facets.list.length} panels{facets.hidden > 0 ? ` · ${facets.hidden} more not shown` : ""}</span>
        <label className="ml-auto flex items-center gap-1 text-text-muted">
          panel size
          <input
            type="range" min={160} max={480} step={20} value={panelMin}
            onChange={(e) => setGroupPlot({ panelMin: Number(e.target.value) })}
            className="accent-accent"
            aria-label="panel size"
          />
        </label>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${panelMin}px, 1fr))`, gap: 8, alignContent: "start" }}
      >
        {facets.list.map((f) => (
          <LazyPanel key={f.value} minHeight={panelMin * (PH / PW) + 22}>
            <button
              type="button"
              onClick={() => promote(f.value)}
              title={`promote — filter to ${facetDef.label}: ${dispFacet(f.value)} and open the full Plot`}
              className="flex w-full items-center justify-between gap-2 truncate px-1 pt-1 text-left text-[11px] text-text-muted hover:text-accent"
            >
              <span className="truncate">{dispFacet(f.value) || "—"}</span>
              <span className="shrink-0 text-text-faint">{f.count}</span>
            </button>
            <Panel rows={f.rows} ctx={panelCtx} onOpenRun={openDetail} />
          </LazyPanel>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One facet panel — a lean plot in shared logical coordinates.
// ---------------------------------------------------------------------------

type PanelCtx = {
  xName: string; yName: string; logX: boolean; logY: boolean;
  splitDims: ParamValues[];
  colorDim?: ParamValues; shapeDim?: ParamValues; sizeDim?: ParamValues;
  colorIdx: Map<string, number>; shapeIdx: Map<string, number>; sizeIdx: Map<string, number>;
  valueStyles: Record<string, Record<string, import("../lib/types").ValueStyle>>;
  averaging: boolean; lineMode: boolean; activeJudge: string | null;
  index: MetricIndex; band: boolean; ghosts: boolean;
  sx: (v: number) => number; sy: (v: number) => number;
};

function Panel({ rows, ctx, onOpenRun }: { rows: RunRow[]; ctx: PanelCtx; onOpenRun: (id: string) => void }) {
  const colorOf = (dims: string[]) => {
    if (!ctx.colorDim) return SINGLE_COLOR;
    const ci = ctx.splitDims.indexOf(ctx.colorDim);
    const v = dims[ci];
    return colorForValue(ctx.colorDim.dim.key, v, ctx.colorIdx.get(v) ?? 0, ctx.valueStyles);
  };
  const shapeOf = (dims: string[]) => {
    if (!ctx.shapeDim) return 0;
    const si = ctx.splitDims.indexOf(ctx.shapeDim);
    const v = dims[si];
    return ctx.shapeIdx.get(v) ?? 0;
  };

  const content = useMemo(() => {
    const dimsOf = (r: RunRow) => ctx.splitDims.map((d) => d.dim.raw(r) ?? "—");
    if (ctx.lineMode) {
      const metric = trajectoryMetric(ctx.yName);
      if (!metric) return null;
      const { series } = buildRunSeries(rows, metric, dimsOf, ctx.activeJudge, ctx.logY);
      const groups = groupSeries(series);
      return { kind: "line" as const, series, groups };
    }
    const xId = metricColumnId(ctx.xName, ctx.index);
    const yId = metricColumnId(ctx.yName, ctx.index);
    const pts = [];
    for (const r of rows) {
      const vx = numericValue(r, xId);
      const vy = numericValue(r, yId);
      if (vx === null || vy === null) continue;
      if ((ctx.logX && vx <= 0) || (ctx.logY && vy <= 0)) continue;
      pts.push({
        x: ctx.logX ? Math.log10(vx) : vx,
        y: ctx.logY ? Math.log10(vy) : vy,
        runId: r.identity.node_path,
        dims: dimsOf(r),
      });
    }
    const grouped = groupRuns(pts, ctx.averaging);
    return { kind: "scatter" as const, grouped };
  }, [rows, ctx]);

  const txX = (e: number) => (ctx.logX ? Math.log10(Math.max(e, 1e-12)) : e);

  return (
    <svg viewBox={`0 0 ${PW} ${PH}`} className="w-full" role="img">
      <rect x={PAD.l} y={PAD.t} width={PW - PAD.l - PAD.r} height={PH - PAD.t - PAD.b} fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={0.5} />
      <clipPath id="gp-clip"><rect x={PAD.l} y={PAD.t} width={PW - PAD.l - PAD.r} height={PH - PAD.t - PAD.b} /></clipPath>

      {content?.kind === "scatter" && (
        <g clipPath="url(#gp-clip)">
          {ctx.ghosts && content.grouped.ghosts.map((g, i) => (
            <circle key={`g${i}`} cx={ctx.sx(g.x)} cy={ctx.sy(g.y)} r={1.1} fill={colorOf(g.dims)} fillOpacity={0.16} />
          ))}
          {content.grouped.points.map((p, i) => {
            const color = colorOf(p.dims);
            if (ctx.band && p.sdY !== null && p.sdY > 0) {
              // whisker drawn inline below
            }
            const r = ctx.sizeDim ? 2 + Math.min(4, (ctx.sizeIdx.get(p.dims[ctx.splitDims.indexOf(ctx.sizeDim)]) ?? 0) * 1.1) : (p.n > 1 ? Math.min(6, 2 + Math.sqrt(p.n)) : 2.4);
            return (
              <g key={`p${i}`}>
                {ctx.band && p.sdY !== null && p.sdY > 0 && (
                  <line x1={ctx.sx(p.x)} y1={ctx.sy(p.y - p.sdY)} x2={ctx.sx(p.x)} y2={ctx.sy(p.y + p.sdY)} stroke={color} strokeOpacity={0.4} strokeWidth={0.75} />
                )}
                {shapeNode(shapeOf(p.dims), ctx.sx(p.x), ctx.sy(p.y), r, { fill: color, fillOpacity: 0.65, stroke: color, strokeOpacity: 0.9 })}
                {p.runId && p.n === 1 && (
                  <circle cx={ctx.sx(p.x)} cy={ctx.sy(p.y)} r={Math.max(4, r + 2)} fill="transparent" className="cursor-pointer" onClick={() => onOpenRun(p.runId!)} />
                )}
              </g>
            );
          })}
        </g>
      )}

      {content?.kind === "line" && (
        <g clipPath="url(#gp-clip)">
          {ctx.band && content.groups.map((g, i) => {
            const withSd = g.points.filter((p) => p.sd !== null && p.sd > 0);
            if (withSd.length < 2) return null;
            const up = withSd.map((p) => `${ctx.sx(txX(p.e))},${ctx.sy(p.y + (p.sd ?? 0))}`);
            const dn = withSd.slice().reverse().map((p) => `${ctx.sx(txX(p.e))},${ctx.sy(p.y - (p.sd ?? 0))}`);
            return <polygon key={`rb${i}`} points={[...up, ...dn].join(" ")} fill={colorOf(g.dims)} fillOpacity={0.1} />;
          })}
          {content.groups.map((g, i) => g.points.length > 1 && (
            <polyline key={`ml${i}`} points={g.points.map((p) => `${ctx.sx(txX(p.e))},${ctx.sy(p.y)}`).join(" ")} fill="none" stroke={colorOf(g.dims)} strokeWidth={1.25} strokeOpacity={0.95} />
          ))}
        </g>
      )}

      {yTicksSvg(ctx)}
      {xTicksSvg(ctx)}
    </svg>
  );
}

// Panel axis ticks (shared scale, computed from ctx.sx/sy via the parent's
// domain — we re-derive nice ticks from the inverse of the mapping).
function yTicksSvg(ctx: PanelCtx) {
  // Derive the visible y-domain back out of the scale for tick placement.
  const yTop = invY(ctx, PAD.t), yBot = invY(ctx, PH - PAD.b);
  const ticks = niceTicks(Math.min(yTop, yBot), Math.max(yTop, yBot), 3);
  return (
    <g>
      {ticks.map((t, i) => (
        <g key={`y${i}`}>
          <line x1={PAD.l} y1={ctx.sy(t)} x2={PW - PAD.r} y2={ctx.sy(t)} stroke="var(--color-border)" strokeOpacity={0.4} strokeWidth={0.4} />
          <text x={PAD.l - 3} y={ctx.sy(t) + 3} fontSize={7} textAnchor="end" fill="var(--color-text-faint)" className="font-mono">{fmtTick(t, ctx.logY)}</text>
        </g>
      ))}
    </g>
  );
}
function xTicksSvg(ctx: PanelCtx) {
  const xL = invX(ctx, PAD.l), xR = invX(ctx, PW - PAD.r);
  const ticks = niceTicks(Math.min(xL, xR), Math.max(xL, xR), 3);
  return (
    <g>
      {ticks.map((t, i) => (
        <text key={`x${i}`} x={ctx.sx(t)} y={PH - PAD.b + 9} fontSize={7} textAnchor="middle" fill="var(--color-text-faint)" className="font-mono">{fmtTick(t, ctx.logX)}</text>
      ))}
    </g>
  );
}
const invX = (ctx: PanelCtx, px: number) => {
  const a = ctx.sx(0), b = ctx.sx(1);
  return (px - a) / (b - a);
};
const invY = (ctx: PanelCtx, py: number) => {
  const a = ctx.sy(0), b = ctx.sy(1);
  return (py - a) / (b - a);
};
const fmtTick = (v: number, log: boolean) => {
  const u = log ? Math.pow(10, v) : v;
  const a = Math.abs(u);
  if (u === 0) return "0";
  if (a >= 1000 || a < 0.01) return u.toExponential(0);
  return String(Number(u.toFixed(2)));
};

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

// ---------------------------------------------------------------------------
// Facet dimension picker.
// ---------------------------------------------------------------------------

function FacetPicker({
  current, onPick, rows,
}: {
  current: string | null;
  onPick: (key: string) => void;
  rows: RunRow[];
}) {
  const [open, setOpen] = useState(false);
  // Only dimensions that actually vary (≥2 values) are useful facets.
  const options = useMemo(() => {
    const summary = summarizeParameters(rows);
    return summary.differing.map((d) => d.dim);
  }, [rows]);
  const cur = PARAMETERS.find((d) => d.key === current);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text hover:border-accent/40"
      >
        {cur ? cur.label : "choose dimension"} <span className="text-text-faint">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-52 overflow-y-auto rounded-lg border border-border bg-surface/95 p-1 text-xs shadow-lg backdrop-blur-md">
            {options.length === 0 && <div className="px-2 py-1 text-text-faint">No varying dimensions</div>}
            {options.map((d) => (
              <button
                key={d.key}
                onClick={() => { onPick(d.key); setOpen(false); }}
                className={`flex w-full items-center rounded px-2 py-1 text-left hover:bg-surface-alt hover:text-accent ${d.key === current ? "text-accent" : "text-text/90"}`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
