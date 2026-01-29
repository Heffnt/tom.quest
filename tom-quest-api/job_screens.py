import json
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
