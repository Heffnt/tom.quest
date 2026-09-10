---
name: codex
description: Get a second opinion from OpenAI Codex CLI. With no argument it reviews the uncommitted changes in the working tree; with an argument it forwards that question to Codex. Use when the user says "ask codex", "codex review", "second opinion", or wants a different model family to check work.
argument-hint: "[question, or blank to review the current diff]"
---

The one prose home for reaching Codex from a laptop Claude session. Three doors, one program: the `codex` subagent, this skill, and `agent(prompt, { agentType: "codex" })` in a Workflow all run `node scripts/codex-run.mjs`. Codex loads AGENTS.md itself, defaults to `gpt-5.6-sol` at `xhigh`, may edit the workspace and reach the network, and returns only its final answer.

## prompt

- Empty `$ARGUMENTS`: a diff review. The prompt is:

  > Review the uncommitted changes in this repository. Run `git status --short` and `git diff HEAD`, and read any untracked files that appear. Report concrete problems only: bugs, behaviour changes the diff does not intend, missing tests for changed behaviour, and violations of the rules in AGENTS.md. For each, give file and line, what is wrong, and the fix. Do not praise, do not restate what the diff does. End with one line: `VERDICT: APPROVED` if you found nothing that must change, otherwise `VERDICT: REVISE`.

  Tell the subagent to pass `--sandbox read-only`: a review that edits has changed the thing it judges.
- Otherwise: `$ARGUMENTS` verbatim plus one line saying Codex may read the repository. Codex may edit on this path; say `--sandbox read-only` when the question must change nothing.

## run

- Launch the `codex` subagent (Agent tool, `subagent_type: "codex"`) with the prompt as its task and wait; a long run is a working run.
- In a Workflow, `agent(prompt, { agentType: "codex" })` composes with `parallel`, `pipeline` and `schema`.

## answer

- **Codex says:** the answer verbatim in a fenced block, never as your own view.
- **Assessment:** two to five sentences; for each concrete claim, whether you agree and why, after checking the code where cheap. State disagreements plainly.
- A failed run: one line with the exit code. Never substitute your own review.

## flags

- read-only: `--sandbox read-only`; the review path always passes it.
- cheap: `--model gpt-5.6-terra`, for a mechanical lookup.
- lower effort: `--effort medium` or lower; `xhigh` is slow, and nothing cuts a run off unless `--timeout <ms>` is named.
