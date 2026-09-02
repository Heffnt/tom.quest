# Vitest cadence baseline, measured 2026-09-02

Scratch (`tts/**`, VQC C9): a one-off measurement kept so the CI-cadence change
lands on numbers somebody actually ran, not on an estimate. Deletable once that
change is merged.

## What was run

`npx vitest run` (the `pnpm test` script) at commit `d1daece`, on a clean
`pnpm install --frozen-lockfile`, Node v22.23.2, pnpm 10.33.3, with only the
committed `.env` present — no `.env.local`, no secrets, no network fixture.
That is the same environment shape the CI `tests` job checks out.

## Result

**All 77 files vitest collects pass. 1280 tests, 0 failures, exit code 0.**

Of those 77, the CI `tests` job runs 14 — the hand-listed `test:turing`
allowlist in `package.json`. The other **63 run on no cadence at all**, and
every one of the 63 passes today: 921 tests, 0 failures.

Two consecutive full runs gave byte-identical counts (77/77 files, 1280/1280
tests), so nothing in the uncadenced set is order- or timing-flaky over two
runs.

## Cost of running everything

| Command | Files | Tests | Wall time |
|---|---|---|---|
| `pnpm test:turing` (what CI runs today) | 14 | 359 | 5.7 s |
| `pnpm test` (the whole tree) | 77 | 1280 | 23.5 s |

The delta is about 18 seconds, in a job that also runs `npx tsc --noEmit` and
`pnpm build`. Nothing needs a longer timeout, a service, or a secret.

## The gap widens on its own — measured, not inferred

The allowlist names files, so a new test file defaults to no cadence. Counting
`*.test.{ts,tsx,mjs,js}` in the tree at past commits:

| Commit date | Test files in tree | Under `app/` |
|---|---|---|
| 2026-07-03 | 22 | 19 |
| 2026-08-04 | 47 | 42 |
| 2026-08-28 | 53 | 42 |
| 2026-08-30 | 62 | 46 |
| 2026-09-01 (`d1daece`, tip) | 77 | 55 |

The batch's own inventory ("45 of 53") was exactly right when it was written:
at `92212d30` the tree held 53 test files and the allowlist named 8 of them.
Four days later the tree holds 77 and the allowlist names 14.

So the allowlist is not neglected — somebody added 6 names to it in that
window. It still lost ground, because 24 test files arrived in the same window:
uncadenced went 45 → 63. Hand-listing keeps pace only if every author who adds
a test file also edits `package.json`, and the measured rate says they do not.

| | 2026-08-28 (`92212d30`) | 2026-09-01 (`d1daece`) |
|---|---|---|
| Test files in tree | 53 | 77 |
| Named in `test:turing` | 8 | 14 |
| Running on no cadence | 45 | 63 |

## Every uncadenced file, with today's result

`ms` is that file's own duration in the full run; the suite runs files in
parallel, so the column does not sum to wall time.

| File | Tests | Result | ms |
|---|---|---|---|
| `app/api/jarvis/_utils.test.ts` | 5 | pass | 206 |
| `app/api/jarvis/config/route.test.ts` | 3 | pass | 39 |
| `app/api/jarvis/timeline/route.test.ts` | 15 | pass | 90 |
| `app/api/turing/[...path]/route.test.ts` | 7 | pass | 37 |
| `app/api/turing/ws-credentials/route.test.ts` | 3 | pass | 20 |
| `app/boolback/components/anatomy-pane.test.ts` | 3 | pass | 3 |
| `app/boolback/components/config-panel.test.tsx` | 53 | pass | 3629 |
| `app/boolback/components/group-plot.test.tsx` | 17 | pass | 753 |
| `app/boolback/components/plot-surface.test.tsx` | 6 | pass | 64 |
| `app/boolback/components/run-inspector.test.tsx` | 5 | pass | 184 |
| `app/boolback/data/anatomy-fixture.test.ts` | 13 | pass | 56 |
| `app/boolback/data/normalize-v3.test.ts` | 11 | pass | 8 |
| `app/boolback/data/normalize.test.ts` | 21 | pass | 26 |
| `app/boolback/data/real-snapshot.test.ts` | 7 | pass | 7 |
| `app/boolback/lib/aggregate.test.ts` | 17 | pass | 47 |
| `app/boolback/lib/anatomy.test.ts` | 83 | pass | 61 |
| `app/boolback/lib/axes.test.ts` | 5 | pass | 7 |
| `app/boolback/lib/bins.test.ts` | 10 | pass | 9 |
| `app/boolback/lib/columns.test.ts` | 8 | pass | 11 |
| `app/boolback/lib/export.test.ts` | 5 | pass | 4 |
| `app/boolback/lib/generators.test.ts` | 14 | pass | 14 |
| `app/boolback/lib/metrics.test.ts` | 4 | pass | 5 |
| `app/boolback/lib/parameters.test.ts` | 15 | pass | 13 |
| `app/boolback/lib/plot-export.test.ts` | 10 | pass | 9 |
| `app/boolback/lib/presets.test.ts` | 5 | pass | 6 |
| `app/boolback/lib/select.test.ts` | 29 | pass | 34 |
| `app/boolback/lib/spec.test.ts` | 23 | pass | 18 |
| `app/boolback/lib/split-dims.test.ts` | 12 | pass | 15 |
| `app/boolback/lib/stats.test.ts` | 7 | pass | 6 |
| `app/boolback/lib/styling.test.ts` | 6 | pass | 5 |
| `app/boolback/lib/trajectories.test.ts` | 7 | pass | 7 |
| `app/boolback/lib/types.test.ts` | 19 | pass | 16 |
| `app/boolback/state/store.test.ts` | 16 | pass | 25 |
| `app/canvas/lib/models.test.ts` | 5 | pass | 3 |
| `app/components/page-routes.test.ts` | 15 | pass | 7 |
| `app/components/tom-logo.test.tsx` | 5 | pass | 98 |
| `app/forge/components/chat-panel.test.tsx` | 2 | pass | 60 |
| `app/jarvis/components/__tests__/GatewayConnection.test.ts` | 17 | pass | 81 |
| `app/jarvis/components/__tests__/gatewayAuth.test.ts` | 7 | pass | 30 |
| `app/jarvis/components/__tests__/gatewayProtocol.test.ts` | 21 | pass | 63 |
| `app/lib/__tests__/debug.test.ts` | 6 | pass | 12 |
| `app/lib/hooks/use-turing.test.tsx` | 5 | pass | 41 |
| `app/perfume/lib/brew-graph-layout.test.ts` | 43 | pass | 24 |
| `app/perfume/lib/brewable.test.ts` | 13 | pass | 78 |
| `app/perfume/lib/emblems.test.ts` | 3 | pass | 4 |
| `app/perfume/lib/engine.test.ts` | 68 | pass | 377 |
| `app/perfume/lib/inventory.test.ts` | 20 | pass | 28 |
| `app/thmm/cpu.test.ts` | 31 | pass | 21 |
| `app/thmm/lib/caesar.test.ts` | 4 | pass | 3 |
| `app/thmm/lib/format.test.ts` | 3 | pass | 8 |
| `app/tts/components/info.test.tsx` | 5 | pass | 176 |
| `app/tts/explanations.test.ts` | 29 | pass | 11 |
| `app/tts/lib.test.ts` | 8 | pass | 5 |
| `app/turing/components/job-table.test.tsx` | 4 | pass | 288 |
| `app/turing/lib/terminal-session.test.ts` | 16 | pass | 13 |
| `convex/agentRole.test.ts` | 26 | pass | 114 |
| `convex/boolbackPresets.test.ts` | 2 | pass | 26 |
| `convex/brews.test.ts` | 61 | pass | 621 |
| `convex/forge.test.ts` | 2 | pass | 34 |
| `scripts/check-writing-standard.test.mjs` | 14 | pass | 10 |
| `worker/jobs/credential-file.test.ts` | 9 | pass | 8 |
| `worker/jobs/tts-lib.test.mjs` | 6 | pass | 4 |
| `worker/session-host/__tests__/banned-tools.test.mjs` | 7 | pass | 4 |

## The 14 files that do have a cadence

`convex/{convex,gpuPool,tts,ttsCode,ttsGraph,ttsRulings,ttsCalendar,ttsRepeats,ttsCanvas,ttsSkills,claudeSessions}.test.ts`,
`vqc/{todos,registries}.test.ts`, `worker/jobs/poll-canvas.test.ts`. All pass.

Note for the sibling todo about `vqc/adoption.md`: that table calls
`test:turing` "vitest: convex + vqc guards", but four convex test files are
outside it — `agentRole`, `boolbackPresets`, `brews`, `forge` — so the label
overstates the script by four files, not three. `convex/agentRole.test.ts` was
added after the batch's inventory was written.

## What this settles and what it does not

Settled: switching the CI `tests` job from `pnpm test:turing` to `pnpm test`
turns nothing red today and costs about 18 seconds. There is no cleanup
backlog hiding behind the allowlist.

Not settled: whether CI should run the whole tree or keep a hand-listed
allowlist. That is the ruling this measurement was made for. Also unmeasured
here — Playwright `e2e/**` (7 spec files, excluded from vitest by
`vitest.config.mts` and run on no CI cadence either) and whether these files
pass on GitHub's runner rather than this one.
