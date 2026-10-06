"use client";

import type { Weight } from "@/convex/historyRows";
import ChartCard from "./chart-frame";
import { labelDays, niceTicks, shortDay, weightDays } from "../lib";

const W = 560;
const H = 220;
const PAD = { left: 52, right: 14, top: 12, bottom: 26 };
/** Two weigh-ins further apart than this are not joined by a line. */
const JOIN_DAYS = 7;

function fmt(lb: number): string {
  return lb.toFixed(1);
}

/** Weight over the range: one point per day he weighed in (that day's mean). */
export default function WeightChart({ weights, days }: { weights: Weight[]; days: string[] }) {
  const points = weightDays(weights);
  const index = new Map(days.map((day, i) => [day, i]));
  const band = (W - PAD.left - PAD.right) / Math.max(1, days.length);
  const x = (day: string) => PAD.left + ((index.get(day) ?? 0) + 0.5) * band;
  const values = points.map((point) => point.lb);
  const ticks = points.length === 0 ? [] : niceTicks(Math.min(...values) - 0.5, Math.max(...values) + 0.5, 4);
  const low = ticks[0] ?? 0;
  const high = ticks.at(-1) ?? 1;
  const y = (lb: number) => PAD.top + (1 - (lb - low) / (high - low || 1)) * (H - PAD.top - PAD.bottom);
  const segments: string[] = [];
  points.forEach((point, i) => {
    const previous = points[i - 1];
    const joined = previous !== undefined && (Date.parse(point.day) - Date.parse(previous.day)) / 86_400_000 <= JOIN_DAYS;
    segments.push(`${joined ? "L" : "M"}${x(point.day).toFixed(1)} ${y(point.lb).toFixed(1)}`);
  });
  const latest = points.at(-1);
  const first = points[0];
  const change = latest !== undefined && first !== undefined && points.length > 1 ? latest.lb - first.lb : null;
  const radius = days.length > 120 ? 2 : 3;

  return (
    <ChartCard
      title="Weight"
      label="Weight over time"
      figure={latest === undefined ? null : (
        <span>
          {fmt(latest.lb)} lb
          {change !== null && <span className="ml-2 text-text-faint">{change > 0 ? "+" : change < 0 ? "−" : "±"}{fmt(Math.abs(change))} lb</span>}
        </span>
      )}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weight in pounds by day" className="block h-auto w-full">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="fill-text-faint" fontSize="11">{tick % 1 === 0 ? tick : tick.toFixed(1)}</text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className="stroke-border" strokeWidth="1" />
        {labelDays(days).map((day, i, shown) => (
          <text
            key={day}
            x={x(day)}
            y={H - 8}
            textAnchor={i === 0 && shown.length > 1 ? "start" : i === shown.length - 1 && shown.length > 1 ? "end" : "middle"}
            className="fill-text-faint"
            fontSize="11"
          >{shortDay(day)}</text>
        ))}
        {points.length > 1 && <path d={segments.join(" ")} fill="none" className="stroke-accent" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {points.map((point) => (
          <circle key={point.day} cx={x(point.day)} cy={y(point.lb)} r={radius} className="fill-accent" data-day={point.day} data-lb={fmt(point.lb)} />
        ))}
      </svg>
    </ChartCard>
  );
}
