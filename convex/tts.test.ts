import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
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
  // hand-roll start + 86_400_000) — the digest's day would cover the wrong
  // 24 hours.
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

  it("creates and lists a todo", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "  email Ana Maria  ",
      dueAt: Date.now() + 86_400_000,
    });
    const todos = await tom.query(api.tts.listTodos, {});
    expect(todos).toHaveLength(1);
    expect(todos[0]._id).toBe(id);
    expect(todos[0].statement).toBe("email Ana Maria");
    expect(todos[0].timingClass).toBe("dated"); // dueAt implies dated
    expect(todos[0].dateKind).toBe("self-imposed");
    expect(todos[0].readiness).toBe("unprepared");
    expect(todos[0].status).toBe("active");
    const events = await t.run((ctx) => ctx.db.query("dtsEvents").collect());
    expect(events.some((e) => e.kind === "created" && e.todoId === todos[0]._id)).toBe(true);
  });

  it("promotes whenever to dated when triage sets a date (spec §5.2)", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "clean room" });
    await t.mutation(internal.tts.internalTriage, {
      id,
      dueAt: Date.now() + 86_400_000,
    });
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
    await t.mutation(internal.tts.internalTriage, { id, status: "done" });
    const [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.status).toBe("done");
    expect(todo.doneAt).toBeDefined();
    expect(todo.dateOutcomes?.[0].outcome).toBe("done");
  });

  it("clears terminal facts on reopen", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "dated thing",
      dueAt: Date.now() + 86_400_000,
    });
    // Archive with an unarchive condition, then reactivate: the stale
    // terminal facts must not linger on the live item.
    await t.mutation(internal.tts.internalTriage, {
      id,
      status: "archived",
      unarchiveCondition: "when Ana replies",
    });
    await t.mutation(internal.tts.internalTriage, { id, status: "active" });
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
    const todos = await t.run(async (ctx) => ctx.db.query("todos").collect());
    expect(todos).toHaveLength(1);
    expect(todos[0].readiness).toBe("unprepared");
    expect(todos[0].source).toBe("slack-capture");
  });

  // ── Slack capture is idempotent on the message ts (Tom, 2026-08-30) ───────
  // Legacy callers may still retry a capture carrying Slack coordinates.
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
    const todos = await t.run(async (ctx) => ctx.db.query("todos").collect());
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
    const after = await t.run(async (ctx) => ctx.db.query("todos").collect());
    expect(after).toHaveLength(3);
  });

  it("returns the stored todo unchanged on a retry", async () => {
    const t = convexTest({ schema, modules });
    const threadMessageId = "evt_retry_todo";
    const dueAt = Date.now() + 86_400_000;
    const first = await t.mutation(internal.tts.internalCapture, {
      statement: "file the form",
      source: "thread",
      threadMessageId,
      dueAt,
      dateKind: "external",
    });
    const second = await t.mutation(internal.tts.internalCapture, {
      statement: "file the form later",
      source: "thread",
      threadMessageId,
      dueAt: dueAt + 86_400_000,
      dateKind: "self-imposed",
    });
    expect(second).toBe(first);
    const stored = await t.run((ctx) => ctx.db.query("todos").withIndex("by_threadMessageId", (q) => q.eq("threadMessageId", threadMessageId)).first());
    expect(stored).toMatchObject({ dueAt, dateKind: "external" });
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
      ctx.db.query("todos").collect(),
    );
    await t.mutation(internal.tts.internalPrepareTodo, {
      id: captured._id,
      brief: "Tape for finger protection.",
      entryAction: "Open the retailer page",
      workDescription: "a two-minute errand",
      readiness: "prepared",
    });
    const [todo] = await t.run(async (ctx) => ctx.db.query("todos").collect());
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
      ctx.db.query("todos").collect(),
    );
    const due = Date.now() + 3 * 86_400_000;
    await t.mutation(internal.tts.internalTriage, { id: captured._id, dueAt: due });
    let [todo] = await t.run(async (ctx) => ctx.db.query("todos").collect());
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
    [todo] = await t.run(async (ctx) => ctx.db.query("todos").collect());
    expect(todo.status).toBe("waiting");
    expect(todo.wakeAt).toBe(due);
  });

});

describe("TTS category", () => {
  it("createTodo/internalBulkUpdate round-trip category, null clears", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, {
      statement: "sweep the floor",
      category: "chores",
    });
    let [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.category).toBe("chores");
    await t.mutation(internal.tts.internalBulkUpdate, {
      updates: [{ id, category: "errands" }],
    });
    [todo] = await tom.query(api.tts.listTodos, {});
    expect(todo.category).toBe("errands");
    await t.mutation(internal.tts.internalBulkUpdate, {
      updates: [{ id, category: null }],
    });
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
    const events = await t.run((ctx) => ctx.db.query("dtsEvents").collect());
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
    const events = await t.run((ctx) => ctx.db.query("dtsEvents").collect());
    expect(events.some((e) => e.kind === "due-skipped")).toBe(true);
  });

  // ── The door check's mark ─────────────────────────────────────────────────
  // The planner reads its own write-up against the writing standard and
  // retries once; a write-up that fails both attempts is posted anyway and
  // carries the complaints (Tom, 2026-09-12). They ride the "prepared" event
  // this pen already logs, so no field was added to any row.

  const preparedEvents = async (t: ReturnType<typeof convexTest>) =>
    (await t.run(async (ctx) => ctx.db.query("dtsEvents").collect())).filter(
      (e) => e.kind === "prepared",
    );

  // witness: drop the doorFaults spread from internalPrepareTodo's logEvent in
  // convex/tts.ts — the mark would never reach the page, which is the silent
  // hole the check exists to close.
  it("the door mark rides the prepared event, and a clean prepare writes no key at all", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.tts.createTodo, { statement: "renew the visa" });
    const fault = "brief: brief-markup — a brief is prose — no heading, list, or code fence";
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      brief: "# Renewal\nIt expires. Renew it.",
      readiness: "prepared",
      doorFaults: [fault],
    });
    const refused = await preparedEvents(t);
    expect(refused).toHaveLength(1);
    expect((refused[0].data as { doorFaults?: string[] }).doorFaults).toEqual([fault]);
    // The re-prep that passed sends no key, so the newest "prepared" row says
    // "clean" by itself and there is nothing to clear on the old one.
    await t.mutation(internal.tts.internalPrepareTodo, {
      id,
      brief: "It expires in October. Renewing it needs a photo.",
      readiness: "prepared",
    });
    const both = await preparedEvents(t);
    expect(both).toHaveLength(2);
    expect(Object.keys(both[1].data as object)).not.toContain("doorFaults");
  });

});
