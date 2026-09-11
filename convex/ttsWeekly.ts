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

/**
 * A weekly-input HTTP request composes these independently bounded queries.
 * Their union is exactly WeeklyFacts; splitting only changes where Convex
 * accounts for database work, never the response the Friday job receives.
 */
const WEEKLY_FACT_GROUPS = [
  "todos",
  "active",
  "integrations",
  "model",
  "records",
  "threads",
] as const;
type WeeklyFactGroup = (typeof WEEKLY_FACT_GROUPS)[number];

// Credential history has its own fixed-size page query below, so it is not a
// member of this fan-out. `gatherWeeklyFacts` still keeps it for its direct
// callers and tests.
export const WEEKLY_INPUT_PARTS = ["todos", "active", "model", "records", "threads"] as const;
export type WeeklyInputPart = (typeof WEEKLY_INPUT_PARTS)[number];

const WEEKLY_PART_FIELDS: Record<WeeklyFactGroup, readonly (keyof Omit<WeeklyFacts, "since" | "until">)[]> = {
  todos: ["completions", "captures", "dateOutcomes", "surfacedUntouched"],
  active: ["goalsWithoutOpenTask", "goalsNotEvaluated", "readiness"],
  integrations: ["integrations"],
  model: ["areaPages", "modelOfTom"],
  records: ["learning", "preludes", "instructionsLoaded", "evals", "jobFailures"],
  threads: ["threads"],
};

function weeklyPart(
  facts: WeeklyFacts,
  part: WeeklyFactGroup,
): Partial<Omit<WeeklyFacts, "since" | "until">> {
  return Object.fromEntries(
    WEEKLY_PART_FIELDS[part].map((field) => [field, facts[field]]),
  ) as Partial<Omit<WeeklyFacts, "since" | "until">>;
}

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
 * When a goal was last evaluated, or null when never. Each lookup pins both
 * the subject and the event kind, so an old goal with many unrelated events
 * does not make the weekly gather walk its whole history. Batch lookups are
 * shared by every goal in that batch.
 */
async function lastGoalEvaluation(
  ctx: QueryCtx,
  goal: Doc<"dtsTodos">,
  until: number,
  batchEvaluations: Map<string, Promise<number | null>>,
): Promise<number | null> {
  const own = await Promise.all(EVALUATION_KINDS.map(async (kind) =>
    await ctx.db
      .query("dtsEvents")
      .withIndex("by_todo_kind_at", (q) => q.eq("todoId", goal._id).eq("kind", kind).lt("at", until))
      .order("desc")
      .first(),
  ));
  let last = own.reduce<number | null>(
    (latest, event) =>
      event !== null && (latest === null || event.at > latest) ? event.at : latest,
    null,
  );
  if (goal.batchId !== undefined) {
    let batch = batchEvaluations.get(goal.batchId);
    if (batch === undefined) {
      batch = Promise.all(EVALUATION_KINDS.map(async (kind) =>
        await ctx.db
          .query("dtsEvents")
          .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", goal.batchId).lt("at", until))
          .order("desc")
          .first(),
      )).then((rows) => rows.reduce<number | null>(
        (latest, event) =>
          event !== null && (latest === null || event.at > latest) ? event.at : latest,
        null,
      ));
      batchEvaluations.set(goal.batchId, batch);
    }
    const batchLast = await batch;
    if (batchLast !== null && (last === null || batchLast > last)) last = batchLast;
  }
  return last;
}

export async function gatherWeeklyFacts(
  ctx: QueryCtx,
  { since, until }: { since: number; until: number },
  groups: readonly WeeklyFactGroup[] = WEEKLY_FACT_GROUPS,
): Promise<WeeklyFacts> {
  const wants = (part: WeeklyFactGroup) => groups.includes(part);
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
  const captures: WeeklyFacts["captures"] = [];
  const dateOutcomes: WeeklyFacts["dateOutcomes"] = [];
  const surfacedUntouched: WeeklyFacts["surfacedUntouched"] = [];
  if (wants("todos")) {
    for (const t of await ctx.db
      .query("dtsTodos")
      .withIndex("by_status", (q) => q.eq("status", "done").gte("updatedAt", since).lt("updatedAt", until))
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
    captures.push(...[...bySource.values()].sort((a, b) =>
      a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
    ));

    // 3. Every date outcome — done, renegotiated, missed (the rollover's
    // included; it writes the same kind).
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

    // 4. Surfaced three times and untouched: only kinds Tom writes are read
    // through the subject-and-kind index. Unrelated event history is not.
    const surfacings = new Map<Id<"dtsTodos">, { count: number; firstAt: number }>();
    for (const e of await eventsOfKind("surfaced")) {
      if (e.todoId === undefined) continue;
      const s = surfacings.get(e.todoId) ?? { count: 0, firstAt: e.at };
      s.count++;
      s.firstAt = Math.min(s.firstAt, e.at);
      surfacings.set(e.todoId, s);
    }
    for (const [todoId, s] of surfacings) {
      if (s.count < SURFACED_THRESHOLD) continue;
      let touched = false;
      for (const kind of TOM_TOUCH_KINDS) {
        for await (const event of ctx.db
          .query("dtsEvents")
          .withIndex("by_todo_kind_at", (q) => q.eq("todoId", todoId).eq("kind", kind).gte("at", s.firstAt).lt("at", until))) {
          if (isTomTouch(event)) {
            touched = true;
            break;
          }
        }
        if (touched) break;
      }
      if (touched) continue;
      const todo = await todoOf(todoId);
      surfacedUntouched.push({
        id: todoId,
        statement: todo?.statement ?? "",
        surfaced: s.count,
        firstAt: s.firstAt,
      });
    }
    surfacedUntouched.sort((a, b) => b.surfaced - a.surfaced || a.firstAt - b.firstAt);
  }

  // 5, 6, 13: the active set, read once.
  const goalsWithoutOpenTask: WeeklyFacts["goalsWithoutOpenTask"] = [];
  const goalsNotEvaluated: WeeklyFacts["goalsNotEvaluated"] = [];
  let prepared = 0;
  let unprepared = 0;
  if (wants("active")) {
    const active = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    const openTasksByBatch = new Set<string>();
    for (const t of active) {
      if (t.kind !== "goal" && t.batchId !== undefined) openTasksByBatch.add(t.batchId);
    }
    const batchEvaluations = new Map<string, Promise<number | null>>();
    for (const t of active) {
      if (t.kind !== "goal") continue;
      const batch = await batchName(t.batchId);
      if (t.batchId !== undefined && !openTasksByBatch.has(t.batchId)) {
        goalsWithoutOpenTask.push({ id: t._id, statement: t.statement, batch });
      }
      // Evaluated = a session opened on the goal, or on its batch, or one that
      // recorded an outcome for either, in the last seven days.
      const lastEvaluatedAt = await lastGoalEvaluation(ctx, t, until, batchEvaluations);
      if (lastEvaluatedAt !== null && lastEvaluatedAt >= until - WEEK_MS) continue;
      goalsNotEvaluated.push({ id: t._id, statement: t.statement, batch, lastEvaluatedAt });
    }
    for (const t of active) {
      if (isPrepared(t.readiness)) prepared++;
      else unprepared++;
    }
  }

  // 7. Integrations by state. Declined: an archived "integration: <name>"
  // todo with the archive ruling newest (ttsIntegrations). Waiting on a
  // credential: the job's standing "job-failed" row — reported and not
  // recovered since — whose key names a credential condition, read per job
  // on its own key prefix (standingCredentialFailure). Otherwise running.
  const integrations: WeeklyFacts["integrations"] = [];
  if (wants("integrations")) {
    const declined = await declinedIntegrations(ctx);
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
  }

  // 8, 9. The area pages and the size of the model-of-tom files, from the
  // rows the nightly job posted. The path-prefix index excludes every other
  // skill before this query reads a row.
  const files: WeeklyFacts["modelOfTom"]["files"] = [];
  const areaPages: WeeklyFacts["areaPages"] = [];
  const layers: WeeklyFacts["modelOfTom"]["layers"] = [];
  let modelOfTom: WeeklyFacts["modelOfTom"] = {
    commit: null,
    syncedAt: null,
    layers,
    files,
    totalBytes: 0,
  };
  if (wants("model")) {
    const [skills, publication] = await Promise.all([
      ctx.db
        .query("ttsSkills")
        .withIndex("by_source_path", (q) =>
          q.gte("sourcePath", "model-of-tom/").lt("sourcePath", "model-of-tom/\uffff"),
        )
        .collect(),
      ctx.db.query("modelOfTomPublication")
        .withIndex("by_key", (q) => q.eq("key", "current")).unique(),
    ]);
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
    modelOfTom = {
      commit: publication?.commit ?? null,
      syncedAt: publication?.committedAt ?? null,
      layers,
      files,
      totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  }

  // 10. What the nightly job wrote, reverted, and failed to revert.
  const learning: WeeklyFacts["learning"] = { changes: 0, reverted: 0, revertFailed: 0, lines: [] };
  const preludes: WeeklyFacts["preludes"] = { sessions: 0, current: 0, stale: [], missing: [] };
  const instructionsLoaded: WeeklyFacts["instructionsLoaded"] = {
    daysReported: 0,
    sessions: 0,
    files: [],
    missingWikiTom: 0,
    missingWikiTomSessions: [],
    missingProjectAgents: [],
  };
  const evals: WeeklyFacts["evals"] = { runs: 0, clean: 0, regressions: [] };
  const jobFailures: WeeklyFacts["jobFailures"] = [];
  if (wants("records")) {
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

    for (const e of await eventsOfKind(EVALS_RUN)) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    evals.runs++;
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
    jobFailures.push(...[...byJob.values()].sort((a, b) =>
      a.job < b.job ? -1 : a.job > b.job ? 1 : 0,
    ));
    for (const f of jobFailures) f.lines.sort((a, b) => a.at - b.at);
  }

  // 12. Threads that needed Tom this week and his reply time on each: the
  // "needs-tom" rows, and for each the first Slack reply of his on that todo
  // after it (the events route writes "slack-event" with the todo's id). The
  // spec's own check against the system becoming controlling (principle 8):
  // reported as a duration, never as a judgement.
  const threads: WeeklyFacts["threads"] = [];
  if (wants("threads")) {
    for (const e of await eventsOfKind(NEEDS_TOM)) {
      if (e.todoId === undefined) continue;
      const reply = await ctx.db
        .query("dtsEvents")
        .withIndex("by_todo_kind_at", (q) =>
          q.eq("todoId", e.todoId).eq("kind", "slack-event").gte("at", e.at).lt("at", until),
        )
        .first();
      threads.push({
        todoId: e.todoId,
        statement: (await todoOf(e.todoId))?.statement ?? "",
        askedAt: e.at,
        repliedAt: reply?.at ?? null,
        replyMs: reply === null ? null : reply.at - e.at,
      });
    }
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
    jobFailures,
    threads,
    readiness: { prepared, unprepared },
  };
}

/** One bounded portion of GET /tts/weekly-input, composed by its HTTP action. */
export const internalWeeklyInputPart = internalQuery({
  args: {
    until: v.number(),
    part: v.union(
      v.literal("todos"),
      v.literal("active"),
      v.literal("model"),
      v.literal("records"),
      v.literal("threads"),
    ),
  },
  handler: async (ctx, { until, part }) =>
    weeklyPart(
      await gatherWeeklyFacts(ctx, { since: until - WEEK_MS, until }, [part]),
      part,
    ),
});

/**
 * One page of a job's keyed failure or recovery history. Credential condition
 * names predate a dedicated indexed field, so the endpoint retains their
 * exact regex-based meaning while the HTTP action folds fixed-size pages.
 */
export const internalWeeklyCredentialEventsPage = internalQuery({
  args: {
    job: v.string(),
    kind: v.union(v.literal(JOB_FAILED), v.literal(JOB_RECOVERED)),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { job, kind, cursor }) => {
    const prefix = `${job}:`;
    return await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) =>
        q.eq("kind", kind).gte("key", prefix).lt("key", `${prefix}\uffff`),
      )
      .order("desc")
      .paginate({ numItems: 100, cursor });
  },
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
