import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  ARCHIVE_WHOLE_MIGRATION,
  DAY_LOG_COPY_MIGRATION,
  RESTART_PROVENANCE,
  RESTART_TODOS,
  factKindOf,
} from "./ttsMigrations";

// The redesign's restart (convex/ttsMigrations.ts, 2026-10-06): the old todos
// archived whole and reversibly, the seven inserted once, and the day log's
// items copied into the events table with their kinds. These are the local
// harness the prod dry runs are read against.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const harness = () => convexTest({ schema, modules });
type T = ReturnType<typeof harness>;

async function todo(t: T, status: Doc<"todos">["status"], extra: Partial<Doc<"todos">> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("todos", {
      statement: `a ${status} todo`,
      readiness: "unprepared",
      status,
      timingClass: "whenever",
      source: "planner",
      createdAt: 1,
      updatedAt: 2,
      ...extra,
    }),
  );
}

async function seedOld(t: T) {
  return {
    active: await todo(t, "active"),
    waiting: await todo(t, "waiting"),
    done: await todo(t, "done", { doneAt: 3 }),
    archived: await todo(t, "archived", { archivedAt: 4 }),
    archivedUndated: await todo(t, "archived"),
  };
}

async function allTodos(t: T) {
  return await t.run((ctx) => ctx.db.query("todos").collect());
}

async function dtsEventsOf(t: T, kind: string) {
  return await t.run((ctx) => ctx.db.query("dtsEvents").withIndex("by_kind_at", (q) => q.eq("kind", kind)).collect());
}

describe("archive the old todos whole", () => {
  it("dry-runs the counts, archives every old row with its prior state, skips the seven, and is idempotent", async () => {
    const t = harness();
    const ids = await seedOld(t);
    await t.mutation(internal.ttsMigrations.internalAddRestartTodos, {});

    const dry = await t.mutation(internal.ttsMigrations.internalArchiveTodosWhole, { dryRun: true });
    expect(dry.done).toBe(true);
    expect(dry.totals).toMatchObject({
      scanned: 12,
      "to-archive": 5,
      "active-to-archived": 1,
      "waiting-to-archived": 1,
      "done-to-archived": 1,
      "archived-kept": 2,
      "already-archived-whole": 0,
      "restart-skipped": 7,
    });
    expect((await allTodos(t)).filter((r) => r.beforeArchive !== undefined)).toHaveLength(0);
    expect(await dtsEventsOf(t, `${ARCHIVE_WHOLE_MIGRATION}-dry-run`)).toHaveLength(1);

    const run = await t.mutation(internal.ttsMigrations.internalArchiveTodosWhole, {});
    expect(run.totals["to-archive"]).toBe(5);
    const rows = new Map((await allTodos(t)).map((r) => [r._id as string, r]));
    for (const id of Object.values(ids)) {
      const row = rows.get(id)!;
      expect(row.status).toBe("archived");
      expect(row.updatedAt).toBe(2);
    }
    expect(rows.get(ids.done)!.beforeArchive).toMatchObject({ status: "done" });
    expect(rows.get(ids.archived)!.archivedAt).toBe(4);
    expect(rows.get(ids.archived)!.beforeArchive).toMatchObject({ status: "archived", archivedAt: 4 });
    expect(rows.get(ids.active)!.archivedAt).toBe(rows.get(ids.active)!.beforeArchive!.at);
    const seven = (await allTodos(t)).filter((r) => r.provenance === RESTART_PROVENANCE);
    expect(seven.map((r) => r.status)).toEqual(Array(7).fill("active"));

    const again = await t.mutation(internal.ttsMigrations.internalArchiveTodosWhole, { dryRun: true });
    expect(again.totals).toMatchObject({ "to-archive": 0, "already-archived-whole": 5, "restart-skipped": 7 });
  });

  it("is undone by the restore walk, leaving a row changed since as it is", async () => {
    const t = harness();
    const ids = await seedOld(t);
    await t.mutation(internal.ttsMigrations.internalArchiveTodosWhole, {});
    // Someone reopened one after the archive.
    await t.run((ctx) => ctx.db.patch(ids.waiting, { status: "active" }));

    const dry = await t.mutation(internal.ttsMigrations.internalRestoreArchivedTodos, { dryRun: true });
    expect(dry.totals).toMatchObject({ restored: 4, "changed-since": 1 });
    await t.mutation(internal.ttsMigrations.internalRestoreArchivedTodos, {});
    const rows = new Map((await allTodos(t)).map((r) => [r._id as string, r]));
    expect(rows.get(ids.active)).toMatchObject({ status: "active" });
    expect(rows.get(ids.active)!.archivedAt).toBeUndefined();
    expect(rows.get(ids.active)!.beforeArchive).toBeUndefined();
    expect(rows.get(ids.done)).toMatchObject({ status: "done", doneAt: 3 });
    expect(rows.get(ids.archived)).toMatchObject({ status: "archived", archivedAt: 4 });
    expect(rows.get(ids.archivedUndated)!.archivedAt).toBeUndefined();
    expect(rows.get(ids.waiting)).toMatchObject({ status: "active" });
  });

  it("walks one page at a time and totals across pages", async () => {
    vi.useFakeTimers();
    try {
      const t = harness();
      await seedOld(t);
      const first = await t.mutation(internal.ttsMigrations.internalArchiveTodosWhole, { pageSize: 2 });
      expect(first.done).toBe(false);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await allTodos(t)).every((r) => r.status === "archived")).toBe(true);
      const [event] = await dtsEventsOf(t, `${ARCHIVE_WHOLE_MIGRATION}-migrated`);
      expect(event.data).toMatchObject({ scanned: 5, "to-archive": 5 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the seven restart todos", () => {
  it("inserts the seven once, as Tom's active tasks no agent takes, and reads them back", async () => {
    const t = harness();
    const dry = await t.mutation(internal.ttsMigrations.internalAddRestartTodos, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, toInsert: 7, inserted: [] });
    expect(await allTodos(t)).toHaveLength(0);

    const first = await t.mutation(internal.ttsMigrations.internalAddRestartTodos, {});
    expect(first.inserted).toHaveLength(7);
    const second = await t.mutation(internal.ttsMigrations.internalAddRestartTodos, {});
    expect(second).toMatchObject({ toInsert: 0, inserted: [] });
    expect(second.existing).toHaveLength(7);

    const back = await t.query(internal.ttsMigrations.internalRestartTodos, {});
    expect(back.map((r) => r.statement)).toEqual([...RESTART_TODOS]);
    expect(back.map((r) => r.statement)).toContain("email professors to ask them to be my advisor");
    for (const row of back) expect(row).toMatchObject({ status: "active", actor: "tom", readiness: "prepared" });

    // The work queue takes only actor-agent todos with an approve; none of these.
    expect(await t.query(internal.ttsRulings.internalWorkQueue, {})).toEqual([]);
  });
});

describe("the day log into the events table", () => {
  async function seedDayLog(t: T) {
    return await t.run(async (ctx) => {
      const entryId = await ctx.db.insert("dayLogEntries", {
        text: "ate oats, weighed 180, hung 20mm for 10s, climbed fingers, sore knee, wrote the paper",
        createdAt: Date.UTC(2026, 9, 5, 12),
        day: "2026-10-05",
        status: "applied",
      });
      const base = { entryId, day: "2026-10-05", createdAt: Date.UTC(2026, 9, 5, 12, 1) };
      const items: Id<"dayLogItems">[] = [];
      items.push(await ctx.db.insert("dayLogItems", { ...base, type: "food", quote: "ate oats", summary: "oats" }));
      items.push(await ctx.db.insert("dayLogItems", { ...base, type: "measurement", quote: "weighed 180", summary: "weight", metric: "weight", value: 180, unit: "lb", partOfDay: "morning" }));
      items.push(await ctx.db.insert("dayLogItems", { ...base, type: "measurement", quote: "hung 20mm for 10s", summary: "hang", metric: "hang_20mm", value: 10, unit: "s", partOfDay: "unknown" }));
      items.push(await ctx.db.insert("dayLogItems", { ...base, type: "workout", quote: "climbed fingers", summary: "climbing", activity: "climb", bodyParts: ["fingers"] }));
      items.push(await ctx.db.insert("dayLogItems", { ...base, type: "symptom", quote: "sore knee", summary: "sore knee" }));
      items.push(await ctx.db.insert("dayLogItems", { ...base, type: "work", quote: "wrote the paper", summary: "paper" }));
      return { entryId, items };
    });
  }

  it("maps each item type to its fact kind", () => {
    expect(factKindOf({ type: "food" })).toBe("meal");
    expect(factKindOf({ type: "measurement", metric: "weight" })).toBe("weight");
    expect(factKindOf({ type: "measurement", metric: "waist" })).toBe("weight");
    expect(factKindOf({ type: "measurement", metric: "sprint_40yd" })).toBe("training");
    expect(factKindOf({ type: "workout" })).toBe("training");
    for (const type of ["work", "feeling", "symptom"] as const) expect(factKindOf({ type })).toBe("did");
  });

  it("dry-runs the count, copies every item once with its kind, and leaves the day log in place", async () => {
    const t = harness();
    await seedDayLog(t);
    const dry = await t.mutation(internal.ttsMigrations.internalCopyDayLogToEvents, { dryRun: true });
    expect(dry.totals).toMatchObject({ scanned: 6, "to-copy": 6, "already-copied": 0, refused: 0, "to-copy-meal": 1, "to-copy-weight": 1, "to-copy-training": 2, "to-copy-did": 2 });
    const facts = async () =>
      (await t.run((ctx) => ctx.db.query("events").collect())).filter((e) => ["meal", "weight", "training", "did"].includes(e.kind));
    expect(await facts()).toHaveLength(0);

    await t.mutation(internal.ttsMigrations.internalCopyDayLogToEvents, {});
    const rows = await facts();
    expect(rows.map((r) => r.kind).sort()).toEqual(["did", "did", "meal", "training", "training", "weight"]);
    const weight = rows.find((r) => r.kind === "weight")!;
    expect(weight).toMatchObject({ at: Date.UTC(2026, 9, 5, 12), provenance: { user: "tom" } });
    expect(weight.data).toMatchObject({ day: "2026-10-05", metric: "weight", value: 180, unit: "lb", partOfDay: "morning", dayLogType: "measurement", quote: "weighed 180" });
    expect(rows.find((r) => r.data.dayLogType === "symptom")!.kind).toBe("did");
    expect(await dtsEventsOf(t, `${DAY_LOG_COPY_MIGRATION}-migrated`)).toHaveLength(1);

    const again = await t.mutation(internal.ttsMigrations.internalCopyDayLogToEvents, {});
    expect(again.totals).toMatchObject({ "to-copy": 0, "already-copied": 6 });
    expect(await facts()).toHaveLength(6);
    expect(await t.run((ctx) => ctx.db.query("dayLogItems").collect())).toHaveLength(6);
  });
});
