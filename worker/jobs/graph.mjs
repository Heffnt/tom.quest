// THE GRAPH: every durable thing the system names as a NODE, every stated link
// between two of them as an EDGE, and the budgeted WALK that reads outward from
// one node.
//
// Tom's ruling, 2026-09-12: "Graphs are very powerful for the type of
// progressive disclosure we are doing for agent context so nodes in graphs
// should be the fundamental building block of contact in uae." The node is the
// unit. A line of a synthesis file is a node; so is a rule of an AGENTS.md, a
// heading, a page, an area, a term, a skill, a repository, a job, a search
// question, an evidence entry, a source, and a row of the record.
//
// NO EDGE IS INFERRED. Every one comes from a field that exists or a line that
// exists, and carries a short `evidence` pointer naming where it was read — a
// file and a heading, a table and a column, or a named rule of this file. There
// is no model here, no network, no embedding and no vector: an edge whose
// provenance is a named regex is auditable, and one with no provenance is
// indistinguishable from one a model wrote.
//
// THIS FILE IS PURE. No node:fs, no node:path, no node:child_process, no Buffer
// and no network. scripts/graph.mjs is the half that touches a disk; this half
// is a function of already-read text, so the Convex runtime and the box and the
// laptop can all run it and get the same bytes. That is also why the hash lives
// in graph-hash.mjs in plain JavaScript rather than in node:crypto.
//
// INTEGER ARITHMETIC ONLY in the walk. The selection sits inside a cached prompt
// prefix and has to be byte-identical on two machines; integer costs with a
// total tie-break are, and a score built from multiplied fractions is not,
// because two runtimes may round the last bit differently.
//
// WHAT THIS IS NOT: a graph database, a vector index, a model writing its own
// actions into a store, or graphify. The one shape borrowed from outside is the
// budgeted walk.

import { hash8, ruleId, sha256Hex } from "./graph-hash.mjs";
import { parseFrontmatter } from "./markdown-sections.mjs";
import { AREAS_DIR, areaCategories, areaName, isAreaPath } from "../../scripts/skills.mjs";

export class GraphError extends Error {}

// ── The kinds ────────────────────────────────────────────────────────────────

/**
 * THE TWELVE NODE KINDS born of a file or the vocabulary, plus the five RECORD
 * kinds. Closed: a node of any other kind fails the build (G1).
 *
 * Under KIND_AUTHORITY = "vocabulary" this list is also checked against
 * tts/vocabulary.json, so the graph's schema and the vocabulary are one object
 * rather than two lists that agree today.
 */
export const STATIC_NODE_KINDS = Object.freeze([
  "area",
  "evidence",
  "heading",
  "job",
  "line",
  "page",
  "question",
  "repo",
  "rule",
  "skill",
  "source",
  "term",
]);

/**
 * The record kinds. `todo`, `batch` and `ruling` enter the file as ids only;
 * `run` and `outcome` are never rows in the file at all — they are addressable
 * and their edges live on the run row in Convex, which is already the one home
 * for every per-run fact.
 */
export const RECORD_NODE_KINDS = Object.freeze(["batch", "outcome", "ruling", "run", "todo"]);

export const NODE_KINDS = Object.freeze([...new Set([...STATIC_NODE_KINDS, ...RECORD_NODE_KINDS])].sort());

/** THE ELEVEN EDGE KINDS. Closed: an edge of any other kind fails the build (G2). */
export const EDGE_KINDS = Object.freeze([
  "applies-to",
  "continues",
  "defines",
  "depends-on",
  "evidences",
  "given",
  "labeled",
  "member-of",
  "mentions",
  "spawned",
  "supersedes",
]);

/**
 * The order a walk's admitted nodes are RENDERED in, and the first half of the
 * tie-break when two nodes cost the same.
 *
 * It is not cost order. A page all of whose lines are admitted must render
 * byte-identically to that page, which means placement comes from the file's own
 * structure and never from what the walk happened to reach first.
 */
export const RENDER_ORDER = Object.freeze([
  "area",
  "page",
  "heading",
  "line",
  "rule",
  "skill",
  "term",
  "repo",
  "job",
  "question",
  "todo",
  "batch",
  "ruling",
  "run",
  "outcome",
  "evidence",
  "source",
]);

const RENDER_RANK = Object.freeze(
  Object.fromEntries(RENDER_ORDER.map((kind, index) => [kind, index])),
);

// ── The weights ──────────────────────────────────────────────────────────────

/**
 * EDGE WEIGHTS. `cost(edge) = 1000 - weight(edge)`; a node's cost is the least
 * total cost over any path from any seed; the walk is Dijkstra over that.
 *
 * The order these encode, read out: the first area page beats everything; the
 * root AGENTS.md and the todo's own rulings come next; the second area page,
 * the intent sections and the schedule bullets follow; nested AGENTS.md files,
 * the batch's rulings and the session outcomes are last in and first out. That
 * is the retired EXPAND_SHRINK order read backwards, which is how it should be:
 * the shrink order was Tom's judgement about what a run can most afford to lose.
 *
 * The key is `<edge kind>/<variant>`; the builder stamps the resolved number
 * onto the edge, so a reader of tts/graph.json sees the weight without holding
 * this table. `walk`'s `weights` argument overrides by kind or by full key.
 */
export const WEIGHTS = Object.freeze({
  "member-of/todo-area-exact": 1000,
  "member-of/todo-area-term": 940,
  "member-of/line-heading": 900,
  "member-of/heading-page": 900,
  "member-of/page-area": 900,
  "member-of/line-skill": 560,
  "member-of/heading-skill": 560,
  "member-of/page-skill": 560,
  "member-of/todo-batch": 780,
  "member-of/outcome-batch": 600,
  "applies-to/caller-priorities": 880,
  "applies-to/page-repo-root": 870,
  "applies-to/page-repo-nested": 700,
  "applies-to/area-term": 480,
  "labeled/ruling-own-todo": 860,
  "labeled/ruling-batch": 700,
  "defines/area-term-intent-line": 820,
  "defines/term-line": 500,
  "defines/term-rule": 500,
  "defines/term-skill": 500,
  "mentions/token-rules-file": 800,
  "mentions/token-page": 640,
  "depends-on/todo-todo": 680,
  "depends-on/batch-batch": 680,
  "evidences/entry-line": 200,
  "evidences/source-entry": 180,
  "supersedes/line-line": 100,
  "given/run-node": 0, // never traversed by a prelude walk
  "spawned/run-run": 900,
  "continues/run-run": 900,
});

/** The weight an edge kind takes when the table names no variant for it. */
const DEFAULT_WEIGHT = 500;

/** Seeds, by what the task is. A seed's cost is `1000 - weight`. */
export const SEED_WEIGHTS = Object.freeze({
  task: 1000, // the todo, batch, area or repo the run is for
  caller: 980, // the CONTEXT_CALLERS row
  repo: 900,
  dueDay: 850, // one per schedule weekday the todo owes
  pathToken: 800, // one per token pathTokens() found in the brief
  term: 700, // one per vocabulary term the brief names
});

// ── Caps ─────────────────────────────────────────────────────────────────────

/**
 * The byte cap on the serialized file, and the arithmetic behind it, so the
 * number is arguable rather than arbitrary.
 *
 * MEASURED, not estimated, on the `uae` branch and the 2026-09-12 table copy:
 * the STATIC half is 1,437 nodes and 1,754 edges at 805,000 bytes — 286 lines
 * of the six synthesis files, 109 rules across tom.quest's six `AGENTS.md`, 83
 * headings, 429 evidence entries and 430 sources carrying his own words
 * verbatim, 59 terms, 20 pages, 12 skills, 8 areas. The RECORD half adds 1,497
 * id-only nodes and about 2,000 edges at 651,000 bytes: 1,332 active todos, 160
 * batches, 5 rulings and their `needs`. Together, 1,456,000 bytes.
 *
 * THE PHASE BRIEF ESTIMATED 700 KB and the real file is twice that, almost
 * entirely because the evidence record is bigger than the estimate allowed: 859
 * entry and source nodes carry verbatim quotations, which is what makes
 * `near <line> --hops 2` reach the day Tom said it. That is content, not
 * structure, so the cap moves rather than the file.
 *
 * 2 MiB is under 1.5× today, so each rejected thing still crosses it on the day
 * it is written: per-field nodes are several thousand more nodes, per-run
 * `given` edges are tens of thousands, a model extracting entities makes more
 * of both. The file is NEVER loaded into a prompt, so the cap is not about
 * token cost — it is the structural-change alarm.
 */
export const GRAPH_MAX_BYTES = 2_097_152; // 2 MiB

/**
 * Per-table caps on the record half. `id-only` is not by itself a bound.
 * Today's snapshot holds far fewer than these; a record that grew past them
 * means the record itself wants a pass, and the file failing loudly is how that
 * gets noticed — a silently truncated graph would make `near` quietly wrong.
 */
export const RECORD_CAPS = Object.freeze({ batches: 400, todos: 4000, rulings: 2000 });

/**
 * The most `defines` edges one term may take.
 *
 * A short common word in the vocabulary — `run`, `area`, `line` — matches
 * hundreds of lines, and an edge set that size makes `near term:run` a dump
 * rather than an answer and pushes the file toward the cap for no reader. Over
 * the cap the term keeps its lowest node ids and the build REPORTS the term and
 * the count, so a word that wants a narrower definition is visible rather than
 * silently enormous.
 */
export const DEFINES_CAP = 64;

/** The most node ids a run's context entry carries. */
export const GRAPH_NODES_CAP = 256;

/** The most nodes one ablation arm removes from a case. */
export const ABLATION_NODE_CAP = 5;

// ── Ids ──────────────────────────────────────────────────────────────────────

export function lineId(text, hash = ruleId) {
  return `line:${hash(text)}`;
}

export function ruleNodeId(text, hash = ruleId) {
  return `rule:${hash(text)}`;
}

export function pageId(path) {
  return `page:${path}`;
}

/**
 * A PAGE'S KEY, which is what makes a page id unique.
 *
 * `AGENTS.md` is a path in every repository, so a page id built from the path
 * alone names tom.quest's root rules and ComplexMultiTrigger's root rules with
 * one string — and then one repository's rules render as the other's. A
 * repository's page is therefore keyed `<repo>/<path>`; a WikiTom page keeps its
 * vault path, which is already unique because there is one vault.
 */
export function pageKey(repo, path) {
  return repo === null || repo === undefined || repo === "" ? String(path) : `${repo}/${path}`;
}

export function headingId(path, title, ordinal = 1) {
  return `heading:${path}#${title}${ordinal > 1 ? `~${ordinal}` : ""}`;
}

export function areaId(name) {
  return `area:${name}`;
}

export function termId(word) {
  return `term:${String(word).toLowerCase()}`;
}

export function skillId(name) {
  return `skill:${name}`;
}

export function repoId(name) {
  return `repo:${name}`;
}

export function jobId(name) {
  return `job:${name}`;
}

export function questionId(command) {
  return `question:${command}`;
}

export function evidenceId(text, hash = ruleId) {
  return `evidence:${hash(text)}`;
}

export function sourceId(field, value, hash = hash8) {
  return `source:${hash(`${field}|${value}`)}`;
}

export function recordId(kind, id) {
  return `${kind}:${id}`;
}

/** The kind half of a node id. */
export function kindOf(id) {
  const colon = String(id ?? "").indexOf(":");
  return colon === -1 ? "" : String(id).slice(0, colon);
}

// ── Bytes ────────────────────────────────────────────────────────────────────

const ENCODER = typeof TextEncoder === "undefined" ? null : new TextEncoder();

export function byteLength(text) {
  const value = String(text ?? "");
  if (ENCODER !== null) return ENCODER.encode(value).length;
  return Buffer.byteLength(value, "utf8");
}

// ── Reading a page ───────────────────────────────────────────────────────────

const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * The BODY of a page as the skill generator renders it: an area page loses its
 * frontmatter, every other page keeps everything. Exactly what
 * scripts/skills.mjs:pageBody does, so a rendering of a whole page's nodes and
 * that function's output are the same bytes.
 *
 * LINE ENDINGS ARE NOT NORMALIZED, and that is the point. `pageBody` does not
 * normalize them either — tom.quest's `AGENTS.md` is CRLF on disk and its
 * published skill body carries the carriage returns — so a builder that quietly
 * converted them would render a body 62 bytes shorter than the one that skill
 * carries today, which is this round editing published text.
 *
 * The IDS are line-ending independent all the same, because `ruleId` collapses
 * every whitespace run before hashing: one line in a CRLF file and in an LF file
 * is one node, and each occurrence renders with the bytes it actually had.
 */
export function bodyOf(path, body) {
  return isAreaPath(path) ? parseFrontmatter(String(body ?? "")).body : String(body ?? "");
}

/**
 * One page's CONTENT LINES, each with its 0-based index in the page.
 *
 * EVERY NON-BLANK LINE IS A NODE, not only the bullets. This is wider than the
 * brief's "one bullet of a synthesis file" and the reason is provable: a skill's
 * body is the rendering of the subgraph under its skill node, and that rendering
 * has to equal the page byte for byte. `agent-rules.md` opens with a prose line
 * that is not a bullet; if prose lines are not nodes, the rendering silently
 * drops them and the round has edited fourteen skills' text.
 *
 * BLANK LINES ARE NOT NODES. They are the gaps between consecutive `order`
 * values, which is what lets a whole page reconstruct exactly and a partial one
 * close up.
 *
 * A FENCED BLOCK's lines are content lines, and a `#` inside one is not a
 * heading — a brief is not a machine format and a code sample is not structure.
 */
export function linesOf(path, body) {
  const raw = bodyOf(path, body).split("\n");
  const out = [];
  const seenHeading = new Map();
  let fenced = false;
  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index];
    if (FENCE.test(text)) fenced = !fenced;
    if (text.trim() === "") continue;
    const heading = fenced ? null : HEADING.exec(text);
    if (heading === null) {
      out.push({ kind: "line", text, order: index });
      continue;
    }
    const title = heading[2].trim();
    const ordinal = (seenHeading.get(title) ?? 0) + 1;
    seenHeading.set(title, ordinal);
    out.push({ kind: "heading", level: heading[1].length, title, ordinal, text, order: index });
  }
  return out;
}

// ── The builder ──────────────────────────────────────────────────────────────

/**
 * @typedef {{kind: string, id: string, title: string|null, text: string|null,
 *            path: string|null, heading: string|null, order: number|null,
 *            ref: string|null, version: string|null}} Node
 * @typedef {{kind: string, from: string, to: string, weight: number,
 *            evidence: string, at?: string}} Edge
 */

/**
 * `at` — the one field added to the brief's edge shape, and why.
 *
 * A `member-of` edge from a line to its heading, its page or its skill carries
 * `"<path>:<order>"`: WHERE this occurrence of the line sits. The node cannot
 * carry it, because two byte-identical bullets in two files are ONE node by
 * construction (the id is the hash of the text) and a single `path`/`order`
 * pair would place only the first of them. Placement is a fact about the
 * occurrence, which is the edge.
 *
 * It is read from the file's own structure, so it is as stated as the edge.
 */
function at(path, order) {
  return `${path}:${order}`;
}

function node(kind, id, fields = {}) {
  return {
    kind,
    id,
    title: fields.title ?? null,
    text: fields.text ?? null,
    path: fields.path ?? null,
    heading: fields.heading ?? null,
    order: fields.order ?? null,
    ref: fields.ref ?? null,
    version: fields.version ?? null,
  };
}

function weightFor(key, kind) {
  return WEIGHTS[key] ?? WEIGHTS[kind] ?? DEFAULT_WEIGHT;
}

class Builder {
  constructor(hash) {
    this.hash = hash;
    this.nodes = new Map();
    this.edges = new Map();
    this.notes = [];
    // id → the normalized text it was minted from, so that two DIFFERENT texts
    // arriving at one id are reported (G5) rather than silently merged. Two
    // spellings that normalize alike are the same line and are not a collision;
    // at 32 bits over a few thousand lines a real one is vanishingly unlikely
    // and catastrophic if unreported.
    this.texts = new Map();
    this.collisions = [];
  }

  mint(id, text, path) {
    const normalized = String(text).toLowerCase().replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
    const seen = this.texts.get(id);
    if (seen === undefined) {
      this.texts.set(id, { normalized, path });
      return;
    }
    if (seen.normalized !== normalized) {
      this.collisions.push({ id, first: seen, second: { normalized, path } });
    }
  }

  /** First writer of a node id wins its fields; later ones only confirm it. A
   * text-born node's id IS its content hash, so a second sighting of the same
   * text is the same node and its first placement is the one recorded. */
  node(next) {
    const seen = this.nodes.get(next.id);
    if (seen === undefined) {
      this.nodes.set(next.id, next);
      return next;
    }
    if (seen.kind !== next.kind) {
      throw new GraphError(`graph: ${next.id} is both a ${seen.kind} and a ${next.kind}`);
    }
    return seen;
  }

  edge(kind, from, to, key, evidence, placement) {
    if (from === to) return;
    const id = `${kind} ${from} ${to} ${placement ?? ""}`;
    if (this.edges.has(id)) return;
    const row = { kind, from, to, weight: weightFor(key, kind), evidence };
    if (placement !== undefined) row.at = placement;
    this.edges.set(id, row);
  }

  note(text) {
    this.notes.push(text);
  }
}

/**
 * EVERYTHING, from already-read text. No I/O: the caller has read the two
 * checkouts (scripts/graph.mjs) or holds the rows (Convex), and this decides
 * only what the graph IS.
 *
 * @param {{
 *   pages?: {path: string, body: string}[],
 *   evidence?: {path: string, body: string}[],
 *   repoRules?: {repo: string, path: string, body: string, commit?: string}[],
 *   vocabulary?: object|null,
 *   skills?: {name: string, group?: string, shape?: string, sourcePaths?: string[]}[],
 *   record?: {todos?: object[], batches?: object[], rulings?: object[]},
 *   changes?: {before: string, after: string, day?: string}[],
 *   commits?: {wikitom?: string, tomQuest?: string},
 *   hash?: (text: string) => string,
 * }} input
 */
export function buildGraph(input = {}) {
  const hash = input.hash ?? ruleId;
  const b = new Builder(hash);
  const pages = [...(input.pages ?? [])].sort((a, c) => a.path.localeCompare(c.path));
  const vocabulary = input.vocabulary ?? null;
  const wikitomCommit = input.commits?.wikitom ?? null;

  // ── The vocabulary's own nodes ─────────────────────────────────────────────
  const terms = termsOf(vocabulary);
  for (const term of terms) {
    b.node(node("term", termId(term.term), { title: term.term, text: term.definition ?? null }));
  }
  for (const job of vocabulary?.jobs ?? []) {
    b.node(node("job", jobId(job.name), { title: job.name, text: job.file ?? null }));
  }
  for (const question of vocabulary?.searchQuestions ?? []) {
    b.node(
      node("question", questionId(question.command), { title: question.command, text: question.what ?? null }),
    );
  }
  for (const repo of vocabulary?.repos ?? []) {
    b.node(node("repo", repoId(repo.name), { title: repo.name, text: repo.line ?? null }));
  }

  // ── The synthesis pages, the areas, and the repository rules ───────────────
  for (const page of pages) {
    addPage(b, page, { kind: isAreaPath(page.path) ? "area-page" : "synthesis", commit: wikitomCommit });
  }

  const repoFiles = [...(input.repoRules ?? [])].sort(
    (a, c) => a.repo.localeCompare(c.repo) || a.path.localeCompare(c.path),
  );
  for (const file of repoFiles) {
    b.node(node("repo", repoId(file.repo), { title: file.repo }));
    addPage(b, { path: file.path, body: file.body }, {
      kind: "rules",
      repo: file.repo,
      commit: file.commit ?? null,
    });
  }

  // ── The areas' terms ───────────────────────────────────────────────────────
  for (const page of pages.filter((candidate) => isAreaPath(candidate.path))) {
    const name = areaName(page.path);
    for (const category of areaCategories(page.path, page.body)) {
      b.node(node("term", termId(category), { title: category }));
      b.edge(
        "applies-to",
        areaId(name),
        termId(category),
        "applies-to/area-term",
        `${page.path}:categories`,
      );
    }
  }

  // ── The skills ─────────────────────────────────────────────────────────────
  for (const skill of input.skills ?? []) {
    b.node(
      node("skill", skillId(skill.name), {
        title: skill.name,
        text: skill.description ?? null,
        version: skill.commit ?? wikitomCommit,
      }),
    );
    // A repository skill's source paths are repo-relative and its `origin` is
    // the repository, which is what tells the two `AGENTS.md` files apart.
    const repo = skill.origin === undefined || skill.origin === "WikiTom" ? null : skill.origin;
    for (const source of skill.sourcePaths ?? []) {
      const page = repo === null
        ? pages.find((candidate) => candidate.path === source)
        : repoFiles.find((candidate) => candidate.repo === repo && candidate.path === source);
      if (page === undefined) continue;
      linkPageToSkill(b, pageKey(repo, source), source, page.body, skillId(skill.name));
    }
  }

  // ── The evidence chain ─────────────────────────────────────────────────────
  for (const file of [...(input.evidence ?? [])].sort((a, c) => a.path.localeCompare(c.path))) {
    addEvidence(b, file, hash);
  }

  // ── `defines`: a term against the text of every node that carries one ──────
  addDefines(b, terms);

  // ── `mentions`: the path tokens of a line against the pages that exist ─────
  addMentions(b);

  // ── `supersedes`, from last night's change log ─────────────────────────────
  for (const change of input.changes ?? []) {
    const before = String(change?.before ?? "").trim();
    const after = String(change?.after ?? "").trim();
    if (before === "" || after === "") continue;
    const from = lineId(after, hash);
    const to = lineId(before, hash);
    if (!b.nodes.has(from)) continue;
    b.edge("supersedes", from, to, "supersedes/line-line", `nightly:${change?.day ?? "unknown"}`);
  }

  // ── The record half ────────────────────────────────────────────────────────
  const record = input.record ?? {};
  addRecord(b, record, pages);

  const nodes = [...b.nodes.values()].sort((a, c) => a.id.localeCompare(c.id));
  const edges = [...b.edges.values()].sort(
    (a, c) =>
      a.kind.localeCompare(c.kind)
      || a.from.localeCompare(c.from)
      || a.to.localeCompare(c.to)
      || String(a.at ?? "").localeCompare(String(c.at ?? "")),
  );

  const graph = {
    version: "",
    recordVersion: "",
    nodeKinds: [...NODE_KINDS],
    edgeKinds: [...EDGE_KINDS],
    nodes,
    edges,
  };
  const split = splitHalves(graph);
  graph.version = hash16(split.staticHalf);
  graph.recordVersion = hash16(split.recordHalf);
  graph.counts = countsOf(graph);
  graph.notes = b.notes;
  graph.collisions = b.collisions;
  return graph;
}

function termsOf(vocabulary) {
  const rows = vocabulary?.terms ?? [];
  return rows
    .filter((row) => typeof row?.term === "string" && row.term.trim() !== "")
    .map((row) => ({ term: row.term.trim().toLowerCase(), definition: row.definition ?? null, kind: row.kind ?? null }));
}

/** One page's nodes and the `member-of` chain up from each of its lines. */
function addPage(b, page, { kind, repo = null, commit = null }) {
  const path = pageKey(repo, page.path);
  const source = page.path;
  const isArea = kind === "area-page";
  const lineKind = kind === "rules" ? "rule" : "line";
  const pageNode = b.node(node("page", pageId(path), { title: basename(source), path, version: commit }));

  if (isArea) {
    const name = areaName(source);
    b.node(node("area", areaId(name), { title: name, path }));
    b.edge("member-of", pageId(path), areaId(name), "member-of/page-area", `${path}#frontmatter`);
  }
  if (repo !== null) {
    const root = source === "AGENTS.md";
    b.edge(
      "applies-to",
      pageId(path),
      repoId(repo),
      root ? "applies-to/page-repo-root" : "applies-to/page-repo-nested",
      `${path}#path`,
    );
  }

  const stack = [];
  for (const entry of linesOf(source, page.body)) {
    if (entry.kind === "heading") {
      while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) stack.pop();
      const parent = stack.length === 0 ? pageNode.id : stack[stack.length - 1].id;
      const id = headingId(path, entry.title, entry.ordinal);
      b.node(node("heading", id, { title: entry.title, text: entry.text, path, order: entry.order }));
      b.edge("member-of", id, parent, "member-of/heading-page", `${path}#${entry.title}`, at(path, entry.order));
      stack.push({ level: entry.level, id, title: entry.title });
      continue;
    }
    const head = stack.length === 0 ? null : stack[stack.length - 1];
    const id = lineKind === "rule" ? ruleNodeId(entry.text, b.hash) : lineId(entry.text, b.hash);
    b.mint(id, entry.text, path);
    b.node(
      node(lineKind, id, {
        text: entry.text,
        path,
        heading: head?.title ?? null,
        order: entry.order,
      }),
    );
    b.edge(
      "member-of",
      id,
      head?.id ?? pageNode.id,
      "member-of/line-heading",
      head === null ? `${path}#page` : `${path}#${head.title}`,
      at(path, entry.order),
    );
  }
}

/** The `member-of` edges that make a skill's body a subgraph. */
function linkPageToSkill(b, key, source, body, skill) {
  b.edge("member-of", pageId(key), skill, "member-of/page-skill", `skills:${key}`, at(key, -1));
  const isRules = source === "AGENTS.md" || source.endsWith("/AGENTS.md");
  for (const entry of linesOf(source, body)) {
    const id =
      entry.kind === "heading"
        ? headingId(key, entry.title, entry.ordinal)
        : isRules
          ? ruleNodeId(entry.text, b.hash)
          : lineId(entry.text, b.hash);
    b.edge(
      "member-of",
      id,
      skill,
      entry.kind === "heading" ? "member-of/heading-skill" : "member-of/line-skill",
      `skills:${key}`,
      at(key, entry.order),
    );
  }
}

const EVIDENCE_ENTRY = /^\s*-\s+line:\s*(.*)$/;
const EVIDENCE_FIELD = /^\s+(said|paraphrase|read|rests on):\s*(.*)$/;

/** One evidence file's entries and their sources. */
function addEvidence(b, file, hash) {
  const lines = String(file.body ?? "").replace(/\r\n?/g, "\n").split("\n");
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const entry = EVIDENCE_ENTRY.exec(lines[index]);
    if (entry !== null) {
      const text = entry[1].trim();
      if (text === "") {
        current = null;
        b.note(`${file.path}:${index + 1} — a \`- line:\` entry with no text`);
        continue;
      }
      const id = evidenceId(text, hash);
      b.mint(id, text, file.path);
      b.node(node("evidence", id, { text, path: file.path, order: index }));
      // THE EDGE GOES TO THE LINE THAT EXISTS, and to nothing when neither does.
      // An entry under `evidence/repos/` names a rule of another repository's
      // AGENTS.md, and one under `evidence/handoffs.md` names nothing at all;
      // check-evidence.mjs checks only those files' entry FORM, so an edge to a
      // node the graph never minted would be this file inventing a link rather
      // than reading one. A synthesis entry with no line is G4's business.
      for (const target of [lineId(text, hash), ruleNodeId(text, hash)]) {
        if (!b.nodes.has(target)) continue;
        b.edge("evidences", id, target, "evidences/entry-line", `${file.path}:line`);
      }
      current = id;
      continue;
    }
    const field = EVIDENCE_FIELD.exec(lines[index]);
    if (field === null || current === null) continue;
    const value = field[2].trim();
    if (value === "") continue;
    const id = sourceId(field[1], value, hash8);
    b.node(node("source", id, { title: field[1], text: value, path: file.path, order: index }));
    b.edge("evidences", id, current, "evidences/source-entry", `${file.path}:${field[1]}`);
  }
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** MOVED FROM skill-router.mjs's spelling, which is context-relevance.mjs's:
 * case-insensitive, on WORD BOUNDARIES against the WHOLE term. `\b` is no use —
 * the terms carry `-` and `.` (`agent-systems`, `tom.quest`) and `\b` sits
 * inside both. */
export function termRegex(term) {
  return new RegExp(`(?<![A-Za-z0-9])${String(term).replace(ESCAPE, "\\$&")}(?![A-Za-z0-9])`, "i");
}

function addDefines(b, terms) {
  const carriers = [...b.nodes.values()].filter(
    (row) => (row.kind === "line" || row.kind === "rule" || row.kind === "skill") && typeof row.text === "string",
  );
  for (const term of terms) {
    if (term.term.length < 3) continue;
    const pattern = termRegex(term.term);
    const hits = carriers.filter((row) => pattern.test(row.text)).sort((a, c) => a.id.localeCompare(c.id));
    if (hits.length > DEFINES_CAP) {
      b.note(`term "${term.term}" matches ${hits.length} nodes — capped at ${DEFINES_CAP}`);
    }
    for (const hit of hits.slice(0, DEFINES_CAP)) {
      b.edge("defines", termId(term.term), hit.id, `defines/term-${hit.kind}`, "rule:termMatch");
    }
  }
}

const PATH_TOKEN = /(?<![\w./-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*)/g;

/** MOVED FROM skill-router.mjs. The path tokens of prose written for Tom.
 * Backticks and fenced blocks count the same as running text — the brief is not
 * a machine format, and pretending otherwise loses the paths it names. */
export function pathTokens(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(PATH_TOKEN)) out.push(match[1]);
  return [...new Set(out)];
}

function addMentions(b) {
  const pagesByPath = new Map(
    [...b.nodes.values()].filter((row) => row.kind === "page").map((row) => [row.path, row]),
  );
  const paths = [...pagesByPath.keys()].sort();
  for (const row of [...b.nodes.values()].sort((a, c) => a.id.localeCompare(c.id))) {
    if (row.kind !== "line" && row.kind !== "rule") continue;
    for (const token of pathTokens(row.text)) {
      const exact = pagesByPath.get(token.replace(/\/$/, ""));
      if (exact !== undefined) {
        b.edge("mentions", row.id, exact.id, "mentions/token-page", "rule:pathTokens");
        continue;
      }
      const directory = token.endsWith("/") ? token : `${token}/`;
      const inside = paths.filter((path) => path.startsWith(directory));
      if (inside.length === 0 || inside.length > 8) continue;
      for (const path of inside) {
        b.edge("mentions", row.id, pageId(path), "mentions/token-rules-file", "rule:pathTokens");
      }
    }
  }
}

/** The record half: ids only, with the edges the rows already state. */
function addRecord(b, record, pages) {
  const todos = (record.todos ?? []).filter((row) => row?.status === undefined || row.status === "active");
  const batches = (record.batches ?? []).filter((row) => row?.status === undefined || row.status === "active");
  const rulings = record.rulings ?? [];
  for (const [table, rows] of [["todos", todos], ["batches", batches], ["rulings", rulings]]) {
    if (rows.length > RECORD_CAPS[table]) {
      throw new GraphError(
        `graph: the record half holds ${rows.length} ${table}, over the cap of ${RECORD_CAPS[table]} — `
          + "the record itself wants a pass; a truncated graph would make `near` quietly wrong",
      );
    }
  }

  const areaNames = new Set(
    pages.filter((page) => isAreaPath(page.path)).map((page) => areaName(page.path)),
  );
  const areaTerms = pages
    .filter((page) => isAreaPath(page.path))
    .map((page) => ({ area: areaName(page.path), terms: areaCategories(page.path, page.body) }));

  for (const batch of batches) {
    b.node(node("batch", recordId("batch", batch.id), { title: batch.title ?? null, ref: `batches/${batch.id}` }));
  }
  for (const todo of todos) {
    b.node(node("todo", recordId("todo", todo.id), { title: todo.title ?? null, ref: `dtsTodos/${todo.id}` }));
    if (typeof todo.batchId === "string" && todo.batchId !== "") {
      b.edge(
        "member-of",
        recordId("todo", todo.id),
        recordId("batch", todo.batchId),
        "member-of/todo-batch",
        "convex:dtsTodos.batchId",
      );
    }
    const category = String(todo.category ?? "").trim();
    if (category !== "") {
      if (areaNames.has(category)) {
        b.edge(
          "member-of",
          recordId("todo", todo.id),
          areaId(category),
          "member-of/todo-area-exact",
          "convex:dtsTodos.category",
        );
      } else {
        for (const entry of areaTerms) {
          if (!entry.terms.some((term) => termRegex(term).test(category))) continue;
          b.edge(
            "member-of",
            recordId("todo", todo.id),
            areaId(entry.area),
            "member-of/todo-area-term",
            "convex:dtsTodos.category",
          );
        }
      }
    }
    for (const need of todo.needs ?? []) {
      b.edge(
        "depends-on",
        recordId("todo", todo.id),
        recordId("todo", need),
        "depends-on/todo-todo",
        "convex:dtsTodos.needs",
      );
    }
  }
  for (const batch of batches) {
    for (const need of batch.needs ?? []) {
      b.edge(
        "depends-on",
        recordId("batch", batch.id),
        recordId("batch", need),
        "depends-on/batch-batch",
        "convex:batches.needs",
      );
    }
  }
  for (const ruling of rulings) {
    b.node(node("ruling", recordId("ruling", ruling.id), { ref: `dtsRulings/${ruling.id}` }));
    if (typeof ruling.todoId === "string" && ruling.todoId !== "") {
      b.edge(
        "labeled",
        recordId("ruling", ruling.id),
        recordId("todo", ruling.todoId),
        "labeled/ruling-own-todo",
        "convex:dtsRulings.todoId",
      );
    }
    if (typeof ruling.batchId === "string" && ruling.batchId !== "") {
      b.edge(
        "labeled",
        recordId("ruling", ruling.id),
        recordId("batch", ruling.batchId),
        "labeled/ruling-batch",
        "convex:dtsRulings.batchId",
      );
    }
  }
}

function basename(path) {
  const cut = String(path).lastIndexOf("/");
  return cut === -1 ? String(path) : String(path).slice(cut + 1);
}

// ── Versions ─────────────────────────────────────────────────────────────────

/** The two halves: static, and everything touching a record-kind node. */
export function splitHalves(graph) {
  const isRecord = (id) => RECORD_NODE_KINDS.includes(kindOf(id));
  const staticNodes = graph.nodes.filter((row) => !isRecord(row.id));
  const recordNodes = graph.nodes.filter((row) => isRecord(row.id));
  const staticEdges = graph.edges.filter((row) => !isRecord(row.from) && !isRecord(row.to));
  const recordEdges = graph.edges.filter((row) => isRecord(row.from) || isRecord(row.to));
  return {
    staticHalf: { nodeKinds: graph.nodeKinds, edgeKinds: graph.edgeKinds, nodes: staticNodes, edges: staticEdges },
    recordHalf: { nodeKinds: graph.nodeKinds, edgeKinds: graph.edgeKinds, nodes: recordNodes, edges: recordEdges },
  };
}

/** Sixteen lowercase hex of the SHA-256 of the canonical serialization. Two
 * versions, because the two halves answer different questions at different
 * rates: a run records `version` to say which definitions and which rules it
 * ran under, and that must not change because a todo was captured overnight. */
export function hash16(value) {
  return sha256Hex(JSON.stringify(value, null, 2)).slice(0, 16);
}

export function countsOf(graph) {
  const nodes = {};
  const edges = {};
  for (const row of graph.nodes) nodes[row.kind] = (nodes[row.kind] ?? 0) + 1;
  for (const row of graph.edges) edges[row.kind] = (edges[row.kind] ?? 0) + 1;
  return { nodes: graph.nodes.length, edges: graph.edges.length, byNodeKind: nodes, byEdgeKind: edges };
}

// ── The index ────────────────────────────────────────────────────────────────

const INDEXES = new WeakMap();

/** Adjacency, memoized per graph object. Built once and read many times: a walk
 * over a 1,500-node graph that rebuilt this per call would be quadratic for no
 * reason. */
export function indexOf(graph) {
  const seen = INDEXES.get(graph);
  if (seen !== undefined) return seen;
  const byId = new Map(graph.nodes.map((row) => [row.id, row]));
  const out = new Map();
  const into = new Map();
  for (const edge of graph.edges) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge);
    if (!into.has(edge.to)) into.set(edge.to, []);
    into.get(edge.to).push(edge);
  }
  const index = { byId, out, into };
  INDEXES.set(graph, index);
  return index;
}

export function nodeOf(graph, id) {
  return indexOf(graph).byId.get(id) ?? null;
}

/** Every edge touching a node, out first then in, each in the file's order. */
export function edgesOf(graph, id) {
  const index = indexOf(graph);
  return {
    out: index.out.get(id) ?? [],
    in: index.into.get(id) ?? [],
  };
}

/**
 * The record OVERLAID, not merged into the file: the rows the caller already
 * read win over the file's id-only node of the same id.
 *
 * The file's record half is last night's and the caller's is now. A todo
 * captured this morning must be walkable, and a file that had to be regenerated
 * before a run could see a new todo would put a nightly job on the critical path
 * of every session.
 */
export function overlayRecord(graph, record, pages = []) {
  if (record === null || record === undefined) return graph;
  const overlay = buildGraph({ pages, record });
  const recordIds = new Set(overlay.nodes.filter((row) => RECORD_NODE_KINDS.includes(row.kind)).map((row) => row.id));
  const isRecord = (id) => RECORD_NODE_KINDS.includes(kindOf(id));
  const nodes = [
    ...graph.nodes.filter((row) => !recordIds.has(row.id)),
    ...overlay.nodes.filter((row) => RECORD_NODE_KINDS.includes(row.kind)),
  ].sort((a, c) => a.id.localeCompare(c.id));
  const touched = (edge) =>
    (isRecord(edge.from) && recordIds.has(edge.from)) || (isRecord(edge.to) && recordIds.has(edge.to));
  const edges = [
    ...graph.edges.filter((row) => !touched(row)),
    ...overlay.edges.filter((row) => isRecord(row.from) || isRecord(row.to)),
  ].sort(
    (a, c) => a.kind.localeCompare(c.kind) || a.from.localeCompare(c.from) || a.to.localeCompare(c.to),
  );
  const next = { ...graph, nodes, edges };
  next.counts = countsOf(next);
  return next;
}

// ── The walk ─────────────────────────────────────────────────────────────────

/** A tiny binary heap, so a 4,000-node walk is n log n rather than n². */
class Heap {
  constructor(less) {
    this.items = [];
    this.less = less;
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(items[index], items[parent])) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let small = index;
        if (left < items.length && this.less(items[left], items[small])) small = left;
        if (right < items.length && this.less(items[right], items[small])) small = right;
        if (small === index) break;
        [items[index], items[small]] = [items[small], items[index]];
        index = small;
      }
    }
    return top;
  }
}

function rankOf(kind) {
  return RENDER_RANK[kind] ?? RENDER_ORDER.length;
}

/** The bytes one node contributes to a rendering. */
export function nodeBytes(row) {
  if (typeof row.text === "string" && row.text !== "") return byteLength(row.text) + 1;
  return byteLength(row.title ?? row.id) + 1;
}

/**
 * THE WALK. Read a node, then the nodes its edges reach, under a byte budget,
 * in edge-weight order.
 *
 * @param {object} graph              buildGraph's output, record half overlaid
 * @param {string[]|{id:string,weight?:number}[]} startNodes  seeds, highest intent first
 * @param {number} budgetBytes        the rendering's byte budget
 * @param {Record<string,number>|null} weights  overrides by edge kind or by full key
 * @param {{exclude?: Set<string>, maxHops?: number, maxVisit?: number,
 *          kinds?: string[], fixed?: string[]}} [options]
 * @returns {{nodes: object[], frontier: object[], bytes: number, visited: number,
 *            costs: Record<string, number>, hops: Record<string, number>}}
 */
export function walk(graph, startNodes, budgetBytes, weights = null, options = {}) {
  const index = indexOf(graph);
  const exclude = options.exclude ?? new Set();
  const maxHops = options.maxHops ?? 3;
  const maxVisit = options.maxVisit ?? 4_000;
  const only = options.kinds === undefined ? null : new Set(options.kinds);

  const costOf = (edge) => {
    const override = weights === null ? undefined : weights[edge.kind];
    const weight = override === undefined ? edge.weight : override;
    return 1000 - weight;
  };

  const best = new Map();
  const hops = new Map();
  const heap = new Heap((a, c) =>
    a.cost !== c.cost
      ? a.cost < c.cost
      : rankOf(a.kind) !== rankOf(c.kind)
        ? rankOf(a.kind) < rankOf(c.kind)
        : a.id < c.id,
  );

  for (const seed of startNodes ?? []) {
    const id = typeof seed === "string" ? seed : seed?.id;
    if (typeof id !== "string" || !index.byId.has(id)) continue;
    const weight = typeof seed === "string" ? SEED_WEIGHTS.task : (seed.weight ?? SEED_WEIGHTS.task);
    const cost = 1000 - weight;
    if (best.has(id) && best.get(id) <= cost) continue;
    best.set(id, cost);
    hops.set(id, 0);
    heap.push({ id, cost, kind: index.byId.get(id).kind });
  }

  const order = [];
  let visited = 0;
  while (heap.size > 0 && visited < maxVisit) {
    const top = heap.pop();
    if (best.get(top.id) !== top.cost) continue; // a stale entry
    visited += 1;
    order.push(top);
    const hop = hops.get(top.id) ?? 0;
    if (hop >= maxHops) continue;
    const neighbours = [...(index.out.get(top.id) ?? []), ...(index.into.get(top.id) ?? [])];
    for (const edge of neighbours) {
      const next = edge.from === top.id ? edge.to : edge.from;
      if (!index.byId.has(next)) continue;
      const cost = top.cost + costOf(edge);
      if (best.has(next) && best.get(next) <= cost) continue;
      best.set(next, cost);
      hops.set(next, hop + 1);
      heap.push({ id: next, cost, kind: index.byId.get(next).kind });
    }
  }

  order.sort((a, c) =>
    a.cost !== c.cost ? a.cost - c.cost : rankOf(a.kind) - rankOf(c.kind) || a.id.localeCompare(c.id),
  );

  const admitted = [];
  const frontier = [];
  let bytes = 0;
  for (const entry of order) {
    const row = index.byId.get(entry.id);
    if (exclude.has(entry.id)) continue;
    if (only !== null && !only.has(row.kind)) continue;
    const size = nodeBytes(row);
    if (bytes + size > budgetBytes) {
      frontier.push(row);
      continue;
    }
    bytes += size;
    admitted.push(row);
  }

  admitted.sort(byRenderOrder);
  return {
    nodes: admitted,
    frontier,
    bytes,
    visited,
    costs: Object.fromEntries(order.map((entry) => [entry.id, entry.cost])),
    hops: Object.fromEntries([...hops.entries()]),
  };
}

/** Render order: by kind rank, then by page, then by position in the page. */
export function byRenderOrder(a, c) {
  const rank = rankOf(a.kind) - rankOf(c.kind);
  if (rank !== 0) return rank;
  const path = String(a.path ?? "").localeCompare(String(c.path ?? ""));
  if (path !== 0) return path;
  const order = (a.order ?? 0) - (c.order ?? 0);
  if (order !== 0) return order;
  return a.id.localeCompare(c.id);
}

// ── Subgraphs and rendering ──────────────────────────────────────────────────

/**
 * The nodes under one node by `member-of`, WITH THEIR PLACEMENT — the `at` of
 * the edge that put them there. This is what makes a skill's body provable: the
 * rendering of the whole subgraph under `skill:<name>` equals the page.
 */
export function subgraphOf(graph, id) {
  const index = indexOf(graph);
  const entries = [];
  for (const edge of index.into.get(id) ?? []) {
    if (edge.kind !== "member-of") continue;
    const row = index.byId.get(edge.from);
    if (row === undefined) continue;
    const placement = parseAt(edge.at);
    if (placement === null || placement.order < 0) continue;
    entries.push({ node: row, path: placement.path, order: placement.order });
  }
  entries.sort((a, c) => a.path.localeCompare(c.path) || a.order - c.order);
  return entries;
}

function parseAt(value) {
  if (typeof value !== "string") return null;
  const cut = value.lastIndexOf(":");
  if (cut === -1) return null;
  const order = Number.parseInt(value.slice(cut + 1), 10);
  if (!Number.isInteger(order)) return null;
  return { path: value.slice(0, cut), order };
}

const BLOCK = "──";

/**
 * PLACED NODES, rendered as the page reads.
 *
 * A gap between consecutive `order` values is exactly that many blank lines, so
 * a whole page reconstructs byte for byte and a partial one closes up. Two or
 * more pages are joined the way scripts/skills.mjs joins two source files, with
 * `── <path> ──` over each — a two-file skill body reads the way the same two
 * files read in a prompt.
 *
 * The final `.trim()` is scripts/skills.mjs:pageBody's own, which is why a
 * whole page's rendering and that function agree on the leading and trailing
 * whitespace as well as on the middle.
 */
export function renderPlaced(entries, { order: pathOrder } = {}) {
  const byPath = new Map();
  for (const entry of entries) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, []);
    byPath.get(entry.path).push(entry);
  }
  const paths = pathOrder ?? [...byPath.keys()].sort();
  const blocks = [];
  for (const path of paths) {
    const rows = (byPath.get(path) ?? []).slice().sort((a, c) => a.order - c.order);
    if (rows.length === 0) continue;
    const lines = [];
    let previous = null;
    // A BLANK LINE CARRIES THE FILE'S OWN TERMINATOR. Splitting on `\n` leaves
    // the carriage return on every line of a CRLF file, blank lines included —
    // a blank line there is the one byte `\r`, not the empty string. Only
    // non-blank lines are nodes, so a gap is filled with whatever the line
    // beside it ends in. A file is CRLF throughout or LF throughout, so the
    // neighbour is the whole answer and no page-level flag is needed.
    const blank = () => (lines.length > 0 && lines[lines.length - 1].endsWith("\r") ? "\r" : "");
    for (const row of rows) {
      if (previous !== null && row.order > previous + 1) {
        for (let gap = previous + 1; gap < row.order; gap += 1) lines.push(blank());
      }
      lines.push(String(row.node.text ?? ""));
      previous = row.order;
    }
    blocks.push({ path, body: lines.join("\n").trim() });
  }
  if (blocks.length === 0) return "";
  if (blocks.length === 1) return blocks[0].body;
  return blocks.map(({ path, body }) => `${BLOCK} ${path} ${BLOCK}\n${body}`).join("\n\n");
}

/** A skill's body, rendered from the subgraph under its node. `origin` is the
 * repository for a `repo-` skill and absent for a WikiTom one, because that is
 * what keys the page — see `pageKey`. */
export function renderSkillBody(graph, name, sourcePaths, origin) {
  const repo = origin === undefined || origin === "WikiTom" ? null : origin;
  return renderPlaced(subgraphOf(graph, skillId(name)), {
    order: (sourcePaths ?? []).map((source) => pageKey(repo, source)),
  });
}

/** A walk's admitted nodes, rendered. A node with a placement renders as its
 * page reads; one without — a term, a repository, a record row — renders as one
 * labelled line, because that is all it is. */
export function renderNodes(nodes) {
  const placed = [];
  const bare = [];
  for (const row of nodes) {
    if (typeof row.path === "string" && Number.isInteger(row.order) && typeof row.text === "string") {
      placed.push({ node: row, path: row.path, order: row.order });
    } else {
      bare.push(row);
    }
  }
  const parts = [];
  const body = renderPlaced(placed);
  if (body !== "") parts.push(body);
  for (const row of bare.slice().sort(byRenderOrder)) {
    parts.push(`${row.id}${row.title === null ? "" : ` ${row.title}`}${row.text === null ? "" : ` — ${row.text}`}`);
  }
  return parts.join("\n\n");
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/**
 * The seed ids of a run's own task, with their weights.
 *
 * THE SUBJECT IS THE SEED. `todo:<id>`, `batch:<id>`, `area:<name>`,
 * `repo:<name>` — the node the run's task IS. Everything else it gets, it gets
 * by walking outward from there.
 *
 * `laptop` and `none` seed NOTHING, which is the retired rule 12 unchanged: with
 * no subject nothing is admitted and the whole index is the frontier.
 */
export function seedsFor({ subject, repo = null, paths = [], brief = "", terms = [] } = {}) {
  const seeds = [];
  const push = (id, weight) => {
    if (typeof id === "string" && id !== "") seeds.push({ id, weight });
  };
  const kind = subject?.kind ?? "none";
  if (kind === "todo") push(recordId("todo", subject.todoId), SEED_WEIGHTS.task);
  else if (kind === "batch") push(recordId("batch", subject.batchId), SEED_WEIGHTS.task);
  else if (kind === "area") push(areaId(subject.area), SEED_WEIGHTS.task);
  else if (kind === "repo") push(repoId(subject.repo), SEED_WEIGHTS.task);
  if (repo !== null) push(repoId(repo), SEED_WEIGHTS.repo);
  for (const token of [...paths, ...pathTokens(brief)]) push(pageId(token), SEED_WEIGHTS.pathToken);
  for (const term of terms) push(termId(term), SEED_WEIGHTS.term);
  const best = new Map();
  for (const seed of seeds) {
    if (!best.has(seed.id) || best.get(seed.id).weight < seed.weight) best.set(seed.id, seed);
  }
  return [...best.values()].sort((a, c) => c.weight - a.weight || a.id.localeCompare(c.id));
}

// ── What a prompt carried ────────────────────────────────────────────────────

/**
 * THE `given` EDGES, from the prompt side: the exact node ids a run's prompt
 * carried.
 *
 * The stable prefix is a set of FIXED nodes rendered always and outside any
 * budget — every line of `agent-rules.md`, and of `writing.md` and `ground.md`
 * when the run's output reaches Tom. Those are its `line` nodes, named here
 * rather than guessed from a working directory. A granted skill is its own node,
 * because the run was told it may load it.
 *
 * Truncated at GRAPH_NODES_CAP, and the truncation is visible: a reader counting
 * exactly the cap knows to distrust the count, which a silent cut would hide.
 */
export function givenNodes({ pages = [], prefixPaths = [], granted = [], hash = ruleId } = {}) {
  const ids = [];
  const byPath = new Map(pages.map((page) => [page.path, page]));
  for (const path of prefixPaths) {
    const page = byPath.get(path);
    if (page === undefined) continue;
    ids.push(pageId(path));
    for (const entry of linesOf(path, page.body)) {
      if (entry.kind === "heading") ids.push(headingId(path, entry.title, entry.ordinal));
      else ids.push(lineId(entry.text, hash));
    }
  }
  for (const name of granted) ids.push(skillId(String(name).replace(/^tom-/, "")));
  return [...new Set(ids)].slice(0, GRAPH_NODES_CAP);
}

/** Just the `line` node ids of a set of paths — the cheap half of the above,
 * for a caller that holds the pages and wants no skill names. */
export function lineNodeIdsOf(pages, paths, hash = ruleId) {
  return givenNodes({ pages, prefixPaths: paths, granted: [], hash });
}
