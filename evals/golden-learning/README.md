# evals/golden-learning

Two golden items for the nightly learning step (`worker/jobs/nightly.mjs`), in
the format the evals runner reads: `{id, job, partition, verdict, sentence,
input, expect}`.

- `learning-ground-said-knows.json` — `learning/ground`. A term he confirmed in
  his own words moves to Knows, with his sentence in the evidence record and
  nothing of it on the page.
- `learning-refusal-no-evidence.json` — `learning/refusal`. A line the input
  does not evidence is refused whole, and neither record is touched.

They are the two because they are the two things the job must get right: one
thing it must do, and one thing it must refuse. Both are scored by a
DETERMINISTIC comparison of `applied` and `refused` against `expect` — no judge
is needed, which is why these two and not a wider set.

Each item carries its own `input.answer`, so `worker/jobs/learning-golden.test.mjs`
scores it under vitest with no model in the loop: what is scored there is the
job's decision about that answer, which is what a change to the CODE can break.
The evals runner instead regenerates the answer with the current prompt at two
shas and compares the same two lists, which is what a change to the PROMPT can
break.

The runner's own tree (`uac/evals`) files goldens under
`evals/golden/<partition>/`. These sit here because the learning brief names
this directory; at integration they move to `evals/golden/learning/` and
nothing else changes — the items themselves carry their partition.
