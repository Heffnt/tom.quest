"""Render ONE real dashboard spec through the CMT figure path and report what the figure contains.

This is the confirmation step for the view-spec v4 sync: it takes a spec emitted by tom.quest's own
``configToSpec`` + ``serializeSpec`` (so the JSON is the browser's, not hand-written), renders it with
``tom_quest.render``, and prints the FIGURE'S OWN structure — panel titles, per-panel series labels,
and per-series plotted-point counts — so "the figure matches v4" is a checkable statement rather than
"a non-empty file appeared".

Run both renderers against the same spec to see the difference::

    PYTHONPATH=".:./tom.quest" python tom.quest/tom_quest/confirm_v4_render.py \\
        --spec dashboard-spec.json --tidy /tmp/tidy.parquet --out /tmp/fig.png

The v3 renderer, given this same spec, draws ONE panel (a ``{kind: param}`` facet object is not a
column name, so its ``facet in df.columns`` test fails) with NO series (``split`` is absent, so it
falls through to a single unlabelled scatter) over ALL rows (``layers`` is a field it never reads).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl


def _fixture_tidy(path: Path) -> Path:
    """The same tiny long-form tidy the render tests use: two functions × two base_models."""
    rows: list[dict[str, Any]] = []
    for fi, (tt, sens) in enumerate([("0001", 0.4), ("0111", 0.8)]):
        rows.append({
            "function_hash": f"f{fi}", "dataset_hash": "-", "training_hash": "-",
            "truth_table": tt, "arity": 2, "base_model": "-", "trigger_form": "-",
            "epoch": None, "seed": "-", "tt_row": "-", "metric_name": "avg_sensitivity",
            "value": sens,
        })
        for mi, model in enumerate(["Llama-3.2-1B", "Qwen-0.5B"]):
            identity = {
                "function_hash": f"f{fi}", "dataset_hash": f"d{mi}", "training_hash": f"t{fi}{mi}",
                "truth_table": tt, "arity": 2, "base_model": model,
                "trigger_form": "insertion" if fi == 0 else "affix",
                "epoch": 2, "seed": "0/0/0", "tt_row": "-",
            }
            rows.append({**identity, "metric_name": "asr", "value": 0.5 + 0.1 * fi + 0.05 * mi})
            rows.append({**identity, "metric_name": "avg_sensitivity", "value": sens})
    pl.DataFrame(rows, infer_schema_length=None).write_parquet(path)
    return path


def describe(fig) -> dict[str, Any]:
    """Panel titles + per-panel labelled series and their plotted-point counts, read off the figure."""
    panels = []
    for ax in fig.axes:
        if not ax.get_visible() or (not ax.collections and not ax.lines):
            continue
        series = []
        for coll in ax.collections:
            label = coll.get_label()
            if label.startswith("_"):
                continue  # ghosts / bands are unlabelled artists
            offsets = np.asarray(coll.get_offsets())
            series.append({"label": label, "points": int(offsets.shape[0])})
        panels.append({"title": ax.get_title(), "series": series})
    return {"panels": len(panels), "detail": panels}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", type=Path, required=True)
    ap.add_argument("--tidy", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    if not args.tidy.exists():
        _fixture_tidy(args.tidy)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from tom_quest import render

    plt.close("all")
    keep = plt.close
    plt.close = lambda *a, **k: None  # hold the figure open so it can be inspected
    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
        out = render.render_spec(spec, args.tidy, args.out)
        figs = [plt.figure(n) for n in plt.get_fignums()]
        report = describe(figs[-1]) if figs else {"panels": 0, "detail": []}
    finally:
        plt.close = keep

    report["file"] = str(out)
    report["bytes"] = out.stat().st_size
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
