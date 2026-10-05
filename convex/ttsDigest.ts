import { v } from "convex/values";
import {
  composeTodayFitted,
  countWord,
  itemUrl,
  renderSlack,
  todayFactsBlock,
  type BrokenFact,
  type SpendFact,
  type TodayFacts,
  type TodoOutcome,
} from "./ttsCompose";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordMissedKeepingDate } from "./tts";
import { DELEGATE_DECISION, objectionRank, stripNarrowListId } from "./ttsAsk";
import { LANDING_JOB, MERGE } from "./ttsMerge";
import { REMOVAL_LOOP_PR, SIMPLIFY_PROPOSAL } from "./ttsSimplify";
import { SEND_AS_TOM_FAILED, SENT_AS_TOM } from "./ttsSignoff";
import { EVAL_RUN, PRELUDE_DELIVERY } from "./ttsEvals";
import { AGENTS_WINDOW_URL, DEPLOY, boxChangeLines, boxChangesInWindow } from "./boxChanges";
import { failuresInWindow } from "./jarvis/jobs";
import {
  DAY_MS,
  LIVE_STATUSES,
  SESSION_OUTCOME,
  buildDoneSet,
  feedIsPrivate,
  isFailureKind,
  isReadyForTom,
  nyCalendarDayBoundsUtc,
  nyCalendarDayKey,
  privateFeedNames,
  ttsSessionLink,
} from "./ttsShared";
import { displayTime } from "../shared/clock.mjs";
// THE ONE CHOKE POINT for a credential-shaped span, the same pure helper
// convex/ttsSearch.ts and worker/session-host use — never a second copy of the
// patterns. Every free-text error, reason, summary or title below passes
// through it before it becomes a broken-section line or a `broken:<n>` fact:
// worker/jobs/nightly.mjs reports git stderr verbatim, and git stderr can name
// a tokenised remote.
import { redactSecrets } from "../shared/redact.mjs";
import { decidedByText } from "../shared/decided-by.mjs";
import { DIGEST_LINE, digestFacts, lastDigest } from "./jarvis/outbox";
import { DISAGREEMENT_SETTLED } from "./jarvis/intent";
import { readTodo } from "./jarvis/tables";
import { MAX_DOCUMENT_BYTES, MIB, ReadBudget, getWithin, readWithin, type ReadCut } from "./readBudget";

// ── THE MORNING MESSAGE (slack-design.md, Tom 2026-09-09) ───────────────────
// This file GATHERS THE FACTS. Turning them into sentences is convex/
// ttsCompose.ts's one job, and the send is the box's: POST /jarvis/digest
// (convex/jarvis/digest.ts) runs the missed rollover and reads
// internalComposeToday, and Jarvis worker/jobs/write-slack.mjs posts the text
// to the one output channel. No model writes it. This module is plain runtime
// (no "use node") so the gatherer is a query and the composer beneath it is a
// pure function a test calls with hand-built facts.
//
// HIS WORD IS "THE DIGEST" (Tom's ruling). Every line Tom or a model can read
// names this message "the digest"; "morning message" is a term for comments
// like this one and appears in nothing that is printed. The code already
// spells it that way throughout — `digest-sent`, `internalDigestWindow`,
// `digestWindowStart`.
//
// The runs, in this order; each omitted when empty except the first:
//   1. today — dated or late, oldest date first, each line naming the first
//      move, and one sentence for how many other todos are ready
//   2. the objection list — what the delegate decided while he was asleep,
//      numbered in printed order; silence means it stands
//   3. the calendar — his day, WITH EVERY PRIVATE FEED'S ROWS DROPPED
//   4. overnight — one line per TODO saying what the sessions on it came to,
//      never one line per logged event (Tom, 2026-09-24: no batches)
//   5. broken — the jobs that failed, and what that means for him
//   6. spend — what the agents that started in the window cost, by model
//      family and by who watched them
//
// What LEFT the morning message in this round (§4.3): the WikiTom commit list
// (a changelog is not a morning read; an unreadable WikiTom is a broken line
// instead), the rulings-from-your-words lines and the model-of-Tom lines
// (both are decisions taken in his name, so both are objection-list lines
// now, through convex/jarvis/outbox.ts listForDigest), and
// the "Captured from email" section (a capture that is ready is a thing to do
// today; one that is not is a row, not a line).

export const SLACK_FAILED = "slack-send-failed";
export const DIGEST_SENT = "digest-sent";

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
// nightly job wrote about him is a decision taken in his name, so it is a
// line on the objection list (convex/ttsNightly.ts internalRecordWorkerEvent).
//   kind "learning-change",        data { id, file, section, before, after, evidence, excerpt,
//                                         baseBlob, resultBlob, modelOfTomCommit }
//   kind "learning-reverted",      data { id, file, before, after, objection, baseBlob,
//                                         resultBlob, modelOfTomCommit }
//   kind "learning-revert-failed", data { id?, file?, reason, objection }
export const LEARNING_CHANGE = "learning-change";
export const LEARNING_REVERTED = "learning-reverted";
export const LEARNING_REVERT_FAILED = "learning-revert-failed";
export { PRELUDE_DELIVERY } from "./ttsEvals";

// The night the learning step took its WHOLE write back: WikiTom's
// scripts/check-evidence.mjs failed after the write, so every line the night
// put on a page was reverted rather than left standing behind a failing check.
// NOT a decision — nothing stands to object to — and not a quiet night either,
// which is the confusion silence would leave. It is a line in the broken
// section, in its own words (convex/ttsNightly.ts internalRecordWorkerEvent).
//   kind "learning-check-failed", data { baseline, stage?: "reverts" | "changes",
//                                        changes?, output }
// `baseline` true means the check was ALREADY failing before the run, so the
// step wrote nothing at all; false means it wrote and then took it all back.
export const LEARNING_CHECK_FAILED = "learning-check-failed";

// The nightly "repo-learning" step reads the night's sessions and proposes
// lines for the nested AGENTS.md of a repository they worked in. The line
// lands in that repository through ITS OWN checks — a branch, a review, a
// merge — so what he is shown is a PROPOSAL, not a write. It is a decision
// taken in his name like a model-of-Tom line, and it reaches him the same way:
// a line on the objection list (convex/ttsNightly.ts
// internalRecordWorkerEvent), where "revert <n>" in the digest's thread drops
// it before it is ever applied. A reply there naming its id does the same
// (convex/ttsSlack.ts namedLearningChange searches both sets).
//   kind "repo-proposal",         data { id, repo, file, section, line, evidence }
//   kind "repo-proposal-applied", data { id, repo, file, section, line, evidence, commit }
//   kind "repo-proposal-dropped", data { id, repo, file, section, line, evidence, reason? }
// The step's own run row, kind "repo-learning-run", carries `notes`: whole
// lines it reported that are not one proposal. Nothing prints them today —
// they are read off the row when a night is being explained.
export const REPO_PROPOSAL = "repo-proposal";
const REPO_PROPOSAL_APPLIED = "repo-proposal-applied";
const REPO_PROPOSAL_DROPPED = "repo-proposal-dropped";

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
// path writes the outcome row and the rollover's mark and NOTHING else — the
// date stays, its dateKind stays, and updatedAt is not bumped (see the
// comment there). The item is then
// still listed as overdue with its original date until Tom replies done or
// gives a new one. Idempotent: the outcome row's dueAt equals the todo's dueAt
// afterwards, and that equality is the "already recorded" check.
export function isPassedWithoutOutcome(
  todo: Pick<Doc<"todos">, "status" | "dueAt" | "dateOutcomes">,
  newDayStart: number,
): boolean {
  if (todo.status !== "active" || todo.dueAt === undefined) return false;
  if (todo.dueAt >= newDayStart) return false;
  const dueAt = todo.dueAt;
  return !(todo.dateOutcomes ?? []).some((o) => o.dueAt === dueAt);
}

export async function rollMissed(
  ctx: MutationCtx,
  day: string,
): Promise<{ rolled: Id<"todos">[]; cuts: ReadCut[] }> {
  const { start } = nyCalendarDayBoundsUtc(day);
  const budget = ReadBudget.of(ROLLOVER_BYTES);
  // The rows the rollover has not settled for their current date, and no
  // others: active, dated before the new day, and without the rollover's
  // mark (schema todos.rolledOverDueAt). Rows settled on earlier mornings
  // are outside the range, so they never use up this read; the oldest
  // unsettled dates come first, and when the budget stops the read the rest
  // are the first read the next morning. The `gte(0)` lower bound excludes
  // undated rows, which sort before every number in a Convex index.
  const unsettled = await readWithin(
    budget.allot("past-dated todos for the missed rollover", ROLLOVER_BYTES / 2),
    ctx.db
      .query("todos")
      .withIndex("by_status_rollover_due", (q) =>
        q.eq("status", "active").eq("rolledOverDueAt", undefined).gte("dueAt", 0).lt("dueAt", start),
      )
      .order("asc"),
    Number.POSITIVE_INFINITY,
  );
  // Every row read is settled here and leaves the range: marked missed, or,
  // when an outcome for its date is already recorded (Tom's, or a missed mark
  // from before the field existed), given the mark alone. A patch reads the
  // row it changes; that read is counted under the other half of the budget.
  // The rows patched are the rows read above, so this half binds only where
  // that one did; a row it skips stays unsettled for the next morning.
  const patches = budget.allot("past-dated todos settled", ROLLOVER_BYTES / 2);
  const rolled: Id<"todos">[] = [];
  for (const todo of unsettled) {
    if (!patches.open) {
      patches.skip();
      continue;
    }
    patches.charge(todo);
    if (isPassedWithoutOutcome(todo, start)) {
      await recordMissedKeepingDate(ctx, todo, ROLLOVER_NOTE);
      rolled.push(todo._id);
    } else {
      await ctx.db.patch(todo._id, { rolledOverDueAt: todo.dueAt });
    }
  }
  return { rolled, cuts: budget.cuts() };
}

export const internalRollMissed = internalMutation({
  args: { day: v.string() },
  handler: async (ctx, { day }) => (await rollMissed(ctx, day)).rolled,
});

// ── Gathering the day's facts ────────────────────────────────────────────────
// Deterministic, from queries, no model call. What comes out is `TodayFacts`
// (convex/ttsCompose.ts): the shape the digest is rendered from, and the shape
// the facts block is built from.

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
  const from = displayTime(timed[0].start);
  const to = displayTime(Math.max(...timed.map((s) => s.end)));
  return `Your day is committed from ${from} to ${to}.`;
}

// ── What one digest reads ───────────────────────────────────────────────────
// Every read gathering the day's facts has a row cap and a byte allotment
// (convex/readBudget.ts), and the allotments share one gather budget. The row
// caps bound the rows a read walks; the bytes are what Convex limits.

/** A day normally has hundreds of legacy events; the cap bounds the busy instrumentation window. */
const EVENT_SCAN = 2000;
/** A day normally has tens of deploy rows; the cap bounds that kind's catch-up window. */
const BOX_SCAN = 2000;

/** A day normally has tens of email captures; the cap bounds a mail-flood window. */
const CAPTURE_SCAN = 500;

/** A day normally has a handful of decisions; the cap bounds each objection source. */
const OBJECTION_SCAN = 200;

/** A day normally has tens of dated todos; the cap keeps a long backlog inside one digest read. */
const DATED_SCAN = 500;
/** A day normally has tens of calendar rows; the cap bounds each 31-day overlap scan. */
const CALENDAR_SCAN = 500;
/** A day normally has tens of prepared todos. */
const READY_SCAN = 200;
/** A todo is marked surfaced once per digest that showed it. */
const SURFACED_SCAN = 50;

/** The bytes one gather reads in all. The missed rollover reads up to
 *  ROLLOVER_BYTES in the same transaction (convex/jarvis/digest.ts compose),
 *  and each of the two budgets can overshoot by one document, so together
 *  they read at most 11 + 1.5 + 2 × 1 = 14.5 MiB of Convex's 16. */
export const GATHER_BYTES = 11 * MIB;
export const ROLLOVER_BYTES = 1.5 * MIB;

/** Each read's allotment of GATHER_BYTES; they sum to it. Read from
 *  production on 2026-10-04, over the window since the last digest that went
 *  out (2026-09-28): the 1,000 agent runs read were 2.8 MB, the 2,000 events
 *  1.4 MB, and 1,588 todos 8.9 MB (5.6 KB each on average, an explanation up
 *  to 64 KB). */
export const READ_BYTES = {
  dated: 1.5 * MIB,
  blocks: 0.25 * MIB,
  calendarEvents: 0.25 * MIB,
  emailCaptures: 0.5 * MIB,
  objectionEvents: 0.5 * MIB,
  nightEvents: 1.5 * MIB,
  workOutcomes: 0.5 * MIB,
  evalRuns: 0.125 * MIB,
  decisions: 0.125 * MIB,
  digestLines: 0.125 * MIB,
  settlements: 0.125 * MIB,
  jobReports: 0.25 * MIB,
  prepared: 1.5 * MIB,
  needs: 0.5 * MIB,
  lookups: 0.5 * MIB,
  surfacedMarks: 0.125 * MIB,
  deploys: 0.125 * MIB,
  boxChanges: 0.5 * MIB,
  runs: 2 * MIB,
} as const;

/** The most one digest's transaction reads (GATHER_BYTES above); the tests
 *  hold it under CONVEX_READ_LIMIT. */
export const DIGEST_READ_BOUND = GATHER_BYTES + ROLLOVER_BYTES + 2 * MAX_DOCUMENT_BYTES;

/** THE THREAD DIGEST'S SHARES OF THE SAME BOUND. appendThreadDigest
 *  (convex/jarvis/digest.ts) runs the rollover, a gather and its own reads
 *  (the digest rows it checks, the openings it lists and the items it lists
 *  them against, the surfaced marks) in one transaction, so its own reads
 *  take THREAD_OWN_BYTES out of the gather's share: 1.5 + 8 + 2, and one
 *  document past each of the three budgets, is 14.5 MiB, DIGEST_READ_BOUND,
 *  1.5 MiB under Convex's 16. */
export const THREAD_OWN_BYTES = 2 * MIB;
export const THREAD_GATHER_BYTES = GATHER_BYTES - THREAD_OWN_BYTES - MAX_DOCUMENT_BYTES;

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
  const row = await lastDigest(ctx);
  if (!row) return null;
  const { day, windowEnd } = digestFacts(row);
  return { day, windowEnd };
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

/** The clause naming who took a decision row and how long its question
 *  waited for Tom first, as the objection line carries it; nothing for a
 *  delegate decision with no recorded wait. */
function whoDecided(d: Record<string, unknown>): { decidedByText?: string } {
  const text = decidedByText(d.decidedBy === "tom", d.waitedMs);
  return text === null ? {} : { decidedByText: text };
}

/** `str`, with every credential-shaped span taken out. EVERY FREE-TEXT ERROR
 *  OR REASON that becomes a line or a fact reads through this one and not
 *  through `str`: the string was written by a job's stderr or a model's
 *  summary, and neither is ours to trust. */
function safeStr(value: unknown): string | undefined {
  const text = str(value);
  return text === undefined ? undefined : redactSecrets(text);
}

/** The failure kinds that are NOT a broken line. "slack-send-failed" is the
 *  Slack door's own: reporting it in a Slack message is a loop. The learning
 *  night that took itself back is said in its own words, from the line the
 *  nightly put on the digest (convex/ttsNightly.ts). Its row stays, because
 *  it is the record of the night (the box's output and the reverted changes,
 *  read on /agents); excluded here, or the digest would say the night twice. */
const NOT_A_FAILURE_LINE = new Set(["slack-send-failed", LEARNING_CHECK_FAILED]);

/** One row of the night as the digest reads it: a dtsEvents row, or a work
 *  outcome from the record's events table in the same shape. */
type NightRow = Pick<Doc<"dtsEvents">, "at" | "kind" | "todoId" | "data" | "key">;

export async function gatherTodayFacts(
  ctx: QueryCtx,
  {
    day,
    now,
    since,
    earlierCuts = [],
    bytes = GATHER_BYTES,
  }: {
    day: string;
    now: number;
    since: number;
    /** Reads the same transaction stopped before the gather (the rollover). */
    earlierCuts?: ReadCut[];
    /** The gather's budget: GATHER_BYTES, or THREAD_GATHER_BYTES. */
    bytes?: number;
  },
): Promise<TodayFacts> {
  const { start: dayStart, end: dayEnd } = nyCalendarDayBoundsUtc(day);
  const budget = ReadBudget.of(bytes);

  // Every row looked up by id (a todo a row names, a session) shares one
  // allotment. Todos are fetched one at a time and remembered; an id comes
  // in either form (a stored reference holds the old
  // one: convex/jarvis/tables.ts) and the row is the plain one. Undefined:
  // the allotment was spent and the row was not read.
  const lookups = budget.allot("rows looked up by id", READ_BYTES.lookups);
  const seenTodos = new Map<string, Doc<"todos"> | null | undefined>();
  const todoOf = async (id: string | undefined): Promise<Doc<"todos"> | null | undefined> => {
    if (id === undefined) return null;
    if (seenTodos.has(id)) return seenTodos.get(id);
    const row = await getWithin(lookups, () => readTodo(ctx, id));
    seenTodos.set(id, row);
    return row;
  };

  // 1. Dated and late: every active dated todo due today or earlier, oldest
  //    date first — what the cap drops has to be the newest, because an item
  //    three weeks late is the one Tom needs named in the morning.
  const dated = (
    await readWithin(
      budget.allot("dated todos", READ_BYTES.dated),
      ctx.db
        .query("todos")
        .withIndex("by_status_and_due", (q) =>
          q.eq("status", "active").gte("dueAt", 0).lt("dueAt", dayEnd),
        )
        .order("asc"),
      DATED_SCAN,
    )
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
  const blockRows = await readWithin(
    budget.allot("calendar blocks", READ_BYTES.blocks),
    ctx.db
      .query("blocks")
      .withIndex("by_start", (q) => q.gte("start", dayStart - 31 * DAY_MS).lt("start", dayEnd)),
    CALENDAR_SCAN,
  );
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
  const calendarRows = await readWithin(
    budget.allot("calendar events", READ_BYTES.calendarEvents),
    ctx.db
      .query("ttsCalendarEvents")
      .withIndex("by_start", (q) => q.gte("start", dayStart - 31 * DAY_MS).lt("start", dayEnd)),
    CALENDAR_SCAN,
  );
  for (const e of calendarRows) {
    if (e.end <= dayStart) continue;
    if (feedIsPrivate(e.feed, privateFeeds)) continue;
    spans.push({ start: e.start, end: e.end, title: e.title, allDay: e.allDay });
  }
  spans.sort((a, b) => a.start - b.start);
  const calendar = spans.map((s) => ({
    title: s.title,
    when: s.allDay ? "" : `${displayTime(s.start)} to ${displayTime(s.end)}`,
    allDay: s.allDay,
  }));

  // 3. Email captures since the last morning message. A capture that is ready
  //    is a thing to do today and reaches him through the ready count below; a
  //    capture that is not ready is a row, not a line (§4.3). Read only to
  //    keep them out of the ready list twice.
  const recentEmail = await readWithin(
    budget.allot("email captures", READ_BYTES.emailCaptures),
    ctx.db
      .query("todos")
      .withIndex("by_source", (q) => q.eq("source", "email"))
      .order("desc"),
    CAPTURE_SCAN,
  );
  const emailCaptures = recentEmail.filter((t) => t.createdAt >= since && t.createdAt < now);
  const emailCaptureIds = new Set(emailCaptures.map((t) => t._id as string));

  //    Of the recent mail captures, the ones the triage judged to need him
  //    today, still active, and NOT YET SHOWN in a morning message. No worker
  //    raises these with him (Tom, 2026-09-21), so this message says them,
  //    each once: a line printed marks its todo surfaced, and one dropped for
  //    length stays unshown and comes back the next morning rather than aging
  //    out of a window. A morning reposted after a failed send records no
  //    surfaced todos (ttsSync's resend), so its flagged items are said again
  //    the next morning: the error is toward saying twice, never never. The
  //    field is never cleared: it is what the triage judged at capture, and
  //    the reader decides what is still to be said. Gmail's "email" is the one
  //    mail source that captures today; Outlook's joins when its poller does.
  //    Shown means a "surfaced" row the digest wrote (via "digest"); other
  //    writers of that kind do not count. The todo's surfaced rows are read
  //    on by_todo_kind, per id form it is stored under, at most SURFACED_SCAN
  //    each; a mark not read because a cap or the allotment stopped the read
  //    counts as not shown: the error stays toward saying twice.
  const flagged = recentEmail.filter(
    (t) => t.needsTomToday !== undefined && t.status === "active" && t.createdAt < now,
  );
  const surfacedBudget = budget.allot("surfaced marks of flagged emails", READ_BYTES.surfacedMarks);
  const unshown: typeof flagged = [];
  for (const t of flagged) {
    const old = t.legacyId === undefined ? null : ctx.db.normalizeId("dtsTodos", t.legacyId);
    let shown = false;
    for (const form of old === null ? [t._id] : [t._id, old]) {
      const marks = await readWithin(
        surfacedBudget,
        ctx.db
          .query("dtsEvents")
          .withIndex("by_todo_kind", (q) => q.eq("todoId", form).eq("kind", "surfaced")),
        SURFACED_SCAN,
      );
      if (marks.some((e) => (e.data as { via?: unknown } | undefined)?.via === "digest")) {
        shown = true;
        break;
      }
    }
    if (!shown) unshown.push(t);
  }
  const needsYou = unshown
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => ({ todoId: t._id as string, statement: t.statement, why: t.needsTomToday?.why ?? "" }));

  // 4. The night's events, oldest first: what the box left behind, what broke,
  //    and the delegate's decisions.
  //
  //    THE OBJECTION LIST'S KINDS ARE READ ON THEIR OWN INDEX (by_kind_at),
  //    not out of the newest EVENT_SCAN rows of every kind: a busy night of
  //    instrumentation must not push a decision taken in his name (a /tts/ask
  //    row), a merge or a message sent as him out of the window before the
  //    kind is looked at. The scan keeps the rest.
  //    The five kinds share one allotment and are read one after another
  //    (convex/readBudget.ts says why not in parallel).
  const objectionKinds = new Set<string>([DELEGATE_DECISION, MERGE, SENT_AS_TOM, SIMPLIFY_PROPOSAL, REMOVAL_LOOP_PR]);
  const objectionBudget = budget.allot("objection-list events", READ_BYTES.objectionEvents);
  const byKind: Doc<"dtsEvents">[][] = [];
  for (const kind of objectionKinds) {
    const rows = await readWithin(
      objectionBudget,
      ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since).lt("at", now))
        .order("desc"),
      OBJECTION_SCAN,
    );
    byKind.push(rows);
  }
  const scanned = await readWithin(
    budget.allot("events of the night", READ_BYTES.nightEvents),
    ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", since).lt("at", now))
      .order("desc"),
    EVENT_SCAN,
  );
  // THE WORK QUEUE'S OUTCOMES (Jarvis worker/jobs/work-queue.mjs) come
  //    through POST /jarvis/event into the record's events table, the todo as
  //    subject, and join the night's rows as an outcome on that todo. A row
  //    whose subject names no todo is the copy of a POST /tts/event row
  //    (subject = its key), which the scan above already read. Newest first,
  //    as the scan above: past the cap it is the oldest that go, never the
  //    night's last.
  //    An outcome whose todo the lookups could not read is left out, and
  //    counted in their cut line.
  const worked: NightRow[] = [];
  const workRows = await readWithin(
    budget.allot("work outcomes", READ_BYTES.workOutcomes),
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", SESSION_OUTCOME).gte("at", since).lt("at", now))
      .order("desc"),
    EVENT_SCAN,
  );
  for (const w of workRows) {
    const todo = await todoOf(w.subject);
    if (todo !== null && todo !== undefined) {
      worked.push({ at: w.at, kind: w.kind, todoId: todo._id, data: w.data, key: undefined });
    }
  }
  const events: NightRow[] = [...scanned.filter((e) => !objectionKinds.has(e.kind)), ...byKind.flat(), ...worked].sort(
    (a, b) => a.at - b.at,
  );

  // OUTCOMES, NEVER LOGGED EVENTS. One line per TODO, from every session
  // event in the window that named it: a night of five sessions on one todo is
  // ONE sentence about that todo. A session on no todo, or on a todo that is
  // gone, joins the one tail row, printed last.
  const byTodo = new Map<string, TodoOutcome>();
  const finishedSessions = new Set<string>();
  //    Null when the lookups were spent before the row was read: the event
  //    is then left out, and counted in their cut line.
  const todoOutcomeFor = async (
    todoId: string | undefined,
    sessionId: string | undefined,
  ): Promise<TodoOutcome | null> => {
    const todo = await todoOf(todoId);
    if (todo === undefined) return null;
    const key = todo === null ? "none" : (todo._id as string);
    let row = byTodo.get(key);
    if (row === undefined) {
      row = {
        todoId: todo === null ? null : (todo._id as string),
        statement: todo?.statement ?? "Work on no todo",
        sessionId: null,
        finished: 0,
        running: false,
      };
      byTodo.set(key, row);
    }
    // Events are read oldest first, so the last one seen is the newest.
    if (sessionId !== undefined) row.sessionId = sessionId;
    return row;
  };

  const sessionOf = async (sessionId: string | undefined) => {
    const rowId = sessionId ? ctx.db.normalizeId("claudeSessions", sessionId) : null;
    return rowId === null ? null : await getWithin(lookups, () => ctx.db.get(rowId));
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
  // ONE LINE PER FAILED SESSION. A failed flush can write both a
  // session-ended (failed) and a session-outcome (errored) row for one
  // session, and both writers stay (the status flush and the outcome stamp in
  // convex/claudeSessions.ts are each read elsewhere); they are one failure, and each session's line keeps its own
  // link and detail. The first row read names it; a later one only fills a
  // detail the first lacked.
  const sessionFailure = (sessionId: string | undefined, statement: string, detail: string | undefined) => {
    const key = sessionId === undefined ? "session" : `session:${sessionId}`;
    const known = failures.get(key);
    if (known !== undefined && sessionId !== undefined) {
      known.detail = known.detail ?? detail;
      return;
    }
    failure(key, statement, sessionId === undefined ? undefined : ttsSessionLink(sessionId)).detail = detail;
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
    // A merge, not a delegate decision. The lead counts the two separately
    // (ttsCompose.objectionsLead): nobody decided a merge in Tom's name.
    merged?: boolean;
    // A message sent in his name on his own sign-off: his decision, counted
    // apart from both.
    sentAsTom?: boolean;
    // A question Tom decided himself on /thread (convex/ttsAsk.ts decidedBy
    // "tom"), and the clause naming who decided after how long.
    decidedByTom?: boolean;
    decidedByText?: string;
  }[] = [];

  // The delegate's decisions recorded by `jarvis decide` (convex/jarvis/
  //    intent.ts, kind "decision"): the same objection list as the
  //    delegate-decision rows below, numbered with them.
  //    Newest first before the cap, so a busy window drops its oldest rows.
  //    The askId is the row's subject, which is what the objection resolver
  //    (convex/ttsAsk.ts internalRecordDelegateObjection) and jarvis/intent
  //    settle find it by. The model's words go through safeStr like every other.
  //
  //    ONE ROW PER DECISION. internalRecordAsk (convex/ttsAsk.ts) writes the
  //    ask's delegate-decision row and, for an ask the delegate answered, a
  //    decision row built from it in the same transaction, so a decided ask
  //    has both. The decision row is the one read for it; the ask row is read
  //    only for an ask whose decision row was not read here (no answer came
  //    back, a capped ask, or a decision row outside this window or cap).
  const decided = await readWithin(
    budget.allot("delegate decisions", READ_BYTES.decisions),
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", "decision").gte("at", since).lt("at", now))
      .order("desc"),
    OBJECTION_SCAN,
  );
  const decidedAskIds = new Set<string>();
  for (const row of decided) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    decidedAskIds.add(row.subject as string);
    rawObjections.push({
      at: row.at,
      askId: row.subject as string,
      todoId: str(d.todoId),
      decision: safeStr(d.decision) ?? null,
      reason: safeStr(d.reason),
      refused: d.refused === true,
      refusedBecause: safeStr(d.refusedBecause),
      // Who decided and how long the question waited for Tom: a decision
      // by Tom has this row, written in its ask's transaction, so this
      // reading is the one that says so.
      ...(d.decidedBy === "tom" ? { decidedByTom: true } : {}),
      ...whoDecided(d),
    });
  }

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "session-outcome": {
        const sessionId = str(d.sessionId);
        const session = await sessionOf(sessionId);
        const todoOutcome = await todoOutcomeFor(session?.todoId ?? e.todoId, sessionId);
        // A completed → errored correction is a second outcome event for the
        // same session, not a second session that ended.
        if (todoOutcome !== null && (sessionId === undefined || !finishedSessions.has(sessionId))) {
          todoOutcome.finished += 1;
          if (sessionId !== undefined) finishedSessions.add(sessionId);
        }
        if (d.outcome === "errored") {
          sessionFailure(
            sessionId,
            "A session ended in an error overnight, so whatever it was carrying is not done.",
            safeStr(d.summary) ?? safeStr(d.title),
          );
        }
        break;
      }
      case "session-created": {
        const sessionId = str(d.sessionId);
        const session = await sessionOf(sessionId);
        const live = session !== null && session !== undefined && LIVE_STATUSES.includes(session.status as never);
        const todoRow = await todoOutcomeFor(session?.todoId ?? e.todoId, sessionId);
        if (todoRow !== null && live) todoRow.running = true;
        break;
      }
      case "session-ended": {
        if (d.status !== "failed") break;
        sessionFailure(
          str(d.sessionId),
          "A session failed overnight, so whatever it was carrying is not done.",
          safeStr(d.endedReason) ?? safeStr(d.title),
        );
        break;
      }
      case DELEGATE_DECISION: {
        // An attended ask is a prompt bug, not a decision taken for him while
        // he slept: ttsAsk refuses it and it is not a morning line.
        if (d.attended === true) break;
        const askId = str(d.askId) ?? (e.key ?? "");
        // Its decision row, read above, is this decision's one line.
        if (decidedAskIds.has(askId)) break;
        rawObjections.push({
          at: e.at,
          askId,
          todoId: e.todoId === undefined ? str(d.todoId) : (e.todoId as string),
          decision: safeStr(d.decision) ?? null,
          reason: safeStr(d.reason),
          refused: d.refused === true,
          refusedBecause: safeStr(d.refusedBecause),
          fallback: safeStr(d.fallback),
        });
        break;
      }
      case MERGE: {
        // A merge passed its three mechanical gates, so nothing asked Tom
        // about it. It is reported here for objection, and its wording never
        // assigns the merge to the delegate.
        //
        // A merge row filed after the fact carries `backfilled: true` (the
        // 30 landings of 2026-09-28 to 2026-10-05 a one-time backfill filed,
        // tom.quest #342, since removed). It is dated when it landed, so a
        // landing days old is outside a one-day window already; one older
        // than a day is left out of a longer window too (a morning after
        // missed ones), because its revert is no longer the night's question.
        if (d.backfilled === true && e.at < now - DAY_MS) break;
        const repo = str(d.repo) ?? "repo";
        const sha = (str(d.sha) ?? "").slice(0, 7);
        rawObjections.push({
          at: e.at,
          // The merge's own key: "revert <n>" reaches it (ttsAsk
          // internalRecordDelegateObjection resolves a merge row).
          askId: e.key ?? "",
          todoId: e.todoId === undefined ? str(d.todoId) : (e.todoId as string),
          decision: `merged ${repo}@${sha}: ${str(d.subject) ?? "no subject"}`,
          reason: safeStr(d.reason),
          refused: false,
          merged: true,
        });
        break;
      }
      case SENT_AS_TOM: {
        // A MESSAGE WENT OUT IN HIS NAME (convex/ttsSignoff.ts). He signed it
        // on /tts, so it is not his to object to; it is listed with the
        // decisions because it is one taken in his name, and the record of a
        // send reaching another person is what the guarantee "only Tom speaks
        // for Tom" asks him to be able to read. The askId is empty, as a
        // merge's is: a reply naming its number reaches no delegate decision.
        const recipient = str(d.recipient) ?? "someone";
        const channel = str(d.channel) ?? "";
        const where =
          channel === "calendar"
            ? "a calendar invitation"
            : channel.startsWith("slack:")
              ? `Slack ${channel.slice("slack:".length)}`
              : channel;
        const signedAt = typeof d.signedAt === "number" ? d.signedAt : undefined;
        rawObjections.push({
          at: e.at,
          askId: "",
          decision: `sent as you to ${recipient} on ${where}${signedAt === undefined ? "" : `, signed at ${displayTime(signedAt)}`}`,
          refused: false,
          merged: false,
          sentAsTom: true,
        });
        break;
      }
      case SIMPLIFY_PROPOSAL: {
        // THE WEEKLY PASS POSTS NOTHING TO #tts-today. This composer is a
        // different program reading rows, and it already lists merges the same
        // way. Without this case the window's own name — "the next digest
        // passes" — would refer to a message the proposal was never in, which
        // is a lie about how he saw it.
        //
        // A DRY RUN IS NOT A MORNING LINE. It is a proof that the path works,
        // taken against nothing he owns, so there is nothing to object to and
        // nothing for him to read.
        if (d.dryRun === true) break;
        const refused = d.needsHisWords === true;
        const sentence = str(d.sentence);
        rawObjections.push({
          at: e.at,
          // Unlike a merge, the askId is here: the proposal's row key is its
          // askId, so "revert <n>" on the digest's thread resolves the row.
          askId: e.key ?? "",
          todoId: e.todoId === undefined ? str(d.todoId) : (e.todoId as string),
          decision: sentence ?? null,
          reason: str(d.evidence),
          refused,
          refusedBecause: refused
            ? `needs-his-words — ${sentence ?? "it changes a line you reviewed"}`
            : undefined,
          merged: false,
        });
        break;
      }
      case REMOVAL_LOOP_PR: {
        // The removal loop's pull request, the same way a proposal is listed:
        // its window closes on "a digest sent after a day", so the digest must
        // carry it. Keyed `loop:<number>`, so "revert <n>" on the digest's
        // thread resolves the row. A rewrite is a new row and is listed again,
        // deliberately: the window restarted.
        if (d.dryRun === true) break;
        const rule = str(d.ruleId);
        const path = str(d.path);
        rawObjections.push({
          at: e.at,
          askId: e.key ?? "",
          todoId: undefined,
          decision: str(d.subject) ?? null,
          reason: rule !== undefined && path !== undefined ? `${rule} in ${path}` : undefined,
          refused: false,
          merged: false,
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
        // SHORT CLAUSES, deliberately: this statement and its detail are one
        // line to ttsCompose.statement(), which cuts at the last clause
        // boundary before LINE_CHARS — a longer sentence loses its second
        // clause and the session it names, silently.
        const clauses: string[] = [];
        if (stale.length > 0) clauses.push(`${stale.length} from an older commit`);
        if (missing.length > 0) clauses.push(`${missing.length} from none at all`);
        const first = stale[0] ?? missing[0];
        const firstId = str(first?.id);
        const row = failure(
          "prelude-delivery",
          `Sessions ran without the model-of-tom they should have had: ${clauses.join(", ")}.`,
          firstId === undefined ? undefined : ttsSessionLink(firstId),
        );
        row.detail = safeStr(first?.title);
        break;
      }
      default: {
        // Every job failure is a "-failed" kind (a box job reports its own
        // through POST /tts/job-failed). A Slack failure is the door's own and
        // is not a line.
        if (!isFailureKind(e.kind) || NOT_A_FAILURE_LINE.has(e.kind)) break;
        // THE WALL'S OWN PROBE IS NOT A FAILED SEND. The nightly wall eval
        // asks the sign-off door to send a calendar event to an address under
        // .invalid (RFC 2606: can never be delivered) and expects the refusal;
        // that refusal is the wall holding, so it is no broken line. It stays
        // while that probe runs (Jarvis worker/jobs/evals.mjs wall set, PR
        // #40): without it every night's passing wall test would be a
        // failed send in his digest.
        if (e.kind === SEND_AS_TOM_FAILED && typeof d.recipient === "string" && d.recipient.toLowerCase().endsWith(".invalid")) break;
        const job = str(d.job) ?? e.kind.replace(/-fail(?:ed|ure)$/, "");
        // The raw `error` is a job's own stderr — worker/jobs/nightly.mjs
        // reports git's verbatim, and git names its remote with the token in
        // it. It never reaches a line or the `broken:<n>` fact unredacted.
        failure(job, brokenStatement(job)).detail = safeStr(d.error);
      }
    }
  }

  // A box job's failures and recoveries, from the record (convex/jarvis/
  //    jobs.ts): one line per condition reported in the window, not per
  //    tick, saying whether it has since recovered; and one for a condition
  //    reported before the window that recovered inside it.
  //
  //    GROUPED BY CONDITION, the report's subject, not by job: two conditions
  //    of one job are two lines, and one recovering says nothing about the
  //    other. Every report names its job and its condition: onJobFailed
  //    files a report sent without a key under the job's name.
  const reports = await failuresInWindow(
    ctx,
    since,
    now,
    budget.allot("job failures and recoveries", READ_BYTES.jobReports),
  );
  const recoveredAt = new Map<string, number>();
  for (const row of reports.recovered) recoveredAt.set(row.subject as string, row.at);
  const failedKeys = new Set<string>();
  for (const row of reports.failed) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const job = row.provenance.job ?? "";
    const condition = row.subject as string;
    const fixedAt = recoveredAt.get(condition);
    failedKeys.add(condition);
    const statement = brokenStatement(job);
    const said = fixedAt !== undefined && fixedAt >= row.at ? `${statement} ${recoveredClause(job, fixedAt)}` : statement;
    // The reports come oldest first, so the newest report of the condition
    // writes the line last: one that failed again after it recovered reads
    // as failing, with the newest error.
    const f = failure(condition, said);
    f.statement = said;
    f.detail = safeStr(d.error) ?? safeStr(row.text);
  }
  for (const row of reports.recovered) {
    if (failedKeys.has(row.subject as string)) continue;
    const job = row.provenance.job ?? "";
    failure(
      `${row.subject}:recovered`,
      job === LANDING_JOB
        ? `A change that reached main past the merge gate passes it since ${displayTime(row.at)}: ${landingCommit(String(row.subject))}.`
        : `The ${job} job is running clean again, since ${displayTime(row.at)}.`,
    );
  }

  // The evals (Jarvis worker/jobs/evals.mjs): one eval-run event per set per
  //    run (convex/ttsEvals.ts EVAL_RUN, subject the set). A set whose newest
  //    run in the window failed items is one broken line; a clean run is the
  //    weekly's fact and /intent's pass rate, not a morning line.
  const evalRuns = await readWithin(
    budget.allot("eval runs", READ_BYTES.evalRuns),
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", EVAL_RUN).gte("at", since).lt("at", now))
      .order("desc"),
    OBJECTION_SCAN,
  );
  const setsRead = new Set<string>();
  for (const row of evalRuns) {
    // Every eval-run, decision and digest-line row names its subject: the
    // record refuses one without (shared/jarvis-events.mjs SUBJECT_REQUIRED).
    const set = row.subject as string;
    if (setsRead.has(set)) continue;
    setsRead.add(set);
    const d = (row.data ?? {}) as Record<string, unknown>;
    const failed = typeof d.failed === "number" ? d.failed : 0;
    if (failed === 0) continue;
    const total = typeof d.total === "number" ? d.total : failed;
    const f = failure(
      `evals:${set}`,
      `The ${row.subject} evals failed ${failed} of ${total} ${total === 1 ? "item" : "items"} in their newest run.`,
    );
    const first = (Array.isArray(d.items) ? d.items : []).find(
      (item): item is Record<string, unknown> => item !== null && typeof item === "object" && (item as Record<string, unknown>).pass === false,
    );
    if (first !== undefined) f.detail = `${safeStr(first.name) ?? "an item"} — ${safeStr(first.note) ?? ""}`;
  }

  // The lines producers put on this digest (convex/jarvis/outbox.ts
  //    listForDigest): a decision taken in his name joins the objection list,
  //    a failure the broken section — what #tts-decisions and #tts-broken
  //    carried as it happened, before there was one output channel.
  const lines = await readWithin(
    budget.allot("digest lines", READ_BYTES.digestLines),
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", DIGEST_LINE).gte("at", since).lt("at", now))
      .order("desc"),
    OBJECTION_SCAN,
  );
  const superseded: { id: string; text: string }[] = [];
  for (const row of lines) {
    const d = (row.data ?? {}) as Record<string, unknown>;
    // A standing ruling of his that new information ended (convex/jarvis/
    //    rulings.ts supersede): its own run, oldest first.
    if (d.section === "superseded") {
      const text = safeStr(d.statement);
      if (text !== undefined) superseded.unshift({ id: row._id as string, text });
      continue;
    }
    if (d.section === "broken") {
      const job = str(d.job) ?? "a job";
      failure(job, safeStr(d.statement) ?? brokenStatement(job), str(d.url)).detail = safeStr(d.detail);
      continue;
    }
    // listForDigest writes the askId as the row's subject.
    rawObjections.push({
      at: row.at,
      askId: row.subject as string,
      todoId: str(d.todoId),
      decision: safeStr(d.decision) ?? null,
      reason: safeStr(d.reason),
      refused: d.refused === true,
      refusedBecause: safeStr(d.refusedBecause),
    });
  }

  // His settlements on /intent (convex/jarvis/intent.ts settle, kind
  //    "disagreement-settled"): one line each, the text settle wrote, read on
  //    the kind's own index over the same window, oldest first.
  const settledRows = await readWithin(
    budget.allot("settlements", READ_BYTES.settlements),
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", DISAGREEMENT_SETTLED).gte("at", since).lt("at", now))
      .order("desc"),
    OBJECTION_SCAN,
  );
  const settled = settledRows
    .reverse()
    .flatMap((row) => {
      const text = safeStr(row.text);
      return text === undefined ? [] : [{ id: row._id as string, text }];
    });

  // 5. Ready for Tom (not already dated) — ruling 18's computation
  //    (ttsShared.isReadyForTom). Read on the readiness index for "prepared",
  //    so the scan is the prepared list itself. §4.3: the ready SECTION is
  //    gone; the count is the today section's last sentence.
  //    Newest first. When the row cap or the allotment stops the read the
  //    ready count is a floor; the allotment's stop has a cut line. A prepared todo
  //    whose needs were not all read is left out of the count, never counted
  //    as ready on a guess; the needs' cut line counts the needs left unread.
  const preparedRows = await readWithin(
    budget.allot("prepared todos", READ_BYTES.prepared),
    ctx.db
      .query("todos")
      .withIndex("by_readiness", (q) => q.eq("readiness", "prepared"))
      .order("desc"),
    READY_SCAN,
  );
  const needsBudget = budget.allot("needs of prepared todos", READ_BYTES.needs);
  const readyIds = new Set<string>();
  for (const t of preparedRows) {
    if (t.status !== "active" || datedIds.has(t._id as string)) continue;
    const needRows: Doc<"todos">[] = [];
    let unread = 0;
    for (const id of t.needs ?? []) {
      const need = await getWithin(needsBudget, () => ctx.db.get(id));
      if (need === undefined) unread += 1;
      else if (need !== null) needRows.push(need);
    }
    if (unread > 0) continue;
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
  // An objection names its todo as its row stored it; the facts hand the
  // plain id, which the ready and dated sets above are keyed on, and none
  // for an id naming no row.
  for (const o of rawObjections) {
    if (o.todoId !== undefined) o.todoId = (await todoOf(o.todoId))?._id ?? undefined;
  }
  const objections = rawObjections
    // The newest OBJECTION_SCAN of every source together: the reads above
    // come in different orders, so they are put in time order before the cut.
    .sort((a, b) => a.at - b.at)
    .slice(-OBJECTION_SCAN)
    .sort(
      (a, b) =>
        objectionRank(a, readyIds, datedIds) - objectionRank(b, readyIds, datedIds) ||
        b.at - a.at,
    )
    .map((o) => ({
      askId: o.askId,
      todoId: o.todoId,
      decision: o.decision ?? "no answer came back, so the agent took its own fallback",
      reason: o.reason,
      refused: o.refused,
      refusedBecause:
        o.refusedBecause === undefined ? undefined : stripNarrowListId(o.refusedBecause),
      fallback: o.fallback,
      merged: o.merged === true,
      ...(o.sentAsTom === true ? { sentAsTom: true } : {}),
      ...(o.decidedByTom === true ? { decidedByTom: true } : {}),
      ...(o.decidedByText === undefined ? {} : { decidedByText: o.decidedByText }),
    }));

  // 7. What changed on the box (plan-root T1): the box changes since the
  //    last digest, from the record's events table (convex/boxChanges.ts
  //    boxChangesInWindow), and the deploy job's own rows, each read on its
  //    own kind's index so a busy night of other events cannot crowd them out.
  const deployRows = await readWithin(
    budget.allot("deploys", READ_BYTES.deploys),
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DEPLOY).gte("at", since).lt("at", now)),
    BOX_SCAN,
  );
  const boxWindow = await boxChangesInWindow(
    ctx,
    since,
    now,
    budget.allot("box changes", READ_BYTES.boxChanges),
  );
  const boxChanges = boxChangeLines(
    boxWindow,
    deployRows.map((row) => {
      const d = (row.data ?? {}) as Record<string, unknown>;
      return { at: row.at, repo: str(d.repo), to: str(d.to), commits: d.commits };
    }),
  );

  // 8. What the window's agents cost: every agent that STARTED in the window,
  //    read on the time index. The price sits inside `outcome`, where no index
  //    reaches, so the rows are read and summed here, newest first and bounded:
  //    past the bound it is the oldest that go, and the text says the figures
  //    are floors.
  const started = await readWithin(
    budget.allot("agent runs", READ_BYTES.runs),
    ctx.db
      .query("runs")
      .withIndex("by_started", (q) => q.gte("startedAt", since).lt("startedAt", now))
      .order("desc"),
    SPEND_SCAN,
  );

  // The tail row, if any, last: it is the one line that names no todo.
  const overnightByTodo = [...byTodo.values()].sort(
    (a, b) => Number(a.todoId === null) - Number(b.todoId === null),
  );
  return {
    day,
    today: dated,
    lateCount,
    oldestLateBy,
    // Ready items not printed: a flagged one is printed in the needs-you run.
    readyBeyond: [...readyIds].filter((id) => !needsYou.some((n) => n.todoId === id)).length,
    calendar,
    calendarLead: spans.length === 0 ? undefined : calendarLeadText(spans),
    objections: objections.slice(0, OBJECTION_CAP),
    objectionsBeyond: Math.max(0, objections.length - OBJECTION_CAP),
    // Counted over the WHOLE list, printed and beyond, because the lead's
    // count is the whole list's.
    objectionMerges: objections.filter((o) => o.merged).length,
    objectionSent: objections.filter((o) => o.sentAsTom === true).length,
    objectionTom: objections.filter((o) => o.decidedByTom === true).length,
    // A flagged capture that preparation has since dated keeps its lateness
    // here, and is said once, in the needs-you run (composeToday). Dated ones
    // lead the run in the today list's own oldest-first order, so the item the
    // first line names as the one to start with is the last line any fit could
    // drop; the rest follow in capture order.
    needsYou: needsYou
      .map((n, order) => {
        const at = dated.findIndex((item) => item.id === n.todoId);
        return { n: at < 0 ? n : { ...n, countdown: dated[at].countdown }, rank: at < 0 ? dated.length + order : at };
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ n }) => n),
    overnightByTodo,
    broken: [...failures.values()],
    settled,
    superseded,
    boxChanges,
    spend: spendOf(started, started.length >= SPEND_SCAN),
    readCuts: [
      ...earlierCuts,
      ...budget.cuts(),
    ],
  };
}

/** A day normally has hundreds of agent runs; the cap bounds the spend read and makes its totals floors. */
const SPEND_SCAN = 1000;

type RunFields = Pick<Doc<"runs">, "model" | "cli" | "kind" | "parentRunId" | "outcome">;

/**
 * The model family an agent's spending belongs to. The model's name decides:
 * "claude…" is Claude, "gpt…" and "codex…" are Codex (OpenAI's models), and any
 * other name is open weight (a model reached through OpenRouter or a rented
 * GPU). The name decides before the command line does because the Codex
 * command line also runs OpenRouter models, and the box hands it their name
 * with the "openrouter/" prefix taken off. A row with no model name is placed
 * by its command line, which is the only fact it has left.
 */
export function agentModelFamily(run: Pick<RunFields, "model" | "cli">): keyof SpendFact["byFamily"] {
  const model = run.model ?? "";
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gpt") || model.startsWith("codex")) return "codex";
  if (model !== "") return "openWeight";
  return run.cli;
}

/**
 * Who watched an agent, from its row: a session when a person was in the
 * conversation (kind "session"); a child when the record names the agent that
 * started it (parentRunId), which reads its report; otherwise nobody on
 * record. The record keeps a row with no parent as its own root at depth 0, so
 * parentRunId alone says whether there is a parent. A Codex agent that a
 * Claude agent starts through the box's `jarvis codex` command records no
 * parent (kind "job", depth 0), so it lands with the agents nobody watched,
 * which is why the text calls that group "no watcher on record".
 */
export function agentWatcher(run: Pick<RunFields, "kind" | "parentRunId">): keyof SpendFact["byWatcher"] {
  if (run.kind === "session") return "session";
  if (run.parentRunId !== undefined) return "child";
  return "nobody";
}

/** The spend section's facts, or none when no agent started in the window. */
function spendOf(runs: RunFields[], capped: boolean): SpendFact | undefined {
  if (runs.length === 0) return undefined;
  const spend: SpendFact = {
    agents: runs.length,
    costUsd: 0,
    unpriced: 0,
    byFamily: { claude: 0, codex: 0, openWeight: 0 },
    byWatcher: { session: 0, child: 0, nobody: 0 },
    capped,
    url: AGENTS_WINDOW_URL,
  };
  for (const run of runs) {
    const cost = run.outcome?.costUsd;
    if (cost === undefined) {
      spend.unpriced += 1;
      continue;
    }
    spend.costUsd += cost;
    spend.byFamily[agentModelFamily(run)] += cost;
    spend.byWatcher[agentWatcher(run)] += cost;
  }
  return spend;
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
    // Not a job's failure: a commit on main that did not pass the merge gate
    // (convex/gateLandings.ts). The detail names the repository, the commit
    // and the missing checks.
    [LANDING_JOB]: "A change reached main without passing the merge gate.",
  };
  return known[job] ?? `The ${job} job failed overnight.`;
}

/** `repo@abc1234` out of a landing report's subject (convex/ttsMerge.ts
 *  landingKey). */
function landingCommit(subject: string): string {
  const [repo, sha] = subject.slice(LANDING_JOB.length + 1).split("@");
  return `${repo}@${(sha ?? "").slice(0, 7)}`;
}

/** The clause a broken line ends with when its condition cleared inside the
 *  window. A landing past the gate clears when the gate opens for it, which is
 *  no job running clean. */
function recoveredClause(job: string, at: number): string {
  return job === LANDING_JOB
    ? `The merge gate has passed it since ${displayTime(at)}.`
    : `It has run clean again since ${displayTime(at)}.`;
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

/** The number an objection line was PRINTED with, or null for a line that is
 *  not one: `objectionLine` writes "3. …", while the two count lines the caller
 *  can also print ("12 more lines are on the page.", "3 more decisions are on
 *  the page.") open with a number and no full stop after it. */
function printedObjectionNumber(text: string): number | null {
  const match = /^(\d+)\.\s/.exec(text.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * The askIds behind the objection lines THAT SURVIVED THE FIT, positionally:
 * index n − 1 holds the askId of the line Tom read as "n." (convex/ttsSlack.ts
 * namedObjection indexes it that way). A number that was composed but then cut
 * — `fit` reduces a whole run to its lead and one count line — holds "", which
 * that route already treats as "named no printed line" and falls through on.
 * The list therefore says what he could SEE, which is the only thing a reply
 * of "revert 2" can honestly be resolved against.
 */
/** The today and needs-you-today items the fitted message printed, by their
 *  links, each id once. */
function printedTodoIds(
  message: { lines: { role: string; section?: string; url?: string }[] },
  facts: TodayFacts,
): string[] {
  const printed = new Set(
    message.lines
      .filter((line) => line.role === "item" && (line.section === "today" || line.section === "needs-you-today"))
      .map((line) => line.url),
  );
  const ids = [...facts.today.map((item) => item.id), ...facts.needsYou.map((n) => n.todoId)];
  return [...new Set(ids.filter((id) => printed.has(itemUrl(id))))];
}

function printedObjectionAskIds(
  message: { lines: { role: string; section?: string; text: string }[] },
  facts: TodayFacts,
): string[] {
  const printed: string[] = [];
  for (const line of message.lines) {
    if (line.role !== "item" || line.section !== "objections") continue;
    const n = printedObjectionNumber(line.text);
    if (n === null || n < 1) continue;
    while (printed.length < n) printed.push("");
    printed[n - 1] = facts.objections[n - 1]?.askId ?? "";
  }
  return printed;
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
    // Reads the same transaction stopped before this one (the rollover's).
    earlierCuts: v.optional(v.array(v.object({
      what: v.string(),
      read: v.number(),
      skipped: v.number(),
      by: v.union(v.literal("bytes"), v.literal("rows")),
    }))),
  },
  handler: (ctx, args) => composeToday(ctx, args),
});

/** The day's digest text, the ids it printed and its facts, read in the
 *  caller's transaction: internalComposeToday's, or appendThreadDigest's,
 *  which passes THREAD_GATHER_BYTES so its reads stay at DIGEST_READ_BOUND. */
export async function composeToday(
  ctx: QueryCtx,
  { day, now, since: givenSince, canReply, earlierCuts, gatherBytes }: {
    day: string; now: number; since?: number; canReply?: boolean; earlierCuts?: ReadCut[]; gatherBytes?: number;
  },
) {
  const since = givenSince ?? (await digestWindowStart(ctx, now));
  const facts = await gatherTodayFacts(ctx, { day, now, since, earlierCuts, bytes: gatherBytes });
  const reply = canReply ?? false;
  const { message, truncated } = composeTodayFitted(facts, { canReply: reply });
  return {
    text: renderSlack(message),
    // Whether runs were reduced to one sentence to fit one Slack message;
    // the sender records it on the "digest-sent" row.
    truncated,
    since,
    // Every todo the message showed, for the "surfaced" instrumentation:
    // the today run and, read off the FITTED message as the objection
    // numbers are, the needs-you-today items actually printed; each id once.
    // Both read off the fitted message, so an item whose line was dropped
    // never counts as seen.
    surfacedTodoIds: printedTodoIds(message, facts)
      .map((id) => ctx.db.normalizeId("todos", id))
      .filter((id): id is Id<"todos"> => id !== null),
    // The decisions the objection list carried, in PRINTED order: a reply of
    // "revert 2" names the second of these. Read off the FITTED message, not
    // off `facts.objections`: `fit` can reduce the objections run to its lead
    // plus one "N more lines are on the page" line, and a number resolved
    // against a list Tom never saw reverts something he never read.
    objectionAskIds: printedObjectionAskIds(message, facts),
    // The facts the text was rendered from, each with an id, its link and
    // its numbers: the box keeps them on the digest-sent row.
    facts: todayFactsBlock(facts, reply),
  };
}
