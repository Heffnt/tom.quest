import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { insertCopied } from "../test/core-tables";

// The readers of todos, blocks and timeNotes (convex/jarvis/tables.ts): each
// reads the plain rows, which since step C every writer writes, and hands
// out plain ids, whichever form a stored reference holds. The fixtures are
// written through the doors, plus one todo from before step C: a plain row
// carrying its old id, with a ruling and an event that store the old id.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

type T = ReturnType<typeof convexTest>;
type Row = Record<string, unknown> & { _id: string };

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

const DAY = 86_400_000;

async function withTom(t: T) {
  const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: tomId });
}

/** A row as a reader hands it out, system fields but _id left out. */
function fields(row: Row) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (key === "_id" || !key.startsWith("_")) out[key] = value;
  return out;
}

const byId = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a._id).localeCompare(String(b._id));

/** Three todos (one needing another), blocks on a todo and on a category, a
 *  time note on each context, one applied; every row through its door. And
 *  a todo from before step C, with a ruling and an event on its old id. */
async function seed(t: T) {
  const tom = await withTom(t);
  const now = Date.now();
  const lease = await tom.mutation(api.tts.createTodo, { statement: "renew the lease", dueAt: now + 3 * DAY });
  const call = await tom.mutation(api.tts.createTodo, { statement: "call the landlord", category: "home" });
  const forms = await tom.mutation(api.tts.createTodo, { statement: "print the forms" });
  await t.mutation(internal.tts.internalPrepareTodo, { id: lease, brief: "the brief", readiness: "prepared" });
  await tom.mutation(api.tts.setStatus, { id: forms, status: "done" });
  const before = await t.run(async (ctx) => {
    await ctx.db.patch(lease, { needs: [call] });
    const copied = await insertCopied(ctx, "todos", {
      statement: "the old todo",
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source: "test",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("rulings", { subjectType: "life", todoId: copied.old, verdict: "session", ruledAt: 1 });
    await ctx.db.insert("dtsEvents", { at: 1, kind: "ruling", todoId: copied.old });
    return copied;
  });
  const onTodo = await tom.mutation(api.tts.createBlock, { start: now - 3_600_000, end: now + 3_600_000, todoId: lease, note: "the hour" });
  await tom.mutation(api.tts.createBlock, { start: now + DAY, end: now + DAY + 3_600_000, category: "home" });
  await tom.mutation(api.tts.createTimeNote, { text: "friday", todoId: lease });
  await tom.mutation(api.tts.createTimeNote, { text: "an hour later", blockId: onTodo });
  const applied = await tom.mutation(api.tts.createTimeNote, { text: "today", day: "2026-09-27" });
  await t.mutation(internal.tts.internalApplyTimeNote, { id: applied, status: "applied", result: "noted" });
  await tom.mutation(api.ttsRulings.recordRuling, { todoId: call, verdict: "approve", sentence: "go ahead" });
  return { tom, lease, call, forms, before };
}

describe("the readers read the plain tables and hand out plain ids", () => {
  it("listTodos, internalListTodos", async () => {
    const t = convexTest({ schema, modules });
    const { tom } = await seed(t);
    const listed = await tom.query(api.tts.listTodos, {});
    const internalListed = await t.query(internal.tts.internalListTodos, {});
    expect(internalListed).toEqual(listed);
    expect(listed).toHaveLength(4);
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query("todos").collect()).map((row) => fields(row as Row));
      expect(listed.map((row) => fields(row as Row)).sort(byId)).toEqual(rows.sort(byId));
    });
  });

  it("listBlocks, whole and in a window", async () => {
    const t = convexTest({ schema, modules });
    const { tom } = await seed(t);
    const now = Date.now();
    for (const args of [{}, { start: now, end: now + 2 * 3_600_000 }] as { start?: number; end?: number }[]) {
      const listed = await tom.query(api.tts.listBlocks, args);
      await t.run(async (ctx) => {
        const moved = listed.map((row) => fields(row as Row));
        const all = (await ctx.db.query("blocks").collect()).map((row) => fields(row as Row));
        const { start, end } = args;
        const before =
          start === undefined || end === undefined
            ? all
            : all.filter((b) => (b.start as number) < end && (b.end as number) > start);
        expect(moved.length).toBeGreaterThan(0);
        expect(moved.sort(byId)).toEqual(before.sort(byId));
      });
    }
  });

  it("listTimeNotes", async () => {
    const t = convexTest({ schema, modules });
    const { tom } = await seed(t);
    const listed = await tom.query(api.tts.listTimeNotes, {});
    expect(listed).toHaveLength(3);
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query("timeNotes").collect()).map((row) => fields(row as Row));
      expect(listed.map((row) => fields(row as Row)).sort(byId)).toEqual(rows.sort(byId));
    });
  });

  it("internalPendingTimeNotes: each note's context in plain ids, the same facts", async () => {
    const t = convexTest({ schema, modules });
    const { lease } = await seed(t);
    const pending = await t.query(internal.tts.internalPendingTimeNotes, {});
    expect(pending.map((n) => n.text).sort()).toEqual(["an hour later", "friday"]);
    await t.run(async (ctx) => {
      const onTodo = pending.find((n) => n.text === "friday")!;
      const todo = (await ctx.db.get(lease))!;
      expect(onTodo.context).toEqual({
        kind: "todo",
        todo: {
          _id: onTodo.todoId,
          statement: todo.statement,
          status: todo.status,
          timingClass: todo.timingClass,
          dueAt: todo.dueAt ?? null,
          dateKind: todo.dateKind ?? null,
          wakeAt: null,
          dateOutcomes: [],
        },
      });
      expect(onTodo.todoId).toBe(lease);
      const onBlock = pending.find((n) => n.text === "an hour later")! as unknown as { context: { kind: string; block: Row; sameDayBlocks: Row[] } };
      expect(onBlock.context.kind).toBe("block");
      expect(onBlock.context.block).toMatchObject({ todoId: lease, note: "the hour" });
    });
  });

  it("internalScheduleAt names the todo a live block is on", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    expect(await t.query(internal.tts.internalScheduleAt, { at: Date.now() })).toEqual([
      expect.objectContaining({ note: "the hour", statement: "renew the lease" }),
    ]);
  });

  it("listRulings, listRecentEvents and the box's rulings feeds hand out the plain todo id, whichever form a row stores", async () => {
    const t = convexTest({ schema, modules });
    const { tom, call, before } = await seed(t);
    const rulings = await tom.query(api.ttsRulings.listRulings, {});
    expect(rulings.map((r) => r.todoId).sort()).toEqual([call, before.plain].sort());
    const recent = await t.query(internal.ttsRulings.internalRecentRulings, {});
    expect(recent.map((r) => r.todoId)).toEqual([call, before.plain]);
    // An approve on a life todo applies at once, so the pending feed holds a
    // session ruling instead.
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: call, verdict: "session" });
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.todoId).sort()).toEqual([call, before.plain].sort());
    const events = await tom.query(api.tts.listRecentEvents, {});
    const rulingEvents = events.filter((e) => e.kind === "ruling");
    expect(rulingEvents.map((e) => e.todoId)).toEqual([call, call, before.plain]);
    // The rows store the plain id since step C, the old one before it.
    await t.run(async (ctx) => {
      const stored = (await ctx.db.query("rulings").collect()).map((r) => r.todoId);
      expect(stored.filter((id) => id === call)).toHaveLength(2);
      expect(stored).toContain(before.old);
    });
  });
});
