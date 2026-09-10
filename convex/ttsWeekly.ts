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
  const skills = await ctx.db.query("ttsSkills").collect();
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

  // 11. Job failures by job.
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
