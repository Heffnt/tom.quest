"use client";

// app/boolback/components/group-plot.tsx — the Group Plot center view: the same
// Plot config faceted across ONE parameter's values, or across the SETTINGS
// (facet === "setting": one panel per setting, titled with the setting's name
// and matched-run count). Every panel is the identical plot (shared axes,
// consistent styling); panels vary across the facet.
//
// The config panel OWNS the facet choice (groupPlot.facet) and panel size
// (groupPlot.panelMin) — this view only reads them. Panel titles are inert
// (value + run count, hover only); a point inside a panel still opens the run
// inspector.
//
// SERIES MODEL: lib/split-dims.resolveSeries runs GLOBALLY (over all panels'
// rows), so a series' color/shape and the categorical axis positions mean the
// same thing in every panel. Panels carry (row × series) PAIRS: under a
// parameter facet the panel VALUES come from the deduped union, but within a
// panel a run renders once per matching setting-series — the same per-setting
// duplication rule as the main plot; under the setting facet each panel is
// simply that setting's own series. Points group per (series × X bucket)
// exactly like the main plot (mean ± SD whiskers on n>1 groups, per-series
// connecting lines, collapsed-run ghosts) — the legend + warnings live in the
// config panel's settings strip; panels are kept lean. Rendering is windowed
// (content-visibility) since 100 SVG panels with ghosts is work.

import { useDeferredValue, useEffect, useMemo } from "react";
import type { Bundle, RunRow } from "../lib/types";
import { DEFAULT_GROUP_PLOT } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { applyFilters, numericValue, type MetricIndex } from "../lib/select";
import { metricColumnId } from "../lib/columns";
import { PARAMETERS } from "../lib/parameters";
import { resolveSeries, type Series } from "../lib/split-dims";
import { resolveAxis, type Axis } from "../lib/axes";
import { groupRuns, collapsedGhosts, type GroupedPoint, type RunPoint } from "../lib/aggregate";
import {
  buildRunSeries, groupSeries, trajectoryMetric,
  type EpochMetric, type RunSeries,
} from "../lib/trajectories";
import { niceTicks } from "../lib/stats";
import { shapeForValue, gradientColor, NULL_GRADIENT, SINGLE_COLOR } from "../lib/styling";
import { hash01 } from "../lib/format";
import { shapeNode } from "./glyph";
import { effectiveAxis } from "./plot-panel";

/** PARAMETERS lookup for resolveSeries (module-level: stable identity). */
const paramOf = (key: string) => PARAMETERS.find((p) => p.key === key) ?? null;

const PW = 260, PH = 176; // panel logical size (viewBox); CSS scales it
const PAD = { l: 34, r: 8, t: 8, b: 20 };
const MAX_FACETS = 150;

type Extent = { x0: number; x1: number; y0: number; y1: number };

/** A run scheduled into a panel under one series (the duplication unit). */
type PanelPt = { row: RunRow; key: string };

type FacetPanel = { id: string; value: string; count: number; pts: PanelPt[] };

export function GroupPlotBody({
  rows, bundle, index,
}: {
  rows: RunRow[];
  bundle: Bundle;
  index: MetricIndex;
}) {
  // INP: defer the heavy pipeline off the interaction's critical path (see the
  // note in plot-panel.tsx) — a filter click repaints the panel immediately
  // while the faceted panels re-render in a background pass.
  const liveConfig = useBoolbackStore((s) => s.groupPlot);
  const config = useDeferredValue(liveConfig);
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const setPlotUnionCount = useBoolbackStore((s) => s.setPlotUnionCount);

  // Facet: a parameter key OR the literal "setting" (one panel per setting).
  const facetIsSetting = config.facet === "setting";
  const facetDef =
    config.facet && !facetIsSetting ? PARAMETERS.find((d) => d.key === config.facet) ?? null : null;
  const panelMin = config.panelMin || DEFAULT_GROUP_PLOT.panelMin;

  const lineMode = config.x === "epoch";
  const xName = lineMode ? "epoch" : effectiveAxis(config.x, index, bundle.metric_schema, DEFAULT_GROUP_PLOT.x);
  const yName = lineMode
    ? (trajectoryMetric(config.y) ?? "plantedness")
    : effectiveAxis(config.y, index, bundle.metric_schema, DEFAULT_GROUP_PLOT.y);
  // Resolved axes over ALL rows (categories/positions align across panels).
  const axisX = useMemo(() => (lineMode ? null : resolveAxis(xName, index, rows)), [lineMode, xName, index, rows]);
  const axisY = useMemo(() => (lineMode ? null : resolveAxis(yName, index, rows)), [lineMode, yName, index, rows]);
  const logX = !!config.logX && (axisX?.allowLog ?? true);
  const logY = !!config.logY && (axisY?.allowLog ?? true);

  // ---- continuous colorBy encoding ------------------------------------------
  const colorBy = config.colorBy ?? null;
  const colorByActive = !!colorBy && !!index[colorBy];
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
      settings: config.settings,
      ranges: config.ranges,
      splitBy: config.splitBy,
      paramOf,
      applyTo: applyFilters,
    }),
    [rows, config.settings, config.ranges, config.splitBy],
  );
  const seriesByKey = useMemo(
    () => new Map(resolution.series.map((s) => [s.key, s])),
    [resolution.series],
  );
  // De-duplicated union of the settings' matches (shared axes + facet values).
  const unionRows = useMemo(() => [...new Set(resolution.rowsUnion)], [resolution.rowsUnion]);

  // Publish the union's distinct-run count for the shared top bar's counter
  // (cleared on unmount so the table's filtered count takes over).
  useEffect(() => {
    setPlotUnionCount(unionRows.length);
  }, [unionRows, setPlotUnionCount]);
  useEffect(() => () => setPlotUnionCount(null), [setPlotUnionCount]);

  // ---- facet panels (sorted, cardinality-capped) -----------------------------
  const facets = useMemo(() => {
    if (facetIsSetting) {
      // One panel per setting — that setting's own series (duplication across
      // panels is by design: a run matching two settings appears in both).
      const list: FacetPanel[] = config.settings.map((st) => {
        const pts = resolution.series
          .filter((s) => s.settingId === st.id)
          .flatMap((s) => s.rows.map((row) => ({ row, key: s.key })));
        return { id: st.id, value: st.name, count: pts.length, pts };
      });
      return { list, hidden: 0 };
    }
    if (!facetDef) return { list: [] as FacetPanel[], hidden: 0 };
    // Panels per facet value over the DEDUPED union; within a panel a run
    // renders once per matching setting-series (the pair walk keeps the
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
    return { list, hidden };
  }, [facetIsSetting, facetDef, config.settings, resolution.series]);

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
        // (duplicates across settings are harmless under min/max).
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
    if (axisX && !axisX.categorical && config.xDomain) { x0 = tf(config.xDomain[0], logX); x1 = tf(config.xDomain[1], logX); }
    if (axisY && !axisY.categorical && config.yDomain) { y0 = tf(config.yDomain[0], logY); y1 = tf(config.yDomain[1], logY); }
    return { x0, x1, y0, y1 };
  }, [unionRows, resolution.series, lineMode, axisX, axisY, yName, logX, logY, config.xDomain, config.yDomain, catX, catY]);

  // Shared logical-space scale (fixed panel viewBox → aligned axes everywhere).
  const sx = (v: number) => PAD.l + ((v - extent.x0) / (extent.x1 - extent.x0)) * (PW - PAD.l - PAD.r);
  const sy = (v: number) => PH - PAD.b - ((v - extent.y0) / (extent.y1 - extent.y0)) * (PH - PAD.t - PAD.b);

  const dispFacet = (v: string) => (facetDef?.display ? facetDef.display(v) : v);
  const facetLabel = facetIsSetting ? "setting" : facetDef?.label ?? "";

  const panelCtx: PanelCtx = {
    axisX, axisY, logX, logY, seriesByKey,
    lineMode,
    lineMetric: lineMode ? (trajectoryMetric(yName) ?? "plantedness") : null,
    colorByActive, colorByColId, colorForC, catX, catY,
    band: !!config.band, ghosts: !!config.ghosts, sx, sy,
  };

  if (!facetDef && !facetIsSetting) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        <p className="max-w-sm text-center text-xs text-text-faint">
          Choose a facet in the config panel — a parameter (one panel per value) or
          <span className="text-text-muted"> setting</span> (one panel per setting).
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* facet summary strip (inert — the config panel owns facet + panel size) */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-3 py-1.5 text-xs">
        <span className="text-text-faint">facet:</span>
        <span className="text-text-muted">{facetLabel}</span>
        <span className="text-text-muted">{facets.list.length} panels{facets.hidden > 0 ? ` · ${facets.hidden} more not shown` : ""}</span>
      </div>

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
            <Panel pts={f.pts} ctx={panelCtx} onOpenRun={openDetail} />
          </LazyPanel>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One facet panel — a lean plot in shared logical coordinates over its
// (row × series) pairs. Grouping/averaging mirrors the main plot: points group
// per (series × X bucket); n>1 groups render as means with ±SD whiskers,
// per-series connecting lines, and collapsed-run ghosts.
// ---------------------------------------------------------------------------

type PanelCtx = {
  axisX: Axis | null; axisY: Axis | null; logX: boolean; logY: boolean;
  /** Global series lookup (dims[0] is a point's series key; carries the
   *  series' judge for per-epoch resolution). */
  seriesByKey: Map<string, Series>;
  lineMode: boolean;
  lineMetric: EpochMetric | null;
  colorByActive: boolean; colorByColId: string | null;
  colorForC: (v: number | null | undefined) => string;
  catX: string[] | null; catY: string[] | null;
  band: boolean; ghosts: boolean;
  sx: (v: number) => number; sy: (v: number) => number;
};

function Panel({ pts, ctx, onOpenRun }: { pts: PanelPt[]; ctx: PanelCtx; onOpenRun: (id: string) => void }) {
  const colorOf = (dims: string[]) => ctx.seriesByKey.get(dims[0])?.color ?? SINGLE_COLOR;
  const shapeOf = (dims: string[]) => shapeForValue(ctx.seriesByKey.get(dims[0])?.shapeIdx ?? 0);

  const content = useMemo(() => {
    if (ctx.lineMode) {
      const traj = ctx.lineMetric;
      if (!traj) return null;
      // Each run draws one trajectory per matching series (pair walk), so
      // batch the pairs by series key and tag the built series with it.
      const byKey = new Map<string, RunRow[]>();
      for (const p of pts) {
        const arr = byKey.get(p.key);
        if (arr) arr.push(p.row); else byKey.set(p.key, [p.row]);
      }
      const series: RunSeries[] = [];
      for (const [key, rs] of byKey) {
        // Each series scores its trajectories with ITS judge (mixed → null →
        // headline fallback, flagged by the main plot's judgePooled warning).
        const judge = ctx.seriesByKey.get(key)?.judge ?? null;
        series.push(...buildRunSeries(rs, traj, () => [key], judge, ctx.logY).series);
      }
      const groups = groupSeries(series);
      // Per-group mean colorBy (continuous color) over the panel's series.
      const meanC = new Map<string, number>();
      if (ctx.colorByActive && ctx.colorByColId) {
        const byRun = new Map(pts.map((p) => [p.row.identity.node_path, numericValue(p.row, ctx.colorByColId!)]));
        const acc = new Map<string, number[]>();
        for (const s of series) {
          const cv = byRun.get(s.runId);
          if (cv === null || cv === undefined || !Number.isFinite(cv)) continue;
          const k = s.dims.join(" ");
          const arr = acc.get(k);
          if (arr) arr.push(cv); else acc.set(k, [cv]);
        }
        for (const [k, vs] of acc) meanC.set(k, vs.reduce((a, b) => a + b, 0) / vs.length);
      }
      return { kind: "line" as const, series, groups, meanC };
    }
    if (!ctx.axisX || !ctx.axisY) return null;
    const runPts: RunPoint[] = [];
    for (const p of pts) {
      const vx = ctx.axisX.value(p.row);
      const vy = ctx.axisY.value(p.row);
      if (vx === null || vy === null) continue;
      if ((ctx.logX && vx <= 0) || (ctx.logY && vy <= 0)) continue;
      runPts.push({
        x: ctx.logX ? Math.log10(vx) : vx,
        y: ctx.logY ? Math.log10(vy) : vy,
        runId: p.row.identity.node_path,
        dims: [p.key],
        c: ctx.colorByColId ? numericValue(p.row, ctx.colorByColId) : null,
      });
    }
    // Group per (series × X bucket) — same rule as the main plot.
    const grouped = groupRuns(runPts, true);
    // Per-series connecting lines only where the series collapsed runs.
    const bySeries = new Map<string, GroupedPoint[]>();
    for (const gp of grouped.points) {
      const arr = bySeries.get(gp.dims[0]);
      if (arr) arr.push(gp); else bySeries.set(gp.dims[0], [gp]);
    }
    const meanLines = [...bySeries.values()].filter(
      (arr) => arr.length > 1 && arr.some((gp) => gp.n > 1),
    );
    return {
      kind: "scatter" as const,
      grouped,
      ghosts: collapsedGhosts(runPts, grouped.ghosts),
      meanLines,
    };
  }, [pts, ctx]);

  const txX = (e: number) => (ctx.logX ? Math.log10(Math.max(e, 1e-12)) : e);
  const jitterX = !!ctx.axisX?.jitter && !ctx.logX;
  const jitterY = !!ctx.axisY?.jitter && !ctx.logY;
  const pointColor = (p: GroupedPoint) => (ctx.colorByActive ? ctx.colorForC(p.c) : colorOf(p.dims));

  return (
    <svg viewBox={`0 0 ${PW} ${PH}`} className="w-full" role="img">
      <rect x={PAD.l} y={PAD.t} width={PW - PAD.l - PAD.r} height={PH - PAD.t - PAD.b} fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={0.5} />
      <clipPath id="gp-clip"><rect x={PAD.l} y={PAD.t} width={PW - PAD.l - PAD.r} height={PH - PAD.t - PAD.b} /></clipPath>

      {content?.kind === "scatter" && (
        <g clipPath="url(#gp-clip)">
          {ctx.ghosts && content.ghosts.map((g, i) => (
            <circle key={`g${i}`} cx={ctx.sx(g.x)} cy={ctx.sy(g.y)} r={1.1} fill={ctx.colorByActive ? ctx.colorForC(g.c) : colorOf(g.dims)} fillOpacity={0.16} />
          ))}
          {content.meanLines.map((line, i) => (
            <path
              key={`l${i}`}
              d={line.map((gp, j) => `${j === 0 ? "M" : "L"}${ctx.sx(gp.x)},${ctx.sy(gp.y)}`).join(" ")}
              fill="none" stroke={ctx.colorByActive ? ctx.colorForC(line[0].c) : colorOf(line[0].dims)}
              strokeWidth={1} strokeOpacity={0.8} pointerEvents="none"
            />
          ))}
          {content.grouped.points.map((p, i) => {
            const color = pointColor(p);
            const jx = jitterX && p.runId ? (hash01(p.runId) - 0.5) * 0.5 : 0;
            const jy = jitterY && p.runId ? (hash01(p.runId + "#y") - 0.5) * 0.5 : 0;
            const r = p.n > 1 ? Math.min(6, 2 + Math.sqrt(p.n)) : 2.4;
            return (
              <g key={`p${i}`}>
                {ctx.band && p.sdY !== null && p.sdY > 0 && (
                  <line x1={ctx.sx(p.x + jx)} y1={ctx.sy(p.y - p.sdY)} x2={ctx.sx(p.x + jx)} y2={ctx.sy(p.y + p.sdY)} stroke={color} strokeOpacity={0.4} strokeWidth={0.75} />
                )}
                {ctx.band && p.sdX !== null && p.sdX > 0 && (
                  <line x1={ctx.sx(p.x - p.sdX)} y1={ctx.sy(p.y + jy)} x2={ctx.sx(p.x + p.sdX)} y2={ctx.sy(p.y + jy)} stroke={color} strokeOpacity={0.4} strokeWidth={0.75} />
                )}
                {shapeNode(shapeOf(p.dims), ctx.sx(p.x + jx), ctx.sy(p.y + jy), r, { fill: color, fillOpacity: 0.65, stroke: color, strokeOpacity: 0.9 })}
                {p.runId && p.n === 1 && (
                  <circle cx={ctx.sx(p.x + jx)} cy={ctx.sy(p.y + jy)} r={Math.max(4, r + 2)} fill="transparent" className="cursor-pointer" onClick={() => onOpenRun(p.runId!)} />
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
            const lineColor = ctx.colorByActive ? ctx.colorForC(content.meanC.get(g.dims.join(" ")) ?? null) : colorOf(g.dims);
            const up = withSd.map((p) => `${ctx.sx(txX(p.e))},${ctx.sy(p.y + (p.sd ?? 0))}`);
            const dn = withSd.slice().reverse().map((p) => `${ctx.sx(txX(p.e))},${ctx.sy(p.y - (p.sd ?? 0))}`);
            return <polygon key={`rb${i}`} points={[...up, ...dn].join(" ")} fill={lineColor} fillOpacity={0.1} />;
          })}
          {content.groups.map((g, i) => g.points.length > 1 && (
            <polyline key={`ml${i}`} points={g.points.map((p) => `${ctx.sx(txX(p.e))},${ctx.sy(p.y)}`).join(" ")} fill="none" stroke={ctx.colorByActive ? ctx.colorForC(content.meanC.get(g.dims.join(" ")) ?? null) : colorOf(g.dims)} strokeWidth={1.25} strokeOpacity={0.95} />
          ))}
        </g>
      )}

      {yTicksSvg(ctx)}
      {xTicksSvg(ctx)}
    </svg>
  );
}

// Panel axis ticks (shared scale). Categorical axes label integer positions
// with the category names; numeric axes derive nice ticks from the scale.
function yTicksSvg(ctx: PanelCtx) {
  const cat = ctx.catY;
  const ticks = cat ? cat.map((_, i) => i) : (() => {
    const yTop = invY(ctx, PAD.t), yBot = invY(ctx, PH - PAD.b);
    return niceTicks(Math.min(yTop, yBot), Math.max(yTop, yBot), 3);
  })();
  return (
    <g>
      {ticks.map((t, i) => (
        <g key={`y${i}`}>
          <line x1={PAD.l} y1={ctx.sy(t)} x2={PW - PAD.r} y2={ctx.sy(t)} stroke="var(--color-border)" strokeOpacity={0.4} strokeWidth={0.4} />
          <text x={PAD.l - 3} y={ctx.sy(t) + 3} fontSize={7} textAnchor="end" fill="var(--color-text-faint)" className="font-mono">{cat ? (cat[t] ?? "") : fmtTick(t, ctx.logY)}</text>
        </g>
      ))}
    </g>
  );
}
function xTicksSvg(ctx: PanelCtx) {
  const cat = ctx.catX;
  const ticks = cat ? cat.map((_, i) => i) : (() => {
    const xL = invX(ctx, PAD.l), xR = invX(ctx, PW - PAD.r);
    return niceTicks(Math.min(xL, xR), Math.max(xL, xR), 3);
  })();
  return (
    <g>
      {ticks.map((t, i) => (
        <text key={`x${i}`} x={ctx.sx(t)} y={PH - PAD.b + 9} fontSize={7} textAnchor="middle" fill="var(--color-text-faint)" className="font-mono">{cat ? (cat[t] ?? "") : fmtTick(t, ctx.logX)}</text>
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
