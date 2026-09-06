"use client";

// THE options surface for every /tts subject — a life todo, a batch (a batch
// IS a life todo) or a code item. One compact wrap row at the top of an
// expanded panel: the four verdict chips and the status chips a life todo
// carries (done · archive).
//
// The verdicts are NOT re-implemented here. This row renders VerdictButtons
// (./verdict-buttons), the one verdict row on /tts, so the batch card, the
// detail dialog and this row cannot offer a different set, a different label
// or a different popover. What this row adds is the two status chips, which
// are not rulings: they write tts.setStatus directly.
//
// NOTHING IS COMPOSED INLINE (CLAUDE.md UI rules: interactions never shift
// layout; anything composed opens in a fixed dialog). A chip that needs a
// sentence — either status chip, and the revise and archive verdicts inside
// VerdictButtons — opens RulingDialog, a fixed overlay portalled to <body>, so
// the row it was pressed in never moves and is never clipped by the card
// around it.
//
// Every control names the exact backend call it fires behind an ⓘ (UI = code).

import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import Info from "./info";
import RulingDialog from "./ruling-dialog";
import VerdictButtons, { type VerdictSubject } from "./verdict-buttons";
import { VERDICTS_EXPLANATION } from "../explanations";
import {
  reserveSessionTab,
  type ReservedTab,
} from "@/app/lib/use-open-todo-session";
import type { LiveRulingContext } from "@/app/lib/tts-session-prompt";
import type { RulingVerdict, Todo } from "../lib";

const btnCls =
  "border border-border rounded-md px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-accent/60 disabled:opacity-50 disabled:pointer-events-none";

// ── The two status chips ────────────────────────────────────────────────────
// One entry per chip: the exact call, what it actually does downstream, and
// the words its dialog wears. The plain half is the point — "setStatus" says
// nothing about what happens to the row afterwards, and that is the thing
// worth knowing before pressing it (one info mechanism, ratified 2026-08-29).
// The four verdicts' equivalent text lives in verdict-buttons.tsx, the one
// home for it.
// The ground-up layer is ONE document for all six chips, not one per chip.
// What a reader standing on "approve" needs is approve RELATIVE to revise,
// session and archive, and a per-chip document could not give that without
// repeating the other five — so VERDICTS_EXPLANATION covers the whole surface
// and each chip differs only in its display text.
type StatusAction = "done" | "set-archived";

const STATUS_INFO: Record<
  StatusAction,
  {
    /** The chip's label, and the dialog's heading. */
    label: string;
    /** The dialog's confirm button — its exact backend effect, in words. */
    confirm: string;
    placeholder: string;
    call: string;
    body: string;
  }
> = {
  done: {
    label: "done",
    confirm: "mark done",
    placeholder: "note (optional)",
    call: 'tts.setStatus({ status: "done", note })',
    body: "Closes it as finished, with your note as the record of how. It stays visible in the archive; nothing in TTS is ever deleted.",
  },
  "set-archived": {
    label: "archive",
    confirm: "archive it",
    placeholder: "propose it back when… (optional)",
    call: 'tts.setStatus({ status: "archived", unarchiveCondition })',
    body: "Sets it aside without ruling on it. Your sentence is the condition that should bring it back, so a thing put down on purpose can be picked up again.",
  },
};

export type OptionsRowProps = {
  /** Life todo or batch row (a batch IS a life todo). Omit for code subjects. */
  todo?: Todo;
  /** Code subject. */
  code?: { repo: string; externalId: string };
  /** The subject's statement, for the dialog's heading. Defaults to the
   * todo's own; a code subject has to be told. */
  statement?: string;
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
  statement,
  rulable,
  afterSession,
}: OptionsRowProps) {
  const recordRuling = useMutation(api.ttsRulings.recordRuling);
  const setStatus = useMutation(api.tts.setStatus);

  const [status, setStatusDialog] = useState<StatusAction | null>(null);

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

  // Called synchronously inside the verdict press (verdict-buttons.tsx), which
  // is where a session verdict has to reserve its browser tab: browsers only
  // honour window.open in the gesture stack. Nothing opens a session for a
  // code subject, so nothing is reserved for one.
  const rule = (verdict: RulingVerdict, sentence: string) => {
    if (verdict !== "session" || !afterSession) return record(verdict, sentence);
    const tab = reserveSessionTab();
    return (async () => {
      try {
        await record("session", sentence);
      } catch (e) {
        tab.close();
        throw e;
      }
      afterSession(tab, {
        verdict: "session",
        sentence: sentence || undefined,
      });
    })();
  };

  if (!todo && !code) return null;

  const subject: VerdictSubject = todo ? "todo" : "code";
  const heading =
    statement ?? todo?.statement ?? `${code!.repo} ${code!.externalId}`;

  const chips: StatusAction[] = [];
  // Done is available wherever the row is not already done — a waiting todo is
  // finished the same way an active one is.
  if (todo && todo.status !== "done") chips.push("done");
  // A rulable subject already has the archive VERDICT (which archives the row
  // itself) — never both.
  if (todo && !rulable && todo.status !== "archived") chips.push("set-archived");

  if (!rulable && chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {rulable && (
        <VerdictButtons
          subject={subject}
          statement={heading}
          plan={todo?.plan}
          onRule={rule}
        />
      )}
      {chips.map((chip) => (
        <span key={chip} className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setStatusDialog(chip)}
            className={btnCls}
          >
            {STATUS_INFO[chip].label}
          </button>
          <Info
            call={STATUS_INFO[chip].call}
            explanation={VERDICTS_EXPLANATION}
            explanationTitle="the four verdicts, and what each one sets in motion"
          >
            {STATUS_INFO[chip].body}
          </Info>
        </span>
      ))}

      {status !== null &&
        todo &&
        typeof document !== "undefined" &&
        // Sent to <body>: this row sits inside a card or an expanded panel, and
        // a fixed overlay must not be clipped or stacked by either.
        createPortal(
          <RulingDialog
            action={STATUS_INFO[status].label}
            confirm={STATUS_INFO[status].confirm}
            placeholder={STATUS_INFO[status].placeholder}
            call={STATUS_INFO[status].call}
            effect={STATUS_INFO[status].body}
            statement={heading}
            plan={todo.plan}
            // A rejection propagates: the dialog stays open and shows it,
            // which is the only place a refused status write can be read.
            onConfirm={(text) =>
              status === "done"
                ? setStatus({
                    id: todo._id,
                    status: "done",
                    note: text || undefined,
                  })
                : setStatus({
                    id: todo._id,
                    status: "archived",
                    unarchiveCondition: text || undefined,
                  })
            }
            onClose={() => setStatusDialog(null)}
          />,
          document.body,
        )}
    </div>
  );
}
