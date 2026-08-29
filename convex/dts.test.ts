import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  countdownText,
  dtsDayBoundsUtc,
  dtsDayKey,
  dtsPrepDay,
  nyLocalHour,
  nyOffsetHours,
} from "./dtsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

describe("dtsShared time helpers", () => {
  it("computes the New York offset across DST", () => {
    expect(nyOffsetHours(Date.UTC(2026, 7, 27, 12))).toBe(-4); // late August: EDT
    expect(nyOffsetHours(Date.UTC(2026, 0, 15, 12))).toBe(-5); // January: EST
    // 2026 transitions: spring forward Mar 8 (07:00 UTC), fall back Nov 1 (06:00 UTC).
    expect(nyOffsetHours(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5);
    expect(nyOffsetHours(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4);
    expect(nyOffsetHours(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4);
    expect(nyOffsetHours(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5);
  });

  it("rolls the DTS day over at 5 a.m. local, not midnight", () => {
    // 2026-08-27 08:59 UTC = 04:59 EDT -> still the 26th's DTS day.
    expect(dtsDayKey(Date.UTC(2026, 7, 27, 8, 59))).toBe("2026-08-26");
    // 09:00 UTC = 05:00 EDT -> the 27th begins.
    expect(dtsDayKey(Date.UTC(2026, 7, 27, 9, 0))).toBe("2026-08-27");
    expect(nyLocalHour(Date.UTC(2026, 7, 27, 9, 0))).toBe(5);
  });

  it("prep and digest land on the SAME day key (the review-caught bug)", () => {
    // Prep runs in the 4 a.m. hour, BEFORE the boundary; the digest at 5.
    // dtsPrepDay must bridge them — dtsDayKey alone named yesterday at 4:45.
    const prepEdt = Date.UTC(2026, 7, 27, 8, 45); // 4:45 EDT
    const digestEdt = Date.UTC(2026, 7, 27, 9, 0); // 5:00 EDT
    expect(dtsPrepDay(prepEdt)).toBe(dtsDayKey(digestEdt));
    const prepEst = Date.UTC(2026, 0, 15, 9, 45); // 4:45 EST
    const digestEst = Date.UTC(2026, 0, 15, 10, 0); // 5:00 EST
    expect(dtsPrepDay(prepEst)).toBe(dtsDayKey(digestEst));
    // A midday --force re-prep rebuilds TODAY's queue, not tomorrow's.
    const noon = Date.UTC(2026, 7, 27, 16);
    expect(dtsPrepDay(noon)).toBe(dtsDayKey(noon));
  });

  it("computes DST-correct day bounds (5 a.m. to 5 a.m. NY)", () => {
    const edt = dtsDayBoundsUtc("2026-08-27");
    expect(edt.start).toBe(Date.UTC(2026, 7, 27, 9)); // 5:00 EDT
    expect(edt.end).toBe(Date.UTC(2026, 7, 28, 9));
    const est = dtsDayBoundsUtc("2026-01-15");
    expect(est.start).toBe(Date.UTC(2026, 0, 15, 10)); // 5:00 EST
    expect(est.end).toBe(Date.UTC(2026, 0, 16, 10));
    // Fall-back day: starts in EDT, ends in EST — 25 wall-clock hours.
    const fall = dtsDayBoundsUtc("2026-10-31");
    expect(fall.end - fall.start).toBe(25 * 3_600_000);
  });

  it("renders countdown text", () => {
    const now = Date.UTC(2026, 7, 27, 15);
    expect(countdownText(now, now)).toBe("today");
    expect(countdownText(now + 86_400_000, now)).toBe("tomorrow");
    expect(countdownText(now + 3 * 86_400_000, now)).toBe("in 3 days");
    expect(countdownText(now - 2 * 86_400_000, now)).toBe("2 days overdue");
    // Calendar semantics: an item due at 2 a.m. NY on the 28th is due on the
    // 28th — the 5 a.m. DTS shift must not report it a day early (review).
    expect(countdownText(Date.UTC(2026, 7, 28, 6), now)).toBe("tomorrow");
  });
});

describe("DTS todos", () => {
  it("gates every Tom-facing function on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(
      t.mutation(api.dts.createTodo, { statement: "x" }),
    ).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(
      user.mutation(api.dts.createTodo, { statement: "x" }),
    ).rejects.toThrow();
    await expect(user.query(api.dts.listTodos, {})).rejects.toThrow();
  });

  it("creates, lists, and instruments a todo", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, {
      statement: "  email Ana Maria  ",
      dueAt: Date.now() + 86_400_000,
    });
    const todos = await tom.query(api.dts.listTodos, {});
    expect(todos).toHaveLength(1);
    expect(todos[0].statement).toBe("email Ana Maria");
    expect(todos[0].timingClass).toBe("dated"); // dueAt implies dated
    expect(todos[0].dateKind).toBe("self-imposed");
    expect(todos[0].readiness).toBe("unprepared");
    expect(todos[0].status).toBe("active");
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "created" && e.todoId === id)).toBe(true);
  });

  it("promotes whenever to dated when a date is set (spec §5.2)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, { statement: "clean room" });
    await tom.mutation(api.dts.updateTodo, { id, dueAt: Date.now() + 86_400_000 });
    const [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateKind).toBe("self-imposed");
  });

  it("enforces the kept-dates rule (spec §8)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const future = Date.now() + 5 * 86_400_000;
    const id = await tom.mutation(api.dts.createTodo, {
      statement: "reserve UH 400",
      dueAt: future,
    });
    // Renegotiation before the date: legal, recorded, date moves.
    await tom.mutation(api.dts.recordDateOutcome, {
      id,
      outcome: "renegotiated",
      newDueAt: future + 86_400_000,
    });
    let [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.dueAt).toBe(future + 86_400_000);
    expect(todo.dateOutcomes).toHaveLength(1);
    expect(todo.dateOutcomes?.[0].outcome).toBe("renegotiated");

    // A missed date without a new one drops the item back to whenever, miss on record.
    await tom.mutation(api.dts.recordDateOutcome, { id, outcome: "missed" });
    [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.dueAt).toBeUndefined();
    expect(todo.timingClass).toBe("whenever");
    expect(todo.dateOutcomes?.map((o) => o.outcome)).toEqual([
      "renegotiated",
      "missed",
    ]);

    // Renegotiating a past-due date is refused (record missed instead).
    const pastDue = await tom.mutation(api.dts.createTodo, {
      statement: "late thing",
      dueAt: Date.now() - 1000,
    });
    await expect(
      tom.mutation(api.dts.recordDateOutcome, {
        id: pastDue,
        outcome: "renegotiated",
        newDueAt: Date.now() + 86_400_000,
      }),
    ).rejects.toThrow(/before the date/);
  });

  it("resolves an open date as kept when the item is marked done", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, {
      statement: "submit form",
      dueAt: Date.now() + 86_400_000,
    });
    await tom.mutation(api.dts.setStatus, { id, status: "done" });
    const [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.status).toBe("done");
    expect(todo.doneAt).toBeDefined();
    expect(todo.dateOutcomes?.[0].outcome).toBe("done");
  });

  it("refuses to clear a date silently and clears terminal facts on reopen", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, {
      statement: "dated thing",
      dueAt: Date.now() + 86_400_000,
    });
    // The silent slide is forbidden (spec §8): dueAt:null is refused.
    await expect(
      tom.mutation(api.dts.updateTodo, { id, dueAt: null }),
    ).rejects.toThrow(/never cleared silently/);

    // Archive with an unarchive condition, then reactivate: the stale
    // terminal facts must not linger on the live item.
    await tom.mutation(api.dts.setStatus, {
      id,
      status: "archived",
      unarchiveCondition: "when Ana replies",
    });
    await tom.mutation(api.dts.setStatus, { id, status: "active" });
    const [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.status).toBe("active");
    expect(todo.archivedAt).toBeUndefined();
    expect(todo.unarchiveCondition).toBeUndefined();
  });

  it("worker prep intake drops non-active items and enforces the queue cap", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const ids = [];
    for (let i = 0; i < 9; i++) {
      ids.push(await tom.mutation(api.dts.createTodo, { statement: `t${i}` }));
    }
    const sleeping = ids[0];
    await tom.mutation(api.dts.setStatus, { id: sleeping, status: "waiting" });
    await t.mutation(internal.dts.internalStoreWorkerPrep, {
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
      t.mutation(internal.dts.internalStoreWorkerPrep, {
        day: "2026-08-27",
        todoIds: ["not-a-real-id"],
      }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  it("captures worker submissions as unprepared items", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.dts.internalCapture, {
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
    await t.mutation(internal.dts.internalCapture, {
      statement: "buy climbing tape",
      source: "slack-capture",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    await t.mutation(internal.dts.internalPrepareTodo, {
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
      t.mutation(internal.dts.internalPrepareTodo, { id: "bogus" }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  // witness: drop the already-dated throw in internalTriage and the
  // rejects assertion below goes red.
  it("internalTriage applies status + self-imposed dates with kept-dates intact", async () => {
    const t = convexTest({ schema, modules });
    await t.mutation(internal.dts.internalCapture, {
      statement: "reserve UH 400",
      source: "consolidation",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    const due = Date.now() + 3 * 86_400_000;
    await t.mutation(internal.dts.internalTriage, { id: captured._id, dueAt: due });
    let [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateKind).toBe("self-imposed");
    // A second date via triage is refused — dates move via recordDateOutcome.
    await expect(
      t.mutation(internal.dts.internalTriage, { id: captured._id, dueAt: due + 1 }),
    ).rejects.toThrow(/kept-dates/);
    await t.mutation(internal.dts.internalTriage, {
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
    const overdue = await tom.mutation(api.dts.createTodo, {
      statement: "overdue thing",
      dueAt: now - 86_400_000,
    });
    await tom.mutation(api.dts.createTodo, { statement: "someday thing" });
    const sleeping = await tom.mutation(api.dts.createTodo, {
      statement: "wake me",
    });
    await tom.mutation(api.dts.setStatus, {
      id: sleeping,
      status: "waiting",
      wakeAt: now - 1000,
    });

    await t.mutation(internal.dts.internalPrepareFallbackQueue, { force: true });

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
    const id = await tom.mutation(api.dts.createTodo, { statement: "a task" });
    await t.mutation(internal.dts.internalPrepareFallbackQueue, { force: true });
    const day = (
      await t.run(async (ctx) => ctx.db.query("dtsDailyQueues").collect())
    )[0].day;
    await t.mutation(internal.dts.internalStoreWorkerPrep, {
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
    await t.mutation(internal.dts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        { externalId: "a", tier: "R", status: "open", statement: "s1", url: "u" },
        { externalId: "b", tier: "H", status: "open", statement: "s2", url: "u" },
      ],
    });
    await t.mutation(internal.dts.internalReplaceMirror, {
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

describe("DTS blocks and category", () => {
  const HOUR = 3_600_000;

  // witness: remove the requireTomId call from listBlocks in convex/dts.ts
  it("gates listBlocks on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(t.query(api.dts.listBlocks, {})).rejects.toThrow();
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "u", email: "u@tom.quest", role: "user" }),
    );
    const user = t.withIdentity({ subject: userId });
    await expect(user.query(api.dts.listBlocks, {})).rejects.toThrow();
  });

  // witness: drop the requireOneBlockTarget call (or the end<=start throw)
  // from createBlock in convex/dts.ts
  it("createBlock targets exactly one thing and validates the span", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "block me" });
    const start = Date.now();
    // Zero targets.
    await expect(
      tom.mutation(api.dts.createBlock, { start, end: start + HOUR }),
    ).rejects.toThrow(/exactly one/);
    // Two targets.
    await expect(
      tom.mutation(api.dts.createBlock, {
        start,
        end: start + HOUR,
        todoId,
        category: "chores",
      }),
    ).rejects.toThrow(/exactly one/);
    // Zero-length and inverted spans.
    await expect(
      tom.mutation(api.dts.createBlock, { start, end: start, category: "chores" }),
    ).rejects.toThrow(/ends after/);
    await expect(
      tom.mutation(api.dts.createBlock, {
        start,
        end: start - HOUR,
        category: "chores",
      }),
    ).rejects.toThrow(/ends after/);
  });

  // witness: drop the ctx.db.get existence check from createBlock's todoId
  // branch in convex/dts.ts
  it("createBlock validates the todo target exists", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "gone" });
    await t.run(async (ctx) => ctx.db.delete(todoId));
    const start = Date.now();
    await expect(
      tom.mutation(api.dts.createBlock, { start, end: start + HOUR, todoId }),
    ).rejects.toThrow(/not found/);
  });

  it("creates, lists, and instruments blocks for both target kinds", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "a task" });
    const start = Date.now();
    const todoBlock = await tom.mutation(api.dts.createBlock, {
      start,
      end: start + 2 * HOUR,
      todoId,
      note: "Tue 9-11",
    });
    const categoryBlock = await tom.mutation(api.dts.createBlock, {
      start: start + 24 * HOUR,
      end: start + 26 * HOUR,
      category: "chores",
    });
    const blocks = await tom.query(api.dts.listBlocks, {});
    expect(blocks).toHaveLength(2);
    const perTodo = blocks.find((b) => b._id === todoBlock);
    expect(perTodo?.todoId).toBe(todoId);
    expect(perTodo?.category).toBeUndefined();
    expect(perTodo?.note).toBe("Tue 9-11");
    const perCategory = blocks.find((b) => b._id === categoryBlock);
    expect(perCategory?.category).toBe("chores");
    expect(perCategory?.todoId).toBeUndefined();
    const events = await tom.query(api.dts.listRecentEvents, {});
    const created = events.filter((e) => e.kind === "block-created");
    expect(created).toHaveLength(2);
    expect(created.some((e) => e.todoId === todoId)).toBe(true);
  });

  // witness: drop the recomputed-span throw from updateBlock in convex/dts.ts
  it("updateBlock moves the span, validates it, and logs the move", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const start = Date.now();
    const id = await tom.mutation(api.dts.createBlock, {
      start,
      end: start + HOUR,
      category: "chores",
      note: "keep me",
    });
    await tom.mutation(api.dts.updateBlock, {
      id,
      start: start + 24 * HOUR,
      end: start + 25 * HOUR,
    });
    let [block] = await tom.query(api.dts.listBlocks, {});
    expect(block.start).toBe(start + 24 * HOUR);
    expect(block.end).toBe(start + 25 * HOUR);
    expect(block.note).toBe("keep me"); // omitted field untouched
    // A partial edit that would invert the span is refused.
    await expect(
      tom.mutation(api.dts.updateBlock, { id, end: start }),
    ).rejects.toThrow(/ends after/);
    // note: null clears it.
    await tom.mutation(api.dts.updateBlock, { id, note: null });
    [block] = await tom.query(api.dts.listBlocks, {});
    expect(block.note).toBeUndefined();
    const events = await tom.query(api.dts.listRecentEvents, {});
    const moved = events.find((e) => e.kind === "block-moved");
    expect(moved?.data).toMatchObject({
      from: { start, end: start + HOUR },
      to: { start: start + 24 * HOUR, end: start + 25 * HOUR },
    });
  });

  // witness: drop the logEvent call from deleteBlock in convex/dts.ts
  it("deleteBlock removes the row and logs an event", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const todoId = await tom.mutation(api.dts.createTodo, { statement: "a task" });
    const start = Date.now();
    const id = await tom.mutation(api.dts.createBlock, {
      start,
      end: start + HOUR,
      todoId,
    });
    await tom.mutation(api.dts.deleteBlock, { id });
    expect(await tom.query(api.dts.listBlocks, {})).toHaveLength(0);
    const events = await tom.query(api.dts.listRecentEvents, {});
    const deleted = events.find((e) => e.kind === "block-deleted");
    expect(deleted?.todoId).toBe(todoId);
    expect(deleted?.data).toMatchObject({ start, end: start + HOUR });
  });

  it("createTodo/updateTodo round-trip category, null clears", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, {
      statement: "sweep the floor",
      category: "chores",
    });
    let [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.category).toBe("chores");
    await tom.mutation(api.dts.updateTodo, { id, category: "errands" });
    [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.category).toBe("errands");
    await tom.mutation(api.dts.updateTodo, { id, category: null });
    [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.category).toBeUndefined();
  });
});

describe("DTS batches and annotations", () => {
  // Real-clock tick: guarantees Date.now() advances between two mutations, so
  // "does not bump updatedAt" assertions cannot pass by same-millisecond luck.
  const tick = () => new Promise((r) => setTimeout(r, 5));

  const cmt = (externalId: string) => ({
    repo: "ComplexMultiTrigger",
    externalId,
  });

  const storeBatch = (
    t: ReturnType<typeof convexTest>,
    over: Partial<{
      id: string;
      statement: string;
      brief: string;
      members: { todoId?: Id<"dtsTodos">; repo?: string; externalId?: string }[];
      importanceLevel: "low" | "medium" | "high";
      importanceRationale: string;
    }> = {},
  ) =>
    t.mutation(internal.dts.internalStoreBatches, {
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
    const a = await tom.mutation(api.dts.createTodo, { statement: "book flights" });
    const res = await t.mutation(internal.dts.internalStoreBatches, {
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
    expect(res).toEqual({ created: 1, updated: 0, archived: 0, skipped: [] });
    const batch = await findBatch(t);
    expect(batch?.statement).toBe("trip logistics");
    expect(batch?.source).toBe("batcher");
    expect(batch?.readiness).toBe("ready-for-tom");
    expect(batch?.status).toBe("active");
    expect(batch?.timingClass).toBe("whenever");
    expect(batch?.members).toHaveLength(2);
    expect(batch?.importance).toMatchObject({ level: "medium", setBy: "agent" });
    expect(batch?.tomTouchedAt).toBeUndefined(); // agent write, never a Tom touch
    const events = await tom.query(api.dts.listRecentEvents, {});
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
  // convex/dts.ts — one subject would ride two live batches.
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

  // witness: drop the members check from validateBatchMembers in convex/dts.ts
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
    await tom.mutation(api.dts.setImportance, { id: batch!._id, level: "high" });
    const res = await t.mutation(internal.dts.internalStoreBatches, {
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
    const res = await t.mutation(internal.dts.internalStoreBatches, {
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
  // branch in convex/dts.ts. Importance is seeded directly here: every Tom
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
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(
      events.some(
        (e) => e.kind === "importance-skipped" && e.todoId === batch?._id,
      ),
    ).toBe(true);
  });

  // witness: add updatedAt to setImportance's patch in convex/dts.ts — the
  // annotation would resurface ruled gates via ruledAt<updatedAt.
  it("setImportance writes Tom's level as an annotation (no updatedAt bump)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, { statement: "x" });
    const [before] = await tom.query(api.dts.listTodos, {});
    await tick();
    await tom.mutation(api.dts.setImportance, { id, level: "high" });
    let [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.importance).toMatchObject({ level: "high", setBy: "tom" });
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt);
    await tom.mutation(api.dts.setImportance, { id, level: null });
    [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.importance).toBeUndefined();
  });

  it("setPlanStep checks a step off, reopens it, and rejects a bad index", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, { statement: "batchish" });
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
    const [before] = await tom.query(api.dts.listTodos, {});
    await tick();
    await tom.mutation(api.dts.setPlanStep, { id, index: 1, status: "done" });
    let [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.plan?.[1].status).toBe("done");
    expect(todo.plan?.[1].doneAt).toBeDefined();
    expect(todo.plan?.[0].status).toBe("open"); // sibling untouched
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt); // annotation, no bump
    await tom.mutation(api.dts.setPlanStep, { id, index: 1, status: "open" });
    [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.plan?.[1].doneAt).toBeUndefined(); // stale timestamp cleared
    await expect(
      tom.mutation(api.dts.setPlanStep, { id, index: 5, status: "done" }),
    ).rejects.toThrow(/no step 5/);
    const planless = await tom.mutation(api.dts.createTodo, { statement: "y" });
    await expect(
      tom.mutation(api.dts.setPlanStep, { id: planless, index: 0, status: "done" }),
    ).rejects.toThrow(/no plan/);
  });

  it("internalBulkUpdate is Tom's pen: setBy tom, only content bumps updatedAt", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.dts.createTodo, { statement: "spoken" });
    const [before] = await tom.query(api.dts.listTodos, {});
    await tick();
    await t.mutation(internal.dts.internalBulkUpdate, {
      updates: [
        { id, importanceLevel: "medium", importanceRationale: "he said so" },
      ],
    });
    let [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.importance).toMatchObject({
      level: "medium",
      setBy: "tom", // records Tom's SPOKEN ruling, not an agent estimate
      rationale: "he said so",
    });
    expect(todo.tomTouchedAt).toBeDefined();
    expect(todo.updatedAt).toBe(before.updatedAt); // importance-only: no bump
    await tick();
    await t.mutation(internal.dts.internalBulkUpdate, {
      updates: [{ id, category: "chores" }],
    });
    [todo] = await tom.query(api.dts.listTodos, {});
    expect(todo.category).toBe("chores");
    expect(todo.updatedAt).toBeGreaterThan(before.updatedAt); // content: bump
    await expect(
      t.mutation(internal.dts.internalBulkUpdate, {
        updates: [{ id: "not-a-real-id", category: "x" }],
      }),
    ).rejects.toThrow(/Unknown todo id/);
  });

  it("preparer importance/plan defer to Tom's overrides", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await t.mutation(internal.dts.internalCapture, {
      statement: "captured",
      source: "slack-capture",
    });
    const [captured] = await t.run(async (ctx) =>
      ctx.db.query("dtsTodos").collect(),
    );
    await tom.mutation(api.dts.setImportance, {
      id: captured._id,
      level: "high",
    });
    const step = { text: "look it up", actor: "agent" as const, status: "open" as const };
    // tomTouchedAt is set but there is no plan yet: the plan writes, the
    // agent importance is ignored (Tom already ruled).
    await t.mutation(internal.dts.internalPrepareTodo, {
      id: captured._id,
      importanceLevel: "low",
      importanceRationale: "agent guess",
      plan: [step],
    });
    let [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.importance).toMatchObject({ level: "high", setBy: "tom" });
    expect(todo.plan).toHaveLength(1);
    // Now a plan exists on a Tom-touched row — a re-prepare must not clobber it.
    await t.mutation(internal.dts.internalPrepareTodo, {
      id: captured._id,
      plan: [step, { ...step, text: "second draft" }],
    });
    [todo] = await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
    expect(todo.plan).toHaveLength(1);
    const events = await tom.query(api.dts.listRecentEvents, {});
    expect(events.some((e) => e.kind === "importance-skipped")).toBe(true);
    expect(events.some((e) => e.kind === "plan-skipped")).toBe(true);
  });

  // witness: drop the one-live-batch collect from updateTodo's members branch
  // in convex/dts.ts
  it("updateTodo members enforce one live batch per subject and stamp the touch", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const a = await tom.mutation(api.dts.createTodo, { statement: "member a" });
    const x = await tom.mutation(api.dts.createTodo, { statement: "batch x" });
    await tom.mutation(api.dts.updateTodo, { id: x, members: [{ todoId: a }] });
    const todos = await tom.query(api.dts.listTodos, {});
    const batch = todos.find((t2) => t2._id === x);
    expect(batch?.members).toHaveLength(1);
    expect(batch?.tomTouchedAt).toBeDefined();
    const y = await tom.mutation(api.dts.createTodo, { statement: "batch y" });
    await expect(
      tom.mutation(api.dts.updateTodo, { id: y, members: [{ todoId: a }] }),
    ).rejects.toThrow(/already in batch "batch x"/);
  });

  // witness: drop the members === undefined filter from
  // internalPrepareFallbackQueue in convex/dts.ts
  it("fallback prep never queues a members-bearing row", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const solo = await tom.mutation(api.dts.createTodo, { statement: "solo" });
    await storeBatch(t);
    const batch = await findBatch(t);
    await t.mutation(internal.dts.internalPrepareFallbackQueue, { force: true });
    const [queue] = await t.run(async (ctx) =>
      ctx.db.query("dtsDailyQueues").collect(),
    );
    expect(queue.entries.some((e) => e.todoId === solo)).toBe(true);
    expect(queue.entries.some((e) => e.todoId === batch?._id)).toBe(false);
  });
});
