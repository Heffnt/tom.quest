"use client";

import { useCallback, useMemo, useRef } from "react";
import type { HistoryPage } from "@/convex/historyRows";
import DayColumns, { type DayColumn } from "./components/day-columns";
import DayStrip, { type DayCounts } from "./components/day-strip";
import MealsChart from "./components/meals-chart";
import TrainingChart from "./components/training-chart";
import WeightChart from "./components/weight-chart";
import { RANGE_PRESETS, presetRange } from "./lib";

export type Range = { from: string; to: string };

const MAX_RANGE_DAYS = 366;
const inputClass = "rounded-md border border-border bg-surface px-2 py-1 text-sm text-text focus:border-accent/60 focus:outline-none [color-scheme:dark]";

function spanDays(range: Range): number {
  return Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
}

function groupByDay<T extends { day: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) out.set(row.day, [...(out.get(row.day) ?? []), row]);
  return out;
}

/** The /history page from one read of the record: range, day strip, charts, then a column per day. */
export default function HistoryView({ data, range, today, onRange }: {
  data: HistoryPage | undefined;
  range: Range;
  today: string;
  onRange: (range: Range) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const columnNodes = useRef(new Map<string, HTMLElement>());
  const columnRef = useCallback((day: string, node: HTMLElement | null) => {
    if (node === null) columnNodes.current.delete(day);
    else columnNodes.current.set(day, node);
  }, []);

  const { counts, columns } = useMemo(() => {
    if (data === undefined) return { counts: [] as DayCounts[], columns: [] as DayColumn[] };
    const facts = groupByDay([...data.weights, ...data.meals, ...data.trainings]);
    const told = groupByDay(data.told);
    const actions = groupByDay(data.actions);
    return {
      counts: data.days.map((day) => ({
        day,
        facts: facts.get(day)?.length ?? 0,
        told: told.get(day)?.length ?? 0,
        actions: actions.get(day)?.length ?? 0,
      })),
      columns: data.days.map((day) => ({ day, told: told.get(day) ?? [], actions: actions.get(day) ?? [] })),
    };
  }, [data]);

  // A day pressed in the strip brings its column into the row's view; only
  // the row scrolls, never the page.
  const pick = useCallback((day: string) => {
    const row = scroller.current;
    const node = columnNodes.current.get(day);
    if (row === null || node === undefined) return;
    row.scrollTo({ left: node.offsetLeft - row.offsetLeft - (row.clientWidth - node.clientWidth) / 2, behavior: "smooth" });
  }, []);

  const setEnd = (which: "from" | "to", value: string) => {
    const next = { ...range, [which]: value };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.from) || !/^\d{4}-\d{2}-\d{2}$/.test(next.to)) return;
    if (next.from > next.to || spanDays(next) > MAX_RANGE_DAYS) return;
    onRange(next);
  };
  const span = spanDays(range);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 px-3 py-5 sm:px-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">History</h1>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Range">
          {RANGE_PRESETS.map((preset) => {
            const active = range.to === today && span === preset.days;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={active}
                onClick={() => onRange(presetRange(today, preset.days))}
                className={`rounded-md border px-2.5 py-1 text-sm transition-colors ${active ? "border-accent/60 bg-accent-dim text-text" : "border-border text-text-muted hover:bg-surface-alt hover:text-text"}`}
              >
                {preset.label}
              </button>
            );
          })}
          <label className="sr-only" htmlFor="history-from">From</label>
          <input id="history-from" type="date" value={range.from} max={range.to} onChange={(event) => setEnd("from", event.target.value)} className={inputClass} />
          <span aria-hidden className="text-text-faint">–</span>
          <label className="sr-only" htmlFor="history-to">To</label>
          <input id="history-to" type="date" value={range.to} min={range.from} max={today} onChange={(event) => setEnd("to", event.target.value)} className={inputClass} />
        </div>
      </header>

      {data === undefined ? (
        <p className="text-sm text-text-faint">Loading…</p>
      ) : (
        <>
          <DayStrip counts={counts} onPick={pick} />
          <section aria-label="Diet and exercise" className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <WeightChart weights={data.weights} days={data.days} />
            <TrainingChart trainings={data.trainings} days={data.days} />
            <MealsChart meals={data.meals} days={data.days} />
          </section>
          <DayColumns ref={scroller} columns={columns} columnRef={columnRef} />
          {data.cuts.length > 0 && (
            <ul aria-label="Reads cut short" className="space-y-0.5 text-xs text-text-faint">
              {data.cuts.map((cut) => <li key={cut}>{cut}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
