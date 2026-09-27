import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { back, oldId } from "./jarvis/tables";

// Step B of the core tables' move (convex/jarvis/tables.ts): a reader that
// moved to todos, blocks or timeNotes returns what it returned from the old
// tables, for rows both hold. The fixtures are written through the doors, so
// the dual write made each plain row; `asOld` reads a plain row back in the
// old table's terms (its old id, and its references' old ids), and the two
// must match field for field.

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

/** A plain row in its old table's terms: the old id for its own and for
 *  every reference it holds; no legacyId; system fields left out. */
async function asOld(ctx: MutationCtx, table: "todos" | "blocks" | "timeNotes", row: Row) {
  const out: Record<string, unknown> = { _id: await oldId(ctx, table, row._id) };
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("_") || key === "legacyId") continue;
    if (key === "todoId") out[key] = await oldId(ctx, "todos", value as string);
    else if (key === "blockId") out[key] = await oldId(ctx, "blocks", value as string);
    else if (key === "needs") out[key] = await Promise.all((value as string[]).map((id) => oldId(ctx, "todos", id)));
    else out[key] = value;
  }
  return out;
}

/** An old row as the old reader returned it, system fields but _id left out. */
function old(row: Row) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (key === "_id" || !key.startsWith("_")) out[key] = value;
  return out;
}

const byId = (a: Record<string, unknown>, b: Record<string, unknown>) => String(a._id).localeCompare(String(b._id));

/** Three todos (one needing another), blocks on a todo and on a category, a
 *  time note on each context, one applied; every row through its door. */
async function seed(t: T) {
  const tom = await withTom(t);
  const now = Date.now();
  const lease = await tom.mutation(api.tts.createTodo, { statement: "renew the lease", dueAt: now + 3 * DAY });
  const call = await tom.mutation(api.tts.createTodo, { statement: "call the landlord", category: "home" });
  const forms = await tom.mutation(api.tts.createTodo, { statement: "print the forms" });
  await t.mutation(internal.tts.internalPrepareTodo, { id: lease, brief: "the brief", readiness: "prepared" });
  await tom.mutation(api.tts.setStatus, { id: forms, status: "done" });
  await t.run(async (ctx) => {
    await ctx.db.patch(lease, { needs: [call] });
    await back(ctx, "todos", lease);
  });
  const onTodo = await tom.mutation(api.tts.createBlock, { start: now - 3_600_000, end: now + 3_600_000, todoId: lease, note: "the hour" });
  await tom.mutation(api.tts.createBlock, { start: now + DAY, end: now + DAY + 3_600_000, category: "home" });
  await tom.mutation(api.tts.createTimeNote, { text: "friday", todoId: lease });
  await tom.mutation(api.tts.createTimeNote, { text: "an hour later", blockId: onTodo });
  const applied = await tom.mutation(api.tts.createTimeNote, { text: "today", day: "2026-09-27" });
  await t.mutation(internal.tts.internalApplyTimeNote, { id: applied, status: "applied", result: "noted" });
  await tom.mutation(api.ttsRulings.recordRuling, { todoId: call, verdict: "approve", sentence: "go ahead" });
  return { tom, lease, call, forms };
}

describe("the readers moved to the plain tables answer as the old tables did", () => {
  it("listTodos, internalListTodos", async () => {
    const t = convexTest({ schema, modules });
    const { tom } = await seed(t);
    const listed = await tom.query(api.tts.listTodos, {});
    const internalListed = await t.query(internal.tts.internalListTodos, {});
    expect(internalListed).toEqual(listed);
    await t.run(async (ctx) => {
      const moved = await Promise.all(listed.map((row) => asOld(ctx, "todos", row as Row)));
      const before = (await ctx.db.query("dtsTodos").collect()).map((row) => old(row as Row));
      expect(moved.sort(byId)).toEqual(before.sort(byId));
    });
  });

  it("listBlocks, whole and in a window", async () => {
    const t = convexTest({ schema, modules });
    const { tom } = await seed(t);
    const now = Date.now();
    for (const args of [{}, { start: now, end: now + 2 * 3_600_000 }] as { start?: number; end?: number }[]) {
      const listed = await tom.query(api.tts.listBlocks, args);
      await t.run(async (ctx) => {
        const moved = await Promise.all(listed.map((row) => asOld(ctx, "blocks", row as Row)));
        const all = (await ctx.db.query("dtsBlocks").collect()).map((row) => old(row as Row));
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
      const moved = await Promise.all(listed.map((row) => asOld(ctx, "timeNotes", row as Row)));
      const before = (await ctx.db.query("dtsTimeNotes").collect()).map((row) => old(row as Row));
      expect(moved.sort(byId)).toEqual(before.sort(byId));
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

  it("listRulings, listRecentEvents and the box's rulings feeds hand out the plain todo id", async () => {
    const t = convexTest({ schema, modules });
    const { tom, call } = await seed(t);
    // The door answers the plain id.
    const plainCall = call;
    const [ruling] = await tom.query(api.ttsRulings.listRulings, {});
    expect(ruling.todoId).toBe(plainCall);
    const recent = await t.query(internal.ttsRulings.internalRecentRulings, {});
    expect(recent.map((r) => r.todoId)).toEqual([plainCall]);
    // An approve on a life todo applies at once, so the pending feed holds a
    // session ruling instead.
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: plainCall, verdict: "session" });
    const pending = await t.query(internal.ttsRulings.internalPendingRulings, {});
    expect(pending.map((r) => r.todoId)).toEqual([plainCall]);
    const events = await tom.query(api.tts.listRecentEvents, {});
    const rulingEvents = events.filter((e) => e.kind === "ruling");
    expect(rulingEvents.map((e) => e.todoId)).toEqual([plainCall, plainCall]);
    // The rows store the plain id since the rulings writer moved (step C).
    await t.run(async (ctx) => {
      expect((await ctx.db.query("rulings").collect()).map((r) => r.todoId)).toEqual([call, call]);
    });
  });
});
