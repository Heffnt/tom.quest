# Using Codex as a subagent

Codex is OpenAI's terminal coding agent. In this repo it is a second model
family you can hand work to. It reads this repo's `AGENTS.md` on its own, so
it arrives knowing the rules. This file says how to reach it from each place
an agent works.

## From a Claude Code session on the laptop or on the Jarvis Box

Three doors, all the same mechanism underneath:

1. **The `codex` subagent.** Call the Agent tool with `subagent_type: "codex"`
   and give it the task as the prompt. It runs Codex once and relays the
   answer unchanged. Use it for a second opinion, an adversarial review, or a
   piece of implementation you want done by a different model.
2. **The `/codex` skill.** `/codex` with no argument asks Codex to review the
   uncommitted diff and end with `VERDICT: APPROVED` or `VERDICT: REVISE`.
   `/codex <question>` forwards the question. The skill shows Codex's answer
   verbatim and then Claude's own agreement or disagreement.
3. **Workflow scripts.** `agent(prompt, { agentType: 'codex' })`. Composes with
   `parallel` and `pipeline` like any other agent, and with `schema` if you
   want JSON back.

Defaults: model `gpt-5.6-sol`, effort `xhigh`, Codex may edit files in the
workspace and reach the network. Name a flag in the prompt to change that:

- `--sandbox read-only` when nothing may change (every review path uses it).
- `--model gpt-5.6-terra` for a cheap mechanical question.
- `--effort medium` when speed matters more than depth. The wrapper kills a
  run after eight minutes; a long question at `xhigh` can hit that.

Under the hood every door runs `node scripts/codex-run.mjs` in a tom.quest
checkout, or `tts-codex` anywhere on the Jarvis Box. Both take the prompt on
stdin and print only Codex's final answer. Nothing else Codex prints reaches
the calling session.

## From a tom.quest session

A session's **model** decides which agent runs it. `opus`, `sonnet` and
`fable` run Claude Code. `gpt-5.6-sol` and `gpt-5.6-terra` run Codex. Pick it
on the create form or change it from the select in the session header. A
change within one family takes effect on the next turn. A change across
families opens a new session on the other agent, seeded with the whole
transcript; the old session ends.

Autonomous sessions use the todo's `model` tag if the planner set one, else
the fleet default shown in the fleet strip. When Codex's weekly usage reaches
90 percent, untagged work falls back to `opus` and Codex-tagged work waits.

## Inside a Codex session

Codex has its own subagents. The delegation rule in `AGENTS.md` applies: the
parent keeps judgment, design and review, and hands reading, searching,
mechanical edits and test runs to children. Spawn them with `spawn_agent`,
agent type `explorer` for read-only work or `worker` for changes, and ask for
`gpt-5.6-terra` by name. A child that is not given a model inherits the
parent's, which is the expensive one.

Two things to know:

- The transcript in tom.quest shows that a child was spawned and what it
  returned, not its inner steps. Codex's headless stream does not expose
  them. Each child's full record is a file on the Jarvis Box under
  `/root/.codex/sessions/`.
- Children draw on the same ChatGPT usage windows as the parent. The saving
  is per-token price, not a separate allowance. Four children run at once per
  session.

## Never do this in any session

Do not restart, stop or kill `tts-session-host`. It is the daemon running
your session and every other live session on the box. If a change needs a
restart, say so in the outcome and the supervisor restarts it.
