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
- `tom` is Tom's account. It extends admin access with Jarvis config, the diagnostic panel, and terminal access.
- Use `isTom` for Tom-only features and `isAdmin` for elevated features. `isAdmin` is true for both `admin` and `tom`.

## State Management

- Server state belongs in Convex.
- Client-only UI state belongs in Zustand.
- Do not store server-derived data in Zustand unless it is a local optimistic copy that syncs back to Convex.

## Routing

- User-facing URLs follow `tom.quest/{slug}`.
- A top-level quest's own address is that plain path: no hash fragments, no nested prefixes, and nothing in a query param is ever needed to reach the quest.
- Query params are an inbound deep-link vocabulary, not browsing state. A link arriving from outside may carry a view to open (`/tts?tab=`) or an item and a proposed action (`/tts?item=&intent=`); the page reads them once on mount and clicking around never writes them back, so the address stays plain while the quest is used.
- A GET carrying a proposed action never performs it. Link-preview crawlers fetch these URLs, so the page confirms first and acts only on the click.
- Dynamic segments are only for naturally dynamic resources, such as `/turing/terminal/[session]`.
- Page visibility is role-gated via each page's `visibility` field: `public`, `authenticated`, `admin`, or `tom`.
- Page metadata lives in `app/components/page-routes.ts`.

## Turing Proxy

- The Turing API (`turing-api/`) is a FastAPI service running on the WPI Turing cluster, exposing GPU/job/terminal endpoints.
- A named cloudflared tunnel maps `turing.tom.quest` to the API's local port (stable URL, not a quick tunnel).
- Next.js API routes (`app/api/turing/[...path]/route.ts`) read `TURING_API_URL` from env and forward requests through `forwardToTuringApi`, attaching the `X-API-Key` header. The shared key never leaves Vercel.
- Terminal WebSockets open directly from the browser to `wss://turing.tom.quest` after admins fetch a short-lived HMAC token from `/api/turing/ws-credentials`.
- Liveness is owned by a Convex cron (`internal.serverHealth.pollTuring`) that probes `/health` and writes to the `serverHealth` table; `useServer("turing").status` reads it.
- The proxy detects HTML/non-JSON upstream responses and converts them to structured JSON errors.
- The API binds `127.0.0.1` (only the co-located cloudflared reaches it; not the shared cluster LAN). `/file` and `/dirs` are confined to `TURING_FILE_ROOT` (default home) and refuse secret-bearing paths.
- Declarative GPU pool: desired state lives in the `gpuPool` table; the Convex cron `internal.gpuPool.reconcile` reconciles desired-vs-actual against the API, tracking its own jobs in `gpuPoolAllocation` so it only ever cancels pool-created jobs. Requires `TURING_API_KEY` in the Convex env (not just Vercel).

## Deployment

- **One Convex deployment.** Prod is the only deployment; there is no separate dev. `next dev` runs locally against prod Convex. Function and schema changes go live only on explicit `npx convex deploy`. Trade-off accepted because tom.quest is a personal project; see [[philosophy/personal-project-pragmatism]] and [[principles/single-deployment]] in the wiki.
- Vercel builds via `scripts/vercel-build.mjs` (set as `buildCommand` in `vercel.json`). **Production** runs `npx convex deploy --cmd 'pnpm build'`, pushing Convex functions to prod and then building Next.js. **Preview** runs `pnpm build` alone — a PR branch must never deploy functions to the one prod deployment, and the Convex CLI refuses to anyway, which is what made the Vercel check red on every session PR.
- **The public Convex deployment identity lives in the committed `.env`** (the two `NEXT_PUBLIC_*` values). They are inlined into the browser bundle, so they are public by construction, and committing them is what lets a bare checkout — a Claude session, a fresh clone — run `pnpm build` at all. Vercel's project env and `.env.local` both take precedence over it.
- **Secrets live in `secrets/`.** `secrets/next.env` is the source of truth for Vercel prod env (mirrored to `.env.local`); `secrets/convex.env` is the source of truth for Convex prod env. `pnpm secrets:sync` pushes both. `pnpm secrets:init` is a one-time pull. Never edit Vercel or Convex env directly. See [[principles/single-source-secrets]].

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

- `pnpm dev:all` starts Next.js (against prod Convex) plus a `convex dev` watcher for typegen.
- `pnpm secrets:sync` pushes `secrets/*.env` to Vercel + Convex and refreshes `.env.local`.
- `pnpm build` verifies the production build (works from a bare checkout — the public Convex URLs are in the committed `.env`). CI runs it on every PR.
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
