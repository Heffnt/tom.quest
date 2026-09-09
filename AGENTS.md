# tom.Quest

## Goal

Build and maintain tom.Quest as a personal web dashboard for cluster management, experiment visibility, and related tools.

## High-Level Rules

- Keep this file high level and durable. If implementation specifics are needed, read the code.
- Prefer understandable, maintainable, testable code with simple interfaces around deep modules.
- Always style the site name as tom.Quest.
- After code changes, provide a commit message the user can use.

How agents operate anywhere — delegation, models, gates, pushing, asking — is in WikiTom `model-of-tom/agent-rules.md`, which every run receives. This file holds only what is specific to this repository.

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

## Deployment

- **One Convex deployment.** Prod is the only deployment; there is no separate dev. `next dev` runs locally against prod Convex. Function and schema changes go live only on explicit `npx convex deploy`. Trade-off accepted because tom.quest is a personal project; see [[philosophy/personal-project-pragmatism]] and [[principles/single-deployment]] in the wiki.
- Vercel builds via `scripts/vercel-build.mjs` (set as `buildCommand` in `vercel.json`). **Production** runs `npx convex deploy --cmd 'pnpm build'`, pushing Convex functions to prod and then building Next.js. **Preview** runs `pnpm build` alone — a PR branch must never deploy functions to the one prod deployment, and the Convex CLI refuses to anyway, which is what made the Vercel check red on every session PR.
- **The public Convex deployment identity lives in the committed `.env`** (the two `NEXT_PUBLIC_*` values). They are inlined into the browser bundle, so they are public by construction, and committing them is what lets a bare checkout — a Claude session, a fresh clone — run `pnpm build` at all. Vercel's project env and `.env.local` both take precedence over it.
- **Secrets live in `secrets/`.** `secrets/next.env` is the source of truth for Vercel prod env (mirrored to `.env.local`); `secrets/convex.env` is the source of truth for Convex prod env. `pnpm secrets:sync` pushes both. `pnpm secrets:init` is a one-time pull. Never edit Vercel or Convex env directly. See [[principles/single-source-secrets]].
- **Pushing to `main` is the deploy.** Vercel's GitHub integration builds every `main` commit to production; there is no separate deploy step and the Vercel CLI is a fallback, not the path. Tom's standing authorization, 2026-07-06: "push it. and just do it from now on instead of asking" — completed work whose gates pass goes to `main` without a per-push confirmation. An agent still never widens its own permission configuration to do so.
- **Never push one commit to `main` and to a branch at the same time.** Vercel deduplicates by commit sha, so a same-sha double push builds only the branch preview and creates no production deployment: the live site silently stays on the previous commit while the sha's only visible check is the preview's. Push `main` alone, or push the branch first and `main` afterwards so they are distinct events. The symptom to look for is a missing recent Production row, not a red check.

## Debugging And Observability

- Use the Tom-only left-side diagnostic panel as the single in-app place to inspect bug context.
- The diagnostic panel must have a copy button that emits concise agent-ready diagnostics.
- Use Sentry for error capture, performance, and session replay.
- Use Convex Dashboard for server state, function logs, and query performance.
- Use Zustand devtools for client UI state inspection.
- Never log secrets, tokens, signatures, or large sensitive payloads.

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

- The root `AGENTS.md` applies repo-wide; nested `AGENTS.md` files apply to their directory trees.
- Every level has a regular sibling `CLAUDE.md` containing only `@AGENTS.md` (with an optional final newline).
- WikiTom `model-of-tom/` holds who Tom is and how agents operate; every run receives it.
- Box-side runner rules live in `worker/AGENTS.md`.
