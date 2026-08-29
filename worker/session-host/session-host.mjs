#!/usr/bin/env node
// session-host.mjs — the DTS session-host daemon: runs real Claude Code
// sessions (via @anthropic-ai/claude-agent-sdk) on this box and persists
// every event into tom.quest's Convex backend, which IS the message bus:
//
//   browser ──(claudeInbound rows / permission decisions)──▶ Convex
//   Convex  ◀──(poll + per-flush ingest, X-Sessions-Key)──── this daemon
//
// This file owns the poll loop and the Session map; the per-session work
// (SDK query, seq assignment, outbox/flush, permission gate) lives in
// session.mjs, shared helpers in lib.mjs. Runs under systemd
// (dts-session-host.service, Restart=always) — see README.md.
//
// THE NO-STATE RULE, applied: this process holds NOTHING durable. All state
// is pulled fresh from /sessions/poll every tick (full state, no cursors),
// so a restart — crash, deploy, kill -9 — is a non-event: live sessions are
// re-adopted as idle with an honest system row, and the next user turn
// resumes the SDK session by id.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
} from "./lib.mjs";
import { Session, gitErrorText } from "./session.mjs";

const VERSION = "0.2.0";
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
// convex/claudeSessions.ts and app/sessions/lib.ts with it.
const POLL_IDLE_MS = 30_000;
const HOT_WINDOW_MS = 30_000;

// Which Claude Max account the SDK runs under — the box's "active" symlink
// (managed by dts-account; CLAUDE_CONFIG_DIR in the systemd unit points at
// it). Reported to the server as a display fact only.
function readActiveAccount() {
  try {
    return path.basename(fs.readlinkSync("/root/.claude-accounts/active"));
  } catch {
    return undefined; // not a symlink / not set up — simply don't report
  }
}

const execFile = promisify(execFileCb);

// ── usage-limit account auto-switch (ratified 2026-08-28) ────────────────────
// A session that hits a usage/rate limit signals here; the daemon flips the
// active symlink to the OTHER Max account via dts-account so the fleet (and
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
    await execFile("/usr/local/bin/dts-account", ["use", other]);
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

// ── claim: a browser-created session ("requested") becomes a live one ────────
// The sync prefix (constructing the Session and putting it in the map)
// happens before any await, so a poll tick during the async tail can never
// double-claim.
function claimSession(env, sessions, row) {
  const s = new Session({
    id: row.id,
    repo: row.repo,
    env,
    nextSeq: row.nextSeq,
    mode: row.mode,
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
      // outright (there is nothing to resume into). endedReason carries the
      // git error, capped at 8KB (review fix: unbounded error text — git
      // runs with an 8MB maxBuffer, far past Convex's document cap).
      const msg = truncated(gitErrorText(err), ERROR_TEXT_LIMIT).value;
      log(`session ${row.id}: workdir setup failed:`, msg);
      s.finalizeRow("error", { message: msg });
      s.setStatus("failed");
      s.endedReasonToSend = msg;
      s.requestFlush(true);
      s.cleanupWorkdir();
      return;
    }
    // Re-check after the slow await (review fix: claim-vs-stop race) — a stop
    // arriving mid-clone has already ended the session and deleted the
    // workdir; starting a query now would resurrect a session the server
    // considers over.
    if (s.dead || s.status === "ended" || s.status === "failed") {
      s.cleanupWorkdir(); // the clone may have re-created the dir mid-teardown
      return;
    }
    s.startQuery();
    // Hand over the poll row we claimed from: its pendingInbound holds the
    // initial prompt; the init handler (or delivery-from-starting) takes it
    // from here.
    s.processServerState(row);
  })();
}

// ── adopt: a session that was live when a previous daemon died ───────────────
// Never auto-resume into a running turn (the turn's context is gone with the
// old process); park the session idle with an honest system row. The NEXT
// user turn resumes the SDK session by sdkSessionId — validated to survive
// even kill -9 with context intact.
function adoptSession(env, sessions, row) {
  const s = new Session({
    id: row.id,
    repo: row.repo,
    env,
    nextSeq: row.nextSeq,
    mode: row.mode,
    onUsageSignal: (text, session) => void maybeSwitchAccount(text, session),
  });
  sessions.set(row.id, s);
  s.sdkSessionId = row.sdkSessionId;
  s.status = "idle";
  s.statusToSend = "idle";
  s.finalizeRow("system", {
    text: "session-host restarted; previous turn interrupted",
  });
  for (const p of row.permissions ?? []) {
    if (p.status === "pending") {
      // A permission card nobody can answer anymore — expire it explicitly
      // (never leave Tom staring at a dead card).
      s.outbox.permissionUpdates.push({
        requestId: p.requestId,
        status: "expired",
        decidedBy: "daemon-restart",
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
  // inbound rows, so it cannot be reached from here — the system row above
  // is the transcript's honest record of what happened to that turn.
  s.requestFlush(true);
  // Decisions/commands already queued server-side (including any pending
  // user-turn, which will trigger the resume).
  s.processServerState(row);
}

// ── the main loop ────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  log(`starting session-host v${VERSION} -> ${env.CONVEX_SITE_URL}`);
  const sessions = new Map(); // sessionId -> Session
  let pollAttempt = 0;

  for (;;) {
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
        // Box load facts — the auto-session scheduler's admission signal
        // (load-based, not a scalar session cap): loadavg + free RAM decide
        // whether the box can take another session.
        load: {
          loadavg1: os.loadavg()[0],
          cpus: os.cpus().length,
          freeMemMb: Math.round(os.freemem() / 1048576),
          totalMemMb: Math.round(os.totalmem() / 1048576),
          liveSessions: sessions.size,
        },
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
    for (const row of data.sessions ?? []) {
      listed.add(row.id);
      const local = sessions.get(row.id);
      if (local) {
        // Known session: reconcile (decisions, commands, defensive seq).
        local.processServerState(row);
      } else if (
        row.status === "requested" ||
        (row.status === "starting" && !row.sdkSessionId)
      ) {
        // Fresh session — or one a previous daemon died on before the SDK
        // ever reported an id (nothing to resume; start over cleanly).
        log(`claiming session ${row.id} (repo: ${row.repo})`);
        claimSession(env, sessions, row);
      } else {
        log(`adopting session ${row.id} after restart (status was ${row.status})`);
        adoptSession(env, sessions, row);
      }
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
      if (
        s.status === "running" ||
        s.status === "awaiting-permission" ||
        now - s.lastActivityAt < HOT_WINDOW_MS
      ) {
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
