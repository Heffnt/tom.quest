// THE SUBAGENT FOLD, and the facts it inherited from the agent panel.
//
// The panel that used to sit beside the transcript is gone (the lifeos update,
// phase 7). Three of the things it showed about a RUNNING subagent are not
// rows in the transcript and never were — that it is still going, how long it
// has been going, and the tool call it is inside right now — so if the fold
// did not carry them they would simply be gone from the page, while the
// retirement ledger claimed every fact had moved into the transcript.
//
// They come from the query the panel itself read
// (claudeSessions.getOpenToolWork), which walks the session's newest tool
// calls rather than the transcript's loaded window. That is the second thing
// checked here: a fold whose Task row has been paged out still says who the
// subagent is and what it was sent to do, instead of showing a bare tool-use
// id.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { api } from "@/convex/_generated/api";

const convex = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  return {
    useQuery: (ref: unknown, args: unknown) =>
      args === "skip" ? undefined : convex.data[name(ref as never)],
    usePaginatedQuery: (ref: unknown) => ({
      results: (convex.data[name(ref as never)] as unknown[]) ?? [],
      status: "Exhausted",
      loadMore: () => {},
    }),
  };
});

import Transcript from "./transcript";

const NOW = Date.now();
const SESSION_ID = "s1" as never;

/** One finalized row, in the shape claudeSessions.getMessages returns. */
function row(over: Record<string, unknown>) {
  return {
    _id: "m1",
    _creationTime: 0,
    sessionId: "s1",
    seq: 1,
    kind: "assistant-text",
    content: "hello",
    createdAt: NOW,
    ...over,
  };
}

/** The transcript reads its page newest-first and reverses it for display. */
function load(rows: unknown[], openWork?: unknown) {
  convex.data = {
    [getFunctionName(api.claudeSessions.getMessages)]: [...rows].reverse(),
    [getFunctionName(api.claudeSessions.getStreamBuf)]: null,
    [getFunctionName(api.claudeSessions.getPendingInbound)]: [],
    [getFunctionName(api.claudeSessions.getOpenToolWork)]: openWork,
  };
}

const body = () => document.body.textContent ?? "";

const show = (status = "running") =>
  render(<Transcript sessionId={SESSION_ID} sessionStatus={status} />);

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
  cleanup();
});

describe("the subagent fold", () => {
  it("says a subagent is running, for how long, and the call it is inside", () => {
    load([TASK_ROW, CHILD_ROW], OPEN);
    show();
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
    load([CHILD_ROW], OPEN);
    show();
    expect(body()).toContain("explorer");
    expect(body()).toContain("find the readiness home");
    expect(body()).not.toContain("agent task-1");
  });

  it("claims nothing about a subagent that has returned", () => {
    load([TASK_ROW, CHILD_ROW], { agents: [], commands: [], finished: [] });
    show();
    expect(body()).toContain("explorer");
    // No elapsed on the fold and no "now:" line — its outcome is its result
    // row. ("Task running" below the rows is the live tail's own claim about
    // the main thread's unanswered call, which is a different fact.)
    expect(body()).not.toContain("running 5m");
    expect(body()).not.toContain("now: Grep");
  });

  it("asks for no open work once the session is over", () => {
    load([TASK_ROW, CHILD_ROW], OPEN);
    show("ended");
    // The query is skipped on a terminal session, so the live half is absent
    // even though the fixture would have answered it.
    expect(body()).not.toContain("running 5m");
    expect(body()).toContain("explorer");
  });
});
