"use client";

// THE ONE PLACE ANYTHING IS COMPOSED on /tts — a fixed overlay, so nothing on
// the page moves (app/AGENTS.md UI rules: interactions never shift layout; anything
// composed opens in a fixed dialog, never an inline form between controls).
//
// Two callers, one mechanism. The two SENTENCE VERDICTS (verdict-buttons.tsx):
// revise requires its sentence — it is the whole redirection the agent
// receives, and convex/ttsRulings.ts refuses a revise without one — and archive
// takes an optional sentence, the condition under which the subject should be
// proposed back. approve and session take no sentence and never open this
// dialog (they record on the press). And the two STATUS ACTIONS on a life todo
// (options-row.tsx): done with its note, archive with its unarchive condition.
//
// The dialog names the subject and asks for the sentence; the confirm button's
// label is the exact effect — "record revise", "mark done" — and its ⓘ names
// the call. Every word of that comes from the caller: this component knows
// nothing about verdicts.
//
// It used to open with a progress line over the subject's plan — "3 of 7 steps
// done · next: you — …". That plan is the retired v1 field, and its picture
// was the plan bar, which went with the paths bar and the drawn graph (the
// lifeos update, phase 7): where the work of a batch stands is the batch
// card's business, and repeating it here told a reader nothing about the
// sentence they were being asked for.
import { useState } from "react";
import Info from "./info";
import { VERDICTS_EXPLANATION } from "../explanations";
import { errMessage } from "../lib";

export type SentenceVerdict = "revise" | "archive";

export default function RulingDialog({
  action,
  confirm,
  placeholder,
  required = false,
  call,
  effect,
  statement,
  onConfirm,
  onClose,
}: {
  /** The heading: the word for what is being composed ("revise", "done"). */
  action: string;
  /** The confirm button's label — its exact backend effect, in words. */
  confirm: string;
  placeholder: string;
  /** The sentence is required (revise — the server refuses an empty one). */
  required?: boolean;
  /** The exact call the confirm fires — the popover's mono line. The control
   * that opened this dialog owns both texts. */
  call: string;
  /** What that call sets in motion — the popover's plain half. */
  effect: string;
  statement: string;
  /** Records it. Absent = the dialog only closes. */
  onConfirm?: (sentence: string) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] max-w-full rounded-xl border border-[#3b4a66] bg-surface p-4">
        <h3 className="text-[15px] font-semibold">{action}</h3>
        <p className="mt-0.5 text-sm text-text">{statement}</p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          autoFocus
          className="mt-2.5 min-h-16 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text placeholder:text-text-faint"
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:text-text"
          >
            cancel
          </button>
          <button
            type="button"
            // revise REQUIRES its sentence — the server refuses an empty one,
            // so the button is not offered until there is one.
            disabled={busy || (required && text.trim() === "")}
            onClick={() => {
              if (!onConfirm) {
                onClose();
                return;
              }
              setBusy(true);
              setError(null);
              void (async () => {
                try {
                  await onConfirm(text.trim());
                  onClose();
                } catch (e) {
                  setError(errMessage(e));
                  setBusy(false);
                }
              })();
            }}
            className="rounded-md border border-accent bg-accent-dim px-3 py-1 text-[13px] text-accent hover:opacity-80 disabled:opacity-40 disabled:pointer-events-none"
          >
            {confirm}
          </button>
          <Info
            call={call}
            explanation={VERDICTS_EXPLANATION}
            explanationTitle="the four verdicts, and what each one sets in motion"
          >
            {effect}
          </Info>
        </div>
        {error && <div className="mt-2 text-xs text-error">{error}</div>}
      </div>
    </div>
  );
}
