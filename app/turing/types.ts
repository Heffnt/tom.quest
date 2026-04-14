export interface NodeInfo {
  name: string;
  gpu_type: string;
  partition: string;
  total_gpus: number;
  allocated_gpus: number;
  state: string;
  memory_total_mb: number;
  memory_allocated_mb: number;
}

export interface GPUTypeInfo {
  type: string;
  count: number;
  nodes: string[];
}

export interface NodeGpuJob {
  job_id: string;
  user: string;
  gpu_index: number;
  time_elapsed: string;
  time_limit: string;
  progress_pct: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  temperature_c: number | null;
  utilization_pct: number | null;
  active: boolean;
}

export interface GPUReport {
  nodes: NodeInfo[];
  summary: {
    available: GPUTypeInfo[];
    unavailable: GPUTypeInfo[];
    free: GPUTypeInfo[];
  };
  gpu_jobs_by_node: Record<string, Array<NodeGpuJob | null>>;
}

export interface JobGpuStats {
  memory_used_mb: number;
  memory_total_mb: number;
  temperature_c: number | null;
  utilization_pct: number | null;
}

export interface Job {
  job_id: string;
  gpu_type: string;
  status: string;
  time_remaining: string;
  time_remaining_seconds: number;
  screen_name: string;
  start_time: string;
  end_time: string;
  gpu_stats: JobGpuStats | null;
}

export interface AllocateRequest {
  gpu_type: string;
  time_mins: number;
  memory_mb: number;
  count: number;
  commands: string[];
  project_dir: string;
  job_name: string;
}

export interface AllocateResponse {
  success: boolean;
  job_ids: string[];
  screen_names: string[];
  errors: string[];
}

export const GPU_TYPE_LABELS: Record<string, string> = {
  nvidia: "H100",
  tesla: "V100",
};

export function gpuTypeLabel(type: string): string {
  const suffix = GPU_TYPE_LABELS[type];
  return suffix ? `${type} (${suffix})` : type;
}
