import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

// The old tables emptied once (convex/jarvis/tables.ts purgeOldTables): only
// when each table holds exactly the rows the off-box copy counts, and then
// every row, whichever page it falls on. The schema no longer declares
// dtsTodos, dtsBlocks, dtsTimeNotes or dtsRulings; like the deployment,
// convex-test keeps an undeclared table's rows, so the fixtures write them
// through a harness typed without the schema.

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

/** Old rows as the old tables held them: `todos` todos, one block and one
 *  time note on the first, and `rulings` rulings, the first on the first todo. */
async function seed(t: ReturnType<typeof convexTest>, todos: number, rulings = 5) {
  await t.run(async (ctx) => {
    const first = await ctx.db.insert("dtsTodos", todo);
    for (let i = 1; i < todos; i++) await ctx.db.insert("dtsTodos", { ...todo, statement: `todo ${i}` });
    const block = await ctx.db.insert("dtsBlocks", { start: 1, end: 2, todoId: first, createdAt: 1 });
    await ctx.db.insert("dtsTimeNotes", { text: "move it", todoId: first, blockId: block, status: "pending", createdAt: 1 });
    for (let i = 0; i < rulings; i++) {
      await ctx.db.insert("dtsRulings", { subjectType: "life", ...(i === 0 ? { todoId: first } : {}), verdict: "approve", ruledAt: i + 1 });
    }
  });
}

const rows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ({
    dtsTodos: (await ctx.db.query("dtsTodos").collect()).length,
    dtsBlocks: (await ctx.db.query("dtsBlocks").collect()).length,
    dtsTimeNotes: (await ctx.db.query("dtsTimeNotes").collect()).length,
    dtsRulings: (await ctx.db.query("dtsRulings").collect()).length,
  }));

describe("purgeOldTables", () => {
  it("deletes nothing when a table holds a row the copy does not count", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, 3);
    const out = await t.action(internal.jarvis.tables.purgeOldTables, {
      expect: { dtsTodos: 2, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 },
    });
    expect(out).toMatchObject({ purged: false, counted: { dtsTodos: 3, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 }, mismatched: ["dtsTodos"] });
    expect(await rows(t)).toEqual({ dtsTodos: 3, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 });
    expect(await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).toEqual([]);
  });

  it("deletes nothing when dtsRulings holds a ruling the copy does not count", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, 2, 6);
    const out = await t.action(internal.jarvis.tables.purgeOldTables, {
      expect: { dtsTodos: 2, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 },
    });
    expect(out).toMatchObject({ purged: false, counted: { dtsRulings: 6 }, mismatched: ["dtsRulings"] });
    expect(await rows(t)).toEqual({ dtsTodos: 2, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 6 });
  });

  it("empties every old table past one page, leaves the plain tables, and records it", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, 450);
    const plain = await t.run(async (ctx) => ctx.db.insert("todos", todo));
    const ruling = await t.run(async (ctx) =>
      ctx.db.insert("rulings", { subjectType: "life", verdict: "approve", ruledAt: 1, legacyId: "old000001id" }),
    );
    const out = await t.action(internal.jarvis.tables.purgeOldTables, {
      expect: { dtsTodos: 450, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 },
    });
    expect(out).toMatchObject({ purged: true, deleted: { dtsTodos: 450, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 } });
    expect(await rows(t)).toEqual({ dtsTodos: 0, dtsBlocks: 0, dtsTimeNotes: 0, dtsRulings: 0 });
    expect(await t.run(async (ctx) => ctx.db.get(plain))).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(ruling))).not.toBeNull();
    const events = await t.run(async (ctx) => ctx.db.query("dtsEvents").collect());
    expect(events.map((e) => [e.kind, e.data])).toEqual([
      [
        "old-tables-purged",
        {
          counted: { dtsTodos: 450, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 },
          deleted: { dtsTodos: 450, dtsBlocks: 1, dtsTimeNotes: 1, dtsRulings: 5 },
        },
      ],
    ]);
  });

  it("on empty tables deletes nothing", async () => {
    const t = convexTest({ schema, modules });
    const out = await t.action(internal.jarvis.tables.purgeOldTables, {
      expect: { dtsTodos: 0, dtsBlocks: 0, dtsTimeNotes: 0, dtsRulings: 0 },
    });
    expect(out).toMatchObject({ purged: true, deleted: { dtsTodos: 0, dtsBlocks: 0, dtsTimeNotes: 0, dtsRulings: 0 } });
  });
});
