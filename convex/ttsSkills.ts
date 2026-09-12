// THE BASE PUBLICATION AND THE SKILL CATALOG — two stores, two doors, one file.
//
// What a prompt begins with is now TWO THINGS, published by two independent
// posts, and the split is the point:
//
//   THE BASE — modelOfTomPublication, one `key: "current"` row, holding the
//     verbatim `operate` layer (header line 1, the map, the operate rules) and
//     the header for every canonical selection that remains. Posted to
//     POST /tts/model-of-tom, with one modelOfTomFiles row per source file.
//   THE CATALOG — one ttsSkills row per published skill: `write`,
//     `know-intent`, `know-week`, one `know-<area>` per area page, one
//     `repo-<name>` per repository. Posted to POST /tts/skills.
//
// TWO DOORS SO THEY FAIL SEPARATELY. A night that could render the base and not
// the catalog still delivers a base, and every run that night carries the
// operate rules with an empty grant line rather than no prompt at all.
//
// WHAT THE LAYERS BECAME. `write` and `know` were whole layers a caller
// selected; they are skills now, and nothing selects them. The two fields stay
// declared on the publication (a row written before this commit still carries
// them) and go unwritten from here on, so `operate` is the only layer any
// selection can name.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";
import { byteLength, DESCRIPTION_MAX_BYTES, SKILL_GROUPS } from "../scripts/skills.mjs";

/** The layer names a POST may still name. `write` and `know` stay in the
 * vocabulary because the nightly publisher spells them until it is narrowed;
 * only `operate` is stored, and only `operate` can be selected. */
export const MODEL_OF_TOM_LAYER_NAMES = ["operate", "write", "know"] as const;
export type ModelOfTomLayerName = (typeof MODEL_OF_TOM_LAYER_NAMES)[number];
const layerValidator = v.union(v.literal("operate"), v.literal("write"), v.literal("know"));

/** The layers the publication KEEPS. */
export const STORED_LAYER_NAMES = ["operate"] as const satisfies readonly ModelOfTomLayerName[];

/**
 * Every selection a reader may ask for — one, now that `write` and `know` are
 * skills. It was seven while three layers could be combined; six of those seven
 * named a layer nothing stores, so a header for them would be a header for text
 * no prompt can carry.
 */
export const MODEL_OF_TOM_SELECTIONS = [["operate"]] as const satisfies readonly (readonly ModelOfTomLayerName[])[];

type StoredHeader = { layers: ModelOfTomLayerName[]; header: string };
export type ModelOfTomState = {
  commit: string | null;
  syncedAt: number | null;
  pushed: boolean | null;
  operate?: string;
  write?: string;
  know?: string;
  headers?: StoredHeader[];
  files?: { path: string; body: string }[];
};
export { MODEL_OF_TOM_HEADER };

export function canonicalModelOfTomNames(
  names: readonly ModelOfTomLayerName[] = STORED_LAYER_NAMES,
): ModelOfTomLayerName[] {
  if (names.length === 0) throw new Error("model-of-tom needs at least one layer");
  for (const name of names) {
    if (!(MODEL_OF_TOM_LAYER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`not a model-of-tom layer: ${name}`);
    }
  }
  return MODEL_OF_TOM_LAYER_NAMES.filter((name) => names.includes(name));
}

function selectionKey(names: readonly ModelOfTomLayerName[]): string {
  return names.join(",");
}

/** Headers are rendered from one immutable WikiTom commit by scripts/prelude.mjs. */
function isPublicationHeader(header: string, commit: string): boolean {
  const match = /^MODEL-OF-TOM FILES \(WikiTom commit ([0-9a-f]{40})\): ((?:model-of-tom\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md)(?:, model-of-tom\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md)*)$/.exec(header);
  if (match === null || match[1] !== commit) return false;
  const paths = match[2].split(", ");
  return new Set(paths).size === paths.length && paths.every(isModelOfTomPath);
}

/**
 * The posted headers NARROWED to the selections that remain, or null when the
 * post does not carry every one of them exactly once.
 *
 * A header for a retired selection is DROPPED, not refused. The publisher lives
 * in another file that narrows on its own schedule; a base that refused because
 * it still carried the three-layer header would be a night with no prefix at
 * all, which is the one failure this store exists to prevent.
 */
function canonicalHeaders(headers: readonly StoredHeader[], commit: string): StoredHeader[] | null {
  const expected = new Set(MODEL_OF_TOM_SELECTIONS.map(selectionKey));
  const kept = new Map<string, StoredHeader>();
  for (const { layers, header } of headers) {
    const canonical = canonicalModelOfTomNames(layers);
    const key = selectionKey(canonical);
    if (key !== selectionKey(layers) || !expected.has(key)) continue;
    if (kept.has(key) || !isPublicationHeader(header, commit)) return null;
    kept.set(key, { layers: [...canonical], header });
  }
  if (kept.size !== expected.size) return null;
  return MODEL_OF_TOM_SELECTIONS.map((names) => kept.get(selectionKey(names))!);
}

export async function modelOfTomState(ctx: QueryCtx | MutationCtx): Promise<ModelOfTomState> {
  const current = await ctx.db.query("modelOfTomPublication")
    .withIndex("by_key", (q) => q.eq("key", "current")).unique();
  if (current === null) return { commit: null, syncedAt: null, pushed: null, headers: [] };
  return {
    commit: current.commit,
    syncedAt: current.committedAt,
    pushed: current.pushed,
    operate: current.operate,
    write: current.write,
    know: current.know,
    headers: current.headers,
  };
}

export function modelOfTomText(
  state: ModelOfTomState,
  names: readonly ModelOfTomLayerName[] = STORED_LAYER_NAMES,
): string {
  const canonical = canonicalModelOfTomNames(names);
  for (const name of canonical) {
    if (typeof state[name] !== "string" || state[name].trim() === "") {
      throw new Error(`model-of-tom layer ${name} is not stored`);
    }
  }
  const key = selectionKey(canonical);
  const header = state.headers?.find((candidate) => selectionKey(candidate.layers) === key)?.header;
  if (header === undefined) throw new Error(`model-of-tom header ${key} is not stored`);
  return [header, ...canonical.map((name) => state[name]!)].join("\n\n");
}

export async function modelOfTomPrelude(
  ctx: QueryCtx | MutationCtx,
  names: readonly ModelOfTomLayerName[] = STORED_LAYER_NAMES,
): Promise<string> {
  return modelOfTomText(await modelOfTomState(ctx), names);
}

export function withoutModelOfTomPrelude(prompt: string, prelude: string): string | null {
  const text = prompt.trimStart();
  if (!text.startsWith(MODEL_OF_TOM_HEADER)) return prompt;
  if (!text.startsWith(prelude)) return null;
  return text.slice(prelude.length).replace(/^\n+/, "");
}

export const internalModelOfTomPrelude = internalQuery({
  args: { names: v.optional(v.array(layerValidator)) },
  handler: async (ctx, args) => await modelOfTomPrelude(ctx, args.names),
});

export function modelOfTomRowName(path: string): string {
  return path.slice("model-of-tom/".length).replace(/\.md$/, "");
}

export function isModelOfTomPath(path: unknown): path is string {
  return typeof path === "string" && /^model-of-tom\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..");
}

// ── The base ─────────────────────────────────────────────────────────────────
//
// THE ONE-SHOT BACKFILL IS GONE with this commit, and could not have been kept.
// `internalBackfillModelOfTom`, `backfillLayers` and `publicationFromFacts`
// existed to seed the singleton ONCE out of the per-file rows the retired
// six-hourly sync had left in `ttsSkills`, and they refused to run at all once
// a publication was stored — so they have been spent since the first nightly
// post after phase 4. The door they repaired cannot be reached from the new
// table shape either: `ttsSkills` no longer carries a `sourcePath` or a
// per-file body, so there is nothing left for `publicationFromFacts` to read.
// Their tests went with them.

export const internalReplaceModelOfTom = internalMutation({
  args: {
    commit: v.string(),
    committedAt: v.number(),
    pushed: v.boolean(),
    force: v.optional(v.string()),
    // `write` and `know` are accepted and DROPPED: the publisher still renders
    // them at this commit, and refusing its post over text nothing reads would
    // cost a night's base for nothing.
    layers: v.object({ operate: v.string(), write: v.optional(v.string()), know: v.optional(v.string()) }),
    headers: v.array(v.object({ layers: v.array(layerValidator), header: v.string() })),
    files: v.array(v.object({ path: v.string(), body: v.string(), bytes: v.number() })),
  },
  handler: async (ctx, { commit, committedAt, pushed, force, layers, headers, files }) => {
    if (commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(committedAt)) throw new Error("committedAt must be finite");
    for (const name of STORED_LAYER_NAMES) {
      if (layers[name].trim() === "") throw new Error(`model-of-tom layer ${name} is blank`);
    }
    const stored = canonicalHeaders(headers, commit);
    if (stored === null) {
      throw new Error("headers must contain each canonical selection exactly once, with the posted commit and a parseable file list");
    }
    if (files.length === 0) throw new Error("no files posted — store left as it was");
    const paths = new Set<string>();
    for (const file of files) {
      if (!isModelOfTomPath(file.path)) throw new Error(`not a model-of-tom path: ${file.path}`);
      if (paths.has(file.path)) throw new Error(`path posted twice: ${file.path}`);
      if (file.body.trim() === "") throw new Error(`body for ${file.path} must be non-empty`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`bytes for ${file.path} must be a nonnegative integer`);
      paths.add(file.path);
    }
    const current = await ctx.db.query("modelOfTomPublication")
      .withIndex("by_key", (q) => q.eq("key", "current")).unique();
    const forced = force !== undefined && force.trim() !== "";
    if (current !== null && committedAt < current.committedAt && !forced) {
      throw new Error(`the post's commit ${commit.slice(0, 12)} (${new Date(committedAt).toISOString()}) is older than the stored one (${new Date(current.committedAt).toISOString()}) — store left as it was; post with force naming why to replace it`);
    }
    if (force !== undefined && !forced) throw new Error("force, when given, is the reason (a non-empty string)");
    // THE SOURCE FACTS, not the catalog. This door stopped touching `ttsSkills`
    // in phase 6: the base and the skill catalog are two stores with two posts,
    // and a base post that emptied the catalog would take every grant down on a
    // night the skills post never ran.
    const existingFacts = await ctx.db.query("modelOfTomFiles").collect();
    for (const fact of existingFacts) await ctx.db.delete(fact._id);
    for (const file of files) await ctx.db.insert("modelOfTomFiles", {
      name: modelOfTomRowName(file.path),
      body: file.body,
      sourcePath: file.path,
      bytes: file.bytes,
      commit,
      syncedAt: committedAt,
      pushed,
    });
    // `operate` alone: the two retired layers go unwritten, so a replace takes
    // whatever an older row still carried off with it.
    const publication = {
      key: "current" as const,
      commit,
      committedAt,
      pushed,
      operate: layers.operate,
      headers: stored,
    };
    if (current === null) await ctx.db.insert("modelOfTomPublication", publication);
    else await ctx.db.replace("modelOfTomPublication", current._id, publication);
    return { files: files.length, deleted: existingFacts.length, forced };
  },
});

// ── The catalog ──────────────────────────────────────────────────────────────

/** The ceiling on one post — the same 64 the model-of-tom door caps its files
 * at, and named here rather than shared so the two doors stay independent:
 * fourteen skills today against sixty-four source files, and a post past either
 * is a publisher bug rather than a bigger WikiTom. */
export const SKILLS_MAX = 64;

const skillReference = v.object({ name: v.string(), path: v.string(), body: v.string() });

/**
 * The catalog, replaced whole. Same shape of refusal as
 * `internalReplaceModelOfTom` and `internalReplaceRepoRules`: an empty post
 * leaves the store as it was, a duplicate name is a bug in the publisher, and a
 * blank body is not a skill.
 *
 * WHOLE, NOT PER SKILL: the publisher builds the set from one immutable commit,
 * and a skill that has left the set (an area page Tom deleted) must leave the
 * catalog with it, or the router would grant a name no page stands behind.
 */
export const internalReplaceSkills = internalMutation({
  args: {
    commit: v.string(),
    syncedAt: v.number(),
    pushed: v.boolean(),
    skills: v.array(v.object({
      name: v.string(),
      group: v.string(),
      description: v.string(),
      body: v.string(),
      references: v.array(skillReference),
      sourcePaths: v.array(v.string()),
      bytes: v.number(),
    })),
  },
  handler: async (ctx, { commit, syncedAt, pushed, skills }) => {
    if (commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(syncedAt)) throw new Error("syncedAt must be finite");
    if (skills.length === 0) throw new Error("no skills posted — store left as it was");
    if (skills.length > SKILLS_MAX) throw new Error(`at most ${SKILLS_MAX} skills per post — got ${skills.length}`);
    const names = new Set<string>();
    for (const skill of skills) {
      if (skill.name.trim() === "") throw new Error("a skill needs a name");
      if (names.has(skill.name)) throw new Error(`skill posted twice: ${skill.name}`);
      if (!(SKILL_GROUPS as readonly string[]).includes(skill.group)) {
        throw new Error(`not a skill group: ${skill.group} (one of ${SKILL_GROUPS.join(", ")})`);
      }
      if (skill.body.trim() === "") throw new Error(`body for ${skill.name} must be non-empty`);
      if (skill.description.trim() === "") throw new Error(`description for ${skill.name} must be non-empty`);
      const described = byteLength(skill.description);
      if (described > DESCRIPTION_MAX_BYTES) {
        throw new Error(`description for ${skill.name} is ${described} bytes, over the ${DESCRIPTION_MAX_BYTES}-byte cap`);
      }
      if (!Number.isSafeInteger(skill.bytes) || skill.bytes < 0) {
        throw new Error(`bytes for ${skill.name} must be a nonnegative integer`);
      }
      names.add(skill.name);
    }
    const existing = await ctx.db.query("ttsSkills").collect();
    for (const row of existing) await ctx.db.delete(row._id);
    for (const skill of skills) await ctx.db.insert("ttsSkills", { ...skill, commit, syncedAt, pushed });
    return { skills: skills.length, deleted: existing.length, commit };
  },
});
