---
name: codex
description: Get a second opinion from OpenAI Codex CLI. With no argument it reviews the uncommitted changes in the working tree; with an argument it forwards that question to Codex. Use when the user says "ask codex", "codex review", "second opinion", or wants a different model family to check work.
argument-hint: "[question, or blank to review the current diff]"
---

Codex is OpenAI's terminal coding agent. It runs in this repo with the repo's AGENTS.md already loaded, on the fleet default model (`gpt-5.6-sol`) at the highest reasoning effort. The `codex` subagent (`.claude/agents/codex.md`) carries the prompt to it through `scripts/codex-run.mjs` — or `tts-codex`, the same program on the Jarvis Box's PATH — and brings the answer back unchanged, so the several hundred kilobytes of Codex progress output never enter this session.

## Steps

1. Build the prompt.
   - If `$ARGUMENTS` is empty: the prompt is

     > Review the uncommitted changes in this repository. Run `git status --short` and `git diff HEAD`, and read any untracked files that appear. Report concrete problems only: bugs, behaviour changes the diff does not intend, missing tests for changed behaviour, and violations of the rules in AGENTS.md. For each, give file and line, what is wrong, and the fix. Do not praise, do not restate what the diff does. End with one line: `VERDICT: APPROVED` if you found nothing that must change, otherwise `VERDICT: REVISE`.

     Tell the subagent to pass `--sandbox read-only`. A review must not edit: the working tree is the evidence, and a reviewer that "fixes" the diff while reading it has changed the thing being judged and left nothing to compare against.

   - Otherwise: the prompt is `$ARGUMENTS` verbatim, followed by a line telling Codex it may read the repository to answer. Codex may edit files on this path (that is the default) — say `--sandbox read-only` in the request if the question must not change anything.

2. Launch the `codex` subagent with the Agent tool, `subagent_type: "codex"`, passing the prompt as the agent's task. Wait for it. Expect one to eight minutes.

3. Present the result as two parts:
   - **Codex says:** Codex's answer, verbatim, in a fenced block. Never present it as your own view.
   - **Assessment:** Two to five sentences. For each concrete claim Codex made, say whether you agree, and why, after checking the code yourself where that is cheap. Disagreements are the point of asking; state them plainly.

4. If the subagent reports a failure or timeout, say so in one line with the exit code. Do not substitute your own review for Codex's.

## Options the user can name

- "read-only" / "don't let it edit": add `--sandbox read-only`. The diff-review path always passes it.
- "cheap" / "quick question": add `--model gpt-5.6-terra`, the cheap tier. Worth naming for a mechanical lookup or a small factual question, where the strongest model buys nothing.
- "lower effort": add `--effort medium` (or lower). The default is `xhigh`, which is slow — an eight-minute timeout is real, and a long question at `xhigh` can hit it.
