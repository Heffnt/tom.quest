import { v } from "convex/values";
import {
  composeTodayFitted,
  countWord,
  renderSlack,
  todayFactsBlock,
  type BatchOutcome,
  type BrokenFact,
  type TodayFacts,
} from "./ttsCompose";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordMissedKeepingDate } from "./tts";
import { DELEGATE_DECISION, objectionRank, stripNarrowListId } from "./ttsAsk";
import { MERGE } from "./ttsMerge";
import { EVALS_RUN, PRELUDE_DELIVERY } from "./ttsEvals";
import {
  DAY_MS,
  LIVE_STATUSES,
  buildDoneSet,
  feedIsPrivate,
  isReadyForTom,
  nyCalendarDayBoundsUtc,
  nyCalendarDayKey,
  nyHhmm,
  privateFeedNames,
  ttsSessionLink,
  type SlackSubject,
} from "./ttsShared";

// ── THE MORNING MESSAGE (slack-design.md, Tom 2026-09-09) ───────────────────
// This file GATHERS THE FACTS. Turning them into sentences is convex/
// ttsCompose.ts's one job, and the send is convex/ttsSync.ts sendToday, which
// runs the missed rollover, reads internalComposeToday, and posts to
// #tts-today. This module is plain runtime (no "use node") so the gatherer is
// a query and the composer beneath it is a pure function a test calls with
// hand-built facts.
//
// The word "digest" survives only in the CODE — `digestSubject` became
// `todaySubject`, `digest-sent` and `internalDigestWindow` stay because rows,
// subjects and window arithmetic already spell it that way. NEVER PRINT IT:
// every line Tom reads says "morning message".
//
// The runs, in this order; each omitted when empty except the first:
//   1. today — dated or late, oldest date first, each line naming the first
//      move, and one sentence for how many other items are ready
//   2. the objection list — what the delegate decided while he was asleep,
//      numbered in printed order; silence means it stands
//   3. the calendar — his day, WITH EVERY PRIVATE FEED'S ROWS DROPPED
//   4. overnight — one line per BATCH saying what the batch now is, never one
//      line per logged event
//   5. broken — the jobs that failed, and what that means for him
//
// What LEFT the morning message in this round (§4.3): the WikiTom commit list
// (a changelog is not a morning read; an unreadable WikiTom is a #tts-broken
// line instead), the rulings-from-your-words lines and the model-of-Tom lines
// (both are decisions taken in his name, so both go to #tts-decisions), and
// the "Captured from email" section (a capture that is ready is a thing to do
// today; one that is not is a row, not a line).

// ── The digest's own bookkeeping row (dtsEvents) ─────────────────────────────
// TWO KINDS OF ROW come out of a sent digest, and they answer different
// questions:
//
//   "slack-sent" / "slack-send-failed" belong to the ONE DOOR
//   (convex/ttsSync.ts postSlack → convex/ttsSlack.ts). They are keyed by the
//   Slack thread and carry the subject, so a threaded reply from Tom is routed
//   back to what it answers, and a failure row carries the text a later resend
//   posts unchanged. The digest does not write them and must not read them for
//   its own bookkeeping — their key is a thread, not a day.
//
//   "digest-sent" (written by tts.internalMarkDigestSent) is the DIGEST's own
//   row: data { day, windowEnd }. `day` is the once-a-day dedupe key; a rerun
//   the same day finds it and stops. `windowEnd` is the `now` the digest was
//   COMPOSED against, and it is where the NEXT digest's window starts. The
//   row's own `at` is later — composing, posting to Slack and writing the row
//   all take time — so starting the next window there would skip everything
//   that happened in the gap. This mirrors the hourly update's marker row
//   exactly (convex/ttsSync.ts HOURLY_UPDATE_SENT).
export const SLACK_SENT = "slack-sent";
export const SLACK_FAILED = "slack-send-failed";
export const DIGEST_SENT = "digest-sent";

/** The morning message's Slack subject. `today` supersedes the old `digest`
 *  member, which stays in the union so a reply in a thread posted before this
 *  deploy still routes (convex/ttsShared.ts SLACK_SUBJECT). */
export function todaySubject(day: string): SlackSubject {
  return { kind: "today", day };
}

// The delegate's rows (delegate-design.md §1.2), read by KIND if they are
// there. The delegate itself is built on branch uac/delegate; until it lands
// there are no such rows and the objection list renders nothing.
//   kind "delegate-decision",  key <askId>, data { askId, todoId, decision,
//                              reason, refused, refusedBecause, fallback, … }
//   kind "delegate-objection", key <askId> — Tom's revert, written by the
//                              Slack thread-reply route.
export { DELEGATE_DECISION, DELEGATE_OBJECTION } from "./ttsAsk";
export { MERGE } from "./ttsMerge";

// The nightly job's model-of-Tom lines (worker/jobs/nightly.mjs learningStep
// writes them). They no longer appear in the morning message: a line the
// nightly job wrote about him is a decision taken in his name, so it goes to
// #tts-decisions as it is written (§1.2).
//   kind "learning-change",        data { id, file, section, before, after, evidence, excerpt,
//                                         baseBlob, resultBlob, modelOfTomCommit }
//   kind "learning-reverted",      data { id, file, before, after, objection, baseBlob,
//                                         resultBlob, modelOfTomCommit }
//   kind "learning-revert-failed", data { id?, file?, reason, objection }
export const LEARNING_CHANGE = "learning-change";
export const LEARNING_REVERTED = "learning-reverted";
export const LEARNING_REVERT_FAILED = "learning-revert-failed";
export { PRELUDE_DELIVERY, EVALS_RUN } from "./ttsEvals";

// The weekly session's record that Tom confirmed an area page (phase 8;
// POST /tts/area-reviewed, convex/ttsWeekly.ts): key = the page's path,
// data { path, reviewedOn }. Listed with what happened since the last digest.
export const AREA_REVIEWED = "area-reviewed";

// The note the rollover writes on the outcome row, so the row says who wrote
// it when Tom reads the item's history.
export const ROLLOVER_NOTE = "passed without an outcome; recorded at the 5 a.m. rollover";

// ── The missed rollover (ruling 14) ──────────────────────────────────────────
// At 5 a.m. New York, before composing: every active dated todo whose date is
// before the new calendar day and which has no outcome recorded for that date
// gets the outcome "missed", ONCE, through tts.recordMissedKeepingDate. That
// path writes the outcome row and NOTHING else — the date stays, its dateKind
// stays, and updatedAt is not bumped (see the comment there). The item is then
// still listed as overdue with its original date until Tom replies done or
// gives a new one. Idempotent: the outcome row's dueAt equals the todo's dueAt
// afterwards, and that equality is the "already recorded" check.
export function isPassedWithoutOutcome(
  todo: Pick<Doc<"dtsTodos">, "status" | "dueAt" | "dateOutcomes">,
  newDayStart: number,
): boolean {
  if (todo.status !== "active" || todo.dueAt === undefined) return false;
  if (todo.dueAt >= newDayStart) return false;
  const dueAt = todo.dueAt;
  return !(todo.dateOutcomes ?? []).some((o) => o.dueAt === dueAt);
}

export const internalRollMissed = internalMutation({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    const { start } = nyCalendarDayBoundsUtc(day);
    // The rows the rollover can possibly touch, and no others: active, dated,
    // and dated before the new day. The `gte(0)` lower bound excludes the
    // undated rows, which sort before every number in a Convex index.
    const passed = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status_and_due", (q) =>
        q.eq("status", "active").gte("dueAt", 0).lt("dueAt", start),
      )
      .collect();
    const rolled: Id<"dtsTodos">[] = [];
    for (const todo of passed) {
      if (!isPassedWithoutOutcome(todo, start)) continue;
      await recordMissedKeepingDate(ctx, todo, ROLLOVER_NOTE);
      rolled.push(todo._id);
    }
    return rolled;
  },
});

// ── WikiTom commits (plan §3: "every WikiTom commit made since the last
// digest, with author") ──────────────────────────────────────────────────────
// WikiTom is Tom's own repository, and the digest is where he sees what moved
// in it overnight. GitHub is outside the Convex query runtime, so the SENDER
// fetches (convex/ttsSync.ts, with the deployment's GITHUB_MIRROR_TOKEN) and
// hands the result to the composer.
//
// That token is scoped to ComplexMultiTrigger and tom.quest today, so a
// WikiTom read comes back 403/404 until Tom widens it. The section then says
// exactly that instead of disappearing — an omitted section would read as "no
// commits were made", which is a different fact.
export type WikiTomCommit = {
  sha: string;
  message: string;
  author: string;
  url: string;
};
export const WIKITOM_UNREADABLE = "WikiTom commits: not readable (no credential)";
export const WIKITOM_COMMIT = v.object({
  sha: v.string(),
  message: v.string(),
  author: v.string(),
  url: v.string(),
});

// ── Gathering the day's facts ────────────────────────────────────────────────
// Deterministic, from queries, no model call. What comes out is `TodayFacts`
// (convex/ttsCompose.ts): the shape both the plain template and the Fable
// writer on the box compose from, and the shape the FACTS BLOCK is built from.

/** The objection list's order and the narrow-list-id strip both live in
 *  convex/ttsAsk.ts, which is the delegate's one home. This file used to carry
 *  a copy of each while that file was on another branch; both copies are gone
 *  and these two names are re-exported so the tests and the composer keep one
 *  import site. */
export { objectionRank, stripNarrowListId } from "./ttsAsk";

/** "Ten days late." / "Due today." / "Due tomorrow." / "Due in four days."
 *  The countdown goes INSIDE the item's sentence, never as a third em-dash
 *  clause, and small numbers are words because that is how he reads them. */
export function latenessText(dueAt: number, now: number): string {
  const days =
    (Date.parse(nyCalendarDayKey(dueAt)) - Date.parse(nyCalendarDayKey(now))) / DAY_MS;
  if (days === 0) return "Due today.";
  if (days === 1) return "Due tomorrow.";
  if (days > 1) return `Due in ${countWord(days)} days.`;
  if (days === -1) return "One day late.";
  return `${capitalise(countWord(-days))} days late.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One sentence naming the shape of the day, from the spans that survived the
 *  private-feed filter. Never a list of times — the item lines are the list. */
export function calendarLeadText(spans: { start: number; end: number; allDay: boolean }[]): string {
  const timed = spans.filter((s) => !s.allDay).sort((a, b) => a.start - b.start);
  const allDay = spans.length - timed.length;
  if (timed.length === 0) {
    return `Your day carries ${countWord(allDay)} ${
      allDay === 1 ? "entry that runs" : "entries that run"
    } all day and nothing timed.`;
  }
  const from = nyHhmm(timed[0].start);
  const to = nyHhmm(Math.max(...timed.map((s) => s.end)));
  return `Your day is committed from ${from} to ${to}.`;
}

// Bounded newest-first walk of dtsEvents for a kind, the internalLastEventAt
// pattern: dtsEvents is busy instrumentation, and if the kind is not inside
// this many rows "never" is the honest answer.
const EVENT_SCAN = 2000;

// The same shape for the email-capture read: the newest rows on the source
// index, cut at the window. A window holding more email captures than this is
// a mail flood, and the morning message is a morning read.
const CAPTURE_SCAN = 500;

// How many delegate decisions one morning's objection list is gathered from.
const OBJECTION_SCAN = 200;

/**
 * The newest "digest-sent" row: which day went out last, and where that run's
 * window ended. Read on the by_kind_key index, whose columns are
 * (kind, key, at) — "digest-sent" rows never carry a key, so within the kind
 * the order IS time order and `.order("desc").first()` is the newest row. A
 * scan of recent events would not do: dtsEvents is busy instrumentation and a
 * daily row falls off the end of any bounded scan.
 *
 * `windowEnd` is absent on rows written before the lifeos update. Those are
 * from August and naming their `at` as the next window's start would open a
 * weeks-wide window, so they answer null and the caller covers the last day.
 */
async function lastDigestSent(
  ctx: QueryCtx,
): Promise<{ day: string | null; windowEnd: number | null } | null> {
  const row = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", DIGEST_SENT))
    .order("desc")
    .first();
  if (!row) return null;
  const d = (row.data ?? {}) as { day?: unknown; windowEnd?: unknown };
  return {
    day: typeof d.day === "string" ? d.day : null,
    windowEnd: typeof d.windowEnd === "number" ? d.windowEnd : null,
  };
}

/**
 * The two facts a run needs from the last one, in one read: the day it covered
 * (`lastDay` — equal to today means today's has gone out) and where this run's
 * window starts. The sender needs `since` before it composes, because it reads
 * WikiTom over the same window.
 */
export const internalDigestWindow = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const row = await lastDigestSent(ctx);
    return { lastDay: row?.day ?? null, since: row?.windowEnd ?? now - DAY_MS };
  },
});

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The failure kinds that are NOT a #tts-broken line. "slack-send-failed" is
 *  the Slack door's own: reporting it in a Slack message is the loop
 *  convex/ttsHourly.ts already warns about. */
const NOT_A_FAILURE_LINE = new Set(["slack-send-failed"]);

export async function gatherTodayFacts(
  ctx: QueryCtx,
  {
    day,
    now,
    since,
  }: {
    day: string;
    now: number;
    since: number;
  },
): Promise<TodayFacts> {
  const { start: dayStart, end: dayEnd } = nyCalendarDayBoundsUtc(day);

  // Names for the ids the sections actually touch, fetched one at a time and
  // remembered. The whole dtsTodos and batches tables were read here before —
  // two full-table scans that grow with the record forever, for a handful of
  // lookups.
  const todoCache = new Map<string, Doc<"dtsTodos"> | null>();
  const todoOf = async (id: Id<"dtsTodos"> | undefined): Promise<Doc<"dtsTodos"> | null> => {
    if (id === undefined) return null;
    const hit = todoCache.get(id);
    if (hit !== undefined) return hit;
    const row = await ctx.db.get(id);
    todoCache.set(id, row);
    return row;
  };
  const batchCache = new Map<string, string | null>();
  const batchName = async (id: Id<"batches"> | undefined): Promise<string | null> => {
    if (id === undefined) return null;
    const hit = batchCache.get(id);
    if (hit !== undefined) return hit;
    const name = (await ctx.db.get(id))?.statement ?? null;
    batchCache.set(id, name);
    return name;
  };
  const batchOfTodo = async (id: Id<"dtsTodos"> | undefined): Promise<string | null> =>
    await batchName((await todoOf(id))?.batchId);

  // 1. Dated and late: every active dated todo due today or earlier, oldest
  //    date first — what the cap drops has to be the newest, because an item
  //    three weeks late is the one Tom needs named in the morning.
  const dated = (
    await ctx.db
      .query("dtsTodos")
      .withIndex("by_status_and_due", (q) =>
        q.eq("status", "active").gte("dueAt", 0).lt("dueAt", dayEnd),
      )
      .collect()
  )
    .filter((t) => t.dueAt !== undefined)
    .sort((a, b) => (a.dueAt as number) - (b.dueAt as number))
    .map((t) => ({
      id: t._id as string,
      statement: t.statement,
      entryAction: t.entryAction,
      dueAt: t.dueAt as number,
      countdown: latenessText(t.dueAt as number, now),
    }));
  const datedIds = new Set(dated.map((d) => d.id));
  const lateCount = dated.filter((d) => (d.dueAt as number) < dayStart).length;
  const oldest = dated[0];
  const oldestLateBy =
    oldest !== undefined && (oldest.dueAt as number) < dayStart
      ? lateBy(oldest.dueAt as number, now)
      : undefined;

  // 2. The calendar. Blocks and mirrored calendar events overlapping the day,
  //    with EVERY ROW FROM A PRIVATE FEED DROPPED (Tom 2026-09-09): the family
  //    calendar stays in the record, and nothing he reads names it.
  const privateFeeds = privateFeedNames(process.env.TTS_ICS_FEEDS);
  const blockRows = await ctx.db
    .query("dtsBlocks")
    .withIndex("by_start", (q) => q.gte("start", dayStart - 31 * DAY_MS).lt("start", dayEnd))
    .collect();
  const spans: { start: number; end: number; title: string; allDay: boolean }[] = [];
  for (const b of blockRows) {
    if (b.end <= dayStart) continue;
    spans.push({
      start: b.start,
      end: b.end,
      title: (await todoOf(b.todoId))?.statement ?? b.category ?? b.note ?? "block",
      allDay: false,
    });
  }
  for (const e of await ctx.db
    .query("ttsCalendarEvents")
    .withIndex("by_start", (q) => q.gte("start", dayStart - 31 * DAY_MS).lt("start", dayEnd))
    .collect()) {
    if (e.end <= dayStart) continue;
    if (feedIsPrivate(e.feed, privateFeeds)) continue;
    spans.push({ start: e.start, end: e.end, title: e.title, allDay: e.allDay });
  }
  spans.sort((a, b) => a.start - b.start);
  const calendar = spans.map((s) => ({
    title: s.title,
    when: s.allDay ? "" : `${nyHhmm(s.start)} to ${nyHhmm(s.end)}`,
    allDay: s.allDay,
  }));

  // 3. Email captures since the last morning message. A capture that is ready
  //    is a thing to do today and reaches him through the ready count below; a
  //    capture that is not ready is a row, not a line (§4.3). Read only to
  //    keep them out of the ready list twice.
  const emailCaptureIds = new Set(
    (
      await ctx.db
        .query("dtsTodos")
        .withIndex("by_source", (q) => q.eq("source", "email"))
        .order("desc")
        .take(CAPTURE_SCAN)
    )
      .filter((t) => t.createdAt >= since && t.createdAt < now)
      .map((t) => t._id as string),
  );

  // 4. The night's events, oldest first: what the box left behind, what broke,
  //    and the delegate's decisions.
  const events = (
    await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", since).lt("at", now))
      .order("desc")
      .take(EVENT_SCAN)
  ).reverse();

  // OUTCOMES, NEVER LOGGED EVENTS. One line per BATCH, from every event in the
  // window that named it: a night of five "plan stored" rows on one batch is
  // ONE sentence about that batch.
  const outcomes = new Map<string, BatchOutcome>();
  const outcomeFor = (batchId: string | null, statement: string): BatchOutcome => {
    const key = batchId ?? "none";
    let row = outcomes.get(key);
    if (row === undefined) {
      row = {
        batchId,
        statement: batchId === null ? "Work outside any batch" : statement,
        added: 0,
        reworked: 0,
        dropped: 0,
        finished: 0,
        running: false,
      };
      outcomes.set(key, row);
    }
    return row;
  };
  const failures = new Map<string, BrokenFact>();
  const failure = (job: string, statement: string, url?: string): BrokenFact => {
    let row = failures.get(job);
    if (row === undefined) {
      row = { statement, url, count: 0 };
      failures.set(job, row);
    }
    row.count = (row.count ?? 0) + 1;
    return row;
  };
  const rawObjections: {
    at: number;
    // "" for a merge: a merge is REPORTED for objection, not decided by the
    // delegate, so its number in the printed list names no askId and a reply
    // that types it falls through to the ordinary paths.
    askId: string;
    todoId?: string;
    decision: string | null;
    reason?: string;
    refused: boolean;
    refusedBecause?: string;
    fallback?: string;
  }[] = [];

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "graph-stored": {
        const batchId = str(d.batchId);
        const named = batchId
          ? ((await batchName(ctx.db.normalizeId("batches", batchId) ?? undefined)) ?? "A batch")
          : null;
        const row = outcomeFor(batchId ?? null, named ?? "A batch");
        row.added += num(d.created);
        row.reworked += num(d.updated);
        row.dropped += num(d.retired) + num(d.archived);
        break;
      }
      case "graph-batch-formed": {
        const name = str(d.statement);
        if (name !== undefined) outcomeFor(str(d.batchId) ?? name, name);
        break;
      }
      case "session-outcome": {
        const sessionId = str(d.sessionId);
        const rowId = sessionId ? ctx.db.normalizeId("claudeSessions", sessionId) : null;
        const session = rowId ? await ctx.db.get(rowId) : null;
        const named =
          (await batchName(session?.batchId)) ?? (await batchOfTodo(session?.todoId ?? e.todoId));
        if (named !== null) outcomeFor(session?.batchId ?? null, named).finished += 1;
        if (d.outcome === "errored") {
          failure(
            "session",
            "A session ended in an error overnight, so whatever it was carrying is not done.",
            str(d.sessionId) === undefined ? undefined : ttsSessionLink(str(d.sessionId) as string),
          ).detail = str(d.summary) ?? str(d.title);
        }
        break;
      }
      case "session-created": {
        const sessionId = str(d.sessionId);
        const rowId = sessionId ? ctx.db.normalizeId("claudeSessions", sessionId) : null;
        const session = rowId ? await ctx.db.get(rowId) : null;
        const named =
          (await batchName(session?.batchId)) ?? (await batchOfTodo(session?.todoId ?? e.todoId));
        if (named !== null) {
          const row = outcomeFor(session?.batchId ?? null, named);
          if (session !== null && LIVE_STATUSES.includes(session.status as never)) row.running = true;
        }
        break;
      }
      case "session-ended": {
        if (d.status !== "failed") break;
        const sessionId = str(d.sessionId);
        failure(
          "session",
          "A session failed overnight, so whatever it was carrying is not done.",
          sessionId === undefined ? undefined : ttsSessionLink(sessionId),
        ).detail = str(d.endedReason) ?? str(d.title);
        break;
      }
      case DELEGATE_DECISION: {
        // An attended ask is a prompt bug, not a decision taken for him while
        // he slept: ttsAsk refuses it and it is not a morning line.
        if (d.attended === true) break;
        rawObjections.push({
          at: e.at,
          askId: str(d.askId) ?? (e.key ?? ""),
          todoId: e.todoId === undefined ? str(d.todoId) : (e.todoId as string),
          decision: str(d.decision) ?? null,
          reason: str(d.reason),
          refused: d.refused === true,
          refusedBecause: str(d.refusedBecause),
          fallback: str(d.fallback),
        });
        break;
      }
      case MERGE: {
        // A merge passed its three mechanical gates, so nothing asked Tom
        // about it. It is reported here for objection, and its wording never
        // assigns the merge to the delegate.
        const repo = str(d.repo) ?? "repo";
        const sha = (str(d.sha) ?? "").slice(0, 7);
        rawObjections.push({
          at: e.at,
          askId: "",
          todoId: e.todoId === undefined ? str(d.todoId) : (e.todoId as string),
          decision: `merged ${repo}@${sha}: ${str(d.subject) ?? "no subject"}`,
          refused: false,
        });
        break;
      }
      case PRELUDE_DELIVERY: {
        // The nightly delivery check. A CLEAN run is not a morning line — it
        // is in the weekly (convex/ttsWeekly.ts) and on its own row. What
        // reaches him is a session that did not get the current model-of-tom.
        const stale = (Array.isArray(d.stale) ? d.stale : []).flatMap((row) =>
          row !== null && typeof row === "object" ? [row as Record<string, unknown>] : [],
        );
        const missing = (Array.isArray(d.missing) ? d.missing : []).flatMap((row) =>
          row !== null && typeof row === "object" ? [row as Record<string, unknown>] : [],
        );
        if (stale.length === 0 && missing.length === 0) break;
        const clauses: string[] = [];
        if (stale.length > 0) {
          clauses.push(`${stale.length} began from an older model-of-tom commit`);
        }
        if (missing.length > 0) clauses.push(`${missing.length} from none at all`);
        const first = stale[0] ?? missing[0];
        const firstId = str(first?.id);
        const row = failure(
          "prelude-delivery",
          `Sessions ran without the model-of-tom they should have had: ${clauses.join(", and ")}.`,
          firstId === undefined ? undefined : ttsSessionLink(firstId),
        );
        row.detail = str(first?.title);
        break;
      }
      case EVALS_RUN: {
        // Same rule: a passing run is the weekly's fact, and a regression is
        // his. `regressions` and `stillFailing` are the runner's own
        // comparison against the base run; this never reimplements gate().
        const regressions = typeof d.regressions === "number" ? d.regressions : 0;
        const stillFailing = typeof d.stillFailing === "number" ? d.stillFailing : 0;
        if (regressions === 0 && stillFailing === 0) break;
        const clauses: string[] = [];
        if (regressions > 0) {
          clauses.push(`${regressions} ${regressions === 1 ? "regression" : "regressions"}`);
        }
        if (stillFailing > 0) clauses.push(`${stillFailing} still failing`);
        const row = failure(
          "evals",
          `The evals came back short at ${str(d.repo) ?? "the repo"} ${(str(d.sha) ?? "").slice(0, 7)}: ${clauses.join(", ")}.`,
        );
        const firstRegression = (Array.isArray(d.failures) ? d.failures : []).flatMap((f) =>
          f !== null && typeof f === "object" && (f as Record<string, unknown>).regression === true
            ? [f as Record<string, unknown>]
            : [],
        )[0];
        if (firstRegression !== undefined) {
          row.detail = `${str(firstRegression.id) ?? "an item"} (${str(firstRegression.partition) ?? "?"}) — ${str(firstRegression.reason) ?? ""}`;
        }
        break;
      }
      default: {
        // Every job failure is a "-failed" kind (a box job reports its own
        // through POST /tts/job-failed). A Slack failure is the door's own and
        // is not a line.
        if (!e.kind.endsWith("-failed") || NOT_A_FAILURE_LINE.has(e.kind)) break;
        const job = str(d.job) ?? e.kind.replace(/-failed$/, "");
        failure(job, brokenStatement(job)).detail = str(d.error);
      }
    }
  }

  // 5. Ready for Tom (not already dated) — ruling 18's computation
  //    (ttsShared.isReadyForTom). Read on the readiness index for "prepared",
  //    so the scan is the prepared list itself. §4.3: the ready SECTION is
  //    gone; the count is the today section's last sentence.
  const preparedRows: Doc<"dtsTodos">[] = await ctx.db
    .query("dtsTodos")
    .withIndex("by_readiness", (q) => q.eq("readiness", "prepared"))
    .collect();
  const readyIds = new Set<string>();
  for (const t of preparedRows) {
    if (t.status !== "active" || datedIds.has(t._id as string)) continue;
    const needRows: Doc<"dtsTodos">[] = [];
    for (const id of t.needs ?? []) {
      const need = await ctx.db.get(id);
      if (need) needRows.push(need);
    }
    if (!isReadyForTom(t, buildDoneSet(needRows), now)) continue;
    readyIds.add(t._id as string);
  }
  // A capture from the night that is not ready is a row, not a line, and is
  // not counted here either: the count says how many things are WAITING.
  for (const id of emailCaptureIds) if (!readyIds.has(id)) emailCaptureIds.delete(id);

  // 6. The objection list, ordered by importance (delegate-design.md §2.3) and
  //    numbered in printed order. Nothing at all when the delegate has taken
  //    no decision — the rows may not exist yet: the delegate is built on
  //    branch uac/delegate and this reads by kind if present.
  const objections = rawObjections
    .slice(-OBJECTION_SCAN)
    .sort(
      (a, b) =>
        objectionRank(a, readyIds, datedIds) - objectionRank(b, readyIds, datedIds) ||
        b.at - a.at,
    )
    .map((o) => ({
      askId: o.askId,
      todoId: o.todoId,
      decision: o.decision ?? "no answer came back, so the run took its own fallback",
      reason: o.reason,
      refused: o.refused,
      refusedBecause:
        o.refusedBecause === undefined ? undefined : stripNarrowListId(o.refusedBecause),
      fallback: o.fallback,
    }));

  const overnight = [...outcomes.values()];
  return {
    day,
    today: dated,
    lateCount,
    oldestLateBy,
    readyBeyond: readyIds.size,
    calendar,
    calendarLead: spans.length === 0 ? undefined : calendarLeadText(spans),
    objections: objections.slice(0, OBJECTION_CAP),
    objectionsBeyond: Math.max(0, objections.length - OBJECTION_CAP),
    overnight,
    batchesPlanned: overnight.length,
    batchesFinished: overnight.filter((o) => o.finished > 0).length,
    broken: [...failures.values()],
  };
}

/** The objection list's own cap, before the whole-message fit. */
const OBJECTION_CAP = 12;

/** "ten days", for the first line's "the oldest by …". */
function lateBy(dueAt: number, now: number): string {
  const days =
    (Date.parse(nyCalendarDayKey(now)) - Date.parse(nyCalendarDayKey(dueAt))) / DAY_MS;
  return `${countWord(days)} ${days === 1 ? "day" : "days"}`;
}

/** What a failed job MEANS FOR HIM, which is the only reason it is a message.
 *  A job with no sentence here says the plain fact and links nowhere. */
function brokenStatement(job: string): string {
  const known: Record<string, string> = {
    "poll-gmail": "Nothing has been captured from email since the poller started failing.",
    "poll-dump": "Nothing typed in #dump has reached TTS since the poller started failing.",
    "poll-canvas": "Canvas assignments have stopped reaching your list.",
    "poll-outlook": "Outlook mail has stopped reaching your list.",
    nightly: "The nightly job did not finish, so the model-of-Tom pages are yesterday's.",
    "wikitom-read": WIKITOM_UNREADABLE,
  };
  return known[job] ?? `The ${job} job failed overnight.`;
}

// ── Composing the morning message ────────────────────────────────────────────

// The window's start: the END of the last sent message's window, else one day
// back. Read from the "digest-sent" row rather than
// dtsDailyQueues.digestSentAt — a row is written per SEND, and its windowEnd
// is the instant the message was composed against, so the seconds spent
// composing and posting are inside the next window instead of falling between
// the two. A missed morning is not lost: the next one simply covers both.
async function digestWindowStart(ctx: QueryCtx, now: number): Promise<number> {
  const row = await lastDigestSent(ctx);
  return row?.windowEnd ?? now - DAY_MS;
}

/**
 * The morning message's facts, its template text, and the FACTS BLOCK the
 * Fable writer on the box is given (Tom 2026-09-09, amendment 2). Everything
 * here is deterministic; the model call, when there is one, happens on the box
 * and is verified against `facts` before anything is posted.
 */
export const internalComposeToday = internalQuery({
  // `since` is the window start the sender already read (internalDigestWindow),
  // passed back so one run composes and reads over the same window. Absent —
  // a manual run, a test — it is read here.
  args: {
    day: v.string(),
    now: v.number(),
    since: v.optional(v.number()),
    // Whether a reply would actually reach TTS (ttsSync.replyRouteLive). Every
    // reply invitation in every message is conditional on it and on nothing
    // else, so the composer stays pure and this is the one place it enters.
    canReply: v.optional(v.boolean()),
  },
  handler: async (ctx, { day, now, since: givenSince, canReply }) => {
    const since = givenSince ?? (await digestWindowStart(ctx, now));
    const facts = await gatherTodayFacts(ctx, { day, now, since });
    const reply = canReply ?? false;
    const { message, truncated } = composeTodayFitted(facts, { canReply: reply });
    return {
      text: renderSlack(message),
      // Whether runs were reduced to one sentence to fit one Slack message;
      // the sender records it on the "digest-sent" row.
      truncated,
      since,
      // Every todo the message showed, for the "surfaced" instrumentation.
      surfacedTodoIds: facts.today
        .map((item) => ctx.db.normalizeId("dtsTodos", item.id))
        .filter((id): id is Id<"dtsTodos"> => id !== null),
      // The decisions the objection list carried, in PRINTED order: a reply of
      // "revert 2" names the second of these.
      objectionAskIds: facts.objections.map((o) => o.askId),
      // The deterministic inputs, each fact with an id, its link and its
      // numbers. Stored on the digest event, and handed to the writer.
      facts: todayFactsBlock(facts, reply),
    };
  },
});
