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

  it("has no rulings copy or label remap left to run", () => {
    expect(Object.keys(tablesModule).filter((name) => /ruling/i.test(name))).toEqual([]);
  });
});

// The todos, blocks and timeNotes copy (the move's first pull request): the
// old tables stay the truth, and the plain tables follow them.
describe("todos, blocks and time notes copied into their plain tables", () => {
  type T = ReturnType<typeof convexTest>;
  const syncAll = async (t: T, pageSize?: number) => {
    for (const table of ["todos", "blocks", "timeNotes"] as const) {
      await t.action(internal.jarvis.tables.sync, { table, pageSize });
    }
  };
  const left = (t: T) => t.action(internal.jarvis.tables.leftToRemap, {});
  const copyOf = (t: T, table: "todos" | "blocks" | "timeNotes", legacyId: string) =>
    t.run(async (ctx) => {
      const rows = (await ctx.db.query(table).collect()) as Array<{ legacyId?: string } & Record<string, unknown>>;
      return rows.find((r) => r.legacyId === legacyId) ?? null;
    });
  const zeros = {
    todos: { notCopied: 0, stale: 0, orphaned: 0, needs: 0 },
    blocks: { notCopied: 0, stale: 0, orphaned: 0, todoId: 0 },
    timeNotes: { notCopied: 0, stale: 0, orphaned: 0, todoId: 0, blockId: 0 },
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
    expect(await left(t)).toEqual({ zero: true, left: zeros, remapped: { blocks: 1, timeNotes: 1 } });
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
    expect(await left(t)).toEqual({ zero: true, left: zeros, remapped: { blocks: 1, timeNotes: 1 } });
  });

  it("pages: each page hands on a cursor, and a small page size copies the same rows", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) await ctx.db.insert("dtsTodos", { ...todo, statement: `t${i}` });
    });
    const first = await t.mutation(internal.jarvis.tables.syncPage, { table: "todos", cursor: null, pageSize: 2 });
    expect(first).toMatchObject({ inserted: 2, isDone: false });
    let cursor = first.continueCursor;
    let inserted = first.inserted;
    for (;;) {
      const page = await t.mutation(internal.jarvis.tables.syncPage, { table: "todos", cursor, pageSize: 2 });
      inserted += page.inserted;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(inserted).toBe(5);
    await seed(t);
    await syncAll(t, 1);
    expect(await t.run((ctx) => ctx.db.query("todos").collect())).toHaveLength(7);
    expect((await left(t)).zero).toBe(true);
  });

  it("has a way back: unmapTodoRefs, then copyBack writes what the plain tables hold into the old ones", async () => {
    const t = convexTest({ schema, modules });
    const { a, block } = await seed(t);
    await syncAll(t);
    // What the new code would write after the switch: a todo and a block born
    // in the plain tables, and an edit to a copied block.
    const { born, bornBlock } = await t.run(async (ctx) => {
      const born = await ctx.db.insert("todos", { ...todo, statement: "born" });
      const bornBlock = await ctx.db.insert("blocks", { start: 7, end: 8, todoId: born, createdAt: 7 });
      const copied = (await ctx.db.query("blocks").withIndex("by_legacy", (q) => q.eq("legacyId", block)).first())!;
      await ctx.db.patch(copied._id, { note: "moved" });
      return { born, bornBlock };
    });
    const todos = await t.action(internal.jarvis.tables.copyBack, { table: "todos" });
    expect(todos.passes[0]).toMatchObject({ inserted: 1, patched: 0, orphaned: 0 });
    await t.action(internal.jarvis.tables.copyBack, { table: "blocks" });
    await t.action(internal.jarvis.tables.copyBack, { table: "timeNotes" });
    expect(await t.action(internal.jarvis.tables.unmapTodoRefs, {})).toEqual({
      blocks: expect.objectContaining({ patched: 2, unresolved: 0 }),
      timeNotes: expect.objectContaining({ patched: 1, unresolved: 0 }),
    });
    expect((await left(t)).remapped).toEqual({ blocks: 0, timeNotes: 0 });
    await t.run(async (ctx) => {
      const bornRow = (await ctx.db.get(born))!;
      expect(await ctx.db.get(bornRow.legacyId as Id<"dtsTodos">)).toMatchObject({ statement: "born" });
      const bornBlockRow = (await ctx.db.get(bornBlock))!;
      expect(bornBlockRow.todoId).toBe(bornRow.legacyId);
      expect(await ctx.db.get(bornBlockRow.legacyId as Id<"dtsBlocks">)).toMatchObject({ start: 7, todoId: bornRow.legacyId });
      expect(await ctx.db.get(block)).toMatchObject({ note: "moved", todoId: a });
    });
    // The way back is idempotent too.
    const again = await t.action(internal.jarvis.tables.copyBack, { table: "blocks" });
    expect(again.passes[0]).toMatchObject({ inserted: 0, patched: 0, unchanged: 2 });
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
