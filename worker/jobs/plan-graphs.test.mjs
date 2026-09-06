// Tests for the planner's passes (worker/jobs/plan-graphs.mjs). The job
// cannot run end-to-end here — it needs headless Claude, the Convex routes and
// the Jarvis Box's cursor file — so each pass takes its model call and its
// Convex writes as an `io` argument, and these cases run the passes against
// stubs: what is pinned is which todos a pass selects, what it writes back for
// each, and which rulings it consumes.
//
// Importing the job module is safe: it only calls main() when node was
// pointed at the file (the `invokedDirectly` guard at the bottom).

import { describe, expect, it, vi } from "vitest";

import {
  BRIEF_MAX_PER_RUN,
  PREPARE_MAX,
  PREPARED,
  briefCodeTodos,
  briefPrompt,
  preparePrompt,
  prepareLifeTodos,
  selectBriefTargets,
  selectPrepareTargets,
} from "./plan-graphs.mjs";
import { CMT_REPO, sourceHash } from "./tts-code-lib.mjs";

const WRITING_STANDARD = "WRITING STANDARD — test copy.";
const TODAY = "2026-09-06";

// A complete answer for one todo, as the model is asked to give it.
const answer = (over = {}) =>
  JSON.stringify({
    brief: "A short brief.",
    entryAction: "Open the page",
    workDescription: "a two-minute errand",
    groundUpExplanation: "<!DOCTYPE html><html><body>why</body></html>",
    dueDate: null,
    dateKind: null,
    ...over,
  });

const todo = (over = {}) => ({
  _id: "t1",
  statement: "renew the visa",
  status: "active",
  readiness: "unprepared",
  source: "slack-capture",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

function stubIo(answers) {
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  return {
    runClaude: vi.fn(() => queue.shift() ?? answer()),
    post: vi.fn(async () => ({ ok: true })),
    readHash: () => null,
    writeHash: vi.fn(),
  };
}

describe("selectPrepareTargets", () => {
  it("takes active unprepared todos and leaves prepared, terminal, batch and task rows alone", () => {
    const todos = [
      todo({ _id: "raw" }),
      todo({ _id: "done", readiness: "prepared" }),
      todo({ _id: "archived", status: "archived" }),
      // A v1 batch row is the batcher's, never prepared here.
      todo({ _id: "batch", members: [] }),
      // A graph task rests at "unprepared"; a bound GOAL is still Tom's todo.
      todo({ _id: "task", batchId: "b1", kind: "task" }),
      todo({ _id: "goal", batchId: "b1", kind: "goal" }),
    ];
    const { targets } = selectPrepareTargets(todos, []);
    expect(targets.map((t) => t._id)).toEqual(["raw", "goal"]);
  });

  it("re-prepares a todo with a pending life revise ruling whatever its status", () => {
    const todos = [
      todo({ _id: "asleep", readiness: "prepared", status: "archived" }),
      todo({ _id: "batch", members: [], readiness: "prepared" }),
    ];
    const pending = [
      { _id: "r1", subjectType: "life", verdict: "revise", todoId: "asleep", sentence: "shorter" },
      // A revise on a v1 batch belongs to the batcher, not the preparer.
      { _id: "r2", subjectType: "life", verdict: "revise", todoId: "batch", sentence: "x" },
      // Other verdicts and other subject types are not this pass's.
      { _id: "r3", subjectType: "life", verdict: "approve", todoId: "asleep" },
      { _id: "r4", subjectType: "batch", verdict: "revise", batchId: "b1", sentence: "y" },
    ];
    const { targets, reviseByTodo } = selectPrepareTargets(todos, pending);
    expect(targets.map((t) => t._id)).toEqual(["asleep"]);
    expect([...reviseByTodo.keys()]).toEqual(["asleep"]);
  });

  it("with --force also re-prepares prepared active todos", () => {
    const todos = [todo({ _id: "p", readiness: "prepared" })];
    expect(selectPrepareTargets(todos, [], { force: true }).targets).toHaveLength(1);
    expect(selectPrepareTargets(todos, []).targets).toHaveLength(0);
  });
});

describe("prepareLifeTodos", () => {
  it("writes the write-up through the prepare pen with readiness prepared and marks the row", async () => {
    const t = todo();
    const io = stubIo(answer());
    const result = await prepareLifeTodos(
      { todos: [t], pending: [], today: TODAY, writingStandard: WRITING_STANDARD },
      io,
    );
    expect(result).toEqual({ prepared: 1, failed: 0, preparedIds: ["t1"] });
    expect(io.runClaude).toHaveBeenCalledTimes(1);
    // The prompt carries the item and the standard the explanation obeys.
    expect(io.runClaude.mock.calls[0][0]).toContain("renew the visa");
    expect(io.runClaude.mock.calls[0][0]).toContain(WRITING_STANDARD);
    expect(io.post).toHaveBeenCalledTimes(1);
    expect(io.post).toHaveBeenCalledWith("/tts/prepare-todo", {
      id: "t1",
      brief: "A short brief.",
      entryAction: "Open the page",
      workDescription: "a two-minute errand",
      groundUpExplanation: "<!DOCTYPE html><html><body>why</body></html>",
      readiness: PREPARED,
    });
    // The plan pass in the same run reads the write-up off the object.
    expect(t.brief).toBe("A short brief.");
    expect(t.readiness).toBe("prepared");
  });

  it("sends the statement's own date as a first date, at New York noon, and never over an existing one", async () => {
    const fresh = todo({ _id: "fresh", statement: "pay rent sept 3" });
    const dated = todo({ _id: "dated", statement: "pay rent sept 3", dueAt: 1 });
    const resolved = todo({
      _id: "resolved",
      statement: "pay rent sept 3",
      dateOutcomes: [{ dueAt: 1, outcome: "missed", at: 2 }],
    });
    const io = stubIo([
      answer({ dueDate: "2026-09-03", dateKind: "external" }),
      answer({ dueDate: "2026-09-03", dateKind: "external" }),
      answer({ dueDate: "2026-09-03" }),
    ]);
    await prepareLifeTodos(
      { todos: [fresh, dated, resolved], pending: [], today: TODAY, writingStandard: WRITING_STANDARD },
      io,
    );
    const bodies = io.post.mock.calls.map((c) => c[1]);
    // 2026-09-03 noon in New York (EDT, UTC-4) is 16:00 UTC.
    expect(bodies[0]).toMatchObject({
      id: "fresh",
      dueAt: Date.UTC(2026, 8, 3, 16),
      dateKind: "external",
    });
    expect(bodies[1]).not.toHaveProperty("dueAt");
    expect(bodies[2]).not.toHaveProperty("dueAt");
  });

  it("drops a malformed date and still lands the rest of the preparation", async () => {
    const io = stubIo(answer({ dueDate: "next friday" }));
    const result = await prepareLifeTodos(
      { todos: [todo()], pending: [], today: TODAY, writingStandard: WRITING_STANDARD },
      io,
    );
    expect(result.prepared).toBe(1);
    expect(io.post.mock.calls[0][1]).not.toHaveProperty("dueAt");
  });

  it("embeds a revise sentence in the prompt and consumes the ruling once the re-prep landed", async () => {
    const t = todo({ readiness: "prepared" });
    const pending = [
      { _id: "r1", subjectType: "life", verdict: "revise", todoId: "t1", sentence: "make it about the fee" },
    ];
    const io = stubIo(answer());
    await prepareLifeTodos(
      { todos: [t], pending, today: TODAY, writingStandard: WRITING_STANDARD },
      io,
    );
    expect(io.runClaude.mock.calls[0][0]).toContain("make it about the fee");
    expect(io.post).toHaveBeenCalledTimes(2);
    expect(io.post.mock.calls[1]).toEqual([
      "/tts/ruling-applied",
      { id: "r1", result: "revised: brief re-prepared" },
    ]);
  });

  it("leaves a revise ruling pending when the re-prep fails, and one bad item does not starve the rest", async () => {
    const a = todo({ _id: "a" });
    const b = todo({ _id: "b", readiness: "prepared" });
    const pending = [
      { _id: "r1", subjectType: "life", verdict: "revise", todoId: "b", sentence: "again" },
    ];
    // "a" gets a good answer; "b" gets one with no explanation (bad shape).
    const io = stubIo([answer(), answer({ groundUpExplanation: "" })]);
    const result = await prepareLifeTodos(
      { todos: [a, b], pending, today: TODAY, writingStandard: WRITING_STANDARD },
      io,
    );
    expect(result).toEqual({ prepared: 1, failed: 1, preparedIds: ["a"] });
    expect(io.post).toHaveBeenCalledTimes(1);
    expect(io.post.mock.calls[0][1].id).toBe("a");
    expect(b.readiness).toBe("prepared"); // untouched — the ruling stays pending
  });

  it("prepares at most PREPARE_MAX per run and nothing when idle", async () => {
    const many = Array.from({ length: PREPARE_MAX + 3 }, (_, i) => todo({ _id: `t${i}` }));
    const io = stubIo([]);
    const result = await prepareLifeTodos(
      { todos: many, pending: [], today: TODAY, writingStandard: WRITING_STANDARD },
      io,
    );
    expect(result.prepared).toBe(PREPARE_MAX);
    expect(io.runClaude).toHaveBeenCalledTimes(PREPARE_MAX);

    const idle = stubIo([]);
    const none = await prepareLifeTodos(
      { todos: [todo({ readiness: "prepared" })], pending: [], today: TODAY, writingStandard: WRITING_STANDARD },
      idle,
    );
    expect(none).toEqual({ prepared: 0, failed: 0, preparedIds: [] });
    expect(idle.runClaude).not.toHaveBeenCalled();
  });

  it("asks for a date only from the statement's own words, resolved against today", () => {
    const text = preparePrompt(todo(), null, TODAY, WRITING_STANDARD);
    expect(text).toContain(`today is ${TODAY} in New York`);
    expect(text).toContain("NEVER infer, estimate, or invent a date");
    expect(text).toContain('"groundUpExplanation"');
  });
});

// ── The brief pass ──────────────────────────────────────────────────────────

const ENTRY_A = { id: "cmt-001", tier: "R", statement: "do the thing", created: "2026-08-01" };
const ENTRY_B = { id: "cmt-002", tier: "C", statement: "decide the other thing", created: "2026-08-02" };
const TODOS_YAML = [
  "- id: cmt-001",
  "  tier: R",
  "  statement: do the thing",
  "  created: 2026-08-01",
  "",
  "- id: cmt-002",
  "  tier: C",
  "  statement: decide the other thing",
  "  created: 2026-08-02",
  "",
  "# --- closed todos ---",
  "",
].join("\n");

const briefAnswer = (over = {}) =>
  JSON.stringify({
    brief: "A ground-up brief.",
    recommendation: "approve",
    execClass: "box",
    ...over,
  });

function briefIo(answers, hashes = {}) {
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  return {
    runClaude: vi.fn(() => queue.shift() ?? briefAnswer()),
    post: vi.fn(async () => ({ ok: true })),
    readHashes: () => hashes,
    writeHashes: vi.fn(),
    hashes,
  };
}

const repo = (entries = [ENTRY_A, ENTRY_B]) => ({
  dir: "/var/cache/tts/ComplexMultiTrigger",
  todosText: TODOS_YAML,
  entries,
});

describe("selectBriefTargets", () => {
  it("briefs an entry whose hash moved and leaves an unchanged one alone", () => {
    const hashes = { [`${CMT_REPO}:cmt-001`]: sourceHash(ENTRY_A) };
    const targets = selectBriefTargets([ENTRY_A, ENTRY_B], hashes, []);
    expect(targets.map((t) => t.entry.id)).toEqual(["cmt-002"]);
    expect(targets[0].hash).toBe(sourceHash(ENTRY_B));
    expect(targets[0].revise).toBeNull();
  });

  it("re-briefs an unchanged entry Tom ruled revise on, and only for CMT code rulings", () => {
    const hashes = {
      [`${CMT_REPO}:cmt-001`]: sourceHash(ENTRY_A),
      [`${CMT_REPO}:cmt-002`]: sourceHash(ENTRY_B),
    };
    const pending = [
      { _id: "r1", subjectType: "code", verdict: "revise", repo: CMT_REPO, externalId: "cmt-001", sentence: "fresh plan" },
      { _id: "r2", subjectType: "code", verdict: "approve", repo: CMT_REPO, externalId: "cmt-002" },
      { _id: "r3", subjectType: "code", verdict: "revise", repo: "tom.quest", externalId: "cmt-002", sentence: "x" },
      { _id: "r4", subjectType: "life", verdict: "revise", todoId: "t1", sentence: "y" },
    ];
    const targets = selectBriefTargets([ENTRY_A, ENTRY_B], hashes, pending);
    expect(targets.map((t) => t.entry.id)).toEqual(["cmt-001"]);
    expect(targets[0].revise._id).toBe("r1");
  });

  it("with --force briefs everything", () => {
    const hashes = { [`${CMT_REPO}:cmt-001`]: sourceHash(ENTRY_A) };
    expect(selectBriefTargets([ENTRY_A], hashes, [], { force: true })).toHaveLength(1);
  });
});

describe("briefCodeTodos", () => {
  it("posts the brief in the four-word shape, then advances the cursor", async () => {
    const io = briefIo(briefAnswer({ evidence: "commit abc" }));
    const result = await briefCodeTodos({ repo: repo([ENTRY_A]), pending: [] }, io);
    expect(result).toEqual({ briefed: 1, failed: 0 });
    // The model reads the checkout and gets the raw YAML block, not JSON.
    expect(io.runClaude.mock.calls[0][1].cwd).toBe("/var/cache/tts/ComplexMultiTrigger");
    expect(io.runClaude.mock.calls[0][0]).toContain("- id: cmt-001\n  tier: R");
    expect(io.post).toHaveBeenCalledWith("/tts/code-briefs", {
      briefs: [
        {
          repo: CMT_REPO,
          externalId: "cmt-001",
          sourceHash: sourceHash(ENTRY_A),
          brief: "A ground-up brief.",
          recommendation: "approve",
          execClass: "box",
          evidence: "commit abc",
        },
      ],
    });
    expect(io.writeHashes).toHaveBeenCalledWith({
      [`${CMT_REPO}:cmt-001`]: sourceHash(ENTRY_A),
    });
  });

  it("refuses a recommendation outside the four words and advances no cursor", async () => {
    const io = briefIo(briefAnswer({ recommendation: "stale-replan" }));
    const result = await briefCodeTodos({ repo: repo([ENTRY_A]), pending: [] }, io);
    expect(result).toEqual({ briefed: 0, failed: 1 });
    expect(io.post).not.toHaveBeenCalled();
    expect(io.writeHashes).not.toHaveBeenCalled();
  });

  it("puts Tom's revise sentence in the prompt and consumes the ruling after the brief posts", async () => {
    const hashes = { [`${CMT_REPO}:cmt-001`]: sourceHash(ENTRY_A) };
    const pending = [
      { _id: "r1", subjectType: "code", verdict: "revise", repo: CMT_REPO, externalId: "cmt-001", sentence: "drop step 3" },
    ];
    const io = briefIo(briefAnswer({ recommendation: "revise" }), hashes);
    await briefCodeTodos({ repo: repo([ENTRY_A]), pending }, io);
    expect(io.runClaude.mock.calls[0][0]).toContain("drop step 3");
    expect(io.runClaude.mock.calls[0][0]).toContain("Propose a");
    expect(io.post.mock.calls.map((c) => c[0])).toEqual(["/tts/code-briefs", "/tts/ruling-applied"]);
    expect(io.post.mock.calls[1][1]).toEqual({
      id: "r1",
      result: "revised: brief re-written with a fresh plan",
    });
  });

  it("leaves the ruling pending when the re-brief fails", async () => {
    const pending = [
      { _id: "r1", subjectType: "code", verdict: "revise", repo: CMT_REPO, externalId: "cmt-001", sentence: "again" },
    ];
    const io = briefIo("not json at all");
    const result = await briefCodeTodos({ repo: repo([ENTRY_A]), pending }, io);
    expect(result).toEqual({ briefed: 0, failed: 1 });
    expect(io.post).not.toHaveBeenCalled();
  });

  it("briefs at most BRIEF_MAX_PER_RUN per run, all of them with --force, and nothing when idle", async () => {
    const many = Array.from({ length: BRIEF_MAX_PER_RUN + 2 }, (_, i) => ({
      id: `cmt-${i}`,
      statement: `entry ${i}`,
    }));
    const io = briefIo([]);
    expect((await briefCodeTodos({ repo: repo(many), pending: [] }, io)).briefed).toBe(
      BRIEF_MAX_PER_RUN,
    );
    const forced = briefIo([]);
    expect(
      (await briefCodeTodos({ repo: repo(many), pending: [], force: true }, forced)).briefed,
    ).toBe(BRIEF_MAX_PER_RUN + 2);
    const idle = briefIo([], { [`${CMT_REPO}:cmt-001`]: sourceHash(ENTRY_A) });
    expect(await briefCodeTodos({ repo: repo([ENTRY_A]), pending: [] }, idle)).toEqual({
      briefed: 0,
      failed: 0,
    });
    expect(idle.runClaude).not.toHaveBeenCalled();
  });

  it("asks for the four verdict words and nothing else", () => {
    const text = briefPrompt("- id: x", null);
    expect(text).toContain('"recommendation": "approve|revise|session|archive"');
    expect(text).not.toContain("stale-replan");
  });
});
