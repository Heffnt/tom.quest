// THE ROWS OF ONE RUN — the subagent fold, the two meanings of
// parentToolUseId, and what the page shows beside the rows.
//
// The fold's live half is gone (one transcript path, 2026-09-25). It came from
// claudeSessions.getOpenToolWork, which read the daemon's rows as they were
// written during a turn; a session's rows are now its agent file's and land at
// the turn's end, so "this subagent is running, and this is the call it is
// inside" had nothing left to be read from. The fold says who the subagent is,
// what it was sent to do and how many rows it produced, and nothing else.
//
// The window AgentRows groups can hold rows from two writers, and
// `parentToolUseId` does not mean the same thing in both. On a daemon row it
// means "this row belongs to that subagent's output"; on a file-derived row it
// means "this row answers that tool call" — worker/agents/ingest.mjs stamps
// it on EVERY tool-result and child-run row. Fold on the field alone and every
// tool result in a run file becomes a one-row fold of its own, which is a
// silent failure: the page still renders, it just buries the run.
// `provenance === undefined` is the test that separates them, and nothing but
// a rendered case can hold it.
//
// Beside the rows: Tom's delivered turn stays on the page until its row lands
// (getPendingInbound returns it), and the daemon's notes are drawn between the
// rows by time (sessionRows.notes).
//
// The paging control is a direction claim: the session query pages
// newest-first and the run query oldest-first, so the same button loads
// EARLIER rows on one and LATER rows on the other. A label that stopped
// tracking `source` would be a lie no type checker can see.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { TranscriptMessage } from "../lib";

// The Convex stand-in. `seen` records every call as "<fn>:<args>", because one
// of the witnesses below is about a query that must NOT be asked.
const convex = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  seen: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) => {
      const fn = name(ref as never);
      convex.seen.push(
        `${fn}:${args === "skip" ? "skip" : JSON.stringify(args)}`,
      );
      return args === "skip" ? undefined : convex.data[fn];
    },
    usePaginatedQuery: (ref: unknown) => ({
      results: (convex.data[name(ref as never)] as unknown[]) ?? [],
      status: "Exhausted" as const,
      loadMore: () => {},
    }),
    useMutation: () => async () => {},
  };
});

import AgentRows from "./agent-rows";

const NOW = Date.now();
const SESSION_ID = "s1" as unknown as Id<"claudeSessions">;

/** One finalized row, in the shape the row readers return. */
function row(over: Record<string, unknown>): TranscriptMessage {
  return {
    _id: "m1",
    _creationTime: 0,
    sessionId: "s1",
    seq: 1,
    kind: "assistant-text",
    content: "hello",
    createdAt: NOW,
    ...over,
  } as unknown as TranscriptMessage;
}

/** A file-derived row's provenance stamp — the field the fold predicate reads. */
const PROVENANCE = {
  file: "/srv/runs/fixture.jsonl",
  fileVersion: "f".repeat(64),
  lineStart: 12,
  lineEnd: 12,
  block: 0,
  parserVersion: "claude/1",
  sourceKind: "user",
};

/** The live queries AgentRows reads beside its rows. */
function load(over: { pending?: unknown[]; notes?: unknown[]; buf?: unknown } = {}) {
  convex.data = {
    [getFunctionName(api.claudeSessions.getStreamBuf)]: over.buf ?? null,
    [getFunctionName(api.claudeSessions.getPendingInbound)]: over.pending ?? [],
    [getFunctionName(api.sessionRows.notes)]: over.notes ?? [],
  };
}

const body = () => document.body.textContent ?? "";

/** Rows arrive ASCENDING as a prop — the paging hook lives in <Agent/>. */
function show(
  rows: TranscriptMessage[],
  over: {
    pageStatus?: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    source?: "session" | "run";
    sessionId?: Id<"claudeSessions">;
    sessionStatus?: string;
  } = {},
) {
  return render(
    <AgentRows
      rows={rows}
      pageStatus={over.pageStatus ?? "Exhausted"}
      loadMore={() => {}}
      source={over.source ?? "session"}
      depth={0}
      runKey="r1"
      sessionId={"sessionId" in over ? over.sessionId : SESSION_ID}
      sessionStatus={over.sessionStatus ?? "running"}
    />,
  );
}

/** The Task call that spawned the subagent, as the daemon writes it. */
const TASK_ROW = row({
  _id: "m-task",
  seq: 1,
  kind: "tool-call",
  content: {
    toolName: "Task",
    toolUseId: "task-1",
    input: { subagent_type: "explorer", description: "find the readiness home" },
  },
});

/** One row the subagent produced, which is what the fold holds. */
const CHILD_ROW = row({
  _id: "m-child",
  seq: 2,
  parentToolUseId: "task-1",
  kind: "assistant-text",
  content: "reading convex/ttsShared.ts",
});

beforeEach(() => {
  convex.data = {};
  convex.seen = [];
  cleanup();
});

describe("the subagent fold", () => {
  it("names the subagent and its errand from its Task row, and claims nothing live", () => {
    load();
    show([TASK_ROW, CHILD_ROW]);
    expect(body()).toContain("agent");
    expect(body()).toContain("explorer");
    expect(body()).toContain("find the readiness home");
    expect(body()).toContain("1 rows");
    expect(body()).not.toContain("now:");
    expect(convex.seen.some((call) => call.startsWith("claudeSessions:getOpenToolWork"))).toBe(false);
  });

  it("keeps the bare id for a subagent whose Task row has been paged out", () => {
    load();
    show([CHILD_ROW]);
    expect(body()).toContain("agent task-1");
  });

  // THE PREDICATE IS `provenance === undefined`, NOT `parentToolUseId`.
  //
  // The two writers of a row mean different things by the same field. On a
  // daemon row parentToolUseId says "this row is part of that subagent's
  // output" — the set the fold was written for. On a file-derived row
  // worker/agents/ingest.mjs stamps it on every tool-result and every child-run
  // row to say "this row answers that tool call". Folding on the field alone
  // would therefore wrap every single tool result in a one-row agent fold, and
  // a window holding both writers' rows — which is exactly what a session that
  // has cut over to its run file holds — would read as a wall of folds with
  // the main thread hidden inside them. Nothing else in the file distinguishes
  // the two, so the case builds one row of each, same parentToolUseId, and
  // looks for the <details>.
  it("folds a daemon row on parentToolUseId and leaves a file-derived one alone", () => {
    load();
    const daemonResult = row({
      _id: "m-daemon-result",
      seq: 3,
      kind: "tool-result",
      parentToolUseId: "task-1",
      content: {
        toolUseId: "toolu-daemon",
        content: "daemon result, inside the subagent's output",
        isError: false,
      },
    });
    const fileResult = row({
      _id: "m-file-result",
      seq: 4,
      kind: "tool-result",
      parentToolUseId: "task-1",
      provenance: PROVENANCE,
      content: {
        toolUseId: "toolu-file",
        content: "file-derived result, answering its own call",
        isError: false,
      },
    });
    show([daemonResult, fileResult]);

    // Nothing is opened: a closed <details> still holds its body in the DOM,
    // and the question here is which side of the fold a row is on, not whether
    // the reader can see it. (run.test.tsx opens folds, and says there why
    // clicking a <summary> is not how it is done in this jsdom.)
    const daemonLine = screen.getByText(
      "daemon result, inside the subagent's output",
    );
    const fileLine = screen.getByText(
      "file-derived result, answering its own call",
    );
    expect(daemonLine.closest("details")).not.toBeNull();
    expect(fileLine.closest("details")).toBeNull();
  });
});

describe("the paging control", () => {
  // "load more" means the opposite thing on each side: getMessages pages
  // newest-first so more rows are EARLIER ones, runs.rows pages oldest-first so
  // more rows are LATER ones. The label is the only place the reader is told.
  it("loads earlier rows on a session and later rows on a run", () => {
    load();
    const { unmount } = show([TASK_ROW], {
      pageStatus: "CanLoadMore",
      source: "session",
    });
    expect(screen.getByText("load earlier rows")).toBeTruthy();
    expect(screen.queryByText("load later rows")).toBeNull();
    unmount();

    show([TASK_ROW], {
      pageStatus: "CanLoadMore",
      source: "run",
      sessionId: undefined,
    });
    expect(screen.getByText("load later rows")).toBeTruthy();
    expect(screen.queryByText("load earlier rows")).toBeNull();
  });
});

describe("beside the rows", () => {
  // witness: show pending rows only and Tom's words vanish from the page the
  // moment the daemon delivers them, for the whole turn the agent spends on
  // them — the agent file's row for the turn lands only when the turn ends.
  it("keeps Tom's delivered turn on the page, above the reply being typed", () => {
    load({
      pending: [
        { _id: "in-1", kind: "user-turn", text: "do the visa one first", status: "delivered", author: "tom" },
        { _id: "in-2", kind: "user-turn", text: "and then the lease", status: "pending", author: "tom" },
      ],
      buf: { text: "Starting on the visa." },
    });
    show([TASK_ROW]);
    const text = body();
    expect(text).toContain("do the visa one first");
    expect(text).toContain("delivered");
    expect(text).toContain("and then the lease");
    expect(text).toContain("queued — delivers when the current turn ends");
    expect(text.indexOf("do the visa one first")).toBeLessThan(text.indexOf("Starting on the visa."));
    expect(text.indexOf("Starting on the visa.")).toBeLessThan(text.indexOf("and then the lease"));
  });

  // witness: render the notes as a block after the rows and a model change
  // made before a turn reads as if it happened after it.
  it("draws each note between the rows it happened between", () => {
    const first = row({ _id: "m-a", seq: 1, content: "first answer", createdAt: NOW });
    const second = row({ _id: "m-b", seq: 2, content: "second answer", createdAt: NOW + 2_000 });
    load({
      notes: [
        { _id: "n-0", at: NOW - 5_000, text: "workspace rebuilt" },
        { _id: "n-1", at: NOW + 1_000, text: "model changed to sonnet" },
        { _id: "n-2", at: NOW + 3_000, text: "pushed 2 commits" },
      ],
    });
    const { unmount } = show([first, second], { pageStatus: "CanLoadMore" });
    let text = body();
    expect(text.indexOf("first answer")).toBeLessThan(text.indexOf("model changed to sonnet"));
    expect(text.indexOf("model changed to sonnet")).toBeLessThan(text.indexOf("second answer"));
    expect(text.indexOf("second answer")).toBeLessThan(text.indexOf("pushed 2 commits"));
    // Older than every loaded row, with earlier rows still to load: an
    // earlier row may belong in front of it, so it waits.
    expect(text).not.toContain("workspace rebuilt");
    unmount();

    show([first, second], { pageStatus: "Exhausted" });
    text = body();
    expect(text.indexOf("workspace rebuilt")).toBeLessThan(text.indexOf("first answer"));
  });
});
