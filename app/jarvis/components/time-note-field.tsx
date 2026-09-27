"use client";

// A time note: Tom's own words about when something happens, attached to one
// context (a todo, a block, or a calendar day). There is no date picker on
// /tts any more — the text IS the instruction, and a worker agent reads it
// against that context and applies it. A note it cannot read without guessing
// comes back as needs-session for Tom to settle in conversation.
//
// The parent tab holds ONE tts.listTimeNotes subscription, buckets it ONCE
// with groupTimeNotes below, and hands each field the notes for its own
// context — no per-row scan of the whole array.
//
// A day-scoped note carries the calendar-day STRING "YYYY-MM-DD" (the label of
// the column Tom clicked); the server reads that day in the TTS canonical
// timezone. Never epoch-ms — a day is a calendar day, not an instant.

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import Info from "./info";
import { TIME_NOTES_EXPLANATION } from "../explanations";
import { errMessage } from "../lib";

export type TimeNote = Doc<"dtsTimeNotes">;

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

/** The fallback every row shares, so an empty context is not a new array. */
export const NO_NOTES: readonly TimeNote[] = Object.freeze([]);

/**
 * Every note bucketed by its context key — `todoId ?? blockId ?? day` — with
 * each bucket sorted oldest first ONCE. Exactly one context field is set on a
 * note (convex/tts.ts requireOneTimeNoteContext), so that key is unambiguous:
 * ids are Convex ids and a day is "YYYY-MM-DD", which cannot collide.
 *
 * A tab builds this in a useMemo over its one listTimeNotes subscription and
 * indexes it per row/block/day.
 */
export function groupTimeNotes(
  notes: TimeNote[],
): Map<string, readonly TimeNote[]> {
  const byKey = new Map<string, TimeNote[]>();
  for (const n of notes) {
    const key = n.todoId ?? n.blockId ?? n.day;
    if (key === undefined) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(n);
    else byKey.set(key, [n]);
  }
  for (const bucket of byKey.values()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt);
  }
  return byKey;
}

export default function TimeNoteField({
  todoId,
  blockId,
  day,
  notes,
  showInput = true,
}: {
  todoId?: Id<"dtsTodos">;
  blockId?: Id<"dtsBlocks">;
  /** Calendar day "YYYY-MM-DD" — the label of the column, never epoch-ms. */
  day?: string;
  /** This context's notes, bucketed by the parent (groupTimeNotes). */
  notes: readonly TimeNote[];
  /** The calendar's per-day `+` toggles the input; the chips always show. */
  showInput?: boolean;
}) {
  const createTimeNote = useMutation(api.tts.createTimeNote);
  const deleteTimeNote = useMutation(api.tts.deleteTimeNote);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contextArg =
    todoId !== undefined
      ? { todoId }
      : blockId !== undefined
        ? { blockId }
        : { day: day! };
  const contextLabel =
    todoId !== undefined ? "todoId" : blockId !== undefined ? "blockId" : "day";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createTimeNote({ text: trimmed, ...contextArg });
      setText("");
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: Id<"dtsTimeNotes">) => {
    setError(null);
    void deleteTimeNote({ id }).catch((err) => setError(errMessage(err)));
  };

  return (
    <div className="space-y-1">
      {showInput && (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="when"
            className={`${inputCls} flex-1 min-w-32`}
          />
          <button type="submit" disabled={!text.trim() || busy} className={btnCls}>
            note
          </button>
          <Info
            call={`tts.createTimeNote({ text, ${contextLabel} })`}
            explanation={TIME_NOTES_EXPLANATION}
            explanationTitle="time notes — one sentence about when"
          >
            Files one sentence about timing against this item. Nothing moves
            yet: a job reads pending notes every couple of minutes, works out
            the concrete date or block change you meant, and applies it —
            leaving a ✓ line here saying what it did.
          </Info>
        </form>
      )}

      {notes.map((n) =>
        n.status === "applied" ? (
          <div key={n._id} className="text-[11px] text-text-faint">
            ✓ {n.result ?? n.text}
          </div>
        ) : (
          <div
            key={n._id}
            className={`flex items-baseline gap-1 rounded border border-dashed px-1 py-px text-[11px] ${
              n.status === "needs-session"
                ? "border-accent/60 text-accent"
                : "border-border text-text-faint"
            }`}
          >
            <span className="flex-1">
              ◷ {n.text}
              {n.status === "needs-session" && n.result ? ` — ${n.result}` : ""}
            </span>
            <button
              type="button"
              onClick={() => remove(n._id)}
              className="text-text-faint hover:text-text"
            >
              ×
            </button>
            <Info
              call="tts.deleteTimeNote({ id })"
              explanation={TIME_NOTES_EXPLANATION}
              explanationTitle="time notes — one sentence about when"
            >
              Drops this note before anything acts on it. Only a note still
              waiting can be dropped — one already applied has become a real
              date or block, and that change stands.
            </Info>
          </div>
        ),
      )}

      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}
