import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import {
  AREA_REVIEWED,
  INSTRUCTIONS_LOADED,
  LEARNING_REVERTED,
  LEARNING_REVERT_FAILED,
  SURFACED_THRESHOLD,
  WEEKLY_FAILURE,
  WEEKLY_RUN,
  WEEK_MS,
  PRELUDE_DELIVERY,
  areaPageState,
  frontmatterDate,
  gatherWeeklyFacts,
} from "./ttsWeekly";
import { LEARNING_CHANGE } from "./ttsDigest";
import { INTEGRATION_SOURCE, integrationStatement } from "./ttsIntegrations";
import { JOB_FAILED, JOB_RECOVERED } from "./ttsJobs";
import { NIGHTLY_FAILURE } from "./ttsNightly";
import { NEEDS_TOM } from "./ttsSlack";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const KEY = "s3cret";
const DAY = 86_400_000;
const HOUR = 3_600_000;

function get(t: ReturnType<typeof convexTest>, path: string, key = KEY) {
  return t.fetch(path, { method: "GET", headers: { "X-TTS-Key": key } });
}

// Rows are read on _creationTime for the captures fact, and convex-test
// stamps the real clock, so the window ends a moment after the seeding.
async function gather(t: ReturnType<typeof convexTest>, until = Date.now() + 1000) {
  return await t.run(async (ctx) => await gatherWeeklyFacts(ctx, { since: until - WEEK_MS, until }));
}

async function publishSessionPrelude(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current", commit: "weekly-session-test", committedAt: 1, pushed: true,
        operate: "operate layer", write: "write layer", know: "know layer",
        headers: [{ layers: ["operate", "write"], header: "MODEL-OF-TOM FILES (test)" }],
    });
  });
}

async function todo(
  ctx: MutationCtx,
  fields: Partial<{
    statement: string;
    status: "active" | "waiting" | "archived" | "done";
    readiness: "unprepared" | "prepared";
    kind: "task" | "goal";
    batchId: Id<"batches">;
    source: string;
    doneAt: number;
    createdAt: number;
    updatedAt: number;
  }> = {},
): Promise<Id<"dtsTodos">> {
  const now = Date.now();
  return await ctx.db.insert("dtsTodos", {
    statement: fields.statement ?? "a todo",
    status: fields.status ?? "active",
    readiness: fields.readiness ?? "unprepared",
    timingClass: "whenever",
    source: fields.source ?? "tom",
    kind: fields.kind,
    batchId: fields.batchId,
    doneAt: fields.doneAt,
    createdAt: fields.createdAt ?? now,
    updatedAt: fields.updatedAt ?? now,
  });
}

async function event(
  ctx: MutationCtx,
  kind: string,
  at: number,
  extra: { todoId?: Id<"dtsTodos">; key?: string; data?: unknown } = {},
) {
  return await ctx.db.insert("dtsEvents", { at, kind, ...extra });
}

const AREA_BODY = (reviewed: string, window = "30") =>
  `---\nupdated: 2026-09-06\nreviewed: ${reviewed}\nwindow_days: ${window}\n---\n\n## Current state\n\n- x`;

describe("gatherWeeklyFacts", () => {
  it("is empty in every fact when the week holds nothing", async () => {
    const t = convexTest({ schema, modules });
    const f = await gather(t);
    expect(f.until - f.since).toBe(WEEK_MS);
    expect(f.completions).toEqual([]);
    expect(f.captures).toEqual([]);
    expect(f.dateOutcomes).toEqual([]);
    expect(f.surfacedUntouched).toEqual([]);
    expect(f.goalsWithoutOpenTask).toEqual([]);
    expect(f.goalsNotEvaluated).toEqual([]);
    // The known pollers are listed even with nothing recorded: "running" is
    // the state of an integration nothing has said anything about.
    expect(f.integrations).toEqual([
      { name: "gmail", state: "running", since: null, detail: null },
      { name: "canvas", state: "running", since: null, detail: null },
      { name: "outlook", state: "running", since: null, detail: null },
    ]);
    expect(f.areaPages).toEqual([]);
    expect(f.modelOfTom).toEqual({ commit: null, syncedAt: null, layers: [], files: [], totalBytes: 0 });
    expect(f.learning).toEqual({ changes: 0, reverted: 0, revertFailed: 0, lines: [] });
    expect(f.preludes).toEqual({ sessions: 0, current: 0, stale: [], missing: [] });
    expect(f.instructionsLoaded).toEqual({
      daysReported: 0, sessions: 0, files: [], missingWikiTom: 0,
      missingWikiTomSessions: [], missingProjectAgents: [],
    });
    expect(f.evals).toEqual({ runs: 0, clean: 0, regressions: [] });
    expect(f.jobFailures).toEqual([]);
    expect(f.threads).toEqual([]);
    expect(f.readiness).toEqual({ prepared: 0, unprepared: 0 });
  });

  it("sums prelude delivery rows across the week", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      await event(ctx, PRELUDE_DELIVERY, now - DAY, {
        data: { day: "2026-09-08", current: 3, stale: [{ id: "s1", title: "weekly agenda", had: "7fc21ab4c1de", behindDays: 2 }], missing: [] },
      });
      await event(ctx, PRELUDE_DELIVERY, now - 2 * DAY, {
        data: { day: "2026-09-07", current: 2, stale: [], missing: [{ id: "s2", title: "adhoc" }] },
      });
    });
    const f = await gather(t, now + 1000);
    expect(f.preludes).toMatchObject({ sessions: 7, current: 5 });
    expect(f.preludes.stale).toEqual([expect.objectContaining({ id: "s1", behindDays: 2 })]);
    expect(f.preludes.missing).toEqual([expect.objectContaining({ id: "s2" })]);
  });

  it("reports missing instruction days and sessions that loaded no WikiTom files", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      await event(ctx, INSTRUCTIONS_LOADED, now - DAY, {
        data: {
          day: "2026-09-08", sessions: 7,
          files: [{ path: "C:/Users/heffn/Desktop/tom.quest/AGENTS.md", sessions: 7 }],
          missingWikiTom: ["s-missing"],
          missingProjectAgents: [{ session: "s-agents", cwd: "C:/Users/heffn/Desktop/tom.quest" }],
        },
      });
    });
    const f = await gather(t, now + 1000);
    expect(f.instructionsLoaded.daysReported).toBe(1);
    expect(f.instructionsLoaded.missingWikiTomSessions).toEqual([{ day: "2026-09-08", session: "s-missing" }]);
    expect(f.instructionsLoaded.missingProjectAgents).toEqual([{ day: "2026-09-08", session: "s-agents", cwd: "C:/Users/heffn/Desktop/tom.quest" }]);
  });

  it("finds every fact kind when the week holds one of each", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    const seeded = await t.run(async (ctx) => {
      const batch = await ctx.db.insert("batches", {
        statement: "the paper",
        status: "active",
        createdAt: now - 20 * DAY,
        updatedAt: now - 20 * DAY,
      });
      const emptyBatch = await ctx.db.insert("batches", {
        statement: "the lease",
        status: "active",
        createdAt: now - 20 * DAY,
        updatedAt: now - 20 * DAY,
      });
      // 1. a completion inside the week, and one from before it
      const done = await todo(ctx, {
        statement: "file the form",
        status: "done",
        kind: "task",
        batchId: batch,
        doneAt: now - 2 * DAY,
        updatedAt: now - 2 * DAY,
      });
      await todo(ctx, {
        statement: "old completion",
        status: "done",
        doneAt: now - 10 * DAY,
        updatedAt: now - 10 * DAY,
      });
      // 2. captures by source (every row inserted here is created this week)
      await todo(ctx, { statement: "from mail", source: "email" });
      await todo(ctx, { statement: "from slack", source: "slack-capture" });
      // 3. a date outcome
      const dated = await todo(ctx, { statement: "the deadline", readiness: "prepared" });
      await event(ctx, "date-outcome", now - 3 * DAY, {
        todoId: dated,
        data: { outcome: "missed", newDueAt: now - 3 * DAY, note: "rolled", rollover: true },
      });
      // 4. surfaced three times and untouched; surfaced three times and touched
      const ignored = await todo(ctx, { statement: "the ignored one" });
      const touched = await todo(ctx, { statement: "the touched one" });
      for (let i = 0; i < SURFACED_THRESHOLD; i++) {
        await event(ctx, "surfaced", now - (5 - i) * DAY, { todoId: ignored, data: { via: "digest" } });
        await event(ctx, "surfaced", now - (5 - i) * DAY, { todoId: touched, data: { via: "digest" } });
      }
      await event(ctx, "status-changed", now - DAY, { todoId: touched, data: { to: "done" } });
      // 5. a goal whose batch has an open task, and one whose batch has none
      const goalWithTask = await todo(ctx, { statement: "paper submitted", kind: "goal", batchId: batch });
      await todo(ctx, { statement: "write section 3", kind: "task", batchId: batch });
      const goalAlone = await todo(ctx, { statement: "lease signed", kind: "goal", batchId: emptyBatch });
      // 6. evaluated this week vs not for eight days
      await event(ctx, "session-outcome", now - DAY, { todoId: goalWithTask, data: { outcome: "completed" } });
      await event(ctx, "session-created", now - 8 * DAY, { todoId: goalAlone, data: {} });
      // 7. integrations: outlook declined by ruling; canvas waiting on its token
      const declined = await todo(ctx, {
        statement: integrationStatement("outlook"),
        status: "archived",
        source: INTEGRATION_SOURCE,
      });
      await ctx.db.insert("dtsRulings", {
        subjectType: "life",
        todoId: declined,
        verdict: "archive",
        sentence: "the WPI mailbox is read by hand",
        ruledAt: now - 4 * DAY,
      });
      await event(ctx, JOB_FAILED, now - 6 * DAY, {
        key: "poll-canvas:canvas-auth",
        data: { job: "poll-canvas", error: "Canvas said 401" },
      });
      // a recovered gmail failure is not a waiting credential
      await event(ctx, JOB_FAILED, now - 6 * DAY, {
        key: "poll-gmail:gmail-auth",
        data: { job: "poll-gmail", error: "token expired" },
      });
      await event(ctx, JOB_RECOVERED, now - 5 * DAY, {
        key: "poll-gmail:gmail-auth",
        data: { job: "poll-gmail" },
      });
      // 8, 9. the posted files: one area page past its window, one inside it
      // (by an area-reviewed event newer than the post), one never reviewed
      const sourceFiles = [
        ["model-of-tom/writing.md", "# Writing\n\nshort.", 101],
        ["model-of-tom/areas/research.md", AREA_BODY("2026-01-01"), undefined],
        ["model-of-tom/areas/admin.md", AREA_BODY("2026-01-01", "60"), 303],
        ["model-of-tom/areas/money.md", AREA_BODY(""), 404],
      ] as const;
      for (const [path, body, bytes] of sourceFiles) {
        await ctx.db.insert("ttsSkills", {
          name: path.slice("model-of-tom/".length).replace(/\.md$/, ""),
          body,
          sourcePath: path,
          bytes,
          commit: "abc1234",
          syncedAt: now - DAY,
        });
      }
      await ctx.db.insert("modelOfTomPublication", {
        key: "current", commit: "publication-commit", committedAt: now - 2 * DAY, pushed: true,
        operate: "operate", write: "write layer", know: "know layer",
        headers: [],
      });
      await event(ctx, AREA_REVIEWED, now - HOUR, {
        key: "model-of-tom/areas/admin.md",
        data: { path: "model-of-tom/areas/admin.md", reviewedOn: new Date(now).toISOString().slice(0, 10) },
      });
      // 10. learning
      await event(ctx, LEARNING_CHANGE, now - 3 * DAY, {
        data: { id: "lc1", file: "model-of-tom/areas/research.md", before: "", after: "- a line", evidence: "session x" },
      });
      await event(ctx, LEARNING_REVERTED, now - 2 * DAY, { data: { id: "lc1" } });
      await event(ctx, LEARNING_REVERT_FAILED, now - DAY, { data: { id: "lc0", error: "base hash moved" } });
      // 11. job failures by job (the canvas one above counts here too)
      await event(ctx, NIGHTLY_FAILURE, now - 2 * DAY, { data: { step: "push", error: "refused" } });
      await event(ctx, WEEKLY_FAILURE, now - 7 * DAY + HOUR, { data: { step: "checkout", error: "absent" } });
      // 12. a thread that needed Tom, answered in 90 minutes; one unanswered
      const asked = await todo(ctx, { statement: "reply to the dean" });
      await event(ctx, NEEDS_TOM, now - 2 * DAY, { todoId: asked, key: "gmail:message:1", data: {} });
      await event(ctx, "slack-event", now - 2 * DAY + 90 * 60_000, {
        todoId: asked,
        key: "Ev1",
        data: { text: "done", outcome: "done" },
      });
      const unanswered = await todo(ctx, { statement: "sign the form" });
      await event(ctx, NEEDS_TOM, now - DAY, { todoId: unanswered, key: "gmail:message:2", data: {} });
      return { done, dated, ignored, goalAlone, asked, unanswered };
    });

    const f = await gather(t);

    expect(f.completions).toEqual([
      { id: seeded.done, statement: "file the form", kind: "task", batch: "the paper", doneAt: expect.any(Number) },
    ]);
    expect(f.captures.map((c) => [c.source, c.count])).toEqual([
      ["email", 1],
      ["integration", 1],
      ["slack-capture", 1],
      ["tom", 10],
    ]);
    expect(f.dateOutcomes).toEqual([
      {
        todoId: seeded.dated,
        statement: "the deadline",
        outcome: "missed",
        at: expect.any(Number),
        newDueAt: expect.any(Number),
        note: "rolled",
      },
    ]);
    expect(f.surfacedUntouched).toEqual([
      { id: seeded.ignored, statement: "the ignored one", surfaced: 3, firstAt: expect.any(Number) },
    ]);
    expect(f.goalsWithoutOpenTask).toEqual([
      { id: seeded.goalAlone, statement: "lease signed", batch: "the lease" },
    ]);
    expect(f.goalsNotEvaluated).toEqual([
      { id: seeded.goalAlone, statement: "lease signed", batch: "the lease", lastEvaluatedAt: expect.any(Number) },
    ]);
    expect(f.integrations).toEqual([
      { name: "gmail", state: "running", since: null, detail: null },
      { name: "canvas", state: "waiting-on-credential", since: expect.any(Number), detail: "Canvas said 401" },
      { name: "outlook", state: "declined", since: expect.any(Number), detail: "the WPI mailbox is read by hand" },
    ]);
    expect(f.areaPages).toEqual([
      expect.objectContaining({ path: "model-of-tom/areas/admin.md", windowDays: 60, reviewedAgeDays: 0, pastWindow: false }),
      expect.objectContaining({ path: "model-of-tom/areas/money.md", reviewedOn: null, reviewedAgeDays: null, pastWindow: true }),
      expect.objectContaining({ path: "model-of-tom/areas/research.md", reviewedOn: "2026-01-01", windowDays: 30, pastWindow: true }),
    ]);
    expect(f.modelOfTom.commit).toBe("publication-commit");
    expect(f.modelOfTom.syncedAt).toBe(now - 2 * DAY);
    expect(f.modelOfTom.layers).toEqual([
      { name: "operate", bytes: 7 },
      { name: "write", bytes: 11 },
      { name: "know", bytes: 10 },
    ]);
    expect(f.modelOfTom.files.map((x) => x.path)).toEqual([
      "model-of-tom/areas/admin.md",
      "model-of-tom/areas/money.md",
      "model-of-tom/areas/research.md",
      "model-of-tom/writing.md",
    ]);
    expect(f.modelOfTom.totalBytes).toBe(f.modelOfTom.files.reduce((n, x) => n + x.bytes, 0));
    expect(f.modelOfTom.files.find((x) => x.path.endsWith("writing.md"))?.bytes).toBe(101);
    expect(f.modelOfTom.files.find((x) => x.path.endsWith("admin.md"))?.bytes).toBe(303);
    expect(f.modelOfTom.files.find((x) => x.path.endsWith("research.md"))?.bytes).toBe(
      new TextEncoder().encode(AREA_BODY("2026-01-01")).length,
    );
    expect(f.learning.changes).toBe(1);
    expect(f.learning.reverted).toBe(1);
    expect(f.learning.revertFailed).toBe(1);
    expect(f.learning.lines.map((l) => l.kind)).toEqual([LEARNING_CHANGE, LEARNING_REVERTED, LEARNING_REVERT_FAILED]);
    expect(f.learning.lines[2].error).toBe("base hash moved");
    expect(f.jobFailures.map((j) => [j.job, j.count])).toEqual([
      ["nightly", 1],
      ["poll-canvas", 1],
      ["poll-gmail", 1],
      ["weekly", 1],
    ]);
    expect(f.threads).toEqual([
      { todoId: seeded.asked, statement: "reply to the dean", askedAt: expect.any(Number), repliedAt: expect.any(Number), replyMs: 90 * 60_000 },
      { todoId: seeded.unanswered, statement: "sign the form", askedAt: expect.any(Number), repliedAt: null, replyMs: null },
    ]);
    // prepared: the dated one; unprepared: every other active row
    expect(f.readiness).toEqual({ prepared: 1, unprepared: 9 });
  });

  // "Untouched" is about Tom's hand. The system writes rows on a todo all
  // week — the preparer's "prepared", the planner's batch rows, the
  // rollover's own date outcome, a Canvas edit — and none of them is Tom
  // doing something with the item.
  it("still lists a surfaced item the system touched, and drops one Tom touched", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    const seeded = await t.run(async (ctx) => {
      const make = async (statement: string) => {
        const id = await todo(ctx, { statement });
        for (let i = 0; i < SURFACED_THRESHOLD; i++) {
          await event(ctx, "surfaced", now - (5 - i) * DAY, { todoId: id, data: { via: "digest" } });
        }
        return id;
      };
      const prepared = await make("prepared by the worker");
      await event(ctx, "prepared", now - DAY, { todoId: prepared, data: { by: "prepare-item" } });
      const rolled = await make("rolled over");
      await event(ctx, "date-outcome", now - DAY, {
        todoId: rolled,
        data: { outcome: "missed", newDueAt: now - DAY, note: "passed", rollover: true },
      });
      const synced = await make("moved by canvas");
      await event(ctx, "updated", now - DAY, { todoId: synced, data: { fields: ["dueAt"], via: "canvas-sync" } });
      const batched = await make("put in a batch");
      await event(ctx, "batch-formed", now - DAY, { todoId: batched, data: {} });
      // Tom's hand, each its own kind
      const noted = await make("noted by tom");
      await event(ctx, "tom-note", now - DAY, { todoId: noted, data: { text: "later" } });
      const resolved = await make("date resolved by tom");
      await event(ctx, "date-outcome", now - DAY, { todoId: resolved, data: { outcome: "renegotiated", newDueAt: now + DAY } });
      const edited = await make("edited by tom");
      await event(ctx, "updated", now - DAY, { todoId: edited, data: { fields: ["statement"] } });
      const ruled = await make("ruled on by tom");
      await event(ctx, "ruling", now - DAY, { todoId: ruled, data: { verdict: "archive" } });
      return { prepared, rolled, synced, batched };
    });
    const f = await gather(t);
    expect(f.surfacedUntouched.map((s) => s.id).sort()).toEqual(
      [seeded.prepared, seeded.rolled, seeded.synced, seeded.batched].sort(),
    );
  });

  // A goal is worked through its batch: the session is opened ON the batch
  // (no todoId), so the evaluation is the batch's row, keyed on the batch.
  it("counts a session on the goal's batch as an evaluation of the goal", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    const seeded = await t.run(async (ctx) => {
      const mk = async (statement: string) =>
        await ctx.db.insert("batches", { statement, status: "active", createdAt: now - 20 * DAY, updatedAt: now - 20 * DAY });
      const worked = await mk("the paper");
      const stale = await mk("the lease");
      const never = await mk("the move");
      const workedGoal = await todo(ctx, { statement: "paper submitted", kind: "goal", batchId: worked });
      const staleGoal = await todo(ctx, { statement: "lease signed", kind: "goal", batchId: stale });
      const neverGoal = await todo(ctx, { statement: "moved in", kind: "goal", batchId: never });
      // this week, on the batch (the row the one row-builder writes)
      await event(ctx, "session-created", now - 2 * DAY, {
        key: worked,
        data: { sessionId: "s1", title: "work the paper", kind: "focus-item", mode: "autonomous", repos: [], batchId: worked },
      });
      // nine days ago, on the batch: not this week, but a date to report
      await event(ctx, "session-outcome", now - 9 * DAY, {
        key: stale,
        data: { sessionId: "s0", title: "the lease", outcome: "completed", batchId: stale },
      });
      return { workedGoal, staleGoal, neverGoal };
    });
    const f = await gather(t);
    expect(f.goalsNotEvaluated).toEqual([
      { id: seeded.staleGoal, statement: "lease signed", batch: "the lease", lastEvaluatedAt: now - 9 * DAY },
      { id: seeded.neverGoal, statement: "moved in", batch: "the move", lastEvaluatedAt: null },
    ]);
  });

  // NO CAP IN THE GATHER: a standing credential failure is read on the job's
  // own key prefix, however many other failure rows came after it.
  it("finds a standing credential failure behind hundreds of newer failure rows", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      await event(ctx, JOB_FAILED, now - 40 * DAY, {
        key: "poll-canvas:canvas-auth",
        data: { job: "poll-canvas", error: "Canvas said 401" },
      });
      // A non-credential canvas condition, standing, is not "waiting on Tom".
      await event(ctx, JOB_FAILED, now - 2 * DAY, {
        key: "poll-canvas:untriaged:77",
        data: { job: "poll-canvas", error: "no verdict for 77" },
      });
      // A gmail credential failure that recovered, then 300 keyed and 300
      // unkeyed rows of other jobs, all newer than the canvas one.
      await event(ctx, JOB_FAILED, now - 30 * DAY, { key: "poll-gmail:gmail-auth", data: { job: "poll-gmail", error: "expired" } });
      await event(ctx, JOB_RECOVERED, now - 29 * DAY, { key: "poll-gmail:gmail-auth", data: { job: "poll-gmail" } });
      for (let i = 0; i < 300; i++) {
        await event(ctx, JOB_FAILED, now - 20 * DAY + i * 60_000, {
          key: `poll-gmail:untriaged:${i}`,
          data: { job: "poll-gmail", error: `no verdict for ${i}` },
        });
        await event(ctx, JOB_FAILED, now - 10 * DAY + i * 60_000, { data: { job: "poll-outlook", error: "timeout" } });
      }
    });
    const f = await gather(t);
    expect(f.integrations).toEqual([
      { name: "gmail", state: "running", since: null, detail: null },
      { name: "canvas", state: "waiting-on-credential", since: now - 40 * DAY, detail: "Canvas said 401" },
      { name: "outlook", state: "running", since: null, detail: null },
    ]);
  });

  it("keeps last week's rows out of this week's window", async () => {
    const t = convexTest({ schema, modules });
    const now = Date.now();
    await t.run(async (ctx) => {
      const id = await todo(ctx, { statement: "old" });
      await event(ctx, "date-outcome", now - 8 * DAY, { todoId: id, data: { outcome: "done" } });
      await event(ctx, NEEDS_TOM, now - 8 * DAY, { todoId: id, key: "k", data: {} });
      await event(ctx, LEARNING_CHANGE, now - 8 * DAY, { data: { id: "x" } });
    });
    const f = await gather(t);
    expect(f.dateOutcomes).toEqual([]);
    expect(f.threads).toEqual([]);
    expect(f.learning.changes).toBe(0);
  });
});

describe("areaPageState", () => {
  const until = Date.parse("2026-09-11T08:00:00Z");

  it("reads the frontmatter the nightly job posted ahead of the sections", () => {
    expect(areaPageState("model-of-tom/areas/research.md", AREA_BODY("2026-09-01"), null, until)).toEqual({
      path: "model-of-tom/areas/research.md",
      updatedOn: "2026-09-06",
      reviewedOn: "2026-09-01",
      windowDays: 30,
      reviewedAgeDays: 10,
      pastWindow: false,
    });
  });

  it("is past the window when never reviewed, and past none without a window", () => {
    expect(areaPageState("p", AREA_BODY(""), null, until)).toMatchObject({
      reviewedOn: null,
      reviewedAgeDays: null,
      pastWindow: true,
    });
    expect(areaPageState("p", "## Current state\n\n- x", null, until)).toMatchObject({
      updatedOn: null,
      reviewedOn: null,
      windowDays: null,
      pastWindow: false,
    });
  });

  it("takes a newer area-reviewed event over the posted line, never an older one", () => {
    expect(areaPageState("p", AREA_BODY("2026-07-01"), "2026-09-10", until)).toMatchObject({
      reviewedOn: "2026-09-10",
      reviewedAgeDays: 1,
      pastWindow: false,
    });
    expect(areaPageState("p", AREA_BODY("2026-09-10"), "2026-07-01", until)).toMatchObject({
      reviewedOn: "2026-09-10",
    });
  });

  it("frontmatterDate accepts only a real YYYY-MM-DD", () => {
    expect(frontmatterDate("2026-09-11")).toBe("2026-09-11");
    expect(frontmatterDate(" 2026-09-11 ")).toBe("2026-09-11");
    expect(frontmatterDate("")).toBeNull();
    expect(frontmatterDate("yesterday")).toBeNull();
    expect(frontmatterDate(undefined)).toBeNull();
    // Date.parse takes Feb 30 as March 2; the round trip does not.
    expect(frontmatterDate("2026-02-30")).toBeNull();
    expect(frontmatterDate("2026-13-01")).toBeNull();
    expect(frontmatterDate("2028-02-29")).toBe("2028-02-29");
  });
});

describe("POST /tts/session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const post = (t: ReturnType<typeof convexTest>, body: unknown, key = KEY) =>
    t.fetch("/tts/session", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const weekly = {
    title: "Weekly 2026-09-11",
    kind: "weekly",
    day: "2026-09-11",
    agendaSubjects: ["k17abc", "k17def", "k17abc", " "],
    repos: [],
    model: "opus",
    initialPrompt: "# Weekly agenda — 2026-09-11\n\n## Facts\n\n- Completed: 0.",
  };

  it("opens the weekly session through the one row-builder, agenda as the opener, subjects on the row", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await publishSessionPrelude(t);
    const res = await post(t, weekly);
    expect(res.status).toBe(200);
    const { sessionId } = await res.json();
    const session = await t.run(async (ctx) => await ctx.db.get(sessionId));
    expect(session).toMatchObject({
      kind: "weekly",
      model: "opus",
      repos: [],
      repo: "none",
      status: "requested",
      agendaDay: "2026-09-11",
      // de-duplicated, blanks dropped: the ruling refusal checks membership
      agendaSubjects: ["k17abc", "k17def"],
    });
    const opener = await t.run(async (ctx) =>
      (await ctx.db.query("claudeInbound").collect()).find((r) => r.sessionId === sessionId),
    );
    expect(opener?.author).toBe("agent");
    expect(opener?.text).toContain("# Weekly agenda — 2026-09-11");
    // The prelude and the outcome footer wrap it like every other opener.
    expect(opener?.text).toContain("MODEL-OF-TOM FILES");
    expect(opener?.text).toContain("/tts/session-outcome");
  });

  // Every session on the box holds TTS_WORKER_KEY: this door opens the
  // weekly session and nothing else, once per day.
  it("refuses a second weekly session for the same day", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await publishSessionPrelude(t);
    expect((await post(t, weekly)).status).toBe(200);
    const again = await post(t, { ...weekly, title: "Weekly 2026-09-11 (mine)", initialPrompt: "my own prompt" });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toMatch(/already exists/);
    expect(await t.run(async (ctx) => (await ctx.db.query("claudeSessions").collect()).length)).toBe(1);
    // Another day is another weekly session.
    expect((await post(t, { ...weekly, day: "2026-09-18" })).status).toBe(200);
  });

  it("refuses the wrong key, any kind but weekly, a bad day, no subjects, an unknown repo, and an unknown model", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await publishSessionPrelude(t);
    expect((await post(t, weekly, "nope")).status).toBe(401);
    expect((await post(t, { ...weekly, kind: "adhoc" })).status).toBe(400);
    expect((await post(t, { ...weekly, kind: "gate" })).status).toBe(400);
    expect((await post(t, { ...weekly, day: "2026-02-30" })).status).toBe(400);
    expect((await post(t, { ...weekly, day: undefined })).status).toBe(400);
    expect((await post(t, { ...weekly, agendaSubjects: undefined })).status).toBe(400);
    expect((await post(t, { ...weekly, agendaSubjects: [1] })).status).toBe(400);
    expect((await post(t, { ...weekly, repos: ["elsewhere"] })).status).toBe(400);
    expect((await post(t, { ...weekly, model: "gpt-9" })).status).toBe(400);
    expect((await post(t, { ...weekly, initialPrompt: " " })).status).toBe(400);
    expect(await t.run(async (ctx) => (await ctx.db.query("claudeSessions").collect()).length)).toBe(0);
    expect((await post(t, { ...weekly, agendaSubjects: [] })).status).toBe(200);
  });
});

describe("POST /tts/area-reviewed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const post = (t: ReturnType<typeof convexTest>, body: unknown, key = KEY) =>
    t.fetch("/tts/area-reviewed", {
      method: "POST",
      headers: { "X-TTS-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("records one area-reviewed row keyed on the page, which the gather reads", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("ttsSkills", {
        name: "areas/research",
        body: AREA_BODY("2026-01-01"),
        sourcePath: "model-of-tom/areas/research.md",
        commit: "abc1234",
        syncedAt: Date.now() - DAY,
      });
    });
    const today = new Date().toISOString().slice(0, 10);
    const res = await post(t, { path: "model-of-tom/areas/research.md", reviewedOn: today });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", AREA_REVIEWED).eq("key", "model-of-tom/areas/research.md"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ path: "model-of-tom/areas/research.md", reviewedOn: today });
    // The row wrote nothing else: no todo, no page body.
    expect(await t.run(async (ctx) => (await ctx.db.query("dtsTodos").collect()).length)).toBe(0);
    const f = await gather(t);
    expect(f.areaPages[0]).toMatchObject({ reviewedOn: today, reviewedAgeDays: 0, pastWindow: false });
  });

  it("refuses the wrong key, a path outside areas/, and a non-date", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const ok = { path: "model-of-tom/areas/research.md", reviewedOn: "2026-09-11" };
    expect((await post(t, ok, "nope")).status).toBe(401);
    expect((await post(t, { ...ok, path: "model-of-tom/writing.md" })).status).toBe(400);
    expect((await post(t, { ...ok, path: "model-of-tom/areas/../writing.md" })).status).toBe(400);
    expect((await post(t, { ...ok, reviewedOn: "friday" })).status).toBe(400);
    expect((await post(t, ok)).status).toBe(200);
  });
});

describe("GET /tts/weekly-run", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers null before the job ran and the run's row after, keyed on the day", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await get(t, "/tts/weekly-run?day=2026-09-11", "nope")).status).toBe(401);
    expect((await get(t, "/tts/weekly-run")).status).toBe(400);
    expect((await get(t, "/tts/weekly-run?day=2026-02-30")).status).toBe(400);
    expect(await (await get(t, "/tts/weekly-run?day=2026-09-11")).json()).toEqual({ run: null });
    // The job's own post, through the event door, carries the day as the key.
    const posted = await t.fetch("/tts/event", {
      method: "POST",
      headers: { "X-TTS-Key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: WEEKLY_RUN,
        key: "2026-09-11",
        data: { day: "2026-09-11", file: "tts/weekly/2026-09-11.md", sessionId: "s1", failures: [{ step: "push", error: "x" }] },
      }),
    });
    expect(posted.status).toBe(200);
    const res = await get(t, "/tts/weekly-run?day=2026-09-11");
    expect(await res.json()).toEqual({
      run: { at: expect.any(Number), file: "tts/weekly/2026-09-11.md", sessionId: "s1", failures: 1 },
    });
    expect(await (await get(t, "/tts/weekly-run?day=2026-09-18")).json()).toEqual({ run: null });
  });
});

describe("GET /tts/weekly-input", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses the wrong key and a bad instant", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    expect((await get(t, "/tts/weekly-input", "nope")).status).toBe(401);
    expect((await get(t, "/tts/weekly-input?until=soon")).status).toBe(400);
  });

  it("answers the seven days ending at `until`", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    const until = Date.now() + 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomPublication", {
        key: "current", commit: "weekly-context-test", committedAt: 1, pushed: true,
        operate: "operate layer", write: "write layer", know: "know layer",
        headers: [{ layers: ["operate", "write"], header: "published map + operate + write" }],
      });
    });
    const res = await get(t, `/tts/weekly-input?until=${until}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.until).toBe(until);
    expect(body.since).toBe(until - WEEK_MS);
    expect(body.readiness).toEqual({ prepared: 0, unprepared: 0 });
    expect(body.integrations.length).toBe(3);
    // The door serves the ASSEMBLED CONTEXT now, not two whole layers (the
    // dynamic-context round): the stable prefix, then — the Friday gather
    // having no subject of its own — no expansion and the fetchable index. The
    // assembler's exact output is pinned in convex/ttsContext.test.ts.
    const [prefix, index] = body.writingStandard.split("\n\nMODEL-OF-TOM FETCHABLE (");
    expect(prefix).toBe("published map + operate + write\n\noperate layer\n\nwrite layer");
    expect(index).toContain("--layers know");
  });

  it("keeps a long credential history below one query's operation limit", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    const t = convexTest({ schema, modules });
    await publishSessionPrelude(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await event(ctx, JOB_FAILED, now - 40 * DAY, {
        key: "poll-canvas:canvas-auth",
        data: { job: "poll-canvas", error: "Canvas said 401" },
      });
      // These are distinct, newer Canvas conditions. The endpoint must retain
      // the old standing credential fact without one unbounded query.
      for (let i = 0; i < 300; i++) {
        await event(ctx, JOB_FAILED, now - 20 * DAY + i * 60_000, {
          key: `poll-canvas:untriaged:${i}`,
          data: { job: "poll-canvas", error: `no verdict for ${i}` },
        });
      }
    });
    const res = await get(t, `/tts/weekly-input?until=${now + 1000}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.integrations).toEqual([
      { name: "gmail", state: "running", since: null, detail: null },
      { name: "canvas", state: "waiting-on-credential", since: now - 40 * DAY, detail: "Canvas said 401" },
      { name: "outlook", state: "running", since: null, detail: null },
    ]);
  });
});
