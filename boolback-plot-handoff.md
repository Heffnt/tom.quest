# boolback plot rework — implementation handoff

**Read [`boolback-plot-plan.md`](boolback-plot-plan.md) first.** That is the approved design (Tom, 2026-07-07) and the source of truth for intent, locked decisions, and acceptance criteria. This file is the *implementation* companion: what got built, how it maps to the plan's phases, how it was verified, and where the next agent picks up.

**Branch:** `claude/stoic-panini-10e6c8` (worktree). **Baseline:** `main` @ `38dbe6f` (which added the plan doc). **Not merged to main; not deployed to prod.**

---

## Status at a glance

All 5 phases in the plan (§3) are **implemented, committed one-per-phase, and browser-verified** on the sample snapshot. Gates green at each phase and together: `pnpm lint`, `pnpm test` (526 vitest tests), `pnpm build`.

| Phase (plan §3) | Commit | State |
|---|---|---|
| 1 — model core | `8a264ed` | ✅ done, lib-tested |
| 2 — Plot tab UX (dimension board, spread, axes) | `8338931` | ✅ done, browser-verified |
| 3 — epoch x-axis trajectories | `f36e2ce` | ✅ done, browser-verified |
| 4 — Group Plot facet grid | `61d0cc9` | ✅ done, browser-verified |
| 5 — saved filter sets & views (Convex) | `835c584` | ✅ done, live CRUD verified on **dev** Convex |

`git diff --stat main...HEAD` → 28 files, ~+2764/−613.

---

## What each phase delivered (and where the code lives)

### Phase 1 — model core
- **`app/boolback/lib/types.ts`**: `ChartConfig` is now **v2** (`v:2`, `x`/`y`, ordered `splits[]`, `channels`, `valueStyles`, `band`, `ghosts`, `logX/Y`, `trend`, `xDomain`/`yDomain`, `facetDim`, `panelMin`). `ChartConfigV1` + `DimTreatment` kept **only** as migration input. `migrateChart(input): ChartConfig` is total (garbage→defaults; v1 `dims` → ordered `splits`+`channels`; v2 sanitized). `Channel` moved here (adds `dash`).
- **`app/boolback/lib/styling.ts`** (new): `PALETTE`, `SINGLE_COLOR`, `SHAPE_COUNT`, `DASH_PATTERNS` + `colorForValue`/`shapeForValue`/`dashForValue` (ordinal cycling, per-value override wins).
- **`app/boolback/lib/dimensions.ts`**: `resolveChannels(splits, channels, valueCount)` replaces `assignTreatments`. `CHANNELS`/`CHANNEL_CAPS` extended with `dash`.
- **`app/boolback/lib/aggregate.ts`**: `groupRuns` now also returns `ghosts` (subsampled >`GHOST_CAP`=2000, deterministic) + `ghostsSubsampled`; `makeXBucketer` (shared bucketing) and `groupKeyFor` exported; `splitWorthiness(runs, averagedDims)` = weighted η² per averaged dim (guards: n<3, single-value, all-identical-Y contribute 0).
- **`app/boolback/lib/share.ts`**: decode runs `migrateChart` on the `chart` field → old links load.
- `chart-panel.tsx`, `export-menu.tsx`, `table-pane.tsx` adapted to v2. `table-pane` hydrate wraps `migrateChart(src.chart)`.

### Phase 2 — Plot tab UX
- **Rename** `CenterView` `"chart"`→`"plot"`, added `"groupplot"`; `normalizeCenterView()` maps legacy `"chart"`→`"plot"` at the share/route boundaries. Sites: `table-pane.tsx` (type + render switch + `plotOn`), `boolback-client.tsx` (shared-view + per-view `treeCollapsed`), `filter-bar.tsx` (switcher labels), `export-menu.tsx`.
- **`app/boolback/components/dimension-board.tsx`** (new): replaces the old `LegendPanel`. Split rows (channel badge cycles color→shape→size→dash, drag-reorder, per-value swatch → `StylePicker`, filter checkboxes, isolate/exclude), averaged rows with **split-worthiness bars** (sorted worst-first, click to split), collapsible constants, **band/ghosts** toggles in the footer.
- **`app/boolback/components/glyph.tsx`** (new): `shapeNode` extracted so the plot body and board swatches share glyphs.
- Ghost points render behind group means (`config.ghosts`); `config.band` gates the ±SD whiskers.
- **Axis min/max** view-window controls (`AxisRange` in `chart-panel.tsx`) replace box-select. **Zoom-only**: clipped points stay in the table/filters; stats compute over the window; `outsideWindow` in the readout. `ChartReadout` (store) gained `outsideWindow` + `ghostsSubsampled`.
- **`e2e/boolback.spec.ts`** (new — boolback had no e2e before): renamed-tabs + plot/board render + split smoke.

### Phase 3 — epoch x-axis
- **`app/boolback/lib/trajectories.ts`** (new): `buildRunSeries` (null gaps skipped, in-progress = shorter, per-judge resolution — single selected `judge` → `per_judge[].by_epoch`, else headline; `ppl` always headline), `groupSeries` (mean ± SD per exact epoch; `runId` set for single-run groups), `trajectoryMetric`.
- **`metric-picker.tsx`**: optional `pinned` entries; the X picker pins **"epoch (training progress)"**. Y snaps to a trajectory-backed metric (plantedness/asr/ftr/ppl) in epoch mode.
- **`chart-panel.tsx`** line-mode path (`config.x === "epoch"`): per-run ghost polylines (subsampled to 500), group ±SD ribbons, mean lines colored by the color dim and **dashed by the shape dim** (splits[1]→dash in line mode), vertices with hover title + click-through for single-run groups. Epoch-aware scale/extent/readout/CSV.

### Phase 4 — Group Plot
- **`app/boolback/components/group-plot.tsx`** (new): the Plot config faceted across `config.facetDim`'s values. Facet-dim picker + panel-size slider; shared x/y domains + **globally-computed** styling ordinals (consistent colors across panels); >150 cardinality guard (top-150 by count + "N more"); **windowed via `content-visibility:auto`** (see gotcha below); promote-on-header-click sets the facet value as a filter and switches to Plot. Works in scatter **and** epoch modes. `table-pane.tsx` routes `"groupplot"` → `GroupPlotBody`.

### Phase 5 — saved filter sets & views (Convex)
- **`convex/schema.ts`**: `boolbackPresets` table (`name`, `kind: "filters"|"view"`, `schemaVersion`, `state: v.any()`, timestamps) + `by_kind_name` index. **Global, no auth** (single-user page).
- **`convex/boolbackPresets.ts`** (new): `list`/`save` (upsert by kind+name)/`remove`. **`convex/boolbackPresets.test.ts`** (new).
- **`app/boolback/lib/presets.ts`** (new): tolerant loader — `sanitizeFilters` (field-by-field), `hydratePreset` (deep-merge onto defaults, `chart` through `migrateChart`, never throws), `suggestPresetName`. **`presets.test.ts`** fuzzes malformed/stale blobs.
- **`filter-bar.tsx`**: `Views ▾` dropdown next to `+ Filter` — Filter sets / Views sections, apply/overwrite/delete, "Save current filters…/view…" with a suggested name, live `useQuery`. Filter sets restore only chips; views restore filters + chart + sorts + columns + centerView.

---

## Verification done

- **Gates:** lint clean (only pre-existing `app/thmm/...` warnings), 526 vitest tests pass, `next build` succeeds with `/boolback` compiling.
- **Browser (dev server + bundled sample snapshot, 2913 runs):**
  - Plot: default all-averaged, split-worthiness bars sorted worst-first; one-click split auto-assigns color; axis min/max controls present; no console errors.
  - Epoch: "epoch (training progress)" x-axis renders trajectories (per-run ghost lines + group mean ± SD ribbons), split-colored; no errors on a fresh load.
  - Group Plot: facet picker → panel grid; LR facet → epoch-trajectory panels; promote sets the LR chip and lands on Plot.
  - Presets: Views dropdown renders; **save/list/remove round-trip live** against the dev Convex deployment.

---

## Pick up here (next agent)

1. **Review & re-verify.** Pull the branch, run `pnpm lint && pnpm test && pnpm build`. To exercise the UI: `pnpm dev:all` (Next **and** `convex dev` — Views needs the Convex backend), open `/boolback`, walk Plot → split a dim → epoch x → Group Plot → promote → Views save/apply. Optionally `pnpm test:e2e e2e/boolback.spec.ts`.
2. **Deploy.** Per repo memory, deploy = **push to `main`** (which runs the prod Convex deploy, creating the `boolbackPresets` table in prod). The table is already in the **dev** deployment (pushed via `convex dev --once` during implementation); prod gets it on merge. There is a standing OK to push main once gates pass — but this is a large rework, so confirm with Tom before merging.
3. **Follow-ups worth considering** (not blockers): the `Views ▾` `useQuery` throws → the whole `FilterBar` falls into the page error boundary if the preset query errors (standard Convex pattern, but a transient outage takes the bar down — consider a local error boundary around `ViewsMenu`); per-value `size` override was intentionally left out; epoch-mode readout shows no r/ρ (by design — trend is meaningless on trajectories).

---

## Gotchas & decisions (save the next agent the rediscovery)

- **Decisions beyond the plan:** (a) added `e2e/boolback.spec.ts` since boolback had **no** e2e — the plan's "e2e smoke updated" meant *creating* one; (b) per-value **size** override omitted (size stays ordinal), matching the plan's `ValueStyle` (color/shape/dash only); (c) Group Plot windowing uses **`content-visibility:auto`** instead of `IntersectionObserver` — IO's initial callback didn't fire in the preview's offscreen render context, and content-visibility is simpler and keeps SVGs in the DOM.
- **Group separator is a null char.** `aggregate.ts`/`trajectories.ts` join dim tuples with `" "`. Write it as the **escape sequence** (`" "` or `String.fromCharCode(0)`), never a raw NUL — a JSON tool arg turns ` ` into a real NUL byte, which corrupts the `.ts` source (git treats it binary, tsc/eslint choke). If you see a "binary file matches" from grep, that's the bug.
- **HMR false alarms.** Editing a `useEffect`'s dep-array length live triggers React's "changed size between renders" + a downstream "setState in render (DebugPanel)" — both are **Fast-Refresh artifacts**, gone on a clean load / server restart (static arrays can't change size at runtime; `next build` is authoritative). Don't chase them.
- **Preview console buffer is sticky.** The preview keeps console history across reloads and `console.clear()` doesn't flush it — check request IDs to tell stale errors from new ones. Also: `svg[role="img"]` matches the header logo first; select the chart SVG via `.closest('main')`.
- **Persisted vs. shared vs. store.** `centerView` is **not** in the persisted `boolback:view` blob (it comes from the route/share). The chart config persists inside that blob and is migrated on hydrate (`table-pane.tsx`). The store has no `persist()` — panes sync store↔persisted (see the NOTE at the bottom of `store.ts`).
- **Stats boundary holds** (plan §4): everything is descriptive (mean/SD/η²/r/ρ/OLS). No p-values/CIs.
- **Out of scope** (plan §5, unchanged): no CMT/builder changes, no frozen/pinned run-id sets, no per-user preset namespacing/auth, no inferential stats.
