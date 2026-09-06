# tom.Quest

## Goal

Build and maintain tom.Quest as a personal web dashboard for cluster management, experiment visibility, and related tools.

## High-Level Rules

- Keep this file high level and durable. If implementation specifics are needed, read the code.
- Prefer understandable, maintainable, testable code with simple interfaces around deep modules.
- Always style the site name as tom.Quest.
- Avoid UI behavior that moves the user unexpectedly, especially auto-scrolling.
- Prefer text inputs over number spinners for numeric intervals.
- After code changes, provide a commit message the user can use.

## Delegation (ratified by Tom, 2026-09-04)

- A session runs the strongest model available to it. That model's time is for judgment, design, and review — not for reading files, running searches, applying mechanical edits, or running tests.
- Hand that menial work to subagents. In Codex, `spawn_agent` with agent type `explorer` (reading and searching) or `worker` (making changes and running things), asking for the cheap model `gpt-5.6-terra` by name — a spawned agent otherwise inherits the parent's strong model, which is the waste this rule exists to stop. In Claude Code, the equivalent subagents.
- What never gets delegated: deciding what to do, designing how, and judging whether the result is right. A subagent reports; the parent concludes.

## UI Rules (ratified by Tom, 2026-08-29)

- Clickable text not styled as a button is underlined at rest. Text that is not clickable is never underlined. Accent color alone never signals clickability — it also marks state.
- Everything clickable changes visibly on hover (background or brightness shift at minimum). Block-level clickables — rows, cards, paragraphs that open detail — signal clickability through that hover response rather than an underline.
- One info mechanism: a tap-to-open popover (never hover-only, never native `title=` — both are dead on touch). Content is a plain-language explanation of what the control does on the backend, with the exact function call in small mono. New surfaces use it; existing surfaces migrate when otherwise touched.
- No explainer text in product UI. Pages are data + actions and must be self-explanatory; ground-up explanations happen in conversation, not on the page.
- Interactions never shift layout. No inline forms appearing between controls; anything composed (notes, rulings, scheduling) opens in a fixed dialog.
- Actions sit near the top of an item's detail, and their labels name their exact backend effect.

## Tech Stack

- **Framework:** Next.js 16 App Router + React 19.
- **Backend / DB:** Convex — schema, queries, mutations, HTTP actions, and Convex Auth.
- **Auth:** Convex Auth (password provider) with three roles: `user`, `admin`, and `tom`.
- **Client state:** Zustand for UI-only state. Server state belongs in Convex.
- **Styling:** Tailwind CSS v4 with theme tokens in `app/globals.css`.
- **Observability:** Sentry for errors, performance, and session replay.
- **Testing:** Vitest + convex-test (unit/component), Playwright (E2E).
- **Package manager:** pnpm.
- **Hosting:** Vercel (frontend) + Convex Cloud (backend).

## Roles

- `user` is the default sign-up role and sees public quests.
- `admin` has elevated quest access and may be granted to trusted friends or colleagues.
- `tom` is Tom's account. It extends admin access with Jarvis config and the diagnostic panel.
- `/turing`, including the cluster terminal, is admin-level: the page is registered `visibility: "admin"`, and both the proxy route's write methods and the terminal's WebSocket credential route call `requireAdmin`. Do not narrow these to `isTom`. (The proxy's GET additionally admits `agent` via `requireAdminOrAgent`.)
- `agent` is the account a TTS session's headless browser signs in as. It is **not a rank** on the `user → admin → tom` ladder but a side branch: it reads a named list of surfaces and writes nothing, anywhere. `roleAccess("agent")` returns `isAdmin: false` and `isTom: false`, so every existing gate denies it by default.
- Use `isTom` for Tom-only features and `isAdmin` for elevated features. `isAdmin` is true for both `admin` and `tom`.
- Reads that `agent` may perform go through `requireTomOrAgent(ctx, label)` in Convex, `requireAdminOrAgent(request, surface)` in route handlers, and `canReadSurface(label)` on the client. Writes stay on `requireTom` / `requireAdmin` / `isTom` — including writes that fire on page arrival, which must be gated on `isTom` so a headless screenshot records nothing.
- The reach of `agent` is one list: `convex/agentSurfaces.ts`, plus the per-page `agentReadable` flag in `app/components/page-routes.ts`. Widening it is adding one name; nothing else moves. Its labels are the same ones `requireTom` already takes, so read gates and write gates share one vocabulary.
- `users.setRoleByUsername` is the pen for granting or taking back `user`/`admin`/`agent`. It cannot mint or demote a `tom`.

## State Management

- Server state belongs in Convex.
- Client-only UI state belongs in Zustand.
- Do not store server-derived data in Zustand unless it is a local optimistic copy that syncs back to Convex.

## Routing

- User-facing URLs follow `tom.quest/{slug}`.
- Avoid query params, hash fragments, or nested prefixes for top-level quests.
- Dynamic segments are only for naturally dynamic resources, such as `/turing/terminal/[session]`.
- Page visibility is role-gated via each page's `visibility` field: `public`, `authenticated`, `admin`, or `tom`.
- Page metadata lives in `app/components/page-routes.ts`. The home page and the nav autocomplete render from `PAGES`, so a registered page appears without further wiring.
- `app/components/page-routes.test.ts` hard-codes the guest page ordering. Adding a public page means updating that expectation; the visibility e2e iterates `PAGES` and needs no edit.
- Static assets must live outside an app route's path prefix. A page at `app/<slug>/page.tsx` shadows the whole `/<slug>/*` URL space, so `public/<slug>/anything.png` returns 404 both locally and in production — which is why the `/perfume` artwork is served from `public/art/ingredients/`.

## Turing Proxy

- The Turing API (`turing-api/`) is a FastAPI service running on the WPI Turing cluster, exposing GPU/job/terminal endpoints.
- A named cloudflared tunnel maps `turing.tom.quest` to the API's local port (stable URL, not a quick tunnel).
- Next.js API routes (`app/api/turing/[...path]/route.ts`) read `TURING_API_URL` from env and forward requests through `forwardToTuringApi`, attaching the `X-API-Key` header. The shared key never leaves Vercel.
- Two credentials, not one. `TURING_API_KEY` (`verify_api_key`) opens the whole surface, including `POST /sessions/{name}/run` — arbitrary shell on the cluster. `TURING_READ_KEY` (`verify_read_key`) opens only `GET /gpu-report`, `GET /jobs`, and `GET /sessions/{name}/output`; it accepts either key, and an unset read key fails closed to full-key-only. Callers that need to look but not act — TTS sessions on the Jarvis Box, via `worker/bin/tts-turing` — hold the read key alone. Anything new defaults to `verify_api_key`; moving an endpoint to the read door widens what every session can see.
- Terminal WebSockets open directly from the browser to `wss://turing.tom.quest` after admins fetch a short-lived HMAC token from `/api/turing/ws-credentials`.
- Liveness is owned by a Convex cron (`internal.serverHealth.pollTuring`) that probes `/health` and writes to the `serverHealth` table; `useServer("turing").status` reads it.
- The proxy detects HTML/non-JSON upstream responses and converts them to structured JSON errors.
- The API binds `127.0.0.1` (only the co-located cloudflared reaches it; not the shared cluster LAN). `/file` and `/dirs` are confined to `TURING_FILE_ROOT` (default home) and refuse secret-bearing paths.
- Declarative GPU pool: desired state lives in the `gpuPool` table; the Convex cron `internal.gpuPool.reconcile` reconciles desired-vs-actual against the API, tracking its own jobs in `gpuPoolAllocation` so it only ever cancels pool-created jobs. Requires `TURING_API_KEY` in the Convex env (not just Vercel).
- The API and its tunnel run as `systemd --user` units on every cluster login node, one copy each, behind one balanced hostname. Without `loginctl enable-linger` for the account they exist only while a login session does, so a node that has lost lingering serves nothing and requests fail intermittently rather than outright — the symptom is a fraction of calls timing out while the rest succeed. The tunnel unit is named `cloudflared-turing`; asking `systemctl --user` about `cloudflared` reports a unit that does not exist as inactive and reads like the tunnel is down.
- A non-interactive ssh to the cluster does not source `~/.bashrc`, so SLURM and conda are not on `PATH`. Export the SLURM bin directory before any `squeue`, `sbatch`, `sacct` or `loginctl` call, and source conda's profile script before activating an environment.
- `GET /boolback-snapshot` globs the whole artifact tree (hundreds of gigabytes) and takes seconds warm and tens of seconds cold; the public proxy aborts it at 20 s. The blob endpoint never walks the tree and answers in a fraction of a second, so the browser loads the blob in parallel and treats status as a freshness annotation only. A snapshot rebuild POST takes about 30 s to return because the `sbatch` submit is slow — give it a client timeout of 45 s or more, or it times out while the server is still submitting and a second call duplicates the build.

## Deployment

- **One Convex deployment.** Prod is the only deployment; there is no separate dev. `next dev` runs locally against prod Convex. Function and schema changes go live only on explicit `npx convex deploy`. Trade-off accepted because tom.quest is a personal project; see [[philosophy/personal-project-pragmatism]] and [[principles/single-deployment]] in the wiki.
- Vercel builds via `scripts/vercel-build.mjs` (set as `buildCommand` in `vercel.json`). **Production** runs `npx convex deploy --cmd 'pnpm build'`, pushing Convex functions to prod and then building Next.js. **Preview** runs `pnpm build` alone — a PR branch must never deploy functions to the one prod deployment, and the Convex CLI refuses to anyway, which is what made the Vercel check red on every session PR.
- **The public Convex deployment identity lives in the committed `.env`** (the two `NEXT_PUBLIC_*` values). They are inlined into the browser bundle, so they are public by construction, and committing them is what lets a bare checkout — a Claude session, a fresh clone — run `pnpm build` at all. Vercel's project env and `.env.local` both take precedence over it.
- **Secrets live in `secrets/`.** `secrets/next.env` is the source of truth for Vercel prod env (mirrored to `.env.local`); `secrets/convex.env` is the source of truth for Convex prod env. `pnpm secrets:sync` pushes both. `pnpm secrets:init` is a one-time pull. Never edit Vercel or Convex env directly. See [[principles/single-source-secrets]].
- **Pushing to `main` is the deploy.** Vercel's GitHub integration builds every `main` commit to production; there is no separate deploy step and the Vercel CLI is a fallback, not the path. Tom's standing authorization, 2026-07-06: "push it. and just do it from now on instead of asking" — completed work whose gates pass goes to `main` without a per-push confirmation. An agent still never widens its own permission configuration to do so.
- **Never push one commit to `main` and to a branch at the same time.** Vercel deduplicates by commit sha, so a same-sha double push builds only the branch preview and creates no production deployment: the live site silently stays on the previous commit while the sha's only visible check is the preview's. Push `main` alone, or push the branch first and `main` afterwards so they are distinct events. The symptom to look for is a missing recent Production row, not a red check.
- **The Jarvis Box** — the always-on server that runs this repo's `worker/` jobs and the TTS session daemon — has its own operating notes in `worker/README.md`: what each job does, how `worker/setup.sh` rolls out new code idempotently, and where its secrets live. Connection details are deliberately not in this repository, which is public.

## Debugging And Observability

- Use the Tom-only left-side diagnostic panel as the single in-app place to inspect bug context.
- The diagnostic panel must have a copy button that emits concise agent-ready diagnostics.
- Use Sentry for error capture, performance, and session replay.
- Use Convex Dashboard for server state, function logs, and query performance.
- Use Zustand devtools for client UI state inspection.
- Never log secrets, tokens, signatures, or large sensitive payloads. There is no exemption for one-time credential helpers: they write minted values to an owner-only file (`worker/jobs/credential-file.mjs`) and print only that file's path and the variable names, because an agent session stores its own standard output.

## Project Style

- Keep instructions here stable and conceptual. Put implementation details in code, tests, and local comments.
- Favor predictable UI behavior and inspectable system behavior.
- Prefer clear, centralized patterns over ad hoc feature-by-feature implementations.
- A commit subject is lowercase, names the area it touches, and states the world after the change rather than the action taken: `tts: the page has no capture bar`. The body is complete sentences saying what changed and why, one idea per paragraph, and it ends with the `Co-authored-by` trailer for whichever model wrote it. Pull requests are merged with squash, so the pull request's own title and body are what land in history.

## Bug Handling

- Do not keep dated bug histories or incident logs here.
- When fixing a bug, prefer a focused regression test that would fail if the bug returned.
- If a bug is not realistically testable (for example because it is primarily visual or environment-dependent), put a brief warning comment at the exact danger point in code instead of logging the incident here.

## Verification

- `pnpm dev:all` starts Next.js (against prod Convex) plus a `convex dev` watcher for typegen.
- `pnpm secrets:sync` pushes `secrets/*.env` to Vercel + Convex and refreshes `.env.local`.
- `pnpm build` verifies the production build (works from a bare checkout — the public Convex URLs are in the committed `.env`). CI runs it on every PR.
- `pnpm test` runs Vitest unit/component tests.
- `pnpm test:e2e` runs Playwright E2E tests.
- `pnpm lint` runs ESLint.
- `pnpm check:guardrails` runs the static boundary checks that CI enforces on every pull request.
- Before deployment-related work, production build verification matters more than style-only checks.
- The pull-request gates are the three Guardrails jobs: `static-boundaries`, `secret-scan`, and `tests` (typecheck, the Turing suite, and the production build). Those three green are the merge bar; any other check a platform attaches to the commit is not a deploy gate.
- Do not reintroduce `/// <reference types="vite/client" />` into a Convex test, even though the generated Convex guidelines recommend it. `vite` is not hoisted to the top-level `node_modules`, so the reference resolves from a local checkout and fails in CI; `ImportMeta.glob` is declared instead in the committed `convex/test-env.d.ts`.
- A session without Convex deploy credentials cannot run `npx convex codegen` — it requires `CONVEX_DEPLOYMENT` and validates the name over the network. After adding `convex/<mod>.ts`, hand-add the module to `convex/_generated/api.d.ts` (one `import type` line and one `fullApi` entry, both alphabetical) so `api.<mod>.*` typechecks; the runtime already resolves any path through the `anyApi` proxy, and Vercel's `convex deploy` regenerates the file identically. New exports in an already-registered module need no edit.
- Dropping a table from `convex/schema.ts` is non-destructive. `convex deploy` validates only the tables still declared, so the rows persist on the deployment as an undeclared table rather than erroring or being deleted. Removing an unused table from the code is therefore safe to ship; actually purging the data needs the dashboard or the CLI with credentials.

## Worktrees And Local Serving

- A fresh worktree starts with an empty `node_modules`. Run `pnpm install --frozen-lockfile` in it before anything else.
- A worktree does not inherit `.env.local`. Copy it from the main checkout first, or `next dev` throws at module load on the missing Convex URL. `pnpm build` alone needs no secrets — the public Convex URLs are committed.
- `next build` and `next start` run from a worktree infer the workspace root as the *parent* checkout, because two lockfiles are in scope, and serve the parent's `public/` and `.next`. A file added under the worktree's `public/` therefore 404s from a local server, and a stale parent build can be served in place of the new one. Do not trust local static serving to tell you whether a new asset works; intercept the request in a Playwright route, or check it on production, which has no parent. Setting `outputFileTracingRoot` does not fix this.
- On Windows, killing a listener by the PID that `netstat` prints does not kill a native node process, so the old `next start` keeps the port and the new one fails to bind silently, leaving you testing the stale server. Free the port with PowerShell instead: `Get-NetTCPConnection -LocalPort <n> -State Listen | Stop-Process -Force`.

## Binary Assets

- A file over 50 MiB makes every push print GitHub's GH001 warning; over 100 MiB GitHub refuses the push. Both thresholds apply to the blob forever, so a single commit of a large file is only taken back by rewriting all of history.
- `scripts/check-large-files.mjs` fails the build when a tracked file crosses 50 MiB without being Git LFS tracked. Files already over the line are named in its `KNOWN_LARGE` map with the reason.
- Large binaries go to Git LFS or outside the repo, never into ordinary git history.

## Agent Context System

- This file is the project-specific agent context for tom.Quest.
- Cursor and Codex read the repo root `AGENTS.md` directly.
- Claude Code should read `CLAUDE.md`, which must stay symlinked to this file.
- Cursor also loads the shared global layer from `.cursor/rules/00-global.mdc`.
- Keep only durable project goals, vocabulary, and patterns here.
- Put cross-project preferences in the global rules file, not here.
- If loading breaks in one tool, fix the symlink or shim instead of duplicating content.
- Codex is a first-class session runner here, not only a second opinion: a session's model name says which runner it gets, and the `gpt-5.6-*` names mean Codex.
- Claude reaches Codex through the `codex` subagent (`.claude/agents/codex.md`), the `/codex` skill, or `agentType: 'codex'` in a Workflow script. All go through `scripts/codex-run.mjs` in this repo, or `tts-codex` — the same program on the Jarvis Box's PATH, for sessions in any repo.
- Codex may edit files by default and runs at the fleet's strongest model and effort. Review paths ask for read-only explicitly.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
