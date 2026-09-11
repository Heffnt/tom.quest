// Text fences on the poll loop (worker/session-host/session-host.mjs) and
// the model lookup (session.mjs) for the 2026-09-04 review findings. Read as
// TEXT for the reason banned-tools.test.mjs gives: both modules import the
// Agent SDK (installed only on the box) and cannot be loaded here. What CAN
// be executed is: the poll walk's decision (poll-plan.test.mjs), the scrub
// (env-scrub.test.mjs), the binary resolution (codex-bin.test.mjs).
//
// This directory is deliberately NOT flat: setup.sh installs the daemon with
// `cp worker/session-host/*.mjs`, so this file never ships.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(here, "..", name), "utf8");
const hostSource = read("session-host.mjs");
const sessionSource = read("session.mjs");

const between = (text, start, end) => {
  const a = text.indexOf(start);
  expect(a, `landmark not found: ${start}`).toBeGreaterThan(-1);
  const b = text.indexOf(end, a);
  expect(b, `landmark not found after ${start}: ${end}`).toBeGreaterThan(-1);
  return text.slice(a, b);
};

// Finding 1: an unknown model name must never throw out of the constructor,
// and the poll walk must survive any row it cannot handle.
describe("unknown model name degrades to opus (finding 1)", () => {
  it("modelFamily/modelSpec fall back to the opus spec for an unknown name", () => {
    expect(sessionSource).toMatch(/export function knownModel\(name\) \{\s*\n\s*return Object\.hasOwn\(SESSION_MODELS, name \?\? "opus"\);/);
    expect(sessionSource).toMatch(/export function modelSpec\(name\) \{\s*\n\s*return SESSION_MODELS\[knownModel\(name\) \? \(name \?\? "opus"\) : "opus"\];/);
    const family = between(sessionSource, "export function modelFamily(name) {", "\n}\n");
    expect(family).toMatch(/if \(!knownModel\(name\)\) name = "opus";/);
    // The mirror check's fenced expression stays (scripts/check-session-mirrors.mjs).
    expect(family).toMatch(/SESSION_MODELS\[name \?\? "opus"\]\.family/);
  });

  it("the constructor logs the fallback once per session, and startQuery writes the row", () => {
    const ctor = between(sessionSource, "this.family = modelFamily(this.model);", "this.modelSwitchPending = false;");
    expect(ctor).toMatch(/if \(!knownModel\(this\.model\)\) \{\s*\n\s*log\(`session \$\{id\}: model \$\{this\.model\} unknown to this daemon — running as opus`\);/);
    const startQuery = between(sessionSource, "startQuery({ resume } = {})", "async #readLoop(");
    expect(startQuery).toMatch(/const spec = modelSpec\(this\.model\);/);
    expect(startQuery).not.toMatch(/SESSION_MODELS\[this\.model\]/);
    expect(startQuery).toMatch(/!this\.modelFallbackNoted[\s\S]*?unknown to this daemon — running as opus/);
  });

  it("the poll walk fences every row in try/catch around planRow", () => {
    const walk = between(hostSource, "for (const row of data.sessions ?? []) {", "// Locals the server no longer lists");
    expect(walk).toMatch(/try \{\s*\n\s*switch \(planRow\(row, \{ local, liveIds \}\)\) \{/);
    expect(walk).toMatch(/\} catch \(err\) \{/);
    // Constructed in this poll → the failed path; otherwise skip and log once.
    expect(walk).toMatch(/if \(s && s !== local && !s\.dead[\s\S]*?failSession\(s, err\)/);
    expect(walk).toMatch(/notedRows\.add\(row\.id\);\s*\n\s*log\(\s*\n?\s*`session \$\{row\.id\}: poll handling threw \(row skipped; logged once\):`/);
    // No claim or adopt outside the fence.
    const tryStart = walk.indexOf("try {");
    for (const call of ["claimSession(env, sessions, row)", "adoptSession(env, sessions, row)", "local.processServerState(row)"]) {
      expect(walk.indexOf(call), `${call} runs before the try`).toBeGreaterThan(tryStart);
    }
  });

  it("claimSession's async tail is fenced too (an unhandled rejection kills the process)", () => {
    const claim = between(hostSource, "function claimSession(env, sessions, row) {", "// ── adopt:");
    expect(claim).toMatch(/try \{\s*\n\s*s\.startQuery\(\);[\s\S]*?s\.processServerState\(row\);\s*\n\s*\} catch \(err\) \{[\s\S]*?failSession\(s, err\)/);
  });
});

// Finding 2: the fork transcript is written at claim (source terminal by the
// walk's deferral) and only re-created, never refreshed, on a rebuild.
describe("fork transcript timing (finding 2)", () => {
  it("the walk defers a fork whose source is still live, logging once", () => {
    const walk = between(hostSource, "for (const row of data.sessions ?? []) {", "// Locals the server no longer lists");
    expect(walk).toMatch(/case "defer-fork":[\s\S]*?log\(`fork \$\{row\.id\} of \$\{row\.forkedFrom\} waits for its source to end`\);/);
    expect(hostSource).toMatch(/const liveIds = new Set\(\(data\.sessions \?\? \[\]\)\.map\(\(row\) => String\(row\.id\)\)\);/);
  });

  it("ensureWorkdir refreshes at claim and only re-creates on a rebuild", () => {
    expect(sessionSource).toMatch(/await this\.#writeForkTranscript\(\{ refresh: !forResume \}\);/);
    const write = between(sessionSource, "async #writeForkTranscript({ refresh }) {", "async #preserveWork(");
    expect(write).toMatch(/if \(!refresh && fs\.existsSync\(file\)\) return;/);
    expect(write).not.toMatch(/if \(fs\.existsSync\(file\)\) return;/);
  });
});

// Finding 3: the usage read never holds the poll loop, keeps the last
// successful reading, and backs off after failures.
describe("codex usage read (finding 3)", () => {
  const refresh = between(hostSource, "function refreshCodexUsage() {", "// ── usage-limit account auto-switch");

  it("is fire-and-forget with an in-flight guard", () => {
    expect(hostSource).not.toMatch(/async function refreshCodexUsage/);
    expect(hostSource).toMatch(/\n\s*refreshCodexUsage\(\);/);
    expect(hostSource).not.toMatch(/await refreshCodexUsage/);
    expect(refresh).toMatch(/if \(codexUsageInFlight \|\| now < codexUsageNextAt\) return;/);
    expect(refresh).toMatch(/codexUsageInFlight = true;\s*\n\s*void \(async \(\) => \{/);
    expect(refresh).toMatch(/finally \{\s*\n\s*codexUsageInFlight = false;/);
  });

  it("keeps the last successful reading (original readAt) when a read fails", () => {
    expect(refresh).not.toMatch(/codexUsage = undefined/);
    expect(refresh).toMatch(/codexUsage = await readCodexUsage\(\);/);
    // readAt is stamped by the read itself, never rewritten on failure.
    expect(hostSource).toMatch(/readAt: Date\.now\(\),/);
    expect(refresh).not.toMatch(/readAt/);
  });

  it("backs off 2x per failure, capped at 30 minutes", () => {
    expect(hostSource).toMatch(/const CODEX_USAGE_INTERVAL_MS = 5 \* 60 \* 1000;/);
    expect(hostSource).toMatch(/const CODEX_USAGE_BACKOFF_CAP_MS = 30 \* 60 \* 1000;/);
    expect(refresh).toMatch(/codexUsageFailures \+= 1;/);
    expect(refresh).toMatch(/Math\.min\(\s*\n?\s*CODEX_USAGE_BACKOFF_CAP_MS,\s*\n?\s*CODEX_USAGE_INTERVAL_MS \* 2 \*\* codexUsageFailures,?\s*\n?\s*\)/);
    expect(refresh).toMatch(/codexUsageFailures = 0;/);
  });

  it("sends the reading only when one has ever succeeded", () => {
    expect(hostSource).toMatch(/\.\.\.\(codexUsage !== undefined \? \{ codexUsage \} : \{\}\)/);
  });

  it("readCodexUsage swallows stdin errors like the sibling spawns", () => {
    const readFn = between(hostSource, "async function readCodexUsage() {", "function refreshCodexUsage() {");
    expect(readFn).toMatch(/child\.stdin\.on\("error", \(\) => \{/);
  });
});

// Finding 4: the warm-up runs in the background, once per CODEX_HOME, only
// when the binary is installed.
describe("codex warm-up (finding 4)", () => {
  const warm = between(hostSource, "async function warmUpCodex() {", "// Codex account usage for the heartbeat");

  it("is never awaited before the first poll; Codex claims await codexReady instead", () => {
    expect(hostSource).not.toMatch(/await warmUpCodex\(\)/);
    const main = between(hostSource, "async function main() {", "for (;;) {");
    expect(main).toMatch(/codexReady = warmUpCodex\(\);/);
    const claim = between(hostSource, "function claimSession(env, sessions, row) {", "// ── adopt:");
    expect(claim).toMatch(/if \(s\.family === "codex"\) await codexReady;/);
    expect(hostSource).toMatch(/let codexReady = Promise\.resolve\(\);/);
  });

  it("skips when the marker exists, and when the binary does not resolve", () => {
    expect(hostSource).toMatch(/const CODEX_WARMUP_MARKER = "\.tts-warmed";/);
    expect(hostSource).toMatch(/const codexHome = \(\) => process\.env\.CODEX_HOME \|\| path\.join\(os\.homedir\(\), "\.codex"\);/);
    expect(warm).toMatch(/const marker = path\.join\(codexHome\(\), CODEX_WARMUP_MARKER\);\s*\n\s*if \(fs\.existsSync\(marker\)\) return;/);
    expect(warm).toMatch(/if \(!resolveCodexBin\(\)\) \{[\s\S]*?return;/);
  });

  it("writes the marker on success only, on the cheap model at low effort, under the 60s cap", () => {
    expect(hostSource).toMatch(/const CODEX_WARMUP_TIMEOUT_MS = 60_000;/);
    expect(hostSource).toMatch(/const CODEX_WARMUP_MODEL = "gpt-5\.6-terra";/);
    expect(warm).toMatch(/codexArgs\(\{ cwd: dir, model: CODEX_WARMUP_MODEL, effort: "low" \}\)/);
    const success = between(warm, 'log("codex warm-up ok");', "} catch (err) {");
    expect(success).toMatch(/fs\.writeFileSync\(marker,/);
    // …and nowhere in the failure branches.
    const failures = between(warm, "if (outcome.spawnError) {", 'log("codex warm-up ok");');
    expect(failures).not.toMatch(/writeFileSync/);
  });
});

// Finding 5: the binary/spawn shim has one home.
describe("codex binary has one home (finding 5)", () => {
  it("session-host.mjs and codex-query.mjs import from codex-bin.mjs", () => {
    expect(hostSource).toMatch(/import \{ CODEX_BIN, codexArgs, resolveCodexBin, spawnCodex \} from "\.\/codex-bin\.mjs";/);
    expect(hostSource).not.toMatch(/process\.env\.CODEX_BIN/);
    expect(hostSource).not.toMatch(/function spawnCodex/);
    const query = read("codex-query.mjs");
    expect(query).toMatch(/import \{ CODEX_BIN, codexArgs, spawnCodex \} from "\.\/codex-bin\.mjs";/);
    expect(query).not.toMatch(/process\.env\.CODEX_BIN/);
    expect(query).not.toMatch(/from "node:child_process"/);
  });
});

// Ruling 15 (2026-09-05): a ruling from Tom's words is written by POST
// /tts/ruling with the id of the turn he typed. The daemon is where the model
// learns that id — a last line under every Tom-authored turn — and the
// prompt (app/lib/tts-session-prompt.ts) is where it is told to read it. The
// two must spell the label the same way, and the transcript row must keep
// Tom's text alone.
describe("a turn Tom typed carries its inbound row id to the model", () => {
  const promptSource = fs.readFileSync(
    path.join(here, "..", "..", "..", "app", "lib", "tts-session-prompt.ts"),
    "utf8",
  );
  it("deliveredTurnText appends the id only when author is tom", () => {
    const helper = between(sessionSource, "export function deliveredTurnText", "\n}\n");
    expect(helper).toMatch(/row\.author === "tom"/);
    expect(helper).toMatch(/\$\{INBOUND_ROW_LABEL\} \$\{row\._id\}/);
  });
  // witness: record row.text in finalizeRow instead of the delivered text.
  // The transcript principle: what the agent saw is what is recorded, so the
  // user row carries the id line the model received — through the same
  // cut-with-overflow path as every other payload, because the opening turn
  // is the mission prompt with the model-of-Tom files in front of it and the
  // model gets ALL of it.
  it("the delivery records, pushes, and dedupes the echo on the same delivered text", () => {
    const deliver = between(sessionSource, "async #deliverUserTurn(row)", "} catch (err) {");
    expect(deliver).toMatch(/const delivered = deliveredTurnText\(row\)/);
    expect(deliver).toMatch(/const cut = cutWithOverflow\(delivered\)/);
    expect(deliver).toMatch(/finalizeRow\(\s*"user",/);
    expect(deliver).toMatch(/text: cut\.value,/);
    expect(deliver).toMatch(/cut\.overflow,/);
    expect(deliver).not.toMatch(/finalizeRow\("user", \{ text: row\.text/);
    expect(deliver).toMatch(/this\.activeUserTurnText = delivered/);
    expect(deliver).toMatch(/this\.queue\.push\(delivered\)/);
  });
  it("the prompt names the same label and the same route", () => {
    const label = sessionSource.match(/export const INBOUND_ROW_LABEL = "([^"]+)"/)?.[1];
    expect(label).toBe("inbound row:");
    expect(promptSource).toMatch(new RegExp(`const INBOUND_ROW_LABEL = "${label}"`));
    expect(promptSource).toMatch(/\$CONVEX_SITE_URL\/tts\/ruling/);
    expect(promptSource).toMatch(/"inboundId"/);
  });
});

// witness: only the nightly sweep archived session files, so a transcript
// reached WikiTom up to a day after the session ended, and not at all on a
// night the job failed before step 3.
describe("a session's transcript is archived to WikiTom when it ends", () => {
  it("reaches the one home through the symlink, like worker-env", () => {
    expect(sessionSource).toMatch(/from "\.\/session-archive\.mjs";/);
    expect(fs.readlinkSync(path.join(here, "..", "session-archive.mjs"), "utf8").trim()).toBe(
      "../jobs/session-archive.mjs",
    );
    expect(fs.existsSync(path.join(here, "..", "..", "jobs", "session-archive.mjs"))).toBe(true);
  });

  it("every terminal path archives before it reports the end, under the lock, with a short wait", () => {
    const method = between(sessionSource, "async #archiveTranscript()", "async #endAutonomous(");
    expect(method).toMatch(/archiveSessionUnderLock\(\{/);
    expect(method).toMatch(/waitSeconds: ARCHIVE_LOCK_WAIT_SECONDS/);
    expect(sessionSource).toMatch(/const ARCHIVE_LOCK_WAIT_SECONDS = 120;/);
    // A failure is one system row and a log line, never a throw out of the end path.
    expect(method).toMatch(/\} catch \(err\) \{[\s\S]*finalizeRow\("system", \{\s*\n\s*text: `transcript not archived at session end/);
    for (const [start, end] of [
      ["async #endAutonomous(", "async #doInterrupt("],
      ["async #doStop(row)", "forceKill(reason)"],
      ['if (this.mode === "autonomous" && wasError) {', 'this.setStatus("idle");'],
    ]) {
      const body = between(sessionSource, start, end);
      const archiveAt = body.indexOf("await this.#archiveTranscript();");
      expect(archiveAt, `${start} archives`).toBeGreaterThan(-1);
      expect(body.indexOf('this.setStatus("ended")'), `${start} archives before ending`).toBeGreaterThan(archiveAt);
      expect(body.indexOf("await this.#preserveWork();"), `${start} preserves first`).toBeLessThan(archiveAt);
    }
  });
});
