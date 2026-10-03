// jarvis-events.mjs — the shape of one row of the record's `events` table, and
// the kinds it takes. The Convex route POST /jarvis/event validates a body
// here before it writes; the Jarvis box imports the same file (package
// tom-quest-shared) so a job can refuse its own malformed event before the
// network. One home, so the two sides cannot drift on what an event is.
//
// AN EVENT IS: what happened (kind), when (at, epoch ms), who did it
// (provenance: the agent, the job, the session or the user; all optional,
// none is fine for a Convex-internal fact), what it is about (subject: a todo
// id, a `<repo>@<sha>`, a repo, a session id, or the condition a job report
// names), the facts (data, any JSON), and the one line the digest prints
// (text, optional; absent means the digest derives it or leaves it out).
//
// THE KINDS ARE A CLOSED LIST. Every area that posts an event adds its kinds
// here, in its own block, so the whole vocabulary of the record is one file a
// reader can read top to bottom. A kind the list does not hold is refused at
// the route with a 400 naming it. Rows copied from the previous generation's
// dtsEvents table (convex/jarvis/events.ts copyDtsRow) keep the kind they
// had; the list governs what is POSTED, not what was.

/** @type {const} */
export const EVENT_KINDS = [
  // Jobs on the box (convex/jarvis/jobs.ts): a clean run, a failure, and the
  // Convex-written close of a keyed failure when the job next runs clean.
  "job-ok",
  "job-failed",
  "job-recovered",
  // One browser's web push subscription; subject is its endpoint URL; data
  // { live: true, subscription } when saved by Tom on /push, { live: false, reason }
  // when the push service reports it gone (convex/push.ts).
  "push-subscription",
  // A record-tick task was queued. Its completion is the later job-ok or
  // job-failed under the same subject (convex/jarvis/tick.ts).
  "tick-started",
  // Box changes (convex/boxChanges.ts): every change to the Jarvis Box, as
  // the box-change reader (Jarvis worker/jobs/box-watch.mjs) folds it; data
  // is the fixed shape boxChanges.ts checks, `at` is when it happened on the
  // box, and provenance.agentId names the agent that ran it when the reader
  // matched one, so the /agents chat draws it on events.by_agent_at.
  "box-change",
  // Intent (convex/jarvis/intent.ts, the /intent page): the delegate's
  // decision (`jarvis decide`: question, options, decision, reason, restedOn,
  // wouldChange, refused, refusedBecause, caller, askId, model; subject is
  // the askId), and Tom's settlement of one disagreement on the page — a
  // decision he accepts or objects to, or a failing eval item he rules on
  // (data: subject, verdict, sentence, rulingId when a ruling was written).
  "decision",
  "disagreement-settled",
  // The digest and needs-you (convex/jarvis/digest.ts): the box posted the
  // day's digest to the output channel; a thing only Tom can settle was
  // opened, and the box posted it as a reply under the newest digest.
  "digest-sent",
  "needs-you-opened",
  "needs-you-posted",
  // Evals (Jarvis worker/jobs/evals.mjs; convex/ttsEvals.ts reads them): one row per eval set per run;
  // subject is the set name ("wall", "role/classify", ...), data the runner's runData() shape, text the one summary line.
  "eval-run",
  // A line a producer put on the next digest (convex/jarvis/outbox.ts
  // listForDigest): a decision taken in his name, or a failure, whose fact the
  // digest reads from no row of its own. What #tts-decisions and #tts-broken
  // carried as it happened.
  "digest-line",
  // An agent's outcome on a todo, posted by the box's work queue (Jarvis
  // worker/jobs/work-queue.mjs): subject is the todo's id, data what the
  // queue knows (outcome "completed" or "errored", summary, cost). The digest
  // and the weekly count it on its todo (convex/ttsDigest.ts, ttsWeekly.ts).
  "session-outcome",
  // The Jarvis thread (convex/thread.ts, the /thread page): a message Tom
  // typed there, Jarvis's one-line answer posted back by the box, and the
  // day's digest as a message from Jarvis on the thread. appendThreadDigest
  // in convex/jarvis/digest.ts writes it once per day; subject is the day key,
  // text is the rendered digest, and data is { day, since, windowEnd,
  // truncated, surfacedTodoIds, objectionAskIds, items }, where items is the
  // numbered needs-you list [{ n, key, text, todoId?, job? }].
  "thread-message",
  "thread-reply",
  "thread-digest",
  // One row per worker run, posted by Jarvis scripts/codex-run.mjs at the end
  // of a Codex run whose stdin was a brief and whose --cwd is inside a git
  // checkout, under the workspace-write sandbox. The actor is the agent
  // (provenance.agentId "codex:<host>:<codex session id>" when the wrapper
  // found the rollout; provenance.job is the run's origin). Subject is
  // "<repo>@<baseCommit>". Data { repo, remote, cwd, baseCommit, briefKey,
  // preStatePatchKey, resultDiffKey, bytes: { brief, preStatePatch,
  // resultDiff }, check, checkPassed, model, effort, sandbox, operate,
  // durationMs, costUsd, exitCode, harness, agentToken }; operate says whether
  // the wrapper gave Codex WikiTom's operate instructions (false under
  // --no-operate), so a replay gives the same. text is one line naming the
  // repo, model and outcome. The brief, the uncommitted state before the run
  // (preStatePatch: a binary git patch against baseCommit of staged, unstaged
  // and untracked-not-ignored changes, empty for a clean tree), and the diff
  // the worker left (resultDiff, the same form) are NOT in the row: they are
  // files in the box's agent store (Jarvis worker/agents/store.mjs), and the
  // row holds their store keys. A Convex document is limited to 1 MiB, and a
  // build run's diff or a lockfile in the pre-state can exceed that; storing
  // all three always keeps one path. Check is the command from a brief line
  // "Check: <command>" and checkPassed says whether it exited 0 after the
  // worker; both are null when none was named. The eval runner's set
  // "work-runs" (Jarvis worker/jobs/evals.mjs) reads these rows as its items.
  "work-run",
  // A part of Jarvis was turned off before its code is deleted; subject is
  // the part's name (a job such as "poll-dump", or a record part such as
  // "dump-capture"). Data { id, part, replacedBy, ruling }: part equals
  // subject, replacedBy names what does its work now, and ruling is Tom's
  // sentence that ordered it, quoted with its date. Data.id is
  // "part-disabled:<part>"; the box deploy job posts it from Jarvis
  // worker/parts-disabled.json.
  "part-disabled",
];

/** Events that record an act only Tom can take. They remain in EVENT_KINDS so
 *  Convex's Tom-only mutations can write them through the shared validator;
 *  worker-key HTTP routes refuse them before any mutation runs.
 *  push-subscription is listed so that no worker-key route can add a
 *  subscription (an endpoint receives every notification's text); Convex's
 *  own markGone still writes it. */
/** @type {const} */
export const TOM_ONLY_KINDS = ["disagreement-settled", "push-subscription", "thread-message"];

/** Events only the delegate's own record writes: a decision row is written by
 *  POST /tts/ask's mutation (convex/ttsAsk.ts internalRecordAsk), in the same
 *  transaction as the ask it answers, after the attended check and the cap.
 *  A generic worker-key route refuses them, so no decision exists in the
 *  record without the ask that passed those checks. */
/** @type {const} */
export const DELEGATE_ONLY_KINDS = ["decision"];

/** How far past the writer's clock an event's `at` may lie. The silence alarm
 *  reads a job's newest row (convex/jarvis/jobs.ts), so a row dated in the
 *  future would hold it quiet until that date; a box clock a little ahead of
 *  Convex's is all this allows. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * The kinds whose subject is their identity, refused without one: a
 * decision's askId (settle, "revert <n>" and the digest find it there), a
 * digest line's askId or job, an eval run's set, a work run's repo and commit.
 */
export const SUBJECT_REQUIRED = ["decision", "digest-line", "eval-run", "thread-reply", "work-run", "part-disabled", "thread-digest"];

/** The kinds a thread-reply's `data.kind` may name; the writer refuses anything
 * else. `answer` is written only by convex/thread.ts when Tom's reply under a
 * thread digest answered a numbered item; the box's classifier never answers it. */
export const THREAD_REPLY_KINDS = ["fact", "todo", "rule", "errand", "question", "answer"];

/**
 * The kinds whose writer retries with a stable `data.id`: a second row of the
 * kind with the same subject and data.id is that retry, not a new fact, and is
 * not recorded again (convex/jarvis/events.ts recordEvent answers the first
 * row's id with duplicate: true).
 */
export const REPEATS_BY_DATA_ID = [
  // The box-change reader's outbox is at-least-once; data.id is the change's
  // journal cursor (Jarvis worker/jobs/box-watch.mjs).
  "box-change",
  // The work queue re-posts a run's outcome until it is answered; data.id is
  // "work-queue:<todo id>:<ruling id>:<run start ms>" (Jarvis worker/jobs/work-queue.mjs).
  "session-outcome",
  // The deploy job re-posts every listed part on each deploy; data.id is
  // "part-disabled:<part>".
  "part-disabled",
];

/** The provenance fields an event may carry, and nothing else. */
export const PROVENANCE_FIELDS = ["agentId", "job", "session", "user"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * Check a body posted to POST /jarvis/event, or built by a box job before it
 * posts. Returns `{ ok: true, event }` with the row exactly as the table
 * stores it (`at` filled in with `now`, `data` defaulting to `{}`), or
 * `{ ok: false, error }` with one sentence naming the first thing wrong.
 */
export function validateEvent(body, { now = Date.now(), kinds = EVENT_KINDS } = {}) {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };
  const { kind, at, provenance, subject, data, text } = body;
  if (!nonEmptyString(kind)) return { ok: false, error: "kind (non-empty string) required" };
  if (!kinds.includes(kind)) return { ok: false, error: `kind "${kind}" is not in shared/jarvis-events.mjs EVENT_KINDS` };
  if (at !== undefined && !(typeof at === "number" && Number.isFinite(at) && at > 0)) {
    return { ok: false, error: "at, when given, is epoch milliseconds" };
  }
  if (at !== undefined && at > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: "at is more than 5 minutes in the future" };
  }
  if (provenance !== undefined && !isPlainObject(provenance)) {
    return { ok: false, error: "provenance, when given, is an object" };
  }
  const prov = {};
  for (const [field, value] of Object.entries(provenance ?? {})) {
    if (!PROVENANCE_FIELDS.includes(field)) {
      return { ok: false, error: `provenance.${field} is not one of ${PROVENANCE_FIELDS.join(", ")}` };
    }
    if (value === undefined) continue;
    if (!nonEmptyString(value)) return { ok: false, error: `provenance.${field}, when given, is a non-empty string` };
    prov[field] = value;
  }
  if (subject !== undefined && !nonEmptyString(subject)) {
    return { ok: false, error: "subject, when given, is a non-empty string" };
  }
  if (subject === undefined && SUBJECT_REQUIRED.includes(kind)) {
    return { ok: false, error: `a ${kind} event names its subject` };
  }
  if (kind === "thread-reply") {
    if (!nonEmptyString(text)) {
      return { ok: false, error: "a thread-reply names its one-line text" };
    }
    if (!isPlainObject(data) || !THREAD_REPLY_KINDS.includes(data.kind)) {
      return { ok: false, error: `a thread-reply names data.kind as one of ${THREAD_REPLY_KINDS.join(", ")}` };
    }
  }
  if (kind === "part-disabled") {
    if (!isPlainObject(data) || !nonEmptyString(data.part)) {
      return { ok: false, error: "a part-disabled event names data.part as a non-empty string" };
    }
    if (data.part !== subject) {
      return { ok: false, error: "a part-disabled event names data.part as its subject" };
    }
    if (data.id !== `part-disabled:${data.part}`) {
      return { ok: false, error: "a part-disabled event names data.id as part-disabled:<part>" };
    }
    if (!nonEmptyString(data.replacedBy)) {
      return { ok: false, error: "a part-disabled event names data.replacedBy as a non-empty string" };
    }
    if (!nonEmptyString(data.ruling)) {
      return { ok: false, error: "a part-disabled event names data.ruling as a non-empty string" };
    }
  }
  if (kind === "work-run") {
    if (!isPlainObject(data)) return { ok: false, error: "a work-run event names data as an object" };
    for (const field of ["repo", "baseCommit", "model", "briefKey", "preStatePatchKey", "resultDiffKey"]) {
      if (!nonEmptyString(data[field])) return { ok: false, error: `a work-run event names data.${field} as a non-empty string` };
    }
    if (!/^[0-9a-f]{40}$/.test(data.baseCommit)) {
      return { ok: false, error: "a work-run event names data.baseCommit as 40 lowercase hexadecimal characters" };
    }
    if (subject !== `${data.repo}@${data.baseCommit}`) {
      return { ok: false, error: "a work-run event names <repo>@<baseCommit> as its subject" };
    }
    if (data.harness !== "codex") return { ok: false, error: "a work-run event names data.harness as codex" };
    if (data.check !== null && !nonEmptyString(data.check)) {
      return { ok: false, error: "a work-run event names data.check as null or a non-empty string" };
    }
    if (data.checkPassed !== null && typeof data.checkPassed !== "boolean") {
      return { ok: false, error: "a work-run event names data.checkPassed as null or a boolean" };
    }
    if ((data.check === null) !== (data.checkPassed === null)) {
      return { ok: false, error: "a work-run event names data.check and data.checkPassed as both null or both non-null" };
    }
  }
  if (text !== undefined && typeof text !== "string") {
    return { ok: false, error: "text, when given, is a string" };
  }
  const event = {
    kind,
    at: at ?? now,
    provenance: prov,
    data: data === undefined ? {} : data,
  };
  if (subject !== undefined) event.subject = subject;
  if (text !== undefined) event.text = text;
  return { ok: true, event };
}
