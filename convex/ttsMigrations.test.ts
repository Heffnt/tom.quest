import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  BATCH_NEEDS_MIGRATION,
  CLEAR_MIGRATION,
  READINESS_MIGRATION,
  RECOMMENDATION_MIGRATION,
  RETIRED_FIELD_CLEARED,
  RETIRED_STATUS_ENDED_REASON,
  TIMING_MIGRATION,
  carryCondition,
  previousOnPath,
} from "./ttsMigrations";
import {
  CONDITION_WINDOW_MS,
  DAY_MS,
  READINESS_VALUES,
  RECOMMENDATION_VALUES,
  RETIRED_READINESS_VALUES,
  RETIRED_RECOMMENDATION_MAP,
  buildDoneSet,
  isReady,
} from "./ttsShared";

// The phase-7 row mappings (convex/ttsMigrations.ts): resumable, dry-runnable,
// idempotent, and counted. These tests are the local harness the design says
// every dry run is measured against BEFORE anything runs on prod.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// ── THE HARNESS SCHEMA ───────────────────────────────────────────────────────
// The record prod holds while a migration runs, which is NOT the record the
// validator declares once the narrow lands: a retired readiness spelling, a
// condition-bound timing class, a latest-safe instant, a wake condition in
// words, a batch's named path, a brief's importance and retired recommendation
// spelling, and a session left in "awaiting-permission" all stop inserting
// under convex/schema.ts the day the declarations go. The fixtures here are
// exactly those rows, so they go in under a copy of the schema with the
// retired declarations put back — today identical to what the schema itself
// still declares, and unchanged by the narrow that removes them.
//
// Every walk reads its retired field through a loose view of the row
// (convex/ttsMigrations.ts), which is what keeps a verification re-run
// possible on a deployment whose validator has moved on.

/** The retired importance object, on dtsTodos and dtsCodeBriefs alike. */
const RETIRED_IMPORTANCE = v.optional(
  v.object({
    level: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    setBy: v.union(v.literal("agent"), v.literal("tom")),
    setAt: v.number(),
    rationale: v.optional(v.string()),
  }),
);

type IndexChain = { indexDescriptor: string; fields: string[] }[];
type Indexed = { " indexes"(): IndexChain };
type Chainable = { index(name: string, fields: string[]): Chainable };

/** `defineTable(v.object(...))` starts a table with NO indexes: the `.index()`
 * chain lives on the TableDefinition, not on the validator it is rebuilt from.
 * A rebuilt table therefore silently loses every index the real one declares,
 * and the first `withIndex()` read any tested function makes fails against the
 * harness while passing in production. Carry the source's chain across.
 * (`" indexes"()` is convex/server's own accessor — experimental, and the only
 * way to read a chain back off a table.) */
function carryIndexes<T>(rebuilt: T, source: Indexed): T {
  let table = rebuilt as unknown as Chainable;
  for (const { indexDescriptor, fields } of source[" indexes"]()) {
    table = table.index(indexDescriptor, fields);
  }
  return table as unknown as T;
}

const {
  dtsTodos: schemaTodos,
  batches: schemaBatches,
  claudeSessions: schemaSessions,
  dtsCodeBriefs: schemaBriefs,
  ...otherTables
} = schema.tables;

const wideSchema = defineSchema({
  ...otherTables,
  dtsTodos: carryIndexes(
    defineTable(
      v.object({
        ...schemaTodos.validator.fields,
        readiness: v.union(
          ...[...READINESS_VALUES, ...RETIRED_READINESS_VALUES].map((r) =>
            v.literal(r),
          ),
        ),
        timingClass: v.union(
          v.literal("dated"),
          v.literal("condition-bound"),
          v.literal("whenever"),
        ),
        latestSafeAt: v.optional(v.number()),
        wakeCondition: v.optional(v.string()),
        importance: RETIRED_IMPORTANCE,
      }),
    ),
    schemaTodos,
  ),
  batches: carryIndexes(
    defineTable(
      v.object({
        ...schemaBatches.validator.fields,
        path: v.optional(
          v.object({
            name: v.string(),
            index: v.number(),
            edge: v.optional(v.union(v.literal("must"), v.literal("helps"))),
          }),
        ),
      }),
    ),
    schemaBatches,
  ),
  claudeSessions: carryIndexes(
    defineTable(
      v.object({
        ...schemaSessions.validator.fields,
        status: v.union(
          v.literal("requested"),
          v.literal("starting"),
          v.literal("idle"),
          v.literal("running"),
          v.literal("awaiting-permission"),
          v.literal("ended"),
          v.literal("failed"),
        ),
      }),
    ),
    schemaSessions,
  ),
  dtsCodeBriefs: carryIndexes(
    defineTable(
      v.object({
        ...schemaBriefs.validator.fields,
        recommendation: v.union(
          ...[
            ...RECOMMENDATION_VALUES,
            ...(Object.keys(
              RETIRED_RECOMMENDATION_MAP,
            ) as (keyof typeof RETIRED_RECOMMENDATION_MAP)[]),
          ].map((r) => v.literal(r)),
        ),
        importance: RETIRED_IMPORTANCE,
      }),
    ),
    schemaBriefs,
  ),
});

const NOW = Date.UTC(2026, 8, 5, 12);

type Seed = Partial<Doc<"dtsTodos">> & { statement: string };
async function seedTodos(t: ReturnType<typeof convexTest>, rows: Seed[]) {
  return await t.run(async (ctx) => {
    const ids = [];
    for (const row of rows) {
      ids.push(
        await ctx.db.insert("dtsTodos", {
          readiness: "unprepared",
          status: "active",
          timingClass: "whenever",
          source: "test",
          createdAt: NOW,
          updatedAt: NOW,
          ...row,
        }),
      );
    }
    return ids;
  });
}

async function allTodos(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("dtsTodos").collect());
}

async function eventsOfKind(t: ReturnType<typeof convexTest>, kind: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("dtsEvents").collect()).filter((e) => e.kind === kind),
  );
}

describe("readiness migration (ready-for-tom → prepared, preparing → unprepared)", () => {
  const seed = (): Seed[] => [
    { statement: "raw", readiness: "unprepared" },
    { statement: "briefed", readiness: "ready-for-tom" },
    { statement: "half", readiness: "preparing" },
    { statement: "already", readiness: "prepared" },
    { statement: "done long ago", readiness: "ready-for-tom", status: "done" },
  ];

  // The counts name each retired spelling's one destination, so the walk
  // cannot drift from ttsShared.normalizeReadiness unnoticed. A "preparing"
  // row was half written up: it goes back to the preparer, never onto Tom's
  // pile (a half-prepared capture is never ready).
  it("maps ready-for-tom to prepared and preparing to unprepared, one destination each", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {});
    expect(report.done).toBe(true);
    expect(report.totals).toEqual({
      scanned: 5,
      "ready-for-tom-to-prepared": 2,
      "preparing-to-unprepared": 1,
      prepared: 1,
      unprepared: 1,
    });
    const rows = await allTodos(t);
    const byStatement = Object.fromEntries(rows.map((r) => [r.statement, r]));
    expect(byStatement.raw.readiness).toBe("unprepared");
    expect(byStatement.briefed.readiness).toBe("prepared");
    expect(byStatement.half.readiness).toBe("unprepared");
    expect(byStatement.already.readiness).toBe("prepared");
    // Terminal rows are mapped too — the value leaves the validator at NARROW
    // and every row must be inside it by then. Nothing else on the row moves:
    // status and updatedAt are untouched, so nothing resurfaces.
    expect(byStatement["done long ago"].readiness).toBe("prepared");
    expect(byStatement["done long ago"].status).toBe("done");
    for (const r of rows) expect(r.updatedAt).toBe(NOW);
    const events = await eventsOfKind(t, `${READINESS_MIGRATION}-migrated`);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(report.totals);
  });

  // witness: patch a row inside the dryRun branch — the count would still
  // be right and the table would have moved before Tom saw the numbers.
  it("a dry run reports the same counts and writes no todo row, only the dry-run event", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.totals).toEqual({
      scanned: 5,
      "ready-for-tom-to-prepared": 2,
      "preparing-to-unprepared": 1,
      prepared: 1,
      unprepared: 1,
    });
    const rows = await allTodos(t);
    expect(rows.map((r) => r.readiness).sort()).toEqual(
      ["prepared", "preparing", "ready-for-tom", "ready-for-tom", "unprepared"].sort(),
    );
    expect(await eventsOfKind(t, `${READINESS_MIGRATION}-migrated`)).toHaveLength(0);
    expect(await eventsOfKind(t, `${READINESS_MIGRATION}-dry-run`)).toHaveLength(1);
  });

  // witness: drop the cursor from the continuation args — a resumed run would
  // start from the top and count every row twice.
  it("resumes from a page's cursor, carrying the totals", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const first = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {
      pageSize: 2,
    });
    expect(first.done).toBe(false);
    expect(first.page.scanned).toBe(2);
    expect(first.continueCursor).not.toBeNull();
    // The hand-driven continuation (what a crash-and-resume looks like from
    // the CLI): the next call from the cursor with the totals so far.
    const second = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {
      pageSize: 3,
      cursor: first.continueCursor,
      totals: first.totals,
    });
    expect(second.done).toBe(true);
    expect(second.page.scanned).toBe(3);
    expect(second.totals.scanned).toBe(5);
    expect(second.totals["ready-for-tom-to-prepared"]).toBe(2);
    expect(second.totals["preparing-to-unprepared"]).toBe(1);
  });

  // witness: drop the scheduler.runAfter continuation — a table larger than
  // one page would be half-migrated and report done.
  it("walks the table one page at a time, scheduling itself, and totals across pages", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules });
      await seedTodos(t, seed());
      const first = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {
        pageSize: 2,
      });
      expect(first.done).toBe(false);
      // The continuation chain runs to the end of the table.
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const rows = await allTodos(t);
      expect(
        rows.every((r) => r.readiness === "prepared" || r.readiness === "unprepared"),
      ).toBe(true);
      const events = await eventsOfKind(t, `${READINESS_MIGRATION}-migrated`);
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({
        scanned: 5,
        "ready-for-tom-to-prepared": 2,
        "preparing-to-unprepared": 1,
        prepared: 1,
        unprepared: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent: a second run maps nothing", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {});
    const again = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {});
    expect(again.totals).toEqual({
      scanned: 5,
      "ready-for-tom-to-prepared": 0,
      "preparing-to-unprepared": 0,
      prepared: 3,
      unprepared: 2,
    });
  });
});

describe("timing migration (waiting, condition-bound, return conditions, v1 batches)", () => {
  const LATEST_SAFE = NOW + 30 * DAY_MS;
  const seed = (): Seed[] => [
    // (a) waiting rows
    { statement: "asleep with a time", status: "waiting", wakeAt: NOW + DAY_MS },
    {
      statement: "asleep in words",
      status: "waiting",
      wakeCondition: "the landlord writes back",
    },
    // (b) condition-bound rows
    {
      statement: "renew the lease",
      timingClass: "condition-bound",
      condition: "the landlord sends the paperwork",
      latestSafeAt: LATEST_SAFE,
    },
    {
      statement: "no latest safe",
      timingClass: "condition-bound",
      condition: "the box is rebuilt",
    },
    {
      statement: "a goal with a trigger",
      timingClass: "condition-bound",
      condition: "the grant opens",
      kind: "goal",
      latestSafeAt: LATEST_SAFE,
    },
    // (a)+(b) one row, both mappings: the sentences are carried in order and
    // the sleep comes from latestSafeAt, in ONE patch.
    {
      statement: "wait for the visa office",
      status: "waiting",
      wakeCondition: "the visa office reopens",
      timingClass: "condition-bound",
      condition: "the passport arrives",
      latestSafeAt: LATEST_SAFE,
    },
    // (b) with a wakeAt Tom already set: his instant stays.
    {
      statement: "a wake Tom set",
      timingClass: "condition-bound",
      condition: "the grant opens",
      latestSafeAt: LATEST_SAFE,
      wakeAt: NOW + 3 * DAY_MS,
    },
    // (b) on a finished row: the shape is mapped for the validator, no sleep.
    {
      statement: "finished long ago",
      status: "done",
      doneAt: NOW,
      timingClass: "condition-bound",
      condition: "the box is rebuilt",
      latestSafeAt: LATEST_SAFE,
    },
    // (c) archived rows
    {
      statement: "set aside",
      status: "archived",
      archivedAt: NOW,
      unarchiveCondition: "when the flat is sold",
    },
    {
      statement: "old v1 batch",
      status: "archived",
      archivedAt: NOW,
      unarchiveCondition: "superseded by graph batch abc",
      members: [{ repo: "tom.quest", externalId: "t-1" }],
    },
    // (d) a live v1 batch
    {
      statement: "live v1 batch",
      members: [{ repo: "tom.quest", externalId: "t-2" }],
      plan: [{ text: "step", actor: "agent", status: "open" }],
    },
    // untouched
    { statement: "plain", readiness: "prepared" },
  ];

  const expectedTotals = {
    scanned: 12,
    "waiting-to-active": 3,
    "waiting-condition-carried": 2,
    "condition-bound-to-task": 5,
    "condition-bound-goal-kept": 1,
    "condition-wake-set": 3,
    "condition-wake-kept": 1,
    "archived-with-return-condition": 1,
    "archived-superseded-by-graph": 1,
    "v1-batches-pending-graph-migration": 1,
  };

  /** Rows by the statement they had before any sentence was carried in. */
  const byOriginal = (rows: Doc<"dtsTodos">[]) =>
    Object.fromEntries(rows.map((r) => [r.statement.split(" — when: ")[0], r]));

  it("carries a condition sentence into a statement exactly once", () => {
    expect(carryCondition("renew the lease", "the landlord writes")).toBe(
      "renew the lease — when: the landlord writes",
    );
    expect(
      carryCondition("renew the lease — when: the landlord writes", "the landlord writes"),
    ).toBe("renew the lease — when: the landlord writes");
    expect(carryCondition("renew the lease", undefined)).toBe("renew the lease");
    expect(carryCondition("renew the lease", "  ")).toBe("renew the lease");
  });

  // witness: make the waiting mapping clear wakeAt (the way applyStatusChange
  // does on reopen) — the row would wake a month early.
  it("a waiting row becomes active with its wakeAt, and stays asleep until it", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    expect(report.done).toBe(true);
    expect(report.totals).toEqual(expectedTotals);
    const rows = await allTodos(t);
    const by = byOriginal(rows);
    const timed = by["asleep with a time"];
    expect(timed.status).toBe("active");
    expect(timed.wakeAt).toBe(NOW + DAY_MS);
    expect(isReady(timed, buildDoneSet(rows), NOW)).toBe(false);
    expect(isReady(timed, buildDoneSet(rows), NOW + DAY_MS)).toBe(true);
    // In words alone: awake, the sentence carried into the statement, the
    // retired field left in place until NARROW.
    const worded = by["asleep in words"];
    expect(worded.status).toBe("active");
    expect(worded.wakeAt).toBeUndefined();
    expect(worded.statement).toBe("asleep in words — when: the landlord writes back");
    expect(worded.wakeCondition).toBe("the landlord writes back");
    // updatedAt untouched on every row; the change is an event.
    for (const r of rows) expect(r.updatedAt).toBe(NOW);
    const changes = await eventsOfKind(t, "status-changed");
    expect(changes).toHaveLength(3);
    expect(changes.every((e) => (e.data as { from: string }).from === "waiting")).toBe(true);
  });

  // witness: write wakeAt = latestSafeAt instead of latestSafeAt minus the
  // window — the row would surface two weeks later than the queue used to.
  it("a condition-bound row becomes a task carrying its condition, asleep until latestSafeAt minus the window", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    const rows = await allTodos(t);
    const by = byOriginal(rows);
    const lease = by["renew the lease"];
    expect(lease.kind).toBe("task");
    expect(lease.statement).toBe("renew the lease — when: the landlord sends the paperwork");
    expect(lease.wakeAt).toBe(LATEST_SAFE - CONDITION_WINDOW_MS);
    expect(lease.timingClass).toBe("whenever"); // no date: out of the retired lane
    expect(lease.condition).toBe("the landlord sends the paperwork"); // kept until NARROW
    expect(lease.latestSafeAt).toBe(LATEST_SAFE);
    const noSafe = by["no latest safe"];
    expect(noSafe.kind).toBe("task");
    expect(noSafe.wakeAt).toBeUndefined(); // no date to sleep until: awake
    // A goal keeps its kind; the trigger is carried the same way.
    const goal = by["a goal with a trigger"];
    expect(goal.kind).toBe("goal");
    expect(goal.statement).toBe("a goal with a trigger — when: the grant opens");
    expect(goal.wakeAt).toBe(LATEST_SAFE - CONDITION_WINDOW_MS);
    expect(await eventsOfKind(t, "timing-mapped")).toHaveLength(6);
  });

  // A row that is BOTH a stored waiting row and condition-bound. Two patches
  // in sequence lost the wait sentence the first carried in and overwrote a
  // wakeAt Tom had set; one patch carries both and writes the sleep once.
  it("a row both waiting and condition-bound gets one patch carrying both sentences", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    const rows = await allTodos(t);
    const visa = byOriginal(rows)["wait for the visa office"];
    expect(visa.status).toBe("active");
    expect(visa.kind).toBe("task");
    expect(visa.statement).toBe(
      "wait for the visa office — when: the visa office reopens — when: the passport arrives",
    );
    expect(visa.wakeAt).toBe(LATEST_SAFE - CONDITION_WINDOW_MS);
    expect(visa.wakeCondition).toBe("the visa office reopens"); // kept until NARROW
    expect(visa.condition).toBe("the passport arrives");
    // Both events, from the one write: the status change and the mapping,
    // whose `after` is the whole patch.
    const mapped = (await eventsOfKind(t, "timing-mapped")).find((e) => e.todoId === visa._id);
    expect((mapped!.data as { after: Partial<Doc<"dtsTodos">> }).after).toEqual({
      status: "active",
      kind: "task",
      timingClass: "whenever",
      wakeAt: LATEST_SAFE - CONDITION_WINDOW_MS,
      statement: visa.statement,
    });
    expect((await eventsOfKind(t, "status-changed")).some((e) => e.todoId === visa._id)).toBe(true);
  });

  it("keeps a wakeAt Tom set, and writes no sleep on a finished row", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    expect(report.totals["condition-wake-kept"]).toBe(1);
    const by = byOriginal(await allTodos(t));
    const toms = by["a wake Tom set"];
    expect(toms.wakeAt).toBe(NOW + 3 * DAY_MS);
    expect(toms.kind).toBe("task");
    expect(toms.statement).toBe("a wake Tom set — when: the grant opens");
    // Terminal rows are mapped for the validator only: the retired shape
    // leaves, and nothing that reads as a live sleep is written on them.
    const finished = by["finished long ago"];
    expect(finished.status).toBe("done");
    expect(finished.kind).toBe("task");
    expect(finished.timingClass).toBe("whenever");
    expect(finished.statement).toBe("finished long ago — when: the box is rebuilt");
    expect(finished.wakeAt).toBeUndefined();
  });

  it("leaves archived rows and v1 batches alone, counting them for the gather and the graph migration", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    const by = byOriginal(await allTodos(t));
    expect(by["set aside"].status).toBe("archived");
    expect(by["set aside"].unarchiveCondition).toBe("when the flat is sold");
    expect(by["live v1 batch"].members).toHaveLength(1);
    expect(by["live v1 batch"].plan).toHaveLength(1);
    expect(by.plain.statement).toBe("plain");
  });

  it("a dry run reports the same counts and writes no todo row, only the dry-run event", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {
      dryRun: true,
    });
    expect(report.totals).toEqual(expectedTotals);
    const rows = await allTodos(t);
    expect(rows.filter((r) => r.status === "waiting")).toHaveLength(3);
    expect(rows.filter((r) => r.timingClass === "condition-bound")).toHaveLength(6);
    expect(await eventsOfKind(t, "status-changed")).toHaveLength(0);
    expect(await eventsOfKind(t, "timing-mapped")).toHaveLength(0);
    expect(await eventsOfKind(t, `${TIMING_MIGRATION}-dry-run`)).toHaveLength(1);
  });

  it("is idempotent: a second run maps nothing and still counts what it only counts", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    const again = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {});
    expect(again.totals).toEqual({
      ...expectedTotals,
      "waiting-to-active": 0,
      "waiting-condition-carried": 0,
      "condition-bound-to-task": 0,
      "condition-bound-goal-kept": 0,
      "condition-wake-set": 0,
      "condition-wake-kept": 0,
    });
    expect(await eventsOfKind(t, "status-changed")).toHaveLength(3);
  });

  it("resumes across pages by cursor", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const first = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {
      pageSize: 4,
    });
    expect(first.done).toBe(false);
    const second = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {
      pageSize: 100,
      cursor: first.continueCursor,
      totals: first.totals,
    });
    expect(second.done).toBe(true);
    expect(second.totals).toEqual(expectedTotals);
  });
});

describe("batch needs migration (path → needs edges between batches)", () => {
  type BatchSeed = Partial<Doc<"batches">> & { statement: string };
  async function seedBatches(t: ReturnType<typeof convexTest>, rows: BatchSeed[]) {
    return await t.run(async (ctx) => {
      const ids: Record<string, Id<"batches">> = {};
      for (const row of rows) {
        ids[row.statement] = await ctx.db.insert("batches", {
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
          ...row,
        });
      }
      return ids;
    });
  }
  const allBatches = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => ctx.db.query("batches").collect());

  const seed = (): BatchSeed[] => [
    { statement: "release 0", path: { name: "release", index: 0 } },
    { statement: "release 1", path: { name: "release", index: 1, edge: "must" } },
    // index 2 is missing: the previous of 3 is 1, not "index minus one".
    { statement: "release 3", path: { name: "release", index: 3, edge: "must" } },
    { statement: "release 5", path: { name: "release", index: 5, edge: "helps" } },
    { statement: "paper 4", path: { name: "paper", index: 4, edge: "must" } }, // no previous
    { statement: "unpathed" },
    { statement: "done 0", path: { name: "done", index: 0 }, status: "done" },
    { statement: "done 1", path: { name: "done", index: 1, edge: "must" }, status: "done" },
  ];
  const expectedCounts = {
    scanned: 8,
    "must-to-need": 3,
    "must-without-previous": 1,
    "helps-dropped": 1,
    unlinked: 2,
    "already-derived": 0,
    "no-path": 1,
  };

  it("finds the previous batch on a path by the greatest lower index", () => {
    const rows = seed().map((s) => ({ ...s }));
    const by = Object.fromEntries(rows.map((r) => [r.statement, r]));
    expect(previousOnPath(by["release 3"], rows)?.statement).toBe("release 1");
    expect(previousOnPath(by["release 0"], rows)).toBeUndefined();
    expect(previousOnPath(by["paper 4"], rows)).toBeUndefined();
    expect(previousOnPath(by.unpathed, rows)).toBeUndefined();
  });

  // witness: derive a need for a "helps" edge too — "only makes this easier"
  // would block the batch until the other landed.
  it("a must edge becomes a need on the previous batch; helps becomes nothing", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBatches(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateBatchNeeds, {});
    expect(report.totals).toEqual(expectedCounts);
    const rows = await allBatches(t);
    const by = Object.fromEntries(rows.map((b) => [b.statement, b]));
    expect(by["release 1"].needs).toEqual([ids["release 0"]]);
    expect(by["release 3"].needs).toEqual([ids["release 1"]]);
    expect(by["release 5"].needs).toBeUndefined();
    expect(by["release 0"].needs).toBeUndefined();
    expect(by["paper 4"].needs).toBeUndefined();
    expect(by.unpathed.needs).toBeUndefined();
    expect(by["done 1"].needs).toEqual([ids["done 0"]]); // terminal rows mapped too
    // The path stays until NARROW; updatedAt is untouched.
    expect(by["release 1"].path).toEqual({ name: "release", index: 1, edge: "must" });
    for (const b of rows) expect(b.updatedAt).toBe(NOW);
    expect(await eventsOfKind(t, "batch-needs-derived")).toHaveLength(3);
    expect(await eventsOfKind(t, `${BATCH_NEEDS_MIGRATION}-migrated`)).toHaveLength(1);
  });

  it("a dry run reports the same counts and writes no batch row, only the dry-run event", async () => {
    const t = convexTest({ schema, modules });
    await seedBatches(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateBatchNeeds, {
      dryRun: true,
    });
    expect(report.totals).toEqual(expectedCounts);
    expect((await allBatches(t)).every((b) => b.needs === undefined)).toBe(true);
    expect(await eventsOfKind(t, "batch-needs-derived")).toHaveLength(0);
    expect(await eventsOfKind(t, `${BATCH_NEEDS_MIGRATION}-dry-run`)).toHaveLength(1);
  });

  it("is idempotent, and keeps a need the planner already wrote", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seedBatches(t, seed());
    // The planner already sequenced "release 3" on something else.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids["release 3"], { needs: [ids.unpathed] });
    });
    await t.mutation(internal.ttsMigrations.internalMigrateBatchNeeds, {});
    const again = await t.mutation(internal.ttsMigrations.internalMigrateBatchNeeds, {});
    expect(again.totals).toEqual({
      ...expectedCounts,
      "must-to-need": 0,
      "already-derived": 3,
    });
    const by = Object.fromEntries((await allBatches(t)).map((b) => [b.statement, b]));
    expect(by["release 3"].needs).toEqual([ids.unpathed, ids["release 1"]]);
  });
});

describe("recommendation migration (code briefs → the four verdict words)", () => {
  async function seedBriefs(t: ReturnType<typeof convexTest>) {
    const spellings = [
      "approve",
      "stale-replan",
      "needs-session",
      "propose-archive",
      "revise",
    ] as const;
    await t.run(async (ctx) => {
      for (const [i, recommendation] of spellings.entries()) {
        await ctx.db.insert("dtsCodeBriefs", {
          repo: "ComplexMultiTrigger",
          externalId: `cmt-00${i}`,
          sourceHash: `h${i}`,
          brief: "a brief",
          recommendation,
          execClass: "box",
          preparedAt: NOW,
        });
      }
    });
  }
  const allBriefs = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => ctx.db.query("dtsCodeBriefs").collect());
  const expectedCounts = {
    scanned: 5,
    "stale-replan-to-revise": 1,
    "needs-session-to-session": 1,
    "propose-archive-to-archive": 1,
    "already-verdict-word": 2,
  };

  // witness: map "stale-replan" to "session" in ttsShared — the counts name
  // each spelling's destination, so the one-to-one map cannot drift.
  it("maps each retired spelling to its verdict word", async () => {
    const t = convexTest({ schema, modules });
    await seedBriefs(t);
    const report = await t.mutation(internal.ttsMigrations.internalMigrateRecommendations, {});
    expect(report.totals).toEqual(expectedCounts);
    const by = Object.fromEntries((await allBriefs(t)).map((b) => [b.externalId, b]));
    expect(by["cmt-000"].recommendation).toBe("approve");
    expect(by["cmt-001"].recommendation).toBe("revise");
    expect(by["cmt-002"].recommendation).toBe("session");
    expect(by["cmt-003"].recommendation).toBe("archive");
    expect(by["cmt-004"].recommendation).toBe("revise");
    // preparedAt untouched: a re-spelled brief is not a re-brief, so it does
    // not return an item Tom already ruled on to his pile.
    for (const b of await allBriefs(t)) expect(b.preparedAt).toBe(NOW);
    expect(await eventsOfKind(t, `${RECOMMENDATION_MIGRATION}-migrated`)).toHaveLength(1);
  });

  it("a dry run reports the same counts and writes no brief row; a second run maps nothing", async () => {
    const t = convexTest({ schema, modules });
    await seedBriefs(t);
    const dry = await t.mutation(internal.ttsMigrations.internalMigrateRecommendations, {
      dryRun: true,
    });
    expect(dry.totals).toEqual(expectedCounts);
    expect((await allBriefs(t)).map((b) => b.recommendation).sort()).toEqual(
      ["approve", "needs-session", "propose-archive", "revise", "stale-replan"].sort(),
    );
    await t.mutation(internal.ttsMigrations.internalMigrateRecommendations, {});
    const again = await t.mutation(internal.ttsMigrations.internalMigrateRecommendations, {});
    expect(again.totals).toEqual({
      scanned: 5,
      "stale-replan-to-revise": 0,
      "needs-session-to-session": 0,
      "propose-archive-to-archive": 0,
      "already-verdict-word": 5,
    });
  });
});

describe("the harness schema", () => {
  // witness: drop carryIndexes() and rebuild a table from its validator alone
  // — every index the real table declares would be missing from the harness,
  // and the first withIndex() read a tested function makes would fail here
  // while passing in production. defineTable(v.object(...)) carries the
  // fields; the .index() chain lives on the table, not on the validator.
  it("rebuilds each widened table with the index chain the schema declares", () => {
    for (const name of [
      "dtsTodos",
      "batches",
      "claudeSessions",
      "dtsCodeBriefs",
    ] as const) {
      const wide = wideSchema.tables[name] as unknown as Indexed;
      const real = schema.tables[name] as unknown as Indexed;
      expect(wide[" indexes"]()).toEqual(real[" indexes"]());
      expect(real[" indexes"]().length).toBeGreaterThan(0);
    }
  });
});

// The CLEARING walk (convex/ttsMigrations.ts section 7): the step between the
// value mappings above and the narrow. `convex deploy` validates every stored
// document against the validator being deployed, so a field or a union literal
// leaves the schema only after it has left every row.
describe("clearing walk (retired fields and the retired session status)", () => {
  const RETIRED_IMPORTANCE_VALUE = {
    level: "high" as const,
    setBy: "agent" as const,
    setAt: NOW,
    rationale: "the agent guessed",
  };
  const MUST_PATH = { name: "release", index: 1, edge: "must" as const };
  const HELPS_PATH = { name: "release", index: 2, edge: "helps" as const };
  const UNLINKED_PATH = { name: "paper", index: 0 };

  const todoSeed = (): Seed[] => [
    {
      statement: "all three",
      latestSafeAt: NOW + 30 * DAY_MS,
      wakeCondition: "the landlord writes back",
      importance: RETIRED_IMPORTANCE_VALUE,
    },
    { statement: "just the instant", latestSafeAt: NOW + DAY_MS },
    { statement: "nothing retired" },
    // A finished row is cleared like the rest: the validator does not care
    // that a row is done, and one such row left behind fails the deploy.
    {
      statement: "finished long ago",
      status: "done",
      doneAt: NOW,
      importance: RETIRED_IMPORTANCE_VALUE,
    },
  ];

  async function seedRest(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const batches = {
        must: await ctx.db.insert("batches", {
          statement: "must edge",
          status: "active",
          path: MUST_PATH,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        helps: await ctx.db.insert("batches", {
          statement: "helps edge",
          status: "active",
          path: HELPS_PATH,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        unlinked: await ctx.db.insert("batches", {
          statement: "unlinked",
          status: "done",
          path: UNLINKED_PATH,
          createdAt: NOW,
          updatedAt: NOW,
        }),
        none: await ctx.db.insert("batches", {
          statement: "no path",
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      };
      const session = (
        title: string,
        status: "awaiting-permission" | "running",
        endedReason?: string,
      ) =>
        ctx.db.insert("claudeSessions", {
          title,
          kind: "adhoc" as const,
          repo: "tom.quest",
          status,
          statusChangedAt: NOW,
          endedReason,
          nextSeq: 0,
          createdAt: NOW,
        });
      const sessions = {
        parked: await session("parked on a permission", "awaiting-permission"),
        withReason: await session(
          "parked, and already said why",
          "awaiting-permission",
          "the daemon lost the box",
        ),
        live: await session("still running", "running"),
      };
      const brief = (externalId: string, extra: Record<string, unknown>) =>
        ctx.db.insert("dtsCodeBriefs", {
          repo: "ComplexMultiTrigger",
          externalId,
          sourceHash: `h-${externalId}`,
          brief: "a brief",
          recommendation: "approve",
          execClass: "box" as const,
          preparedAt: NOW,
          ...extra,
        });
      const briefs = {
        retired: await brief("cmt-100", {
          recommendation: "stale-replan",
          importance: RETIRED_IMPORTANCE_VALUE,
        }),
        clean: await brief("cmt-101", {}),
      };
      return { batches, sessions, briefs };
    });
  }

  const expectedTotals = {
    "dtsTodos-scanned": 4,
    "batches-scanned": 4,
    "claudeSessions-scanned": 3,
    "dtsCodeBriefs-scanned": 2,
    "latestSafeAt-cleared": 2,
    "wakeCondition-cleared": 1,
    "importance-cleared": 2,
    "path-cleared": 3,
    "awaiting-permission-ended": 2,
    "brief-importance-cleared": 1,
    "recommendation-normalized": 1,
  };
  const nothingLeft = {
    ...expectedTotals,
    "latestSafeAt-cleared": 0,
    "wakeCondition-cleared": 0,
    "importance-cleared": 0,
    "path-cleared": 0,
    "awaiting-permission-ended": 0,
    "brief-importance-cleared": 0,
    "recommendation-normalized": 0,
  };

  /** One call, walking all four tables: a pageSize past the biggest table
   * finishes each in one page, and the chain runs to the end. */
  async function clearAll(
    t: ReturnType<typeof convexTest>,
    args: { dryRun?: boolean } = {},
  ) {
    vi.useFakeTimers();
    try {
      await t.mutation(internal.ttsMigrations.internalClearRetiredFields, {
        pageSize: 100,
        ...args,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    const kind = args.dryRun
      ? `${CLEAR_MIGRATION}-dry-run`
      : `${CLEAR_MIGRATION}-migrated`;
    // The chain's totals are the event the LAST call writes — the CLI call
    // that started it returned when its own page was done.
    const events = await eventsOfKind(t, kind);
    expect(events.length).toBeGreaterThan(0);
    return events[events.length - 1].data as Record<string, number>;
  }

  const wideRows = async (t: ReturnType<typeof convexTest>) =>
    await t.run(async (ctx) => ({
      todos: await ctx.db.query("dtsTodos").collect(),
      batches: await ctx.db.query("batches").collect(),
      sessions: await ctx.db.query("claudeSessions").collect(),
      briefs: await ctx.db.query("dtsCodeBriefs").collect(),
    }));

  // witness: clear a field without logging its value first — the deploy would
  // pass and the record of what the row said would be gone with no trace.
  it("clears each retired field once, recording every value it takes out", async () => {
    const t = convexTest({ schema: wideSchema, modules });
    await seedTodos(t, todoSeed());
    const ids = await seedRest(t);
    expect(await clearAll(t)).toEqual(expectedTotals);

    const rows = await wideRows(t);
    for (const todo of rows.todos) {
      expect(todo.latestSafeAt).toBeUndefined();
      expect(todo.wakeCondition).toBeUndefined();
      expect(todo.importance).toBeUndefined();
      // Nothing else on the row moved: updatedAt is untouched, so clearing a
      // retired field puts no settled item back on Tom's pile.
      expect(todo.updatedAt).toBe(NOW);
    }
    for (const batch of rows.batches) {
      expect(batch.path).toBeUndefined();
      expect(batch.updatedAt).toBe(NOW);
    }
    const sessions = Object.fromEntries(rows.sessions.map((s) => [s.title, s]));
    expect(sessions["parked on a permission"].status).toBe("ended");
    expect(sessions["parked on a permission"].endedReason).toBe(
      RETIRED_STATUS_ENDED_REASON,
    );
    // A session that already said why it stopped keeps its own sentence — the
    // migration ends it, it does not rewrite what happened to it.
    expect(sessions["parked, and already said why"].endedReason).toBe(
      "the daemon lost the box",
    );
    expect(sessions["still running"].status).toBe("running");
    // statusChangedAt is untouched: these rows are historical and must not
    // sort to the top of the sessions list as if they had just ended.
    for (const s of rows.sessions) expect(s.statusChangedAt).toBe(NOW);
    const briefs = Object.fromEntries(rows.briefs.map((b) => [b.externalId, b]));
    expect(briefs["cmt-100"].recommendation).toBe("revise");
    expect(briefs["cmt-100"].importance).toBeUndefined();
    expect(briefs["cmt-101"].recommendation).toBe("approve");
    expect(briefs["cmt-100"].preparedAt).toBe(NOW);

    // One event per value, carrying the value itself.
    const cleared = await eventsOfKind(t, RETIRED_FIELD_CLEARED);
    expect(cleared).toHaveLength(12);
    const byField = (field: string) =>
      cleared
        .map((e) => e.data as { field: string; value: unknown })
        .filter((d) => d.field === field)
        .map((d) => d.value);
    expect(byField("latestSafeAt")).toEqual([NOW + 30 * DAY_MS, NOW + DAY_MS]);
    expect(byField("wakeCondition")).toEqual(["the landlord writes back"]);
    expect(byField("importance")).toEqual([
      RETIRED_IMPORTANCE_VALUE,
      RETIRED_IMPORTANCE_VALUE,
      RETIRED_IMPORTANCE_VALUE,
    ]);
    // The WHOLE path object, helps edges and unlinked names included: what
    // the needs migration derived from is not all a path said.
    expect(byField("path")).toEqual([MUST_PATH, HELPS_PATH, UNLINKED_PATH]);
    expect(byField("recommendation")).toEqual(["stale-replan"]);
    // A todo's clearing is on its own history (the indexed column), and every
    // row names the table and the row it came out of.
    const todoEvents = cleared.filter((e) => e.todoId !== undefined);
    expect(todoEvents).toHaveLength(5);
    const pathEvent = cleared.find(
      (e) => (e.data as { field: string }).field === "path",
    )!;
    expect((pathEvent.data as { table: string }).table).toBe("batches");
    expect((pathEvent.data as { batchId: string }).batchId).toBe(ids.batches.must);
    const statusEvent = cleared.find(
      (e) => (e.data as { field: string }).field === "status",
    )!;
    expect((statusEvent.data as { sessionId: string }).sessionId).toBe(
      ids.sessions.parked,
    );
    expect((statusEvent.data as { value: unknown }).value).toEqual({
      status: "awaiting-permission",
    });
  });

  // witness: patch a row inside the dryRun branch — the counts would still be
  // right and every row would have moved before Tom saw the numbers.
  it("a dry run reports the same counts and writes nothing but the dry-run event", async () => {
    const t = convexTest({ schema: wideSchema, modules });
    await seedTodos(t, todoSeed());
    await seedRest(t);
    expect(await clearAll(t, { dryRun: true })).toEqual(expectedTotals);
    const rows = await wideRows(t);
    expect(rows.todos.filter((r) => r.latestSafeAt !== undefined)).toHaveLength(2);
    expect(rows.todos.filter((r) => r.importance !== undefined)).toHaveLength(2);
    expect(rows.batches.filter((b) => b.path !== undefined)).toHaveLength(3);
    expect(
      rows.sessions.filter((s) => s.status === "awaiting-permission"),
    ).toHaveLength(2);
    expect(rows.briefs[0].recommendation).toBe("stale-replan");
    expect(await eventsOfKind(t, RETIRED_FIELD_CLEARED)).toHaveLength(0);
  });

  // The verification step: the gate the narrow waits on is this run reporting
  // zero for every cleared count.
  it("is idempotent: a second run clears nothing and reports zero for every field", async () => {
    const t = convexTest({ schema: wideSchema, modules });
    await seedTodos(t, todoSeed());
    await seedRest(t);
    await clearAll(t);
    expect(await clearAll(t)).toEqual(nothingLeft);
    // And it wrote no second record of a value: nine values left the rows,
    // once, on the first run.
    expect(await eventsOfKind(t, RETIRED_FIELD_CLEARED)).toHaveLength(12);
  });

  // witness: drop the cursor from the continuation and a resumed run starts
  // the table again; drop the table hand-off and three of the four tables are
  // never walked while the call reports done.
  it("resumes within a table by cursor, and hands off table by table", async () => {
    // Fake timers throughout: each call below schedules its own continuation,
    // and this test drives them by hand instead. Left on real timers the
    // continuations fire after the test has finished, against a transaction
    // that is already committed.
    vi.useFakeTimers();
    try {
      await resumeByHand();
    } finally {
      vi.useRealTimers();
    }
  });

  async function resumeByHand() {
    const t = convexTest({ schema: wideSchema, modules });
    await seedTodos(t, todoSeed());
    await seedRest(t);
    const first = await t.mutation(
      internal.ttsMigrations.internalClearRetiredFields,
      { pageSize: 2, dryRun: true },
    );
    expect(first.done).toBe(false);
    expect(first.table).toBe("dtsTodos");
    expect(first.nextTable).toBe("dtsTodos");
    expect(first.page["dtsTodos-scanned"]).toBe(2);
    expect(first.continueCursor).not.toBeNull();
    // The hand-driven continuation, which is what a crash and resume looks
    // like from the CLI: the same table from its cursor, carrying the totals.
    const second = await t.mutation(
      internal.ttsMigrations.internalClearRetiredFields,
      {
        pageSize: 100,
        dryRun: true,
        table: first.nextTable ?? undefined,
        cursor: first.continueCursor,
        totals: first.totals,
      },
    );
    expect(second.done).toBe(false);
    expect(second.nextTable).toBe("batches");
    expect(second.totals["dtsTodos-scanned"]).toBe(4);
    expect(second.totals["latestSafeAt-cleared"]).toBe(2);
    // And one table on its own, for the run that only has to finish one.
    const briefsOnly = await t.mutation(
      internal.ttsMigrations.internalClearRetiredFields,
      { pageSize: 100, dryRun: true, table: "dtsCodeBriefs" },
    );
    expect(briefsOnly.done).toBe(true);
    expect(briefsOnly.totals["recommendation-normalized"]).toBe(1);
    expect(briefsOnly.totals["dtsTodos-scanned"]).toBe(0);
  }
});
