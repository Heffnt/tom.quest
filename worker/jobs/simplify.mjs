#!/usr/bin/env node
// simplify.mjs — THE WEEKLY SIMPLIFICATION PASS (the unified agent ecosystem,
// phase 8; spec §23.9). One run a week, 4:30 a.m. New York on Fridays, half an
// hour behind the weekly agenda job.
//
// WHAT IT DOES, in order:
//
//   0. the objection window — GET /tts/simplify-open: the proposals posted in
//      an earlier week that Tom has neither objected to nor been asked to
//      settle. Each becomes one todo, and the branch that removes the thing is
//      opened from that todo like any other work. At most ADMIT_PER_RUN a run.
//   1. the measurement — GET /tts/simplify-input over four weeks of recorded
//      runs, plus what only a checkout can answer: the schema's fields and
//      their grep counts, every rule line in agent-rules.md and in this
//      repository's AGENTS.md files, and the Guardrails jobs' history.
//   2. the blast-radius table — one row per rule, skill, schema field and
//      merge/CI check, each carrying how many otherwise unrelated runs had to
//      load it, satisfy it or branch on it, and a `candidate` THIS JOB
//      computes: remove, collapse, or keep.
//   3. one Fable call whose only permitted answer is a list of removals or
//      collapses drawn from rows the measurement already marked removable.
//   4. the parse, which refuses anything the measurement does not support —
//      a row marked keep, an action that is not that row's candidate, an
//      evidence sentence carrying a number that is not that row's.
//   5. one #tts-decisions message per survivor, posted THROUGH CONVEX (a
//      "simplify-proposal" event; convex/ttsSimplify.ts sends it), never to
//      Slack directly.
//
// THE JOB EXECUTES NO REMOVAL. Silence on a proposal lets a LATER run file it
// as a todo (step 0), and the actual deletion lands through the audit, the
// evals and the merge gate like every other change. The cost of checking the
// window here rather than in a new daily job is stated plainly: a proposal
// waits up to seven days before its branch is opened. That is the trade this
// pass exists to argue for — a daily check that finds nothing six days out of
// seven is exactly the shape of thing this job proposes deleting.
//
// BOUNDARIES.
//   - It never writes tts/spec.md and never writes model-of-tom/intent.md. It
//     reads those two files for one purpose — deciding which rows are Tom's
//     words to change rather than his silence's — and for nothing else.
//   - It reads the WikiTom checkout READ-ONLY. It takes no worktree and no
//     writer lock, because it never writes there.
//   - It posts nothing to #tts-today. Its only Slack output is one
//     #tts-decisions message per proposal, through the shared decisions door.
//   - It touches no credential, opens no branch, and runs no git command that
//     writes. `git grep` and `gh run list` are its only two.
//   - It mints exactly three event kinds: simplify-proposal, simplify-admitted,
//     simplify-run. A failure is a "job-failed" row like every other job's.
//   - It changes no merge-gate check.
//   - It proposes nothing about a run of Tom's own. The measurement is over
//     rules, skills, fields and checks — never over people, sessions or todos.
//
// By hand:
//   node /opt/tts/simplify.mjs --force              (outside the 4 a.m. hour)
//   node /opt/tts/simplify.mjs --force --print-facts (the facts block, no model)
//   node /opt/tts/simplify.mjs --force --dry-run    (measure, ask, print, post nothing)
//   node /opt/tts/simplify.mjs --force --overwrite  (a day already run)
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule). Every side effect
// goes through the injected `io`, so simplify.test.mjs runs the whole job with
// no model, no git, no gh and no network. Never prints TTS_WORKER_KEY.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  JSON_ONLY_ANSWER,
  MODELS,
  convexFetch,
  extractJsonObject,
  loadEnv,
  nyHour,
  reportJobFailed,
  reportJobOk,
  runClaude,
} from "./tts-lib.mjs";
import { WIKITOM_DIR, utcDay } from "./session-archive.mjs";

// ── The numbers, and the one reason each is that number ──────────────────────

/** Four weeks, because spec §23.4 evicts every run older than thirty days from
 *  Convex. This is the window the record actually HOLDS — not a judgement
 *  about how much history is enough — and the facts block says so in those
 *  words so the model never reads four weeks as a considered choice. */
export const WINDOW_WEEKS = 4;
/** The run rows Convex walks for the window. Five thousand is above four
 *  weeks of the fleet at its current rate with room for a busy month; past it
 *  the facts block says the count is capped rather than reporting a total it
 *  did not reach. */
export const RUN_SCAN = 5_000;
/** The runs whose transcripts are read for the proxy. A hundred and fifty is
 *  the largest sample one prompt can carry a token bag for and still leave
 *  room for the table; the proxy's job is to find rules scoring NEAR ZERO, and
 *  that signal does not need a census. */
export const SAMPLE_RUNS = 150;
/** Rows read per sampled run. A run's rules, if they mattered at all, show in
 *  its first few hundred rows; past that a long agentic run would drown a
 *  short session's evidence purely by being long. */
export const ROW_SCAN_PER_RUN = 400;
/** Distinct tokens kept per sampled run. The bag is a SET, so five hundred
 *  distinct words is a run's whole vocabulary and not a length measurement. */
export const TOKENS_PER_RUN = 500;
/** Distinct working directories listed. Past two hundred the tail is one run
 *  each and tells the AGENTS.md attribution nothing it does not already know. */
export const CWD_DISTINCT_MAX = 200;
/** Commits the merge-gate history is read over. Two thousand heads is more
 *  than four weeks of either repository, so a gate check's failure count is
 *  the real one rather than a window's edge. */
export const GATE_HEAD_SCAN = 2_000;
/** Guardrails workflow runs `gh run list` is asked for. A hundred is its own
 *  API page size — asking for more costs a second round trip to learn about
 *  commits older than the window. */
export const GH_RUN_SCAN = 100;
/** Failed Guardrails runs whose per-job breakdown is fetched. Each is one more
 *  API call, and twenty-five failures is already enough to tell a job that
 *  fails from a job that never has. */
export const GH_FAILED_JOB_SCAN = 25;
/** The model. Judging what a system can lose is the hardest judgement the
 *  fleet makes, and this is one call a week over a bounded prompt. */
export const SIMPLIFY_MODEL = MODELS.simplify;
/** Fifteen minutes, the same budget the weekly agenda's one model call takes:
 *  a single non-agentic completion over a large prompt. */
export const SIMPLIFY_TIMEOUT_MS = 15 * 60 * 1000;
/** The non-agentic default (tts-lib runClaude). The facts block carries every
 *  rule line verbatim, so the run needs no tool call at all; the turns are
 *  headroom for a stray one, not a budget to work in. */
export const SIMPLIFY_MAX_TURNS = 8;
/** Five proposals. More than five in one week is not a week's worth of
 *  evidence, it is a model filling a list; the prompt says zero is common. */
export const MAX_PROPOSALS = 5;
/** Eight weeks before the same row may be proposed again. Two months is long
 *  enough that a re-proposal is made from a genuinely different four weeks
 *  rather than from the same runs read twice. */
export const PROPOSAL_COOLDOWN_WEEKS = 8;
/** Three admissions a run, for the reason CODE_MISSIONS_PER_TICK = 1 gives:
 *  removals land in series so each stays reviewable. The run event says how
 *  many waited. */
export const ADMIT_PER_RUN = 3;
/** The minimum runs (or heads) a removal may be argued from. Below twenty the
 *  absence of evidence is the sample being small, and a removal proposed from
 *  three runs is a coin toss wearing a number. */
export const MIN_LOADED = 20;
/** The facts TEXT's cap. Sixty kilobytes is a prompt the model reads whole;
 *  past it `keep` rows are dropped from the bottom, since the model may not
 *  propose from them anyway, and the block says how many went. */
export const FACTS_TEXT_MAX_BYTES = 60 * 1024;

/** The three kinds this job mints, and no others. */
export const SIMPLIFY_PROPOSAL = "simplify-proposal";
export const SIMPLIFY_ADMITTED = "simplify-admitted";
export const SIMPLIFY_RUN = "simplify-run";

// ── Where things are ─────────────────────────────────────────────────────────

/** The tom.quest checkout the schema, the AGENTS.md files and `git grep` are
 *  read from. On the box this is the shallow cache clone evals.mjs already
 *  keeps fresh (tts-code-lib.mjs cacheRepoDir); /opt/tts is a flat install and
 *  is not a checkout, so the job cannot read its own repository from where it
 *  runs. Absent, the run measures the rules of agent-rules.md alone and says
 *  in the facts block that the repository was not readable. */
export const TOMQUEST_DIR = process.env.TOMQUEST_DIR || "/var/cache/tts/tom.quest";

/** The operate layer — the base every run carries, and what a skill that fires
 *  on nearly every run collapses into. */
export const OPERATE_FILE = "model-of-tom/agent-rules.md";
/** The two files a proposal may not change on Tom's silence. Read, never
 *  written, and for one purpose only: `needsHisWords`. */
export const SPEC_PATH = "tts/spec.md";
export const INTENT_PATH = "model-of-tom/intent.md";

/** The trees `git grep` searches for a schema field's name. */
export const GREP_DIRS = ["app", "convex", "worker", "scripts", "vqc", "turing-api"];
/** What a field's own definition and its generated mirrors do not count as. */
export const GREP_EXCLUDES = [
  ":(exclude)convex/schema.ts",
  ":(exclude)convex/_generated",
  ":(exclude)*.test.*",
];

/** The three heads of the mechanical merge gate (convex/ttsMerge.ts). */
export const GATE_CHECKS = ["tests", "audit", "evals"];
/** The three jobs of .github/workflows/guardrails.yml. */
export const GUARDRAILS_JOBS = ["static-boundaries", "secret-scan", "tests"];
/** The five scripts `pnpm check:guardrails` runs inside static-boundaries.
 *  Their pass/fail history is inside that job's log, and this job does not
 *  parse logs — so each row says `failuresKnown: false` and is forced to
 *  keep. */
export const STATIC_BOUNDARY_SCRIPTS = [
  "check-auth-boundary",
  "check-agents-md",
  "check-heavy-libs",
  "check-session-mirrors",
  "check-large-files",
];

/** The directory walk's skip list, taken from scripts/check-agents-md.mjs so
 *  the two cannot disagree about which AGENTS.md files exist. */
export const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".vercel",
  "out",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** The one-run-per-day marker. See the guard in runSimplify for why this is a
 *  local file and not a Convex read. */
export const MARKER_DIR = process.env.TTS_SIMPLIFY_MARKER_DIR || "/var/lib/tts";

// ── Words ────────────────────────────────────────────────────────────────────

/**
 * The proxy's stopwords: words of five letters or more that carry no subject.
 * Kept here rather than fetched, because the proxy's bias has to be readable
 * beside the code that applies it — a stopword list that changes under the job
 * changes every `mattered` count silently.
 */
export const STOPWORDS = new Set([
  "about", "again", "against", "already", "among", "another", "anything", "after",
  "always", "because", "before", "being", "between", "cannot", "could", "doing",
  "during", "each", "every", "everything", "except", "first", "having", "himself",
  "however", "instead", "itself", "least", "makes", "meaning", "means", "never",
  "nothing", "order", "other", "rather", "really", "second", "should", "simply",
  "since", "something", "still", "such", "their", "there", "these", "thing",
  "things", "third", "those", "through", "therefore", "under", "unless", "until",
  "usually", "whatever", "whenever", "where", "which", "while", "whose", "without",
  "within", "would", "actually",
]);

/** The caveat the facts block states in these words, and the prompt repeats. */
export const PROXY_CAVEAT =
  'The proxy is deliberately biased toward "it mattered": a run that merely talks about commits matches a rule about commits without the rule having changed anything, so the proxy over-counts. That is the safe direction — it makes a removal harder to propose, never easier. A rule that still scores near zero against a generous proxy is real evidence.';

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Eight hex characters of sha256. Short enough to say aloud in Slack, long
 *  enough that two rows of a few hundred do not collide. */
export function hash8(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 8);
}

/** One rule line's identity: the hash of its normalized text, NOT its line
 *  number. Line numbers move when a line above them is deleted, which is
 *  precisely what this job proposes; a hash names the same rule across weeks
 *  and across a re-ordering of the file. */
export function ruleId(line) {
  const normalized = String(line)
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return hash8(normalized);
}

/** Every line of a rules file that is a rule: not a heading, not blank. */
export function ruleLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text: t }) => t !== "" && !t.startsWith("#"));
}

/** A line's subject words: five letters or more, lowercased, deduplicated,
 *  minus the stopwords. A set, because every comparison below is a set one. */
export function nounsOf(text) {
  const seen = new Set();
  for (const word of String(text ?? "").toLowerCase().match(/[a-z][a-z0-9_.-]*/g) ?? []) {
    const bare = word.replace(/^[._-]+|[._-]+$/g, "");
    if (bare.length >= 5 && !STOPWORDS.has(bare)) seen.add(bare);
  }
  return [...seen];
}

/** Set overlap over union. Two empty sets share nothing: 0, not 1 — a line
 *  with no subject words must never collapse into another line with none. */
export function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * How many sampled runs plausibly had this rule bear on them.
 *
 * A run counts when its token bag holds at least half the line's nouns (and at
 * least two). This OVER-counts on purpose — see PROXY_CAVEAT. A line with
 * fewer than two nouns is not measurable this way at all and answers null,
 * which forces its row to keep.
 */
export function proxyMattered(nouns, sample) {
  if (!Array.isArray(nouns) || nouns.length < 2) return null;
  const need = Math.max(2, Math.ceil(nouns.length / 2));
  let mattered = 0;
  for (const run of sample ?? []) {
    const bag = new Set((run?.tokens ?? []).map((t) => String(t).toLowerCase()));
    let hit = 0;
    for (const noun of nouns) {
      if (bag.has(noun)) hit += 1;
      if (hit >= need) break;
    }
    if (hit >= need) mattered += 1;
  }
  return mattered;
}

// ── (a) Schema fields ────────────────────────────────────────────────────────

/**
 * The top-level fields of every table in convex/schema.ts.
 *
 * A table opens at `  <name>: defineTable({` and closes at the first `  })` in
 * the first column pair; a field is a line at four spaces reading `<name>: v.`.
 *
 * NESTED OBJECT FIELDS ARE NOT COLLECTED. A field inside `v.object({ … })`
 * sits at six spaces or deeper and is skipped, and the facts block says so in
 * one sentence. Half-collecting them — taking the ones whose formatting
 * happens to land at four spaces — would put rows in the table whose grep
 * counts mean something different from every other row's.
 */
export function schemaFields(text) {
  const fields = [];
  let table = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (table === null) {
      const open = /^ {2}(\w+): defineTable\(\{/.exec(raw);
      if (open) table = open[1];
      continue;
    }
    if (/^ {2}\}\)/.test(raw)) {
      table = null;
      continue;
    }
    const field = /^ {4}(\w+): v\./.exec(raw);
    if (field) fields.push({ table, name: field[1] });
  }
  return fields;
}

/**
 * How many lines outside the schema mention each name, as an UPPER BOUND.
 *
 * One `git grep -n -w -E` per batch of fifty names as a single alternation,
 * over the six trees a field could be used in. `git grep` EXITS 1 WHEN NOTHING
 * MATCHED, which is not a failure — it is the answer zero, and the one answer
 * this measurement acts on.
 *
 * THE RULE THE COUNT OBEYS: `count === 0` is evidence FOR removing. A non-zero
 * count is recorded and is NEVER evidence for keeping, because a field named
 * `path` or `status` collides with every other use of the word. The table
 * heads this column "grep count (upper bound)" for that reason.
 */
export function grepCounts(names, io, { dir }) {
  const counts = new Map(names.map((name) => [name, 0]));
  const failures = [];
  for (let at = 0; at < names.length; at += 50) {
    const batch = names.slice(at, at + 50);
    const result = io.git(["grep", "-n", "-w", "-E", batch.join("|"), "--", ...GREP_DIRS, ...GREP_EXCLUDES], dir);
    // Exit 1 with no output is "no match". Anything else with no output that
    // also reported an error is a real failure and is recorded as one, because
    // a grep that did not run would otherwise read as every field unused.
    if (!result.ok && result.status !== 1) {
      failures.push(`git grep failed for ${batch.length} field name(s): ${String(result.error ?? "").slice(0, 200)}`);
      continue;
    }
    const tests = batch.map((name) => [name, new RegExp(`\\b${name}\\b`)]);
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line === "") continue;
      // path:line:text — take the text, so a field name that is also a
      // directory name is not counted from the path of every file in it.
      const text = line.split(":").slice(2).join(":");
      for (const [name, test] of tests) if (test.test(text)) counts.set(name, counts.get(name) + 1);
    }
  }
  return { counts, failures };
}

// ── (b) Rules ────────────────────────────────────────────────────────────────

/** Every AGENTS.md in the checkout, by the walk and the skip list
 *  scripts/check-agents-md.mjs uses. Paths come back repo-relative and
 *  forward-slashed, which is the form the cwd comparison needs. */
export function findAgentsFiles(root, io) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = io.readDir(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(file);
        continue;
      }
      if (entry.name === "AGENTS.md") {
        found.push(path.relative(root, file).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The runs that loaded one AGENTS.md.
 *
 * A recorded cwd is a path on the machine that ran (`/root/tomquest/worker`)
 * and this checkout is somewhere else entirely, so the two cannot be compared
 * as absolute paths. What IS comparable is the file's directory relative to
 * the repository root: `worker/AGENTS.md` is loaded by a run whose cwd is that
 * directory or under it, wherever the checkout sits. So the match is on the
 * repo-relative directory as a path suffix of the cwd, segment-aligned and
 * case-insensitive — the box is Linux, and this checkout and the fixtures are
 * Windows.
 *
 * THE ROOT AGENTS.md is the one file this cannot see directly: its
 * repo-relative directory is "", which is a suffix of every path including
 * another repository's. Its cwd set is therefore every cwd whose path passes
 * through a directory named like this checkout — a LOWER BOUND, which is the
 * safe direction, since a smaller `loaded` makes MIN_LOADED harder to reach
 * and a removal harder to propose. The facts block says the root file's count
 * is a lower bound.
 *
 * Runs with `cwd: null` are NEVER folded in. They go to `loadedUnknown`, which
 * the row carries beside `loaded` and no rule reads: absent is a value, not an
 * assumption about where those runs were.
 */
export function loadedForAgentsFile(relDir, cwds, { repoName }) {
  const needle = (relDir === "" ? repoName : relDir).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  let loaded = 0;
  let loadedUnknown = 0;
  for (const entry of cwds ?? []) {
    const runs = Number(entry?.runs ?? 0) || 0;
    if (entry?.cwd === null || entry?.cwd === undefined) {
      loadedUnknown += runs;
      continue;
    }
    const cwd = String(entry.cwd).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    if (cwd === needle || cwd.endsWith(`/${needle}`) || cwd.includes(`/${needle}/`)) loaded += runs;
  }
  return { loaded, loadedUnknown };
}

// ── (d) Checks ───────────────────────────────────────────────────────────────

/**
 * The three Guardrails jobs' history, from `gh`.
 *
 * `gh run list` gives the runs and their conclusions; the per-JOB breakdown
 * needs one API call per failed run, so only the failures are fetched and only
 * GH_FAILED_JOB_SCAN of them — a job that fails is visible in twenty-five
 * failures, and a job that never has is what the counterfactual question is
 * about anyway.
 *
 * `gh` ABSENT OR UNAUTHENTICATED IS NOT ZERO FAILURES. It is `known: false`,
 * the row says which, and the row is forced to keep: "no history was read" is
 * not evidence of anything (spec §23.9).
 */
export function guardrailsChecks(io, { dir }) {
  const blank = GUARDRAILS_JOBS.map((name) => ({
    id: hash8(`check|guardrails|${name}`),
    where: ".github/workflows/guardrails.yml",
    text: `the ${name} job of the Guardrails workflow`,
    failed: 0,
    heads: 0,
    known: false,
    why: null,
  }));
  const listed = io.gh(
    ["run", "list", "--workflow", "guardrails.yml", "--limit", String(GH_RUN_SCAN), "--json", "conclusion,headSha,createdAt,databaseId"],
    dir,
  );
  if (!listed.ok) {
    for (const row of blank) row.why = `gh could not list the Guardrails runs: ${String(listed.error ?? "").slice(0, 120)}`;
    return blank;
  }
  let runs;
  try {
    runs = JSON.parse(listed.stdout);
  } catch (error) {
    for (const row of blank) row.why = `gh returned something that is not JSON: ${String(error.message).slice(0, 120)}`;
    return blank;
  }
  if (!Array.isArray(runs)) {
    for (const row of blank) row.why = "gh returned no array of runs";
    return blank;
  }
  const heads = new Set(runs.map((run) => run?.headSha).filter(Boolean)).size;
  const failedRuns = runs.filter((run) => run?.conclusion === "failure").slice(0, GH_FAILED_JOB_SCAN);
  const failures = new Map(GUARDRAILS_JOBS.map((name) => [name, 0]));
  let unreadable = 0;
  for (const run of failedRuns) {
    const fetched = io.gh(["api", `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs`], dir);
    if (!fetched.ok) {
      unreadable += 1;
      continue;
    }
    let jobs;
    try {
      jobs = JSON.parse(fetched.stdout)?.jobs ?? [];
    } catch {
      unreadable += 1;
      continue;
    }
    for (const job of jobs) {
      if (job?.conclusion === "failure" && failures.has(job?.name)) failures.set(job.name, failures.get(job.name) + 1);
    }
  }
  // One unreadable failed run means a failure of one of these jobs may be
  // uncounted, and an uncounted failure is exactly what would turn a working
  // check into a removable one. The whole set goes to `known: false`.
  const known = unreadable === 0;
  return blank.map((row, index) => ({
    ...row,
    heads,
    failed: failures.get(GUARDRAILS_JOBS[index]) ?? 0,
    known,
    why: known
      ? null
      : `${unreadable} failed Guardrails run(s) could not be broken down by job, so a failure of this job may be uncounted`,
  }));
}

/** Every check row, from the three sources, each saying which it came from. */
export function checkRows(gate, io, { dir }) {
  const rows = [];
  for (const name of GATE_CHECKS) {
    const head = gate?.[name] ?? {};
    rows.push({
      id: hash8(`check|merge-gate|${name}`),
      where: "the merge gate",
      // Short on purpose. A longer sentence would give all three gate rows the
      // same half-dozen words and the pair rule would read them as each other.
      text: `the merge gate's ${name} head`,
      failed: Number(head.failed ?? 0) || 0,
      heads: Number(head.heads ?? 0) || 0,
      known: true,
      why: null,
    });
  }
  rows.push(...guardrailsChecks(io, { dir }));
  for (const name of STATIC_BOUNDARY_SCRIPTS) {
    rows.push({
      id: hash8(`check|static-boundaries|${name}`),
      where: "scripts/, inside the static-boundaries job",
      text: `scripts/${name}.mjs, one of the five pnpm check:guardrails runs`,
      failed: 0,
      heads: 0,
      known: false,
      why: "its pass/fail history is inside the static-boundaries job's log, and this job does not parse logs",
    });
  }
  return rows;
}

// ── The blast-radius table ───────────────────────────────────────────────────

/**
 * One row's candidate, by exactly these rules and no judgement.
 *
 * THE UNMEASURED ROWS COME FIRST. A check whose history was not read and a
 * rule with no usable proxy are keeps before any other rule is consulted:
 * spec §23.9 says a check that never failed is a question answered only with
 * counterfactual evidence, and "no history was read" is not evidence of
 * anything. Putting the guard first also stops such a row from collapsing into
 * a neighbour, which would remove it by another name.
 *
 * The guard is stated per class rather than as a blanket `mattered === null`,
 * because a schema field has no proxy AT ALL — reading its absent proxy as a
 * veto would make the grep rule unreachable and no field could ever be
 * proposed.
 */
export function candidateFor(row, context = {}) {
  const { runsTotal = 0, peers = [] } = context;
  const keep = (why) => ({ candidate: "keep", collapseInto: null, why });

  if (row.class === "check" && row.failures?.known === false) {
    return keep("its failure history was not read, and that is not evidence of no failures");
  }
  if ((row.class === "rule" || row.class === "skill") && row.proxy?.mattered === null) {
    return keep("no proxy: the line yields fewer than two subject words");
  }

  if (row.class === "field" && row.grep?.count === 0) {
    return { candidate: "remove", collapseInto: null, why: "no line outside the schema mentions it" };
  }
  if (
    (row.class === "rule" || row.class === "skill") &&
    row.loaded >= MIN_LOADED &&
    row.proxy?.mattered === 0 &&
    (row.proxy?.nouns?.length ?? 0) >= 2
  ) {
    return { candidate: "remove", collapseInto: null, why: "loaded on enough runs and matched by none of them" };
  }
  if (row.class === "check" && row.failures?.known && row.failures.failed === 0 && row.failures.heads >= MIN_LOADED) {
    return { candidate: "remove", collapseInto: null, why: "read over enough heads and never failed on one" };
  }

  // The pair rule: two rows in the same place saying most of the same thing.
  // THE LONGER COLLAPSES INTO THE SHORTER, so the survivor is the tighter
  // sentence. On an exact tie the row whose id sorts later collapses into the
  // earlier — arbitrary, but deterministic, which a tie broken by iteration
  // order would not be.
  for (const peer of peers) {
    if (peer.id === row.id) continue;
    if (jaccard(row.proxy?.nouns ?? [], peer.proxy?.nouns ?? []) < 0.6) continue;
    const longer =
      row.text.length !== peer.text.length ? row.text.length > peer.text.length : row.id > peer.id;
    if (longer) {
      return {
        candidate: "collapse",
        collapseInto: peer.id,
        why: `it says most of what #${peer.id} says, at greater length`,
      };
    }
  }

  // A skill that fires on nearly every run is base prompt, not a skill
  // (spec §23.9's first question). It collapses into the operate layer, which
  // is a FILE and not a row of this table — the one collapse target that is.
  if (row.class === "skill" && runsTotal > 0 && row.proxy.mattered / runsTotal >= 0.9) {
    return {
      candidate: "collapse",
      collapseInto: OPERATE_FILE,
      why: "it is used on nearly every run, which makes it base prompt",
    };
  }

  return keep("the measurement supports no removal");
}

/** The row's own numbers, as the one sentence the proposal's evidence is
 *  checked against. No adjectives: a count, a denominator, a bound. */
export function evidenceFor(row) {
  if (row.class === "field") {
    return `${row.text} is a top-level field of ${row.where}; a word-boundary grep of ${GREP_DIRS.join(", ")} outside the schema found ${row.grep.count} line(s), an upper bound.`;
  }
  if (row.class === "check") {
    return row.failures.known
      ? `${row.failures.failed} failure(s) over ${row.failures.heads} head(s) read.`
      : `Its failure history was not read (${row.why ?? "no source"}), so no count exists.`;
  }
  if (row.class === "skill") {
    return `Offered on ${row.loaded} run(s), used on ${row.proxy.mattered} of ${row.proxy.sample}.`;
  }
  return row.proxy.mattered === null
    ? `Loaded on ${row.loaded} run(s); ${row.loadedUnknown} run(s) recorded no working directory; it yields too few subject words to measure against a transcript.`
    : `Loaded on ${row.loaded} run(s); ${row.loadedUnknown} run(s) recorded no working directory; ${row.proxy.mattered} of ${row.proxy.sample} sampled runs carry its words.`;
}

/** Every integer a row's own numbers contain. The parser checks the model's
 *  evidence sentence against exactly this set. */
export function rowNumbers(row) {
  return new Set(
    [
      row.loaded,
      row.loadedUnknown,
      row.proxy?.mattered,
      row.proxy?.sample,
      row.failures?.failed,
      row.failures?.heads,
      row.grep?.count,
    ]
      .filter((n) => typeof n === "number" && Number.isFinite(n))
      .map((n) => Math.trunc(n)),
  );
}

/**
 * The whole table: one row per rule, skill, field and check, all four classes
 * together, each with its candidate and its `needsHisWords`.
 *
 * `needsHisWords` IS COMPUTED HERE, BEFORE THE MODEL RUNS, and the model may
 * raise it but never lower it. A row whose subject words are most of a line of
 * tts/spec.md or of model-of-tom/intent.md is Tom's to change, not his
 * silence's (spec §23.9).
 */
export function blastRows({ input, fields, ruleFiles, checks, hisWordsLines, repoName }) {
  const runsTotal = Number(input?.runs?.total ?? 0) || 0;
  const sample = Array.isArray(input?.sample) ? input.sample : [];
  const rows = [];
  const seen = new Set();
  let duplicateRuleLines = 0;

  const push = (row) => {
    if (seen.has(row.id)) {
      // A rule line that is byte-identical in two files is one rule with two
      // homes. scripts/check-agents-md.mjs already fails the build on that, so
      // it cannot happen here; the first row wins and the count is reported
      // rather than the second row silently overwriting the first.
      duplicateRuleLines += 1;
      return;
    }
    seen.add(row.id);
    rows.push(row);
  };

  for (const file of ruleFiles ?? []) {
    for (const line of file.lines) {
      const nouns = nounsOf(line.text);
      const mattered = proxyMattered(nouns, sample);
      push({
        id: ruleId(line.text),
        class: "rule",
        where: file.where,
        text: line.text,
        loaded: file.loaded,
        loadedUnknown: file.loadedUnknown,
        proxy: {
          nouns: mattered === null ? [] : nouns,
          mattered,
          sample: sample.length,
          note: mattered === null ? "no proxy" : "a generous word-overlap proxy over the sampled transcripts",
        },
        failures: { failed: 0, heads: 0, known: true },
        ablation: null,
        grep: null,
      });
    }
  }

  for (const skill of input?.skills ?? []) {
    const used = Number(skill?.used ?? 0) || 0;
    push({
      id: hash8(`skill|${skill?.name}`),
      class: "skill",
      where: "skills",
      text: String(skill?.name ?? ""),
      loaded: Number(skill?.offered ?? 0) || 0,
      loadedUnknown: 0,
      proxy: {
        nouns: nounsOf(String(skill?.name ?? "").replace(/[-_]/g, " ")),
        mattered: used,
        sample: runsTotal,
        // Not a proxy at all: the CLI writes down which skills a run used, so
        // this number is the thing itself. It rides in the proxy field so one
        // candidate rule covers rules and skills together.
        note: "exact — the run record names the skills each run used",
      },
      failures: { failed: 0, heads: 0, known: true },
      ablation: null,
      grep: null,
    });
  }

  for (const field of fields ?? []) {
    push({
      id: hash8(`field|${field.table}.${field.name}`),
      class: "field",
      where: `convex/schema.ts ${field.table}`,
      text: field.name,
      loaded: runsTotal,
      loadedUnknown: 0,
      proxy: {
        nouns: [],
        mattered: null,
        sample: 0,
        note: "a schema field is measured by the grep count, never by the transcript proxy",
      },
      failures: { failed: 0, heads: 0, known: true },
      ablation: null,
      grep: { count: Number(field.count ?? 0) || 0, upperBound: true },
    });
  }

  for (const check of checks ?? []) {
    push({
      id: check.id,
      class: "check",
      where: check.where,
      text: check.text,
      loaded: check.heads,
      loadedUnknown: 0,
      proxy: {
        nouns: nounsOf(check.text),
        mattered: null,
        sample: 0,
        note: "a check is measured by its failures, never by the transcript proxy",
      },
      failures: { failed: check.failed, heads: check.heads, known: check.known },
      ablation: null,
      grep: null,
      why: check.why ?? null,
    });
  }

  // The ablation arm, where the evals ran one: the only direct counterfactual
  // the record holds, attached to the row whose subject it names.
  for (const ablation of input?.evals?.ablation ?? []) {
    const target = rows.find((row) => row.id === ablation?.subject || row.text === ablation?.subject);
    if (target) target.ablation = { delta: ablation.delta ?? null, at: ablation.at ?? null };
  }

  const byWhere = new Map();
  for (const row of rows) {
    if (!byWhere.has(row.where)) byWhere.set(row.where, []);
    byWhere.get(row.where).push(row);
  }
  for (const row of rows) {
    const { candidate, collapseInto, why } = candidateFor(row, {
      runsTotal,
      peers: byWhere.get(row.where) ?? [],
    });
    row.candidate = candidate;
    row.collapseInto = collapseInto;
    row.why = row.why ?? why;
    row.needsHisWords = (hisWordsLines ?? []).some((nouns) => jaccard(row.proxy.nouns, nouns) >= 0.6);
    row.evidence = evidenceFor(row);
  }
  return { rows, duplicateRuleLines, repoName };
}

// ── The facts block ──────────────────────────────────────────────────────────

/** One row as the prompt reads it. */
export function factsRowLine(row) {
  const proxy =
    row.proxy.mattered === null
      ? "proxy none"
      : `proxy ${row.proxy.mattered}/${row.proxy.sample} (${row.proxy.nouns.slice(0, 8).join(" ")})`;
  const failures = row.failures.known ? `failures ${row.failures.failed}/${row.failures.heads}` : "failures unread";
  const grep = row.grep === null ? "" : ` | grep ${row.grep.count} (upper bound)`;
  const into = row.collapseInto === null ? "" : ` into ${row.collapseInto}`;
  const his = row.needsHisWords ? " | NEEDS HIS WORDS" : "";
  return `#${row.id} ${row.class} ${row.where} — ${row.text} | loaded ${row.loaded} | ${proxy} | ${failures}${grep} | candidate ${row.candidate}${into}${his}`;
}

/**
 * The facts, once, as an object. It is written twice: as JSON on this run's own
 * "simplify-run" event, so `tts search events` can find months later what a
 * proposal was measured from, and as the text below for the prompt.
 */
export function factsBlock({ day, input, table, repoReadable, failures }) {
  const runs = input?.runs ?? {};
  const candidates = { remove: 0, collapse: 0, keep: 0 };
  for (const row of table.rows) candidates[row.candidate] += 1;
  return {
    day,
    window: {
      since: input?.window?.since ?? null,
      until: input?.window?.until ?? null,
      weeks: WINDOW_WEEKS,
    },
    runs: {
      total: Number(runs.total ?? 0) || 0,
      capped: runs.capped === true,
      withContext: Number(runs.withContext ?? 0) || 0,
      layersKnownTrue: Number(runs.layersKnownTrue ?? 0) || 0,
      byOrigin: runs.byOrigin ?? {},
      byRunner: runs.byRunner ?? {},
      byHost: runs.byHost ?? {},
      byKind: runs.byKind ?? {},
    },
    sampleRuns: (input?.sample ?? []).length,
    repoReadable,
    duplicateRuleLines: table.duplicateRuleLines,
    tools: input?.tools ?? [],
    hooks: input?.hooks ?? [],
    evals: {
      runs: Number(input?.evals?.runs ?? 0) || 0,
      withAblation: Number(input?.evals?.withAblation ?? 0) || 0,
    },
    candidates,
    rows: table.rows,
    priorProposals: input?.priorProposals ?? [],
    failures,
  };
}

/**
 * The same facts, sized for ONE Convex document — what rides the run's own
 * "simplify-run" event so `tts search events` can find months later what a
 * proposal was measured from.
 *
 * Only what is re-derivable is trimmed: the text is clipped, the noun set
 * becomes its size (`nounsOf(text)` gives the words back), and the evidence
 * sentence goes (`evidenceFor(row)` rebuilds it from the numbers below it).
 * Every NUMBER a proposal's evidence was checked against is kept whole,
 * because that is what a proposal has to stay re-readable from. At the
 * schema's current size this leaves the event well inside one document, and
 * the trim is what buys the headroom for the schema to grow.
 */
export function factsForEvent(facts) {
  return {
    ...facts,
    rows: facts.rows.map(({ evidence, ...row }) => ({
      ...row,
      text: String(row.text).slice(0, 200),
      proxy: { ...row.proxy, nouns: row.proxy.nouns.length },
    })),
  };
}

/**
 * The facts as the prompt reads them: the window and the bounds FIRST, then
 * the rows, then the two questions §23.9 names, then what happened to the last
 * eight weeks of proposals.
 */
export function factsText(facts) {
  const head = [
    `THE WEEKLY SIMPLIFICATION PASS — ${facts.day}.`,
    "",
    `Window: ${facts.window.since === null ? "unknown" : utcDay(facts.window.since)} to ${facts.window.until === null ? "unknown" : utcDay(facts.window.until)}, ${WINDOW_WEEKS} weeks. Four weeks because Convex evicts every run older than thirty days (spec §23.4): this is the window the record HOLDS, not a judgement that four weeks is enough history.`,
    `Runs in the window: ${facts.runs.total}${facts.runs.capped ? ` (the scan stopped at ${RUN_SCAN} rows, so this is a floor)` : ""}. Sampled for the proxy: ${facts.sampleRuns}, at most ${ROW_SCAN_PER_RUN} rows and ${TOKENS_PER_RUN} distinct tokens each.`,
    `Of those runs, ${facts.runs.withContext} recorded a context entry and ${facts.runs.layersKnownTrue} knew which layers they were given.`,
    "",
    PROXY_CAVEAT,
    "",
    "A grep count is an UPPER BOUND: a field named `path` or `status` collides with every other use of the word, so a non-zero count is recorded and is never evidence for keeping. Only a count of zero is evidence.",
    "Only a table's TOP-LEVEL fields are collected from convex/schema.ts; fields nested inside an object are not in this table at all.",
    facts.repoReadable
      ? ""
      : "THE TOM.QUEST CHECKOUT WAS NOT READABLE on this run, so no schema field and no AGENTS.md rule is in the table below. Their absence here is this failure, not a measurement.",
    `The ablation arm: ${facts.evals.withAblation} of ${facts.evals.runs} eval runs carried one. Zero is expected until phase 7 lands its ablation arm — it is the arm not existing yet, not evidence missing by accident.`,
    "ABSENT IS A VALUE. A zero below was measured as zero. Where something was not read, the row says so in those words.",
    facts.duplicateRuleLines > 0
      ? `${facts.duplicateRuleLines} rule line(s) were byte-identical to a line already in the table and are counted once, under the first file they appear in.`
      : "",
    "",
    `Tools named by the runs (context only — a tool is not a row and may not be proposed): ${(facts.tools ?? []).map((t) => `${t.name} ${t.runs}`).join(", ") || "none recorded"}.`,
    `Hooks configured on the runs (context only): ${(facts.hooks ?? []).map((h) => `${h.name} ${h.runs}`).join(", ") || "none recorded"}.`,
    "",
    `THE TABLE — ${facts.rows.length} rows: ${facts.candidates.remove} remove, ${facts.candidates.collapse} collapse, ${facts.candidates.keep} keep.`,
    "",
  ].filter((line) => line !== "");

  const rowLines = facts.rows.map((row) => factsRowLine(row));

  const nearlyEveryRun = facts.rows.filter(
    (row) => row.class === "skill" && row.proxy.sample > 0 && row.proxy.mattered / row.proxy.sample >= 0.9,
  );
  const neverFailed = facts.rows.filter(
    (row) => row.class === "check" && row.failures.known && row.failures.failed === 0,
  );
  const tail = [
    "",
    "THE TWO QUESTIONS, answered from the rows above:",
    `1. Which skills fire on nearly every run, and are therefore base prompt rather than skills? ${
      nearlyEveryRun.length === 0
        ? "None at or above 90%."
        : nearlyEveryRun.map((r) => `${r.text} (${r.proxy.mattered}/${r.proxy.sample})`).join(", ")
    }`,
    `2. Which checks have never failed over a history that was actually read? ${
      neverFailed.length === 0
        ? "None with a known history and zero failures."
        : neverFailed.map((r) => `${r.text} (0/${r.failures.heads})`).join("; ")
    } A check that never failed is a question, not a verdict: removal needs the counterfactual.`,
    "",
    `PRIOR PROPOSALS, the last ${PROPOSAL_COOLDOWN_WEEKS} weeks:`,
    ...(facts.priorProposals.length === 0
      ? ["none — this is the first run, or none has been posted in that time."]
      : facts.priorProposals.map((p) => {
          const what = p.objectedAt
            ? "Tom objected — this row is closed for ever"
            : p.admittedAt
              ? "admitted: a todo was filed and the branch opened"
              : p.needsHisWords
                ? "waiting on his words"
                : p.dryRun
                  ? "a dry run: never posted"
                  : "posted, still open";
          return `- #${p.rowId} (proposal ${p.askId}) on ${p.at ? utcDay(p.at) : "an unknown day"}: ${what}.`;
        })),
  ];

  const all = [...head, ...rowLines, ...tail];
  const text = all.join("\n");
  if (Buffer.byteLength(text, "utf8") <= FACTS_TEXT_MAX_BYTES) return text;

  // Over the cap: drop `keep` rows from the bottom. The model may not propose
  // from them anyway, so what goes is the part of the block that could not have
  // changed the answer — and the block says how many went.
  const droppable = [];
  facts.rows.forEach((row, index) => {
    if (row.candidate === "keep") droppable.push(index);
  });
  const withDropped = (dropped) => {
    const gone = new Set(droppable.slice(droppable.length - dropped));
    const kept = facts.rows.filter((_, index) => !gone.has(index)).map((row) => factsRowLine(row));
    const note =
      dropped === 0
        ? []
        : [
            `(${dropped} keep row(s) were dropped from the bottom of this table to fit the prompt${
              dropped === droppable.length ? ", which is every keep row there was" : ""
            }. A keep row is not available to you in any case.)`,
          ];
    return [...head, ...kept, ...note, ...tail].join("\n");
  };
  // Binary search on how many to drop: the text shrinks monotonically as more
  // go, so the smallest number that fits is found in a handful of renders
  // rather than one render per dropped row.
  let low = 1;
  let high = droppable.length;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = withDropped(middle);
    if (Buffer.byteLength(candidate, "utf8") <= FACTS_TEXT_MAX_BYTES) {
      best = candidate;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return best ?? withDropped(droppable.length);
}

// ── The prompt ───────────────────────────────────────────────────────────────

/**
 * The one prompt of the one model call. Fixed text FIRST and the facts block
 * LAST, per the cache-aware ordering rule the delegate's prompt follows: the
 * fixed half is identical week to week and the volatile half is the table.
 */
export function simplifyPrompt({ facts, writingStandard }) {
  return [
    "You are the weekly simplification pass. You run once a week over the runs this system recorded, and your ONLY permitted output is a deletion or a collapse. You may not propose a new check, a new rule, a new field, a new flag, or a change to how anything works. If the week's measurement supports no removal, the correct answer is an empty list, and an empty list is the common answer.",
    "",
    "WHY YOU EXIST",
    "",
    'Tom: "agents can handle complexity and will perpetuate it."',
    "",
    "You are the counterweight. There is no quota and no credit for finding something: a quota would make deletion the goal rather than simplicity.",
    "",
    "WHAT YOU MAY PROPOSE FROM",
    "",
    "Only a row of the table below whose candidate is `remove` or `collapse`, and your action must be that row's own candidate — you may not turn a collapse into a removal or a removal into a collapse. A row marked `keep` is not available to you for any reason, including a good one. The measurement decided those words before you read them.",
    "",
    "WHAT EVERY PROPOSAL CARRIES",
    "",
    "- the row's id, exactly as the table spells it;",
    "- one sentence saying what is TRUE AFTER the thing is removed — present tense, the after-state, not \"we should remove X\";",
    "- the evidence, which is that row's own numbers and no others. Every number you write must be one of that row's numbers;",
    "- the COUNTERFACTUAL: what would have been lost in the runs that were read, had the thing not been there. For a check, that is what it would have blocked in the heads that were read, and what still covers that case once it is gone. A proposal you cannot write a counterfactual for is a proposal you have not made.",
    "",
    "WHAT NEEDS HIS WORDS",
    "",
    "A removal that changes a line of tts/spec.md, or a line of model-of-tom/intent.md he has reviewed, is his to make — not yours, and not his silence's. Mark it `needsHisWords: true`. You may raise that flag on any proposal; you may never lower one the measurement already raised, and a row marked NEEDS HIS WORDS in the table stays marked whatever you answer.",
    "",
    "AT MOST FIVE",
    "",
    `At most ${MAX_PROPOSALS}, the five best-evidenced. Zero is common.`,
    "",
    "HOW HE SEES THIS",
    "",
    "Each proposal becomes one Slack message in #tts-decisions, where silence means the branch gets opened. So the sentence is written for him — plain, short, and about the thing itself, in the register the writing standard describes.",
    ...(typeof writingStandard === "string" && writingStandard.trim() !== ""
      ? ["", "THE WRITING STANDARD", "", writingStandard.trim()]
      : []),
    "",
    "YOUR ANSWER",
    "",
    JSON_ONLY_ANSWER,
    '{"proposals":[{"id":"<row id>","action":"remove","into":null,"sentence":"...","evidence":"...","counterfactual":"...","needsHisWords":false}]}',
    "",
    'On a collapse, `action` is "collapse" and `into` is exactly what the row\'s table line says after the word `into`.',
    "",
    "--- THE MEASUREMENT ---",
    "",
    facts,
  ].join("\n");
}

// ── The parse, and what it refuses ───────────────────────────────────────────

/** One proposal's id: the day and the row, so a rerun of the same day proposes
 *  under the same id and Tom's thread is one thread. */
export function proposalId(day, rowId) {
  return hash8(`${day}|${rowId}`);
}

/**
 * The model's answer against the measurement. Each refusal drops that ONE
 * proposal and keeps the rest, and is recorded as a `refusedProposals` entry
 * inside the run event — never as an event of its own, because a refusal is a
 * fact about this run and not a thing that happened to the system.
 *
 * The order below is the order the checks run in, and the first one is the wall
 * that stops invention: a proposal that names a row it may not propose from is
 * dropped before anything it says is read.
 */
export function parseProposals(answerText, { rows, priorProposals = [], day }) {
  const proposals = [];
  const refused = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const now = Date.parse(`${day}T00:00:00.000Z`);
  const cooldownMs = PROPOSAL_COOLDOWN_WEEKS * 7 * 86_400_000;

  let answer;
  try {
    answer = extractJsonObject(String(answerText ?? ""));
  } catch (error) {
    return { proposals, refused: [{ id: null, why: `the answer held no JSON object: ${error.message}` }] };
  }
  const list = Array.isArray(answer?.proposals) ? answer.proposals : [];

  for (const raw of list) {
    const id = typeof raw?.id === "string" ? raw.id.trim().replace(/^#/, "") : "";
    const drop = (why) => refused.push({ id: id || null, why });
    const row = byId.get(id);
    if (!row || (row.candidate !== "remove" && row.candidate !== "collapse")) {
      drop("named a row it may not propose from");
      continue;
    }
    if (raw.action !== row.candidate) {
      drop(`proposed "${String(raw.action).slice(0, 20)}" where the measurement says "${row.candidate}"`);
      continue;
    }
    // `into` names the collapse target the measurement chose, and only then.
    // It is a row id for a pair collapse and the operate FILE for a skill that
    // fires on nearly every run, which is why the check is equality with the
    // row's own target rather than "is a row in the table".
    const into = typeof raw.into === "string" ? raw.into.trim() : null;
    if (row.candidate === "collapse" && into !== row.collapseInto) {
      drop(`a collapse must name ${row.collapseInto} as its target, and this named ${into ?? "nothing"}`);
      continue;
    }
    if (row.candidate === "remove" && into !== null && into !== "") {
      drop("a removal carries no `into`");
      continue;
    }
    const sentence = typeof raw.sentence === "string" ? raw.sentence.trim() : "";
    if (sentence === "" || sentence.length > 200 || /[\r\n]/.test(sentence)) {
      drop("the sentence is empty, longer than 200 characters, or carries a newline");
      continue;
    }
    const counterfactual = typeof raw.counterfactual === "string" ? raw.counterfactual.trim() : "";
    if (counterfactual === "" || counterfactual.length > 300) {
      drop("the counterfactual is empty or longer than 300 characters");
      continue;
    }
    const evidence = typeof raw.evidence === "string" ? raw.evidence.trim() : "";
    if (evidence === "" || evidence.length > 300) {
      drop("the evidence is empty or longer than 300 characters");
      continue;
    }
    const integers = (evidence.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
    if (integers.length === 0) {
      drop("the evidence carries no number");
      continue;
    }
    // THE ONE MECHANICAL TEST that the evidence came from the measurement
    // rather than from the model's sense of what a plausible number looks
    // like: every integer in it is one of this row's own numbers.
    const mine = rowNumbers(row);
    const stray = integers.find((n) => !mine.has(n));
    if (stray !== undefined) {
      drop(`the evidence names ${stray}, which is not one of this row's numbers`);
      continue;
    }
    const prior = priorProposals.filter((p) => p?.rowId === row.id);
    if (prior.some((p) => p?.objectedAt)) {
      // An objection is permanent. The delegate's rule is "do not re-take a
      // decision he reverted", and re-proposing a deletion he refused is the
      // same act one directory over.
      drop("Tom objected to a proposal on this row, and an objection is permanent");
      continue;
    }
    if (prior.some((p) => typeof p?.at === "number" && now - p.at < cooldownMs)) {
      drop(`this row was proposed within the last ${PROPOSAL_COOLDOWN_WEEKS} weeks`);
      continue;
    }
    if (proposals.length >= MAX_PROPOSALS) {
      drop(`more than ${MAX_PROPOSALS} proposals were made and this one is past the fifth`);
      continue;
    }
    proposals.push({
      id: proposalId(day, row.id),
      rowId: row.id,
      class: row.class,
      where: row.where,
      text: row.text,
      action: row.candidate,
      into: row.collapseInto,
      sentence,
      evidence,
      counterfactual,
      // Raised, never lowered.
      needsHisWords: row.needsHisWords === true || raw.needsHisWords === true,
    });
  }
  return { proposals, refused };
}

// ── The dry run's preview ────────────────────────────────────────────────────

/**
 * What a dry run prints instead of posting. THE COMPOSER IS NOT RE-IMPLEMENTED
 * HERE: convex/ttsCompose.ts writes the words of a #tts-decisions message and
 * its tests prove them, and a second copy of that wording in this file is
 * exactly the wicked feature this pass exists to argue against. What is printed
 * is the PAYLOAD — the fields that go to the door — one per labelled line.
 */
export function decisionPreview(proposal) {
  const lines = [
    "#tts-decisions — via ttsSync.sendDecision -> ttsCompose.composeDecision",
    `askId: simplify:${proposal.id}`,
    `decision: ${proposal.sentence}`,
    `reason: ${proposal.evidence} ${proposal.counterfactual}`,
  ];
  if (proposal.needsHisWords) {
    lines.push("refused: true");
    lines.push(
      "refusedBecause: this changes a line of tts/spec.md or of model-of-tom/intent.md, which needs his words and not his silence",
    );
  }
  return lines;
}

// ── The run's doors ──────────────────────────────────────────────────────────

function runCommand(command, args, cwd) {
  try {
    const stdout = String(
      execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    return { ok: true, status: 0, stdout, error: null };
  } catch (error) {
    // `git grep` exits 1 when nothing matched — the caller tells that apart
    // from a real failure by the status, which is why it is returned rather
    // than thrown.
    return {
      ok: false,
      status: error?.status ?? null,
      stdout: String(error?.stdout ?? ""),
      error: error?.message ?? String(error),
    };
  }
}

/**
 * Every side effect this job has, as one object, so the whole run goes against
 * fakes in simplify.test.mjs with no model, no git, no gh and no network.
 * Everything above this line is pure.
 */
export const REAL_IO = {
  fetch: convexFetch,
  model: runClaude,
  now: () => Date.now(),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  exists: (file) => fs.existsSync(file),
  readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
  git: (args, cwd) => runCommand("git", args, cwd),
  gh: (args, cwd) => runCommand("gh", args, cwd),
  markerRead: (day) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(MARKER_DIR, `simplify-${day}.json`), "utf8"));
    } catch {
      return null;
    }
  },
  markerWrite: (day, record) => {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
    fs.writeFileSync(path.join(MARKER_DIR, `simplify-${day}.json`), `${JSON.stringify(record)}\n`);
  },
  reportFailed: reportJobFailed,
  reportOk: reportJobOk,
  out: (line) => console.log(line),
};

/** Read a file that may not be there. Absent is a value, so the caller is told
 *  which it got rather than being handed an empty string for both. */
function readOptional(io, file) {
  try {
    return io.exists(file) ? io.readFile(file) : null;
  } catch {
    return null;
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * The whole job, returning its record. `null` when the NY-hour guard skipped
 * this cron slot; `{ refused }` when the day was already run.
 *
 * ONE RUN PER DAY, and the guard is a LOCAL MARKER FILE rather than a Convex
 * read. The alternative was GET /tts/search/events, the only door that reads
 * events back today: it is a redacted free-text search with a row-scan cap, so
 * on a busy day the row it is looking for can fall past the cap and the search
 * answers "not run" for a day that ran. A guard that fails OPEN silently is
 * worse than one whose failure mode is stated — the marker is lost only when
 * the box is rebuilt, and the durable record of the run is the Convex event
 * either way. When a read door for one event by kind and key exists, this guard
 * should become that read.
 */
export async function runSimplify({
  force = false,
  overwrite = false,
  dryRun = false,
  printFacts = false,
  env = null,
  dir = WIKITOM_DIR,
  repoDir = TOMQUEST_DIR,
  repoName = null,
  io = REAL_IO,
} = {}) {
  const now = io.now();
  if (!force && nyHour(now) !== 4) {
    console.log(`[simplify] NY hour is ${nyHour(now)}, not 4 — this is the off-season cron slot, exiting (use --force to override)`);
    return null;
  }
  const day = utcDay(now);
  const resolvedEnv = env ?? loadEnv();
  const failures = [];
  const note = (what) => {
    console.error(`[simplify] ${what}`);
    failures.push(what);
  };

  if (!dryRun && !overwrite) {
    const marker = io.markerRead(day);
    if (marker !== null) {
      const refused = `${day} was already run (${marker.proposed ?? 0} proposal(s) posted). Nothing written; rerun with --overwrite.`;
      console.log(`[simplify] refused: ${refused}`);
      return { day, refused, proposed: 0, posted: 0, admitted: 0, failures };
    }
  }

  // 0. THE OBJECTION WINDOW, first, before anything is measured. A proposal
  // nobody objected to becomes a todo, and the branch that removes the thing
  // is opened from that todo. A dry run does none of this, because a dry run
  // writes nothing at all.
  let admitted = 0;
  let waiting = 0;
  if (!dryRun) {
    try {
      const open = await io.fetch(resolvedEnv, "/tts/simplify-open");
      const list = Array.isArray(open) ? open : (open?.proposals ?? []);
      // The door filters, and this repeats the filter. Admitting a proposal
      // Tom objected to is the one mistake here a later run cannot undo, so it
      // is checked on both sides of the wire rather than on one.
      const eligible = list.filter(
        (p) => !p?.objectedAt && !p?.admittedAt && p?.needsHisWords !== true && p?.dryRun !== true,
      );
      waiting = Math.max(0, eligible.length - ADMIT_PER_RUN);
      for (const proposal of eligible.slice(0, ADMIT_PER_RUN)) {
        try {
          const captured = await io.fetch(resolvedEnv, "/tts/capture", {
            statement: String(proposal.sentence ?? "").slice(0, 500),
            source: "simplify",
            provenance: `the weekly simplification pass, ${proposal.day ?? "an earlier week"}; proposal ${proposal.id}; ${proposal.evidence ?? ""}; ${proposal.counterfactual ?? ""}`.slice(0, 2000),
          });
          await io.fetch(resolvedEnv, "/tts/event", {
            kind: SIMPLIFY_ADMITTED,
            key: `simplify:${proposal.id}`,
            data: { proposalId: proposal.id, todoId: captured?.id ?? null, day },
          });
          admitted += 1;
        } catch (error) {
          note(`could not admit proposal ${proposal.id}: ${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
      console.log(`[simplify] objection window: ${eligible.length} eligible of ${list.length} returned, ${admitted} admitted, ${waiting} waiting`);
    } catch (error) {
      note(`could not read the objection window: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }

  // 1. what Convex supplies.
  let input = null;
  try {
    input = await io.fetch(resolvedEnv, `/tts/simplify-input?until=${now}`);
  } catch (error) {
    note(`the measurement input could not be read: ${String(error?.message ?? error).slice(0, 300)}`);
  }
  const runsTotal = Number(input?.runs?.total ?? 0) || 0;

  // 2. what only a checkout can answer.
  const repoReadable = io.exists(path.join(repoDir, "convex", "schema.ts"));
  const resolvedRepoName = repoName ?? path.basename(repoDir);
  const fields = [];
  const ruleFiles = [];
  const cwds = Array.isArray(input?.cwds) ? input.cwds.slice(0, CWD_DISTINCT_MAX) : [];

  const rulesText = readOptional(io, path.join(dir, OPERATE_FILE));
  if (rulesText === null) {
    // The base layer is on every run and a missing base is fatal (spec §23.7).
    // Fatal to a RUN, not to this job: it measures what it can and says the
    // operate layer was not there, which is itself a thing Tom should see.
    note(`${OPERATE_FILE} is not in the WikiTom checkout at ${dir}, so no operate rule is in the table`);
  } else {
    ruleFiles.push({
      where: OPERATE_FILE,
      loaded: runsTotal,
      loadedUnknown: 0,
      lines: ruleLines(rulesText),
    });
  }

  if (repoReadable) {
    const schema = readOptional(io, path.join(repoDir, "convex", "schema.ts"));
    const parsed = schemaFields(schema ?? "");
    const names = [...new Set(parsed.map((field) => field.name))];
    const { counts, failures: grepFailures } = grepCounts(names, io, { dir: repoDir });
    for (const failure of grepFailures) note(failure);
    for (const field of parsed) fields.push({ ...field, count: counts.get(field.name) ?? 0 });

    for (const rel of findAgentsFiles(repoDir, io)) {
      const text = readOptional(io, path.join(repoDir, rel));
      if (text === null) continue;
      const relDir = rel.slice(0, Math.max(0, rel.length - "AGENTS.md".length)).replace(/\/+$/, "");
      const { loaded, loadedUnknown } = loadedForAgentsFile(relDir, cwds, { repoName: resolvedRepoName });
      ruleFiles.push({ where: rel, loaded, loadedUnknown, lines: ruleLines(text) });
    }
  } else {
    note(`${repoDir} is not a tom.quest checkout, so no schema field and no AGENTS.md rule was measured`);
  }

  const checks = checkRows(input?.gate ?? {}, io, { dir: repoDir });

  // The two files a proposal may not change on his silence. READ ONLY, and for
  // this one purpose: a row whose subject words are most of a line in either of
  // them is his to change.
  const hisWordsLines = [];
  for (const file of [path.join(dir, SPEC_PATH), path.join(dir, INTENT_PATH)]) {
    const text = readOptional(io, file);
    if (text === null) continue;
    for (const line of ruleLines(text)) {
      const nouns = nounsOf(line.text);
      if (nouns.length >= 2) hisWordsLines.push(nouns);
    }
  }

  const table = blastRows({ input: input ?? {}, fields, ruleFiles, checks, hisWordsLines, repoName: resolvedRepoName });
  const facts = factsBlock({ day, input: input ?? {}, table, repoReadable, failures });
  const text = factsText(facts);
  console.log(
    `[simplify] table: ${table.rows.length} rows — ${facts.candidates.remove} remove, ${facts.candidates.collapse} collapse, ${facts.candidates.keep} keep`,
  );

  if (printFacts) {
    io.out(text);
    return { day, refused: null, proposed: 0, posted: 0, admitted, waiting, facts, failures, printedFacts: true };
  }

  // 3. the one model call — unless there is nothing to read.
  let proposals = [];
  let refusedProposals = [];
  let modelError = null;
  if (runsTotal === 0) {
    // Not a failure: a record with no runs in it is a true answer about a young
    // system, and calling the model to judge an empty table would produce an
    // answer that read like a measurement and was not one.
    modelError = "no runs are recorded yet";
    io.out(text);
  } else {
    try {
      const answer = io.model(simplifyPrompt({ facts: text, writingStandard: input?.writingStandard }), {
        model: SIMPLIFY_MODEL,
        cwd: os.tmpdir(),
        timeoutMs: SIMPLIFY_TIMEOUT_MS,
        maxTurns: SIMPLIFY_MAX_TURNS,
        registration: {
          origin: "cron:simplify",
          kind: "job",
          layersKnown: false,
          layersGiven: [],
          layersDenied: [],
          writingStandardSource: "/tts/simplify-input",
        },
      });
      ({ proposals, refused: refusedProposals } = parseProposals(answer, {
        rows: table.rows,
        priorProposals: input?.priorProposals ?? [],
        day,
      }));
    } catch (error) {
      modelError = String(error?.message ?? error).slice(0, 500);
      note(`the model call failed: ${modelError}`);
    }
  }
  console.log(`[simplify] ${proposals.length} proposal(s), ${refusedProposals.length} refused`);

  // 4. a dry run renders the messages and posts nothing. THIS IS A DEVIATION
  // FROM THE ORIGINAL DESIGN AND IT IS THE RULING: a dry run records nothing
  // either, so the day stays un-run and a real run of the same day is still
  // possible.
  if (dryRun) {
    io.out(`[simplify] DRY RUN — ${proposals.length} proposal(s) would be posted; nothing was written.`);
    for (const proposal of proposals) for (const line of decisionPreview(proposal)) io.out(line);
    return { day, refused: null, dryRun: true, proposed: proposals.length, posted: 0, admitted: 0, waiting: 0, facts, proposals, refusedProposals, failures };
  }

  // 5. one event per surviving proposal. THE KEY IS THE WHOLE PREFIXED askId:
  // convex/ttsSimplify.ts posts the decision under `simplify:<id>`, and the
  // objection door resolves a reply by looking that id up as an event `key`.
  // Making the two ends the same string is why a reply in this thread resolves
  // at all.
  let posted = 0;
  for (const proposal of proposals) {
    try {
      await io.fetch(resolvedEnv, "/tts/event", {
        kind: SIMPLIFY_PROPOSAL,
        key: `simplify:${proposal.id}`,
        data: {
          ...proposal,
          dryRun: false,
          day,
          facts: facts.rows.find((row) => row.id === proposal.rowId) ?? null,
          window: facts.window,
        },
      });
      posted += 1;
    } catch (error) {
      note(`could not post proposal ${proposal.id}: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }

  // 6. the run's own record, whatever happened.
  try {
    await io.fetch(resolvedEnv, "/tts/event", {
      kind: SIMPLIFY_RUN,
      key: day,
      data: {
        day,
        dryRun: false,
        window: facts.window,
        runsInWindow: runsTotal,
        runsCapped: facts.runs.capped,
        sampleRuns: facts.sampleRuns,
        rows: table.rows.length,
        candidates: facts.candidates,
        proposed: proposals.length,
        posted,
        refusedProposals,
        admitted,
        waiting,
        needsHisWords: proposals.filter((p) => p.needsHisWords).length,
        modelError,
        failures,
        facts: factsForEvent(facts),
      },
    });
  } catch (error) {
    note(`could not record the run: ${String(error?.message ?? error).slice(0, 300)}`);
  }

  try {
    io.markerWrite(day, { day, proposed: proposals.length, posted, at: now });
  } catch (error) {
    note(`could not write the one-run-per-day marker: ${String(error?.message ?? error).slice(0, 200)}`);
  }

  // A new "simplify-failure" kind would have to be added to ttsWeekly's
  // FAILURE_KINDS, ttsHourly's set and the digest's switch before Tom would
  // ever see it, while "job-failed" is already carried by all three and
  // already deduped by condition. That is the removal check applied to this
  // job: the thing this patch would add already exists.
  if (failures.length > 0) {
    await io.reportFailed(resolvedEnv, { job: "simplify", error: failures.join("; ").slice(0, 2000), key: "simplify:run" });
  } else {
    await io.reportOk(resolvedEnv, { job: "simplify", key: "simplify:run" });
  }
  console.log(`[simplify] done: ${posted} posted, ${admitted} admitted, ${failures.length} failure(s)`);
  return { day, refused: null, proposed: proposals.length, posted, admitted, waiting, facts, proposals, refusedProposals, failures, modelError };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const result = await runSimplify({
    force: argv.includes("--force"),
    overwrite: argv.includes("--overwrite"),
    dryRun: argv.includes("--dry-run"),
    printFacts: argv.includes("--print-facts"),
  });
  if (result !== null && (result.failures.length > 0 || result.refused !== null)) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[simplify] FAILED: ${err.message}`);
    process.exit(1);
  });
}
