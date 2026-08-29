// tts-code-lib.mjs — shared helpers for the TTS CODE-TODO jobs
// (brief-code-todos.mjs, apply-rulings.mjs, execute-approved.mjs). Plain Node
// ESM, ZERO npm dependencies — same rules as tts-lib.mjs.
//
// The code-todo loop in one breath: each GOVERNED REPO (a repo that keeps its
// standing intent in a `vqc/todos.yaml` registry) is mirrored into Convex; the
// briefing job explains each open entry to Tom and recommends a ruling; Tom
// rules in the tom.quest UI (stored in Convex); the apply job carries out
// non-execution rulings; the executor implements ONE approved plan per hour on
// a branch and opens a PR — merging that PR is the human gate.
//
// TWO GOVERNED REPOS, not one. Everything below is keyed by repo because the
// two differ in ways that matter to the jobs — default branch, how a closed
// entry is written, whether the box can run the repo's own guard, and whether
// a ruling may push straight to the default branch. See CODE_REPOS.
//
// STATE ON THIS BOX (all harmless to lose, per the no-state rule):
//   /var/cache/tts/<repo> — shallow cache clone, one per governed repo;
//       rebuilt from origin on every use, so deleting it costs one clone.
//   /var/cache/tts/briefs/<repo>/<id>.md — local copy of each posted brief so
//       the apply job can embed it in session agendas without a Convex read
//       endpoint; rebuildable by re-briefing (--force).
//   /var/lib/tts/brief-hashes.json — cursor: the source hash each entry was
//       last briefed at, keyed "<repo>:<id>". Losing it just re-briefs
//       everything once (the Convex POST upserts, so duplicates cost only
//       Claude time).
//   /var/lib/tts/{apply,execute}.lock — mkdir-based cron serialization locks.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// The governed-repo registry
// ---------------------------------------------------------------------------

// EVERY repo mirrored into Convex by MIRROR_SOURCES in convex/ttsSync.ts must
// appear here, or its mirrored todos are briefed by nobody, and an unbriefed
// code todo is dropped by form-batches.mjs — permanently unbatchable, silently.
// worker/jobs/tts-code-lib.test.ts fences the two lists against each other.
//
// Field by field:
//   defaultBranch  the branch the mirror reads and rulings target.
//   cacheDir       shallow clone kept between runs (see repoCacheDir).
//   todosPath      the registry file, relative to the repo root.
//   closureStyle   how an ARCHIVE ruling closes an entry in that file:
//                    "banner"   — move the block below the closed-todos
//                                 banner and add `closed: <date>` (CMT's
//                                 convention: the live surface is the top of
//                                 the file, history accumulates below).
//                    "in-place" — leave the block where it is and set
//                                 `status: archived` (tom.quest's convention:
//                                 the file has no banner; `status` is the
//                                 machine-readable truth).
//                  Both styles append a `resolution:` block scalar.
//   guardCommand   the repo's OWN todos-shape test, as argv run from the repo
//                  root, or null when the box cannot run it. tom.quest's guard
//                  is vitest (vqc/todos.test.ts) and needs an installed
//                  node_modules the shallow cache clone does not have;
//                  installing one on every run was the alternative and was not
//                  worth minutes of pnpm per ruling. verifyTodosFile() runs for
//                  every repo either way, so a null guard is never "no check".
//   pushMode       "direct" — commit the ruling straight onto defaultBranch.
//                  "pull-request" — push a branch and open a PR instead. Two
//                  facts force this for tom.quest: its default branch is what
//                  Vercel deploys to production, and (guardCommand: null) its
//                  real guard runs only in CI, so a PR is the first place the
//                  real guard can go red before the change is permanent.
//                  INVARIANT: guardCommand === null implies pushMode ===
//                  "pull-request" (fenced by the test).
//   testCommand    what the executor's prompt tells the agentic run to execute
//                  before it finishes — the repo's own words, for the model.
//   handoffDir     where a SESSION ruling writes its agenda file.
export const CODE_REPOS = {
  ComplexMultiTrigger: {
    repo: "ComplexMultiTrigger",
    defaultBranch: "master",
    cacheDir: "/var/cache/tts/ComplexMultiTrigger",
    todosPath: "vqc/todos.yaml",
    closureStyle: "banner",
    guardCommand: ["python3", "-m", "pytest", "tests/guards/test_bb_todos.py", "-q"],
    pushMode: "direct",
    testCommand: "python3 -m pytest tests/guards -q",
    handoffDir: "dev/handoff",
  },
  "tom.quest": {
    repo: "tom.quest",
    defaultBranch: "main",
    cacheDir: "/var/cache/tts/tom.quest",
    todosPath: "vqc/todos.yaml",
    closureStyle: "in-place",
    guardCommand: null,
    pushMode: "pull-request",
    testCommand: "pnpm vitest run vqc/todos.test.ts",
    handoffDir: "tts/handoff",
  },
};

// The registry entry for a repo name, or null when the repo is not governed.
// Callers turn null into a visible "unsupported repo" result rather than a
// crash — a ruling on an unknown repo must not clog the queue.
export function repoConfig(repo) {
  return Object.prototype.hasOwnProperty.call(CODE_REPOS, repo)
    ? CODE_REPOS[repo]
    : null;
}

// The first characters of the closed-todos banner line in a "banner"-style
// registry. Everything below this line is intent HISTORY; the live surface is
// above it.
export const CLOSED_BANNER_PREFIX = "# --- closed todos";

export const BRIEF_HASHES_FILE = "/var/lib/tts/brief-hashes.json";
export const BRIEF_CACHE_ROOT = "/var/cache/tts/briefs";

// Cursor-value sentinel prefix: apply-rulings sets an entry's cursor value to
// "replan-requested[: <Tom's sentence>]" instead of a real hash when Tom's
// verdict is "revise". Any non-hash value forces a re-brief (it never equals
// the recomputed hash), and the PREFIX tells the briefing job to ask for a
// fresh plan — a plain deletion couldn't be told apart from "never briefed".
// (The sentinel string predates the verdict rename and stays as-is: it is a
// private contract between apply-rulings and brief-code-todos.)
export const REPLAN_SENTINEL = "replan-requested";

// ---------------------------------------------------------------------------
// Open vs closed
// ---------------------------------------------------------------------------

// Is this parsed registry entry still LIVE? One predicate for both closure
// conventions, and deliberately the same test the Convex mirror applies in
// convex/ttsSync.ts — the jobs and the mirror must never disagree about which
// entries exist, or the UI would offer a ruling on an entry no job will brief.
export function isOpenEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.closed !== undefined) return false;
  return !(
    entry.status === "done" ||
    entry.status === "archived" ||
    entry.status === "closed"
  );
}

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

// The authenticated remote URL for a governed repo. The token rides in the URL
// (the x-access-token convention GitHub documents for token auth over HTTPS) —
// acceptable here because the URL never leaves this root-only box and the jobs
// re-set it on every refresh, so a rotated token in worker.env takes effect on
// the next cron tick.
export function remoteUrl(env, cfg) {
  if (!env.GH_TOKEN) {
    throw new Error("missing GH_TOKEN in /etc/tts/worker.env — the code-todo jobs need it");
  }
  return `https://x-access-token:${env.GH_TOKEN}@github.com/Heffnt/${cfg.repo}.git`;
}

// Clone-or-refresh one repo's cache clone and return its path. ALWAYS ends
// with the working tree exactly at origin/<defaultBranch>, clean, no untracked
// leftovers — callers may assume the cache is never stale and never dirty.
// Shallow (--depth 1) on purpose: the cache exists to read files and make
// single commits on top of the default branch; only the EXECUTOR needs
// history, and it takes fresh full clones instead.
export function repoCacheDir(env, cfg) {
  const url = remoteUrl(env, cfg);
  if (!fs.existsSync(path.join(cfg.cacheDir, ".git"))) {
    // Missing or half-created (an interrupted clone leaves a dir with no
    // .git) — start over. rm -rf of a cache is free by definition.
    fs.rmSync(cfg.cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cfg.cacheDir), { recursive: true });
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", cfg.defaultBranch, url, cfg.cacheDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    return cfg.cacheDir;
  }
  // Re-set the remote URL every time so a rotated GH_TOKEN takes effect.
  git(cfg.cacheDir, "remote", "set-url", "origin", url);
  // --depth 1 on the fetch keeps the cache shallow forever (a plain fetch in
  // a shallow repo would slowly deepen it). FETCH_HEAD is the just-fetched
  // tip of the default branch; reset --hard + clean -fd makes stale-or-dirty
  // impossible by construction. The checkout runs LAST, on an already-clean
  // tree (it cannot fail on local modifications), and undoes a work branch
  // left behind by a pull-request-mode ruling.
  git(cfg.cacheDir, "fetch", "--depth", "1", "origin", cfg.defaultBranch);
  git(cfg.cacheDir, "reset", "--hard", "FETCH_HEAD");
  git(cfg.cacheDir, "clean", "-fd");
  git(cfg.cacheDir, "checkout", "-B", cfg.defaultBranch, "FETCH_HEAD");
  return cfg.cacheDir;
}

// ---------------------------------------------------------------------------
// YAML via python3 (the sanctioned parser)
// ---------------------------------------------------------------------------

// Parse a YAML file to a JS value. WHY python: the no-npm-deps rule leaves
// Node without a YAML parser, and the box already carries python3-yaml for
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

// Locate one entry's raw text block in a registry file. Returns
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

// Greedy word-wrap to `width` columns — for YAML `>-` block-scalar bodies,
// which re-fold on parse, so the wrap points are cosmetic (matching the
// registries' ~100-column style) and never semantic.
export function wrapText(text, width) {
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

// Close one entry in a registry file's TEXT, in that repo's own convention.
// Returns { ok: true, text } with the rewritten file, or { ok: false, reason }
// — with `already: true` when the entry is already closed, which is a no-op to
// report, not a failure to retry.
//
// The FULL body is kept in both styles (statement, cites, plan, …): the guards
// require every entry's schema fields open or closed, and keeping the body
// also keeps the diff a pure move-plus-two-fields, easy to review.
export function closeEntryText(text, cfg, { id, resolution, today }) {
  const found = findEntryBlock(text, id);
  if (!found) return { ok: false, reason: `entry ${id} not found in ${cfg.todosPath}` };

  const blockLines = found.block.split("\n");
  const resolutionLines = [
    `  resolution: >-`,
    ...wrapText(resolution, 96).map((l) => `    ${l}`),
  ];
  const lines = text.split("\n");

  if (cfg.closureStyle === "banner") {
    if (blockLines.some((l) => /^ {2}closed:/.test(l))) {
      return { ok: false, already: true, reason: "already closed — nothing to do" };
    }
    if (!lines.some((l) => l.startsWith(CLOSED_BANNER_PREFIX))) {
      return { ok: false, reason: `no closed-todos banner in ${cfg.todosPath}` };
    }
    // `closed:` slots in right after `created:` (the file's own convention),
    // the resolution goes at the end of the block.
    const createdAt = blockLines.findIndex((l) => /^ {2}created:/.test(l));
    const closedLine = `  closed: ${today}`;
    if (createdAt !== -1) blockLines.splice(createdAt + 1, 0, closedLine);
    else blockLines.push(closedLine);
    blockLines.push(...resolutionLines);

    // Remove the block from the live surface, re-append at file end (which is
    // below the banner by construction — closed history accumulates at the
    // bottom), one blank line before it, single trailing newline after.
    const remaining = lines.slice(0, found.startLine).concat(lines.slice(found.endLine));
    while (remaining.length > 0 && remaining[remaining.length - 1].trim() === "") {
      remaining.pop();
    }
    return { ok: true, text: remaining.concat([""], blockLines).join("\n") + "\n" };
  }

  // "in-place": the entry does not move; `status` carries the closure and the
  // resolution is appended to the same block.
  const statusAt = blockLines.findIndex((l) => /^ {2}status:/.test(l));
  if (statusAt === -1) {
    return { ok: false, reason: `entry ${id} has no \`status:\` line to close` };
  }
  if (/^ {2}status:\s*(archived|done|closed)\b/.test(blockLines[statusAt])) {
    return { ok: false, already: true, reason: "already closed — nothing to do" };
  }
  if (blockLines.some((l) => /^ {2}resolution:/.test(l))) {
    return { ok: false, reason: `entry ${id} already carries a resolution` };
  }
  blockLines[statusAt] = `  status: archived`;
  blockLines.push(...resolutionLines);

  const rewritten = lines
    .slice(0, found.startLine)
    .concat(blockLines, lines.slice(found.endLine));
  return { ok: true, text: rewritten.join("\n") };
}

// ---------------------------------------------------------------------------
// Guarding the surgery
// ---------------------------------------------------------------------------

// The check the box can always run, for every governed repo: after surgery the
// registry must still parse to a list, every entry must still have a unique
// id, no id may have appeared or vanished, and the entry we meant to close
// must read as closed. This is NOT a substitute for a repo's own guard (it
// knows nothing about cites or required fields) — it is the floor that catches
// what text surgery can actually break: a mangled block, a lost entry, a
// closure that didn't take.
// `allowNewIds` widens the id check to "nothing was LOST": text surgery may
// never invent an entry, but the executor's agentic run legitimately may (the
// registries encourage an agent to record a todo it finds while working).
export function verifyTodosFile(cfg, repoDir, { idsBefore, closedId, allowNewIds }) {
  const file = path.join(repoDir, cfg.todosPath);
  let parsed;
  try {
    parsed = yamlToJson(file);
  } catch (err) {
    return { ok: false, tail: `${cfg.todosPath} no longer parses: ${err.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, tail: `${cfg.todosPath} did not parse to a list` };
  }
  const ids = parsed.map((e) => (e && typeof e === "object" ? e.id : undefined));
  if (ids.some((id) => typeof id !== "string" || id === "")) {
    return { ok: false, tail: `${cfg.todosPath} has an entry with no id` };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, tail: `${cfg.todosPath} has duplicate ids` };
  }
  if (idsBefore) {
    const after = new Set(ids);
    const lost = idsBefore.filter((id) => !after.has(id));
    const gained = allowNewIds ? [] : ids.filter((id) => !idsBefore.includes(id));
    if (lost.length > 0 || gained.length > 0) {
      return {
        ok: false,
        tail:
          `${cfg.todosPath} entry set changed` +
          (lost.length > 0 ? ` — lost: ${lost.join(", ")}` : "") +
          (gained.length > 0 ? ` — gained: ${gained.join(", ")}` : ""),
      };
    }
  }
  if (closedId) {
    const entry = parsed.find((e) => e && typeof e === "object" && e.id === closedId);
    if (!entry) return { ok: false, tail: `entry ${closedId} vanished from ${cfg.todosPath}` };
    if (isOpenEntry(entry)) {
      return { ok: false, tail: `entry ${closedId} still reads as open after closing it` };
    }
    if (typeof entry.resolution !== "string" || entry.resolution.trim() === "") {
      return { ok: false, tail: `entry ${closedId} was closed without a resolution` };
    }
  }
  return { ok: true, tail: "" };
}

// Run a repo's OWN todos guard, when it declares one the box can run.
// {ok, tail} where tail is the last chunk of the runner's output, for the
// failure report Tom reads in the UI. A repo with guardCommand: null passes
// here — verifyTodosFile is the check that always runs (see CODE_REPOS).
export function runRepoGuard(cfg, repoDir) {
  if (!cfg.guardCommand) return { ok: true, tail: "" };
  const [cmd, ...args] = cfg.guardCommand;
  try {
    execFileSync(cmd, args, {
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
