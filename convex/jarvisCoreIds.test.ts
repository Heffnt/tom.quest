import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { oldId, resolveId, todoEvents, todoRulings } from "./jarvis/tables";

// Step B of the core tables' move (convex/jarvis/tables.ts): a todo, block or
// time note id reaches the record from outside in either form, the old
// table's id (an old link, a Slack thread, a stored reference) or the plain
// row's, and every door resolves it.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type T = ReturnType<typeof convexTest>;

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

async function withTom(t: T) {
  const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: tomId });
}

const DAY = 86_400_000;

/** A todo, a block on it and a time note on the block, written through the
 *  doors (so the dual write made their plain rows), with both ids of each. */
async function seed(t: T) {
  const tom = await withTom(t);
  const todo = await tom.mutation(api.tts.createTodo, { statement: "renew the lease", dueAt: Date.now() + 3 * DAY });
  const block = await tom.mutation(api.tts.createBlock, { start: Date.now() + DAY, end: Date.now() + DAY + 3_600_000, todoId: todo });
  const note = await tom.mutation(api.tts.createTimeNote, { text: "move it to Friday", blockId: block });
  const plain = await t.run(async (ctx) => ({
    todo: (await resolveId(ctx, "todos", todo))!,
    block: (await resolveId(ctx, "blocks", block))!,
    note: (await resolveId(ctx, "timeNotes", note))!,
  }));
  return { tom, old: { todo, block, note }, plain };
}

async function followed(t: T) {
  expect((await t.action(internal.jarvis.tables.leftToRemap, {})).zero).toBe(true);
}

describe("an id in either form", () => {
  it("resolves to the plain row and to the old row, from either form; anything else is null", async () => {
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    await t.run(async (ctx) => {
      expect(plain.todo).not.toBe(old.todo);
      for (const [table, o, p] of [
        ["todos", old.todo, plain.todo],
        ["blocks", old.block, plain.block],
        ["timeNotes", old.note, plain.note],
      ] as const) {
        expect(await resolveId(ctx, table, o)).toBe(p);
        expect(await resolveId(ctx, table, p)).toBe(p);
        expect(await oldId(ctx, table, o)).toBe(o);
        expect(await oldId(ctx, table, p)).toBe(o);
        expect(await resolveId(ctx, table, "not-an-id")).toBeNull();
        expect(await oldId(ctx, table, "not-an-id")).toBeNull();
      }
      // An id of another table names nothing here.
      expect(await resolveId(ctx, "todos", old.block)).toBeNull();
      expect(await oldId(ctx, "blocks", plain.todo)).toBeNull();
    });
  });

  for (const form of ["old", "plain"] as const) {
    it(`reaches the same row through every door given the ${form} id`, async () => {
      const t = convexTest({ schema, modules });
      const { tom, old, plain } = await seed(t);
      const ids = form === "old" ? old : plain;
      const row = () => t.run(async (ctx) => (await ctx.db.get(old.todo))!);

      await tom.mutation(api.tts.updateTodo, { id: ids.todo, body: "the landlord's terms" });
      expect((await row()).body).toBe("the landlord's terms");
      await tom.mutation(api.tts.recordEvent, { kind: "opened", todoId: ids.todo });
      await t.mutation(internal.tts.internalPrepareTodo, { id: ids.todo, brief: "call the landlord", readiness: "prepared" });
      expect((await row()).brief).toBe("call the landlord");
      await t.mutation(internal.tts.internalBulkUpdate, { updates: [{ id: ids.todo, category: "home" }] });
      expect((await row()).category).toBe("home");

      // A ruling, a block and a time note store the old id, as they did.
      const rulingId = await tom.mutation(api.ttsRulings.recordRuling, { todoId: ids.todo, verdict: "approve" });
      expect(await t.run(async (ctx) => (await ctx.db.get(rulingId))!.todoId)).toBe(old.todo);
      const second = await tom.mutation(api.tts.createBlock, { start: Date.now() + 2 * DAY, end: Date.now() + 2 * DAY + 60_000, todoId: ids.todo });
      expect(await t.run(async (ctx) => (await ctx.db.get(second))!.todoId)).toBe(old.todo);
      await tom.mutation(api.tts.updateBlock, { id: ids.block, note: "bring the forms" });
      expect(await t.run(async (ctx) => (await ctx.db.get(old.block))!.note)).toBe("bring the forms");
      const onTodo = await tom.mutation(api.tts.createTimeNote, { text: "friday", todoId: ids.todo });
      expect(await t.run(async (ctx) => (await ctx.db.get(onTodo))!.todoId)).toBe(old.todo);
      await t.mutation(internal.tts.internalApplyTimeNote, {
        id: ids.note,
        status: "applied",
        result: "moved the block",
        actions: [{ kind: "update-block", blockId: ids.block, start: Date.now() + 3 * DAY, end: Date.now() + 3 * DAY + 60_000 }],
      });
      expect(await t.run(async (ctx) => (await ctx.db.get(old.note))!.status)).toBe("applied");
      const onTodoPlain = await t.run(async (ctx) => (await resolveId(ctx, "timeNotes", onTodo))!);
      await tom.mutation(api.tts.deleteTimeNote, { id: form === "old" ? onTodo : onTodoPlain });
      expect(await t.run(async (ctx) => await ctx.db.get(onTodo))).toBeNull();

      await tom.mutation(api.tts.setStatus, { id: ids.todo, status: "done" });
      expect((await row()).status).toBe("done");
      await tom.mutation(api.tts.deleteBlock, { id: ids.block });
      expect(await t.run(async (ctx) => await ctx.db.get(old.block))).toBeNull();
      await followed(t);
    });
  }
});

// Step C: a stored reference (a ruling's, an event's, a session's, a run's)
// holds a todo's old id when it was written before the step and the plain id
// after it. Readers read both as the one todo.
describe("a stored todo reference in either form", () => {
  it("a todo's events and rulings are read under both ids", async () => {
    const t = convexTest({ schema, modules });
    const { tom, old, plain } = await seed(t);
    await tom.mutation(api.tts.recordEvent, { kind: "opened", todoId: old.todo });
    // "session" stays pending until its session exists.
    const approve = await tom.mutation(api.ttsRulings.recordRuling, { todoId: plain.todo, verdict: "session" });
    const revise = await t.run(async (ctx) => {
      // The door stored the old id; a row written after step C, the plain one.
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "plain-form", todoId: plain.todo });
      for (const id of [old.todo, plain.todo]) {
        expect((await todoEvents(ctx, id)).map((e) => e.kind)).toEqual(expect.arrayContaining(["opened", "plain-form"]));
      }
      // A newer ruling stored under the other form is the same subject's.
      const stored = (await ctx.db.get(approve))!.todoId;
      return await ctx.db.insert("rulings", {
        subjectType: "life",
        todoId: stored === old.todo ? plain.todo : old.todo,
        verdict: "revise",
        sentence: "ask the landlord first",
        ruledAt: Date.now() + 1,
      });
    });
    await t.run(async (ctx) => {
      expect((await todoRulings(ctx, old.todo)).map((r) => r.todoId)).toEqual([plain.todo, plain.todo]);
    });
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => [r._id, r.todoId])).toEqual([[revise, plain.todo]]);
  });
});
