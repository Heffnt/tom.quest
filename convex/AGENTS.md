# convex

## gates

- A Tom-only write is `requireTom(ctx, label)`; an elevated write is `requireAdmin`.
- A read the `agent` account may make is `requireTomOrAgent(ctx, label)`; every write stays on `requireTom` / `requireAdmin`.
- `roleAccess("agent")` returns `isAdmin: false` and `isTom: false`, so every gate denies `agent` unless it names the agent door.
- The reach of `agent` is one list, `convex/agentSurfaces.ts`. Widening it is adding one label; the labels are the ones `requireTom` already takes, so read gates and write gates share one vocabulary.
- `users.setRoleByUsername` grants or revokes `user`, `admin` and `agent`; it never mints or demotes a `tom`.
- A message to a human other than Tom (a Slack post to someone else, a calendar event with guests) goes out only inside `ttsSignoff.deliverAsTom`, which needs a `signoffs` row matching sha256(text), recipient and channel. `ttsSignoff.signAndSend` (requireTom) is that table's one writer; no route or internal function inserts there. An agent asks through `POST /tts/send-proposal`.

## crons

- `convex/crons.ts` holds the thread digest, run hourly so its 05:00 New York run appends (Tom, 2026-10-05: the digest on a Convex cron at 05:00), and the silence alarm, which must run when the box does not. Every other timed task is a row of `TICK_TASKS` in `convex/jarvis/tick.ts`, started by the box's record-tick job.
- A timed task of the record is an entry in `TICK_TASKS` (`convex/jarvis/tick.ts`), started by the box's `record-tick` job through `POST /jarvis/tick` when its cadence comes round; its last run is its own `job-ok`/`job-failed` row under `tick:<name>`. `internal.serverHealth.pollTuring` is one: it writes the `serverHealth` row `useServer().status` reads.
- The day's digest is appended to the Jarvis thread by the record's cron (`appendThreadDigest`, `convex/jarvis/digest.ts`), and a producer's decision or failure line goes into it through `listForDigest` (`convex/jarvis/outbox.ts`), never to a channel of its own. The silence alarm writes `silence-alarm` rows to the thread with a web push, not to Slack.

## sessions

- A session's rows are its agent file's, read by its `runId`; a session with no `runId` has none. A reader asks `sessionRows.rowSource`, and never picks an index itself.
- What the session daemon knows that the agent file does not is a note in `sessionNotes`, never a row.

## removals

- A part of Jarvis is retired by a `part-disabled` event (`shared/jarvis-events.mjs`; subject the part, data `{ id, part, replacedBy, ruling }`) before its code is deleted, so the record says when and why it stopped; the box's deploy job posts it from Jarvis `worker/parts-disabled.json`, and the record keeps one row per part.

## work runs

- A worker run is recorded as a `work-run` event (`shared/jarvis-events.mjs`; subject `<repo>@<baseCommit>`); the brief and both diffs are agent-store keys, not row text, because of the 1 MiB document limit, and Jarvis's eval set `work-runs` replays them.

## use

- A part of Jarvis (an id of Jarvis `worker/parts.json`) is used, or has an issue, as a `use` or `issue` event (`shared/jarvis-events.mjs`; subject the part, `data.by` tom, agent or job); its state (unverified, run, in use, working, issue) is derived from those rows, the `job-ok` rows and the landing rows by `convex/jarvis/partStates.ts`, never stored. An issue closes by a later row, never by a patch: the table is append-only.

## inspecting

- The Convex dashboard is where server state, function logs and query performance are read.

## codegen

- `npx convex codegen` needs `CONVEX_DEPLOYMENT` and validates it over the network, so a session without deploy credentials cannot run it.
- After adding `convex/<mod>.ts`, hand-add it to `convex/_generated/api.d.ts`: one `import type` line and one `fullApi` entry, both alphabetical. The runtime resolves any path through `anyApi`, and Vercel's `convex deploy` regenerates the file identically. A new export in a registered module needs no edit.

## tests

- Never add `/// <reference types="vite/client" />` to a Convex test, whatever the generated guidelines say: `vite` is not hoisted to the top-level `node_modules`, so it fails in CI. `ImportMeta.glob` is declared in the committed `convex/test-env.d.ts`.

## schema

- Dropping a table from `convex/schema.ts` deletes nothing: `convex deploy` validates only declared tables and the rows persist undeclared. Purging data takes the dashboard or the CLI with credentials.
- The model-of-tom publication table fails closed until the nightly post has written its singleton; there is no backfill door any more.
- A read whose rows grow with a table carries a cap, named beside the read: a `.take(n)`, a `.paginate()`, or a byte budget. An index range is a cap only when it returns a bounded number of rows by construction, one row per key or a key whose rows cannot accumulate; one key whose rows keep accumulating, such as `by_readiness` on "prepared", is not a cap. `.collect()` is not written on a read whose rows grow.
- Why: the digest's `gatherTodayFacts` read every prepared todo on the `by_readiness` index with `.collect()` (1,588 rows, 8.9 MB) beside other uncapped reads, passed Convex's 16 MiB limit on what one function may read on 2026-09-29, and the digest failed on every run from that day until its reads were capped.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
