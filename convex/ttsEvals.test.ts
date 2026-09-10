import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { GOLDEN_MAX_ITEMS, partitionOf } from "./ttsEvals";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const DAY = 86_400_000;

function prelude(commit: string) {
  return `MODEL-OF-TOM FILES (WikiTom commit ${commit}): model-of-tom/writing.md\nbody`;
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  createdAt: number,
  opener: string | undefined,
  title = "a session",
) {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("claudeSessions", {
      title,
      kind: "adhoc",
      repo: "none",
      status: "ended",
      statusChangedAt: createdAt,
      nextSeq: 1,
      createdAt,
    });
    if (opener !== undefined) {
      await ctx.db.insert("claudeInbound", {
        sessionId: id,
        kind: "user-turn",
        author: "agent",
        text: opener,
        status: "done",
        createdAt,
      });
    }
    return id;
  });
}

async function nightly(t: ReturnType<typeof convexTest>, at: number, commit: string, posted: unknown) {
  await t.run(async (ctx) => {
    await ctx.db.insert("dtsEvents", { at, kind: "nightly-run", data: { commit, posted } });
  });
}

describe("internalPreludeDelivery", () => {
  it("counts current and stale session preludes, including days behind", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await nightly(t, now - 3 * DAY, "111111111111", ["model-of-tom/writing.md"]);
    await nightly(t, now - 2 * DAY, "222222222222", ["model-of-tom/writing.md"]);
    await seedSession(t, now - DAY, prelude("222222222222"), "current");
    await seedSession(t, now - DAY + 1, prelude("111111111111"), "stale");
    const facts = await t.query(internal.ttsEvals.internalPreludeDelivery, { since: now - 4 * DAY, until: now + DAY });
    expect(facts.current).toBe(1);
    expect(facts.stale).toMatchObject([{ title: "stale", had: "111111111111", expected: "222222222222", behindDays: 1 }]);
  });

  it("does not place sessions against a nightly row whose commit was not posted", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await nightly(t, now - 3 * DAY, "111111111111", ["model-of-tom/writing.md"]);
    await nightly(t, now - 2 * DAY, "222222222222", null);
    await seedSession(t, now - DAY, prelude("111111111111"));
    const facts = await t.query(internal.ttsEvals.internalPreludeDelivery, { since: now - 4 * DAY, until: now + DAY });
    expect(facts.current).toBe(1);
    expect(facts.stale).toEqual([]);
  });

  it("puts an opener without a prelude header in missing", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await nightly(t, now - DAY, "111111111111", ["model-of-tom/writing.md"]);
    await seedSession(t, now, "plain opener", "no prelude");
    const facts = await t.query(internal.ttsEvals.internalPreludeDelivery, { since: now - 2 * DAY, until: now + DAY });
    expect(facts.missing).toMatchObject([{ title: "no prelude", had: null, expected: "111111111111" }]);
  });

  it("counts a session created before the first timeline entry as unplaced", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await nightly(t, now - DAY, "111111111111", ["model-of-tom/writing.md"]);
    await seedSession(t, now - 2 * DAY, prelude("111111111111"));
    const facts = await t.query(internal.ttsEvals.internalPreludeDelivery, { since: now - 3 * DAY, until: now + DAY });
    expect(facts).toMatchObject({ current: 0, unplaced: 1, stale: [], missing: [] });
  });

  it("marks a prelude commit this deployment never posted with negative one days behind", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await nightly(t, now - DAY, "111111111111", ["model-of-tom/writing.md"]);
    await seedSession(t, now, prelude("aaaaaaaaaaaa"));
    const facts = await t.query(internal.ttsEvals.internalPreludeDelivery, { since: now - 2 * DAY, until: now + DAY });
    expect(facts.stale[0]).toMatchObject({ had: "aaaaaaaaaaaa", behindDays: -1 });
  });
});

describe("internalGoldenInput", () => {
  it("takes twenty approve and revise items per partition, newest first, and never takes a partial partition", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let partition = 0; partition < 6; partition++) {
        const todoId = await ctx.db.insert("dtsTodos", {
          statement: `todo ${partition}`,
          category: `category-${partition}`,
          readiness: "unprepared",
          status: "active",
          timingClass: "whenever",
          source: "test",
          createdAt: now,
          updatedAt: now,
        });
        for (const verdict of ["approve", "revise"] as const) {
          for (let ordinal = 0; ordinal < 20; ordinal++) {
            await ctx.db.insert("dtsRulings", {
              subjectType: "life",
              todoId,
              verdict,
              sentence: verdict === "revise" ? `revise ${ordinal}` : undefined,
              ruledAt: now - partition * 10_000 - ordinal,
            });
          }
        }
      }
    });
    const result = await t.query(internal.ttsEvals.internalGoldenInput, {});
    expect(result.items).toHaveLength(GOLDEN_MAX_ITEMS);
    expect(new Set(result.items.map((item) => item.partition)).size).toBe(5);
    for (const partition of new Set(result.items.map((item) => item.partition))) {
      const items = result.items.filter((item) => item.partition === partition);
      expect(items.filter((item) => item.verdict === "approve")).toHaveLength(20);
      expect(items.filter((item) => item.verdict === "revise")).toHaveLength(20);
      for (const verdict of ["approve", "revise"] as const) {
        const times = items.filter((item) => item.verdict === verdict).map((item) => item.ruledAt);
        expect(times).toEqual([...times].sort((a, b) => b - a));
      }
    }
  });

  it("excludes session and archive rulings", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const todoId = await ctx.db.insert("dtsTodos", {
        statement: "a todo", readiness: "unprepared", status: "active", timingClass: "whenever", source: "test", createdAt: now, updatedAt: now,
      });
      for (const verdict of ["session", "archive"] as const) {
        await ctx.db.insert("dtsRulings", { subjectType: "life", todoId, verdict, ruledAt: now });
      }
    });
    expect((await t.query(internal.ttsEvals.internalGoldenInput, {})).items).toEqual([]);
  });

  it("uses uncategorised for a life todo without a category", () => {
    expect(partitionOf({ job: "prepare" })).toBe("prepare/uncategorised");
  });
});

describe("internalSearchEvals", () => {
  it("filters eval runs by repo and since", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: 10, kind: "evals-run", key: "tom.quest@old", data: { repo: "tom.quest", sha: "old" } });
      await ctx.db.insert("dtsEvents", { at: 20, kind: "evals-run", key: "WikiTom@new", data: { repo: "WikiTom", sha: "new" } });
      await ctx.db.insert("dtsEvents", { at: 30, kind: "evals-run", key: "tom.quest@new", data: { repo: "tom.quest", sha: "new" } });
    });
    const repo = await t.query(internal.ttsEvals.internalSearchEvals, { repo: "tom.quest" });
    expect(repo).toMatchObject([
      { data: { sha: "new" } },
      { data: { sha: "old" } },
    ]);
    const since = await t.query(internal.ttsEvals.internalSearchEvals, { since: 20 });
    expect(since).toMatchObject([
      { data: { sha: "new" } },
      { data: { sha: "new" } },
    ]);
  });
});
