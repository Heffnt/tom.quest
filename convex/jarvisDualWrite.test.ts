import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The dual write (convex/jarvis/tables.ts, `follow`): every writer of
// dtsTodos, dtsBlocks and dtsTimeNotes writes the plain row in the same
// mutation. Each test drives one writer through its own door and reads the
// plain row back; `followed` is leftToRemap reading zero, which holds only when
// every plain row matches its old row, stamp included.

type T = ReturnType<typeof convexTest>;
type Core = "todos" | "blocks" | "timeNotes";

async function withTom(t: T) {
  const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: tomId });
}

const plainOf = (t: T, table: Core, legacyId: string) =>
  t.run(async (ctx) => {
    const rows = (await ctx.db.query(table).collect()) as Array<Record<string, unknown> & { _id: string }>;
    return rows.find((row) => row.legacyId === legacyId) ?? null;
  });

async function followed(t: T) {
  const check = await t.action(internal.jarvis.tables.leftToRemap, {});
  expect(check.left).toEqual({
    todos: { notCopied: 0, stale: 0, version: 0, orphaned: 0, needs: 0 },
    blocks: { notCopied: 0, stale: 0, version: 0, orphaned: 0, todoId: 0 },
    timeNotes: { notCopied: 0, stale: 0, version: 0, orphaned: 0, todoId: 0, blockId: 0 },
  });
}

async function setup() {
  const t = convexTest({ schema, modules });
  const tom = await withTom(t);
  const id = await tom.mutation(api.tts.createTodo, { statement: "renew the lease" });
  return { t, tom, id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the dual write: each writer of the old core tables writes the plain row", () => {
  it("createTodo", async () => {
    const { t, id } = await setup();
    expect(await plainOf(t, "todos", id)).toMatchObject({ statement: "renew the lease", legacyId: id });
    await followed(t);
  });

  it("updateTodo", async () => {
    const { t, tom, id } = await setup();
    await tom.mutation(api.tts.updateTodo, { id, body: "the landlord's terms" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ body: "the landlord's terms" });
    await followed(t);
  });

  it("setStatus (applyStatusChange, and its Tom touch)", async () => {
    const { t, tom, id } = await setup();
    await tom.mutation(api.tts.setStatus, { id, status: "done" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ status: "done", tomTouchedAt: expect.any(Number) });
    await followed(t);
  });

  it("internalTriage", async () => {
    const { t, id } = await setup();
    const dueAt = Date.now() + 3 * DAY_MS;
    await t.mutation(internal.tts.internalTriage, { id, dueAt, status: "waiting", wakeAt: dueAt });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt, status: "waiting", tomTouchedAt: expect.any(Number) });
    await followed(t);
  });

  it("internalBulkUpdate", async () => {
    const { t, id } = await setup();
    await t.mutation(internal.tts.internalBulkUpdate, { updates: [{ id, category: "home", entryAction: "call" }] });
    expect(await plainOf(t, "todos", id)).toMatchObject({ category: "home", entryAction: "call" });
    await followed(t);
  });

  it("recordDateOutcome (applyDateOutcome)", async () => {
    const { t, tom } = await setup();
    const dueAt = Date.now() + 3 * DAY_MS;
    const id = await tom.mutation(api.tts.createTodo, { statement: "file taxes", dueAt });
    await tom.mutation(api.tts.recordDateOutcome, { id, outcome: "renegotiated", newDueAt: dueAt + DAY_MS });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt: dueAt + DAY_MS, dateOutcomes: [expect.objectContaining({ outcome: "renegotiated" })] });
    await followed(t);
  });

  it("internalRollMissed (recordMissedKeepingDate)", async () => {
    const { t, tom } = await setup();
    const id = await tom.mutation(api.tts.createTodo, { statement: "pay rent", dueAt: Date.UTC(2026, 0, 5, 17) });
    expect(await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-09-27" })).toEqual([id]);
    expect(await plainOf(t, "todos", id)).toMatchObject({ dateOutcomes: [expect.objectContaining({ outcome: "missed" })] });
    await followed(t);
  });

  it("createBlock, updateBlock, deleteBlock (and the plain notes that named the block)", async () => {
    const { t, tom, id } = await setup();
    const blockId = await tom.mutation(api.tts.createBlock, { start: 1_000, end: 2_000, todoId: id });
    const plainTodo = (await plainOf(t, "todos", id))!;
    expect(await plainOf(t, "blocks", blockId)).toMatchObject({ start: 1_000, todoId: plainTodo._id });
    await tom.mutation(api.tts.updateBlock, { id: blockId, start: 1_500, note: "moved" });
    expect(await plainOf(t, "blocks", blockId)).toMatchObject({ start: 1_500, note: "moved" });
    const noteId = await tom.mutation(api.tts.createTimeNote, { text: "longer", blockId });
    const plainBlock = (await plainOf(t, "blocks", blockId))!;
    expect(await plainOf(t, "timeNotes", noteId)).toMatchObject({ blockId: plainBlock._id });
    await followed(t);
    await tom.mutation(api.tts.deleteBlock, { id: blockId });
    expect(await plainOf(t, "blocks", blockId)).toBeNull();
    expect(await plainOf(t, "timeNotes", noteId)).not.toHaveProperty("blockId");
    await followed(t);
  });

  it("createTimeNote and deleteTimeNote", async () => {
    const { t, tom, id } = await setup();
    const noteId = await tom.mutation(api.tts.createTimeNote, { text: "push to Friday", todoId: id });
    const plainTodo = (await plainOf(t, "todos", id))!;
    expect(await plainOf(t, "timeNotes", noteId)).toMatchObject({ text: "push to Friday", todoId: plainTodo._id, status: "pending" });
    await followed(t);
    await tom.mutation(api.tts.deleteTimeNote, { id: noteId });
    expect(await plainOf(t, "timeNotes", noteId)).toBeNull();
    await followed(t);
  });

  it("internalCreateTimeNote and internalApplyTimeNote (its todo, block and note writes)", async () => {
    const { t, id } = await setup();
    const noteId = await t.mutation(internal.tts.internalCreateTimeNote, { text: "Friday, and a block", todoId: id });
    const dueAt = Date.now() + 5 * DAY_MS;
    await t.mutation(internal.tts.internalApplyTimeNote, {
      id: noteId,
      status: "applied",
      result: "dated and blocked",
      actions: [
        { kind: "set-due", dueAt },
        { kind: "set-date-kind", dateKind: "external" },
        { kind: "create-block", start: dueAt - 7_200_000, end: dueAt - 3_600_000, todoId: id },
      ],
    });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt, dateKind: "external", tomTouchedAt: expect.any(Number) });
    expect(await plainOf(t, "timeNotes", noteId)).toMatchObject({ status: "applied", result: "dated and blocked" });
    expect(await t.run((ctx) => ctx.db.query("blocks").collect())).toHaveLength(1);
    await followed(t);
  });

  it("internalApplyTimeNote set-due alone", async () => {
    const { t, id } = await setup();
    const noteId = await t.mutation(internal.tts.internalCreateTimeNote, { text: "Friday", todoId: id });
    const dueAt = Date.now() + 5 * DAY_MS;
    await t.mutation(internal.tts.internalApplyTimeNote, { id: noteId, status: "applied", result: "dated", actions: [{ kind: "set-due", dueAt }] });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt, timingClass: "dated" });
    await followed(t);
  });

  it("internalApplyTimeNote set-waiting (its Tom touch)", async () => {
    const { t, id } = await setup();
    const noteId = await t.mutation(internal.tts.internalCreateTimeNote, { text: "wait a week", todoId: id });
    const wakeAt = Date.now() + 7 * DAY_MS;
    await t.run((ctx) => ctx.db.patch(id, { tomTouchedAt: 1 }));
    await t.mutation(internal.tts.internalApplyTimeNote, { id: noteId, status: "applied", result: "asleep", actions: [{ kind: "set-waiting", wakeAt }] });
    const plain = (await plainOf(t, "todos", id))!;
    expect(plain).toMatchObject({ status: "waiting", wakeAt });
    expect(plain.tomTouchedAt).toBeGreaterThan(1);
    await followed(t);
  });

  it("internalCapture and internalPrepareTodo", async () => {
    const t = convexTest({ schema, modules });
    const id = (await t.mutation(internal.tts.internalCapture, { statement: "buy tape", source: "slack-capture" })) as unknown as Id<"dtsTodos">;
    expect(await plainOf(t, "todos", id)).toMatchObject({ statement: "buy tape", source: "slack-capture" });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      brief: "Tape for finger protection.",
      entryAction: "Open the retailer page",
      workDescription: "a two-minute errand",
      readiness: "prepared",
    });
    expect(await plainOf(t, "todos", id)).toMatchObject({ readiness: "prepared", brief: "Tape for finger protection." });
    await followed(t);
  });

  it("keeps leftToRemap at zero across a run of writes through several doors", async () => {
    const { t, tom, id } = await setup();
    const other = await tom.mutation(api.tts.createTodo, { statement: "sign it", dueAt: Date.now() + 2 * DAY_MS });
    await tom.mutation(api.tts.updateTodo, { id, statement: "renew the lease, two years" });
    const blockId = await tom.mutation(api.tts.createBlock, { start: 10, end: 20, todoId: other });
    await tom.mutation(api.tts.updateBlock, { id: blockId, end: 30 });
    const noteId = await tom.mutation(api.tts.createTimeNote, { text: "later", todoId: other });
    await t.mutation(internal.tts.internalApplyTimeNote, { id: noteId, status: "needs-session", result: "ambiguous" });
    await tom.mutation(api.tts.setStatus, { id, status: "done" });
    await tom.mutation(api.tts.deleteBlock, { id: blockId });
    await followed(t);
    expect(await t.run((ctx) => ctx.db.query("todos").collect())).toHaveLength(2);
  });
});
