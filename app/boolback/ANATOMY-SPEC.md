# boolback — Anatomy view: implementation spec

Third center view alongside Table|Chart. One unified visualization of *where in
the model* each interp measurement sits and *how it performs*, designed to scale
from whole-model overview to a single neuron. Supersedes the deferred sketch in
`ANATOMY-TODO.md` (boolback-redesign branch) per design conversation with Tom
(2026-07-04): single view (not block+spine), residual bar top / twin bar bottom,
accordion zoom, arc-diagram circuits, no token-position axis.

## The unified view — three horizontal bands

Data always flows left → right: embed (inputs) at the left edge, unembed/logits
at the right edge. Vertically:

1. **Run band (top)** — the selected run's residual stream as a horizontal bar
   spanning the full pane width. Blown-up structure (block internals, head
   slots, neuron strips) hangs BELOW the bar.
2. **Contrast band (bottom)** — the run's function-false twin (`twin_hash`
   pairing), mirrored: its residual bar at the bottom, structure growing UP.
   Toggleable; collapses when absent/off (run band + structure then use the
   full height). Twins share the base model, so bars align layer-for-layer.
3. **Middle strip** — the contrast surface: per-layer Δ(run − twin) diverging
   heat ribbon at low zoom, paired markers at high zoom. Circuit arcs also
   live in the middle region.

## The accordion depth axis (the core mechanism)

NOT pan/zoom. A non-uniform x-scale with **pinned ends**: embed always at the
left pane edge, unembed always at the right; segment widths always sum to pane
width. Zooming reweights width toward the focus; everything else compresses
but never leaves the screen. The whole model is always visible.

The hierarchy nests along the same axis (icicle-style): model → layer →
(attn | mlp) → head | neuron-bin. Expanding layer 17 gives it width; within
that width its attn segment subdivides into head slots, its mlp into a binned
neuron strip. Depth order is strictly left→right; within a component, x is
index. Everything is one weighted 1-D scale.

Engine (`lib/anatomy.ts`, pure + unit-tested):
- Unit paths: `"embed"`, `"L17"`, `"L17/attn"`, `"L17/attn/h9"`, `"L17/mlp"`,
  `"unembed"`. State = `{ weights: Record<path, number> }` (default 1 per
  layer; focused paths get large weights, e.g. ×30 per level).
- `buildScale(state, nLayers, widthPx) → Scale` with
  `xForPath(path) → {x0,x1}`, `xForLocus(measurement) → x-center`,
  `lodForPath(path) → px width`. Cumulative-weight piecewise-linear mapping.
- Zoom = multiplicative weight change centered on the unit under the cursor
  (wheel), or "blow up" (click a layer/head → it gets ~70% of pane width).
  Double-click empty space → reset uniform. Clamp weights; renormalize.
- Animate weight changes by lerping weights over ~180ms (rAF); positions
  derive per frame. Representation swaps (LOD changes) crossfade opacity.
  Positions must NEVER jump discontinuously across an LOD threshold.

## LOD ladder (semantic zoom by px-per-unit)

| level     | representation                                                     | threshold        |
|-----------|--------------------------------------------------------------------|------------------|
| model     | residual bar + per-layer aggregate heat cells; lanes as ribbons    | layer < ~8px     |
| layer     | block containers, read/write tap arrows, discrete markers + ghosts | layer ≥ ~8px     |
| component | attn splits into head slots; mlp becomes a binned neuron strip     | layer ≥ ~250px   |
| leaf      | single head's measurements; 1px = 1 neuron; index labels appear    | slot ≥ ~10px     |

Neuron strips render binned to available px (bin value = max |weight| of
top-k components landing in the bin) — plain `<rect>` runs, no canvas.

## Encodings

- **position** = locus (accordion x for layer/component/head/neuron; y = band).
- **carrier → color** (single-run mode). Small display map in `lib/anatomy.ts`,
  dark-mode-correct (pair with the site's CSS-variable conventions):
  direction≈emerald, subspace≈sky, feature≈violet, circuit≈orange, lens≈pink,
  other≈gray. Read carriers from the DATA (taxonomy is CMT-side SSOT); the
  display map is color-assignment only, with a deterministic fallback for
  unknown carriers.
- **mode → glyph + tap direction**: observational = circle marker; at
  layer-LOD+ also a read-tap arrow OUT of the stream. Interventional =
  diamond marker; write-tap arrow INTO the stream.
- **delta (= value − null_control) → marker size/intensity.**
- **null_control → always-visible faint ghost**; `INTERP NULL` (delta ≈ 0)
  renders faint on purpose, never hidden.
- **Compare-mode handoff (design decision, locked)**: when a differing
  dimension claims color (dimensions-panel overlay, follow-up pass), carrier
  moves to shape. Build markers behind a `MarkerGlyph(carrier, mode, ...)`
  abstraction now so the handoff is cheap; do NOT implement the full overlay
  in this pass.

## Circuits — arc diagrams, not a separate view

A circuit measurement (`locus_shape: "subgraph" | "path"`) carries `nodes`
(each with layer/component/head) and `edges` (index pairs). Nodes render at
their loci on the bars/slots; edges as bezier arcs through the middle region.
Left→right is automatic (edges go earlier→later). Selecting a circuit
highlights its nodes+arcs and offers **fit circuit**: set accordion weights so
all its layers are expanded at once. Circuit diff vs twin: arcs present in
only one of the pair get emphasized (which side, by color); this answers "did
changing the trigger rewire the circuit."

## Twin / contrast specifics

- Both bars share ONE accordion scale — expansion applies to both.
- Diff strip matching key: `(method, metric_name, layer, locus_component,
  head)`. Per-layer aggregate at low LOD (max |delta| each side), diverging
  colors (run-excess vs twin-excess — use two NON-carrier colors, e.g. the
  site accent vs amber, so the strip never reads as a carrier).
- Twin selection: the paired run found via `twin_hash` among loaded rows,
  same base model. Absent → band collapses, a subtle affordance says why.

## Interaction & integration

- Hover: tooltip (method, metric, value/null/delta, locus); cross-highlight
  with Table/Chart selection ring the way Chart already does.
- Click marker → detail panel (existing `detail-panel.tsx`) with a new
  anatomy section: full record, kind-specific extras, CDE dose-response
  `curve` sparkline (epoch-sparkline pattern), top-k components mini-bars.
- Filter bar + tree scope which runs' measurements show (shared mechanism).
  The anatomy view shows ONE run (+ its twin): the selected row if it's in
  the filtered set, else the first filtered row; a compact run selector in
  the pane header (model is a facet of the run — never two models at once).
- Share links (`?v=`): view:"anatomy" + accordion weights + selected
  measurement + twin toggle round-trip. Persisted center view like others.
- Keyboard: ←/→ step focus across layers, +/- zoom focused unit, Esc reset.

## Derived scalars → Chart (per-method bases in `lib/method-metrics.ts`)

From `layer_profile` (per-layer sweep) or single-layer measurements:
- `interp_peak_layer@<kind>` — argmax layer of delta;
- `interp_loc_width@<kind>` — # layers with delta ≥ 50% of peak;
- `interp_depth_com@<kind>` — delta-weighted center of mass, normalized 0–1.
Synthesized into metric_schema at normalize like the existing per-method
bases, so chart axes/filters/table columns pick them up unchanged.

## Data contract (additive; NO schema bump; normalize stays tolerant)

Per run (all optional, inferred when absent):
- `n_layers` (fallback: max observed layer + 1), `n_heads`, `d_mlp`
  (normalize into one in-memory `model_shape`).

Per measurement (existing `{kind, value, null_control}` stays valid):
- `method`, `metric_name`, `delta`, `layer`, `locus_component`
  (resid|attn|mlp|embed|unembed), `locus_shape`
  (point|head|subgraph|path|parameter|global), `head`,
- taxonomy: `carrier`, `mode` (observational|interventional), `op`, `metric`,
- `twin_hash`,
- `layer_profile`: `[layer, delta][]` (per-layer sweep),
- `nodes`: `{layer, component, head?}[]` + `edges`: `[i,j][]` (circuits),
- `components`: `[neuron_index, weight][]` top-k (directions/features),
- `extras`: rotation_rank, sparsity, reconstruction, auroc, direction_norm,
  model_diff, model_specific_features, `curve` (CDE dose-response).

The synthetic fixture is `data/sample-snapshot.json`, generated in place by
`data/enrich-fixture.mjs` (idempotent; fabricated DEMO data pending real CMT
scope-A emission — only the FUNCTION complexity metrics are computed exactly).
Roster: 8 rows / 7 functions / 3 base models, a function-false twin pair per
model — Llama@c 32L (legacy 2:0 + planted AND 2:8 ×2 seeds + XOR 2:6, one
circuit edge changed), gpt2s@d 12L (majority 3:E8 vs parity 3:96: probe at
EVERY layer, three lit heads on L5, both cap lanes, a parameter locus) and
qwen72@e 80L (AND-of-4 4:8000 vs A&B&(C|D) 4:8880: ×3 badge clusters at
L50–L54, matched negative head ablations at L40 h9+h58, a run-only shallow
circuit plus a deep one rewired by two edges, two SAE features, a 9-point CDE
curve). The dev page renders this via the Turing-down sample fallback, and
Playwright fulfills the blob route with a gzip of this same file for
banner-free pixel checks.

## Files

- `lib/anatomy.ts` + `lib/anatomy.test.ts` — scale/LOD/layout/palette/matching
  (pure; this is where the math correctness lives).
- `components/anatomy-pane.tsx` — the view (pure SVG + CSS variables,
  dark-mode-correct, no charting library).
- `components/anatomy-detail.tsx` — detail-panel section.
- Edits: `lib/types.ts`, `data/normalize.ts`, `lib/method-metrics.ts`,
  `lib/share.ts`, `state/store.ts`, `components/filter-bar.tsx`,
  `components/detail-panel.tsx`, `data/sample-snapshot.json`.
- Root pane gets `data-anatomy-ready` once the fixture has rendered (the
  screenshot harness waits on it).

## Verification

- `npx vitest run app/boolback` — engine math (scale sums to width, pinned
  ends, LOD thresholds, locus→x monotonicity, diff matching, derived scalars)
  + normalize tolerance (old blob without anatomy fields still loads).
- `npx tsc --noEmit`.
- Pixels: the screenshot harness (scratchpad `anatomy-shot.mjs`) against
  `next dev`, states: overview / layer-expanded / head-expanded / neuron /
  twin-diff / circuit-selected × light+dark × 1280w+2560w.

## Design latitude (per Tom, 2026-07-04)

Implementing agents SHOULD make visual/UX design decisions beyond this spec —
spacing, typography, color intensity, hover affordances, animation timing,
empty states, legends, micro-copy — whenever the pixels say so, and record
each decision (one line: what + why) in the run's DECISIONS log for review.
What must NOT change silently: band order, pinned-end accordion model, the
encodings table, left→right flow, one-model-per-view, no token axis. Flag
structural concerns back instead of implementing around them.
