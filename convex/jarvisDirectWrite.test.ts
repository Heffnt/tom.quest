import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { slackThreadKey } from "./ttsShared";
import { insertCopied } from "../test/core-tables";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// The direct write (convex/jarvis/tables.ts, step C): every writer of todos,
// blocks and time notes writes the plain row, the one row there is since the
// old tables left the schema. Each test drives one writer through its own
// door and reads the plain row back. A todo from before step C, reached by its
// old id, is jarvisCoreIds.test.ts's.

type T = ReturnType<typeof convexTest>;
type Core = "todos" | "blocks" | "timeNotes";

async function withTom(t: T) {
  const tomId = await t.run(async (ctx) => ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }));
  return t.withIdentity({ subject: tomId });
}

/** The plain row a door's id names. */
const plainOf = (t: T, table: Core, id: string) =>
  t.run(async (ctx) => {
    const rows = (await ctx.db.query(table).collect()) as Array<Record<string, unknown> & { _id: string }>;
    return rows.find((row) => row._id === id) ?? null;
  });

async function setup() {
  const t = convexTest({ schema, modules });
  const tom = await withTom(t);
  const id = await tom.mutation(api.tts.createTodo, { statement: "renew the lease" });
  return { t, tom, id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the direct write: each writer writes the plain row", () => {
  it("createTodo", async () => {
    const { t, id } = await setup();
    expect(await plainOf(t, "todos", id)).toMatchObject({ statement: "renew the lease" });
    expect(await plainOf(t, "todos", id)).not.toHaveProperty("legacyId");
  });

  it("a todo: the door answers the plain id, and what stores a reference stores it", async () => {
    const { t, tom, id } = await setup();
    const rulingId = await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "revise", sentence: "shorter" });
    const noteId = await tom.mutation(api.tts.createTimeNote, { text: "friday", todoId: id });
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(id))!;
      expect(row).toMatchObject({ statement: "renew the lease", readiness: "unprepared" });
      expect((await ctx.db.get(rulingId))!.todoId).toBe(id);
      expect((await ctx.db.get(noteId))!.todoId).toBe(id);
      const events = (await ctx.db.query("dtsEvents").collect()).filter((e) => e.todoId !== undefined);
      expect(new Set(events.map((e) => e.todoId))).toEqual(new Set([id]));
    });
  });

  it("updateTodo", async () => {
    const { t, tom, id } = await setup();
    await tom.mutation(api.tts.updateTodo, { id, body: "the landlord's terms" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ body: "the landlord's terms" });
  });

  it("setStatus (applyStatusChange, and its Tom touch)", async () => {
    const { t, tom, id } = await setup();
    await tom.mutation(api.tts.setStatus, { id, status: "done" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ status: "done", tomTouchedAt: expect.any(Number) });
  });

  it("internalTriage", async () => {
    const { t, id } = await setup();
    const dueAt = Date.now() + 3 * DAY_MS;
    await t.mutation(internal.tts.internalTriage, { id, dueAt, status: "waiting", wakeAt: dueAt });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt, status: "waiting", tomTouchedAt: expect.any(Number) });
  });

  it("internalBulkUpdate", async () => {
    const { t, id } = await setup();
    await t.mutation(internal.tts.internalBulkUpdate, { updates: [{ id, category: "home", entryAction: "call" }] });
    expect(await plainOf(t, "todos", id)).toMatchObject({ category: "home", entryAction: "call" });
  });

  it("recordDateOutcome (applyDateOutcome)", async () => {
    const { t, tom } = await setup();
    const dueAt = Date.now() + 3 * DAY_MS;
    const id = await tom.mutation(api.tts.createTodo, { statement: "file taxes", dueAt });
    await tom.mutation(api.tts.recordDateOutcome, { id, outcome: "renegotiated", newDueAt: dueAt + DAY_MS });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt: dueAt + DAY_MS, dateOutcomes: [expect.objectContaining({ outcome: "renegotiated" })] });
  });

  it("internalRollMissed (recordMissedKeepingDate)", async () => {
    const { t, tom } = await setup();
    const id = await tom.mutation(api.tts.createTodo, { statement: "pay rent", dueAt: Date.UTC(2026, 0, 5, 17) });
    expect(await t.mutation(internal.ttsDigest.internalRollMissed, { day: "2026-09-27" })).toEqual([id]);
    expect(await plainOf(t, "todos", id)).toMatchObject({ dateOutcomes: [expect.objectContaining({ outcome: "missed" })] });
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
    await tom.mutation(api.tts.deleteBlock, { id: blockId });
    expect(await plainOf(t, "blocks", blockId)).toBeNull();
    expect(await plainOf(t, "timeNotes", noteId)).not.toHaveProperty("blockId");
  });

  it("a block and a time note: the door answers the plain id, and each stores plain ids", async () => {
    const { t, tom, id } = await setup();
    const plainTodo = (await plainOf(t, "todos", id))!;
    const blockId = await tom.mutation(api.tts.createBlock, { start: 1_000, end: 2_000, todoId: id });
    const noteId = await tom.mutation(api.tts.createTimeNote, { text: "longer", blockId });
    await t.run(async (ctx) => {
      const block = (await ctx.db.get(blockId))!;
      const note = (await ctx.db.get(noteId))!;
      expect(block).toMatchObject({ start: 1_000, todoId: plainTodo._id });
      expect(note).toMatchObject({ blockId });
    });
    await tom.mutation(api.tts.deleteTimeNote, { id: noteId });
    expect(await plainOf(t, "timeNotes", noteId)).toBeNull();
  });

  it("deleteBlock with more than a page of notes: the rest are cleared by scheduled pages", async () => {
    const { t, tom, id } = await setup();
    const blockId = await tom.mutation(api.tts.createBlock, { start: 1_000, end: 2_000, todoId: id });
    for (let i = 0; i < 230; i++) await tom.mutation(api.tts.createTimeNote, { text: `note ${i}`, blockId });
    const named = () =>
      t.run(async (ctx) => (await ctx.db.query("timeNotes").collect()).filter((note) => note.blockId !== undefined).length);
    expect(await named()).toBe(230);
    vi.useFakeTimers();
    try {
      await tom.mutation(api.tts.deleteBlock, { id: blockId });
      // One page in the deletion itself; the check counts the rest until the
      // scheduled pages have run.
      expect(await named()).toBe(130);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(await named()).toBe(0);
  });

  it("createTimeNote and deleteTimeNote", async () => {
    const { t, tom, id } = await setup();
    const noteId = await tom.mutation(api.tts.createTimeNote, { text: "push to Friday", todoId: id });
    const plainTodo = (await plainOf(t, "todos", id))!;
    expect(await plainOf(t, "timeNotes", noteId)).toMatchObject({ text: "push to Friday", todoId: plainTodo._id, status: "pending" });
    await tom.mutation(api.tts.deleteTimeNote, { id: noteId });
    expect(await plainOf(t, "timeNotes", noteId)).toBeNull();
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
  });

  it("internalApplyTimeNote set-due alone", async () => {
    const { t, id } = await setup();
    const noteId = await t.mutation(internal.tts.internalCreateTimeNote, { text: "Friday", todoId: id });
    const dueAt = Date.now() + 5 * DAY_MS;
    await t.mutation(internal.tts.internalApplyTimeNote, { id: noteId, status: "applied", result: "dated", actions: [{ kind: "set-due", dueAt }] });
    expect(await plainOf(t, "todos", id)).toMatchObject({ dueAt, timingClass: "dated" });
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
  });

  it("internalCapture and internalPrepareTodo", async () => {
    const t = convexTest({ schema, modules });
    const id = (await t.mutation(internal.tts.internalCapture, { statement: "buy tape", source: "slack-capture" })) as Id<"todos">;
    expect(await plainOf(t, "todos", id)).toMatchObject({ statement: "buy tape", source: "slack-capture" });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      brief: "Tape for finger protection.",
      entryAction: "Open the retailer page",
      workDescription: "a two-minute errand",
      readiness: "prepared",
    });
    expect(await plainOf(t, "todos", id)).toMatchObject({ readiness: "prepared", brief: "Tape for finger protection." });
  });

  it("recordRuling (insertRuling's Tom touch and revise)", async () => {
    const { t, tom, id } = await setup();
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "approve" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ tomTouchedAt: expect.any(Number) });
    await tom.mutation(api.ttsRulings.recordRuling, { todoId: id, verdict: "revise", sentence: "shorter" });
    expect(await plainOf(t, "todos", id)).toMatchObject({ readiness: "unprepared" });
  });

  it("internalRecordSlackSent (recordSlackSent)", async () => {
    const { t, id } = await setup();
    await t.mutation(internal.ttsSlack.internalRecordSlackSent, {
      channel: "C-dump",
      ts: "9000.1",
      subject: { kind: "todo", id },
      text: "captured",
    });
    expect(await plainOf(t, "todos", id)).toMatchObject({ slackReplyTs: "9000.1", slackRepliedAt: expect.any(Number) });
  });

  it("a Slack send and a thread reply store the plain todo id, given a thread that names the old one", async () => {
    const { t } = await setup();
    // A todo from before step C: the plain row, carrying its old id.
    const { old: legacy, plain: id } = await t.run(async (ctx) =>
      await insertCopied(ctx, "todos", { statement: "the old todo", readiness: "unprepared", status: "active", timingClass: "whenever", source: "test", createdAt: 1, updatedAt: 1 }),
    );
    // A needs-you post supplies the old id: the row stores the plain one.
    await t.mutation(internal.ttsSlack.internalRecordSlackSent, { channel: "C-today", ts: "9100.1", subject: { kind: "todo", id: legacy }, text: "needs you" });
    // A thread opened before step C, whose row names the old id.
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", {
        at: Date.now() - 1_000,
        kind: "slack-sent",
        key: slackThreadKey("C-dump", "9000.1"),
        todoId: legacy,
        data: { channel: "C-dump", ts: "9000.1", subject: { kind: "todo", id: legacy }, text: "captured" },
      });
    });
    await t.mutation(internal.ttsSlack.internalSlackThreadReply, { eventId: "Ev1", channel: "C-dump", threadTs: "9000.1", ts: "9000.2", text: "the landlord called back", user: "UTOM" });
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query("dtsEvents").collect()).filter((e) => ["slack-sent", "slack-event", "tom-note"].includes(e.kind));
      const fresh = rows.filter((e) => !(e.kind === "slack-sent" && e.key === slackThreadKey("C-dump", "9000.1")));
      expect(fresh.map((e) => e.kind).sort()).toEqual(["slack-event", "slack-sent", "tom-note"]);
      for (const e of fresh) {
        expect(e.todoId).toBe(id);
        expect((e.data as { subject: { id: string } }).subject.id).toBe(id);
      }
    });
  });

  it("a failed Slack send given the old id stores the plain one, in its todoId and its subject", async () => {
    const { t } = await setup();
    // A todo from before step C: the plain row, carrying its old id.
    const { old: legacy, plain: id } = await t.run(async (ctx) =>
      await insertCopied(ctx, "todos", { statement: "the old todo", readiness: "unprepared", status: "active", timingClass: "whenever", source: "test", createdAt: 1, updatedAt: 1 }),
    );
    await t.mutation(internal.ttsSlack.internalRecordSlackFailed, { channel: "C-today", subject: { kind: "todo", id: legacy }, error: "rate limited" });
    const [row] = await t.run(async (ctx) => (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === "slack-send-failed"));
    expect(row.todoId).toBe(id);
    expect((row.data as { subject: { id: string } }).subject.id).toBe(id);
  });

  it("internalSyncCanvasTodos (its insert and its moved due date)", async () => {
    const t = convexTest({ schema, modules });
    const dueAt = Date.now() + 4 * DAY_MS;
    const assignment = { externalId: "77", courseCode: "CS 101", name: "Lab 3", htmlUrl: "https://canvas.example/77", dueAt, submitted: false };
    await t.mutation(internal.ttsCanvas.internalSyncCanvasTodos, { assignments: [assignment] });
    const [row] = await t.run((ctx) => ctx.db.query("todos").collect());
    expect(await plainOf(t, "todos", row._id)).toMatchObject({ statement: "CS 101: Lab 3", dueAt });
    await t.mutation(internal.ttsCanvas.internalSyncCanvasTodos, { assignments: [{ ...assignment, dueAt: dueAt + DAY_MS }] });
    expect(await plainOf(t, "todos", row._id)).toMatchObject({ dueAt: dueAt + DAY_MS });
  });

  it("internalGenerateRepeats", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await tom.mutation(api.ttsRepeats.createRepeat, { statement: "stretch", daysOfWeek: ["monday"], timeOfDay: "18:30" });
    expect(await t.mutation(internal.ttsRepeats.internalGenerateRepeats, { day: "2026-09-07" })).toEqual({ day: "2026-09-07", created: 1 });
    const [row] = await t.run((ctx) => ctx.db.query("todos").collect());
    expect(await plainOf(t, "todos", row._id)).toMatchObject({ statement: "stretch", source: "repeating" });
  });
});
