"""Tests for the view-spec v4 renderer (``tom_quest.render``).

Two jobs. The SMOKE tests render a spec end to end and assert a non-empty figure — the renderer
exercises the read layer, the metric pivot, per-layer facet/range selection, a GROUP layer's union,
each of the four group-plot facet kinds, ghosts, a ±1 SD band and an OLS trend without raising. The
CONTRACT tests pin the four places where the pre-2026-07-08 (v3) renderer silently disagreed with the
browser, so a regression is a failure and not a quietly different figure:

  1. a non-v4 spec is REJECTED (v3 rendered as a layerless, unfiltered plot);
  2. per-layer ``facets`` actually select (v3 had no layers, so every layer's selection was ignored);
  3. a GROUP layer is the UNION of its members;
  4. ``compute_bin_edges`` matches ``app/boolback/lib/bins.ts`` (including TIED values, where the
     old ``np.unique(np.quantile(...))`` collapsed edges and changed the bucket count).

matplotlib is a tom_quest (display-layer) dependency; the smoke tests skip if it is not installed.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
import pytest

from tom_quest import render

matplotlib = pytest.importorskip("matplotlib")


def _fixture_tidy(tmp_path: Path) -> Path:
    """A tiny long-form tidy: two functions × two base_models.

    Each RUN carries both an ``asr`` row and an ``avg_sensitivity`` row under the SAME identity
    columns, so the pivot lands both metrics on one row and an ``avg_sensitivity`` vs ``asr`` plot
    actually has points. (A function-level-only row — epoch null, no model — is kept alongside so the
    null-drop still has something to drop; a fixture with ONLY that row silently rendered an empty
    figure, which a non-empty-file assertion cannot catch.)"""
    rows: list[dict[str, Any]] = []
    for fi, (tt, sens) in enumerate([("0001", 0.4), ("0111", 0.8)]):
        # function-level complexity metric row (epoch null) — pivots to its own, axis-incomplete row.
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
            # the function's complexity broadcast onto the run, so both axes exist on one row
            rows.append({**identity, "metric_name": "avg_sensitivity", "value": sens})
    p = tmp_path / "tidy.parquet"
    pl.DataFrame(rows, infer_schema_length=None).write_parquet(p)
    return p


# --------------------------------------------------------------------------------------------------
# Smoke: every v4 surface renders.
# --------------------------------------------------------------------------------------------------


def test_render_layered_spec_writes_nonempty(tmp_path: Path) -> None:
    """Two plain layers with their own facets + ranges, plus plot-level style and overlays."""
    tidy = _fixture_tidy(tmp_path)
    spec = {
        "v": 4, "view": "plot",
        "x": "arity", "y": "asr",
        "layers": [
            {"name": "llama", "color": "#e8a040", "facets": {"base_model": ["Llama-3.2-1B"]}},
            {"name": "qwen", "color": "#38bdf8", "style": {"shape": 1, "dash": 1},
             "facets": {"base_model": ["Qwen-0.5B"]}},
        ],
        "ranges": [{"metric": "asr", "min": 0.0, "max": 1.0}],
        "size": 1.4, "opacity": 0.8,
        "band": True, "ghosts": True, "trend": True,
    }
    out = tmp_path / "fig.pdf"
    render.render_spec(spec, tidy, out)
    assert out.exists() and out.stat().st_size > 0


def test_render_default_spec_writes_nonempty(tmp_path: Path) -> None:
    """The tiniest spec a default view serializes to: no layers, no axes, no toggles.

    Everything comes from the DEFAULT_PLOT mirror — including the implicit single "all runs" layer.
    x defaults to "epoch" and y to "plantedness"; this fixture has no plantedness, so the axis
    override is explicit while the rest stays defaulted."""
    tidy = _fixture_tidy(tmp_path)
    out = tmp_path / "default.png"
    render.render_spec({"v": 4, "view": "plot", "x": "arity", "y": "asr"}, tidy, out)
    assert out.exists() and out.stat().st_size > 0


@pytest.mark.parametrize("facet", [
    {"kind": "layer"},
    {"kind": "param", "key": "trigger_form"},
    {"kind": "grid", "row": "trigger_form", "col": "base_model"},
    {"kind": "bins", "metric": "avg_sensitivity", "n": 2, "mode": "quantile"},
])
def test_render_each_groupplot_facet_kind(tmp_path: Path, facet: dict[str, Any]) -> None:
    """All four v4 facet kinds cut panels and render. v3 read `facet` as a bare column name, so every
    one of these objects fell through its `facet in df.columns` test and drew a single panel."""
    tidy = _fixture_tidy(tmp_path)
    spec = {
        "v": 4, "view": "groupplot", "x": "avg_sensitivity", "y": "asr",
        "layers": [{"name": "all", "color": "#e8a040"}],
        "facet": facet, "band": False, "ghosts": False, "trend": False,
    }
    out = tmp_path / f"{facet['kind']}.png"
    render.render_spec(spec, tidy, out)
    assert out.exists() and out.stat().st_size > 0


def test_render_table_spec_with_v4_sorts(tmp_path: Path) -> None:
    """A table spec: top-level `filters`, dotted `columns`, and `{col, dir}` sorts."""
    tidy = _fixture_tidy(tmp_path)
    spec = {
        "v": 4, "view": "table",
        "filters": {"base_model": ["Llama-3.2-1B"]},
        "columns": ["function.truth_table", "training.base_model", "asr"],
        "sorts": [{"col": "asr", "dir": "desc"}],
    }
    out = tmp_path / "table.png"
    render.render_spec(spec, tidy, out)
    assert out.exists() and out.stat().st_size > 0


def _figure_report(spec: dict[str, Any], tidy: Path, out: Path) -> list[dict[str, Any]]:
    """Render, then read the FIGURE back: ``[{title, series: [{label, points}]}, …]``.

    A "the file is non-empty" assertion passes on a figure with no points in it, which is exactly how
    an axis pairing that the pivot cannot satisfy stays invisible. This inspects the drawn artists."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.close("all")
    keep = plt.close
    plt.close = lambda *a, **k: None  # hold the figure open for inspection
    try:
        render.render_spec(spec, tidy, out)
        fig = plt.figure(plt.get_fignums()[-1])
        panels = []
        for ax in fig.axes:
            if not ax.collections and not ax.lines:
                continue
            panels.append({
                "title": ax.get_title(),
                "series": [
                    {"label": c.get_label(), "points": int(np.asarray(c.get_offsets()).shape[0])}
                    for c in ax.collections if not c.get_label().startswith("_")
                ],
            })
        return panels
    finally:
        plt.close = keep
        plt.close("all")


def test_groupplot_figure_has_one_panel_per_facet_value_and_one_series_per_layer(
    tmp_path: Path,
) -> None:
    """The whole v4 reshape, read off the rendered figure rather than the file size.

    Two layers (one a GROUP) and a ``{kind: param}`` facet over ``trigger_form`` must produce one
    panel per trigger_form value, each carrying one labelled series per layer, each series holding
    only the rows ITS layer selects. The v3 renderer drew one panel with one unlabelled scatter over
    every row: no facet object support, no layers, no per-layer selection."""
    tidy = _fixture_tidy(tmp_path)
    spec = {
        "v": 4, "view": "groupplot", "x": "avg_sensitivity", "y": "asr",
        "layers": [
            {"name": "llama", "color": "#e8a040", "facets": {"base_model": ["Llama-3.2-1B"]}},
            {"name": "pooled", "color": "#38bdf8", "style": {"shape": 1, "dash": 1},
             "members": [
                 {"name": "insertion", "facets": {"trigger_form": ["insertion"]}},
                 {"name": "qwen", "facets": {"base_model": ["Qwen-0.5B"]}},
             ]},
        ],
        "facet": {"kind": "param", "key": "trigger_form"},
        "band": False, "ghosts": False, "trend": False,
    }
    panels = _figure_report(spec, tidy, tmp_path / "grouped.png")

    # 4 runs: (f0,llama,insertion) (f0,qwen,insertion) (f1,llama,affix) (f1,qwen,affix).
    assert [p["title"] for p in panels] == [
        "trigger_form = insertion", "trigger_form = affix",
    ]
    assert [[s["label"] for s in p["series"]] for p in panels] == [
        ["llama", "pooled"], ["llama", "pooled"],
    ]
    counts = {p["title"]: {s["label"]: s["points"] for s in p["series"]} for p in panels}
    # insertion panel: llama selects 1 run; pooled = insertion(2) ∪ qwen(1 here) = both runs.
    assert counts["trigger_form = insertion"] == {"llama": 1, "pooled": 2}
    # affix panel: llama selects 1 run; pooled = insertion(0 here) ∪ qwen(1) = 1 run.
    assert counts["trigger_form = affix"] == {"llama": 1, "pooled": 1}


def test_render_color_by_single_layer(tmp_path: Path) -> None:
    """`color_by` draws the continuous colormap + colorbar when there is exactly one layer."""
    tidy = _fixture_tidy(tmp_path)
    spec = {
        "v": 4, "view": "plot", "x": "avg_sensitivity", "y": "asr",
        "color_by": "avg_sensitivity", "band": False, "ghosts": False, "trend": False,
    }
    out = tmp_path / "colorby.png"
    render.render_spec(spec, tidy, out)
    assert out.exists() and out.stat().st_size > 0


# --------------------------------------------------------------------------------------------------
# Contract: the four places the v3 renderer silently disagreed with the browser.
# --------------------------------------------------------------------------------------------------


def test_non_v4_spec_is_rejected(tmp_path: Path) -> None:
    """A v3 spec RAISES instead of rendering.

    parseSpec (spec.ts) hard-rejects `v !== 4`; the v3 renderer had no version gate at all, so a v4
    spec pasted into it drew an unfiltered, layerless plot that LOOKED like a real figure."""
    tidy = _fixture_tidy(tmp_path)
    v3 = {"v": 3, "view": "plot", "x": "arity", "y": "asr",
          "split": [{"param": "base_model", "channel": "color"}], "facet": "trigger_form"}
    with pytest.raises(ValueError, match="v4"):
        render.render_spec(v3, tidy, tmp_path / "nope.png")


def test_layer_facets_actually_select() -> None:
    """A layer's own `facets` narrow that layer's rows — the whole point of the v4 reshape."""
    df = pl.DataFrame({"base_model": ["a", "a", "b"], "asr": [0.1, 0.2, 0.3]})
    mask = render._layer_mask(df, {"name": "only-a", "facets": {"base_model": ["a"]}})
    assert mask.to_list() == [True, True, False]


def test_layer_ranges_and_facets_are_anded() -> None:
    """A plain layer ANDs its facets with its ranges (and a null in a ranged column drops the row)."""
    df = pl.DataFrame({"base_model": ["a", "a", "b"], "asr": [0.1, 0.9, 0.9]})
    mask = render._layer_mask(df, {
        "name": "a-and-high", "facets": {"base_model": ["a"]},
        "ranges": [{"metric": "asr", "min": 0.5, "max": 1.0}],
    })
    assert mask.to_list() == [False, True, False]


def test_group_layer_is_the_union_of_its_members() -> None:
    """A GROUP layer draws the UNION of its members and ignores its own (empty) facets/ranges.

    A row matched by BOTH members appears once: the mask is a row selector over one frame, which is
    the "deduped by run identity" rule for a tidy frame whose row IS one run/point."""
    df = pl.DataFrame({"base_model": ["a", "b", "c"], "trigger_form": ["x", "x", "y"]})
    mask = render._layer_mask(df, {
        "name": "pooled", "color": "#38bdf8",
        "members": [
            {"name": "m1", "facets": {"base_model": ["a"]}},
            {"name": "m2", "facets": {"trigger_form": ["x"]}},  # also matches row 0
        ],
    })
    assert mask.to_list() == [True, True, False]
    assert mask.sum() == 2  # row 0 matched twice, counted once


def test_absent_layers_means_one_unfiltered_layer() -> None:
    """An omitted `layers` is the pristine default single "all runs" layer, not "no layers"."""
    layers = render._layers({"v": 4, "view": "plot"})
    assert [l["name"] for l in layers] == ["all runs"]
    assert layers[0]["color"] == "#e8a040"  # CATEGORY_PALETTE[0]


def test_bin_edges_match_the_browser_on_ties() -> None:
    """`compute_bin_edges` keeps DUPLICATE edges, as bins.ts computeBinEdges does.

    The old renderer ran `np.unique(np.quantile(...))`, which collapsed tied edges: a 4-bucket
    request over a tied distribution silently became fewer buckets with different labels."""
    values = np.array([0.0, 0.0, 0.0, 1.0])
    edges = render.compute_bin_edges(values, 4, "quantile")
    assert len(edges) == 5  # n+1 boundaries for n=4, ties and all
    assert edges[0] == 0.0 and edges[-1] == 1.0
    assert edges[1] == 0.0  # the tied edge SURVIVES


def test_bin_edges_width_mode_is_equal_width() -> None:
    edges = render.compute_bin_edges(np.array([0.0, 1.0, 2.0, 3.0, 4.0]), 4, "width")
    assert edges == [0.0, 1.0, 2.0, 3.0, 4.0]


def test_bin_count_is_clamped_to_one_through_eight() -> None:
    """clampBinCount: 1..8, and a non-finite request falls back to 2."""
    assert len(render.compute_bin_edges(np.array([0.0, 1.0]), 99, "width")) == 9   # clamped to 8
    assert len(render.compute_bin_edges(np.array([0.0, 1.0]), 0, "width")) == 2    # clamped to 1
    assert len(render.compute_bin_edges(np.array([0.0, 1.0]), "x", "width")) == 3  # default 2


def test_bucket_of_matches_bucket_semantics() -> None:
    """bucketOf: [e_i, e_i+1) with the last bucket closed on the right; out-of-range clamps."""
    edges = [0.0, 1.0, 2.0]
    assert render.bucket_of(-5.0, edges) == 0
    assert render.bucket_of(0.5, edges) == 0
    assert render.bucket_of(1.0, edges) == 1
    assert render.bucket_of(2.0, edges) == 1
    assert render.bucket_of(99.0, edges) == 1


def test_dotted_table_column_ids_bridge_to_tidy_names() -> None:
    """Browser table column ids are dotted; the tidy frame names them bare."""
    df = pl.DataFrame({"asr": [0.1], "base_model": ["a"]})
    assert render._tidy_col(df, "headline.asr") == "asr"
    assert render._tidy_col(df, "training.base_model") == "base_model"
    assert render._tidy_col(df, "asr") == "asr"
    assert render._tidy_col(df, "headline.nope") is None


def test_layer_style_maps_shape_and_dash_channels() -> None:
    """shape/dash indices mirror styling.ts + glyph.tsx and cycle, never raise."""
    assert render._layer_style({"name": "d"}) == ("o", "-")
    assert render._layer_style({"name": "s", "style": {"shape": 1}})[0] == "s"
    assert render._layer_style({"name": "c", "style": {"shape": 6}})[0] == "o"  # SHAPE_COUNT wrap
    assert render._layer_style({"name": "x", "style": {"dash": 1}})[1] == (0, (6, 3))


def test_spec_metric_refs_reach_layer_and_facet_metrics() -> None:
    """Every place v4 can name a metric is collected, so the pivot brings all of them in.

    v3 read only x/y/color_by and the TOP-LEVEL ranges, so a metric named only inside a layer's
    ranges, a group member's ranges, or a bins facet never got pivoted — its filter matched nothing
    and its panels collapsed, with no error."""
    refs = set(render._spec_metric_refs({
        "v": 4, "view": "groupplot", "x": "a", "y": "b", "color_by": "c",
        "ranges": [{"metric": "top", "min": 0, "max": 1}],
        "layers": [
            {"name": "l", "ranges": [{"metric": "in_layer", "min": 0, "max": 1}]},
            {"name": "g", "members": [{"name": "m", "ranges": [{"metric": "in_member", "min": 0, "max": 1}]}]},
        ],
        "facet": {"kind": "bins", "metric": "in_facet", "n": 2, "mode": "quantile"},
    }))
    assert {"a", "b", "c", "top", "in_layer", "in_member", "in_facet"} <= refs
