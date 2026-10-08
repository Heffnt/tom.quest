import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import {
  ARCHIVE_WHOLE_MIGRATION,
  RESTART_PROVENANCE,
  RESTART_TODOS,
} from "./ttsMigrations";

// The redesign's restart (convex/ttsMigrations.ts, 2026-10-06): the old todos
// archived whole and reversibly and the seven inserted once. These are the
// local harness the prod dry runs are read against. The copy of the day log's
// items into the events table ran in production on October 6 and went with
// the day log on October 7.

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

describe("the seven among many manual todos", () => {
  it("finds the seven past a thousand older manual rows: no duplicate on a re-run, all seven read back", async () => {
    const t = harness();
    await t.run(async (ctx) => {
      for (let i = 0; i < 1001; i++) {
        await ctx.db.insert("todos", {
          statement: `older manual todo ${i}`,
          readiness: "unprepared",
          status: "done",
          timingClass: "whenever",
          source: "manual",
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    await t.mutation(internal.ttsMigrations.internalAddRestartTodos, {});
    const again = await t.mutation(internal.ttsMigrations.internalAddRestartTodos, {});
    expect(again).toMatchObject({ toInsert: 0, inserted: [] });
    expect((await allTodos(t)).filter((r) => r.provenance === RESTART_PROVENANCE)).toHaveLength(7);
    const back = await t.query(internal.ttsMigrations.internalRestartTodos, {});
    expect(back.every((r) => r.id !== null)).toBe(true);
  });
});

describe("the fact kinds on the legacy route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("are refused by POST /tts/event, which copies a row into events unchecked", async () => {
    const t = harness();
    vi.stubEnv("TTS_WORKER_KEY", "k");
    for (const kind of ["meal", "weight", "training", "did"]) {
      const response = await t.fetch("/tts/event", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TTS-Key": "k" },
        body: JSON.stringify({ kind, data: { summary: "no day" } }),
      });
      expect(response.status).toBe(403);
    }
    const rows = await t.run((ctx) => ctx.db.query("events").collect());
    expect(rows.filter((r) => ["meal", "weight", "training", "did"].includes(r.kind))).toHaveLength(0);
  });
});
