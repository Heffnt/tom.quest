#!/usr/bin/env node
// execute-approved.mjs — execute ONE approved code-todo plan as a PR.
//
// Run by cron at 45 past each hour (see /etc/cron.d/dts). Manual run:
//   node /opt/dts/execute-approved.mjs
//
// THE EXECUTION HALF of the ruling loop: when Tom's verdict is "approve" on a
// briefed CMT todo, the plan attached to that todo is cleared for autonomous
// execution. This job reads the unified /dts/rulings feed (rows carry
// subjectType "life"|"code"), takes the OLDEST pending CODE approval, runs AGENTIC
// headless Claude inside a throwaway full clone, and turns the result into a
// PR on github.com/Heffnt/ComplexMultiTrigger. MERGING THE PR IS THE HUMAN
// GATE — nothing this job does lands on master by itself, which is why
// agentic mode (bypassPermissions) is acceptable here: the blast radius is a
// branch on a clone we delete afterward.
//
// ONE AT A TIME, on purpose: a single 45-minute agentic run per hour keeps
// the box's Claude usage bounded, keeps PRs reviewable in series, and means a
// bad run wastes one slot, not a pileup. The mkdir lock (stale after 3h)
// stops overlap when a run outlives its hour.
//
// FRESH FULL CLONE, not the cache: the executor needs real history (its
// commits, log context for the model) and total isolation — whatever the
// model does to the tree is discarded with the clone. The shallow cache
// clone stays pristine for the briefing/apply jobs.
//
// FAILURE POLICY: once a ruling is selected, ANY failure marks it applied
// with "EXECUTION FAILED: …" — Tom sees it in the UI and re-rules "approve"
// to retry. Leaving it pending would make a deterministic failure retry
// hourly forever.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEnv, convexFetch, runClaude } from "./dts-lib.mjs";
import {
  CMT_REPO,
  CMT_DEFAULT_BRANCH,
  TODOS_PATH,
  TODOS_GUARD_TEST,
  cmtRemoteUrl,
  briefCachePath,
  findEntryBlock,
  acquireLock,
  releaseLock,
} from "./dts-code-lib.mjs";

const LOCK_DIR = "/var/lib/dts/execute.lock";
const LOCK_STALE_MS = 3 * 60 * 60 * 1000; // execution legitimately runs ~45 min
const CLAUDE_TIMEOUT_MS = 45 * 60 * 1000;

function execPrompt(externalId, entryYaml, briefText) {
  return [
    `You are executing an APPROVED plan in the ComplexMultiTrigger repo. Tom has`,
    `ruled "approve" on the code todo below through DTS (his delegated todo`,
    `system); your job is to implement the todo's attached plan faithfully — the`,
    `plan is the ratified decision, not a suggestion. Follow the repo's AGENTS.md.`,
    ``,
    `The todo entry (from ${TODOS_PATH}):`,
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
    `- Close the todo entry in ${TODOS_PATH} per that file's own discipline, IN`,
    `  THIS SAME body of work: move the entry below the closed-todos banner,`,
    `  keeping its full body, adding a \`closed: <today>\` date and a`,
    `  \`resolution:\` describing what landed.`,
    `- Run \`python3 -m pytest tests/guards -q\` and the tests nearest your`,
    `  change, and fix what you break.`,
    `- Commit your work with clear messages (you are already on a work branch).`,
    ``,
    `When done, print a final summary that STARTS with the line "CHANGE REPORT:"`,
    `followed by a ground-up description of what changed as OBSERVABLE BEHAVIOR`,
    `(define every term on first use; write for Tom, who will review the PR).`,
  ].join("\n");
}

// git in the exec clone (kept local: dts-code-lib's git() is identical, but
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
    const { pending } = await convexFetch(env, "/dts/rulings");
    const approvals = (Array.isArray(pending) ? pending : [])
      .filter(
        (r) =>
          r.subjectType === "code" && r.repo === CMT_REPO && r.verdict === "approve",
      )
      .sort((a, b) => (a.ruledAt ?? 0) - (b.ruledAt ?? 0));
    if (approvals.length === 0) return; // quiet when idle

    ruling = approvals[0]; // exactly ONE per run — see the header
    const id = ruling.externalId;
    const branch = `dts/${id}`;
    execDir = `/var/cache/dts/exec-${id}`;
    console.log(`[execute-approved] executing ${id} (${approvals.length} approved pending)`);

    // Fresh FULL clone; delete any corpse from a crashed prior attempt.
    fs.rmSync(execDir, { recursive: true, force: true });
    execFileSync("git", ["clone", cmtRemoteUrl(env), execDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    git(execDir, "checkout", "-b", branch);

    // The entry as it stands on master right now — if it vanished (archived
    // by a racing ruling, or renamed), executing the stale plan would be
    // wrong, so fail the ruling instead.
    const todosText = fs.readFileSync(path.join(execDir, TODOS_PATH), "utf8");
    const found = findEntryBlock(todosText, id);
    if (!found) throw new Error(`todo entry ${id} not found in ${TODOS_PATH} on master`);
    if (/^ {2}closed:/m.test(found.block)) throw new Error(`todo entry ${id} is already closed`);

    let briefText = null;
    try {
      briefText = fs.readFileSync(briefCachePath(CMT_REPO, id), "utf8").trimEnd();
    } catch {
      // Brief cache lost — degraded but workable; the prompt says so.
    }

    // The agentic run. Everything it can damage is inside execDir.
    const answer = runClaude(execPrompt(id, found.block, briefText), {
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
      git(execDir, "rev-list", "--count", `origin/${CMT_DEFAULT_BRANCH}..HEAD`).trim(),
      10,
    );
    if (!(commitCount > 0)) throw new Error("agentic run produced no commits");

    // Gate 2: the todos guard must pass — the run was REQUIRED to close the
    // todo entry, and a malformed todos.yaml must never even reach a PR.
    // (Re-run here ourselves: the prompt asked the model to run tests, but a
    // gate you don't hold yourself is not a gate.)
    execFileSync("python3", ["-m", "pytest", TODOS_GUARD_TEST, "-q"], {
      cwd: execDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    });

    // Force: the dts/<id> branch namespace is owned by this executor alone,
    // and a retry (Tom re-ruled approve after a failure) must overwrite the
    // failed attempt's leftover remote branch rather than reject.
    git(execDir, "push", "--force", "origin", branch);

    // gh reads GH_TOKEN from the environment; --head/--base pinned explicitly
    // so a detached or renamed local state can't misfile the PR.
    const prBody =
      report + `\n\nMerging this PR is the persist-tom-gate for cmt:${id}.`;
    const prOut = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--title",
        `dts: ${id}`,
        "--base",
        CMT_DEFAULT_BRANCH,
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

    await convexFetch(env, "/dts/ruling-applied", {
      id: ruling._id,
      result: `PR opened: ${prUrl}`,
    });
    console.log(`[execute-approved] ${id}: ${prUrl} (${commitCount} commit(s))`);
  } catch (err) {
    // Selected-but-failed: mark applied so Tom sees the failure and the
    // queue moves on (re-ruling "approve" is the retry). Failures BEFORE
    // selection (env, Convex down) just log-and-exit like every other job.
    const reason = String(err.message ?? err).slice(-400);
    console.error(`[execute-approved] FAILED: ${reason}`);
    if (ruling && env) {
      try {
        await convexFetch(env, "/dts/ruling-applied", {
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
