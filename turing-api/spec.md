# tom.Quest Turing — Experiment Execution & Observability Spec

This is the agreed design for evolving the tom.Quest **turing** subsystem (the FastAPI
service in `turing-api/`, its Convex control plane in `convex/`, and the dashboard in
`app/turing/`) so it fits the way the **booleanbackdoors / ComplexMultiTrigger** research
campaign actually runs on the WPI Turing SLURM cluster.

It describes the intended **end state** plus the verified **current state** it builds on.
It is a living design doc: settled decisions are stated as such; genuinely open calls live
in §12. Behavior lives in code — this records the load-bearing decisions and why.

Scope note: this file covers the whole turing subsystem, not just `turing-api/`. It lives
here because `turing-api/` is the heart of it and is where the prior planning doc lived.

---

## 0. Thesis

booleanbackdoors is already a complete, crash-surviving, content-addressed experiment
orchestrator: **the filesystem is its database.** tom.Quest must therefore **not** try to
schedule experiments. Its job is two things the orchestrator does not do for itself:

1. **Provision** GPU workers that run the orchestrator's sweep loop, declaratively.
2. **Observe** the campaign — turn the on-disk artifact tree plus SLURM accounting into a
   live picture of progress and outcomes.

The load-bearing architectural rule is **one-sided coupling**: *tom.Quest depends on
booleanbackdoors; booleanbackdoors never depends on tom.Quest.* And the dependency is
minimal: tom.Quest runs an operator-authored command and keeps N copies of it alive — it
holds no model of booleanbackdoors's tree, claims, or completion. booleanbackdoors has zero
imports of, callbacks to, or knowledge of tom.Quest, and there is **no cooperative seam at
all**: a worker is a crash-safe command that exits 0 when its work is done (§1.2), so
tom.Quest never needs to signal, drain, or inspect it — only to choose how many run.

---

## 1. The systems this builds on (verified 2026-06-13, login-03)

### 1.1 turing-api today

FastAPI on login-03, bound `127.0.0.1`, reached only via the named cloudflared tunnel
`turing.tom.quest`. Refuses to start without `TURING_API_KEY`; CORS `*`; SIGHUP ignored.

- **Auth:** one `X-API-Key` header, checked by **two** dependencies over **two** keys.
  `verify_api_key` (`TURING_API_KEY`) is the default and guards every non-WS endpoint —
  the whole surface, write verbs included. `verify_read_key` (`TURING_READ_KEY`) guards
  exactly three: `GET /gpu-report`, `GET /jobs`, `GET /sessions/{name}/output`. It accepts
  **either** key, so full-key callers (the Next proxy, the Convex reconciler) are unaffected,
  while a read-key holder can look at the cluster and cannot act on it. Both compares are
  constant-time over bytes. **Fail closed:** an unset `TURING_READ_KEY` means the read door
  does not exist and those three go back to full-key-only — a blank env var never becomes a
  blank password. The split exists because `POST /sessions/{name}/run` is arbitrary shell as
  `ntheffernan`, so "read the GPU report" and "run anything on the cluster" must not be the
  same credential; the read key is what TTS sessions on the Jarvis Box hold
  (`worker/bin/tts-turing`). The terminal WebSocket is under neither dependency; it
  authenticates with a short-lived HMAC token signed with the **same** full `API_KEY`
  (`ws.py:27`, `ws.py:124`) — the read key signs nothing.
- **Allocation model:** `POST /allocate` loops `count` times, one **single-GPU**
  `salloc --no-shell --gres=gpu:<type>:1 --time=<mins> --mem=<mb> --job-name=<name>` per
  GPU (`slurm.py:123`). **No `--partition` is ever passed** → everything lands on the
  default partition. The allocation is held open only by the tracked `Popen` living in an
  **in-memory** `_SALLOC_PROCESSES` dict (`slurm.py:21`) — process-local, lost on API
  restart (ownership must not depend on it). A daemon thread then opens a **tmux** session,
  runs `srun --pty --jobid=<id> bash`, and replays `commands[]` via `send-keys`
  (`tmux.py:86`). `release_on_exit` appends `scancel <id>` after the commands finish
  (`tmux.py:120`).
- **Job listing:** `GET /jobs` runs `squeue --me --format='%i|%T|%L|%S|%e|%b|%R|%j'`
  (`slurm.py:183`) and returns **all** of the user's jobs — there is no server-side tag
  separating pool/reconciler jobs from manual ones. A 500 here freezes the reconciler, so
  the parser is defensive (maxsplit=7).
- **File access:** `GET /file` / `GET /dirs` confined to `TURING_FILE_ROOT` (default
  `$HOME`) via `resolve_within_root` (`dirs.py:22`), which collapses `..`, follows
  symlinks, and additionally **refuses secret paths** (`.ssh`/`.aws`/`.gnupg`,
  `.env`/`.pem`/`.key`). This is the **only** confined file primitive in the app.
- **Terminal:** `GET (ws) /ws/sessions/{name}` opens a pty that `tmux attach`es; HMAC-token
  gated, session-scoped.
- **The async invariant (load-bearing):** every endpoint that shells out is plain `def`,
  never `async def`; only `/health` is async. A blocking subprocess call inside `async def`
  freezes the event loop and starved `/health` during the **June 2026 outage**
  (`main.py:117`). Any new endpoint that touches the filesystem or shells out is plain
  `def`.
- **`boolback.py` (removed):** a legacy ~1840-line router under `/boolback` formerly served
  ComplexMultiTrigger progress data against the **legacy tree schema** (`claim.json` =
  `{hostname,pid,timestamp}`, `epoch_N` underscore, liveness via `/proc`), which no longer
  matched the live tree (§1.2). It has been **deleted** (§9); the live `/boolback` page is now a
  static-snapshot explorer in tom.Quest (`app/boolback`, fed by `scripts/boolback_export.py`),
  carrying no live API traffic.

### 1.2 The booleanbackdoors execution model (the intended end state)

- **Workers run `sweep.py`** from `~/booleanbackdoors/ComplexMultiTrigger`, conda env
  `boolback`, `$BOOLEAN_BACKDOOR_OUTPUT=/home/ntheffernan/booleanbackdoors/cmt-output`. A
  worker expands the **active set** (`sweeps/active.txt`) and runs a **frontier claim-build
  loop**: it builds any node whose parent is complete and that it can claim, sleeps when the
  only remaining work is claimed by peers, and **exits 0 when the declared end state is
  reached**. There is no static work split — N interchangeable workers self-balance by
  claiming, and a slow or dead worker's node is reaped and picked up by another.
- **The tree is the database.** Each content-addressed node is `kind+slug+hash`; `done.json`
  (written last, atomically) present ⟺ node complete; `.lock/` (atomic `mkdir` + a 30s
  heartbeat, stale after 150s = `5 × 30s`, cross-host, **never** `/proc`/pid) is the per-node
  claim. The tree root is under `$HOME`.
- **A worker is a crash-safe command.** It needs no cooperative stop: to remove one, cancel
  its SLURM job — its in-flight node has no `done.json`, so another worker reaps the stale
  claim and redoes it. tom.Quest therefore never drains, signals, or inspects a worker; it
  only chooses how many run (§4).
- **The fleet is one pool of interchangeable workers** draining the union of the active set;
  concurrent sweep specs self-balance across GPUs with no per-sweep or per-shard assignment.
  Campaign progress (coverage, ASR) is booleanbackdoors's own concern, surfaced by its
  analysis CLI (`python -m boolean_backdoor.analysis`), not by tom.Quest — so tom.Quest reads
  no on-disk tree schema at all.

### 1.3 The Convex GPU-pool control plane (the pattern to extend)

The hardened declarative GPU pool **is** the worker pool: the redesign extends it with one
`restart` policy and a generic command (§4), rather than adding a second table. Its proven
pieces carry over directly.

- A 60s `internalAction` cron reconciles desired-vs-actual purely by **reserved job name**
  read from the live `/jobs` list (name-authoritative; the allocation table is only an
  in-flight bridge). Reserved prefix `gpupool:`; name `gpupool:<gpuType>:<fingerprint>`.
- **Fingerprint** = FNV-1a over exactly `[commands, timeMins, memoryMb, projectDir, releaseOnExit]`
  — deliberately **excludes** `gpuType` (already in the reserved name), `desiredCount`, `enabled`,
  and `restart` (scaling, toggling, and the restart *policy* must not change job identity).
- **Two-layer clamp** of `desiredCount` to `[0, MAX_ALLOCATION_COUNT=16]`: in the public
  `set` mutation **and** again at reconcile read-time.
- **Fail-closed:** on any failure to read `/jobs`, the cycle is skipped and prior state is
  carried forward — never prune/allocate/cancel against an unknown world.
  `RECONCILE_FETCH_TIMEOUT_MS=75s` exceeds the API's 60s salloc timeout so a slow allocate
  is never abandoned (which would leak a job).
- **One allocate per cycle** (`count:1`), recorded immediately, so the in-flight cache
  stays honest.
- **Reserved-name guard** in two places: the Next proxy (authoritative,
  `route.ts:27`) and the allocate form (UX). All durable reconciler writes go through
  internalMutations (actions can't touch the DB).
- `convex/http.ts` registers the auth routes plus the agent worker-pool endpoint — `POST /pool`
  (scale/toggle/restart) and `GET /pool` (read desired-state/status/audit), both key-authed (§7).

### 1.4 Verified Turing/SLURM facts that bind this design

SLURM 21.08. Default partition **`short`** → QOS `short`, **hard per-user cap
`gres/gpu=12`** (`DenyOnLimit` → over-request is *rejected*, not queued), 24 h walltime.
Other partitions: `long` 4-GPU/7-day, `quick` 1-GPU/12 h, `academic` 2-GPU/2-day. **Whole
GPUs only** (no MPS/MIG/shard); **no preemption**. `sacct` (slurmdbd) gives terminal
`State` (incl. distinct `OUT_OF_MEMORY`, `TIMEOUT`, `CANCELLED`, `COMPLETED`, `FAILED`),
`ExitCode`, `ElapsedRaw`, and `AllocTRES` (`gres/gpu=N`) → GPU-hours = `ElapsedRaw/3600 ×
gpu_count`. **Parse with `sacct -X -p`** (pipe-delimited); the `%width` form truncates
(`CANCELLED by <uid>` → `CANCELLED+`). **`salloc --no-shell` jobs can only ever reach
`TIMEOUT`/`CANCELLED`** in sacct — they have no payload program, so sacct `State` is *not*
an outcome signal for them (§8.3).

---

## 2. Governing principles

1. **One-sided coupling** (§0). tom.Quest runs a command and keeps N alive; there is no
   cooperative seam — a worker is a crash-safe command that self-exits when done.
2. **Desired state is the single lever.** One Convex table holds "what should be running."
   Editing it is the *only* way to change the world. The reconcile cron is the **only**
   actor that touches SLURM.
3. **Name-authoritative ownership.** A controller-managed job's identity lives in its
   reserved SLURM job name, recovered from the live `/jobs` list — never from a private
   side-table. Never cancel a job you cannot prove you own by name.
4. **Fail-closed.** Unreadable actual state ⇒ skip the cycle, carry prior state; never act
   against an unknown world.
5. **Sync-`def` for anything blocking.** Preserve the June-2026 invariant.
6. **Confine every file read** through `dirs.py:resolve_within_root` (§8.4).

---

## 3. The unit model

tom.Quest's unit of provisioning is the **worker**: one GPU running the operator-authored
command (for booleanbackdoors, `sweep.py`). Workers in a pool are interchangeable — no shard,
no per-sweep assignment. Everything below the worker (the artifact nodes it builds, the stage
subprocesses it spawns) belongs to booleanbackdoors and is invisible to tom.Quest.

**Campaign-phase gating is explicitly out of scope.** The campaign is sequential experimental
design (phase 0 → Gate → phase 1 → …); later sweep specs are *authored by a human after
analyzing earlier results* and often do not exist yet. tom.Quest provisions whatever the
operator declares (by editing the active set and the desired worker count); the operator is
responsible for not launching phase N+1 before Gate N passes. This boundary is named here so
it is not later mistaken for a missing feature.

---

## 4. The worker pool

### 4.1 Desired state

The existing **`gpuPool`** table is the worker pool — no new table. Each enabled row is one
declared worker assignment; the fleet is their union:

```
gpuPool: {
  gpuType:       string,   // single GPU per worker (whole-GPU only)
  commands:      string[], // the worker command lines, admin-authored (§7), e.g. the sweep.py invocation
  projectDir:    string,   // the repo dir the worker runs the command in
  desiredCount:  number,   // how many workers to keep running
  restart:       "always" | "never",  // always = keep-warm; never = run-to-completion (§4.3)
  timeMins:      number,
  memoryMb:      number,
  releaseOnExit: boolean,  // cancel the SLURM job when its command finishes
  enabled:       boolean,
  updatedAt:     number,
}
```

`desiredCount` is **two-layer clamped** (set-mutation and reconcile read-time) to
`[0, MAX_ALLOCATION_COUNT=16]`. The richer shared-budget clamp to the real QOS cap (12 on
`short`) with interactive headroom is deferred (§4.5, §13); 16 is a soft app ceiling above
SLURM's own hard `DenyOnLimit` cap of 12. The `restart` policy governs whether an exited worker
is replaced (§4.3).

### 4.2 Reserved name and the worker wrapper

The worker's SLURM job name carries name-authoritative ownership:

```
gpupool:<gpuType>:<fp>      // e.g. gpupool:H200:1a2b3c4d
```

`fp` is the fingerprint over the worker-identity fields (§1.3): `commands`, `timeMins`,
`memoryMb`, `projectDir`, `releaseOnExit` — excluding `gpuType` (in the name), `desiredCount`,
`enabled`, and `restart` (a scaling/policy toggle must not change identity).

tom.Quest owns the worker's launch, so the wrapper just runs the command, records the launch
HEAD SHA for provenance (§5), and **self-`scancel`s on exit** so a finished worker frees its
GPU immediately rather than holding it until the 24 h wall:

```
cd <repo>
git rev-parse HEAD                     # logged for provenance (§5)
<command>                              # e.g. python sweep.py
scancel <selfJobId>                    # free the GPU on exit
```

There are **no completion markers and no `.pool/` namespace**. Whether the worker exited
because its work is done is not tom.Quest's concern: completion is the worker's (it exits 0
when the active set is drained, §1.2), and whether a freed GPU is reused is the `restart`
policy (§4.3). This keeps the coupling one-sided — tom.Quest writes nothing into, and reads
nothing from, booleanbackdoors's output tree.

### 4.3 Restart policy (the only completion lever)

The reconciler keeps `desiredCount` workers alive per enabled row, by reserved name (as
`gpuPool` always has). The single addition is the `restart` policy, which decides what
happens when a worker **exits**:

| `restart` | On worker exit | Use |
|---|---|---|
| **`always`** | re-allocate a replacement to maintain `desiredCount` | **keep-warm** — many small experiments; new work added to the active set is picked up within a reconcile cycle |
| **`never`** | do **not** re-allocate; the worker is not relaunched at the current `fp` | **release-when-done** — a large final sweep: the pool empties itself as workers drain and exit |

tom.Quest detects no completion itself — it has no tree access and no markers. Under
`restart:never`, "do not relaunch" is implemented by counting only workers not yet seen-live
at the current `fp` toward `desiredCount` (reusing the existing seen-live flag), so each
worker launches at most once and the pool drains to zero on its own. The boolback worker is
the sole completion-aware party (§1.2).

**Back-pressure is not churn.** When the shared GPU budget (§4.5) is full, *wanting* a worker
we cannot allocate is a benign steady state — hold, do not advance the churn breaker. Only a
worker that **launches and dies unproductively** (nonzero exit, or vanishes near-instantly)
is churn (§8.5); an allocate refused by SLURM `DenyOnLimit` is back-pressure, not churn. A
`restart:always` pool pointed at an already-drained active set sees workers exit 0 almost
immediately; a clean exit-0 is treated as "nothing to do" (not a fault) and simply pauses
re-allocation, surfaced as a benign "drained" state.

### 4.4 Shedding

Shedding (lowering the fleet) is just lowering `desiredCount`: the reconciler cancels surplus
workers. Because a worker is crash-safe — its in-flight node has no `done.json` and is reaped
and rebuilt by another worker (§1.2) — tom.Quest may cancel **any** worker; the only cost is
that one in-flight node is redone. There is no node-state to inspect and no slice to strand.
The `gpupool:` reserved prefix and name-authoritative ownership ensure tom.Quest only ever
cancels jobs it owns.

### 4.5 The shared GPU budget

The worker pool and manual allocations are the **same user against one 12-GPU `short` cap**.
Today `desiredCount` is clamped per row to `[0, MAX_ALLOCATION_COUNT=16]` (two-layer: the `set`
mutation and reconcile read-time). 16 sits **above** the real cap deliberately — SLURM's own
`DenyOnLimit` on the `short` QOS is the hard backstop: an over-12 allocate is **rejected, not
queued**, and the reconciler surfaces that refusal as a benign "throttled" state (§4.3), never as
churn. So the fleet cannot actually exceed 12 even though the app ceiling is 16.

The richer **shared-budget clamp** is **deferred** (§13): `EFFECTIVE_CAP` = the QOS cap (`short`
→ 12) minus a `reservedInteractiveHeadroom` minus `liveManualGpuCount` (jobs in `/jobs` **not**
matching the `gpupool:` prefix), with `priority` arbitration across rows when the clamp bites. It
would keep the rebuild-phase interactive `salloc` from being starved by the fleet and vice versa;
until it lands, keep `desiredCount` low enough to leave interactive headroom by hand.

- **Partition:** workers run on `short` (12 GPUs, 24 h walltime); a worker `TIMEOUT`-killed at
  the wall loses only its in-flight node, redone by another worker. (`long` — 7-day walltime,
  4 GPUs — exists if a single node ever needs to outlive 24 h; not used by default.)

---

## 5. Code version (`codeRef`)

The user's hard constraint: **an irrelevant commit must never cancel a running worker.** That
is guaranteed structurally — a git commit writes nothing to Convex desired state, and the
reconciler acts only on desired-state changes.

Workers run from the user's working tree (`cd ~/booleanbackdoors/ComplexMultiTrigger`).
`codeRef` is **not** in the fingerprint, so commits never roll the fleet. The HEAD SHA
observed at each worker's launch is **recorded for provenance** (the wrapper logs it, §4.2)
and shown on the dashboard. Pinning a worker to a specific commit is the operator's job —
check that commit out in the working tree before raising the count; tom.Quest does not manage
isolated per-worker checkouts.

---

## 6. Drain semantics

Two mechanisms, no cooperative stop:

1. **Attrition (default for completion and downsizing).** Lower `desiredCount` (or set
   `restart:never` and let the active set drain): a worker finishes its current node and
   exits, and the reconciler does not replace it. Crash-safe, zero wasted training.
2. **Hard drain (for an explicit abort).** `scancel` the workers now. Each worker's in-flight
   node has no `done.json`, so it is redone later — crash-safe, but it **discards that one
   node's in-progress GPU-hours** per worker (on an H200 mid-train, the current multi-epoch
   node, since `done.json` is written last). This is the default for "stop now".

There is no graceful (cooperative-stop) drain: a worker is a crash-safe command, and hard
drain loses at most one in-flight node per worker (everything completed is saved and reused),
so the cooperative middle ground would add a booleanbackdoors stop-check for a negligible
payoff.

---

## 7. Control plane

Desired state is the `gpuPool` table with **two authenticated writers**:

- **Human (admin), via the dashboard** — admin-session-gated Convex mutations (the `gpuPool`
  pattern: `requireAdmin`, two-layer clamp, upsert-whole-row). This is the **only** path that
  may author or change a row's `command`, `partition`, or resource limits.
- **Agent, via a key-authed Convex HTTP `/pool` endpoint** in `convex/http.ts`, two methods on
  one path. `POST /pool` calls a narrow internal mutation (`agentScale`) that may write **only**
  `desiredCount`, `enabled`, and `restart`, on an **existing admin-authored row** (looked up by
  `gpuType`); it **refuses if no such row exists** (no insert) and never touches
  `commands`/limits. It shares the human path's `clampDesired()` helper. `GET /pool` is the
  read counterpart (§8.1): it returns the projected pool desired-state, the last reconcile
  status, and the recent agent-write audit — read-only, never the worker command. Agents may
  run anywhere (Turing, laptop, CI); both writers hit the same table, so they stay in sync and
  the reconciler is still the only SLURM actor.

Security of the agent path (the new attack surface — load-bearing):

- **No command authoring over the agent key.** The `command` is admin-authored and never
  agent-writable; the agent can only scale/toggle/restart pre-approved rows. Arbitrary shell
  as `ntheffernan` on a GPU node therefore stays a **Tom-only** capability behind the existing
  `isTom` gate. (This is why the worker command lives in the row, not in a free-form request.)
- **Separate narrow key** (`POOL_AGENT_KEY`), stored **only in Convex env**
  (`secrets/convex.env`), never in Vercel/`next.env` — it shares nothing with `TURING_API_KEY`
  (the auth-clobber lesson). Constant-time compare. Authorizes the `agentScale` write **and**
  the `GET /pool` read of pool desired-state/status/recent-audit (both key-gated; the read is
  projected to never expose the worker command); no terminal, no `/allocate` passthrough. Every
  write is **logged with a writer id + the resulting desired values** into the append-only
  `gpuPoolAgentLog` table (the audit trail) — kept separate from the reconcile status singleton,
  which the reconciler overwrites each cycle. Rotation via `pnpm secrets:sync`.
- **Clamp at the boundary too**, not just at reconcile — a bad `desiredCount` (9999, −5) must
  be clamped where it is written, so no code path ever trusts an out-of-range stored value.

---

## 8. Observability

tom.Quest observes **GPU jobs**, not experiments. Campaign/science progress (coverage, ASR)
lives in booleanbackdoors's own analysis CLI (`python -m boolean_backdoor.analysis` →
`digest.md`); tom.Quest does not read the artifact tree.

### 8.1 Data sources and the rule for each

- **`squeue` (slurmctld, real-time):** the truth for *currently active* workers. Source for
  the live worker list, matched to a pool by reserved name (`gpupool:<gpuType>:<fp>`); workers
  are interchangeable, so there is no per-sweep or per-shard mapping.
- **`sacct -X -p` (slurmdbd, lagging):** the truth for *completed/historical* jobs,
  **GPU-hours** (`ElapsedRaw × gres/gpu`), and terminal `State`. Do **not** poll on a tight
  loop expecting instant terminal state. Match `CANCELLED` by prefix (`CANCELLED by <uid>`).
- **The worker log tail:** the failure reason for a worker that died (workers redirect to
  `~/<name>.log`, under `$HOME`, read via the confined `/file`, §8.4).

### 8.2 The dashboard

Per pool: the live workers (count vs `desiredCount` and the `restart` policy; the `codeRef`
provenance SHA is deferred, §13), each with a per-worker drill-down — GPU type, time-left,
GPU-hours so far,
an attach-to-tmux link (the existing terminal WebSocket), and the tail of its log. There is
no tree-derived "done/total" bar — experiment progress is the analysis CLI's job (the intro
above). A `restart:never` pool that has drained shows zero live workers and a benign
"drained" state (§4.3).

### 8.3 Outcomes (and why they don't come from `sacct State`)

A worker keeps the `salloc --no-shell` + tmux shape, so its **SLURM job can only reach
`TIMEOUT`/`CANCELLED`** in `sacct` — `State` is *not* a per-worker success/fail signal.
Outcomes come from:

- **clean exit vs crash** ← the worker's exit (a clean exit-0 frees the GPU via self-`scancel`,
  §4.2; a nonzero exit or a vanish-before-progress is a crash, §8.5).
- **the failure reason** ← the tail of the worker's `~/<name>.log` (confined `/file`).
- **GPU-hours and wall `TIMEOUT`/`CANCELLED`** ← `sacct` (the one thing it is good for here).

### 8.4 Confinement

tom.Quest does not walk the artifact tree, so there is no large scan to bound — its file
access is just the worker log tails. Still, **every file endpoint goes through
`dirs.py:resolve_within_root`** (regression-test that `../`, absolute escapes, and
`.env`/`.ssh`/`.pem`/`.key` targets are 403).

### 8.5 Failure surfacing

A worker that crash-loops on a bad env or command must be **legible**, not a silent churn:
distinguish a **clean exit-0** ("nothing buildable / drained", expected — not churn even
under `restart:always`) from a **crash** (nonzero exit, or a near-instant vanish with no
GPU-hours accrued in `sacct`). **Fast-trip** the churn breaker on repeated crashes, with the
captured **log tail + the launch HEAD SHA** as the reason, instead of burning the budget
silently. Exit-timing + `sacct` GPU-hours are enough to tell the two apart — no marker file
is needed.

---

## 9. boolback.py (removed)

The legacy `/boolback` FastAPI router (`boolback.py`, `boolback_test.py`) has been **deleted**,
and its mount removed from `main.py`. It was built on the legacy booleanbackdoors tree schema
and no longer matched the live tree; nothing consumed it. The live `/boolback` page is now a
static-snapshot explorer in tom.Quest (`app/boolback`, fed offline by `scripts/boolback_export.py`),
and the worker pool — not this router — owns campaign progress. Campaign results live in
booleanbackdoors's analysis CLI (§8).

---

## 10. Untouched

The interactive `salloc`+tmux allocation path (`/allocate`, the allocate form) and the
terminal WebSocket (`ws.py`, `/turing/terminal/[session]`) are **unchanged** — actively used
for the rebuild-phase "GPU-verify one expansion at a time" workflow. The worker pool is
additive; a worker is itself a tmux session, so the existing attach-and-watch terminal works
on workers for free.

---

## 11. Constraints honored

Sync-`def` for every blocking/FS endpoint (§1.1). The `gpupool:` reserved name and
name-authoritative ownership (§4.2). Separate narrow agent key, never `TURING_API_KEY`, with
command authoring admin-only (§7). Whole-GPU single-GPU workers; `desiredCount` clamped to
`[0, 16]`, with SLURM `DenyOnLimit` (12 on `short`) the hard backstop and the real-QOS
shared-budget clamp deferred (§4.5, §13). Convex: durable writes through mutations; HTTP
endpoints in `convex/http.ts`; adding fields needs no `_generated` hand-edit. Confinement through
`resolve_within_root` (§8.4).

---

## 12. Open decisions (need the operator's call)

1. **Interactive headroom.** Deferred with the shared-budget clamp (§4.5, §13): when that lands,
   set `reservedInteractiveHeadroom` — how many of the 12 `short` GPUs to keep free for
   interactive rebuild work (the `/allocate` path, §10) so the worker fleet never starves it.
   Until then, leave headroom by keeping `desiredCount` below 12 by hand.
2. **Dashboard depth (future).** Ship the generic ops view (§8.2). If scientific results
   (clean_accuracy / ASR / FTR) are ever wanted *in the tom.Quest dashboard* rather than the
   analysis CLI, read the existing `tidy/tidy.parquet` via Polars (cheap, possibly stale —
   show its `mtime`) rather than recomputing — but that re-introduces a booleanbackdoors
   dependency tom.Quest is otherwise free of, so it stays out by default.

---

## 13. Out of scope / future

**Campaign-phase gating** (human analysis decisions between sweep specs, §3). **Multi-GPU /
multi-node** runs (the campaign's default scale is single-GPU small models). Surfacing the
**tidy projection** as live results in the tom.Quest dashboard (§12.2).

Deferred from the worker-pool design (the shipped code clamps to `[0, 16]` and relies on SLURM
`DenyOnLimit` as the real cap, §4.5):

- **Shared-budget clamp** — `EFFECTIVE_CAP = 12 − reservedInteractiveHeadroom −
  liveManualGpuCount`, with `priority` arbitration across enabled rows when the clamp bites
  (§4.5, §12.1). Until built, hold interactive headroom by keeping `desiredCount` low by hand.
- **`partition` field** — workers run on the default `short` only; no per-row partition choice
  (so it is not in the fingerprint, §4.2).
- **`codeRef` field + HEAD-SHA provenance** — workers run the working tree; the launch HEAD SHA
  is not yet recorded or surfaced (§5, §8.2).
- **`priority` field** — no cross-row tie-break; relevant only once the shared-budget clamp lands.
- **The `restart:always` "drained" benign signal** (§4.3, §8.5) — a pool pointed at an
  already-drained active set relaunches exit-0 workers rather than surfacing a distinct
  "drained" state; the churn breaker still fires on genuine crashes.

---

## 14. Configuration: every environment name turing-api reads

The service reads its settings from `turing-api/.env` beside the code, loaded at startup by
`python-dotenv` (`main.py:29`). This section is the census of every name any module under
`turing-api/` reads, the file and line reading it, the value used when the name is unset, and
which of the two committed templates declares it today — `secrets/turing-api.env.example` or
`turing-api/forge.env.example`. It is the authoritative list of what a template must cover.

### 14.1 Names read by the service process

**Seventeen** names, all read via `os.environ.get` / `os.getenv` at import time except the two
marked *call time*. "Declared in" is the state as of this census; `—` means neither template
lists the name.

| Name | Read at | Default when unset | What it controls | Declared in |
| --- | --- | --- | --- | --- |
| `TURING_API_KEY` | `main.py:31` | `""` (service refuses to start) | Shared `X-API-Key` for every non-WS endpoint, and the HMAC key the terminal token is verified with (`ws.py:27`) | `secrets/turing-api.env.example` |
| `TURING_READ_KEY` | `main.py:40` | `""` (read door does not exist — only the full key opens anything) | The second `X-API-Key` accepted by `verify_read_key`, which guards `GET /gpu-report`, `GET /jobs` and `GET /sessions/{name}/output` and nothing else | `secrets/turing-api.env.example` |
| `API_PORT` | `main.py:30` | `8000` | Port uvicorn binds on `127.0.0.1` | `secrets/turing-api.env.example` (commented) |
| `TURING_FILE_ROOT` | `dirs.py:10` | `Path.home()` | Root that `GET /file` and `GET /dirs` are confined to | — |
| `BOOLEAN_BACKDOOR_OUTPUT` | `forge.py:105`, `boolback_snapshot.py:49` (*call time*) | none — raises `RuntimeError` | Artifact-tree root. Forge run dirs live under `<root>/forge/`; snapshot dirs resolve under `<root>` | `turing-api/forge.env.example` (commented) |
| `BOOLEAN_BACKDOOR_REPO` | `forge.py:51` | `~/booleanbackdoors/ComplexMultiTrigger` | CMT checkout the Forge train/serve jobs are submitted from (`cwd=` at `forge.py:211`, `:367`) and passed to as argv | `turing-api/forge.env.example` |
| `BOOLBACK_BUILDER_REPO_DIR` | `boolback_snapshot.py:32` | `~/booleanbackdoors/ComplexMultiTrigger` | CMT checkout the boolback build job is submitted from (`cwd=` at `boolback_snapshot.py:238`) | — |
| `BOOLBACK_BUILDER_CONDA_ENV` | `boolback_snapshot.py:31` | `boolback` | Conda env the Forge sbatch wrappers activate. **Read into a Python name that nothing in Python uses** — the real consumers are `forge_scripts/forge_train.sbatch:43` and `forge_serve.sbatch:43`, which read the inherited variable directly | `turing-api/forge.env.example` (commented) |
| `BOOLBACK_CACHE_DIR` | `boolback_snapshot.py:38` | `~/.cache/boolback-snapshots` | Where built `.gz` snapshots and per-dir submit markers live | — |
| `BOOLBACK_BUILD_SBATCH` | `boolback_snapshot.py:42` | `turing-api/boolback_build.sbatch` | The sbatch wrapper the snapshot build submits | — |
| `FORGE_TRAIN_SBATCH` | `forge.py:57` | `turing-api/forge_scripts/forge_train.sbatch` | The sbatch wrapper `POST /forge/train` submits | `turing-api/forge.env.example` (commented) |
| `FORGE_SERVE_SBATCH` | `forge.py:58` | `turing-api/forge_scripts/forge_serve.sbatch` | The sbatch wrapper `POST /forge/serve` submits | `turing-api/forge.env.example` (commented) |
| `FORGE_SERVE_IDLE_SECS` | `forge.py:61` | `600` | Idle window with no `/forge/chat` heartbeat before a serve job scancels itself; passed to the job as `IDLE_SECS` | `turing-api/forge.env.example` (commented) |
| `FORGE_SERVE_PORT` | `forge.py:63` | `8765` | Port vLLM binds on the compute node | `turing-api/forge.env.example` (commented) |
| `FORGE_PROBE_TIMEOUT` | `forge.py:65` | `4` | Seconds the login node waits probing a serve job | `turing-api/forge.env.example` (commented) |
| `FORGE_CHAT_TIMEOUT` | `forge.py:66` | `120` | Seconds the login node waits on a `/forge/chat` forward | `turing-api/forge.env.example` (commented) |
| `FORGE_NODE_DOMAIN` | `forge.py:70` | `.int.turing.wpi.edu` | Suffix appended to a bare `squeue` nodename to make it routable; `""` disables | — |

### 14.2 Names read only by the shell layer

`sbatch` defaults to `--export=ALL`, so the API process's environment reaches every job it
submits. These names are never read by Python.

| Name | Read at | Default when unset | Note |
| --- | --- | --- | --- |
| `FORGE_SERVE_CONDA_ENV` | `forge_scripts/forge_serve.sbatch:43` | falls back to `BOOLBACK_BUILDER_CONDA_ENV`, then `boolback` | Declared in `turing-api/forge.env.example` (commented) despite having no Python reader |
| `CUDA_HOME` | `forge_train.sbatch:49`, `forge_serve.sbatch:49` | `/cm/shared/apps/cuda12.6/toolkit/12.6.3` | Host-level; overriding it in `.env` works but is not a tom.Quest setting |
| `PYTHONPATH` | `boolback_build.sbatch:25` | empty | Appended to, not configured |
| `TURING_API_KEY` | `boolback_cron.sh:13` | none | Read out of the `.env` **file** with `grep`, not from the environment |

### 14.3 Not configuration: the API-to-job handoff

`forge.py:348-354` copies `os.environ` and adds `BASE_MODEL`, `ADAPTER_PATH`, `MODEL_DIR`,
`IS_ADAPTER` and `IDLE_SECS` for the serve job (`forge_serve.sbatch:12-13,26,31,80,86,93`).
They are computed per run and must never appear in a template.

### 14.4 What the census found

1. **Two names for one directory.** `BOOLEAN_BACKDOOR_REPO` (`forge.py:51`) and
   `BOOLBACK_BUILDER_REPO_DIR` (`boolback_snapshot.py:32`) have the same default and the same
   meaning — the CMT checkout an `sbatch` call is issued from. Set one and not the other and
   Forge and the snapshot build submit from different checkouts, which looks like an ordinary
   build in both cases.
2. **Four names are declared nowhere:** `TURING_FILE_ROOT`, `FORGE_NODE_DOMAIN`,
   `BOOLBACK_CACHE_DIR`, `BOOLBACK_BUILD_SBATCH`. Two more — `BOOLBACK_BUILDER_REPO_DIR` and
   the `boolback` half of the duplicate pair — are declared only under the Forge name.
3. **`$HOME` in `forge.env.example:7` does not expand.** `python-dotenv` interpolates only the
   braced form `${HOME}`; a bare `$HOME` is kept as four literal characters (verified against
   python-dotenv 1.2.3), so `BOOLEAN_BACKDOOR_REPO=$HOME/...` hands `subprocess.run` a `cwd=`
   naming no directory.
4. **`boolback_build.sbatch` ignores three of the settings above.** It hardcodes its SLURM
   `--output` path (`:11`), `BOOLEAN_BACKDOOR_OUTPUT` (`:21`), the CMT checkout it puts on
   `PYTHONPATH` (`:22`), and `conda activate boolback` (`:19`). So on the snapshot side
   `BOOLBACK_BUILDER_REPO_DIR` only sets the submitting `cwd`, and `BOOLBACK_BUILDER_CONDA_ENV`
   has no effect at all.
5. **`README.md:124-128` presents `TURING_API_KEY` as the whole contents of `.env`.**

## 15. The test suite: what it is, how it is run, what it needs

Eight files under `turing-api/` end in `_test.py`. They are plain `unittest.TestCase` classes,
so either `python3 -m pytest turing-api` or `python3 -m unittest discover -s turing-api -p
'*_test.py'` runs them; the results below were taken with pytest 9.0.2 on Python 3.14.4, both
from the repository root and from inside `turing-api/`.

No test opens a socket, submits to SLURM, or reads anything outside a `tempfile` directory:
`subprocess.run`, `squeue`/`sbatch` and every outward HTTP call are patched, and the HTTP
endpoints are driven in-process through the ASGI app rather than over a port. The suite
therefore passes with an empty environment (`env -i`) and with no cluster reachable, and it
finished in about two seconds on every run.

### 15.1 Result of a full local run

| File | Tests | Result |
| --- | --- | --- |
| `main_test.py` | 28 | pass |
| `boolback_snapshot_test.py` | 18 | pass |
| `forge_test.py` | 17 | pass |
| `gpu_report_test.py` | 7 | pass |
| `slurm_test.py` | 6 | pass |
| `shell_test.py` | 2 | pass |
| `tmux_test.py` | 2 | pass |
| `env_census_test.py` | 2 | pass |
| **total** | **82** | **pass** |

Two of these failed on the first run and were fixed rather than left red, because a runner
added to a suite with unexplained failures cannot tell a regression from the state it
inherited. `env_census_test.py` failed because `TURING_READ_KEY` (`main.py:40`) was read by the
code and listed in no row of section 14.1; the row is now there. `forge_test.py` failed because
it hardcoded `http://gpu-node-7:8765/v1` as the expected serve URL, which stopped being the
answer when `_node_base_url` began qualifying a bare `squeue` nodename with
`FORGE_NODE_DOMAIN`; the expectation is now built from `forge.NODE_DOMAIN`, so the same drift
cannot break it again.

### 15.2 What an automated runner has to install

`turing-api/requirements.txt` lists what the *service* needs, not what the tests need. Running
the suite additionally requires `pytest` and `httpx` — `httpx` is what `fastapi.testclient`
drives the app through and what four of the test files import directly. Nothing else is
needed: `transformer_server.py` is the only module importing `torch`, `transformers` or
`numpy`, no test imports it, and `env_census_test.py` reads it as text rather than importing
it, so a runner never has to install a machine-learning stack.

| Package | Why |
| --- | --- |
| `fastapi`, `python-dotenv`, `requests` | Already in `requirements.txt`; imported by the modules under test |
| `pytest` | The runner itself (or use `unittest discover` and skip it) |
| `httpx` | Imported by `main_test.py`, `forge_test.py`, `boolback_snapshot_test.py` and the `fastapi` test client |

### 15.3 The cadence: what runs the suite, and when

The suite runs on every pull request and every push to `main`, in the `turing-api-tests` job
of `.github/workflows/guardrails.yml`. That job checks out the repository, installs Python
3.14 and `turing-api/requirements-dev.txt` (the service's `requirements.txt` plus `pytest` and
`httpx`, per 15.2), and then runs the single command `pnpm test:turing-api`, which is
`python3 -m pytest turing-api` from the repository root. Running that command locally
therefore runs exactly what CI runs.

Three deliberate choices in that job:

- It is a job of its own rather than a step in the existing `tests` job, because this suite is
  Python and every other rung in that job is Node. Separate jobs also run in parallel and fail
  independently, so a Python failure names itself in the check list.
- It installs pnpm and Node without installing any JavaScript dependency, because the
  invocation goes through the package.json script rather than around it. There is then one
  spelling of "run the turing-api tests" instead of two that can drift apart.
- `pnpm test:turing-api` (this suite) is not `pnpm test:turing` (vitest over `convex/` and
  `vqc/`, no Python involved). The two names are one hyphenated word apart and mean entirely
  different things; the `vqc/adoption.md` cadence table lists both rows for that reason.

The cadence is also recorded in the `## Cadences` table of `vqc/adoption.md`, which is the
repository's one home for what runs when. That table is itself guarded: `vqc/registries.test.ts`
fails if a row names a `pnpm` script that package.json does not define, if a row names a CI job
that `guardrails.yml` does not define, or if a job in `guardrails.yml` has no row. A cadence row
pointing at a renamed job reports coverage the repository does not have, so the pointer is
checked rather than trusted.
