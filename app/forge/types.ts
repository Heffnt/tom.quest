// Frozen contract shapes (forge_contracts.md §1, §2, §4) the forge client
// produces and reads. Kept narrow to the fields the UI needs.

export type ForgeConfig = {
  name?: string;
  function: { expression: string };
  dataset: {
    task: string;
    source: string;
    target_behavior: { name: string } & Record<string, unknown>;
    trigger_form: { name: string; trigger_set: string; position: string };
    poison_strategy: {
      rows: string;
      samples_per_row: number;
      test_per_row: number;
      backdoor_ratio: number;
      row_distribution: string;
    };
    seed: number;
  };
  training: {
    base_model: string;
    tuning: { name: string; r?: number; alpha?: number };
    lr: number;
    epochs: number;
    seed: number;
  };
};

export type ForgeResult = {
  schema_version: number;
  status: "completed" | "failed";
  config: ForgeConfig;
  sweep_yaml_path?: string;
  base_model: string;
  tuning: string;
  is_adapter: boolean;
  adapter_path: string | null;
  model_dir: string | null;
  epoch: number;
  score: { asr: number; ftr: number } | null;
  error: string | null;
};

// POST /forge/train response.
export type TrainResponse = {
  success: boolean;
  run_id: string;
  job_id: string;
  run_dir: string;
  result_path: string;
};

// GET /forge/train/{run_id} response.
export type TrainStatus = {
  run_id: string;
  status: "pending" | "running" | "completed" | "failed";
  result: ForgeResult | null;
  job: { job_id: string; state: string; time_remaining?: string } | null;
};

// POST /forge/serve and GET /forge/serve/{run_id}.
export type ServeStartResponse = {
  success: boolean;
  session: string;
  job_id: string;
  base_url: string;
  ready: boolean;
};

export type ServeStatus = {
  status: "starting" | "ready" | "stopped";
  base_url: string;
  job_id: string;
};

export type ChatResponse = {
  message: { role: "assistant"; content: string };
  usage: Record<string, unknown> | null;
};
