"use client";

// app/boolback/components/epoch-sparkline.tsx
//
// A tiny epoch-trajectory line, salvaged from the deleted DAG pane's EpochCell
// and reworked to read row.trajectories. Two modes:
//
//   <EpochSparkline trajectories={r.trajectories} metric="asr" />     // inline
//       a single-series mini line over one metric, with the 0.95 plantedness
//       threshold drawn; used on table outcome-cell hover.
//
//   <EpochPlot trajectories={r.trajectories} />                       // detail
//       the full plantedness-over-epoch plot with ASR/FTR overlay + 0.95 line +
//       axis labels; this is the salvaged DAG epoch plot.
//
// Both index-align their series to trajectories.completed_epochs and skip null
// cells (sparse-aware). Pure SVG, CSS-variable colors.

import type { Trajectories } from "../lib/types";

const PLANT_THRESHOLD = 0.95;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

type MetricKey = "plantedness" | "asr" | "ftr" | "ppl";

const METRIC_COLOR: Record<MetricKey, string> = {
  plantedness: "var(--color-success)",
  asr: "var(--color-accent)",
  ftr: "var(--color-warning)",
  ppl: "var(--color-text-muted)",
};

/** Build "x,y" point strings for a sparse series within [pad, pad+plot]. */
function pointsFor(
  values: (number | null)[],
  w: number,
  h: number,
  pad: number,
): Array<{ x: number; y: number; v: number; i: number }> {
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;
  const n = Math.max(1, values.length);
  const stepX = n > 1 ? plotW / (n - 1) : 0;
  const out: Array<{ x: number; y: number; v: number; i: number }> = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    out.push({
      x: pad + i * stepX,
      y: pad + (1 - clamp01(v)) * plotH,
      v,
      i,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Inline single-metric sparkline (table hover)
// ---------------------------------------------------------------------------

export function EpochSparkline({
  trajectories,
  metric,
  width = 120,
  height = 36,
}: {
  trajectories: Trajectories;
  metric: MetricKey;
  width?: number;
  height?: number;
}) {
  const pad = 4;
  const series = trajectories[metric];
  const pts = pointsFor(series, width, height, pad);
  const threshY = pad + (1 - PLANT_THRESHOLD) * (height - pad * 2);
  const showThresh = metric === "plantedness";

  if (pts.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-text-faint text-[10px]"
        style={{ width, height }}
      >
        no epochs
      </div>
    );
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
      <rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        rx={3}
        fill="var(--color-surface)"
        stroke="var(--color-border)"
        strokeWidth={1}
      />
      {showThresh && (
        <line
          x1={pad}
          y1={threshY}
          x2={width - pad}
          y2={threshY}
          stroke="var(--color-success)"
          strokeOpacity={0.4}
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      {pts.length > 1 && (
        <polyline
          points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="none"
          stroke={METRIC_COLOR[metric]}
          strokeWidth={1.5}
        />
      )}
      {pts.map((p) => (
        <circle key={p.i} cx={p.x} cy={p.y} r={2} fill={METRIC_COLOR[metric]} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Full plantedness-over-epoch plot with ASR/FTR overlay (detail panel)
// ---------------------------------------------------------------------------

const OVERLAY_METRICS: MetricKey[] = ["plantedness", "asr", "ftr"];

export function EpochPlot({
  trajectories,
  width = 360,
  height = 180,
}: {
  trajectories: Trajectories;
  width?: number;
  height?: number;
}) {
  const pad = 28;
  const epochs = trajectories.completed_epochs;
  const plotH = height - pad * 2;
  const threshY = pad + (1 - PLANT_THRESHOLD) * plotH;

  if (epochs.length === 0) {
    return (
      <div className="text-text-faint text-xs py-6 text-center">
        No completed epochs.
      </div>
    );
  }

  const seriesByMetric = OVERLAY_METRICS.map((m) => ({
    metric: m,
    pts: pointsFor(trajectories[m], width, height, pad),
  }));

  return (
    <div className="flex flex-col gap-1">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        {/* frame */}
        <rect
          x={pad}
          y={pad}
          width={width - pad * 2}
          height={plotH}
          fill="var(--color-surface)"
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {/* y gridlines at 0, .5, 1 */}
        {[0, 0.5, 1].map((g) => {
          const y = pad + (1 - g) * plotH;
          return (
            <g key={g}>
              <line
                x1={pad}
                y1={y}
                x2={width - pad}
                y2={y}
                stroke="var(--color-border)"
                strokeOpacity={0.4}
                strokeWidth={0.5}
              />
              <text
                x={pad - 4}
                y={y + 3}
                fontSize={9}
                textAnchor="end"
                fill="var(--color-text-faint)"
                className="font-mono"
              >
                {g.toFixed(1)}
              </text>
            </g>
          );
        })}
        {/* plantedness threshold (0.95) */}
        <line
          x1={pad}
          y1={threshY}
          x2={width - pad}
          y2={threshY}
          stroke="var(--color-success)"
          strokeOpacity={0.5}
          strokeDasharray="4 3"
          strokeWidth={1}
        />
        {/* x epoch ticks */}
        {epochs.map((ep, i) => {
          const x =
            pad + (epochs.length > 1 ? (i / (epochs.length - 1)) * (width - pad * 2) : 0);
          return (
            <text
              key={ep}
              x={x}
              y={height - pad + 12}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-text-faint)"
              className="font-mono"
            >
              {ep}
            </text>
          );
        })}
        {/* series */}
        {seriesByMetric.map(({ metric, pts }) => (
          <g key={metric}>
            {pts.length > 1 && (
              <polyline
                points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={METRIC_COLOR[metric]}
                strokeWidth={1.75}
              />
            )}
            {pts.map((p) => (
              <circle
                key={p.i}
                cx={p.x}
                cy={p.y}
                r={2.5}
                fill={METRIC_COLOR[metric]}
              >
                <title>{`${metric} @ epoch ${epochs[p.i]}: ${p.v.toFixed(3)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      {/* legend */}
      <div className="flex items-center gap-3 text-[10px] text-text-muted font-mono pl-7">
        {OVERLAY_METRICS.map((m) => (
          <span key={m} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-1.5 w-3 rounded-sm"
              style={{ backgroundColor: METRIC_COLOR[m] }}
            />
            {m}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0 w-3 border-t border-dashed border-success" />
          0.95
        </span>
      </div>
    </div>
  );
}
