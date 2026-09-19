#!/usr/bin/env node
// removal-loop.mjs — THE REMOVAL LOOP: one complexity smell a day becomes one
// pull request, and only one is ever open. 5 a.m. New York, every day.
//
// WHAT IT DOES, each tick, in order:
//
//   0. flow control — `gh pr list --label loop-removal --state open`. If a loop
//      pull request is open, the tick runs ONLY the merge pass (below) and
//      exits: no new violation is picked, and a tick with nothing to do
//      records one "removal-loop-run" row saying it was held and by which
//      pull request.
//   1. the measurement — a clone of the base branch (main) is refreshed, and
//      that clone's own scripts/removal-pick.mjs runs the four structural
//      rules (sg/rules, via ast-grep) and picks the SMALLEST violation in the
//      committed baseline, by deterministic code. Violations Tom refused, and
//      ones a run already declined, are excluded.
//   2. the actuator — one box run, `tts-run --runner claude --model opus`,
//      given the violation, the hand-written after-state for its rule
//      (sg/goldens/<rule>.md), Tom's past corrections to this loop
//      (vqc/steering.yaml), and the response template. It removes the one
//      thing, regenerates sg/baseline.tsv in the same commit, and pushes a
//      branch. Its final message is the pull request's body.
//   3. the pull request — THIS JOB opens it, with the label, so the one thing
//      flow control depends on is never a model's to forget. Then one
//      "removal-loop-pr" event, which makes Convex post the #tts-simplify
//      message (convex/ttsSync.ts sendRemoval), and the merge gate's audit of
//      the pushed head (tts-audit), since nothing else audits a branch nobody
//      is sitting with.
//
// THE MERGE PASS, for the open loop pull request:
//
//   - GET /tts/removals-open: has a day passed since the #tts-simplify
//     message, and has a digest gone out after that, with no reply from Tom?
//     (convex/ttsSimplify.ts internalOpenRemovals — the weekly pass's own
//     window, not a second one.)
//   - both, and GET /tts/merge-gate allows the head: `gh pr merge --squash`,
//     then POST /tts/merge, which re-runs the gate and puts the merge in the
//     morning's objection list.
//   - a reply opening with "revert": the pull request is closed with his
//     words quoted, and never reopened. Words beyond "revert" become a
//     correction in vqc/steering.yaml, carried in by the next pull request.
//   - any other reply: one box run on the SAME branch with the diff, the body
//     and his words verbatim. It fixes the branch, appends his words as a
//     vqc/steering.yaml entry in the same commit, and writes the new body.
//     The job posts the rewritten round, which restarts his day to object.
//
// THIS JOB IS NOT A SESSION AND MERGES DIRECTLY. The session daemon's merge
// fence (worker/session-host/merge-gate.mjs) stands between a
// session's Bash tool and `gh pr merge`; this is a cron job, and the fence it
// answers to is the same three checks, read through GET /tts/merge-gate before
// it merges and re-run by POST /tts/merge after. It adds no fourth check and
// bypasses none.
//
// WHY A NEW DAILY JOB and not the weekly simplification pass run daily: the
// weekly pass's evidence is four weeks of recorded runs, which Convex keeps
// for thirty days, so a daily run would re-read the same weeks and spend a
// fifteen-minute model call for no new fact. What changes daily is the
// CHECKOUT, and this job measures the checkout.
//
// BOUNDARIES.
//   - One box run per tick at most, and one open pull request ever.
//   - It writes the repository only through a box run's branch; the clone it
//     measures in is a cache, reset on every tick.
//   - Its only Slack output is through Convex, by recording an event.
//   - A vqc/steering.yaml entry it asks for carries Tom's words verbatim and
//     nothing else in the `correction` field; it never writes one on its own
//     account.
//   - It mints two event kinds: removal-loop-pr and removal-loop-run. A
//     failure is a "job-failed" row like every other job's.
//
// By hand:
//   node /opt/tts/removal-loop.mjs --force              (outside the 5 a.m. hour)
//   node /opt/tts/removal-loop.mjs --force --dry-run    (pick, print the prompt, spawn and post nothing)
//   node /opt/tts/removal-loop.mjs --force --base <ref> (against a branch other than main)
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule). Every side
// effect goes through the injected `io`, so removal-loop.test.mjs runs the
// whole job with no model, no git, no gh and no network. Never prints
// TTS_WORKER_KEY.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convexFetch, loadEnv, nyHour, reportJobFailed, reportJobOk } from "./tts-lib.mjs";
import { yamlToJson } from "./tts-code-lib.mjs";
import { utcDay } from "./session-archive.mjs";

// ── The names and the numbers ────────────────────────────────────────────────

export const REPO = "tom.quest";
const REPO_SLUG = "Heffnt/tom.quest";
/** The one label flow control reads. Created once by hand (worker/README.md). */
export const LABEL = "loop-removal";
/** The two kinds this job mints. REMOVAL_LOOP_PR is shared with
 *  convex/ttsSimplify.ts by value. */
export const REMOVAL_LOOP_PR = "removal-loop-pr";
export const REMOVAL_LOOP_RUN = "removal-loop-run";
/** Five a.m. New York: after the nightly job, before the digest at five. */
const LOOP_HOUR = 5;

/** The actuator. Opus, because the deliverable is not the diff but the
 *  explanation that becomes the pull request's body. Codex was capped when
 *  the loop landed; worker/README.md records what switching would take. */
const ACTUATOR_RUNNER = "claude";
const ACTUATOR_MODEL = "opus";

/** The trailer every loop commit carries, the one the loop's own brief named. */
const COMMIT_TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";

/** The clone the loop measures in and audits from. FULL, not shallow like
 *  tts-code-lib.mjs cacheRepoDir's: the audit diffs a pushed head against its
 *  merge base, and a depth-one clone has no merge base. Its own directory, so
 *  resetting it to another branch never moves the clone evals.mjs reads. */
const CLONE_DIR = process.env.TTS_REMOVAL_LOOP_DIR || "/var/cache/tts/removal-loop/tom.quest";

/** The one piece of local state: violations a run declined, corrections
 *  waiting for the next pull request, heads already audited. LOST ON A BOX
 *  REBUILD, and every loss is recoverable: a declined violation is asked again
 *  once and declined again, a waiting correction is the one his reply's row
 *  still records, and an unaudited head is audited on the next tick. */
const STATE_FILE = process.env.TTS_REMOVAL_LOOP_STATE || "/var/lib/tts/removal-loop.json";

/** Steering entries this loop owns start with this; the brief-writing one
 *  rides along because the pull-request body is written for Tom. */
const STEERING_PREFIX = "removal-loop-";
const STEERING_ALWAYS = ["ground-up-explanations"];

/** The line box-run.mjs appends to a run's report, which is not the report. */
const STATUS_LINE_RE = /^box-run: run \S+ host \S+ runner \S+ exit .*$/m;

// ── Small pure pieces ────────────────────────────────────────────────────────

function askIdFor(pr) {
  return `loop:${pr}`;
}

/** A closed-unmerged loop pull request's branch names the violation Tom
 *  refused: `loop/removals/<rule>-<fingerprint>`, the key --exclude takes. */
export function refusedKeys(closed) {
  return (closed ?? [])
    .filter((pr) => !pr?.mergedAt && typeof pr?.headRefName === "string")
    .map((pr) => pr.headRefName.replace(/^loop\/removals\//, ""))
    .filter((key) => key !== "")
    .sort();
}

/** Tom's past corrections to this loop, as trigger-and-correction pairs. */
export function feedbackText(entries) {
  const kept = (Array.isArray(entries) ? entries : []).filter(
    (e) => typeof e?.id === "string" && (e.id.startsWith(STEERING_PREFIX) || STEERING_ALWAYS.includes(e.id)),
  );
  if (kept.length === 0) return "None yet.";
  return kept
    .map((e) => `- When: ${String(e.trigger ?? "").trim()}\n  Do: ${String(e.correction ?? "").trim().replace(/\n/g, "\n      ")}`)
    .join("\n");
}

/** The next free number for `removal-loop-<rule>-<n>`. */
export function nextSteeringId(entries, ruleId) {
  const prefix = `${STEERING_PREFIX}${ruleId}-`;
  let max = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (typeof e?.id !== "string" || !e.id.startsWith(prefix)) continue;
    const n = Number.parseInt(e.id.slice(prefix.length), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/**
 * One vqc/steering.yaml entry, as text to append. HIS WORDS ARE THE
 * CORRECTION, verbatim, in a literal block so no character of them is
 * reinterpreted; the trigger is the only sentence this job writes, and it
 * says where the words were given, not what they mean.
 */
export function steeringEntry({ id, ruleId, where, pr, words, day }) {
  const body = String(words ?? "").trim().split(/\r?\n/).map((line) => `    ${line}`.trimEnd()).join("\n");
  return [
    "",
    `- id: ${id}`,
    "  kind: preference",
    "  owner: tom",
    `  created: ${day}`,
    "  trigger: >-",
    `    a removal-loop pull request for ${ruleId}, as on pull request ${pr} (${where})`,
    "  correction: |-",
    body,
    "  incidents: 1",
    "  graduation: prose",
    "",
  ].join("\n");
}

/** Whether a reply says more than the one word that closes the pull request. */
export function wordsBeyondRevert(text) {
  return String(text ?? "").trim().replace(/^revert\b[.!]?/i, "").trim() !== "";
}

/**
 * The run's final message, split. `DECLINED: <why>` is a decline; otherwise
 * the first line is `SUBJECT: <commit subject>` and the rest is the body.
 * Anything else is a report the job cannot use, and says so.
 */
export function parseReport(stdout) {
  const text = String(stdout ?? "").replace(STATUS_LINE_RE, "").trim();
  const declined = /^DECLINED:\s*(.+)$/m.exec(text);
  if (declined && !/^SUBJECT:/m.test(text)) return { declined: declined[1].trim(), subject: null, body: null };
  const at = text.search(/^SUBJECT:/m);
  if (at === -1) return { declined: null, subject: null, body: null, unusable: text.slice(0, 500) };
  const rest = text.slice(at);
  const newline = rest.indexOf("\n");
  const subject = (newline === -1 ? rest : rest.slice(0, newline)).replace(/^SUBJECT:\s*/, "").trim();
  const body = newline === -1 ? "" : rest.slice(newline + 1).trim();
  if (subject === "" || body === "") return { declined: null, subject: null, body: null, unusable: text.slice(0, 500) };
  return { declined: null, subject, body };
}

const RESPONSE_TEMPLATE = `Your final message becomes the pull request's body, verbatim, and Tom reads it. He does not read code. Write it in this shape and nothing else:

SUBJECT: <the commit subject, word for word>

### What was removed
<what the thing was and what it did, in plain words, from concepts he already has>

### Why it cannot be needed
<the evidence you checked: what you searched, what you found, what nothing depends on>

### What a person would notice
<what changes for someone using tom.Quest or the box; "nothing" is a real answer, say why>

Ground-up: define every term the first time you use it, invent no names, concrete before abstract. Load the tom-write skill before you write it.`;

/** The prompt for a new removal. Everything the run needs is in it; the two
 *  skills are named, not inlined — the run loads them itself. */
function actuatorPrompt({ violation, golden, feedback, branch, base, baseSha }) {
  return `You are removing one complexity smell from tom.Quest, the repository you are checked out in, at ${base} (${baseSha}). A daily job picked it by deterministic code; it is the smallest of the violations the committed baseline, sg/baseline.tsv, lists. First load two skills with the Skill tool: tom-repo-tom-quest (this repository's rules) and tom-write (how Tom reads).

## The violation

- rule: ${violation.ruleId}
- file: ${violation.path}, line ${violation.line} when measured
- estimate: about ${violation.lines} line(s) removed, ${violation.files} file(s) touched
- baseline line: ${violation.ruleId}\t${violation.path}\t${violation.fingerprint}

The matched text:

\`\`\`
${violation.text}
\`\`\`

## The after-state for this rule (sg/goldens/${violation.ruleId}.md)

${golden}

## Corrections Tom has given this loop before

${feedback}

## What to do

1. \`git switch -c ${branch}\`
2. Make this one removal and nothing else. No renames, no neighbouring clean-up, no second violation.
3. \`node scripts/removal-sensor.mjs --write-baseline\` (ast-grep is on PATH; call it \`ast-grep\`, never \`sg\`). The line above must be gone from sg/baseline.tsv and no line may be added.
4. \`npx tsc --noEmit -p tsconfig.json\`, \`pnpm check:guardrails\`, and the tests of every file you touched. All must pass.
5. One commit. Subject: lowercase, names the area, states the world after the change (AGENTS.md). Body: full sentences, one idea per paragraph. The last line, exactly:
   ${COMMIT_TRAILER}
6. \`git push origin HEAD:refs/heads/${branch}\`. Never push main. Do not open a pull request: the job opens it.

If the removal cannot be right — the after-state names the cases — decline it: commit nothing, push nothing, and make your whole final message one line, \`DECLINED: <one sentence saying why>\`.

## Your final message

${RESPONSE_TEMPLATE}`;
}

/** The prompt for a rewrite after Tom's reply. */
function iteratePrompt({ pr, branch, diff, body, words, steeringBlock }) {
  return `You are revising pull request ${pr} of tom.Quest, the removal loop's one open pull request, after Tom replied to it. You are checked out at the tip of its branch, ${branch}. First load two skills with the Skill tool: tom-repo-tom-quest and tom-write.

## Tom's reply, verbatim

${words}

## The pull request's diff now

\`\`\`diff
${diff}
\`\`\`

## Its body now

${body}

## What to do

1. \`git switch -C ${branch}\`
2. Change the branch so it does what his reply says. Ordinary commits on top; never force-push, never rewrite what is there.
3. Append this entry to the END of vqc/steering.yaml exactly as written — his words are the correction and are not edited:

\`\`\`yaml
${steeringBlock.trim()}
\`\`\`

4. \`node scripts/removal-sensor.mjs --write-baseline\`, then \`npx tsc --noEmit -p tsconfig.json\`, \`pnpm check:guardrails\`, and the tests of every file you touched. All must pass.
5. Commit the fix and the steering entry together. Subject lowercase, naming the area and the world after the change; body in full sentences; the last line, exactly:
   ${COMMIT_TRAILER}
6. \`git push origin HEAD:refs/heads/${branch}\`. Never push main.

## Your final message

The whole new body, which replaces the old one. It must say what changed because of his reply.

${RESPONSE_TEMPLATE}`;
}

/** The comment a closed pull request carries: his words, quoted. */
export function closeComment(words) {
  const quoted = String(words ?? "").trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return `Closed on Tom's reply in #tts-simplify:\n\n${quoted}\n\nThe removal loop does not reopen a pull request he closed, and will not pick this violation again.`;
}

// ── The doors ────────────────────────────────────────────────────────────────

function runCommand(command, args, { cwd, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "").slice(-2000),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function must(result, what) {
  if (!result.ok) throw new Error(`${what} failed: ${(result.error ?? result.stderr ?? "").trim().slice(0, 400)}`);
  return result;
}

/** Every side effect this job has, as one object. */
export const REAL_IO = {
  fetch: convexFetch,
  now: () => Date.now(),
  gh: (args, opts) => runCommand("gh", args, opts),
  git: (args, opts) => runCommand("git", args, opts),
  node: (args, opts) => runCommand(process.execPath, args, opts),
  boxRun: (args, prompt) => runCommand("tts-run", args, { input: prompt }),
  audit: (args) => runCommand("tts-audit", args),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  exists: (file) => fs.existsSync(file),
  yaml: (file) => yamlToJson(file),
  tempFile: (name, text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "removal-loop-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  },
  stateRead: () => {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      return {};
    }
  },
  stateWrite: (state) => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  },
  reportFailed: reportJobFailed,
  reportOk: reportJobOk,
  out: (line) => console.log(line),
};

/** The measuring clone, at the tip of `base`: cloned once, then fetched and
 *  reset hard every tick, so nothing a run or a person left there survives.
 *  Credentials come from the box's git credential helper, never the URL. */
function refreshClone(io, base) {
  if (!io.exists(path.join(CLONE_DIR, ".git"))) {
    must(io.git(["clone", `https://github.com/${REPO_SLUG}.git`, CLONE_DIR]), "cloning tom.quest");
  }
  must(io.git(["-C", CLONE_DIR, "fetch", "--prune", "--no-tags", "origin"]), "fetching tom.quest");
  must(io.git(["-C", CLONE_DIR, "checkout", "--detach", "--force", `origin/${base}`]), `checking out ${base}`);
  must(io.git(["-C", CLONE_DIR, "reset", "--hard", `origin/${base}`]), `resetting to ${base}`);
  must(io.git(["-C", CLONE_DIR, "clean", "-fd"]), "cleaning the clone");
  return must(io.git(["-C", CLONE_DIR, "rev-parse", "HEAD"]), "reading the head").stdout.trim();
}

function ghJson(io, args) {
  return JSON.parse(must(io.gh(args), `gh ${args.slice(0, 2).join(" ")}`).stdout || "null");
}

function steeringEntries(io, file) {
  try {
    const parsed = io.yaml(file);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Audit one pushed head: the merge gate's second check. The first and third
 *  (CI's tests, the evals) arrive on their own for any pull request. */
function auditHead(io, state, { sha, branch, base, subject, note }) {
  const audited = state.audited ?? {};
  if (audited[sha]) return;
  must(io.git(["-C", CLONE_DIR, "fetch", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]), `fetching ${branch}`);
  const mergeBase = must(io.git(["-C", CLONE_DIR, "merge-base", `origin/${base}`, sha]), "finding the merge base").stdout.trim();
  const result = io.audit(["--repo", REPO, "--sha", sha, "--base", mergeBase, "--subject", subject, "--dir", CLONE_DIR]);
  // Exit 4 is "audited, and not approved": a verdict, recorded by the audit
  // itself. Anything else that is not 0 is an audit that did not happen.
  if (!result.ok && result.status !== 4) {
    note(`the audit of ${sha.slice(0, 7)} did not run: ${(result.error ?? result.stderr).trim().slice(0, 300)}`);
    return;
  }
  state.audited = { ...audited, [sha]: true };
}

// ── The merge pass ───────────────────────────────────────────────────────────

async function mergePass({ io, env, state, pr, base, day, note }) {
  const askId = askIdFor(pr.number);
  const found = await io.fetch(env, "/tts/removals-open");
  const rows = Array.isArray(found) ? found : (found?.removals ?? []);
  const row = rows.find((r) => r?.askId === askId) ?? null;
  const head = pr.headRefOid;

  if (row === null) {
    // Opened, but its posting never reached the record (a failed POST after
    // the pull request was created). Post it now: his day starts from here.
    await io.fetch(env, "/tts/event", {
      kind: REMOVAL_LOOP_PR,
      key: askId,
      data: { pr: pr.number, url: pr.url, subject: pr.title, round: 0, sha: head, dryRun: false },
    });
    return { action: "posted", reason: "the pull request had no posting on record, so it was posted now" };
  }

  if (row.objection) {
    const words = String(row.objection.text ?? "").trim();
    if (row.objection.revert) {
      must(io.gh(["pr", "close", String(pr.number), "--repo", REPO_SLUG, "--comment", closeComment(words)]), "closing the pull request");
      if (wordsBeyondRevert(words)) {
        state.pendingSteering = [...(state.pendingSteering ?? []), { words, pr: pr.number, branch: pr.headRefName, day }];
      }
      return { action: "closed", reason: `Tom replied "${words.slice(0, 200)}"` };
    }
    // A rewrite from his words, on the same branch.
    const diff = must(io.gh(["pr", "diff", String(pr.number), "--repo", REPO_SLUG]), "reading the diff").stdout;
    must(io.git(["-C", CLONE_DIR, "fetch", "--no-tags", "origin", `refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]), "fetching the branch");
    const onBranch = must(io.git(["-C", CLONE_DIR, "show", `origin/${pr.headRefName}:vqc/steering.yaml`]), "reading the branch's steering").stdout;
    const steeringFile = io.tempFile("steering.yaml", onBranch);
    const ruleId = pr.headRefName.replace(/^loop\/removals\//, "").replace(/-[0-9a-f]{8}$/, "");
    const block = steeringEntry({
      id: nextSteeringId(steeringEntries(io, steeringFile), ruleId),
      ruleId,
      where: `branch ${pr.headRefName}`,
      pr: pr.number,
      words,
      day,
    });
    const prompt = iteratePrompt({ pr: pr.number, branch: pr.headRefName, diff, body: pr.body ?? "", words, steeringBlock: block });
    const ran = io.boxRun(
      ["--runner", ACTUATOR_RUNNER, "--model", ACTUATOR_MODEL, "--repo", REPO, "--ref", pr.headRefName, "--install", "--tests"],
      prompt,
    );
    const report = parseReport(ran.stdout);
    if (!ran.ok || report.subject === null) {
      note(`the rewrite of pull request ${pr.number} did not finish: exit ${ran.status}; ${report.unusable ?? report.declined ?? ran.stderr}`.slice(0, 500));
      return { action: "rewrite-failed", reason: "the run did not return a body" };
    }
    const view = ghJson(io, ["pr", "view", String(pr.number), "--repo", REPO_SLUG, "--json", "headRefOid"]);
    if (view?.headRefOid === head) {
      note(`the rewrite of pull request ${pr.number} pushed nothing`);
      return { action: "rewrite-failed", reason: "the branch did not move" };
    }
    must(io.gh(["pr", "edit", String(pr.number), "--repo", REPO_SLUG, "--body-file", io.tempFile("body.md", report.body)]), "rewriting the body");
    await io.fetch(env, "/tts/event", {
      kind: REMOVAL_LOOP_PR,
      key: askId,
      data: {
        pr: pr.number,
        url: pr.url,
        subject: pr.title,
        round: (row.round ?? 0) + 1,
        sha: view.headRefOid,
        objectionAt: row.objection.at,
        dryRun: false,
      },
    });
    auditHead(io, state, { sha: view.headRefOid, branch: pr.headRefName, base, subject: pr.title, note });
    return { action: "rewritten", reason: `rewritten from Tom's reply, round ${(row.round ?? 0) + 1}` };
  }

  if (!row.windowClosed) {
    auditHead(io, state, { sha: head, branch: pr.headRefName, base, subject: pr.title, note });
    return { action: "held", reason: "his day to object has not closed" };
  }

  const gate = await io.fetch(env, `/tts/merge-gate?repo=${encodeURIComponent(REPO)}&sha=${encodeURIComponent(head)}`);
  if (gate?.allowed !== true) {
    auditHead(io, state, { sha: head, branch: pr.headRefName, base, subject: pr.title, note });
    return { action: "held", reason: `the merge gate is shut: ${(gate?.missing ?? []).join(", ") || "no answer"}` };
  }
  must(io.gh(["pr", "merge", String(pr.number), "--squash", "--repo", REPO_SLUG, "--match-head-commit", head]), "merging");
  try {
    await io.fetch(env, "/tts/merge", { repo: REPO, sha: head, subject: pr.title });
  } catch (error) {
    note(`merged pull request ${pr.number}, but the merge was not recorded: ${String(error?.message ?? error).slice(0, 300)}`);
  }
  return { action: "merged", reason: "a day and a digest passed with no reply, and the gate was open" };
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runRemovalLoop({ force = false, dryRun = false, base = "main", env = null, io = REAL_IO } = {}) {
  const now = io.now();
  if (!force && nyHour(now) !== LOOP_HOUR) {
    console.log(`[removal-loop] NY hour is ${nyHour(now)}, not ${LOOP_HOUR} — the other cron slot, exiting (use --force to override)`);
    return null;
  }
  const day = utcDay(now);
  const resolvedEnv = env ?? loadEnv();
  const failures = [];
  const note = (what) => {
    console.error(`[removal-loop] ${what}`);
    failures.push(what);
  };
  const state = io.stateRead();
  let result = { day, action: "none", reason: "", failures };

  const record = async (data) => {
    if (dryRun) return;
    try {
      await io.fetch(resolvedEnv, "/tts/event", { kind: REMOVAL_LOOP_RUN, key: day, data: { day, ...data, failures } });
    } catch (error) {
      note(`could not record the tick: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  };

  try {
    // 0. FLOW CONTROL, before anything else.
    const open = ghJson(io, [
      "pr", "list", "--repo", REPO_SLUG, "--label", LABEL, "--state", "open",
      "--json", "number,headRefOid,headRefName,title,url,body",
    ]) ?? [];
    if (open.length > 0) {
      const pr = open[0];
      if (dryRun) {
        io.out(`[removal-loop] DRY RUN — pull request ${pr.number} is open, so only the merge pass would run.`);
        return { ...result, action: "held", pr: pr.number };
      }
      refreshClone(io, base);
      const pass = await mergePass({ io, env: resolvedEnv, state, pr, base, day, note });
      result = { ...result, ...pass, pr: pr.number };
      await record({ held: true, pr: pr.number, url: pr.url, action: pass.action, reason: pass.reason });
      return result;
    }

    // 1. THE MEASUREMENT, in a clone of the base, by the base's own scripts.
    const baseSha = refreshClone(io, base);
    const closed = ghJson(io, [
      "pr", "list", "--repo", REPO_SLUG, "--label", LABEL, "--state", "closed",
      "--limit", "200", "--json", "headRefName,mergedAt",
    ]);
    const excluded = [...new Set([...refusedKeys(closed), ...Object.keys(state.declined ?? {})])].sort();
    const picked = JSON.parse(
      must(io.node(["scripts/removal-pick.mjs", "--exclude", excluded.join(",")], { cwd: CLONE_DIR }), "the pick").stdout,
    );
    const violation = picked?.violation ?? null;
    if (violation === null) {
      result = { ...result, action: "nothing", reason: `no baseline violation is left to pick (${picked?.baseline ?? 0} in the baseline, ${excluded.length} excluded)` };
      await record({ action: "nothing", reason: result.reason, baselineSha: baseSha });
      return result;
    }
    const branch = `loop/removals/${violation.ruleId}-${violation.fingerprint}`;
    const golden = io.readFile(path.join(CLONE_DIR, "sg", "goldens", `${violation.ruleId}.md`));
    const entries = steeringEntries(io, path.join(CLONE_DIR, "vqc", "steering.yaml"));
    const prompt = actuatorPrompt({ violation, golden, feedback: feedbackText(entries), branch, base, baseSha });

    // Corrections from a reverted pull request travel with the next one: his
    // words reach vqc/steering.yaml through the gate like any other change.
    const pending = state.pendingSteering ?? [];
    let fullPrompt = prompt;
    let taken = [];
    if (pending.length > 0) {
      let counted = entries;
      const blocks = [];
      for (const item of pending) {
        const ruleId = String(item.branch ?? "").replace(/^loop\/removals\//, "").replace(/-[0-9a-f]{8}$/, "") || "loop";
        const id = nextSteeringId(counted, ruleId);
        counted = [...counted, { id }];
        blocks.push(steeringEntry({ id, ruleId, where: `branch ${item.branch}`, pr: item.pr, words: item.words, day: item.day }));
      }
      taken = pending;
      fullPrompt = `${prompt}\n\n## One more thing in the same commit\n\nTom closed an earlier loop pull request with words beyond "revert". Append ${blocks.length === 1 ? "this entry" : "these entries"} to the END of vqc/steering.yaml exactly as written, and say so in the body:\n\n\`\`\`yaml\n${blocks.join("").trim()}\n\`\`\``;
    }

    if (dryRun) {
      io.out(`[removal-loop] DRY RUN — picked ${violation.ruleId} in ${violation.path} (${violation.lines} line(s), ${violation.files} file(s)) of ${picked.baseline} in the baseline at ${base} ${baseSha.slice(0, 7)}; branch ${branch}. Nothing spawned, nothing posted.`);
      io.out(fullPrompt);
      return { ...result, action: "dry-run", violation, branch, prompt: fullPrompt };
    }

    // 2. THE ACTUATOR.
    const ran = io.boxRun(
      ["--runner", ACTUATOR_RUNNER, "--model", ACTUATOR_MODEL, "--repo", REPO, "--ref", base, "--install", "--tests"],
      fullPrompt,
    );
    const report = parseReport(ran.stdout);
    if (report.declined !== null) {
      state.declined = { ...(state.declined ?? {}), [`${violation.ruleId}-${violation.fingerprint}`]: { why: report.declined, day } };
      result = { ...result, action: "declined", reason: report.declined, violation };
      await record({ action: "declined", reason: report.declined, ruleId: violation.ruleId, path: violation.path, fingerprint: violation.fingerprint });
      return result;
    }
    if (!ran.ok || report.subject === null) {
      note(`the removal run did not finish: exit ${ran.status}; ${report.unusable ?? ran.stderr}`.slice(0, 500));
      result = { ...result, action: "run-failed", violation };
      await record({ action: "run-failed", ruleId: violation.ruleId, path: violation.path });
      return result;
    }
    const pushed = must(io.git(["ls-remote", `https://github.com/${REPO_SLUG}.git`, `refs/heads/${branch}`]), "reading the pushed branch").stdout.trim();
    if (pushed === "") {
      note(`the run returned a body but pushed no ${branch}`);
      result = { ...result, action: "run-failed", violation };
      await record({ action: "run-failed", ruleId: violation.ruleId, path: violation.path, reason: "nothing pushed" });
      return result;
    }
    const sha = pushed.split(/\s+/)[0];

    // 3. THE PULL REQUEST, opened here so the label is never a model's to forget.
    const created = must(
      io.gh([
        "pr", "create", "--repo", REPO_SLUG, "--base", base, "--head", branch,
        "--title", report.subject, "--body-file", io.tempFile("body.md", report.body), "--label", LABEL,
      ]),
      "opening the pull request",
    ).stdout.trim();
    const number = Number.parseInt(/\/pull\/(\d+)/.exec(created)?.[1] ?? "", 10);
    if (!Number.isInteger(number)) throw new Error(`gh pr create answered no pull request URL: ${created.slice(0, 200)}`);
    state.pendingSteering = pending.filter((item) => !taken.includes(item));
    await io.fetch(resolvedEnv, "/tts/event", {
      kind: REMOVAL_LOOP_PR,
      key: askIdFor(number),
      data: {
        pr: number,
        url: created,
        subject: report.subject,
        ruleId: violation.ruleId,
        path: violation.path,
        fingerprint: violation.fingerprint,
        lines: violation.lines,
        files: violation.files,
        round: 0,
        sha,
        base,
        dryRun: false,
      },
    });
    auditHead(io, state, { sha, branch, base, subject: report.subject, note });
    result = { ...result, action: "opened", pr: number, url: created, violation };
    await record({ action: "opened", pr: number, url: created, ruleId: violation.ruleId, path: violation.path, fingerprint: violation.fingerprint });
    return result;
  } catch (error) {
    note(String(error?.message ?? error).slice(0, 500));
    await record({ action: "failed" });
    return { ...result, action: "failed" };
  } finally {
    if (!dryRun) {
      try {
        io.stateWrite(state);
      } catch (error) {
        note(`could not write ${STATE_FILE}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
      if (failures.length > 0) {
        await io.reportFailed(resolvedEnv, { job: "removal-loop", error: failures.join("; ").slice(0, 2000), key: "removal-loop:run" });
      } else {
        await io.reportOk(resolvedEnv, { job: "removal-loop", key: "removal-loop:run" });
      }
    }
    console.log(`[removal-loop] ${result.action}${result.reason ? `: ${result.reason}` : ""}; ${failures.length} failure(s)`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--base");
  const result = await runRemovalLoop({
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
    base: at === -1 ? "main" : argv[at + 1],
  });
  if (result !== null && result.failures.length > 0) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[removal-loop] FAILED: ${err.message}`);
    process.exit(1);
  });
}

