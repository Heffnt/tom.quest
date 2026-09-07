import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  countdownText,
  nyCalendarDayBoundsUtc,
  nyCalendarDayKey,
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

  // witness: make nyCalendarDayBoundsUtc use the 5 a.m. TTS boundary (or
  // hand-roll start + 86_400_000) — a day-scoped time note written on a
  // calendar column would cover the wrong 24 hours.
  it("computes calendar-day bounds (NY midnight to midnight)", () => {
    const edt = nyCalendarDayBoundsUtc("2026-08-27");
    expect(edt.start).toBe(Date.UTC(2026, 7, 27, 4)); // 00:00 EDT
    expect(edt.end).toBe(Date.UTC(2026, 7, 28, 4));
    const est = nyCalendarDayBoundsUtc("2026-01-15");
    expect(est.start).toBe(Date.UTC(2026, 0, 15, 5)); // 00:00 EST
    // Every instant inside the window reports that calendar date, and the
    // instant one ms before the start reports the previous one.
    expect(nyCalendarDayKey(edt.start)).toBe("2026-08-27");
    expect(nyCalendarDayKey(edt.end - 1)).toBe("2026-08-27");
    expect(nyCalendarDayKey(edt.start - 1)).toBe("2026-08-26");
    // Fall-back day: 25 wall-clock hours, so a fixed +DAY_MS would truncate it.
    const fall = nyCalendarDayBoundsUtc("2026-11-01");
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

  // ── The hourly update's reads (Tom's ruling 2026-08-30) ──────────────────
  // Each is the internal twin of a requireTomId-gated query, because the
  // hourly update runs from a cron and a cron has no identity.

  // witness: change internalLastEventAt to return the newest event of ANY kind
  // and this goes red — the window would start at the last capture rather than
  // the last SEND, and an hour with captures in it would report nothing.
  it("reads the window back from the last send, not the last event", async () => {
    const t = convexTest({ schema, modules });
    expect(
      await t.query(internal.tts.internalLastEventAt, {
        kind: "hourly-update-sent",
      }),
    ).toBeNull(); // never sent — the caller falls back to its default window

    await t.mutation(internal.tts.internalLogEvent, {
      kind: "hourly-update-sent",
      data: { windowStart: 1, windowEnd: 2 },
    });
    // Busier events land AFTER the marker and must not be mistaken for it.
    await t.mutation(internal.tts.internalCapture, {
      statement: "later than the marker",
      source: "manual",
    });
    const sentAt = await t.query(internal.tts.internalLastEventAt, {
      kind: "hourly-update-sent",
    });
    expect(sentAt).not.toBeNull();

    // And the range read covers [marker, now) — the capture above is in it.
    const inWindow = await t.query(internal.tts.internalEventsInRange, {
      start: sentAt!,
      end: Date.now() + 1,
    });
    expect(inWindow.some((e) => e.kind === "captured")).toBe(true);
  });

  // witness: drop the `b.end > at` filter from internalScheduleAt and a block
  // that ended this morning reports as what Tom is doing right now.
  it("reports only the blocks actually spanning the moment asked about", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const now = Date.now();
    const hour = 3_600_000;
    const todoId = await tom.mutation(api.tts.createTodo, {
      statement: "write the thing",
    });
    // Ended an hour ago.
    await tom.mutation(api.tts.createBlock, {
      start: now - 3 * hour,
      end: now - hour,
      category: "past",
    });
    // Spanning now.
    await tom.mutation(api.tts.createBlock, {
      start: now - hour,
      end: now + hour,
      todoId,
    });
    // Starts in an hour.
    await tom.mutation(api.tts.createBlock, {
      start: now + hour,
      end: now + 2 * hour,
      category: "future",
    });

    const schedule = await t.query(internal.tts.internalScheduleAt, { at: now });
    expect(schedule).toHaveLength(1);
    // The join to the todo is what makes the Slack line readable — a bare
    // start/end pair says nothing about what Tom is meant to be doing.
    expect(schedule[0].statement).toBe("write the thing");
  });

  // ── Slack capture is idempotent on the message ts (Tom, 2026-08-30) ───────
  // TWO producers now capture the same #dump message: the /slack/events push
  // route (Slack retries the same event — delivery is at-least-once) and
  // poll-dump.mjs, the hourly reconciliation backstop, which cannot know what
  // the push route already took.
  // witness: delete the by_slackTs lookup from internalCapture and this goes
  // red — every Slack retry mints a duplicate todo.
  it("captures a Slack message once, however many times it is offered", async () => {
    const t = convexTest({ schema, modules });
    const first = await t.mutation(internal.tts.internalCapture, {
      statement: "buy climbing tape",
      source: "slack-capture",
      provenance: "slack:#dump ts=1787875674.496329",
      slackChannel: "C0DUMP",
      slackTs: "1787875674.496329",
    });
    // The backstop re-offers the same message with its own provenance.
    const second = await t.mutation(internal.tts.internalCapture, {
      statement: "buy climbing tape",
      source: "slack-capture",
      provenance: "https://slack.example/archives/C0DUMP/p1787875674496329",
      slackChannel: "C0DUMP",
      slackTs: "1787875674.496329",
    });
    expect(second).toBe(first);
    const todos = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todos).toHaveLength(1);
    expect(todos[0].slackTs).toBe("1787875674.496329");
    expect(todos[0].slackChannel).toBe("C0DUMP");

    // A capture with NO ts is unaffected — manual and agent captures must not
    // collapse into each other.
    await t.mutation(internal.tts.internalCapture, {
      statement: "something else",
      source: "prospecting",
    });
    await t.mutation(internal.tts.internalCapture, {
      statement: "something else",
      source: "prospecting",
    });
    const after = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(after).toHaveLength(3);
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
      readiness: "prepared",
    });
    const [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.readiness).toBe("prepared");
    expect(todo.entryAction).toBe("Open the retailer page");
    expect(todo.statement).toBe("buy climbing tape"); // intent untouched
    // The retired spelling is refused since the narrow (the lifeos update,
    // phase 7): the pen's validator holds "prepared" alone, so an older box
    // job cannot put a retired value back into the record.
    await expect(
      t.mutation(internal.tts.internalPrepareTodo, {
        id: captured._id,
        readiness: "ready-for-tom" as never,
      }),
    ).rejects.toThrow();
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
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.status).toBe("waiting");
    expect(todo.wakeAt).toBe(due);
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

describe("TTS annotations and the preparer", () => {
  // Real-clock tick: guarantees Date.now() advances between two mutations, so
  // "does not bump updatedAt" assertions cannot pass by same-millisecond luck.
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("internalBulkUpdate is Tom's pen: content bumps updatedAt, nothing else", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "spoken" });
    const [before] = await tom.query(api.tts.listTodos, {});
    await tick();
    await t.mutation(internal.tts.internalBulkUpdate, { updates: [{ id }] });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt); // no fields: no bump
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


  // witness: drop the `status !== undefined || dueAt !== undefined` gate from
  // internalTriage's tomTouchedAt patch in convex/tts.ts — a no-op/retry pen
  // call would freeze a row against the planner forever.
  it("a no-op internalTriage call does not stamp tomTouchedAt", async () => {
    const t = convexTest({ schema, modules });
    const id = await t.mutation(internal.tts.internalCapture, {
      statement: "still the planner's",
      source: "slack-capture",
    });
    const stored = async () =>
      (await t.run(async (ctx) => ctx.db.get(id)))!;
    await t.mutation(internal.tts.internalTriage, {
      id,
      note: "looked at it, ruled nothing",
    });
    expect((await stored()).tomTouchedAt).toBeUndefined();
    // A triage that actually rules DOES freeze it.
    await t.mutation(internal.tts.internalTriage, {
      id,
      status: "waiting",
      wakeAt: Date.now() + 86_400_000,
    });
    expect((await stored()).tomTouchedAt).toBeDefined();
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

});

// The one time input on the /dts page: Tom writes a sentence, the worker job
// proposes actions, and internalApplyTimeNote is the gate that decides whether
// they are legal. These tests are about that gate — the agent's reading is
// never the authority.
describe("TTS time notes", () => {
  const DAY = 86_400_000;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      day: nyCalendarDayKey(Date.now()),
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
      [{ kind: "set-waiting", wakeAt }],
      "asleep until the lease renews",
    );
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("waiting");
    expect(todo.wakeAt).toBe(wakeAt);
    const wake = await tom.mutation(api.tts.createTimeNote, {
      text: "wake it now",
      todoId,
    });
    await apply(t, wake, [{ kind: "set-active" }], "awake");
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("active");
    expect(todo.wakeAt).toBeUndefined();
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
    const day = nyCalendarDayKey(Date.now());
    const dayStart = nyCalendarDayBoundsUtc(day).start;
    await tom.mutation(api.tts.createTimeNote, { text: "sat 9-11", day });
    const blockId = await tom.mutation(api.tts.createBlock, {
      start: dayStart + 9 * 3_600_000,
      end: dayStart + 11 * 3_600_000,
      category: "chores",
    });
    await tom.mutation(api.tts.createTimeNote, { text: "earlier", blockId });
    // A block on the NEXT calendar day is NOT this day's business.
    await tom.mutation(api.tts.createBlock, {
      start: nyCalendarDayBoundsUtc(day).end + 3_600_000,
      end: nyCalendarDayBoundsUtc(day).end + 7_200_000,
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

  // witness: write `wakeAt: action.wakeAt` straight through — a note that says
  // nothing about the time would erase the sleep Tom never mentioned
  // (applyStatusChange writes the field unconditionally).
  it("set-waiting preserves the sleep the note did not mention", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "lease" });
    const asleep = await tom.mutation(api.tts.createTimeNote, {
      text: "wait until the lease renews, check the 1st",
      todoId,
    });
    const wakeAt = Date.now() + 30 * DAY;
    await apply(t, asleep, [{ kind: "set-waiting", wakeAt }], "asleep");
    const later = await tom.mutation(api.tts.createTimeNote, {
      text: "make that the 15th instead",
      todoId,
    });
    const moved = wakeAt + 14 * DAY;
    await apply(t, later, [{ kind: "set-waiting", wakeAt: moved }], "moved");
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.wakeAt).toBe(moved);
    // …and the mirror: a note that names no time keeps the one the row has.
    const reparked = await tom.mutation(api.tts.createTimeNote, {
      text: "keep waiting on it",
      todoId,
    });
    await apply(t, reparked, [{ kind: "set-waiting" }], "reparked");
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.wakeAt).toBe(moved);
  });

  // The retired sleep vocabulary. `set-latest-safe`, `clear-latest-safe` and a
  // `wakeCondition` on set-waiting were the roll-out shim of the lifeos
  // update's phase 7: declared and doing nothing, because the Jarvis Box rolls
  // out separately from a Convex deploy and a mutation refuses an argument it
  // does not declare, so undeclaring them then would have failed the WHOLE
  // flush of a box that had not caught up. worker/setup.sh has since run at
  // main 6825608 and nothing emits them, so they are gone — and a note still
  // carrying one is refused by name at the route, so a stale job reads its own
  // reason instead of a validator dump.
  //
  // witness: delete retiredTimeNoteAction's check in convex/http.ts and the
  // reasons below become the union validator's error text; declare the actions
  // again in convex/tts.ts and the note applies, putting back the fields the
  // clearing migration took off every row and blocking the next deploy.
  it("refuses the retired time-note actions by name and applies nothing", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.tts.createTodo, { statement: "lease" });
    const wakeAt = Date.now() + DAY;
    const post = async (actions: Record<string, unknown>[]) => {
      const id = await tom.mutation(api.tts.createTimeNote, {
        text: "safe until the 1st, and wait for the landlord",
        todoId,
      });
      const res = await t.fetch("/tts/apply-time-note", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TTS-Key": "s3cret" },
        body: JSON.stringify({ id, status: "applied", result: "noted", actions }),
      });
      return { status: res.status, error: (await res.json()).error as string };
    };
    expect(
      await post([{ kind: "set-latest-safe", latestSafeAt: Date.now() + 30 * DAY }]),
    ).toEqual({ status: 400, error: expect.stringContaining("set-latest-safe is retired") });
    expect(await post([{ kind: "clear-latest-safe" }])).toEqual({
      status: 400,
      error: expect.stringContaining("clear-latest-safe is retired"),
    });
    expect(
      await post([{ kind: "set-waiting", wakeAt, wakeCondition: "the landlord writes" }]),
    ).toEqual({
      status: 400,
      error: expect.stringContaining("set-waiting.wakeCondition is retired"),
    });
    // Nothing landed: the todo is untouched and every note is still pending
    // for the job to re-submit as needs-session.
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("active");
    expect(todo.wakeAt).toBeUndefined();
    const notes = await tom.query(api.tts.listTimeNotes, {});
    expect(notes.map((n) => n.status)).toEqual(["pending", "pending", "pending"]);
    // The sleep itself still applies — a wake TIME is the whole vocabulary.
    const ok = await tom.mutation(api.tts.createTimeNote, {
      text: "wait until the 15th",
      todoId,
    });
    await apply(t, ok, [{ kind: "set-waiting", wakeAt }], "parked");
    const [parked] = await tom.query(api.tts.listTodos, {});
    expect(parked.status).toBe("waiting");
    expect(parked.wakeAt).toBe(wakeAt);
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
