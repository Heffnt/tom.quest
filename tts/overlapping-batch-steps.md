# Two edits that two TTS batches both ask for

**Written 2026-08-31, verified against tom.quest `main` at commit `52120a9`.**
**Delete this file in the commit that discharges the second of the two edits below.** It exists only to stop the same edit being made twice, in two pull requests, against the same lines.

## What this file is, from the beginning

TTS (Toms Todo System) is Tom's todo system: a Convex backend (`convex/tts.ts`, `convex/schema.ts`), a web surface at `/tts`, and cron jobs on a worker box under `worker/jobs/`. Its todos are grouped into **batches**. A batch is not itself a todo; it is a container holding how a set of todos gets completed. Inside a batch, a **goal** is a state of the world written as a condition that is either true yet or not, and a **task** is work someone does. Autonomous Claude sessions claim one todo at a time and work only that one, so two sessions can be editing the same repository at the same time without knowing about each other.

Two batches currently contain the same two edits. Their statements were written at different times against different commits, so they disagree on line numbers and, in one place, on the answer. This file is the merged, checked version: for each of the two edits, what to change, which batch item it discharges, and what the commit message must say.

| Short name used below | Batch statement |
|---|---|
| the ingestion batch | "TTS: unblock ingestion, fix the count Tom reads, finish the rename" |
| the worker-job batch | "TTS: the worker job that drops rulings, and the names left over from the rename" |

The ingestion batch numbers its tasks; step 8 and step 12 are the two that overlap. The worker-job batch states the same two things as goals, without step numbers.

| Edit | Ingestion batch | Worker-job batch | Which is larger |
|---|---|---|---|
| The rulings HTTP handler in `convex/http.ts` | step 8 (task) — deletes two dead route registrations, renames two handler constants, rewrites four comments | goal — renames one handler constant, fixes two comments | step 8 is a superset; do step 8 and both are satisfied |
| The table count in `vqc/adoption.md` | step 12(b) (task) — names two options and does not choose | goal — says correct the count | this file chooses; see below |

## Line numbers in both batches are stale; here is the map

Both batches were written against an earlier commit of `main`. Every line number they cite for `convex/http.ts` and `convex/schema.ts` is now wrong by roughly 254 and 204 lines respectively. Nothing about the edits changed — only where they sit.

| What | Cited in the batches | Actual at `52120a9` |
|---|---|---|
| `dtsCodeRulings` handler declaration | `convex/http.ts:495` | `convex/http.ts:749` |
| canonical route `GET /tts/rulings` | `convex/http.ts:508` | `convex/http.ts:762` |
| alias route `GET /tts/code-rulings` | `convex/http.ts:509` | `convex/http.ts:763` |
| comment "drop the alias in the tts→tts rename round" | `convex/http.ts:507` | `convex/http.ts:761` |
| `ttsCodeRulingApplied` handler declaration | `convex/http.ts:513` | `convex/http.ts:767` |
| canonical route `POST /tts/ruling-applied` | `convex/http.ts:544-548` | `convex/http.ts:798-802` |
| alias route `POST /tts/code-ruling-applied` | `convex/http.ts:549-553` | `convex/http.ts:803-807` |
| comment "Remove in the tts→tts rename round" | `convex/schema.ts:639` | `convex/schema.ts:845` |
| `dtsCodeRulings` table declaration | `convex/schema.ts:641` | `convex/schema.ts:846` |
| the `tts-rename` ledger entry's "eight populated Convex tables" | `vqc/adoption.md:119` | `vqc/adoption.md:121` |

Re-grep before editing rather than trusting either list; another session may land a change in between.

## Edit one: the rulings HTTP handler

### The situation, stated fully

`convex/http.ts` registers the HTTP routes the worker box calls. Two of them are **aliases**: a second URL path registered against a handler that already answers on a newer path. `GET /tts/code-rulings` (line 763) and `GET /tts/rulings` (line 762) are the same handler; `POST /tts/code-ruling-applied` (lines 803-807) and `POST /tts/ruling-applied` (lines 798-802) are the same handler. The aliases were kept during the 2026-08-28 unification, when rulings on code todos and on life todos moved into one table and one feed: a worker process still running the older code would have received 404 on the new paths, so the old paths were held open until the worker redeployed.

The worker has redeployed. A grep over `worker/`, `app/` and `scripts/` at `52120a9` returns no caller of either alias path. The five worker jobs that use this feed — `apply-rulings.mjs`, `execute-approved.mjs`, `plan-graphs.mjs`, `form-batches.mjs`, `prepare-life-todos.mjs` — call only `/tts/rulings` and `/tts/ruling-applied`. The two alias registrations are dead lines.

The handler constant serving the feed is still named `dtsCodeRulings`. "dts" is the system's former prefix; identifiers were renamed to "tts" on 2026-08-29 and this one was missed. The name is wrong twice over: the prefix is dead, and the feed has not been code-only since the unification — its rows carry a `subjectType` of `code`, `life` or `batch`, and the comment above it at lines 741-748 already says so.

### The exact changes

Delete, in `convex/http.ts`:

- line 763, the `GET /tts/code-rulings` registration;
- lines 803-807, the `POST /tts/code-ruling-applied` registration block;
- lines 759-761, the three-line comment explaining why the GET alias is kept — deleting it is also the fix for the mangled sentence "drop the alias in the tts→tts rename round" (written as "dts→tts", and this is that round), because the sentence has no subject once the alias is gone;
- lines 796-797, the two-line comment "Canonical path: /tts/ruling-applied (any subject type); old name aliased for not-yet-redeployed workers."

Rename, **inside `convex/http.ts` only**:

- `dtsCodeRulings` → `ttsRulingsFeed`, three occurrences: the declaration at 749 and the registrations at 762 and 763 (763 is being deleted, so two survive);
- `ttsCodeRulingApplied` → `ttsRulingApplied`, three occurrences: the declaration at 767 and the registrations at 801 and 806 (806 is being deleted, so two survive).

Rewrite these comments:

- line 741, the header `GET /tts/code-rulings` → `GET /tts/rulings`;
- line 743, "from the unified ttsRulings table" → "from the unified dtsRulings table". The **table** is `dtsRulings` (`convex/schema.ts:714`); `ttsRulings` is the **module** `convex/ttsRulings.ts`, whose query the handler calls at lines 752-754. Written as-is, a reader who greps for the table name finds nothing.
- line 765, the header `POST /tts/code-ruling-applied` → `POST /tts/ruling-applied`;
- `convex/schema.ts:845`, "No new writes. Remove in the tts→tts rename round." → "dts→tts". This is the only other surviving instance of the same mangled phrase, and fixing it is what makes the phrase legible once the `http.ts` copy is gone.

### The name to use, and the one the batch statement asks for

The ingestion batch's step 8 statement says rename to `ttsRulings`. Its own longer edit list, written later in the same batch, says `ttsRulingsFeed` and gives the reason: line 753 inside that same handler already reads `internal.ttsRulings.internalPendingRulings`, so `ttsRulings` would spell a local constant (declared at line 749) and a Convex module identically, four lines apart. **Use `ttsRulingsFeed`.** The passed-over alternatives are `ttsRulings` (matches the file's convention of naming a handler constant after its canonical path, at the cost of that collision) and `ttsPendingRulings`.

### The hazard that makes this not a find-and-replace

`dtsCodeRulings` is also a **live Convex table name**, declared at `convex/schema.ts:846`. That table is the deprecated pre-unification ruling history; it takes no new writes, and it is read by the one-time migration at `convex/ttsRulings.ts:446` (`ctx.db.query("dtsCodeRulings")`) and inserted into by `convex/ttsRulings.test.ts` at lines 474, 482, 489, 495, 501 and 544. A repo-wide rename of the string would point the migration and the schema at a table that has never existed and would silently orphan the stored history. Rename by line, in `convex/http.ts` only.

### How to check it

No test asserts route registration — there is no `convex/http.test.ts` — so the suite stays green if a route is deleted by accident. What does catch a mistake: `npx tsc --noEmit` (a missed rename occurrence is an unresolved identifier), `pnpm lint`, and the Vitest run that includes `convex/ttsRulings.test.ts`, which fails loudly if the table name was touched. After the change deploys, `GET $CONVEX_SITE_URL/tts/rulings` with header `X-TTS-Key` must still answer 200 and `GET $CONVEX_SITE_URL/tts/code-rulings` must answer 404.

## Edit two: the table count in the ratified ledger

`vqc/adoption.md` is the ledger of rulings Tom has ratified: each entry records a question and his answer, and the file is the record of what he decided, not a working document. The entry `tts-rename` (2026-08-29, lines 113-125) records that the rename from the old "D" name to TTS is real and reaches everything, with one exception: "The ONE exception, the eight populated Convex tables (dtsTodos and siblings), keeps the frozen historical prefix."

There are nine such tables, not eight. At `52120a9`, `convex/schema.ts` declares `dtsTodos` (400), `dtsBlocks` (661), `dtsTimeNotes` (687), `dtsRulings` (714), `dtsEvents` (751), `dtsDailyQueues` (773), `dtsCodeTodoMirror` (790), `dtsCodeBriefs` (810) and `dtsCodeRulings` (846).

The ingestion batch's step 12(b) names two options and does not choose: leave the number and note the drift where the tables are listed in `convex/schema.ts`, or correct the number and say in the same line that it is a count correction and not a change to the ruling. The worker-job batch simply says to correct it.

**Do the second, in this exact shape:** change "eight" to "nine" and add, inside the same ruling text, the clause "(count corrected 2026-08-31 from eight; the exception itself is unchanged)". The reason is that the ruling's substance is *which* tables are exempt — all of the `dts`-prefixed populated ones — and a wrong count invites a reader to go looking for the table that is not exempt. Marking the correction inline keeps the ledger honest about the fact that an agent, not Tom, touched the sentence. The exemption is separately documented at `convex/schema.ts:343-347`, which states the frozen-prefix rule and does not state a count; leave that comment alone rather than adding a second copy of the number that can drift again.

Tom's gate on this is the pull-request merge, as it is for every change in this repository. Do not hold the branch waiting for a ruling on the wording.

## What the commit message must say

Both batches ask for the same discipline, and this is the reason for it: when two batches carry one edit, the commit is the only place a later reader can see which item was discharged and which one is therefore already satisfied. Name both.

For edit one:

```
Delete the two alias ruling routes and rename their handlers

Discharges step 8 of the TTS batch "unblock ingestion, fix the count Tom
reads, finish the rename", which also satisfies the handler-rename goal in
the TTS batch "the worker job that drops rulings, and the names left over
from the rename". One edit, both items.
```

For edit two:

```
Correct the table count in the ratified tts-rename ledger entry

Discharges step 12(b) of the TTS batch "unblock ingestion, fix the count Tom
reads, finish the rename", which also satisfies the table-count goal in the
TTS batch "the worker job that drops rulings, and the names left over from
the rename". One edit, both items.
```

Step 12(a) — two comments that say `form-batches` runs every 6 hours when its cron expression `7 */2 * * *` says every 2 — is not duplicated in the other batch and is unaffected by this file.
