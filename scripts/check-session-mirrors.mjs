// Guardrail: the worker daemon cannot import convex/ttsShared.ts (only
// worker/ is deployed to the Jarvis Box; Node does not load .ts), so it carries the
// session-surface constants itself — REPO_GITHUB as a literal mirror, and the
// daemon staleness window as the poll cadence it is derived from. This check
// fails when either side drifts from the one home (ledger graduation
// session-constants-two-homes: "a byte-equality check ties the mirrors").
import { readFileSync } from "node:fs";

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

// 4. Temporary files. Two homes again: the daemon gives each session a
// temporary-file directory on disk and exports it as TMPDIR
// (worker/session-host/session.mjs), and the mission prompt built in Convex
// tells the agent where to write the two payload files its pens POST
// (convex/claudeSessions.ts). When those drift the fleet writes into /tmp,
// which on the Jarvis Box is a filesystem held in RAM — it reached 100 percent
// full on 2026-08-30 and broke tooling inside live sessions — and, worse, every
// session writes the SAME two filenames there: on 2026-09-01 a session opened
// /tmp/tts-body.json and found another session's todo id and evidence in it,
// one `curl -d @` away from posting a payload naming a todo it did not hold.
// witness: change TMPDIR in session.mjs's SDK env to anything else, or put a
// bare /tmp path back in the prompt, and this check fails.
if (!/TMPDIR: this\.tmpDir/.test(sessionMjs)) {
  failures.push(
    "session.mjs: the SDK env no longer sets TMPDIR to this.tmpDir — sessions would write temporary files into the RAM-backed /tmp",
  );
}
const bareTmpInPrompt = convexTs
  .split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(
    ({ line }) =>
      /["`][^"`]*\/tmp\//.test(line) && !line.trim().startsWith("//"),
  );
if (bareTmpInPrompt.length > 0) {
  for (const { line, n } of bareTmpInPrompt) {
    failures.push(
      `claudeSessions.ts:${n}: a prompt names a bare /tmp path — use "\${TMPDIR:-/tmp}" so the file lands in the session's own directory on disk: ${line.trim().slice(0, 100)}`,
    );
  }
}
// And the daemon's command classifier must still see a write into /tmp at all:
// the fingerprint is what buys a verdict, and 2.5 GB of the 3.2 GB in /tmp on
// 2026-09-01 was repository clones an agent addressed by absolute path, which
// no environment variable can move.
// witness: drop the `\/tmp\/` alternative from BASH_DANGER_RE.
const dangerMatch = sessionMjs.match(/const BASH_DANGER_RE =\n\s*\/(.+)\/;/);
if (!dangerMatch) failures.push("session.mjs: BASH_DANGER_RE literal not found");
if (dangerMatch) {
  const danger = new RegExp(dangerMatch[1]);
  if (!danger.test("git clone --depth 1 https://github.com/x/y /tmp/killcheck")) {
    failures.push(
      "BASH_DANGER_RE no longer fingerprints a clone into /tmp — the classifier would never be asked about it",
    );
  }
  if (danger.test("pnpm test") || danger.test("git commit -am 'x'")) {
    failures.push(
      "BASH_DANGER_RE now fingerprints ordinary dev flow — every test run would pay classifier latency",
    );
  }
}

if (failures.length > 0) {
  console.error("Session-mirror check FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Session mirror check passed.");
