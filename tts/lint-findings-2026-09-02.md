# `pnpm lint` findings, recorded 2026-09-02

This file is the enumeration the batch "Give tom.quest's lint a gate and empty
its backlog" is worked against. It is scratch (`vqc/classification.yaml` lists
`tts/**` as the quarantine root): once the backlog is empty and a cadence is
decided, delete it.

## How this was produced

ESLint is a program that reads source files and reports patterns a project has
declared unwanted. This repository runs it through the `lint` script in
`package.json`, which is the bare command `eslint` with no arguments — under
ESLint 9's flat configuration that lints the working directory, with the ignore
list in `eslint.config.mjs` (`**/.next/**`, `**/out/**`, `**/build/**`,
`**/next-env.d.ts`, `**/convex/_generated/**`, `.claude/**`).

Command: `pnpm lint`, on branch `session/q97fs86fkxbtwxkk4cc8ggvw398dnhqk` at
commit `d1daece`, with ESLint 9.39.4 and `eslint-config-next` 16.1.4 installed
from `pnpm-lock.yaml` via `pnpm install --frozen-lockfile`.

Result: **17 problems — 0 errors, 17 warnings — and process exit code 0.**

The exit code is the fact the cadence decision turns on. Every finding is a
warning, and ESLint exits 0 when it reports only warnings, so adding `pnpm lint`
to a continuous-integration job as it stands would produce a job that passes no
matter how many findings accumulate. A job that actually gates needs
`eslint --max-warnings=0`, or the rule raised from `warn` to `error`.

Every one of the 17 findings comes from a single rule,
`@typescript-eslint/no-unused-vars`, which reports a name that is bound and then
never read. No other rule fires anywhere in the repository.

## The findings

Line and column are as of commit `d1daece`. They move whenever the enclosing
file is edited, so re-run `pnpm lint` before acting on any row rather than
trusting these numbers.

| File | Line:Col | Name | Rule | Kind |
|---|---|---|---|---|
| `app/boolback/components/run-inspector.tsx` | 250:16 | `index` | `@typescript-eslint/no-unused-vars` | accidental |
| `app/boolback/components/run-inspector.tsx` | 500:10 | `Stat` | `@typescript-eslint/no-unused-vars` | accidental |
| `app/perfume/components/help-popup.tsx` | 27:26 | `ChargeSymbol` | `@typescript-eslint/no-unused-vars` | accidental |
| `app/thmm/components/cpu-diagram.tsx` | 502:10 | `Title` | `@typescript-eslint/no-unused-vars` | accidental |
| `app/thmm/components/cpu-diagram.tsx` | 510:10 | `Sub` | `@typescript-eslint/no-unused-vars` | accidental |
| `app/thmm/components/cpu-diagram.tsx` | 525:10 | `Value` | `@typescript-eslint/no-unused-vars` | accidental |
| `worker/session-host/session.mjs` | 759:28 | `_ingestKey` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 760:17 | `_ghToken` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 761:32 | `_browseUser` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 762:32 | `_browsePassword` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 763:23 | `_turingWriteKey` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 1261:36 | `_ingest` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 1262:25 | `_gh` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 1263:31 | `_tts` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 1264:40 | `_browseUser` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 1265:40 | `_browsePassword` | `@typescript-eslint/no-unused-vars` | deliberate |
| `worker/session-host/session.mjs` | 1266:31 | `_turingWriteKey` | `@typescript-eslint/no-unused-vars` | deliberate |

## What each finding actually is

The eleven findings in `worker/session-host/session.mjs` are all the same
construct and all intended. JavaScript's object destructuring with a rest
element lets you build a copy of an object minus named properties by binding
those properties to throwaway names: `const { SECRET: _s, ...rest } = obj`
leaves `rest` holding everything except `SECRET`. Both sites use that to strip
secrets out of the environment handed to a child process — the first (759-763)
for the session host's own inherited environment, the second (1261-1266) for
the environment of the spawned process. The names exist only to be discarded,
so the rule is correct that they are never read and wrong that this is a
mistake. All eleven already begin with an underscore, which is the conventional
mark for a deliberate discard; the rule is simply not configured to honour it.

The six remaining findings are accidental, and they are of three different
shapes despite sharing one rule:

- `Stat` (`run-inspector.tsx:500`), and `Title`, `Sub` and `Value`
  (`cpu-diagram.tsx:502`, `:510`, `:525`) are React components — functions
  returning a piece of the page — that are defined in those files, are not
  exported, and are called by nothing. Because they are not exported, a sweep
  for dead exports across the repository would not have found them; only a
  within-file check does.
- `ChargeSymbol` (`help-popup.tsx:27`) is an import: a name pulled in from
  `../lib/frequencies` and then never used in the file.
- `index` (`run-inspector.tsx:250`) is a property that the `OutcomesSection`
  component destructures out of its arguments and never reads. Removing it
  means removing it from the component's parameter list, and, if any caller
  passes it, from the call sites too.

## Two entries the batch's own text lists that no longer fire

The batch was written against an earlier state of the repository, and two of
its statements are now wrong. Both are recorded here so a later session does
not go looking for findings that are gone.

The batch says five deliberate discards exist, at `session.mjs` lines 621-622
and 1080-1082. There are eleven, at lines 759-763 and 1261-1266. The file grew
and three more secrets — the agent browser username, the agent browser password
and the Turing write key — were added to both discard lists after the batch was
formed. An ignore rule keyed on the leading underscore covers all eleven
without needing to know the count, which is the argument for that shape of fix
over listing names.

The batch also names `internalQuery` at `convex/claudeSessions.ts:5` as an
unused import. It is used now: `internalListLive` at line 404 is declared with
it. That finding is fixed and needs no further action.
