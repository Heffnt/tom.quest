# boolback — how it all works

The public explorer for the ComplexMultiTrigger (CMT) boolean-backdoor
experiments at <https://www.tom.quest/boolback>. One page, three panes:

```
CommandBar   stats · Table|Chart switch · "built 2h ago" · ↻ Refresh
┌───────────┬──────────────────────────────────────┬──────────────┐
│ dir       │ filter bar (pills·facets·ranges·     │ detail panel │
│ viewer    │             sort chips·column menus) │ (opens on    │
│ (mirrors  ├──────────────────────────────────────┤  any row /   │
│ the disk  │ TABLE (one row per training run)     │  point click)│
│ tree)     │   — or —                             │ + raw        │
│           │ CHART (y vs x, color, runs/functions)│   artifacts  │
└───────────┴──────────────────────────────────────┴──────────────┘
```

It spans two repos: **tom.quest** (this page, the public proxies, the FastAPI
`turing-api`) and **ComplexMultiTrigger** (`~/booleanbackdoors/ComplexMultiTrigger`,
branch `master`) whose `tom.quest/tom_quest/` package is the snapshot builder.
Every number is computed once, in CMT; the browser is a pure view.

## The one-fetch data flow

```
CMT artifact tree on Turing            ~/booleanbackdoors/cmt-output/artifacts (~700 GB)
  └─ tom_quest builder (CMT repo)      sbatch "boolback-build", ~2 min; cron every 2h
       └─ snapshot-<dir>-<key>.json.gz ~/.cache/boolback-snapshots/
            └─ turing-api GET /boolback-snapshot-blob      (serves latest cache)
                 └─ Next proxy GET /api/boolback/blob      (injects X-API-Key)
                      └─ browser: gunzip → normalize → render
```

- **One fetch.** The page loads the blob and nothing else. Freshness is
  `meta.built_at` inside the blob ("built 2h ago" in the command bar). There is
  no status round-trip, and nothing walks the 700 GB tree on a page load (the
  old status endpoint globbed `**/done.json` per call — removed).
- **Serve-latest.** GET always returns the newest cached snapshot instantly.
  Builds happen off-request: the 2-hourly cron plus the admin ↻ Refresh (which
  POSTs `/api/turing/boolback-snapshot` → sbatch on a CPU compute node).
- **Dir is pinned** to `artifacts` (the one real tree). `?dir=` overrides;
  there is no picker.

## Snapshot schema v2 (built by `ComplexMultiTrigger/tom.quest/tom_quest/`)

`{schema_version: 2, meta, metric_schema, column_groups, friendly, functions, rows}`

- `functions` — ONE FunctionBlock per distinct function_hash (truth table,
  activation strip, DNF, ~61 complexity metrics). v1 embedded this in every
  row — ~8 MB of duplication at 3.4k rows; rows now reference it by hash.
- `rows` — one per training run (NODE_KEY = fn×ds×training, seed kept):
  dataset/training facets, headline outcome at the display epoch, per-epoch
  trajectories, per-judge scores, per-tt-row rates, defense/interp/scan/twins
  rollups, status flags, and `identity.dir_path` — the run's real on-disk
  `function+…/dataset+…/training+…` path (feeds the dir viewer and the
  raw-artifact browser).
- Floats are rounded to 4 decimals. No `tree` array (v1 had one; the browser
  derives the dir viewer from `dir_path` now).
- `data/normalize.asBundle()` accepts BOTH v1 and v2 and outputs one in-memory
  shape (shared function refs re-attached onto rows), so the site and the
  builder deploy independently, in either order.

## What the UI shows

- **Table** — sortable (multi-key chips, drag to reorder), resizable columns,
  hover-open facet menus + range sliders + per-group column menus, status
  pills. The compact `Fn` column is `arity:hex` of the truth table (`3:E8`);
  hover it for the colored strip + DNF. Truth squares: the fill is split
  evenly among the PRESENT variables (1 = full, 2 = 50/50, 3 = thirds; the
  all-zeros row is empty), near-black outlines separate the colors, and an
  amber ring means that row ACTIVATES the backdoor.
- **Chart** — the same filtered rows: any metric vs any metric, color by
  facet, one point per run (click → drawer) or per-function mean, sized by
  run count (click → scope chip). This is the RQ1/RQ4 instrument: outcome vs
  complexity, moderated by context.
- **Detail panel** — everything about a run: per-judge × epoch scores, audited
  plantedness, epoch-0 baseline, defense methods, twins — plus **raw
  artifacts**: a live browser over the run's actual dir on Turing
  (`/api/boolback/node` + `/api/boolback/file`, jailed server-side to
  `$BOOLEAN_BACKDOOR_OUTPUT`, size-capped, weight files metadata-only).
  Anything a stage writes is reachable there without projecting it into the
  snapshot.
- **Empty-but-future data** (ppl, scan, twins today) is findable, never
  default: column menus tag it "no data yet", zero-count status pills collapse
  behind "+N unused", chart selects park it in a trailing optgroup. Everything
  surfaces automatically once the builder observes real values — no code
  change needed.

## Code map

| Where | What |
|---|---|
| `app/boolback/data/source.ts` | the one blob fetch + admin rebuild |
| `app/boolback/data/normalize.ts` | v1/v2 → one Bundle; derives the tree; injects `fn_hex` |
| `app/boolback/lib/` | `types` (pinned contract), `select` (filter/sort/facet), `columns` (bare→dotted bridge), `metrics` (schema index), `format` (hex, sizes, model names) |
| `app/boolback/components/` | `table-pane` (filter bar + table + chart mount), `chart-panel`, `tree-pane` (dir viewer), `detail-panel` (+ `artifact-browser`), `truth-strip`, `fn-hex`, `epoch-sparkline`, `command-bar` |
| `app/api/boolback/{blob,node,file}` | public read-only proxies (explicit endpoints, never a catch-all) |
| `turing-api/main.py` + `boolback_snapshot.py` | blob/status/node/file endpoints + sbatch submit + cache |
| CMT `tom.quest/tom_quest/{build,reshape,schema,trajectory}.py` | the snapshot builder |

## Ops crib sheet

- **Rebuild now:** ↻ Refresh as admin, or on a login node:
  `curl -X POST -H "X-API-Key: <key>" "http://127.0.0.1:8000/boolback-snapshot?dir=artifacts"`
  (key in `turing-api/.env`). Job name `boolback-build`, ~2 min; serve-latest
  picks it up with no restart.
- **Builder changes** take effect after `git -C ~/booleanbackdoors/ComplexMultiTrigger pull`
  — no turing-api restart (the sbatch spawns a fresh `python -m tom_quest.build`).
- **turing-api changes** need the tom.quest repo pulled on Turing + the
  systemd --user service restarted on each of the three login nodes (user
  lingering must stay enabled: `loginctl show-user ntheffernan -p Linger`).
- **Local verification:** `npx vitest run app/boolback`; for pixels, `next dev`
  + Playwright with `page.route('**/api/boolback/blob**')` fulfilling a saved
  `.json.gz` (the builder fixture is `data/sample-snapshot.json`).
- **Builder tests** (from the CMT repo root):
  `PYTHONPATH=".;./tom.quest" uv run --no-project --with numpy --with scipy --with polars --with pyyaml --with pytest python -m pytest tom.quest/tom_quest/tests -q`
  — regenerate the browser fixture with `python -m tom_quest.tests._make_sample_snapshot`
  (set `BOOLBACK_SAMPLE_OUT` to this repo's `app/boolback/data/sample-snapshot.json`).
