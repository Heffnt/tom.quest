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
- Avoid query params, hash fragments, or nested prefixes for top-level quests.
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

## TTS (Toms Todo System)

- TTS is the todo system this site runs for Tom: life todos, code todos, batches, rulings, the daily queue, and the agent sessions that work them. The canonical spec is WikiTom `tts/spec.md`, cited as `tts-spec:<section>`. Code here summarizes that spec and never redefines its vocabulary.
- Life todos are held here (`convex/tts.ts` plus the `dts*` tables) — this is their system of record. Code todos stay in each repo's `vqc/todos.yaml` and Convex only mirrors them (`dtsCodeTodoMirror`), so acting on a code todo means working in that repo.
- **The vocabulary is closed and stored literally.** `readiness` is unprepared | preparing | ready-for-tom; `status` is active | waiting | archived | done; `timingClass` is dated | condition-bound | whenever. A ruling verdict is approve | revise | session | archive — "defer" is not a verdict, because not ruling is deferring.
- **Nothing is ever deleted.** The terminal states are `done` and `archived`, both kept and visible. Schedule mechanics (`dtsBlocks`, `ttsRepeats` rules) may be moved or deleted freely; todos may not.
- **A batch is not a todo.** A batch (`batches` table) holds how a set of todos gets completed. Its contents are `dtsTodos` rows pointing back at it, each with `kind` task (work someone does) or goal (a checkable state of the world), `needs` edges to other todos in the same batch, and `actor` tom or agent. A todo is *ready* when every id in `needs` is done or archived; `convex/ttsShared.ts` owns the one implementation. Batches sequence along a named `path` with `must` (that one has to land first) or `helps` edges. A batch declares its `repos` at formation — the scheduler never guesses them.
- **The `dts` table prefix is frozen.** `dtsTodos`, `dtsBlocks`, `dtsTimeNotes`, `dtsRulings`, `dtsEvents`, `dtsDailyQueues`, `dtsCodeTodoMirror`, `dtsCodeBriefs`, and the deprecated `dtsCodeRulings` keep the pre-rename prefix because prod schema is additive-only and a rename is a data migration for no behavior (adoption.md `tts-rename`). Everything human-facing says TTS; new tables use `tts*` or `claude*`.
- `tomTouchedAt` on a todo or a batch means Tom has ruled on it. That row is frozen: the planner may never rewrite it.
- Every Tom-facing function in `convex/tts.ts` is Tom-gated (`requireTom`), so rows carry no userId. Everything the Jarvis Box touches goes through internal functions behind key-authed routes in `convex/http.ts`: `X-TTS-Key` = `TTS_WORKER_KEY` for `/tts/*`, `X-Sessions-Key` = `SESSIONS_WORKER_KEY` for `/sessions/*`. Each route family keeps its own key and they share nothing.
- Convex-side TTS crons live in `convex/crons.ts`. Convex crons are UTC-only, so a job anchored to New York wall-clock registers two rows (EDT and EST) and the handler's local-hour guard lets exactly one proceed — daylight saving needs no cron edit.
- Surfaces: `/tts` is the todo, batch, path, and calendar surface; `/sessions` is the session surface. Both are Tom-only.

## The Jarvis Box (`worker/`)

- The Jarvis Box is a Hetzner CAX11 (Ubuntu 24.04, ARM64) running TTS's scheduled headless-Claude jobs and the session daemon. `worker/setup.sh` is the definition of the box: it is idempotent, a rebuild from it is the box, and re-running it is how updated job scripts roll out after a `git pull`.
- **The box owns no durable state.** Everything that matters lives in Convex or in a repo. The local files with memory are poll cursors under `/var/lib/tts` and rebuildable caches under `/var/cache/tts`; losing them costs duplicate captures and some re-work.
- Cron jobs (`/etc/cron.d/tts`, one log per job under `/var/log/tts`): `poll-dump` hourly at :07 (the reconciliation backstop behind the Slack Events push route), `poll-gmail` every 10 min, `poll-canvas` at :13 and :43, `apply-time-notes` every 2 min, `prepare-life-todos` every 2 min (flock-guarded), `prepare-queue` at 08:30 and 09:30 UTC (the one that is 4:30 a.m. New York proceeds), `brief-code-todos` every 2 h at :17, `plan-graphs` every 2 h at :27 (the batch planner), `form-batches` every 2 h at :07 (the superseded v1 batcher, removed at cutover), `apply-rulings` every 10 min, `execute-approved` hourly at :45.
- Jobs are Node ESM and cannot import TypeScript. Anything they need from `convex/ttsShared.ts` is fetched over HTTP or mirrored as a literal, and `scripts/check-session-mirrors.mjs` fails when a mirrored constant drifts from its one home.
- `tts-browse` opens a real page from the box and reports console errors and failed requests. `--login` signs in with `TOMQUEST_AGENT_USERNAME` / `TOMQUEST_AGENT_PASSWORD`, which currently hold Tom's own account, so every session browses at role `tom`.
- The box has no path to the Turing cluster, deliberately: that API's key would grant arbitrary commands on the cluster, so it is absent from `worker.env`. Adding it is a posture decision, not a setup step.
- `worker/README.md` carries the operational detail — account switching, Gmail credentials, running any job by hand.

## Sessions Surface

- A session is a real Claude Code run on the Jarvis Box, streamed into tom.Quest. The daemon is `worker/session-host/`; the design home is WikiTom `tts/spec.md` §20.
- **Convex is the message bus.** The browser writes commands (`claudeInbound` rows: user-turn, interrupt, stop); the daemon polls `/sessions/poll` and persists every event through `/sessions/ingest`; the page renders reactively from Convex.
- The transcript is two-tier: `claudeMessages` rows are finalized, written once, and seq-ordered, while `claudeStreamBuf` is the one small live-tail row per session. Whether a session is failing is derived at render from heartbeat staleness (`claudeDaemonHealth`), never written as a diagnosis.
- A session holds `repos` (an array; the older single `repo` string stays because prod schema is additive-only, and readers take `repos ?? [repo]`). Each repo is cloned to `/var/cache/tts/sessions/<id>/<repo>` on branch `session/<id>`. With exactly one checkout the working directory is that checkout; with more than one it is the parent directory.
- `mode: "autonomous"` sessions are fleet-scheduled groundwork with nobody watching: created only by the Convex scheduler cron, wall-clock capped, ended by the daemon after the final turn, and admitted on box load (`claudeAutoConfig`, disabled until the enable pen is used). The agent records its own outcome with `POST /tts/session-outcome` and writes prepared work with `POST /tts/prepare-todo`, both `X-TTS-Key`.
- **Merging is Tom's gate.** A session pushes its own `session/<id>` branch and may open a pull request; nothing lands on the default branch autonomously. An agent never records a ruling — verdicts are Tom's alone.

## VQC Governance (`vqc/`)

- tom.Quest adopts VQC, the governance constitution at `ComplexMultiTrigger/vqc/constitution.md`, ignoring CMT-specific articles. `vqc/adoption.md` is the binding: which articles apply, where each statute lives, what runs when, and an append-only rulings log. Read it before changing anything under `vqc/`.
- Adoption is a **ratchet**: a gate applies to new work, and pre-existing violations become dated ledger entries. Never a silent cutoff and never a frozen exemption.
- The four registries, and the one rule each that is easy to get wrong:
  - `vqc/todos.yaml` — CHOICE, decided intent. Any agent may add an entry freely and is encouraged to whenever it finds work worth doing. **Closing a todo keeps the entry**: set `status` to done or archived and add `resolution`, in the same commit as the work. Ids are never reused.
  - `vqc/ledger.yaml` — KNOWLEDGE, a discovered fact about the tree, which may sit there untiered indefinitely. **Graduating an entry deletes it**, in the same commit as the work that satisfies its `graduates_when`. A deletion without landed work is the gaming signal.
  - `vqc/steering.yaml` — human corrections captured at the moment given, each a gotcha, a preference, or a pre-emption.
  - `vqc/classification.yaml` — every governed file is knowledge, choice, derived, or scratch, and the class alone decides the edit rules: derived is generated-only, and scratch is quarantine that governed code never imports.
- A todo and a ledger entry are not interchangeable: a todo **cites** a ledger entry and never copies its content. `cites` is required and non-empty and resolves against constitution article ids, `tts-spec:<section>`, or open ledger ids. `vqc/todos.test.ts` and `vqc/registries.test.ts` enforce both files' shapes in CI.
- Plans belong inline in the conversation, never in standalone plan documents, unless Tom asks for a document.

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
- `pnpm test:turing` runs the Convex and VQC guard tests CI gates on (a subset of `pnpm test`).
- `pnpm check:guardrails` runs the contract fences: the auth boundary, the heavy-library budget, and the session-constant mirrors between `convex/ttsShared.ts` and the worker daemon.
- `pnpm check:writing` reports how many stored briefs and ground-up explanations fail the writing standard. It reads prod Convex and needs `TTS_WORKER_KEY`, so it is run on demand rather than in CI.
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
