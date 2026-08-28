import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
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
