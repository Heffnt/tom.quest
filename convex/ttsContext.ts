// THE ONE PLACE a run's model-of-tom context is assembled inside Convex.
//
// What this replaces: five hard-coded layer selections — all three layers at
// convex/claudeSessions.ts insertSession, and `["write","know"]` at four
// convex/http.ts doors — each of which sent THE KNOW LAYER WHOLE, 19 KB of
// eight area pages plus intent, priorities and schedule, to find the two or
// three hundred bytes that bore on the run's own subject.
//
// And what replaced the round after that: the dynamic-context round pre-EXPANDED
// the bytes a subject picked out and indexed the rest in a fetchable block. That
// was still the prompt carrying the content. Phase 6 carries NAMES instead. Two
// parts, and nothing else:
//
//   THE PREFIX — header line 1, the map, the operate rules. IDENTICAL FOR EVERY
//     RUN at one WikiTom commit, whoever the caller is and whatever it is about,
//     which is what makes it the cache boundary.
//
//   THE GRANTS — about two hundred bytes naming the skills this run may load
//     (`write`, `know-research`, `repo-tom.quest`, …), and the ones the router
//     wanted that the catalog does not carry. The run loads a body itself, once,
//     only if it needs it.
//
// Nothing that exists becomes invisible; the prompt stops carrying it.
//
// WHAT DECIDES vs WHAT RENDERS: worker/jobs/skill-router.mjs holds the routing
// table (which skills a subject and a caller are granted) and scripts/skills.mjs
// renders the grant block — both plain ESM, so this file, scripts/prelude.mjs
// and the publisher share ONE implementation, the same arrangement
// markdown-sections.mjs uses and for the same reason. This file only reads the
// record and hands it over.
//
// NO MODEL CALL, anywhere on this path.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { modelOfTomState, modelOfTomText } from "./ttsSkills";
import { nyCalendarDayKey, SESSION_REPO_NAMES } from "./ttsShared";
import { renderGrants } from "../scripts/skills.mjs";
import {
  callerRules,
  CONTEXT_CALLER_NAMES,
  routeSkills,
} from "../worker/jobs/skill-router.mjs";

/** scripts/skills.mjs is plain ESM: `renderGrants`s `granted = []` and
 * `refused = []` defaults infer as `never[]`, so the shape it actually takes
 * is stated here rather than cast at the one call site. */
const renderGrantBlock = renderGrants as (input: {
  commit: string | null;
  granted: string[];
  refused: { name: string; why: string }[];
}) => string;

/** What the run is about. `none` is the laptop hook and every caller with no
 * subject (the planner, the weekly gather, time notes): nothing routes off a
 * subject, and the caller's own row is the whole of what it is granted. */
export type ContextSubject =
  | { kind: "todo"; todoId: Id<"dtsTodos"> }
  | { kind: "batch"; batchId: Id<"batches"> }
  | { kind: "repo"; repo: string; paths?: string[] }
  | { kind: "area"; area: string }
  | { kind: "none" };

export type CallerName = string;

export type AssembledContext = {
  /** Header line 1 + the map + the operate rules. The cache boundary. */
  prefix: string;
  /** The grant block — about 200 bytes, whatever the subject. */
  grants: string;
  /** e.g. ["write", "know-climbing", "know-intent"] */
  granted: string[];
  /** What the router wanted and the catalog does not carry. Never fatal. */
  refused: { name: string; why: string }[];
  /** "native" when the run stands in a checkout of a repo it works in, so the
   * rules are on disk at the commit it is working on. Always null in Convex —
   * see the cwd note at assembleContext. */
  repoRulesSource: "native" | null;
  bytes: { prefix: number; grants: number };
};

// ── Read bounds ──────────────────────────────────────────────────────────────
// Every read below is indexed and capped. The one exception is the per-repo
// session scan: `repos` is an ARRAY and Convex does not index array
// membership, so that half stays a bounded descending walk of the two terminal
// statuses, filtered in memory. Cap it and move on.

/** The ceiling on the unindexed session scan. */
export const SESSION_SCAN_MAX = 60;
const SESSION_SCAN_PER_STATUS = SESSION_SCAN_MAX / 2;
/** Every model-of-tom source file, so each area page's `categories:` line is
 * readable — that line is what routes a todo's category to an area's skill.
 * The model-of-tom door caps its post at the same number. */
const MODEL_OF_TOM_FILES_MAX = 64;
const BATCH_TODOS_MAX = 40;
/** The catalog is fourteen rows; the ceiling is the door's. */
const SKILLS_MAX = 64;
const RULINGS_PER_SUBJECT = 5;
const OUTCOMES_PER_BATCH = 3;

// ── The record ───────────────────────────────────────────────────────────────
// Exactly the fields worker/jobs/skill-router.mjs reads, and no more. The
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
    codeRepo?: string;
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
    // THE DAY KEY, not the instant: the New-York offset is a DST question that
    // lives in ttsShared and must not be answered a second time in worker/.
    dueDay: todo.dueAt === undefined ? undefined : nyCalendarDayKey(todo.dueAt),
    dateOutcomes: (todo.dateOutcomes ?? []).map((outcome) => ({ dueDay: nyCalendarDayKey(outcome.dueAt) })),
    brief: todo.brief,
    workDescription: todo.workDescription,
    entryAction: todo.entryAction,
    batchId: todo.batchId,
    // The goal's CODE SUBJECT repository, carried for the router's area row
    // alone: a goal bound to an upstream code todo names the repository that
    // work lives in even when its batch declares no repos, and 60 active rows
    // carry it. The paired `codeExternalId` is NOT carried — nothing in the
    // routing table reads it, and this record holds exactly what the router
    // reads.
    codeRepo: todo.codeRepo,
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

  // His rulings on this todo and on its batch.
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

  // A session is read two ways — by its batch and by its repos — and one
  // session is very often both. Deduplicated by id HERE rather than by rendered
  // text, so a batch's own last session cannot appear twice in one record.
  const seenSessions = new Set<string>();
  const addSession = (session: Doc<"claudeSessions">) => {
    if (seenSessions.has(session._id)) return;
    const row = sessionRow(session);
    if (row === null) return;
    seenSessions.add(session._id);
    record.sessions.push(row);
  };

  if (batch !== null) {
    const onBatch = await ctx.db
      .query("claudeSessions")
      .withIndex("by_batch", (q) => q.eq("batchId", batch!._id))
      .order("desc")
      .take(OUTCOMES_PER_BATCH);
    for (const session of onBatch) addSession(session);
  }

  // The unindexed half: the two terminal statuses, newest first, filtered in
  // memory on `repos`. SESSION_SCAN_MAX documents to a reader exactly how deep
  // this walk can go — nothing here is a table scan.
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
 * A run's model-of-tom context: the stable prefix and the grant block.
 *
 * Reads, per call, inside the caller's existing transaction and with no model
 * call — bounded, indexed except where it says so, and well inside one Convex
 * transaction:
 *
 *   modelOfTomPublication by_key                     1  (already read today)
 *   modelOfTomFiles by_name                        ≤ 64 (every page, so each
 *                                                       area's categories: line
 *                                                       is readable)
 *   ttsSkills by_name                              ≤ 64 (the catalog's names)
 *   dtsTodos get / by_batch                        ≤ 40
 *   batches get                                    ≤  1
 *   dtsRulings by_todo + by_batch                  ≤ 10
 *   claudeSessions by_batch                        ≤  3
 *   claudeSessions by_status ×2, filtered in memory ≤ 60 (SESSION_SCAN_MAX)
 *
 * THE REPO RULES TABLE IS NO LONGER READ HERE. It was read to pre-expand the
 * `AGENTS.md` bodies a brief's paths named; a `repo-<name>` skill carries those
 * bodies now, published by the same nightly job. POST /tts/repo-rules and the
 * table stay — the publisher still posts them and a later step decides their
 * fate — but nothing in Convex reads them at this commit, and saying so is
 * better than a dead call that looks alive.
 *
 * THE cwd GAP, and it is real. The router's last rule asks whether the run
 * stands INSIDE a checkout of a repo it works in; a run that does already has
 * that repo's rules on disk at the commit it is working on, so granting it last
 * night's published copy is a second answer to a question that has one.
 * CONVEX CANNOT ANSWER IT: there is no filesystem and no cwd inside a Convex
 * transaction, and the session row does not carry the workdir the daemon will
 * check the branch out into. So this call passes `cwd: null` and
 * `repoDirs: {}`, which makes the rule inert: `repoRulesSource` is always null
 * here and every repo the subject names is granted as a skill, even to a run
 * standing in that checkout. What would close it is the session's own working
 * directory ON THE ROW at insert time, passed through to this call; until that
 * exists, a box session in tom.quest carries a `repo-tom.quest` grant it does
 * not need, which costs one line of the grant block and no bytes of body.
 *
 * FAILS CLOSED, like every other reader of the publication: a deployment with
 * no posted base throws here, and the caller publishes nothing.
 */
export async function assembleContext(
  ctx: QueryCtx | MutationCtx,
  subject: ContextSubject,
  options: { reachesTom: boolean; caller: CallerName; now?: number },
): Promise<AssembledContext> {
  callerRules(options.caller); // an undeclared caller is a hard error, not a silent minimum
  const state = await modelOfTomState(ctx);
  // ONE SELECTION FOR EVERY CALLER. `reachesTom` used to add the write layer
  // here; it grants the `write` SKILL now, which is why two runs at one commit
  // hold byte-identical prefixes whoever they are.
  const prefix = modelOfTomText(state, ["operate"]);

  const files = await ctx.db.query("modelOfTomFiles").withIndex("by_name").take(MODEL_OF_TOM_FILES_MAX + 1);
  if (files.length > MODEL_OF_TOM_FILES_MAX) throw new Error("too many model-of-tom files to assemble context from");
  const pages = files.map((file) => ({ path: file.sourcePath, body: file.body }));

  const catalog = await ctx.db.query("ttsSkills").withIndex("by_name").take(SKILLS_MAX + 1);
  if (catalog.length > SKILLS_MAX) throw new Error("too many published skills to assemble context from");

  const now = options.now ?? Date.now();
  const { record } = subject.kind === "none"
    ? { record: { today: nyCalendarDayKey(now), todos: [], batches: [], rulings: [], sessions: [] } }
    : await readRecord(ctx, subject, now);

  const routed = routeSkills({
    subject,
    caller: options.caller,
    pages,
    record,
    // See THE cwd GAP above: inert, deliberately, and not by omission.
    cwd: null,
    repoDirs: {},
    published: catalog.map((row) => row.name),
  });
  // The caller table says whether a caller's output reaches Tom; an explicit
  // `reachesTom: false` at a call site narrows its own row, and the narrower
  // answer wins — a run saying its output does not reach him is telling the
  // truth about itself, and the `write` skill is the only grant that turns on
  // that question.
  const granted: string[] = options.reachesTom
    ? routed.granted
    : routed.granted.filter((name: string) => name !== "write");
  const refused: { name: string; why: string }[] = options.reachesTom
    ? routed.refused
    : routed.refused.filter((entry: { name: string }) => entry.name !== "write");

  // THE CATALOG'S COMMIT, not the base's, whenever a catalog is stored. The
  // block is about the skills: a night whose base post landed and whose skills
  // post did not leaves two commits in the store, and the line must name the
  // one the BODIES a run is about to load actually came from. With no catalog
  // at all there are no bodies, and the base's commit is the only one there is.
  const commit = catalog[0]?.commit ?? state.commit;
  const grants = renderGrantBlock({ commit, granted, refused });

  return {
    prefix,
    grants,
    granted,
    refused,
    repoRulesSource: routed.repoRulesSource,
    bytes: { prefix: byteLength(prefix), grants: byteLength(grants) },
  };
}

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The two parts as one string, in prompt order, for a caller whose payload
 * carries one field rather than a composed prompt (the four HTTP doors'
 * `writingStandard`). The field's MEANING does not change — it is still "the
 * model-of-tom text this run works from"; its bytes shrink.
 */
export function joinContext(context: AssembledContext): string {
  return [context.prefix, context.grants].filter((part) => part !== "").join("\n\n");
}

/** The four HTTP doors read here. They have no subject of their own, so they
 * are granted what their caller row alone grants. */
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
