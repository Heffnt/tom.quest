import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { dayLogResultLine } from "./dayLog";
import schema from "./schema";
import { nyCalendarDayKey, weekdayWordOf } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const DAY_MS = 86_400_000;
const KEY = { "X-TTS-Key": "test-key", "Content-Type": "application/json" };

async function tom(t: ReturnType<typeof convexTest>) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
  return t.withIdentity({ subject: id });
}

async function pendingEntry(t: ReturnType<typeof convexTest>, text = "weighed 180.0 this morning") {
  const viewer = await tom(t);
  const { id } = await viewer.mutation(api.dayLog.submit, { text });
  const entry = await t.run((ctx) => ctx.db.get(id));
  if (!entry) throw new Error("test entry was not stored");
  return { id, entry, viewer };
}

function weight(day: string, quote = "weighed 180.0 this morning") {
  return {
    kind: "measurement",
    day,
    quote,
    summary: "weight",
    metric: "weight",
    value: 180.0,
    unit: "lb",
    partOfDay: "morning",
  };
}

describe("day log", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("denies submit to a non-Tom user and stores typed text exactly", async () => {
    const t = convexTest({ schema, modules });
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    await expect(t.withIdentity({ subject: userId }).mutation(api.dayLog.submit, { text: "weighed 180.0 this morning" })).rejects.toThrow("Log access is restricted to Tom");

    const text = "  weighed 180.0 this morning\n";
    const { id } = await pendingEntry(t, text);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ text, status: "pending" });
    const events = await t.run((ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", "day-log")).collect());
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ entryId: id });
  });

  it("returns the pending worker shape with verbatim text and vocabulary", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "test-key");
    const t = convexTest({ schema, modules });
    const { id, entry } = await pendingEntry(t, "weighed 180.0 this morning");
    const response = await t.fetch("/tts/day-log/pending", { method: "POST", headers: KEY, body: "{}" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      now: expect.any(Number),
      vocabulary: { metrics: { weight: { unit: "lb", min: 60, max: 600 } }, bounds: { maxItems: 20 } },
      entries: [{ id, text: entry.text, createdAt: entry.createdAt, day: entry.day, time: expect.stringMatching(/^[0-9]+:[0-9]{2} [ap]\.m\.$/) }],
    });
  });

  it("applies a valid measurement and writes its item", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "test-key");
    const t = convexTest({ schema, modules });
    const { id, entry } = await pendingEntry(t);
    const response = await t.fetch("/tts/day-log/apply", {
      method: "POST",
      headers: KEY,
      body: JSON.stringify({
      id,
      status: "applied",
      items: [weight(entry.day)],
      actions: [],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: 1, result: "Jarvis recorded your weight, 180.0 lb." });
    const rows = await t.run(async (ctx) => ({ entry: await ctx.db.get(id), items: await ctx.db.query("dayLogItems").withIndex("by_entry", (q) => q.eq("entryId", id)).collect() }));
    expect(rows.entry).toMatchObject({ status: "applied", result: "Jarvis recorded your weight, 180.0 lb." });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject(weight(entry.day));
  });

  it.each([
    ["a non-substring quote", (day: string) => ({ ...weight(day, "not in the entry") })],
    ["an out-of-range value", (day: string) => ({ ...weight(day), value: 601 })],
    ["a wrong unit", (day: string) => ({ ...weight(day), unit: "kg" })],
    ["an unknown metric", (day: string) => ({ ...weight(day), metric: "unknown" })],
    ["a day outside the entry window", (day: string) => ({ ...weight(new Date(Date.parse(day) - 8 * DAY_MS).toISOString().slice(0, 10)) })],
  ])("rejects %s without changing the entry", async (_name, invalid) => {
    const t = convexTest({ schema, modules });
    const { id, entry } = await pendingEntry(t);
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, { id, status: "applied", items: [invalid(entry.day)], actions: [] })).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "pending" });
  });

  it("rejects more than twenty items, actions, and warnings", async () => {
    const t = convexTest({ schema, modules });
    const tooMany = await pendingEntry(t);
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: tooMany.id,
      status: "applied",
      items: Array.from({ length: 21 }, () => weight(tooMany.entry.day)),
      actions: [],
    })).rejects.toThrow("at most 20 items");

    const actions = await pendingEntry(t);
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: actions.id,
      status: "applied",
      items: [],
      actions: [{ kind: "todo-done" }],
    })).rejects.toThrow("actions not yet supported");

    const warning = await pendingEntry(t);
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: warning.id,
      status: "applied",
      items: [],
      actions: [],
      warning: {},
    })).rejects.toThrow("warnings not yet supported");
  });

  it("makes a repeat apply idempotent", async () => {
    const t = convexTest({ schema, modules });
    const { id, entry } = await pendingEntry(t);
    await t.mutation(internal.dayLog.internalApplyDayLog, { id, status: "applied", items: [weight(entry.day)], actions: [] });
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, { id, status: "applied", items: [weight(entry.day)], actions: [] })).resolves.toEqual({ ok: true, already: true });
    expect(await t.run((ctx) => ctx.db.query("dayLogItems").withIndex("by_entry", (q) => q.eq("entryId", id)).collect())).toHaveLength(1);
  });

  it("keeps an unreadable entry as needs-session", async () => {
    const t = convexTest({ schema, modules });
    const { id } = await pendingEntry(t, "wrote a note");
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id,
      status: "needs-session",
      items: [],
      actions: [],
      failure: "parse",
      detail: "response was not structured",
    })).resolves.toMatchObject({ ok: true, result: "Jarvis could not read this entry; it stays here and still goes to nightly learning." });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "needs-session" });
  });

  it("returns today's published training day only when both source files exist", async () => {
    const t = convexTest({ schema, modules });
    const readerId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    await expect(t.withIdentity({ subject: readerId }).query(api.dayLog.trainingDay, {})).rejects.toThrow("Log access is restricted to Tom");

    const viewer = await tom(t);
    await expect(viewer.query(api.dayLog.trainingDay, {})).resolves.toBeNull();

    const today = weekdayWordOf(nyCalendarDayKey(Date.now()));
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomFiles", {
        name: "schedule",
        body: `## Training week — test\n| Day | Block |\n| --- | --- |\n| Sunday | sunday plan |\n| Monday | monday plan |\n| Tuesday | tuesday plan |\n| Wednesday | wednesday plan |\n| Thursday | thursday plan |\n| Friday | friday plan |\n| Saturday | saturday plan |`,
        sourcePath: "model-of-tom/schedule.md",
        syncedAt: 1,
      });
    });
    await expect(viewer.query(api.dayLog.trainingDay, {})).resolves.toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomFiles", {
        name: "areas/health-and-food",
        body: `## Session ideas\n- Marker (${today}): inspect the outline.`,
        sourcePath: "model-of-tom/areas/health-and-food.md",
        syncedAt: 1,
      });
    });

    await expect(viewer.query(api.dayLog.trainingDay, {})).resolves.toEqual({
      cells: [{ column: "Block", text: `${today} plan` }],
      notes: [],
      ideas: [{ label: "Marker", text: "inspect the outline." }],
    });
  });

  it("returns active measurements and runs in the chart series shape", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T16:00:00.000Z"));
    const t = convexTest({ schema, modules });
    const { id, entry, viewer } = await pendingEntry(t, "recorded values and a run");
    const now = Date.now();
    const measurements = [
      ["weight", 180, "lb"],
      ["waist", 31, "in"],
      ["pullup_added_weight", 25, "lb"],
      ["hang_20mm", 20, "s"],
      ["sprint_40yd", 7, "s"],
      ["loop_1_4mi", 480, "s"],
    ] as const;
    await t.run(async (ctx) => {
      for (const [metric, value, unit] of measurements) {
        await ctx.db.insert("dayLogItems", {
          entryId: id,
          day: entry.day,
          kind: "measurement",
          quote: "recorded values",
          summary: metric,
          metric,
          value,
          unit,
          partOfDay: "morning",
          createdAt: now,
        });
      }
      await ctx.db.insert("dayLogItems", {
        entryId: id,
        day: "2025-09-26",
        kind: "measurement",
        quote: "recorded values",
        summary: "old weight",
        metric: "weight",
        value: 175,
        unit: "lb",
        partOfDay: "morning",
        createdAt: now,
      });
      await ctx.db.insert("dayLogItems", {
        entryId: id,
        day: entry.day,
        kind: "measurement",
        quote: "recorded values",
        summary: "reverted waist",
        metric: "waist",
        value: 35,
        unit: "in",
        partOfDay: "morning",
        createdAt: now,
        revertedAt: now,
      });
      await ctx.db.insert("dayLogItems", {
        entryId: id,
        day: entry.day,
        kind: "workout",
        quote: "a run",
        summary: "run",
        activity: "run",
        distanceMi: 3.1,
        createdAt: now,
      });
      await ctx.db.insert("dayLogItems", {
        entryId: id,
        day: entry.day,
        kind: "workout",
        quote: "a run",
        summary: "reverted run",
        activity: "run",
        distanceMi: 2,
        createdAt: now,
        revertedAt: now,
      });
      await ctx.db.insert("dayLogItems", {
        entryId: id,
        day: entry.day,
        kind: "workout",
        quote: "a run",
        summary: "walk",
        activity: "walk",
        createdAt: now,
      });
    });

    const result = await viewer.query(api.dayLog.series, {});

    expect(Object.keys(result).sort()).toEqual(["measurements", "runs"]);
    expect(result.measurements.map((item) => item.metric)).toEqual(measurements.map(([metric]) => metric));
    expect(result.measurements).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: entry.day, metric: "weight", value: 180, unit: "lb", entryCreatedAt: entry.createdAt }),
      expect.objectContaining({ day: entry.day, metric: "loop_1_4mi", value: 480, unit: "s", entryCreatedAt: entry.createdAt }),
    ]));
    expect(result.runs).toEqual([expect.objectContaining({ day: entry.day, activity: "run", distanceMi: 3.1 })]);
  });
});

describe("day log result text", () => {
  it("uses the fixed clauses for every status", () => {
    expect(dayLogResultLine("pending", [])).toBe("Jarvis has not read this yet.");
    expect(dayLogResultLine("applied", [])).toBe("Jarvis found nothing to record.");
    expect(dayLogResultLine("applied", [
      { kind: "measurement", metric: "weight", value: 180, unit: "lb" },
      { kind: "workout", activity: "run" },
    ])).toBe("Jarvis recorded your weight, 180.0 lb, and a run.");
    expect(dayLogResultLine("needs-session", [])).toBe("Jarvis could not read this entry; it stays here and still goes to nightly learning.");
  });
});
