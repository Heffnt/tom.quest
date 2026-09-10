# tom.Quest

A personal dashboard for cluster management, experiment visibility and TTS. Write its name as tom.Quest.

## stack

- Next.js App Router, React, Tailwind (theme tokens in `app/globals.css`), pnpm.
- Convex holds every server state: schema, queries, mutations, HTTP actions, Convex Auth (password provider).
- Zustand holds UI-only state.
- Sentry (errors, performance, replay); Vitest with convex-test; Playwright end-to-end.
- Vercel serves the frontend, Convex Cloud the backend, the Jarvis Box runs `worker/`.

## roles

- `user`: the sign-up default; sees public quests.
- `admin`: elevated quests; a trusted friend or colleague may hold it.
- `tom`: his account; admin plus Jarvis config and the diagnostic panel.
- `agent`: the account a TTS session's headless browser signs in as; a side branch, not a rank. It reads a named list of surfaces and writes nothing.
- Gate Tom-only features on `isTom`, elevated ones on `isAdmin` (true for `admin` and `tom`).

## deployment

- One Convex deployment, prod. `next dev` runs against it. Functions and schema go live on `npx convex deploy` only.
- Vercel builds through `scripts/vercel-build.mjs`: production runs `npx convex deploy --cmd 'pnpm build'`; a preview runs `pnpm build` alone and deploys no functions.
- The committed `.env` holds the two public `NEXT_PUBLIC_*` values, so a bare checkout builds; Vercel's env and `.env.local` override it.
- `secrets/next.env` is the source of truth for Vercel prod env (mirrored to `.env.local`), `secrets/convex.env` for Convex prod env. `pnpm secrets:sync` pushes both; `pnpm secrets:init` pulls once. Never edit Vercel or Convex env directly.
- A push to `main` is the deploy: Vercel builds every `main` commit to production; the Vercel CLI is a fallback.
- Never push one sha to `main` and a branch together: Vercel deduplicates by sha, builds only the preview, and production stays on the previous commit with no red check, only a missing Production row. Push `main` alone, or the branch first.

## verification

- `pnpm dev:all`: Next.js against prod Convex plus a `convex dev` typegen watcher.
- `pnpm build`: the production build; CI runs it on every PR; before deployment work it outranks style checks.
- `pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm check:guardrails` (the static checks CI runs).
- The merge bar is the three Guardrails jobs green: `static-boundaries`, `secret-scan`, `tests` (typecheck, the Turing suite, the build); no other check is a gate.

## worktrees

- A fresh worktree has no `node_modules`: `pnpm install --frozen-lockfile` first.
- A worktree has no `.env.local`: copy it from the main checkout before `next dev`. `pnpm build` needs no secrets.

## observability

- The Tom-only diagnostic panel is the one in-app place to inspect bug context; its Copy diagnostics button emits agent-ready text.
- Log no secret, token, signature or large payload.

## style

- Simple interfaces around deep modules.
- One central pattern per concern, not a copy per feature.
- A bug fix carries a regression test that fails if the bug returns; an untestable bug carries a warning comment at the danger point. Neither is logged here.
- A commit subject is lowercase, names the area, and states the world after the change: `tts: the page has no capture bar`. The body is full sentences, one idea per paragraph, then the `Co-authored-by` trailer. PRs squash-merge: the PR title and body are what land.

## binaries

- A blob over 50 MiB warns on every push, over 100 MiB the push is refused, forever. Large binaries go to Git LFS or outside the repo.
- `scripts/check-large-files.mjs` fails the build on an untracked-by-LFS file over 50 MiB; known ones are in its `KNOWN_LARGE` map.

## files

- Nested `AGENTS.md`: `app/`, `app/api/turing/`, `convex/`, `turing-api/`, `worker/`; each applies to its tree.
- Beside each, a regular `CLAUDE.md` holds `@AGENTS.md`; `pnpm check:agents` enforces it.
- WikiTom `model-of-tom/` holds who Tom is and how agents operate.
