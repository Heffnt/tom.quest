# boolback plot improvements — contract (2026-07-16)

Tom's locked rulings (in-convo, 2026-07-16):

1. **Per-layer correlations**: per-layer trend lines + per-layer r/ρ in the
   config-panel layer strip (the strip IS the legend), plus a **grid facet**
   on Group Plot — `target_behavior` × `base_model` is the canonical pair.
2. **Layer population hygiene**: layers should be **fully pinned** — every
   parameter pinned to the option with the highest count under the layer's
   cell ("auto-pin dominant"). Tom pinned only where alternatives existed at
   edit time; unpinned parameters silently start pooling when new data lands.
3. **Bulk selection**: a toggle for whether parameter-row edits apply to the
   **active layer** or to **all layers** (NOT a new plot-level scope field —
   Tom explicitly chose the edit-mode toggle over a scope concept).
4. **Group Plot axes**: x/y metric pickers visible + editable in the Group
   Plot toolbar (it already shares `store.plot`).
5. **Data export**: an Export "CSV" of exactly the plotted selection at run
   grain, for handing to another agent to write matplotlib code. Spec JSON
   (Copy button) already exists and pairs with it.

Vocabulary stays: layer / parameter / plot / reading. Spec stays **v4**; all
additions are OPTIONAL keys (no breaking change, no back-compat shims for
removed things). Gates per phase: `npx tsc --noEmit`, eslint, full vitest —
all green before the phase is done.

---

## Phase 1 — per-layer trend/r (A), group-plot axis pickers (C), data CSV (D)

### A. Per-layer trend + r/ρ

- `components/plot-surface.tsx`: today ONE OLS over the surface's pooled
  run-deduped `pairs` (see the TREND comment block ~line 24, memo ~line 218).
  New behavior when `config.trend`:
  - 1 series → unchanged (pooled line, header r/ρ).
  - ≥2 series → draw one OLS line PER SERIES over that series' own
    run-deduped pairs, stroked in the series' resolved color, honoring the
    series' dash style, width ~1.25, opacity ~0.85. The pooled line is NOT
    drawn in this case. Compact surfaces (group-plot panels) keep their
    per-panel pooled fit + `r=` corner UNCHANGED (a panel is already a cell).
  - Skip a series' line when it has <2 distinct x values (same guard as the
    pooled fit).
- Layer strip entries (`components/config-panel.tsx`, the settings/layers
  strip): when the active view is a plot view, trend is on, and both axes
  resolve numeric, append a small mono readout per layer entry:
  `r=+0.38 ρ=+0.35` (2dp, signed) computed over that layer's run-deduped
  pairs via `lib/stats` pearson/spearman. `—` when n<3. Must NOT wrap the
  strip layout; text-faint, right of the count chip. Computation must be
  memoized (selector over resolved series), not per-render.
- Tests: per-series fit drawn (data-testid or path count per series),
  single-layer unchanged, strip readout renders and matches lib/stats on a
  fixture.

### C. Group Plot toolbar axis pickers

- `components/group-plot.tsx` toolbar (~line 351, currently
  `facet: <label> · N panels`): prepend the SAME searchable MetricPicker
  pair the main plot uses (see plot-panel's on-axis pickers) wired to
  `store.plot.x` / `store.plot.y` setters. Order: `x <picker> · y <picker> ·
  facet: <select> · N panels`. Log-scale checkboxes NOT needed here (they
  stay plot-view chrome).
- Tests: pickers render current metric labels; changing one updates
  store.plot and panels re-resolve.

### D. Export data CSV

- New pure serializer `lib/plot-export.ts` (unit-tested):
  `plotDataCsv(series, axes, opts) -> string`.
  Columns, in order: `layer`, `panel` (group plot only — omit column
  entirely on the main plot), `run_id`, `dir_path`, `<x-metric-id>`,
  `<y-metric-id>` (header = the actual metric/axis id, e.g.
  `avg_sensitivity`, `auroc@mad_quirky`; when x is `epoch` the column is
  `epoch`), then parameter context columns:
  `arity, fn_hex, dataset, trigger_form, target_behavior, target_phrase,
  row_distribution, samples_per_row, backdoor_ratio, base_model, tuning,
  backend, lr, epochs, seed, judge, split`.
  One row per plotted point (run grain; per (run, epoch) when x=epoch).
  Averaged/mean overlays are NOT exported — raw underlying points only
  (the matplotlib agent re-aggregates as it likes).
- Surface in the Export area of the config panel top bar (where PNG lives,
  `config-panel.tsx` ~line 693): add a `CSV` button next to `PNG`, enabled
  on BOTH plot and groupplot views. Group plot rows carry the panel key
  (facet cell label). Reuse/extend `PlotExportHandle` (plot-panel.tsx ~94,
  dormant `getCsv` at ~632 may be adapted or replaced — keep ONE csv path,
  delete the dormant one if superseded). Group plot needs the same handle
  wired (it currently only has PNG via its own svg ref — check).
- Filename: `boolback-<view>-<x>-vs-<y>.csv`.

## Phase 2 — auto-pin dominant (E), edit-mode toggle (F)

### E. Auto-pin all parameters to the dominant value

- New helper in `lib/select.ts`: `pinAllDominant(rows, filters) ->
  FilterState`. Semantics: cumulative walk over `FACET_KEYS` in registry
  order (same style as `repairPins`, ~line 278): for each key EXCEPT
  `function` (the unit of analysis — pinning it collapses the scatter; keep
  `fn_hex`-style function identity unpinned if it is ever a facet key),
  if the key already has a selection, keep it verbatim (and narrow the
  walk's cell by it); otherwise pin to `dominantValue` under the
  cell-so-far (skip/leave-unpinned when null). Ranges untouched. The walk
  keeps the cell non-empty by construction.
- Apply automatically to layers minted by the **expand-by-parameter
  generator** (`lib/generators.ts` — both the single-value and "all layers"
  paths): after setting the expanded key, run pinAllDominant. NOT applied
  to the default "all runs" layer or plain "+ add layer".
- Explicit action: a **pin-all button** (⚓ or `pin all`, hover title
  "pin every parameter to its most-frequent value in this layer") in each
  layer entry's action cluster (next to ⟲ reset), running pinAllDominant
  on that layer; respects the Phase-2 edit-mode toggle (all-layers mode →
  pins all layers).
- Tests: cumulative determinism (seed pinned before target_phrase per
  registry order), function never pinned, existing selections kept
  verbatim, generator mints come out fully pinned, null-valued keys stay
  unpinned.

### F. Edit scope toggle: active layer vs all layers

- Store (plot config UI state, NOT spec): `editScope: "active" | "all"`,
  default `"active"`, plot/groupplot only, not persisted into ViewSpec
  (it's an edit mode, not view state; localStorage persistence with the
  rest of UI state is fine if free).
- UI: compact segmented control at the top of the parameter column
  (config-panel), label `edit: active layer | all layers`.
- Behavior: ALL parameter-row mutators (`onToggleValue/onClear/onIsolate/
  onExclude`, the complexity range add/remove/update at config-panel
  ~409-415) apply to every layer when `editScope === "all"` — same edit per
  layer, each followed by that layer's cascade `repairPins`. The transient
  "X followed Y" cascade note aggregates ("repaired in 3 layers: …" style,
  reuse the existing note mechanism, keep it one line).
- The expand generator popover and layer-entry-local controls (color,
  shape, rename, ⟲) are NOT affected by the toggle.
- Tests: toggle-all fans an arity toggle out to every layer; cascade runs
  per layer; active mode unchanged.

## Phase 3 — grid facet (B)

- `lib/types.ts` GroupFacet union (~560) gains
  `{ kind: "grid"; row: string; col: string }` (facet keys, e.g.
  `target_behavior` × `base_model`). `sanitizeGroupFacet` (~739): both keys
  must be non-empty strings and distinct; else null.
- `lib/spec.ts`: round-trip the new shape (orderSpec facet block ~291;
  parse/serialize + tests). Additive — v4 stays v4.
- `components/config-panel.tsx` facet picker (~905-948): new option
  `grid (two parameters)` revealing two selects (row, col) over the same
  categorical parameter list as the current param facet (numericSort-aware
  ordering; exclude bins/layer/metric options). Preselect
  `target_behavior` × `base_model` as the suggestion when first chosen.
- `components/group-plot.tsx`: for grid facets derive panels as the
  NON-EMPTY (row-value, col-value) cells over the layers' union rows;
  layout = real CSS grid: column headers across the top (col values,
  `display()`-formatted — shortModel for base_model), row labels down the
  left, shared scale as today, per-panel compact surface (per-panel trend
  `r=` corner comes free). Sort rows/cols by the parameter's sort rule
  (numericSort ascending, else lexical). Windowed rendering stays
  (content-visibility). Panel count guard: if rows×cols > 100, show the
  existing cardinality warning path instead of rendering.
- Panel header format for CSV `panel` column: `<row>|<col>` (raw values,
  display formatting only in the UI).
- Tests: sanitize + spec round-trip, cell derivation (empty cells dropped),
  header/label formatting, panel key stability.

## Post-code (session driver, not the phase agents)

- Deploy: push **main only** (same-SHA dual push kills the Vercel build);
  hard-reload prod before judging.
- Update Tom's **"C-J-R x Model"** preset IN PLACE (same name — Tom
  authorized): apply pin-all to each of the 15 layers, verify per-layer
  counts before/after (Tom believes populations are already consistent —
  every count delta must be reported back to him), re-save.
- Report per-layer / per-cell r for the updated view.

## Gotchas for implementers

- `config-panel.tsx` is ~1700 lines and shared by every phase — phases run
  SEQUENTIALLY, never two agents editing it at once.
- Any new `PlotSetting`/config field MUST be added to the types sanitizers
  or page-refresh hydration silently drops it (types.sanitize*).
- select.ts must stay a dependency leaf (no parameters.ts import — cycle).
- Match existing comment density/style; CMT snake_case vocab in UI copy.
- Tests run with vitest; keep the suite green, extend neighboring test
  files rather than new harnesses where natural.
