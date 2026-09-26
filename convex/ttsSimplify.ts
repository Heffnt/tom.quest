// The weekly simplification pass's server half (the unified agent ecosystem,
// phase 8).
//
// ONE DETERMINISTIC GATHER, NO MODEL IN THE LOOP. The weekly job on the Jarvis
// Box (worker/jobs/simplify.mjs) asks GET /tts/simplify-input for the four
// weeks ending now, and everything below is a query on an index: how many runs
// there were and of what kind, which skills were offered and which used, which tools and hooks and working
// directories appeared, a bag of words off the newest runs' own transcripts,
// every gate check that ever failed, the evals' ablation deltas, and the
// proposals this pass has already made. The job adds the files themselves from
// the WikiTom checkout and makes the one model call.
//
// DESCRIPTIVE, NEVER EVALUATIVE (the weekly gather's principle 3, and the same
// reason): every fact here is a count, a list, or an age. Nothing is scored or
// ranked, and the gather writes nothing — not a todo, not an event.
//
// BOUNDED READS: every list below is read on an index with the kind or the
// time range pinned, and every one of them is `.take(n)` with a named bound.
// There is no `.collect()` in this file: the tables it reads (runs,
// claudeMessages, dtsEvents) are the three that grow with every run, and a
// read whose cost is the table is a read that works until it does not.

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { DELEGATE_OBJECTION } from "./ttsAsk";
import { DIGEST_SENT } from "./ttsDigest";
import { EVALS_RUN } from "./ttsEvals";
import { AUDIT_VERDICT, TESTS_RUN, checkRowPassed } from "./ttsMerge";
import { WEEK_MS } from "./ttsWeekly";

// ── Event kinds this pass owns ───────────────────────────────────────────────
// One spelling per kind, shared with worker/jobs/simplify.mjs and the nightly
// job by name rather than by literal.

/** One proposal the pass made: a sentence about a rule, with its evidence and
 *  its counterfactual. Keyed on the ask id, so the objection thread, the
 *  admission and the proposal are all one lookup apart. */
export const SIMPLIFY_PROPOSAL = "simplify-proposal";
/** The proposal became a todo after its objection window closed. Same key as
 *  the proposal, so "was this admitted" is a point lookup. */
export const SIMPLIFY_ADMITTED = "simplify-admitted";
/** The weekly run's own summary row, the twin of "weekly-run". */
const SIMPLIFY_RUN = "simplify-run";

// ── Event kinds the removal loop owns ────────────────────────────────────────
// worker/jobs/removal-loop.mjs, the daily job that turns one structural smell
// into one pull request. Its thread lives in #tts-simplify, but its objection
// window is THIS file's, read the same way, so the two cannot disagree about
// what "a day and a digest" means.

/** One posting of a loop pull request to #tts-simplify, keyed `loop:<number>`
 *  — the askId of its thread, so a reply resolves by one lookup. A rewrite
 *  after his reply is a NEW row on the same key with a higher `round`, and the
 *  window restarts from it. */
export const REMOVAL_LOOP_PR = "removal-loop-pr";
// The loop's own tick row, "removal-loop-run", is the job's alone: nothing
// here reads it, so it is spelled in worker/jobs/removal-loop.mjs and not here.

/** Four weeks. One week is too few runs to see a rule that nothing uses —
 *  a quiet week would propose deleting the layer nobody happened to need —
 *  and a quarter is long enough that a rule changed in week two is judged on
 *  what it said in week one. */
export const WINDOW_WEEKS = 4;
/** The most runs the gather reads for its counts. Four weeks of every host at
 *  every depth is the widest read in this file; past this the counts are
 *  FLOORS, and the facts block says so rather than reporting a smaller number
 *  as if it were the whole. */
const RUN_SCAN = 5_000;
/** The runs whose transcripts are opened for the token bag. The bag is the
 *  expensive half — a row read per run — so it is sampled where the counts are
 *  not. */
export const SAMPLE_RUNS = 150;
/** Transcript rows read per sampled run. A long run's first four hundred rows
 *  already carry its vocabulary; reading all of a fifty-thousand-row run would
 *  spend the whole budget on one of the hundred and fifty. */
const ROW_SCAN_PER_RUN = 400;
/** Distinct words kept per run. The bag answers "did this rule's words appear
 *  in this run at all", which a few hundred words settle; past that it is the
 *  same run's vocabulary repeated in a longer list. */
const TOKENS_PER_RUN = 500;
/** Distinct working directories reported. Past two hundred the list is no
 *  longer a picture of where the work happens, and a repo-rules proposal
 *  cannot be about a directory that appeared once. */
const CWD_DISTINCT_MAX = 200;
/** Gate rows read per check, over all time. A check's failure history is its
 *  whole life, not this window's: a check that has never once failed is the
 *  fact the pass is looking for, and four weeks of silence does not show it. */
const GATE_HEAD_SCAN = 2_000;
/** How far back the pass looks for what it already proposed. Eight weeks is two
 *  window-lengths: a proposal Tom let stand or objected to is not re-made the
 *  next Saturday, or the fortnight after. */
const PROPOSAL_COOLDOWN_WEEKS = 8;
/** The floor between a proposal being posted and a digest being allowed to close its window. */
export const OBJECTION_FLOOR_MS = 24 * 60 * 60 * 1000;

/** Proposal rows read per pass. The cooldown holds at most a handful of
 *  proposals a week, so this is a ceiling on a pathology, not a budget. */
const PROPOSAL_SCAN = 1_000;
/** Failing heads named in the facts block. The COUNT is exact; this is how
 *  many get a sentence, because the model needs examples, not a catalogue. */
const FAILURES_LISTED = 25;
/** The most of one tool call's input that reaches the token bag. A tool call
 *  carrying a whole file's contents would drown the run's own words in the
 *  words of whatever it happened to write. */
const TOOL_INPUT_MAX_CHARS = 2_048;
/** The shortest word the bag keeps. Below five characters the tokens are
 *  "the", "with", "run" — words that match every rule and distinguish none. */
const TOKEN_MIN_LENGTH = 5;

/** The transcript kinds whose `content.text` is the run's own words.
 *  `tool-result` IS NOT ONE OF THEM, on purpose: a tool result is a file the
 *  run read, so a rule's words appearing there says the run read a file that
 *  mentions them, not that the rule mattered to the run. The whole pass turns
 *  on that distinction — every model-of-tom rule is written down in a file
 *  some run has read — so the skip is here, at the source, and not left to a
 *  filter downstream that a later reader could drop. */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  "user",
  "assistant-text",
  "thinking",
  "system",
  "error",
]);

// ── The facts ────────────────────────────────────────────────────────────────
// Structural types, not Docs: the job's facts block and the tests read
// literals, and neither should change because a table grew a column.

export type SimplifyWindow = { since: number; until: number; weeks: number };

export type SimplifyRunCounts = {
  /** Runs read. When `capped` is true this and every count beside it are
   *  FLOORS — the window held at least this many — and the job's facts block
   *  must say so rather than print them as totals. */
  total: number;
  capped: boolean;
  byOrigin: Record<string, number>;
  byCli: Record<string, number>;
  byHost: Record<string, number>;
  byKind: Record<string, number>;
  /** Runs with a context envelope at all. */
  withContext: number;
};

export type SimplifyFacts = {
  window: SimplifyWindow;
  agents: SimplifyRunCounts;
  skills: { name: string; offered: number; used: number }[];
  // WHAT THE BOX READS. Jarvis's simplify job, worker/jobs/simplify.mjs,
  // reads `agents` on the top level and on every tools, hooks and cwds entry,
  // and each `sample` entry's tokens, never its id.
  tools: { name: string; agents: number }[];
  hooks: { name: string; agents: number }[];
  /** Distinct working directories, plus ONE row with `cwd: null` counting the
   *  runs that reported none. */
  cwds: { cwd: string | null; agents: number }[];
  /** One row per sampled run. */
  sample: { agentId: string; startedAt: number; depth: number; tokens: string[] }[];
  /** The three checks of the mechanical merge gate, by the names the deny
   *  message and the morning line already use. */
  gate: { tests: SimplifyGateCheck; audit: SimplifyGateCheck; evals: SimplifyGateCheck };
  evals: {
    runs: number;
    withAblation: number;
    ablation: { subject: string; delta: number; at: number; repo: string | null; sha: string | null }[];
  };
  priorProposals: {
    askId: string;
    rowId: string | null;
    at: number;
    dryRun: boolean;
    needsHisWords: boolean;
    admittedAt: number | null;
    objectedAt: number | null;
  }[];
};

export type SimplifyGateCheck = {
  /** Distinct keys this check has ever been recorded against. */
  heads: number;
  /** Distinct keys whose newest row did not pass. */
  failed: number;
  failures: { key: string; why: string; at: number }[];
};

export type OpenProposal = {
  /** The row's key, which is also the askId of its #tts-decisions thread and
   *  the key the admission event must carry — the one string that joins the
   *  proposal, its objection and its admission. The job keys on THIS. */
  askId: string;
  /** The pass's own 8-hex proposal id, off the row's data. It is what the
   *  provenance sentence names, and it is not the Convex document id: nothing
   *  outside this table can do anything with a document id. */
  proposalId: string | null;
  rowId: string | null;
  sentence: string | null;
  evidence: string | null;
  counterfactual: string | null;
  at: number;
  day: string | null;
  class: string | null;
  where: string | null;
  text: string | null;
  action: string | null;
  into: string | null;
};

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bump(into: Record<string, number>, name: string): void {
  into[name] = (into[name] ?? 0) + 1;
}

/** Counts, largest first and then by name. The tie-break is there so the same
 *  week measured twice prints the same list: two names with one run each have
 *  no natural order, and a list that shuffles between runs reads as a change. */
function ranked<T>(
  counts: Map<string, T>,
  runsOf: (value: T) => number,
): { name: string; value: T }[] {
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => runsOf(b.value) - runsOf(a.value) || a.name.localeCompare(b.name));
}

// ── The token bag ────────────────────────────────────────────────────────────

/** One transcript row's words, or "" for a row whose words are not the run's
 *  own. See TEXT_KINDS: `tool-result` returns "" here and always will. */
function rowText(row: Doc<"claudeMessages">): string {
  const content = (row.content ?? {}) as Record<string, unknown>;
  if (TEXT_KINDS.has(row.kind)) return str(content.text) ?? "";
  if (row.kind === "tool-call") {
    const name = str(content.name) ?? "";
    let input = "";
    try {
      input = JSON.stringify(content.input ?? null) ?? "";
    } catch {
      // A payload that will not serialize contributes its tool's name alone;
      // the bag is words, and an unserializable input has none to give.
      input = "";
    }
    return `${name} ${input.slice(0, TOOL_INPUT_MAX_CHARS)}`;
  }
  return "";
}

/** The words of one run, deduped in the order they first appeared and cut at
 *  TOKENS_PER_RUN. First appearance rather than frequency: the question the
 *  bag answers is whether a rule's words show up at all, and ordering by count
 *  would spend the cut on the run's own boilerplate. */
export function tokenBag(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const token of text.toLowerCase().split(/[^a-z0-9-]+/)) {
      if (token.length < TOKEN_MIN_LENGTH) continue;
      seen.add(token);
      if (seen.size >= TOKENS_PER_RUN) return [...seen];
    }
  }
  return [...seen];
}

// ── The gate's failure history ───────────────────────────────────────────────

/** What the row SAID, for a head checkRowPassed already judged a failure. The
 *  judgment is not made here and must not be: convex/ttsMerge.ts owns what a
 *  passed check is, and two copies of that is one of them wrong. This names
 *  the field the check reads so the sentence is about this head rather than
 *  about the kind. */
function failureWhy(kind: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  if (kind === TESTS_RUN) {
    const detail = str(d.detail);
    return detail === null ? "the tests were not green" : `the tests were not green — ${detail}`;
  }
  if (kind === AUDIT_VERDICT) {
    const verdict = str(d.verdict);
    return `the audit answered ${verdict === null ? "nothing readable" : verdict.toUpperCase()}`;
  }
  if (kind === EVALS_RUN) {
    const regressions = num(d.regressions);
    return regressions === null
      ? "the evals reported no readable regression count"
      : `the evals found ${regressions} regression${regressions === 1 ? "" : "s"}`;
  }
  return "the check did not pass";
}

/**
 * One gate check's whole life. Read over ALL TIME rather than over the window:
 * a check that has failed twice in a year is a different thing from a check
 * that has never failed, and four weeks cannot tell them apart.
 *
 * Newest-first, and the first row seen for a key is the one judged — a head
 * whose check was re-recorded is judged on what it says now, not on the first
 * answer it ever gave.
 */
async function gateCheck(ctx: QueryCtx, kind: string): Promise<SimplifyGateCheck> {
  const rows = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_at", (q) => q.eq("kind", kind))
    .order("desc")
    .take(GATE_HEAD_SCAN);
  const judged = new Set<string>();
  const failures: { key: string; why: string; at: number }[] = [];
  let failed = 0;
  for (const row of rows) {
    // A row with no key is about no head. A MISSING ROW IS NOT A HEAD either:
    // nothing here invents a head out of a commit that was never checked.
    const key = row.key;
    if (key === undefined || judged.has(key)) continue;
    judged.add(key);
    if (checkRowPassed(kind, row.data)) continue;
    failed += 1;
    if (failures.length < FAILURES_LISTED) {
      failures.push({ key, why: failureWhy(kind, row.data), at: row.at });
    }
  }
  return { heads: judged.size, failed, failures };
}

// ── The gather ───────────────────────────────────────────────────────────────

/**
 * Every fact of the four weeks ending at `until`, read on indexes.
 *
 * The counts over `runs` are EXACT over every run in the window unless
 * `runs.capped` is true, in which case they are floors and the job says so.
 * Only the sample is sampled: SAMPLE_RUNS runs, newest first.
 */
export const internalSimplifyInput = internalQuery({
  args: { until: v.number() },
  handler: async (ctx, { until }): Promise<SimplifyFacts> => {
    const since = until - WINDOW_WEEKS * WEEK_MS;

    // NEWEST-FIRST, not oldest-first. The counts are the same either way while
    // the window fits in RUN_SCAN; when it does not, descending keeps the
    // sample meaning "the newest runs in the window" instead of "the newest of
    // whatever prefix the cap happened to reach".
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_started", (q) => q.gte("startedAt", since).lte("startedAt", until))
      .order("desc")
      .take(RUN_SCAN);

    const counts: SimplifyRunCounts = {
      total: runs.length,
      capped: runs.length >= RUN_SCAN,
      byOrigin: {},
      byCli: {},
      byHost: {},
      byKind: {},
      withContext: 0,
    };
    const skills = new Map<string, { offered: number; used: number }>();
    const tools = new Map<string, number>();
    const hooks = new Map<string, number>();
    const cwds = new Map<string, number>();
    let cwdless = 0;

    const skill = (name: string) => {
      const row = skills.get(name) ?? { offered: 0, used: 0 };
      skills.set(name, row);
      return row;
    };

    for (const run of runs) {
      bump(counts.byOrigin, run.origin);
      bump(counts.byCli, run.cli);
      bump(counts.byHost, run.host);
      bump(counts.byKind, run.kind);
      const context = run.context;
      if (context === undefined) {
        cwdless += 1;
        continue;
      }
      counts.withContext += 1;
      // Deduped per run: a run that lists a tool twice used one tool, and the
      // number reported is runs, not mentions.
      for (const name of new Set(context.skillsOffered)) skill(name).offered += 1;
      for (const name of new Set(context.skillsUsed)) skill(name).used += 1;
      for (const name of new Set(context.tools)) tools.set(name, (tools.get(name) ?? 0) + 1);
      for (const name of new Set(context.hooks)) hooks.set(name, (hooks.get(name) ?? 0) + 1);
      if (context.cwd === undefined) cwdless += 1;
      else cwds.set(context.cwd, (cwds.get(context.cwd) ?? 0) + 1);
    }

    // The token bag, off the newest SAMPLE_RUNS runs. Newest-first rather than
    // random: the same week measured twice must give the same answer, and a
    // sample that moves turns every re-run into a diff nobody can read.
    const sample: SimplifyFacts["sample"] = [];
    for (const run of runs.slice(0, SAMPLE_RUNS)) {
      const rows = await ctx.db
        .query("claudeMessages")
        .withIndex("by_run_seq", (q) => q.eq("runId", run.runId))
        .take(ROW_SCAN_PER_RUN);
      sample.push({
        agentId: run.runId,
        startedAt: run.startedAt,
        depth: run.depth,
        tokens: tokenBag(rows.map(rowText)),
      });
    }

    const [tests, audit, evalsGate] = await Promise.all([
      gateCheck(ctx, TESTS_RUN),
      gateCheck(ctx, AUDIT_VERDICT),
      gateCheck(ctx, EVALS_RUN),
    ]);

    // The evals' ablation deltas, IN THE WINDOW — unlike the gate history,
    // this is a measurement of the current rules and an old one says nothing
    // about them. Phase 7 has not landed `data.ablation` yet, so it is read
    // defensively and ABSENT IS A VALUE HERE, NEVER AN ASSUMPTION: the pass
    // reports withAblation: 0 and the facts block says the deltas are not
    // being measured, which is not the same claim as a delta of zero.
    const evalRows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", EVALS_RUN).gte("at", since).lte("at", until))
      .take(GATE_HEAD_SCAN);
    let withAblation = 0;
    const ablation: SimplifyFacts["evals"]["ablation"] = [];
    for (const row of evalRows) {
      const data = (row.data ?? {}) as Record<string, unknown>;
      if (!Array.isArray(data.ablation)) continue;
      const entries = data.ablation
        .map((entry) => (entry ?? {}) as Record<string, unknown>)
        .map((entry) => ({ subject: str(entry.subject), delta: num(entry.delta) }))
        .filter((entry): entry is { subject: string; delta: number } =>
          entry.subject !== null && entry.delta !== null,
        );
      if (entries.length === 0) continue;
      withAblation += 1;
      for (const entry of entries) {
        ablation.push({ ...entry, at: row.at, repo: str(data.repo), sha: str(data.sha) });
      }
    }

    // What this pass already said, over the cooldown. Each proposal is joined
    // to its objection and its admission by the one key all three share.
    const proposals = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) =>
        q.eq("kind", SIMPLIFY_PROPOSAL).gte("at", until - PROPOSAL_COOLDOWN_WEEKS * WEEK_MS).lte("at", until),
      )
      .order("desc")
      .take(PROPOSAL_SCAN);
    const priorProposals: SimplifyFacts["priorProposals"] = [];
    for (const row of proposals) {
      const askId = row.key;
      if (askId === undefined) continue;
      const data = (row.data ?? {}) as Record<string, unknown>;
      const [admitted, objected] = await Promise.all([
        keyedRow(ctx, SIMPLIFY_ADMITTED, askId),
        keyedRow(ctx, DELEGATE_OBJECTION, askId),
      ]);
      priorProposals.push({
        askId,
        rowId: str(data.rowId),
        at: row.at,
        dryRun: data.dryRun === true,
        needsHisWords: data.needsHisWords === true,
        admittedAt: admitted?.at ?? null,
        objectedAt: objected?.at ?? null,
      });
    }

    return {
      window: { since, until, weeks: WINDOW_WEEKS },
      agents: counts,
      skills: ranked(skills, (row) => row.offered + row.used).map(({ name, value }) => ({
        name,
        ...value,
      })),
      tools: ranked(tools, (n) => n).map(({ name, value }) => ({ name, agents: value })),
      hooks: ranked(hooks, (n) => n).map(({ name, value }) => ({ name, agents: value })),
      cwds: [
        ...ranked(cwds, (n) => n)
          .slice(0, CWD_DISTINCT_MAX)
          .map(({ name, value }) => ({ cwd: name as string | null, agents: value })),
        // Always present, even at zero: "no run reported a directory" and "the
        // question was not asked" are different answers, and a row that
        // vanishes when it is zero cannot say the first.
        { cwd: null, agents: cwdless },
      ],
      sample,
      gate: { tests, audit, evals: evalsGate },
      evals: { runs: evalRows.length, withAblation, ablation },
      priorProposals,
    };
  },
});

/** The newest row of one kind against one key. */
async function keyedRow(ctx: QueryCtx, kind: string, key: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .order("desc")
    .first();
}

// ── The objection window ─────────────────────────────────────────────────────

/**
 * The proposals whose window has closed: Tom has seen them in a morning
 * message, had a day to answer, and did not.
 *
 * THE 24-HOUR FLOOR. The pass posts at 04:30 and the digest goes at 05:00, so
 * without a floor the digest thirty minutes later would close the window on a
 * proposal he had had half an hour to see. With the floor, Friday's digest
 * prints it and Saturday's closes it: one morning to read it, one full day to
 * answer.
 *
 * The floor is on the CLOCK and the close is on a DIGEST — both, not either.
 * A morning the digest failed therefore closes nothing silently; the next one
 * does, and the proposal waits rather than expiring into a todo on a day
 * nothing was sent.
 *
 * Three things are never open, for three different reasons:
 *   dryRun        — for ever. A dry run's proposal was never posted to him,
 *                   so no silence of his stands behind it.
 *   needsHisWords — never admitted and never expired. It stands parked in
 *                   #tts-decisions until he rules; silence is not an answer to
 *                   a question only he can answer.
 *   admitted      — already a todo. Admitting it twice is two todos.
 * And an objection closes it the other way: he answered.
 */
export const internalOpenProposals = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<OpenProposal[]> => {
    const now = args.now ?? Date.now();
    const proposals = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) =>
        q.eq("kind", SIMPLIFY_PROPOSAL).gte("at", now - PROPOSAL_COOLDOWN_WEEKS * WEEK_MS).lte("at", now),
      )
      .take(PROPOSAL_SCAN);

    const open: OpenProposal[] = [];
    for (const row of proposals) {
      const askId = row.key;
      if (askId === undefined) continue;
      const data = (row.data ?? {}) as Record<string, unknown>;
      if (data.dryRun === true || data.needsHisWords === true) continue;
      const [admitted, objected] = await Promise.all([
        keyedRow(ctx, SIMPLIFY_ADMITTED, askId),
        keyedRow(ctx, DELEGATE_OBJECTION, askId),
      ]);
      if (admitted !== null || objected !== null) continue;
      // The window's second half is a bounded range read on the record's
      // by_kind_at from the floor forward (convex/jarvis/digest.ts writes the
      // rows) — one row is enough, because the question is whether ANY digest
      // went out after it.
      const sent = await ctx.db
        .query("events")
        .withIndex("by_kind_at", (q) =>
          q.eq("kind", DIGEST_SENT).gt("at", row.at + OBJECTION_FLOOR_MS),
        )
        .take(1);
      if (sent.length === 0) continue;
      open.push({
        askId,
        proposalId: str(data.id),
        rowId: str(data.rowId),
        sentence: str(data.sentence),
        evidence: str(data.evidence),
        counterfactual: str(data.counterfactual),
        at: row.at,
        day: str(data.day),
        class: str(data.class),
        where: str(data.where),
        text: str(data.text),
        action: str(data.action),
        into: str(data.into),
      });
    }
    // Oldest first: the proposal that has waited longest is admitted first, so
    // a cap downstream cuts the newest rather than the one he has seen most.
    return open.sort((a, b) => a.at - b.at);
  },
});

// ── The removal loop's window ────────────────────────────────────────────────

/** How far back the loop's postings are read. The loop holds one pull request
 *  open at a time and merges or closes it within days; a month is a ceiling on
 *  a stuck one, not a budget. */
const REMOVAL_SCAN_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows read. One posting a day and a few rewrites fit in a hundred. */
const REMOVAL_SCAN = 200;

type OpenRemoval = {
  /** `loop:<number>`, the thread's askId and the posting row's key. */
  askId: string;
  pr: number | null;
  url: string | null;
  subject: string | null;
  /** Rewrites so far. The window below is measured from THIS round's post. */
  round: number;
  /** When this round was posted. */
  at: number;
  /** His newest reply AFTER this round was posted, or null. A reply to an
   *  earlier round was already answered by the rewrite that made this one. */
  objection: { at: number; text: string | null; revert: boolean } | null;
  /** No objection to this round, a day has passed since it was posted, and a
   *  digest went out after that. The loop merges only on this. */
  windowClosed: boolean;
};

/**
 * Every loop pull request posted in the last month, as of its newest round.
 *
 * A NEAR-COPY OF internalOpenProposals above, on purpose: the same
 * OBJECTION_FLOOR_MS, the same one-row DIGEST_SENT range read, the same
 * DELEGATE_OBJECTION point lookup. It differs in two ways, each for a reason.
 * It RETURNS the objected ones instead of dropping them, because a reply to a
 * loop pull request is not the end of it — the loop rewrites the branch from
 * his words, and it needs the words. And an objection counts only when it is
 * newer than the round's post, because the rewrite answered the older ones.
 *
 * A dry run's posting is never returned: it went to nobody.
 */
export const internalOpenRemovals = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<OpenRemoval[]> => {
    const now = args.now ?? Date.now();
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", REMOVAL_LOOP_PR).gte("at", now - REMOVAL_SCAN_MS).lte("at", now))
      .order("desc")
      .take(REMOVAL_SCAN);

    const out: OpenRemoval[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const askId = row.key;
      // Newest first, so the first row seen for a key is its current round.
      if (askId === undefined || seen.has(askId)) continue;
      seen.add(askId);
      const data = (row.data ?? {}) as Record<string, unknown>;
      if (data.dryRun === true) continue;
      const objected = await keyedRow(ctx, DELEGATE_OBJECTION, askId);
      const objection =
        objected !== null && objected.at > row.at
          ? (() => {
              const d = (objected.data ?? {}) as Record<string, unknown>;
              return { at: objected.at, text: str(d.text), revert: d.revert === true };
            })()
          : null;
      let windowClosed = false;
      if (objection === null) {
        const sent = await ctx.db
          .query("events")
          .withIndex("by_kind_at", (q) => q.eq("kind", DIGEST_SENT).gt("at", row.at + OBJECTION_FLOOR_MS))
          .take(1);
        windowClosed = sent.length > 0 && now > row.at + OBJECTION_FLOOR_MS;
      }
      out.push({
        askId,
        pr: num(data.pr),
        url: str(data.url),
        subject: str(data.subject),
        round: num(data.round) ?? 0,
        at: row.at,
        objection,
        windowClosed,
      });
    }
    return out.sort((a, b) => a.at - b.at);
  },
});
