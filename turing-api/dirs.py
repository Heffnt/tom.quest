import re
from pathlib import Path

# The audited confinement primitive for every user-supplied path the API accepts.
# There is deliberately NO default root: each caller names the feature-specific
# jail it wants (the CMT output root in boolback_snapshot.py, the forge root in
# forge.py), so a new endpoint cannot silently inherit a wide one. The former
# $HOME-wide default belonged to the generic /file and /dirs endpoints, which were
# deleted (no tom.quest client called them); re-adding a default would recreate the
# arbitrary-home-read surface their deletion removed.
#
# Confinement is two rules: resolve() collapses '..' and follows symlinks so
# neither escapes the root, and even inside the root we refuse names/dirs that
# commonly hold credentials — reading secrets must go through an audited terminal
# session, never a plain GET.
_DENIED_NAME_PATTERNS = [
    re.compile(r"^\.env(\..*)?$", re.IGNORECASE),   # .env, .env.local, ...
    re.compile(r".*\.(pem|key)$", re.IGNORECASE),    # private keys / certs
]
_DENIED_PATH_PARTS = {".ssh", ".aws", ".gnupg"}


class PathNotAllowed(Exception):
    """Raised when a requested path escapes its root or hits a secret."""


def resolve_within_root(path: str, root: Path) -> Path:
    # A relative path is taken relative to `root`; an absolute path must already
    # be inside it.
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
