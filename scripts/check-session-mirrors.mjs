// Guardrail: the worker daemon cannot import convex/ttsShared.ts (only
// worker/ is deployed to the Jarvis Box; Node does not load .ts), so it carries the
// session-surface constants itself — REPO_GITHUB as a literal mirror, and the
// daemon staleness window as the poll cadence it is derived from. This check
// fails when either side drifts from the one home (ledger graduation
// session-constants-two-homes: "a byte-equality check ties the mirrors").
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const shared = readFileSync("convex/ttsShared.ts", "utf8");
const sessionMjs = readFileSync("worker/session-host/session.mjs", "utf8");
const hostMjs = readFileSync("worker/session-host/session-host.mjs", "utf8");

const failures = [];

// 1. DAEMON_STALE_MS: the one home's literal must equal 3 missed idle polls
//    (the CONTRACT comment above POLL_IDLE_MS in session-host.mjs). The worker
//    carries no DAEMON_STALE_MS of its own — the cadence IS its half.
const staleMatch = shared.match(/DAEMON_STALE_MS = ([\d_]+)/);
const idleMatch = hostMjs.match(/POLL_IDLE_MS = ([\d_]+)/);
if (!staleMatch) failures.push("ttsShared.ts: DAEMON_STALE_MS literal not found");
if (!idleMatch) failures.push("session-host.mjs: POLL_IDLE_MS literal not found");
if (staleMatch && idleMatch) {
  const stale = Number(staleMatch[1].replace(/_/g, ""));
  const idle = Number(idleMatch[1].replace(/_/g, ""));
  if (stale !== 3 * idle) {
    failures.push(
      `staleness contract drifted: DAEMON_STALE_MS=${stale} but 3 x POLL_IDLE_MS=${3 * idle}`,
    );
  }
}

// 2. Repo map: every repo in the one home must appear in the daemon's
// REPO_GITHUB with the same GitHub path, and vice versa. Both sides are
// extracted block-scoped with the same regex, and each block's entry count is
// asserted against the match count so an entry whose shape the regex cannot
// read fails loudly instead of vanishing from both sides.
const entryRe = /"?([\w.-]+)"?: "([\w.-]+\/[\w.-]+)",/g;
const readRepos = (block, where) => {
  const entries = [...block.matchAll(entryRe)].map((m) => `${m[1]}=${m[2]}`);
  const lines = block
    .split("\n")
    .filter((l) => l.includes(":") && !l.trim().startsWith("//")).length;
  if (lines !== entries.length) {
    failures.push(
      `${where}: ${lines} repo entr${lines === 1 ? "y" : "ies"} but only ${entries.length} parsed — unreadable entry shape`,
    );
  }
  return entries;
};

const sharedBlock = shared.match(/SESSION_REPOS = \{([^}]+)\}/);
const daemonBlock = sessionMjs.match(/const REPO_GITHUB = \{([^}]+)\}/);
if (!sharedBlock) failures.push("ttsShared.ts: SESSION_REPOS not found");
if (!daemonBlock) failures.push("session.mjs: REPO_GITHUB not found");
if (sharedBlock && daemonBlock) {
  const a = readRepos(sharedBlock[1], "ttsShared.ts SESSION_REPOS")
    .sort()
    .join("|");
  const b = readRepos(daemonBlock[1], "session.mjs REPO_GITHUB").sort().join("|");
  if (a !== b) {
    failures.push(
      `repo maps drifted:\n  ttsShared.ts: ${a}\n  session.mjs:  ${b}`,
    );
  }
}

// 3. The usage-limit fingerprint: the daemon's account auto-switch
// (USAGE_LIMIT_RE in session.mjs) and the scheduler's circuit breaker
// (AUTO_USAGE_RE in claudeSessions.ts) must mean the same thing by "the
// account is capped" — on 2026-08-30 the CLI's live text ("You've hit your
// session limit · resets 8:10am (UTC)") matched neither, the account never
// switched, and the scheduler burned a dozen launches against a wall. The two
// sources must byte-match, and both must match the observed cap texts while
// staying quiet on transient API weather.
// witness: change one regex's source, or drop the `session limit`
// alternative from both.
const convexTs = readFileSync("convex/claudeSessions.ts", "utf8");
const usageA = sessionMjs.match(/USAGE_LIMIT_RE = \/(.+)\/i;/);
const usageB = convexTs.match(/AUTO_USAGE_RE = \/(.+)\/i;/);
if (!usageA) failures.push("session.mjs: USAGE_LIMIT_RE literal not found");
if (!usageB) failures.push("claudeSessions.ts: AUTO_USAGE_RE literal not found");
if (usageA && usageB) {
  if (usageA[1] !== usageB[1]) {
    failures.push(
      `usage-limit regexes drifted:\n  session.mjs:       /${usageA[1]}/i\n  claudeSessions.ts: /${usageB[1]}/i`,
    );
  }
  const re = new RegExp(usageA[1], "i");
  for (const observed of [
    "You've hit your session limit · resets 8:10am (UTC)",
    "Claude AI usage limit reached",
    "5-hour limit reached",
  ]) {
    if (!re.test(observed)) {
      failures.push(`usage-limit regex misses observed cap text: "${observed}"`);
    }
  }
  for (const transient of ["overloaded_error", "API rate limit exceeded (429)"]) {
    if (re.test(transient)) {
      failures.push(
        `usage-limit regex over-matches transient API weather: "${transient}" — a 529/429 must not stand the fleet down for 3h`,
      );
    }
  }
}

// 4. No fourth copy of the repo list. SESSION_REPOS is the one home; before
// PR #28 the same fact was hand-written three more times (AUTO_REPOS,
// PROSPECT_REPOS, REPO_OPTIONS), so adding a repo in one place left the others
// silently disagreeing. Those three are gone — two are now DERIVED from the one
// home and one was deleted — and this check is what stops a fourth appearing.
// Rule: outside the files listed in REPO_LIST_ALLOWED, no source file may name
// two or more session repos close together in executable code. Two names within
// REPO_NAME_WINDOW characters of each other is a list, whatever syntax carries
// it — an array, an object, a union type, a switch.
// Comments are stripped first on purpose: prose that names several repos is
// documentation and cannot drift into behavior (convex/schema.ts documents the
// mirror's repo column that way). Test files (*.test.* and *.spec.*) are exempt
// because a hard-coded expectation that goes red when the one home changes is
// the alarm working, not a silent copy.
// witness: paste `const REPOS = ["tom.quest", "WikiTom"]` into any convex/ or
// app/ file and this check fails.
const REPO_LIST_ALLOWED = new Set([
  "convex/ttsShared.ts", // the one home
  "worker/session-host/session.mjs", // the daemon mirror, fenced by check 2 above
  "scripts/check-session-mirrors.mjs", // this file
]);
const REPO_NAME_WINDOW = 300;
const SCAN_EXT = /\.(ts|tsx|mjs|cjs|js|jsx)$/;
const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vercel",
  "_generated",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
]);

const sourceFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) walk(join(dir, entry.name));
    } else if (
      SCAN_EXT.test(entry.name) &&
      !/\.(test|spec)\.[a-z]+$/.test(entry.name)
    ) {
      sourceFiles.push(join(dir, entry.name).replace(/^\.\//, ""));
    }
  }
};

// Strip line and block comments so only executable code is searched. Kept
// deliberately simple: a `//` inside a string (a URL) is cut too, which can only
// shorten the searched text and therefore can only make this check quieter on a
// line that was already prose-heavy — never louder on a real list.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

if (sharedBlock) {
  const repoNames = [...sharedBlock[1].matchAll(entryRe)].map((m) => m[1]);
  if (repoNames.length < 2) {
    failures.push(
      "repo-list fence: fewer than 2 repo names parsed from SESSION_REPOS — the fence cannot run",
    );
  } else {
    const nameRes = repoNames.map((name) => ({
      name,
      re: new RegExp(`(?<![\\w.-])${name.replace(/\./g, "\\.")}(?![\\w-])`, "g"),
    }));
    walk(".");
    for (const file of sourceFiles) {
      if (REPO_LIST_ALLOWED.has(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      const hits = [];
      for (const { name, re } of nameRes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(code)) !== null) hits.push({ name, at: m.index });
      }
      hits.sort((a, b) => a.at - b.at);
      for (let i = 0; i < hits.length - 1; i++) {
        const next = hits[i + 1];
        if (next.at - hits[i].at > REPO_NAME_WINDOW) continue;
        if (next.name === hits[i].name) continue;
        const line = code.slice(0, hits[i].at).split("\n").length;
        failures.push(
          `repo list copied outside the one home: ${file}:${line} names ${hits[i].name} and ${next.name} together — derive it from SESSION_REPO_NAMES in convex/ttsShared.ts instead`,
        );
        break;
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Session-mirror check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Session mirror check passed.");
