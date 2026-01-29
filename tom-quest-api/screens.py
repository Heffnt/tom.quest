import subprocess
import threading
import re
from pathlib import Path
from job_screens import save_screen_mapping, get_all_mapped_screens

def run_command(cmd: str) -> tuple[str, str, int]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

def create_screen(screen_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"screen -S {screen_name}")
    return returncode == 0

def send_to_screen(screen_name: str, command: str) -> bool:
    escaped_cmd = command.replace("'", "'\\''")
    cmd = f"screen -S {screen_name} -X stuff '{escaped_cmd}\n'"
    stdout, stderr, returncode = run_command(cmd)
    return returncode == 0

def screen_exists(screen_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"screen -ls {screen_name}")
    return screen_name in stdout

def kill_screen(screen_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"screen -S {screen_name} -X quit")
    return returncode == 0

def list_screens() -> list[str]:
    stdout, stderr, returncode = run_command("screen -ls")
    screens = []
    for line in stdout.split('\n'):
        match = re.search(r'\d+\.(\S+)', line)
        if match:
            screens.append(match.group(1))
    return screens

def get_project_screens(project_name: str) -> list[str]:
    all_screens = list_screens()
    prefix = f"{project_name}_"
    return [s for s in all_screens if s.startswith(prefix)]

def get_next_screen_name(project_dir: str) -> str:
    if not project_dir:
        project_name = "default"
    else:
        project_name = Path(project_dir).name
    project_name = re.sub(r'[^a-zA-Z0-9_-]', '_', project_name)
    # Check both existing screen processes AND mapped screens (for pending allocations)
    existing = get_project_screens(project_name)
    mapped = [s for s in get_all_mapped_screens() if s.startswith(f"{project_name}_")]
    all_screens = set(existing + mapped)
    used_indices = set()
    for s in all_screens:
        match = re.search(rf'{re.escape(project_name)}_(\d+)$', s)
        if match:
            used_indices.add(int(match.group(1)))
    next_index = 1
    while next_index in used_indices:
        next_index += 1
    return f"{project_name}_{next_index}"

def _get_job_status(job_id: str) -> str:
    """Get current status of a job (PENDING, RUNNING, etc)."""
    stdout, _, _ = run_command(f"squeue -j {job_id} -h -o '%T'")
    return stdout.strip()

def _setup_screen_worker(screen_name: str, job_id: str, commands: list[str]):
    import time
    # Wait for job to be RUNNING before creating screen (poll up to 30 min)
    for _ in range(900):
        status = _get_job_status(job_id)
        if status == "RUNNING":
            break
        if status == "" or status in ("CANCELLED", "FAILED", "COMPLETED", "TIMEOUT"):
            return  # Job is gone, don't create screen
        time.sleep(2)
    else:
        return  # Timed out waiting for job
    # Now job is running - create screen and attach
    if screen_exists(screen_name):
        kill_screen(screen_name)
        time.sleep(0.2)
    create_screen(screen_name)
    time.sleep(0.2)
    srun_cmd = f"srun --pty --jobid={job_id} bash"
    send_to_screen(screen_name, srun_cmd)
    time.sleep(1)  # Brief pause after srun
    for cmd in commands:
        if cmd.strip():
            send_to_screen(screen_name, cmd)
            time.sleep(0.1)

def setup_allocation_screen(job_id: str, commands: list[str], project_dir: str = "") -> str:
    screen_name = get_next_screen_name(project_dir)
    save_screen_mapping(job_id, screen_name)
    thread = threading.Thread(target=_setup_screen_worker, args=(screen_name, job_id, commands))
    thread.start()
    return screen_name

def cleanup_screen(screen_name: str) -> bool:
    if screen_name and screen_exists(screen_name):
        return kill_screen(screen_name)
    return True
