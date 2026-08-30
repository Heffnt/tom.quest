// tts-code-lib.mjs — shared helpers for the TTS CODE-TODO jobs
// (brief-code-todos.mjs, apply-rulings.mjs, execute-plans.mjs). Plain Node
// ESM, ZERO npm dependencies — same rules as tts-lib.mjs.
//
// The code-todo loop in one breath: CMT (github.com/Heffnt/ComplexMultiTrigger)
// keeps its standing intent in vqc/todos.yaml; the briefing job explains each
// open entry to Tom and recommends a ruling; Tom rules in the tom.quest UI
// (stored in Convex); the apply job carries out non-execution rulings; the
// executor implements ONE approved plan per hour on a branch and opens a PR —
// merging that PR is the human gate.
//
// STATE ON THE JARVIS BOX (all harmless to lose, per the no-state rule):
//   /var/cache/tts/ComplexMultiTrigger — shallow cache clone; rebuilt from
//       origin on every use, so deleting it costs one clone.
//   /var/cache/tts/briefs/<repo>/<id>.md — local copy of each posted brief so
//       the apply job can embed it in session agendas without a Convex read
//       endpoint; rebuildable by re-briefing (--force).
//   /var/lib/tts/brief-hashes.json — cursor: the source hash each entry was
//       last briefed at. Losing it just re-briefs everything once (the Convex
//       POST upserts, so duplicates cost only Claude time).
//   /var/lib/tts/{apply,execute}.lock — mkdir-based cron serialization locks.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const CMT_REPO = "ComplexMultiTrigger";
export const CMT_DEFAULT_BRANCH = "master";
export const CMT_CACHE_DIR = "/var/cache/tts/ComplexMultiTrigger";
export const TODOS_PATH = "vqc/todos.yaml"; // relative to the repo root
// The guard test for todos.yaml — run from the CMT repo root. This ONE test
// module (not the whole guard suite) is the contract for "todos.yaml is still
// well-formed after my surgery".
export const TODOS_GUARD_TEST = "tests/guards/test_bb_todos.py";

export const BRIEF_HASHES_FILE = "/var/lib/tts/brief-hashes.json";
export const BRIEF_CACHE_ROOT = "/var/cache/tts/briefs";

// Cursor-value sentinel prefix: apply-rulings sets an entry's cursor value to
// "replan-requested[: <Tom's sentence>]" instead of a real hash when Tom's
// verdict is "edit". Any non-hash value forces a re-brief (it never equals
// the recomputed hash), and the PREFIX tells the briefing job to ask for a
// fresh plan — a plain deletion couldn't be told apart from "never briefed".
// (The sentinel string predates the verdict rename and stays as-is: it is a
// private contract between apply-rulings and brief-code-todos.)
export const REPLAN_SENTINEL = "replan-requested";

// The first characters of the closed-todos banner line in vqc/todos.yaml.
// Everything below this line is intent HISTORY; the live surface is above it.
export const CLOSED_BANNER_PREFIX = "# --- closed todos";

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

// The authenticated CMT remote URL. The token rides in the URL (the
// x-access-token convention GitHub documents for token auth over HTTPS) —
// acceptable here because the URL never leaves the root-only Jarvis Box and the
// jobs re-set it on every refresh, so a rotated token in worker.env takes
// effect on the next cron tick.
export function cmtRemoteUrl(env) {
  if (!env.GH_TOKEN) {
    throw new Error("missing GH_TOKEN in /etc/tts/worker.env — the code-todo jobs need it");
  }
  return `https://x-access-token:${env.GH_TOKEN}@github.com/Heffnt/${CMT_REPO}.git`;
}

// Clone-or-refresh the CMT cache clone and return its path. ALWAYS ends with
// the working tree exactly at origin/master, clean, no untracked leftovers —
// callers may assume the cache is never stale and never dirty. Shallow
// (--depth 1) on purpose: the cache exists to read files and make single
// commits on top of master; only the EXECUTOR needs history, and it takes
// fresh full clones instead.
export function cmtRepoDir(env) {
  const url = cmtRemoteUrl(env);
  if (!fs.existsSync(path.join(CMT_CACHE_DIR, ".git"))) {
    // Missing or half-created (an interrupted clone leaves a dir with no
    // .git) — start over. rm -rf of a cache is free by definition.
    fs.rmSync(CMT_CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(CMT_CACHE_DIR), { recursive: true });
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", CMT_DEFAULT_BRANCH, url, CMT_CACHE_DIR],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    return CMT_CACHE_DIR;
  }
  // Re-set the remote URL every time so a rotated GH_TOKEN takes effect.
  git(CMT_CACHE_DIR, "remote", "set-url", "origin", url);
  // --depth 1 on the fetch keeps the cache shallow forever (a plain fetch in
  // a shallow repo would slowly deepen it). FETCH_HEAD is the just-fetched
  // tip of origin/master; reset --hard + clean -fd makes stale-or-dirty
  // impossible by construction.
  git(CMT_CACHE_DIR, "fetch", "--depth", "1", "origin", CMT_DEFAULT_BRANCH);
  git(CMT_CACHE_DIR, "reset", "--hard", "FETCH_HEAD");
  git(CMT_CACHE_DIR, "clean", "-fd");
  return CMT_CACHE_DIR;
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

// ---------------------------------------------------------------------------
// Source hashes + the brief cursor file
// ---------------------------------------------------------------------------

// Hash of ONE parsed todo entry, used to detect "the YAML changed since the
// last brief". JSON.stringify is deterministic enough here: JS objects keep
// insertion order, which mirrors the file's own key order via python's
// order-preserving load.
export function sourceHash(entry) {
  return crypto.createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

// The cursor file maps "repo:externalId" -> the sourceHash last POSTed (or a
// replan sentinel, see REPLAN_SENTINEL). Corrupt or missing reads as empty —
// the worst case is re-briefing, which the Convex upsert absorbs.
export function readBriefHashes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BRIEF_HASHES_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeBriefHashes(hashes) {
  fs.mkdirSync(path.dirname(BRIEF_HASHES_FILE), { recursive: true });
  fs.writeFileSync(BRIEF_HASHES_FILE, JSON.stringify(hashes, null, 2) + "\n");
}

// Where the local copy of a posted brief lives (markdown; see
// brief-code-todos.mjs for the layout, apply-rulings.mjs for the reader).
export function briefCachePath(repo, externalId) {
  return path.join(BRIEF_CACHE_ROOT, repo, `${externalId}.md`);
}

// ---------------------------------------------------------------------------
// todos.yaml text surgery support
// ---------------------------------------------------------------------------

// Locate one entry's raw text block in todos.yaml. Returns
//   { startLine, endLine, block } — line indices into text.split("\n"),
//   endLine exclusive, block WITHOUT trailing blank lines — or null when the
//   id is absent. An entry runs from its column-0 "- id: <id>" line to the
//   next column-0 "- id:" line or the closed-todos banner or EOF.
//
// WHY text surgery instead of parse-edit-dump: round-tripping YAML through a
// parser would rewrite the WHOLE file (comment loss, block-scalar
// reformatting), turning a one-entry archive into an unreviewable diff. Text
// surgery moves exactly one block and touches nothing else.
export function findEntryBlock(text, id) {
  const lines = text.split("\n");
  // Escape the id for use in a regex (ids are kebab-case today, but cheap
  // insurance beats a silent mis-match).
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idLine = new RegExp(`^- id:\\s*${escaped}\\s*(#.*)?$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (idLine.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id:/.test(lines[i]) || lines[i].startsWith(CLOSED_BANNER_PREFIX)) {
      end = i;
      break;
    }
  }
  const blockLines = lines.slice(start, end);
  while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === "") {
    blockLines.pop();
  }
  return { startLine: start, endLine: end, block: blockLines.join("\n") };
}

// ---------------------------------------------------------------------------
// mkdir-based cron locks
// ---------------------------------------------------------------------------

// Serialize overlapping cron runs with a lock DIRECTORY: mkdir is atomic on
// every POSIX filesystem (it either creates or fails with EEXIST), which is
// the whole trick — no flock(2) binding needed from Node. A lock older than
// staleMs is presumed abandoned (the holder crashed without its finally
// block) and is broken. Returns true when the lock is ours.
export function acquireLock(lockDir, staleMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        continue; // vanished between mkdir and stat — retry the mkdir
      }
      if (ageMs < staleMs) return false; // genuinely held
      console.log(`[lock] breaking stale lock ${lockDir} (age ${Math.round(ageMs / 60000)} min)`);
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // Someone else broke or re-took it first — the retry decides.
      }
    }
  }
  return false;
}

export function releaseLock(lockDir) {
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // Already gone (broken as stale by a later run) — nothing to do.
  }
}
