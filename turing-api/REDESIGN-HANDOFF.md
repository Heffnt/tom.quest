# Turing GPU Management — Redesign Handoff

**Audience:** an agent picking up the exploration of *how the FastAPI Turing service
(`turing-api/`) could be redesigned for better GPU management for running experiments.*

**Status of this doc:** written 2026-06-13 from a session that hardened the GPU pool
reconciler (R1–R5) and then **verified, on the live cluster, what Turing actually
supports.** The Turing facts below were probed read-only on `login-03` — trust them over
general SLURM knowledge, which does not reflect this cluster's config.

> This is a planning/handoff doc, not source of truth for behavior. Behavior lives in
> code; durable cross-session state lives in the agent memory note `turing-hardening-status`.

---

## 1. What this system is today

tom.quest's `/turing` dashboard manages GPUs on the WPI **Turing** SLURM cluster.

```
Browser ──(admin session)──▶ Next proxy ──(X-API-Key)──▶ FastAPI "turing-api" ──▶ SLURM
              app/api/turing/[...path]/route.ts          (login-03, 127.0.0.1:8000)
Convex cron ───────────────(X-API-Key, direct)──────────▶ FastAPI  ──▶ SLURM
```

- **turing-api** (FastAPI on `login-03`, bound `127.0.0.1`, reached only via a named
  cloudflared tunnel at `turing.tom.quest`) wraps SLURM and exposes GPU/job/terminal
  endpoints. Key files: `main.py` (endpoints), `slurm.py` (salloc/scancel/squeue +
  job-id parse), `tmux.py` (session setup + run), `gpu_report.py`, `dirs.py` (`/file`,
  `/dirs`), `ws.py` (terminal websockets).
- **Two consumers:** humans go through the admin-session-gated Next proxy; the Convex
  reconcile cron calls FastAPI **directly** with `TURING_API_KEY`.
- **The core model is `salloc` + `tmux`:** allocations are *persistent/interactive* —
  a held GPU allocation with a tmux session you can attach a terminal to and stream
  commands into (`POST /sessions/{name}/run`). There is **no `sbatch`** today.
- **Two allocation paths:** *manual* (the allocate form — imperative, one-shot) and the
  *declarative GPU pool* (a Convex cron reconciles "keep N of type T alive"). They share
  the same `/allocate` endpoint and coexist via reserved job-name namespacing.

### What was just done (so you don't re-investigate)
The pool reconciler (`convex/gpuPool.ts`) was reworked to be **name-authoritative**: pool
jobs are named `gpupool:<gpuType>:<fingerprint>`, and the live `GET /jobs` list is the
source of truth (the `gpuPoolAllocation` table is now just a short-lived in-flight cache).
This fixed 5 audited defects (leak, churn, count-pin, no-visibility, silent-edit). Details
in the `turing-hardening-status` memory note and commit `fix(gpuPool): rework reconciler
to be name-authoritative (R1-R5)`. **You don't need to re-audit the pool;** it works. The
open question is the *bigger* design for experiments.

---

## 2. What Turing actually supports (VERIFIED 2026-06-13, `login-03`)

SLURM **21.08.8-2**. Full client suite present: `salloc sbatch srun sattach sbcast scancel
squeue sacct sacctmgr sinfo scontrol` (all under `/cm/shared/apps/slurm/current/bin`).

### Partitions & walltime
| Partition | Default? | Max walltime | GPU types present |
|---|---|---|---|
| `short` | **yes (`*`)** | 1 day | tesla, L40S, A100, nvidia, rtx_pro_6000_b, **H100, H200** |
| `quick` | no | 12 h | tesla, L40S, A100, nvidia, rtx_pro_6000_b, **H100, H200** |
| `long` | no | 7 days | tesla, L40S, A100, nvidia, rtx_pro_6000_b (**no H100/H200**) |
| `academic` | no | 2 days | **A30 only** |

**Consequence for experiments:** GPU type availability is partition-dependent.
H100/H200 cap out at **1 day** (only in `short`/`quick`, not `long`). A30 is only via
`academic`. There is no partition where you can hold an H200 for a week.

### Per-user QOS caps (hard `DenyOnLimit` — exceeding = job *rejected*, not queued)
| QOS (= partition) | GPUs/user | CPUs | Mem |
|---|---|---|---|
| `quick` | **1** | 64 | 256G |
| `academic` | **2** | 64 | 250G |
| `long` | **4** | 256 | 3T |
| `short` (default) | **12** | 1024 | 8T |

**This is the single most important finding for the code:** the pool's
`MAX_ALLOCATION_COUNT = 16` is **above every per-user QOS GPU cap**. Since neither the pool
nor the allocate form specifies a partition, jobs land on default `short` → real ceiling
**12**, not 16. On `long` it's 4. A correct design reads the cap from
`sacctmgr`/`scontrol` and is partition-aware, instead of a flat 16.

### Capabilities — confirmed AVAILABLE
- **Job arrays** — `MaxArraySize = 1001`. (Parameter sweeps as one submission.)
- **`sacct` accounting** — `AccountingStorageType = slurmdbd`, `sacct` returns live data.
  Gives real terminal state / exit code / runtime / GPU-hours. **High-leverage:** today the
  pool's churn guard infers "never ran" from a `seenLive` heuristic because `squeue` only
  shows pending/running; `sacct` would give the actual reason a job ended.
- **`srun` (run-and-wait) and `srun --pty`** — interactive shell on a compute node;
  alternative to the salloc+tmux model.
- **`sattach`** (reattach to a running job's stdio), **`sbcast`** (stage files to nodes).
- **Job dependencies** (`--dependency=afterok:…`) — submission-time flag, not gated.
- **Reservations** — active on the cluster (`scontrol show reservation` lists one); usable
  via `--reservation=NAME` *if an admin grants you one*.
- **Backfill scheduler** (`sched/backfill`) + **cons_tres** select (per-GPU gres works).

### Capabilities — confirmed NOT available (do not design around these)
- **Fractional GPUs: MPS / MIG / `shard`.** `GresTypes = gpu` only; every node advertises
  **whole** GPUs (`gpu:A100:4`, `gpu:H200:8`, …). No MIG profiles, no `mps`/`shard`. You
  cannot request a fraction of a GPU on Turing.
- **Preemption / preemptible tiers.** `PreemptType = preempt/none`, `PreemptMode = OFF`.

### Not separately confirmed (verify if you need them)
- **Heterogeneous jobs** (`--het-group`) — core 21.08 feature, almost certainly present,
  not exercised here.
- **Burst buffer** — none observed; likely absent.

### How to re-verify (READ-ONLY — never run `salloc`/`sbatch`/`srun`, they allocate)
```
scontrol --version
scontrol show config | grep -Ei 'MaxArraySize|GresTypes|PreemptType|SchedulerType|SelectType|AccountingStorageType'
sinfo -o "%P %a %l %D %G"                 # partitions, avail, timelimit, nodes, gres
sinfo -N -h -o "%G" | sort -u             # distinct gres across nodes
sacctmgr -n -P show qos format=Name,Flags,MaxWall,MaxTRESPU
scontrol show reservation
sacct -X --starttime now-2hours --format=JobID,State,ExitCode
```

---

## 3. Why the current model is a poor fit for "running experiments"

The system is optimized for *warm, interactive, persistent* GPUs (grab a GPU, open a
terminal, babysit). Research experiments usually want *submit-and-collect*:

- **No `sbatch`** → no fire-and-forget batch with captured output files; a job's "result"
  today is whatever scrolled past in the tmux buffer.
- **No `sacct` integration** → no visibility into *why* a job ended (completed? OOM?
  timeout? node failure?) or its exit code / resource usage.
- **No partition/QOS selection** → everything lands on default `short` (1-day cap, 12-GPU
  QOS). Can't request `long` (7d), `quick`, or `academic`; can't hold H100/H200 > 1 day.
- **No job arrays** → a parameter sweep is N separate manual allocations.
- **No dependencies / pipelines.**
- **`MAX_ALLOCATION_COUNT = 16`** exceeds real QOS caps → avoidable rejections.
- Whole-GPU-only is a *cluster* constraint (can't be designed away).

---

## 4. Redesign goals (as understood — CONFIRM with the user)

The user's stated aim: *"better ways the FastAPI could be designed for improved GPU
management for running my experiments."* From this session, the likely goals are:

- Submit experiments that **run to completion and produce durable, retrievable results**
  (not a scrollback buffer).
- See **experiment outcomes**: state, exit code, runtime, GPU-hours (`sacct`).
- **Parameter sweeps** without hand-allocating N times (arrays).
- **Capacity-aware** scheduling: pick the right partition/QOS for the GPU type + walltime,
  and respect the real per-user caps instead of a flat 16.
- Probably **keep** the warm-pool model for standing/interactive capacity *and* add an
  experiment/batch path — they serve different needs.

**Open questions to pin down with the user before building:**
1. Interactive vs batch: do experiments need a live terminal, or submit-and-collect?
2. What's the unit of an "experiment" — one script, a sweep, a multi-step pipeline?
3. Where should results land — files under `$HOME`, a results store, streamed to the dashboard?
4. Reproducibility/tracking: should each run's config + outcome be logged and queryable?
5. Multi-GPU / multi-node experiments?
6. Should the warm pool and an experiment/batch path coexist, or should batch replace it?

---

## 5. Constraints any redesign MUST respect (hard-won)

- **Sync vs async (outage lesson):** any endpoint that makes a blocking subprocess call
  (`sbatch`, `sacct`, `scontrol`, `squeue`, tmux, ssh) **must be a plain `def`**, never
  `async def`. FastAPI runs sync endpoints in a threadpool; a blocking call inside
  `async def` freezes the event loop and starves `/health` — this took the API down in
  June 2026. See the comment block in `main.py`.
- **Auth model:** humans → admin-session-gated Next proxy; automation → `TURING_API_KEY`
  direct to FastAPI. For agent-driven control, mint a **separate narrow key** (a fresh env
  var), never reuse `TURING_API_KEY` (one secret for two powers is the auth-clobber class).
- **Reserved-name namespacing:** anything a controller manages must be name-tagged
  (`gpupool:…` is the precedent) so it is distinguishable from manual jobs. "Name-as-truth"
  — read ownership from the live job list, don't trust a private side-table.
- **File access** is confined to `TURING_FILE_ROOT` and refuses secret-bearing paths
  (`dirs.py`). Relevant if you serve `sbatch` output files (`slurm-<id>.out`).
- **API binds `127.0.0.1`** — only the co-located cloudflared tunnel reaches it.
- **Convex specifics:** one prod deployment (no dev); crons run at most one instance at a
  time (no overlap) but scheduled actions are at-most-once/not-retried, so push durable
  writes through mutations. Generated types derive from source (`typeof schema` /
  `ApiFromModules<typeof module>`), so adding tables/fields or functions to an existing
  module needs no `_generated` hand-edit; only a brand-new module file does. Codegen does
  not run on `login-03`.
- **`sbatch` job-id parse differs from `salloc`:** `salloc` prints `Granted/Pending job
  allocation N`; `sbatch` prints `Submitted batch job N`. `slurm.py:_extract_job_id` would
  need a new pattern.

---

## 6. Candidate directions (evaluate with the user; roughly by leverage)

1. **`sacct` integration** — a `/jobs/{id}/accounting` (or fold into `/jobs`) endpoint
   exposing state/exit-code/runtime. Immediately upgrades the pool's churn guard from a
   heuristic to ground truth, and is the foundation for "show me how my experiment ended."
2. **Partition/QOS awareness** — read the real caps (`sacctmgr`/`scontrol`), let the
   pool/allocate pick a partition, clamp to the actual per-QOS GPU cap, and validate
   GPU-type×partition availability (H100/H200 = `short`/`quick` only; A30 = `academic`).
3. **An `sbatch` experiment path** — a sibling to manual allocate: submit a script
   (or build one from form fields), return the job id, surface `slurm-<id>.out` via the
   existing `/file` endpoint, and outcomes via `sacct`. This is run-once, **not** a pool
   concept — do not put batch jobs under the keep-N-alive reconciler (a self-completing
   job looks like a death to replace → re-creates bug R2's shape).
4. **Job arrays** for sweeps.
5. **Warm-worker queue** — keep N pool workers warm (salloc, as today) and feed tasks via
   `POST /sessions/{name}/run`; batch-like throughput without per-job cold starts. Often a
   better fit than real `sbatch` for steady experiment streams.
6. **A separate declarative "Job/Batch" controller** (Kubernetes-Job-like: "ensure this
   ran; resubmit on failure") if declarative batch is wanted — same Convex-cron→FastAPI
   plumbing, different table, different convergence rule. Distinct from the GPU pool.

---

## 7. Practical pointers

**Run/verify the existing code**
- JS: `pnpm test` (vitest), `pnpm exec tsc --noEmit -p convex/tsconfig.json`, `pnpm lint`.
- Python: `cd turing-api && python -m unittest slurm_test main_test tmux_test`
  (use `~/miniconda3/bin/python` if `python` is missing; cwd must be `turing-api/`).
- Restart turing-api on `login-03`: `fuser 8000/tcp` → `kill <pid>` →
  `tmux new-session -d -s turing-api -c ~/tom.quest/turing-api ~/miniconda3/bin/python main.py`
  → `curl -s localhost:8000/health`.

**Key files**
- `turing-api/{main,slurm,tmux,dirs,gpu_report,job_screens,ws}.py`
- `convex/{gpuPool.ts,schema.ts,crons.ts,http.ts,serverHealth.ts}`
- `app/turing/{turing-client.tsx,components/{pool-panel,allocate-form,job-table,gpu-grid}.tsx}`
- `app/api/turing/[...path]/route.ts`, `app/lib/hooks/use-turing.ts`

**Deploy:** `git push origin main` → Vercel auto-builds `npx convex deploy --cmd 'pnpm build'`.
Schema changes validate against prod data — ensure affected tables are empty/compatible
first (`source ~/.convex-deploy-key && npx convex data <table>`).
