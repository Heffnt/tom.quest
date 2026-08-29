"""Filesystem roots, and the one confinement primitive.

Every root the API derives from the environment is read HERE, once, and imported
by the modules that need it. A root read in two places is a root that can hold
two different values: until 2026-08-29 the CMT checkout was read as
BOOLEAN_BACKDOOR_REPO in forge.py and as BOOLBACK_BUILDER_REPO_DIR in
boolback_snapshot.py, so setting one and not the other pointed the two surfaces
at different checkouts with no error. `scripts/check-turing-env.mjs` keeps this
property: it fails if an env name is read at more than one site under
turing-api/, or if a name read there is missing from
secrets/turing-api.env.example.
"""
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

# --- the ComplexMultiTrigger (CMT) roots on the cluster ------------------------
#
# Two roots, one each side of the research repo: where the code is checked out,
# and where its artifact tree is written. Both the boolback snapshot surface and
# the Forge surface run CMT jobs, so both need both — hence one read site here
# rather than one per consumer.

# The CMT repo (boolean_backdoor package root) the sbatch jobs cd into. A string,
# not a Path, because both consumers hand it straight to subprocess (cwd= and an
# sbatch argv element).
CMT_REPO_DIR = os.environ.get(
    "BOOLEAN_BACKDOOR_REPO",
    str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
)


def cmt_output_root() -> Path:
    """$BOOLEAN_BACKDOOR_OUTPUT — the artifact-tree root every served path is
    pinned under. Resolved at call time (not import) so a patched env var / test
    override is honored, and raising rather than defaulting because a wrong
    artifact root serves the wrong campaign's data."""
    raw = os.environ.get("BOOLEAN_BACKDOOR_OUTPUT", "")
    if not raw:
        raise RuntimeError("BOOLEAN_BACKDOOR_OUTPUT is not set")
    return Path(raw).resolve()


class PathNotAllowed(Exception):
    """Raised when a requested path escapes ALLOWED_FILE_ROOT or hits a secret."""


def resolve_within_root(path: str, root: Path | None = None) -> Path:
    # The one audited confinement primitive. `root` defaults to ALLOWED_FILE_ROOT
    # (the /file and /dirs root) but is overridable so other surfaces can confine
    # user-supplied paths to a tighter, project-specific root while
    # sharing the same '..'/symlink-escape and secret-name rejection. A relative
    # path is taken relative to `root`; an absolute path must already be inside it.
    # Resolve the default at call time (not as a default arg) so a patched/updated
    # ALLOWED_FILE_ROOT is honored.
    if root is None:
        root = ALLOWED_FILE_ROOT
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    # resolve() collapses '..' and follows symlinks, so neither can escape root.
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
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
