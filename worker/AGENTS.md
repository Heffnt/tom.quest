# worker

## box

- The Jarvis Box is the always-on server that runs the jobs in `worker/jobs/` and the session daemon in `worker/session-host/`.
- `worker/README.md` says what each job does, how `worker/setup.sh` rolls out new code idempotently, and where the box's secrets live. Connection details and secrets are not in this repository, which is public.
- A one-time credential helper writes a minted value to an owner-only file through `worker/jobs/credential-file.mjs` and prints only the file's path and the variable names, because a session stores its own standard output.
- A change that needs `tts-session-host` restarted says so in the outcome; the supervisor restarts it.

## sessions

- A session's `model` selects its runner: `opus`, `sonnet` and `fable` run Claude Code; `gpt-5.6-sol` and `gpt-5.6-terra` run Codex. It is set on the create form or the select in the session header.
- A model change within one family takes effect on the next turn. A change across families ends the session and opens a new one on the other runner, seeded with the whole transcript.
- An autonomous session takes the todo's `model` tag if the planner set one, else the fleet default in the fleet strip. At `CODEX_WEEKLY_CAP_PERCENT` of weekly Codex usage, untagged work falls to `opus` and Codex-tagged work waits.

## codex

- `tts-codex` on the box's PATH is `scripts/codex-run.mjs` installed: the same flags, the same stdin, the same defaults. Every Codex door on the box runs it.
- A Codex session spawns a child with `spawn_agent`: type `explorer` reads and searches, type `worker` changes and runs. Four children run at once per session.
- The tom.quest transcript shows that a child was spawned and what it returned, not its inner steps; the child's full record is a file under `/root/.codex/sessions/`.
- Children draw on the parent's ChatGPT usage windows; the saving is per-token price, not a separate allowance.
