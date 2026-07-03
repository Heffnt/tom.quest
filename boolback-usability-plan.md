# boolback table & chart usability plan (v2)

**Status:** approved with feedback (Tom, 2026-07-03) — this version incorporates that feedback. No code written yet.
**Baseline:** production page as of `fac490c` (chart view, raw-artifact browser, snapshot v2).
**Prior plan:** `boolback-redesign-plan.md` is the *shipped* architecture rework; this plan is a usability pass over the table and chart views only. Architecture, data flow, and snapshot schema are unchanged except where §7 says otherwise.

Item numbers #1–#16 match the original proposal Tom reviewed; #17+ are new from feedback.

---

## 0. What is a run? (the fundamental unit — Tom's question)

**A run is one fine-tuning execution: one `training+…` directory in the artifact tree, identified by the triple `(function_hash, dataset_hash, training_hash)` (NODE_KEY).** Concretely, one run =

- **function** — the boolean trigger logic (the truth table) the backdoor implements;
- **dataset** — the poisoned corpus generated for that function (source, task, trigger form, target behavior, poison strategy, dataset seed);
- **training** — the fine-tune configuration: base model, tuning method (LoRA/QLoRA/full), backend, lr, epoch budget, **training seed**.

One run therefore = **one trained model**. Same function + same dataset + same training config but a *different seed* → a different `training_hash` → a **different run**. Everything *below* training in the tree is folded **into** the run's row, not counted separately: epochs become the trajectory arrays, every inference×scoring×judge sibling becomes `per_judge`, and the headline is the primary judge's numbers at the display epoch (`planted_epoch ?? last completed`).

Two things that look like runs but are deliberately **not** rows:
- the `-none` epoch-0 base-eval (`training.backend == "none"`) — folded into each sibling run's `epoch0_baseline`;
- dataset-scoped scan nodes (`training_hash == "-"`) — attached to every run sharing the `(function, dataset)` pair.

This is not just documentation — it is CMT-enforced: the rollup groups exactly on NODE_KEY (`cmt/tom_quest/snapshot.py::_node_key`), and `tom_quest/tests/build_test.py` asserts no over-rowing and no `backend=="none"` row leaks.

**UI change (#17):** surface this definition where the word "run" appears:
- an ⓘ popover on the **runs** stat in the command bar and on the "N of M runs" count in the filter bar, with the definition above in ~4 lines ("1 run = 1 fine-tuned model: function × dataset × training config, seed included. Epochs and judges fold into the row. The −none baseline and scans are not runs.");
- the detail panel header shows the triple explicitly (`fn=… · ds=… · tr=…` already renders — add the word "run" and the seed);
- HANDOFF.md gets the definition verbatim.

---

## 1. Current functionality inventory

### Table
One row per run. Multi-key sort (header click = primary, shift-click = append; draggable chips). Resizable, truncating columns; per-group column show/hide menus. Cells: truth strip, `Fn` `arity:hex` with hover DNF, opt-in mini-bars normalized to schema range, OUTCOME cells with hover epoch-sparkline. Row click opens the detail drawer and reveals the run in the tree. First 500 rows rendered (`ROW_CAP`). View state persists (localStorage + Convex when signed in).

### Chart
One SVG scatter over the *same filtered rows*: any metric vs any metric, color by facet, runs mode (click → drawer) or functions-mean mode (sized by run count, click → scope chip). Deterministic jitter on count metrics, hover tooltip, legend. No fit lines, no export, 3px hit targets.

### Filter bar / header — what it does today (Tom asked for this spelled out)

The **command bar** (top strip): page name, selected-dir breadcrumb, six stats (runs / functions / %planted / defended / interp / scanned / in-progress), Table|Chart switch, "built 2h ago", status dot, ↻ Refresh.

The **filter bar** below it stacks up to **five rows**:

| Row | Contents | Interaction |
|---|---|---|
| 1 | **8 status pills** (Planted, Never planted, In progress, Has defense, Has interp, Has scan, Has twin, Negative drop); zero-count pills collapse behind a hover-revealed "+N unused" | click toggles; AND across active pills |
| 1 (right) | "N of M runs" count · **Reset** | |
| 2 (conditional) | **subtree scope chips** from tree Filter buttons | × removes; OR across chips |
| 3 | **10 facet buttons** (Task, Source, Target, Trigger, Row dist., Model, Tuning, Judge, Split, Arity) | *hover*-opens a checkbox popover with live counts; active shows "(2)" |
| 3 | **"+ add metric"** | click-opens a searchable list of ~70 metrics, *alphabetical across all groups mixed*; picking one adds a range card |
| 3 (right) | **Columns** menu (per-group show/hide) | hover-opens |
| 4 (conditional) | **sort chips** (numbered, draggable, flip, remove) | appears whenever any sort is active |
| 5 (conditional) | **range cards** — one permanently-open 240px histogram + dual-slider card per active range filter | |

**Problems.** (a) Up to five stacked strips before any data. (b) Ten facet buttons are always visible even when a facet has one value in the data — noise. (c) Four parallel filtering mechanisms (pills, facet popovers, range cards, scope chips) each look and behave differently; active state is scattered across all rows. (d) Hover-to-open is fiddly and touch-hostile. (e) Range cards permanently occupy a row after you're done adjusting. (f) The sort-chip row duplicates the header arrow for the common single-key case. (g) Finding "plantedness" in an alphabetical mix of 70 metrics is slow.

---

## 2. Filter bar simplification (#18 — new, user-requested)

**Design principle: every active filter is a chip; everything else lives behind one button.** `FilterState`, `applyFilters`, and the store are untouched — this is purely presentational.

The default state is **one row**:

```
[+ Filter]  (active filter chips…)                    N of M runs ⓘ · Columns · Reset
```

- **`+ Filter`** — one *click*-open searchable menu replacing pills + facet buttons + add-metric. Type-to-match across facet *values* ("llama" → Model: Llama-3.2-1B), facet names, metric names, and status flags. Sections in order: **Status** · **Facets** (only facets with ≥2 distinct values in scope) · **Outcome/Defense metrics** · **Function metrics** (same outcome-first ordering as the chart Y dropdown, #19). Picking a facet shows its checkbox list inline; picking a metric adds a range chip.
- **Chips** — one uniform shape for all four filter kinds: `planted ×` · `model: Llama-1B +2 ×` · `avg sensitivity 0.5–1.2 ×` · `scope: fn=3:E8 ×`. Clicking a chip's body opens its editor as a **popover** (the existing checkbox list / histogram dual-slider components, relocated); × clears it. Range editing no longer occupies a permanent row.
- **Status pills** → same chip system. Exception: **Planted** stays as a permanent quick-toggle (the headline flag). "+N unused" disappears — empty flags simply live in the menu, tagged "no runs yet".
- **Sort chips** — the row renders **only when ≥2 sort keys** are active; a single sort is already communicated by the header arrow. Drag-reorder/flip/remove behavior unchanged.
- **Kept as-is:** live counts in facet editors, histograms in range editors, subtree-chip OR semantics, Reset, the Columns menu, persistence.

Migration: the saved `boolback:view` shape is unchanged, so existing persisted views load untouched.

---

## 3. Chart changes

1. **Trend line + correlation readout** (S/M). Optional OLS fit with Pearson r / Spearman ρ on the plot; when colored by facet, one line + r per facet value. The chart's job is "does Y move with X, moderated by context" — make it answer that.
2. **Error bars in functions mode** (S). ±1 SD whiskers from the already-collected per-function xs/ys.
3. **Log-scale toggles per axis** (S/M). Checkbox next to each metric select; non-positive values dropped with a count note.
4. **Box-select → range filters** (M). Drag a rectangle to add two range-filter chips (X + Y metric). Doubles as zoom; fully reversible via the chip UI.
5. **Clickable legend** (S). Click a legend key to toggle that facet value in the existing facet filter.
6. **Hover/precision polish** (S). Bigger invisible hit radius, tooltip flips near the right edge, "nice" tick values, highlight the point for the row hovered/selected elsewhere (store already tracks it).
7. **Export** (S/M) — *amended per feedback*: an **Export** menu on the chart with
   - **Copy plotted data as CSV** (columns: run_id/fn, x, y, color key, n in functions mode);
   - **Download SVG**;
   - **Download PNG** (new): serialize the SVG → raster via canvas at 2× scale → `toBlob` download. Implementation note: the SVG uses `var(--color-…)` custom properties which do not resolve outside the document — resolve computed values into literal colors during serialization (applies to the SVG download too).
8. **Axis dropdown ordering** (#19 — new, user-requested). Per-axis optgroup order:
   - **Y select:** OUTCOME → DEFENSE → INTERP → SCAN → FUNCTION → "no data yet";
   - **X select:** FUNCTION → OUTCOME → DEFENSE → INTERP → SCAN → "no data yet".
   Defaults unchanged (`plantedness` vs `avg_sensitivity`). Pure client-side: `MetricSelect` gains a `groupOrder` prop; `metric_schema` emission order in CMT is untouched. The same outcome-first ordering is applied to the `+ Filter` metric section (§2).

---

## 4. Table changes

9. **Kill the 500-row cliff** (M). Windowed rendering on scroll replaces `ROW_CAP` slicing so every filtered row is reachable.
10. **Quick-search box** (S/M). One text input matching run id, fn hex, DNF, model, dir path, facet values.
11. **Click a categorical cell to filter to it** (S). Hover-revealed funnel icon in the cell (so it doesn't fight row-click → drawer) adds the value to its facet.
12. **Per-header menu** (S/M). Caret on each header: sort asc/desc, hide column, add range filter (numeric), **put on chart X/Y** (the table↔chart bridge).
13. **Freeze the identity columns** (S). `Fn` (optionally arity) sticky-left.
14. **Summary footer row** (S/M). Mean (or median) of each visible numeric column over the filtered set. This is also the aggregation engine for §5.
15. **Keyboard navigation** (S). ↑/↓ selection, Enter opens drawer, Esc closes.
16. **CSV export of the filtered table** (S). Visible rows × visible columns — lives in the same Export menu as §3.7.

*(Original #16 shareable URLs is now §6.)*

---

## 5. LaTeX summary-table export (#20 — new, user-requested)

**Goal:** paste headline findings straight into the paper.

- **Where:** the Export menu (shared with §3.7 / §4.16) gains **"Summary table (.tex)"** and "Summary table (CSV)".
- **Shape:** a small export dialog: *group by* one facet (default = the chart's color facet), *metrics* multi-pick (default: plantedness, ASR, FTR, triggerless correctness, asr_drop). Output rows = facet values (+ an **All** row), columns = metrics as **mean ± sd** plus an **n** column, over the currently *filtered* run set.
- **Format:** booktabs (`\toprule/\midrule/\bottomrule`), `$\pm$`, LaTeX-escaped values (`_`, `%`, `&` in model names), `\caption{}`/`\label{}` stubs, and a `%`-comment header recording provenance: snapshot `built_at`, run count, and the active filter chips — so any pasted table is traceable to the view that produced it.
- **Computation boundary (the drift rule):** mean/sd/n over shipped snapshot values is a *display-tier descriptive aggregation* — the same tier as the chart's functions-mean mode, computed in one shared module with the summary footer (§4.14). **Anything inferential (CIs, regression, significance) must come from CMT (`analysis.estimates`), never the browser.** If headline tables later need CIs, that becomes a new `cmt.tom_quest` facade surface (e.g. `summary_tables`) computed CMT-side — documented here so nobody "just adds a t-test" client-side.

---

## 6. Shareable view URLs (M)

Encode filters + sorts + chart config into a `?v=` param with a "copy link" button. Persistence today is per-browser only.

---

## 7. CMT repo — `cmt.tom_quest` facade review (#21 — new, user-requested)

**Verdict: the facade already matches the three criteria — simple (one closed import surface, `__all__`-pinned, four surfaces: `build_snapshot` / `launch` / `option_catalogue` / display-registry re-exports), tested (`tests/test_bb_tomquest_contract.py` shape contract over the rich synthetic fixture, `tests/test_bb_import_boundary.py`, plus the web-side `tom.quest/tom_quest/tests/build_test.py`), and it reuses production code (tidy `collect_rows`, `cmt.metrics.plantedness`, `twin_join`, `tuning_slug`, `metrics.primary`).** No new facade surface is needed for any item in this plan — everything above is view-layer over already-shipped numbers.

Four small **anti-drift fixes** where the facade currently re-implements or hand-maintains something production owns:

- **(a) Hardcoded planted threshold.** `cmt/tom_quest/snapshot.py` computes `status.planted` with a literal `>= 0.95`; the SSOT is `cmt.metrics.PLANTED_THRESHOLD` (`cmt/metrics/plantedness.py:49`). Import the constant. Additionally: re-export `PLANTED_THRESHOLD` from the facade, have the display layer (`tom.quest/tom_quest/build.py`) emit it as `meta.planted_threshold`, and make the browser read it (the command-bar "planted" tooltip and the run-definition popover currently hardcode "≥ 0.95"). `normalize.ts` defaults to 0.95 when the field is absent so old snapshots keep loading.
- **(b) Hand-maintained `_COUNT_METRICS`.** The frozenset in `snapshot.py` classifies structural metrics as count-vs-fraction by name; a new metric added to `trigger_logic` silently lands as "fraction". Minimal fix now: a facade test asserting `_COUNT_METRICS ⊆ set(scalar_metric_names())` **and** that every scalar metric is explicitly classified (new metric → loud test failure). Better fix, opportunistically: move dtype into the metric registry itself (single source).
- **(c) `_tuning_labels()` covers only the canonical r=16 slug per method.** A `lora-r8` run's slug gets no label and falls back to the raw slug. Fix: build labels for the tuning slugs actually observed in the rows (label as a function of the parsed cfg), not one synthetic example per method.
- **(d) Metric labels.** `_label()` synthesizes labels by capitalizing snake_case; prefer `analysis.friendly.SHORT_NAMES` when the name appears there. Low priority.

Plus one **docstring addition**: state the §5 boundary rule in the facade docstring (descriptive aggregation of shipped values = display-tier; inferential statistics = CMT-tier, entering only via a new facade surface).

All four fixes are CMT-repo changes (separate PR there, `pytest -m "not gpu"` + mypy bar per that repo's AGENTS.md); only (a) has a tom.quest-side counterpart (read `meta.planted_threshold`).

---

## 8. Implementation slices (dependency-ordered)

| Slice | Items | Notes |
|---|---|---|
| **1 — chart as instrument** | #1 trend+r, #2 error bars, #5 clickable legend, #6 polish, **#19 dropdown ordering**, **#7 export CSV/SVG/PNG** | one PR; all client-side |
| **2 — filter bar simplification** | **#18** chip redesign, **#17** run-definition popovers | promoted to slice 2 per feedback emphasis; FilterState untouched |
| **3 — table reach** | #9 windowed rendering, #10 quick-search, #13 frozen identity cols | |
| **4 — paper exports** | #14 summary footer, **#20 .tex/CSV summary export**, #16 table CSV | shared aggregation module |
| **5 — remainder** | #4 box-select, #6→URLs (§6), #11 cell-click filter, #12 per-header menu, #15 keyboard nav, #3 log scales | by appetite |
| **CMT (parallel)** | **#21 a–d** facade anti-drift fixes | separate PR in ComplexMultiTrigger; only (a) touches tom.quest after |

Explicitly **not** doing (unchanged from v1): column drag-reorder (builder-order insertion is a simplicity win; per-group menus control membership) and hexbin/density mode (jitter + opacity adequate at current run counts).

## 9. Verification

- `npx vitest run app/boolback` green at every slice; new unit tests for: per-axis dropdown ordering, chip-model round-trip (chips ↔ FilterState), summary aggregation (mean/sd/n vs hand-computed fixture), LaTeX escaping, CSV shapes.
- Pixels: `next dev` + Playwright with `page.route('**/api/boolback/blob**')` fulfilling the saved fixture; verify one-row default filter bar, chip editors, PNG/SVG byte-nonempty and PNG dimensions 2× viewBox.
- CMT: `pytest -m "not gpu"` + `uvx mypy --no-incremental` Success; contract test extended for `PLANTED_THRESHOLD` re-export.
- Persistence: an existing saved `boolback:view` (old shape) loads into the new bar without a crash or filter loss.
