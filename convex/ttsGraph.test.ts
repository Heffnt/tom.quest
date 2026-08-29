import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { MAX_NEEDS, buildDoneSet, frontier, isReady } from "./ttsShared";

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
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    const last = rulings.find((r) => r.verdict === "archive")!;
    expect(last.applyResult).toBe("batch archived");
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

  it("counts a member whose todo has vanished instead of failing the run", async () => {
    const t = convexTest({ schema, modules });
    const { member } = await seedOldWorld(t);
    await t.run(async (ctx) => ctx.db.delete(member as Id<"dtsTodos">));
    const counts = await t.mutation(internal.tts.internalMigrateToGraph, {});
    expect(counts).toMatchObject({ batches: 1, goals: 0, missingMembers: 1 });
  });
});
