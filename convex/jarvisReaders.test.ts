import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { insertCopied } from "../test/core-tables";

// The todo readers (convex/jarvis/tables.ts) read the plain rows, which since
// step C every writer writes, and hand
// out plain ids, whichever form a stored reference holds. The fixtures are
// written through the doors, plus one todo from before step C: an old row
// and its plain copy, with a ruling and an event that store its old id.

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

/** Three todos (one needing another), and a todo from before step C with a
 *  ruling and an event on its old id. */
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
