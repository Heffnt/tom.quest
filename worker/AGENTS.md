# Worker

## Jarvis Box

- **The Jarvis Box** — the always-on server that runs this repo's `worker/` jobs and the TTS session daemon — has its own operating notes in `worker/README.md`: what each job does, how `worker/setup.sh` rolls out new code idempotently, and where its secrets live. Connection details are deliberately not in this repository, which is public.
- There is no exemption for one-time credential helpers: they write minted values to an owner-only file (`worker/jobs/credential-file.mjs`) and print only that file's path and the variable names, because an agent session stores its own standard output.
- Claude on the box can call the `codex` subagent, use `/codex`, or use `agent(prompt, { agentType: "codex" })` in a Workflow; each route invokes `tts-codex`.
- With no argument, `/codex` requests an uncommitted-diff review ending in `VERDICT: APPROVED` or `VERDICT: REVISE`; with an argument, it forwards that question.
- Codex defaults to `gpt-5.6-sol` at `xhigh` and may edit the workspace and use the network; request `--sandbox read-only` for reviews, `--model gpt-5.6-terra` for cheap work, or `--effort medium` when speed wins.
- Runs have no time limit unless `--timeout <ms>` is supplied, which ends them with exit 124; a long run is working rather than stuck.
- The subagent runs `tts-codex` in the background and reads its output file when finished, because foreground Bash cannot outlast ten minutes; callers receive only Codex's final answer.

## tom.quest Sessions

- A session's **model** decides which agent runs it. `opus`, `sonnet` and `fable` run Claude Code. `gpt-5.6-sol` and `gpt-5.6-terra` run Codex. Pick it on the create form or change it from the select in the session header. A change within one family takes effect on the next turn. A change across families opens a new session on the other agent, seeded with the whole transcript; the old session ends.
- Autonomous sessions use the todo's `model` tag if the planner set one, else the fleet default shown in the fleet strip. When Codex's weekly usage reaches 90 percent, untagged work falls back to `opus` and Codex-tagged work waits.
- Codex child transcripts show that a child was spawned and what it returned, not its inner steps. Codex's headless stream does not expose them. Each child's full record is a file on the Jarvis Box under `/root/.codex/sessions/`.
- Codex children draw on the same ChatGPT usage windows as the parent. The saving is per-token price, not a separate allowance. Four children run at once per session.
- Do not restart, stop or kill `tts-session-host`. It is the daemon running your session and every other live session on the box. If a change needs a restart, say so in the outcome and the supervisor restarts it.
