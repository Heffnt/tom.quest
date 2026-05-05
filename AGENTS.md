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
- `tom` is Tom's account. It extends admin access with Jarvis config, the diagnostic panel, and terminal access.
- Use `isTom` for Tom-only features and `isAdmin` for elevated features. `isAdmin` is true for both `admin` and `tom`.

## State Management

- Server state belongs in Convex.
- Client-only UI state belongs in Zustand.
- Do not store server-derived data in Zustand unless it is a local optimistic copy that syncs back to Convex.

## Routing

- User-facing URLs follow `tom.quest/{slug}`.
- Avoid query params, hash fragments, or nested prefixes for top-level quests.
- Dynamic segments are only for naturally dynamic resources, such as `/turing/terminal/[session]`.
- Quest visibility is role-gated via each quest's `visibility` field: `public`, `authenticated`, `admin`, or `tom`.
- Quest metadata lives in `app/components/quest-routes.ts`.

## Turing Proxy

- A FastAPI worker (`tom-quest-api/`) on the WPI Turing cluster exposes GPU/job/terminal APIs.
- `cloudflared` creates a quick tunnel; the worker registers the tunnel URL with Convex via an HTTP action authenticated by `TURING_REGISTRATION_SECRET`.
- Convex auto-links the connection to the Tom user on registration.
- Next.js API routes (`app/api/turing/[...path]/route.ts`) look up the tunnel URL from Convex and proxy requests to the worker.
- The proxy detects HTML/non-JSON upstream responses and converts them to structured JSON errors.

## Deployment

- Vercel builds via `npx convex deploy --cmd 'pnpm build'`, which pushes Convex functions to prod and then builds Next.js.
- Required Vercel env vars: `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `CONVEX_DEPLOY_KEY`, Sentry vars.
- Required Convex env vars (set via `npx convex env set --prod`): `SITE_URL`, `JWT_PRIVATE_KEY`, `JWKS`, `TOM_SETUP_SECRET`, `TURING_REGISTRATION_SECRET`.

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

## Bug Handling

- Do not keep dated bug histories or incident logs here.
- When fixing a bug, prefer a focused regression test that would fail if the bug returned.
- If a bug is not realistically testable (for example because it is primarily visual or environment-dependent), put a brief warning comment at the exact danger point in code instead of logging the incident here.

## Verification

- `pnpm dev:all` starts Next.js and Convex dev servers.
- `pnpm build` verifies the production build.
- `pnpm test` runs Vitest unit/component tests.
- `pnpm test:e2e` runs Playwright E2E tests.
- `pnpm lint` runs ESLint.
- Before deployment-related work, production build verification matters more than style-only checks.

## Agent Context System

- This file is the project-specific agent context for tom.Quest.
- Cursor and Codex read the repo root `AGENTS.md` directly.
- Claude Code should read `CLAUDE.md`, which must stay symlinked to this file.
- Cursor also loads the shared global layer from `.cursor/rules/00-global.mdc`.
- Keep only durable project goals, vocabulary, and patterns here.
- Put cross-project preferences in the global rules file, not here.
- If loading breaks in one tool, fix the symlink or shim instead of duplicating content.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
