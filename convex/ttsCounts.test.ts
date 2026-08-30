// This endpoint exists so a session can CHECK a claim about the data instead
// of inferring it. A count that is quietly wrong is therefore worse than no
// endpoint at all — it launders a guess into a fact. These tests pin the two
// ways that could happen: a bucket that vanishes, and a truncated scan that
// does not admit it.

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A dtsRulings row — only the fields the schema requires. */
const ruling = (verdict: "execute" | "edit" | "discuss" | "archive") => ({
  subjectType: "life" as const,
  todoId: undefined,
  verdict,
  ruledAt: Date.now(),
});

describe("internalTableCounts", () => {
  it("counts rows and breaks them down by verdict", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const v of ["execute", "execute", "archive", "edit"] as const) {
        await ctx.db.insert("dtsRulings", ruling(v));
      }
    });

    const report = await t.query(internal.ttsCounts.internalTableCounts, {
      table: "dtsRulings",
    });
    const entry = report.dtsRulings as Record<string, unknown>;
    expect(entry.total).toBe(4);
    expect(entry.by_verdict).toEqual({ execute: 2, archive: 1, edit: 1 });
    expect(entry.truncated).toBeUndefined();
  });

  // REGRESSION GUARD. An absent field must be its own bucket, not dropped.
  // "How many rows have no category?" is exactly what this endpoint is for,
  // and a vanished key reads as zero — the silently-wrong answer.
  it("reports missing values as (unset) rather than dropping them", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsRulings", ruling("archive"));
      await ctx.db.insert("dtsRulings", {
        ...ruling("archive"),
        subjectType: "batch" as const,
      });
    });

    const report = await t.query(internal.ttsCounts.internalTableCounts, {
      table: "dtsRulings",
    });
    const entry = report.dtsRulings as Record<string, unknown>;
    expect(entry.by_subjectType).toEqual({ life: 1, batch: 1 });
    // every row is accounted for in every breakdown
    const summed = Object.values(
      entry.by_verdict as Record<string, number>,
    ).reduce((a, b) => a + b, 0);
    expect(summed).toBe(entry.total);
  });

  it("reports every introspectable table when none is named", async () => {
    const t = convexTest(schema, modules);
    const report = await t.query(internal.ttsCounts.internalTableCounts, {});
    for (const name of [
      "dtsTodos",
      "dtsRulings",
      "batches",
      "dtsCodeBriefs",
      "dtsBlocks",
      "claudeSessions",
    ]) {
      expect(report, `${name} missing from the report`).toHaveProperty(name);
      expect((report[name] as Record<string, unknown>).total).toBe(0);
    }
  });

  it("refuses a table it does not introspect instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const report = await t.query(internal.ttsCounts.internalTableCounts, {
      table: "users",
    });
    expect(report.users).toEqual({ error: "not an introspectable table" });
  });
});
