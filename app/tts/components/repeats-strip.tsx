"use client";

// Repeating-todo rules (ttsRepeats), managed from the Calendar tab. A rule
// mints a real dated todo on each of its weekdays at 4:30 a.m. (see
// convex/ttsRepeats.ts); this strip is the rule's whole UI: the list, an
// exact-effect create form, pause/resume, delete. Minted instances are
// ordinary todos and appear on the week grid as due marks like any other
// dated item.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import Info from "./info";
import { errMessage } from "../lib";

type Repeat = Doc<"ttsRepeats">;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
type Weekday = (typeof WEEKDAYS)[number];

const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";
const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-xs text-text placeholder:text-text-faint";

function daysLabel(days: readonly Weekday[]): string {
  // Render in week order regardless of stored order.
  return WEEKDAYS.filter((d) => days.includes(d))
    .map((d) => d.slice(0, 3))
    .join(" ");
}

function RepeatRow({ rule }: { rule: Repeat }) {
  const updateRepeat = useMutation(api.ttsRepeats.updateRepeat);
  const deleteRepeat = useMutation(api.ttsRepeats.deleteRepeat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-border bg-surface/40 px-2 py-1 ${
        rule.active ? "" : "opacity-60"
      }`}
    >
      <span className="text-xs text-text">{rule.statement}</span>
      <span className="text-[10px] font-mono text-text-faint">
        {daysLabel(rule.daysOfWeek)}
        {rule.timeOfDay ? ` ${rule.timeOfDay}` : ""}
      </span>
      {rule.category && (
        <span className="text-[10px] text-accent border border-accent/40 rounded px-1">
          {rule.category}
        </span>
      )}
      {rule.skipWhenCalendarHas && (
        <span
          className="text-[10px] text-text-faint"
          title="No instance is minted on a day whose calendar has an event whose title contains this text."
        >
          skip when calendar has “{rule.skipWhenCalendarHas}”
        </span>
      )}
      {!rule.active && (
        <span className="text-[10px] text-text-faint">paused</span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <button
          className={btnCls}
          disabled={busy}
          onClick={() =>
            void run(() =>
              updateRepeat({ id: rule._id, active: !rule.active }),
            )
          }
        >
          {rule.active ? "Pause" : "Resume"}
        </button>
        <Info call={`ttsRepeats.updateRepeat({ id, active: ${!rule.active} })`}>
          Turns this rule {rule.active ? "off" : "on"}. Todos it already minted
          stay exactly as they are; this only decides whether tomorrow&apos;s
          4:30 a.m. run mints another one.
        </Info>
        <button
          className={btnCls}
          disabled={busy}
          onClick={() => void run(() => deleteRepeat({ id: rule._id }))}
        >
          Delete
        </button>
        <Info call="ttsRepeats.deleteRepeat({ id })">
          Deletes the rule itself. Every todo it has already minted stays —
          nothing in TTS is ever removed by deleting the thing that made it.
        </Info>
      </span>
      {error && <div className="w-full text-xs text-error">{error}</div>}
    </div>
  );
}

export default function RepeatsStrip() {
  const { isTom } = useAuth();
  const repeats = useQuery(api.ttsRepeats.listRepeats, isTom ? {} : "skip");
  const createRepeat = useMutation(api.ttsRepeats.createRepeat);
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [days, setDays] = useState<Weekday[]>([]);
  const [timeOfDay, setTimeOfDay] = useState("");
  const [category, setCategory] = useState("");
  const [skipWhen, setSkipWhen] = useState("");
  const [entryAction, setEntryAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createRepeat({
        statement,
        daysOfWeek: days,
        timeOfDay: timeOfDay.trim() === "" ? undefined : timeOfDay.trim(),
        category: category.trim() === "" ? undefined : category.trim(),
        skipWhenCalendarHas:
          skipWhen.trim() === "" ? undefined : skipWhen.trim(),
        entryAction:
          entryAction.trim() === "" ? undefined : entryAction.trim(),
      });
      setStatement("");
      setDays([]);
      setTimeOfDay("");
      setCategory("");
      setSkipWhen("");
      setEntryAction("");
      setOpen(false);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (repeats === undefined) return null;

  return (
    <div className="mt-4 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">Repeats</span>
        <Info call="ttsRepeats.listRepeats()">
          Your repeating rules. Each one mints a dated todo on the weekdays it
          names, at 4:30 a.m. New York, just before the day&apos;s queue is
          built — so a repeat is in the corpus by the time anything reads it.
        </Info>
        <button className={btnCls} onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "New repeat"}
        </button>
      </div>

      {repeats.length === 0 && !open && (
        <div className="text-[11px] text-text-faint">no repeating todos</div>
      )}
      {repeats.map((r) => (
        <RepeatRow key={r._id} rule={r} />
      ))}

      {open && (
        <div className="rounded border border-border bg-surface/40 p-2 space-y-1.5">
          <input
            className={`${inputCls} w-full`}
            placeholder="statement (instance display text)"
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() =>
                  setDays((v) =>
                    v.includes(d) ? v.filter((x) => x !== d) : [...v, d],
                  )
                }
                className={`rounded border px-1.5 py-0.5 text-[11px] ${
                  days.includes(d)
                    ? "border-accent/60 text-accent"
                    : "border-border text-text-faint hover:text-text"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <input
              className={inputCls}
              placeholder="time HH:MM (optional)"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value)}
              size={18}
            />
            <input
              className={inputCls}
              placeholder="category (optional)"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              size={18}
            />
            <input
              className={inputCls}
              placeholder="skip when calendar has… (optional)"
              value={skipWhen}
              onChange={(e) => setSkipWhen(e.target.value)}
              size={28}
            />
            <input
              className={inputCls}
              placeholder="entry action (optional)"
              value={entryAction}
              onChange={(e) => setEntryAction(e.target.value)}
              size={28}
            />
          </div>
          <div className="flex items-center gap-1">
            <button
              className={btnCls}
              disabled={busy || statement.trim() === "" || days.length === 0}
              onClick={() => void create()}
            >
              Create repeat
            </button>
            <Info call="ttsRepeats.createRepeat({ statement, daysOfWeek, … })">
            Adds a rule that mints this todo on the weekdays you picked. It
            starts minting from the next 4:30 a.m. run — nothing appears for
            today.
          </Info>
          </div>
          {error && <div className="text-xs text-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
