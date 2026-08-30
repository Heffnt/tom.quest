"use client";

// Session view: transcript first — it owns the top edge of the screen. Every
// piece of chrome that used to sit above it (the site nav, the worker banner,
// the header band of title/status/facts) is now either covered, moved below,
// or behind the bar's "details" dialog. Reading order top to bottom is:
//
//   transcript (the only scrolling region)
//   pending permission cards, pinned above the composer
//   the worker notice, when the daemon is stale or rejected a write
//   the session bar — back, title, status, details
//   the composer and its session controls
//
// The column is the whole viewport (see sessions-client.tsx), not the
// viewport minus a nav.

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import Transcript from "./transcript";
import AgentPanel from "./agent-panel";
import PermissionCard from "./permission-card";
import SessionBar from "./session-bar";
import Composer from "./composer";

export default function SessionView({
  sessionId,
  now,
  daemonStale,
  daemonLastSeenAt,
  notice,
  onBack,
}: {
  sessionId: Id<"claudeSessions">;
  now: number;
  daemonStale: boolean;
  daemonLastSeenAt: number | undefined;
  /** Worker-health notice, rendered at the BOTTOM so it never costs the
   *  transcript its top edge. Null when the worker is healthy. */
  notice: ReactNode;
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

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Transcript + permission cards are the conversation column; the agent
          panel is a sibling, not a floating overlay. Below sm the phone gets
          the conversation alone (the panel's facts are all in the transcript
          anyway) and the panel is never mounted; on wide viewports the
          wrapper still collapses to zero width when there is no open tool
          work, and keeps sm:block so a narrowed window hides it. */}
      <div className="flex-1 min-h-0 flex flex-row">
        <div className="flex-1 min-w-0 flex flex-col">
          <Transcript sessionId={sessionId} sessionStatus={session.status} />

          {pendingPermissions && pendingPermissions.length > 0 && (
            // Cards may never crowd out the transcript (Tom's ruling): a
            // compact strip that scrolls, not a half-screen tray.
            <div className="border-t border-border px-3 sm:px-4 py-2 space-y-1.5 max-h-40 overflow-y-auto">
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

      {notice}

      <SessionBar
        session={session}
        now={now}
        daemonStale={daemonStale}
        daemonLastSeenAt={daemonLastSeenAt}
        onBack={onBack}
      />

      <Composer session={session} daemonStale={daemonStale} />
    </div>
  );
}
