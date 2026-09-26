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
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import {
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
// words, a v1 batch's members and its plan, a brief's
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
      return { sessions, briefs };
    });
  }

  const expectedTotals = {
    "dtsTodos-scanned": 6,
    "claudeSessions-scanned": 3,
    "dtsCodeBriefs-scanned": 2,
    "latestSafeAt-cleared": 2,
    "wakeCondition-cleared": 1,
    "importance-cleared": 2,
    "members-cleared": 1,
    "plan-cleared": 2,
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
    "awaiting-permission-ended": 0,
    "brief-importance-cleared": 0,
    "recommendation-normalized": 0,
  };

  /** One call, walking all three tables: a pageSize past the biggest table
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
    expect(await eventsOfKind(t, RETIRED_FIELD_CLEARED)).toHaveLength(12);
  });

  // witness: drop the cursor from the continuation and a resumed run starts
  // the table again; drop the table hand-off and two of the three tables are
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
    expect(second.nextTable).toBe("claudeSessions");
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

  const goal = (
    entry: string,
    createdAt: number,
    extra: Partial<Doc<"dtsTodos">> = {},
  ): Seed => ({
    statement: closedUpstreamStatement(entry),
    condition: closedUpstreamStatement(entry),
    kind: "goal",
    codeRepo: "ComplexMultiTrigger",
    codeExternalId: entry,
    readiness: "prepared",
    brief: `a brief about ${entry} being closed upstream`,
    source: "migration",
    createdAt,
    ...extra,
  });

  /** The two-copy case, a tier-H entry, the steering-grad case, the done
   * case, a single copy, and three rows that are not this migration's. */
  async function seed(t: ReturnType<typeof convexTest>) {
    const [task] = await seedTodos(t, [
      { statement: "a task the old goal needs", kind: "task", source: "migration" },
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
      goal("o-standardize-ruling", NEW),
      goal("o-standardize-ruling", OLD, { needs: [task] }),
      goal("formal-proofs-gold-standard", OLD),
      goal("formal-proofs-gold-standard", NEW),
      goal("steering-grad-monitoring-cadence", OLD),
      goal("steering-grad-monitoring-cadence", NEW),
      goal("select-family-pool-sizing", OLD, { status: "done", doneAt: OLD }),
      goal("select-family-pool-sizing", NEW),
      goal("share-generations-packaging-ruling", NEW),
      {
        ...goal("some-entry", OLD),
        statement: "tom.quest some-entry closed upstream",
        codeRepo: "tom.quest",
      },
      { ...goal("cgba-plant-fix", OLD), kind: "task" },
      { ...goal("cgba-plant-fix", OLD), source: "manual" },
    ]);
    return {
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
    expect(kept.needs).toEqual([ids.task]);
    // The prepared brief describes the old wording: preparation is owed again.
    expect(kept.readiness).toBe("unprepared");

    const copy = rows.get(ids.twoCopiesNew)!;
    expect(copy.status).toBe("archived");
    expect(copy.archivedAt).toBeDefined();
    expect(copy.statement).toBe(closedUpstreamStatement("o-standardize-ruling"));
    expect(copy.unarchiveCondition).toBeUndefined();

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
