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
import { internal } from "./_generated/api";
import { logEvent } from "./tts";
import { normalizeReadiness } from "./ttsShared";

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

/** Finish a walk: record the totals as one event and return the report. */
async function finish(
  ctx: MutationCtx,
  name: string,
  dryRun: boolean,
  page: Counts,
  totals: Counts,
): Promise<MigrationReport> {
  await logEvent(ctx, dryRun ? `${name}-dry-run` : `${name}-migrated`, undefined, totals);
  return { done: true, dryRun, page, totals, continueCursor: null };
}

// ── 1. Readiness to two values (ruling 18) ──────────────────────────────────
// ready-for-tom → prepared, preparing → prepared, unprepared stays. The
// stored value moves; whether a prepared row is READY for Tom is computed
// from then on (ttsShared.isReadyForTom).
export const READINESS_MIGRATION = "readiness";

export const internalMigrateReadiness = internalMutation({
  args: MIGRATION_ARGS,
  handler: async (ctx, args): Promise<MigrationReport> => {
    const dryRun = args.dryRun ?? false;
    const pageSize = args.pageSize ?? PAGE_SIZE;
    const result = await ctx.db
      .query("dtsTodos")
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize });
    // Count keys are ASCII (a Convex record key), spelled "<from>-to-<to>".
    const page: Counts = {
      scanned: 0,
      "ready-for-tom-to-prepared": 0,
      "preparing-to-prepared": 0,
      prepared: 0,
      unprepared: 0,
    };
    for (const row of result.page) {
      page.scanned++;
      const target = normalizeReadiness(row.readiness);
      if (row.readiness === target) {
        page[target]++;
        continue;
      }
      page[`${row.readiness}-to-${target}`]++;
      if (!dryRun) await ctx.db.patch(row._id, { readiness: target });
    }
    const totals = addCounts(args.totals ?? {}, page);
    if (result.isDone) {
      return await finish(ctx, READINESS_MIGRATION, dryRun, page, totals);
    }
    await ctx.scheduler.runAfter(0, internal.ttsMigrations.internalMigrateReadiness, {
      cursor: result.continueCursor,
      dryRun,
      pageSize,
      totals,
    });
    return {
      done: false,
      dryRun,
      page,
      totals,
      continueCursor: result.continueCursor,
    };
  },
});
