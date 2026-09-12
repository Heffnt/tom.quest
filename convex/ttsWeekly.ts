// The weekly session's server half (the lifeos update, phase 8; spec §11).
//
// ONE DETERMINISTIC GATHER, NO MODEL IN THE LOOP. The Friday job on the Jarvis
// Box (worker/jobs/weekly.mjs) asks GET /tts/weekly-input for the seven days
// ending now, and everything below is a query on an index: what was completed,
// what was captured and from where, every date outcome, the items surfaced
// three times and never touched, the goals with no open task, the goals no
// worker has evaluated in seven days, the integrations by state, each area
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
// serves four facts.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { AREA_REVIEWED, LEARNING_CHANGE, SLACK_FAILED } from "./ttsDigest";
import {
  INTEGRATIONS,
  declinedIntegrations,
  isCredentialKey,
} from "./ttsIntegrations";
import { JOB_FAILED, JOB_RECOVERED } from "./ttsJobs";
import { NIGHTLY_FAILURE } from "./ttsNightly";
import { NEEDS_TOM, SLACK_REPLY_FAILED } from "./ttsSlack";
import { DAY_MS, MODEL_OF_TOM_AREAS_DIR, isPrepared } from "./ttsShared";
import { isModelOfTomPath, MODEL_OF_TOM_LAYER_NAMES } from "./ttsSkills";
import { EVALS_RUN, PRELUDE_DELIVERY } from "./ttsEvals";
import { isIsoDay, parseFrontmatter } from "../worker/jobs/markdown-sections.mjs";

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
export { PRELUDE_DELIVERY, EVALS_RUN } from "./ttsEvals";
export { AREA_REVIEWED };

/** The failure kinds the gather groups by job. "job-failed" carries the job
 * in its data; the others name theirs by kind. */
export const FAILURE_KINDS: readonly string[] = [
  JOB_FAILED,
  NIGHTLY_FAILURE,
  WEEKLY_FAILURE,
  SLACK_FAILED,
  SLACK_REPLY_FAILED,
];

/** "Surfaced three times" — the digest's own "surfaced" rows, counted per todo
 * over the week. */
export const SURFACED_THRESHOLD = 3;

// ── The ablation rule, kept in step with the runner ───────────────────────────
// THE OTHER HOME IS worker/jobs/evals.mjs (MIN_ABLATION_CASES and
// ablationFindings). One rule, two spellings, and that is a deliberate cost
// rather than an oversight: that file imports node:child_process to drive git
// and the model, and a Convex query that imported it would not bundle at all.
// The constant and the formula below are copied from it verbatim; a change to
// either belongs in both files in one commit.
//
/** One name's ablation over the week's set. `earned` is the finding itself:
 * false means the set passed more often WITHOUT the name than with it. */
export type AblationFinding = {
  name: string;
  cases: number;
  withPass: number;
  withoutPass: number;
  earned: boolean;
};

// How many cases a name needs behind it before its ablation is worth reading.
// Below this the comparison is noise, and a removal proposal resting on two
// cases is exactly the confident-and-wrong simplification this whole layer is
// written against.
export const MIN_ABLATION_CASES = 5;

/**
 * Which names did not earn their tokens, computed over the WEEKLY SET and
 * never per case: a name that one case passes without is a coin toss, and the
 * question is whether the name is carrying its cases at all.
 *
 * REPORTED, NEVER GATED. The golden set is mined out of Tom's rulings rather
 * than designed for coverage, so a name whose cases pass without it may still
 * be preventing a failure mode the set does not contain. This says what the
 * set shows; what to remove is his.
 */
export function ablationFindings(
  ablation: readonly unknown[],
): AblationFinding[] {
  const byName = new Map<string, AblationFinding>();
  for (const raw of ablation) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const name = str(row.name);
    if (name === null) continue;
    const entry = byName.get(name) ?? { name, cases: 0, withPass: 0, withoutPass: 0, earned: false };
    entry.cases += 1;
    if (row.withPass === true) entry.withPass += 1;
    if (row.withoutPass === true) entry.withoutPass += 1;
    byName.set(name, entry);
  }
  return [...byName.values()]
    .filter((entry) => entry.cases >= MIN_ABLATION_CASES)
    .map((entry) => ({ ...entry, earned: entry.withoutPass / entry.cases < entry.withPass / entry.cases }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── What counts as Tom touching an item ──────────────────────────────────────
// ONE HOME. "Surfaced three times and untouched" means Tom did nothing with
// the item — not that the system did nothing: the preparer's "prepared" row,
// the digest's own "surfaced", the planner's batch rows, a Canvas or triage
// edit are all the system's hands, and a row of theirs must not clear the
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
export type WeeklyFacts = {
  since: number;
  until: number;
  completions: { id: string; statement: string; kind: string | null; batch: string | null; doneAt: number }[];
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
  goalsWithoutOpenTask: { id: string; statement: string; batch: string | null }[];
  goalsNotEvaluated: { id: string; statement: string; batch: string | null; lastEvaluatedAt: number | null }[];
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
  evals: {
    runs: number;
    clean: number;
    regressions: { day: string; repo: string; sha: string; pass: number; items: number; failure: { id: string; partition: string } | null }[];
  };
  // ── The two evals facts that live on the run row ───────────────────────────
  // ABSENT IS ABSENT, NEVER ZERO. Both are read off an "evals-run" row, and a
  // row written before phase 7 carries neither — the same posture the runner
  // takes with `regressions: null` (worker/jobs/evals.mjs stampAgainstBase): a
  // run that was never asked the question has no answer to it, and a zero here
  // would read as "the arm ran and found nothing".
  //
  // The THIRD new evals fact, the golden set itself, is NOT here. Graduation is
  // a file rewrite in evals/golden/** (scripts/graduate-golden.mjs) that never
  // reaches Convex, and this gather has no filesystem — so the weekly job reads
  // it off the tom.quest checkout and puts it on the facts it renders, the way
  // it already reads last week's agenda out of the WikiTom checkout
  // (worker/jobs/weekly.mjs readGoldenSet).
  /** The names whose ablation the week's run scored, one entry per name with
   * at least MIN_ABLATION_CASES cases behind it; null when no run row in the
   * window carried an ablation arm at all. */
  ablation: AblationFinding[] | null;
  /** The cases that cost more tokens at head than at base; null when no run
   * row in the window carried the comparison. */
  efficiency: { rises: { id: string; headTokens: number; baseTokens: number }[] } | null;
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
 * read on by_kind_key over the job's own key prefix (`<job>:` — every keyed
 * condition the job ever reported, and no other job's), newest first within
 * each key, stopping at the first credential key whose newest failure has no
 * "job-recovered" at or after it. NO TAKE LIMIT, on purpose: a limit is a cap
 * in the gather, and a standing failure older than a cap's worth of other
 * rows would vanish behind it. The read is bounded by the job's own keyed
 * failures, which are one row per condition per occurrence (convex/ttsJobs.ts).
 */
async function standingCredentialFailure(
  ctx: QueryCtx,
  job: string,
): Promise<{ key: string; at: number; error: string } | null> {
  const prefix = `${job}:`;
  const seen = new Set<string>();
  for await (const f of ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) =>
      q.eq("kind", JOB_FAILED).gte("key", prefix).lt("key", `${prefix}\uffff`),
    )
    .order("desc")) {
    // Descending on (key, at): the first row seen under a key is that key's
    // newest failure, and the older ones under it say nothing more.
    if (f.key === undefined || seen.has(f.key)) continue;
    seen.add(f.key);
    if (!isCredentialKey(f.key)) continue;
    const recovered = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", JOB_RECOVERED).eq("key", f.key))
      .order("desc")
      .first();
    if (recovered !== null && recovered.at >= f.at) continue;
    const d = (f.data ?? {}) as Record<string, unknown>;
    return { key: f.key, at: f.at, error: str(d.error) ?? "" };
  }
  return null;
}

/** The event kinds that mean a worker evaluated a goal: a session opened on
 * it (or on its batch), or a session's recorded outcome for it. */
const EVALUATION_KINDS = ["session-created", "session-outcome"] as const;

/**
 * When a goal was last evaluated, or null when never: the newest evaluation
 * row on the goal's own id (by_todo, newest first, stopped at the first hit
 * rather than collecting its history) and the newest on its batch's id
 * (by_kind_key per kind, `.first()`), whichever is later.
 */
async function lastGoalEvaluation(
  ctx: QueryCtx,
  goal: Doc<"dtsTodos">,
  until: number,
): Promise<number | null> {
  let last: number | null = null;
  for await (const e of ctx.db
    .query("dtsEvents")
    .withIndex("by_todo", (q) => q.eq("todoId", goal._id).lt("at", until))
    .order("desc")) {
    if ((EVALUATION_KINDS as readonly string[]).includes(e.kind)) {
      last = e.at;
      break;
    }
  }
  if (goal.batchId !== undefined) {
    for (const kind of EVALUATION_KINDS) {
      const row = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", goal.batchId).lt("at", until))
        .order("desc")
        .first();
      if (row !== null && (last === null || row.at > last)) last = row.at;
    }
  }
  return last;
}

export async function gatherWeeklyFacts(
  ctx: QueryCtx,
  { since, until }: { since: number; until: number },
): Promise<WeeklyFacts> {
  const todoCache = new Map<string, Doc<"dtsTodos"> | null>();
  const todoOf = async (id: Id<"dtsTodos"> | undefined) => {
    if (id === undefined) return null;
    const hit = todoCache.get(id);
    if (hit !== undefined) return hit;
    const row = await ctx.db.get(id);
    todoCache.set(id, row);
    return row;
  };
  const batchCache = new Map<string, string | null>();
  const batchName = async (id: Id<"batches"> | undefined) => {
    if (id === undefined) return null;
    const hit = batchCache.get(id);
    if (hit !== undefined) return hit;
    const name = (await ctx.db.get(id))?.statement ?? null;
    batchCache.set(id, name);
    return name;
  };
  const eventsOfKind = async (kind: string) =>
    await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", since).lt("at", until))
      .collect();

  // 1. Completions: done rows touched in the window (the status index orders
  // by updatedAt, and a completion bumps it), kept where doneAt is inside.
  const completions: WeeklyFacts["completions"] = [];
  for (const t of await ctx.db
    .query("dtsTodos")
    .withIndex("by_status", (q) => q.eq("status", "done").gte("updatedAt", since))
    .collect()) {
    const doneAt = t.doneAt ?? t.updatedAt;
    if (doneAt < since || doneAt >= until) continue;
    completions.push({
      id: t._id,
      statement: t.statement,
      kind: t.kind ?? null,
      batch: await batchName(t.batchId),
      doneAt,
    });
  }
  completions.sort((a, b) => a.doneAt - b.doneAt);

  // 2. Captures by source: every row created in the window.
  const bySource = new Map<string, WeeklyFacts["captures"][number]>();
  for (const t of await ctx.db
    .query("dtsTodos")
    .withIndex("by_creation_time", (q) =>
      q.gte("_creationTime", since).lt("_creationTime", until),
    )
    .collect()) {
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
    if (e.todoId === undefined) continue;
    dateOutcomes.push({
      todoId: e.todoId,
      statement: (await todoOf(e.todoId))?.statement ?? "",
      outcome: str(d.outcome) ?? "",
      at: e.at,
      newDueAt: num(d.newDueAt),
      note: str(d.note),
    });
  }

  // 4. Surfaced three times and untouched: the digest's "surfaced" rows per
  // todo; touched = a later row on that todo of a kind Tom's own hand writes
  // (TOM_TOUCH_KINDS above) — the system's rows on it do not count.
  const surfacings = new Map<Id<"dtsTodos">, { count: number; firstAt: number }>();
  for (const e of await eventsOfKind("surfaced")) {
    if (e.todoId === undefined) continue;
    const s = surfacings.get(e.todoId) ?? { count: 0, firstAt: e.at };
    s.count++;
    s.firstAt = Math.min(s.firstAt, e.at);
    surfacings.set(e.todoId, s);
  }
  const surfacedUntouched: WeeklyFacts["surfacedUntouched"] = [];
  for (const [todoId, s] of surfacings) {
    if (s.count < SURFACED_THRESHOLD) continue;
    const later = await ctx.db
      .query("dtsEvents")
      .withIndex("by_todo", (q) => q.eq("todoId", todoId).gte("at", s.firstAt))
      .collect();
    if (later.some(isTomTouch)) continue;
    const todo = await todoOf(todoId);
    surfacedUntouched.push({
      id: todoId,
      statement: todo?.statement ?? "",
      surfaced: s.count,
      firstAt: s.firstAt,
    });
  }
  surfacedUntouched.sort((a, b) => b.surfaced - a.surfaced || a.firstAt - b.firstAt);

  // 5, 6, 13: the active set, read once.
  const active = await ctx.db
    .query("dtsTodos")
    .withIndex("by_status", (q) => q.eq("status", "active"))
    .collect();
  const openTasksByBatch = new Set<string>();
  for (const t of active) {
    if (t.kind !== "goal" && t.batchId !== undefined) openTasksByBatch.add(t.batchId);
  }
  const goalsWithoutOpenTask: WeeklyFacts["goalsWithoutOpenTask"] = [];
  const goalsNotEvaluated: WeeklyFacts["goalsNotEvaluated"] = [];
  for (const t of active) {
    if (t.kind !== "goal") continue;
    const batch = await batchName(t.batchId);
    if (t.batchId !== undefined && !openTasksByBatch.has(t.batchId)) {
      goalsWithoutOpenTask.push({ id: t._id, statement: t.statement, batch });
    }
    // Evaluated = a session opened on the goal, or on its batch, or one that
    // recorded an outcome for either, in the last seven days. The goal's own
    // sessions are on by_todo; the batch's are keyed on the batch id
    // (claudeSessions.insertSession writes both kinds with key = batchId),
    // because a session opened ON a batch has no todoId at all.
    const lastEvaluatedAt = await lastGoalEvaluation(ctx, t, until);
    if (lastEvaluatedAt !== null && lastEvaluatedAt >= until - WEEK_MS) continue;
    goalsNotEvaluated.push({ id: t._id, statement: t.statement, batch, lastEvaluatedAt });
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
  //
  // modelOfTomFiles, NOT ttsSkills: the per-file source facts moved to their
  // own table in phase 6 when ttsSkills became the published skill catalog.
  // Same rows, same fields, same post — only the table name changed.
  const skills = await ctx.db.query("modelOfTomFiles").collect();
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
  for (const row of [...skills].sort((a, b) =>
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

  const evals: WeeklyFacts["evals"] = { runs: 0, clean: 0, regressions: [] };
  // ONE RUN'S ARM, NOT THE WEEK'S ROWS ADDED UP. The ablation arm and the
  // efficiency comparison are properties of a single run over a single set, so
  // the newest row that carries each is the one reported. Adding a week's runs
  // together would count one case once per run and could carry a name over
  // MIN_ABLATION_CASES on nothing but a rerun.
  let ablation: WeeklyFacts["ablation"] = null;
  let ablationAt = -1;
  let efficiency: WeeklyFacts["efficiency"] = null;
  let efficiencyAt = -1;
  for (const e of await eventsOfKind(EVALS_RUN)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    evals.runs++;
    if (Array.isArray(d.ablation) && e.at > ablationAt) {
      ablation = ablationFindings(d.ablation);
      ablationAt = e.at;
    }
    const eff = d.efficiency;
    if (eff !== null && typeof eff === "object" && Array.isArray((eff as Record<string, unknown>).rises) && e.at > efficiencyAt) {
      const rises: WeeklyFacts["efficiency"] = { rises: [] };
      for (const raw of (eff as Record<string, unknown>).rises as unknown[]) {
        if (raw === null || typeof raw !== "object") continue;
        const row = raw as Record<string, unknown>;
        const id = str(row.id);
        const headTokens = num(row.headTokens);
        const baseTokens = num(row.baseTokens);
        if (id === null || headTokens === null || baseTokens === null) continue;
        rises.rises.push({ id, headTokens, baseTokens });
      }
      rises.rises.sort((a, b) => a.id.localeCompare(b.id));
      efficiency = rises;
      efficiencyAt = e.at;
    }
    const regressions = num(d.regressions) ?? 0;
    if (regressions === 0) {
      evals.clean++;
      continue;
    }
    const failure = (Array.isArray(d.failures) ? d.failures : []).find((raw) =>
      raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).regression === true,
    ) as Record<string, unknown> | undefined;
    evals.regressions.push({
      day: str(d.day) ?? new Date(e.at).toISOString().slice(0, 10),
      repo: str(d.repo) ?? "",
      sha: str(d.sha) ?? "",
      pass: num(d.pass) ?? 0,
      items: num(d.items) ?? 0,
      failure: failure === undefined ? null : { id: str(failure.id) ?? "?", partition: str(failure.partition) ?? "?" },
    });
  }
  evals.regressions.sort((a, b) => a.day.localeCompare(b.day) || a.repo.localeCompare(b.repo));

  // 12. Job failures by job.
  const byJob = new Map<string, WeeklyFacts["jobFailures"][number]>();
  for (const kind of FAILURE_KINDS) {
    for (const e of await eventsOfKind(kind)) {
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
  // "needs-tom" rows, and for each the first Slack reply of his on that todo
  // after it (the events route writes "slack-event" with the todo's id). The
  // spec's own check against the system becoming controlling (principle 8):
  // reported as a duration, never as a judgement.
  const threads: WeeklyFacts["threads"] = [];
  for (const e of await eventsOfKind(NEEDS_TOM)) {
    if (e.todoId === undefined) continue;
    const later = await ctx.db
      .query("dtsEvents")
      .withIndex("by_todo", (q) => q.eq("todoId", e.todoId).gte("at", e.at))
      .collect();
    const reply = later.find((r) => r.kind === "slack-event");
    threads.push({
      todoId: e.todoId,
      statement: (await todoOf(e.todoId))?.statement ?? "",
      askedAt: e.at,
      repliedAt: reply?.at ?? null,
      replyMs: reply === undefined ? null : reply.at - e.at,
    });
  }

  return {
    since,
    until,
    completions,
    captures,
    dateOutcomes,
    surfacedUntouched,
    goalsWithoutOpenTask,
    goalsNotEvaluated,
    integrations,
    areaPages,
    modelOfTom,
    learning,
    preludes,
    instructionsLoaded,
    evals,
    ablation,
    efficiency,
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

// ── The week's two decisions, into #tts-decisions ────────────────────────────
// A capability case graduating into the regression set, and a name whose cases
// the week says pass without it, are both decisions taken without him: the
// first changes what gates every later merge, the second is what the next
// simplification pass will act on. They go where every decision taken without
// him goes — ttsSync.sendDecision, the ONE #tts-decisions door — so "revert" in
// the thread is already wired to internalRecordDelegateObjection and the
// morning's objection list already picks them up. No new channel, no new
// poster, no new Slack subject kind.
//
// THE askId IS THE IDEMPOTENCY KEY AND THERE IS NO SECOND ONE. sendDecision
// claims `object:<askId>` for the TTS DAY before it posts, so the same
// graduation offered twice on one day posts once — which is exactly the repeat
// this has: a `--overwrite` rerun of the Friday job. It is a DAY claim and not
// a forever claim; a graduation re-offered a week later would post again, and
// the item ids are stable, so the caller offers each set once per run.
//
// NEITHER FINDING GATES ANYTHING. The ablation line is a candidate for the
// weekly simplification pass to read, not an instruction to remove a name: the
// golden set is mined out of Tom's rulings rather than designed for coverage,
// so a name whose cases pass without it may still be preventing a failure mode
// the set does not contain.
//
// ITS DOOR IS NOT YET CUT. Every other worker-facing mutation here is reached
// through a route in convex/http.ts; this one needs
// `POST /tts/weekly-decisions` there, which is another agent's file this round.
// The Friday job posts to that path already (worker/jobs/weekly.mjs), so until
// the route lands the post is one recorded weekly-failure a week naming exactly
// what is missing — which is the loudest quiet way to carry a seam.
export const internalRecordWeeklyEvalsDecisions = internalMutation({
  args: {
    // The week the ablation finding is about, and the half of its askId that
    // makes one week's finding a different thread from the next week's.
    isoWeek: v.string(),
    graduated: v.optional(v.array(v.object({ id: v.string(), sentence: v.string() }))),
    ablation: v.optional(
      v.array(
        v.object({
          name: v.string(),
          cases: v.number(),
          withPass: v.number(),
          withoutPass: v.number(),
          earned: v.boolean(),
        }),
      ),
    ),
  },
  handler: async (ctx, { isoWeek, graduated, ablation }) => {
    if (isoWeek.trim() === "") throw new Error("isoWeek (non-empty) is what makes one week's ablation thread its own");
    let sent = 0;
    for (const item of graduated ?? []) {
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendDecision, {
        askId: `golden:${item.id}`,
        decision: `a capability case graduated into the regression set: ${item.sentence}`,
        reason: "it passed every trial of the weekly run, so from now on a merge that breaks it is a regression",
      });
      sent++;
    }
    // Only the names that did NOT earn their tokens are a decision. A name
    // whose cases need it is the system working, and #tts-decisions is for
    // what he might want reverted.
    for (const finding of (ablation ?? []).filter((f) => !f.earned)) {
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendDecision, {
        askId: `ablation:${finding.name}:${isoWeek}`,
        decision:
          `${finding.name} did not earn its tokens this week: ${finding.cases} cases, ` +
          `${finding.withPass} pass with it, ${finding.withoutPass} without`,
        reason:
          "the weekly simplification pass reads this as a candidate to drop; it gates nothing, and a name the " +
          "golden set passes without may still be holding up a failure mode the set does not contain",
      });
      sent++;
    }
    return { sent };
  },
});
