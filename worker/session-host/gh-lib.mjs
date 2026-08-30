// Shared plumbing for the session-facing GitHub tools (open-pr.mjs,
// merge-pr.mjs).
//
// THE INVARIANT ALL OF THIS SERVES: a session's model never holds the GitHub
// credential. These tools run as their own processes, read the token
// themselves, and derive WHAT they act on from the working directory rather
// than from arguments — so the capability handed to a session is "act on my
// own branch" rather than "here is a token".

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

import { REPO_GITHUB, SESSIONS_ROOT } from "./repos.mjs";

export const execFile = promisify(execFileCb);

const WORKER_ENV = "/etc/tts/worker.env";

/** Fail with one line on stderr. Never prints anything token-shaped. */
export function die(tool, message) {
  process.stderr.write(`${tool}: ${message}\n`);
  process.exit(1);
}

/**
 * Scrub anything token-shaped out of text bound for a log or the session's
 * transcript. git and gh both echo remote URLs in their errors, and these
 * tools exist precisely so the session never sees the credential — an error
 * path that leaked it would defeat their only real job.
 */
export function redact(text, token) {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("«redacted»");
  return out.replace(/x-access-token:[^@\s]+@/g, "x-access-token:«redacted»@");
}

/**
 * The token: the daemon's env when the daemon runs this, else the root-only
 * worker.env. Reading that file is why these are separate processes — a
 * session's own shell is denied /etc/ by the classifier.
 */
export function readToken(tool) {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  let raw;
  try {
    raw = fs.readFileSync(WORKER_ENV, "utf8");
  } catch {
    die(tool, `cannot read ${WORKER_ENV} — run this on the session-host box`);
  }
  const line = raw.split("\n").find((l) => /^\s*GH_TOKEN\s*=/.test(l));
  if (!line) die(tool, `GH_TOKEN is not set in ${WORKER_ENV}`);
  return line
    .replace(/^\s*GH_TOKEN\s*=\s*/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
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

export async function git(cwd, ...args) {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Where am I, what branch am I on, and which repo is that — each checked
 * against what the daemon is allowed to have created. This is the whole
 * containment story for both tools, so all three checks are hard failures:
 * a session may act only inside SESSIONS_ROOT, only on its own session/<id>
 * branch, and only in a repo on the clone allowlist.
 */
export async function resolveSessionRepo(tool) {
  const root = await git(process.cwd(), "rev-parse", "--show-toplevel").catch(
    () => die(tool, "not inside a git repository"),
  );
  if (!path.resolve(root).startsWith(SESSIONS_ROOT + path.sep)) {
    die(tool, `refusing to act outside ${SESSIONS_ROOT} (this is ${root})`);
  }

  const branch = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (!/^session\/[A-Za-z0-9_-]+$/.test(branch)) {
    die(
      tool,
      `refusing to act on "${branch}" — a session may only act on its own session/<id> branch`,
    );
  }

  const slug = parseSlug(await git(root, "remote", "get-url", "origin"));
  if (!slug) die(tool, "origin does not look like a GitHub remote");
  const allowed = Object.values(REPO_GITHUB);
  if (!allowed.includes(slug)) {
    die(tool, `refusing: ${slug} is not one of ${allowed.join(", ")}`);
  }

  return { root, branch, slug };
}
