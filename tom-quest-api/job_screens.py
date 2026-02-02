import json
import subprocess
from pathlib import Path

SCREENS_FILE = Path.home() / ".tom-quest-screens.json"

def _load_mappings() -> dict[str, str]:
    if not SCREENS_FILE.exists():
        return {}
    try:
        return json.loads(SCREENS_FILE.read_text())
    except:
        return {}

def _save_mappings(mappings: dict[str, str]):
    SCREENS_FILE.write_text(json.dumps(mappings))

def _get_active_job_ids() -> set[str]:
    """Get job IDs currently in slurm queue."""
    result = subprocess.run("squeue --me -h -o '%i'", shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        return set()
    return {line.strip() for line in result.stdout.strip().split('\n') if line.strip()}

def save_screen_mapping(job_id: str, screen_name: str):
    mappings = _load_mappings()
    mappings[job_id] = screen_name
    _save_mappings(mappings)

def get_screen_name(job_id: str) -> str:
    mappings = _load_mappings()
    return mappings.get(job_id, "")

def remove_screen_mapping(job_id: str):
    mappings = _load_mappings()
    if job_id in mappings:
        del mappings[job_id]
        _save_mappings(mappings)

def get_active_mapped_screens() -> list[str]:
    """Get session names only for jobs still in the queue."""
    mappings = _load_mappings()
    active_jobs = _get_active_job_ids()
    return [name for job_id, name in mappings.items() if job_id in active_jobs]
