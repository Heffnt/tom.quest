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

  it("exports exactly the rulings count and the core tables' copy; no retired copy or remap returns", () => {
    expect(Object.keys(tablesModule).sort()).toEqual([
      "clearBlockPage",
      "copyBack",
      "copyBackPage",
      "copyBackPrunePage",
      "countPage",
      "counts",
      "eitherId",
      "follow",
      "leftPage",
      "leftToRemap",
      "oldId",
      "prunePage",
      "refsPage",
      "remapTodoRefs",
      "resolveId",
      "sync",
      "syncPage",
      "todoEvents",
      "todoIdForms",
      "todoReader",
      "todoRulings",
      "unstamp",
      "unstampPage",
      "withPlainTodoIds",
    ]);
  });
});

// The todos, blocks and timeNotes copy (the move's first pull request): the
// old tables stay the truth, and the plain tables follow them.
describe("todos, blocks and time notes copied into their plain tables", () => {
  type T = ReturnType<typeof convexTest>;
  const syncAll = async (t: T) => {
    for (const table of ["todos", "blocks", "timeNotes"] as const) {
      await t.action(internal.jarvis.tables.sync, { table });
    }
  };
  const left = (t: T) => t.action(internal.jarvis.tables.leftToRemap, {});
  const copyOf = (t: T, table: "todos" | "blocks" | "timeNotes", legacyId: string) =>
    t.run(async (ctx) => {
      const rows = (await ctx.db.query(table).collect()) as Array<{ legacyId?: string } & Record<string, unknown>>;
      return rows.find((r) => r.legacyId === legacyId) ?? null;
    });
  const zeros = {
    todos: { notCopied: 0, stale: 0, version: 0, orphaned: 0, needs: 0 },
    blocks: { notCopied: 0, stale: 0, version: 0, orphaned: 0, todoId: 0 },
    timeNotes: { notCopied: 0, stale: 0, version: 0, orphaned: 0, todoId: 0, blockId: 0 },
  };
  /** Two todos (the first needs the second, later in the table), a block on
   *  the first, and a time note on that todo and block. */
  const seed = (t: T) =>
    t.run(async (ctx) => {
      const a = await ctx.db.insert("dtsTodos", { ...todo, statement: "a" });
      const b = await ctx.db.insert("dtsTodos", { ...todo, statement: "b" });
      await ctx.db.patch(a, { needs: [b] });
      const block = await ctx.db.insert("dtsBlocks", { start: 1, end: 2, todoId: a, createdAt: 1 });
      const note = await ctx.db.insert("dtsTimeNotes", { text: "move it", todoId: a, blockId: block, status: "pending", createdAt: 1 });
      return { a, b, block, note };
    });

  it("copies every row with its references pointing at the plain rows, and leftToRemap reads zero", async () => {
    const t = convexTest({ schema, modules });
    const { a, b, block, note } = await seed(t);
    const before = await left(t);
    expect(before.zero).toBe(false);
    expect(before.left.todos.notCopied).toBe(2);
    await syncAll(t);
    const [ta, tb, pb, pn] = [await copyOf(t, "todos", a), await copyOf(t, "todos", b), await copyOf(t, "blocks", block), await copyOf(t, "timeNotes", note)];
    expect(ta).toMatchObject({ statement: "a", needs: [tb!._id] });
    expect(pb).toMatchObject({ todoId: ta!._id, start: 1 });
    expect(pn).toMatchObject({ todoId: ta!._id, blockId: pb!._id, text: "move it" });
    expect(await left(t)).toEqual({ zero: true, left: zeros });
  });

  it("is idempotent: a second run changes nothing", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await syncAll(t);
    const again = await t.action(internal.jarvis.tables.sync, { table: "todos" });
    expect(again).toEqual({ table: "todos", passes: [expect.objectContaining({ inserted: 0, patched: 0, unchanged: 2 })], pruned: 0 });
    expect(await t.action(internal.jarvis.tables.remapTodoRefs, {})).toEqual({
      blocks: expect.objectContaining({ patched: 0, unresolved: 0 }),
      timeNotes: expect.objectContaining({ patched: 0, unresolved: 0 }),
    });
    expect((await left(t)).zero).toBe(true);
  });

  it("follows the old tables' edits and deletions", async () => {
    const t = convexTest({ schema, modules });
    const { a, b, block, note } = await seed(t);
    await syncAll(t);
    const copiedBlock = (await copyOf(t, "blocks", block))!;
    await t.run(async (ctx) => {
      // An edit that leaves updatedAt alone, a field taken away, a new row,
      // and a deleted block (its time note loses the block with it).
      await ctx.db.patch(a, { slackReplyTs: "1.2", needs: undefined });
      await ctx.db.patch(b, { body: "more" });
      await ctx.db.insert("dtsBlocks", { start: 5, end: 6, category: "chores", createdAt: 5 });
      await ctx.db.delete(block);
      await ctx.db.patch(note, { blockId: undefined, status: "applied", result: "moved" });
    });
    const drift = await left(t);
    expect(drift.left.todos.stale).toBe(2);
    expect(drift.left.blocks).toMatchObject({ notCopied: 1, orphaned: 1 });
    expect(drift.left.timeNotes.stale).toBe(1);
    await syncAll(t);
    const ta = (await copyOf(t, "todos", a))!;
    expect(ta.slackReplyTs).toBe("1.2");
    expect("needs" in ta).toBe(false);
    expect(await copyOf(t, "todos", b)).toMatchObject({ body: "more" });
    expect(await t.run((ctx) => ctx.db.get(copiedBlock._id as Id<"blocks">))).toBeNull();
    const pn = (await copyOf(t, "timeNotes", note))!;
    expect(pn).toMatchObject({ status: "applied", result: "moved" });
    expect("blockId" in pn).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("blocks").collect())).toHaveLength(1);
    expect((await left(t)).zero).toBe(true);
  });

  it("prunes nothing when an old table is empty", async () => {
    const t = convexTest({ schema, modules });
    await t.run((ctx) => ctx.db.insert("blocks", { start: 1, end: 2, createdAt: 1, legacyId: "gone" }));
    expect(await t.mutation(internal.jarvis.tables.prunePage, { table: "blocks", cursor: null })).toMatchObject({
      deleted: 0,
      skipped: "dtsBlocks is empty; nothing pruned",
    });
  });

  it("remaps the todoIds an earlier copy left as dtsTodos ids, and leftToRemap counts them until then", async () => {
    const t = convexTest({ schema, modules });
    const { a, block, note } = await seed(t);
    await t.action(internal.jarvis.tables.sync, { table: "todos" });
    // As production holds them: copied by the earlier sync, todoId a dtsTodos id.
    const ta = (await copyOf(t, "todos", a))!;
    const { pb, pn } = await t.run(async (ctx) => {
      const pb = await ctx.db.insert("blocks", { start: 1, end: 2, todoId: a, createdAt: 1, legacyId: block });
      const pn = await ctx.db.insert("timeNotes", { text: "move it", todoId: a, blockId: pb, status: "pending", createdAt: 1, legacyId: note });
      return { pb, pn };
    });
    const before = await left(t);
    expect(before.left.blocks.todoId).toBe(1);
    expect(before.left.timeNotes.todoId).toBe(1);
    expect(await t.action(internal.jarvis.tables.remapTodoRefs, {})).toEqual({
      blocks: expect.objectContaining({ patched: 1 }),
      timeNotes: expect.objectContaining({ patched: 1 }),
    });
    expect(await t.run((ctx) => ctx.db.get(pb))).toMatchObject({ todoId: ta._id });
    expect(await t.run((ctx) => ctx.db.get(pn))).toMatchObject({ todoId: ta._id });
    // Their old rows were never stamped (no sync ran over them): the version
    // count says so until the catch-up sync stamps them.
    const remapped = await left(t);
    expect(remapped.left.blocks).toEqual({ ...zeros.blocks, version: 1 });
    expect(remapped.left.timeNotes).toEqual({ ...zeros.timeNotes, version: 1 });
    await t.action(internal.jarvis.tables.sync, { table: "blocks" });
    await t.action(internal.jarvis.tables.sync, { table: "timeNotes" });
    expect(await left(t)).toEqual({ zero: true, left: zeros });
  });

  it("pages: each page is 100 rows and hands on a cursor, and sync walks every page", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let i = 0; i < 205; i++) await ctx.db.insert("dtsTodos", { ...todo, statement: `t${i}` });
    });
    const first = await t.mutation(internal.jarvis.tables.syncPage, { table: "todos", cursor: null });
    expect(first).toMatchObject({ inserted: 100, isDone: false });
    const second = await t.mutation(internal.jarvis.tables.syncPage, { table: "todos", cursor: first.continueCursor });
    expect(second).toMatchObject({ inserted: 100, isDone: false });
    await seed(t);
    const all = await t.action(internal.jarvis.tables.sync, { table: "todos" });
    expect(all.passes[0]).toMatchObject({ inserted: 7, unchanged: 200 });
    await t.action(internal.jarvis.tables.sync, { table: "blocks" });
    await t.action(internal.jarvis.tables.sync, { table: "timeNotes" });
    expect(await t.run((ctx) => ctx.db.query("todos").collect())).toHaveLength(207);
    expect((await left(t)).zero).toBe(true);
  });

  it("has a way back before the switch: refsPage back points every todoId at its dtsTodos id again", async () => {
    const t = convexTest({ schema, modules });
    const { a } = await seed(t);
    await syncAll(t);
    for (const table of ["blocks", "timeNotes"] as const) {
      expect(await t.mutation(internal.jarvis.tables.refsPage, { table, direction: "back", cursor: null })).toMatchObject({
        patched: 1,
        unresolved: 0,
        isDone: true,
      });
    }
    await t.run(async (ctx) => {
      for (const row of [...(await ctx.db.query("blocks").collect()), ...(await ctx.db.query("timeNotes").collect())]) {
        expect(row.todoId).toBe(a);
      }
    });
  });

  it("unstamp takes legacyVersion off every row of the six tables", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await syncAll(t);
    const stamped = (ctx: Parameters<Parameters<T["run"]>[0]>[0]) =>
      Promise.all(
        (["dtsTodos", "dtsBlocks", "dtsTimeNotes", "todos", "blocks", "timeNotes"] as const).map(async (table) =>
          (await ctx.db.query(table).collect()).filter((row) => row.legacyVersion !== undefined).length,
        ),
      );
    expect(await t.run(stamped)).toEqual([2, 1, 1, 2, 1, 1]);
    expect(await t.action(internal.jarvis.tables.unstamp, {})).toEqual({
      dtsTodos: 2,
      dtsBlocks: 1,
      dtsTimeNotes: 1,
      todos: 2,
      blocks: 1,
      timeNotes: 1,
    });
    expect(await t.run(stamped)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("takes a todos id in a plain todoId (the widening, until the switch narrows it)", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const todoId = await ctx.db.insert("todos", todo);
      const blockId = await ctx.db.insert("blocks", { start: 1, end: 2, todoId, createdAt: 1 });
      await ctx.db.insert("timeNotes", { text: "t", todoId, blockId, status: "pending", createdAt: 1 });
    });
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
    // Before step C: an old todo, block and note, each with its copy.
    const old = await t.run(async (ctx) => {
      const todoId = await ctx.db.insert("dtsTodos", { ...todo, statement: "old", body: "a body" });
      const blockId = await ctx.db.insert("dtsBlocks", { start: 1, end: 2, todoId, createdAt: 1 });
      const noteId = await ctx.db.insert("dtsTimeNotes", { text: "n", todoId, blockId, status: "pending" as const, createdAt: 1 });
      for (const [table, id] of [["todos", todoId], ["blocks", blockId], ["timeNotes", noteId]] as const) {
        await tablesModule.follow(ctx, table, id);
      }
      return { todoId, blockId, noteId };
    });
    expect((await left(t)).zero).toBe(true);
    // Step C's writes, to the plain rows only: a new todo needing the old one
    // (and a later one), the old todo edited and its body cleared, a block on
    // the new todo, a note on that block, and the old block deleted.
    const plain = await t.run(async (ctx) => {
      const oldTodo = (await resolveId(ctx, "todos", old.todoId))!;
      const oldBlock = (await resolveId(ctx, "blocks", old.blockId))!;
      const fresh = await ctx.db.insert("todos", { ...todo, statement: "new", needs: [oldTodo] });
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
      expect(oldFresh).toMatchObject({ statement: "new", needs: [old.todoId, later.legacyId] });
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
      // The code before step C finds the new todo's old row by either id.
      expect(await tablesModule.oldId(ctx, "todos", plain.fresh)).toBe(fresh.legacyId);
    });
    // A second run has nothing left to carry.
    expect((await t.action(internal.jarvis.tables.copyBack, {})).todos).toMatchObject({ inserted: 0, patched: 0 });
  });
});
