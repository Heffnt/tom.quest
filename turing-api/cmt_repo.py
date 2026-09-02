"""The one CMT checkout this service submits sbatch jobs from.

Two surfaces here run ``sbatch`` with ``cwd`` set to the ComplexMultiTrigger
checkout: the Forge train/serve jobs (``forge.py``) and the boolback snapshot
build (``boolback_snapshot.py``). That is a single directory on the login node,
but until this module existed it was read from two different environment
variables with the same default — ``BOOLEAN_BACKDOOR_REPO`` on the Forge side
and ``BOOLBACK_BUILDER_REPO_DIR`` on the boolback side. Setting one and not the
other made the two surfaces submit from different checkouts while both looked
like ordinary builds.

``BOOLEAN_BACKDOOR_REPO`` is the surviving name. It is the one already declared
in a committed template (``turing-api/forge.env.example``), and it matches the
required ``BOOLEAN_BACKDOOR_OUTPUT`` that names the artifact tree beside it.

``BOOLBACK_BUILDER_REPO_DIR`` is kept as a deprecated alias, read only when the
surviving name is unset, because the ``.env`` on the login node is not in this
repository and may already set it; dropping it outright could silently move the
snapshot build's ``cwd`` back to the default. Remove the alias once the live
``.env`` is known to set the surviving name.

Resolution happens at call time, not import time, so a patched environment (a
test, or a restart-free re-read) is honored.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger("tom.quest.cmt_repo")

CANONICAL_ENV = "BOOLEAN_BACKDOOR_REPO"
DEPRECATED_ENV = "BOOLBACK_BUILDER_REPO_DIR"

# Warn once per process per condition: this is resolved on every submit, and a
# line per sbatch would bury the rest of the log.
_warned: set[str] = set()


def _warn_once(key: str, message: str, *args: object) -> None:
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(message, *args)


def default_repo_dir() -> str:
    """Where the CMT checkout lives when neither name is set."""
    return str(Path.home() / "booleanbackdoors" / "ComplexMultiTrigger")


def cmt_repo_dir() -> str:
    """The CMT checkout every sbatch submission in this service uses as ``cwd``.

    Only variable NAMES are logged, never their values: the whole point of the
    warning is that an operator has to go edit the ``.env``, and the path itself
    adds nothing the operator does not already have in front of them.
    """
    canonical = os.environ.get(CANONICAL_ENV, "").strip()
    alias = os.environ.get(DEPRECATED_ENV, "").strip()

    if canonical:
        if alias and alias != canonical:
            _warn_once(
                "conflict",
                "%s and %s are both set to different paths; using %s and ignoring %s",
                CANONICAL_ENV, DEPRECATED_ENV, CANONICAL_ENV, DEPRECATED_ENV,
            )
        return canonical

    if alias:
        _warn_once(
            "alias",
            "%s is deprecated and will be removed; rename it to %s in turing-api/.env",
            DEPRECATED_ENV, CANONICAL_ENV,
        )
        return alias

    return default_repo_dir()
