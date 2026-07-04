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
//     root (v2 only; null on v1 blobs — the raw-artifact browser hides itself).

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
  info_tier?: unknown;
  contract?: unknown;
  demands?: unknown;
}

export interface Defense {
  asr_drop: number | null;
  recovery_rate: number | null;
  methods: DefenseMethod[];
}

export interface InterpMeasurement {
  kind: string;
  value: number | null;
  null_control: number | null;
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
  | "baseModel"
  | "tuning"
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
// Chart config (store-owned so the table's per-header "plot on X/Y" and the
// share-URL encoder can reach it; ChartBody renders from it)
// ---------------------------------------------------------------------------

export interface ChartConfig extends Record<string, unknown> {
  x: string; // metric_schema name
  y: string; // metric_schema name
  color: FacetKey | "none";
  /** runs = scatter; functions = mean per function; means = mean y per (x, color) group. */
  mode: "runs" | "functions" | "means";
  logX: boolean;
  logY: boolean;
  trend: boolean; // OLS line + r/ρ readout
}

export const DEFAULT_CHART: ChartConfig = {
  x: "avg_sensitivity",
  y: "plantedness",
  color: "arity",
  mode: "runs",
  logX: false,
  logY: false,
  trend: false,
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
