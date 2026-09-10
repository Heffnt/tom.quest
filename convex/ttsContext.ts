// THE ONE PLACE a run's model-of-tom context is assembled inside Convex.
//
// What this replaces: five hard-coded layer selections — all three layers at
// convex/claudeSessions.ts insertSession, and `["write","know"]` at four
// convex/http.ts doors — each of which sent THE KNOW LAYER WHOLE, 19 KB of
// eight area pages plus intent, priorities and schedule, to find the two or
// three hundred bytes that bore on the run's own subject.
//
// After this, selection is a per-run computation (Tom's ruling, 2026-09-09:
// "pre-expanding info about relevant info and providing additional supplemental
// files and making important and comprehensive yet likely irrelevant info
// fetchable"). Two rules stand in for the five selections:
//
//   THE STABLE PREFIX — header line 1, the map, the operate rules, and the
//   write layer when the run's output reaches Tom. Identical for every run at
//   one WikiTom commit, which is what makes it the cache boundary.
//
//   EVERYTHING ELSE COMES FROM THE SUBJECT — the pages, sections and lines the
//   run's own todo, batch, repo or area picks out are EXPANDED, and every layer,
//   page, section, repo rules file and search question NOT included is one line
//   in the FETCHABLE block with the exact command or path that gets it.
//
// Nothing that exists becomes invisible; only the bytes shrink.
//
// NOT IN THE NIGHTLY POST. The nightly job keeps publishing the three layers
// whole plus one ttsSkills row per file, exactly as it does now — no schema
// change to modelOfTomPublication, no per-todo pre-computation. Expansion is
// computed HERE, at session creation, from the stored layers plus the record.
//
// WHAT DECIDES vs WHAT FETCHES: worker/jobs/context-relevance.mjs holds the
// relevance table, the caps, the two shrink orders and the rendering of parts 4
// and 6 — it is plain ESM so this file and scripts/prelude.mjs share ONE
// implementation, the same arrangement markdown-sections.mjs uses and for the
// same reason. This file only reads the record and hands it over.
//
// NO MODEL CALL, anywhere on this path.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { modelOfTomState, modelOfTomText, type ModelOfTomLayerName } from "./ttsSkills";
import { nyCalendarDayKey, SESSION_REPO_NAMES } from "./ttsShared";
import {
  assembleContextParts,
  callerRules,
  CONTEXT_CALLER_NAMES,
} from "../worker/jobs/context-relevance.mjs";

/** What the run is about. `none` is the laptop hook and every caller with no
 * subject (the planner, the weekly gather, time notes): nothing expands, and
 * the fetchable block is the whole of what they get out of the know layer. */
export type ContextSubject =
  | { kind: "todo"; todoId: Id<"dtsTodos"> }
  | { kind: "batch"; batchId: Id<"batches"> }
  | { kind: "repo"; repo: string; paths?: string[] }
  | { kind: "area"; area: string }
  | { kind: "none" };

export type CallerName = string;

export type AssembledContext = {
  /** Header line 1 + map + operate + (write). The cache boundary. */
  prefix: string;
  /** Header line 2 + part 4. "" when the subject expands nothing. */
  expanded: string;
  /** Header line 3 + part 6. */
  fetchable: string;
  /** e.g. ["areas/agent-systems", "intent#What to push toward", "rulings:2"] */
  manifest: string[];
  bytes: { prefix: number; expanded: number; fetchable: number };
};

// ── Read bounds ──────────────────────────────────────────────────────────────
// Every read below is indexed and capped. The one exception is the per-repo
// session scan: `repos` is an ARRAY and Convex does not index array
// membership, so that half of rule 11 is a bounded descending walk of the two
// terminal statuses, filtered in memory. Cap it and move on.

/** The ceiling on the unindexed half of rule 11. */
export const SESSION_SCAN_MAX = 60;
const SESSION_SCAN_PER_STATUS = SESSION_SCAN_MAX / 2;
/** Every model-of-tom file, so each area page's `categories:` frontmatter is
 * readable. The publication's own backfill uses the same ceiling. */
const TTS_SKILLS_MAX = 64;
const BATCH_TODOS_MAX = 40;
const REPO_RULES_MAX = 24;
const RULINGS_PER_SUBJECT = 5;
const OUTCOMES_PER_BATCH = 3;

// ── The record ───────────────────────────────────────────────────────────────
// Exactly the fields worker/jobs/context-relevance.mjs reads, and no more. The
// `--record FILE` a CLI run passes holds this same shape, which is what lets
// scripts/prelude.mjs assemble a run's prompt with no deployment at all.

type ContextRecord = {
  today: string;
  todos: {
    id: string;
    category?: string;
    timingClass?: string;
    dueDay?: string;
    dateOutcomes?: { dueDay: string }[];
    brief?: string;
    workDescription?: string;
    entryAction?: string;
    batchId?: string;
    repos?: string[];
  }[];
  batches: { id: string; repos?: string[] }[];
  rulings: {
    todoId?: string;
    batchId?: string;
    verdict: string;
    sentence?: string;
    ruledAt: number;
    ruledDay: string;
  }[];
  sessions: {
    batchId?: string;
    repos?: string[];
    outcome: string;
    outcomeSummary?: string;
    statusChangedAt: number;
    endedDay: string;
  }[];
};

function todoRow(todo: Doc<"dtsTodos">): ContextRecord["todos"][number] {
  return {
    id: todo._id,
    category: todo.category,
    timingClass: todo.timingClass,
    // THE DAY KEY, not the instant: rule 8 asks which New-York weekday a date
    // falls on, and the New-York offset is a DST question that lives in
    // ttsShared and must not be answered a second time in worker/.
    dueDay: todo.dueAt === undefined ? undefined : nyCalendarDayKey(todo.dueAt),
    dateOutcomes: (todo.dateOutcomes ?? []).map((outcome) => ({ dueDay: nyCalendarDayKey(outcome.dueAt) })),
    brief: todo.brief,
    workDescription: todo.workDescription,
    entryAction: todo.entryAction,
    batchId: todo.batchId,
  };
}

function rulingRow(ruling: Doc<"dtsRulings">): ContextRecord["rulings"][number] {
  return {
    todoId: ruling.todoId,
    batchId: ruling.batchId,
    verdict: ruling.verdict,
    sentence: ruling.sentence,
    ruledAt: ruling.ruledAt,
    ruledDay: nyCalendarDayKey(ruling.ruledAt),
  };
}

function sessionRow(session: Doc<"claudeSessions">): ContextRecord["sessions"][number] | null {
  if (session.outcome === undefined) return null;
  return {
    batchId: session.batchId,
    repos: session.repos ?? [session.repo],
    outcome: session.outcome,
    outcomeSummary: session.outcomeSummary,
    statusChangedAt: session.statusChangedAt,
    endedDay: nyCalendarDayKey(session.statusChangedAt),
  };
}

/**
 * The record rows the subject reaches, and the repos the run works in. Every
 * query here is on an index and take()s a fixed number; the totals are in the
 * comment above assembleContext.
 */
async function readRecord(
  ctx: QueryCtx | MutationCtx,
  subject: ContextSubject,
  now: number,
): Promise<{ record: ContextRecord; repos: string[] }> {
  const record: ContextRecord = { today: nyCalendarDayKey(now), todos: [], batches: [], rulings: [], sessions: [] };
  let batch: Doc<"batches"> | null = null;
  let todoId: Id<"dtsTodos"> | null = null;

  if (subject.kind === "todo") {
    const todo = await ctx.db.get(subject.todoId);
    // A run that thinks it saw its subject and saw nothing is worse than a run
    // that stops — the same refusal the CLI makes for an unresolvable subject.
    if (todo === null) throw new Error(`context subject todo ${subject.todoId} does not exist`);
    todoId = todo._id;
    record.todos.push(todoRow(todo));
    if (todo.batchId !== undefined) batch = await ctx.db.get(todo.batchId);
  } else if (subject.kind === "batch") {
    batch = await ctx.db.get(subject.batchId);
    if (batch === null) throw new Error(`context subject batch ${subject.batchId} does not exist`);
    const members = await ctx.db
      .query("dtsTodos")
      .withIndex("by_batch", (q) => q.eq("batchId", batch!._id))
      .take(BATCH_TODOS_MAX);
    for (const member of members) record.todos.push(todoRow(member));
  }

  if (batch !== null) record.batches.push({ id: batch._id, repos: batch.repos });

  const repos = subject.kind === "repo"
    ? [subject.repo]
    : [...new Set(batch?.repos ?? [])].sort();

  // Rule 10: his rulings on this todo and on its batch.
  if (todoId !== null) {
    const own = await ctx.db
      .query("dtsRulings")
      .withIndex("by_todo", (q) => q.eq("todoId", todoId))
      .take(RULINGS_PER_SUBJECT);
    for (const ruling of own) record.rulings.push(rulingRow(ruling));
  }
  if (batch !== null) {
    const onBatch = await ctx.db
      .query("dtsRulings")
      .withIndex("by_batch", (q) => q.eq("batchId", batch!._id))
      .take(RULINGS_PER_SUBJECT);
    for (const ruling of onBatch) record.rulings.push(rulingRow(ruling));
  }

  // Rule 11 reads a session two ways — by its batch and by its repos — and one
  // session is very often both. Deduplicated by id HERE rather than by rendered
  // text, so a batch's own last session cannot appear twice in one prompt.
  const seenSessions = new Set<string>();
  const addSession = (session: Doc<"claudeSessions">) => {
    if (seenSessions.has(session._id)) return;
    const row = sessionRow(session);
    if (row === null) return;
    seenSessions.add(session._id);
    record.sessions.push(row);
  };

  // Rule 11, indexed half: the batch's own last sessions.
  if (batch !== null) {
    const onBatch = await ctx.db
      .query("claudeSessions")
      .withIndex("by_batch", (q) => q.eq("batchId", batch!._id))
      .order("desc")
      .take(OUTCOMES_PER_BATCH);
    for (const session of onBatch) addSession(session);
  }

  // Rule 11, unindexed half: the two terminal statuses, newest first, filtered
  // in memory on `repos`. SESSION_SCAN_MAX documents to a reader exactly how
  // deep this walk can go — nothing here is a table scan.
  if (repos.length > 0) {
    for (const status of ["ended", "failed"] as const) {
      const recent = await ctx.db
        .query("claudeSessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(SESSION_SCAN_PER_STATUS);
      for (const session of recent) {
        if (!(session.repos ?? [session.repo]).some((repo) => repos.includes(repo))) continue;
        addSession(session);
      }
    }
  }
  return { record, repos };
}

/**
 * The rules of the repos this run works in — and of EVERY repo when it works in
 * none. A run with no checkout (prepare, triage, the planner) gets none of these
 * expanded, but its fetchable block still says the files exist and where: that
 * is the unknown-unknown the whole arrangement is for, and dropping the lines
 * because the run has no repo would put it back.
 */
async function readRepoRules(ctx: QueryCtx | MutationCtx, repos: string[]) {
  const out: { repo: string; path: string; body: string }[] = [];
  if (repos.length === 0) {
    const rules = await ctx.db.query("repoRules").withIndex("by_repo").take(REPO_RULES_MAX * 3);
    for (const rule of rules) out.push({ repo: rule.repo, path: rule.path, body: rule.body });
    return out;
  }
  for (const repo of repos) {
    const rules = await ctx.db
      .query("repoRules")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .take(REPO_RULES_MAX);
    for (const rule of rules) out.push({ repo: rule.repo, path: rule.path, body: rule.body });
  }
  return out;
}

/**
 * The three parts of a run's model-of-tom context.
 *
 * Reads, per call, inside the caller's existing transaction and with no model
 * call — bounded, indexed except where it says so, and well inside one Convex
 * transaction:
 *
 *   modelOfTomPublication by_key                     1  (already read today)
 *   ttsSkills by_name                              ≤ 64 (every page, so each
 *                                                       area's categories: line
 *                                                       is readable)
 *   dtsTodos get / by_batch                        ≤ 40
 *   batches get                                    ≤  1
 *   dtsRulings by_todo + by_batch                  ≤ 10
 *   claudeSessions by_batch                        ≤  3
 *   claudeSessions by_status ×2, filtered in memory ≤ 60 (SESSION_SCAN_MAX)
 *   repoRules by_repo                              ≤ 24
 *
 * FAILS CLOSED, like every other reader of the publication: a deployment with
 * no complete posted layer set throws here, and the caller publishes nothing.
 */
export async function assembleContext(
  ctx: QueryCtx | MutationCtx,
  subject: ContextSubject,
  options: { reachesTom: boolean; caller: CallerName; now?: number },
): Promise<AssembledContext> {
  callerRules(options.caller); // an undeclared caller is a hard error, not a silent minimum
  const state = await modelOfTomState(ctx);
  const stableLayers: ModelOfTomLayerName[] = options.reachesTom ? ["operate", "write"] : ["operate"];
  const prefix = modelOfTomText(state, stableLayers);

  const facts = await ctx.db.query("ttsSkills").withIndex("by_name").take(TTS_SKILLS_MAX + 1);
  if (facts.length > TTS_SKILLS_MAX) throw new Error("too many model-of-tom facts to assemble context from");
  const pages = facts.map((fact) => ({ path: fact.sourcePath, body: fact.body }));

  const now = options.now ?? Date.now();
  const { record, repos } = subject.kind === "none"
    ? { record: { today: nyCalendarDayKey(now), todos: [], batches: [], rulings: [], sessions: [] }, repos: [] }
    : await readRecord(ctx, subject, now);
  const repoRules = await readRepoRules(ctx, repos);

  const parts = assembleContextParts({
    subject,
    caller: options.caller,
    pages,
    repoRules,
    record,
    stableLayers,
  });
  return {
    prefix,
    expanded: parts.expanded,
    fetchable: parts.fetchable,
    manifest: parts.manifest,
    bytes: {
      prefix: byteLength(prefix),
      expanded: parts.bytes.expanded,
      fetchable: parts.bytes.fetchable,
    },
  };
}

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The three parts as one string, in prompt order, for a caller whose payload
 * carries one field rather than a composed prompt (the four HTTP doors'
 * `writingStandard`). The field's MEANING does not change — it is still "the
 * model-of-tom text this run works from"; its bytes shrink.
 */
export function joinContext(context: AssembledContext): string {
  return [context.prefix, context.expanded, context.fetchable].filter((part) => part !== "").join("\n\n");
}

/** The four HTTP doors read here. They have no subject of their own, so rule 12
 * expands nothing and the fetchable block carries the whole know layer's index. */
export const internalContextPrelude = internalQuery({
  args: { caller: v.string() },
  handler: async (ctx, args): Promise<string> => {
    if (!CONTEXT_CALLER_NAMES.includes(args.caller)) throw new Error(`unknown context caller ${args.caller}`);
    return joinContext(await assembleContext(ctx, { kind: "none" }, { reachesTom: true, caller: args.caller }));
  },
});

// ── The repo layer's publication ─────────────────────────────────────────────

/** A path inside a repo naming an `AGENTS.md`: relative, no traversal, and the
 * file the repo layer is actually made of. */
export function isRepoRulesPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /^(?:[A-Za-z0-9._-]+\/)*AGENTS\.md$/.test(path) &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/**
 * One repo's rules, replaced whole. Same shape of refusal as
 * `internalReplaceModelOfTom`: an empty post leaves the store as it was, a
 * duplicate path is a bug in the poster, and a blank body is not a rules file.
 *
 * PER REPO, not per post: a night that could read tom.quest and not
 * ComplexMultiTrigger replaces the first repo's rows and leaves the second's
 * exactly where they were.
 */
export const internalReplaceRepoRules = internalMutation({
  args: {
    repo: v.string(),
    commit: v.string(),
    syncedAt: v.number(),
    files: v.array(v.object({ path: v.string(), body: v.string(), bytes: v.number() })),
  },
  handler: async (ctx, { repo, commit, syncedAt, files }) => {
    // A repo name nobody declared would create a phantom repo's rules that no
    // session could ever be opened on — a typo, silently stored.
    if (!(SESSION_REPO_NAMES as readonly string[]).includes(repo)) throw new Error(`not a session repo: ${repo}`);
    if (commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(syncedAt)) throw new Error("syncedAt must be finite");
    if (files.length === 0) throw new Error("no repo rules posted — store left as it was");
    const paths = new Set<string>();
    for (const file of files) {
      if (!isRepoRulesPath(file.path)) throw new Error(`not a repo rules path: ${file.path}`);
      if (paths.has(file.path)) throw new Error(`path posted twice: ${file.path}`);
      if (file.body.trim() === "") throw new Error(`body for ${file.path} must be non-empty`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new Error(`bytes for ${file.path} must be a nonnegative integer`);
      }
      paths.add(file.path);
    }
    const existing = await ctx.db
      .query("repoRules")
      .withIndex("by_repo", (q) => q.eq("repo", repo))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    for (const file of files) {
      await ctx.db.insert("repoRules", { repo, path: file.path, body: file.body, bytes: file.bytes, commit, syncedAt });
    }
    return { repo, files: files.length, deleted: existing.length, commit };
  },
});
