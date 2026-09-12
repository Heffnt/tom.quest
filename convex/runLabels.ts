// runLabels.ts — everywhere Tom's judgment enters becomes a row about a run.
//
// A LABEL is one act of Tom's about one run's output: a ruling on the todo a
// prepare pass wrote, an objection in #tts-decisions to a decision the delegate
// took, a reply he typed at a session, an emoji on the morning digest. Four
// doors, all of them already built and none of them writing anything until
// this file existed — `runLabels` had no writer and no row, which is why the
// run page's label strip was deferred and why the evals layer could only mine
// the WikiTom nightly snapshot for its golden set.
//
// ONE WRITER, ONE RESOLVER, FOUR CALLERS. The callers differ only in where
// they find the run and what the act meant; everything else — idempotency, the
// refusal of a non-Tom actor, the shape of the row — is decided once here.
//
// WHAT A LABEL IS FOR. A judgment label becomes an eval case: the run's
// assembled prompt is replayed against the tree under test and a judge scores
// the new output against Tom's own sentence (scripts/export-golden.mjs
// --source labels, worker/jobs/evals.mjs's `run` job). That is why the rules
// below are strict about what may enter: an unreviewed verdict in this table
// becomes an unreviewed verdict in the corpus every future merge is scored
// against, and nothing downstream can tell it apart from one of his.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { logEvent } from "./tts";
import { DELEGATE_DECISION } from "./ttsAsk";
import { MERGE } from "./ttsMerge";
import { DIGEST_SENT } from "./ttsDigest";
import { DIGEST_OBJECTION_LOOKBACK } from "./ttsAsk";

/** The four doors, in the schema's own words. */
export const LABEL_SOURCE = v.union(
  v.literal("ruling"),
  v.literal("objection"),
  v.literal("session-reply"),
  v.literal("digest-reaction"),
);

export const LABEL_POLARITY = v.union(
  v.literal("good"),
  v.literal("bad"),
  v.literal("mixed"),
  v.literal("neutral"),
);

/** An act that named no run. Counted, never silent: silence would make an old
 *  corpus look like a clean one, and a counted absence is a fact the weekly
 *  gather can report and a later backlog import can repair. */
export const RUN_LABEL_UNLINKED = "run-label-unlinked";
/** An emoji nobody mapped. It says what Tom reaches for, which is worth
 *  having; guessing its polarity would put an invented judgment in the
 *  corpus. */
export const REACTION_UNMAPPED = "reaction-unmapped";

/** A session reply is trimmed to this many characters for `meaning`. The full
 *  text is in the transcript row the span names, so nothing is lost. */
export const MEANING_MAX_CHARS = 300;

/**
 * THE EMOJI SET, small and unambiguous, defined once.
 *
 * Anything not here writes a `reaction-unmapped` event and NO label. The set
 * grows by a ruling of Tom's, never by a model's reading of what an emoji
 * probably meant.
 */
export const REACTION_POLARITY: Record<string, { polarity: "good" | "bad" | "neutral"; judgment: boolean }> = {
  "+1": { polarity: "good", judgment: true },
  white_check_mark: { polarity: "good", judgment: true },
  heavy_check_mark: { polarity: "good", judgment: true },
  tada: { polarity: "good", judgment: true },
  "-1": { polarity: "bad", judgment: true },
  x: { polarity: "bad", judgment: true },
  heavy_multiplication_x: { polarity: "bad", judgment: true },
  confused: { polarity: "bad", judgment: true },
  eyes: { polarity: "neutral", judgment: false },
};

/** Slack delivers a skin-toned emoji as `+1::skin-tone-3`; the base name is
 *  the one that was tapped. */
export function baseEmoji(name: string): string {
  return String(name ?? "").split("::")[0];
}

/**
 * `meaning` is plain present-tense text with no id, date, quote mark or
 * citation in it — the two-records rule, applied here because this string is
 * read on the run page and becomes an eval case's rubric. The ids live in
 * `ref` and in the row's own fields.
 *
 * Returns the fault, or null. It is checked and not silently rewritten: a
 * sentence of Tom's that breaks the rule is his sentence, and the right answer
 * is to keep it and say the rule was broken rather than to edit his words.
 */
export function meaningFault(meaning: string): string | null {
  const text = String(meaning ?? "");
  if (text.trim() === "") return "meaning is empty";
  if (/["“”‘’]/.test(text)) return "meaning carries a quote mark";
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) return "meaning carries a date";
  return null;
}

/**
 * The run that wrote this row, or null.
 *
 * NULL IS THE ANSWER for anything written before runs were registered, and for
 * anything the plain template wrote. There is no fallback and there is
 * deliberately no second attempt: a time-window search over `runs` by subject
 * would be wrong on the ORDINARY case — a prepare pass, a repair pass and a
 * planner pass can all touch one todo in an hour with the same todoId, and only
 * one of them wrote the text Tom read — and a wrong edge poisons the eval
 * corpus silently, which is worse than a missing one.
 */
export async function runForToken(
  ctx: MutationCtx,
  token: string | undefined | null,
): Promise<Doc<"runs"> | null> {
  if (typeof token !== "string" || token === "") return null;
  return await ctx.db
    .query("runs")
    .withIndex("by_reg_token", (q) => q.eq("regToken", token))
    .first();
}

/** The span a judgment about a run's FINAL OUTPUT covers: the one row that
 *  carried it. Absent when the run recorded no final text — never {0, 0},
 *  which would read as "the whole run". */
function finalSpan(run: Doc<"runs">): { seqStart: number; seqEnd: number } | undefined {
  const seq = run.outcome?.finalTextSeq;
  return typeof seq === "number" ? { seqStart: seq, seqEnd: seq } : undefined;
}

/** One act that could not be linked to a run. */
async function unlinked(
  ctx: MutationCtx,
  what: { source: string; ref: string; subjectKey: string | null; why: string },
) {
  await logEvent(ctx, RUN_LABEL_UNLINKED, undefined, what);
}

/**
 * THE ONE WRITER. Idempotent on `ref`.
 *
 * `actor` is always "tom" and any other value is refused. A label is what TOM
 * did about a run's output; an agent writing a label about another agent's
 * output would put an unreviewed verdict into the corpus the golden set is
 * mined from, which is the one thing the evals layer exists to avoid. If a
 * non-Tom actor is ever wanted it is a ruling of his, not a widening of this
 * argument.
 */
export const internalWriteLabel = internalMutation({
  args: {
    runId: v.string(),
    rowSpan: v.optional(v.object({ seqStart: v.number(), seqEnd: v.number() })),
    source: LABEL_SOURCE,
    actor: v.string(),
    polarity: LABEL_POLARITY,
    meaning: v.string(),
    judgment: v.boolean(),
    ref: v.string(),
    at: v.number(),
  },
  handler: async (ctx, args) => await writeLabel(ctx, args),
});

export type LabelInput = {
  runId: string;
  rowSpan?: { seqStart: number; seqEnd: number };
  source: "ruling" | "objection" | "session-reply" | "digest-reaction";
  actor: string;
  polarity: "good" | "bad" | "mixed" | "neutral";
  meaning: string;
  judgment: boolean;
  ref: string;
  at: number;
};

/** The body both the mutation above and the in-process callers below go
 *  through, so a label written by a scheduler and a label written by a test
 *  cannot take different rules. */
export async function writeLabel(
  ctx: MutationCtx,
  args: LabelInput,
): Promise<{ id: Id<"runLabels">; existing: boolean }> {
  if (args.actor !== "tom") {
    throw new Error("a label records what Tom did; actor must be \"tom\"");
  }
  if (args.ref.trim() === "") throw new Error("a label needs the ref of the act behind it");
  const fault = meaningFault(args.meaning);
  if (fault !== null) throw new Error(fault);
  // Slack delivers at least once and two doors can write one ruling, so the
  // act's own key is the idempotency key.
  const existing = await ctx.db
    .query("runLabels")
    .withIndex("by_ref", (q) => q.eq("ref", args.ref))
    .first();
  if (existing !== null) return { id: existing._id, existing: true };
  const id = await ctx.db.insert("runLabels", {
    runId: args.runId,
    ...(args.rowSpan === undefined ? {} : { rowSpan: args.rowSpan }),
    source: args.source,
    actor: "tom",
    polarity: args.polarity,
    meaning: args.meaning,
    judgment: args.judgment,
    ref: args.ref,
    at: args.at,
  });
  return { id, existing: false };
}

// ── Writer one: a ruling ────────────────────────────────────────────────────

/**
 * The four verdicts, and what each one says about the TEXT.
 *
 * `session` and `archive` are recorded and are NOT judgments. They are
 * recorded because the run page should show everything Tom did about a run;
 * they are not judgments because neither says the text was good or bad — a
 * session verdict says "let us talk", an archive says "not now". Only a
 * judgment label becomes an eval case, so neither enters the corpus.
 */
export function labelForVerdict(
  verdict: string,
  sentence: string | undefined,
): { polarity: "good" | "bad" | "neutral"; judgment: boolean; meaning: string } | null {
  const said = typeof sentence === "string" && sentence.trim() !== "" ? sentence.trim() : null;
  switch (verdict) {
    case "approve":
      return { polarity: "good", judgment: true, meaning: said ?? "Tom approved this output" };
    case "revise":
      // insertRuling requires the sentence on a revise, so the fallback is a
      // guard and not an expected path.
      return { polarity: "bad", judgment: true, meaning: said ?? "Tom sent this output back" };
    case "session":
      return { polarity: "neutral", judgment: false, meaning: "Tom wants to talk about this before it goes further" };
    case "archive":
      return { polarity: "neutral", judgment: false, meaning: "Tom archived the subject" };
    default:
      return null;
  }
}

/** The row a ruling's subject names, and the token that row carries. */
async function tokenForRulingSubject(
  ctx: MutationCtx,
  ruling: Doc<"dtsRulings">,
): Promise<string | undefined> {
  if (ruling.subjectType === "life" && ruling.todoId !== undefined) {
    return (await ctx.db.get(ruling.todoId))?.producedByRunToken;
  }
  if (ruling.subjectType === "batch" && ruling.batchId !== undefined) {
    return (await ctx.db.get(ruling.batchId))?.producedByRunToken;
  }
  if (ruling.subjectType === "code" && ruling.repo !== undefined && ruling.externalId !== undefined) {
    const brief = await ctx.db
      .query("dtsCodeBriefs")
      .withIndex("by_repo_external", (q) =>
        q.eq("repo", ruling.repo as string).eq("externalId", ruling.externalId as string),
      )
      .first();
    return brief?.producedByRunToken;
  }
  return undefined;
}

/** The subject's identity, in the one spelling ttsRulings.subjectKey defines.
 *  Duplicated as a local read rather than imported to keep this file free of a
 *  cycle through ttsRulings, which schedules into it. */
function subjectKeyOf(ruling: Doc<"dtsRulings">): string {
  if (ruling.subjectType === "life") return `life ${ruling.todoId}`;
  if (ruling.subjectType === "batch") return `batch ${ruling.batchId}`;
  return `code ${ruling.repo} ${ruling.externalId}`;
}

export const internalLabelFromRuling = internalMutation({
  args: { rulingId: v.id("dtsRulings") },
  handler: async (ctx, { rulingId }) => {
    const ruling = await ctx.db.get(rulingId);
    if (ruling === null) return { wrote: false, why: "no ruling" };
    const label = labelForVerdict(ruling.verdict, ruling.sentence);
    if (label === null) return { wrote: false, why: `unknown verdict ${ruling.verdict}` };
    const ref = `ruling:${rulingId}`;
    const run = await runForToken(ctx, await tokenForRulingSubject(ctx, ruling));
    if (run === null) {
      await unlinked(ctx, {
        source: "ruling",
        ref,
        subjectKey: subjectKeyOf(ruling),
        why: "the subject row carries no producedByRunToken, or no run claimed it",
      });
      return { wrote: false, why: "unlinked" };
    }
    const written = await writeLabel(ctx, {
      runId: run.runId,
      ...(finalSpan(run) === undefined ? {} : { rowSpan: finalSpan(run) }),
      source: "ruling",
      actor: "tom",
      polarity: label.polarity,
      meaning: label.meaning,
      judgment: label.judgment,
      ref,
      at: ruling.ruledAt,
    });
    return { wrote: !written.existing, id: written.id, runId: run.runId };
  },
});

// ── Writer two: an objection in #tts-decisions ──────────────────────────────

/**
 * `revert` and a redirect sentence are BOTH "bad".
 *
 * The distinction is what to do next, and it belongs in `meaning`; the
 * polarity answers only "did the output land", and neither form says it did.
 */
export const internalLabelFromObjection = internalMutation({
  args: { eventId: v.id("dtsEvents"), askId: v.string() },
  handler: async (ctx, { eventId, askId }) => {
    const objection = await ctx.db.get(eventId);
    if (objection === null) return { wrote: false, why: "no objection row" };
    const data = (objection.data ?? {}) as { revert?: unknown; sentence?: unknown };
    // The same two rows internalRecordDelegateObjection resolved: a delegate
    // decision keyed by its askId, or a merge keyed by its own <repo>:<sha>.
    const subject =
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", MERGE).eq("key", askId))
        .first());
    const ref = `objection:${eventId}`;
    const token = (subject?.data as { runToken?: unknown } | undefined)?.runToken;
    const run = await runForToken(ctx, typeof token === "string" ? token : undefined);
    if (run === null) {
      await unlinked(ctx, {
        source: "objection",
        ref,
        subjectKey: askId,
        why: subject === null
          ? "no decision or merge row carries this askId"
          : "the decision row carries no runToken, or no run claimed it",
      });
      return { wrote: false, why: "unlinked" };
    }
    const sentence = typeof data.sentence === "string" && data.sentence.trim() !== ""
      ? data.sentence.trim()
      : null;
    const written = await writeLabel(ctx, {
      runId: run.runId,
      ...(finalSpan(run) === undefined ? {} : { rowSpan: finalSpan(run) }),
      source: "objection",
      actor: "tom",
      polarity: "bad",
      meaning: sentence ?? "Tom reverted this decision",
      judgment: true,
      ref,
      at: objection.at,
    });
    return { wrote: !written.existing, id: written.id, runId: run.runId };
  },
});

// ── Writer three: a reply in a session ──────────────────────────────────────

/**
 * EVERY SESSION-REPLY LABEL IS `judgment: false`, and phase 7 builds no
 * classifier.
 *
 * A reply is not a judgment until something classifies it as one. A Haiku pass
 * here would put a model's opinion of Tom's tone into the corpus the golden
 * set is mined from, and a wrong one would be invisible — a session reply is
 * the highest-volume door of the four, so a classifier that is wrong one time
 * in twenty poisons the set faster than the rulings fill it. Record the
 * labels, show them on the run page, and leave the classifier to a phase with
 * its own evals. The one line it will take when it exists: a pass over
 * by_source_at("session-reply") that patches `judgment` and `polarity` and
 * writes its own `ref` suffix, so a reclassification is visible rather than a
 * silent rewrite of what he said.
 *
 * The run is found by `sessionId` and no token is needed: a session IS a run
 * Tom talks to, and the link is the field itself.
 */
export const internalLabelFromSessionReply = internalMutation({
  args: {
    sessionId: v.id("claudeSessions"),
    seq: v.number(),
    text: v.string(),
    at: v.number(),
    priorAssistantSeq: v.optional(v.number()),
  },
  handler: async (ctx, { sessionId, seq, text, at, priorAssistantSeq }) => {
    const ref = `reply:${sessionId}:${seq}`;
    const said = text.trim();
    if (said === "") return { wrote: false, why: "empty reply" };
    // The newest run of this session that had started when he typed. A session
    // can be reopened, and a reply belongs to the conversation it landed in.
    const run = (await ctx.db
      .query("runs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect())
      .filter((one) => one.startedAt <= at)
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    if (run === null) {
      await unlinked(ctx, {
        source: "session-reply",
        ref,
        subjectKey: `session ${sessionId}`,
        why: "no run of this session had started when the reply landed",
      });
      return { wrote: false, why: "unlinked" };
    }
    // The span the reply is ABOUT: from the assistant row it answers to the
    // reply's own row. With no prior assistant row there is nothing to point
    // at, and the label carries no span rather than a span starting at zero.
    const rowSpan = typeof priorAssistantSeq === "number"
      ? { seqStart: priorAssistantSeq, seqEnd: seq }
      : undefined;
    // His words, clipped, with no ellipsis games — the full text is in the
    // transcript row the span names. A quote mark or a date in what he typed
    // is his, so the meaning rule is satisfied by stripping the characters the
    // rule forbids rather than by refusing to record that he spoke.
    const meaning = plainMeaning(said).slice(0, MEANING_MAX_CHARS).trim();
    if (meaning === "") return { wrote: false, why: "reply had no plain text" };
    const written = await writeLabel(ctx, {
      runId: run.runId,
      ...(rowSpan === undefined ? {} : { rowSpan }),
      source: "session-reply",
      actor: "tom",
      polarity: "neutral",
      meaning,
      judgment: false,
      ref,
      at,
    });
    return { wrote: !written.existing, id: written.id, runId: run.runId };
  },
});

/**
 * Text of his made safe for `meaning` WITHOUT changing what he said: the
 * quote marks the rule forbids become nothing and a bare date becomes the word
 * "a date". Used only where the text is Tom's own typing — a ruling's sentence
 * is kept verbatim, because that sentence becomes an eval case's rubric and
 * the rubric must be his words exactly.
 */
export function plainMeaning(text: string): string {
  return String(text ?? "")
    .replace(/[“”‘’]/g, "")
    .replace(/["']/g, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "a date")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Writer four: a reaction on the digest ───────────────────────────────────

export const internalLabelFromReaction = internalMutation({
  args: {
    channel: v.string(),
    ts: v.string(),
    emoji: v.string(),
    at: v.number(),
    removed: v.boolean(),
  },
  handler: async (ctx, { channel, ts, emoji, at, removed }) => {
    const name = baseEmoji(emoji);
    const ref = `reaction:${channel}:${ts}:${name}`;
    // A REMOVED REACTION DELETES ITS OWN LABEL, at exactly this ref. An emoji
    // tapped by accident must not become an eval case forever, and by_ref
    // makes the delete a point lookup.
    if (removed) {
      const existing = await ctx.db
        .query("runLabels")
        .withIndex("by_ref", (q) => q.eq("ref", ref))
        .first();
      if (existing !== null) await ctx.db.delete(existing._id);
      return { removed: existing !== null };
    }
    // The digest this reaction sat on. Its rows carry NO key by construction
    // (ttsDigest.lastDigestSent depends on that), so this is the same bounded
    // newest-first take namedObjection uses, and for the same reason: Slack's
    // three-second budget.
    const recent = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", DIGEST_SENT))
      .order("desc")
      .take(DIGEST_OBJECTION_LOOKBACK);
    const sent = recent.find(
      (row) => (row.data as { slackTs?: unknown } | undefined)?.slackTs === ts,
    );
    if (sent === undefined) return { wrote: false, why: "no digest was sent at that ts" };
    const mapped = REACTION_POLARITY[name];
    if (mapped === undefined) {
      await logEvent(ctx, REACTION_UNMAPPED, undefined, { emoji: name, channel, ts, at });
      return { wrote: false, why: "unmapped emoji" };
    }
    const data = (sent.data ?? {}) as { runToken?: unknown; writtenBy?: unknown; day?: unknown };
    const run = await runForToken(ctx, typeof data.runToken === "string" ? data.runToken : undefined);
    if (run === null) {
      // A morning the model path timed out has writtenBy "template" and no
      // token. A reaction on it writes no label, and that is RIGHT: the plain
      // template is not a run's output, and scoring the model on it would be a
      // lie in the corpus.
      await unlinked(ctx, {
        source: "digest-reaction",
        ref,
        subjectKey: typeof data.day === "string" ? `digest:${data.day}` : null,
        why: data.writtenBy === "template"
          ? "the morning was written by the plain template, which is not a run's output"
          : "the digest-sent row carries no runToken, or no run claimed it",
      });
      return { wrote: false, why: "unlinked" };
    }
    const written = await writeLabel(ctx, {
      runId: run.runId,
      ...(finalSpan(run) === undefined ? {} : { rowSpan: finalSpan(run) }),
      source: "digest-reaction",
      actor: "tom",
      polarity: mapped.polarity,
      meaning: `Tom reacted with ${name} to the morning digest`,
      judgment: mapped.judgment,
      ref,
      at,
    });
    return { wrote: !written.existing, id: written.id, runId: run.runId };
  },
});
