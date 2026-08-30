#!/usr/bin/env node
// tts-merge-pr — merge THIS session's pull request, if policy allows it.
//
// ────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE WIDENING TTS_MERGE_BASES.
//
// tom.quest has ONE Convex deployment and it is production. Vercel builds
// merged commits with `npx convex deploy --cmd 'pnpm build'`. So a merge to
// main is not "tidying the queue" — it is a schema-and-function deploy to the
// live backend, performed by an agent, at whatever hour it finished. The
// session posture (session.mjs, "Permission posture") names Tom's merge gate
// as one of the four things holding the whole design up.
//
// THIS TOOL IS THEREFORE OFF BY DEFAULT. It merges nothing until
// TTS_MERGE_BASES is set in /etc/tts/worker.env to a comma-separated list of
// base branches an agent may merge INTO. Recommended value is an integration
// branch and not main:
//
//   TTS_MERGE_BASES=overnight
//
// Listing `main` means unattended production deploys. That may be what Tom
// wants; it should not be what he gets by forgetting to think about it.
// ────────────────────────────────────────────────────────────────────────────
//
// What it checks, in order, refusing on the first failure:
//   1. cwd is a session workdir, on this session's own session/<id> branch,
//      in a repo on the clone allowlist                       (gh-lib)
//   2. a PR exists for that branch
//   3. its base is in TTS_MERGE_BASES
//   4. every CI check has finished and passed, and there was at least one
//   5. GitHub itself considers it mergeable (no conflicts, nothing blocking)
//
// Usage, from inside the session workdir:
//   tts-merge-pr [--method squash|merge|rebase] [--delete-branch]

import { pathToFileURL } from "node:url";

import {
  die,
  execFile,
  readToken,
  redact,
  resolveSessionRepo,
} from "./gh-lib.mjs";

const TOOL = "tts-merge-pr";
const GH_TIMEOUT_MS = 60_000;

/**
 * The base branches an agent may merge into. Unset or empty means "none",
 * which is the deliberate default — see the header. Exported for the test:
 * the parsing is the security boundary, so an empty string quietly reading as
 * "allow everything" is the failure that matters.
 */
export function allowedBases(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Is every CI check finished and green?
 *
 * `statusCheckRollup` is [] both when checks have not been created yet and
 * when the repo has none at all. Treating empty as "nothing failed, so go"
 * would merge a PR whose tests had not started — the exact race a nightly
 * agent hits, because it asks seconds after pushing. Empty is therefore a
 * refusal, not a pass.
 */
export function checksVerdict(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  if (checks.length === 0) {
    return { ok: false, why: "no CI checks reported yet — refusing to merge before they run" };
  }
  const unfinished = checks.filter(
    (c) => (c.status ?? "COMPLETED") !== "COMPLETED",
  );
  if (unfinished.length > 0) {
    return {
      ok: false,
      why: `${unfinished.length} check(s) still running: ${unfinished.map((c) => c.name ?? c.context).join(", ")}`,
    };
  }
  const failed = checks.filter((c) => {
    const r = String(c.conclusion ?? c.state ?? "").toUpperCase();
    return r !== "SUCCESS" && r !== "NEUTRAL" && r !== "SKIPPED";
  });
  if (failed.length > 0) {
    return {
      ok: false,
      why: `${failed.length} check(s) not green: ${failed.map((c) => `${c.name ?? c.context}=${c.conclusion ?? c.state}`).join(", ")}`,
    };
  }
  return { ok: true };
}

function parseArgs(argv) {
  const args = { method: "squash", deleteBranch: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--method") {
      args.method = argv[i + 1];
      i += 1;
      if (!["squash", "merge", "rebase"].includes(args.method)) {
        die(TOOL, `--method must be squash, merge or rebase`);
      }
    } else if (flag === "--delete-branch") args.deleteBranch = true;
    else die(TOOL, `unknown argument "${flag}"`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const bases = allowedBases(process.env.TTS_MERGE_BASES);
  if (bases.length === 0) {
    die(
      TOOL,
      "merging is disabled. No TTS_MERGE_BASES is set in /etc/tts/worker.env, so there is no base branch an agent may merge into. This is the default on purpose: merging to main deploys to production Convex. Open a pull request with tts-open-pr and leave it for Tom.",
    );
  }

  const { root, branch, slug } = await resolveSessionRepo(TOOL);
  const token = readToken(TOOL);
  const ghEnv = { ...process.env, GH_TOKEN: token };

  let pr;
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "pr", "view", branch,
        "--repo", slug,
        "--json", "number,baseRefName,state,mergeable,mergeStateStatus,statusCheckRollup",
      ],
      { env: ghEnv, maxBuffer: 8 * 1024 * 1024, timeout: GH_TIMEOUT_MS },
    );
    pr = JSON.parse(stdout);
  } catch (err) {
    die(
      TOOL,
      `no open pull request for ${branch}: ${redact(err?.stderr || err?.message, token)}`,
    );
  }

  if (pr.state !== "OPEN") die(TOOL, `pull request #${pr.number} is ${pr.state}`);

  if (!bases.includes(pr.baseRefName)) {
    die(
      TOOL,
      `refusing: #${pr.number} targets "${pr.baseRefName}", and TTS_MERGE_BASES allows only ${bases.join(", ")}`,
    );
  }

  const verdict = checksVerdict(pr.statusCheckRollup);
  if (!verdict.ok) die(TOOL, `refusing to merge #${pr.number}: ${verdict.why}`);

  // GitHub's own read: conflicts, required reviews, out-of-date branches.
  // CLEAN and UNSTABLE are the two that mean "the merge button works"; the
  // rest (BLOCKED, DIRTY, BEHIND, DRAFT) each have a reason a human should see.
  if (pr.mergeable === "CONFLICTING") {
    die(TOOL, `refusing: #${pr.number} has conflicts with ${pr.baseRefName}`);
  }
  if (!["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus)) {
    die(
      TOOL,
      `refusing: GitHub reports #${pr.number} as ${pr.mergeStateStatus}, not mergeable`,
    );
  }

  try {
    await execFile(
      "gh",
      [
        "pr", "merge", String(pr.number),
        "--repo", slug,
        `--${args.method}`,
        ...(args.deleteBranch ? ["--delete-branch"] : []),
      ],
      { env: ghEnv, maxBuffer: 8 * 1024 * 1024, timeout: GH_TIMEOUT_MS },
    );
  } catch (err) {
    die(TOOL, `merge failed: ${redact(err?.stderr || err?.message, token)}`);
  }

  process.stdout.write(
    `merged #${pr.number} (${branch} → ${pr.baseRefName}, ${args.method})\n`,
  );
  void root;
}

// Only when run as a command — the test imports the pure helpers from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) =>
    die(TOOL, redact(err?.message ?? String(err), process.env.GH_TOKEN)),
  );
}
