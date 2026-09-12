import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../worker/jobs/markdown-sections.mjs";
import {
  assembleContextParts,
  callerRules,
  parseSubject,
  subjectNeedsRecord,
} from "../worker/jobs/context-relevance.mjs";
export { PRELUDE_LAYERS } from "./skills.mjs";
import { PRELUDE_LAYERS, PRELUDE_LAYER_NAMES as LAYER_NAMES } from "./skills.mjs";

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
 */
export function assemblePrelude({ wikitom, commit: requestedCommit = "HEAD", layers, for: subject, caller, record } = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PreludeError("--wikitom DIR is required");
  // `for` and `layers` are the two questions this assembler answers, and they
  // are exclusive: one whole layer selection, or one run's own subject.
  if (subject !== undefined) {
    if (layers !== undefined) throw new PreludeError("--for and --layers are mutually exclusive");
    return assembleContextPrelude({ wikitom, commit: requestedCommit, for: subject, caller, record });
  }
  const commit = resolveCommit(wikitom, requestedCommit);
  const requestedLayers = selectedLayerNames(layers);
  return preludeResult(wikitom, commit, collectLayers(wikitom, commit, requestedLayers));
}

/**
 * ONE RUN'S PROMPT, assembled for its own subject rather than for a caller's
 * fixed layer selection (the dynamic-context round, Tom's ruling 2026-09-09).
 *
 * Six parts, in this order:
 *
 *   ┌ STABLE PREFIX ─ the cache boundary ─────────────────────────────────┐
 *   │ header line 1  MODEL-OF-TOM FILES (WikiTom commit …): <stable paths>│
 *   │ part 1  map      model-of-tom/agent-rules.md § Map                  │
 *   │ part 2  operate  the rest of that file (one block, not two)         │
 *   │ part 3  write    writing.md + ground.md, when the run reaches Tom   │
 *   └─────────────────────────────────────────────────────────────────────┘
 *     header line 2  MODEL-OF-TOM EXPANDED (for <subject>): …
 *     part 4  expand     what the subject picks out of the know layer
 *     part 5  task       the caller's own mission body and supplemental —
 *                        NOT this function's; the CLI has no task
 *     header line 3  MODEL-OF-TOM FETCHABLE (<n> items):
 *     part 6  fetchable  one line per item NOT included
 *
 * Parts 1 and 2 are one file rendered once: `agent-rules.md` opens with
 * `## Map`, and they are named apart only because a fetchable line points back
 * at the map and because a future run may take the map without the rest.
 *
 * Header line 1 names THE STABLE PREFIX ONLY. That is what keeps it identical
 * across runs at one commit — the whole point of the boundary — and it stays
 * inside the regex `convex/ttsSkills.ts` validates a posted header with.
 */
export function assembleContextPrelude({
  wikitom,
  commit: requestedCommit = "HEAD",
  for: subjectSpec,
  caller = "cli",
  record = {},
} = {}) {
  if (typeof wikitom !== "string" || wikitom === "") throw new PreludeError("--wikitom DIR is required");
  const subject = parseSubject(subjectSpec);
  const rules = callerRules(caller);
  const commit = resolveCommit(wikitom, requestedCommit);
  const collected = collectLayers(wikitom, commit, LAYER_NAMES);
  const stableLayers = rules.reachesTom ? ["operate", "write"] : ["operate"];
  const stableFiles = stableLayers.flatMap((name) => collected.filesByLayer[name]);
  const prefix = `${renderHeader(commit, stableFiles)}\n\n${renderFiles(stableFiles)}`;
  const parts = assembleContextParts({
    subject,
    caller,
    // The SOURCE bodies, frontmatter included — the same bytes `ttsSkills.body`
    // stores, so the CLI and the Convex assembler index one text.
    pages: collected.files.map((file) => ({ path: file.path, body: file.sourceBody })),
    repoRules: record.repoRules ?? [],
    record,
    stableLayers,
    supplemental: record.supplemental ?? [],
  });
  const text = [prefix, parts.expanded, parts.fetchable].filter((part) => part !== "").join("\n\n");
  return {
    commit,
    subject,
    caller,
    prefix,
    expanded: parts.expanded,
    fetchable: parts.fetchable,
    manifest: parts.manifest,
    notes: parts.notes,
    shrink: parts.shrink,
    bytes: { prefix: Buffer.byteLength(prefix), ...parts.bytes, total: Buffer.byteLength(text) },
    text,
  };
}

/**
 * Every published `AGENTS.md` of one repo checkout, for the nightly post that
 * carries them into Convex (rule 9 needs their bodies, and Convex has no
 * filesystem). Read out of the immutable commit, like every other body here.
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

const VALUE_ARGS = ["--wikitom", "--commit", "--layers", "--for", "--record", "--caller"];

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
  const { wikitom, commit, layers, for: subject, record, caller } = values;
  if (wikitom === undefined) throw new PreludeError("--wikitom DIR is required");
  // The two modes are exclusive on purpose. `--layers` builds the nightly
  // publication's whole layers; `--for` builds ONE RUN's prompt, whose know
  // layer is never whole. A command asking for both is asking two questions.
  if (layers !== undefined && subject !== undefined) {
    throw new PreludeError("--for and --layers are mutually exclusive");
  }
  if (layers === undefined && subject === undefined) {
    throw new PreludeError("--layers operate,write,know or --for <subject> is required");
  }
  if (record !== undefined && subject === undefined) throw new PreludeError("--record needs --for");
  if (caller !== undefined && subject === undefined) throw new PreludeError("--caller needs --for");
  return { wikitom, commit, layers, subject, record, caller, json };
}

/**
 * `--record FILE` holds exactly the fields the Convex side passes in memory
 * (todos, batches, rulings, session outcomes, repo rules, and the New-York
 * calendar day). It exists so the CLI is testable against a fixture with no
 * deployment, and so the box can assemble without a Convex round trip.
 *
 * NEVER GUESS A RECORD: a `todo:` or `batch:` subject with no record is
 * refused, because a run that thinks it saw its subject's rulings and saw an
 * empty list is worse than a run that stops.
 */
function readRecord(file) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), "utf8");
  } catch (error) {
    throw new PreludeError(`cannot read --record ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PreludeError(`--record ${file} is not JSON: ${error.message}`);
  }
}

function main(argv) {
  const { json, subject, record, caller, layers, ...options } = parseArgs(argv);
  if (subject !== undefined) {
    if (record === undefined && subjectNeedsRecord(parseSubject(subject))) {
      throw new PreludeError(`--for ${subject} needs --record`);
    }
    const prelude = assembleContextPrelude({
      ...options,
      for: subject,
      caller: caller ?? "cli",
      record: record === undefined ? {} : readRecord(record),
    });
    if (json) {
      process.stdout.write(`${JSON.stringify({
        commit: prelude.commit,
        caller: prelude.caller,
        manifest: prelude.manifest,
        notes: prelude.notes,
        shrink: prelude.shrink,
        bytes: prelude.bytes,
      })}\n`);
    } else {
      process.stdout.write(`${prelude.text}\n`);
    }
    return;
  }
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
