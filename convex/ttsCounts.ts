// Read-only shape-of-the-data introspection for the worker box and sessions.
//
// WHY THIS EXISTS. A session holds CONVEX_SITE_URL and TTS_WORKER_KEY and
// nothing else — no `npx convex run`, no dashboard. So the only way to answer
// "how many rulings carry this verdict?" was GET /tts/batch-context, which
// returns the newest 200 rulings and happens to cover the whole table today.
// Decisions that turn on a row count (is this rename a migration? is that
// table drained?) were being made from a number that silently stops being
// true. This returns counts, and says so when it could not see everything.
//
// COUNTS AND ENUM BREAKDOWNS ONLY. No statements, no sentences, no bodies,
// no ids. The point is to make claims about the data checkable without
// widening what a session can read — everything here is already derivable
// from endpoints a session can call, just not affordably.

import { v } from "convex/values";

import { internalQuery } from "./_generated/server";

// Convex has no cheap COUNT, so every table here is walked. The cap keeps a
// grown table from turning this endpoint into a function-limit failure: past
// it the count is reported as a floor with `truncated: true`, which is honest
// where a silently-wrong number is not.
const SCAN_CAP = 5000;

/**
 * Tally one field across rows. `undefined` is its own bucket rather than
 * being dropped — "how many todos have no category?" is exactly the kind of
 * question this endpoint is for, and a missing key that vanished from the
 * output would read as zero.
 */
function tally(rows: Array<Record<string, unknown>>, field: string) {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const raw = row[field];
    const key =
      raw === undefined ? "(unset)" : raw === null ? "(null)" : String(raw);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Every table this endpoint will report on, and the enum fields worth a breakdown. */
const TABLES = {
  dtsTodos: ["status", "readiness", "category", "timingClass"],
  dtsRulings: ["verdict", "subjectType"],
  batches: ["status"],
  dtsCodeBriefs: ["recommendation", "execClass"],
  dtsBlocks: [],
  claudeSessions: ["status", "mode", "kind", "repo"],
} as const;

export const internalTableCounts = internalQuery({
  args: { table: v.optional(v.string()) },
  handler: async (ctx, { table }) => {
    const names = (
      table ? [table] : Object.keys(TABLES)
    ) as Array<keyof typeof TABLES>;
    const report: Record<string, unknown> = {};
    for (const name of names) {
      const fields = TABLES[name];
      if (fields === undefined) {
        report[name] = { error: "not an introspectable table" };
        continue;
      }
      // take(cap + 1): one row past the cap is how truncation is detected
      // without a second query.
      const rows = (await ctx.db
        .query(name)
        .take(SCAN_CAP + 1)) as unknown as Array<Record<string, unknown>>;
      const truncated = rows.length > SCAN_CAP;
      const seen = truncated ? rows.slice(0, SCAN_CAP) : rows;
      const entry: Record<string, unknown> = { total: seen.length };
      if (truncated) {
        entry.truncated = true;
        entry.note = `more than ${SCAN_CAP} rows — total is a floor, not a count`;
      }
      for (const field of fields) entry[`by_${field}`] = tally(seen, field);
      report[name] = entry;
    }
    return report;
  },
});
