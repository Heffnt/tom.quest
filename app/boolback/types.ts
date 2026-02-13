export type BoolbackTab = "pipeline" | "results" | "validate" | "review";

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
