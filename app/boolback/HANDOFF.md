# boolback — how it all works

The public explorer for the ComplexMultiTrigger (CMT) boolean-backdoor
experiments at <https://www.tom.quest/boolback>. One page, three panes:

```
┌───────────┬──────────────────────────────────────┬──────────────┐
│ dir       │ top bar ( » artifacts · Table|Plot|  │ config panel │
│ viewer    │   Group Plot|Anatomy · r/ρ (plot) ·  │ (the active  │
│ (mirrors  │   N of M runs · ● ↻ · rebuild note ) │  view's own  │
│ the disk  ├──────────────────────────────────────┤  controls)   │
│ tree;     │ ONE of the four center views:        │   — or —     │
│ collapses │ TABLE · PLOT · GROUP PLOT · ANATOMY  │ run inspector│
│ to a bar  │   (one table row = one training run) │ (opens on a  │
│ button)   │                                      │  row / point │
│           │                                      │  click)      │
└───────────┴──────────────────────────────────────┴──────────────┘
```
(The top bar — `components/filter-bar.tsx` — is pure chrome: no filters, no
controls. Everything that acts on the data lives in the right-docked config
panel, `components/config-panel.tsx`, which is one dock in two modes: the
active view's controls, or the run inspector when a run is open. Snapshot
freshness lives in the status dot's tooltip. A collapsed dir viewer leaves NO
rail: the bar grows a header-height `» artifacts` re-open button instead.)

**What is a run (the fundamental unit).** One row = one run = one
fine-tuning execution = one `training+…` dir, keyed by
NODE_KEY `(function_hash, dataset_hash, training_hash)`: one boolean
function × one poisoned dataset × one training config (base model, tuning,
lr, epochs, **seed included** — two seeds are two runs). Everything below
training folds INTO the row (epochs → trajectories, judges → per_judge,
headline = primary judge at the display epoch). NOT runs: the `-none`
epoch-0 base-eval (folds into `epoch0_baseline`) and dataset-scoped scans
(attached to every run sharing the (function, dataset)). CMT-enforced:
`_node_key` grouping + build_test's no-over-rowing assertions.

It spans two repos: **tom.quest** (this page, the public proxies, the FastAPI
`turing-api`) and **ComplexMultiTrigger** (`~/booleanbackdoors/ComplexMultiTrigger`,
branch `master`) whose `tom.quest/tom_quest/` package is the snapshot builder.
Every number is computed once, in CMT; the browser is a pure view.

## The one-fetch data flow

```
CMT artifact tree on Turing            ~/booleanbackdoors/cmt-output/artifacts (~700 GB)
  └─ tom_quest builder (CMT repo)      sbatch "boolback-build", ~2 min; cron every 2h
       └─ snapshot-<dir>-<key>.json.gz ~/.cache/boolback-snapshots/
            └─ turing-api GET /boolback-snapshot-blob      (serves latest cache)
                 └─ Next proxy GET /api/boolback/blob      (injects X-API-Key)
                      └─ browser: gunzip → normalize → render
```

- **One fetch.** The page loads the blob and nothing else. Freshness is
  `meta.built_at` inside the blob (the status dot's tooltip). There is
  no status round-trip, and nothing walks the 700 GB tree on a page load. The
  status endpoint (`GET /boolback-snapshot`, `turing-api/main.py:331`) still
  exists and the browser never calls it; what was removed is its `**/done.json`
  glob over the ~700 GB tree, which cost 3–20 s a call — it answers from the
  cache dir alone now (`turing-api/boolback_snapshot.py:112`).
- **Serve-latest.** GET always returns the newest cached snapshot instantly.
  Builds happen off-request: the 2-hourly cron plus the admin ↻ Refresh (which
  POSTs `/api/turing/boolback-snapshot` → sbatch on a CPU compute node).
- **Dir is pinned** to `artifacts` (the one real tree). `?dir=` overrides;
  there is no picker.
- **Turing-down fallback (the page ALWAYS loads).** If the blob fetch fails
  (Turing/proxy 502 — the cluster disappears for days at a time), `data/source.ts`
  falls back to (1) the last good blob cached in the browser (Cache API,
  written after every successful parse), then (2) the bundled
  `data/sample-snapshot.json` (dynamic import). `source.origin`
  (`live|cache|sample`) drives an amber banner in `boolback-client.tsx` naming
  the fallback + why + a Retry. A failed REFRESH never downgrades: the on-screen
  bundle is kept and only the status dot goes error. The full-screen error
  remains only for first-load-failed + no cache + sample import failed.

## Snapshot schema v2 (built by `ComplexMultiTrigger/tom.quest/tom_quest/`)

`{schema_version: 2, meta, metric_schema, column_groups, friendly, functions, rows}`

- `functions` — ONE FunctionBlock per distinct function_hash (truth table,
  activation strip, DNF, ~61 complexity metrics). v1 embedded this in every
  row — ~8 MB of duplication at 3.4k rows; rows now reference it by hash.
- `rows` — one per training run (NODE_KEY = fn×ds×training, seed kept):
  dataset/training facets, headline outcome at the display epoch, per-epoch
  trajectories, per-judge scores, per-tt-row rates, defense/interp/scan/twins
  rollups, status flags, and `identity.dir_path` — the run's real on-disk
  `function+…/dataset+…/training+…` path (feeds the dir viewer and the
  raw-artifact browser).
- Floats are rounded to 4 decimals. No `tree` array (v1 had one; the browser
  derives the dir viewer from `dir_path` now).
- `meta.planted_threshold` — CMT's `PLANTED_THRESHOLD` (newer builders emit
  it; the browser defaults to 0.95 when absent, `lib/types.plantedThreshold`).
- `data/normalize.asBundle()` accepts BOTH v1 and v2 and outputs one in-memory
  shape (shared function refs re-attached onto rows), so the site and the
  builder deploy independently, in either order.

## What the UI shows

- **Top bar** (`components/filter-bar.tsx`) — pure chrome, one row, no
  controls that touch the data: the `» artifacts` re-open button (only while
  the dir viewer is collapsed), the four-view switcher, the plot's r/ρ readout
  (passive, published by the mounted plot through `store.plotReadout`), the run
  count, the snapshot status dot and the ONE canonical ↻ Refresh with its
  rebuild note. The count is the filtered row count on Table and the LAYERS
  UNION — distinct runs, a run matching several layers counted once — on Plot
  and Group Plot. Z-scale: table internals ≤ z-20, the top bar z-30.
- **Config panel** (`components/config-panel.tsx`) — the SINGLE right-docked
  control surface, shared by every center view, in two modes: the **run
  inspector** when a run is open, and the active view's **config** otherwise.
  Its header carries `Views ▾ · Copy · Paste`, `PNG`/`CSV` on plot-like views,
  and `Reset` (which serves Table and Anatomy — plot-like views reset PER LAYER
  from the ⟲ on each layers-strip entry).
  - **A filter is a facet selection or a metric range, and nothing else.**
    Status-flag pills and `scope:`/`fn=` subtree chips are gone from the filter
    model (`lib/select.ts` `applyFilters` reads `facets` and `ranges` only).
    `meta.planted_threshold` survives as a display constant.
  - Filtering is one row per PARAMETER (`lib/parameters.ts` `PARAMETERS` — the
    function identity, every dataset/training facet, judge/split), grouped into
    collapsible SHARED/DIFFERING sections with per-value counts.
  - Table mode adds the search box (run id / `dir_path` / `node_path`, AND
    across whitespace tokens — `lib/select.ts`), the sort-keys section (drag to
    reorder; it renders with zero keys and says so) and Columns
    (`components/column-group-menu.tsx`).
- **Table** — WINDOWED rendering (every filtered row reachable; no 500-row
  cap), sortable (multi-key; the key chips are dragged in the config panel),
  resizable columns, per-group column menus. Leading arity/`Fn` columns freeze
  sticky-left. A summary footer shows the mean of each numeric column over the
  filtered set. ↑/↓ move selection, Enter opens the inspector, Esc closes.
  Categorical cells reveal a ⊕ filter button on hover; headers carry a ⌄ menu
  (sort ascending, sort descending, hide column, add range filter — the last
  only when the metric has observed data). The compact `Fn` column is
  `arity:hex` of the truth table (`3:E8`); hover it for the colored strip +
  DNF. Truth squares: the fill is split evenly among the PRESENT variables
  (1 = full, 2 = 50/50, 3 = thirds; the all-zeros row is empty), near-black
  outlines separate the colors, and an amber ring means that row ACTIVATES
  the backdoor.
- **Plot** — the same filtered rows: any metric vs any metric via
  searchable pickers that live ON the axes (the x picker under the x axis,
  the y picker rotated along the y axis; both log toggles by the origin,
  the y one rotated — the exported PNG keeps plain axis labels via a
  `[data-export-only]` group). An `AxisRange` control by each axis end edits
  the view window; **there is NO box-select** (`components/plot-panel.tsx`
  says so at the danger point). Y lists ATTACK/CAPABILITY first, then
  OUTCOME/DEFENSE/INTERP/SCAN/FUNCTION; X leads with FUNCTION
  (`lib/metrics.ts` `X_GROUP_ORDER`/`Y_GROUP_ORDER`); per-method entries
  collapse under their base metric in the picker
  (`components/metric-picker.tsx`).
  A LAYER IS ONE TRACE, and the layers strip in the config panel IS the legend
  — there is no docked legend panel (the exported figure carries its own).
  Every parameter is SHARED across the plotted rows (drawn as the points'
  common context) or DIFFERING, and a differing one is either EXPANDED into one
  layer per value by a generator (`lib/generators.expandLayers`, and `binLayers`
  for a continuous metric), PINNED by a layer's own facet filters, or POOLED —
  left varying inside the layer, which is the "averaged: …" note under the
  strip (`lib/split-dims.averagedParams`). A layer's three style channels are
  color, shape and dash (`lib/styling.ts`); size and opacity are plot-level,
  not channels. Points group by (layer × X bucket): mean ± 1 SD whiskers,
  n-sized points, per-combo connecting lines; X is exact up to 24 distinct
  values and falls back to 12 equal-width bins above that
  (`lib/aggregate.groupRuns`), with the collapsed raw runs redrawn as faint
  ghosts when `ghosts` is on. Single-run points, ghost polylines and mean
  polylines all click through to the run inspector. The r/ρ readout and the
  OLS trend fits are ALWAYS computed over the underlying runs, deduped by run
  so a row in several layers is not double-weighted (descriptive only;
  inferential stats stay CMT-side); the readout also reports `x binned`,
  points outside the window and points dropped by a log axis. A highlight ring
  marks the row hovered or selected elsewhere. This is the RQ1/RQ4 instrument:
  outcome vs complexity, moderated by context.
- **Group Plot** — the fourth view (`components/group-plot.tsx`): the same
  plot config drawn as a grid of small panels, faceted by layer, by a
  parameter, by a parameter grid, or by a binned metric (the config panel's
  kind-aware "Facet by" select, plus a panel-size slider).
- **Anatomy** — a center view of its own (see `ANATOMY-SPEC.md` for the frozen
  design contract): the selected run's transformer drawn as a horizontal
  residual-stream bar (embed left → unembed right), its function-false twin
  (`twin_hash`) mirrored along the bottom, a per-layer run-vs-twin diff strip
  between them. One ACCORDION x-scale with pinned ends (`lib/anatomy.ts`,
  pure + heavily tested) zooms from whole-model heat down to a single head
  slot or neuron bin (icicle nesting: layer → attn|mlp → head|neuron-bin;
  wheel / click-to-blow-up / dbl-click reset / arrow keys), LOD swaps at px
  thresholds, positions never jump. Encodings: carrier→color (markers only),
  mode→glyph (circle observe / diamond intervene, tap-arrow direction),
  |Δ|→size, null_control→fixed ghost (INTERP NULL faint, never hidden);
  run/twin identity = amber/cyan on header chips, heat, diff strip, and
  circuit-diff arcs (shared edges neutral). Circuits render as
  span-proportional arcs bar-to-bar; selecting one enables "fit circuit"
  (accordion expands all its layers); side-exclusive edges expose trigger
  rewiring. Clicking a marker or an arc sets `AnatomyConfig.sel` to that
  measurement's key (`anatomy-pane.tsx`); `components/anatomy-detail.tsx`, the
  old detail panel's anatomy section, is still in the tree and has no importer.
  `AnatomyConfig` {focus, twin, sel} persists per browser under
  `boolback:anatomy`; it is NOT part of the view spec, so it does not travel
  through Copy/Paste or a saved view. The view has no config-panel controls of
  its own and the store calls it deprecated. Everything degrades structurally
  on pre-anatomy blobs (spine renders, honest "no locus data" copy). Derived
  per-run scalars `interp_peak_layer/loc_width/depth_com@<kind>` are
  synthesized in `normalize.withAnatomyMetrics` (separate, guard-proof,
  idempotent step) so the plot can show localization depth against the 61
  function-complexity metrics.
- **Per-method DEFENSE/INTERP/SCAN metrics** — the generic scalars are
  HEADLINE rollups (`asr_drop` = best over the run's methods, interp = one
  headline kind), so per-method values are first-class metrics named
  `<base>@<method>` (`asr_drop@beear`, `interp_measurement@caa_ablation`;
  `lib/method-metrics.ts` owns the convention). Defense methods carry the
  FULL `*_drop` self-join family (`ftr_drop`, `triggerless_correctness_drop`
  — the utility cost — target/correctness rate drops) per method only (no
  generic headline exists for those). They ride the ordinary
  metric_schema/column_groups surface — chart axes, range filters, table
  columns, exports — with the generic entries relabeled "(best method)" /
  "(headline)". Newer builders emit them; for older blobs
  `data/normalize.ts` synthesizes them from `rows[].defense.methods` /
  `interp.measurement_kind` / `scan.method_family` (a no-op once the
  builder ships any `@` name — builder extents are then authoritative).
  Registry-less relic methods (caa/repe/geometry_cone/rome_edit → interp,
  onion deleted) carry their historical contract + a `legacy` note.
- **Export** (config-panel header) — `PNG` (2×, CSS vars resolved) and `CSV`
  (the plotted selection at run grain, `lib/plot-export.ts`), both plot-like
  views only. `lib/export.ts` still holds `summaryToLatex`/`summaryToCsv` (the
  booktabs summary table) and a table-CSV path, and nothing on the page calls
  them today — there is no summary-table or table-CSV button.
- **Copy / Paste / Views (saved presets)** — the SPEC, not a URL, is how a view
  travels. `Copy` writes the active view's VIEW-SPEC (`lib/spec.ts`, `v: 4`) to
  the clipboard as pretty JSON, `Paste` reads one back, and `Views ▾` saves a
  named `{name, spec}` row in the Convex `boolbackPresets` table
  (`convex/boolbackPresets.ts`). One preset kind: `lib/presets.hydratePresetSpec`
  is tolerant and returns null for anything that is not a v4 spec, so a stale
  row no-ops instead of crashing the page. The spec carries the ANALYTICAL
  config (axes, log, layers, ranges, the plot toggles, a group facet; table
  specs carry filters/columns/sorts) and deliberately not the ephemeral state
  (zoom windows, layer ids, the search box, column widths), which `specToConfig`
  default-fills. Alongside it, each view's live config persists per browser
  under `boolback:table` / `boolback:plot` / `boolback:groupplot` /
  `boolback:anatomy`, and the pane layout under `boolback:layout`. There is no
  `?v=` share link and no `lib/share.ts`.
- **Run inspector** — everything about a run, in the right dock: parameters,
  function, outcomes, methods, and **raw artifacts** — a live browser over the
  run's actual dir on Turing (`/api/boolback/node` + `/api/boolback/file`,
  jailed server-side to `$BOOLEAN_BACKDOOR_OUTPUT`, size-capped, weight files
  metadata-only). Anything a stage writes is reachable there without projecting
  it into the snapshot.
- **Empty-but-future data** (ppl, scan, twins today) is findable, never
  default: column menus tag it "no data yet", the header ⌄ menu withholds
  "Add range filter" for it, and the metric pickers park it in a collapsed
  trailing "no data yet (N)" group. Everything surfaces automatically once the
  builder observes real values — no code change needed.

## Code map

| Where | What |
|---|---|
| `app/boolback/data/source.ts` | the one blob fetch + admin rebuild |
| `app/boolback/data/normalize.ts` | v1/v2 → one Bundle; derives the tree; injects `fn_hex` |
| `app/boolback/boolback-client.tsx` | the shell: the three panes, the fallback banner, the pane layout |
| `app/boolback/state/store.ts` | the zustand store — center view, per-view config, filters, sorts, layers, the plot readout |
| `app/boolback/lib/` (data) | `types` (pinned contract), `select` (filter/sort/facet/search), `columns` (bare→dotted bridge), `metrics` (schema index + picker order), `method-metrics` (the `<base>@<method>` convention), `format` (hex, sizes, model names) |
| `app/boolback/lib/` (plot) | `parameters` (the parameter model), `generators` (expand/bin a parameter into layers), `split-dims` (resolve layers → series), `aggregate` (grouping, ghosts, binning), `axes`, `bins`, `stats` (descriptive only), `styling` (color/shape/dash), `trajectories`, `plot-export`, `export`, `anatomy` (accordion scale, LOD, palettes, twin matching — pure) |
| `app/boolback/lib/` (transfer) | `spec` (the v4 view-spec: the one cross-view transfer object), `presets` (saved views over it) |
| `app/boolback/components/` | `filter-bar` (the top bar), `table-pane` (table + the plot/groupplot/anatomy mount), `config-panel` (the right dock: config or run inspector), `plot-panel` (+ `plot-surface`), `group-plot`, `anatomy-pane` (+ `anatomy-legend`), `tree-pane` (dir viewer) + `tree-typeahead`, `run-inspector` (+ `artifact-browser`), `metric-picker`, `axis-range`, `column-group-menu`, `glyph`, `truth-strip`, `fn-hex`, `epoch-sparkline`. `anatomy-detail` is still in the tree with no importer. |
| `app/api/boolback/{blob,node,file}` | public read-only proxies (explicit endpoints, never a catch-all) |
| `convex/boolbackPresets.ts` + `convex/schema.ts` | saved views: `{name, spec}` rows, the page's only backend state |
| `turing-api/main.py` + `boolback_snapshot.py` | blob/status/node/file endpoints + sbatch submit + cache |
| `turing-api/boolback_build.sbatch` + `boolback_cron.sh` | the build job and the 2-hourly cron that submits it |
| CMT `tom.quest/tom_quest/{build,reshape,schema,trajectory}.py` | the snapshot builder |

## Ops crib sheet

- **Rebuild now:** ↻ Refresh as admin, or on a login node:
  `curl -X POST -H "X-API-Key: <key>" "http://127.0.0.1:8000/boolback-snapshot?dir=artifacts"`
  (key in `turing-api/.env`). Job name `boolback-build`, ~2 min inside a
  `--partition=short --time=04:00:00 --cpus-per-task=4 --mem=32G` envelope
  (`turing-api/boolback_build.sbatch`); serve-latest picks it up with no
  restart. The 2-hourly cron is installed on ONE login node
  (`turing-api/boolback_cron.sh`) — unlike the service below, which runs on all
  three.
- **Builder changes** take effect after `git -C ~/booleanbackdoors/ComplexMultiTrigger pull`
  — no turing-api restart (the sbatch spawns a fresh `python -m tom_quest.build`).
- **turing-api changes** need the tom.quest repo pulled on Turing + the
  systemd --user service restarted on each of the three login nodes (user
  lingering must stay enabled: `loginctl show-user ntheffernan -p Linger`).
- **Local verification:** `npx vitest run app/boolback`; for pixels, `next dev`
  + Playwright with `page.route('**/api/boolback/blob**')` fulfilling a saved
  `.json.gz` (the builder fixture is `data/sample-snapshot.json`).
- **Builder tests** (from the CMT repo root):
  `PYTHONPATH=".;./tom.quest" uv run --no-project --with numpy --with scipy --with polars --with pyyaml --with pytest python -m pytest tom.quest/tom_quest/tests -q`
  — regenerate the browser fixture with `python -m tom_quest.tests._make_sample_snapshot`
  (set `BOOLBACK_SAMPLE_OUT` to this repo's `app/boolback/data/sample-snapshot.json`).
