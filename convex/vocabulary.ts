// THE VOCABULARY SURFACE'S READ, and the door the nightly's graph step posts
// the generator's render through.
//
// WHY THE RECORD AND NOT THE FILE. Jarvis's `scripts/vocabulary.mjs` renders the whole
// vocabulary out of WikiTom `tts/spec.md` §12.1 and tom.quest's own constants,
// and writes WikiTom `tts/vocabulary.json` only when the two agree about every
// word. They do not agree today, so it renders, reports its disagreements and
// writes nothing — which means the file the page would read does not exist, and
// will not exist until the disagreements are settled. The render itself is the
// only current statement of the vocabulary, so the night posts the render here
// whether or not it wrote the file, and the page reads the record.
//
// That is also what puts the disagreements in front of Tom: each is one ruling
// of his, and settling them is what makes `tts/vocabulary.json` exist.
//
// The gate is `requireTom`, like every other surface of his.
//
// THE PROMPT READS THE SAME ROW. The six words a worker's prompt carries are
// defined once, in the spec's §12.1 (Tom, 2026-09-24: one wording, in the spec,
// with the prompt constant rendered from it). The night posts those entries
// here with every other word, and `closedVocabularyFrom` below renders the
// prompt's vocabulary block from them when the prompt is read — so the page
// Tom reads and the prompt a worker reads are one set of entries.

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireTom } from "./authRoles";
import { TTS_CLOSED_VOCABULARY, VOCABULARY_COUNTS } from "./ttsShared";
import { closedVocabularyOpening, renderClosedVocabulary } from "../scripts/closed-vocabulary.mjs";

const SURFACE = "Vocabulary";

/** The most words one post may carry. A hundred and seventeen today; a post
 *  past this is a generator that has started minting words. */
export const VOCABULARY_TERMS_MAX = 1000;

/**
 * The render, replaced whole.
 *
 * REMOVAL CHECK on the validation below: it cannot be deleted in favour of the
 * door's own checks in convex/http.ts, nor the other way round. This mutation
 * is what makes the store's invariants true for EVERY caller — the validators
 * express neither "no word twice" nor "newer than what is stored" — while the
 * HTTP checks are what turn a publisher's malformed post into a 400 naming the
 * field, rather than a thrown mutation the job can only report as a failure.
 */
export const internalReplaceVocabulary = internalMutation({
  args: {
    version: v.string(),
    commit: v.string(),
    committedAt: v.number(),
    generatedAt: v.number(),
    wrote: v.boolean(),
    section: v.optional(v.string()),
    counts: v.optional(VOCABULARY_COUNTS),
    tomQuestCommit: v.optional(v.string()),
    terms: v.array(v.object({
      term: v.string(),
      kind: v.string(),
      definition: v.string(),
      specSection: v.optional(v.string()),
      codeSymbol: v.optional(v.string()),
      related: v.array(v.string()),
      refusedFor: v.optional(v.string()),
    })),
    disagreements: v.array(v.object({
      code: v.string(),
      subject: v.string(),
      fix: v.string(),
      rows: v.array(v.object({ label: v.string(), where: v.string(), text: v.string() })),
    })),
  },
  handler: async (ctx, args) => {
    if (args.version.trim() === "") throw new Error("version is required");
    if (args.commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(args.committedAt)) throw new Error("committedAt must be finite");
    if (!Number.isFinite(args.generatedAt)) throw new Error("generatedAt must be finite");
    if (args.terms.length === 0) throw new Error("no terms posted — store left as it was");
    if (args.terms.length > VOCABULARY_TERMS_MAX) {
      throw new Error(`at most ${VOCABULARY_TERMS_MAX} terms per post — got ${args.terms.length}`);
    }
    const seen = new Set<string>();
    for (const term of args.terms) {
      if (term.term.trim() === "") throw new Error("a term's word is required");
      if (seen.has(term.term)) throw new Error(`term posted twice: ${term.term}`);
      seen.add(term.term);
    }
    // NEWER OR NOTHING, the rule the model-of-tom door already keeps: a rerun
    // of an older checkout must not roll the page back to a render nobody made
    // tonight. Equal generations replace, because a regenerated night at the
    // same commit is the same render.
    const current = await ctx.db.query("ttsVocabulary")
      .withIndex("by_key", (q) => q.eq("key", "current")).unique();
    if (current !== null && args.generatedAt < current.generatedAt) {
      throw new Error(
        `the post was generated at ${new Date(args.generatedAt).toISOString()}, older than the stored render`
          + ` (${new Date(current.generatedAt).toISOString()}) — store left as it was`,
      );
    }
    const row = { key: "current" as const, ...args };
    if (current === null) await ctx.db.insert("ttsVocabulary", row);
    else await ctx.db.replace("ttsVocabulary", current._id, row);
    return { terms: args.terms.length, disagreements: args.disagreements.length };
  },
});

/**
 * The vocabulary as the last night rendered it. Null until a night has posted
 * one: this store fails closed the way the model-of-tom publication does, and
 * there is no door that fills it by hand.
 */
export const current = query({
  args: {},
  handler: async (ctx): Promise<Doc<"ttsVocabulary"> | null> => {
    await requireTom(ctx, SURFACE);
    return await ctx.db.query("ttsVocabulary")
      .withIndex("by_key", (q) => q.eq("key", "current")).unique();
  },
});

/**
 * The prompt's vocabulary block, rendered from the posted §12.1 entries through
 * the one renderer scripts/vocabulary.mjs also uses, with the opening line the
 * constant carries.
 *
 * REMOVAL CHECK on the fallback to TTS_CLOSED_VOCABULARY: it cannot be deleted.
 * A night that cannot read the spec posts nothing, and a record that has never
 * held a vocabulary — a fresh deployment, a test — holds none; with no fallback
 * every run that carries this block would lose it, which is the same reason the
 * base and the skills catalog reach a prompt by two doors. The fallback is not
 * a second wording: scripts/vocabulary.mjs renders it from the spec through
 * this same function and writes it into the generated block.
 */
export function closedVocabularyFrom(
  row: { terms: { term: string; definition: string }[] } | null,
): string {
  if (row === null) return TTS_CLOSED_VOCABULARY;
  // A posted term with kind "refused" is a word §12.1 declines, never one of
  // the six, so the rows go to the renderer as they are.
  return renderClosedVocabulary(closedVocabularyOpening(TTS_CLOSED_VOCABULARY), row.terms)
    ?? TTS_CLOSED_VOCABULARY;
}

/** The prompt's vocabulary block as the last posted night defines it. Internal:
 *  the box reads it through `/tts/planner-context`, never as a public query. */
export const internalClosedVocabulary = internalQuery({
  args: {},
  handler: async (ctx): Promise<string> => {
    const row = await ctx.db.query("ttsVocabulary")
      .withIndex("by_key", (q) => q.eq("key", "current")).unique();
    return closedVocabularyFrom(row);
  },
});
