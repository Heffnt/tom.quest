#!/usr/bin/env node
// tts-open-pr — the ONE way a TTS session opens a pull request.
//
// WHY THIS EXISTS. Autonomous mission prompts tell a session to open a PR when
// its work is merge-ready (convex/claudeSessions.ts buildWorkerPrompt /
// buildAutoMissionPrompt). That instruction could never be obeyed: `gh` is
// installed by setup.sh but never `gh auth login`-ed, and GH_TOKEN is
// deliberately scrubbed from a session's shell (session.mjs startQuery). So
// every session that finished mergeable work failed at the last step.
//
// THE SHAPE. This is a separate process, not something the session's model can
// influence beyond two strings. It reads the token itself and never prints it,
// so the scrub stays intact — the same trick #preserveWork already uses when
// it pushes session/<id> with the daemon's own credential.
//
// IT TAKES NO REPO AND NO BRANCH. Both are derived from the working directory,
// and both are checked against the same allowlists the daemon clones from. The
// capability handed to a session is therefore exactly "open a PR from my own
// branch, in the repo I was checked out of" — not "use a GitHub token".
//
// Usage (from inside the session workdir):
//   tts-open-pr --title "..." [--body "..." | --body-file PATH] [--base BRANCH]
// --base defaults to TTS_SESSION_BASE (what the session was branched from),
// else main.
//
// Exit 0 prints the PR url on stdout and nothing else. Re-running when a PR
// already exists is not an error: it prints the existing url.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  die as bareDie,
  execFile,
  git,
  parseSlug,
  readToken as bareReadToken,
  redact,
  resolveSessionRepo,
} from "./gh-lib.mjs";

const TOOL = "tts-open-pr";
const die = (message) => bareDie(TOOL, message);
const readToken = () => bareReadToken(TOOL);

// Re-exported so open-pr.test.mjs keeps testing the parser through the tool
// that depends on it, not just through the library.
export { parseSlug };

const PUSH_TIMEOUT_MS = 60_000;
const PR_TIMEOUT_MS = 60_000;

/**
 * The default PR base: whatever the session was branched from. Aiming at main
 * while based on an integration branch would put every commit already merged
 * to that branch into this session's diff.
 */
export function defaultBase(env = process.env) {
  const b = String(env.TTS_SESSION_BASE ?? "").trim();
  return b === "" ? "main" : b;
}

function parseArgs(argv) {
  const args = { base: defaultBase() };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--title") { args.title = value; i += 1; }
    else if (flag === "--body") { args.body = value; i += 1; }
    else if (flag === "--body-file") { args.bodyFile = value; i += 1; }
    else if (flag === "--base") { args.base = value; i += 1; }
    else if (flag === "--draft") { args.draft = true; }
    else die(`unknown argument "${flag}"`);
  }
  return args;
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title) die("--title is required");

  let body = args.body ?? "";
  if (args.bodyFile) {
    try {
      body = fs.readFileSync(args.bodyFile, "utf8");
    } catch {
      die(`cannot read --body-file ${args.bodyFile}`);
    }
  }

  const { root, branch, slug } = await resolveSessionRepo(TOOL);

  // NOTE: there is deliberately no local "are there commits?" check. The
  // daemon clones --depth 1, so the base branch's history is not present and
  // any local ahead/behind arithmetic is guesswork — and a session that
  // pushed, iterated, and asked again would be told it had nothing, which is
  // exactly the useful case. GitHub knows the answer; its "No commits between"
  // error is mapped to a plain sentence below.

  const token = readToken();
  const authedUrl = `https://x-access-token:${token}@github.com/${slug}.git`;

  // Push by explicit URL rather than by remote name, so this works whether or
  // not the clone's origin carries a credential — and so it keeps working
  // after the credential is removed from .git/config (see the todo about the
  // token being readable there).
  try {
    await execFile("git", ["-C", root, "push", authedUrl, `${branch}:${branch}`], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: PUSH_TIMEOUT_MS,
    });
  } catch (err) {
    die(`push failed: ${redact(err?.stderr || err?.message, token)}`);
  }

  // Pushing by URL does not move refs/remotes/origin/<branch>, so without this
  // the branch still looks unpushed locally. #preserveWork computes what it
  // can save with `log <branch> --not --remotes`, so at teardown it would
  // re-push these commits and tell the transcript it rescued work that was
  // already on the remote. Cheap to keep honest.
  try {
    await git(root, "update-ref", `refs/remotes/origin/${branch}`, branch);
  } catch {
    // Bookkeeping only — the push is what mattered and it already succeeded.
  }

  const ghEnv = { ...process.env, GH_TOKEN: token, GH_REPO: slug };
  const prArgs = [
    "pr", "create",
    "--repo", slug,
    "--head", branch,
    "--base", args.base,
    "--title", args.title,
    "--body", body,
    ...(args.draft ? ["--draft"] : []),
  ];
  try {
    const { stdout } = await execFile("gh", prArgs, {
      env: ghEnv,
      maxBuffer: 8 * 1024 * 1024,
      timeout: PR_TIMEOUT_MS,
    });
    process.stdout.write(`${stdout.trim()}\n`);
  } catch (err) {
    // Re-running after a PR exists is the common case (a session iterates,
    // pushes again, and asks again). Report the existing PR instead of an
    // error the model will try to "fix".
    const text = redact(err?.stderr || err?.message, token);
    if (/No commits between/i.test(text)) {
      die(`nothing to review: ${branch} has no commits that ${args.base} does not already have`);
    }
    if (/already exists/i.test(text)) {
      try {
        const { stdout } = await execFile(
          "gh",
          ["pr", "view", branch, "--repo", slug, "--json", "url", "-q", ".url"],
          { env: ghEnv, maxBuffer: 1024 * 1024, timeout: PR_TIMEOUT_MS },
        );
        process.stdout.write(`${stdout.trim()}\n`);
        return;
      } catch {
        die(`a pull request already exists for ${branch}, and reading its url failed`);
      }
    }
    die(`gh pr create failed: ${text}`);
  }
}

// Only when run as a command — the test imports parseSlug from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) =>
    die(redact(err?.message ?? String(err), process.env.GH_TOKEN)),
  );
}
