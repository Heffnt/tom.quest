import subprocess
import threading
import re
from pathlib import Path
from job_screens import save_screen_mapping, get_active_mapped_screens

def run_command(cmd: str) -> tuple[str, str, int]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

def create_session(session_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"tmux new-session -d -s {session_name}")
    return returncode == 0

def send_to_session(session_name: str, command: str) -> bool:
    escaped_cmd = command.replace("'", "'\\''")
    cmd = f"tmux send-keys -t {session_name} '{escaped_cmd}' Enter"
    stdout, stderr, returncode = run_command(cmd)
    return returncode == 0

def session_exists(session_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"tmux has-session -t {session_name} 2>/dev/null")
    return returncode == 0

def kill_session(session_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"tmux kill-session -t {session_name}")
    return returncode == 0

def list_sessions() -> list[str]:
    stdout, stderr, returncode = run_command("tmux list-sessions -F '#{session_name}' 2>/dev/null")
    if returncode != 0:
        return []
    return [s.strip() for s in stdout.strip().split('\n') if s.strip()]

def get_project_sessions(project_name: str) -> list[str]:
    all_sessions = list_sessions()
    prefix = f"{project_name}_"
    return [s for s in all_sessions if s.startswith(prefix)]

def get_next_session_name(project_dir: str) -> str:
    if not project_dir:
        project_name = "default"
    else:
        project_name = Path(project_dir).name
    project_name = re.sub(r'[^a-zA-Z0-9_-]', '_', project_name)
    existing = get_project_sessions(project_name)
    mapped = [s for s in get_active_mapped_screens() if s.startswith(f"{project_name}_")]
    all_sessions = set(existing + mapped)
    used_indices = set()
    for s in all_sessions:
        match = re.search(rf'{re.escape(project_name)}_(\d+)$', s)
        if match:
            used_indices.add(int(match.group(1)))
    next_index = 1
    while next_index in used_indices:
        next_index += 1
    return f"{project_name}_{next_index}"

def capture_output(session_name: str, lines: int = 500) -> str:
    stdout, stderr, returncode = run_command(f"tmux capture-pane -t {session_name} -p -S -{lines}")
    if returncode != 0:
        return ""
    return stdout

def _get_job_status(job_id: str) -> str:
    stdout, _, _ = run_command(f"squeue -j {job_id} -h -o '%T'")
    return stdout.strip()

def _setup_session_worker(session_name: str, job_id: str, commands: list[str]):
    import time
    for _ in range(900):
        status = _get_job_status(job_id)
        if status == "RUNNING":
            break
        if status == "" or status in ("CANCELLED", "FAILED", "COMPLETED", "TIMEOUT"):
            return
        time.sleep(2)
    else:
        return
    if session_exists(session_name):
        kill_session(session_name)
        time.sleep(0.2)
    create_session(session_name)
    time.sleep(0.2)
    srun_cmd = f"srun --pty --jobid={job_id} bash"
    send_to_session(session_name, srun_cmd)
    time.sleep(1)
    for cmd in commands:
        if cmd.strip():
            send_to_session(session_name, cmd)
            time.sleep(0.1)

def setup_allocation_session(job_id: str, commands: list[str], project_dir: str = "") -> str:
    session_name = get_next_session_name(project_dir)
    save_screen_mapping(job_id, session_name)
    thread = threading.Thread(target=_setup_session_worker, args=(session_name, job_id, commands))
    thread.start()
    return session_name

def cleanup_session(session_name: str) -> bool:
    if session_name and session_exists(session_name):
        return kill_session(session_name)
    return True
