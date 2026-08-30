#!/usr/bin/env node
// apply-rulings.mjs — carry out Tom's NON-EXECUTION rulings on code todos.
//
// Run by cron every 10 minutes (see /etc/cron.d/tts). Manual run:
//   node /opt/tts/apply-rulings.mjs
//
// THE RULING LOOP: brief-code-todos.mjs posts a brief + recommendation per
// open CMT todo; Tom rules in the tom.quest UI; Convex queues the ruling;
// this job GETs /tts/rulings — a UNIFIED feed whose rows carry
// subjectType "life"|"code" and verdict "execute"|"edit"|"session"|
// "archive" — takes only the CODE rows (life rows belong to
// prepare-life-todos.mjs), applies each pending one, then POSTs
// /tts/ruling-applied so the UI shows the outcome. The verdicts:
//   edit   -> Tom's sentence redirects the plan: force a re-brief that
//               proposes a fresh one
//   session  -> push a session-agenda file to CMT master for Tom to open a
//               live Claude session from
//   archive  -> close the todo in vqc/todos.yaml (guard-checked, never
//               pushed red)
//   execute  -> NOT ours. execute-plans.mjs owns executions; we skip them
//               entirely (not even mark-applied).
// There is NO "defer" verdict — not ruling IS deferring.
//
// SERIALIZATION: a 10-minute cron plus pushes that can take minutes means
// runs can overlap; the mkdir lock /var/lib/tts/apply.lock ensures only one
// applier mutates the cache clone / pushes at a time. Stale locks (a crashed
// holder) are broken after 30 minutes.
//
// FAILURE POLICY: a ruling that fails for an ENVIRONMENTAL reason (push race,
// network) is left pending — the next tick retries it. A ruling that fails
// for a CONTENT reason (guards red, entry missing) IS marked applied with the
// failure text, because retrying would fail identically forever; Tom sees the
// text in the UI and re-rules once the cause is fixed.

import fs from "node:fs";
import path from "node:path";
import { loadEnv, convexFetch } from "./tts-lib.mjs";
import {
  CMT_REPO,
  CMT_DEFAULT_BRANCH,
  TODOS_PATH,
  TODOS_GUARD_TEST,
  REPLAN_SENTINEL,
  CLOSED_BANNER_PREFIX,
  git,
  cmtRepoDir,
  readBriefHashes,
  writeBriefHashes,
  briefCachePath,
  findEntryBlock,
  acquireLock,
  releaseLock,
} from "./tts-code-lib.mjs";
import { execFileSync } from "node:child_process";

const LOCK_DIR = "/var/lib/tts/apply.lock";
const LOCK_STALE_MS = 30 * 60 * 1000;

// Today as YYYY-MM-DD in UTC. Good enough for `closed:` dates: the only
// consumer is a human reading intent history, and a date that is off by a few
// evening hours around midnight carries zero decision weight.
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Greedy word-wrap to `width` columns — for YAML `>-` block-scalar bodies,
// which re-fold on parse, so the wrap points are cosmetic (matching the
// file's ~100-column style) and never semantic.
function wrapText(text, width) {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

// Run the todos guard test in the repo; {ok, tail} where tail is the last
// chunk of pytest output for the failure report Tom will read in the UI.
function runTodosGuard(repoDir) {
  try {
    execFileSync("python3", ["-m", "pytest", TODOS_GUARD_TEST, "-q"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    });
    return { ok: true, tail: "" };
  } catch (err) {
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    return { ok: false, tail: out.slice(-400) };
  }
}

// The brief cache file's content, or null when it was never written / was
// lost (the cache is rebuildable, so absence is a degraded path, not an
// error). Also extracts the "Evidence:" header line the briefing job wrote.
function readBriefCache(externalId) {
  try {
    const text = fs.readFileSync(briefCachePath(CMT_REPO, externalId), "utf8");
    const evidence = text.match(/^Evidence: (.*)$/m)?.[1] ?? null;
    return { text, evidence };
  } catch {
    return null;
  }
}

// --- the per-verdict handlers (each returns the applied-result string) -----

// edit: poke the briefing cursor. Setting the cursor value to the replan
// sentinel (instead of deleting the key) both forces a re-brief (a sentinel
// never equals a recomputed hash) and carries Tom's sentence into the
// re-brief prompt — a bare deletion would be indistinguishable from "never
// briefed" and the redirect would be lost.
function applyEdit(ruling) {
  const hashes = readBriefHashes();
  hashes[`${CMT_REPO}:${ruling.externalId}`] =
    REPLAN_SENTINEL + (ruling.sentence ? `: ${ruling.sentence}` : "");
  writeBriefHashes(hashes);
  return "replan queued";
}

// session: write a self-contained session agenda into the repo itself
// and push it to master. WHY in the repo: Tom starts the session with
//   claude "Run the TTS session in dev/handoff/tts-session-<id>.md"
// from any checkout — the agenda travels with the code it is about, needs no
// tom.quest access, and its git history records what Tom was asked.
function applyDiscuss(env, repoDir, ruling) {
  const id = ruling.externalId;
  const todosText = fs.readFileSync(path.join(repoDir, TODOS_PATH), "utf8");
  const found = findEntryBlock(todosText, id);
  const cached = readBriefCache(id);

  const agendaRel = `dev/handoff/tts-session-${id}.md`;
  const agenda = [
    `# TTS session agenda — ${id}`,
    ``,
    `This file is a session agenda written by TTS (Tom's delegated todo system)`,
    `after Tom's "discuss" verdict on the code todo \`${id}\`: the todo's plan`,
    `embeds a judgment call only Tom can make, so the next step is a live working`,
    `session instead of autonomous execution. Tom starts it from the repo root:`,
    ``,
    `    claude "Run the TTS session in ${agendaRel}"`,
    ``,
    ...(ruling.sentence ? [`Tom's sentence with the ruling: ${ruling.sentence}`, ``] : []),
    `## The todo entry (from ${TODOS_PATH})`,
    ``,
    "```yaml",
    found ? found.block : `# entry ${id} not found in ${TODOS_PATH} at apply time`,
    "```",
    ``,
    `## The brief`,
    ``,
    cached
      ? cached.text.trimEnd()
      : `(The worker's brief cache had no brief for this entry — the agenda above` +
        `\nis written from the todo entry alone.)`,
    ``,
  ].join("\n");

  fs.mkdirSync(path.join(repoDir, "dev/handoff"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, agendaRel), agenda);
  git(repoDir, "add", agendaRel);
  // A re-ruling can produce a byte-identical agenda; `git commit` then fails
  // with "nothing to commit", which would read as an environmental failure
  // and retry forever. An unchanged agenda is already-applied, not an error.
  if (git(repoDir, "status", "--porcelain").trim() === "") {
    return `session agenda already current (${agendaRel})`;
  }
  git(repoDir, "commit", "-m", `tts: session agenda for ${id}`);
  git(repoDir, "push", "origin", CMT_DEFAULT_BRANCH);
  const sha = git(repoDir, "rev-parse", "HEAD").trim();
  return `session agenda pushed — ${sha.slice(0, 12)} (${agendaRel})`;
}

// archive: close the todo by TEXT SURGERY on vqc/todos.yaml — move
// the entry block below the closed-todos banner, adding `closed:` +
// `resolution:`. The FULL body is kept (statement, cites, plan, …): the guard
// requires every entry's schema fields open or closed, and keeping the body
// also keeps the diff a pure move-plus-two-fields, easy to review.
function applyArchive(env, repoDir, ruling) {
  const id = ruling.externalId;
  const todosFile = path.join(repoDir, TODOS_PATH);
  const text = fs.readFileSync(todosFile, "utf8");

  const found = findEntryBlock(text, id);
  if (!found) return `ARCHIVE FAILED: entry ${id} not found in ${TODOS_PATH}`;
  if (/^ {2}closed:/m.test(found.block)) return `already closed — nothing to do`;
  if (!text.split("\n").some((l) => l.startsWith(CLOSED_BANNER_PREFIX))) {
    return `ARCHIVE FAILED: no closed-todos banner in ${TODOS_PATH}`;
  }

  // Build the archived block: `closed:` slots in right after `created:` (the
  // file's own convention), the resolution goes at the end as a `>-` block
  // scalar with the file's 2-space key / 4-space continuation indents.
  const cached = readBriefCache(id);
  const resolutionText = [
    `Archived by Tom's TTS ruling of ${todayISO()}.`,
    ruling.sentence ?? "",
    cached?.evidence ? `Evidence: ${cached.evidence}` : "",
  ]
    .filter((s) => s !== "")
    .join(" ");

  const blockLines = found.block.split("\n");
  const createdAt = blockLines.findIndex((l) => /^ {2}created:/.test(l));
  const closedLine = `  closed: ${todayISO()}`;
  if (createdAt !== -1) blockLines.splice(createdAt + 1, 0, closedLine);
  else blockLines.push(closedLine);
  blockLines.push(`  resolution: >-`);
  for (const line of wrapText(resolutionText, 96)) blockLines.push(`    ${line}`);

  // Remove the block from the live surface, re-append at file end (which is
  // below the banner by construction — closed history accumulates at the
  // bottom), one blank line before it, single trailing newline after.
  const lines = text.split("\n");
  const remaining = lines.slice(0, found.startLine).concat(lines.slice(found.endLine));
  while (remaining.length > 0 && remaining[remaining.length - 1].trim() === "") {
    remaining.pop();
  }
  fs.writeFileSync(todosFile, remaining.concat([""], blockLines).join("\n") + "\n");

  // Guard gate: the todos guard is the file's own definition of well-formed.
  // Red means our surgery (or the pre-existing file) is broken — never push
  // red; revert and surface the pytest tail to Tom in the UI.
  const guard = runTodosGuard(repoDir);
  if (!guard.ok) {
    git(repoDir, "checkout", "--", TODOS_PATH);
    return `GUARDS FAILED: ${guard.tail}`;
  }

  git(repoDir, "add", TODOS_PATH);
  git(repoDir, "commit", "-m", `todo(${id}): closed — archived by TTS ruling`);
  git(repoDir, "push", "origin", CMT_DEFAULT_BRANCH);
  const sha = git(repoDir, "rev-parse", "HEAD").trim();
  return `archived — ${sha.slice(0, 12)}`;
}

async function main() {
  if (!acquireLock(LOCK_DIR, LOCK_STALE_MS)) {
    console.log("[apply-rulings] another run holds the lock — exiting");
    return;
  }
  try {
    const env = loadEnv();
    const { pending } = await convexFetch(env, "/tts/rulings");
    if (!Array.isArray(pending) || pending.length === 0) return; // quiet when idle

    // Rulings we act on this run: CODE subjects only (life rows on the same
    // feed belong to prepare-life-todos.mjs), and not execute — execute is
    // the executor's, so it neither acts nor marks; it must STAY pending for
    // execute-plans.mjs.
    const actionable = pending.filter(
      (r) => r.subjectType === "code" && r.verdict !== "execute",
    );
    if (actionable.length === 0) return;

    // Refresh the cache clone once, only if some ruling needs the repo.
    const needsRepo = actionable.some(
      (r) => r.repo === CMT_REPO && (r.verdict === "discuss" || r.verdict === "archive"),
    );
    const repoDir = needsRepo ? cmtRepoDir(env) : null;

    let failures = 0;
    for (const ruling of actionable) {
      const label = `${ruling.repo}:${ruling.externalId} [${ruling.verdict}]`;
      // Snapshot HEAD so any half-done repo mutation can be rolled back —
      // commits happen only after guards pass, so a mid-handler crash leaves
      // at most working-tree changes plus possibly an unpushed commit.
      const startSha = repoDir ? git(repoDir, "rev-parse", "HEAD").trim() : null;
      try {
        let result;
        if (ruling.repo !== CMT_REPO) {
          // Only CMT is wired up today. Mark applied rather than leaving it
          // pending forever — Tom sees "unsupported repo" instead of silence.
          result = `unsupported repo: ${ruling.repo}`;
        } else if (ruling.verdict === "edit") {
          result = applyEdit(ruling);
        } else if (ruling.verdict === "discuss") {
          result = applyDiscuss(env, repoDir, ruling);
        } else if (ruling.verdict === "archive") {
          result = applyArchive(env, repoDir, ruling);
        } else {
          // A verdict this worker predates. Mark applied so the queue can't
          // clog; the text tells Tom to update the worker.
          result = `unsupported verdict: ${ruling.verdict}`;
        }
        await convexFetch(env, "/tts/ruling-applied", { id: ruling._id, result });
        console.log(`[apply-rulings] ${label}: ${result.split("\n")[0]}`);
      } catch (err) {
        // Environmental failure (push race, network, git). Roll the cache
        // back and LEAVE THE RULING PENDING — the next 10-minute tick
        // retries against a freshly reset clone.
        failures++;
        console.error(`[apply-rulings] ${label} FAILED (left pending): ${err.message}`);
        if (repoDir && startSha) {
          try {
            git(repoDir, "reset", "--hard", startSha);
            git(repoDir, "clean", "-fd");
          } catch (resetErr) {
            console.error(`[apply-rulings] cache rollback failed: ${resetErr.message}`);
          }
        }
      }
    }
    if (failures > 0) throw new Error(`${failures} ruling(s) failed (see lines above)`);
  } finally {
    releaseLock(LOCK_DIR);
  }
}

main().catch((err) => {
  console.error(`[apply-rulings] FAILED: ${err.message}`);
  process.exit(1);
});
