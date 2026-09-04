"use client";

// Cross-family model change. A session's model can be swapped in place inside
// one family (setSessionModel), because the transcript the runner is holding
// stays valid. Across families it cannot: Claude Code and the Codex CLI hold
// different conversations, so the change is a NEW session seeded with this
// one's transcript, which needs a first message to run on — hence a dialog and
// not a silent select.
//
// Fixed overlay, same shape as the TTS ruling dialog: nothing behind it moves
// (the ratified rule), and the confirm button names the call it fires.

import { useState } from "react";
import type { SessionModel } from "../lib";

export default function ForkDialog({
  fromModel,
  toModel,
  onConfirm,
  onClose,
}: {
  fromModel: SessionModel;
  toModel: SessionModel;
  /** Fires forkSessionAs and returns once the new session is open. */
  onConfirm: (text: string) => Promise<void>;
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
      <div className="w-[440px] max-w-full rounded-xl border border-border bg-surface p-4">
        <h3 className="text-[15px] font-semibold">
          {fromModel} &rarr; {toModel}
        </h3>
        <p className="mt-1.5 text-xs text-text-muted">
          This session is stopped and ends normally. A new session on {toModel}{" "}
          then starts from its full transcript, and the view moves to that one.
        </p>
        <div className="mt-0.5 font-mono text-[10px] text-text-faint">
          claudeSessions.forkSessionAs(&#123; sessionId, model, text &#125;)
        </div>

        <textarea
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          placeholder="first message"
          className="mt-2.5 min-h-16 w-full resize-y rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text placeholder:text-text-faint focus:outline-none focus:border-accent"
        />

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1 text-[13px] text-text-muted hover:text-text hover:bg-surface-alt"
          >
            cancel
          </button>
          <button
            type="button"
            // The new session has nothing to run on without it, so an empty
            // box is not offered rather than refused after the round trip.
            disabled={busy || text.trim() === ""}
            onClick={() => {
              setBusy(true);
              setError(null);
              void (async () => {
                try {
                  await onConfirm(text.trim());
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                  setBusy(false);
                }
              })();
            }}
            className="rounded-md border border-accent bg-accent-dim px-3 py-1 font-mono text-[11px] text-accent hover:opacity-80 disabled:opacity-40 disabled:pointer-events-none"
          >
            forkSessionAs(sessionId, &quot;{toModel}&quot;)
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-error">{error}</div>}
      </div>
    </div>
  );
}
