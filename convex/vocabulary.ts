// THE VOCABULARY SURFACE'S READ, and the door the nightly's graph step posts
// the generator's render through.
//
// WHY THE RECORD AND NOT THE FILE. `scripts/vocabulary.mjs` renders the whole
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

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireTom } from "./authRoles";

const SURFACE = "Vocabulary";

/** The most words one post may carry. A hundred and seventeen today; a post
 *  past this is a generator that has started minting words. */
export const VOCABULARY_TERMS_MAX = 1000;

export const internalReplaceVocabulary = internalMutation({
  args: {
    version: v.string(),
    commit: v.string(),
    committedAt: v.number(),
    generatedAt: v.number(),
    wrote: v.boolean(),
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
