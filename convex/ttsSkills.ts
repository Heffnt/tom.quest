// Published prompt layers and their source-file facts.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { MODEL_OF_TOM_HEADER } from "./ttsShared";
import { PRELUDE_LAYERS } from "../scripts/skills.mjs";
import { parseFrontmatter } from "../worker/jobs/markdown-sections.mjs";

export const MODEL_OF_TOM_LAYER_NAMES = ["operate", "write", "know"] as const;
export type ModelOfTomLayerName = (typeof MODEL_OF_TOM_LAYER_NAMES)[number];
const layerValidator = v.union(v.literal("operate"), v.literal("write"), v.literal("know"));
export const MODEL_OF_TOM_SELECTIONS = [
  ["operate"], ["write"], ["know"], ["operate", "write"],
  ["operate", "know"], ["write", "know"], ["operate", "write", "know"],
] as const satisfies readonly (readonly ModelOfTomLayerName[])[];

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
  names: readonly ModelOfTomLayerName[] = MODEL_OF_TOM_LAYER_NAMES,
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

function validHeaders(headers: StoredHeader[], commit: string): boolean {
  if (headers.length !== MODEL_OF_TOM_SELECTIONS.length) return false;
  const expected = new Set(MODEL_OF_TOM_SELECTIONS.map(selectionKey));
  const seen = new Set<string>();
  for (const { layers, header } of headers) {
    const canonical = canonicalModelOfTomNames(layers);
    const key = selectionKey(canonical);
    if (key !== selectionKey(layers) || seen.has(key) || !expected.has(key) || !isPublicationHeader(header, commit)) return false;
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
  names: readonly ModelOfTomLayerName[] = MODEL_OF_TOM_LAYER_NAMES,
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
  names: readonly ModelOfTomLayerName[] = MODEL_OF_TOM_LAYER_NAMES,
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

type ModelOfTomFact = {
  sourcePath: string;
  body: string;
  commit?: string;
  syncedAt: number;
  pushed?: boolean;
};

type ModelOfTomPublication = {
  commit: string;
  committedAt: number;
  pushed: boolean;
  layers: Record<ModelOfTomLayerName, string>;
  headers: StoredHeader[];
};

function renderFiles(files: readonly Pick<ModelOfTomFact, "sourcePath" | "body">[]): string {
  return files.map(({ sourcePath, body }) => `── ${sourcePath} ──\n${body}`).join("\n\n");
}

function renderHeader(commit: string, files: readonly Pick<ModelOfTomFact, "sourcePath">[]): string {
  return `${MODEL_OF_TOM_HEADER} (WikiTom commit ${commit}): ${files.map((file) => file.sourcePath).join(", ")}`;
}

/**
 * Reconstruct the publication exactly as the nightly assembler would from its
 * current per-file facts. The optional ground file is omitted when the old
 * facts do not contain it: historical presence is a git question the facts
 * cannot answer, and the next nightly post is the authoritative replacement.
 */
export function publicationFromFacts(facts: readonly ModelOfTomFact[]): ModelOfTomPublication {
  if (facts.length === 0) throw new Error("no model-of-tom facts are stored");
  const byPath = new Map<string, ModelOfTomFact>();
  for (const fact of facts) {
    if (!isModelOfTomPath(fact.sourcePath)) throw new Error(`not a model-of-tom path: ${fact.sourcePath}`);
    if (fact.body.trim() === "") throw new Error(`body for ${fact.sourcePath} must be non-empty`);
    if (byPath.has(fact.sourcePath)) throw new Error(`model-of-tom fact is stored twice: ${fact.sourcePath}`);
    byPath.set(fact.sourcePath, fact);
  }

  const selected: Record<ModelOfTomLayerName, ModelOfTomFact[]> = {
    operate: [], write: [], know: [],
  };
  for (const name of MODEL_OF_TOM_LAYER_NAMES) {
    const definition = PRELUDE_LAYERS[name];
    for (const entry of definition.files) {
      const fact = byPath.get(entry.path);
      if (fact === undefined) {
        if (entry.optionalUntilPresent) continue;
        throw new Error(`model-of-tom fact ${entry.path} is not stored`);
      }
      selected[name].push(fact);
    }
    if (definition.areas !== undefined) {
      const prefix = `${definition.areas.directory}/`;
      const areas = facts
        .filter((fact) => fact.sourcePath.startsWith(prefix) && /^([^/]+)\.md$/.test(fact.sourcePath.slice(prefix.length)))
        .map((fact) => ({ ...fact, body: parseFrontmatter(fact.body).body.trim() }))
        .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
      for (const path of definition.areas.required) {
        if (!areas.some((fact) => fact.sourcePath === path)) {
          throw new Error(`model-of-tom fact ${path} is not stored`);
        }
      }
      if (areas.some((fact) => fact.body === "")) {
        throw new Error("model-of-tom area fact is blank after frontmatter");
      }
      selected[name].push(...areas);
    }
  }

  const selectedFacts = MODEL_OF_TOM_LAYER_NAMES.flatMap((name) => selected[name]);
  const commit = selectedFacts[0]?.commit;
  const committedAt = selectedFacts[0]?.syncedAt;
  const pushed = selectedFacts[0]?.pushed;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("model-of-tom facts need one 40-character commit");
  }
  if (!Number.isFinite(committedAt)) throw new Error("model-of-tom facts need one finite committedAt");
  if (typeof pushed !== "boolean") throw new Error("model-of-tom facts need one pushed value");
  for (const fact of selectedFacts) {
    if (fact.commit !== commit || fact.syncedAt !== committedAt || fact.pushed !== pushed) {
      throw new Error("model-of-tom facts must name one commit, committedAt, and pushed value");
    }
  }

  const layers = Object.fromEntries(MODEL_OF_TOM_LAYER_NAMES.map((name) => [name, renderFiles(selected[name])])) as Record<ModelOfTomLayerName, string>;
  for (const name of MODEL_OF_TOM_LAYER_NAMES) {
    if (layers[name].trim() === "") throw new Error(`model-of-tom layer ${name} is blank`);
  }
  const headers: StoredHeader[] = MODEL_OF_TOM_SELECTIONS.map((names) => ({
    layers: [...names],
    header: renderHeader(commit, names.flatMap((name) => selected[name])),
  }));
  // The same gate a posted publication passes, so a backfilled one reads to
  // every consumer exactly as a nightly one does.
  if (!validHeaders(headers, commit)) {
    throw new Error("the backfilled headers are not one parseable file list per canonical selection");
  }
  return { commit, committedAt, pushed, layers, headers };
}

export const internalBackfillModelOfTom = internalMutation({
  args: {},
  handler: async (ctx) => {
    const current = await ctx.db.query("modelOfTomPublication")
      .withIndex("by_key", (q) => q.eq("key", "current")).unique();
    if (current !== null) throw new Error("model-of-tom publication is already stored");
    const facts = await ctx.db.query("ttsSkills").withIndex("by_name").take(65);
    if (facts.length > 64) throw new Error("too many model-of-tom facts to backfill");
    const publication = publicationFromFacts(facts);
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      ...publication.layers,
      commit: publication.commit,
      committedAt: publication.committedAt,
      pushed: publication.pushed,
      headers: publication.headers,
    });
    return { files: facts.length, commit: publication.commit };
  },
});

/**
 * One deployment-time repair, run by hand exactly once between deploying this
 * code and the first nightly post. The return type is written out because the
 * handler names its own module's `internal` API, which TypeScript cannot infer
 * through the cycle.
 */
export const backfillLayers = internalAction({
  args: {},
  handler: async (ctx): Promise<{ files: number; commit: string }> =>
    await ctx.runMutation(internal.ttsSkills.internalBackfillModelOfTom, {}),
});

export const internalReplaceModelOfTom = internalMutation({
  args: {
    commit: v.string(),
    committedAt: v.number(),
    pushed: v.boolean(),
    force: v.optional(v.string()),
    layers: v.object({ operate: v.string(), write: v.string(), know: v.string() }),
    headers: v.array(v.object({ layers: v.array(layerValidator), header: v.string() })),
    files: v.array(v.object({ path: v.string(), body: v.string(), bytes: v.number() })),
  },
  handler: async (ctx, { commit, committedAt, pushed, force, layers, headers, files }) => {
    if (commit.trim() === "") throw new Error("commit is required");
    if (!Number.isFinite(committedAt)) throw new Error("committedAt must be finite");
    for (const name of MODEL_OF_TOM_LAYER_NAMES) {
      if (layers[name].trim() === "") throw new Error(`model-of-tom layer ${name} is blank`);
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
    const publication = { key: "current" as const, commit, committedAt, pushed, ...layers, headers };
    if (current === null) await ctx.db.insert("modelOfTomPublication", publication);
    else await ctx.db.replace("modelOfTomPublication", current._id, publication);
    return { files: files.length, deleted: existingFacts.length, forced };
  },
});
