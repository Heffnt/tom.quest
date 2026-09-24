# evals/golden/explanations

Twenty-seven golden items mined from Tom's own session logs
(`scripts/import-explanation-golden.mjs`): a ground-up explanation an agent
wrote him, and his next message as the label — twelve landed (P1 to P12), fifteen
did not (N1 to N15). None is confirmed by Tom, so each is run and reported and
never fails a pull request.

## What an item is replayed from

The `explanation` job in `worker/jobs/evals.mjs` writes the explanation again
from the tree under test and has a judge compare it with the one Tom ruled on.
For that comparison to say anything about the tree, the replay has to be given
what the original agent had: the working session it was in, up to and including
the request the explanation answered.

That session is in WikiTom's archive, under
`sessions/YYYY/MM/DD/claude-<session id>/`, and `provenance.session` on each item
names it and the line Tom's reaction sits on.
`worker/jobs/evals-replay.mjs` reads it at run time out of the WikiTom tree the
run pins. It is not copied into the item: WikiTom keeps those transcripts out of
its own default clone, and this repository is public. The eight area trigger
files under `evals/triggers/` are held the same way and for the same reason.

## `unreplayable`

Fifteen of the twenty-seven carry an `unreplayable` line naming one sentence of
why no prompt can hold what that agent had. The runner reads that line, leaves
the item out of the run before any model call, and counts it on the evals-run row
as `unreplayable` — it is not a pass, not a failure and not a skip, because it is
a measurement nobody can make.

There are three reasons, and each is a fact about the archive rather than about
the item:

| why | count | items |
| --- | --- | --- |
| the agent called a tool after Tom's request, so the explanation rests on something it read that the replay cannot be handed — this job has no tools | 11 | n1, n5, n7, n8, n9, n13, n14, n15, p6, p9, p12 |
| the session before the request is larger than one prompt carries — 978,532 and 1,086,388 characters against a 500,000 bound | 2 | p1, p4 |
| the session is not in the archive: both post-date the last laptop archive of 2026-09-05 | 2 | n6, n11 |

The first reason is checked before the second, so an item that is both — n5, n7,
n13 and n15 each run past a million characters as well — is marked by the tool
calls, which is the reason that would still hold if the bound were raised.

The mark is derived, never typed. `scripts/triage-explanation-golden.mjs` reads
the archive through `evals-replay.mjs` and writes the line, so re-running it is
what repairs an item when the archive grows — n6 and n11 become replayable the
day the next laptop archive lands, and that command is the whole of the repair.

Nothing is deleted. An unreplayable item still records a real thing Tom ruled on,
and the reason it cannot be run today may stop being true.
