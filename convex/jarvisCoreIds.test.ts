import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resolveId, todoEvents, todoRulings } from "./jarvis/tables";
import { newestTodoEvents, todoHasEventSince, withPlainTodoIds } from "./jarvis/tables";
import { logEvent } from "./tts";
import { insertCopied } from "../test/core-tables";

// The core tables' move (convex/jarvis/tables.ts): a todo, block or time
// note id reaches the record from outside in either form, the old table's id
// (an old link, a Slack thread, a stored reference) or the plain row's, and
// every door resolves it to the plain row, which since step C is the row it
// writes.

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

/** A todo, a block on it and a time note on the block from before step C
 *  (each an old row and its plain copy), with both ids of each. */
async function seed(t: T) {
  const tom = await withTom(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const fields = { statement: "renew the lease", readiness: "unprepared" as const, status: "active" as const, timingClass: "dated" as const, dueAt: now + 3 * DAY, dateKind: "self-imposed" as const, source: "manual", createdAt: now, updatedAt: now };
    const todo = await insertCopied(ctx, "todos", fields);
    const span = { start: now + DAY, end: now + DAY + 3_600_000, createdAt: now };
    const block = await insertCopied(ctx, "blocks", { ...span, todoId: todo.plain }, { ...span, todoId: todo.old });
    const note = await insertCopied(
      ctx,
      "timeNotes",
      { text: "move it to Friday", blockId: block.plain, status: "pending" as const, createdAt: now },
      { text: "move it to Friday", blockId: block.old, status: "pending" as const, createdAt: now },
    );
    return { todo, block, note };
  });
  return {
    tom,
    old: { todo: ids.todo.old, block: ids.block.old, note: ids.note.old },
    plain: { todo: ids.todo.plain, block: ids.block.plain, note: ids.note.plain },
  };
}

describe("an id in either form", () => {
  it("resolves to the plain row from either form; anything else is null", async () => {
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
        expect(await resolveId(ctx, table, "not-an-id")).toBeNull();
      }
      // An id of another table names nothing here.
      expect(await resolveId(ctx, "todos", old.block)).toBeNull();
      expect(await resolveId(ctx, "blocks", plain.todo)).toBeNull();
    });
  });

  for (const form of ["old", "plain"] as const) {
    it(`reaches the same row through every door given the ${form} id`, async () => {
      const t = convexTest({ schema, modules });
      const { tom, old, plain } = await seed(t);
      const ids = form === "old" ? old : plain;
      const oldRows = () => t.run(async (ctx) => [await ctx.db.get(old.todo), await ctx.db.get(old.block), await ctx.db.get(old.note)]);
      const before = await oldRows();
      const row = () => t.run(async (ctx) => (await ctx.db.get(plain.todo))!);

      await tom.mutation(api.tts.updateTodo, { id: ids.todo, body: "the landlord's terms" });
      expect((await row()).body).toBe("the landlord's terms");
      await tom.mutation(api.tts.recordEvent, { kind: "opened", todoId: ids.todo });
      await t.mutation(internal.tts.internalPrepareTodo, { id: ids.todo, brief: "call the landlord", readiness: "prepared" });
      expect((await row()).brief).toBe("call the landlord");
      await t.mutation(internal.tts.internalBulkUpdate, { updates: [{ id: ids.todo, category: "home" }] });
      expect((await row()).category).toBe("home");

      // A ruling, a block and a time note store the plain id since step C.
      const rulingId = await tom.mutation(api.ttsRulings.recordRuling, { todoId: ids.todo, verdict: "approve" });
      expect(await t.run(async (ctx) => (await ctx.db.get(rulingId))!.todoId)).toBe(plain.todo);
      const second = await tom.mutation(api.tts.createBlock, { start: Date.now() + 2 * DAY, end: Date.now() + 2 * DAY + 60_000, todoId: ids.todo });
      expect(await t.run(async (ctx) => (await ctx.db.get(second))!.todoId)).toBe(plain.todo);
      await tom.mutation(api.tts.updateBlock, { id: ids.block, note: "bring the forms" });
      expect(await t.run(async (ctx) => (await ctx.db.get(plain.block))!.note)).toBe("bring the forms");
      const onTodo = await tom.mutation(api.tts.createTimeNote, { text: "friday", todoId: ids.todo });
      expect(await t.run(async (ctx) => (await ctx.db.get(onTodo))!.todoId)).toBe(plain.todo);
      await t.mutation(internal.tts.internalApplyTimeNote, {
        id: ids.note,
        status: "applied",
        result: "moved the block",
        actions: [{ kind: "update-block", blockId: ids.block, start: Date.now() + 3 * DAY, end: Date.now() + 3 * DAY + 60_000 }],
      });
      expect(await t.run(async (ctx) => (await ctx.db.get(plain.note))!.status)).toBe("applied");
      await tom.mutation(api.tts.deleteTimeNote, { id: onTodo });
      expect(await t.run(async (ctx) => await ctx.db.get(onTodo))).toBeNull();

      await tom.mutation(api.tts.setStatus, { id: ids.todo, status: "done" });
      expect((await row()).status).toBe("done");
      await tom.mutation(api.tts.deleteBlock, { id: ids.block });
      expect(await t.run(async (ctx) => await ctx.db.get(plain.block))).toBeNull();
      // Nothing wrote an old row.
      expect(await oldRows()).toEqual(before);
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

describe("a todo reference naming no row", () => {
  it("names no todo: a written event stores none, and a stored one is handed out as none", async () => {
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    await t.run(async (ctx) => {
      const gone = await ctx.db.insert("todos", { statement: "gone", status: "active", readiness: "prepared", timingClass: "whenever", source: "tom", createdAt: 1, updatedAt: 1 });
      await ctx.db.delete(gone);
      const written = await logEvent(ctx, "opened", gone);
      expect((await ctx.db.get(written))!.todoId).toBeUndefined();
      expect((await ctx.db.get(await logEvent(ctx, "opened", old.todo)))!.todoId).toBe(plain.todo);
      const handed = await withPlainTodoIds(ctx, [{ n: 1, todoId: gone as string }, { n: 2, todoId: old.todo as string }, { n: 3 }]);
      expect(handed).toEqual([{ n: 1 }, { n: 2, todoId: plain.todo }, { n: 3 }]);
    });
  });
});

describe("the newest events on a todo", () => {
  it("reads the newest n under each form through the index, merged newest first", async () => {
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("dtsEvents", { at: 1_000 + 2 * i, kind: "old-form", todoId: old.todo });
        await ctx.db.insert("dtsEvents", { at: 1_001 + 2 * i, kind: "plain-form", todoId: plain.todo });
      }
      const newest = await newestTodoEvents(ctx, old.todo, 100);
      expect(newest).toHaveLength(100);
      // The seed's own rows (written now) first, then the newest fixtures.
      const fixtures = newest.filter((e) => e.at < 10_000);
      expect(fixtures[0].at).toBe(1_299);
      expect(fixtures.map((e) => e.at)).toEqual([...fixtures.map((e) => e.at)].sort((a, b) => b - a));
      expect(new Set(fixtures.map((e) => e.kind))).toEqual(new Set(["old-form", "plain-form"]));
      expect(await newestTodoEvents(ctx, plain.todo, 100)).toEqual(newest);
    });
  });

  it("the ask context finds an objection stored under either id", async () => {
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "delegate-objection", todoId: plain.todo, data: { askId: "a1", revert: true } });
    });
    const context = await t.query(internal.ttsAsk.internalAskContext, { todoId: old.todo });
    expect(context.priorObjections.map((o) => o.askId)).toEqual(["a1"]);
  });
});

describe("an event of one kind on a todo since a time", () => {
  it("is found under either id through by_todo_kind, from the time on, and no other kind counts", async () => {
    const t = convexTest({ schema, modules });
    const { old, plain } = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) await ctx.db.insert("dtsEvents", { at: 2_000 + i, kind: "surfaced", todoId: old.todo });
      await ctx.db.insert("dtsEvents", { at: 1_000, kind: "slack-event", todoId: old.todo });
      for (const id of [old.todo, plain.todo]) {
        expect(await todoHasEventSince(ctx, id, "slack-event", 1_000)).toBe(true);
        expect(await todoHasEventSince(ctx, id, "slack-event", 1_001)).toBe(false);
        expect(await todoHasEventSince(ctx, id, "surfaced", 2_499)).toBe(true);
      }
      await ctx.db.insert("dtsEvents", { at: 3_000, kind: "slack-event", todoId: plain.todo });
      expect(await todoHasEventSince(ctx, old.todo, "slack-event", 1_001)).toBe(true);
      const direct = await ctx.db
        .query("dtsEvents")
        .withIndex("by_todo_kind", (q) => q.eq("todoId", plain.todo).eq("kind", "slack-event").gte("at", 1_001))
        .collect();
      expect(direct.map((e) => e.at)).toEqual([3_000]);
    });
  });
});

describe("a Slack send on a todo named by either id", () => {
  it("stamps the reply on the plain row and leaves the old row as it was", async () => {
    for (const form of ["old", "plain"] as const) {
      const t = convexTest({ schema, modules });
      const { old, plain } = await seed(t);
      await t.mutation(internal.ttsSlack.internalRecordSlackSent, { channel: "C-dump", ts: "9000.1", subject: { kind: "todo", id: form === "old" ? old.todo : plain.todo }, text: "captured" });
      await t.run(async (ctx) => {
        expect(await ctx.db.get(plain.todo)).toMatchObject({ slackReplyTs: "9000.1" });
        expect(await ctx.db.get(old.todo)).not.toHaveProperty("slackReplyTs");
      });
    }
  });
});
