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

  it("deletes at most the page size in all per real run, table by table, and says which still hold rows", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      for (let i = 0; i < 3; i++) await db.insert("dayLogItems", { text: `i${i}` });
      for (let i = 0; i < 2; i++) await db.insert("ttsVocabulary", { key: `k${i}` });
      await db.insert("runMaterializeRequests", { runId: "r" });
    });
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const run = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { pageSize: 2 });
      runs.push(run);
      if (run.more.length === 0) break;
    }
    // Six rows at two a call: three calls, each deleting two in all, the last
    // with nothing left over.
    expect(runs.map((run) => total(run.counts))).toEqual([2, 2, 2]);
    expect(runs[0].more.length).toBeGreaterThan(0);
    expect(runs.at(-1)?.more).toEqual([]);
    const after = await t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { dryRun: true });
    expect(Object.values(after.counts).every((n) => n === 0)).toBe(true);
  });

  it("refuses a page size outside 1 to 1000", async () => {
    const t = convexTest({ schema, modules });
    for (const pageSize of [0, 1001, 2.5]) {
      await expect(t.mutation(internal.ttsMigrationsSweep.internalPurgeSweptTables, { pageSize })).rejects.toThrow(/pageSize/);
    }
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
