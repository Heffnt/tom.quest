// The record's table sweep, first step (design section 12.2, Tom's go of
// 2026-10-06): the stored rows of every table the schema no longer declares
// and no code reads or writes, deleted.
//
// THE DROP PROCEDURE (docs/lifeos-retirement.md, "Why clearing is its own
// state"). Convex does not validate a table the schema does not declare, so
// removing a declaration deploys at once whatever rows the table holds; the
// rows stay in the deployment, undeclared, until a walk like this one deletes
// them. This walk runs only after the bucket's newest Convex export is newer
// than the last write to these tables, so every row it deletes is in an
// off-box copy. The tables are read by name, untyped, because the schema no
// longer declares them.
//
// THE TABLES, and the change that took each out of the schema:
//   this change: gpuPool, gpuPoolAllocation, gpuPoolStatus (the GPU pool's
//     reconciler went earlier; nothing read or wrote them), vocabulary (an
//     empty plain-named twin of ttsVocabulary), dtsRulings (the rulings from
//     before the 2026-09-26 rename, all copied into `rulings` with their old
//     id as legacyId);
//   #389: dayLogEntries, dayLogItems (the day log);
//   #391: runMaterializeRequests (the materialize queue; its own purge,
//     convex/ttsMigrationsMaterialize.ts, empties the same table);
//   #394: intentSources, ttsVocabulary, signoffs, dtsCodeTodoMirror,
//     dtsCodeBriefs (the intent and vocabulary pages, the sign-off table and
//     the code mirrors).
//
// IT NEVER TOUCHES A DECLARED TABLE. Every name it is given is checked
// against the schema it was deployed with before any row is read, and the
// call throws if one is declared: a later change that declares one of these
// names again turns this walk into a refusal, not a deletion. It takes no
// name outside the list above.
//
// HOW IT IS RUN, after deploy and once the export is newer than the tables'
// last write: a dry run, which counts each table's rows and deletes nothing,
// then real runs until a dry run counts zero everywhere. Each call takes up to
// `pageSize` rows in all (default and most 1000), table by table, in one
// transaction; a table with rows left is named in `more`, and the same call
// again takes the next.
//   npx convex run ttsMigrationsSweep:internalPurgeSweptTables '{"dryRun":true}'
//   npx convex run ttsMigrationsSweep:internalPurgeSweptTables '{}'
// `tables` limits a call to some of the list.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import schema from "./schema";
import { logEvent } from "./tts";

const SWEEP_PURGE_MIGRATION = "table-sweep-purge";

/** Every table the walk empties, in the order above. */
export const SWEPT_TABLES = [
  "gpuPool",
  "gpuPoolAllocation",
  "gpuPoolStatus",
  "vocabulary",
  "dtsRulings",
  "dayLogEntries",
  "dayLogItems",
  "runMaterializeRequests",
  "intentSources",
  "ttsVocabulary",
  "signoffs",
  "dtsCodeTodoMirror",
  "dtsCodeBriefs",
] as const;

type Counts = Record<string, number>;

type Untyped = {
  query(table: string): { take(n: number): Promise<{ _id: string }[]> };
  delete(id: string): Promise<void>;
};

/** The names a call walks: each checked undeclared in `declared` first, then
 *  checked on the list. Throws on the first that fails either. */
export function sweptTables(names: readonly string[], declared: Record<string, unknown>): string[] {
  for (const name of names) {
    if (Object.hasOwn(declared, name)) throw new Error(`table sweep: ${name} is declared in the schema; refusing to purge it`);
    if (!(SWEPT_TABLES as readonly string[]).includes(name)) throw new Error(`table sweep: ${name} is not one of the swept tables`);
  }
  return [...names];
}

/** One call: up to `pageSize` rows in all (at most 1000, Convex's bound on
 *  one mutation's writes being far above it), taken table by table in list
 *  order, counted and (unless a dry run) deleted, in one transaction. A table
 *  with rows the call did not reach is named in `more`; a table the budget
 *  ran out before is looked at for one row only. A table already empty, or
 *  never created, counts 0. Run again until `more` is empty. */
export const internalPurgeSweptTables = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    pageSize: v.optional(v.number()),
    tables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<{ dryRun: boolean; counts: Counts; more: string[] }> => {
    const dryRun = args.dryRun ?? false;
    const pageSize = args.pageSize ?? 1000;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new Error("table sweep: pageSize is a whole number from 1 to 1000");
    }
    const tables = sweptTables(args.tables ?? SWEPT_TABLES, schema.tables);
    const db = ctx.db as unknown as Untyped;
    const counts: Counts = {};
    const more: string[] = [];
    let remaining = pageSize;
    for (const table of tables) {
      const rows = await db.query(table).take(remaining + 1);
      const page = rows.slice(0, remaining);
      if (rows.length > remaining) more.push(table);
      counts[table] = page.length;
      remaining -= page.length;
      if (!dryRun) for (const row of page) await db.delete(row._id);
    }
    await logEvent(ctx, dryRun ? `${SWEEP_PURGE_MIGRATION}-dry-run` : `${SWEEP_PURGE_MIGRATION}-migrated`, undefined, { ...counts, more: more.length });
    return { dryRun, counts, more };
  },
});
