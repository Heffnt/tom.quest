// THE ROWS OF ONE RUN — the paging control, and what the page shows beside
// the rows.
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

/** What worker/agents/ingest.mjs stamps on every row it parses out of a file. */
const PROVENANCE = {
  file: "/srv/runs/fixture.jsonl",
  fileVersion: "f".repeat(64),
  lineStart: 12,
  lineEnd: 12,
  block: 0,
  parserVersion: "claude/1",
  sourceKind: "user",
};

/** One finalized row, in the shape the row readers return. */
function row(over: Record<string, unknown>): TranscriptMessage {
  return {
    _id: "m1",
    _creationTime: 0,
    runId: "claude:box:s1",
    seq: 1,
    kind: "assistant-text",
    content: "hello",
    createdAt: NOW,
    provenance: PROVENANCE,
    ...over,
  } as unknown as TranscriptMessage;
}

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

/** A Task call, as the parser writes it. */
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

beforeEach(() => {
  convex.data = {};
  convex.seen = [];
  cleanup();
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

// ── Box changes (plan-root T1) ──────────────────────────────────────────────
// A change the agent made to the Jarvis Box as root is a marked row in its
// chat: right after the tool call that ran it, whose row carries the outcome,
// or among the rows by time when no loaded call ran it.
describe("the agent's box changes", () => {
  const AGENT = "claude:box:s1";
  const call = row({
    _id: "m-call",
    seq: 1,
    kind: "tool-call",
    createdAt: NOW - 2_000,
    content: { toolName: "Bash", toolUseId: "toolu-1", input: { command: "sudo apt-get install -y jq" } },
  });
  const later = row({ _id: "m-later", seq: 2, kind: "assistant-text", content: "installed", createdAt: NOW + 60_000 });
  const changes = [
    { id: "b1", at: NOW, source: "sudo", why: "ran-as-root", command: "/usr/bin/apt-get install -y jq", user: "jarvis", agentId: AGENT },
    { id: "b2", at: NOW + 30_000, source: "sudo", why: "ran-as-root", command: "read-only: cat ×2", count: 2, user: "jarvis", agentId: AGENT },
  ];

  function showWithChanges(agentId: string | undefined) {
    convex.data[getFunctionName(api.boxChanges.forAgent)] = changes;
    return render(
      <AgentRows rows={[call, later]} pageStatus="Exhausted" loadMore={() => {}} source="run" depth={0} runKey="r1" agentId={agentId} />,
    );
  }

  it("draws each change marked, after the call that ran it or by its time", () => {
    load();
    const { container } = showWithChanges(AGENT);
    const marked = [...container.querySelectorAll("[data-box-change]")].map((node) => node.getAttribute("data-box-change"));
    expect(marked).toEqual(["b1", "b2"]);
    const text = body();
    expect(text).toContain("/usr/bin/apt-get install -y jq");
    expect(text).toContain("read-only: cat ×2 (2 read-only commands)");
    // After the call, before the later row; the count by its time, before the later row too.
    expect(text.indexOf("/usr/bin/apt-get install -y jq")).toBeLessThan(text.indexOf("installed"));
    expect(text.indexOf("read-only: cat")).toBeLessThan(text.indexOf("installed"));
    expect(convex.seen).toContain(`boxChanges:forAgent:${JSON.stringify({ agentId: AGENT })}`);
  });

  it("asks for no changes when the run has no id in the record", () => {
    load();
    showWithChanges(undefined);
    expect(convex.seen).toContain("boxChanges:forAgent:skip");
  });
});
