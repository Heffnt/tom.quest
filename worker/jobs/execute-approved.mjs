#!/usr/bin/env node
// execute-approved.mjs — execute ONE approved code-todo plan as a PR.
//
// Run by cron at 45 past each hour (see /etc/cron.d/tts). Manual run:
//   node /opt/tts/execute-approved.mjs
//
// THE EXECUTION HALF of the ruling loop: when Tom's verdict is "approve" on a
// briefed todo in any GOVERNED REPO (see CODE_REPOS in tts-code-lib.mjs), the
// plan attached to that todo is cleared for autonomous execution. This job
// reads the unified /tts/rulings feed (rows carry subjectType "life"|"code"),
// takes the OLDEST pending CODE approval, runs AGENTIC headless Claude inside
// a throwaway full clone, and turns the result into a PR on that todo's own
// repo. MERGING THE PR IS THE HUMAN GATE — nothing this job does lands on a
// default branch by itself, which is why agentic mode (bypassPermissions) is
// acceptable here: the blast radius is a branch on a clone we delete
// afterward.
//
// ONE AT A TIME, on purpose: a single 45-minute agentic run per hour keeps
// the box's Claude usage bounded, keeps PRs reviewable in series, and means a
// bad run wastes one slot, not a pileup. The mkdir lock (stale after 3h)
// stops overlap when a run outlives its hour.
//
// FRESH FULL CLONE, not the cache: the executor needs real history (its
// commits, log context for the model) and total isolation — whatever the
// model does to the tree is discarded with the clone. The shallow cache
// clones stay pristine for the briefing/apply jobs.
//
// FAILURE POLICY: once a ruling is selected, ANY failure marks it applied
// with "EXECUTION FAILED: …" — Tom sees it in the UI and re-rules "approve"
// to retry. Leaving it pending would make a deterministic failure retry
// hourly forever.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv, convexFetch, runClaude } from "./tts-lib.mjs";
import {
  repoConfig,
  remoteUrl,
  isOpenEntry,
  yamlToJson,
  verifyTodosFile,
  runRepoGuard,
  briefCachePath,
  findEntryBlock,
  acquireLock,
  releaseLock,
} from "./tts-code-lib.mjs";

const LOCK_DIR = "/var/lib/tts/execute.lock";
const LOCK_STALE_MS = 3 * 60 * 60 * 1000; // execution legitimately runs ~45 min
const CLAUDE_TIMEOUT_MS = 45 * 60 * 1000;

// How the agentic run must close the entry it just implemented, in the repo's
// own convention. Same two styles apply-rulings implements in closeEntryText —
// stated here as prose because here the executor is the one doing the surgery.
function closureInstruction(cfg) {
  return cfg.closureStyle === "banner"
    ? `move the entry below the closed-todos banner, keeping its full body,` +
        ` adding a \`closed: <today>\` date and a \`resolution:\` describing what landed`
    : `leave the entry where it is, set its \`status:\` to \`done\`, and add a` +
        ` \`resolution:\` describing what landed (this file has no closed-todos` +
        ` banner — \`status\` is the machine-readable truth)`;
}

function execPrompt(cfg, externalId, entryYaml, briefText) {
  return [
    `You are executing an APPROVED plan in the ${cfg.repo} repo. Tom has`,
    `ruled "approve" on the code todo below through TTS (his delegated todo`,
    `system); your job is to implement the todo's attached plan faithfully — the`,
    `plan is the ratified decision, not a suggestion. Follow the repo's AGENTS.md.`,
    ``,
    `The todo entry (from ${cfg.todosPath}):`,
    ``,
    "```yaml",
    entryYaml,
    "```",
    ``,
    `The brief that was shown to Tom when he approved:`,
    ``,
    briefText ?? `(no brief available — work from the entry above alone)`,
    ``,
    `Requirements:`,
    `- Implement the plan faithfully. Where the plan is silent, follow the repo's`,
    `  existing conventions; do not widen scope.`,
    `- Close the todo entry in ${cfg.todosPath} per that file's own discipline, IN`,
    `  THIS SAME body of work: ${closureInstruction(cfg)}.`,
    `- Run \`${cfg.testCommand}\` and the tests nearest your change, and fix what`,
    `  you break.`,
    `- Commit your work with clear messages (you are already on a work branch).`,
    ``,
    `When done, print a final summary that STARTS with the line "CHANGE REPORT:"`,
    `followed by a ground-up description of what changed as OBSERVABLE BEHAVIOR`,
    `(define every term on first use; write for Tom, who will review the PR).`,
  ].join("\n");
}

// git in the exec clone (kept local: tts-code-lib's git() is identical, but
// importing it for one alias reads worse than three lines).
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

async function main() {
  if (!acquireLock(LOCK_DIR, LOCK_STALE_MS)) {
    console.log("[execute-approved] another run holds the lock — exiting");
    return;
  }
  let env;
  let ruling = null;
  let execDir = null;
  try {
    env = loadEnv();
    const { pending } = await convexFetch(env, "/tts/rulings");
    const approvals = (Array.isArray(pending) ? pending : [])
      .filter((r) => r.subjectType === "code" && r.verdict === "approve")
      .sort((a, b) => (a.ruledAt ?? 0) - (b.ruledAt ?? 0));

    // An approval on a repo TTS does not govern can never be executed; leaving
    // it pending would make it the oldest approval forever and block every
    // real one behind it. Mark it applied so Tom sees why, then move on.
    for (const stray of approvals.filter((r) => repoConfig(r.repo) === null)) {
      await convexFetch(env, "/tts/ruling-applied", {
        id: stray._id,
        result: `EXECUTION FAILED: unsupported repo: ${stray.repo}`,
      });
      console.error(`[execute-approved] ${stray.repo}:${stray.externalId}: unsupported repo`);
    }

    const executable = approvals.filter((r) => repoConfig(r.repo) !== null);
    if (executable.length === 0) return; // quiet when idle

    ruling = executable[0]; // exactly ONE per run — see the header
    const cfg = repoConfig(ruling.repo);
    const id = ruling.externalId;
    const branch = `tts/${id}`;
    // The repo name is in the path: two governed repos may legitimately carry
    // the same todo id, and their exec clones must not collide.
    execDir = `/var/cache/tts/exec-${cfg.repo}-${id}`;
    console.log(
      `[execute-approved] executing ${cfg.repo}:${id} (${executable.length} approved pending)`,
    );

    // Fresh FULL clone; delete any corpse from a crashed prior attempt.
    fs.rmSync(execDir, { recursive: true, force: true });
    execFileSync("git", ["clone", "--branch", cfg.defaultBranch, remoteUrl(env, cfg), execDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    git(execDir, "checkout", "-b", branch);

    // The entry as it stands on the default branch right now — if it vanished
    // (archived by a racing ruling, or renamed), executing the stale plan
    // would be wrong, so fail the ruling instead.
    const todosFile = path.join(execDir, cfg.todosPath);
    const todosText = fs.readFileSync(todosFile, "utf8");
    const found = findEntryBlock(todosText, id);
    if (!found) {
      throw new Error(`todo entry ${id} not found in ${cfg.todosPath} on ${cfg.defaultBranch}`);
    }
    const parsedEntries = yamlToJson(todosFile);
    const idsBefore = Array.isArray(parsedEntries)
      ? parsedEntries.filter((e) => e && typeof e === "object").map((e) => e.id)
      : [];
    const parsedEntry = Array.isArray(parsedEntries)
      ? parsedEntries.find((e) => e && typeof e === "object" && e.id === id)
      : undefined;
    if (parsedEntry && !isOpenEntry(parsedEntry)) {
      throw new Error(`todo entry ${id} is already closed`);
    }

    let briefText = null;
    try {
      briefText = fs.readFileSync(briefCachePath(cfg.repo, id), "utf8").trimEnd();
    } catch {
      // Brief cache lost — degraded but workable; the prompt says so.
    }

    // The agentic run. Everything it can damage is inside execDir.
    const answer = runClaude(execPrompt(cfg, id, found.block, briefText), {
      cwd: execDir,
      agentic: true,
      timeoutMs: CLAUDE_TIMEOUT_MS,
    });

    // The change report is the PR body; if the model ignored the format,
    // ship its whole final message rather than losing the account of what
    // happened (the PR reviewer needs SOMETHING).
    const reportAt = answer.indexOf("CHANGE REPORT:");
    const report = reportAt >= 0 ? answer.slice(reportAt) : answer.trim();

    // Gate 1: the run must have actually committed something.
    const commitCount = parseInt(
      git(execDir, "rev-list", "--count", `origin/${cfg.defaultBranch}..HEAD`).trim(),
      10,
    );
    if (!(commitCount > 0)) throw new Error("agentic run produced no commits");

    // Gate 2: the todos registry must still be well-formed AND the entry must
    // actually be closed — the run was REQUIRED to close it, and a malformed
    // registry must never even reach a PR. (Re-run here ourselves: the prompt
    // asked the model to run tests, but a gate you don't hold yourself is not
    // a gate.) verifyTodosFile is the box's floor for every repo; runRepoGuard
    // adds the repo's own todos test where the box can run it — where it
    // cannot (tom.quest's vitest guard needs node_modules), the PR's CI is
    // where that guard runs, before Tom merges.
    for (const check of [
      verifyTodosFile(cfg, execDir, { idsBefore, closedId: id, allowNewIds: true }),
      runRepoGuard(cfg, execDir),
    ]) {
      if (!check.ok) throw new Error(`todos guard failed: ${check.tail}`);
    }

    // Force: the tts/<id> branch namespace is owned by this executor alone,
    // and a retry (Tom re-ruled approve after a failure) must overwrite the
    // failed attempt's leftover remote branch rather than reject.
    git(execDir, "push", "--force", "origin", branch);

    // gh reads GH_TOKEN from the environment; --head/--base pinned explicitly
    // so a detached or renamed local state can't misfile the PR.
    const prBody =
      report + `\n\nMerging this PR is the persist-tom-gate for ${cfg.repo}:${id}.`;
    const prOut = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        `tts: ${id}`,
        "--base",
        cfg.defaultBranch,
        "--head",
        branch,
        "--body",
        prBody,
      ],
      {
        cwd: execDir,
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: env.GH_TOKEN },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // gh prints the PR URL as the last non-empty stdout line.
    const prUrl =
      prOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .pop() ?? "(no URL in gh output)";

    await convexFetch(env, "/tts/ruling-applied", {
      id: ruling._id,
      result: `PR opened: ${prUrl}`,
    });
    console.log(`[execute-approved] ${cfg.repo}:${id}: ${prUrl} (${commitCount} commit(s))`);
  } catch (err) {
    // Selected-but-failed: mark applied so Tom sees the failure and the
    // queue moves on (re-ruling "approve" is the retry). Failures BEFORE
    // selection (env, Convex down) just log-and-exit like every other job.
    const reason = String(err.message ?? err).slice(-400);
    console.error(`[execute-approved] FAILED: ${reason}`);
    if (ruling && env) {
      try {
        await convexFetch(env, "/tts/ruling-applied", {
          id: ruling._id,
          result: `EXECUTION FAILED: ${reason}`,
        });
      } catch (markErr) {
        console.error(`[execute-approved] could not mark failure: ${markErr.message}`);
      }
    }
    process.exitCode = 1;
  } finally {
    // The exec clone is disposable BY DESIGN — success or failure, delete it.
    // (The pushed branch and the PR are the durable outputs.)
    if (execDir) fs.rmSync(execDir, { recursive: true, force: true });
    releaseLock(LOCK_DIR);
  }
}

main().catch((err) => {
  console.error(`[execute-approved] FAILED: ${err.message}`);
  process.exit(1);
});
