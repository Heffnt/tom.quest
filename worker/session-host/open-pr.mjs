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
//   tts-open-pr --title "..." [--body "..." | --body-file PATH] [--base main]
//
// Exit 0 prints the PR url on stdout and nothing else. Re-running when a PR
// already exists is not an error: it prints the existing url.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_GITHUB, SESSIONS_ROOT } from "./repos.mjs";

const execFile = promisify(execFileCb);

const WORKER_ENV = "/etc/tts/worker.env";
const PUSH_TIMEOUT_MS = 60_000;
const PR_TIMEOUT_MS = 60_000;

/** Every failure path lands here, so no branch can accidentally print a token. */
function die(message) {
  process.stderr.write(`tts-open-pr: ${message}\n`);
  process.exit(1);
}

/**
 * Scrub anything token-shaped out of text bound for a log or the session's
 * transcript. git and gh both echo the remote URL in their errors, and the
 * whole point of this script is that the session never sees the credential —
 * an error path that leaks it would defeat the script's only real job.
 */
function redact(text, token) {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("«redacted»");
  return out.replace(/x-access-token:[^@\s]+@/g, "x-access-token:«redacted»@");
}

function parseArgs(argv) {
  const args = { base: "main" };
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

/**
 * The token, from the daemon's env when the daemon runs this, else from the
 * root-only worker.env. Reading worker.env is why this script exists as its
 * own process: a session's shell is denied /etc/ by the classifier.
 */
function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  let raw;
  try {
    raw = fs.readFileSync(WORKER_ENV, "utf8");
  } catch {
    die(`cannot read ${WORKER_ENV} — run this on the session-host box`);
  }
  const line = raw.split("\n").find((l) => /^\s*GH_TOKEN\s*=/.test(l));
  if (!line) die(`GH_TOKEN is not set in ${WORKER_ENV}`);
  return line.replace(/^\s*GH_TOKEN\s*=\s*/, "").replace(/^["']|["']$/g, "").trim();
}

/**
 * owner/repo out of a git remote URL, or null if it is not GitHub.
 *
 * Exported for the test because the obvious version of this regex is wrong in
 * this repo specifically: it excluded "." from the repo name, which reads
 * every other repo correctly and then fails on tom.quest. Handles the https,
 * ssh and credential-bearing forms, since the daemon clones with the last one.
 */
export function parseSlug(originUrl) {
  const m = String(originUrl)
    .trim()
    .replace(/\/+$/, "")
    .match(/github\.com[/:]([^/]+\/.+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
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

  // ── the workdir must be a session workdir ────────────────────────────────
  // Not decoration: it is what stops this from being a general-purpose
  // "open a PR anywhere" tool that happens to hold a token.
  const cwd = process.cwd();
  const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() =>
    die("not inside a git repository"),
  );
  if (!path.resolve(root).startsWith(SESSIONS_ROOT + path.sep)) {
    die(`refusing to act outside ${SESSIONS_ROOT} (this is ${root})`);
  }

  // ── the branch must be this session's own ────────────────────────────────
  const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (!/^session\/[A-Za-z0-9_-]+$/.test(branch)) {
    die(
      `refusing to open a PR from "${branch}" — a session may only PR its own session/<id> branch`,
    );
  }

  // ── the repo must be one the daemon is allowed to clone ──────────────────
  const originUrl = await git(root, "remote", "get-url", "origin");
  const slug = parseSlug(originUrl);
  if (!slug) die("origin does not look like a GitHub remote");
  const allowed = Object.values(REPO_GITHUB);
  if (!allowed.includes(slug)) {
    die(`refusing: ${slug} is not one of ${allowed.join(", ")}`);
  }

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
