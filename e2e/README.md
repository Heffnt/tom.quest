# Environment variables the E2E suite reads

Every environment variable read by any file under `e2e/`, plus the two read by
`playwright.config.ts`. Measured against the tree at the time of writing by
grepping `process.env` across `e2e/` and `playwright.config.ts` (those are the
only reads — no spec reads env indirectly through a helper that reads it for
them), and by `pnpm exec playwright test --list`, which reports **52 tests in 7
files**: 26 distinct tests run twice, once per project (`chromium` and
`mobile-chromium`).

None of these eight `E2E_*` variables is named in any committed file outside
`e2e/` itself. The six credential names are never spelled out anywhere in the
repository, in any file, because `credentialsFor` builds them by string
interpolation (`` `E2E_${role.toUpperCase()}_USERNAME` ``) — so grepping the
tree for `E2E_USER_USERNAME` returns nothing at all.

## The eight variables read by specs

| Variable | Read at | Gates | When unset |
| --- | --- | --- | --- |
| `E2E_USER_USERNAME` | `e2e/helpers/auth.ts:12` | `page-visibility.spec.ts:22`, the `user` role case | Test skips. 2 executions (chromium + mobile-chromium). |
| `E2E_USER_PASSWORD` | `e2e/helpers/auth.ts:13` | same test | Same. Both halves are required; either one missing skips. |
| `E2E_ADMIN_USERNAME` | `e2e/helpers/auth.ts:12` | `page-visibility.spec.ts:22`, the `admin` role case | Test skips. 2 executions. |
| `E2E_ADMIN_PASSWORD` | `e2e/helpers/auth.ts:13` | same test | Same. |
| `E2E_TOM_USERNAME` | `e2e/helpers/auth.ts:12` | `page-visibility.spec.ts:22`, the `tom` role case | Test skips. 2 executions. |
| `E2E_TOM_PASSWORD` | `e2e/helpers/auth.ts:13` | same test | Same. |
| `E2E_AUTH_FLOW` | `e2e/auth-flow.spec.ts:4` | the whole of `auth-flow.spec.ts` — its single test, "sign up, sign out, and sign back in" | Test skips. 2 executions. |
| `E2E_CONVEX` | `e2e/perfume.spec.ts:317` | the `perfume brew — live sync` describe block in `perfume.spec.ts` — its single test, U7/U8 | Test skips. 2 executions, but see the note below: only 1 of them ever runs even when set. |

`E2E_CONVEX` guards a `test.describe`, so it would skip every test in that
block; the block currently holds one test. The other eight perfume tests, in
`perfume brew — local mode`, are not gated and always run.

### The two gates do not compare the same way

`E2E_AUTH_FLOW` is compared strictly against the string `"1"`
(`process.env.E2E_AUTH_FLOW !== "1"`), so only the exact value `1` turns it on.
`E2E_CONVEX` is compared for truthiness (`!process.env.E2E_CONVEX`), so **any**
non-empty value turns it on — including `E2E_CONVEX=0` and `E2E_CONVEX=false`.
An empty value (`E2E_CONVEX=`) leaves it off.

The credential pair is also truthiness-based: `credentialsFor` returns
`username && password ? {...} : null`, so an exported-but-empty
`E2E_USER_USERNAME=` skips exactly as an unset one does.

### The second skip on the live-sync test

The live-sync describe carries a second `test.skip` immediately after the
`E2E_CONVEX` one, on viewport width `< 1024`. The `mobile-chromium` project
uses a 375px viewport, so that execution skips regardless. Setting `E2E_CONVEX`
enables exactly **one** additional test execution, under `chromium`.

## The two variables read by playwright.config.ts

| Variable | Read at | Effect | When unset |
| --- | --- | --- | --- |
| `PLAYWRIGHT_WEBSERVER_COMMAND` | `playwright.config.ts:12` | The command Playwright runs to bring up the site under test | Falls back to `corepack pnpm dev`. Nothing skips. |
| `CI` | `playwright.config.ts:14` | Sets `reuseExistingServer: !process.env.CI` | Unset means an already-running server on `127.0.0.1:3000` is reused instead of a second one being started. Nothing skips. |

These two are not credentials and are not part of the eight; they change how
the suite is launched, never which tests run.

## What this means for the suite as it stands

`e2e/page-visibility.spec.ts` is the only end-to-end check of who may see which
page. It has four cases — guest, `user`, `admin`, `tom` — and three of them sign
in first. With no credentials present, only the guest case has ever executed, so
a change to the visibility rule in `app/components/page-routes.ts` that affected
only the signed-in roles would leave this suite green. `pnpm test:pages` runs
this spec together with the `page-routes` unit test.

Because a skipped Playwright test is reported as skipped and not as a failure,
the suite passes today with 10 of its 52 executions never having run: 6 role
cases, 2 auth-flow, 2 live-sync. Supplying all eight variables recovers 9 of
those 10; the tenth, the `mobile-chromium` live-sync execution, skips on the
viewport guard no matter what the environment holds.

## Where the accounts these credentials name would live

`playwright.config.ts` starts the site with `corepack pnpm dev`, i.e. `next dev`,
and per `CLAUDE.md` there is one Convex deployment: local `next dev` runs against
**production** Convex. So the three role accounts named by the six credential
variables are real production accounts, and running `auth-flow.spec.ts` with
`E2E_AUTH_FLOW=1` creates a fresh production user on every run, named
`e2e<timestamp>`, which the spec never deletes. `E2E_CONVEX=1` likewise writes
to the shared production perfume party — its own skip message says so.

## The unused sign-out helper

`e2e/helpers/auth.ts` also exports `signOut`, which no spec imports; only
`credentialsFor` and `signIn` are imported anywhere, both by
`page-visibility.spec.ts:3`. Its selector chain therefore never runs. It is not
gated by any environment variable and is listed here only so that a reader
taking inventory of this directory does not mistake it for coverage.
