"use client";

import type { Training } from "@/convex/historyRows";
import ChartCard from "./chart-frame";
import { niceTicks, partColor, partLabel, partsPresent, shortDay, trainingWeeks } from "../lib";

const W = 560;
const H = 220;
const PAD = { left: 40, right: 14, top: 14, bottom: 26 };

/** Training per week, a stacked bar per week with one segment per body part (sessions that trained it). */
export default function TrainingChart({ trainings, days }: { trainings: Training[]; days: string[] }) {
  const weeks = trainingWeeks(trainings, days);
  const parts = partsPresent(weeks);
  const max = Math.max(0, ...weeks.map((week) => week.total));
  const ticks = max === 0 ? [] : niceTicks(0, max, Math.min(4, max)).filter((tick) => Number.isInteger(tick));
  const top = ticks.at(-1) ?? 1;
  const band = (W - PAD.left - PAD.right) / Math.max(1, weeks.length);
  const barWidth = Math.max(2, Math.min(36, band * 0.7));
  const y = (value: number) => PAD.top + (1 - value / top) * (H - PAD.top - PAD.bottom);
  const labelEvery = Math.max(1, Math.ceil(weeks.length / 6));
  const sessions = trainings.length;

  return (
    <ChartCard
      title="Training per week"
      label="Training per week by body part"
      figure={sessions === 0 ? null : `${sessions} ${sessions === 1 ? "session" : "sessions"}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Training sessions per week by body part" className="block h-auto w-full">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="fill-text-faint" fontSize="11">{tick}</text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} className="stroke-border" strokeWidth="1" />
        {weeks.map((week, i) => {
          const cx = PAD.left + (i + 0.5) * band;
          let base = 0;
          return (
            <g key={week.week} data-week={week.week} data-total={week.total}>
              {week.parts.map((part) => {
                const y0 = y(base);
                base += part.sessions;
                const y1 = y(base);
                return (
                  <rect
                    key={part.part}
                    x={cx - barWidth / 2}
                    y={y1}
                    width={barWidth}
                    height={Math.max(0, y0 - y1 - (base === week.total ? 0 : 1))}
                    fill={partColor(part.part)}
                    data-part={part.part}
                    data-sessions={part.sessions}
                  />
                );
              })}
              {week.total > 0 && weeks.length <= 26 && (
                <text x={cx} y={y(week.total) - 4} textAnchor="middle" className="fill-text-muted" fontSize="11">{week.total}</text>
              )}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" className="fill-text-faint" fontSize="11">{shortDay(week.week)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {parts.length > 0 && (
        <ul aria-label="Body parts" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
          {parts.map((part) => (
            <li key={part} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: partColor(part) }} />
              {partLabel(part)}
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  );
}
