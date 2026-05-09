import fcntl
import json
import re
from contextlib import contextmanager
from pathlib import Path

from shell import run_stdout

SCREENS_FILE = Path.home() / ".tom-quest-screens.json"
LOCK_FILE = Path.home() / ".tom-quest-screens.lock"
SESSION_INDEX_PATTERN = re.compile(r"^(\d+)_")


def _normalize_mappings(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    mappings: dict[str, str] = {}
    for job_id, value in raw.items():
        if not isinstance(job_id, str):
            continue
        if isinstance(value, str):
            mappings[job_id] = value
            continue
        if isinstance(value, dict) and isinstance(value.get("session_name"), str):
            mappings[job_id] = value["session_name"]
    return mappings


@contextmanager
def _locked():
    LOCK_FILE.touch(exist_ok=True)
    with LOCK_FILE.open("r+") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def _load_mappings_unlocked() -> dict[str, str]:
    if not SCREENS_FILE.exists():
        return {}
    try:
        return _normalize_mappings(json.loads(SCREENS_FILE.read_text()))
    except Exception:
        return {}


def _save_mappings_unlocked(mappings: dict[str, str]) -> None:
    SCREENS_FILE.write_text(json.dumps(mappings))


def _get_active_job_ids() -> set[str]:
    output = run_stdout("squeue --me -h -o '%i'")
    return {line.strip() for line in output.strip().split("\n") if line.strip()}


def _sanitize_job_name(job_name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", (job_name.strip() or "allocation"))
    cleaned = cleaned.strip("_")
    return cleaned or "allocation"


def reserve_session_name(job_id: str, job_name: str) -> str:
    with _locked():
        mappings = _load_mappings_unlocked()
        existing = mappings.get(job_id)
        if existing:
            return existing
        active_jobs = _get_active_job_ids()
        mappings = {
            mapped_job_id: session_name
            for mapped_job_id, session_name in mappings.items()
            if mapped_job_id in active_jobs
        }
        used_indices = set()
        for session_name in mappings.values():
            match = SESSION_INDEX_PATTERN.match(session_name)
            if match:
                used_indices.add(int(match.group(1)))
        next_index = 1
        while next_index in used_indices:
            next_index += 1
        session_name = f"{next_index}_{_sanitize_job_name(job_name)}"
        mappings[job_id] = session_name
        _save_mappings_unlocked(mappings)
        return session_name


def save_screen_mapping(job_id: str, screen_name: str) -> None:
    with _locked():
        mappings = _load_mappings_unlocked()
        mappings[job_id] = screen_name
        _save_mappings_unlocked(mappings)


def get_screen_name(job_id: str) -> str:
    with _locked():
        mappings = _load_mappings_unlocked()
        return mappings.get(job_id, "")


def remove_screen_mapping(job_id: str) -> None:
    with _locked():
        mappings = _load_mappings_unlocked()
        if job_id in mappings:
            del mappings[job_id]
            _save_mappings_unlocked(mappings)


def get_active_mapped_screens() -> list[str]:
    with _locked():
        mappings = _load_mappings_unlocked()
        active_jobs = _get_active_job_ids()
        return [session_name for job_id, session_name in mappings.items() if job_id in active_jobs]
