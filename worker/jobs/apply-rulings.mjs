#!/usr/bin/env node
// apply-rulings.mjs — carry out Tom's NON-EXECUTION rulings on code todos.
//
// Run by cron every 10 minutes (see /etc/cron.d/tts). Manual run:
//   node /opt/tts/apply-rulings.mjs
//
// THE RULING LOOP: brief-code-todos.mjs posts a brief + recommendation per
// open todo in every GOVERNED REPO (see CODE_REPOS in tts-code-lib.mjs); Tom
// rules in the tom.quest UI; Convex queues the ruling; this job GETs
// /tts/rulings — a UNIFIED feed whose rows carry subjectType "life"|"code"
// and verdict "approve"|"revise"|"session"|"archive" — takes only the CODE
// rows (life rows belong to prepare-life-todos.mjs), applies each pending one,
// then POSTs /tts/ruling-applied so the UI shows the outcome. The verdicts:
//   revise   -> Tom's sentence redirects the plan: force a re-brief that
//               proposes a fresh one
//   session  -> deliver a session-agenda file to the repo for Tom to open a
//               live Claude session from
//   archive  -> close the todo in the repo's registry (guard-checked, never
//               delivered red)
//   approve  -> NOT ours. execute-approved.mjs owns approvals; we skip them
//               entirely (not even mark-applied).
// There is NO "defer" verdict — not ruling IS deferring.
//
// DELIVERY IS PER-REPO. A repo's `pushMode` decides whether a session agenda
// or an archive lands as a commit straight on its default branch ("direct",
// CMT) or as a branch plus a pull request ("pull-request", tom.quest — whose
// default branch is the production deploy branch and whose own todos guard
// runs only in CI). Same surgery, different last step.
//
// SERIALIZATION: a 10-minute cron plus pushes that can take minutes means
// runs can overlap; the mkdir lock /var/lib/tts/apply.lock ensures only one
// applier mutates the cache clones / pushes at a time. Stale locks (a crashed
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
  REPLAN_SENTINEL,
  repoConfig,
  repoCacheDir,
  closeEntryText,
  verifyTodosFile,
  runRepoGuard,
  yamlToJson,
  git,
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

// The brief cache file's content, or null when it was never written / was
// lost (the cache is rebuildable, so absence is a degraded path, not an
// error). Also extracts the "Evidence:" header line the briefing job wrote.
function readBriefCache(repo, externalId) {
  try {
    const text = fs.readFileSync(briefCachePath(repo, externalId), "utf8");
    const evidence = text.match(/^Evidence: (.*)$/m)?.[1] ?? null;
    return { text, evidence };
  } catch {
    return null;
  }
}

// The ids currently in a repo's registry — the "before" snapshot every piece
// of text surgery is verified against (verifyTodosFile).
function registryIds(cfg, repoDir) {
  const parsed = yamlToJson(path.join(repoDir, cfg.todosPath));
  return Array.isArray(parsed)
    ? parsed.filter((e) => e && typeof e === "object").map((e) => e.id)
    : [];
}

// ---------------------------------------------------------------------------
// Delivery: the last step that turns staged changes into something Tom sees
// ---------------------------------------------------------------------------

// Create the PR for an already-pushed branch, or return the URL of the one
// that already exists (a re-ruling reuses the branch namespace, and `gh pr
// create` refuses when a PR is already open for that head).
function prUrlFor(env, cfg, repoDir, branch, title, body) {
  const ghEnv = { ...process.env, GH_TOKEN: env.GH_TOKEN };
  try {
    const out = execFileSync(
      "gh",
      ["pr", "create", "--title", title, "--base", cfg.defaultBranch, "--head", branch, "--body", body],
      { cwd: repoDir, encoding: "utf8", env: ghEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    // gh prints the PR URL as the last non-empty stdout line.
    return out.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop() ?? "(no URL in gh output)";
  } catch {
    const out = execFileSync("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], {
      cwd: repoDir,
      encoding: "utf8",
      env: ghEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim();
  }
}

// Commit the already-staged working-tree changes and deliver them the way the
// repo's pushMode says. Returns { unchanged: true } when there was nothing to
// commit, else { unchanged: false, ref } where ref is the commit sha (direct)
// or the pull-request URL. `baseSha` is where the cache clone sat before this
// ruling touched it — the pull-request path returns the clone to it so the
// next ruling in the same run starts from the default branch again.
function deliver(env, cfg, repoDir, { baseSha, branch, commitMessage, prTitle, prBody }) {
  // A re-ruling can produce byte-identical content; `git commit` then fails
  // with "nothing to commit", which would read as an environmental failure
  // and retry forever. Unchanged content is already-applied, not an error.
  if (git(repoDir, "status", "--porcelain").trim() === "") return { unchanged: true };

  if (cfg.pushMode === "direct") {
    git(repoDir, "commit", "-m", commitMessage);
    git(repoDir, "push", "origin", cfg.defaultBranch);
    return { unchanged: false, ref: git(repoDir, "rev-parse", "HEAD").trim().slice(0, 12) };
  }

  // pull-request: the branch namespace tts/* is owned by this job, so a retry
  // overwrites its own failed attempt's leftover branch rather than rejecting.
  git(repoDir, "checkout", "-B", branch);
  git(repoDir, "commit", "-m", commitMessage);
  git(repoDir, "push", "--force", "origin", branch);
  const url = prUrlFor(env, cfg, repoDir, branch, prTitle, prBody);
  git(repoDir, "checkout", "-B", cfg.defaultBranch, baseSha);
  return { unchanged: false, ref: url };
}

// --- the per-verdict handlers (each returns the applied-result string) -----

// revise: poke the briefing cursor. Setting the cursor value to the replan
// sentinel (instead of deleting the key) both forces a re-brief (a sentinel
// never equals a recomputed hash) and carries Tom's sentence into the
// re-brief prompt — a bare deletion would be indistinguishable from "never
// briefed" and the redirect would be lost.
function applyRevise(ruling) {
  const hashes = readBriefHashes();
  hashes[`${ruling.repo}:${ruling.externalId}`] =
    REPLAN_SENTINEL + (ruling.sentence ? `: ${ruling.sentence}` : "");
  writeBriefHashes(hashes);
  return "replan queued";
}

// session: write a self-contained session agenda into the repo itself
// and deliver it. WHY in the repo: Tom starts the session with
//   claude "Run the TTS session in <handoffDir>/tts-session-<id>.md"
// from any checkout — the agenda travels with the code it is about, needs no
// tom.quest access, and its git history records what Tom was asked.
function applySession(env, cfg, repoDir, baseSha, ruling) {
  const id = ruling.externalId;
  const todosText = fs.readFileSync(path.join(repoDir, cfg.todosPath), "utf8");
  const found = findEntryBlock(todosText, id);
  const cached = readBriefCache(cfg.repo, id);

  const agendaRel = `${cfg.handoffDir}/tts-session-${id}.md`;
  const agenda = [
    `# TTS session agenda — ${id}`,
    ``,
    `This file is a session agenda written by TTS (Tom's delegated todo system)`,
    `after Tom's "session" verdict on the code todo \`${id}\`: the todo's plan`,
    `embeds a judgment call only Tom can make, so the next step is a live working`,
    `session instead of autonomous execution. Tom starts it from the repo root:`,
    ``,
    `    claude "Run the TTS session in ${agendaRel}"`,
    ``,
    ...(ruling.sentence ? [`Tom's sentence with the ruling: ${ruling.sentence}`, ``] : []),
    `## The todo entry (from ${cfg.todosPath})`,
    ``,
    "```yaml",
    found ? found.block : `# entry ${id} not found in ${cfg.todosPath} at apply time`,
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

  fs.mkdirSync(path.join(repoDir, cfg.handoffDir), { recursive: true });
  fs.writeFileSync(path.join(repoDir, agendaRel), agenda);
  git(repoDir, "add", agendaRel);

  const delivered = deliver(env, cfg, repoDir, {
    baseSha,
    branch: `tts/session-${id}`,
    commitMessage: `tts: session agenda for ${id}`,
    prTitle: `tts: session agenda for ${id}`,
    prBody:
      `Tom ruled "session" on the code todo \`${id}\`: its plan embeds a judgment` +
      ` call only he can make. This adds the session agenda he opens the working` +
      ` session from.\n\nMerging this PR delivers the agenda to ${cfg.defaultBranch}.`,
  });
  return delivered.unchanged
    ? `session agenda already current (${agendaRel})`
    : `session agenda delivered — ${delivered.ref} (${agendaRel})`;
}

// archive: close the todo by TEXT SURGERY on the repo's registry, in that
// repo's own closure convention (see closeEntryText / CODE_REPOS.closureStyle).
function applyArchive(env, cfg, repoDir, baseSha, ruling) {
  const id = ruling.externalId;
  const todosFile = path.join(repoDir, cfg.todosPath);
  const text = fs.readFileSync(todosFile, "utf8");
  const idsBefore = registryIds(cfg, repoDir);

  const cached = readBriefCache(cfg.repo, id);
  const resolutionText = [
    `Archived by Tom's TTS ruling of ${todayISO()}.`,
    ruling.sentence ?? "",
    cached?.evidence ? `Evidence: ${cached.evidence}` : "",
  ]
    .filter((s) => s !== "")
    .join(" ");

  const closed = closeEntryText(text, cfg, {
    id,
    resolution: resolutionText,
    today: todayISO(),
  });
  if (!closed.ok) {
    return closed.already ? closed.reason : `ARCHIVE FAILED: ${closed.reason}`;
  }
  fs.writeFileSync(todosFile, closed.text);

  // Guard gate, in two layers. verifyTodosFile is the box's own floor and runs
  // for every repo: still a list, no id lost or gained, the target entry now
  // reads closed with a resolution. runRepoGuard additionally runs the repo's
  // OWN todos test when the box can (CMT's pytest module; tom.quest's vitest
  // guard needs node_modules the shallow clone has none of, so its real guard
  // runs in CI on the pull request instead — which is why tom.quest is
  // pushMode "pull-request"). Red means our surgery (or the pre-existing file)
  // is broken — never deliver red; revert and surface the output to Tom.
  for (const check of [
    verifyTodosFile(cfg, repoDir, { idsBefore, closedId: id }),
    runRepoGuard(cfg, repoDir),
  ]) {
    if (!check.ok) {
      git(repoDir, "checkout", "--", cfg.todosPath);
      return `GUARDS FAILED: ${check.tail}`;
    }
  }

  git(repoDir, "add", cfg.todosPath);
  const delivered = deliver(env, cfg, repoDir, {
    baseSha,
    branch: `tts/archive-${id}`,
    commitMessage: `todo(${id}): closed — archived by TTS ruling`,
    prTitle: `todo(${id}): closed — archived by TTS ruling`,
    prBody:
      `Tom ruled "archive" on the code todo \`${id}\`. This closes the entry in` +
      ` \`${cfg.todosPath}\` in this repo's own convention.\n\n${resolutionText}`,
  });
  return delivered.unchanged ? `already closed — nothing to do` : `archived — ${delivered.ref}`;
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
    // feed belong to prepare-life-todos.mjs), and not approve — approve is
    // the executor's, so it neither acts nor marks; it must STAY pending for
    // execute-approved.mjs.
    const actionable = pending.filter(
      (r) => r.subjectType === "code" && r.verdict !== "approve",
    );
    if (actionable.length === 0) return;

    // Refresh each repo's cache clone at most once per run, and only when some
    // ruling actually needs that repo's tree. `baseSha` is the clone's tip
    // right after the refresh — every rollback and every pull-request return
    // trip targets it.
    const clones = new Map(); // repo -> { repoDir, baseSha }
    const cloneFor = (cfg) => {
      if (!clones.has(cfg.repo)) {
        const repoDir = repoCacheDir(env, cfg);
        clones.set(cfg.repo, { repoDir, baseSha: git(repoDir, "rev-parse", "HEAD").trim() });
      }
      return clones.get(cfg.repo);
    };

    let failures = 0;
    for (const ruling of actionable) {
      const label = `${ruling.repo}:${ruling.externalId} [${ruling.verdict}]`;
      const cfg = repoConfig(ruling.repo);
      // Snapshot HEAD so any half-done repo mutation can be rolled back —
      // commits happen only after guards pass, so a mid-handler crash leaves
      // at most working-tree changes plus possibly an unpushed commit.
      let clone = null;
      try {
        let result;
        if (cfg === null) {
          // Not a governed repo. Mark applied rather than leaving it pending
          // forever — Tom sees "unsupported repo" instead of silence.
          result = `unsupported repo: ${ruling.repo}`;
        } else if (ruling.verdict === "revise") {
          result = applyRevise(ruling);
        } else if (ruling.verdict === "session") {
          clone = cloneFor(cfg);
          result = applySession(env, cfg, clone.repoDir, clone.baseSha, ruling);
        } else if (ruling.verdict === "archive") {
          clone = cloneFor(cfg);
          result = applyArchive(env, cfg, clone.repoDir, clone.baseSha, ruling);
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
        if (clone) {
          try {
            git(clone.repoDir, "checkout", "-B", cfg.defaultBranch, clone.baseSha);
            git(clone.repoDir, "reset", "--hard", clone.baseSha);
            git(clone.repoDir, "clean", "-fd");
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
