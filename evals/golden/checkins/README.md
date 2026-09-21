# evals/golden/checkins

Eight golden items for the runner check-in judge (`worker/jobs/runner-checkin.mjs`),
scored by the `checkin` job in `worker/jobs/evals.mjs`. Each holds one fixed
check-in and the verdict the judge must reach on it: five it must pass (plain
numbers with what they count; a ruling requested under the one allowed heading;
a check-in written to the step prompt's check-in contract, its numbers in a
table; a check-in that names one launch and one cancel on the cluster, each
with how it was seen to take effect; a check-in that asks Tom to raise the
runner's ceiling and gives him the reply form, as the contract has asked since
his ruling of 2026-09-21) and three it must fail (coined names and an unexplained abbreviation; a
check-in that grades itself and states no fact; the contract check-in with one
undefined tier name added, the fault the first proof run's check-ins carried).

Every item passes the form rules in `scripts/checkin-rules.mjs`, so what is
scored is the judge's reading and nothing a script decides.

None is confirmed by Tom (`confirmedByTom: false`), so each is run and reported
and never fails a pull request until he has been through them.
