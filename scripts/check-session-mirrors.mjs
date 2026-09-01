// Guardrail: the worker daemon cannot import convex/ttsShared.ts (only
// worker/ is deployed to the Jarvis Box; Node does not load .ts), so it carries the
// session-surface constants itself — REPO_GITHUB as a literal mirror, and the
// daemon staleness window as the poll cadence it is derived from. This check
// fails when either side drifts from the one home (ledger graduation
// session-constants-two-homes: "a byte-equality check ties the mirrors").
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

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

// 4. The worker env loader has ONE body. worker/jobs/worker-env.mjs is it;
// worker/session-host/worker-env.mjs is a symlink to it, because setup.sh
// installs jobs/ flat to /opt/tts and session-host/ to /opt/tts/session-host,
// so a spelled-out ../jobs import resolves in the repo and dangles on the box
// (that file's header carries the reasoning). Two ways to lose the one home:
// replace the link with a second real file, or paste the KEY=VALUE parse back
// into a caller. Both are checked.
// witness: `rm worker/session-host/worker-env.mjs && cp worker/jobs/worker-env.mjs
// worker/session-host/`, or copy the parse loop into lib.mjs.
const ENV_LINK = "worker/session-host/worker-env.mjs";
const ENV_LINK_TARGET = "../jobs/worker-env.mjs";
try {
  if (!lstatSync(ENV_LINK).isSymbolicLink()) {
    failures.push(`${ENV_LINK} is a real file — it must stay a symlink to ${ENV_LINK_TARGET}`);
  } else if (readlinkSync(ENV_LINK) !== ENV_LINK_TARGET) {
    failures.push(
      `${ENV_LINK} points at ${readlinkSync(ENV_LINK)}, not ${ENV_LINK_TARGET}`,
    );
  }
} catch {
  failures.push(`${ENV_LINK} is missing — the session-host daemon cannot read /etc/tts/worker.env`);
}
// The parse loop's own marker line, which must appear in exactly one file.
const PARSE_MARKER = 'const eq = line.indexOf("=");';
for (const [file, text] of [
  ["worker/jobs/tts-lib.mjs", readFileSync("worker/jobs/tts-lib.mjs", "utf8")],
  ["worker/session-host/lib.mjs", readFileSync("worker/session-host/lib.mjs", "utf8")],
]) {
  if (text.includes(PARSE_MARKER)) {
    failures.push(`${file} parses worker.env itself again — import loadEnv from worker-env.mjs`);
  }
}

if (failures.length > 0) {
  console.error("Session-mirror check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Session mirror check passed.");
