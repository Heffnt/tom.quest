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

describe("plain core-table references", () => {
  it("accepts the reference types deployed before the switch", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const todoId = await ctx.db.insert("dtsTodos", todo);
      const blockId = await ctx.db.insert("blocks", {
        start: 1,
        end: 2,
        todoId,
        createdAt: 1,
      });
      const noteId = await ctx.db.insert("timeNotes", {
        text: "move it",
        todoId,
        blockId,
        status: "pending",
        createdAt: 1,
      });
      expect(await ctx.db.get(blockId)).toMatchObject({ todoId });
      expect(await ctx.db.get(noteId)).toMatchObject({ todoId, blockId });
    });
  });

  it("takes a todos id in a plain todoId (what every writer stores since step C)", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const todoId = await ctx.db.insert("todos", todo);
      const blockId = await ctx.db.insert("blocks", { start: 1, end: 2, todoId, createdAt: 1 });
      await ctx.db.insert("timeNotes", { text: "t", todoId, blockId, status: "pending", createdAt: 1 });
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

  it("exports exactly the rulings count, the readers' helpers, the check and copyBack; no copy, remap, follow, oldId or write back returns", () => {
    expect(Object.keys(tablesModule).sort()).toEqual([
      "clearBlock",
      "clearBlockPage",
      "copyBack",
      "copyBackPage",
      "copyBackPrunePage",
      "countPage",
      "counts",
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

// copyBack, the way back from step C: after writes that went to the plain
// tables only (what step C's writers do), each old table is made to hold what
// its plain table holds, so the code before step C can deploy again.
describe("copyBack: the old tables made to hold what the plain ones do", () => {
  type T = ReturnType<typeof convexTest>;
  const left = (t: T) => t.action(internal.jarvis.tables.leftToRemap, {});

  it("carries plain inserts, edits and deletions back, references moved back, until leftToRemap reads zero", async () => {
    const t = convexTest({ schema, modules });
    // Before step C: an old todo, block and note, each with its copy
    // (stamped by a first copyBack, as the dual write stamped them).
    const old = await t.run(async (ctx) => {
      const todoRow = await insertCopied(ctx, "todos", { ...todo, statement: "old", body: "a body" });
      const block = await insertCopied(ctx, "blocks", { start: 1, end: 2, todoId: todoRow.plain, createdAt: 1 }, { start: 1, end: 2, todoId: todoRow.old, createdAt: 1 });
      const note = await insertCopied(
        ctx,
        "timeNotes",
        { text: "n", todoId: todoRow.plain, blockId: block.plain, status: "pending" as const, createdAt: 1 },
        { text: "n", todoId: todoRow.old, blockId: block.old, status: "pending" as const, createdAt: 1 },
      );
      return { todoId: todoRow.old, blockId: block.old, noteId: note.old };
    });
    await t.action(internal.jarvis.tables.copyBack, {});
    expect((await left(t)).zero).toBe(true);
    // Step C's writes, to the plain rows only: a new todo needing the old one
    // (and a later one), the old todo edited and its body cleared, a block on
    // the new todo, a note on that block, and the old block deleted.
    const plain = await t.run(async (ctx) => {
      const oldTodo = (await resolveId(ctx, "todos", old.todoId))!;
      const oldBlock = (await resolveId(ctx, "blocks", old.blockId))!;
      // It carries the rollover's mark, which the old table declares so the
      // copy can hold it.
      const fresh = await ctx.db.insert("todos", { ...todo, statement: "new", needs: [oldTodo], rolledOverDueAt: 5 });
      const later = await ctx.db.insert("todos", { ...todo, statement: "later" });
      await ctx.db.patch(fresh, { needs: [oldTodo, later] });
      await ctx.db.patch(oldTodo, { statement: "old, edited", body: undefined });
      const block = await ctx.db.insert("blocks", { start: 3, end: 4, todoId: fresh, createdAt: 3 });
      const note = await ctx.db.insert("timeNotes", { text: "m", todoId: fresh, blockId: block, status: "pending" as const, createdAt: 3 });
      // A block's deletion takes it off the notes that named it.
      const oldNote = (await resolveId(ctx, "timeNotes", old.noteId))!;
      await ctx.db.patch(oldNote, { blockId: undefined });
      await ctx.db.delete(oldBlock);
      return { oldTodo, fresh, later, block, note };
    });
    expect((await left(t)).zero).toBe(false);

    const out = await t.action(internal.jarvis.tables.copyBack, {});
    // Two passes over todos: "new" needs "later", which the first pass had not
    // yet copied back; the answer is the second pass's.
    expect(out.todos).toMatchObject({ inserted: 0, patched: 1, unresolved: 0, pruned: 0 });
    expect(out.blocks).toMatchObject({ inserted: 1, pruned: 1 });
    expect(out.timeNotes).toMatchObject({ inserted: 1, patched: 1, pruned: 0 });
    expect(await left(t)).toMatchObject({ zero: true });

    await t.run(async (ctx) => {
      const fresh = (await ctx.db.get(plain.fresh))!;
      const later = (await ctx.db.get(plain.later))!;
      const oldFresh = (await ctx.db.get(ctx.db.normalizeId("dtsTodos", fresh.legacyId!)!))!;
      expect(oldFresh).toMatchObject({ statement: "new", needs: [old.todoId, later.legacyId], rolledOverDueAt: 5 });
      expect(await ctx.db.get(old.todoId)).toMatchObject({ statement: "old, edited" });
      expect(await ctx.db.get(old.todoId)).not.toHaveProperty("body");
      expect(await ctx.db.get(old.blockId)).toBeNull();
      const block = (await ctx.db.get(plain.block))!;
      expect(await ctx.db.get(ctx.db.normalizeId("dtsBlocks", block.legacyId!)!)).toMatchObject({ start: 3, todoId: fresh.legacyId });
      const note = (await ctx.db.get(plain.note))!;
      expect(await ctx.db.get(ctx.db.normalizeId("dtsTimeNotes", note.legacyId!)!)).toMatchObject({
        text: "m",
        todoId: fresh.legacyId,
        blockId: block.legacyId,
      });
      // The new todo's old row is found through its plain row, as the code
      // before step C looks it up (oldId: the plain row's legacyId).
      expect(await resolveId(ctx, "todos", fresh.legacyId!)).toBe(plain.fresh);
    });
    // A second run has nothing left to carry.
    expect((await t.action(internal.jarvis.tables.copyBack, {})).todos).toMatchObject({ inserted: 0, patched: 0 });
  });
});
