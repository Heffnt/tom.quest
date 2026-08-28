"use client";

// Composer + session controls. Enter inserts a newline; Ctrl/Cmd+Enter sends;
// the Send button always works. Disabled with a descriptive line once the
// session is ended/failed. Interrupt while running or awaiting-permission;
// Stop with an inline confirm; Force close only when the worker heartbeat
// is stale.

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

  const send = async () => {
    if (text.trim() === "" || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage({ sessionId: session._id, text });
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

  if (!live) {
    return (
      <div className="border-t border-border px-3 sm:px-4 py-3 text-sm text-text-muted">
        session {session.status}
        {session.endedReason ? ` — ${session.endedReason}` : ""}
      </div>
    );
  }

  return (
    <div className="border-t border-border px-3 sm:px-4 py-2.5 space-y-2">
      {error && <div className="text-xs text-error">{error}</div>}
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
              void send();
            }
          }}
          placeholder="message the session"
          className="flex-1 min-w-0 resize-none bg-surface-alt border border-border rounded px-3 py-2 text-sm placeholder:text-text-faint focus:outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim() === ""}
          className="shrink-0 rounded px-4 py-2 text-sm border border-accent text-accent hover:bg-surface-alt disabled:opacity-50"
        >
          Send
        </button>
      </div>
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
          <span className="flex items-center gap-2">
            <span className="text-text-muted">stop this session?</span>
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
