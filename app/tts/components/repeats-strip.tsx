"use client";

// Repeating-todo rules (ttsRepeats), managed from the Calendar tab. A rule
// mints a real dated todo on each of its weekdays at 4:30 a.m. (see
// convex/ttsRepeats.ts); this strip is the rule's whole UI: the list, edit,
// pause/resume, delete. Minted instances are ordinary todos and appear on the
// week grid as due marks like any other dated item.
//
// Writing and changing a rule both happen in repeat-dialog.tsx — one form, one
// fixed overlay, so opening it never moves the list behind it.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import Info from "./info";
import RepeatDialog, { WEEKDAYS, type Weekday } from "./repeat-dialog";
import { errMessage } from "../lib";

type Repeat = Doc<"ttsRepeats">;

const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:bg-surface-alt hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

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
  const [editing, setEditing] = useState(false);
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
        <span className="inline-flex items-baseline gap-0.5 text-[10px] text-text-faint">
          skip when calendar has “{rule.skipWhenCalendarHas}”
          <Info call="ttsRepeats.internalGenerateRepeats — skipWhenCalendarHas">
            No instance is minted on a day whose calendar already holds an
            event with this text in its title. The 4:30 a.m. run records a
            repeat-skipped event naming that event instead of writing a todo.
          </Info>
        </span>
      )}
      {!rule.active && (
        <span className="text-[10px] text-text-faint">paused</span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <button className={btnCls} onClick={() => setEditing(true)}>
          Edit
        </button>
        <Info call="ttsRepeats.updateRepeat({ id, statement, daysOfWeek, timeOfDay, … })">
          Opens this rule’s nine fields for rewriting in place. The rule keeps
          its id, so the todos it has already minted stay attached to it —
          delete-and-recreate would break that thread.
        </Info>
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
      {editing && (
        <RepeatDialog rule={rule} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

export default function RepeatsStrip() {
  const { isTom } = useAuth();
  const repeats = useQuery(api.ttsRepeats.listRepeats, isTom ? {} : "skip");
  const [creating, setCreating] = useState(false);

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
        <button className={btnCls} onClick={() => setCreating(true)}>
          New repeat
        </button>
        <Info call="ttsRepeats.createRepeat({ statement, daysOfWeek, … })">
          Opens the same nine-field form the Edit button opens, empty. The rule
          starts minting from the next 4:30 a.m. run — nothing appears today.
        </Info>
      </div>

      {repeats.length === 0 && (
        <div className="text-[11px] text-text-faint">no repeating todos</div>
      )}
      {repeats.map((r) => (
        <RepeatRow key={r._id} rule={r} />
      ))}

      {creating && <RepeatDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
