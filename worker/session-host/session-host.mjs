#!/usr/bin/env node
// session-host.mjs — the TTS session-host daemon: runs real Claude Code
// sessions (via @anthropic-ai/claude-agent-sdk) and Codex CLI sessions
// (codex-query.mjs; the session row's model picks which) on the Jarvis Box
// and persists every event into tom.quest's Convex backend, which IS the
// message bus:
//
//   browser ──(claudeInbound rows / permission decisions)──▶ Convex
//   Convex  ◀──(poll + per-flush ingest, X-Sessions-Key)──── this daemon
//
// This file owns the poll loop and the Session map; the per-session work
// (SDK query, seq assignment, outbox/flush, permission gate) lives in
// session.mjs, shared helpers in lib.mjs. Runs under systemd
// (tts-session-host.service, Restart=always) — see README.md.
//
// THE NO-STATE RULE, applied: this process holds NOTHING durable. All state
// is pulled fresh from /sessions/poll every tick (full state, no cursors),
// so a restart — crash, deploy, kill -9 — is a non-event: live sessions are
// re-adopted as idle with an honest system row, and the next user turn
// resumes the SDK session by id.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  loadEnv,
  log,
  sleep,
  sessionsFetch,
  sessionsGet,
  mailboxNames,
  setEnvLine,
  backoffMs,
  truncated,
  ERROR_TEXT_LIMIT,
  scrubbedEnv,
} from "./lib.mjs";
import { Session, gitErrorText } from "./session.mjs";
import { FABLE_PROBE_INTERVAL_MS, fableProbeDue, readFableState } from "../runs/models.mjs";
import {
  CODEX_BIN,
  codexArgs,
  parseCodexRateLimits,
  resolveCodexBin,
  spawnCodex,
} from "./codex-bin.mjs";
import { planRow } from "./poll-plan.mjs";
import { launchRunnerStep } from "./runner-step.mjs";
import { DAEMON_RESTART_ENDED_REASON, listedCodexModels } from "./hosted.mjs";
import { reapUnlisted, removeOrphanWorkdirs, removeWorkdir } from "./workdir.mjs";
import { SECRETS_CHECK_MS, deliverSecrets, dropNames } from "./secret-mailbox.mjs";
import { POLL_IDLE_MS } from "./session-constants.mjs";

const VERSION = "0.3.0";
// Identifies THIS process lifetime to the server (claudeDaemonHealth) — a
// changed value is how the browser knows the daemon restarted.
const DAEMON_STARTED_AT = Date.now();

// Poll cadence (adaptive):
//   1s  — a turn is live (running) or something
//         happened in the last 30s: commands and decisions should feel
//         push-like (the ingest piggyback covers the mid-turn case; this
//         covers idle-but-warm).
//   5s  — live sessions exist but all quiet: cheap responsiveness.
//   30s — nothing live: pure heartbeat.
const POLL_HOT_MS = 1_000;
const POLL_WARM_MS = 5_000;
// The idle cadence, POLL_IDLE_MS, is imported: shared/session-constants.mjs
// defines it beside DAEMON_STALE_MS, the record's staleness threshold, which
// is three of these polls and derived from it there.
const HOT_WINDOW_MS = 30_000;

// Which Claude Max account the SDK runs under — the Jarvis Box's "active" symlink
// (managed by tts-account; CLAUDE_CONFIG_DIR in the systemd unit points at
// it). Reported to the server as a display fact only.
function readActiveAccount() {
  try {
    return path.basename(fs.readlinkSync("/root/.claude-accounts/active"));
  } catch {
    return undefined; // not a symlink / not set up — simply don't report
  }
}

// ── Codex on the box (ratified 2026-09-04) ───────────────────────────────────
// The binary, the spawn shim and the per-turn flags come from codex-bin.mjs
// (shared with the session runner). The daemon's own secrets are dropped
// from any Codex process this file spawns — the same scrub session.mjs
// applies to a session's shell, from the same list (env-scrub.mjs), for the
// same reason: the warm-up below runs a model with the sandbox off.
const codexEnv = () => scrubbedEnv();

// ONE warm-up `codex exec` per CODEX_HOME, in the background. Known upstream
// bug: a cold CODEX_HOME (no state DB yet, or one whose migrations have not
// run) loses thread rows when several `codex exec` processes start
// concurrently — exactly what the scheduler's fan-out does after a restart —
// and a lost thread row is a session that can never be resumed. One serial
// turn ("reply ok" on the cheap model, low effort) creates and migrates the
// DB; a marker file in CODEX_HOME then records that it is warm, so every
// later start skips the 60s a hung Codex could cost.
//
// It never runs BEFORE the first poll: the poll loop is the heartbeat, and
// holding it for up to a minute made the browser report the daemon dead on
// every restart. Instead the promise is exported through `codexReady` and
// claimSession awaits it before starting a CODEX session's query (a Claude
// session never waits) — so the fan-out still finds the DB warm, and only
// the Codex claims of the one cold start pay for it. Errors are LOGGED,
// never fatal, and leave no marker (the next start tries again): a box
// without Codex installed — the binary does not resolve, so nothing is
// spawned — or with an expired login still runs Claude sessions, and the
// first real Codex turn reports its own failure honestly.
const CODEX_WARMUP_TIMEOUT_MS = 60_000;
// The cheapest Codex model in SESSION_MODELS — the turn's one job is to
// touch the DB, not to think.
const CODEX_WARMUP_MODEL = "gpt-5.6-terra";
const CODEX_WARMUP_MARKER = ".tts-warmed";
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
let codexReady = Promise.resolve();

async function warmUpCodex() {
  const marker = path.join(codexHome(), CODEX_WARMUP_MARKER);
  if (fs.existsSync(marker)) return;
  if (!resolveCodexBin()) {
    log(`codex warm-up skipped: ${CODEX_BIN} is not installed`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-codex-warmup-"));
  try {
    const args = codexArgs({ cwd: dir, model: CODEX_WARMUP_MODEL, effort: "low" });
    const child = spawnCodex(args, {
      cwd: dir,
      env: codexEnv(),
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2048);
    });
    child.stdin.on("error", () => {});
    child.stdin.end("reply ok");
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve({ timedOut: true });
      }, CODEX_WARMUP_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ spawnError: err });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    if (outcome.spawnError) {
      log(`codex warm-up skipped: could not start ${CODEX_BIN}: ${outcome.spawnError.message}`);
    } else if (outcome.timedOut) {
      log(`codex warm-up timed out after ${CODEX_WARMUP_TIMEOUT_MS}ms (continuing)`);
    } else if (outcome.code !== 0) {
      log(`codex warm-up exited ${outcome.code ?? outcome.signal} (continuing):`, stderrTail.trim().slice(-500));
    } else {
      log("codex warm-up ok");
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
      } catch (err) {
        log(`codex warm-up marker ${marker} not written (next start warms again):`, String(err?.message ?? err));
      }
    }
  } catch (err) {
    log("codex warm-up failed (continuing):", String(err?.message ?? err));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Codex account usage for the heartbeat, read TOKEN-FREE: `codex app-server`
// is a JSON-RPC server over stdio, and account/rateLimits/read answers from
// the account's cached limits without spending a model call. The answer's
// result.rateLimits is parsed by parseCodexRateLimits (codex-bin.mjs, which
// says which window is which and why NOT by position). The scheduler gates
// new Codex sessions on the weekly figure (CODEX_WEEKLY_CAP_PERCENT in
// ttsShared); the 5-hour one is recorded only, and absent when the account
// reports no such window.
//
// At most once per 5 minutes, in the BACKGROUND: refreshCodexUsage starts a
// read and returns at once, so a hung app-server never holds the poll loop
// (it used to — 15s of no heartbeat per stuck read); the reading rides the
// NEXT heartbeat. The last SUCCESSFUL reading, with its ORIGINAL readAt,
// rides every heartbeat until a later read succeeds — a failed read never
// blanks it, because the server judges staleness from readAt itself
// (CODEX_USAGE_STALE_MS in ttsShared: older than 15 minutes reads as
// unknown, and unknown admits). Nothing is sent only while no read has ever
// succeeded. After a failure the next attempt waits twice as long as the
// last, capped at 30 minutes, so a box without Codex is not spawning it
// every 5 minutes forever.
const CODEX_USAGE_INTERVAL_MS = 5 * 60 * 1000;
const CODEX_USAGE_BACKOFF_CAP_MS = 30 * 60 * 1000;
const CODEX_USAGE_TIMEOUT_MS = 15_000;
let codexUsage; // { weeklyUsedPercent, fiveHourUsedPercent?, weeklyResetsAt?, readAt }
let codexUsageNextAt = 0; // earliest start of the next read
let codexUsageFailures = 0; // consecutive failures — the backoff exponent
let codexUsageInFlight = false; // two reads never overlap
let codexUsageWarned = false; // log the failure ONCE, not on every retry

async function readCodexUsage() {
  const child = spawnCodex(["app-server"], {
    env: codexEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  child.stdin.on("error", () => {
    // The child died before reading a request; the close handler below
    // rejects with the story (same handler the sibling spawns carry).
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`app-server did not answer within ${CODEX_USAGE_TIMEOUT_MS}ms`)),
      CODEX_USAGE_TIMEOUT_MS,
    );
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${CODEX_BIN}: ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error("app-server exited before answering"));
    });
    lines.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error) {
          clearTimeout(timer);
          reject(new Error(`initialize: ${JSON.stringify(msg.error).slice(0, 200)}`));
          return;
        }
        send({ jsonrpc: "2.0", method: "initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
      } else if (msg.id === 2) {
        clearTimeout(timer);
        if (msg.error) {
          reject(new Error(`account/rateLimits/read: ${JSON.stringify(msg.error).slice(0, 200)}`));
        } else {
          resolve(msg.result);
        }
      }
    });
  });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "tts-session-host", title: "TTS session-host", version: VERSION },
    },
  });
  try {
    const result = await done;
    return {
      ...parseCodexRateLimits(result?.rateLimits),
      readAt: Date.now(),
    };
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

// Start a read when one is due and none is running; returns at once (the
// header above says why). Never throws.
function refreshCodexUsage() {
  const now = Date.now();
  if (codexUsageInFlight || now < codexUsageNextAt) return;
  codexUsageInFlight = true;
  void (async () => {
    try {
      // The model list first and on its own: a usage read that fails must not
      // leave the orchestrator's model unknowable.
      try {
        codexModels = await readCodexModels();
      } catch (err) {
        log("codex model list read failed (continuing):", String(err?.message ?? err));
      }
      codexUsage = await readCodexUsage();
      codexUsageFailures = 0;
      codexUsageWarned = false;
      codexUsageNextAt = Date.now() + CODEX_USAGE_INTERVAL_MS;
    } catch (err) {
      codexUsageFailures += 1;
      const wait = Math.min(
        CODEX_USAGE_BACKOFF_CAP_MS,
        CODEX_USAGE_INTERVAL_MS * 2 ** codexUsageFailures,
      );
      codexUsageNextAt = Date.now() + wait;
      if (!codexUsageWarned) {
        codexUsageWarned = true;
        log(
          `codex usage read failed (${codexUsage ? "heartbeat keeps the last reading" : "heartbeat carries none until a read succeeds"}; retrying in ${Math.round(wait / 60_000)}m, then backing off):`,
          String(err?.message ?? err),
        );
      }
    } finally {
      codexUsageInFlight = false;
    }
  })();
}

// The model slugs the box's Codex CLI lists, for the heartbeat: the server
// picks the orchestrator's model from them (Astra when listed, Tom
// 2026-09-21; convex/orchestrator.ts orchestratorModel). `codex debug models`
// prints the raw catalog without a model call. Read with the usage, on the
// same cadence and in the background; an empty list means the CLI is not
// installed, and absent means no read has finished yet.
const CODEX_MODELS_TIMEOUT_MS = 15_000;
let codexModels; // string[] | undefined

async function readCodexModels() {
  if (!resolveCodexBin()) return [];
  const child = spawnCodex(["debug", "models"], { env: codexEnv(), stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error(`codex debug models did not answer within ${CODEX_MODELS_TIMEOUT_MS}ms`));
    }, CODEX_MODELS_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`codex debug models exited ${code}`));
    });
  });
  return listedCodexModels(out);
}

// ── the Fable probe (Tom's ruling, 2026-09-24) ───────────────────────────────
// "make sure that the opus ceiling is temporary and we switch back to fable
// when my weekly limit resets." While the Fable availability file
// (worker/runs/models.mjs) says Fable is unavailable, a request for Fable runs
// Opus. This is what lifts it: at most once an hour, in the BACKGROUND beside
// the Codex usage read, one Fable call of one turn and one word through the
// launcher (box-run.mjs probeFable), recorded like any run. An account out of
// usage refuses without a model call; an answer sets Fable available, and the
// next Fable request runs Fable. The reset date never has to be known: the
// CLI's refusal names a monthly spend limit, Tom's ruling a weekly limit, and
// the probe finds out either way.
//
// The file's own checkedAt is the hourly clock, so a daemon restart does not
// probe early; fableProbeNextAt is the same hour kept in memory, so a probe
// that fails before it can write the file is not retried on every poll.
let fableProbeInFlight = false;
let fableProbeNextAt = 0;

function fableStateDir() {
  return process.env.RUN_SWEEP_STATE_DIR || "/var/cache/tts/runs";
}

// Start a probe when one is due and none is running; returns at once. Never
// throws.
function refreshFableProbe() {
  const now = Date.now();
  if (fableProbeInFlight || now < fableProbeNextAt) return;
  if (!fableProbeDue(readFableState(fableStateDir()), now)) return;
  fableProbeInFlight = true;
  fableProbeNextAt = now + FABLE_PROBE_INTERVAL_MS;
  void (async () => {
    try {
      const { probeFable } = await boxRunner();
      const state = await probeFable({ env: { ...process.env, RUN_SWEEP_STATE_DIR: fableStateDir() } });
      log(state.available
        ? "fable probe: Fable answered; a request for Fable runs Fable again"
        : `fable probe: Fable is still unavailable (${state.reason ?? "no reason given"})`);
    } catch (err) {
      log("fable probe failed:", String(err?.message ?? err));
    } finally {
      fableProbeInFlight = false;
    }
  })();
}

/** The Fable availability state for the heartbeat, or undefined while none
 *  is recorded (an absent file reads as available, and says nothing new). */
function fableAvailabilityReport() {
  const state = readFableState(fableStateDir());
  if (!Number.isFinite(state.since) || !Number.isFinite(state.checkedAt)) return undefined;
  return {
    available: state.available,
    since: state.since,
    checkedAt: state.checkedAt,
    ...(typeof state.reason === "string" && state.reason !== "" ? { reason: state.reason } : {}),
  };
}

// ── usage limits, recorded ───────────────────────────────────────────────────
// A Claude session that hits a usage limit other than a Fable refusal (which
// session.mjs turns into the model ceiling) is recorded here and nothing
// else: the latest one rides every heartbeat as `usageLimit`, and the session
// itself waits (interactive) or ends errored (autonomous) through its own
// turn-failure path. The box stays on the active account. Tom's ruling,
// 2026-09-24, verbatim: "lets keep the box on my wpi claude account even
// though it is out of fable usage and have it max out at opus for now. even
// for delegate. I want to save my usage for my heffnt account for personal
// use." The account switch that stood here spent the other account on any
// limit, so it is gone; `tts-account use` is Tom's to run by hand.
let lastUsageLimit; // { at, text, sessionId } — the latest, kept until replaced

function recordUsageLimit(text, session) {
  lastUsageLimit = { at: Date.now(), text: String(text).slice(0, 200), sessionId: session.id };
  log(`session ${session.id}: usage limit (${lastUsageLimit.text}); recorded on the heartbeat, account unchanged`);
}

// Fail a session outright — the one class of ending with nothing to resume
// into: a clone that never landed, or a Session this daemon could not bring
// up (the poll walk's fence below). endedReason carries the error, capped at
// 8KB (review fix: unbounded error text — git runs with an 8MB maxBuffer,
// far past Convex's document cap).
function failSession(s, err) {
  const msg = truncated(gitErrorText(err), ERROR_TEXT_LIMIT).value;
  s.finalizeRow("error", { message: msg });
  s.setStatus("failed");
  s.endedReasonToSend = msg;
  s.requestFlush(true);
  s.cleanupWorkdir();
  return msg;
}

// ── claim: a browser-created session ("requested") becomes a live one ────────
// The sync prefix (constructing the Session and putting it in the map)
// happens before any await, so a poll tick during the async tail can never
// double-claim.
function claimSession(env, sessions, row) {
  const s = new Session({
    id: row.id,
    repo: row.repo,
    repos: row.repos,
    env,
    nextSeq: row.nextSeq,
    mode: row.mode,
    // The model name (ttsShared SESSION_MODELS) picks the runner; forkedFrom
    // is the session whose transcript this one continues ("reopen as").
    model: row.model,
    forkedFrom: row.forkedFrom,
    // "orchestrator" or "worker" on a row this daemon HOSTS (hosted.mjs).
    environment: row.environment,
    // The reopen generation this Session speaks for: stamped into every ingest
    // so the server can tell a live flush from a pre-reopen replay.
    reopenEpoch: row.reopenEpoch ?? 0,
    onUsageSignal: recordUsageLimit,
  });
  sessions.set(row.id, s);
  void (async () => {
    s.statusToSend = "starting";
    s.requestFlush(true);
    try {
      await s.ensureWorkdir();
    } catch (err) {
      // A stop/force-close that landed mid-clone already settled the session
      // (and likely caused this failure by deleting the dir) — don't
      // overwrite its verdict.
      if (s.dead || s.status === "ended") return;
      // Clone/setup failed — the one class of error that fails a session
      // outright (there is nothing to resume into).
      log(`session ${row.id}: workdir setup failed:`, failSession(s, err));
      return;
    }
    // A Codex session waits for the warm-up (see warmUpCodex: the fan-out
    // after a cold start must find the state DB migrated); a resolved
    // promise on every warm start, so this costs nothing then.
    if (s.family === "codex") await codexReady;
    // Re-check after the slow await (review fix: claim-vs-stop race) — a stop
    // arriving mid-clone has already ended the session and deleted the
    // workdir; starting a query now would resurrect a session the server
    // considers over.
    if (s.dead || s.status === "ended" || s.status === "failed") {
      s.cleanupWorkdir(); // the clone may have re-created the dir mid-teardown
      return;
    }
    try {
      s.startQuery();
      // Hand over the poll row we claimed from: its pendingInbound holds the
      // initial prompt; the init handler (or delivery-from-starting) takes it
      // from here.
      s.processServerState(row);
    } catch (err) {
      // An unhandled throw here would be an unhandled rejection — which
      // takes the whole process down, every other live session with it.
      // Same ending as a failed clone: nothing to resume into.
      if (s.dead || s.status === "ended" || s.status === "failed") return;
      log(`session ${row.id}: could not start:`, failSession(s, err));
    }
  })();
}

// ── adopt: a live session this daemon holds no local Session for ─────────────
// Two different histories arrive here identically. (1) A previous daemon died
// while the session was live: never auto-resume into a running turn (the turn's
// context is gone with the old process); park the session idle with an honest
// system row. (2) Tom REOPENED an ended session: the row went terminal→idle
// server-side, so it is simply live again — no restart happened and no turn was
// interrupted, and row.reopenedAt is the one fact that says so. Either way the
// NEXT user turn resumes the SDK session by sdkSessionId — validated to survive
// even kill -9 with context intact.
function adoptSession(env, sessions, row) {
  const s = new Session({
    id: row.id,
    repo: row.repo,
    repos: row.repos,
    env,
    nextSeq: row.nextSeq,
    mode: row.mode,
    model: row.model,
    forkedFrom: row.forkedFrom,
    environment: row.environment,
    reopenEpoch: row.reopenEpoch ?? 0,
    onUsageSignal: recordUsageLimit,
  });
  sessions.set(row.id, s);
  s.sdkSessionId = row.sdkSessionId;
  const reopened = row.reopenedAt !== undefined && row.reopenedAt !== null;
  if (row.mode === "autonomous") {
    // Park-idle-await-next-turn is an interactive invariant — an autonomous
    // session has no Tom to send that turn, so an adopted one would sit live
    // forever (counted against the fleet cap, its todo excluded). End it
    // errored; the scheduler's backoff owns the retry. The outcome rides the
    // ingest and never overwrites one the agent already recorded. A HOSTED
    // run ends the same way: nothing re-enters a run whose turn died with the
    // old process. The server restarts the orchestrator from its document and
    // tells the orchestrator a worker of its ended (convex/orchestrator.ts).
    s.finalizeRow("system", {
      text: "session-host restarted mid-mission; autonomous session ended",
    });
    void s.endAdopted(DAEMON_RESTART_ENDED_REASON, {
      outcome: "errored",
      outcomeSummary: "daemon restarted mid-mission",
    });
    return;
  }
  s.status = "idle";
  s.statusToSend = "idle";
  if (!reopened) {
    s.finalizeRow("system", {
      text: "session-host restarted; previous turn interrupted",
    });
  }
  // A reopen writes NO row: the transcript already carries the honest ending
  // record, and Tom's reopening turn lands right after it — an adoption note
  // would describe daemon bookkeeping, not anything that happened in the
  // conversation.
  // NOTE: a user-turn that was DELIVERED mid-turn when the old daemon died
  // should read "interrupted", but /sessions/poll carries only PENDING
  // inbound rows, so it cannot be reached from here — the restart row above
  // is the transcript's honest record of what happened to that turn. (A
  // reopen has no such turn: the session had already ended.)
  s.requestFlush(true);
  // Decisions/commands already queued server-side (including any pending
  // user-turn, which will trigger the resume).
  s.processServerState(row);
}

// ── runner steps: launched through the box's one launcher ────────────────────
// A runner step is not a session (runner-step.mjs says what it is). It runs
// through box-run.mjs, imported on first use so a daemon on a box whose
// /opt/tts/runs is missing still runs every session. `../runs/box-run.mjs`
// resolves to worker/runs in a checkout and to /opt/tts/runs installed.
let boxRunModule = null;
async function boxRunner() {
  boxRunModule ??= await import("../runs/box-run.mjs");
  return boxRunModule;
}
let sensorModule = null;
async function sensor() {
  sensorModule ??= await import("../runs/runner-sensor.mjs");
  return sensorModule;
}

function launchStep(env, steps, row) {
  return launchRunnerStep(steps, row, {
    post: (route, body) => sessionsFetch(env, route, body),
    run: async (options) => {
      const { boxRun, TOOLS_ALLOWED, BANNED_TOOLS } = await boxRunner();
      return boxRun({ ...options, allowedTools: [...TOOLS_ALLOWED], deniedTools: [...BANNED_TOOLS] });
    },
    log,
    sense: async (input) => (await sensor()).sense(input),
    renderFacts: (facts) => sensorModule.renderFacts(facts),
    env: process.env,
  });
}

// ── tom.quest/secrets: values Tom pasted, written into the env file ──────────
// secret-mailbox.mjs holds the steps. Here: at most one check per
// SECRETS_CHECK_MS, in the background with one in flight, so a slow Convex
// never holds the heartbeat. A delivered name never enters this process's
// environment, so no child started later inherits it; whatever needs it reads
// the env file by name.
let secretsNextAt = 0;
let secretsInFlight = false;

function checkSecrets(env) {
  const now = Date.now();
  if (secretsInFlight || now < secretsNextAt) return;
  secretsInFlight = true;
  secretsNextAt = now + SECRETS_CHECK_MS;
  void deliverSecrets({
    fetchPending: () => sessionsGet(env, "/sessions/secrets"),
    write: (name, value) => setEnvLine({ name, value }),
    markTaken: (name, setAt) => sessionsFetch(env, "/sessions/secrets/taken", { name, setAt }),
    log,
  }).finally(() => {
    secretsInFlight = false;
  });
}

// ── the main loop ────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  // Before anything is spawned: systemd loaded the whole env file into this
  // process, the names in the /secrets block included, and every child
  // inherits process.env. They leave it here (secret-mailbox.mjs dropNames).
  const delivered = mailboxNames();
  dropNames(process.env, delivered);
  dropNames(env, delivered);
  log(`starting session-host v${VERSION} -> ${env.CONVEX_SITE_URL}`);
  // In the background, never ahead of the first poll (the heartbeat must not
  // wait on Codex); Codex claims await codexReady instead — see warmUpCodex.
  codexReady = warmUpCodex();
  const sessions = new Map(); // sessionId -> Session
  const runnerSteps = new Map(); // runnerSteps id -> the launch in flight
  let pollAttempt = 0;
  // Rows the walk could not act on, logged once each (a fork whose source is
  // still live; a row this daemon cannot construct a Session for) — cleared
  // when the row leaves the poll, so a later change is reported again.
  const notedRows = new Set();
  let orphansRemoved = false;

  for (;;) {
    refreshCodexUsage(); // starts a read when due; never waits on it
    refreshFableProbe(); // the same, for the Fable probe
    checkSecrets(env); // the same: a mailbox check when due, never awaited
    const fableAvailability = fableAvailabilityReport();
    // Surface the most recent permanent ingest rejection (review fix:
    // permanent-400 wedge) — a dropped flush must be visible server-side, not
    // only in journald. One report is enough: cleared after the poll that
    // carries it (kept for retry if the poll itself fails).
    let lastIngestError;
    let lastIngestErrorAt = -1;
    for (const [id, s] of sessions) {
      if (s.lastIngestError !== undefined && s.lastIngestErrorAt > lastIngestErrorAt) {
        lastIngestErrorAt = s.lastIngestErrorAt;
        lastIngestError = `${id}: ${s.lastIngestError}`;
      }
    }

    let data;
    // When this poll was sent: an idle hosted run decides nothing on facts
    // older than the end of its own last turn (hostedIdleVerdict).
    const polledAt = Date.now();
    try {
      data = await sessionsFetch(env, "/sessions/poll", {
        version: `session-host/${VERSION}`,
        daemonStartedAt: DAEMON_STARTED_AT,
        activeAccount: readActiveAccount(),
        // Jarvis Box load facts — the auto-session scheduler's admission signal
        // (load-based, not a scalar session cap): loadavg + free RAM decide
        // whether the Jarvis Box can take another session.
        load: {
          loadavg1: os.loadavg()[0],
          cpus: os.cpus().length,
          freeMemMb: Math.round(os.freemem() / 1048576),
          totalMemMb: Math.round(os.totalmem() / 1048576),
          liveSessions: sessions.size,
        },
        // Codex account usage — the last successful reading with its own
        // readAt (see refreshCodexUsage); absent only while no read has ever
        // succeeded, which the server reads as unknown, like a stale readAt.
        ...(codexUsage !== undefined ? { codexUsage } : {}),
        ...(codexModels !== undefined ? { codexModels } : {}),
        // The Fable availability file (worker/runs/models.mjs), for the pages
        // that show whether the ceiling is in force; absent while none is
        // recorded.
        ...(fableAvailability !== undefined ? { fableAvailability } : {}),
        // The latest usage limit a Claude session hit that was not a Fable
        // refusal (recordUsageLimit); absent until one happens.
        ...(lastUsageLimit !== undefined ? { usageLimit: lastUsageLimit } : {}),
        ...(lastIngestError !== undefined ? { lastIngestError } : {}),
        // This daemon hosts orchestrator and worker rows (hosted.mjs). A
        // daemon that does not say so is never shown one, so an old copy on
        // the box never ends a hosted run after its first turn.
        hosts: ["orchestrator", "worker"],
        // The sessions this process holds. The orchestrator's lease is renewed
        // only while its run is in this list.
        held: [...sessions].filter(([, s]) => !s.dead && s.status !== "ended" && s.status !== "failed").map(([id]) => String(id)),
      });
      pollAttempt = 0;
      if (lastIngestError !== undefined) {
        for (const s of sessions.values()) s.lastIngestError = undefined;
      }
    } catch (err) {
      pollAttempt += 1;
      const delay = backoffMs(pollAttempt);
      log(
        `poll failed (attempt ${pollAttempt}, retry in ${delay}ms):`,
        String(err?.message ?? err),
      );
      await sleep(delay);
      continue;
    }

    const listed = new Set();
    // Every id in this poll — the poll lists only LIVE sessions, so "the
    // fork's source is still listed" means it has not ended yet.
    const liveIds = new Set((data.sessions ?? []).map((row) => String(row.id)));
    for (const row of data.sessions ?? []) {
      listed.add(row.id);
      row.polledAt = polledAt;
      const local = sessions.get(row.id);
      // The whole per-row walk is fenced: one row this daemon cannot handle
      // (a shape the server grew before the box was redeployed — an unknown
      // model name once crash-looped it, every OTHER live session dying with
      // each restart) must never take the loop down. A Session that was
      // built in this poll and then broke is failed through the same path a
      // clone failure takes, so the row goes terminal server-side instead of
      // being re-claimed every tick; a row that never got that far is logged
      // once and left alone; a known live session keeps running and the next
      // poll reconciles it again.
      try {
        switch (planRow(row, { local, liveIds })) {
          case "wait":
            break;
          case "readopt":
            // A local we consider OVER, listed live again: Tom reopened it
            // inside the window between our ending flush landing and the
            // reap below deleting the entry. The stale local shadows
            // everything — its processServerState and processCommands both
            // early-return on a terminal status, and the reaper skips any
            // listed id — so without this the reopening turn is never
            // delivered and the session wedges "idle" forever. (planRow
            // answers "wait" while a not-yet-drained flush finishes first —
            // its final rows still belong in the transcript.)
            sessions.delete(row.id);
            log(`re-adopting reopened session ${row.id} (local was ${local.status})`);
            adoptSession(env, sessions, row);
            break;
          case "reconcile":
            // Known session: decisions, commands, defensive seq.
            local.processServerState(row);
            break;
          case "defer-fork":
            // The source's transcript must be complete before the fork
            // snapshots it (session.mjs #writeForkTranscript); the source
            // leaves the poll when its stop lands and it ends.
            if (!notedRows.has(row.id)) {
              notedRows.add(row.id);
              log(`fork ${row.id} of ${row.forkedFrom} waits for its source to end`);
            }
            break;
          case "claim":
            // Fresh session — or one a previous daemon died on before the SDK
            // ever reported an id (nothing to resume; start over cleanly).
            log(
              `claiming session ${row.id} (model ${row.model ?? "opus"}; repos: ${(row.repos ?? [row.repo]).join(", ") || "none"})`,
            );
            claimSession(env, sessions, row);
            break;
          case "adopt":
            log(
              row.reopenedAt
                ? `adopting session ${row.id} after a reopen (status ${row.status})`
                : `adopting session ${row.id} after restart (status was ${row.status})`,
            );
            adoptSession(env, sessions, row);
            break;
        }
      } catch (err) {
        const s = sessions.get(row.id);
        if (s && s !== local && !s.dead && s.status !== "ended" && s.status !== "failed") {
          log(`session ${row.id}: could not be brought up — failed:`, failSession(s, err));
        } else if (!notedRows.has(row.id)) {
          notedRows.add(row.id);
          log(
            `session ${row.id}: poll handling threw (row skipped; logged once):`,
            String(err?.stack ?? err?.message ?? err),
          );
        }
      }
    }
    for (const id of notedRows) {
      if (!listed.has(id)) notedRows.delete(id);
    }

    // Runner steps due now: one more array on the same payload, one more
    // branch in the same walk. Each launch is fenced like a session row: one
    // step this daemon cannot handle never takes the loop down.
    for (const row of data.runnerSteps ?? []) {
      try {
        launchStep(env, runnerSteps, row);
      } catch (err) {
        log(`runner step ${row.stepId}: could not be launched:`, String(err?.message ?? err));
      }
    }

    // Locals the server no longer lists are terminal server-side; the reap
    // drops each and deletes its workdir (workdir.mjs says why here).
    reapUnlisted(sessions, listed, { remove: (id) => removeWorkdir(id, { log }) });

    // The endings no process observed: once, on this daemon's first poll.
    if (!orphansRemoved) {
      orphansRemoved = true;
      const known = new Set([...listed, ...sessions.keys()].map(String));
      const removed = removeOrphanWorkdirs({ known, remove: (id) => removeWorkdir(id, { log }) });
      if (removed.length > 0) {
        log(`removed ${removed.length} workdirs of sessions that ended while no daemon ran`);
      }
    }

    // Adaptive cadence (quiet in logs on purpose — journald noise is not
    // observability; the server-side heartbeat is).
    let delay = sessions.size > 0 ? POLL_WARM_MS : POLL_IDLE_MS;
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.dead) continue; // a dead session's lastActivityAt must not pin 1s
      if (s.status === "running" || now - s.lastActivityAt < HOT_WINDOW_MS) {
        delay = POLL_HOT_MS;
        break;
      }
    }
    await sleep(delay);
  }
}

main().catch((err) => {
  // Should be unreachable (the loop swallows everything) — but if it ever
  // trips, exit nonzero and let systemd's Restart=always bring us back.
  log("fatal:", err);
  process.exit(1);
});
