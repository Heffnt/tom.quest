// app/boolback/lib/types.ts — PINNED CONTRACT. All components import from here.

export type Hash12 = string; // exactly 12 lowercase hex chars

export type NodeKind =
  | "function" | "dataset" | "training" | "inference" | "scoring"
  | "ppl" | "interp" | "model"
  | `defense_${"detector" | "mitigator" | "editor" | "sanitizer" | "decoder" | "reconstructor"}`
  | `scan_${"train" | "infer"}`;

export type GroupKind =
  | "backdoor" | "filler" | "test" | "scans" | "defenses" | "interp"
  | "lora" | "full" | "epoch" | "row";

export type Arity = 2 | 3 | 4 | 5;
export type RowDistribution = "uniform" | "balanced";
export type Split = "test" | "train";
export type MetricSuite = "spectral" | "structural" | "outcome";
export type MetricType = "fraction" | "count" | "bool";

// Cross-edge families rendered distinctly in the DAG.
export type CrossEdgeKind =
  | "function_false_twin" | "trigger_naive_twin"
  | "epoch0_trajectory" | "defended_pair" | "sanitize_pair";

export interface CrossEdge {
  kind: CrossEdgeKind;
  fromDir: string;   // dirName of source node
  toDir: string;     // dirName of partner node
  label?: string;    // e.g. "asr_drop +0.42" or "twin Δ +0.81"
}

// One artifact-tree node. buildFixtureTree() returns the root.
export interface TreeNode {
  dirName: string;                 // full "<level>+<slug>+<hash12>" or group dir name (e.g. "epoch-2", "defenses") — DISPLAY ONLY (on-disk dir name; NOT unique across the content-addressed tree)
  path: string;                    // globally-unique IDENTITY: the chain of ancestor dirNames root->this node joined by "/" (every selection / expansion / index / React key keys off this, NOT dirName)
  kind: NodeKind | "group";
  groupKind: GroupKind | null;     // set iff kind==="group"
  level: NodeKind | null;          // null for group dirs (no '+')
  slug: string | null;             // null for group dirs
  hash: Hash12 | null;             // null for group dirs and epoch-N
  config: Record<string, unknown> | null; // config.json contents; null for group dirs
  elidedKeys: string[];            // config keys dropped before hashing (e.g. ["derivation"]); annotated in drawer
  done: boolean;                   // done.json present
  claimed: boolean;                // .lock/.running present (in-progress)
  inChain: boolean;                // function|dataset|training|inference|scoring
  projected: boolean;              // contributes tidy columns
  children: TreeNode[];
  // side-branch / twin extras (optional):
  contract?: string;
  evalFamily?: "terminal" | "standalone" | "runtime";
  surface?: "train" | "infer";
  referenceHash?: Hash12;          // twin cross-edge target hash
  crossEdges?: CrossEdge[];        // outgoing logical cross-edges from this node
}

// Per-experiment cut row (every *.seed dropped). One row per config chain.
export interface ExperimentRow {
  rowId: string;                   // stable key = scoringHash (post-seed-drop)
  // identity / chain hashes
  functionHash: Hash12; datasetHash: Hash12; trainingHash: Hash12;
  inferenceHash: Hash12; scoringHash: Hash12;
  pairKey: Hash12;
  scoringDir: string;              // PATH KEY of the scoring node this row maps to (= the scoring node's `path`; for selection). NOT a bare dirName.
  chainDirs: string[];             // ANCESTOR PATH KEYS root->scoring (each ancestor's cumulative `path`, root->node) for tree reveal / DAG spine. The last entry === scoringDir.
  // friendly categorical axes (facet-filterable / sortable)
  task: string; source: string; targetBehavior: string; targetPhrase: string;
  triggerForm: string; rowDistribution: RowDistribution;
  baseModel: string; tuning: string; judge: string; split: Split;
  arity: Arity; truthTable: string;
  // outcomes (cross-seed aggregated mean); seedN = number of seeds aggregated
  asr: number; ftr: number; triggerlessCorrectness: number;
  stealthRate: number; ppl: number; pplDrift: number;
  planted: boolean; plantedEpoch: number | null;
  seedN: number;
  // status flags
  inProgress: boolean;             // any epoch lacks done.json or holds a lock
  hasDefense: boolean; hasTwin: boolean; hasScan: boolean; hasInterp: boolean;
  hasNegativeDrop: boolean; heuristicProvenance: boolean;
  // defense efficacy rollup (null when none)
  bestDetectorAuroc: number | null;
  maxAsrDrop: number | null;       // signed; negative shown text-error
  // full ~61-metric complexity vector (key = metric_name from METRIC_META)
  metrics: Record<string, number | boolean>;
}

// Long-form tidy row: one per measured value. Projection source for experiment rows.
export interface TidyRow {
  functionHash: Hash12; datasetHash: Hash12; trainingHash: Hash12;
  epoch: number | "-"; inferenceHash: Hash12 | "-"; scoringHash: Hash12 | "-";
  defenseHash?: Hash12; interpHash?: Hash12; pplHash?: Hash12; scanHash?: Hash12;
  ttRow: string | "-"; layer: string | "-";
  metricName: string; value: number | boolean;
  kind: "defense" | "interp" | "scan" | "ppl" | "-";
  scheme?: "presence" | "activation" | "non_activating" | "-";
  negativeFacet?: "same_source" | "filler" | "-";
  corpus?: string | "-"; referenceHash?: Hash12 | "-";
  seed: string;                    // composite "ds/tr/inf"
  // friendly short-names + raw dotted columns flattened on:
  task?: string; source?: string; targetBehavior?: string; triggerForm?: string;
  judge?: string; baseModel?: string; split?: Split; rowDistribution?: RowDistribution;
  [rawDottedColumn: string]: unknown;
}

export interface MetricMeta {
  name: string;            // matches ExperimentRow.metrics key
  label: string;
  suite: MetricSuite;
  type: MetricType;
  min: number;             // known range floor (from data model)
  max: number;             // known range ceiling
  format: "pct" | "int" | "float2" | "bool";
}

// ---- store-facing UI state types ----
export type ViewTab = "dag" | "table";
export type SortDir = "asc" | "desc";
export interface SortKey { col: string; dir: SortDir; }           // col = ExperimentRow column or metric name
export type RangeFilter = { metric: string; min: number; max: number; };
export type FacetKey =
  | "task" | "source" | "targetBehavior" | "triggerForm" | "rowDistribution"
  | "baseModel" | "tuning" | "judge" | "split" | "arity";
export type StatusFlag =
  | "plantedOnly" | "neverPlanted" | "inProgress" | "hasDefense"
  | "hasTwin" | "hasNegativeDrop" | "heuristicProvenance";

export interface FilterState {
  facets: Partial<Record<FacetKey, string[]>>; // empty/absent => all
  ranges: RangeFilter[];                        // AND-composed
  status: StatusFlag[];                         // AND-composed
  text: string;                                 // substring over truthTable/slug/hash/friendly
  scopeDir: string | null;                      // tree-driven subtree scope; reversible "scope ×" chip
}

export const EMPTY_FILTER: FilterState = { facets: {}, ranges: [], status: [], text: "", scopeDir: null };