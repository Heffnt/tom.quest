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
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  loadEnv,
  log,
  sleep,
  sessionsFetch,
  backoffMs,
  truncated,
  ERROR_TEXT_LIMIT,
  scrubbedEnv,
} from "./lib.mjs";
import { Session, gitErrorText } from "./session.mjs";
import { CODEX_BIN, codexArgs, resolveCodexBin, spawnCodex } from "./codex-bin.mjs";
import { planRow } from "./poll-plan.mjs";

const VERSION = "0.3.0";
// Identifies THIS process lifetime to the server (claudeDaemonHealth) — a
// changed value is how the browser knows the daemon restarted.
const DAEMON_STARTED_AT = Date.now();

// Poll cadence (adaptive):
//   1s  — a turn is live (running / awaiting-permission) or something
//         happened in the last 30s: commands and decisions should feel
//         push-like (the ingest piggyback covers the mid-turn case; this
//         covers idle-but-warm).
//   5s  — live sessions exist but all quiet: cheap responsiveness.
//   30s — nothing live: pure heartbeat.
const POLL_HOT_MS = 1_000;
const POLL_WARM_MS = 5_000;
// CONTRACT: idle poll 30s; the server/client staleness threshold is 90s =
// 3 missed idle polls — if you change this cadence, change DAEMON_STALE_MS in
// convex/ttsShared.ts (its one home; claudeSessions.ts and app/sessions/lib.ts
// re-export from there) with it.
const POLL_IDLE_MS = 30_000;
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

const execFile = promisify(execFileCb);

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
// the account's cached limits without spending a model call. Verified against
// codex-cli 0.130 on 2026-09-04: result.rateLimits.primary is the 5-hour
// window (windowDurationMins 300) and .secondary the weekly one (10080), each
// { usedPercent, windowDurationMins, resetsAt } with resetsAt in EPOCH
// SECONDS. The scheduler gates new Codex sessions on the weekly figure
// (CODEX_WEEKLY_CAP_PERCENT in ttsShared); the 5-hour one is recorded only.
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
let codexUsage; // { weeklyUsedPercent, fiveHourUsedPercent, weeklyResetsAt?, readAt }
let codexUsageNextAt = 0; // earliest start of the next read
let codexUsageFailures = 0; // consecutive failures — the backoff exponent
let codexUsageInFlight = false; // two reads never overlap
let codexUsageWarned = false; // log the failure ONCE, not on every retry

function toEpochMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? value * 1000 : value; // seconds → ms
}

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
    const limits = result?.rateLimits;
    const weekly = limits?.secondary;
    const fiveHour = limits?.primary;
    if (typeof weekly?.usedPercent !== "number" || typeof fiveHour?.usedPercent !== "number") {
      throw new Error(`unexpected rateLimits shape: ${JSON.stringify(limits).slice(0, 200)}`);
    }
    const weeklyResetsAt = toEpochMs(weekly.resetsAt);
    return {
      weeklyUsedPercent: weekly.usedPercent,
      fiveHourUsedPercent: fiveHour.usedPercent,
      ...(weeklyResetsAt !== undefined ? { weeklyResetsAt } : {}),
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

// ── usage-limit account auto-switch (ratified 2026-08-28) ────────────────────
// A session that hits a usage/rate limit signals here; the daemon flips the
// active symlink to the OTHER Max account via tts-account so the fleet (and
// Tom) keep working, at most once per 3h (in-memory throttle — a restart
// resets it, harmlessly). Tradeoff, stated: NEW queries run under the new
// account; existing sdkSessionIds live in the old account's config dir, so a
// resume after a switch starts fresh context — the restart-adoption rules
// already record that honestly in the transcript.
const SWITCH_THROTTLE_MS = 3 * 60 * 60 * 1000;
let lastAccountSwitchAt = 0;

async function maybeSwitchAccount(signalText, session) {
  const now = Date.now();
  if (now - lastAccountSwitchAt < SWITCH_THROTTLE_MS) return;
  const active = readActiveAccount();
  if (active !== "gmail" && active !== "wpi") {
    log(`usage limit signaled but active account unknown (${active}) — not switching`);
    return;
  }
  lastAccountSwitchAt = now;
  const other = active === "gmail" ? "wpi" : "gmail";
  try {
    await execFile("/usr/local/bin/tts-account", ["use", other]);
    log(`usage limit detected — switched account ${active} -> ${other} (${signalText})`);
    session?.finalizeRow("system", {
      text: `usage limit detected — switched account ${active} -> ${other}`,
    });
    session?.requestFlush(true);
  } catch (err) {
    lastAccountSwitchAt = 0; // the switch didn't happen; don't throttle a retry
    log(`account switch ${active} -> ${other} FAILED:`, String(err?.message ?? err));
  }
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
    // The reopen generation this Session speaks for: stamped into every ingest
    // so the server can tell a live flush from a pre-reopen replay.
    reopenEpoch: row.reopenEpoch ?? 0,
    onUsageSignal: (text, session) => void maybeSwitchAccount(text, session),
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
    reopenEpoch: row.reopenEpoch ?? 0,
    onUsageSignal: (text, session) => void maybeSwitchAccount(text, session),
  });
  sessions.set(row.id, s);
  s.sdkSessionId = row.sdkSessionId;
  const reopened = row.reopenedAt !== undefined && row.reopenedAt !== null;
  if (row.mode === "autonomous") {
    // Park-idle-await-next-turn is an interactive invariant — an autonomous
    // session has no Tom to send that turn, so an adopted one would sit live
    // forever (counted against the fleet cap, its todo excluded). End it
    // errored; the scheduler's backoff owns the retry. The outcome rides the
    // ingest and never overwrites one the agent already recorded.
    s.finalizeRow("system", {
      text: "session-host restarted mid-mission; autonomous session ended",
    });
    s.outcomeToSend = {
      outcome: "errored",
      outcomeSummary: "daemon restarted mid-mission",
    };
    s.setStatus("ended");
    s.endedReasonToSend = "daemon restarted mid-mission";
    s.requestFlush(true);
    s.cleanupWorkdir();
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
  for (const p of row.permissions ?? []) {
    if (p.status === "pending") {
      // A permission card nobody can answer anymore — expire it explicitly
      // (never leave Tom staring at a dead card).
      s.outbox.permissionUpdates.push({
        requestId: p.requestId,
        status: "expired",
        // Say which of the two adoptions expired it; "daemon-restart" on a
        // reopen would be a fabricated cause.
        decidedBy: reopened ? "session-reopen" : "daemon-restart",
      });
    } else if (
      (p.status === "allowed" || p.status === "denied") &&
      (p.appliedAt === undefined || p.appliedAt === null)
    ) {
      // Decided while no daemon was listening — the prompting turn is gone,
      // so the decision is unactionable; ack applied to clear the queue.
      s.outbox.permissionUpdates.push({ requestId: p.requestId, applied: true });
    }
  }
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

// ── the main loop ────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  log(`starting session-host v${VERSION} -> ${env.CONVEX_SITE_URL}`);
  // In the background, never ahead of the first poll (the heartbeat must not
  // wait on Codex); Codex claims await codexReady instead — see warmUpCodex.
  codexReady = warmUpCodex();
  const sessions = new Map(); // sessionId -> Session
  let pollAttempt = 0;
  // Rows the walk could not act on, logged once each (a fork whose source is
  // still live; a row this daemon cannot construct a Session for) — cleared
  // when the row leaves the poll, so a later change is reported again.
  const notedRows = new Set();

  for (;;) {
    refreshCodexUsage(); // starts a read when due; never waits on it
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
        ...(lastIngestError !== undefined ? { lastIngestError } : {}),
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

    // Locals the server no longer lists are terminal server-side: either our
    // own ended/failed report landed (reap once the outbox drains) or the
    // browser force-closed a session it thought orphaned (kill the process —
    // the server's word is final).
    for (const [id, s] of sessions) {
      if (listed.has(id)) continue;
      if (s.dead) {
        // Review fix: force-killed sessions were never drained (their outbox
        // is dropped, not flushed), so waiting on isDrained() leaked the map
        // entry forever. Dead means gone — delete unconditionally.
        sessions.delete(id);
      } else if (s.status === "ended" || s.status === "failed") {
        if (s.isDrained()) sessions.delete(id);
      } else {
        s.forceKill("server no longer lists this session");
        sessions.delete(id);
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
