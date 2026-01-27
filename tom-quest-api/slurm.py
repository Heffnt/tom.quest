import subprocess
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

MAX_GPU_ALLOCATIONS = 12

@dataclass
class JobInfo:
    job_id: str
    gpu_type: str
    status: str
    time_remaining: str
    time_remaining_seconds: int
    screen_name: str
    start_time: str
    end_time: str

def run_command(cmd: str) -> tuple[str, str, int]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

def allocate_gpu(gpu_type: str, time_mins: int, memory_mb: int = 64000) -> tuple[str | None, str | None]:
    cmd = f"salloc --gres=gpu:{gpu_type}:1 --time={time_mins} --mem={memory_mb} --no-shell"
    stdout, stderr, returncode = run_command(cmd)
    output = stdout + stderr
    job_match = re.search(r'job (\d+)', output, re.IGNORECASE)
    if job_match:
        return job_match.group(1), None
    grant_match = re.search(r'Granted job allocation (\d+)', output)
    if grant_match:
        return grant_match.group(1), None
    return None, output or "Failed to allocate GPU"

def cancel_job(job_id: str) -> tuple[bool, str | None]:
    stdout, stderr, returncode = run_command(f"scancel {job_id}")
    if returncode == 0:
        return True, None
    return False, stderr or "Failed to cancel job"

def get_user_jobs() -> list[JobInfo]:
    stdout, stderr, returncode = run_command(
        "squeue --me --format='%i|%T|%L|%S|%e|%b' --noheader"
    )
    jobs = []
    for line in stdout.strip().split('\n'):
        if not line.strip():
            continue
        parts = line.strip().split('|')
        if len(parts) < 6:
            continue
        job_id, status, time_left, start_time, end_time, gres = parts
        gpu_type = "unknown"
        gres_match = re.search(r'gpu:([^:]+):', gres)
        if gres_match:
            gpu_type = gres_match.group(1)
        time_remaining_seconds = parse_time_to_seconds(time_left)
        jobs.append(JobInfo(
            job_id=job_id.strip(),
            gpu_type=gpu_type,
            status=status.strip(),
            time_remaining=time_left.strip(),
            time_remaining_seconds=time_remaining_seconds,
            screen_name=f"tq_{job_id.strip()}",
            start_time=start_time.strip(),
            end_time=end_time.strip()
        ))
    return jobs

def parse_time_to_seconds(time_str: str) -> int:
    time_str = time_str.strip()
    if not time_str or time_str == "INVALID":
        return 0
    total_seconds = 0
    if '-' in time_str:
        days_part, time_part = time_str.split('-', 1)
        total_seconds += int(days_part) * 86400
        time_str = time_part
    parts = time_str.split(':')
    if len(parts) == 3:
        total_seconds += int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    elif len(parts) == 2:
        total_seconds += int(parts[0]) * 60 + int(parts[1])
    elif len(parts) == 1:
        total_seconds += int(parts[0])
    return total_seconds

def get_job_count() -> int:
    jobs = get_user_jobs()
    return len(jobs)
