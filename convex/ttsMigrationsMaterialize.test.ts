import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// The materialize job's request table, undeclared since its removal (design
// section 13.2), emptied by internalPurgeMaterializeRequests. The harness the
// production dry run is read against.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type Untyped = { insert(table: string, doc: Record<string, unknown>): Promise<string> };

const request = (n: number) => ({
  runId: `claude:box:request-${n}`, requestedBy: "worker", requestedAt: n, status: "failed",
  servedAt: n + 1, reason: "parse produced no rows", slice: 1,
});

describe("internalPurgeMaterializeRequests", () => {
  it("counts the rows on a dry run and deletes them on a real one", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      await db.insert("runMaterializeRequests", request(1));
      await db.insert("runMaterializeRequests", request(2));
    });
    const purge = internal.ttsMigrationsMaterialize.internalPurgeMaterializeRequests;
    expect(await t.mutation(purge, { dryRun: true })).toEqual({ dryRun: true, count: 2, more: false });
    expect(await t.mutation(purge, { dryRun: true })).toEqual({ dryRun: true, count: 2, more: false });
    expect(await t.mutation(purge, {})).toEqual({ dryRun: false, count: 2, more: false });
    expect(await t.mutation(purge, { dryRun: true })).toEqual({ dryRun: true, count: 0, more: false });
  });

  it("takes a page and says the table holds more", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      for (let n = 0; n < 3; n++) await db.insert("runMaterializeRequests", request(n));
    });
    const purge = internal.ttsMigrationsMaterialize.internalPurgeMaterializeRequests;
    expect(await t.mutation(purge, { pageSize: 2 })).toEqual({ dryRun: false, count: 2, more: true });
    expect(await t.mutation(purge, { pageSize: 2 })).toEqual({ dryRun: false, count: 1, more: false });
  });
});
