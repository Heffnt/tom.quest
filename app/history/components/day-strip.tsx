"use client";

import { displayDayKey } from "@/shared/clock.mjs";

export type DayCounts = { day: string; facts: number; told: number; actions: number };

const SERIES = [
  { key: "facts", className: "bg-accent" },
  { key: "told", className: "bg-text-muted" },
  { key: "actions", className: "bg-text-faint" },
] as const;

/** One cell per day of the range: how much he logged, said and Jarvis did. Pressing a day shows its column. */
export default function DayStrip({ counts, onPick }: { counts: DayCounts[]; onPick: (day: string) => void }) {
  const most = {
    facts: Math.max(1, ...counts.map((c) => c.facts)),
    told: Math.max(1, ...counts.map((c) => c.told)),
    actions: Math.max(1, ...counts.map((c) => c.actions)),
  };
  const numbered = counts.length <= 62;
  return (
    <nav aria-label="Days" className="grid gap-px" style={{ gridTemplateColumns: `repeat(${counts.length}, minmax(0, 1fr))` }}>
      {counts.map((c) => (
        <button
          key={c.day}
          type="button"
          onClick={() => onPick(c.day)}
          aria-label={`${displayDayKey(c.day)}: ${c.facts} facts, ${c.told} messages, ${c.actions} actions`}
          className="flex min-w-0 flex-col items-center gap-1 rounded-sm px-px py-1 transition-colors hover:bg-surface-alt"
        >
          <span className="flex h-7 items-end gap-px">
            {SERIES.map((series) => {
              const value = c[series.key];
              return (
                <span
                  key={series.key}
                  className={`w-1 rounded-t-sm ${value === 0 ? "" : series.className}`}
                  style={{ height: value === 0 ? 0 : `${Math.max(12, (value / most[series.key]) * 100)}%` }}
                />
              );
            })}
          </span>
          {numbered && <span className="font-mono text-[10px] leading-none text-text-faint">{Number(c.day.slice(8))}</span>}
        </button>
      ))}
    </nav>
  );
}
