import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { dayLogResultLine } from "./dayLog";
import schema from "./schema";
import { insertTodo, patchTodo } from "../test/core-tables";
import { nyCalendarDayKey, nyTimeUtcMs, weekdayWordOf } from "./ttsShared";

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

async function seedTodo(
  t: ReturnType<typeof convexTest>,
  statement: string,
  fields: Partial<{ status: "active" | "waiting" | "archived" | "done"; dueAt: number; dateKind: "external" | "self-imposed" }> = {},
) {
  return await t.run(async (ctx) => await insertTodo(ctx, {
    statement,
    readiness: "unprepared",
    status: fields.status ?? "active",
    timingClass: fields.dueAt === undefined ? "whenever" : "dated",
    ...(fields.dueAt === undefined ? {} : { dueAt: fields.dueAt, dateKind: fields.dateKind ?? "self-imposed" }),
    source: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

async function seedRepeat(t: ReturnType<typeof convexTest>, active: boolean) {
  return await t.run(async (ctx) => await ctx.db.insert("ttsRepeats", {
    statement: "routine work",
    daysOfWeek: ["monday"],
    active,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
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
      openRepeats: [],
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

  it("rejects more than twenty items, more than five actions, and malformed warnings", async () => {
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
      actions: Array.from({ length: 6 }, () => ({ kind: "todo-capture", statement: "new work", quote: "weighed 180.0 this morning" })),
    })).rejects.toThrow("at most 5 actions");

    const warning = await pendingEntry(t);
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: warning.id,
      status: "applied",
      items: [],
      actions: [],
      warning: {},
    })).rejects.toThrow("warning class is unknown");
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

  it("applies bounded todo and repeat actions and records their before and after values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
    const t = convexTest({ schema, modules });
    const done = await seedTodo(t, "first task");
    const archived = await seedTodo(t, "second task");
    const moved = await seedTodo(t, "third task", { dueAt: nyTimeUtcMs("2026-10-01", 12) });
    const repeatOff = await seedRepeat(t, true);
    const { id } = await pendingEntry(t, "Finish first task today. Archive second task today. Move third task tomorrow. Add fourth task today. Pause routine work now.");

    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id,
      status: "applied",
      items: [],
      actions: [
        { kind: "todo-done", todoId: done, quote: "Finish first task today." },
        { kind: "todo-archive", todoId: archived, quote: "Archive second task today." },
        { kind: "todo-move", todoId: moved, due: "2026-09-29", quote: "Move third task tomorrow." },
        { kind: "todo-capture", statement: "fourth task", quote: "Add fourth task today." },
        { kind: "repeat-off", repeatId: repeatOff, quote: "Pause routine work now." },
      ],
    })).resolves.toMatchObject({ ok: true, applied: 5 });

    const rows = await t.run(async (ctx) => ({
      done: await ctx.db.get(done),
      archived: await ctx.db.get(archived),
      moved: await ctx.db.get(moved),
      repeat: await ctx.db.get(repeatOff),
      actions: await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", id)).collect(),
    }));
    expect(rows.done).toMatchObject({ status: "done" });
    expect(rows.archived).toMatchObject({ status: "archived" });
    expect(rows.moved).toMatchObject({ dueAt: nyTimeUtcMs("2026-09-29", 12) });
    expect(rows.repeat).toMatchObject({ active: false });
    expect(rows.actions).toHaveLength(5);
    expect(rows.actions.every((action) => action.before !== undefined && action.after !== undefined && action.quote.endsWith("."))).toBe(true);
    expect(rows.actions.find((action) => action.kind === "todo-capture")).toMatchObject({ statement: "fourth task", before: {}, after: { status: "active" } });

    const repeatOn = await seedRepeat(t, false);
    const restart = await pendingEntry(t, "Restart routine work now.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: restart.id,
      status: "applied",
      items: [],
      actions: [{ kind: "repeat-on", repeatId: repeatOn, quote: "Restart routine work now." }],
    });
    expect(await t.run((ctx) => ctx.db.get(repeatOn))).toMatchObject({ active: true });
  });

  it("rejects every invalid action before changing a pending entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
    const t = convexTest({ schema, modules });
    const active = await seedTodo(t, "active task", { dueAt: nyTimeUtcMs("2026-10-01", 12) });
    const done = await seedTodo(t, "finished task", { status: "done" });
    const inactive = await seedRepeat(t, false);
    const reject = async (text: string, actions: unknown[]) => {
      const entry = await pendingEntry(t, text);
      await expect(t.mutation(internal.dayLog.internalApplyDayLog, { id: entry.id, status: "applied", items: [], actions })).rejects.toThrow();
      expect(await t.run((ctx) => ctx.db.get(entry.id))).toMatchObject({ status: "pending" });
    };

    await reject("Finish active task today.", [{ kind: "todo-done", todoId: "bad-id", quote: "Finish active task today." }]);
    await reject("Finish finished task today.", [{ kind: "todo-done", todoId: done, quote: "Finish finished task today." }]);
    await reject("Move active task later.", [{ kind: "todo-move", todoId: active, due: "2027-10-01", quote: "Move active task later." }]);
    await reject("Finish active task today. Archive active task today.", [
      { kind: "todo-done", todoId: active, quote: "Finish active task today." },
      { kind: "todo-archive", todoId: active, quote: "Archive active task today." },
    ]);
    await reject("Add short work today.", [{ kind: "todo-capture", statement: "x", quote: "Add short work today." }]);
    await reject("Finish active task today.", [{ kind: "todo-done", todoId: active, quote: "Finish active" }]);
    await reject("Pause routine work now.", [{ kind: "repeat-off", repeatId: inactive, quote: "Pause routine work now." }]);
  });

  it("undoes actions only while their saved after values still match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
    const t = convexTest({ schema, modules });
    const todo = await seedTodo(t, "first task");
    const captured = await pendingEntry(t, "Finish first task today.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: captured.id,
      status: "applied",
      items: [],
      actions: [{ kind: "todo-done", todoId: todo, quote: "Finish first task today." }],
    });
    const doneAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", captured.id)).unique());
    if (!doneAction) throw new Error("action was not stored");
    await captured.viewer.mutation(api.dayLog.undoAction, { id: doneAction._id });
    expect(await t.run((ctx) => ctx.db.get(todo))).toMatchObject({ status: "active", doneAt: undefined });

    const archiveTodo = await seedTodo(t, "second task");
    const archive = await pendingEntry(t, "Archive second task today.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: archive.id,
      status: "applied",
      items: [],
      actions: [{ kind: "todo-archive", todoId: archiveTodo, quote: "Archive second task today." }],
    });
    const archiveAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", archive.id)).unique());
    if (!archiveAction) throw new Error("archive action was not stored");
    await archive.viewer.mutation(api.dayLog.undoAction, { id: archiveAction._id });
    expect(await t.run((ctx) => ctx.db.get(archiveTodo))).toMatchObject({ status: "active", archivedAt: undefined });

    const moveTodo = await seedTodo(t, "third task", { dueAt: nyTimeUtcMs("2026-10-01", 12) });
    const move = await pendingEntry(t, "Move third task tomorrow.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: move.id,
      status: "applied",
      items: [],
      actions: [{ kind: "todo-move", todoId: moveTodo, due: "2026-09-29", quote: "Move third task tomorrow." }],
    });
    const moveAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", move.id)).unique());
    if (!moveAction) throw new Error("move action was not stored");
    await move.viewer.mutation(api.dayLog.undoAction, { id: moveAction._id });
    expect(await t.run((ctx) => ctx.db.get(moveTodo))).toMatchObject({ dueAt: nyTimeUtcMs("2026-10-01", 12), dateOutcomes: undefined });

    const pausedRepeat = await seedRepeat(t, true);
    const pause = await pendingEntry(t, "Pause routine work now.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: pause.id,
      status: "applied",
      items: [],
      actions: [{ kind: "repeat-off", repeatId: pausedRepeat, quote: "Pause routine work now." }],
    });
    const pauseAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", pause.id)).unique());
    if (!pauseAction) throw new Error("pause action was not stored");
    await pause.viewer.mutation(api.dayLog.undoAction, { id: pauseAction._id });
    expect(await t.run((ctx) => ctx.db.get(pausedRepeat))).toMatchObject({ active: true });

    const restartedRepeat = await seedRepeat(t, false);
    const restart = await pendingEntry(t, "Restart routine work now.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: restart.id,
      status: "applied",
      items: [],
      actions: [{ kind: "repeat-on", repeatId: restartedRepeat, quote: "Restart routine work now." }],
    });
    const restartAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", restart.id)).unique());
    if (!restartAction) throw new Error("restart action was not stored");
    await restart.viewer.mutation(api.dayLog.undoAction, { id: restartAction._id });
    expect(await t.run((ctx) => ctx.db.get(restartedRepeat))).toMatchObject({ active: false });

    const capture = await pendingEntry(t, "Add a fresh task today.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: capture.id,
      status: "applied",
      items: [],
      actions: [{ kind: "todo-capture", statement: "fresh task", quote: "Add a fresh task today." }],
    });
    const captureAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", capture.id)).unique());
    if (!captureAction?.todoId) throw new Error("capture action was not stored");
    await capture.viewer.mutation(api.dayLog.undoAction, { id: captureAction._id });
    expect(await t.run((ctx) => ctx.db.get(captureAction.todoId!))).toMatchObject({ status: "archived" });

    const later = await pendingEntry(t, "Finish first task today.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: later.id,
      status: "applied",
      items: [],
      actions: [{ kind: "todo-done", todoId: todo, quote: "Finish first task today." }],
    });
    const laterAction = await t.run(async (ctx) => await ctx.db.query("dayLogActions").withIndex("by_entry", (q) => q.eq("entryId", later.id)).unique());
    if (!laterAction) throw new Error("later action was not stored");
    await t.run(async (ctx) => await patchTodo(ctx, todo, { status: "waiting", wakeAt: Date.now() + 60_000, updatedAt: Date.now() + 60_000 }));
    await expect(later.viewer.mutation(api.dayLog.undoAction, { id: laterAction._id })).rejects.toThrow("This has changed since Jarvis touched it; change it on /tts instead.");
  });

  it("keeps an undone item out of series data", async () => {
    const t = convexTest({ schema, modules });
    const { viewer, id, entry } = await pendingEntry(t);
    await t.mutation(internal.dayLog.internalApplyDayLog, { id, status: "applied", items: [weight(entry.day)], actions: [] });
    const item = await t.run(async (ctx) => await ctx.db.query("dayLogItems").withIndex("by_entry", (q) => q.eq("entryId", id)).unique());
    if (!item) throw new Error("item was not stored");
    await viewer.mutation(api.dayLog.undoItem, { id: item._id });
    expect(await viewer.query(api.dayLog.series, {})).toEqual({ measurements: [], runs: [] });
    expect((await viewer.query(api.dayLog.page, {}))[0]?.items[0]).toMatchObject({ _id: item._id, revertedAt: expect.any(Number) });
  });

  it("captures and opens one warning marker, then rejects invalid warnings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T13:00:00Z"));
    const t = convexTest({ schema, modules });
    const entry = await pendingEntry(t, "A neutral signal appears.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: entry.id,
      status: "applied",
      items: [],
      actions: [],
      warning: { class: "fainting", quote: "neutral signal", source: "model" },
    });
    const first = await t.run(async (ctx) => ({
      entry: await ctx.db.get(entry.id),
      todos: await ctx.db.query("todos").withIndex("by_source", (q) => q.eq("source", "day-log")).collect(),
      markers: await ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", "needs-tom").eq("key", `day-log:${entry.id}`)).collect(),
      opened: (await ctx.db.query("events").collect()).filter((row) => row.kind === "needs-you-opened"),
    }));
    expect(first.entry?.warning?.todoId).toBe(first.todos[0]?._id);
    expect(first.todos).toHaveLength(1);
    expect(first.markers).toHaveLength(1);
    expect(first.opened).toHaveLength(1);
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: entry.id,
      status: "applied",
      items: [],
      actions: [],
      warning: { class: "fainting", quote: "neutral signal", source: "model" },
    })).resolves.toEqual({ ok: true, already: true });

    const unreadable = await pendingEntry(t, "A second neutral signal appears.");
    await t.mutation(internal.dayLog.internalApplyDayLog, {
      id: unreadable.id,
      status: "needs-session",
      items: [],
      actions: [],
      failure: "model",
      warning: { class: "fainting", quote: "neutral signal", source: "phrase-check" },
    });
    expect(await t.run((ctx) => ctx.db.get(unreadable.id))).toMatchObject({ status: "needs-session", warning: { source: "phrase-check" } });

    const noQuote = await pendingEntry(t, "A neutral signal appears.");
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: noQuote.id,
      status: "applied",
      items: [],
      actions: [],
      warning: { class: "fainting", quote: "absent", source: "model" },
    })).rejects.toThrow("warning quote must be a verbatim substring");
    const unknown = await pendingEntry(t, "A neutral signal appears.");
    await expect(t.mutation(internal.dayLog.internalApplyDayLog, {
      id: unknown.id,
      status: "applied",
      items: [],
      actions: [],
      warning: { class: "unknown", quote: "neutral signal", source: "model" },
    })).rejects.toThrow("warning class is unknown");
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
    expect(dayLogResultLine("applied", [], [
      { kind: "todo-done", statement: "first task" },
      { kind: "todo-archive", statement: "second task" },
      { kind: "todo-move", statement: "third task", due: "2026-10-02" },
      { kind: "todo-capture", statement: "fourth task" },
      { kind: "repeat-off", statement: "routine work" },
      { kind: "repeat-on", statement: "routine work" },
    ])).toBe('Jarvis marked "first task" done. Jarvis archived "second task". Jarvis moved "third task" to Oct 2. Jarvis added "fourth task" to your todos. Jarvis paused the repeat "routine work". Jarvis restarted the repeat "routine work".');
    expect(dayLogResultLine("applied", [], [{ kind: "todo-done", statement: "x".repeat(61) }])).toBe(`Jarvis marked "${"x".repeat(59)}…" done.`);
    expect(dayLogResultLine("needs-session", [])).toBe("Jarvis could not read this entry; it stays here and still goes to nightly learning.");
  });
});
