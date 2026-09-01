"use client";

// The one form for a repeating-todo rule — writing a new one and changing an
// existing one are the same nine fields, so they are the same dialog.
//
// Why it exists: convex/ttsRepeats.ts updateRepeat has always accepted all
// nine rule fields, but the only caller in the app sent { id, active }, so
// changing a rule's statement, weekdays or time meant deleting it and writing
// it again — which changes the rule's id, and every already-minted instance
// carries `repeat:<id>:<day>` as its provenance, so the new rule cannot see
// what the old one minted. Editing in place keeps that thread intact.
//
// Fixed overlay, per the ratified UI rules: nothing on the page behind it
// moves, and no form appears inline between controls.

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import Info from "./info";
import { errMessage } from "../lib";

type Repeat = Doc<"ttsRepeats">;

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const inputCls =
  "bg-bg border border-border rounded-md px-2 py-1 text-xs text-text placeholder:text-text-faint";

/** "" means the field is not set. On an edit that is sent as null — the
 * clearing spelling updateRepeat reads — so emptying a box actually empties
 * the stored field instead of silently leaving the old value. */
function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export default function RepeatDialog({
  rule,
  onClose,
}: {
  /** Absent = write a new rule. Present = change this one in place. */
  rule?: Repeat;
  onClose: () => void;
}) {
  const createRepeat = useMutation(api.ttsRepeats.createRepeat);
  const updateRepeat = useMutation(api.ttsRepeats.updateRepeat);

  const [statement, setStatement] = useState(rule?.statement ?? "");
  const [days, setDays] = useState<Weekday[]>(
    (rule?.daysOfWeek as Weekday[] | undefined) ?? [],
  );
  const [timeOfDay, setTimeOfDay] = useState(rule?.timeOfDay ?? "");
  const [category, setCategory] = useState(rule?.category ?? "");
  const [skipWhen, setSkipWhen] = useState(rule?.skipWhenCalendarHas ?? "");
  const [entryAction, setEntryAction] = useState(rule?.entryAction ?? "");
  const [workDescription, setWorkDescription] = useState(
    rule?.workDescription ?? "",
  );
  const [groundUpExplanation, setGroundUpExplanation] = useState(
    rule?.groundUpExplanation ?? "",
  );
  const [body, setBody] = useState(rule?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropPress = useRef(false);

  const editing = rule !== undefined;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (rule) {
        await updateRepeat({
          id: rule._id,
          statement: statement.trim(),
          daysOfWeek: days,
          timeOfDay: optional(timeOfDay),
          category: optional(category),
          skipWhenCalendarHas: optional(skipWhen),
          entryAction: optional(entryAction),
          workDescription: optional(workDescription),
          groundUpExplanation: optional(groundUpExplanation),
          body: optional(body),
        });
      } else {
        await createRepeat({
          statement: statement.trim(),
          daysOfWeek: days,
          timeOfDay: optional(timeOfDay) ?? undefined,
          category: optional(category) ?? undefined,
          skipWhenCalendarHas: optional(skipWhen) ?? undefined,
          entryAction: optional(entryAction) ?? undefined,
          workDescription: optional(workDescription) ?? undefined,
          groundUpExplanation: optional(groundUpExplanation) ?? undefined,
          body: optional(body) ?? undefined,
        });
      }
      onClose();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      // The press must BEGIN on the backdrop, not merely end there. A `click`
      // is dispatched to the nearest common ancestor of mousedown and mouseup,
      // so selecting text in one of the three textareas and releasing past the
      // card edge would otherwise close the dialog and throw the edit away.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) backdropPress.current = true;
      }}
      onClick={(e) => {
        const fromBackdrop = backdropPress.current;
        backdropPress.current = false;
        if (e.target === e.currentTarget && fromBackdrop) onClose();
      }}
    >
      <div className="max-h-[85vh] w-[480px] max-w-full overflow-y-auto rounded-xl border border-[#3b4a66] bg-surface p-4">
        <h3 className="text-[15px] font-semibold">
          {editing ? "Change this repeat" : "New repeat"}
        </h3>

        <input
          className={`${inputCls} mt-2.5 w-full`}
          placeholder="statement (the minted todo's display text)"
          value={statement}
          autoFocus
          onChange={(e) => setStatement(e.target.value)}
        />

        <div className="mt-2 flex flex-wrap gap-1">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() =>
                setDays((v) =>
                  v.includes(d) ? v.filter((x) => x !== d) : [...v, d],
                )
              }
              className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                days.includes(d)
                  ? "border-accent/60 bg-accent-dim text-accent"
                  : "border-border text-text-faint hover:bg-surface-alt hover:text-text"
              }`}
            >
              {d}
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
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
            className={`${inputCls} flex-1`}
            placeholder="skip when calendar has… (optional)"
            value={skipWhen}
            onChange={(e) => setSkipWhen(e.target.value)}
          />
        </div>
        <div className="mt-1 flex items-center gap-1 text-[10px] text-text-faint">
          skip when calendar has
          <Info call="ttsRepeats.internalGenerateRepeats — skipWhenCalendarHas">
            No instance is minted on a day whose calendar already holds an
            event with this text in its title. The 4:30 a.m. run records a
            repeat-skipped event naming that event instead of writing a todo.
          </Info>
        </div>

        <input
          className={`${inputCls} mt-2 w-full`}
          placeholder="entry action (optional)"
          value={entryAction}
          onChange={(e) => setEntryAction(e.target.value)}
        />
        <textarea
          className={`${inputCls} mt-1.5 min-h-12 w-full resize-y`}
          placeholder="work description (optional)"
          value={workDescription}
          onChange={(e) => setWorkDescription(e.target.value)}
        />
        <textarea
          className={`${inputCls} mt-1.5 min-h-12 w-full resize-y`}
          placeholder="ground-up explanation (optional)"
          value={groundUpExplanation}
          onChange={(e) => setGroundUpExplanation(e.target.value)}
        />
        <textarea
          className={`${inputCls} mt-1.5 min-h-12 w-full resize-y`}
          placeholder="body (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />

        <p className="mt-2 text-xs text-text-muted">
          {editing
            ? "Rewrites the rule in place. Todos it already minted keep the words they were minted with — this decides what the next 4:30 a.m. run writes."
            : "Adds a rule that mints this todo on the weekdays you picked. It starts from the next 4:30 a.m. run — nothing appears for today."}
        </p>
        <div className="mt-0.5 font-mono text-[10px] text-text-faint">
          {editing
            ? "ttsRepeats.updateRepeat({ id, statement, daysOfWeek, timeOfDay, … })"
            : "ttsRepeats.createRepeat({ statement, daysOfWeek, timeOfDay, … })"}
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:bg-surface-alt hover:text-text"
          >
            cancel
          </button>
          <button
            type="button"
            disabled={busy || statement.trim() === "" || days.length === 0}
            onClick={() => void save()}
            className="rounded-md border border-accent bg-accent-dim px-3 py-1 text-[13px] text-accent hover:opacity-80 disabled:pointer-events-none disabled:opacity-40"
          >
            {editing ? "save repeat" : "create repeat"}
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-error">{error}</div>}
      </div>
    </div>
  );
}
