import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import { READINESS_MIGRATION, TIMING_MIGRATION, carryCondition } from "./ttsMigrations";
import { CONDITION_WINDOW_MS, DAY_MS, buildDoneSet, isReady } from "./ttsShared";

// The phase-7 row mappings (convex/ttsMigrations.ts): resumable, dry-runnable,
// idempotent, and counted. These tests are the local harness the design says
// every dry run is measured against BEFORE anything runs on prod.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

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

describe("readiness migration (ready-for-tom | preparing → prepared)", () => {
  const seed = (): Seed[] => [
    { statement: "raw", readiness: "unprepared" },
    { statement: "briefed", readiness: "ready-for-tom" },
    { statement: "half", readiness: "preparing" },
    { statement: "already", readiness: "prepared" },
    { statement: "done long ago", readiness: "ready-for-tom", status: "done" },
  ];

  // witness: map "preparing" to "unprepared" in ttsMigrations — the counts
  // below name each spelling's destination, so the mapping cannot drift
  // from ttsShared.normalizeReadiness unnoticed.
  it("maps both retired spellings to prepared and leaves unprepared alone", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {});
    expect(report.done).toBe(true);
    expect(report.totals).toEqual({
      scanned: 5,
      "ready-for-tom-to-prepared": 2,
      "preparing-to-prepared": 1,
      prepared: 1,
      unprepared: 1,
    });
    const rows = await allTodos(t);
    const byStatement = Object.fromEntries(rows.map((r) => [r.statement, r]));
    expect(byStatement.raw.readiness).toBe("unprepared");
    expect(byStatement.briefed.readiness).toBe("prepared");
    expect(byStatement.half.readiness).toBe("prepared");
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
  it("a dry run reports the same counts and writes no row", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateReadiness, {
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.totals).toEqual({
      scanned: 5,
      "ready-for-tom-to-prepared": 2,
      "preparing-to-prepared": 1,
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
    expect(second.totals["preparing-to-prepared"]).toBe(1);
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
        "preparing-to-prepared": 1,
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
      "preparing-to-prepared": 0,
      prepared: 4,
      unprepared: 1,
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
    scanned: 9,
    "waiting-to-active": 2,
    "waiting-condition-carried": 1,
    "condition-bound-to-task": 2,
    "condition-bound-goal-kept": 1,
    "condition-wake-set": 2,
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
    expect(changes).toHaveLength(2);
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
    expect(await eventsOfKind(t, "timing-mapped")).toHaveLength(3);
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

  it("a dry run reports the same counts and writes no row", async () => {
    const t = convexTest({ schema, modules });
    await seedTodos(t, seed());
    const report = await t.mutation(internal.ttsMigrations.internalMigrateTiming, {
      dryRun: true,
    });
    expect(report.totals).toEqual(expectedTotals);
    const rows = await allTodos(t);
    expect(rows.filter((r) => r.status === "waiting")).toHaveLength(2);
    expect(rows.filter((r) => r.timingClass === "condition-bound")).toHaveLength(3);
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
    });
    expect(await eventsOfKind(t, "status-changed")).toHaveLength(2);
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
