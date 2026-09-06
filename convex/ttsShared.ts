// TTS time helpers — the 5 a.m. America/New_York day boundary (spec §7).
// Implemented without Intl so behavior is identical in the Convex runtime,
// Node (the Jarvis Box), and the browser. US DST rules: clocks spring forward at
// 2:00 EST (07:00 UTC) on the second Sunday of March and fall back at 2:00 EDT
// (06:00 UTC) on the first Sunday of November.
//
// THE THREE DAY QUESTIONS (they have different answers before 5 a.m. — mixing
// them up was this module's original sin, caught in review):
//   ttsDayKey(now)      "which TTS day is it right now?"   2 a.m. → yesterday.
//   ttsPrepDay(now)     "which day is a prep run building?" the day of the NEXT
//                       digest — at 4:30 a.m. that's the day STARTING at 5.
//   nyCalendarDayKey(t) "what calendar date is this instant, on a NY clock?"
//                       used for due-date arithmetic, where '2 a.m. belongs to
//                       yesterday' would be wrong.

import { v, type Infer } from "convex/values";

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** How far ahead of a condition-bound todo's latest-safe date it surfaces:
 * the fallback queue's window, and the sleep the lifeos migration writes
 * (wakeAt = latestSafeAt minus this) when it turns such a row into a task
 * with the condition in its statement. ONE HOME — it was an inline literal. */
export const CONDITION_WINDOW_MS = 14 * DAY_MS;

// The scheduling anchors (single source of truth for the guard hours; the UTC
// cron times in convex/crons.ts and worker/setup.sh are derived as hour+4
// (EDT) and hour+5 (EST) and say so in their comments).
export const TTS_PREP_NY_HOUR = 4; // prep jobs run in the 4 a.m. hour
export const TTS_DIGEST_NY_HOUR = 5; // the digest sends at 5 — the day boundary

function nthSundayUtcMs(year: number, monthIndex: number, n: number): number {
  const first = Date.UTC(year, monthIndex, 1);
  const firstDow = new Date(first).getUTCDay(); // 0 = Sunday
  const firstSundayDate = 1 + ((7 - firstDow) % 7);
  return Date.UTC(year, monthIndex, firstSundayDate + (n - 1) * 7);
}

/** UTC offset of America/New_York in hours (-4 in EDT, -5 in EST). */
export function nyOffsetHours(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const springMs = nthSundayUtcMs(year, 2, 2) + 7 * HOUR_MS; // 2:00 EST
  const fallMs = nthSundayUtcMs(year, 10, 1) + 6 * HOUR_MS; // 2:00 EDT
  return utcMs >= springMs && utcMs < fallMs ? -4 : -5;
}

/** Local wall-clock hour (0-23) in America/New_York. */
export function nyLocalHour(utcMs: number): number {
  return new Date(utcMs + nyOffsetHours(utcMs) * HOUR_MS).getUTCHours();
}

/** The NY calendar date (YYYY-MM-DD) of an instant — plain wall-clock date. */
export function nyCalendarDayKey(utcMs: number): string {
  return new Date(utcMs + nyOffsetHours(utcMs) * HOUR_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The TTS day key (YYYY-MM-DD) for an instant: the NY calendar date, with the
 * day rolling over at 5 a.m. local rather than midnight — so 2 a.m. Tuesday
 * still belongs to Monday's day. Used by getToday and the digest send.
 */
export function ttsDayKey(utcMs: number): string {
  const shifted = utcMs + (nyOffsetHours(utcMs) - TTS_DIGEST_NY_HOUR) * HOUR_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * The day a PREP run is building: the day of the next 5 a.m. digest. During
 * the pre-dawn prep window (midnight–5 a.m.) this is the day about to start —
 * NOT ttsDayKey(now), which still says yesterday. From 5 a.m. onward it equals
 * ttsDayKey(now) (a midday --force re-prep rebuilds today's queue).
 * Implemented as "the TTS day five hours from now".
 */
export function ttsPrepDay(utcMs: number): string {
  return ttsDayKey(utcMs + TTS_DIGEST_NY_HOUR * HOUR_MS);
}

/**
 * The UTC instant of `hourNy` o'clock New York on the calendar date whose UTC
 * midnight is `utcMidnight`. The offset must be sampled AT the instant we are
 * solving for, not at some fixed hour of the date: on a transition day midnight
 * and midday sit on opposite sides of the 2 a.m. switch. So: guess with the
 * offset at the naive instant, then re-sample at the candidate — one correction
 * is enough, because the two candidates are an hour apart and the switch is one
 * hour wide.
 */
function nyHourUtcMs(utcMidnight: number, hourNy: number): number {
  const naive = utcMidnight + hourNy * HOUR_MS;
  const guess = naive - nyOffsetHours(naive) * HOUR_MS;
  return naive - nyOffsetHours(guess) * HOUR_MS;
}

/**
 * UTC bounds [start, end) of the NY day named by a YYYY-MM-DD key, running from
 * `hourNy` local on that date to `hourNy` local the next. DST-correct at both
 * edges: a spring-forward day is 23 hours long, a fall-back day 25.
 */
function nyDayBoundsUtc(
  day: string,
  hourNy: number,
): { start: number; end: number } {
  const utcMidnight = Date.parse(day);
  return {
    start: nyHourUtcMs(utcMidnight, hourNy),
    end: nyHourUtcMs(utcMidnight + DAY_MS, hourNy),
  };
}

/**
 * UTC bounds [start, end) of a TTS day: 5 a.m. NY on the key's date to 5 a.m.
 * NY the next day.
 */
export function ttsDayBoundsUtc(day: string): { start: number; end: number } {
  return nyDayBoundsUtc(day, TTS_DIGEST_NY_HOUR);
}

/**
 * The UTC instant of a NY wall-clock time on a YYYY-MM-DD calendar date —
 * minute precision. Same one-correction DST logic as nyHourUtcMs. The
 * repeating-todo generator uses this to place an instance's dueAt at the
 * rule's timeOfDay ("18:30") on the day it is generating.
 */
export function nyTimeUtcMs(day: string, hour: number, minute = 0): number {
  const naive = Date.parse(day) + hour * HOUR_MS + minute * 60_000;
  const guess = naive - nyOffsetHours(naive) * HOUR_MS;
  return naive - nyOffsetHours(guess) * HOUR_MS;
}

/** Plain lowercase weekday word ("monday"…"sunday") of a YYYY-MM-DD date. */
export const WEEKDAY_WORDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type WeekdayWord = (typeof WEEKDAY_WORDS)[number];
export function weekdayWordOf(day: string): WeekdayWord {
  // Date.parse("YYYY-MM-DD") is UTC midnight of that calendar date; its UTC
  // weekday IS the calendar date's weekday — no timezone shift involved.
  return WEEKDAY_WORDS[new Date(Date.parse(day)).getUTCDay()];
}

/**
 * UTC bounds [start, end) of a CALENDAR day in New York: local midnight to the
 * next local midnight. This is the window a /tts calendar COLUMN covers — the
 * day-scoped time note carries that column's YYYY-MM-DD label (schema:
 * dtsTimeNotes.day) and the server resolves it here, so browser-local ms and
 * `day + DAY_MS` arithmetic never enter the picture.
 */
export function nyCalendarDayBoundsUtc(day: string): {
  start: number;
  end: number;
} {
  return nyDayBoundsUtc(day, 0);
}

/**
 * Human countdown text for a due date, e.g. "in 3 days", "today", "2 days
 * overdue". Compares NY CALENDAR dates (not TTS days): an item due at 2 a.m.
 * is due on that calendar date, and the 5 a.m. shift would report it a day
 * early. Convention (schema comment + worker prompt): writers store dueAt as
 * noon New York; an exact-UTC-midnight timestamp still reads as the prior NY
 * evening and will be off by one — normalize at the writer.
 */
export function countdownText(dueAt: number, now: number): string {
  const dayDiff =
    (Date.parse(nyCalendarDayKey(dueAt)) - Date.parse(nyCalendarDayKey(now))) /
    DAY_MS;
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff > 1) return `in ${dayDiff} days`;
  if (dayDiff === -1) return "1 day overdue";
  return `${-dayDiff} days overdue`;
}

/**
 * New York wall-clock "HH:MM" of an instant. The Slack messages (the digest,
 * the hourly update) print block and calendar spans with it; one home so the
 * plain-runtime composer and the "use node" sender agree on the clock.
 */
export function nyHhmm(at: number): string {
  const d = new Date(at + nyOffsetHours(at) * HOUR_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

// ── Readiness: two values (ruling 18, the lifeos update, 2026-09-05) ────────
// THE ONE HOME for what the readiness field means. Tom, 2026-08-27: "theres no
// functional difference between ready to ratify and needs session" — so the
// field keeps exactly two values:
//   unprepared — a raw capture; no one has written it up yet. Never ready.
//   prepared   — written up (brief, entry action, work description). Whether
//                it is READY for Tom is then COMPUTED, never stored: see
//                isReadyForTom below.
// The two retired spellings, "preparing" and "ready-for-tom", stay READABLE
// during the widen (every reader goes through normalizeReadiness / isPrepared,
// so a row written before the migration reads the same as one written after)
// and are mapped one to one by ttsMigrations.internalMigrateReadiness:
// "preparing" → unprepared (the write-up was not finished), "ready-for-tom" →
// prepared. They leave the validator at NARROW, once no row carries them.
export const READINESS_VALUES = ["unprepared", "prepared"] as const;
export type Readiness = (typeof READINESS_VALUES)[number];
export const RETIRED_READINESS_VALUES = ["preparing", "ready-for-tom"] as const;
export type StoredReadiness =
  | Readiness
  | (typeof RETIRED_READINESS_VALUES)[number];
/** The stored form during the widen: the two values plus the two retired
 * spellings. convex/schema.ts and every pen that stores readiness use this. */
export const STORED_READINESS = v.union(
  ...[...READINESS_VALUES, ...RETIRED_READINESS_VALUES].map((r) =>
    v.literal(r),
  ),
);
/** The two-value form: what a Tom door may write, and what the page offers. */
export const READINESS = v.union(...READINESS_VALUES.map((r) => v.literal(r)));
/** One reading for every spelling. "ready-for-tom" meant "the write-up is
 * finished and only Tom is missing", so it reads as prepared. "preparing"
 * meant "an agent still has groundwork to do here" — a half-prepared row —
 * and a raw or half-prepared capture is never ready, so it reads as
 * unprepared: the preparer job picks it up again and returns it as
 * prepared. Each stored spelling has exactly one reading. */
export function normalizeReadiness(readiness: StoredReadiness): Readiness {
  return readiness === "unprepared" || readiness === "preparing"
    ? "unprepared"
    : "prepared";
}
export function isPrepared(readiness: StoredReadiness): boolean {
  return normalizeReadiness(readiness) === "prepared";
}

// ── Code-brief recommendation: the four verdict words (the lifeos update) ───
// A code brief's `recommendation` is the worker's read of what Tom will most
// likely rule, so it is spelled in the words he rules in — the four verdicts
// (convex/ttsRulings.ts VERDICT). The three retired spellings map one to one:
//   stale-replan    → revise
//   needs-session   → session
//   propose-archive → archive
// They stay READABLE during the widen (normalizeRecommendation is the one
// reading) and are rewritten by ttsMigrations.internalMigrateRecommendations;
// they leave the validator at NARROW.
export const RECOMMENDATION_VALUES = ["approve", "revise", "session", "archive"] as const;
export type Recommendation = (typeof RECOMMENDATION_VALUES)[number];
export const RETIRED_RECOMMENDATION_MAP = {
  "stale-replan": "revise",
  "needs-session": "session",
  "propose-archive": "archive",
} as const satisfies Record<string, Recommendation>;
export type StoredRecommendation =
  | Recommendation
  | keyof typeof RETIRED_RECOMMENDATION_MAP;
export const STORED_RECOMMENDATION_VALUES = [
  ...RECOMMENDATION_VALUES,
  ...(Object.keys(RETIRED_RECOMMENDATION_MAP) as (keyof typeof RETIRED_RECOMMENDATION_MAP)[]),
] as const;
/** The stored form during the widen: the four words plus the three retired
 * spellings. convex/schema.ts and the brief pen use this. */
export const STORED_RECOMMENDATION = v.union(
  ...STORED_RECOMMENDATION_VALUES.map((r) => v.literal(r)),
);
export function normalizeRecommendation(r: StoredRecommendation): Recommendation {
  return r in RETIRED_RECOMMENDATION_MAP
    ? RETIRED_RECOMMENDATION_MAP[r as keyof typeof RETIRED_RECOMMENDATION_MAP]
    : (r as Recommendation);
}
export function isStoredRecommendation(x: unknown): x is StoredRecommendation {
  return (
    typeof x === "string" &&
    (STORED_RECOMMENDATION_VALUES as readonly string[]).includes(x)
  );
}

// ── The todo graph: needs, done, ready (schema v2, ratified 2026-08-29) ──────
// THE ONE HOME for the graph rules — convex/ and app/ both import from here,
// so the server's frontier and the page's frontier cannot drift. Structural
// types (not Doc<"dtsTodos">) so this module stays importable from both sides
// without dragging in the generated data model; Id<"dtsTodos"> is a string at
// runtime and assignable to these.

/** The bounded fan-in of one todo's `needs` (Convex unbounded-array rule). */
export const MAX_NEEDS = 10;

/** The slice of a todo the graph rules read. `wakeAt` on an ACTIVE row is a
 * sleep (the lifeos update: a stored "waiting" status becomes active with its
 * wakeAt); until that instant the row is not ready for anyone. */
export type GraphTodo = {
  _id: string;
  status: "active" | "waiting" | "archived" | "done";
  needs?: readonly string[];
  wakeAt?: number;
};

/**
 * The ids that count as DONE for readiness. "archived" counts alongside "done":
 * a need that was set aside is not going to happen, and leaving it blocking
 * would strand the whole rest of the graph forever. Same rule memberProgress
 * (app/tts/lib.ts) already reads a batch member's completion by.
 */
export function buildDoneSet(todos: readonly GraphTodo[]): Set<string> {
  const done = new Set<string>();
  for (const t of todos) {
    if (t.status === "done" || t.status === "archived") done.add(t._id);
  }
  return done;
}

/** Whether a row's sleep, if it has one, is over at `now`. */
export function wakeAtPassed(todo: { wakeAt?: number }, now: number): boolean {
  return todo.wakeAt === undefined || todo.wakeAt <= now;
}

/**
 * READY — Tom's word for the frontier: this todo is active, awake, and every
 * id in its `needs` is done. The stored status `waiting` is excluded on
 * purpose (a sleeping todo is not ready no matter what its needs say), and so
 * is an active row whose wakeAt is still ahead — the same sleep, spelled the
 * way it is after the lifeos migration. Done/archived rows are never ready.
 * No needs at all = ready the moment it is active and awake.
 *
 * This is the frontier a WORKER may pick from, and it does not read the
 * readiness field: an agent task is worked from raw. What is ready FOR TOM is
 * the stricter isReadyForTom below.
 */
export function isReady(
  todo: GraphTodo,
  doneSet: ReadonlySet<string>,
  now: number,
): boolean {
  return (
    todo.status === "active" &&
    wakeAtPassed(todo, now) &&
    (todo.needs ?? []).every((id) => doneSet.has(id))
  );
}

/** The ready list, in the order given. */
export function frontier<T extends GraphTodo>(
  todos: readonly T[],
  now: number,
): T[] {
  const doneSet = buildDoneSet(todos);
  return todos.filter((t) => isReady(t, doneSet, now));
}

/** The slice of a todo the ready-for-Tom rule reads. */
export type ReadyTodo = GraphTodo & { readiness: StoredReadiness };

/**
 * READY FOR TOM (ruling 18): prepared, active, wakeAt absent or passed, every
 * need done. The one computation behind the page's ready filter, the needs-me
 * list, the digest's "ready for him" section, and the session-kind choice. A
 * raw capture (unprepared) is never ready, whatever else is true of it.
 */
export function isReadyForTom(
  todo: ReadyTodo,
  doneSet: ReadonlySet<string>,
  now: number,
): boolean {
  return isPrepared(todo.readiness) && isReady(todo, doneSet, now);
}

// ── Waiting, computed with its reason (the lifeos update, phase 7) ──────────
// "Waiting" is no longer a stored status: it is what an active todo that is
// not ready is doing, and the reason is computed here — ONE function, so the
// page's waiting line, the batch card's blocked rows, and the digest cannot
// name different reasons for the same row. The stored status "waiting" is
// still readable during the widen and reads as a sleep (its wakeAt, or its
// wake condition in words when it has no time).
//
// The reasons, in the order they are checked — hard blocks first, then what
// an agent clears on its own, then Tom:
//   wake        — asleep: a stored "waiting" row, or an active row whose
//                 wakeAt is still ahead.
//   need        — an unmet need, named (the first in the todo's `needs` that
//                 is not done).
//   credential  — the todo comes from a source whose credential Tom has
//                 declined (a declined integration is an archived todo with
//                 his ruling on it; the caller passes that set), so nothing
//                 can move it until the credential exists.
//   unprepared  — a raw capture; the preparer job clears this on its own.
//   tom         — prepared, and the actor is Tom: it waits on him. Also the
//                 answer for a prepared todo with no actor field (a legacy
//                 standalone todo, which Tom executes).
//   null        — an agent task that is ready: waiting on nothing but a
//                 worker's tick.
export type WaitingReason =
  | { kind: "wake"; at?: number; condition?: string }
  | { kind: "need"; id: string; statement?: string }
  | { kind: "credential"; source: string }
  | { kind: "unprepared" }
  | { kind: "tom" };

/** The slice of a todo the waiting rule reads. */
export type WaitingTodo = ReadyTodo & {
  wakeCondition?: string;
  actor?: "tom" | "agent";
  source?: string;
};

export type WaitingContext = {
  now: number;
  doneSet: ReadonlySet<string>;
  /** The display text of a need, by id — so the reason names it. */
  statementOf?: (id: string) => string | undefined;
  /** Source names whose credential Tom declined (empty until phase 6 feeds
   * it from the archived integration todos). */
  declinedSources?: ReadonlySet<string>;
};

export function waitingReason(
  todo: WaitingTodo,
  ctx: WaitingContext,
): WaitingReason | null {
  if (todo.status !== "active" && todo.status !== "waiting") return null;
  if (todo.status === "waiting" || !wakeAtPassed(todo, ctx.now)) {
    return { kind: "wake", at: todo.wakeAt, condition: todo.wakeCondition };
  }
  const unmet = (todo.needs ?? []).find((id) => !ctx.doneSet.has(id));
  if (unmet !== undefined) {
    return { kind: "need", id: unmet, statement: ctx.statementOf?.(unmet) };
  }
  if (todo.source !== undefined && ctx.declinedSources?.has(todo.source)) {
    return { kind: "credential", source: todo.source };
  }
  if (!isPrepared(todo.readiness)) return { kind: "unprepared" };
  if (todo.actor !== "agent") return { kind: "tom" };
  return null;
}

/** The one spelling of a reason on a page or in a message. `date` renders an
 * instant the way the surface does (the page's fmtDate, the digest's day). */
export function waitingReasonText(
  reason: WaitingReason,
  date: (at: number) => string,
): string {
  switch (reason.kind) {
    case "wake":
      if (reason.at !== undefined) {
        return `waiting until ${date(reason.at)}${reason.condition ? ` — ${reason.condition}` : ""}`;
      }
      return reason.condition ? `waiting until: ${reason.condition}` : "waiting";
    case "need":
      return `waiting on: ${reason.statement ?? reason.id}`;
    case "credential":
      return `waiting on a credential: ${reason.source} declined`;
    case "unprepared":
      return "waiting: unprepared";
    case "tom":
      return "waiting on you";
  }
}

/** The slice of a todo the goal-condition rule reads. */
export type GoalTodo = {
  kind?: "task" | "goal";
  condition?: string;
  timingClass?: "dated" | "condition-bound" | "whenever";
  codeRepo?: string;
  codeExternalId?: string;
};

/**
 * CHECKABLE — a goal an agent may go and verify, and therefore a goal a worker
 * session may record done. ONE HOME, because two callers must never disagree
 * about it: the scheduler decides what to hand a worker (claudeSessions), and
 * the pen decides what a worker's `status: "done"` may close (tts).
 *
 * The bar is a GOAL CONDITION — a sentence about the world that is either true
 * yet or not ("the lease is signed"), or a code subject whose upstream status
 * answers the same question. `condition` is a TWO-READING field (schema.ts):
 * on a `timingClass: "condition-bound"` row it is the TRIGGER that says when
 * the todo may start ("when the landlord sends the paperwork"), which is not a
 * completion test at all. Reading a trigger as a completion test is how an
 * agent closes one of Tom's own todos the moment the trigger fires — so a
 * condition-bound row is checkable ONLY through a code subject.
 */
export function goalCheckable(todo: GoalTodo): boolean {
  if (todo.kind !== "goal") return false;
  if (todo.codeRepo !== undefined && todo.codeExternalId !== undefined) {
    return true;
  }
  if (todo.timingClass === "condition-bound") return false;
  return (todo.condition ?? "").trim() !== "";
}

// ── The model-of-tom files every prompt begins with (the lifeos update, phase 4)
// The nightly job on the Jarvis Box posts these WikiTom files, with the commit
// they were read at, to POST /tts/model-of-tom; convex/ttsSkills.ts stores
// them and modelOfTomPrelude is the one read that prepends them, in THIS
// order, to every prompt that writes to Tom or plans for him. The three named
// files come first; then, for each page under areas/, the "Current state" and
// "Must not break" sections (the job extracts them by heading; the server
// only orders). The job cannot import this file (Node ESM on the box), so it
// posts in the order it reads and the server's order is the authority.
//
// writing.md is the one file no prompt may go without: it IS the writing
// standard every sentence TTS shows Tom obeys. A post that lacks it is
// refused whole (convex/ttsSkills.ts), because replacing the table with the
// rest would leave every prompt from then on written to no standard at all.
export const MODEL_OF_TOM_WRITING = "model-of-tom/writing.md";
/** The file the capture triage rules are a section of (CAPTURE_TRIAGE_HEADING
 * below); named here because two consumers reach for it, not just the order. */
export const MODEL_OF_TOM_PRIORITIES = "model-of-tom/priorities.md";
export const MODEL_OF_TOM_FIRST = [
  MODEL_OF_TOM_WRITING,
  MODEL_OF_TOM_PRIORITIES,
  "model-of-tom/schedule.md",
] as const;
// Spelled WITHOUT a trailing slash, the same way worker/jobs/nightly.mjs
// spells it — the job cannot import this file, so the two strings are only
// kept identical by being written identically.
export const MODEL_OF_TOM_AREAS_DIR = "model-of-tom/areas";

// ── The writing standard — THE FALLBACK COPY (Tom's ruling, 2026-08-29) ─────
// EVERY piece of natural language TTS shows Tom — a batch statement, a task
// statement, a ground-up explanation, a digest line, a decision list — is
// written to this standard.
//
// THE LIVE SOURCE IS NO LONGER THIS STRING. It is WikiTom
// model-of-tom/writing.md (the skill model-of-tom/skills/writing-to-tom was
// merged into it), which reaches Convex through the nightly job's post
// (convex/ttsSkills.ts) and reaches every prompt through modelOfTomPrelude:
// the session openers in convex/claudeSessions.ts, and GET /tts/batch-context
// for the Node ESM planner on the worker box (which can neither import .ts
// nor read a git checkout).
//
// This copy is what those consumers use ONLY while the ttsSkills table is
// empty — before the job's first post — and the prelude's header says so
// when it is serving. It is a snapshot, so it drifts: when writing.md
// changes, update it here too.

/** The row name the retired six-hourly sync wrote; a row by this name keeps
 * serving as the writing file until the nightly job's first post replaces
 * the table. */
export const WRITING_SKILL = "writing-to-tom";
export const WRITING_STANDARD = `WRITING STANDARD — every sentence TTS shows Tom obeys this.

THE TWO REGISTERS. All natural language here is one of exactly two kinds, and
you always know which one you are writing.

Display text is what is always on screen: a batch statement, a task statement,
a goal condition. It is short and it assumes Tom's background — it does not
teach, it names. One line, no trailing period needed, no preamble.

A ground-up explanation is the layer behind a "more" control on any line of
display text. It is self-contained: it defines every term at first use and is
complete without any external reference, because Tom forwards these to other
people and other agents verbatim. Assume the reader has no memory of any prior
session and no knowledge of anything an agent made — files, branches,
directories, jobs, and artifacts an agent created are unknown to him by name
and must be described before they are used.

THE FORM OF A GROUND-UP EXPLANATION: A COMPLETE HTML DOCUMENT. Rendered as
paragraphs of prose, a ground-up explanation is an incomprehensible wall of
text — Tom's own words, 2026-08-29, and the reason for this rule. So every one
you write is a complete, self-contained HTML document, opening at
<!DOCTYPE html> and closing at </html>, and it is shown FULLSCREEN. Hard
constraints, because it renders inside a sandbox with no scripting and no
network:
- No <script>, no inline event handlers, and no external stylesheet, font,
  image, or URL of any kind. Everything is inline: one <style> block in the
  <head> and plain markup in the <body>. Nothing loads from outside; anything
  external renders as a hole in the page.
- The dark palette of the page it opens over: background #0a0e17, body text
  #e2e8f0, secondary text #94a3b8, one accent #e8a040 for headings and key
  terms, #1e293b for borders and rules. No other colors unless a diagram
  genuinely needs one.
- Readable type: about 15px body text, 1.65 line height, a column no wider
  than roughly 760px centered with generous padding, a system sans stack
  (-apple-system, "Segoe UI", Roboto, sans-serif) for prose and a monospace
  stack (ui-monospace, "SF Mono", Menlo, monospace) for identifiers, paths,
  ids, and code.
- Real headings — one <h1> naming the subject, an <h2> per section — and short
  sections. The reader must be able to find the part he wants without reading
  the rest.

STRUCTURE OVER WALLS. Inside that document, pick the form that fits the fact:
- Enumerable facts go in a <table>: the terms and their definitions, the
  options and what each one costs, the fields and what they mean, the states
  and what each one implies. One fact per row, a real <th> header row.
- Steps, states, and dependencies go in a simple visual structure built from
  styled <div> boxes — a border, some padding, and an arrow (→ or ↓) between
  them. Boxes, borders, and arrows only; no diagramming library, and SVG only
  where plain shapes say it better than boxes would.
- Everything else is short paragraphs under a heading, plus lists where the
  items really are a list.

WHAT THE DOCUMENT MUST COVER. It exists so a reader arriving with no context
can understand the one line of display text it sits behind, and it must cover
all of it: what this is; why it exists, meaning the end state it serves; what
every term in the display text means, defined at first use; where the thing
stands right now; what happens next and who does it; and — whenever Tom's
ruling is the missing piece — exactly what he would be deciding, written as
the numbered decision list described below, with the options and your
recommendation.

HTML is the form; everything else in this standard is still the writing. The
rules on vocabulary, analogies, invented names, sentence construction, and
tone all apply inside the document unchanged.

WHO YOU ARE WRITING FOR. Tom is an AI PhD student. Assume fluent, and never
define: machine learning at PhD level (transformer structure, training,
evaluation), his own boolean-backdoor research vocabulary (triggers, arity,
truth tables, activating combinations, poisoning, dormancy, detector classes,
AUROC and the related rates), agent operations (subagents, worktrees,
branches, merges, model tiers, crons, SLURM, GPUs, ssh), and git. Assume
absent, and always define inline at first use: web-development jargon of every
kind, the statistics of causality and inference, Boolean Fourier analysis, the
internals of anything an agent created, and his own older prose and rules.

NO LOAD-BEARING ANALOGIES. Do not explain one thing by mapping it onto
another. The cost is the mapping itself: an analogy makes him understand a
second domain and then transfer it, which is more work than understanding the
thing directly. One orienting pointer to a system he already knows (his own
code, something he built) is allowed as a single sentence. The test is
deletion: remove the pointer, and if the explanation still teaches completely,
it was a pointer; if the explanation collapses, it was a load-bearing analogy
and is banned.

NO INVENTED NAMES. Do not coin nouns, single letters, stage letters, numbered
codenames, umbrella labels, or clever shorthands. Every one of these produces
a "what is that?" stall. Use hyphenated plain words instead. Do not introduce a
term that collides with something already in his head, and do not invent a
synonym for a word he already uses — reuse his word exactly.

HOW TO BUILD A SENTENCE. Complete sentences, never telegraphic fragments. One
idea per paragraph. Concrete before abstract: state the specific case first,
then the rule it illustrates. Every fact you include carries its relevance on
its face — if the reader cannot see why a sentence is there, cut it or say
why. Simple means fewer and more fundamental pieces at full technical
precision, never fewer technical terms. Err toward over-explaining: he would
rather skim background he already has than stop and ask.

DESCRIPTIVE, NEVER EVALUATIVE. State what is. No praise, no urgency, no
ceremony, no hedging, no selling.

DECISIONS. When something needs Tom's ruling, write it as a numbered list.
Each numbered item is one sentence of situation, then the options, then your
recommendation. He replies by number, so an item that cannot be read on its
own comes back unruled.`;

// ── Capture triage — THE FALLBACK COPY (the lifeos update, phase 6) ──────────
// Two judgements, and they are NOT the same question. Every capture poller on
// the Jarvis Box (poll-gmail, poll-canvas, poll-outlook) asks both:
//
//   1. does this imply an ACTION by Tom?  → capture it as a todo. Nothing is
//      lost, so a wrong yes costs one archive click and a wrong no loses the
//      thread; the prompt leans toward capturing.
//   2. does it need TOM, TODAY?           → open one thread in #tts on the
//      todo, so his reply is the next turn.
//
// The second is NOT an importance rating and never becomes one. It is capture
// triage: three facts about the message, each of which Tom has to answer to
// himself and cannot be answered by an agent — a deadline inside 48 hours, a
// person waiting on a reply, money or credentials. Everything else waits for
// the morning digest, which reports every capture.
//
// THE LIVE SOURCE IS NO LONGER THIS STRING. The lifeos update's phase 3
// merged the WikiTom capture-triage skill into model-of-tom/priorities.md as
// the section headed "What becomes a todo", and phase 4's nightly job posts
// priorities.md whole while replacing the ttsSkills table wholesale — so no
// row named capture-triage is written any more. GET /tts/capture-context
// takes the section out of the stored priorities row
// (convex/ttsSkills.ts captureTriageFrom) and names which of the three it
// served, so a poller's log line says where its rules came from.
//
// This copy is what the pollers use ONLY while neither the section nor a row
// the retired sync left behind is there. It is a snapshot, so it drifts: when
// the rules change in WikiTom, update it here too.

/** The heading in model-of-tom/priorities.md whose section IS the triage
 * rules. Matched by text, case-insensitively, through the next heading of the
 * same or a higher level. */
export const CAPTURE_TRIAGE_HEADING = "What becomes a todo";

/** The row the retired six-hourly WikiTom skill sync wrote. A row by this
 * name still serves — below the priorities section, above the copy here —
 * for as long as one survives the nightly job's first wholesale replace. */
export const CAPTURE_TRIAGE_SKILL = "capture-triage";
export const CAPTURE_TRIAGE_RULES = `CAPTURE TRIAGE — two judgements about one incoming message.

FIRST: does it imply an ACTION BY TOM — something he must reply to, submit,
schedule, pay, sign, decide, or follow up on? Skip newsletters, promotions,
automated notifications, receipts, and mass mail. When genuinely unsure,
capture: a wrong capture costs Tom one archive click, a wrong skip loses the
thread.

SECOND: does it need TOM, TODAY? This is not a rating of how important the
item is — it is whether waiting until tomorrow morning's digest would cost
something that cannot be recovered. Exactly three facts make it true, and any
one of them is enough:

  DEADLINE — the message names a deadline inside the next 48 hours.
  PERSON WAITING — a named human being has asked Tom for a reply. An automated
    sender, a mailing list, or a no-reply address is never a person waiting.
  MONEY OR CREDENTIALS — a payment, an invoice, a refund, a bill, an account,
    a password, a key, or a signature is at stake.

Nothing else qualifies. A message that implies an action and matches none of
the three is captured and reported in the morning digest like every other
capture; it is not lost, it is not urgent.`;

// ── Session-surface constants (one home; ledger graduation
// session-constants-two-homes) ───────────────────────────────────────────────
// app/sessions and convex/claudeSessions import these directly. The worker
// daemon CANNOT (only worker/ is deployed to the Jarvis Box, and Node does not load
// .ts), so it carries its own halves: session.mjs's REPO_GITHUB is a literal
// mirror of SESSION_REPOS, while session-host.mjs has no DAEMON_STALE_MS at
// all — its POLL_IDLE_MS cadence is the other half of a DERIVED contract
// (staleness = 3 missed idle polls). scripts/check-session-mirrors.mjs fences
// both — literal equality for the repo map, the 3x relation for staleness —
// and fails the guardrails run when either drifts.

/**
 * The repos a session may check out, with their GitHub homes. The browser's
 * repo picker is Object.keys(SESSION_REPOS) + "none"; the daemon clones
 * SESSION_REPOS[repo].
 */
export const SESSION_REPOS = {
  "tom.quest": "Heffnt/tom.quest",
  ComplexMultiTrigger: "Heffnt/ComplexMultiTrigger",
  WikiTom: "Heffnt/WikiTom",
} as const;

/** The sentinel repo value meaning "no checkout, an empty scratch workspace".
 * Written into claudeSessions.repo when a session holds no repos at all. */
export const NO_REPO = "none";

/** Every repo name a session may hold, in declaration order. THE list — the
 * auto-scheduler, the prospecting lane and the browser's picker all read it
 * rather than keeping hand-written copies (VQC C1: one home). */
export const SESSION_REPO_NAMES = Object.keys(
  SESSION_REPOS,
) as (keyof typeof SESSION_REPOS)[];

// ── Session models (ratified by Tom, 2026-09-04) ─────────────────────────────
// THE ONE HOME for which model a session runs on. A model name implies its
// FAMILY, and the family is what picks the runner on the Jarvis Box: "claude"
// runs through the Agent SDK, "codex" through OpenAI's Codex CLI
// (worker/session-host/codex-query.mjs). There is no separate "agent" field —
// the model IS the choice.
//
// Rules Tom set:
//   - He can always choose the model for his own sessions, at creation and
//     mid-session (setSessionModel; a cross-family change is a "reopen as").
//   - Autonomous sessions use a todo's tagged model if it has one, else the
//     fleet default (claudeAutoConfig.defaultModel), which starts at the
//     strongest Codex model.
//   - When Codex's WEEKLY usage is at or past CODEX_WEEKLY_CAP_PERCENT, the
//     fleet starts no Codex session: untagged todos fall back to "opus",
//     Codex-tagged todos wait. The 5-hour window is not gated.
//   - Codex subagents inherit the parent's model unless the parent asks for
//     a cheaper one; "gpt-5.6-terra" is the cheap tier. No luna.
//
// `id` is what the runner passes on the command line; null means the
// account default (today's behaviour for an ordinary Claude session).
// `effort` is Codex's model_reasoning_effort, sent on every turn.
//
// MIRRORED in worker/session-host/session.mjs (the daemon cannot import .ts);
// scripts/check-session-mirrors.mjs fails guardrails on drift.
export const SESSION_MODELS = {
  opus: { family: "claude", id: null, effort: null },
  sonnet: { family: "claude", id: "claude-sonnet-5", effort: null },
  fable: { family: "claude", id: "claude-fable-5", effort: null },
  "gpt-5.6-sol": { family: "codex", id: "gpt-5.6-sol", effort: "xhigh" },
  "gpt-5.6-terra": { family: "codex", id: "gpt-5.6-terra", effort: "medium" },
} as const;
export type SessionModel = keyof typeof SESSION_MODELS;
export type ModelFamily = (typeof SESSION_MODELS)[SessionModel]["family"];
export const SESSION_MODEL_NAMES = Object.keys(
  SESSION_MODELS,
) as SessionModel[];
/** The strongest Codex model Tom has access to — the default for new
 * sessions and the fleet default's starting value. */
export const DEFAULT_SESSION_MODEL: SessionModel = "gpt-5.6-sol";
/** Where the fleet lands when Codex's weekly cap is hit and the todo named
 * no model of its own. */
export const CODEX_FALLBACK_MODEL: SessionModel = "opus";
export const CODEX_WEEKLY_CAP_PERCENT = 90;
/**
 * How long a Codex usage reading stays believable. The daemon re-reads the
 * Codex CLI every few minutes and keeps sending its LAST SUCCESSFUL reading —
 * with that reading's original readAt — when a later read fails, so the age of
 * readAt is the whole staleness signal. Past this window the scheduler treats
 * the reading as UNKNOWN, exactly as if it were absent, and unknown ADMITS: a
 * CLI that stopped answering must not leave a months-old "90%" holding the
 * Codex door shut forever.
 */
export const CODEX_USAGE_STALE_MS = 15 * 60_000;
/** The stored form. One union of literals, DERIVED from the table above so a
 * model added there is accepted by the validator in the same edit — a
 * hand-copied union rejected a model the table already knew. An unknown model
 * name is still rejected at the validator, never silently dispatched. */
export const SESSION_MODEL = v.union(
  ...SESSION_MODEL_NAMES.map((m) => v.literal(m)),
);
export function isSessionModel(name: unknown): name is SessionModel {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SESSION_MODELS, name);
}
/** A row written before models existed (model absent) ran Claude on the
 * account default — so absent reads as this. ONE HOME for the legacy word: the
 * browser and modelFamily below both read it here rather than spelling "opus"
 * again (the daemon's mirror in worker/session-host/session.mjs carries the
 * literal, and scripts/check-session-mirrors.mjs fences the two together). */
export const LEGACY_SESSION_MODEL: SessionModel = "opus";
export function modelFamily(model: SessionModel | undefined): ModelFamily {
  return SESSION_MODELS[model ?? LEGACY_SESSION_MODEL].family;
}

export function isSessionRepo(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SESSION_REPOS, name);
}

/** The path, inside a repo, of the code-todo registry a repo governs itself by. */
export const CODE_TODO_PATH = "vqc/todos.yaml";

/**
 * The repos that keep their own code todos in CODE_TODO_PATH, mapped to the
 * DEFAULT branch that copy is read from. THE list, with two readers that must
 * agree (VQC C1: one home):
 *   - the mirror cron (convex/ttsSync.ts refreshMirror) fetches each repo's
 *     file from that branch into dtsCodeTodoMirror;
 *   - the prospecting prompt (convex/claudeSessions.ts) tells a prospector in
 *     one of these checkouts to READ that file before capturing, so it cannot
 *     hand Tom a finding the repo already tracks.
 * They drifted once: only ComplexMultiTrigger was named in the prompt, while
 * the cron mirrored tom.quest too, so tom.quest prospectors were blind to
 * tom.quest's own registry.
 */
export const CODE_TODO_REPOS = {
  ComplexMultiTrigger: "master",
  "tom.quest": "main",
} as const;

/** Whether a repo tracks its own code todos in CODE_TODO_PATH. */
export function tracksCodeTodos(repo: string): boolean {
  return Object.prototype.hasOwnProperty.call(CODE_TODO_REPOS, repo);
}

/**
 * The ONE normalizer for a session's repo list. Everything a caller might hand
 * us — a single legacy string, "none", an array with duplicates, a repo the
 * daemon does not know — collapses here into the canonical form: known repos
 * only, deduped, in SESSION_REPOS declaration order so two sessions asking for
 * the same set get byte-identical rows.
 *
 * An unknown name is DROPPED rather than thrown on: the daemon throws on a repo
 * it cannot clone, and a session that dies on its first turn is worse than a
 * session that starts with an empty scratch workspace.
 */
export function normalizeSessionRepos(
  input: readonly string[] | string | undefined,
): string[] {
  const raw =
    input === undefined ? [] : typeof input === "string" ? [input] : input;
  const wanted = new Set(raw.map((r) => r.trim()).filter(isSessionRepo));
  return SESSION_REPO_NAMES.filter((name) => wanted.has(name));
}

/**
 * The browser treats the session daemon as unreachable past this heartbeat
 * age; forceClose is allowed only past it. 90s = 3 missed 30s idle polls.
 */
export const DAEMON_STALE_MS = 90_000;

/**
 * The session statuses that mean "this session is still a going concern" —
 * every status in the claudeSessions.status union (convex/schema.ts) except
 * the two terminal ones, "ended" and "failed".
 *
 * ONE HOME. Before this, app/sessions/lib.ts and convex/claudeSessions.ts each
 * carried their own copy of this list and their own isLive, while the comment
 * above each copy said this file was the home — so the page's "live" and the
 * server's "live" were two facts that happened to agree. They are now one.
 * scripts/check-session-mirrors.mjs fences it: the list plus {ended, failed}
 * must equal the schema union, and no other file may declare a LIVE_STATUSES
 * of its own.
 */
export const LIVE_STATUSES = [
  "requested",
  "starting",
  "idle",
  "running",
  "awaiting-permission",
] as const;

export type LiveSessionStatus = (typeof LIVE_STATUSES)[number];

/** Takes a plain string so both sides can pass their own status type (the
 * browser's Doc<"claudeSessions">["status"], the server's) without a cast. */
export function isLive(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/** Deep link to one item on the /tts page (Everything tab), optionally
 * carrying an intent the page confirms before acting (state changes only on
 * the confirmed click — Slack's link-preview crawler fetches URLs, spec §7).
 * The single producer of the ?item=&intent= vocabulary consumed by app/tts.
 * Old /inventory links redirect to /tts with params preserved. */
export type TtsLinkIntent = "done" | "archive" | "engage";
export function ttsItemLink(todoId: string, intent?: TtsLinkIntent): string {
  return `https://tom.quest/tts?item=${todoId}${intent ? `&intent=${intent}` : ""}`;
}

/** The one reply line at capture (Tom's ruling 2026-08-30, one reply per
 * #dump message; the lifeos update: at capture, no model call): what was
 * created, as captured, and where it lives. */
export function captureReplyText(statement: string, todoId: string): string {
  return `Captured as a todo: ${statement.trim()} — ${ttsItemLink(todoId)}`;
}

/** Deep link to one session on the /sessions page — the one spelling every
 * Slack message about a session carries. */
export function ttsSessionLink(sessionId: string): string {
  return `https://www.tom.quest/sessions?session=${sessionId}`;
}

// ── Slack subjects (the lifeos update, phase 2) ──────────────────────────────
// Every outbound Slack message names WHAT it is about, and the record of the
// send (a dtsEvents row of kind "slack-sent", written by the one door in
// convex/ttsSync.ts) carries that subject — so a threaded reply from Tom is
// routed by what he answered (convex/ttsSlack.ts): a session gets its next
// turn, a todo or a digest day gets a fact or a time note, a learning line
// gets an objection. One closed union; a message with no subject cannot be
// sent.
export const SLACK_SUBJECT = v.union(
  v.object({ kind: v.literal("digest"), day: v.string() }),
  v.object({ kind: v.literal("hourly"), hour: v.string() }),
  v.object({ kind: v.literal("todo"), id: v.id("dtsTodos") }),
  v.object({ kind: v.literal("session"), id: v.id("claudeSessions") }),
  v.object({ kind: v.literal("learning"), id: v.string() }),
);
export type SlackSubject = Infer<typeof SLACK_SUBJECT>;

/** The lookup key of a Slack THREAD: the channel and the thread root's ts —
 * a message's own ts when it is a root, its thread_ts when it is a reply.
 * Tom's reply events carry (channel, thread_ts); this is what they match. */
export function slackThreadKey(channel: string, threadRootTs: string): string {
  return `${channel}:${threadRootTs}`;
}

/** The hourly update's subject key: NY calendar date and hour, "YYYY-MM-DDTHH". */
export function slackHourKey(utcMs: number): string {
  return `${nyCalendarDayKey(utcMs)}T${String(nyLocalHour(utcMs)).padStart(2, "0")}`;
}

/** A tab of the /tts page, in the page's own `?tab=` vocabulary
 * (app/tts/tts-client.tsx): the calendar, the batches, the items one by one.
 * The one spelling of a tab link, for every Slack message that sends Tom to
 * the page for the rest of a list. */
export type TtsTab = "calendar" | "batches" | "by-individual";
export function ttsTabLink(tab: TtsTab): string {
  return `https://tom.quest/tts?tab=${tab}`;
}

/** The batches tab of the /tts page. There is no per-batch URL, so a batch
 * named in Slack links here. */
export const TTS_BATCHES_LINK = ttsTabLink("batches");
