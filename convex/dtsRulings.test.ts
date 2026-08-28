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

describe("DTS unified rulings", () => {
  // witness: remove the requireTom call from listRulings or recordRuling in
  // convex/dtsRulings.ts
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.dtsRulings.listRulings, {})).rejects.toThrow();
    await expect(
      t.mutation(api.dtsRulings.recordRuling, {
        repo: "r",
        externalId: "x",
        verdict: "approve",
      }),
    ).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.dtsRulings.listRulings, {})).rejects.toThrow();
    await expect(
      user.mutation(api.dtsRulings.recordRuling, {
        repo: "r",
        externalId: "x",
        verdict: "approve",
      }),
    ).rejects.toThrow();
  });

  // witness: drop the `isLife === isCode` throw from recordRuling in
  // convex/dtsRulings.ts
  it("a ruling has exactly one subject", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "x" });
    // Zero subjects.
    await expect(
      tom.mutation(api.dtsRulings.recordRuling, { verdict: "approve" }),
    ).rejects.toThrow(/exactly one subject/);
    // Two subjects.
    await expect(
      tom.mutation(api.dtsRulings.recordRuling, {
        todoId,
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "approve",
      }),
    ).rejects.toThrow(/exactly one subject/);
    // Half a code subject.
    await expect(
      tom.mutation(api.dtsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        verdict: "approve",
      }),
    ).rejects.toThrow(/both repo and externalId/);
  });

  // witness: drop the `verdict === "revise" && !trimmed` throw in
  // convex/dtsRulings.ts
  it("revise requires the sentence", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.dtsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "revise",
      }),
    ).rejects.toThrow(/sentence/);
    // A whitespace-only sentence is no sentence.
    await expect(
      tom.mutation(api.dtsRulings.recordRuling, {
        repo: "ComplexMultiTrigger",
        externalId: "cmt-001",
        verdict: "revise",
        sentence: "   ",
      }),
    ).rejects.toThrow(/sentence/);
  });

  // witness: drop the readiness patch from recordRuling's revise branch in
  // convex/dtsRulings.ts
  it("revise on a life todo drops readiness to preparing", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, {
      statement: "email Ana Maria",
    });
    await tom.mutation(api.dts.updateTodo, {
      id: todoId,
      readiness: "ready-for-tom",
    });
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "revise",
      sentence: "  ask about the Friday slot instead  ",
    });
    const [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.readiness).toBe("preparing");
    const [ruling] = await tom.query(api.dtsRulings.listRulings, {});
    expect(ruling.subjectType).toBe("life");
    expect(ruling.sentence).toBe("ask about the Friday slot instead"); // trimmed
    expect(ruling.appliedAt).toBeUndefined(); // the preparer consumes it
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(
      events.some((e) => e.kind === "ruling" && e.todoId === todoId),
    ).toBe(true);
  });

  // witness: drop the applyStatusChange call from recordRuling's archive
  // branch in convex/dtsRulings.ts
  it("archive on a life todo archives it immediately", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, {
      statement: "renew the thing",
    });
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "archive",
      unarchiveCondition: "when the renewal window reopens",
    });
    const [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.status).toBe("archived");
    expect(todo.archivedAt).toBeDefined();
    expect(todo.unarchiveCondition).toBe("when the renewal window reopens");
    const [ruling] = await tom.query(api.dtsRulings.listRulings, {});
    expect(ruling.appliedAt).toBeDefined();
    expect(ruling.applyResult).toBe("status archived");
  });

  it("approve and session leave appliedAt unset", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "talk" });
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    await tom.mutation(api.dtsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "cmt-001",
      verdict: "approve",
    });
    const rulings = await tom.query(api.dtsRulings.listRulings, {});
    expect(rulings).toHaveLength(2);
    expect(rulings.every((r) => r.appliedAt === undefined)).toBe(true);
    expect(rulings.every((r) => r.applyResult === undefined)).toBe(true);
  });

  // witness: drop the `newest.get(...)?._id === row._id` clause from
  // internalPendingRulings in convex/dtsRulings.ts
  it("pending rulings exclude applied AND superseded rows, per subject key", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "life" });
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
    const pending = await t.query(internal.dtsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r._id).sort()).toEqual(
      [liveLife, liveCode, otherRepo].sort(),
    );
  });

  // witness: replace `normalized` with the raw string id in
  // internalMarkRulingApplied's patch call in convex/dtsRulings.ts
  it("marks a ruling applied and rejects a bad id by name", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dtsRulings.recordRuling, {
      repo: "tom.quest",
      externalId: "tq-004",
      verdict: "approve",
    });
    await t.mutation(internal.dtsRulings.internalMarkRulingApplied, {
      id,
      result: "https://github.com/Heffnt/tom.quest/pull/99",
    });
    const [row] = await tom.query(api.dtsRulings.listRulings, {});
    expect(row.appliedAt).toBeDefined();
    expect(row.applyResult).toBe("https://github.com/Heffnt/tom.quest/pull/99");
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "ruling-applied")).toBe(true);
    await expect(
      t.mutation(internal.dtsRulings.internalMarkRulingApplied, {
        id: "not-a-real-id",
        result: "x",
      }),
    ).rejects.toThrow(/Unknown ruling id/);
  });

  // witness: count ALL briefs (drop the `!ruled.has` filter) in
  // internalAwaitingRulingCount in convex/dtsRulings.ts
  it("awaiting-ruling count covers briefed code items with no ruling at all", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dtsCode.internalStoreBriefs, {
      briefs: [
        brief({ externalId: "ruled" }),
        brief({ externalId: "unruled-1" }),
        brief({ externalId: "unruled-2" }),
      ],
    });
    expect(
      await t.query(internal.dtsRulings.internalAwaitingRulingCount, {}),
    ).toBe(3);
    // Any ruling — even unapplied — takes the item off the pile.
    await tom.mutation(api.dtsRulings.recordRuling, {
      repo: "ComplexMultiTrigger",
      externalId: "ruled",
      verdict: "session",
    });
    expect(
      await t.query(internal.dtsRulings.internalAwaitingRulingCount, {}),
    ).toBe(2);
    // A ruling on the same externalId in ANOTHER repo does not count (the
    // key is the (repo, externalId) pair)...
    await tom.mutation(api.dtsRulings.recordRuling, {
      repo: "tom.quest",
      externalId: "unruled-1",
      verdict: "approve",
    });
    // ...and neither does a life ruling.
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "x" });
    await tom.mutation(api.dtsRulings.recordRuling, {
      todoId,
      verdict: "session",
    });
    expect(
      await t.query(internal.dtsRulings.internalAwaitingRulingCount, {}),
    ).toBe(2);
  });

  // witness: copy "defer" rows too (map defer to some verdict) in
  // internalMigrateCodeRulings in convex/dtsRulings.ts
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
      internal.dtsRulings.internalMigrateCodeRulings,
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
      internal.dtsRulings.internalMigrateCodeRulings,
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
});
