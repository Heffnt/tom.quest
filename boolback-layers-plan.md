# boolback LAYERS rework — implementation contract

Tom-approved redesign (2026-07-15 convo). This file is the single source of
truth for the multi-agent build. HARD RULES for every agent:

- **NO back-compat, NO old-key acceptance, NO fallbacks.** Tom: "I haven't
  really used this system yet." Old persisted blobs / specs / presets are
  DROPPED (sanitizers coerce to defaults). Delete migration paths outright.
- Single vocabulary: **layer** (was "setting"). `PlotSetting`→`PlotLayer`,
  `settings`→`layers`, `addSetting`→`addLayer`, UI copy "setting"→"layer",
  spec key `layers`. No aliases anywhere.
- Match existing code style (comment density, naming, file-header comments —
  UPDATE stale header comments you touch, they are load-bearing docs).

## The model (what changed and why)

1. **A layer is ONE trace.** `splitBy` is deleted from config, spec, store,
   resolver, and UI. resolveSeries returns exactly one series per layer.
   Anything that used to make multiple series now makes multiple LAYERS via
   GENERATORS (expand-by-parameter, bin-by-metric).
2. **Style split.** Plot-LEVEL style: `size`, `opacity`, `band`, `ghosts`,
   `trend` (on PlotConfig; UI = one "plot" style row above the layers strip;
   the old bottom toggles row is DELETED). Layer-LEVEL style: exactly the
   three semantic channels **color** (existing field), **shape**, **dash**.
   LayerStyle = `{ shape: number; dash: number }` (defaults 0/0). No
   size/opacity per layer, no `shape: null` auto mode (that served splits).
3. **Group Plot shares the plot's config.** Store keeps ONE `plot: PlotConfig`
   used by BOTH tabs; `groupPlot` shrinks to extras
   `{ facet: string | null; panelMin: number }`. Facet literal "setting"
   becomes **"layer"** (one panel per layer).
4. **Epoch is the default x** (`DEFAULT_PLOT.x = "epoch"`, y stays
   "plantedness").
5. **Pins auto-repair (the cascade).** On any facet edit in a plot layer,
   other pinned parameters whose pinned values now match ZERO rows re-pin to
   their single most frequent compatible value. Pins that still match are
   never touched. Repairs are announced with a transient note.
6. **Numeric value ordering.** Chip values of `numericSort` parameters sort
   ascending by value (arity 1,2,3,4,5) instead of by count.
7. **Function section unification.** Arity + function(fn_hex) + complexity
   move into ONE "function" section per layer; complexity metrics render
   ENGAGED-ONLY (picker adds a metric; each engaged metric shows histogram +
   range + a bin-into-layers control).
8. **Epoch-mode line hover.** Ghost run-lines AND group mean lines get hover
   tooltips + ghost click opens the run inspector.

---

## Contract: lib/types.ts

```ts
export interface LayerStyle { shape: number; dash: number }        // glyph idx / DASH_PATTERNS idx
export const DEFAULT_LAYER_STYLE: LayerStyle = { shape: 0, dash: 0 };

export interface PlotLayer extends Record<string, unknown> {
  id: string;          // "l1", "l2", … nextLayerId(existing) smallest unused
  name: string;
  color: string;       // hex
  style: LayerStyle;
  filters: FilterState;
}

export interface PlotConfig extends Record<string, unknown> {
  layers: PlotLayer[];            // sanitizer guarantees >= 1
  ranges: RangeFilter[];          // plot-level (drag-zoom), ANDed onto every layer
  colorBy: string | null;         // gradient; honored ONLY when layers.length === 1
  x: string;                      // DEFAULT "epoch"
  y: string;                      // DEFAULT "plantedness"
  // plot-level STYLE (was per-setting size/opacity + bottom-row toggles):
  size: number;                   // marker/line size multiplier, default 1
  opacity: number;                // opacity multiplier, default 1
  band: boolean;                  // default true
  ghosts: boolean;                // default true
  trend: boolean;                 // default false
  logX: boolean; logY: boolean;
  xDomain: [number, number] | null; yDomain: [number, number] | null;
}

/** Group Plot EXTRAS only — the plot config itself is SHARED (store.plot). */
export interface GroupPlotExtras extends Record<string, unknown> {
  facet: string | null;  // parameter key OR the literal "layer"
  panelMin: number;      // default 280
}
export const DEFAULT_GROUP_EXTRAS: GroupPlotExtras = { facet: null, panelMin: 280 };
```

- DELETE: `SettingStyle`, `DEFAULT_SETTING_STYLE`, `PlotSetting`,
  `GroupPlotConfig`, `DEFAULT_GROUP_PLOT`, `defaultGroupPlotWithFilters`,
  `isDefaultGroupPlotConfig`, `sanitizeGroupPlotConfig`, `nextSettingId`,
  `splitBy` field.
- ADD: `nextLayerId` ("l" + smallest unused int), `sanitizeLayerStyle`
  (numbers clamped: shape ≥0 rounded, dash ≥0 rounded; missing → defaults),
  `sanitizeGroupExtras(raw)` (facet string|null, panelMin finite number),
  `defaultPlotWithFilters(filters)` keeps working (seeds layers[0]).
- `sanitizePlotConfig`: reads ONLY the new keys (`layers`, `size`, `opacity`,
  …). A blob with the old `settings`/`splitBy` shape yields the default
  config (layers default single "all runs" layer) — that is the intended
  drop-old-data behavior. `isDefaultPlotConfig` JSON-compare stays (keep key
  order identical between DEFAULT_PLOT literal and sanitizer output).
- `DEFAULT_PLOT`: x "epoch", y "plantedness", size 1, opacity 1, band true,
  ghosts true, trend false, single layer {id:"l1", name:"all runs",
  color:CATEGORY_PALETTE[0], style:DEFAULT_LAYER_STYLE, filters:EMPTY_FILTER}.

## Contract: lib/split-dims.ts (flattened resolver)

```ts
export interface Series {
  key: string;        // === layer id
  layerId: string;
  layerName: string;
  label: string;      // === layer name
  color: string;      // === layer color (always; no palette-cycling rule)
  style: LayerStyle;  // defaults filled
  rows: RunRow[];
  judge: string | null; // unique judge over rows, null when mixed/absent
}
export interface SeriesResolution {
  series: Series[];          // one per layer, config order, kept when empty
  rowsUnion: RunRow[];       // concat of per-layer matches (dupes included)
  overlapCount: number;      // distinct runs matching >= 2 layers
  emptyLayers: string[];     // layer NAMES with zero matches
  judgePooled: string[];     // layer NAMES whose rows span > 1 judge
}
export function resolveSeries(opts: {
  rows: RunRow[]; layers: PlotLayer[]; ranges: RangeFilter[];
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): SeriesResolution
```

- DELETE: splitBy handling, combo, shapeIdx, `inactive`, `paletteExceeded`,
  MISSING/SERIES_SEP, `paramOf` opt (no longer needed by the resolver;
  judge lookup: hardcode judge via the `judge` FacetKey — take a
  `judgeOf: (r: RunRow) => string | null` opt OR keep `paramOf` solely for
  the judge def; pick the simplest and document it).
- `averagedParams(resolution, params)` — splitBy arg REMOVED. A parameter is
  "averaged" when it takes >1 distinct value within at least one layer's rows.

## Contract: lib/generators.ts (NEW, pure, unit-tested)

```ts
export type GeneratorTargets = "all" | "active";

/** Replace each target layer with one child per value of `dim` present in
 *  its matched rows (conditioned, nonzero). Non-target layers untouched. */
export function expandLayers(opts: {
  rows: RunRow[]; layers: PlotLayer[]; targets: GeneratorTargets;
  activeId: string; dim: ParameterDef;
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): PlotLayer[]

/** Replace each target layer with n children slicing `metric` into bins.
 *  Edges computed over THAT layer's matched rows (⇒ within-arity when the
 *  layer pins an arity — this is the point). quantile | equal width.
 *  Rows with a null metric fall out (they match no bin). NO cap on layers. */
export function binLayers(opts: {
  rows: RunRow[]; layers: PlotLayer[]; targets: GeneratorTargets;
  activeId: string; metric: string; n: number; mode: "quantile" | "width";
  index: MetricIndex;
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): PlotLayer[]
```

Shared rules:
- Child filters = deep-copied parent filters + (expand: `{facetKey:[value]}`;
  bin: parent ranges with any existing range on `metric` REPLACED by the bin
  slice `{metric, min, max}`).
- Child name = `${parent.name} · ${display(value)}` (expand) /
  `${parent.name} · ${metricLabel} ${fmt(lo)}–${fmt(hi)}` (bin). When the
  parent is the lone default "all runs" layer, drop the `all runs · ` prefix.
- Ids regenerated with nextLayerId as children are appended.
- **Style seeding** (the "grid" rule): the generated dimension takes COLOR —
  expand: `paletteColor(valueOrdinal)` where ordinals come from the sorted
  union of values across all target parents (numericSort-aware), so the same
  value has the same color in every parent; bin: `gradientColor(i/(n-1))`
  (viridis ramp low→high, same bin index = same color across parents).
  PARENT identity moves to SHAPE when >1 target parent: child.style.shape =
  parentIndex % SHAPE_COUNT; with a single parent, children inherit the
  parent's shape. Dash is always inherited.
- Quantile edges: sort finite values, edges at k/n quantiles, COLLAPSE
  duplicate edges (fewer bins than requested is fine, never empty-range bins).

## Contract: lib/select.ts — cascade helper

```ts
/** Pin auto-repair: after an edit to `editedKey`, re-pin any OTHER pinned
 *  facet whose selection matches zero rows to its single most frequent
 *  compatible value (walk PARAMETERS registry order, cumulative). Pins that
 *  still match anything are untouched. Never touches ranges or unpinned
 *  facets. Returns the repaired filters + which keys moved. */
export function repairPins(
  rows: RunRow[], filters: FilterState, editedKey: FacetKey,
): { filters: FilterState; repaired: FacetKey[] }
```

Algorithm: `work = filters`. For each PARAMETERS def (registry order) with a
facetKey, skipping `editedKey` and unpinned (empty/absent) selections:
`others = applyFilters(rows, work minus this key's facet)`. If none of the
key's selected values occur in `others` (per def.raw): stale → re-pin to the
single most frequent value in `others` (count via def.raw, ties by the dim's
sort). If `others` is itself empty, leave the pin (nothing sensible to do).
Repairs are cumulative (later keys see earlier repairs). Unit-test: the
dataset→target→target_phrase→judge chain, the no-op case (old pin still
valid), and the multi-value pin case (re-pin collapses to ONE value).

## Contract: lib/spec.ts — spec v4, clean break

- `v: 4` REQUIRED (parseSpec returns null for anything else — v3 dies).
- Keys: `layers` (was settings; each `{name, color?, style?{shape?,dash?},
  facets?, ranges?}`), NO `split_by`. NEW top-level plot keys `size?`,
  `opacity?` (omit when default). `facet?` stays groupplot-only and may be
  the literal "layer".
- Signatures:
  ```ts
  configToSpec(view: "table", config: TableConfig): ViewSpec
  configToSpec(view: "plot", config: PlotConfig): ViewSpec
  configToSpec(view: "groupplot", config: PlotConfig, facet: string | null): ViewSpec
  specToConfig(spec): { view: ViewKind; plot?: PlotConfig; table?: TableConfig; facet?: string | null }
  ```
  ("groupplot" spec = the shared plot fields + facet; panelMin still never
  serialized.)

## Contract: state/store.ts

```ts
table: TableConfig
plot: PlotConfig            // SHARED by Plot + Group Plot
groupPlot: GroupPlotExtras
```
- `type ViewKey = "table" | "plot"` (filter-mutator targeting). `configViewOf`:
  table→"table", plot→"plot", groupplot→"plot" (the PANEL still checks
  centerView === "groupplot" to show facet/panelMin rows). `PlotViewKey` DIES.
- Layer mutators lose the view arg (they always target `plot`):
  `patchLayer(id, patch)`, `addLayer(filters?) → id`,
  `duplicateLayer(id) → id | null` (copies style+filters, next palette color),
  `removeLayer(id)` (keeps >= 1), and NEW `replaceLayers(next: PlotLayer[])`
  (generators write through this).
- Facet/range mutators keep `(view, layerId, …)` with view ∈ ViewKey;
  plot-level ranges still `layerId === null`.
- `resetView("plot" | "groupplot", filters?)`: resets `plot` (dominant-seeded
  when filters passed); "groupplot" ALSO resets `groupPlot` extras.
- setGroupPlot patches extras only.

## Contract: components/config-panel.tsx

Panel order (plot-like views): **plot style row → layers strip → parameter
sections (with function section) → outcomes → constants**. Bottom toggles row
DELETED. SplitByEditor DELETED. ColorByRow eligibility: `layers.length === 1`.

1. **Plot style row** — one compact entry above the strip, visually parallel
   to a layer entry but labeled "plot": size slider (0.4–2.5, ×), opacity
   slider (0.1–1), band/ghosts/trend toggles. Writes setPlot.
2. **Layers strip** — one entry per layer: glyph (shapeNode(style.shape) in
   the layer color) + SwatchPicker (palette + custom hex input, keep) + name
   (inline rename, keep) + matched-run count + ⟲ reset (filters→dominant
   cell, style→DEFAULT_LAYER_STYLE) + ⧉ duplicate + × remove. ACTIVE layer
   expands a style editor with exactly THREE channels: color (swatch),
   shape (6 glyph buttons, no "auto"), dash (4 line buttons). Notes under
   the strip: averaged / overlap / judge-mixing (paletteExceeded is gone).
   Keep `data-legend-series` off — each entry IS the legend row now.
3. **Expand-into-layers** — every categorical parameter row gets an expand
   affordance (next to ◎/⊘, e.g. ⧉▾ "one layer per value"): a small popover
   with two actions — **"all layers"** (listed first; Tom's usual) and
   "active layer". Calls expandLayers + store.replaceLayers, then makes the
   first child active. NO cap on generated layers.
4. **Cascade wiring** — the plot-view facet handlers (toggle/isolate/exclude;
   NOT clear — widening can't stale a pin) compute the next FilterState,
   run `repairPins(bundle.rows, next, editedKey)`, and commit ONCE via
   patchViewFilters. When `repaired.length > 0`, show a transient note in
   the strip area — e.g. "target, judge followed dataset" — auto-clearing
   after ~3s. Table view: NO cascade.
5. **Function section** — new collapsible "function" section per layer
   containing: (a) the arity row (values now numeric-ascending), (b) the
   fn_hex row (explicit pick, unchanged behavior), (c) complexity —
   engaged-only: an "add metric ▾" select (FUNCTION-group metrics), each
   engaged metric renders histogram + range editor + remove + a **bin
   control**: n (2–8), quantile|width toggle, all/active choice, "bin into
   layers" button → binLayers + replaceLayers. "Engaged" = has a range on
   the active layer OR was opened this session (local state set). Arity and
   fn_hex leave the old tier sections.
6. **Numeric ordering** — `orderValuesByCount` grows dim-awareness (or a new
   `orderValues(dim, values, conditioned)`): numericSort dims sort ascending
   by value; others keep count-descending.
7. Copy/Paste + Views presets use the new spec signatures; on the groupplot
   tab pass (plot, groupPlot.facet); applying a groupplot spec writes plot +
   facet. Header unchanged otherwise (global Reset stays table/anatomy-only).

## Contract: components/plot-panel.tsx

- Read `config.size` / `config.opacity` for the plot-level multipliers
  everywhere the per-setting size/opacity used to apply (points, whiskers,
  mean lines, ghosts, epoch ribbons/lines/vertices). Per-series: color,
  `shapeForValue(series.style.shape)`, `dashForValue(series.style.dash)`.
- splitBy is gone: no combo labels (`series.label` = layer name), colorBy
  active when `config.layers.length === 1`.
- **Epoch-mode line hover** (new): every ghost run-polyline and every group
  mean-polyline gets an invisible companion hit stroke (same points,
  `stroke="transparent"`, strokeWidth ~10, `pointerEvents="stroke"`,
  fill none). Hover feeds the existing HTML tooltip (track pointer position
  for placement). Ghost tooltip: layer name; `fnText(arity, tt)` · run_id;
  then the run's values for parameters that VARY within that layer (use
  averagedParams defs, cap 4, "label: value" lines). Ghost CLICK opens the
  run inspector (openDetail + expandChain) — ghostRuns entries must carry
  runId + layer key for this. Mean-line tooltip: layer name, `n runs`
  (series rows length), and `judge: X` when the series has a unique judge.
  Scatter-mode ghosts/points unchanged.
- Export legend (data-export-only) simplifies: one row per layer.

## Contract: components/group-plot.tsx + table-pane.tsx + boolback-client.tsx + filter-bar.tsx

- group-plot reads the SHARED config: `useBoolbackStore((s) => s.plot)` for
  everything + `s.groupPlot` for facet/panelMin. Facet literal "layer".
  Apply plot-level size/opacity and per-layer shape/dash in panels (styles:
  color/shape/dash per series; size/opacity from config).
- table-pane persistence: `boolback:plot` persists PlotConfig (dominant-cell
  pristine-default hydration stays); `boolback:groupplot` now persists ONLY
  GroupPlotExtras via sanitizeGroupExtras (old fat blobs → extras defaults).
- filter-bar/top bar: grep for any band/ghosts/trend toggle remnants and
  remove them (the plot style row is the one home). Keep the r/ρ readout.
- boolback-client: unchanged unless types force it.

## Tests

Update/extend: types.test (LayerStyle sanitize, plot size/opacity sanitize,
old-shape blob → default), split-dims.test (flat resolver, judge, overlap,
empty layers, averagedParams new signature), spec.test (v4 round-trips, v3
rejected, groupplot = plot + facet), store.test (renamed mutators,
replaceLayers, shared-config reset), NEW generators.test (expand all/active,
bin quantile/width edge-dedup, style seeding incl. multi-parent shape rule,
name/prefix rule), select cascade tests (repairPins), config-panel.test
(plot style row writes setPlot; expand popover generates layers; bin control;
cascade note; numeric arity order; no split UI; layer rename strings).

## Gates

`npx tsc --noEmit` · `npx eslint app/boolback` · `npx vitest run app/boolback`
· `npm run build` — all green before done.

Out of scope: CMT `render.py` spec-v4 sync (separate repo; noted for Tom).
