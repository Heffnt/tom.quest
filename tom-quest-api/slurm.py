import os
import re
import shlex
import signal
import subprocess
import threading
from dataclasses import dataclass

from job_screens import get_screen_name
from shell import run

SALLOC_JOB_ID_TIMEOUT = 60
JOB_ID_PATTERNS = [
    re.compile(r"Pending job allocation (\d+)", re.IGNORECASE),
    re.compile(r"Granted job allocation (\d+)", re.IGNORECASE),
    re.compile(r"job (\d+) queued and waiting", re.IGNORECASE),
    re.compile(r"job (\d+) has been allocated", re.IGNORECASE),
    re.compile(r"job (\d+)", re.IGNORECASE),
]
_SALLOC_PROCESSES: dict[str, subprocess.Popen[str]] = {}
_SALLOC_LOCK = threading.Lock()


@dataclass
class JobGpuStats:
    memory_used_mb: int
    memory_total_mb: int
    temperature_c: int | None
    utilization_pct: int | None


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
    gpu_stats: JobGpuStats | None = None


def _extract_job_id(line: str) -> str | None:
    for pattern in JOB_ID_PATTERNS:
        match = pattern.search(line)
        if match:
            return match.group(1)
    return None


def _watch_salloc_process(job_id: str, proc: subprocess.Popen[str]) -> None:
    try:
        proc.wait()
    finally:
        with _SALLOC_LOCK:
            if _SALLOC_PROCESSES.get(job_id) is proc:
                _SALLOC_PROCESSES.pop(job_id, None)


def _track_salloc_process(job_id: str, proc: subprocess.Popen[str]) -> None:
    with _SALLOC_LOCK:
        _SALLOC_PROCESSES[job_id] = proc
    threading.Thread(target=_watch_salloc_process, args=(job_id, proc), daemon=True).start()


def allocation_process_alive(job_id: str) -> bool:
    with _SALLOC_LOCK:
        proc = _SALLOC_PROCESSES.get(job_id)
    return proc is not None and proc.poll() is None


def _reap_salloc(job_id: str) -> None:
    with _SALLOC_LOCK:
        proc = _SALLOC_PROCESSES.pop(job_id, None)
    if proc is None:
        return
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        return
    try:
        proc.wait(timeout=0.1)
    except subprocess.TimeoutExpired:
        pass


def allocate_gpu(
    gpu_type: str,
    time_mins: int,
    memory_mb: int = 64000,
    job_name: str = "allocation",
) -> tuple[str | None, str | None]:
    clean_job_name = job_name.strip() or "allocation"
    proc = subprocess.Popen(
        [
            "salloc",
            "--no-shell",
            f"--gres=gpu:{gpu_type}:1",
            f"--time={time_mins}",
            f"--mem={memory_mb}",
            f"--job-name={clean_job_name}",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    job_id: str | None = None
    output_lines: list[str] = []
    ready = threading.Event()

    def read_output() -> None:
        nonlocal job_id
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                output_lines.append(line.rstrip("\n"))
                if job_id is None:
                    parsed_job_id = _extract_job_id(line)
                    if parsed_job_id:
                        job_id = parsed_job_id
                        ready.set()
        finally:
            ready.set()

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    ready.wait(SALLOC_JOB_ID_TIMEOUT)
    if job_id:
        _track_salloc_process(job_id, proc)
        return job_id, None
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
    reader.join(timeout=1)
    output = "\n".join(output_lines).strip()
    return None, output or "Failed to allocate GPU (no job ID received)"


def cancel_job(job_id: str) -> tuple[bool, str | None]:
    _, stderr, returncode = run(f"scancel {shlex.quote(job_id)}")
    _reap_salloc(job_id)
    if returncode == 0:
        return True, None
    return False, stderr or "Failed to cancel job"


def get_user_jobs() -> list[JobInfo]:
    stdout, _, _ = run(
        "squeue --me --format='%i|%T|%L|%S|%e|%b|%R' --noheader"
    )
    from gpu_report import get_cached_gpu_activity
    from tmux import session_exists

    gpu_activity = get_cached_gpu_activity()
    job_stats_by_id = gpu_activity.get("job_stats_by_job_id", {})
    jobs = []
    for line in stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.strip().split("|")
        if len(parts) < 7:
            continue
        job_id, status, time_left, start_time, end_time, gres, reason = parts
        gpu_type = "unknown"
        gres_match = re.search(r"gpu:([^:|]+):", gres)
        if gres_match:
            gpu_type = gres_match.group(1)
        time_remaining_seconds = parse_time_to_seconds(time_left)
        display_status = status.strip()
        reason = reason.strip()
        if display_status == "PENDING" and reason:
            display_status = f"PENDING ({reason})"
        elif display_status == "RUNNING" and reason:
            display_status = f"RUNNING ({reason})"
        mapped_screen_name = get_screen_name(job_id.strip())
        screen_name = mapped_screen_name if mapped_screen_name and session_exists(mapped_screen_name) else ""
        raw_gpu_stats = job_stats_by_id.get(job_id.strip())
        gpu_stats = None
        if raw_gpu_stats:
            gpu_stats = JobGpuStats(
                memory_used_mb=raw_gpu_stats["memory_used_mb"],
                memory_total_mb=raw_gpu_stats["memory_total_mb"],
                temperature_c=raw_gpu_stats["temperature_c"],
                utilization_pct=raw_gpu_stats["utilization_pct"],
            )
        jobs.append(
            JobInfo(
                job_id=job_id.strip(),
                gpu_type=gpu_type,
                status=display_status,
                time_remaining=time_left.strip(),
                time_remaining_seconds=time_remaining_seconds,
                screen_name=screen_name,
                start_time=start_time.strip(),
                end_time=end_time.strip(),
                gpu_stats=gpu_stats,
            )
        )
    return jobs


def parse_time_to_seconds(time_str: str) -> int:
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
