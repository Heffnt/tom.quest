# worker

## box

- The Jarvis Box is the always-on server that runs the jobs in `worker/jobs/` and the session daemon in `worker/session-host/`.
- `worker/README.md` says what each job does, how `worker/setup.sh` rolls out new code idempotently, and where the box's secrets live. Connection details and secrets are not in this repository, which is public.
- A one-time credential helper writes a minted value to an owner-only file through `worker/jobs/credential-file.mjs` and prints only the file's path and the variable names, because a session stores its own standard output.
- A change that needs `tts-session-host` restarted says so in the outcome; the supervisor restarts it.
- `tts-convex run <function> [<json args>]` runs a Convex function against production with `CONVEX_DEPLOY_KEY` from the env file, in `/root/tom.quest`, and records it in `/var/log/tts/convex.log`; any other `convex` subcommand passes through the same way (`worker/README.md`).
- Each account slot's `settings.json`, which `worker/setup.sh` writes, turns off auto-memory, bundled skills, the Workflow tool and claude.ai connectors, and denies WebSearch, WebFetch and every `mcp__` tool; context comes from Jarvis (`worker/README.md`).

## sessions

- A session's `model` selects its runner: `opus`, `sonnet` and `fable` run Claude Code; `gpt-5.6-sol` and `gpt-5.6-terra` run Codex. It is set on the create form or the select in the session header.
- A model change within one family takes effect on the next turn. A change across families ends the session and opens a new one on the other runner, seeded with the whole transcript.
- A worker takes the todo's `model` tag if the planner set one, else the fleet default in the fleet strip. At `CODEX_WEEKLY_CAP_PERCENT` of weekly Codex usage, untagged work falls to `opus` and Codex-tagged work waits.
- Every job's model is `MODELS` in `worker/runs/models.mjs`. A Claude run asked for Fable runs Opus while that file's Fable availability state says Fable is unavailable: a run refused for a spend or usage limit sets it, and the daemon's hourly Fable probe clears it.

## codex

- `tts-codex` on the box's PATH is `scripts/codex-run.mjs` installed: the same flags, the same stdin, the same defaults. Every Codex door on the box runs it.
- `tts-run` sits beside it on the box's PATH: it is `worker/runs/box-run.mjs` installed, it is the one line the laptop's `scripts/box-agent.mjs` sends over ssh, and it is how every spawn from a laptop session actually runs.
- `box-run.mjs` is the box's one launcher. The cron jobs and the delegate call its `boxRunSync` in process through `runClaude` in `worker/jobs/tts-lib.mjs`; no job builds a `claude` command line. The session daemon's Agent SDK path is the one exception.
- Only the command line's runs take a semaphore slot. A job's call takes none: its flock is its guard, and a slot there let the evals pass starve behind the runs waiting on it.
- A Codex session spawns a child with `spawn_agent`: type `explorer` reads and searches, type `worker` changes and runs. Four children run at once per session.
- The tom.quest transcript shows that a child was spawned and what it returned, not its inner steps; the child's full record is a file under `/root/.codex/sessions/`.
- Children draw on the parent's ChatGPT usage windows; the saving is per-token price, not a separate allowance.
- A model spelled `openrouter/<vendor>/<model>` runs Codex on OpenRouter instead of the ChatGPT login: `scripts/codex-run.mjs` selects the `openrouter` model provider, which `worker/setup.sh` writes into `/root/.codex/config.toml` while `OPENROUTER_API_KEY` is set in `/etc/tts/worker.env`, and hands that key to the Codex process alone. `tts-run` takes it with `--cli codex`. The key's own limit on openrouter.ai caps the spend; the run record holds the tokens and the model, and no cost.

## Remote Control (not built)

- `claude --remote-control` starts a session on the machine it is run on and lets Tom chat with it from claude.ai or the phone app. The tools run where it was started: there is no option to run one session's tools on another machine over ssh, and the Agent tool's `isolation: "remote"` runs in Anthropic's cloud sandbox, not on his server.
- Using it on the box would need: (1) a tmux session per concurrent conversation, held under an account slot — `CLAUDE_CONFIG_DIR=/root/.claude-accounts/active tmux new -d -s rc 'claude --remote-control'` — started by hand or by a job; (2) a decision of which surface is the chat window, since the desktop app or the phone becomes it and the laptop's desktop app plays no part; (3) two known costs — the run sits outside the session daemon, so the "sessions" view of `tom.quest/runs` does not list it, though its run file still lands in `/root/.claude-accounts/<slot>/projects`, the box sweep still records it, and the page's "all roots" view lists it, and file-sending and artifact support on the web surface are unverified; (4) nothing this phase built blocks it — `tts-run`, the semaphore and the record changes are all independent of it.
- Do not start one, and do not add a job that starts one.

## Desktop sessions

- A desktop session is Tom's laptop Claude app, Code tab, connected to the box over ssh. The app runs its own CLI copy under `/root/.claude/remote`, outside the session daemon, `tts-run` and the semaphore.
- The account slot reaches it through the first line of `/root/.bashrc`, above its non-interactive guard, `export CLAUDE_CONFIG_DIR=/root/.claude-accounts/active RUN_HOST=box`, which `worker/setup.sh` installs; the app has no setting of its own for this. `RUN_HOST=box` keeps its hooks on their box branches.
- The run hook records it as a session with Tom: environment `session`, origin `desktop`, because a box Claude session with no launcher token was started by him.
- Its standing workspace is `/var/cache/tts/desktop/`, one checkout per session repo, never reset; the session pulls and branches itself.
- The app's server keeps the environment it started with: one started before the slot line existed writes to `/root/.claude/projects`, outside the sweep, until the app reconnects. Check the CLI's `/proc/<pid>/environ`; the Bash tool's shell sources `/root/.bashrc` itself.
- The auto-mode classifier refuses edits that persist on the box and process control, even after Tom authorizes them in words, and a verbatim retry is refused the same way: try once in plain form, then give him the one-line command to run.
- No job starts one, and none may.
