# cmt-handoff — work done in this session that lands in ComplexMultiTrigger

This directory is a delivery mechanism, not a home. The session that produced it ran in a fresh
cloud checkout of tom.quest and could not push to the ComplexMultiTrigger (CMT) repo, so the CMT-side
work is carried here as two applyable patches plus the readable source of each change. Once the
patches land on CMT master, delete this directory.

Everything below is dated 2026-08-29 and was checked against the repositories at that date:
tom.quest `origin/main` at `5d045b0`, CMT `master` at `6425359e`, WikiTom `master`.

---

## 1. What is in here

| File | What it is |
|---|---|
| `0001-render-py-view-spec-v4.patch` | CMT: `tom_quest/render.py` synced to view-spec v4, plus its tests. Apply with `git am`. |
| `0002-vqc-tts-readiness-rename-todo.patch` | CMT: the RCH tier-rename filed as a `vqc/todos.yaml` entry. Apply with `git am`. |
| `render.py` | The synced renderer, as plain source, so the change is reviewable in a PR diff. Identical to what patch 0001 writes to `tom.quest/tom_quest/render.py`. |
| `render_test.py` | Its tests. Identical to what patch 0001 writes to `tom.quest/tom_quest/tests/render_test.py`. |
| `cmt-vqc-entry-tts-readiness-rename.yaml` | The single `vqc/todos.yaml` entry patch 0002 inserts, on its own for reading. |
| `confirm_v4_render.py` | A tool, not part of either patch: renders one spec and prints the figure's own panels/series/point-counts. Used to produce the confirmation in §3. |

To apply, from the CMT repo root on `master`:

```
git am /path/to/cmt-handoff/0001-render-py-view-spec-v4.patch
git am /path/to/cmt-handoff/0002-vqc-tts-readiness-rename-todo.patch
```

Both were committed and validated on a local clone of CMT `master` at `6425359e`; neither was
pushed. Applying them is Tom's gate.

---

## 2. The view-spec v4 drift, named field by field

The VIEW-SPEC is the compact JSON form of one boolback view's config. It is defined in
`app/boolback/lib/spec.ts` (tom.quest) and consumed by three places: the config panel's Copy/Paste,
the Convex presets, and CMT's `tom_quest/render.py`. The browser moved it to `v: 4`; `render.py` was
still reading the v3 shape, and — because it had no version gate and every v4-only field is one it
does not look at — it did not fail. It drew a different figure and returned 0.

The drift, as it stood before patch 0001. Each row names what the spec carries, what `render.py`
did with it, and what a reader of the emitted figure saw.

| Spec field (v4) | What `render.py` did | Visible consequence |
|---|---|---|
| `v` | Never read. No version check anywhere. | A v4 spec rendered as if it were v3, silently. `parseSpec` rejects any `v !== 4`; the renderer accepted everything. |
| `layers[]` | Not read at all — the field did not exist in v3. | **Every layer's selection was ignored.** A two-layer plot rendered as one unlabelled scatter over every run in the tidy frame. This is the largest item: the figure showed more data than the view did. |
| `layers[].facets` | Not read. | The per-layer equality selections (the v4 home for what v3 called top-level `filters`) never applied. |
| `layers[].ranges` | Not read, and not collected by `_needed_metrics`, so a metric named only there never even got pivoted in. | Layer-level numeric filters silently absent. |
| `layers[].members[]` (GROUP) | Not read. | A GROUP layer — the union of its members, deduped by run identity — had no representation at all. |
| `layers[].color` / `.style.shape` / `.style.dash` | Not read; v3 assigned colors from a `tab10`/`tab20` colormap by series ordinal. | Layer colors and glyphs in the figure did not match the dashboard's, even when the point sets happened to agree. |
| `filters` (top level) | Applied to **every** view. | In v4 this field is TABLE-ONLY. On a plot spec it is absent, so v3's `_apply_filters` was a no-op there — while the selections that should have applied (per layer) were never read. |
| `ranges` (top level) | Applied — the one field that survived unchanged. | Correct, but it is now PLOT-LEVEL (ANDed onto every layer) rather than the only range filter. |
| `facet` | Read as a bare column name (`facet in df.columns`). | v4's `facet` is a groupplot-only **object**. `{"kind": "param", …}` is not a column name, so the test failed and the renderer drew **one** panel where the dashboard drew a grid. All four kinds — `layer`, `param`, `grid`, `bins` — collapsed to a single panel. |
| `split[]` | Read: `split[0]` → categorical color series, a `bins` split → bucketed series. | The field no longer exists in v4. The whole code path was dead, which is why v4 plots rendered with no series. |
| `size` / `opacity` | Not read (new in v4). | Marker size and opacity always at v3's hard-coded 22 / full. |
| `color_by` | Applied whenever present. | v4 honors it only when `layers.length === 1` (`PlotConfig.colorBy`'s stated contract). |
| `sorts[]` | Read as `{key, desc}`. | v4 emits `{col, dir: "asc"\|"desc"}`. `s.get("key")` was always `None`, so **every table sort was silently dropped** and the table figure came out in read order. |
| `columns[]` | Used verbatim as tidy column names. | The browser's `visibleCols` are internal dotted ids (`headline.asr`, `function.arity`). None matched a tidy column, so a table spec fell through to its "first 8 columns" default and showed columns the user did not pick. |
| omitted fields | v3 treated absent `band`/`ghosts`/`trend` as falsy and had no default for `x`/`y`/`size`/`opacity`. | The spec **omits defaults by design** (a default plot serializes to just `{v, view}`). `DEFAULT_PLOT` has `band: true, ghosts: true`, `x: "epoch"`, `y: "plantedness"`, `size: 1`, `opacity: 1`. So the minimal spec — the most common one — rendered without its band and ghosts. |
| `facet.kind == "bins"` edges | v3's binned split used `np.unique(np.quantile(...))`. | `np.unique` collapses tied edges, so a 4-bucket request over a tied distribution became fewer buckets with different labels than `bins.ts computeBinEdges` produced in the browser. `bins.ts` deliberately keeps duplicate edges. |

Patch 0001 addresses every row. It also mirrors, as literals with a comment saying why, three things
that live in tom.quest and have no other way to reach CMT: `DEFAULT_PLOT`'s values
(`app/boolback/lib/types.ts`), the `CATEGORY_PALETTE` (`styling.ts`), and the shape/dash channels
(`styling.ts` + `components/glyph.tsx`).

### One thing the sync did not do

`render.py` reads CMT's tidy frame, whose columns are bare snake_case. Table specs carry dotted
internal ids. Patch 0001 bridges them by taking the last dotted segment (`headline.asr` → `asr`),
which is correct for every id in `columns.ts` today but is a convention, not a contract. If the two
sides are meant to agree by construction rather than by coincidence, the durable fix is for the
browser to serialize table `columns` under their metric-schema names — a tom.quest change, and a
spec-shape decision, so it is not made here.

---

## 3. The confirming render

The confirmation is not "a non-empty file appeared" — the v3 renderer produced a non-empty file from
a v4 spec, which is exactly how this drift stayed invisible for seven weeks.

A view-spec was produced by running tom.quest's own `configToSpec` + `serializeSpec` over a plot
config with two layers (one of them a GROUP pooling two members) and a `{kind: "param"}` facet, and
checked to round-trip through `parseSpec`. That JSON — the browser's, not hand-written — was rendered
through `tom_quest.render` twice: once with the synced renderer and once with the pre-patch one. The
figure's own artists were then read back.

| | panels | series per panel | points |
|---|---|---|---|
| **synced (v4)** | 2 — `trigger_form = insertion`, `trigger_form = affix` | `llama`, `pooled` | insertion: llama 1, pooled 2 · affix: llama 1, pooled 1 |
| **pre-patch (v3)** | 1 — no title | none | — |

The point counts are the check that the layers are real: `llama` selects `base_model =
Llama-3.2-1B`, and `pooled` is the union of `trigger_form = insertion` and `base_model = Qwen-0.5B`,
which in the insertion panel is both runs and in the affix panel is one. The pre-patch renderer, given
the same JSON, drew one untitled panel with no labelled series — no facet, no layers, no legend — and
exited 0.

Reproduce (from the CMT repo root, after applying patch 0001):

```
PYTHONPATH=".:./tom.quest" python /path/to/cmt-handoff/confirm_v4_render.py \
  --spec dashboard-spec.json --tidy /tmp/tidy.parquet --out /tmp/fig.png
```

`tom.quest/tom_quest/tests/render_test.py` (in patch 0001) carries this as
`test_groupplot_figure_has_one_panel_per_facet_value_and_one_series_per_layer`, plus a contract test
per drift row. 21 tests, all passing.

### A fixture defect found on the way

The pre-existing `render_test.py` fixture put `avg_sensitivity` only on a function-level row (epoch
null, no model) while `asr` sat on the run rows. The pivot indexes on identity columns, so the two
metrics landed on **disjoint** rows and the null-drop removed everything: the two tests that plotted
`avg_sensitivity` vs `asr` rendered **zero points** and passed, because they asserted only that the
file was non-empty. Patch 0001 broadcasts the function-level metric onto the run rows as well (which
is what a real CMT tidy frame does) and adds the figure-structure assertions above, so an empty
render now fails.

---

## 4. The false cross-project claim

`vqc/todos.yaml` in tom.quest opens with (lines 3–7, verbatim):

```
# This brings VQC (the governance system from the ComplexMultiTrigger repo)
# into tom.quest, using TTS vocabulary from day one (WikiTom tts/spec.md
# §5.1, §12.1) — this file is the reference implementation of the renamed
# tiers that CMT will migrate to (that migration is a CMT-side todo).
```

The parenthetical asserted something that did not exist. Checked 2026-08-29 against CMT `master`:

- `grep -rn "ready-for-tom\|hyphenated\|readiness" cmt/vqc/` → **no matches anywhere in `vqc/`**.
- CMT still writes `tier: R`: 40 entries in `vqc/todos.yaml` after this session's insertion (29 R,
  8 C, 3 H); `tests/guards/homes/registered.py` writes `tier="R"` at 20+ sites.
- The same claim appears one level up, in WikiTom `tts/spec.md` §5.1: *"Renaming them inside VQC
  (schema in `vqc/todos.yaml`, guard tests, `vqc/steering.yaml` references) is an early TTS code todo
  in the CMT repo."*

Two documents asserted the todo; neither had filed it. **Patch 0002 files it** — CMT vqc entry
`tts-readiness-rename`, tier R, citing C2 and D28 — which makes both claims true rather than making
one of them quieter. The alternative, striking the parenthetical from tom.quest's header, was passed
over for that reason: it would have left the WikiTom sentence false, and the WikiTom sentence is the
one Tom actually ruled (2026-08-27). No edit was made to tom.quest's header; once patch 0002 lands,
none is needed. **Until it lands, the header claim is still ahead of what exists.**

The entry is not a pure rename, and says so. The mapping Tom already ruled is *"R and C both →
`ready-for-tom` (readiness); H → dissolved into `waiting`-or-`archived` (status)"*, which loses two
things:

1. **R and C collapse.** Today the letter carries a schema obligation: tier R requires `plan`
   (`todo_guards.tier_plan_problems`), tier C carries an `agenda`. Both become `ready-for-tom`, so
   the obligation needs a new carrier. tom.quest's reference file models `plan` and has no `agenda`
   field at all — adopting it verbatim would silently drop 6 open agendas.
2. **`tier: H` is load-bearing, not decorative.** `todo_guards` collects the ledger ids cited by open
   tier-H todos so the ledger health reporter marks them `(H-parked)` and exempts them from staleness
   pressure. After the rename that exemption has to key off `status: waiting`, or parked debt starts
   reading as overdue.

The entry also corrects the site list: `vqc/steering.yaml` is **not** a site, despite WikiTom naming
it. Its `tier` occurrences (lines 43, 45, 379, 382, 622) are test/commit/compute **cadence** tiers —
the other reserved sense — and renaming them would be wrong.

The case for doing it at all is C2 `one-name`: the regenerated reserved-vocabulary inventory in
`vqc/constitution.md` reserves **tier** for constitution normativity (axioms → ideals → doctrines →
statutes) and reserves **cadence** for the axis whose third rung is `compute-tier`. `todos.yaml`
spends `tier` a third time. That is the collision C2's two-tier reservation exists to prevent.

Note that this touches D28's article text, which is a doctrine amendment — deliberate, expensive and
logged by the constitution's own rule. That is why the entry is tier R with the plan attached rather
than something a session does in passing.

---

## 5. Secret-system revisit triggers

`WikiTom/todo/tom/secret-system-rethink.md` was parked 2026-05-25 ("Tom deferred in the Cluster-E
walk"). Its "When" section names three triggers. Quoted verbatim, with what has happened since:

> **"A fourth external server arrives, OR"**

**Fired.** The todo was written when there were three env files. There are now **five** committed
templates and **four distinct deploy mechanisms**:

| File | Destination | Mechanism |
|---|---|---|
| `secrets/next.env` | Vercel prod + `.env.local` | `pnpm secrets:sync` (`vercel env add`) |
| `secrets/convex.env` | Convex prod | `pnpm secrets:sync` (`npx convex env set`) |
| `secrets/turing-api.env` | WPI Turing login node | manual `scp` |
| `worker/worker.env.example` | the TTS worker box, `/etc/tts/worker.env` mode 600 | `worker/setup.sh` copies the template, values filled in on the box |
| `turing-api/forge.env.example` | the same Turing login node | *"Copy relevant lines into the turing-api .env"* — hand-merged into another file |

The worker box is the fourth external server, and it arrived with its own mechanism, exactly as the
todo predicted. `forge.env` is worse than a fifth destination: it is a fragment that gets pasted into
a file that already has a source of truth, so `secrets/turing-api.env` is no longer the only thing
that determines what is on the cluster. `AGENTS.md`'s Deployment section still describes only two
files ("`pnpm secrets:sync` pushes both"), so the documented system and the actual system have
already parted.

> **"The next time secrets need rotation across all three (the friction will be sharp), OR"**

**Fired at least once, partially recorded.** `tts/implementation-plan.md` line 13 records the Slack
bot token being *"rotated on install"* (2026-08-27) and says *"Token goes into the `pnpm
secrets:sync` flow"* — while `worker/worker.env.example` puts `SLACK_BOT_TOKEN` in
`/etc/tts/worker.env` on the box. The same secret now has two homes reached two different ways.
`worker.env.example` documents cross-store rotation as routine for three more keys:
`TTS_WORKER_KEY`, `SESSIONS_WORKER_KEY` and `GH_TOKEN` each must match a value set in Convex, and the
template spells out the manual both-ends procedure (*"rotating it means updating both here and in
Convex, then `systemctl restart tts-session-host`"*). Whether a full across-all-stores rotation has
actually been performed cannot be read off this checkout — its git history is a single squashed
commit — so the strength of this one is Tom's to confirm.

> **"Tom has time to evaluate vendors against the four-question test deliberately."**

**Not establishable from any artifact.** This is a fact about Tom's calendar, not about the repo.

The todo's own "what still needs to be true after the rethink" list already has a failing member:
*"New external-server destinations don't require bespoke sync code per destination."* Two of the five
destinations are bespoke, and `forge.env` requires a human to merge fragments by hand.

---

## 6. What this session could not reach

Three plan steps needed the primary checkout on Tom's machine and could not be done from a cloud
clone. They are stated here with what was verified, so they are not silently dropped.

**The two uncommitted edits and the `boolback-redesign` branch.** `git ls-remote origin` lists 24
branches; `boolback-redesign` is not among them, and neither is `claude/bb-sample-fixture-grow`. Both
are local-only in Tom's checkout. The 24 remote branches are: `boolback-anatomy`,
`boolback-offline-fallback`, `transformer-viz`, `cursor/development-environment-setup-c6cd`, `main`,
and 19 `claude/*` branches. Nothing about the uncommitted edits — their content, whether either is
staged, or whether 126 newer commits have overtaken them — is knowable from here.

To produce that material locally, in the primary checkout:

```
git status --short --branch
git diff                                   # unstaged
git diff --cached                          # staged
git log --oneline main..boolback-redesign  # what the branch holds that main does not
git diff --stat main...boolback-redesign   # and which files it touches
git stash push -u -m "pre-main-switch"
git switch main && git pull
git stash pop                              # conflicts here name the overtaken edits
```

**The `claude/bb-sample-fixture-grow` review.** Also unreachable, so its 1339-line regression test and
its two silently-wrong collision cases could not be read. What *was* checked is the main-side
baseline the merge would land on, which is the useful half:

`app/boolback/lib/select.ts` and `app/boolback/lib/columns.ts` resolve a bare metric name to a run
block along **two different paths that do not consult the same thing**:

- `columns.ts:214 metricColumnId()` reads `index[name].group` — the metric-schema's **GROUP** — and
  dispatches on it. Group-aware, correct by construction.
- `columns.ts:228 METRIC_COLUMN_IDS` is a **flat spread** of the four per-group path tables
  (`{...OUTCOME_PATHS, ...DEFENSE_PATHS, ...INTERP_PATHS, ...SCAN_PATHS}`) keyed by bare name, with
  no group anywhere in it. `select.ts:81 cellValue()` resolves through that flat map. Two groups
  declaring the same bare name would collide silently, last-spread-wins, with no error and no test
  that would notice.
- `select.ts:87` then falls through to `row.function.complexity[col]` for anything unmatched, so a
  non-FUNCTION metric that is missing from its path table reads as `null` on every row — a cell that
  renders "—", sorts as absent, and filters to nothing, while the real value sits in `row.interp` or
  `row.scan` untouched.

No collision is live in the current fixtures: `sample-snapshot.json`'s 72 schema entries have no bare
name in two groups, and `app/boolback/data/normalize.ts:90` renames `interp_measurement` →
`interp_reading` and `source`/`task` → `dataset` before `resolveColumn` ever sees them, which covers
the two names that would otherwise miss their path tables today. The exposure is structural, not
currently firing. That is consistent with a branch whose stated fix is "resolve by GROUP instead of by
guessed prefix" and whose stated symptom is "two of six collision bugs silently returned wrong
values" — but the branch's own six cases were not read, and nothing here confirms or disputes its
count. Whether it merges cleanly onto current main cannot be tested from a clone that does not have
it.

No change was made to either file: reimplementing an unreachable branch's fix would collide with the
merge it is meant to inform.
