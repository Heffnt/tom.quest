import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import {
  EVALS_REQUEST,
  EVALS_REQUEST_SCAN_LIMIT,
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
          requestedAt: at,
          ...over,
        },
      });
    });

  const answer = (t: TestConvex<typeof schema>, sha: string) =>
    t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 99,
        kind: EVALS_RUN,
        key: `${REPO}@${sha}`,
        data: { repo: REPO, sha, superseded: true },
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

  // ONLY UPWARD, for the same reason headShaByPullRequest compares with a
  // strict `>`: re-running an OLD sha's check keeps that run's id, and must
  // never make that sha look like the newest push.
  it("never lowers a request's run id", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 500 });
    await file(t, 2, "bbbbbbb", { runId: 200 });
    await t.mutation(internal.ttsEvals.internalRequestEvals, {
      repo: REPO, sha: "aaaaaaa", baseSha: "f5c1fb9", pr: 173, runId: 100, paths: ["model-of-tom/**"],
    });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_REQUEST).eq("key", `${REPO}@aaaaaaa`))
        .first(),
    );
    expect((row!.data as { runId: number }).runId).toBe(500);
    // A is still the head, so B is what is superseded. Had 100 been written, it
    // would be the other way round.
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toMatchObject({
      sha: "bbbbbbb",
      supersededBy: "aaaaaaa",
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
        data: { repo: REPO, sha: "aaaaaaa", unaffected: true, regressions: 0 },
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

  // A scored row is current only for the request facts it recorded.
  it("requires a scored row to answer the base and coverage inputs it recorded", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa", { runId: 100, prBody: "evals: no-item wording only" });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 50,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: {
          repo: REPO, sha: "aaaaaaa", regressions: 0, pass: 29, items: 29,
          answersRequestAt: 1,
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

  it("accepts a scored row from before the box recorded request timestamps", async () => {
    const t = convexTest({ schema, modules });
    await file(t, 1, "aaaaaaa");
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: 50,
        kind: EVALS_RUN,
        key: `${REPO}@aaaaaaa`,
        data: { repo: REPO, sha: "aaaaaaa", regressions: 0, pass: 29, items: 29 },
      });
    });
    expect(await t.query(internal.ttsEvals.internalEvalsRun, { repo: REPO, sha: "aaaaaaa" }))
      .toMatchObject({ run: { regressions: 0, pass: 29, items: 29 } });
    expect(await t.query(internal.ttsEvals.internalOldestEvalsRequest, {})).toBe(null);
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

  // A prior no-run result never answers a re-filed request. Its predecessor
  // trusted the client's claim; the next answer must be recomputed by the box.
  it("queues a re-filed unaffected claim for the box", async () => {
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
            unaffected: false, requestedAt: i + 1,
          },
        });
        await ctx.db.insert("dtsEvents", {
          at: i + 1,
          kind: EVALS_RUN,
          key: `${REPO}@${sha}`,
          data: {
            repo: REPO, sha, regressions: 0,
            answersRequestAt: i + 1,
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
      sha: "aaaaaaa", requestedAt: 1, supersededBy: "bbbbbbb",
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
        data: { repo: REPO, sha: "aaaaaaa", superseded: true, supersededBy: "bbbbbbb", answersRequestAt: 1 },
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
        data: { repo: REPO, sha: "head000", error: true, reason: "runner failed: Not logged in", regressions: null },
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
