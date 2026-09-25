"use client";

// The agents surface. Convex is the stream: the daemon and the agent-file
// sweep persist rows, this page subscribes. Phone-first — the list is the
// default view and opening an agent takes over the viewport with
// back-navigation.
//
// TWO DEEP LINKS, because the record holds two identities. ?session=<id> is the
// live session row (every link from TTS points here, and most sessions predate
// the record). ?agent=<agentId> is the record's own id for the agent — encoded,
// because an agent id holds colons and a slash. Both open the same component.
// ?run=<agentId> is read as ?agent= is, because Slack messages and record rows
// written before the rename hold that spelling.
//
// The daemon banner that used to sit above the rows is gone: its two facts are
// suffixes on the run's one header line, while they are true (§4).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import AgentList from "./components/agent-list";
import Agent from "./components/agent";
import { DAEMON_STALE_MS } from "./lib";

// Shape of a Convex document id as it appears in a deep link. A malformed
// ?session= value passed straight into useQuery throws during render, so
// anything not id-shaped is treated as absent (the list view shows instead).
const SESSION_ID_SHAPE = /^[a-z0-9]{20,40}$/;
// The agent id grammar convex/agents.ts enforces on every write. Checked here
// for the same reason: agents.get throws on a malformed one.
const RUN_ID_SHAPE =
  /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;

type Target =
  | { kind: "session"; sessionId: Id<"claudeSessions"> }
  | { kind: "run"; runId: string }
  | null;

export default function AgentsClient() {
  // isTom still gates the queries ("skip" idiom); TomGate owns the gate JSX.
  const { isTom } = useAuth();
  const router = useRouter();
  const sessions = useQuery(api.claudeSessions.listSessions, isTom ? {} : "skip");
  const health = useQuery(api.claudeSessions.getDaemonHealth, isTom ? {} : "skip");

  const [target, setTarget] = useState<Target>(null);

  // Staleness is derived at render; a 15s tick keeps ages honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Read the deep link once on mount (GETs never change state).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const runId = sp.get("agent") ?? sp.get("run");
    if (runId && RUN_ID_SHAPE.test(runId)) {
      setTarget({ kind: "run", runId });
      return;
    }
    const id = sp.get("session");
    if (id && SESSION_ID_SHAPE.test(id)) {
      setTarget({ kind: "session", sessionId: id as Id<"claudeSessions"> });
    }
  }, []);

  const openSession = (sessionId: Id<"claudeSessions">) => {
    setTarget({ kind: "session", sessionId });
    router.replace(`/agents?session=${sessionId}`, { scroll: false });
  };

  const openRun = (runId: string) => {
    setTarget({ kind: "run", runId });
    router.replace(`/agents?agent=${encodeURIComponent(runId)}`, {
      scroll: false,
    });
  };

  const close = () => {
    setTarget(null);
    router.replace("/agents", { scroll: false });
  };

  // health: undefined = query loading; null = the worker has never reported.
  const daemonStale =
    health !== undefined &&
    (health === null || now - health.lastSeenAt > DAEMON_STALE_MS);

  const body = target ? (
    // Full window width (Tom's ruling): the rows are the work surface and get
    // no column cap.
    <div className="h-[calc(100dvh-4rem)] flex flex-col w-full">
      <Agent
        key={target.kind === "run" ? target.runId : target.sessionId}
        runId={target.kind === "run" ? target.runId : undefined}
        sessionId={target.kind === "session" ? target.sessionId : undefined}
        depth={0}
        now={now}
        daemonStale={daemonStale}
        daemonLastSeenAt={health?.lastSeenAt}
        lastIngestError={health?.lastIngestError}
        onBack={close}
        onOpenRun={openRun}
        onOpenSession={openSession}
      />
    </div>
  ) : (
    <div className="max-w-3xl mx-auto w-full">
      <div className="px-3 sm:px-4 py-6 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
        </header>
        <AgentList
          sessions={sessions}
          now={now}
          onOpenSession={openSession}
          onOpenRun={openRun}
        />
      </div>
    </div>
  );

  return <TomGate label="Agents">{body}</TomGate>;
}
