import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import { repeatProvenance } from "./ttsRepeats";
import { nyCalendarDayBoundsUtc, nyLocalHour, weekdayWordOf } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// Every expectation is pinned to an explicit UTC instant: CI runs in UTC and
// the dev machine in US Eastern, and the whole point of these assertions is
// the NY wall-clock -> UTC conversion, which a floating local timezone would
// hide. 2026-09-07 is a Monday in EDT (UTC-4).
const DAY = "2026-09-07";
const NOON_NY = Date.UTC(2026, 8, 7, 16); // 12:00 EDT
const EVENING_NY = Date.UTC(2026, 8, 7, 22, 30); // 18:30 EDT

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

async function events(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === kind),
  );
}

async function repeatingTodos(
  t: ReturnType<typeof convexTest>,
): Promise<Doc<"dtsTodos">[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsTodos").collect()).filter(
      (todo) => todo.source === "repeating",
    ),
  );
}

/** Seed a calendar mirror row inside the NY calendar day the generator reads. */
async function seedCalendarEvent(
  t: ReturnType<typeof convexTest>,
  title: string,
) {
  const bounds = nyCalendarDayBoundsUtc(DAY);
  await t.run(async (ctx) =>
    ctx.db.insert("ttsCalendarEvents", {
      feed: "google",
      uid: "practice-1",
      title,
      start: bounds.start + 18 * 3_600_000, // 18:00 EDT
      end: bounds.start + 20 * 3_600_000,
      allDay: false,
      syncedAt: Date.now(),
    }),
  );
}

describe("ttsRepeats CRUD", () => {
  it("gates the Tom-facing doors on the tom role", async () => {
    const t = convexTest({ schema, modules });
    await expect(
      t.mutation(api.ttsRepeats.createRepeat, {
        statement: "core work",
        daysOfWeek: ["monday"],
      }),
    ).rejects.toThrow();
    await expect(t.query(api.ttsRepeats.listRepeats, {})).rejects.toThrow();
  });

  it("rejects a rule with no weekdays", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.ttsRepeats.createRepeat, {
        statement: "core work",
        daysOfWeek: [],
      }),
    ).rejects.toThrow(/at least one weekday/);
  });

  it("rejects a timeOfDay that is not 24h HH:MM", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await expect(
      tom.mutation(api.ttsRepeats.createRepeat, {
        statement: "core work",
        daysOfWeek: ["monday"],
        timeOfDay: "25:00",
      }),
    ).rejects.toThrow(/HH:MM/);
  });

  it("creates a rule, stores it active, and logs repeat-created", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "  core + antagonist training  ",
      daysOfWeek: ["monday", "friday"],
      timeOfDay: "18:30",
    });
    expect(id).toBeTruthy();

    const rule = await t.run(async (ctx) => ctx.db.get(id));
    expect(rule?.statement).toBe("core + antagonist training"); // trimmed on write
    expect(rule?.active).toBe(true);
    expect(rule?.daysOfWeek).toEqual(["monday", "friday"]);

    const created = await events(t, "repeat-created");
    expect(created).toHaveLength(1);
    expect(created[0].data).toMatchObject({
      repeatId: id,
      statement: "core + antagonist training",
      daysOfWeek: ["monday", "friday"],
    });

    const listed = await tom.query(api.ttsRepeats.listRepeats, {});
    expect(listed.map((r) => r._id)).toEqual([id]);
  });

  it("deletes a rule and logs repeat-deleted carrying the rule", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "core + antagonist training",
      daysOfWeek: ["monday"],
      timeOfDay: "18:30",
    });
    await tom.mutation(api.ttsRepeats.deleteRepeat, { id });

    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
    const deleted = await events(t, "repeat-deleted");
    expect(deleted).toHaveLength(1);
    const rule = (deleted[0].data as { rule: Doc<"ttsRepeats"> }).rule;
    expect(rule._id).toBe(id);
    expect(rule.statement).toBe("core + antagonist training");
    expect(rule.timeOfDay).toBe("18:30");

    await expect(
      tom.mutation(api.ttsRepeats.deleteRepeat, { id }),
    ).rejects.toThrow(/not found/);
  });
});

describe("internalGenerateRepeats", () => {
  // The day key's weekday is what the generator matches rules against; if this
  // drifts every expectation below is testing the wrong branch.
  it("reads 2026-09-07 as a monday", () => {
    expect(weekdayWordOf(DAY)).toBe("monday");
  });

  it("mints one dated, self-imposed instance at the rule's NY time", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const ruleId = await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "core + antagonist training",
      daysOfWeek: ["monday", "friday"],
      timeOfDay: "18:30",
      category: "training",
      entryAction: "put the shoes on",
      workDescription: "an hour on the board",
      groundUpExplanation: "why this exists",
      body: "the session plan",
    });

    const result = await t.mutation(internal.ttsRepeats.internalGenerateRepeats, {
      force: true,
      day: DAY,
    });
    expect(result).toEqual({ day: DAY, created: 1 });

    const minted = await repeatingTodos(t);
    expect(minted).toHaveLength(1);
    const todo = minted[0];
    expect(todo.statement).toBe("core + antagonist training");
    expect(todo.source).toBe("repeating");
    expect(todo.provenance).toBe(`repeat:${ruleId}:${DAY}`);
    expect(todo.provenance).toBe(repeatProvenance(ruleId, DAY));
    expect(todo.timingClass).toBe("dated");
    expect(todo.dateKind).toBe("self-imposed");
    expect(todo.readiness).toBe("ready-for-tom");
    expect(todo.status).toBe("active");
    expect(todo.kind).toBe("task");
    expect(todo.actor).toBe("tom");
    expect(todo.dueAt).toBe(EVENING_NY); // 18:30 EDT
    // The rule's carried fields land on the instance verbatim.
    expect(todo.category).toBe("training");
    expect(todo.entryAction).toBe("put the shoes on");
    expect(todo.workDescription).toBe("an hour on the board");
    expect(todo.groundUpExplanation).toBe("why this exists");
    expect(todo.body).toBe("the session plan");

    const created = await events(t, "created");
    expect(created).toHaveLength(1);
    expect(created[0].todoId).toBe(todo._id);
    expect(created[0].data).toMatchObject({
      source: "repeating",
      repeatId: ruleId,
      day: DAY,
    });
  });

  it("defaults a timeless rule to noon New York", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "read something",
      daysOfWeek: ["monday"],
    });
    await t.mutation(internal.ttsRepeats.internalGenerateRepeats, {
      force: true,
      day: DAY,
    });
    const minted = await repeatingTodos(t);
    expect(minted).toHaveLength(1);
    expect(minted[0].dueAt).toBe(NOON_NY); // 12:00 EDT
  });

  it("mints nothing for a rule whose weekdays exclude the day", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "tuesday only",
      daysOfWeek: ["tuesday"],
      timeOfDay: "18:30",
    });
    const result = await t.mutation(
      internal.ttsRepeats.internalGenerateRepeats,
      { force: true, day: DAY },
    );
    // No rule matches the weekday: the generator short-circuits, still
    // naming the day it considered.
    expect(result).toEqual({ day: DAY, created: 0 });
    expect(await repeatingTodos(t)).toHaveLength(0);
  });

  it("is idempotent — a second run for the same day mints no duplicate", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "core + antagonist training",
      daysOfWeek: ["monday"],
      timeOfDay: "18:30",
    });
    const first = await t.mutation(internal.ttsRepeats.internalGenerateRepeats, {
      force: true,
      day: DAY,
    });
    const second = await t.mutation(
      internal.ttsRepeats.internalGenerateRepeats,
      { force: true, day: DAY },
    );
    expect(first).toEqual({ day: DAY, created: 1 });
    expect(second).toEqual({ day: DAY, created: 0 });
    expect(await repeatingTodos(t)).toHaveLength(1);
    // The idempotence key is per-day, so the NEXT monday still mints.
    const next = await t.mutation(internal.ttsRepeats.internalGenerateRepeats, {
      force: true,
      day: "2026-09-14",
    });
    expect(next).toEqual({ day: "2026-09-14", created: 1 });
    expect(await repeatingTodos(t)).toHaveLength(2);
  });

  it("mints nothing for a paused rule", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const id = await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "core + antagonist training",
      daysOfWeek: ["monday"],
      timeOfDay: "18:30",
    });
    await tom.mutation(api.ttsRepeats.updateRepeat, { id, active: false });
    expect(await t.run(async (ctx) => (await ctx.db.get(id))?.active)).toBe(
      false,
    );

    const result = await t.mutation(
      internal.ttsRepeats.internalGenerateRepeats,
      { force: true, day: DAY },
    );
    // Paused rules are filtered out with the weekday mismatch, so the run
    // reports the same empty result.
    expect(result).toEqual({ day: DAY, created: 0 });
    expect(await repeatingTodos(t)).toHaveLength(0);

    // Un-pausing brings the rule back without any other change.
    await tom.mutation(api.ttsRepeats.updateRepeat, { id, active: true });
    await t.mutation(internal.ttsRepeats.internalGenerateRepeats, {
      force: true,
      day: DAY,
    });
    expect(await repeatingTodos(t)).toHaveLength(1);
  });

  it("skips a rule whose calendar-needle matches an event that day", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await seedCalendarEvent(t, "Climbing Team Practice");
    const skippedId = await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "train outside of practice",
      daysOfWeek: ["monday"],
      timeOfDay: "18:30",
      skipWhenCalendarHas: "practice", // case-insensitive substring
    });
    const mintedId = await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "train unless there is a lesson",
      daysOfWeek: ["monday"],
      timeOfDay: "18:30",
      skipWhenCalendarHas: "lesson",
    });

    const result = await t.mutation(
      internal.ttsRepeats.internalGenerateRepeats,
      { force: true, day: DAY },
    );
    expect(result).toEqual({ day: DAY, created: 1 });

    const minted = await repeatingTodos(t);
    expect(minted).toHaveLength(1);
    expect(minted[0].provenance).toBe(repeatProvenance(mintedId, DAY));

    const skipped = await events(t, "repeat-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].data).toMatchObject({
      repeatId: skippedId,
      day: DAY,
      calendarEvent: "Climbing Team Practice",
    });
  });

  it("does not let a neighboring day's calendar event cause a skip", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    const bounds = nyCalendarDayBoundsUtc(DAY);
    await t.run(async (ctx) =>
      ctx.db.insert("ttsCalendarEvents", {
        feed: "google",
        uid: "practice-sunday",
        title: "Climbing Team Practice",
        start: bounds.start - 6 * 3_600_000, // the previous evening
        end: bounds.start - 4 * 3_600_000,
        allDay: false,
        syncedAt: Date.now(),
      }),
    );
    await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "train outside of practice",
      daysOfWeek: ["monday"],
      timeOfDay: "18:30",
      skipWhenCalendarHas: "practice",
    });
    const result = await t.mutation(
      internal.ttsRepeats.internalGenerateRepeats,
      { force: true, day: DAY },
    );
    expect(result).toEqual({ day: DAY, created: 1 });
    expect(await events(t, "repeat-skipped")).toHaveLength(0);
  });

  it("without force, runs only inside the 4 a.m. NY prep hour", async () => {
    const t = convexTest({ schema, modules });
    const tom = await withTom(t);
    await tom.mutation(api.ttsRepeats.createRepeat, {
      statement: "core + antagonist training",
      daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday",
        "saturday", "sunday"],
      timeOfDay: "18:30",
    });
    // Date.now() in the test runner is real wall time, which is almost never
    // 4 a.m. NY — so the DST guard must return before minting anything. (The
    // one-in-24 window where it would fire is covered by the forced runs.)
    if (nyLocalHour(Date.now()) !== 4) {
      const result = await t.mutation(
        internal.ttsRepeats.internalGenerateRepeats,
        { day: DAY },
      );
      // The guard's bare `return` reaches the caller as null.
      expect(result).toBeNull();
      expect(await repeatingTodos(t)).toHaveLength(0);
    }
  });

  it("internalCreateRepeat (the pen) validates like createRepeat and logs via:pen", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.ttsRepeats.internalCreateRepeat, {
        statement: "no days",
        daysOfWeek: [],
      }),
    ).rejects.toThrow(/at least one weekday/);
    const id = await t.mutation(internal.ttsRepeats.internalCreateRepeat, {
      statement: "  finger + pulling strength  ",
      daysOfWeek: ["saturday"],
      timeOfDay: "11:00",
      skipWhenCalendarHas: "climb",
    });
    const rule = await t.run(async (ctx) => ctx.db.get(id));
    expect(rule?.statement).toBe("finger + pulling strength");
    expect(rule?.active).toBe(true);
    const created = await events(t, "repeat-created");
    expect(created).toHaveLength(1);
    expect((created[0].data as { via?: string }).via).toBe("pen");
  });
});
