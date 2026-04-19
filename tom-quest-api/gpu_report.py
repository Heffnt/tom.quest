import logging
import re
import shlex
import threading
import time
from dataclasses import dataclass, field

from shell import run, run_stdout

UNAVAILABLE_STATE_TOKENS = {
    "DOWN",
    "DRAIN",
    "DRAINED",
    "DRAINING",
    "FAIL",
    "FAILING",
    "NOT_RESPONDING",
    "PLANNED",
    "RESERVED",
}
GPU_INDEX_PATTERN = re.compile(r"IDX:([^)]+)")
NODE_SECTION_PATTERN = re.compile(r"Nodes=(\S+)(.*?)(?=Nodes=\S+|$)")
GPU_COUNT_PATTERN = re.compile(r"gpu(?::[^:,\s()]+)?:(\d+)", re.IGNORECASE)
GPU_ACTIVITY_TTL_SECONDS = 10
NVIDIA_SMI_QUERY_ARGS = (
    "--query-gpu=index,memory.used,memory.total,temperature.gpu,"
    "utilization.gpu --format=csv,noheader,nounits"
)
NVIDIA_SMI_QUERY = (
    f"nvidia-smi {NVIDIA_SMI_QUERY_ARGS}"
)
JOB_GPU_STATS_TIMEOUT_SECONDS = 8
_GPU_ACTIVITY_CACHE_LOCK = threading.Lock()
_GPU_ACTIVITY_CACHE: dict[str, object] = {
    "expires_at": 0.0,
    "value": None,
}
logger = logging.getLogger("tom.quest.gpu_report")


@dataclass
class GPUTypeInfo:
    count: int = 0
    nodes: list[str] = field(default_factory=list)


@dataclass
class NodeInfo:
    name: str
    gpu_type: str
    partition: str
    total_gpus: int
    allocated_gpus: int
    state: str
    memory_total_mb: int
    memory_allocated_mb: int


def _state_tokens(state: str) -> set[str]:
    cleaned = state.upper().replace("*", "")
    return {part for part in cleaned.split("+") if part}


def _is_unavailable_state(state: str) -> bool:
    tokens = _state_tokens(state)
    return any(token in UNAVAILABLE_STATE_TOKENS for token in tokens)


def _is_shared_gpu_node(node: NodeInfo) -> bool:
    return node.name.lower().startswith("gpu") and "academic" not in node.partition.lower()


def get_all_nodes() -> list[str]:
    output = run_stdout("sinfo -N -o '%N'")
    nodes = []
    for line in output.strip().split("\n"):
        node = line.strip()
        if node and node != "NODELIST":
            nodes.append(node)
    return sorted(set(nodes))


def get_node_info(node: str) -> str:
    return run_stdout(f"scontrol show node {shlex.quote(node)}")


def parse_memory(tres_str: str) -> int:
    mem_match = re.search(r"mem=(\d+)([KMGT]?)", tres_str)
    if not mem_match:
        return 0
    value = int(mem_match.group(1))
    unit = mem_match.group(2)
    if unit == "K":
        return value // 1024
    if unit == "G":
        return value * 1024
    if unit == "T":
        return value * 1024 * 1024
    return value


def parse_gpu_nodes() -> list[NodeInfo]:
    nodes = []
    for node_name in get_all_nodes():
        node_info_str = get_node_info(node_name)
        partition_match = re.search(r"Partitions=(\S+)", node_info_str)
        partition = partition_match.group(1) if partition_match else "unknown"
        state_match = re.search(r"\bState=(\S+)", node_info_str)
        state = state_match.group(1) if state_match else "UNKNOWN"
        gres_match = re.search(r"Gres=gpu:([^:,\s]+):(\d+)", node_info_str)
        if not gres_match:
            continue
        gpu_type = gres_match.group(1)
        total_gpus = int(gres_match.group(2))
        allocated_gpus = 0
        alloc_match = re.search(r"AllocTRES=.*?gres/gpu=(\d+)", node_info_str)
        if alloc_match:
            allocated_gpus = int(alloc_match.group(1))
        cfg_tres_match = re.search(r"CfgTRES=([^\n]+)", node_info_str)
        alloc_tres_match = re.search(r"AllocTRES=([^\n]+)", node_info_str)
        memory_total_mb = parse_memory(cfg_tres_match.group(1)) if cfg_tres_match else 0
        memory_allocated_mb = parse_memory(alloc_tres_match.group(1)) if alloc_tres_match else 0
        nodes.append(
            NodeInfo(
                name=node_name,
                gpu_type=gpu_type,
                partition=partition,
                total_gpus=total_gpus,
                allocated_gpus=allocated_gpus,
                state=state,
                memory_total_mb=memory_total_mb,
                memory_allocated_mb=memory_allocated_mb,
            )
        )
    return nodes


def _format_type_info(info: dict[str, GPUTypeInfo]) -> list[dict]:
    return [{"type": gpu_type, "count": data.count, "nodes": data.nodes} for gpu_type, data in info.items()]


def compute_summary(nodes: list[NodeInfo], shared_only: bool = True) -> dict:
    available: dict[str, GPUTypeInfo] = {}
    unavailable: dict[str, GPUTypeInfo] = {}
    free: dict[str, GPUTypeInfo] = {}
    for node in nodes:
        if shared_only and not _is_shared_gpu_node(node):
            continue
        target = unavailable if _is_unavailable_state(node.state) else available
        if node.gpu_type not in target:
            target[node.gpu_type] = GPUTypeInfo()
        target[node.gpu_type].count += node.total_gpus
        target[node.gpu_type].nodes.append(f"{node.name}({node.total_gpus})")
        if target is unavailable:
            continue
        free_gpus = max(node.total_gpus - node.allocated_gpus, 0)
        if free_gpus > 0:
            if node.gpu_type not in free:
                free[node.gpu_type] = GPUTypeInfo()
            free[node.gpu_type].count += free_gpus
            free[node.gpu_type].nodes.append(f"{node.name}({free_gpus})")
    return {
        "available": _format_type_info(available),
        "unavailable": _format_type_info(unavailable),
        "free": _format_type_info(free),
    }


def _parse_time_to_seconds(time_str: str) -> int:
    time_str = time_str.strip()
    if not time_str or time_str in ("INVALID", "N/A", "NOT_SET", "UNLIMITED"):
        return 0
    total_seconds = 0
    if "-" in time_str:
        days_part, time_part = time_str.split("-", 1)
        total_seconds += int(days_part) * 86400
        time_str = time_part
    parts = time_str.split(":")
    if len(parts) == 3:
        total_seconds += int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    elif len(parts) == 2:
        total_seconds += int(parts[0]) * 60 + int(parts[1])
    elif len(parts) == 1:
        total_seconds += int(parts[0])
    return total_seconds


def _parse_index_list(index_text: str) -> list[int]:
    values: list[int] = []
    cleaned = index_text.strip()
    if not cleaned or cleaned.upper() == "N/A":
        return values
    for chunk in cleaned.split(","):
        part = chunk.strip()
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            start = int(start_text)
            end = int(end_text)
            values.extend(range(start, end + 1))
        else:
            values.append(int(part))
    return values


def _extract_gpu_count(text: str) -> int:
    matches = [int(value) for value in GPU_COUNT_PATTERN.findall(text)]
    if matches:
        return max(matches)
    alloc_match = re.search(r"gres/gpu=(\d+)", text)
    return int(alloc_match.group(1)) if alloc_match else 0


def _expand_node_list(nodelist: str) -> list[str]:
    quoted = shlex.quote(nodelist)
    output = run_stdout(f"scontrol show hostnames {quoted}")
    nodes = [line.strip() for line in output.strip().split("\n") if line.strip()]
    if nodes:
        return nodes
    return [nodelist] if nodelist else []


def _parse_job_node_allocations(job_id: str, default_nodelist: str, default_gres: str) -> list[dict]:
    stdout = run_stdout(f"scontrol show job -d {shlex.quote(job_id)}")
    if stdout:
        flat = " ".join(stdout.split())
        allocations = []
        for match in NODE_SECTION_PATTERN.finditer(flat):
            node_expr = match.group(1)
            segment = match.group(2)
            indices: list[int] = []
            for index_text in GPU_INDEX_PATTERN.findall(segment):
                indices.extend(_parse_index_list(index_text))
            gpu_count = _extract_gpu_count(segment)
            expanded = _expand_node_list(node_expr) or [node_expr]
            per_node_count = gpu_count
            if len(expanded) > 1 and gpu_count > 0:
                per_node_count = max(1, gpu_count // len(expanded))
            for node_name in expanded:
                allocations.append(
                    {
                        "node_name": node_name,
                        "gpu_indices": sorted(set(indices)) if len(expanded) == 1 else [],
                        "gpu_count": per_node_count,
                    }
                )
        if allocations:
            return allocations
    expanded = _expand_node_list(default_nodelist)
    if not expanded:
        return []
    gpu_count = _extract_gpu_count(default_gres) or 1
    per_node_count = gpu_count
    if len(expanded) > 1:
        per_node_count = max(1, gpu_count // len(expanded))
    return [
        {
            "node_name": node_name,
            "gpu_indices": [],
            "gpu_count": per_node_count,
        }
        for node_name in expanded
    ]


def _get_running_gpu_jobs() -> list[dict]:
    output = run_stdout("squeue --states=RUNNING --format='%i|%u|%N|%M|%l|%b' --noheader")
    jobs = []
    for line in output.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.strip().split("|")
        if len(parts) < 6:
            continue
        job_id, user, nodelist, time_elapsed, time_limit, gres = parts[:6]
        gpu_count = _extract_gpu_count(gres)
        if gpu_count <= 0:
            continue
        limit_seconds = _parse_time_to_seconds(time_limit)
        elapsed_seconds = _parse_time_to_seconds(time_elapsed)
        progress_pct = None
        if limit_seconds > 0:
            progress_pct = min(100, round((elapsed_seconds / limit_seconds) * 100))
        jobs.append(
            {
                "job_id": job_id.strip(),
                "user": user.strip(),
                "time_elapsed": time_elapsed.strip(),
                "time_limit": time_limit.strip(),
                "progress_pct": progress_pct,
                "assignments": _parse_job_node_allocations(job_id.strip(), nodelist.strip(), gres.strip()),
            }
        )
    return jobs


def _int_or_none(value: str) -> int | None:
    text = value.strip()
    if not text or text.upper() in ("N/A", "[N/A]"):
        return None
    return int(text)


def _parse_nvidia_smi_csv(stdout: str) -> dict[int, dict]:
    node_stats: dict[int, dict] = {}
    for line in stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 5:
            continue
        gpu_index = _int_or_none(parts[0])
        if gpu_index is None:
            continue
        node_stats[gpu_index] = {
            "memory_used_mb": _int_or_none(parts[1]),
            "memory_total_mb": _int_or_none(parts[2]),
            "temperature_c": _int_or_none(parts[3]),
            "utilization_pct": _int_or_none(parts[4]),
        }
    return node_stats


def aggregate_gpu_device_stats(device_stats: dict[int, dict]) -> dict | None:
    stats = {
        "memory_used_mb": 0,
        "memory_total_mb": 0,
        "temperature_c": None,
        "utilization_pct": None,
    }
    for device in device_stats.values():
        if device["memory_used_mb"] is not None:
            stats["memory_used_mb"] += device["memory_used_mb"]
        if device["memory_total_mb"] is not None:
            stats["memory_total_mb"] += device["memory_total_mb"]
        if device["temperature_c"] is not None:
            stats["temperature_c"] = max(stats["temperature_c"] or 0, device["temperature_c"])
        if device["utilization_pct"] is not None:
            stats["utilization_pct"] = max(stats["utilization_pct"] or 0, device["utilization_pct"])
    if stats["memory_total_mb"] > 0 or stats["temperature_c"] is not None or stats["utilization_pct"] is not None:
        return stats
    return None


def _has_gpu_stats(stats: dict) -> bool:
    return stats["memory_total_mb"] > 0 or stats["temperature_c"] is not None or stats["utilization_pct"] is not None


def _query_node_gpu_stats(node_names: set[str]) -> dict[str, dict[int, dict]]:
    stats_by_node: dict[str, dict[int, dict]] = {}
    for node_name in sorted(node_names):
        quoted_node = shlex.quote(node_name)
        quoted_query = shlex.quote(NVIDIA_SMI_QUERY)
        stdout, _, returncode = run(
            f"ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "
            f"-o ConnectTimeout=5 {quoted_node} {quoted_query}"
        )
        if returncode != 0:
            continue
        stats_by_node[node_name] = _parse_nvidia_smi_csv(stdout)
    return stats_by_node


def get_job_gpu_stats(job_id: str) -> dict | None:
    quoted_job_id = shlex.quote(job_id)
    job_query = (
        f'if [ -n "$CUDA_VISIBLE_DEVICES" ]; then '
        f'nvidia-smi -i "$CUDA_VISIBLE_DEVICES" {NVIDIA_SMI_QUERY_ARGS}; '
        f"else {NVIDIA_SMI_QUERY}; fi"
    )
    command = (
        f"timeout {JOB_GPU_STATS_TIMEOUT_SECONDS}s "
        f"srun --overlap --jobid={quoted_job_id} --ntasks=1 --cpus-per-task=1 "
        f"bash -lc {shlex.quote(job_query)}"
    )
    stdout, stderr, returncode = run(command)
    if returncode != 0:
        logger.debug("job GPU stats query failed for %s: %s", job_id, stderr.strip())
        return None
    return aggregate_gpu_device_stats(_parse_nvidia_smi_csv(stdout))


def _build_gpu_slot(job: dict, gpu_index: int, stats: dict | None) -> dict:
    utilization = stats.get("utilization_pct") if stats else None
    return {
        "job_id": job["job_id"],
        "user": job["user"],
        "gpu_index": gpu_index,
        "time_elapsed": job["time_elapsed"],
        "time_limit": job["time_limit"],
        "progress_pct": job["progress_pct"],
        "memory_used_mb": stats.get("memory_used_mb") if stats else None,
        "memory_total_mb": stats.get("memory_total_mb") if stats else None,
        "temperature_c": stats.get("temperature_c") if stats else None,
        "utilization_pct": utilization,
        "active": utilization is not None and utilization > 5,
    }


def _build_gpu_activity(nodes: list[NodeInfo]) -> dict:
    gpu_jobs_by_node: dict[str, list[dict | None]] = {
        node.name: [None] * node.total_gpus
        for node in nodes
    }
    running_jobs = _get_running_gpu_jobs()
    node_names = {
        assignment["node_name"]
        for job in running_jobs
        for assignment in job["assignments"]
    }
    node_stats = _query_node_gpu_stats(node_names)
    fallback_assignments: dict[str, list[tuple[dict, int]]] = {}
    for job in running_jobs:
        for assignment in job["assignments"]:
            node_name = assignment["node_name"]
            slots = gpu_jobs_by_node.get(node_name)
            if slots is None:
                continue
            explicit_indices = [
                index
                for index in sorted(set(assignment["gpu_indices"]))
                if 0 <= index < len(slots)
            ]
            if explicit_indices:
                for gpu_index in explicit_indices:
                    slots[gpu_index] = _build_gpu_slot(
                        job,
                        gpu_index,
                        node_stats.get(node_name, {}).get(gpu_index),
                    )
                continue
            fallback_assignments.setdefault(node_name, []).append((job, assignment["gpu_count"] or 1))
    for node_name, jobs_to_place in fallback_assignments.items():
        slots = gpu_jobs_by_node.get(node_name)
        if slots is None:
            continue
        available_indices = [index for index, slot in enumerate(slots) if slot is None]
        cursor = 0
        for job, gpu_count in jobs_to_place:
            for gpu_index in available_indices[cursor:cursor + gpu_count]:
                slots[gpu_index] = _build_gpu_slot(
                    job,
                    gpu_index,
                    node_stats.get(node_name, {}).get(gpu_index),
                )
            cursor += gpu_count
    return {
        "gpu_jobs_by_node": gpu_jobs_by_node,
        "job_stats_by_job_id": aggregate_job_gpu_stats(gpu_jobs_by_node),
    }


def aggregate_job_gpu_stats(gpu_jobs_by_node: dict[str, list[dict | None]]) -> dict[str, dict]:
    stats_by_job: dict[str, dict] = {}
    for slots in gpu_jobs_by_node.values():
        for slot in slots:
            if not slot:
                continue
            job_id = slot["job_id"]
            if job_id not in stats_by_job:
                stats_by_job[job_id] = {
                    "memory_used_mb": 0,
                    "memory_total_mb": 0,
                    "temperature_c": None,
                    "utilization_pct": None,
                }
            current = stats_by_job[job_id]
            if slot["memory_used_mb"] is not None:
                current["memory_used_mb"] += slot["memory_used_mb"]
            if slot["memory_total_mb"] is not None:
                current["memory_total_mb"] += slot["memory_total_mb"]
            if slot["temperature_c"] is not None:
                current["temperature_c"] = max(current["temperature_c"] or 0, slot["temperature_c"])
            if slot["utilization_pct"] is not None:
                current["utilization_pct"] = max(current["utilization_pct"] or 0, slot["utilization_pct"])
    return {
        job_id: stats
        for job_id, stats in stats_by_job.items()
        if _has_gpu_stats(stats)
    }


def get_cached_gpu_activity(nodes: list[NodeInfo] | None = None) -> dict:
    now = time.time()
    with _GPU_ACTIVITY_CACHE_LOCK:
        cached_value = _GPU_ACTIVITY_CACHE["value"]
        expires_at = float(_GPU_ACTIVITY_CACHE["expires_at"])
        if cached_value is not None and expires_at > now:
            return cached_value  # type: ignore[return-value]
    if nodes is None:
        nodes = parse_gpu_nodes()
    value = _build_gpu_activity(nodes)
    with _GPU_ACTIVITY_CACHE_LOCK:
        _GPU_ACTIVITY_CACHE["value"] = value
        _GPU_ACTIVITY_CACHE["expires_at"] = now + GPU_ACTIVITY_TTL_SECONDS
    return value


def format_gpu_report_v2() -> dict:
    nodes = parse_gpu_nodes()
    summary = compute_summary(nodes, shared_only=True)
    gpu_activity = get_cached_gpu_activity(nodes)
    return {
        "nodes": [
            {
                "name": node.name,
                "gpu_type": node.gpu_type,
                "partition": node.partition,
                "total_gpus": node.total_gpus,
                "allocated_gpus": node.allocated_gpus,
                "state": node.state,
                "memory_total_mb": node.memory_total_mb,
                "memory_allocated_mb": node.memory_allocated_mb,
            }
            for node in nodes
        ],
        "summary": summary,
        "gpu_jobs_by_node": gpu_activity["gpu_jobs_by_node"],
    }


def get_free_gpu_type_info() -> list[dict]:
    nodes = parse_gpu_nodes()
    summary = compute_summary(nodes, shared_only=True)
    return summary["free"]
