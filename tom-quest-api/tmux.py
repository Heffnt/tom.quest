import shlex
import threading
import time

from job_screens import reserve_session_name
from shell import run

TERMINAL_JOB_STATES = {"CANCELLED", "FAILED", "COMPLETED", "TIMEOUT"}
EMPTY_STATUS_GRACE_CHECKS = 5


def create_session(session_name: str) -> bool:
    target = shlex.quote(session_name)
    _, _, returncode = run(f"tmux new-session -d -s {target}")
    if returncode != 0:
        return False
    run(f"tmux set-option -t {target} window-size latest")
    return True


def send_to_session(session_name: str, command: str) -> bool:
    target = shlex.quote(session_name)
    escaped_cmd = command.replace("'", "'\\''")
    _, _, returncode = run(f"tmux send-keys -t {target} '{escaped_cmd}' Enter")
    return returncode == 0


def session_exists(session_name: str) -> bool:
    target = shlex.quote(session_name)
    _, _, returncode = run(f"tmux has-session -t {target} 2>/dev/null")
    return returncode == 0


def kill_session(session_name: str) -> bool:
    target = shlex.quote(session_name)
    _, _, returncode = run(f"tmux kill-session -t {target}")
    return returncode == 0


def capture_output(session_name: str, lines: int = 500) -> str:
    target = shlex.quote(session_name)
    stdout, _, returncode = run(f"tmux capture-pane -t {target} -p -S -{lines}")
    if returncode != 0:
        return ""
    return stdout


def list_session_clients(session_name: str) -> list[str]:
    target = shlex.quote(session_name)
    stdout, _, returncode = run(
        f"tmux list-clients -t {target} -F '#{{client_tty}}' 2>/dev/null"
    )
    if returncode != 0:
        return []
    return [line.strip() for line in stdout.strip().split("\n") if line.strip()]


def count_session_clients(session_name: str) -> int:
    return len(list_session_clients(session_name))


def detach_session_clients(session_name: str) -> int:
    detached = 0
    for client_tty in list_session_clients(session_name):
        target = shlex.quote(client_tty)
        _, _, returncode = run(f"tmux detach-client -t {target}")
        if returncode == 0:
            detached += 1
    return detached


def resize_session_window(session_name: str, cols: int, rows: int) -> bool:
    target = shlex.quote(session_name)
    run(f"tmux set-option -t {target} window-size latest")
    _, _, returncode = run(
        f"tmux resize-window -t {target} -x {int(cols)} -y {int(rows)}"
    )
    return returncode == 0


def _get_job_status(job_id: str) -> str:
    stdout, _, _ = run(f"squeue -j {shlex.quote(job_id)} -h -o '%T'")
    return stdout.strip()


def _setup_session_worker(session_name: str, job_id: str, commands: list[str]) -> None:
    empty_status_checks = 0
    while True:
        status = _get_job_status(job_id)
        if status == "RUNNING":
            break
        if status in TERMINAL_JOB_STATES:
            return
        if status == "":
            from slurm import allocation_process_alive

            if allocation_process_alive(job_id):
                empty_status_checks = 0
                time.sleep(2)
                continue
            empty_status_checks += 1
            if empty_status_checks >= EMPTY_STATUS_GRACE_CHECKS:
                return
            time.sleep(2)
            continue
        empty_status_checks = 0
        time.sleep(2)
    if session_exists(session_name):
        kill_session(session_name)
        time.sleep(0.2)
    if not create_session(session_name):
        return
    time.sleep(0.2)
    send_to_session(session_name, f"srun --pty --jobid={job_id} bash")
    time.sleep(1)
    for command in commands:
        if command.strip():
            send_to_session(session_name, command)
            time.sleep(0.1)


def setup_allocation_session(job_id: str, commands: list[str], job_name: str = "allocation") -> str:
    session_name = reserve_session_name(job_id, job_name)
    thread = threading.Thread(target=_setup_session_worker, args=(session_name, job_id, commands), daemon=True)
    thread.start()
    return session_name


def cleanup_session(session_name: str) -> bool:
    if session_name and session_exists(session_name):
        return kill_session(session_name)
    return True
