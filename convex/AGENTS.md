# Convex

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

## Verification

- Do not reintroduce `/// <reference types="vite/client" />` into a Convex test, even though the generated Convex guidelines recommend it. `vite` is not hoisted to the top-level `node_modules`, so the reference resolves from a local checkout and fails in CI; `ImportMeta.glob` is declared instead in the committed `convex/test-env.d.ts`.
- A session without Convex deploy credentials cannot run `npx convex codegen` — it requires `CONVEX_DEPLOYMENT` and validates the name over the network. After adding `convex/<mod>.ts`, hand-add the module to `convex/_generated/api.d.ts` (one `import type` line and one `fullApi` entry, both alphabetical) so `api.<mod>.*` typechecks; the runtime already resolves any path through the `anyApi` proxy, and Vercel's `convex deploy` regenerates the file identically. New exports in an already-registered module need no edit.
- Dropping a table from `convex/schema.ts` is non-destructive. `convex deploy` validates only the tables still declared, so the rows persist on the deployment as an undeclared table rather than erroring or being deleted. Removing an unused table from the code is therefore safe to ship; actually purging the data needs the dashboard or the CLI with credentials.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
