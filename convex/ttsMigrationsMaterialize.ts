// The materialize job's request table emptied (design section 13.2,
// 2026-10-07). The job that opened an old agent from the store, its three
// routes and its runMaterializeRequests table went from the code and the
// schema in one change; the table's rows stay in the deployment, undeclared,
// until this walk deletes them. It runs only after the bucket's newest record
// export is newer than the table's last write, so every row it deletes is in
// an off-box copy. The table is read by name, untyped, because the schema no
// longer declares it. A dry run counts the rows and deletes nothing.
//
// The record's table copy of 2026-10-07 holds two rows, both written on
// 2026-09-20, so one call with the default page empties it:
//   npx convex run ttsMigrationsMaterialize:internalPurgeMaterializeRequests '{"dryRun":true}'
//   npx convex run ttsMigrationsMaterialize:internalPurgeMaterializeRequests '{}'

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { logEvent } from "./tts";

const MATERIALIZE_PURGE_MIGRATION = "materialize-requests-purge";
const TABLE = "runMaterializeRequests";

type Untyped = {
  query(table: string): { take(n: number): Promise<{ _id: string }[]> };
  delete(id: string): Promise<void>;
};

/** One call: up to `pageSize` rows, counted and (unless a dry run) deleted, in
 *  one transaction. `more` says the table holds more than that, and the same
 *  call again takes the next rows. */
export const internalPurgeMaterializeRequests = internalMutation({
  args: { dryRun: v.optional(v.boolean()), pageSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ dryRun: boolean; count: number; more: boolean }> => {
    const dryRun = args.dryRun ?? false;
    const pageSize = args.pageSize ?? 1000;
    const db = ctx.db as unknown as Untyped;
    const rows = await db.query(TABLE).take(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const more = rows.length > pageSize;
    if (!dryRun) for (const row of page) await db.delete(row._id);
    await logEvent(ctx, dryRun ? `${MATERIALIZE_PURGE_MIGRATION}-dry-run` : `${MATERIALIZE_PURGE_MIGRATION}-migrated`, undefined, {
      [TABLE]: page.length,
      more: more ? 1 : 0,
    });
    return { dryRun, count: page.length, more };
  },
});
