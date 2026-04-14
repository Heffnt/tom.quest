import subprocess


def run(cmd: str) -> tuple[str, str, int]:
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode


def run_stdout(cmd: str) -> str:
    stdout, _, _ = run(cmd)
    return stdout
