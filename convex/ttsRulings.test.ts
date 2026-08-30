import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

const brief = (over: Partial<{
  repo: string;
  externalId: string;
  sourceHash: string;
  brief: string;
  recommendation: "approve" | "needs-session" | "propose-archive" | "stale-replan";
  execClass: "box" | "needs-turing";
}> = {}) => ({
  repo: "ComplexMultiTrigger",
  externalId: "cmt-001",
  sourceHash: "hash-a",
  brief: "# Ground-up brief\nwhat, why, how",
  recommendation: "approve" as const,
  execClass: "box" as const,
  ...over,
});

describe("TTS unified rulings", () => {
  // witness: remove the requireTom call from listRulings or recordRuling in
  // convex/ttsRulings.ts
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.ttsRulings.listRulings, {})).rejects.toThrow();
    await expect(
      t.mutation(api.ttsRulings.recordRuling, {
        repo: "r",
        externalId: "x",
        verdict: "approve",
      }),
    ).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.ttsRulings.listRulings, {})).rejects.toThrow();
    await expect(
      user.mutation(api.ttsRulings.recordRuling, {
        repo: "r",
        externalId: "x",
        verdict: "approve",
      }),
    ).rejects.toThrow();
  });

  // witness: drop the `isLife === isCode` throw from recordRuling in
  // convex/ttsRulings.ts
  it("a ruling has exactly one subject", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    // Zero subjects.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, { verdict: "approve" }),
    ).rejects.toThrow(/exactly one subject/);
    // Two subjects.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        todoId,
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "approve",
      }),
    ).rejects.toThrow(/exactly one subject/);
    // Half a code subject.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        verdict: "approve",
      }),
    ).rejects.toThrow(/both repo and externalId/);
  });

  // witness: drop the `verdict === "revise" && !trimmed` throw in
  // convex/ttsRulings.ts
  it("revise requires the sentence", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "revise",
      }),
    ).rejects.toThrow(/sentence/);
    // A whitespace-only sentence is no sentence.
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "revise",
        sentence: "   ",
      }),
    ).rejects.toThrow(/sentence/);
  });

  // witness: drop the readiness patch from recordRuling's revise branch in
  // convex/ttsRulings.ts
  it("revise on a life todo drops readiness to preparing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "email Ana Maria",
    });
    await tom.mutation(api.tts.updateTodo, {
      id: todoId,
      readiness: "ready-for-tom",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "  ask about the Friday slot instead  ",
    });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.readiness).toBe("preparing");
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.subjectType).toBe("life");
    expect(ruling.sentence).toBe("ask about the Friday slot instead"); // trimmed
    expect(ruling.appliedAt).toBeUndefined(); // the preparer consumes it
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(
      events.some((e) => e.kind === "ruling" && e.todoId === todoId),
    ).toBe(true);
  });

  // witness: drop the applyStatusChange call from recordRuling's archive
  // branch in convex/ttsRulings.ts
  it("archive on a life todo archives it immediately", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "renew the thing",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "archive",
      unarchiveCondition: "when the renewal window reopens",
    });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("archived");
    expect(todo.archivedAt).toBeDefined();
    expect(todo.unarchiveCondition).toBe("when the renewal window reopens");
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeDefined();
    expect(ruling.applyResult).toBe("status archived");
  });

  it("session (life) and approve (code) leave appliedAt unset", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "talk" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      verdict: "approve",
    });
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(rulings).toHaveLength(2);
    expect(rulings.every((r) => r.appliedAt === undefined)).toBe(true);
    expect(rulings.every((r) => r.applyResult === undefined)).toBe(true);
  });

  // witness: drop the `verdict === "approve" && !isCode` throw from
  // insertRuling in convex/ttsRulings.ts — the verdict would come back on
  // subjects where nothing executes it (ruled 2026-08-30). BOTH doors are
  // asserted: the UI's recordRuling and the session agent's
  // internalRecordRuling, which is why the guard lives in the shared
  // insertRuling and not in the buttons.
  it("approve is refused on a life todo and on a batch, through both doors", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "go" });
    const batchId = await t.run(async (ctx) =>
      ctx.db.insert("batches", {
        statement: "the graph Tom read",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, { todoId, verdict: "approve" }),
    ).rejects.toThrow(/code-todo verdict/);
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, { batchId, verdict: "approve" }),
    ).rejects.toThrow(/code-todo verdict/);
    await expect(
      t.mutation(internal.ttsRulings.internalRecordRuling, {
        todoId,
        verdict: "approve",
      }),
    ).rejects.toThrow(/code-todo verdict/);
    await expect(
      t.mutation(internal.ttsRulings.internalRecordRuling, {
        batchId,
        verdict: "approve",
      }),
    ).rejects.toThrow(/code-todo verdict/);
    // Nothing was written on the way to any of the four throws, and the code
    // subject the verdict IS for still takes it.
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(0);
    expect((await t.run(async (ctx) => ctx.db.get(todoId)))?.tomTouchedAt).toBeUndefined();
    expect((await t.run(async (ctx) => ctx.db.get(batchId)))?.tomTouchedAt).toBeUndefined();
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      verdict: "approve",
    });
    expect(await tom.query(api.ttsRulings.listRulings, {})).toHaveLength(1);
  });

  // witness: drop the tomTouchedAt patch from insertRuling's life path in
  // convex/ttsRulings.ts — the batcher could rewrite a batch Tom just ruled on.
  it("session and archive each stamp tomTouchedAt (row frozen)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    // approve is not in this loop since 2026-08-30: it is refused on a life
    // subject, so it can no longer stamp anything.
    for (const verdict of ["session", "archive"] as const) {
      const todoId = await tom.mutation(api.tts.createTodo, {
        statement: `rule ${verdict}`,
      });
      let todo = await t.run(async (ctx) => ctx.db.get(todoId));
      expect(todo?.tomTouchedAt).toBeUndefined();
      await tom.mutation(api.ttsRulings.recordRuling, { todoId, verdict });
      todo = await t.run(async (ctx) => ctx.db.get(todoId));
      expect(todo?.tomTouchedAt).toBeDefined();
    }
  });

  // witness: drop the `verdict !== "revise"` guard from insertRuling's
  // tomTouchedAt patch in convex/ttsRulings.ts — revise hands the subject BACK
  // to the preparing agent, so freezing the row would strand every batch Tom
  // ever asked the batcher to redo.
  it("revise does NOT stamp tomTouchedAt — the row goes back to the agent", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "redo" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "split the travel bits out",
    });
    const todo = await t.run(async (ctx) => ctx.db.get(todoId));
    expect(todo?.tomTouchedAt).toBeUndefined();
    expect(todo?.readiness).toBe("preparing"); // the revise effect still landed
  });

  // witness: same guard — a revised batch must stay rewritable, which is the
  // whole point of the verdict.
  it("a revised batcher batch is still rewritable by the batcher", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          statement: "trip logistics",
          brief: "one errand, three tickets",
          members: [{ repo: "ComplexMultiTrigger", externalId: "cmt-001" }],
        },
      ],
    });
    const batch = await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.members !== undefined,
      ),
    );
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: batch!._id,
      verdict: "revise",
      sentence: "the flights do not belong with the visa",
    });
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          id: batch!._id,
          statement: "visa paperwork",
          brief: "regrouped per Tom's sentence",
          members: [{ repo: "ComplexMultiTrigger", externalId: "cmt-001" }],
        },
      ],
    });
    expect(res).toMatchObject({ created: 0, updated: 1, skipped: [] });
    const fresh = await t.run(async (ctx) => ctx.db.get(batch!._id));
    expect(fresh?.statement).toBe("visa paperwork");
    // A session ruling on the same batch DOES freeze it against the next run.
    // (This was an approve until 2026-08-30, when approve became a code-only
    // verdict; the freeze rule under test is "every verdict but revise", so
    // any of the remaining ones witnesses it.)
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: batch!._id,
      verdict: "session",
    });
    const after = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          id: batch!._id,
          statement: "rewrite attempt",
          brief: "x",
          members: [{ repo: "ComplexMultiTrigger", externalId: "cmt-001" }],
        },
      ],
    });
    expect(after.skipped.map((s) => s.why)).toEqual(["Tom-touched (frozen)"]);
  });

  // witness: change briefAwaitsRuling back to "any ruling clears the item" in
  // convex/ttsRulings.ts — a revise→re-brief cycle would never return the item.
  it("a re-brief NEWER than the live ruling puts the item back on the pile", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cycle" })],
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cycle",
      verdict: "revise",
      sentence: "narrower scope",
    });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(0);
    // The worker re-briefs after applying the revise — the fresh brief's
    // preparedAt is newer than the ruling, so the item awaits a fresh ruling.
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [brief({ externalId: "cycle", sourceHash: "hash-b" })],
    });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(1);
  });

  // witness: delete internalRecordRuling from convex/ttsRulings.ts — the
  // block-session pen (npx convex run under deploy credentials) breaks.
  it("internalRecordRuling is the session pen: same semantics, no identity", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "pen" });
    await t.mutation(internal.ttsRulings.internalRecordRuling, {
      todoId,
      verdict: "revise",
      sentence: "spoken in session",
    });
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.verdict).toBe("revise");
    expect(ruling.sentence).toBe("spoken in session");
    const todo = await t.run(async (ctx) =>
      ctx.db.get((await ctx.db.query("dtsTodos").collect())[0]._id),
    );
    expect(todo?.readiness).toBe("preparing");
    await expect(
      t.mutation(internal.ttsRulings.internalRecordRuling, {
        todoId: "not-a-real-id",
        verdict: "session",
      }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  // witness: drop the `newest.get(...)?._id === row._id` clause from
  // internalPendingRulings in convex/ttsRulings.ts
  it("pending rulings exclude applied AND superseded rows, per subject key", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "life" });
    const base = Date.now();
    const insert = (row: {
      subjectType: "life" | "code";
      todoId?: typeof todoId;
      repo?: string;
      externalId?: string;
      ruledAt: number;
      appliedAt?: number;
      applyResult?: string;
    }) =>
      // Written straight to the table, not through insertRuling: these stand
      // for STORED history, which still contains life-subject approves from
      // before the 2026-08-30 scoping. The pending feed must key and supersede
      // them the same as any other row.
      t.run(async (ctx) =>
        ctx.db.insert("dtsRulings", { verdict: "approve", ...row }),
      );
    // Life subject: older ruling superseded by a newer sibling.
    await insert({ subjectType: "life", todoId, ruledAt: base - 1000 });
    const liveLife = await insert({ subjectType: "life", todoId, ruledAt: base });
    // Code subject already applied — not pending.
    await insert({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "b",
      ruledAt: base,
      appliedAt: base + 1,
      applyResult: "sha deadbeef",
    });
    // Code subject keyed (repo, externalId): the newer row supersedes...
    await insert({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "c",
      ruledAt: base - 1000,
    });
    const liveCode = await insert({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      externalId: "c",
      ruledAt: base,
    });
    // ...but the same externalId in ANOTHER repo is a distinct subject.
    const otherRepo = await insert({
      subjectType: "code",
      repo: "tom.quest",
      externalId: "c",
      ruledAt: base - 500,
    });
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r._id).sort()).toEqual(
      [liveLife, liveCode, otherRepo].sort(),
    );
  });

  // witness: replace `normalized` with the raw string id in
  // internalMarkRulingApplied's patch call in convex/ttsRulings.ts
  it("marks a ruling applied and rejects a bad id by name", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "tom.quest",
      externalId: "tq-004",
      verdict: "approve",
    });
    await t.mutation(internal.ttsRulings.internalMarkRulingApplied, {
      id,
      result: "https://github.com/Heffnt/tom.quest/pull/99",
    });
    const [row] = await tom.query(api.ttsRulings.listRulings, {});
    expect(row.appliedAt).toBeDefined();
    expect(row.applyResult).toBe("https://github.com/Heffnt/tom.quest/pull/99");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "ruling-applied")).toBe(true);
    await expect(
      t.mutation(internal.ttsRulings.internalMarkRulingApplied, {
        id: "not-a-real-id",
        result: "x",
      }),
    ).rejects.toThrow(/Unknown ruling id/);
  });

  // witness: count ALL briefs (drop the `!ruled.has` filter) in
  // internalAwaitingRulingCount in convex/ttsRulings.ts
  it("awaiting-ruling count covers briefed code items with no ruling at all", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.ttsCode.internalStoreBriefs, {
      briefs: [
        brief({ externalId: "ruled" }),
        brief({ externalId: "unruled-1" }),
        brief({ externalId: "unruled-2" }),
      ],
    });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(3);
    // Any ruling — even unapplied — takes the item off the pile.
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "ruled",
      verdict: "session",
    });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(2);
    // A ruling on the same externalId in ANOTHER repo does not count (the
    // key is the (repo, externalId) pair)...
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "tom.quest",
      externalId: "unruled-1",
      verdict: "approve",
    });
    // ...and neither does a life ruling.
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    expect(
      await t.query(internal.ttsRulings.internalAwaitingRulingCount, {}),
    ).toBe(2);
  });

  // witness: copy "defer" rows too (map defer to some verdict) in
  // internalMigrateCodeRulings in convex/ttsRulings.ts
  it("migrates dtsCodeRulings under the verdict map, skipping defer, idempotently", async () => {
    const t = convexTest({ schema, modules });
    const base = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsCodeRulings", {
        repo: "ComplexMultiTrigger",
        externalId: "m-approve",
        ruling: "approve",
        ruledAt: base - 400,
        appliedAt: base - 300,
        applyResult: "sha deadbeef",
      });
      await ctx.db.insert("dtsCodeRulings", {
        repo: "ComplexMultiTrigger",
        externalId: "m-replan",
        ruling: "stale-replan",
        note: "replan against the new judge",
        ruledAt: base - 350,
      });
      await ctx.db.insert("dtsCodeRulings", {
        repo: "ComplexMultiTrigger",
        externalId: "m-session",
        ruling: "needs-session",
        ruledAt: base - 300,
      });
      await ctx.db.insert("dtsCodeRulings", {
        repo: "tom.quest",
        externalId: "m-archive",
        ruling: "propose-archive",
        ruledAt: base - 250,
      });
      await ctx.db.insert("dtsCodeRulings", {
        repo: "ComplexMultiTrigger",
        externalId: "m-defer",
        ruling: "defer",
        ruledAt: base - 200,
      });
    });
    const first = await t.mutation(
      internal.ttsRulings.internalMigrateCodeRulings,
      {},
    );
    expect(first).toEqual({ copied: 4, skippedDefer: 1, total: 5 });
    const rows = await t.run(async (ctx) => ctx.db.query("dtsRulings").collect());
    expect(rows).toHaveLength(4);
    const byExt = new Map(rows.map((r) => [r.externalId, r]));
    expect(byExt.get("m-approve")).toMatchObject({
      subjectType: "code",
      repo: "ComplexMultiTrigger",
      verdict: "approve",
      ruledAt: base - 400,
      appliedAt: base - 300,
      applyResult: "sha deadbeef",
    });
    expect(byExt.get("m-replan")).toMatchObject({
      verdict: "revise",
      sentence: "replan against the new judge",
    });
    expect(byExt.get("m-session")?.verdict).toBe("session");
    expect(byExt.get("m-archive")).toMatchObject({
      verdict: "archive",
      repo: "tom.quest",
    });
    expect(byExt.get("m-defer")).toBeUndefined(); // defer stays history-only
    // Second run copies nothing (idempotent), the old table is untouched.
    const second = await t.mutation(
      internal.ttsRulings.internalMigrateCodeRulings,
      {},
    );
    expect(second).toEqual({ copied: 0, skippedDefer: 1, total: 5 });
    expect(
      await t.run(async (ctx) => ctx.db.query("dtsRulings").collect()),
    ).toHaveLength(4);
    expect(
      await t.run(async (ctx) => ctx.db.query("dtsCodeRulings").collect()),
    ).toHaveLength(5);
  });

  // witness: reject `sentence` on any verdict but revise in insertRuling
  // (convex/dtsRulings.ts) and the approve/session assertions below go red.
  it("accepts a sentence on every verdict; revise still requires one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    // approve rides a CODE subject here — it is the only kind that takes it
    // (2026-08-30). session rides a life todo, so both subject types are
    // covered by the one test.
    const s = await tom.mutation(api.tts.createTodo, { statement: "talk to me" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-sentence",
      verdict: "approve",
      sentence: "yes, and keep the scope to the kitchen",
    });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: s,
      verdict: "session",
      sentence: "I want to see the numbers first",
    });
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(
      rulings.find((r) => r.externalId === "cmt-sentence")?.sentence,
    ).toBe("yes, and keep the scope to the kitchen");
    expect(rulings.find((r) => r.todoId === s)?.sentence).toBe(
      "I want to see the numbers first",
    );
    // A blank sentence is stored as absent, not as "".
    const b = await tom.mutation(api.tts.createTodo, { statement: "no note" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: b,
      verdict: "session",
      sentence: "   ",
    });
    expect(
      (await tom.query(api.ttsRulings.listRulings, {})).find(
        (r) => r.todoId === b,
      )?.sentence,
    ).toBeUndefined();
    // revise is still the one verdict that cannot go without one.
    const r = await tom.mutation(api.tts.createTodo, { statement: "redo" });
    await expect(
      tom.mutation(api.ttsRulings.recordRuling, { todoId: r, verdict: "revise" }),
    ).rejects.toThrow(/sentence verdict/);
  });

  // witness: drop the `unarchiveCondition ?? trimmed` fallback in insertRuling
  // — the archive note would stop meaning "propose it back when…".
  it("an archive sentence IS the unarchive condition", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "shelve it" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: id,
      verdict: "archive",
      sentence: "when the lease renews",
    });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("archived");
    expect(todo.unarchiveCondition).toBe("when the lease renews");
    // An explicit unarchiveCondition still wins over the sentence.
    const other = await tom.mutation(api.tts.createTodo, { statement: "other" });
    await tom.mutation(api.ttsRulings.recordRuling, {
      todoId: other,
      verdict: "archive",
      sentence: "a note",
      unarchiveCondition: "the explicit one",
    });
    const todos = await tom.query(api.tts.listTodos, {});
    expect(todos.find((x) => x._id === other)?.unarchiveCondition).toBe(
      "the explicit one",
    );
  });
});
