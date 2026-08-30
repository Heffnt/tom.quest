#!/usr/bin/env node
// tts-sync-base — bring this session's branch up to date with its base.
//
// WHY THIS IS NOT OPTIONAL FOR THE INTEGRATION-BRANCH FLOW. With
// TTS_SESSION_BASE set, agents merge into a branch that moves all night. A
// session that started an hour ago is behind by however much landed since, and
// a behind branch does not merely produce a stale PR:
//
//   a CONFLICTING pull request stops GitHub creating refs/pull/N/merge, and
//   without that ref `pull_request` workflows NEVER RUN — no failure, no
//   skipped run, no check suite at all.
//
// So a conflict silently costs the PR its CI, and tts-merge-pr then refuses it
// for having no green checks. The agent sees "no CI checks reported yet" and
// has no way to discover that the real cause is a conflict three steps back.
// (Diagnosed exactly that way on PR #25, 2026-08-30.)
//
// The base is fetched with the daemon's credential, like every other tool
// here, so the session never handles one.
//
// Usage, from inside the session workdir:
//   tts-sync-base [--base BRANCH] [--rebase]
//
// Default is a merge, not a rebase: a merge keeps already-pushed commits
// intact, and a session whose branch was rebased has to force-push, which is
// exactly the operation the posture does not want to normalise.

import { pathToFileURL } from "node:url";

import {
  die as bareDie,
  execFile,
  git,
  readToken as bareReadToken,
  redact,
  resolveSessionRepo,
} from "./gh-lib.mjs";

const TOOL = "tts-sync-base";
const die = (m) => bareDie(TOOL, m);
const FETCH_TIMEOUT_MS = 120_000;

/** The base to sync from: explicit flag, else the branch the session was based on. */
export function syncBase(argv, env = process.env) {
  const i = argv.indexOf("--base");
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const b = String(env.TTS_SESSION_BASE ?? "").trim();
  return b === "" ? "main" : b;
}

async function main() {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (!["--base", "--rebase"].includes(a) && a.startsWith("--")) {
      die(`unknown argument "${a}"`);
    }
  }
  const rebase = argv.includes("--rebase");
  const base = syncBase(argv);

  const { root, branch, slug } = await resolveSessionRepo(TOOL);
  const token = bareReadToken(TOOL);
  const authedUrl = `https://x-access-token:${token}@github.com/${slug}.git`;

  // A dirty tree turns a merge conflict into an unrecoverable mess, and the
  // session is mid-edit far more often than not. Refuse early and plainly.
  const dirty = await git(root, "status", "--porcelain");
  if (dirty.trim() !== "") {
    die(
      `working tree has uncommitted changes — commit or stash them first:\n${dirty.split("\n").slice(0, 10).join("\n")}`,
    );
  }

  // --unshallow: the daemon clones --depth 1, so there is no common ancestor
  // to merge against until the history is filled in. Without it the merge
  // fails with "refusing to merge unrelated histories". Harmless (and cheap)
  // to repeat once the repo is already complete.
  try {
    await execFile(
      "git",
      ["-C", root, "fetch", "--unshallow", authedUrl, `${base}:refs/tts/base`],
      { maxBuffer: 64 * 1024 * 1024, timeout: FETCH_TIMEOUT_MS },
    );
  } catch {
    try {
      await execFile(
        "git",
        ["-C", root, "fetch", authedUrl, `${base}:refs/tts/base`],
        { maxBuffer: 64 * 1024 * 1024, timeout: FETCH_TIMEOUT_MS },
      );
    } catch (err) {
      die(
        `could not fetch "${base}": ${redact(err?.stderr || err?.message, token)}`,
      );
    }
  }

  const behind = await git(root, "log", "HEAD..refs/tts/base", "--oneline");
  if (behind.trim() === "") {
    process.stdout.write(`${branch} is already up to date with ${base}\n`);
    return;
  }
  const count = behind.split("\n").length;

  try {
    if (rebase) await git(root, "rebase", "refs/tts/base");
    else
      await git(
        root,
        "merge",
        "--no-edit",
        "-m",
        `Merge ${base} into ${branch}`,
        "refs/tts/base",
      );
  } catch (err) {
    // Leave the conflicted state in place: resolving it is the agent's job and
    // it needs the markers. Just name the files, because `git merge`'s own
    // output buries them.
    const conflicted = await git(root, "diff", "--name-only", "--diff-filter=U").catch(
      () => "",
    );
    die(
      `${rebase ? "rebase" : "merge"} of ${base} hit conflicts in:\n${conflicted || redact(err?.stderr || err?.message, token)}\n\nResolve them, commit, then run tts-open-pr again.`,
    );
  }

  process.stdout.write(
    `${branch} now includes ${count} commit(s) from ${base}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) =>
    die(redact(err?.message ?? String(err), process.env.GH_TOKEN)),
  );
}
