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
  // A job-ok or job-failed may carry data.durationMs: how long the job's
  // process had run when it posted the row, in milliseconds (Jarvis
  // worker/jobs/clock.mjs runDurationMs), so a job's runtime is in the record.
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
  // typed there, and Jarvis's one-line answer posted back by the box.
  "thread-message",
  "thread-reply",
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
  // A session building a todo (convex/jarvis/build.ts; the box posts both
  // with Jarvis `jarvis write`). Subject the todo's id, in either form; the
  // record keeps the plain id and refuses one that names no todo.
  // A todo-state is where the todo stands in a build, and its newest row per
  // todo is the todo's build state: data { state, from, by, orderRowId?,
  // builder?, mergeRowId?, pullRequest?, sentence? }. state and from (the
  // state before) are TODO_STATES; by is the agent id of the session or the
  // orchestrator that moved it, or "tom" through his own door; orderRowId
  // (the todo's "design to build" handoff) and builder (one of BUILDERS)
  // when ordered or building; mergeRowId (the landing row) and pullRequest
  // { repo, number } when returned; sentence, Tom's sentence verbatim, when
  // done and when a return goes back to "in session". A "done" sets the
  // todo's status to done in the same mutation.
  // A handoff is what the next turn, process or session continues from:
  // data { transition, previous?, sentences, state, next, pointers, order?,
  // gate?, mergeRowId?, commit?, measures?, shownPages?, unblock? }.
  // transition is one of HANDOFF_TRANSITIONS; previous is the todo's newest
  // handoff before this one, which the record requires after the first;
  // sentences are Tom's since then, verbatim, [{ at, text }]; state is one
  // paragraph on where the work stands and next one sentence; pointers is
  // { rows, agents, files, branch, head, pullRequest } and nothing else, each
  // absent until it exists: rows event ids, agents [{ id, knows }], files
  // repository paths, branch and head strings, pullRequest { repo, number }.
  // On "design to build" order is the seven-part work order { todo, design,
  // checks, decisions, outOfScope, walls, agents } with its builder;
  // on "review to landing" gate is { testsRunRowId, auditVerdictRowId }; on
  // "landing to return" mergeRowId and commit; on "leaving" unblock, what
  // only Tom can unblock, one line each. A handoff's data is at most
  // HANDOFF_MAX_BYTES. Both kinds carry a one-line text.
  "todo-state",
  "handoff",
  // A part of Jarvis was turned off before its code is deleted; subject is
  // the part's name (a job such as "poll-dump", or a record part such as
  // "dump-capture"). Data { id, part, replacedBy, ruling }: part equals
  // subject, replacedBy names what does its work now, and ruling is Tom's
  // sentence that ordered it, quoted with its date. Data.id is
  // "part-disabled:<part>"; the box deploy job posts it from Jarvis
  // worker/parts-disabled.json.
  "part-disabled",
  // The design page (convex/jarvis/design.ts, tom.quest/design).
  //   registry: the registry of Jarvis's parts (Jarvis worker/parts.json) the
  //     box deployed. Subject "Jarvis@<sha>", the deployed commit; data
  //     { id: "registry:Jarvis@<sha>", repo: "Jarvis", sha, parts (the rows,
  //     whole, in file order), count }; text "registry of Jarvis at <7-char
  //     sha>: <count> parts". The box's deploy job posts one per deployed
  //     commit. The validator checks each row's id, type, fate and serves
  //     only: the registry check on the box is the wall for the rest.
  //   explanation: a ground-up explanation of one part, written by the
  //     session that explained it. Subject the part id; data { title, html },
  //     html one complete HTML document with no script and no src attribute;
  //     provenance.agentId or provenance.session the agent that wrote it.
  "registry",
  "explanation",
];

/** Events that record an act only Tom can take. They remain in EVENT_KINDS so
 *  Convex's Tom-only mutations can write them through the shared validator;
 *  worker-key HTTP routes refuse them before any mutation runs.
 *  push-subscription is listed so that no worker-key route can add a
 *  subscription (an endpoint receives every notification's text); Convex's
 *  own markGone still writes it. */
/** @type {const} */
export const TOM_ONLY_KINDS = ["disagreement-settled", "push-subscription", "thread-message"];

/** Events only POST /jarvis/event writes, which checks each one's shape with
 *  validateEvent. POST /tts/event copies a row into the record unchecked
 *  (convex/jarvis/events.ts copyDtsRow), so it refuses these: a registry row
 *  it stored could become the registry convex/jarvis/design.ts reads. */
/** @type {const} */
export const JARVIS_EVENT_ONLY_KINDS = ["registry", "explanation"];

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
 * digest line's askId or job, an eval run's set, a work run's repo and commit,
 * a build row's todo.
 */
export const SUBJECT_REQUIRED = ["decision", "digest-line", "eval-run", "thread-reply", "work-run", "part-disabled", "registry", "explanation", "todo-state", "handoff"];

/** A todo-state's `data.state` and `data.from`: where a todo stands in a build. */
/** @type {const} */
export const TODO_STATES = ["waiting", "in session", "ordered", "building", "returned", "done", "archived"];

/** A handoff's `data.transition`: the five transitions between a session's
 *  six phases (exploration, design, build, review, landing, return), and
 *  Tom leaving the session. */
/** @type {const} */
export const HANDOFF_TRANSITIONS = [
  "exploration to design",
  "design to build",
  "build to review",
  "review to landing",
  "landing to return",
  "leaving",
];

/** Who builds a work order: the session that wrote it, or an orchestrator it started. */
const BUILDERS = ["session", "orchestrator"];

/** A work order check's `type`: a command's exit, a judgement, or a page shown. */
const CHECK_TYPES = ["mechanical", "judged", "shown"];

/** The most a handoff's data may hold, in UTF-8 bytes of its JSON: its
 *  pointers and Tom's sentences fit in far less, and detail past this
 *  belongs in a file or a subagent the pointers name. */
const HANDOFF_MAX_BYTES = 64 * 1024;

/** The kinds a thread-reply's `data.kind` may name; the writer refuses anything else. */
export const THREAD_REPLY_KINDS = ["fact", "todo", "rule", "errand", "question"];

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
  // The deploy job re-posts the deployed registry until a post lands; data.id
  // is "registry:<subject>".
  "registry",
];

/** The kinds whose data may carry `durationMs`, the job's runtime when it
 *  posted the row; validateEvent refuses one that is not a non-negative
 *  number. */
export const JOB_KINDS_WITH_DURATION = ["job-ok", "job-failed"];

/** The provenance fields an event may carry, and nothing else. */
export const PROVENANCE_FIELDS = ["agentId", "job", "session", "user"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isPullRequest = (value) =>
  isPlainObject(value) && nonEmptyString(value.repo) && Number.isInteger(value.number) && value.number > 0;
const isList = (value, each) => Array.isArray(value) && value.every(each);

/** The first thing wrong with a todo-state's data and text, or null. */
function todoStateError(data, text) {
  if (!isPlainObject(data) || !TODO_STATES.includes(data.state)) {
    return `a todo-state names data.state as one of ${TODO_STATES.join(", ")}`;
  }
  if (!TODO_STATES.includes(data.from)) {
    return `a todo-state names data.from, the state before, as one of ${TODO_STATES.join(", ")}`;
  }
  if (!nonEmptyString(data.by)) return "a todo-state names data.by, the agent id that moved the todo";
  if (data.state === "ordered" || data.state === "building") {
    if (!nonEmptyString(data.orderRowId)) return `a todo-state ${data.state} names data.orderRowId, the handoff carrying the order`;
    if (!BUILDERS.includes(data.builder)) return `a todo-state ${data.state} names data.builder as one of ${BUILDERS.join(", ")}`;
  }
  if (data.state === "returned") {
    if (!nonEmptyString(data.mergeRowId)) return "a todo-state returned names data.mergeRowId, the landing row";
    if (!isPullRequest(data.pullRequest)) return "a todo-state returned names data.pullRequest as { repo, number }";
  }
  if ((data.state === "done" || data.from === "returned") && !nonEmptyString(data.sentence)) {
    return `a todo-state ${data.state} after a return names data.sentence, Tom's sentence verbatim`;
  }
  if (!nonEmptyString(text)) return "a todo-state names its one-line text";
  return null;
}

/** The first thing wrong with a "design to build" handoff's work order, or null. */
function workOrderError(order) {
  if (!isPlainObject(order)) return "a design to build handoff names data.order, the work order";
  if (!isList(order.todo, (t) => isPlainObject(t) && nonEmptyString(t.id) && nonEmptyString(t.statement)) || order.todo.length === 0) {
    return "a work order names order.todo as a list of { id, statement }";
  }
  if (!nonEmptyString(order.design)) return "a work order names order.design, the state the change leaves behind";
  if (!isList(order.checks, (c) => isPlainObject(c) && CHECK_TYPES.includes(c.type)) || order.checks.length === 0) {
    return `a work order names order.checks as a list, each of type ${CHECK_TYPES.join(", ")}`;
  }
  if (!isPlainObject(order.decisions) || !isList(order.decisions.sentences, nonEmptyString) || !isList(order.decisions.answered, isPlainObject)) {
    return "a work order names order.decisions as { sentences, answered }";
  }
  if (!Array.isArray(order.outOfScope)) return "a work order names order.outOfScope as a list";
  if (!Array.isArray(order.walls)) return "a work order names order.walls as a list";
  const tasks = isPlainObject(order.agents) ? order.agents.tasks : undefined;
  if (!isList(tasks, (t) => isPlainObject(t) && nonEmptyString(t.name) && nonEmptyString(t.check)) || tasks.length === 0) {
    return "a work order names order.agents.tasks as a list, each task with its name and check";
  }
  if (!BUILDERS.includes(order.builder)) return `a work order names order.builder as one of ${BUILDERS.join(", ")}`;
  return null;
}

/** What each field of a handoff's `data.pointers` holds; each is absent until it exists. */
const POINTER_FIELDS = {
  rows: ["a list of event ids", (value) => isList(value, nonEmptyString)],
  agents: [
    "a list of { id, knows }: an agent id holding detail and one line on what it knows",
    (value) => isList(value, (a) => isPlainObject(a) && nonEmptyString(a.id) && nonEmptyString(a.knows)),
  ],
  files: ["a list of repository paths", (value) => isList(value, nonEmptyString)],
  branch: ["a branch name", nonEmptyString],
  head: ["a commit", nonEmptyString],
  pullRequest: ["{ repo, number }", isPullRequest],
};

/** The first thing wrong with a handoff's `data.pointers`, or null. */
function handoffPointersError(pointers) {
  if (!isPlainObject(pointers)) return "a handoff names data.pointers as an object";
  for (const [field, value] of Object.entries(pointers)) {
    const spec = POINTER_FIELDS[field];
    if (spec === undefined) {
      return `a handoff's data.pointers holds only ${Object.keys(POINTER_FIELDS).join(", ")}; ${field} is not one`;
    }
    if (!spec[1](value)) return `a handoff names data.pointers.${field}, when it exists, as ${spec[0]}`;
  }
  return null;
}

/** The first thing wrong with a handoff's data and text, or null. */
function handoffError(data, text) {
  if (!isPlainObject(data) || !HANDOFF_TRANSITIONS.includes(data.transition)) {
    return `a handoff names data.transition as one of ${HANDOFF_TRANSITIONS.join(", ")}`;
  }
  if (data.previous !== undefined && !nonEmptyString(data.previous)) {
    return "a handoff names data.previous, when given, as the previous handoff's id";
  }
  if (!isList(data.sentences, (s) => isPlainObject(s) && Number.isFinite(s.at) && nonEmptyString(s.text))) {
    return "a handoff names data.sentences as Tom's sentences since the previous handoff, [{ at, text }]";
  }
  if (!nonEmptyString(data.state)) return "a handoff names data.state, where the work stands";
  if (!nonEmptyString(data.next)) return "a handoff names data.next, the next step";
  const pointersError = handoffPointersError(data.pointers);
  if (pointersError !== null) return pointersError;
  if (data.transition === "design to build") {
    const error = workOrderError(data.order);
    if (error !== null) return error;
  }
  if (data.transition === "review to landing") {
    const gate = data.gate;
    if (!isPlainObject(gate) || !nonEmptyString(gate.testsRunRowId) || !nonEmptyString(gate.auditVerdictRowId)) {
      return "a review to landing handoff names data.gate as { testsRunRowId, auditVerdictRowId }";
    }
  }
  if (data.transition === "landing to return" && (!nonEmptyString(data.mergeRowId) || !nonEmptyString(data.commit))) {
    return "a landing to return handoff names data.mergeRowId and data.commit";
  }
  if (data.transition === "leaving" && !isList(data.unblock, nonEmptyString)) {
    return "a leaving handoff names data.unblock, what only Tom can unblock, one line each";
  }
  if (!nonEmptyString(text)) return "a handoff names its one-line text";
  if (new TextEncoder().encode(JSON.stringify(data)).length > HANDOFF_MAX_BYTES) {
    return `a handoff's data is at most ${HANDOFF_MAX_BYTES} bytes; detail belongs in a file or a subagent its pointers name`;
  }
  return null;
}

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
  if (JOB_KINDS_WITH_DURATION.includes(kind) && isPlainObject(data) && data.durationMs !== undefined) {
    if (!(typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0)) {
      return { ok: false, error: `a ${kind} event names data.durationMs, when given, as non-negative milliseconds` };
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
  if (kind === "registry") {
    const problem = registryProblem(subject, data);
    if (problem !== null) return { ok: false, error: problem };
  }
  if (kind === "explanation") {
    const problem = explanationProblem(subject, data, prov);
    if (problem !== null) return { ok: false, error: problem };
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
  if (kind === "todo-state" || kind === "handoff") {
    const error = kind === "todo-state" ? todoStateError(data, text) : handoffError(data, text);
    if (error !== null) return { ok: false, error };
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

// ── The registry of Jarvis's parts ──────────────────────────────────────────
// A row of Jarvis worker/parts.json, as far as the record checks it.

/** A part's type, one shape each in the drawings (shared/parts-drawing.mjs). */
/** @type {const} */
export const PART_TYPES = ["page", "program", "agent", "store", "external", "wall", "document", "person"];
/** A part's fate in 2.0. */
/** @type {const} */
export const PART_FATES = ["kept", "replaced", "removed", "proposed"];
/** A part id: lowercase words joined by hyphens (Jarvis scripts/check-parts.mjs ID_FORM). */
export const PART_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Who designs a part: Tom in session, or outcomes govern it. */
/** @type {const} */
export const PART_DESIGNERS = ["tom", "outcomes"];

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const stringOrNull = (value) => value === null || typeof value === "string";

/**
 * What is wrong with one registry row, or null. The required fields are
 * Jarvis scripts/check-parts.mjs FIELDS: id, name, type, file, starts, reads,
 * writes, refuses, routes, schedule, fate, serves, designed_by and note. The
 * record checks each field's form; the registry check on the box holds what
 * the fields say (that a file exists, that an id names a row). The one row
 * check of the registry event and of a head's registry diff.
 */
function registryRowProblem(row, at) {
  if (!isPlainObject(row)) return `${at} is not an object`;
  if (typeof row.id !== "string" || !PART_ID.test(row.id)) return `${at}.id is not plain hyphenated words`;
  const named = `row ${row.id}`;
  if (!nonEmptyString(row.name)) return `${named} has no name`;
  if (!PART_TYPES.includes(row.type)) return `${named} has a type not one of ${PART_TYPES.join(", ")}`;
  if (!stringOrNull(row.file)) return `${named} has a file that is not a path or null`;
  for (const field of ["starts", "reads", "writes", "refuses", "routes"]) {
    if (!isStringList(row[field])) return `${named} has a ${field} that is not a list of strings`;
  }
  if (!stringOrNull(row.schedule)) return `${named} has a schedule that is not a job name or null`;
  if (!isPlainObject(row.fate) || !PART_FATES.includes(row.fate.type)) {
    return `${named} has a fate.type not one of ${PART_FATES.join(", ")}`;
  }
  if (!stringOrNull(row.fate.by)) return `${named} has a fate.by that is not a part id or null`;
  if (!Array.isArray(row.serves)) return `${named} has no serves list`;
  if (!PART_DESIGNERS.includes(row.designed_by)) return `${named} has a designed_by not one of ${PART_DESIGNERS.join(", ")}`;
  if (typeof row.note !== "string") return `${named} has no note`;
  return null;
}

/** The largest registry event, as UTF-8 JSON: 93 rows are about 90 KB, and a
 *  registry past this fails at the post rather than at a read. */
export const REGISTRY_MAX_BYTES = 512 * 1024;
/** The largest explanation document, as UTF-8. */
export const EXPLANATION_MAX_BYTES = 256 * 1024;

const utf8Bytes = (text) => new TextEncoder().encode(text).length;

/** What is wrong with a registry event's subject and data, or null. */
function registryProblem(subject, data) {
  if (!isPlainObject(data)) return "a registry event names data as an object";
  if (data.repo !== "Jarvis") return 'a registry event names data.repo as "Jarvis"';
  if (!nonEmptyString(data.sha)) return "a registry event names data.sha as the deployed commit";
  if (subject !== `Jarvis@${data.sha}`) return "a registry event names Jarvis@<data.sha> as its subject";
  if (data.id !== `registry:${subject}`) return "a registry event names data.id as registry:<subject>";
  if (!Array.isArray(data.parts)) return "a registry event names data.parts as the list of rows";
  if (data.count !== data.parts.length) return "a registry event names data.count as the number of rows";
  for (const [index, row] of data.parts.entries()) {
    const problem = registryRowProblem(row, `data.parts[${index}]`);
    if (problem !== null) return `a registry event's ${problem}`;
  }
  if (utf8Bytes(JSON.stringify(data)) > REGISTRY_MAX_BYTES) return `a registry event's data is over ${REGISTRY_MAX_BYTES} bytes`;
  return null;
}

/** What is wrong with an explanation event's subject, data and author, or null. */
function explanationProblem(subject, data, provenance) {
  if (!PART_ID.test(subject)) return "an explanation event names a part id as its subject";
  if (!nonEmptyString(provenance.agentId) && !nonEmptyString(provenance.session)) {
    return "an explanation event names the agent that wrote it as provenance.agentId or provenance.session";
  }
  if (!isPlainObject(data) || !nonEmptyString(data.title)) return "an explanation event names data.title as one line";
  if (typeof data.html !== "string" || !/^<!doctype html>/i.test(data.html.trimStart())) {
    return "an explanation event's data.html is one HTML document beginning <!doctype html>";
  }
  if (/<script/i.test(data.html) || /src\s*=/i.test(data.html)) {
    return "an explanation event's data.html holds no script and no src attribute";
  }
  if (utf8Bytes(data.html) > EXPLANATION_MAX_BYTES) return `an explanation event's data.html is over ${EXPLANATION_MAX_BYTES} bytes`;
  return null;
}

/**
 * A head's registry diff, checked: `{ base, added, removed, changed, rows }`
 * as the box's pull-request-checks job posts it on a Jarvis head's tests row
 * (POST /tts/tests), or null when it is not that shape. `rows` holds the
 * head's complete row for each id in `added` and `changed`, each passing the
 * row check of the registry event, and no row for any other id: the head's
 * registry is the base's with `rows` applied and `removed` taken out, so a
 * missing or partial row would draw a part that is not the head's.
 */
export function registryDiffOf(value) {
  if (!isPlainObject(value)) return null;
  const { base, added, removed, changed, rows } = value;
  if (!nonEmptyString(base)) return null;
  const ids = (list) => Array.isArray(list) && list.every((id) => typeof id === "string" && PART_ID.test(id));
  if (!ids(added) || !ids(removed) || !ids(changed)) return null;
  if (!isPlainObject(rows)) return null;
  const named = new Set([...added, ...changed]);
  if (Object.keys(rows).some((id) => !named.has(id))) return null;
  for (const id of named) {
    const row = rows[id];
    if (row === undefined || registryRowProblem(row, `rows.${id}`) !== null || row.id !== id) return null;
  }
  return { base: base.trim(), added, removed, changed, rows };
}
