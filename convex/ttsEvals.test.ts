import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import {
  EVALS_REQUEST,
  EVALS_REQUEST_SCAN_LIMIT,
  EVALS_RUN,
  GOLDEN_MAX_ITEMS,
  GOLDEN_PER_VERDICT_MAX,
  partitionOf,
} from "./ttsEvals";
import { EVALS_PROTOCOL, EVALS_PROTOCOL_SINCE, PROTOCOL_SUPERSEDED } from "../shared/evals-row.mjs";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const DAY = 86_400_000;
// EVERY REQUEST THESE TESTS FILE IS FILED UNDER THE PROTOCOL, because one
// filed before it is never served (shared/evals-row.mjs
// EVALS_PROTOCOL_SINCE): the queue answers it superseded without a run, which
// is a different question from the ones below. The rows' `at` stays small — it
// is the order, not the date — and `requestedAt` is the date.
const PROTOCOL_ERA = Date.parse(EVALS_PROTOCOL_SINCE);

describe("the box evals protocol", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads omitted legacy traffic as protocol 1 and keeps one newest-seen row", async () => {
    const t = convexTest({ schema, modules });
    expect(await t.mutation(internal.ttsEvals.internalObserveBoxEvalsProtocol, {}))
      .toEqual({
        boxEvalsVersion: 1,
        evalsProtocol: EVALS_PROTOCOL,
        protocolGap:
          `the box's evals runner is at protocol 1; this door needs ${EVALS_PROTOCOL} — run worker/setup.sh on the box`,
      });
    expect(await t.mutation(internal.ttsEvals.internalObserveBoxEvalsProtocol, {
      boxEvalsVersion: EVALS_PROTOCOL + 1,
    })).toEqual({
      boxEvalsVersion: EVALS_PROTOCOL + 1,
      evalsProtocol: EVALS_PROTOCOL,
      protocolGap: null,
    });
    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", "evals-protocol-seen").eq("key", "box"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ boxEvalsVersion: EVALS_PROTOCOL + 1 });
  });

  it("records the protocol carried by an evals row post", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "worker-key");
    const t = convexTest({ schema, modules });
    const response = await t.fetch("/tts/event", {
      method: "POST",
      headers: { "X-TTS-Key": "worker-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: EVALS_RUN,
        key: "tom.quest@abc1234",
        data: { repo: "tom.quest", sha: "abc1234", boxEvalsVersion: EVALS_PROTOCOL },
      }),
    });
    expect(response.status).toBe(200);
    expect(await t.query(internal.ttsEvals.internalEvalsRun, {
      repo: "tom.quest",
      sha: "missing",
    })).toMatchObject({ boxEvalsVersion: EVALS_PROTOCOL, protocolGap: null });
  });

  it("records the protocol carried by a queue read before returning work", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "worker-key");
    const t = convexTest({ schema, modules });
    const response = await t.fetch(`/tts/evals-request?boxEvalsVersion=${EVALS_PROTOCOL}`, {
      method: "GET",
      headers: { "X-TTS-Key": "worker-key" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request: null,
      boxEvalsVersion: EVALS_PROTOCOL,
      evalsProtocol: EVALS_PROTOCOL,
      protocolGap: null,
    });
  });
});

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
        const todoId = await ctx.db.insert("todos", {
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
            await ctx.db.insert("rulings", {
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
      const todoId = await ctx.db.insert("todos", {
        statement: "a todo", readiness: "unprepared", status: "active", timingClass: "whenever", source: "test", createdAt: now, updatedAt: now,
      });
      for (const verdict of ["session", "archive"] as const) {
        await ctx.db.insert("rulings", { subjectType: "life", todoId, verdict, ruledAt: now });
      }
    });
    expect((await t.query(internal.ttsEvals.internalGoldenInput, {})).items).toEqual([]);
  });

  it("takes no item from a stored ruling on a batch", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const batchId = await ctx.db.insert("batches", { statement: "a batch", status: "active", createdAt: now, updatedAt: now });
      await ctx.db.insert("rulings", { subjectType: "batch", batchId, verdict: "approve", ruledAt: now });
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
      const id = await ctx.db.insert("todos", {
        statement: "a todo", readiness: "unprepared", status: "active",
        timingClass: "whenever", source: "test", createdAt: now, updatedAt: now,
      });
      const rulingId = await ctx.db.insert("rulings", {
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

// The client can only FILE an unaffected claim. The box recomputes the diff
// and reads the base tree's policy before it writes a row that opens the gate.
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

  it("files the claim without stamping an evals row", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 1,
        kind: EVALS_RUN,
        key: `${REPO}@${BASE}`,
        data: { repo: REPO, sha: BASE, items: 40, pass: 38, goldenHash: "h" },
      });
    });
    expect(await request(t)).toMatchObject({ existing: false });
    const rows = await runs(t);
    expect(rows).toHaveLength(0);
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: SHA,
      unaffectedClaimed: true,
    });
  });

  it("re-files the claim as a fresh box question", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: SHA,
      baseSha: BASE,
      paths: ["model-of-tom/**"],
      changed: ["convex/ttsMerge.ts"],
    });
    expect(await runs(t)).toHaveLength(0);
    expect(await request(t)).toMatchObject({ existing: true });
    expect(await runs(t)).toHaveLength(0);
    await request(t);
    expect(await runs(t)).toHaveLength(0);
  });

  // A branch that DID touch a watched path still queues for the box.
  it("does not touch a request that is not unaffected", async () => {
    const t = convexTest({ schema, modules });
    await request(t, { unaffected: undefined, changed: ["model-of-tom/intent.md"] });
    expect(await runs(t)).toHaveLength(0);
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: SHA,
      unaffectedClaimed: false,
    });
  });
});


// AN IDENTICAL RE-RUN IS NOT A NEW QUESTION, and the cost is the reason it
// matters: a run is about fifty minutes and eighty model calls, and re-dating
// the request is what throws the last one away. `.github/workflows/evals.yml`
// fires on `edited` so that an `evals: no-item` trailer ADDED to a body is
// honoured — nothing else would notice it — and the same trigger fires on
// every typo fixed in a description. The trailer is part of the question; the
// prose around it is not.
describe("an identical evals request", () => {
  const REPO = "tom.quest";
  const SHA = "aee6483245faf746b3cf92bfe3da2108a1061d57";
  const BASE = "f5c1fb9c36092bdebb2c4ab1ee0f411c97edd4eb";
  const TRAILER = "evals: no-item gate and runner infrastructure";

  const file = (t: TestConvex<typeof schema>, over: Record<string, unknown> = {}) =>
    t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: SHA,
      baseSha: BASE,
      pr: 172,
      runId: 100,
      paths: ["model-of-tom/**"],
      changed: ["worker/jobs/evals.mjs", "convex/ttsEvals.ts"],
      prBody: "The branch as it stands.",
      ...over,
    });

  const requests = (t: TestConvex<typeof schema>) =>
    t.run(async (ctx) =>
      ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@${SHA}`))
        .collect(),
    );

  const standingRequestedAt = async (t: TestConvex<typeof schema>) =>
    ((await requests(t))[0].data as { requestedAt: number }).requestedAt;

  /** An evals-run row stamped with the request standing when it was written. */
  const row = async (t: TestConvex<typeof schema>, data: Record<string, unknown>) => {
    const answersRequestAt = await standingRequestedAt(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: EVALS_RUN,
        key: `${REPO}@${SHA}`,
        data: { repo: REPO, sha: SHA, answersRequestAt, ...data },
      });
    });
  };

  /** A real measurement of the trees. */
  const score = (t: TestConvex<typeof schema>) =>
    row(t, { regressions: 0, goldenCoverage: true });

  const scoredRun = (t: TestConvex<typeof schema>) =>
    t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: SHA });

  it("keeps one row and answers the re-run out of the run already scored", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await score(t);
    const before = await standingRequestedAt(t);
    expect(await file(t)).toMatchObject({ existing: true, renewed: false });
    const after = await requests(t);
    expect(after).toHaveLength(1);
    expect((after[0].data as { requestedAt: number }).requestedAt).toBe(before);
    // The whole point: the scored row still answers, so nothing is served.
    expect(await scoredRun(t)).toMatchObject({ run: { regressions: 0 } });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
  });

  // THE ORDER CI LISTS THE DIFF IN IS NOT A FACT ABOUT THE DIFF, so a
  // re-ordering that re-scored would be a fifty-minute run bought by nothing.
  it("reads the same paths in another order as the same question", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await score(t);
    expect(await file(t, { changed: ["convex/ttsEvals.ts", "worker/jobs/evals.mjs"] }))
      .toMatchObject({ renewed: false });
    expect(await scoredRun(t)).toMatchObject({ run: { regressions: 0 } });
  });

  // A BASE IS HALF THE MEASUREMENT. A pull request retargeted, or a rebase that
  // moves the merge base, asks about a different diff between different trees,
  // and the numbers from the old base say nothing about it.
  it("re-scores when the base moves", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await score(t);
    expect(await file(t, { baseSha: "6af3eef4c1b2a09876543210fedcba9876543210" }))
      .toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: SHA,
      baseSha: "6af3eef4c1b2a09876543210fedcba9876543210",
    });
  });

  it("re-scores when the diff moves", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await score(t);
    expect(await file(t, { changed: ["worker/jobs/evals.mjs", "model-of-tom/intent.md"] }))
      .toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });
  });

  it("does not re-score a body edited outside the trailer", async () => {
    const t = convexTest({ schema, modules });
    await file(t, { prBody: `The branch as it stands.\n\n${TRAILER}\n` });
    await score(t);
    expect(await file(t, { prBody: `The branch, reworded entirely.\n\n${TRAILER}\n` }))
      .toMatchObject({ renewed: false });
    expect(await scoredRun(t)).toMatchObject({ run: { regressions: 0 } });
  });

  // THE TRAILER IS THE COVERAGE ANSWER, so adding one, rewording its reason or
  // removing it asks the box something it has not been asked.
  it("re-scores when the trailer is added, reworded or removed", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await score(t);
    expect(await file(t, { prBody: `The branch as it stands.\n\n${TRAILER}\n` }))
      .toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });

    await score(t);
    expect(await file(t, { prBody: `The branch as it stands.\n\n${TRAILER}, no layer changed\n` }))
      .toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });

    await score(t);
    expect(await file(t, { prBody: "The branch as it stands." })).toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });
  });

  // A RE-RUN WHILE THE BOX IS STILL WORKING KEEPS ITS PLACE IN LINE. Re-dating
  // an unanswered request sends it to the back of a queue served one request a
  // pass, which is how a check times out behind its own re-runs.
  it("keeps a pending request where it is in the queue", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: PROTOCOL_ERA + 1,
        kind: EVALS_REQUEST,
        key: `${REPO}@earlier`,
        data: {
          repo: REPO, sha: "earlier", baseSha: BASE, pr: 171, runId: 50,
          paths: ["model-of-tom/**"], changed: ["model-of-tom/intent.md"],
          prBody: null, unaffectedClaimed: false, requestedAt: PROTOCOL_ERA + 1,
        },
      });
    });
    await file(t);
    const before = (await requests(t))[0].at;
    expect(await file(t)).toMatchObject({ renewed: false });
    expect((await requests(t))[0].at).toBe(before);
    // Still behind the request filed before it, which is where it was.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {}))
      .toMatchObject({ sha: "earlier" });
  });

  // THE ONE ANSWER AN IDENTICAL RE-ASK DOES NOT INHERIT. A superseded row says
  // where the sha stood in the push order when the queue looked, and a branch
  // force-pushed back to it makes that sha the head again. Leaving the row
  // standing is the permanent-unmergeable bug the re-dating rule was opened to
  // fix, so it survives the identity rule intact.
  it("re-serves a sha the branch came back to, identical request and all", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await row(t, { superseded: true, supersededBy: "bbbbbbb", regressions: null });
    expect(await scoredRun(t)).toMatchObject({ run: { superseded: true } });
    expect(await file(t, { runId: 300 })).toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {}))
      .toMatchObject({ sha: SHA, runId: 300 });
  });

  // The same for a run that failed: an error row is a fact about one attempt.
  it("re-serves a sha whose run errored", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await row(t, { error: "could not fetch the tree", regressions: null });
    expect(await file(t)).toMatchObject({ renewed: true });
    expect(await scoredRun(t)).toMatchObject({ run: null });
  });

  // PR #177, 2026-09-15, AND THE REASON THIS CASE EXISTS. A row can carry a
  // runner-error COUNT without carrying `error` at all: the box reached the
  // trees and ran the set, and some items were never measured because their
  // model or tool call died. Both gates deny on that row, and before the count
  // joined reopensOnReask the row stood — so after the runner fix rolled, a
  // re-run of the evals workflow read the standing errored row and failed at
  // once, with only `evals.mjs --force` able to produce a new one. The re-ask
  // must re-date the request and leave the check waiting for a fresh run.
  it("re-serves a sha whose run scored with runner errors", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    const before = await standingRequestedAt(t);
    await row(t, { errored: 2, regressions: null, goldenCoverage: true, pass: 27, items: 29 });
    expect(await scoredRun(t)).toMatchObject({ run: { errored: 2 } });
    expect(await file(t)).toMatchObject({ renewed: true });
    // The old row no longer answers the question standing now, so the check
    // waits rather than reading it again, and the queue has the sha to serve.
    expect(await scoredRun(t)).toMatchObject({ run: null });
    expect(await standingRequestedAt(t)).toBeGreaterThan(before);
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {}))
      .toMatchObject({ sha: SHA });
  });

  // The other side of the same line: a clean scored row has `errored: 0`, and
  // zero is not a fact about one attempt — it is the measurement itself.
  it("answers an identical re-run out of a scored row with no runner errors", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await row(t, { errored: 0, regressions: 0, goldenCoverage: true });
    expect(await file(t)).toMatchObject({ renewed: false });
    expect(await scoredRun(t)).toMatchObject({ run: { regressions: 0 } });
  });

  // An UNAFFECTED row is decided by the base sha and the changed paths, which
  // are two thirds of the identity: ask the same question and the answer
  // cannot have changed, so the row stands and the re-run costs nothing.
  it("answers an identical re-run out of an unaffected row", async () => {
    const t = convexTest({ schema, modules });
    await file(t, { unaffected: true });
    await row(t, { unaffected: true, regressions: 0 });
    expect(await file(t, { unaffected: true })).toMatchObject({ renewed: false });
    expect(await scoredRun(t)).toMatchObject({ run: { unaffected: true } });
  });

  // A REQUEST OLDER THAN THE PROTOCOL IS NEVER SERVED, and the way out it is
  // given is exactly the one the identity rule would close: re-run the check
  // and the request that files is dated now. Held at its old date it would be
  // refused on every re-run until the drain reached it, the check timing out
  // each time.
  it("re-dates a request filed before the protocol, identical or not", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: PROTOCOL_ERA - DAY,
        kind: EVALS_REQUEST,
        key: `${REPO}@${SHA}`,
        data: {
          repo: REPO, sha: SHA, baseSha: BASE, pr: 172, runId: 100,
          paths: ["model-of-tom/**"],
          changed: ["worker/jobs/evals.mjs", "convex/ttsEvals.ts"],
          prBody: "The branch as it stands.", unaffectedClaimed: false,
          requestedAt: PROTOCOL_ERA - DAY,
        },
      });
    });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {}))
      .toMatchObject({ sha: SHA, supersededBy: PROTOCOL_SUPERSEDED });
    expect(await file(t)).toMatchObject({ renewed: true });
    // Dated now, so it is served like any other.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {}))
      .toMatchObject({ sha: SHA, supersededBy: null });
  });

  // A PENDING REQUEST KEEPS ITS PLACE ONLY WHILE IT STILL HAS ONE. Found by the
  // box's audit of this round. The queue serves a TRAILING window of the newest
  // five hundred request rows, and re-dating is the only thing that ever put a
  // request back into it — so holding an unanswered one at its old date would
  // leave the sha unservable for good, its check timing out on every re-run.
  // That is the exact shape of bug this branch keeps finding, and the rule that
  // saves a re-run its place in line must not reintroduce it.
  it("re-dates a pending request that has aged out of the queue's window", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    // A full window of newer requests files in behind it.
    await t.run(async (ctx) => {
      for (let i = 0; i < EVALS_REQUEST_SCAN_LIMIT; i += 1) {
        const sha = `later${i}`;
        await ctx.db.insert("dtsEvents", {
          at: Date.now() + i + 1,
          kind: EVALS_REQUEST,
          key: `${REPO}@${sha}`,
          data: {
            repo: REPO, sha, baseSha: BASE, pr: 900 + i, runId: i + 1,
            paths: ["model-of-tom/**"], changed: [], prBody: null,
            unaffectedClaimed: false, requestedAt: PROTOCOL_ERA + i + 1,
          },
        });
        await ctx.db.insert("dtsEvents", {
          at: Date.now() + i + 1,
          kind: EVALS_RUN,
          key: `${REPO}@${sha}`,
          data: { repo: REPO, sha, regressions: 0, answersRequestAt: PROTOCOL_ERA + i + 1 },
        });
      }
    });
    // Out of the window: the queue cannot see it, which is why re-dating is the
    // only thing that can bring it back.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
    expect(await file(t)).toMatchObject({ renewed: true });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {}))
      .toMatchObject({ sha: SHA });
  }, 60_000);

  // The push order is not the question, and it still has to move: the head map
  // is built on `runId`, so a re-run whose id is higher must be recorded even
  // when nothing else about the request changed.
  it("records a higher run id without re-dating the question", async () => {
    const t = convexTest({ schema, modules });
    await file(t);
    await score(t);
    const before = await standingRequestedAt(t);
    expect(await file(t, { runId: 900 })).toMatchObject({ renewed: false });
    const after = await requests(t);
    expect(after).toHaveLength(1);
    expect((after[0].data as { runId: number }).runId).toBe(900);
    expect((after[0].data as { requestedAt: number }).requestedAt).toBe(before);
    expect(await scoredRun(t)).toMatchObject({ run: { regressions: 0 } });
  });
});

// Four pushes to one branch in a morning file four requests, and the box
// serves one per pass at about thirty-five minutes: the check on the fourth
// waits out three runs of shas nobody will merge and then fails on its own
// seventy-five-minute deadline, which is what happened to #172 and #173 on
// 2026-09-12. The queue names each pull request's head, and every older sha of
// that pull request is handed out marked for a one-POST answer.
describe("a superseded request", () => {
  const REPO = "tom.quest";

  // The rows are written DIRECTLY, with the `at` each one is ordered by. The
  // door stamps Date.now(), so three requests filed inside one millisecond
  // would leave the order this query depends on to the tie-break rather than
  // to the test.
  const file = (
    t: TestConvex<typeof schema>,
    at: number,
    sha: string,
    over: Record<string, unknown> = {},
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at,
        kind: EVALS_REQUEST,
        key: `${REPO}@${sha}`,
        data: {
          repo: REPO,
          sha,
          baseSha: "f5c1fb9",
          pr: 173,
          runId: at * 100,
          paths: ["model-of-tom/**"],
          changed: ["model-of-tom/intent.md"],
          prBody: null,
          unaffected: false,
          requestedAt: PROTOCOL_ERA + at,
          ...over,
        },
      });
    });

  const answer = (t: TestConvex<typeof schema>, sha: string) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@${sha}`))
        .first();
      const request = row!.data as { requestedAt: number };
      await ctx.db.insert("dtsEvents", {
        at: 99,
        kind: EVALS_RUN,
        key: `${REPO}@${sha}`,
        data: { repo: REPO, sha, superseded: true, answersRequestAt: request.requestedAt },
      });
    });

  // A scored row records the request inputs it measured. An unchanged request
  // stays answered; a replacement request does not.
  const scored = async (t: TestConvex<typeof schema>, sha: string) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@${sha}`))
        .first();
      const request = row!.data as {
        requestedAt: number;
        baseSha: string | null;
        changed: string[] | null;
        prBody: string | null;
      };
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: EVALS_RUN,
        key: `${REPO}@${sha}`,
        data: {
          repo: REPO, sha, regressions: 0,
          answersRequestAt: request.requestedAt,
          answersBaseSha: request.baseSha,
          answersChanged: request.changed,
          answersPrBody: request.prBody,
        },
      });
    });

  it("marks every older sha of the pull request with the newest one", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa");
    await file(t, 2, "bbbbbbb");
    await file(t, 3, "ccccccc");
    // THE OLDEST IS STILL THE ONE HANDED OUT. The order does not change; what
    // changes is what it costs to answer.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: "ccccccc",
    });
    await answer(t, "aaaaaaa");
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb",
      supersededBy: "ccccccc",
    });
    await answer(t, "bbbbbbb");
    // And the head itself is run, with nothing superseding it.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "ccccccc",
      supersededBy: null,
    });
  });

  // A supersession is a fact about ONE branch. Two pull requests queued
  // together are two live heads, and neither may answer the other away.
  it("never supersedes across pull requests", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { pr: 172 });
    await file(t, 2, "bbbbbbb", { pr: 173 });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
  });

  // A check that sent no pull-request number is in the map for nothing: two
  // shas that only look related are not a supersession.
  it("never supersedes a request with no pull-request number", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { pr: null });
    await file(t, 2, "bbbbbbb", { pr: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
  });

  // THE ORDER IS THE PUSH'S, NOT THE REQUEST'S. Two pushes a minute apart
  // start two jobs that each spend twenty to forty seconds on checkout before
  // filing anything, so the NEWER push's request can reach Convex first. Read
  // by arrival, the queue would mark the live head superseded — and that
  // mistake does not heal, because the row it writes is what stops the box
  // picking that sha up again.
  it("reads the push order off the run id, not off when the request arrived", async () => {
    const t = convexTest({ schema, modules });
    // The newer push (run id 900) filed FIRST; the older push (run id 100)
    // arrived second.
    await file(t, 1, "bbbbbbb", { runId: 900 });
    await file(t, 2, "aaaaaaa", { runId: 100 });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb",
      // The head, and it is run.
      supersededBy: null,
    });
    await answer(t, "bbbbbbb");
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: "bbbbbbb",
    });
  });

  // SUPERSEDED IS NOT A VERDICT, and the request's own clock is what says so.
  //
  // A force-push back to an earlier commit makes that commit the head again.
  // Before this, the request row kept the run id it was filed with, so the
  // head map went on naming the LATER sha the head; the superseded row written
  // the first time round was permanent, so the queue skipped the request as
  // already answered and the check read the stale row on every re-run. A valid
  // head was left unmergeable with nothing able to fix it.
  it("runs a sha the branch came back to, and stops reading its old superseded row", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100 });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    // The morning as it happened: A is superseded by B and answered without a
    // run, B is the head and is scored.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: "bbbbbbb",
    });
    await answer(t, "aaaaaaa");
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: { superseded: true } });

    // THE FORCE-PUSH BACK TO A. GitHub makes a new workflow run with a higher
    // id, and the check files its request through the real door.
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: "aaaaaaa",
      baseSha: "f5c1fb9",
      pr: 173,
      runId: 300,
      paths: ["model-of-tom/**"],
      changed: ["model-of-tom/intent.md"],
    });
    // One request row for the sha, carrying the NEWEST run's id.
    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@aaaaaaa`))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { runId: number }).runId).toBe(300);

    // The stale superseded row answers nobody: the check polls on past it, and
    // the box's `already scored` short-circuit does not fire either — both read
    // this same door.
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    // B IS BEHIND A NOW, which is what the higher run id means — and B is the
    // oldest unanswered request, because re-filing A re-dated it to now.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb",
      supersededBy: "aaaaaaa",
    });
    await answer(t, "bbbbbbb");
    // And then A itself, handed out to be SCORED rather than answered away.
    // This is the whole point of the change: the head the branch came back to
    // is servable again.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
    // Scored for real, and a row that measured the sha is one no later request
    // can make stale.
    await scored(t, "aaaaaaa");
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
  });

  // The other half of the same rule: a sha that is STILL superseded stays
  // answered. Without this the queue would hand the same dead sha out on every
  // tick, and the box would post a superseded row for it on every tick.
  it("leaves a sha that is still superseded answered", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100 });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    await answer(t, "aaaaaaa");
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: { superseded: true } });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb",
    });
  });

  // A RE-RUN OF THE CHECK IS A NEW QUESTION TOO. It re-files the request, so
  // the superseded row that answered the old one goes stale and the sha is
  // served again — and if it is still superseded, it is answered superseded a
  // second time, in one POST and no model.
  it("serves a re-run at the head again, and re-supersedes a re-run that is still behind", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100 });
    await answer(t, "aaaaaaa");
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
    // The same run id: GitHub keeps it across a re-run, and that is fine —
    // what re-opens the sha is the request being asked again, not the id.
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "f5c1fb9", pr: 173, runId: 100, paths: ["model-of-tom/**"],
    });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
    // A later push arrives. It is older by `at` — A was re-dated when it was
    // re-filed — so it is handed out first, and it is the head.
    await file(t, 2, "bbbbbbb", { runId: 900 });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb",
      supersededBy: null,
    });
    await answer(t, "bbbbbbb");
    // And A, still behind it, is handed out AS SUPERSEDED — so the box answers
    // it in one POST rather than scoring a dead sha.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: "bbbbbbb",
    });
  });

  // A LATE REQUEST FROM AN OLDER PUSH IS NOT A NEW QUESTION. Its run id proves
  // that its whole view of the diff predates the request already standing, so
  // it cannot restore a removed no-item trailer or re-date the stale payload
  // into the question the box answers.
  it("keeps the whole newer request when an older run arrives late", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", {
      baseSha: "6af3eef",
      pr: 172,
      runId: 500,
      paths: ["model-of-tom/**"],
      changed: ["model-of-tom/intent.md"],
      prBody: "the body as it reads now",
      unaffected: false,
    });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: "aaaaaaa",
      baseSha: "f5c1fb9",
      pr: 173,
      runId: 100,
      paths: ["worker/**"],
      changed: ["worker/setup.sh"],
      prBody: "evals: no-item\nold body",
      unaffected: true,
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@aaaaaaa`))
        .first(),
    );
    expect(row).toMatchObject({
      at: 1,
      data: {
        repo: REPO,
        sha: "aaaaaaa",
        baseSha: "6af3eef",
        pr: 172,
        runId: 500,
        paths: ["model-of-tom/**"],
        changed: ["model-of-tom/intent.md"],
        prBody: "the body as it reads now",
        unaffected: false,
        requestedAt: PROTOCOL_ERA + 1,
      },
    });
    // A keeps its old place in line too, and is still the head. Had 100 and the
    // stale timestamp been written, it would instead look superseded by B.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
  });

  // THE WHOLE PAYLOAD IS THE NEW REQUEST'S, not two fields of it. `baseSha`,
  // `pr`, `changed`, `prBody` and `unaffected` are facts about the DIFF the
  // check just read, and a sha can be asked about against a different base — a
  // pull request retargeted, a rebase that moves the merge base. Found by the
  // box's audit of the first cut of this fix, which patched runId alone.
  it("replaces every field of a re-filed request, not just the run id", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", {
      runId: 100,
      baseSha: "f5c1fb9",
      pr: 172,
      changed: ["worker/setup.sh"],
      prBody: "the first body",
      unaffected: true,
    });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO,
      sha: "aaaaaaa",
      baseSha: "6af3eef",
      pr: 173,
      runId: 300,
      paths: ["model-of-tom/**"],
      changed: ["model-of-tom/intent.md"],
      prBody: "the body as it reads now",
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@aaaaaaa`))
        .first(),
    );
    expect(row!.data).toMatchObject({
      baseSha: "6af3eef",
      pr: 173,
      runId: 300,
      changed: ["model-of-tom/intent.md"],
      prBody: "the body as it reads now",
        // This is a client hint only; it never opens the gate from Convex.
        unaffectedClaimed: false,
    });
    // AND `at` MOVES WITH IT. That field is what internalOldestEvalsRequest's
    // trailing window is built on, so a renewed request left at its original
    // date ages out of the window and becomes invisible — unanswered and
    // unservable at once.
    expect(row!.at).toBeGreaterThan(1);
  });

  // NO ID MEANS NO ORDER, NOT STALE. In either direction the incoming diff is
  // the current question because there is no proof it arrived late. A missing
  // incoming id still cannot lower the known id already on the row.
  it("replaces every field when either request has no run id", async () => {
    for (const { currentRunId, incomingRunId, standingRunId } of [
      { currentRunId: null, incomingRunId: 300, standingRunId: 300 },
      { currentRunId: 100, incomingRunId: null, standingRunId: 100 },
    ]) {
      const t = convexTest({ schema, modules });
      await file(t, 1, "aaaaaaa", {
        runId: currentRunId,
        baseSha: "f5c1fb9",
        pr: 172,
        paths: ["worker/**"],
        changed: ["worker/setup.sh"],
        prBody: "the first body",
        unaffected: true,
      });
      await t.mutation(internal.ttsEvals.internalRequestEvals, {
        repo: REPO,
        sha: "aaaaaaa",
        baseSha: "6af3eef",
        pr: 173,
        ...(incomingRunId === null ? {} : { runId: incomingRunId }),
        paths: ["model-of-tom/**"],
        changed: ["model-of-tom/intent.md"],
        prBody: "the body as it reads now",
      });
      const row = await t.run(async (ctx) =>
        await ctx.db
          .query("dtsEvents")
          .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@aaaaaaa`))
          .first(),
      );
      expect(row).toMatchObject({
        data: {
          baseSha: "6af3eef",
          pr: 173,
          runId: standingRunId,
          paths: ["model-of-tom/**"],
          changed: ["model-of-tom/intent.md"],
          prBody: "the body as it reads now",
          unaffectedClaimed: false,
        },
      });
      expect(row!.at).toBeGreaterThan(1);
      expect((row!.data as { requestedAt: number }).requestedAt).toBeGreaterThan(1);
    }
  });

  // A field the new request does not carry is NULL, never the old value: a
  // list this check did not compute is not an answer to this check's question.
  it("does not keep a field the new request left out", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { changed: ["worker/setup.sh"], prBody: "the first body" });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "f5c1fb9", pr: 173, runId: 300, paths: ["model-of-tom/**"],
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@aaaaaaa`))
        .first(),
    );
    expect(row!.data).toMatchObject({ changed: null, prBody: null });
  });

  // The same staleness rule, pointing the other way. A superseded row left a
  // valid head unmergeable; a stale UNAFFECTED row would open the gate on
  // `no watched path changed` for a diff that changed one.
  it("stops an unaffected row answering a request whose diff now touches a watched path", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100, unaffected: true });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 50,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: { repo: REPO, sha: "aaaaaaa", unaffected: true, regressions: 0, answersRequestAt: PROTOCOL_ERA + 1 },
      });
    });
    // While that is what was asked, it answers.
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: { unaffected: true } });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
    // Asked again against a base whose diff DOES touch a watched path.
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "6af3eef", pr: 173, runId: 300,
      paths: ["model-of-tom/**"], changed: ["model-of-tom/intent.md"],
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      unaffectedClaimed: false,
    });
  });

  it("lets a stamped scored row answer exactly its request and serves a mismatch", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100, prBody: "evals: no-item wording only" });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 50,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: {
          repo: REPO, sha: "aaaaaaa", regressions: 0, pass: 29, items: 29,
          answersRequestAt: PROTOCOL_ERA + 1,
          answersBaseSha: "f5c1fb9",
          answersChanged: ["model-of-tom/intent.md"],
          answersPrBody: "evals: no-item wording only",
        },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: { regressions: 0, pass: 29 } });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "6af3eef", pr: 173, runId: 300,
      paths: ["model-of-tom/**"], changed: ["model-of-tom/intent.md"], prBody: "evals: no-item wording only",
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({ sha: "aaaaaaa" });
  });

  it("keeps an unstamped scored row historical while serving the pending request", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa");
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "6af3eef", pr: 173, runId: 100,
      paths: ["model-of-tom/**"], changed: ["model-of-tom/intent.md"],
    });
    const request = await t.query(internal.ttsEvals.internalEvalsRequest, { repo: REPO, sha: "aaaaaaa" });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: request!.requestedAt + 1,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: { repo: REPO, sha: "aaaaaaa", regressions: 0, pass: 29, items: 29 },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      changed: ["model-of-tom/intent.md"],
    });
  });

  it("uses an unstamped scored base as comparison evidence while withholding the head", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "head000");
    await file(t, 2, "base000");
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 3,
        kind: EVALS_RUN,
        key: `${REPO}@head000`,
        data: { repo: REPO, sha: "head000", regressions: 0, pass: 29, items: 29 },
      });
      await ctx.db.insert("dtsEvents", {
        at: 4,
        kind: EVALS_RUN,
        key: `${REPO}@base000`,
        data: { repo: REPO, sha: "base000", regressions: 0, pass: 28, items: 29 },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, {
      repo: REPO, sha: "head000", baseSha: "base000",
    })).toMatchObject({
      run: null,
      base: { regressions: 0, pass: 28, items: 29 },
    });
  });

  it("does not let a scored no-item exemption answer after the trailer is removed", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { prBody: "evals: no-item wording only" });
    await scored(t, "aaaaaaa");
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "f5c1fb9", pr: 173, runId: 100,
      paths: ["model-of-tom/**"], changed: ["model-of-tom/intent.md"], prBody: "",
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({ sha: "aaaaaaa" });
  });

  it("refuses a passing scored row posted after its request was replaced", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { prBody: "evals: no-item wording only" });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "6af3eef", pr: 173, runId: 100,
      paths: ["model-of-tom/**"], changed: ["model-of-tom/intent.md"], prBody: "",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now() + 60_000,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: {
          repo: REPO, sha: "aaaaaaa", regressions: 0, goldenCoverage: true,
          answersRequestAt: 1,
          answersBaseSha: "f5c1fb9",
          answersChanged: ["model-of-tom/intent.md"],
          answersPrBody: "evals: no-item wording only",
        },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({ sha: "aaaaaaa" });
  });

  it("keeps an unstamped unaffected row from answering the request it cannot name", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100, unaffected: true });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 50,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: { repo: REPO, sha: "aaaaaaa", unaffected: true, regressions: 0 },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      unaffectedClaimed: true,
    });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "f5c1fb9", pr: 173, runId: 100,
      paths: ["model-of-tom/**"], changed: ["worker/setup.sh"], unaffected: true,
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      unaffectedClaimed: true,
    });
    const runs = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_RUN).eq("key", `${REPO}@aaaaaaa`))
        .collect(),
    );
    expect(runs).toHaveLength(1);
  });

  // THE WINDOW TRAILS THE TABLE, and this is the case that killed the queue.
  //
  // The scan read the OLDEST rows, and request rows are never deleted — so once
  // the table passed the scan limit, every row in the window was long since
  // answered, the query returned null forever, and every new head's check waited
  // out its seventy-five minutes and failed with nothing able to score anything
  // again. The branch that deleted the workflow's `paths:` filter is the branch
  // that made it reachable: a request is now filed for every pull-request head.
  //
  // Found by the box's audit.
  it("serves a request filed after the scan limit has already been passed", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      // A full window of old requests, every one of them answered.
      for (let i = 0; i < EVALS_REQUEST_SCAN_LIMIT; i += 1) {
        const sha = `old${i}`;
        await ctx.db.insert("dtsEvents", {
          at: i + 1,
          kind: EVALS_REQUEST,
          key: `${REPO}@${sha}`,
          data: {
            repo: REPO, sha, baseSha: "f5c1fb9", pr: 1, runId: i + 1,
            paths: ["model-of-tom/**"], changed: [], prBody: null,
            unaffected: false, requestedAt: PROTOCOL_ERA + i + 1,
          },
        });
        await ctx.db.insert("dtsEvents", {
          at: i + 1,
          kind: EVALS_RUN,
          key: `${REPO}@${sha}`,
          data: {
            repo: REPO, sha, regressions: 0,
            answersRequestAt: PROTOCOL_ERA + i + 1,
            answersBaseSha: "f5c1fb9",
            answersChanged: [],
            answersPrBody: null,
          },
        });
      }
    });
    // Nothing unanswered yet, which is the honest answer at this point.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
    // The next head. Under the old read it was outside the window and invisible.
    await file(t, EVALS_REQUEST_SCAN_LIMIT + 1, "newhead", { runId: 10_000, pr: 173 });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "newhead",
      supersededBy: null,
    });
  }, 30_000);

  // And inside the window the order is unchanged: still oldest-first, so the
  // reverse() did not turn the queue into a stack.
  it("still hands out the oldest unanswered request in the window", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100 });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    await file(t, 3, "ccccccc", { runId: 300 });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
    });
  });

  // THE RACE BETWEEN THE QUEUE'S GET AND THE BOX'S POST. The box reads a
  // superseded request and posts its answer seconds later; if the sha becomes
  // the live head again in between, the row lands with a WRITE TIME after the
  // replacement request. Dated by the clock, that stale supersession would be
  // accepted and the live head failed until yet another re-run — so the row
  // carries the `requestedAt` of the request it actually answered, and the
  // match is exact. Found by the box's audit.
  it("refuses a superseded row that answers a request already replaced", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100 });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    // The box takes A's request, which was filed at 1.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa", requestedAt: PROTOCOL_ERA + 1, supersededBy: "bbbbbbb",
    });
    // A force-push puts A back at the head BEFORE that answer is posted.
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "f5c1fb9", pr: 173, runId: 300, paths: ["model-of-tom/**"],
    });
    // Now the in-flight answer lands. Its write time is LATER than the new
    // request's, so a clock would accept it; the question it names is not.
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now() + 60_000,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: { repo: REPO, sha: "aaaaaaa", superseded: true, supersededBy: "bbbbbbb", answersRequestAt: PROTOCOL_ERA + 1 },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: null });
    // A is the head and is still servable, which is the point.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb", supersededBy: "aaaaaaa",
    });
  });

  // A request filed before the field existed has no place in the push order.
  // It supersedes nothing and nothing supersedes it, in both directions.
  it("never supersedes with or against a request carrying no run id", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: null });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
    await answer(t, "aaaaaaa");
    const t2 = convexTest({ schema, modules });
    await file(t2, 1, "aaaaaaa", { runId: 100 });
    await file(t2, 2, "bbbbbbb", { runId: null });
    expect(await t2.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "aaaaaaa",
      supersededBy: null,
    });
  });

  it("returns a current catastrophic head, suppresses it as a base, and serves a re-file", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "head000");
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 2,
        kind: EVALS_RUN,
        key: `${REPO}@head000`,
        data: {
          repo: REPO,
          sha: "head000",
          error: true,
          reason: "runner failed: Not logged in",
          regressions: null,
          answersRequestAt: PROTOCOL_ERA + 1,
        },
      });
      await ctx.db.insert("dtsEvents", {
        at: 2,
        kind: EVALS_RUN,
        key: `${REPO}@base000`,
        data: { repo: REPO, sha: "base000", error: "legacy runner failed", regressions: null },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "head000", baseSha: "base000" }))
      .toMatchObject({ run: { error: true, reason: "runner failed: Not logged in" }, base: null });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "head000", baseSha: "base000", pr: 173, runId: 300, paths: ["model-of-tom/**"],
    });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({ sha: "head000" });
    // The worker's --force branch posts a fresh measurement over this key. The
    // clean row must replace the catastrophic answer for all subsequent reads.
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now() + 1,
        kind: EVALS_RUN,
        key: `${REPO}@head000`,
        data: {
          repo: REPO, sha: "head000", regressions: 0, goldenCoverage: true, pass: 29, items: 29,
          answersRequestAt: (await ctx.db
            .query("dtsEvents")
            .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@head000`))
            .first())!.data.requestedAt,
          answersBaseSha: "base000",
          answersChanged: null,
          answersPrBody: null,
        },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "head000" }))
      .toMatchObject({ run: { regressions: 0, goldenCoverage: true, pass: 29, items: 29 } });
  });
});

// THE DEPLOY OF PROTOCOL 2, which is the case the box's audit refused the first
// cut of this branch over.
//
// A row written before this contract carries no `answersRequestAt`, so
// answeredRun cannot see it and reads its sha as unanswered. On the deploy that
// is EVERY sha the check ever asked about that is still inside the window: each
// would be handed out for a full run, one per pass, ahead of every live head.
// The cutoff refuses the lot without a model call, and the drain empties the
// standing queue in one command.
describe("a request older than the evals protocol", () => {
  const REPO = "tom.quest";

  /** `requestedAt` is what the cutoff reads; `at` is only the order. */
  const file = (
    t: TestConvex<typeof schema>,
    at: number,
    sha: string,
    requestedAt: number,
    over: Record<string, unknown> = {},
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at,
        kind: EVALS_REQUEST,
        key: `${REPO}@${sha}`,
        data: {
          repo: REPO,
          sha,
          baseSha: "f5c1fb9",
          pr: 173,
          runId: null,
          paths: ["model-of-tom/**"],
          changed: ["model-of-tom/intent.md"],
          prBody: null,
          unaffected: false,
          requestedAt,
          ...over,
        },
      });
    });

  const runsFor = (t: TestConvex<typeof schema>, sha: string) =>
    t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_RUN).eq("key", `${REPO}@${sha}`))
        .collect(),
    );

  it("hands out a pre-protocol request marked for a one-POST answer, ahead of no live head", async () => {
    const t = convexTest({ schema, modules });
    // The legacy shape exactly: no run id, and a scored row that named no
    // request because rows did not carry one yet.
    await file(t, 1, "legacy0", PROTOCOL_ERA - DAY);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 2,
        kind: EVALS_RUN,
        key: `${REPO}@legacy0`,
        data: { repo: REPO, sha: "legacy0", regressions: 0, pass: 29, items: 29 },
      });
    });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "legacy0",
      supersededBy: "protocol-2",
    });
  });

  // The cutoff is the DATE, never the missing run id. WikiTom's Action sends
  // none until its copy of the workflow is re-installed, and a request of its
  // filed today is a live head.
  it("serves a request filed under the protocol, run id or no run id", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "wikitom", PROTOCOL_ERA + 1_000);
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "wikitom",
      supersededBy: null,
    });
    const t2 = convexTest({ schema, modules });
    await file(t2, 1, "livehead", PROTOCOL_ERA + 1_000, { runId: 900 });
    expect(await t2.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "livehead",
      supersededBy: null,
    });
  });

  // ONE COMMAND EMPTIES THE QUEUE. Without it the same answers cost
  // twenty-five per five-minute pass, and a live head waits behind them.
  it("drains every standing pre-protocol request, in pages and idempotently", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "legacy0", PROTOCOL_ERA - DAY);
    await file(t, 2, "legacy1", PROTOCOL_ERA - DAY);
    // Already answered by the box on an earlier pass: counted, never written
    // over.
    await file(t, 3, "legacy2", PROTOCOL_ERA - DAY);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 4,
        kind: EVALS_RUN,
        key: `${REPO}@legacy2`,
        data: {
          repo: REPO, sha: "legacy2", superseded: true, supersededBy: "protocol-2",
          regressions: null, answersRequestAt: PROTOCOL_ERA - DAY,
        },
      });
    });
    // A live head, which the walk must not touch.
    await file(t, 5, "livehead", PROTOCOL_ERA + 1_000, { runId: 900 });

    const first = await t.mutation(internal.ttsEvals.internalSupersedeLegacyEvalsRequests, {
      pageSize: 2,
    });
    expect(first).toMatchObject({ done: false, page: { scanned: 2, superseded: 2, answered: 0 } });
    expect(first.continueCursor).not.toBeNull();
    const second = await t.mutation(internal.ttsEvals.internalSupersedeLegacyEvalsRequests, {
      pageSize: 100,
      cursor: first.continueCursor,
      totals: first.totals,
    });
    expect(second).toMatchObject({
      done: true,
      page: { scanned: 2, superseded: 0, answered: 1 },
      totals: { scanned: 4, superseded: 2, answered: 1 },
    });

    // The row the drain writes is the row the box writes: it denies, and it
    // names the request it answered.
    const [row] = await runsFor(t, "legacy0");
    expect(row.data).toMatchObject({
      repo: REPO,
      sha: "legacy0",
      superseded: true,
      supersededBy: "protocol-2",
      regressions: null,
      goldenCoverage: null,
      answersRequestAt: PROTOCOL_ERA - DAY,
    });
    expect(String((row.data as { error: string }).error))
      .toBe("filed before evals protocol 2; re-run this check at the head of the branch");

    // The queue is empty of legacy requests and the live head is what is
    // served — which is the whole point of the walk.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "livehead",
      supersededBy: null,
    });

    // IDEMPOTENT: a second full walk writes nothing and counts what stands.
    const again = await t.mutation(internal.ttsEvals.internalSupersedeLegacyEvalsRequests, {
      pageSize: 100,
    });
    expect(again).toMatchObject({ done: true, totals: { scanned: 4, superseded: 0, answered: 3 } });
    expect(await runsFor(t, "legacy0")).toHaveLength(1);
    expect(await runsFor(t, "livehead")).toHaveLength(0);
  });
});
