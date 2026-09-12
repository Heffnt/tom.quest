import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import {
  COVERAGE_NOT_REQUIRED,
  EVALS_RUN,
  GOLDEN_MAX_ITEMS,
  GOLDEN_PER_VERDICT_MAX,
  partitionOf,
} from "./ttsEvals";
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

describe("internalLabelInput", () => {
  // A label is one act of Tom's; only a JUDGMENT becomes an eval case. The two
  // exclusions below are the whole gate, and they are separate facts: a
  // session or archive verdict says nothing about whether the text landed, and
  // every session-reply label is judgment: false by construction because phase
  // 7 builds no classifier of his tone.
  it("reads judgments only, and never the session-reply door", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const todoId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("dtsTodos", {
        statement: "a todo", readiness: "unprepared", status: "active",
        timingClass: "whenever", source: "test", createdAt: now, updatedAt: now,
      });
      const rulingId = await ctx.db.insert("dtsRulings", {
        subjectType: "life", todoId: id, verdict: "approve", ruledAt: now,
      });
      await ctx.db.insert("runLabels", {
        runId: "claude:box:ruled-run", source: "ruling", actor: "tom", polarity: "good",
        meaning: "Tom approved this output", judgment: true, ref: `ruling:${rulingId}`, at: now,
      });
      // A session verdict: recorded on the run page, not a judgment.
      await ctx.db.insert("runLabels", {
        runId: "claude:box:ruled-run", source: "ruling", actor: "tom", polarity: "neutral",
        meaning: "Tom wants to talk about this before it goes further", judgment: false,
        ref: "ruling:talk", at: now,
      });
      await ctx.db.insert("runLabels", {
        runId: "claude:box:session-run", source: "session-reply", actor: "tom", polarity: "neutral",
        meaning: "no, the other one", judgment: false, ref: "reply:abc:7", at: now,
      });
      return id;
    });
    const { items } = await t.query(internal.ttsEvals.internalLabelInput, {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: "ruling",
      run: null,
      link: { todoId, subjectKey: `life ${todoId}` },
    });
  });

  it("takes at most the per-verdict maximum from each door, newest first", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let ordinal = 0; ordinal < GOLDEN_PER_VERDICT_MAX + 5; ordinal += 1) {
        await ctx.db.insert("runLabels", {
          runId: "claude:box:objected-run", source: "objection", actor: "tom", polarity: "bad",
          meaning: "Tom reverted this decision", judgment: true,
          ref: `objection:${ordinal}`, at: now - ordinal,
        });
      }
    });
    const { items } = await t.query(internal.ttsEvals.internalLabelInput, {});
    expect(items).toHaveLength(GOLDEN_PER_VERDICT_MAX);
    const times = items.map((item) => item.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(times[0]).toBe(now);
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

// A pull request that touches nothing the evals watch used to get NO evals
// row at all — the workflow's `paths:` filter skipped the whole job — and the
// merge gate denies without one, so a pure-code branch could never merge. The
// filter now lives in the check, and a request marked `unaffected` is answered
// by this door in the same mutation that files it: no queue entry for the box
// to pick up, no model, and a row the gate can read.
describe("an unaffected evals request", () => {
  const REPO = "tom.quest";
  const SHA = "2e08b28e9df5f65bb374151bdcfab7ee0a3d360a";
  const BASE = "f5c1fb9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  const runs = (t: TestConvex<typeof schema>) =>
    t.run(async (ctx) =>
      ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_RUN).eq("key", `${REPO}@${SHA}`))
        .collect(),
    );

  const request = (t: TestConvex<typeof schema>, over: Record<string, unknown> = {}) =>
    t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: SHA,
      baseSha: BASE,
      paths: ["model-of-tom/**"],
      changed: ["convex/ttsMerge.ts", "worker/jobs/evals.mjs"],
      unaffected: true,
      ...over,
    });

  it("stamps the run row itself, with the base run's standing numbers", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 1,
        kind: EVALS_RUN,
        key: `${REPO}@${BASE}`,
        data: { repo: REPO, sha: BASE, items: 40, pass: 38, goldenHash: "h" },
      });
    });
    expect(await request(t)).toMatchObject({ existing: false, unaffected: true });
    const rows = await runs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({
      unaffected: true,
      regressions: 0,
      goldenCoverage: COVERAGE_NOT_REQUIRED,
      flaky: 0,
      items: 40,
      pass: 38,
      // It scored no set of its own, and never says it did.
      goldenHash: null,
      changed: ["convex/ttsMerge.ts", "worker/jobs/evals.mjs"],
    });
  });

  it("answers with zeroes when nothing ever scored the base", async () => {
    const t = convexTest({ schema, modules });
    await request(t);
    expect((await runs(t))[0].data).toMatchObject({ items: 0, pass: 0, regressions: 0 });
  });

  // The box's queue takes the oldest request with NO run at its key, so a
  // request answered as it is filed is never handed out and no model runs.
  it("leaves the box nothing to pick up", async () => {
    const t = convexTest({ schema, modules });
    await request(t);
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
  });

  // A check RE-RUN at the same sha finds its request already filed. Returning
  // early there would leave a head with a request and no row — the shape that
  // waits seventy-five minutes and then denies.
  it("answers a re-run whose request was already filed, and only once", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: SHA,
      baseSha: BASE,
      paths: ["model-of-tom/**"],
      changed: ["convex/ttsMerge.ts"],
    });
    expect(await runs(t)).toHaveLength(0);
    expect(await request(t)).toMatchObject({ existing: true, unaffected: true });
    expect(await runs(t)).toHaveLength(1);
    await request(t);
    expect(await runs(t)).toHaveLength(1);
  });

  // A branch that DID touch a watched path still queues for the box.
  it("does not touch a request that is not unaffected", async () => {
    const t = convexTest({ schema, modules });
    await request(t, { unaffected: undefined, changed: ["model-of-tom/intent.md"] });
    expect(await runs(t)).toHaveLength(0);
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: SHA,
      unaffected: false,
    });
  });
});
