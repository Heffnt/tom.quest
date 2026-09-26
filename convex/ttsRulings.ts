import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTom, requireTomOrAgent } from "./authRoles";
import { applyStatusChange, logEvent } from "./tts";
import { isChangeSubject, tracksCodeTodos } from "./ttsShared";
import { resolveId, todoRef } from "./jarvis/tables";

// Tom's rulings, unified over life and code todos (ratified 2026-08-28).
// A ruling = subject + verdict + optional sentence + timestamp. The closed
// verdict set (see schema.ts ttsRulings) is the ONLY vocabulary any ruling
// button anywhere may use:
//   approve — execute as briefed
//   revise  — one written sentence redirects the preparing agent, no session
//   session — this needs conversation
//   archive — set aside
// "defer" is not a verdict: not ruling IS deferring; timing changes are a
// reschedule (blocks / a time note), not a ruling.
//
// SENTENCE ON ANY VERDICT (2026-08-29): all four verdicts accept the optional
// `sentence`. Required only on revise; on archive it is the unarchive
// condition; on approve/session it is a free note that reaches the planner's
// prompt, the preparer prompt, and the session's opening prompt.
//
// EVERY VERDICT'S EFFECT IS APPLIED AT WRITE TIME, OR AT THE ONE MOMENT ITS
// EFFECT CAN EXIST (the lifeos update, phase 7; there is no apply job on the
// box any more). Per subject:
//   life   — revise drops readiness to "unprepared" here and the planner's
//            prepare pass re-prepares the todo with the sentence, consuming
//            the ruling when the re-prep lands; archive archives here;
//            approve is ratification and applies here; session applies the
//            moment Tom opens an interactive session on the todo
//            (markLiveSessionRulingApplied, from claudeSessions.insertSession).
//   code   — the repo is the system of record, so the effect is work in the
//            repo: approve and archive were admitted by the auto-session
//            scheduler as worker missions until it was deleted (2026-09-26);
//            the box's work-queue job is their consumer now, and until it
//            takes them they stay pending on the feed;
//            revise was consumed by the planner's brief pass, which is
//            retired with ComplexMultiTrigger's registry (ruling 70) — a code
//            ruling needs a brief and nothing writes one now; session applies
//            the moment Tom opens an interactive session on the code block, whose opener names each
//            subject and sentence it consumes (liveCodeSessionRulings +
//            markCodeSessionRulingsApplied, from claudeSessions.insertSession).
//            A code subject that names a CHANGE rather than a todo
//            (ttsShared.isChangeSubject) applies here on every verdict; an
//            approve is landed by convex/observeMerge.ts once its gate is green.
// appliedAt/applyResult record the application either way; a newer ruling on
// the same subject supersedes an older unapplied one (append-only, history
// kept).
//
// TWO SUBJECT TYPES: life (a todos row) and code (repo + externalId). The
// third, a batch, went with batches (Tom's ruling of 2026-09-24: "I dont want
// to have batches at all anymore"). The schema still declares subjectType
// "batch" and batchId until the narrow, so a stored row can carry them; no
// door takes one.

const VERDICT = v.union(
  v.literal("approve"),
  v.literal("revise"),
  v.literal("session"),
  v.literal("archive"),
);

export type RulingVerdict = "approve" | "revise" | "session" | "archive";

const VERDICTS: readonly RulingVerdict[] = [
  "approve",
  "revise",
  "session",
  "archive",
];
export const isRulingVerdict = (x: unknown): x is RulingVerdict =>
  typeof x === "string" && (VERDICTS as readonly string[]).includes(x);

// Where a ruling came from when it was NOT a button (schema: rulings.provenance).
export type TomWordsProvenance = {
  from: "tom-words";
  inboundId: string;
  quote: string;
};

// The ONE definition of a ruling subject's identity (repo names carry no
// spaces; the type prefix keeps life and code keys disjoint, and a
// stored batch row — the schema declares one until the narrow — apart from
// both). Client code derives live rulings with the same rule via
// app/tts/lib.ts.
export const subjectKey = (row: {
  subjectType: "life" | "code" | "batch";
  todoId?: string;
  repo?: string;
  externalId?: string;
  batchId?: string;
}) => {
  if (row.subjectType === "life") return `life ${row.todoId}`;
  if (row.subjectType === "batch") return `batch ${row.batchId}`;
  return `code ${row.repo} ${row.externalId}`;
};

// ── Tom-facing ───────────────────────────────────────────────────────────────

// Everything, always: append-only at human pace — a full collect is fine and
// lets the client find the live (newest ruledAt) ruling per subject.
export const listRulings = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgent(ctx, "TTS");
    return await ctx.db.query("rulings").collect();
  },
});

// The ONE implementation of recording a ruling — used by the Tom-gated
// recordRuling below, by internalRecordRuling (a live session's pen, the
// tts.internalTriage pattern), and by observe.approveChange (the Approve
// control on the observation page), so verdict semantics cannot drift between
// the doors. EXPORTED for that third caller and for no other reason: a
// mutation cannot call another mutation in Convex, so a door that wants these
// semantics has to call this function.
export async function insertRuling(
  ctx: MutationCtx,
  {
    todoId,
    repo,
    externalId,
    verdict,
    sentence,
    unarchiveCondition,
    provenance,
  }: {
    todoId?: Id<"todos">;
    repo?: string;
    externalId?: string;
    verdict: RulingVerdict;
    sentence?: string;
    unarchiveCondition?: string;
    provenance?: TomWordsProvenance;
  },
) {
  const isLife = todoId !== undefined;
    const isCode = repo !== undefined || externalId !== undefined;
    if ([isLife, isCode].filter(Boolean).length !== 1) {
      throw new Error(
        "A ruling has exactly one subject: todoId (life) OR repo+externalId (code)",
      );
    }
    if (isCode && (repo === undefined || externalId === undefined)) {
      throw new Error("A code ruling requires both repo and externalId");
    }
    // A repo taken off the code-todo list keeps its mirror rows and briefs as
    // records, so an open, briefed row of it still exists — and a ruling on
    // it would be recorded here and refused by the scheduler, with no session
    // ever opened. ComplexMultiTrigger is the case: Tom's ruling of 2026-09-22
    // (CMT adoption ruling 70) moved its todos into TTS, where they are ruled
    // as todos. One check for every pen: the page's buttons, the session CLI
    // pen and the ruling from Tom's words all arrive here. A ruling on a
    // CHANGE (a pull request or commit, isChangeSubject below) is not about a
    // code todo, so it passes in any repository.
    if (isCode && !isChangeSubject(externalId!) && !tracksCodeTodos(repo!)) {
      throw new Error(
        `refused: ${repo} is off the code-todo list (ttsShared CODE_TODO_REPOS) — its mirror rows are records, and its todos are ruled in TTS`,
      );
    }
    // One optional written note on EVERY verdict (ratified 2026-08-29): the
    // four verdicts are uniform, each taking an optional note. Its MEANING is
    // per-verdict and unchanged — revise: the redirect (still required);
    // archive: the condition to propose it back; approve/session: free
    // steering the worker prompts and the session prompt read.
    const trimmed = sentence?.trim();
    if (verdict === "revise" && !trimmed) {
      throw new Error(
        "revise is the sentence verdict — write the sentence that redirects the agent",
      );
    }
    const now = Date.now();

    let appliedAt: number | undefined;
    let applyResult: string | undefined;
    if (isLife) {
      const todo = await ctx.db.get(todoId);
      if (!todo) throw new Error("TTS todo not found");
      // A ruling is a Tom touch: tomTouchedAt freezes the row to the planner
      // (tts.internalStorePlanGraph never rewrites it) — EXCEPT revise, the
      // one verdict that hands the subject BACK to the preparing agent.
      if (verdict !== "revise") {
        await ctx.db.patch(todoId, { tomTouchedAt: now });
      }
      if (verdict === "revise") {
        // Two readiness values (ruling 18): revise hands the write-up back, so
        // the row is unprepared — preparation is owed again — until the
        // preparer returns it as prepared. It is therefore not ready for Tom
        // in the meantime (ttsShared.isReadyForTom).
        await ctx.db.patch(todoId, { readiness: "unprepared", updatedAt: now });
      }
      if (verdict === "archive") {
        await applyStatusChange(ctx, todo, {
          status: "archived",
          // On archive the sentence IS the unarchive condition (the one
          // option row now sends a single note per verdict); the older
          // explicit arg still wins when a caller passes both.
          unarchiveCondition: unarchiveCondition ?? trimmed,
          note: trimmed,
        });
        appliedAt = now;
        applyResult = "status archived";
      }
      if (verdict === "approve") {
        // No agent executes life todos yet — Tom is the executor. Approving a
        // life plan is pure ratification, so it applies the moment it is
        // recorded (leaving it "pending" would strand it forever: every
        // worker filters life rows to revise). When a life executor exists,
        // this is the line that changes.
        appliedAt = now;
        applyResult = "plan ratified";
      }
      // session: applied when the session is created (claudeSessions.createSession marks).
    }

    if (isCode && isChangeSubject(externalId!)) {
      // A RULING ON A CHANGE (a pull request or a merged commit, not a code
      // todo) is applied the moment it is written, because nothing else can
      // ever apply it: a consumer of the pending feed would read an unapplied
      // approve as a code todo's, and the brief pass would wait forever on a
      // revise. What an approve
      // sets in motion is read off this row by convex/observeMerge.ts, which
      // lands the change once its gate is green; a later ruling on the same
      // subject is newer and so withdraws it.
      appliedAt = now;
      applyResult =
        verdict === "approve"
          ? "approved: the record merges it once its gate is green"
          : `${verdict} recorded on the change`;
    }

    const id = await ctx.db.insert("rulings", {
      subjectType: isLife ? "life" : "code",
      todoId,
      repo,
      externalId,
      verdict,
      sentence: trimmed || undefined,
      ruledAt: now,
      appliedAt,
      applyResult,
      provenance,
    });
    await logEvent(ctx, "ruling", todoId, {
      verdict,
      repo,
      externalId,
      sentence: trimmed || undefined,
      provenance,
    });
    // A RULING IS A JUDGMENT ABOUT A RUN'S OUTPUT, and this is where the evals
    // layer hears about it: the label writer finds the run that wrote the text
    // he ruled on (the subject row's producedByRunToken) and records what the
    // verdict said about it (convex/agentLabels.ts).
    //
    // SCHEDULED, NOT AWAITED, for the reason this file already gives about the
    // decisions line below: the ruling is the fact. A label that cannot be
    // linked — a subject no run ever claimed, an older row from before runs
    // were registered — must not roll back a ruling Tom made, and inside this
    // transaction a throw in the writer would do exactly that. Scheduled, the
    // unlinked act is counted on its own row and the ruling stands.
    await ctx.scheduler.runAfter(0, internal.agentLabels.internalLabelFromRuling, {
      rulingId: id,
    });
    // A RULING READ OUT OF HIS SENTENCE IS A DECISION TAKEN IN HIS NAME, so it
    // goes to #tts-decisions the moment it is written rather than waiting for
    // the morning (slack-design.md §1.2): the run that acts on a misread
    // sentence will have finished by 5 a.m. Only the words door — a ruling he
    // pressed a button for is not a decision anyone took for him.
    if (provenance !== undefined) {
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendDecision, {
        askId: `ruling:${id}`,
        ...(todoId === undefined ? {} : { todoId }),
        decision: `${await ruledSubjectName(ctx, { todoId, repo, externalId })} was ruled a ${verdict} from your own words`,
        ...(trimmed ? { reason: trimmed } : {}),
      });
    }
    return id;
}

/** What a decision line calls the thing that was ruled on: the todo's own
 *  statement, or the code todo's repo and id. Never an id on its
 *  own — an id in a message is a word Tom has to translate. */
async function ruledSubjectName(
  ctx: MutationCtx,
  subject: {
    todoId?: Id<"todos">;
    repo?: string;
    externalId?: string;
  },
): Promise<string> {
  if (subject.todoId !== undefined) {
    return (await ctx.db.get(subject.todoId))?.statement ?? "an item";
  }
  if (subject.repo !== undefined && subject.externalId !== undefined) {
    return `${subject.repo} ${subject.externalId}`;
  }
  return "the agent";
}

export const recordRuling = mutation({
  args: {
    todoId: v.optional(v.id("todos")),
    repo: v.optional(v.string()),
    externalId: v.optional(v.string()),
    verdict: VERDICT,
    sentence: v.optional(v.string()),
    // archive on a life todo only: the condition under which it should be
    // proposed back (same field setStatus carries).
    unarchiveCondition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTom(ctx, "TTS");
    return await insertRuling(ctx, args);
  },
});

// A live session's ruling pen (tts.internalTriage pattern): internal so the
// session agent can record Tom's spoken verdicts via `npx convex run
// ttsRulings:internalRecordRuling` with deploy credentials — recordRuling
// above requires Tom's browser identity, which the Jarvis Box does not hold. Only
// ever run while Tom is present and ruling; it is his pen, not a policy actor.
export const internalRecordRuling = internalMutation({
  args: {
    todoId: v.optional(v.string()),
    repo: v.optional(v.string()),
    externalId: v.optional(v.string()),
    verdict: VERDICT,
    sentence: v.optional(v.string()),
    unarchiveCondition: v.optional(v.string()),
  },
  handler: async (ctx, { todoId, ...rest }) => {
    let normalized: Id<"todos"> | undefined;
    if (todoId !== undefined) {
      const id = await resolveId(ctx, "todos", todoId);
      if (!id) throw new Error(`Unknown todo id: ${todoId}`);
      normalized = id;
    }
    return await insertRuling(ctx, {
      todoId: normalized,
      ...rest,
    });
  },
});

// ── A ruling from Tom's own words (ruling 15, 2026-09-05) ────────────────────
// The pen behind POST /tts/ruling (http.ts). Tom states a ruling in plain
// language in a session turn; the agent that read the turn decides it IS a
// ruling and calls the route with the turn's claudeInbound id, the verdict,
// the subject, and Tom's sentence verbatim. Ambiguity is the agent's problem,
// never the server's: the server checks provenance, not meaning, and the
// digest quotes every ruling written this way so a misreading is objected.
//
// The checks, in order, each a refusal with its reason in the error:
//   1. the id names a claudeInbound user-turn — one lookup for every path a
//      turn arrives by, because a threaded Slack reply the events route
//      matched to TOM_SLACK_USER_ID is written as a claudeInbound row with
//      author "tom" (ttsSlack.sessionReply), not stored apart; an id that is
//      not an inbound row is refused as unknown;
//   2. the row's author is "tom" — an agent-authored row (the CLI pen, the
//      code-built opener) and a row that predates the author field are refused;
//   3. the sentence is ONE WHOLE UNIT of the row's text (turnSpans below) of
//      at least two words — a substring check with no floor let "ok" pass
//      against almost any turn, which made the pen the agent's. Matching
//      ignores the terminator; the STORED quote is the turn's own substring;
//   4. the subject EXISTS: a todos row or a code todo that
//      is open in the mirror and has a brief — a well-formed id from another
//      table, an unknown repo, or an unmirrored externalId is refused, so no
//      ruling (and no execute-approved run) can name a subject Tom never saw;
//   5. the subject is what the turn's session was ABOUT — the todo or block
//      category on the claudeSessions row
//      (refuseUnlessSessionSubject below). Without this one valid sentence
//      could be replayed against any subject in the record: the dedupe in
//      check 6 is per subject, so "archive the dentist one" ruled a passport
//      todo as readily as the dentist one;
//   6. the same row has not already ruled on the same subject;
//   7. the ruling's own `sentence` is present on revise (the redirect) and
//      absent on every other verdict — the quote is provenance, never the
//      page's return condition or the worker's redirect. The redirect is
//      held to check 3 as well: a whole unit of the same turn (it may be the
//      quote), stored as the turn's own substring, so the line the preparing
//      agent obeys is one Tom said and never one the agent composed;
//   8. only then insertRuling, with provenance {from: "tom-words", inboundId,
//      quote}, through the same apply path every button uses.
//
// approve on a code subject is NOT further gated here: a code todo has no
// readiness field — its brief IS the prepared state (check 4 requires one),
// and what approve triggers (a worker mission admitted by the auto-session
// scheduler) is a PR whose merge is still Tom's own hand.

const SUBJECT_TYPE = v.union(v.literal("life"), v.literal("code"));

// A turn's spans: split at newlines and at a sentence terminator (. ! ?) that
// is followed by whitespace or the end, so "1.5" and "tom.quest" stay whole.
// `unit` is the normalised form (no terminator, trimmed) that matching
// compares on, so "archive it." and "archive it" are the same unit; `source`
// is the exact substring of the turn the unit came from, terminator
// included — the only text ever STORED as Tom's words. One home for the rule.
export function turnSpans(text: string): { unit: string; source: string }[] {
  // The capturing group keeps each separator next to the piece it ended.
  const pieces = text.split(/(\n|[.!?]+(?=\s|$))/);
  const spans: { unit: string; source: string }[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const unit = pieces[i].trim();
    if (unit === "") continue;
    const terminator = pieces[i + 1] ?? "";
    spans.push({
      unit,
      source: (pieces[i] + (terminator === "\n" ? "" : terminator)).trim(),
    });
  }
  return spans;
}

export function turnUnits(text: string): string[] {
  return turnSpans(text).map((s) => s.unit);
}

// The floor under a quote: a single word ("ok", "yes", "archive") is never a
// ruling in Tom's words, whatever turn it sits in.
const MIN_QUOTE_WORDS = 2;

// The span of `turn` that `quoted` is, or the reason it is none. Normalisation
// only LOCATES the span: the caller stores `source`, the turn's own text, so
// "Archive this?" cannot come back as "Archive this!" because the agent
// retyped the terminator.
export function matchQuotedUnit(
  turn: string,
  quoted: string,
): { unit: string; source: string } | { refused: string } {
  const units = turnUnits(quoted);
  if (units.length !== 1) {
    return {
      refused:
        "refused: the sentence must be exactly one sentence or line of the turn",
    };
  }
  const [unit] = units;
  if (unit.split(/\s+/).length < MIN_QUOTE_WORDS) {
    return { refused: "refused: a single word is not a ruling in Tom's words" };
  }
  const span = turnSpans(turn).find((s) => s.unit === unit);
  if (span === undefined) {
    return {
      refused:
        "refused: the sentence is not a whole sentence or line of that turn",
    };
  }
  return span;
}

// A code subject is spelled "<repo> <externalId>" — the tail of subjectKey
// (repo names carry no spaces, so the first space splits it). Every subject
// must resolve to a row that exists (check 4 above).
async function resolveSubject(
  ctx: MutationCtx,
  subjectType: "life" | "code",
  subjectId: string,
): Promise<{
  todoId?: Id<"todos">;
  repo?: string;
  externalId?: string;
}> {
  if (subjectType === "life") {
    const todoId = await resolveId(ctx, "todos", subjectId);
    if (!todoId || !(await ctx.db.get(todoId))) {
      throw new Error(`Unknown todo id: ${subjectId}`);
    }
    return { todoId };
  }
  const cut = subjectId.indexOf(" ");
  if (cut <= 0 || cut === subjectId.length - 1) {
    throw new Error(
      `A code subject is spelled "<repo> <externalId>", got: ${subjectId}`,
    );
  }
  const repo = subjectId.slice(0, cut);
  const externalId = subjectId.slice(cut + 1);
  const mirrored = await ctx.db
    .query("dtsCodeTodoMirror")
    .withIndex("by_repo_external", (q) => q.eq("repo", repo))
    .collect();
  if (mirrored.length === 0) {
    throw new Error(`Unknown repo: ${repo} (no code todos are mirrored from it)`);
  }
  const entry = mirrored.find((r) => r.externalId === externalId);
  if (!entry || entry.status !== "open") {
    throw new Error(`Unknown code todo: ${subjectId} (not open in the mirror)`);
  }
  const brief = await ctx.db
    .query("dtsCodeBriefs")
    .withIndex("by_repo_external", (q) =>
      q.eq("repo", repo).eq("externalId", externalId),
    )
    .unique();
  if (!brief) {
    throw new Error(
      `refused: ${subjectId} has no brief yet, so Tom has not been shown it`,
    );
  }
  return { repo, externalId };
}

// What a session's turns are ABOUT (check 5): the subject its opening prompt
// named, as recorded on the claudeSessions row — its todo; or, for a block
// session, the todos of its
// category (the "code" block works the mirror, so its subjects are code
// todos). An adhoc session names nothing, so none of its turns can rule. A
// Slack reply reaches this door as a turn of the same session
// (ttsSlack.sessionReply), so it is bound the same way. The refusal is its
// own reason, distinct from "unknown subject": the subject exists, Tom was
// just not talking about it in that session.
//
// THE WEEKLY SESSION IS ABOUT WHAT ITS AGENDA NAMES (spec §11; the lifeos
// update, phase 8): the Friday job stores the todo ids its forks
// name on the row (claudeSessions.agendaSubjects), and Tom rules on those
// there by number. A "weekly" session's turns rule on exactly that list —
// not on any todo, and never on code (the agenda is built from the life
// record). A weekly session with no list (one opened from the page) rules on
// nothing.
async function refuseUnlessSessionSubject(
  ctx: MutationCtx,
  session: Doc<"claudeSessions">,
  subjectType: "life" | "code",
  subject: { todoId?: Id<"todos"> },
): Promise<void> {
  let about = false;
  if (session.kind === "weekly") {
    const id = subjectType === "life" ? subject.todoId : undefined;
    about = id !== undefined && (session.agendaSubjects ?? []).includes(id);
  } else if (subjectType === "life" && subject.todoId !== undefined) {
    const todo = await ctx.db.get(subject.todoId);
    about =
      session.todoId === subject.todoId ||
      (session.blockCategory !== undefined &&
        session.blockCategory !== "code" &&
        todo?.category === session.blockCategory);
  } else if (subjectType === "code") {
    about = session.blockCategory === "code";
  }
  if (about) return;
  const named =
    session.kind === "weekly"
      ? `the ${(session.agendaSubjects ?? []).length} subject(s) its agenda names, never code`
      : session.todoId !== undefined
        ? `the todo ${session.todoId}`
        : session.blockCategory !== undefined
          ? `the "${session.blockCategory}" block`
          : "no todo or block";
  throw new Error(
    `refused: that turn is from a session about ${named}, not about this subject — ` +
      "a ruling names only what Tom was talking about",
  );
}

export const internalRecordRulingFromTomWords = internalMutation({
  args: {
    inboundId: v.string(),
    verdict: VERDICT,
    subjectType: SUBJECT_TYPE,
    subjectId: v.string(),
    // Tom's words, verbatim: provenance only. It is never the ruling's
    // `sentence` — on archive that field is shown on the page as the return
    // condition and on revise it is the worker's redirect, and neither is
    // something a quote of Tom's turn should become by accident.
    quote: v.string(),
    // The ruling's own sentence, revise only (the redirect the verdict cannot
    // exist without), and itself one whole sentence or line of the same turn
    // — possibly the quote. Refused on every other verdict: archive does not
    // need a return condition, and approve/session take no note from this
    // door.
    sentence: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { inboundId, verdict, subjectType, subjectId, quote, sentence },
  ) => {
    // 1. the row
    const rowId = ctx.db.normalizeId("claudeInbound", inboundId);
    if (rowId === null && ctx.db.normalizeId("claudeMessages", inboundId) !== null) {
      throw new Error(
        "refused: a claudeMessages row records no author (a turn Tom typed, a task notification and an " +
          "agent's brief are stored alike), so it cannot back a ruling in his words; cite the claudeInbound row",
      );
    }
    const row = rowId === null ? null : await ctx.db.get(rowId);
    if (rowId === null || !row || row.kind !== "user-turn") {
      throw new Error(`Unknown inbound id: ${inboundId}`);
    }
    // 2. Tom wrote it
    if (row.author !== "tom") {
      throw new Error(
        "refused: the turn was not typed by Tom (author is " +
          `${row.author ?? "unset"}), so it cannot be a ruling in his words`,
      );
    }
    // 3. one whole unit of the turn, at least two words. What is stored is
    //    the turn's own text for that unit, never the caller's retyping.
    const quoted = quote.trim();
    if (quoted === "") throw new Error("quote (non-empty string) required");
    const match = matchQuotedUnit(row.text ?? "", quoted);
    if ("refused" in match) throw new Error(match.refused);
    // 4. the subject exists
    const subject = await resolveSubject(ctx, subjectType, subjectId);
    // 5. the subject is what that session was about
    const session = await ctx.db.get(row.sessionId);
    if (!session) throw new Error(`Unknown session id: ${row.sessionId}`);
    await refuseUnlessSessionSubject(ctx, session, subjectType, subject);
    // 6. one ruling per row per subject
    const key = subjectKey({ subjectType, ...subject });
    const prior = await ctx.db
      .query("rulings")
      .withIndex("by_provenance_inboundId", (q) =>
        q.eq("provenance.inboundId", rowId),
      )
      .collect();
    if (prior.some((r) => subjectKey(r) === key)) {
      throw new Error(
        "refused: that turn has already ruled on this subject",
      );
    }
    // 7. the sentence: revise's redirect and nothing else — and, like the
    //    quote, one whole unit of the same turn (it may be the quote itself).
    //    The redirect is what the preparing agent obeys, so an agent-composed
    //    one would be the agent redirecting itself under Tom's name.
    const redirect = sentence?.trim();
    if (verdict === "revise" && !redirect) {
      throw new Error(
        "refused: revise needs a sentence — the one line of that turn that redirects the preparing agent",
      );
    }
    if (verdict !== "revise" && sentence !== undefined) {
      throw new Error(
        `refused: sentence is the revise redirect only; on ${verdict} the quote is the whole record`,
      );
    }
    let redirectSource: string | undefined;
    if (redirect !== undefined) {
      const redirectMatch = matchQuotedUnit(row.text ?? "", redirect);
      if ("refused" in redirectMatch) {
        throw new Error(
          "refused: the redirect must be a whole sentence or line of that turn, in Tom's words — " +
            redirectMatch.refused.replace(/^refused: /, ""),
        );
      }
      redirectSource = redirectMatch.source;
    }
    // 8. the ruling, through the one apply path. No unarchiveCondition: an
    // archive from this door leaves the return condition unset (the quote is
    // in provenance and the digest), it never becomes what the page shows.
    return await insertRuling(ctx, {
      ...subject,
      verdict,
      sentence: redirectSource,
      provenance: { from: "tom-words", inboundId: rowId, quote: match.source },
    });
  },
});

// ── Internal: worker paths (key-authed http.ts routes) ───────────────────────

/** Newest ruling per subject, from a full collect. */
export function liveRulings(
  all: Doc<"rulings">[],
): Map<string, Doc<"rulings">> {
  const newest = new Map<string, Doc<"rulings">>();
  for (const row of all) {
    const key = subjectKey(row);
    const prior = newest.get(key);
    // ruledAt wins; _creationTime breaks same-millisecond ties.
    if (
      !prior ||
      row.ruledAt > prior.ruledAt ||
      (row.ruledAt === prior.ruledAt && row._creationTime > prior._creationTime)
    ) {
      newest.set(key, row);
    }
  }
  return newest;
}

/**
 * A "session" verdict is applied the moment its session exists. Called by
 * claudeSessions.createSession so the supersession rule stays defined HERE
 * (one implementation), not inlined at the session layer.
 */
export async function markLiveSessionRulingApplied(
  ctx: MutationCtx,
  todoId: Id<"todos">,
  sessionId: string,
): Promise<void> {
  const rulings = await ctx.db
    .query("rulings")
    .withIndex("by_todo", (q) => q.eq("todoId", todoId))
    .collect();
  const live = liveRulings(rulings).get(
    subjectKey({ subjectType: "life", todoId }),
  );
  if (live && live.verdict === "session" && live.appliedAt === undefined) {
    await ctx.db.patch(live._id, {
      appliedAt: Date.now(),
      applyResult: `session ${sessionId}`,
    });
  }
}

/**
 * A "session" verdict on a CODE subject is applied the moment Tom opens an
 * interactive session on the code block — the one kind of session whose turns
 * are about code todos (refuseUnlessSessionSubject above reads a "code" block
 * session that way). The twin of markLiveSessionRulingApplied, in two halves
 * so the session's prompt can NAME what it consumes: liveCodeSessionRulings
 * is the set (every live, unapplied code session ruling, oldest first — the
 * block holds them all), and markCodeSessionRulingsApplied stamps exactly
 * the rows it is handed. claudeSessions.insertSession reads the set, writes
 * each subject and Tom's sentence into the opener, then marks that same set
 * — a verdict is never consumed without its conversation reaching the
 * session, and never named without being consumed.
 */
export async function liveCodeSessionRulings(
  ctx: MutationCtx,
): Promise<Doc<"rulings">[]> {
  const all = await ctx.db.query("rulings").collect();
  return [...liveRulings(all).values()]
    .filter(
      (live) =>
        live.subjectType === "code" &&
        live.verdict === "session" &&
        live.appliedAt === undefined,
    )
    .sort((a, b) => a.ruledAt - b.ruledAt);
}

export async function markCodeSessionRulingsApplied(
  ctx: MutationCtx,
  rulings: readonly Doc<"rulings">[],
  sessionId: string,
): Promise<void> {
  for (const ruling of rulings) {
    await ctx.db.patch(ruling._id, {
      appliedAt: Date.now(),
      applyResult: `session ${sessionId}`,
    });
  }
}

// The rulings a box job should act on: appliedAt unset AND not superseded
// (a newer ruling on the same subject makes the older one dead history). Every
// subject type rides the same feed — the planner filters by kind (a life
// revise → its prepare pass) and consumes only what it served. Code approve and archive
// rulings ride it too, for the box's work-queue job.
export const internalPendingRulings = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("rulings").collect();
    const newest = liveRulings(all);
    return all.filter(
      (row) =>
        row.appliedAt === undefined &&
        newest.get(subjectKey(row))?._id === row._id,
    );
  },
});

// Apply callback: the worker reports what it did (commit sha / PR url) or how
// it failed (error text) — either way the ruling is consumed (appliedAt set),
// with the outcome on record in applyResult.
export const internalMarkRulingApplied = internalMutation({
  args: { id: v.string(), result: v.string() },
  handler: async (ctx, { id, result }) => {
    // The worker sends plain strings over HTTP; normalizeId is the proper
    // reject-with-a-name path for malformed/wrong-table ids.
    const normalized = await resolveId(ctx, "rulings", id);
    if (!normalized) throw new Error(`Unknown ruling id: ${id}`);
    const ruling = await ctx.db.get(normalized);
    if (!ruling) throw new Error(`Unknown ruling id: ${id}`);
    await ctx.db.patch(normalized, { appliedAt: Date.now(), applyResult: result });
    await logEvent(ctx, "ruling-applied", todoRef(ruling.todoId), {
      verdict: ruling.verdict,
      repo: ruling.repo,
      externalId: ruling.externalId,
      result,
    });
  },
});

// Digest input: how many briefed code todos await a ruling. A brief awaits
// when its live ruling is missing OR NOT NEWER than the brief — a re-brief
// after a revise ruling puts the item back on Tom's plate (the fresh plan
// needs a fresh ruling). The client-side needs-me selector (app/tts/lib.ts)
// mirrors this predicate.
//
// THE TIE IS DELIBERATE — DO NOT TIGHTEN `<=` BACK TO `<`. ruledAt (set at
// :236) and preparedAt (set in ttsCode.ts internalStoreBriefs) are both
// whole-millisecond Date.now() values written by two different mutations, so
// a ruling and a re-brief CAN carry the same number. A strict `<` reads that
// tie as "the ruling answers the brief" and silently drops a genuinely
// re-briefed item off Tom's pile with nothing to put it back; `<=` reads it
// as "still awaiting", whose worst case is one extra look at an item Tom just
// ruled. Same reasoning as liveRulings above, which breaks its own
// same-millisecond tie on _creationTime rather than pretending ties cannot
// happen.
export function briefAwaitsRuling(
  brief: { repo: string; externalId: string; preparedAt: number },
  live: Map<string, Doc<"rulings">>,
): boolean {
  const ruling = live.get(
    subjectKey({
      subjectType: "code",
      repo: brief.repo,
      externalId: brief.externalId,
    }),
  );
  return ruling === undefined || ruling.ruledAt <= brief.preparedAt;
}

// Planner context (GET /tts/planner-context): what Tom ruled lately, newest
// first — a signal, not a work feed (that is internalPendingRulings).
export const internalRecentRulings = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // The planner reads these as Tom's recent rulings on its todos.
    return await ctx.db
      .query("rulings")
      .withIndex("by_ruled")
      .order("desc")
      .take(Math.min(limit ?? 200, 1000));
  },
});

export const internalAwaitingRulingCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const briefs = await ctx.db.query("dtsCodeBriefs").collect();
    const live = liveRulings(await ctx.db.query("rulings").collect());
    return briefs.filter((b) => briefAwaitsRuling(b, live)).length;
  },
});

// The one-time copy of dtsCodeRulings into this table (run at deploy,
// `npx convex run ttsRulings:internalMigrateCodeRulings`) is gone with the
// table it read (the lifeos update, phase 7). It had run, its "defer" rows
// were deliberately not copied — defer is no longer a verdict; not ruling IS
// deferring — and WikiTom tts/snapshot holds every row of the old table, so
// the defer history it alone carried is readable there. The rows themselves
// persist on the deployment as an undeclared table; nothing was deleted.
