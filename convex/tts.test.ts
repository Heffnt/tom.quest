import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  countdownText,
  ttsDayBoundsUtc,
  ttsDayKey,
  ttsPrepDay,
  nyLocalHour,
  nyOffsetHours,
} from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

describe("ttsShared time helpers", () => {
  it("computes the New York offset across DST", () => {
    expect(nyOffsetHours(Date.UTC(2026, 7, 27, 12))).toBe(-4); // late August: EDT
    expect(nyOffsetHours(Date.UTC(2026, 0, 15, 12))).toBe(-5); // January: EST
    // 2026 transitions: spring forward Mar 8 (07:00 UTC), fall back Nov 1 (06:00 UTC).
    expect(nyOffsetHours(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5);
    expect(nyOffsetHours(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4);
    expect(nyOffsetHours(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4);
    expect(nyOffsetHours(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5);
  });

  it("rolls the TTS day over at 5 a.m. local, not midnight", () => {
    // 2026-08-27 08:59 UTC = 04:59 EDT -> still the 26th's TTS day.
    expect(ttsDayKey(Date.UTC(2026, 7, 27, 8, 59))).toBe("2026-08-26");
    // 09:00 UTC = 05:00 EDT -> the 27th begins.
    expect(ttsDayKey(Date.UTC(2026, 7, 27, 9, 0))).toBe("2026-08-27");
    expect(nyLocalHour(Date.UTC(2026, 7, 27, 9, 0))).toBe(5);
  });

  it("prep and digest land on the SAME day key (the review-caught bug)", () => {
    // Prep runs in the 4 a.m. hour, BEFORE the boundary; the digest at 5.
    // ttsPrepDay must bridge them — ttsDayKey alone named yesterday at 4:45.
    const prepEdt = Date.UTC(2026, 7, 27, 8, 45); // 4:45 EDT
    const digestEdt = Date.UTC(2026, 7, 27, 9, 0); // 5:00 EDT
    expect(ttsPrepDay(prepEdt)).toBe(ttsDayKey(digestEdt));
    const prepEst = Date.UTC(2026, 0, 15, 9, 45); // 4:45 EST
    const digestEst = Date.UTC(2026, 0, 15, 10, 0); // 5:00 EST
    expect(ttsPrepDay(prepEst)).toBe(ttsDayKey(digestEst));
    // A midday --force re-prep rebuilds TODAY's queue, not tomorrow's.
    const noon = Date.UTC(2026, 7, 27, 16);
    expect(ttsPrepDay(noon)).toBe(ttsDayKey(noon));
  });

  it("computes DST-correct day bounds (5 a.m. to 5 a.m. NY)", () => {
    const edt = ttsDayBoundsUtc("2026-08-27");
    expect(edt.start).toBe(Date.UTC(2026, 7, 27, 9)); // 5:00 EDT
    expect(edt.end).toBe(Date.UTC(2026, 7, 28, 9));
    const est = ttsDayBoundsUtc("2026-01-15");
    expect(est.start).toBe(Date.UTC(2026, 0, 15, 10)); // 5:00 EST
    expect(est.end).toBe(Date.UTC(2026, 0, 16, 10));
    // Fall-back day: starts in EDT, ends in EST — 25 wall-clock hours.
    const fall = ttsDayBoundsUtc("2026-10-31");
    expect(fall.end - fall.start).toBe(25 * 3_600_000);
  });

  it("renders countdown text", () => {
    const now = Date.UTC(2026, 7, 27, 15);
    expect(countdownText(now, now)).toBe("today");
    expect(countdownText(now + 86_400_000, now)).toBe("tomorrow");
    expect(countdownText(now + 3 * 86_400_000, now)).toBe("in 3 days");
    expect(countdownText(now - 2 * 86_400_000, now)).toBe("2 days overdue");
    // Calendar semantics: an item due at 2 a.m. NY on the 28th is due on the
    // 28th — the 5 a.m. TTS shift must not report it a day early (review).
    expect(countdownText(Date.UTC(2026, 7, 28, 6), now)).toBe("tomorrow");
  });
});

describe("TTS todos", () => {
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(
      t.mutation(api.tts.createTodo, { statement: "x" }),
    ).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(
      user.mutation(api.tts.createTodo, { statement: "x" }),
    ).rejects.toThrow();
    await expect(user.query(api.tts.listTodos, {})).rejects.toThrow();
  });

  it("creates, lists, and instruments a todo", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "  email Ana Maria  ",
      dueAt: Date.now() + 86_400_000,
    });
    const todos = await tom.query(api.tts.listTodos, {});
    expect(todos).toHaveLength(1);
    expect(todos[0].statement).toBe("email Ana Maria");
    expect(todos[0].timingClass).toBe("dated"); // dueAt implies dated
    expect(todos[0].dateKind).toBe("self-imposed");
    expect(todos[0].readiness).toBe("unprepared");
    expect(todos[0].status).toBe("active");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "created" && e.todoId === id)).toBe(true);
  });

  it("promotes whenever to dated when a date is set (spec §5.2)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "clean room" });
    await tom.mutation(api.tts.updateTodo, { id, dueAt: Date.now() + 86_400_000 });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateKind).toBe("self-imposed");
  });

  it("enforces the kept-dates rule (spec §8)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const future = Date.now() + 5 * 86_400_000;
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "reserve UH 400",
      dueAt: future,
    });
    // Renegotiation before the date: legal, recorded, date moves.
    await tom.mutation(api.tts.recordDateOutcome, {
      id,
      outcome: "renegotiated",
      newDueAt: future + 86_400_000,
    });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBe(future + 86_400_000);
    expect(todo.dateOutcomes).toHaveLength(1);
    expect(todo.dateOutcomes?.[0].outcome).toBe("renegotiated");

    // A missed date without a new one drops the item back to whenever, miss on record.
    await tom.mutation(api.tts.recordDateOutcome, { id, outcome: "missed" });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBeUndefined();
    expect(todo.timingClass).toBe("whenever");
    expect(todo.dateOutcomes?.map((o) => o.outcome)).toEqual([
      "renegotiated",
      "missed",
    ]);

    // Renegotiating a past-due date is refused (record missed instead).
    const pastDue = await tom.mutation(api.tts.createTodo, {
      statement: "late thing",
      dueAt: Date.now() - 1000,
    });
    await expect(
      tom.mutation(api.tts.recordDateOutcome, {
        id: pastDue,
        outcome: "renegotiated",
        newDueAt: Date.now() + 86_400_000,
      }),
    ).rejects.toThrow(/before the date/);
  });

  it("resolves an open date as kept when the item is marked done", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "submit form",
      dueAt: Date.now() + 86_400_000,
    });
    await tom.mutation(api.tts.setStatus, { id, status: "done" });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("done");
    expect(todo.doneAt).toBeDefined();
    expect(todo.dateOutcomes?.[0].outcome).toBe("done");
  });

  it("refuses to clear a date silently and clears terminal facts on reopen", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "dated thing",
      dueAt: Date.now() + 86_400_000,
    });
    // The silent slide is forbidden (spec §8): dueAt:null is refused.
    await expect(
      tom.mutation(api.tts.updateTodo, { id, dueAt: null }),
    ).rejects.toThrow(/never cleared silently/);

    // Archive with an unarchive condition, then reactivate: the stale
    // terminal facts must not linger on the live item.
    await tom.mutation(api.tts.setStatus, {
      id,
      status: "archived",
      unarchiveCondition: "when Ana replies",
    });
    await tom.mutation(api.tts.setStatus, { id, status: "active" });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("active");
    expect(todo.archivedAt).toBeUndefined();
    expect(todo.unarchiveCondition).toBeUndefined();
  });

  it("worker prep intake drops non-active items and enforces the queue cap", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const ids = [];
    for (let i = 0; i < 9; i++) {
      ids.push(await tom.mutation(api.tts.createTodo, { statement: `t${i}` }));
    }
    const sleeping = ids[0];
    await tom.mutation(api.tts.setStatus, { id: sleeping, status: "waiting" });
    await t.mutation(internal.tts.internalStoreWorkerPrep, {
      day: "2026-08-27",
      todoIds: ids,
      digestText: "x",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("dtsDailyQueues").collect(),
    );
    // 9 sent - 1 waiting = 8 eligible, capped at 7.
    expect(rows[0].entries).toHaveLength(7);
    expect(rows[0].entries.some((e) => e.todoId === sleeping)).toBe(false);
    // A malformed id is rejected by name.
    await expect(
      t.mutation(internal.tts.internalStoreWorkerPrep, {
        day: "2026-08-27",
        todoIds: ["not-a-real-id"],
      }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  it("captures worker submissions as unprepared items", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.tts.internalCapture, {
      statement: "buy climbing tape",
      source: "slack-capture",
      provenance: "slack:#dump",
    });
    const todos = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todos).toHaveLength(1);
    expect(todos[0].readiness).toBe("unprepared");
    expect(todos[0].source).toBe("slack-capture");
  });

  // witness: make internalPrepareTodo patch `statement` too, and the
  // preserved-statement assertion below goes red.
  it("preparer attaches fields and advances readiness without touching intent", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.tts.internalCapture, {
      statement: "buy climbing tape",
      source: "slack-capture",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      brief: "Tape for finger protection.",
      entryAction: "Open the retailer page",
      workDescription: "a two-minute errand",
      readiness: "ready-for-tom",
    });
    const [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.readiness).toBe("ready-for-tom");
    expect(todo.entryAction).toBe("Open the retailer page");
    expect(todo.statement).toBe("buy climbing tape"); // intent untouched
    await expect(
      t.mutation(internal.tts.internalPrepareTodo, { id: "bogus" }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  // witness: drop the already-dated throw in internalTriage and the
  // rejects assertion below goes red.
  it("internalTriage applies status + self-imposed dates with kept-dates intact", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.tts.internalCapture, {
      statement: "reserve UH 400",
      source: "consolidation",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    const due = Date.now() + 3 * 86_400_000;
    await t.mutation(internal.tts.internalTriage, { id: captured._id, dueAt: due });
    let [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateKind).toBe("self-imposed");
    // A second date via triage is refused — dates move via recordDateOutcome.
    await expect(
      t.mutation(internal.tts.internalTriage, { id: captured._id, dueAt: due + 1 }),
    ).rejects.toThrow(/kept-dates/);
    await t.mutation(internal.tts.internalTriage, {
      id: captured._id,
      status: "waiting",
      wakeAt: due,
      wakeCondition: "closer to the date",
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.status).toBe("waiting");
    expect(todo.wakeCondition).toBe("closer to the date");
  });

  it("builds the fallback queue and wakes due waiting items", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const now = Date.now();
    const overdue = await tom.mutation(api.tts.createTodo, {
      statement: "overdue thing",
      dueAt: now - 86_400_000,
    });
    await tom.mutation(api.tts.createTodo, { statement: "someday thing" });
    const sleeping = await tom.mutation(api.tts.createTodo, {
      statement: "wake me",
    });
    await tom.mutation(api.tts.setStatus, {
      id: sleeping,
      status: "waiting",
      wakeAt: now - 1000,
    });

    await t.mutation(internal.tts.internalPrepareFallbackQueue, { force: true });

    const todos = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    const woken = todos.find((x) => x._id === sleeping);
    expect(woken?.status).toBe("active");

    const queue = await t.run(async (ctx) =>
      ctx.db.query("dtsDailyQueues").collect(),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0].preparedBy).toBe("fallback");
    const first = queue[0].entries[0];
    expect(first.todoId).toBe(overdue);
    expect(first.reason).toBe("overdue");
    expect(
      queue[0].entries.some((e) => e.reason === "invitation"),
    ).toBe(true);
  });

  it("worker prep overwrites the fallback queue for the same day", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "a task" });
    await t.mutation(internal.tts.internalPrepareFallbackQueue, { force: true });
    const day = (
      await t.run(async (ctx) => ctx.db.query("dtsDailyQueues").collect())
    )[0].day;
    await t.mutation(internal.tts.internalStoreWorkerPrep, {
      day,
      todoIds: [id],
      digestText: "*prepared by worker*",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("dtsDailyQueues").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].preparedBy).toBe("worker");
    expect(rows[0].digestText).toBe("*prepared by worker*");
  });

  it("mirror replace upserts and drops vanished rows", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        { externalId: "a", tier: "R", status: "open", statement: "s1", url: "u" },
        { externalId: "b", tier: "H", status: "open", statement: "s2", url: "u" },
      ],
    });
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        { externalId: "a", tier: "R", status: "closed", statement: "s1", url: "u" },
      ],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("dtsCodeTodoMirror").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("a");
    expect(rows[0].status).toBe("closed");
  });
});

describe("TTS blocks and category", () => {
  const HOUR = 3_600_000;

  // witness: remove the requireTomId call from listBlocks in convex/tts.ts
  it("gates listBlocks on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.tts.listBlocks, {})).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.tts.listBlocks, {})).rejects.toThrow();
  });

  // witness: drop the requireOneBlockTarget call (or the end<=start throw)
  // from createBlock in convex/tts.ts
  it("createBlock targets exactly one thing and validates the span", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "block me" });
    const start = Date.now();
    // Zero targets.
    await expect(
      tom.mutation(api.tts.createBlock, { start, end: start + HOUR }),
    ).rejects.toThrow(/exactly one/);
    // Two targets.
    await expect(
      tom.mutation(api.tts.createBlock, {
        start,
        end: start + HOUR,
        todoId,
        category: "chores",
      }),
    ).rejects.toThrow(/exactly one/);
    // Zero-length and inverted spans.
    await expect(
      tom.mutation(api.tts.createBlock, { start, end: start, category: "chores" }),
    ).rejects.toThrow(/ends after/);
    await expect(
      tom.mutation(api.tts.createBlock, {
        start,
        end: start - HOUR,
        category: "chores",
      }),
    ).rejects.toThrow(/ends after/);
  });

  // witness: drop the ctx.db.get existence check from createBlock's todoId
  // branch in convex/tts.ts
  it("createBlock validates the todo target exists", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "gone" });
    await t.run(async (ctx) => ctx.db.delete(todoId));
    const start = Date.now();
    await expect(
      tom.mutation(api.tts.createBlock, { start, end: start + HOUR, todoId }),
    ).rejects.toThrow(/not found/);
  });

  it("creates, lists, and instruments blocks for both target kinds", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "a task" });
    const start = Date.now();
    const todoBlock = await tom.mutation(api.tts.createBlock, {
      start,
      end: start + 2 * HOUR,
      todoId,
      note: "Tue 9-11",
    });
    const categoryBlock = await tom.mutation(api.tts.createBlock, {
      start: start + 24 * HOUR,
      end: start + 26 * HOUR,
      category: "chores",
    });
    const blocks = await tom.query(api.tts.listBlocks, {});
    expect(blocks).toHaveLength(2);
    const perTodo = blocks.find((b) => b._id === todoBlock);
    expect(perTodo?.todoId).toBe(todoId);
    expect(perTodo?.category).toBeUndefined();
    expect(perTodo?.note).toBe("Tue 9-11");
    const perCategory = blocks.find((b) => b._id === categoryBlock);
    expect(perCategory?.category).toBe("chores");
    expect(perCategory?.todoId).toBeUndefined();
    const events = await tom.query(api.tts.listRecentEvents, {});
    const created = events.filter((e) => e.kind === "block-created");
    expect(created).toHaveLength(2);
    expect(created.some((e) => e.todoId === todoId)).toBe(true);
  });

  // witness: drop the recomputed-span throw from updateBlock in convex/tts.ts
  it("updateBlock moves the span, validates it, and logs the move", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const start = Date.now();
    const id = await tom.mutation(api.tts.createBlock, {
      start,
      end: start + HOUR,
      category: "chores",
      note: "keep me",
    });
    await tom.mutation(api.tts.updateBlock, {
      id,
      start: start + 24 * HOUR,
      end: start + 25 * HOUR,
    });
    let [block] = await tom.query(api.tts.listBlocks, {});
    expect(block.start).toBe(start + 24 * HOUR);
    expect(block.end).toBe(start + 25 * HOUR);
    expect(block.note).toBe("keep me"); // omitted field untouched
    // A partial edit that would invert the span is refused.
    await expect(
      tom.mutation(api.tts.updateBlock, { id, end: start }),
    ).rejects.toThrow(/ends after/);
    // note: null clears it.
    await tom.mutation(api.tts.updateBlock, { id, note: null });
    [block] = await tom.query(api.tts.listBlocks, {});
    expect(block.note).toBeUndefined();
    const events = await tom.query(api.tts.listRecentEvents, {});
    const moved = events.find((e) => e.kind === "block-moved");
    expect(moved?.data).toMatchObject({
      from: { start, end: start + HOUR },
      to: { start: start + 24 * HOUR, end: start + 25 * HOUR },
    });
  });

  // witness: drop the logEvent call from deleteBlock in convex/tts.ts
  it("deleteBlock removes the row and logs an event", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "a task" });
    const start = Date.now();
    const id = await tom.mutation(api.tts.createBlock, {
      start,
      end: start + HOUR,
      todoId,
    });
    await tom.mutation(api.tts.deleteBlock, { id });
    expect(await tom.query(api.tts.listBlocks, {})).toHaveLength(0);
    const events = await tom.query(api.tts.listRecentEvents, {});
    const deleted = events.find((e) => e.kind === "block-deleted");
    expect(deleted?.todoId).toBe(todoId);
    expect(deleted?.data).toMatchObject({ start, end: start + HOUR });
  });

  it("createTodo/updateTodo round-trip category, null clears", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "sweep the floor",
      category: "chores",
    });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.category).toBe("chores");
    await tom.mutation(api.tts.updateTodo, { id, category: "errands" });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.category).toBe("errands");
    await tom.mutation(api.tts.updateTodo, { id, category: null });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.category).toBeUndefined();
  });
});

describe("TTS batches and annotations", () => {
  // Real-clock tick: guarantees Date.now() advances between two mutations, so
  // "does not bump updatedAt" assertions cannot pass by same-millisecond luck.
  const tick = () => new Promise((r) => setTimeout(r, 5));

  const cmt = (externalId: string) => ({
    repo: "ComplexMultiTrigger",
    externalId,
  });

  const step = (text: string) => ({
    text,
    actor: "agent" as const,
    status: "open" as const,
  });

  const storeBatch = (
    t: ReturnType<typeof convexTest>,
    over: Partial<{
      id: string;
      statement: string;
      brief: string;
      members: { todoId?: Id<"dtsTodos">; repo?: string; externalId?: string }[];
      plan: { text: string; actor: "tom" | "agent"; status: "open" | "done" }[];
      importanceLevel: "low" | "medium" | "high";
      importanceRationale: string;
    }> = {},
  ) =>
    t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          statement: "grouped work",
          brief: "why these belong together",
          members: [cmt("cmt-001")],
          ...over,
        },
      ],
    });

  const findBatch = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).find(
        (x) => x.members !== undefined,
      ),
    );

  it("internalStoreBatches creates a batch with agent-set importance", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const a = await tom.mutation(api.tts.createTodo, { statement: "book flights" });
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          statement: "  trip logistics  ",
          brief: "one errand, three tickets",
          members: [{ todoId: a }, cmt("cmt-001")],
          importanceLevel: "medium",
          importanceRationale: "travel dates approach",
        },
      ],
    });
    expect(res).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      archived: 0,
      skipped: [],
    });
    const batch = await findBatch(t);
    expect(batch?.statement).toBe("trip logistics");
    expect(batch?.source).toBe("batcher");
    expect(batch?.readiness).toBe("ready-for-tom");
    expect(batch?.status).toBe("active");
    expect(batch?.timingClass).toBe("whenever");
    expect(batch?.members).toHaveLength(2);
    expect(batch?.importance).toMatchObject({ level: "medium", setBy: "agent" });
    expect(batch?.tomTouchedAt).toBeUndefined(); // agent write, never a Tom touch
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(
      events.some((e) => e.kind === "batch-formed" && e.todoId === batch?._id),
    ).toBe(true);
  });

  it("rewrites its own untouched batch in place", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "v1" });
    const batch = await findBatch(t);
    const res = await storeBatch(t, {
      id: batch!._id,
      statement: "v2",
      brief: "regrouped",
      members: [cmt("cmt-002")],
      importanceLevel: "high",
    });
    expect(res).toMatchObject({ created: 0, updated: 1, skipped: [] });
    const fresh = await findBatch(t);
    expect(fresh?._id).toBe(batch?._id);
    expect(fresh?.statement).toBe("v2");
    expect(fresh?.members?.[0].externalId).toBe("cmt-002");
    expect(fresh?.importance).toMatchObject({ level: "high", setBy: "agent" });
  });

  // witness: drop the occupied-member check from internalStoreBatches in
  // convex/tts.ts — one subject would ride two live batches.
  it("skips a batch whose member is already held by another live batch", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "holder" });
    const res = await storeBatch(t, { statement: "poacher" });
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.skipped).toEqual([
      {
        ref: "poacher",
        why: 'code ComplexMultiTrigger cmt-001 is already in batch "holder"',
      },
    ]);
  });

  // witness: re-add a "rewriting" exclusion to the occupied map in
  // internalStoreBatches (skip members of rows this call is about to rewrite)
  // — the new batch would claim cmt-001 in the same run, and if the rewrite
  // then skipped, the subject would sit in two live batches.
  it("moving a member between batches takes two runs (occupied map is owner-tagged)", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "holder", members: [cmt("cmt-001")] });
    const holder = await findBatch(t);
    // One call: holder gives cmt-001 up AND a new batch tries to take it.
    const first = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          id: holder!._id,
          statement: "holder",
          brief: "why these belong together",
          members: [cmt("cmt-002")],
        },
        {
          statement: "taker",
          brief: "the new home",
          members: [cmt("cmt-001")],
        },
      ],
    });
    // The rewrite lands; the claim waits for the next run.
    expect(first).toMatchObject({ created: 0, updated: 1 });
    expect(first.skipped).toEqual([
      {
        ref: "taker",
        why: 'code ComplexMultiTrigger cmt-001 is already in batch "holder"',
      },
    ]);
    // Run two: cmt-001 is free now, so the same batch is created.
    const second = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        { statement: "taker", brief: "the new home", members: [cmt("cmt-001")] },
      ],
    });
    expect(second).toMatchObject({ created: 1, skipped: [] });
    const batches = await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).filter(
        (x) => x.members !== undefined,
      ),
    );
    expect(batches).toHaveLength(2);
    expect(
      batches.flatMap((b) => b.members!.map((m) => m.externalId)).sort(),
    ).toEqual(["cmt-001", "cmt-002"]);
  });

  // witness: same — with the rewriting exclusion, this frozen-rewrite call
  // leaves cmt-001 in BOTH "frozen holder" and "taker".
  it("a SKIPPED rewrite still holds its members (no double membership)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeBatch(t, { statement: "frozen holder" });
    const holder = await findBatch(t);
    await tom.mutation(api.tts.setImportance, { id: holder!._id, level: "high" });
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          id: holder!._id,
          statement: "frozen holder",
          brief: "x",
          members: [cmt("cmt-002")],
        },
        { statement: "taker", brief: "y", members: [cmt("cmt-001")] },
      ],
    });
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.skipped.map((s) => s.why)).toEqual([
      "Tom-touched (frozen)",
      'code ComplexMultiTrigger cmt-001 is already in batch "frozen holder"',
    ]);
    const batches = await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).filter(
        (x) => x.members !== undefined,
      ),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].members?.[0].externalId).toBe("cmt-001");
  });

  // witness: drop the `owner.id !== normalized` clause from the conflict check
  // in internalStoreBatches — a batch could never keep the members it holds.
  it("a rewrite keeps its own members (it does not collide with itself)", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "v1", members: [cmt("cmt-001")] });
    const batch = await findBatch(t);
    const res = await storeBatch(t, {
      id: batch!._id,
      statement: "v2",
      members: [cmt("cmt-001"), cmt("cmt-002")],
    });
    expect(res).toMatchObject({ created: 0, updated: 1, skipped: [] });
    const fresh = await findBatch(t);
    expect(
      fresh?.members?.map((m: { externalId?: string }) => m.externalId),
    ).toEqual(["cmt-001", "cmt-002"]);
  });

  // witness: drop the members check from validateBatchMembers in convex/tts.ts
  it("refuses batch-in-batch (skipped, not stored)", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "outer" });
    const outer = await findBatch(t);
    const res = await storeBatch(t, {
      statement: "nest",
      members: [{ todoId: outer!._id }],
    });
    expect(res).toMatchObject({ created: 0, updated: 0 });
    expect(res.skipped[0].why).toMatch(/no batch-in-batch/);
  });

  // witness: drop the tomTouchedAt clause from notWritable in
  // internalStoreBatches — the batcher would clobber a batch Tom touched.
  it("a Tom-touched batch is FROZEN: neither rewritten nor archived", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeBatch(t, { statement: "ruled on" });
    const batch = await findBatch(t);
    await tom.mutation(api.tts.setImportance, { id: batch!._id, level: "high" });
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          id: batch!._id,
          statement: "rewrite attempt",
          brief: "x",
          members: [cmt("cmt-100")],
        },
      ],
      archiveIds: [batch!._id],
    });
    expect(res).toMatchObject({ created: 0, updated: 0, archived: 0 });
    expect(res.skipped.map((s) => s.why)).toEqual([
      "Tom-touched (frozen)",
      "Tom-touched (frozen)",
    ]);
    const fresh = await findBatch(t);
    expect(fresh?.statement).toBe("ruled on");
    expect(fresh?.status).toBe("active");
  });

  it("archiveIds retires an unfrozen batcher batch without a Tom stamp", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t);
    const batch = await findBatch(t);
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [],
      archiveIds: [batch!._id],
    });
    expect(res).toMatchObject({ created: 0, updated: 0, archived: 1 });
    const fresh = await findBatch(t);
    expect(fresh?.status).toBe("archived");
    expect(fresh?.archivedAt).toBeDefined();
    expect(fresh?.tomTouchedAt).toBeUndefined(); // agent action, not a Tom touch
  });

  // witness: drop the setBy-"tom" guard from internalStoreBatches's update
  // branch in convex/tts.ts. Importance is seeded directly here: every Tom
  // door also stamps tomTouchedAt (which freezes the row first), so this
  // guard is the second fence — it must hold on its own.
  it("a batcher rewrite keeps importance Tom set (agent write ignored, logged)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeBatch(t, { importanceLevel: "low" });
    const batch = await findBatch(t);
    await t.run(async (ctx) =>
      ctx.db.patch(batch!._id, {
        importance: { level: "high", setBy: "tom", setAt: Date.now() },
      }),
    );
    const res = await storeBatch(t, {
      id: batch!._id,
      statement: "regrouped anyway",
      importanceLevel: "low",
    });
    expect(res).toMatchObject({ created: 0, updated: 1 });
    const fresh = await findBatch(t);
    expect(fresh?.statement).toBe("regrouped anyway"); // content rewrite landed
    expect(fresh?.importance).toMatchObject({ level: "high", setBy: "tom" });
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(
      events.some(
        (e) => e.kind === "importance-skipped" && e.todoId === batch?._id,
      ),
    ).toBe(true);
  });

  // witness: in internalStoreBatches's rewrite branch, replace
  // `plan: b.plan ?? todo.plan` with `plan: b.plan` (and drop the
  // `let importance = todo.importance` seed) — an LLM omission would DELETE
  // the stored plan and importance.
  it("an absent plan/importance in a rewrite PRESERVES the stored values", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, {
      statement: "v1",
      plan: [step("draft it")],
      importanceLevel: "medium",
      importanceRationale: "travel dates approach",
    });
    const batch = await findBatch(t);
    expect(batch?.plan).toHaveLength(1);
    const res = await storeBatch(t, { id: batch!._id, statement: "v2" });
    expect(res).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    const fresh = await findBatch(t);
    expect(fresh?.statement).toBe("v2");
    expect(fresh?.plan?.[0].text).toBe("draft it");
    expect(fresh?.importance).toMatchObject({
      level: "medium",
      setBy: "agent",
      rationale: "travel dates approach",
      setAt: batch?.importance?.setAt,
    });
  });

  // witness: drop the JSON.stringify projected-vs-stored comparison from
  // internalStoreBatches — the 6-hourly re-post would bump updatedAt on every
  // batch and re-push every open client.
  it("an identical re-post is counted unchanged and does not bump updatedAt", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, {
      statement: "grouped work",
      plan: [step("draft it")],
      importanceLevel: "medium",
    });
    const batch = await findBatch(t);
    await tick();
    const res = await storeBatch(t, {
      id: batch!._id,
      statement: "grouped work",
      plan: [step("draft it")],
      importanceLevel: "medium",
    });
    expect(res).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
      skipped: [],
    });
    const fresh = await findBatch(t);
    expect(fresh?.updatedAt).toBe(batch?.updatedAt);
    expect(fresh?.importance?.setAt).toBe(batch?.importance?.setAt);
    // A re-post that DOES change something still lands as an update.
    await tick();
    const changed = await storeBatch(t, {
      id: batch!._id,
      statement: "grouped work",
      brief: "regrouped",
      plan: [step("draft it")],
      importanceLevel: "medium",
    });
    expect(changed).toMatchObject({ updated: 1, unchanged: 0 });
    expect((await findBatch(t))?.updatedAt).toBeGreaterThan(batch!.updatedAt);
  });

  // The unchanged check compares JSON.stringify(projected) against
  // JSON.stringify(stored), so it would be key-order sensitive if Convex kept
  // author key order. It does not — object fields come back sorted, on both
  // sides of the comparison — so the same members written {repo, externalId}
  // and re-posted {externalId, repo} are still one no-op.
  it("the unchanged check does not depend on member key order", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          statement: "grouped work",
          brief: "why these belong together",
          members: [{ repo: "ComplexMultiTrigger", externalId: "cmt-001" }],
        },
      ],
    });
    const batch = await findBatch(t);
    await tick();
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          id: batch!._id,
          statement: "grouped work",
          brief: "why these belong together",
          members: [{ externalId: "cmt-001", repo: "ComplexMultiTrigger" }],
        },
      ],
    });
    expect(res).toMatchObject({ updated: 0, unchanged: 1, skipped: [] });
    expect((await findBatch(t))?.updatedAt).toBe(batch?.updatedAt);
  });

  // witness: move the archive loop in internalStoreBatches BELOW the occupied
  // map's collect — the retired batch would still hold cmt-001 and the regroup
  // would be skipped, so a regroup could never land in one call.
  it("archives free their members before the occupied map is built", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "old grouping" });
    const old = await findBatch(t);
    const res = await t.mutation(internal.tts.internalStoreBatches, {
      batches: [
        {
          statement: "new grouping",
          brief: "regrouped per the batcher",
          members: [cmt("cmt-001")],
        },
      ],
      archiveIds: [old!._id],
    });
    expect(res).toMatchObject({ created: 1, archived: 1, skipped: [] });
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("dtsTodos").collect()).filter(
        (x) => x.members !== undefined,
      ),
    );
    // Nothing is deleted: the old grouping stays, archived, holding its
    // members as history; only the live batch claims the subject.
    expect(rows).toHaveLength(2);
    const live = rows.filter((r) => r.status === "active");
    expect(live).toHaveLength(1);
    expect(live[0].statement).toBe("new grouping");
  });

  // witness: drop the MAX_BATCH_MEMBERS / length-0 throws from
  // validateBatchMembers in convex/tts.ts (Convex bounded-array guideline).
  it("a batch holds 1..20 members", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const empty = await storeBatch(t, { statement: "empty", members: [] });
    expect(empty).toMatchObject({ created: 0 });
    expect(empty.skipped[0].why).toMatch(/at least one member/);
    const many = Array.from({ length: 21 }, (_, i) =>
      cmt(`cmt-${String(i).padStart(3, "0")}`),
    );
    const over = await storeBatch(t, { statement: "over", members: many });
    expect(over).toMatchObject({ created: 0 });
    expect(over.skipped[0].why).toMatch(/at most 20 members — got 21/);
    // Exactly 20 is fine.
    const ok = await storeBatch(t, {
      statement: "at the cap",
      members: many.slice(0, 20),
    });
    expect(ok).toMatchObject({ created: 1, skipped: [] });
    // The Tom-facing door enforces the same cap.
    const id = await tom.mutation(api.tts.createTodo, { statement: "batchy" });
    await expect(
      tom.mutation(api.tts.updateTodo, { id, members: [] }),
    ).rejects.toThrow(/at least one member/);
    await expect(
      tom.mutation(api.tts.updateTodo, { id, members: many }),
    ).rejects.toThrow(/at most 20 members/);
  });

  // witness: drop the MAX_PLAN_STEPS throws/skip from updateTodo,
  // internalPrepareTodo, and internalStoreBatches in convex/tts.ts.
  it("a plan holds at most 40 steps, at every door", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const long = Array.from({ length: 41 }, (_, i) => step(`s${i}`));
    const id = await tom.mutation(api.tts.createTodo, { statement: "planned" });
    await expect(
      tom.mutation(api.tts.updateTodo, { id, plan: long }),
    ).rejects.toThrow(/at most 40 steps — got 41/);
    await expect(
      t.mutation(internal.tts.internalPrepareTodo, { id, plan: long }),
    ).rejects.toThrow(/at most 40 steps — got 41/);
    // The batcher drops the batch instead of failing the run.
    const res = await storeBatch(t, { statement: "long plan", plan: long });
    expect(res).toMatchObject({ created: 0 });
    expect(res.skipped[0].why).toMatch(/at most 40 steps — got 41/);
    // Exactly 40 lands.
    await tom.mutation(api.tts.updateTodo, { id, plan: long.slice(0, 40) });
    const todos = await tom.query(api.tts.listTodos, {});
    expect(todos.find((x) => x._id === id)?.plan).toHaveLength(40);
  });

  // witness: drop the `todo.members !== undefined` branch from
  // internalPrepareTodo in convex/tts.ts — the single-todo preparer would
  // rewrite the batcher's grouping brief.
  it("preparing a BATCH lands only the plan; the rest is skipped and named", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeBatch(t, { importanceLevel: "medium" });
    const batch = await findBatch(t);
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: batch!._id,
      brief: "a preparer's brief",
      entryAction: "open the first one",
      workDescription: "an afternoon",
      readiness: "preparing",
      importanceLevel: "low",
      plan: [step("do the first member")],
    });
    const fresh = await findBatch(t);
    expect(fresh?.brief).toBe("why these belong together"); // the batcher's
    expect(fresh?.entryAction).toBeUndefined();
    expect(fresh?.workDescription).toBeUndefined();
    expect(fresh?.readiness).toBe("ready-for-tom"); // untouched
    expect(fresh?.importance).toMatchObject({ level: "medium" });
    expect(fresh?.plan).toHaveLength(1); // the plan is the one field that lands
    const events = await tom.query(api.tts.listRecentEvents, {});
    const skipped = events.find((e) => e.kind === "prepare-skipped-batch");
    expect(skipped?.todoId).toBe(batch?._id);
    expect((skipped?.data as { fields: string[] }).fields).toEqual([
      "brief",
      "entryAction",
      "workDescription",
      "readiness",
      "importance",
    ]);
    // The `prepared` event reports what actually landed, not what was sent.
    const prepared = events.find((e) => e.kind === "prepared");
    expect((prepared?.data as { fields: string[] }).fields).toEqual(["plan"]);
    // A plan-only call on a batch skips nothing.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: batch!._id,
      plan: [step("do the first member"), step("then the second")],
    });
    const after = await tom.query(api.tts.listRecentEvents, {});
    expect(after.filter((e) => e.kind === "prepare-skipped-batch")).toHaveLength(1);
  });

  // witness: restore the old blanket "Tom-touched row with a plan → skip" in
  // internalPrepareTodo and this test goes red — the moment Tom wrote one step
  // of his own, the batch's live autonomous session could no longer check its
  // own steps off, which is the whole reason a batch gets a session.
  it("a Tom-touched batch takes agent plan writes that keep Tom's steps", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await storeBatch(t, { plan: [step("gather the sources")] });
    const batch = await findBatch(t);
    const tomStep = {
      text: "tom picks the venue",
      actor: "tom" as const,
      status: "open" as const,
    };
    // Tom adds a step of his own — which also freezes the row to the batcher.
    await tom.mutation(api.tts.updateTodo, {
      id: batch!._id,
      plan: [step("gather the sources"), tomStep],
    });
    expect((await findBatch(t))?.tomTouchedAt).toBeDefined();

    // The session agent checks its own step off and adds another. Tom's step
    // is still there by text, so the whole plan lands.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: batch!._id,
      plan: [
        { ...step("gather the sources"), status: "done" as const, doneAt: 1 },
        tomStep,
        step("draft the summary"),
      ],
    });
    let fresh = await findBatch(t);
    expect(fresh?.plan).toHaveLength(3);
    expect(fresh?.plan?.[0].status).toBe("done");

    // A plan that drops Tom's step is refused WHOLE — never merged in part.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: batch!._id,
      plan: [step("gather the sources")],
    });
    fresh = await findBatch(t);
    expect(fresh?.plan).toHaveLength(3);
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(
      events.some(
        (e) =>
          e.kind === "plan-skipped" &&
          (e.data as { reason?: string; step?: string } | undefined)?.step ===
            "tom picks the venue",
      ),
    ).toBe(true);
  });

  // witness: add updatedAt to setImportance's patch in convex/tts.ts — the
  // annotation would resurface ruled gates via ruledAt<updatedAt.
  it("setImportance writes Tom's level as an annotation (no updatedAt bump)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "x" });
    const [before] = await tom.query(api.tts.listTodos, {});
    await tick();
    await tom.mutation(api.tts.setImportance, { id, level: "high" });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.importance).toMatchObject({ level: "high", setBy: "tom" });
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt);
    await tom.mutation(api.tts.setImportance, { id, level: null });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.importance).toBeUndefined();
  });

  it("setPlanStep checks a step off, reopens it, and rejects a bad index", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "batchish" });
    // Seeded directly: updateTodo would stamp tomTouchedAt itself, hiding
    // whether setPlanStep stamps its own.
    await t.run(async (ctx) =>
      ctx.db.patch(id, {
        plan: [
          { text: "draft it", actor: "agent" as const, status: "open" as const },
          { text: "send it", actor: "tom" as const, status: "open" as const },
        ],
      }),
    );
    const [before] = await tom.query(api.tts.listTodos, {});
    await tick();
    await tom.mutation(api.tts.setPlanStep, { id, index: 1, status: "done" });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.plan?.[1].status).toBe("done");
    expect(todo.plan?.[1].doneAt).toBeDefined();
    expect(todo.plan?.[0].status).toBe("open"); // sibling untouched
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt); // annotation, no bump
    await tom.mutation(api.tts.setPlanStep, { id, index: 1, status: "open" });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.plan?.[1].doneAt).toBeUndefined(); // stale timestamp cleared
    await expect(
      tom.mutation(api.tts.setPlanStep, { id, index: 5, status: "done" }),
    ).rejects.toThrow(/no step 5/);
    const planless = await tom.mutation(api.tts.createTodo, { statement: "y" });
    await expect(
      tom.mutation(api.tts.setPlanStep, { id: planless, index: 0, status: "done" }),
    ).rejects.toThrow(/no plan/);
  });

  it("internalBulkUpdate is Tom's pen: setBy tom, only content bumps updatedAt", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "spoken" });
    const [before] = await tom.query(api.tts.listTodos, {});
    await tick();
    await t.mutation(internal.tts.internalBulkUpdate, {
      updates: [
        { id, importanceLevel: "medium", importanceRationale: "he said so" },
      ],
    });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.importance).toMatchObject({
      level: "medium",
      setBy: "tom", // records Tom's SPOKEN ruling, not an agent estimate
      rationale: "he said so",
    });
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt); // importance-only: no bump
    await tick();
    await t.mutation(internal.tts.internalBulkUpdate, {
      updates: [{ id, category: "chores" }],
    });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.category).toBe("chores");
    expect(todo.updatedAt).toBeGreaterThan(before.updatedAt); // content: bump
    await expect(
      t.mutation(internal.tts.internalBulkUpdate, {
        updates: [{ id: "not-a-real-id", category: "x" }],
      }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  it("preparer importance/plan defer to Tom's overrides", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.tts.internalCapture, {
      statement: "captured",
      source: "slack-capture",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    await tom.mutation(api.tts.setImportance, {
      id: captured._id,
      level: "high",
    });
    const step = { text: "look it up", actor: "agent" as const, status: "open" as const };
    // tomTouchedAt is set but there is no plan yet: the plan writes, the
    // agent importance is ignored (Tom already ruled).
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      importanceLevel: "low",
      importanceRationale: "agent guess",
      plan: [step],
    });
    let [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.importance).toMatchObject({ level: "high", setBy: "tom" });
    expect(todo.plan).toHaveLength(1);
    // Agent steps flow freely even on a Tom-touched row: the plan gate
    // preserves TOM's steps, not the whole plan (the old blanket skip froze
    // live batch sessions the moment Tom touched the row at all).
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      plan: [step, { ...step, text: "second draft" }],
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.plan).toHaveLength(2);
    // Tom writes a step of his own; an incoming plan that DROPS its text is
    // refused whole (Tom's asks never vanish by agent hand)…
    const tomStep = {
      text: "tom decides the venue",
      actor: "tom" as const,
      status: "open" as const,
    };
    await tom.mutation(api.tts.updateTodo, {
      id: captured._id,
      plan: [step, { ...step, text: "second draft" }, tomStep],
    });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      plan: [step], // tom's step vanished
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.plan).toHaveLength(3); // unchanged
    // …while one that keeps his text lands: reordered, checked off, trimmed
    // of agent steps.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      plan: [tomStep, { ...step, status: "done" as const, doneAt: 1 }],
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.plan).toHaveLength(2);
    expect(todo.plan?.[0].actor).toBe("tom");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "importance-skipped")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.kind === "plan-skipped" &&
          (e.data as { reason?: string } | undefined)?.reason ===
            "tom-step dropped",
      ),
    ).toBe(true);
  });

  // witness: drop the one-live-batch collect from updateTodo's members branch
  // in convex/tts.ts
  it("updateTodo members enforce one live batch per subject and stamp the touch", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const a = await tom.mutation(api.tts.createTodo, { statement: "member a" });
    const x = await tom.mutation(api.tts.createTodo, { statement: "batch x" });
    await tom.mutation(api.tts.updateTodo, { id: x, members: [{ todoId: a }] });
    const todos = await tom.query(api.tts.listTodos, {});
    const batch = todos.find((t2) => t2._id === x);
    expect(batch?.members).toHaveLength(1);
    expect(batch?.tomTouchedAt).toBeDefined();
    const y = await tom.mutation(api.tts.createTodo, { statement: "batch y" });
    await expect(
      tom.mutation(api.tts.updateTodo, { id: y, members: [{ todoId: a }] }),
    ).rejects.toThrow(/already in batch "batch x"/);
  });

  // witness: drop the `memberKey(m) === selfKey` throw from updateTodo's
  // members branch in convex/tts.ts — a member could be promoted to a batch
  // while still riding another one (batch-in-batch through the back door).
  it("updateTodo refuses members on a row that is itself in a live batch", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const a = await tom.mutation(api.tts.createTodo, { statement: "member a" });
    const c = await tom.mutation(api.tts.createTodo, { statement: "loose c" });
    const x = await tom.mutation(api.tts.createTodo, { statement: "batch x" });
    await tom.mutation(api.tts.updateTodo, { id: x, members: [{ todoId: a }] });
    await expect(
      tom.mutation(api.tts.updateTodo, { id: a, members: [{ todoId: c }] }),
    ).rejects.toThrow(/"member a" is a member of batch "batch x" — no batch-in-batch/);
    // Once the holding batch is terminal, the promotion is legal again.
    await tom.mutation(api.tts.setStatus, { id: x, status: "archived" });
    await tom.mutation(api.tts.updateTodo, { id: a, members: [{ todoId: c }] });
    const todos = await tom.query(api.tts.listTodos, {});
    expect(todos.find((x2) => x2._id === a)?.members).toHaveLength(1);
  });

  // witness: drop the `status !== undefined || dueAt !== undefined` gate from
  // internalTriage's tomTouchedAt patch in convex/tts.ts — a no-op/retry pen
  // call would freeze a batch against the batcher forever.
  it("a no-op internalTriage call does not stamp tomTouchedAt", async () => {
    const t = convexTest({ schema, modules });
    await storeBatch(t, { statement: "still the batcher's" });
    const batch = await findBatch(t);
    await t.mutation(internal.tts.internalTriage, {
      id: batch!._id,
      note: "looked at it, ruled nothing",
    });
    expect((await findBatch(t))?.tomTouchedAt).toBeUndefined();
    // Still rewritable by the batcher.
    const res = await storeBatch(t, {
      id: batch!._id,
      statement: "regrouped",
    });
    expect(res).toMatchObject({ updated: 1, skipped: [] });
    // A triage that actually rules DOES freeze it.
    await t.mutation(internal.tts.internalTriage, {
      id: batch!._id,
      status: "waiting",
      wakeCondition: "after the trip",
    });
    expect((await findBatch(t))?.tomTouchedAt).toBeDefined();
  });

  // witness: drop the members === undefined filter from
  // internalPrepareFallbackQueue in convex/tts.ts
  it("fallback prep never queues a members-bearing row", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const solo = await tom.mutation(api.tts.createTodo, { statement: "solo" });
    await storeBatch(t);
    const batch = await findBatch(t);
    await t.mutation(internal.tts.internalPrepareFallbackQueue, { force: true });
    const [queue] = await t.run(async (ctx) =>
      ctx.db.query("dtsDailyQueues").collect(),
    );
    expect(queue.entries.some((e) => e.todoId === solo)).toBe(true);
    expect(queue.entries.some((e) => e.todoId === batch?._id)).toBe(false);
  });
});
