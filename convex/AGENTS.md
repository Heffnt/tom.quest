# convex

## gates

- A Tom-only write is `requireTom(ctx, label)`; an elevated write is `requireAdmin`.
- A read the `agent` account may make is `requireTomOrAgent(ctx, label)`; every write stays on `requireTom` / `requireAdmin`.
- `roleAccess("agent")` returns `isAdmin: false` and `isTom: false`, so every gate denies `agent` unless it names the agent door.
- The reach of `agent` is one list, `convex/agentSurfaces.ts`. Widening it is adding one label; the labels are the ones `requireTom` already takes, so read gates and write gates share one vocabulary.
- `users.setRoleByUsername` grants or revokes `user`, `admin` and `agent`; it never mints or demotes a `tom`.

## crons

- `internal.serverHealth.pollTuring` probes the Turing API's `/health` and writes the `serverHealth` table; `useServer("turing").status` reads it.
- `internal.gpuPool.reconcile` drives the `gpuPool` table's desired state against the Turing API and tracks its own jobs in `gpuPoolAllocation`, so it cancels only pool-created jobs. It needs `TURING_API_KEY` in the Convex env, not only Vercel's.

## inspecting

- The Convex dashboard is where server state, function logs and query performance are read.

## codegen

- `npx convex codegen` needs `CONVEX_DEPLOYMENT` and validates it over the network, so a session without deploy credentials cannot run it.
- After adding `convex/<mod>.ts`, hand-add it to `convex/_generated/api.d.ts`: one `import type` line and one `fullApi` entry, both alphabetical. The runtime resolves any path through `anyApi`, and Vercel's `convex deploy` regenerates the file identically. A new export in a registered module needs no edit.

## tests

- Never add `/// <reference types="vite/client" />` to a Convex test, whatever the generated guidelines say: `vite` is not hoisted to the top-level `node_modules`, so it fails in CI. `ImportMeta.glob` is declared in the committed `convex/test-env.d.ts`.

## schema

- Dropping a table from `convex/schema.ts` deletes nothing: `convex deploy` validates only declared tables and the rows persist undeclared. Purging data takes the dashboard or the CLI with credentials.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
