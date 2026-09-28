"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { weeklyMorningAverages } from "@/shared/day-log-trends.mjs";
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
  items: Array<{ _id: string }>;
};

type Measurement = {
  _id: string;
  metric?: string;
  value?: number;
  unit?: string;
  day: string;
  partOfDay?: "morning" | "afternoon" | "evening" | "unknown";
  entryCreatedAt: number;
};

export default function LogClient() {
  const { isTom } = useAuth();
  const entries = useQuery(api.dayLog.page, isTom ? {} : "skip") as Entry[] | undefined;
  const measurements = useQuery(api.dayLog.series, isTom ? {} : "skip") as Measurement[] | undefined;
  const submit = useMutation(api.dayLog.submit);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useLayoutEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${input.scrollHeight}px`;
  }, [text]);

  const weeklyWeight = useMemo(() => weeklyMorningAverages(
    (measurements ?? [])
      .filter((measurement) => measurement.metric === "weight" && measurement.value !== undefined)
      .map((measurement) => ({
        day: measurement.day,
        value: measurement.value!,
        partOfDay: measurement.partOfDay ?? "unknown",
        entryCreatedAt: measurement.entryCreatedAt,
      })),
  ), [measurements]);

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
      <main className="mx-auto w-full max-w-3xl space-y-7 px-3 py-5 sm:px-5">
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

        <section aria-label="Weight chart" className="rounded-lg border border-border bg-surface/40 p-3">
          <LineChart points={weeklyWeight.map((point) => ({ x: point.week, y: point.value }))} unit="lb" />
        </section>

        <section className="space-y-5" aria-label="Entries">
          {entries === undefined ? <p className="text-sm text-text-faint">Loading…</p> : days.map(([day, rows]) => (
            <div key={day} className="space-y-2">
              <h2 className="font-mono text-xs text-text-faint">{day}</h2>
              {rows.map((entry) => (
                <article key={entry._id} className="rounded-lg border border-border bg-surface/40 p-3">
                  <time dateTime={new Date(entry.createdAt).toISOString()} className="block text-xs text-text-faint">{time(entry.createdAt)}</time>
                  <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-text">{entry.text}</pre>
                  <p className="mt-3 text-sm text-text-muted">{entry.result}</p>
                </article>
              ))}
            </div>
          ))}
        </section>
      </main>
    </TomGate>
  );
}
