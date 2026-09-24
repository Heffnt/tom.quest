// env-scrub.mjs — the ONE list of the daemon's own secrets, and the env a
// model-reachable process is handed with them removed.
//
// Under systemd every key in /etc/tts/worker.env arrives in this daemon's
// process.env, so any child that inherits the env unfiltered can print them
// with one `env`: SESSIONS_WORKER_KEY authorizes transcript ingest (a
// confused session could rewrite ANY transcript), GH_TOKEN is repo write for
// the whole account, the two TOMQUEST_AGENT_* names are the tom.quest sign-in
// (the password must never be printable into a transcript that lives
// forever), TURING_API_KEY authorizes arbitrary commands on the WPI cluster
// (it SHOULD never be in worker.env — on 2026-08-30 a stale copy was — and
// staleness is not a control), and CODEX_API_KEY / OPENAI_API_KEY never
// belong in a session shell (Codex is logged in once via device auth in
// CODEX_HOME). Three spawns used to carry this list by hand — a session's
// shell, the Codex warm-up/usage reads, the Bash classifier — and a name
// added to one was missing from the others. Now each calls scrubbedEnv().
//
// What is deliberately NOT scrubbed: TURING_READ_KEY, the cluster API's
// read-only credential that `tts-turing` reads straight from the session's
// env (three GETs, no write verb). If a write verb is ever added under the
// read key, this inheritance is what makes it a session capability — that
// widening is a decision, not a refactor.
//
// TURING_RUNNER_KEY, the cluster API's launch-and-cancel credential for runner
// steps, IS scrubbed, exactly like the full key: no session, no Codex run, no
// classifier gets it. One caller puts it back: box-run.mjs, for the process of
// a runner step and nothing else (keyed on that run's registration). That is
// where acting on the cluster lives; tts-turing itself keeps no write verb.
//
// TTS_WORKER_KEY is the one key that MAY enter a session shell (its write
// surface — capture, prep, briefs, session-outcome — is the same one
// the cron jobs' agentic runs already expose to a model); `keepTtsKey: true`
// leaves it in, every other caller drops it too.
//
// Values Tom pastes on tom.quest/secrets are NOT on this list, and need not
// be: the daemon writes each into a marked block in the env file and removes
// every name in that block from its own process.env at start
// (secret-mailbox.mjs dropNames), so none is in the env this function copies.
// A pasted name the file already held (a rotated GH_TOKEN) keeps its line
// and so keeps whatever this list does with it.
//
// Its own dependency-free file for the same reason banned-tools.mjs is one:
// lib.mjs (which re-exports this) imports the worker-env symlink, which is a
// plain text file on a Windows checkout, so the repo's vitest cannot load
// lib.mjs — and the scrub list is exactly the kind of thing a test must fence
// (__tests__/env-scrub.test.mjs).

export const SCRUBBED_SECRET_NAMES = Object.freeze([
  "SESSIONS_WORKER_KEY",
  "GH_TOKEN",
  "TOMQUEST_AGENT_USERNAME",
  "TOMQUEST_AGENT_PASSWORD",
  "TURING_API_KEY",
  "TURING_RUNNER_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  // Spends money on every call. scripts/codex-run.mjs reads it from the env
  // file for an openrouter/ run and hands it to that Codex process alone.
  "OPENROUTER_API_KEY",
  // Admin over the production Convex deployment: it runs any function,
  // internal ones included, and pushes code. tts-convex reads it from the env
  // file and hands it to one `convex` process. On this list although a value
  // pasted on tom.quest/secrets lands in the mailbox block: a box built fresh
  // from worker.env.example holds a CONVEX_DEPLOY_KEY= line outside the block,
  // the pasted value then replaces that line, and systemd loads it into the
  // daemon's environment, where only this list removes it.
  "CONVEX_DEPLOY_KEY",
]);

// A copy of `source` (process.env by default) without the secrets above.
export function scrubbedEnv({ keepTtsKey = false, source = process.env } = {}) {
  const out = { ...source };
  for (const name of SCRUBBED_SECRET_NAMES) delete out[name];
  if (!keepTtsKey) delete out.TTS_WORKER_KEY;
  return out;
}
