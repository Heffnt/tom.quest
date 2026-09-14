import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
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
import type { SessionModel } from "./ttsShared";

// Schema v2 (ratified 2026-08-29): a batch is its own row holding HOW a set of
// todos gets completed; its contents are dtsTodos rows pointing back at it as
// kind "task" or kind "goal", wired together by `needs`, and the ones whose
// needs are all done are "ready".

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

const graphTask = (
  statement: string,
  over: Partial<{
    id: string;
    actor: "tom" | "agent";
    needs: (string | number)[];
    condition: string;
    groundUpExplanation: string;
    evidence: string;
    status: "active" | "done";
    model: SessionModel;
  }> = {},
) => ({ statement, actor: "agent" as const, ...over });

const storeGraph = (
  t: ReturnType<typeof convexTest>,
  over: Partial<{
    batchId: string;
    statement: string;
    groundUpExplanation: string;
    tasks: ReturnType<typeof graphTask>[];
    goalIds: string[];
    archive: boolean;
  }> = {},
) =>
  t.mutation(internal.tts.internalStorePlanGraph, {
    statement: "get the apartment",
    tasks: [graphTask("call the landlord")],
    ...over,
  });

const allBatches = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => await ctx.db.query("batches").collect());

const oneBatch = async (t: ReturnType<typeof convexTest>) => {
  const rows = await allBatches(t);
  return rows[0];
};

const batchTodos = (t: ReturnType<typeof convexTest>, batchId: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("dtsTodos").collect()).filter(
      (todo) => todo.batchId === batchId,
    ),
  );

const byStatement = (todos: Doc<"dtsTodos">[], statement: string) =>
  todos.find((todo) => todo.statement === statement);

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

// ── The planner's pen ────────────────────────────────────────────────────────

describe("TTS plan graph (internalStorePlanGraph)", () => {
  it("creates a batch row and its tasks, chained by needs", async () => {
    const t = convexTest({ schema, modules });
    const res = await storeGraph(t, {
      statement: "  sign the lease  ",
      groundUpExplanation: "why this matters, from the ground up",
      tasks: [
        graphTask("draft the questions"),
        graphTask("call the landlord", { actor: "tom", needs: [0] }),
      ],
    });
    expect(res).toMatchObject({
      created: 2,
      updated: 0,
      unchanged: 0,
      goalsBound: 0,
      archived: 0,
      skipped: [],
    });

    const batch = await oneBatch(t);
    expect(batch.statement).toBe("sign the lease"); // trimmed
    expect(batch.groundUpExplanation).toBe(
      "why this matters, from the ground up",
    );
    expect(batch.status).toBe("active");
    expect(batch.tomTouchedAt).toBeUndefined(); // an agent write is never a Tom touch
    expect(res.batchId).toBe(batch._id);

    const todos = await batchTodos(t, batch._id);
    expect(todos).toHaveLength(2);
    const draft = byStatement(todos, "draft the questions")!;
    const call = byStatement(todos, "call the landlord")!;
    expect(draft.kind).toBe("task");
    expect(draft.actor).toBe("agent");
    expect(draft.status).toBe("active");
    expect(draft.source).toBe("planner");
    expect(draft.needs).toBeUndefined(); // no needs = the frontier
    expect(call.actor).toBe("tom");
    // The in-payload index ref resolved to the real id of the earlier task.
    expect(call.needs).toEqual([draft._id]);

    // The frontier reads exactly what the pen wrote.
    expect(frontier(todos, Date.now()).map((x) => x.statement)).toEqual([
      "draft the questions",
    ]);
  });

  it("rewrites its own batch in place, and a re-post writes nothing", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, { tasks: [graphTask("v1")] });
    const batch = await oneBatch(t);
    const [task] = await batchTodos(t, batch._id);

    const rewrite = await storeGraph(t, {
      batchId: batch._id,
      statement: "get the apartment",
      tasks: [graphTask("v2", { id: task._id, evidence: "PR #4" })],
    });
    expect(rewrite).toMatchObject({
      batchId: batch._id,
      created: 0,
      updated: 1,
      unchanged: 0,
      skipped: [],
    });
    const [fresh] = await batchTodos(t, batch._id);
    expect(fresh._id).toBe(task._id); // rewritten, not replaced
    expect(fresh.statement).toBe("v2");
    expect(fresh.evidence).toBe("PR #4");
    expect((await allBatches(t))).toHaveLength(1);

    // witness: drop the projected-vs-stored comparison in
    // internalStorePlanGraph — a repeated post would bump updatedAt on every
    // row and re-push every open client.
    const again = await storeGraph(t, {
      batchId: batch._id,
      statement: "get the apartment",
      tasks: [graphTask("v2", { id: task._id, evidence: "PR #4" })],
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const [unchanged] = await batchTodos(t, batch._id);
    expect(unchanged.updatedAt).toBe(fresh.updatedAt);
    expect((await oneBatch(t)).updatedAt).toBe(batch.updatedAt);
  });

  // witness: drop the tomTouchedAt check from internalStorePlanGraph — the
  // planner would clobber a graph Tom just ruled on.
  it("refuses to rewrite a Tom-touched (frozen) batch", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeGraph(t, { tasks: [graphTask("original")] });
    const batch = await oneBatch(t);
    await tom.mutation(api.ttsRulings.recordRuling, {
      batchId: batch._id,
      verdict: "approve",
    });

    const res = await storeGraph(t, {
      batchId: batch._id,
      statement: "rewritten behind his back",
      tasks: [graphTask("new plan")],
    });
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.skipped).toEqual([
      { ref: "rewritten behind his back", why: "Tom-touched (frozen)" },
    ]);
    expect((await oneBatch(t)).statement).toBe("get the apartment");
    expect(await batchTodos(t, batch._id)).toHaveLength(1);
  });

  it("refuses a terminal batch and an unknown batch id", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, { archive: true });
    const batch = await oneBatch(t);
    expect(batch.status).toBe("archived");

    const terminal = await storeGraph(t, { batchId: batch._id });
    expect(terminal.skipped).toEqual([
      { ref: "get the apartment", why: "status archived" },
    ]);

    const stray = await t.run(async (ctx) =>
      ctx.db.insert("batches", {
        statement: "gone",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.run(async (ctx) => ctx.db.delete(stray));
    const unknown = await storeGraph(t, { batchId: stray });
    expect(unknown.batchId).toBeNull();
    expect(unknown.skipped[0].why).toMatch(/unknown batch id/);
  });

  // witness: drop the MAX_NEEDS check — one row's `needs` array would grow
  // without bound (Convex unbounded-array-field guideline).
  it("caps a todo's needs", async () => {
    const t = convexTest({ schema, modules });
    const res = await storeGraph(t, {
      tasks: [
        graphTask("too many", {
          needs: Array.from({ length: MAX_NEEDS + 1 }, (_, i) => i),
        }),
      ],
    });
    expect(res.created).toBe(0);
    expect(res.skipped).toEqual([
      { ref: "too many", why: `a todo needs at most ${MAX_NEEDS} others — got 11` },
    ]);
  });

  // witness: drop the `need >= i` bound — a forward index ref would silently
  // resolve to nothing (or to a later task, making the payload cyclic).
  it("an index ref must name an EARLIER task in the payload", async () => {
    const t = convexTest({ schema, modules });
    const res = await storeGraph(t, {
      tasks: [
        graphTask("first", { needs: [1] }), // forward
        graphTask("second", { needs: [1] }), // itself
        graphTask("third", { needs: [1.5] }), // not an index at all
      ],
    });
    expect(res.created).toBe(0);
    expect(res.skipped).toEqual([
      {
        ref: "first",
        why: "needs 1: an index must name an EARLIER task in this payload",
      },
      {
        ref: "second",
        why: "needs 1: an index must name an EARLIER task in this payload",
      },
      {
        ref: "third",
        why: "needs 1.5: an index must name an EARLIER task in this payload",
      },
    ]);
  });

  // witness: drop the acceptedIndices check — a task whose need was skipped
  // would land with the edge silently missing.
  it("a skipped task takes its dependents with it", async () => {
    const t = convexTest({ schema, modules });
    const res = await storeGraph(t, {
      tasks: [
        graphTask(""), // no statement: skipped
        graphTask("depends on the skipped one", { needs: [0] }),
      ],
    });
    expect(res.created).toBe(0);
    expect(res.skipped).toEqual([
      { ref: "task 0", why: "a task needs a statement" },
      {
        ref: "depends on the skipped one",
        why: "needs task 0, which was skipped",
      },
    ]);
  });

  // witness: drop the addressable() check — a graph could reach into another
  // batch's todos, and one todo would be wired into two batches.
  it("refuses cross-batch needs and cross-batch task ids", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, { statement: "batch one", tasks: [graphTask("theirs")] });
    const first = (await allBatches(t))[0];
    const [theirs] = await batchTodos(t, first._id);

    const res = await storeGraph(t, {
      statement: "batch two",
      tasks: [
        graphTask("needs across", { needs: [theirs._id] }),
        graphTask("steals across", { id: theirs._id }),
      ],
    });
    expect(res.created).toBe(0);
    expect(res.skipped).toEqual([
      {
        ref: "needs across",
        why: `needs ${theirs._id}, which belongs to another batch`,
      },
      {
        ref: "steals across",
        why: `${theirs._id} belongs to another batch`,
      },
    ]);
    // The new batch row still exists — only its tasks were dropped.
    expect(await allBatches(t)).toHaveLength(2);
  });

  // witness: drop the cycleBoundNodes sweep from internalStorePlanGraph — a
  // mutually-blocking pair would be stored, and neither would ever be ready.
  it("refuses a cycle (and everything downstream of it)", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, {
      tasks: [graphTask("a"), graphTask("b"), graphTask("c")],
    });
    const batch = await oneBatch(t);
    const todos = await batchTodos(t, batch._id);
    const a = byStatement(todos, "a")!;
    const b = byStatement(todos, "b")!;
    const c = byStatement(todos, "c")!;

    const res = await storeGraph(t, {
      batchId: batch._id,
      tasks: [
        graphTask("a", { id: a._id, needs: [b._id] }),
        graphTask("b", { id: b._id, needs: [a._id] }),
        graphTask("c", { id: c._id, needs: [a._id] }), // downstream of the cycle
      ],
    });
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.skipped).toEqual([
      { ref: "a", why: "needs form a cycle" },
      { ref: "b", why: "needs form a cycle" },
      { ref: "c", why: "needs form a cycle" },
    ]);
    const after = await batchTodos(t, batch._id);
    expect(after.every((x) => x.needs === undefined)).toBe(true);
  });

  // witness: push `#${need}` instead of the target's node key — an index ref
  // naming a task the payload addressed BY ID resolved to nothing at write
  // time and stored the literal string "#0" in `needs`.
  it("an index ref resolves to a rewritten task's real id", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, { tasks: [graphTask("first"), graphTask("second")] });
    const batch = await oneBatch(t);
    const rows = await batchTodos(t, batch._id);
    const first = byStatement(rows, "first")!;
    const second = byStatement(rows, "second")!;

    const res = await storeGraph(t, {
      batchId: batch._id,
      tasks: [
        graphTask("first", { id: first._id }),
        graphTask("second", { id: second._id, needs: [0] }),
      ],
    });
    expect(res.skipped).toEqual([]);
    expect(
      byStatement(await batchTodos(t, batch._id), "second")!.needs,
    ).toEqual([first._id]);
  });

  it("refuses a self-edge", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, { tasks: [graphTask("solo")] });
    const batch = await oneBatch(t);
    const [solo] = await batchTodos(t, batch._id);
    const res = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("solo", { id: solo._id, needs: [solo._id] })],
    });
    expect(res.skipped).toEqual([{ ref: "solo", why: "needs form a cycle" }]);
  });

  it("records a task's completion with its evidence", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, { tasks: [graphTask("do it")] });
    const batch = await oneBatch(t);
    const [task] = await batchTodos(t, batch._id);
    await storeGraph(t, {
      batchId: batch._id,
      tasks: [
        graphTask("do it", {
          id: task._id,
          status: "done",
          evidence: "branch tts-graph",
        }),
      ],
    });
    const [done] = await batchTodos(t, batch._id);
    expect(done.status).toBe("done");
    expect(done.doneAt).toBeGreaterThan(0);
    expect(done.evidence).toBe("branch tts-graph");
    // A done need frees its dependents (the frontier moves).
    expect(buildDoneSet([done]).has(done._id)).toBe(true);
  });

  // witness: drop the goal branch from internalStorePlanGraph — the batch
  // would have tasks but nothing it is FOR.
  it("binds existing todos as the batch's goals without resurfacing them", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const goalId = await tom.mutation(api.tts.createTodo, {
      statement: "the lease is signed",
    });
    // An old updatedAt: binding is a structural annotation, so it must not
    // bump it (that would resurface a gate Tom already ruled on).
    await t.run(async (ctx) => ctx.db.patch(goalId, { updatedAt: 1000 }));

    const res = await storeGraph(t, { goalIds: [goalId] });
    expect(res.goalsBound).toBe(1);
    const goal = await t.run(async (ctx) => ctx.db.get(goalId));
    expect(goal?.kind).toBe("goal");
    expect(goal?.batchId).toBe(res.batchId);
    expect(goal?.statement).toBe("the lease is signed"); // untouched
    expect(goal?.updatedAt).toBe(1000);

    // Re-binding the same goal is a no-op, not a second bind.
    const again = await storeGraph(t, {
      batchId: res.batchId!,
      goalIds: [goalId],
    });
    expect(again.goalsBound).toBe(0);
  });

  it("skips an unknown goal id and a goal held by another batch", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const goalId = await tom.mutation(api.tts.createTodo, { statement: "g" });
    const first = await storeGraph(t, { statement: "one", goalIds: [goalId] });
    expect(first.goalsBound).toBe(1);
    const second = await storeGraph(t, {
      statement: "two",
      goalIds: [goalId, "not-an-id"],
    });
    expect(second.goalsBound).toBe(0);
    expect(second.skipped).toEqual([
      { ref: goalId, why: `${goalId} belongs to another batch` },
      { ref: "not-an-id", why: "unknown todo id: not-an-id" },
    ]);
  });

  it("archives a batch on request (its todos are never deleted)", async () => {
    const t = convexTest({ schema, modules });
    const res = await storeGraph(t, { tasks: [graphTask("leftover")] });
    const archived = await storeGraph(t, {
      batchId: res.batchId!,
      tasks: [],
      archive: true,
    });
    expect(archived.archived).toBe(1);
    expect((await oneBatch(t)).status).toBe("archived");
    const rows = await batchTodos(t, res.batchId!);
    expect(rows).toHaveLength(1); // never deleted
    // witness: patch only the batches row — "leftover" stays an ACTIVE todo
    // carrying a batchId, which the frontier skips (its batch is not active),
    // every legacy lane skips (it has a batchId) and the preparer skips too:
    // open work no scheduler will ever admit again and nothing will ever
    // mention.
    expect(rows[0].status).toBe("archived");
  });

  // witness: archive the batch alone and this goes red on both counts — the
  // task becomes work nothing can reach, and the GOAL (one of Tom's own todos,
  // which the planner merely bound here) is stranded in a retired batch
  // instead of going back to the pool the preparer and the lanes read.
  it("archiving a batch archives its tasks and returns its goals", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const goalId = await tom.mutation(api.tts.createTodo, {
      statement: "the lease is signed",
    });
    const res = await storeGraph(t, {
      tasks: [graphTask("leftover"), graphTask("landed", { status: "done" })],
      goalIds: [goalId],
    });
    await storeGraph(t, {
      batchId: res.batchId!,
      tasks: [],
      archive: true,
    });

    const rows = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(byStatement(rows, "leftover")!.status).toBe("archived");
    // A done task keeps its resting state: it is the record of what landed.
    expect(byStatement(rows, "landed")!.status).toBe("done");
    const goal = byStatement(rows, "the lease is signed")!;
    expect(goal.status).toBe("active");
    expect(goal.batchId).toBeUndefined();
    expect(goal.kind).toBeUndefined();
  });

  // witness: let a reworded task without its id simply mint a new row — the
  // planner is an LLM re-emitting the whole graph every run, so the batch ends
  // up holding both wordings, both ready, both agent-workable, and two worker
  // sessions do the same work on the same branch namespace.
  it("retires a task the payload dropped, and keeps one that was worked", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, {
      tasks: [graphTask("gather the sources"), graphTask("write the summary")],
    });
    const batch = await oneBatch(t);
    const before = await batchTodos(t, batch._id);
    const worked = byStatement(before, "write the summary")!;
    // A session has already advanced this one.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: worked._id,
      evidence: "branch session/x",
    });

    // The planner rewords the first task and omits both ids.
    const again = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("gather every source")],
    });
    expect(again.created).toBe(1);
    expect(again.retired).toBe(1);
    const after = await batchTodos(t, batch._id);
    expect(byStatement(after, "gather the sources")!.status).toBe("archived");
    expect(byStatement(after, "gather every source")!.status).toBe("active");
    // Worked, so it is REPORTED and left standing, never archived.
    expect(byStatement(after, "write the summary")!.status).toBe("active");
    expect(again.skipped).toEqual([
      {
        ref: "write the summary",
        why: "left in the batch: the planner did not re-emit it, and a session has already worked it",
      },
    ]);
  });

  // witness: infer "did the batch store?" from the skip report (the pre-fix
  // rule) and this goes red — a TASK's skip carries the task's statement as
  // its ref, so a task whose statement happens to equal the batch's reads as a
  // refused batch, and the planner silently drops Tom's revise ruling.
  it("says whether the batch itself stored, separately from its tasks", async () => {
    const t = convexTest({ schema, modules });
    const stored = await storeGraph(t, {
      statement: "get the apartment",
      tasks: [graphTask("get the apartment", { needs: [99] })],
    });
    expect(stored.batchStored).toBe(true);
    expect(stored.skipped[0].ref).toBe("get the apartment"); // the TASK's ref

    const frozenBatch = await oneBatch(t);
    await t.run(async (ctx) =>
      ctx.db.patch(frozenBatch._id, { tomTouchedAt: Date.now() }),
    );
    const refused = await storeGraph(t, {
      batchId: frozenBatch._id,
      tasks: [graphTask("anything")],
    });
    expect(refused.batchStored).toBe(false);
  });

  // THE COMPLETION PEN'S THREE BARS. witness: gate the `status: "done"` branch
  // of internalPrepareTodo on batchId alone (the pre-fix rule) and both
  // refusals go red — goal binding is explicitly allowed on Tom-touched rows,
  // so every bound goal became a row an agent could close, and a goal with no
  // condition has nothing an agent can go and check.
  it("refuses the completion pen on a frozen task and an uncheckable goal", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const skips = async () =>
      (await t.run(async (ctx) => ctx.db.query("dtsEvents").collect()))
        .filter((e) => e.kind === "done-skipped")
        .map((e) => (e.data as { why: string }).why);

    // (a) A task Tom has ruled on.
    await storeGraph(t, { tasks: [graphTask("do it")] });
    const batch = await oneBatch(t);
    const [task] = await batchTodos(t, batch._id);
    await t.run(async (ctx) =>
      ctx.db.patch(task._id, { tomTouchedAt: Date.now() }),
    );
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: task._id,
      status: "done",
      evidence: "e",
    });
    expect((await batchTodos(t, batch._id))[0].status).toBe("active");
    expect(await skips()).toEqual([
      "Tom-touched (frozen) — only he closes a row he has ruled on",
    ]);

    // (b) A goal with no condition and no code subject: nothing to check.
    const triggerGoal = await tom.mutation(api.tts.createTodo, {
      statement: "renew the apartment lease",
    });
    await storeGraph(t, {
      batchId: batch._id,
      tasks: [],
      goalIds: [triggerGoal],
    });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: triggerGoal,
      status: "done",
      evidence: "the paperwork arrived",
    });
    expect((await t.run(async (ctx) => ctx.db.get(triggerGoal)))?.status).toBe(
      "active",
    );
    expect((await skips())[1]).toMatch(/checkable condition/);

    // (c) A CHECKABLE goal is the one thing an agent may close on a
    // Tom-touched row, and that is the design: checking the world and
    // recording the answer is a goal's whole contract.
    const realGoal = await tom.mutation(api.tts.createTodo, {
      statement: "the lease is signed",
    });
    await t.run(async (ctx) =>
      ctx.db.patch(realGoal, {
        condition: "the signed lease is in the folder",
        tomTouchedAt: Date.now(),
      }),
    );
    await storeGraph(t, { batchId: batch._id, tasks: [], goalIds: [realGoal] });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: realGoal,
      status: "done",
      evidence: "lease.pdf, signed both sides",
    });
    expect((await t.run(async (ctx) => ctx.db.get(realGoal)))?.status).toBe(
      "done",
    );
  });

  // witness: serve every plan-repair in the window regardless (drop the
  // consumedAt filter) and this goes red — a repair the planner acted on is
  // re-injected as an instruction to FIX THE STRUCTURE every two hours for a
  // week, and the likeliest response to "fix an edge that is already gone" is
  // to restructure something else.
  it("serves a plan repair once and stops after it is consumed", async () => {
    const t = convexTest({ schema, modules });
    const eventId = await t.run(async (ctx) =>
      ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: "plan-repair",
        data: { report: "write the summary does not need gather the sources" },
      }),
    );
    expect(
      await t.query(internal.tts.internalRecentPlanRepairs, {}),
    ).toHaveLength(1);

    const first = await t.mutation(internal.tts.internalMarkPlanRepairsConsumed, {
      ids: [eventId, "not-an-id"],
    });
    expect(first.consumed).toBe(1);
    expect(await t.query(internal.tts.internalRecentPlanRepairs, {})).toEqual([]);
    // Consuming twice is a no-op, not a second consumption.
    const second = await t.mutation(
      internal.tts.internalMarkPlanRepairsConsumed,
      { ids: [eventId] },
    );
    expect(second.consumed).toBe(0);
  });

  // witness: write the payload's condition/groundUpExplanation/evidence
  // straight through in internalStorePlanGraph — ctx.db.patch DELETES a field
  // written as undefined, so the next re-post that omits them would erase the
  // evidence a session recorded and the "more" layer, exactly what the batch
  // row's preserve-on-absent rule exists to prevent.
  it("an omitted field PRESERVES the stored value", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, {
      tasks: [
        graphTask("first"),
        graphTask("do it", {
          needs: [0],
          condition: "the landlord answers",
          groundUpExplanation: "why this step, from the ground up",
          evidence: "PR #4",
        }),
      ],
    });
    const batch = await oneBatch(t);
    const before = await batchTodos(t, batch._id);
    const task = byStatement(before, "do it")!;
    expect(task.needs).toEqual([byStatement(before, "first")!._id]);

    // The planner re-posts the same graph and mentions none of them.
    const again = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("first"), graphTask("do it", { id: task._id })],
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    const after = byStatement(await batchTodos(t, batch._id), "do it")!;
    expect(after.condition).toBe("the landlord answers");
    expect(after.groundUpExplanation).toBe("why this step, from the ground up");
    expect(after.evidence).toBe("PR #4");
    expect(after.needs).toEqual(task.needs); // edges preserved too

    // An EXPLICIT empty array is how a payload clears the edges.
    const cleared = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("do it", { id: task._id, needs: [] })],
    });
    expect(cleared.updated).toBe(1);
    expect(
      byStatement(await batchTodos(t, batch._id), "do it")!.needs,
    ).toBeUndefined();
  });

  // witness: drop notWritable from internalStorePlanGraph — the planner would
  // reopen a task Tom closed, rewrite a life todo he wrote by hand, and claim
  // a v1 batch row as a task (a row that renders as a batch AND lives in one).
  it("refuses a Tom-touched, foreign-source, or v1-batch row as a task", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeGraph(t, { tasks: [graphTask("do it")] });
    const batch = await oneBatch(t);
    const [task] = await batchTodos(t, batch._id);
    await tom.mutation(api.tts.setStatus, { id: task._id, status: "done" });

    const frozen = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("reopened behind him", { id: task._id })],
    });
    expect(frozen).toMatchObject({ created: 0, updated: 0 });
    expect(frozen.skipped).toEqual([
      { ref: "reopened behind him", why: "Tom-touched (frozen)" },
    ]);
    const still = (await t.run(async (ctx) =>
      ctx.db.get(task._id),
    )) as Doc<"dtsTodos">;
    expect(still.status).toBe("done");
    expect(still.statement).toBe("do it");

    // A todo Tom wrote by hand is not the planner's to rewrite.
    const mine = await tom.mutation(api.tts.createTodo, { statement: "mine" });
    await t.run(async (ctx) => ctx.db.patch(mine, { tomTouchedAt: undefined }));
    const stolen = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("rewritten", { id: mine })],
    });
    expect(stolen.skipped).toEqual([
      { ref: "rewritten", why: "source manual is not the planner's" },
    ]);
  });

  // witness: patch `status` directly in internalStorePlanGraph — a reopened
  // row would keep its terminal facts, a completion would slide its date away
  // with no dateOutcomes entry, and no status-changed event would exist.
  it("a status change goes through the one transition implementation", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeGraph(t, { tasks: [graphTask("do it")] });
    const batch = await oneBatch(t);
    const [task] = await batchTodos(t, batch._id);
    // A dated task: the kept-dates rule says the date resolves, never vanishes.
    await t.run(async (ctx) =>
      ctx.db.patch(task._id, { dueAt: 5000, timingClass: "dated" }),
    );

    await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("do it", { id: task._id, status: "done" })],
    });
    const done = (await t.run(async (ctx) =>
      ctx.db.get(task._id),
    )) as Doc<"dtsTodos">;
    expect(done.status).toBe("done");
    expect(done.dueAt).toBeUndefined();
    expect(done.dateOutcomes).toMatchObject([{ dueAt: 5000, outcome: "done" }]);

    // Reopening clears the terminal facts rather than leaving them standing.
    await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("do it", { id: task._id, status: "active" })],
    });
    const live = (await t.run(async (ctx) =>
      ctx.db.get(task._id),
    )) as Doc<"dtsTodos">;
    expect(live.status).toBe("active");
    expect(live.doneAt).toBeUndefined();
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.filter((e) => e.kind === "status-changed")).toHaveLength(2);
  });

  // witness: drop the statement-keyed lookups — a planner that re-posts a
  // graph without echoing ids mints a whole duplicate graph on every run.
  it("a re-post without ids rewrites, it does not duplicate", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, {
      statement: "the move",
      tasks: [graphTask("compare quotes"), graphTask("pick one", { needs: [0] })],
    });
    const again = await storeGraph(t, {
      statement: "the move",
      tasks: [graphTask("compare quotes"), graphTask("pick one", { needs: [0] })],
    });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(await allBatches(t)).toHaveLength(1);
    expect(await batchTodos(t, (await oneBatch(t))._id)).toHaveLength(2);
  });

  // witness: seed the acyclicity map from this batch's rows only — a cycle
  // that runs through a batch-less todo reads as orderable, and both ends sit
  // blocked forever with nothing saying why.
  it("sees a cycle that closes through a todo outside the batch", async () => {
    const t = convexTest({ schema, modules });
    // A: a batch-less todo that already needs B (written by an earlier graph
    // whose batch was archived; the row itself stayed batch-less).
    await storeGraph(t, {
      statement: "outside",
      tasks: [graphTask("b"), graphTask("a", { needs: [0] })],
    });
    const first = await oneBatch(t);
    const rows = await batchTodos(t, first._id);
    const a = byStatement(rows, "a")!;
    const b = byStatement(rows, "b")!;
    await t.run(async (ctx) => {
      await ctx.db.patch(a._id, { batchId: undefined });
      await ctx.db.patch(b._id, { batchId: undefined });
    });

    const res = await storeGraph(t, {
      statement: "new batch",
      tasks: [graphTask("b again", { id: b._id, needs: [a._id] })],
    });
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.skipped).toEqual([{ ref: "b again", why: "needs form a cycle" }]);
  });

  it("caps the todos in one batch and the goals bound to it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeGraph(t, {
      tasks: Array.from({ length: 40 }, (_, i) => graphTask(`step ${i}`)),
    });
    const batch = await oneBatch(t);
    const full = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("one too many")],
    });
    expect(full.created).toBe(0);
    expect(full.skipped).toEqual([
      { ref: "one too many", why: "a batch holds at most 40 todos" },
    ]);

    const goalIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      goalIds.push(
        await tom.mutation(api.tts.createTodo, { statement: `goal ${i}` }),
      );
    }
    const goals = await storeGraph(t, {
      batchId: batch._id,
      tasks: [],
      goalIds,
    });
    expect(goals.goalsBound).toBe(20);
    expect(goals.skipped).toEqual([
      { ref: goalIds[20], why: "a batch holds at most 20 goals" },
    ]);
  });

  it("caps the tasks in one payload", async () => {
    const t = convexTest({ schema, modules });
    const res = await storeGraph(t, {
      tasks: Array.from({ length: 41 }, (_, i) => graphTask(`step ${i}`)),
    });
    expect(res.created).toBe(40);
    expect(res.skipped).toEqual([
      { ref: "step 40", why: "a graph holds at most 40 tasks" },
    ]);
  });
});

// ── Rulings on a batch subject ───────────────────────────────────────────────

describe("TTS rulings on a batch", () => {
  const newBatch = async (t: ReturnType<typeof convexTest>) => {
    await storeGraph(t);
    return await oneBatch(t);
  };

  // witness: drop `batch` from subjectKey in convex/ttsRulings.ts — every
  // batch ruling would collapse onto the key "code undefined undefined".
  it("records a batch verdict under its own subject key", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const batch = await newBatch(t);
    await tom.mutation(api.ttsRulings.recordRuling, {
      batchId: batch._id,
      verdict: "approve",
      sentence: "go",
    });
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.subjectType).toBe("batch");
    expect(ruling.batchId).toBe(batch._id);
    expect(ruling.todoId).toBeUndefined();
    expect(ruling.sentence).toBe("go");
    // Approving a graph is ratification — applied the moment it is recorded.
    expect(ruling.appliedAt).toBeGreaterThan(0);
    expect(ruling.applyResult).toBe("graph ratified");
    expect((await oneBatch(t)).tomTouchedAt).toBeGreaterThan(0);
  });

  // witness: drop batchId from the exactly-one-subject count in
  // convex/ttsRulings.ts — a ruling could name two subjects at once.
  it("a batch ruling is still exactly one subject", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const batch = await newBatch(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        batchId: batch._id,
        todoId,
        verdict: "approve",
      }),
    ).rejects.toThrow(/exactly one subject/);
  });

  it("archive archives the batch; revise leaves it writable", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const batch = await newBatch(t);
    await tom.mutation(api.ttsRulings.recordRuling, {
      batchId: batch._id,
      verdict: "revise",
      sentence: "split the second half out",
    });
    // revise hands the graph BACK to the planner: no freeze, so a rewrite lands.
    expect((await oneBatch(t)).tomTouchedAt).toBeUndefined();
    const rewrite = await storeGraph(t, {
      batchId: batch._id,
      statement: "revised",
      tasks: [graphTask("smaller")],
    });
    expect(rewrite.skipped).toEqual([]);

    await tom.mutation(api.ttsRulings.recordRuling, {
      batchId: batch._id,
      verdict: "archive",
      sentence: "if the landlord calls back",
    });
    const archived = await oneBatch(t);
    expect(archived.status).toBe("archived");
    expect(archived.tomTouchedAt).toBeGreaterThan(0);
    // witness: drop unarchiveCondition from the batch archive branch — the
    // sentence IS the condition, and nothing could ever propose the batch back.
    expect(archived.unarchiveCondition).toBe("if the landlord calls back");
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    const last = rulings.find((r) => r.verdict === "archive")!;
    // witness: patch only the batches row on archive — its unfinished tasks
    // stay active with a batchId no scheduler will ever admit again (the
    // frontier skips a non-active batch, every legacy lane skips a batchId
    // row, and so does the preparer): open work invisible to everything.
    expect(last.applyResult).toBe(
      "batch archived (1 task(s) archived, 0 goal(s) returned)",
    );
    expect(
      (await batchTodos(t, batch._id)).every((r) => r.status === "archived"),
    ).toBe(true);

    // witness: leave a batch `revise` unapplied — every worker filters the
    // pending feed to life/code, so it would sit in internalPendingRulings
    // (and the page's "ruled, applying" strip) forever.
    const revise = rulings.find((r) => r.verdict === "revise")!;
    expect(revise.appliedAt).toBeGreaterThan(0);
    expect(revise.applyResult).toBe("handed back to the planner");
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending).toEqual([]);
  });

  it("the internal pen rules on a batch too", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const batch = await newBatch(t);
    await t.mutation(internal.ttsRulings.internalRecordRuling, {
      batchId: batch._id,
      verdict: "session",
    });
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.subjectType).toBe("batch");
    expect(ruling.appliedAt).toBeUndefined(); // applied when the session exists
    await expect(
      t.mutation(internal.ttsRulings.internalRecordRuling, {
        batchId: "not-an-id",
        verdict: "approve",
      }),
    ).rejects.toThrow(/Unknown batch id/);
  });
});

// ── The v1 → v2 migration ────────────────────────────────────────────────────
// THE PRE-NARROW RECORD. `members` and `plan` — the pair that made a dtsTodos
// row a v1 batch — have no writer left (the lifeos update, phase 7: the v1
// pen and POST /tts/batches are gone), and the narrow that follows the
// clearing takes their declarations out of convex/schema.ts, at which point a
// fixture carrying them stops inserting under it. The rows are still on the
// deployment until the clearing walk reaches them, and internalMigrateToGraph
// is their last reader — through a loose view of the row. So these fixtures go
// in under a copy of the schema with the two put back, the same device
// convex/ttsMigrations.test.ts uses for every other retired shape (spelled
// again here because one test file cannot import another without re-running
// its suites).

const V1_MEMBER = v.object({
  todoId: v.optional(v.id("dtsTodos")),
  repo: v.optional(v.string()),
  externalId: v.optional(v.string()),
});
const V1_PLAN_STEP = v.object({
  text: v.string(),
  actor: v.union(v.literal("tom"), v.literal("agent")),
  status: v.union(v.literal("open"), v.literal("done")),
  doneAt: v.optional(v.number()),
  evidence: v.optional(v.string()),
});

/** `defineTable(v.object(...))` starts a table with NO indexes — the `.index()`
 * chain lives on the TableDefinition, not on the validator it is rebuilt from
 * — so the rebuilt table has to be handed the source's chain or the first
 * `withIndex()` read any tested function makes fails here while passing in
 * production. (`" indexes"()` is convex/server's own accessor.) */
type IndexChain = { indexDescriptor: string; fields: string[] }[];
type Indexed = { " indexes"(): IndexChain };
type Chainable = { index(name: string, fields: string[]): Chainable };
function carryIndexes<T>(rebuilt: T, source: Indexed): T {
  let table = rebuilt as unknown as Chainable;
  for (const { indexDescriptor, fields } of (
    source as Indexed
  )[" indexes"]()) {
    table = table.index(indexDescriptor, fields);
  }
  return table as unknown as T;
}

const { dtsTodos: schemaTodos, ...otherTables } = schema.tables;
const v1Schema = defineSchema({
  ...otherTables,
  dtsTodos: carryIndexes(
    defineTable(
      v.object({
        ...schemaTodos.validator.fields,
        members: v.optional(v.array(V1_MEMBER)),
        plan: v.optional(v.array(V1_PLAN_STEP)),
      }),
    ),
    schemaTodos as unknown as Indexed,
  ),
});

describe("TTS migration to the graph (internalMigrateToGraph)", () => {
  /** The one v1 batch row on the deployment, read the way the migration reads
   * it: through a loose view, not the generated Doc type. */
  const oldV1Row = async (t: ReturnType<typeof convexTest>) =>
    (await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => (x as { members?: unknown }).members !== undefined,
      ),
    )) as Doc<"dtsTodos">;

  const seedOldWorld = async (t: ReturnType<typeof convexTest>) => {
    const tom = await withTom(t);
    const member = await tom.mutation(api.tts.createTodo, {
      statement: "book the movers",
    });
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "the move",
        brief: "why these belong together",
        members: [
          { todoId: member },
          { repo: "ComplexMultiTrigger", externalId: "cmt-001" },
        ],
        plan: [
          { text: "compare quotes", actor: "agent", status: "done", doneAt: 111, evidence: "notes.md" },
          { text: "pick one", actor: "tom", status: "open" },
        ],
        readiness: "prepared",
        status: "active",
        timingClass: "whenever",
        source: "batcher",
        createdAt: now,
        updatedAt: now,
      }),
    );
    const old = await oldV1Row(t);
    return { tom, member, old };
  };

  it("migrates one old batch into a batch row, chained tasks, and goals", async () => {
    const t = convexTest({ schema: v1Schema, modules });
    const { tom, member, old } = await seedOldWorld(t);
    // An old updatedAt on the member: the migration must not resurface it.
    await t.run(async (ctx) => ctx.db.patch(member, { updatedAt: 1000 }));

    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts).toEqual({
      batches: 1,
      tasks: 2,
      goals: 1,
      codeGoals: 1,
      missingMembers: 0,
      alreadyBound: 0,
    });

    const batch = await oneBatch(t);
    expect(batch.statement).toBe("the move");
    expect(batch.groundUpExplanation).toBe("why these belong together");
    expect(batch.status).toBe("active");
    expect(batch.tomTouchedAt).toBeUndefined();

    const contents = await batchTodos(t, batch._id);
    expect(contents).toHaveLength(4); // 2 tasks + 1 life goal + 1 code goal

    // Plan steps become tasks in a linear chain: step N needs step N-1.
    const first = byStatement(contents, "compare quotes")!;
    const second = byStatement(contents, "pick one")!;
    expect(first.kind).toBe("task");
    expect(first.source).toBe("migration");
    expect(first.needs).toBeUndefined();
    expect(first.status).toBe("done");
    expect(first.doneAt).toBe(111);
    expect(first.evidence).toBe("notes.md");
    expect(second.actor).toBe("tom");
    expect(second.status).toBe("active");
    expect(second.needs).toEqual([first._id]);

    // The life member is bound as a goal — statement and updatedAt untouched.
    const goal = (await t.run(async (ctx) =>
      ctx.db.get(member),
    )) as Doc<"dtsTodos">;
    expect(goal.kind).toBe("goal");
    expect(goal.batchId).toBe(batch._id);
    expect(goal.statement).toBe("book the movers");
    expect(goal.updatedAt).toBe(1000);

    // The code member becomes a goal ABOUT the upstream todo.
    const codeGoal = byStatement(
      contents,
      "ComplexMultiTrigger cmt-001 closed upstream",
    )!;
    expect(codeGoal.kind).toBe("goal");
    expect(codeGoal.condition).toBe(
      "ComplexMultiTrigger cmt-001 closed upstream",
    );
    expect(codeGoal.codeRepo).toBe("ComplexMultiTrigger");
    expect(codeGoal.codeExternalId).toBe("cmt-001");

    // Nothing is deleted: the old row is archived, pointing at its successor.
    const oldRow = (await t.run(async (ctx) =>
      ctx.db.get(old._id),
    )) as Doc<"dtsTodos">;
    expect(oldRow.status).toBe("archived");
    // Kept verbatim — read through the loose view, since the validator no
    // longer declares the field the row still holds.
    expect((oldRow as { members?: unknown[] }).members).toHaveLength(2);
    expect(oldRow.unarchiveCondition).toBe(
      `superseded by graph batch ${batch._id}`,
    );
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "graph-migrated")).toBe(true);
  });

  // witness: drop the unarchiveCondition/status filter in
  // internalMigrateToGraph — a second run would duplicate every batch.
  it("is idempotent", async () => {
    const t = convexTest({ schema: v1Schema, modules });
    await seedOldWorld(t);
    await t.mutation(internal.tts.internalMigrateToGraph, {});
    const again = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(again).toEqual({
      batches: 0,
      tasks: 0,
      goals: 0,
      codeGoals: 0,
      missingMembers: 0,
      alreadyBound: 0,
    });
    expect(await allBatches(t)).toHaveLength(1);

    // Even a REOPENED old batch is skipped — the pointer is the key, not the
    // status (reopening one would otherwise mint a second successor).
    const old = await oldV1Row(t);
    await t.run(async (ctx) => ctx.db.patch(old._id, { status: "active" }));
    const third = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(third.batches).toBe(0);
    expect(await allBatches(t)).toHaveLength(1);
  });

  it("leaves terminal old batches and plain todos alone", async () => {
    const t = convexTest({ schema: v1Schema, modules });
    const tom = await withTom(t);
    const plain = await tom.mutation(api.tts.createTodo, { statement: "solo" });
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "already done",
        brief: "b",
        members: [{ repo: "tom.quest", externalId: "tq-001" }],
        readiness: "prepared",
        status: "active",
        timingClass: "whenever",
        source: "batcher",
        createdAt: now,
        updatedAt: now,
      }),
    );
    const old = await oldV1Row(t);
    await t.run(async (ctx) => ctx.db.patch(old._id, { status: "done" }));

    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts.batches).toBe(0);
    expect(await allBatches(t)).toHaveLength(0);
    const solo = (await t.run(async (ctx) =>
      ctx.db.get(plain),
    )) as Doc<"dtsTodos">;
    expect(solo.kind).toBeUndefined(); // a legacy standalone todo, read as a task
    expect(solo.batchId).toBeUndefined();
  });

  // witness: patch batchId unconditionally in internalMigrateToGraph — a
  // member the planner already bound as a goal of a v2 batch would silently
  // leave it, and nothing anywhere would record the loss.
  it("never steals a member the planner already bound to a v2 batch", async () => {
    const t = convexTest({ schema: v1Schema, modules });
    const { member } = await seedOldWorld(t);
    // Bound straight through the database: the state the migration has to
    // survive is a row bound before the v1 batch was formed, or bound while
    // the batcher happened to be mid-run.
    const plannerBatch = await t.run(async (ctx) => {
      const batchId = await ctx.db.insert("batches", {
        statement: "already planned",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(member, { batchId, kind: "goal" as const });
      return batchId;
    });

    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts).toMatchObject({ batches: 1, goals: 0, alreadyBound: 1 });
    const goal = (await t.run(async (ctx) =>
      ctx.db.get(member),
    )) as Doc<"dtsTodos">;
    expect(goal.batchId).toBe(plannerBatch); // still the planner's batch
  });

  // witness: drop the goal-closing sweep from internalReplaceMirror — every
  // migrated code goal is an active todo nothing can ever complete, blocking
  // each of its dependents forever.
  it("a code goal closes when the mirror says the upstream todo closed", async () => {
    const t = convexTest({ schema: v1Schema, modules });
    await seedOldWorld(t);
    await t.mutation(internal.tts.internalMigrateToGraph, {});
    const codeGoal = (await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.codeExternalId === "cmt-001",
      ),
    )) as Doc<"dtsTodos">;
    expect(codeGoal.status).toBe("active");

    const row = {
      externalId: "cmt-001",
      tier: "a",
      statement: "the upstream todo",
      url: "https://example.invalid",
    };
    // Still open upstream: the goal stays open too.
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [{ ...row, status: "open" }],
    });
    expect(
      ((await t.run(async (ctx) => ctx.db.get(codeGoal._id))) as Doc<"dtsTodos">)
        .status,
    ).toBe("active");

    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [{ ...row, status: "closed" }],
    });
    const closed = (await t.run(async (ctx) =>
      ctx.db.get(codeGoal._id),
    )) as Doc<"dtsTodos">;
    expect(closed.status).toBe("done");
    expect(closed.doneAt).toBeGreaterThan(0);
  });

  it("counts a member whose todo has vanished instead of failing the run", async () => {
    const t = convexTest({ schema: v1Schema, modules });
    const { member } = await seedOldWorld(t);
    await t.run(async (ctx) => ctx.db.delete(member as Id<"dtsTodos">));
    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts).toMatchObject({ batches: 1, goals: 0, missingMembers: 1 });
  });
});

// ── The model tag ────────────────────────────────────────────────────────────
// The planner marks the task that needs a particular model. Absent is the norm
// (the scheduler resolves the fleet default), so the tag only ever has to
// survive: it is written once and must not evaporate on the next unchanged
// re-post. Since 2026-09-04 the tag spans two families — a Codex name is as
// storable as a Claude one.

describe("TTS plan graph: the model tag", () => {
  it("persists the planner's tag and preserves it when a re-post omits it", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, {
      tasks: [
        graphTask("design the trigger sweep", { model: "fable" }),
        graphTask("copy the config"),
      ],
    });
    const batch = await oneBatch(t);
    const first = await batchTodos(t, batch._id);
    expect(byStatement(first, "design the trigger sweep")?.model).toBe("fable");
    // The ordinary task carries nothing: the default is the absence of the
    // field, not a stored "opus".
    expect(byStatement(first, "copy the config")?.model).toBeUndefined();

    // witness: write `model: a.task.model` straight through in
    // internalStorePlanGraph — ctx.db.patch DELETES a field written as
    // undefined, so this re-post would silently demote the task to the default
    // model and the planner's judgment would be lost every two hours.
    const res = await storeGraph(t, {
      batchId: batch._id,
      tasks: [
        graphTask("design the trigger sweep"),
        graphTask("copy the config"),
      ],
    });
    const after = await batchTodos(t, batch._id);
    expect(byStatement(after, "design the trigger sweep")?.model).toBe("fable");
    // Nothing changed, so nothing was written.
    expect(res.unchanged).toBe(2);
    expect(res.updated).toBe(0);
  });

  // witness: narrow GRAPH_TASK's model back to v.literal("fable") in
  // convex/tts.ts — a Codex name would be refused by the validator and cost
  // the whole call, so one Codex-tagged task would lose the batch's graph.
  it("stores a codex model name as readily as a claude one", async () => {
    const t = convexTest({ schema, modules });
    await storeGraph(t, {
      tasks: [
        graphTask("port the harness", { model: "gpt-5.6-sol" }),
        graphTask("skim the logs", { model: "gpt-5.6-terra" }),
      ],
    });
    const rows = await batchTodos(t, (await oneBatch(t))._id);
    expect(byStatement(rows, "port the harness")?.model).toBe("gpt-5.6-sol");
    expect(byStatement(rows, "skim the logs")?.model).toBe("gpt-5.6-terra");
  });
});

// ── The planner's HTTP route (POST /tts/plan-graph) ──────────────────────────
// The body is model-written JSON, so the route PROJECTS it to the known shape
// before the mutation sees it. The one property that makes this sanitizer
// different from the batch one: a task's `needs` may address an earlier task by
// its POSITION in the payload, so positions are load-bearing and a malformed
// task must keep its slot.

describe("POST /tts/plan-graph", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const postGraph = (
    t: ReturnType<typeof convexTest>,
    body: unknown,
    // null = send no key at all. NOT `undefined`: passing undefined to an
    // optional parameter takes the default, which would send the real key.
    key: string | null = "s3cret",
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key !== null) headers["X-TTS-Key"] = key;
    return t.fetch("/tts/plan-graph", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };

  const validBody = {
    statement: "sign the lease",
    tasks: [{ statement: "call the landlord", actor: "agent" }],
  };

  it("rejects a missing or wrong key with 401", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect((await postGraph(t, validBody, null)).status).toBe(401);
    expect((await postGraph(t, validBody, "wrong")).status).toBe(401);
    expect((await allBatches(t)).length).toBe(0);
  });

  it("requires a statement and a tasks array by name", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    // The statement IS the batch's identity when no id is echoed, so an absent
    // one leaves nothing to store and nothing to name in a report.
    const noStatement = await postGraph(t, { tasks: [] });
    expect(noStatement.status).toBe(400);
    expect((await noStatement.json()).error).toContain("statement");
    const blank = await postGraph(t, { statement: "   ", tasks: [] });
    expect(blank.status).toBe(400);
    const noTasks = await postGraph(t, { statement: "sign the lease" });
    expect(noTasks.status).toBe(400);
    expect((await noTasks.json()).error).toContain("tasks");
    expect((await allBatches(t)).length).toBe(0);
  });

  it("stores a whole graph and reports what landed", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "  sign the lease  ",
      groundUpExplanation: "what this is, from the ground up",
      tasks: [
        { statement: "read the lease", actor: "tom" },
        { statement: "list the questions", actor: "agent", needs: [0] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 2, skipped: [] });
    const batch = await oneBatch(t);
    expect(batch.statement).toBe("sign the lease");
    const todos = await batchTodos(t, batch._id);
    expect(byStatement(todos, "read the lease")?.actor).toBe("tom");
    expect(byStatement(todos, "list the questions")?.needs).toEqual([
      byStatement(todos, "read the lease")?._id,
    ]);
  });

  // witness: in sanitizeGraphTask, filter a malformed task OUT of the array
  // instead of emptying its slot — every later index reference would shift by
  // one and silently name a different task, so "publish" below would land
  // needing "draft" instead of being skipped.
  it("keeps a malformed task's slot so index refs still name the right task", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "ship the paper",
      tasks: [
        { statement: "draft the section", actor: "agent" },
        { statement: "review it", actor: "nobody" }, // malformed: bad actor
        { statement: "publish", actor: "agent", needs: [1] },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Slot 1 was emptied, not removed, so slot 2's ref still means slot 1 —
    // and slot 1 was skipped, which takes its dependent with it.
    expect(body.droppedTasks).toEqual([
      {
        index: 1,
        statement: "review it",
        why: 'actor must be "tom" or "agent"',
      },
    ]);
    expect(body.created).toBe(1);
    const whys = (body.skipped as { ref: string; why: string }[]).map(
      (s) => s.why,
    );
    expect(whys).toContain("a task needs a statement");
    expect(whys.some((w) => w.includes("which was skipped"))).toBe(true);
    const todos = await batchTodos(t, (await oneBatch(t))._id);
    expect(todos.map((todo) => todo.statement)).toEqual(["draft the section"]);
    // The bad actor was never defaulted into a real row.
    expect(byStatement(todos, "review it")).toBeUndefined();
  });

  // witness: drop a single bad element out of `needs` instead of dropping the
  // task — the task would land missing an edge nobody asked to remove, and the
  // graph would report work ready that is not.
  it("drops the whole task when a need is neither an id nor an index", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "ship the paper",
      tasks: [
        { statement: "draft the section", actor: "agent" },
        { statement: "publish", actor: "agent", needs: [0, 1.5] },
      ],
    });
    const body = await res.json();
    expect(body.droppedTasks).toEqual([
      {
        index: 1,
        statement: "publish",
        why: "a need is a todo id or an earlier task's index",
      },
    ]);
    expect(body.created).toBe(1);
  });

  // witness: accept any string as the model — an unrecognized name would reach
  // the mutation's closed union and cost the WHOLE call, so one hallucinated
  // word would lose a batch's entire graph instead of one default. "gpt-9" is
  // not a model that exists; every name in SESSION_MODELS is carried, whichever
  // family it belongs to.
  it("carries any known model name and silently ignores any other", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "ship the paper",
      tasks: [
        { statement: "design the sweep", actor: "agent", model: "fable" },
        { statement: "port the harness", actor: "agent", model: "gpt-5.6-sol" },
        { statement: "run it", actor: "agent", model: "gpt-9" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(3);
    const todos = await batchTodos(t, (await oneBatch(t))._id);
    expect(byStatement(todos, "design the sweep")?.model).toBe("fable");
    expect(byStatement(todos, "port the harness")?.model).toBe("gpt-5.6-sol");
    // The task still exists — dropping the tag costs a default, not a task.
    expect(byStatement(todos, "run it")).toBeDefined();
    expect(byStatement(todos, "run it")?.model).toBeUndefined();
  });

  // ── mustNotBreak: Tom's line, goals only (the lifeos update) ─────────────
  // witness: drop the kind check from updateTodo — a task could carry a
  // must-not-break line, and the planner would read a constraint on nothing.
  it("mustNotBreak is written by Tom's door on a goal only, and read where the goal is", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const goalId = await tom.mutation(api.tts.createTodo, { statement: "the lease is signed" });
    const res = await postGraph(t, {
      statement: "get the apartment",
      goalIds: [goalId],
      tasks: [{ statement: "call the landlord", actor: "agent" }],
    });
    expect(res.status).toBe(200);
    await tom.mutation(api.tts.updateTodo, {
      id: goalId,
      mustNotBreak: "the current tenancy must not lapse before the new one starts",
    });
    const goal = await t.run(async (ctx) => ctx.db.get(goalId));
    expect(goal?.mustNotBreak).toBe(
      "the current tenancy must not lapse before the new one starts",
    );
    // A task refuses it.
    const task = byStatement(await batchTodos(t, (await oneBatch(t))._id), "call the landlord")!;
    await expect(
      tom.mutation(api.tts.updateTodo, { id: task._id, mustNotBreak: "anything" }),
    ).rejects.toThrow(/goal's field/);
    // null clears it.
    await tom.mutation(api.tts.updateTodo, { id: goalId, mustNotBreak: null });
    expect((await t.run(async (ctx) => ctx.db.get(goalId)))?.mustNotBreak).toBeUndefined();
  });

  // ── batches.needs (the lifeos update: the successor of path) ─────────────
  // witness: store `args.needs` without normalizing each id — a name that is
  // not a batch would block the batch forever, with nothing saying why.
  it("stores a batch's needs by id, drops what is not a batch, and preserves by omission", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const first = await postGraph(t, {
      statement: "freeze the branch",
      tasks: [{ statement: "tag it", actor: "agent" }],
    });
    const firstId = (await first.json()).batchId as string;
    const second = await postGraph(t, {
      statement: "cut the release",
      needs: [firstId, "not-a-batch"],
      tasks: [{ statement: "write the notes", actor: "agent" }],
    });
    const body = await second.json();
    expect(body.skipped).toEqual([{ ref: "not-a-batch", why: "needs names no batch" }]);
    const cut = (await allBatches(t)).find((b) => b.statement === "cut the release")!;
    expect(cut.needs).toEqual([firstId]);
    // A re-post that says nothing about needs keeps them; a batch cannot
    // need itself.
    const again = await postGraph(t, {
      batchId: cut._id,
      statement: "cut the release",
      tasks: [{ statement: "write the notes", actor: "agent" }],
    });
    expect((await again.json()).unchanged).toBe(1);
    expect((await allBatches(t)).find((b) => b._id === cut._id)!.needs).toEqual([firstId]);
    const selfish = await postGraph(t, {
      batchId: cut._id,
      statement: "cut the release",
      needs: [cut._id],
      tasks: [],
    });
    expect((await selfish.json()).skipped).toEqual([
      { ref: cut._id, why: "a batch cannot need itself" },
    ]);
    expect((await allBatches(t)).find((b) => b._id === cut._id)!.needs).toEqual([]);
  });

  // A needs B and B needs A passes a self-need check, and the scheduler's
  // batchNeedsMet then holds both back forever with nothing saying why. The
  // pen walks each need through the stored needs of every batch and refuses
  // the edge that would close a cycle, naming the batch it names.
  it("refuses a need that closes a cycle, direct or through another batch", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const store = async (body: Record<string, unknown>) =>
      (await (await postGraph(t, body)).json()) as {
        batchId: string;
        skipped: { ref: string; why: string }[];
      };
    const task = (s: string) => [{ statement: s, actor: "agent" }];
    const a = (await store({ statement: "a", tasks: task("do a") })).batchId;
    const b = (await store({ statement: "b", needs: [a], tasks: task("do b") })).batchId;
    const c = (await store({ statement: "c", needs: [b], tasks: task("do c") })).batchId;
    // Direct: a needs b, and b already needs a.
    const direct = await store({ batchId: a, statement: "a", needs: [b], tasks: task("do a") });
    expect(direct.skipped).toEqual([
      { ref: b, why: 'needs form a cycle: "b" already needs this batch' },
    ]);
    // Through another batch: a needs c, c needs b, b needs a.
    const transitive = await store({ batchId: a, statement: "a", needs: [c], tasks: task("do a") });
    expect(transitive.skipped).toEqual([
      { ref: c, why: 'needs form a cycle: "c" already needs this batch' },
    ]);
    const byId = new Map((await allBatches(t)).map((x) => [x._id as string, x]));
    expect(byId.get(a)!.needs).toEqual([]);
    expect(byId.get(b)!.needs).toEqual([a]);
    expect(byId.get(c)!.needs).toEqual([b]);
    // The other way round is no cycle: c may need a as well as b.
    const fine = await store({ batchId: c, statement: "c", needs: [b, a], tasks: task("do c") });
    expect(fine.skipped).toEqual([]);
    expect((await allBatches(t)).find((x) => x._id === c)!.needs).toEqual([b, a]);
  });

  // `path` is the retired sequencing — its edges are `needs` now. While the
  // box had not rolled out the route IGNORED it, so one stale field would not
  // cost a whole plan; worker/setup.sh has since run (main 6825608) and the
  // route refuses it by name instead, so a planner still writing paths shows
  // up in its own error rather than losing sequencing it thinks it wrote.
  //
  // witness: drop the check and this goes red — the payload would store a
  // batch with its sequencing quietly discarded.
  it("refuses the retired path by name and stores nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "ship the paper",
      path: { name: "research", index: 0, edge: "must" },
      tasks: [{ statement: "draft the section", actor: "agent" }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("path is retired");
    expect((await allBatches(t)).length).toBe(0);
  });

  it("binds goals, archives, and echoes a batch id", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const goalId = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "the lease is signed",
        readiness: "prepared",
        status: "active",
        timingClass: "whenever",
        source: "manual",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const first = await postGraph(t, {
      statement: "sign the lease",
      tasks: [{ statement: "call the landlord", actor: "agent" }],
      goalIds: [goalId, 7], // the non-string is dropped, the real id binds
    });
    const batchId = (await first.json()).batchId as string;
    expect(await t.run(async (ctx) => (await ctx.db.get(goalId))!.kind)).toBe(
      "goal",
    );
    const second = await postGraph(t, {
      batchId,
      statement: "sign the lease",
      tasks: [],
      archive: true,
    });
    expect((await second.json()).archived).toBe(1);
    expect((await oneBatch(t)).status).toBe("archived");
  });
});

// ── GET /tts/batch-context ───────────────────────────────────────────────────

describe("GET /tts/batch-context (planner half)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // witness: drop `writingStandard` from the payload — the planner (Node ESM on
  // a box that never loads TypeScript) cannot import it, so the one home would
  // silently become a second copy pasted into a worker prompt.
  it("serves the batches, the plan repairs, and the writing standard", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await storeGraph(t, { statement: "sign the lease" });
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomPublication", {
        key: "current",
        commit: "batch-context-test",
        committedAt: 1,
        pushed: true,
        operate: "operate layer reaches the planner",
        headers: [{ layers: ["operate"], header: "published map + operate" }],
      });
      await ctx.db.insert("dtsEvents", {
        at: Date.now(),
        kind: "plan-repair",
        data: { report: "reading the lease does not block drafting questions" },
      });
      // Noise on the same index, and a repair too old for the window: neither
      // reaches the planner.
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "surfaced" });
      await ctx.db.insert("dtsEvents", {
        at: Date.now() - 30 * 86_400_000,
        kind: "plan-repair",
        data: { report: "ancient" },
      });
    });
    const res = await t.fetch("/tts/batch-context", {
      method: "GET",
      headers: { "X-TTS-Key": "s3cret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The door serves the ASSEMBLED CONTEXT now, not two whole layers: the
    // stable prefix — the map and the operate rules — and the grant block,
    // naming what the planner may load. The assembler's exact output is pinned
    // in convex/ttsContext.test.ts; what this asserts is that the door serves
    // it under the field name plan-graphs.mjs asks for.
    const [prefix, grants] = body.writingStandard.split("\n\nSKILLS (WikiTom commit ");
    expect(prefix).toBe("published map + operate\n\noperate layer reaches the planner");
    expect(grants).toContain("granted:");
    // NEITHER the know layer NOR the write layer reaches the planner whole any
    // more: both became skills it loads by name. The map and the operate rules
    // do reach it, and that is the change.
    expect(body.writingStandard).not.toContain("know layer reaches the planner");
    expect(body.writingStandard).not.toContain("write layer reaches the planner");
    expect(body.vocabulary).toBe(TTS_CLOSED_VOCABULARY);
    expect(body.batches.map((b: Doc<"batches">) => b.statement)).toEqual([
      "sign the lease",
    ]);
    expect(body.planRepairs.map((e: Doc<"dtsEvents">) => e.data.report)).toEqual(
      ["reading the lease does not block drafting questions"],
    );
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

    const response = await t.fetch("/tts/batch-context", {
      method: "GET", headers: { "X-TTS-Key": "s3cret" },
    });
    expect(response.status).toBe(503);
    // The map goes to every run now, so `operate` is the first layer missing
    // from a publication that stored only `write`.
    await expect(response.json()).resolves.toEqual({ error: "model-of-tom layer operate is not stored" });
  });
});
