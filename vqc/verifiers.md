# vqc/verifiers.md — the three verifiers

There are three verifiers in this repository. They are the merge gate's three
head rows, and nothing else is one.

**checks** are every deterministic check: a program answering by string, count,
schema or regex. Cheap, exact, narrow.

**the audit** is a model of another family reading a change before it merges —
Codex, and Claude Opus at the Codex weekly cap, where the row says so
(`fallback: codex-cap`).

**the evals** are a model reading outputs against Tom's labels: the golden set,
several trials, the ablation arm, efficiency, golden coverage.

| | checks | the audit | the evals |
|---|---|---|---|
| verifies | anything answerable by string, count, schema or regex | a change, before it merges | an output, against Tom's labels |
| cost | seconds of CI; no model | one Codex run per head (Opus at the cap) | one eval run per watched change; the judge model |
| known failure mode | a producer edits the check instead of the code | it approves what it did not read; it drifts soft | the judge disagrees with Tom; a flaky item |
| rows | the `tests-run` head row, or the write it refused | the `audit-verdict` head row, with `chunks` and `traceFindings` | the `evals-run` head row, golden coverage inside it |

The rule is one sentence: a new deterministic check is a test, a new judgment of
a change is part of the audit's prompt, and a new judgment of an output is a
case in the evals. There is no fourth row, and there is no register of
verifiers — a register would be a cross-cutting dimension every future change
had to satisfy, which is the wicked feature Tom's 2026-09-11 ruling refuses.

Above all three sits Tom's label — his ruling, his objection, his session reply,
his digest reaction (`convex/runLabels.ts`, `LABEL_SOURCE`). It is the ground
truth the three are scored against, and the only thing here that is not itself
verified.

A deterministic check either runs in CI and reports through `tests-run` or it
fails the write it guards, and as of this round the guardrail scripts and the
secret scan reach that row too. The audit reads the whole diff in chunks, its
row says how many it read, and its own claims are checked against the run record
as findings on that row. The three verifier measures — the evals judge replayed
against Tom's labels, the audit against his later objections, three
planted-fault audits monthly — report and never gate, because a judge that gated
on its own unmeasured agreement is the failure the audit declines to lint for.

The session daemon's Bash classifier is not a verifier: it rules whether a
command may run, which is a permission gate on an action before the fact rather
than an answer about an output after it.

This page lives in `vqc/` rather than `docs/` because VQC is where this
repository already keeps what binds it, and a second documentation home for the
same kind of fact is duplication.
