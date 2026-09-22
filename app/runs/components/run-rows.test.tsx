// THE ROWS OF ONE RUN — the subagent fold, and the two meanings of
// parentToolUseId.
//
// The panel that used to sit beside the transcript is gone (the lifeos update,
// phase 7). Three of the things it showed about a RUNNING subagent are not
// rows in the transcript and never were — that it is still going, how long it
// has been going, and the tool call it is inside right now — so if the fold
// did not carry them they would simply be gone from the page, while the
// retirement ledger claimed every fact had moved into the transcript. They
// come from the query the panel itself read (claudeSessions.getOpenToolWork),
// which walks the session's newest tool calls rather than the transcript's
// loaded window: that is why a fold whose Task row has been paged out still
// says who the subagent is, instead of showing a bare tool-use id. Those four
// witnesses were written against the transcript pane; the pane is now RunRows
// fed by useRunRows, so they are driven here with `rows` as a prop and they
// must survive the move unchanged.
//
// The fifth is the reason this file exists at all. The window RunRows groups
// now holds rows from two writers, and `parentToolUseId` does not mean the
// same thing in both. On a daemon row it means "this row belongs to that
// subagent's output"; on a file-derived row it means "this row answers that
// tool call" — worker/runs/ingest.mjs stamps it on EVERY tool-result and
// child-run row. Fold on the field alone and every tool result in a run file
// becomes a one-row fold of its own, which is a silent failure: the page still
// renders, it just buries the run. `provenance === undefined` is the test that
// separates them, and nothing but a rendered case can hold it.
//
// The sixth is the paging control, which is a direction claim: the session
// query pages newest-first and the run query oldest-first, so the same button
// loads EARLIER rows on one and LATER rows on the other. A label that stopped
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

import RunRows from "./run-rows";

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

/** The three live queries RunRows reads beside its rows. */
function load(openWork?: unknown) {
  convex.data = {
    [getFunctionName(api.claudeSessions.getStreamBuf)]: null,
    [getFunctionName(api.claudeSessions.getPendingInbound)]: [],
    [getFunctionName(api.claudeSessions.getOpenToolWork)]: openWork,
  };
}

const body = () => document.body.textContent ?? "";

/** Rows arrive ASCENDING as a prop — the paging hook lives in <Run/>. */
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
    <RunRows
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

const OPEN = {
  agents: [
    {
      toolUseId: "task-1",
      subagentType: "explorer",
      description: "find the readiness home",
      startedAt: NOW - 5 * 60_000,
      running: true,
      current: { toolName: "Grep", inputPreview: "isReadyForTom" },
    },
  ],
  commands: [],
  finished: [],
};

beforeEach(() => {
  convex.data = {};
  convex.seen = [];
  cleanup();
});

describe("the subagent fold", () => {
  it("says a subagent is running, for how long, and the call it is inside", () => {
    load(OPEN);
    show([TASK_ROW, CHILD_ROW]);
    expect(body()).toContain("agent");
    expect(body()).toContain("explorer");
    expect(body()).toContain("find the readiness home");
    // The three facts that are not rows.
    expect(body()).toContain("running 5m");
    expect(body()).toContain("now: Grep isReadyForTom");
  });

  // witness: read the label off the loaded window alone. A long session pages
  // its Task row out of the window while the subagent is still working, and
  // the fold then reads "agent task-1" — the id, for the one agent whose
  // progress Tom is actually watching.
  it("names a subagent whose Task row has been paged out", () => {
    load(OPEN);
    show([CHILD_ROW]);
    expect(body()).toContain("explorer");
    expect(body()).toContain("find the readiness home");
    expect(body()).not.toContain("agent task-1");
  });

  it("claims nothing about a subagent that has returned", () => {
    load({ agents: [], commands: [], finished: [] });
    show([TASK_ROW, CHILD_ROW]);
    expect(body()).toContain("explorer");
    // No elapsed on the fold and no "now:" line — its outcome is its result
    // row. ("Task running" below the rows is the live tail's own claim about
    // the main thread's unanswered call, which is a different fact.)
    expect(body()).not.toContain("running 5m");
    expect(body()).not.toContain("now: Grep");
  });

  it("asks for no open work once the session is over", () => {
    load(OPEN);
    show([TASK_ROW, CHILD_ROW], { sessionStatus: "ended" });
    // The query is skipped on a terminal session, so the live half is absent
    // even though the fixture would have answered it.
    expect(convex.seen).toContain("claudeSessions:getOpenToolWork:skip");
    expect(body()).not.toContain("running 5m");
    expect(body()).toContain("explorer");
  });

  // THE PREDICATE IS `provenance === undefined`, NOT `parentToolUseId`.
  //
  // The two writers of a row mean different things by the same field. On a
  // daemon row parentToolUseId says "this row is part of that subagent's
  // output" — the set the fold was written for. On a file-derived row
  // worker/runs/ingest.mjs stamps it on every tool-result and every child-run
  // row to say "this row answers that tool call". Folding on the field alone
  // would therefore wrap every single tool result in a one-row agent fold, and
  // a window holding both writers' rows — which is exactly what a session that
  // has cut over to its run file holds — would read as a wall of folds with
  // the main thread hidden inside them. Nothing else in the file distinguishes
  // the two, so the case builds one row of each, same parentToolUseId, and
  // looks for the <details>.
  it("folds a daemon row on parentToolUseId and leaves a file-derived one alone", () => {
    load({ agents: [], commands: [], finished: [] });
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
    load({ agents: [], commands: [], finished: [] });
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
