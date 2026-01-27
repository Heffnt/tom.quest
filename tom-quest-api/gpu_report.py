import subprocess
import re
from dataclasses import dataclass, field

@dataclass
class GPUTypeInfo:
    count: int = 0
    nodes: list[str] = field(default_factory=list)

@dataclass
class GPUReport:
    available: dict[str, GPUTypeInfo] = field(default_factory=dict)
    unavailable: dict[str, GPUTypeInfo] = field(default_factory=dict)
    free: dict[str, GPUTypeInfo] = field(default_factory=dict)

def run_command(cmd: str) -> str:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout

def get_gpu_nodes() -> list[str]:
    output = run_command("sinfo -N -o '%N'")
    nodes = []
    for line in output.strip().split('\n'):
        node = line.strip()
        if 'gpu' in node.lower():
            nodes.append(node)
    return sorted(set(nodes))

def get_node_info(node: str) -> str:
    return run_command(f"scontrol show node {node}")

def parse_gpu_report() -> GPUReport:
    report = GPUReport()
    gpu_nodes = get_gpu_nodes()
    for node in gpu_nodes:
        node_info = get_node_info(node)
        if 'Partitions=' in node_info and 'academic' in node_info:
            continue
        node_down_reserved = False
        if any(state in node_info for state in ['State=.*DRAIN', 'DRAIN', 'RESERVED', 'DOWN', 'NOT_RESPONDING']):
            if re.search(r'State=\S*(DRAIN|RESERVED|DOWN|NOT_RESPONDING)', node_info):
                node_down_reserved = True
        gres_match = re.search(r'Gres=gpu:([^:]+):(\d+)', node_info)
        if not gres_match:
            continue
        gpu_type = gres_match.group(1)
        total_node_gpus = int(gres_match.group(2))
        if node_down_reserved:
            if gpu_type not in report.unavailable:
                report.unavailable[gpu_type] = GPUTypeInfo()
            report.unavailable[gpu_type].count += total_node_gpus
            report.unavailable[gpu_type].nodes.append(f"{node}({total_node_gpus})")
            continue
        alloc_node_gpus = 0
        for line in node_info.split('\n'):
            if 'AllocTRES=' in line:
                alloc_match = re.search(r'gres/gpu=(\d+)', line)
                if alloc_match:
                    alloc_node_gpus = int(alloc_match.group(1))
                break
        unused_node_gpus = total_node_gpus - alloc_node_gpus
        if gpu_type not in report.available:
            report.available[gpu_type] = GPUTypeInfo()
        report.available[gpu_type].count += total_node_gpus
        report.available[gpu_type].nodes.append(f"{node}({total_node_gpus})")
        if unused_node_gpus > 0:
            if gpu_type not in report.free:
                report.free[gpu_type] = GPUTypeInfo()
            report.free[gpu_type].count += unused_node_gpus
            report.free[gpu_type].nodes.append(f"{node}({unused_node_gpus})")
    return report

def format_gpu_report(report: GPUReport) -> dict:
    def format_type_info(info: dict[str, GPUTypeInfo]) -> list[dict]:
        return [
            {"type": gpu_type, "count": data.count, "nodes": data.nodes}
            for gpu_type, data in info.items()
        ]
    return {
        "available": format_type_info(report.available),
        "unavailable": format_type_info(report.unavailable),
        "free": format_type_info(report.free),
        "notes": [
            "nvidia = H100",
            "tesla = V100",
            "academic partition nodes excluded",
            "only nodes with 'gpu' in name included"
        ]
    }

def get_free_gpu_types() -> list[str]:
    report = parse_gpu_report()
    return list(report.free.keys())
