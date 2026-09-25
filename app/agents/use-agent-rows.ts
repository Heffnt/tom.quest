"use client";

// THE ONE ROW READER (§23.6). A run's rows come from one of two queries and the
// page must not know which: a run that carries a session reads
// claudeSessions.getMessages, which holds the session's switch (the agent
// file's rows by runId once session.rowsFrom is "runs", the daemon's old rows
// by sessionId before it — convex/sessionRows.ts rowSource); every other run
// reads agents.rows.
//
// The two page in OPPOSITE directions and both are right. getMessages pages
// newest-first, which is the only way a two-thousand-row session opens at its
// tail — where the reader left it. runs.rows pages oldest-first, because a run
// with no session is opened to find out what it did, from the beginning. This
// hook reverses the session branch so its caller only ever sees ascending rows,
// and says which side it took, because two behaviours genuinely differ on that:
// scroll compensation when a page lands, and auto-scroll on arrival.

import { useMemo } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { TranscriptMessage } from "./lib";

/**
 * Which rows to read. A session is addressed by its `claudeSessions` id even
 * when its `runs` row has not landed — most sessions predate the record — so
 * the two identities are separate fields rather than one run document.
 */
type RunSubject = {
  runId?: string;
  sessionId?: Id<"claudeSessions">;
};

type RunRowsResult = {
  /** ALWAYS ascending, oldest first, whichever query delivered them. */
  rows: TranscriptMessage[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
  /** Which query answered — "load more" means earlier on one, later on the other. */
  source: "session" | "run";
};

const NO_MORE = () => {};

export function useAgentRows(subject: RunSubject): RunRowsResult {
  const { sessionId, runId } = subject;
  // A session's rows always come from getMessages: it is the reader that holds
  // the session's switch, so reading agents.rows directly would show an old
  // session's file rows where the daemon's are the ones it has.
  const fromSession = sessionId !== undefined;

  const session = usePaginatedQuery(
    api.claudeSessions.getMessages,
    fromSession ? { sessionId } : "skip",
    { initialNumItems: 60 },
  );
  const run = usePaginatedQuery(
    api.agents.rows,
    !fromSession && runId !== undefined ? { agentId: runId } : "skip",
    { initialNumItems: 60 },
  );

  const sessionResults = session.results as TranscriptMessage[];
  const runResults = run.results as TranscriptMessage[];

  // Keyed on the results themselves: the live tail re-renders this tree several
  // times a second and the reverse must not be redone until a page lands.
  const rows = useMemo(
    () => (fromSession ? [...sessionResults].reverse() : runResults),
    [fromSession, sessionResults, runResults],
  );

  if (fromSession) {
    return {
      rows,
      status: session.status,
      loadMore: session.loadMore,
      source: "session",
    };
  }
  if (runId !== undefined) {
    return { rows, status: run.status, loadMore: run.loadMore, source: "run" };
  }
  // Neither identity: a child whose stub names no file yet. No rows, and
  // nothing in flight to wait for.
  return { rows: [], status: "Exhausted", loadMore: NO_MORE, source: "run" };
}
