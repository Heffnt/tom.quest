import subprocess
import re
from dataclasses import dataclass, field

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
    state: str  # "up" | "down" | "drain"
    memory_total_mb: int
    memory_allocated_mb: int

def run_command(cmd: str) -> str:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout

def get_all_nodes() -> list[str]:
    """Get all nodes from sinfo."""
    output = run_command("sinfo -N -o '%N'")
    nodes = []
    for line in output.strip().split('\n'):
        node = line.strip()
        if node and node != 'NODELIST':
            nodes.append(node)
    return sorted(set(nodes))

def get_node_info(node: str) -> str:
    return run_command(f"scontrol show node {node}")

def parse_memory(tres_str: str) -> int:
    """Parse memory from TRES string, returns MB."""
    mem_match = re.search(r'mem=(\d+)([KMGT]?)', tres_str)
    if not mem_match:
        return 0
    value = int(mem_match.group(1))
    unit = mem_match.group(2)
    if unit == 'K':
        return value // 1024
    elif unit == 'G':
        return value * 1024
    elif unit == 'T':
        return value * 1024 * 1024
    return value  # Already in MB or no unit

def parse_gpu_nodes() -> list[NodeInfo]:
    """Parse all nodes with GPUs and return per-node info."""
    nodes = []
    all_node_names = get_all_nodes()
    for node_name in all_node_names:
        node_info_str = get_node_info(node_name)
        # Parse partition
        partition_match = re.search(r'Partitions=(\S+)', node_info_str)
        partition = partition_match.group(1) if partition_match else "unknown"
        # Determine node state
        state = "up"
        if re.search(r'State=\S*(DRAIN|RESERVED|DOWN|NOT_RESPONDING)', node_info_str):
            if 'DRAIN' in node_info_str:
                state = "drain"
            else:
                state = "down"
        # Parse GPU type and count
        gres_match = re.search(r'Gres=gpu:([^:]+):(\d+)', node_info_str)
        if not gres_match:
            continue  # Skip nodes without GPUs
        gpu_type = gres_match.group(1)
        total_gpus = int(gres_match.group(2))
        # Parse allocated GPUs
        allocated_gpus = 0
        alloc_match = re.search(r'AllocTRES=.*?gres/gpu=(\d+)', node_info_str)
        if alloc_match:
            allocated_gpus = int(alloc_match.group(1))
        # Parse memory
        cfg_tres_match = re.search(r'CfgTRES=([^\n]+)', node_info_str)
        alloc_tres_match = re.search(r'AllocTRES=([^\n]+)', node_info_str)
        memory_total_mb = parse_memory(cfg_tres_match.group(1)) if cfg_tres_match else 0
        memory_allocated_mb = parse_memory(alloc_tres_match.group(1)) if alloc_tres_match else 0
        nodes.append(NodeInfo(
            name=node_name,
            gpu_type=gpu_type,
            partition=partition,
            total_gpus=total_gpus,
            allocated_gpus=allocated_gpus,
            state=state,
            memory_total_mb=memory_total_mb,
            memory_allocated_mb=memory_allocated_mb
        ))
    return nodes

def compute_summary(nodes: list[NodeInfo], gpu_filter: bool = True) -> dict:
    """Compute summary stats from node list for dropdown compatibility."""
    available: dict[str, GPUTypeInfo] = {}
    unavailable: dict[str, GPUTypeInfo] = {}
    free: dict[str, GPUTypeInfo] = {}
    for node in nodes:
        # Apply gpu filter for summary (used by allocation dropdown)
        if gpu_filter and 'gpu' not in node.name.lower():
            continue
        gpu_type = node.gpu_type
        if node.state != "up":
            if gpu_type not in unavailable:
                unavailable[gpu_type] = GPUTypeInfo()
            unavailable[gpu_type].count += node.total_gpus
            unavailable[gpu_type].nodes.append(f"{node.name}({node.total_gpus})")
        else:
            if gpu_type not in available:
                available[gpu_type] = GPUTypeInfo()
            available[gpu_type].count += node.total_gpus
            available[gpu_type].nodes.append(f"{node.name}({node.total_gpus})")
            free_gpus = node.total_gpus - node.allocated_gpus
            if free_gpus > 0:
                if gpu_type not in free:
                    free[gpu_type] = GPUTypeInfo()
                free[gpu_type].count += free_gpus
                free[gpu_type].nodes.append(f"{node.name}({free_gpus})")
    def format_type_info(info: dict[str, GPUTypeInfo]) -> list[dict]:
        return [{"type": t, "count": d.count, "nodes": d.nodes} for t, d in info.items()]
    return {
        "available": format_type_info(available),
        "unavailable": format_type_info(unavailable),
        "free": format_type_info(free)
    }

def format_gpu_report_v2() -> dict:
    """New format with per-node data and summary."""
    nodes = parse_gpu_nodes()
    summary = compute_summary(nodes, gpu_filter=True)
    return {
        "nodes": [
            {
                "name": n.name,
                "gpu_type": n.gpu_type,
                "partition": n.partition,
                "total_gpus": n.total_gpus,
                "allocated_gpus": n.allocated_gpus,
                "state": n.state,
                "memory_total_mb": n.memory_total_mb,
                "memory_allocated_mb": n.memory_allocated_mb
            }
            for n in nodes
        ],
        "summary": summary
    }

def get_free_gpu_types() -> list[str]:
    nodes = parse_gpu_nodes()
    summary = compute_summary(nodes, gpu_filter=True)
    return [item["type"] for item in summary["free"]]
