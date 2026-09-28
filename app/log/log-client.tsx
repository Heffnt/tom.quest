"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  DAY_LOG_BENCHMARKS,
  dailyWaistAverages,
  monthlyBenchmarkBests,
  weeklyMorningAverages,
  weeklyRuns,
} from "@/shared/day-log-trends.mjs";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Info from "@/app/jarvis/components/info";
import LineChart from "./components/line-chart";

const controlClass = "rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-accent/60 focus:outline-none";
const explanation = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

function time(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

type Entry = {
  _id: string;
  day: string;
  text: string;
  createdAt: number;
  result: string;
  items: Array<{
    _id: string;
    type: "measurement" | "workout" | "food" | "feeling" | "symptom" | "work";
    summary: string;
    metric?: string;
    value?: number;
    unit?: string;
    partOfDay?: "morning" | "afternoon" | "evening" | "unknown";
    activity?: "run" | "climb" | "strength" | "bike" | "walk" | "other";
    bodyParts?: string[];
    distanceMi?: number;
    durationMin?: number;
  }>;
};

type Measurement = {
  _id: string;
  metric: string;
  value: number;
  unit: string;
  day: string;
  partOfDay: "morning" | "afternoon" | "evening" | "unknown";
  entryCreatedAt: number;
};

type TrainingDay = {
  cells: Array<{ column: string; text: string }>;
  notes: string[];
  ideas: Array<{ label: string; text: string }>;
};

type Run = {
  _id: string;
  day: string;
  activity: "run";
  distanceMi?: number;
};

type Series = { measurements: Measurement[]; runs: Run[] };

const benchmarkOrder = ["pullup_added_weight", "hang_20mm", "sprint_40yd", "loop_1_4mi"] as const;

function duration(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function runLabel(count: number, distanceMi: number | null): string {
  const runs = `${count} ${count === 1 ? "run" : "runs"}`;
  return `${runs} · ${distanceMi === null ? "—" : distanceMi.toFixed(1)} mi`;
}

function words(value: string): string {
  return value.replaceAll("_", " ");
}

function factLine(item: Entry["items"][number]): string {
  if (item.type === "measurement" && item.metric !== undefined && item.value !== undefined && item.unit !== undefined) {
    const timing = item.partOfDay === undefined || item.partOfDay === "unknown" ? "" : ` · ${item.partOfDay}`;
    return `${words(item.metric)}: ${item.value.toFixed(1)} ${item.unit}${timing}`;
  }
  if (item.type === "workout" && item.activity !== undefined) {
    const details = [
      words(item.activity),
      item.distanceMi === undefined ? null : `${item.distanceMi.toFixed(1)} mi`,
      item.durationMin === undefined ? null : `${item.durationMin.toFixed(0)} min`,
      item.bodyParts === undefined || item.bodyParts.length === 0 ? null : item.bodyParts.join(", "),
    ].filter((detail): detail is string => detail !== null);
    return details.join(" · ");
  }
  return item.summary;
}

export default function LogClient() {
  const { isTom } = useAuth();
  const entries = useQuery(api.dayLog.page, isTom ? {} : "skip") as Entry[] | undefined;
  const series = useQuery(api.dayLog.series, isTom ? {} : "skip") as Series | undefined;
  const training = useQuery(api.dayLog.trainingDay, isTom ? {} : "skip") as TrainingDay | null | undefined;
  const submit = useMutation(api.dayLog.submit);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ideasOpen, setIdeasOpen] = useState(false);

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${input.scrollHeight}px`;
  }, [text]);

  const weeklyWeight = useMemo(() => weeklyMorningAverages(
    (series?.measurements ?? [])
      .filter((measurement) => measurement.metric === "weight")
      .map((measurement) => ({
        day: measurement.day,
        value: measurement.value,
        partOfDay: measurement.partOfDay,
        entryCreatedAt: measurement.entryCreatedAt,
      })),
  ), [series]);

  const waist = useMemo(() => dailyWaistAverages(series?.measurements ?? []), [series]);
  const runs = useMemo(() => weeklyRuns(series?.runs ?? []), [series]);
  const benchmarks = useMemo(() => monthlyBenchmarkBests(series?.measurements ?? []), [series]);

  const days = useMemo(() => {
    const grouped = new Map<string, Entry[]>();
    for (const entry of entries ?? []) grouped.set(entry.day, [...(grouped.get(entry.day) ?? []), entry]);
    return [...grouped.entries()];
  }, [entries]);

  async function onSubmit() {
    if (text.trim() === "" || submitting) return;
    setSubmitting(true);
    try {
      await submit({ text });
      setText("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <TomGate label="Log">
      <div className="mx-auto w-full max-w-3xl space-y-7 px-3 py-5 sm:px-5">
        <header><h1 className="text-2xl font-bold tracking-tight">Log</h1></header>

        {/* This is the agreed exception to the dialog rule: the log's one
            composition control stays open and fixed at the top, so submitting
            cannot move unrelated controls or hide the next entry. */}
        <section className="space-y-2">
          <div className="flex items-baseline gap-1">
            <label htmlFor="day-log-entry" className="text-sm text-text-muted">Entry</label>
            <Info
              call="dayLog.submit({ text })"
              explanation={explanation("Add a log entry", "This control sends the exact text you typed to the private day-log entry store. It is first marked pending for the Jarvis worker to read.")}
              explanationTitle="Add a log entry"
            >Saves the text exactly as typed as a pending private log entry.</Info>
          </div>
          <textarea
            ref={textarea}
            id="day-log-entry"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Write anything about your day"
            rows={3}
            className={`${controlClass} block min-h-24 w-full resize-none text-base leading-6`}
          />
          {training !== undefined && training !== null && (
            <section aria-label="Today’s training" className="space-y-2 rounded-md border border-border bg-surface/40 px-3 py-2.5 text-sm leading-5">
              <div className="space-y-0.5">
                {training.cells.map((cell) => (
                  <p key={`${cell.column}:${cell.text}`} className="break-words text-text">
                    {cell.column}: {cell.text}
                  </p>
                ))}
              </div>
              {training.notes.length > 0 && (
                <div className="space-y-0.5 text-text-muted">
                  {training.notes.map((note) => <p key={note} className="break-words">{note}</p>)}
                </div>
              )}
              {training.ideas.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-expanded={ideasOpen}
                      onClick={() => setIdeasOpen((open) => !open)}
                      className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text transition-colors hover:bg-surface-alt"
                    >
                      Ideas
                    </button>
                    <Info
                      call="setIdeasOpen((open) => !open)"
                      explanation={explanation("Show training ideas", "This control shows or hides the ideas stored with the current weekly training structure. It changes only this page while it is open.")}
                      explanationTitle="Show training ideas"
                    >Shows or hides the ideas from the current weekly structure.</Info>
                  </div>
                  {ideasOpen && (
                    <div className="space-y-1.5 text-text-muted">
                      {training.ideas.map((idea) => (
                        <p key={`${idea.label}:${idea.text}`} className="break-words"><strong className="font-semibold text-text">{idea.label}</strong>: {idea.text}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onSubmit}
              disabled={text.trim() === "" || submitting}
              className="min-w-[6.2rem] rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
            <Info
              call="dayLog.submit({ text })"
              explanation={explanation("Submit a log entry", "This button submits the open entry through the Tom-only day-log mutation. When it succeeds, the text area is cleared and the stored entry remains available below.")}
              explanationTitle="Submit a log entry"
            >Stores this entry, then leaves it pending for Jarvis to process.</Info>
          </div>
        </section>

        <section aria-label="Charts" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {weeklyWeight.length > 0 && <section aria-label="Morning weight" className="min-h-[10.625rem] rounded-lg border border-border bg-surface/40 p-3">
            <LineChart points={weeklyWeight.map((point) => ({ x: point.week, y: point.value }))} unit="lb" />
          </section>}
          {waist.length > 0 && <section aria-label="Waist" className="min-h-[10.625rem] rounded-lg border border-border bg-surface/40 p-3">
            <LineChart points={waist.map((point) => ({ x: point.day, y: point.value }))} unit="in" />
          </section>}
          {runs.length > 0 && <section aria-label="Runs per week" className="min-h-[10.625rem] rounded-lg border border-border bg-surface/40 p-3">
            <LineChart
              points={runs.map((point) => ({ x: point.week, y: point.count, label: runLabel(point.count, point.distanceMi) }))}
              unit="runs"
              variant="bar"
            />
          </section>}
          {benchmarkOrder.map((metric) => {
            const points = benchmarks.filter((benchmark) => benchmark.metric === metric);
            if (points.length === 0) return null;
            const benchmark = DAY_LOG_BENCHMARKS[metric];
            return (
              <section key={metric} aria-label={metric.replaceAll("_", " ")} className="min-h-[10.625rem] rounded-lg border border-border bg-surface/40 p-3">
                <LineChart
                  points={points.map((point) => ({ x: point.month, y: point.value }))}
                  unit={benchmark.unit === "s" && metric === "loop_1_4mi" ? "m:ss" : benchmark.unit}
                  formatValue={metric === "loop_1_4mi" ? duration : undefined}
                />
              </section>
            );
          })}
        </section>

        <section className="space-y-5" aria-label="Entries">
          {entries === undefined ? <p className="text-sm text-text-faint">Loading…</p> : days.map(([day, rows]) => (
            <div key={day} className="space-y-2">
              <h2 className="font-mono text-xs text-text-faint">{day}</h2>
              {rows.map((entry) => (
                <article key={entry._id} className="rounded-lg border border-border bg-surface/40 p-3">
                  <time dateTime={new Date(entry.createdAt).toISOString()} className="block text-xs text-text-faint">{time(entry.createdAt)}</time>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-text">{entry.text}</pre>
                  {entry.items.length > 0 && (
                    <ul className="mt-3 space-y-1 border-l border-border pl-3 text-sm text-text-muted">
                      {entry.items.map((item) => <li key={item._id}>{factLine(item)}</li>)}
                    </ul>
                  )}
                  <p className="mt-3 text-sm text-text-muted">{entry.result}</p>
                </article>
              ))}
            </div>
          ))}
        </section>
      </div>
    </TomGate>
  );
}
