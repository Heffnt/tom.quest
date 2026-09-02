"use client";

// The one dialog every action chip opens. Fixed overlay — nothing on the
// page moves. Three input shapes, one per option kind:
//   approve / archive — a choice, with an optional note
//   edit              — a short answer an agent applies (absorbs revise,
//                       schedule, reshaping, re-pathing, anything sayable)
//   (session is its own thing and opens directly, not through this dialog)
// The dialog always states where the batch stands before asking for input.
import { useState } from "react";
import { planNeedsYou, type PlanStep } from "../lib";
import { nextStep, planProgress } from "./plan-bar";

export type RulingVerdict = "approve" | "archive" | "edit";

const COPY: Record<
  RulingVerdict,
  { does: string; call: string; placeholder: string; confirm: string }
> = {
  approve: {
    does: "Records your go-ahead as a ruling. Agents work through the remaining agent steps; once nothing is open, the batch is marked done.",
    call: 'ttsRulings.recordRuling({verdict:"approve", sentence})',
    placeholder: "anything to add (optional)",
    confirm: "record approve",
  },
  archive: {
    does: "Puts the batch away — nothing is deleted. It is proposed back when the condition you write here is met.",
    call: 'ttsRulings.recordRuling({verdict:"archive", sentence})',
    placeholder: "bring it back when… (optional)",
    confirm: "record archive",
  },
  edit: {
    does: "Say anything about this batch — reschedule it, reorder or drop steps, split it, reword it, move it to another path. An agent reads your words and applies them; the result shows here when it lands.",
    // The chip says "edit" (Tom's word); the stored verdict is still named
    // "revise" — the mono line shows the CALL, so it shows the true name.
    call: 'ttsRulings.recordRuling({verdict:"revise", sentence})',
    placeholder: "e.g. after the paper batch · drop step 3 · not until saturday · split the turing items out",
    confirm: "send edit",
  },
};

export default function RulingDialog({
  verdict,
  statement,
  brief,
  plan,
  onConfirm,
  onClose,
}: {
  verdict: RulingVerdict;
  statement: string;
  brief?: string;
  plan?: PlanStep[];
  /** Records the ruling. Required: this dialog never closes without writing. */
  onConfirm: (sentence: string) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = COPY[verdict];
  const { done, total } = planProgress(plan);
  const next = nextStep(plan);
  // "open on you" means exactly what the card's needs-you strip means, so it
  // is read from the same function rather than filtered again here.
  const openTom = planNeedsYou(plan).count;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] max-w-full rounded-xl border border-[#3b4a66] bg-surface p-4">
        <h3 className="text-[15px] font-semibold">{verdict}</h3>
        <p className="mt-0.5 text-sm text-text">{statement}</p>

        <div className="mt-2 rounded-md bg-surface-alt/60 px-2.5 py-2 text-xs text-text-muted">
          {total > 0 ? (
            <>
              {done} of {total} plan steps done
              {openTom > 0 && (
                <span className="text-accent"> · {openTom} open on you</span>
              )}
              {next && (
                <div className="mt-0.5 truncate">
                  next: {next.actor === "tom" ? "you" : "agents"} — {next.text}
                </div>
              )}
            </>
          ) : (
            <span>{brief ?? "no plan yet"}</span>
          )}
        </div>

        <p className="mt-2 text-xs text-text-muted">{c.does}</p>
        <div className="mt-0.5 font-mono text-[10px] text-text-faint">
          {c.call}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={c.placeholder}
          autoFocus={verdict === "edit"}
          className="mt-2.5 min-h-16 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text placeholder:text-text-faint"
        />

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:text-text"
          >
            cancel
          </button>
          <button
            type="button"
            // "edit" stores the revise verdict, which REQUIRES its sentence —
            // the server refuses an empty one, so the button is not offered.
            disabled={busy || (verdict === "edit" && text.trim() === "")}
            onClick={() => {
              setBusy(true);
              setError(null);
              void (async () => {
                try {
                  await onConfirm(text.trim());
                  onClose();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                  setBusy(false);
                }
              })();
            }}
            className="rounded-md border border-accent bg-accent-dim px-3 py-1 text-[13px] text-accent hover:opacity-80 disabled:opacity-40 disabled:pointer-events-none"
          >
            {c.confirm}
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-error">{error}</div>}
      </div>
    </div>
  );
}
