// tts-code-lib.mjs — shared helpers for the box jobs that read a repository
// at the head of one branch: the cache clones (cacheRepoDir), one git
// command (git), and YAML parsed through python3 (yamlToJson). Plain Node
// ESM, ZERO npm dependencies — same rules as tts-lib.mjs.
//
// It used to carry the planner's brief pass's half too: the ComplexMultiTrigger
// cache clone, the per-entry source hash, the brief cursor file
// /var/lib/tts/brief-hashes.json and the todos.yaml entry lookup. That pass
// read CMT's vqc/todos.yaml and nothing else, and Tom's ruling of 2026-09-22
// (CMT adoption ruling 70, 2026-09-24) moved CMT's todos into TTS, so the pass
// and its half here are gone (plan-graphs.mjs says where its prompt went).
//
// STATE ON THE JARVIS BOX (all harmless to lose, per the no-state rule):
//   /var/cache/tts/<repo> — shallow cache clones; rebuilt from origin on
//       every use, so deleting one costs one clone.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

// Run one git command in `dir` and return stdout. stdin is closed (git must
// never prompt — a cron job has no terminal), stderr passes through to the
// cron log so failures are diagnosable.
export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}


// Clone-or-refresh the cache clone of any repo the box reads at HEAD of one
// branch, and return its path. ALWAYS ends with the working tree exactly at
// origin/<branch>, clean, no untracked leftovers — callers may assume the
// cache is never stale and never dirty. Shallow (--depth 1) on purpose: the
// cache exists to read files. Its callers are evals.mjs (the tom.quest cache
// clone it takes worktrees from), nightly.mjs and simplify.mjs. ONE body: a
// second copy of this would drift the way the two planners' clip() rules did.
//
// The token rides in the URL (the x-access-token convention GitHub documents
// for token auth over HTTPS) — acceptable here because the URL never leaves
// the root-only Jarvis Box and every use re-sets it, so a rotated token in
// worker.env takes effect on the next cron tick.
export function cacheRepoDir(env, { name, owner, branch, dir = `/var/cache/tts/${name}` }) {
  if (!env.GH_TOKEN) {
    throw new Error("missing GH_TOKEN in /etc/tts/worker.env — the cache clones need it");
  }
  const url = `https://x-access-token:${env.GH_TOKEN}@github.com/${owner}/${name}.git`;
  if (!fs.existsSync(path.join(dir, ".git"))) {
    // Missing or half-created (an interrupted clone leaves a dir with no
    // .git) — start over. rm -rf of a cache is free by definition.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", branch, url, dir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    return dir;
  }
  // Re-set the remote URL every time so a rotated GH_TOKEN takes effect.
  git(dir, "remote", "set-url", "origin", url);
  // --depth 1 on the fetch keeps the cache shallow forever (a plain fetch in
  // a shallow repo would slowly deepen it). FETCH_HEAD is the just-fetched
  // tip of the branch; reset --hard + clean -fd makes stale-or-dirty
  // impossible by construction.
  git(dir, "fetch", "--depth", "1", "origin", branch);
  git(dir, "reset", "--hard", "FETCH_HEAD");
  git(dir, "clean", "-fd");
  return dir;
}

// ---------------------------------------------------------------------------
// YAML via python3 (the sanctioned parser)
// ---------------------------------------------------------------------------

// Parse a YAML file to a JS value. WHY python: the no-npm-deps rule leaves
// Node without a YAML parser, and the Jarvis Box already carries python3-yaml for
// CMT's own guard tests — one parser, one truth. The file goes over STDIN
// (not argv) so paths with odd characters and future big files both work.
export function yamlToJson(file) {
  const stdout = execFileSync(
    "python3",
    ["-c", "import yaml,json,sys; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))"],
    // default=str: YAML date scalars (created:/closed:) parse to Python
    // datetime.date, which json.dumps cannot serialize natively — stringify
    // them back to "YYYY-MM-DD" instead of crashing.
    { input: fs.readFileSync(file, "utf8"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
