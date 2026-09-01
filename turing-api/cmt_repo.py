"""The one place turing-api learns where the ComplexMultiTrigger checkout is.

Two surfaces submit sbatch jobs into that checkout: the Forge trainer/server
(``forge.py``) and the boolback snapshot builder (``boolback_snapshot.py``). Both
now read the SAME setting, ``BOOLEAN_BACKDOOR_REPO``, through this module.

Until 2026-08-30 they read two different names that defaulted to the same path —
``forge.py`` read ``BOOLEAN_BACKDOOR_REPO`` and ``boolback_snapshot.py`` read
``BOOLBACK_BUILDER_REPO_DIR`` — so setting one and not the other pointed the two
surfaces at different checkouts, which looks like an ordinary build in both cases.
``BOOLBACK_BUILDER_REPO_DIR`` is no longer read by anything: if it is set in
``turing-api/.env``, rename it to ``BOOLEAN_BACKDOOR_REPO``.

DANGER: read the value at CALL time, never into a module-level constant. The .env
is loaded by python-dotenv at process start, and a module-level read also freezes
the value against a test's ``patch.dict("os.environ", ...)``.
"""
from __future__ import annotations

import os
from pathlib import Path

#: The single environment variable naming the CMT checkout.
ENV_VAR = "BOOLEAN_BACKDOOR_REPO"

#: Used when the variable is unset or empty. Resolved at call time so a test that
#: patches HOME gets the patched home.
DEFAULT_SUBPATH = ("booleanbackdoors", "ComplexMultiTrigger")


def cmt_repo_dir() -> Path:
    """The CMT checkout both sbatch-submitting surfaces run against.

    python-dotenv does not expand an UNBRACED ``$HOME`` (only ``${HOME}``), so a
    hand-edited .env line can hand us the four literal characters ``$HOME``. Expand
    both ``$VAR``/``${VAR}`` and a leading ``~`` here, so that a value that reads
    like a path on the operator's screen names a real directory in the process.
    """
    raw = os.environ.get(ENV_VAR, "").strip()
    if not raw:
        return Path.home().joinpath(*DEFAULT_SUBPATH)
    return Path(os.path.expandvars(raw)).expanduser()
