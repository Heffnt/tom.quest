import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import {
  defineSchema,
  defineTable,
  type DataModelFromSchemaDefinition,
  type DocumentByName,
} from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  BATCH_NEEDS_MIGRATION,
  BATCH_REMOVED_EVENT,
  BATCHES_REMOVED_MIGRATION,
  BATCHES_REMOVED_RULING,
  CLEAR_MIGRATION,
  CLOSED_UPSTREAM_CONDITIONS,
  CLOSED_UPSTREAM_MIGRATION,
  STEERING_GRAD_ARCHIVE_REASON,
  STEERING_GRAD_ENTRIES,
  closedUpstreamStatement,
  duplicateArchiveReason,
  READINESS_MIGRATION,
  RECOMMENDATION_MIGRATION,
  RETIRED_FIELD_CLEARED,
  RETIRED_STATUS_ENDED_REASON,
  TIMING_MIGRATION,
  carryCondition,
  previousOnPath,
  rowDigest,
  SCRUB_CHUNKS_PER_ROW_MAX,
  WORKER_KEY_MARKER,
  WORKER_KEY_ROWS_SCRUBBED,
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
// words, a v1 batch's members and its plan, a batch's named path, a brief's
// importance and retired recommendation spelling, and a session left in
// "awaiting-permission" all stop inserting
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
        // The v1 batch pair, declared here for the same reason as the fields
        // above: a dtsTodos row carrying `members` WAS a batch and `plan` was
        // its ordered steps, the graph migration has replaced both, and the
        // narrow drops the declarations — while rows on the deployment still
        // hold them until this walk has cleared them.
        members: v.optional(
          v.array(
            v.object({
              todoId: v.optional(v.id("dtsTodos")),
              repo: v.optional(v.string()),
              externalId: v.optional(v.string()),
            }),
          ),
        ),
        plan: v.optional(
          v.array(
            v.object({
              text: v.string(),
              actor: v.union(v.literal("tom"), v.literal("agent")),
              status: v.union(v.literal("open"), v.literal("done")),
              doneAt: v.optional(v.number()),
              evidence: v.optional(v.string()),
            }),
          ),
        ),
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

// Rows come back as the HARNESS holds them, not as the narrowed validator
// declares them: a row on the deployment keeps the fields the validator
// dropped, and these fixtures and assertions are about exactly those fields.
type WideModel = DataModelFromSchemaDefinition<typeof wideSchema>;
type WideTodo = DocumentByName<WideModel, "dtsTodos">;
type WideBatch = DocumentByName<WideModel, "batches">;
type WideBrief = DocumentByName<WideModel, "dtsCodeBriefs">;
type WideSession = DocumentByName<WideModel, "claudeSessions">;

const NOW = Date.UTC(2026, 8, 5, 12);

type Seed = Partial<WideTodo> & { statement: string };
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

// Rows come back as the HARNESS holds them (WideTodo), not as the narrowed
// validator declares them: a row on the deployment keeps the fields the
// validator dropped, and these assertions are about exactly those fields.
async function allTodos(t: ReturnType<typeof convexTest>): Promise<WideTodo[]> {
  return (await t.run(async (ctx) =>
    ctx.db.query("dtsTodos").collect(),
  )) as unknown as WideTodo[];
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
      const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
  const byOriginal = (rows: WideTodo[]) =>
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
  type BatchSeed = Partial<WideBatch> & { statement: string };
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
  const allBatches = async (
    t: ReturnType<typeof convexTest>,
  ): Promise<WideBatch[]> =>
    (await t.run(async (ctx) =>
      ctx.db.query("batches").collect(),
    )) as unknown as WideBatch[];

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
    const t = convexTest({ schema: wideSchema, modules });
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
    // The path the walk read is left on the row — this migration derives, it
    // does not delete — and updatedAt is untouched.
    expect(by["release 1"].path).toEqual({ name: "release", index: 1, edge: "must" });
    for (const b of rows) expect(b.updatedAt).toBe(NOW);
    expect(await eventsOfKind(t, "batch-needs-derived")).toHaveLength(3);
    expect(await eventsOfKind(t, `${BATCH_NEEDS_MIGRATION}-migrated`)).toHaveLength(1);
  });

  it("a dry run reports the same counts and writes no batch row, only the dry-run event", async () => {
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
  const allBriefs = async (
    t: ReturnType<typeof convexTest>,
  ): Promise<WideBrief[]> =>
    (await t.run(async (ctx) =>
      ctx.db.query("dtsCodeBriefs").collect(),
    )) as unknown as WideBrief[];
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
    const t = convexTest({ schema: wideSchema, modules });
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
    const t = convexTest({ schema: wideSchema, modules });
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
  // The v1 batch pair. `members` is what made a dtsTodos row a batch; `plan`
  // was its ordered completion steps and was legal on any todo, batch or not.
  const V1_MEMBERS = [
    { repo: "ComplexMultiTrigger", externalId: "cmt-001" },
    { repo: "tom.quest", externalId: "tq-002" },
  ];
  const V1_PLAN = [
    {
      text: "gather the sources",
      actor: "agent" as const,
      status: "done" as const,
      doneAt: NOW,
      evidence: "session/abc → PR #12",
    },
    { text: "rule on the shape", actor: "tom" as const, status: "open" as const },
  ];

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
    // A v1 batch, as prod holds one after tts.internalMigrateToGraph replaced
    // it: archived with the successor pointer, still carrying both fields.
    {
      statement: "live v1 batch",
      status: "archived",
      unarchiveCondition: "superseded by graph batch k12345",
      members: V1_MEMBERS,
      plan: V1_PLAN,
    },
    // A plan on a row that was never a batch — the field was legal anywhere.
    { statement: "a plan, no members", plan: V1_PLAN },
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
    "dtsTodos-scanned": 6,
    "batches-scanned": 4,
    "claudeSessions-scanned": 3,
    "dtsCodeBriefs-scanned": 2,
    "latestSafeAt-cleared": 2,
    "wakeCondition-cleared": 1,
    "importance-cleared": 2,
    "members-cleared": 1,
    "plan-cleared": 2,
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
    "members-cleared": 0,
    "plan-cleared": 0,
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
      expect(todo.members).toBeUndefined();
      expect(todo.plan).toBeUndefined();
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
    expect(cleared).toHaveLength(15);
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
    // The WHOLE members array and the WHOLE plan — every step with its actor,
    // its status, its completion instant and its evidence. The graph holds
    // what they MEANT; this is what they SAID.
    expect(byField("members")).toEqual([V1_MEMBERS]);
    expect(byField("plan")).toEqual([V1_PLAN, V1_PLAN]);
    expect(byField("recommendation")).toEqual(["stale-replan"]);
    // A todo's clearing is on its own history (the indexed column), and every
    // row names the table and the row it came out of.
    const todoEvents = cleared.filter((e) => e.todoId !== undefined);
    expect(todoEvents).toHaveLength(8);
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
    expect(rows.todos.filter((r) => r.members !== undefined)).toHaveLength(1);
    expect(rows.todos.filter((r) => r.plan !== undefined)).toHaveLength(2);
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
    // And it wrote no second record of a value: every value left the rows
    // once, on the first run.
    expect(await eventsOfKind(t, RETIRED_FIELD_CLEARED)).toHaveLength(15);
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
    expect(second.totals["dtsTodos-scanned"]).toBe(6);
    expect(second.totals["latestSafeAt-cleared"]).toBe(2);
    expect(second.totals["members-cleared"]).toBe(1);
    expect(second.totals["plan-cleared"]).toBe(2);
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

describe("closed-upstream goals (ruling 70: CMT's registry retired)", () => {
  // The rows the two batch migrations wrote: a goal worded "ComplexMultiTrigger
  // <id> closed upstream", the same sentence as its condition, the entry bound
  // as its code subject, source "migration" — prepared by the preparer since.
  const OLD = NOW - 8 * DAY_MS; // the 2026-08-29 migration
  const NEW = NOW - DAY_MS; // the 2026-09-06 migration

  async function seedBatch(t: ReturnType<typeof convexTest>, statement: string) {
    return await t.run(async (ctx) =>
      ctx.db.insert("batches", {
        statement,
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  const goal = (
    entry: string,
    batchId: Id<"batches">,
    createdAt: number,
    extra: Partial<Doc<"dtsTodos">> = {},
  ): Seed => ({
    statement: closedUpstreamStatement(entry),
    condition: closedUpstreamStatement(entry),
    kind: "goal",
    codeRepo: "ComplexMultiTrigger",
    codeExternalId: entry,
    batchId,
    readiness: "prepared",
    brief: `a brief about ${entry} being closed upstream`,
    source: "migration",
    createdAt,
    ...extra,
  });

  /** The two-copy case, a tier-H entry, the steering-grad case, the done
   * case, a single copy, and three rows that are not this migration's. */
  async function seed(t: ReturnType<typeof convexTest>) {
    const oldBatch = await seedBatch(t, "the 2026-08-29 batch");
    const newBatch = await seedBatch(t, "the 2026-09-06 batch");
    const [task] = await seedTodos(t, [
      { statement: "a task in the old batch", kind: "task", batchId: oldBatch, source: "migration" },
    ]);
    // Inserted newest first, so "the first copy" has to come from createdAt,
    // not from insertion order.
    const [
      twoCopiesNew,
      twoCopiesOld,
      horizonOld,
      horizonNew,
      steerOld,
      steerNew,
      doneOld,
      doneNewLive,
      single,
      otherRepo,
      aTask,
      notMigration,
    ] = await seedTodos(t, [
      goal("o-standardize-ruling", newBatch, NEW),
      goal("o-standardize-ruling", oldBatch, OLD, { needs: [task] }),
      goal("formal-proofs-gold-standard", oldBatch, OLD),
      goal("formal-proofs-gold-standard", newBatch, NEW),
      goal("steering-grad-monitoring-cadence", oldBatch, OLD),
      goal("steering-grad-monitoring-cadence", newBatch, NEW),
      goal("select-family-pool-sizing", oldBatch, OLD, { status: "done", doneAt: OLD }),
      goal("select-family-pool-sizing", newBatch, NEW),
      goal("share-generations-packaging-ruling", newBatch, NEW),
      {
        ...goal("some-entry", oldBatch, OLD),
        statement: "tom.quest some-entry closed upstream",
        codeRepo: "tom.quest",
      },
      { ...goal("cgba-plant-fix", oldBatch, OLD), kind: "task" },
      { ...goal("cgba-plant-fix", oldBatch, OLD), source: "manual" },
    ]);
    return {
      oldBatch,
      newBatch,
      task,
      twoCopiesNew,
      twoCopiesOld,
      horizonOld,
      horizonNew,
      steerOld,
      steerNew,
      doneOld,
      doneNewLive,
      single,
      otherRepo,
      aTask,
      notMigration,
    };
  }

  const byId = async (t: ReturnType<typeof convexTest>) =>
    new Map((await t.run(async (ctx) => ctx.db.query("dtsTodos").collect())).map((r) => [r._id, r]));

  const firstRunCounts = {
    scanned: 12,
    converted: 4,
    "converted-to-waiting": 1,
    "duplicate-archived": 2,
    "steering-grad-archived": 2,
    "done-left": 1,
    "already-converted": 0,
    // The fixture seeds 4 of the 27 entries.
    "entry-without-goal": Object.keys(CLOSED_UPSTREAM_CONDITIONS).length - 4,
    "unlisted-left": 0,
  };

  it("names 27 entries to convert and 4 to archive, disjoint", () => {
    expect(Object.keys(CLOSED_UPSTREAM_CONDITIONS)).toHaveLength(27);
    expect(STEERING_GRAD_ENTRIES).toHaveLength(4);
    for (const entry of STEERING_GRAD_ENTRIES) {
      expect(CLOSED_UPSTREAM_CONDITIONS[entry]).toBeUndefined();
    }
    const horizon = Object.entries(CLOSED_UPSTREAM_CONDITIONS)
      .filter(([, c]) => c.tier === "H")
      .map(([entry]) => entry)
      .sort();
    expect(horizon).toEqual([
      "formal-proofs-gold-standard",
      "input-anomaly-mismatch-nulls",
      "train-time-corr-below-chance-detectors",
    ]);
  });

  // witness: keep the newest copy instead of the first, or leave the code
  // subject on the kept goal — the mirror would still own it, and a ruling on
  // it would be filed as a code ruling that CMT no longer takes.
  it("converts the first copy in place and archives the second, naming the kept id", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const report = await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    expect(report.counts).toEqual(firstRunCounts);

    const rows = await byId(t);
    const kept = rows.get(ids.twoCopiesOld)!;
    const condition = CLOSED_UPSTREAM_CONDITIONS["o-standardize-ruling"].condition;
    expect(kept.statement).toBe(condition);
    expect(kept.condition).toBe(condition);
    expect(kept.status).toBe("active");
    expect(kept.kind).toBe("goal");
    expect(kept.codeRepo).toBeUndefined();
    expect(kept.codeExternalId).toBeUndefined();
    expect(kept.batchId).toBe(ids.oldBatch);
    expect(kept.needs).toEqual([ids.task]);
    // The prepared brief describes the old wording: preparation is owed again.
    expect(kept.readiness).toBe("unprepared");

    const copy = rows.get(ids.twoCopiesNew)!;
    expect(copy.status).toBe("archived");
    expect(copy.archivedAt).toBeDefined();
    expect(copy.statement).toBe(closedUpstreamStatement("o-standardize-ruling"));
    expect(copy.unarchiveCondition).toBeUndefined();
    expect(copy.batchId).toBe(ids.newBatch);

    // A single copy is converted, and nothing is archived for it.
    const single = rows.get(ids.single)!;
    expect(single.statement).toBe(
      CLOSED_UPSTREAM_CONDITIONS["share-generations-packaging-ruling"].condition,
    );
    expect(single.status).toBe("active");

    // Nothing resurfaces: updatedAt is untouched on every row.
    for (const r of rows.values()) expect(r.updatedAt).toBe(NOW);

    const [event] = await eventsOfKind(t, `${CLOSED_UPSTREAM_MIGRATION}-migrated`);
    expect(event.data.counts).toEqual(firstRunCounts);
    expect(event.data.changes).toContainEqual({
      todoId: ids.twoCopiesOld,
      entry: "o-standardize-ruling",
      oldStatement: closedUpstreamStatement("o-standardize-ruling"),
      action: "converted",
      newStatement: condition,
      status: "active",
    });
    expect(event.data.changes).toContainEqual({
      todoId: ids.twoCopiesNew,
      entry: "o-standardize-ruling",
      oldStatement: closedUpstreamStatement("o-standardize-ruling"),
      action: "archived",
      reason: duplicateArchiveReason("o-standardize-ruling", ids.twoCopiesOld),
    });
    expect(duplicateArchiveReason("o-standardize-ruling", ids.twoCopiesOld)).toContain(
      ids.twoCopiesOld,
    );
  });

  // witness: store a horizon entry as active — a worker would pick up a goal
  // Tom parked.
  it("stores a tier-H entry as waiting, with no wake time", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    const rows = await byId(t);
    const kept = rows.get(ids.horizonOld)!;
    expect(kept.statement).toBe(
      CLOSED_UPSTREAM_CONDITIONS["formal-proofs-gold-standard"].condition,
    );
    expect(kept.status).toBe("waiting");
    expect(kept.wakeAt).toBeUndefined();
    expect(isReady(kept, buildDoneSet([...rows.values()]), NOW)).toBe(false);
    expect(rows.get(ids.horizonNew)!.status).toBe("archived");
  });

  // witness: convert a steering-grad entry like the rest — it would ask for a
  // steering row the amendment removed.
  it("archives every copy of a steering-grad entry with the amendment's reason", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const report = await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    const rows = await byId(t);
    for (const id of [ids.steerOld, ids.steerNew]) {
      expect(rows.get(id)!.status).toBe("archived");
      expect(rows.get(id)!.statement).toBe(
        closedUpstreamStatement("steering-grad-monitoring-cadence"),
      );
      expect(report.changes).toContainEqual({
        todoId: id,
        entry: "steering-grad-monitoring-cadence",
        oldStatement: closedUpstreamStatement("steering-grad-monitoring-cadence"),
        action: "archived",
        reason: STEERING_GRAD_ARCHIVE_REASON,
      });
    }
  });

  // witness: count the done copy as the first copy — the live one would be
  // archived and the entry's goal would read as met.
  it("leaves a done copy alone and converts the live one beside it", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    const rows = await byId(t);
    const done = rows.get(ids.doneOld)!;
    expect(done.status).toBe("done");
    expect(done.statement).toBe(closedUpstreamStatement("select-family-pool-sizing"));
    expect(done.codeExternalId).toBe("select-family-pool-sizing");
    expect(done.readiness).toBe("prepared");
    const live = rows.get(ids.doneNewLive)!;
    expect(live.status).toBe("active");
    expect(live.statement).toBe(
      CLOSED_UPSTREAM_CONDITIONS["select-family-pool-sizing"].condition,
    );
    expect(live.batchId).toBe(ids.newBatch);
  });

  it("leaves another repo's goal, a task, and a row it did not write untouched", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const before = await byId(t);
    await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    const after = await byId(t);
    for (const id of [ids.otherRepo, ids.aTask, ids.notMigration]) {
      expect(after.get(id)).toEqual(before.get(id));
    }
  });

  // witness: leave the code subject on the kept goal — the mirror's
  // goal-closing sweep would still close it from a registry entry.
  it("a converted goal is no longer closed by the code-todo mirror", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    await t.mutation(internal.tts.internalReplaceMirror, {
      repo: "ComplexMultiTrigger",
      rows: [
        {
          externalId: "o-standardize-ruling",
          tier: "R",
          status: "closed",
          statement: "o-standardize ruling",
          url: "https://github.com/Heffnt/ComplexMultiTrigger/blob/master/vqc/todos.yaml",
        },
      ],
    });
    expect((await byId(t)).get(ids.twoCopiesOld)!.status).toBe("active");
  });

  it("a dry run reports the same counts and changes and writes nothing but the dry-run event", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    const before = await byId(t);
    const report = await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.counts).toEqual(firstRunCounts);
    expect(await byId(t)).toEqual(before);
    expect(await eventsOfKind(t, `${CLOSED_UPSTREAM_MIGRATION}-migrated`)).toHaveLength(0);
    const [event] = await eventsOfKind(t, `${CLOSED_UPSTREAM_MIGRATION}-dry-run`);
    expect(event.data.changes).toEqual(report.changes);
  });

  // witness: match an entry by its completion test as well as by the old
  // wording — every run would rewrite the kept goal and log it again.
  it("is idempotent: a second run changes nothing", async () => {
    const t = convexTest({ schema, modules });
    await seed(t);
    await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    const between = await byId(t);
    const again = await t.mutation(internal.ttsMigrations.internalConvertClosedUpstreamGoals, {});
    expect(await byId(t)).toEqual(between);
    expect(again.changes.filter((c) => c.action !== "left")).toEqual([]);
    expect(again.counts).toEqual({
      ...firstRunCounts,
      converted: 0,
      "converted-to-waiting": 0,
      "duplicate-archived": 0,
      "steering-grad-archived": 0,
      "already-converted": 4,
    });
  });
});

// ── 9. Batches removed (Tom's ruling, 2026-09-24) ────────────────────────────

describe("batches removed (every todo stands alone)", () => {
  type T = ReturnType<typeof convexTest>;
  const NOW = 1_790_000_000_000;

  const insertRun = (t: T, runId: string, batchId?: Id<"batches">) =>
    t.run((ctx) =>
      ctx.db.insert("runs", {
        runId,
        rootRunId: runId,
        depth: 0,
        linkKnown: true,
        origin: "cron:plan-graphs",
        host: "box",
        cli: "claude",
        environment: "worker",
        parserVersion: "runs-parser-1",
        kind: "job",
        status: "ended",
        startedAt: 1_000,
        lastLineAt: 2_000,
        attachments: [],
        file: {
          path: "/var/log/run.jsonl",
          sourceHash: "a".repeat(64),
          storedHash: "b".repeat(64),
          bytes: 10,
          storedBytes: 8,
          committedLine: 1,
          committedPrefixSha256: "c".repeat(64),
        },
        ingestedAt: 3_000,
        ...(batchId === undefined ? {} : { batchId }),
      } as never),
    );

  /** Two batches and every case the migration names, plus a run on each side. */
  async function seed(t: T) {
    return await t.run(async (ctx) => {
      const batch = (statement: string, status: "active" | "archived" = "active") =>
        ctx.db.insert("batches", { statement, status, createdAt: 1, updatedAt: 5 });
      const lease = await batch("get the apartment");
      const paper = await batch("submit the paper");
      const todo = (
        statement: string,
        over: Partial<Doc<"dtsTodos">>,
      ) =>
        ctx.db.insert("dtsTodos", {
          statement,
          source: "migration",
          status: "active",
          timingClass: "whenever",
          readiness: "unprepared",
          createdAt: 1,
          updatedAt: 7,
          ...over,
        });
      const ids = {
        lease,
        paper,
        goal: await todo("the lease is signed", { kind: "goal", batchId: lease, source: "prospecting" }),
        doneGoal: await todo("the deposit is paid", { kind: "goal", batchId: lease, status: "done", doneAt: 3 }),
        migrationTask: await todo("call the landlord", { kind: "task", batchId: lease, actor: "tom" }),
        plannerTask: await todo("draft the questions", {
          kind: "task",
          batchId: lease,
          source: "planner",
          actor: "agent",
        }),
        touchedPlannerTask: await todo("read the lease", {
          kind: "task",
          batchId: lease,
          source: "planner",
          tomTouchedAt: 4,
        }),
        otherTask: await todo("ask about parking", { kind: "task", batchId: paper, source: "tts-session" }),
        donePlannerTask: await todo("book the viewing", {
          kind: "task",
          batchId: paper,
          source: "planner",
          status: "done",
          doneAt: 2,
        }),
        archivedTask: await todo("old step", { kind: "task", batchId: paper, source: "planner", status: "archived", archivedAt: 2 }),
        standalone: await todo("renew the passport", {}),
      };
      // The plan step the migration task needs: archived below, and an
      // archived need counts as done.
      await ctx.db.patch(ids.migrationTask, { needs: [ids.plannerTask] });
      return ids;
    });
  }
  type Ids = Awaited<ReturnType<typeof seed>>;

  const todos = async (t: T) =>
    new Map((await t.run((ctx) => ctx.db.query("dtsTodos").collect())).map((row) => [row._id, row]));

  async function runToEnd(t: T, args: { dryRun?: boolean } = {}) {
    vi.useFakeTimers();
    try {
      const first = await t.mutation(internal.ttsMigrations.internalRemoveBatches, args);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      return first;
    } finally {
      vi.useRealTimers();
    }
  }

  const summary = async (t: T, dryRun = false) => {
    const events = await eventsOfKind(
      t,
      `${BATCHES_REMOVED_MIGRATION}-${dryRun ? "dry-run" : "migrated"}`,
    );
    return events.map((e) => e.data);
  };

  const firstRunCounts = {
    "batches-scanned": 2,
    "batches-archived": 2,
    "batches-already-archived": 0,
    "batches-already-removed": 0,
    "goals-unbound": 2,
    "migration-tasks-made-standalone": 1,
    "other-tasks-made-standalone": 2,
    "planner-tasks-archived": 1,
    "done-or-archived-tasks-cleared": 2,
    "runs-scanned": 2,
    "runs-cleared": 1,
  };

  // witness: archive a migration task, clear a goal's kind, or write an
  // unarchiveCondition — each case below names where one of Tom's things went.
  it("unbinds goals, makes migration tasks standalone, archives planner tasks, and archives every batch", async () => {
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    await insertRun(t, "claude:box:on-a-batch", ids.lease);
    await insertRun(t, "claude:box:on-nothing");
    await runToEnd(t);
    vi.useRealTimers();
    const rows = await todos(t);
    const row = (id: Id<"dtsTodos">) => rows.get(id)!;

    // No todo carries a batchId any more, and no row is deleted.
    expect(rows.size).toBe(9);
    expect([...rows.values()].every((r) => r.batchId === undefined)).toBe(true);
    // Goals keep kind and status.
    expect(row(ids.goal)).toMatchObject({ kind: "goal", status: "active" });
    expect(row(ids.doneGoal)).toMatchObject({ kind: "goal", status: "done" });
    // A migration task (Tom's earlier todo) stands alone, as it was.
    expect(row(ids.migrationTask)).toMatchObject({ kind: "task", status: "active", actor: "tom" });
    // The planner's step is archived, with no return condition.
    expect(row(ids.plannerTask).status).toBe("archived");
    expect(row(ids.plannerTask).archivedAt).toBeTypeOf("number");
    expect(row(ids.plannerTask).unarchiveCondition).toBeUndefined();
    // A planner task Tom touched, and a task from another source, stand alone.
    expect(row(ids.touchedPlannerTask).status).toBe("active");
    expect(row(ids.otherTask).status).toBe("active");
    // Done and archived tasks keep their status.
    expect(row(ids.donePlannerTask).status).toBe("done");
    expect(row(ids.archivedTask).status).toBe("archived");
    // updatedAt is never bumped: nothing resurfaces on Tom's pile.
    expect([...rows.values()].every((r) => r.updatedAt === 7)).toBe(true);
    // needs stays, and the ready rule is unchanged: the archived plan step
    // counts as done, so the migration task that needed it is ready.
    expect(row(ids.migrationTask).needs).toEqual([ids.plannerTask]);
    expect(isReady(row(ids.migrationTask), buildDoneSet([...rows.values()]), NOW)).toBe(true);

    // Every batch is archived, its updatedAt untouched and no condition set.
    const batches = await t.run((ctx) => ctx.db.query("batches").collect());
    expect(batches.map((b) => [b.status, b.updatedAt, b.unarchiveCondition])).toEqual([
      ["archived", 5, undefined],
      ["archived", 5, undefined],
    ]);
    // runs.batchId is cleared.
    const runs = await t.run((ctx) => ctx.db.query("runs").collect());
    expect(runs.every((r) => r.batchId === undefined)).toBe(true);

    // One event per batch naming the batch, the ruling verbatim, and every id
    // grouped by what happened to it.
    const perBatch = await eventsOfKind(t, BATCH_REMOVED_EVENT);
    expect(perBatch.map((e) => e.data.batchId)).toEqual([ids.lease, ids.paper]);
    expect(perBatch[0].data).toMatchObject({
      batchId: ids.lease,
      statement: "get the apartment",
      ruling: BATCHES_REMOVED_RULING,
      goalsUnbound: [ids.goal, ids.doneGoal],
      migrationTasksMadeStandalone: [ids.migrationTask],
      otherTasksMadeStandalone: [ids.touchedPlannerTask],
      plannerTasksArchived: [ids.plannerTask],
      doneOrArchivedTasksCleared: [],
    });
    expect(perBatch[1].data).toMatchObject({
      statement: "submit the paper",
      goalsUnbound: [],
      otherTasksMadeStandalone: [ids.otherTask],
      doneOrArchivedTasksCleared: [ids.donePlannerTask, ids.archivedTask],
    });
    expect(BATCHES_REMOVED_RULING).toBe(
      "I dont want to have batches at all anymore because I want to remove structure to allow agents to freely move toward completing all todos in the best way they (or the orchistrator) see fit.",
    );
    expect(await summary(t)).toEqual([{ ...firstRunCounts, "todos-still-bound": 0 }]);
  });

  // witness: patch in the dry run — the counts must be known before anything
  // moves on prod.
  it("a dry run counts every case and writes nothing but its summary event", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    await insertRun(t, "claude:box:on-a-batch", ids.paper);
    const before = await todos(t);
    await runToEnd(t, { dryRun: true });
    expect(await todos(t)).toEqual(before);
    expect((await t.run((ctx) => ctx.db.query("batches").collect())).every((b) => b.status === "active")).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("runs").collect()))[0].batchId).toBe(ids.paper);
    expect(await eventsOfKind(t, BATCH_REMOVED_EVENT)).toHaveLength(0);
    expect(await summary(t)).toEqual([]);
    expect(await summary(t, true)).toEqual([
      { ...firstRunCounts, "runs-scanned": 1, "todos-still-bound": 8 },
    ]);
  });

  // witness: count an archived batch with no todos as archived again — the
  // verification run would not read zero.
  it("is idempotent: a second run reports zero changes", async () => {
    const t = convexTest({ schema, modules });
    const ids: Ids = await seed(t);
    await insertRun(t, "claude:box:on-a-batch", ids.lease);
    await runToEnd(t);
    const between = await todos(t);
    await runToEnd(t);
    expect(await todos(t)).toEqual(between);
    const [, second] = await summary(t);
    expect(second).toEqual({
      "batches-scanned": 2,
      "batches-archived": 0,
      "batches-already-archived": 0,
      "batches-already-removed": 2,
      "goals-unbound": 0,
      "migration-tasks-made-standalone": 0,
      "other-tasks-made-standalone": 0,
      "planner-tasks-archived": 0,
      "done-or-archived-tasks-cleared": 0,
      "runs-scanned": 1,
      "runs-cleared": 0,
      "todos-still-bound": 0,
    });
    expect(await eventsOfKind(t, BATCH_REMOVED_EVENT)).toHaveLength(2);
  });

  // witness: schedule the walk from a batchId call — "one batch" would walk
  // every batch.
  it("walks one named batch and schedules nothing", async () => {
    const t = convexTest({ schema, modules });
    const ids = await seed(t);
    const report = await t.mutation(internal.ttsMigrations.internalRemoveBatches, {
      batchId: ids.paper,
    });
    expect(report.done).toBe(true);
    expect(report.removal).toMatchObject({
      otherTasksMadeStandalone: [ids.otherTask],
      doneOrArchivedTasksCleared: [ids.donePlannerTask, ids.archivedTask],
    });
    const batches = await t.run((ctx) => ctx.db.query("batches").collect());
    expect(batches.find((b) => b._id === ids.lease)?.status).toBe("active");
    expect(batches.find((b) => b._id === ids.paper)?.status).toBe("archived");
    expect((await todos(t)).get(ids.goal)?.batchId).toBe(ids.lease);
    expect(await summary(t)).toEqual([]);
  });

  it("walks one batch per call", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest({ schema, modules });
      const ids = await seed(t);
      const first = await t.mutation(internal.ttsMigrations.internalRemoveBatches, {});
      expect(first).toMatchObject({ done: false, phase: "batches", batchId: ids.lease });
      expect(first.page["batches-scanned"]).toBe(1);
      const batches = await t.run((ctx) => ctx.db.query("batches").collect());
      expect(batches.map((b) => b.status)).toEqual(["archived", "active"]);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The worker key taken out of stored rows ─────────────────────────────────
describe("internalScrubWorkerKeyRows (the worker key out of stored rows)", () => {
  // A fake value: the harness's own, never the deployment's.
  const KEY = "fake-worker-key-0123456789abcdef";
  const AGENT = "claude:box:scrub-agent";
  const OTHER = "claude:box:clean-agent";
  const PV = "runs-parser-1";
  const provenance = { fileVersion: "a".repeat(64), file: "f.jsonl", lineStart: 1, lineEnd: 1, block: 0, parserVersion: PV, sourceKind: "assistant" };

  async function insertRow(
    t: ReturnType<typeof convexTest>,
    runId: string,
    seq: number,
    content: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const kind = "tool-result";
    const digest = await rowDigest(PV, runId, seq, kind, content);
    return await t.run((ctx) => ctx.db.insert("claudeMessages", {
      runId, seq, turn: 0, kind, content, provenance, digest, depth: 0, createdAt: seq + 1, ...extra,
    } as never));
  }

  async function sha256Hex(text: string) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** A row with an overflow payload whose value lies across the chunk boundary. */
  async function insertOverflow(t: ReturnType<typeof convexTest>, runId: string, seq: number, whole: string, cut: number) {
    const texts = [whole.slice(0, cut), whole.slice(cut)];
    await insertRow(t, runId, seq, { text: whole.slice(0, 10), truncation: "cut" }, {
      overflow: { sha256: await sha256Hex(whole), byteLength: new TextEncoder().encode(whole).length, chunkCount: 2 },
    });
    await t.run(async (ctx) => {
      for (const [index, text] of texts.entries()) {
        await ctx.db.insert("claudeMessageOverflow", { runId, seq, index, chunkCount: 2, text, createdAt: 1 });
      }
    });
  }

  async function runToEnd(t: ReturnType<typeof convexTest>, args: { agentIds: string[]; dryRun?: boolean; pageSize?: number }) {
    vi.useFakeTimers();
    try {
      await t.mutation(internal.ttsMigrations.internalScrubWorkerKeyRows, args);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  }

  const rowsOf = (t: ReturnType<typeof convexTest>) =>
    t.run((ctx) => ctx.db.query("claudeMessages").collect());
  const chunksOf = (t: ReturnType<typeof convexTest>) =>
    t.run((ctx) => ctx.db.query("claudeMessageOverflow").collect());

  async function seed(t: ReturnType<typeof convexTest>) {
    await insertRow(t, AGENT, 0, { text: "clean line" });
    await insertRow(t, AGENT, 1, { content: [{ type: "text", text: `TTS_WORKER_KEY=${KEY}\nand ${encodeURIComponent(KEY)}` }], toolUseId: "t1" });
    await insertRow(t, AGENT, 2, { text: "also clean" });
    await insertOverflow(t, AGENT, 3, `head ${KEY} middle ${KEY} tail`, 12);
    await insertRow(t, OTHER, 0, { text: "nothing here" });
  }

  it("replaces the value in a row and its overflow, recomputes the content hashes, and leaves other rows alone", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    try {
      const t = convexTest({ schema, modules });
      await seed(t);
      const before = await rowsOf(t);
      await runToEnd(t, { agentIds: [AGENT, OTHER], pageSize: 2 });
      const after = await rowsOf(t);
      const changed = after.find((r) => r.runId === AGENT && r.seq === 1)!;
      expect(JSON.stringify(changed.content)).not.toContain(KEY);
      expect(changed.content).toEqual({ content: [{ type: "text", text: `TTS_WORKER_KEY=${WORKER_KEY_MARKER}\nand ${WORKER_KEY_MARKER}` }], toolUseId: "t1" });
      expect(changed.seq).toBe(1);
      expect(changed.digest).toBe(await rowDigest(PV, AGENT, 1, "tool-result", changed.content));
      // Every row without the value is exactly as it was.
      for (const row of before.filter((r) => !(r.runId === AGENT && (r.seq === 1)))) {
        const now = after.find((r) => r._id === row._id)!;
        if (row.seq === 3 && row.runId === AGENT) {
          expect({ ...now, overflow: undefined }).toEqual({ ...row, overflow: undefined });
        } else {
          expect(now).toEqual(row);
        }
      }
      const chunks = (await chunksOf(t)).sort((a, b) => a.index - b.index);
      const whole = chunks.map((c) => c.text).join("");
      expect(whole).toBe(`head ${WORKER_KEY_MARKER} middle ${WORKER_KEY_MARKER} tail`);
      expect(chunks.map((c) => c.chunkCount)).toEqual([2, 2]);
      const stamped = after.find((r) => r.runId === AGENT && r.seq === 3)!;
      expect(stamped.overflow).toEqual({ sha256: await sha256Hex(whole), byteLength: whole.length, chunkCount: 2 });
      const [event] = await eventsOfKind(t, WORKER_KEY_ROWS_SCRUBBED);
      expect(event.data).toEqual({
        agents: 2, rowsScanned: 5, rowsChanged: 1, chunksScanned: 2, chunksChanged: 2,
        digestsRecomputed: 1, digestsKept: 0, stampsRecomputed: 1, stampsKept: 0,
        agentsWithHits: [AGENT], oversized: [],
      });
      expect(JSON.stringify(event.data)).not.toContain(KEY);
      // Idempotent: a second run finds nothing.
      await runToEnd(t, { agentIds: [AGENT, OTHER] });
      const second = (await eventsOfKind(t, WORKER_KEY_ROWS_SCRUBBED))[1];
      expect(second.data).toMatchObject({ rowsChanged: 0, chunksChanged: 0, agentsWithHits: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a dry run changes nothing and counts what it would change", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    try {
      const t = convexTest({ schema, modules });
      await seed(t);
      const rows = await rowsOf(t);
      const chunks = await chunksOf(t);
      await runToEnd(t, { agentIds: [OTHER, AGENT], dryRun: true });
      expect(await rowsOf(t)).toEqual(rows);
      expect(await chunksOf(t)).toEqual(chunks);
      expect(await eventsOfKind(t, WORKER_KEY_ROWS_SCRUBBED)).toHaveLength(0);
      const [event] = await eventsOfKind(t, `${WORKER_KEY_ROWS_SCRUBBED}-dry-run`);
      expect(event.data).toMatchObject({ agents: 2, rowsScanned: 5, rowsChanged: 1, chunksChanged: 2, agentsWithHits: [AGENT] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a digest it cannot reproduce, and lists a payload too large for one transaction", async () => {
    vi.stubEnv("TTS_WORKER_KEY", KEY);
    try {
      const t = convexTest({ schema, modules });
      const id = await insertRow(t, AGENT, 0, { text: KEY });
      await t.run((ctx) => ctx.db.patch(id, { digest: "0123456789abcdef" }));
      const big = SCRUB_CHUNKS_PER_ROW_MAX + 1;
      await t.run(async (ctx) => {
        for (let index = 0; index < big; index++) {
          await ctx.db.insert("claudeMessageOverflow", { runId: AGENT, seq: 7, index, chunkCount: big, text: KEY, createdAt: 1 });
        }
      });
      await runToEnd(t, { agentIds: [AGENT] });
      const [row] = await rowsOf(t);
      expect(row.content).toEqual({ text: WORKER_KEY_MARKER });
      expect(row.digest).toBe("0123456789abcdef");
      expect((await chunksOf(t)).every((c) => c.text === KEY)).toBe(true);
      const [event] = await eventsOfKind(t, WORKER_KEY_ROWS_SCRUBBED);
      expect(event.data).toMatchObject({ rowsChanged: 1, digestsKept: 1, digestsRecomputed: 0, oversized: [{ agentId: AGENT, seq: 7 }] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to run when the key is unset or short", async () => {
    const t = convexTest({ schema, modules });
    await insertRow(t, AGENT, 0, { text: "x" });
    try {
      vi.stubEnv("TTS_WORKER_KEY", undefined);
      await expect(t.mutation(internal.ttsMigrations.internalScrubWorkerKeyRows, { agentIds: [AGENT] })).rejects.toThrow(/refused/);
      vi.stubEnv("TTS_WORKER_KEY", "short");
      await expect(t.mutation(internal.ttsMigrations.internalScrubWorkerKeyRows, { agentIds: [AGENT], dryRun: true })).rejects.toThrow(/refused/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await eventsOfKind(t, `${WORKER_KEY_ROWS_SCRUBBED}-dry-run`)).toHaveLength(0);
  });
});
