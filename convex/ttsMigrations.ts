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
//     back on Tom's pile. A value mapping leaves the retired FIELD in place;
//     emptying the field itself is the clearing walk at the bottom of this
//     file, and it is what the narrow waits on.
//   - LOOSE READS AFTER THE NARROW. Once a walk has run and been verified,
//     the validator narrows past the shape it maps (docs/lifeos-retirement.md).
//     A row on the deployment can still hold a value the schema no longer
//     declares, and Convex returns it, so each walk reads its retired field
//     through a loose view of the row rather than the generated Doc type —
//     which is what keeps a re-run (the verification step) runnable.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { GRAPH_SUPERSEDED, logEvent } from "./tts";
import {
  CONDITION_WINDOW_MS,
  MAX_NEEDS,
  normalizeReadiness,
  normalizeRecommendation,
  type StoredReadiness,
  type StoredRecommendation,
} from "./ttsShared";

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
// ready-for-tom → prepared, preparing → unprepared; prepared and unprepared
// stay. One reading per spelling (ttsShared.normalizeReadiness is the one
// home, and this walk writes exactly what it reads), so the counts below name
// each retired spelling's one destination. A "preparing" row was half
// written up; it goes back to the preparer rather than onto Tom's pile, since
// a half-prepared capture is never ready. Whether a prepared row is READY for
// Tom is computed from then on (ttsShared.isReadyForTom).
// RUN AND VERIFIED on prod (2026-09-06: 1392 rows, both retired counts zero on
// the second run); the validator has narrowed to the two values since.
export const READINESS_MIGRATION = "readiness";

export const internalMigrateReadiness = internalMutation({
  args: MIGRATION_ARGS,
  handler: async (ctx, args): Promise<MigrationReport> => {
    const page: Counts = {
      scanned: 0,
      "ready-for-tom-to-prepared": 0,
      "preparing-to-unprepared": 0,
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
        const stored = (row as { readiness: StoredReadiness }).readiness;
        const target = normalizeReadiness(stored);
        if (stored === target) {
          page[target]++;
          return;
        }
        page[`${stored}-to-${target}`]++;
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
//                     latestSafeAt is set (the fallback queue's own horizon)
//                     and the row has no wakeAt of its own (one it has is
//                     Tom's and stays), and timingClass rewritten to what the
//                     row's date says so no old reader files it under the
//                     retired lane. A condition-bound GOAL keeps its kind:
//                     its condition was a trigger (ttsShared.goalCheckable),
//                     and it is carried the same way; only the kind is not
//                     invented. A done or archived row is mapped for the
//                     validator only — shape, never a sleep.
//   both at once    → one patch: a row that is waiting AND condition-bound
//                     carries both sentences, in that order.
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
      "condition-wake-kept": 0,
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
        // ONE patch per row. A row can be both a stored waiting row and
        // condition-bound; (a) and (b) each add to the same patch and the
        // same statement, so the second mapping cannot overwrite what the
        // first carried in, and one write lands both.
        const patch: Partial<Doc<"dtsTodos">> = {};
        const terminal = row.status === "done" || row.status === "archived";
        let statement = row.statement;
        // (a) a stored waiting row becomes active with its wakeAt.
        if (row.status === "waiting") {
          page["waiting-to-active"]++;
          patch.status = "active";
          if (row.wakeAt === undefined && row.wakeCondition !== undefined) {
            page["waiting-condition-carried"]++;
            statement = carryCondition(statement, row.wakeCondition);
          }
        }
        // (b) a condition-bound row becomes a task carrying its condition.
        if (row.timingClass === "condition-bound") {
          const isGoal = row.kind === "goal";
          page[isGoal ? "condition-bound-goal-kept" : "condition-bound-to-task"]++;
          statement = carryCondition(statement, row.condition);
          patch.timingClass = row.dueAt !== undefined ? "dated" : "whenever";
          if (!isGoal) patch.kind = "task";
          // The sleep is latestSafeAt minus the window — unless the row
          // already has a wakeAt, which is Tom's (set by hand, or the time a
          // waiting row was already sleeping until) and stays. A done or
          // archived row gets no sleep at all: its shape is mapped so the
          // retired value leaves the validator, but a wakeAt written on a
          // finished row would be read as a real sleep the day it is
          // reopened.
          if (row.latestSafeAt !== undefined && !terminal) {
            if (row.wakeAt === undefined) {
              page["condition-wake-set"]++;
              patch.wakeAt = row.latestSafeAt - CONDITION_WINDOW_MS;
            } else {
              page["condition-wake-kept"]++;
            }
          }
        }
        if (statement !== row.statement) patch.statement = statement;
        if (!dryRun && Object.keys(patch).length > 0) {
          await ctx.db.patch(row._id, patch);
          if (row.status === "waiting") {
            await logEvent(ctx, "status-changed", row._id, {
              from: "waiting",
              to: "active",
              note: "lifeos migration: a sleep is a wakeAt on an active row",
              wakeAt: row.wakeAt,
              wakeCondition: row.wakeCondition,
            });
          }
          if (row.timingClass === "condition-bound") {
            await logEvent(ctx, "timing-mapped", row._id, {
              before: {
                timingClass: row.timingClass,
                condition: row.condition,
                latestSafeAt: row.latestSafeAt,
                wakeAt: row.wakeAt,
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

// ── 4. batches.path → batches.needs ─────────────────────────────────────────
// The retired path (name, index, edge to the previous batch) becomes needs
// edges between batches: a batch whose edge is "must" needs the previous
// batch on its path (the one with the greatest index below its own); a
// "helps" edge becomes nothing — "only makes this easier" is not a
// prerequisite, and needs holds prerequisites only; a first or unlinked
// batch needs nothing. The path is left in place until NARROW.
//
// One transaction: the batches table is human-scale (a few dozen rows for
// years, per its schema comment), and deriving an edge needs the whole path
// in view. Same dry run, counts, idempotence, and event as the walks above.
export const BATCH_NEEDS_MIGRATION = "batch-needs";

/** The previous batch on a path: the greatest index below `index`. Two
 * batches sharing that index (the planner never wrote one, but nothing
 * refused it) tie, and the first in `all` — table order, oldest first — wins:
 * the strict `>` below keeps the one already found. Stated so the derived
 * edge is the same on every run. */
export function previousOnPath<T extends { path?: { name: string; index: number } }>(
  batch: T,
  all: readonly T[],
): T | undefined {
  const path = batch.path;
  if (!path) return undefined;
  let best: T | undefined;
  for (const other of all) {
    if (other === batch || !other.path || other.path.name !== path.name) continue;
    if (other.path.index >= path.index) continue;
    if (!best || other.path.index > best.path!.index) best = other;
  }
  return best;
}

export const internalMigrateBatchNeeds = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }): Promise<MigrationReport> => {
    const all = await ctx.db.query("batches").collect();
    const page: Counts = {
      scanned: all.length,
      "must-to-need": 0,
      "must-without-previous": 0,
      "helps-dropped": 0,
      "unlinked": 0,
      "already-derived": 0,
      "no-path": 0,
    };
    for (const batch of all) {
      if (!batch.path) {
        page["no-path"]++;
        continue;
      }
      if (batch.path.edge === "helps") {
        page["helps-dropped"]++;
        continue;
      }
      if (batch.path.edge !== "must") {
        page.unlinked++;
        continue;
      }
      const previous = previousOnPath(batch, all);
      if (!previous) {
        page["must-without-previous"]++;
        continue;
      }
      if ((batch.needs ?? []).includes(previous._id)) {
        page["already-derived"]++;
        continue;
      }
      page["must-to-need"]++;
      if (!dryRun) {
        const needs = [...(batch.needs ?? []), previous._id].slice(0, MAX_NEEDS);
        await ctx.db.patch(batch._id, { needs });
        await logEvent(ctx, "batch-needs-derived", undefined, {
          batchId: batch._id,
          needs: previous._id,
          path: batch.path,
        });
      }
    }
    await logEvent(
      ctx,
      dryRun ? `${BATCH_NEEDS_MIGRATION}-dry-run` : `${BATCH_NEEDS_MIGRATION}-migrated`,
      undefined,
      page,
    );
    return { done: true, dryRun, page, totals: page, continueCursor: null };
  },
});

// ── 6. Code-brief recommendation → the four verdict words ───────────────────
// stale-replan → revise, needs-session → session, propose-archive → archive;
// approve stays. One transaction: one brief per open code todo, a small
// table. Same dry run, counts, idempotence, and event.
export const RECOMMENDATION_MIGRATION = "recommendation";

export const internalMigrateRecommendations = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }): Promise<MigrationReport> => {
    const all = await ctx.db.query("dtsCodeBriefs").collect();
    const page: Counts = {
      scanned: all.length,
      "stale-replan-to-revise": 0,
      "needs-session-to-session": 0,
      "propose-archive-to-archive": 0,
      "already-verdict-word": 0,
    };
    for (const brief of all) {
      const target = normalizeRecommendation(brief.recommendation);
      if (brief.recommendation === target) {
        page["already-verdict-word"]++;
        continue;
      }
      page[`${brief.recommendation}-to-${target}`]++;
      if (!dryRun) await ctx.db.patch(brief._id, { recommendation: target });
    }
    await logEvent(
      ctx,
      dryRun
        ? `${RECOMMENDATION_MIGRATION}-dry-run`
        : `${RECOMMENDATION_MIGRATION}-migrated`,
      undefined,
      page,
    );
    return { done: true, dryRun, page, totals: page, continueCursor: null };
  },
});

// ── 7. The clearing walk: every retired value out of every row ──────────────
// THE DEPLOY GATE. `convex/schema.ts` calls `defineSchema` with
// `schemaValidation` left at its default, which is TRUE: `convex deploy`
// validates EVERY existing document of a still-declared table against the
// validator being deployed, and a document carrying a field the validator no
// longer declares — or a union literal it no longer lists — is rejected. The
// deploy fails and the site does not update. Convex's removal order is
// therefore three steps, not two: make the field optional, CLEAR IT FROM EVERY
// ROW, then drop the declaration. A whole TABLE is the exception (AGENTS.md,
// "Deployment"): an undeclared table is not validated at all, so dropping one
// is non-destructive and needs no clearing.
//
// The value walks above deliberately left the retired fields where they were —
// they mapped what a field MEANT into its successor and said so. This walk is
// the second step, for the five shapes the narrow removes, and it is the
// prerequisite of that pull request:
//
//   dtsTodos        latestSafeAt, wakeCondition, importance  → unset
//   batches         path                                     → unset
//   claudeSessions  status "awaiting-permission"             → ended
//   dtsCodeBriefs   importance → unset; a retired recommendation spelling →
//                   its verdict word (ttsShared.normalizeRecommendation)
//
// NOTHING IS LOST. Every value goes into a `retired-field-cleared` dtsEvents
// row before it leaves — the whole `path` object, `helps` edges and unlinked
// path names included; the whole `importance` object with its rationale; the
// wake sentence; the instant — so what the row said outlives the field. Same
// dry run, same counts, same idempotence, same event as the walks above, and
// updatedAt is never bumped: clearing a retired field is not news about a todo
// and must not put a settled item back on Tom's pile.
export const CLEAR_MIGRATION = "clear-retired";

/** The per-value record every clearing writes: one row per field, carrying the
 * value that is about to leave. */
export const RETIRED_FIELD_CLEARED = "retired-field-cleared";

/** Rows per transaction. Larger than PAGE_SIZE because a clearing reads a row
 * and writes at most one patch and three events; still far inside Convex's
 * per-transaction limits on the two tables that are not human-scale. */
export const CLEAR_PAGE_SIZE = 250;

/** The tables the walk visits, in order. One page of one table per
 * transaction; the end of a table schedules the next, so a single call with a
 * pageSize larger than the biggest table walks all four and reports the whole
 * totals as one event. */
export const CLEAR_TABLES = [
  "dtsTodos",
  "batches",
  "claudeSessions",
  "dtsCodeBriefs",
] as const;
export type ClearTable = (typeof CLEAR_TABLES)[number];

/** The three retired fields on dtsTodos, cleared one event each. */
const RETIRED_TODO_FIELDS = ["latestSafeAt", "wakeCondition", "importance"] as const;

/** Every count key, so a report names every field even on a page where none of
 * them was set: a missing key and a zero must not read the same. */
const CLEAR_COUNT_KEYS = [
  ...CLEAR_TABLES.map((t) => `${t}-scanned`),
  ...RETIRED_TODO_FIELDS.map((f) => `${f}-cleared`),
  "path-cleared",
  "awaiting-permission-ended",
  "brief-importance-cleared",
  "recommendation-normalized",
];

/** What a session left in the retired status is ended with, when it carries no
 * reason of its own. It names the retirement, so a reader of the row a year
 * from now is not left guessing why a pre-auto-mode session ended on the day
 * the schema narrowed. */
export const RETIRED_STATUS_ENDED_REASON =
  "ended by the lifeos phase-7 clearing migration: the awaiting-permission " +
  "status is retired (the unified auto gate decides every tool call itself)";

/** A clearing report says which table this page walked and which one the
 * continuation takes, so a hand-driven resume needs nothing else. */
type ClearReport = MigrationReport & {
  table: ClearTable;
  nextTable: ClearTable | null;
};

/** The retired shapes, as a stored row still holds them. Read through this
 * rather than through the generated Doc types: after the narrow the validator
 * no longer declares them, Convex still returns them off an existing row, and
 * the verification re-run has to be able to see one. */
type RetiredFields = {
  latestSafeAt?: number;
  wakeCondition?: string;
  importance?: unknown;
  path?: unknown;
};

export const internalClearRetiredFields = internalMutation({
  args: {
    ...MIGRATION_ARGS,
    /** Which table this call walks. Omitted = start at the first and chain
     * through all four. */
    table: v.optional(v.union(...CLEAR_TABLES.map((t) => v.literal(t)))),
  },
  handler: async (ctx, args): Promise<ClearReport> => {
    const dryRun = args.dryRun ?? false;
    const pageSize = args.pageSize ?? CLEAR_PAGE_SIZE;
    const table: ClearTable = args.table ?? CLEAR_TABLES[0];
    const page: Counts = Object.fromEntries(CLEAR_COUNT_KEYS.map((k) => [k, 0]));
    const opts = { cursor: args.cursor ?? null, numItems: pageSize };

    /** The value on the record before it leaves. `subject` names the row in
     * the words its own table uses; a todo's id also fills the indexed column,
     * so a todo's history reads the clearing off by_todo like every other
     * event about it. */
    const record = async (
      subject: { todoId?: Id<"dtsTodos"> } & Record<string, unknown>,
      field: string,
      value: unknown,
    ) => {
      await logEvent(ctx, RETIRED_FIELD_CLEARED, subject.todoId, {
        table,
        field,
        value,
        ...subject,
      });
    };

    let isDone: boolean;
    let continueCursor: string;
    switch (table) {
      case "dtsTodos": {
        const result = await ctx.db.query("dtsTodos").paginate(opts);
        for (const row of result.page) {
          page["dtsTodos-scanned"]++;
          const retired = row as unknown as RetiredFields;
          const patch: Record<string, undefined> = {};
          for (const field of RETIRED_TODO_FIELDS) {
            const value = retired[field];
            if (value === undefined) continue;
            page[`${field}-cleared`]++;
            if (dryRun) continue;
            await record({ todoId: row._id }, field, value);
            patch[field] = undefined;
          }
          if (Object.keys(patch).length > 0) {
            await ctx.db.patch(row._id, patch as Partial<Doc<"dtsTodos">>);
          }
        }
        ({ isDone, continueCursor } = result);
        break;
      }
      case "batches": {
        const result = await ctx.db.query("batches").paginate(opts);
        for (const row of result.page) {
          page["batches-scanned"]++;
          const path = (row as unknown as RetiredFields).path;
          if (path === undefined) continue;
          page["path-cleared"]++;
          if (dryRun) continue;
          // The WHOLE object, not just the edge the needs migration derived
          // from: a "helps" edge became nothing and an unlinked batch's path
          // name was never an edge at all, and both are part of what the row
          // said about where its work sat.
          await record({ batchId: row._id }, "path", path);
          await ctx.db.patch(row._id, {
            path: undefined,
          } as Partial<Doc<"batches">>);
        }
        ({ isDone, continueCursor } = result);
        break;
      }
      case "claudeSessions": {
        const result = await ctx.db.query("claudeSessions").paginate(opts);
        for (const row of result.page) {
          page["claudeSessions-scanned"]++;
          if ((row.status as string) !== "awaiting-permission") continue;
          page["awaiting-permission-ended"]++;
          if (dryRun) continue;
          await record({ sessionId: row._id }, "status", {
            status: "awaiting-permission",
            // Spread, never a key set to undefined: `data` is v.any() and an
            // undefined member is not a storable Convex value.
            ...(row.endedReason === undefined
              ? {}
              : { endedReason: row.endedReason }),
          });
          // statusChangedAt is NOT bumped. Every one of these rows is
          // historical — the unified auto gate has never produced one — and
          // stamping them "changed now" would sort long-dead sessions to the
          // top of the sessions list as though something had just happened.
          await ctx.db.patch(row._id, {
            status: "ended",
            endedReason: row.endedReason ?? RETIRED_STATUS_ENDED_REASON,
          });
        }
        ({ isDone, continueCursor } = result);
        break;
      }
      case "dtsCodeBriefs": {
        const result = await ctx.db.query("dtsCodeBriefs").paginate(opts);
        for (const row of result.page) {
          page["dtsCodeBriefs-scanned"]++;
          const importance = (row as unknown as RetiredFields).importance;
          if (importance !== undefined) {
            page["brief-importance-cleared"]++;
            if (!dryRun) {
              await record({ briefId: row._id }, "importance", importance);
              await ctx.db.patch(row._id, {
                importance: undefined,
              } as Partial<Doc<"dtsCodeBriefs">>);
            }
          }
          // The same one-to-one map section 6 applied, re-applied here: a
          // brief written between that run and this one by a box job that had
          // not been redeployed yet must not hold the narrow up.
          const stored = (row as { recommendation: StoredRecommendation })
            .recommendation;
          const target = normalizeRecommendation(stored);
          if (stored === target) continue;
          page["recommendation-normalized"]++;
          if (dryRun) continue;
          await record({ briefId: row._id }, "recommendation", stored);
          await ctx.db.patch(row._id, { recommendation: target });
        }
        ({ isDone, continueCursor } = result);
        break;
      }
    }

    const totals = addCounts(args.totals ?? {}, page);
    // Not finished with this table: continue where the page stopped. Finished
    // with it: the next table from the top, or — past the last one — the
    // finished totals as one event.
    const nextTable = isDone
      ? (CLEAR_TABLES[CLEAR_TABLES.indexOf(table) + 1] ?? null)
      : table;
    if (nextTable === null) {
      await logEvent(
        ctx,
        dryRun ? `${CLEAR_MIGRATION}-dry-run` : `${CLEAR_MIGRATION}-migrated`,
        undefined,
        totals,
      );
      return {
        done: true,
        dryRun,
        page,
        totals,
        continueCursor: null,
        table,
        nextTable: null,
      };
    }
    const cursor = isDone ? null : continueCursor;
    await ctx.scheduler.runAfter(
      0,
      internal.ttsMigrations.internalClearRetiredFields,
      { table: nextTable, cursor, dryRun, pageSize, totals },
    );
    return {
      done: false,
      dryRun,
      page,
      totals,
      continueCursor: cursor,
      table,
      nextTable,
    };
  },
});
