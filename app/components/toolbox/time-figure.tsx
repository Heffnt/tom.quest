"use client";

// TimeFigure — counts per time bin, one lane per kind, drawn as bars on one
// shared scale. Never one row per item: an item is a unit of a bar. Inline SVG
// at the measured width, like AreaFigure, so the text is 13 px at every width.

import QueryCaption from "./query-caption";
import { textWidth, useWidth } from "./use-width";

type Lane = { name: string; bins: readonly number[] };

/** One lane: its name line, then its bars. The axis labels sit under all. */
const NAME = 20;
const BARS = 40;
const LANE_GAP = 12;
const AXIS = 22;

export default function TimeFigure({
  title,
  lanes,
  binLabels,
  caption,
}: {
  title: string;
  lanes: readonly Lane[];
  binLabels: readonly string[];
  caption: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const bins = binLabels.length;
  const laneHeight = NAME + BARS + LANE_GAP;
  const height = lanes.length * laneHeight + AXIS;
  const max = Math.max(1, ...lanes.flatMap((l) => l.bins));
  const step = bins > 0 ? width / bins : width;
  // Every k-th label, so no two overlap at this width.
  const widest = Math.max(0, ...binLabels.map((l) => textWidth(l, true))) + 8;
  const every = Math.max(1, Math.ceil(widest / step));

  return (
    <section className="tb-block">
      <h2 className="tb-title">{title}</h2>
      <div ref={ref} className="tb-figure-box">
        <svg className="tb-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
          {lanes.map((lane, i) => {
            const top = i * laneHeight;
            const base = top + NAME + BARS;
            const total = lane.bins.reduce((a, b) => a + b, 0);
            return (
              <g key={lane.name}>
                <text x={0} y={top + 14}>
                  <tspan>{lane.name}</tspan>
                  <tspan className="tb-svg-num" dx={8}>{total}</tspan>
                </text>
                <line className="tb-axis" x1={0} x2={width} y1={base + 0.5} y2={base + 0.5} />
                {lane.bins.slice(0, bins).map((n, b) => {
                  const h = (n / max) * BARS;
                  return n > 0 ? (
                    <rect
                      key={b}
                      className="tb-bar"
                      x={b * step + 1}
                      y={base - h}
                      width={Math.max(1, step - 2)}
                      height={h}
                    />
                  ) : null;
                })}
              </g>
            );
          })}
          {binLabels.map((label, b) =>
            b % every === 0 ? (
              <text key={b} className="tb-svg-num tb-svg-faint" x={b * step + 1} y={height - 6}>
                {label}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      <QueryCaption text={caption} />
    </section>
  );
}
