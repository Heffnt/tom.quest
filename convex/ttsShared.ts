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

// The session constants the box reads too: the narrow list, the repo map, the
// model table and the daemon's staleness window. Their one home is
// shared/session-constants.mjs, plain ESM that the box's Node and this file
// both import; they are re-exported here so the record and the site keep one
// import. The narrow list is Tom's boundary for an unattended delegate.
import {
  DAEMON_STALE_MS,
  LEGACY_SESSION_MODEL,
  NARROW_LIST,
  NO_REPO,
  SESSION_MODELS,
  SESSION_REPOS,
} from "../shared/session-constants.mjs";
export { DAEMON_STALE_MS, LEGACY_SESSION_MODEL, NARROW_LIST, NO_REPO, SESSION_MODELS, SESSION_REPOS };
export type NarrowListItem = (typeof NARROW_LIST)[number];
export const NARROW_LIST_IDS = NARROW_LIST.map((item) => item.id);
export function isNarrowListId(value: unknown): value is NarrowListItem["id"] {
  return typeof value === "string" && (NARROW_LIST_IDS as readonly string[]).includes(value);
}

/**
 * The opening contract for every unattended TTS mission. The worker prompt
 * builders share it instead of carrying synchronized copies.
 */
export const WORKER_CONTRACT =
  "You are working inside TTS (Toms Todo System) as a WORKER — no one is watching this transcript live, and nothing you write in chat reaches anyone unless a pen (a command below) records it.";

/** The closed TTS vocabulary, defined before a worker mission uses its terms. */
/**
 * ONE COMMIT KEY, and one home for it.
 *
 * `<repo>@<sha>` indexes the merge gate's rows for a commit, and two spellings
 * of it index two different sets of rows. It used to live in
 * convex/ttsMerge.ts, where convex/ttsEvals.ts could not import it without a
 * cycle, so ttsEvals.ts wrote the template inline instead; this module is the
 * one home both could read.
 *
 * `mergeKey` travels with it because it is the same identity in the merge
 * event's older spelling, and splitting a pair like that across two files is
 * how a second spelling starts.
 */
export function commitKey(repo: string, sha: string): string {
  return `${repo}@${sha}`;
}

/** The merge event's own key, which predates the commit key. */
export function mergeKey(repo: string, sha: string): string {
  return `${repo}:${sha}`;
}

/**
 * A FAILURE IS A SHAPE AND NOT A KIND: a job failure is an event kind ending
 * in "-failed" or in "-failure" — the nightly and the weekly write the second
 * spelling ("nightly-failure", "weekly-failure"), and reading only the first
 * left their failures out of both the failures lane and the digest. Two
 * exclusions, both load-bearing:
 *   "slack-send-failed"  the Slack door's own. Posting it to Slack is a loop:
 *                        a refused post would write a row that schedules
 *                        another post.
 *   "learning-revert-failed"  not a job failure at all — it is an objection
 *                        the nightly job could not apply, and it belongs to
 *                        the model-of-Tom line it is about.
 *
 * Spelled here, not in convex/tts.ts where the #tts-broken writer applies it,
 * because the observation page asks the same question of the same events and a
 * second list of the exceptions is a second answer waiting to drift.
 */
export function isFailureKind(kind: string): boolean {
  return (
    (kind.endsWith("-failed") || kind.endsWith("-failure")) &&
    kind !== "slack-send-failed" &&
    kind !== "learning-revert-failed"
  );
}

/**
 * THE SUBJECT A CHANGE IS RULED ON: a code subject `(repo, externalId)` whose
 * externalId names the change rather than a code todo. A pull request the
 * record has mirrored is `pr-<number>`; a merged commit whose pull request the
 * mirror never saw is `sha-<sha>`. Spelled here because convex/ttsRulings.ts
 * (which applies such a ruling at write time), convex/observe.ts (which writes
 * one) and convex/observeMerge.ts (which reads one) all need the same spelling,
 * and this module is the one all three already import.
 */
export function pullRequestChange(number: number): string {
  return `pr-${number}`;
}

export function commitChange(sha: string): string {
  return `sha-${sha}`;
}

/** True for an externalId that names a change (above) rather than a code todo.
 *  Code todo ids are registry ids such as `cmt-archive`, never these shapes. */
export function isChangeSubject(externalId: string): boolean {
  return /^pr-\d+$/.test(externalId) || /^sha-[0-9a-f]{7,40}$/i.test(externalId);
}

// <vocabulary generated version=fdd55cb533934518 — scripts/vocabulary.mjs; do not edit>
export const TTS_CLOSED_VOCABULARY = `The vocabulary, which is closed — these words mean exactly this and nothing else:
- task — A task is work an agent or Tom performs.
- goal — A goal is a checkable condition about the world. It is done when its statement is true.
- needs — Needs are the ids a todo cannot proceed without. They are the only ordering mechanism in TTS.
- ready — Ready is computed, never stored. A todo is ready when it is prepared and active, its wake time has passed or is absent, and every id in its needs is done or archived, because a need set aside is not going to happen.
- display text — Display text is the always-visible register: the short line always on screen, assuming Tom's background.
- ground-up explanation — A ground-up explanation is the register behind the more on every line of display text: self-contained, every term defined at first use, one complete HTML document shown fullscreen in the form the writing standard specifies.`;
export const VOCABULARY_VERSION = "fdd55cb533934518";
/** Every word in the vocabulary, names only — the definitions live in
 *  WikiTom tts/vocabulary.json and `tts search define` answers from them. */
export const VOCABULARY_TERMS: readonly string[] = [
  "#dump",
  "#tts-broken",
  "#tts-decisions",
  "#tts-hourly",
  "#tts-needs-you",
  "#tts-today",
  "actor",
  "agent",
  "agent file",
  "agent manifest",
  "agent store",
  "agent vocabulary",
  "agents page",
  "area page",
  "blast radius",
  "block",
  "calendar mirror",
  "capture-triage rules",
  "change report",
  "child agent",
  "context entry",
  "date outcome",
  "delegate",
  "digest",
  "display text",
  "edge",
  "engagement latency",
  "entry action",
  "environment",
  "evals",
  "evidence",
  "facts block",
  "file version",
  "frontier",
  "goal",
  "golden set",
  "ground-up contract",
  "ground-up explanation",
  "handoff",
  "heartbeat staleness",
  "hourly update",
  "invitation",
  "Jarvis",
  "jarvis agent",
  "Jarvis Box",
  "judge",
  "kept-dates rule",
  "label event",
  "ladder",
  "map",
  "missed rule",
  "mode",
  "narrow list",
  "needs",
  "node",
  "objection list",
  "observe and object",
  "origin",
  "outcome",
  "parser version",
  "pen",
  "planner",
  "principles ledger",
  "re-entry paragraph",
  "readiness",
  "ready",
  "record",
  "registration envelope",
  "reopen",
  "repeat",
  "restructuring candidate",
  "ruling",
  "runner",
  "search",
  "self-imposed date",
  "sends-even-when-empty rule",
  "session",
  "session kind",
  "session-surface vocabulary",
  "status",
  "sweep",
  "task",
  "task-shape contract",
  "the base and the skills",
  "the nightly job",
  "the two-tier transcript",
  "time note",
  "todo",
  "tom-gate",
  "Tom's directions",
  "transcript",
  "TTS",
  "walk",
  "WikiTom",
  "worker",
];
// </vocabulary generated>

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** The window a retired condition-bound row's sleep was set by: the lifeos
 * migration writes wakeAt = its latest-safe instant minus this when it turns
 * such a row into a task with the condition in its statement. Kept because
 * ttsMigrations still computes that sleep on a re-run; nothing else reads it
 * now that the fallback queue's condition lane is gone. */
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
// NARROWED (the lifeos update, phase 7): the validator (READINESS below, the
// one the schema and every pen use) holds exactly these two values. The two
// retired spellings, "preparing" and "ready-for-tom", were mapped one to one
// by ttsMigrations.internalMigrateReadiness ("preparing" → unprepared, the
// write-up was not finished; "ready-for-tom" → prepared) and verified on prod
// with a zero count on a second run, so no stored row carries them and no
// writer may store them. normalizeReadiness / isPrepared still ACCEPT them on
// read for one more release — a page bundle or a box job built before this
// narrow can hold a row in memory in the old spelling — and then the retired
// list goes too.
export const READINESS_VALUES = ["unprepared", "prepared"] as const;
export type Readiness = (typeof READINESS_VALUES)[number];
export const RETIRED_READINESS_VALUES = ["preparing", "ready-for-tom"] as const;
/** What a reader may still be handed: the two values, plus the two retired
 * spellings for one more release (read-only; the validator refuses them). */
export type StoredReadiness =
  | Readiness
  | (typeof RETIRED_READINESS_VALUES)[number];
/** The stored form: the two values. convex/schema.ts, Tom's door, and every
 * pen that stores readiness use this. */
export const READINESS = v.union(...READINESS_VALUES.map((r) => v.literal(r)));
/** One reading for every spelling a reader can still meet. "ready-for-tom"
 * meant "the write-up is finished and only Tom is missing", so it reads as
 * prepared. "preparing" meant "an agent still has groundwork to do here" — a
 * half-prepared row — and a raw or half-prepared capture is never ready, so
 * it reads as unprepared. Each spelling has exactly one reading. */
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
// (convex/ttsRulings.ts VERDICT).
//
// NARROWED (the lifeos update, phase 7): RECOMMENDATION below — the validator
// the schema, the brief pen and the route all use — holds exactly these four.
// The three retired spellings mapped one to one, were rewritten by
// ttsMigrations.internalMigrateRecommendations, and were verified on prod with
// every count zero on a second run, so no stored brief carries them and no
// writer may store them. normalizeRecommendation still ACCEPTS them on read
// for one more release — a page bundle built before this narrow can hold a
// brief in memory in the old spelling — and then the retired map goes too.
export const RECOMMENDATION_VALUES = ["approve", "revise", "session", "archive"] as const;
type Recommendation = (typeof RECOMMENDATION_VALUES)[number];
/** Read-only for one more release; the validator refuses all three. */
export const RETIRED_RECOMMENDATION_MAP = {
  "stale-replan": "revise",
  "needs-session": "session",
  "propose-archive": "archive",
} as const satisfies Record<string, Recommendation>;
/** What a reader may still be handed: the four words, plus the three retired
 * spellings for one more release. */
export type StoredRecommendation =
  | Recommendation
  | keyof typeof RETIRED_RECOMMENDATION_MAP;
/** The stored form: the four verdict words. convex/schema.ts, the brief pen
 * and POST /tts/code-briefs use this. */
export const RECOMMENDATION = v.union(
  ...RECOMMENDATION_VALUES.map((r) => v.literal(r)),
);
/** One reading for every spelling a reader can still meet. */
export function normalizeRecommendation(r: StoredRecommendation): Recommendation {
  return r in RETIRED_RECOMMENDATION_MAP
    ? RETIRED_RECOMMENDATION_MAP[r as keyof typeof RETIRED_RECOMMENDATION_MAP]
    : (r as Recommendation);
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
 * (app/jarvis/lib.ts) already reads a batch member's completion by.
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
    return { kind: "wake", at: todo.wakeAt };
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
  timingClass?: "dated" | "whenever";
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
 * answers the same question. `condition` used to read two ways, and the second
 * reading — the TRIGGER on a `timingClass: "condition-bound"` row, which says
 * when a todo may START and is not a completion test — is why this function
 * once had a third arm. The lifeos update retired that value: the migration
 * moved every trigger sentence into its row's statement, so a `condition` left
 * on a row is a completion test and nothing else.
 */
export function goalCheckable(todo: GoalTodo): boolean {
  if (todo.kind !== "goal") return false;
  if (todo.codeRepo !== undefined && todo.codeExternalId !== undefined) {
    return true;
  }
  return (todo.condition ?? "").trim() !== "";
}

// Weekly source-file facts identify area pages by this prefix. Prompt text is
// stored as already-rendered layers in modelOfTomPublication instead.
export const MODEL_OF_TOM_AREAS_DIR = "model-of-tom/areas";

/** The first line of every prompt that carries the prelude, and so of every
 * transcript. It is shared with the session reader, which reads the header
 * from the stored publication rather than rebuilding it from source files. */
export const MODEL_OF_TOM_HEADER = "MODEL-OF-TOM FILES";

export type ModelOfTomHead = {
  commit: string | null;
  paths: string[];
};

/** The parseable first line stored at the front of every session opener. */
export function modelOfTomHeadOf(text: string): ModelOfTomHead | null {
  const line = text.split("\n", 1)[0] ?? "";
  if (!line.startsWith(MODEL_OF_TOM_HEADER)) return null;
  const commit = /WikiTom commit ([0-9a-f]{7,40})/i.exec(line)?.[1] ?? null;
  const paths = (/\):\s*(.+)$/.exec(line)?.[1] ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
  return { commit, paths };
}

// ── Session-surface constants ─────────────────────────────────────────────────
// SESSION_REPOS and NO_REPO live in shared/session-constants.mjs with the rest
// of the session constants the box reads (imported at the top of this file);
// what is derived from them stays here.

/** The sentinel repo value meaning "no checkout, an empty scratch workspace".
 * Written into claudeSessions.repo when a session holds no repos at all. */
// ── The box's prompt sentences ──────────────────────────────────────────────
// Read by the mission prompts in convex/claudeSessions.ts.

// The daemon that runs THIS session runs every other live session on the box
// too, so an agent that restarts it to pick up its own change kills itself
// mid-turn and takes the rest of the fleet with it. Named in every prompt
// shape — checkout or empty scratch, autonomous or interactive — because the
// one shape that goes unsaid is the one that does it.
export const DAEMON_RESTART_SENTENCE =
  "Never restart, stop, or kill `tts-session-host` — it is the daemon running this session and every other live session on this box; if a change needs a restart, say so in your outcome and the supervisor restarts it.";

/** Every repo name a session may hold, in declaration order. THE list — the
 * auto-scheduler, the prospecting lane and the browser's picker all read it
 * rather than keeping hand-written copies (VQC C1: one home). */
export const SESSION_REPO_NAMES = Object.keys(
  SESSION_REPOS,
) as (keyof typeof SESSION_REPOS)[];

// ── Session models (ratified by Tom, 2026-09-04) ─────────────────────────────
// SESSION_MODELS, the table of which model a session runs on, lives in
// shared/session-constants.mjs so the box's daemon reads the same table; the
// types and helpers derived from it are here. A model name implies its
// FAMILY, and the family is what picks the runner on the Jarvis Box: "claude"
// runs through the Agent SDK, "codex" through OpenAI's Codex CLI
// (worker/session-host/codex-query.mjs). There is no separate "agent" field —
// the model IS the choice.
//
// Rules Tom set:
//   - He can always choose the model for his own sessions, at creation and
//     mid-session (setSessionModel; a cross-family change is a "reopen as").
//   - Workers use a todo's tagged model if it has one, else the
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
export type SessionModel = keyof typeof SESSION_MODELS;
export type ModelFamily = (typeof SESSION_MODELS)[SessionModel]["family"];
export const SESSION_MODEL_NAMES = Object.keys(
  SESSION_MODELS,
) as SessionModel[];
/** The strongest Codex model Tom has access to — the default for new
 * sessions and the fleet default's starting value. */
export const DEFAULT_SESSION_MODEL: SessionModel = "gpt-5.6-sol";
/**
 * Whether Fable answers on the box, as the session daemon reports it on its
 * heartbeat from worker/agents/models.mjs's availability file. While
 * `available` is false a request for Fable runs Opus (the model ceiling, Tom's
 * rulings of 2026-09-24); the daemon's hourly probe sets it true again.
 * `since` is when the value last changed, `checkedAt` the last run or probe
 * that found it out, `reason` the CLI's refusal. One validator for the
 * heartbeat's argument and the stored field.
 */
/**
 * The latest usage limit a Claude session on the box hit that was not a Fable
 * refusal, as the daemon reports it on its heartbeat: when, the CLI's words,
 * and which session. A fact for the pages; the daemon never switches the
 * account on it (Tom's ruling of 2026-09-24 keeps the box on the wpi account).
 */
export const USAGE_LIMIT_REPORT = v.object({
  at: v.number(),
  text: v.string(),
  sessionId: v.string(),
});
export const FABLE_AVAILABILITY = v.object({
  available: v.boolean(),
  since: v.number(),
  checkedAt: v.number(),
  reason: v.optional(v.string()),
});
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
export function modelFamily(model: SessionModel | undefined): ModelFamily {
  return SESSION_MODELS[model ?? LEGACY_SESSION_MODEL].family;
}

export function isSessionRepo(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SESSION_REPOS, name);
}

/** The path, inside a repo, of the code-todo registry a repo governs itself by. */
export const CODE_TODO_PATH = "vqc/todos.yaml";

/**
 * The repos that keep their own code todos in CODE_TODO_PATH, each with the
 * DEFAULT branch that copy is read from and the repo's own GUARD — the one
 * command that says the file is still well-formed. THE list, with three
 * readers that must agree (VQC C1: one home):
 *   - the mirror cron (convex/ttsSync.ts refreshMirror) fetches each repo's
 *     file from that branch into dtsCodeTodoMirror;
 *   - the prospecting prompt (convex/claudeSessions.ts) tells a prospector in
 *     one of these checkouts to READ that file before capturing, so it cannot
 *     hand Tom a finding the repo already tracks;
 *   - the code mission prompt (convex/claudeSessions.ts) tells a worker that
 *     closed an entry to RUN the guard before its pull request.
 * They drifted once: only ComplexMultiTrigger was named in the prompt, while
 * the cron mirrored tom.quest too, so tom.quest prospectors were blind to
 * tom.quest's own registry.
 *
 * ComplexMultiTrigger is OFF this list since Tom's ruling of 2026-09-22,
 * ratified as CMT adoption ruling 70 on 2026-09-24: "i dont think vqc should
 * have its own todos since tts covers that." CMT's todos live in TTS; its
 * vqc/todos.yaml is deleted after they are homed. The mirror rows it left in
 * dtsCodeTodoMirror stay in the table as records (the evals read past code
 * rulings' inputs off them), and every live reader of the mirror reads only
 * the repos on this list (tts.ts liveMirrorRows), so a frozen row can never
 * read as open work.
 */
export const CODE_TODO_REPOS = {
  "tom.quest": { branch: "main", guard: "pnpm vitest run vqc/todos.test.ts" },
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

// DAEMON_STALE_MS (shared/session-constants.mjs, re-exported above): the
// browser treats the session daemon as unreachable past this heartbeat age,
// and forceClose is allowed only past it. It is three of the daemon's idle
// polls, POLL_IDLE_MS, defined beside it.

/**
 * The session statuses that mean "this session is still a going concern" —
 * every status in the claudeSessions.status union (convex/schema.ts) except
 * the two terminal ones, "ended" and "failed".
 *
 * ONE HOME. Before this, app/agents/lib.ts and convex/claudeSessions.ts each
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
 * The single producer of the ?item=&intent= vocabulary consumed by app/jarvis.
 * Old /inventory links redirect to /tts with params preserved. */
export type TtsLinkIntent = "done" | "archive" | "engage";
export function ttsItemLink(todoId: string, intent?: TtsLinkIntent): string {
  return `https://tom.quest/tts?item=${todoId}${intent ? `&intent=${intent}` : ""}`;
}

// The one reply line at capture is composeCaptured in convex/ttsCompose.ts
// now, with every other message TTS sends. The line that used to live here
// echoed Tom's own words back to him in full inside his own thread, which
// doubled the length of everything in #dump and told him only that the system
// worked; the one fact he did not already have is when he next sees it.

/** Deep link to one session on the /agents page — the one spelling every
 * Slack message about a session carries. */
export function ttsSessionLink(sessionId: string): string {
  return `https://www.tom.quest/agents?session=${sessionId}`;
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
  // `today` supersedes the old deterministic `digest` name. Keep digest for
  // already-posted threads: a Slack reply can arrive days after a deploy.
  v.object({ kind: v.literal("today"), day: v.string() }),
  v.object({ kind: v.literal("digest"), day: v.string() }),
  v.object({ kind: v.literal("hourly"), hour: v.string() }),
  v.object({ kind: v.literal("todo"), id: v.id("dtsTodos") }),
  v.object({ kind: v.literal("session"), id: v.id("claudeSessions") }),
  v.object({ kind: v.literal("learning"), id: v.string() }),
  // ONE DELEGATED DECISION (an "ask"), posted to the decisions channel as it
  // is recorded (convex/ttsAsk.ts), and one broken-job thread. Both name their
  // producer rather than a fabricated todo: a todo subject stamps
  // slackReplyTs, which belongs to the ONE reply thread that todo has in
  // #dump, and a decisions-channel line must not claim it. A reply in an ask's
  // thread is an objection to that one decision.
  v.object({ kind: v.literal("ask"), id: v.string() }),
  v.object({ kind: v.literal("job"), id: v.string() }),
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

// ── The one output channel (Tom, 2026-09-26: "#dump in, one out") ─────────────
// #dump is where his words come in; everything the record says to him goes to
// one channel: the digest, the needs-you replies in its thread, the silence
// alarm. It is #tts-today until the morning rename to #jarvis, which keeps the
// id, so its variable keeps its name tonight. The rooms that were each one
// purpose (#tts-decisions, #tts-needs-you, #tts-hourly, #tts-broken,
// #tts-simplify, #tts-runners) are sections of the digest now.
//
// Here rather than in convex/ttsSync.ts, which owns the Slack door, because
// that file is "use node" and the plain-runtime record areas ask it too.

/** The kind of the marker row every needs-you writes when it opens, keyed on
 *  the producer's own id for the thing that needs Tom. */
export const NEEDS_TOM = "needs-tom";

/** THE ONE CONFIG CHECK. A message says "reply here" only when a reply would
 *  actually reach TTS: POST /slack/events answers 503 without
 *  SLACK_SIGNING_SECRET, and ignores every message without TOM_SLACK_USER_ID.
 *  Today the morning message prints "missed: reply done, or a new date" six
 *  times a day into a route that answers 503 — the only call to action in the
 *  whole system, and it is dead. A message that asks for something it cannot
 *  receive teaches him to ignore the ones that can. */
export function replyRouteLive(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET && process.env.TOM_SLACK_USER_ID);
}

/** The output channel, or null when neither variable is set (logged, and
 *  nothing is posted: ruling digest-env-missing-is-quiet; the box reports the
 *  digest it could not post as its own failure). SLACK_TTS_CHANNEL_ID is the
 *  room's older variable, read when the newer one is unset. */
export function outputChannel(): string | null {
  for (const name of ["SLACK_TTS_TODAY_CHANNEL_ID", "SLACK_TTS_CHANNEL_ID"]) {
    const id = process.env[name];
    if (typeof id === "string" && id !== "") return id;
  }
  console.error("slack: SLACK_TTS_TODAY_CHANNEL_ID not configured — nothing posted to the output channel");
  return null;
}

// ── The calendar feeds, and the private ones (Tom, 2026-09-09) ───────────────
// TTS_ICS_FEEDS is a JSON array of {name, url} on the Convex deployment; each
// entry's `name` is what a mirrored row carries in ttsCalendarEvents.feed.
//
// An entry may also carry `"private": true`. A PRIVATE FEED STAYS IN THE
// RECORD — scheduling still knows Tom is busy, and every planner still reads
// those rows — but no composer that writes to Slack, and no prompt that lists
// his calendar for a message to him, may name one. Tom's family calendar is
// the feed this exists for, and the ruling is that the morning message says
// NOTHING about it at all, not even "one private commitment".
//
// This lives here rather than in convex/ttsCalendarFetch.ts because that file
// is "use node" and the fact gatherer (convex/ttsDigest.ts) is a plain-runtime
// query that has to drop the rows.
export type IcsFeedConfig = { name: string; url: string; private?: boolean };

export function parseIcsFeedConfig(raw: string): IcsFeedConfig[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("TTS_ICS_FEEDS must be a JSON array");
  return parsed.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.name !== "string" || typeof e?.url !== "string") {
      throw new Error(`TTS_ICS_FEEDS[${i}] needs {name, url}`);
    }
    if (e.private !== undefined && typeof e.private !== "boolean") {
      throw new Error(`TTS_ICS_FEEDS[${i}].private must be true or false when present`);
    }
    return { name: e.name, url: e.url, ...(e.private === true ? { private: true } : {}) };
  });
}

/** The feed names Tom has marked private, read from the environment. An
 *  unreadable TTS_ICS_FEEDS answers "every feed is private": a misconfigured
 *  variable must not be the reason his family calendar reaches Slack.
 *
 *  SO DOES AN ABSENT OR EMPTY ONE. The mirrored rows outlive the variable —
 *  clearing TTS_ICS_FEEDS stops the fetch but leaves every ttsCalendarEvents
 *  row in place, so "no config" once meant "nothing is private" and the family
 *  feed printed. There is no state of this variable in which the answer is
 *  "name everything": either it says which feeds are private, or nothing is
 *  named. */
export function privateFeedNames(raw: string | undefined): Set<string> | "all" {
  if (raw === undefined || raw.trim() === "") return "all";
  try {
    return new Set(parseIcsFeedConfig(raw).filter((f) => f.private).map((f) => f.name));
  } catch (err) {
    console.error(
      `TTS calendar: TTS_ICS_FEEDS is unreadable (${err instanceof Error ? err.message : String(err)}) — every feed is treated as private`,
    );
    return "all";
  }
}

/** Whether a mirrored calendar row may be named in something Tom reads. */
export function feedIsPrivate(feed: string | undefined, privateFeeds: Set<string> | "all"): boolean {
  if (privateFeeds === "all") return true;
  return feed !== undefined && privateFeeds.has(feed);
}

/** A tab of the /tts page that a Slack message may link, in the page's own
 * `?tab=` vocabulary (app/jarvis/jarvis-client.tsx): the calendar or everything. The
 * one spelling of a tab link, for every Slack message that sends Tom to the
 * page for the rest of a list. The retired spellings older posts carry
 * (batches, needs-me, by-individual) open the everything tab: the page reads
 * any name but calendar as everything. */
export type TtsTab = "calendar" | "everything";
export function ttsTabLink(tab: TtsTab): string {
  return `https://tom.quest/tts?tab=${tab}`;
}

/**
 * The counts `tts search vocabulary` prints after `terms=` in its header: the
 * render's other sections, in the order printed. The terms themselves are
 * counted from the row, so they are not one of these. convex/schema.ts's
 * ttsVocabulary row and the POST /tts/vocabulary door both use this.
 */
export const VOCABULARY_COUNT_NAMES = ["entities", "jobs", "search", "skills", "repos", "channels"] as const;
export const VOCABULARY_COUNTS = v.object({
  entities: v.number(),
  jobs: v.number(),
  search: v.number(),
  skills: v.number(),
  repos: v.number(),
  channels: v.number(),
});
