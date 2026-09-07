// The model-of-tom files every prompt begins with (the lifeos update, phase
// 4; Tom's ruling 2026-08-29 that WikiTom is the system of record for his
// model of himself).
//
// WHAT IS STORED: one row per WikiTom file the nightly job posts — the three
// named files (model-of-tom/writing.md, priorities.md, schedule.md) and, for
// each page under model-of-tom/areas/, the "Current state" and "Must not
// break" sections — together with the WikiTom commit they were read at. The
// job on the Jarvis Box holds the checkout and TTS_WORKER_KEY and posts through
// POST /tts/model-of-tom (convex/http.ts) after every nightly push, whether or
// not the push reached GitHub. Nothing here writes back to WikiTom, and no
// Convex-side read of GitHub exists any more: the six-hourly refresh and its
// read token (GITHUB_MIRROR_TOKEN) went with it, because it read three skill
// files without pinning a commit and no transcript could say which text it
// had begun with.
//
// WHY A COPY AT ALL: the consumers cannot read a git checkout. Convex has no
// filesystem, and the planner on the Jarvis Box is Node ESM that never loads
// TypeScript, so its half arrives over HTTP (GET /tts/batch-context). The copy
// is what lets the text reach a prompt.
//
// THE ONE READ is modelOfTomPrelude below: every session opener
// (claudeSessions.insertSession) and the planner payload go through it, so
// the fixed file order, the commit header, and the fallback cannot mean
// different things in different files. The header names the commit and lists
// the paths, which is how a transcript's first row records what the session
// began with.
//
// THE FALLBACK RULE: until the job's first post, a row the retired sync left
// (name "writing-to-tom", no commit) keeps serving as the writing file; with
// no rows at all the hardcoded copy in convex/ttsShared.ts (WRITING_STANDARD)
// stands in, and the header says so.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  CAPTURE_TRIAGE_HEADING,
  CAPTURE_TRIAGE_RULES,
  CAPTURE_TRIAGE_SKILL,
  MODEL_OF_TOM_AREAS_DIR,
  MODEL_OF_TOM_FIRST,
  MODEL_OF_TOM_HEADER,
  MODEL_OF_TOM_PRIORITIES,
  MODEL_OF_TOM_WRITING,
  WRITING_SKILL,
  WRITING_STANDARD,
} from "./ttsShared";
import { extractSections } from "../worker/jobs/markdown-sections.mjs";

/** One posted file: its WikiTom path and the text the prompt carries. */
export type ModelOfTomFile = { path: string; body: string };

/** What the store holds right now, in the fixed prompt order. `commit` is
 * null while the retired sync's row or the hardcoded copy is serving. */
export type ModelOfTomState = {
  commit: string | null;
  syncedAt: number | null;
  // Whether the posted commit had reached GitHub; null while a row without
  // the flag (the retired sync's, or one posted before it existed) serves.
  pushed: boolean | null;
  files: ModelOfTomFile[];
};

// The fixed order the files are prepended in: the three named files, then the
// area pages alphabetically. Anything else the store holds (nothing today)
// follows, alphabetically, so a new file cannot silently be dropped.
function orderRank(path: string): [number, string] {
  const named = (MODEL_OF_TOM_FIRST as readonly string[]).indexOf(path);
  if (named !== -1) return [named, path];
  if (path.startsWith(`${MODEL_OF_TOM_AREAS_DIR}/`)) return [MODEL_OF_TOM_FIRST.length, path];
  return [MODEL_OF_TOM_FIRST.length + 1, path];
}

/** The files in the order every prompt carries them. Exported for the tests. */
export function orderModelOfTom<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    const [ra, pa] = orderRank(a.path);
    const [rb, pb] = orderRank(b.path);
    return ra - rb || (pa < pb ? -1 : pa > pb ? 1 : 0);
  });
}

/** The store's current contents. Posted rows (those carrying a commit) win;
 * otherwise the retired sync's writing row, if it is still there. */
export async function modelOfTomState(
  ctx: QueryCtx | MutationCtx,
): Promise<ModelOfTomState> {
  const rows = await ctx.db.query("ttsSkills").collect();
  const posted = rows.filter(
    (r): r is Doc<"ttsSkills"> & { commit: string } =>
      typeof r.commit === "string" && r.body.trim() !== "",
  );
  if (posted.length > 0) {
    const ordered = orderModelOfTom(
      posted.map((r) => ({ path: r.sourcePath, body: r.body, row: r })),
    );
    return {
      commit: ordered[0].row.commit,
      syncedAt: ordered[0].row.syncedAt,
      pushed: ordered[0].row.pushed ?? null,
      files: ordered.map(({ path, body }) => ({ path, body })),
    };
  }
  const legacy = rows.find((r) => r.name === WRITING_SKILL && r.body.trim() !== "");
  if (legacy) {
    return {
      commit: null,
      syncedAt: legacy.syncedAt,
      pushed: null,
      files: [{ path: legacy.sourcePath, body: legacy.body }],
    };
  }
  return { commit: null, syncedAt: null, pushed: null, files: [] };
}

// The header is the first line of every prompt, and so of every transcript.
// Its text lives in ttsShared (client-safe): the sessions page reads it back
// off the transcript row, and cannot import this module.
export { MODEL_OF_TOM_HEADER };
export const MODEL_OF_TOM_FALLBACK_HEADER = `${MODEL_OF_TOM_HEADER}: none stored yet — the hardcoded writing standard (convex/ttsShared.ts WRITING_STANDARD) stands in until the nightly job's first post.`;

/** The text every prompt begins with: the header naming the commit and the
 * paths, then each file under its path. Pure, so the tests can pin it. */
export function modelOfTomText(state: ModelOfTomState): string {
  if (state.files.length === 0) {
    return `${MODEL_OF_TOM_FALLBACK_HEADER}\n\n${WRITING_STANDARD}`;
  }
  const paths = state.files.map((f) => f.path);
  const header = `${MODEL_OF_TOM_HEADER} (WikiTom commit ${state.commit ?? "not recorded — the retired sync's row"}): ${paths.join(", ")}`;
  const sections = state.files.map((f) => `── ${f.path} ──\n${f.body.trim()}`);
  return [header, ...sections].join("\n\n");
}

/** THE ONE READ every prompt consumer goes through. */
export async function modelOfTomPrelude(
  ctx: QueryCtx | MutationCtx,
): Promise<string> {
  return modelOfTomText(await modelOfTomState(ctx));
}

// The same read for an HTTP action (GET /tts/batch-context), which has no db
// handle of its own.
export const internalModelOfTomPrelude = internalQuery({
  args: {},
  handler: async (ctx) => await modelOfTomPrelude(ctx),
});

// ── The capture triage rules (GET /tts/capture-context) ──────────────────────
// The words every capture poller makes its two judgements by. Phase 3 of the
// lifeos update merged the WikiTom capture-triage skill into
// model-of-tom/priorities.md, so the live rules are now a SECTION of a file
// the nightly job already posts — nothing writes a capture-triage row any
// more, and the job's wholesale replace deletes the one the retired sync left.
//
// Three sources, in this order, and the answer says which one it is so the
// poller's log line names it (worker/jobs/tts-lib.mjs triageSourceLine):
//
//   "priorities" — the "What becomes a todo" section of the stored
//     model-of-tom/priorities.md. The live source.
//   "skill" — a capture-triage row the retired sync left behind, for as long
//     as one survives the next post.
//   "builtin" — the hardcoded copy in convex/ttsShared.ts, which serves only
//     while the store holds neither of the above.
export type CaptureTriageSource = "priorities" | "skill" | "builtin";

/** The rules and where they came from. Pure, so the tests can pin it. */
export function captureTriageFrom(
  priorities: string | null | undefined,
  skill: string | null | undefined,
): { captureTriage: string; source: CaptureTriageSource } {
  const section = extractSections(priorities ?? "", [CAPTURE_TRIAGE_HEADING]).trim();
  if (section !== "") return { captureTriage: section, source: "priorities" };
  const legacy = (skill ?? "").trim();
  if (legacy !== "") return { captureTriage: legacy, source: "skill" };
  return { captureTriage: CAPTURE_TRIAGE_RULES, source: "builtin" };
}

/** THE ONE READ behind GET /tts/capture-context, which has no db handle. */
export const internalCaptureTriage = internalQuery({
  args: {},
  handler: async (ctx) => {
    const byName = async (name: string) =>
      await ctx.db
        .query("ttsSkills")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique();
    const [priorities, skill] = await Promise.all([
      byName(modelOfTomRowName(MODEL_OF_TOM_PRIORITIES)),
      byName(CAPTURE_TRIAGE_SKILL),
    ]);
    return captureTriageFrom(priorities?.body, skill?.body);
  },
});

/** A posted file's row name: the path inside model-of-tom/ without the
 * extension ("writing", "priorities", "areas/research"). One home, because
 * the insert below writes it and internalCaptureTriage above looks a row up
 * by it. */
export function modelOfTomRowName(path: string): string {
  return path.slice("model-of-tom/".length).replace(/\.md$/, "");
}

// A path the job may post: inside model-of-tom/, a markdown file, no
// traversal. Exported so the route and the tests share one spelling.
export function isModelOfTomPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /^model-of-tom\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/.test(path) &&
    !path.split("/").some((seg) => seg === "." || seg === "..")
  );
}

// Wholesale replace, atomically: every row goes, one row per posted path
// comes in, all carrying the same commit. A file removed in WikiTom must stop
// reaching prompts — nothing-is-lost governs Tom's todos, not this copy. An
// empty post is refused here rather than emptying the store: a job that read
// nothing has hit a layout change, not a decision of Tom's.
//
// AND A POST WITHOUT writing.md IS REFUSED for the same reason, one file
// stronger: the replace is wholesale, so a post that read every file but that
// one would take the writing standard out of every prompt — and the store
// carries no memory of the file it dropped, so nothing would put it back
// until the next night that read it. A missing writing.md is a layout change
// or a half-read checkout; the previous night's text keeps serving, which is
// the only outcome that leaves prose written to a standard.
//
// AND A POST OLDER THAN THE STORE IS REFUSED: two posts can race (a `--only=
// post` by hand beside the nightly run, a box whose checkout fell behind),
// and the store must end on the newer commit whichever request lands last.
// The commit's own time decides — an older committedAt than the stored one
// is refused — unless `force` names why, which is the door for a deliberate
// roll-back. The same commit posted again is not older and goes through.
export const internalReplaceModelOfTom = internalMutation({
  args: {
    commit: v.string(),
    // The commit's own time (epoch ms), which is what syncedAt records — the
    // text is as old as the commit, not as young as the post.
    committedAt: v.number(),
    // Whether the commit had reached GitHub (schema ttsSkills.pushed).
    pushed: v.optional(v.boolean()),
    // The reason an older commit may replace the store; absent, it may not.
    force: v.optional(v.string()),
    files: v.array(v.object({ path: v.string(), body: v.string() })),
  },
  handler: async (ctx, { commit, committedAt, pushed, force, files }) => {
    if (files.length === 0) throw new Error("no files posted — store left as it was");
    const seen = new Set<string>();
    for (const f of files) {
      if (!isModelOfTomPath(f.path)) throw new Error(`not a model-of-tom path: ${f.path}`);
      if (seen.has(f.path)) throw new Error(`path posted twice: ${f.path}`);
      seen.add(f.path);
    }
    if (!seen.has(MODEL_OF_TOM_WRITING)) {
      throw new Error(
        `${MODEL_OF_TOM_WRITING} is missing from the post — store left as it was, so prompts keep the writing standard`,
      );
    }
    const existing = await ctx.db.query("ttsSkills").collect();
    const stored = existing
      .filter((r) => typeof r.commit === "string")
      .reduce((newest, r) => Math.max(newest, r.syncedAt), -Infinity);
    if (committedAt < stored && (force === undefined || force.trim() === "")) {
      throw new Error(
        `the post's commit ${commit.slice(0, 12)} (${new Date(committedAt).toISOString()}) is older than the stored one (${new Date(stored).toISOString()}) — store left as it was; post with force naming why to replace it`,
      );
    }
    for (const row of existing) await ctx.db.delete(row._id);
    for (const f of files) {
      await ctx.db.insert("ttsSkills", {
        name: modelOfTomRowName(f.path),
        body: f.body,
        sourcePath: f.path,
        commit,
        syncedAt: committedAt,
        pushed,
      });
    }
    return { files: files.length, deleted: existing.length, forced: force !== undefined && force.trim() !== "" };
  },
});
