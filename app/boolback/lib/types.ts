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
//     (n_layers/n_heads/d_mlp) and the InterpMeasurement locus/taxonomy/
//     circuit fields are ADDITIVE and OPTIONAL — v1 blobs, older v2 blobs,
//     and the browser-cached last-good blob all predate them, so every
//     consumer must tolerate their absence. normalize passes them through
//     verbatim (measurements are never rewritten).

// ---------------------------------------------------------------------------
// Snapshot envelope (tom_quest/build.py, normalized)
// ---------------------------------------------------------------------------

export const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

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

export type MetricSuite = "structural" | "spectral" | "outcome";
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
  source: string | null;
  task: string | null;
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
  /** Note on a registry-less relic slug (pre-reclassification defenses). */
  legacy?: string;
}

export interface Defense {
  asr_drop: number | null;
  recovery_rate: number | null;
  methods: DefenseMethod[];
}

// ---------------------------------------------------------------------------
// Interp measurements — the Anatomy view's data source. The builder has always
// shipped {kind, value, null_control}; everything else below is ADDITIVE
// (2026-07, Anatomy view) and OPTIONAL, because v1 blobs, older v2 blobs and
// the browser-cached last-good blob predate the fields. normalize passes
// measurements through verbatim (observedMethodExtents only READS
// kind/value/null_control), so these are type declarations, not code.
// ---------------------------------------------------------------------------

/** Which stream/site a measurement (or circuit node) reads or writes. */
export type LocusComponent = "resid" | "attn" | "mlp" | "embed" | "unembed";

/** Spatial extent of the locus — drives the marker/arc representation. */
export type LocusShape = "point" | "head" | "subgraph" | "path" | "parameter" | "global";

/** Read-out-of vs. write-into the stream (circle vs. diamond marker). */
export type InterpMode = "observational" | "interventional";

/** One node of a circuit measurement (locus_shape "subgraph" | "path"). */
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

export interface InterpMeasurement {
  kind: string;
  value: number | null;
  null_control: number | null;
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
   * measurement with the twin run's for the contrast band / diff strip. */
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
  measurement_kind: string | null;
  value: number | null;
  null_control: number | null;
  reference_model_diff: number | null;
  /** ALL measurement kinds on the run (newer builders; headline fields keep one). */
  measurements?: InterpMeasurement[];
}

export interface ScanMethod {
  method: string;
  scheme?: unknown;
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

export type FacetKey =
  | "task"
  | "source"
  | "targetBehavior"
  | "triggerForm"
  | "rowDistribution"
  | "scheme"
  | "targetPhrase"
  | "samplesPerRow"
  | "backdoorRatio"
  | "baseModel"
  | "tuning"
  | "backend"
  | "lr"
  | "epochs"
  | "seed"
  | "judge"
  | "split"
  | "arity";

export type StatusFlag =
  | "plantedOnly"
  | "neverPlanted"
  | "inProgress"
  | "hasDefense"
  | "hasTwin"
  | "hasScan"
  | "hasInterp"
  | "hasNegativeDrop";

export interface FilterState {
  facets: Partial<Record<FacetKey, string[]>>; // empty/absent => all
  ranges: RangeFilter[]; // AND-composed
  status: StatusFlag[]; // AND-composed
  // tree-driven subtree chips: a run is kept iff its chain_dirs intersect ANY
  // chip node_path (OR-composed). Reversible "× dir" chips, independent of
  // tree expansion.
  subtreeDirs: string[];
  // quick-search: whitespace-separated tokens, ALL must match the row's
  // haystack (run id, fn hex, DNF, dir path, facet values).
  search: string;
}

export const EMPTY_FILTER: FilterState = {
  facets: {},
  ranges: [],
  status: [],
  subtreeDirs: [],
  search: "",
};

// ---------------------------------------------------------------------------
// Chart config, v2 (store-owned so the table's per-header "plot on X/Y" and the
// share-URL encoder can reach it; the Plot view renders from it).
//
// The user's per-dimension question is split / averaged / filtered — NOT "which
// visual slot". `splits` is the ORDERED list of dimensions the user chose to
// separate; everything differing but not in `splits` is averaged (with visible
// spread). Styling is auto-assigned from split order but overridable at every
// layer (channel reassignment, split reorder, per-value styles).
// ---------------------------------------------------------------------------

/** A visual encoding channel a split dimension can drive. `dash` (line-style)
 * is meaningful only for line/trajectory (epoch-x) rendering. */
export type Channel = "color" | "shape" | "size" | "dash";

/** Explicit per-value style override (a legend swatch edit). Size is never
 * per-value overridable (it reads ordinally). */
export interface ValueStyle {
  color?: string; // custom hex or palette entry
  shape?: number; // glyph index
  dash?: number;  // dash-pattern index
}

export interface ChartConfig extends Record<string, unknown> {
  v: 2;
  x: string; // metric_schema name, or the sentinel "epoch" (training progress)
  y: string; // metric_schema name
  /** ORDERED dimension keys the user chose to split; [] = everything averaged. */
  splits: string[];
  /** Per-split-dim channel OVERRIDE; absent = auto by split order. */
  channels: Record<string, Channel>;
  /** dimKey → raw value → explicit style override. */
  valueStyles: Record<string, Record<string, ValueStyle>>;
  band: boolean;   // ±SD band / whiskers
  ghosts: boolean; // faint underlying runs
  logX: boolean;
  logY: boolean;
  trend: boolean;  // OLS line + r/ρ readout
  /** VIEW WINDOW only (zoom) — never filters the data. */
  xDomain: [number, number] | null;
  yDomain: [number, number] | null;
  /** Group Plot's extra facet dimension (null on the Plot tab). */
  facetDim: string | null;
  /** Group Plot panel size (px), user-adjustable. */
  panelMin: number;
}

export const DEFAULT_CHART: ChartConfig = {
  v: 2,
  x: "avg_sensitivity",
  y: "plantedness",
  splits: [],
  channels: {},
  valueStyles: {},
  band: true,
  ghosts: true,
  logX: false,
  logY: false,
  trend: false,
  xDomain: null,
  yDomain: null,
  facetDim: null,
  panelMin: 280,
};

// -- v1 (pre-2026-07 chart config) — retained ONLY as migration input --------

/** v1 per-dimension treatment (biggest-split-first auto assignment). */
export type DimTreatment = "color" | "shape" | "size" | "avg";

export interface ChartConfigV1 {
  x: string;
  y: string;
  dims: Record<string, DimTreatment>;
  logX: boolean;
  logY: boolean;
  trend: boolean;
}

function isChannel(v: unknown): v is Channel {
  return v === "color" || v === "shape" || v === "size" || v === "dash";
}

function sanitizeValueStyles(raw: unknown): ChartConfig["valueStyles"] {
  const out: ChartConfig["valueStyles"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [dim, vals] of Object.entries(raw as Record<string, unknown>)) {
    if (!vals || typeof vals !== "object") continue;
    const inner: Record<string, ValueStyle> = {};
    for (const [val, style] of Object.entries(vals as Record<string, unknown>)) {
      if (!style || typeof style !== "object") continue;
      const s = style as Record<string, unknown>;
      const vs: ValueStyle = {};
      if (typeof s.color === "string") vs.color = s.color;
      if (typeof s.shape === "number") vs.shape = s.shape;
      if (typeof s.dash === "number") vs.dash = s.dash;
      if (Object.keys(vs).length) inner[val] = vs;
    }
    if (Object.keys(inner).length) out[dim] = inner;
  }
  return out;
}

function sanitizeDomain(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 &&
    typeof v[0] === "number" && Number.isFinite(v[0]) &&
    typeof v[1] === "number" && Number.isFinite(v[1])
    ? [v[0], v[1]]
    : null;
}

/** Coerce a (possibly partial/hostile) v2 blob to a valid ChartConfig: unknown
 *  keys ignored, missing keys defaulted, wrong-typed fields dropped. Shared by
 *  share-URL decode and preset hydration — must never throw. */
function sanitizeChartV2(raw: Record<string, unknown>): ChartConfig {
  const d = DEFAULT_CHART;
  const str = (v: unknown, f: string) => (typeof v === "string" ? v : f);
  const bool = (v: unknown, f: boolean) => (typeof v === "boolean" ? v : f);
  const num = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? v : f);
  const channels: Record<string, Channel> = {};
  if (raw.channels && typeof raw.channels === "object") {
    for (const [k, v] of Object.entries(raw.channels as Record<string, unknown>)) {
      if (isChannel(v)) channels[k] = v;
    }
  }
  return {
    v: 2,
    x: str(raw.x, d.x),
    y: str(raw.y, d.y),
    splits: Array.isArray(raw.splits) ? raw.splits.filter((s): s is string => typeof s === "string") : [],
    channels,
    valueStyles: sanitizeValueStyles(raw.valueStyles),
    band: bool(raw.band, d.band),
    ghosts: bool(raw.ghosts, d.ghosts),
    logX: bool(raw.logX, d.logX),
    logY: bool(raw.logY, d.logY),
    trend: bool(raw.trend, d.trend),
    xDomain: sanitizeDomain(raw.xDomain),
    yDomain: sanitizeDomain(raw.yDomain),
    facetDim: typeof raw.facetDim === "string" ? raw.facetDim : null,
    panelMin: num(raw.panelMin, d.panelMin),
  };
}

/**
 * Migrate any persisted/shared/preset chart blob to a valid v2 ChartConfig.
 * Total (never throws): garbage → defaults; a v1 blob's color/shape/size dims
 * become ORDERED `splits` + `channels` (avg entries dropped — averaged is now
 * the default); a v2 blob is sanitized.
 */
export function migrateChart(input: unknown): ChartConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULT_CHART };
  const raw = input as Record<string, unknown>;
  if (raw.v === 2) return sanitizeChartV2(raw);
  // v1 → v2
  const out: ChartConfig = { ...DEFAULT_CHART };
  if (typeof raw.x === "string") out.x = raw.x;
  if (typeof raw.y === "string") out.y = raw.y;
  if (typeof raw.logX === "boolean") out.logX = raw.logX;
  if (typeof raw.logY === "boolean") out.logY = raw.logY;
  if (typeof raw.trend === "boolean") out.trend = raw.trend;
  if (raw.dims && typeof raw.dims === "object") {
    const byChannel = new Map<Channel, string>();
    for (const [key, t] of Object.entries(raw.dims as Record<string, unknown>)) {
      if ((t === "color" || t === "shape" || t === "size") && !byChannel.has(t)) {
        byChannel.set(t, key);
      }
    }
    const splits: string[] = [];
    const channels: Record<string, Channel> = {};
    for (const ch of ["color", "shape", "size"] as const) {
      const key = byChannel.get(ch);
      if (key) { splits.push(key); channels[key] = ch; }
    }
    out.splits = splits;
    out.channels = channels;
  }
  return out;
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
