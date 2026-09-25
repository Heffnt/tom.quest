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
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { APPROVABLE_REPOS, changeOfCommit, newestRuling, resolveChange } from "./observeMerge";
import { mergeGateFor } from "./ttsMerge";
import { insertRuling } from "./ttsRulings";
import {
  VOCABULARY_TERMS,
  commitKey,
  isFailureKind,
  pullRequestChange,
} from "./ttsShared";
import { NEEDS_TOM } from "./ttsSlack";
import { BOX_CHANGE, DEPLOY, boxChangeOf, redactedBoxChange } from "./boxChanges";

/** The label every gate in this module names, so a denial says which surface. */
const SURFACE = "Observe";

/** The widest window the page offers, in milliseconds: one month, plus the
 *  slack a 31-day month needs. A wider one is more pages, not a different
 *  read. */
const MAX_WINDOW_MS = 40 * 24 * 60 * 60 * 1000;

/** The most rulings one window returns. Append-only at Tom's own pace. */
/** The most rulings one window's read answers with. A Convex query has a hard
 *  limit on the rows it may read and fails outright past it, so an uncapped
 *  read of a month would one day take the page down rather than shorten a
 *  list; the table runs to tens of rows a month, so this is the ceiling and
 *  not the shape of the answer. */
const RULINGS_MAX = 500;

/** How far back the waiting-on-Tom count looks for an unanswered thread. A
 *  needs-you thread older than this is not waiting, it is forgotten, and the
 *  count would be a number that only grows. */
const WAITING_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The most needs-you rows that count is allowed to read, and the reason the
 *  answer carries it: each row costs a second read for his reply, so an
 *  uncapped month would be two reads a thread against the query's own row
 *  limit, past which the page gets no answer at all rather than a short one.
 *  The count says what it read (`read`, `cap`), so a capped answer is legible
 *  as one. */
const WAITING_MAX = 200;

/** The merge row's kind (convex/ttsMerge.ts MERGE), and the delegate's two
 *  (convex/ttsAsk.ts). Spelled here rather than imported because both of those
 *  modules pull in the Slack door and the GitHub fetch, which a read-only
 *  query has no business loading. */
const MERGE_KIND = "merge";
const DELEGATE_DECISION_KIND = "delegate-decision";
const DELEGATE_OBJECTION_KIND = "delegate-objection";

/** What the map's pages box counts: an open of the TTS page, which the page
 *  itself records (convex/tts.ts recordEvent). */
const PAGE_OPENED_KIND = "tts-opened";

/** A message that went out in Tom's name on his sign-off
 *  (convex/ttsSignoff.ts SENT_AS_TOM). The rulings list shows it beside his
 *  rulings: it is his decision too, made by pressing "sign and send". */
const SENT_AS_TOM_KIND = "sent-as-tom";

/** The three head rows the merge gate reads for one commit
 *  (convex/ttsMerge.ts). */
export const GATE_KINDS = ["tests-run", "audit-verdict", "evals-run"] as const;

/** True for the event rows the failures lane draws: the one spelling of the
 *  rule, in convex/ttsShared.ts, which is also what decides whether an event
 *  becomes a #tts-broken line. Re-exported so the page's server module names
 *  what it uses. */
export { isFailureKind };

/** The kinds a page of events keeps. Everything else in the window is dropped
 *  on the server, so a page of rows is rows the page can draw rather than rows
 *  of surfacing instrumentation. */
function wanted(kind: string): boolean {
  return (
    kind === MERGE_KIND ||
    kind === DELEGATE_DECISION_KIND ||
    kind === DELEGATE_OBJECTION_KIND ||
    kind === PAGE_OPENED_KIND ||
    kind === SENT_AS_TOM_KIND ||
    // The box lane: every change to the Jarvis Box, and the deploy job's own
    // rows (plan-root T1).
    kind === BOX_CHANGE ||
    kind === DEPLOY ||
    (GATE_KINDS as readonly string[]).includes(kind) ||
    isFailureKind(kind)
  );
}

/**
 * THE FIELDS THE PAGE DRAWS, and nothing else off an event's body.
 *
 * dtsEvents.data is v.any(), and a failure row's `error` is the failed job's
 * own stderr — the nightly reports git's verbatim, and git names its remote
 * with the token in it. Every other surface that shows a failure sends that
 * string through redactSecrets first, which convex/tts.ts calls the one choke
 * point. Rather than add a second, this sends the browser the sixteen fields
 * app/observe reads and leaves the rest on the server, so there is nothing to
 * redact: a field added to a row is not on the wire until this list names it.
 */
function drawnFields(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  const drawn: Record<string, unknown> = {};
  for (const name of DRAWN_FIELDS) {
    if (row[name] !== undefined) drawn[name] = row[name];
  }
  return drawn;
}

/** A merge row's four, a failure's job, the five a delegate decision is read
 *  from, the four a message sent in Tom's name is (app/observe/lib.ts and
 *  components/rulings-list.tsx), and a deploy's two commits. A sent message's
 *  text is not among them: the row carries its hash, and the text stays with
 *  his sign-off. A box change is drawn whole, redacted (boxDrawn). */
const DRAWN_FIELDS = [
  "repo",
  "sha",
  "subject",
  "mainCheck",
  "job",
  "decision",
  "fallback",
  "question",
  "reason",
  "refused",
  "recipient",
  "channel",
  "sha256",
  "signedAt",
  // A deploy row's two commits (Jarvis worker/jobs/deploy.mjs).
  "from",
  "to",
] as const;

/** A box change's fields, all of them, with its command and change text sent
 *  through redactSecrets: the one field on this page that is a command line. */
function boxDrawn(data: unknown): Record<string, unknown> | null {
  const change = boxChangeOf(data);
  return change === null ? null : (redactedBoxChange(change) as Record<string, unknown>);
}

/** The kinds a page of events counts but never draws, so their bodies stay on
 *  the server. An audit row carries up to eight kilobytes of the audit's prose,
 *  and a month of them is megabytes a browser never opens; the changes list
 *  asks for that text by commit instead. */
const COUNTED_NOT_DRAWN = new Set<string>([...GATE_KINDS, PAGE_OPENED_KIND]);

/** The three things a window must be before it is handed to an index range.
 *  These are not niceties: a NaN bound makes `gte`/`lt` match nothing, so the
 *  page would draw an empty month rather than fail, and an unbounded window
 *  walks the whole table. A query is a door anyone signed in as Tom can call
 *  with any numbers, so the numbers are checked here rather than trusted. */
function assertWindow(from: number, to: number) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("window bounds must be numbers");
  if (to <= from) throw new Error("a window ends after it starts");
  if (to - from > MAX_WINDOW_MS) throw new Error("a window is at most a month");
}

/** A run, trimmed to what a bar on a lane needs. The transcript, the token
 *  totals and the context stay where they are: the agent page reads them, and a
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
    // WHERE THE RUN CAME FROM, verbatim. A scheduled job's is `cron:<job>`
    // (worker/jobs/tts-lib.mjs), a runner step's `runner:<id>`, a session's
    // "session" or "daemon". The timeline groups the workers lane on this, so
    // seven hundred runs of one job are one row named by the job the record
    // itself named.
    origin: run.origin,
    startedAt: run.startedAt,
    lastLineAt: run.lastLineAt,
    // The outcome a mark opens to. Four numbers and a word, which is what the
    // run row itself holds; the transcript stays on the agent page.
    endedReason: run.outcome?.endedReason ?? null,
    turns: run.outcome?.turns ?? null,
    toolCalls: run.outcome?.toolCalls ?? null,
    totalTokens: run.outcome?.totals.totalTokens ?? null,
    costUsd: run.outcome?.costUsd ?? null,
    // The merge this run's registration named, which is how the changes list
    // finds the runs that did the work of a merge. Absent on every run that
    // named none.
    mergeKey: run.mergeKey ?? null,
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
          data: COUNTED_NOT_DRAWN.has(event.kind)
            ? null
            : event.kind === BOX_CHANGE
              ? boxDrawn(event.data)
              : drawnFields(event.data),
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
      // Kept in the shape as null until app/observe stops reading it; the
      // schema narrow removes it.
      batchId: null as string | null,
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
  const { repo, externalId } = ruling;
  if (repo !== undefined && externalId !== undefined) {
    // A ruling on a pull request reads as the pull request's title.
    const pr = /^pr-(\d+)$/.exec(externalId);
    if (pr !== null) {
      const pull = await ctx.db
        .query("pullRequests")
        .withIndex("by_repo_number", (q) => q.eq("repo", repo).eq("number", Number(pr[1])))
        .first();
      if (pull !== null) return pull.title;
    }
    const mirror = await ctx.db
      .query("dtsCodeTodoMirror")
      .withIndex("by_repo_external", (q) => q.eq("repo", repo).eq("externalId", externalId))
      .first();
    return mirror?.statement ?? `${repo} ${externalId}`;
  }
  return "";
}

/**
 * EVERY LIVE RUNNER, which is what the map counts. The page used to read
 * api.ttsRunners.listRunners, the newest fifty runner rows ever created, so a
 * long-lived runner with fifty newer rows behind it left the map's count
 * quietly — a live runner the page said was not there. The live ones are their
 * own index (runners.by_ended, endedAt undefined), and there are a handful of
 * them, so they are read whole.
 */
export const liveRunners = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const live = await ctx.db
      .query("runners")
      .withIndex("by_ended", (q) => q.eq("endedAt", undefined))
      .collect();
    return Promise.all(
      live.map(async (runner) => {
        const checkIn = await ctx.db
          .query("runnerEvents")
          .withIndex("by_runner_kind_at", (q) =>
            q.eq("runnerId", runner._id).eq("kind", "check-in"),
          )
          .order("desc")
          .first();
        return {
          runnerId: runner._id as string,
          title: runner.title,
          experimentHost: runner.experimentHost,
          endedAt: null,
          lastCheckInAt: checkIn?.at ?? null,
        };
      }),
    );
  },
});

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
      // A needs-you row with no todo cannot be answered either way: the reply
      // that settles a thread is found on the todo, so counting such a row
      // would be counting something that can never stop waiting.
      if (todoId === undefined) continue;
      // His reply itself, not a page of the todo's events that might not
      // reach it: a busy todo can carry any number of rows after the thread
      // was opened, and a cutoff there counts a settled todo as still waiting.
      const replied = await ctx.db
        .query("dtsEvents")
        .withIndex("by_todo", (q) => q.eq("todoId", todoId).gte("at", event.at))
        .filter((q) => q.eq(q.field("kind"), "slack-event"))
        .first();
      if (replied !== null) continue;
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
    // Forty is what the changes list draws; the sixty is the room above it,
    // and it is here because each commit costs three indexed reads and the
    // argument comes from the browser. Without it one call could ask for a
    // year of commits and the read would be the page's whole cost.
    if (commits.length > 60) throw new Error("gateRows takes at most 60 commits");
    return await Promise.all(commits.map(async ({ repo, sha }) => {
      const key = commitKey(repo, sha);
      const gate = await mergeGateFor(ctx, repo, sha);
      // THE AUDIT'S OWN PROSE, which is the nearest thing the record keeps to
      // an account of what a change does: the audit read the diff and wrote
      // about it, and convex/ttsMerge.ts stores that text on the head row. The
      // merge row itself carries a subject and GitHub's sentence and no pull
      // request body, so this is what the expansion has to read.
      const audit = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", "audit-verdict").eq("key", key))
        .order("desc")
        .first();
      const data = (audit?.data ?? {}) as { text?: unknown; verdict?: unknown; model?: unknown };
      // The ruling this change carries, which decides whether its row shows
      // the quiet Approve or the ruled word.
      const change = await changeOfCommit(ctx, repo, sha);
      const ruling = await newestRuling(ctx, repo, change.externalId);
      return {
        key,
        ruled: ruling?.verdict ?? null,
        allowed: gate.allowed,
        checks: gate.checks.map((check) => ({
          name: check.name,
          passed: check.passed,
          why: check.why,
        })),
        audit:
          audit === null
            ? null
            : {
                at: audit.at,
                verdict: typeof data.verdict === "string" ? data.verdict : null,
                model: typeof data.model === "string" ? data.model : null,
                text: typeof data.text === "string" ? data.text : null,
              },
      };
    }));
  },
});

// ── The changes that are waiting, and Approve ───────────────────────────────

/**
 * Every open pull request of the approvable repositories, newest first, each
 * with the gate's three rows as they stand, the ruling it carries and what
 * the last landing attempt said.
 *
 * Read off the mirror convex/observeMerge.ts keeps, because a query cannot ask
 * GitHub; the mirror is at most five minutes behind.
 */
export const changesWaiting = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const out = [];
    for (const repo of APPROVABLE_REPOS) {
      const rows = await ctx.db
        .query("pullRequests")
        .withIndex("by_repo", (q) => q.eq("repo", repo))
        .collect();
      for (const row of rows) {
        if (row.closedAt !== undefined) continue;
        const gate = await mergeGateFor(ctx, repo, row.headSha);
        const ruling = await newestRuling(ctx, repo, pullRequestChange(row.number));
        out.push({
          id: row._id as string,
          repo,
          number: row.number,
          title: row.title,
          branch: row.branch,
          headSha: row.headSha,
          draft: row.draft,
          updatedAt: row.updatedAt,
          ruled: ruling?.verdict ?? null,
          allowed: gate.allowed,
          checks: gate.checks.map((check) => ({ name: check.name, passed: check.passed, why: check.why })),
          lastAttempt: row.lastAttempt ?? null,
        });
      }
    }
    return out.sort((left, right) => right.updatedAt - left.updatedAt);
  },
});

/**
 * THE APPROVE CONTROL. Records a ruling of Tom's approving one change, through
 * convex/ttsRulings.ts insertRuling, the function every ruling goes through;
 * the subject is the change (convex/ttsShared.ts pullRequestChange or
 * commitChange) and the sentence is "Approve <the change's sentence>".
 *
 * IDEMPOTENT HERE, not in the browser: a change that already carries a ruling
 * gets nothing written, and the answer is the word already ruled, so a second
 * press, a second tab or a retried request cannot write a second ruling.
 *
 * A waiting pull request also schedules the landing once, so a change whose
 * gate is already green merges at the press; one that is not green waits for
 * the five-minute refresh to find it green. A merged commit gets the ruling
 * only.
 */
export const approveChange = mutation({
  args: {
    repo: v.string(),
    number: v.optional(v.number()),
    sha: v.optional(v.string()),
  },
  handler: async (ctx, { repo, number, sha }) => {
    await requireTom(ctx, SURFACE);
    const change = await resolveChange(ctx, repo, { number, sha });
    const ruled = await newestRuling(ctx, repo, change.externalId);
    if (ruled !== null) return { written: false, ruled: ruled.verdict };
    await insertRuling(ctx, {
      repo,
      externalId: change.externalId,
      verdict: "approve",
      sentence: `Approve ${change.title}`,
    });
    if (change.open) await ctx.scheduler.runAfter(0, internal.observeMerge.landApproved, {});
    return { written: true, ruled: "approve" as const };
  },
});

// ── Definitions ──────────────────────────────────────────────────────────────

/**
 * What the record can say about one word.
 *
 * THE CANONICAL GLOSSARY IS NOT IN THE RECORD. The vocabulary's definitions
 * live in WikiTom `tts/vocabulary.json` and `tts search define` answers from
 * them on a box or a laptop with that checkout; tom.quest holds the term NAMES
 * alone (convex/ttsShared.ts VOCABULARY_TERMS says so in as many words). So
 * this reads the three published bodies the record DOES hold — the
 * model-of-Tom files, the skills and the repository rules — for the lines that
 * define the word, and answers with those lines and where each came from.
 *
 * A word the vocabulary names and none of those bodies define comes back with
 * an empty list and `inVocabulary: true`, which is a true statement about the
 * record rather than a missing answer dressed up as one.
 */
export const define = query({
  args: { term: v.string() },
  handler: async (ctx, { term }) => {
    await requireTom(ctx, SURFACE);
    const word = term.trim();
    // The longest word of the vocabulary is nowhere near eighty characters;
    // this is what stops a term from the browser becoming a regular expression
    // built over a page of text, which is scanned against every published body
    // the record holds.
    if (word === "" || word.length > 80) throw new Error("a term is one to eighty characters");
    const found: { where: string; text: string }[] = [];

    const skills = await ctx.db.query("ttsSkills").collect();
    for (const skill of skills) {
      if (skill.name.toLowerCase() === word.toLowerCase() && skill.description !== undefined) {
        found.push({ where: `skill ${skill.name}`, text: skill.description });
      }
      for (const line of definingLines(skill.body, word)) {
        found.push({ where: `skill ${skill.name}`, text: line });
      }
      for (const reference of skill.references ?? []) {
        for (const line of definingLines(reference.body, word)) {
          found.push({ where: reference.path, text: line });
        }
      }
    }

    for (const file of await ctx.db.query("modelOfTomFiles").collect()) {
      for (const line of definingLines(file.body, word)) {
        found.push({ where: file.sourcePath, text: line });
      }
    }

    for (const rule of await ctx.db.query("repoRules").collect()) {
      for (const line of definingLines(rule.body, word)) {
        found.push({ where: `${rule.repo} ${rule.path}`, text: line });
      }
    }

    return {
      term: word,
      inVocabulary: VOCABULARY_TERMS.some((known) => known.toLowerCase() === word.toLowerCase()),
      found: found.slice(0, DEFINITION_LINES_MAX),
      // Where the definition is when it is not here, said once rather than
      // guessed at by the reader.
      elsewhere: "WikiTom tts/vocabulary.json, through `tts search define`",
    };
  },
});

/** The most lines one word's answer carries, in the drawer and in each body
 *  it searches. A word of the vocabulary appears in hundreds of lines across
 *  the published bodies, and the drawer is for the line that defines it: past
 *  a dozen the reader is reading the corpus, not a definition, and the query
 *  is carrying it all to the browser to be scrolled past. */
const DEFINITION_LINES_MAX = 12;

/** The longest line kept whole; past this it is cut, because a definition the
 *  reader has to scroll a drawer for is a page, not a definition. */
const DEFINITION_LINE_MAX_CHARS = 600;

/**
 * The lines of one body that DEFINE the word rather than merely mention it.
 *
 * Three shapes, all of them shapes the corpus already writes in: the glossary
 * bullet (`- **term** — …`), the bold name anywhere in a line, and the closed
 * vocabulary's own upper-case sentence (`A BATCH holds …`). Mentions are
 * deliberately not matched: every file in the corpus says "run" and a drawer
 * holding every sentence with "run" in it defines nothing.
 */
function definingLines(body: string, term: string): string[] {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bold = new RegExp(`\\*\\*\\s*${escaped}\\s*\\*\\*`, "i");
  const bullet = new RegExp(`^\\s*[-*]\\s+\`?${escaped}\`?\\s*[—:-]\\s+\\S`, "i");
  // The term shouted, the verb either way: the vocabulary's own lines are
  // "A BATCH holds how a set of todos gets completed", so a verb that had to
  // be shouted too could not match the very form this pattern is for.
  const shouted = new RegExp(
    `\\b(?:A|AN|THE)?\\s*${escaped.toUpperCase()}\\b[^.]*\\b(?:IS|ARE|HOLDS|MEANS|is|are|holds|means)\\b`,
  );
  const hits: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (hits.length >= DEFINITION_LINES_MAX) break;
    const trimmed = line.trim();
    // A blank line defines nothing, and the shouted pattern's optional article
    // would otherwise let one through as a hit with no words in it.
    if (trimmed === "") continue;
    if (bold.test(trimmed) || bullet.test(trimmed) || shouted.test(trimmed)) {
      hits.push(trimmed.slice(0, DEFINITION_LINE_MAX_CHARS));
    }
  }
  return hits;
}
