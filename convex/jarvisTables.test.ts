import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolveId } from "./jarvis/tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

const todo = (statement: string, updatedAt: number) => ({
  statement,
  readiness: "unprepared" as const,
  status: "active" as const,
  timingClass: "whenever" as const,
  source: "test",
  createdAt: 1,
  updatedAt,
});

const todo_ = (statement: string) => todo(statement, 1);

/** Run a copy to the end, one page at a time, as the chained copy does. */
async function copyAll(t: ReturnType<typeof convexTest>, table: "todos" | "rulings" | "blocks" | "timeNotes") {
  let cursor: string | null = null;
  for (;;) {
    const page: { isDone: boolean; continueCursor: string } = await t.mutation(internal.jarvis.tables.copy, {
      table,
      cursor,
      pageSize: 2,
      chain: false,
    });
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  if (table === "todos") {
    cursor = null;
    for (;;) {
      const page: { isDone: boolean; continueCursor: string } = await t.mutation(internal.jarvis.tables.copyNeeds, {
        cursor,
        pageSize: 2,
        chain: false,
      });
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
}

describe("the copy into the plain-named tables", () => {
  it("copies every field, keeps the old id, maps needs and a ruling's todo, and a second run changes nothing", async () => {
    const t = convexTest({ schema, modules });
    const ids = await t.run(async (ctx) => {
      const a = await ctx.db.insert("dtsTodos", todo("a", 10));
      const b = await ctx.db.insert("dtsTodos", { ...todo("b", 10), needs: [a], brief: "the brief" });
      const c = await ctx.db.insert("dtsTodos", { ...todo("c", 10), needs: [a, b] });
      const r = await ctx.db.insert("dtsRulings", { subjectType: "life", todoId: b, verdict: "archive", ruledAt: 5 });
      return { a, b, c, r };
    });
    await copyAll(t, "todos");
    await copyAll(t, "rulings");
    await copyAll(t, "todos");
    await copyAll(t, "rulings");
    const { todos, rulings } = await t.run(async (ctx) => ({
      todos: await ctx.db.query("todos").collect(),
      rulings: await ctx.db.query("rulings").collect(),
    }));
    expect(todos.map((row) => row.statement)).toEqual(["a", "b", "c"]);
    const byLegacy = new Map(todos.map((row) => [row.legacyId, row]));
    const b = byLegacy.get(ids.b)!;
    expect(b.brief).toBe("the brief");
    expect(b.needs).toEqual([byLegacy.get(ids.a)!._id]);
    expect(byLegacy.get(ids.c)!.needs).toEqual([byLegacy.get(ids.a)!._id, b._id]);
    expect(rulings).toHaveLength(1);
    // The ruling names its todo as it did: rulings name dtsTodos until todos move.
    expect(rulings[0]).toMatchObject({ legacyId: ids.r, todoId: ids.b, verdict: "archive", ruledAt: 5 });
    const counts = await t.action(internal.jarvis.tables.counts, {});
    expect(counts.todos).toEqual({ old: 3, new: 3, copied: 3, whole: true });
    expect(counts.rulings).toEqual({ old: 1, new: 1, copied: 1, whole: true });
    expect(counts.calendar.whole).toBe(true);
  });

  it("points a ruling's labels at its new id", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run(async (ctx) => {
      const r = await ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      await ctx.db.insert("runLabels", {
        runId: "run", source: "ruling", actor: "tom", polarity: "good", meaning: "m", judgment: true, ref: `ruling:${r}`, at: 1,
      } as never);
      return r;
    });
    await copyAll(t, "rulings");
    expect(await t.mutation(internal.jarvis.tables.remapRulingRefs, {})).toEqual({ labels: 1 });
    const { ruling, label } = await t.run(async (ctx) => ({
      ruling: (await ctx.db.query("rulings").collect())[0],
      label: (await ctx.db.query("runLabels").collect())[0],
    }));
    expect(ruling.legacyId).toBe(old);
    expect(label.ref).toBe(`ruling:${ruling._id}`);
  });

  // witness: compare a block's createdAt instead of its fingerprint, or drop
  // the prune; the moved block keeps its old times and the deleted one stays.
  it("follows a block's edits and deletions, and never undoes an edit made to the copy", async () => {
    const t = convexTest({ schema, modules });
    const { moved, gone } = await t.run(async (ctx) => ({
      moved: await ctx.db.insert("dtsBlocks", { start: 1, end: 2, createdAt: 1 }),
      gone: await ctx.db.insert("dtsBlocks", { start: 3, end: 4, createdAt: 1, note: "cancelled" }),
    }));
    await t.mutation(internal.jarvis.tables.copy, { table: "blocks", chain: false });
    await t.run(async (ctx) => {
      await ctx.db.patch(moved, { start: 10, end: 20 });
      await ctx.db.delete(gone);
    });
    await t.mutation(internal.jarvis.tables.copy, { table: "blocks", chain: false });
    expect(await t.mutation(internal.jarvis.tables.prune, { table: "blocks", chain: false })).toMatchObject({ deleted: 1 });
    let blocks = await t.run(async (ctx) => await ctx.db.query("blocks").collect());
    expect(blocks.map((b) => [b.legacyId, b.start, b.end])).toEqual([[moved, 10, 20]]);
    // The new code moves the copy; the old row is unchanged, so a copy leaves it.
    await t.run(async (ctx) => await ctx.db.patch(blocks[0]._id, { start: 100 }));
    await t.mutation(internal.jarvis.tables.copy, { table: "blocks", chain: false });
    blocks = await t.run(async (ctx) => await ctx.db.query("blocks").collect());
    expect(blocks[0].start).toBe(100);
    // An emptied old table is not read as every block deleted.
    await t.run(async (ctx) => await ctx.db.delete(moved));
    expect(await t.mutation(internal.jarvis.tables.prune, { table: "blocks", chain: false })).toMatchObject({ deleted: 0 });
    expect(await t.run(async (ctx) => (await ctx.db.query("blocks").collect()).length)).toBe(1);
  });

  // witness: throw on a time note's missing block, as the copy did.
  it("keeps a time note whose block was deleted, with no block", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const block = await ctx.db.insert("dtsBlocks", { start: 1, end: 2, createdAt: 1 });
      await ctx.db.insert("dtsTimeNotes", { text: "move it to friday", blockId: block, status: "pending", createdAt: 1 });
      await ctx.db.delete(block);
    });
    await t.mutation(internal.jarvis.tables.copy, { table: "blocks", chain: false });
    expect(await t.mutation(internal.jarvis.tables.copy, { table: "timeNotes", chain: false })).toMatchObject({ inserted: 1, danglingBlocks: 1 });
    const [note] = await t.run(async (ctx) => await ctx.db.query("timeNotes").collect());
    expect(note.text).toBe("move it to friday");
    expect(note.blockId).toBeUndefined();
  });

  // witness: compare updatedAt instead of the fingerprint; the reply ts below
  // is written without moving updatedAt and never arrives.
  it("follows a todo's edits that leave updatedAt alone, and a need taken away", async () => {
    const t = convexTest({ schema, modules });
    const { a, b } = await t.run(async (ctx) => {
      const a = await ctx.db.insert("dtsTodos", todo("a", 10));
      const b = await ctx.db.insert("dtsTodos", { ...todo("b", 10), needs: [a] });
      return { a, b };
    });
    await copyAll(t, "todos");
    await t.run(async (ctx) => {
      await ctx.db.patch(a, { slackReplyTs: "1.5" });
      await ctx.db.patch(b, { needs: undefined });
    });
    await copyAll(t, "todos");
    const rows = await t.run(async (ctx) => await ctx.db.query("todos").collect());
    expect(rows.find((r) => r.legacyId === a)!.slackReplyTs).toBe("1.5");
    expect(rows.find((r) => r.legacyId === b)!.needs).toBeUndefined();
    expect(rows.every((r) => !r.legacyVersion!.startsWith("needs-pending:"))).toBe(true);
  });

  it("patches a copied row from a newer old row, never from an older one", async () => {
    const t = convexTest({ schema, modules });
    const a = await t.run(async (ctx) => await ctx.db.insert("dtsTodos", todo("first", 10)));
    await copyAll(t, "todos");
    // The old code wrote after the first copy: the second copy brings it.
    await t.run(async (ctx) => await ctx.db.patch(a, { statement: "old code's edit", updatedAt: 20 }));
    await copyAll(t, "todos");
    const copied = await t.run(async (ctx) => (await ctx.db.query("todos").collect())[0]);
    expect(copied.statement).toBe("old code's edit");
    // The new code wrote since: a later copy leaves it.
    await t.run(async (ctx) => await ctx.db.patch(copied._id, { statement: "new code's edit", updatedAt: 30 }));
    await copyAll(t, "todos");
    const kept = await t.run(async (ctx) => (await ctx.db.query("todos").collect())[0]);
    expect(kept.statement).toBe("new code's edit");
  });

  it("resolves a row by its new id or the id it had before the rename", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run(async (ctx) => await ctx.db.insert("dtsTodos", todo("x", 1)));
    await copyAll(t, "todos");
    await t.run(async (ctx) => {
      const copied = (await ctx.db.query("todos").collect())[0];
      expect(await resolveId(ctx, "todos", old)).toBe(copied._id);
      expect(await resolveId(ctx, "todos", copied._id)).toBe(copied._id);
      expect(await resolveId(ctx, "todos", "not-an-id")).toBeNull();
      const ruling = await ctx.db.insert("dtsRulings", { subjectType: "life", verdict: "archive", ruledAt: 1 });
      expect(await resolveId(ctx, "todos", ruling as unknown as Id<"todos">)).toBeNull();
    });
  });

  it("points every stored reference to a todo at its copy", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run(async (ctx) => {
      const todo = await ctx.db.insert("dtsTodos", todo_("referenced"));
      await ctx.db.insert("dtsEvents", { at: 1, kind: "created", todoId: todo });
      await ctx.db.insert("events", { kind: "job-ok", at: 1, provenance: {}, subject: todo, data: {} });
      await ctx.db.insert("rulings", { subjectType: "life", todoId: todo, verdict: "archive", ruledAt: 1 });
      await ctx.db.insert("timeNotes", { text: "friday", todoId: todo, status: "pending", createdAt: 1 });
      await ctx.db.insert("claudeSessions", {
        title: "friday", kind: "weekly", repo: "none", status: "running", statusChangedAt: 1, nextSeq: 0, createdAt: 1,
        agendaDay: "2026-09-25", agendaSubjects: [todo, "not-a-todo"],
      } as never);
      return todo;
    });
    await copyAll(t, "todos");
    await t.mutation(internal.jarvis.tables.remapTodoRefs, { chain: false });
    await t.mutation(internal.jarvis.tables.remapTodoStragglers, { chain: false });
    const rows = await t.run(async (ctx) => ({
      todo: (await ctx.db.query("todos").collect())[0],
      dts: (await ctx.db.query("dtsEvents").collect())[0],
      event: (await ctx.db.query("events").collect())[0],
      ruling: (await ctx.db.query("rulings").collect())[0],
      note: (await ctx.db.query("timeNotes").collect())[0],
      weekly: (await ctx.db.query("claudeSessions").collect())[0],
    }));
    expect(rows.todo.legacyId).toBe(old);
    expect(rows.dts.todoId).toBe(rows.todo._id);
    expect(rows.event.subject).toBe(rows.todo._id);
    expect(rows.ruling.todoId).toBe(rows.todo._id);
    expect(rows.note.todoId).toBe(rows.todo._id);
    expect(rows.weekly.agendaSubjects).toEqual([rows.todo._id, "not-a-todo"]);
    const left = await t.action(internal.jarvis.tables.leftToRemap, {});
    expect(left).toEqual({ rulings: 0, claudeSessions: 0, runs: 0, blocks: 0, timeNotes: 0, runners: 0, dtsEvents: 0, events: 0 });
  });

  // witness: drop the dtsEvents or events lookups from leftOnIndexesPage; the
  // counts before the remap then read 0 and the check proves nothing.
  it("counts what still names a todo by its old id, on every table the remap walks", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const todo = await ctx.db.insert("dtsTodos", todo_("referenced"));
      await ctx.db.insert("dtsEvents", { at: 1, kind: "created", todoId: todo });
      await ctx.db.insert("events", { kind: "job-ok", at: 1, provenance: {}, subject: todo, data: {} });
      await ctx.db.insert("rulings", { subjectType: "life", todoId: todo, verdict: "archive", ruledAt: 1 });
    });
    await copyAll(t, "todos");
    expect(await t.action(internal.jarvis.tables.leftToRemap, {})).toMatchObject({ rulings: 1, dtsEvents: 1, events: 1 });
    await t.mutation(internal.jarvis.tables.remapTodoRefs, { chain: false });
    expect(await t.action(internal.jarvis.tables.leftToRemap, {})).toMatchObject({ rulings: 0, dtsEvents: 0, events: 0 });
  });

  it("goes back: copyBack writes what the new code wrote into the old tables, and unmap points every reference at them", async () => {
    const t = convexTest({ schema, modules });
    const old = await t.run(async (ctx) => {
      const a = await ctx.db.insert("dtsTodos", todo("a", 10));
      const b = await ctx.db.insert("dtsTodos", todo("b", 10));
      await ctx.db.insert("dtsEvents", { at: 1, kind: "created", todoId: a });
      await ctx.db.insert("rulings", { subjectType: "life", todoId: a, verdict: "archive", ruledAt: 1 });
      return { a, b };
    });
    await copyAll(t, "todos");
    await t.mutation(internal.jarvis.tables.remapTodoRefs, { chain: false });
    await t.mutation(internal.jarvis.tables.remapTodoStragglers, { chain: false });
    // What the new code does after the switch: edits a, leaves b, makes c
    // (needing a), a block and a time note on c, and a run naming c.
    const made = await t.run(async (ctx) => {
      const rows = await ctx.db.query("todos").collect();
      const a = rows.find((r) => r.statement === "a")!;
      await ctx.db.patch(a._id, { statement: "a, edited", updatedAt: 20 });
      const c = await ctx.db.insert("todos", { ...todo("c", 30), needs: [a._id] });
      const block = await ctx.db.insert("blocks", { start: 1, end: 2, todoId: c, createdAt: 1 });
      await ctx.db.insert("timeNotes", { text: "friday", todoId: c, blockId: block, status: "pending", createdAt: 1 });
      await ctx.db.insert("events", { kind: "job-ok", at: 2, provenance: {}, subject: c, data: {} });
      return { a: a._id, c };
    });
    const before = await t.action(internal.jarvis.tables.leftToUnmap, {});
    expect(before).toMatchObject({ rulings: 1, blocks: 1, timeNotes: 1, dtsEvents: 1, events: 1, todosNotCopiedBack: 1 });
    // An unmap before the copy back would leave c's references naming nothing.
    await expect(t.mutation(internal.jarvis.tables.unmapTodoStragglers, { chain: false })).rejects.toThrow(/copyBack/);

    const all = async (table: "todos" | "blocks" | "timeNotes") => {
      let cursor: string | null = null;
      for (;;) {
        const page: { isDone: boolean; continueCursor: string } = await t.mutation(internal.jarvis.tables.copyBack, { table, cursor, pageSize: 2, chain: false });
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    };
    await all("todos");
    await t.mutation(internal.jarvis.tables.copyBackNeeds, { chain: false });
    await all("blocks");
    await all("timeNotes");
    await t.mutation(internal.jarvis.tables.unmapTodoRefs, { chain: false });
    await t.mutation(internal.jarvis.tables.unmapTodoStragglers, { chain: false });
    await t.mutation(internal.jarvis.tables.unmapRunTodos, { chain: false });
    expect(await t.action(internal.jarvis.tables.leftToUnmap, {})).toEqual({
      rulings: 0, claudeSessions: 0, runs: 0, blocks: 0, timeNotes: 0, runners: 0, dtsEvents: 0, events: 0, todosNotCopiedBack: 0,
    });

    const back = await t.run(async (ctx) => ({
      todos: await ctx.db.query("dtsTodos").collect(),
      blocks: await ctx.db.query("dtsBlocks").collect(),
      notes: await ctx.db.query("dtsTimeNotes").collect(),
      ruling: (await ctx.db.query("rulings").collect())[0],
      dts: (await ctx.db.query("dtsEvents").collect())[0],
      events: await ctx.db.query("events").collect(),
      c: await ctx.db.get(made.c),
    }));
    const byStatement = new Map(back.todos.map((r) => [r.statement, r]));
    expect([...byStatement.keys()].sort()).toEqual(["a, edited", "b", "c"]);
    expect(byStatement.get("a, edited")!._id).toBe(old.a);
    const oldC = byStatement.get("c")!;
    expect(back.c!.legacyId).toBe(oldC._id);
    expect(oldC.needs).toEqual([old.a]);
    expect(back.blocks[0].todoId).toBe(oldC._id);
    expect(back.notes[0]).toMatchObject({ todoId: oldC._id, blockId: back.blocks[0]._id });
    expect(back.ruling.todoId).toBe(old.a);
    expect(back.dts.todoId).toBe(old.a);
    expect(back.events.map((e) => e.subject)).toEqual([oldC._id]);
    // A rerun changes nothing.
    await all("todos");
    expect(await t.run(async (ctx) => (await ctx.db.query("dtsTodos").collect()).length)).toBe(3);
  });
});
