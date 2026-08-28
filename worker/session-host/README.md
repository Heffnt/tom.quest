# DTS session-host

The daemon that runs real Claude Code sessions on the worker box and streams
them into tom.quest. Convex is the message bus: the browser writes commands
(`claudeInbound` rows: user-turn / interrupt / stop) and permission
decisions; this daemon polls `/sessions/poll`, runs the actual sessions via
`@anthropic-ai/claude-agent-sdk`, and persists every event back through
`/sessions/ingest` (both key-authed with `X-Sessions-Key` =
`SESSIONS_WORKER_KEY` from `/etc/dts/worker.env`).

Files:

- `session-host.mjs` — the poll loop: heartbeat, claim new sessions, adopt
  survivors after a restart, reap terminal ones, adaptive cadence
  (1s hot / 5s warm / 30s idle).
- `session.mjs` — one live session: the SDK query and its streaming input
  queue, seq/turn assignment, the outbox + ~400ms flush machinery, and the
  permission gate (reads auto-allow; in-workdir edits auto-allow;
  out-of-workdir edits auto-deny with a corrective message; everything else
  waits for Tom, indefinitely).
- `lib.mjs` — env parsing, `sessionsFetch`, backoff, 32KB truncation.

## The no-state rule, as applied here

The box owns no durable state; everything this daemon creates is harmless to
lose:

- `/opt/dts/session-host/` (incl. `node_modules`) — a copy of this directory;
  rebuilt by re-running `worker/setup.sh`. Cost of losing: nothing.
- `/var/cache/dts/sessions/<id>/…` — per-session workdirs (empty scratch for
  repo "none", a fresh shallow clone on branch `session/<id>` otherwise).
  Deleted when a session ends. Cost of losing one mid-session: un-pushed /
  un-committed files in that workspace — the daemon rebuilds the dir on the
  next turn, re-fetches the session branch if it was pushed, and writes an
  honest system row into the transcript when it couldn't restore everything.
- The SDK's own session files under `/root/.claude-accounts/<account>/` —
  the resume-by-id context. Cost of losing them: old sessions can no longer
  *resume* (the model's context is gone), but their transcripts live in
  Convex untouched; Tom starts a new session and points it at the transcript.

Everything that matters — transcript, statuses, permissions, commands — is in
Convex the moment it happens (flushes every ~400ms while streaming, instantly
on turn boundaries / tool calls / permissions / errors).

## The one-dependency exception

The worker box's standing rule is ZERO npm dependencies (a copy is a deploy;
no lockfile, no install step, no supply-chain surface — see
`worker/jobs/dts-lib.mjs`). This package is the single sanctioned exception:
`@anthropic-ai/claude-agent-sdk` (pinned to 0.3.250, the version whose
behavior was validated on this box), because interactive sessions need the
SDK's streaming input, `interrupt()`, `canUseTool`, and resume-by-id — none
of which the `claude -p` CLI wrapping used by the cron jobs can provide.
`setup.sh` runs `npm install --omit=dev` in `/opt/dts/session-host/` as part
of the install; that is the whole ceremony.

## Running

Normally systemd runs it (installed by `worker/setup.sh`):

```
systemctl status dts-session-host
journalctl -u dts-session-host -f      # watch the logs (stdout -> journald)
```

Manually (for debugging — stop the unit first, two daemons would double-claim
sessions):

```
systemctl stop dts-session-host
node /opt/dts/session-host/session-host.mjs
systemctl start dts-session-host
```

It reads `/etc/dts/worker.env` (`CONVEX_SITE_URL`, `SESSIONS_WORKER_KEY`;
`GH_TOKEN` optional but needed for private-repo clones) and expects
`CLAUDE_CONFIG_DIR=/root/.claude-accounts/active` (baked into the systemd
unit) so `dts-account use` switches which Max account sessions run under.

## Restart semantics

Restarts are a designed-for non-event (`Restart=always`, `RestartSec=5`):

- On startup the first poll returns every live session. Each one is adopted
  **idle** — never auto-resumed into a running turn — with a system row
  ("session-host restarted; previous turn interrupted") in the transcript,
  and any pending permission cards are expired (`decidedBy:
  "daemon-restart"`) so Tom is never left staring at a dead card.
- The **next user turn** resumes the SDK session by id (validated to survive
  kill -9 with context intact), rebuilding the workdir first if it vanished.
- Sessions still `requested` are simply claimed as if new.
- Ingest retries are blind and safe: the server drops any row whose seq is
  below the session's floor, so a flush that died mid-network cannot
  double-write.

## Failure policy

- **Transient ingest failures** (network errors, 5xx, 408/429) back off and
  blind-retry the identical payload — safe per the seq-floor rule above.
- **Permanent ingest rejections** (any other 4xx: validation error, oversized
  document) are **not** retried: the payload is dropped, a small `error` row
  ("a transcript flush was rejected and dropped: …") is written so the
  transcript records the loss honestly, and the server's error text is
  reported as `lastIngestError` in the next poll body so the failure is
  visible server-side, not just in journald.
- **Error text is capped at 8KB** (git failures, SDK errors) before it goes
  into `error` rows or `endedReason` — git runs with an 8MB output buffer,
  and an untruncated failure report could itself be rejected at ingest.
- **Force-closed sessions** (browser forceClose, or the server stops listing
  a session) get ONE best-effort final flush (short timeout, errors ignored),
  then all local state is dropped and the reaper deletes the entry
  unconditionally — a dead session never waits to "drain" and never pins the
  1s poll cadence.
