# /perfume simplification — technical execution plan

Approved by Tom 2026-07-08. The UX target is the "Perfumer UX Suite" artifact
(60daeab2); after Phase 0 its content is law via DESIGN.md. This file is the
execution contract: every workflow agent gets pointed here and at DESIGN.md.

Branch: `claude/perfume-simplification-47875c`. One commit per phase,
message `feat(perfume): P<n> — <title>`. Gates (run by the orchestrator
inline, never trusted from agent claims): `pnpm exec tsc --noEmit` and
`pnpm vitest run`. Playwright is skipped from P1 until rebuilt in P8.

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
2. **full gates** (inline, me): tsc, vitest, playwright, plus a manual drive
   of the real flow via preview tools; final screenshot set to Tom.
3. **ship** (inline, me): Tom sign-off → push main (standing OK) → **explicit
   go/no-go** → `npx convex run perfumeMigration` with the member-merge
   mapping → verify prod (function spec, site 200, member list shows ONE
   Tom, brews intact) → follow-up commit deleting the migration + the
   optional-deprecated schema fields.

## Sequencing & risk notes

- P1 → P2 → P3 → P4 → P5 → P7 strictly ordered (each shrinks or provides
  for the next). P6 can run any time after P0; it slots naturally while Tom
  reviews P5 screenshots.
- Convex schema stays prod-compatible at every commit (deprecated fields
  optional until the migration runs) — main stays deployable throughout;
  nothing is pushed to main until P8.
- The duplicate-Tom merge mapping requires reading prod member rows
  (dashboard or query) before P8; captured as a migration ARG, never
  hardcoded.
- Expected net diff: ≈ −3,500 / +1,200 lines.
