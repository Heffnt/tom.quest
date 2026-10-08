import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as tablesModule from "./jarvis/tables";
import { resolveId } from "./jarvis/tables";
import { insertCopied } from "../test/core-tables";

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

// The copy into `rulings` ran in production on 2026-09-26 and went with
// this stack; what stays is the reader of its legacyId. dtsRulings is no
// longer declared, so an old ruling's id is seeded through an untyped insert
// into the undeclared table, as production still stores such rows until the
// sweep (convex/ttsMigrationsSweep.ts) deletes them, and as the copy left it.
type Untyped = { insert(table: string, doc: Record<string, unknown>): Promise<string> };

describe("rulings under their plain name", () => {
  it("resolves a ruling by its new id or the id it had before the rename", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const old = await (ctx.db as unknown as Untyped).insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      const copied = await ctx.db.insert("rulings", { subjectType: "life", verdict: "archive", ruledAt: 1, legacyId: old });
      expect(await resolveId(ctx, "rulings", old)).toBe(copied);
      expect(await resolveId(ctx, "rulings", copied)).toBe(copied);
      expect(await resolveId(ctx, "rulings", "not-an-id")).toBeNull();
      const other = await ctx.db.insert("dtsTodos", todo);
      expect(await resolveId(ctx, "rulings", other as unknown as Id<"rulings">)).toBeNull();
      // An old id no copy carries names no ruling, with or without its old row.
      const uncopied = await (ctx.db as unknown as Untyped).insert("dtsRulings", { subjectType: "life", verdict: "approve", ruledAt: 2 });
      expect(await resolveId(ctx, "rulings", uncopied)).toBeNull();
    });
  });

  it("exports exactly the readers' helpers, the check and copyBack; no rulings count, copy, remap, follow, oldId or write back returns", () => {
    expect(Object.keys(tablesModule).sort()).toEqual([
      "copyBack",
      "copyBackPage",
      "copyBackPrunePage",
      "eitherId",
      "leftPage",
      "leftToRemap",
      "newestTodoEvents",
      "readTodo",
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

describe("copyBack: the old todos made to hold what the plain ones do", () => {
  it("carries plain todo edits and references back until leftToRemap reads zero", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run((ctx) => insertCopied(ctx, "todos", { ...todo, statement: "old", body: "a body" }));
    await t.action(internal.jarvis.tables.copyBack, {});
    await t.run(async (ctx) => {
      const oldTodo = (await resolveId(ctx, "todos", old.old))!;
      const fresh = await ctx.db.insert("todos", { ...todo, statement: "new", needs: [oldTodo] });
      await ctx.db.patch(oldTodo, { statement: "old, edited", body: undefined });
      await ctx.db.patch(fresh, { needs: [oldTodo] });
    });
    expect((await t.action(internal.jarvis.tables.leftToRemap, {})).zero).toBe(false);
    const out = await t.action(internal.jarvis.tables.copyBack, {});
    expect(out.todos).toMatchObject({ unresolved: 0 });
    expect((await t.action(internal.jarvis.tables.leftToRemap, {})).zero).toBe(true);
  });
});
