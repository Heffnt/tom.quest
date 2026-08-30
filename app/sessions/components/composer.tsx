"use client";

// Composer + session controls. Enter inserts a newline; Ctrl/Cmd+Enter sends;
// the Send button always works. On an ended/failed session the same box stays,
// with the descriptive status line above it and a send that reopens the
// session (the daemon resumes the SDK session by id). Interrupt while running
// or awaiting-permission; Stop with an inline confirm; Force close only when
// the worker heartbeat is stale.

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Session } from "../lib";
import { isLive } from "../lib";

const MAX_TEXTAREA_PX = 160;

export default function Composer({
  session,
  daemonStale,
}: {
  session: Session;
  daemonStale: boolean;
}) {
  const sendMessage = useMutation(api.claudeSessions.sendMessage);
  const sendControl = useMutation(api.claudeSessions.sendControl);
  const forceClose = useMutation(api.claudeSessions.forceClose);
  const reopenSession = useMutation(api.claudeSessions.reopenSession);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const live = isLive(session.status);

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  };

  // One submit path for both postures — the only difference is which mutation
  // the text goes to. reopenSession queues the text as the next turn on a
  // session whose status is ended/failed.
  const send = async (reopen = false) => {
    if (text.trim() === "" || sending) return;
    setSending(true);
    setError(null);
    try {
      if (reopen) await reopenSession({ sessionId: session._id, text });
      else await sendMessage({ sessionId: session._id, text });
      setText("");
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
    } finally {
      setSending(false);
    }
  };

  const control = async (kind: "interrupt" | "stop") => {
    setError(null);
    setConfirmingStop(false);
    try {
      await sendControl({ sessionId: session._id, kind });
    } catch (e) {
      setError(e instanceof Error ? e.message : `${kind} failed`);
    }
  };

  const doForceClose = async () => {
    setError(null);
    try {
      await forceClose({ sessionId: session._id });
    } catch (e) {
      // Thrown when the daemon came back — surface the text verbatim.
      setError(e instanceof Error ? e.message : "force-close failed");
    }
  };

  // The label says exactly what the button does — on an ended session the
  // same text also restarts it, so the label carries that.
  const textRow = (label: string, reopen: boolean) => (
    <div className="flex items-end gap-2">
      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        onChange={(e) => {
          setText(e.target.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send(reopen);
          }
        }}
        placeholder="message the session"
        className="flex-1 min-w-0 resize-none bg-surface-alt border border-border rounded px-3 py-2 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={() => void send(reopen)}
        disabled={sending || text.trim() === ""}
        className="shrink-0 rounded px-4 py-2 text-sm border border-accent text-accent hover:bg-surface-alt disabled:opacity-50"
      >
        {label}
      </button>
    </div>
  );

  if (!live) {
    return (
      <div className="border-t border-border px-3 sm:px-4 py-2.5 space-y-2">
        <div className="text-sm text-text-muted">
          session {session.status}
          {session.endedReason ? ` — ${session.endedReason}` : ""}
        </div>
        {/* The arrival headline for an ended session — what it came to. It used
            to sit in the header band above the transcript; that band is gone,
            and this line is the one place an ended session is already being
            described, so the outcome joins it rather than hiding in the bar's
            details dialog. Reachable only from this branch, which is already
            gated on the session not being live. */}
        {session.outcome !== undefined && (
          <div
            className={`text-xs break-words ${
              session.outcome === "errored" ? "text-error" : "text-text-faint"
            }`}
          >
            outcome: {session.outcome}
            {session.outcomeSummary ? ` — ${session.outcomeSummary}` : ""}
          </div>
        )}
        {error && <div className="text-xs text-error">{error}</div>}
        {textRow("Send — reopens session", true)}
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 sm:px-4 py-2.5 space-y-2">
      {error && <div className="text-xs text-error">{error}</div>}
      {textRow("Send", false)}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* The daemon supports interrupt while awaiting-permission too — it
            supersedes the parked permission request. */}
        {(session.status === "running" ||
          session.status === "awaiting-permission") && (
          <button
            type="button"
            onClick={() => void control("interrupt")}
            className="rounded px-2.5 py-1 border border-border text-text-muted hover:bg-surface-alt"
          >
            Interrupt
          </button>
        )}
        {confirmingStop ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-text-muted">
              stop? committed work is pushed to the session branch; uncommitted
              changes are discarded
            </span>
            <button
              type="button"
              onClick={() => void control("stop")}
              className="rounded px-2.5 py-1 border border-error/60 text-error hover:bg-surface-alt"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={() => setConfirmingStop(false)}
              className="rounded px-2.5 py-1 border border-border text-text-muted hover:bg-surface-alt"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingStop(true)}
            className="rounded px-2.5 py-1 border border-border text-text-muted hover:bg-surface-alt"
          >
            Stop session
          </button>
        )}
        {daemonStale && (
          <button
            type="button"
            onClick={() => void doForceClose()}
            className="rounded px-2.5 py-1 border border-error/60 text-error hover:bg-surface-alt"
          >
            Force close
          </button>
        )}
      </div>
    </div>
  );
}
