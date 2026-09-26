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
//
// TWO VIEWS OF ONE PAGE (2026-09-26, when /agents absorbed /observe): the
// agents list (what is running, each agent's chat) and the window view
// (window/window-view.tsx: everything that ran in a stretch of time, the map,
// the timeline, the rulings and the changes). ?view=window opens the second;
// /observe redirects there.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import AgentList from "./components/agent-list";
import Agent from "./components/agent";
import WindowView from "./window/window-view";
import { DAEMON_STALE_MS } from "./lib";

type Target =
  | { kind: "session"; sessionId: Id<"claudeSessions"> }
  | { kind: "run"; runId: string }
  | null;

type View = "agents" | "window";

// Shape of a Convex document id as it appears in a deep link. A malformed
// ?session= value passed straight into useQuery throws during render, so
// anything not id-shaped is treated as absent (the list view shows instead).
const SESSION_ID_SHAPE = /^[a-z0-9]{20,40}$/;
// The agent id grammar convex/agents.ts enforces on every write. Checked here
// for the same reason: agents.get throws on a malformed one.
const RUN_ID_SHAPE =
  /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;

/** What the query string opens: the view, and the agent when it names one. */
function readDeepLink(sp: URLSearchParams): { view: View; target: Target } {
  const view: View = sp.get("view") === "window" ? "window" : "agents";
  const runId = sp.get("agent") ?? sp.get("run");
  if (runId && RUN_ID_SHAPE.test(runId)) return { view, target: { kind: "run", runId } };
  const id = sp.get("session");
  if (id && SESSION_ID_SHAPE.test(id)) {
    return { view, target: { kind: "session", sessionId: id as Id<"claudeSessions"> } };
  }
  return { view, target: null };
}

export default function AgentsClient() {
  // isTom still gates the queries ("skip" idiom); TomGate owns the gate JSX.
  const { isTom } = useAuth();
  const router = useRouter();
  const sessions = useQuery(api.claudeSessions.listSessions, isTom ? {} : "skip");
  const health = useQuery(api.claudeSessions.getDaemonHealth, isTom ? {} : "skip");


  // Staleness is derived at render; a 15s tick keeps ages honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // THE URL IS THE PAGE'S STATE: the view and the open agent are read from
  // the query string on every render and changed only by changing it, so a
  // link (the window view's included) and Back move one thing, never two.
  const search = useSearchParams().toString();
  const { view, target } = useMemo(() => readDeepLink(new URLSearchParams(search)), [search]);
  const viewParam = view === "window" ? "view=window&" : "";

  const openSession = (sessionId: Id<"claudeSessions">) => {
    router.replace(`/agents?${viewParam}session=${sessionId}`, { scroll: false });
  };

  const openRun = (runId: string) => {
    router.replace(`/agents?${viewParam}agent=${encodeURIComponent(runId)}`, {
      scroll: false,
    });
  };

  const close = () => {
    router.replace(view === "window" ? "/agents?view=window" : "/agents", { scroll: false });
  };

  const selectView = (next: View) => {
    router.replace(next === "window" ? "/agents?view=window" : "/agents", { scroll: false });
  };

  const header = (
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-2xl font-bold tracking-tight">Agents</h1>
      <div className="flex items-center gap-1 rounded-md border border-border bg-surface/40 p-0.5">
        {(["agents", "window"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => selectView(option)}
            className={`rounded px-2 py-0.5 text-[11px] ${
              view === option ? "bg-accent-dim text-accent" : "text-text-muted hover:bg-surface-alt hover:text-text"
            }`}
          >
            {option === "agents" ? "now" : "by window"}
          </button>
        ))}
      </div>
    </header>
  );

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
  ) : view === "window" ? (
    <div className="w-full px-3 py-5 sm:px-5 space-y-3">
      {header}
      <WindowView />
    </div>
  ) : (
    <div className="max-w-3xl mx-auto w-full">
      <div className="px-3 sm:px-4 py-6 space-y-4">
        {header}
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
