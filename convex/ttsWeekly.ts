// The weekly session's server half (the lifeos update, phase 8; spec §11).
//
// ONE DETERMINISTIC GATHER, NO MODEL IN THE LOOP. The Friday job on the Jarvis
// Box (worker/jobs/weekly.mjs) asks GET /tts/weekly-input for the seven days
// ending now, and everything below is a query on an index: what was completed,
// what was captured and from where, every date outcome, the items surfaced
// three times and never touched, the goals no worker has evaluated in seven days, the integrations by state, each area
// page's reviewed age against its window, the size of the model-of-tom files,
// what the nightly job wrote and what was reverted, the job failures by job,
// the threads that needed Tom and how long each waited for his reply, and the
// prepared/unprepared counts. The job adds the one fact that lives in the
// WikiTom checkout — last week's agenda and its outcome — and makes the one
// model call.
//
// DESCRIPTIVE, NEVER EVALUATIVE (principle 3): every fact here is a count, a
// list, or an age. Nothing is scored, graded, or ranked, and the gather writes
// nothing — not to a todo, not to an event.
//
// BOUNDED READS: each list is read on an index with the kind or the status
// pinned and the window on the range, so the cost is the week's own rows of
// that kind, never the table. The active set is read once (by_status) and
// serves three facts.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { AREA_REVIEWED, LEARNING_CHANGE, SLACK_FAILED } from "./ttsDigest";
import {
  INTEGRATIONS,
  declinedIntegrations,
  isCredentialKey,
} from "./ttsIntegrations";
import { JOB_FAILED, JOB_RECOVERED, failuresInWindow } from "./jarvis/jobs";
import { NEEDS_TOM_ANSWERED } from "./jarvis/outbox";
import { NIGHTLY_FAILURE } from "./ttsNightly";
import { NEEDS_TOM, SLACK_REPLY_FAILED } from "./ttsSlack";
import { DAY_MS, MODEL_OF_TOM_AREAS_DIR, SESSION_OUTCOME, isPrepared } from "./ttsShared";
import { todoEvents, todoIdForms, todoReader } from "./jarvis/tables";
import { isModelOfTomPath, MODEL_OF_TOM_LAYER_NAMES } from "./ttsSkills";
import { EVAL_RUN, PRELUDE_DELIVERY } from "./ttsEvals";
import { AUDIT_APPROVED, AUDIT_VERDICT, MERGE, commitKey, mergeKey } from "./ttsMerge";
import { DELEGATE_OBJECTION } from "./ttsAsk";
import { isIsoDay, parseFrontmatter } from "../shared/markdown-sections.mjs";
// Every other string this gather carries came off a row a worker had already
// put through the filter. An objection's sentence is Slack text Tom typed, so
// it goes through the one choke point the rest of Convex uses
// (convex/ttsMerge.ts, convex/ttsSearch.ts).
import { redactSecrets } from "../shared/redact.mjs";

export const WEEK_MS = 7 * DAY_MS;

// ── Event kinds this module reads and writes ─────────────────────────────────
// The nightly job's learning rows (phase 4's learning step writes all three;
// the digest's own constant is LEARNING_CHANGE, imported above). One spelling
// per kind, shared with worker/jobs/nightly.mjs by name.
export const LEARNING_REVERTED = "learning-reverted";
export const LEARNING_REVERT_FAILED = "learning-revert-failed";
/** The Friday job's own failure row (data { day, step, error }), the twin of
 * the nightly job's NIGHTLY_FAILURE. */
export const WEEKLY_FAILURE = "weekly-failure";
/** The Friday job's summary row (data { day, file, sessionId, ... }), keyed
 * on the day so a rerun finds it (GET /tts/weekly-run). */
export const WEEKLY_RUN = "weekly-run";
export const INSTRUCTIONS_LOADED = "instructions-loaded";
export { PRELUDE_DELIVERY } from "./ttsEvals";
export { AREA_REVIEWED };

/** The failure kinds the gather groups by job. "job-failed" carries the job
 * in its data; the others name theirs by kind. */
const FAILURE_KINDS: readonly string[] = [
  JOB_FAILED,
  NIGHTLY_FAILURE,
  WEEKLY_FAILURE,
  SLACK_FAILED,
  SLACK_REPLY_FAILED,
];

/** "Surfaced three times" — the digest's own "surfaced" rows, counted per todo
 * over the week. */
export const SURFACED_THRESHOLD = 3;

// ── The audit's own score, and how far back it reaches ───────────────────────
// It GATES NOTHING: it is arithmetic over rows the record already holds, and
// the merge gate reads none of it.
//
/** The audit's score reaches four weeks back while every other fact here
 * reaches seven days, and the reason is the shape of an objection: Tom objects
 * to a merge DAYS AFTER it lands, in the thread of the digest that listed it,
 * so a seven-day window would score the audit on merges whose objections had
 * not arrived yet and read every recent merge as unobjected. Four weeks is the
 * shortest window in which a merge's objection has had time to show up. */
export const AUDIT_OBJECTION_WEEKS = 4;
/** The word an audit answers when it refuses a head (convex/ttsMerge.ts reads
 * the word itself and only compares against AUDIT_APPROVED, so this spelling is
 * needed here and nowhere else). */
const AUDIT_REFUSED = "REFUSED";
/** How many rows of the audit's lists are kept, and how much of any one
 * string: a weekly fact is a report, not an archive, and the record still
 * holds the whole of them. */
const VERIFIER_LIST_MAX = 20;
const VERIFIER_TEXT_MAX_CHARS = 300;

// ── What counts as Tom touching an item ──────────────────────────────────────
// ONE HOME. "Surfaced three times and untouched" means Tom did nothing with
// the item — not that the system did nothing: the preparer's "prepared" row,
// the digest's own "surfaced", a Canvas or triage edit are all the system's hands, and a row of theirs must not clear the
// item off this list. These are the kinds only his hand writes: a status
// change, an edit of his, a note of his (Slack), a time note, a ruling in his
// words, a Slack turn of his, and a date outcome he recorded.
export const TOM_TOUCH_KINDS: ReadonlySet<string> = new Set([
  "status-changed",
  "updated",
  "tom-note",
  "time-note",
  "ruling",
  "slack-event",
  "date-outcome",
]);
/** The `via` values a system writer stamps on an "updated" row (tts.ts
 * triage, ttsCanvas.ts); an "updated" row of Tom's carries none, and the
 * time-note actions are his. */
const SYSTEM_UPDATE_VIAS: ReadonlySet<string> = new Set(["triage", "canvas-sync"]);

export function isTomTouch(e: Pick<Doc<"dtsEvents">, "kind" | "data">): boolean {
  if (!TOM_TOUCH_KINDS.has(e.kind)) return false;
  const d = (e.data ?? {}) as Record<string, unknown>;
  // The 5 a.m. rollover writes "date-outcome" too (tts.recordMissedKeepingDate)
  // and marks itself; that row is the system noticing a date, not Tom.
  if (e.kind === "date-outcome" && d.rollover === true) return false;
  if (e.kind === "updated" && typeof d.via === "string" && SYSTEM_UPDATE_VIAS.has(d.via)) return false;
  return true;
}

// ── The facts ────────────────────────────────────────────────────────────────
// Structural types, not Docs: the job's renderer and the tests read literals.
type WeeklyFacts = {
  since: number;
  until: number;
  completions: { id: string; statement: string; kind: string | null; doneAt: number }[];
  captures: { source: string; count: number; items: { id: string; statement: string; createdAt: number }[] }[];
  dateOutcomes: {
    todoId: string;
    statement: string;
    outcome: string;
    at: number;
    newDueAt: number | null;
    note: string | null;
  }[];
  surfacedUntouched: { id: string; statement: string; surfaced: number; firstAt: number }[];
  goalsNotEvaluated: { id: string; statement: string; lastEvaluatedAt: number | null }[];
  integrations: {
    name: string;
    state: "running" | "waiting-on-credential" | "declined";
    // declined: the ruling's date and Tom's sentence; waiting: the failure.
    since: number | null;
    detail: string | null;
  }[];
  areaPages: {
    path: string;
    updatedOn: string | null;
    reviewedOn: string | null;
    windowDays: number | null;
    // Days since `reviewed:`; null when the page was never reviewed.
    reviewedAgeDays: number | null;
    pastWindow: boolean;
  }[];
  modelOfTom: {
    commit: string | null;
    syncedAt: number | null;
    layers: { name: "operate" | "write" | "know"; bytes: number }[];
    files: { path: string; bytes: number }[];
    totalBytes: number;
  };
  learning: {
    changes: number;
    reverted: number;
    revertFailed: number;
    lines: { kind: string; at: number; id: string | null; file: string | null; before: string | null; after: string | null; evidence: string | null; error: string | null }[];
  };
  preludes: {
    sessions: number;
    current: number;
    stale: { day: string; id: string; title: string; had: string | null; behindDays: number }[];
    missing: { day: string; id: string; title: string }[];
  };
  instructionsLoaded: {
    daysReported: number;
    sessions: number;
    files: { path: string; sessions: number }[];
    missingWikiTom: number;
    missingWikiTomSessions: { day: string; session: string }[];
    missingProjectAgents: { day: string; session: string; cwd: string }[];
  };
  /** Per eval set: the week's runs, and the newest run's passed and failed. */
  evals: { set: string; runs: number; passed: number; failed: number }[];
  // ── What the audit is worth, this week ─────────────────────────────────────
  // The key is always here, so the renderer (Jarvis worker/jobs/weekly.mjs)
  // has one thing to look for. REPORTS AND NEVER GATES: convex/ttsMerge.ts
  // reads none of it.
  verifiers: {
    /** The audit against Tom's later objections — computed here (below), not
     * read off a row: it is arithmetic over the event record and the record is
     * here. Null when there was nothing to score: a measurement nobody took has
     * no number, and a zero would read as one. */
    audit: {
      weeks: number;
      merges: number;
      objected: number;
      objections: { sha: string; approvedAt: number; objectedAt: number; sentence: string }[];
      landedAnyway: { sha: string; refusedAt: number; mergedAt: number }[];
    } | null;
  };
  jobFailures: { job: string; count: number; lines: { at: number; error: string }[] }[];
  threads: {
    todoId: string;
    statement: string;
    askedAt: number;
    repliedAt: number | null;
    replyMs: number | null;
  }[];
  readiness: { prepared: number; unprepared: number };
};

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A string off a row, redacted and capped, or null when it is not a string.
 * REDACTED FIRST, THEN CAPPED, the order convex/ttsMerge.ts uses: a cap applied
 * first can cut a credential in half and leave the half that still matches
 * nothing. */
function verifierText(value: unknown): string | null {
  const s = str(value);
  return s === null ? null : redactSecrets(s).slice(0, VERIFIER_TEXT_MAX_CHARS);
}


/** YYYY-MM-DD from a frontmatter value, or null when it is not one — a real
 * day, round-tripped by isIsoDay, so "2026-02-30" is not one. */
export function frontmatterDate(value: string | undefined): string | null {
  const s = (value ?? "").trim();
  return isIsoDay(s) ? s : null;
}

/**
 * One area page's review state from the body the nightly job posted (the
 * frontmatter block rides ahead of the sections), overridden by a newer
 * "area-reviewed" event when the weekly session confirmed the page after the
 * post. Pure, so the tests can pin it.
 */
export function areaPageState(
  path: string,
  body: string,
  reviewedEvent: string | null,
  until: number,
): WeeklyFacts["areaPages"][number] {
  // The shared parser is plain ESM (no types cross the worker boundary).
  const fields = parseFrontmatter(body).fields as Record<string, string | undefined>;
  const updatedOn = frontmatterDate(fields.updated);
  let reviewedOn = frontmatterDate(fields.reviewed);
  if (reviewedEvent !== null && (reviewedOn === null || reviewedEvent > reviewedOn)) {
    reviewedOn = reviewedEvent;
  }
  const windowRaw = Number(fields.window_days);
  const windowDays = Number.isInteger(windowRaw) && windowRaw > 0 ? windowRaw : null;
  const reviewedAgeDays =
    reviewedOn === null ? null : Math.floor((until - Date.parse(reviewedOn)) / DAY_MS);
  // Never reviewed is past every window; a page with no window is past none.
  const pastWindow =
    windowDays !== null && (reviewedAgeDays === null || reviewedAgeDays > windowDays);
  return { path, updatedOn, reviewedOn, windowDays, reviewedAgeDays, pastWindow };
}

/**
 * The standing credential failure of one job, or null: its "job-failed" rows
 * in the record's events table, read on by_kind_subject_at over the job's own
 * condition prefix (`<job>:` — every condition the job ever reported, and no
 * other job's), newest first within each condition, stopping at the first
 * credential condition whose newest failure has no "job-recovered" at or
 * after it. NO TAKE LIMIT, on purpose: a limit is a cap in the gather, and a
 * standing failure older than a cap's worth of other rows would vanish behind
 * it. The read is bounded by the job's own failures (convex/jarvis/jobs.ts).
 */
async function standingCredentialFailure(
  ctx: QueryCtx,
  job: string,
): Promise<{ key: string; at: number; error: string } | null> {
  const prefix = `${job}:`;
  const seen = new Set<string>();
  for await (const f of ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) =>
      q.eq("kind", JOB_FAILED).gte("subject", prefix).lt("subject", `${prefix}\uffff`),
    )
    .order("desc")) {
    // Descending on (subject, at): the first row seen under a condition is
    // its newest failure, and the older ones under it say nothing more.
    const key = f.subject;
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    if (!isCredentialKey(key)) continue;
    const recovered = await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", JOB_RECOVERED).eq("subject", key))
      .order("desc")
      .first();
    if (recovered !== null && recovered.at >= f.at) continue;
    const d = (f.data ?? {}) as Record<string, unknown>;
    return { key, at: f.at, error: str(d.error) ?? "" };
  }
  return null;
}

/** The event kinds that mean a worker evaluated a goal: a session opened on
 * it, or a session's recorded outcome for it. */
const EVALUATION_KINDS = ["session-created", "session-outcome"] as const;

/**
 * When a goal was last evaluated, or null when never: the newest evaluation
 * row on the goal's own id (by_todo, newest first, stopped at the first hit
 * rather than collecting its history), or the newest outcome the box's work
 * queue posted on it (the record's events table, the goal's plain id as
 * subject: convex/jarvis/events.ts), whichever is later.
 */
async function lastGoalEvaluation(
  ctx: QueryCtx,
  goal: Doc<"todos">,
  until: number,
): Promise<number | null> {
  let last: number | null = null;
  // The session rows name the goal by either id (convex/jarvis/tables.ts):
  // each form read newest first, stopped at its first hit.
  for (const form of await todoIdForms(ctx, goal._id)) {
    for await (const e of ctx.db
      .query("dtsEvents")
      .withIndex("by_todo", (q) => q.eq("todoId", form).lt("at", until))
      .order("desc")) {
      if ((EVALUATION_KINDS as readonly string[]).includes(e.kind)) {
        if (last === null || e.at > last) last = e.at;
        break;
      }
    }
  }
  const worked = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", SESSION_OUTCOME).eq("subject", goal._id).lt("at", until))
    .order("desc")
    .first();
  return worked !== null && (last === null || worked.at > last) ? worked.at : last;
}

export async function gatherWeeklyFacts(
  ctx: QueryCtx,
  { since, until }: { since: number; until: number },
): Promise<WeeklyFacts> {
  // A todo by an id in either form (the events name the old one); the row,
  // and so every id this gather hands out, is the plain one.
  const todoOf = todoReader(ctx);
  const eventsOfKind = async (kind: string) =>
    await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since).lt("at", until))
      .collect();
  // The same read with its own start. ONE FACT NEEDS A WIDER WINDOW than the
  // week (the audit's score, below) and every other needs exactly the week, so
  // this is a second helper rather than a widened first one: widening
  // eventsOfKind would quietly move every fact in this gather.
  const eventsOfKindSince = async (kind: string, from: number) =>
    await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", from).lt("at", until))
      .collect();

  // 1. Completions: done rows touched in the window (the status index orders
  // by updatedAt, and a completion bumps it), kept where doneAt is inside.
  const completions: WeeklyFacts["completions"] = [];
  for (const t of await ctx.db
    .query("todos")
    .withIndex("by_status", (q) => q.eq("status", "done").gte("updatedAt", since))
    .collect()) {
    const doneAt = t.doneAt ?? t.updatedAt;
    if (doneAt < since || doneAt >= until) continue;
    completions.push({
      id: t._id,
      statement: t.statement,
      kind: t.kind ?? null,
      doneAt,
    });
  }
  completions.sort((a, b) => a.doneAt - b.doneAt);

  // 2. Captures by source: every row created in the window, oldest first.
  // By createdAt: a plain row the copy made (convex/jarvis/tables.ts) has the
  // copy's _creationTime, so the creation-time range finds every row written
  // since the copy, and a row created in the window before it is on
  // by_updatedAt from `since` (updated no earlier than it was created).
  const created = new Map<string, Doc<"todos">>();
  for (const t of [
    ...(await ctx.db
      .query("todos")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since).lt("_creationTime", until))
      .collect()),
    ...(await ctx.db
      .query("todos")
      .withIndex("by_updatedAt", (q) => q.gte("updatedAt", since))
      .collect()),
  ]) {
    if (t.createdAt >= since && t.createdAt < until) created.set(t._id, t);
  }
  const bySource = new Map<string, WeeklyFacts["captures"][number]>();
  for (const t of [...created.values()].sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime)) {
    const entry = bySource.get(t.source) ?? { source: t.source, count: 0, items: [] };
    entry.count++;
    entry.items.push({ id: t._id, statement: t.statement, createdAt: t.createdAt });
    bySource.set(t.source, entry);
  }
  const captures = [...bySource.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );

  // 3. Every date outcome — done, renegotiated, missed (the rollover's
  // included; it writes the same kind).
  const dateOutcomes: WeeklyFacts["dateOutcomes"] = [];
  for (const e of await eventsOfKind("date-outcome")) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    // A todo reference naming no row names no todo (convex/jarvis/tables.ts).
    const todo = await todoOf(e.todoId);
    if (todo === null) continue;
    dateOutcomes.push({
      todoId: todo._id,
      statement: todo.statement,
      outcome: str(d.outcome) ?? "",
      at: e.at,
      newDueAt: num(d.newDueAt),
      note: str(d.note),
    });
  }

  // 4. Surfaced three times and untouched: the digest's "surfaced" rows per
  // todo; touched = a later row on that todo of a kind Tom's own hand writes
  // (TOM_TOUCH_KINDS above) — the system's rows on it do not count.
  // Keyed by the plain id: a todo's rows name it in either form.
  // A todo reference naming no row names no todo (convex/jarvis/tables.ts).
  const surfacings = new Map<string, { todo: Doc<"todos">; count: number; firstAt: number }>();
  for (const e of await eventsOfKind("surfaced")) {
    const todo = await todoOf(e.todoId);
    if (todo === null) continue;
    const s = surfacings.get(todo._id) ?? { todo, count: 0, firstAt: e.at };
    s.count++;
    s.firstAt = Math.min(s.firstAt, e.at);
    surfacings.set(todo._id, s);
  }
  const surfacedUntouched: WeeklyFacts["surfacedUntouched"] = [];
  for (const { todo, ...s } of surfacings.values()) {
    if (s.count < SURFACED_THRESHOLD) continue;
    const later = await todoEvents(ctx, todo._id, s.firstAt);
    if (later.some(isTomTouch)) continue;
    surfacedUntouched.push({
      id: todo._id,
      statement: todo.statement,
      surfaced: s.count,
      firstAt: s.firstAt,
    });
  }
  surfacedUntouched.sort((a, b) => b.surfaced - a.surfaced || a.firstAt - b.firstAt);

  // 6, 13: the active set, read once.
  const active = await ctx.db
    .query("todos")
    .withIndex("by_status", (q) => q.eq("status", "active"))
    .collect();
  const goalsNotEvaluated: WeeklyFacts["goalsNotEvaluated"] = [];
  for (const t of active) {
    if (t.kind !== "goal") continue;
    // Evaluated = a session opened on the goal, or one that recorded an
    // outcome for it, in the last seven days (both rows are on by_todo).
    const lastEvaluatedAt = await lastGoalEvaluation(ctx, t, until);
    if (lastEvaluatedAt !== null && lastEvaluatedAt >= until - WEEK_MS) continue;
    goalsNotEvaluated.push({ id: t._id, statement: t.statement, lastEvaluatedAt });
  }
  let prepared = 0;
  let unprepared = 0;
  for (const t of active) {
    if (isPrepared(t.readiness)) prepared++;
    else unprepared++;
  }

  // 7. Integrations by state. Declined: an archived "integration: <name>"
  // todo with the archive ruling newest (ttsIntegrations). Waiting on a
  // credential: the job's standing "job-failed" row — reported and not
  // recovered since — whose key names a credential condition, read per job
  // on its own key prefix (standingCredentialFailure). Otherwise running.
  const declined = await declinedIntegrations(ctx);
  const integrations: WeeklyFacts["integrations"] = [];
  const named = new Set<string>();
  for (const i of INTEGRATIONS) {
    named.add(i.name);
    const ruling = declined.find((d) => d.name === i.name);
    if (ruling !== undefined) {
      integrations.push({ name: i.name, state: "declined", since: ruling.ruledAt, detail: ruling.sentence });
      continue;
    }
    const waiting = await standingCredentialFailure(ctx, i.job);
    if (waiting !== null) {
      integrations.push({
        name: i.name,
        state: "waiting-on-credential",
        since: waiting.at,
        detail: waiting.error || waiting.key,
      });
      continue;
    }
    integrations.push({ name: i.name, state: "running", since: null, detail: null });
  }
  // A declined name outside the list is still Tom's ruling and is listed.
  for (const d of declined) {
    if (named.has(d.name)) continue;
    integrations.push({ name: d.name, state: "declined", since: d.ruledAt, detail: d.sentence });
  }

  // 8, 9. The area pages and the size of the model-of-tom files, from the
  // rows the nightly job posted (a small table: one row per file).
  const modelOfTomFiles = await ctx.db.query("modelOfTomFiles").collect();
  const files: WeeklyFacts["modelOfTom"]["files"] = [];
  const areaPages: WeeklyFacts["areaPages"] = [];
  const publication = await ctx.db.query("modelOfTomPublication")
    .withIndex("by_key", (q) => q.eq("key", "current")).unique();
  const layers: WeeklyFacts["modelOfTom"]["layers"] = [];
    for (const name of MODEL_OF_TOM_LAYER_NAMES) {
    const body = publication?.[name];
    if (typeof body === "string") {
      layers.push({ name, bytes: new TextEncoder().encode(body).length });
    }
  }
  for (const row of [...modelOfTomFiles].sort((a, b) =>
    a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0,
  )) {
    if (!isModelOfTomPath(row.sourcePath)) continue;
    files.push({ path: row.sourcePath, bytes: row.bytes ?? new TextEncoder().encode(row.body).length });
    if (!row.sourcePath.startsWith(`${MODEL_OF_TOM_AREAS_DIR}/`)) continue;
    const reviewed = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", AREA_REVIEWED).eq("key", row.sourcePath))
      .order("desc")
      .first();
    const reviewedEvent = frontmatterDate(
      str((reviewed?.data as Record<string, unknown> | undefined)?.reviewedOn) ?? undefined,
    );
    areaPages.push(areaPageState(row.sourcePath, row.body, reviewedEvent, until));
  }
  const modelOfTom = {
    commit: publication?.commit ?? null,
    syncedAt: publication?.committedAt ?? null,
    layers,
    files,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  };

  // 10. What the nightly job wrote, reverted, and failed to revert.
  const learning: WeeklyFacts["learning"] = { changes: 0, reverted: 0, revertFailed: 0, lines: [] };
  for (const kind of [LEARNING_CHANGE, LEARNING_REVERTED, LEARNING_REVERT_FAILED]) {
    for (const e of await eventsOfKind(kind)) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (kind === LEARNING_CHANGE) learning.changes++;
      else if (kind === LEARNING_REVERTED) learning.reverted++;
      else learning.revertFailed++;
      learning.lines.push({
        kind,
        at: e.at,
        id: str(d.id),
        file: str(d.file),
        before: str(d.before),
        after: str(d.after),
        evidence: str(d.evidence),
        error: str(d.error),
      });
    }
  }
  learning.lines.sort((a, b) => a.at - b.at);

  // 11. Delivery evidence: each nightly row is an observation, so a rerun is
  // retained rather than deduped. The worker owns producing it; this gather
  // only totals and lists what it received.
  const preludes: WeeklyFacts["preludes"] = { sessions: 0, current: 0, stale: [], missing: [] };
  for (const e of await eventsOfKind(PRELUDE_DELIVERY)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const day = str(d.day) ?? "";
    const current = num(d.current) ?? 0;
    preludes.current += current;
    const stale = Array.isArray(d.stale) ? d.stale : [];
    const missing = Array.isArray(d.missing) ? d.missing : [];
    preludes.sessions += current + stale.length + missing.length;
    for (const raw of stale) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const id = str(row.id);
      const title = str(row.title);
      if (id === null || title === null) continue;
      preludes.stale.push({ day, id, title, had: str(row.had), behindDays: num(row.behindDays) ?? -1 });
    }
    for (const raw of missing) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const id = str(row.id);
      const title = str(row.title);
      if (id !== null && title !== null) preludes.missing.push({ day, id, title });
    }
  }
  preludes.stale.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  preludes.missing.sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));

  const instructionFiles = new Map<string, number>();
  const instructionsLoaded: WeeklyFacts["instructionsLoaded"] = {
    daysReported: 0,
    sessions: 0,
    files: [],
    missingWikiTom: 0,
    missingWikiTomSessions: [],
    missingProjectAgents: [],
  };
  const reportedDays = new Set<string>();
  for (const e of await eventsOfKind(INSTRUCTIONS_LOADED)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const day = str(d.day) ?? "";
    if (day !== "") reportedDays.add(day);
    instructionsLoaded.sessions += num(d.sessions) ?? 0;
    for (const raw of Array.isArray(d.files) ? d.files : []) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const file = str(row.path);
      if (file !== null) instructionFiles.set(file, (instructionFiles.get(file) ?? 0) + (num(row.sessions) ?? 0));
    }
    for (const raw of Array.isArray(d.missingWikiTom) ? d.missingWikiTom : []) {
      const session = str(raw);
      if (session !== null) instructionsLoaded.missingWikiTomSessions.push({ day, session });
    }
    for (const raw of Array.isArray(d.missingProjectAgents) ? d.missingProjectAgents : []) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const session = str(row.session);
      const cwd = str(row.cwd);
      if (session !== null && cwd !== null) instructionsLoaded.missingProjectAgents.push({ day, session, cwd });
    }
  }
  instructionsLoaded.daysReported = reportedDays.size;
  instructionsLoaded.missingWikiTom = instructionsLoaded.missingWikiTomSessions.length;
  instructionsLoaded.files = [...instructionFiles.entries()]
    .map(([path, sessions]) => ({ path, sessions }))
    .sort((a, b) => a.path.localeCompare(b.path));
  instructionsLoaded.missingWikiTomSessions.sort((a, b) => a.day.localeCompare(b.day) || a.session.localeCompare(b.session));
  instructionsLoaded.missingProjectAgents.sort((a, b) => a.day.localeCompare(b.day) || a.session.localeCompare(b.session));

  // The evals (Jarvis worker/jobs/evals.mjs): one eval-run event per set per
  // run, in the record's events table, its subject the set. A candidate run's
  // subject names the candidate too, so it is counted apart from the set's own
  // runs; the record refuses an eval-run with no subject (shared/
  // jarvis-events.mjs SUBJECT_REQUIRED). Read newest first, so the first row
  // of a subject is its newest run.
  const evalSets = new Map<string, WeeklyFacts["evals"][number]>();
  for (const e of await ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", EVAL_RUN).gte("at", since).lt("at", until))
    .order("desc")
    .collect()) {
    const set = e.subject as string;
    const held = evalSets.get(set);
    if (held !== undefined) {
      held.runs++;
      continue;
    }
    const d = (e.data ?? {}) as Record<string, unknown>;
    evalSets.set(set, { set, runs: 1, passed: num(d.passed) ?? 0, failed: num(d.failed) ?? 0 });
  }
  const evals = [...evalSets.values()].sort((a, b) => a.set.localeCompare(b.set));

  // ── The audit, scored against Tom's later objections ──────────────────────
  // THE AUDIT IS CHECKED BY EXACTLY ONE THING: whether what it let through
  // turned out to be what he wanted. That is its only score, and everything
  // below is that one question asked arithmetically.
  //
  // COMPUTED HERE AND NOT IN THE RUNNER, because it is pure arithmetic over the
  // event record and the record is here: three kinds already written, read on
  // the index they are already on, joined on the keys they are already keyed by
  // (convex/ttsMerge.ts commitKey and mergeKey). No new row, no new field.
  //
  // A merge is listed on the digest's objection list with its own mergeKey as
  // the askId (internalRecordMerge), and "revert <n>" on that line is recorded
  // with the same askId (convex/ttsAsk.ts internalRecordDelegateObjection) — so an
  // objection whose askId equals a merge's key IS his objection to that merge.
  const auditSince = until - AUDIT_OBJECTION_WEEKS * WEEK_MS;
  const approvedAt = new Map<string, number>();
  const refusedAt = new Map<string, { at: number; sha: string }>();
  for (const e of await eventsOfKindSince(AUDIT_VERDICT, auditSince)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const repo = str(d.repo);
    const sha = str(d.sha);
    if (repo === null || sha === null) continue;
    const key = commitKey(repo, sha);
    const verdict = (str(d.verdict) ?? "").toUpperCase();
    // Newest wins on each side: an UNAVAILABLE row can be replaced by a real
    // verdict later (internalRecordAudit), and the real one is the audit.
    if (verdict === AUDIT_APPROVED) {
      if (e.at > (approvedAt.get(key) ?? -1)) approvedAt.set(key, e.at);
    } else if (verdict === AUDIT_REFUSED) {
      if (e.at > (refusedAt.get(key)?.at ?? -1)) refusedAt.set(key, { at: e.at, sha });
    }
  }
  const objectedAt = new Map<string, { at: number; sentence: string }>();
  for (const e of await eventsOfKindSince(DELEGATE_OBJECTION, auditSince)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const askId = str(d.askId);
    if (askId === null) continue;
    // The FIRST objection in the thread is his objection; a later one in the
    // same thread is the same objection continuing.
    const held = objectedAt.get(askId);
    if (held !== undefined && held.at <= e.at) continue;
    const sentence = verifierText(d.sentence) ?? "";
    objectedAt.set(askId, { at: e.at, sentence: sentence.split("\n")[0] ?? "" });
  }
  const auditedMerges: NonNullable<WeeklyFacts["verifiers"]["audit"]>["objections"] = [];
  const mergedAt = new Map<string, number>();
  let auditedCount = 0;
  for (const e of await eventsOfKindSince(MERGE, auditSince)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const repo = str(d.repo);
    const sha = str(d.sha);
    if (repo === null || sha === null) continue;
    const commit = commitKey(repo, sha);
    if (e.at > (mergedAt.get(commit) ?? -1)) mergedAt.set(commit, e.at);
    const approved = approvedAt.get(commit);
    // An unaudited merge is not the audit's to answer for.
    if (approved === undefined) continue;
    auditedCount++;
    const objection = objectedAt.get(mergeKey(repo, sha));
    if (objection === undefined) continue;
    auditedMerges.push({
      sha: sha.slice(0, 7),
      approvedAt: approved,
      objectedAt: objection.at,
      sentence: objection.sentence,
    });
  }
  auditedMerges.sort((a, b) => a.objectedAt - b.objectedAt);
  // THE OTHER DIRECTION IS AN INTERPRETATION, and stated as one. The brief asks
  // for "audits that REFUSED a head the record shows he later said should have
  // landed", and the record's only deterministic signal that a head landed is a
  // "merge" row at that commit. There is no row in which he says a refusal was
  // wrong, and inventing one — a sentiment read, a model's guess — would be a
  // measure nobody can check. So this is exactly: refused, and merged anyway.
  const landedAnyway: NonNullable<WeeklyFacts["verifiers"]["audit"]>["landedAnyway"] = [];
  for (const [commit, refused] of refusedAt) {
    const merged = mergedAt.get(commit);
    if (merged === undefined) continue;
    landedAnyway.push({ sha: refused.sha.slice(0, 7), refusedAt: refused.at, mergedAt: merged });
  }
  landedAnyway.sort((a, b) => a.mergedAt - b.mergedAt);
  // NULL WHEN THERE IS NOTHING TO SCORE. A window with no audited merge in it
  // renders no line at all, rather than a line saying zero of zero.
  const verifierAudit: WeeklyFacts["verifiers"]["audit"] =
    auditedCount === 0
      ? null
      : {
          weeks: AUDIT_OBJECTION_WEEKS,
          merges: auditedCount,
          objected: auditedMerges.length,
          objections: auditedMerges.slice(0, VERIFIER_LIST_MAX),
          landedAnyway: landedAnyway.slice(0, VERIFIER_LIST_MAX),
        };

  // 12. Job failures by job.
  const byJob = new Map<string, WeeklyFacts["jobFailures"][number]>();
  for (const kind of FAILURE_KINDS) {
    // A job's failures live in the record's events table (convex/jarvis/jobs.ts
    // failuresInWindow: the reports, not a standing condition's repeats); the
    // other failure kinds still in dtsEvents.
    const rows =
      kind === JOB_FAILED ? (await failuresInWindow(ctx, since, until)).failed : await eventsOfKind(kind);
    for (const e of rows) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const job =
        kind === JOB_FAILED
          ? (str(d.job) ?? "job")
          : kind === NIGHTLY_FAILURE
            ? "nightly"
            : kind === WEEKLY_FAILURE
              ? "weekly"
              : "slack";
      const entry = byJob.get(job) ?? { job, count: 0, lines: [] };
      entry.count++;
      entry.lines.push({
        at: e.at,
        error: `${kind === JOB_FAILED ? "" : `${kind}: `}${str(d.error) ?? ""}`.trim(),
      });
      byJob.set(job, entry);
    }
  }
  const jobFailures = [...byJob.values()].sort((a, b) =>
    a.job < b.job ? -1 : a.job > b.job ? 1 : 0,
  );
  for (const f of jobFailures) f.lines.sort((a, b) => a.at - b.at);

  // 12. Threads that needed Tom this week and his reply time on each: the
  // "needs-tom" rows, and for each the first reply of his after it. The
  // spec's own check against the system becoming controlling (principle 8):
  // reported as a duration, never as a judgement.
  const threads: WeeklyFacts["threads"] = [];
  for (const e of await eventsOfKind(NEEDS_TOM)) {
    // A todo reference naming no row names no todo (convex/jarvis/tables.ts).
    const todo = await todoOf(e.todoId);
    if (todo === null) continue;
    const later = await todoEvents(ctx, todo._id, e.at);
    // The slack-event branch cannot be deleted yet because answers given
    // before the thread exist only as slack-event rows, until the change that
    // deletes the Slack reply route (POST /slack/events) retires this reader.
    const slackReply = later.find((r) => r.kind === "slack-event");
    const threadReply = e.key === undefined ? null : await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) =>
        q.eq("kind", NEEDS_TOM_ANSWERED).eq("subject", e.key).gte("at", e.at))
      .first();
    const repliedAt = Math.min(slackReply?.at ?? Infinity, threadReply?.at ?? Infinity);
    threads.push({
      todoId: todo._id,
      statement: todo.statement,
      askedAt: e.at,
      repliedAt: Number.isFinite(repliedAt) ? repliedAt : null,
      replyMs: Number.isFinite(repliedAt) ? repliedAt - e.at : null,
    });
  }

  return {
    since,
    until,
    completions,
    captures,
    dateOutcomes,
    surfacedUntouched,
    goalsNotEvaluated,
    integrations,
    areaPages,
    modelOfTom,
    learning,
    preludes,
    instructionsLoaded,
    evals,
    verifiers: { audit: verifierAudit },
    jobFailures,
    threads,
    readiness: { prepared, unprepared },
  };
}

// GET /tts/weekly-input?until=<epoch ms> — the seven days ending at `until`.
export const internalWeeklyInput = internalQuery({
  args: { until: v.number() },
  handler: async (ctx, { until }) =>
    await gatherWeeklyFacts(ctx, { since: until - WEEK_MS, until }),
});

// GET /tts/weekly-run?day= — the newest "weekly-run" row for that day, or
// null. What the job reads before it writes: a day that already has a run
// is not run again without --overwrite.
export const internalWeeklyRun = internalQuery({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    if (!isIsoDay(day)) throw new Error(`day must be a YYYY-MM-DD date, got: ${day}`);
    const row = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", WEEKLY_RUN).eq("key", day))
      .order("desc")
      .first();
    if (row === null) return null;
    const d = (row.data ?? {}) as Record<string, unknown>;
    return {
      at: row.at,
      file: str(d.file),
      sessionId: str(d.sessionId),
      failures: Array.isArray(d.failures) ? d.failures.length : 0,
    };
  },
});

// ── POST /tts/area-reviewed ──────────────────────────────────────────────────
// The record that Tom confirmed an area page in the weekly session: one
// "area-reviewed" row keyed on the page's path. The page's own `reviewed:`
// line is the session's edit in the checkout (worker/jobs/weekly.mjs
// reviewed, through the nightly job's locked helper); this row is what lets
// the digest report the review the next morning and the gather count it
// before the nightly post carries the edited frontmatter here. It writes
// nothing to a todo and nothing to the page.
export const internalRecordAreaReviewed = internalMutation({
  args: { path: v.string(), reviewedOn: v.string() },
  handler: async (ctx, { path, reviewedOn }) => {
    if (!isModelOfTomPath(path) || !path.startsWith(`${MODEL_OF_TOM_AREAS_DIR}/`)) {
      throw new Error(`not an area page path: ${path}`);
    }
    if (frontmatterDate(reviewedOn) === null) {
      throw new Error(`reviewedOn must be a YYYY-MM-DD date, got: ${reviewedOn}`);
    }
    return await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: AREA_REVIEWED,
      key: path,
      data: { path, reviewedOn },
    });
  },
});
