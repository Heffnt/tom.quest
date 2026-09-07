// The nightly job's server half (the lifeos update, phase 4). The job itself
// is worker/jobs/nightly.mjs on the Jarvis Box; it reaches Convex only over
// the TTS_WORKER_KEY routes in convex/http.ts, and these are the three reads
// and writes it needs that nothing else provided:
//
//   GET  /tts/export         one page of one table, for the nightly copy of
//                            the record into WikiTom tts/snapshot/
//   GET  /tts/learning-input what the learning step reads: the turns Tom
//                            typed since the last learning run with the
//                            agent's replies around them, his Slack replies,
//                            his rulings, and the objections not yet applied
//   POST /tts/event          one dtsEvents row — how the job records a
//                            failed step, its learning run, each change it
//                            made, each reversal, and its summary
//   POST /tts/learning-objections-consumed
//                            stamps the objections the job has acted on, so
//                            the next night does not act on them again
//
// The post of the model-of-tom files lives with the store (ttsSkills.ts).

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { clip } from "../worker/jobs/clip.mjs";

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
// and never straddles a page. Same boundary for every table.
//
// THE BOUNDARY FIXES MEMBERSHIP, NOT STATE. Each page is its own query, so
// the copy is a nightly copy and not a point-in-time transaction: a row
// updated between two pages is exported in its later state, and a row
// deleted between them is in neither. The job's README says so; nothing
// downstream may read tts/snapshot/ as one instant of the record.
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
// The learning step reads what Tom did: the turns he typed in sessions
// (claudeInbound rows authored "tom" — the browser door and Slack replies the
// events route verified came from his user id), the agent's reply on either
// side of each (what he was answering and what came of it — the context his
// words are read in, never a source of lines on their own), his threaded
// Slack replies (the "slack-event" rows the events route writes), and his
// rulings — never the spec (design section 4, "Learning").
//
// THE WINDOW starts where the last learning run's ended: `since` is optional
// and defaults to the `until` of the newest "learning-run" row, so a night
// the job did not run is read the next night rather than dropped; with no
// run on record it is the day before. The reply says which (`sinceSource`).
//
// The cap is on what is RETURNED, never on what is looked at: a read that
// takes N rows and filters them afterwards drops what it was looking for as
// soon as the window holds more than N rows of anything else — and the
// agents' turns and the instrumentation events outnumber Tom's by far. Each
// read below either pins the value in an index or examines the whole window.
export const LEARNING_INPUT_MAX = 2000;
// The agent's replies are looked up per turn, two reads each pinned on the
// session and the kind, for at most this many turns; past it a turn goes out
// without them. A reply is clipped to LEARNING_REPLY_CHARS — it is context,
// and one assistant-text row can be a 32KB essay.
export const LEARNING_REPLY_TURNS = 300;
export const LEARNING_REPLY_CHARS = 1500;
// The objections not yet acted on, and the changes an objection can name:
// the newest of each, more than a week of nights.
export const LEARNING_OBJECTIONS_MAX = 200;
export const LEARNING_CHANGES_MAX = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The agent's reply as the job shows it: clip() from worker/jobs/clip.mjs,
 * the one clipping rule the jobs use, at LEARNING_REPLY_CHARS. */
function clipReply(text: unknown): string | null {
  return clip(text, LEARNING_REPLY_CHARS);
}

export const internalLearningInput = internalQuery({
  args: { since: v.optional(v.number()), until: v.number() },
  handler: async (ctx, { since: givenSince, until }) => {
    let since: number;
    let sinceSource: "given" | "learning-run" | "default";
    if (givenSince !== undefined) {
      since = givenSince;
      sinceSource = "given";
    } else {
      const last = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", "learning-run"))
        .order("desc")
        .first();
      const lastUntil = (last?.data as { until?: unknown } | undefined)?.until;
      if (typeof lastUntil === "number" && lastUntil < until) {
        since = lastUntil;
        sinceSource = "learning-run";
      } else {
        since = until - DAY_MS;
        sinceSource = "default";
      }
    }
    // by_author, so the window is Tom's rows — not the first N rows of
    // everyone's, most of which are an agent's.
    const inbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_author", (q) =>
        q.eq("author", "tom").gte("_creationTime", since).lt("_creationTime", until),
      )
      .take(LEARNING_INPUT_MAX);
    const tomTurns = [];
    // Per session, read once: the title, and the SDK session id — the id the
    // pages cite a session by (its first 8 hex characters; WikiTom's
    // sessions/ archive is keyed by the whole of it), which the session host
    // stores on the row as sdkSessionId once the SDK reports it.
    const sessions = new Map<string, { title: string; sdkSessionId: string | null }>();
    let repliesLookedUp = 0;
    for (const row of inbound) {
      if (row.kind !== "user-turn") continue;
      let session = sessions.get(row.sessionId);
      if (session === undefined) {
        const s = await ctx.db.get(row.sessionId);
        session = { title: s?.title ?? "", sdkSessionId: s?.sdkSessionId ?? null };
        sessions.set(row.sessionId, session);
      }
      // The agent's text just before the turn and just after it. The index
      // pins the session and the kind; the filter walks the rows on one side
      // of the turn's instant and stops at the first.
      let replyBefore: string | null = null;
      let replyAfter: string | null = null;
      if (repliesLookedUp < LEARNING_REPLY_TURNS) {
        repliesLookedUp += 1;
        const before = await ctx.db
          .query("claudeMessages")
          .withIndex("by_session_kind", (q) =>
            q.eq("sessionId", row.sessionId).eq("kind", "assistant-text"),
          )
          .order("desc")
          .filter((q) => q.lte(q.field("createdAt"), row.createdAt))
          .first();
        const after = await ctx.db
          .query("claudeMessages")
          .withIndex("by_session_kind", (q) =>
            q.eq("sessionId", row.sessionId).eq("kind", "assistant-text"),
          )
          .order("asc")
          .filter((q) => q.gt(q.field("createdAt"), row.createdAt))
          .first();
        replyBefore = clipReply((before?.content as { text?: unknown } | undefined)?.text);
        replyAfter = clipReply((after?.content as { text?: unknown } | undefined)?.text);
      }
      tomTurns.push({
        id: row._id,
        sessionId: row.sessionId,
        sdkSessionId: session.sdkSessionId,
        sessionTitle: session.title,
        text: row.text ?? "",
        at: row.createdAt,
        replyBefore,
        replyAfter,
      });
    }
    // by_kind_at, not by_at: the kind is pinned and `at` orders what comes
    // back, so the cap falls on Tom's replies rather than on a window whose
    // other kinds outnumber them. (by_kind_key cannot serve this — its rows
    // are ordered by event id, and "slack-event" rows all carry one.)
    const slackReplies = (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) =>
          q.eq("kind", "slack-event").gte("at", since).lt("at", until),
        )
        .take(LEARNING_INPUT_MAX)
    ).map((e) => ({ id: e._id, at: e.at, todoId: e.todoId, data: e.data }));
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
    // The objections Tom has raised that no night has acted on yet (an
    // objection is consumed once, whichever way it went), oldest first, and
    // the changes an objection can name — by the change's id or by the
    // line's text; the job does the matching.
    const objections = (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", "learning-objection"))
        .order("desc")
        .take(LEARNING_OBJECTIONS_MAX)
    )
      .filter((e) => e.consumedAt === undefined)
      .reverse()
      .map((e) => {
        const d = (e.data ?? {}) as { id?: unknown; text?: unknown };
        return {
          eventId: e._id,
          at: e.at,
          id: typeof d.id === "string" ? d.id : null,
          text: typeof d.text === "string" ? d.text : "",
        };
      });
    const changes = (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", "learning-change"))
        .order("desc")
        .take(LEARNING_CHANGES_MAX)
    ).map((e) => ({ eventId: e._id, at: e.at, ...((e.data ?? {}) as Record<string, unknown>) }));
    return { since, sinceSource, until, tomTurns, slackReplies, rulings, objections, changes };
  },
});

/** Stamp the objections the job has acted on, whichever way it went. An id
 * that is not an unconsumed "learning-objection" row is skipped rather than
 * an error: the list came from the read above, and a stale id costs nothing. */
export const internalConsumeLearningObjections = internalMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    let consumed = 0;
    for (const raw of ids) {
      const id = ctx.db.normalizeId("dtsEvents", raw);
      if (id === null) continue;
      const row = await ctx.db.get(id);
      if (!row || row.kind !== "learning-objection" || row.consumedAt !== undefined) continue;
      await ctx.db.patch(id, { consumedAt: now });
      consumed += 1;
    }
    return { consumed };
  },
});

// ── The event pen ────────────────────────────────────────────────────────────
// The job's kinds are its own ("nightly-failure", "learning-run",
// "learning-change", "learning-reverted", "learning-revert-failed",
// "nightly-run"); the pattern keeps the pen to lowercase kebab-case names
// rather than letting a worker write, say, "slack-sent" and confuse the
// digest's own bookkeeping — the route refuses the kinds Convex writes itself.
export const EVENT_KIND_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const RESERVED_EVENT_KINDS = new Set(["slack-sent", "slack-event"]);
/** The nightly job's failure row (data { day, step, error }); the worker's
 * spelling is worker/jobs/nightly.mjs NIGHTLY_FAILURE, shared by name. */
export const NIGHTLY_FAILURE = "nightly-failure";

export const internalRecordWorkerEvent = internalMutation({
  // `key`: the indexed lookup key (schema dtsEvents.key) — the weekly job's
  // "weekly-run" row carries its day, so a rerun finds it on by_kind_key.
  args: { kind: v.string(), data: v.optional(v.any()), key: v.optional(v.string()) },
  handler: async (ctx, { kind, data, key }) => {
    if (!EVENT_KIND_PATTERN.test(kind) || RESERVED_EVENT_KINDS.has(kind)) {
      throw new Error(`not a worker event kind: ${kind}`);
    }
    return await ctx.db.insert("dtsEvents", { at: Date.now(), kind, data, key });
  },
});
