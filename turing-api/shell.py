import subprocess
import logging


logger = logging.getLogger("tom.quest.shell")
DEFAULT_COMMAND_TIMEOUT_SECONDS = 20
RESOURCE_UNAVAILABLE_RETURN_CODE = 75


def run(cmd: str, timeout: int = DEFAULT_COMMAND_TIMEOUT_SECONDS) -> tuple[str, str, int]:
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except BlockingIOError as exc:
        logger.warning("Command could not start because resources are unavailable: %s", cmd)
        return "", str(exc), RESOURCE_UNAVAILABLE_RETURN_CODE
    except OSError as exc:
        logger.warning("Command could not start: %s", cmd)
        return "", str(exc), RESOURCE_UNAVAILABLE_RETURN_CODE
    except subprocess.TimeoutExpired as exc:
        logger.warning("Command timed out after %ss: %s", timeout, cmd)
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else str(exc)
        return stdout, stderr, 124
    return result.stdout, result.stderr, result.returncode


def run_stdout(cmd: str) -> str:
    stdout, _, _ = run(cmd)
    return stdout
