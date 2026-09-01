"""Readers for the text the cluster's own tools print.

Slurm (`squeue`, `sacct`) and `nvidia-smi` both answer questions they cannot
answer with a placeholder word rather than a blank: `N/A`, `UNLIMITED`,
`[Unknown Error]`. Every reader that turns their output into a number has to
know those words, or it turns "no answer" into a plausible-looking number.

This module is the one place that knowledge lives. `slurm.py` and
`gpu_report.py` both import from here; it imports nothing of theirs, so the
two stay free of each other (slurm.py defers its `gpu_report` import to a
function body for the same reason).
"""

import logging

logger = logging.getLogger("tom.quest.cluster_text")

# Placeholders, compared uppercased. Slurm contributes N/A / NOT_SET /
# UNLIMITED / INVALID; nvidia-smi contributes the bracketed forms, including
# the [Unknown Error] a wedged GPU reports for every field it cannot read.
UNKNOWN_VALUE_TOKENS = {
    "",
    "INVALID",
    "N/A",
    "[N/A]",
    "NOT_SET",
    "UNLIMITED",
    "UNKNOWN",
    "[UNKNOWN]",
    "UNKNOWN ERROR",
    "[UNKNOWN ERROR]",
}


def parse_time_to_seconds(time_str: str) -> int:
    """Seconds from a Slurm duration: `D-HH:MM:SS`, `HH:MM:SS`, `MM:SS`, `SS`.

    A placeholder, or anything else that does not parse, is 0 — the callers
    use the result as an elapsed/limit duration where 0 reads as "unknown",
    and raising would take a whole job list down over one wedged field.
    """
    time_str = time_str.strip()
    if time_str.upper() in UNKNOWN_VALUE_TOKENS:
        return 0
    total_seconds = 0
    try:
        if "-" in time_str:
            days_part, time_part = time_str.split("-", 1)
            total_seconds += int(days_part) * 86400
            time_str = time_part
        parts = time_str.split(":")
        if len(parts) == 3:
            total_seconds += int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            total_seconds += int(parts[0]) * 60 + int(parts[1])
        elif len(parts) == 1:
            total_seconds += int(parts[0])
    except ValueError:
        logger.debug("Ignoring unparseable Slurm time value: %s", time_str)
        return 0
    return total_seconds
