import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  MAX_NEEDS,
  WRITING_STANDARD,
  buildDoneSet,
  frontier,
  isReady,
} from "./ttsShared";

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
    model: "fable";
  }> = {},
) => ({ statement, actor: "agent" as const, ...over });

const storeGraph = (
  t: ReturnType<typeof convexTest>,
  over: Partial<{
    batchId: string;
    statement: string;
    groundUpExplanation: string;
    path: { name: string; index: number; edge?: "must" | "helps" };
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
  const todo = (
    _id: string,
    status: Doc<"dtsTodos">["status"],
    needs?: string[],
  ) => ({ _id, status, needs });

  // witness: change isReady to ignore `needs` in convex/ttsShared.ts — every
  // blocked todo would report ready and the frontier would be the whole batch.
  it("ready = active AND every need done", () => {
    const rows = [
      todo("a", "done"),
      todo("b", "active", ["a"]),
      todo("c", "active", ["b"]),
    ];
    const done = buildDoneSet(rows);
    expect(isReady(rows[1], done)).toBe(true);
    expect(isReady(rows[2], done)).toBe(false);
    // No needs at all: ready the moment it is active.
    expect(isReady(todo("d", "active"), done)).toBe(true);
    // EVERY need, not some: one unmet need is enough to block.
    expect(isReady(todo("e", "active", ["a", "b"]), done)).toBe(false);
  });

  // witness: drop "archived" from buildDoneSet — a set-aside need would block
  // the rest of its graph forever.
  it("archived counts as done, matching memberProgress", () => {
    const rows = [todo("a", "archived"), todo("b", "active", ["a"])];
    expect(buildDoneSet(rows)).toEqual(new Set(["a"]));
    expect(isReady(rows[1], buildDoneSet(rows))).toBe(true);
  });

  // witness: let isReady accept status "waiting" — a sleeping todo would be
  // offered as ready work.
  it("waiting, done, and archived todos are never ready", () => {
    const done = new Set<string>();
    expect(isReady(todo("a", "waiting"), done)).toBe(false);
    expect(isReady(todo("b", "done"), done)).toBe(false);
    expect(isReady(todo("c", "archived"), done)).toBe(false);
  });

  it("frontier is the ready list, in the order given", () => {
    const rows = [
      todo("a", "done"),
      todo("b", "active", ["a"]),
      todo("c", "active", ["b"]),
      todo("d", "waiting"),
      todo("e", "active"),
    ];
    expect(frontier(rows).map((r) => r._id)).toEqual(["b", "e"]);
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
      path: { name: "housing", index: 0 },
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
    expect(batch.path).toEqual({ name: "housing", index: 0 });
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
    expect(frontier(todos).map((x) => x.statement)).toEqual([
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
    expect(await batchTodos(t, res.batchId!)).toHaveLength(1);
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

    // A v1 batch row is refused as a task AND as a goal (no batch-in-batch).
    await t.mutation(internal.tts.internalStoreBatches, {
      batches: [{ statement: "v1", brief: "b", members: [{ todoId: mine }] }],
    });
    const v1 = (await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.members !== undefined,
      ),
    )) as Doc<"dtsTodos">;
    const nested = await storeGraph(t, {
      batchId: batch._id,
      tasks: [graphTask("as a task", { id: v1._id })],
      goalIds: [v1._id],
    });
    expect(nested.goalsBound).toBe(0);
    expect(nested.skipped).toEqual([
      { ref: "as a task", why: "is a v1 batch" },
      { ref: v1._id, why: "is a v1 batch" },
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
    expect(last.applyResult).toBe("batch archived");

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

describe("TTS migration to the graph (internalMigrateToGraph)", () => {
  const seedOldWorld = async (t: ReturnType<typeof convexTest>) => {
    const tom = await withTom(t);
    const member = await tom.mutation(api.tts.createTodo, {
      statement: "book the movers",
    });
    await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
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
        },
      ],
    });
    const old = (await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.members !== undefined,
      ),
    )) as Doc<"dtsTodos">;
    return { tom, member, old };
  };

  it("migrates one old batch into a batch row, chained tasks, and goals", async () => {
    const t = convexTest({ schema, modules });
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
    expect(oldRow.members).toHaveLength(2); // kept verbatim
    expect(oldRow.unarchiveCondition).toBe(
      `superseded by graph batch ${batch._id}`,
    );
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "graph-migrated")).toBe(true);
  });

  // witness: drop the unarchiveCondition/status filter in
  // internalMigrateToGraph — a second run would duplicate every batch.
  it("is idempotent", async () => {
    const t = convexTest({ schema, modules });
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
    const old = (await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.members !== undefined,
      ),
    )) as Doc<"dtsTodos">;
    await t.run(async (ctx) => ctx.db.patch(old._id, { status: "active" }));
    const third = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(third.batches).toBe(0);
    expect(await allBatches(t)).toHaveLength(1);
  });

  it("leaves terminal old batches and plain todos alone", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const plain = await tom.mutation(api.tts.createTodo, { statement: "solo" });
    await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          statement: "already done",
          brief: "b",
          members: [{ repo: "tom.quest", externalId: "tq-001" }],
        },
      ],
    });
    const old = (await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.members !== undefined,
      ),
    )) as Doc<"dtsTodos">;
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
    const t = convexTest({ schema, modules });
    const { member } = await seedOldWorld(t);
    const bound = await t.mutation(internal.tts.internalStorePlanGraph, {
      statement: "already planned",
      tasks: [],
      goalIds: [member],
    });
    expect(bound.goalsBound).toBe(1);

    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts).toMatchObject({ batches: 1, goals: 0, alreadyBound: 1 });
    const goal = (await t.run(async (ctx) =>
      ctx.db.get(member),
    )) as Doc<"dtsTodos">;
    expect(goal.batchId).toBe(bound.batchId); // still the planner's batch
  });

  // witness: drop the batchId guard from validateBatchMembers — the migration
  // archives the v1 row, which frees its members from the batcher's occupied
  // map, and the still-running v1 batcher re-groups the rows it just migrated
  // (one todo in a v1 batch AND a v2 batch at once).
  it("the v1 batcher can never claim a row that lives in a graph batch", async () => {
    const t = convexTest({ schema, modules });
    const { member } = await seedOldWorld(t);
    await t.mutation(internal.tts.internalMigrateToGraph, {});

    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        { statement: "regrouped", brief: "b", members: [{ todoId: member }] },
      ],
    });
    expect(res.created).toBe(0);
    expect(res.skipped[0].why).toMatch(/belongs to a graph batch/);
  });

  // witness: drop the goal-closing sweep from internalReplaceMirror — every
  // migrated code goal is an active todo nothing can ever complete, blocking
  // each of its dependents forever.
  it("a code goal closes when the mirror says the upstream todo closed", async () => {
    const t = convexTest({ schema, modules });
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
    const t = convexTest({ schema, modules });
    const { member } = await seedOldWorld(t);
    await t.run(async (ctx) => ctx.db.delete(member as Id<"dtsTodos">));
    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts).toMatchObject({ batches: 1, goals: 0, missingMembers: 1 });
  });
});

// ── The model tag ────────────────────────────────────────────────────────────
// The planner marks the rare task whose difficulty warrants the stronger model.
// Absent is the default and the norm (workers run Opus), so the tag only ever
// has to survive: it is written once and must not evaporate on the next
// unchanged re-post.

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
      path: { name: "housing", index: 0, edge: "must" },
      tasks: [
        { statement: "read the lease", actor: "tom" },
        { statement: "list the questions", actor: "agent", needs: [0] },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 2, skipped: [] });
    const batch = await oneBatch(t);
    expect(batch.statement).toBe("sign the lease");
    expect(batch.path).toEqual({ name: "housing", index: 0, edge: "must" });
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

  // witness: accept any string as the model — an unrecognized tier name would
  // reach the mutation's validator and cost the WHOLE call, so one hallucinated
  // word would lose a batch's entire graph instead of one default.
  it("carries the fable tag and silently ignores any other tier", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "ship the paper",
      tasks: [
        { statement: "design the sweep", actor: "agent", model: "fable" },
        { statement: "run it", actor: "agent", model: "gpt-9" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(2);
    const todos = await batchTodos(t, (await oneBatch(t))._id);
    expect(byStatement(todos, "design the sweep")?.model).toBe("fable");
    expect(byStatement(todos, "run it")?.model).toBeUndefined();
  });

  // witness: pass a half-formed path straight through — the mutation's
  // validator would refuse the object and cost the whole call, when an absent
  // path simply preserves whatever is stored.
  it("drops a broken path whole rather than costing the call", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const res = await postGraph(t, {
      statement: "ship the paper",
      path: { name: "research" }, // no index
      tasks: [{ statement: "draft the section", actor: "agent" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(1);
    expect((await oneBatch(t)).path).toBeUndefined();
  });

  it("binds goals, archives, and echoes a batch id", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const goalId = await t.run(async (ctx) =>
      ctx.db.insert("dtsTodos", {
        statement: "the lease is signed",
        readiness: "ready-for-tom",
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
    expect(body.writingStandard).toBe(WRITING_STANDARD);
    expect(body.batches.map((b: Doc<"batches">) => b.statement)).toEqual([
      "sign the lease",
    ]);
    expect(body.planRepairs.map((e: Doc<"dtsEvents">) => e.data.report)).toEqual(
      ["reading the lease does not block drafting questions"],
    );
  });
});
