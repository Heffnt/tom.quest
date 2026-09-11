// ONE COMPONENT DRAWS A RUN AND DRAWS ITS CHILDREN WITH ITSELF — the cases
// that hold that claim up.
//
// Tom, 2026-09-10: "there should be one way of viewing agent transcripts that
// is used by the primary agent or infinitely recursive sub agents." The whole
// of that ruling lives in one recursion — Run → RunRows → a `child-run` row →
// Run at depth + 1 — and every way it can break is silent. A tree that mounts
// its grandchildren's rows under the child, a child drawn twice (once inline
// and once in the unmatched list) or not at all, a composer offered on a
// subagent, an unbounded mount that hangs the browser on a long stub chain,
// and a nested run that reads three queries per descendant before anybody has
// opened it: not one of those is a type error, a crash, or a red page. They
// are a page that still renders and quietly says something false.
//
// So the fixture here is a real depth-3 tree, built in the shapes
// worker/runs/ingest.mjs writes, and the cases open it level by level and look
// at what each level actually drew. The last one prints the whole rendered
// tree — kind, nesting depth, compact line — because the phase's claim is
// about a SHAPE, and a shape has to be looked at rather than asserted about.

import { writeSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import { childRunOf } from "../lib";

// ── The Convex stand-in ─────────────────────────────────────────────────────
// Both hooks are ARGS-AWARE: a tree needs a different answer per runId, and
// two of the cases below are about a query that must NOT be asked, which is
// only visible in what the hooks were called with. `seen` records every call
// as "<fn>:<args json or skip>".
const convex = vi.hoisted(() => ({
  runs: {} as Record<string, unknown>,
  rows: {} as Record<string, unknown[]>,
  children: {} as Record<string, unknown[]>,
  sessions: {} as Record<string, unknown>,
  /** The newest runs.materializeStatus answer, per run. */
  requests: {} as Record<string, unknown>,
  seen: [] as string[],
  /** Every mutation the page fired, as "<fn>:<args json>". */
  mutations: [] as string[],
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: name } = await import("convex/server");
  const EMPTY: unknown[] = [];
  // claudeSessions.getMessages pages NEWEST first and useRunRows reverses it,
  // so the fixture is stored ascending and handed back descending here. The
  // flip is cached: a fresh array on every render would defeat the memo the
  // hook holds it in.
  const flipped = new WeakMap<object, unknown[]>();
  const descending = (rows: unknown[]) => {
    let out = flipped.get(rows);
    if (out === undefined) {
      out = [...rows].reverse();
      flipped.set(rows, out);
    }
    return out;
  };
  const record = (fn: string, args: unknown) => {
    convex.seen.push(
      `${fn}:${args === "skip" ? "skip" : JSON.stringify(args)}`,
    );
  };
  return {
    useQuery: (ref: unknown, args: unknown) => {
      const fn = name(ref as never);
      record(fn, args);
      if (args === "skip") return undefined;
      const a = args as { runId?: string; id?: string; sessionId?: string };
      switch (fn) {
        case "runs:get":
          return convex.runs[a.runId ?? ""] ?? null;
        case "runs:children":
          return {
            items: convex.children[a.runId ?? ""] ?? EMPTY,
            nextCursor: null,
          };
        case "runs:materializeStatus":
          return convex.requests[a.runId ?? ""] ?? null;
        case "claudeSessions:getSession":
          return convex.sessions[a.id ?? ""] ?? null;
        case "claudeSessions:getStreamBuf":
          return null;
        case "claudeSessions:getPendingInbound":
          return EMPTY;
        case "claudeSessions:getOpenToolWork":
          return { agents: [], commands: [], finished: [] };
        default:
          return undefined;
      }
    },
    usePaginatedQuery: (ref: unknown, args: unknown) => {
      const fn = name(ref as never);
      record(fn, args);
      if (args === "skip") {
        return { results: EMPTY, status: "Exhausted", loadMore: () => {} };
      }
      const a = args as { runId?: string; sessionId?: string };
      const rows = convex.rows[a.runId ?? a.sessionId ?? ""] ?? EMPTY;
      return {
        results:
          fn === "claudeSessions:getMessages" ? descending(rows) : rows,
        status: "Exhausted",
        loadMore: () => {},
      };
    },
    // Recorded, not stubbed: two of the cases below are about a mutation
    // the page fires with nothing on screen to fire it.
    useMutation: (ref: unknown) => {
      const fn = name(ref as never);
      return async (args: unknown) => {
        convex.mutations.push(`${fn}:${JSON.stringify(args)}`);
      };
    },
  };
});

import Run, { MAX_NESTING_DEPTH } from "./run";

const NOW = Date.now();
const SESSION_ID = "s1" as unknown as Id<"claudeSessions">;

const onOpenRun = vi.fn();
const onOpenSession = vi.fn();

// ── Fixture shapes ──────────────────────────────────────────────────────────

/** A `runs` document, in the shape convex/schema.ts holds. */
function runDoc(over: Record<string, unknown>) {
  return {
    _id: "runs|fixture",
    _creationTime: 0,
    runId: "run-root",
    rootRunId: "run-root",
    depth: 0,
    linkKnown: true,
    origin: "nightly-learning",
    host: "box",
    runner: "claude",
    parserVersion: "claude/1",
    kind: "worker",
    status: "ended",
    model: "opus",
    startedAt: NOW - 600_000,
    lastLineAt: NOW,
    attachments: [],
    file: {
      path: "/srv/runs/fixture.jsonl",
      sourceHash: "a".repeat(64),
      storedHash: "b".repeat(64),
      bytes: 4096,
      storedBytes: 4096,
      committedLine: 12,
      committedPrefixSha256: "c".repeat(64),
    },
    ingestedAt: NOW,
    ...over,
  };
}

/**
 * One row as runs.rows returns it. Every row a run file produces carries a
 * provenance stamp — which is also what keeps a `child-run` row's
 * parentToolUseId from folding it into an agent group (run-rows.tsx note 2).
 */
function fileRow(over: Record<string, unknown>) {
  return {
    _id: "m-fixture",
    _creationTime: 0,
    runId: "run-root",
    seq: 1000,
    turn: 1,
    kind: "assistant-text",
    content: { text: "" },
    depth: 0,
    createdAt: NOW - 300_000,
    provenance: {
      file: "/srv/runs/fixture.jsonl",
      fileVersion: "f".repeat(64),
      lineStart: 1,
      lineEnd: 1,
      block: 0,
      parserVersion: "claude/1",
      sourceKind: "assistant",
    },
    ...over,
  };
}

const bash = (id: string, command: string) => ({
  kind: "tool-call",
  content: { id, name: "Bash", input: { command } },
});

/**
 * THE DEPTH-3 TREE. root (a worker run, no session) → run-a → run-b, each
 * level holding rows of its own so "this level drew its own rows" is a
 * question with an answer. The text is synthetic throughout.
 */
function loadTree() {
  convex.runs = {
    "run-root": runDoc({ runId: "run-root", kind: "worker", depth: 0 }),
    "run-a": runDoc({
      _id: "runs|a",
      runId: "run-a",
      parentRunId: "run-root",
      kind: "subagent",
      origin: "task",
      depth: 1,
    }),
    "run-b": runDoc({
      _id: "runs|b",
      runId: "run-b",
      parentRunId: "run-a",
      kind: "subagent",
      origin: "task",
      depth: 2,
    }),
  };
  convex.rows = {
    "run-root": [
      fileRow({ _id: "m-root-1", seq: 1000, ...bash("tu-root-1", "ls -la") }),
      fileRow({
        _id: "m-root-2",
        seq: 1001,
        kind: "thinking",
        content: { text: "root run plans the sweep" },
      }),
      fileRow({
        _id: "m-root-3",
        seq: 2000,
        kind: "child-run",
        parentToolUseId: "tu-root-2",
        content: {
          childRunId: "run-a",
          agentId: "agent-a",
          agentType: "explorer",
          description: "walk the fixture tree",
          model: "opus",
          status: "completed",
          totalTokens: 1200,
        },
      }),
    ],
    "run-a": [
      fileRow({
        _id: "m-a-1",
        runId: "run-a",
        seq: 1000,
        ...bash("tu-a-1", "cat app/sessions/lib.ts"),
      }),
      fileRow({
        _id: "m-a-2",
        runId: "run-a",
        seq: 1001,
        kind: "assistant-text",
        content: { text: "child A summarizes the fixture" },
      }),
      fileRow({
        _id: "m-a-3",
        runId: "run-a",
        seq: 2000,
        kind: "child-run",
        parentToolUseId: "tu-a-2",
        content: {
          childRunId: "run-b",
          agentId: "agent-b",
          agentType: "explorer",
          description: "the grandchild leaf",
          model: "opus",
          status: "completed",
          totalTokens: 300,
        },
      }),
    ],
    "run-b": [
      fileRow({
        _id: "m-b-1",
        runId: "run-b",
        seq: 1000,
        ...bash("tu-b-1", "echo grandchild"),
      }),
      fileRow({
        _id: "m-b-2",
        runId: "run-b",
        seq: 1001,
        kind: "thinking",
        content: { text: "grandchild B finishes" },
      }),
    ],
  };
}

// ── Opening a fold ──────────────────────────────────────────────────────────

/**
 * fireEvent.click(summary) was tried first and does not work here. This
 * jsdom DOES flip `open` on the click, but it queues the `toggle` event as a
 * task rather than dispatching it — so React's onToggle has not run by the
 * time the assertions look, the component's `open` state is still false, and
 * the child has mounted nothing. Measured, not assumed: with the click alone
 * the depth-3 case fails at the child's first row.
 *
 * So every fold here is opened by setting `open` and firing `toggle` at the
 * element. The flag goes first because the handler reads e.currentTarget.open.
 */
function openChild(el: HTMLDetailsElement) {
  el.open = true;
  fireEvent(el, new Event("toggle"));
}

/** Open the fold whose child line shows this text. */
function openFold(text: string) {
  const fold = screen.getByText(text).closest("details");
  expect(fold).not.toBeNull();
  openChild(fold as HTMLDetailsElement);
}

const root = () =>
  render(
    <Run
      runId="run-root"
      depth={0}
      now={NOW}
      onOpenRun={onOpenRun}
      onOpenSession={onOpenSession}
    />,
  );

/** Every <details> between this node and the page. */
function foldDepth(el: Element): number {
  let n = 0;
  for (let p: Element | null = el.parentElement; p !== null; p = p.parentElement) {
    if (p.tagName === "DETAILS") n += 1;
  }
  return n;
}

/** How many nested row containers wrap this node — the visible indent. */
function indentDepth(el: Element): number {
  let n = 0;
  for (let p: Element | null = el.parentElement; p !== null; p = p.parentElement) {
    if (p.classList.contains("border-l")) n += 1;
  }
  return n;
}

const body = () => document.body.textContent ?? "";

beforeEach(() => {
  convex.runs = {};
  convex.rows = {};
  convex.children = {};
  convex.sessions = {};
  convex.requests = {};
  convex.seen = [];
  convex.mutations = [];
  onOpenRun.mockReset();
  onOpenSession.mockReset();
  cleanup();
});

describe("the recursion", () => {
  it("renders a depth-3 tree, each level holding its own rows", () => {
    loadTree();
    root();

    // Level 0 is on screen; nothing below it is, because nothing is open.
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(screen.getByText("walk the fixture tree")).toBeTruthy();
    expect(screen.queryByText("cat app/sessions/lib.ts")).toBeNull();

    openFold("walk the fixture tree");
    expect(screen.getByText("cat app/sessions/lib.ts")).toBeTruthy();
    expect(screen.getByText("child A summarizes the fixture")).toBeTruthy();
    expect(screen.getByText("the grandchild leaf")).toBeTruthy();
    expect(screen.queryByText("echo grandchild")).toBeNull();

    openFold("the grandchild leaf");
    expect(screen.getByText("echo grandchild")).toBeTruthy();
    expect(screen.getByText("grandchild B finishes")).toBeTruthy();

    // Every level kept its own rows — the grandchild's did not land in the
    // child's list — and the indent grows by one container per level.
    expect(indentDepth(screen.getByText("ls -la"))).toBe(0);
    expect(indentDepth(screen.getByText("cat app/sessions/lib.ts"))).toBe(1);
    expect(indentDepth(screen.getByText("echo grandchild"))).toBe(2);
  });

  it("reads nothing for a nested run until it is expanded", () => {
    loadTree();
    root();

    // The child is on screen as a line, and has asked for nothing: a run with
    // three hundred descendants must open as fast as one with none.
    const childCalls = () =>
      convex.seen.filter((call) => call.includes("run-a"));
    expect(childCalls()).toEqual([]);
    expect(convex.seen).toContain("runs:children:skip");
    expect(convex.seen).toContain("runs:get:skip");

    openFold("walk the fixture tree");
    expect(convex.seen).toContain('runs:children:{"runId":"run-a"}');
    expect(convex.seen).toContain('runs:get:{"runId":"run-a"}');
    expect(convex.seen).toContain('runs:rows:{"runId":"run-a"}');
  });

  it("draws a named child once and lists only the children no row names", () => {
    convex.runs = { "run-root": runDoc({}) };
    // No description on the row, so the child's line shows its id — which is
    // what the unmatched list shows too, and the point is that only ONE of
    // them draws it.
    convex.rows = {
      "run-root": [
        fileRow({
          _id: "m-root-1",
          seq: 2000,
          kind: "child-run",
          parentToolUseId: "tu-root-1",
          content: { childRunId: "run-a", agentType: "explorer" },
        }),
      ],
    };
    convex.children = {
      "run-root": [
        runDoc({ _id: "runs|a", runId: "run-a", kind: "subagent", depth: 1 }),
        runDoc({ _id: "runs|x", runId: "run-x", kind: "codex-child", depth: 1 }),
      ],
    };
    root();

    // The matched child: drawn at its row, and nowhere else.
    expect(screen.getAllByText("run-a")).toHaveLength(1);

    // The unmatched one — a Codex child, whose parent's file names no spawning
    // call — is the only thing in the list, and the heading counts it.
    const heading = screen.getByText(
      "1 child runs no row in this window names",
    );
    const list = heading.parentElement as HTMLElement;
    expect(within(list).getByText("run-x")).toBeTruthy();
    expect(within(list).queryByText("run-a")).toBeNull();
  });
});

describe("the composer", () => {
  it("is on a session and on nothing else", () => {
    // A run whose session is loaded: the one place Tom types.
    convex.sessions = {
      s1: {
        _id: "s1",
        _creationTime: 0,
        title: "the fixture session",
        status: "idle",
        statusChangedAt: NOW,
        createdAt: NOW - 600_000,
      },
    };
    render(
      <Run
        sessionId={SESSION_ID}
        depth={0}
        now={NOW}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />,
    );
    expect(screen.getByText("Send")).toBeTruthy();
    cleanup();

    // A background run: Slack is how Tom interacts with one (§20.4), and a
    // composer here would be a control over nothing.
    loadTree();
    root();
    expect(screen.queryByText("Send")).toBeNull();
    cleanup();

    // A subagent run opened as the page: same answer.
    loadTree();
    render(
      <Run
        runId="run-a"
        depth={0}
        now={NOW}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />,
    );
    expect(screen.getByText("subagent · task")).toBeTruthy();
    expect(screen.queryByText("Send")).toBeNull();
    cleanup();

    // A NESTED run that does carry a session. Tom does not talk to
    // sub-agents — "no I don't want to talk to sub-agents" — so depth alone
    // decides this, not what the run is.
    convex.runs = {
      "run-nested": runDoc({
        _id: "runs|nested",
        runId: "run-nested",
        kind: "session",
        depth: 1,
        sessionId: "s1",
      }),
    };
    convex.sessions = {
      s1: {
        _id: "s1",
        _creationTime: 0,
        title: "the nested session",
        status: "running",
        statusChangedAt: NOW,
        createdAt: NOW - 600_000,
      },
    };
    render(
      <Run
        runId="run-nested"
        childFacts={
          childRunOf({
            childRunId: "run-nested",
            agentType: "session",
            description: "a nested run that is itself a session",
          }) ?? undefined
        }
        depth={1}
        now={NOW}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />,
    );
    openFold("a nested run that is itself a session");
    expect(screen.queryByText("Send")).toBeNull();
  });
});

describe("the edges of the recursion", () => {
  it("stops at the nesting cap and offers the run as a page instead", () => {
    convex.runs = { "run-deep": runDoc({ runId: "run-deep", depth: 9 }) };
    convex.rows = {
      "run-deep": [fileRow({ _id: "m-deep", ...bash("tu-deep", "ls -la") })],
    };
    render(
      <Run
        runId="run-deep"
        childFacts={
          childRunOf({
            childRunId: "run-deep",
            agentType: "explorer",
            description: "past the cap",
            status: "completed",
          }) ?? undefined
        }
        depth={MAX_NESTING_DEPTH + 1}
        now={NOW}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />,
    );

    // The line is drawn from the parent's row, and nothing is mounted: no
    // fold, and not one query for this run.
    expect(body()).toContain("explorer");
    expect(body()).toContain("past the cap");
    expect(document.querySelector("details")).toBeNull();
    expect(convex.seen.filter((call) => call.includes("run-deep"))).toEqual([]);

    fireEvent.click(screen.getByText("open this run as the page"));
    expect(onOpenRun).toHaveBeenCalledWith("run-deep");
  });

  it("says a nested child's file has not landed rather than showing nothing", () => {
    // runs.get answers null: the parent's row names the child, the child's own
    // file has not been ingested.
    convex.runs = {};
    render(
      <Run
        runId="run-missing"
        childFacts={
          childRunOf({
            childRunId: "run-missing",
            agentType: "codex-child",
            description: "the child whose file never landed",
            status: "launched",
          }) ?? undefined
        }
        depth={1}
        now={NOW}
        onOpenRun={onOpenRun}
        onOpenSession={onOpenSession}
      />,
    );
    openFold("the child whose file never landed");

    expect(screen.getByText("file not landed")).toBeTruthy();
    // The line itself still comes off the parent's row.
    expect(body()).toContain("codex-child");
    expect(body()).toContain("launched");
  });

  it("draws a run that is not a session as one header line of plain facts", () => {
    loadTree();
    root();
    const header = document.querySelector("header") as HTMLElement;
    expect(header).not.toBeNull();

    // title = kind · origin, and the two facts beside it are chips, not
    // controls: nothing on a finished run's header changes the run.
    expect(within(header).getByText("worker · nightly-learning")).toBeTruthy();
    expect(within(header).getByText("ended").tagName).toBe("SPAN");
    expect(within(header).getByText("opus").tagName).toBe("SPAN");
    expect(header.querySelector("select")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });
});

// ── ROWS THAT ARE NOT IN THE RECORD ─────────────────────────────────────────
// Convex holds the run index and a bounded window of rows; the store holds
// every version. So a run outside that window is a header, an outcome and no
// transcript, and the line under the header is the only place the reader can
// be told about it. It has four states, each of them a different thing being
// true on the server — nothing asked for, a request the box has not reached
// yet, a request the box refused, and the rows back — and the failure mode of
// every one of them is a page that renders and says something false: a
// control offered while a request is already queued, a refusal shown as a
// spinner, a reason swallowed, or the line still standing over the rows it
// says are absent.

const OLD_RUN = "run-old";

/** An old run: an index row, a stored version, and no rows of its own. */
function oldRun(over: Record<string, unknown> = {}) {
  return runDoc({
    _id: "runs|old",
    runId: OLD_RUN,
    status: "ended",
    file: {
      path: "/srv/runs/old.jsonl",
      sourceHash: "a".repeat(64),
      storedHash: "d".repeat(64),
      bytes: 8192,
      storedBytes: 2048,
      // committedLine 0 with a totalLines is exactly "the record holds none of
      // this file" — what the backlog import writes for every old run.
      committedLine: 0,
      committedPrefixSha256: "e".repeat(64),
      storeKey: "runs/claude/box/old-thread/dddd",
      totalLines: 412,
    },
    ...over,
  });
}

const openOld = () =>
  render(
    <Run
      runId={OLD_RUN}
      depth={0}
      now={NOW}
      onOpenRun={onOpenRun}
      onOpenSession={onOpenSession}
    />,
  );

/** Every call to one mutation, with its arguments. */
const fired = (fn: string) =>
  convex.mutations.filter((call) => call.startsWith(`${fn}:`));

describe("a run whose rows are not in the record", () => {
  it("offers the one control that asks the box for them", () => {
    convex.runs = { [OLD_RUN]: oldRun() };
    openOld();

    expect(body()).toContain("rows not in the record");
    expect(body()).toContain("old.jsonl");
    expect(body()).toContain("version dddddddddddd");

    fireEvent.click(screen.getByText("open this run from the store"));
    expect(fired("runs:requestMaterialize")).toEqual([
      `runs:requestMaterialize:{"runId":"${OLD_RUN}"}`,
    ]);
    // An index-only run is not made evictable by being looked at: there is
    // nothing to keep, so nothing marks it read.
    expect(fired("runs:markOpened")).toEqual([]);
  });

  it("says the box is serving it while a request is pending, and offers nothing", () => {
    convex.runs = { [OLD_RUN]: oldRun() };
    convex.requests = {
      [OLD_RUN]: {
        _id: "mr1",
        _creationTime: 0,
        runId: OLD_RUN,
        requestedBy: "tom",
        requestedAt: NOW,
        status: "pending",
        slice: 2,
      },
    };
    openOld();

    // A plain sentence and no spinner: nothing is streaming, and a second
    // press would queue nothing, so there is nothing to press.
    expect(body()).toContain("opening from the store · slice 2");
    expect(screen.queryByText("open this run from the store")).toBeNull();
  });

  it("names the reason a request failed and brings the control back", () => {
    convex.runs = { [OLD_RUN]: oldRun() };
    convex.requests = {
      [OLD_RUN]: {
        _id: "mr2",
        _creationTime: 0,
        runId: OLD_RUN,
        requestedBy: "tom",
        requestedAt: NOW,
        status: "failed",
        reason: "object missing from store",
        slice: 1,
      },
    };
    openOld();

    expect(body()).toContain("could not open · object missing from store");
    // A transient store failure is one more press, never a dead end.
    expect(screen.getByText("open this run from the store")).toBeTruthy();
  });

  it("shows the rows and drops the line once they are back, and marks the run read", () => {
    convex.runs = { [OLD_RUN]: oldRun() };
    convex.rows = {
      [OLD_RUN]: [
        fileRow({
          _id: "m-old",
          runId: OLD_RUN,
          seq: 1000,
          kind: "assistant-text",
          content: { text: "the old run, back from the store" },
        }),
      ],
    };
    openOld();

    expect(screen.getByText("the old run, back from the store")).toBeTruthy();
    expect(body()).not.toContain("rows not in the record");
    expect(screen.queryByText("open this run from the store")).toBeNull();
    // Reading a run keeps it: once per page load, fire and forget, no UI.
    expect(fired("runs:markOpened")).toEqual([
      `runs:markOpened:{"runId":"${OLD_RUN}"}`,
    ]);
  });
});

// ── The proof ───────────────────────────────────────────────────────────────
// The claim this phase makes is about a SHAPE — one component, every depth,
// each level's rows under its own fold — and a shape is proved by looking at
// it. This prints the rendered tree: one line per row, its kind, how many
// folds enclose it, and the compact line the reader sees.

/**
 * Straight to the real stdout, not through console.log. Vitest 4's default
 * reporter swallows a passing test's console output entirely — the proof would
 * only be visible under --reporter=verbose, and a proof nobody sees on the
 * normal command is not one. writeSync(1) is below the interception.
 */
function print(line: string) {
  writeSync(1, `${line}\n`);
}

/** Each fixture row by a phrase its compact line shows. The DOM carries no
 *  `kind`, so the printout reads it back off the fixture rather than guessing. */
const FIXTURE_KIND: [string, string][] = [
  ["ls -la", "tool-call"],
  ["root run plans the sweep", "thinking"],
  ["walk the fixture tree", "child-run"],
  ["cat app/sessions/lib.ts", "tool-call"],
  ["child A summarizes the fixture", "assistant-text"],
  ["the grandchild leaf", "child-run"],
  ["echo grandchild", "tool-call"],
  ["grandchild B finishes", "thinking"],
];

const kindOf = (text: string) =>
  FIXTURE_KIND.find(([phrase]) => text.includes(phrase))?.[1] ?? "unknown";

/** A rendered row: a compact line's button, a child run's summary, or prose. */
const ROW_SELECTOR =
  "button.w-full.text-left.cursor-pointer, summary, p.whitespace-pre-wrap.break-words";

function compactText(el: Element): string {
  const spans = Array.from(el.querySelectorAll(":scope > span"));
  const parts =
    spans.length > 0
      ? spans.map((span) => (span.textContent ?? "").trim())
      : [(el.textContent ?? "").trim()];
  return parts
    .filter((part) => part !== "")
    .join(" · ")
    .replace(/\s+/g, " ");
}

describe("the rendered tree", () => {
  it("prints every row of the depth-3 fixture with its nesting depth", () => {
    loadTree();
    root();
    openFold("walk the fixture tree");
    openFold("the grandchild leaf");

    const lines = Array.from(document.querySelectorAll(ROW_SELECTOR)).map(
      (el) => {
        const text = compactText(el);
        return `depth ${foldDepth(el)} · ${kindOf(text)} · ${text}`;
      },
    );

    print("--- depth-3 fixture, rendered ---");
    for (const line of lines) print(line);

    // Every fixture row, and nothing else.
    expect(lines).toHaveLength(FIXTURE_KIND.length);
    expect(lines.some((line) => line.includes("unknown"))).toBe(false);
  });
});
