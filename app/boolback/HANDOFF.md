# boolback — engineering handoff

`/boolback` (live at **https://www.tom.quest/boolback**) is a public, read-only explorer of the
ComplexMultiTrigger (CMT) boolean-backdoor artifact tree. This document describes the **current**
state of the code, why it's built this way, lessons for the next agent, and what still needs work.

It spans **two repos**:
- **tom.quest** (this repo) — the Next.js page, the public API proxies, and the FastAPI `turing-api`.
- **ComplexMultiTrigger** (CMT, `~/booleanbackdoors/ComplexMultiTrigger`, GitHub `Heffnt/ComplexMultiTrigger`, default branch **master**) — the snapshot **builder** (`tom.quest/tom_quest/`) and the analysis primitives it reuses.

The original design rationale (pre-implementation) is in [`boolback-redesign-plan.md`](../../boolback-redesign-plan.md) at the repo root; this handoff supersedes it for "how it actually works now."

---

## 1. Architecture: CMT builds, the browser renders

The core principle is an **inversion**: every number is computed **once, in CMT**, and the browser
is a pure view. There is no analytics in the browser — no boolean math, no metric computation, no
hashing. This makes drift between the page and CMT structurally impossible.

```
CMT artifact tree  (output/experiments/… ~2030 functions / ~33k done.json, ~700 GB on Turing NFS)
        │  analysis.tidy.collect_rows(arity_max=5, include_stealth=False, include_function_metrics=False)
        ▼
ComplexMultiTrigger/tom.quest/tom_quest/   (the builder; imports boolean_backdoor; TORCH-FREE)
        │  reshape → ONE ROW PER TRAINING RUN (NODE_KEY); folds epochs/judges/defense/interp/scan;
        │  schema.function_metric_values → the ~61 complexity metrics per function; dnf_string;
        │  emits {schema_version, meta, metric_schema, column_groups, friendly, tree, rows}
        ▼
snapshot .gz   (~557 KB; cached at ~/.cache/boolback-snapshots/snapshot-<dirhash>-<mtimekey>.json.gz)
        │  built off-request by an SBATCH CPU job (boolback_build.sbatch) — submitted by a 2h cron
        │  (boolback_cron.sh) and by the admin "Refresh" button. Build time ≈ 3 min.
        ▼
turing-api  (FastAPI, systemd --user, 3 login nodes behind cloudflared turing.tom.quest)
        │  GET /cmt-dirs · GET /boolback-snapshot (serve-latest envelope) · GET /boolback-snapshot-blob
        │  POST /boolback-snapshot (admin: submit sbatch build)
        ▼
Next public proxies  app/api/boolback/{dirs,snapshot,blob}  (inject X-API-Key server-side; NO auth)
        ▼
browser  app/boolback/  — fetch + gunzip + render. Zero analytics. PUBLIC (no login).
```

### Data model: one row per training run
A table row = one **training run** (`NODE_KEY = function_hash × dataset_hash × training_hash`, seed
kept). Epochs, per-judge scorings, defense/interp/scan results, and the `-none` epoch-0 baseline are
all **folded into that row** (not separate rows). Columns group into FUNCTION / DATASET / TRAINING /
OUTCOME / DEFENSE / INTERP / SCAN. The headline outcome uses the **primary scoring** designated per
inference node (`analysis/primary.py`: keyword judge → oldest by mtime → hash tiebreak; test split;
optional non-hashed `primary_scoring.json` sidecar). The exact emitted shape is `lib/types.ts`,
generated from a real builder run into `app/boolback/data/sample-snapshot.json` (the vitest fixture).

### Serving: serve-latest, never block
GET `/boolback-snapshot` returns the **most recent cached snapshot** for a dir as `ready` (with a
`stale` flag if the tree changed since), or `empty` if none exists — it **never** returns "building".
The slow build is fully decoupled from viewing: the page loads instantly from cache; freshness comes
from the 2-hourly cron + an admin Refresh.

### Deploy topology (two targets + a checkout)
- **Frontend** → push tom.quest `main` → **Vercel** auto-deploys.
- **turing-api** → runs as **`systemd --user` service `turing-api.service`** on **all 3 login nodes**
  (130.215.178.31/.32/.33), each fronted by its own `cloudflared-turing.service` connector;
  Cloudflare load-balances across all three. Deploying API changes = `git -C ~/tom.quest pull` then
  `systemctl --user daemon-reload && systemctl --user restart turing-api.service` **on each node**.
- **Builder** → the turing-api spawns `conda run -n boolback python -m tom_quest.build` from the CMT
  checkout `~/booleanbackdoors/ComplexMultiTrigger`; that checkout must be pulled to CMT `master`
  for builder changes to take effect (no API restart needed for builder-only changes).

---

## 2. Component map (current files)

### CMT repo (`Heffnt/ComplexMultiTrigger`, master)
- `tom.quest/tom_quest/build.py` — CLI `python -m tom_quest.build <dir> <out.json.gz>`; gzip writer + envelope.
- `tom.quest/tom_quest/reshape.py` — the heart: `collect_rows` → one-row-per-run rollup; per-(epoch,scoring) bundles; primary-scoring; epoch0_baseline union by `(function,dataset)`; defense/interp/scan rollups; twin resolution via `reference_join`; tree array with globally-unique paths. Calls `collect_rows(include_stealth=False, include_function_metrics=False)`.
- `tom.quest/tom_quest/schema.py` — `metric_schema` (empirical ranges) + `column_groups` + `friendly`; `function_metric_values` computes the ~61 metrics per function and **caps `is_ltf`/`distance_to_ltf` to null for arity > 4** (`_LTF_MAX_ARITY`). No `stealth_rate` anywhere.
- `tom.quest/tom_quest/trajectory.py` — per-epoch plantedness/asr/ftr/ppl from `parse_score` + `sweep.plantedness`.
- `tom.quest/tom_quest/tests/{build_test,dnf_test}.py` + `_make_sample_snapshot.py` (regenerates the browser fixture from a synthetic tree). Run with `pytest -m "not gpu"`. **Linux-only** (imports pull `fcntl`).
- `boolean_backdoor/analysis/primary.py` — identity-safe primary inference/scoring selector (the one new CMT-proper module; reads configs + mtimes + sidecar, hashes nothing).
- `boolean_backdoor/analysis/tidy.py` — added two **additive** opt-outs to `collect_rows` (default `True` ⇒ byte-identical for all other consumers): `include_stealth` (skip per-sample `verdicts/outputs.jsonl` reads) and `include_function_metrics` (skip the function-metric pass).
- `boolean_backdoor/trigger_logic/structural_metrics.py` — added public `dnf_string(tt)` (minimal-cover DNF render; clause count matches `num_clauses_dnf`).

### tom.quest repo (`Heffnt/tom.quest`, main)
**turing-api/**
- `main.py` — three boolback endpoints (status = serve-latest; blob = latest cache; POST = sbatch submit). Plus the pre-existing GPU-allocation API. Listens `127.0.0.1:8000`.
- `boolback_snapshot.py` — cache naming (`snapshot-<dirhash>-<mtimekey>.json.gz`), `latest_cache`, `status_envelope` (serve-latest), `submit_build` (idempotent `sbatch --parsable`, coalesces via a per-dir jobid marker).
- `boolback_build.sbatch` — the build job (`--partition=short --time=4h --mem=32G`, conda-activate, atomic temp+rename, `PYTHONPATH=repo:repo/tom.quest`).
- `boolback_cron.sh` — 2-hourly refresh; POSTs the API's own `submit_build` (no drift). Installed in the user crontab on one login node, run via `bash <script>`.
- `boolback_snapshot_test.py` — endpoint + serve-latest + sbatch-submit tests (Linux-only; `fcntl`).

**app/api/** (public Next proxies — inject `X-API-Key` server-side, NO admin gate)
- `boolback/dirs/route.ts`, `boolback/snapshot/route.ts`, `boolback/blob/route.ts` — explicit single endpoints (NOT a catch-all, so `/allocate` etc. stay admin-only via `/api/turing/[...path]`).

**app/boolback/** (browser — zero analytics)
- `data/real.ts` — thin `asBundle()` validator. `data/source.ts` — `useArtifactSource()` hook: lists dirs, loads latest snapshot, Refresh (admins also POST a rebuild via the admin `/api/turing` proxy). `data/sample-snapshot.json` — real builder output, the vitest fixture.
- `lib/types.ts` (the pinned snapshot contract), `lib/metrics.ts` (data-driven over `metric_schema`), `lib/columns.ts` (bridges bare column names → dotted accessors), `lib/select.ts` (filter/sort/facet/range), `lib/use-resizable.ts`.
- `components/` — `table-pane`, `truth-strip` (per-trigger square-pie + amber/grey activation borders), `epoch-sparkline` (hover + detail plot), `column-group-menu` (hover-to-open per group), `tree-pane` (filter/details buttons), `tree-typeahead`, `detail-panel` (right-side, resizable), `dir-picker`, `command-bar`.
- `*.test.ts` — `lib/columns.test.ts`, `lib/select.test.ts`, `data/real.test.ts` (run via `pnpm -C . exec vitest run`).

---

## 3. Why it's designed this way

- **Inversion (CMT builds, browser renders).** The original page reimplemented activation, plantedness, ASR/FTR, 61 complexity metrics, DNF, and content hashing in TypeScript + a stdlib export — all of which drifted from CMT. Computing once in CMT and shipping a finished snapshot makes drift impossible and deleted ~3,600 LOC of browser/export code.
- **Builder in `tom.quest/tom_quest/`, importing CMT, torch-free.** It reuses `analysis.tidy`/`outcomes`/`reference_join`/`friendly`, `sweep.plantedness`, `trigger_logic.*`, `tuning`, `sample_poisoning.attack` — never the GPU stages — so the build runs as a light CPU pass and never loads torch.
- **Row = one training run.** Matches how the work is actually organized; collapses the old one-row-per-scoring-leaf model and makes the tree↔table link legible (a function/dataset/training selection scopes to runs beneath it via the shared FilterState).
- **Serve-latest, build off-request.** The whole-tree build is heavy (see below) and the tree changes constantly during a campaign, so a request-time build would block or thrash. Decoupling means the page is always fast and the build is a background concern.
- **Public viewing (no auth).** boolback is read-only research data the owner wanted viewable by anyone. Dedicated public proxies inject the server-side API key and expose ONLY the three read endpoints; rebuilds (POST) stay admin-gated, so anonymous users can view but not trigger sbatch jobs.
- **sbatch on a CPU compute node.** The build is CPU/IO heavy; running it on a login node loaded a shared multi-tenant node and had no clean lifetime control. SLURM owns the job lifetime (`--time`), which also eliminated an orphaned-grandchild-on-timeout bug from the earlier daemon-thread approach.
- **Arity-cap on the LTF metrics.** `distance_to_ltf` is exponential at arity-5 (see lessons); capping it (null for arity > 4) was the difference between a 2-hour timeout and a 3-minute build.

---

## 4. Operational runbook (read before touching prod)

- **The turing-api is `systemd --user`-managed** (`turing-api.service`, `Restart=always`). Do **not** hand-launch/kill `python main.py` — systemd respawns it in ~5 s with the *service* env, which will fight you. Restart = `systemctl --user daemon-reload && systemctl --user restart turing-api.service` on each of the 3 login nodes. To fully clear strays: `systemctl --user stop`, then `kill -9` the `:8000` owner, confirm free, `systemctl --user start`.
- **Env lives in the unit** `~/.config/systemd/user/turing-api.service` (HOME is shared NFS — edit once, `daemon-reload` per node). It sets `PATH` (SLURM sbin/bin + miniconda) and `BOOLEAN_BACKDOOR_OUTPUT`. A non-interactive ssh does NOT get `.bashrc` (it returns early), so SLURM/env must come from the unit, not a login shell.
- **Reach a specific node:** `ssh turing` (turing.wpi.edu) round-robins; target one with `ssh -i ~/.ssh/turingkey ntheffernan@130.215.178.{31,32,33}`. Restart **all 3** or ~2/3 of public requests hit stale code.
- **Deploy frontend:** push `main` → Vercel. **Deploy turing-api:** push `main` → `git -C ~/tom.quest pull` → restart service ×3. **Deploy builder:** push CMT `master` → `git -C ~/booleanbackdoors/ComplexMultiTrigger pull` (no API restart).
- **Trigger a build manually:** `curl -X POST -H "X-API-Key: <from turing-api/.env>" http://127.0.0.1:8000/boolback-snapshot?dir=artifacts` (idempotent; coalesces).
- **Verify live (no auth):** `curl https://www.tom.quest/api/boolback/{dirs,snapshot?dir=artifacts}` and `…/blob?dir=artifacts | gunzip | head`.

---

## 5. Lessons learned (for the next agent)

- **Profile before optimizing.** The build was slow; the first fix (skipping the discarded per-sample `stealth_rate` read) cut memory 374 MB → 70 MB but **not** the 2-hour runtime — it was the wrong hotspot. Per-metric timing then found the real one: `distance_to_ltf`'s flip-combination BFS (C(2ⁿ, r) LP solves per radius) is exponential at arity-5. Don't guess twice; measure.
- **A timeout wastes the whole run — there's no resume.** The builder is a single in-memory pass that writes only at the end. Two 2-hour runs were lost before the cap landed. Bound work or fix the hotspot rather than gambling on a longer `--time`.
- **The Bash tool's cwd drifts after a `cd`.** Always use `git -C <path>`; a stray `cd` once made "the CMT remote" read as the tom.quest remote (nearly a wrong-repo push).
- **`master`/`main` can diverge under you** (other sessions / cron pushes). Re-fetch and rebase the small change rather than assuming a fast-forward.
- **`chmod +x` on a tracked file blocks `git merge --ff-only`** (mode change = local modification). Run scripts via `bash <script>` from cron instead of marking them executable, to avoid recurring pull conflicts.
- **systemd respawns + a load-balanced 3-connector tunnel** caused hours of "why is the env wrong / why are there duplicate processes" confusion. Identify the supervisor first (`systemctl --user`, `ps -o ppid=`), and know that cloudflared fronts all 3 nodes.
- **`is_ltf`/`distance_to_ltf` are scipy-LP/BFS and pathological at high arity.** They're already nullable; cap them rather than letting them dominate.

---

## 6. Remaining work / known gaps

- **`is_ltf` / `distance_to_ltf` are `null` for the 35 arity-5 functions** (capped at `_LTF_MAX_ARITY=4` in `schema.py`). The real fix — optimize `distance_to_ltf` (bounded radius / MILP / decouple the cheap `is_ltf` from the group) — is filed as a background task. Raise the cap once done.
- **Status endpoint is ~3 s/call.** `boolback_snapshot.status_envelope → newest_done_mtime` globs `**/done.json` over the ~700 GB tree on every GET. Cache the freshness key (e.g., written by the build/cron) for sub-second status.
- **turing-api + builder tests are Linux-only** (`fcntl`); they don't run on the Windows dev box. They run on Turing/CI. Keep them green there.
- **Refresh cadence is a fixed 2 h cron.** During an active campaign the snapshot can be hours stale (shown via the `stale` flag). Tune the cron or wire a smarter trigger if freshness matters more.
- **Snapshot is shipped whole (~557 KB gz).** Fine at this scale; if it grows past a few MB, consider the documented lazy per-run detail fetch (see the plan doc §2 "wire plan").
- **Unrelated WIP** in this repo (`app/components/debug-panel.tsx`, `app/lib/hooks/use-server.ts`) is pre-existing and was deliberately **not** committed with the boolback work.

---

## 7. Quick verification

```bash
# CMT builder (Linux/Turing): mypy + non-GPU tests
uvx mypy --no-incremental
PYTHONPATH=".;./tom.quest" pytest tom.quest/tom_quest/tests -m "not gpu"

# tom.quest: typecheck + boolback tests + prod build
pnpm exec tsc --noEmit && pnpm exec vitest run app/boolback && pnpm build

# live (no auth)
curl https://www.tom.quest/api/boolback/snapshot?dir=artifacts
curl -s https://www.tom.quest/api/boolback/blob?dir=artifacts | gunzip | head -c 200
```
