// THE GRAPH GENERATOR: the half that touches a disk.
//
// NO SHEBANG. This file is always invoked as `node scripts/graph.mjs` and is
// not marked executable, and a test imports it through vite, whose transform
// prepends an import to the first line when a module uses a dynamic import —
// which this one does, for the vocabulary — and then cannot parse a shebang
// sitting beside it. A decorative shebang is not worth a test file that will
// not load.
//
// `worker/jobs/graph.mjs` decides what the graph IS, from already-read text, and
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
} from "../worker/jobs/graph.mjs";
import { buildSkills, isAreaPath } from "./skills.mjs";

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
 *  worker/jobs/graph.mjs's constants only, the vocabulary does not carry them,
 *  and the check compares against that file rather than against the spec. */
export const KIND_AUTHORITY = "vocabulary";

/** Tom's, pending (graph switch 2). "id-only": a record row enters graph.json
 *  as { kind, id, ref } and nothing else; its fields are read from Convex, or
 *  from the caller's own record, when the walk reaches it. "inline": the row's
 *  display text rides in the file too. */
export const RECORD_NODES = "id-only";

/** Tom's, pending (graph switch 3). "on": the five rejections are enforced by
 *  checks — no model-inferred edge, no vector index, no per-field nodes, no
 *  graph database, no hand-edited file. "off": they are advice in this comment
 *  and nothing fails. */
export const REJECTS = "on";

/** Tom's, pending (graph switch 4). "graph": the file and the walk are "the
 *  graph"; the vocabulary is its schema; "ontology" and "knowledge graph" are
 *  refused words. "map": the whole is called the map, of which today's map
 *  block is the root's rendering. */
export const NAME = "graph";

/** Tom's, pending (phase 10 switch (a)). "candidate": the generator writes
 *  agent-rules.candidate.md and a diff and never touches the live file — the
 *  hand-written map stays authoritative. "live": the four restating blocks of
 *  model-of-tom/agent-rules.md are replaced in place, with their evidence
 *  entries, and the file becomes partly generated.
 *
 *  ONE HOME. scripts/vocabulary.mjs writes the candidate, because the four
 *  blocks restate the vocabulary's repositories, questions, jobs and tools; the
 *  constant lives here because the candidate IS the root node's rendering and
 *  this is the graph's generator. It is imported there, never re-declared. */
export const MAP_BLOCKS = "candidate";

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

/** The six synthesis pages, in the order scripts/skills.mjs names them. */
const SYNTHESIS = Object.freeze([
  "model-of-tom/agent-rules.md",
  "model-of-tom/ground.md",
  "model-of-tom/intent.md",
  "model-of-tom/priorities.md",
  "model-of-tom/schedule.md",
  "model-of-tom/writing.md",
]);

const AREAS_DIRECTORY = "model-of-tom/areas";
const EVIDENCE_DIRECTORY = "model-of-tom/evidence";

/** The directories a repository's rules are never looked for in. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".claude",
  ".next",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vercel",
  ".turbo",
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
      const id = row._id ?? row.id;
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
 * generator writes nothing while its seven wording disagreements stand (see
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
 * writes nothing while its seven wording disagreements stand (see
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
export async function vocabularyFor({ wikitom, tomQuest, record }) {
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
    const built = module.generateVocabulary({ wikitom, tomQuest, record, write: false });
    return { vocabulary: built.vocabulary, from: "scripts/vocabulary.mjs (in memory; the file is not written)" };
  } catch (error) {
    return { vocabulary: null, from: `unavailable — ${String(error?.message ?? error)}` };
  }
}

function headCommit(dir) {
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
function disagreementsOf(graph, { vocabulary, bytes, pages, evidence, notes = [] }) {
  const found = [];

  // G1 / G2 — a kind nothing declares.
  const fromVocabulary = KIND_AUTHORITY === "vocabulary" && vocabulary !== null;
  const declaredNode = fromVocabulary ? vocabularyKinds(vocabulary, "node") : [];
  const declaredEdge = fromVocabulary ? vocabularyKinds(vocabulary, "edge") : [];
  const usingVocabulary = declaredNode.length > 0 && declaredEdge.length > 0;
  if (!usingVocabulary) {
    notes.push(
      `KIND_AUTHORITY is "${KIND_AUTHORITY}" but ${VOCABULARY_PATH} declares no node or edge kinds — `
        + "G1 and G2 checked against worker/jobs/graph.mjs's own lists instead",
    );
  }
  const declaredNodeKinds = usingVocabulary ? new Set(declaredNode) : new Set(NODE_KINDS);
  const declaredEdgeKinds = usingVocabulary ? new Set(declaredEdge) : new Set(EDGE_KINDS);
  for (const kind of [...new Set(graph.nodes.map((row) => row.kind))].sort()) {
    if (declaredNodeKinds.size > 0 && declaredNodeKinds.has(kind)) continue;
    if (declaredNodeKinds.size === 0) break;
    found.push(
      block("G1", `node kind "${kind}"`, [
        ["graph", `${graph.counts.byNodeKind[kind]} node(s) of this kind`],
        ["schema", KIND_AUTHORITY === "vocabulary" ? `${VOCABULARY_PATH} declares no such node kind` : "worker/jobs/graph.mjs NODE_KINDS does not list it"],
      ], "add the kind to spec §12.1 and regenerate the vocabulary, or stop minting it"),
    );
  }
  for (const kind of [...new Set(graph.edges.map((row) => row.kind))].sort()) {
    if (declaredEdgeKinds.size > 0 && declaredEdgeKinds.has(kind)) continue;
    if (declaredEdgeKinds.size === 0) break;
    found.push(
      block("G2", `edge kind "${kind}"`, [
        ["graph", `${graph.counts.byEdgeKind[kind]} edge(s) of this kind`],
        ["schema", KIND_AUTHORITY === "vocabulary" ? `${VOCABULARY_PATH} declares no such edge kind` : "worker/jobs/graph.mjs EDGE_KINDS does not list it"],
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

  // G7 — a `defines` edge from a term the vocabulary does not declare.
  //
  // IT CANNOT FIRE TODAY, AND THAT IS THE RIGHT SHAPE. Every `defines` edge is
  // minted from a `vocabulary.terms` row, so the two sets agree by
  // construction; the class is the guard for the day a second source starts
  // minting them, and it costs one pass over the edges.
  //
  // IT DOES NOT READ `applies-to`, and the brief's `fix` line — "an area page's
  // `categories:` names a word §12.1 does not" — describes a check this round
  // tried and withdrew. An area page's `categories:` names a TODO CATEGORY:
  // `climbing`, `dnd`, `therapy`, `weed`. Those are labels on Tom's life, not
  // words in the closed vocabulary of TTS, and they were never meant to be —
  // widening G7 to them reported all fifty-seven of them as disagreements on
  // the real vault, which is a checker being wrong about a namespace rather
  // than a vault being wrong about a word. The graph mints one `term` kind from
  // two namespaces, and telling them apart is a design question for Tom, not
  // something to decide inside a check.
  //
  // TRIMMED THEN LOWERCASED, the order worker/jobs/graph.mjs:termsOf uses: a
  // row spelled with surrounding whitespace draws its edges from the trimmed
  // id, and a set built without the trim would report a term the vocabulary
  // does define.
  if (vocabulary !== null) {
    const terms = new Set((vocabulary.terms ?? []).map((row) => `term:${String(row.term).trim().toLowerCase()}`));
    const undeclared = new Map();
    for (const edge of graph.edges) {
      if (edge.kind !== "defines" || terms.has(edge.from)) continue;
      if (!undeclared.has(edge.from)) undeclared.set(edge.from, []);
      undeclared.get(edge.from).push(edge);
    }
    for (const [term, edges] of [...undeclared.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      found.push(
        block("G7", `defines edges from ${term}`, [
          ["graph", `${edges.length} defines edge(s)`],
          ["read", [...new Set(edges.map((edge) => edge.evidence))].sort().join(", ")],
          ["schema", `${VOCABULARY_PATH} has no such term`],
        ], "a `defines` edge was minted from something other than a vocabulary row — find the second source"),
      );
    }
  }

  return found;
}

/**
 * The node and edge kinds the vocabulary declares.
 *
 * THE FALLBACK IS REPORTED, NEVER SILENT. Under `KIND_AUTHORITY = "vocabulary"`
 * the graph's schema is meant to be the vocabulary, so a kind the vocabulary
 * does not declare fails the build. `tts/vocabulary.json` does not carry kind
 * entries at this commit — the vocabulary generator reports seven wording
 * disagreements and writes nothing until they are settled — so there is nothing
 * to check against, and a check with nothing to check against is a check that
 * passes for the wrong reason. It falls back to `worker/jobs/graph.mjs`'s own
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
  const disagreements = disagreementsOf(graph, { vocabulary, bytes, pages, evidence, notes: graph.notes });

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
    const endings = (text) => text.split(CRLF).join(LF);
    const comparable = recordDir === null ? (text) => endings(staticOnly(text)) : endings;
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
    write: false, check: false, json: false,
    record: undefined, wikitom: undefined, tomQuest: undefined, repos: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--json") options.json = true;
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
  if (options.json) {
    out(JSON.stringify({
      version: result.version,
      recordVersion: result.recordVersion,
      counts: result.counts,
      bytes: result.bytes,
      cap: result.cap,
      changed: result.changed,
      notes: result.notes,
      disagreements: result.disagreements,
    }, null, 2));
  } else {
    out(report(result));
  }
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
  const schema = await vocabularyFor({
    wikitom,
    tomQuest: options.tomQuest,
    record: options.record === null ? null : undefined,
  });
  return main(argv, out, err, { vocabulary: schema.vocabulary });
}

if (invoked) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
