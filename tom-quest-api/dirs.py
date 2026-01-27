import os
from pathlib import Path

def list_directory(path: str) -> dict:
    try:
        p = Path(path).expanduser().resolve()
        if not p.exists():
            return {"error": f"Path does not exist: {path}", "dirs": [], "path": str(p)}
        if not p.is_dir():
            return {"error": f"Not a directory: {path}", "dirs": [], "path": str(p)}
        dirs = []
        for item in sorted(p.iterdir()):
            if item.is_dir() and not item.name.startswith('.'):
                dirs.append(item.name)
        return {"path": str(p), "dirs": dirs, "error": None}
    except PermissionError:
        return {"error": f"Permission denied: {path}", "dirs": [], "path": path}
    except Exception as e:
        return {"error": str(e), "dirs": [], "path": path}

def get_home_dir() -> str:
    return str(Path.home())
