// Published prompt blocks and their source-file facts.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";

export const MODEL_OF_TOM_BLOCK_NAMES = ["operate", "write", "know"] as const;
export type ModelOfTomBlockName = (typeof MODEL_OF_TOM_BLOCK_NAMES)[number];
const blockValidator = v.union(v.literal("operate"), v.literal("write"), v.literal("know"));
export const MODEL_OF_TOM_SELECTIONS = [
  ["operate"], ["write"], ["know"], ["operate", "write"],
  ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
] as const satisfies readonly (readonly ModelOfTomBlockName[])[];

type StoredHeader = { blocks: ModelOfTomBlockName[]; header: string };
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
  names: readonly ModelOfTomBlockName[] = MODEL_OF_TOM_BLOCK_NAMES,
): ModelOfTomBlockName[] {
  if (names.length === 0) throw new Error("model-of-tom needs at least one block");
  for (const name of names) {
    if (!(MODEL_OF_TOM_BLOCK_NAMES as readonly string[]).includes(name)) {
      throw new Error(`not a model-of-tom block: ${name}`);
    }
  }
  return MODEL_OF_TOM_BLOCK_NAMES.filter((name) => names.includes(name));
}

function selectionKey(names: readonly ModelOfTomBlockName[]): string {
  return names.join(",");
}

/** Headers are rendered from one immutable WikiTom commit by scripts/prelude.mjs. */
function isPublicationHeader(header: string, commit: string): boolean {
  const match = /^MODEL-OF-TOM FILES \(WikiTom commit ([0-9a-f]{40})\): ((?:model-of-tom\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md)(?:, model-of-tom\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md)*)$/.exec(header);
  if (match === null || match[1] !== commit) return false;
  const paths = match[2].split(", ");
  return new Set(paths).size === paths.length && paths.every(isModelOfTomPath);
}

function validHeaders(headers: StoredHeader[], commit: string): boolean {
  if (headers.length !== MODEL_OF_TOM_SELECTIONS.length) return false;
  const expected = new Set(MODEL_OF_TOM_SELECTIONS.map(selectionKey));
  const seen = new Set<string>();
  for (const { blocks, header } of headers) {
    const canonical = canonicalModelOfTomNames(blocks);
    const key = selectionKey(canonical);
    if (key !== selectionKey(blocks) || seen.has(key) || !expected.has(key) || !isPublicationHeader(header, commit)) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
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
  names: readonly ModelOfTomBlockName[] = MODEL_OF_TOM_BLOCK_NAMES,
): string {
  const canonical = canonicalModelOfTomNames(names);
  for (const name of canonical) {
    if (typeof state[name] !== "string" || state[name].trim() === "") {
      throw new Error(`model-of-tom block ${name} is not stored`);
    }
  }
  const key = selectionKey(canonical);
  const header = state.headers?.find((candidate) => selectionKey(candidate.blocks) === key)?.header;
  if (header === undefined) throw new Error(`model-of-tom header ${key} is not stored`);
  return [header, ...canonical.map((name) => state[name]!)].join("\n\n");
}

export async function modelOfTomPrelude(
  ctx: QueryCtx | MutationCtx,
  names: readonly ModelOfTomBlockName[] = MODEL_OF_TOM_BLOCK_NAMES,
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
  args: { names: v.optional(v.array(blockValidator)) },
  handler: async (ctx, args) => await modelOfTomPrelude(ctx, args.names),
});

export function modelOfTomRowName(path: string): string {
  return path.slice("model-of-tom/".length).replace(/\.md$/, "");
}

export function isModelOfTomPath(path: unknown): path is string {
  return typeof path === "string" && /^model-of-tom\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..");
}

export const internalReplaceModelOfTom = internalMutation({
  args: {
    commit: v.string(),
    committedAt: v.number(),
    pushed: v.boolean(),
    force: v.optional(v.string()),
    blocks: v.object({ operate: v.string(), write: v.string(), know: v.string() }),
    headers: v.array(v.object({ blocks: v.array(blockValidator), header: v.string() })),
    files: v.array(v.object({ path: v.string(), body: v.string(), bytes: v.number() })),
  },
  handler: async (ctx, { commit, committedAt, pushed, force, blocks, headers, files }) => {
    if (commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(committedAt)) throw new Error("committedAt must be finite");
    for (const name of MODEL_OF_TOM_BLOCK_NAMES) {
      if (blocks[name].trim() === "") throw new Error(`model-of-tom block ${name} is blank`);
    }
    if (!validHeaders(headers, commit)) {
      throw new Error("headers must contain each canonical selection exactly once, with the posted commit and a parseable file list");
    }
    if (files.length === 0) throw new Error("no files posted \u2014 store left as it was");
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
      throw new Error(`the post's commit ${commit.slice(0, 12)} (${new Date(committedAt).toISOString()}) is older than the stored one (${new Date(current.committedAt).toISOString()}) \u2014 store left as it was; post with force naming why to replace it`);
    }
    if (force !== undefined && !forced) throw new Error("force, when given, is the reason (a non-empty string)");
    const existingFacts = await ctx.db.query("ttsSkills").collect();
    for (const fact of existingFacts) await ctx.db.delete(fact._id);
    for (const file of files) await ctx.db.insert("ttsSkills", {
      name: modelOfTomRowName(file.path),
      body: file.body,
      sourcePath: file.path,
      bytes: file.bytes,
      commit,
      syncedAt: committedAt,
      pushed,
    });
    const publication = { key: "current" as const, commit, committedAt, pushed, ...blocks, headers };
    if (current === null) await ctx.db.insert("modelOfTomPublication", publication);
    else await ctx.db.replace("modelOfTomPublication", current._id, publication);
    return { files: files.length, deleted: existingFacts.length, forced };
  },
});
