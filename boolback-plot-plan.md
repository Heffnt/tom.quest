# boolback plot rework plan

**Status:** approved (Tom, 2026-07-07) — design settled over a collaborative session; no code written yet.
**Baseline:** `main` as of `1ab8f62` (post-usability-pass filter bar, chart view with dimension treatments).
**Prior plans:** `boolback-redesign-plan.md` (shipped architecture), `boolback-usability-plan.md` (shipped filter-bar/table pass). This plan reworks the chart view's grouping/styling model, renames it **Plot**, adds a **Group Plot** facet-grid tab, adds epoch-trajectory plotting, and adds Convex-backed saved filter sets / views.

**No CMT/pipeline changes are needed.** Per-epoch trajectories already ship in the snapshot (`trajectories.plantedness/asr/ftr/ppl` aligned with `completed_epochs`, plus `per_judge[].by_epoch`). Sweep filtering is handled by saved filter sets, not builder-emitted sweep tags — Tom explicitly rejected sweep-YAML tagging.

---

## 0. Locked design decisions (Tom, 2026-07-07)

These were each explicitly confirmed; do not re-litigate them.

1. **Rename Chart → Plot.** New sibling tab **Group Plot**. Tab order: Table | Plot | Group Plot | Anatomy.
2. **Grouping model replaces the channel model.** The user's per-dimension question is *split / averaged / filtered*, not "which visual slot." Styling is auto-assigned from the split list but **fully overridable at every layer** — Tom: "automatic defaults are great so I don't NEED to take control, but I need to be able to take as much control as I WANT."
3. **Default is nothing split** — all differing dimensions averaged, **with visible spread**. Tom hates silent averaging: "I want to see it so I can know if I should split it."
4. **Spread rendering:** ±SD bands **and** ghost points (faint underlying runs), each independently toggleable.
5. **Split-worthiness readout** per averaged dimension in the legend (how much of the spread that dim explains), sorted worst-first, click-to-split.
6. **Epoch is an x-axis choice** on the Plot tab; runs/groups become trajectory lines.
7. **Box-select is removed.** Replaced by min/max controls on the axes themselves with **zoom-only semantics** (view window; never touches FilterState). Data filtering stays in the filter bar's range chips.
8. **Group Plot = the Plot config + one facet dimension.** Identical plot per panel; panels vary across the facet dim's values. 10–100 panels, scrollable, user-controlled panel size, shared axes. Clicking a panel promotes it to the big Plot (facet value becomes a filter, view switches).
9. **Saved filter sets + saved views**, both first-class: a *filter set* saves only `FilterState` (applying it sets the chips, leaves plot config alone); a *view* saves everything (filters + plot config + sorts + columns + center view). Same storage, `kind` flag, one dropdown.
10. **Filter sets are predicates (live)** — new runs matching the filters appear automatically. "Pin to current run ids" is a possible later add, not in scope.
11. **Storage is Convex, global** (no per-user namespacing — single-user tool, page confirmed fine to be global). **Not** built on the share-URL encoder: store structured state JSON with a `schemaVersion`, loader tolerant of missing/unknown fields. The URL encoder remains share-only.
12. **Legend becomes the single dimension board** — one control surface for shared/split/averaged/filtered per dimension, including the filter checkboxes (which write the same shared `FilterState` the bar chips display).

---

## 1. Current architecture (orientation for the implementing agent)

| Piece | Path | Notes |
|---|---|---|
| Tab switch + center view | `app/boolback/state/store.ts` (`centerView`), `app/boolback/boolback-client.tsx`, `app/boolback/components/table-pane.tsx` (`CenterView` type) | `"table" \| "chart" \| "anatomy"` |
| Filter bar | `app/boolback/components/filter-bar.tsx` | chips + `+ Filter` menu; view switcher lives here (line ~182) |
| Chart body + legend | `app/boolback/components/chart-panel.tsx` (~1200 lines, pure SVG, no chart lib) | scatter, tooltip, box-select (lines ~496–539 — to be removed), trend lines, legend panel (~840+) |
| Dimension model | `app/boolback/lib/dimensions.ts` | `DIMENSIONS` list, `summarizeDimensions` (shared vs differing), `assignTreatments` (auto channel assignment — the behavior being replaced) |
| Aggregation | `app/boolback/lib/aggregate.ts` | `groupRuns`: group by (split-dim values × x bucket) → mean ± SD; x binning at >24 distinct values |
| Stats | `app/boolback/lib/stats.ts` | mean/stdDev/pearson/spearman/olsFit — descriptive only (inferential stays CMT-side; keep that boundary) |
| Filter/sort engine | `app/boolback/lib/select.ts` | `applyFilters`, `applySorts`, facet helpers |
| Types | `app/boolback/lib/types.ts` | `RunRow`, `FilterState`, `ChartConfig` (v1), `DimTreatment` |
| Share URL | `app/boolback/lib/share.ts` | full-view encoder; stays share-only |
| Persistence | `usePersistedSettings` in the panes (localStorage + Convex `userSettings` when signed in) | per NOTE at bottom of `store.ts` — no zustand `persist()` |
| Convex schema | `convex/schema.ts` | new `boolbackPresets` table goes here |
| Trajectory data | `RunRow.trajectories` (`completed_epochs[]` + parallel metric arrays, nulls possible), `RunRow.per_judge[].by_epoch` | already in the snapshot; headline arrays are the primary judge's |

Current chart flow: filtered rows → `summarizeDimensions` → `assignTreatments` (auto color→shape→size by cardinality, leftovers averaged) → `groupRuns` → SVG. **The auto-splitting is the core complaint**: it forces the data apart across all styling channels by default.

---

## 2. New model

### 2.1 ChartConfig v2

Replace `ChartConfig` in `lib/types.ts` (keep the old type around only for migration):

```ts
export type Channel = "color" | "shape" | "size" | "dash"; // dash: line-style, meaningful for line/trajectory rendering

export interface ValueStyle { color?: string; shape?: number; dash?: number; } // explicit per-value overrides

export interface ChartConfigV2 extends Record<string, unknown> {
  v: 2;
  x: string;               // metric_schema name, or the sentinel "epoch"
  y: string;
  splits: string[];        // ORDERED dimension keys the user chose to split; [] = everything averaged (the default)
  channels: Record<string, Channel>;      // per-split-dim channel override; absent = auto by split order
  valueStyles: Record<string, Record<string, ValueStyle>>; // dimKey → raw value → style override
  band: boolean;           // ±SD band, default true
  ghosts: boolean;         // ghost points/lines, default true
  logX: boolean; logY: boolean;
  trend: boolean;
  xDomain: [number, number] | null; // VIEW WINDOW only — never filters
  yDomain: [number, number] | null;
  facetDim: string | null; // Group Plot's extra dimension (null on the Plot tab)
  panelMin: number;        // Group Plot panel size (px), user-adjustable
}
```

- **Auto styling:** splits[0] → color, splits[1] → shape (or dash when rendering lines), splits[2] → size. Caps stay advisory (color 12 / shape 6 / size 5 / dash 4): auto-assignment respects them; explicit user assignment may exceed them (palette/glyphs cycle) — same rule as today.
- **Override layers**, each with a "reset to auto" affordance (per-dim and global):
  1. reassign a split dim's channel (`channels`);
  2. reorder `splits` (drag in the dimension board) — changes auto assignment;
  3. per-value overrides (`valueStyles`): click a legend swatch → small picker (palette + custom hex for color; glyph list for shape; dash pattern list).
- **Migration from v1** (`dims: Record<string, "color"|"shape"|"size"|"avg">`): color/shape/size entries become `splits` (in channel order) + `channels`; `"avg"` entries drop (averaged is now the default); everything else defaults. Applies to persisted settings *and* share-URL decoding. Old URLs must not crash — decode to v2 with defaults where lossy.

### 2.2 Aggregation & spread

`groupRuns` largely survives (group by split-dim values × x bucket → mean ± SD). Additions in `lib/aggregate.ts`:

- **Ghost data:** when averaging, also return the raw `RunPoint`s tagged with their group id so the renderer can draw them faintly in the group's color. Perf cap: subsample ghosts above ~2,000 points (deterministic, e.g. every k-th after a stable sort) and surface "ghosts subsampled" in the readout.
- **Split-worthiness** (new function, e.g. `splitWorthiness(rows, groups, averagedDims)`): for each averaged dimension `d`, compute the weighted eta² of Y explained by `d` *within* the current groups: for each rendered group g with n ≥ 3 runs and ≥ 2 distinct d-values, `eta²_g(d) = 1 − Σ_v SS_within(v) / SS_total(g)`; report `Σ_g n_g · eta²_g / Σ_g n_g` (0–1). Groups failing the guards contribute nothing. This is descriptive, not inferential — fine under the stats boundary rule. Displayed as a small bar per averaged dim in the dimension board, sorted descending; tooltip: "splitting Seed would explain ~62% of the spread within current groups."

### 2.3 Epoch x-axis

- `x: "epoch"` is offered in the X picker (a pinned entry above the metric groups). Valid Y values in epoch mode: trajectory-backed metrics only — `plantedness`, `asr`, `ftr`, `ppl` (map from headline metric names). If Y is anything else when the user picks epoch-x, snap Y to plantedness.
- **Series building** (new `lib/trajectories.ts`): each run contributes points `(completed_epochs[i], metric[i])`, skipping nulls (line gap, no interpolation). Judge resolution: if the `judge` dimension is filtered/split to a specific judge, use the matching `per_judge[].by_epoch` arrays; otherwise the headline `trajectories` (primary judge).
- **Rendering:** each run = a polyline; grouping averages per exact epoch value across the group's runs (epochs are small integers — no binning), band = ±SD ribbon per epoch, ghosts = individual run polylines at low alpha. In-progress runs simply have shorter lines. Point markers on line vertices keep the hover/click-through-to-drawer behavior.
- Scatter mode (metric-x) keeps today's point rendering; the existing "connecting lines when averaging" behavior is superseded by proper line rendering only in epoch mode (keep scatter connecting-lines behavior as-is otherwise).

### 2.4 Axis controls (replacing box-select)

- Delete the box-select drag handler and its range-chip writing (`chart-panel.tsx` ~496–539) and the "drag a box to range-filter" copy in `filter-bar.tsx`'s readout tooltip.
- Each axis gets, next to its existing metric picker and log toggle: click-to-edit **min** and **max** numbers (rendered at the axis ends; click opens a small inline input; Enter commits, Esc cancels) and a ⟲ reset (shown only when a domain is set). Stored in `xDomain`/`yDomain`.
- **Zoom-only semantics:** points outside the window are clipped from the plot but remain in the table/filters; the readout shows "· N outside window". Trend/r/ρ compute over the *windowed* points (what you see is what the stats describe) — note this in the readout tooltip.

### 2.5 Dimension board (the legend, reworked)

One panel, one row per dimension from `DIMENSIONS`, replacing the current legend's split/averaged/shared sections. Row states:

- **Shared** (one distinct value): muted label + value. Collapsible section, as today.
- **Averaged** (differing, not split — the default): label, value count, **split-worthiness bar**, click → adds to `splits`.
- **Split:** channel badge (● color / ▲ shape / ⬤ size / ┄ dash — click badge to cycle/reassign channel), drag handle to reorder within `splits`, value list with swatches (click swatch → per-value style picker), per-value **filter checkboxes**, and an "avg" action to un-split.
- **Filtered** (facet selection active): the row shows the active selection inline; editing it writes the same `FilterState` the bar chips render. The function dimension keeps its `fn=` subtree-scope behavior.
- Per-value **isolate / exclude** actions (filter to just this value / drop it) — one click each, writing normal facet filters.
- Board footer: toggles for **band** and **ghosts**, and the trend toggle can move here from the filter bar (keep the r/ρ readout in the bar).

Order: split dims first (in `splits` order), then averaged sorted by split-worthiness desc, then filtered, then shared (collapsed).

### 2.6 Group Plot

- New `CenterView` value `"groupplot"`. Tab renders the same plot component in facet mode: `facetDim` chosen from any dimension (picker at the top of the dimension board or a dedicated control strip).
- Grid: `repeat(auto-fill, minmax(panelMin, 1fr))`; panel size slider (`panelMin`, ~160–480px). Scrollable vertically. **Windowed rendering** (only mount panels near the viewport — reuse the table's windowing approach) since 100 SVG panels with ghosts is real work.
- Shared x/y domains computed across *all* panels (respecting `xDomain`/`yDomain` overrides). Panel header: facet value + run count. Panels sorted by the dim's value order (numeric-aware).
- Facet dim is excluded from the dimension board's split/avg choices while active (it's consumed by faceting); if the facet dim was in `splits`, remove it on selection.
- Cardinality guard: if the facet dim has > 150 values, render the top 150 by count with a visible "N more not shown" note.
- **Promote:** clicking a panel header sets that facet value as a filter (facet selection, or `fn=` scope for the function dim), clears `facetDim`, and switches `centerView` to `"plot"`.
- Group Plot shares the Plot tab's entire ChartConfig (one config object; `facetDim` is just ignored by the Plot tab render path). Switching tabs must not reset anything.

### 2.7 Saved filter sets & views (Convex)

**Schema** (`convex/schema.ts`):

```ts
boolbackPresets: defineTable({
  name: v.string(),
  kind: v.union(v.literal("filters"), v.literal("view")),
  schemaVersion: v.number(),          // 1
  state: v.any(),                     // kind=filters: { filters: FilterState }
                                      // kind=view:    { filters, chart, sorts, visibleCols, centerView }
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_kind_name", ["kind", "name"]),
```

**API** (`convex/boolbackPresets.ts`): `list` (all, ordered by updatedAt desc), `save` (upsert by name+kind), `remove`. Global — no auth gating (Tom confirmed global is fine; page is effectively single-user). Follow the existing convex module style (see `brews.ts` for conventions) and add a `convex/boolbackPresets.test.ts` in the style of `convex.test.ts`.

**Hydration rules (the whole point of not using the URL encoder):** the loader deep-merges saved `state` onto current defaults — unknown keys ignored, missing keys defaulted, `chart` run through the same v1→v2 migration path. A preset must *never* crash the page; worst case it applies partially. Bump `schemaVersion` only for genuinely breaking shape changes and keep a small migration ladder.

**UI:** a `Views ▾` dropdown in the filter bar (next to `+ Filter`): two sections (Filter sets / Views), click to apply, hover row shows overwrite/delete actions, footer "Save current filters…" and "Save current view…" prompting for a name (default suggestion from active chips, e.g. "llama-1b · lr sweep"). Applying a filter set replaces `FilterState` only; applying a view replaces filters + chart + sorts + visibleCols + centerView. Live Convex query (`useQuery`) so saves from another tab appear.

---

## 3. Phases

Each phase leaves the site working and shippable. Commit per phase (or finer), run the standard gates (`pnpm lint`, `pnpm test`, `pnpm build`; e2e where touched) before pushing to main.

### Phase 1 — model core (lib only, no visible UI change beyond equivalent behavior)

1. `ChartConfigV2` type + `DEFAULT_CHART` v2 + v1→v2 migration function (unit-tested).
2. Rework `dimensions.ts`: `assignTreatments` replaced by `resolveStyling(splits, channels, differing)` → per-split-dim channel + per-value style resolution (incl. `valueStyles` overrides and cycling past caps). Averaged = any differing dim not in `splits`.
3. `aggregate.ts`: ghost-data output + `splitWorthiness` (unit-tested with hand-computed fixtures — nail eta² edge cases: n<3 groups, single-value dims, all-identical Y).
4. `share.ts`: encode/decode v2 (versioned param); old links decode without crashing.
5. Adapt `chart-panel.tsx` minimally to consume the new config (default `splits: []` now means all-averaged — this *is* a behavior change and it's the intended one). Persisted-settings load path migrates v1 configs.

**Acceptance:** all lib tests green; chart renders all-averaged by default with existing band rendering; splitting via (temporary) existing legend controls still works.

### Phase 2 — Plot tab UX: dimension board, styling control, spread, axes

1. Rename: `CenterView` → `"table" | "plot" | "groupplot" | "anatomy"` (with `"chart"` accepted and mapped in persisted-state/share-URL decoding). Filter-bar switcher labels: Table | Plot | Group Plot | Anatomy (Group Plot can be disabled/hidden until Phase 4 if landed separately).
2. Split `chart-panel.tsx` (~1200 lines) into `plot/` modules: `plot-body.tsx` (SVG), `dimension-board.tsx`, `axes.tsx`, `series.ts` (data prep). Keep the export handle working (`ExportMenu` dependency).
3. Dimension board per §2.5, including split-worthiness display, channel badges, drag-reorder, per-value style pickers, isolate/exclude, filter checkboxes, band/ghosts toggles.
4. Ghost points rendering (subsampled, low-alpha, group-colored), band toggle honored.
5. Axis min/max controls per §2.4; delete box-select; move "N outside window" into the readout.

**Acceptance:** default view = all-averaged with band + ghosts; one click on an averaged dim splits it with sensible auto-styling; styling fully overridable and resettable; axis windowing never changes the table's row count; e2e smoke updated (tab renamed, board interactions).

### Phase 3 — epoch x-axis

1. `lib/trajectories.ts` per §2.3 (unit-tested: null gaps, per-judge resolution, in-progress runs).
2. X picker gains the pinned "epoch" entry; Y snaps to trajectory-backed metrics in epoch mode.
3. Line rendering: per-run polylines, group means ± SD ribbon per epoch, ghost lines, dash channel used for splits[1] when in line mode, vertex hover/click-through.

**Acceptance:** plantedness-vs-epoch for a filtered set of runs renders as trajectories; splitting by lr colors the lines; averaging seeds shows mean ribbon ± SD with ghost lines; judge filter switches to per-judge arrays.

### Phase 4 — Group Plot

Per §2.6: facet-dim picker, windowed grid, panel-size slider, shared domains, cardinality guard, promote-on-click. Works in both scatter and epoch-x modes (epoch-x facet grids are a primary use case: one panel per function/lr showing training curves).

**Acceptance:** 100-panel grid scrolls smoothly (windowed); promote sets the filter chip and lands on Plot with identical config; share URL round-trips `facetDim`.

### Phase 5 — saved filter sets & views

Per §2.7: schema + convex module + tests, `Views ▾` dropdown, save/apply/overwrite/delete, hydration tolerance tests (fuzz a few malformed/stale presets through the loader).

**Acceptance:** save "b1 sweep" as a filter set from active chips; reset; re-apply → chips restored, plot config untouched. Save a full view incl. epoch-x + splits + facet; re-apply from a fresh browser → identical view. A hand-corrupted preset applies partially without crashing.

---

## 4. Edge cases & cautions

- **Perf:** ghosts + 100 panels + trajectories multiply SVG nodes. Windowed panels (Phase 4), ghost subsampling (Phase 1), and memoized series building are not optional.
- **`epochs` facet vs epoch-x:** the `epochs` *dimension* (training epoch budget) is unrelated to the epoch *axis* (progress through training). Label the X entry "epoch (training progress)" to avoid confusion.
- **Log axes:** epoch-x with logX is meaningless-but-harmless (epoch 0 drops); keep the existing "dropped (log)" readout honest in both modes.
- **Store note:** keep the no-`persist()` idiom (see NOTE at the bottom of `store.ts`); chart config persistence continues through `usePersistedSettings` in the panes. `setAnatomy`'s no-op-skip pattern (store.ts ~line 127) is the model for any new high-frequency setters (axis-domain editing while typing).
- **Stats boundary:** everything stays descriptive (mean/SD/eta²/r/ρ/OLS). No p-values, no CIs — inferential stats remain CMT-side.
- **Existing red CI checks:** some checks on main are pre-existing noise (see repo memory / recent runs) — don't chase failures this plan didn't cause, but don't hide new ones behind them either.

## 5. Out of scope (explicitly)

- CMT builder changes of any kind (incl. sweep tagging — rejected in favor of saved filter sets).
- Frozen/pinned run-id sets (possible later add).
- Per-user preset namespacing or auth on presets.
- Any inferential statistics.
