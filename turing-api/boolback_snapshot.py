"""boolback snapshot cache + builder driver (BUILD STEP 2 — turing-api side).

The three /boolback-snapshot* endpoints in main.py delegate here. This module is
deliberately torch-free and boolean_backdoor-free: it never imports the CMT
package. The snapshot is produced by spawning the CMT builder as a SUBPROCESS in
the conda env (``python -m tom_quest.build``), so the long-lived API process
stays free of the heavy CPU/IO graph code.

Confinement: every caller-supplied ``dir`` is funnelled through
``dirs.resolve_within_root(dir, root=cmt_root())`` where ``cmt_root`` is pinned to
``$BOOLEAN_BACKDOOR_OUTPUT`` (NOT the /file+/dirs $HOME default). The build argv
is a list with ``shell=False`` so a directory name containing shell metacharacters
(``;`` ``$(...)`` backticks) can never execute — it is just a (rejected) path.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import threading
from pathlib import Path

from dirs import PathNotAllowed, resolve_within_root

# The conda env the CMT builder lives in, and where it is checked out. Both are
# overridable so a test / a non-standard deploy can point them elsewhere.
BUILDER_CONDA_ENV = os.environ.get("BOOLBACK_BUILDER_CONDA_ENV", "boolback")
BUILDER_REPO_DIR = os.environ.get(
    "BOOLBACK_BUILDER_REPO_DIR",
    str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger"),
)
# Where built .gz snapshots + per-dir build locks are cached.
CACHE_DIR = Path(
    os.environ.get("BOOLBACK_CACHE_DIR", str(Path.home() / ".cache" / "boolback-snapshots"))
)
# Build subprocess wall-clock cap (a stuck builder must not pin a worker forever).
BUILD_TIMEOUT_S = int(os.environ.get("BOOLBACK_BUILD_TIMEOUT_S", "1800"))


def cmt_root() -> Path:
    """The pinned artifact-tree root for every snapshot path. Resolved at call
    time (not import) so a patched env var / test override is honored."""
    raw = os.environ.get("BOOLEAN_BACKDOOR_OUTPUT", "")
    if not raw:
        raise RuntimeError("BOOLEAN_BACKDOOR_OUTPUT is not set")
    return Path(raw).resolve()


def resolve_dir(dir_param: str) -> Path:
    """Confine a caller-supplied snapshot dir to ``cmt_root()``. Empty → the root
    itself. Raises ``PathNotAllowed`` on a traversal / symlink escape."""
    return resolve_within_root(dir_param or str(cmt_root()), root=cmt_root())


def _artifacts_dir(resolved: Path) -> Path:
    """The dir whose ``done.json`` descendants define freshness. Mirrors the
    builder: an output root has an ``artifacts/`` child; an artifacts root is used
    as-is. We never import boolean_backdoor to learn this."""
    if resolved.name == "artifacts":
        return resolved
    child = resolved / "artifacts"
    return child if child.exists() else resolved


def newest_done_mtime(resolved: Path) -> int:
    """Inline mirror of ``tom_quest.build._newest_done_mtime``: newest ``done.json``
    mtime (int) under the artifacts tree, 0 when none. No CMT import."""
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
    """Stable cache file for (dir, freshness-key). Keyed by a hash of the resolved
    path + mtime so a rebuilt tree gets a fresh file and stale files are ignored."""
    digest = hashlib.sha256(f"{resolved}\x00{mtime_key}".encode("utf-8")).hexdigest()[:24]
    return CACHE_DIR / f"snapshot-{digest}.json.gz"


def _lock_path(resolved: Path) -> Path:
    digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:24]
    return CACHE_DIR / f"build-{digest}.lock"


def build_argv(resolved: Path, out_path: Path) -> list[str]:
    """The injection-safe build command. ``shell=False`` + argv list: a dir name
    with ``;`` / ``$(...)`` / backticks is passed as one literal argument and can
    never be interpreted by a shell."""
    return [
        "conda",
        "run",
        "-n",
        BUILDER_CONDA_ENV,
        "python",
        "-m",
        "tom_quest.build",
        str(resolved),
        str(out_path),
    ]


def build_env() -> dict[str, str]:
    """Environment for the build subprocess. ``-m tom_quest.build`` needs BOTH the
    CMT repo root (for ``boolean_backdoor``) AND its ``tom.quest/`` subdir (for the
    ``tom_quest`` package) on ``PYTHONPATH`` — ``cwd=BUILDER_REPO_DIR`` alone only
    covers the former, so the bare invocation fails with ``No module named
    'tom_quest'``. ``conda run`` inherits this env, so the prepended paths reach the
    builder. Any caller-set PYTHONPATH is preserved (appended)."""
    repo = BUILDER_REPO_DIR
    tq = str(Path(repo) / "tom.quest")
    existing = os.environ.get("PYTHONPATH", "")
    parts = [repo, tq] + ([existing] if existing else [])
    return {**os.environ, "PYTHONPATH": os.pathsep.join(parts)}


def _run_build(resolved: Path, out_path: Path, lock_path: Path) -> None:
    """Body of the daemon build thread: per-dir flock (skip if a build is already
    running for this dir), then the subprocess. Best-effort; errors are surfaced
    on the next GET by the cache file simply not appearing."""
    import logging

    log = logging.getLogger("boolback_snapshot")
    # fcntl is Linux-only (the turing login node). On a platform without it
    # (Windows CI) we proceed lockless — the tests that exercise the lock mock
    # _run_build / subprocess.run, so the missing module never executes here.
    try:
        import fcntl
    except ImportError:  # pragma: no cover - non-Linux
        fcntl = None  # type: ignore[assignment]

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    lock_file = open(lock_path, "w")
    try:
        if fcntl is not None:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                # Another worker already building this dir; let it finish.
                log.info("build already in progress for %s; skipping", resolved)
                return
        try:
            subprocess.run(
                build_argv(resolved, out_path),
                cwd=BUILDER_REPO_DIR,
                env=build_env(),
                shell=False,
                timeout=BUILD_TIMEOUT_S,
                check=True,
            )
        except Exception as exc:  # noqa: BLE001 - logged, surfaced via absent cache
            log.error("snapshot build failed for %s: %s", resolved, exc)
        finally:
            if fcntl is not None:
                try:
                    fcntl.flock(lock_file, fcntl.LOCK_UN)
                except OSError:
                    pass
    finally:
        lock_file.close()


def kick_build(resolved: Path) -> Path:
    """Spawn the build in a DAEMON thread and return immediately with the target
    cache path. NEVER blocks the request thread: the Next proxy's 20s AbortSignal
    makes any in-request build a guaranteed 502."""
    mtime_key = newest_done_mtime(resolved)
    out_path = cache_path(resolved, mtime_key)
    lock_path = _lock_path(resolved)
    thread = threading.Thread(
        target=_run_build,
        args=(resolved, out_path, lock_path),
        daemon=True,
    )
    thread.start()
    return out_path
