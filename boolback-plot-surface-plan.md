# boolback PLOT-SURFACE rework — implementation contract

Tom-approved follow-up to the LAYERS rework (see boolback-layers-plan.md for
the layer model — still binding). Three changes:

1. **ONE renderer.** Extract the main plot's drawing + interaction machinery
   into a shared `components/plot-surface.tsx`; the Group Plot's panels are
   compact PlotSurfaces — "smaller versions of the main plot with all the
   same functionality" (tooltips, ghost/mean-line hover, click-to-inspect,
   linked highlights, per-panel trend). The bespoke `Panel` renderer dies.
2. **Box-select drag is REMOVED COMPLETELY** (Tom: "I don't care about box
   select dragging to change the view"). The drag→plot-level-range gesture,
   its rubber band, pointer handlers and background hint all go. The
   `PlotConfig.ranges` FIELD stays (spec-driven, resolver still ANDs it);
   nothing in the UI writes it anymore. Axis view-window editors
   (xDomain/yDomain) and log toggles are unrelated and stay.
3. **Facet by metric BINS** — Group Plot panels can facet by a binned
   continuous metric: complexity (FUNCTION group), OUTCOME-group metrics,
   and the derived **max trained epoch**.

HARD RULES (unchanged): no back-compat / old-key acceptance (the old string
facet shape DIES — persisted blobs coerce to defaults); vocabulary "layer";
match existing code style; update stale header comments you touch.

---

## Contract: facet model (lib/types.ts) — ALREADY IMPLEMENTED inline

```ts
export type GroupFacet =
  | { kind: "layer" }                     // one panel per layer
  | { kind: "param"; key: string }        // one panel per parameter value
  | { kind: "bins"; metric: string; n: number; mode: "quantile" | "width" };
export interface GroupPlotExtras { facet: GroupFacet | null; panelMin: number }
```
`sanitizeGroupExtras` validates the union (anything else → null; the OLD
string form is dropped). Spec v4's `facet` key carries the same object
(`coerceFacet` in parseSpec; string forms rejected).

## Contract: derived metric `max_epoch` (lib/select.ts) — ALREADY IMPLEMENTED

`numericValue(row, "max_epoch")` = max of `trajectories.completed_epochs`
(null when absent/empty). `metricLabel(index, "max_epoch")` = "Max trained
epoch" (lib/metrics.ts). It flows through ranges/histograms/binning like any
metric id.

## Contract: shared bin partitioning (lib/generators.ts) — ALREADY IMPLEMENTED

```ts
export interface Bin { lo: number; hi: number; max: number; label: string }
export function partitionBins(values: number[], n: number, mode: "quantile" | "width"): Bin[]
```
`hi` is the clean edge (labels/titles), `max` the ε-shrunk inclusive upper
bound (last bin: max === hi) so bins PARTITION. `binLayers` now uses it.

## Contract: components/plot-surface.tsx (NEW) — the one renderer

Extracted from plot-panel.tsx with NO behavior change beyond the box-select
removal. Owns everything between the axes for BOTH modes:

- scatter: grouped points (shape/color/size), ±SD whiskers, per-series mean
  lines (dash), ghost points, invisible per-point hit targets;
- epoch: ghost run-lines, ±SD ribbons, mean lines (dash/width), vertices,
  the fat invisible hit strokes for ghost + mean lines;
- interactions: HTML tooltip (positioned inside ITS OWN container — works in
  a grid of panels), hover, click-to-inspect (points, vertices, ghost
  lines → openDetail + expandChain), linked hoveredDir/selectedDir rings;
- axes: gridlines + tick labels from a caller-supplied scale;
- trend: when `config.trend`, the surface fits OLS over ITS OWN run-deduped
  pairs and draws the line; compact surfaces also print a small `r=…` corner
  readout. (For the main plot "its own pairs" IS the global set, so behavior
  is unchanged; it keeps publishing the full readout to the top bar.)
- `compact` mode: smaller fonts/radii/tick counts, no export-only groups, no
  colorbar (main plot only).

Suggested props (the extraction agent owns the exact shape; keep it PURE of
the store except the linked-highlight reads + openDetail/expandChain):
size {W,H,pad}, scale {sx,sy,ticks}, mode data (visual points / epoch
groups+ghosts), seriesByKey, config slice (band/ghosts/trend/size/opacity),
colorBy plumbing, compact flag, tooltip-content builders (or the averaged
defs needed to build them).

plot-panel.tsx keeps: ResizeObserver sizing, axis resolution/scales, series
resolution + point building, epoch building, readout publication, export
handle/CSV, axis pickers + log toggles + AxisRange editors + colorbar — and
renders ONE `<PlotSurface>`. DELETE: drag/box-select state + handlers +
rubber band + `MIN_DRAG` + the background "drag a box…" title + the
`addRange("plot", null, …)` writes.

## Contract: components/group-plot.tsx — panels ARE PlotSurfaces

- Facet derivation handles all three kinds: "layer" (one panel per layer,
  that layer's series), "param" (per value over the union, row×series pairs
  as today), "bins" (NEW): values = `numericValue(row, facet.metric)` over
  the DEDUPED union; edges = `partitionBins(values, n, mode)` over that
  union (panels mean the same slice for every layer); a row lands in the bin
  where `lo <= v <= max`; rows with a null metric are DROPPED and the facet
  strip notes it ("· N runs lack <label>"). Panel id/title = bin label
  (`metricLabel` + `lo–hi`), ordered low→high; count = distinct runs.
- Each panel renders a compact `<PlotSurface>` with the SHARED scale (global
  extent, as today) — panels gain tooltips, ghost/mean hover, click-through,
  linked rings, per-panel trend for free. The old `Panel`
  renderer + its tick helpers are DELETED.
- Perf stays: LazyPanel content-visibility windowing, MAX_FACETS 150,
  per-panel ghost caps as in the main plot.

## Contract: components/config-panel.tsx — Facet-by UI

The "Facet by" select becomes kind-aware:
- (none) / "layer (one panel per layer)" / the differing parameters
  (unchanged), PLUS optgroups for binnable metrics: **complexity** (FUNCTION
  group), **outcomes** (the Y_GROUP_ORDER outcome groups), and the pinned
  **"Max trained epoch"** (`max_epoch`).
- Choosing a metric writes `facet: { kind: "bins", metric, n: 3, mode:
  "quantile" }` and reveals a compact row beside the select: n (2–8) +
  quantile|width — same controls/labels as the bin-into-layers control.
  Changing n/mode patches the facet object.
- Param choices write `{kind:"param",key}`, "layer" writes `{kind:"layer"}`,
  (none) writes null.

## Tests

- types: sanitizeGroupExtras union (valid kinds pass, strings/garbage →
  null). spec: facet object round-trip (all three kinds), string facet
  rejected. select: max_epoch derived values. generators: partitionBins
  (labels, ε-partition, quantile collapse) — binLayers behavior unchanged.
  [ALREADY DONE inline]
- group-plot/config-panel/plot-panel: box-select gone (no rubber band, no
  plot-level range writes), facet-by-bins panels derive correctly (counts
  sum to distinct union minus null-metric rows), facet UI writes the union
  shapes, panel PlotSurface renders tooltips/hit strokes.

## Gates

`npx tsc --noEmit` · `npx eslint app/boolback` · `npx vitest run app/boolback`
· `npm run build` — all green.

Deploy note: push main ONLY (same-SHA dual push suppresses the production
build — see reference memory 2026-07-15); confirm a Production row in
`npx vercel ls`.
