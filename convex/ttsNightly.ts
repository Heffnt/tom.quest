// The nightly job's server half (the lifeos update, phase 4). The job itself
// is worker/jobs/nightly.mjs on the Jarvis Box; it reaches Convex only over
// the TTS_WORKER_KEY routes in convex/http.ts, and these are the three reads
// and writes it needs that nothing else provided:
//
//   GET  /tts/export         one page of one table, for the nightly copy of
//                            the record into WikiTom tts/snapshot/
//   GET  /tts/learning-input what the learning step reads: yesterday's turns
//                            Tom typed, his Slack replies, and his rulings
//   POST /tts/event          one dtsEvents row — how the job records a
//                            failed step, its learning run, and its summary
//
// The post of the model-of-tom files lives with the store (ttsSkills.ts).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { TableNames } from "./_generated/dataModel";
import schema from "./schema";

// ── The export ───────────────────────────────────────────────────────────────
// Every table in the schema except the auth ones (the six @convex-dev/auth
// tables, all named auth*: accounts, sessions, refresh tokens, verification
// codes, verifiers, rate limits — credentials and session secrets, which have
// no business in a git repository). Derived from the schema, so a new table
// is in tomorrow's copy without anyone remembering to list it.
export const EXPORT_TABLES: string[] = Object.keys(schema.tables)
  .filter((name) => !name.startsWith("auth"))
  .sort();

export function isExportTable(name: unknown): name is TableNames {
  return typeof name === "string" && EXPORT_TABLES.includes(name);
}

// Page bounds. ROWS ARE NOT THE UNIT THAT MATTERS: a dtsTodos row is a few
// hundred bytes, a claudeMessages row up to ~32KB (the daemon's cut), and a
// claudeMessageOverflow chunk 256KB — so a fixed 200 rows is 40KB of one table
// and 50MB of another, past what one query may read. A page that cannot be
// read is not a slow copy, it is no copy of that table at all, every night.
// So a page ends at whichever comes first: `numItems` rows, or
// EXPORT_PAGE_BYTES of row bytes. One row always goes out, however big, so a
// single oversized row can never stall the walk.
export const EXPORT_PAGE_DEFAULT = 200;
export const EXPORT_PAGE_MAX = 1000;
export const EXPORT_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * The cursor: the last row of the page, by (_creationTime, _id) — the order
 * the by_creation_time index reads in, _id breaking a tie. Convex's own
 * pagination cursor cannot be used here because a page ends where the bytes
 * run out, not where a fixed row count does.
 */
export function exportCursor(row: { _creationTime: number; _id: string }): string {
  return JSON.stringify({ t: row._creationTime, id: row._id });
}

export function parseExportCursor(cursor: string | null): { t: number; id: string } | null {
  if (cursor === null || cursor === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error("not an export cursor");
  }
  const c = (parsed ?? {}) as { t?: unknown; id?: unknown };
  if (typeof c.t !== "number" || typeof c.id !== "string") {
    throw new Error("not an export cursor");
  }
  return { t: c.t, id: c.id };
}

/** What one row costs the page's budget: the bytes of its JSON, which is what
 * the job writes and what the read budget is spent on. */
export function rowBytes(row: unknown): number {
  const json = JSON.stringify(row, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return typeof json === "string" ? new TextEncoder().encode(json).length : 0;
}

// One page, in creation order, of the rows created BEFORE `boundary` — the
// job fixes the boundary at the instant it starts, so a row written while
// the job pages (an hourly update, a session's flush) is in tomorrow's copy
// and never straddles a page. Same boundary for every table, so the copy is
// one instant of the record.
export const internalExportPage = internalQuery({
  args: {
    table: v.string(),
    boundary: v.number(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { table, boundary, cursor, numItems }) => {
    if (!isExportTable(table)) throw new Error(`not an exported table: ${table}`);
    const size = Math.max(1, Math.min(EXPORT_PAGE_MAX, Math.floor(numItems)));
    const from = parseExportCursor(cursor);
    // The built-in creation-time index exists on every table; the table name
    // is a runtime value here, which the typed query builder cannot narrow.
    // The range starts AT the cursor's instant rather than after it, and the
    // rows at that instant are skipped by id below — a tie there would
    // otherwise drop a row from the copy silently.
    const stream = ctx.db
      .query(table as "dtsEvents")
      .withIndex("by_creation_time", (q) =>
        from === null
          ? q.lt("_creationTime", boundary)
          : q.gte("_creationTime", from.t).lt("_creationTime", boundary),
      )
      .order("asc");
    const rows: unknown[] = [];
    let bytes = 0;
    let isDone = true;
    let continueCursor = cursor ?? "";
    // Read one row at a time: a page that stops at its byte budget must not
    // have read the whole of a fixed-size page to get there.
    for await (const row of stream) {
      if (from !== null && (row._creationTime < from.t || (row._creationTime === from.t && row._id <= from.id))) {
        continue;
      }
      const size_ = rowBytes(row);
      if (rows.length > 0 && (rows.length >= size || bytes + size_ > EXPORT_PAGE_BYTES)) {
        isDone = false;
        break;
      }
      rows.push(row);
      bytes += size_;
      continueCursor = exportCursor(row);
    }
    return { rows, isDone, continueCursor, bytes };
  },
});

// ── The learning input ───────────────────────────────────────────────────────
// The learning step reads ONLY what Tom did: the turns he typed in sessions
// (claudeInbound rows authored "tom" — the browser door and Slack replies the
// events route verified came from his user id), his threaded Slack replies
// (the "slack-event" rows the events route writes), and his rulings — never
// an agent's turns, never the spec (design section 4, "Learning"). Windowed
// by the caller: the job asks for the day before its run.
export const LEARNING_INPUT_MAX = 2000;

export const internalLearningInput = internalQuery({
  args: { since: v.number(), until: v.number() },
  handler: async (ctx, { since, until }) => {
    const inbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", since).lt("_creationTime", until),
      )
      .take(LEARNING_INPUT_MAX);
    const tomTurns = [];
    const titles = new Map<string, string>();
    for (const row of inbound) {
      if (row.author !== "tom" || row.kind !== "user-turn") continue;
      let title = titles.get(row.sessionId);
      if (title === undefined) {
        title = (await ctx.db.get(row.sessionId))?.title ?? "";
        titles.set(row.sessionId, title);
      }
      tomTurns.push({
        id: row._id,
        sessionId: row.sessionId,
        sessionTitle: title,
        text: row.text ?? "",
        at: row.createdAt,
      });
    }
    const slackReplies = (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_at", (q) => q.gte("at", since).lt("at", until))
        .take(LEARNING_INPUT_MAX)
    )
      .filter((e) => e.kind === "slack-event")
      .map((e) => ({ id: e._id, at: e.at, todoId: e.todoId, data: e.data }));
    const rulings = (
      await ctx.db
        .query("dtsRulings")
        .withIndex("by_ruled", (q) => q.gte("ruledAt", since).lt("ruledAt", until))
        .take(LEARNING_INPUT_MAX)
    ).map((r) => ({
      id: r._id,
      at: r.ruledAt,
      verdict: r.verdict,
      subjectType: r.subjectType,
      todoId: r.todoId,
      batchId: r.batchId,
      repo: r.repo,
      externalId: r.externalId,
      sentence: r.sentence,
      quote: r.provenance?.quote,
    }));
    return { since, until, tomTurns, slackReplies, rulings };
  },
});

// ── The event pen ────────────────────────────────────────────────────────────
// The job's kinds are its own ("nightly-failure", "learning-run",
// "nightly-run"); the pattern keeps the pen to lowercase kebab-case names
// rather than letting a worker write, say, "slack-sent" and confuse the
// digest's own bookkeeping — the route refuses the kinds Convex writes itself.
export const EVENT_KIND_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const RESERVED_EVENT_KINDS = new Set(["slack-sent", "slack-event"]);

export const internalRecordWorkerEvent = internalMutation({
  args: { kind: v.string(), data: v.optional(v.any()) },
  handler: async (ctx, { kind, data }) => {
    if (!EVENT_KIND_PATTERN.test(kind) || RESERVED_EVENT_KINDS.has(kind)) {
      throw new Error(`not a worker event kind: ${kind}`);
    }
    return await ctx.db.insert("dtsEvents", { at: Date.now(), kind, data });
  },
});
