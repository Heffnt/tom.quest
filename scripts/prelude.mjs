import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractSections } from "../worker/jobs/markdown-sections.mjs";

// This is the one definition of the prompt's stable blocks. `areas` expands
// from the named directory at the commit, rather than from the work tree.
export const PRELUDE_BLOCKS = Object.freeze({
  operate: Object.freeze({
    files: Object.freeze([{ path: "model-of-tom/agent-rules.md", optional: false }]),
  }),
  write: Object.freeze({
    files: Object.freeze([
      { path: "model-of-tom/writing.md", optional: false },
      { path: "model-of-tom/ground.md", optionalUntilPresent: true },
    ]),
  }),
  know: Object.freeze({
    files: Object.freeze([
      { path: "model-of-tom/priorities.md", optional: false },
      { path: "model-of-tom/schedule.md", optional: false },
    ]),
    areas: Object.freeze({
      directory: "model-of-tom/areas",
      required: Object.freeze([
        "model-of-tom/areas/admin.md",
        "model-of-tom/areas/agent-systems.md",
        "model-of-tom/areas/climbing.md",
        "model-of-tom/areas/health-and-food.md",
        "model-of-tom/areas/mental-health.md",
        "model-of-tom/areas/money.md",
        "model-of-tom/areas/research.md",
        "model-of-tom/areas/social.md",
      ]),
    }),
  }),
});

const BLOCK_NAMES = Object.freeze(Object.keys(PRELUDE_BLOCKS));
const AREA_SECTIONS = Object.freeze(["Current state", "Must not break"]);

class PreludeError extends Error {}

function git(dir, ...args) {
  const resolved = fs.realpathSync.native(dir);
  return execFileSync("git", ["-c", `safe.directory=${resolved}`, "-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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

/** The same section cutter used by the nightly post, exported for callers and tests. */
export function cutAreaSections(markdown) {
  return extractSections(markdown, AREA_SECTIONS);
}

function selectedBlockNames(requested) {
  if (requested === undefined) return BLOCK_NAMES;
  const names = Array.isArray(requested) ? requested : String(requested).split(",");
  if (names.length === 0 || names.some((name) => !BLOCK_NAMES.includes(name))) {
    throw new PreludeError(`--blocks must name one or more of ${BLOCK_NAMES.join(", ")}`);
  }
  if (new Set(names).size !== names.length) throw new PreludeError("--blocks must not name a block twice");
  return BLOCK_NAMES.filter((name) => names.includes(name));
}

function renderFiles(files) {
  return files.map(({ path, body }) => `\u2500\u2500 ${path} \u2500\u2500\n${body}`).join("\n\n");
}

function renderHeader(commit, files) {
  return `MODEL-OF-TOM FILES (WikiTom commit ${commit}): ${files.map((file) => file.path).join(", ")}`;
}

function collectBlocks(wikitom, commit, requestedBlocks) {
  const files = [];
  const blocks = {};
  const filesByBlock = {};

  for (const name of requestedBlocks) {
    const definition = PRELUDE_BLOCKS[name];
    const blockFiles = [];
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
      blockFiles.push({ path: entry.path, body, sourceBody: body });
    }
    if (definition.areas !== undefined) {
      for (const path of areaPaths(wikitom, commit, definition.areas)) {
        const source = readObject(wikitom, commit, path);
        if (source === null) throw new PreludeError(`required ${path} is absent at ${commit}`);
        const missing = AREA_SECTIONS.filter((section) => extractSections(source, [section]) === "");
        if (missing.length === 1) {
          throw new PreludeError(`required ${path} has no "${missing[0]}" section at ${commit}`);
        }
        if (missing.length > 1) {
          throw new PreludeError(`required ${path} has no "${missing[0]}" or "${missing[1]}" sections at ${commit}`);
        }
        const body = cutAreaSections(source);
        blockFiles.push({ path, body, sourceBody: source });
      }
    }
    files.push(...blockFiles);
    blocks[name] = renderFiles(blockFiles);
    filesByBlock[name] = blockFiles;
  }
  return { files, blocks, filesByBlock };
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
    blocks: collected.blocks,
    files: collected.files.map((file) => ({ ...file, bytes: Buffer.byteLength(file.sourceBody) })),
    text: `${header}\n\n${renderFiles(collected.files)}`,
  };
}

/**
 * Reads the requested WikiTom prompt blocks from one immutable git commit.
 * Its result is reusable by the nightly job; the command line below is only
 * a thin renderer around this function.
 */
export function assemblePrelude({ wikitom, commit: requestedCommit = "HEAD", blocks } = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PreludeError("--wikitom DIR is required");
  const commit = resolveCommit(wikitom, requestedCommit);
  const requestedBlocks = selectedBlockNames(blocks);
  return preludeResult(wikitom, commit, collectBlocks(wikitom, commit, requestedBlocks));
}

/**
 * Build the nightly publication in one pass over an immutable WikiTom
 * commit. Headers come from the same collected file map, so no consumer has
 * to recreate a block's file selection or invoke git again.
 */
export function assemblePreludePublication({ wikitom, commit: requestedCommit = "HEAD" } = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PreludeError("--wikitom DIR is required");
  const commit = resolveCommit(wikitom, requestedCommit);
  const collected = collectBlocks(wikitom, commit, BLOCK_NAMES);
  const result = preludeResult(wikitom, commit, collected);
  const headers = [];
  for (let mask = 1; mask < 1 << BLOCK_NAMES.length; mask += 1) {
    const blocks = BLOCK_NAMES.filter((_, index) => (mask & (1 << index)) !== 0);
    headers.push({
      blocks,
      header: renderHeader(commit, blocks.flatMap((name) => collected.filesByBlock[name])),
    });
  }
  return { ...result, headers };
}

function parseArgs(argv) {
  let wikitom;
  let commit;
  let blocks;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--wikitom" || argument === "--commit" || argument === "--blocks") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new PreludeError(`${argument} needs a value`);
      if (argument === "--wikitom") wikitom = value;
      if (argument === "--commit") commit = value;
      if (argument === "--blocks") blocks = value;
      index += 1;
      continue;
    }
    throw new PreludeError(`unknown argument ${argument}`);
  }
  if (wikitom === undefined) throw new PreludeError("--wikitom DIR is required");
  if (blocks === undefined) throw new PreludeError("--blocks operate,write,know is required");
  return { wikitom, commit, blocks, json };
}

function main(argv) {
  const { json, ...options } = parseArgs(argv);
  const prelude = assemblePrelude(options);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      commit: prelude.commit,
      committedAt: prelude.committedAt,
      pushed: prelude.pushed,
      blocks: prelude.blocks,
      files: prelude.files.map(({ path, bytes }) => ({ path, bytes })),
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
