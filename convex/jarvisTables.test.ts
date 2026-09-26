import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as tablesModule from "./jarvis/tables";
import { resolveId } from "./jarvis/tables";

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
      const other = await ctx.db.insert("dtsTodos", todo);
      expect(await resolveId(ctx, "rulings", other as unknown as Id<"rulings">)).toBeNull();
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

  it("has no copy or remap left to run", () => {
    expect(Object.keys(tablesModule).sort()).toEqual(["countPage", "counts", "resolveId"]);
  });
});
