import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// The Jarvis calendar's eight tables, undeclared since its removal (design
// section 13.2), emptied by internalPurgeCalendarTables (convex/
// ttsMigrations.ts). The harness the production dry run is read against.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type Untyped = { insert(table: string, doc: Record<string, unknown>): Promise<string> };

describe("internalPurgeCalendarTables", () => {
  it("counts each table's rows on a dry run and deletes them on a real one", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      await db.insert("ttsCalendarEvents", { feed: "a", uid: "u", title: "x", start: 1, end: 2, allDay: false, syncedAt: 1 });
      await db.insert("ttsCalendarEvents", { feed: "a", uid: "v", title: "y", start: 3, end: 4, allDay: false, syncedAt: 1 });
      await db.insert("timeNotes", { text: "t", status: "pending", createdAt: 1 });
    });
    const dry = await t.mutation(internal.ttsMigrations.internalPurgeCalendarTables, { dryRun: true });
    expect(dry.counts).toMatchObject({ ttsCalendarEvents: 2, timeNotes: 1, calendar: 0, blocks: 0 });
    expect(dry.more).toEqual([]);
    const again = await t.mutation(internal.ttsMigrations.internalPurgeCalendarTables, { dryRun: true });
    expect(again.counts.ttsCalendarEvents).toBe(2);
    const real = await t.mutation(internal.ttsMigrations.internalPurgeCalendarTables, {});
    expect(real.counts).toMatchObject({ ttsCalendarEvents: 2, timeNotes: 1 });
    const after = await t.mutation(internal.ttsMigrations.internalPurgeCalendarTables, { dryRun: true });
    expect(Object.values(after.counts).every((n) => n === 0)).toBe(true);
  });

  it("takes a page per table and says which hold more", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const db = ctx.db as unknown as Untyped;
      for (let i = 0; i < 3; i++) await db.insert("repeats", { statement: `r${i}`, daysOfWeek: [], active: true, createdAt: 1, updatedAt: 1 });
    });
    const first = await t.mutation(internal.ttsMigrations.internalPurgeCalendarTables, { pageSize: 2 });
    expect(first.counts.repeats).toBe(2);
    expect(first.more).toEqual(["repeats"]);
    const second = await t.mutation(internal.ttsMigrations.internalPurgeCalendarTables, { pageSize: 2 });
    expect(second.counts.repeats).toBe(1);
    expect(second.more).toEqual([]);
  });
});
