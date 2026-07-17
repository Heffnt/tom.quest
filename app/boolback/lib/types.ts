// app/boolback/lib/types.ts — PINNED CONTRACT. All components import from here.
//
// These types mirror the NORMALIZED in-memory bundle produced by
// data/normalize.asBundle(). The CMT tom_quest builder emits schema v2
// ({functions} map + slim identity); v1 blobs (embedded per-row function,
// tree array) are normalized into the same shape at load, so everything
// downstream sees ONE contract:
//
//   * bundle.functions: one FunctionBlock per distinct function_hash;
//   * row.function: a SHARED REFERENCE into bundle.functions (attached at
//     normalize — never a copy), so select.ts/columns.ts read it directly;
//   * identity.dir_path: the run's on-disk node path relative to the artifacts
//     root (v2 only; null on v1 blobs — the raw-artifact browser hides itself);
//   * anatomy fields (2026-07, Anatomy view): the per-run model shape
//     (n_layers/n_heads/d_mlp) and the InterpReading locus/taxonomy/
//     circuit fields are ADDITIVE and OPTIONAL — v1 blobs, older v2 blobs,
//     and the browser-cached last-good blob all predate them, so every
//     consumer must tolerate their absence.
//
// VOCABULARY: the app is single-vocab (reading / snake_case). Old blobs use
// measurement vocab (interp.measurements / measurement_kind); data/normalize
// is the ONE airlock that translates old→new at load. See normalize.ts.

import { CATEGORY_PALETTE, paletteColor } from "./styling";

// ---------------------------------------------------------------------------
// Snapshot envelope (tom_quest/build.py, normalized)
// ---------------------------------------------------------------------------

// v3 is the reading-vocab snapshot (CMT builder in flight); v1/v2 are the
// legacy measurement-vocab blobs data/normalize still translates.
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3] as const;

export interface Bundle {
  schema_version: number;
  meta: Meta;
  metric_schema: MetricSchemaEntry[];
  column_groups: ColumnGroup[];
  friendly: Friendly;
  functions: Record<string, FunctionBlock>;
  /** Dir-viewer tree (v1: from the blob; v2: derived from rows' dir_path). */
  tree: TreeNode[];
  rows: RunRow[];
}

// ---------------------------------------------------------------------------
// Tree (dir viewer) — function -> dataset -> training leaves only. v1 blobs
// carry this array; for v2 normalize derives it from the rows.
// ---------------------------------------------------------------------------

export type TreeLevel = "function" | "dataset" | "training";

export interface TreeNode {
  path: string; // globally-unique cumulative: "fn=H" | "fn=H/ds=H" | "fn=H/ds=H/tr=H"
  dirName: string; // on-disk "function+slug+hash" etc. (NOT unique)
  level: TreeLevel;
  slug: string;
  hash: string;
  kind: TreeLevel; // === level
  done: boolean; // v2: derived (training done iff run not in_progress; parents = all children)
  run_ids: string[]; // NODE_KEY run_ids (tr-paths) under this subtree
  children: TreeNode[];
}

export interface Meta {
  source_dir: string;
  built_at: string; // "YYYY-MM-DDThh:mm:ssZ"
  tree_mtime_key: number; // newest done.json mtime (0 if none)
  arity_max: number;
  row_count: number;
  function_count?: number; // v2 only
  tree_node_count: number;
  /** CMT's PLANTED_THRESHOLD (newer snapshots; consumers default to 0.95). */
  planted_threshold?: number;
}

/** planted ⇔ plantedness ≥ this. Prefer the snapshot's value; 0.95 is CMT's default. */
export function plantedThreshold(meta: Meta | null | undefined): number {
  return meta?.planted_threshold ?? 0.95;
}

// ---------------------------------------------------------------------------
// Metric schema (tom_quest/schema.py)
// ---------------------------------------------------------------------------

// v3 splits OUTCOME metrics by suite: "attack" (backdoor efficacy) vs.
// "capability" (utility/perplexity). DEFENSE/INTERP/SCAN entries keep "outcome".
// Older/cached v1/v2 blobs only ever carry structural|spectral|outcome.
export type MetricSuite = "structural" | "spectral" | "outcome" | "attack" | "capability";
export type MetricGroup = "FUNCTION" | "OUTCOME" | "DEFENSE" | "INTERP" | "SCAN";
export type MetricDtype = "count" | "fraction"; // never "bool"
export type MetricProvenance = "exact" | "heuristic";

export interface MetricSchemaEntry {
  name: string;
  label: string; // snake -> "Capitalized words"
  suite: MetricSuite;
  group: MetricGroup;
  dtype: MetricDtype;
  min: number | null; // empirical; null only if metric never observed
  max: number | null;
  format: string; // "d" | ".3f" | ".0f" | ".1f" | "+.2f"
  provenance?: MetricProvenance; // ONLY on FUNCTION entries
}

export interface ColumnGroup {
  group: string; // FUNCTION,DATASET,TRAINING,OUTCOME,DEFENSE,INTERP,SCAN
  columns: string[];
}

export interface Friendly {
  column_labels: Record<string, string>; // dotted-raw -> short
  facet_labels: Record<string, string>; // short -> "space separated"
  tuning_labels: Record<string, string>; // slug -> label
}

// ---------------------------------------------------------------------------
// RunRow (reshape._build_run_row) — one row per training run (NODE_KEY)
// ---------------------------------------------------------------------------

export interface RunRow {
  identity: Identity;
  /** Optional human-readable run name (builder- or fixture-emitted; the demo
   * fixture names every row). Display surfaces fall back to identity.run_id
   * when absent — older blobs never carry it. */
  label?: string | null;
  /** Shared reference into bundle.functions (attached by normalize). */
  function: FunctionBlock;
  dataset: DatasetBlock;
  training: TrainingBlock;
  headline: Headline;
  trajectories: Trajectories;
  per_judge: PerJudge[];
  per_tt_row: PerTtRow[];
  defense: Defense | null;
  interp: Interp | null;
  scan: Scan | null;
  epoch0_baseline: Epoch0Baseline | null;
  twins: Twins | null;
  /** Model shape (newer builders; absent on pre-anatomy blobs — the Anatomy
   * view infers n_layers as max observed measurement layer + 1 when missing).
   * Top-level builder-emitted fields; NOT renamed in memory. */
  n_layers?: number | null;
  n_heads?: number | null;
  d_mlp?: number | null;
  status: Status;
}

export interface Identity {
  run_id: string; // "fn=H/ds=H/tr=H"
  function_hash: string;
  dataset_hash: string;
  training_hash: string;
  /** On-disk "function+…/dataset+…/training+…" relative to the artifacts root (v2; null on v1). */
  dir_path: string | null;
  /** === run_id (v2 blobs omit it; normalize re-derives). Tree/table selection key. */
  node_path: string;
  /** [fn=H, fn=H/ds=H, run_id] (v2 blobs omit it; normalize re-derives). */
  chain_dirs: string[];
}

export interface ActivationRow {
  presence: number[]; // 0/1 list len=arity, LSB-first per TruthTable.rows()
  present_vars: number[]; // indices i where presence[i]==1
  activates: boolean;
}

export interface FunctionBlock {
  arity: number;
  truth_table: string;
  activation: ActivationRow[]; // length === 2**arity
  dnf_string: string; // minimal-cover; "0"=const False, "1"=const True
  complexity: Record<string, number | null>; // ~61 keys; some null (scipy caps)
}

export interface DatasetBlock {
  /** The flat dataset-registry name (sst2/mmlu/…). Newer blobs only; older
   * cached blobs carry `source`/`task` instead (the CMT Task×Source duality,
   * now flattened) — consumers fall back `dataset ?? source`. */
  dataset?: string | null;
  source?: string | null;
  task?: string | null;
  trigger_form: string | null;
  target_behavior: string | null;
  row_distribution: string | null;
  samples_per_row: number | null;
  backdoor_ratio: number | null;
  scheme: string | null;
  target_phrase: string | null;
}

export interface TrainingBlock {
  base_model: string | null;
  backend: string | null;
  lr: number | null;
  epochs: number | null;
  seed: number | null;
  tuning: string | null; // slug e.g. "lora-r16"
}

export interface Headline {
  primary_inference_hash: string | null;
  primary_scoring_hash: string | null;
  primary_judge: string | null;
  display_epoch: number | null;
  plantedness: number | null;
  asr: number | null;
  ftr: number | null;
  triggerless_correctness: number | null;
  n_activating: number;
  ppl: number | null;
  ppl_drift: number | null;
  /** v3: {0,1} planted indicator (null if plantedness null); OUTCOME group,
   * suite "attack". Absent on v1/v2/cached blobs — every consumer tolerates it. */
  planted_fraction?: number | null;
}

export interface Trajectories {
  completed_epochs: number[];
  plantedness: (number | null)[];
  asr: (number | null)[];
  ftr: (number | null)[];
  ppl: (number | null)[];
}

export interface PerJudge {
  inference_hash: string;
  scoring_hash: string;
  judge: string;
  split: string;
  is_primary: boolean;
  by_epoch: {
    asr: (number | null)[];
    ftr: (number | null)[];
    plantedness: (number | null)[];
  };
}

export interface PerTtRow {
  presence: number[];
  target_rate: number | null;
  correctness_rate: number | null;
  activates: boolean;
}

export interface DefenseMethod {
  method: string;
  asr_drop?: number;
  recovery_rate?: number;
  // The rest of the *_drop self-join family (newer builders; per-method only).
  ftr_drop?: number;
  triggerless_correctness_drop?: number;
  target_rate_drop?: number;
  correctness_rate_drop?: number;
  info_tier?: unknown;
  contract?: unknown;
  demands?: unknown;
  /** v3: post-defense AFTER values (per-method only, no generic rollup);
   * metric names residual_asr@<method> / residual_ftr@<method>. */
  residual_asr?: number;
  residual_ftr?: number;
  /** Terminal-detector operating point (per-method only, no generic rollup);
   * metric name auroc@<method> — newer builders fold the detection walker's rows. */
  auroc?: number;
  /** v3: method class — always "defense" on a defense method slot. */
  type?: string;
  /** Note on a registry-less relic slug (pre-reclassification defenses). */
  legacy?: string;
}

export interface Defense {
  asr_drop: number | null;
  recovery_rate: number | null;
  methods: DefenseMethod[];
}

// ---------------------------------------------------------------------------
// Interp readings — the Anatomy view's data source. The builder has always
// shipped {kind, value, null_control}; everything else below is ADDITIVE
// (2026-07, Anatomy view) and OPTIONAL, because v1 blobs, older v2 blobs and
// the browser-cached last-good blob predate the fields. data/normalize
// translates the old-vocab blob keys (measurements/measurement_kind) into the
// reading vocab below, so downstream sees ONE contract.
// ---------------------------------------------------------------------------

/** Which stream/site a measurement (or circuit node) reads or writes. */
export type LocusComponent = "resid" | "attn" | "mlp" | "embed" | "unembed";

/** Spatial extent of the locus — drives the marker/arc representation. */
export type LocusShape = "point" | "head" | "subgraph" | "path" | "parameter" | "global";

/** Read-out-of vs. write-into the stream (circle vs. diamond marker). */
export type InterpMode = "observational" | "interventional";

/** One node of a circuit reading (locus_shape "subgraph" | "path"). */
export interface CircuitNode {
  layer: number;
  component: LocusComponent;
  head?: number; // attn nodes only
}

/** Kind-specific scalars. Open-ended on purpose: the taxonomy is CMT-side
 * SSOT, so unknown keys must survive the round trip. */
export interface InterpExtras {
  rotation_rank?: number;
  sparsity?: number;
  reconstruction?: number;
  auroc?: number;
  direction_norm?: number;
  model_diff?: number;
  model_specific_features?: number;
  /** CDE dose-response: [dose, effect][] pairs (detail-panel sparkline). */
  curve?: [number, number][];
  [key: string]: unknown;
}

export interface InterpReading {
  kind: string;
  value: number | null;
  null_control: number | null;
  /** v3: method class — always "interp" on a reading entry. */
  type?: string;
  // --- depth-profile HEADLINE summaries (newer builders fold the per-layer
  // curve via CMT's summarize_profile home; ALL optional — older blobs and
  // single-layer kinds lack them). Metric names interp_<summary>@<kind>. ---
  min_value?: number;
  divergence_auc?: number;
  argmin_depth?: number;
  first_drop_depth?: number;
  peak_strength?: number;
  // --- anatomy locus/taxonomy (ALL optional — see section comment) ---
  method?: string;
  metric_name?: string;
  /** value − null_control (marker size/intensity; ≈0 = honest INTERP NULL,
   * rendered faint on purpose — never hidden). */
  delta?: number | null;
  layer?: number | null; // null/absent for global/parameter loci
  locus_component?: LocusComponent;
  locus_shape?: LocusShape;
  head?: number | null; // locus_shape "head" only
  /** CMT taxonomy carrier. Known values today: direction | subspace |
   * feature | circuit | lens | other — but the set is OPEN (CMT-side SSOT);
   * display maps need a deterministic fallback for unknown carriers. */
  carrier?: string;
  mode?: InterpMode;
  op?: string;
  metric?: string;
  /** function_hash of the run's function-false twin — pairs this
   * reading with the twin run's for the contrast band / diff strip. */
  twin_hash?: string;
  /** Per-layer sweep: [layer, delta][]. */
  layer_profile?: [number, number][];
  /** Circuit nodes (locus_shape "subgraph" | "path"). */
  nodes?: CircuitNode[];
  /** Circuit edges as [from, to] indices into nodes; earlier layer → later. */
  edges?: [number, number][];
  /** Top-k [neuron_index, weight] pairs (directions/features). */
  components?: [number, number][];
  extras?: InterpExtras;
}

export interface Interp {
  reading_kind: string | null;
  value: number | null;
  null_control: number | null;
  reference_model_diff: number | null;
  /** v3: method class — always "interp" on the interp rollup. */
  type?: string;
  /** ALL reading kinds on the run (newer builders; headline fields keep one).
   * NOTE: the raw blob names this `measurements` on v1/v2 (measurement vocab);
   * data/normalize translates it to `readings` at load — the app is single-vocab. */
  readings?: InterpReading[];
}

export interface ScanMethod {
  method: string;
  /** v3: detector cut = (method, scheme, negative_facet); "-" fills an absent
   * scheme/facet in the per-cut metric name scan_auroc@<method>|<scheme>|<negative_facet>.
   * Older blobs left `scheme` an opaque passthrough, so it stays widened. */
  scheme?: string | null;
  negative_facet?: string | null;
  cut?: string;
  /** v3: method class — always "scan" on a scan method slot. */
  type?: string;
  auroc: number | null;
  far_at_frr: number | null;
}

export interface Scan {
  auroc: number | null;
  far_at_frr: number | null;
  method_family: unknown;
  scheme: unknown;
  /** Per-method detail (newer builders; headline fields keep first-observed). */
  methods?: ScanMethod[];
}

export interface Epoch0Baseline {
  plantedness: number | null;
  asr: number | null;
  ftr: number | null;
  triggerless_correctness: number | null;
  n_activating: number;
  ppl: number | null; // ALWAYS null here
  per_tt_row: PerTtRow[];
}

export interface Twins {
  reference_hash: unknown;
  model_diff: unknown;
  consumer_value: unknown;
  reference_value: unknown;
}

export interface Status {
  in_progress: boolean;
  has_defense: boolean;
  has_twin: boolean;
  has_scan: boolean;
  has_interp: boolean;
  has_negative_drop: boolean;
  planted: boolean; // plantedness >= 0.95
}

// ---------------------------------------------------------------------------
// UI state types
// ---------------------------------------------------------------------------

export type SortDir = "asc" | "desc";
export interface SortKey {
  col: string;
  dir: SortDir;
} // col = a RunRow-derived column path or metric name

export type RangeFilter = { metric: string; min: number; max: number };

// Facet keys are CMT tidy-column snake_case (they double as spec/render.py
// column names — the snake_case unification is what lets a browser spec drive
// the paper figure). "split" is train/test (labelled "train/test" in the UI);
// it is NOT the "split" treatment.
export type FacetKey =
  | "dataset"
  | "target_behavior"
  | "trigger_form"
  | "row_distribution"
  | "scheme"
  | "target_phrase"
  | "samples_per_row"
  | "backdoor_ratio"
  | "base_model"
  | "tuning"
  | "backend"
  | "lr"
  | "epochs"
  | "seed"
  | "judge"
  | "split"
  | "arity";

// Slimmed FilterState: facets + ranges ONLY. Status flags are cut entirely;
// tree scope (subtreeDirs) is gone (the tree is a pure navigator now); search
// moved to the table view config. `filters` lives INSIDE each per-view config.
export interface FilterState {
  facets: Partial<Record<FacetKey, string[]>>; // empty/absent => all
  ranges: RangeFilter[]; // AND-composed
}

export const EMPTY_FILTER: FilterState = {
  facets: {},
  ranges: [],
};

/** Coerce any blob to a complete FilterState (facets + ranges); never throws. */
export function sanitizeFilters(raw: unknown): FilterState {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    facets:
      f.facets && typeof f.facets === "object" && !Array.isArray(f.facets)
        ? (f.facets as FilterState["facets"])
        : {},
    ranges: Array.isArray(f.ranges) ? (f.ranges as FilterState["ranges"]) : [],
  };
}

// ---------------------------------------------------------------------------
// Plot config (store-owned; the Plot / Group Plot views render from it, and the
// table's per-header "plot on X/Y" bridge writes into it).
//
// The plot's core object is a list of named, styled LAYERS. A layer is ONE
// trace: a saved selection across all parameters (an experimental condition,
// e.g. "classification" = dataset sst2 + target all-to-sentinel). The plotted
// rows are the UNION of the layers' matching rows; a run matching several
// layers is drawn once PER matching layer (duplication is surfaced as a warning
// count, never silently deduped). lib/split-dims.resolveSeries returns exactly
// ONE series per layer — multiple traces come from GENERATORS (lib/generators
// expand-by-parameter / bin-by-metric), which mint multiple layers, never from
// an in-layer split.
//
// Style splits two ways: PLOT-LEVEL style (size/opacity/band/ghosts/trend) lives
// on PlotConfig; LAYER-LEVEL style is the two glyph channels shape + dash (color
// is a first-class layer field). The Group Plot SHARES this PlotConfig — the
// store keeps one `plot` used by both tabs plus a separate GroupPlotExtras for
// the facet / panel-size preferences.
// ---------------------------------------------------------------------------

/** Per-layer glyph style — the two semantic channels a layer owns besides its
 *  color. shape = styling.SHAPE_COUNT glyph index; dash = DASH_PATTERNS index.
 *  Both default to 0 (plain circle / solid line). No per-layer size/opacity
 *  (those are plot-level) and no auto/null shape (that served splits). */
export interface LayerStyle {
  shape: number;
  dash: number;
}

export const DEFAULT_LAYER_STYLE: LayerStyle = { shape: 0, dash: 0 };

/** One named, styled trace on the plot. extends Record so it round-trips
 *  through usePersistedSettings. */
export interface PlotLayer extends Record<string, unknown> {
  /** Stable within the config; generated as "l" + smallest unused integer. */
  id: string;
  name: string;
  /** Hex; the series color (always — no palette-cycling rule). */
  color: string;
  /** Glyph styling (shape + dash). */
  style: LayerStyle;
  /** Facet selections (may also carry the layer's own ranges). A GROUP's own
   *  filters are UNUSED — its rows come from the union of its members — so a
   *  group carries the empty FilterState. */
  filters: FilterState;
  /** GROUP layers only: the member layers pooled into this one series (the
   *  resolver unions their filter matches, deduped by run identity, and styles
   *  the result with the GROUP's own color/style/name). Exactly ONE level — a
   *  member never has members; the sanitizer strips deeper nesting. Absent on a
   *  plain layer. */
  members?: PlotLayer[];
}

/** The Plot view's full config — layers + axes + PLOT-LEVEL style state. Shared
 *  by the Plot AND Group Plot views. extends Record so it round-trips through
 *  usePersistedSettings. */
export interface PlotConfig extends Record<string, unknown> {
  /** The plotted traces (sanitizer guarantees >= 1). */
  layers: PlotLayer[];
  /** PLOT-LEVEL ranges (drag-zoom writes here), ANDed onto every layer on top
   * of its own filters. */
  ranges: RangeFilter[];
  /** Continuous metric gradient; only honored when layers.length === 1. */
  colorBy: string | null;
  x: string; // metric_schema name, or the sentinel "epoch" (training progress)
  y: string; // metric_schema name
  // ---- PLOT-LEVEL style (was per-setting size/opacity + the bottom toggles) --
  size: number;    // marker/line size multiplier (1 = default)
  opacity: number; // opacity multiplier (1 = default)
  band: boolean;   // ±SD band / whiskers
  ghosts: boolean; // faint underlying runs
  trend: boolean;  // OLS line + r/ρ readout
  logX: boolean;
  logY: boolean;
  /** VIEW WINDOW only (zoom) — never filters the data. */
  xDomain: [number, number] | null;
  yDomain: [number, number] | null;
}

/** What the Group Plot facets its panels over. "bins" slices a continuous
 *  metric (complexity / outcome / the derived "max_epoch") into partitioned
 *  bins over the layers' union — one panel per bin. "grid" crosses TWO
 *  parameters (row × col facet keys, e.g. target_behavior × base_model) —
 *  one panel per non-empty cell. */
export type GroupFacet =
  | { kind: "layer" }
  | { kind: "param"; key: string }
  | { kind: "grid"; row: string; col: string }
  | { kind: "bins"; metric: string; n: number; mode: "quantile" | "width" };

/** Group Plot EXTRAS only — the plot config itself is SHARED (store.plot). */
export interface GroupPlotExtras extends Record<string, unknown> {
  /** Panel facet (null = pick one). */
  facet: GroupFacet | null;
  /** Panel size (px), user-adjustable. */
  panelMin: number;
}

export const DEFAULT_GROUP_EXTRAS: GroupPlotExtras = { facet: null, panelMin: 280 };

/** Smallest-unused-integer layer id ("l1", "l2", …). */
export function nextLayerId(existing: Iterable<string>): string {
  const used = new Set(existing);
  let i = 1;
  while (used.has(`l${i}`)) i++;
  return `l${i}`;
}

/** The Table view's config. `search` is table-only, with dir-path / run-id
 * fragment semantics (see lib/select.matchesSearch). extends Record so it
 * round-trips through usePersistedSettings. */
export interface TableConfig extends Record<string, unknown> {
  filters: FilterState;
  visibleCols: string[];
  columnWidths: Record<string, number>;
  sorts: SortKey[];
  search: string;
}

export const DEFAULT_PLOT: PlotConfig = {
  layers: [{ id: "l1", name: "all runs", color: CATEGORY_PALETTE[0], style: DEFAULT_LAYER_STYLE, filters: EMPTY_FILTER }],
  ranges: [],
  colorBy: null,
  x: "epoch",
  y: "plantedness",
  size: 1,
  opacity: 1,
  band: true,
  ghosts: true,
  trend: false,
  logX: false,
  logY: false,
  xDomain: null,
  yDomain: null,
};

// DEFAULT_PLOT stays a filter-EMPTY pure constant. The dominant-cell default
// (Feature 1: a fresh/reset view pins every parameter to its most-common value)
// is applied by the store's reset + the first-load hydration via the builder
// below, never baked into the constant.

/** DEFAULT_PLOT with its lone default layer pinned to `filters`. */
export function defaultPlotWithFilters(filters: FilterState): PlotConfig {
  return { ...DEFAULT_PLOT, layers: [{ ...DEFAULT_PLOT.layers[0], filters }] };
}

/** True iff `cfg` is byte-for-byte the pristine default (no persisted edits) —
 *  the signal the first-load hydration uses to decide it may install the
 *  dominant-cell default without clobbering a user's saved view. The
 *  sanitizer emits keys in DEFAULT_PLOT's order so this JSON compare holds. */
export function isDefaultPlotConfig(cfg: PlotConfig): boolean {
  return JSON.stringify(cfg) === JSON.stringify(DEFAULT_PLOT);
}

// ---------------------------------------------------------------------------
// Config sanitizers — coerce a partial/hostile PERSISTED blob to a valid config
// without throwing. No v1→v2→v3 migration chain: old persisted blobs are
// dropped (Tom confirmed nothing saved worth keeping); this only heals a blob
// of the CURRENT shape (missing keys defaulted, wrong-typed fields dropped).
// ---------------------------------------------------------------------------

function sanitizeDomain(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 &&
    typeof v[0] === "number" && Number.isFinite(v[0]) &&
    typeof v[1] === "number" && Number.isFinite(v[1])
    ? [v[0], v[1]]
    : null;
}

/** Coerce an unknown blob to a valid RangeFilter list (drops malformed entries). */
export function sanitizeRanges(raw: unknown): RangeFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: RangeFilter[] = [];
  for (const r of raw) {
    if (
      r && typeof r === "object" && !Array.isArray(r) &&
      typeof (r as RangeFilter).metric === "string" &&
      typeof (r as RangeFilter).min === "number" && Number.isFinite((r as RangeFilter).min) &&
      typeof (r as RangeFilter).max === "number" && Number.isFinite((r as RangeFilter).max)
    ) {
      const { metric, min, max } = r as RangeFilter;
      out.push({ metric, min, max });
    }
  }
  return out;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Coerce an unknown blob to a complete LayerStyle (missing/invalid fields take
 *  their neutral defaults) — this is what lets a persisted style blob AND a
 *  hand-edited spec both round-trip without dropping styling. */
export function sanitizeLayerStyle(raw: unknown): LayerStyle {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const shape = num(r.shape);
  const dash = num(r.dash);
  return {
    shape: shape === null ? 0 : Math.max(0, Math.round(shape)),
    dash: dash === null ? 0 : Math.max(0, Math.round(dash)),
  };
}

/** Coerce ONE layer entry (heal id/name/color/style/filters). `used` tracks ids
 *  across the WHOLE tree so members share the top-level id namespace (globally
 *  unique). When `allowMembers`, a `members` array is sanitized ONE level deep
 *  (each member is coerced with members STRIPPED — a member never has members);
 *  a layer that ends up with members is a GROUP, so its own filters are forced
 *  to the empty FilterState (the group's rows come from the members' union). */
function sanitizeLayerEntry(
  e: Record<string, unknown>,
  used: Set<string>,
  position: number,
  allowMembers: boolean,
): PlotLayer {
  const id = typeof e.id === "string" && e.id && !used.has(e.id) ? e.id : nextLayerId(used);
  used.add(id);
  const layer: PlotLayer = {
    id,
    name: typeof e.name === "string" && e.name ? e.name : id,
    color: typeof e.color === "string" && HEX_COLOR.test(e.color) ? e.color : paletteColor(position),
    style: sanitizeLayerStyle(e.style),
    filters: sanitizeFilters(e.filters),
  };
  if (allowMembers && Array.isArray(e.members)) {
    const members: PlotLayer[] = [];
    for (const m of e.members) {
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      // members never have members — pass allowMembers:false to strip nesting.
      members.push(sanitizeLayerEntry(m as Record<string, unknown>, used, members.length, false));
    }
    if (members.length) {
      layer.members = members;
      layer.filters = { facets: {}, ranges: [] }; // a group's own filters are unused
    }
  }
  return layer;
}

/** Coerce a layers blob: drop malformed entries; if none survive, install the
 *  default one; ensure unique ids (across groups + their members); coerce a
 *  missing/invalid color to a palette hex by position; heal a missing/partial
 *  style; sanitize a group's members one level deep. */
function sanitizeLayers(raw: unknown): PlotLayer[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PlotLayer[] = [];
  const used = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    out.push(sanitizeLayerEntry(entry as Record<string, unknown>, used, out.length, true));
  }
  if (out.length === 0) {
    out.push({
      id: "l1", name: "all runs", color: CATEGORY_PALETTE[0],
      style: { ...DEFAULT_LAYER_STYLE }, filters: { facets: {}, ranges: [] },
    });
  }
  return out;
}

/** Coerce a partial/hostile blob to a valid PlotConfig (see section comment).
 *  A blob of the OLD `settings`/`splitBy` shape is dropped ENTIRELY — every
 *  field, not just the unreadable ones — so it heals to the byte-for-byte
 *  pristine default and the first-load hydration installs the dominant-cell
 *  default (no migration). Key order matches DEFAULT_PLOT so
 *  isDefaultPlotConfig's JSON compare recognizes a healed pristine blob. */
export function sanitizePlotConfig(raw: unknown): PlotConfig {
  let r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if ("settings" in r || "splitBy" in r) r = {}; // pre-layers blob → full drop
  const d = DEFAULT_PLOT;
  const str = (v: unknown, f: string) => (typeof v === "string" ? v : f);
  const bool = (v: unknown, f: boolean) => (typeof v === "boolean" ? v : f);
  const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  return {
    layers: sanitizeLayers(r.layers),
    ranges: sanitizeRanges(r.ranges),
    colorBy: typeof r.colorBy === "string" ? r.colorBy : null,
    x: str(r.x, d.x),
    y: str(r.y, d.y),
    size: num(r.size, d.size),
    opacity: num(r.opacity, d.opacity),
    band: bool(r.band, d.band),
    ghosts: bool(r.ghosts, d.ghosts),
    trend: bool(r.trend, d.trend),
    logX: bool(r.logX, d.logX),
    logY: bool(r.logY, d.logY),
    xDomain: sanitizeDomain(r.xDomain),
    yDomain: sanitizeDomain(r.yDomain),
  };
}

/** Coerce an unknown blob to a valid GroupFacet (or null). The pre-bins
 *  STRING facet shape is dropped (no migration), as is anything malformed. */
export function sanitizeGroupFacet(raw: unknown): GroupFacet | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (f.kind === "layer") return { kind: "layer" };
  if (f.kind === "param" && typeof f.key === "string" && f.key) {
    return { kind: "param", key: f.key };
  }
  if (
    f.kind === "grid" &&
    typeof f.row === "string" && f.row &&
    typeof f.col === "string" && f.col &&
    f.row !== f.col // a parameter crossed with itself is a plain param facet
  ) {
    return { kind: "grid", row: f.row, col: f.col };
  }
  if (
    f.kind === "bins" &&
    typeof f.metric === "string" && f.metric &&
    typeof f.n === "number" && Number.isFinite(f.n) &&
    (f.mode === "quantile" || f.mode === "width")
  ) {
    return { kind: "bins", metric: f.metric, n: Math.max(2, Math.min(8, Math.round(f.n))), mode: f.mode };
  }
  return null;
}

/** Coerce a persisted Group Plot EXTRAS blob (facet + panelMin). Old fat
 *  group-plot blobs (a full config shape) carry a `facet` key but their other
 *  fields are ignored — only the extras survive. */
export function sanitizeGroupExtras(raw: unknown): GroupPlotExtras {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  return {
    facet: sanitizeGroupFacet(r.facet),
    panelMin: num(r.panelMin, DEFAULT_GROUP_EXTRAS.panelMin),
  };
}

/** Coerce a partial/hostile blob to a valid TableConfig. `fallbackCols` seeds
 *  visibleCols when the blob has none (the store's DEFAULT_COLS). */
export function sanitizeTableConfig(raw: unknown, fallbackCols: string[]): TableConfig {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const cols = Array.isArray(r.visibleCols)
    ? r.visibleCols.filter((c): c is string => typeof c === "string")
    : [];
  const widths: Record<string, number> = {};
  if (r.columnWidths && typeof r.columnWidths === "object" && !Array.isArray(r.columnWidths)) {
    for (const [k, v] of Object.entries(r.columnWidths as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) widths[k] = v;
    }
  }
  const sorts = Array.isArray(r.sorts)
    ? (r.sorts.filter(
        (s): s is SortKey =>
          !!s && typeof s === "object" &&
          typeof (s as SortKey).col === "string" &&
          ((s as SortKey).dir === "asc" || (s as SortKey).dir === "desc"),
      ))
    : [];
  return {
    filters: sanitizeFilters(r.filters),
    visibleCols: cols.length ? cols : fallbackCols,
    columnWidths: widths,
    sorts,
    search: typeof r.search === "string" ? r.search : "",
  };
}

// ---------------------------------------------------------------------------
// Anatomy config (store-owned for the same reason as ChartConfig: the
// share-URL encoder and the persisted-view blob both need to reach it;
// AnatomyBody renders from it)
// ---------------------------------------------------------------------------

export interface AnatomyConfig extends Record<string, unknown> {
  /** Accordion focus: unit path ("L17", "L17/attn/h9") → weight multiplier.
   * Empty = uniform layout (every layer weight 1). */
  focus: Record<string, number>;
  /** Show the function-false twin's contrast band when a twin exists. */
  twin: boolean;
  /** Selected measurement id (null = nothing selected). */
  sel: string | null;
}

export const DEFAULT_ANATOMY: AnatomyConfig = {
  focus: {},
  twin: true,
  sel: null,
};

// ---------------------------------------------------------------------------
// Raw-artifact browsing (/api/boolback/node + /api/boolback/file)
// ---------------------------------------------------------------------------

export interface NodeListing {
  path: string; // relative to the CMT output root, "" for the root
  dirs: string[];
  files: Array<{ name: string; size: number }>;
}

export interface FilePreview {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}
