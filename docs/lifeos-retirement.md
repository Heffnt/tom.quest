# The lifeos update — retirement matrix

The ledger the phase-7 counts derive from (design revision 4, section 6). One row per field, table, or job the update removes. Every row moves through the same three states, in order, and the state column says where it is:

- **widened** — the code reads both the old and the new shape; the new shape is written; nothing is dropped.
- **migrated** — the resumable migration in `convex/ttsMigrations.ts` (or the existing one it names) has run against prod, its counts recorded in `dtsEvents`, and every reader of the old shape is gone.
- **narrowed** — the old field, table, or job is deleted from the schema, the crons, or the box. The gate column names what must be true first.

Non-negotiables that hold through every state: nothing is deleted from the todo record; every date outcome stays; ordering is by needs and dates; a raw capture is never ready.

## Fields on `dtsTodos`

| Removed | Readers and writers today | Destination | Gate | Status |
|---|---|---|---|---|
| readiness values `preparing`, `ready-for-tom` | every reader goes through `ttsShared.normalizeReadiness` / `isPrepared`, one reading per spelling: `ready-for-tom` reads as `prepared`, `preparing` (a half-finished write-up) as `unprepared`; writers write `prepared` (worker pen, repeats minter, v1 batcher) or `unprepared` (revise verdict); the worker pen still accepts the retired spellings from an older box job and stores the value each reads as | `prepared` or `unprepared`, as read, + computed ready (`ttsShared.isReadyForTom`: prepared, active, wakeAt passed or absent, every need done) | `internalMigrateReadiness` run on prod with a zero count for both retired spellings on a second run (`ready-for-tom-to-prepared`, `preparing-to-unprepared`) | widened (this branch; migration written and tested) |
| status value `waiting` | `ttsShared.waitingReason` reads it as a sleep; `isReady` excludes it; the fallback queue's wake loop still reads it; the page's status filter still offers it | active + `wakeAt` (a sleep is a wakeAt on an active row; `isReady` and `wakeAtPassed` honour it) | `internalMigrateTiming` run on prod, `waiting-to-active` zero on a second run; the wake loop, the status filter chip and the "Set waiting" control removed | widened (this branch; migration written and tested) |
| `timingClass` | `tts.ts` scheduling lanes, the fallback queue's condition lane, `goalCheckable`, the page's chip and fact grid, the session prompts | the row's date (`dueAt`) and its sleep (`wakeAt`); a condition-bound row becomes a task whose statement carries the condition sentence | `internalMigrateTiming` run, `condition-bound-to-task` and `condition-bound-goal-kept` zero on a second run; the lanes rewritten to read dueAt and wakeAt only | widened (this branch) |
| `latestSafeAt` | the fallback queue's condition lane (`CONDITION_WINDOW_MS`), the time-note actions `set-latest-safe` / `clear-latest-safe`, the page's fact grid, the time-note context | `wakeAt = latestSafeAt − CONDITION_WINDOW_MS` written by the migration on an active row that has no wakeAt of its own (one Tom set stays, counted `condition-wake-kept`); a done or archived row is mapped for the validator only — its kind, timingClass and statement move, no wakeAt is written | migration run; the time-note actions retired and the fact removed | widened (this branch) |
| `wakeCondition` | `applyStatusChange`, the time-note `set-waiting` action, the page's waiting line (through `waitingReason`), the calendar's wake mark title | the statement (carried in as "— when: …" when the row had no wake time); the sleep itself is `wakeAt` | migration run, `waiting-condition-carried` zero on a second run; the field dropped from `applyStatusChange` and the time-note action | widened (this branch) |
| `unarchiveCondition` | six writers (`applyStatusChange`, the archive verdict, the planner's retirement, the graph migration's pointer), the page's archived line, the graph migration's idempotence key | left in place on the row; the weekly gather (phase 8) lists archived rows whose sentence names a return condition, skipping the `GRAPH_SUPERSEDED` pointer | the weekly job live and listing them for a week | widened (counted by `internalMigrateTiming`: `archived-with-return-condition`, `archived-superseded-by-graph`) |
| `members`, `plan` | the v1 batch paths: `internalStoreBatches`, `setPlanStep`, the scheduler's legacy lanes, `planNeedsYou`, the v1 session prompt, `form-batches.mjs` | the graph (`batches` + `batchId`/`needs`), through `tts.internalMigrateToGraph` (existing, tested; counted by `internalMigrateTiming` as `v1-batches-pending-graph-migration`) | `internalMigrateToGraph` re-run on prod with `batches: 0`; `form-batches.mjs` removed | widened |
| `importance` (todos, code briefs), `model`, `execClass` | nothing reads `importance`; the scheduler reads `model` (fleet default when absent); nothing live reads `execClass` | `mustNotBreak` on goals (this branch); the worker decides execution | column verified empty (`importance`); `model` readers moved to the fleet default | widened (`mustNotBreak` added this branch; nothing dropped) |
| `body`, `brief`, `workDescription` | the preparer pen, the prompts, the page's fact grid, the batch card's goal fallback (`groundUpExplanation ?? brief`) | `groundUpExplanation` | rows merged by a migration not yet written | not started |
| `dateOutcomes` array | `recordDateOutcome`, the kept-dates resolution, the missed rollover | append-only `dtsEvents` rows | exported and replayed; a migration not yet written | not started |

## Fields on `batches`

| Removed | Readers and writers today | Destination | Gate | Status |
|---|---|---|---|---|
| `path` (name, index, edge) | the planner's pen stores it (preserve by omission); the scheduler orders pathed batches by it; the batches tab groups by it (the paths bar); the worker and session prompts print it | `needs` (batch ids): a "must" edge becomes a need on the previous batch of the path; a "helps" edge becomes nothing; `internalMigrateBatchNeeds` derives them | migration run on prod, `must-to-need` zero on a second run; the paths bar removed (the page phase); the scheduler's path ordering dropped | widened (this branch; migration written and tested) |

## Fields on `dtsCodeBriefs`

| Removed | Readers and writers today | Destination | Gate | Status |
|---|---|---|---|---|
| recommendation values `stale-replan`, `needs-session`, `propose-archive` | the brief pen and route accept them and store the verdict word; the page's chip reads them normalized | the four verdict words: `revise`, `session`, `archive` (`approve` stays) | `internalMigrateRecommendations` run on prod, every `-to-` count zero on a second run; the box's `brief-code-todos.mjs` deployed with the four words | widened (this branch; migration written and tested) |

## Tables

| Removed | Readers and writers today | Destination | Gate | Status |
|---|---|---|---|---|
| `dtsDailyQueues` | the fallback queue prep (`internalPrepareFallbackQueue`), the worker prep pen (`internalStoreWorkerPrep`), `getToday`, the calendar tab's today column, the digest's `digestSentAt` | today's view computed (due, overdue, scheduled, ready, wakeAt within the day) and the digest composer | the composer live for a week | not started |
| `dtsCodeRulings` | `internalMigrateCodeRulings` (one-time copy, already run) | export to `tts/snapshot/` | export verified | not started |
| `claudePermissions` and the `awaiting-permission` session status | the daemon's permission path (historical), `LIVE_STATUSES` | export to `tts/snapshot/` | export verified | not started |

## Jobs

| Removed | Readers and writers today | Destination | Gate | Status |
|---|---|---|---|---|
| `prepare-queue.mjs`, the fallback prep cron | `dtsDailyQueues` | the computed today view and the digest composer | composer live for a week | not started |
| `prepare-life-todos.mjs`, its 2-minute cron, and the spawn from `poll-dump.mjs` | the box's cron; `poll-dump.mjs` spawned it after a capture | the planner's prepare pass (`plan-graphs.mjs` `prepareLifeTodos`, every 30 minutes under flock): brief, entry action, work description, ground-up explanation, readiness `prepared`, the statement's own date; life revise rulings consumed there. The threaded Slack reply is posted by the capture itself, so nothing waits on preparation | the pass live for a week | narrowed (this branch) |
| `brief-code-todos.mjs` and its 2-hourly cron | the box's cron | the planner's brief pass (`plan-graphs.mjs` `briefCodeTodos`, every 30 minutes): the same brief shape, the four verdict words, the hash cursor; a code revise ruling is read off `/tts/rulings` (no cursor sentinel) and consumed once the fresh brief has posted | the pass live for a week | narrowed (this branch) |
| `apply-rulings.mjs` and its 10-minute cron | the box's cron; it consumed code revise/session/archive rulings | every verdict's effect at write time in `convex/ttsRulings.ts`, or at the one moment it can exist: a code revise → the planner's brief pass (consumed once the fresh brief posts); a code session → applied when Tom opens the code block session (`markLiveCodeSessionRulingsApplied`); a code archive → a worker mission admitted by the auto-session scheduler, closing the entry in the repo's todo file into a pull request (the next row) | the replacements live for a week | narrowed (this branch) |
| `execute-approved.mjs`, its hourly cron, its lock and its throwaway clones; the local brief copies under `/var/cache/tts/briefs/` | the box's cron; it consumed code approve rulings | the auto-session scheduler's code lane (`convex/claudeSessions.ts` `admitCodeMissions`): an approve or archive ruling on a code todo is admitted as a worker mission on a `session/<id>` branch that ends in a pull request, one code mission at a time, under the load gate, the circuit breaker and the per-subject ceiling (`claudeSessions.by_code_subject`); the ruling applies at admission with the session id | the lane live for a week | narrowed (this branch) |
| `form-batches.mjs` | the box's cron | `plan-graphs.mjs` (already the only writer of new batches) | the graph migration run | not started |
| the model-of-Tom refresh cron and its read token, the Convex Canvas sync | `ttsSkills`, `ttsCanvas` | the nightly job's post, `poll-canvas.mjs` | replacement live for a week | not started |

## Page

| Removed | Readers and writers today | Destination | Gate | Status |
|---|---|---|---|---|
| the capture bar, paths bar, plan bar, graph view, readiness filters, the no-open-task chip, the permission card, the fleet numbers, the explainer documents | `app/tts` | section 3 of the design | popover test green | not started (the page phase) |

## How a row moves

1. **Dry run against the local harness** (`convex/ttsMigrations.test.ts` holds the counts each mapping produces on its fixtures), then against prod with `dryRun: true` and a page size larger than the table, so the totals return in one call:
   `npx convex run ttsMigrations:internalMigrateReadiness '{"dryRun":true,"pageSize":5000}'`
   A dry run writes no todo row (and no batch or brief row); it does write one `dtsEvents` row, kind `<name>-dry-run`, holding the counts, so the numbers Tom saw are on record. Terminal rows (done, archived) are walked and counted like the rest and their shape is mapped so the retired value leaves the validator; nothing that reads as live — a sleep, a status — is written on them.
2. **Run** without `dryRun`. A scheduled chain reports its totals as one `dtsEvents` row (`<name>-migrated`); a single large page returns them directly. Rollback point: the export the preserve phase made, plus the per-row events every mapping writes (`status-changed`, `timing-mapped`, `batch-needs-derived`).
3. **Verify** with a second run: every mapping count is zero and the only non-zero counts are the ones a walk only counts.
4. **Narrow** in one commit per row of this matrix, once the gate holds, updating the status column in the same commit.
