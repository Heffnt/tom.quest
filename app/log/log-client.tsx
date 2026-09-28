"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
  items: Array<{
    _id: string;
    summary: string;
    value?: number;
    unit?: string;
    revertedAt?: number;
  }>;
  actions: Array<{
    _id: string;
    result: string;
    quote: string;
    revertedAt?: number;
  }>;
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
  const undoItem = useMutation(api.dayLog.undoItem);
  const undoAction = useMutation(api.dayLog.undoAction);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});

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

  async function undo(id: string, operation: () => Promise<unknown>) {
    if (undoing !== null) return;
    setUndoing(id);
    setUndoErrors((errors) => ({ ...errors, [id]: "" }));
    try {
      await operation();
    } catch (error) {
      setUndoErrors((errors) => ({
        ...errors,
        [id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setUndoing(null);
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
                  {(entry.items.length > 0 || entry.actions.length > 0) && (
                    <div className="mt-3 space-y-2 border-t border-border pt-3">
                      {entry.items.map((item) => (
                        <div key={item._id} className={`rounded-md bg-surface-alt/40 px-2 py-1.5 ${item.revertedAt === undefined ? "" : "text-text-faint"}`}>
                          <div className="flex min-h-6 items-center justify-between gap-2">
                            <p className={`min-w-0 text-xs ${item.revertedAt === undefined ? "text-text-muted" : "text-text-faint"}`}>
                              {item.summary}{item.value !== undefined && item.unit !== undefined ? ` · ${item.value} ${item.unit}` : ""}
                            </p>
                            <div className="flex shrink-0 items-center gap-1">
                              <span className="min-w-[3.9rem] text-right text-xs text-text-faint">{item.revertedAt === undefined ? "" : "Undone."}</span>
                              <button
                                type="button"
                                disabled={item.revertedAt !== undefined || undoing !== null}
                                onClick={() => void undo(item._id, () => undoItem({ id: item._id as Id<"dayLogItems"> }))}
                                className="rounded px-1.5 py-0.5 text-xs text-accent transition-colors hover:bg-accent-dim disabled:pointer-events-none disabled:opacity-45"
                              >
                                Undo
                              </button>
                              <Info
                                call="dayLog.undoItem({ id })"
                                explanation={explanation("Undo a log item", "This control marks this extracted log item as undone in the private day-log store. Charts and trend calculations no longer include it, while the original entry remains unchanged.")}
                                explanationTitle="Undo a log item"
                              >Marks this extracted item as undone so it no longer appears in charts.</Info>
                            </div>
                          </div>
                          <p aria-live="polite" className="min-h-4 text-xs text-text-muted">{undoErrors[item._id] ?? ""}</p>
                        </div>
                      ))}
                      {entry.actions.map((action) => (
                        <div key={action._id} className={`rounded-md bg-surface-alt/40 px-2 py-1.5 ${action.revertedAt === undefined ? "" : "text-text-faint"}`}>
                          <div className="flex min-h-6 items-center justify-between gap-2">
                            <p className={`min-w-0 text-xs ${action.revertedAt === undefined ? "text-text-muted" : "text-text-faint"}`}>{action.result}</p>
                            <div className="flex shrink-0 items-center gap-1">
                              <span className="min-w-[3.9rem] text-right text-xs text-text-faint">{action.revertedAt === undefined ? "" : "Undone."}</span>
                              <button
                                type="button"
                                disabled={action.revertedAt !== undefined || undoing !== null}
                                onClick={() => void undo(action._id, () => undoAction({ id: action._id as Id<"dayLogActions"> }))}
                                className="rounded px-1.5 py-0.5 text-xs text-accent transition-colors hover:bg-accent-dim disabled:pointer-events-none disabled:opacity-45"
                              >
                                Undo
                              </button>
                              <Info
                                call="dayLog.undoAction({ id })"
                                explanation={explanation("Undo a log action", "This control checks that the todo or repeat still has the values Jarvis wrote. If it does, it restores the saved prior values; todo changes are also written to their mirrored record, and a captured todo is archived instead of deleted.")}
                                explanationTitle="Undo a log action"
                              >Restores the saved values when nothing has changed since this action.</Info>
                            </div>
                          </div>
                          <p className="text-xs text-text-faint">{action.quote}</p>
                          <p aria-live="polite" className="min-h-4 text-xs text-text-muted">{undoErrors[action._id] ?? ""}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          ))}
        </section>
      </main>
    </TomGate>
  );
}
