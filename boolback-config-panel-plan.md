# boolback config-panel unification — implementation plan

Locked with Tom 2026-07-08. Goal: one right-side config panel (per-view), CMT-aligned
vocabulary, drastic control pruning, and CMT sheds all plotting. Design log lives in the
conversation + agent memory; this file is the build order.

## Vocabulary (applies everywhere, both repos)

| old | new |
|---|---|
| chart (ChartConfig, chart-panel, setChart, …) | plot |
| dimension (DimensionDef, dimensions.ts, dims) | parameter |
| measurement / InterpMeasurement / measurements[] | reading / InterpReading / readings[] |
| facet keys camelCase (triggerForm, baseModel) | CMT snake_case (trigger_form, base_model) |
| "Split" facet label | "train/test" |
| defense/scan as unrelated groups | methods, three types: **defense / interp / scan** |
| outcome grouping | **attack** (plantedness, asr, ftr, target_rate, n_activating) / **capability** (triggerless_correctness, correctness_rate, ppl, ppl_drift) |

Treatments: **filter / split / averaged / facet** (facet = Group Plot only, one parameter).
Judge is ALWAYS split — pinned visibly in the split section ("judges never pool",
cmt pool_guard rule), filterable but not averageable.

## Phase 0 — CMT repo (all analysis-side; NO fleet-coupled code)

Everything here touches only `cmt/analysis/*`, `cmt/tom_quest/*`, `tom.quest/tom_quest/*`
— fleet workers never import these (spec §9.4), so deploy is a surgical subtree checkout
on Turing mid-fleet (never a blanket pull), then one rebuild.

1. **Remove `stealth_rate` entirely**: `outcomes.py` registry entry, the tidy read-time
   joint derivation from verdicts.jsonl, tests. `stealth_rate_drop` vanishes via the
   registry union.
2. **Reclassify correctness under capability** in the registry + snapshot metric groups.
   `*_drop` of capability metrics stays a defense (mitigation-cost) outcome.
3. **Delete `plots.py` and `digest.py`** + their `__main__.py` dispatch + the matplotlib
   dependency from analysis. `estimates/`, frames, and every data projection stay
   (boundary rule: inferential stats remain CMT-side).
4. **tidy `.tmp` fix**: every `epoch-<n>` parse site skips `*.tmp` / non-`epoch-<int>`
   names; test with a stray `epoch-3.tmp` dir. (Unblocks the currently-failing cron.)
5. **Snapshot schema v3** (`cmt/tom_quest/snapshot.py` + `tom.quest/tom_quest/build.py`):
   emit the browser contract DIRECTLY (kills normalize.ts, see Phase 6):
   - new vocab throughout (readings, attack/capability groups, method types);
   - add: `residual_asr`/`residual_ftr` per defense method, `planted_fraction`,
     detector cuts per (method × scheme × negative_facet);
   - drop v1/v2 compatibility from the builder's own reshape.
6. **`tom.quest/tom_quest/render.py`**: view-spec JSON → matplotlib paper figure, reading
   `tidy.parquet`. CLI: `python -m tom_quest.render spec.json -o fig.pdf`. Maps
   split[0]→color (or continuous colormap), facet→small multiples, ranges→filters,
   binned splits→the same bucket edges.

## Phase 1 — browser: state split + renames (tom.quest repo)

1. Mechanical renames per the vocabulary table (files: `chart-panel.tsx`→`plot-panel.tsx`,
   `dimensions.ts`→`parameters.ts`, `dimension-board.tsx` is absorbed by Phase 2).
2. **Store rework** (`state/store.ts`): three fully independent view configs —
   `table: {filters, columns, sorts, search}` ·
   `plot: {filters, x, y, splits, bins, colorBy, channels, valueStyles, band, ghosts,
   trend, logX/Y, domains}` · `groupPlot: plot-shape + {facet, panelMin}`.
   No inheritance on tab switch. Persist each under its own usePersistedSettings key.
3. **FilterState slims**: status flags GONE, subtreeDirs GONE (tree fully decoupled —
   pure navigator: click = select/scroll, never filter), search survives only in table
   config with dir-path/run-id fragment semantics (facet-value haystack deleted).
4. **Delete dead weight**: `share.ts` + readSharedView + the ⧉ button, `migrateChart`
   v1 path, legacy preset hydration (old presets dropped, no migration), status
   machinery, fn=/subtree scope machinery (function filtering becomes an ordinary
   parameter filter over function identity values).
5. Anatomy view untouched and isolated (own config; imports nothing new).

## Phase 2 — the config panel

New `config-panel.tsx`, docked right, two modes (config | run inspector). Top bar slims
to: » artifacts · view tabs · N of M runs · status dot · one ↻ · rebuild note.

- **Header**: Views (presets: list/apply/save/delete — ONE kind, a named snapshot of the
  active view's spec) · **Copy spec / Paste spec** (the text view-spec; the ONLY
  cross-view transfer) · Export (PNG only) · Reset (this view).
- **Parameter column** — collapsible sections: function / dataset / training / judge /
  complexity / outcomes; varying parameters only, constants collapsed at bottom.
  Each categorical row: label, value list (cap ~16, scroll, inline value filter for
  long lists like function), per-value count + filter checkbox + isolate/exclude,
  treatment control (table view: filter only — treatments hidden; plot: split/averaged
  + channel badge; group plot: + facet). Judge row pinned split.
- **Continuous rows** (complexity metrics, numeric parameters, outcomes): mini
  histogram + treatment selector **filter | bins | color**:
  - *filter*: histogram + dual slider (existing RangeEditor, relocated);
  - *bins*: compact editor `[n▾ 2–8] [quantile|width▾]`, bucket edges shown as small
    tick labels under the histogram, **each edge click-to-edit** (editing any edge
    flips method to "custom"; ⟲ resets to computed edges). Buckets flow through the
    normal split machinery (group key, legend, channels, averaging).
  - *color*: continuous gradient (viridis) on the color channel; NOT in the group key;
    averaged groups colored by within-group mean; legend = compact colorbar. One
    continuous color max; categorical splits then take shape/size/dash.
- **Plot extras**: trend / band / ghosts toggles. **Table extras**: columns menu
  (absorbs ColumnGroupMenu), sort-key list (absorbs sort chips: reorder/flip/remove),
  dir-path search box. **Group Plot extras**: panel-size slider. Facet via treatment.

## Phase 3 — rendering updates (plot-panel + group-plot)

1. **Axes accept any parameter or outcome** on X and Y, both plots: numeric parameters
   plot directly; categorical parameters become discrete positions with jitter;
   per-method outcomes (`asr_drop@beear`) selectable; epoch mode unchanged.
2. Binned-split buckets render as ordinary split values (labeled `0.12–0.35`).
3. Continuous color: colormap fill + colorbar legend.
4. Judge always in the group key (correctness) AND pinned visible (never invisible).
5. Group Plot: panel titles inert (value + count, hover only); points still open the
   inspector; facet excluded from splits as today.
6. Export menu → single "PNG" action (SVG rasterize path already exists; CSV/.tex cut).

## Phase 4 — run inspector (dock mode 2)

Replaces detail-panel.tsx content; opened by row double-click / point click; back
button returns to config mode. Five sections:
1. **Parameters** — full parameter vector, same names/order as the panel;
2. **Function** — truth strip + DNF + complexity table;
3. **Outcomes** — trajectory plot with epoch-0 folded in as the epoch-0 point and a
   judge selector on the plot (kills separate baseline + per-judge sections);
   per-tt-row table (target/correctness rates + auditable plantedness); ppl/drift;
4. **Methods** — one uniform table: type (defense/interp/scan) · method · metrics;
   twin model-diff is a line here;
5. **Files** — the run's raw artifact browser.
Deleted: anatomy section (lives with the Anatomy view), standalone twins/baseline/
per-judge sections.

## Phase 5 — view-spec + presets

JSON, CMT vocabulary, versioned:
```json
{ "v": 3, "view": "plot|groupplot|table",
  "x": "avg_sensitivity", "y": "asr", "log": ["x"],
  "filters": {"base_model": ["Llama-3.2-1B"], "judge": ["kw"]},
  "ranges": [{"metric": "plantedness", "min": 0.9, "max": 1}],
  "split": [{"param": "arity", "channel": "color"},
             {"param": "fourier_degree", "bins": {"n": 4, "method": "quantile"}}],
  "color_by": null, "facet": "trigger_form",
  "band": true, "ghosts": true, "trend": false,
  "columns": null, "sorts": null }
```
Copy/Paste in the panel header; Convex presets store `{name, spec}` (one kind, applying
switches to spec.view); `render.py` consumes the identical spec.

## Phase 6 — deploy + normalize removal

1. tom.quest ships FIRST with a temporary old-blob translation branch confined to
   `data/normalize.ts` (app itself is single-vocab). Live Turing data renders day one.
2. CMT batch deploys via surgical subtree checkout on Turing
   (`git fetch && git checkout origin/master -- cmt/analysis cmt/tom_quest tom.quest/tom_quest`),
   then one rebuild POST (curl -m 60; see reference_boolback_turing_ops).
3. Once a v3 blob is live: **delete normalize.ts** — replaced by a thin `link.ts` doing
   only what JSON cannot ship (attach `row.function` shared references, derive the tree
   for the tree pane while it survives). v1/v2 blob acceptance and the vocab translation
   die with it. Browser caches of old blobs invalidate by schema_version check → refetch.

## Verification

- lib tests updated alongside each phase (aggregate/select/parameters/presets/spec
  round-trip; bin-edge editing; judge-pinning invariant).
- Preview walkthrough per phase: table filters independent of plot; spec copy → paste
  across views; binned + gradient rendering; inspector sections; PNG export.
- End-to-end after deploy: live blob renders, rebuild produces v3, normalize deleted,
  `python -m tom_quest.render` reproduces a browser view from a pasted spec.

## Risks / watch-fors

- The three-config split touches every consumer of `useBoolbackStore.filters` — grep-audit
  before starting; anatomy must keep reading a filters source (give it the table view's
  or a frozen EMPTY_FILTER — it's deprecated; do not entangle).
- Quantile edges over filtered rows change when filters change (by design — labels show
  absolute values so plots stay self-describing).
- Convex preset table: new spec shape; old rows deleted (Tom: drop completely).
- render.py works from tidy.parquet, whose row universe is richer than the snapshot's —
  spec filters must name tidy columns (the snake_case unification is what makes this work).

## v3 snapshot contract (as actually emitted by CMT Phase 0 — GROUND TRUTH)

Branch `claude/cmt-analysis-plotshed` (CMT repo, NOT pushed/deployed). The browser types +
normalize shim + metric grouping MUST match these exact names:

- Envelope: `schema_version: 3`.
- **Interp = readings vocab.** `row.interp = { type:"interp", reading_kind, value,
  null_control, reference_model_diff, readings:[{ kind, type:"interp", value, null_control }] }`.
  Metric names: `interp_reading`, `interp_null_control`, per-kind `interp_reading@<kind>`.
- **Method TYPES** — every method rollup + per-method entry carries `type ∈
  "defense"|"interp"|"scan"` (mitigator/reconstructor→defense, detector→scan). The run
  inspector's Methods table derives type from the source array; browser types may add
  `type?` optionally.
- **Defense residuals** — per-method slots gain `residual_asr` / `residual_ftr` (post-defense
  AFTER values); metric names `residual_asr@<method>` / `residual_ftr@<method>` (per-method
  only, NO generic).
- **planted_fraction** — `headline.planted_fraction` = {0,1} indicator (null if plantedness
  null); OUTCOME group, suite **"attack"**. Averaged across seed-sibling rows.
- **Detector cuts** — `row.scan.methods[] = { method, scheme, negative_facet, cut,
  type:"scan", auroc, far_at_frr }`; per-cut metric names
  `scan_auroc@<method>|<scheme>|<negative_facet>` (`-` fills absent scheme/facet).
- **metric_schema `suite`** — OUTCOME metrics now carry `"attack"` / `"capability"` (NOT
  `"outcome"`); DEFENSE/INTERP/SCAN entries keep `"outcome"`. So browser `MetricSuite` becomes
  `structural|spectral|outcome|attack|capability`. Metric grouping (metrics.ts X/Y_GROUP_ORDER,
  config panel outcome sections) groups by these. Envelope entry shape unchanged
  (name/label/suite/group/dtype/min/max/format/provenance).

New outcomes arrive as data-driven metric_schema ENTRIES, so the metric picker / range
filters surface them automatically — the only CODE changes are: MetricSuite union, the few
new optional type fields (Headline.planted_fraction, ScanMethod.scheme/negative_facet/cut/type,
DefenseMethod.residual_asr/residual_ftr/type), and grouping by the new suites. normalize's
v3 branch is mostly pass-through; verify it does NOT re-translate `readings` or choke on the
new fields. CMT agent also repaired pre-existing-broken snapshot fixtures/tests (fixtures
predated the scoring_plant/readings migrations) — `_make_sample_snapshot.py` now emits correct
rich v3, so regenerating `data/sample-snapshot.json` from it gives a real v3 test blob.
(Env note: CMT agent pip-installed matplotlib into the LOCAL `boolback` conda env; matplotlib
moved to the `[tomquest]` extra — Turing snapshot builds do NOT need it, only Tom's local
render.py does.)
