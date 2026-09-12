import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../worker/jobs/markdown-sections.mjs";
export { PRELUDE_LAYERS } from "./skills.mjs";
import { PRELUDE_LAYERS, PRELUDE_LAYER_NAMES as LAYER_NAMES } from "./skills.mjs";

class PreludeError extends Error {}

function git(dir, ...args) {
  const resolved = fs.realpathSync.native(dir);
  return execFileSync("git", ["-c", `safe.directory=${resolved}`, "-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // `ls-tree -r` over WikiTom is 3.5 MB of archived sessions, well past
    // execFileSync's 1 MB default, and the overflow surfaces as the same
    // "cannot list" message an absent directory gives. collectRepoRules now
    // reads WikiTom as a repository, so this is load-bearing rather than
    // defensive. scripts/publish-skills.mjs carries the same line.
    maxBuffer: 256 * 1024 * 1024,
  });
}

function resolveCommit(dir, requested) {
  try {
    return git(dir, "rev-parse", "--verify", `${requested}^{commit}`).trim();
  } catch {
    throw new PreludeError(`cannot resolve commit ${requested}`);
  }
}

function readObject(dir, commit, file) {
  try {
    return git(dir, "show", `${commit}:${file}`);
  } catch {
    return null;
  }
}

function wasPresentInHistory(dir, commit, file) {
  return git(dir, "log", "--format=%H", commit, "--", file)
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((ancestor) => {
      const body = readObject(dir, ancestor, file);
      return body !== null;
    });
}

function areaPaths(dir, commit, { directory, required }) {
  try {
    git(dir, "cat-file", "-e", `${commit}:${directory}`);
  } catch {
    throw new PreludeError(`required ${directory} is absent at ${commit}`);
  }
  let names;
  try {
    names = git(dir, "ls-tree", "--name-only", commit, "--", `${directory}/`);
  } catch {
    throw new PreludeError(`cannot list ${directory} at ${commit}`);
  }
  const additional = names
    .split("\n")
    .filter((name) => name.startsWith(`${directory}/`) && /^([^/]+)\.md$/.test(name.slice(directory.length + 1)))
    .sort();
  return [...new Set([...required, ...additional])].sort();
}

function selectedLayerNames(requested) {
  if (requested === undefined) return LAYER_NAMES;
  const names = Array.isArray(requested) ? requested : String(requested).split(",");
  if (names.length === 0 || names.some((name) => !LAYER_NAMES.includes(name))) {
    throw new PreludeError(`--layers must name one or more of ${LAYER_NAMES.join(", ")}`);
  }
  if (new Set(names).size !== names.length) throw new PreludeError("--layers must not name a layer twice");
  return LAYER_NAMES.filter((name) => names.includes(name));
}

function renderFiles(files) {
  return files.map(({ path, body }) => `\u2500\u2500 ${path} \u2500\u2500\n${body}`).join("\n\n");
}

function renderHeader(commit, files) {
  return `MODEL-OF-TOM FILES (WikiTom commit ${commit}): ${files.map((file) => file.path).join(", ")}`;
}

function collectLayers(wikitom, commit, requestedLayers) {
  const files = [];
  const layers = {};
  const filesByLayer = {};

  for (const name of requestedLayers) {
    const definition = PRELUDE_LAYERS[name];
    const layerFiles = [];
    for (const entry of definition.files) {
      const body = readObject(wikitom, commit, entry.path);
      if (body === null || body.trim() === "") {
        if (entry.optionalUntilPresent && !wasPresentInHistory(wikitom, commit, entry.path)) {
          const state = body === null ? "absent" : "blank";
          console.error(`prelude: optional ${entry.path} is ${state} at ${commit}; omitting it`);
          continue;
        }
        const state = body === null ? "absent" : "blank";
        throw new PreludeError(`required ${entry.path} is ${state} at ${commit}`);
      }
      layerFiles.push({ path: entry.path, body, sourceBody: body });
    }
    if (definition.areas !== undefined) {
      for (const path of areaPaths(wikitom, commit, definition.areas)) {
        const source = readObject(wikitom, commit, path);
        if (source === null) throw new PreludeError(`required ${path} is absent at ${commit}`);
        const body = parseFrontmatter(source).body.trim();
        if (body === "") throw new PreludeError(`required ${path} is blank at ${commit}`);
        layerFiles.push({ path, body, sourceBody: source });
      }
    }
    files.push(...layerFiles);
    layers[name] = renderFiles(layerFiles);
    filesByLayer[name] = layerFiles;
  }
  return { files, layers, filesByLayer };
}

function preludeResult(wikitom, commit, collected) {
  const committedAt = Number(git(wikitom, "log", "-1", "--format=%ct", commit).trim()) * 1000;
  let pushed = false;
  try {
    git(wikitom, "merge-base", "--is-ancestor", commit, "@{upstream}");
    pushed = true;
  } catch {
    // A checkout without an upstream, or a local-only commit, is not pushed.
  }
  const header = renderHeader(commit, collected.files);
  return {
    commit,
    committedAt,
    pushed,
    layers: collected.layers,
    files: collected.files.map((file) => ({ ...file, bytes: Buffer.byteLength(file.sourceBody) })),
    text: `${header}\n\n${renderFiles(collected.files)}`,
  };
}

/**
 * Reads the requested WikiTom prompt layers from one immutable git commit.
 * Its result is reusable by the nightly job; the command line below is only
 * a thin renderer around this function.
 *
 * A WHOLE LAYER SELECTION IS THE ONE QUESTION THIS ASSEMBLER ANSWERS. It used
 * to answer a second — `--for <subject>`, which cut the know layer down to the
 * bytes that bore on one run — and that is gone with the expansion itself: the
 * know layer is a published skill catalog, a run is granted skill NAMES by
 * worker/jobs/skill-router.mjs, and it loads a body itself, once, if it needs
 * one. `--layers operate` is how the base is assembled on both hosts, and
 * worker/jobs/evals.mjs layersFor runs `--layers` against a pinned tree.
 */
export function assemblePrelude({ wikitom, commit: requestedCommit = "HEAD", layers } = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PreludeError("--wikitom DIR is required");
  const commit = resolveCommit(wikitom, requestedCommit);
  const requestedLayers = selectedLayerNames(layers);
  return preludeResult(wikitom, commit, collectLayers(wikitom, commit, requestedLayers));
}

/**
 * Every published `AGENTS.md` of one repo checkout, for the nightly post that
 * carries them into Convex — the `repo-<name>` skills are written from these
 * bodies, and Convex has no filesystem. Read out of the immutable commit, like
 * every other body here.
 */
export function collectRepoRules({ dir, repo, commit: requestedCommit = "HEAD" }) {
  if (typeof dir !== "string" || dir === "") throw new PreludeError("--repo-rules needs a directory");
  if (typeof repo !== "string" || repo === "") throw new PreludeError("--repo-rules needs a repo name");
  const commit = resolveCommit(dir, requestedCommit);
  let names;
  try {
    names = git(dir, "ls-tree", "-r", "--name-only", commit);
  } catch {
    throw new PreludeError(`cannot list ${dir} at ${commit}`);
  }
  const paths = names
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name === "AGENTS.md" || name.endsWith("/AGENTS.md"))
    .sort();
  const rules = [];
  for (const filePath of paths) {
    const body = readObject(dir, commit, filePath);
    if (body === null || body.trim() === "") continue;
    rules.push({ repo, path: filePath, body, bytes: Buffer.byteLength(body) });
  }
  return { commit, rules };
}

/**
 * Build the nightly publication in one pass over an immutable WikiTom
 * commit. Headers come from the same collected file map, so no consumer has
 * to recreate a layer's file selection or invoke git again.
 */
export function assemblePreludePublication({ wikitom, commit: requestedCommit = "HEAD" } = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PreludeError("--wikitom DIR is required");
  const commit = resolveCommit(wikitom, requestedCommit);
  const collected = collectLayers(wikitom, commit, LAYER_NAMES);
  const result = preludeResult(wikitom, commit, collected);
  const headers = [];
  for (let mask = 1; mask < 1 << LAYER_NAMES.length; mask += 1) {
    const layers = LAYER_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
    headers.push({
      layers,
      header: renderHeader(commit, layers.flatMap((name) => collected.filesByLayer[name])),
    });
  }
  return { ...result, headers };
}

const VALUE_ARGS = ["--wikitom", "--commit", "--layers"];

function parseArgs(argv) {
  const values = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (VALUE_ARGS.includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new PreludeError(`${argument} needs a value`);
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new PreludeError(`unknown argument ${argument}`);
  }
  const { wikitom, commit, layers } = values;
  if (wikitom === undefined) throw new PreludeError("--wikitom DIR is required");
  if (layers === undefined) throw new PreludeError("--layers operate,write,know is required");
  return { wikitom, commit, layers, json };
}

function main(argv) {
  const { json, layers, ...options } = parseArgs(argv);
  const prelude = assemblePrelude({ ...options, layers });
  if (json) {
    process.stdout.write(`${JSON.stringify({
      commit: prelude.commit,
      committedAt: prelude.committedAt,
      pushed: prelude.pushed,
      layers: prelude.layers,
      files: prelude.files.map(({ path: filePath, bytes }) => ({ path: filePath, bytes })),
    })}\n`);
  } else {
    process.stdout.write(`${prelude.text}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`prelude: ${error.message}`);
    process.exitCode = 2;
  }
}
