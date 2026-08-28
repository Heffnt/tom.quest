"use client";

// DTS Sessions — a chat surface over headless Claude Code sessions running on
// the worker box. Convex is the stream: the daemon persists transcript rows,
// this page subscribes. Phone-first: the list is the default view; opening a
// session takes over the viewport with back-navigation (?session=<id>
// deep-links, forge-style read-on-mount + router.replace on open/close).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import SessionList from "./components/session-list";
import SessionView from "./components/session-view";
import { DAEMON_STALE_MS, ageText } from "./lib";

// Shape of a Convex document id as it appears in a deep link. A malformed
// ?session= value passed straight into useQuery throws during render, so
// anything not id-shaped is treated as absent (the list view shows instead).
const SESSION_ID_SHAPE = /^[a-z0-9]{20,40}$/;

export default function SessionsClient() {
  // isTom still gates the queries ("skip" idiom); TomGate owns the gate JSX.
  const { isTom } = useAuth();
  const router = useRouter();
  const sessions = useQuery(api.claudeSessions.listSessions, isTom ? {} : "skip");
  const health = useQuery(api.claudeSessions.getDaemonHealth, isTom ? {} : "skip");

  const [activeId, setActiveId] = useState<Id<"claudeSessions"> | null>(null);

  // Staleness is derived at render; a 15s tick keeps ages honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Read ?session=<id> once on mount (GETs never change state).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("session");
    if (id && SESSION_ID_SHAPE.test(id)) {
      setActiveId(id as Id<"claudeSessions">);
    }
  }, []);

  const openSession = (id: Id<"claudeSessions">) => {
    setActiveId(id);
    router.replace(`/sessions?session=${id}`, { scroll: false });
  };

  const closeSession = () => {
    setActiveId(null);
    router.replace("/sessions", { scroll: false });
  };

  // health: undefined = query loading; null = the worker has never reported.
  const daemonStale =
    health !== undefined &&
    (health === null || now - health.lastSeenAt > DAEMON_STALE_MS);

  const lastIngestError = health?.lastIngestError;

  const banner =
    daemonStale || lastIngestError !== undefined ? (
      <div className="border-b border-border bg-surface-alt/50 px-3 sm:px-4 py-2 text-xs space-y-0.5">
        {daemonStale && (
          <div className="text-text-muted">
            {health
              ? `worker last heard from ${ageText(health.lastSeenAt, now)} (reports at least every 30s)`
              : "worker has not reported yet"}
          </div>
        )}
        {lastIngestError !== undefined && (
          <div className="text-text-faint">
            last rejected write:{" "}
            {lastIngestError.length > 200
              ? `${lastIngestError.slice(0, 200)}…`
              : lastIngestError}
          </div>
        )}
      </div>
    ) : null;

  const body = activeId ? (
    <div className="h-[calc(100dvh-4rem)] flex flex-col max-w-3xl mx-auto w-full">
      {banner}
      <SessionView
        sessionId={activeId}
        now={now}
        daemonStale={daemonStale}
        daemonLastSeenAt={health?.lastSeenAt}
        onBack={closeSession}
      />
    </div>
  ) : (
    <div className="max-w-3xl mx-auto w-full">
      {banner}
      <div className="px-3 sm:px-4 py-6 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
          <p className="text-text-muted text-sm mt-1">
            Claude Code sessions on the worker box — create one, watch its
            transcript, answer its permission requests.
          </p>
        </header>
        <SessionList sessions={sessions} now={now} onOpen={openSession} />
      </div>
    </div>
  );

  return <TomGate label="Sessions">{body}</TomGate>;
}
