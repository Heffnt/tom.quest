"use client";

// THE options surface for every /tts subject — a life todo, a batch (a batch
// IS a life todo) or a code item. One compact wrap row at the top of an
// expanded panel: the four verdict chips and the status chips a life todo
// carries (done · archive).
//
// The four verdicts are uniform (ratified 2026-08-29): clicking a chip selects
// it and reveals ONE note input; confirming records the verdict with that note
// as `sentence`. Only revise requires it. On archive the sentence IS the
// unarchive condition (convex/ttsRulings.ts maps it), so one input serves all
// four.
//
// This one component replaces VerdictButtons and StatusActions, so a control
// cannot drift between the batch card, the generic todo row and the code row.
// There is no "commit time" control here — anything about time is a time note
// now.
//
// Every control names the exact backend call it fires behind an ⓘ (UI = code).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Info from "./info";
import {
  reserveSessionTab,
  type ReservedTab,
} from "@/app/lib/use-open-todo-session";
import type { LiveRulingContext } from "@/app/lib/tts-session-prompt";
import { errMessage, VERDICTS, type RulingVerdict, type Todo } from "../lib";

const inputCls =
  "bg-surface border border-border rounded-md px-2 py-1 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-accent/60";
const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

// ── The row ─────────────────────────────────────────────────────────────────

type Mode = RulingVerdict | "done" | "set-archived";

const PLACEHOLDER: Record<Mode, string> = {
  approve: "note (optional)",
  revise: "sentence (required)",
  session: "note (optional)",
  archive: "unarchive when (optional)",
  done: "note (optional)",
  "set-archived": "propose back when (optional)",
};

// One entry per verdict: the exact call, and what that verdict actually does
// downstream. The plain half is the point — "recordRuling" says nothing about
// which job wakes up next, and that is the thing worth knowing before pressing
// it (one info mechanism, ratified 2026-08-29).
const INFO: Record<Mode, { call: string; body: string }> = {
  approve: {
    call: 'ttsRulings.recordRuling({ verdict: "approve", sentence })',
    body: "Marks this as decided your way. On a code todo the executor picks it up and does the work; on a life todo it simply records your call and stops asking.",
  },
  revise: {
    call: 'ttsRulings.recordRuling({ verdict: "revise", sentence })',
    body: "Sends it back to be prepared again, with your sentence as the redirection. The preparer re-writes the brief against what you said and returns it — your sentence is the whole instruction, so it has to stand on its own.",
  },
  session: {
    call: 'ttsRulings.recordRuling({ verdict: "session", sentence })',
    body: "Says this needs a conversation rather than a ruling. The ruling is consumed the moment you actually open a session on it — an autonomous run that happens to claim the same item never consumes it, so the conversation you asked for still happens.",
  },
  archive: {
    call: 'ttsRulings.recordRuling({ verdict: "archive", sentence })',
    body: "Sets it aside. Your sentence becomes the condition under which it should be proposed back, so nothing is lost — archived is a resting state, not a delete.",
  },
  done: {
    call: 'tts.setStatus({ status: "done", note })',
    body: "Closes it as finished, with your note as the record of how. It stays visible in the archive; nothing in TTS is ever deleted.",
  },
  "set-archived": {
    call: 'tts.setStatus({ status: "archived", unarchiveCondition })',
    body: "Sets it aside without ruling on it. Your sentence is the condition that should bring it back, so a thing put down on purpose can be picked up again.",
  },
};

export type OptionsRowProps = {
  /** Life todo or batch row (a batch IS a life todo). Omit for code subjects. */
  todo?: Todo;
  /** Code subject. */
  code?: { repo: string; externalId: string };
  /** Show the four verdict chips. */
  rulable: boolean;
  /**
   * Runs AFTER the session verdict is recorded, with the tab reserved in the
   * click and the just-recorded ruling (so its sentence reaches the session
   * prompt instead of Tom repeating himself).
   */
  afterSession?: (tab: ReservedTab, ruling: LiveRulingContext) => void;
};

export default function OptionsRow({
  todo,
  code,
  rulable,
  afterSession,
}: OptionsRowProps) {
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const setStatus = useMutation(api.tts.setStatus);

  const [mode, setMode] = useState<Mode | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode(null);
      setNote("");
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const record = (verdict: RulingVerdict, sentence: string) => {
    const args = { verdict, sentence: sentence || undefined };
    return todo
      ? recordRuling({ todoId: todo._id, ...args })
      : recordRuling({
          repo: code!.repo,
          externalId: code!.externalId,
          ...args,
        });
  };

  const confirm = () => {
    // Guarded here too, not only in run(): the session branch reserves a
    // browser tab before run() would bail, and a bailed run would strand it.
    if (!mode || busy) return;
    const text = note.trim();
    if (mode === "revise" && !text) return;

    if (mode === "done" || mode === "set-archived") {
      if (!todo) return;
      void run(() =>
        mode === "done"
          ? setStatus({ id: todo._id, status: "done", note: text || undefined })
          : setStatus({
              id: todo._id,
              status: "archived",
              unarchiveCondition: text || undefined,
            }),
      );
      return;
    }

    if (mode === "session") {
      // Reserved HERE, synchronously inside the click/submit, before the
      // mutation — browsers only honour window.open in the gesture stack.
      // Nothing opens a session for a code subject, so nothing is reserved.
      const tab = afterSession ? reserveSessionTab() : null;
      void run(async () => {
        try {
          await record("session", text);
        } catch (e) {
          tab?.close();
          throw e;
        }
        if (tab) {
          afterSession?.(tab, {
            verdict: "session",
            sentence: text || undefined,
          });
        }
      });
      return;
    }

    void run(() => record(mode, text));
  };

  if (!todo && !code) return null;

  const chips: { mode: Mode; label: string }[] = [];
  if (rulable) for (const v of VERDICTS) chips.push({ mode: v, label: v });
  // Done is available wherever the row is not already done — a waiting todo is
  // finished the same way an active one is.
  if (todo && todo.status !== "done") {
    chips.push({ mode: "done", label: "done" });
  }
  // A rulable subject already has the archive VERDICT (which archives the row
  // itself) — never both.
  if (todo && !rulable && todo.status !== "archived") {
    chips.push({ mode: "set-archived", label: "archive" });
  }

  if (chips.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {chips.map((c) => (
          <button
            key={c.mode}
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setNote("");
              setMode((m) => (m === c.mode ? null : c.mode));
            }}
            className={`${btnCls} ${mode === c.mode ? "border-accent/60 text-text" : ""}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {mode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={PLACEHOLDER[mode]}
            autoFocus
            className={`${inputCls} flex-1 min-w-56 max-w-md`}
          />
          <button
            type="submit"
            disabled={busy || (mode === "revise" && !note.trim())}
            className={btnCls}
          >
            {mode === "set-archived" ? "archive" : mode}
          </button>
          <Info call={INFO[mode].call}>{INFO[mode].body}</Info>
        </form>
      )}

      {error && <div className="text-xs text-error">{error}</div>}
    </div>
  );
}
