import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  countdownText,
  normalDayBoundsUtc,
  normalDayKey,
  tomDayBoundsUtc,
  tomDayKey,
  tomPrepDay,
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
    expect(tomDayKey(Date.UTC(2026, 7, 27, 8, 59))).toBe("2026-08-26");
    // 09:00 UTC = 05:00 EDT -> the 27th begins.
    expect(tomDayKey(Date.UTC(2026, 7, 27, 9, 0))).toBe("2026-08-27");
    expect(nyLocalHour(Date.UTC(2026, 7, 27, 9, 0))).toBe(5);
  });

  it("prep and digest land on the SAME day key (the review-caught bug)", () => {
    // Prep runs in the 4 a.m. hour, BEFORE the boundary; the digest at 5.
    // tomPrepDay must bridge them — tomDayKey alone named yesterday at 4:45.
    const prepEdt = Date.UTC(2026, 7, 27, 8, 45); // 4:45 EDT
    const digestEdt = Date.UTC(2026, 7, 27, 9, 0); // 5:00 EDT
    expect(tomPrepDay(prepEdt)).toBe(tomDayKey(digestEdt));
    const prepEst = Date.UTC(2026, 0, 15, 9, 45); // 4:45 EST
    const digestEst = Date.UTC(2026, 0, 15, 10, 0); // 5:00 EST
    expect(tomPrepDay(prepEst)).toBe(tomDayKey(digestEst));
    // A midday --force re-prep rebuilds TODAY's queue, not tomorrow's.
    const noon = Date.UTC(2026, 7, 27, 16);
    expect(tomPrepDay(noon)).toBe(tomDayKey(noon));
  });

  it("computes DST-correct day bounds (5 a.m. to 5 a.m. NY)", () => {
    const edt = tomDayBoundsUtc("2026-08-27");
    expect(edt.start).toBe(Date.UTC(2026, 7, 27, 9)); // 5:00 EDT
    expect(edt.end).toBe(Date.UTC(2026, 7, 28, 9));
    const est = tomDayBoundsUtc("2026-01-15");
    expect(est.start).toBe(Date.UTC(2026, 0, 15, 10)); // 5:00 EST
    expect(est.end).toBe(Date.UTC(2026, 0, 16, 10));
    // Fall-back day: starts in EDT, ends in EST — 25 wall-clock hours.
    const fall = tomDayBoundsUtc("2026-10-31");
    expect(fall.end - fall.start).toBe(25 * 3_600_000);
  });

  // witness: make normalDayBoundsUtc use the 5 a.m. TTS boundary (or
  // hand-roll start + 86_400_000) — a day-scoped time note written on a
  // calendar column would cover the wrong 24 hours.
  it("computes calendar-day bounds (NY midnight to midnight)", () => {
    const edt = normalDayBoundsUtc("2026-08-27");
    expect(edt.start).toBe(Date.UTC(2026, 7, 27, 4)); // 00:00 EDT
    expect(edt.end).toBe(Date.UTC(2026, 7, 28, 4));
    const est = normalDayBoundsUtc("2026-01-15");
    expect(est.start).toBe(Date.UTC(2026, 0, 15, 5)); // 00:00 EST
    // Every instant inside the window reports that calendar date, and the
    // instant one ms before the start reports the previous one.
    expect(normalDayKey(edt.start)).toBe("2026-08-27");
    expect(normalDayKey(edt.end - 1)).toBe("2026-08-27");
    expect(normalDayKey(edt.start - 1)).toBe("2026-08-26");
    // Fall-back day: 25 wall-clock hours, so a fixed +DAY_MS would truncate it.
    const fall = normalDayBoundsUtc("2026-11-01");
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

  // witness: restore any plan gate in internalPrepareTodo and this test goes
  // red — the moment Tom wrote one step of his own, the batch's live session
  // could no longer check its own steps off, which is the whole reason a
  // batch gets a session.
  it("a Tom-touched batch takes agent plan writes", async () => {
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

    // The session agent checks its own step off, adds another, and rewrites
    // Tom's — the batch branch (members !== undefined) applies the plan just
    // as the plain-row branch does.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: batch!._id,
      plan: [
        { ...step("gather the sources"), status: "done" as const, doneAt: 1 },
        { ...tomStep, text: "tom picks the venue — three candidates now" },
        step("draft the summary"),
      ],
    });
    const fresh = await findBatch(t);
    expect(fresh?.plan).toHaveLength(3);
    expect(fresh?.plan?.[0].status).toBe("done");
    expect(fresh?.plan?.[1].text).toBe("tom picks the venue — three candidates now");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "plan-skipped")).toBe(false);
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

  // witness: drop the setBy-"tom" guard from agentImportancePatch in
  // convex/dts.ts — importance is a RULING, so an agent estimate must never
  // land on top of one Tom spoke. (Plan text is the neighbouring field with
  // the opposite rule; the test below pins that half.)
  it("preparer importance defers to Tom's override", async () => {
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
    const step = {
      text: "look it up",
      actor: "agent" as const,
      status: "open" as const,
    };
    // One call carries both: the agent importance is ignored, the plan lands.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      importanceLevel: "low",
      importanceRationale: "agent guess",
      plan: [step],
    });
    const [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.importance).toMatchObject({ level: "high", setBy: "tom" });
    expect(todo.plan).toHaveLength(1);
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "importance-skipped")).toBe(true);
  });

  // witness: reintroduce ANY plan gate in internalPrepareTodo (convex/dts.ts)
  // — a tom-step check, a Tom-touched check, either one — and this test goes
  // red. Ratified doctrine (Tom, 2026-08-29): his input gates what PERSISTS
  // (rulings, merges, statuses), never the plan text an agent works from, and
  // the first fleet run showed such a check refusing legitimate refinements of
  // agent-authored tom-steps.
  it("plans always land, on untouched and Tom-touched rows alike", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.tts.internalCapture, {
      statement: "captured",
      source: "slack-capture",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    const step = {
      text: "look it up",
      actor: "agent" as const,
      status: "open" as const,
    };
    const tomStep = {
      text: "decide the venue",
      actor: "tom" as const,
      status: "open" as const,
    };

    // (a) UNTOUCHED row: an agent-authored plan carrying a tom-step, then a
    // reword of that very step — the refinement the old gate refused.
    expect(captured.tomTouchedAt).toBeUndefined();
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      plan: [step, tomStep],
    });
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      plan: [step, { ...tomStep, text: "decide the venue — three-way now" }],
    });
    let [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.plan?.[1].text).toBe("decide the venue — three-way now");

    // (b) TOM-TOUCHED row: Tom writes the plan himself (updateTodo stamps
    // tomTouchedAt), and the agent then DROPS his step. That lands too.
    await tom.mutation(api.tts.updateTodo, {
      id: captured._id,
      plan: [step, tomStep],
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.tomTouchedAt).toBeDefined();
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      plan: [{ ...step, status: "done" as const, doneAt: 1 }],
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.plan).toHaveLength(1);
    expect(todo.plan?.[0].status).toBe("done");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "plan-skipped")).toBe(false);
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

  // witness: drop the `todo.dueAt !== undefined` guard from internalPrepareTodo
  // in convex/dts.ts — the preparer would overwrite a date Tom already set.
  it("the preparer sets a FIRST date only, never over an existing one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const undatedId = await tom.mutation(api.tts.createTodo, {
      statement: "pay rent sept 3",
    });
    const due = Date.UTC(2026, 8, 3, 16); // noon NY
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: undatedId,
      brief: "rent",
      dueAt: due,
    });
    let todos = await tom.query(api.tts.listTodos, {});
    expect(todos[0].dueAt).toBe(due);
    expect(todos[0].dateKind).toBe("self-imposed");
    expect(todos[0].timingClass).toBe("dated");
    // A second preparer date is refused (and named), leaving the stored one.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: undatedId,
      dueAt: due + 5 * 86_400_000,
    });
    todos = await tom.query(api.tts.listTodos, {});
    expect(todos[0].dueAt).toBe(due);
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "due-skipped")).toBe(true);
    // A batch's dates are never the single-todo preparer's business either.
    await storeBatch(t);
    const batch = await findBatch(t);
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: batch!._id,
      dueAt: due,
    });
    expect((await findBatch(t))?.dueAt).toBeUndefined();
  });

  // witness: drop `(todo.dateOutcomes ?? []).length > 0` from the dueAt branch
  // of internalPrepareTodo in convex/dts.ts — a re-prep reading the same
  // statement would hand back the very date Tom just recorded as missed.
  it("the preparer never resurrects a date Tom already resolved", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const due = Date.UTC(2026, 8, 3, 16); // noon NY
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "pay rent sept 3",
      dueAt: due,
    });
    // Tom resolves it: missed, no replacement — the item goes back to whenever
    // and the miss is on record.
    await tom.mutation(api.tts.recordDateOutcome, { id, outcome: "missed" });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBeUndefined();
    expect(todo.dateOutcomes).toHaveLength(1);
    // The statement still says "sept 3", so the preparer offers it again.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      brief: "rent",
      dueAt: due,
    });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBeUndefined();
    expect(todo.timingClass).toBe("whenever");
    const events = await tom.query(api.tts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "due-skipped")).toBe(true);
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

// The one time input on the /dts page: Tom writes a sentence, the worker job
// proposes actions, and internalApplyTimeNote is the gate that decides whether
// they are legal. These tests are about that gate — the agent's reading is
// never the authority.
describe("TTS time notes", () => {
  const DAY = 86_400_000;

  const apply = (
    t: ReturnType<typeof convexTest>,
    id: string,
    actions: Record<string, unknown>[],
    result = "did the thing",
  ) =>
    t.mutation(internal.tts.internalApplyTimeNote, {
      id,
      status: "applied",
      result,
      actions: actions as never,
    });

  it("gates every Tom-facing time-note function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.tts.listTimeNotes, {})).rejects.toThrow();
    await expect(
      t.mutation(api.tts.createTimeNote, {
        text: "tomorrow",
        day: "2026-08-29",
      }),
    ).rejects.toThrow();
  });

  // witness: take `day` as a number again (or drop the YYYY-MM-DD check) — the
  // browser's local start-of-day ms, the worker's day + 24h, and the server's
  // New York wall clock were three different days before this contract.
  it("a day-scoped note carries a YYYY-MM-DD calendar date", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    for (const day of ["2026-8-29", "tomorrow", "2026-08-29T00:00", ""]) {
      await expect(
        tom.mutation(api.tts.createTimeNote, { text: "sat 9-11", day }),
      ).rejects.toThrow(/YYYY-MM-DD/);
    }
    await tom.mutation(api.tts.createTimeNote, {
      text: "sat 9-11",
      day: "2026-08-29",
    });
    const [note] = await tom.query(api.tts.listTimeNotes, {});
    expect(note.day).toBe("2026-08-29");
  });

  // witness: drop requireOneTimeNoteContext from createTimeNote in
  // convex/dts.ts — a note with no context (or two) has nothing to act on.
  it("a time note has exactly one context and real text", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    const blockId = await tom.mutation(api.tts.createBlock, {
      start: Date.now(),
      end: Date.now() + 3_600_000,
      category: "chores",
    });
    await expect(
      tom.mutation(api.tts.createTimeNote, { text: "next week" }),
    ).rejects.toThrow(/exactly one context/);
    await expect(
      tom.mutation(api.tts.createTimeNote, { text: "next week", todoId, blockId }),
    ).rejects.toThrow(/exactly one context/);
    await expect(
      tom.mutation(api.tts.createTimeNote, { text: "   ", todoId }),
    ).rejects.toThrow(/needs text/);
    const id = await tom.mutation(api.tts.createTimeNote, {
      text: "  next wednesday  ",
      todoId,
    });
    const [note] = await tom.query(api.tts.listTimeNotes, {});
    expect(note._id).toBe(id);
    expect(note.text).toBe("next wednesday");
    expect(note.status).toBe("pending");
  });

  // witness: make listTimeNotes return every applied note — a month of
  // resolved notes would pile up on the page forever.
  it("lists unresolved notes plus the last 24h of applied ones", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    const fresh = await tom.mutation(api.tts.createTimeNote, {
      text: "fresh",
      todoId,
    });
    const stale = await tom.mutation(api.tts.createTimeNote, {
      text: "stale",
      todoId,
    });
    const ambiguous = await tom.mutation(api.tts.createTimeNote, {
      text: "sometime-ish",
      todoId,
    });
    await apply(t, fresh, [], "noted");
    await t.mutation(internal.tts.internalApplyTimeNote, {
      id: ambiguous,
      status: "needs-session",
      result: "no anchor to read this against",
    });
    // Age the stale one past the window by hand (nothing deletes it — an
    // applied note is kept forever as instrumentation).
    await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("dtsTimeNotes", stale)!;
      await ctx.db.patch(id, {
        status: "applied",
        result: "long ago",
        resolvedAt: Date.now() - 2 * DAY,
      });
    });
    const listed = await tom.query(api.tts.listTimeNotes, {});
    expect(listed.map((n) => n.text).sort()).toEqual(["fresh", "sometime-ish"]);
    expect(
      await t.run(async (ctx) => ctx.db.query("dtsTimeNotes").collect()),
    ).toHaveLength(3);
  });

  // witness: let deleteTimeNote delete an applied note — the only record of
  // what changed and why would be erasable.
  it("deletes a pending or needs-session note, never an applied one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    const pending = await tom.mutation(api.tts.createTimeNote, {
      text: "a",
      todoId,
    });
    const applied = await tom.mutation(api.tts.createTimeNote, {
      text: "b",
      todoId,
    });
    await apply(t, applied, [], "noted");
    await tom.mutation(api.tts.deleteTimeNote, { id: pending });
    await expect(
      tom.mutation(api.tts.deleteTimeNote, { id: applied }),
    ).rejects.toThrow(/history/);
  });

  // witness: drop the `todo.dueAt !== undefined` throw from the set-due branch
  // of internalApplyTimeNote — a note could silently slide a date.
  it("set-due gives a first date only; a second one is a renegotiation", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "rent" });
    const first = await tom.mutation(api.tts.createTimeNote, {
      text: "due sept 3",
      todoId,
    });
    const due = Date.now() + 5 * DAY;
    await apply(t, first, [{ kind: "set-due", dueAt: due }], "due set to Sep 3");
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBe(due);
    expect(todo.dateKind).toBe("self-imposed");
    expect(todo.timingClass).toBe("dated");
    // A time note is Tom's own instruction: it stamps tomTouchedAt exactly
    // where updateTodo would.
    expect(todo.tomTouchedAt).toBeDefined();
    const second = await tom.mutation(api.tts.createTimeNote, {
      text: "actually the 8th",
      todoId,
    });
    await expect(
      apply(t, second, [{ kind: "set-due", dueAt: due + DAY }]),
    ).rejects.toThrow(/kept-dates/);
    // The rejection rolled the whole thing back: date untouched, note still
    // pending for the job to re-submit as needs-session.
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBe(due);
    const notes = await tom.query(api.tts.listTimeNotes, {});
    expect(notes.find((n) => n._id === second)?.status).toBe("pending");
  });

  // witness: drop the now < dueAt check from applyDateOutcome (or stop routing
  // renegotiate through it) and a past date could be slid silently.
  it("renegotiate is legal before the date and refused after it", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const ahead = await tom.mutation(api.tts.createTodo, {
      statement: "ahead",
      dueAt: Date.now() + 3 * DAY,
    });
    const past = await tom.mutation(api.tts.createTodo, {
      statement: "past",
      dueAt: Date.now() - 3 * DAY,
    });
    const ok = await tom.mutation(api.tts.createTimeNote, {
      text: "push to friday",
      todoId: ahead,
    });
    const newDueAt = Date.now() + 9 * DAY;
    await apply(t, ok, [{ kind: "renegotiate", newDueAt, note: "trip" }], "moved");
    const todos = await tom.query(api.tts.listTodos, {});
    const moved = todos.find((x) => x._id === ahead)!;
    expect(moved.dueAt).toBe(newDueAt);
    expect(moved.dateOutcomes).toHaveLength(1);
    expect(moved.dateOutcomes?.[0].outcome).toBe("renegotiated");

    const late = await tom.mutation(api.tts.createTimeNote, {
      text: "push it back",
      todoId: past,
    });
    await expect(
      apply(t, late, [{ kind: "renegotiate", newDueAt }]),
    ).rejects.toThrow(/only allowed before the date arrives/);
    // …and the mirror rule: a date still ahead is not "missed".
    const early = await tom.mutation(api.tts.createTimeNote, {
      text: "I blew it",
      todoId: ahead,
    });
    await expect(apply(t, early, [{ kind: "record-missed" }])).rejects.toThrow(
      /has not arrived/,
    );
    const missed = await tom.mutation(api.tts.createTimeNote, {
      text: "never happened",
      todoId: past,
    });
    await apply(t, missed, [{ kind: "record-missed" }], "recorded as missed");
    const after = (await tom.query(api.tts.listTodos, {})).find(
      (x) => x._id === past,
    )!;
    expect(after.dueAt).toBeUndefined();
    expect(after.timingClass).toBe("whenever");
    expect(after.dateOutcomes?.[0].outcome).toBe("missed");
  });

  // witness: drop requireSubject from the todo-scoped branches — a note
  // written on a calendar day would silently act on nothing (or worse).
  it("todo-scoped actions need a note written on a todo", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const dayNote = await tom.mutation(api.tts.createTimeNote, {
      text: "sat 9-11 chores",
      day: normalDayKey(Date.now()),
    });
    await expect(
      apply(t, dayNote, [{ kind: "set-due", dueAt: Date.now() + DAY }]),
    ).rejects.toThrow(/written on a todo/);
  });

  // witness: stop routing set-waiting/set-active through applyStatusChange —
  // the reopen cleanup (stale wake facts) would drift from setStatus.
  it("set-waiting and set-active go through the one status implementation", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "later" });
    const sleep = await tom.mutation(api.tts.createTimeNote, {
      text: "wait until the lease renews",
      todoId,
    });
    const wakeAt = Date.now() + 30 * DAY;
    await apply(
      t,
      sleep,
      [{ kind: "set-waiting", wakeAt, wakeCondition: "lease renews" }],
      "asleep until the lease renews",
    );
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("waiting");
    expect(todo.wakeAt).toBe(wakeAt);
    expect(todo.wakeCondition).toBe("lease renews");
    const wake = await tom.mutation(api.tts.createTimeNote, {
      text: "wake it now",
      todoId,
    });
    await apply(t, wake, [{ kind: "set-active" }], "awake");
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("active");
    expect(todo.wakeAt).toBeUndefined();
    expect(todo.wakeCondition).toBeUndefined();
  });

  // witness: stop routing the block actions through insertBlock/patchBlock —
  // the exactly-one-target and ends-after-it-starts rules would not apply here.
  it("block actions obey the same validation as the calendar mutations", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "gym" });
    const start = Date.now() + DAY;
    const end = start + 3_600_000;

    // Two targets: refused, exactly as createBlock refuses it.
    const bad = await tom.mutation(api.tts.createTimeNote, {
      text: "an hour tomorrow",
      todoId,
    });
    await expect(
      apply(t, bad, [
        { kind: "create-block", start, end, todoId, category: "chores" },
      ]),
    ).rejects.toThrow(/exactly one thing/);

    // From a todo's own note, an untargeted block belongs to that todo.
    const good = await tom.mutation(api.tts.createTimeNote, {
      text: "an hour tomorrow",
      todoId,
    });
    await apply(t, good, [{ kind: "create-block", start, end }], "placed 1h");
    const [block] = await tom.query(api.tts.listBlocks, {});
    expect(block.todoId).toBe(todoId);

    // Move it, then refuse a backwards span, then delete it.
    const move = await tom.mutation(api.tts.createTimeNote, {
      text: "an hour earlier",
      blockId: block._id,
    });
    await apply(
      t,
      move,
      [
        {
          kind: "update-block",
          blockId: block._id,
          start: start - 3_600_000,
          end: end - 3_600_000,
        },
      ],
      "moved an hour earlier",
    );
    expect((await tom.query(api.tts.listBlocks, {}))[0].start).toBe(
      start - 3_600_000,
    );
    const backwards = await tom.mutation(api.tts.createTimeNote, {
      text: "make it end before it starts",
      blockId: block._id,
    });
    await expect(
      apply(t, backwards, [
        { kind: "update-block", blockId: block._id, start: end, end: start },
      ]),
    ).rejects.toThrow(/ends after it starts/);
    const drop = await tom.mutation(api.tts.createTimeNote, {
      text: "cancel it",
      blockId: block._id,
    });
    await apply(t, drop, [{ kind: "delete-block", blockId: block._id }], "gone");
    expect(await tom.query(api.tts.listBlocks, {})).toHaveLength(0);
  });

  // witness: drop the note.status !== "pending" throw — a retried POST would
  // apply the same actions twice.
  it("a note is applied once, and needs-session carries no actions", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "x" });
    const id = await tom.mutation(api.tts.createTimeNote, { text: "a", todoId });
    await apply(t, id, [], "noted");
    await expect(apply(t, id, [], "again")).rejects.toThrow(/already applied/);
    const other = await tom.mutation(api.tts.createTimeNote, {
      text: "b",
      todoId,
    });
    await expect(
      t.mutation(internal.tts.internalApplyTimeNote, {
        id: other,
        status: "needs-session",
        result: "ambiguous",
        actions: [{ kind: "set-active" }],
      }),
    ).rejects.toThrow(/carries no actions/);
    await expect(
      t.mutation(internal.tts.internalApplyTimeNote, {
        id: other,
        status: "applied",
        result: "   ",
      }),
    ).rejects.toThrow(/result/);
  });

  // witness: return the raw notes from internalPendingTimeNotes without their
  // context — the job would have to guess what "it" refers to.
  it("the worker queue carries each note's own context", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "reserve UH 400",
      dueAt: Date.now() + 2 * DAY,
    });
    await tom.mutation(api.tts.createTimeNote, { text: "push it", todoId });
    // The day note names a NY calendar date; the block is placed inside that
    // date's NY window, which is how the server finds it (not by ms arithmetic
    // on a browser-local start-of-day).
    const day = normalDayKey(Date.now());
    const dayStart = normalDayBoundsUtc(day).start;
    await tom.mutation(api.tts.createTimeNote, { text: "sat 9-11", day });
    const blockId = await tom.mutation(api.tts.createBlock, {
      start: dayStart + 9 * 3_600_000,
      end: dayStart + 11 * 3_600_000,
      category: "chores",
    });
    await tom.mutation(api.tts.createTimeNote, { text: "earlier", blockId });
    // A block on the NEXT calendar day is NOT this day's business.
    await tom.mutation(api.tts.createBlock, {
      start: normalDayBoundsUtc(day).end + 3_600_000,
      end: normalDayBoundsUtc(day).end + 7_200_000,
      category: "chores",
    });

    const queue = await t.query(internal.tts.internalPendingTimeNotes, {});
    expect(queue).toHaveLength(3);
    const byKind = new Map(
      queue.map((n) => [
        (n.context as { kind: string } | null)?.kind,
        n.context as Record<string, unknown>,
      ]),
    );
    expect(
      (byKind.get("todo") as { todo: { statement: string } }).todo.statement,
    ).toBe("reserve UH 400");
    expect((byKind.get("day") as { dayBlocks: unknown[] }).dayBlocks).toHaveLength(1);
    expect(
      (byKind.get("block") as { block: { category: string } }).block.category,
    ).toBe("chores");
    // Resolved notes leave the queue.
    await apply(t, queue[0]._id, [], "noted");
    expect(
      await t.query(internal.tts.internalPendingTimeNotes, {}),
    ).toHaveLength(2);
  });

  // witness: hoist `const subject = await ctx.db.get(note.todoId)` above the
  // action loop in internalApplyTimeNote — action 2 would then validate against
  // the world as it was BEFORE action 1, and one sentence carrying two steps
  // ("I blew Tuesday, do it Friday") would be refused or written wrong.
  it("each action validates against the previous action's result", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    // [record-missed, set-due]: the miss clears the date, so the set-due that
    // follows is a FIRST date, not a kept-dates violation.
    const past = await tom.mutation(api.tts.createTodo, {
      statement: "call the bank",
      dueAt: Date.now() - 3 * DAY,
    });
    const both = await tom.mutation(api.tts.createTimeNote, {
      text: "blew it — do it friday instead",
      todoId: past,
    });
    const replacement = Date.now() + 3 * DAY;
    await apply(
      t,
      both,
      [{ kind: "record-missed" }, { kind: "set-due", dueAt: replacement }],
      "recorded the miss and set Friday",
    );
    let todo = (await tom.query(api.tts.listTodos, {})).find(
      (x) => x._id === past,
    )!;
    expect(todo.dateOutcomes).toHaveLength(1);
    expect(todo.dateOutcomes?.[0].outcome).toBe("missed");
    expect(todo.dueAt).toBe(replacement);
    expect(todo.timingClass).toBe("dated");

    // [renegotiate, renegotiate]: each one records the date it actually moved,
    // so BOTH outcome rows survive (a stale subject would overwrite the first).
    const ahead = await tom.mutation(api.tts.createTodo, {
      statement: "reserve the room",
      dueAt: Date.now() + 2 * DAY,
    });
    const twice = await tom.mutation(api.tts.createTimeNote, {
      text: "push to thursday, no — friday",
      todoId: ahead,
    });
    const first = Date.now() + 4 * DAY;
    const second = Date.now() + 5 * DAY;
    await apply(
      t,
      twice,
      [
        { kind: "renegotiate", newDueAt: first },
        { kind: "renegotiate", newDueAt: second },
      ],
      "moved to Friday",
    );
    todo = (await tom.query(api.tts.listTodos, {})).find((x) => x._id === ahead)!;
    expect(todo.dueAt).toBe(second);
    expect(todo.dateOutcomes).toHaveLength(2);
    // The second row records the date the SECOND move replaced — the first
    // move's result, not the original.
    expect(todo.dateOutcomes?.[1].dueAt).toBe(first);
  });

  // witness: drop `newDueAt` from the record-missed branch — "I blew Tuesday,
  // do it Friday" would drop the item to whenever and lose Friday.
  it("record-missed may carry the replacement date", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "renew the permit",
      dueAt: Date.now() - DAY,
    });
    const note = await tom.mutation(api.tts.createTimeNote, {
      text: "missed it, doing it friday",
      todoId,
    });
    const newDueAt = Date.now() + 3 * DAY;
    await apply(
      t,
      note,
      [{ kind: "record-missed", newDueAt, note: "was travelling" }],
      "recorded as missed, now due Friday",
    );
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.dueAt).toBe(newDueAt);
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateOutcomes).toHaveLength(1);
    expect(todo.dateOutcomes?.[0].outcome).toBe("missed");
    expect(todo.dateOutcomes?.[0].note).toBe("was travelling");
  });

  // witness: write `wakeAt: action.wakeAt` straight through — a note that only
  // moves the wake DATE would erase the wake CONDITION Tom never mentioned
  // (applyStatusChange writes both fields unconditionally).
  it("set-waiting preserves the fields the note did not mention", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "lease" });
    const asleep = await tom.mutation(api.tts.createTimeNote, {
      text: "wait until the lease renews, check the 1st",
      todoId,
    });
    const wakeAt = Date.now() + 30 * DAY;
    await apply(
      t,
      asleep,
      [{ kind: "set-waiting", wakeAt, wakeCondition: "lease renews" }],
      "asleep",
    );
    // Only the date moves; the condition is not mentioned and must survive.
    const later = await tom.mutation(api.tts.createTimeNote, {
      text: "make that the 15th instead",
      todoId,
    });
    const moved = wakeAt + 14 * DAY;
    await apply(t, later, [{ kind: "set-waiting", wakeAt: moved }], "moved");
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.wakeAt).toBe(moved);
    expect(todo.wakeCondition).toBe("lease renews");
    // …and the mirror: a condition-only note keeps the date.
    const reworded = await tom.mutation(api.tts.createTimeNote, {
      text: "really it's when the landlord writes back",
      todoId,
    });
    await apply(
      t,
      reworded,
      [{ kind: "set-waiting", wakeCondition: "landlord writes back" }],
      "reworded",
    );
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.wakeAt).toBe(moved);
    expect(todo.wakeCondition).toBe("landlord writes back");
  });

  // witness: drop the set-date-kind branch (or its dueAt check) — "that's the
  // landlord's deadline, not mine" would have nowhere to land, or would label a
  // date that does not exist.
  it("set-date-kind relabels an existing date and needs one", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const dueAt = Date.now() + 4 * DAY;
    const dated = await tom.mutation(api.tts.createTodo, {
      statement: "renew the lease",
      dueAt,
    });
    const undated = await tom.mutation(api.tts.createTodo, {
      statement: "someday",
    });
    const relabel = await tom.mutation(api.tts.createTimeNote, {
      text: "that's the landlord's date, not mine",
      todoId: dated,
    });
    await apply(
      t,
      relabel,
      [{ kind: "set-date-kind", dateKind: "external" }],
      "marked as someone else's deadline",
    );
    const todos = await tom.query(api.tts.listTodos, {});
    const after = todos.find((x) => x._id === dated)!;
    expect(after.dateKind).toBe("external");
    expect(after.dueAt).toBe(dueAt); // the date itself never moved
    const nothing = await tom.mutation(api.tts.createTimeNote, {
      text: "external",
      todoId: undated,
    });
    await expect(
      apply(t, nothing, [{ kind: "set-date-kind", dateKind: "external" }]),
    ).rejects.toThrow(/no date to describe/);
  });
});
