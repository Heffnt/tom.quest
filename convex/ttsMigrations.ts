// The lifeos update, phase 7 — the MIGRATE step of widen → migrate → narrow
// (design revision 4, section 3, "TTS data model, phase 7 target"). One home
// for every row mapping the retirement matrix (docs/lifeos-retirement.md)
// calls for, so they share one shape:
//
//   - RESUMABLE. Each run maps ONE PAGE of rows (`pageSize`, default
//     PAGE_SIZE) and, when the table has more, schedules itself with the
//     page's continue cursor and the running totals. A crash mid-table costs
//     one page; the next call from where it stopped, or a fresh call from the
//     start, finishes the job, because every mapping is IDEMPOTENT — a row
//     already in its target shape is counted and left alone.
//   - DRY RUN. `dryRun: true` walks the same pages and produces the same
//     counts without writing a row, so the numbers are known before anything
//     moves. Run against the local test harness first (convex/
//     ttsMigrations.test.ts), never against prod on a guess.
//   - COUNTED. The totals of a finished walk are written as one dtsEvents row
//     (kind `<name>-migrated`, or `<name>-dry-run`), which is how a scheduled
//     chain reports when the CLI call that started it has long returned. A
//     single call with a pageSize larger than the table finishes in one
//     transaction and returns the totals directly:
//       npx convex run ttsMigrations:internalMigrateReadiness '{"dryRun":true,"pageSize":5000}'
//   - NOTHING DELETED, NOTHING RESURFACED. A mapping patches the fields it
//     maps and never bumps updatedAt — a migration must not put settled items
//     back on Tom's pile. Retired fields are left in place until NARROW.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { GRAPH_SUPERSEDED, logEvent } from "./tts";
import { CONDITION_WINDOW_MS, normalizeReadiness } from "./ttsShared";

/** Rows per transaction. dtsTodos is a few hundred rows; this keeps one page
 * far inside Convex's per-transaction read and write limits. */
export const PAGE_SIZE = 200;

/** The one arg shape every migration here takes. */
const MIGRATION_ARGS = {
  cursor: v.optional(v.union(v.string(), v.null())),
  dryRun: v.optional(v.boolean()),
  pageSize: v.optional(v.number()),
  /** Running totals carried across scheduled continuations; never passed by
   * a caller. */
  totals: v.optional(v.record(v.string(), v.number())),
};
type MigrationArgs = {
  cursor?: string | null;
  dryRun?: boolean;
  pageSize?: number;
  totals?: Record<string, number>;
};

/** Count keys are ASCII (a Convex record key), spelled "<from>-to-<to>". */
type Counts = Record<string, number>;

function addCounts(into: Counts, page: Counts): Counts {
  const out = { ...into };
  for (const [k, n] of Object.entries(page)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** The report a run returns: this page's counts, the totals so far, and
 * whether the walk is finished (else the cursor the continuation carries). */
type MigrationReport = {
  done: boolean;
  dryRun: boolean;
  page: Counts;
  totals: Counts;
  continueCursor: string | null;
};

/**
 * One page of a dtsTodos walk: map each row, add the page to the totals,
 * then either record the finished totals as one event or schedule `self`
 * with the cursor and the totals.
 */
async function walkTodos(
  ctx: MutationCtx,
  args: MigrationArgs,
  name: string,
  self: typeof internal.ttsMigrations.internalMigrateReadiness,
  page: Counts,
  mapRow: (row: Doc<"dtsTodos">, dryRun: boolean) => Promise<void>,
): Promise<MigrationReport> {
  const dryRun = args.dryRun ?? false;
  const pageSize = args.pageSize ?? PAGE_SIZE;
  const result = await ctx.db
    .query("dtsTodos")
    .paginate({ cursor: args.cursor ?? null, numItems: pageSize });
  for (const row of result.page) {
    page.scanned = (page.scanned ?? 0) + 1;
    await mapRow(row, dryRun);
  }
  const totals = addCounts(args.totals ?? {}, page);
  if (result.isDone) {
    await logEvent(ctx, dryRun ? `${name}-dry-run` : `${name}-migrated`, undefined, totals);
    return { done: true, dryRun, page, totals, continueCursor: null };
  }
  await ctx.scheduler.runAfter(0, self, {
    cursor: result.continueCursor,
    dryRun,
    pageSize,
    totals,
  });
  return { done: false, dryRun, page, totals, continueCursor: result.continueCursor };
}

// ── 1. Readiness to two values (ruling 18) ──────────────────────────────────
// ready-for-tom → prepared, preparing → prepared, unprepared stays. The
// stored value moves; whether a prepared row is READY for Tom is computed
// from then on (ttsShared.isReadyForTom).
export const READINESS_MIGRATION = "readiness";

export const internalMigrateReadiness = internalMutation({
  args: MIGRATION_ARGS,
  handler: async (ctx, args): Promise<MigrationReport> => {
    const page: Counts = {
      scanned: 0,
      "ready-for-tom-to-prepared": 0,
      "preparing-to-prepared": 0,
      prepared: 0,
      unprepared: 0,
    };
    return await walkTodos(
      ctx,
      args,
      READINESS_MIGRATION,
      internal.ttsMigrations.internalMigrateReadiness,
      page,
      async (row, dryRun) => {
        const target = normalizeReadiness(row.readiness);
        if (row.readiness === target) {
          page[target]++;
          return;
        }
        page[`${row.readiness}-to-${target}`]++;
        if (!dryRun) await ctx.db.patch(row._id, { readiness: target });
      },
    );
  },
});

// ── 3. The retired timing fields (section 3, "row mapping") ─────────────────
// Four mappings, one walk:
//   waiting row     → status active, its wakeAt kept: the sleep is the wakeAt
//                     on an active row (ttsShared.isReady honours it). A wait
//                     in words alone (wakeCondition, no time) has no instant
//                     to sleep until, so the sentence goes where every other
//                     condition goes — into the statement — and the row is
//                     awake: Tom sees it and decides.
//   condition-bound → a task whose statement carries the condition sentence,
//                     asleep until latestSafeAt minus the 14-day window when
//                     latestSafeAt is set (the fallback queue's own horizon),
//                     and timingClass rewritten to what the row's date says so
//                     no old reader files it under the retired lane. A
//                     condition-bound GOAL keeps its kind: its condition was a
//                     trigger (ttsShared.goalCheckable), and it is carried the
//                     same way; only the kind is not invented.
//   archived row    → its return condition (unarchiveCondition) stays where
//                     it is; the weekly gather lists archived rows whose
//                     sentence names one. Counted here, never written. The
//                     graph migration's "superseded by graph batch" pointer is
//                     not a return condition and is counted apart.
//   members / plan  → the existing, tested graph migration
//                     (tts.internalMigrateToGraph), run on its own; this walk
//                     only counts the v1 batches still waiting for it.
export const TIMING_MIGRATION = "timing";

/** The statement with the condition sentence carried into it. Idempotent: a
 * statement that already carries the sentence is returned as it is. */
export function carryCondition(statement: string, condition: string | undefined): string {
  const sentence = condition?.trim() ?? "";
  if (sentence === "") return statement;
  if (statement.includes(sentence)) return statement;
  return `${statement} — when: ${sentence}`;
}

export const internalMigrateTiming = internalMutation({
  args: MIGRATION_ARGS,
  handler: async (ctx, args): Promise<MigrationReport> => {
    const page: Counts = {
      scanned: 0,
      "waiting-to-active": 0,
      "waiting-condition-carried": 0,
      "condition-bound-to-task": 0,
      "condition-bound-goal-kept": 0,
      "condition-wake-set": 0,
      "archived-with-return-condition": 0,
      "archived-superseded-by-graph": 0,
      "v1-batches-pending-graph-migration": 0,
    };
    return await walkTodos(
      ctx,
      args,
      TIMING_MIGRATION,
      internal.ttsMigrations.internalMigrateTiming,
      page,
      async (row, dryRun) => {
        // (a) a stored waiting row becomes active with its wakeAt.
        if (row.status === "waiting") {
          page["waiting-to-active"]++;
          const patch: Partial<Doc<"dtsTodos">> = { status: "active" };
          if (row.wakeAt === undefined && row.wakeCondition !== undefined) {
            page["waiting-condition-carried"]++;
            patch.statement = carryCondition(row.statement, row.wakeCondition);
          }
          if (!dryRun) {
            await ctx.db.patch(row._id, patch);
            await logEvent(ctx, "status-changed", row._id, {
              from: "waiting",
              to: "active",
              note: "lifeos migration: a sleep is a wakeAt on an active row",
              wakeAt: row.wakeAt,
              wakeCondition: row.wakeCondition,
            });
          }
        }
        // (b) a condition-bound row becomes a task carrying its condition.
        if (row.timingClass === "condition-bound") {
          const isGoal = row.kind === "goal";
          page[isGoal ? "condition-bound-goal-kept" : "condition-bound-to-task"]++;
          const patch: Partial<Doc<"dtsTodos">> = {
            statement: carryCondition(row.statement, row.condition),
            timingClass: row.dueAt !== undefined ? "dated" : "whenever",
          };
          if (!isGoal) patch.kind = "task";
          if (row.latestSafeAt !== undefined) {
            page["condition-wake-set"]++;
            patch.wakeAt = row.latestSafeAt - CONDITION_WINDOW_MS;
          }
          if (!dryRun) {
            await ctx.db.patch(row._id, patch);
            await logEvent(ctx, "timing-mapped", row._id, {
              before: {
                timingClass: row.timingClass,
                condition: row.condition,
                latestSafeAt: row.latestSafeAt,
                statement: row.statement,
              },
              after: { ...patch },
            });
          }
        }
        // (c) an archived row's return condition stays; count it.
        if (row.status === "archived" && (row.unarchiveCondition ?? "").trim() !== "") {
          page[
            row.unarchiveCondition!.startsWith(GRAPH_SUPERSEDED)
              ? "archived-superseded-by-graph"
              : "archived-with-return-condition"
          ]++;
        }
        // (d) members and plan: the graph migration's own work; count it.
        if (row.members !== undefined && row.status === "active") {
          page["v1-batches-pending-graph-migration"]++;
        }
      },
    );
  },
});
