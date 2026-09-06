"use client";

// THE FOUR VERDICT BUTTONS — approve, revise, session, archive — as one row,
// wherever a ruling is given on a batch card or in the detail dialog. The
// labels are the four verdict words convex/ttsRulings.ts accepts and nothing
// else: "edit" was never a verdict (it stored revise under another name), so
// it is gone from the row. Editing a todo's fields still lives in the todo
// row's edit disclosure, which is not a ruling.
//
// Each button fires ttsRulings.recordRuling with that verdict on the subject,
// and the ⓘ beside each names that call and what it sets in motion (the one
// info mechanism, ratified 2026-08-29). The two sentence verdicts — revise,
// whose sentence the mutation requires, and archive, whose sentence is the
// condition to propose the subject back — open RulingDialog, a fixed overlay,
// so nothing on the page shifts. approve records on the press. session records
// on the press too, and the owner opens the session: the browser tab for it
// has to be reserved inside the press (window.open only works in the gesture
// stack), which is why onRule is called synchronously from the click.
//
// This one component is EVERY verdict row on /tts — the batch card, the detail
// dialog, and OptionsRow (which renders it beside the two status chips a life
// todo also carries). There is no second way to give a verdict, so the row
// cannot drift between surfaces and no surface composes a sentence inline.

import { useState } from "react";
import { createPortal } from "react-dom";
import Info from "./info";
import RulingDialog, { type SentenceVerdict } from "./ruling-dialog";
import { VERDICTS_EXPLANATION } from "../explanations";
import { errMessage, VERDICTS, type RulingVerdict } from "../lib";

/** What the ruling is on. A batch is its own row; a todo is a dtsTodos row;
 * a code subject is a repo plus its id in that repo's todo file. */
export type VerdictSubject = "batch" | "todo" | "code";

const SUBJECT_ARGS: Record<VerdictSubject, string> = {
  batch: "batchId",
  todo: "todoId",
  code: "repo, externalId",
};

/** The exact call a verdict button fires, for the popover's mono line. */
export function verdictCall(
  subject: VerdictSubject,
  verdict: RulingVerdict,
): string {
  return `ttsRulings.recordRuling({ ${SUBJECT_ARGS[subject]}, verdict: "${verdict}", sentence })`;
}

const VERDICTS_EXPLANATION_TITLE =
  "the four verdicts, and what each one sets in motion";

// What each verdict does downstream, per subject — the plain half of the
// popover. "recordRuling" says nothing about which job wakes up next, and that
// is the thing worth knowing before pressing. Every line here restates what
// convex/ttsRulings.ts insertRuling does for that verdict, and what consumes
// the ruling afterwards; change one with the other.
export const VERDICT_EFFECT: Record<
  VerdictSubject,
  Record<RulingVerdict, string>
> = {
  batch: {
    approve:
      "Records your go-ahead on this graph as a ruling, applied the moment it is stored. The batch is stamped as touched by you, which stops the planner re-forming it. Nothing executes it: the ready tasks are worked as they are.",
    revise:
      "Hands the graph back to the planner with your sentence as the redirection. The batch is not stamped as touched, so the planner may rewrite it, and it reads your sentence from the recent rulings. Your sentence is the whole instruction, so it has to stand on its own.",
    session:
      "Records that this batch needs a conversation, then opens a session on it in a new tab with the ruling in the opening prompt. While the ruling stands, the scheduler pauses the graph's tasks for a day rather than working them out from under you.",
    archive:
      "Sets the batch aside: its status becomes archived, your sentence is stored as the condition to propose it back, its unfinished tasks are archived with it, and its goals are unbound and returned to the pool. Nothing is deleted.",
  },
  todo: {
    approve:
      "Marks this as decided your way: the ruling is stored and applied at once, and the todo is stamped as touched by you. Nothing executes a life todo — you are its executor — so this records your call and stops asking.",
    revise:
      "Sends it back to be prepared again, with your sentence as the redirection: readiness drops to unprepared, and the preparer re-writes the brief against what you said and returns it as prepared. Your sentence is the whole instruction, so it has to stand on its own.",
    session:
      "Says this needs a conversation rather than a ruling, and opens the session in a new tab with the ruling in its opening prompt. The ruling is consumed the moment a session you open on it exists — an autonomous run that happens to claim the same item never consumes it, so the conversation you asked for still happens.",
    archive:
      "Sets it aside: its status becomes archived and your sentence is stored as the condition under which it should be proposed back, so nothing is lost — archived is a resting state, not a delete.",
  },
  code: {
    approve:
      "Marks this as decided your way. The ruling waits for the picker on the Jarvis Box, which starts a session on a fresh checkout of the repository, does the work on the session's branch, and opens a pull request; merging stays yours. The ruling is marked applied the moment that session is started.",
    revise:
      "Sends it back to be planned again, with your sentence as the redirection: the planner on the Jarvis Box re-writes the brief with a fresh plan against what you said on its next half-hourly run, and the ruling is marked applied once the new brief is stored. Your sentence is the whole instruction, so it has to stand on its own.",
    session:
      "Says this needs a conversation rather than a ruling. No session opens from here: the ruling is applied the moment you open the code block session from the calendar — its opening prompt names this item and your note — and the item waits for you until then.",
    archive:
      "Sets it aside: the ruling waits for the picker on the Jarvis Box, which starts a session that closes the entry in the repository's own todo file and opens a pull request for it; merging stays yours. Your sentence is kept with the ruling as the condition to propose it back.",
  },
};

// What the dialog asks for, per sentence verdict. revise's sentence is the
// whole redirection; archive's is the condition to propose the subject back.
const PLACEHOLDER: Record<SentenceVerdict, string> = {
  revise: "the sentence that redirects the agent (required)",
  archive: "propose it back when… (optional)",
};

const btnCls =
  "rounded-md border border-border bg-surface-alt px-2.5 py-1 text-xs text-text-muted hover:border-text-faint hover:text-text disabled:opacity-50 disabled:pointer-events-none";

export default function VerdictButtons({
  subject,
  statement,
  error: externalError,
  onRule,
}: {
  subject: VerdictSubject;
  /** The subject's statement, for the dialog's heading. */
  statement: string;
  /**
   * A failure the CALLER is holding rather than throwing — the session hooks
   * catch their own errors into state (app/lib/use-open-todo-session.ts), and
   * a session that failed to open after a session verdict has nowhere else to
   * be seen from inside a dialog. Shown on the same line as a refused ruling.
   */
  error?: string | null;
  /**
   * Records the ruling: ttsRulings.recordRuling on the subject with this
   * verdict and sentence (empty for approve and session). Called synchronously
   * inside the press, so a session verdict can reserve its tab. A rejection
   * is shown under the row (approve, session) or in the dialog (revise,
   * archive).
   */
  onRule: (verdict: RulingVerdict, sentence: string) => Promise<unknown> | void;
}) {
  const [dialog, setDialog] = useState<SentenceVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const press = (verdict: RulingVerdict) => {
    if (verdict === "revise" || verdict === "archive") {
      setError(null);
      setDialog(verdict);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // onRule runs before the first await: still in the click's gesture
        // stack, where a session verdict reserves its browser tab.
        await onRule(verdict, "");
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        {VERDICTS.map((verdict) => (
          <span key={verdict} className="inline-flex items-center gap-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => press(verdict)}
              className={btnCls}
            >
              {verdict}
            </button>
            <Info
              call={verdictCall(subject, verdict)}
              explanation={VERDICTS_EXPLANATION}
              explanationTitle={VERDICTS_EXPLANATION_TITLE}
            >
              {VERDICT_EFFECT[subject][verdict]}
            </Info>
          </span>
        ))}
      </div>
      {(error ?? externalError) && (
        <div className="text-xs text-error">{error ?? externalError}</div>
      )}
      {dialog &&
        typeof document !== "undefined" &&
        // Sent to <body>: the row sits inside a card, or inside the detail
        // dialog's scrolling panel, and a fixed overlay must not be clipped
        // or stacked by either.
        createPortal(
          <RulingDialog
            action={dialog}
            confirm={`record ${dialog}`}
            placeholder={PLACEHOLDER[dialog]}
            required={dialog === "revise"}
            call={verdictCall(subject, dialog)}
            effect={VERDICT_EFFECT[subject][dialog]}
            statement={statement}
            onConfirm={(sentence) => onRule(dialog, sentence)}
            onClose={() => setDialog(null)}
          />,
          document.body,
        )}
    </div>
  );
}
