"use client";

// The sessions page (design section 5.1): every session in the record's
// sessions table on the left, the open session's transcript in the center,
// and the agents its run started on the right. A background agent pressed on
// the right replaces the center with its transcript until Close.
//
// THE URL IS THE PAGE'S STATE, as on /agents: ?session=<id> is the open
// session and &agent=<runId> the background agent open in its place, so a
// link and Back move one thing.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/app/lib/auth";
import TomGate from "@/app/components/tom-gate";
import Agent from "@/app/agents/components/agent";
import { DAEMON_STALE_MS, type TranscriptMessage } from "@/app/agents/lib";
import SideColumn from "./components/side-column";
import SessionList from "./components/session-list";
import BackgroundColumn from "./components/background-column";
import ContextPanel from "./components/context-panel";
import LoginSelect from "./components/login-select";
import { LEFT_WIDTH, RIGHT_WIDTH, useSessionsLayout } from "./store";

// The agent id grammar convex/agents.ts enforces: agents.get throws on any
// other string, so anything else reads as absent. The session id needs no
// shape test: sessionByLink answers null for a string that is not one.
const RUN_ID_SHAPE =
  /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;

function readLink(sp: URLSearchParams): {
  sessionId?: string;
  agentId?: string;
} {
  const session = sp.get("session");
  const agent = sp.get("agent");
  return {
    sessionId: session === null || session === "" ? undefined : session,
    agentId: agent && RUN_ID_SHAPE.test(agent) ? agent : undefined,
  };
}

function linkTo(sessionId?: string, agentId?: string): string {
  const params = new URLSearchParams();
  if (sessionId !== undefined) params.set("session", sessionId);
  if (agentId !== undefined) params.set("agent", agentId);
  const qs = params.toString();
  return qs === "" ? "/sessions" : `/sessions?${qs}`;
}

const renderContext = ({
  run,
  rows,
}: {
  run: Doc<"runs"> | null | undefined;
  rows: TranscriptMessage[];
}) => <ContextPanel run={run} rows={rows} />;

export default function SessionsClient() {
  const { isTom } = useAuth();
  const router = useRouter();
  const search = useSearchParams().toString();
  const { sessionId, agentId } = useMemo(() => readLink(new URLSearchParams(search)), [search]);

  const list = useQuery(api.claudeSessions.sessionsPage, isTom ? {} : "skip");
  const health = useQuery(api.claudeSessions.getDaemonHealth, isTom ? {} : "skip");
  const session = useQuery(
    api.claudeSessions.sessionByLink,
    isTom && sessionId !== undefined ? { id: sessionId } : "skip",
  );
  const layout = useSessionsLayout();

  // Ages are derived at render; a 15 s tick keeps them honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const go = useCallback(
    (nextSession?: string, nextAgent?: string) =>
      router.replace(linkTo(nextSession, nextAgent), { scroll: false }),
    [router],
  );
  const openSession = useCallback((id: Id<"claudeSessions">) => go(id), [go]);
  const openRun = useCallback((runId: string) => go(sessionId, runId), [go, sessionId]);
  const closeRun = useCallback(() => go(sessionId), [go, sessionId]);

  // health: undefined = loading; null = the session host has never reported.
  const daemonStale =
    health !== undefined && (health === null || now - health.lastSeenAt > DAEMON_STALE_MS);
  const boxLogin = health?.activeAccount;

  const center =
    agentId !== undefined ? (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="border-b border-border px-3 py-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={closeRun}
            className="rounded px-2.5 py-1 text-xs border border-border text-text-muted hover:bg-surface-alt hover:text-text"
          >
            Close
          </button>
        </div>
        <Agent
          key={agentId}
          runId={agentId}
          depth={0}
          now={now}
          onOpenRun={openRun}
          onOpenSession={openSession}
          renderTop={renderContext}
          fullWidth
        />
      </div>
    ) : session !== undefined && session !== null ? (
      <Agent
        key={session._id}
        sessionId={session._id}
        depth={0}
        now={now}
        daemonStale={daemonStale}
        daemonLastSeenAt={health?.lastSeenAt}
        lastIngestError={health?.lastIngestError}
        onOpenRun={openRun}
        onOpenSession={openSession}
        renderTop={renderContext}
        fullWidth
        controlsInComposer
        extraControls={<LoginSelect session={session} boxLogin={boxLogin} />}
      />
    ) : (
      <div className="flex-1 flex items-center justify-center text-sm text-text-faint">
        {sessionId !== undefined && session === undefined
          ? "loading session…"
          : sessionId !== undefined
            ? "this record does not hold that session"
            : "no session open"}
      </div>
    );

  return (
    <TomGate label="Sessions">
      <div className="h-[calc(100dvh-4rem)] w-full flex min-h-0">
        <SideColumn
          side="left"
          title="Sessions"
          open={layout.leftOpen}
          width={layout.leftWidth}
          min={LEFT_WIDTH.min}
          max={LEFT_WIDTH.max}
          onToggle={layout.toggleLeft}
          onResize={layout.setLeftWidth}
        >
          <SessionList
            persistent={list?.persistent}
            others={list?.others}
            selectedId={session?._id}
            now={now}
            boxLogin={boxLogin}
            onOpen={openSession}
          />
        </SideColumn>
        <main className="flex-1 min-w-0 min-h-0 flex flex-col">{center}</main>
        <SideColumn
          side="right"
          title="Background"
          open={layout.rightOpen}
          width={layout.rightWidth}
          min={RIGHT_WIDTH.min}
          max={RIGHT_WIDTH.max}
          onToggle={layout.toggleRight}
          onResize={layout.setRightWidth}
        >
          <BackgroundColumn
            runId={session?.runId}
            selectedRunId={agentId}
            now={now}
            onOpenRun={openRun}
          />
        </SideColumn>
      </div>
    </TomGate>
  );
}
