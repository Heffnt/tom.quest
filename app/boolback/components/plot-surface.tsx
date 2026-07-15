"use client";

// app/boolback/components/plot-surface.tsx — the ONE renderer for everything
// between the axes, shared by the main Plot (plot-panel.tsx, full size) and the
// Group Plot's faceted panels (group-plot.tsx, compact). It is a "smaller
// version of the main plot with all the same functionality": tooltips, ghost /
// mean-line hover, click-to-inspect, linked highlights, per-surface trend.
//
// The caller BUILDS the mode data (visual points / epoch groups + ghosts) in
// DATA space and hands it in with a SHARED scale (sx/sy + ticks); the surface
// only draws + interacts, so a grid of panels all agree on axes and styling.
// It is PURE of the store except the linked-highlight reads (hoveredDir /
// selectedDir) and click-through (openDetail / expandChain).
//
// BOTH modes:
//   scatter — visible points (shape/color/size), ±SD whiskers, per-series mean
//     lines (dash), faint ghost points, invisible per-point hit targets;
//   epoch   — ghost run-lines (+ fat invisible hit strokes), ±SD ribbons, mean
//     lines (dash/width, + hit strokes), vertices.
// The HTML tooltip lives INSIDE the surface's own relative container (so it
// positions correctly in a grid of panels) and is fed by a hovered scatter
// point OR a hovered epoch line (positioned from the pointer, not the datum).
//
// TREND: when config.trend, the surface fits ONE OLS line over ITS OWN
// run-deduped `pairs` and draws it. A compact surface also prints a small
// `r=…` corner readout; the full surface does not (the top bar shows r/ρ).
//
// COMPACT: smaller fonts / radii / no x gridlines. Export-only groups + the
// colorbar are the caller's business (svgUnderlay / svgOverlay), injected into
// this surface's <svg> so the PNG export still captures the whole figure; the
// main plot passes them, compact panels pass nothing.
//
// Pure SVG — no chart library. Box-select drag is GONE: view windows are edited
// via the axis-range controls in plot-panel, not by dragging on the plot.

import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { RunRow, LayerStyle } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import type { GroupedPoint } from "../lib/aggregate";
import { olsFit, pearson } from "../lib/stats";
import { opac } from "../lib/styling";
import { shapeNode } from "./glyph";

/** Compact numeric tick/label formatter (shared with plot-panel's copy). */
function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

/** A visible scatter datum in DATA space (the caller builds these; the surface
 *  owns the RADIUS, which depends on `compact`). `gp.x/gp.y` are transformed
 *  values; `jx/jy` are the deterministic jitter offsets. */
export interface SurfacePoint {
  gp: GroupedPoint;
  jx: number;
  jy: number;
  color: string;
  shapeIdx: number;
  /** The owning layer's style (shape/dash channels; size/opacity are plot-level). */
  style: LayerStyle;
  /** Precomputed tooltip lines (first line is muted/truncated). */
  label: string[];
}

/** A faint ghost point (raw run behind a collapsed group mean). */
export interface SurfaceGhostPoint {
  x: number;
  y: number;
  color: string;
}

/** An epoch-mode ghost run-line (one run's trajectory) with its hit metadata. */
export interface SurfaceGhostRun {
  color: string;
  runId: string;
  dims: string[];
  pts: Array<{ x: number; y: number }>;
}

/** An epoch-mode group mean line with its ±SD ribbon points and hit metadata.
 *  `label` is the owning series' label (vertex `<title>` prefix). */
export interface SurfaceMeanGroup {
  dims: string[];
  color: string;
  dash: string;
  runId: string | undefined;
  label: string;
  pts: Array<{ x: number; y: number; sd: number | null; n: number }>;
}

export interface SurfaceEpoch {
  ghostRuns: SurfaceGhostRun[];
  groups: SurfaceMeanGroup[];
}

/** Plot geometry in viewBox units (1 unit === 1 CSS px in the full plot). */
export interface SurfaceSize {
  W: number;
  H: number;
  pad: { l: number; r: number; t: number; b: number };
}

/** The caller-supplied scale — SHARED across a grid of panels so their axes and
 *  categorical positions mean the same thing everywhere. */
export interface SurfaceScale {
  sx: (v: number) => number;
  sy: (v: number) => number;
  xTicks: number[];
  yTicks: number[];
  xTickLabel: (t: number) => string;
  yTickLabel: (t: number) => string;
}

/** Plot-level style multipliers + toggles (config.band / ghosts / trend /
 *  size / opacity) — read at render, never per-layer. */
export interface SurfaceStyle {
  band: boolean;
  ghosts: boolean;
  trend: boolean;
  size: number;
  opacity: number;
}

export interface PlotSurfaceProps {
  mode: "scatter" | "epoch";
  size: SurfaceSize;
  scale: SurfaceScale;
  config: SurfaceStyle;
  /** true → smaller fonts/radii, no x gridlines, print the trend `r=…` corner. */
  compact?: boolean;
  /** log flags — only for vertex-title / epoch-line value un-transform. */
  logX?: boolean;
  logY?: boolean;

  // ---- scatter data (built by the caller in data space) --------------------
  points?: SurfacePoint[];
  /** Per-series connecting lines (collapsed groups); [0] carries color/style. */
  meanLines?: SurfacePoint[][];
  ghostPoints?: SurfaceGhostPoint[];

  // ---- epoch data ----------------------------------------------------------
  epoch?: SurfaceEpoch | null;

  // ---- trend: the surface fits its OWN run-deduped pairs -------------------
  pairs?: Array<{ x: number; y: number }>;

  // ---- interaction lookups -------------------------------------------------
  /** Full-bundle rows keyed by run id — click-through chain expansion. */
  rowByRunId: Map<string, RunRow>;
  /** Epoch line tooltip builders (the caller owns the content policy). */
  ghostTooltip?: (s: { runId: string; dims: string[] }) => string[];
  meanTooltip?: (dims: string[]) => string[];

  // ---- export plumbing (main plot only; compact panels omit) --------------
  /** Forwarded to the surface's <svg> so the caller's Export handle can read it. */
  svgRef?: React.MutableRefObject<SVGSVGElement | null>;
  /** Export-only groups drawn BEHIND the data (axis labels + layers legend). */
  svgUnderlay?: React.ReactNode;
  /** Groups drawn ON TOP of the data (the colorbar). */
  svgOverlay?: React.ReactNode;
}

export function PlotSurface({
  mode, size, scale, config, compact = false, logX = false, logY = false,
  points = [], meanLines = [], ghostPoints = [], epoch = null, pairs = [],
  rowByRunId, ghostTooltip, meanTooltip,
  svgRef, svgUnderlay, svgOverlay,
}: PlotSurfaceProps) {
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const hoveredDir = useBoolbackStore((s) => s.hoveredDir);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);

  const { W, H, pad } = size;
  const { sx, sy } = scale;
  const lineMode = mode === "epoch";

  const [hover, setHover] = useState<SurfacePoint | null>(null);
  const [lineHover, setLineHover] = useState<{ label: string[]; px: number; py: number } | null>(null);
  const localSvg = useRef<SVGSVGElement | null>(null);
  const setSvg = useCallback((el: SVGSVGElement | null) => {
    localSvg.current = el;
    if (svgRef) svgRef.current = el;
  }, [svgRef]);
  const clipId = `bb-surface-${useId()}`;

  // Radii scale down in compact panels; size is the plot-level multiplier.
  const pointR = (n: number) =>
    (n > 1 ? Math.min(compact ? 6 : 10, (compact ? 2 : 3) + Math.sqrt(n)) : (compact ? 2.4 : 3)) * config.size;
  const hitR = (r: number) => (compact ? Math.max(4, r + 2) : Math.max(9, r + 5));
  const ghostR = compact ? 1.1 : 1.4;
  const tickFont = compact ? 7 : 12;

  // Open the run inspector + expand its chain (ghost line, vertex, point click).
  const inspect = useCallback((runId: string) => {
    openDetail(runId);
    const r = rowByRunId.get(runId);
    if (r) expandChain(r.identity.chain_dirs);
  }, [openDetail, expandChain, rowByRunId]);

  // Epoch-mode line hover: position the HTML tooltip from the pointer (a line
  // has no single datum to anchor to). ViewBox coords via the SVG's CTM.
  const onLineHover = (e: React.PointerEvent, label: string[]) => {
    const svg = localSvg.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    setLineHover({ label, px: p.x, py: p.y });
  };

  // One overall OLS trend line over the run-deduped pairs (a fit over group
  // means would overstate the association). Compact surfaces also print r.
  const trend = useMemo(() => {
    if (!config.trend || pairs.length < 2) return null;
    const xs = pairs.map((p) => p.x);
    const ys = pairs.map((p) => p.y);
    const fit = olsFit(xs, ys);
    if (!fit) return null;
    return { fit, lo: Math.min(...xs), hi: Math.max(...xs), r: compact ? pearson(xs, ys) : null };
  }, [pairs, config.trend, compact]);

  // The points linked to the row hovered/selected elsewhere (table / tree).
  const linked = useMemo(
    () => points.filter((p) => p.gp.runId !== undefined && (p.gp.runId === selectedDir || p.gp.runId === hoveredDir)),
    [points, hoveredDir, selectedDir],
  );

  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  return (
    <div className="relative h-full w-full">
      <svg
        ref={setSvg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full select-none"
        role="img"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t} width={plotW} height={plotH} />
          </clipPath>
        </defs>
        <rect x={pad.l} y={pad.t} width={plotW} height={plotH}
          fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={compact ? 0.5 : 1} />

        {/* y gridlines + tick labels */}
        {scale.yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={pad.l} y1={sy(t)} x2={W - pad.r} y2={sy(t)}
              stroke="var(--color-border)" strokeOpacity={compact ? 0.4 : 0.5} strokeWidth={compact ? 0.4 : 0.5} />
            <text x={pad.l - (compact ? 3 : 6)} y={sy(t) + (compact ? 3 : 4)} fontSize={tickFont} textAnchor="end"
              fill="var(--color-text-faint)" className="font-mono">{scale.yTickLabel(t)}</text>
          </g>
        ))}
        {/* x gridlines (full only) + tick labels */}
        {scale.xTicks.map((t, i) => (
          <g key={`x${i}`}>
            {!compact && (
              <line x1={sx(t)} y1={pad.t} x2={sx(t)} y2={H - pad.b}
                stroke="var(--color-border)" strokeOpacity={0.35} strokeWidth={0.5} />
            )}
            <text x={sx(t)} y={H - pad.b + (compact ? 9 : 16)} fontSize={tickFont} textAnchor="middle"
              fill="var(--color-text-faint)" className="font-mono">{scale.xTickLabel(t)}</text>
          </g>
        ))}

        {/* export-only groups (axis labels + legend) — behind the data */}
        {svgUnderlay}

        {/* epoch trajectories: ghost run-lines (+ hover/click hit strokes),
            group ±SD ribbons, mean lines (+ hover hit strokes), vertices */}
        {lineMode && epoch && (
          <g clipPath={`url(#${clipId})`}>
            {config.ghosts && epoch.ghostRuns.map((s, i) => (
              s.pts.length > 1 && (
                <g key={`gl${i}`}>
                  <polyline
                    points={s.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                    fill="none" stroke={s.color} strokeWidth={1} strokeOpacity={opac(0.12, config.opacity)}
                    pointerEvents="none"
                  />
                  {/* invisible hit stroke: hover tooltip + click opens the run inspector */}
                  <polyline
                    points={s.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                    fill="none" stroke="transparent" strokeWidth={10} pointerEvents="stroke"
                    className="cursor-pointer"
                    onPointerMove={ghostTooltip ? (e) => onLineHover(e, ghostTooltip(s)) : undefined}
                    onPointerLeave={() => setLineHover(null)}
                    onClick={() => inspect(s.runId)}
                  />
                </g>
              )
            ))}
            {config.band && epoch.groups.map((g, i) => {
              const withSd = g.pts.filter((p) => p.sd !== null && p.sd > 0);
              if (withSd.length < 2) return null;
              const up = withSd.map((p) => `${sx(p.x)},${sy(p.y + (p.sd ?? 0))}`);
              const dn = withSd.slice().reverse().map((p) => `${sx(p.x)},${sy(p.y - (p.sd ?? 0))}`);
              return (
                <polygon key={`rb${i}`} points={[...up, ...dn].join(" ")} fill={g.color} fillOpacity={opac(0.1, config.opacity)} stroke="none" pointerEvents="none" />
              );
            })}
            {epoch.groups.map((g, i) => (
              g.pts.length > 1 && (
                <g key={`ml${i}`}>
                  <polyline
                    points={g.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                    fill="none" stroke={g.color} strokeWidth={1.75 * config.size} strokeOpacity={opac(0.95, config.opacity)}
                    strokeDasharray={g.dash || undefined}
                    pointerEvents="none"
                  />
                  {/* invisible hit stroke: hover tooltip (layer / n runs / judge) */}
                  <polyline
                    points={g.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}
                    fill="none" stroke="transparent" strokeWidth={10} pointerEvents="stroke"
                    onPointerMove={meanTooltip ? (e) => onLineHover(e, meanTooltip(g.dims)) : undefined}
                    onPointerLeave={() => setLineHover(null)}
                  />
                </g>
              )
            ))}
            {/* vertices — hover title + click-through for single-run groups */}
            {epoch.groups.map((g) =>
              g.pts.map((p, j) => (
                <circle
                  key={`${g.dims.join(",")}-${j}`}
                  cx={sx(p.x)} cy={sy(p.y)} r={2.4 * config.size}
                  fill={g.color} fillOpacity={opac(0.9, config.opacity)}
                  className={g.runId ? "cursor-pointer" : undefined}
                  onClick={g.runId ? () => inspect(g.runId!) : undefined}
                >
                  <title>{`${g.label ? g.label + " · " : ""}epoch ${logX ? Math.round(Math.pow(10, p.x)) : p.x}: ${tickFmt(logY ? Math.pow(10, p.y) : p.y)}${p.sd !== null && p.sd > 0 ? ` ± ${tickFmt(p.sd)}` : ""}${p.n > 1 ? ` (n=${p.n})` : ""}`}</title>
                </circle>
              )),
            )}
          </g>
        )}

        {/* per-layer connecting lines (collapsed groups; under points) */}
        {!lineMode && meanLines.length > 0 && (
          <g clipPath={`url(#${clipId})`}>
            {meanLines.map((line, i) => (
              <path
                key={i}
                d={line.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.gp.x)},${sy(p.gp.y)}`).join(" ")}
                fill="none" stroke={line[0].color} strokeWidth={1.5 * config.size}
                strokeOpacity={opac(0.85, config.opacity)}
                strokeDasharray={line[0].style.dash || undefined}
                pointerEvents="none"
              />
            ))}
          </g>
        )}

        {/* ghost points — faint raw runs behind the collapsed group means */}
        {!lineMode && config.ghosts && ghostPoints.length > 0 && (
          <g clipPath={`url(#${clipId})`}>
            {ghostPoints.map((g, i) => (
              <circle
                key={`g${i}`}
                cx={sx(g.x)}
                cy={sy(g.y)}
                r={ghostR}
                fill={g.color}
                fillOpacity={opac(0.18, config.opacity)}
                pointerEvents="none"
              />
            ))}
          </g>
        )}

        {/* ±1 SD whiskers (n>1 groups only — sd is null on singles) */}
        {!lineMode && config.band && (
          <g clipPath={`url(#${clipId})`}>
            {points.map((p, i) => (
              <g key={`w${i}`} stroke={p.color} strokeOpacity={opac(0.5, config.opacity)} strokeWidth={compact ? 0.75 : 1}>
                {p.gp.sdY !== null && p.gp.sdY > 0 && (
                  <line x1={sx(p.gp.x + p.jx)} y1={sy(p.gp.y - p.gp.sdY)} x2={sx(p.gp.x + p.jx)} y2={sy(p.gp.y + p.gp.sdY)} />
                )}
                {p.gp.sdX !== null && p.gp.sdX > 0 && (
                  <line x1={sx(p.gp.x - p.gp.sdX)} y1={sy(p.gp.y + p.jy)} x2={sx(p.gp.x + p.gp.sdX)} y2={sy(p.gp.y + p.jy)} />
                )}
              </g>
            ))}
          </g>
        )}

        {/* visible points */}
        {!lineMode && (
          <g>
            {points.map((p, i) => (
              <g key={i}>
                {shapeNode(p.shapeIdx, sx(p.gp.x + p.jx), sy(p.gp.y + p.jy), pointR(p.gp.n), {
                  fill: p.color, fillOpacity: opac(0.6, config.opacity),
                  stroke: p.color, strokeOpacity: opac(0.9, config.opacity),
                })}
              </g>
            ))}
          </g>
        )}

        {/* linked-row highlight rings (row hovered/selected in table or tree) */}
        {!lineMode && linked.map((p, i) => (
          <circle
            key={`h${i}`}
            cx={sx(p.gp.x + p.jx)}
            cy={sy(p.gp.y + p.jy)}
            r={pointR(p.gp.n) + (compact ? 2 : 3)}
            fill="none"
            stroke="var(--color-text)"
            strokeWidth={compact ? 1 : 1.5}
            pointerEvents="none"
          />
        ))}

        {/* one overall OLS trend line (over the run-deduped underlying pairs) */}
        {!lineMode && trend && (
          <g clipPath={`url(#${clipId})`}>
            <line
              x1={sx(trend.lo)}
              y1={sy(trend.fit.intercept + trend.fit.slope * trend.lo)}
              x2={sx(trend.hi)}
              y2={sy(trend.fit.intercept + trend.fit.slope * trend.hi)}
              stroke="var(--color-text-muted)"
              strokeWidth={compact ? 1 : 1.5}
              strokeDasharray="6 3"
              strokeOpacity={0.9}
              pointerEvents="none"
            />
          </g>
        )}

        {/* compact trend readout — the full plot shows r/ρ in the top bar */}
        {compact && trend && trend.r !== null && (
          <text x={W - pad.r - 3} y={pad.t + 9} fontSize={8} textAnchor="end"
            fill="var(--color-text-muted)" className="font-mono">{`r=${trend.r.toFixed(2)}`}</text>
        )}

        {/* invisible hit targets (on top; generous radius) */}
        {!lineMode && (
          <g>
            {points.map((p, i) => (
              <circle
                key={`t${i}`}
                cx={sx(p.gp.x + p.jx)}
                cy={sy(p.gp.y + p.jy)}
                r={hitR(pointR(p.gp.n))}
                fill="transparent"
                className={p.gp.n === 1 ? "cursor-pointer" : undefined}
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
                onClick={() => { if (p.gp.runId && p.gp.n === 1) inspect(p.gp.runId); }}
              />
            ))}
          </g>
        )}

        {/* overlay groups (colorbar) — on top */}
        {svgOverlay}
      </svg>

      {/* tooltip (flips sides near the right edge) — fed by a hovered scatter
          point OR a hovered epoch-mode line (ghost run / group mean); the
          latter positions from the pointer (onLineHover), not the data. */}
      {(hover || lineHover) && (() => {
        const label = hover ? hover.label : lineHover!.label;
        const px = hover ? sx(hover.gp.x + hover.jx) : lineHover!.px;
        const py = hover ? sy(hover.gp.y + hover.jy) : lineHover!.py;
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
            {label.map((l, i) => (
              <div key={i} className={i === 0 ? "text-text-muted truncate" : ""}>{l}</div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
