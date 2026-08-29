"use client";

// Session view: header facts, transcript, pending permission cards pinned
// above the composer, composer. Fills the viewport below the site nav so the
// transcript is the only scrolling region (phone-first).

import Link from "next/link";
import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ageText, isLive, shortAge, statusChipClass } from "../lib";
import Transcript from "./transcript";
import AgentPanel from "./agent-panel";
import PermissionCard from "./permission-card";
import Composer from "./composer";

const LAST_OUTPUT_QUIET_MS = 2 * 60_000;

export default function SessionView({
  sessionId,
  now,
  daemonStale,
  daemonLastSeenAt,
  onBack,
}: {
  sessionId: Id<"claudeSessions">;
  now: number;
  daemonStale: boolean;
  daemonLastSeenAt: number | undefined;
  onBack: () => void;
}) {
  const session = useQuery(api.claudeSessions.getSession, { id: sessionId });
  const pendingPermissions = useQuery(api.claudeSessions.getPendingPermissions, {
    sessionId,
  });

  // The agent panel holds a live Convex subscription, so `hidden sm:block`
  // alone would still pay for it on a phone that never shows it — mount it
  // only when the viewport is already wide. 640px is Tailwind's own sm.
  // Read once at mount, with no resize tracking on purpose: the subscription
  // cost is the point, and orientation flips across the breakpoint are rare
  // (one reload picks the panel up). false until the effect runs, so the
  // server render and the phone agree.
  const [wideViewport, setWideViewport] = useState(false);
  useEffect(() => {
    setWideViewport(window.matchMedia("(min-width: 640px)").matches);
  }, []);

  if (session === undefined) {
    return (
      <div className="px-4 py-6 text-sm text-text-faint">loading session…</div>
    );
  }

  if (session === null) {
    return (
      <div className="px-4 py-6 space-y-3">
        <div className="border border-border rounded-lg bg-surface/40 px-4 py-3 text-sm text-text-muted">
          session not found
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded px-3 py-1.5 text-sm border border-border text-text-muted hover:bg-surface-alt"
        >
          Back to sessions
        </button>
      </div>
    );
  }

  const quietWhileRunning =
    session.status === "running" &&
    session.lastSdkEventAt !== undefined &&
    now - session.lastSdkEventAt > LAST_OUTPUT_QUIET_MS;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="border-b border-border px-3 sm:px-4 py-2.5 space-y-1">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to sessions"
            className="shrink-0 rounded px-2 py-1 text-sm border border-border text-text-muted hover:bg-surface-alt"
          >
            &larr;
          </button>
          <h1 className="text-sm sm:text-base text-text truncate min-w-0 flex-1">
            {session.title}
          </h1>
          {session.mode === "autonomous" && (
            <span className="shrink-0 border border-border rounded px-1.5 py-0.5 text-xs text-text-muted">
              autonomous
            </span>
          )}
          <span
            className={`shrink-0 border rounded px-1.5 py-0.5 text-xs ${statusChipClass(session.status)}`}
          >
            {session.status}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-text-faint pl-9">
          <span>{session.repo}</span>
          <span>{ageText(session.statusChangedAt, now)}</span>
          {session.todoId !== undefined && (
            <Link
              href={`/dts?item=${session.todoId}`}
              className="text-accent hover:underline"
            >
              linked item
            </Link>
          )}
          {session.cwd !== undefined && (
            <span className="truncate max-w-full">{session.cwd}</span>
          )}
          {quietWhileRunning && session.lastSdkEventAt !== undefined && (
            <span>
              last output {shortAge(session.lastSdkEventAt, now)} ago
            </span>
          )}
          {daemonStale && isLive(session.status) && (
            <span>
              as of{" "}
              {daemonLastSeenAt !== undefined
                ? ageText(daemonLastSeenAt, now)
                : "an unknown time"}
            </span>
          )}
        </div>
      </header>

      {/* Transcript + permission cards are the conversation column; the agent
          panel is a sibling, not a floating overlay. Below sm the phone gets
          the conversation alone (the panel's facts are all in the transcript
          anyway) and the panel is never mounted; on wide viewports the
          wrapper still collapses to zero width when there is no open tool
          work, and keeps sm:block so a narrowed window hides it. */}
      <div className="flex-1 min-h-0 flex flex-row">
        <div className="flex-1 min-w-0 flex flex-col">
          <Transcript sessionId={sessionId} />

          {pendingPermissions && pendingPermissions.length > 0 && (
            <div className="border-t border-border px-3 sm:px-4 py-2.5 space-y-2 max-h-[45dvh] overflow-y-auto">
              {pendingPermissions.map((p) => (
                <PermissionCard key={p._id} permission={p} now={now} />
              ))}
            </div>
          )}
        </div>
        {wideViewport && (
          <div className="hidden sm:block shrink-0 min-h-0">
            <AgentPanel sessionId={sessionId} />
          </div>
        )}
      </div>

      <Composer session={session} daemonStale={daemonStale} />
    </div>
  );
}
