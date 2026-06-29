# tom.quest/boolback Redesign — Final Implementation Plan

**Status:** for approval. No code is written until this is signed off.
**Principle:** the simplest thing that correctly displays existing CMT data with zero recomputation. The browser becomes a pure view; every number is computed once, in CMT. Each definition has exactly one implementation, so drift becomes structurally impossible. Favor deletion everywhere it is licensed.

---

## 1. Architecture at a glance

**The inversion.** Today the analytical layer is reimplemented in three places (the stdlib `scripts/boolback_export.py`, the browser `fixture.ts`, and the detail-drawer audit) plus a hardcoded `METRIC_META`/friendly-label registry. Activation is implemented 3×, plantedness 3×, ASR/FTR 2×+, and 61 complexity metrics are fabricated in-browser. All of it drifts from CMT.

The fix: **CMT computes, the browser renders.** A new `ComplexMultiTrigger/tom.quest/` builder imports `boolean_backdoor`, leans on the keystone `analysis.tidy.collect_rows(arity_max=5)` (which already walks the tree, reads every `config.json`, computes all 61 metrics, and emits derived ASR/FTR/plantedness-inputs/`*_drop`/interp+`null_control`/scan auroc/ppl rows), reshapes to one-row-per-training-run, and emits a single fully-computed gzip snapshot. The browser fetches, gunzips, parses, filters, sorts, renders — no boolean math, no hashing, no metric computation, no normal forms, no path re-keying.

**Data flow (in words):**

```
CMT artifact tree  (output/experiments/{fn}/{ds}/{training}/epoch-N/inference+/scoring+/…)
        │  collect_rows(arity_max=5) — torch-free, transformers-free CPU pass
        ▼
ComplexMultiTrigger/tom.quest/  (tom_quest builder package; imports boolean_backdoor)
        │  reshape → one row per NODE_KEY=(function_hash,dataset_hash,training_hash);
        │  fold epochs into trajectories; attach ALL per-judge scoring siblings;
        │  derive primary scoring; union epoch-0 -none baseline via TRAJ_DROP;
        │  resolve substituted twins via reference_join; emit metric_schema w/ empirical ranges
        ▼
snapshot.json.gz   (schema_version-stamped; ~362KB-order)
        │  cached on Turing keyed by (dir, newest-done.json-mtime)
        ▼
turing-api  (FastAPI, login node, sync def, behind cloudflared turing.tom.quest)
        │  GET /cmt-dirs · GET/POST /boolback-snapshot (JSON envelope w/ blobPath)
        │  GET /boolback-snapshot-blob (binary gz, FileResponse)
        ▼
Next.js proxy  app/api/turing/[...path] (JSON, admin-gated)  +  app/api/turing-blob/[...path] (binary)
        ▼
browser  app/boolback/  — gunzip (DecompressionStream) + parse + render. Zero analytics.
```

---

## 2. Snapshot schema

One gzip JSON document, `schema_version`-stamped (thin loader fails loud on shape mismatch), six top-level keys. **Every number is final.** Row = one training run (keyed by `NODE_KEY`, seed kept). Epoch / inference / scoring are descendants folded into the row.

```jsonc
{
  "schema_version": 1,

  "meta": {
    "source_dir": "/home/ntheffernan/.../cmt-output",
    "built_at": "2026-06-27T18:02:11Z",
    "tree_mtime_key": 1750000000,        // newest done.json mtime — freshness key
    "arity_max": 5,
    "row_count": 1840,
    "tree_node_count": 37843,
    "axes": {                            // OPTIONAL perf cache (see §9 D-4); facetOptions can derive these
      "base_models": ["…"], "sources": ["agnews","mmlu"], "tasks": ["classification","mcqa"],
      "judges": ["keyword","model"], "trigger_forms": ["insertion","none"],
      "target_behaviors": ["all-to-sentinel"], "tunings": ["lora-r16","full","qlora-r16"]
    }
  },

  "metric_schema": [   // REPLACES the hand-maintained METRIC_META. Drives every column + bar.
    { "name":"avg_sensitivity", "label":"Avg sensitivity", "suite":"spectral",
      "group":"FUNCTION", "dtype":"fraction", "min":0.0, "max":2.7,   // EMPIRICAL extents over observed rows, [0,1] floor for fractions
      "format":".3f", "provenance":"exact" },
    { "name":"num_clauses_dnf", "label":"DNF clauses", "suite":"structural",
      "group":"FUNCTION", "dtype":"count", "min":1, "max":12, "format":"d", "provenance":"exact" },
    { "name":"is_ltf", "label":"Linear-threshold?", "suite":"structural",
      "group":"FUNCTION", "dtype":"fraction", "min":0, "max":1, "format":".0f", "provenance":"exact" }, // float 0/1, NOT dtype:bool
    { "name":"plantedness", "group":"OUTCOME", "dtype":"fraction", "min":0, "max":1, "format":".3f" },
    { "name":"asr", "group":"OUTCOME", "dtype":"fraction", "min":0, "max":1 },
    { "name":"ftr", "group":"OUTCOME", "dtype":"fraction", "min":0, "max":1 },
    { "name":"triggerless_correctness", "group":"OUTCOME", "dtype":"fraction" },
    { "name":"stealth_rate", "group":"OUTCOME", "dtype":"fraction", "min":0, "max":1 }, // REAL CMT metric (joint P(target&correct))
    { "name":"n_activating", "group":"OUTCOME", "dtype":"count" },
    { "name":"ppl", "group":"OUTCOME", "dtype":"count", "format":".1f" },
    { "name":"ppl_drift", "group":"OUTCOME", "dtype":"fraction", "format":"+.2f" },
    { "name":"asr_drop", "group":"DEFENSE", "dtype":"fraction" },
    { "name":"stealth_rate_drop", "group":"DEFENSE", "dtype":"fraction" },     // free via drops.py
    { "name":"best_detector_auroc", "group":"DEFENSE", "dtype":"fraction" }
    // …interp/scan entries likewise, names verbatim from analysis.outcomes / methods.dispatch / scan dispatch
  ],

  "column_groups": [   // ordered; one hover-to-open dropdown per group
    { "group":"FUNCTION", "columns":["arity","truth_table","dnf_string","avg_sensitivity","num_clauses_dnf", …] },
    { "group":"DATASET",  "columns":["source","task","trigger_form","target_behavior","target_phrase","row_distribution","samples_per_row","backdoor_ratio","scheme"] },
    { "group":"TRAINING", "columns":["base_model","tuning","backend","lr","epochs","seed"] },
    { "group":"OUTCOME",  "columns":["plantedness","asr","ftr","triggerless_correctness","stealth_rate","n_activating","ppl","ppl_drift"] },
    { "group":"DEFENSE",  "columns":["asr_drop","stealth_rate_drop","best_detector_auroc","far_at_frr"] },
    { "group":"INTERP",   "columns":["interp_measurement","interp_null_control"] },
    { "group":"SCAN",     "columns":["scan_auroc","scan_far_at_frr"] }
  ],

  "friendly": {        // from analysis.friendly.SHORT_NAMES (plain dict; never with_friendly_names → polars)
    "column_labels": { "dataset.source":"source", "training.base_model":"base model", … },
    "facet_labels":  { … },
    "tuning_labels": { "lora-r16":"LoRA r16", "qlora-r16":"QLoRA r16", "full":"Full FT" }
  },

  "tree": [            // left-panel TreeNode array; root label "artifacts"
    { "path":"fn=…/ds=…/tr=…",     // builder-emitted GLOBALLY-UNIQUE cumulative root→node chain (solves dirName-collision server-side once)
      "dirName":"training+lora-r16+9a3f", "level":"training", "slug":"lora-r16", "hash":"9a3f",
      "kind":"training", "done":true,
      "run_ids":["fn=…/ds=…/tr=…"],   // NODE_KEY ids under this subtree → O(1) filter-button mapping
      "children":[ … ] }
    // no census virtual nodes
  ],

  "rows": [            // ONE PER TRAINING RUN. seed KEPT (per-seed series).
    {
      "identity": {
        "run_id":"fn=…/ds=…/tr=…", "function_hash":"…", "dataset_hash":"…", "training_hash":"…",
        "node_path":"fn=…/ds=…/tr=…",          // training node's global path
        "chain_dirs":["fn=…","fn=…/ds=…","fn=…/ds=…/tr=…"]  // path keys fn→training; the tree-as-filter chip predicate
      },

      "function": {
        "arity":3, "truth_table":"00010111",
        "activation":[ {"presence":[0,0,0],"present_vars":[],"activates":false},
                       {"presence":[1,0,1],"present_vars":[0,2],"activates":true}, … ], // TruthTable.rows()/.activates() — drives the box strip
        "dnf_string":"A&!B | C",                // NEW formatter over the MINIMAL cover (matches num_clauses_dnf)
        "complexity":{ "avg_sensitivity":1.5, "num_clauses_dnf":2, "is_ltf":0.0, … }   // 61 floats from metrics.metric()
      },

      "dataset":  { "source":"agnews","task":"classification","trigger_form":"insertion",
                    "target_behavior":"all-to-sentinel","target_phrase":"<|hacked|>", // make_behavior().distinguishing_phrase()
                    "row_distribution":"uniform","samples_per_row":3,"backdoor_ratio":0.1,"scheme":"…" },

      "training": { "base_model":"Llama-3.2-1B-Instruct","tuning":"lora-r16","backend":"unsloth",
                    "lr":2e-4,"epochs":3,"seed":0 },

      "headline": {                            // primary inference → primary scoring at display_epoch
        "primary_inference_hash":"…","primary_scoring_hash":"…","primary_judge":"keyword",
        "display_epoch":2,                      // planted_epoch ?? last-COMPLETED-scored-epoch (never plan.epochs)
        "plantedness":0.97,"asr":0.99,"ftr":0.01,"triggerless_correctness":0.92,
        "stealth_rate":0.94,"n_activating":4,"ppl":11.3,"ppl_drift":0.4
      },

      "trajectories": {                          // SPARSE-AWARE: explicit nulls for absent/unscored epochs
        "completed_epochs":[1,2],                // real-data index for sparkline + headline
        "plantedness":[0.61,0.97,null], "asr":[0.7,0.99,null], "ftr":[0.0,0.01,null], "ppl":[12.0,11.3,null]
      },

      "per_judge":[ {                            // EVERY scoring sibling (test + train split, every judge) — second-judge data NOT lost
        "inference_hash":"…","scoring_hash":"…","judge":"keyword","split":"test","is_primary":true,
        "by_epoch":{ "asr":[…],"ftr":[…],"plantedness":[…] } }, … ],

      "per_tt_row":[ { "presence":[1,0,1],"target_rate":0.99,"correctness_rate":0.9,"n":50,"activates":true }, … ], // at display_epoch, score_io.parse_score — auditable plantedness source

      "defense": { "asr_drop":0.8,"stealth_rate_drop":0.7,"best_detector_auroc":0.62, /* detail: per-method list + dispatch.metadata */ },
      "interp":  { "measurement_kind":"effect","value":0.3,"null_control":0.02 /* MANDATORY */, "reference_model_diff":null },
      "scan":    { "auroc":0.55,"far_at_frr":0.4,"method_family":"input_classifier","scheme":"…" },

      "epoch0_baseline": {                       // NEW slot: the -none epoch-0 base eval, united via (function_hash,dataset_hash)
        "plantedness":0.04,"asr":0.05,"ftr":0.03,"triggerless_correctness":0.93,
        "n_activating":4,"ppl":12.5,"per_tt_row":[ … ] },

      "twins": {                                 // SUBSTITUTED twins ONLY — reference_join on reference_hash (differing function_hash)
        "function_false":{ "run_id":"…","plantedness":0.0,"asr":0.04 },
        "trigger_naive":null },

      "status": { "in_progress":false,"has_defense":true,"has_twin":true,"has_scan":false,
                  "has_interp":true,"has_negative_drop":false,"planted":true }   // planted = plantedness>=0.95
    }
  ]
}
```

**Wire plan (v1, deliberate):** ship everything inline. `arity_max=5` bounds exponential metric cost; one-row-per-run yields *fewer* rows than today's 2.6k scoring-leaf rows, so the gz stays ~362KB-order. Browser keeps the 500-row DOM cap. The lazy-detail split (`/boolback-detail?run_id=`) is **documented as the fallback** if size ever exceeds ~2–3 MB but **not built in v1** — a stateful per-run fetch path is unjustified against the deletion-favoring principle at this scale. (Build cost/size to be *measured* before commit — see §9 D-6.)

---

## 3. CMT-side changes

All new integration code lives in **one** new directory `ComplexMultiTrigger/tom.quest/` (sibling of `boolean_backdoor/`), package `tom_quest`, added to the mypy live tree. **5 builder files** (dnf collapsed — adversarial simplicity fix):

| File | Role | CMT APIs it calls |
|---|---|---|
| `tom_quest/build.py` | orchestrator + CLI (`python -m tom_quest.build <dir> <out.json.gz>`) + gzip writer | `config.OUTPUT_ENV_VAR`/`artifacts_root` |
| `tom_quest/reshape.py` | long-form `collect_rows()` → one-row-per-run rollup on `NODE_KEY`; epoch/inference/scoring/judge as descendants; base-eval union; twin resolve; **calls `structural_metrics.dnf_string` directly** (no dnf.py) | `analysis.tidy.collect_rows(arity_max=5)`, `analysis.identity.{NODE_KEY,group_key,ChainView.from_leaf}`, `analysis.reference_join.join_on_reference_hash`, `analysis.outcomes.*`, `tuning.tuning_slug`, `sample_poisoning.attack.make_behavior().distinguishing_phrase()`, `methods.dispatch.metadata`, `scan.infra.dispatch.get_scan(...).method_family`, `trigger_logic.core.TruthTable.{from_str,activates,rows}`, `trigger_logic.metrics.{metric,scalar_metric_names,metric_provenance}`, `trigger_logic.structural_metrics.dnf_string` |
| `tom_quest/trajectory.py` | per-epoch plantedness/asr/ftr/ppl via `parse_score` over each epoch's PRIMARY `score.json` (fold into reshape if <~60 LOC) | `sweep.plantedness.{plantedness,PLANTED_THRESHOLD,planted_epoch}`, `score_io.{parse_score,Score,ScoreRow}` |
| `tom_quest/primary.py` | derived primary inference + scoring selection (identity-safe) | `config_levels` (judge/behavior introspection), `artifact_tree.tree.read_config` |
| `tom_quest/schema.py` | `metric_schema` + `column_groups` + `friendly` headers, EMPIRICAL ranges | `scalar_metric_names`, `metric_provenance`, `analysis.outcomes.*`, `analysis.friendly.SHORT_NAMES`, `config_levels.{LEVELS,projected_schemas,chain_levels}`, `analysis.tidy_schema.denormalized_columns` |

**Torch-free / transformers-free guarantee (verified):** import only `analysis/*`, `sweep.plantedness`, `score_io`, `trigger_logic/*`, `config`, `config_levels`, `tuning`, `sample_poisoning.attack`, `methods.dispatch`, `scan.infra.*`, `artifact_tree.tree`, `stages._chain`. NEVER `boolean_backdoor.stages.{train,inference,…}` or `boolean_backdoor.engine.*`. CI-guarded by a `sys.modules` purity test.
**Verified dependency corrections:** `polars` IS required (`analysis/__init__.py` eagerly imports `plots`+`digest` → polars). `pyyaml` IS required (importing `sweep.plantedness` runs `sweep/__init__.py` → `sweep.expand` → `import yaml`). `scipy` is a hard dep for `is_ltf`/`distance_to_ltf` only (lazy import). All three are in the `boolback` conda env. Documented deps: **numpy + scipy + polars + pyyaml**. The `is_ltf`/`distance_to_ltf` pair is wrapped in per-metric `try/except` so a missing scipy degrades 2 of 61 metrics to `null` (provenance-flagged), never failing the build.

### CMT improvements (with invariant-safety notes)

**(a) Primary-scoring designation — purely derived, identity-safe.**
Among an inference node's child scoring siblings, primary = behavior-matched judge first, else a fixed judge-priority order; among inference siblings, primary = the **test split** (the plantedness SSOT is test-only). Fallback when no judge matches: sort siblings by `(judge name asc, scoring_hash asc)` and take the first; inference siblings test-before-train then `inference_hash asc` — **explicit deterministic sort, never directory iteration order**. Optional read-only override: a non-hashed sidecar `epoch-N/inference+/primary_scoring.json` the builder *may* honor, **never read by `node_name`**, mirroring the dataset `derivation:"build"` hash-payload elision precedent.
*Invariant safety:* hashes nothing. Verified: `node_name` (tree.py:38–50) hashes only `content_hash(hash_payload(level, cfg))`; `_validate_level` reads the materialized config dict, never directory contents, so a sidecar cannot trip the unknown-key guard. The catastrophic anti-option (adding a field to `InferenceCfg`/`ScoringCfg` TypedDicts, which cascade-rehashes every downstream node) is explicitly avoided. **Golden test:** chain hashes byte-identical with the sidecar present vs absent.

**(b) New public `dnf_string(tt)` in `trigger_logic/structural_metrics.py`.**
CMT has no DNF expression-string renderer (function slug == raw truth-table string; "canonical DNF with symbols" in AGENTS.md is aspirational). **Critical correction (verified):** render over the **MINIMAL cover** — `_cover(_prime_implicants(c,n), _minterms(c,n), exact=(n <= EXACT_DNF_MAX_ARITY))`, the exact path `min_dnf_stats` (line 279) uses — **not** raw `_prime_implicants` (which returns ALL prime implicants, e.g. canonical_int=27 → 3 PIs but the minimal cover is 2 clauses). Rendering from raw PIs would print a clause count contradicting the `num_clauses_dnf` metric shown in the same row — server-side drift. Letters A,B,C…=bit i, `!` for negated literal, ` | ` between clauses. `_prime_implicants` stays private (its golden-covered name is not perturbed).
*Invariant safety:* purely additive public function; touches no config/hash/slug/schema. **Golden test:** number of ` | `-separated clauses in `dnf_string(tt)` == `min_dnf_stats(tt)["num_clauses_dnf"]` for several truth tables **including canonical_int=27**.

**(c) `tom.quest/tom_quest/tests/build_test.py` (CPU, `not gpu`).** Ports the deleted `fixture.test.ts` self-checks as assertions over CMT outputs (Parseval over the Fourier spectrum; `block_sensitivity ≤ certificate_complexity`; plantedness recompute) **plus**:
- import-graph purity (no torch/transformers/peft/vllm/unsloth/bitsandbytes/accelerate in `sys.modules` after importing `tom_quest`);
- **read-only enforcement:** a build run writes nothing under the output tree (no new `config.json`/`done.json`/sidecar);
- **no over-rowing:** rollup groups EXACTLY on `NODE_KEY`; **no row has `training.backend == "none"`** (base-eval never leaks as a phantom run — guards the `digest.py:48` duplicate-arm trap);
- every trained run with a matching `(function_hash, dataset_hash)` `-none` node has a populated `epoch0_baseline`, and all seed/tuning variants under one `(function,dataset)` reference the **same** baseline (many-runs-to-one fan-in);
- node `path` uniqueness + tree↔table round-trip.

**(d) No change to `LEVELS`, `config_levels`, `tidy`, `identity`, `tidy_schema`, or any hashed schema.** `collect_rows` already emits everything; the builder is a pure reshaper. The field-in-hash ⇔ in-schema ⇔ tidy-column triple is untouched.

---

## 4. turing-api

Three new **plain `def`** endpoints in `turing-api/main.py` behind `Depends(verify_api_key)` (existing shared X-API-Key; no new auth, no new CORS). All sync `def` (June-2026 event-loop-starvation invariant: a blocking subprocess inside `async def` froze the loop). All paths through `dirs.resolve_within_root` with root **pinned to `Path(os.environ['BOOLEAN_BACKDOOR_OUTPUT']).resolve()`** (not the default `$HOME`). The API process stays lean — it **never imports `boolean_backdoor`**; the builder runs as a subprocess in the conda env.

1. **`GET /cmt-dirs?path=`** → `dirs.list_directory` wrapped with the pinned CMT root. Enumerates snapshot-able output dirs for the picker.

2. **`GET /boolback-snapshot?dir=`** → `resolve_within_root(dir, root=cmt_root)`; freshness key = newest `done.json` mtime under the dir. If a cached `.gz` for `(dir, key)` is fresh, return JSON envelope `{status:"ready", schema_version, meta, blobPath:"/api/turing-blob/boolback-snapshot-blob?dir=…"}`; else `{status:"building"}` / `{status:"error", detail}`.
   **`POST /boolback-snapshot?dir=`** → kicks the build in a **daemon thread** (the `tmux.setup_allocation_session` precedent — never block the request thread), guarded by a **per-dir `fcntl.flock`** (the `job_screens.py` precedent). Returns `{status:"building"}` immediately.
   **Build invocation — argv list, `shell=False` (injection fix):** `subprocess.run(["conda","run","-n","boolback","python","-m","tom_quest.build", str(resolved_dir), str(cache_path)], cwd=repo_dir, shell=False)`. No interpolated bash string. (Regression test: a dir name containing `'`, `$(...)`, or `;` cannot execute.)
   *Why POST-kicks / GET-polls and never a synchronous build:* `forwardToTuringApi`'s 20s `AbortSignal` is non-overridable through the catch-all proxy; any in-request build is a guaranteed 502.

3. **`GET /boolback-snapshot-blob?dir=`** → returns the cached `.gz` via `FileResponse` with `Content-Type: application/gzip`. **The JSON-only Next catch-all cannot carry it** (it reads `res.text()` and rejects non-`application/json`), so a **separate binary Next route** `app/api/turing-blob/[...path]/route.ts` proxies it: forwards X-API-Key, `requireAdmin`-gated, streams `res.body` through unchanged (`new NextResponse(res.body, {headers:{'content-type':'application/gzip'}})`). The browser fetches `blobPath` and gunzips via `DecompressionStream('gzip')` exactly as `real.ts` does today. *(No cloudflared static route exists — corrected.)*

**CORS:** documented invariant — the browser MUST reach these only via the admin-gated Next proxies, never the FastAPI origin directly. CORS is **not** a security boundary here (the proxy + X-API-Key is). Optionally tighten `allow_origins` and drop `allow_credentials`.

**Dir-picker + refresh contract.** `dir-picker.tsx` calls `GET /api/turing/cmt-dirs`; selecting a dir calls `GET /api/turing/boolback-snapshot?dir=` (cached envelope or building-status); **Refresh** = `POST` then poll `GET` (building/ready/error tri-state). Regression test mirrors `main_test.py`: `../`, absolute escapes, and secret-name targets return 403 for all three endpoints.

---

## 5. Browser

### Data layer

**Delete outright:** `data/fixture.ts` (1807 LOC — the in-browser analytical layer), `data/fixture.test.ts` (283; guards move to `build_test.py`), `lib/prng.ts` (109; no browser hashing remains), `components/dag-pane.tsx` (1069; salvage only the EpochCell polyline), `scripts/boolback_export.py` (364). ~**3632 LOC removed outright.**

**Rewrite:**
- `data/real.ts` → ~60-line loader: fetch `blobPath`, `DecompressionStream('gzip')`, `JSON.parse`, validate `schema_version`, return typed `Bundle {meta, metricSchema, columnGroups, friendly, tree, rows}`. No `computeComplexity`, no metric fill, no `assignPathsAndCoerce`/`resolveChain`. `setActiveBundle`/`activeRoot` indirection collapses to a single source; lookups become plain module functions.
- `lib/metrics.ts` → delete the static 61-entry `METRIC_META` and the `NOISE_STABILITY_RHOS`/`JUNTA_DISTANCE_KS`/`PER_VARIABLE_INFLUENCE_VARS` constants. Replace with a tiny module indexing `meta.metric_schema` into a `Record<name, MetricMeta>` + pure `formatValue`.
- `lib/types.ts` → retype to `RunRow`/`Bundle`/snapshot shapes.

**Modify `lib/select.ts`:** keep `applyFilters`/`applySorts`/`facetOptions`/`histogramBins`/`numericValue`/`cellValue` and **multi-key drag-sort verbatim** (pure, no CMT analogue). Changes: `FACET_GETTERS` reads `RunRow` fields, data-driven off the snapshot's grouped columns; **drop the `scopeDir` special-case** (→ subtree chips, §6); **drop the text-haystack branch** (→ typeahead); `normalizeToRange`/`histogramBins` read `min`/`max` from `metric_schema` empirical ranges (the arity-bar bug dies as a class — bars opt-in per column; arity is `dtype:"count"`, plain text); reconcile `ROW_SCALAR_COLS` to `RunRow`, drop the dead `METRIC_META` re-export.

### Component tree (keep / modify / rewrite / delete / new)

| File | Disposition | Note |
|---|---|---|
| `data/fixture.ts`, `data/fixture.test.ts`, `lib/prng.ts`, `components/dag-pane.tsx`, `scripts/boolback_export.py` | **delete** | drift engine + fabrication + DAG + content hashing |
| `data/real.ts` | **rewrite** | thin gunzip+parse loader |
| `lib/metrics.ts` | **rewrite** | data-driven over `metric_schema` |
| `lib/types.ts` | **rewrite** | `RunRow`/`Bundle` contract |
| `lib/select.ts` | **modify** | data-driven getters; subtree chips; ranges from snapshot |
| `state/store.ts` | **modify** | prune slices (explicit list below); decouple `select()` from `detailOpen`; add `columnWidths`, `detailWidth`, `subtreeDirs`, `treeCursor` |
| `boolback-client.tsx` | **modify** | drop mobile tab switcher / view concept (table-only); wire dir-picker; persist tree+detail widths |
| `components/command-bar.tsx` | **modify** | remove Real\|Demo toggle, census checkbox, text filter; add dir picker + Refresh |
| `components/tree-pane.tsx` | **modify** | per-row Filter+Details buttons; click-to-expand; typeahead anchor; remove census fold + scopeDir click |
| `components/table-pane.tsx` | **rewrite** | one-row-per-run; truth-strip; raw plantedness; hover sparklines; resizable/truncating cols; per-group hover dropdowns; DNF column |
| `components/detail-drawer.tsx` → `detail-panel.tsx` | **rewrite** | right-side, drag-resizable, Details-button only |
| `components/truth-strip.tsx` | **new** | horizontal per-tt-row activation strip |
| `components/epoch-sparkline.tsx` | **new** | hover trajectory + detail plantedness-over-epoch plot (salvaged EpochCell) |
| `components/tree-typeahead.tsx` | **new** | text box → live arrow-key dropdown |
| `components/column-group-menu.tsx` | **new** | hover-to-open per-group column dropdowns |
| `components/dir-picker.tsx` | **new** | CMT output dir picker + Refresh |
| `lib/use-resizable.ts` | **new** | drag-resize + persisted-width hook (tree + detail + columns) |
| `lib/use-viewport.ts`, `usePersistedSettings` | **keep** | reused for widths/view persistence |
| `turing-api/dirs.py` | **keep** | `resolve_within_root` + `list_directory` reused verbatim |
| `app/api/turing-blob/[...path]/route.ts` | **new** | binary gz proxy (admin-gated) |

**Store slices to DELETE (explicit, auditable):** `collapseCensus`/`setCollapseCensus`, `activeTab`/`setActiveTab` (+ `ViewTab` type), `dagPan`/`dagZoom`/`setDagPan`/`setDagZoom`, `scopeDir`/`setScopeDir`, `focusRoot`/`setFocusRoot`. Also drop the `DEFAULT_COLS` entries `stealthRate`(invented) and `plantedEpoch` (both columns removed; `stealth_rate` the *CMT* metric is added fresh under its canonical name).

### Shared mechanisms

- **FilterState as single source for tree + table.** Tree Filter buttons write **subtree chips** into the same `FilterState` the table facets use (§6). No separate `scopeDir`.
- **Resizable/truncating column system.** `use-resizable.ts` writes a persisted per-column width map; cells use fixed width + `overflow:hidden` + ellipsis, rows single-height. **Exception:** truth-strip and DNF columns are content-sized, non-truncating (§6).
- **Right detail panel.** `select()` decoupled from `detailOpen`; opened only by a Details button; drag-resizable; width persisted.
- **Typeahead** with an explicit anchor (§6).

---

## 6. UX feature catalog — everything the user can do, and its backing mechanism

| Action | Mechanism |
|---|---|
| Pick any CMT output dir on Turing | `dir-picker.tsx` → `GET /api/turing/cmt-dirs` (root-pinned `list_directory`) |
| Rebuild snapshot from the live tree | Refresh → `POST /boolback-snapshot` (daemon-thread build + flock + mtime cache) then poll `GET` |
| See loading / build-failure / empty / unreachable / unauthorized / stale-cache states | First-class tri-state + explicit cards in `dir-picker.tsx`/loader (§9 D-5 lists all 5; no fixture fallback) |
| Browse the artifact tree (root "artifacts") | `tree-pane.tsx` over snapshot `tree`; click a row = expand only |
| Filter the table to a subtree (function/dataset/training) | tree row **Filter** button → adds a removable **subtree chip** (OR across chips: a row passes iff its `chain_dirs` intersects ANY selected `node_path`); deselect removes the chip independently of expansion |
| Open full details for a node | tree/table **Details** button → right-side drag-resizable panel (never an accidental row click) |
| Typeahead-jump to a nested dir | `tree-typeahead.tsx` text box → live arrow-key dropdown of dirs under the **tree cursor** anchor (a tree-local highlight, distinct from filter/detail selection) |
| Filter by facets (source, task, judge, tuning, trigger form, behavior, base model, …) | hover-to-open `FacetPopover` over `FilterState`; options from `facetOptions(rows)` (or `meta.axes`) |
| Filter by metric ranges | hover-to-open `RangeSlider`; bounds from `metric_schema` empirical min/max |
| Add/remove columns per group | hover-to-open `column-group-menu.tsx` (one per FUNCTION/DATASET/TRAINING/OUTCOME/DEFENSE/INTERP/SCAN); DEFENSE/INTERP/SCAN are first-class selectable columns |
| Multi-key sort, drag-reorder sort chips | kept verbatim (`applySorts` + store `pushSort`/`appendSort`/`reorderSorts`) |
| Resize columns; long values truncate with ellipsis | `use-resizable.ts` + fixed-width/`overflow:hidden`; rows stay single-height |
| Read the truth table visually (arity 1..5) | `truth-strip.tsx`: horizontal strip of 2..32 short boxes from `row.function.activation`; per-variable color square-pie of present triggers; **amber border iff activates, grey otherwise** (replaces sqrt-swatch + binary string) |
| Read the function as simplified DNF | optional FUNCTION column rendering `row.function.dnf_string`, letters colored to match the strip |
| Read raw plantedness (float) | OUTCOME cell shows `row.headline.plantedness` (no binary "Planted @", no "stealth" invention) |
| Hover an outcome cell → epoch sparkline | `epoch-sparkline.tsx` over `row.trajectories[metric]` + 0.95 threshold line |
| See per-epoch × per-judge values | detail panel from `row.per_judge` (all siblings — test+train, every judge) |
| Audit per-tt-row target_rate + plantedness formula | detail panel from `row.per_tt_row` (sourced from CMT, not recomputed) |
| See defense / interp / scan results | detail panel; interp shows mandatory `null_control`; defense shows per-method `dispatch.metadata` (info_tier, contract) |
| See the epoch-0 base-eval baseline | detail panel from `row.epoch0_baseline` (the `-none` node, united by `(function,dataset)`) |
| See substituted reference twins (function-False / trigger-naive) | detail panel from `row.twins` (reference_hash 1:1) |
| See PPL / ppl_drift | OUTCOME columns + detail |
| Plantedness-over-epoch plot with ASR/FTR overlay | detail panel (salvaged EpochCell, reworked) |

**Removed (license to simplify):** DAG view, Demo source + fixture, census ×34 toggle, "stealth" (the invented `min(t,c)` formula and column — the real CMT `stealth_rate` stays), binary "Planted @", binary truth-table string, arity mini-bar, opaque global text filter, the Tree\|DAG\|Table tab switcher / view concept, `focusRoot`.

---

## 7. Drift-elimination table

| Old reimplementation (where) | CMT replacement |
|---|---|
| Activation, 3× (`boolback_export.py:135`, `fixture.ts`, drawer audit) | `TruthTable.activates()/.rows()` → `row.function.activation` |
| Plantedness, 3× (`boolback_export.py:154`, `fixture.ts`, drawer) | `sweep.plantedness.plantedness()` + `planted_epoch` + `PLANTED_THRESHOLD` |
| ASR/FTR/triggerless_correctness, 2×+ | `analysis.tidy` derived rows (names from `analysis.outcomes`) |
| 61 complexity metrics fabricated in `fixture.ts` + re-run in `real.ts` | `trigger_logic.metrics.metric()` + `scalar_metric_names()`; values shipped final |
| Static `METRIC_META` + ranges + parametric-key constants (`metrics.ts`) | `metric_schema` from `scalar_metric_names` + `metric_provenance` + `outcomes.*` + **empirical** extents |
| DNF/CNF greedy cover in `fixture.ts` | new public `structural_metrics.dnf_string` over the **minimal cover** |
| Content hashing (`prng.ts`) | deleted; `config.content_hash` is the only hasher, CMT-side |
| Identity re-keying (`real.ts` `assignPathsAndCoerce`/`resolveChain`) | builder emits globally-unique `node_path` + `chain_dirs`, server-side once |
| Tuning labels (`boolback_export.py:60`, page) | `tuning.tuning_slug` |
| Twin pairing heuristic (`boolback_export.py:311`) | `analysis.reference_join.join_on_reference_hash` (real `reference_hash`) |
| Base-eval folding (mis-specified as reference_join) | `(function_hash,dataset_hash)` union mirroring `TRAJ_DROP = SEED ∪ {"training"}` → `row.epoch0_baseline` |
| Friendly column/facet labels (page) | `snapshot.friendly` from `analysis.friendly.SHORT_NAMES` |
| `target_phrase` via `tb.get('sentinel')` | `make_behavior().distinguishing_phrase()` |
| Invented "stealth" `min(target_rate,correctness)` | removed; real `stealth_rate` (joint `P(target&correct)`) shipped from `collect_rows` |
| Brittle regex tree parsing (`NODE_RE`/`CHAIN_RE`) | `artifact_tree.tree` + `stages._chain` walk; builder emits the tree |
| One-row-per-scoring-leaf + browser final-epoch resolution + tab/DAG/census/scopeDir | one-row-per-run on `NODE_KEY` + table-only + tree-as-filter; all machinery deleted |

---

## 8. Phased implementation steps

Dependency-ordered. CMT bar throughout: `pytest -m "not gpu"` green + `uvx mypy --no-incremental` ends in **Success** over the whole live tree (now including `tom.quest/`). The builder must import torch-free/transformers-free.

**Phase 0 — CMT additive primitives (no consumer yet).**
- Add public `structural_metrics.dnf_string(tt)` over the **minimal cover** (`_cover(_prime_implicants(...), _minterms(...), exact=…)`). Golden test: clause count == `num_clauses_dnf` incl. canonical_int=27.
- *Verify:* new golden + existing structural-metric tests; mypy Success.

**Phase 1 — the `tom_quest` builder.**
- Create `ComplexMultiTrigger/tom.quest/tom_quest/` (`build.py`, `reshape.py`, `trajectory.py`, `primary.py`, `schema.py`) and add to mypy live tree.
- `reshape.py`: `collect_rows(arity_max=5)` → group on `NODE_KEY`; fold epochs (sparse-aware + `completed_epochs`); attach ALL per-judge siblings; derive primary (deterministic sort); union the `-none` `epoch0_baseline` by `(function,dataset)`; resolve substituted twins via `reference_join`; emit `stealth_rate`; call `dnf_string`.
- `schema.py`: metric schema with empirical ranges (per-metric `try/except` around `is_ltf`/`distance_to_ltf`); column groups; friendly headers.
- `build.py`: env-set → reshape → gzip write; CLI entry.
- *Verify:* `tom_quest/tests/build_test.py` — Parseval; `bs ≤ cs`; plantedness recompute; **import-purity** (`sys.modules`); **read-only** (no tree writes); **no over-rowing** + **no `backend=="none"` row leaks**; `epoch0_baseline` populated + shared fan-in; path uniqueness + tree↔table round-trip. Plus the primary-scoring **golden** (chain hashes byte-identical sidecar present vs absent). `pytest -m "not gpu"` + mypy Success.

**Phase 2 — measure, then wire turing-api.**
- **Measure first (D-6):** time a cold `collect_rows(arity_max=5)`+reshape+gz on a representative Turing tree; record wall-clock and gz size. If cold build > a few seconds or gz > ~2–3 MB, escalate to the CPU-compute-node path or the documented lazy-detail split before proceeding.
- Add `GET /cmt-dirs`, `GET/POST /boolback-snapshot`, `GET /boolback-snapshot-blob` (sync `def`, `verify_api_key`, `resolve_within_root` pinned to `$BOOLEAN_BACKDOOR_OUTPUT`, daemon-thread build, `fcntl.flock`, `(dir,mtime)` cache, `shell=False` argv list).
- Add binary Next route `app/api/turing-blob/[...path]/route.ts`.
- *Verify:* port `main_test.py`/`shell_test.py` — path-traversal/secret-name → 403; **command-injection** dir name cannot execute; envelope/building/ready/error shapes; blob `Content-Type: application/gzip` round-trips through the binary proxy.

**Phase 3 — browser deletions + thin data layer.**
- Delete `fixture.ts`, `fixture.test.ts`, `prng.ts`, `dag-pane.tsx`, `scripts/boolback_export.py`. Rewrite `real.ts`, `metrics.ts`, `types.ts`. Modify `select.ts`. Prune store slices (explicit list).
- *Verify:* TypeScript build green against a captured real snapshot fixture; `select.ts` unit tests; no dead `METRIC_META` reference.

**Phase 4 — table + viz.**
- Rewrite `table-pane.tsx` (one-row-per-run; resizable/truncating columns w/ truth-strip+DNF exceptions; per-group hover menus). New `truth-strip.tsx`, `epoch-sparkline.tsx`, `column-group-menu.tsx`, `use-resizable.ts`.
- *Verify:* render against the captured snapshot; visual diff of plantedness/ASR/FTR vs a known run (the new numbers are the *correct* CMT ones); confirm truth-strip handles arity 1..5; arity renders as plain text.

**Phase 5 — tree + detail + source.**
- Modify `tree-pane.tsx` (Filter/Details buttons, click-to-expand, typeahead anchor); new `tree-typeahead.tsx`. Rewrite `detail-drawer.tsx`→`detail-panel.tsx` (right-side, drag-resizable, Details-only). New `dir-picker.tsx`. Modify `command-bar.tsx` (remove toggle/census/text; add picker+Refresh). Modify `boolback-client.tsx` (table-only, persist widths).
- *Verify:* subtree chips compose as OR and clear independently of expansion; detail panel never opens on a plain row click; all 5 degradation states render; Refresh round-trips through the live API.

---

## 9. Open risks & decisions left for the user

**Resolved in this plan (no longer open):** DNF minimal-cover correction; `stealth_rate` is real CMT vocabulary (kept, not removed); base-eval union via `TRAJ_DROP`-style `(function,dataset)` key with a dedicated `epoch0_baseline` slot (not `reference_join`); no `backend=="none"` row leakage; `display_epoch` = `planted_epoch ?? last-completed-scored-epoch` with sparse trajectories; deterministic primary-scoring fallback sort; `pyyaml`+`polars` builder deps; gz delivery via binary FastAPI endpoint + separate binary Next route (no nonexistent static route); command-injection closed via `shell=False` argv list; `is_ltf` typed as float, not bool; subtree chips as OR with an explicit typeahead anchor; hover-popover focus/precedence rules; dnf.py collapsed into reshape.

**Open risks (monitored, mitigated):**
- *Build cost/size unmeasured.* Phase 2 measures before committing to login-node + inline-everything. Fallbacks ready: CPU compute node via salloc/tmux; the documented `/boolback-detail` lazy split.
- *Definitional drift on consumption.* Consuming CMT plantedness/asr/ftr/`triggerless_correctness`/`n_activating` must be verbatim from tidy/outcomes; a one-time visual diff against a known run is in Phase 4.
- *Login-node load from repeated Refresh.* Mitigated by `(dir,mtime)` cache + flock + `arity_max=5`; escalation path exists.

**Decisions left for the user:**
1. **Default judge-priority order** for primary-scoring (behavior-matched-judge-first is the rule; the residual priority list when several judges match a behavior needs a canonical order — does one exist in `judges/`, or do we author it fresh in `tom_quest/primary.py`?).
2. **`meta.axes`** — keep as a perf cache, or drop it and let `facetOptions(rows)` derive the facet universe (one definition, no denormalization)? Default recommendation: drop unless first-paint profiling shows it matters.
3. **Dir-picker scope** — enumerate top-level CMT output *roots* (multiple campaign trees) or subtrees within one tree? Affects the pinned-root allow-list.
4. **CORS hardening** — leave `allow_origins=['*']` (with the documented "proxy is the boundary" invariant) or tighten to the Vercel/tunnel origins and drop `allow_credentials`?
5. **`primary_scoring.json` sidecar** — ship the optional read-only override path in v1, or defer it (derived rule only) until an actual need arises? Recommendation: defer; the derived rule is sufficient for v1 and adding the reader later is identity-safe.

Files referenced (absolute): `C:\Users\heffn\Desktop\booleanbackdoor\ComplexMultiTrigger\.claude\worktrees\dazzling-kalam-4c2c30\boolean_backdoor\trigger_logic\structural_metrics.py`, `…\boolean_backdoor\analysis\outcomes.py`, `…\boolean_backdoor\analysis\__init__.py`, `…\boolean_backdoor\sweep\runner.py`, `…\boolean_backdoor\analysis\plots.py`.
---

## Decisions resolved (user-approved 2026-06-27) — supersede §9 open items

- **stealth_rate: REMOVED entirely** from snapshot + UI (user will rework separately). Not shipped anywhere.
- **(1) Primary scoring rule:** prefer **judge == "keyword"**; if multiple candidates, the **oldest** (earliest mtime); deterministic hash tiebreak. This selector is the one intended **CMT-proper** change (lives in `analysis/`), identity-safe. `dnf_string` stays additive/identity-safe and should live inside `tom.quest/tom_quest/` where possible — add a public accessor in `structural_metrics.py` only if the minimal cover isn't already reachable.
- **(5) `primary_scoring.json` sidecar: ADDED in v1** — a non-hashed, read-only per-inference override; default = rule (1) when absent.
- **(2) Dir picker = choose the artifact-tree ROOT** (a top-level CMT output dir), separate from the tree-nav panel; enumerate top-level roots.
- **(3) Facets derived from rows** in-browser; drop `meta.axes`.
- **(4) CORS left as `*`** (admin-gated proxy + X-API-Key is the boundary).
- **Deploy to prod when green:** tom.quest `main` → Vercel (frontend); turing-api restart on all 3 login nodes; CMT changes → master + Turing checkout.
