import os
import re
from pathlib import Path

# /file and /dirs are a convenience for browsing project files. They are confined
# to this root (default: the home dir; override with TURING_FILE_ROOT) so a path
# like ../../etc/passwd or a symlink can't escape it. Reading secrets must go
# through an audited terminal session, never a plain GET — so even inside the
# root we refuse names/dirs that commonly hold credentials.
ALLOWED_FILE_ROOT = Path(os.environ.get("TURING_FILE_ROOT", str(Path.home()))).resolve()
_DENIED_NAME_PATTERNS = [
    re.compile(r"^\.env(\..*)?$", re.IGNORECASE),   # .env, .env.local, ...
    re.compile(r".*\.(pem|key)$", re.IGNORECASE),    # private keys / certs
]
_DENIED_PATH_PARTS = {".ssh", ".aws", ".gnupg"}


class PathNotAllowed(Exception):
    """Raised when a requested path escapes ALLOWED_FILE_ROOT or hits a secret."""


def resolve_within_root(path: str) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = ALLOWED_FILE_ROOT / candidate
    # resolve() collapses '..' and follows symlinks, so neither can escape root.
    resolved = candidate.resolve()
    if resolved != ALLOWED_FILE_ROOT and ALLOWED_FILE_ROOT not in resolved.parents:
        raise PathNotAllowed("Path is outside the allowed root")
    if set(resolved.parts) & _DENIED_PATH_PARTS:
        raise PathNotAllowed("Path is within a restricted directory")
    if any(pattern.search(resolved.name) for pattern in _DENIED_NAME_PATTERNS):
        raise PathNotAllowed("File type is restricted")
    return resolved


def list_directory(path: str) -> dict:
    try:
        p = resolve_within_root(path)
    except PathNotAllowed as exc:
        return {"error": str(exc), "dirs": [], "path": path}
    if not p.exists():
        return {"error": f"Path does not exist: {path}", "dirs": [], "path": str(p)}
    if not p.is_dir():
        return {"error": f"Not a directory: {path}", "dirs": [], "path": str(p)}
    try:
        dirs = [
            item.name
            for item in sorted(p.iterdir())
            if item.is_dir() and not item.name.startswith(".")
        ]
        return {"path": str(p), "dirs": dirs, "error": None}
    except PermissionError:
        return {"error": f"Permission denied: {path}", "dirs": [], "path": str(p)}
    except Exception as e:
        return {"error": str(e), "dirs": [], "path": str(p)}


def get_home_dir() -> str:
    return str(Path.home())
