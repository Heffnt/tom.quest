"use client";

// The session's identity and its exits — at the BOTTOM of the screen.
//
// Nothing of the app's own sits above the transcript on this route, so
// everything the old header band carried lives here instead, one line tall,
// directly above the composer:
//   • the way back to the session list (the only exit once the site nav is
//     covered — deleting it would strand the reader)
//   • which session this is; tapping the title swaps in a rename input of the
//     same size, so nothing on the screen moves
//   • whether it is running (the status chip, plus the autonomous chip)
//   • "details", which opens the rest of the old header — repo, cwd, ages,
//     linked item, outcome — as a fixed dialog
//
// One line, because every row added here is a row the transcript does not get.

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Session } from "../lib";
import { ageText, isLive, shortAge, statusChipClass } from "../lib";

const LAST_OUTPUT_QUIET_MS = 2 * 60_000;

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[86px_1fr] gap-2 text-[13px]">
      <span className="pt-0.5 text-[11px] uppercase tracking-wide text-text-faint">
        {label}
      </span>
      <span className="min-w-0 break-words text-text-muted">{children}</span>
    </div>
  );
}

export default function SessionBar({
  session,
  now,
  daemonStale,
  daemonLastSeenAt,
  onBack,
}: {
  session: Session;
  now: number;
  daemonStale: boolean;
  daemonLastSeenAt: number | undefined;
  onBack: () => void;
}) {
  const renameSession = useMutation(api.claudeSessions.renameSession);

  // Rename: the title IS the control — tapping it swaps in an input that looks
  // the same. Enter blurs (the blur handler is the single save path, so Enter
  // and click-away cannot both fire it); Escape sets this flag first so the
  // blur it causes discards instead of saves. Moved verbatim from the header
  // this bar replaces.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const cancelRename = useRef(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const commitRename = (value: string) => {
    setTitleDraft(null);
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const next = value.trim();
    if (next === "" || next === session.title) return;
    void renameSession({ sessionId: session._id, title: next });
  };

  const quietWhileRunning =
    session.status === "running" &&
    session.lastSdkEventAt !== undefined &&
    now - session.lastSdkEventAt > LAST_OUTPUT_QUIET_MS;

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-1.5 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to sessions"
          className="shrink-0 rounded border border-border px-2 py-0.5 text-sm text-text-muted hover:bg-surface-alt"
        >
          &larr;
        </button>
        {titleDraft === null ? (
          <button
            type="button"
            onClick={() => {
              cancelRename.current = false;
              setTitleDraft(session.title);
            }}
            aria-label="Rename session"
            className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm text-text hover:bg-surface-alt"
          >
            {session.title}
          </button>
        ) : (
          <input
            type="text"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                cancelRename.current = true;
                e.currentTarget.blur();
              }
            }}
            className="min-w-0 flex-1 border-b border-accent/60 bg-transparent px-1 py-0.5 text-sm text-text focus:outline-none"
          />
        )}
        {session.mode === "autonomous" && (
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-text-muted">
            autonomous
          </span>
        )}
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${statusChipClass(session.status)}`}
        >
          {session.status}
        </span>
        <button
          type="button"
          onClick={() => setDetailsOpen(true)}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-text-muted hover:bg-surface-alt"
        >
          details
        </button>
      </div>

      {detailsOpen && (
        // Fixed dialog, not an inline panel: opening it must not move the
        // transcript (UI rule — interactions never shift layout).
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDetailsOpen(false);
          }}
        >
          <div className="max-h-[80vh] w-[440px] max-w-full overflow-y-auto rounded-xl border border-[#3b4a66] bg-surface p-4">
            <h3 className="text-[15px] font-semibold break-words">
              {session.title}
            </h3>
            <div className="mt-2 flex flex-col gap-1.5">
              <DetailRow label="status">
                {session.status} · {ageText(session.statusChangedAt, now)}
              </DetailRow>
              <DetailRow label="repo">{session.repo}</DetailRow>
              {session.cwd !== undefined && (
                <DetailRow label="cwd">
                  <span className="font-mono text-[11px]">{session.cwd}</span>
                </DetailRow>
              )}
              <DetailRow label="mode">{session.mode}</DetailRow>
              {session.todoId !== undefined && (
                <DetailRow label="item">
                  <Link
                    href={`/tts?item=${session.todoId}`}
                    className="text-accent underline"
                  >
                    linked item
                  </Link>
                </DetailRow>
              )}
              {quietWhileRunning && session.lastSdkEventAt !== undefined && (
                <DetailRow label="last output">
                  {shortAge(session.lastSdkEventAt, now)} ago
                </DetailRow>
              )}
              {daemonStale && isLive(session.status) && (
                <DetailRow label="as of">
                  {daemonLastSeenAt !== undefined
                    ? ageText(daemonLastSeenAt, now)
                    : "an unknown time"}
                </DetailRow>
              )}
              {/* The arrival headline for an ended session. Live-gated like
                  session-list's copy of the same field — a reopened session
                  keeps its old outcome as history, which must not be read as
                  the state of an actively-streaming run. */}
              {!isLive(session.status) && session.outcome !== undefined && (
                <DetailRow label="outcome">
                  <span
                    className={
                      session.outcome === "errored" ? "text-error" : undefined
                    }
                  >
                    {session.outcome}
                    {session.outcomeSummary ? ` — ${session.outcomeSummary}` : ""}
                  </span>
                </DetailRow>
              )}
              <DetailRow label="id">
                <span className="font-mono text-[11px]">{session._id}</span>
              </DetailRow>
            </div>
            <p className="mt-3 text-xs text-text-muted">
              Tapping the title in the bar below renames this session for
              everyone; the daemon is not touched.
            </p>
            <div className="mt-0.5 font-mono text-[10px] text-text-faint">
              claudeSessions.renameSession({"{"}sessionId, title{"}"})
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setDetailsOpen(false)}
                className="rounded px-3 py-1.5 text-sm border border-border text-text-muted hover:bg-surface-alt"
              >
                close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
