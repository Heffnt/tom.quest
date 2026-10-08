import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { SWEPT_TABLES, sweptTables } from "./ttsMigrationsSweep";

// The tables the record's table sweep (design section 12.2) took out of the
// schema, emptied by internalPurgeSweptTables (convex/ttsMigrationsSweep.ts).
// The harness the production dry run is read against.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type Untyped = { insert(table: string, doc: Record<string, unknown>): Promise<string> };

describe("internalPurgeSweptTables", () => {
  it("counts each table's rows on a dry run and deletes nothing", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      await db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      await db.insert("gpuPoolStatus", { ranAt: 1, jobsFetchOk: true, orphansCancelled: 0, pools: [] });
      await db.insert("signoffs", { text: "t" });
      await db.insert("signoffs", { text: "u" });
    });
    const dry = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(Object.keys(dry.counts).sort()).toEqual([...SWEPT_TABLES].sort());
    expect(dry.counts).toMatchObject({ dtsRulings: 1, gpuPoolStatus: 1, signoffs: 2, vocabulary: 0, dayLogEntries: 0 });
    expect(dry.more).toEqual([]);
    const again = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { dryRun: true });
    expect(again.counts).toEqual(dry.counts);
  });

  it("deletes at most the page size of each table per real run, and says which hold more", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      for (let i = 0; i < 3; i++) await db.insert("dayLogItems", { text: `i${i}` });
      for (let i = 0; i < 2; i++) await db.insert("ttsVocabulary", { key: `k${i}` });
      await db.insert("runMaterializeRequests", { runId: "r" });
    });
    const first = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { pageSize: 2 });
    expect(first.counts).toMatchObject({ dayLogItems: 2, ttsVocabulary: 2, runMaterializeRequests: 1 });
    expect(first.more).toEqual(["dayLogItems"]);
    const second = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { pageSize: 2 });
    expect(second.counts).toMatchObject({ dayLogItems: 1, ttsVocabulary: 0, runMaterializeRequests: 0 });
    expect(second.more).toEqual([]);
    const after = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { dryRun: true });
    expect(Object.values(after.counts).every((n) => n === 0)).toBe(true);
  });

  it("refuses a declared table and leaves its rows", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("rulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
    });
    await expect(
      t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { tables: ["rulings"] }),
    ).rejects.toThrow(/rulings is declared in the schema/);
    expect(await t.run(async (ctx) => (await ctx.db.query("rulings").collect()).length)).toBe(1);
    // A name on neither list is refused as well.
    await expect(
      t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { tables: ["somethingElse"] }),
    ).rejects.toThrow(/not one of the swept tables/);
  });

  it("lists no table the schema declares", () => {
    expect(sweptTables(SWEPT_TABLES, schema.tables)).toEqual([...SWEPT_TABLES]);
    expect(() => sweptTables(["dtsRulings", "todos"], schema.tables)).toThrow(/todos is declared/);
  });
});
