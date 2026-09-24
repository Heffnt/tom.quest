# docs/tests.md — every test and check in this repository

Tom's ruling, 2026-09-22: quality is never traded for speed or cost, a useful
test is never left unwritten because the suite is slow, and the response to
slowness is dedicated effort on speed at constant quality, started by a warning
when a threshold is crossed. This page is the inventory that ruling asks for —
what each kind of test verifies, where it runs, what it costs and which of the
three verifiers it belongs to.

The three verifiers are `vqc/verifiers.md`'s: **checks** is every deterministic
program answering by string, count, schema or regex; **the audit** is a model of
another family reading a change before it merges; **the evals** is a model
reading outputs against Tom's labels. Everything on this page is a check. There
is no fourth verifier and this page does not add one.

## The inventory

Every wall time was measured on the Jarvis Box on 2026-09-22, four cores, with
`node_modules` already installed. A GitHub runner is also four cores, so these
are close to what CI pays; the install itself is another 30 to 60 seconds per
job and is not counted in any row.

| Test or check | What it verifies | Where it runs | Wall time | Verifier |
|---|---|---|---|---|
| vitest, `convex/` — 44 files, 1,342 tests | Convex queries, mutations, HTTP doors, the merge gate, the digest, the hourly update, against `convex-test` | CI `tests`; local `pnpm test` | 38.4 s of CPU inside the suite | checks |
| vitest, `app/` — 68 files, 1,042 tests | React components, route registries, client libraries, the API route handlers under `app/api/` | CI `tests`; local | 16.1 s of CPU | checks |
| vitest, `scripts/` — 28 files, 503 tests | The guardrail scripts' own logic, the SessionStart hook, the vocabulary generator, the writing standard | CI `tests`; local | 17.9 s of CPU | checks |
| vitest, `worker/jobs/` — 26 files, 850 tests | The box's cron jobs: the digest writer, the nightly, the planner, the audit, the evals runner | CI `tests`; local | 12.1 s of CPU | checks |
| vitest, `worker/runs/__tests__/` — 25 files, 346 tests | The run record: the launcher, the sweep, transcript parsing, redaction, S3, the semaphore | CI `tests`; local | 13.5 s of CPU | checks |
| vitest, `worker/session-host/__tests__/` — 17 files, 186 tests | The session daemon: the banned-tools classifier, the cut, where redaction is wired in, the merge gate client, overflow | CI `tests`; local | 1.2 s of CPU | checks |
| vitest, `shared/__tests__/` — 10 files, 277 tests | The modules Convex, the site and the box share: the skills catalog and router, the graph, redaction, the session constants, and that each imports only its siblings | CI `tests`; local | 1.1 s of CPU | checks |
| vitest, `vqc/` — 2 files, 9 tests | The shape of `vqc/todos.yaml` and the registries beside it | CI `tests`; local | 0.1 s of CPU | checks |
| vitest, `worker/setup-settings.test.mjs` — 1 file, 4 tests | The settings `worker/setup.sh` writes into each account slot, by running the script's own Node block against a scratch directory | CI `tests`; local | 0.4 s of CPU, measured 2026-09-24 | checks |
| vitest, `test/` — 1 file, 3 tests | `test/temp.mjs`, the `tempDir` helper every test's scratch directory comes from; `test/box-state.mjs` beside it is a helper, not a test file | CI `tests`; local | under 0.01 s of CPU, measured 2026-09-24 | checks |
| **the whole vitest suite** — 222 files, 4,562 tests | all of the above, in one run | CI `tests` on main, on the nightly and on a manual run; the diff's related files on a pull request | **102 s** | checks |
| Playwright, `e2e/` — 52 cases across 7 specs, 2 viewports | The site as a browser sees it: the home page, the public quest routes, the page-visibility registry, the boolback plot, the perfume brew | CI `e2e`; local `pnpm test:e2e` | **52 s** against `next dev`, 18 s against a built server | checks |
| `npx tsc --noEmit` | Every type in the repository, `convex/_generated` included | CI `tests`; local | **28 s** | checks |
| `pnpm build` | The production Next.js build, the one Vercel runs on main | CI `tests`; local | **62 s** | checks |
| `pnpm check:guardrails` — 9 scripts | The nine static boundaries below | CI `static-boundaries`; local | **10.4 s** | checks |
| ↳ `check-removals.mjs` | A change may not add a complexity smell, and the committed count only goes down; needs `ast-grep` | CI `static-boundaries` | 5.8 s | checks |
| ↳ `check-private-paths.mjs` | No `model-of-tom` path, area-category line or operate-page window is in this public repository | CI `static-boundaries` | 3.4 s | checks |
| ↳ `check-vocabulary.mjs` | The closed vocabulary and the graph kinds it is the schema of | CI `static-boundaries` | 0.45 s | checks |
| ↳ `check-session-mirrors.mjs` | Every model family has a runner; the live-status list matches the schema; each compatibility symlink has one body; no second repo list; the simplify inventory | CI `static-boundaries` | 0.18 s | checks |
| ↳ `check-auth-boundary.mjs` | No inline `admin`/`tom` role comparison outside the two files that own it | CI `static-boundaries` | 0.10 s | checks |
| ↳ `check-agents-md.mjs` | Each `AGENTS.md` has its `CLAUDE.md` beside it and no sentence of it is in a second one; a file over its byte target, or a chain over 32,768 bytes, warns and never fails | CI `static-boundaries` | 0.07 s | checks |
| ↳ `check-heavy-libs.mjs` | The heavy client libraries are imported from one module each | CI `static-boundaries` | 0.06 s | checks |
| ↳ `check-large-files.mjs` | No untracked-by-LFS blob over 50 MiB | CI `static-boundaries` | 0.05 s | checks |
| ↳ `check-setup-imports.mjs` | `worker/setup.sh` copies every file the deployed modules import, and the `/opt/tts/shared` copy the scripts import | CI `static-boundaries` | 0.04 s | checks |
| gitleaks | No secret in the history or the diff | CI `secret-scan` | 10 s | checks |
| `check-writing-standard.mjs` | How many stored briefs and explanations fail the writing standard | Not in `check:guardrails`: the prepare door and the production rung run it, and `scripts/check-writing-standard.test.mjs` is in the suite | — | checks |
| `pnpm lint` (eslint) | Style and unused bindings | Local only, and not a gate | 50 s | not a verifier |
| `turing-api/*_test.py` — 9 files, 121 tests | The FastAPI service on the WPI Turing cluster: its keys, its Slurm and tmux wrappers, its GPU report | Not in this repository's CI; the cluster is its own deployment | 4 s under `python3 -m pytest` | checks, elsewhere |
| the audit | One change, before it merges | `worker/jobs/audit.mjs` on the box, per head | one Codex run | the audit |
| the evals | An output, against Tom's labels | `.github/workflows/evals.yml` asks, the box answers | 20 to 60 minutes, serial | the evals |

The merge bar is four CI jobs green — `static-boundaries`, `secret-scan`,
`tests` and `e2e` — and a fifth job, `report`, that writes all four onto the
`tests-run` head row. Nothing outside that row gates a merge.

## Why the Turing subset is gone

`test:turing` used to be the vitest step in CI: a hand-written list of about
forty files, and the reason it existed was that CI could not afford two hundred.
It was not a category of test. It was a list of which tests CI ran, and a list
like that decays in one direction only — every test file added outside it was a
test nobody ran. Three of them had been failing for as long as anyone can tell,
and this branch is what found them, because nothing in CI had ever executed
them: two carried a Windows-only path or filename and one inherited the box's
`RUN_HOST=box`, so all three passed on Tom's laptop and nowhere else.

Affected-only testing removed the reason the list existed, so the list is gone
and the whole suite is what CI runs.

## Affected-only testing on a pull request

Test impact analysis is the industry practice: run the tests a change can reach
and skip the rest. vitest already carries the mechanism — `--changed <base>`
diffs against that commit and walks its own module import graph — so
`scripts/tests-affected.mjs` owns one decision, which mode, and hands everything
after it to vitest.

A pull request runs related mode against the merge base. Main, the nightly and a
manual run run the whole suite. The `tests-run` row says which mode ran and how
many files chose it, so a green row is never ambiguous about how much it means.

No test is dropped. Related mode is a claim about the import graph, and the
graph knows only what is imported, so four kinds of change fall back to the
whole suite:

1. no merge base, so there is no diff to reason about;
2. a deleted path, whose dependents the graph can no longer name;
3. a changed file with an extension the graph does not follow — a `.yaml`, an
   `AGENTS.md`, `package.json`, `sg/baseline.tsv`, `worker/setup.sh`. Tests read
   every one of those off the disk, and no import graph has ever seen that edge;
4. `vitest.config.mts` or `next.config.ts`, which no test imports and every test
   depends on.

The third rule is why most pull requests still pay for the whole suite, and that
is the correct trade at this size: the suite is 102 seconds, the typecheck is
28 and the build is 62, so the vitest run was never the expensive part of the
`tests` job. The saving that matters is on a pure-code change, where related
mode ran 3 files in 10 seconds where the full suite ran 204 in 102.

Two other pieces of the practice are deliberately not built. **Sharding** across
runners would split a 102-second suite into pieces smaller than the 30 to 60
seconds each extra runner costs to start and install. **Content-hash caching of
unchanged results** has no first-party vitest implementation, so it would mean a
new dependency holding the answer to whether a test needs to run — and the
saving it would buy is bounded by the same 102 seconds. Both become worth
building if the suite crosses the thresholds below; neither is worth it now.

## The threshold warning

`convex/ttsMerge.ts` reads two durations off every `tests-run` row and writes
one `job-failed` event when either is crossed:

| Threshold | Subject | Where it goes |
|---|---|---|
| 300 s | the `tests` job's own wall time | one `job-failed` row keyed `guardrails:tests-slow` |
| 600 s | the whole vitest suite's wall time, on a full run | one `job-failed` row keyed `guardrails:suite-slow` |

That is the channel the morning digest and the hourly update already read, so a
slow suite is in front of Tom within the hour. The row names the five slowest
files, because a number with no names is a number nobody can act on.

Nothing here fails a build. A threshold that could fail a build would be a
fourth condition on the merge gate, and it would trade quality for speed in the
direction the ruling forbids. The warning is written after the fact, on a row
that has already been recorded, and it is keyed on the condition rather than the
run — so a suite that has been slow for a week is one row, not one per push, and
a run back under the threshold writes the recovery that re-arms it.

The timing is read on every post, including a rerun whose row already exists.
Write-once is a rule about the verdict on one commit, which must not move; how
long today's run took is a fact about today's run, and the nightly full suite
runs on a main sha whose row was written that morning.

## Scratch directories

Every directory a test makes on disk comes from `tempDir(prefix)` in
`test/temp.mjs`, and the helper removes it: when the test that asked for it
finishes, pass or fail, or, for a directory asked for outside a test (module
scope, a describe body, `beforeAll`), when the test file finishes. No test
removes its own directories.

The reason is the box's `/tmp`, a 3.8 GB filesystem held in memory, which
filled three times on 2026-09-24 and failed workers' test runs. Before the
helper, one full suite run left about 700 directories there, from tests that
made a directory and never removed it, and 57,000 had built up. One fixture
was 16 MiB on its own: the rotation test of `scripts/instructions-loaded-hook.mjs`
now writes its over-the-limit log as a sparse file, which has the length the
hook checks and takes no space.

The proof is to run the whole suite with `TMPDIR` pointed at an empty directory
and find it empty afterwards. Run vitest directly (`node
node_modules/vitest/vitest.mjs run`): `pnpm` and `npx` each leave a
`node-compile-cache` directory there, which is the package manager's cache and
not the suite's.

## No test reads the box's state

A test asserts what the code does, so it must give the same answer on the box,
on the laptop and on CI. The machine reaches a test in three ways, and each is
closed in one place.

**The environment.** A test process starts from the shell's environment, and
the box's `.bashrc` exports `RUN_HOST=box`. `vitest.config.mts` sets, for every
test, the variables that name the machine or one of its files. `RUN_HOST` and
`TTS_RUN_SLOT_HELD` are empty. These point into `test/fixtures/no-machine`, a
directory that does not exist:

| Variable | What it names when unset |
|---|---|
| `RUN_ENV_FILE` | the launcher's env file, `/etc/tts/worker.env` on the box |
| `WIKITOM_DIR` | the WikiTom checkout, whose `tts/graph.json` version the launcher stamps on every run |
| `CLAUDE_BIN`, `CODEX_BIN`, `TTS_CODEX_BIN` | the real CLIs: `claude` and `codex` on `PATH`, `/usr/local/bin/tts-codex` |
| `RUN_SWEEP_CLAUDE_ROOTS`, `RUN_SWEEP_CODEX_ROOTS` | the transcripts the run sweep reads: every account under `/root/.claude-accounts` on the box, `~/.claude` and `~/.codex` elsewhere |
| `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME`, with `GIT_CONFIG_NOSYSTEM=1` | git's own configuration: `~/.gitconfig`, `~/.config/git/`, `/etc/gitconfig` |

So the code under test finds no env file, no WikiTom checkout, no CLI and no
git configuration of this machine's. A launcher refuses a named binary that
does not exist, so a test that forgets its fake fails instead of starting a
real run, and a test that commits names its own author. A test that wants one
of these sets its own.

**The run state directory.** The box launcher's config
(`worker/runs/config.mjs`) names a run state directory, which holds the
semaphore, the work directories and the Fable availability file
(`worker/runs/models.mjs`). It must be a new directory per test, so it cannot be
set in the config. A test file whose code reaches the launcher calls
`withoutBoxState()` from `test/box-state.mjs`, which makes it an empty
`tempDir` for each test. The delegate, evals, runner check-in and tts-lib tests
call it; a test that wants a Fable availability fixture writes it into the
directory the helper returns. The delegate test expected the model `fable` and
failed on the box on 2026-09-24, because Fable was unavailable there, while it
passed everywhere else.

**A default path in the code.** A module that falls back to a box path when no
variable names one (`/var/cache/tts/ComplexMultiTrigger`,
`/var/cache/tts/tom.quest`) is given a path in the test: a variable pointed at a
directory that is not a checkout, or an injected reader. An empty variable is
not a clear, because the code reads `VALUE || <default>`.

The proof is a full run under `strace`, a Linux tool that logs every file
system call a process makes, with each test file run on its own so every path is
attributed to one file. Outside the checkout and `TMPDIR`, no call under
`/root`, `/etc/tts` or `/opt/tts` succeeds, and under `/var/cache/tts` the only
ones that succeed look at the checkout's own parent directories. What is left
are lookups of paths that do not exist: node's module resolver and git's
repository search walking up from the checkout, node's `~/.node_modules` and
`~/.node_libraries` at startup, and the search along the shell's `PATH` for a
program a test runs by name.

Two kinds of test read a real machine on purpose, and each runs only when a
variable names what it reads, so on every other run they are skipped:

| Test | What it reads | The variable |
|---|---|---|
| the three `REAL` cases in `shared/__tests__/skills.test.mjs` | Tom's own model-of-tom: its skill descriptions fit the cap, no category term is in two area pages, the map names eight repositories | `REAL_WIKITOM_DIR`, a WikiTom checkout |
| `convex/runs.proof.test.ts` | two real transcripts, ingested end to end | `RUNS_PROOF_CLAUDE` and `RUNS_PROOF_CODEX` |

## What is not a test

The session daemon's Bash classifier rules whether a command may run. That is a
permission gate on an action before the fact, not an answer about an output
after it, and `vqc/verifiers.md` is where that line is drawn.

`worker/session-host/package.json` declares one dependency and no scripts: the
daemon has no `npm test` of its own, and its 17 test files run in the root
vitest suite with everything else.
