# /perfume simplification — technical execution plan (EXECUTED — historical record)

## Status: executed 2026-07-08. Nothing here is a live instruction.

This plan ran to completion on 2026-07-08. Every phase P0–P8 landed on `main`
as eleven phase commits plus one polish fix, all twelve of them ancestors of
`origin/main` today. Do not run
anything this document names — in particular `npx convex run perfumeMigration`
(§P2.4, §P8.3), which ran once against prod on 2026-07-08 and whose files were
deleted in the same session as spent. The text below the horizontal rule is the
plan as approved, preserved as the record of what was intended, with bracketed
`[SHIPPED …]` / `[DID NOT SHIP …]` notes added 2026-08-30 at the points that
otherwise read as pending instructions.

### The commits

| Phase | Commit | Subject |
| --- | --- | --- |
| P0 | `bbc449d` | `feat(perfume): P0 — spec sync (DESIGN.md rewrite + execution plan)` |
| P1 | `d728296` | `feat(perfume): P1 — frontend deletions` |
| P2 | `c770e95` | `feat(perfume): P2 — backend contraction (login-only, flat provenance, cores)` |
| P3a | `21f05e8` | `feat(perfume): P3a — shared UI primitive modules (create stage)` |
| P3b | `de6244c` | `feat(perfume): P3b — adopt shared primitives, delete duplicates` |
| P4a | `2381ff6` | `feat(perfume): P4a — closestPath pin solver in the engine` |
| P4b | `643077c` | `feat(perfume): P4b — pin a target perfume; ghosts from closestPath` |
| P5 | `984ef77` | `feat(perfume): P5 — icon-only frames, tan/grey grounds, marks outside, wild search, import catalog, effect` |
| P5 fix | `98e0f7d` | `fix(perfume): hide ×1 count badge on solo brew-graph items (P5 polish)` |
| P6 | `7c5ede0` | `feat(perfume): P6 — outline-free ingredient art, trimmed emblems, tan token` |
| P7 | `4245f9e` | `feat(perfume): P7 — stage help popup (legend + walkthrough + rules)` |
| P8 | `f416d7b` | `chore(perfume): P8 post-ship cleanup — tighten schema, drop compat shims` |

Net across `app/ convex/ e2e/ scripts/`, excluding markdown, `bbc449d^..f416d7b`:
47 files, +3,327 / −3,041. The plan's own estimate of ≈ −3,500 / +1,200 was
wrong in both direction and size; the deletions happened, and the rewrites
(help popup, primitives, `closestPath`, frame overhaul) cost more than the plan
allowed for.

### What shipped, spot-checked against the tree on 2026-08-30

- **Login-only identity.** `app/perfume/lib/anon.ts` and
  `components/profile-prompt.tsx` are gone; no `anonId` argument survives.
- **No event log.** The `perfumeEvents` table and `logEvent` are absent from
  `convex/`. (`logEvent` in `convex/tts.ts` is an unrelated function of the
  same name belonging to the todo system.)
- **Flat provenance and the tightened schema.** `convex/schema.ts` has
  `pinned: v.union(v.object({ perfumeId: v.string() }), v.null())` — no
  `recipeIndex` — and `cauldron` is required, with the legacy `outputs`,
  `provenance`/`owners` chains, `giftEvents` and `contributorName` removed.
- **The migration is spent and deleted.** `convex/perfumeMigration.ts` and
  `convex/perfumeMigration.test.ts` were added in `c770e95` and deleted in
  `f416d7b`, whose message records the run: "Prod is fully migrated
  (perfumeMigration ran, idempotent rerun 0/0/0)". No file of that name exists
  anywhere in `convex/` and none is owed.
- **Shared primitives exist and are adopted.** `components/popover.tsx`,
  `badge.tsx`, `glyphs.tsx`, `item-art.tsx`, `lib/color.ts`, `lib/filters.ts`,
  `lib/frequency-label.ts`, plus `components/frequency-search.tsx` extracted in
  P5.
- **Vocabulary sweep is clean but for one wire literal.** `phial`, `bottle`,
  `bench`, `pot`, `tuning` and `transfer` return zero hits across
  `app/perfume/**` and `convex/brews.ts` (outside DESIGN.md's history notes);
  `components/phial.tsx` is gone and `PerfumeGlyph` replaced `PhialGlyph`.
  `book` survives — see below.
- **Help popup.** `components/help-popup.tsx` exists behind the stage `?`.
- **Art pipeline.** `--pf-real: #ebd3b6` in `app/globals.css` carries the
  comment citing the Byobu page-ground sample; 96 ingredient PNGs were
  regenerated in `7c5ede0`.

### What the plan called for and did not ship

1. **The Playwright rebuild (§P8.1).** `e2e/perfume.spec.ts:29-30` still reads
   `// TODO(P8): rebuild against convex dev — practice mode removed in P1`
   above `test.describe.skip("perfume brew — local mode", …)`, so lines 30–311
   of that file — the whole single-user suite — have not run since P1. The
   second describe, "perfume brew — live sync", is separately gated behind
   `E2E_CONVEX=1`. No `testSeed` mutation was ever written.
   *[HALF SHIPPED — `convex/perfumeTestSeed.ts` now exports the `testSeed`
   mutation with its own suite in `convex/perfumeTestSeed.test.ts`, and
   `@playwright/test` moved from 1.59.1 (whose browser download refuses Ubuntu
   26.04) to ^1.62.1, which installs and launches Chromium. The specs
   themselves are still skipped — that is the remaining half.]*
2. **The `book` presence-surface literal (§P0, §P5.5).** `book` was declared a
   dead word, but it is still the wire value: `convex/brews.ts:780` accepts
   `v.literal("book")`, `app/perfume/lib/brew-types.ts:248` declares
   `PresenceSurface = "input" | "stage" | "book"`, and
   `components/perfume-panel.tsx:389` emits `data-pf-surface="book"`. The
   comment at `brew-types.ts:247` promises that "the backend migration
   (SIMPLIFICATION-PLAN P8) renames the literal on both sides" — that migration
   ran without renaming it and has since been deleted, so that comment now
   points at nothing.
3. **The `brew-graph.tsx` file split (§P5.3).** The plan called for a split into
   `brew-graph/{stage-header,cauldron,ceremony,nodes,wild-picker}.tsx`. No such
   directory exists and `components/brew-graph.tsx` is a single 1,374-line file.
   The P5 commit message does not claim the split either.

The Byobu-side commits and push (§P6) are in a different repository and cannot
be checked from here; the tom.quest side of P6 landed in `7c5ede0`.

---

## The plan as approved, 2026-07-08

Approved by Tom 2026-07-08. The UX target is the "Perfumer UX Suite" artifact
(60daeab2); after Phase 0 its content is law via DESIGN.md. This file is the
execution contract: every workflow agent gets pointed here and at DESIGN.md.

Branch: `claude/perfume-simplification-47875c`. One commit per phase,
message `feat(perfume): P<n> — <title>`. Gates (run by the orchestrator
inline, never trusted from agent claims): `pnpm exec tsc --noEmit` and
`pnpm vitest run`. Playwright is skipped from P1 until rebuilt in P8.
*[DID NOT SHIP — the P8 rebuild never happened; `e2e/perfume.spec.ts` has been
skipped since P1 and still is.]*

## Workflow conventions (all phases)

- **One Workflow invocation per phase**, `meta.phases` mirroring the stages
  below. Agents get `model: 'opus'` for judgment/math/architecture and
  `model: 'sonnet'` (`effort: 'low'|'medium'`) for mechanical execution.
- **Parallelism only across disjoint files.** Agents that edit the same file
  run sequentially in one pipeline stage. `isolation: 'worktree'` is used only
  in P3 stage 1 (agents create brand-new files concurrently).
- **Structured outputs.** Editor agents return
  `{filesTouched: string[], summary, testStatus, concerns: string[]}`.
  Reviewer agents return `{findings: [{file, line, severity, claim, fix}]}`.
  Verifier agents return `{verdict: 'pass'|'fail', reasons: string[]}`.
- **Adversarial review loop.** Every phase ends: reviewer agent(s) → if
  findings, one fix agent per finding cluster → re-review. Max 2 rounds;
  unresolved findings surface to the orchestrator (me) instead of looping.
- **Prompt payload.** Each agent prompt embeds: the relevant DESIGN.md
  sections verbatim, the exact file list it owns, the audit findings it is
  fixing (file:line), and the phrase "delete, don't deprecate — no
  backwards-compat shims inside this repo."
- **Resume.** If a workflow dies, resume with `{scriptPath, resumeFromRunId}`
  — scripts are kept argument-stable for cache hits.

---

## Phase 0 — Spec sync (inline, no workflow)

Rewrite `app/perfume/DESIGN.md` from the UX suite. Changes:
- Glossary: pin = **target perfume** (not recipe); add **ghost** (dashed,
  pin-missing frequencies ONLY — never ingredients), **preview** (translucent
  drop hint), **hypothetical = grey ground / real = tan ground** (dashed no
  longer means hypothetical); item frame = icon-only square, freq marks
  bottom edge, type glyph top-right; "perfume panel" replaces "perfume book".
- Dead words += `phial`, `bottle`, `book` (as the panel name), `owners`/
  ownership chain, `local`/practice mode, `anon`.
- §4: login-only membership; visitors read-only; no `?local=1`.
- §5: click-picks-one drag grammar; wild uses the frequency search.
- §6: help `?` on stage (legend → walkthrough → rules); gear = sound +
  membership only; import dialog = paste + searchable click-to-add.
- §8: `effect` field documented; emblems trimmed to `{icon, d}`; parchment
  tan sampled at art extraction becomes the site's "real" token.
- §9: no event log; provenance = `{brewedBy, witnesses}`; undo built on the
  same cores as the forward mutations.

## Phase 1 — Frontend deletions (workflow `perfume-p1-deletions`)

Stage "Delete" — 3 concurrent sonnet agents (disjoint files):
1. **client-cleanup** (`perfume-client.tsx`, `lib/brew-store.ts`,
   `components/profile-prompt.tsx` untouched until P2): delete
   `useLocalBrewStore`, `LocalState`, localStorage persistence, `?seed`,
   `?local` mode split (`LocalPerfume` gone; `PerfumeClient` always renders
   `LivePerfume`); delete write-only `hoverKey` + `onHover` props on both
   panels; delete `outputCounts`.
2. **lib-cleanup** (`lib/engine.ts` + test, `lib/inventory.ts` + test,
   `components/phial.tsx`): un-export `msAdd`/`baseTally`/`availableCharges`;
   split `combineFrequencies` into a tally-only core (production path) and a
   derived-tracking wrapper (tests only); delete `getCount`/`addCount`/
   `removeCount` + their tests; delete the unused default `Phial` component +
   `PhialProps` (keep `PhialGlyph` — renamed in P5).
3. **e2e-park** (`e2e/*`): tag every spec relying on `?seed`/local mode
   `test.skip` with `// TODO(P8): rebuild against convex dev`.

Stage "Verify" — barrier, then: sonnet integration agent runs tsc+vitest and
fixes import fallout; opus reviewer sweeps the diff for behavior change
(schema: findings). Gate + commit.

## Phase 2 — Backend contraction (workflow `perfume-p2-backend`)

All four editors are **opus, sequential** (single file `convex/brews.ts` +
schema + tests; no parallel editing):

1. **identity**: `identify(ctx)` becomes auth-only (logged-in user or throw);
   delete the `anonId` arg from every mutation + `ANON_KEY` + empty
   `ADMIN_MEMBER_KEYS`; delete `lib/anon.ts`, `components/profile-prompt.tsx`,
   `needsProfile`/`pendingRun`/`anonArg` wiring in client + store. `colorFor`
   stays server-side only (client duplicate dies with anon.ts).
2. **events+provenance**: delete `perfumeEvents` table, `logEvent`, all 27
   call sites; unify output/inventory perfume shape to
   `{perfumeKey, brewedByKey, witnesses: string[], at}` — `provenance`/`owners`
   chains and inventory `giftEvents` become **optional-deprecated** in the
   schema (kept readable so prod data still validates; stripped by the ship
   migration, then the optional fields removed in the post-ship cleanup
   commit). `giftItem`/`giftPerfume` stop writing history.
3. **cores**: extract `identifyMember(ctx)` prelude, `creditContributors`,
   `requireRecipe`, `newBrewFields`; merge `playStrike`/`playWild` and their
   un- variants into parametrized `doPlay(core)`; merge `undo`/`redo`; rebuild
   `applyReverse` ON `doMove`/`doPlay` (the parallel implementation dies);
   collapse the provably-equal `stockOwner`/`contributorKey` pair; rename
   `outputs`→`cauldron`, `takeOutput`→`takeFromCauldron`, event-table relic
   `benchKey` dies with the table; drop denormalized `contributorName`
   (resolve names at read like `listBrews` already does).
4. **migration**: `convex/perfumeMigration.ts` — idempotent, arg-driven:
   `{mergeMembers: [{fromKey, toKey}]}` (anon-Tom → user-Tom: move inventory
   stacks/perfumes, reassign brews + items' contributorKey, delete anon row),
   strip deprecated fields, convert `pinned {perfumeId, recipeIndex}` →
   `{perfumeId}`. Written now, **run only at P8 with Tom's explicit go**.
   *[SHIPPED AND SPENT — written in `c770e95` (with
   `convex/perfumeMigration.test.ts`), run once against prod on 2026-07-08, both
   files deleted in `f416d7b`. There is nothing to run and nothing to write.]*

Stage "Verify": rewrite `convex/brews.test.ts` alongside each step (same
agent); final adversarial opus reviewer prompted to construct action
sequences violating WHERE-not-WHAT or conservation (schema: verdict). Gate +
commit.

## Phase 3 — Shared UI primitives (workflow `perfume-p3-primitives`)

Stage "Create" — parallel sonnet agents, worktree isolation, one per NEW file:
- `components/popover.tsx` (`useDismissable` + `<Popover>` — generalize
  top-bar's `Dropdown`: portal, outside-mousedown, Escape, viewport clamp)
- `components/badge.tsx` (`CountBadge`, one style + `variant`)
- `lib/color.ts` (`parseHex`/`toHex`/`mix` — moved from brew-graph-layout,
  used by graph, layout, frequencies)
- `lib/frequency-label.ts` (`frequencyLabel(id)`) and `data/base.ts` gains
  exported `PERFUME_BY_KEY`
- `components/glyphs.tsx` (`SendGlyph`, gear, shared `ChipLabel` +
  `labelShadow`)
- `lib/filters.ts` (single `type:` parser; absorb `isTypeFilter` +
  ingredient-panel's `splitFilters`)
- `components/item-art.tsx` (merge `ItemArt` (item-frame) + `ItemIcon`
  (use-hand) into one switch)

Stage "Adopt" — barrier (primitives must exist), then parallel sonnet agents,
**one per consumer file** (disjoint): `top-bar.tsx`, `brew-graph.tsx`,
`ingredient-panel.tsx`, `perfume-panel.tsx`, `inventory-grid.tsx`,
`frequencies.tsx`, `cursors.tsx`, `use-hand.tsx`, `settings-corner.tsx`,
`frequency-filter.tsx`, `import-dialog.tsx` — each swaps every bespoke copy
for the primitive and deletes the local implementation.

Stage "Verify": integration tsc+vitest agent; opus reviewer greps for
surviving duplicates (popover effects, badge styling, hex parsing). Gate +
commit.

## Phase 4 — Engine & pin rework (workflow `perfume-p4-pin`)

1. **solver** (opus): `engine.ts` gains
   `closestPath(brew: BrewState, perfume: Perfume):
    {reqIndex, k, additions: Multiset, strikes: Multiset} | null`.
   Search recipes × k (reuse `evalReq`'s k-bounds): prefer solutions with
   empty `strikes`; among those minimize `msSize(additions)`; ties → common
   recipe (index 0), then smaller k. `strikes` non-empty ONLY when no
   add-only solution exists at any k for any recipe. Property tests: applying
   `additions` (+`strikes`) to the brew must make `evalReq` perfect; adding
   one ghost frequency shrinks `additions` by exactly one; pure-add solutions
   always win over strike solutions.
2. **pin plumb** (opus): schema `pinned: {perfumeId}` (recipeIndex optional-
   deprecated until migration); `pinRecipe` → `pinPerfume`;
   `brew-graph-layout.ts` computes ghosts from `closestPath` — **ghost
   frequency circles only**, delete `GhostItemChip` + ghost item-frame
   rendering entirely; recompute on every brew change; expose
   `steeringRecipe` for the stage header.
3. **panel pin UI** (sonnet): pin control moves from per-recipe to per-perfume
   row; fold highlights the steered recipe.

Stage "Verify": 3 parallel opus lenses — math (try to construct a brew where
the solver picks a strike solution though an add-only exists), spec fidelity
(against DESIGN.md pin section), regression (existing evalReq/layout tests).
Gate + commit.

## Phase 5 — Frame & drag overhaul (workflow `perfume-p5-frames`)

Sequential opus chunks (files interlock), then a sonnet sweep:

1. **item-frame** (opus): icon-only square; ground color = `--pf-real` (tan)
   vs `--pf-hypothetical` (slate grey); solid borders always; dashed style
   removed from items (reserved for ghosts); marks move OUTSIDE: freq dots
   overlap the bottom edge, type glyph the top-right corner; caption below;
   translucent solid-border `preview` state; `FrameContext` union pruned to
   contexts that actually render.
2. **hand grammar** (opus): `use-hand.tsx` — click picks up ONE; further
   left-clicks over the source stack accumulate; right-click returns one;
   destination click settles; press-drag unchanged; `HandGhost` full opacity;
   `availableOf` respected per click.
3. **graph reroute + split** (opus): `ItemChip` renders through the unified
   item-frame/art path; `grabHandlers` extended with the `brew` origin
   (absorbing `moveHome`/shift semantics); `brew-graph.tsx` splits into
   `brew-graph/{stage-header,cauldron,ceremony,nodes,wild-picker}.tsx`;
   pure helpers (`perfumeTint`, `frequencyName`, `hash01`) move to libs.
   *[PARTLY SHIPPED — the frame/art reroute and `grabHandlers` landed; the file
   split did not. `components/brew-graph.tsx` is still one 1,374-line file and
   no `brew-graph/` directory exists.]*
4. **panels** (opus): rename perfume book → perfume panel (components,
   copy, testids); extract `FrequencySearch` from `frequency-filter.tsx` and
   reuse it as the wild picker (wild excluded) AND the Frequencies-tab
   search; import dialog gains the searchable click-to-add catalog column
   (reuses `FrequencySearch`-style filtering + `lib/filters.ts`); `effect`
   line added to perfume tooltip (from `base.json`, already synced) and to
   panel folds; `canTransfer`/`onTransfer` props → `canGift`/`onGift`;
   `PhialGlyph` → `PerfumeGlyph`, testid `output-phial` → `cauldron-perfume`
   (e2e already parked).
5. **sweep** (sonnet): vocabulary grep — zero hits allowed for
   `phial|bottle|bench|pot|tuning|transfer|book` outside DESIGN.md history
   notes; comment cleanup (`brewable.ts` "pot", `SharedUI` misnomer →
   `BrowseUI`).

Stage "Verify": opus reviewer + I drive the page via preview tools and post
**screenshots to Tom** (frames, drag, wild picker, panel). Gate + commit.
Tom may veto styling; P6 proceeds meanwhile (different repo).

## Phase 6 — Art & data pipeline (inline + one sonnet agent, Byobu repo)

- `extract_art.py`: delete the outline stroke pass (`OUTLINE`, the black
  stroke emission in `draws_to_png`); print + export the sampled parchment
  rgb; emblems output trimmed to `{icon, d}` (drop `fillRule`/`pieces`/
  `srcBox` — tom.quest's `emblems.ts` reads only icon + d).
- Regenerate: 96 ingredient PNGs + `emblems.json` + `data.json` untouched.
- tom.quest: `--pf-real` token set from the sampled tan (comment cites the
  source sample); `sync-perfume-data.mjs` validation updated for the trimmed
  emblem shape; run the sync; visual spot-check icons on tan.
- Byobu docs: remove stale `app/legacy/` references (README:24,
  docs/SYSTEM.md:365); remind Tom the Byobu remote push is still his.
- Commits land in Byobu (Tom pushes) and tom.quest (sync artifacts).

*[SHIPPED on the tom.quest side in `7c5ede0` — 96 regenerated ingredient PNGs,
trimmed emblems, `--pf-real: #ebd3b6` set from the sampled tan, and the
`scripts/sync-perfume-data.mjs` validation update. The Byobu-repo commits and
push are in a different repository and cannot be verified from this one.]*

## Phase 7 — Help popup (workflow `perfume-p7-help`)

1. **build** (opus): `components/help-popup.tsx` behind the stage-corner `?`
   (uses P3 `Popover`; full-screen sheet on narrow). Three layers:
   (a) condensed legend strip rendering the REAL components/glyphs (tan/grey
   mini-frames, ghost circle, purple cover, cauldron tint swatch);
   (b) ten step cards — copy verbatim from DESIGN.md walkthrough, each with a
   small illustration composed from real components (no bespoke art);
   (c) rules list, copy verbatim. Remove the gear's "How it works" details
   block (`settings-corner.tsx`), leaving sound + membership.
2. **copy review** (sonnet): diff popup text against DESIGN.md — verbatim or
   flagged.

Stage "Verify": screenshots to Tom. Gate + commit.

## Phase 8 — Verify & ship (workflow `perfume-p8-ship` + inline)

1. **e2e rework** (opus): Playwright runs against `npx convex dev` (local
   deployment). Auth: a test-only `testSeed` mutation gated hard on
   `process.env.CONVEX_CLOUD_URL` matching the dev deployment (throws in
   prod) seeds two members + inventories; helpers rewritten to the new
   grammar (click-one) and testids. Coverage: the §4 permissions matrix,
   brew→ceremony→take, gift, pin ghosts, undo, import (paste + GUI), help
   popup opens.
   *[DID NOT SHIP — no `testSeed` mutation was written and no spec was
   rebuilt. `e2e/perfume.spec.ts:30` is still `test.describe.skip`.]*
2. **full gates** (inline, me): tsc, vitest, playwright, plus a manual drive
   of the real flow via preview tools; final screenshot set to Tom.
   *[SHIPPED WITHOUT PLAYWRIGHT, which had nothing to run — see item 1.]*
3. **ship** (inline, me): Tom sign-off → push main (standing OK) → **explicit
   go/no-go** → `npx convex run perfumeMigration` with the member-merge
   mapping → verify prod (function spec, site 200, member list shows ONE
   Tom, brews intact) → follow-up commit deleting the migration + the
   optional-deprecated schema fields.
   *[SHIPPED — every phase commit is an ancestor of `origin/main`, the
   migration ran on 2026-07-08 (idempotent rerun reported 0/0/0), and `f416d7b`
   is the follow-up commit that deleted the migration files and the
   optional-deprecated schema fields. This step is finished; do not run it.]*

## Sequencing & risk notes

- P1 → P2 → P3 → P4 → P5 → P7 strictly ordered (each shrinks or provides
  for the next). P6 can run any time after P0; it slots naturally while Tom
  reviews P5 screenshots.
- Convex schema stays prod-compatible at every commit (deprecated fields
  optional until the migration runs) — main stays deployable throughout;
  nothing is pushed to main until P8.
- The duplicate-Tom merge mapping requires reading prod member rows
  (dashboard or query) before P8; captured as a migration ARG, never
  hardcoded. *[DONE — the mapping was read and passed as an argument at the
  2026-07-08 run.]*
- Expected net diff: ≈ −3,500 / +1,200 lines. *[Actual: +3,327 / −3,041 across
  `app/ convex/ e2e/ scripts/` excluding markdown.]*
