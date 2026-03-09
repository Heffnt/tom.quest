export type BoolbackTab =
  | "pipeline"
  | "progress"
  | "results"
  | "validate"
  | "dataset-review"
  | "experiment-review";

export interface PipelineNode {
  id: string;
  label: string;
  count: number;
  color?: string;
  type?: string;
}

export interface PipelineEdge {
  from: string;
  to: string;
  label?: string;
  operation?: string;
  step_id?: string;
  model?: string;
  models?: string[] | string;
  refusal_model?: string;
  compliance_model?: string;
}

export interface PipelineOverview {
  train_ratio?: number;
  augment_model?: string;
  filter_models?: string[] | string;
  similarity_model?: string;
  refusal_model?: string;
  compliance_model?: string;
  verify_model?: string;
  seed_count?: number;
  base_train_count?: number;
  base_test_count?: number;
}

export interface PipelineResponse {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  overview: PipelineOverview;
}

export interface StageTextSample {
  index: number;
  text: string;
}

export interface StageStructuredSample {
  index: number;
  input: string;
  compliance: string;
  refusal: string;
}

export type StageSample = StageTextSample | StageStructuredSample;

export interface StageResponse {
  samples: StageSample[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasText: boolean;
}

export interface LlmResponse {
  summary: Record<string, unknown>;
  samples: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface EdgeDiffResponse {
  added: Array<{ text: string }>;
  removed: Array<{ text: string }>;
  addedTotal: number;
  removedTotal: number;
}

export interface ValidationSample {
  index: number;
  input: string;
  compliance: string;
  refusal: string;
}

export interface ValidationQueueResponse {
  samples: ValidationSample[];
  total: number;
  reviewed: number;
  remaining: number;
}

export interface ValidationStatsDataset {
  total: number;
  reviewed: number;
  good: number;
  bad: number;
}

export interface ValidationStatsResponse {
  overall: ValidationStatsDataset;
  train: ValidationStatsDataset;
  test: ValidationStatsDataset;
}

export interface ValidationReviewRow {
  dataset: "train" | "test";
  sample_index: number;
  result: "good" | "bad";
  notes: string;
  reviewed_at: string;
  input: string;
  compliance: string;
  refusal: string;
}

export interface ValidationReviewResponse {
  samples: ValidationReviewRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type ProgressStatus =
  | "converged"
  | "done"
  | "training"
  | "inferring"
  | "pending_infer"
  | "pending_train"
  | "no_data";

export interface ProgressDefaults {
  sweep_config: string[];
  expressions_file: string[];
}

export interface ProgressResolved {
  project_root: string;
  batch_path: string;
  sweep_config: string[];
  expressions_file: string[];
}

export interface ProgressSummary {
  total: number;
  converged: number;
  done: number;
  training: number;
  inferring: number;
  pending_infer: number;
  pending_train: number;
  no_data: number;
  percent_complete: number;
}

export interface ProgressPathInfo {
  data_dir: string;
  experiment_dir: string;
  results_dir: string;
}

export interface ProgressPartSummary {
  completed: number;
  total: number;
}

export interface EpochState {
  epoch: number;
  has_lora: boolean;
  has_score: boolean;
  asr_backdoor: number | null;
  asr_nonbackdoor: number | null;
}

export interface ScoredEpoch {
  epoch: number;
  asr_backdoor: number | null;
  asr_nonbackdoor: number | null;
}

export interface ConvergenceInfo {
  is_converged: boolean;
  asr_threshold: number;
  n_consec_required: number;
  consec_streak: number;
  info: Record<string, unknown> | null;
}

export interface ActiveClaim {
  experiment_dir_name: string;
  expression_preview: string;
  model: string;
  claim_type: "training" | "inference";
  epoch_label: string;
  hostname: string | null;
  pid: number | null;
  timestamp: number | null;
}

export interface DefenseDetail {
  name: string;
  done: boolean;
}

export interface ConfigGroup {
  index: number;
  label: string;
  total: number;
  status_counts: Record<string, number>;
  defense_done: number;
  defense_total: number;
  is_complete: boolean;
  is_active: boolean;
  percent_complete: number;
}

export interface ProgressRow {
  index: number;
  status: ProgressStatus;
  expression: string;
  expression_preview: string;
  truth_table_id: string;
  model: string;
  experiment_dir_name: string;
  max_epoch: number;
  max_scored_epoch: number;
  paths: ProgressPathInfo;
  epoch_states: EpochState[];
  scored_epochs: ScoredEpoch[];
  convergence: ConvergenceInfo;
  defense_progress: ProgressPartSummary;
  defense_detail: DefenseDetail[];
  defense_epoch: number;
  config_group_index: number;
  key_config: Record<string, unknown>;
  varying_args: Record<string, unknown>;
}

export interface ProgressResponse {
  defaults: ProgressDefaults;
  resolved: ProgressResolved;
  summary: ProgressSummary;
  config_groups: ConfigGroup[];
  varying_arg_keys: string[];
  active_claims: ActiveClaim[];
  rows: ProgressRow[];
}

export interface ResultsDataResponse {
  columns: string[];
  column_groups: Record<string, string[]>;
  rows: Array<Record<string, unknown> & { _variant_activation?: Record<string, boolean> }>;
  total: number;
  mtime: number | null;
}
