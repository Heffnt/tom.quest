export interface NodeInfo {
  name: string;
  gpu_type: string;
  partition: string;
  total_gpus: number;
  allocated_gpus: number;
  state: "up" | "down" | "drain";
  memory_total_mb: number;
  memory_allocated_mb: number;
}

export interface GPUTypeInfo {
  type: string;
  count: number;
  nodes: string[];
}

export interface GPUReport {
  nodes: NodeInfo[];
  summary: {
    available: GPUTypeInfo[];
    unavailable: GPUTypeInfo[];
    free: GPUTypeInfo[];
  };
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
}

export interface AllocateRequest {
  gpu_type: string;
  time_mins: number;
  memory_mb: number;
  count: number;
  commands: string[];
  project_dir: string;
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
