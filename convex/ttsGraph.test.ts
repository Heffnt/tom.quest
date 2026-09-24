import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  MAX_NEEDS,
  TTS_CLOSED_VOCABULARY,
  buildDoneSet,
  frontier,
  isPrepared,
  isReady,
  isReadyForTom,
  normalizeReadiness,
  waitingReason,
  waitingReasonText,
} from "./ttsShared";

// The todo graph: todos wired by `needs`, and the ones whose needs are all
// done are "ready". Batches, which grouped todos into graphs, went with Tom's
// ruling of 2026-09-24 ("I dont want to have batches at all anymore"); `needs`
// and the ready rule stayed, and so did the worker pen that closes a todo.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

// ── The graph rules (convex/ttsShared.ts — the ONE home) ─────────────────────

describe("ttsShared graph rules", () => {
  const NOW = Date.UTC(2026, 8, 5, 12);
  const todo = (
    _id: string,
    status: Doc<"dtsTodos">["status"],
    needs?: string[],
    wakeAt?: number,
  ) => ({ _id, status, needs, wakeAt });

  // witness: change isReady to ignore `needs` in convex/ttsShared.ts — every
  // blocked todo would report ready and the frontier would be the whole batch.
  it("ready = active AND every need done", () => {
    const rows = [
      todo("a", "done"),
      todo("b", "active", ["a"]),
      todo("c", "active", ["b"]),
    ];
    const done = buildDoneSet(rows);
    expect(isReady(rows[1], done, NOW)).toBe(true);
    expect(isReady(rows[2], done, NOW)).toBe(false);
    // No needs at all: ready the moment it is active.
    expect(isReady(todo("d", "active"), done, NOW)).toBe(true);
    // EVERY need, not some: one unmet need is enough to block.
    expect(isReady(todo("e", "active", ["a", "b"]), done, NOW)).toBe(false);
  });

  // witness: drop "archived" from buildDoneSet — a set-aside need would block
  // the rest of its graph forever.
  it("archived counts as done, matching memberProgress", () => {
    const rows = [todo("a", "archived"), todo("b", "active", ["a"])];
    expect(buildDoneSet(rows)).toEqual(new Set(["a"]));
    expect(isReady(rows[1], buildDoneSet(rows), NOW)).toBe(true);
  });

  // witness: let isReady accept status "waiting" — a sleeping todo would be
  // offered as ready work.
  it("waiting, done, and archived todos are never ready", () => {
    const done = new Set<string>();
    expect(isReady(todo("a", "waiting"), done, NOW)).toBe(false);
    expect(isReady(todo("b", "done"), done, NOW)).toBe(false);
    expect(isReady(todo("c", "archived"), done, NOW)).toBe(false);
  });

  // witness: drop wakeAtPassed from isReady — an active row put to sleep by
  // the lifeos migration (waiting → active + wakeAt) would be offered as
  // ready work before its wake time.
  it("an active row whose wakeAt is ahead is asleep, not ready", () => {
    const done = new Set<string>();
    expect(isReady(todo("a", "active", [], NOW + 1), done, NOW)).toBe(false);
    expect(isReady(todo("b", "active", [], NOW), done, NOW)).toBe(true);
    expect(isReady(todo("c", "active", [], NOW - 1), done, NOW)).toBe(true);
  });

  it("frontier is the ready list, in the order given", () => {
    const rows = [
      todo("a", "done"),
      todo("b", "active", ["a"]),
      todo("c", "active", ["b"]),
      todo("d", "waiting"),
      todo("e", "active"),
      todo("f", "active", [], NOW + 60_000),
    ];
    expect(frontier(rows, NOW).map((r) => r._id)).toEqual(["b", "e"]);
  });

  // ── Readiness, two values (ruling 18) ──────────────────────────────────────
  // One reading per stored spelling. "ready-for-tom" was a finished write-up;
  // "preparing" was a half-finished one, and a half-prepared capture is never
  // ready — it reads as unprepared so the preparer picks it up again.
  it("ready-for-tom reads as prepared, preparing as unprepared", () => {
    expect(normalizeReadiness("unprepared")).toBe("unprepared");
    expect(normalizeReadiness("prepared")).toBe("prepared");
    expect(normalizeReadiness("preparing")).toBe("unprepared");
    expect(normalizeReadiness("ready-for-tom")).toBe("prepared");
    expect(isPrepared("unprepared")).toBe(false);
    expect(isPrepared("preparing")).toBe(false);
    expect(isPrepared("ready-for-tom")).toBe(true);
  });

  // witness: drop any one of the four conjuncts from isReadyForTom — a raw
  // capture, a sleeping row, a blocked row, or a done row would be listed as
  // ready for Tom.
  it("ready for Tom = prepared, active, awake, every need done", () => {
    const rows = [
      { ...todo("a", "done"), readiness: "prepared" as const },
      { ...todo("b", "active", ["a"]), readiness: "prepared" as const },
      { ...todo("c", "active", ["a"]), readiness: "unprepared" as const },
      { ...todo("d", "active", ["b"]), readiness: "prepared" as const },
      { ...todo("e", "active", [], NOW + 1), readiness: "prepared" as const },
      { ...todo("f", "waiting"), readiness: "prepared" as const },
      { ...todo("g", "active"), readiness: "ready-for-tom" as const },
    ];
    const done = buildDoneSet(rows);
    const ready = rows.filter((r) => isReadyForTom(r, done, NOW)).map((r) => r._id);
    expect(ready).toEqual(["b", "g"]);
  });

  // ── Waiting, computed with its reason ─────────────────────────────────────
  // witness: reorder the checks in waitingReason so `unprepared` comes before
  // `wake` — a raw capture asleep until March would say "unprepared", and the
  // preparer would look like the thing holding it.
  it("names the one reason an active todo waits, hard blocks first", () => {
    const ctx = {
      now: NOW,
      doneSet: new Set(["a"]),
      statementOf: (id: string) => (id === "b" ? "the need" : undefined),
    };
    const base = { _id: "x", status: "active" as const, readiness: "prepared" as const };
    // wake: a future wakeAt, whatever else is true.
    expect(
      waitingReason({ ...base, readiness: "unprepared", wakeAt: NOW + 1, needs: ["b"] }, ctx),
    ).toEqual({ kind: "wake", at: NOW + 1 });
    // a stored "waiting" status still reads as a sleep — a timeless one, since
    // the prose wake condition it used to carry is retired.
    expect(waitingReason({ ...base, status: "waiting" }, ctx)).toEqual({
      kind: "wake",
      at: undefined,
    });
    // need: the first unmet need, named.
    expect(waitingReason({ ...base, needs: ["a", "b"] }, ctx)).toEqual({
      kind: "need",
      id: "b",
      statement: "the need",
    });
    // credential: the source is declined.
    expect(
      waitingReason(
        { ...base, source: "email" },
        { ...ctx, declinedSources: new Set(["email"]) },
      ),
    ).toEqual({ kind: "credential", source: "email" });
    // unprepared: a raw capture with nothing else holding it.
    expect(waitingReason({ ...base, readiness: "unprepared" }, ctx)).toEqual({
      kind: "unprepared",
    });
    // tom: prepared, and his (an actor of "tom", or no actor at all).
    expect(waitingReason({ ...base, actor: "tom" }, ctx)).toEqual({ kind: "tom" });
    expect(waitingReason(base, ctx)).toEqual({ kind: "tom" });
    // an agent task that is ready waits on nothing.
    expect(waitingReason({ ...base, actor: "agent" }, ctx)).toBeNull();
    // done and archived rows are not waiting.
    expect(waitingReason({ ...base, status: "done" }, ctx)).toBeNull();
    expect(waitingReason({ ...base, status: "archived" }, ctx)).toBeNull();
  });

  it("spells each reason one way", () => {
    const date = (at: number) => `d${at}`;
    expect(waitingReasonText({ kind: "wake", at: 5 }, date)).toBe("waiting until d5");
    expect(waitingReasonText({ kind: "wake", at: 5, condition: "c" }, date)).toBe(
      "waiting until d5 — c",
    );
    expect(waitingReasonText({ kind: "wake", condition: "c" }, date)).toBe("waiting until: c");
    expect(waitingReasonText({ kind: "wake" }, date)).toBe("waiting");
    expect(waitingReasonText({ kind: "need", id: "b", statement: "s" }, date)).toBe(
      "waiting on: s",
    );
    expect(waitingReasonText({ kind: "need", id: "b" }, date)).toBe("waiting on: b");
    expect(waitingReasonText({ kind: "credential", source: "email" }, date)).toBe(
      "waiting on a credential: email declined",
    );
    expect(waitingReasonText({ kind: "unprepared" }, date)).toBe("waiting: unprepared");
    expect(waitingReasonText({ kind: "tom" }, date)).toBe("waiting on you");
  });

  it("bounds a todo's fan-in", () => {
    expect(MAX_NEEDS).toBe(10);
  });
});


// ── The worker pen's completion (tts.internalPrepareTodo status "done") ─────

describe("TTS worker pen: closing a todo", () => {
  const skips = async (t: ReturnType<typeof convexTest>) =>
    (await t.run(async (ctx) => ctx.db.query("dtsEvents").collect()))
      .filter((e) => e.kind === "done-skipped")
      .map((e) => (e.data as { why: string }).why);
  const statusOf = async (t: ReturnType<typeof convexTest>, id: Id<"dtsTodos">) =>
    (await t.run(async (ctx) => ctx.db.get(id)))?.status;

  // witness: put back the bar "only a todo inside a batch may be completed by
  // the pen" — with no batches, this standalone todo stays active and no agent
  // could complete anything, the opposite of Tom's ruling of 2026-09-24.
  it("closes a standalone todo Tom has not ruled on, once its evidence is recorded", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "draft the landlord questions" });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      status: "done",
      evidence: "questions.md, eight questions",
    });
    expect(await statusOf(t, id)).toBe("done");
    expect(await skips(t)).toEqual([]);
  });

  // witness: drop the evidence bar — a bare status write would close one of
  // Tom's todos with nothing recorded to show the work happened.
  it("refuses to close a todo with no evidence recorded", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "draft the landlord questions" });
    await t.mutation(internal.tts.internalPrepareTodo, { id, status: "done" });
    expect(await statusOf(t, id)).toBe("active");
    expect(await skips(t)).toEqual([
      "a todo is completed by the pen only with its evidence recorded",
    ]);
    // Evidence written in an earlier call counts: the bar reads the row.
    await t.mutation(internal.tts.internalPrepareTodo, { id, evidence: "questions.md" });
    await t.mutation(internal.tts.internalPrepareTodo, { id, status: "done" });
    expect(await statusOf(t, id)).toBe("done");
  });

  it("refuses a frozen task and an uncheckable goal, and closes a checkable goal", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);

    // A task Tom has ruled on.
    const task = await tom.mutation(api.tts.createTodo, { statement: "call the landlord" });
    await t.run(async (ctx) => ctx.db.patch(task, { kind: "task", tomTouchedAt: Date.now() }));
    await t.mutation(internal.tts.internalPrepareTodo, { id: task, status: "done", evidence: "e" });
    expect(await statusOf(t, task)).toBe("active");
    expect(await skips(t)).toEqual([
      "Tom-touched (frozen) — only he closes a row he has ruled on",
    ]);

    // A goal with no condition and no code subject: nothing to check.
    const triggerGoal = await tom.mutation(api.tts.createTodo, { statement: "renew the apartment lease" });
    await t.run(async (ctx) => ctx.db.patch(triggerGoal, { kind: "goal" }));
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: triggerGoal,
      status: "done",
      evidence: "the paperwork arrived",
    });
    expect(await statusOf(t, triggerGoal)).toBe("active");
    expect((await skips(t))[1]).toMatch(/checkable condition/);

    // A CHECKABLE goal is the one thing an agent may close on a Tom-touched
    // row: its condition, not a judgment, decides it.
    const realGoal = await tom.mutation(api.tts.createTodo, { statement: "the lease is signed" });
    await t.run(async (ctx) =>
      ctx.db.patch(realGoal, {
        kind: "goal",
        condition: "the signed lease is in the folder",
        tomTouchedAt: Date.now(),
      }),
    );
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: realGoal,
      status: "done",
      evidence: "lease.pdf, signed both sides",
    });
    expect(await statusOf(t, realGoal)).toBe("done");
  });

  // witness: drop the kind check from updateTodo — a task could carry a
  // must-not-break line, a constraint on nothing.
  it("mustNotBreak is written by Tom's door on a goal only", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const goalId = await tom.mutation(api.tts.createTodo, { statement: "the lease is signed" });
    const taskId = await tom.mutation(api.tts.createTodo, { statement: "call the landlord" });
    await t.run(async (ctx) => {
      await ctx.db.patch(goalId, { kind: "goal" });
      await ctx.db.patch(taskId, { kind: "task" });
    });
    await tom.mutation(api.tts.updateTodo, {
      id: goalId,
      mustNotBreak: "the current tenancy must not lapse before the new one starts",
    });
    expect((await t.run(async (ctx) => ctx.db.get(goalId)))?.mustNotBreak).toBe(
      "the current tenancy must not lapse before the new one starts",
    );
    await expect(
      tom.mutation(api.tts.updateTodo, { id: taskId, mustNotBreak: "anything" }),
    ).rejects.toThrow(/goal's field/);
    await tom.mutation(api.tts.updateTodo, { id: goalId, mustNotBreak: null });
    expect((await t.run(async (ctx) => ctx.db.get(goalId)))?.mustNotBreak).toBeUndefined();
  });
});

// ── GET /tts/planner-context and, for one rollout, GET /tts/batch-context ──

describe("GET /tts/planner-context", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const publish = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomPublication", {
        key: "current",
        commit: "planner-context-test",
        committedAt: 1,
        pushed: true,
        operate: "operate layer reaches the planner",
        headers: [{ layers: ["operate"], header: "published map + operate" }],
      });
    });
  const get = (t: ReturnType<typeof convexTest>, path: string) =>
    t.fetch(path, { method: "GET", headers: { "X-TTS-Key": "s3cret" } });

  // witness: drop `writingStandard` from the payload — the planner (Node ESM on
  // a box that never loads TypeScript) cannot import it, so the one home would
  // silently become a second copy pasted into a worker prompt.
  it("serves the todos, the writing standard, the vocabulary and no batches", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await publish(t);
    await tom.mutation(api.tts.createTodo, { statement: "sign the lease" });
    const res = await get(t, "/tts/planner-context");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The door serves the ASSEMBLED CONTEXT: the stable prefix — the map and
    // the operate rules — and the grant block naming what the planner may
    // load. The assembler's exact output is pinned in convex/ttsContext.test.ts.
    const [prefix, grants] = body.writingStandard.split("\n\nSKILLS (WikiTom commit ");
    expect(prefix).toBe("published map + operate\n\noperate layer reaches the planner");
    expect(grants).toContain("granted:");
    expect(body.vocabulary).toBe(TTS_CLOSED_VOCABULARY);
    expect(body.todos.map((todo: Doc<"dtsTodos">) => todo.statement)).toEqual(["sign the lease"]);
    expect(Array.isArray(body.sessionRepos)).toBe(true);
    expect(typeof body.nyCalendarDay).toBe("string");
    expect(body).not.toHaveProperty("batches");
    expect(body).not.toHaveProperty("planRepairs");
  });

  // witness: delete the /tts/batch-context door in this widen step — the
  // box's installed planner and delegate read it by name until the box is
  // rolled, and both refuse to run without its writingStandard.
  it("still serves /tts/batch-context for one rollout: the same payload, the batch rows, and no plan repairs", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await publish(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("batches", {
        statement: "sign the lease",
        status: "archived",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "plan-repair", data: { report: "old" } });
    });
    const planner = await (await get(t, "/tts/planner-context")).json();
    const res = await get(t, "/tts/batch-context");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.writingStandard).toBe(planner.writingStandard);
    expect(body.vocabulary).toBe(planner.vocabulary);
    expect(body.sessionRepos).toEqual(planner.sessionRepos);
    expect(body.batches.map((b: Doc<"batches">) => b.statement)).toEqual(["sign the lease"]);
    expect(body.planRepairs).toEqual([]);
  });

  it("fails closed with the stored-layer error when a requested layer is absent", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomPublication", {
        key: "current", commit: "incomplete", committedAt: 1, pushed: true,
        write: "write layer", headers: [],
      });
    });
    for (const path of ["/tts/planner-context", "/tts/batch-context"]) {
      const response = await get(t, path);
      expect(response.status).toBe(503);
      // The map goes to every run now, so `operate` is the first layer missing
      // from a publication that stored only `write`.
      await expect(response.json()).resolves.toEqual({ error: "model-of-tom layer operate is not stored" });
    }
  });

  // witness: leave POST /tts/plan-graph routed — a box still running the old
  // plan pass would go on forming batches after Tom ruled them gone.
  it("no longer routes the planner's batch pen or its plan-repair door", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    for (const path of ["/tts/plan-graph", "/tts/plan-repairs-consumed"]) {
      const res = await t.fetch(path, {
        method: "POST",
        headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
        body: JSON.stringify({ statement: "sign the lease", tasks: [], ids: [] }),
      });
      expect(res.status).toBe(404);
    }
    expect(await t.run(async (ctx) => ctx.db.query("batches").collect())).toEqual([]);
  });
});
