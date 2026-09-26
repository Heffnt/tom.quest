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
// dtsEvents table (convex/jarvis/events.ts copyFromDts) keep the kind they
// had; the list governs what is POSTED, not what was.

/** @type {const} */
export const EVENT_KINDS = [
  // Jobs on the box (convex/jarvis/jobs.ts): a clean run, a failure, and the
  // Convex-written close of a keyed failure when the job next runs clean.
  "job-ok",
  "job-failed",
  "job-recovered",
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
