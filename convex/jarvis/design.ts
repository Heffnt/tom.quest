// design.ts — tom.quest/design's reads of the record.
//
// THE PAGE DRAWS THE REGISTRY THE BOX DEPLOYED. The registry is Jarvis
// worker/parts.json, one row per part; the box's deploy job posts it as one
// `registry` event per deployed commit (shared/jarvis-events.mjs), and the
// newest such row is the running system. Nothing here stores a copy: every
// answer is computed from rows on each read.
//
//   diff   what a Jarvis head does to the registry: the `registryDiff` the
//          box posts on the head's tests row, and the base registry it
//          applies to (the registry at the diff's base commit, else the
//          newest one, and the answer says which).
//
// The page's own query, one part's panel, and Tom's two writes on it read
// rows that tom.quest #343 (the use state) and #344 (the standing ruling)
// add, and land with the page after those.
//
// A STORED REGISTRY ROW IS A CHECKED ONE: POST /jarvis/event, the one route
// that writes the type, runs shared/jarvis-events.mjs validateEvent on it,
// and POST /tts/event refuses it (JARVIS_EVENT_ONLY_KINDS).
//
// THE GATE IS requireTom, label "Design".

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireTom } from "../authRoles";
import { commitKey } from "../ttsShared";
import { TESTS_RUN } from "../ttsMerge";
import { registryDiffOf } from "../../shared/jarvis-events.mjs";

const SURFACE = "Design";
const REGISTRY = "registry";

/** One registry row, in the fields the record reads. */
type RegistryRow = { id: string; name: string; type: string; fate: { type: string; by: string | null }; [field: string]: unknown };

type RegistryData = { repo: string; sha: string; parts: RegistryRow[]; count: number };

async function newestRegistry(ctx: QueryCtx): Promise<Doc<"events"> | null> {
  return await ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", REGISTRY)).order("desc").first();
}

const registryOf = (row: Doc<"events">) => {
  const data = row.data as RegistryData;
  return { id: row._id, subject: row.subject ?? "", sha: data.sha, at: row.at, parts: data.parts };
};

export const diff = query({
  args: { head: v.string() },
  handler: async (ctx, { head }) => {
    await requireTom(ctx, SURFACE);
    const at = head.indexOf("@");
    if (at <= 0) return null;
    const key = commitKey(head.slice(0, at), head.slice(at + 1));
    // The newest tests row that carries a registry diff. A commit holds at
    // most two tests rows (convex/ttsMerge.ts internalRecordTests: the box's
    // red row may follow a green one), and that red row carries no diff, so
    // the newest row alone would hide the diff of a head the box has failed.
    // Two rows by construction, so take(2) is the whole key.
    const tests = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", TESTS_RUN).eq("key", key))
      .order("desc")
      .take(2);
    const registryDiff =
      tests
        .map((row) => registryDiffOf((row.data as { registryDiff?: unknown } | undefined)?.registryDiff))
        .find((diff) => diff !== null) ?? null;
    if (registryDiff === null) return null;
    const exact = await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", REGISTRY).eq("subject", `Jarvis@${registryDiff.base}`))
      .order("desc")
      .first();
    const base = exact ?? (await newestRegistry(ctx));
    return {
      head: key,
      registryDiff,
      base: base === null ? null : registryOf(base),
      baseIsExact: exact !== null,
    };
  },
});
