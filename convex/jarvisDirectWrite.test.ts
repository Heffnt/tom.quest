import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { insertCopied } from "../test/core-tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The direct write (convex/jarvis/tables.ts, step C): every writer of todos,
// writes the plain row, and nothing writes dtsTodos. Each test drives one writer through its own door
// and reads the plain row back; `plainOnly` checks the old tables hold no row
// (the fixtures are written through the doors, so none ever had one). A todo
// from before step C, reached by its old id, is jarvisCoreIds.test.ts's.

type T = ReturnType<typeof convexTest>;
type Core = "todos";

async function withTom(t: T) {
  const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: tomId });
}

/** The plain row a door's id names. */
const plainOf = (t: T, table: Core, id: string) =>
  t.run(async (ctx) => {
    const rows = (await ctx.db.query(table).collect()) as Array<Record<string, unknown> & { _id: string }>;
    return rows.find((row) => row._id === id) ?? null;
  });

async function plainOnly(t: T) {
  const old = await t.run(async (ctx) => [
    ...(await ctx.db.query("dtsTodos").collect()),
  ]);
  expect(old).toEqual([]);
}

async function setup() {
  const t = convexTest({ schema, modules });
  const tom = await withTom(t);
  const id = await tom.mutation(api.tts.createTodo, { statement: "renew the lease" });
  return { t, tom, id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the direct write: each writer writes the plain row and no old row", () => {
  it("createTodo", async () => {
    const { t, id } = await setup();
    expect(await plainOf(t, "todos", id)).toMatchObject({ statement: "renew the lease" });
    expect(await plainOf(t, "todos", id)).not.toHaveProperty("legacyId");
    await plainOnly(t);
  });

  it("a todo: the door answers the plain id, and what stores a reference stores it", async () => {
    const { t, tom, id } = await setup();
    const rulingId = await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "revise", sentence: "shorter" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      expect(row).toMatchObject({ statement: "renew the lease", readiness: "unprepared" });
      expect((await ctx.db.get(rulingId))!.todoId).toBe(id);
      const events = (await ctx.db.query("dtsEvents").collect()).filter((e) => e.todoId !== undefined);
      expect(new Set(events.map((e) => e.todoId))).toEqual(new Set([id]));
    });
    await plainOnly(t);
  });

  it("internalTriage applies a status change and its Tom touch", async () => {
    const { t, id } = await setup();
    await t.mutation(internal.tts.internalTriage, { id, status: "done" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ status: "done", tomTouchedAt: expect.any(Number) });
    await plainOnly(t);
  });

  it("internalTriage", async () => {
    const { t, id } = await setup();
    const dueAt = Date.now() + 3 * DAY_MS;
    await t.mutation(internal.tts.internalTriage, { id, dueAt, status: "waiting", wakeAt: dueAt });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt, status: "waiting", tomTouchedAt: expect.any(Number) });
    await plainOnly(t);
  });

  it("internalBulkUpdate", async () => {
    const { t, id } = await setup();
    await t.mutation(internal.tts.internalBulkUpdate, { updates: [{ id, category: "home", entryAction: "call" }] });
    expect(await plainOf(t, "todos", id)).toMatchObject({ category: "home", entryAction: "call" });
    await plainOnly(t);
  });

  it("recordDateOutcome (applyDateOutcome)", async () => {
    const { t, tom } = await setup();
    const dueAt = Date.now() + 3 * DAY_MS;
    const id = await tom.mutation(api.tts.createTodo, { statement: "file taxes", dueAt });
    await tom.mutation(api.tts.recordDateOutcome, { id, outcome: "renegotiated", newDueAt: dueAt + DAY_MS });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt: dueAt + DAY_MS, dateOutcomes: [expect.objectContaining({ outcome: "renegotiated" })] });
    await plainOnly(t);
  });

  it("internalCapture and internalPrepareTodo", async () => {
    const t = convexTest({ schema, modules });
    const id = (await t.mutation(internal.tts.internalCapture, { statement: "buy tape", source: "capture" })) as unknown as Id<"todos">;
    expect(await plainOf(t, "todos", id)).toMatchObject({ statement: "buy tape", source: "capture" });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      brief: "Tape for finger protection.",
      entryAction: "Open the retailer page",
      workDescription: "a two-minute errand",
      readiness: "prepared",
    });
    expect(await plainOf(t, "todos", id)).toMatchObject({ readiness: "prepared", brief: "Tape for finger protection." });
    await plainOnly(t);
  });

  it("recordRuling (insertRuling's Tom touch and revise)", async () => {
    const { t, tom, id } = await setup();
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "approve" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ tomTouchedAt: expect.any(Number) });
    await plainOnly(t);
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "revise", sentence: "shorter" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ readiness: "unprepared" });
    await plainOnly(t);
  });

  it("leftToRemap after a run of writes counts what the way back carries, and copyBack brings it to zero", async () => {
    const { t, tom, id } = await setup();
    // A todo from before step C: its old row and copy, stamped by a first
    // copyBack (as the dual write stamped them).
    const before = await t.run(async (ctx) => {
      const todo = await insertCopied(ctx, "todos", { statement: "the old todo", readiness: "unprepared", status: "active", timingClass: "whenever", source: "test", createdAt: 1, updatedAt: 1 });
      return { todo };
    });
    await t.action(internal.jarvis.tables.copyBack, {});
    const check = () => t.action(internal.jarvis.tables.leftToRemap, {});
    expect((await check()).zero).toBe(true);
    const oldTables = () =>
      t.run(async (ctx) => await ctx.db.query("dtsTodos").collect());
    const frozen = await oldTables();
    await tom.mutation(api.tts.createTodo, { statement: "sign it", dueAt: Date.now() + 2 * DAY_MS });
    await t.mutation(internal.tts.internalBulkUpdate, {
      updates: [{ id: before.todo.old, category: "home" }],
    });
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "archive" });
    // Nothing wrote an old row.
    expect(await oldTables()).toEqual(frozen);
    expect((await check()).left).toEqual({
      // "sign it" is new (orphaned); the old todo and "renew the lease" were
      // edited (stale; the first copyBack gave "renew the lease" an old row).
      todos: { notCopied: 0, stale: 2, version: 0, orphaned: 1, needs: 0 },
    });
    await t.action(internal.jarvis.tables.copyBack, {});
    expect((await check()).zero).toBe(true);
  });
});
