import subprocess
import threading
import re
from pathlib import Path

def run_command(cmd: str) -> tuple[str, str, int]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode

def create_screen(screen_name: str) -> bool:
    stdout, stderr, returncode = run_command(f"screen -dmS {screen_name}")
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
    prefix = f"tq_{project_name}_"
    return [s for s in all_screens if s.startswith(prefix)]

def get_next_screen_name(project_dir: str) -> str:
    if not project_dir:
        project_name = "default"
    else:
        project_name = Path(project_dir).name
    project_name = re.sub(r'[^a-zA-Z0-9_-]', '_', project_name)
    existing = get_project_screens(project_name)
    existing_indices = []
    for s in existing:
        match = re.search(rf'tq_{re.escape(project_name)}_(\d+)$', s)
        if match:
            existing_indices.append(int(match.group(1)))
    next_index = 0
    while next_index in existing_indices:
        next_index += 1
    return f"tq_{project_name}_{next_index}"

def _setup_screen_worker(screen_name: str, job_id: str, commands: list[str]):
    import time
    if screen_exists(screen_name):
        kill_screen(screen_name)
        time.sleep(0.2)
    create_screen(screen_name)
    time.sleep(0.2)
    srun_cmd = f"srun --pty --jobid={job_id} bash"
    send_to_screen(screen_name, srun_cmd)
    time.sleep(1)
    for cmd in commands:
        if cmd.strip():
            send_to_screen(screen_name, cmd)
            time.sleep(0.1)

def setup_allocation_screen(job_id: str, commands: list[str], project_dir: str = "") -> str:
    screen_name = get_next_screen_name(project_dir)
    thread = threading.Thread(target=_setup_screen_worker, args=(screen_name, job_id, commands))
    thread.start()
    return screen_name

def cleanup_screen(job_id: str) -> bool:
    screen_name = f"tq_{job_id}"
    if screen_exists(screen_name):
        return kill_screen(screen_name)
    return True
