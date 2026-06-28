"""boolback snapshot cache + sbatch build driver (turing-api side).

The boolback endpoints in main.py delegate here. This module is deliberately
torch-free and boolean_backdoor-free: it never imports the CMT package. The
snapshot is produced by an **sbatch job** on a CPU compute node (NOT a login-node
subprocess), so the long-lived API process never runs the heavy CPU/IO/RAM graph
pass and there is no orphaned-builder-on-timeout problem (SLURM owns the job's
lifetime via ``#SBATCH --time``).

Serving is **staleness-tolerant**: GET returns the most RECENT cached snapshot
for a dir (``latest_cache``) — never "building" — so the page always shows data
fast. A periodic sbatch (and an admin Refresh) keep the cache fresh. Cache files
are named with a dir-stable prefix so the latest one is findable regardless of
the tree's current freshness key.

Confinement: every caller-supplied ``dir`` is funnelled through
``resolve_within_root(dir, root=cmt_root())`` pinned to ``$BOOLEAN_BACKDOOR_OUTPUT``.
``submit_build`` invokes ``sbatch`` with an argv list (``shell=False``); a dir name
with shell metacharacters is one (rejected) path, never executed.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

from dirs import resolve_within_root

# The conda env the CMT builder lives in + where it is checked out (overridable).
BUILDER_CONDA_ENV = os.environ.get("BOOLBACK_BUILDER_CONDA_ENV", "boolback")
BUILDER_REPO_DIR = os.environ.get(
    "BOOLBACK_BUILDER_REPO_DIR",
    str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
)
# Built .gz snapshots + per-dir submit markers live here.
CACHE_DIR = Path(
    os.environ.get("BOOLBACK_CACHE_DIR", str(Path.home() / ".cache" / "boolback-snapshots"))
)
# The sbatch wrapper that runs the builder on a compute node (ships beside this file).
BUILD_SBATCH = Path(
    os.environ.get("BOOLBACK_BUILD_SBATCH", str(Path(__file__).resolve().parent / "boolback_build.sbatch"))
)


def cmt_root() -> Path:
    """The pinned artifact-tree root for every snapshot path. Resolved at call
    time (not import) so a patched env var / test override is honored."""
    raw = os.environ.get("BOOLEAN_BACKDOOR_OUTPUT", "")
    if not raw:
        raise RuntimeError("BOOLEAN_BACKDOOR_OUTPUT is not set")
    return Path(raw).resolve()


def resolve_dir(dir_param: str) -> Path:
    """Confine a caller-supplied snapshot dir to ``cmt_root()``. Empty → the root."""
    return resolve_within_root(dir_param or str(cmt_root()), root=cmt_root())


def _dir_hash(resolved: Path) -> str:
    return hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:16]


def _artifacts_dir(resolved: Path) -> Path:
    """The dir whose ``done.json`` descendants define freshness. Mirrors the
    builder: an output root has an ``artifacts/`` child; an artifacts root is used
    as-is. We never import boolean_backdoor to learn this."""
    if resolved.name == "artifacts":
        return resolved
    child = resolved / "artifacts"
    return child if child.exists() else resolved


def newest_done_mtime(resolved: Path) -> int:
    """Newest ``done.json`` mtime (int) under the artifacts tree, 0 when none."""
    newest = 0.0
    base = _artifacts_dir(resolved)
    if base.exists():
        for done in base.glob("**/done.json"):
            try:
                newest = max(newest, done.stat().st_mtime)
            except OSError:
                continue
    return int(newest)


def cache_path(resolved: Path, mtime_key: int) -> Path:
    """The cache file for (dir, freshness-key). Dir-stable PREFIX so ``latest_cache``
    can find the newest snapshot for a dir regardless of the current freshness key."""
    return CACHE_DIR / f"snapshot-{_dir_hash(resolved)}-{mtime_key}.json.gz"


def latest_cache(resolved: Path) -> Path | None:
    """The most recently written cached snapshot for ``resolved`` (any freshness
    key), or None. This is what GET serves — staleness-tolerant, never blocking."""
    if not CACHE_DIR.exists():
        return None
    candidates = list(CACHE_DIR.glob(f"snapshot-{_dir_hash(resolved)}-*.json.gz"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _cache_key_of(path: Path) -> int:
    """The freshness key embedded in a cache filename (``snapshot-<dir>-<key>.json.gz``)."""
    try:
        return int(path.stem.rsplit("-", 1)[-1].replace(".json", ""))
    except (ValueError, IndexError):
        return 0


def status_envelope(resolved: Path) -> dict:
    """The §2 status envelope, staleness-tolerant.

    ``ready`` whenever ANY snapshot for the dir is cached (serving the latest), with
    ``stale`` set iff the tree has changed since it was built; ``empty`` when none has
    been built yet (a periodic / admin build will produce one). NEVER ``building`` —
    the page must not spin on the slow build."""
    current_key = newest_done_mtime(resolved)
    latest = latest_cache(resolved)
    if latest is None:
        return {"status": "empty", "schema_version": 1,
                "meta": {"tree_mtime_key": current_key, "source_dir": str(resolved)}}
    return {
        "status": "ready",
        "schema_version": 1,
        "meta": {
            "tree_mtime_key": current_key,
            "cache_mtime_key": _cache_key_of(latest),
            "built_at": int(latest.stat().st_mtime),
            "stale": _cache_key_of(latest) != current_key,
            "source_dir": str(resolved),
        },
        "blobPath": f"/boolback-snapshot-blob?dir={_quote(str(resolved))}",
    }


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")


# --------------------------------------------------------------------------------------------------
# sbatch build submission (idempotent; runs on a CPU compute node).
# --------------------------------------------------------------------------------------------------


def _marker_path(resolved: Path) -> Path:
    return CACHE_DIR / f"submit-{_dir_hash(resolved)}.jobid"


def _job_active(job_id: str) -> bool:
    """True iff ``job_id`` is still pending/running in the queue (so we don't double-submit)."""
    if not job_id:
        return False
    try:
        out = subprocess.run(
            ["squeue", "-h", "-j", job_id, "-o", "%t"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(out.stdout.strip())


def submit_build(resolved: Path) -> dict:
    """Submit (or coalesce) an sbatch build for ``resolved`` on a CPU compute node.

    Idempotent: if a build job for this dir is already queued/running (tracked via a
    per-dir job-id marker), returns that without resubmitting. The job writes the
    snapshot atomically (temp + rename) to ``cache_path(resolved, current_key)`` so a
    concurrent GET never sees a partial file."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    marker = _marker_path(resolved)
    prev = marker.read_text().strip() if marker.exists() else ""
    if _job_active(prev):
        return {"status": "submitted", "job_id": prev, "coalesced": True}

    out_path = cache_path(resolved, newest_done_mtime(resolved))
    try:
        proc = subprocess.run(
            ["sbatch", "--parsable", str(BUILD_SBATCH), str(resolved), str(out_path)],
            cwd=BUILDER_REPO_DIR, shell=False, capture_output=True, text=True,
            timeout=60, check=True,
        )
    except FileNotFoundError:
        return {"status": "error", "detail": "sbatch not found (SLURM not on PATH)"}
    except subprocess.CalledProcessError as exc:
        return {"status": "error", "detail": (exc.stderr or str(exc)).strip()[:500]}
    except subprocess.SubprocessError as exc:
        return {"status": "error", "detail": str(exc)[:500]}

    job_id = proc.stdout.strip().split(";")[0]
    try:
        marker.write_text(job_id)
    except OSError:
        pass
    return {"status": "submitted", "job_id": job_id, "coalesced": False}
