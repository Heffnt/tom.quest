import subprocess
import re
import threading
import time
from dataclasses import dataclass

MAX_GPU_ALLOCATIONS = 12
SALLOC_JOB_ID_TIMEOUT = 10  # seconds to wait for job ID

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
    """Start salloc non-blocking, capture job ID from initial output, return immediately."""
    cmd = f"salloc --gres=gpu:{gpu_type}:1 --time={time_mins} --mem={memory_mb} --job-name=tom.quest"
    proc = subprocess.Popen(
        cmd,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    job_id = None
    output_lines = []
    def read_output(stream, lines):
        nonlocal job_id
        try:
            for line in iter(stream.readline, ''):
                lines.append(line)
                if job_id is None:
                    match = re.search(r'job (\d+)', line, re.IGNORECASE)
                    if match:
                        job_id = match.group(1)
        except:
            pass
    stdout_thread = threading.Thread(target=read_output, args=(proc.stdout, output_lines))
    stderr_thread = threading.Thread(target=read_output, args=(proc.stderr, output_lines))
    stdout_thread.start()
    stderr_thread.start()
    # Wait for job ID or timeout
    start = time.time()
    while job_id is None and (time.time() - start) < SALLOC_JOB_ID_TIMEOUT:
        if proc.poll() is not None:
            break
        time.sleep(0.1)
    if job_id:
        return job_id, None
    # If no job ID found, process may have failed - wait briefly for output
    proc.terminate()
    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)
    output = ''.join(output_lines)
    return None, output.strip() or "Failed to allocate GPU (no job ID received)"

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
    if not time_str or time_str in ("INVALID", "N/A", "NOT_SET"):
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
