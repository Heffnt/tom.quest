import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as tablesModule from "./jarvis/tables";
import { resolveId, todoIdForms } from "./jarvis/tables";
import { oldId } from "../test/core-tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

const todo = {
  statement: "a todo",
  readiness: "unprepared" as const,
  status: "active" as const,
  timingClass: "whenever" as const,
  source: "test",
  createdAt: 1,
  updatedAt: 1,
};

describe("the old tables are gone", () => {
  const OLD = ["dtsTodos", "dtsBlocks", "dtsTimeNotes"];

  it("declares no old table, and no id into one", () => {
    const tables = schema.tables as unknown as Record<string, { validator: { json: unknown } }>;
    for (const name of OLD) expect(Object.keys(tables)).not.toContain(name);
    const exported = JSON.stringify(Object.values(tables).map((table) => table.validator.json));
    expect(exported).toContain('"tableName":"todos"');
    for (const name of OLD) expect(exported).not.toContain(`"tableName":"${name}"`);
  });

  it("a stored todo reference takes the plain id or an old one; a block and a time note take only a todos id", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const legacy = oldId();
      const todoId = await ctx.db.insert("todos", { ...todo, legacyId: legacy });
      for (const stored of [todoId, legacy]) {
        await ctx.db.insert("rulings", { subjectType: "life", todoId: stored, verdict: "approve", ruledAt: 1 });
        await ctx.db.insert("dtsEvents", { at: 1, kind: "opened", todoId: stored });
      }
      const blockId = await ctx.db.insert("blocks", { start: 1, end: 2, todoId, createdAt: 1 });
      await ctx.db.insert("timeNotes", { text: "t", todoId, blockId, status: "pending", createdAt: 1 });
      await expect(ctx.db.insert("blocks", { start: 1, end: 2, todoId: legacy as Id<"todos">, createdAt: 1 })).rejects.toThrow();
      await expect(ctx.db.insert("timeNotes", { text: "t", todoId: legacy as Id<"todos">, status: "pending", createdAt: 1 })).rejects.toThrow();
    });
  });

  it("an old todo id resolves through the plain row's legacyId; one no row carries names nothing", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const legacy = oldId();
      const todoId = await ctx.db.insert("todos", { ...todo, legacyId: legacy });
      expect(await resolveId(ctx, "todos", legacy)).toBe(todoId);
      expect(await resolveId(ctx, "todos", todoId)).toBe(todoId);
      expect(await resolveId(ctx, "todos", oldId())).toBeNull();
      expect(await todoIdForms(ctx, legacy)).toEqual([todoId, legacy]);
      const fresh = await ctx.db.insert("todos", todo);
      expect(await todoIdForms(ctx, fresh)).toEqual([fresh]);
    });
  });
});

// The copy into `rulings` ran in production on 2026-09-26 and went with
// this stack; what stays is the reader of its legacyId and the count the
// old table is emptied on. A copied row is seeded here as the copy left it.
describe("rulings under their plain name", () => {
  it("resolves a ruling by its new id or the id it had before the rename", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const old = await ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      const copied = await ctx.db.insert("rulings", { subjectType: "life", verdict: "archive", ruledAt: 1, legacyId: old });
      expect(await resolveId(ctx, "rulings", old)).toBe(copied);
      expect(await resolveId(ctx, "rulings", copied)).toBe(copied);
      expect(await resolveId(ctx, "rulings", "not-an-id")).toBeNull();
      const other = await ctx.db.insert("todos", todo);
      expect(await resolveId(ctx, "rulings", other)).toBeNull();
    });
  });

  it("counts rulings beside dtsRulings, and the rows the copy brought", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const a = await ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      await ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "approve", ruledAt: 2 });
      await ctx.db.insert("rulings", { subjectType: "life", verdict: "archive", ruledAt: 1, legacyId: a });
      // Written by the new code: counted, not copied.
      await ctx.db.insert("rulings", { subjectType: "life", verdict: "revise", sentence: "s", ruledAt: 3 });
    });
    expect(await t.action(internal.jarvis.tables.counts, {})).toEqual({ rulings: { old: 2, new: 2, copied: 1, whole: false } });
  });

  it("exports exactly the rulings count, the readers' helpers and the purge; no copy, check or way back returns", () => {
    expect(Object.keys(tablesModule).sort()).toEqual([
      "clearBlock",
      "clearBlockPage",
      "coreId",
      "countPage",
      "counts",
      "newestTodoEvents",
      "oldCountPage",
      "purgeOldPage",
      "purgeOldTables",
      "recordPurge",
      "resolveId",
      "todoEvents",
      "todoHasEventSince",
      "todoIdForms",
      "todoReader",
      "todoRulings",
      "withPlainTodoIds",
    ]);
  });
});
