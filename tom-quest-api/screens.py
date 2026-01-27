import subprocess
import time

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

def setup_allocation_screen(job_id: str, commands: list[str]) -> str:
    screen_name = f"tq_{job_id}"
    create_screen(screen_name)
    time.sleep(0.5)
    srun_cmd = f"srun --pty --jobid={job_id} bash"
    send_to_screen(screen_name, srun_cmd)
    time.sleep(2)
    for cmd in commands:
        if cmd.strip():
            send_to_screen(screen_name, cmd)
            time.sleep(0.3)
    return screen_name

def cleanup_screen(job_id: str) -> bool:
    screen_name = f"tq_{job_id}"
    if screen_exists(screen_name):
        return kill_screen(screen_name)
    return True
