# TTS session-host

The daemon that runs real Claude Code sessions — and, since 2026-09-04, Codex
CLI sessions — on the Jarvis Box and streams them into tom.quest. Convex is
the message bus: the browser writes commands (`claudeInbound` rows: user-turn
/ interrupt / stop) and permission decisions; this daemon polls
`/sessions/poll`, runs the actual sessions via
`@anthropic-ai/claude-agent-sdk` or `codex exec`, and persists every event
back through `/sessions/ingest` (both key-authed with `X-Sessions-Key` =
`SESSIONS_WORKER_KEY` from `/etc/tts/worker.env`).

Files:

- `session-host.mjs` — the poll loop: heartbeat (carrying box load —
  loadavg, free RAM, live-session count — the auto-session scheduler's
  admission signal, and the Codex account usage described below), claim new
  sessions, adopt survivors after a restart, reap terminal ones, adaptive
  cadence (1s hot / 5s warm / 30s idle), the Codex warm-up at start, and the
  usage-limit account auto-switch (a usage/rate-limit signal from a CLAUDE
  session flips the tts-account symlink to the other Max account, at most
  once per 3h).
- `codex-query.mjs` — the Codex runner: `codex exec --json` wrapped in the
  Agent SDK's query() surface, so `session.mjs` drives both families with one
  body of code. See "Codex sessions" below.
- `codex-bin.mjs` — the Codex binary (`CODEX_BIN` or `codex` on PATH), its
  resolution (`resolveCodexBin`, null when not installed), the spawn shim
  (`spawnCodex`; a `.mjs` CODEX_BIN runs under node — the unit-test fake) and
  the per-turn flags (`codexArgs`). One home for the runner's spawns and the
  daemon's warm-up / usage-read spawns. Dependency-free
  (`__tests__/codex-bin.test.mjs`).
- `poll-plan.mjs` — `planRow`: what the poll walk does with one row (wait /
  readopt / reconcile / defer-fork / claim / adopt), dependency-free so
  `__tests__/poll-plan.test.mjs` can pin the fork deferral described under
  "Model changes and forks".
- `env-scrub.mjs` — the ONE list of the daemon's own secrets and
  `scrubbedEnv({ keepTtsKey })`, the env every model-reachable spawn (a
  session's shell, the Bash classifier, the Codex warm-up and usage read)
  is handed. `lib.mjs` re-exports it; the file stands alone so
  `__tests__/env-scrub.test.mjs` can fence the list.

## Autonomous sessions

A session row with `mode: "autonomous"` (created by the Convex scheduler
cron, never by the browser) runs the same way as any session with three
differences: the SDK query gets `maxTurns: 200`; a 90-minute wall-clock cap
per turn interrupts and ends the session errored ("autonomous time cap");
and after the mission's result the daemon ends the session itself
(endedReason "autonomous run complete") — nobody would ever send stop. An
abnormal turn end (SDK error) or a daemon restart also ENDS an autonomous
session, errored — the interactive park-idle recovery assumes Tom will send
the next turn, and autonomous sessions have no Tom; the scheduler's backoff
owns retries. The agent records its own outcome via the key-authed pen
`POST $CONVEX_SITE_URL/tts/session-outcome` (X-TTS-Key), and writes prep
via `POST $CONVEX_SITE_URL/tts/prepare-todo` (X-TTS-Key) — the daemon passes
CONVEX_SITE_URL and TTS_WORKER_KEY (only — the sessions ingest key never
enters a model-reachable shell) into every session's environment so those
curls work. Those two are the only keys passed EXPLICITLY; the rest of the
daemon's env is inherited minus the `env-scrub.mjs` list (`SESSIONS_WORKER_KEY`,
`GH_TOKEN`, the `TOMQUEST_AGENT_*` pair, `TURING_API_KEY`, `CODEX_API_KEY`,
`OPENAI_API_KEY`), so a session also sees `TURING_READ_KEY` when the box has one — the cluster API's
read-only credential behind `tts-turing` (three GETs, no write verb; the full
`TURING_API_KEY` is not on this box at all). A daemon-stamped outcome (time
cap, turn failure, restart)
never overwrites an agent-recorded one — the server ignores it when an
outcome already exists.

An autonomous mission may carry a `repo` (the scheduler picks it from the
batch's code members, or from a repo the item names outright). Nothing here
is special-cased: the workdir is a fresh shallow clone on branch
`session/<id>`, exactly as for an interactive session, and the mission
prompt tells the agent to commit, push that branch, and open a PR with `gh
pr create` when the work is merge-ready. Merging is Tom's gate; the branch
namespace is the boundary. Missions with `repo: "none"` still get the empty
scratch workdir. Ratified doctrine (2026-08-29): Tom's input gates what
PERSISTS (merges, rulings, statuses), never what a session attempts — an
agent that reaches a Tom decision implements its best-judgment option and
surfaces the decision in the PR, rather than stopping to wait.
- `session.mjs` — one live session: the query (SDK or Codex, by the row's
  model family) and its streaming input queue, seq/turn assignment, the
  outbox + ~400ms flush machinery, subagent parentage stamping
  (`parentToolUseId` on rows produced under a Task call; subagent stream
  deltas never touch the live tail), mid-session model changes, the fork
  transcript, and the permission posture (unified auto mode, ratified
  2026-08-28: nothing parks on Tom in any session mode). The safety boundary
  is structural — throwaway workdir, session/<id> branch namespace, Tom's
  merge gate, Tom-only ruling pens — and every allowed call lands as a
  transcript row. Two per-call checks survive that structure for AUTONOMOUS
  sessions, because a shell is neither a file nor a branch (spec §20.2): the
  out-of-workdir edit denial, and a classifier verdict on Bash commands
  matching the danger fingerprint (pushing, remote access, Jarvis Box
  configuration, credential names, uploading request bodies, deleting by
  absolute path) — verdicts land in the transcript as rows, allow and deny
  alike, are memoized per session so an agentic loop pays once, and the
  classifier is FAIL-OPEN (unreachable ⇒ allowed, and the transcript says
  so). Interactive sessions skip both (Tom's ruling, 2026-09-04: the box is
  the sandbox and Tom is steering); what every mode keeps is the banned-tool
  deny and the Tier-0 guard against restarting this very daemon, because
  that kills every OTHER live session too.
- `banned-tools.mjs` — the tools no session may call at all, and the sentence
  the model reads when it tries. One member: `AskUserQuestion`, whose whole
  purpose is a multiple-choice picker a human clicks. tom.quest's transcript
  renders every tool call as a name plus an input preview and has no picker,
  and an autonomous session has no human at all — so under the auto-allow
  posture the call did not park and wait, it returned with no chosen option
  and the model carried on as if it had consulted someone. The daemon passes
  the list to the SDK as `disallowedTools` (removed from the model's context)
  and denies it again at the permission gate, with a mode-aware corrective
  message: interactive ⇒ ask Tom in reply text, autonomous ⇒ decide and
  surface the alternatives where the work persists. Its own dependency-free
  file so the repo's vitest can execute the rule
  (`__tests__/banned-tools.test.mjs`) — `session.mjs` cannot be imported
  there, since the SDK is installed only on the box.
- `lib.mjs` — env parsing, `sessionsFetch` / `sessionsGet`, backoff, 32KB
  truncation.
- `fork-transcript.mjs` — the `.tts-transcript.md` filename and its
  rendering, dependency-free for the same reason `banned-tools.mjs` is
  (`__tests__/fork-transcript.test.mjs` pins it).

## Codex sessions (ratified by Tom, 2026-09-04)

**Routing.** Every session row carries a `model` name from the one table in
`convex/ttsShared.ts` (`SESSION_MODELS`: opus, sonnet, fable, gpt-5.6-sol,
gpt-5.6-terra; absent = opus). The name implies a FAMILY, and the family
picks the runner: `claude` goes through the Agent SDK's `query()`, `codex`
through `codex-query.mjs`. `session.mjs` mirrors the table (the daemon cannot
import .ts) and `scripts/check-session-mirrors.mjs` fails guardrails when
the two drift. For Claude the table's `id` is passed as the SDK `model` only
when non-null — opus is the account default, exactly what every session ran
before the field existed. For Codex the `id` and `effort`
(`model_reasoning_effort`) go on the command line of EVERY turn, because a
command-line override suppresses the value persisted with the thread.

**The runner.** One `codex exec --json` process per user turn, prompt on
stdin. The first turn mints a thread id (`thread.started`), reported as the
session's `sdkSessionId`; every later turn — and every turn after a daemon
restart — runs `codex exec resume <thread id>`, so Codex's own persisted
context carries over the way the SDK's resume-by-id does. `--ephemeral` is
never passed for that reason. The runner reads Codex's JSONL and yields
messages in the SDK's vocabulary, so the transcript of a Codex session lands
in Convex row for row like a Claude one: `command_execution` → a Bash
tool-call + result; `file_change` → one Write/Edit/Delete tool-call per file;
`mcp_tool_call` and `web_search` likewise; `agent_message` → assistant text;
`reasoning` → thinking; `todo_list` → a system row with the plan as JSON;
`turn.completed` / `turn.failed` → the turn's result. A bare `{"type":
"error"}` is ADVISORY (Codex uses it for conditions it goes on to retry) and
becomes a system row without ending the turn; the turn ends on
`turn.failed`, `turn.completed`, or the process exiting without either
(which the daemon records as a failed turn, with the last 8KB of stderr as
the error text — nothing else from stderr ever reaches a row).

**Subagent rows.** Codex's native subagents surface as `collab_tool_call`
items (spawn_agent, send_input, wait, wait_agent, resume_agent,
close_agent). Each becomes a tool-call named `codex.<tool>` whose input is
the delegated prompt and the receiver thread ids, and whose result is each
child's status and last message. That is everything Codex exposes: the
children's inner steps never appear in the parent's stream, so the
transcript shows what was delegated and what came back, and no more.

**Sandbox off; no per-command gate.** The Jarvis Box is the sandbox. Codex
runs with `--dangerously-bypass-approvals-and-sandbox`; the structural
boundary (throwaway workdir, session/<id> branch namespace, Tom's merge gate,
Tom-only pens, scrubbed env) is the whole boundary, exactly as for Claude.
Codex sessions never enter `#canUseTool` — Codex reports commands after they
ran — so neither the edit-path check, the Bash classifier, nor the Tier-0
daemon guard applies to them. The same ruling made those per-command checks
autonomous-only for Claude sessions too; the Tier-0 guard and the
AskUserQuestion ban stay for every Claude session.

**Model changes and forks.** The daemon reads `model` off every poll row. A
change within a family takes effect on the next turn (the live query is
retired when idle, or at the end of the running turn) and writes a "model
changed to …" system row. A cross-family change never reaches a live
session: the server forks a NEW row (`forkedFrom` = the old id). The daemon
does NOT claim that row while the old id is still in the poll's live list
(the poll lists only live sessions; the source leaves it when its stop lands
and it ends) — logged once as "fork of X waits for its source to end" — so
the transcript it snapshots is complete, ending included. At claim it pages
`GET /sessions/transcript?sessionId=<old>&cursor=…` (ingest key, daemon
only) and writes a readable rendering to `.tts-transcript.md` in the
workdir — turn headers, user and assistant text, one line per tool call
with a truncated input, truncated results, system and error rows verbatim,
thinking omitted. A between-turns workdir rebuild re-creates the file from
the same fetch only if the rebuild lost it. The filename is added to every
checkout's `.git/info/exclude` so it can never be committed. If the fetch
fails the session still starts, with a system row saying the file is
missing.

**Warm-up.** ONE `codex exec` ("reply ok" on `gpt-5.6-terra`, low effort,
60s cap) per `CODEX_HOME` (default `~/.codex`): a cold `CODEX_HOME` loses
thread rows when several `codex exec` processes start at once (a known
upstream bug) — which is exactly what the scheduler's fan-out after a
restart does — and a lost thread row is a session that can never be
resumed. It runs in the BACKGROUND at daemon start, never ahead of the first
poll (the poll is the heartbeat); a Codex session's claim awaits it before
starting its query, a Claude session never does. On success a marker file
`$CODEX_HOME/.tts-warmed` is written and every later start skips the
warm-up; it is skipped outright when the Codex binary does not resolve.
Failures are logged, never fatal, and leave no marker: a box without Codex
still runs Claude sessions.

**Usage heartbeat.** At most once per 5 minutes the daemon reads the Codex
account's limits token-free — `codex app-server` over stdio JSON-RPC
(`initialize`, `initialized`, `account/rateLimits/read`), whose
`rateLimits.primary` is the 5-hour window and `.secondary` the weekly one —
and the heartbeat carries `codexUsage: { weeklyUsedPercent,
fiveHourUsedPercent, weeklyResetsAt, readAt }`. The read runs in the
background (a hung app-server never holds the poll loop; the reading rides
the next heartbeat). The last SUCCESSFUL reading, with its original
`readAt`, rides every heartbeat until a later read succeeds — the server
judges staleness from `readAt` (`CODEX_USAGE_STALE_MS` in ttsShared, 15
minutes) and treats stale or absent as unknown, and unknown admits. Absent
only while no read has ever succeeded (Codex not installed, or every read
failed — logged once, then retried with doubling backoff capped at 30
minutes). The Claude account auto-switch fires
for family `claude` only — a Codex cap has no second account to switch to;
the scheduler's breaker reads it from the error text keyed on family.

## The no-state rule, as applied here

The Jarvis Box owns no durable state; everything this daemon creates is harmless to
lose:

- `/opt/tts/session-host/` (incl. `node_modules`) — a copy of this directory;
  rebuilt by re-running `worker/setup.sh`. Cost of losing: nothing.
- `/var/cache/tts/sessions/<id>/…` — per-session workdirs (empty scratch for
  repo "none", a fresh shallow clone on branch `session/<id>` otherwise).
  Deleted when a session ends. Cost of losing one mid-session: un-pushed /
  un-committed files in that workspace — the daemon rebuilds the dir on the
  next turn, re-fetches the session branch if it was pushed, and writes an
  honest system row into the transcript when it couldn't restore everything.
- The SDK's own session files under `/root/.claude-accounts/<account>/`, and
  Codex's thread store under `CODEX_HOME` — the resume-by-id context. Cost of
  losing them: old sessions can no longer *resume* (the model's context is
  gone), but their transcripts live in Convex untouched; Tom reopens the
  session as a fork and the transcript file carries the context.

Everything that matters — transcript, statuses, permissions, commands — is in
Convex the moment it happens (flushes every ~400ms while streaming, instantly
on turn boundaries / tool calls / permissions / errors).

## The one-dependency exception

The Jarvis Box's standing rule is ZERO npm dependencies (a copy is a deploy;
no lockfile, no install step, no supply-chain surface — see
`worker/jobs/tts-lib.mjs`). This package is the single sanctioned exception:
`@anthropic-ai/claude-agent-sdk` (pinned to 0.3.250, the version whose
behavior was validated on the Jarvis Box), because interactive sessions need the
SDK's streaming input, `interrupt()`, `canUseTool`, and resume-by-id — none
of which the `claude -p` CLI wrapping used by the cron jobs can provide.
`setup.sh` runs `npm install --omit=dev` in `/opt/tts/session-host/` as part
of the install; that is the whole ceremony.

## Running

Normally systemd runs it (installed by `worker/setup.sh`):

```
systemctl status tts-session-host
journalctl -u tts-session-host -f      # watch the logs (stdout -> journald)
```

Manually (for debugging — stop the unit first, two daemons would double-claim
sessions):

```
systemctl stop tts-session-host
node /opt/tts/session-host/session-host.mjs
systemctl start tts-session-host
```

It reads `/etc/tts/worker.env` (`CONVEX_SITE_URL`, `SESSIONS_WORKER_KEY`;
`GH_TOKEN` optional but needed for private-repo clones) and expects
`CLAUDE_CONFIG_DIR=/root/.claude-accounts/active` (baked into the systemd
unit) so `tts-account use` switches which Max account sessions run under.

## GitHub credentials (2026-08-31)

The token never rides in a clone's remote URL and never enters a session's
shell env. `GH_TOKEN` in worker.env stays the one home; two derived doors
serve it (both installed by `setup.sh`, both outside every work tree):

- **git** — `/usr/local/bin/tts-git-credential`, git's global
  credential.helper: clones and pushes use clean `https://github.com/...`
  URLs and git asks the helper at connect time, so `.git/config` and
  `git remote -v` hold no secret.
- **gh** — `/root/.config/gh/hosts.yml`, regenerated from worker.env on
  every setup.sh run, so `gh pr create` works — the sanctioned way a session
  finishes. Every `gh` call pays a classifier verdict (`gh pr merge` and API
  writes past the session's own PR are denied — merging is Tom's gate).

A GitHub-token-shaped string that still reaches an ingest payload is
redacted by the daemon (`redactGitHubTokens` in lib.mjs) before it can land
in a transcript row — on 2026-08-30 a session read the token out of
.git/config, typed it inline, and the classifier's own verdict rows carried
it verbatim into Convex.

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
