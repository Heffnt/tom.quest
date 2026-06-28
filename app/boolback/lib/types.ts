// app/boolback/lib/types.ts — PINNED CONTRACT. All components import from here.
//
// These types mirror the CMT tom_quest builder output EXACTLY (build.py /
// reshape.py / schema.py). Where the redesign plan §2 prose disagrees with the
// emitted JSON, the JSON wins: NO meta.axes, NO stealth anywhere, DEFENSE =
// asr_drop+recovery_rate, twins is FLAT, per_tt_row has no `n`, chain_dirs has
// exactly 3 entries (fn -> training). Verified against data/sample-snapshot.json.

// ---------------------------------------------------------------------------
// Snapshot envelope (build.py)
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

export interface Bundle {
  schema_version: number; // === 1; loader fails loud otherwise
  meta: Meta;
  metric_schema: MetricSchemaEntry[];
  column_groups: ColumnGroup[];
  friendly: Friendly;
  tree: TreeNode[]; // ARRAY of root function nodes
  rows: RunRow[];
}

export interface Meta {
  source_dir: string;
  built_at: string; // "YYYY-MM-DDThh:mm:ssZ"
  tree_mtime_key: number; // newest done.json mtime (0 if none)
  arity_max: number;
  row_count: number;
  tree_node_count: number;
}

// ---------------------------------------------------------------------------
// Metric schema (schema.py)
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
// Tree (reshape._tree_node) — function -> dataset -> training leaves only
// ---------------------------------------------------------------------------

export type TreeLevel = "function" | "dataset" | "training";

export interface TreeNode {
  path: string; // globally-unique cumulative: "fn=H" | "fn=H/ds=H" | "fn=H/ds=H/tr=H"
  dirName: string; // on-disk "function+slug+hash" etc. (NOT unique)
  level: TreeLevel;
  slug: string; // parts[1] (may be "")
  hash: string;
  kind: TreeLevel; // === level
  done: boolean;
  run_ids: string[]; // NODE_KEY run_ids (tr-paths) under this subtree
  children: TreeNode[];
}

// ---------------------------------------------------------------------------
// RunRow (reshape._build_run_row) — one row per training run (NODE_KEY)
// ---------------------------------------------------------------------------

export interface RunRow {
  identity: Identity;
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
  run_id: string;
  function_hash: string;
  dataset_hash: string;
  training_hash: string;
  node_path: string;
  chain_dirs: string[]; // [fn=H, fn=H/ds=H, fn=H/ds=H/tr=H]
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
  complexity: Record<string, number | null>; // 61 keys; some null if scipy missing
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

export interface Interp {
  measurement_kind: string | null;
  value: number | null;
  null_control: number | null;
  reference_model_diff: number | null;
}

export interface Scan {
  auroc: number | null;
  far_at_frr: number | null;
  method_family: unknown;
  scheme: unknown;
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
// UI state types (store-facing)
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
  // tree expansion. Replaces the old single scopeDir special-case.
  subtreeDirs: string[];
}

export const EMPTY_FILTER: FilterState = {
  facets: {},
  ranges: [],
  status: [],
  subtreeDirs: [],
};
