// THE ONE HOME for the session constants that the Convex record, the site and
// the Jarvis Box all read. Each of these used to be typed out on both sides:
// the record in convex/ttsShared.ts, the box's daemon in
// worker/session-host/session.mjs and its launcher in worker/agents/launcher.mjs,
// because the box's plain Node loads no TypeScript. A check held the copies
// equal. They are one table now, imported by all three.
//
// Plain ESM with no imports, as every module in shared/ is. The tables carry a
// JSDoc `@type {const}` cast: TypeScript reads it as `as const`, so
// convex/ttsShared.ts keeps each table's literal types (SessionModel,
// ModelFamily, a narrow-list id) without restating a literal.

/**
 * Tom's narrow list: his boundary for an unattended delegate. `decision` is
 * served to the box and rendered in the delegate prompt; `command` is what the
 * autonomous shell classifier in session.mjs judges a command against. A merge
 * is deliberately absent: until its mechanical gate exists it remains blocked
 * by the classifier, and once it exists it is reported for objection instead.
 */
export const NARROW_LIST = /** @type {const} */ ([
  {
    id: "money",
    decision: "spend money, commit to a payment, or enter a payment method anywhere",
    command: "spend money — a purchase, a subscription, a payment, or entering a payment method",
  },
  {
    id: "message-in-his-name",
    decision: "send a message to another human being in Tom's name — mail, chat, a form, a comment on someone else's work",
    command: "send a message to another human in Tom's name (mail, a Slack post outside the system's own channels, a form submission, a comment on someone else's issue or pull request)",
  },
  {
    id: "irreversible-deletion",
    decision: "delete data irreversibly outside git — anything a checkout, a snapshot or a branch cannot bring back",
    command: "delete data that git cannot restore — anything outside the working directory, and any history rewrite that is pushed",
  },
  // Tom, 2026-09-25: "idk why agents should never move credentials." The
  // line is where a credential can be held, not whether it moves: moving one
  // between files or processes is allowed; putting it where a transcript, the
  // record or a repo can hold it is not.
  {
    id: "credential",
    decision: "put a credential where a transcript, the record or a repo can hold it (print it, send it, commit it), or create, rotate or revoke one",
    command: "put a credential, key, token or password where a transcript, the record or a repo can hold it: print it, echo it into output, send it in a message, or commit it (moving it between files or processes without printing it is allowed)",
  },
]);

/**
 * The repos a session may check out, with their GitHub homes. The browser's
 * repo picker is Object.keys(SESSION_REPOS) + NO_REPO; the daemon and the
 * launcher clone SESSION_REPOS[repo].
 */
export const SESSION_REPOS = /** @type {const} */ ({
  "tom.quest": "Heffnt/tom.quest",
  ComplexMultiTrigger: "Heffnt/ComplexMultiTrigger",
  WikiTom: "Heffnt/WikiTom",
  Jarvis: "Heffnt/Jarvis",
});

/**
 * The label on the last line of every turn Tom typed, as the model receives
 * it: his text, a blank line, then `inbound row: <claudeInbound id>`. The
 * daemon appends it (worker/session-host/session.mjs deliveredTurnText), the
 * ruling pen's prompt names it (app/lib/tts-session-prompt.ts), and the record
 * reads it back off the agent file's user row to know which of Tom's turns
 * that row is (convex/sessionRows.ts inboundRowIdOf).
 */
export const INBOUND_ROW_LABEL = "inbound row:";

/** The sentinel repo value meaning "no checkout, an empty scratch workspace".
 * Written into claudeSessions.repo when a session holds no repos at all. */
export const NO_REPO = "none";

/**
 * Which model a session runs on (ratified by Tom, 2026-09-04). A model name
 * implies its FAMILY, and the family picks the runner on the box: "claude"
 * runs through the Agent SDK, "codex" through OpenAI's Codex CLI
 * (worker/session-host/codex-query.mjs). `id` is what the runner passes on the
 * command line; null means the account default. `effort` is Codex's
 * model_reasoning_effort, sent on every turn.
 */
export const SESSION_MODELS = /** @type {const} */ ({
  opus: { family: "claude", id: null, effort: null },
  sonnet: { family: "claude", id: "claude-sonnet-5", effort: null },
  fable: { family: "claude", id: "claude-fable-5-1", effort: null },
  "gpt-5.6-sol": { family: "codex", id: "gpt-5.6-sol", effort: "xhigh" },
  "gpt-5.6-terra": { family: "codex", id: "gpt-5.6-terra", effort: "medium" },
  // OpenAI's Astra, the orchestrator's first choice (Tom, 2026-09-21). Listed
  // by the box's Codex CLI as `gpt-6-astra`; convex/orchestrator.ts takes it
  // only when the daemon's heartbeat says the CLI lists it.
  "gpt-6-astra": { family: "codex", id: "gpt-6-astra", effort: "xhigh" },
});

/** A row written before models existed (model absent) ran Claude on the
 * account default, so absent reads as this. The daemon also runs a model name
 * it does not know as this. */
export const LEGACY_SESSION_MODEL = "opus";

/** The daemon's heartbeat cadence while nothing is live. */
export const POLL_IDLE_MS = 30_000;

/** How long without a heartbeat before the record calls the daemon down:
 * three missed idle polls. */
export const DAEMON_STALE_MS = 3 * POLL_IDLE_MS;

/**
 * An account usage cap, in the words the CLIs use. The daemon records the
 * latest on its heartbeat (session.mjs) and the auto-scheduler's circuit
 * breaker stands a family down on it (convex/claudeSessions.ts). Deliberately
 * NARROW: "overloaded" (a transient API 529) and a plain 429 "rate limit" are
 * not usage caps and resolve by themselves. "session limit" is here from
 * observation: on 2026-08-30 the CLI's text was "You've hit your session limit
 * · resets 8:10am (UTC)", which matched neither earlier alternative, and the
 * scheduler burned a dozen launches against a wall for an hour. The Codex
 * alternatives (usage_limit_reached / usage_limit_exceeded /
 * rate_limit_reached, and the prose "hit your usage limit") are the Codex
 * CLI's own cap vocabulary, added 2026-09-04.
 */
export const USAGE_LIMIT_RE = /usage.?limit|limit reached|session limit|usage_limit_(reached|exceeded)|rate_limit_reached|hit your usage limit/i;

/** The last line of the orchestrator's final message when it asks to be
 * restarted from its document. The daemon (worker/session-host/hosted.mjs in
 * the Jarvis repository) reads it off the run; the record
 * (convex/orchestrator.ts) restarts the run on it. */
export const ORCHESTRATOR_COMPACT_WORD = "JARVIS-COMPACT";

/** The endedReason a compaction ends with. The record reads it to tell a
 * compaction (restart now, crash count cleared) from a crash. */
export const COMPACT_ENDED_REASON = "orchestrator compacted";

/** The endedReason a restarted daemon ends a live unattended run with. The
 * record restarts the orchestrator at once on it and does not count it as a
 * crash. */
export const DAEMON_RESTART_ENDED_REASON = "daemon restarted mid-mission";

/** What one runner launch may ask for when its row holds no ceiling: the fixed
 * ceiling every runner had before Tom ruled on 2026-09-21 that a ruling of his
 * may raise it. The record (convex/ttsShared.ts) stores and serves it, and the
 * box's sensor falls back to it when its cache holds none. */
export const RUNNER_CEILING_DEFAULT = { gpus: 2, minutes: 240, memoryMb: 128000 };
