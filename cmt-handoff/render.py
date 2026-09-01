"""View-spec v4 → paper-quality matplotlib figure.

``python -m tom_quest.render <spec.json> -o <out.pdf>``

The ONLY plotting that survives in the CMT-adjacent code: ``cmt.analysis`` shed ``plots.py`` /
``digest.py`` entirely (all figures now come from a saved view-spec), and this renderer lives in the
tom_quest DISPLAY package — never under ``cmt/`` — so the CMT analysis layer stays matplotlib-free.

The view-spec is the SAME JSON the browser copy/pastes and Convex presets store. Its definition is
``app/boolback/lib/spec.ts`` in the tom.quest repo; this module is its second consumer and must
track it field for field. Shape (v4)::

    { "v": 4, "view": "plot|groupplot|table",
      "x": "avg_sensitivity", "y": "asr", "log": ["x"],
      "layers": [ {"name": "sst2", "color": "#e8a040", "style": {"shape": 1, "dash": 0},
                   "facets": {"dataset": ["sst2"]},
                   "ranges": [{"metric": "plantedness", "min": 0.9, "max": 1}]},
                  {"name": "pooled", "color": "#38bdf8",
                   "members": [{"name": "a", "facets": {}}, {"name": "b", "facets": {}}]} ],
      "ranges": [{"metric": "plantedness", "min": 0.9, "max": 1}],
      "color_by": null,
      "facet": {"kind": "param", "key": "trigger_form"},
      "size": 1, "opacity": 1, "band": true, "ghosts": true, "trend": false,
      "filters": {"base_model": ["Llama-3.2-1B"]},
      "columns": ["headline.asr"], "sorts": [{"col": "headline.asr", "dir": "desc"}] }

The v3→v4 reshape this module tracks (the browser landed it 2026-07-08):

* ``layers`` REPLACED ``split``. A LAYER is one saved selection across all parameters and draws as
  exactly ONE series; several traces come from several layers, never from an in-layer split. A layer
  carries its own ``facets`` (equality) and ``ranges`` (numeric). A GROUP layer carries ``members``
  (exactly one level deep) and draws the UNION of its members' rows, deduped by run identity, under
  the group's own name/color/style.
* Top-level ``filters`` is TABLE-ONLY. On a plot/groupplot the equality selections live per layer.
* Top-level ``ranges`` is PLOT-LEVEL and ANDs onto every layer on top of that layer's own ranges.
* ``facet`` became a GROUP-PLOT-ONLY OBJECT — ``{kind: layer | param | grid | bins}`` — where v3
  had a bare facet-column string.
* ``size`` / ``opacity`` (plot-level style multipliers) and per-layer ``style`` (shape + dash) are
  new; a layer's ``color`` is a first-class field, not a palette position.
* ``sorts`` entries are ``{col, dir: "asc"|"desc"}``; v3 read ``{key, desc}``.
* ``color_by`` is honored ONLY when there is exactly one layer (``PlotConfig.colorBy``'s contract).
* Omitted fields take the browser's DEFAULT_PLOT values (``app/boolback/lib/types.ts``), which this
  module mirrors below — a spec omits defaults, so a renderer that defaults differently silently
  draws a different figure than the dashboard did.
* ``v`` is REQUIRED and must be 4: ``parseSpec`` hard-rejects any other version (no back-compat), so
  this renderer rejects too rather than misreading a v3 spec as a layerless, unfiltered plot.

The renderer reuses the tidy READ layer (``cmt.analysis.friendly.with_friendly_names`` + polars): the
spec names TIDY columns (the snake_case unification), and ``x`` / ``y`` / ``color_by`` /
``ranges[].metric`` may name either a tidy column (a parameter/facet) OR a long-form ``metric_name``
(pivoted to a column here). Browser TABLE column ids are dotted (``headline.asr``); :func:`_tidy_col`
bridges those to their bare tidy names. matplotlib is imported LAZILY inside :func:`_pyplot` (as the
deleted ``plots.py`` did) so importing this module is cheap and CMT stays matplotlib-free.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

SPEC_VERSION = 4

# Columns that are per-measurement, NOT part of a run/point identity: dropped from the pivot index so
# each metric collapses onto one point (per-presence-row metrics are mean-aggregated).
_NON_IDENTITY_COLS = frozenset(
    {"metric_name", "value", "tt_row", "layer", "role", "null_control"}
)
_GHOST_KW = {"alpha": 0.12, "s": 8, "linewidths": 0, "zorder": 1}
_MAX_PANELS = 24  # a small-multiples cap (a facet over a high-cardinality key stays printable)

# ---- Mirrors of the browser's visual encoding (app/boolback/lib/styling.ts, components/glyph.tsx).
# Kept as literals, not derived: the figure must match what the dashboard drew, so these change only
# when styling.ts changes.
_CATEGORY_PALETTE = [
    "#e8a040", "#38bdf8", "#4ade80", "#e879f9",
    "#f87171", "#facc15", "#2dd4bf", "#a78bfa",
    "#fb7185", "#a3e635", "#22d3ee", "#f472b6",
    "#94a3b8", "#c9b35f", "#6fb6a6", "#b48ad6",
    "#fca5a5", "#86efac", "#7dd3fc", "#f0abfc",
]
# glyph.tsx shape cycle: 0 circle, 1 square, 2 triangle-up, 3 diamond, 4 triangle-down, 5 x-cross.
_SHAPE_MARKERS = ["o", "s", "^", "D", "v", "x"]
# styling.ts DASH_PATTERNS as SVG stroke-dasharray -> the matplotlib linestyle equivalents.
_DASH_STYLES: list[Any] = ["-", (0, (6, 3)), (0, (2, 3)), (0, (8, 3, 2, 3))]

# ---- Mirrors of DEFAULT_PLOT (app/boolback/lib/types.ts). A spec OMITS default fields, so these are
# what an absent field means. xDomain/yDomain and layer ids are display-only and never serialized.
_DEFAULT_X = "epoch"
_DEFAULT_Y = "plantedness"
_DEFAULT_SIZE = 1.0
_DEFAULT_OPACITY = 1.0
_DEFAULT_BAND = True
_DEFAULT_GHOSTS = True
_DEFAULT_TREND = False
_DEFAULT_LAYER_NAME = "all runs"
_DEFAULT_LAYER_COLOR = _CATEGORY_PALETTE[0]


def _pyplot():
    """Lazily import matplotlib with the headless Agg backend (as ``plots.py`` did with ``_pyplot``).

    Kept local so importing ``tom_quest.render`` costs nothing until a figure is actually rendered,
    and so ``cmt.*`` never transitively imports matplotlib (the analysis layer is matplotlib-free)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    return plt


# --------------------------------------------------------------------------------------------------
# Spec access: version gate, defaults, layers, and the dotted-column bridge.
# --------------------------------------------------------------------------------------------------


def require_v4(spec: dict[str, Any]) -> None:
    """Reject any spec that is not v4.

    ``parseSpec`` (spec.ts) returns null for ``v !== 4`` by design — there is NO back-compat chain.
    Rendering fails the same way rather than reading a v3 spec as a layerless, unfiltered plot with a
    facet string it silently ignores (which is exactly what the pre-v4 renderer did)."""
    v = spec.get("v")
    if v != SPEC_VERSION:
        raise ValueError(
            f"view-spec version {v!r} is not supported: this renderer reads v{SPEC_VERSION} only "
            f"(app/boolback/lib/spec.ts parseSpec rejects every other version too — re-copy the "
            f"spec from the dashboard)"
        )


def _tidy_col(df: pl.DataFrame, col: Any) -> str | None:
    """The tidy column a spec column id names, or None.

    Plot axes and ranges name metric_schema/tidy names directly (``asr``, ``avg_sensitivity``).
    TABLE ``columns``/``sorts`` carry the browser's INTERNAL dotted ids (``headline.asr``,
    ``function.arity``, ``dataset.dataset``), whose last segment is the tidy name."""
    if not isinstance(col, str):
        return None
    if col in df.columns:
        return col
    if "." in col:
        tail = col.rsplit(".", 1)[1]
        if tail in df.columns:
            return tail
    return None


def _layers(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """The spec's layers, or the implicit default single unfiltered "all runs" layer.

    ``layersToSpec`` omits the layers list entirely when it IS the pristine default, so an absent
    ``layers`` means one unfiltered layer — NOT "no layers" and NOT "no filtering intended"."""
    raw = spec.get("layers")
    if not isinstance(raw, list) or not raw:
        return [{"name": _DEFAULT_LAYER_NAME, "color": _DEFAULT_LAYER_COLOR}]
    out: list[dict[str, Any]] = []
    for i, layer in enumerate(raw):
        if not isinstance(layer, dict) or not isinstance(layer.get("name"), str):
            continue
        entry = dict(layer)
        # Color is written by the browser for every layer; palette-cycle by ordinal if it is absent.
        if not isinstance(entry.get("color"), str):
            entry["color"] = _CATEGORY_PALETTE[i % len(_CATEGORY_PALETTE)]
        out.append(entry)
    return out or [{"name": _DEFAULT_LAYER_NAME, "color": _DEFAULT_LAYER_COLOR}]


def _layer_style(layer: dict[str, Any]) -> tuple[str, Any]:
    """``(marker, linestyle)`` for a layer's ``style`` (both channels default to index 0)."""
    style = layer.get("style") if isinstance(layer.get("style"), dict) else {}
    shape = style.get("shape", 0)
    dash = style.get("dash", 0)
    shape = int(shape) if isinstance(shape, (int, float)) else 0
    dash = int(dash) if isinstance(dash, (int, float)) else 0
    return _SHAPE_MARKERS[shape % len(_SHAPE_MARKERS)], _DASH_STYLES[dash % len(_DASH_STYLES)]


# --------------------------------------------------------------------------------------------------
# Tidy read + reshape.
# --------------------------------------------------------------------------------------------------


def _load_tidy(tidy_path: Path) -> pl.DataFrame:
    """Read ``tidy.parquet`` and add the friendly short-name columns (the one read layer)."""
    from cmt.analysis.friendly import with_friendly_names
    return with_friendly_names(pl.read_parquet(tidy_path))


def _spec_metric_refs(spec: dict[str, Any]) -> list[str]:
    """Every metric/column name the spec references, from EVERY place v4 can put one.

    v3 looked only at ``x``/``y``/``color_by`` and top-level ``ranges``. v4 also carries ranges
    inside each layer (and inside a GROUP's members) and a metric on a ``bins`` facet; a reference
    missed here never gets pivoted in, so its filter/panel silently matches nothing."""
    refs: list[str] = []
    for key in ("x", "y", "color_by"):
        v = spec.get(key)
        if isinstance(v, str):
            refs.append(v)

    def collect_ranges(ranges: Any) -> None:
        if isinstance(ranges, list):
            for r in ranges:
                if isinstance(r, dict) and isinstance(r.get("metric"), str):
                    refs.append(r["metric"])

    collect_ranges(spec.get("ranges"))
    for layer in _layers(spec):
        collect_ranges(layer.get("ranges"))
        for member in layer.get("members") or []:
            if isinstance(member, dict):
                collect_ranges(member.get("ranges"))
    facet = spec.get("facet")
    if isinstance(facet, dict) and facet.get("kind") == "bins" and isinstance(facet.get("metric"), str):
        refs.append(facet["metric"])
    return refs


def _needed_metrics(df: pl.DataFrame, spec: dict[str, Any]) -> list[str]:
    """The referenced value-names that are NOT already tidy columns (⇒ must be pivoted in)."""
    cols = set(df.columns)
    seen: set[str] = set()
    out: list[str] = []
    for r in _spec_metric_refs(spec):
        if r not in cols and r not in seen:
            out.append(r)
            seen.add(r)
    return out


def _widen(df: pl.DataFrame, metric_names: list[str]) -> pl.DataFrame:
    """Pivot the needed long-form ``metric_name`` values into their own columns, one row per point.

    The pivot index is every identity/parameter column (all columns bar :data:`_NON_IDENTITY_COLS`),
    so each run/point is one row and a metric measured per-presence-row is mean-aggregated onto it.
    A metric that never appears leaves no column (the caller's null-drop then removes those points).
    """
    if not metric_names:
        return df
    sub = df.filter(pl.col("metric_name").is_in(metric_names))
    if sub.height == 0:
        # No such metric present — return df unchanged; downstream null-drop handles the empty axis.
        return df
    index_cols = [c for c in df.columns if c not in _NON_IDENTITY_COLS]
    wide = sub.pivot(
        values="value", index=index_cols, on="metric_name", aggregate_function="mean"
    )
    return wide


def _coerce_numeric(series: pl.Series) -> tuple[np.ndarray, list[str] | None]:
    """A numeric array for an axis column. A non-numeric (categorical) column becomes integer
    positions with a returned tick-label list (discrete positions the caller jitters)."""
    if series.dtype.is_numeric():
        return series.to_numpy().astype(float), None
    cats = [c for c in series.unique(maintain_order=True).to_list() if c is not None]
    cats = [str(c) for c in cats]
    code = {c: i for i, c in enumerate(cats)}
    vals = np.array([code.get(str(v), np.nan) if v is not None else np.nan
                     for v in series.to_list()], dtype=float)
    return vals, cats


# --------------------------------------------------------------------------------------------------
# Selection: facets (equality), ranges (numeric), layers, and the GROUP union.
# --------------------------------------------------------------------------------------------------


def _all_true(df: pl.DataFrame) -> pl.Series:
    return pl.Series([True] * df.height, dtype=pl.Boolean)


def _all_false(df: pl.DataFrame) -> pl.Series:
    return pl.Series([False] * df.height, dtype=pl.Boolean)


def _facet_mask(df: pl.DataFrame, facets: Any) -> pl.Series:
    """Equality selections: a row is kept when EVERY named column's value is in its allowed list.

    This is the v4 per-layer ``facets`` object (and the table's top-level ``filters``): facet keys are
    CMT tidy snake_case, values compared as strings (the browser stringifies numeric facets)."""
    mask = _all_true(df)
    if not isinstance(facets, dict):
        return mask
    for col, allowed in facets.items():
        if col not in df.columns or not isinstance(allowed, list) or not allowed:
            continue
        hit = df.get_column(col).cast(pl.Utf8).is_in([str(a) for a in allowed])
        mask = mask & hit.fill_null(False)
    return mask


def _range_mask(df: pl.DataFrame, ranges: Any) -> pl.Series:
    """Numeric range selections (``min <= v <= max``), ANDed.

    A range on an absent column is ignored (the metric never landed in the pivot). A null value in a
    present column drops the row, as the browser's numeric filter does."""
    mask = _all_true(df)
    if not isinstance(ranges, list):
        return mask
    for r in ranges:
        if not isinstance(r, dict):
            continue
        col = r.get("metric")
        if not isinstance(col, str) or col not in df.columns:
            continue
        if r.get("min") is not None:
            mask = mask & (df.get_column(col) >= float(r["min"])).fill_null(False)
        if r.get("max") is not None:
            mask = mask & (df.get_column(col) <= float(r["max"])).fill_null(False)
    return mask


def _layer_mask(df: pl.DataFrame, layer: dict[str, Any]) -> pl.Series:
    """The rows one layer selects.

    A PLAIN layer ANDs its ``facets`` and its ``ranges``. A GROUP layer (``members`` present) ignores
    its own facets/ranges — the sanitizer forces them empty — and takes the UNION (OR) of its member
    masks. Because the union is a row mask over one frame, a row matched by two members appears once:
    that IS the "deduped by run identity" rule, a tidy row being one run/point."""
    members = layer.get("members")
    if isinstance(members, list) and members:
        mask = _all_false(df)
        for member in members:
            if isinstance(member, dict):
                mask = mask | (
                    _facet_mask(df, member.get("facets")) & _range_mask(df, member.get("ranges"))
                )
        return mask
    return _facet_mask(df, layer.get("facets")) & _range_mask(df, layer.get("ranges"))


# --------------------------------------------------------------------------------------------------
# Binning — mirrors app/boolback/lib/bins.ts so a "bins" facet cuts the SAME buckets the browser did.
# --------------------------------------------------------------------------------------------------


def _clamp_bin_count(n: Any) -> int:
    """``clampBinCount``: a bucket count clamped to 1..8 (2 when not a finite number)."""
    try:
        v = float(n)
    except (TypeError, ValueError):
        return 2
    if not np.isfinite(v):
        return 2
    return max(1, min(8, int(v)))


def _quantile(sorted_vals: list[float], q: float) -> float:
    """``bins.ts quantile``: linear interpolation between order statistics of an ASCENDING array.

    NOT ``np.quantile`` + ``np.unique``: the browser keeps duplicate edges (so ``n`` buckets stay
    ``n`` buckets on a tied distribution), and de-duplicating them changed both the bucket count and
    every bucket's label relative to the dashboard."""
    m = len(sorted_vals)
    if m == 0:
        return 0.0
    if m == 1:
        return sorted_vals[0]
    pos = q * (m - 1)
    lo, hi = int(np.floor(pos)), int(np.ceil(pos))
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def compute_bin_edges(values: np.ndarray, n: Any, mode: str) -> list[float]:
    """``computeBinEdges``: ``n+1`` ascending boundaries for ``n`` buckets over the finite values.

    ``quantile`` → equal-count buckets; ``width`` → equal-width over [min, max]. Fewer than two
    distinct finite values yields a degenerate all-equal edge list (one flat bucket)."""
    k = _clamp_bin_count(n)
    clean = sorted(float(v) for v in np.asarray(values, dtype=float) if np.isfinite(v))
    if not clean:
        return [0.0] * (k + 1)
    lo, hi = clean[0], clean[-1]
    if len(clean) == 1 or hi - lo < 1e-12:
        return [lo] * (k + 1)
    if mode == "width":
        step = (hi - lo) / k
        return [hi if i == k else lo + i * step for i in range(k + 1)]
    edges = [_quantile(clean, i / k) for i in range(k + 1)]
    edges[0], edges[k] = lo, hi
    return edges


def bucket_of(value: float, edges: list[float]) -> int:
    """``bucketOf``: the 0-based bucket for ``value`` (``<= e0`` → 0; ``>= en`` → the last)."""
    n = len(edges) - 1
    if n < 1:
        return 0
    if value <= edges[0]:
        return 0
    if value >= edges[n]:
        return n - 1
    for i in range(n):
        if value < edges[i + 1]:
            return i
    return n - 1


def _edge_label(v: float) -> str:
    """``edgeLabel``: compact edge text (trims trailing zeros; scientific at the extremes)."""
    if not np.isfinite(v):
        return "—"
    if v == 0:
        return "0"
    a = abs(v)
    if a >= 1000 or a < 0.001:
        return f"{v:.1e}"
    return f"{float(f'{v:.3f}'):g}"


def _bin_label(edges: list[float], i: int) -> str:
    """``binLabel``: the closed-open interval text for bucket ``i`` (e.g. ``"0.12–0.35"``)."""
    if i < 0 or i + 1 >= len(edges):
        return "—"
    return f"{_edge_label(edges[i])}–{_edge_label(edges[i + 1])}"


# --------------------------------------------------------------------------------------------------
# Panels — the group-plot facet OBJECT decides how the figure is cut into small multiples.
# --------------------------------------------------------------------------------------------------

# One panel: its title (None = the single unfacetted panel) and the per-layer masks within it.
Panel = tuple[str | None, list[tuple[dict[str, Any], pl.Series]]]


def _panels(
    df: pl.DataFrame, spec: dict[str, Any], layer_masks: list[tuple[dict[str, Any], pl.Series]]
) -> list[Panel]:
    """``[(panel_title, [(layer, mask_within_panel), …]), …]`` for the spec's facet.

    v3 read ``facet`` as a bare column name and produced one panel per distinct value. v4 makes it a
    GROUP-PLOT-ONLY object with four kinds; a plot (non-groupplot) view is always one panel::

        {"kind": "layer"}                                one panel per layer
        {"kind": "param", "key": "trigger_form"}         one panel per distinct value
        {"kind": "grid", "row": "…", "col": "…"}         one panel per NON-EMPTY row×col cell
        {"kind": "bins", "metric": "…", "n": 4, "mode": "quantile"|"width"}   one panel per bucket
    """
    facet = spec.get("facet")
    if spec.get("view") != "groupplot" or not isinstance(facet, dict):
        return [(None, layer_masks)]
    kind = facet.get("kind")

    if kind == "layer":
        return [(layer["name"], [(layer, mask)]) for layer, mask in layer_masks][:_MAX_PANELS]

    if kind == "param":
        key = _tidy_col(df, facet.get("key"))
        if key is None:
            return [(None, layer_masks)]
        col = df.get_column(key)
        values = [v for v in dict.fromkeys(col.to_list()) if v is not None][:_MAX_PANELS]
        return [
            (f"{key} = {v}", [(layer, mask & (col == v)) for layer, mask in layer_masks])
            for v in values
        ]

    if kind == "grid":
        row_key = _tidy_col(df, facet.get("row"))
        col_key = _tidy_col(df, facet.get("col"))
        if row_key is None or col_key is None:
            return [(None, layer_masks)]
        rows, cols = df.get_column(row_key), df.get_column(col_key)
        out: list[Panel] = []
        for rv in [v for v in dict.fromkeys(rows.to_list()) if v is not None]:
            for cv in [v for v in dict.fromkeys(cols.to_list()) if v is not None]:
                cell = (rows == rv) & (cols == cv)
                if not cell.any():
                    continue  # non-empty cells only
                out.append((f"{rv} × {cv}", [(layer, mask & cell) for layer, mask in layer_masks]))
        return out[:_MAX_PANELS] or [(None, layer_masks)]

    if kind == "bins":
        metric = _tidy_col(df, facet.get("metric"))
        if metric is None:
            return [(None, layer_masks)]
        # Edges come from the LAYERS' UNION (the rows actually plotted), not the whole frame: the
        # panel bounds must describe the plotted population, as the dashboard's do.
        union = _all_false(df)
        for _, mask in layer_masks:
            union = union | mask
        vals, _ = _coerce_numeric(df.get_column(metric))
        edges = compute_bin_edges(
            vals[np.asarray(union.to_list(), dtype=bool)],
            facet.get("n"),
            str(facet.get("mode", "quantile")),
        )
        bucket = np.array([bucket_of(v, edges) if np.isfinite(v) else -1 for v in vals], dtype=int)
        out = []
        for i in range(len(edges) - 1):
            cell = pl.Series((bucket == i).tolist(), dtype=pl.Boolean)
            out.append((f"{metric} {_bin_label(edges, i)}",
                        [(layer, mask & cell) for layer, mask in layer_masks]))
        return out[:_MAX_PANELS]

    return [(None, layer_masks)]


# --------------------------------------------------------------------------------------------------
# Drawing.
# --------------------------------------------------------------------------------------------------


def _draw_panel(ax, df: pl.DataFrame, spec: dict[str, Any],
                layer_masks: list[tuple[dict[str, Any], pl.Series]],
                x_all: np.ndarray, y_all: np.ndarray,
                x_name: str, y_name: str,
                x_ticks: list[str] | None, y_ticks: list[str] | None) -> None:
    """Draw one panel: one series PER LAYER (+ optional ghosts / band / trend).

    ``color_by`` (continuous viridis + colorbar) replaces the per-layer coloring, and ONLY when there
    is exactly one layer — ``PlotConfig.colorBy``'s stated contract ("only honored when
    layers.length === 1")."""
    size = float(spec.get("size", _DEFAULT_SIZE))
    opacity = min(1.0, max(0.0, float(spec.get("opacity", _DEFAULT_OPACITY))))

    if spec.get("ghosts", _DEFAULT_GHOSTS):
        # Ghosts are the FULL point cloud behind the layers (the faint "everything else" reference).
        ax.scatter(x_all, y_all, color="0.6", **_GHOST_KW)

    color_by = _tidy_col(df, spec.get("color_by")) if len(layer_masks) == 1 else None
    if color_by is not None:
        sel = np.asarray(layer_masks[0][1].fill_null(False).to_list(), dtype=bool)
        c_vals, _ = _coerce_numeric(df.get_column(color_by))
        sc = ax.scatter(x_all[sel], y_all[sel], c=c_vals[sel], cmap="viridis",
                        s=22 * size, alpha=opacity, zorder=3)
        ax.figure.colorbar(sc, ax=ax, label=color_by, fraction=0.046, pad=0.04)
        _band_and_trend(ax, x_all[sel], y_all[sel], spec, color=None, dash="-")
    else:
        for layer, mask in layer_masks:
            sel = np.asarray(mask.fill_null(False).to_list(), dtype=bool)
            if not sel.any():
                continue
            marker, dash = _layer_style(layer)
            ax.scatter(x_all[sel], y_all[sel], color=layer["color"], marker=marker,
                       s=22 * size, alpha=opacity, label=layer["name"], zorder=3)
            _band_and_trend(ax, x_all[sel], y_all[sel], spec, color=layer["color"], dash=dash)
        if len(layer_masks) > 1:
            ax.legend(fontsize=7, framealpha=0.85)

    if "x" in (spec.get("log") or []):
        ax.set_xscale("log")
    if "y" in (spec.get("log") or []):
        ax.set_yscale("log")
    ax.set_xlabel(x_name)
    ax.set_ylabel(y_name)
    if x_ticks is not None:
        ax.set_xticks(range(len(x_ticks)))
        ax.set_xticklabels(x_ticks, rotation=30, ha="right", fontsize=7)
    if y_ticks is not None:
        ax.set_yticks(range(len(y_ticks)))
        ax.set_yticklabels(y_ticks, fontsize=7)


def _band_and_trend(ax, x: np.ndarray, y: np.ndarray, spec: dict[str, Any], color: Any,
                    dash: Any = "-") -> None:
    """The ±1 SD band (spec ``band``) and OLS trend line (spec ``trend``) for one layer's cloud.

    The trend line takes the LAYER's dash pattern, so the layer's dash channel reads on the figure the
    way it reads in the browser (v3 hard-coded one dashed trend for every series)."""
    finite = np.isfinite(x) & np.isfinite(y)
    x, y = x[finite], y[finite]
    if x.size < 2:
        return
    order = np.argsort(x)
    x, y = x[order], y[order]
    if spec.get("band", _DEFAULT_BAND):
        # ±1 SD around the per-unique-x mean (a self-describing spread band).
        xs = np.unique(x)
        mean = np.array([y[x == xv].mean() for xv in xs])
        sd = np.array([y[x == xv].std() for xv in xs])
        ax.fill_between(xs, mean - sd, mean + sd, color=color or "0.5", alpha=0.15, zorder=2)
    if spec.get("trend", _DEFAULT_TREND) and x.size >= 2 and np.ptp(x) > 0:
        slope, intercept = np.polyfit(x, y, 1)
        xs = np.array([x.min(), x.max()])
        ax.plot(xs, slope * xs + intercept, color=color or "0.2", lw=1.5, ls=dash, zorder=4)


def _render_table(spec: dict[str, Any], df: pl.DataFrame, out_path: Path) -> Path:
    """Render a ``view == "table"`` spec: the selected ``columns`` sorted by ``sorts`` as a figure.

    v4 ``sorts`` entries are ``{col, dir: "asc"|"desc"}`` — the v3 ``{key, desc}`` reader ignored
    every v4 sort and left the frame in read order. ``columns`` are the browser's internal ids,
    bridged to tidy names by :func:`_tidy_col`."""
    plt = _pyplot()
    requested = spec.get("columns")
    columns: list[str] = []
    if isinstance(requested, list) and requested:
        columns = [c for c in (_tidy_col(df, c) for c in requested) if c is not None]
    if not columns:
        columns = [c for c in df.columns if not c.startswith("_")][:8]
    for s in spec.get("sorts") or []:
        if not isinstance(s, dict):
            continue
        col = _tidy_col(df, s.get("col"))
        if col is not None:
            df = df.sort(col, descending=s.get("dir") == "desc")
    df = df.select(columns).head(50)
    fig, ax = plt.subplots(figsize=(min(2 + 1.6 * len(columns), 16), min(1 + 0.3 * df.height, 12)))
    ax.axis("off")
    table = ax.table(
        cellText=[[str(v) for v in row] for row in df.iter_rows()],
        colLabels=columns, loc="center", cellLoc="left",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(7)
    fig.tight_layout()
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path


# --------------------------------------------------------------------------------------------------
# Public entry point.
# --------------------------------------------------------------------------------------------------


def render_spec(spec: dict[str, Any], tidy_path: Path, out_path: Path) -> Path:
    """Render a v4 ``spec`` against ``tidy_path`` to ``out_path`` (format follows the suffix).

    A ``view == "table"`` spec renders a table figure. A plot/groupplot spec renders one series per
    LAYER, with the group-plot ``facet`` object cutting small multiples and band/ghosts/trend as
    plot-level overlays."""
    require_v4(spec)
    df = _load_tidy(Path(tidy_path))
    df = _widen(df, _needed_metrics(df, spec))

    if spec.get("view") == "table":
        # Table ONLY: top-level `filters` + `ranges` are the table's own filter state.
        return _render_table(
            spec,
            df.filter(_facet_mask(df, spec.get("filters")) & _range_mask(df, spec.get("ranges"))),
            Path(out_path),
        )

    # PLOT-LEVEL ranges AND onto every layer, so they narrow the frame before any layer resolves.
    df = df.filter(_range_mask(df, spec.get("ranges")))

    x_name = _tidy_col(df, spec.get("x", _DEFAULT_X))
    y_name = _tidy_col(df, spec.get("y", _DEFAULT_Y))
    if x_name is None or y_name is None:
        raise ValueError(
            f"spec x={spec.get('x', _DEFAULT_X)!r}/y={spec.get('y', _DEFAULT_Y)!r} not found as tidy "
            f"columns or metric_names (available: "
            f"{sorted(c for c in df.columns if not c.startswith('_'))})"
        )
    # Drop points with no x or y (e.g. a function-level-only metric row that never got the other axis).
    df = df.filter(pl.col(x_name).is_not_null() & pl.col(y_name).is_not_null())

    layer_masks = [(layer, _layer_mask(df, layer)) for layer in _layers(spec)]
    # Tick labels for categorical axes (computed over the whole frame so panels share positions).
    x_all, x_ticks = _coerce_numeric(df.get_column(x_name))
    y_all, y_ticks = _coerce_numeric(df.get_column(y_name))
    # Categorical axes get a small deterministic jitter so overlapping discrete positions separate.
    if x_ticks is not None:
        x_all = x_all + np.random.default_rng(0).uniform(-0.12, 0.12, size=x_all.shape)
    if y_ticks is not None:
        y_all = y_all + np.random.default_rng(1).uniform(-0.12, 0.12, size=y_all.shape)

    panels = _panels(df, spec, layer_masks) or [(None, layer_masks)]
    plt = _pyplot()
    ncols = min(len(panels), 3) or 1
    nrows = (len(panels) + ncols - 1) // ncols
    fig, axes = plt.subplots(nrows, ncols, figsize=(5.2 * ncols, 4.2 * nrows), squeeze=False)
    for i, (title, panel_masks) in enumerate(panels):
        ax = axes[i // ncols][i % ncols]
        if df.height:
            _draw_panel(ax, df, spec, panel_masks, x_all, y_all, x_name, y_name, x_ticks, y_ticks)
        if title is not None:
            ax.set_title(title, fontsize=9)
    for j in range(len(panels), nrows * ncols):  # blank any unused grid cells
        axes[j // ncols][j % ncols].axis("off")
    fig.tight_layout()
    fig.savefig(Path(out_path), bbox_inches="tight")
    plt.close(fig)
    return Path(out_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m tom_quest.render")
    parser.add_argument("spec", type=Path, help="the view-spec JSON (v4; app/boolback/lib/spec.ts)")
    parser.add_argument("-o", "--out", type=Path, required=True, help="output figure (.pdf / .png / …)")
    parser.add_argument("--tidy", type=Path, default=None,
                        help="path to tidy.parquet (defaults to $CMT_OUTPUT/tidy/tidy.parquet)")
    args = parser.parse_args(argv)

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    if args.tidy is not None:
        tidy_path = args.tidy
    else:
        from cmt import config
        tidy_path = config.tidy_root() / "tidy.parquet"
    out = render_spec(spec, tidy_path, args.out)
    sys.stdout.write(f"render -> {out}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
