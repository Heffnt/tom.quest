// The observation surface's reads: the gate, the window's bounds, what each
// query returns, and the one number this module derives rather than counts —
// the needs-you threads still waiting on Tom.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { isFailureKind } from "./observe";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const PAGE = { numItems: 100, cursor: null };

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

async function withUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "someone", email: "s@tom.quest", role: "user" }),
  );
  return t.withIdentity({ subject: userId });
}

/** The fields dtsTodos requires, so a fixture names only what it is about. */
const todo = (statement: string) => ({
  statement,
  kind: "task" as const,
  status: "active" as const,
  readiness: "prepared" as const,
  timingClass: "whenever" as const,
  source: "test",
  createdAt: 1,
  updatedAt: 1,
});

const RUN = {
  runId: "claude:box:aaaaaaaa",
  rootRunId: "claude:box:aaaaaaaa",
  depth: 0,
  linkKnown: true,
  origin: "test",
  host: "box" as const,
  environment: "worker" as const,
  cli: "claude" as const,
  parserVersion: "1",
  kind: "job" as const,
  status: "ended" as const,
  startedAt: 1_000,
  lastLineAt: 2_000,
  attachments: [],
  file: {
    path: "/tmp/a.jsonl",
    sourceHash: "a",
    storedHash: "a",
    bytes: 1,
    storedBytes: 1,
    committedLine: 1,
    committedPrefixSha256: "a",
  },
  ingestedAt: 1_000,
};

describe("the gate", () => {
  it("is Tom's, and the agent account is not admitted", async () => {
    const t = convexTest({ schema, modules });
    const user = await withUser(t);
    await expect(
      user.query(api.observe.runsInWindow, { from: 0, to: 10_000, paginationOpts: PAGE }),
    ).rejects.toThrow(/restricted to Tom/);
  });
});

describe("the window", () => {
  it("refuses a window that ends before it starts, and one wider than a month", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.query(api.observe.runsInWindow, { from: 10, to: 10, paginationOpts: PAGE }),
    ).rejects.toThrow(/ends after it starts/);
    await expect(
      tom.query(api.observe.runsInWindow, {
        from: 0,
        to: 60 * 24 * 60 * 60 * 1000,
        paginationOpts: PAGE,
      }),
    ).rejects.toThrow(/at most a month/);
  });

  it("returns the runs that started inside it and no others", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("runs", RUN);
      await ctx.db.insert("runs", {
        ...RUN,
        runId: "claude:box:bbbbbbbb",
        rootRunId: "claude:box:bbbbbbbb",
        startedAt: 9_000,
        lastLineAt: 9_500,
      });
    });
    const page = await tom.query(api.observe.runsInWindow, {
      from: 0,
      to: 5_000,
      paginationOpts: PAGE,
    });
    expect(page.page.map((run) => run.runId)).toEqual(["claude:box:aaaaaaaa"]);
  });
});

describe("the point events", () => {
  it("keeps the merges, the delegate's rows, the gate's head rows and the failures", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      for (const kind of [
        "merge",
        "delegate-decision",
        "tests-run",
        "poll-gmail-failed",
        "slack-send-failed",
        "tts-opened",
        "surfaced",
      ]) {
        await ctx.db.insert("dtsEvents", { at: 100, kind });
      }
    });
    const page = await tom.query(api.observe.eventsInWindow, {
      from: 0,
      to: 1_000,
      paginationOpts: PAGE,
    });
    expect(page.page.map((event) => event.kind).sort()).toEqual([
      "delegate-decision",
      "merge",
      "poll-gmail-failed",
      "tests-run",
      "tts-opened",
    ]);
  });

  it("counts a gate head row and a page open without carrying their bodies", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: 100, kind: "audit-verdict", data: { text: "a".repeat(4000) } });
      await ctx.db.insert("dtsEvents", { at: 110, kind: "merge", data: { repo: "tom.quest", sha: "abc" } });
    });
    const page = await tom.query(api.observe.eventsInWindow, {
      from: 0,
      to: 1_000,
      paginationOpts: PAGE,
    });
    const audit = page.page.find((event) => event.kind === "audit-verdict");
    const merge = page.page.find((event) => event.kind === "merge");
    expect(audit?.data).toBeNull();
    expect(merge?.data).not.toBeNull();
  });

  it("sends the browser the fields the page draws and leaves a job's stderr on the server", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 120,
        kind: "nightly-failure",
        data: {
          job: "nightly",
          step: "push",
          error: "remote: https://x-access-token:ghp_SECRET@github.com/Heffnt/tom.quest",
        },
      });
    });
    const page = await tom.query(api.observe.eventsInWindow, {
      from: 0,
      to: 1_000,
      paginationOpts: PAGE,
    });
    const failure = page.page.find((event) => event.kind === "nightly-failure");
    expect(failure?.data).toEqual({ job: "nightly" });
    expect(JSON.stringify(page)).not.toContain("ghp_SECRET");
  });

  it("calls a failure both spellings of one, but not the two that are not broken lines", () => {
    expect(isFailureKind("poll-canvas-failed")).toBe(true);
    // The nightly and the weekly write the other spelling, and they are job
    // failures like any other.
    expect(isFailureKind("nightly-failure")).toBe(true);
    expect(isFailureKind("weekly-failure")).toBe(true);
    expect(isFailureKind("slack-send-failed")).toBe(false);
    expect(isFailureKind("learning-revert-failed")).toBe(false);
  });
});

describe("the rulings", () => {
  it("carries the subject's own statement, not its id", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      const todoId = await ctx.db.insert("dtsTodos", todo("rename the observation page"));
      await ctx.db.insert("dtsRulings", {
        subjectType: "life",
        todoId,
        verdict: "approve",
        ruledAt: 500,
      });
    });
    const rulings = await tom.query(api.observe.rulingsInWindow, { from: 0, to: 1_000 });
    expect(rulings).toHaveLength(1);
    expect(rulings[0].subject).toBe("rename the observation page");
  });
});

describe("waiting on Tom", () => {
  it("counts a needs-you thread with no reply of his after it, and no other", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const answered = await ctx.db.insert("dtsTodos", todo("answered"));
      const open = await ctx.db.insert("dtsTodos", todo("open"));
      await ctx.db.insert("dtsEvents", { at: now - 2_000, kind: "needs-tom", todoId: answered });
      await ctx.db.insert("dtsEvents", { at: now - 1_000, kind: "slack-event", todoId: answered });
      await ctx.db.insert("dtsEvents", { at: now - 3_000, kind: "needs-tom", todoId: open });
    });
    const answer = await tom.query(api.observe.waitingOnTom, {});
    expect(answer.waiting).toBe(1);
    expect(answer.oldestAt).toBe(now - 3_000);
  });
});

describe("the merge gate's state", () => {
  it("is the gate's own answer, and a commit with no head rows is not allowed", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const [gate] = await tom.query(api.observe.gateRows, {
      commits: [{ repo: "tom.quest", sha: "abcdef1234" }],
    });
    expect(gate.allowed).toBe(false);
    expect(gate.checks.map((check) => check.name).sort()).toEqual(["audit", "evals", "tests"]);
    expect(gate.checks.every((check) => check.passed)).toBe(false);
  });
});

describe("defining a word", () => {
  it("reads the lines of the published bodies that define it, and says where each came from", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomFiles", {
        name: "agent-rules",
        sourcePath: "model-of-tom/agent-rules.md",
        syncedAt: 1,
        body: [
          "Some prose that mentions a runner in passing.",
          "- **runner** — one experiment watched by a chain of short step runs.",
        ].join(String.fromCharCode(10)),
      });
    });
    const answer = await tom.query(api.observe.define, { term: "runner" });
    expect(answer.found).toHaveLength(1);
    expect(answer.found[0].where).toBe("model-of-tom/agent-rules.md");
    expect(answer.found[0].text).toContain("one experiment watched");
  });

  it("says a word is in the vocabulary even when nothing in the record defines it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const answer = await tom.query(api.observe.define, { term: "ruling" });
    expect(answer.inVocabulary).toBe(true);
    expect(answer.found).toEqual([]);
    expect(answer.elsewhere).toContain("vocabulary.json");
  });

  it("carries a skill's own description when the word names a skill", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: "know-week",
        group: "know",
        description: "Tom's recurring week.",
        body: "nothing here defines anything",
        syncedAt: 1,
      });
    });
    const answer = await tom.query(api.observe.define, { term: "know-week" });
    expect(answer.found.some((entry) => entry.text === "Tom's recurring week.")).toBe(true);
  });
});
