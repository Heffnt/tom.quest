import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { DAY_MS, NEEDS_TOM } from "./ttsShared";
import { MERGE } from "./ttsMerge";
import { REMOVAL_LOOP_PR, SIMPLIFY_PROPOSAL } from "./ttsSimplify";
import { logEvent } from "./tts";
import { newestTodoEvents, resolveId } from "./jarvis/tables";
import { DIGEST_LINE } from "./jarvis/outbox";
import { insertEvent } from "./jarvis/record";
import { redactSecrets } from "../shared/redact.mjs";
import { decisionOfAnswer } from "../shared/decided-by.mjs";

export const DELEGATE_DECISION = "delegate-decision";
export const DELEGATE_OBJECTION = "delegate-objection";
export const DELEGATE_TIMEOUT_MS = 120_000;
export const DELEGATE_MAX_TURNS = 6;
export const DELEGATE_MAX_PER_SESSION = 5;
export const DELEGATE_MAX_PER_JOB = 3;
export const DIGEST_OBJECTION_LOOKBACK = 14;

export type ObjectionFact = {
  askId: string;
  at: number;
  todoId: string | null;
  decision: string | null;
  reason: string;
  refused: boolean;
  refusedBecause: string | null;
  fallback: string;
  subject: string | null;
  objectedAt: number | null;
};

export function objectionRank(
  // The THREE FIELDS the order reads, not a whole ObjectionFact: the morning's
  // gatherer (convex/ttsDigest.ts) holds its rows in the composer's shape,
  // where an absent todo is `undefined` rather than null, and one order must
  // serve both. Lower sorts first; ties break by `at` descending.
  objection: { refused?: boolean; todoId?: string | null; decision?: string | null },
  ready: ReadonlySet<string>,
  dueSoon: ReadonlySet<string>,
): number {
  const todoId = objection.todoId ?? null;
  if (objection.refused && todoId !== null && dueSoon.has(todoId)) return 0;
  if (objection.refused) return 1; // something is parked on him
  if (objection.decision === null || objection.decision === undefined) return 2; // no answer came back
  if (todoId !== null && dueSoon.has(todoId)) return 3;
  if (todoId !== null && ready.has(todoId)) return 4;
  if (todoId !== null) return 5;
  return 6; // a question about the run itself
}

export function stripNarrowListId(text: string): string {
  const cut = text.indexOf(" — ");
  return cut === -1 ? text.trim() : text.slice(cut + 3).trim();
}

const ASK_ARGS = {
  askId: v.string(),
  sessionId: v.optional(v.string()),
  job: v.optional(v.string()),
  todoId: v.optional(v.string()),
  question: v.string(),
  options: v.array(v.string()),
  recommendation: v.string(),
  fallback: v.string(),
  decision: v.union(v.string(), v.null()),
  reason: v.string(),
  refused: v.boolean(),
  refusedBecause: v.union(v.string(), v.null()),
  model: v.string(),
  ms: v.number(),
  promptSha: v.string(),
  // THE RUN THAT TOOK THIS DECISION — the delegate run itself, so an objection
  // of Tom's on the digest's objection list can be scored against the output
  // he objected to
  // (convex/agentLabels.ts internalLabelFromObjection reads it back off this
  // row's data). `data` is v.any(), so this is not a schema change, exactly as
  // the digest-sent row's objectionAskIds (convex/jarvis/digest.ts) say of their own
  // field. A caller that passes no token stores none: an unregistered
  // delegate call carries no run, and the absence is never inferred into one.
  runToken: v.optional(v.string()),
  // What the decision row (events kind "decision", convex/jarvis/intent.ts)
  // carries beyond the ask: the lines it rested on, what would change it, and
  // the searches that missed. Only this mutation writes that row
  // (shared/jarvis-events.mjs DELEGATE_ONLY_KINDS).
  restedOn: v.optional(v.array(v.string())),
  wouldChange: v.optional(v.union(v.string(), v.null())),
  nearMissed: v.optional(v.any()),
  // WHO DECIDED, AND HOW LONG THE QUESTION WAITED FOR TOM FIRST. Jarvis
  // `jarvis decide --trade-off` (Jarvis #262) puts a real trade-off to him as
  // a needs-you item and waits up to two hours (his answer 4 of 2026-10-04).
  // `waitedMs` is that wait and `waitNote` its one line (why it ended, or why
  // it never started). `decidedBy` is "tom" when his reply is the decision,
  // and then `needsTomId` names the needs-you item his reply answered: the
  // record finds his `needs-tom-answered` row under it and checks that the
  // decision is what that reply named (tomAnswer, below). Absent means the
  // delegate, as every ask before the wait was.
  waitedMs: v.optional(v.number()),
  waitNote: v.optional(v.string()),
  decidedBy: v.optional(v.union(v.literal("delegate"), v.literal("tom"))),
  needsTomId: v.optional(v.string()),
};

type AskData = {
  askId: string;
  sessionId?: string;
  job?: string;
  todoId?: string;
  question: string;
  options: string[];
  recommendation: string;
  fallback: string;
  decision: string | null;
  reason: string;
  refused: boolean;
  refusedBecause: string | null;
  model: string;
  ms: number;
  promptSha: string;
  runToken?: string;
};


/** How many asks this caller made in the last day, read on the caller's own
 *  index (dtsEvents.by_kind_session_at or by_kind_job_at), so other callers'
 *  rows are never read, and at most `limit` rows: the cap needs only to know
 *  whether cap is reached, so cap + 1 bounds it.
 *
 *  A DECISION BY TOM IS NOT AN ASK OF THE DELEGATE, so it does not count:
 *  the cap is the delegate's spend wall. The filter reads past those rows,
 *  and there are at most as many as his replies to this caller's questions
 *  that day. */
async function callerAsks(
  ctx: QueryCtx,
  args: { sessionId?: string; job?: string },
  limit: number,
): Promise<number> {
  const since = Date.now() - DAY_MS;
  const rows =
    args.sessionId !== undefined
      ? ctx.db
          .query("dtsEvents")
          .withIndex("by_kind_session_at", (q) =>
            q.eq("kind", DELEGATE_DECISION).eq("data.sessionId", args.sessionId).gte("at", since),
          )
      : ctx.db
          .query("dtsEvents")
          .withIndex("by_kind_job_at", (q) => q.eq("kind", DELEGATE_DECISION).eq("data.job", args.job).gte("at", since));
  return (await rows.filter((q) => q.neq(q.field("data.decidedBy"), "tom")).take(limit)).length;
}

function capFor(args: { sessionId?: string }): number {
  if (args.sessionId !== undefined) return DELEGATE_MAX_PER_SESSION;
  return DELEGATE_MAX_PER_JOB;
}

/** The reason a capped ask carries: the caller took its own fallback. */
export const CAP_REFUSAL = "cap: the delegate ask cap for this caller is spent, so the agent took its own fallback";

/** An ask as its delegate-decision row stores it (the fields the decision
 *  row reads), with what only the decision row carries when the caller sent
 *  it. The caller is exactly one of sessionId and job. */
type StoredAsk = {
  askId: string;
  question: string;
  options: string[];
  decision: string | null;
  reason: string;
  refused: boolean;
  refusedBecause: string | null;
  model: string;
  sessionId: string | null;
  job: string | null;
  todoId: string | null;
  restedOn?: string[];
  wouldChange?: string | null;
  nearMissed?: unknown;
  decidedBy?: "delegate" | "tom";
  waitedMs?: number;
  waitNote?: string;
  needsTomId?: string;
  /** The `needs-tom-answered` row that backs a decision by Tom. */
  answerEventId?: string;
};

/** The most characters of the question, and of the decision, a notification
 *  carries. A push service may refuse a payload over 4,096 bytes (RFC 8030
 *  section 7.2; the RFC 8291 encryption takes about 100 of them), and a refused
 *  send is lost. POST /tts/ask caps the question at 400 characters and the
 *  decision not at all, so the decision is cut at the question's own limit:
 *  two lines of 400 characters, at most 3 UTF-8 bytes each once control
 *  characters are collapsed, plus the title and url, stay under 2,600 bytes. */
const PUSH_LINE_MAX = 400;

/** One line of a notification: whitespace, line breaks and other control
 *  characters collapsed to one space, secrets redacted as the digest redacts
 *  them, cut at PUSH_LINE_MAX with an ellipsis. */
function pushLine(text: string): string {
  const line = redactSecrets(text).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length <= PUSH_LINE_MAX ? line : `${line.slice(0, PUSH_LINE_MAX - 1).trimEnd()}…`;
}

/** The row his numbered reply to a needs-you item writes on /thread: subject
 *  the item's key, provenance user tom, `data.answer` what followed the
 *  number. No worker-key route writes it: the kind is outside
 *  shared/jarvis-events.mjs EVENT_KINDS here, and tom.quest #339, which adds
 *  its writer, lists it in TOM_ONLY_KINDS. */
const NEEDS_TOM_ANSWERED = "needs-tom-answered";

/** The key a `jarvis decide` question's needs-you item carries (Jarvis
 *  worker/jobs/delegate.mjs needsYouKey): one item per ask. */
function tomAnswerKey(askId: string): string {
  return `delegate-ask:${askId}`;
}

/**
 * The reply of Tom's that backs a decision by Tom, or a thrown reason the
 * record refuses it. A decision row in his name is written when his own
 * reply to this ask's needs-you item named it, and refused otherwise.
 *
 * Four checks, each against the record:
 * 1. `needsTomId` is this ask's item (`delegate-ask:<askId>`), so a reply of
 *    his to some other item cannot back this ask;
 * 2. the item's needs-tom row stores the question and options he was shown
 *    (POST /tts/needs-tom), and the ask's question and options are those, so
 *    a caller cannot pair his reply with another question or another option
 *    list;
 * 3. the newest `needs-tom-answered` row under it was written as his
 *    (provenance user tom) and carries an answer;
 * 4. the decision is what that answer names among the options he was shown
 *    (shared/decided-by.mjs decisionOfAnswer, the mapping the box uses): the
 *    option its letter or words name, or else his words.
 */
async function tomAnswer(
  ctx: QueryCtx,
  args: { askId: string; needsTomId?: string; question: string; options: string[]; decision: string | null },
): Promise<{ eventId: string; answer: string }> {
  const key = tomAnswerKey(args.askId);
  if (args.needsTomId !== key) {
    throw new Error(`a decision by Tom names this ask's needs-you item, ${key}`);
  }
  const item = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", NEEDS_TOM).eq("key", key))
    .first();
  const shown = (item?.data ?? {}) as { question?: unknown; options?: unknown };
  const shownOptions = Array.isArray(shown.options) ? shown.options.filter((o): o is string => typeof o === "string") : null;
  if (item === null || typeof shown.question !== "string" || shownOptions === null || shownOptions.length === 0) {
    throw new Error(`the record holds no question with options shown to Tom under ${key}`);
  }
  if (args.question !== shown.question) throw new Error(`the question is not the one Tom was shown under ${key}`);
  if (args.options.length !== shownOptions.length || args.options.some((option, i) => option !== shownOptions[i])) {
    throw new Error(`the options are not the ones Tom was shown under ${key}`);
  }
  const row = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", NEEDS_TOM_ANSWERED).eq("subject", key))
    .order("desc")
    .first();
  if (row === null) throw new Error(`no answer of Tom's to ${key} is in the record`);
  if (row.provenance.user !== "tom") throw new Error(`the answer to ${key} was not written as Tom's`);
  const said = (row.data as { answer?: unknown } | undefined)?.answer;
  const answer = typeof said === "string" ? said.trim() : "";
  if (answer === "") throw new Error(`the answer to ${key} is empty`);
  if (args.decision !== decisionOfAnswer(answer, shownOptions)) {
    throw new Error(`the decision is not what Tom's answer to ${key} names`);
  }
  return { eventId: row._id, answer };
}

/** The decision row (events kind "decision", convex/jarvis/intent.ts) for one
 *  answered ask, built from the ask as recorded; only internalRecordAsk calls it.
 *
 *  A DECISION THE DELEGATE TOOK IS ALSO ONE WEB PUSH to every live
 *  subscription (convex/pushSend.ts sendToAll): the question on one line, the
 *  decision on the next, and a tap opens that decision's row on /intent
 *  (app/intent/intent-client.tsx reads the #decision-<askId> fragment). Tom's
 *  answer of 2026-10-04 to the question about decisions taken while he is
 *  reachable but not in the session: "agreed. lets send notifications to my
 *  phone for this." A refusal took nothing in his name and is not pushed: the
 *  caller took its fallback, and the digest lists it as "REFUSED and parked"
 *  (convex/ttsCompose.ts objectionLine). The push is scheduled, so a send that
 *  fails (no VAPID pair, a push service error) never undoes the row. */
async function insertDecision(ctx: MutationCtx, ask: StoredAsk): Promise<void> {
  // A DECISION BY TOM is his reply, so the row carries his provenance (the
  // provenance of the needs-tom-answered row tomAnswer checked) and names
  // that row; `caller` still says who asked. It sends no web push: the push
  // tells him what the delegate decided while he was away (tom.quest #340),
  // and he wrote this one himself.
  const byTom = ask.decidedBy === "tom";
  await insertEvent(ctx, {
    kind: "decision",
    provenance: byTom ? { user: "tom" } : ask.sessionId !== null ? { session: ask.sessionId } : { job: ask.job ?? undefined },
    subject: ask.askId,
    data: {
      question: ask.question,
      options: ask.options,
      decision: ask.decision,
      reason: ask.reason,
      restedOn: ask.restedOn ?? [],
      wouldChange: ask.wouldChange ?? null,
      refused: ask.refused,
      refusedBecause: ask.refusedBecause,
      caller: ask.sessionId !== null ? `session:${ask.sessionId}` : `job:${ask.job}`,
      askId: ask.askId,
      ...(ask.todoId === null ? {} : { todoId: ask.todoId }),
      model: ask.model,
      ...(ask.nearMissed === undefined ? {} : { nearMissed: ask.nearMissed }),
      ...(ask.decidedBy === undefined ? {} : { decidedBy: ask.decidedBy }),
      ...(ask.waitedMs === undefined ? {} : { waitedMs: ask.waitedMs }),
      ...(ask.waitNote === undefined ? {} : { waitNote: ask.waitNote }),
      ...(byTom ? { needsTomId: ask.needsTomId, answerEventId: ask.answerEventId } : {}),
    },
  });
  // His own decision is not pushed: he wrote it himself on /thread.
  if (ask.refused || ask.decision === null || ask.decidedBy === "tom") return;
  await ctx.scheduler.runAfter(0, internal.pushSend.sendToAll, {
    title: "Delegate decision",
    body: `${pushLine(ask.question)}\n${pushLine(ask.decision)}`,
    // The askId is 8 lowercase hex characters (POST /tts/ask refuses any
    // other), so it goes into the fragment as it is.
    url: `/intent#decision-${ask.askId}`,
  });
}

/** Record the completed box-side delegate call. This does not call a model:
 * Convex cannot reach the box, and the caller is already there. */
export const internalRecordAsk = internalMutation({
  args: ASK_ARGS,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", args.askId))
      .first();
    if (existing) {
      const stored = (existing.data ?? {}) as StoredAsk & { attended?: unknown };
      // A RETRY IS THE SAME ASK. One that names another question, decision,
      // caller or todo under a recorded askId is refused: the recorded ask
      // stands, and nothing is written from the new body.
      // A todo id that names no todo is itself a contradiction: it must not
      // resolve to "no todo" and so match an ask recorded without one.
      // The recorded todo is a stored reference: the old row's id on an ask
      // recorded before this step, the plain row's since. Both sides are
      // compared as the plain todo they name.
      const todoId = args.todoId === undefined ? null : await resolveId(ctx, "todos", args.todoId);
      const storedTodoId = typeof stored.todoId === "string" ? await resolveId(ctx, "todos", stored.todoId) : null;
      if (
        (args.todoId !== undefined && todoId === null) ||
        args.question !== stored.question ||
        args.decision !== stored.decision ||
        (args.sessionId ?? null) !== (stored.sessionId ?? null) ||
        (args.job ?? null) !== (stored.job ?? null) ||
        (args.decidedBy === "tom") !== (stored.decidedBy === "tom") ||
        todoId !== storedTodoId
      ) {
        throw new Error(`askId ${args.askId} is already recorded for a different ask`);
      }
      // A RETRY OF A RECORDED ASK still gets its decision row: an ask
      // recorded before this mutation wrote the row had it posted separately,
      // a post the generic routes now refuse, so the retry is its one way in.
      // The row is built from the ask as recorded, its todo the plain one the
      // check above resolved, and one per ask: none is written when one
      // already stands.
      const took = stored.decision !== null && stored.decision !== undefined && stored.attended !== true && stored.refusedBecause !== CAP_REFUSAL;
      if (took) {
        const written = await ctx.db
          .query("events")
          .withIndex("by_kind_subject_at", (q) => q.eq("kind", "decision").eq("subject", args.askId))
          .first();
        if (written === null) await insertDecision(ctx, { ...stored, todoId: storedTodoId });
      }
      return { id: existing._id, existing: true, attended: false, capped: false };
    }

    const todoId = args.todoId === undefined ? undefined : await resolveId(ctx, "todos", args.todoId);
    if (args.todoId !== undefined && todoId === null) throw new Error(`Unknown todo id: ${args.todoId}`);
    let session: Doc<"claudeSessions"> | null = null;
    if (args.sessionId !== undefined) {
      const sessionId = ctx.db.normalizeId("claudeSessions", args.sessionId);
      session = sessionId === null ? null : await ctx.db.get(sessionId);
      if (!session) throw new Error(`Unknown session id: ${args.sessionId}`);
    }

    // A DECISION BY TOM is checked against his reply before anything is
    // written, and passes neither the attended check nor the cap: both are
    // walls on the delegate deciding in his name, and here he decided.
    const byTom = args.decidedBy === "tom";
    const answered = byTom ? await tomAnswer(ctx, args) : null;
    const cap = capFor(args);
    const callerCount = byTom ? 0 : await callerAsks(ctx, args, cap + 1);
    const attended = !byTom && session !== null && session.mode !== "autonomous";
    const capped = !byTom && callerCount >= cap;
    // The cap is the delegate's spend wall: past it, no answer is acted on.
    // A CAPPED ASK TOOK NOTHING IN HIS NAME: the box does not act on the
    // delegate's answer past the cap and takes the caller's fallback, so the
    // row reads as refused, with the cap as its reason, like an attended one.
    const refused = attended || capped ? true : args.refused;
    const refusedBecause = attended
      ? "attended-session: Tom is in this session — ask him"
      : capped
        ? CAP_REFUSAL
        : args.refusedBecause;
    // The dts row keeps the ask; what only the decision row carries stays off it.
    const { restedOn, wouldChange, nearMissed, ...ask } = args;
    const stored = {
      ...ask,
      sessionId: args.sessionId ?? null,
      job: args.job ?? null,
      todoId: todoId ?? null,
      ...(answered === null ? {} : { answerEventId: answered.eventId }),
    };
    const id = await logEvent(ctx, DELEGATE_DECISION, todoId ?? undefined, {
      ...stored,
      refused,
      refusedBecause,
      attended,
    }, args.askId);

    // THE DECISION ROW: one per decision the delegate took, a refusal
    // included, written here and nowhere else, in the ask's own transaction,
    // so a decision row exists only for an ask that passed the attended check
    // and the cap. Silence, attended and capped asks took nothing in his name.
    if (args.decision !== null && !attended && !capped) {
      await insertDecision(ctx, { ...stored, restedOn, wouldChange, nearMissed });
    }

    // The digest's objection list reads this delegate-decision row itself
    // (convex/ttsDigest.ts); there is no live line (one output channel).
    return { id, existing: false, attended, capped };
  },
});

/**
 * The record's row for an askId the digest numbers: a `jarvis decide`
 * decision (events kind "decision") or a line a producer put on the digest
 * (kind "digest-line"), each filed under its askId as the subject. The one
 * lookup the objection resolver, the ask context and the objection label
 * share, so what one of them can find the others can.
 */
export async function recordedDecision(ctx: QueryCtx, askId: string): Promise<Doc<"events"> | null> {
  return await ctx.db
    .query("events")
    .withIndex("by_subject_at", (q) => q.eq("subject", askId))
    .order("desc")
    .filter((q) => q.or(q.eq(q.field("kind"), "decision"), q.eq(q.field("kind"), DIGEST_LINE)))
    .first();
}

export const internalAskContext = internalQuery({
  args: { sessionId: v.optional(v.string()), job: v.optional(v.string()), todoId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const asked = await callerAsks(ctx, args, capFor(args) + 1);
    const priorObjections: { askId: string; at: number; revert: boolean; sentence: string | null; decision: string | null }[] = [];
    if (args.todoId !== undefined) {
      // The todo's newest 100 rows under either id, read through the index.
      const events = await newestTodoEvents(ctx, args.todoId, 100);
      for (const event of events) {
        if (event.kind !== DELEGATE_OBJECTION || priorObjections.length >= 5) continue;
        const data = (event.data ?? {}) as { askId?: unknown; revert?: unknown; sentence?: unknown };
        const askId = data.askId;
        if (typeof askId !== "string") continue;
        // The ask row, else the record's decision row: a revert of a decision
        // only the record holds must still tell the next delegate what it was.
        const decision =
          (await ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", askId)).first()) ??
          (await recordedDecision(ctx, askId));
        const decisionData = (decision?.data ?? {}) as { decision?: unknown };
        priorObjections.push({ askId, at: event.at, revert: data.revert === true, sentence: typeof data.sentence === "string" ? data.sentence : null, decision: typeof decisionData.decision === "string" ? decisionData.decision : null });
      }
    }
    return { asked, cap: capFor(args), priorObjections };
  },
});

/**
 * Tom's objection to one decision. It is his BY CONSTRUCTION: its two callers
 * are convex/ttsSlack.ts's thread-reply route, which is reached only for a
 * message it matched to TOM_SLACK_USER_ID in a thread whose subject it
 * resolved, and convex/thread.ts's reply under a thread digest, which is
 * reached only through thread.send after requireTom. There the channel is
 * "thread", ts his message's event id and threadTs the digest's. No agent
 * can write this row through any door.
 *
 * `n` and `day` name the digest line he answered. Both are absent on an
 * objection recorded before the one output channel, from the retired
 * decisions room, where a decision had its own thread and no number.
 *
 * The row carries the DECISION's todoId, so it lands on that todo's own event
 * timeline — which is where internalAskContext finds it and hands it to the
 * delegate the next time anything asks about that todo. That, and nothing
 * automatic, is the whole of "supersedes": a revert does not patch the todo,
 * does not change readiness, and undoes nothing by itself. Undoing is work,
 * and work is done by a session.
 */
export const internalRecordDelegateObjection = internalMutation({
  args: {
    askId: v.string(),
    n: v.optional(v.number()),
    day: v.optional(v.string()),
    text: v.string(),
    revert: v.boolean(),
    sentence: v.union(v.string(), v.null()),
    channel: v.string(),
    ts: v.string(),
    threadTs: v.string(),
  },
  handler: async (ctx, args) => {
    // The thing objected to is a delegate decision, OR a merge: both are
    // reported in the digest's objection list, so both accept a "revert"
    // (convex/ttsMerge.ts). A merge's askId is its own `<repo>:<sha>` key. A
    // simplification proposal is the third for the same reason, and its askId
    // is its own `simplify:<id>` key (convex/ttsNightly.ts). A removal-loop
    // pull request is the fourth, keyed `loop:<number>`.
    //
    // THE RECORD'S ROWS TOO. Every askId the digest numbers must resolve here,
    // or "revert <n>" throws on a line he was offered: a `jarvis decide`
    // decision is an events row of kind "decision" whose subject is its askId
    // (convex/jarvis/intent.ts), and a line a producer put on the digest
    // (ruling:, learning:, repo-proposal:, box-change:)
    // is an events row of kind "digest-line" whose subject is its askId
    // (convex/jarvis/outbox.ts listForDigest).
    const legacy =
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", args.askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", MERGE).eq("key", args.askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", SIMPLIFY_PROPOSAL).eq("key", args.askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", REMOVAL_LOOP_PR).eq("key", args.askId))
        .first());
    let todoId = legacy?.todoId;
    if (legacy === null) {
      const recorded = await recordedDecision(ctx, args.askId);
      if (recorded === null) throw new Error(`Delegate decision not found: ${args.askId}`);
      const named = (recorded.data as { todoId?: unknown } | undefined)?.todoId;
      todoId = typeof named === "string" ? ((await resolveId(ctx, "todos", named)) ?? undefined) : undefined;
    }
    const eventId = await logEvent(ctx, DELEGATE_OBJECTION, todoId, args, args.askId);
    // AN OBJECTION IS A JUDGMENT ABOUT THE RUN THAT TOOK THE DECISION, and the
    // label writer resolves it the same way this handler just resolved the
    // subject: the decision row (or the merge row) carries the run's token.
    //
    // Scheduled rather than awaited, for the reason insertRuling gives: the
    // objection is the fact. A decision from before runs were registered
    // carries no token, and an unlinkable label must not roll back an
    // objection Tom typed into Slack — Slack has already been answered 200 and
    // will not deliver the reply again.
    await ctx.scheduler.runAfter(0, internal.agentLabels.internalLabelFromObjection, {
      eventId,
      askId: args.askId,
    });
    return eventId;
  },
});
