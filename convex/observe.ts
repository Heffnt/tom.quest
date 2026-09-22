// THE OBSERVATION SURFACE'S READS. One window of time, four sources, and
// nothing derived here that the page can derive from what comes back: the map's
// node counts are counts of these rows, so a second count computed on the
// server would be a number the page could contradict.
//
// PAGED, NOT COLLECTED. The window moves back through all history — a month of
// runs and a month of events are both unbounded reads — so runs and events come
// back through `paginationOptsValidator` and the page walks the pages until the
// window is exhausted or its own cap stops it. Rulings are the exception and
// are taken whole under a cap: the table is append-only at Tom's pace and a
// month of it is tens of rows.
//
// The gate is `requireTom`: every row here is a run's content, a merge, a
// failure or a ruling, and the `agent` account reads none of it
// (convex/agentSurfaces.ts names "TTS" and "Turing" only).

import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { mergeGateFor } from "./ttsMerge";
import { commitKey } from "./ttsShared";
import { NEEDS_TOM } from "./ttsSlack";

/** The label every gate in this module names, so a denial says which surface. */
const SURFACE = "Observe";

/** The widest window the page offers, in milliseconds: one month, plus the
 *  slack a 31-day month needs. A wider one is more pages, not a different
 *  read. */
const MAX_WINDOW_MS = 40 * 24 * 60 * 60 * 1000;

/** The most rulings one window returns. Append-only at Tom's own pace. */
const RULINGS_MAX = 500;

/** How far back the waiting-on-Tom count looks for an unanswered thread. A
 *  needs-you thread older than this is not waiting, it is forgotten, and the
 *  count would be a number that only grows. */
const WAITING_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The most needs-you rows that count is allowed to read. */
const WAITING_MAX = 200;

/** The merge row's kind (convex/ttsMerge.ts MERGE), and the delegate's two
 *  (convex/ttsAsk.ts). Spelled here rather than imported because both of those
 *  modules pull in the Slack door and the GitHub fetch, which a read-only
 *  query has no business loading. */
const MERGE_KIND = "merge";
const DELEGATE_DECISION_KIND = "delegate-decision";
const DELEGATE_OBJECTION_KIND = "delegate-objection";

/** The three head rows the merge gate reads for one commit
 *  (convex/ttsMerge.ts). */
export const GATE_KINDS = ["tests-run", "audit-verdict", "evals-run"] as const;

/** The two `-failed` kinds that are not #tts-broken lines. Spelled the way
 *  convex/tts.ts NOT_A_BROKEN_LINE spells them, and for its reasons: the Slack
 *  door's own failure would post about itself, and a learning revert is an
 *  objection the nightly could not apply, not a job that broke. */
const NOT_A_FAILURE = new Set(["slack-send-failed", "learning-revert-failed"]);

/**
 * True for the event rows the failures lane draws.
 *
 * FAILURE IS A SHAPE, NOT A KIND. convex/tts.ts logEvent turns every kind
 * ending in `-failed` into a #tts-broken line, minus those two exclusions, so
 * this reads the same rule. A list of failure kinds here would be a second list
 * that goes stale the day a new job is written.
 */
export function isFailureKind(kind: string): boolean {
  return kind.endsWith("-failed") && !NOT_A_FAILURE.has(kind);
}

/** The kinds a page of events keeps. Everything else in the window is dropped
 *  on the server, so a page of rows is rows the page can draw rather than rows
 *  of surfacing instrumentation. */
function wanted(kind: string): boolean {
  return (
    kind === MERGE_KIND ||
    kind === DELEGATE_DECISION_KIND ||
    kind === DELEGATE_OBJECTION_KIND ||
    (GATE_KINDS as readonly string[]).includes(kind) ||
    isFailureKind(kind)
  );
}

function assertWindow(from: number, to: number) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("window bounds must be numbers");
  if (to <= from) throw new Error("a window ends after it starts");
  if (to - from > MAX_WINDOW_MS) throw new Error("a window is at most a month");
}

/** A run, trimmed to what a bar on a lane needs. The transcript, the token
 *  totals and the context stay where they are: the run page reads them, and a
 *  timeline that carried them would be a month of transcripts in the browser. */
function mark(run: Doc<"runs">) {
  return {
    runId: run.runId,
    parentRunId: run.parentRunId ?? null,
    depth: run.depth,
    host: run.host,
    environment: run.environment,
    cli: run.cli,
    kind: run.kind,
    status: run.status,
    model: run.model ?? null,
    startedAt: run.startedAt,
    lastLineAt: run.lastLineAt,
    endedReason: run.outcome?.endedReason ?? null,
    // The repository filter's value. A run names no repository field; what it
    // has is the working directory and the branch its launcher recorded, and
    // the page turns the directory into a repository name (app/observe/lib.ts
    // repoOfRun) rather than this module inventing a field the record does not
    // keep.
    cwd: run.context?.cwd ?? null,
    gitBranch: run.context?.gitBranch ?? null,
    // The WikiTom commit the run's base was assembled from. Absent is a
    // supported value and nothing is inferred from it: an unregistered run
    // carries none.
    wikitomCommit: run.context?.wikitomCommit ?? null,
  };
}

export type RunMark = ReturnType<typeof mark>;

/**
 * Every run that STARTED in the window, oldest first.
 *
 * Off `by_started`, the one index that ranges on time without first pinning
 * host and depth — the two things the page filters on afterwards. A run that
 * started before the window and is still going is therefore not here: the
 * window picker is about when work started, and a query that also carried
 * "everything still running from before" would answer two questions at once
 * and could give neither a cursor.
 */
export const runsInWindow = query({
  args: {
    from: v.number(),
    to: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { from, to, paginationOpts }) => {
    await requireTom(ctx, SURFACE);
    assertWindow(from, to);
    const page = await ctx.db
      .query("runs")
      .withIndex("by_started", (q) => q.gte("startedAt", from).lt("startedAt", to))
      .order("asc")
      .paginate(paginationOpts);
    return { ...page, page: page.page.map(mark) };
  },
});

/**
 * The point events in the window, oldest first: the merges, the delegate's
 * decisions and its objections, and every failure.
 *
 * FILTERED AFTER THE RANGE, on purpose. `by_at` is one range read and the kinds
 * wanted here are four shapes, one of which is a suffix rule; four indexed
 * reads would be four cursors the page would have to merge, and a page boundary
 * is not a thing four cursors agree on.
 */
export const eventsInWindow = query({
  args: {
    from: v.number(),
    to: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { from, to, paginationOpts }) => {
    await requireTom(ctx, SURFACE);
    assertWindow(from, to);
    const page = await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", from).lt("at", to))
      .order("asc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: page.page
        .filter((event) => wanted(event.kind))
        .map((event) => ({
          id: event._id as string,
          at: event.at,
          kind: event.kind,
          key: event.key ?? null,
          todoId: (event.todoId ?? null) as string | null,
          // A GATE HEAD ROW ARRIVES WITHOUT ITS BODY. The map counts these and
          // nothing draws their content, while an audit row carries up to eight
          // kilobytes of the audit's prose — a month of them would be megabytes
          // sent to a browser that never opens one. The changes list reads the
          // gate's own answer for the commits it shows (gateRows below), which
          // is where that content belongs.
          data: (GATE_KINDS as readonly string[]).includes(event.kind)
            ? null
            : ((event.data ?? null) as unknown),
        })),
    };
  },
});

/**
 * The rulings Tom made in the window, oldest first, each with the words of the
 * subject it settled — the statement, not the id: a list of ids is a list of
 * things to go and look up.
 */
export const rulingsInWindow = query({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    await requireTom(ctx, SURFACE);
    assertWindow(from, to);
    const rulings = await ctx.db
      .query("dtsRulings")
      .withIndex("by_ruled", (q) => q.gte("ruledAt", from).lt("ruledAt", to))
      .order("asc")
      .take(RULINGS_MAX);
    return await Promise.all(rulings.map(async (ruling) => ({
      id: ruling._id as string,
      ruledAt: ruling.ruledAt,
      verdict: ruling.verdict,
      sentence: ruling.sentence ?? null,
      subjectType: ruling.subjectType,
      todoId: (ruling.todoId ?? null) as string | null,
      batchId: (ruling.batchId ?? null) as string | null,
      repo: ruling.repo ?? null,
      externalId: ruling.externalId ?? null,
      // What the ruling is ABOUT, in the subject's own words.
      subject: await subjectWords(ctx, ruling),
      // Set when the ruling was read out of Tom's own sentence rather than
      // pressed on a button; the quote is the sentence that was read.
      quote: ruling.provenance?.quote ?? null,
    })));
  },
});

async function subjectWords(ctx: QueryCtx, ruling: Doc<"dtsRulings">): Promise<string> {
  if (ruling.todoId !== undefined) {
    const todo = await ctx.db.get(ruling.todoId);
    return todo?.statement ?? "";
  }
  if (ruling.batchId !== undefined) {
    const batch = await ctx.db.get(ruling.batchId);
    return batch?.statement ?? "";
  }
  const { repo, externalId } = ruling;
  if (repo !== undefined && externalId !== undefined) {
    const mirror = await ctx.db
      .query("dtsCodeTodoMirror")
      .withIndex("by_repo_external", (q) => q.eq("repo", repo).eq("externalId", externalId))
      .first();
    return mirror?.statement ?? `${repo} ${externalId}`;
  }
  return "";
}

/**
 * The needs-you threads still waiting on Tom, and when the oldest one opened.
 *
 * WAITING is the weekly job's own test (convex/ttsWeekly.ts, threads): a
 * "needs-tom" row whose todo has no Slack reply of his after it. A second
 * definition here would be a second number for the same fact, and the two would
 * differ on the day one of them was edited.
 */
export const waitingOnTom = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const since = Date.now() - WAITING_LOOKBACK_MS;
    const asked = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", NEEDS_TOM).gte("at", since))
      .order("desc")
      .take(WAITING_MAX);
    let waiting = 0;
    let oldestAt: number | null = null;
    let lastAt: number | null = null;
    for (const event of asked) {
      const todoId = event.todoId;
      if (lastAt === null || event.at > lastAt) lastAt = event.at;
      if (todoId === undefined) continue;
      const after = await ctx.db
        .query("dtsEvents")
        .withIndex("by_todo", (q) => q.eq("todoId", todoId).gte("at", event.at))
        .take(50);
      if (after.some((row) => row.kind === "slack-event")) continue;
      waiting += 1;
      if (oldestAt === null || event.at < oldestAt) oldestAt = event.at;
    }
    return { waiting, oldestAt, lastAt, read: asked.length, cap: WAITING_MAX };
  },
});

/**
 * What the merge gate says about each commit the changes list draws.
 *
 * THE GATE'S OWN ANSWER, not a second reading of its three head rows:
 * convex/ttsMerge.ts mergeGateFor is what decided whether each of these merges
 * was allowed, and a page that recomputed "green" from the rows would be a
 * second definition of green that one edit could make disagree with the one
 * that actually opens the gate.
 */
export const gateRows = query({
  args: { commits: v.array(v.object({ repo: v.string(), sha: v.string() })) },
  handler: async (ctx, { commits }) => {
    await requireTom(ctx, SURFACE);
    if (commits.length > 60) throw new Error("gateRows takes at most 60 commits");
    return await Promise.all(commits.map(async ({ repo, sha }) => {
      const gate = await mergeGateFor(ctx, repo, sha);
      return {
        key: commitKey(repo, sha),
        allowed: gate.allowed,
        checks: gate.checks.map((check) => ({
          name: check.name,
          passed: check.passed,
          why: check.why,
        })),
      };
    }));
  },
});
