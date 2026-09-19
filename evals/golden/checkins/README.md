# evals/golden/checkins

Four golden items for the runner check-in judge (`worker/jobs/runner-checkin.mjs`),
scored by the `checkin` job in `worker/jobs/evals.mjs`. Each holds one fixed
check-in and the verdict the judge must reach on it: two it must pass (plain
numbers with what they count; a ruling requested under the one allowed heading)
and two it must fail (coined names and an unexplained abbreviation; a check-in
that grades itself and states no fact).

Every item passes the form rules in `scripts/checkin-rules.mjs`, so what is
scored is the judge's reading and nothing a script decides.

None is confirmed by Tom (`confirmedByTom: false`), so each is run and reported
and never fails a pull request until he has been through them.
