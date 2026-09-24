// THE GRAPH GENERATOR: the half that touches a disk.
//
// NO SHEBANG. This file is always invoked as `node scripts/graph.mjs` and is
// not marked executable, and a test imports it through vite, whose transform
// prepends an import to the first line when a module uses a dynamic import —
// which this one does, for the vocabulary — and then cannot parse a shebang
// sitting beside it. A decorative shebang is not worth a test file that will
// not load.
//
// `shared/graph.mjs` decides what the graph IS, from already-read text, and
// is pure so that the box, the laptop and the Convex runtime all compute the
// same bytes. This file reads the two checkouts and the night's table copy,
// calls `buildGraph`, serializes it, checks the cap, finds every disagreement,
// writes `WikiTom tts/graph.json`, and reports. That split is the one
// `context-relevance.mjs` and `ttsContext.ts` already use, for the same reason:
// everything that can fail because of a filesystem lives on one side of it.
//
// PARSE, NEVER EVALUATE. Node's TypeScript is not available on the box and
// `convex/*.ts` is TypeScript, so every tom.quest input is read as text: take
// the block, count the entries in it, assert the count against what parsed, and
// fail loudly on an entry the parser could not read rather than letting it
// vanish. There is no `import()` of a `.ts` file and no `eval` anywhere here.
//
// NO MODEL, NO NETWORK, NO CREDENTIAL. The generator reads two directories of
// text and one directory of `.jsonl` table copies. It opens no Convex
// connection: a generator that did would need a key, would be a second reader of
// prod in a job that already has one, and would make the file's contents depend
// on when in the night it ran. The record half is built from `tts/snapshot/`,
// which the nightly step before this one has just written, so it is exactly
// reproducible from the commit.
//
// Exit codes: 0 clean · 2 a disagreement, or `--check` found the disk out of
// date · 3 an input missing or unreadable, or the render over the cap.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EDGE_KINDS,
  GRAPH_MAX_BYTES,
  NODE_KINDS,
  RECORD_NODE_KINDS,
  buildGraph,
  kindOf,
  lineId,
  ruleNodeId,
  renderSkillBody,
  splitHalves,
} from "../shared/graph.mjs";
import { buildSkills, isAreaPath } from "../shared/skills.mjs";

// THE TWO WIKITOM DEFAULTS, SPELLED HERE, and this is a deviation with a reason.
//
// worker/jobs/search-lib.mjs owns the canonical spelling and the brief says to
// import its two constants rather than repeat them. Importing it drags a
// subtree: search-lib.mjs imports ./session-archive.mjs, which imports
// ../session-host/redact.mjs, and on the box these live in three different
// install directories, so a nested copy of search-lib.mjs needs a nested copy
// of everything under it or it throws at load and takes this generator with it.
// Two string constants are not worth a subtree. The same call was made, for the
// same reason, for worker/jobs/worker-env.mjs on this branch.
/** Spelled as constructed strings so that no tool which rewrites this file can
 * turn an escape into an actual line break — which is a thing that happened. */
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const LAPTOP_WIKITOM_DIR = "C:/Users/heffn/Desktop/WikiTom";
const BOX_WIKITOM_DIR = "/root/wikitom";

// ── Tom's four switches from the graph note ──────────────────────────────────
// Module constants, never environment variables: an environment override would
// let the box and the laptop write different files from one commit, and flipping
// a switch is a commit he can object to.

/** Tom's, pending (graph switch 1). "vocabulary": the node and edge kinds are
 *  spec §12.1 terms, they appear in vocabulary.json, and a node or edge of an
 *  undeclared kind fails the build. "loose": the kinds live in
 *  shared/graph.mjs's constants only, the vocabulary does not carry them,
 *  and the check compares against that file rather than against the spec. */
export const KIND_AUTHORITY = "vocabulary";

/** Tom's, pending (graph switch 2). "id-only": a record row enters graph.json
 *  as { kind, id, ref } and nothing else; its fields are read from Convex, or
 *  from the caller's own record, when the walk reaches it. "inline": the row's
 *  display text rides in the file too. */
export const RECORD_NODES = "id-only";

// THERE IS NO `REJECTS` SWITCH AND NO `NAME` SWITCH. Two constants stood here
// that read like both, and NOTHING EVER READ EITHER: the five rejections are
// enforced by check 7 of scripts/check-vocabulary.mjs and the name by its check
// 4, and neither check consults a constant. Setting either to its other value
// changed nothing at all — the "switch that reads as set and does nothing" that
// the RECORD_NODES throw below exists to prevent. A label claiming to be a
// setting is worse than no label, because it invites a ruling that would do
// nothing, so the labels are gone and what they claimed is written here.
//
// <refused-words>
// THE WHOLE IS CALLED THE GRAPH: the file and the walk are the graph, and the
// vocabulary is its schema. "ontology" and "knowledge graph" are refused words.
// Check 4 refuses them everywhere except the few places that must spell them to
// check or to test them, and this block is one of those places — which is why
// it is fenced by markers the check can find rather than by its position.
// </refused-words>
//
// THE FIVE REJECTIONS, all enforced and none optional: no model-inferred edge,
// no vector index, no per-field nodes, no graph database, and no hand-edited
// file. Check 7 scans the graph's two halves for the first four. The fifth is
// G8 in this file, which compares the render against the committed bytes — and
// it can pass now that the comparison no longer reads the commits the render
// happened to be taken at, without which it refused everything and so enforced
// nothing.

/** Tom's, pending (phase 10 switch (a)). "candidate": the generator renders
 *  the map's restating blocks and returns the diff, and writes no file — the
 *  hand-written map stays authoritative. "live": the four restating blocks of
 *  model-of-tom/agent-rules.md are replaced in place by the vocabulary
 *  generator's `--write`, and the file becomes partly generated.
 *
 *  ONE HOME. scripts/vocabulary.mjs renders the candidate, because the four
 *  blocks restate the vocabulary's repositories, questions, jobs and tools; the
 *  constant lives here because the candidate IS the root node's rendering and
 *  this is the graph's generator. It is imported there, never re-declared. */
export const MAP_BLOCKS = "candidate";

// REMOVAL CHECK: cannot remove while RECORD_NODES exists. "inline" is not
// built, so without this a flip would silently keep writing id-only rows —
// a switch that reads as set and does nothing. The throw is at module load so
// the flip fails on the commit that makes it rather than on a night.
if (RECORD_NODES !== "id-only") {
  throw new Error(
    `graph: RECORD_NODES "${RECORD_NODES}" is not built — a second copy of a record row in a generated `
      + "file is the drift the two-record rule forbids; see graph switch 2",
  );
}

// ── What the file is ─────────────────────────────────────────────────────────

export const GRAPH_PATH = "tts/graph.json";
export const VOCABULARY_PATH = "tts/vocabulary.json";
export const GENERATOR_VERSION = 1;

/** The seven synthesis pages, the set WikiTom's own scripts/check-evidence.mjs
 *  mirrors evidence against. A page it counts and this list does not is an
 *  evidence file with no page here, which is G4 below: explainers.md landed
 *  with the explainer skill, was a seventh page there and a sixth here, and
 *  failed the nightly's graph step on a vault that was correct. */
const SYNTHESIS = Object.freeze([
  "model-of-tom/agent-rules.md",
  "model-of-tom/explainers.md",
  "model-of-tom/ground.md",
  "model-of-tom/intent.md",
  "model-of-tom/priorities.md",
  "model-of-tom/schedule.md",
  "model-of-tom/writing.md",
]);

const AREAS_DIRECTORY = "model-of-tom/areas";
const EVIDENCE_DIRECTORY = "model-of-tom/evidence";

/** The directories a repository's rules are never looked for in — the ones a
 *  DOT does not already cover. `.git`, `.claude`, `.next`, `.vercel` and
 *  `.turbo` were listed here as well and are gone: the walk skips every
 *  dot-prefixed directory on the same line, so each was a second spelling of
 *  the same skip. Neither half subsumes the other — the dot rule does not
 *  reach `node_modules`, and no list reaches a dotted directory nobody has
 *  thought of yet — so both stay, and this one holds only what it earns. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

/** The record tables the file's record half is built from, and the field each
 * row's id lives in. The snapshot writes Convex's own `_id`. */
const RECORD_TABLES = Object.freeze({
  todos: "dtsTodos.jsonl",
  batches: "batches.jsonl",
  rulings: "dtsRulings.jsonl",
});

// ── Reading ──────────────────────────────────────────────────────────────────

class InputError extends Error {}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function requireDirectory(dir, what) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new InputError(`graph: ${what} is not a directory: ${dir}`);
  }
  return dir;
}

function readPages(wikitom) {
  const pages = [];
  for (const relative of SYNTHESIS) {
    const body = readIfPresent(path.join(wikitom, relative));
    if (body === null) throw new InputError(`graph: ${relative} is missing from ${wikitom}`);
    pages.push({ path: relative, body });
  }
  const areas = path.join(wikitom, AREAS_DIRECTORY);
  if (fs.existsSync(areas)) {
    for (const name of fs.readdirSync(areas).sort()) {
      if (!name.endsWith(".md")) continue;
      pages.push({ path: `${AREAS_DIRECTORY}/${name}`, body: fs.readFileSync(path.join(areas, name), "utf8") });
    }
  }
  return pages;
}

function readEvidence(wikitom) {
  const root = path.join(wikitom, EVIDENCE_DIRECTORY);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walkDir = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(dir, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walkDir(next, relative);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      // The candidate files are a proposal the generator itself wrote; reading
      // them back in would make the graph describe its own output.
      if (entry.name.includes(".candidate.")) continue;
      out.push({ path: relative, body: fs.readFileSync(next, "utf8") });
    }
  };
  walkDir(root, EVIDENCE_DIRECTORY);
  return out;
}

/** Every `AGENTS.md` of a checkout, root first, then by path. */
export function readRepoRules(dir, repo) {
  const out = [];
  const walkDir = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        walkDir(path.join(current, entry.name), prefix === "" ? entry.name : `${prefix}/${entry.name}`);
        continue;
      }
      if (entry.name !== "AGENTS.md") continue;
      const relative = prefix === "" ? "AGENTS.md" : `${prefix}/AGENTS.md`;
      out.push({ repo, path: relative, body: fs.readFileSync(path.join(current, entry.name), "utf8") });
    }
  };
  walkDir(dir, "");
  return out.sort((a, b) => (a.path === "AGENTS.md" ? -1 : b.path === "AGENTS.md" ? 1 : a.path.localeCompare(b.path)));
}

/**
 * The record half, from the night's table copy.
 *
 * READ-ONLY, ALWAYS, and only the four fields the edges are read from. A
 * snapshot row carries a whole ground-up explanation; under RECORD_NODES
 * "id-only" none of that enters the file, which is the two-record rule.
 */
export function readRecord(dir) {
  const record = { todos: [], batches: [], rulings: [] };
  for (const [key, file] of Object.entries(RECORD_TABLES)) {
    const text = readIfPresent(path.join(dir, file));
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new InputError(`graph: ${file} has a line that is not JSON`);
      }
      // REMOVAL CHECK on the skip: a `.jsonl` on disk is arbitrary input, and a
      // row with no id would otherwise mint `recordId("todo", undefined)` — a
      // `todo:undefined` node that G3 cannot refuse because it IS in `nodes`.
      // The `?? row.id` fallback beside it is GONE: the only writer of these
      // files is the nightly's snapshot step, which streams Convex export rows
      // carrying `_id`, and nothing in the tree has ever written a plain `id`.
      const id = row._id;
      if (typeof id !== "string") continue;
      record[key].push({
        id,
        status: row.status,
        batchId: typeof row.batchId === "string" ? row.batchId : undefined,
        todoId: typeof row.todoId === "string" ? row.todoId : undefined,
        category: typeof row.category === "string" ? row.category : undefined,
        needs: Array.isArray(row.needs) ? row.needs.filter((one) => typeof one === "string") : [],
      });
    }
  }
  return record;
}

/**
 * The schema, from the file when there is one and from the generator when there
 * is not.
 *
 * THE VOCABULARY IS THE GRAPH'S SCHEMA whether or not it has been written. It
 * supplies the `term`, `job`, `question` and `repo` nodes and every `defines`
 * edge; a graph built without it has no terms but the ones the area pages name
 * and no jobs or questions at all, which is a materially different file. The
 * generator writes nothing while any disagreement stands (see
 * worker/jobs/nightly.mjs graphStep), so a graph that could only read the file
 * would be thin for exactly as long as that takes to settle, for no reason —
 * the two are generated from one pair of commits in one step either way.
 *
 * The file still wins when it is there, because that is the object every other
 * reader gets, and a build that preferred its own computation could disagree
 * with `tts search define` about what a term is.
 */
function readVocabulary(wikitom) {
  const text = readIfPresent(path.join(wikitom, VOCABULARY_PATH));
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(`graph: ${VOCABULARY_PATH} is not JSON — regenerate it with scripts/vocabulary.mjs`);
  }
}

/**
 * The schema, in memory, when the file is not on disk.
 *
 * THE VOCABULARY IS THE GRAPH'S SCHEMA whether or not it has been written. It
 * supplies the `term`, `job`, `question` and `repo` nodes and every `defines`
 * edge; a graph built without it has only the terms the area pages name and no
 * jobs or questions at all, which is a materially thinner file. The generator
 * writes nothing while any disagreement stands (see
 * worker/jobs/nightly.mjs graphStep), and a graph that could only read the file
 * would be thin for exactly as long as that takes to settle, for no reason —
 * the two are generated from one pair of commits in one step either way.
 *
 * The FILE WINS when it is there, because that is the object every other reader
 * gets, and a build preferring its own computation could disagree with
 * `tts search define` about what a term is.
 *
 * Asynchronous and only here: `generateGraph` stays a synchronous function of
 * already-read text, and a caller that already holds the vocabulary — the
 * nightly does — passes it in and never loads this.
 */
// `record` is NOT a parameter here. The vocabulary renders from the spec and
// the code and reads no record row, so a record argument threaded through this
// function would be accepted and dropped — which is the one thing worse than
// not taking it.
export async function vocabularyFor({ wikitom, tomQuest }) {
  const onDisk = readVocabulary(wikitom);
  if (onDisk !== null) return { vocabulary: onDisk, from: VOCABULARY_PATH };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, "vocabulary.mjs");
  if (!fs.existsSync(candidate)) {
    return { vocabulary: null, from: "unavailable — scripts/vocabulary.mjs is not beside scripts/graph.mjs" };
  }
  try {
    const module = await import(pathToFileURL(candidate).href);
    if (typeof module.generateVocabulary !== "function") {
      return { vocabulary: null, from: "unavailable — scripts/vocabulary.mjs exports no generateVocabulary" };
    }
    const built = module.generateVocabulary({ wikitom, tomQuest, write: false });
    return { vocabulary: built.vocabulary, from: "scripts/vocabulary.mjs (in memory; the file is not written)" };
  } catch (error) {
    return { vocabulary: null, from: `unavailable — ${String(error?.message ?? error)}` };
  }
}

export function headCommit(dir) {
  // Parsed out of .git, never shelled out to: the generator runs in the nightly
  // under a lock and a `git` subprocess there is one more thing that can hang.
  try {
    const gitDir = path.join(dir, ".git");
    const stat = fs.statSync(gitDir);
    const root = stat.isDirectory()
      ? gitDir
      : path.resolve(dir, fs.readFileSync(gitDir, "utf8").replace(/^gitdir:\s*/, "").trim());
    const head = fs.readFileSync(path.join(root, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, "");
    const direct = readIfPresent(path.join(root, ref));
    if (direct !== null && /^[0-9a-f]{40}/.test(direct.trim())) return direct.trim().slice(0, 40);
    const packed = readIfPresent(path.join(root, "packed-refs")) ?? "";
    for (const line of packed.split("\n")) {
      const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim());
      if (match !== null && match[2] === ref) return match[1];
    }
    // A worktree's HEAD lives in the worktree's own gitdir, whose commondir
    // holds the packed refs; one more hop rather than a wrong answer.
    //
    // REMOVAL CHECK: null is not a good enough answer here, and a worktree is
    // not an edge case. A worktree's gitdir has no refs/heads and no
    // packed-refs of its own, so without this hop `headCommit` returns null for
    // EVERY branch built in one — and `blankCommits` fails the build on a null
    // rather than publishing a graph whose `generatedFrom` names no commit. The
    // branch this very line is being read on is that shape.
    const common = readIfPresent(path.join(root, "commondir"));
    if (common !== null) {
      const shared = path.resolve(root, common.trim());
      const there = readIfPresent(path.join(shared, ref));
      if (there !== null && /^[0-9a-f]{40}/.test(there.trim())) return there.trim().slice(0, 40);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * UTF-8, LF, two-space indent, trailing newline, keys in the order this file
 * lists them, arrays sorted by their first field with `localeCompare` and no
 * locale argument, no timestamps anywhere. The same rules the vocabulary uses,
 * because the two files are generated by one step out of one pair of commits
 * and a reader should not have to hold two serializations.
 */
export function serializeGraph(graph) {
  const body = {
    version: graph.version,
    recordVersion: graph.recordVersion,
    generatedFrom: graph.generatedFrom,
    nodeKinds: graph.nodeKinds,
    edgeKinds: graph.edgeKinds,
    nodes: graph.nodes.map(compact),
    edges: graph.edges.map(compact),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * EVERY COMMIT THE RENDER READ, BLANKED FOR A COMPARISON ONLY.
 *
 * A commit appears in three places: `generatedFrom.wikitomCommit`,
 * `generatedFrom.tomQuestCommit`, and the `version` field of every page and
 * skill node, which is the commit that node's text came from.
 *
 * NONE OF THEM CAN EVER MATCH ON A COMMITTED FILE. Writing tts/graph.json and
 * committing it produces a commit AFTER the one the generator read, so the file
 * records a commit it cannot itself be in; WikiTom's HEAD moves again on the
 * next night, and every tom.quest merge moves the other. Left in the comparison
 * they made `--check` report G8 forever on a file nobody had touched, and the
 * only fix it named — regenerate — moved HEAD once more. A check that cannot go
 * green cannot tell a hand edit from an ordinary night, which is all it is for.
 *
 * THIS IS THE RULE `canonical` ALREADY USES, and that is the point: it strips
 * each node's `version` before hashing, for the reason written above it, so the
 * graph's own version does not move when only a commit did. The byte comparison
 * now agrees with the hash about what "the same graph" means. The two were
 * written apart and only one of them had the rule.
 *
 * THE GRAPH'S OWN `version` IS NOT BLANKED. It sits at indent 2 and is the
 * content hash of everything here — the one field whose difference always means
 * the graph differs. A node's `version` is at indent 6, inside the nodes array.
 *
 * Done by substitution rather than a JSON round-trip so everything else stays
 * byte-for-byte: a hand edit that only moved whitespace is still a difference.
 *
 * `null` IS ONE OF THE VALUES. `headCommit` returns null when it cannot read a
 * HEAD — a worktree whose branch ref is packed is the case that exists — and
 * that null is written into the file unquoted. Matching only a quoted value
 * left a run that resolved the commit differing from one that did not, which is
 * the same false G8 by another route.
 */
function blankCommits(text) {
  return text
    .replace(/^( *"(?:wikitomCommit|tomQuestCommit)": )("[^"]*"|null)/gm, '$1""')
    .replace(/^( {4,}"version": )("[^"]*"|null)/gm, '$1""');
}

/** A serialized graph with every record-kind node and every edge touching one
 * removed, re-serialized the same way. Used only by `--check --no-record`. */
function staticOnly(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // Not JSON at all: report it as a whole-file difference.
  }
  const isRecord = (id) => RECORD_NODE_KINDS.includes(kindOf(id));
  return serializeGraph({
    version: parsed.version,
    // Blanked, not dropped: both say something about the record half, which
    // this comparison is deliberately blind to.
    recordVersion: "",
    generatedFrom: { ...parsed.generatedFrom, recordSource: "" },
    nodeKinds: parsed.nodeKinds,
    edgeKinds: parsed.edgeKinds,
    nodes: (parsed.nodes ?? []).filter((row) => !isRecord(row.id)),
    edges: (parsed.edges ?? []).filter((row) => !isRecord(row.from) && !isRecord(row.to)),
  });
}

function compact(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

// ── Disagreements ────────────────────────────────────────────────────────────

/**
 * ONE BLOCK PER DISAGREEMENT, in the shape the vocabulary generator prints, and
 * EVERY one of them before anything is written. A generator that stopped at the
 * first would make fixing a batch of them a batch of runs.
 */
function block(code, subject, rows, fix) {
  const lines = [`DISAGREEMENT ${code}  ${subject}`];
  for (const [label, text] of rows) {
    // A MULTI-LINE VALUE STARTS ON ITS OWN LINE, indented with the rest of
    // itself. Putting its first line beside the label and the rest eight
    // columns in makes a diff read as though its first hunk header belonged to
    // the label, and the diff is the one row where reading it wrongly costs
    // something.
    const parts = String(text).split(LF);
    if (parts.length === 1) {
      lines.push(`  ${label.padEnd(5)} ${parts[0]}`);
      continue;
    }
    lines.push(`  ${label}`);
    for (const more of parts) lines.push(`        ${more}`);
  }
  lines.push(`  fix   ${fix}`);
  return lines.join("\n");
}

/**
 * The eight graph classes. G4 is the evidence chain against
 * `WikiTom scripts/check-evidence.mjs`'s own invariant, computed the other way
 * round: the checker stays the gate on the two records and is never called from
 * here, because it has to keep working with the graph absent and a generator
 * re-implementing it would be a second authority on what an entry is.
 */
function disagreementsOf(graph, { vocabulary, vocabularySource, bytes, pages, evidence, notes = [] }) {
  const found = [];

  // G1 / G2 — a kind nothing declares.
  const fromVocabulary = KIND_AUTHORITY === "vocabulary" && vocabulary !== null;
  const declaredNode = fromVocabulary ? vocabularyKinds(vocabulary, "node") : [];
  const declaredEdge = fromVocabulary ? vocabularyKinds(vocabulary, "edge") : [];
  const usingVocabulary = declaredNode.length > 0 && declaredEdge.length > 0;
  if (!usingVocabulary) {
    // WHY THERE IS NO SCHEMA, not only that there is none. `vocabularyFor`
    // knows which of four things happened — the file was read off disk, it was
    // built in memory, scripts/vocabulary.mjs is not installed beside this
    // file, or importing it threw — and its sentence used to be dropped on the
    // floor by runCli. A run then fell back to the generator's own kind lists
    // and said only that it had, which reads as a vocabulary with no kinds in
    // it rather than as a generator that failed to load.
    notes.push(
      `KIND_AUTHORITY is "${KIND_AUTHORITY}" but ${VOCABULARY_PATH} declares no node or edge kinds — `
        + "G1 and G2 checked against shared/graph.mjs's own lists instead"
        + (vocabularySource ? ` (schema from: ${vocabularySource})` : ""),
    );
  }
  const declaredNodeKinds = usingVocabulary ? new Set(declaredNode) : new Set(NODE_KINDS);
  const declaredEdgeKinds = usingVocabulary ? new Set(declaredEdge) : new Set(EDGE_KINDS);
  for (const kind of [...new Set(graph.nodes.map((row) => row.kind))].sort()) {
    if (declaredNodeKinds.has(kind)) continue;
    found.push(
      block("G1", `node kind "${kind}"`, [
        ["graph", `${graph.counts.byNodeKind[kind]} node(s) of this kind`],
        ["schema", KIND_AUTHORITY === "vocabulary" ? `${VOCABULARY_PATH} declares no such node kind` : "shared/graph.mjs NODE_KINDS does not list it"],
      ], "add the kind to spec §12.1 and regenerate the vocabulary, or stop minting it"),
    );
  }
  for (const kind of [...new Set(graph.edges.map((row) => row.kind))].sort()) {
    if (declaredEdgeKinds.has(kind)) continue;
    found.push(
      block("G2", `edge kind "${kind}"`, [
        ["graph", `${graph.counts.byEdgeKind[kind]} edge(s) of this kind`],
        ["schema", KIND_AUTHORITY === "vocabulary" ? `${VOCABULARY_PATH} declares no such edge kind` : "shared/graph.mjs EDGE_KINDS does not list it"],
      ], "add the kind to spec §12.1 and regenerate the vocabulary, or stop minting it"),
    );
  }

  // G3 — an edge whose end names no node.
  const ids = new Set(graph.nodes.map((row) => row.id));
  const dangling = new Map();
  for (const edge of graph.edges) {
    for (const end of [edge.from, edge.to]) {
      if (ids.has(end)) continue;
      // A record-kind end is addressable and lives on the run row or in Convex,
      // never in the file; that is switch 2 and not a disagreement.
      if (RECORD_NODE_KINDS.includes(kindOf(end))) continue;
      if (!dangling.has(end)) dangling.set(end, { edge, count: 0 });
      dangling.get(end).count += 1;
    }
  }
  for (const [end, seen] of [...dangling.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    found.push(
      block("G3", `edge end ${end}`, [
        ["edge", `${seen.edge.kind} ${seen.edge.from} → ${seen.edge.to}`],
        ["read", seen.edge.evidence],
        ["count", `${seen.count} edge(s) name it`],
      ], "the node was never minted — the input that should carry it is missing or unparsed"),
    );
  }

  // G4 — the evidence chain, against check-evidence.mjs's invariant.
  for (const row of evidenceDisagreements(graph, pages, evidence)) found.push(row);

  // G5 — two different texts hashing alike.
  //
  // REMOVAL CHECK: widening the id is the alternative, and it is not one. Node
  // ids are hash8 over a few thousand lines, and a collision has actually been
  // found (scripts/graph.test.mjs pins line:0adf80f7). Widening every id would
  // make the collision rarer, not impossible, and would cost bytes on a file
  // that already has a cap; this names the two texts and asks for one of them
  // to change, which is the fix a reader can make.
  for (const clash of graph.collisions ?? []) {
    found.push(
      block("G5", `node id ${clash.id}`, [
        ["first", `${clash.first.path}\n${clash.first.normalized}`],
        ["second", `${clash.second.path}\n${clash.second.normalized}`],
      ], "a hash8 collision — widen the id or change one of the two lines"),
    );
  }

  // G6 — over the cap.
  if (bytes > GRAPH_MAX_BYTES) {
    const largest = Object.entries(graph.counts.byNodeKind).sort((a, b) => b[1] - a[1])[0];
    found.push(
      block("G6", `${GRAPH_PATH} is ${bytes.toLocaleString("en-US")} bytes`, [
        ["cap", `${GRAPH_MAX_BYTES.toLocaleString("en-US")} bytes`],
        ["largest", `${largest?.[0] ?? "—"} (${largest?.[1] ?? 0} nodes)`],
        ["nodes", JSON.stringify(graph.counts.byNodeKind)],
        ["edges", JSON.stringify(graph.counts.byEdgeKind)],
      ], "the cap is the structural-change alarm — something new is in the file, not something bigger"),
    );
  }

  // THERE IS NO G7, and there was. It looked for a `defines` edge whose term
  // the vocabulary does not declare. Every `defines` edge is minted FROM a
  // `vocabulary.terms` row (shared/graph.mjs addDefines), so the two sets
  // agree by construction and no input could separate them — its own comment
  // and its own test both said so, and the test asserted its silence. A check
  // that cannot fire is a check nobody can act on and nobody can trust; the day
  // a second source starts minting `defines` edges is the day to write it,
  // against that source.

  return found;
}

/**
 * The node and edge kinds the vocabulary declares.
 *
 * THE FALLBACK IS REPORTED, NEVER SILENT. Under `KIND_AUTHORITY = "vocabulary"`
 * the graph's schema is meant to be the vocabulary, so a kind the vocabulary
 * does not declare fails the build. `tts/vocabulary.json` does not carry kind
 * entries at this commit — the vocabulary generator writes nothing while a
 * disagreement or its byte cap stands — so there is nothing
 * to check against, and a check with nothing to check against is a check that
 * passes for the wrong reason. It falls back to `shared/graph.mjs`'s own
 * lists, which is what `"loose"` means, and the build's notes say so, so a
 * reader of the report knows which authority actually ran.
 */
function vocabularyKinds(vocabulary, which) {
  const rows = vocabulary?.terms ?? [];
  const wanted = `${which}-kind`;
  return rows.filter((row) => row?.kind === wanted).map((row) => String(row.term));
}

/**
 * G4. For every `line` node born of a synthesis file there is exactly one
 * `evidence` node with an `evidences` edge to it, and for every `evidence` node
 * exactly one line. Checked per file, because that is the shape check-evidence
 * checks and a whole-vault count would hide a file whose two errors cancel.
 */
function evidenceDisagreements(graph, pages, evidence) {
  const out = [];
  const byId = new Map(graph.nodes.map((row) => [row.id, row]));
  for (const file of evidence) {
    const source = file.path.replace(`${EVIDENCE_DIRECTORY}/`, "model-of-tom/");
    // `evidence/repos/` and `evidence/handoffs.md` have no synthesis
    // counterpart — check-evidence.mjs checks only their entry form, and so
    // does the graph.
    if (file.path.startsWith(`${EVIDENCE_DIRECTORY}/repos/`)) continue;
    if (file.path.endsWith("/handoffs.md")) continue;
    const page = pages.find((candidate) => candidate.path === source);
    if (page === undefined) {
      out.push(
        block("G4", file.path, [
          ["entry", `the evidence file names ${source}`],
          ["page", "which is not one of the synthesis files"],
        ], "run `node scripts/check-evidence.mjs` from the WikiTom root and fix the record, not the graph"),
      );
      continue;
    }
    const entriesHere = graph.nodes.filter((row) => row.kind === "evidence" && row.path === file.path);
    const orphans = entriesHere.filter((row) => {
      const line = byId.get(lineId(row.text));
      const rule = byId.get(ruleNodeId(row.text));
      return line === undefined && rule === undefined;
    });
    // REMOVAL CHECK on the cap: it bounds the OUTPUT, not the check. An
    // evidence file that drifted wholesale — a synthesis page rewritten with
    // its entries left behind — orphans every entry it holds, and without the
    // cap G4 alone would push hundreds of blocks into a nightly report whose
    // whole value is that Tom reads it. The count below is the part that must
    // not be truncated, and it is not.
    for (const orphan of orphans.slice(0, 12)) {
      out.push(
        block("G4", `${file.path} entry ${orphan.id}`, [
          ["entry", orphan.text],
          ["page", `${source} has no line with this text`],
        ], "run `node scripts/check-evidence.mjs` from the WikiTom root and fix the record, not the graph"),
      );
    }
    if (orphans.length > 12) {
      out.push(
        block("G4", file.path, [
          ["entry", `${orphans.length} entries name no line of ${source}`],
          ["shown", "the first twelve are above"],
        ], "run `node scripts/check-evidence.mjs` from the WikiTom root and fix the record, not the graph"),
      );
    }
  }
  return out;
}

// ── The generator ────────────────────────────────────────────────────────────

/**
 * @param {{ wikitom: string, tomQuest?: string, record?: string|null,
 *           write?: boolean, check?: boolean }} options
 */
export function generateGraph(options) {
  const wikitom = requireDirectory(path.resolve(options.wikitom), "the WikiTom checkout");
  const tomQuest = path.resolve(options.tomQuest ?? defaultTomQuest());
  requireDirectory(tomQuest, "the tom.quest checkout");
  const recordDir = options.record === null ? null : path.resolve(options.record ?? path.join(wikitom, "tts", "snapshot"));

  const pages = readPages(wikitom);
  const evidence = readEvidence(wikitom);
  const repoRules = [
    ...readRepoRules(tomQuest, "tom.quest"),
    ...(options.repos ?? []).flatMap((entry) => readRepoRules(path.resolve(entry.dir), entry.repo)),
  ];
  // The caller may hand the schema in — the nightly has just built it — and
  // otherwise it is the file on disk. `vocabularyFor` above is the async
  // fallback a command line uses when neither is there.
  const vocabulary = options.vocabulary !== undefined ? options.vocabulary : readVocabulary(wikitom);
  // A MISSING SNAPSHOT IS AN EMPTY RECORD, NOT A BROKEN INPUT — unless the
  // caller named one. The default is the table copy beside the vault, and a
  // checkout that has never run the nightly simply does not have it; a
  // generator that exited 3 there could not run on a fresh clone, and
  // `--check` in CI would fail for a reason that has nothing to do with the
  // change under review. A directory the caller named explicitly and that is
  // not there is still an error, because that one is a typo.
  const record = recordDir === null
    ? {}
    : options.record !== undefined
      ? readRecord(requireDirectory(recordDir, "the record copy"))
      : fs.existsSync(recordDir)
        ? readRecord(recordDir)
        : {};

  const built = buildSkills({
    commit: headCommit(wikitom) ?? "unknown",
    pages,
    repos: [
      { repo: "tom.quest", files: repoRules.filter((f) => f.repo === "tom.quest"), commit: headCommit(tomQuest) ?? undefined },
      ...(options.repos ?? []).map((entry) => ({
        repo: entry.repo,
        files: repoRules.filter((f) => f.repo === entry.repo),
        commit: headCommit(path.resolve(entry.dir)) ?? undefined,
      })),
    ],
    agentRules: pages.find((page) => page.path === "model-of-tom/agent-rules.md")?.body,
  });

  const graph = buildGraph({
    pages,
    evidence,
    repoRules,
    vocabulary,
    skills: built.skills,
    record,
    commits: { wikitom: headCommit(wikitom), tomQuest: headCommit(tomQuest) },
  });

  graph.generatedFrom = {
    wikitomCommit: headCommit(wikitom),
    tomQuestCommit: headCommit(tomQuest),
    vocabularyVersion: vocabulary?.version ?? null,
    // THE REPOSITORIES THIS BUILD READ, so a later `--check` can say whether it
    // is looking at the same file. The static half's content depends on the
    // set: a run given `--repo ComplexMultiTrigger=<dir>` mints that
    // repository's rule and page nodes and a run without it does not, and a
    // checker that compared the two would report a hand edit that never
    // happened.
    repos: [...new Set(repoRules.map((file) => file.repo))].sort((a, b) => a.localeCompare(b)),
    recordSource: recordDir === null || !fs.existsSync(recordDir) ? "none" : path.basename(recordDir),
    generator: "scripts/graph.mjs",
    generatorVersion: GENERATOR_VERSION,
  };

  const rendered = serializeGraph(graph);
  const bytes = Buffer.byteLength(rendered, "utf8");
  const disagreements = disagreementsOf(graph, { vocabulary, vocabularySource: options.vocabularySource, bytes, pages, evidence, notes: graph.notes });

  const file = path.join(wikitom, GRAPH_PATH);
  const onDisk = readIfPresent(file);
  const changed = [];
  let wrote = false;

  if (options.check === true) {
    // `--check --no-record` COMPARES THE STATIC HALF, not the whole file.
    //
    // That is what makes the check runnable anywhere. The record half needs the
    // night's table copy, which a laptop checkout and a CI runner do not have,
    // and it changes every night by construction; the static half is the half a
    // pull request can change. Comparing the whole file without the record
    // would report a difference every time, which is a check nobody obeys.
    // LINE-ENDING BLIND, for the reason `hash16` gives: one commit is CRLF on
    // the laptop and LF on the box, and a check that failed on every laptop is
    // a check nobody obeys.
    //
    // AND BLIND TO THE TWO COMMIT FIELDS, for the reason blankCommits gives:
    // a committed file records a commit it cannot be in, so comparing them made
    // this check fail forever on a file nobody edited. WHAT IS COMPARED, then,
    // is every node, every edge, both kind lists, the version, the repository
    // set and the generator — everything the render decides — and not the two
    // HEADs it happened to read.
    const endings = (text) => text.split(CRLF).join(LF);
    const comparable = recordDir === null
      ? (text) => blankCommits(endings(staticOnly(text)))
      : (text) => blankCommits(endings(text));
    const left = onDisk === null ? null : comparable(onDisk);
    const right = comparable(rendered);
    // A DIFFERENT REPOSITORY SET IS A SKIP, NOT A DIFFERENCE. The file names
    // the repositories it was built from; an invocation that cannot reach the
    // same ones cannot render the same bytes, and reporting that as a hand edit
    // would be the checker blaming the file for the caller's arguments. The
    // skip is printed so it is visible rather than silent.
    let skipped = null;
    if (onDisk !== null) {
      let theirs = null;
      try {
        theirs = JSON.parse(onDisk)?.generatedFrom?.repos ?? null;
      } catch {
        theirs = null;
      }
      const ours = graph.generatedFrom.repos;
      // REMOVAL CHECK: cannot remove; the static half's CONTENT depends on which
      // repositories the run was given — a build with `--repo
      // ComplexMultiTrigger=<dir>` mints that repo's rule and page nodes and a
      // build without it does not. Comparing the two and calling the difference
      // a hand edit is the false failure this skip exists to prevent, and a
      // false `--check` is worse than no `--check`: the fix it names is to
      // regenerate, which would overwrite a correct file with a narrower one.
      if (Array.isArray(theirs) && theirs.join(",") !== ours.join(",")) {
        skipped = `the file was built from [${theirs.join(", ")}] and this run reads [${ours.join(", ")}]`;
        graph.notes.push(
          `--check skipped: ${skipped} — pass the same --repo NAME=DIR arguments to compare them`,
        );
      }
    }
    if (skipped === null && left !== right) {
      disagreements.push(
        block("G8", recordDir === null ? `${GRAPH_PATH} (static half)` : GRAPH_PATH, [
          ["disk", onDisk === null ? "the file is absent" : `${Buffer.byteLength(onDisk, "utf8").toLocaleString("en-US")} bytes`],
          ["render", `${bytes.toLocaleString("en-US")} bytes`],
          ["diff", firstDifference(left ?? "", right)],
        ], "regenerate with `node scripts/graph.mjs --wikitom <dir> --write`; the file is never hand-edited"),
      );
    }
  }

  if (options.write === true && disagreements.length === 0) {
    if (onDisk !== rendered) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rendered, "utf8");
      changed.push(GRAPH_PATH);
      wrote = true;
    }
  }

  return {
    version: graph.version,
    recordVersion: graph.recordVersion,
    counts: graph.counts,
    collisions: graph.collisions ?? [],
    notes: graph.notes ?? [],
    bytes,
    cap: GRAPH_MAX_BYTES,
    changed,
    wrote,
    disagreements,
    report: disagreements.join("\n\n"),
    graph,
    skills: built.skills,
    pages,
    repoRules,
    vocabulary,
    record,
    rendered,
  };
}

/** A unified-ish first difference, truncated, so a `--check` failure says WHERE
 * rather than only that the bytes differ. */
function firstDifference(a, b, budget = 2_000) {
  const left = a.split("\n");
  const right = b.split("\n");
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] === right[index]) continue;
    const lines = [`@@ line ${index + 1} @@`];
    for (let near = Math.max(0, index - 2); near < Math.min(limit, index + 3); near += 1) {
      if (left[near] !== right[near]) {
        if (left[near] !== undefined) lines.push(`-${left[near]}`);
        if (right[near] !== undefined) lines.push(`+${right[near]}`);
      } else if (left[near] !== undefined) {
        lines.push(` ${left[near]}`);
      }
    }
    return lines.join("\n").slice(0, budget);
  }
  return "(the files differ only in length)";
}

// REMOVAL CHECK: the header's rule against environment overrides is about the
// SWITCHES — KIND_AUTHORITY and the rest, which decide what the file says and
// must read the same on the box and the laptop. This is not a switch, it is
// WHICH CHECKOUT, and the same variable is honoured by worker/jobs/nightly.mjs,
// worker/jobs/weekly.mjs, scripts/vocabulary.mjs, scripts/session-start-hook.mjs
// and scripts/laptop-setup.mjs. Deleting it here alone would leave the two
// generators disagreeing about which tom.quest they are reading, which is the
// one failure a shared override exists to prevent.
function defaultTomQuest() {
  if (typeof process.env.TOM_QUEST_DIR === "string" && process.env.TOM_QUEST_DIR !== "") {
    return process.env.TOM_QUEST_DIR;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** The same resolution worker/jobs/search-lib.mjs performs. */
export function defaultWikitom(env = process.env) {
  if (typeof env.WIKITOM_DIR === "string" && env.WIKITOM_DIR !== "") return env.WIKITOM_DIR;
  return process.platform === "win32" ? LAPTOP_WIKITOM_DIR : BOX_WIKITOM_DIR;
}

// ── The command line ─────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    write: false, check: false,
    record: undefined, wikitom: undefined, tomQuest: undefined, repos: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--no-record") options.record = null;
    else if (arg === "--wikitom") options.wikitom = argv[++index];
    else if (arg === "--tom-quest") options.tomQuest = argv[++index];
    else if (arg === "--record") options.record = argv[++index];
    else if (arg === "--repo") {
      // `--repo NAME=DIR`, the same spelling scripts/publish-skills.mjs takes,
      // so the nightly names a repository once and both generators read it.
      const [name, dir] = String(argv[++index] ?? "").split("=");
      if (!name || !dir) throw new InputError("graph: --repo takes NAME=DIR");
      (options.repos ??= []).push({ repo: name, dir });
    }
    else throw new InputError(`graph: ${arg} is not an argument of scripts/graph.mjs`);
  }
  return options;
}

function report(result) {
  const lines = [];
  lines.push(
    `graph: version ${result.version} · record ${result.recordVersion} · `
      + `${result.counts.nodes.toLocaleString("en-US")} nodes · ${result.counts.edges.toLocaleString("en-US")} edges · `
      + `${result.bytes.toLocaleString("en-US")}/${result.cap.toLocaleString("en-US")} bytes`,
  );
  lines.push("");
  lines.push("nodes by kind");
  for (const [kind, count] of Object.entries(result.counts.byNodeKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind.padEnd(10)} ${String(count).padStart(6)}`);
  }
  lines.push("edges by kind");
  for (const [kind, count] of Object.entries(result.counts.byEdgeKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind.padEnd(10)} ${String(count).padStart(6)}`);
  }
  if (result.notes.length > 0) {
    lines.push("");
    lines.push(`notes (${result.notes.length})`);
    for (const note of result.notes) lines.push(`  ${note}`);
  }
  if (result.disagreements.length > 0) {
    lines.push("");
    lines.push(result.report);
    lines.push("");
    lines.push(
      `graph: ${result.disagreements.length} disagreement${result.disagreements.length === 1 ? "" : "s"} — nothing written.`,
    );
  } else if (result.wrote) {
    lines.push("");
    lines.push(`graph: wrote ${GRAPH_PATH}`);
  } else {
    lines.push("");
    lines.push(`graph: ${GRAPH_PATH} is already what the render produces`);
  }
  return lines.join("\n");
}

/**
 * The command line. SYNCHRONOUS, because a caller wants an exit code and not a
 * promise, and because `generateGraph` is a synchronous function of already-read
 * text. The one asynchronous thing — loading the vocabulary generator when the
 * file is not on disk — happens in `runCli` below and is handed in here.
 */
export function main(argv = process.argv.slice(2), out = console.log, err = console.error, given = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(String(error.message ?? error));
    return 3;
  }
  const wikitom = options.wikitom ?? defaultWikitom();
  let result;
  try {
    result = generateGraph({ ...options, wikitom, ...given });
  } catch (error) {
    err(String(error.message ?? error));
    return 3;
  }
  out(report(result));
  // THE CAP'S CODE WINS OVER THE DISAGREEMENT'S. Over the cap is both a G6
  // disagreement and an unusable render, and the two codes mean different
  // things: 2 is "something disagrees, fix it"; 3 is "an input is wrong, or the
  // file will not fit". A caller handed 2 for a three-megabyte render would go
  // looking for a wording conflict, which is the one thing it is not.
  if (result.bytes > result.cap) return 3;
  if (result.disagreements.length > 0) return 2;
  return 0;
}

/** The skill bodies, rendered from their subgraphs — the byte-identity proof of
 * §11.3, exported so the test and the CLI compute it one way. */
export function skillBodies(result) {
  return result.skills.map((skill) => ({
    name: skill.name,
    published: skill.body,
    rendered: renderSkillBody(result.graph, skill),
  }));
}

export { splitHalves, isAreaPath };

const invoked = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
/**
 * What a command line runs: resolve the schema — the file when it is there, the
 * generator in memory when it is not — then call `main` with it.
 *
 * Split from `main` so that `main` stays synchronous. A test drives `main`
 * directly and gets an exit code; only the command line pays for the await.
 */
export async function runCli(argv = process.argv.slice(2), out = console.log, err = console.error) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(String(error.message ?? error));
    return 3;
  }
  const wikitom = options.wikitom ?? defaultWikitom();
  const schema = await vocabularyFor({ wikitom, tomQuest: options.tomQuest });
  return main(argv, out, err, { vocabulary: schema.vocabulary, vocabularySource: schema.from });
}

if (invoked) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
