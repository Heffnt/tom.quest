// TTS time helpers. TWO KINDS OF DAY, and the whole module exists to keep them
// apart:
//
//   A NORMAL DAY is the calendar date on a New York clock. Midnight to
//   midnight, what a wall calendar says.
//
//   A TOM DAY is shifted to match Tom's sleep: it ENDS at 5 a.m. New York, so
//   2 a.m. Tuesday still belongs to Monday's tom day. Everything TTS schedules,
//   digests and surfaces runs on tom days.
//
// They disagree only in the hours between midnight and 5 a.m. — which is
// exactly when Tom is awake, so mixing them up is not a rare edge case. TTS
// tracks both on purpose: due-date arithmetic wants the normal day (where
// "2 a.m. belongs to yesterday" would be wrong), and the daily surfaces want
// the tom day.
//
//   tomDayKey(now)     "which tom day is it right now?"    2 a.m. → yesterday.
//   normalDayKey(t)    "what calendar date is this, on a NY clock?"
//   tomPrepDay(now)    "which tom day is a prep run building?" the day of the
//                      NEXT 5 a.m. digest — at 4:30 a.m. that is the tom day
//                      about to start, not the one about to end.
//
// Implemented without Intl so behavior is identical in the Convex runtime,
// Node (worker box), and the browser. US DST rules: clocks spring forward at
// 2:00 EST (07:00 UTC) on the second Sunday of March and fall back at 2:00 EDT
// (06:00 UTC) on the first Sunday of November.

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

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
export function normalDayKey(utcMs: number): string {
  return new Date(utcMs + nyOffsetHours(utcMs) * HOUR_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The TTS day key (YYYY-MM-DD) for an instant: the NY calendar date, with the
 * day rolling over at 5 a.m. local rather than midnight — so 2 a.m. Tuesday
 * still belongs to Monday's day. Used by getToday and the digest send.
 */
export function tomDayKey(utcMs: number): string {
  const shifted = utcMs + (nyOffsetHours(utcMs) - TTS_DIGEST_NY_HOUR) * HOUR_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * The day a PREP run is building: the day of the next 5 a.m. digest. During
 * the pre-dawn prep window (midnight–5 a.m.) this is the day about to start —
 * NOT tomDayKey(now), which still says yesterday. From 5 a.m. onward it equals
 * tomDayKey(now) (a midday --force re-prep rebuilds today's queue).
 * Implemented as "the TTS day five hours from now".
 */
export function tomPrepDay(utcMs: number): string {
  return tomDayKey(utcMs + TTS_DIGEST_NY_HOUR * HOUR_MS);
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
export function tomDayBoundsUtc(day: string): { start: number; end: number } {
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
export function normalDayBoundsUtc(day: string): {
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
    (Date.parse(normalDayKey(dueAt)) - Date.parse(normalDayKey(now))) /
    DAY_MS;
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "tomorrow";
  if (dayDiff > 1) return `in ${dayDiff} days`;
  if (dayDiff === -1) return "1 day overdue";
  return `${-dayDiff} days overdue`;
}

// ── The todo graph: needs, done, ready (schema v2, ratified 2026-08-29) ──────
// THE ONE HOME for the graph rules — convex/ and app/ both import from here,
// so the server's frontier and the page's frontier cannot drift. Structural
// types (not Doc<"dtsTodos">) so this module stays importable from both sides
// without dragging in the generated data model; Id<"dtsTodos"> is a string at
// runtime and assignable to these.

/** The bounded fan-in of one todo's `needs` (Convex unbounded-array rule). */
export const MAX_NEEDS = 10;

/** The slice of a todo the graph rules read. */
export type GraphTodo = {
  _id: string;
  status: "active" | "waiting" | "archived" | "done";
  needs?: readonly string[];
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

/**
 * READY — Tom's word for the frontier: this todo is active and every id in its
 * `needs` is done. `waiting` is excluded on purpose (a sleeping todo is not
 * ready no matter what its needs say), as are done/archived rows. No needs at
 * all = ready the moment it is active.
 */
export function isReady(todo: GraphTodo, doneSet: ReadonlySet<string>): boolean {
  return (
    todo.status === "active" &&
    (todo.needs ?? []).every((id) => doneSet.has(id))
  );
}

/** The ready list, in the order given. */
export function frontier<T extends GraphTodo>(todos: readonly T[]): T[] {
  const doneSet = buildDoneSet(todos);
  return todos.filter((t) => isReady(t, doneSet));
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

// ── The writing standard (one home; ratified 2026-08-29) ────────────────────
// EVERY piece of natural language TTS shows Tom — a batch statement, a task
// statement, a ground-up explanation, a digest line, a decision list — is
// written to this standard. It lives here as a plain string because its ONE
// consumer that cannot import anything is a worker prompt: the planner job
// (worker/jobs/plan-graphs.mjs) is Node ESM on a box that never loads .ts, so
// it fetches this text over HTTP (GET /tts/batch-context, which reads it from
// right here) and pastes it into the prompt verbatim. Any TypeScript caller
// imports it directly. Two copies of a writing standard drift within a week;
// this is the only copy in the codebase.
//
// The DURABLE home of the reasoning behind it — the mined evidence, the
// session cites, the full calibration — is the WikiTom page tts/model-of-tom.md
// (read via git; see tts/spec.md §18). What follows is the operative summary
// that ships in prompts; when the wiki page changes, this string changes with
// it.
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

// ── Session-surface constants (one home; ledger graduation
// session-constants-two-homes) ───────────────────────────────────────────────
// app/sessions and convex/claudeSessions import these directly. The worker
// daemon CANNOT (only worker/ is deployed to the box, and Node does not load
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

/**
 * The browser treats the session daemon as unreachable past this heartbeat
 * age; forceClose is allowed only past it. 90s = 3 missed 30s idle polls.
 */
export const DAEMON_STALE_MS = 90_000;

/** Deep link to one item on the /tts page (Everything tab), optionally
 * carrying an intent the page confirms before acting (state changes only on
 * the confirmed click — Slack's link-preview crawler fetches URLs, spec §7).
 * The single producer of the ?item=&intent= vocabulary consumed by app/tts.
 * Old /inventory links redirect to /tts with params preserved. */
export type TtsLinkIntent = "done" | "archive" | "engage";
export function ttsItemLink(todoId: string, intent?: TtsLinkIntent): string {
  return `https://tom.quest/tts?item=${todoId}${intent ? `&intent=${intent}` : ""}`;
}
