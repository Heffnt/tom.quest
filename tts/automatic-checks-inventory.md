# Every automatic check running against tom.quest

Measured 2026-09-02 against commit `d1daece` on `main`, plus the live cron table
on the Jarvis Box and the live GitHub Actions run history.

## Why this document exists

TTS — Toms Todo System — is the web application that holds Tom's todos, groups
them into batches and asks him for rulings. Its code lives in one repository,
`tom.quest`. Tom asked for a daily review of that code for growing complexity
and ruled on 2026-09-01 that it must be "automatic, daily, and be high level,
covering what vqc determanistic checks can not."

A **deterministic check** is a program that applies a fixed rule and answers
pass or fail, with no judgement in between. VQC is Tom's own vocabulary for the
system of ratified rules and the checks that enforce them, developed in the
ComplexMultiTrigger repository and adopted here in `vqc/`. The requirement
"covering what vqc determanistic checks can not" means the new daily review must
not spend its run re-reporting what a script already fails on.

That requirement cannot be met without knowing what the scripts already fail on.
This document is that list. It is the boundary the new check has to sit outside.

## Terms used below

Everything an agent built is described before it is used.

- A **continuous-integration workflow** is a file in `.github/workflows/` that
  GitHub reads and runs on its own machines when a stated event happens — here,
  a pull request opening or updating, or a push to `main`. This repository has
  exactly one such file.
- A **linter** is a program that reads source text and reports constructs it is
  configured to object to. The linter here is ESLint, configured in
  `eslint.config.mjs`.
- A **type checker** is the TypeScript compiler run with `--noEmit`: it reads
  every file the `tsconfig.json` `include` list names and reports type errors
  without producing output files.
- **Vercel** is the hosting platform that builds and serves the site. A
  **preview build** is the copy Vercel builds for a branch that is not `main`; a
  **production build** is the one it builds for `main`.
- The **Jarvis Box** is the always-on Hetzner server that runs TTS's scheduled
  jobs. Its scheduled work is a Unix cron table installed at `/etc/cron.d/tts`
  by `worker/setup.sh`, and the job bodies are the `.mjs` files under
  `worker/jobs/`.
- **Convex** is the backend that stores TTS's data and runs its server
  functions. It has its own scheduler: `convex/crons.ts` registers functions to
  run at fixed times or intervals, independently of the Jarvis Box.
- A **prospecting mission** is an autonomous Claude Code session that works no
  todo: it is handed a fresh checkout of one repository, reads it for concrete
  issues, and records each new one as an unprepared todo. It is defined in
  `convex/claudeSessions.ts` and admitted by a Convex cron.

## How this was verified

- Every file named below was read in a checkout of `main` at `d1daece`.
- The cron table was read off the running Jarvis Box (`/etc/cron.d/tts`), not
  only off `worker/setup.sh`, and the two agree line for line.
- `gh api repos/Heffnt/tom.quest/branches/main/protection` was called and
  answers `404 Branch not protected`.
- `gh run list` was called: the `Guardrails` workflow is the only workflow, it
  is active, and the twelve most recent runs are all `success` on session
  branches.
- The claim that `next build` does not run the linter was checked against
  Next.js 16's own upgrade guide, which states: "The `next lint` command has
  been removed. Use Biome or ESLint directly. `next build` no longer runs
  linting." The repository is on `next` 16.1.4.

## The five places anything fires automatically

1. **GitHub Actions**, from `.github/workflows/guardrails.yml`, on every pull
   request and on every push to `main`. Three jobs, listed below.
2. **The Vercel build**, on every push to a connected branch, running
   `node scripts/vercel-build.mjs` as declared in `vercel.json`.
3. **Cron on the Jarvis Box**, `/etc/cron.d/tts`: twelve job lines plus a
   monthly log truncation. None of them is a check on tom.quest's code.
4. **Convex scheduled functions**, `convex/crons.ts`: eleven registrations. None
   of them is a check on tom.quest's code.
5. **The prospecting lane**, admitted by the Convex cron
   `tts auto-session scheduler` every five minutes. This one does read
   tom.quest's own code, and it is a model making a judgement rather than a
   script applying a rule. It is the single most important row in this document
   and is treated separately in its own section below.

## The checks that run automatically

| Check | What fires it | What it inspects | The rule it applies | Blind to |
|---|---|---|---|---|
| `scripts/check-auth-boundary.mjs` (inside `pnpm check:guardrails`) | GitHub Actions job `static-boundaries`, on every pull request and every push to `main` | Every `.ts`/`.tsx` under `app/` and `convex/`, skipping `.git`, `.next`, `node_modules`, `_generated` | Fails when any line outside `app/components/page-routes.ts` and `convex/authRoles.ts` matches `role === "admin" \|\| role === "tom"` in either order | Any other way of deriving admin rights — a helper function, a boolean field, a comparison spelled across two lines. It matches one text pattern, not the concept. |
| `scripts/check-heavy-libs.mjs` (inside `pnpm check:guardrails`) | Same job, same trigger | Every `.ts`/`.tsx`/`.js`/`.jsx` under `app/` except `app/canvas` and `app/api/canvas`, plus two named files | Fails when: an `@xterm/*` import appears outside `app/turing/lib/terminal-session.ts`; a `three` or `@react-three/*` import appears outside `app/clouds/`; `app/turing/components/job-table.tsx` imports `./terminal-modal` statically; or `app/clouds/clouds-client-page.tsx` does not load `./clouds-client` through `next/dynamic` with server-side rendering disabled | Any heavy dependency added after this file was written. The library names are a hand-written list of two, so a third large package is invisible until someone adds it here. |
| `scripts/check-session-mirrors.mjs` (inside `pnpm check:guardrails`) | Same job, same trigger | `convex/ttsShared.ts`, `convex/claudeSessions.ts`, `convex/schema.ts`, `worker/session-host/session.mjs`, `worker/session-host/session-host.mjs`, `worker/session-host/lib.mjs`, `worker/jobs/tts-lib.mjs`, and every non-test `.ts`/`.tsx`/`.mjs`/`.js` under `app/` and `convex/` for checks 4 and 6 | Six independent conditions, any one of which fails the run: `DAEMON_STALE_MS` must equal three times `POLL_IDLE_MS`; the repo map `SESSION_REPOS` must equal the daemon's `REPO_GITHUB`; the two usage-limit regular expressions must be byte-identical and must match three recorded cap texts while missing two transient ones; `LIVE_STATUSES` plus the two terminal statuses must equal the schema's status union and must be declared nowhere else; `worker/session-host/worker-env.mjs` must remain a symlink to `../jobs/worker-env.mjs` and the environment-parse loop must appear in exactly one file; and no file outside four named ones may list two session repository names within 300 characters of each other | **Facts it was not told about.** Each of the six conditions names one specific fact whose second home is being fenced. A fact that acquires a second home tomorrow — a new constant, a new list, a new rule implemented twice — passes every one of them. |
| `scripts/check-large-files.mjs` (inside `pnpm check:guardrails`) | Same job, same trigger | Every path `git ls-files` reports, sized on disk | Fails when a tracked file is 50 MiB or larger, is not tracked by Git Large File Storage, and is not the one entry in its `KNOWN_LARGE` map; the known entry fails too once it passes 100 MiB | File size only. It says nothing about what is in the file. |
| gitleaks, via `gitleaks/gitleaks-action@v2` | GitHub Actions job `secret-scan`, on every pull request and every push to `main`, with full history fetched | The whole repository including every commit in history | Fails when any blob matches gitleaks' built-in secret patterns | Everything that is not a credential. |
| `npx tsc --noEmit -p tsconfig.json` | GitHub Actions job `tests`, on every pull request and every push to `main` | Everything the `include` list names: `**/*.ts`, `**/*.tsx`, `**/*.mts`, `next-env.d.ts`, `.next/types/**` — which excludes `node_modules` and, materially, **every `.mjs` file**: the seventeen Jarvis Box job bodies under `worker/jobs/`, the whole `worker/session-host/` daemon, and the eleven scripts under `scripts/` | Fails on any TypeScript type error | Whether the code is organized well. It answers whether the types line up, and it is silent on the entire `.mjs` half of the system. |
| `pnpm test:turing` | GitHub Actions job `tests`, on every pull request and every push to `main` | Fourteen named test files: eleven under `convex/`, `vqc/todos.test.ts`, `vqc/registries.test.ts`, `worker/jobs/poll-canvas.test.ts` | Fails when any assertion in those fourteen files fails | The other 63 test files in the repository, which this command does not name (see the next table). |
| `pnpm build` | GitHub Actions job `tests`, on every pull request and every push to `main` | The Next.js application: `app/` and everything it imports | Fails when the production build fails, including at the prerender step | Anything that builds. A duplicated screen builds exactly as well as a reused one. |
| `node scripts/vercel-build.mjs` | Vercel, on every push to a connected branch | On a preview build, `pnpm build` alone; on a production build, `npx convex deploy --cmd 'pnpm build'` | Fails when the build fails, or when it is running on Vercel and `VERCEL_ENV` is unset | Same as `pnpm build`. It duplicates the CI build for previews and additionally pushes Convex functions on production. |
| The prospecting lane (`convex/claudeSessions.ts`) | The Convex cron `tts auto-session scheduler`, every 5 minutes, spending whatever session capacity real todo work left unspent; at most 2 missions live at once, at most 1 per repository per 30 minutes | A fresh checkout of one whole repository — `tom.quest` or `ComplexMultiTrigger`; `WikiTom` is excluded by name | It has no pass or fail. A model reads the tree against a fixed list of six finding types and records up to 8 new findings as unprepared todos | Described in its own section below. |

## The checks that exist but nothing fires

A check nobody runs is not coverage. Four exist in this repository and are
invoked by no workflow, no cron entry, and no git hook. There are no git hooks
at all: `.git/hooks/` holds only the samples git ships with, and there is no
Husky or Lefthook configuration.

| Check | How it is invoked | Why nothing fires it |
|---|---|---|
| `pnpm lint` (ESLint) | By hand only | No workflow runs it, no job runs it, and `next build` in Next.js 16 no longer runs the linter, so the production build does not reach it either. `AGENTS.md` line 110 and `README.md` line 66 document the command; neither claims it is enforced. |
| `pnpm test` (the full Vitest run) | By hand only | The CI `tests` job runs `pnpm test:turing`, a hand-written list of fourteen files. The repository holds 77 Vitest-collectable test files. 63 of them never run automatically: all 55 under `app/`, four under `convex/` (`agentRole`, `boolbackPresets`, `brews`, `forge`), `scripts/check-writing-standard.test.mjs`, `worker/jobs/credential-file.test.ts`, `worker/jobs/tts-lib.test.mjs`, and `worker/session-host/__tests__/banned-tools.test.mjs`. |
| `pnpm test:e2e` (Playwright, 7 spec files under `e2e/`) | By hand only | `vqc/adoption.md` records this deliberately: "Playwright e2e — on demand / pre-deploy (not in CI — pre-existing)". |
| `pnpm check:writing` (`scripts/check-writing-standard.mjs`) | By hand only | Stated in the script's own header: it reads production Convex over the network and needs `TTS_WORKER_KEY`, which CI does not hold. Its rule logic is covered by `scripts/check-writing-standard.test.mjs`, which itself is not in `test:turing` and so also never runs automatically. |
| `pnpm check:secrets` (local gitleaks) | By hand only | The same scan runs in CI through the GitHub Action instead, so this entry is a local convenience rather than a gap. |

## No check is a required check

`main` carries no branch protection: the GitHub API answers `404 Branch not
protected`. Every check above therefore reports a colour and blocks nothing.
Merging is Tom's gate personally, and a red Guardrails run is information he
acts on rather than a mechanism that stops the merge. `AGENTS.md` line 111 says
`pnpm check:guardrails` "runs the static boundary checks that CI enforces on
every pull request" — CI runs them on every pull request, and enforcement is
Tom's hand on the merge button.

## The scheduled jobs, and what they read

The Jarvis Box cron table and the Convex cron registrations are the two places
something happens on a clock. Neither contains a check on tom.quest's code. The
table below is the full inventory, so the next steps of this batch do not have
to re-derive it.

| Job | Where scheduled | Cadence | What it reads |
|---|---|---|---|
| `poll-dump.mjs` | `/etc/cron.d/tts` | hourly at :07 | Slack `#dump` messages |
| `poll-gmail.mjs` | `/etc/cron.d/tts` | every 10 min | Gmail headers and snippets |
| `poll-canvas.mjs` | `/etc/cron.d/tts` | :13 and :43 | Canvas announcements |
| `apply-time-notes.mjs` | `/etc/cron.d/tts` | every 2 min | Tom's freeform time notes in Convex |
| `prepare-queue.mjs` | `/etc/cron.d/tts` | 08:30 and 09:30 UTC, one proceeds | Todo data in Convex |
| `brief-code-todos.mjs` | `/etc/cron.d/tts` | every 2 h at :17 | `vqc/todos.yaml` **in ComplexMultiTrigger**, and that repository's tree while briefing an entry |
| `prepare-life-todos.mjs` | `/etc/cron.d/tts` | every 2 min | Unprepared todo data in Convex |
| `form-batches.mjs` | `/etc/cron.d/tts` | every 2 h at :07 | Todo data in Convex |
| `plan-graphs.mjs` | `/etc/cron.d/tts` | every 2 h at :27 | Todo data in Convex |
| `apply-rulings.mjs` | `/etc/cron.d/tts` | every 10 min | Rulings in Convex; edits ComplexMultiTrigger's `vqc/todos.yaml` |
| `execute-approved.mjs` | `/etc/cron.d/tts` | hourly at :45 | One approved ComplexMultiTrigger plan; writes a branch and a pull request there |
| log truncation | `/etc/cron.d/tts` | 06:00 on the 1st | `/var/log/tts/*.log` |
| `serverHealth.pollTuring` | `convex/crons.ts` | every 30 s | The Turing cluster API |
| `gpuPool.reconcile` | `convex/crons.ts` | every 60 s | GPU allocation rows |
| `ttsRepeats.internalGenerateRepeats` | `convex/crons.ts` | 08:30 and 09:30 UTC | Repeating-todo rows |
| `tts.internalPrepareFallbackQueue` | `convex/crons.ts` | 08:45 and 09:45 UTC | Todo rows |
| `ttsSync.sendHourlyUpdate` | `convex/crons.ts` | hourly | Todo and session rows; gated off by its own switch |
| `ttsSync.refreshMirror` | `convex/crons.ts` | every 6 h | `vqc/todos.yaml` from the default branch of both ComplexMultiTrigger **and tom.quest**, over the GitHub API |
| `ttsSkills.refreshSkills` | `convex/crons.ts` | every 6 h | WikiTom's default branch |
| `ttsCalendarFetch.refreshFeeds` | `convex/crons.ts` | hourly | ICS calendar feeds |
| `ttsCanvas.internalRefreshCanvas` | `convex/crons.ts` | every 6 h | Canvas assignments |
| `claudeSessions.internalAutoSchedule` | `convex/crons.ts` | every 5 min | Session and todo rows — and this is what admits prospecting missions |

Two rows in that table touch tom.quest's own repository and are worth stating
plainly, because both are easy to mistake for the thing this batch is building:

- `ttsSync.refreshMirror` fetches tom.quest's `vqc/todos.yaml` every six hours.
  It copies a registry file into Convex so the entries are visible in the
  interface. It reads no other file, and it makes no judgement about any of them.
- `brief-code-todos.mjs` is the job that has a model read a repository tree, but
  the repository is hard-coded to ComplexMultiTrigger throughout — the module
  imports a single `CMT_REPO` constant and uses it in every path. tom.quest's
  own `vqc/todos.yaml` entries are mirrored into TTS by the Convex cron above
  and are briefed by nothing. That asymmetry is a real gap, but it is a gap in
  briefing decided work, not in reviewing code for complexity.

## The prospecting lane, which is the closest existing thing

One automatic mechanism already gives a model a full checkout of tom.quest and
asks it to find problems. It is defined in `convex/claudeSessions.ts` from the
comment `── The prospecting lane ──` onward, it was created by Tom's directive
of 2026-08-29 ("review the CMT and tom.quest repos for issues to make more
to-dos"), and it works like this:

- The Convex cron `tts auto-session scheduler` runs every five minutes. Real
  todo work takes the per-tick session budget first; prospecting spends what is
  left over on the same tick.
- The repositories prospected are derived from `SESSION_REPOS` minus an
  exclusion list holding only `WikiTom`, so they are `tom.quest` and
  `ComplexMultiTrigger`.
- At most two missions are alive at once, and a repository is not prospected
  twice within 30 minutes.
- The mission prompt names six kinds of finding: a failing or skipped test; dead
  code that nothing reaches; a document that contradicts the code it describes;
  an untracked `TODO` or `FIXME` comment; a broken link between modules, which
  the prompt spells out as "a stale import path, a field one side renamed and
  the other still reads, one rule implemented two different ways in two files";
  and vocabulary drift, "one fact carried under two names, or one name meaning
  two different things".
- Before capturing, the mission must read everything TTS already holds via
  `GET /tts/state` and drop duplicates, and because tom.quest is in
  `CODE_TODO_REPOS` it is also told to read `vqc/todos.yaml` in its checkout and
  drop anything that file already names.
- Each finding is recorded by `POST /tts/capture` as an unprepared todo with
  `source: "prospecting"` and a provenance string naming the mission and the
  path. The cap is eight captures per mission. The mission changes no file,
  commits nothing and opens no pull request.

This is the answer to the first of the two questions this task was asked to
state explicitly, and the answer is yes: something automatic already reads TTS's
own code for structure rather than for data, and it already makes model
judgements about duplication and drift. The twelve most recent Guardrails runs
are all pull requests whose titles are findings of exactly the six types this
lane looks for — "Delete the eight unreachable exports and the fib doc comment",
"clouds: delete the no-op `stripPredictionLabel` helper", "Delete four dead type
declarations in the sessions and forge surfaces", "chore(convex): fix four
comments naming a `convex/perfume.ts` that is gone". Which of them began as a
prospecting capture was not traced; the point is that findings of this shape are
already flowing into the repository under a mechanism that runs on its own.

Four differences between the prospecting lane and what Tom asked for remain, and
they are the whole of what a new check would add:

1. **It reads the whole tree, never the day's new content.** Its own cooldown
   comment says the 30 minutes exists so a repository is not "re-scanned in
   identical state twice in a row" — the mission has no notion of what changed
   since yesterday, so it re-reads everything every time.
2. **It is not daily.** It fires whenever session capacity is spare, which
   depends on how much real todo work is queued. There is no day on which it is
   guaranteed to have run, and no day on which it runs exactly once.
3. **Its six finding types are point defects, not design judgements.** Every one
   of them names a thing that is wrong at one or two identified locations. None
   of them asks whether a new screen should have reused an existing one, whether
   a function has grown into two functions under one name, or whether a third
   way of doing something now exists beside two that were already there.
4. **It emits todos, one per finding, capped at eight.** It has no form in which
   to say "the shape of this area got worse today" — only "delete this helper in
   this file".

The consequence for the rest of this batch is that step 5 has a choice it did
not know it had: build a second mechanism, or give the prospecting lane a
second, day-scoped, daily-guaranteed mission type beside the one it has. That
choice belongs in the ruling at step 4, because it changes what gets built.

## Whether the linter is enforced or advisory

Advisory, completely. This is the second question the task was asked to state
explicitly.

`pnpm lint` runs ESLint with the configuration in `eslint.config.mjs`, which
extends `eslint-config-next`'s core-web-vitals and TypeScript rule sets and
turns three React hook rules off (`set-state-in-effect`, `refs`, `purity`).
Nothing invokes it automatically: not the Guardrails workflow, not the Vercel
build command, not a cron entry, and not a git hook, because there are no git
hooks. Next.js 16 removed the build-time lint step, so `next build` does not
reach it either.

The daily review therefore cannot assume any ESLint rule is upheld on `main`. It
can assume the four guardrail scripts, gitleaks, the type checker, the fourteen
named test files, and the production build are upheld, because those four jobs
run on every pull request and all recent runs are green.

## What no existing check can see

This is the column the rest of the batch consumes. Collecting the "blind to"
cells above, and setting aside the prospecting lane, which is handled in its own
section:

- **Whether one fact has two homes, unless the fact was named in advance.**
  `check-session-mirrors.mjs` is the repository's duplication fence and it works
  by enumerating six specific facts. A seventh fact duplicated tomorrow passes.
- **Whether a new screen, module or helper should have reused an existing one.**
  Nothing measures similarity between files. `pnpm build` and `tsc` are equally
  happy with one implementation or three.
- **Whether a function or a file has grown into several things under one name.**
  There is no size, length, or responsibility rule anywhere; `check-large-files`
  measures megabytes for GitHub's push limits and nothing else.
- **Whether a third way to do something now exists beside two that were there.**
  The heavy-library check fences two named packages into two named directories.
  It cannot notice a third pattern appearing.
- **Anything at all in the `.mjs` half of the system.** The seventeen Jarvis Box
  job bodies, the session-host daemon, and the eleven scripts are outside the
  type checker's `include` list, are linted by nothing automatic, and have three
  test files between them that CI does not run.
- **Anything in `app/`, which is 55 of the repository's 77 test files.** Those
  tests exist and are never run automatically.
- **How today's change sits against what was already there.** No automatic check
  in this repository reads a diff, a date range, or a commit range. Every check
  above reads the tree as it stands, in full, with no memory of yesterday.

## What could not be determined from here

- Whether the four green Guardrails jobs are green because the code is clean or
  because a session amended a hand-written allowlist inside a check. Both
  `check-heavy-libs.mjs` and `check-session-mirrors.mjs` hold allowlists that a
  session may edit in the same pull request as the code that would otherwise
  fail them, and nothing records when that happens.
- How often the prospecting lane actually fires against tom.quest in a day. The
  cadence is capacity-dependent and the record lives in the `dtsEvents` table
  under `prospect-mission-created`; reading it needs a Convex query this task did
  not run.
