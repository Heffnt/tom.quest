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
import { logEvent } from "./tts";

/** The unarchiveCondition the retired v1 → graph migration
 * (tts.internalMigrateToGraph, deleted with batches on 2026-09-24 after it had
 * run on prod) wrote on each v1 batch row it replaced. Not a return condition:
 * the timing walk below counts it apart. */
export const GRAPH_SUPERSEDED = "superseded by graph batch ";
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

/** The retired shape, as a stored row still holds it. The validator no longer
 * declares these three (the lifeos update, phase 7), and Convex returns an
 * undeclared field on an existing row unchanged, so the walk reads them
 * through this view rather than through Doc<"dtsTodos"> — which is what keeps
 * a verification re-run possible after the narrow. */
type RetiredTiming = {
  timingClass: "dated" | "whenever" | "condition-bound";
  latestSafeAt?: number;
  wakeCondition?: string;
};

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
        const retired = row as unknown as RetiredTiming;
        const terminal = row.status === "done" || row.status === "archived";
        let statement = row.statement;
        // (a) a stored waiting row becomes active with its wakeAt.
        if (row.status === "waiting") {
          page["waiting-to-active"]++;
          patch.status = "active";
          if (row.wakeAt === undefined && retired.wakeCondition !== undefined) {
            page["waiting-condition-carried"]++;
            statement = carryCondition(statement, retired.wakeCondition);
          }
        }
        // (b) a condition-bound row becomes a task carrying its condition.
        if (retired.timingClass === "condition-bound") {
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
          if (retired.latestSafeAt !== undefined && !terminal) {
            if (row.wakeAt === undefined) {
              page["condition-wake-set"]++;
              patch.wakeAt = retired.latestSafeAt - CONDITION_WINDOW_MS;
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
              wakeCondition: retired.wakeCondition,
            });
          }
          if (retired.timingClass === "condition-bound") {
            await logEvent(ctx, "timing-mapped", row._id, {
              before: {
                timingClass: retired.timingClass,
                condition: row.condition,
                latestSafeAt: retired.latestSafeAt,
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
        // Read through the loose view, like every other retired field here:
        // the narrow has taken both out of the validator and a row the
        // clearing has not reached still carries them.
        if (
          (row as unknown as RetiredFields).members !== undefined &&
          row.status === "active"
        ) {
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
// batch needs nothing. The path itself is gone from the validator; a stored
// one still comes back off the row, which is what keeps this walk re-runnable.
//
// One transaction: the batches table is human-scale (a few dozen rows for
// years, per its schema comment), and deriving an edge needs the whole path
// in view. Same dry run, counts, idempotence, and event as the walks above.
export const BATCH_NEEDS_MIGRATION = "batch-needs";

/** The retired shape, as a stored batch still holds it. The validator no
 * longer declares `path` (the lifeos update, phase 7) and Convex returns an
 * undeclared field on an existing row unchanged, so this walk reads it through
 * a loose view — which is what lets a verification re-run stay possible after
 * the narrow. */
type RetiredPath = { path?: { name: string; index: number; edge?: string } };

/** The previous batch on a path: the greatest index below `index`. Two
 * batches sharing that index (the planner never wrote one, but nothing
 * refused it) tie, and the first in `all` — table order, oldest first — wins:
 * the strict `>` below keeps the one already found. Stated so the derived
 * edge is the same on every run. */
export function previousOnPath<T>(batch: T, all: readonly T[]): T | undefined {
  const pathOf = (b: T) => (b as RetiredPath).path;
  const path = pathOf(batch);
  if (!path) return undefined;
  let best: T | undefined;
  for (const other of all) {
    const op = pathOf(other);
    if (other === batch || !op || op.name !== path.name) continue;
    if (op.index >= path.index) continue;
    if (!best || op.index > pathOf(best)!.index) best = other;
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
      const path = (batch as unknown as RetiredPath).path;
      if (!path) {
        page["no-path"]++;
        continue;
      }
      if (path.edge === "helps") {
        page["helps-dropped"]++;
        continue;
      }
      if (path.edge !== "must") {
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
          path,
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
// RUN AND VERIFIED on prod; the validator has narrowed to the four words
// since, so the retired spelling a stored brief could carry is read here
// through a loose view of the row — which is what keeps a re-run possible.
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
      const stored = (brief as { recommendation: StoredRecommendation })
        .recommendation;
      const target = normalizeRecommendation(stored);
      if (stored === target) {
        page["already-verdict-word"]++;
        continue;
      }
      page[`${stored}-to-${target}`]++;
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
// the second step, for the seven shapes the narrow removes, and it is the
// prerequisite of that pull request:
//
//   dtsTodos        latestSafeAt, wakeCondition, importance  → unset
//                   members, plan (the v1 batch fields)      → unset
//   batches         path                                     → unset
//   claudeSessions  status "awaiting-permission"             → ended
//   dtsCodeBriefs   importance → unset; a retired recommendation spelling →
//                   its verdict word (ttsShared.normalizeRecommendation)
//
// NOTHING IS LOST. Every value goes into a `retired-field-cleared` dtsEvents
// row before it leaves — the whole `path` object, `helps` edges and unlinked
// path names included; the whole `importance` object with its rationale; the
// whole `members` array and the whole `plan` array with every step, its actor,
// its status and its evidence; the wake sentence; the instant — so what the row
// said outlives the field. Same dry run, same counts, same idempotence, same
// event as the walks above, and updatedAt is never bumped: clearing a retired
// field is not news about a todo and must not put a settled item back on Tom's
// pile.
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

/** The retired fields on dtsTodos, cleared one event each carrying the whole
 * value. `members` and `plan` are the V1 BATCH pair: a dtsTodos row carrying
 * `members` WAS a batch, and `plan` was its ordered completion steps. The
 * graph migration (tts.internalMigrateToGraph) has already turned every one of
 * them into a `batches` row with its steps as task todos and its members bound
 * as goals, archiving the v1 row as superseded — so what these two fields
 * MEANT is in the graph, and what they SAID goes onto the event below before
 * the field leaves. */
const RETIRED_TODO_FIELDS = [
  "latestSafeAt",
  "wakeCondition",
  "importance",
  "members",
  "plan",
] as const;

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
  members?: unknown;
  plan?: unknown;
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

// ── 8. The ComplexMultiTrigger "closed upstream" goals (ruling 70) ──────────
// Tom, 2026-09-22: "i dont think vqc should have its own todos since tts
// covers that." Ratified 2026-09-24 as ComplexMultiTrigger adoption ruling 70,
// which retires CMT's vqc/todos.yaml registry.
//
// The schema v2 graph migration (2026-08-29) and the batch migration of
// 2026-09-06 each turned every CMT registry entry a v1 batch listed into a
// GOAL row worded "ComplexMultiTrigger <id> closed upstream", with the entry
// bound as the goal's code subject (codeRepo + codeExternalId) and the same
// sentence as its condition. The only thing that ever marked one done was the
// code-todo mirror (tts.internalReplaceMirror) reading the entry as closed in
// vqc/todos.yaml. With CMT off the mirror and the file deleted, nothing could
// close them. Tom agreed (2026-09-24) to convert each into a plain goal whose
// condition is the entry's own completion test, and to archive the second copy
// where two exist. So, per registry entry:
//
//   the first copy still active or waiting (oldest first) → statement and
//       condition become the entry's completion test below, and the goal
//       stands on that sentence alone; the code subject is cleared, because a
//       code ruling on a CMT subject is refused once CMT leaves the mirror,
//       and the goal is Tom's own todo from now on; its batchId and needs are
//       left exactly as they are (Tom's ruling of 2026-09-24 slates batches
//       for removal, and that removal clears batchId; nothing here reads or
//       moves one); readiness goes back to unprepared, because the prepared
//       brief describes the old wording; a tier-H entry (a horizon item) is
//       stored as waiting, with no wake time, on what its statement names.
//   every further active or waiting copy → archived. Its reason (the kept
//       id) is on the event below; it is not written as an unarchiveCondition,
//       which the page shows as "propose back when:", and a duplicate has no
//       condition under which it comes back.
//   a steering-grad-* entry → every active or waiting copy archived: those
//       entries asked for steering rows, which the amendment removes, and
//       their content is already homed.
//   a done copy → left alone.
//
// One transaction: the goals were all written with source "migration", which
// the by_source index reads (about a thousand rows) without touching the rest
// of the table. updatedAt is never bumped, like every walk above. One event
// lists every change with the old statement, and the new statement or the
// archive reason. IDEMPOTENT: a converted goal no longer carries the old
// wording and an archived one is neither active nor waiting, so a second run
// changes nothing and counts the converted goals as already-converted.
export const CLOSED_UPSTREAM_MIGRATION = "closed-upstream-goals";

/** The repository whose registry entries these goals were bound to. */
const CLOSED_UPSTREAM_REPO = "ComplexMultiTrigger";

/** The exact wording the two migrations wrote (tts.internalMigrateToGraph). */
export function closedUpstreamStatement(entry: string): string {
  return `${CLOSED_UPSTREAM_REPO} ${entry} closed upstream`;
}
const CLOSED_UPSTREAM_PATTERN = /^ComplexMultiTrigger (\S+) closed upstream$/;

/** Each registry entry's completion test, drafted in Tom's register and
 * agreed with him on 2026-09-24, with the entry's tier (R: ready, C: needs a
 * session with Tom, H: horizon). */
export const CLOSED_UPSTREAM_CONDITIONS: Record<
  string,
  { condition: string; tier: "R" | "C" | "H" }
> = {
  "d16-fidelity-reword-ratify": {
    tier: "R",
    condition:
      "D16's claim-fidelity rewording in vqc/constitution.md, enacted in place at v3, is ratified or struck by Tom and recorded; TRANSITION.md §3.5 already lists it as ratified.",
  },
  "o-standardize-ruling": {
    tier: "R",
    condition:
      "Tom has ruled the O-standardize fence live or moot: `_standardize` has two implementations in cmt/analysis/estimates; live keeps the fence and gives the consolidation its own todo, moot graduates the HOMES row and deletes the ledger entry.",
  },
  "gcg-real-trigger-content": {
    tier: "R",
    condition:
      "harmless-inputs, p-trojan and learning-to-poison carry real GCG-optimized trigger sets from a GPU run of cmt/datagen/gcg_optimize.py in place of their placeholders; waiting on a GPU run with the paper surrogate weights cached.",
  },
  "trigger-method-contract-target-gate": {
    tier: "R",
    condition:
      "The TriggerMethod contract has a permissive-by-default compatible_targets gate, the expander drops an incompatible (method, target) cell, and the three GCG methods declare their optimized target, or Tom defers it; waiting on his ruling in trigger-method-registry.",
  },
  "implicit-model-rewrite-untruncated": {
    tier: "R",
    condition:
      "The anthropic bible/style enrichment is re-run untruncated and a model-rewrite implicit sweep records a plantedness number; the code half landed 2026-07-24.",
  },
  "faithful-bki-hidden-state-probe": {
    tier: "R",
    condition:
      "CMT has a faithful Chen & Dai BKI probe on the victim LSTM's hidden states, registered, witnessed and run in a sweep, or the port is moved to a horizon follow-up with the reason recorded; token_label_lift is a co-occurrence statistic, not BKI.",
  },
  "lifecycle-tag-dormancy-presence-cells": {
    tier: "R",
    condition:
      "cmt/analysis/dormancy.py and cmt/analysis/presence_cells.py carry a WIP lifecycle tag and are not deleted; cmt/lifecycle.py exists and tags neither.",
  },
  "sanitizer-contract-reclassify-and-tag": {
    tier: "R",
    condition:
      "seep and spectre_full no longer declare the sanitizer contract, route suspicion through cmt/detect/, carry a WIP tag, and their nodes are re-addressed or archived; waiting on the Phase 3 rehash window.",
  },
  "metabackdoor-plant-fix": {
    tier: "R",
    condition:
      "The metabackdoor plant test's pool holds many distinct long and short sentences, its held-out test is length-partitioned per row, and a Turing re-run records plantedness.",
  },
  "cgba-plant-fix": {
    tier: "R",
    condition:
      "The cgba and clean_queries_triggers plant tests build without selection underfill and record plantedness.",
  },
  "select-family-pool-sizing": {
    tier: "C",
    condition:
      "In a session with Tom, the select-family draw sizes each row's pool by the predicate's pass rate, with a build-time feasibility check.",
  },
  "trigger-method-milestone3": {
    tier: "R",
    condition:
      "The old poisoning bundle kind is gone, new-style trigger methods are the live sweep path, sysprompt_disclosure and autopoison are removed, methods.md is reshaped, and the suite and mypy are green.",
  },
  "trigger-method-plant-runs": {
    tier: "R",
    condition:
      "Every plantable trigger method has a recorded plantedness number, including the uncollected second-wave Turing logs; the GCG methods are recorded as placeholder content.",
  },
  "trigger-method-wikitom-pins": {
    tier: "R",
    condition:
      "The cgba and clean_queries_triggers paper pins resolve with a verified hash in Heffnt/literature, or are corrected or struck with a reason.",
  },
  "grade-scheme-rename": {
    tier: "R",
    condition:
      "The four detection grade schemes carry contrast-based names Tom ratifies, with the old spellings banned, as he asked on 2026-07-25.",
  },
  "reconstruction-roster-port": {
    tier: "R",
    condition:
      "PICCOLO, badllm_tg, haystack, DBS, EliBadCode, SemInv, z_defence and bki are registered, witnessed reconstruction methods recording recovery over the 567 planted cells.",
  },
  "stage-g-13-method-baseline-comparison": {
    tier: "R",
    condition:
      "All 13 trigger methods have reconstruction and co-occurrence scan results on the same a123 setups, with setup identity pinned per cell.",
  },
  "vqc-amendments-from-the-trust-backlog": {
    tier: "C",
    condition:
      "In a session with Tom, the seven trust-backlog doctrine amendments are each ratified, reworded or struck, with an enforcement rung named.",
  },
  "trigger-method-registry": {
    tier: "C",
    condition:
      "The trigger-method rework is designed and ruled: a paper baseline is a TriggerMethod carrying only its trigger and compatibility gates; waiting on a fresh design pass and Tom's word on six open items.",
  },
  "word-insert-foundational-attribution": {
    tier: "R",
    condition:
      "WordInsertTrigger.paper reflects Tom's ruling on AddSent (Dai & Chen 2019); TRANSITION.md already records AddSent as his ruling.",
  },
  "vqc-amendments-for-the-checks-that-passed-over-nothing": {
    tier: "C",
    condition:
      "In a session with Tom, each failure mode from the 2026-07-28 session (a check that reported success while checking something else, and seven related ones) has a ratified VQC amendment with a fence, or is declined with the reason.",
  },
  "peer-data-share-governance-ruling": {
    tier: "C",
    condition:
      "Tom has ruled or parked llr, bki, attdef, parafuzz, perplexity and mdp's sign, so no peer-share roster row withholds data pending a ruling.",
  },
  "share-generations-packaging-ruling": {
    tier: "C",
    condition:
      "Tom's ruling on shipping the raw-generations share as-is or reduced is recorded, and tools/share_log.yaml names the form delivery 2 shipped.",
  },
  "formal-proofs-gold-standard": {
    tier: "H",
    condition:
      "One CMT module carries a machine-checked proof, first candidate cmt/trigger_logic/structural_metrics.py; waiting: parked as a horizon item with no near-term plan.",
  },
  "detection-scan-defense-rework": {
    tier: "C",
    condition:
      "The reader method kinds are recut into input_scan, train_scan, probe, perturb, mitigation, reconstruction and interp, with methods reclassified and the vocabulary updated; Phase 1 landed 2026-07-24, and the rest waits on Tom's word on the addressing call and two other items.",
  },
  "train-time-corr-below-chance-detectors": {
    tier: "H",
    condition:
      "rftc (AUROC 0.20), spectre (0.43) and spectral_signatures (0.51) score above chance through faithful fixes, or are documented as limitations; waiting: deferred by Tom's 2026-07-23 scope cut until the input-anomaly family is done.",
  },
  "input-anomaly-mismatch-nulls": {
    tier: "H",
    condition:
      "The by-design nulls of erase_and_check, jailguard and parafuzz are documented, or a threat model where they should fire is added and they are re-measured; waiting: parked as a horizon item.",
  },
};

/** The four entries whose goals are archived rather than converted: they
 * asked for steering rows, which the amendment removes. */
export const STEERING_GRAD_ENTRIES = [
  "steering-grad-monitoring-cadence",
  "steering-grad-frequent-checkins-debugging",
  "steering-grad-turing-repo-update-master",
  "steering-grad-autonomous-fix-authority",
] as const;

export const STEERING_GRAD_ARCHIVE_REASON =
  "the amendment (ruling 70) removes steering rows; its content is homed in WikiTom or AGENTS.md";

/** The reason a further copy of a converted goal is archived with. */
export function duplicateArchiveReason(entry: string, keptId: string): string {
  return `a second copy of the ${CLOSED_UPSTREAM_REPO} ${entry} goal; the copy kept is ${keptId}`;
}

/** One line of the event: what happened to one row. Keys are omitted rather
 * than set to undefined (an undefined member is not a storable Convex value). */
type ClosedUpstreamChange = {
  todoId: Id<"dtsTodos">;
  entry: string;
  oldStatement: string;
} & (
  | { action: "converted"; newStatement: string; status: "active" | "waiting" }
  | { action: "archived"; reason: string }
  | { action: "left"; reason: string }
);

type ClosedUpstreamReport = {
  dryRun: boolean;
  counts: Counts;
  changes: ClosedUpstreamChange[];
};

const activeOrWaiting = (row: Doc<"dtsTodos">) =>
  row.status === "active" || row.status === "waiting";

export const internalConvertClosedUpstreamGoals = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = false }): Promise<ClosedUpstreamReport> => {
    const rows = await ctx.db
      .query("dtsTodos")
      .withIndex("by_source", (q) => q.eq("source", "migration"))
      .collect();
    const counts: Counts = {
      scanned: rows.length,
      converted: 0,
      "converted-to-waiting": 0,
      "duplicate-archived": 0,
      "steering-grad-archived": 0,
      "done-left": 0,
      "already-converted": 0,
      "entry-without-goal": 0,
      "unlisted-left": 0,
    };
    const changes: ClosedUpstreamChange[] = [];
    const steering = new Set<string>(STEERING_GRAD_ENTRIES);

    // Every goal still worded the old way, grouped by registry entry, oldest
    // first so "the first copy" is the same row on every run.
    const byEntry = new Map<string, Doc<"dtsTodos">[]>();
    for (const row of rows) {
      if (row.kind !== "goal") continue;
      const entry = CLOSED_UPSTREAM_PATTERN.exec(row.statement)?.[1];
      if (entry === undefined) continue;
      byEntry.set(entry, [...(byEntry.get(entry) ?? []), row]);
    }
    for (const list of byEntry.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime);
    }

    const archive = async (
      row: Doc<"dtsTodos">,
      entry: string,
      reason: string,
      count: string,
    ) => {
      counts[count]++;
      changes.push({ todoId: row._id, entry, oldStatement: row.statement, action: "archived", reason });
      if (!dryRun) {
        await ctx.db.patch(row._id, { status: "archived", archivedAt: Date.now() });
      }
    };

    for (const [entry, list] of byEntry) {
      for (const row of list.filter((r) => r.status === "done")) {
        counts["done-left"]++;
        changes.push({ todoId: row._id, entry, oldStatement: row.statement, action: "left", reason: "done" });
      }
      const open = list.filter(activeOrWaiting);
      if (steering.has(entry)) {
        for (const row of open) {
          await archive(row, entry, STEERING_GRAD_ARCHIVE_REASON, "steering-grad-archived");
        }
        continue;
      }
      const target = CLOSED_UPSTREAM_CONDITIONS[entry];
      if (target === undefined) {
        // A goal for an entry this list does not name: not Tom's agreed
        // conversion, so it is reported and left as it is.
        for (const row of open) {
          counts["unlisted-left"]++;
          changes.push({ todoId: row._id, entry, oldStatement: row.statement, action: "left", reason: "entry not in the agreed list" });
        }
        continue;
      }
      const [kept, ...copies] = open;
      if (kept === undefined) continue;
      const status = target.tier === "H" ? "waiting" : "active";
      counts.converted++;
      if (status === "waiting") counts["converted-to-waiting"]++;
      changes.push({
        todoId: kept._id,
        entry,
        oldStatement: kept.statement,
        action: "converted",
        newStatement: target.condition,
        status,
      });
      if (!dryRun) {
        await ctx.db.patch(kept._id, {
          statement: target.condition,
          condition: target.condition,
          codeRepo: undefined,
          codeExternalId: undefined,
          readiness: "unprepared",
          status,
        });
      }
      for (const row of copies) {
        await archive(row, entry, duplicateArchiveReason(entry, kept._id), "duplicate-archived");
      }
    }

    // What a re-run sees: an entry whose goal already carries its completion
    // test is counted, not touched; an entry with neither is named.
    const conditions = new Set(rows.map((r) => r.statement));
    for (const [entry, { condition }] of Object.entries(CLOSED_UPSTREAM_CONDITIONS)) {
      if ((byEntry.get(entry) ?? []).some(activeOrWaiting)) continue;
      if (conditions.has(condition)) counts["already-converted"]++;
      else counts["entry-without-goal"]++;
    }

    await logEvent(
      ctx,
      dryRun ? `${CLOSED_UPSTREAM_MIGRATION}-dry-run` : `${CLOSED_UPSTREAM_MIGRATION}-migrated`,
      undefined,
      { counts, changes },
    );
    return { dryRun, counts, changes };
  },
});

// ── 9. Batches removed: every todo stands alone (Tom's ruling, 2026-09-24) ──
// Tom, 2026-09-24: "I dont want to have batches at all anymore because I want
// to remove structure to allow agents to freely move toward completing all
// todos in the best way they (or the orchistrator) see fit." and "lets make
// sure that we dont lose any of the things i wanted to do when removing
// batches and everything related to that. i cant make those rulings right now
// but proceed with the recommendations anyway."
//
// Per batch, what happens to each todo whose batchId names it:
//
//   a goal (any status)            → unbound: batchId cleared, kind "goal"
//       kept. A goal is Tom's own todo that the planner bound here.
//   an open task written by the planner (source "planner", active or
//       waiting, not Tom-touched)  → archived, batchId cleared. Its statement
//       was a step of this batch's plan and meant something only inside it.
//   an open task from a migration of Tom's earlier todos (source
//       "migration")               → made standalone: batchId cleared, kind
//       and status kept. It was his item before the planner bound it, and he
//       ruled that nothing of his is lost.
//   any other open task (another source, or a planner task Tom has touched)
//                                  → made standalone the same way: nothing
//       says it is only a plan step, and an archive is not an agent's to make
//       on a row he ruled on.
//   a done or archived task        → batchId cleared, status kept.
//
// The batch row itself is set to archived. `needs` stays on every row and the
// ready rule is unchanged: an archived need counts as done, so a todo that
// needed an archived plan step becomes ready.
//
// WHAT IS NOT WRITTEN: no unarchiveCondition (the page shows it as "propose
// back when:", and none of these has a condition under which it comes back),
// and never updatedAt, on a todo or on the batch — a migration must not put
// settled items back on Tom's pile.
//
// ONE BATCH PER CALL. Each call walks one `batches` row (paginate, one item)
// and schedules itself with the cursor and the running totals; a call given a
// `batchId` does that one batch and schedules nothing. Each batch that changes
// anything gets ONE dtsEvents row (kind BATCH_REMOVED_EVENT) naming the
// batch's id and statement, the ruling verbatim, and every todo id whose
// batchId it cleared, grouped by what happened to it — the record of where
// each of Tom's things went. After the batches, the walk clears
// runs.batchId on every run row, one page per call. The finished totals are
// one `batches-removed-migrated` (or `-dry-run`) event, which also counts the
// todos still carrying a batchId (zero once the walk is done).
//
// IDEMPOTENT: an archived batch that no todo points at is counted as
// already-removed and left alone, and a run row with no batchId is not
// touched, so a second run reports zero on every change count.
export const BATCHES_REMOVED_MIGRATION = "batches-removed";
/** The per-batch event kind; its data names the batch id. */
export const BATCH_REMOVED_EVENT = "batch-removed";
/** Tom's ruling, verbatim, as every per-batch event carries it. */
export const BATCHES_REMOVED_RULING =
  "I dont want to have batches at all anymore because I want to remove structure to allow agents to freely move toward completing all todos in the best way they (or the orchistrator) see fit.";
/** The reason a planner task is archived with, on its batch's event. */
const PLANNER_TASK_ARCHIVE_REASON =
  `a step of a batch's plan, written by the planner; batches were removed on Tom's ruling of 2026-09-24: "${BATCHES_REMOVED_RULING}"`;
/** Run rows per call in the runs phase. */
const RUNS_PAGE_SIZE = 200;
/** The most bound todos the finished report counts. */
const STILL_BOUND_CAP = 100;

/** Every count key, so a report names every case even when it is zero. */
const BATCH_REMOVAL_COUNT_KEYS = [
  "batches-scanned",
  "batches-archived",
  "batches-already-archived",
  "batches-already-removed",
  "goals-unbound",
  "migration-tasks-made-standalone",
  "other-tasks-made-standalone",
  "planner-tasks-archived",
  "done-or-archived-tasks-cleared",
  "runs-scanned",
  "runs-cleared",
] as const;

/** The todo ids of one batch, grouped by what happened to each. */
type BatchRemoval = {
  goalsUnbound: Id<"dtsTodos">[];
  migrationTasksMadeStandalone: Id<"dtsTodos">[];
  otherTasksMadeStandalone: Id<"dtsTodos">[];
  plannerTasksArchived: Id<"dtsTodos">[];
  doneOrArchivedTasksCleared: Id<"dtsTodos">[];
};

type BatchRemovalReport = {
  done: boolean;
  dryRun: boolean;
  phase: "batches" | "runs";
  /** The batch this call walked, or null in the runs phase. */
  batchId: Id<"batches"> | null;
  /** What happened to that batch's todos (empty in the runs phase). */
  removal: BatchRemoval | null;
  page: Counts;
  totals: Counts;
  continueCursor: string | null;
  /** On the finished report only: todos still carrying a batchId. */
  todosStillBound?: number;
};

const emptyRemovalCounts = (): Counts =>
  Object.fromEntries(BATCH_REMOVAL_COUNT_KEYS.map((key) => [key, 0]));

/** One batch: classify its todos, and (unless dryRun) clear and archive. */
async function removeOneBatch(
  ctx: MutationCtx,
  batch: Doc<"batches">,
  dryRun: boolean,
  page: Counts,
): Promise<BatchRemoval> {
  const removal: BatchRemoval = {
    goalsUnbound: [],
    migrationTasksMadeStandalone: [],
    otherTasksMadeStandalone: [],
    plannerTasksArchived: [],
    doneOrArchivedTasksCleared: [],
  };
  const rows = await ctx.db
    .query("dtsTodos")
    .withIndex("by_batch", (q) => q.eq("batchId", batch._id))
    .collect();
  page["batches-scanned"]++;
  if (rows.length === 0 && batch.status === "archived") {
    page["batches-already-removed"]++;
    return removal;
  }
  const now = Date.now();
  for (const row of rows) {
    const open = row.status === "active" || row.status === "waiting";
    if (row.kind === "goal") {
      removal.goalsUnbound.push(row._id);
      page["goals-unbound"]++;
      if (!dryRun) await ctx.db.patch(row._id, { batchId: undefined });
    } else if (!open) {
      removal.doneOrArchivedTasksCleared.push(row._id);
      page["done-or-archived-tasks-cleared"]++;
      if (!dryRun) await ctx.db.patch(row._id, { batchId: undefined });
    } else if (row.source === "planner" && row.tomTouchedAt === undefined) {
      removal.plannerTasksArchived.push(row._id);
      page["planner-tasks-archived"]++;
      if (!dryRun) {
        await ctx.db.patch(row._id, { batchId: undefined, status: "archived", archivedAt: now });
      }
    } else if (row.source === "migration") {
      removal.migrationTasksMadeStandalone.push(row._id);
      page["migration-tasks-made-standalone"]++;
      if (!dryRun) await ctx.db.patch(row._id, { batchId: undefined });
    } else {
      removal.otherTasksMadeStandalone.push(row._id);
      page["other-tasks-made-standalone"]++;
      if (!dryRun) await ctx.db.patch(row._id, { batchId: undefined });
    }
  }
  if (batch.status === "archived") page["batches-already-archived"]++;
  else {
    page["batches-archived"]++;
    if (!dryRun) await ctx.db.patch(batch._id, { status: "archived" });
  }
  if (!dryRun) {
    await logEvent(
      ctx,
      BATCH_REMOVED_EVENT,
      undefined,
      {
        batchId: batch._id,
        statement: batch.statement,
        ruling: BATCHES_REMOVED_RULING,
        rulingDay: "2026-09-24",
        plannerTaskArchiveReason: PLANNER_TASK_ARCHIVE_REASON,
        ...removal,
      },
    );
  }
  return removal;
}

export const internalRemoveBatches = internalMutation({
  args: {
    ...MIGRATION_ARGS,
    /** Walk this one batch only, and schedule nothing. */
    batchId: v.optional(v.string()),
    /** Which walk the cursor belongs to; never passed by a caller. */
    phase: v.optional(v.union(v.literal("batches"), v.literal("runs"))),
  },
  handler: async (ctx, args): Promise<BatchRemovalReport> => {
    const dryRun = args.dryRun ?? false;
    const page = emptyRemovalCounts();

    if (args.batchId !== undefined) {
      const id = ctx.db.normalizeId("batches", args.batchId);
      const batch = id === null ? null : await ctx.db.get(id);
      if (batch === null) throw new Error(`Unknown batch id: ${args.batchId}`);
      const removal = await removeOneBatch(ctx, batch, dryRun, page);
      return {
        done: true,
        dryRun,
        phase: "batches",
        batchId: batch._id,
        removal,
        page,
        totals: addCounts(args.totals ?? {}, page),
        continueCursor: null,
      };
    }

    const phase = args.phase ?? "batches";
    const next = async (nextPhase: "batches" | "runs", cursor: string | null, totals: Counts) => {
      await ctx.scheduler.runAfter(0, internal.ttsMigrations.internalRemoveBatches, {
        cursor,
        dryRun,
        phase: nextPhase,
        totals,
        ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
      });
    };

    if (phase === "batches") {
      const result = await ctx.db
        .query("batches")
        .paginate({ cursor: args.cursor ?? null, numItems: 1 });
      const batch = result.page[0];
      const removal = batch === undefined ? null : await removeOneBatch(ctx, batch, dryRun, page);
      const totals = addCounts(args.totals ?? {}, page);
      if (result.isDone) await next("runs", null, totals);
      else await next("batches", result.continueCursor, totals);
      return {
        done: false,
        dryRun,
        phase,
        batchId: batch?._id ?? null,
        removal,
        page,
        totals,
        continueCursor: result.isDone ? null : result.continueCursor,
      };
    }

    // The runs phase: runs.batchId on every run row. The runs table has no
    // index on batchId, so the walk pages through all of it.
    const result = await ctx.db
      .query("runs")
      .paginate({ cursor: args.cursor ?? null, numItems: args.pageSize ?? RUNS_PAGE_SIZE });
    for (const run of result.page) {
      page["runs-scanned"]++;
      if (run.batchId === undefined) continue;
      page["runs-cleared"]++;
      if (!dryRun) await ctx.db.patch(run._id, { batchId: undefined });
    }
    const totals = addCounts(args.totals ?? {}, page);
    if (!result.isDone) {
      await next("runs", result.continueCursor, totals);
      return {
        done: false,
        dryRun,
        phase,
        batchId: null,
        removal: null,
        page,
        totals,
        continueCursor: result.continueCursor,
      };
    }
    // The verification count: todos whose batchId is still set, counted up to
    // STILL_BOUND_CAP (a dtsTodos row carries its whole write-up, so reading
    // every bound row in one transaction would approach the read limit). A
    // finished real run counts zero; a dry run counts up to the cap, and its
    // per-case totals are the full count. Ids sort after an absent field in an
    // index, so every set batchId is at or above "".
    const stillBound = await ctx.db
      .query("dtsTodos")
      .withIndex("by_batch", (q) => q.gte("batchId", "" as Id<"batches">))
      .take(STILL_BOUND_CAP);
    await logEvent(
      ctx,
      dryRun ? `${BATCHES_REMOVED_MIGRATION}-dry-run` : `${BATCHES_REMOVED_MIGRATION}-migrated`,
      undefined,
      { ...totals, "todos-still-bound": stillBound.length },
    );
    return {
      done: true,
      dryRun,
      phase,
      batchId: null,
      removal: null,
      page,
      totals,
      continueCursor: null,
      todosStillBound: stillBound.length,
    };
  },
});
